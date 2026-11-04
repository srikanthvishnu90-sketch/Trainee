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
//   words     the reply never says "I don't send reminder texts"; the reminder says the person's words, never the model's
//   key       the key is code's: a hash of the person, the words and the exact instant (same three, one row; a later
//             time the same day, a second row); "Friday at 3pm" said on a Friday after 3pm is next Friday at 3pm, the
//             time kept; a chat reminder for the same evening time (another UTC day) is not set twice
//   deno test -A --no-check tests/architect/planner-reminders.test.ts
import assertNode from "node:assert/strict";
import { planReminderId, plannerTurn, type PlannerIO, relativeBasis, REPLAY_WINDOW_MS } from "../../supabase/functions/agent-chat/career_planner.ts";
import { memoryReminderStore, type MemoryReminders, reminderTurn } from "../../supabase/functions/_shared/career_reminders.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const THU = Date.UTC(2026, 9, 29, 15); // Thursday 2026-10-29, 10:00 AM in Chicago
const U = "u-plan-remind";

function fake(plan: unknown, init: Partial<MemoryReminders> = {}, now = THU) {
  const reminders = memoryReminderStore({ reachable: { [U]: true }, zones: { [U]: "America/Chicago" }, ...init });
  const ctx: Record<string, any> = {};
  const io: PlannerIO = {
    userId: U, threadId: "t1", now: () => now, tz: "America/Chicago", ctx, reminders,
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

const planAt = (when: string, what = "prep for the call") => ({ kind: "task", steps: [PLAN.steps[0],
  { capability: "reminder.set", text: `remind me ${when} to ${what}`, args: { when, what } }] });
const msgAt = (when: string) => `apply to the analyst role at Stripe and remind me ${when} to prep for the call`;

Deno.test("key: 'Friday at 3pm' said on a Friday after 3pm is next Friday at 3:00 PM, the stated time kept (no '9:00 AM' assumed)", async () => {
  const FRI_4PM = Date.UTC(2026, 9, 30, 21); // Friday 2026-10-30, 4:00 PM in Chicago
  const { io, reminders } = fake(planAt("Friday at 3pm"), {}, FRI_4PM);
  const r = claimed(await plannerTurn(io, msgAt("Friday at 3pm")));
  const rows = await reminders.pending(U);
  eq(rows.length, 1, r.reply);
  eq([chicago(rows[0].at), new Date(rows[0].at).toISOString().slice(0, 10)], ["Fri 3:00 PM", "2026-11-06"]);
  ok(!/9:00 AM|didn't say a time/.test(r.reply), r.reply);
});

Deno.test("key: a chat reminder for Friday 8pm Chicago (Saturday in UTC) with the same words is not set again by the plan", async () => {
  const { io, reminders } = fake(planAt("Friday at 8pm"));
  eq((await reminderTurn({ message: "remind me Friday at 8pm to prep for the call", userId: U, now: THU, store: reminders }))?.status, "set");
  const r = claimed(await plannerTurn(io, msgAt("Friday at 8pm")));
  const rows = await reminders.pending(U);
  eq(rows.length, 1, r.reply);
  eq(new Date(rows[0].at).getUTCDay(), 6, "it is Saturday in UTC: the check compares the instant, not a UTC day");
  ok(/already set/.test(r.reply), r.reply);
});

Deno.test("key: the same words at 3pm, then at 5pm the same Friday, are two reminders; the key is the hash of person, words and instant", async () => {
  const three = fake(planAt("Friday at 3pm"));
  claimed(await plannerTurn(three.io, msgAt("Friday at 3pm")));
  const five = fake(planAt("Friday at 5pm"));
  (five.io as any).reminders = three.reminders;
  const r = claimed(await plannerTurn(five.io, msgAt("Friday at 5pm")));
  const rows = (await three.reminders.pending(U)).sort((a, b) => a.at - b.at);
  eq(rows.map((x) => chicago(x.at)), ["Fri 3:00 PM", "Fri 5:00 PM"], r.reply);
  ok(!/already set/.test(r.reply), r.reply);
  for (const row of rows) eq(row.key, `status:reminder:${await planReminderId(U, "prep for the call", row.at)}:America/Chicago`);
  eq(await planReminderId(U, "Prep for the call", rows[0].at), await planReminderId(U, "prep for the call", rows[0].at), "case aside, the same words");
  ok(await planReminderId(U, "prep for the call", rows[0].at) !== await planReminderId("someone-else", "prep for the call", rows[0].at), "another person, another key");
});

Deno.test("words: the reminder says the person's words, never the model's wording", async () => {
  const plan = { kind: "task", steps: [PLAN.steps[0],
    { capability: "reminder.set", text: "remind me Friday at 3pm to prep for the call", args: { when: "Friday at 3pm", what: "prepare thoroughly for your Stripe interview" } }] };
  const { io, reminders } = fake(plan);
  claimed(await plannerTurn(io, MSG));
  const rows = await reminders.pending(U);
  eq(rows.length, 1);
  ok(/^Reminder: prep for the call\./.test(rows[0].text), rows[0].text);
  ok(!/thoroughly|interview/.test(rows[0].text), rows[0].text);
});

Deno.test("replay: a relative time ('in a week') replayed across a minute boundary is the same reminder, not a second row", async () => {
  const at = (sec: number) => Date.UTC(2026, 9, 29, 15, 0, sec);
  const plan = planAt("in a week");
  const first = fake(plan, {}, at(40)); // 10:00:40 AM in Chicago
  claimed(await plannerTurn(first.io, msgAt("in a week")));
  const replay = fake(plan, {}, at(110)); // 10:01:50 AM: 70 seconds later, past the minute
  (replay.io as any).reminders = first.reminders;
  const r = claimed(await plannerTurn(replay.io, msgAt("in a week")));
  const rows = await first.reminders.pending(U);
  eq(rows.length, 1, r.reply);
  ok(/already set/.test(r.reply), r.reply);
  // A fixed time is still keyed on its instant: the same words "in a week" and "Thursday at 10am" the same day are two.
  const fixed = fake(planAt("Thursday at 10am"), {}, at(110));
  (fixed.io as any).reminders = first.reminders;
  claimed(await plannerTurn(fixed.io, msgAt("Thursday at 10am")));
  eq((await first.reminders.pending(U)).length, 2);
});

Deno.test("relative after fixed: 'Sunday at 5pm', then 'in 3 days' (sent Sunday 10am), same words: both are set", async () => {
  const SUN_10AM = Date.UTC(2026, 10, 1, 16); // Sunday 2026-11-01, 10:00 AM in Chicago (CST)
  const sun = fake(planAt("Sunday at 5pm"), {}, SUN_10AM);
  claimed(await plannerTurn(sun.io, msgAt("Sunday at 5pm")));
  const rel = fake(planAt("in 3 days"), {}, SUN_10AM);
  (rel.io as any).reminders = sun.reminders;
  const r = claimed(await plannerTurn(rel.io, msgAt("in 3 days")));
  const rows = (await sun.reminders.pending(U)).sort((a, b) => a.at - b.at);
  eq(rows.map((x) => chicago(x.at)), ["Sun 5:00 PM", "Wed 10:00 AM"], r.reply);
  ok(!/already set/.test(r.reply), r.reply);
});

Deno.test("relative key: two sends inside one 10-minute bucket get the one key (relativeBasis), so the row is found by its key", async () => {
  const at = (sec: number) => Date.UTC(2026, 9, 29, 15, 0, sec); // 10:00:xx AM Chicago: one bucket
  const a = fake(planAt("in a week"), {}, at(5));
  claimed(await plannerTurn(a.io, msgAt("in a week")));
  const [row] = await a.reminders.pending(U);
  eq(row.key, `status:reminder:${await planReminderId(U, "prep for the call", relativeBasis(row.at))}:America/Chicago`);
  eq(relativeBasis(at(5) + 7 * 86_400_000), relativeBasis(at(65) + 7 * 86_400_000), "one bucket");
  // The key alone finds it: change the stored text so the words check cannot, and replay within the bucket.
  (a.reminders as any).dump().rows[0].text = "Reminder: something else. You asked me on x";
  const b = fake(planAt("in a week"), {}, at(65));
  (b.io as any).reminders = a.reminders;
  const r = claimed(await plannerTurn(b.io, msgAt("in a week")));
  eq((await a.reminders.pending(U)).length, 1, r.reply);
});

Deno.test("relative duplicate check: a replay across a bucket boundary (another key) within 10 minutes is still one row; 11 minutes later is two", async () => {
  const at = (min: number, sec: number) => Date.UTC(2026, 9, 29, 15, min, sec);
  const a = fake(planAt("in a week"), {}, at(8, 30)); // 10:08:30: due a week on at 10:09 (minutes rounded up)
  claimed(await plannerTurn(a.io, msgAt("in a week")));
  const due1 = (await a.reminders.pending(U))[0].at;
  const b = fake(planAt("in a week"), {}, at(9, 40)); // 10:09:40, 70 s later: due at 10:10, the next bucket
  (b.io as any).reminders = a.reminders;
  const r = claimed(await plannerTurn(b.io, msgAt("in a week")));
  const due2 = due1 + 60_000;
  ok(relativeBasis(due1) !== relativeBasis(due2), "the two due times sit in different buckets, so their keys differ");
  eq((await a.reminders.pending(U)).length, 1, r.reply);
  ok(/already set/.test(r.reply), r.reply);
  const c = fake(planAt("in a week"), {}, at(8, 30) + REPLAY_WINDOW_MS + 60_000);
  (c.io as any).reminders = a.reminders;
  claimed(await plannerTurn(c.io, msgAt("in a week")));
  eq((await a.reminders.pending(U)).length, 2, "11 minutes later is another reminder");
});
