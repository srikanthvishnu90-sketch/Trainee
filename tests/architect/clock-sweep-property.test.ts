// CLOCK SWEEP (2026-10-31): a seeded property test of the clock rules (tests/flow/db_clock.ts) around every boundary: random
// millisecond and microsecond offsets, equal timestamps, and a worker clock up to 2 s off the database's. Each rule is one a
// migration keeps (20261030040000, 20261030140000, 20261031010000) or the ordering an approval depends on (PR #341 and this
// sweep: the newest batch or offer is the one the database received last). Each block also shows the naive comparison the
// rule replaced failing on the same inputs, so the property is not vacuous. Pure: no database (the Postgres cross-check is
// tests/architect/clock-sweep-pg.test.ts). Seed: CLOCK_SEED (default fixed); printed on failure.
// Run: deno test -A --no-check tests/architect/clock-sweep-property.test.ts
import { boundToCard, cardShownAt, dueForWorker, microsToIso, msToMicros, newestFirst, notBeforeReached, pgMicros, type Stamped } from "../flow/db_clock.ts";

const SEED = Number(Deno.env.get("CLOCK_SEED") ?? 20261031);
const N = 20_000;
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int, pick: <T>(xs: T[]) => xs[int(0, xs.length - 1)] };
}
function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(`${m} (CLOCK_SEED=${SEED})`); }
const BASE = Date.parse("2026-10-31T04:00:00Z");
// A microsecond offset that lands on, just before or just after a millisecond boundary, or anywhere.
const usNear = (r: ReturnType<typeof rng>) => BigInt(r.pick([0, 1, 499, 500, 998, 999, r.int(0, 999)]));
const skewOf = (r: ReturnType<typeof rng>) => r.pick([-2000, -1999, -1000, -1, 0, 1, 1000, 1999, 2000, r.int(-2000, 2000)]);

Deno.test("clock sweep property: timestamps round-trip to the microsecond", () => {
  const r = rng(SEED);
  for (let i = 0; i < N; i++) {
    const us = msToMicros(BASE + r.int(-86_400_000, 86_400_000)) + usNear(r);
    const iso = microsToIso(us);
    ok(pgMicros(iso) === us, `round trip ${us} -> ${iso}`);
    // As Postgres prints it (text output, UTC): "2026-10-31 04:09:06.472554+00"; trailing zeros dropped.
    const pg = iso.replace("T", " ").replace("Z", "+00").replace(/\.?0+\+00$/, "+00");
    ok(pgMicros(pg) === us, `Postgres text ${pg}`);
    ok(BigInt(Date.parse(iso)) * 1000n <= us && us - BigInt(Date.parse(iso)) * 1000n < 1000n, "Date.parse keeps only the millisecond (the class)");
  }
});

Deno.test("clock sweep property: a row the database stamped in the worker's own millisecond is due (20261030040000, 20261030140000)", () => {
  const r = rng(SEED + 1);
  let naiveMissed = 0;
  for (let i = 0; i < N; i++) {
    const ms = BASE + r.int(0, 86_400_000), db = msToMicros(ms) + usNear(r);
    // Same millisecond: due under both rules, whatever the microseconds.
    ok(dueForWorker(db, ms), `due within the worker's millisecond (${db} at ${ms})`);
    ok(notBeforeReached(db, ms), `not-before reached within the worker's millisecond (${db} at ${ms})`);
    if (!(db <= msToMicros(ms))) naiveMissed++;
    // A later millisecond: never due early.
    ok(!dueForWorker(msToMicros(ms + 1) + usNear(r), ms), "a row of the next millisecond is not due yet");
    ok(!notBeforeReached(msToMicros(ms + 1) + usNear(r), ms), "a not-before of the next millisecond is not reached yet");
    // Monotone in the worker's clock, skew included: once due, due at every later reading.
    const w = ms + skewOf(r);
    if (dueForWorker(db, w)) ok(dueForWorker(db, w + r.int(0, 2000)), "due stays due");
    if (notBeforeReached(db, w)) ok(notBeforeReached(db, w + r.int(0, 2000)), "reached stays reached");
  }
  ok(naiveMissed > N / 2, `the naive comparison (db <= worker ms) misses most same-millisecond rows (${naiveMissed})`);
});

Deno.test("clock sweep property: an application a card approved is bound to that card, whatever clock showed it (20261031010000)", () => {
  const r = rng(SEED + 2);
  let oldConfirm = 0, oldAhead = 0;
  for (let i = 0; i < N; i++) {
    const tx = msToMicros(BASE + r.int(0, 86_400_000)) + usNear(r);
    // One Confirm: shown and answered in one transaction at clock_timestamp() (tx + d); its applications carry now() = tx.
    const d = BigInt(r.pick([0, 1, 7, 999, 30_000, r.int(0, 5_000_000)]));
    ok(boundToCard(tx, cardShownAt(tx + d, tx), tx + d), `one Confirm: bound (d ${d} µs)`);
    if (d > 0n && !boundToCard(tx, tx + d, tx + d)) oldConfirm++;
    // A card pushed by a worker `skew` ms off (p_now its clock) in transaction t0; answered in a later transaction t1 at
    // clock_timestamp() (t1 + d); the applications carry t1. Any gap, zero included (the same microsecond).
    const skew = skewOf(r), t0 = tx, t1 = t0 + BigInt(r.pick([0, 1, 1000, r.int(0, 3_000_000)])), pNow = t0 + BigInt(skew) * 1000n;
    ok(boundToCard(t1, cardShownAt(pNow, t0), t1 + d), `pushed by a worker ${skew} ms off: bound`);
    if (!boundToCard(t1, pNow, t1 + d)) oldAhead++;
    // An earlier time given by the caller is kept as given.
    const earlier = t0 - BigInt(r.int(1, 3_600_000_000));
    ok(cardShownAt(earlier, t0) === earlier, "an earlier shown time is kept");
    // Never shown after the transaction that shows it.
    ok(cardShownAt(pNow, t0) <= t0, "never after the transaction's start");
  }
  ok(oldConfirm > 0 && oldAhead > 0, `the old rule (shown_at = p_now) unbinds both (${oldConfirm} Confirms, ${oldAhead} pushes)`);
});

Deno.test("clock sweep property: the newest batch or offer is the one the database received last; equal times break by sequence", () => {
  const r = rng(SEED + 3);
  let callerWrong = 0;
  for (let i = 0; i < N / 10; i++) {
    // Saves, in the order the database received them (seq), each at the database's insert time (non-decreasing, often equal:
    // rows of one transaction share now()), each drafted by a worker whose `at` is its start (0-30 s of drafting before the
    // save) on a clock up to 2 s off.
    const k = r.int(2, 6);
    let t = msToMicros(BASE + r.int(0, 86_400_000));
    const saves: (Stamped & { callerMs: number })[] = [];
    for (let s = 0; s < k; s++) {
      t += BigInt(r.pick([0, 0, 1, 999, 1000, r.int(0, 5_000_000)]));
      saves.push({ atUs: t, seq: s, callerMs: Number(t / 1000n) - r.int(0, 30_000) + skewOf(r) });
    }
    const shuffled = [...saves].sort(() => r.next() - 0.5);
    const newest = [...shuffled].sort(newestFirst)[0];
    ok(newest.seq === k - 1, `the newest is the last received (got ${newest.seq} of ${k})`);
    ok(JSON.stringify([...saves].reverse().map((s) => s.seq)) === JSON.stringify([...shuffled].sort(newestFirst).map((s) => s.seq)), "one order, whatever the input order");
    const byCaller = [...saves].sort((a, b) => b.callerMs - a.callerMs)[0];
    if (byCaller.seq !== k - 1) callerWrong++;
  }
  ok(callerWrong > 0, `ordering by the caller's clock picks another batch in some runs (${callerWrong})`);
});
