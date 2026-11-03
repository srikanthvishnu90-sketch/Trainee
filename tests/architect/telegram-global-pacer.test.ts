// TELEGRAM GLOBAL PACER (scale-90k bottleneck 6): Telegram's ~30 messages a second for the bot and one a second to a chat are
// held across every invocation by one database bucket (channel_rate_acquire), not by a pacer per request. Here: the client
// (channel_pacer.ts) and the Telegram adapter against a stand-in bucket with the SAME arithmetic as the SQL function; the SQL
// itself, with real parallel sessions, is tests/architect/delivery-throughput-pg.test.ts and tests/db/delivery_throughput.test.sql.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/telegram-global-pacer.test.ts
import { dbTelegramPacer, telegramPacerFromEnv, TELEGRAM_GLOBAL_BURST, TELEGRAM_GLOBAL_RATE } from "../../supabase/functions/_shared/channel_pacer.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const real = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The SQL function's arithmetic on the real clock, atomic (one JS turn per call).
function bucketAdmin() {
  const rows = new Map<string, { tokens: number; at: number }>();
  const calls: number[] = [];
  return { calls, admin: { async rpc(name: string, a: any) {
    if (name !== "channel_rate_acquire") return { data: null, error: { message: "unknown" } };
    calls.push(1);
    const now = performance.now();
    let wait = 0;
    const cur = (k: string, i: number) => { const r = rows.get(k) ?? { tokens: a.p_bursts[i], at: now }; return Math.min(a.p_bursts[i], r.tokens + a.p_rates[i] * Math.max(0, now - r.at) / 1000); };
    a.p_keys.forEach((k: string, i: number) => { const av = cur(k, i); if (av < a.p_cost) wait = Math.max(wait, (a.p_cost - av) / a.p_rates[i] * 1000); });
    if (wait > 0) return { data: Math.max(1, Math.ceil(wait)), error: null };
    a.p_keys.forEach((k: string, i: number) => rows.set(k, { tokens: cur(k, i) - a.p_cost, at: now }));
    return { data: 0, error: null };
  } } };
}
const okFetch = (log: number[]) => (async () => { log.push(performance.now()); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); }) as unknown as typeof fetch;

Deno.test("defaults sit under Telegram's 30 a second: rate + burst = 30", () => {
  eq(TELEGRAM_GLOBAL_RATE + TELEGRAM_GLOBAL_BURST, 30);
});

Deno.test("N parallel invocations (each its own adapter) never send more than burst + rate x elapsed, overall", async () => {
  const b = bucketAdmin(), sent: number[] = [];
  const N = 20, EACH = 10, RATE = 100, BURST = 5;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: N }, async (_, inv) => {
    // one adapter per invocation, as each request builds its own; the in-process pacer is off (a constant clock, no sleeping)
    // so only the shared bucket holds the rate
    const a = telegramAdapter({ token: "T", fetch: okFetch(sent), clock: () => 0, sleep: async () => {},
      sharedPace: dbTelegramPacer(b.admin, { rate: RATE, burst: BURST, perChatRate: 1000, sleep: real }) });
    for (let i = 0; i < EACH; i++) { const r = await a.send(`${inv * 1000 + i}`, ["hi"]); assert(r.ok, JSON.stringify(r)); }
  }));
  const elapsed = (performance.now() - t0) / 1000;
  eq(sent.length, N * EACH, "every message went");
  assert(sent.length <= BURST + RATE * elapsed + 1, `${sent.length} sends in ${elapsed.toFixed(2)} s is above ${BURST} + ${RATE} x elapsed`);
  assert(elapsed > (N * EACH - BURST) / RATE * 0.9, `the bucket paced the run (${elapsed.toFixed(2)} s for ${N * EACH} sends at ${RATE}/s)`);
  // and in every 1-second window of the sends themselves (a 10% margin for timers firing late)
  const s = sent.sort((x, y) => x - y);
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] > 1000) j++; assert(i - j + 1 <= (BURST + RATE) * 1.1 + 2, `window of ${i - j + 1} sends inside one second`); }
});

Deno.test("one chat is held to its own rate across invocations", async () => {
  const b = bucketAdmin(), sent: number[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    const a = telegramAdapter({ token: "T", fetch: okFetch(sent), clock: () => 0, sleep: async () => {}, sharedPace: dbTelegramPacer(b.admin, { rate: 1000, burst: 100, perChatRate: 20, sleep: real }) });
    for (let i = 0; i < 3; i++) await a.send("777", ["hi"]);
  }));
  eq(sent.length, 12);
  const s = sent.sort((x, y) => x - y);
  for (let i = 1; i < s.length; i++) assert(s[i] - s[i - 1] >= 40, `two sends to one chat ${(s[i] - s[i - 1]).toFixed(0)} ms apart (the chat's rate is 20/s: 50 ms)`);
});

Deno.test("a wait longer than the request should sleep is handed back: nothing is sent, the outbox waits that long", async () => {
  let fetched = 0;
  const gate = { async rpc() { return { data: 5000, error: null }; } };
  const a = telegramAdapter({ token: "T", fetch: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch, clock: () => 0, sleep: async () => {}, sharedPace: dbTelegramPacer(gate, { maxWaitMs: 1000, sleep: async () => {} }) });
  const r = await a.send("5", ["one"]) as any;
  eq([r.ok, r.retryable, r.retryAfterMs, fetched], [false, true, 5000, 0]);
  assert(/pacing/i.test(r.error), r.error);
  // partway through a reply: what went out is reported so the outbox resumes after it
  let n = 0;
  const half = { async rpc() { return { data: n++ === 0 ? 0 : 5000, error: null }; } };
  const b = telegramAdapter({ token: "T", fetch: (async () => { fetched++; return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } })); }) as unknown as typeof fetch, clock: () => 0, sleep: async () => {}, sharedPace: dbTelegramPacer(half, { maxWaitMs: 1000, sleep: async () => {} }) });
  const r2 = await b.send("5", ["one", "two"]) as any;
  eq([r2.ok, r2.retryable, r2.sent, r2.sentIds, r2.retryAfterMs], [false, true, 1, ["9"], 5000]);
});

Deno.test("a short wait is slept (with a little spread) and retried until the token comes", async () => {
  const waits: number[] = [];
  let n = 0;
  const gate = { async rpc() { return { data: n++ < 2 ? 40 : 0, error: null }; } };
  const pace = dbTelegramPacer(gate, { maxWaitMs: 1000, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
  eq(await pace("1"), { ok: true });
  eq(waits.length, 2);
  assert(waits.every((w) => w >= 40 && w <= 50), JSON.stringify(waits));
});

Deno.test("the database cannot answer (not applied, an error, nonsense): the send goes on the in-process pacer, and says so", async () => {
  const said: string[] = [];
  for (const rpc of [async () => ({ data: null, error: { message: "Could not find the function channel_rate_acquire" } }), async () => { throw new Error("network down"); }, async () => ({ data: "soon", error: null })]) {
    eq(await dbTelegramPacer({ rpc } as any, { log: (m) => said.push(m) })("1"), { ok: true });
  }
  eq(said.length, 3);
});

Deno.test("what is asked of the bucket: the global key and the chat's key, one token each, in one call", async () => {
  const seen: any[] = [];
  await dbTelegramPacer({ async rpc(_n: string, a: any) { seen.push(a); return { data: 0, error: null }; } } as any, { rate: 25, burst: 5 })("42");
  eq(seen, [{ p_keys: ["telegram:global", "telegram:chat:42"], p_rates: [25, 1], p_bursts: [5, 1], p_cost: 1 }]);
});

Deno.test("switches: no database client, or TELEGRAM_GLOBAL_PACER=off, is the in-process pacer alone; the rate can be set", async () => {
  const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  const admin = { async rpc() { return { data: 0, error: null }; } };
  eq(telegramPacerFromEnv(env({}), undefined), undefined);
  eq(telegramPacerFromEnv(env({ TELEGRAM_GLOBAL_PACER: "off" }), admin), undefined);
  assert(typeof telegramPacerFromEnv(env({}), admin) === "function");
  const seen: any[] = [];
  await telegramPacerFromEnv(env({ TELEGRAM_GLOBAL_RATE: "10", TELEGRAM_GLOBAL_BURST: "2" }), { async rpc(_n: string, a: any) { seen.push(a); return { data: 0, error: null }; } })!("1");
  eq([seen[0].p_rates[0], seen[0].p_bursts[0]], [10, 2]);
});

Deno.test("without a shared pacer the adapter is exactly what it was (the in-process pacer, no extra call)", async () => {
  const sent: number[] = [];
  const a = telegramAdapter({ token: "T", fetch: okFetch(sent), clock: () => 0, sleep: async () => {} });
  const r = await a.send("1", ["a", "b"]);
  eq([r.ok, sent.length], [true, 2]);
});

Deno.test("a chat waiting for its own second (the next bubble of a long message) does not hold up any other chat", async () => {
  const sent: { chat: string; at: number }[] = [];
  const f = (async (_u: string, i: RequestInit) => { sent.push({ chat: String(JSON.parse(String(i.body)).chat_id), at: performance.now() }); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); }) as unknown as typeof fetch;
  // the in-process pacer alone (no shared bucket): one adapter, as a delivery run has
  const a = telegramAdapter({ token: "T", fetch: f });
  const t0 = performance.now();
  const long = a.send("1", ["first", "second"]);
  await real(30);
  const other = await a.send("2", ["x"]);
  const otherAt = performance.now() - t0;
  assert(other.ok);
  assert(otherAt < 400, `the other chat waited ${otherAt.toFixed(0)} ms behind a bubble that must wait a second`);
  await long;
  const second = sent.filter((s) => s.chat === "1")[1].at - t0;
  assert(second >= 900, `the same chat's next bubble still waits its second (${second.toFixed(0)} ms)`);
  // and with the shared bucket the local pacer keeps only the overall gap (the chat's second is the bucket's key)
  const b = bucketAdmin(), t1 = performance.now();
  const c = telegramAdapter({ token: "T", fetch: okFetch([]), sharedPace: dbTelegramPacer(b.admin, { rate: 1000, burst: 100, perChatRate: 20, sleep: real }) });
  await c.send("9", ["a", "b", "c"]);
  assert(performance.now() - t1 < 500, "three bubbles to one chat take the bucket's 50 ms gaps, not three seconds");
});

Deno.test("a link, a document or a photo refused for the shared budget is a retryable failure that says how long to wait", async () => {
  let fetched = 0;
  const gate = { async rpc() { return { data: 7000, error: null }; } };
  const a = telegramAdapter({ token: "T", fetch: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch, clock: () => 0, sleep: async () => {}, sharedPace: dbTelegramPacer(gate, { maxWaitMs: 1000, sleep: async () => {} }) });
  const results: any[] = [await a.sendLink!("5", "https://example.test/x"), await a.sendDocument!("5", { bytes: new Uint8Array([1]), filename: "a.pdf", mime: "application/pdf" }), await a.sendPhoto!("5", { photoUrl: "https://example.test/p.png", caption: "c" })];
  for (const r of results) eq([r.ok, r.retryable, r.retryAfterMs], [false, true, 7000]);
  eq(fetched, 0, "nothing was sent");
});
