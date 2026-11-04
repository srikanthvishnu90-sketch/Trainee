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
}
export interface BoardStateDb {
  count(): Promise<number>;
  seed(boards: Board[]): Promise<void>; // adds a row for every board not yet known; never changes a known one
  due(buckets: number[], limit: number): Promise<BoardState[]>; // never-read first, then oldest attempt first
  record(rows: BoardState[]): Promise<void>;
  // Feature 6: coverage. Of the boards in `buckets` (all boards when null), how many were read successfully at or after
  // `sinceIso`. Optional: a store without it reports no coverage.
  fresh?(buckets: number[] | null, sinceIso: string): Promise<{ fresh: number; total: number }>;
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
  return Math.max(1, Math.ceil((o.boards / runs / Math.max(1, o.lanes ?? 1)) * (o.headroom ?? 1.5)));
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
    async fresh(buckets, sinceIso) {
      const mine = buckets ? new Set(buckets) : null, since = Date.parse(sinceIso);
      let total = 0, fresh = 0;
      for (const s of rows.values()) { if (mine && !mine.has(s.bucket)) continue; total++; if (s.last_ok_at && Date.parse(s.last_ok_at) >= since) fresh++; }
      return { fresh, total };
    },
  };
}

const COLS = "provider,board,bucket,last_attempt_at,last_ok_at,last_status,etag,last_modified,fail_count,body_sha";
// deno-lint-ignore no-explicit-any
export function supabaseBoardState(admin: any): BoardStateDb {
  const T = "career_board_state";
  const must = <X>(r: { data: X | null; error: { message: string } | null }, what: string): X => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as X; };
  return {
    async count() { const r = await admin.from(T).select("provider", { count: "exact", head: true }); if (r.error) throw new Error(`count board state: ${r.error.message}`); return r.count ?? 0; },
    async seed(boards) {
      for (let i = 0; i < boards.length; i += 1000) {
        const chunk = boards.slice(i, i + 1000).map((b) => ({ provider: b.provider, board: b.board, bucket: bucketOf(b) }));
        must(await admin.from(T).upsert(chunk, { onConflict: "provider,board", ignoreDuplicates: true }), "seed board state");
      }
    },
    async due(buckets, limit) {
      return must<BoardState[]>(await admin.from(T).select(COLS).in("bucket", buckets).order("last_attempt_at", { ascending: true, nullsFirst: true })
        .order("provider").order("board").limit(limit), "read due boards") || [];
    },
    async record(list) {
      for (let i = 0; i < list.length; i += 500) {
        must(await admin.from(T).upsert(list.slice(i, i + 500).map((s) => ({ ...s, updated_at: new Date().toISOString() })), { onConflict: "provider,board" }), "record board state");
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
