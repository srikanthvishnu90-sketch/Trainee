// career-ingest, bounded (2026-10-30 production fix), on a real Postgres 16 with the career schema (the flow harness:
// tests/flow/pg.ts) through the PostgREST double and the real supabase-js client, the way the deployed function talks to
// the database. The production failures were: "read postings: error sending request" (in.(...) URLs of ~13 KB),
// "touch postings" / "write postings: canceling statement due to statement timeout", and failed runs with no log row.
//   P1  a lane's worth at realistic sizes (a Workday board of 1,000 long ids, a Lever board of 1,500 postings with long
//       descriptions read as a stream, a Greenhouse board of 300): every request URL under 6 KB, the stored rows compared
//       through career_postings_known (no description read back), every row written
//   P2  seen again 7 hours on, unchanged: every posting touched, its search vector as it was, first_seen kept
//   P3  changed and removed postings: rewritten (searchable by the new words at once) and closed
//   P4  statement timeouts: a write or touch over 20 rows times out and goes through in halves; a board whose writes
//       always time out fails alone, with its reason, and the lane goes on
//   P5  the scheduled handler on the database: a board past the run's posting budget is read in parts (career_board_state
//       pass_offset), the run's row is written at its start and completed at its end, the pass closes what it did not see
//   P6  a run that fails is in career_ingest_runs as failed, with its error
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/ingest-bounded-pg.test.ts
// (needs Postgres 16 binaries; in CI it must run).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { boardFetchFeed, ingestBoards, sha256Hex, supabasePostingsDb, type Board, type BoardOutcome } from "../../supabase/functions/_shared/career_ingest.ts";
import { supabaseBoardState } from "../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../supabase/functions/career-ingest/handler.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const URL0 = "http://supabase.test", KEY = "service-test-key", SECRET = "s".repeat(40);
const T0 = Date.UTC(2026, 9, 30, 6, 2), H = 3600000, MIN = 60000;
const TIMEOUT = "canceling statement due to statement timeout";

// ------------------------------------------------------------------------------------------------ the boards
const words = (i: number, n: number, extra = "") => (`Posting ${i}: stock shelves, help customers, open and close the store. ${extra} `).repeat(Math.ceil(n / 70) + 1).slice(0, n);
function streamed(parts: Iterable<string>): Response {
  const it = parts[Symbol.iterator](), enc = new TextEncoder();
  let buf = "";
  return new Response(new ReadableStream<Uint8Array>({ pull(c) {
    while (buf.length < 65536) { const n = it.next(); if (n.done) break; buf += n.value; }
    if (!buf) { c.close(); return; }
    c.enqueue(enc.encode(buf.slice(0, 65536))); buf = buf.slice(65536);
  } }), { status: 200 });
}
interface World { leverDrop: Set<number>; leverEdit: Set<number>; workdayDrop: Set<number> }
function* lever(board: string, n: number, w: World) {
  yield "[";
  let first = true;
  for (let i = 0; i < n; i++) {
    if (w.leverDrop.has(i)) continue;
    const d = words(i, 3000, w.leverEdit.has(i) ? "Forklift certification preferred." : "");
    yield (first ? "" : ",") + JSON.stringify({ id: `${board}-${i}`, text: `Store Associate ${i}`, categories: { location: "Dallas, TX", team: "Retail" },
      hostedUrl: `https://jobs.lever.co/${board}/${board}-${i}`, createdAt: Date.UTC(2026, 9, 1), descriptionPlain: d, description: `<div>${d}</div>` });
    first = false;
  }
  yield "]";
}
const greenhouse = (board: string, n: number) => JSON.stringify({ jobs: Array.from({ length: n }, (_, i) => ({ id: 7000000 + i, title: `Registered Nurse ${i}`, location: { name: "Houston, TX" },
  absolute_url: `https://boards.greenhouse.io/${board}/jobs/${7000000 + i}`, updated_at: "2026-10-20T00:00:00Z", content: `&lt;p&gt;${words(i, 5000)}&lt;/p&gt;` })) });
function workday(total: number, offset: number, limit: number, w: World) {
  const all = Array.from({ length: total }, (_, i) => i).filter((i) => !w.workdayDrop.has(i));
  return JSON.stringify({ total: offset === 0 ? all.length : 0, jobPostings: all.slice(offset, offset + limit).map((i) => ({
    title: `Patient Accounts Rep - Patient Financial Services - Full Time 8 hours ${i}`, externalPath: `/job/Los-Angeles-CA/Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ${20000 + i}`,
    locationsText: "Los Angeles, CA", postedOn: "Posted 3 Days Ago" })) });
}
function ats(w: World) {
  return (async (url: string, init?: RequestInit) => {
    if (/myworkdayjobs/.test(url)) { const q = JSON.parse(String(init?.body)); return new Response(workday(1000, q.offset, q.limit, w), { status: 200 }); }
    const lv = /lever\.co\/v0\/postings\/([a-z0-9]+)/.exec(url);
    if (lv) return streamed(lever(lv[1], 1500, w));
    const gh = /boards\/([a-z0-9]+)\/jobs/.exec(url);
    if (gh) return new Response(greenhouse(gh[1], 300), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const WORKDAY: Board = { company: "Keck Medicine of USC", provider: "workday", board: "usc.wd5/externalkeckusccareers" };
const LEVER: Board = { company: "BoxLunch", provider: "lever", board: "boxlunch" };
const clinic = (n: number): Board => ({ company: `Clinic ${n}`, provider: "greenhouse", board: `clinic${n}` });

// ------------------------------------------------------------------------------------------------ the database, watched
interface Req { method: string; path: string; urlLength: number; rows: number }
function client(pg: Pg, fail: { fn: ((r: Req) => string | null) | null }) {
  const double = postgrestDouble(pg, { url: URL0, serviceKey: KEY, users: {} });
  const log: Req[] = [];
  const watched = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    const ids = /^in\.\((.*)\)$/.exec(u.searchParams.get("job_id") ?? "")?.[1];
    let rows = ids ? ids.split(",").length : 0;
    if (req.method === "POST" && !u.pathname.includes("/rpc/")) { const b = await req.clone().json().catch(() => null); rows = Array.isArray(b) ? b.length : 1; }
    if (u.pathname.endsWith("/rpc/career_postings_known")) rows = ((await req.clone().json()).p_ids ?? []).length;
    const r: Req = { method: req.method, path: u.pathname + u.search, urlLength: req.url.length, rows };
    log.push(r);
    const e = fail.fn?.(r);
    if (e) return new Response(JSON.stringify({ code: "57014", message: e, details: null, hint: null }), { status: 500, headers: { "content-type": "application/json" } });
    return await double.fetch(req);
  };
  return { admin: createClient(URL0, KEY, { auth: { persistSession: false }, global: { fetch: watched as typeof fetch } }), log };
}
const n = async (pg: Pg, sql: string) => Number(await pg.sql(sql));

Deno.test({
  name: "Ingest bounded on Postgres: URLs under 6 KB, rows compared without descriptions, touches leave search alone, timeouts fail a board not the lane, big boards read in parts, every run logged",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    try {
      const fail: { fn: ((r: Req) => string | null) | null } = { fn: null };
      const { admin, log } = client(pg, fail);
      const db = supabasePostingsDb(admin);
      const w: World = { leverDrop: new Set(), leverEdit: new Set(), workdayDrop: new Set() };
      const feed = boardFetchFeed(ats(w), { stream: true, bodyHash: true });
      const run = (boards: Board[], at: number, o: { postingBudget?: number; onBoard?: (b: Board, r: BoardOutcome) => void } = {}) =>
        ingestBoards({ boards, db, now: at, useCursor: false, concurrency: 4, touchAfterMs: 6 * H, fetchFeed: feed, ...o });

      await t.step("P1 a lane's worth at realistic sizes: every URL under 6 KB, rows compared through career_postings_known, every row written", async () => {
        const st = await run([WORKDAY, LEVER, clinic(1)], T0);
        eq([st.boards_ok, st.boards_failed, st.new], [3, 0, 2800], "three boards, 2,800 postings new");
        eq(await n(pg, "select count(*) from career_postings where closed_at is null"), 2800, "every row written");
        const longest = Math.max(...log.map((r) => r.urlLength));
        assert(longest <= 6000, `the longest request URL: ${longest} characters`);
        assert(log.some((r) => r.path.startsWith("/rest/v1/rpc/career_postings_known")), "the stored rows come from career_postings_known");
        assert(!log.some((r) => r.method === "GET" && /career_postings\?select=\*/.test(r.path)), "no whole row (description) is read back");
        assert(Math.max(...log.filter((r) => r.method === "POST" && r.path.startsWith("/rest/v1/career_postings")).map((r) => r.rows)) <= 50, "at most 50 rows a write");
        // The database's description hash is the run's own.
        const id = "lever:boxlunch:boxlunch-7";
        const { data } = await admin.rpc("career_postings_known", { p_ids: [id] });
        const desc = await pg.sql(`select description from career_postings where job_id = '${id}'`);
        eq(data[0].description_sha, await sha256Hex(desc), "SHA-256 of the description, the same on both sides");
        assert(!("description" in data[0]), "no description in the known row");
        assert(await n(pg, `select count(*) from career_postings where job_id like 'workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---%' and search @@ websearch_to_tsquery('english','patient accounts')`) === 1000, "Workday rows searchable");
      });

      const searchSum = () => pg.sql("select md5(string_agg(search::text, '|' order by job_id)) from career_postings");
      await t.step("P2 seen again 7 hours on, unchanged: every posting touched, its search vector as it was, first seen kept", async () => {
        const before = await searchSum();
        log.length = 0;
        const st = await run([WORKDAY, LEVER, clinic(1)], T0 + 7 * H);
        eq([st.new, st.seen, st.closed], [0, 2800, 0], "all seen");
        eq(await n(pg, `select count(*) from career_postings where last_seen_at = '${new Date(T0 + 7 * H).toISOString()}' and first_seen_at = '${new Date(T0).toISOString()}'`), 2800, "every posting touched, first seen kept");
        eq(await searchSum(), before, "search untouched by the touches");
        assert(!log.some((r) => r.method === "POST" && r.path.startsWith("/rest/v1/career_postings")), "nothing rewritten");
        const touches = log.filter((r) => r.method === "PATCH");
        assert(touches.length >= 28 && Math.max(...touches.map((r) => r.rows)) <= 100 && Math.max(...touches.map((r) => r.urlLength)) <= 6000, "touches in bounded lists");
      });

      await t.step("P3 changed postings are rewritten and searchable at once; removed ones are closed", async () => {
        w.leverEdit = new Set([5, 6, 700, 701, 1499]); w.workdayDrop = new Set([0, 1, 2, 500, 501, 998, 999]);
        const st = await run([WORKDAY, LEVER], T0 + 8 * H);
        eq([st.closed, st.boards_failed], [7, 0], "the seven removed Workday postings closed");
        eq(await n(pg, "select count(*) from career_postings where closed_at is null and search @@ websearch_to_tsquery('english','forklift')"), 5, "the new words found");
        eq(await n(pg, "select count(*) from career_postings where provider = 'workday' and closed_at is not null"), 7, "closed in the table");
      });

      await t.step("P4 statement timeouts: retried in halves; a board that keeps timing out fails alone, the lane goes on", async () => {
        log.length = 0;
        fail.fn = (r) => (r.method === "POST" || r.method === "PATCH") && r.path.startsWith("/rest/v1/career_postings") && r.rows > 20 ? `write postings: ${TIMEOUT}` : null;
        const st = await run([clinic(2)], T0 + 9 * H);
        eq([st.boards_ok, st.boards_failed, st.new], [1, 0, 300], "written in parts");
        assert(log.some((r) => r.rows > 20 && r.method === "POST") && log.filter((r) => r.method === "POST" && r.path.startsWith("/rest/v1/career_postings")).every((r) => r.rows <= 50), "a timed-out write was retried smaller");
        // Every write of clinic3's rows times out, however small (the board being written is tracked on the store).
        let writing = "", clinic3Writes = 0;
        fail.fn = (r) => {
          if (r.method === "POST" && r.path.startsWith("/rest/v1/career_postings") && writing === "clinic3") { clinic3Writes++; return TIMEOUT; }
          return null;
        };
        const outcomes = new Map<string, BoardOutcome>();
        const orig = db.putMany.bind(db);
        db.putMany = async (ps) => { writing = ps[0]?.board ?? ""; try { await orig(ps); } finally { writing = ""; } };
        const st2 = await ingestBoards({ boards: [clinic(3), clinic(4)], db, now: T0 + 9 * H, useCursor: false, concurrency: 1, fetchFeed: feed, onBoard: (b, r) => { outcomes.set(b.board, r); } });
        db.putMany = orig;
        fail.fn = null;
        eq([st2.boards_ok, st2.boards_failed], [1, 1], "one board failed, the other read");
        assert(/^storage: write postings: canceling statement due to statement timeout/.test(st2.failures[0].error) && clinic3Writes > 1, st2.failures[0]?.error);
        eq([outcomes.get("clinic3")!.status, outcomes.get("clinic4")!.status], ["failed", "ok"], "outcomes");
        eq(await n(pg, "select count(*) from career_postings where board = 'clinic4'"), 300, "the next board's rows written");
      });

      await t.step("P5 the scheduled handler: a board past the posting budget is read in parts; the run's row is written first and completed; the pass closes what it did not see", async () => {
        const env = { get: (k: string) => ({ CAREER_INGEST_SECRET: SECRET, INGEST_CONTACT_EMAIL: "ops@example.test", INGEST_EVERY_MIN: "15" } as Record<string, string>)[k] };
        const boards = [LEVER, clinic(5)];
        w.leverDrop = new Set([42, 1200]); w.leverEdit = new Set();
        const deps = (at: number) => ({ env, boards, now: () => at, db: () => supabasePostingsDb(admin), state: () => supabaseBoardState(admin), fetchFeed: () => feed });
        const post = () => new Request("https://fn.test/?lane=0&lanes=1&window_min=15&posting_budget=600", { method: "POST", headers: { "x-trainee-ingest-secret": SECRET } });
        let at = T0 + 16 * H, runs = 0, offset = -1;
        const offsets: number[] = [];
        do {
          const res = await handleIngest(post(), deps(at));
          assert(res.status === 200, `run ${runs}: ${res.status} ${await res.text()}`);
          offset = await n(pg, "select pass_offset from career_board_state where provider = 'lever' and board = 'boxlunch'");
          offsets.push(offset);
          at += 5 * MIN; runs++;
        } while ((offset > 0 || runs < 2) && runs < 10);
        assert(offsets[0] > 0 && offsets.at(-1) === 0, `the board read in parts: offsets ${offsets}`);
        eq(await n(pg, "select count(*) from career_board_state where pass_offset = 0 and pass_started_at is null and provider = 'lever'"), 1, "the pass is over");
        eq(await n(pg, "select count(*) from career_postings where board = 'boxlunch' and closed_at is not null and job_id in ('lever:boxlunch:boxlunch-42','lever:boxlunch:boxlunch-1200')"), 2, "the pass's end closed what no part saw");
        eq(await n(pg, "select count(*) from career_postings where board = 'boxlunch' and closed_at is not null"), 2, "and nothing else");
        eq(await n(pg, "select count(*) from career_ingest_runs"), runs, "one row a run");
        eq(await n(pg, "select count(*) from career_ingest_runs where status = 'done' and report like 'lane 0 of 1;%'"), runs, "each completed as done");
        assert(await n(pg, "select count(*) from career_ingest_runs where report like '%read in parts: 1 board stopped at the posting budget, continued next run%'") >= 1, "a run that stopped inside a board says so");
      });

      await t.step("P6 a run that fails is logged as failed, with its error", async () => {
        const env = { get: (k: string) => ({ CAREER_INGEST_SECRET: SECRET, INGEST_CONTACT_EMAIL: "ops@example.test" } as Record<string, string>)[k] };
        // The board state unreadable: the due list (GET) or, since ingest round 2, the claim that takes it (one RPC).
        fail.fn = (r) => (r.method === "GET" && r.path.startsWith("/rest/v1/career_board_state")) || r.path.startsWith("/rest/v1/rpc/career_board_state_claim") ? "permission denied for table career_board_state" : null;
        const before = await n(pg, "select count(*) from career_ingest_runs");
        const res = await handleIngest(new Request("https://fn.test/?lane=0&lanes=1", { method: "POST", headers: { "x-trainee-ingest-secret": SECRET } }),
          { env, boards: [clinic(6)], now: () => T0 + 20 * H, db: () => supabasePostingsDb(admin), state: () => supabaseBoardState(admin), fetchFeed: () => feed });
        fail.fn = null;
        eq(res.status, 500, "the run failed");
        eq(await n(pg, "select count(*) from career_ingest_runs") - before, 1, "one row for it");
        const row = JSON.parse(await pg.sql("select to_jsonb(r) from career_ingest_runs r order by id desc limit 1"));
        eq([row.status, /permission denied for table career_board_state/.test(row.error), /run failed/.test(row.report)], ["failed", true, true], "failed, with its error");
      });
    } finally {
      await pg.stop();
    }
  },
});
