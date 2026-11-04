// The scheduled ingest run (WO-006), as a function of its inputs so it is testable without a network or a database.
// pg_cron calls it every 5 minutes (scripts/launch/schedule-career-ingest.sql, run by the owner) with the shared secret.
// Each run reads the next INGEST_MAX_BOARDS boards of the directory (default 100, so each of ~2,200 boards is read about every
// 2 hours), INGEST_CONCURRENCY at a time (default 8), starts no board after 100 s so the run ends inside the function's
// time limit, rewrites an unchanged posting's last_seen_at at most every 6 hours, and records its stats in
// career_ingest_state so a silent stop is visible.
// WO-037, sharded (when `state` is given, as the deployed function does): each run reads the boards of its lane
// (?lane=k of INGEST_LANES, one scheduled call per lane per tick) that have waited longest, never-read first, up to the
// capacity that reads every board within INGEST_WINDOW_HOURS (default 6) at the INGEST_EVERY_MIN cadence (default 5),
// sends each board's last ETag / Last-Modified, and records every attempt in career_board_state.
// Feature 6 (hourly at scale): the schedule names its lanes and window in the URL (?lane=k&lanes=N&window_min=60; the
// query wins over INGEST_LANES / INGEST_WINDOW_MIN / INGEST_WINDOW_HOURS), so one SQL file holds the whole plan. Every run
// returns and records a report with coverage fractions (career_ingest_runs): boards read of those due, failures by
// reason, postings new/seen/closed, links refused by the URL-shape guard, and how many boards of the lane and of the
// directory were read within the window. ?posting_budget=P stops starting boards once P postings were parsed (CPU).
import { equalSecret } from "../_shared/message_service.ts";
import { ingestBoards, type Board, type BoardOutcome, type FetchFeed, type IngestRunRow, type IngestStats, type PostingsDb } from "../_shared/career_ingest.ts";
import { boardKey, type BoardState, type BoardStateDb, bucketOf, capacityPer, laneBuckets } from "../_shared/career_shards.ts";
import { runReport } from "../_shared/career_ingest_lanes.mjs";

export interface IngestDeps {
  env: { get(k: string): string | undefined };
  boards: Board[];
  db: () => PostingsDb & { recordRun(stats: IngestStats, at: string): Promise<void>; recordLaneRun?(row: IngestRunRow): Promise<void> };
  fetchFeed: (userAgent: string) => FetchFeed;
  now: () => number;
  state?: () => BoardStateDb; // WO-037: present -> sharded scheduling; absent -> the rotating cursor
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const int = (v: string | null | undefined, d: number, lo: number, hi: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && v ? Math.max(lo, Math.min(hi, n)) : d; };

// The directory's keys and buckets, computed once per warm instance (27,000+ boards: a few ms each run otherwise).
const prepared = new WeakMap<Board[], { byKey: Map<string, Board>; buckets: Uint8Array }>();
function prep(boards: Board[]) {
  let p = prepared.get(boards);
  if (!p) { p = { byKey: new Map(boards.map((b) => [boardKey(b), b])), buckets: Uint8Array.from(boards, (b) => bucketOf(b)) }; prepared.set(boards, p); }
  return p;
}

export async function handleIngest(req: Request, d: IngestDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("CAREER_INGEST_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: CAREER_INGEST_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-ingest-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  const contact = d.env.get("INGEST_CONTACT_EMAIL") || "";
  if (!contact) return json({ error: "not configured: INGEST_CONTACT_EMAIL is not set (boards are told who is reading them)" }, 503);
  const started = d.now();
  const db = d.db();
  const q = new URL(req.url).searchParams;
  try {
    const common = { db, now: started, fetchFeed: d.fetchFeed(`Trainee job alerts (contact: ${contact})`),
      concurrency: int(d.env.get("INGEST_CONCURRENCY"), 8, 1, 16), deadline: started + 100000, clock: d.now, touchAfterMs: 6 * 3600000 };
    let shard: Record<string, number> | null = null, stats: IngestStats & { attempted: number };
    let report: ReturnType<typeof runReport>, laneRun: Omit<IngestRunRow, "ms" | "report"> | null = null;
    if (d.state) {
      const st = d.state();
      const lanes = int(q.get("lanes"), int(d.env.get("INGEST_LANES"), 1, 1, 64), 1, 64), lane = Math.min(lanes - 1, int(q.get("lane"), 0, 0, 63));
      const intervalMs = int(d.env.get("INGEST_EVERY_MIN"), 5, 1, 60) * 60000;
      const windowMin = int(q.get("window_min"), int(d.env.get("INGEST_WINDOW_MIN"), int(d.env.get("INGEST_WINDOW_HOURS"), 6, 1, 48) * 60, 15, 2880), 15, 2880);
      const windowMs = windowMin * 60000;
      // WO-044: the lane's own share, not an even split. The 64 buckets are uneven (the heaviest of 4 lanes held 24% more
      // than a quarter in the WO-044/R1 simulation, enough to miss the 6 hours), so a lane takes enough for its own boards.
      const { byKey, buckets } = prep(d.boards);
      const laneList = laneBuckets(lane, lanes), mine = new Set(laneList);
      let laneBoards = 0;
      for (const b of buckets) if (mine.has(b)) laneBoards++;
      const cap = Math.min(int(d.env.get("INGEST_MAX_BOARDS"), 400, 1, 2000),
        Math.max(capacityPer({ boards: d.boards.length, windowMs, intervalMs, lanes }), capacityPer({ boards: laneBoards, windowMs, intervalMs, lanes: 1 })));
      if ((await st.count()) < d.boards.length) await st.seed(d.boards);
      const due = (await st.due(laneList, cap)).filter((s) => byKey.has(boardKey(s))); // a board left the directory: skip it
      const was = new Map(due.map((s) => [boardKey(s), s]));
      const outcomes = new Map<string, BoardOutcome>();
      // Feature 6: the run's CPU bound, as postings parsed (?posting_budget= from the schedule, or INGEST_POSTING_BUDGET).
      const postingBudget = int(q.get("posting_budget"), int(d.env.get("INGEST_POSTING_BUDGET"), 0, 0, 1000000), 0, 1000000) || undefined;
      stats = await ingestBoards({ ...common, useCursor: false, maxBoards: due.length, postingBudget,
        boards: due.map((s) => ({ ...byKey.get(boardKey(s))!, etag: s.etag, last_modified: s.last_modified, body_sha: s.body_sha ?? null })),
        onBoard: (b, r) => outcomes.set(boardKey(b), r) });
      const at = new Date(started).toISOString();
      const rows: BoardState[] = [...outcomes].map(([k, r]) => {
        const s = was.get(k)!, ok = r.status !== "failed";
        return { ...s, last_attempt_at: at, last_ok_at: ok ? at : s.last_ok_at, last_status: r.status === "failed" ? `failed: ${String(r.error).slice(0, 120)}` : r.status,
          etag: r.status === "not_modified" ? s.etag : ok ? r.etag ?? null : s.etag, last_modified: r.status === "not_modified" ? s.last_modified : ok ? r.last_modified ?? null : s.last_modified,
          fail_count: ok ? 0 : s.fail_count + 1,
          // Feature 6: the body a full read answered (a partial read's body proves nothing: not kept).
          body_sha: r.status === "ok" ? r.body_sha ?? null : r.status === "not_modified" ? r.body_sha ?? s.body_sha ?? null : r.status === "partial" ? null : s.body_sha ?? null };
      });
      await st.record(rows);
      shard = { lane, lanes, capacity: cap, due: due.length, window_min: windowMin, ...(postingBudget ? { posting_budget: postingBudget } : {}) };
      // Coverage after this run's writes. A store that cannot count reports none (never a guess).
      const since = new Date(started - windowMs).toISOString();
      type Cov = { fresh: number; total: number };
      const coverage: { lane?: Cov; directory?: Cov } = st.fresh ? { lane: await st.fresh(laneList, since), directory: await st.fresh(null, since) } : {};
      report = runReport({ lane, lanes, due: due.length, stats, coverage, windowMin });
      laneRun = { at, lane, lanes, window_min: windowMin, boards_due: due.length, boards_read: stats.attempted, boards_ok: stats.boards_ok,
        boards_failed: stats.boards_failed, boards_not_modified: stats.boards_not_modified ?? 0, postings_new: stats.new, postings_seen: stats.seen,
        postings_reopened: stats.reopened, postings_closed: stats.closed, url_rejected: stats.url_rejected ?? 0,
        lane_fresh: coverage.lane?.fresh ?? null, lane_total: coverage.lane?.total ?? null,
        directory_fresh: coverage.directory?.fresh ?? null, directory_total: coverage.directory?.total ?? null, failures: stats.failures };
    } else {
      stats = await ingestBoards({ ...common, boards: d.boards, maxBoards: int(d.env.get("INGEST_MAX_BOARDS"), 100, 1, 400) });
      report = runReport({ due: stats.attempted, stats });
    }
    const ms = d.now() - started;
    const result = { ...stats, directory: d.boards.length, ...(shard ? { shard } : {}), report, ms };
    await db.recordRun(result as IngestStats, new Date(started).toISOString());
    if (laneRun && db.recordLaneRun) await db.recordLaneRun({ ...laneRun, ms, report: report.text });
    return json(result);
  } catch (e) {
    // A storage failure is reported, never a partial success; the cursor and postings stay as the last good write left them.
    console.error("career-ingest failed:", e instanceof Error ? e.message : e);
    return json({ error: "ingest failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}
