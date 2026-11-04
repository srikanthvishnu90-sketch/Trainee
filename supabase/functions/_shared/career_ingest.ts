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

// etag / last_modified: what the board's last full read answered (career_board_state, WO-037), sent back as a conditional
// request; absent on the cursor path.
// body_sha (Feature 6): the SHA-256 of the body the board's last full read answered; a board whose body is the same again
// is not parsed or normalized (read as "not modified"), the way a 304 is. Only with boardFetchFeed's bodyHash option.
export interface Board { company: string; provider: string; board: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null }
export interface FeedPosting {
  job_id: string; company: string; title: string; location?: string; url: string; description?: string;
  ats_id?: string; department?: string; posted_at?: string | null; remote?: string; role_family?: string; seniority_band?: string;
  apply_email?: string | null; // WO-032: the address the posting asks applications to be emailed to (apply_email.ts)
  pay?: string | null; // WO-069: the pay the board states in its own structured fields (boardPay), or null
}
// A feed returns its postings; `complete: false` says the board has more than was read (closes nothing). WO-037:
// `not_modified` says the board answered 304 to a conditional request (nothing changed since the last read); etag and
// last_modified are the validators a full read answered with, kept for the next conditional request.
export interface FeedRead { postings: FeedPosting[]; complete: boolean; not_modified?: boolean; etag?: string | null; last_modified?: string | null; body_sha?: string | null }
export type FetchFeed = (b: Board) => Promise<FeedPosting[] | FeedRead>;
// What happened to one board in a run (WO-037: the sharded scheduler records it in career_board_state).
export interface BoardOutcome { status: "ok" | "partial" | "not_modified" | "failed"; error?: string; etag?: string | null; last_modified?: string | null; body_sha?: string | null }
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
}
export interface IngestStats {
  boards_ok: number; boards_failed: number; boards_partial: number; new: number; seen: number; reopened: number; closed: number;
  boards_not_modified?: number; // WO-037: answered 304 to a conditional request
  // Feature 6: postings refused at ingest because their link is never a posting (a data/API endpoint, a discussion
  // thread, a search or board page, not a URL), by shape; and links kept but of no recognized posting grammar.
  url_rejected?: number; url_rejected_shapes?: Record<string, number>; url_unknown?: number;
  postings_read?: number; // Feature 6: postings parsed this run (the CPU proxy postingBudget counts)
  stopped_by?: "deadline" | "posting_budget"; // why boards were left for the next run, when any were
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

// `deadline` (epoch ms): boards not started by then wait for the next run; the cursor moves only past boards attempted.
// `clock`: what the deadline is checked against (default Date.now). The caller passes the clock it built the deadline
// from, so a deadline and its check never come from two different clocks.
// `touchAfterMs`: an unchanged posting's last_seen_at is rewritten only once it is this old (0 = every run). The scheduled
// run uses hours, so tens of thousands of unchanged postings are not rewritten every few minutes.
// `useCursor: false` (WO-037, the sharded scheduler): read `boards` in the order given, from the first, and leave the
// cursor alone; `onBoard` hears each attempted board's outcome.
export async function ingestBoards(o: { boards: Board[]; fetchFeed: FetchFeed; db: PostingsDb; now: number; maxBoards?: number; concurrency?: number; deadline?: number; clock?: () => number; touchAfterMs?: number; useCursor?: boolean; onBoard?: (b: Board, r: BoardOutcome) => void; postingBudget?: number }): Promise<IngestStats & { attempted: number }> {
  const now = new Date(o.now).toISOString(), n = o.boards.length, clock = o.clock || Date.now;
  const st = { boards_ok: 0, boards_failed: 0, boards_partial: 0, new: 0, seen: 0, reopened: 0, closed: 0, failures: [], large_closes: [], attempted: 0 } as IngestStats & { attempted: number };
  if (!n) return st;
  const take = Math.max(1, Math.min(o.maxBoards ?? n, n));
  const useCursor = o.useCursor !== false;
  const start = useCursor ? ((await o.db.getCursor()) % n + n) % n : 0;
  const pick = Array.from({ length: take }, (_, i) => o.boards[(start + i) % n]);

  async function one(b: Board) {
    let list: FeedPosting[], complete = true, validators: { etag?: string | null; last_modified?: string | null; body_sha?: string | null } = {};
    try {
      const r = await o.fetchFeed(b);
      if (Array.isArray(r)) list = r;
      else {
        list = r.postings; complete = r.complete; validators = { etag: r.etag ?? null, last_modified: r.last_modified ?? null, ...(r.body_sha !== undefined ? { body_sha: r.body_sha } : {}) };
        // Nothing changed since the last full read: nothing to write, nothing to close.
        if (r.not_modified) { st.boards_ok++; st.boards_not_modified = (st.boards_not_modified ?? 0) + 1; o.onBoard?.(b, { status: "not_modified", ...validators }); return; }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      st.boards_failed++;
      st.failures.push({ board: b.board, provider: b.provider, error });
      o.onBoard?.(b, { status: "failed", error });
      return;
    }
    st.boards_ok++;
    st.postings_read = (st.postings_read ?? 0) + list.length;
    if (!complete) st.boards_partial++;
    o.onBoard?.(b, { status: complete ? "ok" : "partial", ...validators });
    const fresh = new Map<string, FeedPosting>();
    for (const p of list) {
      if (!p || !p.job_id || fresh.has(p.job_id)) continue;
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
      fresh.set(p.job_id, p);
    }
    const known = new Map((await o.db.getMany([...fresh.keys()])).map((p) => [p.job_id, p]));
    const writes: Posting[] = [], touched: string[] = [];
    for (const p of fresh.values()) {
      const old = known.get(p.job_id);
      if (!old) { st.new++; writes.push({ ...p, provider: b.provider, board: b.board, first_seen_at: now, last_seen_at: now, closed_at: null }); continue; }
      if (old.closed_at) st.reopened++; else st.seen++;
      if (!old.closed_at && same(old, p)) { if (o.now - Date.parse(old.last_seen_at) >= (o.touchAfterMs ?? 0)) touched.push(p.job_id); continue; }
      writes.push({ ...old, ...p, provider: b.provider, board: b.board, first_seen_at: old.first_seen_at, last_seen_at: now, closed_at: null });
    }
    if (writes.length) await o.db.putMany(writes);
    if (touched.length) await o.db.touch(touched, now);
    if (!complete) return; // a partial read proves nothing about what it did not reach
    const open = await o.db.openForBoard(b);
    const gone = open.map((p) => p.job_id).filter((id) => !fresh.has(id));
    if (gone.length) {
      await o.db.close(gone, now);
      st.closed += gone.length;
      if (gone.length >= 20 && gone.length * 2 >= open.length) st.large_closes.push({ board: b.board, provider: b.provider, closed: gone.length, was_open: open.length });
    }
  }

  const width = Math.max(1, Math.min(o.concurrency ?? 1, pick.length));
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    // Feature 6: postingBudget bounds a run's CPU (parsing and normalizing postings is most of it): once the run has parsed
    // that many, no further board starts; the rest stay due, oldest first, for the next run.
    const stop = () => (o.deadline && clock() >= o.deadline) ? "deadline" as const : (o.postingBudget && (st.postings_read ?? 0) >= o.postingBudget) ? "posting_budget" as const : null;
    while (next < pick.length) { const why = stop(); if (why) { st.stopped_by = why; break; } st.attempted++; await one(pick[next++]); }
  }));
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
// Requests stay small: 100 ids keep an in() list well inside gateway URL limits; 100 rows of up to 20 KB of text keep a
// write body around 2 MB at worst.
const PAGE = 1000, ID_CHUNK = 100, WRITE_CHUNK = 100;
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
}
export const RUN_LOG_DAYS = 14;
export function supabasePostingsDb(admin: any): PostingsDb & { recordRun(stats: IngestStats, at: string): Promise<void>; recordLaneRun(row: IngestRunRow): Promise<void> } {
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
      for (const c of chunks(ids, ID_CHUNK)) out.push(...(must<Posting[]>(await admin.from(T).select("*").in("job_id", c), "read postings") || []));
      return out;
    },
    async putMany(ps) { for (const c of chunks(ps, WRITE_CHUNK)) must(await admin.from(T).upsert(c.map(row), { onConflict: "job_id" }), "write postings"); },
    async touch(ids, at) { for (const c of chunks(ids, ID_CHUNK)) must(await admin.from(T).update({ last_seen_at: at }).in("job_id", c), "touch postings"); },
    async close(ids, at) { for (const c of chunks(ids, ID_CHUNK)) must(await admin.from(T).update({ closed_at: at }).in("job_id", c), "close postings"); },
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
    async recordLaneRun(r) {
      const R = "career_ingest_runs";
      must(await admin.from(R).insert({ ...r, failures: r.failures.slice(0, 50), report: r.report.slice(0, 2000) }), "write ingest run");
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
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const RAW_ID: Record<string, (j: any) => string> = { greenhouse: (j) => j.id, lever: (j) => j.id, ashby: (j) => j.id, smartrecruiters: (j) => j.id,
  ...Object.fromEntries(MORE_PROVIDERS.map((p) => [p, FEEDS[p].id])) };
// Every provider ingest reads: the 121 bundle's four and WO-044's seven.
export const INGEST_PROVIDERS = Object.keys(RAW_ID);
const rawJobs: Record<string, (json: any) => any[]> = {
  greenhouse: (j) => (j && j.jobs) || [], lever: (j) => (Array.isArray(j) ? j : []), ashby: (j) => (j && j.jobs) || [], smartrecruiters: (j) => (j && j.content) || [],
};

// ------------------------------------------------------------------------------------------------ the pay a board states
// WO-069: the pay a board's public API states in its own structured fields, as text written from the API's own numbers,
// currency and period; null when it states none. Never estimated, never read from prose (posting_pay.ts reads the text).
//   greenhouse       pay_input_ranges[] {min_cents, max_cents, currency_type, title} (the list read with pay_transparency=true)
//   lever            salaryRange {min, max, currency, interval}
//   ashby            compensation.compensationTierSummary / scrapeableCompensationSalarySummary (includeCompensation=true)
//   smartrecruiters  its postings list carries no structured pay: null
export const PAY_MAX = 200; // the column's limit (20261022110000_career_postings_pay.sql)
const oneLine = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
function money(v: unknown, currency: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || Math.round(n) < 1) return null; // a 0 or a missing figure is no figure
  const cur = oneLine(currency).toUpperCase() || "USD";
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  return `${cur === "USD" ? "$" : `${cur} `}${Math.round(n).toLocaleString("en-US")}`;
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
        const title = oneLine(r?.title).replace(/[\s:;,.-]+$/, "").slice(0, 80).trim();
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
      return `${s}${per ? ` ${per}` : ""}`.slice(0, PAY_MAX);
    }
    if (provider === "ashby") {
      const c = raw?.compensation;
      const s = oneLine(c?.compensationTierSummary) || oneLine(c?.scrapeableCompensationSalarySummary);
      return s ? s.slice(0, PAY_MAX).trim() : null;
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
export function boardFetchFeed(fetchFn: typeof fetch = fetch, opts: { userAgent?: string; timeoutMs?: number; bodyHash?: boolean } = {}): FetchFeed {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  const timeoutMs = opts.timeoutMs ?? 15000;
  // WO-037: `cond` sends the board's last validators (If-None-Match / If-Modified-Since); a 304 comes back as null.
  async function getJson(url: string, deadline: number, cond?: Board, seen?: { etag?: string | null; last_modified?: string | null; body_sha?: string | null }) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${timeoutMs / 1000}s`);
    const h: Record<string, string> = { ...headers };
    if (cond?.etag) h["if-none-match"] = cond.etag;
    if (cond?.last_modified) h["if-modified-since"] = cond.last_modified;
    let res: Response;
    try { res = await fetchFn(url, { headers: h, signal: AbortSignal.timeout(left) }); }
    catch (e) { throw new Error(e instanceof Error && /timed? ?out|abort/i.test(`${e.name} ${e.message}`) ? `timed out after ${timeoutMs / 1000}s` : e instanceof Error ? e.message : String(e)); }
    if (seen) { seen.etag = res.headers.get("etag"); seen.last_modified = res.headers.get("last-modified"); }
    if (res.status === 304 && cond) { try { await res.body?.cancel(); } catch { /* already closed */ } return null; }
    if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* already closed */ } throw new Error(`HTTP ${res.status}`); }
    if (!(opts.bodyHash && seen)) return await res.json();
    const text = await res.text();
    seen.body_sha = await sha256Hex(text);
    if (cond?.body_sha && cond.body_sha === seen.body_sha) return null; // the same body as the last full read
    return JSON.parse(text);
  }
  // WO-044: a provider of career_ingest_feeds.ts. GET, or Workday's read-only search POST; paged where the provider
  // pages (past maxPages the read is partial and closes nothing); the conditional request applies to one-request GETs.
  async function readMore(b: Board, deadline: number) {
    const spec = FEEDS[b.provider as keyof typeof FEEDS];
    let raw: any[] = [], complete = true, first: unknown = null, total: number | null = null;
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
      raw.push(...got);
      if (spec.maxPages === 1 || got.length < spec.pageSize || (total !== null && raw.length >= total)) break;
      if (page + 1 >= spec.maxPages) complete = false;
    }
    raw = raw.filter((j) => j && typeof j === "object");
    return { json: { name: spec.company(first), jobs: raw.map((j) => spec.toGreenhouse(j, b.board)) }, raw, complete, validators };
  }
  return async (b: Board) => {
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
      for (let page = 0; ; page++) {
        const j = await getJson(`${base}?limit=${SR_PAGE}&offset=${page * SR_PAGE}`, deadline);
        const got = rawJobs.smartrecruiters(j);
        raw.push(...got);
        json = { ...j, content: raw };
        const total = Number(j && j.totalFound);
        if (got.length < SR_PAGE || (Number.isFinite(total) && raw.length >= total)) break;
        if (page + 1 >= SR_MAX_PAGES) { complete = false; break; }
      }
    } else {
      // One request per board: the conditional request applies (SmartRecruiters pages, so it reads in full).
      const seen: { etag?: string | null; last_modified?: string | null; body_sha?: string | null } = {};
      json = await getJson(base, deadline, b, seen);
      if (json === null) return { postings: [], complete: false, not_modified: true, etag: b.etag ?? seen.etag ?? null, last_modified: b.last_modified ?? seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? b.body_sha ?? null } : {}) };
      raw = rawJobs[b.provider](json);
      validators = { etag: seen.etag ?? null, last_modified: seen.last_modified ?? null, ...(opts.bodyHash ? { body_sha: seen.body_sha ?? null } : {}) };
    }
    const postings = toPostings(b, normalize(json, b.board, b.company), raw);
    if (opts.bodyHash) return { postings, complete, etag: validators?.etag ?? null, last_modified: validators?.last_modified ?? null, body_sha: validators?.body_sha ?? null };
    if (validators && (validators.etag || validators.last_modified)) return { postings, complete, ...validators };
    return complete ? postings : { postings, complete };
  };
}
// One read's normalized jobs -> the rows the table takes. Every row must fit the table's constraints
// (20261019000000_career_postings.sql): one bad row would otherwise fail its board's write on every run. A posting
// without an https link or a title is not a job anyone can apply to.
function toPostings(b: Board, normalized: any[], raw: any[]): FeedPosting[] {
    const token = b.board.toLowerCase();
    const postings: FeedPosting[] = [];
    normalized.forEach((p, i) => {
      const atsId = String(RAW_ID[b.provider](raw[i]) ?? "");
      const title = clip(p.title, 500), url = String(p.url || "");
      if (!atsId || !title || !/^https:\/\//.test(url) || url.length > 2000) return;
      const description = decodeEntities(String(p.jd_text || "")).slice(0, MAX_DESCRIPTION);
      postings.push({
        job_id: `${b.provider}:${token}:${atsId}`, ats_id: atsId, company: clip(p.company || b.company, 300) || b.board, title,
        location: clip(p.location, 1000), url, description,
        department: clip(p.department, 300), posted_at: p.posted_at || null, remote: p.remote, role_family: p.role_family, seniority_band: p.seniority_band,
        apply_email: applyEmailOf({ description, url }), pay: boardPay(b.provider, raw[i]),
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
