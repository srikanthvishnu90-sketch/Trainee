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
  // One posting per ask; two different postings in one text is the batch ask's, not this turn's.
  return asks.length === 1 ? asks[0] : null;
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
  let read: FeedPosting[];
  try { read = postingsOf(await o.fetchFeed(board)); }
  catch (e) { return onFile ? { kind: "closed", posting: onFile } : { kind: "unreadable", board, why: String((e as Error)?.message ?? e) }; }
  const hit = read.find((p) => sameKey(p.job_id, ask.key) || sameKey(String(p.ats_id ?? ""), ask.atsId));
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
