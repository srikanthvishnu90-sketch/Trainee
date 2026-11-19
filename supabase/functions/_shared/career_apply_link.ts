// FEATURE E2E (2026-10-26): "apply me to this: <posting link>" and "apply to Ramp's frontend intern" on the live path
// (agent-chat handleChat -> applyTurn, before the router). Before this, a pasted Greenhouse, Lever or Ashby link went to the
// router's old batch stack ("BOARD_NOT_WIRED", nothing queued), and a named role at a company with no posting on file was
// answered "not in the list I can work from", because career_postings is filled only by the scheduled ingest, which is not
// running. This module reads the posting itself, on demand, from the ATS's own public posting API (the same feeds and
// normalizers the ingest uses: career_ingest.ts boardFetchFeed), stores that one posting in career_postings exactly as the
// ingest would (provider:board:<ATS id>), and hands it to the chat's apply turn (career_apply_chat.ts applyPicked), which
// screens it, queues it in career_apply_wanted and asks the server's prepare for it. Facts about the job come only from
// the posting the ATS returned; the company's name only from the board registry (121 BOARD_REGISTRY) or, failing that,
// the board's own name in the link. Nothing here approves, fills or sends anything.
import { CareerJobs } from "./router_core.career.js";
import { type Board, type FetchFeed, type FeedPosting, type FeedRead, type Posting, type PostingsDb, searchWords } from "./career_ingest.ts";
import { detectPortal, postingKey } from "./posting_key.ts";
import { neverOpen } from "./career_people_sites.ts";

// ------------------------------------------------------------------------------------------------ the asks
const URL_IN = /https?:\/\/[^\s<>"'()]+/gi;
// A request to apply ("apply me to this: <link>", "can you apply to <link>", "<link> apply for me", "I want to apply to
// this job <link>"), never a question about how ("how do I apply to <link>?", "should I apply to <link>?") and never the
// past ("I applied to <link>").
const HOW = /^\s*(how|what|where|when|why|which|should|is|are|am|do|does|did)\b/i;
// ROUTING SCENARIOS (2026-10-29): what comes before "apply" decides whether a text is an ask to apply at all. A greeting
// ("hey", "ok so", an emoji) is dropped before the question test, so "hey did you apply to X?" stays a question; a
// negation ("hey don't apply to X", "never apply to X") or a second ask joined to it ("connect gmail and apply to X",
// "withdraw from X and apply to Y") is never an apply: the cancel turn or the router asks instead of queueing half of it.
const APPLY_LEAD = /^(?:(?:hey|hi|hello|ok|okay|so|pls|please|actually|oh|um|also)\b[,!:]?\s+)+/i;
export function applyText(message: string): string | null {
  const raw = String(message ?? "").trim().replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(APPLY_LEAD, "");
  const at = raw.search(/\bapply\b/i);
  if (at < 0) return raw;
  const before = raw.slice(0, at);
  if (/\b(?:don'?t|dont|do not|never|not|no longer|stop|cancel|withdraw)\b/i.test(before)) return null;
  if (/\b(?:and|then|plus)\b|[;]/i.test(before)) return null;
  return raw;
}
export interface LinkAsk { url: string; key: string; family: "greenhouse" | "lever" | "ashby"; board: string; atsId: string }
export function linkAsk(message: string): LinkAsk | null {
  const raw = applyText(message);
  if (raw === null || !/\bapply\b/i.test(raw) || /\bapplied\b/i.test(raw) || HOW.test(raw)) return null;
  const links = [...new Set((raw.match(URL_IN) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, "")))];
  const asks = links.map(linkOf).filter((x): x is LinkAsk => !!x);
  // One posting per ask; two different postings in one text is the batch ask's (linksAsk), not this turn's.
  return asks.length === 1 ? asks[0] : null;
}
// R9-G (e2e E05): "apply to these 20: <link> <link> …": every posting link in one apply ask, in the order pasted, one each.
// Two or more different postings; one is linkAsk's. A link no ATS reader knows (or LinkedIn, Indeed, Handshake) is named in
// `unread`, never guessed at.
export function linksAsk(message: string): { asks: LinkAsk[]; unread: string[] } | null {
  const raw = applyText(message);
  if (raw === null || !/\bapply\b/i.test(raw) || /\bapplied\b/i.test(raw) || HOW.test(raw)) return null;
  const links = [...new Set((raw.match(URL_IN) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, "")))];
  const asks: LinkAsk[] = [], unread: string[] = [], keys = new Set<string>();
  for (const u of links) {
    const a = linkOf(u);
    if (!a) unread.push(u);
    else if (!keys.has(a.key)) { keys.add(a.key); asks.push(a); }
  }
  return asks.length >= 2 ? { asks, unread } : null;
}
// MASS APPLY CONVERSATIONS (2026-11-17, ag/ma-09-link-list-input; eval MA14: 122 pasted links were refused "message too
// long"): the one shape of text allowed past the chat's 4,000-character cap. It must parse as an apply ask (linksAsk), and
// every link in it must be a posting link a reader here knows (linkOf: Greenhouse, Lever or Ashby postings; never LinkedIn,
// Indeed or Handshake); at most LINK_LIST_MAX_LINKS links of at most LINK_MAX_CHARS each, at most LINK_LIST_MAX_WORDS
// characters of other words, LINK_LIST_MAX_CHARS in all. Anything else over the cap is refused as before (chat_input.ts). A
// text let through here is read only by code: the turn refuses every model call (handler-career.ts), and later turns see it
// clipped (career_brain.ts historyWindow). These bound one message's size, not how many applications a person may make
// (D-NO-LIMITS): every link is read and screened.
export const LINK_LIST_MAX_CHARS = 64_000, LINK_LIST_MAX_LINKS = 1_000, LINK_LIST_MAX_WORDS = 500, LINK_MAX_CHARS = 500;
export function linkListAsk(text: string, o: { crisis?: (words: string) => unknown } = {}): boolean {
  const t = String(text ?? "");
  if (t.length > LINK_LIST_MAX_CHARS) return false;
  const urls = t.match(URL_IN) ?? [];
  if (urls.length < 2 || urls.length > LINK_LIST_MAX_LINKS) return false;
  if (urls.some((u) => u.length > LINK_MAX_CHARS || !linkOf(u.replace(/[.,;:!?)\]]+$/, "")))) return false;
  const words = t.replace(URL_IN, " ").replace(/\s+/g, " ").trim();
  if (words.length > LINK_LIST_MAX_WORDS) return false;
  // Review of ag/ma-09 (2026-11-17): the same list beside crisis words passes too (o.crisis, the handler's crisisReply), so
  // the person gets the crisis reply (overCapRoute gives the words alone as the message) and never a "message too long".
  return linksAsk(t) !== null || (!!o.crisis && !!o.crisis(words));
}
// The links of a pasted list not read within a turn's budget (career_apply_chat.ts linksApplyTurn), kept per person until
// their "keep going" reads them. Review of ag/ma-09 (2026-11-17, architect ruling):
//   - every change is one atomic read-modify-write (`update`): the change is computed from the list as stored and written
//     only if nobody wrote it in between (a version compare-and-set), retried a few times, else it throws and nothing is
//     written; a read that fails writes nothing either (never a list overwritten from an unread one);
//   - at most LINK_PENDING_MAX links are kept in all (the rest are named as not read, never silently dropped);
//   - a kept list expires LINK_PENDING_TTL_MS after it was last written: an expired list is reported, never read.
export const LINK_PENDING_MAX = 1000, LINK_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export type PendingNow = { urls: string[]; expired: number };
export interface LinkPendingStore {
  // The kept links now (expired: how many an expired list held; its urls are then []). Throws when unreadable.
  read(userId: string, now: number): Promise<PendingNow>;
  // Atomically: next = change(the kept links now, [] when expired), written as the new list ([] removes it). Returns what was
  // there and what is there now. Throws (nothing written) when it cannot be read or written without a conflict.
  update(userId: string, now: number, change: (cur: string[]) => string[]): Promise<{ before: PendingNow; after: string[] }>;
}
export const LINK_PENDING_KEY = "career:apply-links-reading";
const pendingOf = (v: any, now: number): PendingNow & { version: number; versioned: boolean } => {
  const urls = Array.isArray(v?.urls) ? v.urls.filter((u: unknown): u is string => typeof u === "string") : [];
  const at = Date.parse(String(v?.at ?? ""));
  const expired = urls.length && (!Number.isFinite(at) || now - at > LINK_PENDING_TTL_MS) ? urls.length : 0;
  return { urls: expired ? [] : urls, expired, version: Number(v?.version ?? 0) || 0, versioned: v?.version !== undefined && v?.version !== null };
};
// The per-person service-role key-value row (career_watch_kv, as career_apply_questions.ts keeps "career:questions-shown"),
// bound to the account's privacy epoch (career:account): after an erase the kept links are gone, never read. The write is a
// compare-and-set on value->>version (an insert when there is no row; the primary key refuses a second insert).
// deno-lint-ignore no-explicit-any
export function supabaseLinkPending(admin: any): LinkPendingStore {
  const kv = () => admin.from("career_watch_kv");
  const epochOf = async (userId: string) => {
    const r = await kv().select("value").eq("user_id", userId).eq("key", "career:account").maybeSingle();
    if (r?.error) throw Error(`account: ${r.error.message}`);
    return Number(r?.data?.value?.epoch ?? 0);
  };
  const row = async (userId: string) => {
    const r = await kv().select("value").eq("user_id", userId).eq("key", LINK_PENDING_KEY).maybeSingle();
    if (r?.error) throw Error(`links still being read: ${r.error.message}`);
    return r?.data?.value ?? null;
  };
  // The compare-and-set filter: the version read, or, for a row written without one, a row that still has none.
  const same = (q: any, cur: { version: number; versioned: boolean }) => cur.versioned ? q.eq("value->>version", String(cur.version)) : q.is("value->>version", null);
  const read = async (userId: string, now: number) => {
    const v = await row(userId);
    if (!v) return { present: false, cur: { urls: [], expired: 0, version: 0, versioned: false } };
    const cur = pendingOf(v, now);
    // A list kept before an erase is not theirs to read: it reads as none (and is replaced or removed by the next write).
    if (Number(v.epoch ?? 0) !== await epochOf(userId)) return { present: true, cur: { urls: [], expired: 0, version: cur.version, versioned: cur.versioned } };
    return { present: true, cur };
  };
  return {
    async read(userId, now) { const { cur } = await read(userId, now); return { urls: cur.urls, expired: cur.expired }; },
    async update(userId, now, change) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { present, cur } = await read(userId, now);
        const next = [...new Set(change(cur.urls))];
        const at = new Date(now).toISOString();
        let r: any;
        if (!present) {
          if (!next.length) return { before: { urls: cur.urls, expired: cur.expired }, after: [] };
          r = await kv().insert({ user_id: userId, key: LINK_PENDING_KEY, value: { urls: next, version: 1, epoch: await epochOf(userId), at }, updated_at: at }).select("key");
          if (r?.error && /duplicate|23505|conflict/i.test(`${r.error.code ?? ""} ${r.error.message ?? ""}`)) continue;
        } else if (!next.length) {
          r = await same(kv().delete().eq("user_id", userId).eq("key", LINK_PENDING_KEY), cur).select("key");
        } else {
          r = await same(kv().update({ value: { urls: next, version: cur.version + 1, epoch: await epochOf(userId), at }, updated_at: at })
            .eq("user_id", userId).eq("key", LINK_PENDING_KEY), cur).select("key");
        }
        if (r?.error) throw Error(`keep the links still being read: ${r.error.message}`);
        if (Array.isArray(r?.data) && r.data.length === 1) return { before: { urls: cur.urls, expired: cur.expired }, after: next };
        // Someone wrote the list in between (or removed it): read it again and redo the change on what is there now.
      }
      throw Error("keep the links still being read: the list kept changing under this write");
    },
  };
}
// In memory, for tests and the eval world: the same rules (cap enforced by the caller, expiry, one write at a time).
export function memoryLinkPending(o: { failRead?: () => boolean; failWrite?: () => boolean } = {}): LinkPendingStore & { rows: Map<string, { urls: string[]; at: number }> } {
  const rows = new Map<string, { urls: string[]; at: number }>();
  const now0 = (u: string, now: number): PendingNow => {
    const r = rows.get(u);
    if (!r) return { urls: [], expired: 0 };
    return now - r.at > LINK_PENDING_TTL_MS ? { urls: [], expired: r.urls.length } : { urls: [...r.urls], expired: 0 };
  };
  return {
    rows,
    read: async (u, now) => { if (o.failRead?.()) throw Error("down"); return now0(u, now); },
    update: async (u, now, change) => {
      if (o.failRead?.()) throw Error("down");
      const before = now0(u, now);
      const next = [...new Set(change(before.urls))];
      if (o.failWrite?.()) throw Error("down");
      if (next.length) rows.set(u, { urls: next, at: now }); else rows.delete(u);
      return { before, after: next };
    },
  };
}
// Architect ruling (2026-11-17): an over-cap link list goes straight to the link turn; the handler's other code routes never
// run their patterns over it. They are given OVER_CAP_ROUTE_TEXT (no letters, no digits: nothing matches it) and the link
// turn the text itself. One exception, for safety: when the words beside the links (at most LINK_LIST_MAX_WORDS characters)
// are crisis text (`crisis`), those words alone are the message, as any message under the cap is, and no link is read.
export const OVER_CAP_ROUTE_TEXT = "\u2026";
export const linkListWords = (text: string) => String(text ?? "").replace(URL_IN, " ").replace(/\s+/g, " ").trim();
export function overCapRoute(text: string, o: { crisis?: (words: string) => unknown } = {}): { route: string; links: string | null } {
  const words = linkListWords(text);
  if (o.crisis && o.crisis(words.slice(0, LINK_LIST_MAX_WORDS))) return { route: words.slice(0, LINK_LIST_MAX_WORDS), links: null };
  return { route: OVER_CAP_ROUTE_TEXT, links: text };
}
export function linkOf(url: string): LinkAsk | null {
  // Never LinkedIn, Indeed or Handshake (owner rule), on any suffix or subdomain: the chat declines those before this turn.
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (neverOpen(host)) return null;
  const portal = detectPortal(url);
  if (!portal || portal.family === "workday") return null;
  const key = postingKey(url);
  if (!key) return null;
  const [family, board, atsId] = key.split(":");
  return { url, key, family: family as LinkAsk["family"], board, atsId };
}

// "apply to Ramp's frontend intern", "apply me to Ramp's Frontend Engineer Intern role": a role named by the company's
// possessive. The single ask's other shape ("apply to the <role> role at <Company>") is career_apply_chat.ts applyAsk's.
const CO = "([A-Z][A-Za-z0-9&.-]*(?:\\s+[A-Z][A-Za-z0-9&.-]*)*)";
export function possessiveAsk(message: string): { company: string; role: string } | null {
  const raw = applyText(message);
  if (raw === null || !/\bapply\b/i.test(raw) || /\bapplied\b/i.test(raw) || HOW.test(raw)) return null;
  const m = raw.match(new RegExp(`\\bapply\\s+(?:me\\s+)?(?:to|for)\\s+(?:the\\s+)?${CO}['’]s?\\s+(.+?)\\s*(?:role|position|job|posting|opening)?\\s*[.!]?\\s*$`));
  if (!m) return null;
  const role = m[2].replace(/\s+(?:role|position|job|posting|opening)$/i, "").trim();
  return role && searchWords(role).length ? { company: m[1].trim(), role } : null;
}

// ------------------------------------------------------------------------------------------------ the boards
// The live boards the registry names (121 BOARD_REGISTRY: each verified by a real fetch), by company.
// deno-lint-ignore no-explicit-any
const REGISTRY: { company: string; provider: string; board: string }[] = ((CareerJobs as any).liveBoards?.() ?? []) as any[];
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export function boardOfCompany(company: string): Board | null {
  const want = norm(company);
  const hit = REGISTRY.find((b) => norm(b.company) === want && ["greenhouse", "lever", "ashby"].includes(b.provider));
  return hit ? { company: hit.company, provider: hit.provider, board: hit.board } : null;
}
// The company a board belongs to: the registry's name for it, else the board's own name as the link carries it.
export function companyOfBoard(provider: string, board: string): string {
  const hit = REGISTRY.find((b) => b.provider === provider && b.board.toLowerCase() === board.toLowerCase());
  return hit ? hit.company : board;
}

// ------------------------------------------------------------------------------------------------ the posting
export type Found =
  | { kind: "found"; posting: Posting; fetched: boolean }
  | { kind: "closed"; posting: Posting }
  | { kind: "not_on_board"; board: Board }
  | { kind: "unreadable"; board: Board; why: string };
const postingsOf = (r: FeedPosting[] | FeedRead) => Array.isArray(r) ? r : r.postings;
const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The posting a link names: on file and open, it is used as it is; otherwise its board is read from the ATS's public
// API, and the one posting with this id is stored as the ingest would store it and used. A board that does not list it
// is "not_on_board" (closed, or never there): nothing is invented in its place.
export async function postingForLink(o: { ask: LinkAsk; db: PostingsDb; fetchFeed: FetchFeed; now: number }): Promise<Found> {
  const { ask } = o;
  const board: Board = { company: companyOfBoard(ask.family, ask.board), provider: ask.family, board: ask.board };
  let onFile: Posting | null = null;
  try { onFile = await o.db.get(ask.key) ?? await o.db.get(`${ask.family}:${ask.board.toLowerCase()}:${ask.atsId}`); } catch { onFile = null; }
  if (onFile && !onFile.closed_at) return { kind: "found", posting: onFile, fetched: false };
  const named = (p: FeedPosting) => sameKey(p.job_id, ask.key) || sameKey(String(p.ats_id ?? ""), ask.atsId);
  // Review of #775, round 5: the posting's own API first, where the feed reader has one (career_ingest.ts boardFetchFeed
  // `one`); the whole board feed when that does not answer with this posting.
  let read: FeedPosting[] | null = null;
  const one = (o.fetchFeed as { one?: (b: Board, atsId: string) => Promise<FeedPosting | null> }).one;
  if (typeof one === "function") { try { const p = await one(board, ask.atsId); if (p && named(p)) read = [p]; } catch { /* the feed, below */ } }
  // A read that failed (too large, refused, an error) is NOT READ: never "closed". The state on file is from an earlier read,
  // and is not handed over as a fresh answer.
  if (!read) {
    try { read = postingsOf(await o.fetchFeed(board)); }
    catch (e) { return { kind: "unreadable", board, why: String((e as Error)?.message ?? e) }; }
  }
  const hit = read.find(named);
  if (!hit) return onFile ? { kind: "closed", posting: onFile } : { kind: "not_on_board", board };
  const at = new Date(o.now).toISOString();
  const posting: Posting = {
    ...hit, provider: ask.family, board: ask.board.toLowerCase(), first_seen_at: onFile?.first_seen_at ?? at, last_seen_at: at, closed_at: null,
  };
  await o.db.put(posting);
  return { kind: "found", posting, fetched: true };
}

// The open postings on a company's registered board whose title carries every word of the role ("frontend intern").
export async function postingsForRole(o: { company: string; role: string; fetchFeed: FetchFeed }): Promise<{ board: Board; hits: FeedPosting[] } | { board: Board; why: string } | null> {
  const board = boardOfCompany(o.company);
  if (!board) return null;
  let read: FeedPosting[];
  try { read = postingsOf(await o.fetchFeed(board)); }
  catch (e) { return { board, why: String((e as Error)?.message ?? e) }; }
  const words = searchWords(o.role).map(norm).filter(Boolean);
  const hits = read.filter((p) => { const t = ` ${norm(p.title)} `; return words.every((w) => t.includes(` ${w}`)); });
  return { board, hits };
}
