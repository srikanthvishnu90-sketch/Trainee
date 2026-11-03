// career-ingest, bounded (2026-10-30 production fix). The live function failed ~20% of its lane runs every hour: "Memory
// limit exceeded" / "CPU Time exceeded" (a whole board held as text, parsed JSON and postings at once, 8 boards at a time;
// one Lever board lists 4,600 postings), statement timeouts on "touch postings" / "write postings", and "read postings:
// error sending request" (in.(...) lists of 100 long Workday ids: ~20 KB URLs). A stopped run left no log row and left its
// boards first in line, so the lane was stopped the same way every tick. Over fake boards and fake stores (no network, no
// database; the same paths on a real Postgres: tests/architect/ingest-bounded-pg.test.ts):
//   B1  the streamed job-array splitter: any chunking, escapes, skip, the root's own fields, a split UTF-8 character
//   B2  id lists stay under 6 KB of URL (the production URLs did not), in every read and write that sends one
//   B3  a statement that times out is retried in halves; one that keeps timing out fails its board, never the lane
//   B4  a board larger than the run's budget is read in parts over runs, never held whole, closed at the pass end
//   B5  a lane like the largest: 112 boards x 300 postings with long descriptions and Workday boards with thousands,
//       stopped at the run's posting budget, every store call a bounded batch, the body never held past WHOLE_MAX
//   B6  the bounded read gives the same postings as the whole read, for every JSON provider; an XML feed past 8 MB fails
//   B7  the handler: the run's row is written first, the claim precedes the reads, a failed run records its error and
//       hands back what it never reached
//   B8  the working set, measured: live heap (after gc, in a child process) while a 4,600-posting board streams through
// Run: deno test -A --no-check tests/edge/career-ingest-bounded.test.ts
import { boardFetchFeed, halving, ingestBoards, INGEST_BATCH, memoryPostingsDb, RESUME_OVERLAP, sha256Hex, supabasePostingsDb, WHOLE_MAX, writeBatches, XML_MAX, type Board, type BoardOutcome, type FeedPosting, type IngestRunRow, type KnownPosting, type PostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { idChunks, jsonArrayElements, readBody, streamProbe, transientStorageError } from "../../supabase/functions/_shared/career_ingest_stream.ts";
import { boardKey, memoryBoardState } from "../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../supabase/functions/career-ingest/handler.ts";
import { FIX } from "../architect/wo-044-fixtures.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x.slice(0, 600)}\n  want: ${y.slice(0, 600)}`); }
const T0 = Date.UTC(2026, 9, 30, 6, 2), MIN = 60000, H = 3600000;
const CHUNK = 65536;

// ------------------------------------------------------------------------------------------------ fake boards
// A body generated as it is read (the test never holds it either), in CHUNK-character pieces.
export function streamed(parts: () => Iterable<string>, chunk = CHUNK): Response {
  const it = parts()[Symbol.iterator](), enc = new TextEncoder();
  let buf = "";
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      while (buf.length < chunk) { const n = it.next(); if (n.done) break; buf += n.value; }
      if (!buf) { c.close(); return; }
      c.enqueue(enc.encode(buf.slice(0, chunk)));
      buf = buf.slice(chunk);
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const words = (i: number, n: number) => `Posting ${i}: stock shelves, help customers, open and close the store, run the register. `.repeat(Math.ceil(n / 80) + 1).slice(0, n);
// Lever: a root array; each job carries its description twice (plain and HTML), as Lever's API does.
export function* leverBody(board: string, n: number, descChars: number, drop: Set<number> = new Set(), edit: Set<number> = new Set()) {
  yield "[";
  let first = true;
  for (let i = 0; i < n; i++) {
    if (drop.has(i)) continue;
    const d = words(i, descChars) + (edit.has(i) ? " Now hiring a shift lead." : "");
    yield (first ? "" : ",") + JSON.stringify({ id: `${board}-${i}`, text: `Store Associate ${i}`, categories: { location: "Dallas, TX", team: "Retail" },
      hostedUrl: `https://jobs.lever.co/${board}/${board}-${i}`, createdAt: Date.UTC(2026, 9, 1), descriptionPlain: d, description: `<div>${d}</div>` });
    first = false;
  }
  yield "]";
}
export function* greenhouseBody(board: string, n: number, contentChars: number) {
  yield '{"jobs":[';
  for (let i = 0; i < n; i++) {
    yield (i ? "," : "") + JSON.stringify({ id: 9000000 + i, title: `Registered Nurse ${i}`, location: { name: "Houston, TX" }, absolute_url: `https://boards.greenhouse.io/${board}/jobs/${9000000 + i}`,
      updated_at: "2026-10-20T00:00:00Z", content: `&lt;p&gt;${words(i, contentChars)}&lt;/p&gt;` });
  }
  yield `],"meta":{"total":${n}}}`;
}
// Workday's paged search: `total` boards' worth of postings, 20 a page, long ids like production's.
function workdayPage(total: number, offset: number, limit: number) {
  const n = Math.max(0, Math.min(limit, total - offset));
  return JSON.stringify({ total: offset === 0 ? total : 0, jobPostings: Array.from({ length: n }, (_, k) => {
    const i = offset + k;
    return { title: `Patient Accounts Rep - Patient Financial Services - Full Time 8 hours ${i}`, externalPath: `/job/Los-Angeles-CA/Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ${20000 + i}`,
      locationsText: "Los Angeles, CA", postedOn: "Posted 3 Days Ago", bulletFields: [`REQ${20000 + i}`] };
  }) });
}

// ------------------------------------------------------------------------------------------------ a store without descriptions
// Keeps each posting as the run compares it (no description, its SHA-256), and the size of every call.
export function slimDb() {
  const rows = new Map<string, KnownPosting>();
  const calls = { known: [] as number[], put: [] as number[], putChars: [] as number[], touch: [] as number[], close: [] as number[], getMany: 0 };
  const open = () => [...rows.values()].filter((p) => !p.closed_at);
  const db: PostingsDb & { rows: typeof rows; calls: typeof calls } = {
    rows, calls,
    async all() { return []; }, async open() { return []; }, async get() { return null; }, async put() {},
    async newSince() { return []; }, async search() { return []; }, async getCursor() { return 0; }, async setCursor() {},
    async getMany(ids) { calls.getMany++; return ids.map((id) => rows.get(id)).filter((p): p is KnownPosting => !!p).map((p) => ({ ...p, description: "" })); },
    async known(ids) { calls.known.push(ids.length); return ids.map((id) => rows.get(id)).filter((p): p is KnownPosting => !!p).map((p) => ({ ...p })); },
    async putMany(ps) {
      calls.put.push(ps.length); calls.putChars.push(JSON.stringify(ps).length);
      for (const p of ps) { const { description, ...rest } = p; rows.set(p.job_id, { ...rest, description_sha: await sha256Hex(description ?? "") }); }
    },
    async touch(ids, at) { calls.touch.push(ids.length); for (const id of ids) { const p = rows.get(id); if (p) p.last_seen_at = at; } },
    async close(ids, at) { calls.close.push(ids.length); for (const id of ids) { const p = rows.get(id); if (p) p.closed_at = at; } },
    async openForBoard(b) { return open().filter((p) => p.provider === b.provider && p.board === b.board).map((p) => ({ job_id: p.job_id })); },
    async staleForBoard(b, before) { const t = Date.parse(before); return open().filter((p) => p.provider === b.provider && p.board === b.board && Date.parse(p.last_seen_at) < t).map((p) => p.job_id); },
  };
  return db;
}
const maxOf = (xs: number[]) => xs.reduce((a, x) => Math.max(a, x), 0);

// ------------------------------------------------------------------------------------------------ B1
async function* pieces(s: string, n: number) { for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n); }
Deno.test("B1 the streamed job-array splitter: any chunking, escapes and braces in strings, skip, the root's own fields, not the shape, a split UTF-8 character", async () => {
  const doc = { name: 'Acme "Co" {x} é', meta: { total: 3, x: [1, { a: "]" }] }, jobs: [{ id: 1, t: 'a}\\"]{' }, 7, { id: 2, n: { z: [1, 2] } }, { id: 3, s: "☃" }], tail: "end" };
  const text = JSON.stringify(doc);
  for (const n of [1, 2, 3, 5, 7, 64, 100000]) {
    for (const skip of [0, 1, 2, 3]) {
      const scan = { found: false, done: false, root: {} as Record<string, string>, counted: 0 };
      const got: unknown[] = [];
      for await (const t of jsonArrayElements(pieces(text, n), "jobs", skip, scan)) got.push(JSON.parse(t));
      eq(got, doc.jobs.filter((j) => typeof j === "object").slice(skip), `chunks of ${n}, skip ${skip}`);
      assert(scan.found && scan.done && scan.counted === 3, "found, finished, three objects counted");
      eq([scan.root.name, scan.root.tail], [doc.name, "end"], "the root's string fields, unescaped");
    }
  }
  const arr = JSON.stringify([{ a: 1 }, { b: "x]" }]), g: unknown[] = [];
  for await (const t of jsonArrayElements(pieces(arr, 3), null)) g.push(JSON.parse(t));
  eq(g, [{ a: 1 }, { b: "x]" }], "a root array");
  const miss = { found: false, done: false, root: {}, counted: 0 };
  for await (const _ of jsonArrayElements(pieces(arr, 3), "jobs", 0, miss)) { /* none */ }
  assert(!miss.found, "a root array is not a body with a jobs key");
  // Bytes split inside a character: readBody decodes across chunks.
  const bytes = new TextEncoder().encode(JSON.stringify({ jobs: [{ t: "é☃\u{1F600}".repeat(50) }] }));
  const res = new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }));
  const b = await readBody(res, 10);
  assert(b.text === null, "past wholeMax: streamed");
  const out: unknown[] = [];
  for await (const t of jsonArrayElements((async function* () { while (b.head.length) yield b.head.shift()!; for await (const c of b.rest!) yield c; })(), "jobs")) out.push(JSON.parse(t));
  eq(out, [{ t: "é☃\u{1F600}".repeat(50) }], "every character whole");
});

// ------------------------------------------------------------------------------------------------ B2
// The URL supabase-js builds for .in(column, ids) (postgrest-js: values with reserved characters are quoted).
const inUrl = (base: string, col: string, ids: string[]) => {
  const u = new URL(base);
  u.searchParams.append(col, `in.(${ids.map((s) => /[,()]/.test(s) ? `"${s}"` : s).join(",")})`);
  return u.toString();
};
const BASE = "https://mrwngntwmnaqrqhupvlt.supabase.co/rest/v1/career_postings?select=*";
const LONG_ID = (i: number) => `workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ${20000 + i}`;
// A fake supabase-js admin: records the URL of every in() list and the rows of every write; `fail` answers an error.
export function fakeAdmin(o: { fail?: (op: string, n: number) => string | null; known?: boolean } = {}) {
  const urls: number[] = [], writes: { op: string; n: number }[] = [], rpcs: number[] = [];
  const result = (op: string, n: number) => { const e = o.fail?.(op, n); if (!e) writes.push({ op, n }); return Promise.resolve({ data: op === "select" ? [] : null, error: e ? { message: e } : null }); };
  const chain = (op: string, n = 0): any => {
    const c: any = {
      in(col: string, ids: string[]) { urls.push(inUrl(BASE, col, ids).length); return op === "select" ? result(op, ids.length) : result(op, ids.length); },
      select() { return c; }, eq() { return c; }, is() { return c; }, lt() { return c; }, order() { return c; },
      range() { return Promise.resolve({ data: [], error: null }); },
      then(res: any, rej: any) { return result(op, n).then(res, rej); },
    };
    return c;
  };
  const admin = {
    urls, writes, rpcs,
    from: () => ({ select: () => chain("select"), update: () => chain("update"), upsert: (rows: unknown[]) => result("upsert", rows.length), insert: () => result("insert", 1), delete: () => chain("delete") }),
    rpc: (_n: string, a: { p_ids: string[] }) => { rpcs.push(a.p_ids.length); return Promise.resolve(o.known === false ? { data: null, error: { message: "Could not find the function public.career_postings_known(p_ids) in the schema cache" } } : { data: [], error: null }); },
  };
  return admin;
}
Deno.test("B2 id lists stay under 6 KB of URL (production's 100 long Workday ids made ~13 KB): getMany, known before its migration, touch, close", async () => {
  const ids = Array.from({ length: 3000 }, (_, i) => LONG_ID(i));
  const old = inUrl(BASE, "job_id", ids.slice(0, 100)).length;
  assert(old > 12000, `the old 100-id chunk made a ${old}-character URL (the production failure)`);
  const ch = idChunks(ids);
  eq(ch.flat(), ids, "every id, once, in order");
  for (const c of ch) assert(inUrl(BASE, "job_id", c).length <= 6000 && c.length <= 100, `a chunk of ${c.length} ids made ${inUrl(BASE, "job_id", c).length} characters`);
  const short = idChunks(Array.from({ length: 1000 }, (_, i) => `greenhouse:acme:${i}`));
  assert(short.every((c) => c.length === 100), "short ids still go 100 at a time");
  for (const known of [true, false]) {
    const admin = fakeAdmin({ known });
    const db = supabasePostingsDb(admin);
    await db.getMany(ids); await db.touch(ids, new Date(T0).toISOString()); await db.close(ids, new Date(T0).toISOString()); await db.known!(ids);
    assert(admin.urls.length > 0 && maxOf(admin.urls) <= 6000, `the longest URL: ${maxOf(admin.urls)}`);
    if (known) assert(admin.rpcs.length === 15 && maxOf(admin.rpcs) === 200, "known goes by POST (career_postings_known), 200 ids a call");
  }
});

// ------------------------------------------------------------------------------------------------ B3
const TIMEOUT = "canceling statement due to statement timeout";
Deno.test("B3 a statement that times out is retried in halves; one that keeps timing out fails its board, never the lane", async () => {
  assert(transientStorageError(new Error(`touch postings: ${TIMEOUT}`)) && transientStorageError(new Error("read postings: TypeError: error sending request for url (https://x)")), "a timeout and an unsent request are transient");
  assert(!transientStorageError(new Error("read postings: relation does not exist")) && !transientStorageError(new Error("violates check constraint")), "a schema or data error is not");
  // The store: a write or touch over 10 rows times out; the halves go through.
  const admin = fakeAdmin({ fail: (op, n) => (op === "upsert" || op === "update") && n > 10 ? TIMEOUT : null });
  const db = supabasePostingsDb(admin);
  const at = new Date(T0).toISOString();
  const rows = Array.from({ length: 120 }, (_, i) => ({ job_id: `lever:acme:${i}`, provider: "lever", board: "acme", company: "Acme", title: "Clerk", url: `https://jobs.lever.co/acme/${i}`, description: words(i, 3000), first_seen_at: at, last_seen_at: at, closed_at: null }));
  await db.putMany(rows);
  eq(admin.writes.filter((w) => w.op === "upsert").reduce((a, w) => a + w.n, 0), 120, "every row written");
  assert(maxOf(admin.writes.filter((w) => w.op === "upsert").map((w) => w.n)) <= 10, "in parts no larger than went through");
  await db.touch(rows.map((r) => r.job_id), at);
  eq(admin.writes.filter((w) => w.op === "update").reduce((a, w) => a + w.n, 0), 120, "every row touched");
  // A single row that still times out fails.
  let threw = "";
  try { await halving([1, 2, 3], async () => { throw new Error(TIMEOUT); }); } catch (e) { threw = (e as Error).message; }
  eq(threw, TIMEOUT, "a lone row that times out is an error");
  // Batches: 50 rows or 1 MB of JSON, whichever first.
  const big = writeBatches(Array.from({ length: 300 }, (_, i) => ({ i, d: "x".repeat(19000) })));
  assert(big.every((c) => JSON.stringify(c).length <= 1_000_000 + 20000 && c.length <= 50), "write batches bounded by rows and bytes");
  // The run: board b2's writes always time out -> b2 failed with the reason; b1 and b3 written; the run goes on.
  const store = slimDb();
  const failing: PostingsDb = { ...store, putMany: async (ps) => { if (ps.some((p) => p.board === "b2")) throw new Error(`write postings: ${TIMEOUT}`); await store.putMany(ps); } };
  const boards: Board[] = ["b1", "b2", "b3"].map((b) => ({ company: b, provider: "lever", board: b }));
  const outcomes = new Map<string, BoardOutcome>();
  const st = await ingestBoards({ boards, db: failing, now: T0, useCursor: false, concurrency: 2, onBoard: (b, r) => outcomes.set(b.board, r),
    fetchFeed: boardFetchFeed((async (url: string) => streamed(() => leverBody(/postings\/(b\d)/.exec(url)![1], 150, 500))) as unknown as typeof fetch, { stream: true }) });
  eq([st.boards_ok, st.boards_failed, st.failures.map((f) => f.board)], [2, 1, ["b2"]], "one board failed, the lane did not");
  assert(/^storage: write postings: canceling statement/.test(st.failures[0].error), st.failures[0].error);
  eq([outcomes.get("b1")!.status, outcomes.get("b2")!.status, outcomes.get("b3")!.status], ["ok", "failed", "ok"]);
  eq([...store.rows.values()].filter((p) => p.board !== "b2").length, 300, "the other boards' postings are written");
  // A storage error that is not transient still fails the run (and the handler records it: B7).
  const broken: PostingsDb = { ...store, known: async () => { throw new Error("read postings: relation does not exist"); } };
  let runErr = "";
  try { await ingestBoards({ boards, db: broken, now: T0, useCursor: false, fetchFeed: boardFetchFeed((async () => streamed(() => leverBody("b1", 5, 100))) as unknown as typeof fetch, { stream: true }) }); }
  catch (e) { runErr = (e as Error).message; }
  eq(runErr, "read postings: relation does not exist");
});

// ------------------------------------------------------------------------------------------------ B4
Deno.test("B4 a board larger than the run's budget: read in parts over runs, never held whole, every posting stored once, closed when the pass ends", async () => {
  const N = 4600, BUDGET = 637, db = slimDb();
  let drop = new Set<number>(), edit = new Set<number>(), fetches = 0;
  const f = (async () => { fetches++; return streamed(() => leverBody("boxlunch", N, 2500, drop, edit)); }) as unknown as typeof fetch;
  const feed = boardFetchFeed(f, { stream: true, bodyHash: true });
  const b: Board = { company: "BoxLunch", provider: "lever", board: "boxlunch" };
  let state: { offset: number; pass_started_at: string | null } = { offset: 0, pass_started_at: null };
  streamProbe.maxHeldChars = 0;
  const run = async (at: number) => {
    let out: BoardOutcome | null = null;
    const st = await ingestBoards({ boards: [{ ...b, offset: state.offset, pass_started_at: state.pass_started_at }], db, now: at, useCursor: false, postingBudget: BUDGET, touchAfterMs: 6 * H, fetchFeed: feed, onBoard: (_b, r) => { out = r; } });
    const r = out as unknown as BoardOutcome;
    assert((st.postings_read ?? 0) <= BUDGET + INGEST_BATCH, `a run parsed ${st.postings_read} postings`);
    if (r.status === "failed") throw new Error(r.error);
    state = { offset: r.next_offset ?? 0, pass_started_at: r.next_offset ? r.pass_started_at! : null };
    return { st, r };
  };
  // Pass 1: every 5 minutes until the pass ends.
  let t = T0, runs = 0, first: BoardOutcome | null = null;
  do { const { r } = await run(t); first ??= r; t += 5 * MIN; runs++; } while (state.offset > 0 && runs < 20);
  eq([first!.status, first!.next_offset], ["partial", Math.ceil(BUDGET / INGEST_BATCH) * INGEST_BATCH - RESUME_OVERLAP], "the first part stops at the budget and says where the next starts");
  assert(runs >= 7 && runs <= 9, `pass 1 took ${runs} runs`);
  eq(db.rows.size, N, "every posting of the board stored, once");
  assert([...db.rows.values()].every((p) => !p.closed_at), "nothing closed by a part");
  assert(streamProbe.maxHeldChars <= WHOLE_MAX + CHUNK, `the most body ever held: ${streamProbe.maxHeldChars} characters (the body is ${(N * 5200 / 1e6).toFixed(0)}+ MB)`);
  assert(maxOf(db.calls.known) <= INGEST_BATCH && maxOf(db.calls.put) <= INGEST_BATCH, "every store call a batch");
  eq(db.calls.getMany, 0, "no whole row read back");
  // Pass 2, 7 hours on: 10 postings gone, 5 changed. The postings an earlier part saw are touched (older than 6 h).
  drop = new Set([3, 700, 701, 1500, 2222, 3000, 3001, 3002, 4000, 4599]); edit = new Set([10, 11, 2500, 2501, 4100]);
  t = T0 + 7 * H; runs = 0;
  const closedBefore = [...db.rows.values()].filter((p) => p.closed_at).length;
  do { await run(t); t += 5 * MIN; runs++; } while (state.offset > 0 && runs < 20);
  const closed = [...db.rows.values()].filter((p) => p.closed_at).map((p) => Number(p.job_id.split("-").at(-1))).sort((a, b) => a - b);
  eq([closedBefore, closed], [0, [...drop].sort((a, b) => a - b)], "the pass's end closes exactly what no part saw");
  const changed = [...edit].map((i) => db.rows.get(`lever:boxlunch:boxlunch-${i}`)!.last_seen_at);
  assert(changed.every((s) => Date.parse(s) >= T0 + 7 * H), "a changed posting is rewritten");
  assert(fetches >= 14, "one request per part");
});

// ------------------------------------------------------------------------------------------------ B5
Deno.test("B5 a lane like the largest: 112 boards x 300 postings with long descriptions + Workday boards with thousands; the run stops at its budget, every call bounded", async () => {
  const boards: Board[] = [
    ...Array.from({ length: 112 }, (_, i) => ({ company: `Clinic ${i}`, provider: "greenhouse", board: `clinic${i}` })),
    { company: "Keck Medicine of USC", provider: "workday", board: "usc.wd5/externalkeckusccareers" },
    { company: "CVS Health", provider: "workday", board: "cvshealth.wd1/CVS_Health_Careers" },
  ];
  const requests: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (/myworkdayjobs/.test(url)) { const q = JSON.parse(String(init?.body)); return new Response(workdayPage(/usc/.test(url) ? 3400 : 1495, q.offset, q.limit), { status: 200 }); }
    const m = /boards\/(clinic\d+)\//.exec(url)!;
    return streamed(() => greenhouseBody(m[1], 300, 5000));
  }) as unknown as typeof fetch;
  const db = slimDb();
  streamProbe.maxHeldChars = 0;
  const BUDGET = 3000;
  // Workday first (as a lane's oldest could be), then the clinics.
  const order = [boards[112], boards[113], ...boards.slice(0, 112)];
  const st = await ingestBoards({ boards: order, db, now: T0, useCursor: false, concurrency: 8, postingBudget: BUDGET, fetchFeed: boardFetchFeed(f, { stream: true, bodyHash: true }) });
  assert((st.postings_read ?? 0) <= BUDGET + 8 * INGEST_BATCH, `parsed ${st.postings_read}`);
  eq(st.stopped_by, "posting_budget", "boards left for the next run");
  assert(st.attempted < order.length, `${st.attempted} of ${order.length} boards started`);
  assert(maxOf(db.calls.known) <= INGEST_BATCH && maxOf(db.calls.put) <= INGEST_BATCH && maxOf(db.calls.touch) <= INGEST_BATCH, "every store call a batch");
  assert(maxOf(db.calls.putChars) < 4_000_000, `the largest write: ${maxOf(db.calls.putChars)} characters`);
  assert(streamProbe.maxHeldChars <= WHOLE_MAX + CHUNK, `the most body held at once: ${streamProbe.maxHeldChars}`);
  assert([...db.rows.keys()].some((k) => k.startsWith("workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---")), "Workday's long ids are stored");
  eq(st.boards_failed, 0, "nothing failed");
  // Run after run, every board of the lane is read (the budget moves work to the next tick; nothing is lost): boards not
  // started stay first, a board stopped inside goes to the back with its next offset, a finished one leaves.
  let left: Board[] = order, rounds = 0;
  while (left.length && rounds < 40) {
    const outcomes = new Map<string, BoardOutcome>();
    await ingestBoards({ boards: left, db, now: T0 + (rounds + 1) * 5 * MIN, useCursor: false, concurrency: 8, postingBudget: BUDGET,
      fetchFeed: boardFetchFeed(f, { stream: true, bodyHash: true }), onBoard: (b, r) => { outcomes.set(boardKey(b), r); } });
    assert([...outcomes.values()].every((r) => r.status !== "failed"), "no board failed");
    left = [...left.filter((b) => !outcomes.has(boardKey(b))),
      ...left.filter((b) => outcomes.get(boardKey(b))?.next_offset).map((b) => ({ ...b, offset: outcomes.get(boardKey(b))!.next_offset, pass_started_at: outcomes.get(boardKey(b))!.pass_started_at }))];
    rounds++;
  }
  eq(left.length, 0, `every board read within ${rounds} runs`);
  eq(db.rows.size, 112 * 300 + 1000 + 1000, "every posting (Workday past 1,000 is a partial read, as before)");
});

// ------------------------------------------------------------------------------------------------ B6
const FIXTURE_BODIES: Record<string, { board: string; body: string }> = {
  greenhouse: { board: "acme", body: [...greenhouseBody("acme", 7, 300)].join("") },
  lever: { board: "acme", body: [...leverBody("acme", 7, 300)].join("") },
  ashby: { board: "acme", body: JSON.stringify({ apiVersion: "1", jobs: Array.from({ length: 5 }, (_, i) => ({ id: `ash-${i}`, title: `Intern ${i}`, location: "New York, NY", jobUrl: `https://jobs.ashbyhq.com/acme/ash-${i}`, publishedAt: "2026-10-11T00:00:00Z", descriptionPlain: "Python." })) }) },
  workable: { board: "acme", body: JSON.stringify(FIX.workable) }, recruitee: { board: "acme", body: JSON.stringify(FIX.recruitee) },
  bamboohr: { board: "acme", body: JSON.stringify(FIX.bamboohr) }, breezy: { board: "acme", body: JSON.stringify(FIX.breezy) },
};
async function drain(r: FeedPosting[] | Awaited<ReturnType<ReturnType<typeof boardFetchFeed>>>): Promise<FeedPosting[]> {
  if (Array.isArray(r)) return r;
  if (!r.batches) return r.postings;
  const out: FeedPosting[] = [];
  for await (const b of r.batches) out.push(...b.postings);
  return out;
}
Deno.test("B6 the bounded read gives the same postings as the whole read for every JSON provider (whole, and streamed element by element); offsets skip; an XML feed past 8 MB fails with that reason", async () => {
  for (const [provider, { board, body }] of Object.entries(FIXTURE_BODIES)) {
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const b: Board = { company: "Acme", provider, board };
    const legacy = await drain(await boardFetchFeed(f)(b));
    assert(legacy.length > 0, `${provider}: the fixture reads`);
    eq(await drain(await boardFetchFeed(f, { stream: true })(b)), legacy, `${provider}: read whole`);
    eq(await drain(await boardFetchFeed(f, { stream: true, wholeMax: 16 })(b)), legacy, `${provider}: read as a stream`);
    if (legacy.length > 1) eq(await drain(await boardFetchFeed(f, { stream: true, wholeMax: 16 })({ ...b, offset: 1 })), legacy.slice(1), `${provider}: from offset 1`);
  }
  let err = "";
  try { await boardFetchFeed((async () => new Response(`<?xml version="1.0"?><rss><channel>${"<item><title>x</title></item>".repeat(Math.ceil(XML_MAX / 28) + 10)}</channel></rss>`)) as unknown as typeof fetch, { stream: true })({ company: "A", provider: "teamtailor", board: "acme" }); }
  catch (e) { err = (e as Error).message; }
  eq(err, "body over 8 MB: too large to read");
  // A body that is not the board's shape fails the board, streamed or not.
  for (const wholeMax of [undefined, 4]) {
    let e2 = "";
    try { await drain(await boardFetchFeed((async () => new Response(JSON.stringify({ error: "not found", detail: "x".repeat(40) }))) as unknown as typeof fetch, { stream: true, wholeMax })({ company: "A", provider: "greenhouse", board: "x" })); }
    catch (e) { e2 = (e as Error).message; }
    // Ingest round 2: read whole it used to be an empty board (every open posting closed); now both fail and close nothing.
    eq(e2, "not a greenhouse board (unexpected body)", wholeMax ? "streamed: no jobs array" : "whole: no jobs array");
  }
});

// ------------------------------------------------------------------------------------------------ B7
const SECRET = "f".repeat(40);
const envOf = (m: Record<string, string> = {}) => ({ get: (k: string) => ({ CAREER_INGEST_SECRET: SECRET, INGEST_CONTACT_EMAIL: "ops@example.test", ...m } as Record<string, string>)[k] });
const post = (q: string) => new Request(`https://fn.test/${q}`, { method: "POST", headers: { "x-trainee-ingest-secret": SECRET } });
Deno.test("B7 the handler: the run's row first, the claim before any read, outcomes as they come; a failed run records its error and hands back what it never reached", async () => {
  const boards: Board[] = Array.from({ length: 6 }, (_, i) => ({ company: `Acme ${i}`, provider: "lever", board: `acme${i}` }));
  const state = memoryBoardState();
  const events: string[] = [];
  const runs: { id: number; row: IngestRunRow | null; started: unknown }[] = [];
  const mem = memoryPostingsDb();
  const dbOf = (over: Partial<PostingsDb> = {}) => Object.assign(mem, over, {
    async recordRun() {},
    async startLaneRun(r: unknown) { events.push("start"); runs.push({ id: runs.length + 1, row: null, started: r }); return runs.length; },
    async finishLaneRun(id: number, row: IngestRunRow) { events.push(`finish:${row.status}`); runs[id - 1].row = row; },
  });
  let claimedAtFirstRead: string[] = [];
  const fetchFeed = () => async (b: Board) => {
    if (!events.includes("read")) { events.push("read"); claimedAtFirstRead = (await state.due(Array.from({ length: 64 }, (_, i) => i), 100)).map((s) => s.last_status ?? "null"); }
    return [{ job_id: `lever:${b.board}:1`, company: b.company, title: "Clerk", url: `https://jobs.lever.co/${b.board}/1` }];
  };
  const ok = await handleIngest(post("?lane=0&lanes=1&window_min=15"), { env: envOf({ INGEST_CONCURRENCY: "1" }), boards, now: () => T0, db: () => dbOf(), state: () => state, fetchFeed });
  eq(ok.status, 200);
  const due = (await ok.json()).shard.due;
  eq(events, ["start", "read", "finish:done"], "the row is written before any board is read, and completed after");
  assert(due >= 2 && claimedAtFirstRead.filter((s) => s === "reading").length === due, `every due board (${due}) claimed before the first read: ${claimedAtFirstRead}`);
  eq(runs[0].row!.boards_ok, due);
  // A run that fails (a storage error that is not transient) is recorded, with its error; boards it never reached go back.
  events.length = 0;
  const before = new Map((await state.due(Array.from({ length: 64 }, (_, i) => i), 100)).map((s) => [boardKey(s), s.last_attempt_at]));
  const failed = await handleIngest(post("?lane=0&lanes=1&window_min=15"), { env: envOf({ INGEST_CONCURRENCY: "1" }), boards, now: () => T0 + H, state: () => state, fetchFeed,
    db: () => dbOf({ getMany: async () => { throw new Error("read postings: relation does not exist"); } }) });
  eq(failed.status, 500);
  eq(events, ["start", "read", "finish:failed"], "a failed run completes its row as failed");
  const row = runs[1].row!;
  eq([row.status, row.error, row.lane, row.lanes], ["failed", "read postings: relation does not exist", 0, 1]);
  assert(/run failed: read postings: relation does not exist/.test(row.report), row.report);
  const after = await state.due(Array.from({ length: 64 }, (_, i) => i), 100);
  assert(after.every((s) => s.last_attempt_at === before.get(boardKey(s)) && s.last_status !== "reading"), "the boards the failed run never finished keep their place in the queue");
  // A store that cannot write a row at the start (before the migration) still gets one row at the end, failed or not.
  const legacyRows: IngestRunRow[] = [];
  const legacy = await handleIngest(post("?lane=0&lanes=1&window_min=15"), { env: envOf(), boards, now: () => T0 + 2 * H, state: () => memoryBoardState(), fetchFeed,
    db: () => Object.assign(memoryPostingsDb(), { async recordRun() {}, async recordLaneRun(r: IngestRunRow) { legacyRows.push(r); }, getMany: async () => { throw new Error("read postings: permission denied"); } }) });
  eq([legacy.status, legacyRows.length, legacyRows[0]?.status, legacyRows[0]?.error], [500, 1, "failed", "read postings: permission denied"], "a failed run's row, without a started row");
});

// ------------------------------------------------------------------------------------------------ B8
Deno.test({ name: "B8 the working set, measured: live memory after gc while a 4,600-posting board (~56 MB of JSON) streams through a run grows under 32 MB (under 16 MB at a budget)", sanitizeResources: false, sanitizeOps: false, async fn() {
  // The reader before this fix grew ~77 MB on the same board at the same sampling points (the probe's --before), more
  // between them (the parse itself is not sampled), and the live function ran up to 8 boards at once.
  const probe = new URL("./career-ingest-heap-probe.ts", import.meta.url).pathname;
  const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", "--v8-flags=--expose-gc", probe], stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout), err = new TextDecoder().decode(out.stderr);
  assert(out.code === 0, `the probe failed: ${err.slice(-800)}`);
  const r = JSON.parse(text.trim().split("\n").at(-1)!);
  assert(r.bodyMB > 50, `the board's body is ${r.bodyMB} MB`);
  eq([r.whole.stored, r.budget.stored], [4600, 1000], "the whole board, and what a budget of 1,000 allowed");
  assert(r.whole.growthMB < 32 && r.whole.samples > 100, `reading the whole board grew live memory ${r.whole.growthMB} MB over ${r.whole.samples} samples`);
  assert(r.budget.growthMB < 16, `a run at its budget grew ${r.budget.growthMB} MB`);
} });
