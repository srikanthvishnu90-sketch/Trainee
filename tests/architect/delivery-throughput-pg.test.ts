// DELIVERY THROUGHPUT on a real Postgres 16 with real parallel sessions (never a live project):
//   1. the shared bucket: many sessions take at once; at every simulated instant the grants so far are exactly floor(burst +
//      rate x elapsed) (so never more), and on the real clock the total never passes burst + rate x elapsed;
//   2. a 4,500-row alert wave does not hold up replies: the priority lane returns the replies first;
//   3. parallel claims (several workers, shards or not) hand every row to exactly one worker.
// Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/delivery-throughput-pg.test.ts
import { pgBinDir, startPg } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test({ name: "shared bucket, priority lane and parallel claims on real Postgres", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
  const pg = await startPg();
  try {
    const svc = pg.asService();
    const take = async (keys: string[], rates: number[], bursts: number[], now?: string) =>
      (await svc.rpc("channel_rate_acquire", { p_keys: keys, p_rates: rates, p_bursts: bursts, p_cost: 1, ...(now ? { p_now: now } : {}) }));

    // 1a. Simulated instants, 30 sessions at once at each: cumulative grants == floor(5 + 25 x t).
    const base = Date.parse("2031-01-01T00:00:00Z");
    let granted = 0;
    for (let k = 0; k <= 20; k++) {
      const at = new Date(base + k * 100).toISOString();
      const res = await Promise.all(Array.from({ length: 30 }, () => take(["pg:global"], [25], [5], at)));
      for (const r of res) assert(!r.error, JSON.stringify(r.error));
      granted += res.filter((r) => r.data === 0).length;
      eq(granted, Math.floor(5 + 25 * (k * 0.1) + 1e-9), `grants after ${k * 100} ms`);
    }
    console.log(`BUCKET simulated: 21 instants x 30 parallel sessions -> ${granted} grants (burst 5 + 25/s x 2 s = 55)`);

    // 1b. The real clock: 12 workers take 80 tokens at 40/s burst 5; the total never passes burst + rate x elapsed.
    const RATE = 40, BURST = 5, WANT = 80;
    let got = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (got < WANT) {
        const r = await take(["pg:real"], [RATE], [BURST]);
        if (r.error) throw Error(r.error.message);
        if (r.data === 0) { if (got < WANT) got++; else break; } else await sleep(Math.min(Number(r.data), 100));
      }
    }));
    const T = (performance.now() - t0) / 1000;
    assert(got >= WANT, "all taken");
    assert(got <= BURST + RATE * T + 1, `${got} grants in ${T.toFixed(2)} s is more than ${BURST} + ${RATE} x elapsed`);
    console.log(`BUCKET real clock: ${got} grants in ${T.toFixed(2)} s with 12 sessions (limit ${BURST} + ${RATE} x T = ${(BURST + RATE * T).toFixed(0)})`);

    // 1c. Global + chat in one call, atomic under contention: 20 sessions ask for the same chat at one instant; one wins, the
    // global bucket lost exactly one token.
    const at = "2031-02-01T00:00:00Z";
    const res = await Promise.all(Array.from({ length: 20 }, () => take(["pg:g3", "pg:chat:9"], [25, 1], [5, 1], at)));
    eq(res.filter((r) => r.data === 0).length, 1, "one grant for one chat at one instant");
    eq(await pg.sql(`select tokens from public.channel_rate_buckets where key = 'pg:g3'`), "4", "the global bucket paid for the one grant only");

    // 2 and 3. A wave of 4,500 alerts, 5 replies and 3 cards newer than all of it.
    await pg.sql(`
      create temporary table w as select gen_random_uuid() as id, n from generate_series(1, 300) n;
      insert into auth.users(id, email) select id, 'w-' || n || '@example.test' from w;
      insert into public.profiles(id) select id from w;
      insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at) select 'tg:' || (90000 + n), id, now(), now() from w;
      insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel)
        select w.id, 'alert:w' || w.n || '-' || j, 'alert', 'a', now() - interval '1 hour' + (w.n * 15 + j) * interval '1 millisecond', 'telegram' from w, generate_series(1, 15) j;
      insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel)
        select id, 'reply:w' || n, 'reply', 'r', now() - interval '1 second', 'telegram' from w where n <= 5;
      insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel)
        select id, 'card:w' || n, 'card', 'c', now() - interval '1 second', 'telegram' from w where n between 6 and 8;`);
    eq(await pg.sql(`select count(*) from public.career_outbox where kind = 'alert'`), "4500");
    const old = await svc.rpc("career_outbox_claim", { p_now: new Date().toISOString(), p_limit: 20 });
    assert(!old.error && old.data.every((r: any) => r.key.startsWith("alert:")), "the old claim hands out the oldest 20: all alerts, no reply (the problem)");
    await pg.sql(`update public.career_outbox set status = 'queued', claimed_at = null where status = 'sending'`);
    const pri = await svc.rpc("career_outbox_claim_lane", { p_now: new Date().toISOString(), p_limit: 20, p_lane: "priority" });
    assert(!pri.error, pri.error?.message);
    eq(pri.data.map((r: any) => r.key.split(":")[0]).sort(), ["card", "card", "card", "reply", "reply", "reply", "reply", "reply"], "the lane claim returns the 8 replies and cards behind 4,500 alerts");
    await pg.sql(`update public.career_outbox set status = 'delivered', delivered_at = now(), claimed_at = null where status = 'sending'`);

    // 3. 8 workers claim at once in 4 shards (2 per shard), 50 rows a claim, until the wave is gone: each row once.
    const seen = new Map<string, number>();
    let rounds = 0;
    const worker = async (shard: number) => {
      for (;;) {
        const r = await svc.rpc("career_outbox_claim_lane", { p_now: new Date().toISOString(), p_limit: 50, p_lane: "bulk", p_shard: shard, p_shards: 4 });
        if (r.error) throw Error(r.error.message);
        if (!r.data.length) { await sleep(30); const again = await svc.rpc("career_outbox_claim_lane", { p_now: new Date().toISOString(), p_limit: 50, p_lane: "bulk", p_shard: shard, p_shards: 4 }); if (!again.data.length) return; for (const x of again.data) seen.set(String(x.id), (seen.get(String(x.id)) ?? 0) + 1); continue; }
        rounds++;
        for (const x of r.data) seen.set(String(x.id), (seen.get(String(x.id)) ?? 0) + 1);
      }
    };
    await Promise.all([0, 1, 2, 3, 0, 1, 2, 3].map(worker));
    eq(seen.size, 4500, "every alert claimed");
    eq([...seen.values()].filter((n) => n !== 1).length, 0, "no row claimed twice");
    eq(await pg.sql(`select count(*) from public.career_outbox where status = 'sending'`), "4500");
    console.log(`CLAIM: 4,500 alerts claimed by 8 parallel workers in ${rounds} claims, each row exactly once`);

    // The same without shards: 6 parallel workers over a refilled queue.
    await pg.sql(`update public.career_outbox set status = 'queued', claimed_at = null where status = 'sending'`);
    const seen2 = new Map<string, number>();
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        const r = await svc.rpc("career_outbox_claim_lane", { p_now: new Date().toISOString(), p_limit: 100, p_lane: "bulk" });
        if (r.error) throw Error(r.error.message);
        if (!r.data.length) return;
        for (const x of r.data) seen2.set(String(x.id), (seen2.get(String(x.id)) ?? 0) + 1);
      }
    }));
    eq([seen2.size, [...seen2.values()].filter((n) => n !== 1).length], [4500, 0], "unsharded parallel claims: each once");
  } finally { await pg.stop(); }
} });
