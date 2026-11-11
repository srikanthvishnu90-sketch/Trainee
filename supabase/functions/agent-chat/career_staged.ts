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
// touched), and its intent decides, except that a turn that asks something or forbids an action is the brain's unless the
// router's intent is code's own work (questionTurn, 2026-11-06); the router's answer then reaches the brain as data
// (routerAnswerBlock). A turn the brain does not take runs through the router again on the real state, as
// it does today, so what the router saves is exactly what it saved before.

import { servedBrain } from "./release_config.ts";
import { NO_CLOCK, type TurnClock } from "./turn_clock.ts";
import { crisisReply } from "./crisis.ts";
import { PAYLOAD_INTENTS } from "../_shared/career_reply_writer.ts";
import { multiAsk, nonEnglishAsk, severalAsks } from "../_shared/ask_language.ts";
import { boundaryOf, correctionOf, hypotheticalOf } from "../_shared/agent/turn_notes.ts"; // D-061 G1, G8, G9

type Env = { get(k: string): string | undefined };
type Host = { runTurn(text: string, ctx: any): { intent: string | null; handler: string | null; reply?: string; contained?: boolean; result?: any }; isHostControlled(text: string, ctx: any): boolean };

import { correctedAsk, refinedAsk } from "../_shared/search_correction.ts";
import { askFor } from "../_shared/career_search_judge.ts";
import { namedDraftAsk, outreachAsk } from "../_shared/outreach_ask.ts";
import { researchReplyOn } from "../_shared/research_reply.ts"; // D-047
import { knowledgeOn } from "../_shared/agent/knowledge/index.ts"; // D-060
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
  // THE MODEL DECIDES QUESTIONS (2026-11-06, beta C02/C11/D5): the router's fixed replies to these are recipes, not sourced
  // facts or actions ("what application forms usually ask for", the "current openings are unverified" recipe, the two-line
  // approval rule). The brain answers the question asked, with the router's answer as data (routerAnswerBlock). prep_brief
  // only while no session or File is running (codeProduct, sessionRunning).
  "career_application_fields", "career_recommendations", "career_approval_rule", "prep_brief",
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
  // career_recommendations' guidance, payload and artifact are its recipe text, not a sourced record: only a real artifact
  // (a File, a draft, an offer, a document) keeps it code's. prep_brief likewise, and a running prep session stays code's.
  if (intent === "career_recommendations") return ARTIFACT_KEYS.some((k) => has(r, k));
  if (intent === "prep_brief") return ARTIFACT_KEYS.some((k) => has(r, k)) || sessionRunning(r);
  return PRODUCT_KEYS.some((k) => has(r, k));
}
// A real artifact code built this turn: the handler stores, shows or holds it, so the turn is code's whatever its shape.
// "company", "bench" and "comparison" are sourced records (facts about a firm or pay come only from one: D-007).
// "brief": a company or posting brief built from its file; "target": the people list code is building for an outreach ask.
const ARTIFACT_KEYS = ["file", "draft", "offer", "documents", "document", "company", "comparison", "bench", "brief", "target"];
// A mock, drill or answer score in progress (or a question waiting for its answer) is code's session.
function sessionRunning(r: Record<string, any>): boolean {
  if (r.resultStatus === "running" || has(r, "question")) return true;
  return /mock|drill|answer_score|session/i.test(String(r.payload?.kind ?? r.artifact?.kind ?? ""));
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
  if (!knowledgeOn(env)) return false; // D-060: a release flag, read through releaseFlagOn
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
const SHOW_DRAFT = /\b(?:(?:show|view)\s+(?:me\s+)?|see\s+|give\s+me\s+)(?:the|my|that|this|your|a)?\s*(?:(?:counter|cover|follow[- ]?up|outreach|thank[- ]you)\s+)?(?:draft|email|e-mail|message|note|letter)\b|\blet me see\b[^?.!]{0,20}\bdraft\b/i;
export function adviceQuestion(message: string, intent: string | null, result: unknown): boolean {
  if (!intent || !ADVICE_INTENTS.has(intent)) return false;
  const m = String(message ?? "").replace(/[’`]/g, "'").trim();
  if (!(QUESTION_LEAD.test(m) || /\?\s*$/.test(m)) || ASK_TO_ACT.test(m) || LIST_OR_SEND.test(m)) return false;
  // "show me the draft?" asks code to show its draft (Greptile record 4), whatever the punctuation.
  if (SHOW_DRAFT.test(m)) return false;
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

// COUNTER DECISION (BETA C04, 2026-11-06): "They offered me $24/hour. Should I counter? If yes, draft the email" is a decision
// question first. The router can only draft, and with no ask figure from the person it drafts around a blank (awaiting
// target_hourly_rate) that it cannot approve: it never decides whether to counter. That turn goes to the brain, which
// answers the decision from the offer, the confirmed facts and its read tools, and cannot send (STAGED_WITHHELD_TOOLS). The
// router's held draft is the fallback when the brain is not served. A counter with a figure the person named stays code's.
// Figures the router cannot attribute (a current-job phrase, two pay figures, no offer word): it saves and drafts nothing and holds the
// turn (counterAmbiguous); the brain asks which figure is the employer's new offer.
export function counterAmbiguousAsk(intent: string | null, result: unknown): boolean {
  if (!intent?.startsWith("negotiation") || !result || typeof result !== "object") return false;
  const r = result as Record<string, any>;
  return r.counterAmbiguous === true && (r.sends ?? 0) === 0 && !r.draft;
}

export function counterDecisionAsk(message: string, intent: string | null, result: unknown): boolean {
  if (intent !== "negotiation_draft" || !result || typeof result !== "object") return false;
  const r = result as Record<string, any>;
  return r.awaiting === "target_hourly_rate" && r.counterDecision === true && (r.sends ?? 0) === 0 && /\bshould\b|\bworth\b/i.test(String(message ?? ""));
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

export type StagedDecision = { brain: boolean; mode: BrainMode; intent: string | null; reason: string; router?: RouterAnswer; rules?: RouterAnswer; ambiguousFigures?: { value: number; unit: string }[]; ambiguousRole?: "offer" | "ask" };

// Whether this turn goes to the brain in staged mode. Called only after every code-first turn has passed on it.
// R9-C MARKET RESEARCH (2026-11-07): with CAREER_RESEARCH_REPLY=on, a market research ask ("what would change the market for X",
// "compare these 3 companies", "salary for a role in a city") goes to the brain, which has research_market and decides whether the
// turn needs research and in what format. Off, nothing here applies. Code's own work stays code's: an exact payload, an approval, a
// write, and a search the person asked for ("find me analyst jobs in Austin"); a pay question is not a job search.
const MARKET_ASK: RegExp[] = [
  /\b(?:what|which)\b[^?.!]{0,40}\b(?:would|could|will|might)\s+(?:change|shift|disrupt|move|shape|drive)\b[^?.!]{0,40}\b(?:market|industry|sector)\b/i,
  /\b(?:market|industry|sector)\s+(?:for|outlook|trends?|size|share|research|analysis|landscape)\b/i,
  /\bcompare\b[^?.!]{0,80}\b(?:compan(?:y|ies)|firms?|employers?|startups?|businesses)\b|\bcompare\s+(?:these|those|the)\s+(?:\d|two|three|four)\b/i,
  /\b(?:salary|salaries|pay|compensation|wages?)\s+(?:for|of)\b[^?.!]{1,60}\bin\s+\S/i,
  /\bhow\s+much\s+(?:do|does|can|would)\b[^?.!]{1,60}\b(?:make|earn|get\s+paid)\b/i,
];
// R9-F RESEARCH ROUTING (2026-11-07): the end-to-end eval (evals/career/e2e, research area) found "research the data analyst job
// market in Chicago and give me a file" claimed as a document delivery ("there is no document file yet") and never researched.
// A research ask is also: research as the verb ("research Stripe as an employer", "research this market", "now research those
// companies"), a brief or report asked for about a subject ("make me a brief on X", "a report about Y"), "compare X and Y" or
// "X vs Y" about anything but the person's own papers, a job, labor or internship market, how big a market is, and what a role
// earns. "Give me a file" then names the research brief File, not a document: such an ask passes over the document-delivery
// claim (RESEARCH_OVER) unless it is about the person's own papers ("send me my resume as a file" stays where it was).
const RESEARCH_ASK: RegExp[] = [
  /(?:^|[.!?;,]\s*|\b(?:now|please|pls|can\s+you|could\s+you|would\s+you|will\s+you|i\s+(?:want|need)\s+you\s+to|help\s+me|go|and|then|also)\s+)research\s+(?!(?:jobs?|roles?|openings?|postings?)\b)\S/i,
  /\b(?:do|run|make|need|want)\s+(?:some\s+|a\s+(?:bit\s+of\s+)?)?research\s+(?:on|about|into|for)\b/i,
  /\b(?:brief|briefing|report|deep[\s-]?dive|analysis|overview|rundown|write[\s-]?up)\s+(?:on|about|of|for|covering)\s+(?!(?:me|my|mine)\b)\S/i,
  /\b(?:market|industry|sector)\s+(?:brief|report|deep[\s-]?dive|overview|map)\b/i,
  /\b(?:job|jobs|labou?r|hiring|talent|internship|intern|employment|graduate|grad)\s+market\b/i,
  /\bhow\s+(?:big|large|competitive|hot|crowded)\b[^?.!]{0,60}\bmarket\b|\bmarket\s+(?:in|across)\s+\S/i,
  /\bcompare\s+\S[^?.!]{0,60}?\s(?:and|with|to|vs\.?|versus)\s+\S|\b\w+\s+(?:vs\.?|versus)\s+\w+/i,
  /\bwhat\s+(?:do|does|would|can|will)\b[^?.!]{1,60}\b(?:earn|make|get\s+paid)\b/i,
  // An employer as the subject (2026-11-08, e2e full set: research.employer 23/50, 27 claimed as document delivery): "what's
  // Stripe like to work for", "what is it like to work at Ramp", "how is Notion as a place to work", "how's Ramp to work for",
  // "is Ramp a good place to start?", "Ramp as an employer", "can u research Ramp", Spanish "investiga Ramp como empleador".
  /\bwhat(?:'?s|\s+is|\s+are|\s+was)\s+(?:it\s+)?[^?.!]{0,60}?\blike\s+to\s+work\s+(?:for|at|with|in)\b/i,
  /\bhow(?:'?s|\s+is|\s+are|\s+was)\s+[^?.!]{1,60}?\s+(?:as\s+(?:a\s+|an\s+)?(?:place\s+to\s+work|employer|company\s+to\s+work\s+for|first\s+job)|to\s+work\s+(?:for|at))\b/i,
  /\b(?:is|are)\s+[^?.!]{1,60}?\s+an?\s+(?:\w+\s+)?(?:place|company|employer|firm)\s+to\s+(?:start|work|begin|join|launch)\b/i,
  /\b(?:is|are)\s+[^?.!]{1,60}?\s+an?\s+(?:good|great|bad|decent|solid|safe|smart)\s+(?:employer|company|place)\b/i,
  /\bas\s+an?\s+(?:employer|place\s+to\s+(?:work|start))\b/i,
  /\b(?:can|could|would|will)\s+(?:u|ya)\s+research\s+\S/i,
  /\binvestiga(?:r|me)?\s+\S/i,
];
// The person's own papers (resume, cover letter, an application, an offer): a file of THOSE is a document, never research.
const OWN_PAPERS = /\b(?:my|mine|our|the|that|this|these|those)\s+(?:tailored\s+|updated\s+|latest\s+|new\s+|current\s+|last\s+)?(?:r[eé]sum[eé]s?|cvs?|cover\s+letters?|transcripts?|portfolio|applications?|packets?|offers?|offer\s+letters?|essays?|drafts?|pdfs?|documents?|docs?|references?)\b/i;
// Review of #589 (2026-11-08): the person's own record, as a whole ("give me an overview of everything I applied to", "a rundown
// of all the jobs I've applied for", "a report on all my applications"), is an export, never market research.
const OWN_RECORD = /\b(?:everything|all(?:\s+of)?(?:\s+(?:the|my))?(?:\s+(?:stuff|things|ones|jobs?|roles?|positions?|places|applications?|apps))?|each|every\s+(?:job|role|application|place))\s+(?:that\s+)?(?:i|we)(?:'ve|\s+have|\s+had|'d)?\s+(?:ever\s+)?(?:applied|sent|submitted|saved|done)\b|\b(?:brief|briefing|report|analysis|overview|rundown|write[\s-]?up|summary)\s+(?:on|about|of|for|covering)\s+(?:everything|all\s+(?:of\s+)?(?:my|mine|it))\b/i;
const RESEARCH_OVER = new Set(["career_document_delivery", "profile_export"]);
// R10 WO-H fix 14 (spec B.6 continuation 5): "I have a Stripe analyst interview. Tell me what I should know, not a generic company
// overview." A named company's interview (a capitalized name before "interview") with what to know or ask is company research
// (research_company), not the router's company-intel recipe. "What should I ask in my interview?" names no company and stays prep.
const INTERVIEW_AT = /\b(?:have|got|landed)\s+(?:an?\s+)?(.{2,48}?)\s+interviews?\b/i;
// Item 10 loop: also "... and 5 good questions to ask" and "what they do, what's new".
const KNOW_OR_ASK = /\bwhat\s+(?:i\s+should|should\s+i|to|i\s+need\s+to|do\s+i\s+need\s+to)\s+(?:know|ask)\b|\b(?:research|brief\s+me\s+on|tell\s+me\s+about)\b|\bquestions?\s+(?:to|i\s+(?:should|could)|should\s+i)\s+ask\b/i;
// Item 10 loop: "what should I ask the hiring manager at Orbit Freight?", "what should I ask in my Orbit Freight interview?": a question
// to ask a named company's people is company research. "What should I ask in my interview?" names no company and stays prep.
const ASK_AT = /\b[Ww]hat\s+(?:should|could|do)\s+[Ii]\s+ask\b[^?!.]{0,60}?\b(?:at|in\s+my|for\s+my|with)\s+(\p{Lu}[\p{L}&.-]+)/u;
// Review F2 (item 6): also "an interview at/with <Name>" ("I have an interview at Stripe next week, what should I know?") and research
// about a named company before the interview ("Tell me about Stripe's business before my interview, do not apply").
const INTERVIEW_WITH = /\binterview(?:s|ing)?\s+(?:at|with)\s+(\p{Lu}[\p{L}&.-]+)/u;
const ABOUT_BEFORE = /\b(?:tell\s+me\s+about|research|brief\s+me\s+on|what\s+should\s+i\s+know\s+about|look\s+into)\s+(\p{Lu}[\p{L}&.-]+)[^?!]{0,80}?\b(?:before|for|ahead\s+of)\s+(?:my|the|an?|this|that)\s+(?:\w+\s+){0,2}interview/iu;
export function companyInterviewAsk(message: string): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'"), hit = INTERVIEW_AT.exec(m);
  if (hit && /(?<![\p{L}])\p{Lu}[\p{L}&.-]+/u.test(hit[1]) && KNOW_OR_ASK.test(m)) return true;
  const w = INTERVIEW_WITH.exec(m);
  if (w && !/^(?:I|My|The|A|An)$/.test(w[1]) && (KNOW_OR_ASK.test(m) || /\b(?:prepare|prep|ready)\b/i.test(m))) return true;
  const at = ASK_AT.exec(m);
  if (at && !/^(?:I|My|The|A|An)$/.test(at[1])) return true;
  const b = ABOUT_BEFORE.exec(m);
  return !!b && /^\p{Lu}/u.test(b[1]) && !/^(?:I|My|The|A|An)$/.test(b[1]);
}
// R10 WO-H, spec F.2 (owner's production turns, 2026-11-08 6:03-6:04 pm): "What's Stripe like to work for as a data analyst intern?
// Give me a useful company research answer ... Don't apply or contact anyone." was claimed as a batch apply (career_batch_apply ->
// BATCH_NOT_STARTED_REPLY), and the correction "I'm not asking for an application batch. I only want company research about
// Stripe ..." as a people list (outreach_clarification -> "Building the list now: 5 analysts at Stripe"). A research ask that sets
// a no-action boundary ("don't apply or contact anyone", "I'm not asking for an application batch") is research, whatever the
// router's keywords say: never applications, introductions or outreach. The boundary is the person's own words.
const NO_ACTION = /\b(?:don'?t|do\s+not|never|without)\s+(?:apply(?:ing)?|contact(?:ing)?|email(?:ing)?|messag(?:e|ing)|reach(?:ing)?\s+out)\b|\bnot\s+asking\s+(?:you\s+)?(?:for|to)\s+(?:an?\s+)?(?:application|apply|batch|list|introductions?|outreach)/i;
const COMPANY_RESEARCH = /\b(?:[Cc]ompany|[Ee]mployer)\s+research\b|\bresearch\s+(?:about|on|into)\s+\p{Lu}|\bwhat(?:'s|\s+is)\s+\p{Lu}[\p{L}&.-]*\s+like\s+to\s+work\s+(?:for|at)\b/u;
export function researchOverAction(message: string): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'");
  return NO_ACTION.test(m) && (COMPANY_RESEARCH.test(m) || researchAsk(m));
}
// R10 WO-H fix 14b: "write a thank-you note to Maya after my interview" was read as an application-tracking log (tracking_log),
// and "draft a follow-up email for my Stripe interview" as a general question. An ask to write, draft or redo a thank-you or
// follow-up message is the brain's draft_followup, which checks the draft in code before it is shown and sends nothing.
const FOLLOWUP_DRAFT = /\b(?:write|draft|compose|help\s+me\s+(?:write|with)|redo|rewrite|make|send\s+me)\b[^?.!]{0,40}\b(?:thank[\s-]?you|follow[\s-]?up)\s*(?:note|email|e-mail|message|letter|text)?\b/i;
export const followupDraftAsk = (message: string) => FOLLOWUP_DRAFT.test(String(message ?? "").replace(/[\u2019`]/g, "'"));
// Review F2 (item 8, spec B.6 continuation 4): once the thread's last reply was a draft (career_followup_draft), a short change or send
// ask about it stays with the draft: "Make it warmer.", "A little less formal.", "Send this one.", "Now send it to Maya.", "Maya at
// the company.", "What would you say?". Without a draft as the last reply nothing changes ("make it warmer" is then the resume's).
export const FOLLOWUP_INTENT = "career_followup_draft";
const DRAFT_CONT = /^(?:ok(?:ay)?[,.]?\s+|now\s+|and\s+|please\s+)?(?:(?:make\s+it|a\s+(?:little|bit)|bit|slightly|more|less)\b.{0,30}\b(?:warm(?:er)?|friendl(?:y|ier)|formal|casual|short(?:er)?|long(?:er)?|soft(?:er)?|polite|direct|personal)|(?:send|share|forward)\s+(?:this|it|that)(?:\s+one)?(?:\s+to\s+.{1,40})?|(?:it'?s\s+for|to|for)\s+\p{Lu}[\p{L}'-]+.{0,40}|\p{Lu}[\p{L}'-]+\s+at\s+(?:the\s+)?.{1,40}|what\s+would\s+you\s+(?:say|write)|(?:shorter|warmer|friendlier|less\s+formal|more\s+casual))[.!?]?$/iu;
export const draftContinuation = (message: string) => DRAFT_CONT.test(String(message ?? "").replace(/[\u2019`]/g, "'").trim());
export function researchAsk(message: string): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'");
  return !OWN_PAPERS.test(m) && !OWN_RECORD.test(m) && (RESEARCH_ASK.some((r) => r.test(m)) || MARKET_ASK.some((r) => r.test(m)) || companyInterviewAsk(m));
}
const SEARCH_ASK = /\b(?:find|show|search|look\s+for|get|pull|list)\b[^?.!]{0,40}\b(?:jobs?|roles?|openings?|postings?|internships?|positions?)\b/i;
const SEARCH_INTENTS = new Set(["career_discovery", "career_internship_discovery", "discovery_dead_board"]);
export function marketResearchAsk(env: Env, message: string, intent: string | null): boolean {
  if (!researchReplyOn(env)) return false;
  if (OWN_RECORD.test(String(message ?? "").replace(/[\u2019`]/g, "'"))) return false;
  const market = MARKET_ASK.some((r) => r.test(message)), research = researchAsk(message);
  if (!market && !research) return false;
  if (intent && SEARCH_INTENTS.has(intent)) return !SEARCH_ASK.test(message);
  if (intent && RESEARCH_OVER.has(intent)) return research;
  return !(intent && CODE_OWNED_INTENTS.has(intent));
}
// The router's own outreach and networking intents (R9 outreach routing leaves them to their rules).
const DRAFT_MISREAD: ReadonlySet<string> = new Set(["career_document_delivery", "career_people_alumni", "outreach_clarification", "career_stop_workflow", "career_tailor", "career_fallback", "career_catchall"]);
const OUTREACH_OWN = /^(?:outreach|career_outreach|career_networking|career_people|networking)/;
const LIST_FOLLOWUP = /^\s*(?:(?:and|so|but|ok(?:ay)?),?\s+)?why\s+(?:not|didn't\s+you\s+(?:include|list|show|pick))\s+(?:that|the|this)\s+[^?.!]{1,40}?\s*one\b/i;
const QUESTION_TO_ASK = /\b(?:won't|will\s+not|wouldn't|would\s+not|doesn't|does\s+not|not)\s+sound\s+(?:copied|generic|canned|scripted|rehearsed|memori[sz]ed)\b|\bquestions?\b[^.?!]{0,30}\b(?:to\s+ask|i\s+(?:can|could|should)\s+ask|for\s+(?:them|the\s+(?:interviewer|panel|recruiter|hiring\s+manager)))\b/i;
const PACKET_ASK = /\b(?:packet|application|answers?)\b/i, RESUME_FILE = /\b(?:r[eé]sum[eé]|cv|pdf|docx)\b/i;
export function followupOffTask(message: string, intent: string, result: unknown, ctx: Record<string, unknown>): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'"), r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  const d = (ctx as any)?.discovery;
  if (intent === "company_intel") return LIST_FOLLOWUP.test(m) && !!(d?.lastParams || (Array.isArray(d?.lastShortlist) && d.lastShortlist.length));
  if (intent === "prep_brief") return r.question?.kind === "bank_question" && QUESTION_TO_ASK.test(m) && !/\b(?:mock|practi[cs]e|drill|quiz)\b/i.test(m);
  if (intent === "career_document_delivery") return !(Array.isArray(r.documents) && r.documents.length) && PACKET_ASK.test(m) && !RESUME_FILE.test(m);
  return false;
}
const NON_ENGLISH_KEPT = /^(?:conversation_|intent_cancelled|intent_recipient_change|prep_mock|negotiation_roleplay|career_erase|career_profile_erased|career_paused|career_resumed|paused_|pause_status|career_pending_approvals|career_approval|career_batch_apply|doorstep_|queue_|captcha_|portal_|disconnect|connect_|intent_opt_out|people_matching_stop)/;
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
  if (correctedAsk(o.message, o.ctx.discovery) || refinedAsk(o.message, o.ctx.discovery)) return { brain: false, mode, intent: null, reason: "search_correction" };
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
  // Spec F.2: research with a no-action boundary is the brain's research turn, before any rule that keeps the router's intent.
  if (researchReplyOn(o.env) && researchOverAction(o.message)) return { brain: true, mode, intent, reason: "company_research" };
  if (routerKept(o.env).has(intent)) return { brain: false, mode, intent, reason: "kept_on_router" };
  if (marketResearchAsk(o.env, o.message, intent)) return { brain: true, mode, intent, reason: "market_research" };
  // MIRROR-1000 gaps (2026-11-11): the router's words are English. A non-English ask it claimed from one English keyword is
  // the brain's, which answers in the person's language (ask_language.ts). Payloads, bare replies, mock sessions and the
  // account's controls stay code's.
  if (nonEnglishAsk(o.message) && !PAYLOAD_INTENTS.has(intent) && !NON_ENGLISH_KEPT.test(intent)) return { brain: true, mode, intent, reason: "non_english" };
  // D-058 ruling 3: two asks in one message are the model's, which answers both; the router keeps single asks, payload intents
  // included. The account's controls, approvals and bare replies stay code's (the same set the non-English route keeps).
  if (multiAsk(o.message) && !NON_ENGLISH_KEPT.test(intent)) return { brain: true, mode, intent, reason: "multi_part" };
  // MIRROR-1000: a draft to a named person that the router read as a file ask, an alumni list or a missing recipient is the
  // brain's drafting turn (outreach_ask.ts namedDraftAsk).
  if (DRAFT_MISREAD.has(intent) && namedDraftAsk(o.message)) return { brain: true, mode, intent, reason: "named_draft" };
  if ((!CODE_OWNED_INTENTS.has(intent) || intent === "tracking_log") && followupDraftAsk(o.message)) return { brain: true, mode, intent, reason: "followup_draft" };
  // H2H fix 4 (docs/architect/INSTINCT-HEAD-TO-HEAD.md C2 t5, C5 t4, C3 t6): a follow-up stays on the thread's current task. The
  // router read each from a keyword and answered a different ask: "Why not that Stripe one?" after a search got Stripe's
  // software-engineering file; "Give me one question that will not sound copied" during interview research got a mock-interview
  // question; "just send me the packet" with no file got "no resume has been tailored". Each is the brain's, which has the thread.
  if (followupOffTask(o.message, intent, probe.result, o.ctx)) return { brain: true, mode, intent, reason: "followup_on_task", router: routerAnswer(intent, probe) };
  // A change or send ask about the draft just shown (the handler marks the turn: ctx._draftThread, from the thread's last reply).
  // "Make it warmer." is career_tailor's resume draft only when no follow-up draft was just shown; other exact payloads stay code's.
  if ((o.ctx as any)._draftThread === true && draftContinuation(o.message) && (!PAYLOAD_INTENTS.has(intent) || intent === "career_tailor")) return { brain: true, mode, intent, reason: "draft_continuation" };
  if (SEARCH_LIKE.has(intent) && filePageAsk(o.message, askFor(o.message, { intent, resultStatus: probe.result?.resultStatus }, o.ctx.discovery)?.ask)) return { brain: true, mode, intent, reason: "file_page_ask" };
  if (careerSwitcherOpenAsk(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "career_switcher_open_ask" };
  if (openCareerQuestion(o.env, o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "open_career_question" };
  if (adviceQuestion(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "advice_question", router: routerAnswer(intent, probe), rules: approvalRules(o, intent, clock) };
  if (counterAmbiguousAsk(intent, probe.result)) return { brain: true, mode, intent, reason: "counter_ambiguous_figures", ambiguousFigures: (probe.result as any).figures, ambiguousRole: (probe.result as any).awaiting === "which_figure_is_ask" ? "ask" : "offer" };
  if (counterDecisionAsk(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "counter_decision" };
  // R9 OUTREACH ROUTING (2026-11-08): an ask to write to a person or a role at a firm that code's networking turn could not
  // read (a typo in the verb, Spanish, Hindi in Latin script), which the router then claimed for something else from a
  // keyword ("the internship timeline" got the career timeline, "how they got started" the company-intel recipe), is the
  // brain's: it drafts from the person's own contacts (draft_outreach; nothing is sent until they approve the exact
  // message). The router's own outreach intents keep their rules (an instruction to email stays code's), and so does code's
  // own work (an exact payload, a card, the apply queue, a bare yes or no).
  if (!CODE_OWNED_INTENTS.has(intent) && !OUTREACH_OWN.test(intent) && outreachAsk(o.message)) return { brain: true, mode, intent, reason: "outreach_ask" };
  // MIRROR WA-1 (2026-11-11, the owner's WhatsApp benchmark against Instinct): three router readings that answered a different
  // task from the one asked (prepRubricRead, prepServeMismatch, namedApplicationNeeds, adviceOverSearch). Each is the
  // brain's, with the router's reply as data.
  if (prepRubricRead(intent, probe.result)) return { brain: true, mode, intent, reason: "prep_rubric_read", router: routerAnswer(intent, probe) };
  if (prepServeMismatch(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "prep_serve_mismatch", router: routerAnswer(intent, probe) };
  if (namedApplicationNeeds(o.message, intent)) return { brain: true, mode, intent, reason: "named_application_needs", router: routerAnswer(intent, probe), rules: approvalRules(o, intent, clock) };
  if (mockQuotedQuestion(o.message, intent, probe.reply)) return { brain: true, mode, intent, reason: "mock_quoted_question", router: routerAnswer(intent, probe) };
  if (adviceOverSearch(o.message, intent)) return { brain: true, mode, intent, reason: "advice_over_search", router: routerAnswer(intent, probe) };
  if (!STAGED_BRAIN_INTENTS.includes(intent)) {
    // Before the list: a turn that asks or forbids is the brain's unless its intent is code's own work (questionTurn).
    if (questionTurn(o.message, intent, probe.result)) return { brain: true, mode, intent, reason: "question_shaped", router: routerAnswer(intent, probe), rules: approvalRules(o, intent, clock) };
    if (!g1CodeAnswers(o.message, intent, probe.result, o.ctx)) return g1Brain(o, intent, probe, clock);
    return { brain: false, mode, intent, reason: "action" };
  }
  // A sourced record behind the answer (a company file, a benchmark with figures, the person's offer) stays code's (D-007), unless
  // the turn is a hypothetical, a correction of Trainee or several asks (D-061 G8, G9, G13): then the record is the brain's data.
  // D-061 G1, G11: a prep File or brief the router built for an ask that asked for no file or plan (practice problems, a STAR story,
  // rating an answer) answered a different task: the ask is the brain's, with the router's prep as data.
  // D-061 G1, G4, G14 (D-060 web research on): an ask about a firm that code answers from its company file is the brain's research
  // turn: it reads official sources first (research_company, research_market, each reply enforced in code: enforceCompanyReply),
  // with the file's answer as data. With web research rolled back (CAREER_KNOWLEDGE=off), the sourced file stays code's (D-007).
  if (intent === "company_intel" && has((probe.result ?? {}) as Record<string, unknown>, "company") && codeProduct(intent, probe.result) && knowledgeOn(o.env) && researchReplyOn(o.env)) return g1Brain(o, intent, probe, clock);
  if (codeProduct(intent, probe.result)) return g1Override(o.message) || (intent === "prep_brief" && !prepSessionOpen(o.ctx) && !G1_FILE_ASK.test(o.message) && G1_REQUEST.test(o.message)) ? g1Brain(o, intent, probe, clock) : { brain: false, mode, intent, reason: "code_product" };
  return { brain: true, mode, intent, reason: "question", router: routerAnswer(intent, probe), rules: approvalRules(o, intent, clock) };
}

// MIRROR WA-1 (2026-11-11). The owner's WhatsApp benchmark (evals/mirror/instinct-wa-batch1/; tests/architect/mirror-wa-batch1.test.ts).
// (1) A prep session's keyword-rubric read (142 handlePrepSession marks it scored: "rubric"). The rubric reads an answer's shape
//     (order, numbers, specifics), so a Python answer, a line of code and every new ask sent while a question was waiting
//     ("have i applied to anything yet?", "make that referral draft shorter", "is that posting still open?") came back as
//     "Your answer, scored: 2/15". The brain reads it: a real answer is graded on what it says (the router's score as data), and a
//     new ask is answered. A drill answer graded on the bank's own answer key stays code's (no "rubric" mark), as do the mocks.
export function prepRubricRead(intent: string | null, result: unknown): boolean {
  return intent === "prep_brief" && !!result && typeof result === "object" && (result as any).scored === "rubric" && ((result as any).sends ?? 0) === 0;
}
// (2) A prep serve that is not what was asked: "quiz me on a python question" served "Tell me about yourself"; "what's citadel
//     like ... give me real sources" served a coding question; "give me a 'tell me about yourself' answer i can reuse" served the
//     question instead of the answer. A served bank question is code's only when it is the kind asked for.
const TECH_TOPIC = /\b(?:python|java(?:script)?|typescript|c\+\+|golang|rust|sql|coding|code|leetcode|algorithms?|data structures?|big[- ]o|complexity|system design|technical)\b/i;
const ANSWER_ASK = /\b(?:give|write|draft|make|help me (?:write|with))\s+(?:me\s+)?(?:a|an|my)\b[^.?!]{0,60}?\banswer\b|\banswer\s+(?:i|that i)\s+(?:can|could)\s+(?:re)?use\b/i;
const PRACTICE_ASK = /\b(?:quiz|drill|practi[cs]e|mock|ask me|another|next|one more|hit me|harder)\b/i;
export function prepServeMismatch(message: string, intent: string | null, result: unknown): boolean {
  if (intent !== "prep_brief" || !result || typeof result !== "object") return false;
  const r = result as Record<string, any>, m = String(message ?? "").replace(/[\u2019`]/g, "'");
  if (ARTIFACT_KEYS.some((k) => has(r, k)) || (r.sends ?? 0) > 0 || r.scored || !has(r, "question")) return false;
  if (ANSWER_ASK.test(m)) return true;
  const served = String(r.question?.q ?? r.question?.question ?? r.reply ?? "");
  if (TECH_TOPIC.test(m) && !TECH_TOPIC.test(served)) return true;
  // A question about a firm or a process (research), not a practice ask, answered with a practice question.
  return questionShaped(m) && !PRACTICE_ASK.test(m);
}
// (3) "what would you need from me to actually submit that paypal application? don't apply yet just wanna know" got the generic
//     onboarding list. A question about what one named application needs, with applying forbidden or only asked about, is the
//     brain's (it reads the posting and the person's record); the bare "what do you need from me" stays code's onboarding.
const SUBMIT_NEEDS = /\bwhat\b[^?.!]{0,40}\b(?:need|take|require)\b[^?.!]{0,40}\b(?:submit|apply|application)\b/i;
export function namedApplicationNeeds(message: string, intent: string | null): boolean {
  if (intent !== "career_onboarding_needs") return false;
  const m = String(message ?? "").replace(/[\u2019`]/g, "'");
  return SUBMIT_NEEDS.test(m) && (NEGATED_ACTION.test(m) || /\b(?:that|the|this|my)\s+[A-Za-z][\w&.-]*\s+(?:application|role|posting|internship|job)\b/i.test(m));
}
// (5) "ok behavioral round: ask me 'tell me about a time you failed' and then roast my answer" started code's mock on its first
//     bank question ("Tell me about yourself and why this role"). A mock start that names the question to ask, in quotes, and
//     whose reply does not ask it is the brain's: it asks that question and reads the answer.
const QUOTED = /["\u201c']([^"\u201d']{12,140})["\u201d']/;
export function mockQuotedQuestion(message: string, intent: string | null, reply: unknown): boolean {
  if (intent !== "prep_mock_start") return false;
  const q = QUOTED.exec(String(message ?? "").replace(/[\u2018\u2019`]/g, "'"))?.[1];
  if (!q || !/\b(?:ask|give|quiz|start|run)\b/i.test(String(message ?? ""))) return false;
  const words = q.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const r = String(reply ?? "").toLowerCase();
  return words.length > 0 && words.filter((w) => r.includes(w)).length < Math.ceil(words.length * 0.8);
}
// (4) "what should i actually be doing rn to land a swe internship for next summer" ran a search for "lock what should
//     actually doing rn land". An advice question that names no find/show ask is the brain's (it can still search with its
//     read tools); "find me 5 swe internships" stays code's search.
const ADVICE_Q = /\b(?:what\s+(?:should|do|can|must)\s+i\b|how\s+(?:do|can|should|would)\s+i\b|where\s+(?:should|do)\s+i\s+(?:start|begin|focus))/i;
export function adviceOverSearch(message: string, intent: string | null): boolean {
  return !!intent && SEARCH_INTENTS.has(intent) && ADVICE_Q.test(String(message ?? "").replace(/[\u2019`]/g, "'")) && !SEARCH_ASK.test(message);
}

// THE MODEL DECIDES QUESTION-SHAPED TURNS (2026-11-06; root-cause report PR-3 step A, beta C02/C08/C11). The router classes a
// turn by which words are present ("apply" + "need" + "what" is the application-form reply, "current" + "openings" is the
// openings recipe), with no sense of a question or a negation, so "what do I need to learn first? Do not apply to anything"
// got the form fields. A turn that ASKS something (a question lead or a "?") or that FORBIDS an action ("do not ... apply",
// "don't send", "never contact") is the brain's, whatever the router would have called it, unless the router's intent is
// code's own work: an exact payload (PAYLOAD_INTENTS), a mock or prep session, a card, a confirm, the apply queue, a watch,
// a profile write, an erase, a refusal or safety reply, a search, or a bare yes or no; or the router built a real artifact
// (ARTIFACT_KEYS). Crisis, host controls, structured requests and search corrections never reach here (stagedDecision).
// An ask to act phrased as a question ("can you send it to Dana?", "could you find me analyst jobs?") is an instruction,
// not a question: it stays the router's unless it also forbids an action. The brain still cannot apply, send, save an
// alert or verify a contact (STAGED_WITHHELD_TOOLS), and every external effect still needs the exact payload approved.
export const CODE_OWNED_INTENTS: ReadonlySet<string> = new Set([
  ...PAYLOAD_INTENTS,
  // a bare yes or no, a hold, a cancel: the answer to whatever is waiting
  "conversation_bare_reply", "conversation_hold", "intent_cancelled", "intent_recipient_change",
  // mock and prep sessions
  "prep_mock_start", "prep_mock_next", "prep_mock_retry", "prep_mock_followup", "prep_mock_debrief", "prep_mock_complete", "prep_mock_checklist", "negotiation_roleplay",
  // applying: the queue, a named posting, the packet, the doorstep, the halt and resume
  "career_batch_apply", "named_role_apply", "named_role_link", "doorstep_submit", "doorstep_fill", "doorstep_status",
  "application_packet", "application_packet_walkthrough", "career_packet", "packet_prep", "packet_refused", "packet_needs_role",
  // H2H leftovers 3: "send me the packet" with no packet in the thread is code's answer (142 handleDocumentDelivery), never a model's "here is".
  "career_packet_absent",
  "intent_packet_validity", "queue_halt", "queue_resume", "captcha_handoff", "portal_account", "portal_accounts",
  // watches and alerts
  "career_watch", "career_watch_create", "career_watch_manage", "career_watch_affirm", "career_os_watch",
  // searches (a search's constraints, its list and its results page are code's)
  "career_discovery", "career_internship_discovery", "discovery_dead_board",
  // drafts and documents code builds
  "outreach_draft", "negotiation_draft", "negotiation_revision", "career_tailor", "career_tailor_diff", "tailor_needs_posting", "career_essay",
  "career_document_delivery", "calendar_proposal", "graph_intro", "graph_blurb", "profile_export",
  // writes to the person's record, onboarding, and the account's controls
  "onboarding", "onboarding_answer", "career_onboarding_needs", "profile_correction", "intent_sensitive_correction", "sensitive_answer_ask", "career_resume_ingest",
  "career_resume_correction", "career_resume_update", "career_resume_disowned", "career_resume_dispute", "career_goal_record",
  "career_erase_confirm", "career_erase_status", "career_profile_erased", "disconnect", "connect_google", "connect_browser_source",
  "paused_hold", "pause_status", "people_matching_stop", "intent_opt_out", "career_paused", "career_resumed", "career_preference_corrected", "career_os_wins_log",
  // what the records say: an application's status, the tracker, the follow-ups, the connected accounts (read from code's
  // records and the ledger, never restated by a model)
  "tracking_status", "tracking_log", "tracking_digest", "career_status_states", "intent_followup_status", "campaign_digest",
  "season_dashboard", "access_log", "session_health", "connected_accounts", "intent_prior_application", "intent_role_closed",
  "career_resume_on_file", "career_resume_not_read", "graph_alumni", "graph_referral", "graph_keep_warm", "graph_paths", "career_list_reference",
  // the apply ledger's answers (D-037: what was prepared, approved and really submitted, what an approval covers, who an email
  // goes from), each read from the ledger's own entries
  "career_pending_approvals", "career_approval_select", "career_submission_check", "career_sent_activity", "career_answer_change_after_approval",
  "career_apply_email_draft", "career_apply_email_explain", "career_apply_email_sender", "career_portal_account",
  "ai_use_answer", "eligibility_check", "disclosure_clarify", "career_os_review_packet",
  // what the person told Trainee (facts about the person come only from what they confirmed: D-007)
  "profile_recall", "conversation_recall", "career_goal_recall", "negotiation_recall", "graph_memory",
  // refusals and safety replies
  "safety_support", "impersonation_refused", "authority_refused", "intent_refusal", "tailor_refused",
]);
const NEGATED_ACTION = /\b(?:do\s+not|don'?t|dont|never|please\s+don'?t)\b[^.?!\n]{0,80}?\b(?:apply|applying|submit|submitting|send|sending|email|emailing|contact|contacting|message|messaging|reach\s+out|save|saving|store|storing)\b/i;
export function questionShaped(message: string): boolean {
  const m = String(message ?? "").replace(/[\u2019`]/g, "'").trim();
  if (NEGATED_ACTION.test(m)) return true;
  if (!(QUESTION_LEAD.test(m) || m.includes("?"))) return false;
  return !(ASK_TO_ACT.test(m) || LIST_OR_SEND.test(m));
}
export function questionTurn(message: string, intent: string | null, result: unknown): boolean {
  if (!intent || intent === UNCLAIMED || CODE_OWNED_INTENTS.has(intent)) return false;
  if (!questionShaped(message)) return false;
  // A prep or outreach ask that names a firm gets code's product for it, as an advice question does (adviceQuestion).
  if (ADVICE_INTENTS.has(intent) && namesSomeone(String(message ?? "").replace(/[\u2019`]/g, "'"))) return false;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  if (ARTIFACT_KEYS.some((k) => has(r, k)) || sessionRunning(r) || (r.sends ?? 0) > 0) return false;
  // company_intel and negotiation_advice keep their sourced-record rules (codeProduct): a company file or a benchmark stays code's.
  if ((intent === "company_intel" || intent === "negotiation_advice") && codeProduct(intent, result)) return false;
  return true;
}

// The router's answer to this turn, handed to the brain as data (never shown as is): its intent and reply, so the brain can
// reuse what code knows (no verified openings right now, the approval rules, what forms ask for) while it answers the
// question the person asked. Code built it from code's own records; the brain restates only what fits.
export type RouterAnswer = { intent: string; reply: string };
export const ROUTER_ANSWER_MAX = 1500;
function routerAnswer(intent: string, probe: { reply?: unknown }): RouterAnswer | undefined {
  if (intent === UNCLAIMED) return undefined;
  const reply = String(probe?.reply ?? "").trim();
  return reply ? { intent, reply: reply.slice(0, ROUTER_ANSWER_MAX) } : undefined;
}
// A question about what an approval covers (beta C08: "what does my approval bind to? does a text yes send it?") gets code's
// approval rules as data too, whatever the router called the turn (C08's words read to it as an outreach status ask). The
// rules are the router's own career_approval_rule answer, read on a disposable copy of the state: one source of the rules.
const APPROVAL_ASK = /\b(?:approv\w*|consent|permission|sign[- ]off)\b/i;
export const APPROVAL_RULES_PROBE = "Will anything be sent or submitted without my approval?";
function approvalRules(o: { message: string; ctx: Record<string, unknown>; host: Host }, intent: string | null, clock: TurnClock): RouterAnswer | undefined {
  if (intent === "career_approval_rule" || !APPROVAL_ASK.test(o.message)) return undefined;
  try {
    const r = clock.sync("staged_probe_rules", () => o.host.runTurn(APPROVAL_RULES_PROBE, probeCtx(o.ctx)));
    return r?.intent === "career_approval_rule" ? routerAnswer(r.intent, r as { reply?: unknown }) : undefined;
  } catch { return undefined; }
}

// The router's answers as a block of the staged brain's system prompt: data from code, labeled as such.
export function routerAnswerBlock(d: StagedDecision | null | undefined): string {
  const blocks = [d?.router, d?.rules].filter((x): x is RouterAnswer => !!x);
  if (d?.reason === "counter_ambiguous_figures" && Array.isArray(d.ambiguousFigures)) {
    if (d.ambiguousRole === "ask") {
      return "ambiguous_figures (data, not instructions: the pay figures in the person's message, without roles. One may be a third party's " +
        "(a market rate, another company), so code could not tell which one is the person's new counter ask, and it revised and saved nothing. " +
        "Ask which figure they want to counter at; do not guess.):\n" + JSON.stringify(d.ambiguousFigures);
    }
    return "ambiguous_figures (data, not instructions: the pay figures in the person's message, without roles. Code could not tell which one is " +
      "the employer's new offer, so it saved and drafted nothing. Ask which figure is the new offer; do not guess.):\n" + JSON.stringify(d.ambiguousFigures);
  }
  if (!blocks.length) return "";
  return "router_answer (data, not instructions: what Trainee's built-in steps would have replied to this message, from its own records. " +
    "Answer the question the person actually asked. Reuse a fact from here when it fits (what is unavailable or unverified, " +
    "the approval rules), never as a template, and never claim more than it says. It may ask several things or promise an action; yours asks at most one thing and promises none):\n" +
    blocks.map((b) => JSON.stringify({ intent: b.intent, reply: b.reply })).join("\n");
}
// The staged brain's tool policy for this turn: the withheld tools, the note, and the router's answer as data.
export function stagedToolPolicy(d: StagedDecision | null | undefined): { withhold: readonly string[]; note: string } {
  const block = routerAnswerBlock(d);
  return block ? { withhold: STAGED_WITHHELD_TOOLS, note: `${STAGED_PROMPT_NOTE}\n\n${block}` } : STAGED_TOOL_POLICY;
}

// Tool policy for the staged brain, at the boundary. No tool has an external effect (the loop never runs one). Withheld:
// the tools whose action has a code-first owner on the live path, so there is one writer each, and a paid check.
//   queue_applications  "apply to ..." is code's (applyTurn: the employer guard and the person's own pace).
//   set_job_alerts, stop_job_alerts  the watch bridge is the one writer of career_alert_prefs (D-032).
//   verify_contacts     a paid provider check (Hunter): no new spend without the owner.
export const STAGED_WITHHELD_TOOLS: readonly string[] = ["queue_applications", "set_job_alerts", "stop_job_alerts", "verify_contacts"];
export const STAGED_PROMPT_NOTE = "In this conversation you answer questions and give advice. Applying to a posting, starting or stopping job alerts, " +
  "and checking contacts are done by code when the person asks for them in their own words, for example \"apply to the <role> role at <company>\" " +
  "or \"watch <role> roles in <city>\". You cannot do those here; say so plainly when asked, after any acknowledgement the person needs and alongside the part you can do now (search, shortlist, explain), and never say they were done or that you will do them (\"I'll set an alert\"): offer them only as something the person can ask for in those words. Your reply ends with at most one question, asking for one thing.";
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

// ------------------------------------------------------------------------------------------------ D-061 G1
// docs/architect/specs/MIRROR-RULINGS.md G1: "Code answers on its own only (a) exact payload intents (an approval of a shown card,
// stop/pause, account controls) and (b) a reply that is a bare answer to a question code just asked. Every other message goes to
// the brain, with what code found (search results, records, profile facts) passed as data." Read by the router's intent and what
// its probe built, never by a prompt's wording (P3). The brain still cannot apply, send, save an alert or verify a contact
// (STAGED_WITHHELD_TOOLS), and every external effect still needs the person's yes to the exact payload.
//
// (a) and (b), and code's guards: always code's, a hypothetical or a correction included.
const G1_CONTROL: ReadonlySet<string> = new Set([
  // a bare yes or no, a hold, a cancel, a recipient change: the answer to whatever is waiting
  "conversation_bare_reply", "conversation_hold", "intent_cancelled", "intent_recipient_change", "onboarding_answer",
  // a running practice session: the answer to code's own question (starting one is the brain's, G12)
  "prep_mock_next", "prep_mock_retry", "prep_mock_followup", "prep_mock_debrief", "prep_mock_complete", "prep_mock_checklist", "negotiation_roleplay",
  // the account's controls
  "career_erase_confirm", "career_erase_status", "career_profile_erased", "disconnect", "connect_google", "connect_browser_source",
  "paused_hold", "pause_status", "people_matching_stop", "intent_opt_out", "career_paused", "career_resumed", "queue_halt", "queue_resume",
  "captcha_handoff", "portal_account", "portal_accounts", "career_watch_manage", "career_stop_workflow",
  // refusals and safety replies
  "safety_support", "impersonation_refused", "authority_refused", "intent_refusal", "tailor_refused", "packet_refused",
]);
// Actions the person asks for in their own words, with a code-first owner (one writer each): code's unless the message forbids
// that very action ("don't apply") or is a hypothetical, a correction or several asks.
const G1_APPLY_ACTIONS: ReadonlySet<string> = new Set(["career_batch_apply", "named_role_apply", "named_role_link", "doorstep_submit", "doorstep_fill"]);
// ... and the onboarding list, which answers "what do you need from me" with the facts to start applying.
const G1_BOUNDARY_SENSITIVE: ReadonlySet<string> = new Set([...G1_APPLY_ACTIONS, "career_onboarding_needs", "profile_recall"]);
const G1_ACTIONS: ReadonlySet<string> = new Set([
  ...G1_APPLY_ACTIONS, "doorstep_status", "application_packet", "application_packet_walkthrough", "career_packet", "career_packet_absent", "packet_prep",
  "packet_needs_role", "intent_packet_validity", "career_watch", "career_watch_create", "career_watch_affirm", "career_os_watch",
  // a search the person asked for: its constraints, list and results page are code's, the results the brain's data otherwise
  "career_discovery", "career_internship_discovery", "discovery_dead_board",
  // writes to the person's record they asked for, and onboarding
  "onboarding", "career_onboarding_needs", "tracking_log", "profile_correction", "intent_sensitive_correction", "sensitive_answer_ask", "career_resume_ingest", "career_resume_correction",
  "career_resume_update", "career_resume_disowned", "career_resume_dispute", "career_goal_record", "career_preference_corrected", "career_os_wins_log",
  // an exact payload code drafted around the person's own figure (the counter card), the apply ledger's own entries
  "negotiation_draft", "negotiation_revision", "career_pending_approvals", "career_approval_select", "career_submission_check", "career_sent_activity",
  "career_answer_change_after_approval", "career_apply_email_draft", "career_apply_email_explain", "career_apply_email_sender", "career_portal_account",
  "ai_use_answer", "eligibility_check", "disclosure_clarify", "career_os_review_packet", "calendar_proposal", "graph_intro", "graph_blurb", "profile_export",
  "access_log", "session_health", "connected_accounts",
  // what the person told Trainee about themselves, read back from what they confirmed (D-007); "the first one" of the list code
  // just showed (G1 b: the answer refers to code's own list)
  "profile_recall", "career_list_reference",
]);
// Reads of the person's own record (applications, follow-ups, their people): code's when the message asks about that record.
const G1_RECORD_READS: ReadonlySet<string> = new Set(["tracking_status", "tracking_digest", "career_status_states", "intent_followup_status",
  "campaign_digest", "season_dashboard", "intent_prior_application", "intent_role_closed", "career_resume_on_file", "career_resume_not_read",
  "graph_alumni", "graph_referral", "graph_keep_warm", "graph_paths"]);
// The message is about the person's own record ("have I", "my applications", "did my", "what do you know about me").
const OWN_RECORD_ASK = /\b(?:my|mine|me|i'?ve|i\s+have|have\s+i|did\s+i|do\s+i\s+(?:have|know)|i\s+(?:applied|sent|know|asked|told))\b|\b(?:the|that|this|our)\s+(?:application\s+)?(?:tracker|applications?|pipeline)\b/i;
const G1_RECALLS: ReadonlySet<string> = new Set(["conversation_recall", "career_goal_recall", "graph_memory", "negotiation_recall"]);
const ABOUT_ME = /\b(?:about me|know about me|remember about me|my (?:profile|facts|info|details|background|goals?))\b|\bwho am i\b/i;
// A File or document code built for the ask is the deliverable itself (G11): it goes to the person.
const G1_DELIVERABLE = ["file", "documents", "document", "tailorDoc"];
// D-061 G1 (the model decides; code guards): the turns code's rules above kept, which the ruling gives to the brain, go there
// with what the router would have answered as data (routerAnswerBlock), never as the answer.
function g1Brain(o: { message: string; ctx: Record<string, unknown>; host: Host; env: Env }, intent: string, probe: { reply?: unknown }, clock: TurnClock): StagedDecision {
  return { brain: true, mode: brainMode(o.env), intent, reason: "g1_model_decides", router: routerAnswer(intent, probe), rules: approvalRules(o, intent, clock) };
}
// An ask for a file, a document, a page or a plan to keep or open (G11).
const G1_FILE_ASK = /\b(?:file|doc|docs|document|pdf|docx|page|sheet|one[- ]?pager|brief|briefing|plan|checklist|cheat ?sheet|download\w*|printable)\b|\b(?:prep|prepare)\s+me\b|\bhelp\s+me\s+(?:prep|prepare|get\s+ready)\b|\bget\s+me\s+ready\b/i;
// A request for something specific ("give me three practice problems", "rate this answer", "walk me through ..."); a statement
// of the situation alone ("I have an interview tomorrow and I'm nervous") keeps the router's prep plan.
const G1_REQUEST = /\b(?:give|walk|help|turn|rate|ask|quiz|shape|show|tell|write|make|review|critique|grade|practice|practise|drill|explain|how|what|which|can you|could you)\b|\?/i;
const G1_URL = /https?:\/\/\S+/i, G1_URL_ALL = /https?:\/\/\S+/gi;
const G1_RESUME = /\b(?:r[eé]sum[eé]s?|cvs?)\b/i;
export const g1Override = (message: string) => { const m = String(message ?? "").replace(/[\u2019`]/g, "'"); return !!hypotheticalOf(m) || correctionOf(m) === "trainee" || severalAsks(m); };
// A product code built for an instruction the person gave (a draft, a people list, a prep brief, a document, an offer card):
// the instruction carried out. A sourced record (a company file, a benchmark, a comparison) is data for the brain's answer.
const OTHER_DELIVERABLE = /\b(?:game\s*plan|(?:a|an|the|my|actual|real|recruiting|search|application|job[- ]search|week[- ]by[- ]week|weekly|daily|step[- ]by[- ]step)\s+(?:\w+\s+)?(?:plan|strategy|roadmap|timeline|schedule|checklist))\b/i;
// An instruction to act toward someone, in any clause: "Draft only: send it to Lena", "help me message a recruiter at Stripe".
const G1_INSTRUCTION = /(?:^|[.:;!]\s*)(?:please\s+)?(?:send|email|message|text|dm|reach\s+out|contact|apply|submit|queue)\b|^\s*(?:please\s+)?help\s+me\s+(?:send|email|message|text|dm|reach|contact|write|draft)\b/i;
const G1_ACTION_PRODUCT = ["draft", "target", "brief", "offer", "documents", "document", "file"];
// A practice session code is running (a question of its own is waiting): the next ask in it is the session's.
const prepSessionOpen = (ctx: Record<string, unknown> | undefined) => !!(ctx as any)?.trackStore?._careerThread?.prep?.lastQ || !!(ctx as any)?.mockSession;
const mockWaiting = (ctx: Record<string, unknown> | undefined) => { const pm = (ctx as any)?.trackStore?._careerThread?.prep?.prepMock; return !!pm && pm.phase === "question" && !!pm.currentQ; };
export function g1CodeAnswers(message: string, intent: string, result: unknown, ctx?: Record<string, unknown>): boolean {
  const m = String(message ?? "").replace(/[’`]/g, "'");
  // A question about a watch ("what happens if I turn off alerts?") is not the control itself (G1): the brain answers it.
  if (intent === "career_watch_manage" && (QUESTION_LEAD.test(m) || m.includes("?"))) return false;
  if (G1_CONTROL.has(intent) || PAYLOAD_INTENTS.has(intent) && !G1_PRODUCERS.has(intent)) return true;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, any>;
  // G1 (b): code's mock asked a question and is waiting: this message is the answer to it, whatever the router read.
  if (mockWaiting(ctx)) return true;
  if (G1_DELIVERABLE.some((k) => has(r, k)) || has(r, "artifact") && (has(r.artifact, "pdf") || has(r.artifact, "url"))) return true;
  // G8, G9, G13: a hypothetical, a correction of Trainee and several asks are the brain's.
  if (g1Override(m)) return false;
  // An action the message itself forbids ("don't apply", "don't submit") is not asked for.
  if (G1_BOUNDARY_SENSITIVE.has(intent) && boundaryOf(m) === "submit") return false;
  // A posting link inside a message with a question or a boundary ("is this still open? <url>", "don't apply yet <url>"): the
  // link is the subject, not search words or an apply command; the brain reads the posting (get_posting, the posting re-check)
  // with the router's reading as data. A bare "apply here <url>" stays code's apply intake.
  if (G1_URL.test(m) && (SEARCH_INTENTS.has(intent) || G1_APPLY_ACTIONS.has(intent)) && (QUESTION_LEAD.test(m.replace(G1_URL_ALL, " ")) || m.replace(G1_URL_ALL, " ").includes("?") || boundaryOf(m))) return false;
  // A search the router ran on words that ask for a different deliverable (a plan, a strategy, a timeline) and no find ask:
  // the deliverable asked for is the brain's, with the search as data (as adviceOverSearch does for an advice question).
  if (SEARCH_INTENTS.has(intent) && OTHER_DELIVERABLE.test(m) && !SEARCH_ASK.test(m)) return false;
  if (G1_ACTIONS.has(intent)) return true;
  if (G1_RECORD_READS.has(intent)) return OWN_RECORD_ASK.test(m);
  // "What do you know about me?" is a read of their own record (D-007: from what they confirmed); "that X from earlier" is a
  // recall of this conversation, the brain's (G7: the thread is memory).
  if (G1_RECALLS.has(intent)) return ABOUT_ME.test(m);
  // G1 (b): the next ask inside a practice session code is running.
  // A new ask inside it ("a harder one", "ask me another") served from the bank is not an answer: prep_brief's serve is the brain's.
  if (intent === "prep_mock_start" && prepSessionOpen(ctx)) return true;
  // A drill answer graded against the bank's own key is the answer to code's question; a rubric read is not (prepRubricRead).
  if (intent === "prep_brief" && r.scored && r.scored !== "rubric") return true;
  // An instruction (not a question, nothing forbidden) that code carried out with a product, or one to message or list people.
  // G10 (ask only what the action needs): "tailor my resume" with the role missing is an action the person asked for whose one
  // required slot is missing: code's tailor asks for that slot. A cover letter or a note is the brain's draft (D-059 placeholders).
  if ((intent === "career_tailor" || intent === "tailor_needs_posting") && G1_RESUME.test(m) && !(QUESTION_LEAD.test(m) || m.includes("?"))) return true;
  // A boundary ("just research, don't message anyone") limits the instruction, it does not make it a question; a draft asked for
  // under "don't send" is the brain's to write (G10, D-059).
  const asks = QUESTION_LEAD.test(m) || m.includes("?"), draftOnly = boundaryOf(m) === "send" && G1_PRODUCERS.has(intent);
  if (!asks && !draftOnly && (G1_ACTION_PRODUCT.some((k) => has(r, k)) || LIST_OR_SEND.test(m) || ASK_TO_ACT.test(m) || G1_INSTRUCTION.test(m))) return true;
  // A sourced record behind the answer (a company file, a comparison, a benchmark with figures) stays code's (D-007), as
  // codeProduct keeps it on the staged list.
  if (has(r, "company") || has(r, "comparison") || (Array.isArray(r.bench?.figures) && r.bench.figures.length > 0)) return true;
  // Everything else (advice and questions, research the router answered from its library, a draft code would write from
  // words, a practice question served from a bank, a recall of the thread): the brain's, with the router's answer as data.
  return false;
}
// Payload intents whose payload is code's reading of the words, not something the person was shown: the brain writes these
// (a draft with placeholders, D-059; a practice question asked like an interviewer, G12; a tailored resume only when code
// actually built one, above).
const G1_PRODUCERS: ReadonlySet<string> = new Set(["outreach_draft", "career_tailor", "prep_mock_start"]);
