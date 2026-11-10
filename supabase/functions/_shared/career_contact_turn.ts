// CONTACT OUTREACH, release 10 (connector wiring): the chat turn that puts a stored contact's email on a card and sends
// exactly that card on the person's yes. Behind CAREER_CONTACT_OUTREACH; a contact the pipeline found itself also needs
// CAREER_PEOPLE_SEARCH, and one the person supplied (supplied_by "person") does not (D-048 option a, contactSendOn). Off, the
// turn claims nothing except a yes to a card shown while it was on, and that yes is refused: nothing is saved, queued or sent.
//   show   "email Jane Doe" / "email Jane Doe at Acme with 2 follow-ups": a contact the person resolved earlier
//          (career_contact_profiles, by name), drafted from cited facts and the person's confirmed facts only
//          (career_contact_draft.ts), put on a card (career_contact_send.ts contactCard). The card rides the reply's meta
//          (contact_card) and is the thread's last word.
//   yes    a yes while that card is the thread's last word (no turn after it, within YES_WINDOW_MS), optionally with the
//          card's code (the first 6 of its hash; a code that is not this card's approves nothing). The config is read
//          again at the yes, so a switch turned off, a test list changed or a postal address removed refuses a card shown
//          earlier. The card in the meta is never trusted: the stored contact is read again, and every mail is rebuilt
//          and re-hashed, the first email's checks run again on the stored facts, the follow-ups' checks too. Then
//          approveContactCard: the yes must be the card's hash, the send log decides "already emailed" (it outlives
//          forget and forget everything), the day's cap counts on the server's UTC day.
//   send   only through the existing rail (career_send_rail.ts queueApproved), from the person's own connected Gmail or
//          Outlook (mail_providers.ts sendProviders); with neither connected nothing is queued. There is no path that
//          sends from Trainee's own identity. Never to a no-reply, role or ATS/job-board inbox (automated_inbox.ts), and
//          never to an address off the contact's own company domain.
// Every failure fails closed: an unreadable store, a model error, a check that does not pass, a rail refusal.
import { contactAskOn, type ContactStore, contactSendOn, emailHash } from "./career_contact_pipeline.ts";
import { approveContactCard, cardHash, type ContactCard, contactCard, FOLLOWUPS_MAX, followupOk, footerFor, sendConfig, type SendConfig, type SendLimits } from "./career_contact_send.ts";
import { asData, checkContactDraft, type ContactDraft, type ContactIn, draftContactEmail, PROMPT_FACTS } from "./career_contact_draft.ts";
import { messageOf, type ModelFn, type OutreachStore, payloadHash, type Recipient } from "./career_outreach.ts";
import { automatedInbox, AUTOMATED_WHY } from "./automated_inbox.ts";
import type { QueueDeps } from "./career_send_rail.ts";
import { YES_WINDOW_MS } from "./career_apply_cards.ts";
import type { MxResolver } from "./career_contacts.ts";
import { confirmCard, parseSupplied, type Supplied, suppliedContact, suppliedProblem, SUPPLY_CONFIRM_INTENT } from "./career_contact_supply.ts";

export const CONTACT_CARD_INTENT = "career_contact_card", CONTACT_SEND_INTENT = "career_contact_send";
type Card = Extract<ContactCard, { ok: true }>;
export interface ShownCard { contact_id: string; hook: number; card: Card }
export interface ContactTurnOut { reply: string; intent: string; status: string; meta?: Record<string, unknown> }
export interface ContactTurnDeps {
  env: (k: string) => string | undefined; // read at every call: never cached
  mx: MxResolver; // the recipient domain's mail server, asked when the person confirms an address they gave
  contacts: Pick<ContactStore, "get" | "suppressed" | "save"> & { byName(userId: string, name: string, company?: string | null): Promise<string[]> };
  model: ModelFn;
  senderFacts: () => unknown[] | Promise<unknown[]>;
  signature: (userId: string) => Promise<string | null>;
  mailboxes: (userId: string) => Promise<{ id: "gmail" | "outlook" }[]>; // the person's own, that can send
  lastCard: () => Promise<{ meta: Record<string, unknown> | null; at: number } | null>; // the thread's last word
  store: Pick<OutreachStore, "saveBatch" | "update">;
  rail: QueueDeps;
  limits: SendLimits;
}

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, "1": 1, "2": 2 };
// "email Jane Doe", "reach out to Jane Doe at Acme", "write to Jane Doe with 2 follow-ups".
export function contactAsk(message: string): { name: string; company: string | null; followups: number } | null {
  const m = /^\s*(?:please\s+)?(?:e-?mail|write to|reach out to|draft an? e-?mail to)\s+(.+?)(?:\s+(?:at|from)\s+(.+?))?(?:\s+with\s+(an?|one|two|1|2)\s+follow[- ]?ups?)?\s*[.!]*\s*$/i.exec(String(message ?? ""));
  if (!m) return null;
  const name = m[1].replace(/\s+/g, " ").trim();
  if (name.split(" ").length < 2 || name.length > 100 || /[@<>]/.test(name)) return null; // a full name, never an address
  return { name, company: m[2]?.trim() || null, followups: m[3] ? Math.min(FOLLOWUPS_MAX, NUM[m[3].toLowerCase()] ?? 0) : 0 };
}
// "yes", "send it", "yes 3fa9c1" (the card's code).
export function contactYes(message: string): { code: string | null } | null {
  const t = String(message ?? "").trim().toLowerCase();
  const code = /\b([0-9a-f]{6})\b/.exec(t)?.[1] ?? null;
  const rest = (code ? t.replace(code, " ") : t).replace(/[.!\s]+/g, " ").trim();
  return /^(?:yes|y|yep|yeah|ok|okay|approve|approved|send|send it|send them|yes send|yes send it|yes please|go ahead)$/.test(rest) ? { code } : null;
}

// The address may only be the contact's own: on the company's domain (a subdomain of it too), and a person's inbox.
export function addressProblem(c: ContactIn): string | null {
  const e = String(c.email.email ?? "").trim().toLowerCase(), pd = String(c.person.domain ?? "").trim().toLowerCase();
  const d = e.slice(e.lastIndexOf("@") + 1);
  if (!e.includes("@") || !pd) return `${c.person.name}'s address is unconfirmed, so I won't send to it.`;
  if (d !== pd && !d.endsWith(`.${pd}`)) return `${e} is not on ${c.person.company}'s own domain (${pd}), so I won't send to it.`;
  const why = automatedInbox(e, c.person.company);
  return why ? `${e} ${AUTOMATED_WHY[why]}, so I won't send to it.` : null;
}

const textOf = (msg: any) => (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("").trim();
// Follow-ups, written by the model from the first email only: each checked by followupOk (contactCard checks again).
export async function draftFollowups(model: ModelFn, c: ContactIn, d: ContactDraft, n: number): Promise<string[] | null> {
  if (n <= 0) return [];
  const system = [`Write ${n} short follow-up email${n > 1 ? "s" : ""} to an unanswered cold email, in plain text.`,
    "Each: at most 60 words, at most one question, no links, no email addresses, no sales words, no new claims about the sender or the recipient.",
    "No sign-off and no name at the end. Answer one per line, exactly:\nFollow-up 1: <text>" + (n > 1 ? "\nFollow-up 2: <text>" : "")].join("\n");
  let msg: any;
  try { msg = await model({ system, messages: [{ role: "user", content: `TO: ${c.person.name}\nFIRST EMAIL (data):\nSubject: ${d.subject}\n\n${d.body}` }], max_tokens: 400 }); } catch { return null; }
  const out = [...textOf(msg).matchAll(/^\s*follow-?up\s*(\d)\s*:\s*(.+)$/gim)].map((m) => ({ i: Number(m[1]), t: m[2].trim() })).sort((a, b) => a.i - b.i).map((x) => x.t);
  return out.length === n && out.every(followupOk) ? out : null;
}

const fmt = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const PROVIDER = { gmail: "Gmail", outlook: "Outlook" } as const;
function cardText(card: Card, contact: ContactIn, mailbox: string | null): string {
  const lines = [`To: ${contact.person.name}, ${contact.person.title ? `${contact.person.title}, ` : ""}${contact.person.company} <${card.to}>`];
  if (card.test_mode) lines.push(`Test mode: this goes to ${card.to}, not to ${card.found}.`);
  lines.push(`Address confidence ${card.score}/100.`);
  card.mails.forEach((m, i) => lines.push("", i === 0 ? "Email 1 (now):" : `Follow-up ${i} (day ${m.after_days}, only if they haven't replied):`, `Subject: ${m.subject}`, "", m.body, "", m.footer));
  lines.push("", `Reply yes to send exactly ${card.mails.length === 1 ? "this email" : `these ${card.mails.length} emails`} from your own ${mailbox ?? "Gmail or Outlook"} (card ${card.hash.slice(0, 6)}).`);
  return lines.join("\n");
}

// The card shown, as the meta stored it, checked again against the stored contact and today's config. null: it holds.
async function stale(shown: ShownCard, c: ContactIn, cfg: SendConfig, signature: string | null, senderFacts: unknown[]): Promise<string | null> {
  const card = shown.card, mails = Array.isArray(card?.mails) ? card.mails : [];
  if (!mails.length || mails.length > 1 + FOLLOWUPS_MAX) return "changed";
  const found = String(c.email.email ?? "").toLowerCase();
  if (!c.email.approvable || c.email.score < 70 || card.found !== found) return "changed";
  if (!cfg.testMode && card.to !== found) return "changed";
  if (!cfg.postalAddress || !signature?.trim()) return "changed";
  const footer = footerFor(signature, cfg.postalAddress);
  for (const [i, m] of mails.entries()) {
    if (m.footer !== footer || m.after_days !== (i === 0 ? 0 : cfg.followupDays * i)) return "changed";
    if (i > 0 && (m.subject !== `Re: ${mails[0].subject}` || !followupOk(m.body))) return "changed";
    const msg = messageOf({ recipient: { email: card.to } as Recipient, subject: m.subject, body: m.body, footer: m.footer });
    if (msg.text !== m.text || msg.subject !== m.subject || (await payloadHash(msg)) !== m.hash) return "changed";
  }
  const failed = checkContactDraft({ subject: mails[0].subject, body: mails[0].body, hook: Number(shown.hook) }, { facts: asData(c.facts).slice(0, PROMPT_FACTS), senderFacts, contact: c });
  if (failed.length) return "changed";
  return card.hash === (await cardHash(mails)) ? null : "changed";
}

// A contact the pipeline found itself, while people search is switched off (D-048 option a).
const SEARCH_OFF = (name: string, tail: string) => `I found ${name} by searching, and searching for people is switched off here, so I won't email them. ${tail} If you have their work address or a page that names them, send it to me.`;
const toContactIn = (r: { person: any; facts: any[]; email: any; expires_at: string }): ContactIn => ({ person: r.person, facts: r.facts ?? [], email: r.email ?? { email: null, method: null, score: 0, approvable: false, why: "" }, expires_at: r.expires_at });

export async function contactTurn(o: { message: string; userId: string; now: number; deps: ContactTurnDeps }): Promise<ContactTurnOut | null> {
  const d = o.deps, on = contactAskOn({ get: d.env });
  // A recipient the person wrote in this message (career_contact_supply.ts): read back for their confirmation first.
  const supplied = parseSupplied(o.message);
  if (supplied) {
    if (!on) return null;
    const bad = suppliedProblem(supplied);
    if (bad) return { reply: bad, intent: SUPPLY_CONFIRM_INTENT, status: "not_a_person" };
    const c = confirmCard(supplied);
    return { reply: c.reply, intent: SUPPLY_CONFIRM_INTENT, status: "awaiting_confirm", meta: c.meta };
  }
  const ask = contactAsk(o.message);
  if (ask) return on ? await show(o, ask) : null;
  const yes = contactYes(o.message);
  if (!yes) return null;
  const last = await d.lastCard();
  const supply = (last?.meta as any)?.contact_supply as Supplied | undefined;
  if (last && supply && typeof supply === "object") return await confirmSupplied(o, supply, last.at, yes.code);
  const shown = (last?.meta as any)?.contact_card as ShownCard | undefined;
  if (!last || !shown || typeof shown !== "object" || !shown.card || typeof shown.contact_id !== "string") return null;
  const refuse = (status: string, reply: string): ContactTurnOut => ({ reply, intent: CONTACT_SEND_INTENT, status });
  // Read fresh at the yes: a switch turned off since the card was shown refuses it.
  if (!on) return refuse("off", "Contact outreach is switched off, so nothing was sent.");
  if (yes.code && !String(shown.card.hash ?? "").startsWith(yes.code)) return refuse("changed", "That code isn't the card I showed last, so nothing was sent.");
  if (o.now - last.at > YES_WINDOW_MS || o.now < last.at) return refuse("expired", `That card was shown too long ago to approve with a text, so nothing was sent. Ask me to email ${shown.card.found ? "them" : "this person"} again for a fresh card.`);
  const row = await d.contacts.get(o.userId, shown.contact_id);
  if (!row) return refuse("gone", "I no longer have that contact, so nothing was sent.");
  const contact = toContactIn(row);
  if (!contactSendOn({ get: d.env }, row.person?.supplied_by)) return refuse("off", SEARCH_OFF(contact.person.name, "Nothing was sent."));
  const cfg = sendConfig(d.env, true);
  const bad = addressProblem(contact);
  if (bad) return refuse("not_a_person", `${bad} Nothing was sent.`);
  if (await stale(shown, contact, cfg, await d.signature(o.userId), await d.senderFacts())) {
    return refuse("changed", "That card no longer matches what I'd send (the contact, your facts or the settings changed), so nothing was sent. Ask me to email them again for a fresh card.");
  }
  const boxes = await d.mailboxes(o.userId);
  if (!boxes.length) return refuse("no_mailbox", "Connect your Gmail or Outlook first: emails go only from your own account. Nothing was sent.");
  const r = await approveContactCard({ userId: o.userId, card: shown.card, yesHash: shown.card.hash, contact, now: o.now, config: cfg, store: d.store, rail: { ...d.rail, which: async () => boxes },
    limits: d.limits, suppressed: (es) => d.contacts.suppressed(es) });
  if (!r.ok) return refuse(r.why, r.reply);
  const box = PROVIDER[boxes[0].id];
  const when = r.send_at.map((s, i) => (i === 0 ? `the first at ${fmt(s)}` : `follow-up ${i} at ${fmt(s)} unless they reply`)).join(", ");
  return { reply: `Queued ${r.queued.length} email${r.queued.length > 1 ? "s" : ""} to ${shown.card.to} from your own ${box}: ${when}. Say "where are my emails" to check on them.`, intent: CONTACT_SEND_INTENT, status: "queued" };
}

// The yes to a read-back recipient: checked again, saved as the person's own contact (supplied_by 'person'), then drafted
// and put on a card exactly as "email <name>" would. A recipient read back from anything but the person's own message (a
// row whose fields do not parse as a name and an address on that address's domain) is refused.
async function confirmSupplied(o: { message: string; userId: string; now: number; deps: ContactTurnDeps }, s: Supplied, at: number, code: string | null): Promise<ContactTurnOut> {
  const d = o.deps, refuse = (status: string, reply: string): ContactTurnOut => ({ reply, intent: SUPPLY_CONFIRM_INTENT, status });
  if (!contactAskOn({ get: d.env })) return refuse("off", "Contact outreach is switched off, so nothing was saved or sent.");
  if (code) return refuse("changed", "That code isn't for this; say yes to save the contact I read back, or send it again corrected.");
  if (o.now - at > YES_WINDOW_MS || o.now < at) return refuse("expired", "That was too long ago to confirm with a text, so nothing was saved. Send me the name and address again.");
  const again = parseSupplied(`email ${s.name} at ${s.email}`);
  if (!again || again.email !== s.email || again.domain !== s.domain || again.name !== s.name) return refuse("not_a_person", "I can't read that contact back as a name and an address, so nothing was saved.");
  const bad = suppliedProblem(s);
  if (bad) return refuse("not_a_person", `${bad} Nothing was saved.`);
  const contact = await suppliedContact(s, d.mx, o.now);
  if (!contact.email.approvable) return refuse("unconfirmed", `${s.domain} has no mail server I can find, so I won't send to ${s.email}. Nothing was saved. Check the address and send it again.`);
  const id = await d.contacts.save(o.userId, { ok: true, dropped: [], runs: [], ...contact } as any);
  const out = await show(o, { name: s.name, company: null, followups: s.followups }, id);
  return out ?? refuse("gone", "I saved the contact but couldn't read it back, so there's nothing to approve yet. Ask me to email them again.");
}

async function show(o: { userId: string; now: number; deps: ContactTurnDeps }, ask: NonNullable<ReturnType<typeof contactAsk>>, savedId?: string): Promise<ContactTurnOut | null> {
  const d = o.deps;
  const ids = savedId ? [savedId] : await d.contacts.byName(o.userId, ask.name, ask.company);
  if (!ids.length) return null; // not a contact this person resolved: not this turn's
  const row = await d.contacts.get(o.userId, ids[0]);
  if (!row) return null;
  const contact = toContactIn(row);
  const card = (status: string, reply: string): ContactTurnOut => ({ reply, intent: CONTACT_CARD_INTENT, status });
  if (!contactSendOn({ get: d.env }, row.person?.supplied_by)) return card("search_off", SEARCH_OFF(contact.person.name, "There's nothing to approve."));
  const bad = addressProblem(contact);
  if (bad) return card("not_a_person", bad);
  const seen = contact.email.email ? await d.limits.sentOn(o.userId, await emailHash(contact.email.email)) : null;
  if (seen) return card("already_contacted", `You already emailed ${contact.person.name} on ${seen}, so I won't email them again.`);
  const facts = await d.senderFacts();
  const drafted = await draftContactEmail({ model: d.model, senderFacts: facts, contact });
  if (!drafted.ok) return card(`draft_${drafted.why}`, `I couldn't write an email to ${contact.person.name} that passes every check (${drafted.detail.slice(0, 3).join("; ")}), so there's nothing to approve.`);
  const fus = await draftFollowups(d.model, contact, drafted.draft, ask.followups);
  if (!fus) return card("bad_followup", "I couldn't write follow-ups that pass the rules (short, one question, no links or sales words), so there's nothing to approve.");
  const made = await contactCard({ contact, draft: drafted.draft, signature: await d.signature(o.userId), followups: fus, config: sendConfig(d.env, contactSendOn({ get: d.env }, row.person?.supplied_by)), suppressed: (es) => d.contacts.suppressed(es) });
  if (!made.ok) return card(made.why, made.reply);
  const boxes = await d.mailboxes(o.userId);
  const shown: ShownCard = { contact_id: ids[0], hook: drafted.draft.hook, card: made };
  return { reply: cardText(made, contact, boxes[0] ? PROVIDER[boxes[0].id] : null), intent: CONTACT_CARD_INTENT, status: "shown", meta: { contact_card: shown } };
}

// ------------------------------------------------------------------------------------------------ over the service role
// The thread's last reply and when it was written, unless the person has said anything since.
// deno-lint-ignore no-explicit-any
export async function lastReplyRow(admin: any, threadId: string): Promise<{ meta: Record<string, unknown> | null; at: number } | null> {
  const a = await admin.from("agent_messages").select("id,meta,created_at").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1);
  if (a.error) throw new Error(`read the thread's last reply: ${a.error.message}`);
  const row = a.data?.[0];
  if (!row) return null;
  const u = await admin.from("agent_messages").select("id").eq("thread_id", threadId).eq("role", "user").gt("id", row.id).limit(1);
  if (u.error) throw new Error(`read the thread's later turns: ${u.error.message}`);
  if (u.data?.length) return null;
  const at = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(at) ? { meta: row.meta ?? null, at } : null;
}
// The person's own unexpired contacts with this name (and company, when given), newest first.
// deno-lint-ignore no-explicit-any
export function contactsByName(admin: any, now: () => number = Date.now) {
  return async (userId: string, name: string, company?: string | null): Promise<string[]> => {
    const r = await admin.from("career_contact_profiles").select("id,name,company,created_at").eq("user_id", userId).gt("expires_at", new Date(now()).toISOString()).order("created_at", { ascending: false }).limit(100);
    if (r.error) throw new Error(`read contacts: ${r.error.message}`);
    const n = name.trim().toLowerCase(), co = company?.trim().toLowerCase() ?? null;
    return (r.data ?? []).filter((x: any) => String(x.name).trim().toLowerCase() === n && (!co || String(x.company).toLowerCase().includes(co))).map((x: any) => String(x.id));
  };
}
// The person's outreach signature (career_outreach_prefs.signature), or null.
// deno-lint-ignore no-explicit-any
export function outreachSignature(admin: any) {
  return async (userId: string): Promise<string | null> => {
    const r = await admin.from("career_outreach_prefs").select("signature").eq("user_id", userId).maybeSingle();
    if (r.error) throw new Error(`read outreach settings: ${r.error.message}`);
    return typeof r.data?.signature === "string" && r.data.signature.trim() ? r.data.signature : null;
  };
}
