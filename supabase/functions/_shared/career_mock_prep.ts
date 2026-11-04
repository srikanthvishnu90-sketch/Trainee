// FEATURE 11 (DIAGNOSIS 2.12, fix F7; ARCHITECTURE 3.4): interview prep tied to the actual job, with weak spots drilled.
//
// (a) A mock for a company and role the person has a posting on file for (their applications, their last search, or a
//     job description pasted under the ask) is bound to that posting: its requirements (127 jdKeywords plus a few more
//     skill words, each found in the posting's own text) pick the questions from the role's question bank, technical and
//     behavioral in a mix that fits the role's sector.
// (b) Each answer is graded on 127's rubric (structure, evidence, specificity) and against the question's answer key
//     (the bank item's own key points) and the posting's requirement. With CAREER_MOCK_JUDGE=on an OpenAI model judges the
//     same answer against the same key (metered, rubric-anchored, only key points it was given, never a fact about the
//     person); without it, or when it fails, the code check stands.
// (c) Every finished mock writes one career_events row (kind mock_done) with each answer's skill and whether it was weak.
//     The weak-spot list is read back from those rows (the newest result for a skill wins), so "drill my weak spots" works
//     in any thread and runs a short mock on just those skills.
// (d) The debrief ends with concrete next steps, one per weak spot, from the missed key points.
//
// Code picks the questions and grades; a model never writes a question, a score, or anything about the person.
import { CareerPrep } from "./router_core.career.js";
import type { Debrief, MockAnswer, MockQuestion, MockState } from "./career_mock.ts";
import { callModel, modelConfig, newMeter } from "./model_gateway.ts";

export const DRILL_MAX = 4;
// 127's rubric is strict (a full situation-action-result story with a number scores about 8 of 15): a story answer under 6
// is weak; a technical answer is judged on its key and the requirement, and is weak on the rubric alone only at 3 or under.
export const WEAK_TOTAL = 6, WEAK_TECH_TOTAL = 3;
const MIN_JD = 150; // characters of pasted text under the ask that count as a job description

const clean = (x: unknown) => String(x ?? "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
const norm = (x: unknown) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function cut(t: string, max: number): string {
  if (t.length <= max) return t;
  const c = t.slice(0, max), sp = c.lastIndexOf(" ");
  return c.slice(0, sp > max / 2 ? sp : max).replace(/[\s,;:.]+$/, "") + "...";
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- The posting's requirements ----------
export type ReqKind = "technical" | "behavioral";
export interface Requirement { key: string; label: string; kind: ReqKind }
// re: the posting says it. bank: the role bank's sections and items that test it. said: an answer that speaks to it
// without naming it ("a LEFT JOIN" answers for SQL). ask: the behavioral question for it.
interface ReqDef { key: string; label: string; kind: ReqKind; re: RegExp; bank?: RegExp; said?: RegExp; ask?: string }
// 127's JD_KEYS, each matched as a whole word in the posting (127's own check is a substring check, so "go" would match
// "good"), and a few skill words postings for these roles name often. A requirement is used only when the posting says it.
const REQS: ReqDef[] = [
  { key: "sql", label: "SQL", kind: "technical", re: /\bsql\b/i, bank: /\bsql\b|join|cte|window function|dedup/i, said: /\bjoins?\b|\bctes?\b|window function|\bselect\b|group by|\bpartition(?:ed)? by\b|\b(?:dense_?|row_?)\s?(?:rank|number)\b/i },
  { key: "postgres", label: "Postgres", kind: "technical", re: /\bpostgres(?:ql)?\b/i, bank: /\bsql\b|join|cte/i },
  { key: "python", label: "Python", kind: "technical", re: /\bpython\b/i, bank: /\bpython\b|pandas|notebook/i },
  { key: "r", label: "R", kind: "technical", re: /(?:^|[\s,(/])R(?=[\s,)/.]|$)/ },
  { key: "excel", label: "Excel", kind: "technical", re: /\bexcel\b|\bspreadsheets?\b/i, bank: /excel|spreadsheet/i },
  { key: "tableau", label: "Tableau", kind: "technical", re: /\btableau\b/i },
  { key: "power bi", label: "Power BI", kind: "technical", re: /\bpower ?bi\b/i },
  { key: "looker", label: "Looker", kind: "technical", re: /\blooker\b/i },
  { key: "dashboards", label: "dashboards", kind: "technical", re: /\bdashboards?\b|\bdata visuali[sz]ation\b|\breporting\b/i, bank: /dashboard|visuali/i },
  { key: "statistics", label: "statistics", kind: "technical", re: /\bstatistic(?:s|al)\b/i, bank: /statistic|probab|p-value|confidence|regression|distribution/i, said: /\bprobabilit|\bp-?values?\b|\bconfidence interval|\bsignifican|\bregression\b|\bdistribution|\bvariance\b|\bstandard deviation\b|\bbayes/i },
  { key: "probability", label: "probability", kind: "technical", re: /\bprobability\b/i, bank: /probab|distribution|bayes/i },
  { key: "experimentation", label: "A/B testing", kind: "technical", re: /\bexperiment(?:s|ation)?\b|\ba\/b test/i, bank: /a\/b|experiment|mde|power|peeking/i, said: /\bexperiment|\brandomi[sz]|\bcontrol group|\btreatment\b|\bhypothes[ie]s\b/i },
  { key: "machine learning", label: "machine learning", kind: "technical", re: /\bmachine learning\b|\bml\b/i, bank: /regression|tree model|unsupervised|evaluation metric|bias.variance|ml concept/i },
  { key: "metrics", label: "metrics", kind: "technical", re: /\bmetrics?\b|\bkpis?\b/i, bank: /metric|funnel|cohort|retention/i },
  { key: "etl", label: "ETL and pipelines", kind: "technical", re: /\betl\b|\bdata pipelines?\b|\bdbt\b|\bairflow\b/i },
  { key: "java", label: "Java", kind: "technical", re: /\bjava\b(?!script)/i },
  { key: "javascript", label: "JavaScript", kind: "technical", re: /\bjavascript\b|\btypescript\b/i },
  { key: "react", label: "React", kind: "technical", re: /\breact\b/i },
  { key: "go", label: "Go", kind: "technical", re: /\bgolang\b|(?:^|[\s,(/])Go(?=[\s,)/]|$)(?! (?:to|ahead|beyond)\b)/ },
  { key: "rust", label: "Rust", kind: "technical", re: /\brust\b/i },
  { key: "aws", label: "AWS", kind: "technical", re: /\baws\b/i },
  { key: "kubernetes", label: "Kubernetes", kind: "technical", re: /\bkubernetes\b/i },
  { key: "distributed", label: "distributed systems", kind: "technical", re: /\bdistributed\b/i, bank: /design|scal/i },
  { key: "system design", label: "system design", kind: "technical", re: /\bsystem design\b/i, bank: /design|scal/i },
  { key: "data structures", label: "data structures", kind: "technical", re: /\bdata structures\b/i, bank: /array|hash|linked list|tree|graph|heap/i },
  { key: "algorithms", label: "algorithms", kind: "technical", re: /\balgorithms?\b/i, bank: /array|two pointer|sliding|binary search|dynamic programming|graph/i },
  { key: "financial model", label: "financial modeling", kind: "technical", re: /\bfinancial model(?:s|ing|ling)?\b/i, bank: /three (?:financial )?statements|model|lbo/i },
  { key: "dcf", label: "DCF", kind: "technical", re: /\bdcf\b|\bdiscounted cash flow\b/i, bank: /\bdcf\b|discounted/i },
  { key: "trading", label: "trading", kind: "technical", re: /\btrading\b/i, bank: /market|trad|bid|ask/i },
  { key: "product", label: "product sense", kind: "technical", re: /\bproduct (?:sense|thinking|analytics|metrics|management)\b/i, bank: /product|metric|improve/i },
  { key: "communication", label: "communication", kind: "behavioral", re: /\bcommunicat(?:e|ion|ing)\b|\bpresent(?:ing)? (?:findings|results|insights)\b/i,
    ask: "Tell me about a time you explained a technical result to someone without your background. What did they do with it?" },
  { key: "stakeholders", label: "working with stakeholders", kind: "behavioral", re: /\bstakeholders?\b|\bcross-functional\b|\bpartner with\b/i,
    ask: "Tell me about a time a stakeholder wanted something different from what your work showed. What did you do?" },
  { key: "teamwork", label: "teamwork", kind: "behavioral", re: /\bteamwork\b|\bcollaborat(?:e|ion|ive)\b|\bteam player\b/i,
    ask: "Tell me about a time you worked with a team under a deadline. What was your exact part?" },
  { key: "leadership", label: "leadership", kind: "behavioral", re: /\bleadership\b|\blead (?:projects|initiatives|a team)\b|\bownership\b/i,
    ask: "Tell me about a time you took the lead on something nobody asked you to own. What changed because of it?" },
  { key: "mentoring", label: "mentoring", kind: "behavioral", re: /\bmentor(?:ing|ship)?\b/i,
    ask: "Tell me about a time you helped someone else get better at something. How did you know it worked?" },
  { key: "ambiguity", label: "handling ambiguity", kind: "behavioral", re: /\bambigu(?:ity|ous)\b|\bfast-paced\b/i,
    ask: "Tell me about a time you had to start work before the question was clear. How did you decide what to do first?" },
];
const REQ_BY_KEY = new Map(REQS.map((r) => [r.key, r]));

// What the posting asks for, in the order the posting says it, at most eight. 127's jdKeywords is consulted first; a
// keyword it finds counts only when the word stands alone in the text.
export function requirementsOf(text: string, max = 8): Requirement[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const found: { r: ReqDef; at: number }[] = [];
  const fromJd = new Set<string>(((CareerPrep as any).jdKeywords?.(t) ?? []) as string[]);
  for (const r of REQS) {
    const m = r.re.exec(t);
    if (!m) continue;
    found.push({ r, at: m.index });
  }
  // jdKeywords words not in the table above, as the posting says them.
  for (const k of fromJd) {
    if (REQ_BY_KEY.has(k)) continue;
    const m = new RegExp(`\\b${esc(k)}\\b`, "i").exec(t);
    if (m) found.push({ r: { key: k, label: k, kind: /leader|team|communic|mentor/.test(k) ? "behavioral" : "technical", re: /$^/ }, at: m.index });
  }
  const out: Requirement[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    if (out.some((x) => x.key === f.r.key || x.label === f.r.label)) continue;
    // Postgres folds into SQL when both are named.
    if (f.r.key === "postgres" && out.some((x) => x.key === "sql")) continue;
    out.push({ key: f.r.key, label: f.r.label, kind: f.r.kind });
  }
  return out.slice(0, max);
}

// ---------- Answer keys from the bank ----------
const KEY_STOP = new Set(["the", "and", "for", "with", "that", "this", "then", "when", "what", "into", "from", "your", "their", "about", "each", "both",
  "handle", "show", "once", "named", "item", "items", "generic", "form", "asked", "across", "many", "firms", "guides", "especially", "where", "which"]);
const keyWords = (k: string) => k.toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !KEY_STOP.has(w));
// The key points of a bank item: the functions it names in code (`DENSE_RANK()`), then the short phrases its detail lists.
export function answerKeys(detail: unknown, max = 6): string[] {
  const d = String(detail ?? "").replace(/\*\*[^*]*\*\*/g, "").replace(/\bsource[s]?:.*$/i, "");
  const out: string[] = [];
  const add = (k: string) => {
    const c = clean(k).replace(/^(?:e\.g\.?|i\.e\.?|and|or|then|plus)\s+/i, "").replace(/[().…]+$/g, "").trim().toLowerCase();
    if (!c || c.length < 3 || c.split(" ").length > 4 || !keyWords(c).length) return;
    if (!out.some((x) => x === c)) out.push(c);
  };
  for (const m of d.matchAll(/`([^`]+)`/g)) {
    const fn = m[1].match(/^([A-Z_]{3,}(?: [A-Z]{2,})*)/);
    if (fn) add(fn[1].replace(/_/g, " "));
  }
  const plain = d.replace(/`[^`]*`/g, " ").replace(/\([^)]*\)/g, " ").replace(/\be\.g\.?/gi, " ");
  for (const part of plain.split(/[,;:/]|\band\b|\bor\b|\.\s/)) add(part);
  return out.slice(0, max);
}
// Whether the answer covers a key point: at least half of the key's words, each by its first five letters.
export function covers(answer: string, key: string): boolean {
  const a = ` ${String(answer ?? "").toLowerCase().replace(/[_-]/g, " ").replace(/[^a-z0-9/ ]+/g, " ")} `;
  const ws = keyWords(key.replace(/[_-]/g, " "));
  if (!ws.length) return false;
  const hit = ws.filter((w) => a.includes(` ${w.slice(0, Math.min(5, w.length))}`)).length;
  return hit * 2 >= ws.length;
}
export function mentions(answer: string, req: string): boolean {
  const d = REQ_BY_KEY.get(req);
  if (d && d.re.source !== "$^" && d.re.test(answer)) return true;
  if (d?.said && d.said.test(answer)) return true; // "a window function" answers for SQL
  return covers(answer, d?.label ?? req);
}

// ---------- The plan of questions bound to a posting ----------
const NAMED = /\b(?:meta|facebook|twitter|uber|snapchat|linkedin|intuit|apple|netflix|faang|amazon|google|microsoft|mckinsey|bain|bcg|goldman|jpmorgan|morgan stanley|citadel|jane street)\b/i;
const ASKS = /\?$|^(?:walk|tell|describe|design|how|what|why|explain|estimate|make|given|pick|build|define|diagnose|compare|price|interpret|reverse|quote|mental|your|turn|debug)\b/i;
const SKIP_SECTION = /behavio|fit|personal|why|r[ée]sum|questions the candidate|format|expectation|bookshelf|canon|sample cases|published by/i;
interface BankItem { q: string; keys: string[]; section: string; from: string }
function asQuestion(raw: string): string | null {
  const t = clean(raw).replace(/\s*\([^)]*\)/g, "").replace(/^"|"$/g, "").replace(/\s+([.?,])/g, "$1").trim();
  if (!t || t.split(" ").length < 2 || NAMED.test(t) || /skill cluster|book canon|bookshelf/i.test(t)) return null;
  if (ASKS.test(t)) return /[.?!]$/.test(t) ? t : `${t}.`;
  return `Talk me through how you would do this: ${t.charAt(0).toLowerCase()}${t.slice(1).replace(/[.]$/, "")}.`;
}
export function bankItems(role: string): BankItem[] {
  if (!role) return [];
  const bank = (CareerPrep as any).questionBank({ role, roleFamily: role });
  const out: BankItem[] = [];
  for (const row of bank.questions || []) {
    const type = String(row?.source?.type ?? "");
    if (type === "generic_behavioral_bank" || /^CIR/.test(type)) continue;
    const section = String(row?.source?.section ?? row?.round ?? "");
    if (SKIP_SECTION.test(section)) continue;
    const q = asQuestion(row.q);
    if (!q || out.some((x) => norm(x.q) === norm(q))) continue;
    out.push({ q, keys: answerKeys(`${row.detail ?? ""}${row.answer ? `, ${row.answer}` : ""}`), section, from: type.startsWith("interview_bank_") ? `${String(row.source.sector).replace(/_/g, " ")} question bank` : `${type.replace(/_bank$/, "").replace(/_/g, " ")} set` });
  }
  return out;
}
// The share of technical questions for the role's sector.
export function technicalShare(sector: string | null): number {
  return ({ data: 0.6, swe: 0.67, quant: 0.67, finance: 0.5, pm: 0.4, consulting: 0.4 } as Record<string, number>)[sector ?? ""] ?? 0.5;
}
const lead = (r: Requirement) => `The posting asks for ${r.label}.`;
function questionFor(r: Requirement, items: BankItem[], used: Set<string>, seed: number): { q: string; keys: string[]; from: string } {
  const d = REQ_BY_KEY.get(r.key);
  if (r.kind === "behavioral") return { q: `${lead(r)} ${d?.ask ?? `Tell me about a time you showed ${r.label}. What was your exact part, and what came of it?`}`, keys: [], from: "general behavioral, bound to the posting" };
  const pool = d?.bank ? items.filter((it) => !used.has(it.q) && (d.bank!.test(it.section) || d.bank!.test(it.q))) : [];
  if (pool.length) {
    const it = pool[seed % pool.length];
    used.add(it.q);
    return { q: `${lead(r)} ${it.q}`, keys: it.keys, from: it.from };
  }
  return { q: `${lead(r)} Walk me through the last real problem you solved with ${r.label}: what the problem was, what you did with it, and how you checked the result.`, keys: [], from: "posting requirement" };
}

export interface PostingOnFile {
  title: string; company: string; job_id: string | null; url: string | null;
  source: "application" | "search" | "pasted"; text: string;
}
export interface BoundPosting { title: string; company: string; job_id: string | null; url: string | null; source: PostingOnFile["source"]; requirements: Requirement[] }

export function postingPlan(o: { role: string; company: string | null; posting: BoundPosting; minutes: number; seed: number; sector: string | null; questionCount: number }): MockQuestion[] {
  const n = Math.max(3, o.questionCount);
  const name = o.posting.company || o.company;
  const reqs = o.posting.requirements;
  const middle = n - (name ? 2 : 1);
  const techWant = Math.min(middle, Math.ceil(middle * technicalShare(o.sector)));
  const items = bankItems(o.role || o.posting.title);
  const backed = (r: Requirement) => { const b = REQ_BY_KEY.get(r.key)?.bank; return !!b && items.some((it) => b.test(it.section) || b.test(it.q)); };
  const bi = reqs.some((r) => ["tableau", "power bi", "looker"].includes(r.key));
  // Requirements the bank has questions (and answer keys) for go first, in the posting's order; then the rest.
  const techAll = reqs.filter((r) => r.kind === "technical" && !(bi && r.key === "dashboards"));
  const tech = [...techAll.filter(backed), ...techAll.filter((r) => !backed(r))], beh = reqs.filter((r) => r.kind === "behavioral");
  const used = new Set<string>();
  const seed = Math.abs(Math.floor(o.seed)) || 0;
  const qs: Omit<MockQuestion, "n">[] = [];
  qs.push({ q: `Tell me about yourself and why the ${o.posting.title} role${name ? ` at ${name}` : ""}.`, kind: "opener", from: "general behavioral", skill: "your opener" });
  const picked: Omit<MockQuestion, "n">[] = [];
  const techPicks = tech.slice(0, techWant);
  const behPicks = beh.slice(0, middle - techPicks.length);
  // Short of behavioral requirements, more technical ones fill in; short of both, the role's bank fills in.
  const extraTech = tech.slice(techPicks.length, techPicks.length + Math.max(0, middle - techPicks.length - behPicks.length));
  for (const r of [...techPicks, ...extraTech]) { const x = questionFor(r, items, used, seed); picked.push({ q: x.q, kind: "technical", from: x.from, req: [r.key], keys: x.keys, skill: r.label }); }
  for (const r of behPicks) { const x = questionFor(r, items, used, seed); picked.push({ q: x.q, kind: "behavioral", from: x.from, req: [r.key], keys: [], skill: r.label }); }
  const generic: string[] = (CareerPrep as any).GENERIC_BEHAVIORAL;
  let g = 1;
  while (picked.length < middle) {
    const it = items.filter((x) => !used.has(x.q))[0];
    if (it && picked.filter((p) => p.kind === "technical").length < techWant) { used.add(it.q); picked.push({ q: it.q, kind: "technical", from: it.from, keys: it.keys, skill: cut(it.q, 50) }); continue; }
    if (g >= 4) break;
    picked.push({ q: generic[g], kind: "behavioral", from: "general behavioral", skill: cut(generic[g], 50) });
    g++;
  }
  // Technical first, then behavioral, as most loops run.
  qs.push(...picked.filter((p) => p.kind === "technical"), ...picked.filter((p) => p.kind !== "technical"));
  if (name) qs.push({ q: `Why ${name}, specifically?`, kind: "closer", from: "general behavioral", skill: `why ${name}` });
  return qs.slice(0, n).map((q, i) => ({ ...q, n: i + 1 }));
}

// ---------- The text that asks ----------
const DRILL = /^(?:(?:can you|could you|please|let'?s|lets|ok(?:ay)?|now)[\s,]+)*(?:drill|practi[cs]e|work on|quiz me on|go over|redo|train)\s+(?:me on\s+)?(?:my|the)\s+weak(?:est)?\s*(?:spots?|areas?|points?|answers?|questions?|skills?|ness(?:es)?)(?:\s+(?:again|now|from (?:my|the) (?:last )?mock(?: interview)?))?(?:\s+please)?$|^(?:drill|practi[cs]e) (?:my )?weakness(?:es)?$|^weak[- ]spots? drill$/i;
const LIST = /^(?:what|which)(?: are|'re| were)? (?:my|the) weak(?:est)? (?:spots?|areas?|points?|answers?)(?: from (?:my|the) (?:last )?mock(?: interview)?)?$|^(?:show|list)(?: me)? my weak (?:spots?|areas?)$/i;
const plainAsk = (t: string) => String(t ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
export function isDrillAsk(text: string): boolean { return DRILL.test(plainAsk(text)); }
export function isWeakListAsk(text: string): boolean { return LIST.test(plainAsk(text)); }
// "mock me for the data analyst role at Acme" with the job description pasted below it: the first line is the ask, the
// rest is the posting. Returns null when the text has no ask on its first line or too little below it.
export function pastedJd(text: string): { ask: string; jd: string } | null {
  const t = String(text ?? "").replace(/\r/g, "");
  const m = t.match(/^([^\n]{6,200}?)(?:[:.]\s*|\s*\n)\s*([\s\S]+)$/);
  if (!m) return null;
  const [ask, jd] = [m[1].trim().replace(/[\s:.,-]+$/, ""), m[2].trim()];
  if (jd.length < MIN_JD || !/\b(?:mock|practice)\b/i.test(ask)) return null;
  return { ask: ask.replace(/\s+(?:with|using|from)?\s*(?:this|the)\s+(?:job description|jd|posting)$/i, "").replace(/[,\s]*(?:here(?:'s| is) (?:the|my) (?:job description|jd|posting))$/i, ""), jd };
}

// ---------- Grading against the key and the posting ----------
export interface Fit { req: string | null; covered: string[]; missed: string[]; named_req: boolean | null; weak: boolean; why: string; judged?: boolean }
export interface JudgeVerdict { covered: string[]; verdict: "strong" | "ok" | "weak"; fix: string | null }
export type Judge = (o: { question: string; requirement: string | null; keys: string[]; answer: string; userId?: string; threadId?: string }) => Promise<JudgeVerdict | null>;

export function fitOf(q: MockQuestion, a: MockAnswer): Fit {
  const req = q.req?.[0] ?? null;
  const label = req ? (REQ_BY_KEY.get(req)?.label ?? req) : null;
  const keys = q.keys ?? [];
  const covered = keys.filter((k) => covers(a.text, k)), missed = keys.filter((k) => !covers(a.text, k));
  const named = req && q.kind === "technical" ? mentions(a.text, req) : null;
  const total = a.scores?.total ?? 0;
  let weak = false, why = "";
  if (q.kind === "technical" ? total <= WEAK_TECH_TOTAL : total < WEAK_TOTAL) { weak = true; why = a.fix ? `the answer was thin on ${a.fix}` : "the answer scored low"; }
  if (named === false) { weak = true; why = `the answer never said how you would use ${label}`; }
  else if (keys.length >= 2 && covered.length * 3 < keys.length) { weak = true; why = `it missed most of the answer key (${missed.slice(0, 3).join(", ")})`; }
  return { req, covered, missed, named_req: named, weak, why };
}
// The line said after a scored answer, after the rubric's nudge.
export function fitLine(q: MockQuestion, f: Fit): string | null {
  if (!q.req?.length && !(q.keys ?? []).length) return f.weak ? "Weak spot noted for a drill." : null;
  const label = f.req ? (REQ_BY_KEY.get(f.req)?.label ?? f.req) : null;
  const parts: string[] = [];
  if (label && f.named_req === false) parts.push(`The posting asks for ${label}, and the answer never said how you would use it.`);
  if ((q.keys ?? []).length) {
    if (f.covered.length) parts.push(`Answer key: you covered ${f.covered.slice(0, 3).join(", ")}${f.missed.length ? `; it also has ${f.missed.slice(0, 3).join(", ")}` : ""}.`);
    else parts.push(`Answer key: ${f.missed.slice(0, 3).join(", ")}; none of it came up.`);
  } else if (label && f.named_req) parts.push(`It speaks to the posting's ${label}.`);
  if (f.judged && f.weak && f.why && !parts.some((p) => p.includes(f.why))) parts.push(`${f.why.charAt(0).toUpperCase()}${f.why.slice(1).replace(/[.]?$/, ".")}`);
  if (f.weak) parts.push("Weak spot noted for a drill.");
  return parts.length ? parts.join(" ") : null;
}
// A judge's verdict is used only inside what it was given: covered key points from the list, one of three verdicts, and a
// fix with no number and no name that the question, the key or the person's answer did not already hold.
export function checkVerdict(v: any, keys: string[], context: string): JudgeVerdict | null {
  if (!v || typeof v !== "object" || !["strong", "ok", "weak"].includes(v.verdict)) return null;
  const covered = Array.isArray(v.covered) ? v.covered.filter((k: unknown) => typeof k === "string" && keys.includes(k)) : [];
  let fix: string | null = typeof v.fix === "string" ? clean(v.fix).slice(0, 220) : null;
  if (fix) {
    const ctx = context.toLowerCase();
    const invented = /\d/.test(fix) || (fix.match(/(?<=\s)[A-Z][a-zA-Z]+/g) ?? []).some((w) => !ctx.includes(w.toLowerCase())) || /\byou (?:have|had|did|worked|built|led|used)\b/i.test(fix);
    if (invented || /\b(?:as an ai|language model)\b/i.test(fix)) fix = null;
  }
  return { covered, verdict: v.verdict, fix };
}
export function judgedFit(f: Fit, v: JudgeVerdict, keys: string[]): Fit {
  const covered = v.covered, missed = keys.filter((k) => !covered.includes(k));
  const weak = v.verdict === "weak" || f.named_req === false;
  return { ...f, covered, missed, weak, why: weak ? (v.fix ?? f.why ?? "the judge rated it weak") : "", judged: true };
}

// ---------- Weak spots, kept in career_events ----------
export interface WeakSpot { skill: string; q: string; kind: string; req: string[]; keys: string[]; missed: string[]; why: string; at: string; role: string; company: string | null; mock: string }
interface EventLike { at: string; kind: string; subject: string; detail: any }
// The skills whose newest graded answer was weak, newest first. A later strong answer on the same skill clears it.
export function weakSpots(events: EventLike[], max = DRILL_MAX + 2): WeakSpot[] {
  const latest = new Map<string, WeakSpot | null>();
  const sorted = [...events].filter((e) => e.kind === "mock_done" && Array.isArray(e.detail?.answers)).sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const e of sorted) {
    for (const a of e.detail.answers) {
      const skill = clean(a?.skill).toLowerCase();
      if (!skill || latest.has(skill) || a.skipped) continue;
      latest.set(skill, a.weak ? {
        skill: clean(a.skill), q: clean(a.q), kind: String(a.kind ?? "behavioral"), req: Array.isArray(a.req) ? a.req.map(String) : [], keys: Array.isArray(a.keys) ? a.keys.map(String) : [],
        missed: Array.isArray(a.missed) ? a.missed.map(String) : [], why: clean(a.why), at: e.at, role: clean(e.detail.role), company: e.detail.company ? clean(e.detail.company) : null,
        mock: clean(e.subject),
      } : null);
    }
  }
  // Newest mock first; within one mock, the posting's requirements before the opener and the closer.
  const list = [...latest.values()].filter((x): x is WeakSpot => !!x);
  list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : Number(b.req.length > 0) - Number(a.req.length > 0)));
  return list.slice(0, max);
}
// The mock_done event of a finished mock: what was asked, each answer's skill and whether it was weak. No answer text.
export function mockEvent(s: MockState, d: Debrief): { subject: string; detail: Record<string, unknown> } {
  const answers = s.questions.map((q) => {
    const a = s.answers.find((x) => x.n === q.n);
    const f = (a as any)?.fit as Fit | undefined;
    return {
      n: q.n, skill: q.skill ?? cut(q.q, 50), q: cut(q.q, 180), kind: q.kind, req: q.req ?? [], keys: (q.keys ?? []).slice(0, 6),
      ...(a ? (a.skipped ? { skipped: true } : { score: a.scores?.total ?? null, weak: !!f?.weak, missed: (f?.missed ?? []).slice(0, 4), why: cut(f?.why ?? "", 120) }) : { skipped: true }),
    };
  }).filter((x) => !("skipped" in x && x.skipped && !s.answers.some((a) => a.n === x.n)));
  const p = s.posting;
  return {
    subject: cut(`${s.drill ? "Weak-spot drill" : "Mock"}: ${s.role || "general"}${s.company ? ` at ${s.company}` : ""}`, 200),
    detail: {
      role: s.role || null, company: s.company, drill: !!s.drill, average: d.average, answered: d.answered, asked: d.asked,
      ...(p ? { posting: { title: cut(p.title, 100), company: cut(p.company, 80), job_id: p.job_id, source: p.source, requirements: p.requirements.map((r) => r.label) } } : {}),
      answers,
    },
  };
}

function stepFor(w: { skill: string; n?: number; kind: string; req: string[]; missed: string[]; why: string }): string {
  const at = w.n ? ` (Q${w.n})` : "";
  const label = w.req[0] ? (REQ_BY_KEY.get(w.req[0])?.label ?? w.req[0]) : null;
  if (w.missed.length) return `${cap(w.skill)}${at}: redo it out loud in 2 minutes and cover ${w.missed.slice(0, 3).join(", ")}.`;
  if (label && w.kind === "technical") return `${cap(w.skill)}${at}: write down one real time you used ${label}, the problem, what you did, how you checked it, and say it in 90 seconds.`;
  if (/structure/.test(w.why)) return `${cap(w.skill)}${at}: tell it in order, the situation, what you did, then the result, in 90 seconds.`;
  if (/specificity/.test(w.why)) return `${cap(w.skill)}${at}: name the tool, the limit you worked under and your exact part.`;
  return `${cap(w.skill)}${at}: add the result as a number and how you know it, then say it again.`;
}
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// The lines after the debrief: the posting's requirements covered and missed, the weak spots kept, and one concrete next
// step for each.
export function debriefTail(s: MockState): string {
  const lines: string[] = [];
  const weak = s.questions.map((q) => ({ q, a: s.answers.find((x) => x.n === q.n) })).filter((x) => x.a && !x.a.skipped && (x.a as any).fit?.weak);
  if (s.posting?.requirements.length) {
    const asked = s.questions.filter((q) => q.req?.length);
    const ok = asked.filter((q) => { const a = s.answers.find((x) => x.n === q.n); return a && !a.skipped && !(a as any).fit?.weak; }).map((q) => q.skill!);
    const bad = asked.filter((q) => { const a = s.answers.find((x) => x.n === q.n); return a && !a.skipped && (a as any).fit?.weak; }).map((q) => `${q.skill} (Q${q.n})`);
    const notAsked = s.posting.requirements.filter((r) => !asked.some((q) => q.req?.includes(r.key))).map((r) => r.label);
    const parts = [ok.length ? `held up on ${ok.join(", ")}` : "", bad.length ? `weak on ${bad.join(", ")}` : "", notAsked.length ? `not asked this time: ${notAsked.join(", ")}` : ""].filter(Boolean);
    if (parts.length) lines.push(`Against the posting (${s.posting.title}): ${parts.join("; ")}.`);
  }
  if (weak.length) {
    lines.push(`${s.drill ? "Still weak, kept for the next drill" : "Weak spots kept for a drill"}: ${weak.map((x) => x.q.skill ?? `Q${x.q.n}`).join(", ")}.`);
    lines.push("Next steps:");
    weak.slice(0, 3).forEach((x, i) => {
      const f = (x.a as any).fit as Fit;
      lines.push(`${i + 1}. ${stepFor({ skill: x.q.skill ?? `Q${x.q.n}`, n: x.q.n, kind: x.q.kind, req: x.q.req ?? [], missed: f.missed, why: f.why })}`);
    });
    lines.push(`Text "drill my weak spots" to practice just ${weak.length === 1 ? "that one" : "those"}.`);
  } else if (s.answers.some((a) => !a.skipped)) {
    lines.push(s.drill ? "Every drilled spot held up this time, so it is off the weak-spot list." : "No weak spots this time.");
  }
  return lines.join("\n");
}

// ---------- The drill ----------
export function drillQuestions(spots: WeakSpot[], seed: number): MockQuestion[] {
  const out: MockQuestion[] = [];
  for (const w of spots.slice(0, DRILL_MAX)) {
    let q = w.q;
    if (w.req.length && w.kind === "technical") {
      // A fresh question for the same requirement when the bank has one; the same question again when it does not.
      const r = REQ_BY_KEY.get(w.req[0]);
      const items = bankItems(w.role).filter((it) => r?.bank && (r.bank.test(it.section) || r.bank.test(it.q)) && !w.q.includes(it.q));
      if (items.length) {
        const it = items[Math.abs(seed) % items.length];
        out.push({ n: out.length + 1, q: `${lead({ key: w.req[0], label: r!.label, kind: "technical" })} ${it.q}`, kind: "technical", from: `weak-spot drill (${it.from})`, req: w.req, keys: it.keys, skill: w.skill });
        continue;
      }
    }
    q = q.replace(/^Again[^:]*:\s*/, "");
    out.push({ n: out.length + 1, q: `Again, sharper this time: ${q}`, kind: (["opener", "behavioral", "technical", "company", "closer"].includes(w.kind) ? w.kind : "behavioral") as MockQuestion["kind"], from: "weak-spot drill", req: w.req, keys: w.keys, skill: w.skill });
  }
  return out;
}
export function weakListText(spots: WeakSpot[]): string {
  if (!spots.length) return `No weak spots on file. They come from mock answers that scored low or missed the answer key. Text "mock me for data analyst at Acme" (your role and company) to run one.`;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return [`Weak spots on file (${spots.length}), newest first:`,
    ...spots.map((w, i) => `${i + 1}. ${cap(w.skill)}, from your ${w.mock.replace(/^(?:Mock|Weak-spot drill): /, "")} mock on ${day(w.at)}${w.why ? `: ${w.why}` : ""}.`),
    `Text "drill my weak spots" for a short mock on just these.`].join("\n");
}

// ---------- The hooks the mock calls (career_mock.ts mockTurn) ----------
export interface MockPrep {
  // The posting on file for this company and role: the person's applications, then their last search.
  posting(userId: string, threadId: string, want: { role: string; company: string | null }): Promise<PostingOnFile | null>;
  // The person's finished mocks, newest first (career_events, kind mock_done).
  history(userId: string): Promise<EventLike[]>;
  // One finished mock, written as a mock_done event. Never fails the turn.
  record(userId: string, e: { subject: string; detail: Record<string, unknown> }): Promise<void>;
  judge?: Judge | null; // only with CAREER_MOCK_JUDGE=on
}

// ---------- The production store ----------
// Where a posting on file is: the person's applications (career_apply_jobs, then their apply queue career_apply_wanted),
// then the last search's shortlist (this thread's, then their other threads', newest first, from agent_flow_state). The
// posting's text is the ingested posting (career_postings.description) or the knowledge-base excerpt
// (career_kb_postings.text_excerpt). A read that fails is skipped; the mock then runs on the role alone.
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["the", "and", "role", "job", "position", "for"].includes(w));
export function matchPosting<T extends { company?: unknown; title?: unknown }>(rows: T[], want: { role: string; company: string | null }): T | null {
  const wc = norm(want.company), rw = words(want.role);
  const company = (c: unknown) => { const n = norm(c); return !!wc && !!n && (n === wc || (wc.length >= 4 && n.startsWith(wc)) || (n.length >= 4 && wc.startsWith(n))); };
  const roleHit = (t: unknown) => { const tw = words(String(t ?? "")); return rw.filter((w) => tw.some((x) => x.startsWith(w.slice(0, 5)))).length; };
  let best: T | null = null, bestHit = 0;
  for (const r of rows) {
    if (!wc && !rw.length) return null;
    if (wc && !company(r.company)) continue;
    const hit = roleHit(r.title);
    if (rw.length && hit === 0) continue; // a posting for another role at the same company is not this one
    if (!wc && hit * 2 < rw.length) continue;
    if (!best || hit > bestHit) { best = r; bestHit = hit; }
  }
  return best;
}
export type ModelCall = typeof callModel;
export function supabaseMockPrep(admin: any, env: { get(k: string): string | undefined }, deps?: { judge?: Judge | null; callModel?: ModelCall }): MockPrep {
  const textOf = async (id: string | null): Promise<string> => {
    if (!id) return "";
    try {
      const p = await admin.from("career_postings").select("title,description").eq("job_id", id).maybeSingle();
      if (!p.error && p.data?.description) return `${p.data.title ?? ""}\n${p.data.description}`;
    } catch { /* next source */ }
    try {
      const k = await admin.from("career_kb_postings").select("title,text_excerpt").eq("posting_key", id).maybeSingle();
      if (!k.error && k.data?.text_excerpt) return `${k.data.title ?? ""}\n${k.data.text_excerpt}`;
    } catch { /* none */ }
    return "";
  };
  return {
    async posting(userId, threadId, want) {
      const apps: { company: string; title: string; job_id: string | null; url: string | null }[] = [];
      try {
        const r = await admin.from("career_apply_jobs").select("job_id,company,url,title:payload->>title").eq("user_id", userId).order("updated_at", { ascending: false }).limit(200);
        if (!r.error) for (const x of r.data ?? []) apps.push({ company: x.company ?? "", title: x.title ?? "", job_id: x.job_id ?? null, url: x.url ?? null });
      } catch (e) { console.error("mock prep: applications", (e as Error)?.message ?? e); }
      try {
        const r = await admin.from("career_apply_wanted").select("posting_key,company,title,url").eq("user_id", userId).order("queued_at", { ascending: false }).limit(200);
        if (!r.error) for (const x of r.data ?? []) apps.push({ company: x.company ?? "", title: x.title ?? "", job_id: x.posting_key ?? null, url: x.url ?? null });
      } catch (e) { console.error("mock prep: apply queue", (e as Error)?.message ?? e); }
      const app = matchPosting(apps, want);
      if (app) return { title: clean(app.title) || want.role, company: clean(app.company), job_id: app.job_id, url: app.url, source: "application", text: await textOf(app.job_id) };
      const lists: any[][] = [];
      try {
        const r = await admin.from("agent_flow_state").select("thread_id,state").eq("user_id", userId).order("updated_at", { ascending: false }).limit(10);
        if (!r.error) {
          const rows = (r.data ?? []) as any[];
          rows.sort((a, b) => Number(b.thread_id === threadId) - Number(a.thread_id === threadId));
          for (const row of rows) { const l = row?.state?.career?.stores?.discovery?.lastShortlist; if (Array.isArray(l)) lists.push(l); }
        }
      } catch (e) { console.error("mock prep: last search", (e as Error)?.message ?? e); }
      for (const l of lists) {
        const hit = matchPosting(l.filter((x) => x && typeof x === "object"), want);
        if (hit) return { title: clean(hit.title) || want.role, company: clean(hit.company), job_id: hit.id ? String(hit.id) : null, url: hit.url ? String(hit.url) : null, source: "search", text: await textOf(hit.id ? String(hit.id) : null) };
      }
      return null;
    },
    async history(userId) {
      const r = await admin.from("career_events").select("at,kind,subject,detail").eq("user_id", userId).eq("kind", "mock_done").order("at", { ascending: false }).limit(30);
      if (r.error) throw new Error(`read the mock history: ${r.error.message}`);
      return (r.data ?? []) as EventLike[];
    },
    async record(userId, e) {
      try {
        const r = await admin.from("career_events").insert({ user_id: userId, kind: "mock_done", subject: e.subject, detail: e.detail, source: "mock" });
        if (r.error) console.error("mock prep: mock_done not recorded:", r.error.message);
      } catch (err) { console.error("mock prep: mock_done not recorded:", (err as Error)?.message ?? err); }
    },
    judge: deps?.judge !== undefined ? deps.judge : (env.get("CAREER_MOCK_JUDGE") === "on" ? modelJudge(admin, env, deps?.callModel ? { callModel: deps.callModel } : undefined) : null),
  };
}

// ---------- The model judge (CAREER_MOCK_JUDGE=on) ----------
// OpenAI only (the gateway is pinned to it here whatever MODEL_PROVIDER says), CAREER_MODEL (default gpt-5-mini). Each
// call is metered and one agent_turn_costs row is written per judged answer. Any failure returns null and the code check
// stands.
export const JUDGE_SYSTEM = [
  "You grade one practice interview answer against an answer key. You are not the interviewer and you do not write to the candidate.",
  "Use only the question, the requirement, the key points and the answer you are given. Do not state or guess any fact about the candidate.",
  "covered: the key points (copied exactly from the list) that the answer actually explains, not just names.",
  "verdict: strong when it covers most key points with a concrete example, weak when it misses most key points or never addresses the requirement, else ok.",
  "fix: one short instruction for the next attempt, about what to add or explain. No numbers, no names, no claims about the candidate.",
  'Reply with JSON only: {"covered":[...],"verdict":"strong|ok|weak","fix":"..."}',
].join("\n");
export function modelJudge(admin: any, env: { get(k: string): string | undefined }, o?: { call?: (payload: any, meter: any) => Promise<any>; callModel?: ModelCall }): Judge {
  return async ({ question, requirement, keys, answer, userId, threadId }) => {
    const meter = newMeter();
    const cfg = { ...modelConfig({ get: (k: string) => (k === "MODEL_PROVIDER" ? "openai" : env.get(k)) }, "chat"), model: env.get("CAREER_MODEL") || "gpt-5-mini" };
    const payload = {
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ question, requirement, key_points: keys, answer: answer.slice(0, 2000) }) }],
      max_tokens: 300,
    };
    let v: JudgeVerdict | null = null;
    try {
      const msg = o?.call ? await o.call(payload, meter) : await (o?.callModel ?? callModel)(cfg, payload, { meter, role: "chat" });
      const text = (msg?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      const m = text.match(/\{[\s\S]*\}/);
      v = m ? checkVerdict(JSON.parse(m[0]), keys, `${question} ${requirement ?? ""} ${keys.join(" ")} ${answer}`) : null;
    } catch (e) {
      console.error("mock judge:", (e as Error)?.message ?? e);
      v = null;
    }
    if (meter.calls && userId) {
      try {
        const r = await admin.from("agent_turn_costs").insert({ user_id: userId, thread_id: threadId ?? null, provider: meter.provider, models: meter.models, calls: meter.calls, failed: meter.failed, input_tokens: meter.input_tokens, output_tokens: meter.output_tokens, cached_tokens: meter.cached_tokens, usd_micros: meter.usd_micros, unpriced: meter.unpriced });
        if (r.error) console.error("mock judge cost not recorded:", r.error.message);
      } catch { /* the cost row never fails the turn */ }
    }
    return v;
  };
}
