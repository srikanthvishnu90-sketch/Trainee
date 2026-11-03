// Parity audit R10 (alerts and watches): a promised message (a reminder the person set, the morning job report, the morning
// brief, the weekly summary) goes out once at its time; one that goes out late says it is late and when it was due; one that
// never went out (its sends failed for good, or it was too old to send as news) is owned in the NEXT message the person gets,
// once, never silently. The person's own choices (STOP, a pause, alerts turned off) are not misses and are never "owned".
// Delivery is channel.ts deliverDue (what trainee-deliver runs); the store is the in-memory one. Nothing is sent anywhere.
// Run: deno test -A --no-check tests/architect/parity-r10-miss-owned.test.ts
import nodeAssert from "node:assert/strict";
import { deliverDue, memoryChannel, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";

const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const U = "u-r10", C = "+15555550100", MIN = 60_000, HOUR = 3_600_000;
// Nov 2, 2026, 15:00 UTC = 9:00 AM Chicago (CST).
const NOW = Date.parse("2026-11-02T15:00:00Z");
const REMINDER_KEY = `status:reminder:r1:America/Chicago`;
const reminder = (at: number, id = "1"): OutboxRow => ({ id, userId: U, contact: C, key: REMINDER_KEY.replace("r1", `r${id}`), text: `Reminder: send my transcript to Acme. You asked me on Nov 1 to remind you at ${new Date(at).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })}.`, deliver_at: at, attempts: 0 });
const reply = (id: string, at: number, text = "Here are three roles in Chicago."): OutboxRow => ({ id, userId: U, contact: C, key: `reply:m${id}`, text, deliver_at: at, attempts: 0 });

// A provider that records every message (each call is one message of one or more bubbles) and fails when told to.
function provider() {
  const sent: string[][] = [];
  let failing: false | "temporary" | "permanent" = false;
  const send = async (_c: string, bubbles: string[]) => {
    if (failing) return { ok: false as const, error: "provider down", retryable: failing === "temporary" };
    sent.push(bubbles);
    return { ok: true as const, id: `p${sent.length}` };
  };
  return { send, sent, fail: (f: false | "temporary" | "permanent") => { failing = f; }, text: () => sent.map((b) => b.join("\n")) };
}
const MISSED = /\b(missed|didn't go out|did not go out|never went out|didn't reach you|did not reach you)\b/i;

Deno.test("R10: a reminder whose sends failed for good is owned in the person's next message, once, with the reminder itself", async () => {
  const store = memoryChannel([reminder(NOW - 2 * HOUR)], { promises: true });
  const p = provider();
  p.fail("permanent");
  await deliverDue({ store, send: p.send, now: NOW - 2 * HOUR });
  eq(store.rows()[0].status, "failed", "the reminder's send failed for good");
  eq(p.sent.length, 0);

  p.fail(false);
  store.queue(reply("2", NOW));
  await deliverDue({ store, send: p.send, now: NOW });
  const said = p.text();
  eq(said.length, 2, `one message owning the miss, then the answer: ${JSON.stringify(said)}`);
  assert(MISSED.test(said[0]), `the first message owns the miss: ${said[0]}`);
  assert(/send my transcript to Acme/.test(said[0]), `the missed reminder is said, so it is not lost: ${said[0]}`);
  assert(/7:00 AM/.test(said[0]), `when it was due: ${said[0]}`);
  eq(said[1], "Here are three roles in Chicago.", "the answer itself is unchanged");

  store.queue(reply("3", NOW + 5 * MIN, "Done."));
  await deliverDue({ store, send: p.send, now: NOW + 5 * MIN });
  eq(p.text().slice(2), ["Done."], "a miss is owned once: the message after carries nothing about it");
});

Deno.test("R10: a morning job report too old to send is not silently dropped: the next message says it was missed", async () => {
  const report: OutboxRow = { id: "1", userId: U, contact: C, key: "report:2026-10-31", text: "Your morning job matches: 3 new.\n- Data Analyst, Acme\n  https://boards.greenhouse.io/acme/jobs/1", deliver_at: NOW - 49 * HOUR, attempts: 0 };
  const store = memoryChannel([report], { promises: true });
  const p = provider();
  await deliverDue({ store, send: p.send, now: NOW });
  eq(p.sent.length, 0, "a report 49 hours past its time is not sent as news");
  store.queue(reply("2", NOW + MIN));
  await deliverDue({ store, send: p.send, now: NOW + MIN });
  const said = p.text();
  eq(said.length, 2, JSON.stringify(said));
  assert(MISSED.test(said[0]) && /report/i.test(said[0]) && /Oct 31/.test(said[0]), `the missed report is named with its day: ${said[0]}`);
  assert(!/greenhouse/.test(said[0]), "stale postings are not re-sent inside the apology");
});

Deno.test("R10: the person's own choices are not misses: a paused account's reminder is never 'owned' afterwards", async () => {
  const store = memoryChannel([reminder(NOW - HOUR)], { promises: true });
  let paused = true;
  (store as any).quiet = async () => paused;
  const p = provider();
  await deliverDue({ store, send: p.send, now: NOW - HOUR });
  eq(store.rows()[0].status, "skipped_opt_out", "paused: not sent");
  paused = false;
  store.queue(reply("2", NOW));
  await deliverDue({ store, send: p.send, now: NOW });
  eq(p.text(), ["Here are three roles in Chicago."], "nothing to own: the person paused it");
});

Deno.test("R10: a promised message that goes out late says it is late and when it was due; on time, it says nothing extra", async () => {
  const late = memoryChannel([reminder(NOW - 2 * HOUR)], { promises: true });
  const p = provider();
  await deliverDue({ store: late, send: p.send, now: NOW });
  const said = p.text()[0];
  assert(/\blate\b/i.test(said), `a reminder 2 hours late says so: ${said}`);
  assert(/7:00 AM/.test(said), `and the time it was due, on the person's clock (Chicago): ${said}`);
  assert(/send my transcript to Acme/.test(said), "the reminder itself follows");

  const onTime = memoryChannel([reminder(NOW - 5 * MIN)], { promises: true });
  const q = provider();
  await deliverDue({ store: onTime, send: q.send, now: NOW });
  assert(!/\blate\b/i.test(q.text()[0]), `5 minutes after its time is on time: ${q.text()[0]}`);

  const answer = memoryChannel([reply("9", NOW - 2 * HOUR, "Sure.")], { promises: true });
  const r = provider();
  await deliverDue({ store: answer, send: r.send, now: NOW });
  eq(r.text(), ["Sure."], "an answer to the person's own message is never labelled late");
});

Deno.test("R10: a miss whose owning message could not be sent is owned by the next message that does go", async () => {
  const store = memoryChannel([reminder(NOW - 3 * HOUR)], { promises: true });
  const p = provider();
  p.fail("permanent");
  await deliverDue({ store, send: p.send, now: NOW - 3 * HOUR });
  // The next message fails too (temporarily): nothing went, so nothing is owned yet.
  p.fail("temporary");
  store.queue(reply("2", NOW));
  await deliverDue({ store, send: p.send, now: NOW });
  eq(p.sent.length, 0);
  p.fail(false);
  await deliverDue({ store, send: p.send, now: NOW + 2 * MIN });
  const said = p.text();
  eq(said.length, 2, JSON.stringify(said));
  assert(MISSED.test(said[0]), said[0]);
  eq(said[1], "Here are three roles in Chicago.");
});

Deno.test("R10: two misses are owned together in one message, not one message each", async () => {
  const store = memoryChannel([reminder(NOW - 3 * HOUR, "1"), reminder(NOW - 2 * HOUR, "2")], { promises: true });
  const p = provider();
  p.fail("permanent");
  await deliverDue({ store, send: p.send, now: NOW - 2 * HOUR });
  p.fail(false);
  store.queue(reply("3", NOW));
  await deliverDue({ store, send: p.send, now: NOW });
  eq(p.sent.length, 2, `one owning message and the answer: ${JSON.stringify(p.text())}`);
  eq((p.text()[0].match(/send my transcript to Acme/g) ?? []).length, 2, "both reminders are in it");
});

Deno.test("R10: the Supabase store reads misses and records them owned, and both production delivery paths turn it on", async () => {
  const s = supabaseChannelStore({} as any, { promises: true });
  eq(typeof s.misses, "function", "misses(userId, now)");
  eq(typeof s.ownMisses, "function", "ownMisses(userId, ids, at)");
  const read = (f: string) => Deno.readTextFile(new URL(`../../supabase/functions/${f}`, import.meta.url));
  assert(/supabaseChannelStore\(admin, \{ promises: true \}\)/.test(await read("trainee-deliver/index.ts")), "the delivery run keeps the promise record");
  eq(((await read("_shared/channel_runtime.ts")).match(/promises: true/g) ?? []).length, 2, "the answer path keeps it too (one row, or everything due for the person)");
});
