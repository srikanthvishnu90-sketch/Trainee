// INGEST: THE RE-READ GAP (2026-10-31). CI run 41146111368 failed tests/architect/ingest-r2-pg.test.ts with
// "lever:s45b0: read 2 times in one tick": the claim (career_board_state_claim; career_shards.ts memoryBoardState.claim)
// skipped a board only while another run was still reading it, so a board whose read had just finished was due again at
// once and an overlapping run, or the next tick, in a small lane re-read it. Now a board attempted less than the gap ago
// (half the headroom's slack, window / 6: career_shards.ts rereadGapMs) is not claimed, finished or not.
// Seeded schedules of lane runs against the in-memory claim (the same rule as the SQL one:
// tests/architect/ingest-reread-gap-pg.test.ts), every run's claim and finish interleaved in time: overlapping runs of a
// lane at one tick, a second run inside the first, runs lost before they claim (at most one in five of a lane's runs),
// runs stopped after they claimed (their boards stay "reading"), runs handing back boards they never reached, boards
// that always fail or sometimes fail. Every schedule:
//   G1  no board is read twice within the gap (the bug: with no gap, the same schedules read boards twice in one tick)
//   G2  every healthy board is read within the window, with no run lost and with one in five lost; where more is lost
//       than the headroom covers (runs handing back boards on top of lost ones), the scheduler without the gap misses the
//       window too, and the gap makes no board wait longer than it did
//   G3  a failing board is never read inside its backoff, and is read again once it is due (not starved)
//   G4  a stopped run's boards are read again after the gap
// And through the scheduled handler: two runs of a lane one after the other at one tick read each board once; the next
// tick reads nothing; the tick at the gap reads every board again.
// No database, no network, no model.
import { boardKey, bucketOf, capacityPer, DEFAULT_REREAD_GAP_MS, HEADROOM, laneBuckets, memoryBoardState, rereadGapMs, retryAfterMs, type BoardState, WINDOW_MS } from "../../supabase/functions/_shared/career_shards.ts";
import { boardFetchFeed, type Board } from "../../supabase/functions/_shared/career_ingest.ts";
import { handleIngest } from "../../supabase/functions/career-ingest/handler.ts";
import { fakeFetch, makeJob, pgLikeDb, rng, type Net } from "./scenarios/ingest-r2-world.ts";
import { handlerDeps, SECRET, T0 } from "./scenarios/ingest-r2-generator.ts";

const MIN = 60000;
function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
const iso = (t: number) => new Date(t).toISOString();

type Kind = "clean" | "lossy" | "stopped";
interface Sched { id: string; seed: number; windowMin: number; everyMin: number; lanes: number; boards: number; overlap: number; kind: Kind; failing: number; handBack: number }
export const SCHEDULES = 900;
function generate(): Sched[] {
  const r = rng(20261031), out: Sched[] = [];
  const kinds: Kind[] = ["clean", "lossy", "stopped"];
  for (let i = 0; i < SCHEDULES; i++) {
    // The plan of scripts/launch/schedule-career-ingest.sql (60 min, every 5) most often; the 6-hour default; others with 6
    // or more runs a window (the condition rereadGapMs states).
    const windowMin = r.pick([60, 60, 60, 360, 120, 30, 15]);
    const everyMin = Math.min(r.pick([5, 5, 5, 1, 2, 10]), Math.floor(windowMin / 6));
    out.push({ id: `gap-${i}`, seed: r.int(1, 2 ** 31), windowMin, everyMin, lanes: r.pick([1, 1, 2, 4]), boards: r.pick([1, 2, 3, 5, 8, 20, 60, 150]),
      overlap: r.pick([0, 0.2, 0.5, 1]), kind: kinds[i % kinds.length], failing: r.pick([0, 0.1, 0.3]), handBack: r.pick([0, 0, 0.1]) });
  }
  return out;
}
export const ALL = generate();

interface Read { at: number; lane: number; ok: boolean }
interface Result { reads: Map<string, Read[]>; claims: Map<string, number[]>; stoppedClaims: { key: string; at: number }[]; failingKeys: Set<string>; healthy: Set<string>; laneOf: Map<string, number>; end: number }

// One schedule, every run's claim and finish in time order. gapMs: the claim's gap (0: the rule before this fix).
export async function simulate(s: Sched, gapMs: number): Promise<Result> {
  const r = rng(s.seed);
  const W = s.windowMin * MIN, I = s.everyMin * MIN;
  const st = memoryBoardState();
  const boards: Board[] = Array.from({ length: s.boards }, (_, i) => ({ company: `Co ${i}`, provider: r.pick(["greenhouse", "lever", "ashby"] as const), board: `g${s.seed % 997}b${i}` }));
  await st.seed(boards);
  const behaviour = new Map<string, "ok" | "fail" | "flaky">();
  for (const b of boards) behaviour.set(boardKey(b), r.chance(s.failing) ? r.pick(["fail", "flaky"] as const) : "ok");
  const laneCount = new Map<number, number>();
  for (const b of boards) { const l = bucketOf(b) % s.lanes; laneCount.set(l, (laneCount.get(l) ?? 0) + 1); }
  const cap = (lane: number) => Math.max(capacityPer({ boards: s.boards, windowMs: W, intervalMs: I, lanes: s.lanes }), capacityPer({ boards: laneCount.get(lane) ?? 0, windowMs: W, intervalMs: I, lanes: 1 }));
  const res: Result = { reads: new Map(), claims: new Map(), stoppedClaims: [], failingKeys: new Set(), healthy: new Set(), laneOf: new Map(), end: 0 };
  for (const b of boards) { const k = boardKey(b); res.laneOf.set(k, bucketOf(b) % s.lanes); if (behaviour.get(k) === "ok") res.healthy.add(k); else res.failingKeys.add(k); }
  // The runs: one a lane a tick (a few seconds late), some lost before they claim (never more than one in five of a lane's
  // runs), a second run at the same tick (overlap: at once, or inside the first's read, or after it finished).
  type Ev = { at: number; kind: "claim"; lane: number; stop: boolean } | { at: number; kind: "finish"; lane: number; claimAt: number; rows: BoardState[]; reached: number };
  const evs: Ev[] = [];
  const ticks = Math.ceil((3 * W) / I);
  for (let k = 0; k < ticks; k++) {
    for (let lane = 0; lane < s.lanes; lane++) {
      const t = k * I + r.int(0, 20) * 1000;
      const lost = s.kind === "lossy" && k % 5 === lane % 5 && r.chance(0.9);
      if (!lost) evs.push({ at: t, kind: "claim", lane, stop: s.kind === "stopped" && k % 5 === 1 && r.chance(0.3) });
      if (r.chance(s.overlap)) evs.push({ at: t + r.pick([0, 1000, r.int(1, 150) * 1000, r.int(1, Math.max(1, Math.floor(I / 1000) - 1)) * 1000]), kind: "claim", lane, stop: false });
    }
  }
  const insert = (e: Ev) => { let i = evs.length; while (i > 0 && evs[i - 1].at > e.at) i--; evs.splice(i, 0, e); };
  evs.sort((a, b) => a.at - b.at);
  const fails = new Map<string, number>();
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e.kind === "claim") {
      const got = (await st.claim!(laneBuckets(e.lane, s.lanes), cap(e.lane), iso(e.at), gapMs))!;
      for (const row of got) {
        const k = boardKey(row);
        // G3 at the claim: a failing board not inside its backoff.
        const f = row.fail_count, last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : null;
        if (last !== null) ok(e.at - last >= retryAfterMs(f), `${s.id} ${k}: claimed ${(e.at - last) / MIN} min after its last attempt with ${f} failures (backoff ${retryAfterMs(f) / MIN} min)`);
        ok(f === (fails.get(k) ?? 0), `${s.id} ${k}: fail_count ${f}, ${fails.get(k) ?? 0} failures in a row`);
        res.claims.set(k, [...(res.claims.get(k) ?? []), e.at]);
      }
      if (e.stop) { for (const row of got) { res.stoppedClaims.push({ key: boardKey(row), at: e.at }); const k = boardKey(row); res.reads.set(k, [...(res.reads.get(k) ?? []), { at: e.at, lane: e.lane, ok: false }]); } continue; }
      const reached = got.length && r.chance(s.handBack) ? r.int(0, got.length - 1) : got.length;
      insert({ at: e.at + r.int(1, 150) * 1000, kind: "finish", lane: e.lane, claimAt: e.at, rows: got, reached });
    } else {
      // The run's outcomes, as the handler records them (attempted at the run's start); the boards it never reached go back
      // as they were (handler.ts unclaim).
      const out: BoardState[] = [];
      e.rows.forEach((row, j) => {
        const k = boardKey(row);
        if (j >= e.reached) { out.push(row); return; }
        const b = behaviour.get(k)!, good = b === "ok" || (b === "flaky" && r.chance(0.6));
        fails.set(k, good ? 0 : (fails.get(k) ?? 0) + 1);
        res.reads.set(k, [...(res.reads.get(k) ?? []), { at: e.claimAt, lane: e.lane, ok: good }]);
        out.push({ ...row, last_attempt_at: iso(e.claimAt), last_ok_at: good ? iso(e.claimAt) : row.last_ok_at, last_status: good ? "ok" : "failed: HTTP 429", fail_count: fails.get(k)! });
      });
      await st.record(out);
    }
    res.end = Math.max(res.end, e.at);
  }
  return res;
}

// G2's measure: the longest a healthy board went without a good read (from the start, to the end of the schedule).
export function worstWait(s: Sched, x: Result): { ms: number; key: string } {
  const W = s.windowMin * MIN, I = s.everyMin * MIN, horizon = 3 * W - I;
  let ms = 0, key = "";
  for (const k of x.healthy) {
    if (x.stoppedClaims.some((c) => c.key === k)) continue; // G4
    const at = [0, ...(x.reads.get(k) ?? []).filter((r) => r.ok).map((r) => r.at), horizon];
    for (let i = 1; i < at.length; i++) if (at[i] - at[i - 1] > ms) { ms = at[i] - at[i - 1]; key = k; }
  }
  return { ms, key };
}

export function check(s: Sched, x: Result, gapMs: number) {
  const W = s.windowMin * MIN, I = s.everyMin * MIN, slack = 21 * 1000; // a run starts up to 20 s after its tick
  for (const [k, rs] of x.reads) {
    // G1: no board read twice within the gap.
    for (let i = 1; i < rs.length; i++) ok(rs[i].at - rs[i - 1].at >= gapMs, `${s.id} ${k}: read twice ${(rs[i].at - rs[i - 1].at) / 1000} s apart (gap ${gapMs / MIN} min)`);
  }
  const horizon = 3 * W - I;
  for (const k of x.failingKeys) {
    // G3: a failing board is read again once due: within its backoff (or the gap) + the window.
    const rs = x.reads.get(k) ?? [];
    ok(rs.length > 0 && rs[0].at <= W + slack, `${s.id} ${k}: a failing board is read in the first window`);
    let f = 0;
    for (let i = 0; i < rs.length; i++) {
      f = rs[i].ok ? 0 : f + 1;
      const next = i + 1 < rs.length ? rs[i + 1].at : horizon;
      if (next === horizon && rs[i].at + Math.max(retryAfterMs(f), gapMs) + W >= horizon) continue;
      ok(next - rs[i].at <= Math.max(retryAfterMs(f), gapMs) + W + slack, `${s.id} ${k}: a failing board starved (${(next - rs[i].at) / MIN} min after its read with ${f} failures)`);
    }
  }
  for (const c of x.stoppedClaims) {
    // G4: a stopped run's board is read again after the gap (and within the gap + the window).
    const next = (x.reads.get(c.key) ?? []).find((r) => r.at > c.at);
    if (!next) { ok(c.at + gapMs + W + slack >= horizon, `${s.id} ${c.key}: never read again after a stopped run at ${c.at / MIN} min`); continue; }
    ok(next.at - c.at >= gapMs && next.at - c.at <= gapMs + W + slack, `${s.id} ${c.key}: read ${(next.at - c.at) / MIN} min after a stopped run (gap ${gapMs / MIN} min)`);
  }
}

Deno.test("the re-read gap's arithmetic: half the headroom's slack, at least an interval, for the plans in use", () => {
  ok(DEFAULT_REREAD_GAP_MS === 10 * MIN, `the scheduled plan's gap (60-min window): ${DEFAULT_REREAD_GAP_MS / MIN} min`);
  ok(rereadGapMs({}) === 3600000 && rereadGapMs({ windowMs: WINDOW_MS }) === 3600000, "the 6-hour default: 1 h");
  for (const windowMin of [15, 30, 60, 120, 360, 720, 2880]) for (const everyMin of [1, 2, 5, 10, 15, 30, 60]) {
    const W = windowMin * MIN, g = rereadGapMs({ windowMs: W }), I = everyMin * MIN;
    ok(g + W / HEADROOM <= W - (W - W / HEADROOM) / 2 + 1, `window ${windowMin}: gap + cycle leaves half the slack`);
    if (everyMin * 6 > windowMin) continue; // fewer than 6 runs a window
    ok(g >= I, `window ${windowMin}, every ${everyMin}: the gap (${g / MIN} min) is at least an interval: the next tick never re-reads`);
  }
});

Deno.test({ name: `the re-read gap: ${SCHEDULES} seeded schedules of overlapping, lost, stopped and handed-back lane runs (G1-G4)`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const failures: string[] = [];
  let reads = 0, overlapped = 0, beyond = 0;
  for (const s of ALL) {
    try {
      const W = s.windowMin * MIN, slack = 21 * 1000, gap = rereadGapMs({ windowMs: W });
      const x = await simulate(s, gap);
      check(s, x, gap);
      // G2: within the window; past it only where the rule before the gap was past it too, and never later than it.
      const worst = worstWait(s, x);
      if (worst.ms > W + slack) {
        const base = worstWait(s, await simulate(s, 0));
        ok(base.ms > W && worst.ms <= base.ms + slack, `${s.id} ${worst.key}: ${worst.ms / MIN} min without a read (${s.kind}; window ${s.windowMin} every ${s.everyMin}, ${s.boards} boards, ${s.lanes} lanes; with no gap ${base.ms / MIN} min)`);
        beyond++;
      }
      for (const rs of x.reads.values()) reads += rs.length;
      if (s.overlap > 0) overlapped++;
    } catch (e) { failures.push((e as Error).message); }
  }
  if (failures.length) throw new Error(`${failures.length} of ${SCHEDULES} schedules failed:\n${failures.slice(0, 10).join("\n")}`);
  console.log(`re-read gap: ${SCHEDULES} schedules (${overlapped} with overlapping runs), ${reads} board reads, none within the gap; ${beyond} past the window, each as late with no gap`);
  ok(overlapped > SCHEDULES / 2, "most schedules overlap runs");
  ok(beyond < SCHEDULES / 20, `${beyond} schedules past the window: the battery's losses are meant to stay mostly inside the headroom`);
} });

Deno.test({ name: "the re-read gap bites: with no gap (the rule before 2026-10-31) the same schedules read boards twice in one tick", sanitizeOps: false, sanitizeResources: false, async fn() {
  let twice = 0;
  for (const s of ALL.filter((x) => x.overlap > 0).slice(0, 200)) {
    const x = await simulate(s, 0);
    for (const rs of x.reads.values()) for (let i = 1; i < rs.length; i++) if (rs[i].at - rs[i - 1].at < s.everyMin * MIN) twice++;
  }
  ok(twice > 0, "the old rule never read a board twice in a tick: the battery would not catch the bug");
  console.log(`with no gap: ${twice} reads of a board within one tick of its last`);
} });

// The scheduled handler over a fake board network (memoryBoardState).
function handlerWorld(seed: number, n: number, everyMin: number) {
  const r = rng(seed);
  const net: Net = { calls: [], answer: new Map() }, db = pgLikeDb(), state = memoryBoardState(), runs = { rows: [] as any[] };
  const feed = boardFetchFeed(fakeFetch(net, r), { stream: true, bodyHash: true });
  const dir: Board[] = Array.from({ length: n }, (_, i) => { const p = r.pick(["greenhouse", "lever", "ashby"] as const); return { company: `Co ${i}`, provider: p, board: `h${seed}b${i}` }; });
  for (const b of dir) net.answer.set(boardKey(b), { kind: "list", jobs: Array.from({ length: r.int(1, 5) }, (_, k) => makeJob(r, k, b.provider)) });
  const run = async (at: number, windowMin: number) => {
    const req = new Request(`https://fn.test/?lane=0&lanes=1&window_min=${windowMin}`, { method: "POST", headers: { "x-trainee-ingest-secret": SECRET() } });
    const res = await handleIngest(req, handlerDeps({ boards: () => dir, db, state, feed, at: () => at, runs, env: { INGEST_EVERY_MIN: String(everyMin) } }) as any);
    ok(res.status === 200, `seed ${seed}: ${res.status} ${await res.clone().text()}`);
  };
  const reads = () => { const m = new Map<string, number>(); for (const c of net.calls) m.set(c.board, (m.get(c.board) ?? 0) + 1); net.calls.length = 0; return m; };
  return { r, run, reads, dir };
}

Deno.test({ name: "the re-read gap through the scheduled handler: the CI failure's order (two runs of a lane at one tick, the first finished before the second claims) reads each board once", sanitizeOps: false, sanitizeResources: false, async fn() {
  // As tests/architect/ingest-r2-pg.test.ts runs it: a 15-minute window, a run every 15 minutes (one run reads the lane).
  for (let seed = 1; seed <= 40; seed++) {
    const w = handlerWorld(7000 + seed, 1 + (seed % 6), 15);
    const at = T0 + seed * 86400000;
    await w.run(at, 15); await w.run(at + w.r.int(0, 3000), 15);
    const first = w.reads();
    ok(first.size === w.dir.length && [...first.values()].every((c) => c === 1), `seed ${seed}: each board read once at the tick: ${JSON.stringify([...first])}`);
    await w.run(at + 15 * MIN, 15);
    ok(w.reads().size === w.dir.length, `seed ${seed}: the next tick (15 min, past the gap of ${rereadGapMs({ windowMs: 15 * MIN }) / 1000} s) reads every board again`);
  }
} });

Deno.test({ name: "the re-read gap through the scheduled handler: the scheduled plan (60-min window, every 5 min), ticks doubled at random: no board read twice within the gap, every board within the window", sanitizeOps: false, sanitizeResources: false, async fn() {
  const gap = rereadGapMs({ windowMs: 60 * MIN });
  let doubled = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const w = handlerWorld(9000 + seed, w0(seed), 5);
    const last = new Map<string, number>(), base = T0 + seed * 86400000;
    for (let k = 0; k < 36; k++) {
      const t = base + k * 5 * MIN;
      const two = w.r.chance(0.4);
      if (two) doubled++;
      await w.run(t, 60);
      if (two) await w.run(t + w.r.int(0, 200) * 1000, 60);
      for (const [b, c] of w.reads()) {
        ok(c === 1, `seed ${seed} tick ${k}: ${b} read ${c} times in one tick`);
        const prev = last.get(b);
        ok(prev === undefined || t - prev >= gap, `seed ${seed} tick ${k}: ${b} read again ${(t - prev!) / MIN} min after (gap ${gap / MIN} min)`);
        last.set(b, t);
      }
      for (const b of w.dir) {
        const prev = last.get(boardKey(b));
        ok((prev ?? base) > t - 60 * MIN || k < 12, `seed ${seed} tick ${k}: ${boardKey(b)} not read within the window`);
      }
    }
  }
  ok(doubled > 100, "ticks with two runs");
} });
const w0 = (seed: number) => [1, 2, 3, 5, 8, 13, 21, 34][seed % 8];
