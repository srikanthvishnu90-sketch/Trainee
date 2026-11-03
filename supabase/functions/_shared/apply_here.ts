// "APPLY HERE" INTAKE (owner, 2026-10-29): at mass scale nobody downloads anything. The person texts "apply here <link>" (or pastes a
// posting link, or says "apply to this" about the one posting just shown) and ONE button applies.
//
// What this turn does, all in code (the model decides nothing here):
//   * reads the links in the text; LinkedIn, Indeed and Handshake (any suffix) are refused by name, never opened;
//   * resolves each posting: our index first, else the one permitted fetch of the employer's public board (career_apply_link.ts
//     postingForLink: Greenhouse, Lever, Ashby); any other site is said plainly ("apply there yourself"), never guessed;
//   * runs the posting screen (career_apply_want.ts screenPicks, #276): closed / stale / scam / a CONFIRMED conflicting fact hold the
//     posting with the reason; a fact the person has not confirmed proceeds, labelled "not checked";
//   * answers with ONE short line and hands the postings to the channel (hits with apply_here: true). The channel shows one Apply
//     button with the exact payload summary (telegram_jobs.ts sendApplyHere): hash-bound, one tap = approval of exactly that
//     payload (D-MS-1). Several links: one list link (the hosted page, Apply on each row and one "Apply to all N" bound to the set).
// Nothing here queues, approves or sends anything: the tap does, and says only what is true (queued, never "applied").
import { neverOpen } from "./career_people_sites.ts";
import { applyText, linkOf, postingForLink } from "./career_apply_link.ts";
import { screenPicks } from "./career_apply_want.ts";
import { contentOf } from "./career_apply_gate.ts";
import { trackedFromRows } from "./career_apply_chat.ts";
import type { AppRow } from "./career_apply_status.ts";
import type { FetchFeed, PostingsDb } from "./career_ingest.ts";

export const APPLY_HERE_MAX_LINKS = 25;
const URL_IN = /https?:\/\/[^\s<>"'()]+/gi;
const HOW = /^\s*(how|what|where|when|why|which|should|is|are|am|do|does|did)\b/i;
// "apply here", "apply to this", "apply to that one", "apply for it": about the posting just shown, no link in the text.
const HERE = /^\s*(?:(?:ok|okay|pls|please|hey)\b[,!:]?\s+)*apply\s+(?:me\s+)?(?:here|(?:to|for)\s+(?:this|that|it)(?:\s+(?:one|job|role|posting))?)\s*[.!]?\s*$/i;
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export interface ApplyHereAsk { urls: string[]; blocked: string[]; fromLast: boolean }
// The ask, or null when the text is not one (a question about how, the past, a negation, a second ask joined to it).
export function applyHereAsk(message: string, last: { url?: string } | null): ApplyHereAsk | null {
  const raw = applyText(message);
  if (raw === null || /\bapplied\b/i.test(raw)) return null;
  const all = [...new Set((raw.match(URL_IN) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, "")))].filter((u) => /^https?:\/\/[^/]+\./i.test(u));
  let urls = all, fromLast = false;
  if (!all.length) {
    if (!last?.url || !HERE.test(raw)) return null;
    urls = [last.url]; fromLast = true;
  } else {
    const rest = raw.replace(URL_IN, " ");
    const bare = !/[\p{L}\p{N}]/u.test(rest);
    if (!bare && (!/\bapply\b/i.test(rest) || HOW.test(raw))) return null;
  }
  return { urls: urls.filter((u) => !neverOpen(hostOf(u))), blocked: urls.filter((u) => neverOpen(hostOf(u))), fromLast };
}

export interface ApplyHereHit { job_id: string; company: string; title: string; location: string; url: string; apply_here: true; not_checked?: string[] }
export interface ApplyHereResult { reply: string; status: "ready" | "refused"; hits: ApplyHereHit[]; refused: { url: string; why: string }[] }
export const BLOCKED_SAY = (url: string) => `${hostOf(url)}: I don't apply on LinkedIn, Indeed or Handshake for you; open it and apply there yourself.`;

export async function applyHereTurn(o: {
  message: string; now: number; db: PostingsDb; fetchFeed: FetchFeed; apps: () => Promise<AppRow[]>; facts: any[];
  last?: { url?: string } | null;
}): Promise<ApplyHereResult | null> {
  const ask = applyHereAsk(o.message, o.last ?? null);
  if (!ask) return null;
  const refused: ApplyHereResult["refused"] = ask.blocked.map((url) => ({ url, why: BLOCKED_SAY(url) }));
  const none = (reply: string): ApplyHereResult => ({ reply, status: "refused", hits: [], refused });
  let apps;
  try { apps = trackedFromRows(await o.apps()); }
  catch { return none("I couldn't check your applications just now, so nothing was set up. Send the link again in a minute."); }
  const hits: ApplyHereHit[] = [], seen = new Set<string>();
  const urls = ask.urls.slice(0, APPLY_HERE_MAX_LINKS);
  for (const url of urls) {
    const la = linkOf(url);
    if (!la) { refused.push({ url, why: `${hostOf(url) || "that site"}: I can only open Greenhouse, Lever and Ashby postings for you, so apply there yourself.` }); continue; }
    if (seen.has(la.key.toLowerCase())) continue;
    seen.add(la.key.toLowerCase());
    const f = await postingForLink({ ask: la, db: o.db, fetchFeed: o.fetchFeed, now: o.now });
    if (f.kind !== "found") {
      const why = f.kind === "closed" ? "that posting is closed" : f.kind === "not_on_board" ? `${f.board.company}'s board doesn't list it (closed, or never there)` : `I couldn't read ${f.board.company}'s board just now (${f.why.slice(0, 80)})`;
      refused.push({ url, why: `${hostOf(url)}: ${why}; nothing was set up.` });
      continue;
    }
    const p = f.posting;
    const pick = { job_id: p.job_id, url: p.url || url, company: p.company, title: p.title, location: p.location, content: contentOf(p) };
    const s = screenPicks([pick], { apps, facts: o.facts, now: o.now });
    if (!s.ok.length) { refused.push({ url, why: `${p.title} at ${p.company}: ${s.refused[0]?.said ?? "it didn't pass the posting screen"}` }); continue; }
    const nc = s.gate.unchecked[0]?.facts.map((x) => String(x).replace(/_/g, " "));
    hits.push({ job_id: p.job_id, company: p.company, title: p.title, location: p.location ?? "", url: p.url || url, apply_here: true, ...(nc?.length ? { not_checked: nc } : {}) });
  }
  if (ask.urls.length > urls.length) refused.push({ url: "", why: `I read the first ${urls.length} links only.` });
  const skipped = refused.length ? ` Skipped ${refused.length}: ${refused[0].why}${refused.length > 1 ? ` (+${refused.length - 1} more)` : ""}` : "";
  if (!hits.length) return none(refused.length === 1 ? `Not set up: ${refused[0].why}` : `Nothing set up. ${refused.slice(0, 3).map((r) => r.why).join(" ")}`);
  const one = hits.length === 1;
  const nc = one && hits[0].not_checked?.length ? ` Not checked: ${hits[0].not_checked.join(", ")}.` : "";
  const reply = one ? `${hits[0].title} at ${hits[0].company}: tap Apply.${nc}${skipped}` : `${hits.length} postings ready: open the list to Apply on each, or to all ${hits.length}.${skipped}`;
  return { reply, status: "ready", hits, refused };
}
