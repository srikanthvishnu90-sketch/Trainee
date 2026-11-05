// Channel delivery round 4 (2026-11-05), part 1: provider errors of every shape, a run that fails part way, and long,
// emoji-heavy texts. The seeded battery (scenarios-channel-r4-battery.ts: a model of career_outbox with the database's states
// and rules, the real deliverDue and the real Telegram, WhatsApp and LoopMessage adapters over fake provider APIs, a virtual
// clock) runs 5,000 scenarios here; part 2 (scenarios-channel-r4b.test.ts) runs STOP, channel switches and quiet hours.
// Every scenario must hold every invariant:
//   - a part of a row reaches a provider at most once and in order, on each channel it went on;
//   - a row marked delivered arrived whole; every row ends in a state that says what happened (delivered; failed or not sent
//     with the reason; held for WhatsApp's window; or waiting for something named), never "sending", never silently gone;
//   - a row the sweep fails as "delivery outcome unknown" was handed to a provider (or the database refused to record it);
//   - a provider refusing Trainee's own credentials never fails a row for good, nor does a 200 the provider answered;
//   - nothing goes to a chat that is not the row's person's, nor to a migrated chat id; nothing after STOP; nothing in quiet hours;
//   - no message is over its platform's limit, empty, or cut inside a character;
//   - no log line and no recorded reason carries a message's words or a credential.
// And the three bugs this round found, each pinned on its own below (R1-R3).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/scenarios-channel-r4.test.ts
import assertNode from "node:assert/strict";
import { battery, modelStore, type Model, type Row, T0 } from "./scenarios-channel-r4-battery.ts";
import { deliverDue, MAX_ATTEMPTS, RUN_FAILED_NOTE } from "../../supabase/functions/_shared/channel.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { whatsappAdapter } from "../../supabase/functions/_shared/whatsapp.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { SENDING_TIMEOUT_MS, UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);

Deno.test("channel delivery round 4 battery: provider errors, a run failing part way, long emoji-heavy texts (5,000 scenarios)", async () => {
  await battery([["errors", 2200], ["crash", 1900], ["long", 900]], "");
});

// ------------------------------------------------------------------------------------------------------- the regressions
const MIN = 60000, HOUR = 3600000;
const mkModel = (rows: Partial<Row>[], contacts: [string, string][]): Model => ({
  rows: rows.map((x, i) => ({ id: String(i + 1), userId: "u1", key: `status:${i + 1}`, text: `update ${i + 1}`, channel: null, partOf: null, part: null, deliverAt: T0 - MIN, status: "queued", attempts: 0, retryAt: null, claimedAt: null, contact: null, sentParts: 0, providerIds: [], error: null, deliveredAt: null, heldAt: null, ...x })),
  contacts: new Map(contacts.map(([c, u], i) => [c, { contact: c, userId: u, home: i === 0, optedOut: false, optedOutAt: null, lastInboundAt: null, nudgedAt: null }])),
  zones: new Map(), faults: { markFails: 0, readFails: 0 }, optLog: [], culprits: new Set(),
});
const sendOk = (sent: string[]) => async (contact: string, bubbles: string[]) => { sent.push(`${contact}|${bubbles.join("/")}`); return { ok: true as const, id: `id-${sent.length}` }; };

Deno.test("R1 a run that fails part way: the rows it never reached go back as they were, not to the sweep as 'outcome unknown'", async () => {
  // Before: the database refused the write recording row 1 (sent); rows 2-6, claimed in the same batch and never sent, stayed
  // "sending", and ten minutes later the sweep failed each one as "delivery outcome unknown: ... not resent". Lost, unsent.
  for (const concurrency of [1, 3]) {
    const m = mkModel([1, 2, 3, 4, 5, 6].map((i) => ({ userId: `u${i}`, key: `status:${i}` })), [1, 2, 3, 4, 5, 6].map((i) => [`+1555000000${i}`, `u${i}`] as [string, string]));
    const sent: string[] = [];
    m.faults.markFails = 1;
    const store = modelStore(m);
    let threw = "";
    try { await deliverDue({ store, send: sendOk(sent), now: T0, concurrency }); } catch (e) { threw = (e as Error).message; }
    eq(threw, "record delivery: connection reset", "the failure is still thrown (the run records it)");
    const handed = new Set(sent.map((s) => s.split("|")[0]));
    // concurrency 1: only row 1 was sent. concurrency 3: the workers finish the row they were on and start nothing after.
    ok(sent.length === (concurrency === 1 ? 1 : 3), `sends before the stop (${concurrency}): ${sent.length}`);
    for (const o of m.rows) eq(o.status, handed.has(`+1555000000${o.userId.slice(1)}`) && m.culprits.has(o.id) ? "sending" : handed.has(`+1555000000${o.userId.slice(1)}`) ? "delivered" : "queued", `row ${o.id} (${concurrency})`);
    // the sweep fails only the row that may be with the provider; the next run sends the rest, once each
    const later = modelStore(m);
    eq(await later.sweep(T0 + SENDING_TIMEOUT_MS + MIN), 1, "only the row whose record was refused");
    await deliverDue({ store: later, send: sendOk(sent), now: T0 + SENDING_TIMEOUT_MS + MIN, concurrency });
    eq(m.rows.map((o) => o.status).sort(), ["delivered", "delivered", "delivered", "delivered", "delivered", "failed"], `everything else delivered (${concurrency})`);
    eq(m.rows.find((o) => o.status === "failed")!.error, UNKNOWN_OUTCOME);
    eq(sent.length, new Set(sent).size, "nothing twice");
  }
});

Deno.test("R1 the row whose own handling failed before any send counts one attempt and goes again; it never blocks the rows behind it", async () => {
  const m = mkModel([{}, { key: "status:2" }], [["+15550000001", "u1"]]);
  m.faults.readFails = 1; // the STOP read of row 1 is refused
  const sent: string[] = [];
  await deliverDue({ store: modelStore(m), send: sendOk(sent), now: T0 }).catch(() => {});
  eq([m.rows[0].status, m.rows[0].attempts, m.rows[0].error, m.rows[0].retryAt], ["failed", 1, RUN_FAILED_NOTE, T0 + MIN], "row 1: one attempt, retried in a minute");
  eq(m.rows[1].status, "queued", "row 2 went back untouched");
  await deliverDue({ store: modelStore(m), send: sendOk(sent), now: T0 + 30000 });
  eq(m.rows.map((o) => o.status), ["failed", "delivered"], "the next run sends row 2 at once (row 1 waits for its minute)");
  await deliverDue({ store: modelStore(m), send: sendOk(sent), now: T0 + 2 * MIN });
  eq(m.rows.map((o) => o.status), ["delivered", "delivered"], "then row 1");
  // A failure that is the row's own, every time: it ends failed with the reason after MAX_ATTEMPTS, never stuck.
  const m2 = mkModel([{}], [["+15550000001", "u1"]]);
  for (let i = 0; i < MAX_ATTEMPTS; i++) { m2.faults.readFails = 1; await deliverDue({ store: modelStore(m2), send: sendOk([]), now: T0 + i * 3600000 }).catch(() => {}); }
  eq([m2.rows[0].status, m2.rows[0].retryAt, m2.rows[0].error], ["failed", null, RUN_FAILED_NOTE]);
});

Deno.test("R1b a row the provider refused twice is not lost to one refused STOP read on its third try; it goes on the next run", async () => {
  // Before (CI flake of flow-scenarios-channel-r4, 2026-11-05): the run failure counted as the row's third and last attempt,
  // so a WhatsApp alert refused with a 502 and a 429 was failed for good with RUN_FAILED_NOTE when the database refused one
  // read on its third try: lost, never sent. Every scenario here is fixed; nothing depends on timing.
  for (const prior of ["WhatsApp HTTP 502: ", "LoopMessage HTTP 429 after 1 of 5 bubbles went out"]) {
    const m = mkModel([{ status: "failed", attempts: MAX_ATTEMPTS - 1, retryAt: T0 - MIN, error: prior }, { key: "status:2" }], [["+15550000001", "u1"]]);
    m.faults.readFails = 1; // the STOP read of row 1 is refused
    const sent: string[] = [];
    await deliverDue({ store: modelStore(m), send: sendOk(sent), now: T0 }).catch(() => {});
    eq([m.rows[0].status, m.rows[0].attempts, m.rows[0].error], ["failed", MAX_ATTEMPTS, RUN_FAILED_NOTE], `${prior}: the run failure is recorded`);
    ok(m.rows[0].retryAt !== null && m.rows[0].retryAt > T0, `${prior}: and the row is tried again, not failed for good`);
    eq(m.rows[1].status, "queued", "row 2 went back untouched");
    await deliverDue({ store: modelStore(m), send: sendOk(sent), now: m.rows[0].retryAt! });
    eq(m.rows.map((o) => o.status), ["delivered", "delivered"], `${prior}: both went`);
    eq(sent.length, 2, "each once");
  }
  // Still bounded: a row whose own handling fails in two runs in a row once its attempts are used ends failed with the reason.
  const m = mkModel([{ status: "failed", attempts: MAX_ATTEMPTS - 1, retryAt: T0 - MIN, error: "WhatsApp HTTP 502: " }], [["+15550000001", "u1"]]);
  for (let i = 0; i < 2; i++) { m.faults.readFails = 1; await deliverDue({ store: modelStore(m), send: sendOk([]), now: T0 + i * 3600000 }).catch(() => {}); }
  eq([m.rows[0].status, m.rows[0].attempts, m.rows[0].retryAt, m.rows[0].error], ["failed", MAX_ATTEMPTS + 1, null, RUN_FAILED_NOTE], "failed with the reason on the second run failure in a row");
});

const SECRET = "s".repeat(40);
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
Deno.test("R2 a provider refusing Trainee's credentials (Telegram 401/404, WhatsApp 401/190, LoopMessage 401) fails nothing; one try per channel per run; they go once the secret works", async () => {
  // Before: each was a final failure. One expired WhatsApp token (code 190) failed every queued WhatsApp message, run after run.
  for (const [channel, contact, refusal] of [
    ["telegram", "tg:5550001", j({ ok: false, error_code: 401, description: "Unauthorized" }, 401)],
    ["telegram", "tg:5550001", j({ ok: false, error_code: 404, description: "Not Found" }, 404)],
    ["whatsapp", "wa:15550001", j({ error: { code: 190, type: "OAuthException", message: "Error validating access token: Session has expired" } }, 400)],
    ["whatsapp", "wa:15550001", j({ error: { message: "Unauthorized" } }, 401)],
    ["imessage", "+15550001", j({ success: false }, 401)],
  ] as const) {
    const m = mkModel(Array.from({ length: 8 }, (_, i) => ({ key: i % 2 ? `reply:x${i}` : `status:${i}` })), [[contact, "u1"]]);
    for (const c of m.contacts.values()) c.lastInboundAt = T0 - MIN;
    let broken = true, calls = 0;
    const f = (async (_u: string, init?: RequestInit) => {
      calls++;
      if (broken) return refusal.clone();
      const b = JSON.parse(String(init?.body));
      return channel === "telegram" ? j({ ok: true, result: { message_id: calls } }) : channel === "whatsapp" ? j({ messages: [{ id: `wamid.${calls}` }] }) : j({ message_id: `lm-${calls}`, text: b.text });
    }) as typeof fetch;
    const env = { TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: `lm-${"k".repeat(20)}`, TELEGRAM_BOT_TOKEN: `1:${"t".repeat(30)}`, WHATSAPP_TOKEN: `wa-${"w".repeat(20)}`, WHATSAPP_PHONE_NUMBER_ID: "1", DELIVER_BATCH_SIZE: "2" };
    const run = async (t: number) => {
      const res = await handleDeliver(new Request("http://x/", { method: "POST", headers: { "x-trainee-deliver-secret": SECRET } }), {
        env: { get: (k) => (env as Record<string, string>)[k] }, now: () => t, store: () => modelStore(m), send: (k) => loopSend({ apiKey: k, fetch: f, sleep: async () => {} }),
        adapters: (e) => adaptersFromEnv(e, { fetch: f, sleep: async () => {} }), recordRun: async () => {},
      });
      return await res.json();
    };
    const first = await run(T0);
    eq([calls, first.failed, first.delivered], [1, 0, 0], `${channel}: one refused request, nothing failed (${JSON.stringify(first)})`);
    eq(m.rows.map((o) => o.status), m.rows.map(() => "queued"), `${channel}: every row still queued`);
    await run(T0 + MIN);
    eq(calls, 2, `${channel}: the next run tries once more, then stops`);
    broken = false;
    const after = await run(T0 + 2 * MIN);
    for (let i = 0; i < 5 && m.rows.some((o) => o.status !== "delivered"); i++) await run(T0 + (3 + i) * MIN);
    eq(m.rows.map((o) => o.status), m.rows.map(() => "delivered"), `${channel}: everything went once the secret worked (${JSON.stringify(after)})`);
  }
});

Deno.test("R3 a 200 whose body could not be read is the message taken: the rest of the row goes, the row is delivered; a 200 that says ok:false is still a refusal", async () => {
  const replies = (first: Response) => { let n = 0; return (async () => (++n === 1 ? first.clone() : j({ ok: true, result: { message_id: n }, messages: [{ id: `wamid.${n}` }] }))) as unknown as typeof fetch; };
  const cut = () => new Response('{"ok":true,"result":{"message_id":', { status: 200 });
  const tg = (f: typeof fetch) => telegramAdapter({ token: `1:${"t".repeat(30)}`, fetch: f, sleep: async () => {} });
  const wa = (f: typeof fetch) => whatsappAdapter({ token: "w".repeat(30), phoneNumberId: "1", fetch: f, sleep: async () => {} });
  eq(await tg(replies(cut())).send("5550001", ["one", "two", "three"]), { ok: true, id: "2", ids: ["2", "3"] }, "Telegram: before, 'Telegram HTTP 200' and messages 2 and 3 never sent");
  eq(await wa(replies(cut())).send("15550001", ["one", "two"]), { ok: true, id: "wamid.2", ids: ["wamid.2"] }, "WhatsApp: the same");
  eq(await wa(replies(new Response("", { status: 200 }))).send("15550001", ["one"]), { ok: true, id: null, ids: [] }, "an empty 200");
  const said = await tg(replies(j({ ok: false, error_code: 400, description: "Bad Request: message text is empty" }))).send("5550001", ["one", "two"]);
  ok(!said.ok && /HTTP 200: Bad Request/.test(said.error) && !said.retryable, `a 200 that says ok:false: ${JSON.stringify(said)}`);
  const waSaid = await wa(replies(j({ error: { code: 131026, message: "Message undeliverable" } }))).send("15550001", ["one"]);
  ok(!waSaid.ok && /131026/.test(waSaid.error), `a 200 carrying an error: ${JSON.stringify(waSaid)}`);
  // Through deliverDue: the row is delivered, with the ids Telegram gave.
  const m = mkModel([{ text: Array.from({ length: 3 }, (_, i) => `paragraph ${i} ${"word ".repeat(300)}`).join("\n\n") }], [["tg:5550001", "u1"]]);
  await deliverDue({ store: modelStore(m), adapters: { telegram: tg(replies(cut())) }, now: T0 });
  eq([m.rows[0].status, m.rows[0].providerIds.length > 0], ["delivered", true]);
});

Deno.test("R2 a row part of which went in an earlier attempt waits out a credential outage too: no attempt counted while nothing goes", async () => {
  // Found by the Postgres flow on the first version of the fix: the earlier attempt's parts made the row look "partly sent" on
  // every probe during the outage, so each run counted an attempt and the third failed it for good with the 401.
  const text = Array.from({ length: 3 }, (_, i) => `paragraph ${i} ${"word ".repeat(300)}`).join("\n\n");
  const m = mkModel([{ text, status: "failed", attempts: MAX_ATTEMPTS - 1, retryAt: T0 - MIN, sentParts: 1, providerIds: ["7"] }], [["tg:5550001", "u1"]]);
  let broken = true;
  const sent: string[] = [];
  const f = (async (_u: string, init?: RequestInit) => {
    if (broken) return j({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    sent.push(JSON.parse(String(init?.body)).text);
    return j({ ok: true, result: { message_id: 7 + sent.length } });
  }) as typeof fetch;
  const tg = telegramAdapter({ token: `1:${"t".repeat(30)}`, fetch: f, sleep: async () => {} });
  for (let i = 0; i < 6; i++) {
    const store = modelStore(m);
    const r = await deliverDue({ store, adapters: { telegram: tg }, now: T0 + i * 10 * MIN });
    await store.release();
    eq([r.not_wired, m.rows[0].status, m.rows[0].attempts, m.rows[0].sentParts], [1, "failed", MAX_ATTEMPTS - 1, 1], `run ${i}: put back as it was`);
  }
  broken = false;
  const store = modelStore(m);
  await deliverDue({ store, adapters: { telegram: tg }, now: T0 + HOUR });
  eq(m.rows[0].status, "delivered");
  ok(sent.length >= 1 && !sent.some((s) => s.startsWith("paragraph 0")), "only the messages after the one that went before");
});
