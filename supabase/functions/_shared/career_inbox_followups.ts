// FEATURE 8 (DIAGNOSIS-2026-10-25 §2.4, §2.5): inbox awareness and follow-ups that can be sent, on the live chat path.
// WO-107 gave chat one read model of the person's applications (career_standing.ts), but it only reads what the mail run
// recorded, and the mail run is a schedule that was never deployed; a drafted follow-up had no way out but copy and paste.
// This turn, code's like the card and before the router or any brain, adds three things and builds none of them anew:
//   check   "check my email now", "I just connected my Gmail": ONE mail run for this person only, through the scheduled
//           run's own code (career_proactive_run.ts runMail: the Gmail read, the classifier, the status events, the
//           follow-up drafts, the queue confirmations, the read cursor), behind the same switch (CAREER_MAIL_TRACKING=on).
//           What that run would have texted is said in this reply instead, so the read model has data without a schedule
//           and every record it reads (mail events, drafts, the queue's confirmation, the cursor) is the run's own.
//   card    "draft the follow-up to Stripe", "send the thank-you to Acme": the follow-up the read model calls drafted or
//           due for that employer, shown as one email through the outreach card path (career_outreach_drafts: one
//           recipient, the exact subject and text, its SHA-256). The address is the one the person typed or the one their
//           emailed application went to; never guessed. Nothing is sent by showing it.
//   yes     while that card is this thread's last word (by its id): approved for exactly that hash, claimed through the
//           database's career_outreach_claim (age, pause, do-not-contact; no volume limit, NO LIMITS), and sent once from the person's
//           own Gmail, only with CAREER_EMAIL_SEND=on and a career grant that may send; otherwise the reply says exactly
//           which is missing and the card stays. A sent one is recorded on its mail draft as 'sent', so it is never due again.
import type { EventStore } from "./agent/timeline.ts";
import type { Outbox } from "./career_alert_store.ts";
import { type ConfirmStore } from "./career_apply_confirm.ts";
import { assessmentDeadline, type Deadline, type Draft, dueText as dueTextOf, sameCompany } from "./career_mail.ts";
import { careerTokenFor, CAREER_READ_SCOPE, type ReadResult, readMailSince, type TokenDeps } from "./career_mail_gmail.ts";
import type { MailStore } from "./career_mail_store.ts";
import { type Admit, dayStartOf, type Message, messageOf, type OutreachDraft, type OutreachStore, payloadHash, recordOutreach, type SendResult } from "./career_outreach.ts";
import { ONE_ADDRESS } from "./career_outreach_gmail.ts";
import { runMail } from "./career_proactive_run.ts";
import { type DraftRow, type ReadStanding, standingFrom } from "./career_standing.ts";
import { vaultRefreshWrite } from "./oauth_vault_refresh.ts";
import { PARTIAL_WORDS } from "./oauth_connect.ts";

export const CHECK_INTENT = "career_inbox_check";
export const FOLLOWUP_CARD_INTENT = "career_followup_card";
export const FOLLOWUP_ANSWER_INTENT = "career_followup_answer";
const DAY = 86_400_000;

// ------------------------------------------------------------------------------------------------ what the person says
export type FollowupAsk =
  | { kind: "check"; connected: boolean }
  | { kind: "card"; which: "followup" | "thank_you" | null; company: string; to: string | null }
  | { kind: "yes" } | { kind: "no" } | { kind: "to"; to: string } | { kind: "body"; text: string } | { kind: "sign"; text: string };
const ADDRESS = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/;
const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()} `;
const CHECK = /^ (?:(?:please|can you|could you|pls) )?(?:check|read|scan|look through|go through|refresh|sync|recheck|re-check) (?:my |the )?(?:e-?mails?|gmail|inbox|mail|mailbox)(?: inbox)?(?: (?:now|again|right now|for me|for (?:updates|news|replies|responses)))*(?: please)? $/;
const CONNECTED = /^ (?:ok |okay |done |there )?(?:(?:i|i'?ve|i have)(?: just)? |just )(?:connected|linked|hooked up|added) (?:my )?(?:gmail|google|e-?mail|inbox)(?: account)?(?: now| just now)? $|^ (?:my )?(?:gmail|google account|e-?mail) is (?:now )?connected(?: now)? $/;
const KIND = "(follow[- ]?up|thank[- ]?you|thanks)(?: (?:note|email|e-mail|message|letter))?";
const CARD = [
  new RegExp(`^ (?:(?:please|can you|could you|pls) )?(?:draft|write|send|prepare|make|do|show me) (?:the|a|my|that|an) ${KIND} (?:to|for|with) (.+?) $`),
  new RegExp(`^ (?:(?:please|can you|could you|pls) )?(?:send|email|e-mail) (.+?) (?:the|a|my|that) ${KIND} $`),
  /^ (?:(?:please|can you|could you|pls) )?(follow[- ]?up) with (.+?)(?: for me)? $/,
];
const NOT_COMPANY = /^(?:anyone|anybody|everyone|them|they|it|you|me|my applications?|the employers?|employers|companies|who|whom)$/;
function companyOf(raw: string): { company: string | null; to: string | null } {
  const to = ADDRESS.exec(raw)?.[0]?.toLowerCase() ?? null;
  const c = raw.replace(ADDRESS, " ").replace(/\b(?:at|to|via|using|on)\s*$/i, "").replace(/\s+(?:now|please|for me|today)$/i, "").replace(/^(?:the|my)\s+/i, "")
    .replace(/[,;:]+$/, "").replace(/\s+/g, " ").trim();
  return { company: c && c.length <= 80 && !NOT_COMPANY.test(c.toLowerCase()) ? c : null, to };
}
const asTyped = (message: string, lower: string) => { const i = message.toLowerCase().indexOf(lower); return i >= 0 ? message.slice(i, i + lower.length) : lower; };
// The asks this turn takes at any time. null: not one of them.
export function followupAsk(message: string): FollowupAsk | null {
  const t = plain(message);
  if (CHECK.test(t)) return { kind: "check", connected: false };
  if (CONNECTED.test(t)) return { kind: "check", connected: true };
  for (const [i, re] of CARD.entries()) {
    const m = re.exec(t);
    if (!m) continue;
    const [kindWord, target] = i === 1 ? [m[2], m[1]] : [m[1], m[2]];
    const { company, to } = companyOf(asTyped(String(message), target.trim()));
    if (!company) return null;
    const which = /^follow/.test(kindWord) ? "followup" : /^thank/.test(kindWord) ? "thank_you" : null;
    return { kind: "card", which, company, to };
  }
  return null;
}
// The answers this turn takes only while its card or its question is the thread's last word.
export function followupAnswer(message: string): FollowupAsk | null {
  const raw = String(message ?? "").trim();
  const body = /^(?:body|text|change it to|edit)\s*:\s*([\s\S]+)$/i.exec(raw);
  if (body) return { kind: "body", text: body[1].trim() };
  const sign = /^sign (?:it |them |my emails |emails |off )?(?:as |with )?([\s\S]{1,300})$/i.exec(raw);
  if (sign) return { kind: "sign", text: sign[1].trim() };
  const t = plain(raw).trim();
  const addr = ADDRESS.exec(raw)?.[0]?.toLowerCase();
  if (addr && (t === addr || /^(?:send it |send |it goes |use |address is |the address is )?(?:to |at )?\S+@\S+$/.test(t))) return { kind: "to", to: addr };
  if (/^(?:yes|yep|yeah|y|ok|okay|send it|yes send it|yes,? send it|send|go ahead|send it now|yes please)$/.test(t)) return { kind: "yes" };
  if (/^(?:no|nope|n|don'?t send(?: it)?|do not send(?: it)?|cancel|drop it|skip it|not now)$/.test(t)) return { kind: "no" };
  return null;
}

// ------------------------------------------------------------------------------------------------ the mail run, now
export interface Reminder { who: string; at: number }
export type MailNow =
  | { status: "ok"; read: number; statuses: string[]; offers: string[]; read_through: string | null; reminders?: Reminder[] }
  | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string; statuses: string[]; offers: string[]; reminders?: Reminder[] };
// EM-08: when an assessment's reminder is due. A stated date (no time): the day before, 14:00 UTC (morning in the
// Americas, afternoon in Europe). A time limit: 24 hours before it ends, or halfway when the limit is shorter than 2 days.
export function remindAt(d: Deadline, sentMs: number): number {
  const due = Date.parse(d.at);
  if (d.dated) return due - 86_400_000 + 14 * 3_600_000;
  return due - Math.min(86_400_000, Math.max(0, (due - sentMs) / 2));
}
const dayWord = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
// One run of the scheduled mail tracking (runMail) for this person only. Its texts are collected for this reply instead of
// the outbox; everything it records (events, drafts, confirmations, the cursor) it records exactly as on its schedule.
export async function mailNow(o: {
  userId: string; now: number; store: MailStore; cursor: (userId: string) => Promise<string | null>;
  read: (userId: string, sinceMs: number, nowMs: number) => Promise<ReadResult>; confirm?: ConfirmStore | null;
}): Promise<MailNow> {
  const said: { kind: string; text: string; key: string }[] = [];
  const outbox: Outbox = { enqueue: async (_u, m) => { said.push({ kind: m.kind, text: m.text, key: m.key }); return true; } };
  let got = null as ReadResult | null;
  const read_through = await o.cursor(o.userId);
  const store: MailStore = { ...o.store, people: async () => [{ user_id: o.userId, read_through }] };
  const statuses = () => said.filter((s) => s.kind === "status").map((s) => s.text), offers = () => said.filter((s) => s.kind === "followup").map((s) => s.text);
  // EM-08: an assessment this read moved (its status was said, so it was recorded just now and never before) gets one
  // reminder before its deadline, when the email states one and the reminder's time is still ahead.
  const remind = async (): Promise<Reminder[]> => {
    const out: Reminder[] = [];
    const write = o.confirm?.remind?.bind(o.confirm);
    if (!got || !write) return out;
    for (const m of got.mails) {
      const text = said.find((s) => s.kind === "status" && s.key === `status:${m.hash}`)?.text;
      const who = text ? /^(.+?) sent an assessment on /.exec(text)?.[1] : null;
      const d = who ? assessmentDeadline(m) : null;
      if (!who || !d) continue;
      const at = remindAt(d, Date.parse(m.date));
      if (!(at > o.now)) continue;
      const line = `Reminder: your ${who} assessment is ${dueTextOf(d)}. The link is in their email; Trainee doesn't take assessments for you.`;
      try {
        if (await write(o.userId, { key: `status:deadline:${m.hash}`, text: line, at })) out.push({ who, at });
      } catch (e) {
        console.error("mail: deadline reminder not queued", e instanceof Error ? e.message : String(e));
      }
    }
    return out;
  };
  try {
    await runMail({ outbox, now: o.now, store, confirm: o.confirm ?? null, batch: 1, read: async (u, since, now) => (got = await o.read(u, since, now)) });
  } catch (e) {
    // The read's own failure, in the person's words; the run's internal summary ("failed for 1 people") is for the logs.
    console.error("mail now:", e instanceof Error ? e.message : String(e));
    const r = got as ReadResult | null;
    const detail = r?.status === "ERROR" ? "Gmail returned an error partway through" : r?.status === "RATE_LIMITED" ? "Gmail asked Trainee to slow down" : "something went wrong saving what was read";
    return { status: "ERROR", detail, statuses: statuses(), offers: offers(), reminders: await remind() };
  }
  if (!got || (got as ReadResult).status === "NOT_WIRED") return { status: "NOT_WIRED" };
  const r = got as ReadResult;
  if (r.status === "RATE_LIMITED") return { status: "ERROR", detail: "Gmail asked Trainee to slow down", statuses: statuses(), offers: offers(), reminders: await remind() };
  return { status: "ok", read: r.mails.length, statuses: statuses(), offers: offers(), read_through: r.readThrough !== null ? new Date(r.readThrough).toISOString() : read_through, reminders: await remind() };
}

// ------------------------------------------------------------------------------------------------ the card
export interface Card { key: string; ref: string; kind: "followup" | "thank_you"; company: string; role?: string | null; text: string; basis: string; to?: string | null; via?: string | null }
export interface FollowupDeps {
  read: ReadStanding;
  outreach: OutreachStore;
  events?: EventStore | null;
  lastAssistant: (threadId: string) => Promise<{ intent: string | null; meta: Record<string, unknown> } | null>;
  // The address the person's emailed application went to, for this application ref; null when there is none on record.
  addressOnRecord: (userId: string, ref: string) => Promise<string | null>;
  name: () => string | null; // the person's own name on their profile, for the sign-off when no signature is set
  markSent: (userId: string, c: Card, outreachId: string, at: number) => Promise<void>;
  mailOn: boolean; readNow: (userId: string) => Promise<MailNow>;
  sendOn: boolean; canSend: (userId: string) => Promise<boolean>; send: (userId: string, m: Message) => Promise<SendResult>;
  connectAsk?: string;
  // CONNECTORS ROUND 3 (2026-10-31): whether the person's Gmail grant may read mail (a partial grant: the box left unticked
  // at Google). Absent: not told apart from a Gmail that isn't connected.
  readGrant?: (userId: string) => Promise<"ok" | "not_connected" | "not_allowed">;
}
export interface FollowupTurn { reply: string; status: string; intent: string; meta?: Record<string, unknown> | null }
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const word = (k: Card["kind"]) => (k === "followup" ? "follow-up" : "thank-you");
const subjectOf = (c: Card) => clip(c.kind === "followup" ? `Following up on my ${c.role ? `${clip(c.role, 80)} ` : ""}application` : `Thank you${c.role ? `: ${clip(c.role, 80)} interview` : ""}`, 150);
const VIA: Record<string, string> = { typed: "the address you gave", record: "the address your application was emailed to" };
// The card's exact message as a mailto link: the person's own mail app opens it addressed, with this subject and text.
export function mailtoOf(m: Message): string {
  return `mailto:${m.to}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.text)}`;
}
// sends: Trainee may send this from the person's Gmail (CAREER_EMAIL_SEND=on and a grant with gmail.send). Otherwise, as
// Google verification ships it (gmail.readonly only, PR #196), the card says plainly that Trainee doesn't send, and gives
// the exact text to copy and the same text as a mailto link.
export function cardText(d: OutreachDraft, c: Card, sends = true): string {
  const m = messageOf(d);
  const head = `Your ${word(c.kind)} to ${clip(c.company, 80)}${c.role ? ` (${clip(c.role, 80)})` : ""}, ${sends ? "ready to send from your Gmail" : "ready for you to send"} (${c.basis}):`;
  const tail = sends
    ? `Nothing is sent until you say yes, and a yes sends exactly this, once. Say "body: your words" to change it, "to name@company.com" for another address, or "no".`
    : `Trainee doesn't send email for you: copy it into your own email, or open it ready to send in your mail app: ${mailtoOf(m)}\nSay "body: your words" to change it, "to name@company.com" for another address, or "no".`;
  return [head, `To: ${m.to} (${VIA[c.via ?? "typed"] ?? "the address you gave"})`, `Subject: ${m.subject}`, "", m.text, "", tail].join("\n");
}
const ADMIT: Record<Exclude<Admit, "ok">, string> = {
  not_approved: "the approval was not recorded", changed: "the email changed after you saw it", expired: "the approval is too old",
  paused: "your account is paused", do_not_contact: "that address asked not to be contacted",
};

// Someone the person wrote to through Trainee (their own outreach drafts), by full name or first name.
async function isOutreachPerson(store: OutreachStore, userId: string, name: string): Promise<boolean> {
  if (!store.history) return false;
  const want = String(name ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!want) return false;
  const rows = await store.history(userId, 500).catch(() => []);
  return rows.some((d) => { const n = String(d.recipient?.name ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim(); return n === want || n.split(" ")[0] === want; });
}
// Which follow-up the person means: the drafted one for that employer first, then the due one, of the kind they named.
function pick(rows: { drafts: DraftRow[]; due: Draft[] }, company: string, which: Card["kind"] | null): Card[] {
  const drafted: Card[] = rows.drafts.filter((d) => sameCompany(d.company, company)).map((d) => ({ key: d.draft_key, ref: d.application_ref, kind: d.kind, company: d.company, role: d.role, text: d.text, basis: d.basis }));
  const due: Card[] = rows.due.filter((d) => sameCompany(d.company, company) && !drafted.some((x) => x.key === d.key)).map((d) => ({ key: d.key, ref: d.ref, kind: d.kind, company: d.company, role: d.role ?? null, text: d.text, basis: d.basis }));
  return [...drafted, ...due].filter((c) => !which || c.kind === which);
}

export async function followupTurn(o: { message: string; userId: string; threadId: string; now: number; deps: FollowupDeps }): Promise<FollowupTurn | null> {
  const ask = followupAsk(o.message);
  if (ask?.kind === "check") return await checkTurn(o, ask.connected);
  if (ask?.kind === "card") return await cardTurn(o, ask);
  const ans = followupAnswer(o.message);
  if (!ans) return null;
  let last: { intent: string | null; meta: Record<string, unknown> } | null;
  try { last = await o.deps.lastAssistant(o.threadId); } catch (e) { console.error("follow-up: last reply not read", e instanceof Error ? e.message : String(e)); return null; }
  if (!last || last.intent !== FOLLOWUP_CARD_INTENT) return null;
  if (last.meta?.followup_ask && typeof last.meta.followup_ask === "object") return await askAnswer(o, ans, last.meta.followup_ask as Card);
  if (typeof last.meta?.followup_card === "string") return await cardAnswer(o, ans, last.meta.followup_card, last.meta.followup as Card | undefined);
  return null;
}

async function checkTurn(o: { userId: string; deps: FollowupDeps }, connected: boolean): Promise<FollowupTurn> {
  const lead = connected ? "Thanks for connecting. " : "";
  if (!o.deps.mailOn) return { reply: `${lead}I haven't read your mail: reading it is not switched on in Trainee yet, so nothing was read from your inbox. What I have on record is what you told me and what Trainee sent.`, status: "MAIL_OFF", intent: CHECK_INTENT };
  const r: MailNow = await o.deps.readNow(o.userId).catch((e) => ({ status: "ERROR" as const, detail: e instanceof Error ? e.message : String(e), statuses: [], offers: [] }));
  // CONNECTORS ROUND 3 (2026-10-31): said in plain words (it began with an internal code), and a Gmail connected without
  // the permission to read mail is told so, with how to give it, instead of being asked to connect what is connected.
  if (r.status === "NOT_WIRED") {
    const why = o.deps.readGrant ? await o.deps.readGrant(o.userId).catch(() => null) : null;
    if (why === "not_allowed") return { reply: PARTIAL_WORDS.gmail.read, status: "NOT_WIRED", intent: CHECK_INTENT };
    return { reply: `Nothing was read: Trainee can't read your Gmail yet. Connect it (it asks to read your mail), then say "check my email".${o.deps.connectAsk ? `\n\n${o.deps.connectAsk}` : ""}`, status: "NOT_WIRED", intent: CHECK_INTENT };
  }
  const reminded = (r.reminders ?? []).map((x: Reminder) => `I'll remind you on ${dayWord(x.at)} that the ${x.who} assessment is due.`);
  const found = [...r.statuses, ...reminded, ...r.offers.map((x) => `${x}\nSay "send the ${/thank-you/.test(x) ? "thank-you" : "follow-up"} to" and the company to see it as an email you can send yourself.`)];
  if (r.status === "ERROR") {
    console.error("follow-up: mail read", r.detail);
    return { reply: [`I couldn't finish reading your mail just now: ${clip(r.detail, 160)}. What I read before that is kept; ask me again in a minute.`, ...found].join("\n\n"), status: "ERROR", intent: CHECK_INTENT };
  }
  const when = r.read_through ? new Date(r.read_through).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  const head = `${lead}I read your mail${when ? ` through ${when}` : ""}: ${r.read} new message${r.read === 1 ? "" : "s"}, read from your Gmail only (sender, subject and preview).`;
  return { reply: [head, ...(found.length ? found : ["Nothing in it changes any of your applications."])].join("\n\n"), status: found.length ? "updated" : "nothing_new", intent: CHECK_INTENT };
}

async function cardTurn(o: { userId: string; threadId: string; now: number; deps: FollowupDeps }, ask: Extract<FollowupAsk, { kind: "card" }>): Promise<FollowupTurn | null> {
  const done = (reply: string, status: string): FollowupTurn => ({ reply, status, intent: FOLLOWUP_ANSWER_INTENT });
  const s = standingFrom(await o.deps.read(o.userId), o.now);
  if ((s.unreadable.includes("mail") || s.unreadable.includes("drafts")) && await isOutreachPerson(o.deps.outreach, o.userId, ask.company)) return null;
  if (s.unreadable.includes("mail") || s.unreadable.includes("drafts")) return done(`I couldn't read your mail record just now, so I can't tell whether ${clip(ask.company, 80)} replied; nothing was drafted or sent. Ask me again in a minute.`, "unreadable");
  const what = ask.which ? word(ask.which) : "follow-up";
  const found = pick(s, ask.company, ask.which);
  if (!found.length) {
    const sent = (s.sent ?? []).find((d) => sameCompany(d.company, ask.company) && (!ask.which || d.kind === ask.which));
    if (sent) return done(`Your ${word(sent.kind)} to ${clip(sent.company, 80)} was already sent from your Gmail on your yes; nothing more is due for it.`, "already_sent");
    const known = s.apps.some((a) => sameCompany(a.company, ask.company)) || s.tracker.some((a) => sameCompany(a.company, ask.company));
    // FAMILY NETWORKING: "follow up with Maya" names a person the person emailed through Trainee, not an employer: the
    // networking turn after this one answers it (career_outreach_track.ts). Only when no application matches the name.
    if (!known && await isOutreachPerson(o.deps.outreach, o.userId, ask.company)) return null;
    return done(known
      ? `No ${what} is due for ${clip(ask.company, 80)} right now: an application gets a follow-up after 14 days with no reply, and an interview step a thank-you after 7 days with nothing since. Nothing was drafted or sent.`
      : `There's no application to ${clip(ask.company, 80)} on record, so there's no ${what} to send. Nothing was drafted or sent.`, "none_due");
  }
  const c = found[0];
  if (ask.to) return await show(o, { ...c, to: ask.to, via: "typed" });
  const onRecord = await o.deps.addressOnRecord(o.userId, c.ref).catch(() => null);
  if (onRecord) return await show(o, { ...c, to: onRecord, via: "record" });
  return { reply: `I have the ${word(c.kind)} for ${clip(c.company, 80)} (${c.basis}):\n\n${c.text}\n\nWho should it go to? Trainee has no address for ${clip(c.company, 80)} on record and won't guess one: send the address (for example, the recruiter who wrote to you), or copy the text and send it yourself.`,
    status: "need_address", intent: FOLLOWUP_CARD_INTENT, meta: { followup_ask: c } };
}

// The card, saved through the outreach store as one message whose hash is the approval's only key.
async function show(o: { userId: string; threadId: string; now: number; deps: FollowupDeps }, c: Card, lead = ""): Promise<FollowupTurn> {
  if (!c.to || !ONE_ADDRESS.test(c.to)) return { reply: `"${clip(c.to, 80)}" isn't one plain email address, so nothing was drafted. Send one address, like name@company.com.`, status: "bad_address", intent: FOLLOWUP_CARD_INTENT, meta: { followup_ask: { ...c, to: null } } };
  const prefs = await o.deps.outreach.prefs(o.userId).catch(() => ({ signature: null, daily_cap: null }));
  const signature = clip(prefs.signature, 300) || clip(o.deps.name(), 120);
  if (!signature) return { reply: `How do you sign your emails? Say "sign as" and your name the way you want it at the bottom; then I'll show the ${word(c.kind)} to ${clip(c.company, 80)}.`, status: "need_signature", intent: FOLLOWUP_CARD_INTENT, meta: { followup_ask: c } };
  const base = { n: 1, recipient: { name: clip(c.company, 120), firm: clip(c.company, 120), title: "", school: "", email: c.to, source: `${word(c.kind)} (${clip(c.basis, 120)})` },
    subject: subjectOf(c), body: c.text.trim().slice(0, 4000), footer: signature, shared: [], status: "shown" as const,
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  const hash = await payloadHash(messageOf(base));
  const [d] = await o.deps.outreach.saveBatch(o.userId, o.threadId, [{ ...base, hash }], o.now);
  // On the account's timeline as outreach (the kinds the timeline knows), marked as this follow-up.
  await recordOutreach(o.deps.events, o.userId, "outreach_drafted", d, o.now, { followup: c.kind, key: c.key });
  const sends = o.deps.sendOn && await o.deps.canSend(o.userId).catch(() => false);
  return { reply: `${lead}${cardText(d, c, sends)}`, status: "shown", intent: FOLLOWUP_CARD_INTENT, meta: { followup_card: d.id, followup: c } };
}

async function askAnswer(o: { userId: string; threadId: string; now: number; deps: FollowupDeps }, ans: FollowupAsk, c: Card): Promise<FollowupTurn | null> {
  if (ans.kind === "no") return { reply: "Dropped. Nothing was sent.", status: "declined", intent: FOLLOWUP_ANSWER_INTENT };
  if (ans.kind === "to") return await show(o, { ...c, to: ans.to, via: "typed" });
  if (ans.kind === "sign") {
    const sig = ans.text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    if (!sig || sig.length > 300) return { reply: "A signature is 1 to 300 characters; nothing was saved.", status: "bad_signature", intent: FOLLOWUP_CARD_INTENT, meta: { followup_ask: c } };
    await o.deps.outreach.setPrefs(o.userId, { signature: sig });
    if (c.to) return await show(o, c, `Saved "${sig}" as how you sign your emails.\n\n`);
    return { reply: `Saved "${sig}" as how you sign your emails. Who should the ${word(c.kind)} to ${clip(c.company, 80)} go to? Send the address.`, status: "need_address", intent: FOLLOWUP_CARD_INTENT, meta: { followup_ask: c } };
  }
  return null;
}

async function cardAnswer(o: { userId: string; threadId: string; now: number; deps: FollowupDeps }, ans: FollowupAsk, id: string, c: Card | undefined): Promise<FollowupTurn | null> {
  const done = (reply: string, status: string): FollowupTurn => ({ reply, status, intent: FOLLOWUP_ANSWER_INTENT });
  const waiting = (reply: string, status: string): FollowupTurn => ({ reply, status, intent: FOLLOWUP_CARD_INTENT, meta: { followup_card: id, followup: c } });
  const s = o.deps.outreach;
  const d = (await s.latestBatch(o.userId)).find((x) => x.id === id);
  if (!d || !c || d.status !== "shown") return d && c && d.status === "sent" ? done(`That ${word(c.kind)} was already sent; nothing more went.`, "already_sent") : null;
  const co = clip(c.company, 80);
  if (Date.parse(d.created_at) < o.now - DAY) return done(`That email is more than a day old, so nothing was sent. Say "send the ${word(c.kind)} to ${co}" for a fresh one.`, "expired");
  if (ans.kind === "no") {
    await s.update(o.userId, { ...d, status: "skipped" }, { status: "shown" });
    return done("Dropped. Nothing was sent.", "declined");
  }
  if (ans.kind === "to") return await show(o, { ...c, to: ans.to, via: "typed" });
  if (ans.kind === "body") return await show(o, { ...c, text: ans.text.slice(0, 1500) }, "New version, in your words. Nothing is approved for it yet.\n\n");
  if (ans.kind !== "yes") return null;
  // The yes: exactly the message on the card, by its hash, here and again in the database's claim.
  const m = messageOf(d), h = await payloadHash(m);
  if (h !== d.hash) return done("Not sent: the email changed after you saw it, so your yes was not for this version.", "changed");
  // Sending is deferred (Google verification asks for gmail.readonly only): a yes sends nothing, and the reply says so plainly
  // and hands over the exact text, never a connection step that would not add sending.
  const yourself = `Copy the email above into your own email, or open it ready to send: ${mailtoOf(m)}`;
  if (!o.deps.sendOn) return waiting(`Not sent: Trainee doesn't send email for you, so nothing went to ${co}. ${yourself}`, "SEND_OFF");
  if (!(await o.deps.canSend(o.userId).catch(() => false))) {
    return waiting(`Not sent: your Google connection lets Trainee read your mail, not send it, so nothing went to ${co}. ${yourself}`, "NOT_WIRED");
  }
  const at = new Date(o.now).toISOString();
  const approved: OutreachDraft = { ...d, status: "approved", approved_hash: h, approved_at: at };
  if (!(await s.update(o.userId, approved, { status: "shown", hash: h }))) return done("Not sent: the email changed after you saw it, so your yes was not for this version.", "changed");
  const admit = await s.claim(o.userId, approved, h, o.now, dayStartOf(o.now));
  if (admit !== "ok") {
    await s.update(o.userId, { ...approved, status: "shown", approved_hash: null, approved_at: null, result: admit }, { status: "approved" });
    return waiting(`Not sent: ${ADMIT[admit] ?? admit}. Nothing went to ${co}.`, admit);
  }
  const sending: OutreachDraft = { ...approved, status: "sending", sent_at: at };
  const r = await o.deps.send(o.userId, m).catch((e) => ({ status: "ERROR", detail: e instanceof Error ? e.message : String(e) }) as SendResult);
  if (r.status === "sent") {
    await s.update(o.userId, { ...sending, status: "sent", gmail_id: r.id, gmail_thread: r.thread_id, result: "sent" }, { status: "sending" });
    await o.deps.markSent(o.userId, c, d.id, o.now).catch((e) => console.error("follow-up: sent, not marked on the mail draft", e instanceof Error ? e.message : String(e)));
    await recordOutreach(o.deps.events, o.userId, "outreach_sent", d, o.now, { followup: c.kind, key: c.key });
    return done(`Sent to ${m.to} from your Gmail: your ${word(c.kind)} to ${co}, exactly as shown. I'll tell you when ${co} writes back, once I read your mail.`, "sent");
  }
  // Nothing went (no grant that may send, a limit, Gmail's refusal): the same card waits for a fresh yes.
  await s.update(o.userId, { ...sending, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: r.status === "NOT_WIRED" ? "not_wired" : r.status === "RATE_LIMITED" ? "rate_limited" : `error: ${r.detail}`.slice(0, 200) }, { status: "sending" });
  if (r.status === "NOT_WIRED") return waiting(`Not sent: your Google connection doesn't let Trainee send email, so nothing went to ${co}. ${yourself}`, "NOT_WIRED");
  if (r.status === "RATE_LIMITED") return waiting(`Not sent: Gmail asked Trainee to slow down. Nothing went to ${co}; say yes again in a few minutes.`, "rate_limited");
  return waiting(`Not sent: Gmail refused it (${clip(r.detail, 120)}). Nothing went to ${co}; say yes to try once more.`, "refused");
}

// ------------------------------------------------------------------------------------------------ Supabase
// deno-lint-ignore no-explicit-any
export function supabaseFollowupStores(admin: any) {
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    async lastAssistant(threadId: string) {
      const rows = must(await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply");
      const meta = rows?.[0]?.meta ?? null;
      return meta ? { intent: meta.intent ?? null, meta } : null;
    },
    // Only an application the person emailed through Trainee carries the address it went to (career_apply_email.ts).
    async addressOnRecord(userId: string, ref: string) {
      const id = /^job:(.+)$/.exec(ref)?.[1];
      if (!id) return null;
      const r = must(await admin.from("career_apply_jobs").select("evidence").eq("user_id", userId).eq("id", id).maybeSingle(), "read the application");
      const to = String(r?.evidence?.to ?? "").trim().toLowerCase();
      return ONE_ADDRESS.test(to) ? to : null;
    },
    async markSent(userId: string, c: Card, outreachId: string, at: number) {
      must(await admin.from("career_mail_drafts").upsert({ user_id: userId, draft_key: c.key, application_ref: c.ref, kind: c.kind, company: clip(c.company, 200), role: c.role ? clip(c.role, 200) : null,
        text: c.text.slice(0, 1500), basis: clip(c.basis, 200), state: "sent", sent_at: new Date(at).toISOString(), outreach_draft: outreachId }, { onConflict: "user_id,draft_key" }), "mark the follow-up sent");
    },
    async cursor(userId: string) {
      const r = must(await admin.from("career_mail_cursors").select("read_through").eq("user_id", userId).maybeSingle(), "read the mail cursor");
      return (r?.read_through ?? null) as string | null;
    },
  };
}
// The career Google grant (vault oauth_google_career_<uid>), read the way the scheduled run reads it (career-proactive).
// deno-lint-ignore no-explicit-any
export function careerGrant(admin: any, env: { get(k: string): string | undefined }, f: typeof fetch): TokenDeps {
  return {
    env, fetch: f, now: Date.now,
    connection: async (u) => {
      const { data, error } = await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle();
      if (error) throw new Error(`read the career grant: ${error.message}`);
      return data ?? null;
    },
    readVault: async (name) => {
      const { data, error } = await admin.rpc("oauth_vault_read", { p_name: name });
      if (error) throw new Error("read the career grant's vault entry");
      return data ? String(data) : null;
    },
    writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed career grant"),
  };
}
// CONNECTORS ROUND 3: may the person's career Google grant read mail? (FollowupDeps.readGrant)
export const gmailReadGrant = (admin: any) => async (userId: string): Promise<"ok" | "not_connected" | "not_allowed"> => {
  const { data, error } = await admin.from("user_oauth_connections").select("scopes").eq("user_id", userId).eq("provider", "google_career").maybeSingle();
  if (error) throw new Error(`read the career grant: ${error.message}`);
  if (!data) return "not_connected";
  return String(data.scopes ?? "").split(/[\s,]+/).includes(CAREER_READ_SCOPE) ? "ok" : "not_allowed";
};
// The person's mail, read now with the career grant's gmail.readonly, through the scheduled run's reader.
export const gmailReadNow = (grant: TokenDeps, f: typeof fetch) => (userId: string, since: number, now: number) =>
  readMailSince({ fetch: f, token: careerTokenFor(grant, CAREER_READ_SCOPE) }, userId, since, now);
