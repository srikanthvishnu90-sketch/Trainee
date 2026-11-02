// TASK PLANNER, plannerTurn itself (supabase/functions/agent-chat/career_planner.ts) with a fake model and fake paths:
// pure, no database, no spend. Review of PR #362: each case below fails under the mutation named beside it.
//   caps        one message runs at most MAX_STEPS steps, ONE apply step (one card; later picks join it), at most
//               MAX_REMINDERS reminders and MAX_PICKS postings per step; what is over is named in the reply, never run
//               (mutations: the steps cap, the per-type cap, the apply merge or the picks cap removed)
//   uncovered   a part of the message no step took is named in the reply and the turn is partial (mutation: the
//               uncovered line dropped from the reply)
//   tracker     a tracker step's employer must be in the person's message (mutation: the employer check removed)
//   reminder    a reminder's day comes from the person's own words, never the model's args (mutation: `when` used as said)
//   one step    a compound message the model plans as one step is today's chain's, not claimed (mutation: `< 2` -> `< 1`)
//   deno test -A --no-check tests/architect/task-planner-turn.test.ts
import assertNode from "node:assert/strict";
import { plannerTurn, type PlannerIO } from "../../supabase/functions/agent-chat/career_planner.ts";
import { checkPlan, MAX_PICKS, MAX_REMINDERS, MAX_STEPS } from "../../supabase/functions/_shared/task/plan.ts";
import { memoryReminderStore } from "../../supabase/functions/_shared/task/reminders.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const FRI = Date.UTC(2026, 9, 30, 15); // Friday 2026-10-30
const LIST = Array.from({ length: 40 }, (_, i) => ({ job_id: `j${i + 1}`, title: `Frontend Intern ${i + 1}`, company: `Co${i + 1}` }));

function fake(plan: unknown) {
  const calls = { model: 0, router: [] as string[], apply: [] as string[], networking: [] as string[], track: [] as any[], remember: [] as any[] };
  const reminders = memoryReminderStore();
  const ctx: Record<string, any> = {};
  const io: PlannerIO = {
    userId: "u1", threadId: "t1", now: () => FRI, tz: null, ctx, reminders,
    model: async () => { calls.model++; return { content: [{ type: "tool_use", name: "plan_task", input: plan }] }; },
    lastIntent: async () => null,
    router: async (text) => {
      calls.router.push(text);
      if (/^(find|search)/i.test(text)) { ctx.discovery = { lastShortlist: LIST }; return { reply: `Found ${LIST.length}.`, intent: "career_discovery" }; }
      if (/^tailor/i.test(text)) return { reply: `Tailored: ${text}`, intent: "career_tailor", result: { artifact: { jobId: text } } };
      if (/prep/i.test(text)) return { reply: "Prep brief.", intent: "career_interview_prep" };
      return { reply: "?", intent: "career_catchall" };
    },
    apply: async (text) => { calls.apply.push(text); return { reply: `Queued: ${text}`, intent: "career_apply_queue", status: "queued" }; },
    networking: async (text) => { calls.networking.push(text); return { reply: "Drafted.", intent: "career_outreach", status: "drafted" }; },
    tools: [
      { name: "track_application", run: async (i: any) => { calls.track.push(i); return { application: { company: i.company, role: i.role, stage: i.stage } }; } },
      { name: "remember_instruction", run: async (i: any) => { calls.remember.push(i); return { kept: { text: i.instruction } }; } },
    ] as any,
  };
  return { io, calls, reminders };
}
const claimed = (r: Awaited<ReturnType<typeof plannerTurn>>) => { if (!r.claimed) throw new Error(`not claimed: ${r.why}`); return r; };

Deno.test("caps: 40 apply steps are ONE apply turn (picks joined, capped at MAX_PICKS), the rest named; no model step runs past the cap", async () => {
  const msg = "find frontend internships in Chicago and apply to all of them";
  const plan = { kind: "task", steps: [{ capability: "jobs.search", text: "find frontend internships in Chicago" },
    ...LIST.map((_, i) => ({ capability: "apply.queue", text: "apply to all of them", args: { picks: [i + 1] } }))] };
  const { io, calls } = fake(plan);
  const r = claimed(await plannerTurn(io, msg));
  eq(calls.apply, ["apply to 1, 2, 3, 4 and 5"], "one apply turn, one card, the first MAX_PICKS postings");
  eq(r.resultStatus, "partial");
  ok(r.reply.includes(`at most ${MAX_PICKS} postings`) && r.reply.includes("postings 6, 7, 8"), r.reply);
  eq((r.meta.planner as any).steps.map((s: any) => s.capability), ["jobs.search", "apply.queue"]);
});

Deno.test("caps: two apply steps that cannot join (named roles) are one apply turn; the second is named, not run", async () => {
  const msg = "apply to the analyst role at Stripe, apply to the analyst role at Ramp and remind me Friday";
  const { io, calls } = fake({ kind: "task", steps: [{ capability: "apply.queue", text: "apply to the analyst role at Stripe" }, { capability: "apply.queue", text: "apply to the analyst role at Ramp" },
    { capability: "reminder.set", text: "remind me Friday", args: { when: "Friday" } }] });
  const r = claimed(await plannerTurn(io, msg));
  eq(calls.apply, ["apply to the analyst role at Stripe"]);
  ok(/on one card/.test(r.reply) && r.reply.includes("Ramp"), r.reply);
});

Deno.test(`caps: at most ${MAX_REMINDERS} reminders from one message; the rest are named`, async () => {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const msg = `find jobs in Chicago and ${days.map((d) => `remind me ${d}`).join(", ")}`;
  const { io, reminders } = fake({ kind: "task", steps: [{ capability: "jobs.search", text: "find jobs in Chicago" },
    ...days.map((d) => ({ capability: "reminder.set", text: `remind me ${d}`, args: { what: "follow up", when: d } }))] });
  const r = claimed(await plannerTurn(io, msg));
  eq((await reminders.list("u1")).length, MAX_REMINDERS);
  ok(r.reply.includes(`at most ${MAX_REMINDERS} reminders`) && r.reply.includes("remind me Thursday") && r.reply.includes("remind me Saturday"), r.reply);
  eq(r.resultStatus, "partial");
});

Deno.test(`caps: at most ${MAX_STEPS} steps from one message; the rest are named`, async () => {
  const cities = ["Chicago", "Denver", "Austin", "Boston", "Miami", "Seattle", "Portland", "Dallas", "Houston", "Atlanta", "Phoenix", "Tampa"];
  const msg = `find jobs in ${cities.join(", ")} and tailor my resume`;
  const { io, calls } = fake({ kind: "task", steps: cities.map((c) => ({ capability: "jobs.search", text: `find jobs in ${c}` })) });
  const r = claimed(await plannerTurn(io, msg));
  eq(calls.router.length, MAX_STEPS, "no step past the cap runs");
  ok(r.reply.includes(`at most ${MAX_STEPS} steps`) && cities.slice(MAX_STEPS).every((c) => r.reply.includes(c)), r.reply);
  eq(checkPlan({ kind: "task", steps: cities.map((c) => ({ capability: "jobs.search", text: `find jobs in ${c}` })) }, msg).refused.map((x) => x.why), Array(cities.length - MAX_STEPS).fill("over_cap"));
});

Deno.test("uncovered: a part no step took is named in the reply and the turn is partial", async () => {
  const msg = "find jobs in Chicago, apply to the first one and remind me Friday";
  const { io } = fake({ kind: "task", steps: [{ capability: "jobs.search", text: "find jobs in Chicago" }, { capability: "apply.queue", text: "apply to the first one", args: { picks: [1] } }] });
  const r = claimed(await plannerTurn(io, msg));
  eq((r.meta.planner as any).uncovered, ["remind"]);
  ok(/Not started from your message: the part to remind/.test(r.reply), r.reply);
  eq(r.resultStatus, "partial");
});

Deno.test("tracker: an employer the person never named is not written; one they named is", async () => {
  const msg = "prep me for my Ramp interview Tuesday and add it to my tracker";
  const step = (company: string) => ({ kind: "task", steps: [{ capability: "interview.prep", text: "prep me for my Ramp interview" }, { capability: "tracker.update", text: "add it to my tracker", args: { company, stage: "Interview rounds", when: "Tuesday" } }] });
  const bad = fake(step("Stripe"));
  const r = claimed(await plannerTurn(bad.io, msg));
  eq(bad.calls.track, [], "the model's employer is never written");
  eq((r.meta.planner as any).steps.find((s: any) => s.capability === "tracker.update").status, "not_done");
  const good = fake(step("Ramp"));
  claimed(await plannerTurn(good.io, msg));
  eq(good.calls.track.map((t) => t.company), ["Ramp"]);
});

Deno.test("reminder: the day is the person's, never the model's args", async () => {
  const noDay = fake({ kind: "task", steps: [{ capability: "jobs.search", text: "find jobs in Chicago" }, { capability: "reminder.set", text: "remind me to follow up", args: { what: "follow up", when: "Friday" } }] });
  const r = claimed(await plannerTurn(noDay.io, "find jobs in Chicago and remind me to follow up"));
  eq(await noDay.reminders.list("u1"), [], "no day said, no reminder");
  eq((r.meta.planner as any).steps.find((s: any) => s.capability === "reminder.set").status, "not_done");
  const said = fake({ kind: "task", steps: [{ capability: "jobs.search", text: "find jobs in Chicago" }, { capability: "reminder.set", text: "remind me Friday to follow up", args: { what: "follow up", when: "Friday" } }] });
  claimed(await plannerTurn(said.io, "find jobs in Chicago and remind me Friday to follow up"));
  eq((await said.reminders.list("u1")).map((x) => x.due_date), ["2026-11-06"]);
});

Deno.test("one step: a compound message planned as one step is today's chain's; nothing runs", async () => {
  const { io, calls } = fake({ kind: "task", steps: [{ capability: "jobs.search", text: "find jobs in Chicago" }] });
  const r = await plannerTurn(io, "find jobs in Chicago and apply to the first one");
  eq([r.claimed, (r as any).why], [false, "one_step"]);
  eq([calls.model, calls.router, calls.apply], [1, [], []]);
});

Deno.test(`caps: tailoring is ONE step: 7 tailor steps x 5 picks are at most ${MAX_PICKS} tailoring turns; named-role extras are named`, async () => {
  const msg = "find frontend internships in Chicago, tailor my resume for all of them and apply to the first one";
  const plan = { kind: "task", steps: [{ capability: "jobs.search", text: "find frontend internships in Chicago" },
    ...Array.from({ length: 7 }, (_, k) => ({ capability: "resume.tailor", text: "tailor my resume for all of them", args: { picks: [1, 2, 3, 4, 5].map((n) => n + 5 * k) } })),
    { capability: "apply.queue", text: "apply to the first one", args: { picks: [1] } }] };
  const { io, calls } = fake(plan);
  const r = claimed(await plannerTurn(io, msg));
  const tailors = calls.router.filter((t) => /^tailor/.test(t));
  eq(tailors.length, MAX_PICKS, `one tailor step, ${MAX_PICKS} postings: ${tailors.length} tailoring turns`);
  eq((r.meta.planner as any).steps.map((s: any) => s.capability), ["jobs.search", "resume.tailor", "apply.queue"]);
  ok(r.reply.includes(`at most ${MAX_PICKS} postings`) && r.reply.includes("postings 6, 7"), r.reply);
  // A second tailor step without picks cannot join: refused and named, never run.
  const named = fake({ kind: "task", steps: [{ capability: "resume.tailor", text: "tailor my resume for the analyst role at Stripe" }, { capability: "resume.tailor", text: "tailor my resume for the analyst role at Ramp" },
    { capability: "reminder.set", text: "remind me Friday", args: { when: "Friday" } }] });
  const r2 = claimed(await plannerTurn(named.io, "tailor my resume for the analyst role at Stripe, tailor my resume for the analyst role at Ramp and remind me Friday"));
  eq(named.calls.router, ["tailor my resume for the analyst role at Stripe"]);
  ok(/one step per message/.test(r2.reply) && r2.reply.includes("Ramp"), r2.reply);
});
