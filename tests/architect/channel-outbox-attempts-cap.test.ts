// Outbox attempts cap (2026-11-05): career_outbox's check allows attempts between 0 and 10 (20261021070000_channel_parity.sql),
// and deliverDue retried a paced row (Telegram's 429 retry_after) up to MAX_PACED_ATTEMPTS = 12 times. A row rate-limited ten
// times was refused the write recording its 11th attempt; it had been handed to the provider, so it stayed "sending", the
// sweep failed it as "delivery outcome unknown" although a 429 sends nothing, and the run stopped there. Here the battery's
// model of career_outbox (scenarios-channel-r4-battery.ts) refuses, as the check does, any write past 10, and the REAL
// deliverDue and Telegram adapter run over a fake Bot API that answers every sendMessage with a 429. Postgres:
// channel-outbox-attempts-cap-pg.test.ts.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/channel-outbox-attempts-cap.test.ts
import assertNode from "node:assert/strict";
import { modelStore, type Model, type Row, T0 } from "./scenarios-channel-r4-battery.ts";
import { deliverDue, MAX_ATTEMPTS, MAX_PACED_ATTEMPTS, OUTBOX_MAX_ATTEMPTS, RUN_FAILED_NOTE } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { SENDING_TIMEOUT_MS, UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const MIN = 60000, HOUR = 3600000;
const CHECK = 10; // career_outbox_status: attempts between 0 and 10
const CONTACT = "tg:5550001";

const mkModel = (row: Partial<Row>): Model => ({
  rows: [{ id: "1", userId: "u1", key: "status:1", text: "your application was viewed", channel: null, partOf: null, part: null, deliverAt: T0 - MIN, status: "queued", attempts: 0, retryAt: null, claimedAt: null, contact: null, sentParts: 0, providerIds: [], error: null, deliveredAt: null, heldAt: null, ...row }],
  contacts: new Map([[CONTACT, { contact: CONTACT, userId: "u1", home: true, optedOut: false, optedOutAt: null, lastInboundAt: null, nudgedAt: null }]]),
  zones: new Map(), faults: { markFails: 0, readFails: 0 }, optLog: [], culprits: new Set(),
});
// The model store, with the database's check: a write that would record an 11th attempt is refused (and left "sending").
const checked = (m: Model, refused: string[]) => {
  const s = modelStore(m);
  const mark = s.mark.bind(s);
  s.mark = async (id, k) => {
    const o = m.rows.find((x) => x.id === id)!;
    if (k.status === "failed" && o.status === "sending" && o.attempts + 1 > CHECK) { refused.push(`${id}@${o.attempts + 1}`); throw new Error('new row for relation "career_outbox" violates check constraint "career_outbox_status"'); }
    return await mark(id, k);
  };
  return s;
};
// A Bot API that paces every message for two minutes (longer than the adapter waits in place, so it goes back to the outbox).
const paced = (calls: number[], clock: { t: number }) => (async (input: Request | URL | string) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!u.pathname.endsWith("/sendMessage")) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  calls.push(clock.t);
  return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 120", parameters: { retry_after: 120 } }), { status: 429, headers: { "content-type": "application/json" } });
}) as typeof fetch;

Deno.test("the paced cap fits career_outbox's check", () => {
  eq(OUTBOX_MAX_ATTEMPTS, CHECK);
  ok(MAX_PACED_ATTEMPTS <= CHECK && MAX_ATTEMPTS <= CHECK, `MAX_PACED_ATTEMPTS ${MAX_PACED_ATTEMPTS}, MAX_ATTEMPTS ${MAX_ATTEMPTS}`);
});

Deno.test("a row Telegram paces past ten times ends failed with the 429, never a refused write, never 'outcome unknown'", async () => {
  const m = mkModel({}), refused: string[] = [], calls: number[] = [], threw: string[] = [];
  const clock = { t: T0 };
  const tg = telegramAdapter({ token: `7401:${"T".repeat(34)}`, fetch: paced(calls, clock), clock: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  for (let run = 0; run < 20; run++) {
    try { await deliverDue({ store: checked(m, refused), adapters: { telegram: tg }, now: clock.t, clock: () => clock.t }); }
    catch (e) { threw.push((e as Error).message); }
    const o = m.rows[0];
    ok(o.attempts <= CHECK, `run ${run}: attempts ${o.attempts}`);
    if (o.status === "failed" && o.retryAt !== null) clock.t = Math.max(clock.t, o.retryAt) + 1000; else clock.t += 10 * MIN;
  }
  eq(refused, [], "no write the check refuses");
  eq(threw, [], "no run stops");
  const o = m.rows[0];
  eq([o.status, o.attempts, o.retryAt], ["failed", MAX_PACED_ATTEMPTS, null], "failed for good on its last paced attempt");
  ok(/^Telegram HTTP 429/.test(o.error ?? ""), `with the provider's reason: ${o.error}`);
  eq(calls.length, MAX_PACED_ATTEMPTS, "one try per attempt");
  for (let i = 1; i < calls.length; i++) ok(calls[i] - calls[i - 1] >= 120000, `try ${i + 1} no sooner than Telegram asked`);
  // nothing "sending" for the sweep to call unknown
  eq(await modelStore(m).sweep(clock.t + SENDING_TIMEOUT_MS + HOUR), 0);
  ok(o.error !== UNKNOWN_OUTCOME, "never 'outcome unknown' for a row nothing of which was sent");
});

Deno.test("a run failure on a paced row's last attempt is its last: it never leaves a retry that would need an 11th", async () => {
  // Before: the run failure (a refused STOP read) on attempt 10 of a row Telegram had paced was retried (its last error was the
  // provider's), so the next run recorded attempt 11 and was refused.
  const m = mkModel({ status: "failed", attempts: CHECK - 1, retryAt: T0 - MIN, error: "Telegram HTTP 429: Too Many Requests: retry after 120" });
  const refused: string[] = [], calls: number[] = [];
  const clock = { t: T0 };
  const tg = telegramAdapter({ token: `7401:${"T".repeat(34)}`, fetch: paced(calls, clock), clock: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  m.faults.readFails = 1;
  let threw = "";
  try { await deliverDue({ store: checked(m, refused), adapters: { telegram: tg }, now: T0, clock: () => clock.t }); } catch (e) { threw = (e as Error).message; }
  ok(/read opt-out/.test(threw), `the run fails on the refused read: ${threw}`);
  eq([m.rows[0].status, m.rows[0].attempts, m.rows[0].retryAt, m.rows[0].error], ["failed", CHECK, null, RUN_FAILED_NOTE], "failed with the reason, no retry");
  for (let run = 0; run < 3; run++) await deliverDue({ store: checked(m, refused), adapters: { telegram: tg }, now: T0 + (run + 1) * HOUR, clock: () => clock.t });
  eq(refused, [], "no write the check refuses");
  eq(calls, [], "nothing more tried");
});
