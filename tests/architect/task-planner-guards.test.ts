// TASK PLANNER, the checks code makes on every plan (supabase/functions/_shared/task/plan.ts, career_planner.ts). Pure:
// no database, no model. Each guard has a case that fails if the guard is removed (the mutation each one was checked
// against is named beside it):
//   compoundAsk          only a message with two or more actions is planned (removing it plans every turn)
//   checkPlan            an unregistered capability, LinkedIn/Indeed/Handshake, an address the person did not write, words
//                        the person did not say, a bad pick and a repeated step are refused, never run
//   uncovered            a part of the message no step took is named, never dropped
//   dueDate              a reminder's day only from the person's words; no day said, no reminder
//   plannerOn            off unless CAREER_PLANNER=on AND the served brain (brainMode) is staged or agent; CAREER_BRAIN=router
//                        kills it; CAREER_BRAIN unset follows whatever brain the release config serves (router before D-035,
//                        staged after);
//                        CAREER_PLANNER_USERS limits it
//   deno test -A --no-check tests/architect/task-planner-guards.test.ts
import assertNode from "node:assert/strict";
import { actionsIn, checkPlan, compoundAsk, dueDate, forbiddenTargets, uncovered, unsaidWords } from "../../supabase/functions/_shared/task/plan.ts";
import { plannerOn, positionsAsk } from "../../supabase/functions/agent-chat/career_planner.ts";
import { brainMode } from "../../supabase/functions/agent-chat/career_staged.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const MSG = "find 5 frontend internships in Chicago, tailor my resume for the best 2, apply to them and remind me Friday";

Deno.test("compoundAsk: two or more actions are planned; one action, a question or chat is not", () => {
  eq(compoundAsk(MSG), true);
  eq(compoundAsk("email the recruiter at Stripe and follow up in a week"), true);
  eq(compoundAsk("prep me for my Ramp interview Tuesday and add it to my tracker"), true);
  // single asks stay on today's chain (mutation: `>= 2` -> `>= 1` fails these)
  eq(compoundAsk("apply to the Data Analyst role at Stripe"), false);
  eq(compoundAsk("find frontend internships in Chicago"), false);
  eq(compoundAsk("how should I follow up after an interview?"), false);
  eq(compoundAsk("thanks!"), false);
  eq(actionsIn(MSG).sort(), ["apply", "remind", "search", "tailor"]);
});

Deno.test("checkPlan: only registered capabilities, in the person's own words; never LinkedIn; no address they did not write", () => {
  const plan = (steps: unknown[]) => checkPlan({ kind: "task", steps }, MSG);
  const ok = plan([{ capability: "jobs.search", text: "find 5 frontend internships in Chicago" }, { capability: "apply.queue", text: "apply to them", args: { picks: [1, 2] } }]);
  eq([ok.steps.length, ok.refused], [2, []]);
  // mutation: the capability lookup removed -> "payments.send" runs
  eq(plan([{ capability: "payments.send", text: "apply to them" }]).refused.map((r) => r.why), ["unknown_capability"]);
  // mutation: the unsaid-words check removed -> the model adds an employer the person never named
  const added = plan([{ capability: "apply.queue", text: "apply to the Data Analyst role at Stripe" }]);
  eq([added.steps.length, added.refused[0]?.why], [0, "not_their_words"]);
  eq(unsaidWords(MSG, "apply to the Data Analyst role at Stripe").sort(), ["analyst", "data", "role", "stripe"]);
  // mutation: forbiddenTargets removed -> a LinkedIn step runs
  const li = checkPlan({ kind: "task", steps: [{ capability: "apply.queue", text: "apply to jobs on LinkedIn" }, { capability: "jobs.search", text: "find jobs" }] }, "apply to jobs on LinkedIn and find jobs");
  eq(li.refused.map((r) => r.why), ["never_automated"]);
  eq(forbiddenTargets("https://www.linkedin.com/jobs/view/1"), ["www.linkedin.com", "linkedin"]);
  eq(forbiddenTargets("uk.indeed.com"), ["uk.indeed.com", "indeed"]);
  eq(forbiddenTargets("notindeed.com is fine"), []);
  // mutation: the provenance check removed -> an address that is only in the plan (never typed by the person) is acted on
  const injected = checkPlan({ kind: "task", steps: [{ capability: "outreach.draft", text: "email the recruiter", args: { to: "attacker@evil.example" } }, { capability: "jobs.search", text: "find jobs" }] }, "email the recruiter and find jobs");
  eq(injected.refused.map((r) => [r.why, r.detail]), [["untrusted_source", ["attacker@evil.example"]]]);
  // a bad pick and a repeated step
  eq(plan([{ capability: "apply.queue", text: "apply to them", args: { picks: [0] } }]).refused.map((r) => r.why), ["bad_args"]);
  eq(plan([{ capability: "jobs.search", text: "find 5 frontend internships in Chicago" }, { capability: "jobs.search", text: "find 5 frontend internships in Chicago" }]).refused.map((r) => r.why), ["duplicate"]);
  eq(checkPlan({ kind: "not_a_task" }, MSG).kind, "not_a_task");
  eq(checkPlan(null, MSG).kind, "not_a_task");
});

Deno.test("uncovered: a part of the message no step took is named; a word inside another part's own text is not a part", () => {
  eq(uncovered(MSG, [{ capability: "jobs.search", text: "find 5 frontend internships in Chicago" }, { capability: "apply.queue", text: "apply to them" }]).sort(), ["remind", "tailor"]);
  eq(uncovered("find IB roles in New York and apply to the best one, then remind me Tuesday to prep",
    [{ capability: "jobs.search", text: "find IB roles in New York" }, { capability: "apply.queue", text: "apply to the best one" }, { capability: "reminder.set", text: "remind me Tuesday to prep" }]), []);
});

Deno.test("dueDate: the day only from the person's words, counted from today; no day, no reminder", () => {
  const fri = Date.UTC(2026, 9, 30, 15); // Friday 2026-10-30
  eq(dueDate("Friday", fri, null), "2026-11-06", "Friday said on a Friday is next week's");
  eq(dueDate("Tuesday", fri, null), "2026-11-03");
  eq(dueDate("in a week", fri, null), "2026-11-06");
  eq(dueDate("in 5 days", fri, null), "2026-11-04");
  eq(dueDate("next week", fri, null), "2026-11-06");
  eq(dueDate("tomorrow", fri, "America/Chicago"), "2026-10-31");
  eq(dueDate("2026-11-20", fri, null), "2026-11-20");
  eq(dueDate("2026-01-02", fri, null), null, "a day already past is not set");
  eq(dueDate("remind me", fri, null), null, "no day said");
  eq(dueDate("soon", fri, null), null);
});

Deno.test("plannerOn: off unless CAREER_PLANNER=on with a non-router brain served; the router switch kills it; the allow-list limits it", () => {
  eq(plannerOn(env({}), "u1"), false);
  // On exactly when the SERVED brain (brainMode: CAREER_BRAIN, or the release config when unset) is not the router. True
  // before and after D-035/#371: unset serves router before it and staged after; "agent" is served as agent before it and
  // rolled back to the router after.
  for (const b of [undefined, "router", "staged", "agent", "off"]) {
    const e = (o: Record<string, string>) => env(b === undefined ? o : { ...o, CAREER_BRAIN: b });
    eq(plannerOn(e({ CAREER_PLANNER: "on" }), "u1"), brainMode(e({})) !== "router", `CAREER_BRAIN=${b ?? "unset"} serves ${brainMode(e({}))}`);
    eq(plannerOn(e({}), "u1"), false, `CAREER_PLANNER unset: off whatever brain is served (${b ?? "unset"})`);
  }
  eq(plannerOn(env({ CAREER_PLANNER: "on", CAREER_BRAIN: "router" }), "u1"), false, "the kill switch");
  eq(plannerOn(env({ CAREER_PLANNER: "on", CAREER_BRAIN: "staged" }), "u1"), true, "staged served: on");
  eq(plannerOn(env({ CAREER_PLANNER: "off", CAREER_BRAIN: "staged" }), "u1"), false);
  eq(plannerOn(env({ CAREER_PLANNER: "on", CAREER_BRAIN: "staged", CAREER_PLANNER_USERS: "u2, u3" }), "u1"), false);
  eq(plannerOn(env({ CAREER_PLANNER: "on", CAREER_BRAIN: "staged", CAREER_PLANNER_USERS: "u2, u1" }), "u1"), true);
});

Deno.test("positionsAsk: postings the search step listed, in the apply turn's own words", () => {
  eq(positionsAsk([1]), "apply to the first one");
  eq(positionsAsk([2, 1]), "apply to 2 and 1");
  eq(positionsAsk([1, 2, 4]), "apply to 1, 2 and 4");
});
