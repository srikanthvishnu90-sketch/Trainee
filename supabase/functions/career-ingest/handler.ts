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
// 2026-10-30 (production: ~20% of lane runs stopped by the platform's memory / CPU limits, three lanes stuck for hours on
// the same boards, and no log row for any of them): the run's log row is written when it starts and completed when it
// ends (failed runs carry their error); the run claims its boards before reading (a stopped run no longer pins its
// lane); outcomes are recorded 20 at a time; a board larger than the posting budget is read in parts over several runs.
import { equalSecret } from "../_shared/message_service.ts";
import { ingestBoards, type Board, type BoardOutcome, type FetchFeed, type IngestRunRow, type IngestStats, type PostingsDb } from "../_shared/career_ingest.ts";
import { boardKey, type BoardState, type BoardStateDb, bucketOf, capacityPer, claimable, goneReadsOf, laneBuckets, rereadGapMs } from "../_shared/career_shards.ts";
import { runReport } from "../_shared/career_ingest_lanes.mjs";

export interface IngestDeps {
  env: { get(k: string): string | undefined };
  boards: Board[];
  db: () => PostingsDb & { recordRun(stats: IngestStats, at: string): Promise<void>; recordLaneRun?(row: IngestRunRow): Promise<void>;
    startLaneRun?(row: { at: string; lane: number; lanes: number; window_min: number }): Promise<number | null>; finishLaneRun?(id: number, row: IngestRunRow): Promise<void> };
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
  const at = new Date(started).toISOString();
  const db = d.db();
  const q = new URL(req.url).searchParams;
  // 2026-10-30: what a failed run must still leave behind: its log row (started at the run's start, so a run the platform
  // stops shows too), and the boards it claimed but never reached handed back to the queue.
  let laneCtx: { at: string; lane: number; lanes: number; window_min: number } | null = null, runId: number | null = null, dueCount = 0, leftClosed = 0;
  let unclaim: (() => Promise<void>) | null = null;
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
      laneCtx = { at, lane, lanes, window_min: windowMin };
      if (db.startLaneRun) runId = await db.startLaneRun(laneCtx).catch(() => null);
      // WO-044: the lane's own share, not an even split. The 64 buckets are uneven (the heaviest of 4 lanes held 24% more
      // than a quarter in the WO-044/R1 simulation, enough to miss the 6 hours), so a lane takes enough for its own boards.
      const { byKey, buckets } = prep(d.boards);
      const laneList = laneBuckets(lane, lanes), mine = new Set(laneList);
      let laneBoards = 0;
      for (const b of buckets) if (mine.has(b)) laneBoards++;
      const cap = Math.min(int(d.env.get("INGEST_MAX_BOARDS"), 400, 1, 2000),
        Math.max(capacityPer({ boards: d.boards.length, windowMs, intervalMs, lanes }), capacityPer({ boards: laneBoards, windowMs, intervalMs, lanes: 1 })));
      // 2026-10-30 (round 2): seeded whenever the store's count is not the directory's (a board renamed in the directory
      // left the count equal, so the new name was never seeded and never read).
      if ((await st.count()) !== d.boards.length) await st.seed(d.boards);
      // 2026-10-30: the run claims its boards before reading any (attempted now, status "reading"). A run the platform stops
      // (memory, CPU) used to leave them oldest, so every later run of the lane took the same boards and was stopped the
      // same way; now they wait their turn, and one that stays "reading" names the board a stopped run was on.
      // Round 2: the claim is one step in the store (two runs of a lane used to both read the same due list and both
      // claim it), and a board in its failure backoff (career_shards.ts retryAfterMs) is not taken.
      // 2026-10-31: and a board attempted less than the re-read gap ago (half the headroom's slack: window / 6; career_shards.ts
      // rereadGapMs says why every board is still read within the window) is not taken: a read that had just finished was
      // due again at once, so an overlapping run, or the next tick, re-read every board of a small lane.
      const nowMs = Date.parse(at), gapMs = rereadGapMs({ windowMs });
      let claimed = st.claim ? await st.claim(laneList, cap, at, gapMs) : null;
      if (claimed === null) {
        claimed = (await st.due(laneList, cap * 2)).filter((s) => claimable(s, nowMs, gapMs)).slice(0, cap);
        await st.record(claimed.filter((s) => byKey.has(boardKey(s))).map((s) => ({ ...s, last_attempt_at: at, last_status: "reading" })));
      }
      // A board that left the directory (removed, or renamed): its open postings are no longer read, so they are closed,
      // and its row is forgotten (it used to be skipped, never recorded, and so taken first, and skipped, every run).
      const due = claimed.filter((s) => byKey.has(boardKey(s)));
      dueCount = due.length;
      const was = new Map(due.map((s) => [boardKey(s), s]));
      const done = new Set<string>();
      unclaim = async () => { const back = due.filter((s) => !done.has(boardKey(s))); if (back.length) await st.record(back); };
      const left = claimed.filter((s) => !byKey.has(boardKey(s)));
      for (const s of left) {
        const open = (await db.openForBoard({ company: s.board, provider: s.provider, board: s.board })).map((p) => p.job_id);
        if (open.length) { await db.close(open, at); leftClosed += open.length; }
      }
      if (left.length) {
        if (st.forget) await st.forget(left);
        else await st.record(left.map((s) => ({ ...s, last_attempt_at: at, last_status: "left the directory" })));
        await st.seed(d.boards); // a renamed board's new name is read from the next run
      }
      // Each board's outcome is recorded as the run goes, 20 at a time: what a stopped run finished is kept.
      const pending: BoardState[] = [];
      const flush = async () => { if (pending.length) await st.record(pending.splice(0)); };
      const rowOf = (s: BoardState, r: BoardOutcome): BoardState => {
        const ok = r.status !== "failed";
        return { ...s, last_attempt_at: at, last_ok_at: ok ? at : s.last_ok_at,
          // Round 2: a read that answered 404 / 410 says how many in a row ("[gone x2]"; the count the next read goes on from)
          // and, once the board is taken as gone, how many open postings that closed.
          last_status: r.status === "failed" ? `failed: ${String(r.error).slice(0, 120)}${r.gone_reads ? ` [gone x${r.gone_reads}]` : ""}${r.gone_closed ? `; ${r.gone_closed} open postings closed` : ""}`
            : r.status === "partial" && r.next_offset ? `partial: next part from ${r.next_offset}` : r.status,
          etag: r.status === "not_modified" ? s.etag : ok ? r.etag ?? null : s.etag, last_modified: r.status === "not_modified" ? s.last_modified : ok ? r.last_modified ?? null : s.last_modified,
          fail_count: ok ? 0 : s.fail_count + 1,
          // Feature 6: the body a full read answered (a partial read's body proves nothing: not kept).
          body_sha: r.status === "ok" ? r.body_sha ?? null : r.status === "not_modified" ? r.body_sha ?? s.body_sha ?? null : r.status === "partial" ? null : s.body_sha ?? null,
          // 2026-10-30: a board read in parts: where its next part starts; a failed read leaves the pass where it was.
          pass_offset: ok ? r.next_offset ?? 0 : s.pass_offset ?? 0,
          pass_started_at: ok ? (r.next_offset ? r.pass_started_at ?? at : null) : s.pass_started_at ?? null,
          // Round 2: a board taken as gone had its postings closed: the validators of its last full read no longer describe
          // the table, so they go (the same body coming back used to read as "not modified" and its postings stayed closed).
          ...(r.gone_closed !== undefined ? { etag: null, last_modified: null, body_sha: null } : {}) };
      };
      // Feature 6: the run's CPU bound, as postings parsed (?posting_budget= from the schedule, or INGEST_POSTING_BUDGET).
      const postingBudget = int(q.get("posting_budget"), int(d.env.get("INGEST_POSTING_BUDGET"), 0, 0, 1000000), 0, 1000000) || undefined;
      stats = await ingestBoards({ ...common, useCursor: false, maxBoards: due.length, postingBudget,
        boards: due.map((s) => ({ ...byKey.get(boardKey(s))!, etag: s.etag, last_modified: s.last_modified, body_sha: s.body_sha ?? null, offset: s.pass_offset ?? 0, pass_started_at: s.pass_started_at ?? null, gone_reads: goneReadsOf(s) })),
        onBoard: async (b, r) => { const k = boardKey(b); done.add(k); pending.push(rowOf(was.get(k)!, r)); if (pending.length >= 20) await flush(); } });
      if (leftClosed) { stats.closed += leftClosed; stats.boards_left_directory = left.length; }
      await flush();
      await unclaim(); // boards the run did not reach (the deadline, the posting budget) keep their place in the queue
      unclaim = null;
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
    await db.recordRun(result as IngestStats, at);
    if (laneRun && runId !== null && db.finishLaneRun) await db.finishLaneRun(runId, { ...laneRun, ms, report: report.text, status: "done" });
    else if (laneRun && db.recordLaneRun) await db.recordLaneRun({ ...laneRun, ms, report: report.text });
    return json(result);
  } catch (e) {
    // A storage failure is reported, never a partial success; the cursor and postings stay as the last good write left them.
    // 2026-10-30: and it is recorded: the lane's log row says the run failed and why (a failed run used to leave no row).
    const detail = e instanceof Error ? e.message : String(e);
    console.error("career-ingest failed:", detail);
    try { if (unclaim) await unclaim(); } catch { /* the claim stands: those boards wait one turn */ }
    try {
      const ms = Math.max(0, d.now() - started);
      if (laneCtx) {
        const row: IngestRunRow = { ...laneCtx, ms, boards_due: dueCount, boards_read: 0, boards_ok: 0, boards_failed: 0, boards_not_modified: 0,
          postings_new: 0, postings_seen: 0, postings_reopened: 0, postings_closed: 0, url_rejected: 0,
          lane_fresh: null, lane_total: null, directory_fresh: null, directory_total: null, failures: [],
          report: `lane ${laneCtx.lane} of ${laneCtx.lanes}: run failed: ${detail}`.slice(0, 2000), status: "failed", error: detail.slice(0, 1000) };
        if (runId !== null && db.finishLaneRun) await db.finishLaneRun(runId, row);
        else if (db.recordLaneRun) await db.recordLaneRun(row);
      } else {
        await db.recordRun({ boards_ok: 0, boards_failed: 0, boards_partial: 0, new: 0, seen: 0, reopened: 0, closed: 0, failures: [], large_closes: [], error: detail.slice(0, 1000) } as IngestStats, at);
      }
    } catch (e2) {
      console.error("career-ingest: the failed run could not be recorded:", e2 instanceof Error ? e2.message : e2);
    }
    return json({ error: "ingest failed", detail }, 500);
  }
}
