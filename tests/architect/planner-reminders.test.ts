// Planner reminders are delivered (coordinator's order, 2026-11-02, ahead of CAREER_PLANNER=on in #395): a reminder step of
// a compound ask ("remind me Friday and apply to X") is set by PR #355's setReminder into its store, one career_outbox row
// the texting channel delivers, never the planner's old career_watch_kv list that nothing sent. Unit level over the
// reminder store's memory double (the same interface supabaseReminderStore implements); the handler-level proof (outbox
// rows, "what reminders do I have") is task-planner-handler-pg.test.ts.
//   time      the row is due at the time asked in the person's own zone, and the reply says when it will arrive
//   listed    "what reminders do I have" (PR #355's turn) lists it
//   quiet     a time inside their quiet hours is said so (delivery holds it to the end of them)
//   holds     paused or STOPped, or no texting channel: nothing is set, and the reply says why
//   once      the same plan twice, or a reminder already set in chat with the same words for that day: one row
//   words     the reply never says "I don't send reminder texts"
//   deno test -A --no-check tests/architect/planner-reminders.test.ts
import assertNode from "node:assert/strict";
import { plannerTurn, type PlannerIO } from "../../supabase/functions/agent-chat/career_planner.ts";
import { memoryReminderStore, type MemoryReminders, reminderTurn } from "../../supabase/functions/_shared/career_reminders.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const THU = Date.UTC(2026, 9, 29, 15); // Thursday 2026-10-29, 10:00 AM in Chicago
const U = "u-plan-remind";

function fake(plan: unknown, init: Partial<MemoryReminders> = {}) {
  const reminders = memoryReminderStore({ reachable: { [U]: true }, zones: { [U]: "America/Chicago" }, ...init });
  const ctx: Record<string, any> = {};
  const io: PlannerIO = {
    userId: U, threadId: "t1", now: () => THU, tz: "America/Chicago", ctx, reminders,
    model: async () => ({ content: [{ type: "tool_use", name: "plan_task", input: plan }] }),
    lastIntent: async () => null,
    router: async () => ({ reply: "?", intent: "career_catchall" }),
    apply: async (text) => ({ reply: `Queued: ${text}`, intent: "career_apply_queue", status: "queued" }),
    networking: async () => null,
    tools: [] as any,
  };
  return { io, reminders };
}
const MSG = "apply to the analyst role at Stripe and remind me Friday at 3pm to prep for the call";
const PLAN = { kind: "task", steps: [{ capability: "apply.queue", text: "apply to the analyst role at Stripe" },
  { capability: "reminder.set", text: "remind me Friday at 3pm to prep for the call", args: { when: "Friday at 3pm", what: "prep for the call" } }] };
const claimed = (r: Awaited<ReturnType<typeof plannerTurn>>) => { if (!r.claimed) throw new Error(`not claimed: ${r.why}`); return r; };
const stepOf = (r: any) => (r.meta.planner as any).steps.find((s: any) => s.capability === "reminder.set");
const chicago = (at: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at));

Deno.test("time and words: one delivery row due Friday 3:00 PM in their zone; the reply says when, never 'I don't send reminder texts'", async () => {
  const { io, reminders } = fake(PLAN);
  const r = claimed(await plannerTurn(io, MSG));
  const rows = await reminders.pending(U);
  eq(rows.length, 1);
  eq(chicago(rows[0].at), "Fri 3:00 PM");
  ok(/^status:reminder:/.test(rows[0].key) && /:America\/Chicago$/.test(rows[0].key), rows[0].key);
  ok(/^Reminder: prep for the call\./.test(rows[0].text), rows[0].text);
  eq([stepOf(r).status, stepOf(r).intent], ["done", "career_reminder_set"]);
  ok(/I'll text you/.test(r.reply), r.reply);
  ok(!/don't send reminder texts/i.test(r.reply), r.reply);
});

Deno.test("listed: 'what reminders do I have' (PR #355's own turn) lists the planner's reminder", async () => {
  const { io, reminders } = fake(PLAN);
  claimed(await plannerTurn(io, MSG));
  const list = await reminderTurn({ message: "what reminders do I have", userId: U, now: THU, store: reminders });
  eq(list?.status, "shown");
  ok(/prep for the call/.test(list!.reply) && /3:00 PM/.test(list!.reply), list!.reply);
});

Deno.test("quiet hours: a reminder asked for inside them is said to arrive when they end", async () => {
  const plan = { kind: "task", steps: [PLAN.steps[0], { capability: "reminder.set", text: "remind me Friday at 11pm to prep for the call", args: { when: "Friday at 11pm", what: "prep for the call" } }] };
  const { io, reminders } = fake(plan);
  const r = claimed(await plannerTurn(io, "apply to the analyst role at Stripe and remind me Friday at 11pm to prep for the call"));
  eq((await reminders.pending(U)).length, 1);
  ok(/quiet hours/.test(r.reply) && /7:00 AM/.test(r.reply), r.reply);
});

Deno.test("holds: paused or STOPped, or no texting channel: nothing is set, the step is not done, and the reply says why", async () => {
  for (const [init, why] of [[{ paused: { [U]: true } }, /on hold/], [{ reachable: {} }, /no texting channel/]] as const) {
    const { io, reminders } = fake(PLAN, init as Partial<MemoryReminders>);
    const r = claimed(await plannerTurn(io, MSG));
    eq(await reminders.pending(U), [], JSON.stringify(init));
    eq(stepOf(r).status, "not_done");
    ok(why.test(r.reply), r.reply);
    ok(!/I'll text you/.test(r.reply), r.reply);
  }
});

Deno.test("once: the same plan sent twice is one row; one already set in chat for that day with the same words is not set again", async () => {
  const { io, reminders } = fake(PLAN);
  claimed(await plannerTurn(io, MSG));
  const again = claimed(await plannerTurn(io, MSG));
  eq((await reminders.pending(U)).length, 1, "the replayed plan set nothing new");
  ok(/already set/.test(again.reply), again.reply);
  // PR #355's own turn set it first, under its own key: the planner finds it by its words and day.
  const chat = fake(PLAN);
  const set = await reminderTurn({ message: "remind me Friday at 3pm to prep for the call", userId: U, now: THU, store: chat.reminders });
  eq(set?.status, "set");
  const r = claimed(await plannerTurn(chat.io, MSG));
  eq((await chat.reminders.pending(U)).length, 1, "one reminder, not two");
  ok(/already set/.test(r.reply), r.reply);
});
