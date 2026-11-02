// From chat to the person's apply queue (STEP 4 F1, 2026-10-25). "apply to the <role> role at <Company>" or "apply to
// <Company>" puts the matching open posting on file into career_apply_wanted, the same queue the Trainee extension
// takes from and the server's prepare-ahead run draws candidates from (career_apply_prepare_candidates). The reply says
// what was queued and that nothing is prepared, filled or sent by it: preparation uses only confirmed facts, the form's
// open questions are asked of the person in chat, and the exact application goes only on their tap on its card.
// A posting not on file is said so, never invented; a second ask for the same posting queues nothing twice; the screens
// the brain's queue_applications applies (their current employer, this exact posting already in their applications) apply here.
// No product ceiling (owner, 2026-10-22: no cap on applications): only a daily pace the person set themselves is read,
// and only once the turn is an apply ask; the once-per-employer guard, the exact-payload approval on each card and the
// site limits stand. The batch ask (SERIAL-1410 (1): "apply to these", "apply to the top 2", "apply to 3 roles", "apply
// to the second one") queues from the postings the thread last listed (the router's discovery.lastShortlist), each one
// through the same screens on its own; the reply lists what was queued and what was not, with the reason for each. With
// no list on the thread the batch ask is not this turn's.
import { INT4_MAX, type Limits, PACE_RE } from "./career_apply.ts";
import { type EmployerAnswer, employerQuestion, type Pick, queueWants, type Refusal, samePosting, screenPicks, type WantStore } from "./career_apply_want.ts";
import { type AppRow, statusLine } from "./career_apply_status.ts";
import { formUrlFor, postingKey } from "./posting_key.ts";
import { type FetchFeed, type PostingsDb, searchWords } from "./career_ingest.ts";
import { applyText, linkAsk, possessiveAsk, postingForLink, postingsForRole } from "./career_apply_link.ts";
import { sameCompany, type TrackedApp } from "./career_mail.ts";
// FEATURE 1 (2026-10-25): positions in the list, the listed postings checked on file, no resume on file, the server
// prepare asked for the rows queued, and the coverage line (career_apply_from_chat.ts).
import { contentOf, type GateResult, gateSummary } from "./career_apply_gate.ts";
import { checkListed, coverageLine, NO_RESUME_NEXT, NO_RESUME_REASON, NO_RESUME_WAIT, positionsOf, type PrepareKick, prepareSentence } from "./career_apply_from_chat.ts";

export const APPLY_QUEUE_INTENT = "career_apply_queue";
const CO = "([A-Z][A-Za-z0-9&.'’-]*(?:\\s+(?:[A-Z][A-Za-z0-9&.'’-]*|\\d+|of|and|&))*)";
const QUESTION = /^\s*(how|what|where|when|should|can|could|would|do|does|did|is|are|am|why|which)\b/i;
const GENERIC_EMPLOYER = /^(?:jobs?|roles?|positions?|internships?|openings?|postings?|work|me|us|them|it|this|that|some|any|all|every\w*|any\w*|more|a few|lots|companies|employers)\b/i;
const BATCH = /\b(these|those|them|all of|the ones|each of|every|\d+\s+(roles?|jobs?|postings?|internships?|positions?))\b/i;

// The ask: a role at a named employer, or a named employer alone. Questions ("how do I apply to X?") and batch shapes
// are never this ask.
export function applyAsk(message: string): { company: string; role: string | null } | null {
  const raw = applyText(message);
  if (raw === null || !/\bapply\b/i.test(raw) || QUESTION.test(raw) || BATCH.test(raw)) return null;
  let m = raw.match(new RegExp(`\\bapply\\s+(?:me\\s+)?(?:to|for)\\s+(?:the\\s+|that\\s+|this\\s+)?(.+?)\\s+(?:role|position|job|internship|opening)\\s+at\\s+${CO}\\s*[.!]?\\s*$`, "i"));
  if (m) return { role: m[1].trim(), company: m[2].trim() };
  m = raw.match(new RegExp(`\\bapply\\s+(?:me\\s+)?(?:to|at|for)\\s+${CO}\\s*[.!]?\\s*$`, "i"));
  // KNOWN GAPS (2026-10-30, #317): the employer grammar is case-blind, so "apply to jobs for me" named the employer "jobs for
  // me". A name that opens with a job word, a pronoun or a quantity names no employer.
  if (m && GENERIC_EMPLOYER.test(m[1].trim())) return null;
  if (m) return { role: null, company: m[1].trim() };
  return null;
}

// The batch ask: the listed postings (all, the first N, the Nth, or N of them). Questions, past tense and a named employer
// ("apply to the analyst role at Acme": the single ask's) are never this ask.
// D-MS-2 (2026-10-27): "all" may carry a filter over the listed postings ("apply to all remote ones", "apply to every
// SWE intern role you found"): only the listed postings that match it are queued, as one batch.
export type ListFilter = { remote: boolean; words: string[]; said: string };
export type ManyAsk = { kind: "all"; filter?: ListFilter } | { kind: "first"; n: number } | { kind: "nth"; i: number } | { kind: "pick"; is: number[] };
// Short forms a person types for a role family, read against the listed titles.
const ROLE_ALIASES: Record<string, string[]> = {
  swe: ["software engineer", "software engineering", "software developer", "swe"],
  sde: ["software development engineer", "software engineer", "sde"],
  dev: ["developer", "engineer"],
  eng: ["engineer", "engineering"],
  pm: ["product manager", "program manager", "pm"],
  ds: ["data scientist", "data science"],
  ml: ["machine learning", "ml"],
  ai: ["ai", "artificial intelligence", "machine learning"],
  fe: ["frontend", "front end", "front-end"],
  be: ["backend", "back end", "back-end"],
  ux: ["ux", "user experience", "designer"],
  intern: ["intern", "internship", "co-op"],
  internship: ["intern", "internship", "co-op"],
  internships: ["intern", "internship", "co-op"],
  interns: ["intern", "internship", "co-op"],
};
const FILTER_NOISE = new Set(["the", "of", "a", "an", "my", "those", "these", "them", "that", "you", "i", "just", "jobs", "job", "roles", "role", "ones", "one", "postings", "posting", "positions", "position", "openings", "opening", "listings", "listing", "remaining", "other"]);
// The words of an "all <words> ones" / "every <words> role you found" ask, or null when it is not that shape. "remote" is
// read against the posting's location (and title); every other word against the title.
export function listFilterOf(after: string): ListFilter | null {
  const m = /^(?:all(?:\s+of)?(?:\s+the)?|every(?:\s+one\s+of\s+the)?|each(?:\s+of\s+the)?)\s+(.+?)\s+(?:ones?|roles?|jobs?|postings?|positions?|internships?|openings?|listings?)(?:\s+(?:you(?:'ve| have)?\s+(?:just\s+)?(?:found|listed|showed|shown|sent|gave)(?:\s+me)?|(?:on|from)\s+(?:the|that|your)\s+list|there|here|above))?(?:\s+please)?$/.exec(after);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/[^a-z0-9+#/ -]/g, " ").split(/\s+/).filter((w) => w && !FILTER_NOISE.has(w));
  // "every remote internship": the noun itself is the filter word.
  if (/\binternships?\b/.test(after) && !raw.some((w) => /^intern/.test(w))) raw.push("intern");
  if (!raw.length) return null;
  const remote = raw.includes("remote");
  return { remote, words: raw.filter((w) => w !== "remote"), said: m[1].trim() };
}
const titleHas = (title: string, w: string) => {
  const t = ` ${lower(title)} `;
  return (ROLE_ALIASES[w] ?? [w]).some((a) => t.includes(` ${lower(a)} `) || t.includes(` ${lower(a)}s `));
};
export function matchesFilter(e: { title?: string | null; location?: string | null }, f: ListFilter): boolean {
  if (f.remote && !/\bremote\b/i.test(`${e.location ?? ""} ${e.title ?? ""}`)) return false;
  return f.words.every((w) => titleHas(String(e.title ?? ""), w));
}
const WORD_N: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const numOf = (w: string) => /^\d+$/.test(w) ? Number(w) : WORD_N[w.toLowerCase()];
export function applyManyAsk(message: string): ManyAsk | null {
  const raw = applyText(message);
  if (raw === null || !/\bapply\b/i.test(raw) || QUESTION.test(raw) || /\bapplied\b/i.test(raw) || /\bat\s+[A-Z]/.test(raw)) return null;
  const t = raw.toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const after = t.match(/\bapply\b(?:\s+me)?(?:\s+(?:to|for))?\s+(.*)$/)?.[1];
  if (after === undefined) return null;
  let m = after.match(/^(?:the\s+)?(first|second|third|fourth|fifth)\s+one\b/);
  if (m) return { kind: "nth", i: ORD[m[1]] };
  m = after.match(/^(?:the\s+)?(?:top|first|best)\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (m) return { kind: "first", n: numOf(m[1]) };
  // A bare count of the listed postings ("3 roles", "2 of them"). A count with a role family in it ("15 software
  // engineering intern roles") is the broad ask, the batch delegation's (career_batch_apply), never this turn's.
  m = after.match(/^(?:all\s+)?(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:roles?|jobs?|postings?|positions?|internships?|openings?|of (?:them|these|those))\b/);
  if (m) return { kind: "first", n: numOf(m[1]) };
  // D-MS-2: "all remote ones", "every SWE intern role you found": the listed postings that match, as one batch.
  if (!/^(?:all\s+(?:of\s+)?)?(?:these|those|them|both)\b/.test(after)) {
    const filter = listFilterOf(after);
    if (filter) return { kind: "all", filter };
  }
  if (/^(?:all\s+(?:of\s+)?)?(?:these|those|them|both|each of (?:these|those|them)|every one of (?:these|those|them)|them all|the ones (?:you )?(?:just )?listed|the list|all)\b/.test(after)) return { kind: "all" };
  // FEATURE 1: positions ("1 and 3", "#2", "the 2nd one", "the first and third").
  const is = positionsOf(after);
  if (is) return is.length === 1 ? { kind: "nth", i: is[0] } : { kind: "pick", is };
  return null;
}

const lower = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// What the queue recorded, as an application for the same-posting screen (D-MS-3: no employer rule): a row that was
// approved, went, may have gone, or was handed back to the person to finish counts; one that ended unsent does not.
// The queue's states that count as this posting applied to (or approved, or handed back to finish): the database's own
// career_apply_counted_states(), so a posting the database would refuse as the same posting is said so here first.
const COUNTED = new Set(["queued", "driving", "submitted_unconfirmed", "confirmed", "needs_user", "unknown_outcome"]);
export function trackedFromRows(rows: AppRow[]): TrackedApp[] {
  return rows.map((r) => ({ ref: r.id, company: r.company, role: r.title ?? undefined, url: r.url ?? undefined, applied_at: r.created_at, stage: COUNTED.has(r.state) ? "Submitted" : "Saved", source: "queue" as const }));
}

export interface ApplyChatDeps {
  message: string; userId: string; now: number;
  postings: { search(words: string[], limit: number): Promise<any[]> };
  wants: WantStore;
  apps: () => Promise<AppRow[]>;
  facts: any[];
  // The postings the thread last listed (the router's discovery.lastShortlist), for the batch ask.
  shortlist?: ShortlistEntry[] | null;
  // The person's own daily pace, if they set one (never a product number), read only once the turn is an apply ask. A
  // reader that throws is retried once; still failing, the turn queues nothing and says the pace could not be read.
  limits?: () => Promise<Limits | undefined>;
  tz?: string;
  // The person's saved zone (career_alert_prefs.tz), read only when a reply shows a date. Absent or failing: UTC, said.
  zone?: () => Promise<string | null>;
  // SERIAL-1491: the person's answers on this thread to "is X where you work now?" (the employer-ask store); absent, none.
  employerAnswers?: () => Promise<EmployerAnswer[]>;
  // FEATURE 1: a listed posting by its id on file (career_postings), to refuse a closed one or one not found; absent, the
  // list is taken as listed.
  posting?: ((id: string) => Promise<any | null>) | null;
  // FEATURE 1: whether a confirmed resume is on file to prepare from (null: unknown, decides nothing); absent, not asked.
  resumeOnFile?: () => Promise<boolean | null>;
  // FEATURE 1: ask the server's prepare for exactly the rows queued; absent, nothing is said about preparing.
  prepare?: (jobIds: string[]) => Promise<PrepareKick>;
  // FEATURE E2E: the posting a link names, read on demand from the ATS's public API and stored as the ingest stores it
  // (career_apply_link.ts); absent, a link is not this turn's.
  link?: { db: PostingsDb; fetchFeed: FetchFeed } | null;
  // FEATURE 1: whether a row queued here is prepared at once (the server prepare is configured: CAREER_PREPARE_AHEAD_URL
  // and its token). OWNER RULE (2026-10-26): no longer read for the resume check; "no resume on file" keeps every posting
  // out of the queue either way.
  prepareOn?: () => boolean;
}
// A posting held back by the possible-match question (SERIAL-1490): queued only when the person answers no.
export interface EmployerQuestion { job_id: string | null; url: string; company: string; title: string }
export interface ShortlistEntry { id?: string | null; title?: string | null; company?: string | null; location?: string | null; url?: string | null }
export type ApplyChatResult = {
  reply: string; status: "queued" | "already" | "none" | "which" | "refused" | "unreadable" | "pace_unknown" | "pace_unreadable" | "no_list" | "asking_employer" | "no_resume" | "resume_unreadable"; intent: typeof APPLY_QUEUE_INTENT;
  // FEATURE 1: how many of the postings asked for went into the queue, and whether the server prepare was asked to run.
  coverage?: { queued: number; total: number }; prepare?: PrepareKick;
  posting?: { job_id: string; company: string; title: string };
  // The batch ask: what went into the queue and what did not, each with its reason.
  queued?: { job_id: string; company: string; title: string }[]; refused?: { job_id: string | null; company: string; title: string; reason: string; said?: string }[];
  // SERIAL-1490/1491: the postings waiting on "is X where you work now?"; the handler keeps them on the reply so the next
  // yes or no answers exactly these (employerAnswerTurn).
  ask?: EmployerQuestion[];
  // The posting screen (career_apply_gate.ts): what was screened out and why, and the facts asked once.
  screen?: GateResult;
  // Q395: the earlier application that refused this one (career_apply_jobs), as said in the reply.
  prior?: { id: string; state: string; applied_at: string };
};

// SERIAL-1420 (b) / SERIAL-1430: the person's pace from the database, in its three states (career_apply_pace_state): none
// (daily null), set (daily n), unreadable (daily null and the stored value in `unreadable`). A lookup error is thrown,
// never read as "no pace": unknown is not no preference.
export function paceReader(admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<any> }, userId: string): () => Promise<Limits> {
  return async () => {
    let r: any;
    try { r = await admin.rpc("career_apply_pace_state", { p_user: userId }); }
    catch (e) { throw new Error(`pace lookup failed: ${String((e as Error)?.message ?? e)}`); }
    if (r?.error) throw new Error(`pace lookup failed: ${String(r.error.message ?? r.error)}`);
    const row = Array.isArray(r?.data) ? r.data[0] : r?.data;
    if (!row || typeof row !== "object") throw new Error("pace lookup failed: no row");
    if (row.state === "set") return { daily: Number(row.pace) };
    if (row.state === "unreadable") return { daily: null, unreadable: String(row.raw ?? "") };
    return { daily: null };
  };
}
// The pace, tried twice; `unknown` when both tries fail (the turn then queues nothing and says so).
export async function readPace(limits?: () => Promise<Limits | undefined>): Promise<{ limits?: Limits; unknown?: string }> {
  if (!limits) return {};
  let why = "";
  for (let i = 0; i < 2; i++) {
    try { return { limits: await limits() }; }
    catch (e) { why = String((e as Error)?.message ?? e); }
  }
  return { unknown: why };
}
const PACE_UNKNOWN = "I couldn't read your daily pace just now, so I don't know how many you want a day; nothing was queued. Ask again in a minute.";
const PACE_UNREADABLE = (raw: string) =>
  `Your saved daily pace could not be read (it says ${JSON.stringify(raw)}), so I don't know how many you want a day; nothing was queued. Say "set my daily pace to N" (a whole number) or "no daily pace", then ask again.`;
export const PACE_INTENT = "career_apply_pace";
const PACE_RULE = "a whole number from 1 to 2147483647, or \"no daily pace\"";

// SERIAL-1430 (b): the person sets or clears their pace in chat. Questions and other numbers are never this ask.
export function paceAsk(message: string): { pace: string | null } | null {
  const raw = String(message ?? "").trim();
  if (QUESTION.test(raw) || /\bapplied\b/i.test(raw)) return null;
  const t = raw.toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  let m = t.match(/^(?:set|change|make|put)\s+my\s+(?:daily\s+)?(?:pace|limit|cap)(?:\s+to|\s+at|\s*[:=])\s+(.+?)(?:\s+(?:a|per)\s+day)?$/);
  if (m) return { pace: /^(none|no limit|no pace|no daily pace|nothing|off|clear)$/.test(m[1]) ? null : m[1] };
  m = t.match(/^apply\s+(?:to\s+)?(?:at most\s+|up to\s+)?(\S+)\s+(?:a|per)\s+day$/);
  if (m) return { pace: m[1] };
  if (/^(?:no|remove|clear|drop|turn off|lift)\s+(?:my\s+)?(?:daily\s+)?(?:pace|limit|cap)$|^no daily (?:pace|limit|cap)$|^(?:remove|clear|drop)\s+my\s+daily\s+(?:pace|limit|cap)$/.test(t)) return { pace: null };
  return null;
}
export type PaceTurnResult = { reply: string; status: "set" | "none" | "refused" | "unreadable"; intent: typeof PACE_INTENT };
export async function paceTurn(o: { message: string; userId: string; admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<any> } }): Promise<PaceTurnResult | null> {
  const ask = paceAsk(o.message);
  if (!ask) return null;
  const intent = PACE_INTENT;
  // The same rule as the store's, here first so an impossible number is refused in the person's words before any write.
  if (ask.pace !== null && !(PACE_RE.test(ask.pace) && Number(ask.pace.trim()) >= 1 && Number(ask.pace.trim()) <= INT4_MAX)) {
    return { reply: `${ask.pace} is not a pace I can keep: ${PACE_RULE}. Your pace is unchanged.`, status: "refused", intent };
  }
  let r: any;
  try { r = await o.admin.rpc("career_apply_pace_set", { p_user: o.userId, p_pace: ask.pace === null ? "none" : ask.pace.trim() }); }
  catch (e) { r = { error: { message: String((e as Error)?.message ?? e) } }; }
  if (r?.error) {
    const msg = String(r.error.message ?? r.error);
    if (/invalid pace/.test(msg)) return { reply: `${ask.pace} is not a pace I can keep: ${PACE_RULE}. Your pace is unchanged.`, status: "refused", intent };
    return { reply: "I couldn't save that just now, so your pace is unchanged. Say it again in a minute.", status: "unreadable", intent };
  }
  if (ask.pace === null) return { reply: "Done: no daily pace. I queue what you ask for, and each goes only when you approve it on the card that shows it exactly.", status: "none", intent };
  const n = Number(r?.data?.pace ?? ask.pace);
  return { reply: `Done: your daily pace is ${n} a day. I won't queue more than that in a day; say "no daily pace" to lift it, or a new number to change it.`, status: "set", intent };
}


// Launch readiness Q2 (2026-10-26): what happens next is said as the deployed system does it. With the server's prepare
// configured (prepareRunsNow), Trainee prepares it; without it, only the Trainee extension on the person's computer does.
const NOTHING_SENT = (company: string, prepares = true) => prepares
  ? `Nothing is sent and nothing is filled yet: I prepare it before you ask, from the facts you confirmed and a resume tailored to it; if the form asks something you haven't told me, I'll ask you here. The exact application goes to ${company} only when you approve it on the card that shows it exactly.`
  : `Nothing is sent and nothing is filled yet: it's in your queue to be prepared. The exact application goes to ${company} only when you approve it on the card that shows it exactly.`;

export async function applyTurn(o: ApplyChatDeps): Promise<ApplyChatResult | null> {
  // FEATURE E2E: a pasted posting link, or a role named by the company's possessive, read from the ATS on demand
  // (career_apply_link.ts); only with the link deps wired (agent-chat), otherwise as before.
  if (o.link) {
    const linked = await linkApplyTurn(o);
    if (linked) return linked;
  }
  // The batch ask first: applyAsk's employer grammar is case-blind, so "apply to the top 2" would read as an employer.
  if (applyManyAsk(o.message)) return applyManyTurn(o);
  const ask = applyAsk(o.message);
  if (!ask) return null;
  const intent = APPLY_QUEUE_INTENT;
  // Only an open posting on file (career_postings) is this turn's: when none matches, or the read fails, the turn is
  // not claimed, and the router answers the ask as it always has (its own served list, its honest named stop).
  let hits: any[];
  try { hits = await o.postings.search(searchWords(ask.company), 50); }
  catch { return null; }
  const atCompany = hits.filter((p) => sameCompany(p?.company, ask.company) || lower(p?.company) === lower(ask.company));
  const roleWords = ask.role ? searchWords(ask.role) : [];
  const matching = roleWords.length ? atCompany.filter((p) => { const t = lower(p?.title); return roleWords.every((w) => t.includes(lower(w))); }) : atCompany;
  if (!matching.length) {
    // FEATURE E2E: nothing at that employer on file: its registered board, read on demand (career_apply_link.ts).
    if (!atCompany.length) return o.link && ask.role ? await roleFromBoard(o, ask.company, ask.role) : null;
    const near = `${ask.company} has ${atCompany.length === 1 ? "one open posting" : `${atCompany.length} open postings`} on file: ${atCompany.slice(0, 3).map((p) => p.title).join("; ")}.`;
    return { reply: `I have no open posting for ${ask.role} at ${ask.company} on file, so nothing was queued. ${near} Say "apply to the <role> role at ${ask.company}" for one of those, or paste the posting's link.`, status: "none", intent };
  }
  if (matching.length > 1 && !ask.role) {
    return { reply: `${ask.company} has ${matching.length} open postings on file. Which one? ${matching.slice(0, 5).map((p, i) => `${i + 1}. ${p.title}`).join(" ")} Say "apply to the <role> role at ${ask.company}".`, status: "which", intent };
  }
  return await applyPicked(o, matching[0]);
}

// One posting the person named, through the same screens, resume check, pace and queue as every single ask.
// deno-lint-ignore no-explicit-any
export async function applyPicked(o: ApplyChatDeps, p: any): Promise<ApplyChatResult> {
  const intent = APPLY_QUEUE_INTENT;
  const pick: Pick = { job_id: p.job_id, url: p.url, company: p.company, title: p.title, location: p.location, content: contentOf(p) };
  let apps: TrackedApp[], rows: AppRow[];
  try { rows = await o.apps(); apps = trackedFromRows(rows); }
  catch { return { reply: "I couldn't read your applications just now, so I couldn't rule out one already sent there; nothing was queued. Ask again in a minute.", status: "unreadable", intent }; }
  const resolved = await answersOf(o);
  const screened = screenPicks([pick], { apps, facts: o.facts ?? [], now: o.now, resolved });
  if (!screened.ok.length) {
    const first = screened.refused[0];
    if (first?.prior) return priorReply(rows, p, first, await zoneFor(o));
    if (first?.ask === "employer") {
      return { reply: askText([first.posting], o.facts ?? []), status: "asking_employer", intent, posting: { job_id: p.job_id, company: p.company, title: p.title },
        ask: [{ job_id: p.job_id ?? null, url: String(p.url ?? ""), company: p.company, title: p.title }] };
    }
    const why = first?.said ?? first?.reason ?? `nothing was queued`;
    const gs = gateSummary(screened.gate, nameOf);
    return { reply: `${coverageLine(0, 1)} Not queued: ${why}.${first?.ask === "fact" ? ` ${gs}` : ""}`, status: "refused", intent,
      posting: { job_id: p.job_id, company: p.company, title: p.title }, coverage: { queued: 0, total: 1 }, screen: screened.gate };
  }
  const resumeMissing = await noResume(o);
  if (resumeMissing === "unknown") return { reply: `${coverageLine(0, 1)} ${RESUME_UNREAD}`, status: "resume_unreadable", intent, posting: { job_id: p.job_id, company: p.company, title: p.title }, coverage: { queued: 0, total: 1 } };
  // OWNER RULE (2026-10-26): never queued without a confirmed resume, prepare on or off.
  if (resumeMissing) {
    return { reply: `${coverageLine(0, 1)} Not queued: ${p.title} at ${p.company}: ${NO_RESUME_REASON}. ${NO_RESUME_NEXT}`, status: "no_resume", intent,
      posting: { job_id: p.job_id, company: p.company, title: p.title }, coverage: { queued: 0, total: 1 } };
  }
  const pace = await readPace(o.limits);
  if (pace.unknown !== undefined) return { reply: PACE_UNKNOWN, status: "pace_unknown", intent, posting: { job_id: p.job_id, company: p.company, title: p.title } };
  if (pace.limits?.unreadable !== undefined) return { reply: PACE_UNREADABLE(pace.limits.unreadable), status: "pace_unreadable", intent, posting: { job_id: p.job_id, company: p.company, title: p.title } };
  const r = await queueWants(o.wants, o.userId, screened.ok, o.now, { limits: pace.limits, tz: o.tz });
  const posting = { job_id: p.job_id, company: p.company, title: p.title };
  // With no confirmed resume on file nothing is asked to prepare: it could only end in no_resume.
  const kick = r.queued && !resumeMissing ? await prepareFor(o, r.items.map((w) => w.posting_key)) : null;
  const ahead = [prepareSentence(kick, r.queued), resumeMissing && r.queued ? NO_RESUME_WAIT : ""].filter(Boolean).join(" ");
  if (r.queued) {
    return { reply: `${coverageLine(1, 1)} Queued: ${p.title} at ${p.company} is on your apply list.${ahead ? ` ${ahead}` : ""} ${NOTHING_SENT(p.company, prepareRunsNow(o))}`, status: "queued", intent, posting,
      coverage: { queued: 1, total: 1 }, ...(kick ? { prepare: kick } : {}) };
  }
  if (r.already) return { reply: `${coverageLine(0, 1, 1)} ${p.title} at ${p.company} is already in your queue, so nothing changed. ${NOTHING_SENT(p.company, prepareRunsNow(o))}`, status: "already", intent, posting, coverage: { queued: 0, total: 1 } };
  if (r.refused[0]?.prior) return priorReply(rows, p, r.refused[0], await zoneFor(o));
  const why = r.refused[0]?.said ?? r.refused[0]?.reason ?? "it could not be queued";
  return { reply: `${coverageLine(0, 1)} Not queued: ${why}.`, status: "refused", intent, posting, coverage: { queued: 0, total: 1 } };
}

// Reqs doc 2 Q395: "apply to Acme" when Acme was already applied to. The earlier application is said from the record
// (career_apply_jobs): the day it was made and where it stands now (statusLine: confirmed only when the employer confirmed
// it). Nothing is queued, and the person is asked whether this is a new role or a re-apply. The record that refused it is
// the one shown: this exact posting first, else the newest counted application to that employer.
// The day on the person's own clock (career_alert_prefs.tz); UTC, said, when no zone is on file.
const zoneOk = (tz: string | null | undefined): tz is string => {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const dayOf = (iso: string | null | undefined, tz?: string | null) => !(iso && Number.isFinite(Date.parse(iso))) ? null
  : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zoneOk(tz) ? tz : "UTC" }) + (zoneOk(tz) ? "" : " (UTC)");
// deno-lint-ignore no-explicit-any
export function priorReply(rows: AppRow[], p: any, why: Refusal, tz?: string | null): ApplyChatResult {
  const posting = { job_id: p.job_id, company: p.company, title: p.title };
  // Only an application that went out or is on its way is an earlier application; a failed or never-sent one is not.
  const counted = rows.filter((r) => COUNTED.has(r.state));
  const link = String(formUrlFor(String(p.job_id ?? "")) ?? p.url ?? "");
  const key = samePosting(postingKey(link));
  const exact = key ? counted.filter((r) => r.url && samePosting(postingKey(r.url)) === key) : [];
  const same = exact.length ? exact : counted.filter((r) => sameCompany(r.company, String(p.company ?? "")));
  const newest = [...same].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const what = `${p.title || "this posting"} at ${p.company || "this employer"}`;
  if (!newest) return { reply: `${coverageLine(0, 1)} Not queued: ${why.said}.`, status: "refused", intent: APPLY_QUEUE_INTENT, posting, coverage: { queued: 0, total: 1 } };
  const on = dayOf(newest.created_at, tz);
  // The refusal's own words first (status "refused", as every refusal), then the earlier application from the record.
  const earlier = `${exact.length ? "You applied" : `You applied to ${newest.company}${newest.title ? ` (${newest.title})` : ""}`}${on ? ` on ${on}` : ""}. Where it stands: ${statusLine(newest)}`;
  const co = p.company || "the employer";
  // Q395: a new role, or a re-apply to the same one. Trainee never sends the same posting twice; a re-apply is the person's.
  const ask = exact.length
    ? `Is this a new role at ${co}, or do you want to re-apply to this same posting? For a new role, send me its link. A re-apply to the same posting can look careless to ${co}, so Trainee won't send it twice; if you still want to, apply yourself at ${oneLine(newest.url || link)}.`
    : `Is ${what} a new role you want to apply to as well, or the same one?`;
  return { reply: `${coverageLine(0, 1)} Not queued: ${why.said}. ${earlier} ${ask}`, status: "refused", intent: APPLY_QUEUE_INTENT, posting, coverage: { queued: 0, total: 1 },
    prior: { id: newest.id, state: newest.state, applied_at: newest.created_at } };
}
const oneLine = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 500);

async function zoneFor(o: { tz?: string; zone?: () => Promise<string | null> }): Promise<string | null> {
  if (o.tz) return o.tz;
  if (!o.zone) return null;
  try { return await o.zone(); } catch { return null; }
}

// FEATURE 1: no confirmed resume on file means nothing can be prepared; unknown (null, or a reader that throws) decides
// nothing.
// Fail closed (review of PR #194): "missing" unless the check says yes; "unknown" when it could not be made.
async function noResume(o: { resumeOnFile?: () => Promise<boolean | null> }): Promise<false | "missing" | "unknown"> {
  if (!o.resumeOnFile) return false;
  let r: boolean | null;
  try { r = await o.resumeOnFile(); } catch { r = null; }
  return r === true ? false : r === false ? "missing" : "unknown";
}
export const RESUME_UNREAD = "I couldn't check your resume on file just now, so nothing was queued. Ask again in a minute.";
async function prepareFor(o: { prepare?: (jobIds: string[]) => Promise<PrepareKick> }, ids: string[]): Promise<PrepareKick | null> {
  if (!o.prepare || !ids.length) return null;
  try { return await o.prepare(ids); } catch { return "failed"; }
}

// Whether Trainee prepares applications itself (cloud prepare on) or only the extension on the person's computer does;
// it picks the "nothing is sent" wording. #194 removed it from the resume check (a missing resume now refuses, prepare
// on or off); the replies below still read it.
function prepareRunsNow(o: { prepareOn?: () => boolean }): boolean {
  if (!o.prepareOn) return true;
  try { return o.prepareOn() !== false; } catch { return true; }
}
const NOTHING_SENT_MANY = (prepares = true) => (prepares
  ? "Nothing is sent and nothing is filled yet: I prepare each one before you ask, from the facts you confirmed and a resume tailored to it; if a form asks something you haven't told me, I'll ask you here."
  : "Nothing is sent and nothing is filled yet: they're in your queue to be prepared.") +
  " Each application goes to its employer only when you approve it on the card that shows it exactly; once they're prepared, \"show my applications\" shows them all on one card, and one yes to that card approves exactly what it shows.";
const nameOf = (p: { title?: string | null; company?: string | null }) =>
  !p.company && /^#\d+$/.test(String(p.title ?? "")) ? String(p.title) : `${p.title || "the posting"} at ${p.company || "an employer not on record"}`;
const listed = (names: string[], max = 12) => names.length <= max ? names.join("; ") : `${names.slice(0, max).join("; ")}; and ${names.length - max} more`;

// The batch ask over the thread's last listed postings: null with no ask, or no list (the router's turn, as before).
export async function applyManyTurn(o: ApplyChatDeps): Promise<ApplyChatResult | null> {
  const ask = applyManyAsk(o.message);
  if (!ask) return null;
  const list = (o.shortlist ?? []).filter((e) => e && (e.url || e.id));
  const intent = APPLY_QUEUE_INTENT;
  // SERIAL-1440 (2): with no list on this thread the ask still gets an answer that says what to say, never a catch-all.
  if (!list.length) {
    return { reply: `I haven't listed any postings in this thread yet, so there is nothing for "these" to mean; nothing was queued. Say "find <role> jobs in <place>" first and then "apply to these", or name one: "apply to the <role> role at <Company>".`, status: "no_list", intent, queued: [], refused: [] };
  }
  let slice: ShortlistEntry[], note = "";
  const missing: { job_id: string | null; company: string; title: string; reason: string; said?: string }[] = [];
  if (ask.kind === "nth") {
    if (ask.i > list.length) return { reply: `I listed ${list.length}, so there is no ${["first", "second", "third", "fourth", "fifth"][ask.i - 1] ?? `#${ask.i}`} one; nothing was queued. Say which of the ${list.length} you mean.`, status: "none", intent };
    slice = list.slice(ask.i - 1, ask.i);
  } else if (ask.kind === "first") {
    if (ask.n < 1) return null;
    slice = list.slice(0, ask.n);
    if (ask.n > list.length) note = `I listed ${list.length}, not ${ask.n}, so these ${list.length}. `;
  } else if (ask.kind === "pick") {
    // FEATURE 1: "apply to 1 and 3": the positions on the list; one past its end is named, never guessed.
    const inRange = ask.is.filter((i) => i <= list.length), outRange = ask.is.filter((i) => i > list.length);
    if (!inRange.length) return { reply: `I listed ${list.length}, so there is no ${outRange.map((i) => `#${i}`).join(" or ")}; nothing was queued. Say which of the ${list.length} you mean.`, status: "none", intent };
    slice = inRange.map((i) => list[i - 1]);
    for (const i of outRange) missing.push({ job_id: null, company: "", title: `#${i}`, reason: `not on the list I showed (I listed ${list.length})` });
  } else if (ask.filter) {
    // D-MS-2: "all remote ones": the listed postings that match, all of them, as one batch; none matching queues nothing.
    slice = list.filter((e) => matchesFilter(e, ask.filter!));
    if (!slice.length) {
      return { reply: `None of the ${list.length} I listed ${list.length === 1 ? "is" : "are"} ${ask.filter.said}, so nothing was queued. Say "apply to all of them", or name which ones ("apply to 1 and 3").`, status: "none", intent, queued: [], refused: [] };
    }
    if (slice.length < list.length) note = `${slice.length} of the ${list.length} I listed ${slice.length === 1 ? "is" : "are"} ${ask.filter.said}: those ${slice.length === 1 ? "one" : String(slice.length)}. `;
  } else slice = list.slice();
  const total = slice.length + missing.length;
  const listedPicks: Pick[] = slice.map((e) => ({ job_id: e.id ?? undefined, url: e.url ?? undefined, company: e.company ?? undefined, title: e.title ?? undefined, location: e.location ?? undefined }));
  // FEATURE 1: each listed posting by its record on file; a closed one, or one not found with no link, is refused by name.
  const onFile = await checkListed(listedPicks, o.posting);
  const picks: Pick[] = onFile.ok;
  missing.push(...onFile.refused);
  let apps: TrackedApp[];
  try { apps = trackedFromRows(await o.apps()); }
  catch { return { reply: "I couldn't read your applications just now, so I couldn't rule out one already sent to any of these; nothing was queued. Ask again in a minute.", status: "unreadable", intent }; }
  // Each posting through the same screens as a single ask, on its own: their current employer, this exact posting already applied to.
  const screened = screenPicks(picks, { apps, facts: o.facts ?? [], now: o.now, resolved: await answersOf(o) });
  // SERIAL-1491: the possible-match question attaches to its own posting; the rest of the batch goes on.
  const asking = screened.refused.filter((r) => r.ask === "employer");
  const refused = [...missing, ...screened.refused.filter((r) => r.ask !== "employer").map((r) => ({ job_id: r.posting.job_id, company: r.posting.company, title: r.posting.title, reason: r.reason, said: r.said }))];
  // FEATURE 1: with no confirmed resume on file nothing can be prepared, so nothing is queued; each posting is named.
  const resumeMissing = screened.ok.length ? await noResume(o) : false;
  if (resumeMissing === "unknown") return { reply: `${coverageLine(0, total)} ${RESUME_UNREAD}`, status: "resume_unreadable", intent, queued: [], refused, coverage: { queued: 0, total } };
  // OWNER RULE (2026-10-26): never queued without a confirmed resume, prepare on or off.
  if (resumeMissing) {
    for (const p of screened.ok) refused.push({ job_id: p.job_id ?? null, company: String(p.company ?? ""), title: String(p.title ?? ""), reason: NO_RESUME_REASON });
    return { reply: `${coverageLine(0, total)} Not queued: ${listed(refused.map((r) => `${nameOf(r)}: ${r.said ?? r.reason}`), 8)}. ${NO_RESUME_NEXT}`, status: "no_resume", intent, queued: [], refused, coverage: { queued: 0, total } };
  }
  let queued: { job_id: string; company: string; title: string }[] = [], already = 0;
  if (screened.ok.length) {
    const pace = await readPace(o.limits);
    if (pace.unknown !== undefined) return { reply: PACE_UNKNOWN, status: "pace_unknown", intent, queued: [], refused };
    if (pace.limits?.unreadable !== undefined) return { reply: PACE_UNREADABLE(pace.limits.unreadable), status: "pace_unreadable", intent, queued: [], refused };
    const r = await queueWants(o.wants, o.userId, screened.ok, o.now, { limits: pace.limits, tz: o.tz });
    queued = r.items.map((w) => ({ job_id: w.posting_key, company: w.company, title: w.title }));
    already = r.already;
    for (const x of r.refused) refused.push({ job_id: x.posting.job_id, company: x.posting.company, title: x.posting.title, reason: x.reason, said: x.said });
  }
  const kick = queued.length && !resumeMissing ? await prepareFor(o, queued.map((q) => q.job_id)) : null;
  const parts: string[] = [coverageLine(queued.length, total, already)];
  if (queued.length) parts.push(`Queued ${queued.length}${total > queued.length ? ` of the ${total}` : ""}${ask.kind === "all" && !note ? " I listed" : ""}: ${listed(queued.map(nameOf))}.`);
  const ahead = prepareSentence(kick, queued.length);
  if (ahead) parts.push(ahead);
  if (resumeMissing && queued.length) parts.push(NO_RESUME_WAIT);
  if (already) parts.push(queued.length ? `${already} already in your queue, unchanged.` : `${already === slice.length ? (slice.length === 1 ? "That one is" : "Those are") : `${already} of them are`} already in your queue, so nothing changed.`);
  // The batch summary of the screen: counts and short reasons; held postings and the one question per missing fact.
  const gs = gateSummary(screened.gate, nameOf);
  const shownRefused = refused.filter((r) => !/^(screened out|held, not guessed)/.test(r.reason));
  if (shownRefused.length) parts.push(`Not queued: ${listed(shownRefused.map((r) => `${nameOf(r)}: ${r.said ?? r.reason}`), 8)}.`);
  if (gs) parts.push(gs);
  if (asking.length) parts.push(askText(asking.map((r) => r.posting), o.facts ?? []));
  const status = queued.length ? "queued" : already ? "already" : asking.length ? "asking_employer" : "refused";
  const tail = queued.length || already ? ` ${NOTHING_SENT_MANY(prepareRunsNow(o))}` : "";
  return { reply: `${note}${parts.join(" ")}${tail}`.trim(), status, intent, queued, refused, coverage: { queued: queued.length, total }, screen: screened.gate, ...(kick ? { prepare: kick } : {}),
    ...(asking.length ? { ask: asking.map((r) => ({ job_id: r.posting.job_id, url: r.posting.url, company: r.posting.company, title: r.posting.title })) } : {}) };
}

// ---------------------------------------------------------------------------------- the possible-match question (SERIAL-1490/1491)
const answersOf = async (o: { employerAnswers?: ApplyChatDeps["employerAnswers"] }): Promise<EmployerAnswer[]> => { try { return (await o.employerAnswers?.()) ?? []; } catch { return []; } };
const factAbout = (company: string, facts: any[]) => {
  const f = (facts ?? []).find((x) => x && !x.needs_confirmation && x.status !== "draft" && /\b(work|employ|current|now|present)/i.test(String(x.text ?? x.value ?? "")));
  return f ? String(f.text ?? f.value ?? "").slice(0, 160) : null;
};
// One question per posting held back; with several, the answer names the company ("Acme Robotics: no").
function askText(postings: { job_id: string | null; company: string; title: string }[], facts: any[]): string {
  const one = postings.length === 1;
  const qs = postings.map((p) => `${p.title || "the posting"} at ${p.company}: ${employerQuestion(p.company)}`);
  const basis = factAbout(postings[0].company, facts);
  return `${one ? "One question before I queue it" : `${postings.length} questions before I queue these`}${basis ? ` (you told me: "${basis}")` : ""}: ${qs.join(" ")} ` +
    `Reply ${one ? '"yes" or "no"' : `with the company and yes or no ("${postings[0].company}: no")`}; nothing is queued there until you do.`;
}
export const EMPLOYER_ASK_INTENT = "career_apply_employer_ask";
export const EMPLOYER_ANSWER_INTENT = "career_apply_employer_answer";
// Where the thread's last word and the person's earlier answers are kept: agent_messages meta (the handler writes
// employer_question on the asking reply and employer_answers on the answering one).
export interface EmployerAskStore {
  lastAssistant(threadId: string): Promise<{ intent: string | null; meta: Record<string, any> } | null>;
  answers(threadId: string): Promise<EmployerAnswer[]>;
}
// deno-lint-ignore no-explicit-any
export function supabaseEmployerAskStore(admin: any): EmployerAskStore {
  const rows = async (threadId: string, limit: number) => {
    const r = await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(limit);
    if (r.error) throw new Error(`read the thread's replies: ${r.error.message}`);
    return (r.data ?? []) as { meta: Record<string, any> | null }[];
  };
  return {
    async lastAssistant(threadId) {
      const [row] = await rows(threadId, 1);
      return row ? { intent: row.meta?.intent ?? null, meta: row.meta ?? {} } : null;
    },
    async answers(threadId) {
      const out: EmployerAnswer[] = [];
      for (const row of (await rows(threadId, 200)).reverse()) for (const a of (row.meta?.employer_answers ?? []) as any[]) if (a?.company) out.push({ company: String(a.company), is_employer: !!a.is_employer });
      return out;
    },
  };
}
export function memoryEmployerAskStore(messages: { role: string; thread_id: string; meta?: Record<string, any> | null }[]): EmployerAskStore {
  const mine = (threadId: string) => messages.filter((m) => m.role === "assistant" && m.thread_id === threadId);
  return {
    async lastAssistant(threadId) { const row = mine(threadId).at(-1); return row ? { intent: row.meta?.intent ?? null, meta: row.meta ?? {} } : null; },
    async answers(threadId) { return mine(threadId).flatMap((m) => ((m.meta?.employer_answers ?? []) as any[]).map((a) => ({ company: String(a.company), is_employer: !!a.is_employer }))); },
  };
}
// The answer, if this text is one: yes (it is where they work) or no (it is not), with the company when they name it.
// A bare yes or no, or one followed by its own words ("no, I don't work there"); "no idea what you mean" is not an answer.
const YES_ANS = /^(?:(?:yes|yep|yeah|yup)(?=$|[,.!;:]| (?:it is|that'?s|i (?:do|still)? ?work|i work|correct|right|i do))|it is|that'?s (?:right|correct|where i work)|i (?:do|still) work there|i work there|that'?s my (?:employer|company)|correct|right)\b/;
const NO_ANS = /^(?:(?:no|nope|nah)(?=$|[,.!;:]| (?:i (?:don'?t|do not|no longer) work|i left|it'?s not|it isn'?t|that'?s not|not (?:my|where)|wrong|i don'?t))|it'?s not|it isn'?t|that'?s not (?:my|where)|i (?:don'?t|do not|no longer) work (?:there|at|for)|i left|not (?:my|where i) (?:employer|work)|not any ?more)\b/;
export function employerAnswerAsk(message: string): { kind: "yes" | "no"; company: string | null } | null {
  const raw = String(message ?? "").trim();
  const m = /^([A-Za-z][\w&.'’ -]{0,80}?)\s*[:,-]\s*(.+)$/.exec(raw);
  const company = m && !/^(yes|no|nope|yeah|yep)\b/i.test(m[1]) ? m[1].trim() : null;
  const t = (company ? m![2] : raw).toLowerCase().replace(/[’`]/g, "'").replace(/[!.]+$/, "").replace(/\s+/g, " ").trim();
  const kind = answerKind(t);
  return kind ? { kind, company } : null;
}
// Owner rules (2026-10-29): a yes or no followed by more words ("yes, send them", "yes, but", "no, don't send them", "yeah
// right") answers only when those words are that answer's own ("no, I don't work there", "yes, that's right"); anything
// else (a hedge, a condition, sarcasm, an unrelated instruction) is not an answer: nothing is queued and no fact recorded.
function answerKind(t: string): "yes" | "no" | null {
  if (/^(?:yeah|yea|ya|yes),? right\b/.test(t)) return null;
  const more = /^(?:yes|yep|yeah|yup|no|nope|nah)\s*[,.!;:]+\s*(.+)$/.exec(t);
  if (more) {
    const own = answerKind(more[1]);
    return own && own === (/^(?:yes|yep|yeah|yup)\b/.test(t) ? "yes" : "no") && !/^(?:yes|yep|yeah|yup|no|nope|nah)\b/.test(more[1]) ? own : null;
  }
  if (YES_ANS.test(t) && !/\bnot\b/.test(t.split(/[,;]/)[0])) return "yes";
  if (NO_ANS.test(t)) return "no";
  return null;
}
export type EmployerAnswerResult = { reply: string; status: "queued" | "already" | "refused" | "is_employer" | "which" | "stands" | "pace_unknown" | "pace_unreadable" | "unreadable"; intent: string; pending?: EmployerQuestion[]; answers?: EmployerAnswer[] };
// The turn that answers the question, only while the question is this thread's last word; a repeated yes or no right after
// the answer is told that the answer stands (nothing asked again, nothing queued twice).
export async function employerAnswerTurn(o: Omit<ApplyChatDeps, "postings" | "shortlist"> & { threadId: string; store: EmployerAskStore }): Promise<EmployerAnswerResult | null> {
  const ans = employerAnswerAsk(o.message);
  if (!ans) return null;
  const last = await o.store.lastAssistant(o.threadId);
  if (!last) return null;
  if (last.intent === EMPLOYER_ANSWER_INTENT && !ans.company) {
    const prior = (last.meta.employer_answers ?? []) as EmployerAnswer[];
    if (!prior.length) return null;
    const lines = prior.map((a) => a.is_employer ? `${a.company} is where you work, so nothing was queued there` : `${a.company} was queued once`);
    return { reply: `That stands: ${lines.join("; ")}. Nothing was asked again and nothing more was queued.`, status: "stands", intent: EMPLOYER_ANSWER_INTENT, answers: prior };
  }
  if (last.intent !== EMPLOYER_ASK_INTENT) return null;
  const pending = ((last.meta.employer_question ?? []) as EmployerQuestion[]).filter((q) => q && q.company);
  if (!pending.length) return null;
  const chosen = ans.company ? pending.filter((q) => sameCompany(q.company, ans.company)) : pending.length === 1 ? pending : [];
  if (!chosen.length) {
    const names = pending.map((q) => q.company);
    return { reply: `Which one? ${names.map((n) => `${n}: ${employerQuestion(n)}`).join(" ")} Reply with the company and yes or no ("${names[0]}: no").`, status: "which", intent: EMPLOYER_ASK_INTENT, pending };
  }
  const rest = pending.filter((q) => !chosen.includes(q));
  const answers: EmployerAnswer[] = chosen.map((q) => ({ company: q.company, is_employer: ans.kind === "yes" }));
  const intent = rest.length ? EMPLOYER_ASK_INTENT : EMPLOYER_ANSWER_INTENT;
  const more = rest.length ? ` Still open: ${rest.map((q) => `${q.company}: ${employerQuestion(q.company)}`).join(" ")}` : "";
  if (ans.kind === "yes") {
    return { reply: `Noted: ${chosen.map((q) => q.company).join(", ")} is where you work now, so ${chosen.map(nameOf).join("; ")} stays out of your queue; nothing was queued.${more}`, status: "is_employer", intent, pending: rest, answers };
  }
  let apps: TrackedApp[];
  try { apps = trackedFromRows(await o.apps()); }
  catch { return { reply: "I couldn't read your applications just now, so I couldn't rule out one already sent there; nothing was queued. Say no again in a minute.", status: "unreadable", intent: EMPLOYER_ASK_INTENT, pending }; }
  const resolved = [...await answersOf(o), ...answers];
  // The posting screen needs the posting's own record: read it again (the question only kept its identity). A closed one is
  // refused by checkListed; a record that cannot be read leaves the pick as it was, and the screen runs on what is known.
  const onFile = await checkListed(chosen.map((q) => ({ job_id: q.job_id ?? undefined, url: q.url, company: q.company, title: q.title })), o.posting);
  const picks: Pick[] = onFile.ok;
  const screened = screenPicks(picks, { apps, facts: o.facts ?? [], now: o.now, resolved });
  const refused = [...onFile.refused.map((r) => `${nameOf(r)}: ${r.reason}`), ...screened.refused.map((r) => `${nameOf(r.posting)}: ${r.said ?? r.reason}`)];
  let queued: string[] = [], already = 0;
  if (screened.ok.length) {
    const pace = await readPace(o.limits);
    if (pace.unknown !== undefined) return { reply: PACE_UNKNOWN, status: "pace_unknown", intent: EMPLOYER_ASK_INTENT, pending };
    if (pace.limits?.unreadable !== undefined) return { reply: PACE_UNREADABLE(pace.limits.unreadable), status: "pace_unreadable", intent: EMPLOYER_ASK_INTENT, pending };
    const r = await queueWants(o.wants, o.userId, screened.ok, o.now, { limits: pace.limits, tz: o.tz });
    queued = r.items.map(nameOf); already = r.already;
    for (const x of r.refused) refused.push(`${nameOf(x.posting)}: ${x.said ?? x.reason}`);
  }
  const parts: string[] = [];
  if (queued.length) parts.push(`Noted, not your employer. Queued: ${queued.join("; ")}.`);
  if (already) parts.push(`Already in your queue, unchanged.`);
  if (refused.length) parts.push(`Not queued: ${refused.join("; ")}.`);
  const tail = queued.length || already ? ` ${NOTHING_SENT_MANY(prepareRunsNow(o))}` : "";
  return { reply: `${parts.join(" ")}${more}${tail}`.trim(), status: queued.length ? "queued" : already ? "already" : "refused", intent, pending: rest, answers };
}

// ------------------------------------------------------------------------------------- FEATURE E2E: links and boards
// "apply me to this: <link>": the posting the link names (on file, or read from its ATS now and stored), then the single
// ask's screens. A link to a posting its board no longer lists, or a board that cannot be read, queues nothing and says so.
async function linkApplyTurn(o: ApplyChatDeps): Promise<ApplyChatResult | null> {
  const intent = APPLY_QUEUE_INTENT;
  const ask = linkAsk(o.message);
  if (!ask) {
    const named = possessiveAsk(o.message);
    return named ? await roleFromBoard(o, named.company, named.role, true) : null;
  }
  const found = await postingForLink({ ask, db: o.link!.db, fetchFeed: o.link!.fetchFeed, now: o.now }).catch((e) => ({ kind: "unreadable" as const, why: String(e?.message ?? e) }));
  if (found.kind === "unreadable") {
    return { reply: `${coverageLine(0, 1)} I couldn't read that posting from ${ask.family === "ashby" ? "Ashby" : ask.family === "lever" ? "Lever" : "Greenhouse"} just now, so nothing was queued. Send the link again in a minute.`, status: "unreadable", intent, coverage: { queued: 0, total: 1 } };
  }
  if (found.kind === "not_on_board" || found.kind === "closed") {
    return { reply: `${coverageLine(0, 1)} Not queued: ${ask.url} is not among the open postings its board lists right now (it may have closed), so there is nothing to apply to.`, status: "none", intent, coverage: { queued: 0, total: 1 } };
  }
  return await applyPicked(o, found.posting);
}

// A role at a company with nothing on file: the company's registered board (121 BOARD_REGISTRY), read now. Exactly one
// open posting whose title carries every word of the role is queued only when the person named it by the company's
// possessive and the board is the registry's; more than one, or none, is listed with links and nothing is queued.
async function roleFromBoard(o: ApplyChatDeps, company: string, role: string, mayQueue = false): Promise<ApplyChatResult | null> {
  const intent = APPLY_QUEUE_INTENT;
  const r = await postingsForRole({ company, role, fetchFeed: o.link!.fetchFeed }).catch(() => null);
  if (!r) return null; // no registered board: the router answers as before
  if ("why" in r) return { reply: `${coverageLine(0, 1)} I couldn't read ${r.board.company}'s job board just now, so nothing was queued. Ask again in a minute, or paste the posting's link.`, status: "unreadable", intent, coverage: { queued: 0, total: 1 } };
  if (!r.hits.length) return { reply: `${coverageLine(0, 1)} ${r.board.company}'s job board lists no open posting for "${role}" right now, so nothing was queued. Paste the posting's link if you have it.`, status: "none", intent, coverage: { queued: 0, total: 1 } };
  if (r.hits.length > 1 || !mayQueue) {
    const list = r.hits.slice(0, 5).map((p, i) => `${i + 1}. ${p.title}${p.location ? ` (${p.location})` : ""}: ${p.url}`).join("\n");
    return { reply: `${r.board.company}'s job board lists ${r.hits.length === 1 ? "one open posting" : `${r.hits.length} open postings`} for "${role}":\n${list}\nSay "apply me to <link>" with the one you want; nothing was queued yet.`, status: "which", intent };
  }
  const p = r.hits[0], at = new Date(o.now).toISOString();
  const posting = { ...p, provider: r.board.provider, board: r.board.board.toLowerCase(), first_seen_at: at, last_seen_at: at, closed_at: null };
  const onFile = await o.link!.db.get(p.job_id).catch(() => null);
  if (onFile) posting.first_seen_at = onFile.first_seen_at;
  await o.link!.db.put(posting);
  return await applyPicked(o, posting);
}
