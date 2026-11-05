// The shared Telegram pacer on an injected clock (CI time, 2026-11-05). dbTelegramPacer's `now` is passed as
// channel_rate_acquire's p_now, so a flow test paces on tests/flow/virtual-clock.ts: the same waits, computed and taken, with
// no wall-clock second per message. Production passes no `now` and the call carries no p_now (the database's clock).
// Run: deno test -A --no-check tests/architect/telegram-pacer-clock.test.ts
import { dbTelegramPacer, telegramPacerFromEnv } from "../../supabase/functions/_shared/channel_pacer.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { virtualClock } from "../flow/virtual-clock.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

// The SQL function's arithmetic (20261102180000_delivery_throughput.sql), read at p_now when it is given.
function bucketAt() {
  const rows = new Map<string, { tokens: number; at: number }>(), seen: any[] = [];
  return { seen, admin: { async rpc(name: string, a: any) {
    if (name !== "channel_rate_acquire") return { data: null, error: { message: "unknown" } };
    seen.push(a);
    const now = a.p_now ? Date.parse(a.p_now) : Date.now();
    let wait = 0;
    const cur = (k: string, i: number) => { const r = rows.get(k) ?? { tokens: a.p_bursts[i], at: now }; return Math.min(a.p_bursts[i], r.tokens + a.p_rates[i] * Math.max(0, now - r.at) / 1000); };
    a.p_keys.forEach((k: string, i: number) => { const av = cur(k, i); if (av < a.p_cost) wait = Math.max(wait, (a.p_cost - av) / a.p_rates[i] * 1000); });
    if (wait > 0) return { data: Math.max(1, Math.ceil(wait)), error: null };
    a.p_keys.forEach((k: string, i: number) => rows.set(k, { tokens: cur(k, i) - a.p_cost, at: Math.max(rows.get(k)?.at ?? now, now) }));
    return { data: 0, error: null };
  } } };
}

Deno.test("without `now` the call carries no p_now (production reads the database's clock)", async () => {
  const b = bucketAt();
  await dbTelegramPacer(b.admin)("1");
  await telegramPacerFromEnv({ get: () => undefined }, b.admin)!("2");
  eq(b.seen.map((a) => "p_now" in a), [false, false]);
});

Deno.test("with `now` the bucket is read at that instant, and telegramPacerFromEnv passes it on", async () => {
  const b = bucketAt(), at = Date.parse("2026-11-05T12:00:00.250Z");
  await dbTelegramPacer(b.admin, { now: () => at })("1");
  await telegramPacerFromEnv({ get: () => undefined }, b.admin, { now: () => at + 5 })!("2");
  eq(b.seen.map((a) => a.p_now), ["2026-11-05T12:00:00.250Z", "2026-11-05T12:00:00.255Z"]);
});

Deno.test("on the injected clock one chat still gets one message a second, and the wall barely moves", async () => {
  const b = bucketAt(), vc = virtualClock(), at: number[] = [];
  const f = (async () => { at.push(vc.clock()); return new Response(JSON.stringify({ ok: true, result: { message_id: at.length } }), { status: 200 }); }) as unknown as typeof fetch;
  const a = telegramAdapter({ token: "T", fetch: f, clock: vc.clock, sleep: vc.sleep, sharedPace: dbTelegramPacer(b.admin, { now: vc.clock, sleep: vc.sleep, random: () => 0 }) });
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) { const r = await a.send("777", ["hi"]); assert(r.ok, JSON.stringify(r)); }
  const wall = performance.now() - t0;
  eq(at.length, 5, "every message went");
  for (let i = 1; i < at.length; i++) assert(at[i] - at[i - 1] >= 999, `messages ${i} and ${i + 1} to one chat ${at[i] - at[i - 1]} ms apart on the clock`);
  assert(vc.waits.length >= 4 && vc.ahead >= 3900, `the waits were taken on the clock (${vc.waits.length} waits, ${vc.ahead} ms)`);
  assert(wall < 1000, `${Math.round(wall)} ms of wall time for 4 s of pacing`);
});
