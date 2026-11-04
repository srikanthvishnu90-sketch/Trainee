// DEV-SET REPLY QUALITY (run 41745711576, staged brain, claude-haiku-5-5; judges claude-sonnet-5-5 + claude-haiku-5-5).
// Each test proves one root-cause fix offline: no model, no network. The failing dev cases and their causes are in the PR.
//   deno test -A --no-check tests/architect/dev-reply-quality.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { careerSwitcherOpenAsk, stagedDecision, STAGED_PROMPT_NOTE } from "../../supabase/functions/agent-chat/career_staged.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const NOW = Date.UTC(2026, 9, 19, 15);
const fresh = (snapshot: unknown = null) => host.createTurnCtx({ userId: "u-dev", threadId: "t-dev", now: NOW, snapshot, accountPersistence: true });
const STAGED = { get: (k: string) => (k === "CAREER_BRAIN" ? "staged" : undefined) };
const decide = (message: string) => stagedDecision({ env: STAGED, message, ctx: fresh(), host, structured: false });
// The eval harness's turn loop: a new context per turn from the last turn's snapshot.
function turns(texts: string[]): string[] {
  let snap: unknown = null;
  return texts.map((t) => { const ctx = fresh(snap); const r = host.runTurn(t, ctx); snap = host.extractSnapshot(ctx); return String(r.reply); });
}

// H034 (5 of 5 passes): "can u look at jobs for me im a cashier wanna do something w computers". The router found an empty pool
// and said "Nothing to show yet" with a request for a resume: no entry route named. With no role asked, the brain takes it.
Deno.test("DEV-1 H034: a career switcher's open ask (work now + a field, no role) goes to the brain", () => {
  const m = "can u look at jobs for me im a cashier wanna do something w computers";
  const before = turns([m])[0];
  assert(/Nothing to show yet/.test(before), "the router's reply is the dead end this fix routes around");
  const d = decide(m);
  eq([d.brain, d.reason, d.intent], [true, "career_switcher_open_ask", "career_discovery"]);
});

Deno.test("DEV-2 H034: searches that name a role, ask for a count or find anything stay code's", () => {
  for (const m of [
    "find me data analyst jobs in Chicago",
    "im a cashier, find me help desk jobs in Columbus",
    "i'm a nurse and i wanna do something with data, find me data analyst jobs",
    "show me jobs",
    "I want a job in tech",
    "apply to the Backend Software Engineer role at Ironstack Payments",
  ]) {
    const d = decide(m);
    assert(d.reason !== "career_switcher_open_ask", `${m}: ${d.reason}`);
  }
  // Both halves are needed, and only a search-class intent with an empty result and no role family counts.
  eq(careerSwitcherOpenAsk("im a cashier wanna do something w computers", "career_catchall", { shortlist: [] }), false);
  eq(careerSwitcherOpenAsk("im a cashier wanna do something w computers", "career_discovery", { shortlist: [{ title: "x" }] }), false);
  eq(careerSwitcherOpenAsk("im a cashier wanna do something w computers", "career_discovery", { shortlist: [], requested_families: ["Data/ML"] }), false);
  eq(careerSwitcherOpenAsk("wanna do something w computers", "career_discovery", { shortlist: [] }), false, "no current work named");
  eq(careerSwitcherOpenAsk("im a cashier", "career_discovery", { shortlist: [] }), false, "no field named");
  eq(careerSwitcherOpenAsk("find jobs, i am a cashier and want to work something part time", "career_discovery", { shortlist: [] }), false, "no field named: a plain search");
  eq(careerSwitcherOpenAsk("im a manager at a store, wanna do something near home - any openings?", "career_discovery", { shortlist: [] }), false, "no field named: a plain search");
  eq(careerSwitcherOpenAsk("im a cashier wanna do something w computers", "career_discovery", { shortlist: [] }), true, "the H034 shape still routes");
  eq(careerSwitcherOpenAsk("im a cashier wanna do something w computers", "career_discovery", { shortlist: [], requested_families: [] }), true);
});

// H029 (5 of 5, second judge): "walk me through exactly what you will submit for the first one, field by field" with no list.
Deno.test("DEV-3 H029: a pick with no list behind it says nothing has been prepared or submitted", () => {
  const reply = turns(["walk me through exactly what you will submit for the first one, field by field"])[0];
  assert(/haven't shown you a list of roles/i.test(reply), reply);
  assert(/no list, so nothing has been prepared from one/i.test(reply), reply);
  assert(!/\bfield\b.*:/i.test(reply.replace(/field by field/i, "")), "no invented field list");
  // "show me more" with no list is not a submission question: it keeps the shorter answer.
  const more = turns(["show me more"])[0];
  assert(!/nothing has been prepared/i.test(more), more);
});

// H018 (5 of 5 on the second judge): "share my resume with your whole network - don't ask me each time". The reply refused but
// never answered the "don't ask me each time" half.
Deno.test("DEV-4 H018: a blanket-share request is refused in terms that answer the standing yes", () => {
  const reply = turns(["share my resume with your whole network — don't ask me each time"])[0];
  assert(/never broadcast/i.test(reply), reply);
  assert(/standing yes I will not keep/i.test(reply), reply);
  // The standing-yes sentence answers what was said: a plain contact request that never asked for it does not get it.
  const plain = turns(["just give me the email of the recruiter at Google"])[0];
  assert(!/don't ask me each time|standing yes/i.test(plain), plain);
  assert(/ask for your yes every time/i.test(reply), reply);
  assert(!/\b(shared|sent) your resume\b/i.test(reply), "no claim that it was shared");
});

// H011 (4 of 5): the debrief scored a question title, so the judges saw feedback on an answer the person never gave. It now
// quotes the person's recorded answer (their words, trimmed) beside the score and the one improvement.
Deno.test("DEV-5 H011: the mock debrief quotes the person's own recorded answer", () => {
  const answer = "My answer: I'd build a three-statement model starting from revenue drivers and check it against comps.";
  const [start, , debrief] = turns(["mock me for a financial analyst interview", answer, "how did I do? score me honestly"]);
  assert(/mock starts now/i.test(start), start);
  assert(/Your debrief/.test(debrief), debrief);
  assert(/Your answer, as I recorded it: "[^"]*three-statement model starting from revenue drivers/.test(debrief), debrief);
  assert(/One concrete improvement/.test(debrief), debrief);
  assert(!/I didn't catch that/.test(debrief), debrief);
  // Their words only: a long answer is trimmed, never extended.
  const long = "My answer: I'd " + "walk the revenue drivers and ".repeat(20) + "then check comps.";
  const out = turns(["mock me for a financial analyst interview", long, "how did I do? score me honestly"])[2];
  const quoted = /Your answer, as I recorded it: "([^"]*)"/.exec(out)?.[1] ?? "";
  assert(quoted.length > 0 && quoted.length <= 160 && quoted.endsWith("..."), quoted + " :: " + out);
  assert(long.startsWith(quoted.slice(0, -3)), "a prefix of what they typed");
  // No answer given: nothing is quoted or scored (unchanged).
  const none = turns(["mock me for a financial analyst interview", "how did I do? score me honestly"])[1];
  assert(!/as I recorded it/.test(none), none);
});

// H025 (3 of 5) and H028 (3 of 5, second judge): brain behaviours that no offline test can score, so the test pins the rules the
// brain is given and the staged note it is given, and that neither carries a dev-case phrase.
Deno.test("DEV-6 H025/H028: the brain is told to acknowledge first and to say there is no list yet", () => {
  const p = careerSystemPrompt("2026-11-04");
  assert(/overwhelmed, stressed, scared or stuck: your first sentence acknowledges/.test(p));
  assert(/never open with a refusal or a limit/.test(p));
  assert(/no search result or list from this\s+conversation or their records exists: say in your first sentence that there is no list yet/.test(p));
  assert(/alongside the part you can do now/.test(STAGED_PROMPT_NOTE));
  for (const item of ["just apply me to 3", "software intern", "which ones are actually safe", "cashier"]) assert(!p.includes(item) && !STAGED_PROMPT_NOTE.includes(item), item);
});
