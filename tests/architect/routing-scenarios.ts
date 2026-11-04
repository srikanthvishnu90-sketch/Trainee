// ROUTING SCENARIOS (architect, 2026-10-29): which deterministic turn of the career chat
// (supabase/functions/agent-chat/handler-career.ts handleChat) answers a text, decided WITHOUT the database, plus a
// generator of ~10,000 phrasings in the intent families that must never cross (billing vs cancelling an application,
// email/outreach status vs application status, networking vs applying, connectors vs everything).
//
// pureRoute() evaluates, in the handler's gate order, the exported pure predicate of each turn for a person with no
// pending state in the thread (no card, question, batch, cancel or employer ask waiting): connectors, site refusal,
// Outlook, card ("show my applications"), mock, questions, outreach ("show my drafts"), replies (the interval), cloud
// (and the resume record), pace, billing, application cancel, apply (link, possessive role, list ask, named employer
// with a posting on file), receipts, follow-up cards, standing, status, networking (people, imports, forget, tracking,
// who/draft), offers, outreach send status; else the router. Stateful turns that claim only an answer to their own
// waiting question are null here, as they are in the handler for a fresh thread. tests/architect/
// flow-routing-scenarios.test.ts runs a sample through the real handler on real Postgres and holds this mirror to it.
import { connectorAsk } from "../../supabase/functions/_shared/connectors.ts";
import { outlookAsk } from "../../supabase/functions/_shared/outlook_connector.ts";
import { siteAsk, trackAsk } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { parsePeopleAsk, targetAskOf } from "../../supabase/functions/_shared/career_people.ts";
import { forgetAsk, parseNetworkingAsk, pastedCsv } from "../../supabase/functions/_shared/career_networking.ts";
import { parseCardReply } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { parseMockCommand } from "../../supabase/functions/_shared/career_mock.ts";
import { isAsk as questionsAsk } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { parseEmailReply } from "../../supabase/functions/_shared/career_apply_email.ts";
import { parseOutreachReply } from "../../supabase/functions/_shared/career_outreach.ts";
import { intervalAsk } from "../../supabase/functions/_shared/career_outreach_replies.ts";
import { parseCloudCommand } from "../../supabase/functions/_shared/career_cloud_optin.ts";
import { parseResumeCommand } from "../../supabase/functions/_shared/career_resume_record.ts";
import { applyAsk, applyManyAsk, paceAsk } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { boardOfCompany, linkAsk, possessiveAsk } from "../../supabase/functions/_shared/career_apply_link.ts";
import { billingAsk } from "../../supabase/functions/_shared/career_billing.ts";
import { cancelAsk } from "../../supabase/functions/_shared/career_hosted_prepare.ts";
import { receiptAsk } from "../../supabase/functions/_shared/career_apply_receipt_read.ts";
import { followupAsk } from "../../supabase/functions/_shared/career_inbox_followups.ts";
import { standingAsk } from "../../supabase/functions/_shared/career_standing.ts";
import { statusAsk } from "../../supabase/functions/_shared/career_apply_status.ts";
import { emailStatusAsk } from "../../supabase/functions/_shared/career_send_rail.ts";

export type Route =
  | "connectors" | "site_refused" | "outlook" | "cards" | "mock" | "questions" | "email" | "outreach" | "outreach_replies"
  | "cloud" | "apply_pace" | "billing" | "apply_cancel" | "apply_queue" | "receipt" | "followup" | "standing" | "status"
  | "networking" | "outreach_status" | "router";

// The host's account controls (career_host.js PAUSE_RE / RESUME_RE / ERASE_RE, copied) close most deterministic turns;
// the host answers them on the router path.
const HOST = [/^(?:STOP|UNSUBSCRIBE|stop everything|pause all career work)[.!]*$/i, /^(?:resume career work|resume all career work)[.!]*$/i, /^(?:forget|delete) my career profile[.!]*$/i];

export interface World {
  // Companies with an open posting on file (career_postings): a named-employer apply ask is the apply turn's only then.
  postingsAt?: (company: string) => boolean;
}

export function pureRoute(message: string, w: World = {}): Route {
  const m = String(message ?? "");
  if (connectorAsk(m)) return "connectors";
  if (siteAsk(m) && parsePeopleAsk(m)?.kind !== "page") return "site_refused";
  if (outlookAsk(m)) return "outlook";
  if (HOST.some((re) => re.test(m.trim()))) return "router";
  if (parseCardReply(m)?.kind === "show") return "cards";
  const mock = parseMockCommand(m);
  if (mock?.kind === "start" || mock?.kind === "voice") return "mock";
  if (questionsAsk(m)) return "questions";
  if (parseEmailReply(m)?.kind === "apply") return "email";
  const o = parseOutreachReply(m);
  if (o?.kind === "show" || o?.kind === "lapsed") return "outreach";
  if (intervalAsk(m) || /^(?:show|see|list)(?: me)?(?: my| the)? outreach approvals$/.test(m.toLowerCase().replace(/[.!?]+$/, "").trim())) return "outreach_replies";
  if (parseResumeCommand(m) || parseCloudCommand(m)) return "cloud";
  if (paceAsk(m)) return "apply_pace";
  if (billingAsk(m)) return "billing";
  if (cancelAsk(m)) return "apply_cancel";
  if (linkAsk(m)) return "apply_queue";
  const pos = possessiveAsk(m);
  if (pos && boardOfCompany(pos.company)) return "apply_queue";
  if (applyManyAsk(m)) return "apply_queue";
  const one = applyAsk(m);
  if (one && (w.postingsAt?.(one.company) || (one.role && boardOfCompany(one.company)))) return "apply_queue";
  if (receiptAsk(m)) return "receipt";
  if (followupAsk(m)) return "followup";
  // The handler keeps an email-status ask from the standing, status and networking turns (emailAsk).
  if (emailStatusAsk(m)) return "outreach_status";
  if (standingAsk(m)) return "standing";
  if (statusAsk(m)) return "status";
  if (networkingAsk(m)) return "networking";
  return "router";
}

// The networking turn claims a message when one of its parts reads it (career_networking.ts networkingTurnInner and
// career_people.ts peopleTurn, in their order). trackAsk's tracking asks other than the list need history on record,
// which a fresh person has none of.
function networkingAsk(m: string): boolean {
  // The people turn reads a discovery ask through targetAskOf (its own tidying: filler, courtesy, emoji; never a site).
  if (targetAskOf(m)) return true;
  if (parsePeopleAsk(m) || pastedCsv(m) || forgetAsk(m)) return true;
  const t = trackAsk(m);
  if (t && (t.kind === "list" || t.kind === "site")) return true;
  return !!parseNetworkingAsk(m);
}

// ------------------------------------------------------------------------------------------------ the scenarios
export type Family = "billing" | "app_cancel" | "app_receipts" | "outreach_status" | "app_status" | "networking" | "connectors" | "apply" | "site" | "multi" | "site_named";
export interface Scenario {
  family: Family; message: string; base: string; variant: string;
  // The one route the text must take ("strict"), or the routes it may take when a variant leaves the product's
  // grammar (a typo, an emoji): the family's own turn or the router (the brain or the router answers it), never another
  // family's deterministic turn.
  expect: Route[]; strict: boolean;
}

// Ordinary employers, and employers whose names collide with the families' keywords.
export const COMPANIES = ["Stripe", "Acme Corp", "Goldman Sachs", "Jane Street", "Bravo Labs", "Ramp", "Notion", "Figma"];
export const COLLIDING = ["Plan", "Billing Co", "Receipt Bank", "Status Labs", "Outreach", "Connect Inc", "Apply Digital", "Gmail Partners"];
// Employers whose names carry LinkedIn, Indeed or Handshake: the owner rule's edge. Either the family's own turn reads
// the employer, or the site refusal declines it plainly (nothing done on the site either way); the router may ask.
export const SITE_NAMED = ["Indeed Partners", "Handshake Capital", "LinkedIn"];
// A posting on file at every employer above (the e2e seeds them), so a named apply ask is the apply turn's.
const key = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const ON_FILE = new Set([...COMPANIES, ...COLLIDING, ...SITE_NAMED].map(key));
export const world: World = { postingsAt: (c) => ON_FILE.has(key(c)) };

type Base = { family: Family; text: string; expect: Route };
const B = (family: Family, expect: Route, texts: string[]): Base[] => texts.map((text) => ({ family, text, expect }));

function bases(): Base[] {
  const out: Base[] = [];
  out.push(...B("billing", "billing", [
    "cancel my plan", "cancel my subscription", "cancel my membership", "I want to cancel my subscription", "can you cancel my plan",
    "stop charging me", "don't charge me again", "how much am I paying", "what am I paying", "what's my bill", "my invoices",
    "show me my invoices", "what was I charged", "how much does trainee cost", "cancel trainee", "billing receipts", "my billing receipts",
    "what plan am I on", "how much did you charge me", "end my subscription", "stop billing me", "what's my billing",
    "how much is my subscription", "show my billing history", "send me my invoices", "can i see my invoices",
  ]));
  for (const c of [...COMPANIES, ...COLLIDING]) {
    out.push(...B("app_cancel", "apply_cancel", [
      `cancel my application to ${c}`, `withdraw from ${c}`, `withdraw my application to ${c}`, `don't apply to ${c}`,
      `remove ${c} from my list`, `stop applying to ${c}`, `cancel the ${c} application`, `do not apply to ${c}`,
      `never mind the ${c} application`, `don't send my application to ${c}`, `remove ${c} from my queue`,
    ]));
    out.push(...B("app_receipts", "receipt", [`show me the receipt for ${c}`, `what did you send to ${c}`, `${c} receipt`, `receipt for my application to ${c}`]));
    out.push(...B("app_status", "standing", [`where's my application to ${c}`, `did my application to ${c} go through`, `did you apply to ${c}`, `where do I stand with ${c}`]));
    out.push(...B("networking", "networking", [
      `who do I know at ${c}`, `reach people at ${c}`, `contact people at ${c}`, `connect with people at ${c}`, `find recruiters at ${c}`,
      `reach out to people at ${c}`, `find someone at ${c}`, `do I know anyone at ${c}`, `email my contacts at ${c}`,
      `I want to reach people at ${c}`, `get in touch with people at ${c}`, `find engineers at ${c}`, `message people at ${c}`,
    ]));
    out.push(...B("apply", "apply_queue", [`apply to ${c}`, `apply me to ${c}`, `apply to the data analyst role at ${c}`, `apply for the Data Analyst position at ${c}`]));
  }
  for (const c of SITE_NAMED) {
    for (const [route, texts] of [
      ["apply_cancel", [`cancel my application to ${c}`, `withdraw from ${c}`, `don't apply to ${c}`, `remove ${c} from my list`]],
      ["apply_queue", [`apply to ${c}`, `apply to the data analyst role at ${c}`]],
      ["networking", [`who do I know at ${c}`, `reach people at ${c}`, `find recruiters at ${c}`, `email my contacts at ${c}`]],
      ["standing", [`where's my application to ${c}`, `did you apply to ${c}`]],
      ["receipt", [`show me the receipt for ${c}`]],
    ] as [Route, string[]][]) out.push(...B("site_named", route, texts));
  }
  out.push(...B("app_receipts", "receipt", ["receipts", "my receipts", "show me my receipts", "show all my receipts", "my application receipts"]));
  out.push(...B("app_status", "standing", [
    "where are my applications", "status of my applications", "what's the status of my applications", "did my applications go through",
    "where do I stand", "any updates on my applications", "how are my applications", "did it go through",
  ]));
  out.push(...B("app_status", "standing", ["what did I apply to", "status of my apps", "where are my apps", "show me what I applied to", "what have I applied to"]));
  out.push(...B("outreach_status", "outreach_status", [
    "where are my emails", "did my emails go out", "status of my outreach", "what's the status of my outreach emails", "how are my emails",
    "did my outreach emails go out", "email status", "any update on my emails", "where are my outreach emails", "have my emails been sent",
  ]));
  out.push(...B("outreach_status", "standing", ["who replied", "any replies", "has anyone replied", "did anyone get back to me", "any responses"]));
  out.push(...B("connectors", "connectors", ["connect gmail", "connect my gmail", "what's connected", "disconnect gmail", "disconnect my gmail", "link my google account", "what do you have access to", "check my gmail", "disconnect outlook"]));
  out.push(...B("connectors", "outlook", ["connect outlook", "connect my outlook", "is my outlook connected", "use my work email"]));
  out.push(...B("apply", "apply_queue", [
    "apply to these", "apply to all of them", "apply to 1 and 3", "apply to the first one", "apply to the top 3", "apply to all", "apply to both",
    "apply me to https://boards.greenhouse.io/acme/jobs/12345", "apply to https://jobs.lever.co/ramp/0a1b2c3d-4e5f-6789-abcd-ef0123456789",
  ]));
  out.push(...B("site", "site_refused", [
    "apply to jobs on Indeed for me", "message recruiters on Handshake", "apply on linkedin for me", "connect with people at Stripe on LinkedIn",
    "apply to https://www.indeed.com/viewjob?jk=abc", "send connection requests on linkedin",
  ]));
  return out;
}

// Messages that say two families at once: the conservative expectation is that no half is acted on. The router asks;
// a read-only answer to the first half (who they know at a firm, where their emails are) changes nothing and is allowed.
// The acting turns (apply, cancel an application, billing) never take one.
const MULTI: [string, Route[]][] = [
  ["cancel my plan and my application to Stripe", ["router"]],
  ["cancel my subscription and withdraw from Acme Corp", ["router"]],
  ["apply to Stripe and email my contacts there", ["router"]],
  ["where are my emails and my applications", ["router"]],
  ["connect gmail and apply to Stripe", ["router"]],
  ["withdraw from Stripe and apply to Ramp", ["router"]],
  ["stop charging me and stop applying to Notion", ["router"]],
  ["who do I know at Stripe and apply to Stripe", ["router", "networking"]],
  ["remove Ramp from my list and apply to Notion", ["router"]],
  ["don't apply to Stripe, apply to Ramp", ["router"]],
];

// ------------------------------------------------------------------------------------------------ variants
// A seeded PRNG so the 10,000 are the same on every run.
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Variants the product reads as the same ask (strict): case, end punctuation, extra spaces.
const STRICT: [string, (s: string) => string][] = [
  ["as-is", (s) => s],
  ["lower", (s) => s.toLowerCase()],
  ["upper-first", (s) => s[0].toUpperCase() + s.slice(1)],
  ["period", (s) => `${s}.`],
  ["bang", (s) => `${s}!`],
  ["spaces", (s) => `  ${s.replace(/ /g, "  ")}  `],
];
// Variants that may leave a turn's grammar (soft): the family's own turn or the router (which asks, or hands the text
// to the brain), never another family's deterministic turn.
const SOFT: [string, (s: string, r: () => number) => string][] = [
  ["question", (s) => `${s}?`],
  ["hey", (s) => `hey ${s}`],
  ["please", (s) => `please ${s}`],
  ["trailing-please", (s) => `${s} please`],
  ["upper", (s) => s.toUpperCase()],
  ["can-you", (s) => `can you ${s}`],
  ["pls", (s) => `pls ${s}`],
  ["thanks", (s) => `${s} thanks`],
  ["emoji", (s) => `${s} 🙏`],
  ["emoji-lead", (s) => `👋 ${s}`],
  ["hey-comma", (s) => `hey, ${s}`],
  ["ok-so", (s) => `ok so ${s}`],
  ["typo-swap", (s, r) => typo(s, r, "swap")],
  ["typo-drop", (s, r) => typo(s, r, "drop")],
  ["typo-double", (s, r) => typo(s, r, "double")],
  ["typo-two", (s, r) => typo(typo(s, r, "swap"), r, "drop")],
];
// One edit inside a word of 4+ letters that is not a URL or a company name (an edit to "Stripe" names another employer).
function typo(s: string, r: () => number, kind: "swap" | "drop" | "double"): string {
  const words = s.split(" ");
  const idx = words.map((w, i) => (/^[a-z]{4,}$/.test(w) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return s;
  const i = idx[Math.floor(r() * idx.length)], w = words[i];
  const j = 1 + Math.floor(r() * (w.length - 2));
  words[i] = kind === "swap" ? w.slice(0, j - 1) + w[j] + w[j - 1] + w.slice(j + 1) : kind === "drop" ? w.slice(0, j) + w.slice(j + 1) : w.slice(0, j) + w[j] + w.slice(j);
  return words.join(" ");
}

export function scenarios(seed = 20261029, target = 10_000): Scenario[] {
  const r = rng(seed);
  const out: Scenario[] = [];
  const seen = new Set<string>();
  const push = (s: Scenario) => { if (!seen.has(s.message)) { seen.add(s.message); out.push(s); } };
  const all = bases();
  for (const b of all) {
    const expect: Route[] = b.family === "site_named" ? [b.expect, "site_refused", "router"] : [b.expect];
    for (const [name, f] of STRICT) push({ family: b.family, message: f(b.text), base: b.text, variant: name, expect, strict: true });
  }
  for (const [text, expect] of MULTI) for (const [name, f] of STRICT) push({ family: "multi", message: f(text), base: text, variant: name, expect, strict: true });
  // Then soft variants, drawn at random, until the target count.
  let guard = 0;
  while (out.length < target && guard++ < target * 20) {
    const b = all[Math.floor(r() * all.length)];
    const [name, f] = SOFT[Math.floor(r() * SOFT.length)];
    const [n2, g] = STRICT[Math.floor(r() * STRICT.length)];
    const message = g(f(b.text, r));
    push({ family: b.family, message, base: b.text, variant: `${name}+${n2}`, expect: [...new Set<Route>([b.expect, ...FAMILY_ROUTES[b.family], "router"])], strict: false });
  }
  return out;
}

// The deterministic turns of each family: a text of one family landing on another's is a misroute even when soft.
export const FAMILY_ROUTES: Record<Family, Route[]> = {
  billing: ["billing"], app_cancel: ["apply_cancel"], site_named: ["site_refused"], app_receipts: ["receipt"], outreach_status: ["outreach_status", "standing", "outreach_replies"],
  app_status: ["standing", "status"], networking: ["networking"], connectors: ["connectors", "outlook"], apply: ["apply_queue"], site: ["site_refused"], multi: [],
};
