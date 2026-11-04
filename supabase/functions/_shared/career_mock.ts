// WO-025: the text mock interview and the pre-interview brief. Code picks the questions, scores the answers and writes
// the debrief; the model never does. Every question comes from the question banks (packages/career-data/interview-banks,
// through 127's questionBank) or the generic behavioral set; a question about a company comes only from that company's
// record on file (packages/career-data/cirs), quoted, with its source label. With no record, nothing is said about how
// the company interviews. The debrief quotes only the person's own words and states no number the rubric did not give.
//
// WO-035 adds the voice mock: "start a voice mock for Goldman IB" answers with a single-use link to the app's voice page
// (career_voice_link.ts), the call runs on OpenAI's Realtime API with the same plan of questions (career_voice.ts), and
// the transcript's words, never audio, come back to voiceDebrief here, scored with the same rubric. Firms without a full
// record get their sourced interview patterns from packages/career-data/interview-patterns.json (127 interviewPatterns).
//
// Over SMS, STOP (and END, QUIT, CANCEL, UNSUBSCRIBE, STOPALL, HELP, INFO, START) are carrier keywords that trainee-inbound
// handles before any turn runs. None of them, alone, is ever a mock command or a mock answer: the mock ends with
// "end mock" or "stop the mock".
import { CareerPaths, CareerPrep } from "./router_core.career.js";
import { supabaseCardStore } from "./career_apply_cards.ts";
import { hostEnv, supabaseVoiceLinks, type VoiceLinks } from "./career_voice_link.ts";
// FEATURE 11: posting-bound mocks, grading against the answer key and the posting, weak spots kept and drilled.
import {
  type BoundPosting, debriefTail, drillQuestions, type Fit, fitLine, fitOf, isDrillAsk, isWeakListAsk, judgedFit, mockEvent, type MockPrep,
  pastedJd, postingPlan, requirementsOf, supabaseMockPrep, weakListText, weakSpots, type ModelCall,
} from "./career_mock_prep.ts";

export const MOCK_INTENT = "career_mock"; // the mock asked a question and waits for the answer
export const MOCK_DONE_INTENT = "career_mock_debrief"; // the mock ended; nothing waits
export const MOCK_PAUSED_INTENT = "career_mock_paused"; // the mock is still saved, but the next text is not its answer
export const MOCK_VOICE_INTENT = "career_mock_voice"; // a voice link was sent; the next text is not an answer
export const IDLE_MS = 30 * 60_000;
export const MAX_QUESTIONS = 6;
export const DEFAULT_MINUTES = 20;
const MAX_ANSWER = 2000;
const MAX_VOICE_ANSWER = 6000; // spoken answers run longer than texted ones

export type QKind = "opener" | "behavioral" | "technical" | "company" | "closer";
// FEATURE 11: a question bound to a posting carries the requirement it tests (req), the bank item's key points (keys) and
// the skill name a weak spot is kept under (skill).
export interface MockQuestion { n: number; q: string; kind: QKind; from: string; req?: string[]; keys?: string[]; skill?: string }
export interface Scores { structure: number; evidence: number; specificity: number; total: number }
export interface MockAnswer { n: number; text: string; skipped: boolean; scores: Scores | null; gaps: string[]; fix: string | null; nudge: string; fit?: Fit }
export interface MockState {
  v: 1;
  role: string;
  company: string | null;
  record: { id: string; name: string; as_of: string | null } | null;
  patterns?: { id: string; name: string; checked: string | null; unverified?: string | null } | null; // a firm without a record, from its sourced patterns
  voice?: boolean; // planned for the voice page (WO-035)
  sector: string | null;
  minutes: number;
  started_at: number;
  last_at: number;
  questions: MockQuestion[];
  answers: MockAnswer[];
  status: "running" | "ended";
  ended?: "done" | "time" | "asked" | "idle";
  posting?: BoundPosting | null; // FEATURE 11: the posting on file this mock is bound to
  drill?: boolean; // FEATURE 11: a weak-spot drill
}
export interface Moment { n: number; quote: string; score: number }
export interface Debrief {
  asked: number;
  answered: number;
  skipped: number;
  average: number | null;
  per_question: { n: number; q: string; score: number | null }[];
  strongest: Moment[];
  weakest: Moment[];
  practice: string[];
  text: string;
}

const clean = (x: unknown) => String(x ?? "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
const norm = (x: unknown) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function cut(t: string, max: number): string {
  if (t.length <= max) return t;
  const c = t.slice(0, max), sp = c.lastIndexOf(" ");
  return c.slice(0, sp > max / 2 ? sp : max).replace(/[\s,;:.]+$/, "") + "...";
}
function firstSentence(t: string, max: number): string {
  const s = clean(t), m = s.match(/^.*?(?<!\b(?:[A-Z]|e\.g|i\.e|vs|etc|Inc|Co))[.;](?=\s+[A-Z"(]|\s*$)/);
  return cut((m ? m[0] : s).replace(/[.;]$/, ""), max);
}

// ---------- Company records ----------
// A record matches the name the person gave only exactly (its id, its short name, the short name without "& Co" or
// "Inc"), never by a shared word: "Bain Capital" is not Bain & Company, and "Citadel" is not Citadel Securities.
// Archetypes ("a fintech startup") are not companies and never answer for one.
const NICKNAMES: Record<string, string> = { goldman: "goldman-sachs-ibd", jpm: "jpmorgan-ibd", hrt: "hudson-river-trading" };
export function recordName(cir: any): string {
  return clean(cir?.company_name || cir?.company_id).split(/\s+[—–-]\s+|\s*\(|,/)[0].trim();
}
function recordForms(cir: any): Set<string> {
  const id = String(cir?.company_id ?? ""), short = recordName(cir);
  return new Set([
    norm(id), norm(id.replace(/-ibd$/, "")), norm(short),
    norm(short.replace(/\s*(?:&|and)\s*(?:co\.?|company)$/i, "")),
    norm(short.replace(/\s+(?:inc\.?|llc|technologies|industries|labs)$/i, "")),
  ].filter((x) => x.length >= 2));
}
export function companyRecords(lib?: any[]): any[] {
  const all = lib ?? (CareerPrep.cirLibrary ? CareerPrep.cirLibrary() : []);
  return (all || []).filter((c: any) => c && typeof c === "object" && c.company_id && !String(c.company_id).startsWith("archetype-"));
}
export function findRecord(company: unknown, lib?: any[]): any | null {
  const want = norm(String(company ?? "").replace(/^\s*the\s+/i, "").replace(/[,.]?\s+(?:inc\.?|llc|corp\.?)\s*$/i, ""));
  if (want.length < 2) return null;
  for (const c of companyRecords(lib)) if (NICKNAMES[want] === c.company_id || recordForms(c).has(want)) return c;
  return null;
}

// Where a fact in a record came from, in words: its kind of source, the site, and the date it was checked. A fact with
// no source at all is not used.
export function sourceLabel(cir: any, item: any): string | null {
  const f = item?.fact || item?.basis || item || {};
  const url = String(item?.source_url ?? f.source_url ?? "");
  let type = String(item?.source_type ?? f.source_type ?? "");
  if (!type && url) type = String((cir?.data_sources || []).find((d: any) => d && d.url === url)?.source_type ?? "");
  const t = type.toLowerCase();
  if (/omitted|no official|unsourced/.test(t) || (!t && !url)) return null;
  const kind = /anecdot/.test(t) ? "anecdotal" : /report|third|secondary|aggregator|explainer|press/.test(t) ? "reported"
    : /official|posting|careers|employer|firm/.test(t) ? "official" : /university|public/.test(t) ? "public page" : "source on file";
  let host = "";
  try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  const asOf = String(item?.as_of ?? f.as_of ?? cir?.as_of ?? cir?.last_verified_at ?? "").slice(0, 10);
  return [kind, host, asOf].filter(Boolean).join(", ");
}
interface Fact { text: string; label: string }
function factsOf(cir: any, field: "screening_signals" | "interview_styles"): Fact[] {
  const raw = cir?.[field];
  const list = Array.isArray(raw) ? raw : [...(raw?.stated || []), ...(raw?.revealed || [])];
  const out: Fact[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const text = clean(it.statement || it.claim || it.signal || it.summary || it.text || it.style || it.pattern || it.note || "");
    const label = sourceLabel(cir, it);
    if (text && label) out.push({ text, label });
  }
  return out;
}
function stagesOf(cir: any): Fact[] {
  const ps = cir?.process_stages;
  const raw = Array.isArray(ps) ? ps : (ps?.stages || []);
  const out: Fact[] = [];
  for (const st of raw) {
    const text = clean(typeof st === "string" ? st : (st?.stage || st?.claim || st?.name));
    const label = sourceLabel(cir, typeof st === "string" ? ps?.basis : st);
    if (text && label) out.push({ text: cut(text, 70), label });
  }
  return out;
}
const SKILL = /communicat|ownership|problem[- ]solving|leadership|craft|impact|entrepreneur|collaborat|curio|rigou?r|judg|trade-?offs?|tenaci|teamwork|analytic|test coverage|pull requests?|initiative|write clearly|written communication|values/i;
const LOGISTICS = /\bcap(?:ped)?\b|deadline|applications? (?:every|per)|cover letter|r[ée]sum[ée]|\bcv\b|visa|sponsor|commute|office|days per week|relocat|salary|compensation|\$|\bgpa\b|degree|bachelor|master|graduat|school|class of|education|preferred:|minimum:|at least \d|years? of|timing|rolling|early|location|remote|on-?site|referr|rubric|structured interview/i;
// The one thing a record says the company looks for, usable as a question: a screening signal about a skill first, an
// interview style second, never a logistics fact (an application cap, a degree, an office).
function lookFor(cir: any): (Fact & { field: string }) | null {
  const sig = factsOf(cir, "screening_signals").find((f) => SKILL.test(f.text) && !LOGISTICS.test(f.text));
  if (sig) return { ...sig, field: "signal" };
  const sty = styleOf(cir);
  return sty ? { ...sty, field: "style" } : null;
}
// How the record says they interview, when it says something usable: a description of the interview itself, not a
// pointer ("Per BCG's case page"), a hedge ("Candidate reports only") or a logistics fact.
const STYLE_SKIP = /^(?:per |candidate reports only|documented sequence)|\bcap(?:ped)?\b|deadline|applications? (?:every|per)|salary|compensation|\$|visa|sponsor|office|commute|timing|rolling/i;
function styleOf(cir: any): Fact | null {
  return factsOf(cir, "interview_styles").find((f) => f.text.split(" ").length >= 10 && !STYLE_SKIP.test(f.text)) || null;
}
// Every sourced fact a record holds about how the company hires and interviews, with the record field it came from: what
// the voice interviewer may say about the company, and nothing else (WO-035).
export function recordFacts(cir: any, max = 8): { field: string; text: string; label: string }[] {
  const out: { field: string; text: string; label: string }[] = [];
  for (const f of factsOf(cir, "interview_styles")) out.push({ field: "interview_styles", ...f });
  for (const f of stagesOf(cir)) out.push({ field: "process_stages", ...f });
  for (const f of factsOf(cir, "screening_signals").filter((x) => !LOGISTICS.test(x.text))) out.push({ field: "screening_signals", ...f });
  return out.filter((f) => !STYLE_SKIP.test(f.text)).map((f) => ({ ...f, text: cut(f.text, 240) })).slice(0, max);
}
// "Stripe's", "Goldman Sachs'".
export const possessive = (name: string) => /s$/i.test(name) ? `${name}'` : `${name}'s`;

// ---------- The 50 firms' interview patterns (WO-035) ----------
// packages/career-data/interview-patterns.json through 127's interviewPatterns(). A firm with a full record answers
// from the record (findRecord above); the rest carry their own patterns, each with its public URL, source type and the
// date it was checked. A firm question is used only when a source attributes it to that firm. Matching is exact, as
// for records: the firm's id, name or a listed alias, never a shared word ("Citadel" is not Citadel Securities).
export interface FirmPattern { text: string; source_url: string; source_type: string; checked: string; note?: string }
export interface FirmQuestion { q: string; source_url: string; source_type: string; checked: string }
export interface Firm { id: string; name: string; aliases: string[]; sector: string; record: string | null; checked: string; patterns: FirmPattern[]; questions: FirmQuestion[] }
export function firms(lib?: Firm[]): Firm[] {
  return lib ?? ((CareerPrep.interviewPatterns ? CareerPrep.interviewPatterns().firms : []) || []);
}
function firmForms(f: Firm): Set<string> {
  const name = clean(f.name);
  return new Set([norm(f.id), norm(name), norm(name.replace(/\s*(?:&|and)\s*(?:co\.?|company)$/i, "")),
    norm(name.replace(/\s+(?:inc\.?|llc|partners|trading|group)$/i, "")), ...(f.aliases || []).map(norm)].filter((x) => x.length >= 2));
}
export function findFirm(company: unknown, lib?: Firm[]): Firm | null {
  const want = norm(String(company ?? "").replace(/^\s*the\s+/i, "").replace(/[,.]?\s+(?:inc\.?|llc|corp\.?)\s*$/i, ""));
  if (want.length < 2) return null;
  for (const f of firms(lib)) if (f && f.id && firmForms(f).has(want)) return f;
  return null;
}
// "official, metacareers.com, 2026-10-19": the same shape as a record's source label. A pattern with no URL is never used.
export function patternLabel(p: { source_url?: string; source_type?: string; checked?: string } | null | undefined): string | null {
  const url = String(p?.source_url ?? "");
  if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(url)) return null;
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  const t = String(p?.source_type ?? "").toLowerCase();
  const kind = /anecdot/.test(t) ? "anecdotal" : /posting/.test(t) ? "posting" : /official/.test(t) ? "official" : "reported";
  return [kind, host, String(p?.checked ?? "").slice(0, 10)].filter(Boolean).join(", ");
}
const RANK: Record<string, number> = { official: 0, posting: 1, reported: 2, anecdotal: 3 };
// What is wrong with a patterns file, one line per problem (none for the file on disk): every firm checked on a date,
// every firm without a record carrying at least one pattern, and every pattern and every firm question citing a public
// https URL, its source type and the date it was checked.
export function patternProblems(data: any, recordIds: Set<string>): string[] {
  const out: string[] = [];
  const day = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const src = (x: any, at: string) => {
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(String(x?.source_url ?? ""))) out.push(`${at}: no public https source_url`);
    if (!Object.prototype.hasOwnProperty.call(RANK, String(x?.source_type ?? ""))) out.push(`${at}: source_type must be official, posting, reported or anecdotal`);
    if (!day(x?.checked)) out.push(`${at}: no checked date`);
  };
  const list = Array.isArray(data?.firms) ? data.firms : null;
  if (!list) return ["no firms list"];
  const seen = new Set<string>();
  for (const f of list) {
    const id = String(f?.id ?? "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { out.push(`firm "${id}": bad id`); continue; }
    if (seen.has(id)) out.push(`${id}: listed twice`);
    seen.add(id);
    if (!clean(f.name)) out.push(`${id}: no name`);
    if (!day(f.checked)) out.push(`${id}: no checked date`);
    if (f.record !== null && !recordIds.has(String(f.record))) out.push(`${id}: record ${f.record} is not on file`);
    if (f.record === null && !(f.patterns || []).length) out.push(`${id}: no record and no sourced pattern`);
    (f.patterns || []).forEach((p: any, i: number) => { if (!clean(p?.text)) out.push(`${id}.patterns[${i}]: no text`); src(p, `${id}.patterns[${i}]`); });
    (f.questions || []).forEach((q: any, i: number) => { if (!clean(q?.q)) out.push(`${id}.questions[${i}]: no question`); src(q, `${id}.questions[${i}]`); });
  }
  return out;
}
// WO-041: what the last source check (packages/career-data/source-checks.json, through 134 sourceStatus) says about a
// pattern's page. A page the check found gone (404 or 410) is never quoted. A page no check has opened, or one that
// refused or failed the check, is quoted only with that said: its text is a search summary nobody has read on the page.
export interface SourceStatus { status: string; verified: boolean; checked: string | null }
export function sourceOf(p: { source_url?: string } | null | undefined, checks?: unknown): SourceStatus {
  return (CareerPaths as any).sourceStatus(String(p?.source_url ?? ""), checks);
}
export function unverifiedNote(src: SourceStatus): string | null {
  if (src.verified || src.status === "gone") return null;
  if (src.status === "unverified") return "Unverified: a search summary of that page; no source check has opened the page yet.";
  return `Unverified: the page could not be opened at the ${src.checked} source check (${src.status}).`;
}
// The pattern to build a question from: a firm-attributed question first, then the firm's own pages, then reports;
// within each, a page the check opened before one it did not. Gone pages are left out.
function firmPrompt(f: Firm, checks?: unknown): { text: string; label: string; asked: boolean; note: string | null } | null {
  for (const q of f.questions || []) {
    const label = patternLabel(q), src = sourceOf(q, checks);
    if (label && clean(q.q) && src.status !== "gone") return { text: clean(q.q), label, asked: true, note: unverifiedNote(src) };
  }
  const ps = (f.patterns || []).map((p) => ({ p, label: patternLabel(p), src: sourceOf(p, checks) })).filter((x) => x.label && clean(x.p.text) && x.src.status !== "gone");
  ps.sort((a, b) => (RANK[a.label!.split(",")[0]] ?? 9) - (RANK[b.label!.split(",")[0]] ?? 9) || Number(b.src.verified) - Number(a.src.verified));
  return ps.length ? { text: clean(ps[0].p.text), label: ps[0].label!, asked: false, note: unverifiedNote(ps[0].src) } : null;
}

// ---------- The plan of questions ----------
const TECH_SOURCES = new Set(["swe_coding_bank", "finance_drill_bank", "quant_drill_bank", "pm_drill_bank"]);
const SKIP_SECTION = /behavio|fit|personal|why|r[ée]sum|questions the candidate|format|expectation|bookshelf|canon|sample cases|published by/i;
const SKIP_ITEM = /book canon|bookshelf|skill cluster|scored skill|^competencies|^online assessment|\bdrill$/i;
const ASKS = /\?$|^(?:walk|tell|describe|design|how|what|why|explain|estimate|make|given|pick|build|define|diagnose|compare|price|interpret|reverse|quote|mental|your)\b/i;
// A bank item that names a company stays out of the mock: a company pattern comes only from that company's record.
const NAMED = /\b(?:meta|facebook|twitter|uber|snapchat|linkedin|intuit|apple|netflix|faang|amazon|google|microsoft|mckinsey|bain|bcg|goldman|jpmorgan|morgan stanley|citadel|jane street)\b/i;
// A bank item as a question: as written when it already asks something, otherwise as a topic to talk through.
function askable(row: any): { q: string; asks: boolean } | null {
  const t = clean(row?.q).replace(/\s*\([^)]*\)/g, "").replace(/^"|"$/g, "").replace(/\s+([.?,])/g, "$1").trim();
  if (!t || t.split(" ").length < 2 || SKIP_ITEM.test(t) || NAMED.test(t)) return null;
  if (ASKS.test(t)) return { q: /[.?!]$/.test(t) ? t : `${t}.`, asks: true };
  return { q: `Talk me through how you would handle this: ${t.replace(/[.]$/, "")}.`, asks: false };
}
// The role's technical questions: the inline drill sets first, then bank items that already ask something; topics to
// talk through only when fewer than two real questions exist.
function technicalPool(role: string): { q: string; group: string; from: string }[] {
  if (!role) return [];
  const bank = CareerPrep.questionBank({ role, roleFamily: role });
  const sector = bank.interview_bank?.sector ?? null;
  const out: { q: string; group: string; from: string }[] = [], topics: typeof out = [];
  for (const row of bank.questions || []) {
    const type = String(row?.source?.type ?? "");
    if (TECH_SOURCES.has(type)) {
      if (NAMED.test(String(row.q))) continue;
      out.push({ q: clean(row.q), group: String(row.round || type), from: `${type.replace(/_bank$/, "").replace(/_/g, " ")} set` });
    } else if (sector && type === `interview_bank_${sector}`) {
      const section = String(row?.source?.section ?? "");
      if (SKIP_SECTION.test(section)) continue;
      const a = askable(row);
      if (!a || out.concat(topics).some((x) => norm(x.q) === norm(a.q))) continue;
      (a.asks ? out : topics).push({ q: a.q, group: section, from: `${sector.replace(/_/g, " ")} question bank` });
    }
  }
  return out.length >= 2 ? out : out.concat(topics);
}
export function sectorOf(role: string): string | null {
  return role ? (CareerPrep.bankSectorFor({ role, roleFamily: role }) ?? null) : null;
}
export function questionCount(minutes: number): number {
  return Math.max(2, Math.min(MAX_QUESTIONS, Math.round(minutes / 3.5)));
}

export function plan(o: { role: string; company: string | null; cir: any | null; minutes: number; seed: number; firm?: Firm | null; checks?: unknown }): MockQuestion[] {
  const gen: string[] = CareerPrep.GENERIC_BEHAVIORAL;
  const seed = Math.abs(Math.floor(o.seed)) || 0;
  const beh = [gen[1], gen[2], gen[3]];
  const rot = beh.slice(seed % 3).concat(beh.slice(0, seed % 3));
  const tech = technicalPool(o.role);
  let t1: typeof tech[number] | null = null, t2: typeof tech[number] | null = null;
  if (tech.length) {
    const i = seed % tech.length;
    t1 = tech[i];
    for (let k = 1; k < tech.length && !t2; k++) { const c = tech[(i + k) % tech.length]; if (c.group !== t1.group) t2 = c; }
    if (!t2 && tech.length > 1) t2 = tech[(i + 1) % tech.length];
  }
  const firm = o.cir ? null : (o.firm ?? null);
  const name = o.cir ? recordName(o.cir) : firm ? clean(firm.name) : (o.company ? cut(clean(o.company), 60) : null);
  const look = o.cir ? lookFor(o.cir) : null;
  // A firm without a record: its own sourced pattern (or a question a source attributes to it), quoted with its label.
  const fp = firm ? firmPrompt(firm, o.checks) : null;
  const unverified = fp?.note ? ` ${fp.note}` : "";
  const companyQ = look
    ? `${possessive(name!)} record says (${look.label}): "${firstSentence(look.text, 150)}". ${look.field === "signal" ? "Tell me about a time you showed that." : "Pick the part of that you know best and walk me through a real example of it."}`
    : fp
    ? (fp.asked
      ? `A question reported from ${possessive(name!)} interviews (${fp.label}): "${firstSentence(fp.text, 200)}"${unverified}`
      : `What is on file about ${possessive(name!)} interviews (${fp.label}): "${firstSentence(fp.text, 150)}".${unverified} How would you prepare for that, and which example of your own would you bring?`)
    : null;
  const companyFrom = look ? `${possessive(name!)} record (${look.label})` : fp ? `${possessive(name!)} interview patterns (${fp.label})` : "";
  type Slot = { pri: number; pos: number; q: string; kind: QKind; from: string };
  const slots: Slot[] = [
    { pri: 0, pos: 0, q: gen[0], kind: "opener", from: "general behavioral" },
    { pri: 3, pos: 1, q: rot[0], kind: "behavioral", from: "general behavioral" },
    { pri: 6, pos: 4.5, q: rot[1], kind: "behavioral", from: "general behavioral" },
    { pri: 7, pos: 4.6, q: rot[2], kind: "behavioral", from: "general behavioral" },
  ];
  if (t1) slots.push({ pri: 1, pos: 2, q: t1.q, kind: "technical", from: t1.from });
  if (t2) slots.push({ pri: 5, pos: 4, q: t2.q, kind: "technical", from: t2.from });
  if (companyQ) slots.push({ pri: 2, pos: 3, q: companyQ, kind: "company", from: companyFrom });
  if (name) slots.push({ pri: 4, pos: 5, q: `Why ${name}, specifically?`, kind: "closer", from: "general behavioral" });
  return slots.sort((a, b) => a.pri - b.pri).slice(0, questionCount(o.minutes)).sort((a, b) => a.pos - b.pos)
    .map((s, i) => ({ n: i + 1, q: s.q, kind: s.kind, from: s.from }));
}

// ---------- The session ----------
const ask = (s: MockState, i: number) => `Q${i + 1} of ${s.questions.length}: ${s.questions[i].q}`;
export function idle(s: MockState, now: number): boolean {
  return now - s.last_at > IDLE_MS;
}

export function start(o: { role?: string | null; company?: string | null; minutes?: number; now: number; cir?: any | null; lib?: any[]; firm?: Firm | null; firms?: Firm[]; checks?: unknown }): { state: MockState; reply: string } {
  const role = cut(clean(o.role), 80), company = o.company ? cut(clean(o.company), 80) : null;
  const minutes = Math.max(5, Math.min(30, Math.round(Number(o.minutes) || DEFAULT_MINUTES)));
  const cir = o.cir !== undefined ? o.cir : (company ? findRecord(company, o.lib) : null);
  // No record: a firm among the 50 still has its sourced patterns (never a firm whose record exists; that is the record).
  const found = cir ? null : (o.firm !== undefined ? o.firm : (company ? findFirm(company, o.firms) : null));
  const fp = found && !found.record ? firmPrompt(found, o.checks) : null;
  const firm = fp ? found : null;
  const sector = sectorOf(role);
  const questions = plan({ role, company, cir, minutes, seed: Math.floor(o.now / 60_000), firm, checks: o.checks });
  const state: MockState = {
    v: 1, role, company: cir ? recordName(cir) : firm ? clean(firm.name) : company,
    record: cir ? { id: String(cir.company_id), name: recordName(cir), as_of: String(cir.as_of || cir.last_verified_at || "").slice(0, 10) || null } : null,
    patterns: firm ? { id: firm.id, name: clean(firm.name), checked: String(firm.checked || "").slice(0, 10) || null, unverified: fp?.note ?? null } : null,
    sector, minutes, started_at: o.now, last_at: o.now, questions, answers: [], status: "running",
  };
  const what = `${role || "general"} mock${state.company ? ` for ${state.company}` : ""}`;
  const lines = [
    `Mock interview: ${what}. About ${minutes} minutes, ${questions.length} questions, by text (voice comes later). Each answer gets a score out of 15 for structure, evidence and detail, and you get a debrief at the end. Text "end mock" any time.`,
  ];
  const fromRecord = questions.find((q) => q.kind === "company");
  if (fromRecord && state.record) lines.push(`Q${fromRecord.n} comes from ${possessive(state.record.name)} record on file.`);
  else if (fromRecord && state.patterns) lines.push(`Q${fromRecord.n} comes from sourced notes on how ${state.patterns.name} interviews (checked ${state.patterns.checked}).${state.patterns.unverified ? ` ${state.patterns.unverified}` : ""}`);
  else if (state.record) lines.push(`${possessive(state.record.name)} record on file has nothing to build a question from, so these are role questions.`);
  else if (company) lines.push(`No record for ${company} on file, so nothing here is about how they interview.`);
  if (!role) lines.push(`No role named, so these are general questions. Try "mock me for data analyst at Stripe" for a role mock.`);
  else if (!sector) lines.push(`No question bank for ${role} yet, so these are general questions.`);
  lines.push("", ask(state, 0));
  return { state, reply: lines.join("\n") };
}

// 127's rubric (structure, evidence, specificity, 0-5 each; total 0-15), typed for this file.
interface Graded { scores: Scores; gaps: string[]; fix_first: string | null; missing_result_metric: boolean; judgment?: any; variant?: any }
const graded = (answer: string): Graded => CareerPrep.scoreAnswer(answer) as unknown as Graded;

function nudgeFor(g: any): string {
  const gaps: string[] = g?.gaps || [];
  if (gaps.some((x) => x.startsWith("domain_error"))) return "One fact in that answer looks wrong. Check it before the real thing.";
  if (g?.judgment?.missing_judgment) return "Make a call: say what you would decide and why.";
  if (g?.variant) return "Good if you can do it fresh. Try a new version without notes.";
  if (g?.scores?.total >= 12) return "Strong. Keep that one.";
  if (g?.missing_result_metric) return "Add a number: how big the result was, and how you know it.";
  if (g?.fix_first === "structure") return "Put it in order: the situation, what you did, then the result.";
  if (g?.fix_first === "specificity") return "Name the tool, the limit you worked under, and your exact part.";
  return "Add a number and how you know it.";
}

// One answer (or a skip, when text is null): scored, a one-line nudge, then the next question or, after the last one or
// past the time, the debrief.
export function next(s0: MockState, text: string | null, now: number): { state: MockState; reply: string; done: boolean; head: string; rest: string } {
  const s: MockState = structuredClone(s0);
  if (s.status !== "running") throw new Error("the mock is not running");
  const i = s.answers.length;
  if (!s.questions[i]) throw new Error("the mock has no question waiting");
  let head: string;
  if (text === null) {
    s.answers.push({ n: i + 1, text: "", skipped: true, scores: null, gaps: [], fix: null, nudge: "Skipped." });
    head = "Skipped.";
  } else {
    const answer = String(text).trim().slice(0, MAX_ANSWER);
    const g = graded(answer);
    const nudge = nudgeFor(g);
    s.answers.push({ n: i + 1, text: answer, skipped: false, scores: g.scores, gaps: g.gaps || [], fix: g.fix_first ?? null, nudge });
    head = `${g.scores.total} of 15. ${nudge}`;
  }
  s.last_at = now;
  if (s.answers.length >= s.questions.length) { const e = end(s, now, "done"); return { state: e.state, reply: `${head}\n\n${e.reply}`, done: true, head, rest: e.reply }; }
  if (now - s.started_at >= s.minutes * 60_000) { const e = end(s, now, "time"); return { state: e.state, reply: `${head}\n\n${e.reply}`, done: true, head, rest: e.reply }; }
  const rest = ask(s, s.answers.length);
  return { state: s, reply: `${head}\n\n${rest}`, done: false, head, rest };
}

// The sentence of an answer that scores best (or worst) on the same rubric, in the person's own words.
function quoteFrom(answer: string, best: boolean): string {
  const parts = answer.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  let pick = parts[0] ?? answer, at = best ? -1 : 99;
  for (const p of parts) {
    const t = graded(p).scores.total;
    if (best ? t > at : t < at) { at = t; pick = p; }
  }
  return cut(pick, 110);
}
const PRACTICE_DIM: Record<string, string> = {
  evidence: "Write the result number for 3 of your stories (people, time, money or a percent) and how you know it.",
  specificity: "Rewrite one answer naming the tool, the deadline and your exact part.",
  structure: "Tell 3 stories in this order, 90 seconds each: the situation, what you did, the result.",
};

export function debrief(s: MockState): Debrief {
  const scored = s.answers.filter((a) => !a.skipped && a.scores);
  const per_question = s.questions.map((q) => {
    const a = s.answers.find((x) => x.n === q.n);
    return { n: q.n, q: q.q, score: a && a.scores ? a.scores.total : null };
  });
  const skipped = s.answers.filter((a) => a.skipped).length;
  const what = `${s.role || "general"} ${s.voice ? "voice mock" : "mock"}${s.company ? ` for ${s.company}` : ""}`;
  const why = s.ended === "time" ? `Time is up (${s.minutes} minutes). ` : s.ended === "idle" ? "The mock stopped after 30 minutes with no reply. " : "";
  if (!scored.length) {
    const text = `${why}Debrief, ${what}: no answers to score, so there is nothing to grade. Text "start a mock interview" to try again.`;
    return { asked: s.questions.length, answered: 0, skipped, average: null, per_question, strongest: [], weakest: [], practice: [], text };
  }
  const total = (a: MockAnswer) => a.scores!.total;
  const avg = Math.round((scored.reduce((n, a) => n + total(a), 0) / scored.length) * 10) / 10;
  const ranked = [...scored].sort((a, b) => (total(b) - total(a)) || (a.n - b.n));
  const nStrong = Math.min(2, Math.ceil(ranked.length / 2)), nWeak = Math.min(2, ranked.length - nStrong);
  const strongest = ranked.slice(0, nStrong).map((a) => ({ n: a.n, quote: quoteFrom(a.text, true), score: total(a) }));
  const weakest = ranked.slice(ranked.length - nWeak).reverse().map((a) => ({ n: a.n, quote: quoteFrom(a.text, false), score: total(a) }));

  const practice: string[] = [];
  const low = ranked[ranked.length - 1];
  const lowQ = s.questions.find((q) => q.n === low.n)!;
  practice.push(`Redo Q${low.n} out loud in 2 minutes: ${cut(lowQ.q, 90)} ${nudgeFor({ scores: low.scores, gaps: low.gaps, fix_first: low.fix, missing_result_metric: low.gaps.includes("missing_result_metric") })}`);
  const dims = ["evidence", "specificity", "structure"] as const;
  const mean = (d: typeof dims[number]) => scored.reduce((n, a) => n + (a.scores as any)[d], 0) / scored.length;
  const wrong = scored.find((a) => a.gaps.some((x) => x.startsWith("domain_error")));
  const noCall = scored.some((a) => a.gaps.includes("missing_judgment"));
  if (wrong) practice.push(`Check the facts in Q${wrong.n} against a guide you trust before the real interview.`);
  else if (noCall) practice.push("In case and design answers, end with a decision: what you would do, why, and what would change your mind.");
  else {
    const weakDim = [...dims].sort((a, b) => mean(a) - mean(b))[0];
    practice.push(mean(weakDim) >= 4
      ? `Keep Q${ranked[0].n} as your go-to story and say it once a day this week.`
      : PRACTICE_DIM[weakDim]);
  }
  const rec = s.record ? companyRecords().find((c) => String(c.company_id) === s.record!.id) : null;
  const steps = rec ? stagesOf(rec).slice(0, 3).map((x) => x.text) : [];
  if (s.record && steps.length) practice.push(`Before ${s.record.name}, practice for each step on their record: ${steps.join("; ")}.`);
  else if (s.company && s.patterns) practice.push(`Ask your recruiter what the ${s.company} rounds are; the notes on file about ${s.company} are general, not a list of their rounds.`);
  else if (s.company && !s.record) practice.push(`Ask your recruiter what the ${s.company} rounds are; there is no record of them here.`);
  else if (s.sector) practice.push(`Do 3 more ${s.sector.replace(/_/g, " ")} questions: text "mock me for ${s.role}${s.company ? ` at ${s.company}` : ""}".`);
  else practice.push(`Do another mock in 2 days and beat today's average of ${avg}.`);

  const scoreLine = per_question.filter((p) => p.n <= s.answers.length || p.score !== null)
    .map((p) => `Q${p.n} ${p.score === null ? "skipped" : p.score}`).join(", ");
  const text = [
    `${why}Debrief, ${what}: ${scored.length} of ${s.questions.length} answered${skipped ? `, ${skipped} skipped` : ""}. Average ${avg} of 15 (a practice score, not a hiring prediction).`,
    `Scores out of 15: ${scoreLine}.`,
    `Strongest: ${strongest.map((m) => `Q${m.n} "${m.quote}"`).join(" ")}`,
    ...(weakest.length ? [`Weakest: ${weakest.map((m) => `Q${m.n} "${m.quote}"`).join(" ")}`] : []),
    "Practice next:",
    ...practice.slice(0, 3).map((p, i) => `${i + 1}. ${p}`),
  ].join("\n");
  return { asked: s.questions.length, answered: scored.length, skipped, average: avg, per_question, strongest, weakest, practice: practice.slice(0, 3), text };
}

export function end(s0: MockState, now: number, why: "done" | "time" | "asked" | "idle"): { state: MockState; reply: string; debrief: Debrief } {
  const s: MockState = { ...structuredClone(s0), status: "ended", ended: why };
  if (why !== "idle") s.last_at = now;
  const d = debrief(s);
  return { state: s, reply: d.text, debrief: d };
}

// ---------- The text that drives it ----------
export type MockCommand =
  | { kind: "start"; role: string; company: string | null; minutes: number }
  | { kind: "voice"; role: string; company: string | null; minutes: number }
  | { kind: "end" }
  | { kind: "done" }
  | { kind: "resume" }
  | { kind: "skip" };
export const CARRIER = /^(?:stop|stopall|unsubscribe|cancel|end|quit|help|info|start|unstop)$/i;
const START = /^(?:(?:can|could) you |please |let'?s |lets |i (?:want|would like|'d like) to )*(?:(?:start|begin|run|do|give me|try)(?: me)?(?: a| an| my| another| one)?(?: (\d{1,2})[- ]?min(?:ute)?s?)? (?:mock|practice)(?: interview)?|mock interview|mock me)\b(.*)$/i;

export function parseMockCommand(text: string): MockCommand | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  const low = t.toLowerCase();
  if (!low || CARRIER.test(low)) return null;
  if (/^(?:please )?(?:end|stop|finish|quit|cancel|close)(?: the| my| this)? mock(?: interview)?(?: now)?(?: please)?$|^(?:end|finish) (?:the |my |this )?(?:practice |mock )?interview$|^mock (?:is )?(?:over|done)$/.test(low)) return { kind: "end" };
  if (/^(?:done|i'?m done|im done|that'?s all|that is all)$/.test(low)) return { kind: "done" };
  if (/^(?:resume|continue|back to)(?: the| my)? mock(?: interview)?$/.test(low)) return { kind: "resume" };
  if (/^(?:skip|pass|next question|skip (?:this|that)(?: one| question)?)$/.test(low)) return { kind: "skip" };
  // WO-035: "start a voice mock for Goldman IB", "voice mock me for data analyst at Stripe", "a mock interview by voice":
  // the same words as a text mock, with "voice" in them, ask for the voice page instead.
  let voice = false, said = t;
  if (/\bvoice[- ](?:mock|practice|interview)\b/i.test(said)) {
    voice = true;
    said = said.replace(/\bvoice[- ](mock|practice)\b/i, "$1").replace(/\bvoice[- ]interview\b/i, "mock interview");
  } else if (/\b(?:mock|practice)(?: interview)? (?:by|over|with|on) voice\b/i.test(said)) {
    voice = true;
    said = said.replace(/ (?:by|over|with|on) voice\b/i, "");
  }
  const m = said.match(START);
  if (!m) return null;
  const minutes = m[1] ? Number(m[1]) : DEFAULT_MINUTES;
  const rest = m[2].trim().replace(/^(?:me|now)\b\s*/i, "").replace(/,?\s*please$/i, "").trim();
  let role = "", company: string | null = null;
  if (rest) {
    const at = rest.match(/^at\s+(.+)$/i), fr = rest.match(/^(?:for|as)\s+(.+)$/i);
    if (at) company = at[1];
    else if (fr) {
      const i = fr[1].toLowerCase().lastIndexOf(" at ");
      if (i >= 0) { role = fr[1].slice(0, i); company = fr[1].slice(i + 4); } else role = fr[1];
    } else return null; // "mock interview tips" is a question about mocks, not a start
  }
  role = clean(role).replace(/^(?:an?|the|my)\s+/i, "").replace(/\s+(?:role|position|job|interview)s?$/i, "").trim();
  company = company ? clean(company).replace(/\s+interviews?$/i, "").trim() || null : null;
  if (role.length > 80 || (company && company.length > 80)) return null;
  const known = (x: string) => !!(findRecord(x) || findFirm(x));
  // "mock me for Stripe": a company on file named alone is the company, not the role.
  if (role && !company && known(role)) { company = role; role = ""; }
  // "for Goldman IB", "for Stripe data analyst": a company on file named first, then the role.
  if (role && !company) {
    const w = role.split(" ");
    for (let k = w.length - 1; k >= 1; k--) {
      const head = w.slice(0, k).join(" ");
      if (known(head)) { company = head; role = w.slice(k).join(" "); break; }
    }
  }
  return { kind: voice ? "voice" : "start", role, company, minutes };
}

// The person says they are in a real interview right now: never help during one (D-015), never score it as practice.
const LIVE = /\b(?:i'?m|i am|im) (?:in|on) (?:an?|my|the) (?:real |actual |live )?interview\b|\b(?:real|actual|live) interview\b.*\b(?:now|right now|currently)\b|\binterviewer (?:just )?(?:asked|is asking)\b/i;
const MOCK_EXIT = /^(?:please )?(?:exit|leave|quit|stop|end|cancel)(?: (?:the|this|my))?(?: mock| interview| practice| mock interview| practice interview)(?: now)?(?: please)?$|^(?:exit|leave)$/i;
// Not an answer to an interview question: a platform command, a greeting or "help", or another task named up front.
export function notAnAnswer(text: string): boolean {
  const t = String(text ?? "").trim();
  return /^\//.test(t) ||
    /^(?:hi|hello|hey|hiya|yo|good (?:morning|afternoon|evening)|help|menu|main menu|start over|restart|never ?mind|nvm|what can you do|what do you do)\b[^.?!]{0,30}[.?!]*$/i.test(t) ||
    /^(?:(?:can you|could you|please|now|ok(?:ay)?|so)[\s,]+)*(?:find|show|search|list|look for|get me|pull up|apply|queue|upload)\b/i.test(t) ||
    /^(?:what'?s|what is|where'?s|where is|how'?s|how is|how are)\s+my\b/i.test(t) ||
    /^here'?s my (?:resume|cv)\b/i.test(t);
}
// This hook runs before the router's own goal capture. A new, own career target is a task switch, not an answer
// to the saved interview question. Keep answer labels, questions, quotes and hypotheticals in their current frame.
function ownsNewCareerTarget(text: string): boolean {
  if (/^\s*(?:my answer|answer|my response|here'?s my answer|here is my answer)\s*:/i.test(text)) return false;
  const own = text.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, "");
  return own.split(/(?<=[.!?])\s+|[\r\n]+/).some((sentence) => {
    const clause = sentence.trim().replace(/^(?:actually|also|and|by the way)[,:]?\s+/i, "");
    if (/[?]/.test(clause)) return false;
    if (/^my\s+(?:career\s+)?goal\s+is\s+[^.!?]+[.!]?$/i.test(clause)) return true;
    const m = clause.match(/^(?:I\s+want\s+|I(?:'m|\s+am)\s+aiming\s+for\s+)([^.!?]+)[.!]?$/i);
    return !!m && m[1].length <= 200 &&
      /\b(?:jobs?|roles?|positions?|internships?|apprenticeships?|fellowships?)\b/i.test(m[1]) &&
      !/\b(?:you\s+to|answers?|questions?|mock|practice|rehears(?:e|al)|drafts?|resumes?|cover letters?)\b/i.test(m[1]);
  });
}
const LIVE_REFUSAL ="I can't help during a real interview; that is off by decision. When it ends, text me and we'll go over how it went. Your practice mock is saved: text \"resume mock\" to pick it up later.";

export interface MockStore {
  get(userId: string, threadId: string): Promise<MockState | null>;
  save(userId: string, threadId: string, s: MockState): Promise<void>;
  clear(userId: string, threadId: string): Promise<void>;
  lastAssistantIntent(threadId: string): Promise<string | null>;
  voice?: VoiceLinks; // WO-035: single-use links to the voice page; absent where no voice rail exists
  prep?: MockPrep; // FEATURE 11: the posting on file, the mock history and the judge; absent, the mock runs as WO-025 built it
}

// ---------- The voice mock (WO-035) ----------
const mockName = (s: MockState) => `${s.role || "general"} mock${s.company ? ` for ${s.company}` : ""}`;
const textAsk = (s: MockState) => `mock me for ${s.role || "this role"}${s.company ? ` at ${s.company}` : ""}`;
export const VOICE_LIMIT_REPLY = "You have started 5 voice mocks in the last day, which is the limit. The text mock has no limit: text \"start a mock interview\".";
// The link alone on its own line; every other line plain text that reads the same on iMessage, WhatsApp and Telegram.
export function voiceStartText(s: MockState, url: string): string {
  const lines = [
    `Voice mock: ${mockName(s)}. About ${s.minutes} minutes, ${s.questions.length} questions, out loud. Open this link within 10 minutes. It works once, and only for you:`,
    url,
    "Allow the microphone when your browser asks. Audio is never stored: only the words of the call are scored, and your debrief comes back here within 2 minutes of hanging up.",
  ];
  const fromRecord = s.questions.find((q) => q.kind === "company");
  if (fromRecord && s.record) lines.push(`Q${fromRecord.n} comes from ${possessive(s.record.name)} record on file.`);
  else if (fromRecord && s.patterns) lines.push(`Q${fromRecord.n} comes from sourced notes on how ${s.patterns.name} interviews (checked ${s.patterns.checked}).${s.patterns.unverified ? ` ${s.patterns.unverified}` : ""}`);
  else if (s.company && !s.record) lines.push(`No record for ${s.company} on file, so nothing in the call is about how they interview.`);
  return lines.join("\n");
}
export function voiceOffText(s: MockState): string {
  return `Voice mocks aren't on yet, so there is no call to join. The text mock works now: text "${textAsk(s)}".`;
}

export interface Turn { who: "interviewer" | "candidate"; text: string }
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const contentWords = (x: string) => new Set(norm(x) ? x.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 4) : []);
// Which planned question each candidate turn answers. The interviewer is told to say "Question N." before each planned
// question (career_voice.ts); without that, an interviewer turn that shares most of its words with a planned question
// counts as asking it. The count only moves forward. Candidate words before the first question are small talk.
export function answersFromTranscript(questions: MockQuestion[], turns: Turn[]): { answers: Map<number, string>; reached: number } {
  const answers = new Map<number, string>();
  let current = 0;
  for (const t of turns) {
    const text = clean(t.text);
    if (!text) continue;
    if (t.who === "interviewer") {
      const m = text.match(/\bquestion\s+(\d|one|two|three|four|five|six)\b/i);
      let n = m ? (NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])) : 0;
      if (!n) {
        const said = contentWords(text);
        for (const q of questions) {
          const want = contentWords(q.q);
          if (!want.size || q.n <= current) continue;
          let hit = 0;
          for (const w of want) if (said.has(w)) hit++;
          if (hit / want.size >= 0.6) { n = q.n; break; }
        }
      }
      if (n > current && n <= questions.length) current = n;
      continue;
    }
    if (!current || LIVE.test(text)) continue; // never score words said about a real interview (D-015)
    answers.set(current, answers.has(current) ? `${answers.get(current)} ${text}` : text);
  }
  return { answers, reached: current };
}

// The debrief of a voice call: each planned question the call reached is scored with the same rubric as the text mock,
// over the person's own words only (the candidate's side of the transcript); the interviewer's words are never scored
// or quoted. Questions the call never reached are left out, not marked skipped.
export function voiceDebrief(s0: MockState, turns: Turn[], now: number): { state: MockState; reply: string; debrief: Debrief; reached: number } {
  const s: MockState = { ...structuredClone(s0), voice: true, answers: [], status: "running" };
  const { answers, reached } = answersFromTranscript(s.questions, turns);
  for (let n = 1; n <= reached; n++) {
    const said = answers.get(n);
    if (!said) { s.answers.push({ n, text: "", skipped: true, scores: null, gaps: [], fix: null, nudge: "Skipped." }); continue; }
    const answer = said.slice(0, MAX_VOICE_ANSWER);
    const g = graded(answer);
    s.answers.push({ n, text: answer, skipped: false, scores: g.scores, gaps: g.gaps || [], fix: g.fix_first ?? null, nudge: nudgeFor(g) });
  }
  const e = end(s, now, reached >= s.questions.length ? "done" : "asked");
  return { state: e.state, reply: e.reply, debrief: e.debrief, reached };
}

// ---------- FEATURE 11: the posting, the key, the weak spots ----------
type TurnIn = { message: string; userId: string; threadId: string; now: number; store: MockStore };
type TurnOut = { reply: string; status: string; intent: string };
const SOURCE_WORDS: Record<string, string> = { application: "on your applications", search: "from your last search", pasted: "you pasted" };
// A mock bound to the posting on file for this company and role, or null when there is none (or it names no skill this
// code can test), so the role mock runs as before.
async function boundStart(o: TurnIn, prep: MockPrep, a: { role: string; company: string | null; minutes: number }, pasted: { title: string; company: string; text: string } | null): Promise<{ state: MockState; reply: string } | null> {
  let found: Awaited<ReturnType<MockPrep["posting"]>> = null;
  if (pasted) found = { ...pasted, job_id: null, url: null, source: "pasted" };
  else if (a.role || a.company) {
    try { found = await prep.posting(o.userId, o.threadId, { role: a.role, company: a.company }); } catch (e) { console.error("mock: posting not read", e instanceof Error ? e.message : String(e)); }
  }
  if (!found) return null;
  const requirements = requirementsOf(found.text || found.title);
  if (!requirements.length) return null;
  const posting: BoundPosting = { title: cut(clean(found.title), 80) || a.role, company: cut(clean(found.company), 80), job_id: found.job_id, url: found.url, source: found.source, requirements };
  const role = a.role || posting.title;
  const base = start({ role, company: posting.company || a.company, minutes: a.minutes, now: o.now }).state;
  const questions = postingPlan({ role, company: base.company, posting, minutes: base.minutes, seed: Math.floor(o.now / 60_000), sector: base.sector, questionCount: questionCount(base.minutes) });
  const state: MockState = { ...base, questions, posting };
  const tech = questions.filter((q) => q.kind === "technical").length, beh = questions.filter((q) => q.kind === "behavioral").length;
  const asked = requirements.filter((r) => questions.some((q) => q.req?.includes(r.key))).map((r) => r.label);
  const lines = [
    `Mock interview: ${posting.title}${state.company ? ` at ${state.company}` : ""}, built from the posting ${SOURCE_WORDS[posting.source]}. About ${state.minutes} minutes, ${questions.length} questions, by text.`,
    `The posting names ${requirements.map((r) => r.label).join(", ")}. ${tech} technical and ${beh} behavioral question${tech + beh === 1 ? "" : "s"} test${asked.length ? ` ${asked.join(", ")}` : " the role"}.`,
    `Each answer gets a score out of 15 for structure, evidence and detail, and a check against the answer key and the posting. Text "end mock" any time.`,
    "", ask(state, 0),
  ];
  return { state, reply: lines.join("\n") };
}
async function prepTurn(o: TurnIn, prep: MockPrep): Promise<TurnOut | null> {
  if (isWeakListAsk(o.message) || isDrillAsk(o.message)) {
    let spots;
    try { spots = weakSpots(await prep.history(o.userId)); } catch (e) {
      console.error("mock: history not read", e instanceof Error ? e.message : String(e));
      return { reply: "I couldn't read your past mocks just now, so I can't say which spots were weak. Try again in a minute.", status: "history_unreadable", intent: MOCK_DONE_INTENT };
    }
    if (isWeakListAsk(o.message) || !spots.length) return { reply: weakListText(spots), status: spots.length ? "weak_spots" : "no_weak_spots", intent: MOCK_DONE_INTENT };
    const prev = await o.store.get(o.userId, o.threadId).catch(() => null);
    const questions = drillQuestions(spots, Math.floor(o.now / 60_000));
    const minutes = Math.max(5, Math.min(30, questions.length * 4));
    const base = start({ role: spots[0].role, company: spots[0].company, minutes, now: o.now }).state;
    const state: MockState = { ...base, questions, drill: true, posting: null };
    await o.store.save(o.userId, o.threadId, state);
    const dropped = prev && prev.status === "running" && !idle(prev, o.now) ? "The earlier mock was dropped. " : "";
    const reply = [
      `${dropped}Weak-spot drill: ${questions.length} question${questions.length === 1 ? "" : "s"}, one for each weak spot on file: ${questions.map((q) => q.skill).join(", ")}. Same scoring as the mock, plus the answer key. Text "end mock" any time.`,
      "", ask(state, 0),
    ].join("\n");
    return { reply, status: "drill_started", intent: MOCK_INTENT };
  }
  const pj = pastedJd(o.message);
  const cmd = pj ? parseMockCommand(pj.ask) : null;
  if (pj && cmd?.kind === "start") {
    const title = cmd.role || cut(clean(pj.jd.split("\n").find((l) => l.trim()) ?? ""), 80);
    const prev = await o.store.get(o.userId, o.threadId).catch(() => null);
    const b = await boundStart(o, prep, { role: cmd.role, company: cmd.company, minutes: cmd.minutes }, { title, company: cmd.company ?? "", text: pj.jd });
    const s = b ?? start({ role: cmd.role || title, company: cmd.company, minutes: cmd.minutes, now: o.now });
    await o.store.save(o.userId, o.threadId, s.state);
    const dropped = prev && prev.status === "running" && !idle(prev, o.now) ? "The earlier mock was dropped. " : "";
    const none = b ? "" : "The text you pasted names no skill I can build questions from, so these are role questions. ";
    return { reply: dropped + none + s.reply, status: "started", intent: MOCK_INTENT };
  }
  return null;
}
// The last answer checked against its key and the posting (and by the judge, when it is on); the line said after it.
async function gradeLast(o: TurnIn, prep: MockPrep, s: MockState): Promise<string | null> {
  const a = s.answers[s.answers.length - 1];
  const q = a ? s.questions.find((x) => x.n === a.n) : null;
  if (!a || !q || a.skipped) return null;
  let f = fitOf(q, a);
  if (prep.judge && ((q.keys ?? []).length || (q.req ?? []).length)) {
    const v = await prep.judge({ question: q.q, requirement: q.req?.[0] ?? null, keys: q.keys ?? [], answer: a.text, userId: o.userId, threadId: o.threadId }).catch(() => null);
    if (v) f = judgedFit(f, v, q.keys ?? []);
  }
  a.fit = f;
  return fitLine(q, f);
}
// A mock that ended: kept as one mock_done event (each answer's skill and whether it was weak), and the debrief's tail.
async function closed(o: TurnIn, s: MockState, reply: string): Promise<string> {
  const prep = o.store.prep;
  if (!prep) return reply;
  const d = debrief(s);
  if (d.answered) await prep.record(o.userId, mockEvent(s, d));
  const tail = debriefTail(s);
  return tail ? `${reply}\n${tail}` : reply;
}

// One turn, before any brain, right after the card hook. Returns null when the text is not for the mock, so the turn
// goes on as before. An answer counts only while the mock's question is this thread's last word (the card rule): a
// reply to anything said after it is not an answer to it.
export async function mockTurn(
  o: { message: string; userId: string; threadId: string; now: number; store: MockStore },
): Promise<{ reply: string; status: string; intent: string } | null> {
  // FEATURE 11: "drill my weak spots", "what are my weak spots", a mock asked with its job description pasted below.
  if (o.store.prep) {
    const p = await prepTurn(o, o.store.prep);
    if (p) return p;
  }
  const cmd = parseMockCommand(o.message);
  if (cmd?.kind === "start") {
    const prev = await o.store.get(o.userId, o.threadId);
    // FEATURE 11: a posting on file for this company and role binds the mock to it.
    const s = (o.store.prep ? await boundStart(o, o.store.prep, cmd, null) : null) ?? start({ role: cmd.role, company: cmd.company, minutes: cmd.minutes, now: o.now });
    await o.store.save(o.userId, o.threadId, s.state);
    const dropped = prev && prev.status === "running" && !idle(prev, o.now) ? "The earlier mock was dropped. " : "";
    return { reply: dropped + s.reply, status: "started", intent: MOCK_INTENT };
  }
  if (cmd?.kind === "voice") {
    // The same plan as the text mock, for the voice page. A text mock already running stays saved ("resume mock").
    const st: MockState = { ...start({ role: cmd.role, company: cmd.company, minutes: cmd.minutes, now: o.now }).state, voice: true };
    if (!o.store.voice) return { reply: voiceOffText(st), status: "voice_not_wired", intent: MOCK_VOICE_INTENT };
    const link = await o.store.voice.create(o.userId, o.threadId, st, o.now);
    if (!link.ok) {
      return link.reason === "limit"
        ? { reply: VOICE_LIMIT_REPLY, status: "voice_limit", intent: MOCK_VOICE_INTENT }
        : { reply: voiceOffText(st), status: "voice_not_wired", intent: MOCK_VOICE_INTENT };
    }
    return { reply: voiceStartText(st, link.url), status: "voice_link", intent: MOCK_VOICE_INTENT };
  }
  const low = String(o.message ?? "").trim().replace(/[.!?]+$/, "");
  if (CARRIER.test(low)) return null;
  // This read runs on every turn: when it fails and the text is not a mock command, the turn goes on without the mock
  // rather than failing the person's message (the mock's own commands still say what went wrong).
  let s: MockState | null;
  try {
    s = await o.store.get(o.userId, o.threadId);
  } catch (e) {
    if (cmd) throw e;
    console.error("mock: session not read", e instanceof Error ? e.message : String(e));
    return null;
  }
  const running = !!s && s.status === "running";
  if (cmd?.kind === "end") {
    if (!running) return { reply: `No mock is running. Text "start a mock interview" to begin.`, status: "none", intent: MOCK_DONE_INTENT };
    const e = end(s!, o.now, idle(s!, o.now) ? "idle" : "asked");
    await o.store.clear(o.userId, o.threadId);
    return { reply: await closed(o, e.state, e.reply), status: "ended", intent: MOCK_DONE_INTENT };
  }
  if (!running) return null;
  if (cmd?.kind === "resume") {
    if (idle(s!, o.now)) {
      return { reply: `That mock stopped after 30 minutes with no reply. Text "end mock" for its debrief, or "start a mock interview" for a new one.`, status: "idle", intent: MOCK_DONE_INTENT };
    }
    const r: MockState = { ...s!, last_at: o.now };
    await o.store.save(o.userId, o.threadId, r);
    return { reply: `Back to the mock.\n\n${ask(r, r.answers.length)}`, status: "resumed", intent: MOCK_INTENT };
  }
  if (idle(s!, o.now)) return null; // timed out: "end mock" still gives its debrief
  if ((await o.store.lastAssistantIntent(o.threadId)) !== MOCK_INTENT) return null;
  if (cmd?.kind === "done") {
    const e = end(s!, o.now, "asked");
    await o.store.clear(o.userId, o.threadId);
    return { reply: await closed(o, e.state, e.reply), status: "ended", intent: MOCK_DONE_INTENT };
  }
  if (LIVE.test(o.message)) return { reply: LIVE_REFUSAL, status: "live_refused", intent: MOCK_PAUSED_INTENT };
  // Live 2026-10-21: "/start", "hi" and "find jobs" were scored as interview answers. "exit the interview" ends it with its
  // debrief; anything that is not an answer goes on to the brain and leaves the mock saved ("resume mock" picks it up).
  if (MOCK_EXIT.test(low)) {
    const e = end(s!, o.now, "asked");
    await o.store.clear(o.userId, o.threadId);
    return { reply: await closed(o, e.state, e.reply), status: "ended", intent: MOCK_DONE_INTENT };
  }
  if (ownsNewCareerTarget(o.message) || notAnAnswer(low)) return null;
  const r = next(s!, cmd?.kind === "skip" ? null : o.message, o.now);
  let reply = r.reply;
  if (o.store.prep) {
    const line = cmd?.kind === "skip" ? null : await gradeLast(o, o.store.prep, r.state);
    reply = `${r.head}${line ? ` ${line}` : ""}\n\n${r.rest}`;
    if (r.done) reply = await closed(o, r.state, reply);
  }
  if (r.done) await o.store.clear(o.userId, o.threadId);
  else await o.store.save(o.userId, o.threadId, r.state);
  return { reply, status: r.done ? "ended" : (cmd?.kind === "skip" ? "skipped" : "answered"), intent: r.done ? MOCK_DONE_INTENT : MOCK_INTENT };
}

// The session lives in career_watch_kv (service role only) under career:mock:<thread>. An account erase deletes every
// career_watch_kv row of the person except request receipts (career_host_commit, 20261016120000), so it goes with it.
export const mockKey = (threadId: string) => `career:mock:${threadId}`;
export function validState(v: any): v is MockState {
  return !!v && v.v === 1 && Array.isArray(v.questions) && Array.isArray(v.answers) && typeof v.last_at === "number" &&
    typeof v.started_at === "number" && (v.status === "running" || v.status === "ended");
}
// callModel: the model call the judge makes (the chat passes its daily-capped call, career_spend_cap.ts).
export function supabaseMockStore(admin: any, o: { callModel?: ModelCall } = {}): MockStore {
  const cards = supabaseCardStore(admin);
  return {
    async get(userId, threadId) {
      const r = await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", mockKey(threadId)).maybeSingle();
      if (r.error) throw new Error(`read the mock: ${r.error.message}`);
      return validState(r.data?.value) ? r.data.value : null;
    },
    async save(userId, threadId, s) {
      const r = await admin.from("career_watch_kv").upsert({ user_id: userId, key: mockKey(threadId), value: s }, { onConflict: "user_id,key" });
      if (r.error) throw new Error(`save the mock: ${r.error.message}`);
    },
    async clear(userId, threadId) {
      const r = await admin.from("career_watch_kv").delete().eq("user_id", userId).eq("key", mockKey(threadId));
      if (r.error) throw new Error(`clear the mock: ${r.error.message}`);
    },
    lastAssistantIntent: (threadId) => cards.lastAssistantIntent(threadId),
    voice: supabaseVoiceLinks(admin, hostEnv()),
    // FEATURE 11: the posting on file, the weak spots (career_events, kind mock_done), the judge (CAREER_MOCK_JUDGE=on).
    prep: supabaseMockPrep(admin, { get: (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined) }, o.callModel ? { callModel: o.callModel } : undefined),
  };
}

// ---------- The pre-interview brief ----------
export interface Brief {
  company: string | null;
  role: string | null;
  has_record: boolean;
  record: { name: string; as_of: string | null; steps: Fact[]; look_for: Fact | null; style: Fact | null } | null;
  questions_note: string;
  families: string[];
  posting: { title: string; company: string; url: string | null; mentions: string[] } | null;
  plan: string[];
  text: string;
}
function families(role: string): string[] {
  const sector = sectorOf(role);
  if (!sector) return [];
  const bank = (CareerPrep.interviewBanks() || {})[sector];
  const seen: string[] = [];
  for (const it of bank?.items || []) {
    const sec = String(it.section || "");
    if (!sec || SKIP_SECTION.test(sec)) continue;
    const name = clean(sec.replace(/^[A-Z]\.\s*/, "").replace(/\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "").replace(/\s+[—–-]\s+.*$/, ""))
      .replace(/\s*&\s*/g, " and ");
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen.slice(0, 3);
}
function postingFor(postings: any[] | undefined, company: string | null, role: string): Brief["posting"] {
  const want = norm(company), rec = company ? findRecord(company) : null;
  const mine = (postings || []).filter((p) => p && (!want || norm(p.company) === want || (rec && findRecord(p.company) === rec)));
  if (!mine.length) return null;
  const words = role.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const p = mine.find((x) => words.some((w) => String(x.title || "").toLowerCase().includes(w))) || mine[0];
  return { title: cut(clean(p.title), 80), company: cut(clean(p.company), 60), url: p.url ? String(p.url) : null,
    mentions: CareerPrep.jdKeywords(`${p.title || ""} ${p.description || p.jd_text || ""}`).slice(0, 4) };
}

export function brief(o: { company?: string | null; role?: string | null; cir?: any | null; postings?: any[]; lib?: any[] }): Brief {
  const role = cut(clean(o.role), 80), asked = o.company ? cut(clean(o.company), 80) : null;
  const cir = o.cir !== undefined ? o.cir : (asked ? findRecord(asked, o.lib) : null);
  const name = cir ? recordName(cir) : asked;
  const fam = families(role);
  const posting = postingFor(o.postings, name, role);
  const record = cir ? {
    name: recordName(cir), as_of: String(cir.as_of || cir.last_verified_at || "").slice(0, 10) || null,
    steps: stagesOf(cir).slice(0, 4), look_for: lookFor(cir), style: styleOf(cir),
  } : null;
  const roleWords = role || "this role";
  const at = name ? ` at ${name}` : "";
  const questions_note = record
    ? `Questions they asked: the record has no list of ${possessive(record.name)} questions, only the notes above.`
    : name ? `No record for ${name} on file, so nothing here is about how they interview. Role-only plan below.` : "No company named, so this is a role-only plan.";
  const plan = [
    posting && posting.mentions.length
      ? `Reread the posting. It names ${posting.mentions.join(", ")}: have one example for each.`
      : "Get the posting or job description and list the 3 skills it names most.",
    `Write a 60-second answer to "tell me about yourself" for ${roleWords}.`,
    "Pick 3 stories: a team win, a hard problem, a failure. Give each result a number.",
    fam[0] ? `Practice ${fam[0]}: 3 questions out loud, timed.` : "Practice 3 behavioral questions out loud, timed.",
    fam[1] ? `Practice ${fam[1]}: 2 questions out loud.` : "Say why this role and why this company in 2 sentences each.",
    record && record.steps.length
      ? `Prepare for each step on their record: ${record.steps.map((x) => x.text).join("; ")}.`
      : name ? `Ask the recruiter what the ${name} rounds are; there is no record of them here.` : "Ask the recruiter what the rounds are and how long each takes.",
    record && record.look_for
      ? "Have one example that shows what their record says they look for."
      : `Say why ${name || "this company"} in 2 sentences, using only their own site or the posting.`,
    `Run a timed mock: text "mock me for ${role || "this role"}${name ? ` at ${name}` : ""}".`,
    "Write 2 questions to ask them about the team and the work.",
    "Confirm the time, time zone, link or address, and who you meet. Test your setup the day before.",
  ];
  // One text message: the record's notes shrink (style first, then shorter quotes) until the brief fits 1,600 characters.
  const compose = (withStyle: boolean, quote: number, nSteps = 4) => {
    const lines = [`Interview brief: ${role || "interview"}${at}.`];
    if (record) {
      const parts: string[] = [];
      if (record.steps.length) parts.push(`Steps: ${record.steps.slice(0, nSteps).map((x) => x.text).join("; ")} (${record.steps[0].label}).`);
      if (record.look_for && quote) parts.push(`They look for: "${firstSentence(record.look_for.text, quote)}" (${record.look_for.label}).`);
      if (withStyle && record.style && record.style.text !== record.look_for?.text) parts.push(`Interview style: "${firstSentence(record.style.text, quote)}" (${record.style.label}).`);
      lines.push(`What ${possessive(record.name)} record says${record.as_of ? ` (as of ${record.as_of})` : ""}: ${parts.join(" ") || "nothing about their interviews."}`);
    }
    lines.push(questions_note);
    if (posting) lines.push(`From the posting (${posting.title}): ${posting.mentions.length ? `it names ${posting.mentions.join(", ")}.` : "no skill words found in it."}`);
    lines.push(fam.length ? `Top question types for ${roleWords}: ${fam.join(", ")}.` : `Top question types: general behavioral (no question bank for ${roleWords} yet).`);
    lines.push("10-point plan:", ...plan.map((p, i) => `${i + 1}. ${p}`));
    return lines.join("\n");
  };
  let text = compose(true, 120);
  for (const [withStyle, quote, nSteps] of [[false, 120, 4], [false, 80, 4], [false, 50, 3], [false, 0, 2]] as [boolean, number, number][]) {
    if (text.length > BRIEF_LIMIT) text = compose(withStyle, quote, nSteps);
  }
  return { company: name, role: role || null, has_record: !!record, record, questions_note, families: fam, posting, plan, text };
}
export const BRIEF_LIMIT = 1600;
