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
// Feature 6: the posting URL-shape guard (packages/domain/166-career-url-shape.js, MUSE-F-010), copied byte for byte
// (tests/edge/career-ingest-scale.test.ts fails while the copy is stale). It sets globalThis.CareerUrlShape.
import "./career_url_shape.js";
import { chunksOf, cut, idChunks, jsonArrayElements, readBody, rowContentError, storable, transientStorageError, type ArrayScan } from "./career_ingest_stream.ts";

// etag / last_modified: what the board's last full read answered (career_board_state, WO-037), sent back as a conditional
// request; absent on the cursor path.
// body_sha (Feature 6): the SHA-256 of the body the board's last full read answered; a board whose body is the same again
// is not parsed or normalized (read as "not modified"), the way a 304 is. Only with boardFetchFeed's bodyHash option.
// offset / pass_started_at (2026-10-30): a board too large to read inside one run's posting budget is read in parts over
// several runs; `offset` is where this part starts (the board's job list, counted in job objects), `pass_started_at` when
// the pass that part belongs to began (its first part). Absent: a read from the start.
// gone_reads (2026-10-30, ingest round 2): how many reads in a row before this one the board answered 404 / 410 (it no
// longer exists at the ATS); at GONE_AFTER the board's open postings are closed (they are gone with it).
export interface Board { company: string; provider: string; board: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null; offset?: number | null; pass_started_at?: string | null; gone_reads?: number | null }
export interface FeedPosting {
  job_id: string; company: string; title: string; location?: string; url: string; description?: string;
  ats_id?: string; department?: string; posted_at?: string | null; remote?: string; role_family?: string; seniority_band?: string;
  apply_email?: string | null; // WO-032: the address the posting asks applications to be emailed to (apply_email.ts)
  pay?: string | null; // WO-069: the pay the board states in its own structured fields (boardPay), or null
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
export interface BoardOutcome { status: "ok" | "partial" | "not_modified" | "failed"; error?: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null; next_offset?: number | null; pass_started_at?: string | null; gone_reads?: number; gone_closed?: number }
// A board that answers 404 / 410 on this many reads in a row is gone: its open postings are closed (never left listed as
// open for ever), and it is read again only on the failure backoff (career_shards.ts retryAfterMs), not every window.
export const GONE_AFTER = 3;
export const goneAnswer = (error: string) => /^HTTP (404|410)$/.test(error);
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
const CONTENT = ["company", "title", "location", "url", "description", "department", "posted_at", "ats_id", "remote", "role_family", "seniority_band", "apply_email", "pay"] as const;
// Postgres hands timestamps back in its own format ("+00:00"), so a time compares as a time.
const sameValue = (k: string, x: any, y: any) => k === "posted_at" ? (x ? Date.parse(x) : null) === (y ? Date.parse(y) : null) : (x ?? (TEXT_DEFAULTS.has(k) ? "" : null)) === (y ?? (TEXT_DEFAULTS.has(k) ? "" : null));
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

    const seen = new Set<string>();
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
      const writes: Posting[] = [], touched: string[] = [], needWhole: FeedPosting[] = [];
      const due = (old: { last_seen_at: string }) => o.now - Date.parse(old.last_seen_at) >= touchAfterMs;
      if (o.db.known) {
        const known = new Map((await store(() => o.db.known!([...fresh.keys()]))).map((p) => [p.job_id, p]));
        for (const p of fresh.values()) {
          const old = known.get(p.job_id);
          if (!old) { st.new++; writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null }); continue; }
          if (old.closed_at) st.reopened++; else st.seen++;
          if (!old.closed_at && sameKnown(old, p, await sha256Hex(p.description ?? ""))) { if (due(old)) touched.push(p.job_id); continue; }
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
        for (const p of fresh.values()) {
          const old = known.get(p.job_id);
          if (!old) { st.new++; writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null }); continue; }
          if (old.closed_at) st.reopened++; else st.seen++;
          if (!old.closed_at && same(old, p)) { if (due(old)) touched.push(p.job_id); continue; }
          writes.push({ ...old, ...p, provider: b.provider, board: b.board, first_seen_at: old.first_seen_at, last_seen_at: later(now, old.last_seen_at), closed_at: null });
        }
      }
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
      await o.onBoard?.(b0, { status: "partial", ...validators, body_sha: null, next_offset: nextOffset, pass_started_at: passStarted });
      return;
    }
    const complete = r.complete;
    try {
      if (complete && offset === 0) {
        const open = await store(() => o.db.openForBoard(b));
        const gone = open.map((p) => p.job_id).filter((id) => !seen.has(id));
        if (gone.length) {
          await store(() => o.db.close(gone, now));
          st.closed += gone.length;
          if (gone.length >= 20 && gone.length * 2 >= open.length) st.large_closes.push({ board: b.board, provider: b.provider, closed: gone.length, was_open: open.length });
        }
      } else if (complete && o.db.staleForBoard) {
        // The last part of a pass read over several runs: what no part saw is gone. A posting an earlier part saw was written
        // or touched then, or had been touched less than touchAfterMs before (so after pass start - touchAfterMs).
        const before = new Date(Date.parse(passStarted) - touchAfterMs).toISOString();
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
  "posted_at", "remote", "role_family", "seniority_band", "apply_email", "pay", "first_seen_at", "last_seen_at", "closed_at"] as const;
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
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(t: string): string {
  let out = t;
  for (let i = 0; i < 3 && /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out); i++) {
    out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }
  return out.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
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
export const WHOLE_MAX = 2_000_000, XML_MAX = 8_000_000, STREAM_TIMEOUT_MS = 45000;
// Where each JSON provider's job array is: a key of the root object, or the root itself (null).
const CORE_ARRAY: Record<string, string | null> = { greenhouse: "jobs", lever: null, ashby: "jobs" };
export function boardFetchFeed(fetchFn: typeof fetch = fetch, opts: { userAgent?: string; timeoutMs?: number; bodyHash?: boolean; stream?: boolean; wholeMax?: number } = {}): FetchFeed {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  const timeoutMs = opts.timeoutMs ?? 15000;
  // WO-037: `cond` sends the board's last validators (If-None-Match / If-Modified-Since); a 304 comes back as NOT_MODIFIED
  // (2026-10-30: it was null, so a board whose body was the JSON `null` read as "not modified").
  async function getJson(prov: string, url: string, deadline: number, cond?: Board, seen?: { etag?: string | null; last_modified?: string | null; body_sha?: string | null }): Promise<any> {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${timeoutMs / 1000}s`);
    const h: Record<string, string> = { ...headers };
    if (cond?.etag) h["if-none-match"] = cond.etag;
    if (cond?.last_modified) h["if-modified-since"] = cond.last_modified;
    let res: Response;
    try { res = await fetchFn(url, { headers: h, signal: AbortSignal.timeout(left) }); }
    catch (e) { throw new Error(e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
    if (seen) { seen.etag = res.headers.get("etag"); seen.last_modified = res.headers.get("last-modified"); }
    if (res.status === 304 && cond) { try { await res.body?.cancel(); } catch { /* already closed */ } return NOT_MODIFIED; }
    if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* already closed */ } throw new Error(`HTTP ${res.status}`); }
    const text = await res.text();
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
  async function readMore(b: Board, deadline: number) {
    const spec = FEEDS[b.provider as keyof typeof FEEDS];
    let raw: any[] = [], complete = true, first: unknown = null, total: number | null = null;
    const ids = new Set<string>();
    let validators: { etag: string | null; last_modified: string | null; body_sha?: string | null } | null = null;
    for (let page = 0; page < spec.maxPages; page++) {
      const rq = spec.request(b.board, page);
      const left = deadline - Date.now();
      // Out of time after the first page of a paged board: what was read is a partial read (it closes nothing).
      if (left <= 0 && page > 0) { complete = false; break; }
      if (left <= 0) throw new Error(`timed out after ${timeoutMs / 1000}s`);
      const h: Record<string, string> = { ...headers, accept: rq.accept };
      const cond = spec.maxPages === 1 && rq.method === "GET";
      if (cond && b.etag) h["if-none-match"] = b.etag;
      if (cond && b.last_modified) h["if-modified-since"] = b.last_modified;
      if (rq.body) h["content-type"] = "application/json";
      let res: Response;
      try { res = await fetchFn(rq.url, { method: rq.method, headers: h, body: rq.body, signal: AbortSignal.timeout(left) }); }
      catch (e) {
        if (page > 0) { complete = false; break; }
        throw new Error(e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
      if (res.status === 304 && cond && (b.etag || b.last_modified)) { try { await res.body?.cancel(); } catch { /* already closed */ } return null; }
      if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* already closed */ } throw new Error(`HTTP ${res.status}`); }
      if (cond) validators = { etag: res.headers.get("etag"), last_modified: res.headers.get("last-modified") };
      const text = await res.text();
      if (cond && opts.bodyHash) {
        const sha = await sha256Hex(text);
        if (b.body_sha && b.body_sha === sha) return { same: true as const, sha, validators };
        validators = { ...(validators ?? { etag: null, last_modified: null }), body_sha: sha };
      }
      const data = spec.parse(text);
      if (!spec.shape(data)) throw new Error(`not a ${b.provider} board (unexpected body)`);
      const got = spec.jobs(data);
      if (page === 0) { first = data; total = spec.total(data, 0); }
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
        if (id && ids.has(id)) continue;
        if (id) ids.add(id);
        raw.push(j); added++;
      }
      if (repeated) complete = false;
      if (got.length < spec.pageSize || added === 0 || (total !== null && ids.size >= total)) break;
      if (page + 1 >= spec.maxPages) complete = false;
    }
    raw = raw.filter((j) => j && typeof j === "object");
    return { json: { name: spec.company(first), jobs: raw.map((j) => spec.toGreenhouse(j, b.board)) }, raw, complete, validators };
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
      const r = await legacy(b);
      const read: FeedRead = Array.isArray(r) ? { postings: r, complete: true } : r;
      if (read.not_modified) return read;
      const all = read.postings;
      return { ...read, postings: [], batches: (async function* () { for (let i = offset; i < all.length; i += INGEST_BATCH) { const s = all.slice(i, i + INGEST_BATCH); yield { postings: s, consumed: s.length }; } })() };
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
      try { res = await fetchFn(rq.url, { method: rq.method, headers: h, signal: ctl.signal }); }
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
        if (spec) return toPostings(b, CareerJobs.normalizeGreenhouse({ name: company, jobs: slice.map((j) => spec.toGreenhouse(j, b.board)) }, b.board, b.company), slice);
        const json = b.provider === "lever" ? slice : { ...root, jobs: slice };
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
  const legacy = async (b: Board): Promise<FeedPosting[] | FeedRead> => {
    if (isMoreProvider(b.provider)) {
      const r = await readMore(b, Date.now() + timeoutMs);
      if (r === null) return { postings: [], complete: false, not_modified: true, etag: b.etag ?? null, last_modified: b.last_modified ?? null, ...(opts.bodyHash ? { body_sha: b.body_sha ?? null } : {}) };
      if ("same" in r) return { postings: [], complete: false, not_modified: true, etag: r.validators?.etag ?? b.etag ?? null, last_modified: r.validators?.last_modified ?? b.last_modified ?? null, body_sha: r.sha };
      const postings = toPostings(b, CareerJobs.normalizeGreenhouse(r.json, b.board, b.company), r.raw);
      if (opts.bodyHash || (r.validators && (r.validators.etag || r.validators.last_modified))) return { postings, complete: r.complete, etag: r.validators?.etag ?? null, last_modified: r.validators?.last_modified ?? null, ...(opts.bodyHash ? { body_sha: r.validators?.body_sha ?? null } : {}) };
      return r.complete ? postings : { postings, complete: false };
    }
    const feed = (CareerJobs.feeds as any)[b.provider];
    const normalize = ({ greenhouse: CareerJobs.normalizeGreenhouse, lever: CareerJobs.normalizeLever, ashby: CareerJobs.normalizeAshby, smartrecruiters: CareerJobs.normalizeSmartRecruiters } as any)[b.provider];
    if (!feed || !normalize) throw new Error(`provider ${b.provider} is not supported`);
    const deadline = Date.now() + timeoutMs;
    const base = withPay(b.provider, feed(b.board).url as string);
    let raw: any[] = [], complete = true, json: any, validators: { etag: string | null; last_modified: string | null; body_sha?: string | null } | null = null;
    if (b.provider === "smartrecruiters") {
      // 2026-10-30 (round 2): ids are counted once. A page that repeats one already read means the list moved (or the
      // board pages in a loop): what was read is partial and closes nothing. Duplicates used to count toward totalFound,
      // so the read looked complete and the postings never read were closed.
      const ids = new Set<string>();
      for (let page = 0; ; page++) {
        const j = await getJson("smartrecruiters", `${base}?limit=${SR_PAGE}&offset=${page * SR_PAGE}`, deadline);
        const got = rawJobs.smartrecruiters(j).filter((x: any) => x && typeof x === "object");
        const before = new Set(ids); // an id twice on one page is the board's own duplicate (kept once), not a moved list
        let added = 0, repeated = 0;
        for (const x of got) {
          const id = String(RAW_ID.smartrecruiters(x) ?? "");
          if (id && before.has(id)) { repeated++; continue; }
          if (id && ids.has(id)) continue;
          if (id) ids.add(id);
          raw.push(x); added++;
        }
        json = { ...j, content: raw };
        if (repeated) complete = false;
        const total = Number(j && j.totalFound);
        if (got.length < SR_PAGE || added === 0 || (Number.isFinite(total) && ids.size >= total)) break;
        if (page + 1 >= SR_MAX_PAGES) { complete = false; break; }
      }
    } else {
      // One request per board: the conditional request applies (SmartRecruiters pages, so it reads in full).
      const seen: { etag?: string | null; last_modified?: string | null; body_sha?: string | null } = {};
      json = await getJson(b.provider, base, deadline, b, seen);
      if (json === NOT_MODIFIED) return { postings: [], complete: false, not_modified: true, etag: b.etag ?? seen.etag ?? null, last_modified: b.last_modified ?? seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? b.body_sha ?? null } : {}) };
      raw = rawJobs[b.provider](json);
      validators = { etag: seen.etag ?? null, last_modified: seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? null } : {}) };
    }
    const postings = toPostings(b, normalize(json, b.board, b.company), raw);
    if (opts.bodyHash) return { postings, complete, etag: validators?.etag ?? null, last_modified: validators?.last_modified ?? null, body_sha: validators?.body_sha ?? null };
    if (validators && (validators.etag || validators.last_modified)) return { postings, complete, ...validators };
    return complete ? postings : { postings, complete };
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
    const safeClip = (v: unknown, n: number) => cut(storable(v).replace(/\s+/g, " ").trim(), n).trim();
    normalized.forEach((p, i) => {
      const atsId = String(RAW_ID[b.provider](raw[i]) ?? "");
      const title = safeClip(p.title, 500), url = String(p.url || "");
      if (!atsId || !title || !/^https:\/\//.test(url) || url.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(url) || storable(url) !== url) return;
      if (/[\u0000-\u001f\u007f]/.test(atsId) || storable(atsId) !== atsId || atsId.length > 1000) return;
      const description = cut(decodeEntities(storable(p.jd_text || "")), MAX_DESCRIPTION);
      const pay = boardPay(b.provider, raw[i]);
      postings.push({
        job_id: `${b.provider}:${token}:${atsId}`, ats_id: atsId, company: safeClip(p.company || b.company, 300) || b.board, title,
        location: safeClip(p.location, 1000), url, description,
        department: safeClip(p.department, 300), posted_at: p.posted_at || null, remote: p.remote, role_family: p.role_family, seniority_band: p.seniority_band,
        apply_email: applyEmailOf({ description, url }), pay: pay === null ? null : cut(storable(pay), PAY_MAX) || null,
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
