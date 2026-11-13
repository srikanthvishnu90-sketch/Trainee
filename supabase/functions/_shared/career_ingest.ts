// Job ingestion (WO-006): public ATS boards -> one postings table every person's agent reads.
//   ingestBoards        one run over the next `maxBoards` boards of the directory (a rotating cursor), honest times:
//                       first_seen_at never moves; a posting missing from a SUCCESSFUL, COMPLETE read is closed; a failed
//                       or partial read closes nothing; a posting that comes back reopens with its first_seen_at and is not new.
//   memoryPostingsDb    the same semantics in memory (tests, the local runner, the simulator)
//   supabasePostingsDb  the same semantics over career_postings / career_ingest_state, written in batches
//   boardFetchFeed      the CareerJobs (121) feed URLs and normalizers, one request per board (SmartRecruiters paged),
//                       a timeout per board, and a job id the apply worker can use (provider:board:<the ATS's own id>);
//                       WO-044: Workable, Recruitee, BambooHR, Teamtailor, Breezy, Personio and Workday through
//                       career_ingest_feeds.ts, each job rewritten to the Greenhouse shape and run through the same normalizer
//   directoryBoards     packages/career-data/board-directory.json -> the live boards
// Network and storage are injected; nothing here deploys, schedules or spends.
import { CareerJobs } from "./router_core.career.js";
import { applyEmailOf } from "./apply_email.ts";
import { BACKLOG_MS, freshWhenSeen } from "./career_fresh.ts";
import { FEEDS, isMoreProvider, MORE_PROVIDERS } from "./career_ingest_feeds.ts";
import { boardHost, cappedText, guardedFetch, type Resolve } from "./posting_fetch.ts";
// Feature 6: the posting URL-shape guard (packages/domain/166-career-url-shape.js, MUSE-F-010), copied byte for byte
// (tests/edge/career-ingest-scale.test.ts fails while the copy is stale). It sets globalThis.CareerUrlShape.
import "./career_url_shape.js";
import { chunksOf, cut, idChunks, jsonArrayElements, readBody, rowContentError, storable, transientStorageError, type ArrayScan } from "./career_ingest_stream.ts";
import { plainLine, plainText, sameJob, scrubRaw, truthfulPostedAt } from "./posting_text.ts";

// etag / last_modified: what the board's last full read answered (career_board_state, WO-037), sent back as a conditional
// request; absent on the cursor path.
// body_sha (Feature 6): the SHA-256 of the body the board's last full read answered; a board whose body is the same again
// is not parsed or normalized (read as "not modified"), the way a 304 is. Only with boardFetchFeed's bodyHash option.
// offset / pass_started_at (2026-10-30): a board too large to read inside one run's posting budget is read in parts over
// several runs; `offset` is where this part starts (the board's job list, counted in job objects), `pass_started_at` when
// the pass that part belongs to began (its first part). Absent: a read from the start.
// gone_reads (2026-10-30, ingest round 2): how many reads in a row before this one the board answered 404 / 410 (it no
// longer exists at the ATS); at GONE_AFTER the board's open postings are closed (they are gone with it).
// empty_reads (2026-11-03, ingest round 3): how many complete reads in a row before this one listed no posting at all
// while the board still had open postings (career_shards.ts emptyReadsOf); at EMPTY_AFTER they are closed.
// pass_marked (round 3): the pass this part belongs to marked every posting its first part saw as seen at the pass's start
// (career_shards.ts passMarkedOf), so its last part closes exactly what the pass never saw.
export interface Board { company: string; provider: string; board: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null; offset?: number | null; pass_started_at?: string | null; gone_reads?: number | null; empty_reads?: number | null; pass_marked?: boolean | null }
export interface FeedPosting {
  job_id: string; company: string; title: string; location?: string; url: string; description?: string;
  ats_id?: string; department?: string; posted_at?: string | null; remote?: string; role_family?: string; seniority_band?: string;
  apply_email?: string | null; // WO-032: the address the posting asks applications to be emailed to (apply_email.ts)
  pay?: string | null; // WO-069: the pay the board states in its own structured fields (boardPay), or null
  pay_zones?: PayZone[] | null; // D-069: every zone the board states (boardPayZones), none dropped; null when it states none
}
// A feed returns its postings; `complete: false` says the board has more than was read (closes nothing). WO-037:
// `not_modified` says the board answered 304 to a conditional request (nothing changed since the last read); etag and
// last_modified are the validators a full read answered with, kept for the next conditional request.
// `batches` (2026-10-30, boardFetchFeed's `stream` option): the postings arrive a batch at a time while the body is read
// and normalized lazily (each batch says how many of the board's job objects it covers), so a run never holds a whole
// board; `postings` is then empty. The reader starts at Board.offset.
export interface FeedBatch { postings: FeedPosting[]; consumed: number }
export interface FeedRead { postings: FeedPosting[]; complete: boolean; not_modified?: boolean; etag?: string | null; last_modified?: string | null; body_sha?: string | null; batches?: AsyncIterable<FeedBatch> }
export type FetchFeed = (b: Board) => Promise<FeedPosting[] | FeedRead>;
// What happened to one board in a run (WO-037: the sharded scheduler records it in career_board_state).
// next_offset (2026-10-30): the read stopped at the run's posting budget with more of the board left; the next read
// resumes there (pass_started_at: when this pass began). null/absent: the pass is over.
// gone_reads: a failed read that answered 404 / 410: how many in a row now (this one included); gone_closed: the open
// postings closed because the board is gone (GONE_AFTER reached).
// empty_reads (round 3): this read listed nothing while postings were open: how many such reads in a row now.
export interface BoardOutcome { status: "ok" | "partial" | "not_modified" | "failed"; error?: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null; next_offset?: number | null; pass_started_at?: string | null; gone_reads?: number; gone_closed?: number; empty_reads?: number; pass_marked?: boolean }
// A board that answers 404 / 410 on this many reads in a row is gone: its open postings are closed (never left listed as
// open for ever), and it is read again only on the failure backoff (career_shards.ts retryAfterMs), not every window.
export const GONE_AFTER = 3;
export const goneAnswer = (error: string) => /^HTTP (404|410)$/.test(error);
// 2026-11-03 (ingest round 3): a board that answers 200 with an empty list while it has open postings is, as often as not,
// a board in an outage or mid-migration (an ATS answering its public list empty while its index rebuilds), not a board
// whose every job closed at once. Its postings used to close on that one read, and with them every application queued
// for them (20261030110000_career_ingest_r2.sql closes those). They close once EMPTY_AFTER complete reads in a row list
// nothing; a read that lists anything starts the count again. The held read keeps no validators, so the next read is a
// full one (an unchanged empty body is never "not modified" into a hold for ever).
export const EMPTY_AFTER = 3;
// A stored posting without its description (2026-10-30): the description's SHA-256 stands in for it, so a run compares
// a board's postings with what is stored without reading 20 KB of text per posting back.
export type KnownPosting = Omit<Posting, "description"> & { description_sha: string };
export interface Posting extends FeedPosting {
  provider: string; board: string; first_seen_at: string; last_seen_at: string; closed_at: string | null;
}
export interface PostingsDb {
  all(): Promise<Posting[]>; open(): Promise<Posting[]>; get(job_id: string): Promise<Posting | null>; put(p: Posting): Promise<void>;
  getMany(ids: string[]): Promise<Posting[]>; putMany(ps: Posting[]): Promise<void>;
  touch(ids: string[], at: string): Promise<void>; // seen again, nothing changed: last_seen_at only (no description re-sent)
  close(ids: string[], at: string): Promise<void>;
  openForBoard(b: Board): Promise<{ job_id: string }[]>; newSince(isoTime: string): Promise<Posting[]>; // open, first_seen_at > t, newest first
  search(words: string[], limit: number): Promise<Posting[]>; // open postings matching every word, newest first
  getCursor(): Promise<number>; setCursor(n: number): Promise<void>;
  // 2026-10-30: the stored postings among ids, without descriptions (the store that has it; else getMany is used).
  known?(ids: string[]): Promise<KnownPosting[]>;
  // 2026-10-30: a board's open postings last seen before `beforeIso` (the close at the end of a pass read in parts).
  staleForBoard?(b: Board, beforeIso: string): Promise<string[]>;
}
export interface IngestStats {
  boards_ok: number; boards_failed: number; boards_partial: number; new: number; seen: number; reopened: number; closed: number;
  boards_not_modified?: number; // WO-037: answered 304 to a conditional request
  // Feature 6: postings refused at ingest because their link is never a posting (a data/API endpoint, a discussion
  // thread, a search or board page, not a URL), by shape; and links kept but of no recognized posting grammar.
  url_rejected?: number; url_rejected_shapes?: Record<string, number>; url_unknown?: number;
  postings_read?: number; // Feature 6: postings parsed this run (the CPU proxy postingBudget counts)
  stopped_by?: "deadline" | "posting_budget"; // why boards were left for the next run, when any were
  boards_continued?: number; // 2026-10-30: boards stopped inside at the posting budget, their next part due next run
  boards_gone?: number; // 2026-10-30 (round 2): boards found gone this run (GONE_AFTER reads of 404 / 410), their postings closed
  boards_left_directory?: number; // boards no longer in the directory, their postings closed and their state forgotten (handler)
  boards_empty_held?: number; // round 3: boards that listed nothing while postings were open, held (fewer than EMPTY_AFTER reads)
  replaced?: number; // round 3: ids the board gave to another job: the old job closed, the new one stored as new
  failures: { board: string; provider: string; error: string }[];
  large_closes: { board: string; provider: string; closed: number; was_open: number }[]; // a board that lost half or more at once
}

const MAX_DESCRIPTION = 20000;
// deno-lint-ignore no-explicit-any
const URL_SHAPE = (globalThis as any).CareerUrlShape as { classifyPostingUrl(u: unknown): { verdict: "posting" | "not_posting" | "unknown"; shape: string; reasons: string[] } };
export const urlShape = (u: unknown) => URL_SHAPE.classifyPostingUrl(u);
const TEXT_DEFAULTS = new Set(["location", "description", "department"]); // never null in the table

// ------------------------------------------------------------------------------------------------ the run
// The fields that, when a board changes them, rewrite the stored posting; anything else seen again is only touched.
const CONTENT = ["company", "title", "location", "url", "description", "department", "posted_at", "ats_id", "remote", "role_family", "seniority_band", "apply_email", "pay", "pay_zones"] as const;
// Postgres hands timestamps back in its own format ("+00:00"), so a time compares as a time.
// pay_zones (D-069) is an array of objects: it compares by value, keys sorted (jsonb hands keys back in its own order).
const canon = (v: any): string => v === null || v === undefined ? "null" : Array.isArray(v) ? `[${v.map(canon).join(",")}]` : typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);
const sameValue = (k: string, x: any, y: any) => k === "posted_at" ? (x ? Date.parse(x) : null) === (y ? Date.parse(y) : null) : k === "pay_zones" ? canon(x?.length ? x : null) === canon(y?.length ? y : null) : (x ?? (TEXT_DEFAULTS.has(k) ? "" : null)) === (y ?? (TEXT_DEFAULTS.has(k) ? "" : null));
const same = (a: any, b: any) => CONTENT.every((k) => sameValue(k, a[k], b[k]));
// The same test against a stored row without its description (2026-10-30): the description compares by its SHA-256.
const sameKnown = (a: KnownPosting, b: FeedPosting, descriptionSha: string) => a.description_sha === descriptionSha && CONTENT.every((k) => k === "description" || sameValue(k, (a as any)[k], (b as any)[k]));

// `deadline` (epoch ms): boards not started by then wait for the next run; the cursor moves only past boards attempted.
// `clock`: what the deadline is checked against (default Date.now). The caller passes the clock it built the deadline
// from, so a deadline and its check never come from two different clocks.
// `touchAfterMs`: an unchanged posting's last_seen_at is rewritten only once it is this old (0 = every run). The scheduled
// run uses hours, so tens of thousands of unchanged postings are not rewritten every few minutes.
// `useCursor: false` (WO-037, the sharded scheduler): read `boards` in the order given, from the first, and leave the
// cursor alone; `onBoard` hears each attempted board's outcome.
// `onBoard` may return a promise; the run waits for it (the handler records board state in small groups as it goes).
// 2026-10-30, bounded per board: a board's postings are handled a batch (INGEST_BATCH) at a time: the stored rows
// compared without descriptions (db.known), at most a batch written or touched per call, and only the ids kept for the
// close. With `postingBudget`, a board whose read reaches the budget stops there (partial, closes nothing) and its next read
// resumes where it stopped (BoardOutcome.next_offset); the part that ends a pass read over several runs closes what the
// pass did not see (staleForBoard). A transient storage error (a statement timeout, a request that never arrived) fails
// that board, recorded with its reason, and the run goes on; any other storage error fails the run.
export const INGEST_BATCH = 100;
// How far before its stopping point a board's next part starts (postings already handled are only compared again).
export const RESUME_OVERLAP = 20;
class StorageFailure extends Error { constructor(readonly original: unknown) { super(original instanceof Error ? original.message : String(original)); } }
export async function ingestBoards(o: { boards: Board[]; fetchFeed: FetchFeed; db: PostingsDb; now: number; maxBoards?: number; concurrency?: number; deadline?: number; clock?: () => number; touchAfterMs?: number; useCursor?: boolean; onBoard?: (b: Board, r: BoardOutcome) => unknown; postingBudget?: number }): Promise<IngestStats & { attempted: number }> {
  const now = new Date(o.now).toISOString(), n = o.boards.length, clock = o.clock || Date.now;
  const st = { boards_ok: 0, boards_failed: 0, boards_partial: 0, new: 0, seen: 0, reopened: 0, closed: 0, failures: [], large_closes: [], attempted: 0 } as IngestStats & { attempted: number };
  if (!n) return st;
  const take = Math.max(1, Math.min(o.maxBoards ?? n, n));
  const useCursor = o.useCursor !== false;
  const start = useCursor ? ((await o.db.getCursor()) % n + n) % n : 0;
  const pick = Array.from({ length: take }, (_, i) => o.boards[(start + i) % n]);
  const touchAfterMs = o.touchAfterMs ?? 0;
  const store = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw new StorageFailure(e); } };
  const budgetLeft = () => (o.postingBudget ? o.postingBudget - (st.postings_read ?? 0) : Infinity);
  const fail = async (b: Board, error: string) => {
    st.boards_failed++;
    st.failures.push({ board: b.board, provider: b.provider, error });
    // 2026-10-30 (round 2): a board that answers 404 / 410 read after read no longer exists. Production held boards at
    // "HTTP 404" for days (fail_count 69) with their postings still listed open. At GONE_AFTER in a row they are closed.
    if (goneAnswer(error)) {
      const gone = Math.max(0, Math.floor(Number(b.gone_reads) || 0)) + 1;
      let closed = 0;
      if (gone >= GONE_AFTER) {
        try {
          const open = (await store(() => o.db.openForBoard(b))).map((p) => p.job_id);
          if (open.length) { await store(() => o.db.close(open, now)); closed = open.length; st.closed += closed; }
          st.boards_gone = (st.boards_gone ?? 0) + 1;
        } catch (e) {
          const why = storageFailed(e); // the close is tried again on the board's next read
          st.failures[st.failures.length - 1].error = `${error}; closing its postings: ${why}`.slice(0, 300);
        }
      }
      await o.onBoard?.(b, { status: "failed", error, gone_reads: gone, ...(gone >= GONE_AFTER ? { gone_closed: closed } : {}) });
      return;
    }
    await o.onBoard?.(b, { status: "failed", error });
  };
  // A storage failure: transient, or a row the table refuses -> that board fails (its reason recorded); anything else
  // fails the run.
  const storageFailed = (e: unknown) => {
    if (!(e instanceof StorageFailure)) throw e;
    if (!transientStorageError(e.original) && !rowContentError(e.original)) throw e.original;
    return `storage: ${e.message}`.slice(0, 300);
  };
  // 2026-10-30 (round 2): a posting rewritten by a run whose clock is behind the one that last saw it keeps the later
  // time (last_seen_at never moves back, and never before first_seen_at: the table's check would refuse the write).
  const later = (a: string, b: string | null | undefined) => (b && Date.parse(b) > Date.parse(a) ? b : a);

  async function one(b0: Board) {
    const offset = Math.max(0, Math.floor(Number(b0.offset) || 0));
    // A part after the first is read in full: no validators (a 304 or an unchanged body would end the pass unread).
    const b = offset > 0 ? { ...b0, etag: null, last_modified: null, body_sha: null } : b0;
    let r: FeedRead, plain = false; // plain: the feed answered a bare list (no validators)
    try {
      const got = await o.fetchFeed(b);
      plain = Array.isArray(got);
      r = Array.isArray(got) ? { postings: got, complete: true } : got;
    } catch (e) {
      await fail(b0, e instanceof Error ? e.message : String(e));
      return;
    }
    const validators = { etag: r.etag ?? null, last_modified: r.last_modified ?? null, ...(r.body_sha !== undefined ? { body_sha: r.body_sha } : {}) };
    // Nothing changed since the last full read: nothing to write, nothing to close.
    if (r.not_modified) { st.boards_ok++; st.boards_not_modified = (st.boards_not_modified ?? 0) + 1; await o.onBoard?.(b0, { status: "not_modified", ...validators }); return; }

    const seen = new Set<string>(), quiet: string[] = [];
    const marked = offset > 0 && !!b0.pass_marked, passStartMs = Date.parse(b0.pass_started_at ?? now);
    async function handle(list: FeedPosting[]) {
      const fresh = new Map<string, FeedPosting>();
      for (const p of list) {
        if (!p || !p.job_id || seen.has(p.job_id)) continue;
        // Feature 6: a link that is never a posting never enters the table (and one stored before is closed below, since a
        // complete read no longer carries it). "unknown" is kept and counted: the guard never promotes or drops a guess.
        const v = urlShape(p.url);
        if (v.verdict === "not_posting") {
          st.url_rejected = (st.url_rejected ?? 0) + 1;
          const shapes = (st.url_rejected_shapes ??= {});
          shapes[v.shape] = (shapes[v.shape] ?? 0) + 1;
          continue;
        }
        if (v.verdict === "unknown") st.url_unknown = (st.url_unknown ?? 0) + 1;
        seen.add(p.job_id);
        fresh.set(p.job_id, p);
      }
      if (!fresh.size) return;
      const writes: Posting[] = [], touched: string[] = [], needWhole: FeedPosting[] = [], replaced: string[] = [];
      // Round 3: a later part of a marked pass touches what it sees not yet seen in this pass; the first part keeps the ids
      // it saw unchanged and left untouched (`quiet`), touched only if the pass goes on past it.
      const due = (old: { last_seen_at: string }) => marked ? Date.parse(old.last_seen_at) < passStartMs : o.now - Date.parse(old.last_seen_at) >= touchAfterMs;
      const keepQuiet = (id: string) => { if (offset === 0) quiet.push(id); };
      // 2026-11-03 (round 3): the id a board gave to another job (the title says another job, not the same one edited) is a
      // new posting: first seen now, and the job it was before closed first, so every application queued for that job
      // ends as not sent (20261030110000_career_ingest_r2.sql) instead of going to the new one. It used to be merged.
      const another = (old: { title: string; closed_at: string | null }, p: FeedPosting) => {
        if (sameJob(old.title, p.title)) return false;
        st.new++; st.replaced = (st.replaced ?? 0) + 1;
        if (!old.closed_at) replaced.push(p.job_id);
        writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null });
        return true;
      };
      // A posted date only when it can be true (posting_text.ts truthfulPostedAt). Workday states an age ("Posted 30+ Days
      // Ago"), read as the latest date it allows: a later read of the same job never moves the stored date later.
      const dated = (p: FeedPosting, old?: { posted_at?: string | null; title: string } | null): FeedPosting => {
        let at = truthfulPostedAt(p.posted_at, o.now);
        const was = old ? truthfulPostedAt(old.posted_at, o.now) : null;
        if (b.provider === "workday" && at && was && Date.parse(was) < Date.parse(at) && sameJob(old!.title, p.title)) at = was;
        return { ...p, posted_at: at };
      };
      if (o.db.known) {
        const known = new Map((await store(() => o.db.known!([...fresh.keys()]))).map((p) => [p.job_id, p]));
        for (const p0 of fresh.values()) {
          const old = known.get(p0.job_id), p = dated(p0, old);
          if (!old) { st.new++; writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null }); continue; }
          if (another(old, p)) continue;
          if (old.closed_at) st.reopened++; else st.seen++;
          if (!old.closed_at && sameKnown(old, p, await sha256Hex(p.description ?? ""))) { if (due(old)) touched.push(p.job_id); else keepQuiet(p.job_id); continue; }
          // A posting the feed gave no description keeps the stored one (as a whole row would): read back for these only.
          if (p.description === undefined) { needWhole.push(p); continue; }
          const { description_sha: _sha, ...rest } = old;
          writes.push({ ...rest, ...p, provider: b.provider, board: b.board, first_seen_at: old.first_seen_at, last_seen_at: later(now, old.last_seen_at), closed_at: null } as Posting);
        }
        if (needWhole.length) {
          const whole = new Map((await store(() => o.db.getMany(needWhole.map((p) => p.job_id)))).map((p) => [p.job_id, p]));
          for (const p of needWhole) { const old = whole.get(p.job_id)!; writes.push({ ...old, ...p, provider: b.provider, board: b.board, first_seen_at: old.first_seen_at, last_seen_at: later(now, old.last_seen_at), closed_at: null }); }
        }
      } else {
        const known = new Map((await store(() => o.db.getMany([...fresh.keys()]))).map((p) => [p.job_id, p]));
        for (const p0 of fresh.values()) {
          const old = known.get(p0.job_id), p = dated(p0, old);
          if (!old) { st.new++; writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null }); continue; }
          if (another(old, p)) continue;
          if (old.closed_at) st.reopened++; else st.seen++;
          if (!old.closed_at && same(old, p)) { if (due(old)) touched.push(p.job_id); else keepQuiet(p.job_id); continue; }
          writes.push({ ...old, ...p, provider: b.provider, board: b.board, first_seen_at: old.first_seen_at, last_seen_at: later(now, old.last_seen_at), closed_at: null });
        }
      }
      if (replaced.length) await store(() => o.db.close(replaced, now));
      if (writes.length) await store(() => o.db.putMany(writes));
      if (touched.length) await store(() => o.db.touch(touched, now));
    }

    let consumed = 0, more = false, readError: unknown = null;
    try {
      if (r.batches) {
        const it = r.batches[Symbol.asyncIterator]();
        try {
          for (;;) {
            // The run's posting budget is reached: this board stops here (at least one batch read) and resumes next run.
            if (consumed > 0 && budgetLeft() <= 0) { more = true; break; }
            let nx: IteratorResult<FeedBatch>;
            try { nx = await it.next(); } catch (e) { readError = e; break; }
            if (nx.done) break;
            consumed += nx.value.consumed;
            st.postings_read = (st.postings_read ?? 0) + nx.value.consumed;
            await handle(nx.value.postings);
          }
        } finally {
          if (more || readError !== null || consumed === 0) { try { await it.return?.(undefined); } catch { /* the stream is closed either way */ } }
        }
      } else {
        st.postings_read = (st.postings_read ?? 0) + r.postings.length;
        for (let i = 0; i < r.postings.length; i += INGEST_BATCH) await handle(r.postings.slice(i, i + INGEST_BATCH));
      }
    } catch (e) {
      await fail(b0, storageFailed(e));
      return;
    }
    if (readError !== null && consumed === 0) { await fail(b0, readError instanceof Error ? readError.message : String(readError)); return; }
    const passStarted = offset > 0 ? (b0.pass_started_at ?? now) : now;
    if (more || readError !== null) {
      // Stopped inside the board: the next part starts a little before this one stopped (a board that moved its list a few
      // places is still covered); nothing is closed until the pass ends.
      st.boards_ok++;
      st.boards_partial++;
      if (more) st.boards_continued = (st.boards_continued ?? 0) + 1;
      const nextOffset = offset +Math.max(1, consumed > 2 * RESUME_OVERLAP ? consumed - RESUME_OVERLAP : consumed);
      // 2026-11-03 (round 3): the pass goes on past its first part: what that part saw unchanged and left untouched (seen
      // under touchAfterMs ago) is marked seen now, so the pass's last part closes exactly what no part saw. It used to
      // close only what was last seen before the pass start less touchAfterMs: a posting a board took down soon after the
      // last pass stayed open through the whole next pass (found on 12,000-posting boards read over 14 runs).
      let passMarked = marked;
      if (offset === 0) {
        try { if (quiet.length) await store(() => o.db.touch(quiet, now)); passMarked = true; }
        catch (e) { await fail(b0, storageFailed(e)); return; }
      }
      await o.onBoard?.(b0, { status: "partial", ...validators, body_sha: null, next_offset: nextOffset, pass_started_at: passStarted, ...(passMarked ? { pass_marked: true } : {}) });
      return;
    }
    const complete = r.complete;
    let emptyReads = 0, held = false;
    try {
      if (complete && offset === 0) {
        const open = await store(() => o.db.openForBoard(b));
        const gone = open.map((p) => p.job_id).filter((id) => !seen.has(id));
        // Round 3: a list with nothing in it while postings are open closes them only at EMPTY_AFTER such reads in a row.
        if (gone.length && seen.size === 0) {
          emptyReads = Math.max(0, Math.floor(Number(b0.empty_reads) || 0)) + 1;
          held = emptyReads < EMPTY_AFTER;
          if (held) st.boards_empty_held = (st.boards_empty_held ?? 0) + 1;
        }
        if (gone.length && !held) {
          await store(() => o.db.close(gone, now));
          st.closed += gone.length;
          if (gone.length >= 20 && gone.length * 2 >= open.length) st.large_closes.push({ board: b.board, provider: b.provider, closed: gone.length, was_open: open.length });
        }
      } else if (complete && o.db.staleForBoard) {
        // The last part of a pass read over several runs: what no part saw is gone. A posting an earlier part saw was written
        // or touched then, or had been touched less than touchAfterMs before (so after pass start - touchAfterMs).
        // Round 3: a marked pass touched every posting it saw that was not seen since its start: what is older is gone.
        const before = marked ? new Date(passStartMs).toISOString() : new Date(Date.parse(passStarted) - touchAfterMs).toISOString();
        const gone = (await store(() => o.db.staleForBoard!(b, before))).filter((id) => !seen.has(id));
        if (gone.length) { await store(() => o.db.close(gone, now)); st.closed += gone.length; }
      }
    } catch (e) {
      await fail(b0, storageFailed(e));
      return;
    }
    st.boards_ok++;
    if (!complete) st.boards_partial++;
    const outcome: BoardOutcome = plain ? { status: complete ? "ok" : "partial" } : { status: complete ? "ok" : "partial", ...validators };
    if (offset > 0) Object.assign(outcome, { body_sha: null, next_offset: null, pass_started_at: null });
    if (emptyReads) outcome.empty_reads = emptyReads;
    if (held) Object.assign(outcome, { etag: null, last_modified: null, body_sha: null });
    await o.onBoard?.(b0, outcome);
  }

  const width = Math.max(1, Math.min(o.concurrency ?? 1, pick.length));
  let next = 0, halted: { e: unknown } | null = null;
  // 2026-10-30 (round 2): a run that fails (a storage error that is not one board's) stops every worker before it
  // reports: no board starts after it, and nothing is still writing once the caller has handed back the unread boards.
  await Promise.allSettled(Array.from({ length: width }, async () => {
    // Feature 6: postingBudget bounds a run's CPU (parsing and normalizing postings is most of it): once the run has parsed
    // that many, no further board starts; the rest stay due, oldest first, for the next run.
    const stop = () => (o.deadline && clock() >= o.deadline) ? "deadline" as const : (o.postingBudget && (st.postings_read ?? 0) >= o.postingBudget) ? "posting_budget" as const : null;
    while (next < pick.length && !halted) {
      const why = stop(); if (why) { st.stopped_by = why; break; }
      st.attempted++;
      try { await one(pick[next++]); } catch (e) { halted ??= { e }; }
    }
  }));
  if (halted) throw (halted as { e: unknown }).e;
  if (useCursor) await o.db.setCursor((start + st.attempted) % n);
  return st;
}

export { BACKLOG_MS, freshWhenSeen } from "./career_fresh.ts";

// ------------------------------------------------------------------------------------------------ search words
// Words that say "a job" rather than which job; every remaining word must match.
const FILLER = new Set(["job", "jobs", "role", "roles", "position", "positions", "opening", "openings", "opportunity", "opportunities",
  "work", "any", "some", "find", "me", "my", "near", "in", "at", "for", "the", "a", "an", "and", "or", "of", "to", "with", "on", "hiring", "open"]);
export function searchWords(query: unknown): string[] {
  return [...new Set(String(query ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !FILLER.has(w)))];
}
// A light stem so "nurse" finds "nursing" and "analysts" finds "analyst"; the database side stems with Postgres english.
export function wordStem(w: string): string {
  const s = w.replace(/(ing|ed|es|s|e)$/, "");
  return s.length >= 4 ? s : w;
}
// WO-073: how much of the query the title itself carries: 0 every word, 1 some, 2 none (it is only in the description,
// the company or the place). A search for a role ranks the role first ("product manager" is not a recruiter whose
// posting mentions product managers).
export function titleTier(p: { title?: string }, words: string[]): 0 | 1 | 2 {
  if (!words.length) return 0;
  const t = String(p.title || "").toLowerCase();
  const n = words.filter((w) => t.includes(w) || t.includes(wordStem(w))).length;
  return n === words.length ? 0 : n > 0 ? 1 : 2;
}
export function matchesWords(p: { title?: string; company?: string; location?: string; description?: string }, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${p.title || ""} ${p.company || ""} ${p.location || ""} ${p.description || ""}`.toLowerCase();
  return words.every((w) => hay.includes(w) || hay.includes(wordStem(w)));
}

// ------------------------------------------------------------------------------------------------ memory store
export function memoryPostingsDb(): PostingsDb {
  const rows = new Map<string, Posting>();
  let cursor = 0;
  const open = () => [...rows.values()].filter((p) => !p.closed_at);
  const newest = (a: Posting, b: Posting) => b.first_seen_at.localeCompare(a.first_seen_at);
  return {
    async all() { return [...rows.values()].map((p) => ({ ...p })); },
    async open() { return open().sort(newest).map((p) => ({ ...p })); },
    async get(id) { const p = rows.get(id); return p ? { ...p } : null; },
    async put(p) { rows.set(p.job_id, { ...p }); },
    async getMany(ids) { return ids.map((id) => rows.get(id)).filter((p): p is Posting => !!p).map((p) => ({ ...p })); },
    async putMany(ps) { for (const p of ps) rows.set(p.job_id, { ...p }); },
    async touch(ids, at) { for (const id of ids) { const p = rows.get(id); if (p) rows.set(id, { ...p, last_seen_at: at }); } },
    async close(ids, at) { for (const id of ids) { const p = rows.get(id); if (p) rows.set(id, { ...p, closed_at: at }); } },
    async openForBoard(b) { return open().filter((p) => p.provider === b.provider && p.board === b.board).map((p) => ({ job_id: p.job_id })); },
    async staleForBoard(b, before) { const t = Date.parse(before); return open().filter((p) => p.provider === b.provider && p.board === b.board && Date.parse(p.last_seen_at) < t).map((p) => p.job_id); },
    async newSince(t) { return open().filter((p) => p.first_seen_at > t && freshWhenSeen(p)).sort(newest).map((p) => ({ ...p })); },
    async search(words, limit) {
      return open().filter((p) => matchesWords(p, words)).sort((a, b) => titleTier(a, words) - titleTier(b, words) || newest(a, b))
        .slice(0, limit).map((p) => ({ ...p }));
    },
    async getCursor() { return cursor; },
    async setCursor(c) { cursor = c; },
  };
}

// ------------------------------------------------------------------------------------------------ Supabase store
// The tables: supabase/migrations/20261019000001_career_postings.sql (pay: 20261022110000). `admin` is a service-role client.
const COLUMNS = ["job_id", "provider", "board", "ats_id", "company", "title", "location", "url", "description", "department",
  "posted_at", "remote", "role_family", "seniority_band", "apply_email", "pay", "pay_zones", "first_seen_at", "last_seen_at", "closed_at"] as const;
const LIST_COLUMNS = COLUMNS.filter((c) => c !== "description").join(",");
// Requests and statements stay small (2026-10-30 production fix):
//   an in() list is cut by its URL length (idChunks: at most URL_MAX characters, and ID_CHUNK ids): 100 Workday ids made
//     ~20 KB URLs the gateway never sent ("read postings: TypeError: error sending request");
//   a write is at most WRITE_ROWS rows and WRITE_BYTES of JSON per statement (each row rewrites the search index);
//   a statement that times out is retried as two halves, down to one row, before the board fails (never the lane);
//   the stored rows a run compares against come back without descriptions (career_postings_known, a POST: no URL limit).
const PAGE = 1000, ID_CHUNK = 100, URL_MAX = 6000, WRITE_ROWS = 50, WRITE_BYTES = 1_000_000, KNOWN_CHUNK = 200;
const row = (p: Posting) => Object.fromEntries(COLUMNS.map((c) => [c, (p as any)[c] ?? (TEXT_DEFAULTS.has(c) ? "" : null)]));
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

// deno-lint-ignore no-explicit-any
// Feature 6: one run's record in career_ingest_runs (20261026060106_career_ingest_runs.sql), one row per lane run.
export interface IngestRunRow {
  at: string; lane: number; lanes: number; window_min: number; ms: number;
  boards_due: number; boards_read: number; boards_ok: number; boards_failed: number; boards_not_modified: number;
  postings_new: number; postings_seen: number; postings_reopened: number; postings_closed: number; url_rejected: number;
  lane_fresh: number | null; lane_total: number | null; directory_fresh: number | null; directory_total: number | null;
  failures: { provider: string; board: string; error: string }[]; report: string;
  // 2026-10-30 (20261030030000_career_ingest_bounded.sql): 'started' is written when a run begins, so a run the platform
  // stops (memory, CPU, wall clock) still shows in the log; 'failed' carries the error a run ended on.
  status?: "started" | "done" | "failed"; error?: string | null;
}
// Rows grouped for writing: at most `rows` each and about `bytes` of JSON.
export function writeBatches<T>(xs: T[], rows = WRITE_ROWS, bytes = WRITE_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const x of xs) {
    const n = JSON.stringify(x).length;
    if (cur.length && (cur.length >= rows || size + n > bytes)) { out.push(cur); cur = []; size = 0; }
    cur.push(x);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
// One statement over `items`; on a transient failure (a statement timeout) the two halves are tried apart, down to one item.
export async function halving<T>(items: T[], run: (part: T[]) => Promise<void>): Promise<void> {
  try { await run(items); }
  catch (e) {
    if (items.length <= 1 || !transientStorageError(e)) throw e;
    const mid = Math.ceil(items.length / 2);
    await halving(items.slice(0, mid), run);
    await halving(items.slice(mid), run);
  }
}
const missingFunction = (m: string) => /could not find the function|PGRST202|no function |function .* does not exist/i.test(m);
export const RUN_LOG_DAYS = 14;
export function supabasePostingsDb(admin: any): PostingsDb & { recordRun(stats: IngestStats, at: string): Promise<void>; recordLaneRun(row: IngestRunRow): Promise<void>;
  startLaneRun(row: Pick<IngestRunRow, "at" | "lane" | "lanes" | "window_min">): Promise<number | null>; finishLaneRun(id: number, row: IngestRunRow): Promise<void> } {
  let knownRpc = true; // false once the database says career_postings_known is not there (the migration not yet applied)
  const T = "career_postings", S = "career_ingest_state";
  async function pages(build: (from: number, to: number) => any, what: string): Promise<any[]> {
    const out: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const got = must<any[]>(await build(from, from + PAGE - 1), what) || [];
      out.push(...got);
      if (got.length < PAGE) return out;
    }
  }
  return {
    async all() { return pages((a, b) => admin.from(T).select("*").order("job_id").range(a, b), "read postings"); },
    async open() { return must<Posting[]>(await admin.from(T).select("*").is("closed_at", null).order("first_seen_at", { ascending: false }).limit(3000), "read open postings") || []; },
    async get(id) { return must<Posting | null>(await admin.from(T).select("*").eq("job_id", id).maybeSingle(), "read posting"); },
    async put(p) { must(await admin.from(T).upsert([row(p)], { onConflict: "job_id" }), "write posting"); },
    async getMany(ids) {
      const out: Posting[] = [];
      for (const c of idChunks(ids, { maxUrl: URL_MAX, maxIds: ID_CHUNK })) out.push(...(must<Posting[]>(await admin.from(T).select("*").in("job_id", c), "read postings") || []));
      return out;
    },
    async known(ids) {
      const out: KnownPosting[] = [];
      for (const c of chunks(ids, KNOWN_CHUNK)) {
        if (knownRpc) {
          const r = await admin.rpc("career_postings_known", { p_ids: c });
          if (!r.error) { out.push(...((r.data as KnownPosting[]) || [])); continue; }
          if (!missingFunction(r.error.message)) throw new Error(`read postings: ${r.error.message}`);
          knownRpc = false;
        }
        // Before the migration: the whole rows by URL-bounded lists, each description hashed and dropped at once.
        for (const d of idChunks(c, { maxUrl: URL_MAX, maxIds: ID_CHUNK })) {
          for (const p of must<Posting[]>(await admin.from(T).select("*").in("job_id", d), "read postings") || []) {
            const { description, ...rest } = p;
            out.push({ ...rest, description_sha: await sha256Hex(description ?? "") });
          }
        }
      }
      return out;
    },
    async putMany(ps) {
      for (const c of writeBatches(ps.map(row))) await halving(c, async (part) => { must(await admin.from(T).upsert(part, { onConflict: "job_id" }), "write postings"); });
    },
    async touch(ids, at) {
      for (const c of idChunks(ids, { maxUrl: URL_MAX, maxIds: ID_CHUNK })) await halving(c, async (part) => { must(await admin.from(T).update({ last_seen_at: at }).in("job_id", part), "touch postings"); });
    },
    async close(ids, at) {
      for (const c of idChunks(ids, { maxUrl: URL_MAX, maxIds: ID_CHUNK })) await halving(c, async (part) => { must(await admin.from(T).update({ closed_at: at }).in("job_id", part), "close postings"); });
    },
    async staleForBoard(b, before) {
      return (await pages((x, y) => admin.from(T).select("job_id").eq("provider", b.provider).eq("board", b.board).is("closed_at", null).lt("last_seen_at", before).order("job_id").range(x, y), "read stale board postings")).map((p) => p.job_id);
    },
    async openForBoard(b) {
      return pages((x, y) => admin.from(T).select("job_id").eq("provider", b.provider).eq("board", b.board).is("closed_at", null).order("job_id").range(x, y), "read board postings");
    },
    // Every open posting first seen after t that is news (freshWhenSeen), in pages (no description): the alerts run counts
    // these in reports, so a cut list would undercount. Bounded at 20,000 rows (~6 MB). A board's first read can add tens
    // of thousands of backlog rows at once; the database drops them first (published before t less BACKLOG_MS cannot be
    // fresh when first seen after t), so the bound holds news only.
    async newSince(t) {
      const out: Posting[] = [];
      const oldest = new Date(Date.parse(t) - BACKLOG_MS).toISOString();
      for (let from = 0; from < 20000; from += PAGE) {
        const got = must<Posting[]>(await admin.from(T).select(LIST_COLUMNS).is("closed_at", null).gt("first_seen_at", t)
          .or(`posted_at.is.null,posted_at.gte.${oldest}`).order("first_seen_at", { ascending: false }).order("job_id").range(from, from + PAGE - 1), "read new postings") || [];
        out.push(...got);
        if (got.length < PAGE) break;
      }
      return out.filter(freshWhenSeen);
    },
    async search(words, limit) {
      const base = () => admin.from(T).select("*").is("closed_at", null);
      if (!words.length) return must<Posting[]>(await base().order("first_seen_at", { ascending: false }).limit(limit), "search postings") || [];
      // WO-073: postings whose title carries every word first (the search column weights the title A), then the rest, each
      // once, newest first within each: the limit never cuts the role itself in favour of newer postings that mention it.
      const lexemes = words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
      const titled = lexemes.length
        ? must<Posting[]>(await base().textSearch("search", lexemes.map((w) => `${w}:A`).join(" & "), { config: "english" })
          .order("first_seen_at", { ascending: false }).limit(limit), "search postings by title") || []
        : [];
      if (titled.length >= limit) return titled;
      const rest = must<Posting[]>(await base().textSearch("search", words.join(" "), { type: "websearch", config: "english" })
        .order("first_seen_at", { ascending: false }).limit(limit), "search postings") || [];
      const seen = new Set(titled.map((p) => p.job_id));
      return [...titled, ...rest.filter((p) => !seen.has(p.job_id))].slice(0, limit);
    },
    async getCursor() { const r = must<{ cursor: number } | null>(await admin.from(S).select("cursor").eq("id", 1).maybeSingle(), "read ingest cursor"); return r ? Number(r.cursor) || 0 : 0; },
    async setCursor(c) { must(await admin.from(S).upsert({ id: 1, cursor: c }, { onConflict: "id" }), "write ingest cursor"); },
    async recordRun(stats, at) { must(await admin.from(S).upsert({ id: 1, last_run_at: at, last_stats: stats }, { onConflict: "id" }), "write ingest stats"); },
    // Lane 0 also drops records older than RUN_LOG_DAYS (about 5,800 rows a day at 20 lanes every 5 minutes).
    // A run's row is written when it starts ('started') and completed when it ends, so a run the platform stops shows.
    // null: the log cannot hold a started row yet (the migration not applied): the run is recorded once, at its end.
    async startLaneRun(r) {
      const x = await admin.from("career_ingest_runs").insert({ ...r, ms: 0, boards_due: 0, boards_read: 0, boards_ok: 0, boards_failed: 0, status: "started",
        report: `lane ${r.lane} of ${r.lanes}: started; no end recorded (the function was stopped: memory, CPU or time limit)` }).select("id").single();
      return x.error ? null : Number(x.data?.id) || null;
    },
    async finishLaneRun(id, r) {
      must(await admin.from("career_ingest_runs").update({ ...r, status: r.status ?? "done", failures: r.failures.slice(0, 50), report: r.report.slice(0, 2000) || "-", error: r.error ? r.error.slice(0, 1000) : null }).eq("id", id), "write ingest run");
      if (r.lane === 0) must(await admin.from("career_ingest_runs").delete().lt("at", new Date(Date.parse(r.at) - RUN_LOG_DAYS * 86400000).toISOString()), "prune ingest runs");
    },
    async recordLaneRun(r) {
      const R = "career_ingest_runs";
      const { status, error, ...base } = r;
      const ext = status || error ? { status: status ?? "done", error: error ? error.slice(0, 1000) : null } : {};
      const ins = await admin.from(R).insert({ ...base, ...ext, failures: r.failures.slice(0, 50), report: r.report.slice(0, 2000) || "-" });
      // Before the migration the log has no status / error columns: the row is kept without them (the report says it).
      if (ins.error && Object.keys(ext).length && /status|error|column/i.test(ins.error.message)) must(await admin.from(R).insert({ ...base, failures: r.failures.slice(0, 50), report: r.report.slice(0, 2000) || "-" }), "write ingest run");
      else must(ins, "write ingest run");
      if (r.lane === 0) must(await admin.from(R).delete().lt("at", new Date(Date.parse(r.at) - RUN_LOG_DAYS * 86400000).toISOString()), "prune ingest runs");
    },
  };
}

// ------------------------------------------------------------------------------------------------ the network
const SR_PAGE = 100, SR_MAX_PAGES = 10; // SmartRecruiters pages its list; past 1,000 the read is partial (closes nothing)
// Greenhouse escapes its HTML once more than it means to ("&amp;amp;"), so 121's stripHtml leaves "&amp;" in the text.
// 2026-11-03 (round 3): every named entity a board writes (posting_text.ts), not six of them, and a script's body out.
export const decodeEntities = (t: string): string => plainText(t);
const RAW_ID: Record<string, (j: any) => string> = { greenhouse: (j) => j.id, lever: (j) => j.id, ashby: (j) => j.id, smartrecruiters: (j) => j.id,
  ...Object.fromEntries(MORE_PROVIDERS.map((p) => [p, FEEDS[p].id])) };
// Every provider ingest reads: the 121 bundle's four and WO-044's seven.
export const INGEST_PROVIDERS = Object.keys(RAW_ID);
const rawJobs: Record<string, (json: any) => any[]> = {
  greenhouse: (j) => (j && j.jobs) || [], lever: (j) => (Array.isArray(j) ? j : []), ashby: (j) => (j && j.jobs) || [], smartrecruiters: (j) => (j && j.content) || [],
};
// 2026-10-30 (round 2): the body a real board of each of the four answers with. Anything else (`{}`, `null`, an error
// object, `{"jobs": null}`, a Lever object where its list belongs) is not the board's list: the read fails and closes
// nothing. It used to read as an empty board and close every open posting the board had.
const isObj = (j: any) => !!j && typeof j === "object" && !Array.isArray(j);
const CORE_SHAPE: Record<string, (json: any) => boolean> = {
  greenhouse: (j) => isObj(j) && Array.isArray(j.jobs), lever: (j) => Array.isArray(j), ashby: (j) => isObj(j) && Array.isArray(j.jobs),
  smartrecruiters: (j) => isObj(j) && Array.isArray(j.content),
};
function coreShape(provider: string, json: any) {
  if (!CORE_SHAPE[provider]?.(json)) throw new Error(`not a ${provider} board (unexpected body)`);
}
const NOT_MODIFIED = Symbol("not modified");

// ------------------------------------------------------------------------------------------------ the pay a board states
// WO-069: the pay a board's public API states in its own structured fields, as text written from the API's own numbers,
// currency and period; null when it states none. Never estimated, never read from prose (posting_pay.ts reads the text).
//   greenhouse       pay_input_ranges[] {min_cents, max_cents, currency_type, title} (the list read with pay_transparency=true)
//   lever            salaryRange {min, max, currency, interval}
//   ashby            compensation.compensationTierSummary / scrapeableCompensationSalarySummary (includeCompensation=true)
//   smartrecruiters  its postings list carries no structured pay: null
export const PAY_MAX = 200; // the column's limit (20261022110000_career_postings_pay.sql)
const oneLine = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
// 2026-10-30 (round 2): the figure as the board states it: cents kept ($17.50 an hour was written "$18"), and a figure
// the board gives no currency for is written without one (it was written as dollars: a currency the board never said).
function money(v: unknown, currency: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0.995) return null; // a 0 or a missing figure is no figure
  const cur = oneLine(currency).toUpperCase();
  if (cur && !/^[A-Z]{3}$/.test(cur)) return null;
  const cents = Math.round(n * 100);
  const text = cents % 100 === 0 ? (cents / 100).toLocaleString("en-US") : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cur === "USD" ? "$" : cur ? `${cur} ` : ""}${text}`;
}
function span(lo: string | null, hi: string | null, loN: number, hiN: number): string | null {
  if (lo && hi) return hiN < loN ? null : lo === hi ? lo : `${lo}–${hi}`;
  return lo ? `from ${lo}` : hi ? `up to ${hi}` : null;
}
// Lever's intervals ("per-year-salary", "per-hour-wage") read as "per year", "per hour".
const LEVER_PER: Record<string, string> = { year: "per year", month: "per month", week: "per week", day: "per day", hour: "per hour" };
export function boardPay(provider: string, raw: any): string | null {
  try {
    if (provider === "greenhouse") {
      const parts: string[] = [];
      for (const r of Array.isArray(raw?.pay_input_ranges) ? raw.pay_input_ranges : []) {
        const loN = Number(r?.min_cents) / 100, hiN = Number(r?.max_cents) / 100;
        const s = span(money(loN, r?.currency_type), money(hiN, r?.currency_type), loN, hiN);
        if (!s) continue;
        const title = cut(oneLine(r?.title).replace(/[\s:;,.-]+$/, ""), 80).trim();
        const part = title ? `${s} (${title})` : s;
        if (parts.includes(part)) continue;
        if ([...parts, part].join("; ").length > PAY_MAX) break; // whole ranges only, never one cut in half
        parts.push(part);
      }
      return parts.length ? parts.join("; ") : null;
    }
    if (provider === "lever") {
      const r = raw?.salaryRange;
      if (!r || typeof r !== "object") return null;
      const loN = Number(r.min), hiN = Number(r.max);
      const s = span(money(r.min, r.currency), money(r.max, r.currency), loN, hiN);
      if (!s) return null;
      const iv = oneLine(r.interval).toLowerCase();
      const unit = /^per-(year|month|week|day|hour)\b/.exec(iv)?.[1];
      const per = unit ? LEVER_PER[unit] : iv.replace(/-/g, " ");
      return cut(`${s}${per ? ` ${per}` : ""}`, PAY_MAX);
    }
    if (provider === "ashby") {
      const c = raw?.compensation;
      const s = oneLine(c?.compensationTierSummary) || oneLine(c?.scrapeableCompensationSalarySummary);
      return s ? cut(s, PAY_MAX).trim() : null;
    }
  } catch { /* a malformed pay field is no pay field */ }
  return null;
}
// D-069 (real set item 13, finding 4): every pay zone a board states, as a structured array, so no zone is dropped. `pay` above
// stays the column's whole-range text (PAY_MAX); Robinhood's third zone (Lake Mary, FL: $130,000–$152,000) did not fit in it
// and was lost. Each zone is the board's own numbers, currency and period: `text` is written the way boardPay writes a part,
// `label` is the board's own zone title (its places), `min`/`max` its figures in its currency, `period` its interval as stated
// (null when the board states none). Never converted, never estimated. Stored in career_postings.pay_zones (migration
// 20261112130000).
export interface PayZone { text: string; label: string | null; currency: string | null; min: number | null; max: number | null; period: "year" | "month" | "week" | "day" | "hour" | null }
export const PAY_ZONES_MAX = 24;
const ASHBY_PER: Record<string, PayZone["period"]> = { "1 YEAR": "year", "1 MONTH": "month", "1 WEEK": "week", "1 DAY": "day", "1 HOUR": "hour" };
export function boardPayZones(provider: string, raw: any): PayZone[] {
  const out: PayZone[] = [];
  const put = (z: PayZone) => { if (out.length < PAY_ZONES_MAX && !out.some((x) => x.text === z.text)) out.push(z); };
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0.995 ? n : null; };
  const cur = (c: unknown) => { const x = oneLine(c).toUpperCase(); return /^[A-Z]{3}$/.test(x) ? x : null; };
  try {
    if (provider === "greenhouse") {
      for (const r of Array.isArray(raw?.pay_input_ranges) ? raw.pay_input_ranges : []) {
        const loN = Number(r?.min_cents) / 100, hiN = Number(r?.max_cents) / 100;
        const s = span(money(loN, r?.currency_type), money(hiN, r?.currency_type), loN, hiN);
        if (!s) continue;
        const label = cut(oneLine(r?.title).replace(/[\s:;,.-]+$/, ""), 160).trim() || null;
        put({ text: label ? `${s} (${label})` : s, label, currency: cur(r?.currency_type), min: num(loN), max: num(hiN), period: null });
      }
    } else if (provider === "lever") {
      const text = boardPay("lever", raw), r = raw?.salaryRange;
      if (text && r) put({ text, label: null, currency: cur(r.currency), min: num(r.min), max: num(r.max), period: (/^per-(year|month|week|day|hour)\b/.exec(oneLine(r.interval).toLowerCase())?.[1] ?? null) as PayZone["period"] });
    } else if (provider === "ashby") {
      for (const t of Array.isArray(raw?.compensation?.compensationTiers) ? raw.compensation.compensationTiers : []) {
        const text = cut(oneLine(t?.tierSummary), 300).trim();
        if (!text) continue;
        const sal = (Array.isArray(t?.components) ? t.components : []).find((c: any) => c?.compensationType === "Salary") ?? null;
        put({ text, label: cut(oneLine(t?.title), 160).trim() || null, currency: cur(sal?.currencyCode), min: num(sal?.minValue), max: num(sal?.maxValue), period: ASHBY_PER[oneLine(sal?.interval).toUpperCase()] ?? null });
      }
    }
  } catch { /* a malformed pay field is no pay field */ }
  return out;
}
// The list request each provider answers with its structured pay (Lever always includes salaryRange).
const PAY_QUERY: Record<string, string> = { greenhouse: "pay_transparency=true", ashby: "includeCompensation=true" };
const withPay = (provider: string, url: string) => PAY_QUERY[provider] ? `${url}${url.includes("?") ? "&" : "?"}${PAY_QUERY[provider]}` : url;

// bodyHash (Feature 6, the deployed function): every one-request read hashes its body; one equal to the board's last
// (Board.body_sha) is "not modified" and skips parsing and normalizing, which is most of a read's CPU (measured:
// scripts/career/measure-ingest-lane.ts). Every result is then a FeedRead carrying body_sha.
export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let h = "";
  for (const x of d) h += x.toString(16).padStart(2, "0");
  return h;
}
// 2026-10-30: the bounded read's limits (see streamRead).
export const PERSON_LINK_MAX_BYTES = 8 * 1024 * 1024; // the board read behind a link a person pasted (apply_here.ts)
export const BOARD_MAX_BYTES = 64 * 1024 * 1024; // a whole board's list read whole (not streamed): stopped beyond this
export const WHOLE_MAX = 2_000_000, XML_MAX = 8_000_000, STREAM_TIMEOUT_MS = 45000;
// Where each JSON provider's job array is: a key of the root object, or the root itself (null).
const CORE_ARRAY: Record<string, string | null> = { greenhouse: "jobs", lever: null, ashby: "jobs" };
export function boardFetchFeed(fetchFn: typeof fetch = fetch, opts: { userAgent?: string; timeoutMs?: number; bodyHash?: boolean; stream?: boolean; wholeMax?: number; wholeBytes?: number; personLink?: boolean; resolve?: Resolve } = {}): FetchFeed {
  const wholeBytes = opts.wholeBytes ?? (opts.personLink ? PERSON_LINK_MAX_BYTES : BOARD_MAX_BYTES);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  const timeoutMs = opts.timeoutMs ?? 15000;
  // Review of #775, round 2 (2026-11-13): a board read never follows a redirect unchecked (posting_fetch.ts guardedFetch:
  // redirect "manual", at most 3 hops, each https, on the host asked or a job board's own host, never a never-open site), and
  // a whole-body read stops at BOARD_MAX_BYTES (the streamed read below has its own bounds). The first address is built here
  // from the provider list (career_ingest_feeds.ts), so no name lookup is made for it.
  const guarded = async (url: string, init: RequestInit): Promise<Response> => {
    const hostOf = (h: string) => { try { return new URL(h).hostname.toLowerCase(); } catch { return ""; } };
    // Round 4: a scheduled ingest reads feeds the operator configured, and a board may redirect off its host (Recruitee to the
    // employer's careers domain, Personio .de to .com): any public https host that passes the refusals is followed (never a
    // never-open site, a reserved or private name, or a name that leads to a private address where a resolver exists). The
    // first address is built here from the provider list, so only the hops are looked up. A pasted link's read (personLink,
    // the chat path) stays on the host asked and the job boards' own hosts.
    return (await guardedFetch(fetchFn as any, url, init, opts.personLink ? { allow: (h) => boardHost(h) || hostOf(h) === hostOf(url), resolve: null } : { resolve: opts.resolve, trustFirst: true })).res;
  };
  // WO-037: `cond` sends the board's last validators (If-None-Match / If-Modified-Since); a 304 comes back as NOT_MODIFIED
  // (2026-10-30: it was null, so a board whose body was the JSON `null` read as "not modified").
  async function getJson(prov: string, url: string, deadline: number, cond?: Board, seen?: { etag?: string | null; last_modified?: string | null; body_sha?: string | null }): Promise<any> {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${timeoutMs / 1000}s`);
    const h: Record<string, string> = { ...headers };
    if (cond?.etag) h["if-none-match"] = cond.etag;
    if (cond?.last_modified) h["if-modified-since"] = cond.last_modified;
    let res: Response;
    try { res = await guarded(url, { headers: h, signal: AbortSignal.timeout(left) }); }
    catch (e) { throw new Error(e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
    if (seen) { seen.etag = res.headers.get("etag"); seen.last_modified = res.headers.get("last-modified"); }
    if (res.status === 304 && cond) { try { await res.body?.cancel(); } catch { /* already closed */ } return NOT_MODIFIED; }
    if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* already closed */ } throw new Error(`HTTP ${res.status}`); }
    const text = await cappedText(res, wholeBytes);
    if (opts.bodyHash && seen) {
      seen.body_sha = await sha256Hex(text);
      if (cond?.body_sha && cond.body_sha === seen.body_sha) return NOT_MODIFIED; // the same body as the last full read
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error(`not a ${prov} board (unexpected body)`); }
    coreShape(prov, data);
    return data;
  }
  // WO-044: a provider of career_ingest_feeds.ts. GET, or Workday's read-only search POST; paged where the provider
  // pages (past maxPages the read is partial and closes nothing); the conditional request applies to one-request GETs.
  // 2026-11-03 (round 3): `startPage`: a paged board read in parts over several runs starts its part there; `more` says the
  // read stopped at the page cap or the deadline with the list going on (the next part continues it), where a list that
  // moved under the read (`complete` false, `more` false) starts its pass again.
  async function readMore(b: Board, deadline: number, startPage = 0) {
    const spec = FEEDS[b.provider as keyof typeof FEEDS];
    let raw: any[] = [], complete = true, more = false, first: unknown = null, total: number | null = null, listed = 0, moved = false;
    const ids = new Set<string>();
    let validators: { etag: string | null; last_modified: string | null; body_sha?: string | null } | null = null;
    const lastPage = startPage + spec.maxPages;
    for (let page = startPage; page < lastPage; page++) {
      const rq = spec.request(b.board, page);
      const left = deadline - Date.now();
      // Out of time after the first page of a paged board: what was read is a partial read (it closes nothing).
      if (left <= 0 && page > startPage) { complete = false; more = true; break; }
      if (left <= 0) throw new Error(`timed out after ${timeoutMs / 1000}s`);
      const h: Record<string, string> = { ...headers, accept: rq.accept };
      const cond = spec.maxPages === 1 && rq.method === "GET";
      if (cond && b.etag) h["if-none-match"] = b.etag;
      if (cond && b.last_modified) h["if-modified-since"] = b.last_modified;
      if (rq.body) h["content-type"] = "application/json";
      let res: Response;
      try { res = await guarded(rq.url, { method: rq.method, headers: h, body: rq.body, signal: AbortSignal.timeout(left) }); }
      catch (e) {
        if (page > startPage) { complete = false; more = true; break; }
        throw new Error(e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
      if (res.status === 304 && cond && (b.etag || b.last_modified)) { try { await res.body?.cancel(); } catch { /* already closed */ } return null; }
      if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* already closed */ } throw new Error(`HTTP ${res.status}`); }
      if (cond) validators = { etag: res.headers.get("etag"), last_modified: res.headers.get("last-modified") };
      const text = await cappedText(res, wholeBytes);
      if (cond && opts.bodyHash) {
        const sha = await sha256Hex(text);
        if (b.body_sha && b.body_sha === sha) return { same: true as const, sha, validators };
        validators = { ...(validators ?? { etag: null, last_modified: null }), body_sha: sha };
      }
      const data = spec.parse(text);
      if (!spec.shape(data)) throw new Error(`not a ${b.provider} board (unexpected body)`);
      const got = spec.jobs(data);
      if (page === startPage) { first = data; total = spec.total(data, page); }
      if (spec.maxPages === 1) { raw.push(...got); break; }
      // 2026-10-30 (round 2): a paged board's ids are counted once. A page that repeats one an earlier page gave means the
      // list moved between pages (or the board ignores the offset and answers page one again): the read is partial and
      // closes nothing. Duplicates used to count toward the board's total, so the read looked complete and closed the rest.
      // (An id listed twice on one page is the board's own duplicate: kept once.)
      const before = new Set(ids);
      let added = 0, repeated = 0;
      for (const j of got) {
        if (!j || typeof j !== "object") continue;
        const id = spec.id(j);
        if (id && before.has(id)) { repeated++; continue; }
        listed++;
        if (id && ids.has(id)) continue;
        if (id) ids.add(id);
        raw.push(j); added++;
      }
      if (repeated) { complete = false; moved = true; }
      // 2026-11-03 (round 3): the list ends where a page comes back short, never where the board's total says: a total
      // that counts low ("total": 40 with 100 listed) used to end the read at 40 as complete, and the 60 never read closed.
      if (got.length < spec.pageSize || added === 0) break;
      if (page + 1 >= lastPage) { complete = false; more = !moved; }
    }
    // Round 3: fewer listed than the board's own total on a read from the top: a posting slid past the read while the list
    // moved (one taken down on page 1 moves page 2's first to page 1's end, never read), or the total counts what the list
    // does not show. Either way the read is not the whole list: it closes nothing.
    if (complete && startPage === 0 && total !== null && listed < total) complete = false;
    raw = raw.filter((j) => j && typeof j === "object");
    return { json: { name: spec.company(first), jobs: raw.map((j) => spec.toGreenhouse(j, b.board)) }, raw, complete, more: more && !moved, listed, validators };
  }
  // 2026-10-30, `stream` (the deployed function): a bounded read. A body up to WHOLE_MAX characters is read whole (hashed,
  // parsed once) and normalized a batch at a time as the run asks for it; a longer one is never held: its job array is
  // split element by element as it arrives (jsonArrayElements) and each batch normalized and handed on, the elements
  // before Board.offset counted and passed over unparsed. The run stops asking at its posting budget and the stream is
  // cancelled. An XML feed past XML_MAX fails the board with that reason. The paged readers (SmartRecruiters, Workday)
  // hold at most 1,000 short list entries and are batched after their read.
  async function streamRead(b: Board): Promise<FeedRead> {
    const offset = Math.max(0, Math.floor(Number(b.offset) || 0));
    const more = isMoreProvider(b.provider), spec = more ? FEEDS[b.provider as keyof typeof FEEDS] : null;
    if (b.provider === "smartrecruiters" || (spec && spec.maxPages > 1)) {
      // 2026-11-03 (round 3): a paged board larger than one read's pages (1,000 postings; fewer when the deadline comes
      // first) is read in parts over several runs, as a large one-request board is: this part starts at the page that
      // holds Board.offset, and one that stops with the list going on ends in a "more" read error, so the run records
      // where the next part starts (career_board_state pass_offset) and the part that ends the list closes what the pass
      // never saw. Such a board used to be read from page one every time, partial every time: its first 1,000 postings
      // only, and nothing it took down ever closed.
      const pageSize = b.provider === "smartrecruiters" ? SR_PAGE : spec!.pageSize;
      const startPage = Math.floor(offset / pageSize), skip = offset - startPage * pageSize;
      const r = await legacy(b, startPage);
      const read: FeedRead & { more?: boolean; listed?: number } = Array.isArray(r) ? { postings: r, complete: true } : r;
      if (read.not_modified) return read;
      const all = read.postings, more = !!read.more, listed = read.listed ?? all.length;
      const { more: _m, listed: _l, ...rest } = read;
      return { ...rest, complete: more ? true : read.complete, postings: [], batches: (async function* () {
        let given = 0;
        for (let i = skip; i < all.length; i += INGEST_BATCH) { const s = all.slice(i, i + INGEST_BATCH); given += s.length; yield { postings: s, consumed: s.length }; }
        // Entries a board listed that make no posting (no title, no link) still count toward where the next part starts.
        const left = Math.max(0, listed - skip - given);
        if (left) yield { postings: [], consumed: left };
        if (more) throw new Error(`more of the board than one read: the next part starts at ${offset + Math.max(0, listed - skip)}`);
      })() };
    }
    const core = more ? null : { feed: (CareerJobs.feeds as any)[b.provider], normalize: ({ greenhouse: CareerJobs.normalizeGreenhouse, lever: CareerJobs.normalizeLever, ashby: CareerJobs.normalizeAshby } as any)[b.provider] };
    if (core && (!core.feed || !core.normalize)) throw new Error(`provider ${b.provider} is not supported`);
    const rq = spec ? spec.request(b.board, 0) : { url: withPay(b.provider, core!.feed(b.board).url as string), method: "GET" as const, accept: "application/json", body: undefined };
    const xml = !!spec && spec.arrayKey === undefined;
    const h: Record<string, string> = { ...headers, accept: rq.accept };
    if (b.etag) h["if-none-match"] = b.etag;
    if (b.last_modified) h["if-modified-since"] = b.last_modified;
    // One timer for the request and its body: timeoutMs to the first WHOLE_MAX characters, STREAM_TIMEOUT_MS for a body
    // read as a stream (its batches are written while it arrives); cleared whichever way the read ends.
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    const stop = () => clearTimeout(timer);
    let streaming = false;
    try {
      let res: Response;
      try { res = await guarded(rq.url, { method: rq.method, headers: h, signal: ctl.signal }); }
      catch (e) { throw new Error(ctl.signal.aborted || (e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`)) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
      const notModified = { postings: [], complete: false, not_modified: true as const, etag: b.etag ?? null, last_modified: b.last_modified ?? null, ...(opts.bodyHash ? { body_sha: b.body_sha ?? null } : {}) };
      if (res.status === 304 && (b.etag || b.last_modified)) { try { await res.body?.cancel(); } catch { /* closed */ } return notModified; }
      if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* closed */ } throw new Error(`HTTP ${res.status}`); }
      const etag = res.headers.get("etag"), lastModified = res.headers.get("last-modified");
      let body;
      try { body = await readBody(res, xml ? XML_MAX : opts.wholeMax ?? WHOLE_MAX); }
      catch (e) { throw new Error(ctl.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
      // A board's own name, then each slice of its jobs -> postings (the provider's normalizer, as the whole read does).
      const norm = (slice: any[], root: Record<string, unknown>, company: string | null): FeedPosting[] => {
        // Round 3: a script or style block in any field is not the posting's text (posting_text.ts scrubRaw).
        if (spec) return toPostings(b, CareerJobs.normalizeGreenhouse({ name: company, jobs: slice.map((j) => scrubRaw(spec.toGreenhouse(j, b.board))) }, b.board, b.company), slice);
        const clean = slice.map((j) => scrubRaw(j));
        const json = b.provider === "lever" ? clean : { ...root, jobs: clean };
        return toPostings(b, core!.normalize(json, b.board, b.company), slice);
      };
      if (body.text !== null) {
        stop();
        const text = body.text;
        const sha = opts.bodyHash ? await sha256Hex(text) : null;
        if (sha && b.body_sha && b.body_sha === sha) return { ...notModified, etag: etag ?? b.etag ?? null, last_modified: lastModified ?? b.last_modified ?? null, body_sha: sha };
        let data: any;
        if (spec) { data = spec.parse(text); if (!spec.shape(data)) throw new Error(`not a ${b.provider} board (unexpected body)`); }
        else { try { data = JSON.parse(text); } catch { throw new Error(`not a ${b.provider} board (unexpected body)`); } coreShape(b.provider, data); }
        const raw = (spec ? spec.jobs(data) : rawJobs[b.provider](data)).filter((j: any) => j && typeof j === "object");
        const company = spec ? spec.company(data) : null, root = spec || Array.isArray(data) ? {} : { name: data?.name };
        return { postings: [], complete: true, etag, last_modified: lastModified, ...(opts.bodyHash ? { body_sha: sha } : {}),
          batches: (async function* () { for (let i = offset; i < raw.length; i += INGEST_BATCH) { const s = raw.slice(i, i + INGEST_BATCH); yield { postings: norm(s, root, company), consumed: s.length }; } })() };
      }
      if (xml) { try { await body.rest?.[Symbol.asyncIterator]().return?.(undefined); } catch { /* closed */ } throw new Error(`body over ${XML_MAX / 1e6} MB: too large to read`); }
      streaming = true;
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error("timed out")), STREAM_TIMEOUT_MS);
      const key = spec ? spec.arrayKey! : CORE_ARRAY[b.provider];
      const scan: ArrayScan = { found: false, done: false, root: {}, counted: 0 };
      const provider = b.provider;
      const batches = (async function* () {
        let batch: any[] = [], tried = 0, company: string | null | undefined;
        const out = () => {
          if (spec && company === undefined) company = spec.company(key ? { ...scan.root, [key]: batch } : batch);
          const r = { postings: norm(batch, scan.root, company ?? null), consumed: tried };
          batch = []; tried = 0;
          return r;
        };
        try {
          for await (const text of jsonArrayElements(chunksOf(body), key, offset, scan)) {
            tried++;
            try { const j = JSON.parse(text); if (j && typeof j === "object") batch.push(j); } catch { /* not a job: counted, dropped */ }
            if (tried >= INGEST_BATCH) yield out();
          }
          if (!scan.found) throw new Error(`not a ${provider} board (unexpected body)`);
          // 2026-10-30 (round 2): a body that ends inside its job list is not the whole list (it used to read as complete
          // and close every posting past the cut).
          if (!scan.done) throw new Error(`not a ${provider} board (the body ended inside its job list)`);
          if (tried) yield out();
        } catch (e) {
          throw new Error(ctl.signal.aborted ? `timed out reading the body after ${STREAM_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : String(e));
        } finally { stop(); }
      })();
      return { postings: [], complete: true, etag, last_modified: lastModified, ...(opts.bodyHash ? { body_sha: null } : {}), batches };
    } finally {
      if (!streaming) stop();
    }
  }
  const legacy = async (b: Board, startPage = 0): Promise<FeedPosting[] | (FeedRead & { more?: boolean; listed?: number })> => {
    if (isMoreProvider(b.provider)) {
      const r = await readMore(b, Date.now() + timeoutMs, startPage);
      if (r === null) return { postings: [], complete: false, not_modified: true, etag: b.etag ?? null, last_modified: b.last_modified ?? null, ...(opts.bodyHash ? { body_sha: b.body_sha ?? null } : {}) };
      if ("same" in r) return { postings: [], complete: false, not_modified: true, etag: r.validators?.etag ?? b.etag ?? null, last_modified: r.validators?.last_modified ?? b.last_modified ?? null, body_sha: r.sha };
      const postings = toPostings(b, CareerJobs.normalizeGreenhouse({ ...r.json, jobs: r.json.jobs.map((j) => scrubRaw(j)) }, b.board, b.company), r.raw);
      const part = startPage > 0 || r.more ? { more: r.more, listed: r.listed } : {};
      if (opts.bodyHash || (r.validators && (r.validators.etag || r.validators.last_modified))) return { postings, complete: r.complete, ...part, etag: r.validators?.etag ?? null, last_modified: r.validators?.last_modified ?? null, ...(opts.bodyHash ? { body_sha: r.validators?.body_sha ?? null } : {}) };
      return r.complete && !part.more && startPage === 0 ? postings : { postings, complete: r.complete, ...part };
    }
    const feed = (CareerJobs.feeds as any)[b.provider];
    const normalize = ({ greenhouse: CareerJobs.normalizeGreenhouse, lever: CareerJobs.normalizeLever, ashby: CareerJobs.normalizeAshby, smartrecruiters: CareerJobs.normalizeSmartRecruiters } as any)[b.provider];
    if (!feed || !normalize) throw new Error(`provider ${b.provider} is not supported`);
    const deadline = Date.now() + timeoutMs;
    const base = withPay(b.provider, feed(b.board).url as string);
    let raw: any[] = [], complete = true, more = false, listed = 0, json: any, validators: { etag: string | null; last_modified: string | null; body_sha?: string | null } | null = null;
    if (b.provider === "smartrecruiters") {
      // 2026-10-30 (round 2): ids are counted once. A page that repeats one already read means the list moved (or the
      // board pages in a loop): what was read is partial and closes nothing. Duplicates used to count toward totalFound,
      // so the read looked complete and the postings never read were closed.
      // Round 3: the list ends at a short page, never at totalFound (a total that counts low closed what was never read);
      // fewer listed than totalFound on a read from the top is not the whole list; `startPage`: a part of a pass.
      const ids = new Set<string>();
      let total = NaN, moved = false;
      for (let page = startPage; ; page++) {
        let j: any;
        try { j = await getJson("smartrecruiters", `${base}?limit=${SR_PAGE}&offset=${page * SR_PAGE}`, deadline); }
        catch (e) { if (page > startPage) { complete = false; more = true; break; } throw e; }
        if (page === startPage) total = Number(j && j.totalFound);
        const got = rawJobs.smartrecruiters(j).filter((x: any) => x && typeof x === "object");
        const before = new Set(ids); // an id twice on one page is the board's own duplicate (kept once), not a moved list
        let added = 0, repeated = 0;
        for (const x of got) {
          const id = String(RAW_ID.smartrecruiters(x) ?? "");
          if (id && before.has(id)) { repeated++; continue; }
          listed++;
          if (id && ids.has(id)) continue;
          if (id) ids.add(id);
          raw.push(x); added++;
        }
        json = { ...j, content: raw };
        if (repeated) { complete = false; moved = true; }
        if (got.length < SR_PAGE || added === 0) break;
        if (page + 1 >= startPage + SR_MAX_PAGES) { complete = false; more = !moved; break; }
      }
      if (moved) more = false;
      if (complete && startPage === 0 && Number.isFinite(total) && listed < total) complete = false;
    } else {
      // One request per board: the conditional request applies (SmartRecruiters pages, so it reads in full).
      const seen: { etag?: string | null; last_modified?: string | null; body_sha?: string | null } = {};
      json = await getJson(b.provider, base, deadline, b, seen);
      if (json === NOT_MODIFIED) return { postings: [], complete: false, not_modified: true, etag: b.etag ?? seen.etag ?? null, last_modified: b.last_modified ?? seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? b.body_sha ?? null } : {}) };
      raw = rawJobs[b.provider](json);
      validators = { etag: seen.etag ?? null, last_modified: seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? null } : {}) };
    }
    const clean = raw.map((j) => scrubRaw(j)); // round 3: scripts out of every field before the normalizer reads it
    const cleanJson = b.provider === "lever" ? clean : b.provider === "smartrecruiters" ? { ...json, content: clean } : { ...json, jobs: clean };
    const postings = toPostings(b, normalize(cleanJson, b.board, b.company), raw);
    const part = startPage > 0 || more ? { more, listed } : {};
    if (opts.bodyHash) return { postings, complete, ...part, etag: validators?.etag ?? null, last_modified: validators?.last_modified ?? null, body_sha: validators?.body_sha ?? null };
    if (validators && (validators.etag || validators.last_modified)) return { postings, complete, ...part, ...validators };
    return complete && !more && startPage === 0 ? postings : { postings, complete, ...part };
  };
  return opts.stream ? streamRead : legacy;
}
// One read's normalized jobs -> the rows the table takes. Every row must fit the table's constraints
// (20261019000000_career_postings.sql): one bad row would otherwise fail its board's write on every run. A posting
// without an https link or a title is not a job anyone can apply to.
function toPostings(b: Board, normalized: any[], raw: any[]): FeedPosting[] {
    const token = b.board.toLowerCase();
    const postings: FeedPosting[] = [];
    // 2026-10-30 (round 2): every text the table takes is text Postgres stores (no NUL, no lone surrogate) and every
    // length limit ends between characters, never inside an emoji: one such posting used to fail its board's write and,
    // as a storage error that was not transient, the whole lane run, every tick. An id or a link with a control character
    // or a space is not a usable id or link: the posting is left out.
    normalized.forEach((p, i) => {
      const atsId = String(RAW_ID[b.provider](raw[i]) ?? "");
      // 2026-11-03 (round 3): a short field is stored as the plain text the board meant: no tag, no entity, no script, no
      // bidi override (posting_text.ts plainLine). "<b>Senior</b> Data Analyst" and "R&amp;D" used to be stored as written.
      const title = plainLine(p.title, 500), url = String(p.url || "");
      if (!atsId || !title || !/^https:\/\//.test(url) || url.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(url) || storable(url) !== url) return;
      if (/[\u0000-\u001f\u007f]/.test(atsId) || storable(atsId) !== atsId || atsId.length > 1000) return;
      const description = cut(decodeEntities(storable(p.jd_text || "")), MAX_DESCRIPTION);
      const pay = boardPay(b.provider, raw[i]);
      postings.push({
        job_id: `${b.provider}:${token}:${atsId}`, ats_id: atsId, company: plainLine(p.company || b.company, 300) || b.board, title,
        location: plainLine(p.location, 1000), url, description,
        department: plainLine(p.department, 300), posted_at: p.posted_at || null, remote: p.remote, role_family: p.role_family, seniority_band: p.seniority_band,
        apply_email: applyEmailOf({ description, url }), pay: pay === null ? null : cut(storable(pay), PAY_MAX) || null,
        pay_zones: (() => { const z = boardPayZones(b.provider, raw[i]).map((x) => ({ ...x, text: storable(x.text), label: x.label === null ? null : storable(x.label) })); return z.length ? z : null; })(),
      });
    });
    return postings;
}

// ------------------------------------------------------------------------------------------------ the directory
export function directoryBoards(dir: { boards?: any[] }): Board[] {
  const seen = new Set<string>(), out: Board[] = [];
  for (const e of dir.boards || []) {
    if (e.status !== "live" || !RAW_ID[e.provider] || !e.board_token) continue;
    const key = `${e.provider}:${String(e.board_token).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ company: String(e.company || e.board_token), provider: e.provider, board: String(e.board_token) });
  }
  return out;
}
