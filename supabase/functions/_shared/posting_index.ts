// Posting index (docs/architect/POSTING-INDEX.md): the crawler/verifier slice over the existing ATS readers.
//   enrichPosting     a FeedPosting -> IndexedPosting: ats_type, level (internship/entry/...), deadline, requirements, content_sig
//   extractDeadline   "Apply by March 15, 2027" -> "2027-03-15"; null when the text states none (never guessed)
//   extractRequirements  the posting's own requirements section, capped; null when it has none
//   crawlBoards       board list -> fetchFeed (boardFetchFeed: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee,
//                     BambooHR, Teamtailor, Breezy, Personio, Workday) -> enrich -> diff against the store -> close what a COMPLETE
//                     read no longer lists. Every posting a read lists is stamped last_verified_at; a 304 / same-body read
//                     stamps the whole board. A failed or partial read closes nothing (same rule as career_ingest.ts).
//   verifyPosting     single-posting liveness (Greenhouse/Lever by id; others by the apply URL), host-paced; only an
//                     explicit 404/410/closed marker is "closed", anything uncertain is "unknown" and closes nothing.
//   verifyQueue       open postings whose last_verified_at is older than the cadence, oldest first.
// Network, clock and storage are injected. Nothing here deploys, writes a database or spends.
import type { Board, FeedPosting, FetchFeed } from "./career_ingest.ts";

export type Level = "internship" | "entry" | "mid" | "senior" | "lead" | "executive" | null;
export interface IndexedPosting extends FeedPosting {
  provider: string; board: string; first_seen_at: string; last_seen_at: string; closed_at: string | null;
  ats_type: string; level: Level; deadline: string | null; requirements: string | null;
  last_verified_at: string; closed_reason: string | null; content_sig: string;
}

// ------------------------------------------------------------------------------------------------ enrichment
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const CUE = "(?:appl(?:y|ications?)\\s+(?:by|before|until|deadline|close[sd]?|due|accepted\\s+until)|(?:application|closing|close|apply-by)\\s+(?:deadline|date)|deadline(?:\\s+to\\s+apply)?|applications?\\s+(?:will\\s+)?close|must\\s+(?:be\\s+)?(?:apply|submitted)\\s+(?:by|before)|closes?(?:\\s+on)?)";
const GAP = "[^\\d\\n]{0,24}?";
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d) ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
const monthNo = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

export function extractDeadline(text: unknown, now = Date.now()): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  if (!t) return null;
  const nowY = new Date(now).getUTCFullYear(), nowM = new Date(now).getUTCMonth() + 1, nowD = new Date(now).getUTCDate();
  // A year-less date ("March 15") is the next one at or after today.
  const yearless = (m: number, d: number) => { const y = (m < nowM || (m === nowM && d < nowD)) ? nowY + 1 : nowY; return iso(y, m, d); };
  const pats: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [new RegExp(`${CUE}${GAP}(\\d{4})-(\\d{2})-(\\d{2})`, "i"), (m) => iso(+m[1], +m[2], +m[3])],
    [new RegExp(`${CUE}${GAP}${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i"), (m) => iso(+m[3], monthNo(m[1]), +m[2])],
    [new RegExp(`${CUE}${GAP}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\.?,?\\s+(\\d{4})`, "i"), (m) => iso(+m[3], monthNo(m[2]), +m[1])],
    [new RegExp(`${CUE}${GAP}(\\d{1,2})/(\\d{1,2})/(\\d{4})`, "i"), (m) => iso(+m[3], +m[1], +m[2])], // US month/day/year
    [new RegExp(`${CUE}${GAP}${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s*\\d{4})`, "i"), (m) => yearless(monthNo(m[1]), +m[2])],
  ];
  for (const [re, f] of pats) { const m = t.match(re); if (m) { const d = f(m); if (d && +d.slice(0, 4) >= nowY - 1) return d; } }
  return null;
}

const REQ_HEAD = /(?:^|[\n.:!?]\s*|\s{2,})(requirements|qualifications|minimum qualifications|basic qualifications|required qualifications|what you(?:'|’)ll need|what we(?:'|’)re looking for|who you are|you have|must[- ]haves?|skills (?:and|&) experience)\s*:?\s+/i;
const REQ_STOP = /\b(preferred qualifications|nice to have|bonus points|benefits|perks|what we offer|about (?:us|the company|the team)|compensation|salary|equal opportunity|responsibilities|how to apply)\b\s*:?/i;
export function extractRequirements(text: unknown, cap = 1500): string | null {
  const t = String(text ?? "");
  const m = t.match(REQ_HEAD);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  let body = t.slice(start, start + cap * 2);
  const stop = body.search(REQ_STOP);
  if (stop > 40) body = body.slice(0, stop);
  body = body.replace(/[ \t]+\n/g, "\n").trim().slice(0, cap).trim();
  return body.length >= 20 ? body : null;
}

const INTERN = /\b(intern(?:ship)?s?|co-?op|working student|werkstudent|apprentice(?:ship)?|trainee)\b/i;
export function levelOf(title: string, band?: string | null): Level {
  if (INTERN.test(title)) return "internship";
  const b = String(band ?? "").toLowerCase();
  if (/entry|junior|new ?grad|associate/.test(b)) return "entry";
  if (/senior|sr/.test(b)) return "senior";
  if (/lead|staff|principal/.test(b)) return "lead";
  if (/exec|director|vp|chief|head/.test(b)) return "executive";
  if (/mid/.test(b)) return "mid";
  return null;
}

const CONTENT_KEYS = ["company", "title", "location", "url", "description", "department", "posted_at", "ats_id", "remote", "role_family", "seniority_band", "apply_email", "pay"] as const;
// A fast, non-cryptographic change signature (two FNV-1a lanes, 16 hex): decides "rewrite or only stamp", nothing else.
export function contentSig(p: Record<string, unknown>): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (const k of CONTENT_KEYS) {
    const s = `${k}\u0001${p[k] ?? ""}\u0002`;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b + c, 0x85ebca6b) >>> 0; b ^= b >>> 13; }
  }
  return a.toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function enrichPosting(p: FeedPosting, b: Pick<Board, "provider" | "board">, now: number): Omit<IndexedPosting, "first_seen_at" | "last_seen_at" | "closed_at"> {
  const desc = p.description ?? "";
  return { ...p, provider: b.provider, board: b.board, ats_type: b.provider, level: levelOf(p.title, p.seniority_band),
    deadline: extractDeadline(desc, now), requirements: extractRequirements(desc), last_verified_at: new Date(now).toISOString(), closed_reason: null, content_sig: contentSig(p as any) };
}

// ------------------------------------------------------------------------------------------------ the store
export interface IndexStore {
  forBoard(b: Pick<Board, "provider" | "board">): Promise<IndexedPosting[]>; // every row of the board, open and closed
  putMany(ps: IndexedPosting[]): Promise<void>;
  stamp(ids: string[], at: string): Promise<void>; // seen on the board, nothing changed: last_seen_at + last_verified_at
  stampBoard(b: Pick<Board, "provider" | "board">, at: string): Promise<number>; // 304 / same body: every open posting of the board
  close(ids: string[], at: string, reason: string): Promise<void>;
}
const bk = (b: Pick<Board, "provider" | "board">) => `${b.provider}:${b.board}`;
export function memoryIndexStore() {
  const rows = new Map<string, IndexedPosting>(), byBoard = new Map<string, Set<string>>();
  const store: IndexStore & { rows: Map<string, IndexedPosting>; open(): IndexedPosting[] } = {
    rows, open: () => [...rows.values()].filter((p) => !p.closed_at),
    async forBoard(b) { return [...(byBoard.get(bk(b)) ?? [])].map((id) => rows.get(id)!); },
    async putMany(ps) { for (const p of ps) { rows.set(p.job_id, p); let s = byBoard.get(bk(p)); if (!s) byBoard.set(bk(p), s = new Set()); s.add(p.job_id); } },
    async stamp(ids, at) { for (const id of ids) { const p = rows.get(id); if (p) { p.last_seen_at = at; p.last_verified_at = at; } } },
    async stampBoard(b, at) { let n = 0; for (const id of byBoard.get(bk(b)) ?? []) { const p = rows.get(id)!; if (!p.closed_at) { p.last_verified_at = at; n++; } } return n; },
    async close(ids, at, reason) { for (const id of ids) { const p = rows.get(id); if (p && !p.closed_at) { p.closed_at = at; p.closed_reason = reason; } } },
  };
  return store;
}

// ------------------------------------------------------------------------------------------------ the crawl
export interface CrawlStats { boards_ok: number; boards_partial: number; boards_not_modified: number; boards_failed: number; new: number; changed: number; unchanged: number; reopened: number; closed: number; verified: number; failures: { board: string; provider: string; error: string }[] }
export async function crawlBoards(o: { boards: Board[]; fetchFeed: FetchFeed; store: IndexStore; now: number; concurrency?: number; onBoard?: (b: Board, status: string, v: { etag?: string | null; last_modified?: string | null; body_sha?: string | null }) => void }): Promise<CrawlStats> {
  const st: CrawlStats = { boards_ok: 0, boards_partial: 0, boards_not_modified: 0, boards_failed: 0, new: 0, changed: 0, unchanged: 0, reopened: 0, closed: 0, verified: 0, failures: [] };
  const at = new Date(o.now).toISOString();
  let next = 0;
  async function one(b: Board) {
    let list: FeedPosting[], complete = true, v: { etag?: string | null; last_modified?: string | null; body_sha?: string | null } = {};
    try {
      const r = await o.fetchFeed(b);
      if (Array.isArray(r)) list = r;
      else {
        v = { etag: r.etag ?? null, last_modified: r.last_modified ?? null, body_sha: r.body_sha ?? null };
        if (r.not_modified) { st.boards_ok++; st.boards_not_modified++; st.verified += await o.store.stampBoard(b, at); o.onBoard?.(b, "not_modified", v); return; }
        list = r.postings; complete = r.complete;
      }
    } catch (e) { st.boards_failed++; st.failures.push({ board: b.board, provider: b.provider, error: e instanceof Error ? e.message : String(e) }); o.onBoard?.(b, "failed", {}); return; }
    complete ? st.boards_ok++ : st.boards_partial++;
    o.onBoard?.(b, complete ? "ok" : "partial", v);
    const known = new Map((await o.store.forBoard(b)).map((p) => [p.job_id, p]));
    const seen = new Set<string>(), writes: IndexedPosting[] = [], stamps: string[] = [];
    for (const p of list) {
      if (!p?.job_id || seen.has(p.job_id)) continue;
      seen.add(p.job_id);
      const old = known.get(p.job_id), sig = contentSig(p as any);
      if (old && !old.closed_at && old.content_sig === sig) { st.unchanged++; stamps.push(p.job_id); continue; }
      const e = enrichPosting(p, b, o.now);
      if (!old) { st.new++; writes.push({ ...e, first_seen_at: at, last_seen_at: at, closed_at: null }); }
      else { old.closed_at ? st.reopened++ : st.changed++; writes.push({ ...e, first_seen_at: old.first_seen_at, last_seen_at: at, closed_at: null }); }
    }
    if (writes.length) await o.store.putMany(writes);
    if (stamps.length) await o.store.stamp(stamps, at);
    st.verified += seen.size;
    if (!complete) return; // a partial read proves nothing about what it did not reach
    const gone = [...known.values()].filter((p) => !p.closed_at && !seen.has(p.job_id)).map((p) => p.job_id);
    if (gone.length) { await o.store.close(gone, at, "gone_from_board"); st.closed += gone.length; }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 8, o.boards.length)) }, async () => { while (next < o.boards.length) await one(o.boards[next++]); }));
  return st;
}

// ------------------------------------------------------------------------------------------------ liveness
export type Verdict = { verdict: "live" | "closed" | "unknown"; via: string; status?: number; reason?: string };
export function verifyRequest(p: Pick<IndexedPosting, "provider" | "board" | "ats_id" | "url">): { url: string; host: string; byId: boolean } {
  const id = encodeURIComponent(p.ats_id ?? "");
  const byId = p.ats_id ? ({ greenhouse: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(p.board)}/jobs/${id}`, lever: `https://api.lever.co/v0/postings/${encodeURIComponent(p.board)}/${id}` } as Record<string, string>)[p.provider] : undefined;
  const url = byId ?? p.url;
  return { url, host: new URL(url).host, byId: !!byId };
}
const CLOSED_BODY = /(no longer (?:available|accepting|open)|(?:job|position|role|posting) (?:has been |is )?(?:closed|filled|removed|expired)|this (?:job|position) (?:is|has) (?:closed|expired)|page you(?:'|’)re looking for)/i;
export async function verifyPosting(p: Pick<IndexedPosting, "provider" | "board" | "ats_id" | "url" | "title">, o: { fetchFn: typeof fetch; wait?: (host: string) => Promise<void>; userAgent?: string; timeoutMs?: number }): Promise<Verdict> {
  const rq = verifyRequest(p);
  try {
    await o.wait?.(rq.host);
    const res = await o.fetchFn(rq.url, { headers: { accept: rq.byId ? "application/json" : "text/html", ...(o.userAgent ? { "user-agent": o.userAgent } : {}) }, signal: AbortSignal.timeout(o.timeoutMs ?? 15000) });
    const status = res.status;
    if (status === 404 || status === 410) { await res.body?.cancel(); return { verdict: "closed", via: rq.byId ? "ats_api" : "apply_url", status, reason: `HTTP ${status}` }; }
    if (status < 200 || status >= 300) { await res.body?.cancel(); return { verdict: "unknown", via: "http", status, reason: `HTTP ${status}` }; } // 403/429/5xx prove nothing
    if (rq.byId) { await res.body?.cancel(); return { verdict: "live", via: "ats_api", status }; }
    if (/[?&]error=true\b/.test(res.url || "")) return { verdict: "closed", via: "apply_url", status, reason: "redirected to the board with error=true" };
    const text = (await res.text()).slice(0, 400000);
    if (CLOSED_BODY.test(text)) return { verdict: "closed", via: "apply_url", status, reason: "page says the role is closed" };
    // A 200 that still names the role is live; a 200 app shell that does not (client-rendered boards) proves nothing.
    return text.toLowerCase().includes(p.title.toLowerCase().slice(0, 60)) ? { verdict: "live", via: "apply_url", status } : { verdict: "unknown", via: "apply_url", status, reason: "page does not name the role" };
  } catch (e) { return { verdict: "unknown", via: "network", reason: e instanceof Error ? e.message : String(e) }; }
}

export function verifyQueue(open: IndexedPosting[], now: number, cadenceMs: number, limit: number): IndexedPosting[] {
  return open.filter((p) => !p.closed_at && now - Date.parse(p.last_verified_at) >= cadenceMs)
    .sort((a, b) => a.last_verified_at.localeCompare(b.last_verified_at)).slice(0, limit);
}
export async function applyVerdicts(store: IndexStore, results: { p: IndexedPosting; v: Verdict }[], now: number): Promise<{ live: number; closed: number; unknown: number }> {
  const at = new Date(now).toISOString(), out = { live: 0, closed: 0, unknown: 0 };
  const live = results.filter((r) => r.v.verdict === "live").map((r) => r.p.job_id);
  if (live.length) await store.stamp(live, at);
  out.live = live.length;
  for (const r of results.filter((r) => r.v.verdict === "closed")) { await store.close([r.p.job_id], at, `verify:${r.v.reason ?? r.v.via}`); out.closed++; }
  out.unknown = results.length - out.live - out.closed;
  return out;
}
