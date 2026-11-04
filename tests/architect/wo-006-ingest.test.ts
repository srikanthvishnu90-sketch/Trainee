// WO-006 acceptance tests (architect-authored; builders make them pass, never edit them).
// Job ingestion: public ATS boards -> postings, with honest first-seen times, closes only on a successful read,
// and a rotating cursor so a big directory fits inside one function run. Network is injected (fetchFeed).
// Contract in docs/architect/work-orders/WO-006-job-ingestion.md. Run: deno test -A --no-check tests/architect/
import { ingestBoards, memoryPostingsDb, type Board, type FetchFeed } from "../../supabase/functions/_shared/career_ingest.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const T0 = Date.UTC(2026, 9, 19, 12), H = 3600000;
const iso = (ms: number) => new Date(ms).toISOString();

const board = (company: string, provider = "greenhouse"): Board => ({ company, provider, board: company.toLowerCase() });
const job = (b: Board, id: string, title: string) => ({ job_id: `${b.provider}:${b.board}:${id}`, company: b.company, title, location: "Remote - US", url: `https://example.test/${b.board}/${id}`, description: `${title} at ${b.company}` });

// A fake network: per board, a list of postings or an error.
function net(map: Record<string, any[] | Error>): FetchFeed & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (b: Board) => { calls.push(b.board); const v = map[b.board]; if (v instanceof Error) throw v; return v || []; }) as FetchFeed & { calls: string[] };
  f.calls = calls;
  return f;
}

Deno.test("WO-006/1 the first run stores every posting with first_seen_at = now", async () => {
  const s = board("Stripe"), r = board("Ramp", "ashby"), db = memoryPostingsDb();
  const stats = await ingestBoards({ boards: [s, r], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst"), job(s, "2", "SWE")], ramp: [job(r, "9", "Ops")] }), db, now: T0 });
  eq([stats.boards_ok, stats.boards_failed, stats.new, stats.seen, stats.closed], [2, 0, 3, 0, 0]);
  const all = await db.open();
  eq(all.map((p) => p.job_id).sort(), ["ashby:ramp:9", "greenhouse:stripe:1", "greenhouse:stripe:2"]);
  assert(all.every((p) => p.first_seen_at === iso(T0) && p.last_seen_at === iso(T0) && p.closed_at === null), "first and last seen now, open");
});

Deno.test("WO-006/2 a later run keeps first_seen_at, adds new postings, and closes postings that disappeared", async () => {
  const s = board("Stripe"), db = memoryPostingsDb();
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst"), job(s, "2", "SWE")] }), db, now: T0 });
  const stats = await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst"), job(s, "3", "PM")] }), db, now: T0 + H });
  eq([stats.new, stats.seen, stats.closed], [1, 1, 1]);
  const byId = Object.fromEntries((await db.all()).map((p) => [p.job_id, p]));
  eq(byId["greenhouse:stripe:1"].first_seen_at, iso(T0), "first seen never moves");
  eq(byId["greenhouse:stripe:1"].last_seen_at, iso(T0 + H));
  eq(byId["greenhouse:stripe:3"].first_seen_at, iso(T0 + H));
  eq(byId["greenhouse:stripe:2"].closed_at, iso(T0 + H), "gone from the board = closed");
  eq((await db.open()).map((p) => p.job_id).sort(), ["greenhouse:stripe:1", "greenhouse:stripe:3"]);
});

Deno.test("WO-006/3 a board that fails to load closes nothing and is counted as failed", async () => {
  const s = board("Stripe"), db = memoryPostingsDb();
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst")] }), db, now: T0 });
  const stats = await ingestBoards({ boards: [s], fetchFeed: net({ stripe: new Error("HTTP 503") }), db, now: T0 + H });
  eq([stats.boards_ok, stats.boards_failed, stats.closed], [0, 1, 0]);
  eq((await db.open()).length, 1, "still open: a failed read proves nothing");
  assert(stats.failures.length === 1 && /503/.test(stats.failures[0].error) && stats.failures[0].board === "stripe", "the failure is reported with its board");
});

// Ingest round 3 (2026-11-03, architect): a board answering an empty list while it has open postings is as often an outage
// as a board whose jobs all closed at once, so its postings close on the EMPTY_AFTER-th (3rd) such read in a row
// (career_ingest.ts EMPTY_AFTER; the scheduled run carries the count in career_board_state, "ok [empty x2]").
Deno.test("WO-006/4 a board that returns zero postings successfully closes its open postings (on the third such read in a row)", async () => {
  const s = board("Stripe"), db = memoryPostingsDb();
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst")] }), db, now: T0 });
  const outcomes: { empty_reads?: number }[] = [];
  const held = await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [] }), db, now: T0 + H, onBoard: (_b, r) => { outcomes.push(r); } });
  eq(held.closed, 0, "one empty read: held");
  eq((await db.open()).length, 1);
  eq(outcomes[0].empty_reads, 1, "the empty read is counted");
  const stats = await ingestBoards({ boards: [{ ...s, empty_reads: 2 }], fetchFeed: net({ stripe: [] }), db, now: T0 + 3 * H });
  eq(stats.closed, 1);
  eq((await db.open()).length, 0);
});

Deno.test("WO-006/5 a posting that reappears after closing is reopened with its original first_seen_at", async () => {
  const s = board("Stripe"), db = memoryPostingsDb();
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst")] }), db, now: T0 });
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [] }), db, now: T0 + H });
  const stats = await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Data Analyst")] }), db, now: T0 + 2 * H });
  const p = (await db.all())[0];
  eq([p.closed_at, p.first_seen_at, stats.new], [null, iso(T0), 0], "a repost is not a new posting");
});

Deno.test("WO-006/6 maxBoards and the cursor rotate through a big directory, every board covered", async () => {
  const boards = ["A", "B", "C", "D", "E"].map((c) => board(c)), db = memoryPostingsDb();
  const f = net({});
  for (let i = 0; i < 3; i++) await ingestBoards({ boards, fetchFeed: f, db, now: T0 + i * H, maxBoards: 2 });
  eq(f.calls.slice(0, 5).sort(), ["a", "b", "c", "d", "e"], "three runs of two cover all five, in rotation");
  eq(f.calls.length, 6);
});

Deno.test("WO-006/7 newSince returns open postings first seen after a time, newest first (the alert feed)", async () => {
  const s = board("Stripe"), db = memoryPostingsDb();
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Old")] }), db, now: T0 });
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Old"), job(s, "2", "New A")] }), db, now: T0 + H });
  await ingestBoards({ boards: [s], fetchFeed: net({ stripe: [job(s, "1", "Old"), job(s, "2", "New A"), job(s, "3", "New B")] }), db, now: T0 + 2 * H });
  eq((await db.newSince(iso(T0 + 30 * 60000))).map((p) => p.title), ["New B", "New A"]);
});
