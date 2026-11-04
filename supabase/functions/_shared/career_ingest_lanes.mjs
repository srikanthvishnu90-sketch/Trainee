// Feature 6 (2026-10-25): the hourly job index, sized and accounted for. Plain JavaScript so the ingest function (Deno),
// the sizing script and the Node tests read the same arithmetic.
//   bucketOf / laneOf    a board's fixed bucket (0..63, FNV-1a of provider:board, the same as career_shards.ts) and lane
//   laneLoads            how many boards each of N lanes holds (the 64 buckets do not split evenly)
//   planLanes            the fewest lanes at which every board is read within the freshness window (default 60 min) and
//                        one lane's run fits the Edge Function's CPU and wall-clock limits, from a MEASURED cost per board
//   simulateFreshness    oldest-first reads over simulated hours, with runs lost and cut short: the oldest read it saw
//   coverageOf           boards read successfully within the window, of all boards (or of one lane's)
//   runReport            one run's record: "boards read 118/120 due; ... failed 2 (HTTP 404 x2)"; coverage fractions
// Nothing here reads the network or a database.

export const BUCKETS = 64;

export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const boardKey = (b) => `${b.provider}:${String(b.board).toLowerCase()}`;
export const bucketOf = (b) => fnv1a(boardKey(b)) % BUCKETS;
const clampLanes = (lanes) => Math.max(1, Math.min(BUCKETS, Math.floor(Number(lanes) || 1)));
export const laneOf = (b, lanes) => bucketOf(b) % clampLanes(lanes);

// Boards per bucket, then per lane (a lane owns the buckets b with b % lanes == lane).
export function bucketCounts(boards) {
  const c = new Array(BUCKETS).fill(0);
  for (const b of boards) c[bucketOf(b)]++;
  return c;
}
export function laneLoads(counts, lanes) {
  const L = clampLanes(lanes), out = new Array(L).fill(0);
  counts.forEach((n, b) => { out[b % L] += n; });
  return out;
}

// The run capacity of a lane holding `laneBoards` boards: runsPerWindow = window / interval; headroom 1.5 lets a lane lose
// a third of its runs (failed, cut at the deadline) and still read everything within the window.
export function laneCapacity(laneBoards, windowMin, intervalMin, headroom = 1.5) {
  const runs = Math.max(1, Math.floor(windowMin / intervalMin));
  return Math.max(1, Math.ceil((laneBoards / runs) * headroom));
}

// measured: { cpuMsPerBoard, cpuMsPerRun (fixed cost: the directory, the lane's buckets), requestsPerBoard }
// assumed:  { latencyMs } (network time per request, not measurable offline)
// limits:   { cpuMs: 2000 (Edge Function CPU per request), deadlineS: 100 (no board started after it), wallS: 150 }
// cpuBudget: the share of the CPU limit a run may plan to use (the rest: the database client's own work, a cold start).
// A lane count fits when one run at the heaviest lane's capacity fits the CPU budget, the deadline and maxCapacity.
export function planLanes(o) {
  const counts = Array.isArray(o.counts) ? o.counts : bucketCounts(o.boards || []);
  const total = counts.reduce((a, n) => a + n, 0);
  const windowMin = o.windowMin ?? 60, intervalMin = o.intervalMin ?? 5, headroom = o.headroom ?? 1.5;
  const concurrency = o.concurrency ?? 8, cpuBudget = o.cpuBudget ?? 0.75;
  const maxCapacity = o.maxCapacity ?? 400; // the handler's INGEST_MAX_BOARDS default: a run never takes more
  const m = o.measured || {}, a = o.assumed || {}, lim = { cpuMs: 2000, deadlineS: 100, wallS: 150, ...(o.limits || {}) };
  const reqPerBoard = m.requestsPerBoard ?? 1, latencyMs = a.latencyMs ?? 600;
  // A steady-state read costs cpuMsPerBoard when the board's body changed since its last read and cpuMsPerBoardUnchanged
  // when it did not (the body hash matches: nothing is parsed); changedShare is the share of boards whose body changes
  // between two reads. Without the unchanged cost, every read is charged as changed.
  const changedShare = a.changedShare ?? 1;
  const perBoard = m.cpuMsPerBoardUnchanged == null ? (m.cpuMsPerBoard ?? 0) : changedShare * (m.cpuMsPerBoard ?? 0) + (1 - changedShare) * m.cpuMsPerBoardUnchanged;
  const rows = [];
  for (let lanes = 1; lanes <= (o.maxLanes ?? BUCKETS); lanes++) {
    const loads = laneLoads(counts, lanes), heaviest = Math.max(...loads);
    const cap = laneCapacity(heaviest, windowMin, intervalMin, headroom);
    const cpuMs = (m.cpuMsPerRun ?? 0) + cap * perBoard;
    const wallS = (cap * reqPerBoard * latencyMs) / concurrency / 1000;
    const fitsCpu = cpuMs <= lim.cpuMs * cpuBudget, fitsWall = wallS <= Math.min(lim.deadlineS, lim.wallS), fitsCap = cap <= maxCapacity;
    rows.push({ lanes, heaviest_lane_boards: heaviest, lightest_lane_boards: Math.min(...loads), capacity_per_run: cap,
      cpu_ms_per_run: Math.round(cpuMs), wall_s_per_run: +wallS.toFixed(1), fits_cpu: fitsCpu, fits_wall: fitsWall, fits_capacity: fitsCap });
    if (fitsCpu && fitsWall && fitsCap) {
      const runsPerHour = 60 / intervalMin;
      return { ok: true, lanes, boards: total, window_min: windowMin, interval_min: intervalMin, headroom, concurrency, cpu_budget: cpuBudget,
        capacity_per_run: cap, cpu_ms_per_run: Math.round(cpuMs), wall_s_per_run: +wallS.toFixed(1), lane_loads: loads,
        invocations_per_hour: lanes * runsPerHour, requests_per_hour: Math.round((total * reqPerBoard * 60) / windowMin),
        // The run's CPU bound as postings parsed: the CPU budget left after the fixed cost, at the measured cost of a posting.
        posting_budget: m.cpuMsPerPosting ? Math.max(1, Math.floor((lim.cpuMs * cpuBudget - (m.cpuMsPerRun ?? 0)) / m.cpuMsPerPosting)) : null,
        // The first full read of every board (every posting new) at that bound: how long until the index first covers all.
        first_coverage_hours: m.cpuMsPerPosting && m.postingsTotal ? +((m.postingsTotal / Math.max(1, Math.floor((lim.cpuMs * cpuBudget - (m.cpuMsPerRun ?? 0)) / m.cpuMsPerPosting))) / (lanes * runsPerHour)).toFixed(1) : null,
        tried: rows };
    }
  }
  return { ok: false, lanes: null, boards: total, window_min: windowMin, interval_min: intervalMin, reason: "no lane count up to the bucket limit fits one run inside the limits", tried: rows };
}

// Oldest-first reads (never-read first) per lane, as career_board_state.due serves them, over `hours` simulated hours.
// Each tick each lane takes up to its capacity; a run is lost with probability `lose` and cut short (a random part
// read) with probability `cut`. Returns the oldest age of any board's last read seen after the first window, in minutes,
// and whether every board was read at all.
export function simulateFreshness(o) {
  const lanes = clampLanes(o.lanes), windowMin = o.windowMin ?? 60, intervalMin = o.intervalMin ?? 5, hours = o.hours ?? 4;
  let seed = (o.seed ?? 1) >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const queues = Array.from({ length: lanes }, () => []);
  o.boards.forEach((b, i) => queues[laneOf(b, lanes)].push(i));
  const last = new Float64Array(o.boards.length).fill(-Infinity);
  const caps = queues.map((q) => o.capacity ?? laneCapacity(q.length, windowMin, intervalMin, o.headroom ?? 1.5));
  let worst = 0, ticks = 0;
  for (let t = 0; t < hours * 60; t += intervalMin, ticks++) {
    queues.forEach((q, l) => {
      if (rnd() < (o.lose ?? 0)) return;
      let take = Math.min(caps[l], q.length);
      if (rnd() < (o.cut ?? 0)) take = Math.floor(take * rnd());
      const read = q.splice(0, take);
      for (const i of read) last[i] = t;
      q.push(...read); // read now: the back of the line
    });
    if (t + intervalMin > windowMin) for (let i = 0; i < last.length; i++) worst = Math.max(worst, t + intervalMin - last[i]);
  }
  return { worst_age_min: worst, every_board_read: last.every((x) => x > -Infinity), ticks, capacities: caps };
}

// Fresh = read successfully at or after now - window. `states`: career_board_state rows ({bucket, last_ok_at}).
export function coverageOf(states, nowMs, windowMin, buckets) {
  const mine = buckets ? new Set(buckets) : null, since = nowMs - windowMin * 60000;
  let total = 0, fresh = 0;
  for (const s of states) {
    if (mine && !mine.has(s.bucket)) continue;
    total++;
    if (s.last_ok_at && Date.parse(s.last_ok_at) >= since) fresh++;
  }
  return { fresh, total };
}

const n = (x) => Number(x || 0).toLocaleString("en-US");
export const fraction = (a, b) => `${n(a)}/${n(b)}`;
// The kind of a board failure, so a run's failures read as counts ("HTTP 404 x20, timed out x3").
export function failureKind(error) {
  const e = String(error || "unknown error");
  const http = /HTTP (\d{3})/.exec(e);
  if (http) return `HTTP ${http[1]}`;
  if (/timed? ?out|abort/i.test(e)) return "timed out";
  if (/not a [a-z]+ board/i.test(e)) return "not the provider's feed shape";
  if (/not supported/i.test(e)) return "provider not supported";
  return e.replace(/\s+/g, " ").slice(0, 60);
}

// One run's record. stats: ingestBoards' stats (+ attempted); due: boards the lane owed this run; coverage: {lane, directory}
// as {fresh, total} (absent when the store cannot count them).
export function runReport(o) {
  const s = o.stats || {}, failures = s.failures || [];
  const reasons = {};
  for (const f of failures) { const k = failureKind(f.error); reasons[k] = (reasons[k] ?? 0) + 1; }
  const why = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} x${c}`).join(", ");
  const parts = [];
  if (o.lanes) parts.push(`lane ${o.lane} of ${o.lanes}`);
  parts.push(`boards read ${fraction(s.attempted ?? 0, o.due ?? s.attempted ?? 0)} due`);
  parts.push(`ok ${n(s.boards_ok)}${s.boards_not_modified ? ` (${n(s.boards_not_modified)} unchanged since the last read)` : ""}${s.boards_partial ? `, partial ${n(s.boards_partial)}` : ""}`);
  parts.push(`failed ${n(s.boards_failed)}${why ? ` (${why})` : ""}`);
  parts.push(`postings new ${n(s.new)}, seen ${n(s.seen)}, reopened ${n(s.reopened)}, closed ${n(s.closed)}`);
  if (s.url_rejected) parts.push(`not job links, refused ${n(s.url_rejected)}`);
  if (s.stopped_by) parts.push(`stopped by the ${s.stopped_by === "deadline" ? "deadline" : "posting budget"}: ${n((o.due ?? 0) - (s.attempted ?? 0))} boards left for the next run`);
  const cov = o.coverage || {};
  if (cov.lane || cov.directory) {
    const w = o.windowMin ?? 60, c = [];
    if (cov.lane) c.push(`lane ${fraction(cov.lane.fresh, cov.lane.total)}`);
    if (cov.directory) c.push(`directory ${fraction(cov.directory.fresh, cov.directory.total)}`);
    parts.push(`read within ${w} min: ${c.join(", ")}`);
  }
  const frac = (c) => (c && c.total ? +(c.fresh / c.total).toFixed(4) : null);
  return {
    text: parts.join("; "),
    due: o.due ?? null, read: s.attempted ?? 0, read_fraction: o.due ? +((s.attempted ?? 0) / o.due).toFixed(4) : null,
    failure_reasons: reasons,
    lane_fresh_fraction: frac(cov.lane), directory_fresh_fraction: frac(cov.directory),
  };
}
