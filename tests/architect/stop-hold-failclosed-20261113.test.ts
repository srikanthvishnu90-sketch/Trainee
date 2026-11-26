// STOP AND HOLD, FAIL CLOSED (independent review, 2026-11-13). Pausing is reversible; sending is not. Each table below is read
// by what a message IS (an imperative stop beside a question, a no-send boundary beside words that also start questions, a
// bulk apply ask after "no wait", a limit word versus a word one letter away), never by one prompt's wording.
//   1 stop      a real stop followed by a question was ignored ("Pause everything. What happens if a recruiter replies while it's
//               paused?"); only a stop inside a conditional or hypothetical clause is hypothetical (career_host.js stopControlOf)
//   2 hold      "Don't send any of them." / "Leave everything unsent, I don't want any of it going out." were holds before #778 and
//               then were not, because the ask-more words (any, which, ?) sat inside the boundary sentence itself
//   3 bulk      "no wait apply to all 60 jobs" / "i do not care just apply to every job" escaped the mass_apply_unreviewed refusal
//               (142-career-router.js handleRefusal: negation stripping read them as no apply ask)
//   4 limits    an empty search said "I kept your limits: posted recently" for "decent", and "onsite" for "an office in Austin":
//               typo matching invented limits, on the branch where no filter ran (142-career-router.js statedSearchLimits)
//   5 spend     the spending-limit reply said "nothing was sent" without reading what the turn did (limit_stop.ts)
//   6 prompt    the process review called itself "Upmore's code" (agent/loop.ts)
//   deno test -A --no-check tests/architect/stop-hold-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { heldReply } from "../../supabase/functions/_shared/limit_stop.ts";

const c = core as any;
const host = (CareerHost as any).createCareerHost({ CareerAccess: c.CareerAccess, CareerOnboarding: c.CareerOnboarding, CareerRouter: c.CareerRouter, CareerDoorstep: c.CareerDoorstep, CareerReply: c.CareerReply, CareerContainment: c.CareerContainment });
const turn = (m: string) => {
  const ctx = host.createTurnCtx({ userId: "u-shf", threadId: "t-shf", now: Date.UTC(2026, 10, 13, 15), snapshot: null, accountPersistence: true });
  const r = host.runTurn(m, ctx);
  return { intent: String(r.intent ?? ""), reply: String(r.reply ?? "") };
};
const failures = (rows: string[]) => { if (rows.length) throw new Error(`${rows.length} row(s) wrong:\n  ${rows.join("\n  ")}`); };

// ---------- 1: an imperative stop applies even when another clause is a question ----------
const STOPS: [string, "account" | string][] = [
  ["Pause everything. What happens if a recruiter replies while it's paused?", "account"],
  ["Cancel the application batch. What would that do to the ones already sent?", "application_batch"],
  ["Stop all the drafts now. What happens if someone already got one?", "drafts"],
  ["Pause everything right now, I'm hypothetically going on vacation", "account"],
  ["Pause everything, what happens if a recruiter replies?", "account"],
  ["pause everything. would that stop the follow-ups too?", "account"],
  ["Stop all sending. Why did the last one go out?", "account"],
  ["Can you pause everything?", "account"],
  ["Please stop the outreach. Is there anything else queued?", "outreach"],
  ["Kill the application batch, then tell me what was already submitted", "application_batch"],
  ["Halt all messages. What would a recruiter see?", "account"],
  ["Freeze everything. If a recruiter writes back, what happens?", "account"],
  ["Stop the people list. What happens to the names you already found?", "people_list"],
  ["Drop the follow-ups. What would happen if I sent them myself?", "outreach"],
  ["If anything looks off, pause everything", "account"],
  ["Scrap all the drafts. What would that do to my applications?", "drafts"],
  ["stop everything", "account"],
  ["could you cancel the application batch? what would that do to my interviews?", "application_batch"],
];
const NOT_STOPS = [
  "should I pause everything?",
  "If I said pause everything, what happens to what's in flight? Just explain, don't do it",
  "What would happen if I paused everything?",
  "If I cancel the application batch, what happens to the ones already sent?",
  "what happens if I stop the drafts?",
  "Hypothetically, if I paused everything, would recruiters notice?",
  "Don't pause everything.",
  "Why did you stop the drafts?",
  "Is it a good idea to cancel the application batch?",
  "Do I need to stop all sending before I travel?",
  "what would it do if I halted all messages?",
  "Only tell me what it would do if I paused everything",
  "Suppose I cancel the batch, what then?",
  "Should I stop the outreach or keep going?",
];
Deno.test("1 stop: an imperative stop applies beside a question; a stop inside a conditional or a question does not", () => {
  ok(STOPS.length + NOT_STOPS.length >= 25, "table size");
  const bad: string[] = [];
  for (const [m, want] of STOPS) {
    const s = host.stopControlOf(m);
    const got = !s ? "null" : s.kind === "account" ? "account" : (s.workflows ?? []).join(",");
    if (want === "account" ? got !== "account" : !(s && s.kind === "workflow" && s.workflows.includes(want))) bad.push(`${JSON.stringify(m)} -> ${got}, want ${want}`);
  }
  for (const m of NOT_STOPS) { const s = host.stopControlOf(m); if (s) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want null`); }
  failures(bad);
});

// ---------- 2: a no-send boundary wins over the ask-more words inside it ----------
// Before #778 (git show 1ee064082^:supabase/functions/_shared/career_host.js) the first three were workflow holds.
const HOLDS = [
  "Don't send any of them.",
  "Leave everything unsent, I don't want any of it going out.",
  "Do not message anyone, I'm reconsidering which jobs I want",
  "Don't send anything.",
  "don't send anything to anyone",
  "Don't contact anyone until I say so. Any questions?",
  "Leave it all unsent for now, which is safer.",
  "Don't send any of them, I need to think about which ones matter",
  "Do not contact anyone. I'm not sure which companies I like anymore.",
  "Don't email anyone, any of it could be wrong",
  "Leave them unsent. My plans are still up in the air.",
  "don't text anyone, I'm rethinking when to start",
  "Don't start anything new, I'm unsure which direction to take",
  "Don't reach out to anyone, any message now would be too early",
];
// D-061 G1/G6, as ruled in review round 3 (2026-11-13): a boundary beside a real ask is still a hold (never cancelled); the
// ask is answered alongside it (alongside: true), and the hold is applied to effects only.
const ASKS_WITH_BOUNDARY = [
  "find me 3 lakeshore alumni working at google or trading firms i could reach out to, just research don't message anyone",
  "who are some lakeshore alumni at Stripe? names and roles, don't reach out to anyone",
  "Don't send anything yet: get that over to Marcus",
  "find 3 grads at Jane Street, research only, don't message anyone",
  "dig up lakeshore grads at Citadel or similar — names and why they're relevant, don't reach out to anyone",
  "Which companies are hiring analysts in Denver? Don't contact anyone.",
  "draft a note to the Acme recruiter, don't send anything",
  "What's Stripe like to work for? Don't contact anyone.",
  "show me data jobs in Austin, don't message anyone",
  "look up who runs recruiting at Ramp, don't email anyone",
  "Don't send anything yet, forward it to Priya",
  "Any good fintech internships in NYC? don't contact anyone",
];
Deno.test("2 hold: a no-send boundary is a hold whatever words share its sentence; a boundary beside a real ask limits the ask", () => {
  ok(HOLDS.length + ASKS_WITH_BOUNDARY.length >= 25, "table size");
  const bad: string[] = [];
  for (const m of HOLDS) { const s = host.stopControlOf(m); if (!(s && s.kind === "workflow" && s.boundary === true)) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want a workflow hold`); }
  for (const m of ASKS_WITH_BOUNDARY) { const s = host.stopControlOf(m); if (!(s && s.kind === "workflow" && s.boundary === true && s.alongside === true) || host.isHostControlled(m, {})) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want a hold alongside the answered ask`); }
  failures(bad);
});

// ---------- 3: a bulk apply ask is one unless its own clause is negated ----------
const BULK = /Applying in bulk, unseen, is not a mode this product has/;
const BULK_ASKS = [
  "no wait apply to all 60 jobs",
  "i do not care just apply to every job",
  "apply to all 60 jobs",
  "don't ask me, just apply to all 80 jobs",
  "apply to all of them, no need to review",
  "No, apply to all 75 jobs right now",
  "nah just submit all 100 applications tonight",
  "no no, apply to every job automatically",
  "never mind the review, apply to all 55 roles",
  "don't bother checking, just apply to all of them",
  "i don't care, apply to all 60 jobs",
  "no wait, apply to every job automatically",
  "ok no, apply to all 90 jobs",
];
const NOT_BULK_ASKS = [
  "don't apply to all of them",
  "do not apply to all 60 jobs yet",
  "never apply to every job automatically",
  "don't just apply to all 60 jobs, show me the best five",
  "find me 60 jobs in Denver, don't apply to anything",
  "what backend developer jobs are open in Detroit right now? Don't apply to anything",
  "do not submit all 50 applications",
  "don't apply to every job, only the good ones",
  "no need to apply to all 60 jobs",
  "never submit all of them without asking me",
  "stop, don't apply to all 80 jobs",
  "please do not apply to everything automatically",
];
Deno.test("3 bulk: an apply-to-all/every/N clause is a bulk ask unless that clause itself is negated", () => {
  ok(BULK_ASKS.length + NOT_BULK_ASKS.length >= 25, "table size");
  const bad: string[] = [];
  for (const m of BULK_ASKS) { const r = turn(m); if (r.intent !== "intent_refusal" || !BULK.test(r.reply)) bad.push(`${JSON.stringify(m)} -> ${r.intent}: ${r.reply.slice(0, 120)}`); }
  for (const m of NOT_BULK_ASKS) { const r = turn(m); if (BULK.test(r.reply)) bad.push(`${JSON.stringify(m)} -> refused as bulk apply`); }
  failures(bad);
});

// ---------- 4: limits are exact words; an empty pool never says limits were kept ----------
// [message, the limits a person stated (exact words or a known misspelling of one)]
const LIMITS: [string, string[]][] = [
  ["find decent data analyst jobs in Boston", []],
  ["any data jobs at a firm with an office in Austin", []],
  ["I pasted my resume, find analyst jobs in Chicago", []],
  ["find police officer jobs in Dallas", []],
  ["find retail jobs on Regent Street in London", []],
  ["find fresh grad software jobs in Denver", []],
  ["find customer success jobs that want a recent graduate in Miami", []],
  ["find office manager jobs in Tampa", []],
  ["find remote sensing analyst jobs in Denver", []],
  ["find frontend developer jobs, my last week at work is Friday", []],
  ["find jobs at Fresh Market in Charlotte", []],
  ["find paralegal jobs at a law office in Reno", []],
  ["find data analyst jobs in Boston", []],
  ["find remote data analyst jobs", ["remote"]],
  ["find fully remote UX designer jobs", ["remote only"]],
  ["find hybrid marketing jobs in Chicago", ["hybrid"]],
  ["find onsite nurse jobs in Denver", ["onsite"]],
  ["find data jobs posted in the last week", ["posted recently"]],
  ["fnid pharmacy technician jobs, fully remoet, potsed in the lasst week. just loking, dont aply", ["remote only", "posted recently"]],
  ["any inetrnship welding inspector positionns posed recently? hybrdi ok, not fuly onsite", ["hybrid, not fully onsite", "posted recently"]],
  ["find accountant jobs in Phoenix with no office days", ["no office days"]],
  ["find analyst jobs in Austin, in-office only", ["onsite"]],
  ["find recent postings for data engineers in Dallas", ["posted recently"]],
  ["find remote-only designer jobs", ["remote only"]],
  ["find marketing jobs, hybrid is fine, posted this week", ["hybrid", "posted recently"]],
  ["find teacher jobs in Austin, on-site", ["onsite"]],
];
const LIMIT_WORDS = ["remote only", "remote", "hybrid, not fully onsite", "hybrid", "no office days", "onsite", "posted recently"];
Deno.test("4 limits: only exact limit words (or a listed misspelling) count, and an empty pool never says it kept them", () => {
  ok(LIMITS.length >= 25, "table size");
  const R = c.CareerRouter;
  ok(typeof R.statedSearchLimits === "function", "statedSearchLimits is exported for this test");
  const bad: string[] = [];
  for (const [m, want] of LIMITS) {
    const got = R.statedSearchLimits(m);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`statedSearchLimits(${JSON.stringify(m)}) -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const r = turn(m);
    if (/\bkept your limits\b/i.test(r.reply)) bad.push(`${JSON.stringify(m)}: an empty pool said its limits were kept: ${r.reply.slice(0, 200)}`);
    const limitLine = r.reply.split("\n").join(" ").match(/You asked for ([^;.]+(?:; [^;.]+)*); no limit was applied/);
    if (want.length && r.intent === "career_discovery" && !limitLine) bad.push(`${JSON.stringify(m)}: the stated limits were not named: ${r.reply.slice(0, 200)}`);
    if (!want.length && limitLine) bad.push(`${JSON.stringify(m)}: limits invented (${limitLine[1]})`);
    for (const w of LIMIT_WORDS) if (!want.includes(w) && limitLine && limitLine[1].split("; ").includes(w)) bad.push(`${JSON.stringify(m)}: invented limit ${w}`);
  }
  failures(bad);
});

// ---------- 5: the limit reply says what the turn did, never a blanket "nothing was sent" ----------
Deno.test("5 spend: the held reply is built from the turn's recorded tool calls; an unknown or failed write is not 'nothing was sent'", () => {
  const M = "is that paypal internship posting still open? check rn";
  // No tool ran (the model call failed first): nothing was sent, as before.
  const none = heldReply(M, "spend_limit", null, null, []);
  ok(/nothing was sent/.test(none) && /Nothing was applied for/.test(none), none);
  const reads = heldReply(M, "spend_limit", null, null, [{ name: "check_posting_open", ok: true, effect: "read" }]);
  ok(/nothing was sent/.test(reads), reads);
  // The turn's effects are not known: never "nothing was sent".
  const unknown = heldReply(M, "spend_limit", null, null, null);
  ok(!/nothing was sent|Nothing was applied for/i.test(unknown), unknown);
  ok(/couldn't confirm/i.test(unknown), unknown);
  // A write tool failed partway: what it changed is not confirmed.
  const failed = heldReply(M, "spend_limit", null, null, [{ name: "queue_applications", ok: false, effect: "write_own" }]);
  ok(!/nothing was sent|Nothing was applied for/i.test(failed), failed);
  ok(/couldn't confirm/i.test(failed) && /queue/i.test(failed), failed);
  // A write ran: it is named.
  const wrote = heldReply(M, "paused", null, null, [{ name: "track_application", ok: true, effect: "write_own" }]);
  ok(!/Nothing was applied for/.test(wrote) && /track/i.test(wrote), wrote);
  // An external action was only put up for approval: nothing was sent, and it waits for a yes.
  const pending = heldReply(M, "spend_limit", null, null, [{ name: "send_outreach", ok: true, effect: "external" }]);
  ok(/nothing was sent/i.test(pending) && /approv|yes/i.test(pending), pending);
  // The handler passes the turn's recorded tool calls.
  const handler = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  ok(/limitHeldReply\([^)]*turn\.tool_calls/.test(handler), "handler-career.ts passes turn.tool_calls to the held reply");
});

// ---------- 6: the process review names Trainee ----------
Deno.test("6 prompt: the process review is from Trainee's code, never Upmore's", () => {
  const loop = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/agent/loop.ts", import.meta.url));
  ok(!/Upmore/.test(loop), "loop.ts names Upmore");
  ok(/This is from Trainee's code/.test(loop), "loop.ts names Trainee's code");
});

function ok(v: unknown, m?: string) { assertNode.ok(v, m); }

// ---------- round 2 (review 2026-11-13): a boundary sentence is a hold; a question about state beside it never cancels it ----------
const HOLDS_R2 = [
  "don't send anything. which ones are still pending?",
  "Don't email anyone. Why did you queue those?",
  "Don't send anything!! who told you to?",
  "don't contact anyone. any idea why Maya hasn't replied?",
  "Don't text anyone. Where did you get those numbers?",
  "Don't start anything new. When does my next interview start?",
  "Don't reach out to anyone, my manager might find out.",
];
// A real ask for work beside the boundary: the hold applies and the ask is answered alongside it (round 3).
const ASKS_R2 = [
  "What should I say to Leo? Don't message anyone yet.",
  "How should I follow up with Priya? don't text anyone yet",
  "Who at Airbnb could refer me? don't reach out to anyone",
  "which of my contacts work at Meta? Don't message anyone.",
  "Research Datadog's interview process, don't contact anyone there",
  "list engineers at Plaid who went to Michigan, don't contact anyone",
];
Deno.test("2b hold: a question about state beside a boundary never cancels the hold; 'find out' is not an ask", () => {
  const bad: string[] = [];
  for (const m of HOLDS_R2) { const s = host.stopControlOf(m); if (!(s && s.kind === "workflow" && s.boundary === true)) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want a workflow hold`); }
  for (const m of ASKS_R2) { const s = host.stopControlOf(m); if (!(s && s.boundary === true && s.alongside === true)) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want a hold alongside`); }
  failures(bad);
});
Deno.test("4b limits: a company or domain name is not a limit ('Remote.com')", () => {
  const R = c.CareerRouter;
  const bad: string[] = [];
  for (const m of ["find product roles at Remote.com", "jobs at remote.io in Denver"]) { const got = R.statedSearchLimits(m); if (got.length) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(got)}`); }
  failures(bad);
});

// ---------- round 3 (review 2026-11-13): a boundary is a hold, full stop; nothing beside it cancels it ----------
const HOLDS_R3 = [
  // the reviewer's
  "Don't send anything. Why did you queue those jobs?",
  "Don't message anyone. Who at Google did you already email?",
  "Don't contact anyone, I'll research them myself.",
  "Don't send anything, how do I know it's working?",
  "dont send anything, what would I even say to them",
  // thirty more: a boundary beside a question, a request, a hand-off, a reason or a plan
  "Don't send any of them. Can you show me the drafts?",
  "don't contact anyone. find me data jobs in Austin",
  "Do not message anyone, what's the status of my Stripe application?",
  "Don't email anyone. Draft a note to Lena though.",
  "don't text anyone, look up the recruiters at Ramp",
  "Leave everything unsent. Which companies replied this week?",
  "Don't send anything yet, tell me what's in the queue",
  "Don't reach out to anyone. How many applications are out?",
  "do not send any of them, list what's waiting",
  "Don't contact anyone at Plaid, research the team instead",
  "Don't start anything new. What did I apply to yesterday?",
  "don't message anyone till friday. who is on the people list?",
  "Don't send anything!!! where are my drafts",
  "Leave them unsent. Write me a better version of the Acme note.",
  "Don't email anyone, show me jobs posted this week",
  "Do not contact anyone. What would you say to Priya if I said yes later?",
  "don't send any of it. I'm going to rewrite them all myself",
  "Don't text anyone, I'm on vacation until the 20th",
  "Please don't message anyone, my boss follows me online",
  "Don't send anything. Get the Figma draft over to Marcus for review.",
  "Don't contact anyone. Give me names of PMs at Notion.",
  "dont reach out to anyone, just research Datadog's interview loop",
  "Don't send anything, why is Maya's draft so long?",
  "Do not send any of them; when is my next interview?",
  "Don't email anyone. Find product roles at Remote.com.",
  "leave it all unsent, did the Meta application go through?",
  "Don't start anything new, how do I pause everything later?",
  "Don't message anyone until I review. Thanks!",
  "don't contact anyone - I'll handle outreach myself",
  "Don't send anything. Seriously, nothing.",
];
// Not this person's boundary: quoted words, a hypothetical, a negated boundary, or "anything else" beside a hand-off.
const NOT_HOLDS_R3 = [
  "My friend told me \"pause everything\" when she got a job. Should I?",
  "My mentor said \"don't contact anyone\" before an offer. Is that right?",
  "If I said don't send anything, would the queue stop?",
  "Send it over to Marcus. Don't send anything else.",
];
Deno.test("2c hold (round 3): a boundary is a hold whatever sits beside it; the other ask is answered alongside, never instead", () => {
  ok(HOLDS_R3.length >= 35, "the reviewer's five and thirty more");
  const bad: string[] = [];
  for (const m of HOLDS_R3) { const s = host.stopControlOf(m); if (!(s && s.kind === "workflow" && s.boundary === true)) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want a hold`); }
  for (const m of NOT_HOLDS_R3) { const s = host.stopControlOf(m); if (s) bad.push(`${JSON.stringify(m)} -> ${JSON.stringify(s)}, want null`); }
  // A bare boundary is the host's own turn (the stop reply); one beside an ask is answered and the hold rides along.
  if (!host.isHostControlled("Don't send any of them.", {})) bad.push("a bare boundary is the host's turn");
  if (host.isHostControlled("don't contact anyone. find me data jobs in Austin", {})) bad.push("a boundary beside a search is answered, not swallowed");
  const handler = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  if (!/stopAsk\.alongside\)[\s\S]{0,200}holdUnsent\(/.test(handler)) bad.push("handler-career.ts applies the hold on an alongside turn");
  failures(bad);
});
