// FEATURE 13 (owner, 2026-10-25): the staged release of the agent brain. CAREER_BRAIN=staged sends to the brain only the
// turns that are questions, advice or conversation: a turn no code-first turn in handler-career.ts claimed, and that the
// router itself would answer with no action and no code product (nothing claimed it, or it fell to an advice or
// catch-all reply). Every action stays code's: the code-first turns, the host's controls, structured task and batch
// requests, and every router turn that is not on the list below. The router still answers when the model fails, and the
// owner keeps any turn class on the router by naming it in CAREER_BRAIN_ROUTER_INTENTS (comma separated; "unclaimed"
// is the class of turns no module claimed). D-035 (owner, 2026-11-01: "Ship staged brain"): which brain is served is the
// committed release config (release_config.ts PRODUCTION_BRAIN, now "staged"), so CAREER_BRAIN unset serves it; the
// environment only rolls back: CAREER_BRAIN=router (the kill switch, or any value but the release brain) makes nothing
// here true, and the router answers every turn exactly as before. CAREER_BRAIN=agent stays pinned off by AGENT_BRAIN_RELEASED.
//
// How a turn is classed: the router runs once on a disposable copy of the turn's state (no I/O; the real state is not
// touched), and its intent decides. A turn the brain does not take runs through the router again on the real state, as
// it does today, so what the router saves is exactly what it saved before.

import { servedBrain } from "./release_config.ts";
import { NO_CLOCK, type TurnClock } from "./turn_clock.ts";
import { crisisReply } from "./crisis.ts";

type Env = { get(k: string): string | undefined };
type Host = { runTurn(text: string, ctx: any): { intent: string | null; handler: string | null; contained?: boolean; result?: any }; isHostControlled(text: string, ctx: any): boolean };

import { correctedAsk } from "../_shared/search_correction.ts";
import { askFor } from "../_shared/career_search_judge.ts";
export type BrainMode = "router" | "agent" | "staged";
// The served brain (release_config.ts): the committed PRODUCTION_BRAIN unless CAREER_BRAIN rolls it back to the router.
// "agent" is never served from here (the full brain stays pinned off in career_brain.ts).
export function brainMode(env: Env): BrainMode {
  return servedBrain(env);
}

// The pseudo-intent of a turn that no module claimed (the router's "I didn't catch that").
export const UNCLAIMED = "unclaimed";
// The router's question, advice and conversation answers. Each is code's reply to a turn with no action in it; the
// brain answers those with the person's situation and its read tools. Actions (search, apply, watch, track, tailor,
// mock, outreach, onboarding, profile corrections, refusals, safety replies, a bare yes or no) are not here.
export const STAGED_BRAIN_INTENTS: readonly string[] = [
  UNCLAIMED,
  "career_catchall", "career_fallback", "career_out_of_scope", "career_greeting",
  "conversation_ack", "conversation_clarify",
  "career_guidance", "career_resume_guidance", "career_cover_letter_guidance", "career_field_decision", "career_offer_decision",
  "career_life_event", "career_next_step", "path_answer",
  // Taken only without a sourced record behind the answer (no company file, no benchmark, no offer on record): see
  // codeProduct. With one, the router's answer cites it and stays.
  "company_intel", "negotiation_advice",
];

// A router answer that carries a code product (a sourced company file, a benchmark with figures, the person's offer, a
// draft, a document, a plan record) is the router's: the brain would restate what code already cites, and facts about
// a company come only from a sourced record. Two intents are judged by what they carry: company_intel is the brain's
// only when no company is named and no file or library figure stands behind it (a general question the router took
// for a company ask: grad school, a certificate, a role it has no figures for); negotiation_advice only when no offer
// is on record and the benchmark found no figures. A pay question at a firm with no file is the brain's too (below).
// "file": a File page code built this turn (the interview prep File, 142 handlePrepFile): the handler stores it and sends its link,
// so the turn is code's whatever its intent (BETA C03, 2026-11-04).
const PRODUCT_KEYS = ["payload", "artifact", "bench", "offer", "draft", "ai_answer", "comparison", "documents", "document", "company", "file"];
const has = (r: Record<string, unknown>, k: string) => r[k] !== undefined && r[k] !== null;
export function codeProduct(intent: string, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, any>;
  if (intent === "company_intel") {
    // ROUTER ROUTING ROUND (2026-11-02): a pay question at a firm with no file. The router's answer is "X has no company
    // file yet", with no figure in it; the brain reads the firm's postings (get_posting, search_jobs) and sources under the
    // figure checks, so the question gets an answer instead of stopping there. Any other no-file question stays the router's.
    if (r.payload?.kind === "company_file_absent" && r.payload?.topic === "pay") return false;
    if (has(r, "company") || has(r, "comparison")) return true;
    const kind = String(r.payload?.kind ?? "");
    return !(has(r, "guidance") || /_absent$/.test(kind));
  }
  if (intent === "negotiation_advice") {
    if (has(r, "offer")) return true;
    const figures = r.bench?.figures;
    return Array.isArray(figures) ? figures.length > 0 : has(r, "bench");
  }
  return PRODUCT_KEYS.some((k) => has(r, k));
}

export function routerKept(env: Env): Set<string> {
  return new Set(String(env.get("CAREER_BRAIN_ROUTER_INTENTS") ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

// A deep copy of the turn's state: plain objects and arrays all the way down (cycles kept), functions shared (they are
// seams, not state), anything else structured-cloned or shared as is. The probe's writes can never reach the real
// turn: probeCtx used to copy an object that holds a function one level only, so a probe of "resume my job alerts" resumed
// the real alerts through the shared watch state (launch readiness 2026-10-26; tests/career-bundle-reachability.test.cjs
// caught it on the pool probe).
export function deepTurnCopy<T>(v: T, seen = new Map<unknown, unknown>()): T {
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) return seen.get(v) as T;
  if (Array.isArray(v)) { const out: unknown[] = []; seen.set(v, out); for (const x of v) out.push(deepTurnCopy(x, seen)); return out as T; }
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = proto === null ? Object.create(null) : {};
    seen.set(v, out);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepTurnCopy(x, seen);
    return out as T;
  }
  try { const c = structuredClone(v); seen.set(v, c); return c; } catch { return v; }
}

// A disposable copy of a turn's state for the probe: deep, so nothing the router writes during the probe reaches the real
// turn, nested state included; functions (the batch board seam) are shared. The probe's containment records are its own.
export function probeCtx<T extends Record<string, unknown>>(ctx: T): T {
  const out = deepTurnCopy(ctx) as Record<string, unknown>;
  out.containmentRecords = [];
  return out as T;
}

// An OPEN entry question ("how do I get hired as an investment banker", "how do I break into consulting", "how do I become
// a data analyst"), from any stage, naming no company. The router answers it from the library: a posting-requirements
// definition (company_intel, payload role_kb_stats / role_kb_absent) or a generic path list (path_plan, plan_paths). Neither
// is a researched answer for this person, so with CAREER_KNOWLEDGE=on (the research tool exists) the brain takes it and calls
// research_career_question. Company-specific asks never match here: the router gives them a company file or a campaign, and
// a result carrying a company stays code's. "What do data analyst postings require?" is not an entry question: library.
const ENTRY_VERB = String.raw`(?:get\s+hired|get\s+a\s+job|get\s+an?\s+(?:internship|offer|entry)|get\s+into|get\s+started\s+(?:as|in)|break\s+into|breaking\s+into|become|becoming|be\s+an?|work\s+as|work\s+in|go\s+into|enter|pursue|qualify\s+as|train\s+as|switch\s+(?:in)?to|land\s+an?|start\s+a\s+career)`;
const OPEN_ENTRY_RES: RegExp[] = [
  // "how do I get hired as ...", "how to break into ...", "what should I do to land a job as ..."
  new RegExp(String.raw`\b(?:how\s+(?:do|can|would|should|could)\s+(?:i|we|someone|a\s+\w+)|how\s+to|what(?:'s|\s+is)\s+the\s+(?:best\s+)?way\s+to|what\s+should\s+i\s+do\s+to|where\s+do\s+i\s+(?:even\s+)?start\s+(?:to|if\s+i\s+want\s+to))\b[^?.!]*\b${ENTRY_VERB}\b`, "i"),
  // "what does it take to become ...", "how long does it take to become ...", "what's the path to becoming ..."
  new RegExp(String.raw`\b(?:what\s+(?:does|would|will)\s+it\s+take|how\s+(?:long|hard|much\s+school)\s+(?:does|would|will|is)\s+it(?:\s+take)?|what(?:'s|\s+is)\s+the\s+(?:best\s+)?(?:path|route|road|process|steps?))\b[^?.!]*\b(?:to|into)\s+${ENTRY_VERB}\b`, "i"),
  new RegExp(String.raw`\bwhat(?:'s|\s+is)\s+the\s+(?:best\s+)?(?:path|route|road|process)\s+(?:to|into)\b[^?.!]*\b(?:becoming|being|a\s+career|an?\s+\w+)`, "i"),
  // "where do I even start if I want to be a nurse", "I want to become a nurse, where do I start"
  /\bwhere\s+(?:do\s+i|should\s+i)\s+(?:even\s+)?(?:start|begin)\b[^?.!]*\b(?:want\s+to|trying\s+to|hoping\s+to)\s+(?:be|become|work|get|break)\b/i,
  new RegExp(String.raw`\b(?:want|wanna|hoping|planning|trying|thinking\s+(?:of|about))\s+(?:to\s+)?${ENTRY_VERB}\b[^?.!]*[?.!]?\s*(?:where|how|what)\b[^?.!]*\b(?:start|begin|first|next)\b`, "i"),
  // "do I need a degree to be a ...", "is it too late for me to become ...", "how many years of school to be ..."
  new RegExp(String.raw`\b(?:do\s+i\s+(?:really\s+)?need|does\s+it\s+take|is\s+it\s+too\s+late(?:\s+for\s+me)?|am\s+i\s+too\s+(?:old|late))\b[^?.!]*\bto\s+${ENTRY_VERB}\b`, "i"),
  // "is nursing worth it", "is a career in law a good bet", "is it worth becoming an electrician"
  /\bis\s+(?:a\s+career\s+in\s+|being\s+an?\s+|becoming\s+an?\s+)?[a-z][^?.!,]{1,50}?\s+(?:worth\s+(?:it|doing|pursuing)|a\s+good\s+(?:career|field|major|bet|path|choice|job|profession))\b/i,
  /\bis\s+it\s+worth\s+(?:it\s+)?(?:to\s+)?(?:becoming|become|being|going\s+into|studying|majoring)\b/i,
  // "should I major in X", "should I go into X", "should I become X"
  /\bshould\s+i\s+(?:still\s+)?(?:major|minor|study|specialize|concentrate)\s+in\b/i,
  new RegExp(String.raw`\bshould\s+i\s+(?:still\s+)?(?:go\s+(?:into|to\s+school\s+for)|pursue|become|be\s+an?|enter|switch\s+(?:in)?to|train\s+as)\b`, "i"),
];
// The broad shapes ("be a ...", "is ... worth it", "should I go into ...") also fit "be a Googler" and "work at Stripe". A
// capitalized name is a COMPANY only when (a) it is a known employer or brand, or (b) it follows at/for/with/from and is not a
// place, school or service branch. Everything else (a state, a city we never listed, "nurse in Wichita Falls", "nursing at Ohio
// State", "pharmacist in Puerto Rico") stays an open question: when we cannot tell, the brain takes it, and the research tool and
// the source guard make that safe (no company fact comes from the model). The router still claims real company asks first.
const words = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
const KNOWN_COMPANIES = words(("google alphabet amazon apple microsoft meta facebook instagram whatsapp netflix tesla spacex nvidia intel amd qualcomm broadcom cisco ibm oracle sap salesforce adobe intuit uber lyft doordash instacart airbnb stripe square block paypal venmo coinbase robinhood plaid ramp brex palantir snowflake databricks datadog mongodb openai anthropic deepmind spotify twitter linkedin snap snapchat pinterest reddit tiktok bytedance dropbox slack zoom shopify twilio cloudflare atlassian github gitlab figma notion canva asana okta splunk vmware dell hp lenovo samsung sony ibm " +
  "goldman sachs morgan stanley jpmorgan chase citi citigroup citibank wells fargo barclays deutsche ubs lazard evercore moelis centerview blackstone kkr carlyle apollo citadel jane street blackrock vanguard fidelity schwab visa mastercard amex capital one mckinsey bain bcg deloitte pwc kpmg accenture capgemini booz allen oliver wyman kearney guidehouse " +
  "lockheed boeing raytheon northrop grumman spacex airbus ford toyota honda gm chevrolet bmw volkswagen walmart target costco kroger walgreens cvs home depot lowes nike adidas starbucks mcdonalds disney comcast verizon att tmobile " +
  "unitedhealth kaiser mayo hca cigna aetna humana pfizer moderna merck johnson abbvie genentech exxon chevron shell bp conocophillips ge honeywell caterpillar deere fedex ups usps " +
  "googler googlers amazonian amazonians microsoftie facebooker stripe stripes metamate").replace(/ (?=\w)/g, " "));
const SCHOOL_WORD = /^(?:university|college|institute|academy|school|state|tech|polytechnic|seminary|conservatory|cc)$/i;
const PLACE_WORDS = words(("alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada hampshire jersey mexico york carolina dakota ohio oklahoma oregon pennsylvania rhode island tennessee texas utah vermont virginia washington wisconsin wyoming columbia puerto rico guam " +
  "canada ontario toronto vancouver montreal quebec alberta britain england scotland wales ireland london india australia germany france spain italy china japan korea singapore nigeria brazil netherlands europe asia africa america american canadian british indian united states kingdom emirates zealand philippines pakistan kenya ghana israel turkey poland sweden norway denmark finland switzerland " +
  "atlanta austin boston chicago dallas denver detroit houston miami nashville orlando philadelphia phoenix pittsburgh portland sacramento seattle tampa angeles francisco diego jose vegas orleans louis paul antonio baltimore charlotte columbus cleveland minneapolis brooklyn manhattan queens bronx fresno wichita falls tucson omaha raleigh richmond memphis louisville milwaukee albuquerque oakland tulsa honolulu anchorage boise spokane tacoma madison buffalo rochester albany syracuse cincinnati indianapolis kansas lincoln lexington savannah charleston jacksonville tallahassee birmingham mobile jackson shreveport lubbock amarillo laredo reno provo salt lake cheyenne billings fargo sioux bismarck duluth akron toledo dayton scranton harrisburg hartford providence newark trenton stamford bridgeport worcester springfield manchester burlington bangor " +
  "army navy marines marine force guard coast air space military").replace(/\s+/g, " "));
const CAP_SEQ = /\b[A-Z][a-z]+[A-Z]?\w*(?:\s+(?:of\s+)?[A-Z][a-z]+\w*)*/g;
// A place, a school or a service branch ("Ohio State", "Puerto Rico", "University of Texas"), never a known employer.
export function placeOrSchool(name: string): boolean {
  const toks = name.split(/\s+/).filter((t) => t && t.toLowerCase() !== "of");
  const lower = toks.map((t) => t.toLowerCase());
  if (lower.some((t) => KNOWN_COMPANIES.has(t))) return false;
  return lower.some((t) => PLACE_WORDS.has(t)) || toks.some((t) => SCHOOL_WORD.test(t)) || /\bof\b/i.test(name);
}
export function namesSomeone(span: string): boolean {
  const rest = span.replace(/^\S+\s*/, "");
  for (const m of rest.matchAll(CAP_SEQ)) {
    const seq = m[0], toks = seq.split(/\s+/).filter((t) => t !== "of");
    if (toks.every((t) => t.length < 3)) continue;
    const lower = toks.map((t) => t.toLowerCase());
    const stem = (t: string) => t.replace(/(?:ers|er|s)$/, "");
    if (lower.some((t) => KNOWN_COMPANIES.has(t) || KNOWN_COMPANIES.has(stem(t)))) return true;
    const before = rest.slice(0, m.index).trimEnd().split(/\s+/).pop()?.toLowerCase() ?? "";
    const afterPrep = /^(?:at|for|with|from)$/.test(before);
    if (afterPrep && !placeOrSchool(seq)) return true;
  }
  return false;
}
const OPEN_ENTRY = { test: (m: string) => OPEN_ENTRY_RES.some((r) => { const x = r.exec(m); return !!x && !namesSomeone(m.slice(x.index).split(/[?.!]/)[0]); }) };
const OPEN_ENTRY_KINDS = new Set(["role_kb_stats", "role_kb_absent", "plan_paths"]);
export function openCareerQuestion(env: Env, message: string, intent: string, result: unknown): boolean {
  if (env.get("CAREER_KNOWLEDGE") !== "on") return false;
  // career_os_plan ("the path from freshman to null") and profile_recall (a self-statement such as "I'm on F-1" swallows the
  // question) are the router's generic misses on the same open questions: they carry no library answer, so the brain takes them.
  const GENERIC_MISS = intent === "career_os_plan" || intent === "profile_recall";
  if (intent !== "company_intel" && intent !== "path_plan" && !GENERIC_MISS) return false;
  if (!OPEN_ENTRY.test(message)) return false;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  // The router sometimes reads "at home" or "at night" as a company ("home has no company file yet"). A company the person never
  // capitalized and that is an everyday word is not one: the question is still open.
  const co = typeof r.company === "string" ? r.company : null;
  const spurious = !!co && String(r.payload?.kind ?? "") === "company_file_absent" && (
    (co === co.toLowerCase() && /^[a-z]{2,12}$/.test(co) && !new RegExp(`\\b${co[0].toUpperCase()}${co.slice(1)}`).test(message)) || placeOrSchool(co));
  if ((has(r, "company") && !spurious) || has(r, "comparison") || has(r, "offer")) return false;
  if (GENERIC_MISS || spurious) return true;
  return OPEN_ENTRY_KINDS.has(String(r.payload?.kind ?? r.artifact?.kind ?? ""));
}

// ADVICE QUESTIONS (2026-11-01, the 1v1's outreach and prep turns): a QUESTION about networking or interviews ("how do I
// network into banking with no connections", "what's a good subject line for a cold email", "what should I ask at the end of
// an interview") is advice, but the router reads it as work: outreach_clarification starts a campaign plan for a list nobody
// asked for, and prep_brief answers with a template brief. Neither carries anything the person approved or that sends. These
// go to the brain, which answers the question asked. Instructions stay code's: building a list ("find me engineers at X to
// reach out to"), drafting or sending to someone, a prep brief for a company or posting the person named, and a mock or
// drill that is running. The brain cannot send, apply or save on its own (STAGED_WITHHELD_TOOLS; every external effect needs
// the person's approval of the exact payload on code's path).
const ADVICE_INTENTS = new Set(["outreach_clarification", "prep_brief"]);
const QUESTION_LEAD = /^\s*(?:(?:so|ok|okay|hey|also|and|but|quick question)[,:]?\s+)?(?:how|what|whats|what's|which|when|why|where|who|should|is|are|do|does|did|would|could|any|tips?\b|advice\b|best way)\b/i;
const ASK_TO_ACT = /^\s*(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:send|email|message|text|dm|reach|contact|find|build|make|get|pull|list|draft|write|apply|submit|queue|save|set|start|run|mock|quiz|drill)\b/i;
const LIST_OR_SEND = /\b(?:find|build|pull|get|make|compile)\b[^?.!]*\b(?:list|people|contacts?|names|engineers|analysts|bankers|associates|recruiters|alumni|alums|managers)\b|^\s*(?:please\s+)?(?:send|email|message|text|dm|reach out|contact|apply|submit|queue)\b/i;
export function adviceQuestion(message: string, intent: string | null, result: unknown): boolean {
  if (!intent || !ADVICE_INTENTS.has(intent)) return false;
  const m = String(message ?? "").replace(/[’`]/g, "'").trim();
  if (!(QUESTION_LEAD.test(m) || /\?\s*$/.test(m)) || ASK_TO_ACT.test(m) || LIST_OR_SEND.test(m)) return false;
  // A company or a posting the person named gets code's product for it (the firm's file, the posting's brief).
  if (namesSomeone(m)) return false;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  // A File page code built for the ask (BETA C03: "could you make me a one-page prep File?") is an instruction carried out, not advice.
  if (has(r, "draft") || has(r, "documents") || has(r, "document") || has(r, "file") || has(r, "offer") || has(r, "company") || (r.sends ?? 0) > 0) return false;
  // A mock, drill or answer score in progress is code's session.
  if (r.resultStatus === "running" || has(r, "question")) return false;
  const kind = String(r.payload?.kind ?? r.artifact?.kind ?? "");
  if (intent === "outreach_clarification") return !kind || kind === "campaign_plan";
  return !/mock|drill|answer_score|session/i.test(kind);
}

// A File page ask ("show me a File page for getting started with job applications. Do not apply or submit anything") is not a
// job search, but the router reads its words as one: the "role" it searches for is "file page getting started applications do
// submit anything", the list is empty, and the person is told "Nothing to show yet" with no page. When every word the search
// would use is a File-page or process word, and the ask states no place, pay, level, company, season, sponsorship or remote
// limit, there is no search to run: the brain (which can make the page, create_file, and cannot apply: STAGED_WITHHELD_TOOLS)
// takes it. An ask that names any role ("a File page of data analyst jobs") or any limit stays a search, on code's path.
const FILE_PAGE_ASK = /\b(?:show|open|give|send|make|create|build|get|share|see)\b[^.?!]{0,40}\bfile page\b|\bfile page\b[^.?!]{0,60}\b(?:for|about|on|to)\b/i;
const FILE_PAGE_WORDS = new Set(("file page pages a an the my me us our your for of on about to with and or in into from by at as is it this that these those please can could would will you i " +
  "show open give send make create build get see share start started starting getting begin beginning guide intro introduction overview basics steps how help new first " +
  "job jobs application applications apply applying submit submitting submission anything nothing do does not dont don't never without any all no and").split(/\s+/));
const SEARCH_LIKE = new Set(["career_discovery", "career_internship_discovery"]);
export function filePageAsk(message: string, ask: { role?: string; place?: string | null; remote?: boolean; remoteOnly?: boolean; limits?: object } | null | undefined): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'");
  if (!FILE_PAGE_ASK.test(m)) return false;
  if (!ask) return true;
  const L = (ask.limits ?? {}) as Record<string, unknown>;
  const limited = Object.values(L).some((v) => Array.isArray(v) ? v.length > 0 : !!v);
  if (ask.place || ask.remote || ask.remoteOnly || limited) return false;
  return String(ask.role ?? "").toLowerCase().split(/[^a-z']+/).filter(Boolean).every((w) => FILE_PAGE_WORDS.has(w));
}

// A CAREER SWITCHER'S OPEN ASK ("can u look at jobs for me im a cashier wanna do something w computers"): the person names the
// work they do now and a field they want to move toward, but no role. The router reads it as a job search with no role, finds
// an empty pool and answers "Nothing to show yet" (asking for a resume), which names no way in: the person asked where to
// start and got a dead end (eval H034, failing 5 of 5 passes). With no role to search for, there is nothing for code to run:
// the brain takes it, names realistic entry roles from the work they do now (prompt.ts, "A change with no target role named
// yet"), reads real postings with search_jobs, and asks which to pursue. Both halves must be in the words (where they are now,
// where they want to go) and the router's own result must be empty with no role family asked: a search that found or asked
// for anything stays code's.
const SWITCH_FROM = /\b(?:i'?m|im|i\s+am|i\s+work\s+as|i\s+worked\s+as|i\s+used\s+to\s+(?:be|work\s+as))\s+(?:a|an)\s+[a-z][a-z -]{1,30}/i;
const SWITCH_TO = /\b(?:wanna|want\s+to|trying\s+to|hoping\s+to|looking\s+to|like\s+to|would\s+like\s+to|thinking\s+of|ready\s+to)\s+(?:do|work|get\s+into|move\s+(?:in)?to|switch\s+(?:in)?to|go\s+into|try|change)\s+(?:something|anything|stuff|work)\s+(?:with|w|w\/|in|involving|around|using|related\s+to)\s+(?:computers?|tech(?:nology)?|data|software|coding|code|programming|design|health(?:care)?|finance|marketing|science|engineering|cars?|music|art|writing)\b|\bcareer\s+(?:change|switch|pivot)\b|\bchange\s+careers\b|\bswitch\s+careers\b/i;
export function careerSwitcherOpenAsk(message: string, intent: string | null, result: unknown): boolean {
  if (!intent || !SEARCH_LIKE.has(intent)) return false;
  const m = String(message ?? "").replace(/[’`]/g, "'");
  if (!SWITCH_FROM.test(m) || !SWITCH_TO.test(m)) return false;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  if (Array.isArray(r.shortlist) ? r.shortlist.length > 0 : has(r, "shortlist")) return false;
  if (Array.isArray(r.requested_families) && r.requested_families.length > 0) return false;
  return true;
}

export type StagedDecision = { brain: boolean; mode: BrainMode; intent: string | null; reason: string };

// Whether this turn goes to the brain in staged mode. Called only after every code-first turn has passed on it.
export function stagedDecision(o: { env: Env; message: string; ctx: Record<string, unknown>; host: Host; structured: boolean; clock?: TurnClock }): StagedDecision {
  const clock = o.clock ?? NO_CLOCK;
  const mode = brainMode(o.env);
  if (mode !== "staged") return { brain: false, mode, intent: null, reason: "not_staged" };
  if (o.structured) return { brain: false, mode, intent: null, reason: "structured_request" };
  if (o.host.isHostControlled(o.message, o.ctx)) return { brain: false, mode, intent: null, reason: "host_control" };
  // Crisis text is code's (crisis.ts): never the brain's, whatever the router would class it as.
  if (crisisReply(o.message) !== null) return { brain: false, mode, intent: null, reason: "crisis" };
  // Spec 2.3: a correction to the last search ("remote only", "only individual-contributor roles") changes its constraints in
  // code (search_correction.ts) and the next results use them; it is not a question for the brain.
  if (correctedAsk(o.message, o.ctx.discovery)) return { brain: false, mode, intent: null, reason: "search_correction" };
  let probe, records: any[] = [];
  try { const copy = clock.sync("staged_probe_copy", () => probeCtx(o.ctx)); probe = clock.sync("staged_probe_router", () => o.host.runTurn(o.message, copy)); records = Array.isArray(copy.containmentRecords) ? copy.containmentRecords as any[] : []; }
  catch { return { brain: false, mode, intent: null, reason: "probe_failed" }; }
  let intent: string | null;
  if (probe.contained) {
    // Containment answers two ways: no module claimed the turn (null_result, the router's "I didn't catch that"), which
    // is the brain's; or a module claimed it and crashed, which stays the router's contained reply.
    if (records.at(-1)?.boundary !== "null_result") return { brain: false, mode, intent: null, reason: "router_contained" };
    intent = UNCLAIMED;
  } else intent = probe.intent ?? null;
  if (!intent) return { brain: false, mode, intent: null, reason: "router_claimed" };
  if (routerKept(o.env).has(intent)) return { brain: false, mode, intent, reason: "kept_on_router" };
  if (SEARCH_LIKE.has(intent) && filePageAsk(o.message, askFor(o.message, { intent, resultStatus: probe.result?.resultStatus }, o.ctx.discovery)?.ask)) return { brain: true, mode, intent, reason: "file_page_ask" };
  if (careerSwitcherOpenAsk(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "career_switcher_open_ask" };
  if (openCareerQuestion(o.env, o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "open_career_question" };
  if (adviceQuestion(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "advice_question" };
  if (!STAGED_BRAIN_INTENTS.includes(intent)) return { brain: false, mode, intent, reason: "action" };
  if (codeProduct(intent, probe.result)) return { brain: false, mode, intent, reason: "code_product" };
  return { brain: true, mode, intent, reason: "question" };
}

// Tool policy for the staged brain, at the boundary. No tool has an external effect (the loop never runs one). Withheld:
// the tools whose action has a code-first owner on the live path, so there is one writer each, and a paid check.
//   queue_applications  "apply to ..." is code's (applyTurn: the employer guard and the person's own pace).
//   set_job_alerts, stop_job_alerts  the watch bridge is the one writer of career_alert_prefs (D-032).
//   verify_contacts     a paid provider check (Hunter): no new spend without the owner.
export const STAGED_WITHHELD_TOOLS: readonly string[] = ["queue_applications", "set_job_alerts", "stop_job_alerts", "verify_contacts"];
export const STAGED_PROMPT_NOTE = "In this conversation you answer questions and give advice. Applying to a posting, starting or stopping job alerts, " +
  "and checking contacts are done by code when the person asks for them in their own words, for example \"apply to the <role> role at <company>\" " +
  "or \"watch <role> roles in <city>\". You cannot do those here; say so plainly when asked, after any acknowledgement the person needs and alongside the part you can do now (search, shortlist, explain), and never say they were done.";
export const STAGED_TOOL_POLICY = { withhold: STAGED_WITHHELD_TOOLS, note: STAGED_PROMPT_NOTE } as const;

// Lazy and memoized: the probe runs only when the handler reaches the brain test, at most once a turn.
export function stagedRoute(o: { env: Env; message: string; ctx: Record<string, unknown>; host: Host; structured: boolean; clock?: TurnClock }) {
  let d: StagedDecision | null = null;
  return {
    toBrain(): boolean { d ??= stagedDecision(o); return d.brain; },
    get decision(): StagedDecision | null { return d; },
    get chosen(): boolean { return !!d?.brain; },
  };
}
