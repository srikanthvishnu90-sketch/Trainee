// WO-037: the 6-hour refresh at scale. Every board in the directory is read at least once every 6 hours, however many
// boards there are, by sharded, oldest-first scheduling:
//   bucketOf     a board's fixed bucket (0..63, FNV-1a of provider:board). A lane (one scheduled invocation per tick)
//                owns the buckets b with b % lanes == lane, so parallel invocations never read the same board.
//   capacityPer  how many boards one run of one lane must take so its share is read within the window, with headroom
//                for runs that fail or stop at their deadline: ceil(N / runsPerWindow / lanes * headroom).
//   pickDue      the run's boards: never-read first, then the longest since the last attempt, up to capacity.
//   sizeIngest   the arithmetic for N boards against the Edge Function limits (requests/hour, wall clock, CPU).
// Each board's read state (last attempt, last success, its ETag / Last-Modified for a conditional request) lives in
// career_board_state (supabase/migrations/20261021110000_career_board_state.sql); memoryBoardState is the same in memory.
import type { Board } from "./career_ingest.ts";

export const BUCKETS = 64;
export const WINDOW_MS = 6 * 3600000;
export interface BoardState {
  provider: string; board: string; bucket: number;
  last_attempt_at: string | null; last_ok_at: string | null; last_status: string | null;
  etag: string | null; last_modified: string | null; fail_count: number;
  body_sha?: string | null; // Feature 6: the SHA-256 of the last full read's body (20261026060106_career_ingest_runs.sql)
  // 2026-10-30 (20261030030000_career_ingest_bounded.sql): a board read in parts over several runs: where the next part
  // starts (0: from the top) and when the pass began.
  pass_offset?: number; pass_started_at?: string | null;
}
export interface BoardStateDb {
  count(): Promise<number>;
  seed(boards: Board[]): Promise<void>; // adds a row for every board not yet known; never changes a known one
  due(buckets: number[], limit: number): Promise<BoardState[]>; // never-read first, then oldest attempt first
  record(rows: BoardState[]): Promise<void>;
  // Feature 6: coverage. Of the boards in `buckets` (all boards when null), how many were read successfully at or after
  // `sinceIso`. Optional: a store without it reports no coverage.
  fresh?(buckets: number[] | null, sinceIso: string): Promise<{ fresh: number; total: number }>;
  // 2026-10-30 (ingest round 2): the run's boards taken in one step: the due boards (never-read first, then oldest
  // attempt, those in their failure backoff left out) marked attempted at `atIso` ("reading") and returned as they were
  // before, so two runs of one lane never read the same board (due() then record() let both take the same list).
  // null: the store cannot (the migration not applied); the caller then takes due() and records its claim.
  // 2026-10-31 (20261030150000_career_ingest_reread_gap.sql): a board attempted less than `gapMs` before `atIso` (finished
  // or not) is not taken (claimable below); omitted: DEFAULT_REREAD_GAP_MS, as the 3-argument SQL form.
  claim?(buckets: number[], limit: number, atIso: string, gapMs?: number): Promise<BoardState[] | null>;
  // Boards no longer in the directory: their rows removed (a row left behind kept its lane's oldest place for ever and
  // its count hid a renamed board from the seed).
  forget?(rows: { provider: string; board: string }[]): Promise<void>;
}

// 2026-10-30 (ingest round 2): a board that keeps failing is read less often, never every window for ever (production:
// boards at "HTTP 404" read every hour for days, fail_count 69; boards at "HTTP 429" asked again every hour). After
// RETRY_FREE_FAILS failures in a row it waits retryAfterMs(fail_count) after its last attempt: 1 h, 2 h, 4 h, 8 h, 16 h,
// then once a day. The same arithmetic is in career_board_state_claim (20261030110000_career_ingest_r2.sql).
export const RETRY_FREE_FAILS = 2;
export const RETRY_MAX_MS = 24 * 3600000;
export function retryAfterMs(failCount: number): number {
  const f = Math.floor(Number(failCount) || 0);
  return f < RETRY_FREE_FAILS ? 0 : Math.min(RETRY_MAX_MS, 2 ** Math.min(30, f - RETRY_FREE_FAILS) * 3600000);
}
// Fewer than RETRY_FREE_FAILS failures: no backoff, even when the last attempt is ahead of this run's clock (as the SQL's
// "fail_count < 2"; found by tests/architect/ingest-reread-gap-pg.test.ts; the re-read gap holds such a board back).
export const backedOff = (s: Pick<BoardState, "fail_count" | "last_attempt_at">, nowMs: number) => {
  const wait = retryAfterMs(s.fail_count);
  return wait > 0 && !!s.last_attempt_at && nowMs - Date.parse(s.last_attempt_at) < wait;
};
// A board another run claimed less than IN_FLIGHT_MS ago and has not finished ("reading") is being read now: no claim takes
// it (a lane smaller than a run's capacity used to be read whole by both of two overlapping runs). A run lasts at most the
// function's 150 s; a claim older than this belongs to a run that was stopped, and the board is due again.
export const IN_FLIGHT_MS = 5 * 60000;
export const inFlight = (s: Pick<BoardState, "last_status" | "last_attempt_at">, nowMs: number) =>
  s.last_status === "reading" && !!s.last_attempt_at && nowMs - Date.parse(s.last_attempt_at) < IN_FLIGHT_MS;
// 2026-10-31: the re-read gap. A board attempted less than the gap ago, its read finished or not, is not claimed. Before,
// only a board still "reading" was skipped: a read that had just finished (ok, or fewer than 2 failures) was due again at
// once, so in a lane smaller than a run's capacity an overlapping run, or the next tick, read every board the last run had
// just read (CI run 41146111368: "lever:s45b0: read 2 times in one tick"): twice the requests, and more HTTP 429s.
// The gap is half the slack the headroom leaves: (window - window / headroom) / 2, i.e. window / 6 at headroom 1.5:
// 1 h for the 6-hour default, 10 min for the scheduled plan (scripts/launch/schedule-career-ingest.sql: window_min=60,
// every 5 min). Why every board is still read within the window:
//   - capacityPer gives a lane run headroom x its share, so a lane reads all its boards in at most window / headroom
//     (the cycle: 40 min of a 60-min window); the rest of the window (the slack, 20 min) is for runs that are lost.
//   - The gap holds a board back at most the gap; once due it waits behind at most the lane's other boards, one cycle:
//     gap + cycle = window - slack / 2. Half the slack is left: a lane that loses one run in five still reads every
//     board inside the window (cycle / (4/5) + gap = 50 + 10 min of 60).
//   - Boards the gap holds back together (a lane its runs, overlapping ones included, read whole inside the gap) are
//     at most 2 x capacity x gap / interval; they are read in 2 x gap (3 x gap losing a third of the runs) once due:
//     a wait of 4 x gap = 2/3 of the window at most.
//   - gap >= interval when a window holds 6 runs or more (the plan: 12; the default: 72): the next tick never re-reads
//     what the last one read.
// A fixed 1 h would be the plan's whole 60-minute window: every board read late, every time.
// The same rule is in career_board_state_claim (20261030150000_career_ingest_reread_gap.sql), whose 3-argument form uses
// DEFAULT_REREAD_GAP_MS; tests/architect/ingest-reread-gap-pg.test.ts holds the two to the same answers, and
// tests/architect/scenarios-ingest-reread-gap.test.ts the schedules to the window.
export const HEADROOM = 1.5;
export function rereadGapMs(o: { windowMs?: number; headroom?: number }): number {
  const w = o.windowMs ?? WINDOW_MS, h = Math.max(1, o.headroom ?? HEADROOM);
  return Math.max(0, Math.floor((w - w / h) / 2));
}
export const DEFAULT_REREAD_GAP_MS = rereadGapMs({ windowMs: 60 * 60000 }); // 10 min: the scheduled plan's window (60 min)
export const tooSoon = (s: Pick<BoardState, "last_attempt_at">, nowMs: number, gapMs: number) =>
  gapMs > 0 && !!s.last_attempt_at && nowMs - Date.parse(s.last_attempt_at) < gapMs;
// What a claim may take: not in its failure backoff, not being read by another run, not attempted inside the gap.
export const claimable = (s: Pick<BoardState, "fail_count" | "last_attempt_at" | "last_status">, nowMs: number, gapMs: number) =>
  !backedOff(s, nowMs) && !inFlight(s, nowMs) && !tooSoon(s, nowMs, gapMs);
// How many reads in a row before this one answered 404 / 410, from the board's last status ("failed: HTTP 404 [gone x2]";
// a status written before the tag existed counts its failures).
export function goneReadsOf(s: Pick<BoardState, "last_status" | "fail_count">): number {
  const st = String(s.last_status ?? "");
  const m = /\[gone x(\d+)\]/.exec(st);
  if (m) return Number(m[1]);
  return /^failed: HTTP (404|410)$/.test(st) ? Math.max(1, s.fail_count || 0) : 0;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const boardKey = (b: { provider: string; board: string }) => `${b.provider}:${b.board.toLowerCase()}`;
export const bucketOf = (b: { provider: string; board: string }) => fnv1a(boardKey(b)) % BUCKETS;
export function laneBuckets(lane: number, lanes: number): number[] {
  const L = Math.max(1, Math.min(BUCKETS, Math.floor(lanes))), l = ((Math.floor(lane) % L) + L) % L;
  return Array.from({ length: BUCKETS }, (_, b) => b).filter((b) => b % L === l);
}
// Boards one lane's run must take. runsPerWindow = window / interval (6 h / 5 min = 72). Headroom 1.5 means a lane can
// lose a third of its runs (failed, cut by the deadline) and still read everything inside the window.
export function capacityPer(o: { boards: number; windowMs?: number; intervalMs: number; lanes?: number; headroom?: number }): number {
  const runs = Math.max(1, Math.floor((o.windowMs ?? WINDOW_MS) / o.intervalMs));
  return Math.max(1, Math.ceil((o.boards / runs / Math.max(1, o.lanes ?? 1)) * (o.headroom ?? HEADROOM)));
}
const t = (s: string | null) => (s ? Date.parse(s) : -Infinity);
export function pickDue(states: BoardState[], buckets: number[], limit: number): BoardState[] {
  const mine = new Set(buckets);
  return states.filter((s) => mine.has(s.bucket)).map((s) => ({ s, at: t(s.last_attempt_at), k: s.provider + ":" + s.board }))
    .sort((a, b) => a.at - b.at || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .slice(0, Math.max(0, limit)).map((x) => x.s);
}
export function freshState(b: Board): BoardState {
  return { provider: b.provider, board: b.board, bucket: bucketOf(b), last_attempt_at: null, last_ok_at: null, last_status: null, etag: null, last_modified: null, fail_count: 0, body_sha: null };
}

// ------------------------------------------------------------------------------------------------ sizing
// Inputs marked by the caller as measured or assumed; the output is arithmetic only.
export interface SizeIn {
  boards: number; windowMs?: number; intervalMs: number; lanes: number; concurrency: number;
  avgLatencyMs: number; cpuMsPerBoard: number; requestsPerBoard?: number; notModifiedShare?: number; cpuMsNotModified?: number;
  wallLimitS: number; cpuLimitMs: number; deadlineS: number;
}
export function sizeIngest(s: SizeIn) {
  const window = s.windowMs ?? WINDOW_MS;
  const perRun = capacityPer({ boards: s.boards, windowMs: window, intervalMs: s.intervalMs, lanes: s.lanes });
  const steady = Math.ceil(s.boards / (window / s.intervalMs) / s.lanes); // boards a lane reads per run once caught up
  const reqPerBoard = s.requestsPerBoard ?? 1;
  const requestsPerHour = Math.round((s.boards / (window / 3600000)) * reqPerBoard);
  const share = s.notModifiedShare ?? 0;
  const cpuPerBoard = share * (s.cpuMsNotModified ?? 0.2) + (1 - share) * s.cpuMsPerBoard;
  const wallS = (perRun * reqPerBoard * s.avgLatencyMs) / s.concurrency / 1000;
  const cpuMs = perRun * cpuPerBoard;
  return {
    boards_per_lane_run_capacity: perRun, boards_per_lane_run_steady: steady, runs_per_window: Math.floor(window / s.intervalMs),
    requests_per_hour: requestsPerHour, requests_per_second: +(requestsPerHour / 3600).toFixed(2),
    wall_s_per_run_at_capacity: +wallS.toFixed(1), cpu_ms_per_run_at_capacity: Math.round(cpuMs),
    fits_wall: wallS <= Math.min(s.deadlineS, s.wallLimitS), fits_cpu: cpuMs <= s.cpuLimitMs,
  };
}
// The fewest lanes (parallel invocations per tick) at which one run fits both limits.
export function lanesNeeded(s: Omit<SizeIn, "lanes">, maxLanes = BUCKETS): number | null {
  for (let l = 1; l <= maxLanes; l++) { const r = sizeIngest({ ...s, lanes: l }); if (r.fits_wall && r.fits_cpu) return l; }
  return null;
}

// ------------------------------------------------------------------------------------------------ stores
export function memoryBoardState(): BoardStateDb & { rows: Map<string, BoardState> } {
  const rows = new Map<string, BoardState>();
  return {
    rows,
    async count() { return rows.size; },
    async seed(boards) { for (const b of boards) if (!rows.has(boardKey(b))) rows.set(boardKey(b), freshState(b)); },
    async due(buckets, limit) { return pickDue([...rows.values()], buckets, limit).map((s) => ({ ...s })); },
    async record(list) { for (const s of list) rows.set(boardKey(s), { ...s }); },
    // One synchronous step (no await between the pick and the mark): two runs never take the same board.
    async claim(buckets, limit, atIso, gapMs = DEFAULT_REREAD_GAP_MS) {
      const now = Date.parse(atIso);
      const got = pickDue([...rows.values()].filter((s) => claimable(s, now, gapMs)), buckets, limit).map((s) => ({ ...s }));
      for (const s of got) rows.set(boardKey(s), { ...s, last_attempt_at: atIso, last_status: "reading" });
      return got;
    },
    async forget(list) { for (const s of list) rows.delete(boardKey(s)); },
    async fresh(buckets, sinceIso) {
      const mine = buckets ? new Set(buckets) : null, since = Date.parse(sinceIso);
      let total = 0, fresh = 0;
      for (const s of rows.values()) { if (mine && !mine.has(s.bucket)) continue; total++; if (s.last_ok_at && Date.parse(s.last_ok_at) >= since) fresh++; }
      return { fresh, total };
    },
  };
}

const COLS = "provider,board,bucket,last_attempt_at,last_ok_at,last_status,etag,last_modified,fail_count,body_sha";
const PASS_COLS = ",pass_offset,pass_started_at";
// deno-lint-ignore no-explicit-any
export function supabaseBoardState(admin: any): BoardStateDb {
  const T = "career_board_state";
  const must = <X>(r: { data: X | null; error: { message: string } | null }, what: string): X => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as X; };
  // Before 20261030030000 the table has no pass columns: read and write without them (a board is then read from the top).
  // claimRpc: the claim function exists; gapArg: its 4-argument form (20261030150000) does. Before that migration the
  // 3-argument form is called: no gap, but still one statement, so two runs at once never share a board.
  let pass = true, claimRpc = true, gapArg = true;
  const strip = (s: BoardState) => { if (pass) return s; const { pass_offset: _o, pass_started_at: _p, ...rest } = s; return rest; };
  return {
    async count() { const r = await admin.from(T).select("provider", { count: "exact", head: true }); if (r.error) throw new Error(`count board state: ${r.error.message}`); return r.count ?? 0; },
    async seed(boards) {
      for (let i = 0; i < boards.length; i += 1000) {
        const chunk = boards.slice(i, i + 1000).map((b) => ({ provider: b.provider, board: b.board, bucket: bucketOf(b) }));
        must(await admin.from(T).upsert(chunk, { onConflict: "provider,board", ignoreDuplicates: true }), "seed board state");
      }
    },
    async due(buckets, limit) {
      const q = () => admin.from(T).select(COLS + (pass ? PASS_COLS : "")).in("bucket", buckets).order("last_attempt_at", { ascending: true, nullsFirst: true })
        .order("provider").order("board").limit(limit);
      let r = await q();
      if (r.error && pass && /pass_offset|pass_started_at/.test(r.error.message)) { pass = false; r = await q(); }
      return must<BoardState[]>(r, "read due boards") || [];
    },
    async claim(buckets, limit, atIso, gapMs = DEFAULT_REREAD_GAP_MS) {
      if (!claimRpc) return null;
      const missing = (e: { message: string } | null) => !!e && /could not find the function|PGRST202|no function |function .* does not exist/i.test(e.message);
      let r = gapArg ? await admin.rpc("career_board_state_claim", { p_buckets: buckets, p_limit: limit, p_now: atIso, p_reread_gap_ms: Math.max(0, Math.floor(gapMs)) }) : null;
      if (!r || missing(r.error)) { gapArg = false; r = await admin.rpc("career_board_state_claim", { p_buckets: buckets, p_limit: limit, p_now: atIso }); }
      if (missing(r.error)) { claimRpc = false; return null; }
      return must<BoardState[]>(r, "claim due boards") || [];
    },
    async forget(list) {
      for (const s of list) must(await admin.from(T).delete().eq("provider", s.provider).eq("board", s.board), "forget board state");
    },
    async record(list) {
      for (let i = 0; i < list.length; i += 500) {
        must(await admin.from(T).upsert(list.slice(i, i + 500).map((s) => ({ ...strip(s), updated_at: new Date().toISOString() })), { onConflict: "provider,board" }), "record board state");
      }
    },
    // Two head-only counts (no rows come back): the index on (bucket, last_attempt_at) serves the bucket filter.
    async fresh(buckets, sinceIso) {
      const q = () => { const b = admin.from(T).select("provider", { count: "exact", head: true }); return buckets ? b.in("bucket", buckets) : b; };
      const all = await q(), ok = await q().gte("last_ok_at", sinceIso);
      if (all.error) throw new Error(`count board state: ${all.error.message}`);
      if (ok.error) throw new Error(`count fresh boards: ${ok.error.message}`);
      return { fresh: ok.count ?? 0, total: all.count ?? 0 };
    },
  };
}
