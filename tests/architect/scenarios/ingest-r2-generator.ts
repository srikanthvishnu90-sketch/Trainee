// INGEST ROUND 2 AT SCALE (2026-10-30): a seeded battery of ~10,000 scenarios for job ingest, the posting feed every job
// card, alert and Apply reads. The world (fake ATS boards for all eleven providers, a fake network, a store that refuses
// what Postgres refuses) is ingest-r2-world.ts; the end to end multi-run sequences on Postgres are
// tests/architect/ingest-r2-pg.test.ts. Five families:
//   read   one board read three times (a first good read, then one answer real boards give, then a good read again):
//          malformed JSON / XML, HTML with 200, the wrong JSON shape, 404 / 410 / 429 / 503 / 500 / a redirect,
//          a body still gzip-encoded, timeouts, a 304 and an unchanged body, huge bodies streamed in small chunks,
//          duplicate ids, titles and descriptions with HTML, scripts, RTL, emoji, NUL and broken surrogates, salaries
//          in many formats, remote and multi-location places, links on LinkedIn / Indeed / plain http
//   paging SmartRecruiters and Workday: clean pages, a list that moves between pages, a board that ignores the offset,
//          past the page cap, an id twice on one page
//   pay    the board's structured pay written as it says: ranges stay ranges, cents stay, the currency is the board's
//   life   the scheduled handler over several boards and runs: adds, removals, reposts, reopenings, outages, a board that
//          is gone (404 / 410), malformed answers, a board renamed in the directory, a schedule re-planned across lanes
//   race   two runs of one lane at once, a run killed mid-way, a run whose clock is behind, statement timeouts, a store
//          failure that ends the run, a lane whose boards all fail
// Invariants: after a successful complete read a board's open postings are exactly what the board lists (no ghost, none
// lost); a posting is closed exactly when gone; a failed or partial read closes nothing; first_seen_at never moves; every
// stored text is text Postgres stores; nothing is invented (pay, place, date only from the source, never reworded); the run
// log says what happened (failures recorded, counts equal to what changed in the table); a failing board is not read
// every window for ever.
import { boardFetchFeed, boardPay, GONE_AFTER, ingestBoards, type Board, type BoardOutcome, type FetchFeed, type IngestRunRow, type IngestStats, type Posting } from "../../../supabase/functions/_shared/career_ingest.ts";
import { streamProbe } from "../../../supabase/functions/_shared/career_ingest_stream.ts";
import { boardKey, memoryBoardState, type BoardState } from "../../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../../supabase/functions/career-ingest/handler.ts";
import { wantsFrom } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { screenPosting } from "../../../supabase/functions/_shared/career_apply_screen.ts";
import { atsId, cleanText, fakeFetch, render, JSON_ONE_REQUEST, jobIdOf, keepable, makeJob, OWN_LINK, pgLikeDb, PROVIDERS, rng, XML,
  type Answer, type Job, type Net, type Pay, type PgLike, type Provider, type Rng } from "./ingest-r2-world.ts";

export const T0 = Date.UTC(2026, 9, 30, 6, 2), MIN = 60000, H = 3600000;
const iso = (t: number) => new Date(t).toISOString();

// ------------------------------------------------------------------------------------------------ the scenarios
export interface ReadScenario { id: string; seed: number; provider: Provider; answer: string; wholeMax: number }
export interface PagingScenario { id: string; seed: number; provider: "smartrecruiters" | "workday"; mode: "clean" | "shift" | "loop" | "over_cap" | "dupe_in_page" | "dupe_across_pages" }
export interface PayScenario { id: string; seed: number; provider: "greenhouse" | "lever" | "ashby" }
export interface LifeScenario { id: string; seed: number; boards: number; runs: number; replan: boolean }
export interface RaceScenario { id: string; seed: number; kind: "two_runs" | "killed" | "skew" | "timeouts" | "store_down" | "all_fail" }
export type Family = "read" | "paging" | "pay" | "life" | "race";

// The answers a board gives on the second read, by family of provider.
export const READ_ANSWERS = ["list_changed", "list_same", "list_empty", "list_dupes", "not_modified", "malformed", "html_200", "wrong_shape",
  "http_404", "http_410", "http_429", "http_503", "http_500", "redirect", "gzip", "timeout", "network", "huge", "truncated"] as const;
export const COUNTS = { read: 7524, paging: 600, pay: 900, life: 1260, race: 360 };
export function generate() {
  const read: ReadScenario[] = [], paging: PagingScenario[] = [], pay: PayScenario[] = [], life: LifeScenario[] = [], race: RaceScenario[] = [];
  const r = rng(20261030);
  for (let i = 0; i < COUNTS.read; i++) {
    const provider = PROVIDERS[i % PROVIDERS.length], answer = READ_ANSWERS[Math.floor(i / PROVIDERS.length) % READ_ANSWERS.length];
    read.push({ id: `read-${i}`, seed: r.int(1, 2 ** 31), provider, answer, wholeMax: r.chance(0.5) ? r.int(64, 4096) : 2_000_000 });
  }
  const pmodes = ["clean", "shift", "loop", "over_cap", "dupe_in_page", "dupe_across_pages"] as const;
  for (let i = 0; i < COUNTS.paging; i++) paging.push({ id: `paging-${i}`, seed: r.int(1, 2 ** 31), provider: i % 2 ? "workday" : "smartrecruiters", mode: pmodes[Math.floor(i / 2) % pmodes.length] });
  for (let i = 0; i < COUNTS.pay; i++) pay.push({ id: `pay-${i}`, seed: r.int(1, 2 ** 31), provider: (["greenhouse", "lever", "ashby"] as const)[i % 3] });
  for (let i = 0; i < COUNTS.life; i++) life.push({ id: `life-${i}`, seed: r.int(1, 2 ** 31), boards: r.int(2, 6), runs: r.int(4, 9), replan: r.chance(0.2) });
  const rk = ["two_runs", "killed", "skew", "timeouts", "store_down", "all_fail"] as const;
  for (let i = 0; i < COUNTS.race; i++) race.push({ id: `race-${i}`, seed: r.int(1, 2 ** 31), kind: rk[i % rk.length] });
  return { read, paging, pay, life, race };
}

// ------------------------------------------------------------------------------------------------ grading
export function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x?.slice(0, 500)}\n  want: ${y?.slice(0, 500)}`); }
export function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
export async function grade<S extends { id: string }>(name: string, xs: S[], run: (s: S) => Promise<void>) {
  const fails: string[] = [];
  for (const s of xs) { try { await run(s); } catch (e) { fails.push(`${s.id} ${JSON.stringify(s)}: ${(e as Error).message}`); } }
  if (fails.length) throw new Error(`${name}: ${fails.length} of ${xs.length} scenarios failed\n${fails.slice(0, 8).join("\n")}`);
}

// ------------------------------------------------------------------------------------------------ oracles
// The ids ingest keeps from a board's list: in order, each id once (the first entry that can be kept), only jobs with a
// title and an https link.
export function expectedIds(p: Provider, board: string, jobs: Job[]): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const j of jobs) {
    if (!keepable(p, j)) continue;
    const id = jobIdOf(p, board, j.dupeOf ?? j.n);
    if (seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
}
const sorted = (xs: Iterable<string>) => [...xs].sort();
const WELL_FORMED = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
// Every stored row: what Postgres stores, inside the table's limits, first seen never after last seen.
export function checkRow(p: Posting) {
  for (const k of ["title", "company", "location", "description", "department", "url", "pay", "job_id"] as const) {
    const v = (p as any)[k];
    if (typeof v === "string") ok(WELL_FORMED(v), `${p.job_id}: ${k} is not storable text: ${JSON.stringify(v.slice(0, 80))}`);
  }
  ok(p.title.length >= 1 && p.title.length <= 500, `${p.job_id}: title length ${p.title.length}`);
  ok((p.description ?? "").length <= 20000, `${p.job_id}: description length`);
  ok(/^https:\/\//.test(p.url) && !/\s/.test(p.url), `${p.job_id}: url ${p.url}`);
  ok(Date.parse(p.last_seen_at) >= Date.parse(p.first_seen_at), `${p.job_id}: last seen before first seen`);
}
// A source text and what was stored: a clean text is stored as it is (no reword); any text never gains a word.
function sameText(src: string, stored: string, what: string, limit: number) {
  const c = cleanText(src);
  if (c === src && src.length <= limit) eq(stored, src, `${what}: a clean text is stored as the board wrote it`);
  else ok(stored.length <= limit && WELL_FORMED(stored), `${what}: stored text within its limit and storable`);
}
// Structured pay as the board states it (WO-069; round 2: cents kept, no currency invented, a range stays a range).
export function checkPay(provider: "greenhouse" | "lever", pay: Pay | null | undefined, stored: string | null | undefined) {
  if (!pay) { eq(stored ?? null, null, "no pay stated: none stored"); return; }
  const scale = provider === "greenhouse" ? 100 : 1;
  const lo = pay.min / scale, hi = pay.max / scale, cur = pay.currency.trim().toUpperCase();
  const validCur = cur === "" || /^[A-Z]{3}$/.test(cur);
  if (!validCur || (lo < 1 && hi < 1) || hi < lo) { eq(stored ?? null, null, `pay ${JSON.stringify(pay)}: nothing a board's figures say for sure: none stored`); return; }
  ok(typeof stored === "string" && stored.length > 0, `pay ${JSON.stringify(pay)}: stored`);
  const s = stored!;
  if (cur !== "USD") ok(!s.includes("$"), `pay ${JSON.stringify(pay)} -> ${s}: dollars the board never said`);
  if (cur && cur !== "USD") ok(s.includes(cur), `pay ${JSON.stringify(pay)} -> ${s}: its currency kept`);
  const fig = (n: number) => (Math.round(n * 100) % 100 === 0 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (lo >= 1) ok(s.includes(fig(lo)), `pay ${JSON.stringify(pay)} -> ${s}: the low figure ${fig(lo)} as stated`);
  if (hi >= 1) ok(s.includes(fig(hi)), `pay ${JSON.stringify(pay)} -> ${s}: the high figure ${fig(hi)} as stated`);
  if (lo >= 1 && hi >= 1 && fig(lo) !== fig(hi)) ok(s.includes("–"), `pay ${JSON.stringify(pay)} -> ${s}: a range stays a range`);
  if (provider === "lever" && pay.interval) { const u = /^per-(year|month|week|day|hour)/.exec(pay.interval)?.[1]; if (u) ok(s.endsWith(`per ${u}`), `pay ${s}: its period`); }
}

// ------------------------------------------------------------------------------------------------ read
const nextJobs = (r: Rng, p: Provider, from: number, n: number, dirty?: boolean) => Array.from({ length: n }, (_, i) => makeJob(r, from + i, p, { dirty }));
function boardName(p: Provider, r: Rng) { return p === "workday" ? `acme${r.int(1, 99)}.wd${r.int(1, 12)}/External_Careers` : `acme${r.int(1, 9999)}`; }
function feedOf(net: Net, r: Rng, wholeMax: number): FetchFeed { return boardFetchFeed(fakeFetch(net, r), { stream: true, bodyHash: true, wholeMax, userAgent: "Trainee job alerts (contact: test)" }); }

export async function runRead(s: ReadScenario) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { calls: [], answer: new Map() }, db = pgLikeDb(), feed = feedOf(net, r, s.wholeMax);
  const B: Board = { company: "Acme", provider: p, board };
  const outcomes: BoardOutcome[] = [];
  const read = async (b: Board, at: number) => { net.calls.length = 0; return await ingestBoards({ boards: [b], db, now: at, useCursor: false, fetchFeed: feed, touchAfterMs: 6 * H, onBoard: (_b, o) => { outcomes.push(o); } }); };
  const openIds = async () => sorted((await db.open()).filter((x) => x.provider === p && x.board === board).map((x) => x.job_id));

  // 1. a good first read
  const A = nextJobs(r, p, 0, r.int(1, 30));
  net.answer.set(key, { kind: "list", jobs: A, etag: r.chance(0.5) ? `"e${s.seed}"` : undefined });
  const st1 = await read(B, T0);
  const o1 = outcomes.at(-1)!;
  eq(o1.status, "ok", `${s.id} first read`);
  const exp1 = expectedIds(p, board, A);
  eq(await openIds(), sorted(exp1), "first read: the board's postings, exactly");
  eq([st1.new, st1.closed, st1.boards_failed, st1.url_rejected ?? 0], [exp1.length, 0, 0, 0], "first read counts");
  const first = new Map((await db.all()).map((x) => [x.job_id, x]));
  for (const x of first.values()) checkRow(x);
  checkFields(p, board, A, first);

  // 2. the answer under test
  const B2: Board = { ...B, etag: o1.etag ?? null, last_modified: o1.last_modified ?? null, body_sha: o1.body_sha ?? null };
  let jobs2: Job[] | null = null; // the board's list when the answer is one
  let a: Answer;
  switch (s.answer) {
    case "list_changed": {
      const keep = A.filter(() => r.chance(0.7));
      jobs2 = [...keep, ...nextJobs(r, p, 100, r.int(1, 10))];
      if (r.chance(0.5)) jobs2.reverse();
      a = { kind: "list", jobs: jobs2 }; break;
    }
    case "list_same": jobs2 = A; a = { kind: "list", jobs: A }; break;
    case "list_empty": jobs2 = []; a = { kind: "list", jobs: [] }; break;
    case "list_dupes": {
      const base = nextJobs(r, p, 200, r.int(2, 12), false);
      const dupes = base.filter(() => r.chance(0.4)).map((j, i) => ({ ...j, n: 900 + i, dupeOf: j.n, title: j.title + " (again)" }));
      jobs2 = [...base, ...dupes]; a = { kind: "list", jobs: jobs2 }; break;
    }
    case "not_modified": a = B2.etag ? { kind: "list", jobs: A, etag: B2.etag } : { kind: "list", jobs: A }; jobs2 = A; break;
    case "malformed": a = XML.includes(p) ? { kind: "body", body: `<?xml version="1.0"?><rss><channel><item><title>cut off`, status: 200 } : { kind: "body", body: `{"jobs":[{"id":1,"title":"Nurse"`, status: 200 }; break;
    case "html_200": a = { kind: "body", body: "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Please log in to continue</body></html>", status: 200, contentType: "text/html" }; break;
    case "wrong_shape": a = { kind: "body", body: r.pick(["{}", "null", '{"jobs":null}', '{"error":"rate limited","status":429}', '{"ok":false,"error":"Document not found"}', "[]x", '"jobs"', "42", '{"offers":"none"}', '{"jobPostings":{}}']), status: 200 }; break;
    case "http_404": a = { kind: "status", status: 404, body: '{"status":404,"error":"Not found"}' }; break;
    case "http_410": a = { kind: "status", status: 410, body: "Gone" }; break;
    case "http_429": a = { kind: "status", status: 429, body: "Too Many Requests", headers: { "retry-after": String(r.int(1, 3600)) } }; break;
    case "http_503": a = { kind: "status", status: 503, body: "<html>Service Unavailable</html>", headers: { "retry-after": "120" } }; break;
    case "http_500": a = { kind: "status", status: 500, body: "Internal Server Error" }; break;
    case "redirect": a = r.chance(0.5) ? { kind: "status", status: 301, headers: { location: "https://example.com/careers" } } : { kind: "body", body: "<html><body>Moved to our new careers site</body></html>", status: 200, contentType: "text/html" }; break;
    case "gzip": a = { kind: "gzip", jobs: A }; break;
    case "timeout": a = { kind: "throw", error: "The signal has been aborted", name: "TimeoutError" }; break;
    case "network": a = { kind: "throw", error: "error sending request for url: connection reset" }; break;
    case "truncated": {
      // The board's real list cut off mid-way, ending cleanly (a proxy that cut the body): never a complete read.
      const full = render(p, board, [...A, ...nextJobs(r, p, 400, r.int(5, 40))]);
      a = { kind: "body", body: full.slice(0, r.int(Math.floor(full.length * 0.3), full.length - 3)), status: 200, chunk: r.int(16, 2048) }; break;
    }
    case "huge": jobs2 = nextJobs(r, p, 300, p === "smartrecruiters" ? 250 : p === "workday" ? 300 : r.int(120, 400)); a = { kind: "list", jobs: jobs2, chunk: r.int(7, 4096) }; break;
  }
  const allBefore = new Map((await db.all()).map((x) => [x.job_id, x]));
  const openBefore = await openIds();
  net.answer.set(key, a!);
  streamProbe.maxHeldChars = 0;
  const st2 = await read(B2, T0 + 7 * H);
  const o2 = outcomes.at(-1)!;
  const open2 = await openIds();
  if (jobs2) {
    const exp2 = expectedIds(p, board, jobs2);
    if (o2.status === "not_modified") {
      ok(s.answer === "list_same" || s.answer === "not_modified", `${s.answer}: not modified only when nothing changed`);
      eq(open2, openBefore, "not modified: nothing changes");
    } else {
      eq(o2.status, "ok", `${s.answer}: a good read (${o2.error ?? ""})`);
      eq(open2, sorted(exp2), `${s.answer}: the board's postings, exactly (no ghost, none lost)`);
      const gone = openBefore.filter((id) => !exp2.includes(id));
      eq(st2.closed, gone.length, `${s.answer}: closed exactly the postings gone`);
      eq(st2.new, exp2.filter((id) => !allBefore.has(id)).length, `${s.answer}: new is what was never seen`);
      eq(st2.seen + st2.reopened, exp2.filter((id) => allBefore.has(id)).length, `${s.answer}: seen again`);
      if (s.answer === "list_empty" && openBefore.length >= 20 && openBefore.length > 0) ok(st2.large_closes.length === 1, "a board emptied is reported as a large close");
      if (s.wholeMax < 2_000_000 && JSON_ONE_REQUEST.includes(p)) {
        const biggest = Math.max(0, ...jobs2.map((j) => JSON.stringify(j).length * 3 + 2000));
        ok(streamProbe.maxHeldChars <= s.wholeMax + 70000 + biggest, `bounded read held ${streamProbe.maxHeldChars} chars`);
      }
    }
    const all2 = new Map((await db.all()).map((x) => [x.job_id, x]));
    if (o2.status === "ok") checkFields(p, board, jobs2, all2);
  } else {
    eq(o2.status, "failed", `${s.answer}: the read fails`);
    ok(typeof o2.error === "string" && o2.error.length > 0, "the failure says why");
    eq(st2.failures.length, 1, "the failure recorded once");
    eq(st2.closed, 0, `${s.answer}: a failed read closes nothing`);
    eq(open2, openBefore, `${s.answer}: the board's postings stay as they were`);
    if (s.answer === "http_404" || s.answer === "http_410") eq(o2.gone_reads, 1, "the first gone answer counted");
    else ok(!o2.gone_reads, "only 404 / 410 count toward gone");
  }
  // 3. a good read again: the board's postings, exactly; first seen never moved
  const C = [...A.filter(() => r.chance(0.5)), ...nextJobs(r, p, 1000, r.int(0, 8))];
  net.answer.set(key, { kind: "list", jobs: C });
  const st3 = await read({ ...B, etag: null, last_modified: null, body_sha: null }, T0 + 14 * H);
  eq(outcomes.at(-1)!.status, "ok", "third read");
  eq(await openIds(), sorted(expectedIds(p, board, C)), "third read: the board's postings, exactly");
  eq(st3.failures.length, 0, "third read has no failure");
  for (const x of await db.all()) {
    checkRow(x);
    const was = first.get(x.job_id);
    if (was) eq(x.first_seen_at, was.first_seen_at, `${x.job_id}: first seen never moves`);
  }
  eq(db.refused, [], "nothing ingest wrote was refused by the table");
}

// What each kept posting says, against what its board said: title, place, pay, date, link, never invented or reworded.
function checkFields(p: Provider, board: string, jobs: Job[], rows: Map<string, Posting>) {
  const firstOf = new Map<string, Job>();
  for (const j of jobs) { if (!keepable(p, j)) continue; const id = jobIdOf(p, board, j.dupeOf ?? j.n); if (!firstOf.has(id)) firstOf.set(id, j); }
  for (const [id, j] of firstOf) {
    const x = rows.get(id);
    ok(x, `${id} stored`);
    sameText(j.title, x.title, `${id} title`, 500);
    if (["greenhouse", "lever", "recruitee"].includes(p)) sameText(j.location, x.location ?? "", `${id} location`, 1000);
    if (p === "ashby") { if (cleanText(j.location)) sameText(j.location, x.location ?? "", `${id} location`, 1000); else eq(x.location, "Location not stated", `${id}: no place stated is said so, never guessed`); }
    if (p === "greenhouse" || p === "lever") checkPay(p, j.pay, x.pay);
    else if (p === "ashby") { if (j.payText) eq(x.pay, cleanText(j.payText), `${id}: Ashby's pay text as the board wrote it`); else eq(x.pay ?? null, null, `${id}: no pay`); }
    else eq(x.pay ?? null, null, `${id}: a board with no structured pay has none stored`);
    if (p === "greenhouse" || p === "lever") {
      const src = j.posted;
      const t = typeof src === "number" ? src : src ? Date.parse(src) : NaN;
      eq(x.posted_at ?? null, Number.isFinite(t) ? iso(t) : null, `${id}: posted at the instant the board says, or none`);
    }
    if (OWN_LINK.includes(p) && (j.link === "linkedin" || j.link === "indeed")) {
      ok(/linkedin\.com|indeed\.com/.test(x.url), `${id}: the board's own link kept`);
      const w = wantsFrom([{ url: x.url, company: x.company, title: x.title }], T0);
      eq(w.ok.length, 0, `${id}: a LinkedIn / Indeed link is never queued to apply`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ paging
export async function runPaging(s: PagingScenario) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { calls: [], answer: new Map() }, db = pgLikeDb(), feed = feedOf(net, r, 2_000_000);
  const B: Board = { company: "Acme", provider: p, board };
  const size = p === "workday" ? 20 : 100, cap = p === "workday" ? 1000 : 1000;
  const n = s.mode === "over_cap" ? cap + r.int(1, 60) : r.int(size * 2, size * 4); // the second read spans pages too
  const A = nextJobs(r, p, 0, n, false);
  const outcomes: BoardOutcome[] = [];
  net.answer.set(key, { kind: "list", jobs: A });
  const st1 = await ingestBoards({ boards: [B], db, now: T0, useCursor: false, fetchFeed: feed, onBoard: (_b, o) => { outcomes.push(o); } });
  const opened = sorted((await db.open()).map((x) => x.job_id));
  if (s.mode === "over_cap") { eq(outcomes[0].status, "partial", "past the page cap: a partial read"); eq(opened.length, cap, "the first pages kept"); }
  else eq(opened, sorted(expectedIds(p, board, A)), "every page read");
  eq(st1.closed, 0, "first read closes nothing");
  // The second read, the mode under test.
  let a: Answer, closes = true;
  const B2 = A.filter((_, i) => i % 7 !== 3);
  switch (s.mode) {
    case "clean": a = { kind: "list", jobs: B2 }; break;
    case "shift": a = { kind: "list", jobs: B2, shift: makeJob(r, 5000, p, { dirty: false }) }; closes = false; break;
    case "loop": a = { kind: "list", jobs: B2, loop: true }; closes = false; break;
    case "over_cap": a = { kind: "list", jobs: B2 }; closes = B2.length < cap; break;
    case "dupe_in_page": { const d = { ...B2[1], n: 7777, dupeOf: B2[1].dupeOf ?? B2[1].n }; a = { kind: "list", jobs: [B2[0], B2[1], d, ...B2.slice(2)] }; break; }
    case "dupe_across_pages": { const d = { ...B2[0], n: 7778, dupeOf: B2[0].n }; a = { kind: "list", jobs: [...B2.slice(0, size + 3), d, ...B2.slice(size + 3)] }; closes = false; break; }
  }
  const before = sorted((await db.open()).map((x) => x.job_id));
  net.answer.set(key, a);
  const st2 = await ingestBoards({ boards: [B], db, now: T0 + 7 * H, useCursor: false, fetchFeed: feed, onBoard: (_b, o) => { outcomes.push(o); } });
  const after = sorted((await db.open()).map((x) => x.job_id));
  if (closes) {
    eq(outcomes.at(-1)!.status, "ok", `${s.mode}: a complete read`);
    eq(after, sorted(expectedIds(p, board, (a as any).jobs)), `${s.mode}: the board's postings, exactly`);
  } else {
    eq(outcomes.at(-1)!.status, "partial", `${s.mode}: the list moved or looped or was cut: a partial read`);
    eq(st2.closed, 0, `${s.mode}: a partial read closes nothing`);
    for (const id of before) ok(after.includes(id), `${s.mode}: ${id} not closed`);
  }
  for (const x of await db.all()) checkRow(x);
}

// ------------------------------------------------------------------------------------------------ pay
const CURS = ["USD", "EUR", "GBP", "usd", "", "€", "$", "US Dollars", "JPY", "INR", "CAD", " eur "];
export async function runPay(s: PayScenario) {
  const r = rng(s.seed);
  if (s.provider === "ashby") {
    const text = r.pick(["$120K – $150K", "€55,000–€65,000 per year", "£18.50 per hour", "DOE", "Competitive salary", "₹12 LPA – ₹18 LPA", "CHF 110'000 – 130'000", "$90K - $110K • Offers Equity", "  $1,000\n per week  "]);
    const got = boardPay("ashby", { compensation: { compensationTierSummary: text } });
    eq(got, cleanText(text), "Ashby's own summary is stored as written (normalization never changes its meaning)");
    return;
  }
  const cents = r.chance(0.4);
  const unit = s.provider === "greenhouse" ? 100 : 1;
  const lo = cents ? r.int(800, 9999) / 100 : r.int(1, 400) * 1000, hi = r.chance(0.15) ? lo : r.chance(0.1) ? lo / 2 : lo + (cents ? r.int(1, 2000) / 100 : r.int(1, 100) * 1000);
  const pay: Pay = { min: Math.round(lo * unit * 100) / 100, max: Math.round(hi * unit * 100) / 100, currency: r.pick(CURS), interval: r.pick(["per-year-salary", "per-hour-wage", "per-month-salary", "one-time", ""]), title: r.pick(["", "US", "Zone A:", "Hourly"]) };
  if (r.chance(0.05)) pay.min = 0;
  const raw = s.provider === "greenhouse" ? { pay_input_ranges: [{ min_cents: pay.min, max_cents: pay.max, currency_type: pay.currency, title: pay.title }] }
    : { salaryRange: { min: pay.min, max: pay.max, currency: pay.currency, interval: pay.interval } };
  const got = boardPay(s.provider, raw);
  // The oracle reads the currency as the board wrote it, trimmed (" eur " is EUR); a symbol or a word is not a currency code.
  checkPay(s.provider, { ...pay, currency: pay.currency.trim() }, got);
}

// ------------------------------------------------------------------------------------------------ the scheduled handler
export const SECRET = () => ["s", "e", "c"].join("").repeat(14); // built at run time, 42 characters
interface Runs { rows: (IngestRunRow & { id: number; status?: string })[] }
export function handlerDeps(o: { boards: () => Board[]; db: PgLike; state: ReturnType<typeof memoryBoardState>; feed: FetchFeed; at: () => number; runs: Runs; env?: Record<string, string> }) {
  const env: Record<string, string> = { CAREER_INGEST_SECRET: SECRET(), INGEST_CONTACT_EMAIL: "ops@example.test", INGEST_EVERY_MIN: "15", INGEST_CONCURRENCY: "4", ...(o.env ?? {}) };
  const store = Object.assign(o.db, {
    async recordRun(_s: IngestStats, _at: string) {},
    async startLaneRun(r: { at: string; lane: number; lanes: number; window_min: number }) { const id = o.runs.rows.length + 1; o.runs.rows.push({ id, ...r, status: "started" } as any); return id; },
    async finishLaneRun(id: number, row: IngestRunRow) { Object.assign(o.runs.rows[id - 1], row); },
  });
  return { env: { get: (k: string) => env[k] }, boards: o.boards(), now: o.at, db: () => store, state: () => o.state, fetchFeed: () => o.feed };
}
export const post = (lane: number, lanes: number, q = "") => new Request(`https://fn.test/?lane=${lane}&lanes=${lanes}&window_min=15${q}`, { method: "POST", headers: { "x-trainee-ingest-secret": SECRET() } });

// ------------------------------------------------------------------------------------------------ life
interface World { p: Provider; board: string; company: string; jobs: Job[]; removed: Job[]; next: number; mode: string; gone: number; fails: number; lastAttempt: number | null; renamedFrom?: string; alive: boolean }
const waitMs = (f: number) => (f < 2 ? 0 : Math.min(24 * H, 2 ** (f - 2) * H));
export async function runLife(s: LifeScenario) {
  const r = rng(s.seed);
  const net: Net = { calls: [], answer: new Map() }, db = pgLikeDb(), state = memoryBoardState(), runs: Runs = { rows: [] };
  const feed = boardFetchFeed(fakeFetch(net, r), { stream: true, bodyHash: true, wholeMax: r.chance(0.5) ? 512 : 2_000_000 });
  const worlds: World[] = [];
  for (let i = 0; i < s.boards; i++) {
    const p = r.pick(PROVIDERS), board = p === "workday" ? `co${i}x${r.int(1, 99)}.wd5/Careers` : `co${i}x${r.int(1, 999)}`;
    if (worlds.some((w) => boardKey({ provider: w.p, board: w.board }) === boardKey({ provider: p, board }))) continue;
    worlds.push({ p, board, company: `Co ${i}`, jobs: nextJobs(r, p, 0, r.int(1, 25)), removed: [], next: 100, mode: "list", gone: 0, fails: 0, lastAttempt: null, alive: true });
  }
  let directory: Board[] = worlds.map((w) => ({ company: w.company, provider: w.p, board: w.board }));
  const k = (w: World) => `${w.p}:${w.board.toLowerCase()}`;
  const firstSeen = new Map<string, string>();
  const oneJobOnTwoBoards = r.chance(0.3);
  for (let run = 0; run < s.runs; run++) {
    const at = T0 + run * 61 * MIN;
    // Each live board's answer this run.
    for (const w of worlds.filter((x) => x.alive)) {
      const m = run === 0 ? "list" : r.pick(["list", "list", "same", "add", "remove", "repost", "reopen", "down", "gone", "gone", "bad", "rename"] as const);
      w.mode = m;
      if (m === "add") w.jobs.push(...nextJobs(r, w.p, w.next += 50, r.int(1, 5)));
      if (m === "remove" && w.jobs.length) { const out = w.jobs.splice(r.int(0, w.jobs.length - 1), r.int(1, 3)); w.removed.push(...out); }
      if (m === "repost" && w.jobs.length) { const old = w.jobs.shift()!; w.removed.push(old); w.jobs.push({ ...old, n: w.next += 50 }); }
      if (m === "reopen" && w.removed.length) w.jobs.push(w.removed.shift()!);
      if (oneJobOnTwoBoards && worlds.length > 1 && w === worlds[1] && worlds[0].jobs[0] && (m === "add" || run === 0)) w.jobs.push({ ...worlds[0].jobs[0], n: w.next += 50 }); // the same job, the other board's id
      if (m === "rename") {
        // The directory names the board anew (a new token); the old one leaves.
        w.alive = false;
        const nb = w.p === "workday" ? w.board.replace(/\.wd5/, "n.wd5") : `${w.board}n`;
        const nw: World = { ...w, board: nb, jobs: w.jobs.map((j) => ({ ...j })), removed: [], mode: "list", gone: 0, fails: 0, lastAttempt: null, renamedFrom: w.board, alive: true };
        worlds.push(nw);
        directory = directory.filter((b) => !(b.provider === w.p && b.board === w.board)).concat([{ company: nw.company, provider: nw.p, board: nw.board }]);
        net.answer.set(k(nw), { kind: "list", jobs: nw.jobs });
      }
      const ans: Answer = m === "down" ? r.pick([{ kind: "status", status: 503 }, { kind: "status", status: 429 }, { kind: "throw", error: "timed out after 15s", name: "TimeoutError" }] as Answer[])
        : m === "gone" ? { kind: "status", status: r.pick([404, 410]) }
        : m === "bad" ? { kind: "body", body: r.pick(["<html>Maintenance</html>", "{}", "null", "{\"jobs\":"]) }
        : { kind: "list", jobs: w.jobs };
      if (m !== "rename") net.answer.set(k(w), ans);
    }
    const prevOpen = new Map<string, Set<string>>();
    for (const w of worlds) prevOpen.set(k(w), new Set((await db.open()).filter((x) => x.provider === w.p && x.board === w.board).map((x) => x.job_id)));
    const allBefore = new Map((await db.all()).map((x) => [x.job_id, x]));
    // Which boards the run should read: in the directory, not in a backoff.
    const dir = directory;
    const due = worlds.filter((w) => (w.alive || dir.some((b) => boardKey(b) === boardKey({ provider: w.p, board: w.board }))) && (w.lastAttempt === null || at - w.lastAttempt >= waitMs(w.fails)));
    net.calls.length = 0;
    const lanes = s.replan && run % 2 === 1 ? 2 : 1;
    const startRows = runs.rows.length;
    for (let lane = 0; lane < lanes; lane++) {
      const res = await handleIngest(post(lane, lanes), handlerDeps({ boards: () => dir, db, state, feed, at: () => at, runs }) as any);
      ok(res.status === 200, `run ${run} lane ${lane}: ${res.status} ${await res.clone().text()}`);
    }
    const read = new Set(net.calls.map((c) => c.board));
    // A failing board is not read inside its backoff; a due live board is read.
    for (const w of worlds) {
      const wasDue = due.includes(w);
      if (!w.alive && w.renamedFrom === undefined && !dir.some((b) => boardKey(b) === boardKey({ provider: w.p, board: w.board }))) { ok(!read.has(k(w)), `${k(w)} left the directory: not read`); continue; }
      if (!w.alive) continue;
      const newlySeeded = w.renamedFrom !== undefined && w.lastAttempt === null && !state.rows.get(boardKey({ provider: w.p, board: w.board }))?.last_attempt_at && !read.has(k(w));
      if (wasDue && !newlySeeded) ok(read.has(k(w)) || (w.renamedFrom !== undefined && w.lastAttempt === null), `run ${run}: ${k(w)} due and not read (fails ${w.fails})`);
      if (!wasDue) ok(!read.has(k(w)), `run ${run}: ${k(w)} read inside its backoff (fails ${w.fails}, last ${w.lastAttempt && iso(w.lastAttempt)})`);
    }
    // Each board's postings after the run.
    const openNow = async (w: World) => sorted((await db.open()).filter((x) => x.provider === w.p && x.board === w.board).map((x) => x.job_id));
    for (const w of worlds) {
      const wasRead = read.has(k(w)), before = sorted(prevOpen.get(k(w)) ?? []);
      const now = await openNow(w);
      if (!w.alive) {
        // Renamed away: once its stale row was taken, its postings are closed.
        if (w.renamedFrom === undefined && !dir.some((b) => boardKey(b) === boardKey({ provider: w.p, board: w.board }))) {
          if (!state.rows.has(boardKey({ provider: w.p, board: w.board }))) eq(now, [], `${k(w)} left the directory: its postings closed`);
        }
        continue;
      }
      if (!wasRead) { eq(now, before, `${k(w)} not read: nothing changes`); continue; }
      w.lastAttempt = at;
      const m = w.mode;
      if (m === "down" || m === "bad") { w.fails++; w.gone = 0; eq(now, before, `${k(w)} ${m}: a failed read closes nothing`); }
      else if (m === "gone") {
        w.fails++; w.gone++;
        if (w.gone >= GONE_AFTER) eq(now, [], `${k(w)}: ${w.gone} gone answers in a row: its postings closed`);
        else eq(now, before, `${k(w)}: ${w.gone} gone answer(s): not yet closed`);
        const st = state.rows.get(boardKey({ provider: w.p, board: w.board }))!;
        ok(st.last_status?.includes(`[gone x${w.gone}]`), `${k(w)}: the state says gone x${w.gone}: ${st.last_status}`);
      } else {
        w.fails = 0; w.gone = 0;
        eq(now, sorted(expectedIds(w.p, w.board, w.jobs)), `run ${run} ${k(w)} ${m}: the board's postings, exactly`);
      }
      const st = state.rows.get(boardKey({ provider: w.p, board: w.board }))!;
      eq(st.fail_count, w.fails, `${k(w)}: failures in a row`);
    }
    // No ghost: every open posting belongs to a board in the directory, and is listed by it or its board is not confirmed.
    for (const x of await db.open()) {
      const w = worlds.find((y) => y.p === x.provider && y.board === x.board);
      ok(w, `${x.job_id}: an open posting of no board`);
      if (w!.alive && (w!.mode === "list" || w!.mode === "same") && read.has(k(w!))) ok(expectedIds(w!.p, w!.board, w!.jobs).includes(x.job_id), `${x.job_id}: open but not listed (ghost)`);
    }
    // first seen never moves; every row storable.
    for (const x of await db.all()) {
      checkRow(x);
      const f = firstSeen.get(x.job_id);
      if (f) eq(x.first_seen_at, f, `${x.job_id}: first seen moved`); else firstSeen.set(x.job_id, x.first_seen_at);
      // A closed posting is seen closed by the apply path.
      if (x.closed_at && r.chance(0.05)) eq(screenPosting("u1", { job_id: x.job_id, url: x.url, company: x.company, title: x.title, closed_at: x.closed_at }, {}, { now: at }).verdict, "exclude", "closed: never applied to");
    }
    // The run log: each lane's row done, its counts what changed in the table.
    const rows = runs.rows.slice(startRows);
    eq(rows.length, lanes, "one log row a lane run");
    for (const row of rows) eq(row.status, "done", `run ${run}: logged done`);
    const after = await db.all();
    const newly = after.filter((x) => !allBefore.has(x.job_id)).length;
    const closedNow = after.filter((x) => x.closed_at === iso(at) && !allBefore.get(x.job_id)?.closed_at).length;
    eq(rows.reduce((a, x) => a + x.postings_new, 0), newly, `run ${run}: postings new in the log = rows added`);
    eq(rows.reduce((a, x) => a + x.postings_closed, 0), closedNow, `run ${run}: postings closed in the log = rows closed`);
    const failedBoards = worlds.filter((w) => w.alive && read.has(k(w)) && ["down", "bad", "gone"].includes(w.mode)).length;
    eq(rows.reduce((a, x) => a + x.boards_failed, 0), failedBoards, `run ${run}: boards failed in the log`);
    eq(rows.reduce((a, x) => a + x.failures.length, 0), failedBoards, `run ${run}: every failure listed`);
  }
  eq(db.refused, [], "nothing ingest wrote was refused by the table");
}

// ------------------------------------------------------------------------------------------------ race
const tick = () => new Promise<void>((res) => setTimeout(res, 0));
export async function runRace(s: RaceScenario) {
  const r = rng(s.seed);
  const net: Net = { calls: [], answer: new Map() }, db = pgLikeDb(), state = memoryBoardState(), runs: Runs = { rows: [] };
  const base = fakeFetch(net, r);
  // Every request yields first, so two runs started together interleave.
  const slow = (async (u: any, i: any) => { await Promise.resolve(); return base(u, i); }) as typeof fetch;
  const feed = boardFetchFeed(slow, { stream: true, bodyHash: true });
  const n = r.int(4, 12);
  const worlds = Array.from({ length: n }, (_, i) => { const p = r.pick(PROVIDERS.filter((x) => x !== "workday")); return { p, board: `b${i}x${r.int(1, 999)}`, jobs: nextJobs(r, p, 0, r.int(1, 15)) }; });
  const dir: Board[] = worlds.map((w, i) => ({ company: `Co ${i}`, provider: w.p, board: w.board }));
  for (const w of worlds) net.answer.set(`${w.p}:${w.board.toLowerCase()}`, { kind: "list", jobs: w.jobs });
  const deps = (at: number, env: Record<string, string> = {}) => handlerDeps({ boards: () => dir, db, state, feed, at: () => at, runs, env }) as any;
  const openOf = async (w: (typeof worlds)[0]) => sorted((await db.open()).filter((x) => x.provider === w.p && x.board === w.board).map((x) => x.job_id));
  const mirrorAll = async (m: string) => { for (const w of worlds) eq(await openOf(w), sorted(expectedIds(w.p, w.board, w.jobs)), `${m}: ${w.p}:${w.board}`); };

  if (s.kind === "two_runs") {
    // Two runs of one lane at the same moment (an overlapping tick): each board read once, by one of them.
    const a = handleIngest(post(0, 1), deps(T0)), b = handleIngest(post(0, 1), deps(T0 + r.int(0, 3000)));
    const [ra, rb] = await Promise.all([a, b]);
    eq([ra.status, rb.status], [200, 200], "both runs end");
    const per = new Map<string, number>(); for (const c of net.calls) if (!/smartrecruiters/.test(c.url) || /offset=0/.test(c.url)) per.set(c.board, (per.get(c.board) ?? 0) + 1);
    for (const [b, c] of per) eq(c, 1, `${b} read by both runs`);
    eq(per.size, n, "every board read");
    const ja = await ra.json(), jb = await rb.json();
    eq(ja.new + jb.new, (await db.all()).length, "new counted once across the two runs");
    await mirrorAll("two runs");
  } else if (s.kind === "killed") {
    // A run stopped by the platform mid-way: its outcome flush never returns. Its boards stay claimed ("reading"); what it
    // wrote stays; the next run takes them again and nothing is lost or closed by the stop.
    const pre = await handleIngest(post(0, 1), deps(T0));
    eq(pre.status, 200, "a first good run");
    for (const w of worlds) { if (r.chance(0.5)) w.jobs.push(...nextJobs(r, w.p, 500, r.int(1, 4))); if (r.chance(0.3) && w.jobs.length > 1) w.jobs.pop(); net.answer.set(`${w.p}:${w.board.toLowerCase()}`, { kind: "list", jobs: w.jobs }); }
    const realRecord = state.record.bind(state);
    let records = 0;
    state.record = async (rows: BoardState[]) => { records++; if (records >= 1) return await new Promise<void>(() => {}); return realRecord(rows); }; // the claim is the store's own step; the stop is at the first outcome flush
    void handleIngest(post(0, 1), deps(T0 + 20 * MIN));
    for (let i = 0; i < 200 && records < 1; i++) await tick();
    for (let i = 0; i < 20; i++) await tick();
    ok(records >= 1, "the killed run reached its flush");
    state.record = realRecord;
    eq(runs.rows.at(-1)!.status, "started", "the killed run's row says it never ended (no end recorded)");
    for (const s2 of state.rows.values()) eq(s2.last_status, "reading", "a claimed board names the stopped run");
    const after = await handleIngest(post(0, 1), deps(T0 + 40 * MIN));
    eq(after.status, 200, "the next run");
    await mirrorAll("after a killed run");
    for (const s2 of state.rows.values()) ok(s2.last_status !== "reading", "every board read again after the stop");
  } else if (s.kind === "skew") {
    // A run whose clock is behind the run that last wrote these postings: nothing it writes moves last_seen_at back or
    // puts it before first_seen_at (the table's check), and every board is read.
    eq((await handleIngest(post(0, 1), deps(T0))).status, 200, "first run");
    for (const w of worlds) { for (const j of w.jobs) if (r.chance(0.5)) j.desc += " Updated."; w.jobs.push(...nextJobs(r, w.p, 700, 1)); net.answer.set(`${w.p}:${w.board.toLowerCase()}`, { kind: "list", jobs: w.jobs }); }
    for (const st of state.rows.values()) st.last_attempt_at = iso(T0 - H); // due again
    const known = new Set((await db.all()).map((x) => x.job_id));
    const res = await handleIngest(post(0, 1), deps(T0 - r.int(1, 30) * MIN));
    eq(res.status, 200, `a run with a clock behind: ${await res.clone().text()}`);
    const j = await res.json();
    eq(j.boards_failed, 0, "no board failed for its clock");
    for (const x of await db.all()) { checkRow(x); if (known.has(x.job_id)) ok(Date.parse(x.last_seen_at) >= T0, `${x.job_id}: last seen moved back`); }
    await mirrorAll("clock behind");
  } else if (s.kind === "timeouts") {
    // Statement timeouts writing one board: that board fails with the reason, the lane goes on, nothing of it is closed.
    const victim = worlds[r.int(0, n - 1)];
    db.fault.on = (op, _n) => op === "putMany" && curBoard === victim.board ? "canceling statement due to statement timeout" : null;
    let curBoard = "";
    const real = db.putMany.bind(db);
    db.putMany = async (ps) => { curBoard = ps[0]?.board ?? ""; try { await real(ps); } finally { curBoard = ""; } };
    const res = await handleIngest(post(0, 1), deps(T0));
    eq(res.status, 200, "the lane run ends");
    const j = await res.json();
    eq(j.boards_failed, 1, "one board failed");
    ok(/^storage: write postings: canceling statement due to statement timeout/.test(j.failures[0].error), j.failures[0].error);
    const st = state.rows.get(boardKey({ provider: victim.p, board: victim.board }))!;
    ok(st.last_status?.startsWith("failed: storage:") && st.fail_count === 1, `the board's state: ${st.last_status}`);
    for (const w of worlds) if (w !== victim) eq(await openOf(w), sorted(expectedIds(w.p, w.board, w.jobs)), "the other boards read");
    db.fault.on = null; db.putMany = real;
    eq(runs.rows.at(-1)!.status, "done", "logged done, with the failure");
    eq(runs.rows.at(-1)!.failures.length, 1, "the failure listed");
  } else if (s.kind === "store_down") {
    // A storage error that is not one board's (permission denied) ends the run: logged failed with its error; no board
    // starts or writes after the failure; the boards it never reached go back to the queue.
    const failAt = r.int(1, 3);
    let reads = 0;
    db.fault.on = (op) => (op === "getMany" && ++reads === failAt ? "permission denied for table career_postings" : null);
    const quiet = console.error;
    console.error = () => {}; // the handler logs the failure it is about to record
    let res: Response;
    try { res = await handleIngest(post(0, 1), deps(T0, { INGEST_CONCURRENCY: String(r.int(1, 8)) })); } finally { console.error = quiet; }
    db.fault.on = null;
    eq(res.status, 500, "the run fails");
    const callsAtEnd = net.calls.length, writesAtEnd = db.writes;
    for (let i = 0; i < 30; i++) await tick();
    eq([net.calls.length, db.writes], [callsAtEnd, writesAtEnd], "nothing is read or written after the run has ended");
    const row = runs.rows.at(-1)!;
    ok(row.status === "failed" && /permission denied/.test(String((row as any).error)), `logged failed with its error: ${row.status}`);
    for (const st of state.rows.values()) ok(st.last_status !== "reading" || st.last_attempt_at === iso(T0), "claims settled");
    const next = await handleIngest(post(0, 1), deps(T0 + 20 * MIN));
    eq(next.status, 200, "the next run");
    await mirrorAll("after a failed run");
  } else if (s.kind === "all_fail") {
    // A lane whose every board fails: the run is done (not failed), every failure recorded, nothing closed.
    eq((await handleIngest(post(0, 1), deps(T0))).status, 200, "first run");
    const before = sorted((await db.open()).map((x) => x.job_id));
    for (const w of worlds) net.answer.set(`${w.p}:${w.board.toLowerCase()}`, r.pick([{ kind: "status", status: 503 }, { kind: "status", status: 429 }, { kind: "throw", error: "timed out after 15s" }, { kind: "body", body: "<html>down</html>" }] as Answer[]));
    const res = await handleIngest(post(0, 1), deps(T0 + 20 * MIN));
    eq(res.status, 200, "the run is done");
    const j = await res.json();
    eq([j.boards_ok, j.boards_failed, j.closed], [0, n, 0], "every board failed, nothing closed");
    ok(new RegExp(`failed ${n} \\(`).test(j.report.text), j.report.text);
    eq(sorted((await db.open()).map((x) => x.job_id)), before, "the postings stay");
    eq(runs.rows.at(-1)!.failures.length, n, "every failure listed");
    for (const st of state.rows.values()) eq(st.fail_count, 1, "each board's failure counted");
  }
  eq(db.refused, [], "nothing ingest wrote was refused by the table");
}

export const ALL = generate();
export { atsId };
