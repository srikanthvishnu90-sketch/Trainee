// WO-033 parts 2-4: outreach drafted per person, approved in batches of 10 by one reply, sent one at a time from the
// person's own Gmail under caps code enforces, and every step on the account's timeline. Code decides everything that
// matters; the model only writes sentences:
//   1. Never invent (D-007). A draft may use only the person's confirmed facts, the recipient's own row (name, firm,
//      title, school) and what is actually on both sides (the same school, the same firm). The fact-lock checks every
//      name, number and month against those, every "I studied/worked at X" against the person's facts, every "you ...
//      at X" against the recipient's row, and every claim of something shared ("fellow", "we both", "like you")
//      against what both sides really share. A draft that fails is written again once with the failures named; if it
//      still fails it is not shown.
//   2. The approval binds the exact message (a SHA-256 of recipient, subject and full text). "redo 3" or "edit 3: ..."
//      makes a new message, which needs a new approval; the send recomputes the hash and refuses on any difference.
//   3. NO LIMITS (owner, 2026-10-27): Trainee sets no volume limit of its own: no daily number, no warm-up, no spacing,
//      here or in the database (career_outreach_claim). Only Gmail's own refusal (429/quota) slows sending, and the
//      person is told plainly. What stays: the exact-payload approval, its 7-day life, pause, do-not-contact forever.
//   4. No blast mode: one recipient per message, no Cc or Bcc, the person's own signature, nothing hidden.
//   5. A recipient who answers "stop" or "unsubscribe" is on the person's do-not-contact list forever (kept as a hash of
//      the address, so an erase of the career profile never re-opens them).
// Declining a batch is "send none", never "stop": over SMS, STOP is the carrier's opt-out keyword (WO-013a).
import { type EventStore, dayIn, localMidnight, recordEvent } from "./agent/timeline.ts";
import { MAX_CONTACTS, normalizeFirm, sameFirm, type ContactRow } from "./career_contacts.ts";
import { factLock } from "./essay_draft.ts";
import { CareerProfile } from "./router_core.career.js";
import { approvalWords } from "./approval_words.ts";
import { secretIn } from "./agent/reply_guards.ts";
import { redactIdentity } from "./identity_redact.ts";
import { langOf } from "./career_mail_langs.ts";
import { type PersonalMeta, type PersonalOpts, personalDraft, personalLine, type RecipientFact } from "./career_outreach_personalize.ts";

export type ModelFn = (payload: any) => Promise<any>;
export interface Recipient {
  name: string; firm: string; title: string; school: string; email: string; source: string; prior_firms?: string[]; address?: "published" | "inferred";
  // PERSONALIZED OUTREACH (2026-10-31): sourced facts about this recipient (career_outreach_personalize.ts RecipientFact:
  // each with source_kind + retrieved_at), and, on a stored draft, what made it personal (shown on the card). Both ride in
  // the draft's recipient jsonb, so no migration.
  facts?: RecipientFact[]; personal?: PersonalMeta;
}
export type Status = "shown" | "approved" | "skipped" | "sending" | "sent" | "failed" | "bounced" | "replied";
export interface OutreachDraft {
  id: string; batch_id: string; thread_id: string | null; n: number;
  recipient: Recipient; subject: string; body: string; footer: string; hash: string;
  status: Status; approved_hash: string | null; approved_at: string | null; sent_at: string | null;
  gmail_id: string | null; gmail_thread: string | null; result: string | null; created_at: string;
  shared?: Shared[];
}
// WO-091c: "expired" (approved more than APPROVAL_TTL_MS ago) and "paused" (the account is paused, opted out or erased).
export type Admit = "ok" | "not_approved" | "changed" | "expired" | "paused" | "do_not_contact";
// A "stop" to any Trainee user stops every Trainee user's drafts to that address (do-not-contact is checked across
// people, never only the sender's own). There is no count of emails per recipient (owner: the cross-person 3-in-30-days
// rule is removed); the person's own duplicate guard is the already-contacted set and the send rail's already_emailed.
export interface Prefs { daily_cap: number | null; signature: string | null; list_costs?: Record<string, unknown> }
export interface OutreachStore {
  saveBatch(userId: string, threadId: string | null, drafts: Omit<OutreachDraft, "id" | "batch_id" | "thread_id">[], at: number): Promise<OutreachDraft[]>;
  latestBatch(userId: string): Promise<OutreachDraft[]>; // the newest batch, by n
  update(userId: string, d: OutreachDraft, expect?: { status?: Status; hash?: string }): Promise<boolean>;
  contacted(userId: string): Promise<Set<string>>; // addresses already drafted, approved or sent (lowercase)
  dnc(userId: string): Promise<Set<string>>; // hashes of addresses on the do-not-contact list
  addDnc(userId: string, emailHash: string, reason: string, at: number): Promise<void>;
  prefs(userId: string): Promise<Prefs>;
  setPrefs(userId: string, p: Partial<Prefs>): Promise<void>;
  approvedDue(limit: number): Promise<{ user_id: string; draft: OutreachDraft }[]>; // oldest approval first, any person
  claim(userId: string, draft: OutreachDraft, hash: string, now: number, dayStart: number): Promise<Admit>;
  sentAwaiting(limit: number, sinceIso: string): Promise<{ user_id: string; draft: OutreachDraft }[]>;
  lastAssistantIntent(threadId: string): Promise<string | null>;
  // SERIAL-1510: approved drafts the run dropped as expired (approved more than APPROVAL_TTL_MS ago, the pace never reached
  // them) and not yet shown again: status skipped, result "expired". Re-showing marks them "expired_reshown".
  lapsed(userId: string): Promise<OutreachDraft[]>;
  // FAMILY NETWORKING (2026-10-26): every draft of the person's, newest first (who they reached out to and where each
  // stands), and their follow-up reminders (career_watch_kv 'career:outreach:followups', erased with the account).
  history?(userId: string, limit?: number): Promise<OutreachDraft[]>;
  approvedDrafts?(userId: string): Promise<OutreachDraft[]>; // every approved draft, read in pages (the send rail's check)
  // Exactly these drafts of the person's, by id (the primary key): the bounded read the reminder run and the sending rail use.
  drafts?(userId: string, ids: string[]): Promise<OutreachDraft[]>;
  followups?(userId: string): Promise<Followup[]>;
  saveFollowups?(userId: string, items: Followup[]): Promise<void>;
  allFollowups?(limit: number): Promise<{ user_id: string; items: Followup[] }[]>;
  // Scale (20261027160000): up to `batch` people with a reminder due at `now`, oldest due first, each leased for leaseMs so
  // concurrent runs claim disjoint people; saveFollowups releases the lease. `batch` sizes one call, never caps the work.
  claimDueFollowups?(now: number, batch: number, leaseMs: number): Promise<{ user_id: string; items: Followup[] }[]>;
  // The person's contacts, ONE list per account (architect ruling R1; career_account_contacts, 20261027160100), read only
  // through indexed, paged queries, never the whole list on a turn. Keys are computed by the caller (career_networking.ts
  // keyedContact). Writes carry the account's privacy epoch read at turn start and are refused (null) once it moved.
  contactsSummary?(userId: string): Promise<{ total: number; fileCount: number; files: string[] }>;
  contactsAtFirm?(userId: string, firmKey: string): Promise<ContactRow[]>;
  contactsNamed?(userId: string, nameKey: string): Promise<ContactRow[]>; // name_key = nameKey, or starts with `${nameKey} `
  contactsByEmail?(userId: string, email: string): Promise<ContactRow[]>;
  contactsInFile?(userId: string, file: string): Promise<ContactRow[]>;
  putContacts?(userId: string, epoch: number, rows: KeyedContact[], o?: { replaceFile?: string; unlessForgotten?: boolean }): Promise<number | null>;
  forgetContacts?(userId: string, epoch: number, sel: { all?: boolean; linkedin?: boolean; rowKeys?: string[] }): Promise<number | null>;
  accountEpoch?(userId: string): Promise<number>;
  // OUTREACH SCENARIOS (2026-10-30): which of these addresses no one may email: one that said "stop" to ANY Trainee user
  // (career_outreach_dnc is read by address, across everyone) or that bounced for anyone (career_send_bad_addresses).
  // dnc(userId) above is the person's own list only; drafting read only that, so someone who told another person "stop"
  // was drafted to, approved, and then refused by the rail while the person was told it was going.
  blocked?(emails: string[]): Promise<Map<string, "opted_out" | "bounced">>;
  // A batch shown again in another chat moves to that chat: only the chat that shows a batch last can approve it.
  moveBatch?(userId: string, batchId: string, threadId: string): Promise<void>;
  // PERSONALIZED OUTREACH (2026-10-31): sourced facts about the people the person writes to, by person key (career_networking.ts
  // personKey), in career_watch_kv 'career:rfacts:<person key>' (service role only; erased with the account's other keys).
  recipientFacts?(userId: string, personKeys: string[]): Promise<Map<string, RecipientFact[]>>;
  addRecipientFacts?(userId: string, personKey: string, facts: RecipientFact[]): Promise<number>;
  forgetRecipientFacts?(userId: string, personKeys: string[] | "all"): Promise<number>;
  // The one question waiting in a chat (who it is about, and the ask to run once it is answered): career_watch_kv
  // 'career:fact_ask:<thread>'. The chat state persists only the router's own keys, so it lives here.
  factAsk?(userId: string, threadId: string): Promise<Record<string, unknown> | null>;
  setFactAsk?(userId: string, threadId: string, v: Record<string, unknown> | null): Promise<void>;
}
export const RFACTS_PREFIX = "career:rfacts:", RFACTS_MAX = 20;
// New facts first, the same words kept once, at most RFACTS_MAX per person.
export const mergeFacts = (old: RecipientFact[], add: RecipientFact[]): RecipientFact[] => {
  const seen = new Set<string>(), out: RecipientFact[] = [];
  for (const f of [...add, ...old]) { const k = String(f.text ?? "").toLowerCase().replace(/\s+/g, " ").trim(); if (!k || seen.has(k)) continue; seen.add(k); out.push(f); }
  return out.slice(0, RFACTS_MAX);
};
// Every address of these that may not be emailed (lowercase -> why), the person's own list and everyone's.
export async function blockedAddresses(store: OutreachStore, userId: string, emails: string[]): Promise<Map<string, "opted_out" | "bounced">> {
  const list = [...new Set(emails.filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  const out = new Map<string, "opted_out" | "bounced">();
  if (!list.length) return out;
  const own = await store.dnc(userId);
  for (const e of list) if (own.has(await emailHash(e))) out.set(e, "opted_out");
  if (store.blocked) for (const [e, why] of await store.blocked(list)) if (!out.has(e)) out.set(e, why);
  return out;
}
export const BLOCKED_WHY = { opted_out: "they asked not to be contacted", bounced: "that address bounced before, so no one emails it again" } as const;
export interface KeyedContact { row_key: string; person_key: string; file: string; name_key: string; email: string | null; firm_key: string; firm_raw_key: string; data: ContactRow }
// One follow-up reminder: on the draft the person sent (from Trainee or themselves), due on a day, fired at most once.
export interface Followup {
  draft_id: string; name: string; firm: string; email: string; subject: string;
  sent_at: string; due_at: string; set_at: string; fired_at: string | null; asked: boolean;
}
export const FOLLOWUP_DAYS = 7, FOLLOWUP_KEY = "career:outreach:followups";
// The stored value: every reminder still waiting is kept (no volume cap); fired ones are history, the newest 200 kept.
// next_due_at: the earliest waiting due time, what the leased claim reads.
export function followupValue(items: Followup[]): { items: Followup[]; next_due_at: string | null } {
  const waiting = items.filter((f) => !f.fired_at), fired = items.filter((f) => f.fired_at).slice(-200);
  const next = waiting.map((f) => new Date(Date.parse(f.due_at)).toISOString()).sort()[0] ?? null;
  return { items: [...fired, ...waiting], next_due_at: next };
}

export const OUTREACH_INTENT = "career_outreach_batch";
export const LAPSE_NOTE = "Any not sent within 7 days of your approval lapse unsent; when you next ask I'll say how many, and you can approve them again.";
export const lapsedLine = (n: number) =>
  `${n} approved draft${n === 1 ? "" : "s"} lapsed unsent: approved more than 7 days ago, not sent by then, and that approval is no longer valid. Say "show lapsed" to see exactly ${n === 1 ? "that draft" : "those drafts"} again for a fresh approval.`;
// BATCH_MAX is a display page (how many drafts one message shows), never a cap on how many are drafted, approved or sent.
export const BATCH_MAX = 10;
export const BATCH_TTL_MS = 72 * 3600_000, MAX_WORDS = 120, MESSAGE_MAX = 1500;
// WO-091c: an approval is for a send soon after it, not whenever Gmail sending starts to work: after 7 days it is dropped.
export const APPROVAL_TTL_MS = 7 * 86400_000;
export const OPT_OUT_LINE = "If you'd rather not hear from me, reply stop and I won't write again.";
export const SIGNATURE_ASK = "How do you sign your emails? Send your name the way you want it at the bottom (and a phone or school line if you like).";

// NETWORKING R2 (2026-10-30): letters of any script are letters. Before, everything outside a-z was a word break, so
// "Amélie" read as "am lie" and "Ørsted" as "rsted": a name could be misspelled ("Hi Émilie" to Amélie) and still trace.
const plain = (s: unknown) => String(s ?? "").normalize("NFC").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
const hasWords = (hay: string, needle: string) => { const n = plain(needle); return !!n && ` ${plain(hay)} `.includes(` ${n} `); };
export async function sha256(s: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const emailHash = (email: string) => sha256(String(email ?? "").trim().toLowerCase());

// ------------------------------------------------------------------------------------------------ the message
export interface Message { to: string; subject: string; text: string }
export const messageOf = (d: Pick<OutreachDraft, "recipient" | "subject" | "body" | "footer">): Message =>
  ({ to: d.recipient.email.trim().toLowerCase(), subject: d.subject.replace(/\s+/g, " ").trim(), text: `${d.body.trim()}\n\n${d.footer.trim()}` });
export const payloadHash = (m: Message) => sha256(JSON.stringify([m.to, m.subject, m.text]));
export const footerOf = (signature: string) => `${signature.trim()}\n\n${OPT_OUT_LINE}`;

// ------------------------------------------------------------------------------------------------ facts on both sides
const META = new Set(["id", "kind", "status", "source", "needs_confirmation", "unproven", "fact_id", "created_at", "updated_at", "confirmed_at"]);
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || v == null) return out;
  if (typeof v === "string" || typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out, depth + 1));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v as any)) if (!META.has(k)) strings(x, out, depth + 1);
  return out;
}
export const factText = (f: any) => [...new Set(strings(f).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))].join("; ");
// Confirmed facts only, never a D-007 quarantined one (122's shared reader).
export const confirmed = (facts: unknown[]): any[] =>
  (Array.isArray(facts) ? facts : []).filter((f: any) => f && typeof f === "object" && !f.needs_confirmation && (!f.status || f.status === "confirmed") && !CareerProfile.quarantinedFact(f));

export interface Shared { kind: "school" | "firm"; value: string; fact: string; field: "school" | "firm" | "prior_firm" }
// A firm is named in a fact when the fact's words carry it under any of its spellings ("J.P. Morgan" is JPMorgan).
function factNamesFirm(text: string, firm: string): boolean {
  if (!plain(firm)) return false;
  if (hasWords(text, firm)) return true;
  const w = String(text).split(/[\s,;()/|]+/).filter(Boolean);
  for (let i = 0; i < w.length; i++) for (let k = 1; k <= 4 && i + k <= w.length; k++) if (sameFirm(w.slice(i, i + k).join(" "), firm)) return true;
  return false;
}
// What is on both sides: the recipient's school in one of the person's confirmed facts, or the recipient's firm (or a
// past firm on their row) in one. Each names the fact and the row field it came from.
export function sharedFacts(facts: unknown[], r: Recipient): Shared[] {
  const out: Shared[] = [];
  const cf = confirmed(facts);
  if (r.school) {
    const f = cf.find((x) => hasWords(factText(x), r.school));
    if (f) out.push({ kind: "school", value: r.school, fact: String(f.id ?? ""), field: "school" });
  }
  for (const [firm, field] of [[r.firm, "firm"], ...(r.prior_firms ?? []).map((p) => [p, "prior_firm"])] as [string, Shared["field"]][]) {
    if (!firm) continue;
    const f = cf.find((x) => x.kind !== "goal" && x.kind !== "preference" && factNamesFirm(factText(x), firm));
    if (f && !out.some((s) => s.kind === "firm" && sameFirm(s.value, firm))) out.push({ kind: "firm", value: normalizeFirm(firm), fact: String(f.id ?? ""), field });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the fact-lock
// Words that open a sentence or a greeting and so are capitalized there; never a name.
const COMMON = new Set(("i im ive id ill hi hello hey dear thanks thank best regards cheers sincerely warmly my me we our us you your youre yours " +
  "it its this that these those the a an and but or so if as at in on of to for from with about after before since while when where what which who " +
  "would could can will may might should do does did is are was were be been being have has had i'd i'm i've i'll please hope hoping " +
  "looking happy glad really also just any some no yes not one two three congrats congratulations quick brief currently recently right now today " +
  "given happy saw noticed reading read learning learned found would're wondering curious open grateful appreciate appreciated " +
  "question questions coffee chat call intro introduction advice reaching request note thoughts quick fellow great good thank").split(" "));
const GENERIC_CAPS = new Set(["I", "M&A", "IB", "ECM", "DCM", "LevFin", "PE", "VC", "MBA", "CFA", "Zoom", "LinkedIn"]);
const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;
const SHARED_CUE = /\b(we both|both of us|you and i|fellow|like you|like yourself|as you did|same (?:school|college|university|program|firm|bank|team|alma mater|class|group)|our (?:school|alma mater|college|university|time at|shared|firm)|both (?:went|studied|attended|worked|interned|graduated|at|from)|also (?:went|studied|attended|graduated|an? alum))\b/i;
// A name starts with a capital letter of any script ("École", "Ørsted", "Łódź"), or is a run of letters of a script without
// capitals (Chinese, Japanese, Korean, Arabic, Hebrew ...): NETWORKING R2 (2026-10-30), before only A-Z started a name,
// so "I worked at Ørsted" and "you studied at École" were never checked against anything.
const CAP = "(?:\\p{Lu}|\\p{Lt}|\\p{Lo})";
const ENTITY = `((?:${CAP}[\\p{L}\\p{M}\\p{N}_&.'’-]*|of|the|and|&)(?:[ \\t]+(?:${CAP}[\\p{L}\\p{M}\\p{N}_&.'’-]*|of|and|&))*)`;
const MEMBER = "(?:studied at|study at|studying at|went to|go to|graduated from|graduate of|attended|attend|attending|interned at|intern at|interning at|internship at|worked at|work at|working at|am at|'m at|’m at|alum(?:nus|na|ni)? of|student at|junior at|senior at|sophomore at|freshman at|analyst at|associate at|class at|spent the summer at|summer at)";
// Between the pronoun and the verb, no pronoun of the other side: "I saw you worked at X" is about them, not the person.
const FIRST = new RegExp(`\\b(?:I|I'm|I’m|I am|I've|I’ve|I have|I was|my)\\b(?:(?!\\byou)[^.!?\\n]){0,40}?\\b${MEMBER}\\s+(?:the\\s+)?${ENTITY}`, "gu");
const SECOND = new RegExp(`\\b(?:you|you're|you’re|you are|you've|you’ve|your)\\b(?:(?!\\b(?:I|my|me)\\b)[^.!?\\n]){0,40}?\\b(?:${MEMBER.slice(3, -1)}|at)\\s+(?:the\\s+)?${ENTITY}`, "gu");

// `topic` (F10): what the person asked to write about, in their own words this turn ("the data analyst role"). Its words
// may be named, but it is never a source for a claim about either side: "I ... at X" still needs X in the facts.
// recipientFacts (PERSONALIZED OUTREACH): the sourced facts of the recipient's brief, read as their row.
export interface LockSources { facts: string[]; recipient: Recipient; shared: Shared[]; topic?: string; lang?: DraftLang | null; recipientFacts?: string[] }
// NETWORKING R2 (2026-10-30): a draft in the language the person writes in (Spanish, French, German, Italian, Portuguese,
// Dutch: the languages Trainee reads mail in, career_mail_langs.ts). Before, the writer was never told the language and
// the lock knew only English: every honest draft in another language was refused ("Hola", "Ich", "Sie", "15 minutos" read
// as claims), and a claim in that language ("Trabajé en Acme" when only the recipient works at Acme) was not checked.
// Per language: the words that open a sentence or a greeting, German's capitalized everyday nouns, the word for minutes,
// the words that claim something in common, and who a claim is about (I studied/worked at X; you studied/work at X).
export type DraftLang = "es" | "fr" | "de" | "it" | "pt" | "nl";
export const LANG_NAME: Record<DraftLang, string> = { es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch" };
// The language the person writes in, from their own message (career_mail_langs.ts langOf), or null for English.
export function draftLangOf(message: unknown): DraftLang | null {
  const l = langOf(String(message ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim());
  return l && l in LANG_NAME ? (l as DraftLang) : null;
}
const words = (x: string) => new Set(x.split(/\s+/).filter(Boolean));
const LANG_COMMON: Record<DraftLang, Set<string>> = {
  es: words("hola estimado estimada estimados querido querida buenos buenas buen gracias muchas saludos un una unos unas el la los las lo me mi mis soy estoy estudio estudié trabajo trabajé quería quisiera querría escribo le te su sus tu usted ustedes nos nuestro y o pero si en de del con por para que qué cómo como tendría tendrías podría podrías sería sé vi he es son espero cordialmente atentamente un ya hoy esta este ese esa también gracias aunque cuando donde sobre ante ambos ambas nosotros nosotras vi que estudiamos trabajamos fuimos"),
  fr: words("bonjour bonsoir salut madame monsieur cher chère chers merci bien cordialement je j je suis j'ai jai me mon ma mes vous votre vos tu ton ta nous notre et ou mais si en de du des le la les un une au aux pour par avec sur que qui quoi comment comme auriez pourriez seriez serait aurait est sont ai serais aimerais souhaiterais écris vois espère aussi actuellement également ce cette ces étudie travaille étudié travaillé fait avez auriez-vous pourriez-vous seriez-vous"),
  de: words("hallo guten liebe lieber sehr geehrte geehrter grüß gruß grüße viele beste freundlichen ich mich mir mein meine meinen meinem wir uns unser sie ihnen ihr ihre ihrem ihren ihrer du dich dir dein deine und oder aber wenn in im an am bei von vom zu zum zur mit für auf über als wie dass ob hätten hätte könnten könnte würden würde wäre bin ist sind habe haben schreibe danke vielen herzlichen gerne auch derzeit aktuell gerade diese dieser dieses der die das ein eine einen einem beide studiere arbeite studiert gearbeitet"),
  it: words("ciao buongiorno buonasera gentile gentilissimo gentilissima caro cara grazie mille cordiali saluti io mi mio mia miei sono studio lavoro ho le la lo gli il i un una uno suo sua lei voi vostro noi nostro e o ma se in di del della con per su che come avrebbe potrebbe sarebbe vorrei scrivo spero anche attualmente questo questa entrambi avrei avreste potreste"),
  pt: words("olá ola oi prezado prezada caro cara bom boa dia tarde obrigado obrigada muito atenciosamente cumprimentos eu me meu minha sou estou estudo trabalho tenho o a os as um uma seu sua você vocês senhor senhora nós nosso e ou mas se em de do da no na com por para que como teria poderia seria gostaria escrevo espero também atualmente este esta ambos teríamos"),
  nl: words("hallo hoi beste geachte goedemorgen goedemiddag dag dank bedankt groeten vriendelijke met ik mij me mijn ben heb studeer werk u uw jij je jouw wij we ons onze en of maar als in op aan bij van voor met over dat hoe zou zoudt kunt kun zijn is schrijf hoop ook momenteel deze dit de het een heeft hebt kunt wilt mag zoudt allebei"),
};
// German capitalizes every noun: the everyday ones an outreach note uses are not names.
const DE_NOUNS = words("sie ihnen ihr ihre ihrem ihren ihrer herr frau minuten minute zeit gespräch gespräche telefonat anruf call kaffee frage fragen rat tipps tipp erfahrung erfahrungen einblick einblicke austausch woche wochen tag tage monat nachricht e-mail email team rolle stelle position bereich branche karriere weg einstieg berufseinstieg praktikum studium interesse dank grüße grüßen gruß unternehmen firma arbeit aufgaben alltag möglichkeit möglichkeiten perspektive perspektiven meinung hilfe zukunft ziel ziele bewerbung lebenslauf abschluss semester");
const MINUTES = String.raw`(?:min|mins|minutes?|minutos?|minuti|minuten|minuut|minuto)`;
const LANG_SHARED: Record<DraftLang, RegExp> = {
  es: /\b(?:ambos|ambas|los dos|las dos|igual que (?:tú|usted)|como (?:tú|usted)|también (?:estudi|fui|trabaj|me gradu)|compañer[oa]s? de|nuestra (?:universidad|escuela|alma mater|empresa))/iu,
  fr: /(?:tous les deux|toutes les deux|nous deux|comme vous|comme toi|vous aussi|notre (?:école|université|alma mater|entreprise)|moi aussi|également (?:étudié|été|travaillé))/iu,
  de: /(?:wir beide|beide|wie sie|wie du|ebenfalls|sie auch|ich auch|unsere(?:r|n)? (?:uni|universität|hochschule|firma))/iu,
  it: /(?:entrambi|entrambe|tutti e due|come lei|come te|anch'io|anche io|nostra (?:università|scuola|azienda))/iu,
  pt: /(?:ambos|ambas|nós dois|como você|como o senhor|como a senhora|também (?:estud|trabalh|fui)|nossa (?:universidade|escola|empresa))/iu,
  nl: /(?:allebei|wij beiden|we beiden|net als u|net als jij|ook (?:gestudeerd|gewerkt)|onze (?:universiteit|school|hogeschool))/iu,
};
// First person: "Estudié en X", "J'ai travaillé chez X", "Ich habe an der X studiert" (the place before the verb in German
// and Dutch, read by its preposition), "Ho lavorato presso X", "Estudei na X", "Ik heb bij X gewerkt".
const LANG_FIRST: Record<DraftLang, string> = {
  es: String.raw`(?:estudi[ée]|estudio|estoy estudiando|trabaj[ée]|trabajo|hice (?:unas |mis )?pr[áa]cticas|me gradu[ée]|soy (?:estudiante|egresad[oa]|alumn[oa]))\s+(?:en|de|a|para)\s+(?:la |el |los |las )?`,
  fr: String.raw`(?:j'ai (?:étudié|travaillé|fait (?:un |mon )?stage)|j’ai (?:étudié|travaillé|fait (?:un |mon )?stage)|j'étudie|j’étudie|je travaille|je suis (?:étudiante?|diplômée?|stagiaire))\s+(?:à|chez|en|au|aux|de|à la|pour)\s+(?:la |le |l'|les )?`,
  de: String.raw`(?:[Ii]ch (?:habe|hab|bin|studiere|arbeite|arbeitete|studierte)\b[^.!?\n]{0,30}?)\b(?:an der|an dem|am|bei|in der|auf der|an)\s+(?:der |dem |den )?`,
  it: String.raw`(?:ho (?:studiato|lavorato|fatto (?:uno |il mio )?stage)|studio|lavoro|sono (?:studente|studentessa|laureat[oa]))\s+(?:presso|a|in|da|alla|al|all'|per)\s+(?:la |il |lo |l')?`,
  pt: String.raw`(?:estudei|estudo|trabalhei|trabalho|fiz (?:um |meu )?est[áa]gio|me formei|sou (?:estudante|formad[oa]|alun[oa]))\s+(?:na|no|em|de|da|do|para)\s+(?:a |o )?`,
  nl: String.raw`(?:ik (?:heb|ben|studeer|werk|werkte|studeerde)\b[^.!?\n]{0,30}?)\b(?:bij|aan de|aan het|op de|in|aan)\s+(?:de |het )?`,
};
const LANG_SECOND: Record<DraftLang, string> = {
  es: String.raw`(?:usted|tú|vos)?\s*(?:estudió|estudiaste|trabajó|trabajaste|trabaja|trabajas|est[áa]s? en)\s+(?:en|de|a|para)?\s*(?:la |el )?`,
  fr: String.raw`(?:vous (?:avez (?:étudié|travaillé)|travaillez|étudiez|êtes)|tu (?:as (?:étudié|travaillé)|travailles))\s+(?:à|chez|en|au|aux|de|pour)\s+(?:la |le |l'|les )?`,
  de: String.raw`(?:[Ss]ie|[Dd]u)\s+(?:haben|hast|sind|bist|arbeiten|arbeitest|studierten|studiert(?:en)?)\b[^.!?\n]{0,30}?\b(?:an der|an dem|am|bei|in der|an)\s+(?:der |dem |den )?`,
  it: String.raw`(?:lei|tu)?\s*(?:ha (?:studiato|lavorato)|hai (?:studiato|lavorato)|lavora|lavori)\s+(?:presso|a|in|da|alla|al|per)\s+(?:la |il |lo |l')?`,
  pt: String.raw`(?:você|o senhor|a senhora)?\s*(?:estudou|trabalhou|trabalha)\s+(?:na|no|em|de|da|do|para)\s+(?:a |o )?`,
  nl: String.raw`(?:u|jij|je)\s+(?:hebt|heeft|bent|werkt|studeert|werkte|studeerde)\b[^.!?\n]{0,30}?\b(?:bij|aan de|aan het|op de|in|aan)\s+(?:de |het )?`,
};
// Case-sensitive (a name must start with a capital); a sentence is read with its first letter lowered, so "Estudié en X"
// and "estudié en X" read the same.
const langRx = (lang: DraftLang, side: "first" | "second") => new RegExp(`(?<![\\p{L}])${(side === "first" ? LANG_FIRST : LANG_SECOND)[lang]}${ENTITY}`, "gu");
export interface Lock { pass: boolean; untraced: string[]; misattributed: string[] }
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const trimEntity = (e: string) => e.replace(/^(?:the|of|and|&)\s+/i, "").replace(/\s+(?:of|the|and|&)$/i, "").replace(/['’]s$/, "").replace(/[.]+$/, "").trim();

// OUTREACH R3 (D-007): titles written in lower case, events in someone's career, and what they lead or run.
const RECIPIENT_TITLE = /(?<![\p{L}-])(partner|principal|founder|co-?founder|owner|chair(?:man|woman|person)?|president|recruiter|professor|dean)s?(?![\p{L}-])/giu;
const RECIPIENT_EVENT = /\b(?:congrat\w*|congratulations)\s+on\s+(?:your|the)\s+(?:new\s+|recent\s+)?(promotion|appointment|new role|role|position|move|raise|funding round|award|book|launch)\b|\byour\s+(?:recent\s+)?(promotion|appointment|new role|new position|move to|move from)\b|\byou\s+(?:were|got|just got|recently got)\s+(promoted|appointed|hired)\b/giu;
const RECIPIENT_DOES = /\byou(?:'re| are)?\s+(?:now\s+)?(lead|leading|run|running|manage|managing|head|heading|oversee|overseeing|built|founded|co-?founded|started)\s+([^.,;!?\n]{1,60})/giu;
const DOES_FILLER = new Set(["team", "group", "desk", "teams", "groups", "there", "firm", "company", "office", "work", "now", "currently", "whole", "entire"]);
export function outreachLock(text: string, s: LockSources): Lock {
  const r = s.recipient;
  const personCorpus = s.facts.join(" \n ");
  const rowCorpus = [r.name, r.firm, r.title, r.school, ...(r.prior_firms ?? []), ...(s.recipientFacts ?? [])].join(" \n ");
  const sharedCorpus = s.shared.map((x) => x.value).join(" \n ");
  const all = [personCorpus, rowCorpus, sharedCorpus, s.topic ?? ""].join(" \n ");
  const inAny = (e: string) => hasWords(all, e) || sameFirmIn(all, e);
  const untraced: string[] = [], misattributed: string[] = [];
  const miss = (v: string) => { if (!untraced.some((u) => plain(u) === plain(v))) untraced.push(v); };
  const wrong = (v: string) => { if (!misattributed.includes(v)) misattributed.push(v); };
  // A word of the draft's language that is no claim: every part of it ("Auriez-vous", "J'étudie") is a common word.
  const langWord = (w: string) => {
    if (!s.lang) return false;
    const parts = w.toLowerCase().split(/[-'’\s]+/).filter((x) => x.length > 1);
    return parts.length > 0 && parts.every((x) => COMMON.has(x) || LANG_COMMON[s.lang!].has(x) || (s.lang === "de" && DE_NOUNS.has(x)));
  };
  // 1. Every capitalized name, number and month traces to a source. A number of minutes is a request, not a claim.
  for (const sent of sentencesOf(text)) {
    const toks = [...sent.matchAll(/(?<![\p{L}\p{M}\p{N}_&.'’-])([\p{Lu}\p{Lt}][\p{L}\p{M}&.'’-]*[\p{L}\p{M}]|[\p{Lu}\p{Lt}]|\p{Lo}[\p{Lo}\p{M}]*)(?![\p{L}\p{M}\p{N}_&'’-])/gu)];
    for (const [i, m] of toks.entries()) {
      const w = m[1].replace(/['’]s$/, "");
      if (GENERIC_CAPS.has(w) || /^I['’](?:m|ve|d|ll)$/.test(w)) continue;
      const atStart = i === 0 && /^[\s"'“(¿¡«]*$/.test(sent.slice(0, m.index));
      const lw = w.toLowerCase().replace(/['’]/g, "");
      if (atStart && (COMMON.has(lw) || langWord(w))) continue;
      if (s.lang === "de" && (DE_NOUNS.has(lw) || LANG_COMMON.de.has(lw))) continue;
      if (!inAny(w)) miss(w);
    }
  }
  const nums = new Set([...all.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
  for (const m of text.matchAll(/\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|k|m|bn|b)\b)?/gi)) {
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    if (new RegExp(`^\\s*(?:-|to|a|à|bis|-)?\\s*\\d*\\s*${MINUTES}`, "i").test(after)) continue;
    if (!nums.has(m[0].replace(/[$,%a-z\s]/gi, ""))) miss(m[0].trim());
  }
  for (const m of text.matchAll(MONTH)) {
    if (m[1] === "May" && /(^|[.!?]\s+)$/.test(text.slice(0, m.index))) continue;
    if (!hasWords(all, m[1])) miss(m[1]);
  }
  // WO-030's fact-lock (essay_draft.ts) on top: titles, degrees, tools, scale words and units must trace too ("a junior"
  // is a claim when the facts say "Class of 2027"). A number of minutes is a request, and an opening word is no claim.
  const asked = text.replace(new RegExp(String.raw`\b\d{1,2}(?:\s*(?:-|to|a|à|bis)\s*\d{1,2})?\s*${MINUTES}\b`, "giu"), "a few minutes");
  for (const u of factLock(asked, [all]).untraced) {
    const w = u.replace(/['’]s$/, "");
    const lw = w.toLowerCase().replace(/['’]/g, "");
    if (GENERIC_CAPS.has(w) || COMMON.has(lw) || inAny(w)) continue;
    if (s.lang) {
      // The essay lock reads A-Z only: a word with an accent comes back cut ("Trabaj" of "Trabajé", "Gespr" of "Gespräch");
      // the whole word is checked above. A greeting with a name ("Hola Ana") is common words and a traced name.
      if (new RegExp(`${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\p{L}\\p{M}]`, "u").test(text)) continue;
      if (u.split(/\s+/).every((p) => langWord(p) || inAny(p))) continue;
    }
    miss(u);
  }
  // 2. Who a claim is about. "I ... at X" is about the person: X must be in their confirmed facts. Read sentence by sentence
  // (NETWORKING SCENARIOS, 2026-10-29): a name ending a sentence ("I studied at DePaul University. Would you ...") ran
  // into the next one's first word, so a fact on record was refused as "DePaul University. Would".
  const bySentence = (rx: RegExp) => sentencesOf(text).flatMap((x) => [...x.matchAll(rx)]);
  for (const m of bySentence(FIRST)) {
    const e = trimEntity(m[1]);
    if (e && !GENERIC_CAPS.has(e) && !(hasWords(personCorpus, e) || sameFirmIn(personCorpus, e))) wrong(`"${m[0].trim()}" says this about you, but ${e} is not in your confirmed facts`);
  }
  // "you ... at X" is about the recipient: X must be on their row.
  for (const m of bySentence(SECOND)) {
    const e = trimEntity(m[1]);
    if (e && !GENERIC_CAPS.has(e) && !(hasWords(rowCorpus, e) || sameFirmIn(rowCorpus, e))) wrong(`"${m[0].trim()}" says this about them, but ${e} is not on their row`);
  }
  if (s.lang) {
    const bySentenceLow = (rx: RegExp) => sentencesOf(text).map((x) => x.replace(/^([¿¡«"'“(\s]*)(\p{L})/u, (_a, p, c) => p + c.toLowerCase())).flatMap((x) => [...x.matchAll(rx)]);
    for (const m of bySentenceLow(langRx(s.lang, "first"))) {
      const e = trimEntity(m[m.length - 1] ?? "");
      if (e && !GENERIC_CAPS.has(e) && !(hasWords(personCorpus, e) || sameFirmIn(personCorpus, e))) wrong(`"${m[0].trim()}" says this about you, but ${e} is not in your confirmed facts`);
    }
    for (const m of bySentenceLow(langRx(s.lang, "second"))) {
      const e = trimEntity(m[m.length - 1] ?? "");
      if (e && !GENERIC_CAPS.has(e) && !(hasWords(rowCorpus, e) || sameFirmIn(rowCorpus, e))) wrong(`"${m[0].trim()}" says this about them, but ${e} is not on their row`);
    }
  }
  // OUTREACH R3 (2026-10-31, D-007): what the email says about the recipient that no capital letter gives away. "Congrats
  // on your promotion to partner", "You lead the healthcare coverage group" passed: a title in lower case, an event and a
  // team are claims, and none of them was on the row. A title word must be on the row (or in the person's facts); a
  // promotion, appointment, new role or recent move must be in what the draft was given; "you lead / run / manage / built
  // X" must name only what is on their row.
  const lowText = text.replace(/[’]/g, "'");
  for (const m of lowText.matchAll(RECIPIENT_TITLE)) {
    if (/^\p{Lu}/u.test(m[0])) continue; // capitalized: a name ("Blue Harbor Partners"), traced in 1 above
    const w = m[1].toLowerCase();
    if (!hasWords(rowCorpus, w) && !hasWords(personCorpus, w) && !hasWords(s.topic ?? "", w)) wrong(`"${m[0].trim()}" gives them a title (${w}) that is not on their row`);
  }
  for (const m of lowText.matchAll(RECIPIENT_EVENT)) {
    const w = String(m[1] ?? m[2] ?? m[3]).toLowerCase().replace(/\s+/g, " ");
    if (!hasWords(all, w)) wrong(`"${m[0].trim()}" says something happened to them (${w}) that nothing on record says`);
  }
  for (const sent of sentencesOf(lowText)) for (const m of sent.matchAll(RECIPIENT_DOES)) {
    const words = plain(m[2]).split(" ").filter((x) => x.length > 2 && !COMMON.has(x) && !DOES_FILLER.has(x));
    const off = words.filter((x) => !hasWords(rowCorpus, x) && !hasWords(s.topic ?? "", x));
    if (off.length) wrong(`"${m[0].trim()}" says what they do (${off.join(", ")}), but that is not on their row`);
  }
  // 3. Anything claimed in common must be on both sides: every name in the clause that says so.
  for (const sent of sentencesOf(text).flatMap((x) => x.split(/[,;:]\s+|\s+(?:but|while|and so)\s+/))) {
    if (!SHARED_CUE.test(sent) && !(s.lang && LANG_SHARED[s.lang].test(sent))) continue;
    const names = [...sent.matchAll(/(?<![\p{L}\p{M}\p{N}_&.'’-])((?:[\p{Lu}\p{Lt}][\p{L}\p{M}&.'’-]*[\p{L}\p{M}]|\p{Lo}[\p{Lo}\p{M}]*)(?:[ \t]+(?:of[ \t]+)?(?:[\p{Lu}\p{Lt}][\p{L}\p{M}&.'’-]*[\p{L}\p{M}]|\p{Lo}[\p{Lo}\p{M}]*))*)/gu)]
      .map((m) => trimEntity(m[1])).map((e) => (s.lang ? e.split(/\s+/).filter((p) => !langWord(p)).join(" ") : e)).filter((e) => e && !GENERIC_CAPS.has(e) && !COMMON.has(e.toLowerCase()) && plain(e) !== plain(r.name) && !plain(r.name).split(" ").includes(plain(e)));
    const bad = names.filter((e) => !s.shared.some((x) => hasWords(x.value, e) || hasWords(e, x.value) || sameFirm(x.value, e)));
    if (bad.length) wrong(`"${sent}" claims ${bad.join(", ")} in common, but that is not on both sides`);
    else if (!names.length && !s.shared.length) wrong(`"${sent}" claims something in common, but nothing on record is on both sides`);
  }
  // 4. NETWORKING R2 (2026-10-30): never a secret in an email, wherever the words came from (a fact, a contact's row, a
  // page): an API key or token, a password or one-time code, a card, account or Social Security number. Before, a key or
  // an SSN that sat in a confirmed fact or a row field traced like any other word and could be written into the email.
  const red = redactIdentity(text);
  if (secretIn(text) || red.removed.length) wrong(`it carries a secret (${[...new Set(red.removed.length ? red.removed : ["key"])].join(", ")}); an email never does`);
  return { pass: !untraced.length && !misattributed.length, untraced, misattributed };
}
function sameFirmIn(corpus: string, e: string): boolean {
  if (!/[A-Za-z]/.test(e)) return false;
  const f = normalizeFirm(e);
  return f !== e.trim() && hasWords(corpus, f);
}

// ------------------------------------------------------------------------------------------------ drafting
const SYSTEM = [
  "You write one short cold email from a job seeker to one professional, in the seeker's plain first-person voice.",
  "Rules that do not bend:",
  "1. Use ONLY what is listed: the seeker's confirmed facts, the recipient's row, and the things listed as shared. Every school, firm, title, number, month and name you write must appear there. Never say or imply anything is shared unless it is listed under SHARED. If something would help but is not listed, leave it out.",
  `2. At most ${MAX_WORDS} words in the body. One clear, small ask (a short call or a question). No attachments, no links.`,
  "3. Output exactly: a first line 'Subject: <subject>', a blank line, then the body starting with a greeting. No sign-off and no name at the end: the seeker's own signature is added after it.",
  "4. Never mention AI, Upmore or Trainee. No stock phrases (\"I hope this email finds you well\", \"pick your brain\", \"I came across your profile\").",
].join("\n");
export function draftPayload(o: { facts: any[]; r: Recipient; shared: Shared[]; previous?: string | null; fix?: string[]; topic?: string | null; lang?: DraftLang | null }) {
  const lines = [
    o.lang ? `Write the subject and the body in ${LANG_NAME[o.lang]}: the seeker writes in ${LANG_NAME[o.lang]}. Every name stays exactly as written below.` : "",
    "THE SEEKER'S CONFIRMED FACTS (the only things you may say about them):",
    ...(o.facts.length ? o.facts.map((f) => `- [${[f.id, f.kind].filter(Boolean).join(", ")}] ${factText(f)}`) : ["- (none)"]),
    "THE RECIPIENT'S ROW (the only things you may say about them):",
    `- name: ${o.r.name}`, `- firm: ${o.r.firm || "(not given)"}`, `- title: ${o.r.title || "(not given)"}`, `- school: ${o.r.school || "(not given)"}`,
    "SHARED (on both sides; the only things you may call shared):",
    ...(o.shared.length ? o.shared.map((x) => `- same ${x.kind}: ${x.value}`) : ["- nothing"]),
    o.topic ? `WHAT THE SEEKER WANTS TO ASK ABOUT (their own words; the ask, never a fact about either side):\n- ${o.topic}` : "",
    o.previous ? `\nWrite a different version from this earlier one:\n${o.previous}` : "",
    o.fix?.length ? `\nYour last version broke these rules. Write it again without breaking them:\n${o.fix.map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean);
  return { system: SYSTEM, messages: [{ role: "user", content: lines.join("\n") }], max_tokens: 700 };
}
function parseDraft(msg: any): { subject: string; body: string; cut: boolean } {
  const text = (Array.isArray(msg?.content) ? msg.content : []).filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("").trim();
  const m = /^\s*subject:\s*(.+)\n+([\s\S]+)$/i.exec(text);
  const subject = (m ? m[1] : "").replace(/\s+/g, " ").trim().slice(0, 150);
  const body = (m ? m[2] : text).trim();
  return { subject, body, cut: msg?.stop_reason === "max_tokens" || !/[.!?)"”]$/.test(body) };
}
export type Drafted = { ok: true; subject: string; body: string; shared: Shared[]; tries: number; personal?: PersonalMeta } | { ok: false; why: string; detail: string[]; tries: number };
// PERSONALIZED OUTREACH (2026-10-31): every new outreach draft is written by the personalization engine: the field's
// playbook, the overlap, one sized ask, and the quality gate that rejects a generic draft (career_outreach_personalize.ts).
// With nothing sourced about the recipient beyond a title and firm it answers why "unsourced" and the caller asks the
// person one question instead of writing an email that would fit anyone. personal: false is only for a message that is
// not a first email to someone: a follow-up on a thread already sent.
export async function draftFor(o: { model: ModelFn; facts: unknown[]; r: Recipient; previous?: string | null; topic?: string | null; lang?: DraftLang | null; personal?: PersonalOpts | false }): Promise<Drafted> {
  if (o.personal !== false) {
    const { facts: _f, personal: _p, ...r } = o.r;
    return personalDraft({ model: o.model, facts: o.facts, r: r as Recipient, previous: o.previous, topic: o.topic, lang: o.lang, recipientFacts: o.r.facts, ...(o.personal || {}) });
  }
  const facts = confirmed(o.facts);
  if (!facts.length) return { ok: false, why: "thin", detail: ["no confirmed facts to write from"], tries: 0 };
  const shared = sharedFacts(facts, o.r);
  const topic = o.topic ? String(o.topic).replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const lang = o.lang && LANG_NAME[o.lang] ? o.lang : null;
  const sources: LockSources = { facts: facts.map(factText), recipient: o.r, shared, ...(topic ? { topic } : {}), ...(lang ? { lang } : {}) };
  let fix: string[] = [], last: string[] = [];
  for (let tries = 1; tries <= 2; tries++) {
    let msg: any;
    try { msg = await o.model(draftPayload({ facts, r: o.r, shared, previous: o.previous, fix, topic: topic || null, lang })); }
    catch (e) { return { ok: false, why: "model", detail: [e instanceof Error ? e.message : String(e)], tries }; }
    const d = parseDraft(msg);
    if (!d.subject || !d.body) { last = ["it did not write a subject and a body"]; fix = ["Write 'Subject: ...', a blank line, then the body."]; continue; }
    const lock = outreachLock(`${d.subject}\n${d.body}`, sources);
    const words = d.body.split(/\s+/).filter(Boolean).length;
    if (lock.pass && words <= MAX_WORDS && !d.cut) return { ok: true, subject: d.subject, body: d.body, shared, tries };
    last = [...lock.untraced.map((u) => `not on record: ${u}`), ...lock.misattributed, ...(words > MAX_WORDS ? [`${words} words, over ${MAX_WORDS}`] : []), ...(d.cut ? ["it stopped mid-sentence"] : [])];
    fix = [
      ...(lock.untraced.length ? [`It named things that are not listed: ${lock.untraced.join("; ")}. Leave them out entirely.`] : []),
      ...lock.misattributed.map((x) => `${x}. Leave that claim out.`),
      ...(words > MAX_WORDS ? [`It was ${words} words; stay under ${MAX_WORDS}.`] : []),
      ...(d.cut ? ["It stopped in the middle of a sentence."] : []),
    ];
  }
  return { ok: false, why: "unverified", detail: last, tries: 2 };
}

// ------------------------------------------------------------------------------------------------ the batch, shown
const who = (r: Recipient) => [r.name, r.title, r.firm].filter(Boolean).join(", ");
export function draftText(d: OutreachDraft): string {
  const common = (d.shared ?? []).length ? `In common: ${(d.shared ?? []).map((s) => `${s.value} (your ${s.fact || "fact"}; their ${s.field.replace("_", " ")})`).join("; ")}\n` : "";
  const m = messageOf(d);
  // An address web discovery found is labeled on the card (owner rule, 2026-10-27: "the card labels each address").
  const label = d.recipient.address === "inferred" ? " (inferred address: guessed from the company's email format, never published; it may bounce)"
    : d.recipient.address === "published" ? " (published address)" : "";
  const personal = d.recipient.personal ? `${personalLine(d.recipient.personal)}\n` : "";
  return `${d.n}. To: ${who(d.recipient)} <${m.to}>${label}\nFrom your list: ${d.recipient.source}\n${common}${personal}Subject: ${m.subject}\n\n${m.text}`;
}
export const BATCH_FOOT = `Reply "send all", "send 1-7,9" for some, "redo 3" for a new version, "skip 4" to drop one, "edit 3: your words" to change one, or "send none".`;
// The batch, split on purpose into messages of at most 1,500 characters; a draft is never cut across two.
export function batchMessages(drafts: OutreachDraft[]): string[] {
  const live = drafts.filter((d) => d.status === "shown" || d.status === "approved");
  if (!live.length) return ["No drafts are waiting in this batch."];
  const head = `${live.length} outreach draft${live.length === 1 ? "" : "s"}, each written only from your confirmed facts and what's on record about that person. Nothing is sent until you approve it, and each goes exactly as shown.`;
  const out: string[] = [];
  let cur = head;
  for (const d of live) {
    const t = draftText(d) + (d.status === "approved" ? "\n(approved)" : "");
    if (cur && cur.length + 2 + t.length > MESSAGE_MAX) { out.push(cur); cur = t; } else cur = cur ? `${cur}\n\n${t}` : t;
  }
  if (cur.length + 2 + BATCH_FOOT.length > MESSAGE_MAX) { out.push(cur); cur = BATCH_FOOT; } else cur = `${cur}\n\n${BATCH_FOOT}`;
  out.push(cur);
  return out;
}
export const batchText = (drafts: OutreachDraft[]) => batchMessages(drafts).join("\n\n");

// ------------------------------------------------------------------------------------------------ the reply
export type OutreachReply =
  | { kind: "send"; all: boolean; ns: number[]; except: number[]; it?: boolean }
  | { kind: "skip"; ns: number[]; anytime?: boolean } | { kind: "redo"; n: number } | { kind: "edit"; n: number; text: string }
  | { kind: "none" } | { kind: "show" } | { kind: "lapsed" } | { kind: "bad"; why: string };
// FAMILY NETWORKING: "send it" / "looks good, send it" names the one draft shown (only when exactly one is waiting), and
// "cancel 1" / "don't send 1" / "unapprove 1" takes back a draft, approved or not, at any time before it is sent.
const SEND_IT = /^(?:(?:yes|yep|yeah|ok|okay|looks good|look good|sounds good|perfect|great|nice|cool|lgtm)[,!. ]+)?(?:please )?(?:send|approve)(?: it| this| that| this one| that one| the email| the draft)(?: now| please| for me)?$/;
const CANCEL = /^(?:wait,? |actually,? |hold on,? )?(?:cancel|unapprove|don'?t send|do not send|dont send|hold|take back)(?: (?:draft|email|number))? #?(\d{1,2}(?:\s*(?:,|and|-)\s*\d{1,2})*)(?: (?:yet|for now|please))?$/;
const MAX_N = 99;
// "1-7,9", "1-7, 9", "1 2 3", "2 and 5": numbers and ranges only, nothing else. null when it is not such a list.
export function parseNumbers(s: string): { ok: true; ns: number[] } | { ok: false; why: string } | null {
  const t = s.replace(/\s*(?:,|\band\b|&)\s*/g, ",").replace(/\s*-\s*/g, "-").replace(/\s+/g, ",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!t || !/^(?:#?\d+(?:-\d+)?)(?:,#?\d+(?:-\d+)?)*$/.test(t)) return null;
  const ns: number[] = [];
  for (const part of t.split(",")) {
    const [a, b] = part.replace("#", "").split("-").map(Number);
    if (!(a >= 1) || (b !== undefined && !(b >= 1))) return { ok: false, why: "drafts are numbered from 1" };
    if (a > MAX_N || (b ?? a) > MAX_N) return { ok: false, why: `there is no draft ${Math.max(a, b ?? a)}` };
    if (b !== undefined && b < a) return { ok: false, why: `"${a}-${b}" runs backwards; say ${b}-${a}` };
    for (let n = a; n <= (b ?? a); n++) if (!ns.includes(n)) ns.push(n);
  }
  return { ok: true, ns: ns.sort((x, y) => x - y) };
}
export function parseOutreachReply(text: string): OutreachReply | null {
  const raw = String(text ?? "").trim();
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 2000) return null;
  const edit = /^(?:edit|change)\s+#?(\d{1,2})\s*[:\-]\s*([\s\S]+)$/i.exec(raw);
  if (edit) return { kind: "edit", n: Number(edit[1]), text: edit[2].trim() };
  if (t.length > 80) return null;
  if (/^(?:show|see|list)(?: me)?(?: (?:my|the))? (?:outreach )?(?:drafts|emails|outreach)$/.test(t)) return { kind: "show" };
  // SERIAL-1510: the drafts whose approval lapsed, shown again for a fresh approval.
  if (/^(?:show|see|list|re-?show)(?: me)?(?: (?:my|the))? (?:lapsed|unsent|expired)(?: outreach)?(?: drafts| emails)?(?: again)?$/.test(t) || /^show lapsed$/.test(t)) return { kind: "lapsed" };
  if (/^(?:send none|none|don'?t send(?: any(?: of them)?)?|send nothing|cancel(?: all| them| the batch)?|skip all|no thanks)$/.test(t)) return { kind: "none" };
  if (SEND_IT.test(t)) return { kind: "send", all: false, ns: [], except: [], it: true };
  const cancel = CANCEL.exec(t);
  if (cancel) {
    const nums = parseNumbers(cancel[1]);
    if (nums?.ok) return { kind: "skip", ns: nums.ns, anytime: true };
  }
  const all = /^(?:send|approve)(?: them)? all(?: of them| \d+)?(?: (?:except|but|minus|without|not)\b(.*))?$/.exec(t) ?? /^send (?:them|everything)(?: (?:except|but|minus|without|not)\b(.*))?$/.exec(t);
  if (all) {
    if (all[1] === undefined) return { kind: "send", all: true, ns: [], except: [] };
    const nums = parseNumbers(all[1].replace(/\b(?:numbers?|for)\b/g, " ").trim());
    if (!nums) return { kind: "bad", why: `say which to leave out by number, e.g. "send all except 3"` };
    if (!nums.ok) return { kind: "bad", why: nums.why };
    return { kind: "send", all: true, ns: [], except: nums.ns };
  }
  const some = /^(?:send|approve)(?: numbers?| only| just)? (.+)$/.exec(t);
  if (some) {
    const nums = parseNumbers(some[1]);
    if (!nums) return { kind: "bad", why: `say which by number, e.g. "send 1-7,9", or "send all"` };
    if (!nums.ok) return { kind: "bad", why: nums.why };
    return { kind: "send", all: false, ns: nums.ns, except: [] };
  }
  const redo = /^(?:redo|rewrite|redraft|retry)(?: number| draft)? #?(\d{1,2})$/.exec(t);
  if (redo) return { kind: "redo", n: Number(redo[1]) };
  const skip = /^(?:skip|drop|remove)(?: numbers?| drafts?)? (.+)$/.exec(t);
  if (skip) {
    const nums = parseNumbers(skip[1]);
    if (!nums) return t.startsWith("skip all") ? { kind: "none" } : null;
    if (!nums.ok) return { kind: "bad", why: nums.why };
    return { kind: "skip", ns: nums.ns };
  }
  return null;
}

// D-MN-2 (owner, 2026-10-27 19:48 CDT): a yes to the batch shown approves exactly that batch, each draft bound to its own
// hash; "yes except 3" / "only 1-10" approve what is stated; a hedged answer ("maybe", "yes but not Acme", "yes?") approves
// nothing. Read only while the batch is the thread's last word (outreachTurn), never by parseOutreachReply, so a bare
// "yes" anywhere else stays someone else's (WO-033/P1).
export function parseBatchYes(text: string): Extract<OutreachReply, { kind: "send" | "bad" }> | null {
  // A thumbs-up alone, or "yess"/"yse" alone, is "yes" (approval_words.ts).
  const raw = approvalWords(String(text ?? "")).trim();
  if (raw.length > 80) return null;
  // A question ("yes?", "send them all?") never matches below: only . and ! are stripped from the end.
  const t = raw.toLowerCase().replace(/[’]/g, "'").replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  // Owner rules (2026-10-29): "ok", "okay" and "sure" alone are not a clear yes and approve nothing (as on the card and the
  // billing cancel); with an explicit send ("ok, send them all") they are. "y", "send" and "yes to all" are a clear yes.
  const yes = /^(?:yes|yep|yeah|yup|y|(?:ok|okay|sure)(?=[,!.]? (?:send|approve|go ahead|do it)\b)|approve(?:d)?|go ahead|do it|lgtm|looks good|sounds good|send|send them(?: all)?|send all of them|yes to all)(?:[,!.]? (?:send (?:them|all(?: of them)?|them all)|go ahead|please|all of them|all|do it|approve(?: them| all)?))*(?:[,;]? (?:except|but not|minus|without|not) (.+))?$/.exec(t);
  if (yes) {
    if (yes[1] === undefined) return { kind: "send", all: true, ns: [], except: [] };
    const nums = parseNumbers(yes[1].replace(/\b(?:numbers?|drafts?)\b|#/g, " ").trim());
    if (!nums) return { kind: "bad", why: `say which to leave out by number, e.g. "yes except 3"` };
    if (!nums.ok) return { kind: "bad", why: nums.why };
    return { kind: "send", all: true, ns: [], except: nums.ns };
  }
  const only = /^(?:(?:yes|ok|okay)[,!.]? )?(?:only|just)(?: send| approve)?(?: numbers?| drafts?)? (.+)$/.exec(t);
  if (only) {
    const nums = parseNumbers(only[1]);
    if (!nums) return { kind: "bad", why: `say which by number, e.g. "only 1-10"` };
    if (!nums.ok) return { kind: "bad", why: nums.why };
    return { kind: "send", all: false, ns: nums.ns, except: [] };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ admission
// The one admission rule (the database's career_outreach_claim checks the same): the exact approval, its 7-day life, pause
// and do-not-contact. No volume number of Trainee's own (NO LIMITS).
export function admitSend(o: { draft: OutreachDraft; hash: string; now: number; dnc: boolean; quiet?: boolean }): Admit {
  if (o.draft.status !== "approved" || !o.draft.approved_hash) return "not_approved";
  if (o.draft.approved_hash !== o.hash || o.draft.hash !== o.hash) return "changed";
  // The database's anchor (career_outreach_claim): the later of the approval and the draft.
  const anchor = Math.max(...[o.draft.approved_at, o.draft.created_at].map((t) => Date.parse(String(t ?? ""))).filter(Number.isFinite));
  if (Number.isFinite(anchor) && anchor < o.now - APPROVAL_TTL_MS) return "expired";
  if (o.quiet) return "paused";
  if (o.dnc) return "do_not_contact";
  return "ok";
}
export const dayStartOf = (now: number, tz?: string) => { const [y, m, d] = dayIn(now, tz).split("-").map(Number); return localMidnight(y, m, d, tz || "America/New_York"); };

// ------------------------------------------------------------------------------------------------ events
const BANK = new Set(["Goldman Sachs", "JPMorgan", "Morgan Stanley", "Bank of America", "Citi", "Barclays", "Deutsche Bank", "Wells Fargo", "Evercore", "Lazard", "Centerview Partners", "PJT Partners", "Moelis", "Houlihan Lokey", "Jefferies"]);
// The kind of person, from their row alone, so "which bankers did I email" finds them.
export function roleWord(r: Pick<Recipient, "title" | "firm">): string | null {
  const t = plain(r.title);
  if (/\b(banking|banker|m and a|mergers|capital markets|leveraged finance|levfin|coverage|restructuring|ecm|dcm)\b/.test(t) || BANK.has(normalizeFirm(r.firm)) && /\b(analyst|associate|vice president|vp|director|managing director|md|partner|principal)\b/.test(t)) return "Banker";
  if (/\b(recruit|talent|campus)/.test(t)) return "Recruiter";
  if (/\bconsult/.test(t)) return "Consultant";
  if (/\btrad(er|ing)\b/.test(t)) return "Trader";
  if (/\bengineer/.test(t)) return "Engineer";
  return null;
}
export function recordOutreach(events: EventStore | null | undefined, userId: string, kind: string, d: OutreachDraft, at: number, extra: Record<string, unknown> = {}) {
  const r = d.recipient;
  return recordEvent(events, {
    user_id: userId, at, kind, subject: `${r.name}${r.firm ? `, ${r.firm}` : ""}`, source: "outreach",
    detail: { name: r.name, company: r.firm, title: r.title || null, role: roleWord(r), batch: d.batch_id, n: d.n, to_domain: r.email.split("@")[1] ?? null, subject: d.subject, ...extra },
  });
}

// ------------------------------------------------------------------------------------------------ the turn
const listOf = (ds: OutreachDraft[]) => ds.map((d) => `${d.n} ${d.recipient.name}${d.recipient.firm ? ` (${d.recipient.firm})` : ""}`).join(", ");
export async function outreachTurn(o: {
  message: string; userId: string; threadId: string; now: number; store: OutreachStore; events?: EventStore | null;
  redraft?: (d: OutreachDraft) => Promise<Drafted>; gmailConnected?: () => Promise<boolean>; connectAsk?: string; tz?: string;
  // D-MN-1/2: called once per answer with exactly the drafts this answer approved, each with the hash it was approved
  // against (career_outreach_drafts.approved_hash). The Gmail sending rail (queueApprovedOutreach, built separately)
  // plugs in here. A failure is logged and changes nothing that was approved: the scheduled send run re-checks every
  // draft's hash at claim (admitSend "changed").
  // OUTREACH R3 (2026-10-31): the hand-off may answer which approved drafts the rail would not take ({draftId, reason}:
  // opted_out, bad_address, already_emailed ...); the reply says so instead of promising they go.
  onApproved?: (userId: string, items: ApprovedItem[]) => Promise<void | { draftId: string; reason: string }[]>;
}): Promise<{ reply: string; status: string; intent: string; parts?: string[]; approved?: ApprovedItem[] } | null> {
  // A batch yes (D-MN-2) counts only while the batch is the thread's last word: the check just below, as for "send all".
  const r: OutreachReply | null = parseOutreachReply(o.message) ?? parseBatchYes(o.message);
  if (!r) return null;
  // D-MN-2: a question ("send them all?", "send 3?") is never an approval; with D-MN-1 an approval now sends.
  if (r.kind === "send" && /\?\s*$/.test(String(o.message ?? "").trim())) return null;
  // A take-back ("cancel 1") counts at any time, but only for a draft of the newest batch still waiting or approved.
  const anytime = r.kind === "skip" && !!r.anytime;
  if (r.kind !== "show" && r.kind !== "lapsed" && !anytime && (await o.store.lastAssistantIntent(o.threadId)) !== OUTREACH_INTENT) return null;
  if (anytime && (await o.store.lastAssistantIntent(o.threadId)) !== OUTREACH_INTENT) {
    const b = await o.store.latestBatch(o.userId);
    if (!r.ns.every((n) => b.some((d) => d.n === n && (d.status === "shown" || d.status === "approved")))) return null;
  }
  // SERIAL-1510 (b): approvals the run dropped as expired are said when the person next asks, never proactively; the old
  // approval is dead, and only a fresh "send" on the re-shown drafts approves them again.
  const lapsed = r.kind === "show" || r.kind === "lapsed" ? await o.store.lapsed(o.userId) : [];
  if (r.kind === "lapsed") {
    if (!lapsed.length) return { reply: "No approved drafts have lapsed: nothing approved went unsent past its 7 days.", status: "none_lapsed", intent: "career_outreach_answer" };
    const again = lapsed.map((d, i) => ({ n: i + 1, recipient: d.recipient, subject: d.subject, body: d.body, footer: d.footer, hash: d.hash, shared: d.shared, status: "shown" as const,
      approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() }));
    const shown = await o.store.saveBatch(o.userId, o.threadId, again, o.now);
    for (const d of lapsed) await o.store.update(o.userId, { ...d, result: "expired_reshown" }, { status: "skipped" });
    for (const d of shown) await recordOutreach(o.events, o.userId, "outreach_redrafted", d, o.now, { lapsed: true });
    const head = `${shown.length} draft${shown.length === 1 ? "" : "s"} lapsed unsent; here ${shown.length === 1 ? "it is" : "they are"} again, exactly as before. The earlier approval no longer counts: nothing is sent until you approve ${shown.length === 1 ? "it" : "them"} again.`;
    const parts = [head, ...batchMessages(shown)];
    return { reply: parts.join("\n\n"), status: "lapsed_shown", intent: OUTREACH_INTENT, parts };
  }
  const batch = await o.store.latestBatch(o.userId);
  const note = lapsed.length ? `${lapsedLine(lapsed.length)}\n\n` : "";
  if (!batch.length) return r.kind === "show" ? { reply: `${note}There are no outreach drafts yet. Ask me to draft emails to people on your list.`, status: lapsed.length ? "empty_lapsed" : "empty", intent: "career_outreach_answer" } : null;
  const open = (s: string, status: string) => ({ reply: s, status, intent: OUTREACH_INTENT });
  // OUTREACH SCENARIOS (2026-10-30): an answer approves only the batch this chat showed. The newest batch was read for
  // the person, whichever chat drafted it, so "yes" here approved a batch drafted and shown in another chat (never shown
  // here). Showing it here moves it here; answering in a chat that did not show it approves nothing.
  if (r.kind === "show") {
    if (batch[0].thread_id && batch[0].thread_id !== o.threadId && o.store.moveBatch) await o.store.moveBatch(o.userId, batch[0].batch_id, o.threadId);
    return { ...open(note + batchText(batch), lapsed.length ? "shown_lapsed" : "shown"), parts: [...(lapsed.length ? [lapsedLine(lapsed.length)] : []), ...batchMessages(batch)] };
  }
  if (!anytime && batch[0].thread_id && batch[0].thread_id !== o.threadId) {
    return { reply: `Nothing was approved or changed: your newest drafts were shown in another chat, not this one. Say "show drafts" to see them here.`, status: "other_chat", intent: "career_outreach_answer" };
  }
  const byN = new Map(batch.map((d) => [d.n, d]));
  const numbers = batch.map((d) => d.n);
  const range = numbers.length === 1 ? "only number 1" : `numbers 1 to ${Math.max(...numbers)}`;
  if (r.kind === "send" && r.it) {
    // "send it": exactly one draft is waiting, so "it" can mean only that one; otherwise ask for the number, once.
    const waiting = batch.filter((d) => d.status === "shown");
    if (waiting.length !== 1) return open(`Nothing was approved: ${waiting.length ? `${waiting.length} drafts are waiting, so say which by number, e.g. "send ${waiting[0].n}", or "send all"` : "no draft in this batch is waiting for approval"}.`, "bad");
    r.ns = [waiting[0].n];
  }
  if (r.kind === "bad") return open(`Nothing was approved: ${r.why}. This batch has ${range}.`, "bad");
  if (Date.parse(batch[0].created_at) < o.now - BATCH_TTL_MS) return { reply: `Those drafts are more than 3 days old, so nothing was approved. Ask me to draft them again.`, status: "expired", intent: "career_outreach_answer" };
  const named = r.kind === "send" ? [...r.ns, ...r.except] : r.kind === "skip" ? r.ns : r.kind === "none" ? [] : [r.n];
  const unknown = named.filter((n) => !byN.has(n));
  if (unknown.length) return open(`This batch has ${range}; there is no ${unknown.length > 5 ? `${unknown[0]} to ${unknown[unknown.length - 1]}` : unknown.join(", ")}. Nothing was approved.`, "not_in_batch");
  if (r.kind === "none") {
    for (const d of batch.filter((x) => x.status === "shown")) await o.store.update(o.userId, { ...d, status: "skipped" }, { status: "shown" });
    return { reply: "Nothing was approved and nothing will be sent from this batch.", status: "none", intent: "career_outreach_answer" };
  }
  if (r.kind === "skip") {
    const done: OutreachDraft[] = [];
    for (const n of r.ns) { const d = byN.get(n)!; if (["shown", "approved"].includes(d.status) && await o.store.update(o.userId, { ...d, status: "skipped", approved_hash: null, approved_at: null, ...(r.anytime ? { result: "cancelled" } : {}) }, { status: d.status })) done.push(d); }
    for (const d of done) if (r.anytime) await recordOutreach(o.events, o.userId, "status_change", d, o.now, { outreach: "cancelled" });
    const left = (await o.store.latestBatch(o.userId)).filter((d) => d.status === "shown").map((d) => d.n);
    const what = r.anytime ? (done.length ? `Cancelled ${listOf(done)}: nothing will be sent${done.length === 1 ? " to them" : ""} from ${done.length === 1 ? "that draft" : "those drafts"}.` : "Nothing was cancelled (already sent or dropped).") : `Dropped ${done.length ? listOf(done) : "nothing (already sent or dropped)"}.`;
    return open(`${what} ${left.length ? `Still waiting: ${left.join(", ")}.` : "Nothing else is waiting."}`, "skipped");
  }
  if (r.kind === "redo" || r.kind === "edit") {
    const d = byN.get(r.n)!;
    if (!["shown", "approved"].includes(d.status)) return open(`Draft ${r.n} is already ${d.status}; it can't be changed now.`, "locked");
    let subject = d.subject, body: string, shared = d.shared ?? [];
    if (r.kind === "redo") {
      if (!o.redraft) return open(`I can't write a new version of ${r.n} right now. Draft ${r.n} is unchanged and not approved.`, "no_model");
      const x = await o.redraft(d);
      if (!x.ok) return open(`I couldn't write a new version of ${r.n} that uses only what's on record (${x.detail.slice(0, 3).join("; ")}). Draft ${r.n} is unchanged.`, "redo_failed");
      subject = x.subject; body = x.body; shared = x.shared;
    } else {
      body = r.text.slice(0, 4000);
    }
    const next: OutreachDraft = { ...d, subject, body, shared, status: "shown", approved_hash: null, approved_at: null };
    next.hash = await payloadHash(messageOf(next));
    await o.store.update(o.userId, next, { status: d.status });
    const was = d.status === "approved" ? " It was approved before; this new version needs your approval." : "";
    return open(`New version of ${r.n}${r.kind === "edit" ? " in your words" : ""}. Nothing is approved for it yet.${was}\n\n${draftText(next)}\n\n${BATCH_FOOT}`, r.kind);
  }
  // send: approve exactly the drafts named, each bound to the exact message shown.
  const want = r.all ? numbers.filter((n) => !r.except.includes(n)) : r.ns;
  const approved: OutreachDraft[] = [], not: string[] = [];
  for (const n of want) {
    const d = byN.get(n)!;
    if (d.status !== "shown") { not.push(`${n} (${d.status})`); continue; }
    const h = await payloadHash(messageOf(d));
    if (h !== d.hash) { not.push(`${n} (changed since it was shown)`); continue; }
    if (await o.store.update(o.userId, { ...d, status: "approved", approved_hash: h, approved_at: new Date(o.now).toISOString() }, { status: "shown", hash: h })) {
      approved.push(d);
      await recordOutreach(o.events, o.userId, "outreach_approved", d, o.now);
    } else not.push(`${n} (changed since it was shown)`);
  }
  const items: ApprovedItem[] = approved.map((d) => ({ draftId: d.id, approvalHash: d.hash, n: d.n, batchId: d.batch_id, to: d.recipient.email }));
  const notTaken = items.length && o.onApproved ? (await o.onApproved(o.userId, items).catch((e) => { console.error("outreach: hand-off of approved drafts:", e instanceof Error ? e.message : e); })) || [] : [];
  const left = numbers.filter((n) => !want.includes(n) && byN.get(n)!.status === "shown");
  const prefs = await o.store.prefs(o.userId).catch(() => ({ daily_cap: null, signature: null }));
  const lines = [approved.length ? `Approved ${approved.length}, exactly as shown: ${listOf(approved)}.` : "Nothing new was approved."];
  if (not.length) lines.push(`Not approved: ${not.join(", ")}.`);
  // OUTREACH R3: an approved draft the sending rail refused for good is never said to be going (the database marks the
  // draft skipped with that reason, 20261031020000 career_send_enqueue).
  const wont = notTaken.map((x) => ({ d: approved.find((a) => a.id === x.draftId), why: RAIL_REFUSED[x.reason] })).filter((x) => x.d && x.why);
  if (wont.length) lines.push(`Won't be sent: ${wont.map((x) => `${x.d!.n} (${x.d!.recipient.name}: ${x.why})`).join(", ")}.`);
  if (left.length) lines.push(`Not sent: ${left.join(", ")}.`);
  if (approved.length > wont.length) {
    const connected = o.gmailConnected ? await o.gmailConnected().catch(() => false) : false;
    // NO LIMITS: no pacing or daily number of Trainee's own is promised; only Gmail's own refusal slows sending.
    if (connected) lines.push(`They go from your Gmail. If Gmail asks to slow down, the rest wait and go on when it allows, and I'll tell you. ${LAPSE_NOTE}`);
    // FAMILY NETWORKING: no promise of a send that can't happen. Sending from the person's own address is not available
    // (gmail.send is deferred), so the reply says nothing went, and gives the ways to send it themselves, exactly as approved.
    else lines.push(`Nothing has gone out. Nothing can go out until your Gmail is connected for sending, and sending from your own address isn't available in Trainee yet.\n\n${sendYourselfText(approved)}${o.connectAsk ? `\n\n${o.connectAsk}` : ""}`);
  }
  return { reply: lines.join(" ").replace(/ \n\n/, "\n\n"), status: approved.length ? "approved" : "none_approved", intent: left.length ? OUTREACH_INTENT : "career_outreach_answer", ...(items.length ? { approved: items } : {}) };
}
// Why the sending rail refused an approved draft for good, in the person's words (the reasons career_send_enqueue gives).
export const RAIL_REFUSED: Record<string, string> = {
  opted_out: "they asked not to be contacted", bad_address: "that address bounced before, so no one emails it again",
  already_emailed: "you already emailed them; Trainee never sends a second first email to the same person",
};
// One draft an answer approved: what the sending rail needs to queue it (D-MN-2: each bound to its own hash).
export interface ApprovedItem { draftId: string; approvalHash: string; n: number; batchId: string; to: string }
// The person's drafts approved and not yet sent, each with the hash it was approved against: the read the sending rail
// uses to check that a queued {draftId, approvalHash} is still exactly what was approved (status approved, hash unchanged).
export async function approvedOutreach(store: OutreachStore, userId: string): Promise<(ApprovedItem & { approvedAt: string | null })[]> {
  // NO LIMITS: every approved draft, however many (no newest-500 window).
  const rows = store.approvedDrafts ? await store.approvedDrafts(userId) : store.history ? await store.history(userId, Number.MAX_SAFE_INTEGER) : await store.latestBatch(userId);
  return rows.filter((d) => d.status === "approved" && !!d.approved_hash && d.approved_hash === d.hash)
    .map((d) => ({ draftId: d.id, approvalHash: d.approved_hash!, n: d.n, batchId: d.batch_id, to: d.recipient.email, approvedAt: d.approved_at }));
}

// ------------------------------------------------------------------------------------------------ sending it yourself
// The ladder when Trainee can't send from the person's address: copy the exact text, or open it prefilled in their own
// mail app (a mailto link carrying exactly the approved recipient, subject and text), then say "sent N" so it is tracked,
// gets its follow-up reminder, and can never be sent a second time by Trainee.
export const MAILTO_MAX = 1800;
export function mailtoOf(m: Message): { url: string; full: boolean } {
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  const to = /^[^\s@,;<>?&#%]+@[^\s@,;<>?&#%]+$/.test(m.to) ? m.to : encodeURIComponent(m.to);
  const full = `mailto:${to}?subject=${enc(m.subject)}&body=${enc(m.text)}`;
  return full.length <= MAILTO_MAX ? { url: full, full: true } : { url: `mailto:${to}?subject=${enc(m.subject)}`, full: false };
}
const numbersText = (ns: number[]) => ns.length === 1 ? String(ns[0]) : ns.join(",");
export function sendYourselfText(ds: Pick<OutreachDraft, "n" | "recipient" | "subject" | "body" | "footer">[]): string {
  const one = ds.length === 1;
  const links = ds.map((d) => {
    const m = messageOf(d), l = mailtoOf(m);
    return `${one ? "" : `${d.n} (${d.recipient.name}): `}${l.url}${l.full ? "" : `\n(The text is too long for a link, so this opens with the address and subject; paste the text of ${d.n} in.)`}`;
  });
  return [
    `To send ${one ? "it" : "them"} yourself now, from your own email:`,
    `1. Copy ${one ? `draft ${ds[0].n}` : `drafts ${numbersText(ds.map((d) => d.n))}`} exactly as shown above into a new email${one ? ` to ${messageOf(ds[0]).to}` : ""}.`,
    `2. Or open ${one ? "it" : "each one"} ready to send in your mail app${one ? ":" : ""}\n${links.join("\n")}`,
    `3. Once you've sent ${one ? "it" : "them"}, say "sent ${numbersText(ds.map((d) => d.n))}" and I'll mark ${one ? "it" : "them"} sent and set a follow-up for ${FOLLOWUP_DAYS} days later if there's no reply. Until then ${one ? "it stays" : "they stay"} approved for 7 days, so tell me once you've sent ${one ? "it" : "them"} and Trainee will never send ${one ? "it" : "them"} a second time.`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ the scheduled run
export type SendResult = { status: "sent"; id: string; thread_id: string } | { status: "NOT_WIRED"; reason: string } | { status: "ERROR"; detail: string } | { status: "RATE_LIMITED"; detail: string };
export interface Sender { send(userId: string, m: Message): Promise<SendResult> }
export interface ReplyMail { from: string; subject: string; snippet: string; at: string }
export type ReplyRead = { status: "ok"; messages: ReplyMail[] } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };
export type ReplyReader = (userId: string, threadId: string) => Promise<ReplyRead>;

// Every approved draft that is due goes, in approval order, each only through the claim (the approval's hash and age, the
// person's pause or STOP, the do-not-contact list). NO LIMITS: no number per person, per day or per run of Trainee's own,
// no spacing. The only thing that slows a person is Gmail refusing (RATE_LIMITED): their remaining drafts wait for a
// later run, kept approved; everyone else carries on. Drafts are read in pages; a page that sends nothing ends the run
// (what is left is waiting on Gmail or refused). One person's failure is counted and never stops the next (WO-091c).
type SendStats = { sent: number; refused: Record<string, number>; not_wired: number; failed: number; rate_limited: number; errors: number; error: string | null };
type SendRun = { store: OutreachStore; sender: Sender; now: number; tz?: (userId: string) => Promise<string | undefined>; events?: EventStore | null; page?: number };
export async function runOutreachSends(o: SendRun) {
  const stats: SendStats = { sent: 0, refused: {}, not_wired: 0, failed: 0, rate_limited: 0, errors: 0, error: null };
  const waiting = new Set<string>(); // Gmail said "not now" (or is not wired) for this person this run
  const tried = new Set<string>();
  for (;;) {
    const due = (await o.store.approvedDue(o.page ?? 500)).filter((x) => !tried.has(x.draft.id));
    if (!due.length) break;
    const before = stats.sent;
    for (const { user_id, draft } of due) {
      tried.add(draft.id);
      if (waiting.has(user_id)) continue;
      try {
        const r = await sendOne(o, stats, user_id, draft);
        if (r === "wait") waiting.add(user_id);
      } catch (e) {
        stats.errors++;
        stats.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
    }
    if (stats.sent === before) break;
  }
  return stats;
}
// One approved draft through the claim and the sender. "wait": Gmail is not taking this person's mail right now.
async function sendOne(o: SendRun, stats: SendStats, user_id: string, draft: OutreachDraft): Promise<"done" | "wait"> {
  const m = messageOf(draft);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(m.to)) { stats.refused.bad_address = (stats.refused.bad_address ?? 0) + 1; return "done"; }
  const hash = await payloadHash(m);
  const tz = o.tz ? await o.tz(user_id).catch(() => undefined) : undefined;
  const admit = await o.store.claim(user_id, draft, hash, o.now, dayStartOf(o.now, tz));
  if (admit !== "ok") {
    stats.refused[admit] = (stats.refused[admit] ?? 0) + 1;
    if (admit === "changed" || admit === "do_not_contact" || admit === "expired") await o.store.update(user_id, { ...draft, status: admit === "changed" ? "shown" : "skipped", approved_hash: null, approved_at: null, result: admit }, { status: "approved" });
    // A paused account keeps its approval: a resume inside the 7 days lets it go, and nothing older ever does.
    return admit === "paused" ? "wait" : "done";
  }
  const sending: OutreachDraft = { ...draft, status: "sending", sent_at: new Date(o.now).toISOString() };
  const r = await o.sender.send(user_id, m).catch((e) => ({ status: "ERROR", detail: String(e) }) as SendResult);
  if (r.status === "sent") {
    const done = { ...sending, status: "sent" as Status, gmail_id: r.id, gmail_thread: r.thread_id, result: "sent" };
    await o.store.update(user_id, done, { status: "sending" });
    await recordOutreach(o.events, user_id, "outreach_sent", done, o.now);
    stats.sent++;
  } else {
    // Not sent: back to approved (the claim's time is cleared), so it goes on a later run: once the rail is there, or
    // once Gmail takes mail again (its own limit is the only thing that slows sending).
    await o.store.update(user_id, { ...draft, status: r.status === "ERROR" ? "failed" : "approved", sent_at: null, result: r.status === "NOT_WIRED" ? "not_wired" : r.status === "RATE_LIMITED" ? "rate_limited" : `error: ${r.detail}`.slice(0, 200) }, { status: "sending" });
    if (r.status === "NOT_WIRED") stats.not_wired++; else if (r.status === "RATE_LIMITED") stats.rate_limited++; else stats.failed++;
    if (r.status === "NOT_WIRED" || r.status === "RATE_LIMITED") return "wait";
  }
  return "done";
}

const BOUNCE_FROM = /\b(mailer-daemon|postmaster|mail delivery (subsystem|system))\b/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|delivery has failed|mail delivery failed|returned mail|failure notice|address not found)/i;
const STOP = /^\s*(stop|unsubscribe|remove me|opt out|please stop|stop emailing me|do not contact me)\b|\b(unsubscribe|stop (?:emailing|contacting|writing to) me|remove me from|take me off|do not (?:contact|email) me|don'?t (?:contact|email) me|opt me out|opt out)\b/i;
export const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
export function classifyReply(m: ReplyMail, recipient: string): "bounce" | "stop" | "reply" | "other" {
  if (BOUNCE_FROM.test(m.from) || BOUNCE_SUBJECT.test(m.subject)) return "bounce";
  if (addressOf(m.from) !== recipient.toLowerCase()) return "other";
  return STOP.test(`${m.snippet}`) || STOP.test(m.subject.replace(/^re:\s*/i, "")) ? "stop" : "reply";
}
// What came back on the threads Trainee started: a bounce marks the draft bounced; a "stop" or "unsubscribe" from the
// recipient puts them on the do-not-contact list forever; any other answer is a reply. All on the timeline.
export async function recordReply(o: { store: OutreachStore; userId: string; draft: OutreachDraft; mail: ReplyMail; now: number; events?: EventStore | null }): Promise<string> {
  const kind = classifyReply(o.mail, o.draft.recipient.email);
  if (kind === "other") return kind;
  if (kind === "stop") await o.store.addDnc(o.userId, await emailHash(o.draft.recipient.email), "recipient asked to stop", o.now);
  await o.store.update(o.userId, { ...o.draft, status: kind === "bounce" ? "bounced" : "replied", result: kind }, { status: "sent" });
  await recordOutreach(o.events, o.userId, kind === "bounce" ? "outreach_bounced" : "outreach_replied", o.draft, Date.parse(o.mail.at) || o.now, kind === "stop" ? { stop: true } : {});
  return kind;
}
export async function runOutreachReplies(o: { store: OutreachStore; read: ReplyReader; now: number; events?: EventStore | null; limit?: number }) {
  const stats = { checked: 0, replies: 0, stops: 0, bounces: 0, not_wired: 0, errors: 0, error: null as string | null };
  for (const { user_id, draft } of await o.store.sentAwaiting(o.limit ?? 20, new Date(o.now - 30 * 86400_000).toISOString())) {
    if (!draft.gmail_thread) continue;
    const r = await o.read(user_id, draft.gmail_thread).catch((e) => ({ status: "ERROR", detail: String(e) }) as ReplyRead);
    if (r.status === "NOT_WIRED") { stats.not_wired++; continue; }
    if (r.status !== "ok") continue;
    stats.checked++;
    // WO-091c: a failed write for one thread is counted; the next thread is still read.
    try {
      for (const mail of r.messages) {
        const k = await recordReply({ store: o.store, userId: user_id, draft, mail, now: o.now, events: o.events });
        if (k === "other") continue;
        if (k === "bounce") stats.bounces++; else if (k === "stop") { stats.stops++; stats.replies++; } else stats.replies++;
        break;
      }
    } catch (e) {
      stats.errors++;
      stats.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
  }
  return stats;
}

// ------------------------------------------------------------------------------------------------ stores
const CONTACTS_TABLE = "career_account_contacts", CONTACTS_PAGE = 1000;
async function pagedContacts(q: (after: string) => PromiseLike<{ data: any; error: { message: string } | null }>): Promise<{ row_key: string; data: ContactRow }[]> {
  const out: { row_key: string; data: ContactRow }[] = [];
  let after = "";
  for (;;) {
    const r = await q(after);
    if (r.error) throw new Error(`read your contacts: ${r.error.message}`);
    const rows = (r.data ?? []) as { row_key: string; data: ContactRow }[];
    out.push(...rows);
    if (rows.length < CONTACTS_PAGE) return out;
    after = rows[rows.length - 1].row_key;
  }
}
const mergeRows = (a: { row_key: string; data: ContactRow }[], b: { row_key: string; data: ContactRow }[]) => {
  const m = new Map<string, ContactRow>();
  for (const r of [...a, ...b]) m.set(r.row_key, r.data);
  return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, d]) => d);
};
export function memoryOutreachStore(): OutreachStore & { dump(): { drafts: (OutreachDraft & { user_id: string })[]; dnc: Record<string, string[]>; prefs: Record<string, Prefs> }; setIntent(threadId: string, intent: string | null): void; setQuiet(userId: string, on: boolean): void; setEpoch(userId: string, epoch: number): void; allContacts(userId: string): ContactRow[]; forgotten(userId: string): string[]; markBounced(email: string): void } {
  const drafts: (OutreachDraft & { user_id: string })[] = [], dnc: Record<string, Set<string>> = {}, prefs: Record<string, Prefs> = {}, intents: Record<string, string | null> = {};
  const follow: Record<string, Followup[]> = {}, leases: Record<string, number> = {};
  const rfacts: Record<string, Record<string, RecipientFact[]>> = {}, asks: Record<string, Record<string, unknown>> = {};
  const book: Record<string, Map<string, KeyedContact>> = {}, forgottenByUser: Record<string, Set<string>> = {}, epochByUser: Record<string, number> = {};
  const rowsOf = (u: string) => [...(book[u]?.values() ?? [])].sort((a, z) => a.row_key.localeCompare(z.row_key));
  const quiet = new Set<string>(); // paused, opted out or erased (career_user_quiet in the database)
  const bad = new Set<string>(); // bounced for anyone (career_send_bad_addresses)
  let seq = 0;
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const self: any = {
    async saveBatch(u: string, threadId: string | null, ds: any[], at: number) {
      const batch_id = `B${++seq}`;
      const out = ds.map((d) => ({ ...copy(d), id: `D${++seq}`, batch_id, thread_id: threadId, user_id: u, created_at: d.created_at ?? new Date(at).toISOString() }));
      drafts.push(...out);
      return copy(out);
    },
    async latestBatch(u: string) {
      const mine = drafts.filter((d) => d.user_id === u);
      if (!mine.length) return [];
      const b = mine[mine.length - 1].batch_id;
      return copy(mine.filter((d) => d.batch_id === b).sort((a, z) => a.n - z.n));
    },
    async update(u: string, d: OutreachDraft, expect: { status?: Status; hash?: string } = {}) {
      const i = drafts.findIndex((x) => x.id === d.id && x.user_id === u);
      if (i < 0) return false;
      if (expect.status && drafts[i].status !== expect.status) return false;
      if (expect.hash && drafts[i].hash !== expect.hash) return false;
      drafts[i] = { ...copy(d), user_id: u };
      return true;
    },
    async contacted(u: string) { return new Set(drafts.filter((d) => d.user_id === u && d.status !== "skipped").map((d) => d.recipient.email.toLowerCase())); },
    async dnc(u: string) { return new Set(dnc[u] ?? []); },
    async addDnc(u: string, h: string) { (dnc[u] ??= new Set()).add(h); },
    async prefs(u: string) { return { ...{ daily_cap: null, signature: null }, ...(prefs[u] ?? {}) } as Prefs; },
    async setPrefs(u: string, p: Partial<Prefs>) {
      prefs[u] = { ...{ daily_cap: null, signature: null }, ...(prefs[u] ?? {}), ...p } as Prefs;
    },
    async approvedDue(limit: number) {
      return copy(drafts.filter((d) => d.status === "approved").sort((a, z) => String(a.approved_at).localeCompare(String(z.approved_at))).slice(0, limit).map((d) => ({ user_id: d.user_id, draft: d })));
    },
    async claim(u: string, draft: OutreachDraft, hash: string, now: number, _dayStart: number) {
      const cur = drafts.find((x) => x.id === draft.id && x.user_id === u);
      if (!cur) return "not_approved";
      const h = await emailHash(cur.recipient.email);
      const admit = admitSend({ draft: cur, hash, now, dnc: Object.values(dnc).some((set) => set.has(h)), quiet: quiet.has(u) });
      if (admit === "ok") { cur.status = "sending"; cur.sent_at = new Date(now).toISOString(); }
      return admit;
    },
    async sentAwaiting(limit: number, since: string) {
      return copy(drafts.filter((d) => d.status === "sent" && d.sent_at && d.sent_at >= since).slice(0, limit).map((d) => ({ user_id: d.user_id, draft: d })));
    },
    async lastAssistantIntent(threadId: string) { return intents[threadId] ?? null; },
    async approvedDrafts(u: string) { return copy(drafts.filter((d) => d.user_id === u && d.status === "approved").sort((a, z) => String(z.created_at).localeCompare(String(a.created_at)) || z.n - a.n)); },
    async history(u: string, limit = 200) { return copy(drafts.filter((d) => d.user_id === u).sort((a, z) => String(z.created_at).localeCompare(String(a.created_at)) || z.n - a.n).slice(0, limit)); },
    async drafts(u: string, ids: string[]) { const want = new Set(ids); return copy(drafts.filter((d) => d.user_id === u && want.has(d.id))); },
    async recipientFacts(u: string, keys: string[]) { const m = new Map<string, RecipientFact[]>(); for (const k of keys) if (rfacts[u]?.[k]?.length) m.set(k, copy(rfacts[u][k])); return m; },
    async addRecipientFacts(u: string, k: string, facts: RecipientFact[]) { const cur = ((rfacts[u] ??= {})[k] ??= []); rfacts[u][k] = mergeFacts(cur, copy(facts)); return rfacts[u][k].length; },
    async factAsk(u: string, t: string) { return copy(asks[`${u}|${t}`] ?? null); },
    async setFactAsk(u: string, t: string, v: Record<string, unknown> | null) { if (v) asks[`${u}|${t}`] = copy(v); else delete asks[`${u}|${t}`]; },
    async forgetRecipientFacts(u: string, keys: string[] | "all") { const m = rfacts[u] ?? {}; const ks = keys === "all" ? Object.keys(m) : keys.filter((k) => k in m); for (const k of ks) delete m[k]; return ks.length; },
    async followups(u: string) { return copy(follow[u] ?? []); },
    async saveFollowups(u: string, items: Followup[]) { follow[u] = copy(followupValue(items).items); delete leases[u]; },
    async allFollowups(limit: number) { return copy(Object.entries(follow).filter(([, v]) => v.length).slice(0, limit).map(([user_id, items]) => ({ user_id, items }))); },
    async claimDueFollowups(now: number, batch: number, leaseMs: number) {
      const due = Object.entries(follow).map(([user_id, items]) => ({ user_id, items, next: followupValue(items).next_due_at }))
        .filter((x) => x.next && Date.parse(x.next) <= now && !((leases[x.user_id] ?? 0) > now))
        .sort((a, z) => a.next!.localeCompare(z.next!) || a.user_id.localeCompare(z.user_id)).slice(0, Math.max(1, batch));
      for (const x of due) leases[x.user_id] = now + leaseMs;
      return copy(due.map(({ user_id, items }) => ({ user_id, items })));
    },
    async contactsSummary(u: string) {
      const rows = rowsOf(u), files = [...new Set(rows.map((r) => r.file))].sort();
      return { total: rows.length, fileCount: files.length, files: files.slice(0, 3) };
    },
    async contactsAtFirm(u: string, k: string) { return copy(rowsOf(u).filter((r) => k && (r.firm_key === k || r.firm_raw_key === k)).map((r) => r.data)); },
    async contactsNamed(u: string, k: string) { return copy(rowsOf(u).filter((r) => k && (r.name_key === k || r.name_key.startsWith(`${k} `))).map((r) => r.data)); },
    async contactsByEmail(u: string, e: string) { return copy(rowsOf(u).filter((r) => r.email === e.toLowerCase()).map((r) => r.data)); },
    async contactsInFile(u: string, f: string) { return copy(rowsOf(u).filter((r) => r.file === f).map((r) => r.data)); },
    async putContacts(u: string, epoch: number, rows: KeyedContact[], o: { replaceFile?: string; unlessForgotten?: boolean } = {}) {
      if ((epochByUser[u] ?? 0) !== epoch) return null;
      const m = (book[u] ??= new Map()), gone = (forgottenByUser[u] ??= new Set());
      if (o.replaceFile !== undefined) for (const [k, r] of m) if (r.file === o.replaceFile) m.delete(k);
      let n = 0;
      for (const r of rows) {
        if (o.unlessForgotten && gone.has(r.person_key)) continue;
        if (!o.unlessForgotten) gone.delete(r.person_key);
        m.set(r.row_key, copy({ ...r, email: r.email ? r.email.toLowerCase() : null })); n++;
      }
      return n;
    },
    async forgetContacts(u: string, epoch: number, sel: { all?: boolean; linkedin?: boolean; rowKeys?: string[] }) {
      if ((epochByUser[u] ?? 0) !== epoch) return null;
      const m = (book[u] ??= new Map()), gone = (forgottenByUser[u] ??= new Set()), keys = new Set(sel.rowKeys ?? []);
      const people = new Set(rowsOf(u).filter((r) => sel.all || (sel.linkedin && (/connections/i.test(r.file) || (r.data as any).linkedin_export === true)) || keys.has(r.row_key)).map((r) => r.person_key));
      let n = 0;
      for (const [k, r] of m) if (people.has(r.person_key)) { m.delete(k); n++; }
      for (const pk of people) gone.add(pk);
      return n;
    },
    async accountEpoch(u: string) { return epochByUser[u] ?? 0; },
    async blocked(emails: string[]) {
      const out = new Map<string, "opted_out" | "bounced">();
      for (const e of emails) {
        const k = e.trim().toLowerCase(), h = await emailHash(k);
        if (bad.has(k)) out.set(k, "bounced"); else if (Object.values(dnc).some((set) => set.has(h))) out.set(k, "opted_out");
      }
      return out;
    },
    async moveBatch(u: string, b: string, t: string) { for (const d of drafts) if (d.user_id === u && d.batch_id === b) d.thread_id = t; },
    // Test seam: an address that bounced for anyone (career_send_bad_addresses).
    markBounced(email: string) { bad.add(email.trim().toLowerCase()); },
    // Test seams: the account's privacy epoch (an erase bumps it), and a write by "another thread" between a read and a save.
    setEpoch(u: string, e: number) { epochByUser[u] = e; },
    allContacts(u: string) { return copy(rowsOf(u).map((r) => r.data)); },
    forgotten(u: string) { return [...(forgottenByUser[u] ?? [])].sort(); },
    async lapsed(u: string) { return copy(drafts.filter((d) => d.user_id === u && d.status === "skipped" && d.result === "expired").sort((a, z) => String(a.approved_at ?? a.created_at).localeCompare(String(z.approved_at ?? z.created_at)))); },
    setIntent(threadId: string, intent: string | null) { intents[threadId] = intent; },
    setQuiet(userId: string, on: boolean) { if (on) quiet.add(userId); else quiet.delete(userId); },
    dump() { return { drafts: copy(drafts), dnc: Object.fromEntries(Object.entries(dnc).map(([k, v]) => [k, [...v]])), prefs: copy(prefs) }; },
  };
  return self;
}

// The service client's store. Every read and write names the person; the claim is the database's
// (career_outreach_claim, 20261021010000_career_outreach.sql), which takes the person's lock and checks the same rules.
const COLS = "id,user_id,batch_id,thread_id,n,recipient,subject,body,footer,hash,status,approved_hash,approved_at,sent_at,gmail_id,gmail_thread,result,shared,created_at";
const fromRow = (x: any): OutreachDraft => ({ ...x, shared: Array.isArray(x.shared) ? x.shared : [] });
export function supabaseOutreachStore(admin: any): OutreachStore {
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    // 2026-10-31 (clock sweep): created_at is the database's own clock at the insert (the column's default), never the
    // caller's `at`. latestBatch below takes the newest batch by created_at, and that is the batch an answer ("send all",
    // "send 2") approves. With the caller's time, a batch drafted by a turn or run that started earlier but saved later (its
    // `at` is its start; drafting takes the model's seconds) read as older than the batch saved and shown before it, so the
    // answer approved a batch other than the one shown last; two workers' clocks (±2 s) reordered them the same way. As
    // supabaseRepliesStore.saveActions (PR #341). The 3-day check reads it against the turn's clock: seconds do not matter.
    async saveBatch(u, threadId, ds, _at) {
      const batch_id = crypto.randomUUID();
      const rows = ds.map((d) => ({ user_id: u, batch_id, thread_id: threadId, n: d.n, recipient: d.recipient, recipient_email: d.recipient.email.toLowerCase(), subject: d.subject, body: d.body, footer: d.footer, hash: d.hash, status: d.status, shared: d.shared ?? [] }));
      return (must(await admin.from("career_outreach_drafts").insert(rows).select(COLS), "save the drafts") ?? []).map(fromRow);
    },
    async latestBatch(u) {
      const last = must(await admin.from("career_outreach_drafts").select("batch_id").eq("user_id", u).order("created_at", { ascending: false }).limit(1), "read the latest batch");
      if (!last?.length) return [];
      return (must(await admin.from("career_outreach_drafts").select(COLS).eq("user_id", u).eq("batch_id", last[0].batch_id).order("n"), "read the batch") ?? []).map(fromRow);
    },
    async update(u, d, expect = {}) {
      let q = admin.from("career_outreach_drafts").update({ subject: d.subject, body: d.body, hash: d.hash, status: d.status, approved_hash: d.approved_hash, approved_at: d.approved_at, sent_at: d.sent_at, gmail_id: d.gmail_id, gmail_thread: d.gmail_thread, result: d.result, shared: d.shared ?? [], updated_at: new Date().toISOString() })
        .eq("id", d.id).eq("user_id", u);
      if (expect.status) q = q.eq("status", expect.status);
      if (expect.hash) q = q.eq("hash", expect.hash);
      return (must(await q.select("id"), "update a draft") ?? []).length === 1;
    },
    async contacted(u) {
      // Every address, in pages: a silent cut here would let someone be emailed twice.
      const out = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const rows = must(await admin.from("career_outreach_drafts").select("recipient_email").eq("user_id", u).neq("status", "skipped").order("id").range(from, from + 999), "read who was contacted") ?? [];
        for (const r of rows) out.add(String(r.recipient_email).toLowerCase());
        if (rows.length < 1000) return out;
      }
    },
    async lapsed(u) {
      return (must(await admin.from("career_outreach_drafts").select(COLS).eq("user_id", u).eq("status", "skipped").eq("result", "expired").order("created_at").limit(200), "read the lapsed drafts") ?? []).map(fromRow);
    },
    async approvedDrafts(u) {
      const out: OutreachDraft[] = [];
      for (let from = 0; ; from += 1000) {
        const rows = must(await admin.from("career_outreach_drafts").select(COLS).eq("user_id", u).eq("status", "approved").order("created_at", { ascending: false }).order("n", { ascending: false }).order("id").range(from, from + 999), "read your approved drafts") ?? [];
        out.push(...rows.map(fromRow));
        if (rows.length < 1000) return out;
      }
    },
    async history(u, limit = 200) {
      return (must(await admin.from("career_outreach_drafts").select(COLS).eq("user_id", u).order("created_at", { ascending: false }).order("n", { ascending: false }).limit(limit), "read your outreach") ?? []).map(fromRow);
    },
    async drafts(u, ids) {
      if (!ids.length) return [];
      const out: OutreachDraft[] = [];
      for (let k = 0; k < ids.length; k += 100) {
        out.push(...(must(await admin.from("career_outreach_drafts").select(COLS).eq("user_id", u).in("id", ids.slice(k, k + 100)), "read your outreach drafts") ?? []).map(fromRow));
      }
      return out;
    },
    async recipientFacts(u, keys) {
      const m = new Map<string, RecipientFact[]>();
      for (let k = 0; k < keys.length; k += 100) {
        const rows = must(await admin.from("career_watch_kv").select("key,value").eq("user_id", u).in("key", keys.slice(k, k + 100).map((x) => RFACTS_PREFIX + x)), "read what you told me about people");
        for (const r of rows ?? []) if (Array.isArray(r.value?.facts)) m.set(String(r.key).slice(RFACTS_PREFIX.length), r.value.facts);
      }
      return m;
    },
    async addRecipientFacts(u, key, facts) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", RFACTS_PREFIX + key).maybeSingle(), "read what you told me about them");
      const merged = mergeFacts(Array.isArray(r?.value?.facts) ? r.value.facts : [], facts);
      must(await admin.from("career_watch_kv").upsert({ user_id: u, key: RFACTS_PREFIX + key, value: { facts: merged }, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save what you told me about them");
      return merged.length;
    },
    async factAsk(u, t) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", `career:fact_ask:${t}`).maybeSingle(), "read the question I asked");
      return r?.value ?? null;
    },
    async setFactAsk(u, t, v) {
      if (v) must(await admin.from("career_watch_kv").upsert({ user_id: u, key: `career:fact_ask:${t}`, value: v, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save the question I asked");
      else must(await admin.from("career_watch_kv").delete().eq("user_id", u).eq("key", `career:fact_ask:${t}`), "clear the question I asked");
    },
    async forgetRecipientFacts(u, keys) {
      let q = admin.from("career_watch_kv").delete().eq("user_id", u);
      q = keys === "all" ? q.like("key", `${RFACTS_PREFIX}%`) : q.in("key", keys.map((x) => RFACTS_PREFIX + x));
      const rows = must(await q.select("key"), "delete what you told me about people");
      return (rows ?? []).length;
    },
    async followups(u) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", FOLLOWUP_KEY).maybeSingle(), "read your follow-up reminders");
      return Array.isArray(r?.value?.items) ? r.value.items : [];
    },
    async saveFollowups(u, items) {
      // next_due_at is what the leased claim (20261027160000) orders and indexes on; saving releases any lease.
      must(await admin.from("career_watch_kv").upsert({ user_id: u, key: FOLLOWUP_KEY, value: followupValue(items), updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save your follow-up reminders");
    },
    async allFollowups(limit) {
      const rows = must(await admin.from("career_watch_kv").select("user_id,value").eq("key", FOLLOWUP_KEY).limit(limit), "read follow-up reminders");
      return (rows ?? []).map((x: any) => ({ user_id: x.user_id, items: Array.isArray(x.value?.items) ? x.value.items : [] }));
    },
    async claimDueFollowups(now, batch, leaseMs) {
      const rows = must(await admin.rpc("career_outreach_followups_claim", { p_now: new Date(now).toISOString(), p_batch: batch, p_lease_seconds: Math.max(1, Math.ceil(leaseMs / 1000)) }), "claim due follow-up reminders");
      return (rows ?? []).map((x: any) => ({ user_id: String(x.user_id), items: Array.isArray(x.value?.items) ? x.value.items : [] }));
    },
    // R1 contacts (career_account_contacts): every read indexed and keyset-paged on row_key; PAGE sizes a call, not the work.
    async contactsSummary(u) {
      const r = must(await admin.rpc("career_account_contacts_summary", { p_user: u }), "read your contacts");
      const x = Array.isArray(r) ? r[0] : r;
      return { total: Number(x?.total ?? 0), fileCount: Number(x?.file_count ?? 0), files: Array.isArray(x?.files) ? x.files : [] };
    },
    async contactsAtFirm(u, k) {
      if (!k) return [];
      const a = await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).eq("firm_key", k).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE));
      const b = await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).eq("firm_raw_key", k).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE));
      return mergeRows(a, b);
    },
    async contactsNamed(u, k) {
      if (!k) return [];
      const a = await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).eq("name_key", k).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE));
      const b = await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).like("name_key", `${k} %`).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE));
      return mergeRows(a, b);
    },
    async contactsByEmail(u, e) {
      return mergeRows(await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).eq("email", e.toLowerCase()).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE)), []);
    },
    async contactsInFile(u, f) {
      return mergeRows(await pagedContacts((after) => admin.from(CONTACTS_TABLE).select("row_key,data").eq("user_id", u).eq("file", f).gt("row_key", after).order("row_key").limit(CONTACTS_PAGE)), []);
    },
    async putContacts(u, epoch, rows, o = {}) {
      let n = 0;
      // One call per chunk keeps each request small; a file's rows replace its earlier rows in the first chunk only.
      for (let k = 0; k === 0 || k < rows.length; k += CONTACTS_PAGE) {
        const part = rows.slice(k, k + CONTACTS_PAGE).map((r) => ({ ...r, email: r.email ? r.email.toLowerCase() : null }));
        const w = must(await admin.rpc("career_account_contacts_put", { p_user: u, p_epoch: epoch, p_rows: part, p_replace_file: k === 0 ? o.replaceFile ?? null : null, p_unless_forgotten: !!o.unlessForgotten }), "save your contacts");
        if (w === null || w === undefined) return null;
        n += Number(w);
      }
      return n;
    },
    async forgetContacts(u, epoch, sel) {
      const w = must(await admin.rpc("career_account_contacts_forget", { p_user: u, p_epoch: epoch, p_all: !!sel.all, p_linkedin: !!sel.linkedin, p_row_keys: sel.rowKeys ?? [] }), "delete your contacts");
      return w === null || w === undefined ? null : Number(w);
    },
    async accountEpoch(u) {
      const r = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", "career:account").maybeSingle(), "read your account");
      return Number(r?.value?.epoch ?? 0) || 0;
    },
    async dnc(u) {
      const rows = must(await admin.from("career_outreach_dnc").select("email_hash").eq("user_id", u).limit(10000), "read the do-not-contact list");
      return new Set((rows ?? []).map((r: any) => String(r.email_hash)));
    },
    async blocked(emails) {
      const out = new Map<string, "opted_out" | "bounced">();
      const byHash = new Map<string, string>();
      for (const e of emails) byHash.set(await emailHash(e), e.trim().toLowerCase());
      const hashes = [...byHash.keys()];
      for (let k = 0; k < hashes.length; k += 100) {
        const part = hashes.slice(k, k + 100);
        for (const r of must(await admin.from("career_send_bad_addresses").select("email_hash").in("email_hash", part), "read the bounced addresses") ?? []) out.set(byHash.get(String(r.email_hash))!, "bounced");
        for (const r of must(await admin.from("career_outreach_dnc").select("email_hash").in("email_hash", part), "read the do-not-contact list") ?? []) if (!out.has(byHash.get(String(r.email_hash))!)) out.set(byHash.get(String(r.email_hash))!, "opted_out");
      }
      return out;
    },
    async moveBatch(u, b, t) {
      must(await admin.from("career_outreach_drafts").update({ thread_id: t }).eq("user_id", u).eq("batch_id", b), "move the batch to this chat");
    },
    async addDnc(u, h, reason, at) {
      must(await admin.from("career_outreach_dnc").upsert({ user_id: u, email_hash: h, reason: reason.slice(0, 120), at: new Date(at).toISOString() }, { onConflict: "user_id,email_hash", ignoreDuplicates: true }), "add to the do-not-contact list");
    },
    async prefs(u) {
      const r = must(await admin.from("career_outreach_prefs").select("daily_cap,signature,list_costs").eq("user_id", u).maybeSingle(), "read outreach settings");
      return { daily_cap: r?.daily_cap ?? null, signature: r?.signature ?? null, list_costs: r?.list_costs ?? {} };
    },
    async setPrefs(u, p) {
      must(await admin.from("career_outreach_prefs").upsert({ user_id: u, ...p, updated_at: new Date().toISOString() }, { onConflict: "user_id" }), "save outreach settings");
    },
    async approvedDue(limit) {
      return (must(await admin.from("career_outreach_drafts").select(COLS).eq("status", "approved").order("approved_at", { ascending: true }).limit(limit), "read approved drafts") ?? [])
        .map((x: any) => ({ user_id: x.user_id, draft: fromRow(x) }));
    },
    async claim(u, d, hash, now, dayStart) {
      return must(await admin.rpc("career_outreach_claim", { p_user: u, p_draft: d.id, p_hash: hash, p_now: new Date(now).toISOString(), p_day_start: new Date(dayStart).toISOString() }), "claim a send") as Admit;
    },
    async sentAwaiting(limit, since) {
      return (must(await admin.from("career_outreach_drafts").select(COLS).eq("status", "sent").gte("sent_at", since).order("sent_at", { ascending: true }).limit(limit), "read sent drafts") ?? [])
        .map((x: any) => ({ user_id: x.user_id, draft: fromRow(x) }));
    },
    async lastAssistantIntent(threadId) {
      const rows = must(await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply");
      return rows?.[0]?.meta?.intent ?? null;
    },
  };
}
