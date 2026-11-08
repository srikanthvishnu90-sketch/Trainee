// CONTACT OUTREACH (release 9 workstream E, proposal D-042), the send: the card the person approves and the hand-off to
// the existing sending rail (career_send_rail.ts: the person's own Gmail, gmail.send only, one recipient, List-Unsubscribe,
// bounces and stop replies kept forever). Nothing leaves without the person's yes to the exact payload hash (D-MN-2).
//   contactCard        only an address scoring SEND_MIN_SCORE (70) or more can be put up for approval; below it the card
//                      says "unconfirmed" and suggests another channel. A suppressed address (the global list, anyone's
//                      opt-out, any bounce) never gets a card. Every email ends with the person's signature, the sender's
//                      postal address (CAREER_SENDER_POSTAL_ADDRESS, owner-set; no address, no card) and the opt-out line.
//   test mode          CAREER_CONTACT_TEST_RECIPIENTS (the owner's own addresses): every card is addressed to the first of
//                      them, and nothing goes to any address outside the list. The card shows both, and the hash binds the
//                      address it will really go to.
//   approveContactCard the yes must carry the card's hash; the drafts are stored approved (career_outreach_drafts) and
//                      queued on the rail. At most `dailyNew` (20) new contacts per person per day, each spread
//                      `spreadMinutes` after the last; at most 2 follow-ups, 4 to 7 days apart, which the rail stops on a
//                      reply, a bounce or an opt-out (career_send_claim reads the thread first).
import { emailHash as hashOf, messageOf, OPT_OUT_LINE, type OutreachDraft, type OutreachStore, payloadHash, type Recipient } from "./career_outreach.ts";
import { type AddressType, type QueueDeps, queueApproved, type QueueResult } from "./career_send_rail.ts";
import { type ContactDraft, type ContactIn, SPAM_PHRASES } from "./career_contact_draft.ts";

export const SEND_MIN_SCORE = 70, DAILY_NEW_DEFAULT = 20, SPREAD_MINUTES_DEFAULT = 20, FOLLOWUPS_MAX = 2, FOLLOWUP_DAYS = 5, FOLLOWUP_MIN_DAYS = 4, FOLLOWUP_MAX_DAYS = 7;
export const UNCONFIRMED = "I can't confirm this address, so I won't send to it. Try an introduction through someone you know there, or the company's own contact form.";
export interface SendConfig { on: boolean; dailyNew: number; spreadMinutes: number; followupDays: number; postalAddress: string | null; testRecipients: string[] }
const int = (v: string | undefined, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
const ADDR = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,24}$/;
// on: career_contact_pipeline.ts contactOutreachOn (both switches), computed by the caller.
export function sendConfig(env: (k: string) => string | undefined, on: boolean): SendConfig {
  const postal = String(env("CAREER_SENDER_POSTAL_ADDRESS") ?? "").replace(/\s+/g, " ").trim();
  return { on, dailyNew: int(env("CAREER_CONTACT_DAILY_MAX"), DAILY_NEW_DEFAULT, 0, 200), spreadMinutes: int(env("CAREER_CONTACT_SPREAD_MINUTES"), SPREAD_MINUTES_DEFAULT, 0, 720),
    followupDays: int(env("CAREER_CONTACT_FOLLOWUP_DAYS"), FOLLOWUP_DAYS, FOLLOWUP_MIN_DAYS, FOLLOWUP_MAX_DAYS), postalAddress: postal.length >= 10 && postal.length <= 200 ? postal : null,
    testRecipients: String(env("CAREER_CONTACT_TEST_RECIPIENTS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => ADDR.test(s)) };
}
export const footerFor = (signature: string, postal: string) => `${signature.trim()}\n${postal}\n\n${OPT_OUT_LINE}`;

export interface CardMail { subject: string; body: string; footer: string; text: string; hash: string; after_days: number }
export type ContactCard =
  | { ok: true; to: string; found: string; test_mode: boolean; score: number; method: string; mails: CardMail[]; hash: string }
  | { ok: false; why: "off" | "unconfirmed" | "suppressed" | "no_postal_address" | "no_signature" | "bad_followup"; reply: string };
// A follow-up's own checks: short, at most one question, no spam phrase, no link.
const followupOk = (b: string) => b.split(/\s+/).filter(Boolean).length <= 80 && (b.match(/\?/g) ?? []).length <= 1 && !SPAM_PHRASES.some((p) => b.toLowerCase().includes(p)) && !/https?:\/\/|www\./i.test(b);
export async function contactCard(o: { contact: ContactIn; draft: ContactDraft; signature: string | null; followups?: string[]; config: SendConfig; suppressed: (emails: string[]) => Promise<Set<string>> }): Promise<ContactCard> {
  const c = o.config, e = o.contact.email;
  if (!c.on) return { ok: false, why: "off", reply: "Contact outreach is not switched on." };
  if (!e.email || !e.approvable || e.score < SEND_MIN_SCORE) return { ok: false, why: "unconfirmed", reply: `${o.contact.person.name}'s address is unconfirmed (${e.score}/100: ${e.why}). ${UNCONFIRMED}` };
  if (!c.postalAddress) return { ok: false, why: "no_postal_address", reply: "A sender postal address has to be set before any outreach email can go (CAREER_SENDER_POSTAL_ADDRESS)." };
  if (!o.signature?.trim()) return { ok: false, why: "no_signature", reply: "How do you sign your emails? Send your name the way you want it at the bottom." };
  const found = e.email.toLowerCase(), to = c.testRecipients.length ? c.testRecipients[0] : found;
  if ((await o.suppressed([found, to])).size) return { ok: false, why: "suppressed", reply: `${o.contact.person.name} asked not to be contacted, or that address bounced, so no one emails it.` };
  const fus = (o.followups ?? []).slice(0, FOLLOWUPS_MAX);
  if (!fus.every(followupOk)) return { ok: false, why: "bad_followup", reply: "A follow-up broke the rules (at most 80 words, one question, no links or sales words)." };
  const footer = footerFor(o.signature, c.postalAddress);
  const parts = [{ subject: o.draft.subject, body: o.draft.body, after_days: 0 }, ...fus.map((b, i) => ({ subject: `Re: ${o.draft.subject}`, body: b, after_days: c.followupDays * (i + 1) }))];
  const mails: CardMail[] = [];
  for (const p of parts) {
    const m = messageOf({ recipient: { email: to } as Recipient, subject: p.subject, body: p.body, footer });
    mails.push({ subject: m.subject, body: p.body, footer, text: m.text, hash: await payloadHash(m), after_days: p.after_days });
  }
  return { ok: true, to, found, test_mode: to !== found, score: e.score, method: e.method ?? "", mails, hash: mails[0].hash };
}

// The day's limit, per person (PR part 1: career_contact_record_send / career_contact_sends).
export interface SendLimits {
  countToday(userId: string, day: string): Promise<number>;
  record(p: { user: string; email_hash: string; step: number; day: string; cap: number; queue_id?: string | null }): Promise<"recorded" | "already_recorded" | "daily_limit">;
}
export function memorySendLimits(): SendLimits {
  const rows: { user: string; email_hash: string; step: number; day: string }[] = [];
  return {
    async countToday(u, day) { return rows.filter((r) => r.user === u && r.day === day && r.step === 0).length; },
    async record(p) {
      if (rows.some((r) => r.user === p.user && r.email_hash === p.email_hash && r.step === p.step)) return "already_recorded";
      if (p.step === 0 && rows.filter((r) => r.user === p.user && r.day === p.day && r.step === 0).length >= p.cap) return "daily_limit";
      rows.push({ user: p.user, email_hash: p.email_hash, step: p.step, day: p.day }); return "recorded";
    },
  };
}
export const dayIn = (now: number, tz?: string | null) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export type Approved = { ok: true; queued: QueueResult[]; send_at: string[] } | { ok: false; why: "changed" | "suppressed" | "daily_limit" | "refused"; reply: string; queued?: QueueResult[] };
export async function approveContactCard(o: {
  userId: string; card: Extract<ContactCard, { ok: true }>; yesHash: string; contact: ContactIn; now: number; tz?: string | null; config: SendConfig;
  store: Pick<OutreachStore, "saveBatch" | "update">; rail: QueueDeps; limits: SendLimits; suppressed: (emails: string[]) => Promise<Set<string>>;
}): Promise<Approved> {
  const { card, config: c } = o;
  if (o.yesHash !== card.hash) return { ok: false, why: "changed", reply: "That yes was for a different version of this email, so nothing was sent. Here it is again to approve." };
  if (c.testRecipients.length && !c.testRecipients.includes(card.to)) return { ok: false, why: "refused", reply: "Test mode: that address is not on the test list, so nothing was sent." };
  if ((await o.suppressed([card.found, card.to])).size) return { ok: false, why: "suppressed", reply: `${o.contact.person.name} can't be emailed any more (they opted out, or the address bounced).` };
  const day = dayIn(o.now, o.tz), emailHash = await hashOf(card.found);
  const slot = await o.limits.countToday(o.userId, day);
  const rec = await o.limits.record({ user: o.userId, email_hash: emailHash, step: 0, day, cap: c.dailyNew });
  if (rec === "daily_limit") return { ok: false, why: "daily_limit", reply: `That's ${c.dailyNew} new people today, the most I email in a day. I'll keep this one for tomorrow if you approve it again then.` };
  const addressType: AddressType = o.contact.email.method === "first_party_published" || o.contact.email.method === "github_public" ? "published" : "inferred";
  const recipient: Recipient = { name: o.contact.person.name, firm: o.contact.person.company, title: o.contact.person.title, school: "", email: card.to, source: o.contact.person.source_url, address: addressType };
  const drafts = card.mails.map((m, i) => ({ n: i + 1, recipient, subject: m.subject, body: m.body, footer: m.footer, hash: m.hash, status: "shown" as const, shared: [] })) as unknown as Omit<OutreachDraft, "id" | "batch_id" | "thread_id">[];
  const saved = await o.store.saveBatch(o.userId, null, drafts, o.now);
  for (const d of saved) if (!(await o.store.update(o.userId, { ...d, status: "approved", approved_hash: d.hash, approved_at: new Date(o.now).toISOString() } as OutreachDraft, { status: "shown", hash: d.hash }))) return { ok: false, why: "changed", reply: "That email changed before it was approved, so nothing was sent." };
  // Spread: the day's n-th new contact goes n x spreadMinutes from now (the rail sends nothing before send_at).
  const first = o.now + slot * c.spreadMinutes * 60_000;
  const item = (i: number, followUpOf: string | null) => ({ kind: "outreach" as const, sourceId: saved[i].id, approvalHash: saved[i].hash, to: card.to, subject: card.mails[i].subject,
    text: card.mails[i].text, followUpOf, sendAt: new Date(first + card.mails[i].after_days * 86400_000).toISOString(), addressType });
  const [q0] = await queueApproved(o.rail, o.userId, [item(0, null)]);
  if (q0?.status !== "queued" && q0?.status !== "already_queued") return { ok: false, why: "refused", reply: `The send rail refused it (${q0?.reason ?? "unknown"}), so nothing was sent.`, queued: [q0] };
  const queued = [q0], send_at = [item(0, null).sendAt];
  for (let i = 1; i < saved.length; i++) {
    const it = item(i, q0.id ?? null);
    const [q] = await queueApproved(o.rail, o.userId, [it]);
    queued.push(q); send_at.push(it.sendAt);
    await o.limits.record({ user: o.userId, email_hash: emailHash, step: i, day, cap: c.dailyNew, queue_id: q.id ?? null });
  }
  return { ok: true, queued, send_at };
}
