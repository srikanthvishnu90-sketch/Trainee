// D-060 (owner, 2026-11-11: "Web research"): Trainee's research searches the web through Claude's web search tool (the gateway's
// webSearch door, proven live: evals/research-live/). This module turns one search into what the research guard already reads:
//
//   hits      the result pages, official sources first (the employer's own site and job postings, government and university
//             data), then reporting, then self-reported pay data, then anecdotes. The free reader opens each one itself as before
//             (research_free_sources.ts freeReader: every hop's address, robots.txt, the never-list).
//   passages  the passages the search quoted word for word, by page. A quoted passage stands as its page's text ONLY when the
//             reader could not open that page itself (market.ts sourcePages): the link is the search tool's own result URL, and
//             the guard still keeps a point only when its quote is in that passage.
//   kind      every source is labelled (sourceKind): official, reported, self_reported or anecdote. A reply sentence that stands only
//             on self-reported or anecdotal sources must say so (market.ts enforceMarketReply).
//
// Limits (D-060 (3)): at most ONE web search call per turn (a provider instance is made per turn) with at most WEB_RESEARCH_SEARCHES
// searches, and a per-instance cache (the same queries within CACHE_TTL_MS return the same sources at no cost, which is also how a
// recalled answer cites the same source, C23). Off (CAREER_KNOWLEDGE rolled back, or no key): the free sources alone, as before.
import { WEB_SEARCH_AVAILABLE, type WebSearchResult } from "./model_gateway.ts";
import { releaseFlagOn } from "../agent-chat/release_config.ts";
import { isBlockedHost, isHttps, normalizeUrl } from "./research_sources.ts";
import { NEVER_SEARCH_DOMAINS } from "./research_never.ts";
import type { SearchHit, SearchOut, SearchPlan, SearchProvider } from "./research_search.ts";
import { type WorkdayRead, workdayUrl } from "./workday_posting.ts";

type Env = { get(k: string): string | undefined };
// Web research is on when the knowledge release flag is (D-060: CAREER_KNOWLEDGE is a release flag, rolled back with =off) and
// the gateway's web search is proven (WEB_SEARCH_AVAILABLE).
export const webResearchOn = (env: Env): boolean => WEB_SEARCH_AVAILABLE && releaseFlagOn(env, "CAREER_KNOWLEDGE");

export const WEB_RESEARCH_SEARCHES = 2; // searches per turn (one call, max_uses); the live proof measured about $0.044 a search
export const WEB_RESEARCH_CALLS_PER_TURN = 1;
export const WEB_CACHE_TTL_MS = 24 * 3600_000;
export const WEB_MAX_HITS = 8;

export type SourceKind = "official" | "reported" | "self_reported" | "anecdote";
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const under = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
// Anyone can post: forums, Q&A sites, anonymous review and interview-experience sites.
const ANECDOTE = ["reddit.com", "teamblind.com", "quora.com", "wallstreetoasis.com", "jointaro.com", "leetcode.com", "news.ycombinator.com", "medium.com", "fishbowlapp.com", "x.com", "twitter.com", "youtube.com", "tiktok.com"];
// Pay and offer figures their users report (useful, but self-reported and lagging).
const SELF_REPORTED = ["levels.fyi", "payscale.com", "salary.com", "comparably.com", "builtin.com", "simplify.jobs"];
// The employer's own postings, on the applicant tracking systems that host them.
const ATS = ["greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com", "myworkdayjobs.com", "workday.com", "icims.com", "jobvite.com"];
const SHARED_HOSTS = ["sites.google.com", "docs.google.com", "groups.google.com", "github.io", "github.com", "medium.com", "substack.com", "notion.site", "notion.so", "wordpress.com", "blogspot.com", "linkedin.com", "reddit.com", "facebook.com", "x.com", "twitter.com", "wixsite.com", "weebly.com", "webflow.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev"];
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
// official: a government or university source, an ATS posting, or the named employer's own site (its name is in the host's
// registrable label, "citadel" in citadel.com; not "citadelsecurities.com" for Citadel, which is a different employer).
// `domains` (market.ts FAIL_CLOSED.support passes it; review of #810: citadel.xyz and any .edu student page read as official): when
// given, "official" is only a government domain or a host whose registrable domain IS one of these, the employer's own domains as
// its record gives them (the search's own finding, never the model's); a name in a host, an ATS board or a .edu page is "reported".
export function sourceKind(url: string, companies: string[] = [], domains?: string[]): SourceKind {
  const host = hostOf(url);
  if (!host) return "reported";
  if (ANECDOTE.some((d) => under(host, d))) return "anecdote";
  if (SELF_REPORTED.some((d) => under(host, d))) return "self_reported";
  // Round 3: a host anyone can publish on is never official, whoever's name or domain it carries (sites.google.com for google.com).
  if (domains && (SHARED_HOSTS.some((d) => under(host, d)) || /(?:^|\.)glassdoor\.[a-z.]+$/.test(host))) return "reported";
  if (domains) { const reg = host.split(".").slice(-2).join("."); return /\.(gov|mil)$/.test(host) || domains.map((d) => hostOf(`https://${String(d).replace(/^https?:\/\//, "")}`)).some((d) => d && d.split(".").length === 2 && d === reg) ? "official" : "reported"; }
  if (/\.(gov|mil)$/.test(host) || /\.edu$/.test(host) || ATS.some((d) => under(host, d))) return "official";
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  if (companies.map(compact).some((c) => c.length >= 3 && label === c)) return "official";
  return "reported";
}
const RANK: Record<SourceKind, number> = { official: 0, reported: 1, self_reported: 2, anecdote: 3 };

export interface WebPassage { url: string; title: string; text: string; page_age: string | null }
export type WebSearchFn = (query: string, o: { maxUses: number; blockedDomains: string[] }) => Promise<WebSearchResult>;
export interface WebCacheEntry { at: number; out: SearchOut }
export interface WebCache { get(k: string): WebCacheEntry | null; set(k: string, e: WebCacheEntry): void }
export function memoryWebCache(): WebCache & { size(): number } {
  const m = new Map<string, WebCacheEntry>();
  return { get: (k) => m.get(k) ?? null, set: (k, e) => { m.set(k, e); if (m.size > 500) m.delete(m.keys().next().value!); }, size: () => m.size };
}
export const webCacheKey = (plan: SearchPlan) => [...plan.queries.map((q) => String(q).toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean)].sort().join(" | ");

// What the search model is asked: the turn's queries, official sources first. Its prose is never shown (the gateway returns it
// only for the record); the passages it cites, word for word, are what research reads.
export function webQueryText(plan: SearchPlan): string {
  const qs = plan.queries.map((q) => String(q).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3);
  return `Search the web for: ${qs.map((q, i) => `(${i + 1}) ${q}`).join(" ")}. Quote the passages that answer it, official sources first (the employer's own pages and postings, government data).`;
}

// The Claude web provider: one search call per instance (per turn), cached across turns by the turn's queries.
export function claudeWebProvider(o: { search: WebSearchFn; now: () => number; cache?: WebCache; ttlMs?: number; companies?: string[]; maxSearches?: number }): SearchProvider & { calls(): number } {
  let calls = 0;
  return {
    id: "claude_web", needsKey: true,
    calls: () => calls,
    async search(plan) {
      const queries = plan.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
      if (!queries.length) return { hits: [], notes: [], provider: "claude_web", searches: 0 };
      const key = webCacheKey({ queries }), hit = o.cache?.get(key);
      if (hit && o.now() - hit.at < (o.ttlMs ?? WEB_CACHE_TTL_MS)) return { ...hit.out, searches: 0, notes: [...hit.out.notes, "the same search earlier in this conversation's window: the same sources, not searched again"] };
      if (calls >= WEB_RESEARCH_CALLS_PER_TURN) return { hits: [], notes: ["this turn's web search was already used"], provider: "claude_web", searches: 0 };
      calls++;
      const max = Math.max(1, Math.min(o.maxSearches ?? WEB_RESEARCH_SEARCHES, queries.length + 1));
      const r = await o.search(webQueryText({ queries }), { maxUses: max, blockedDomains: [...NEVER_SEARCH_DOMAINS] }).catch((e) => ({ available: false, reason: "error", detail: String(e?.message ?? e).slice(0, 200), results: [] }) as WebSearchResult);
      if (!r.available) return { hits: [], notes: [`the web search was not completed (${r.reason})`], provider: "claude_web", searches: 0 };
      const companies = [...(plan.companies ?? []), ...(o.companies ?? [])];
      const ok = (u: string) => isHttps(u) && !isBlockedHost(u);
      const found = o.now();
      // Cited pages first (they answer the question), then the other results; within each, official sources first.
      const cited = [...new Set(r.citations.map((c) => normalizeUrl(c.url)))];
      const pages = [...cited.map((u) => ({ url: u, title: r.citations.find((c) => normalizeUrl(c.url) === u)?.title ?? "" })), ...r.results.map((x) => ({ url: normalizeUrl(x.url), title: x.title }))]
        .filter((p, i, a) => ok(p.url) && a.findIndex((q) => q.url === p.url) === i);
      const order = (u: string) => RANK[sourceKind(u, companies)] * 10 + (cited.includes(u) ? 0 : 5);
      const hits: SearchHit[] = pages.sort((a, b) => order(a.url) - order(b.url)).slice(0, WEB_MAX_HITS).map((p) => ({ url: p.url, title: p.title.slice(0, 200), provider: "claude_web", foundAt: found }));
      const passages: WebPassage[] = [];
      for (const c of r.citations) {
        const u = normalizeUrl(c.url);
        if (!ok(u) || !hits.some((h) => h.url === u)) continue;
        const p = passages.find((x) => x.url === u);
        if (p) { if (!p.text.includes(c.cited_text)) p.text = `${p.text}\n${c.cited_text}`; }
        else passages.push({ url: u, title: c.title, text: c.cited_text, page_age: r.results.find((x) => normalizeUrl(x.url) === u)?.page_age ?? null });
      }
      const out: SearchOut = { hits, notes: r.errors.length ? [`the web search reported: ${r.errors.join(", ")}`] : [], provider: "claude_web", searches: r.searches, passages, cost_usd: r.cost_usd };
      if (hits.length) o.cache?.set(key, { at: found, out });
      return out;
    },
  };
}

// The turn's search with web research on: the free first-party sources (government data, filings, job boards) and the web search,
// official first. Off: the free sources alone, unchanged.
export function withWebSearch(web: SearchProvider, free: SearchProvider): SearchProvider {
  return {
    id: "claude_web", needsKey: true,
    async search(plan) {
      const [a, b] = await Promise.all([free.search(plan).catch(() => ({ hits: [], notes: ["the free sources did not answer"], provider: "first_party", searches: 0 }) as SearchOut), web.search(plan)]);
      const hits: SearchHit[] = [];
      for (const h of [...a.hits, ...b.hits]) if (!hits.some((x) => x.url === h.url)) hits.push(h);
      return { ...a, hits: hits.slice(0, WEB_MAX_HITS + 4), notes: [...a.notes, ...b.notes], provider: b.searches || b.hits.length ? "claude_web" : a.provider, searches: a.searches + b.searches, passages: b.passages ?? [], cost_usd: b.cost_usd ?? null };
    },
  };
}

// ------------------------------------------------------------------------------------------------ "is that posting still open?"
// D-060 (C18): a live re-check of a named posting page, only on the job boards the product already reads by their public APIs
// (link_check.ts: Greenhouse, Lever and SmartRecruiters by posting id, Ashby by its posting page) and, since D-062, Workday by
// the posting's own CXS data (workday_posting.ts: open or closed, and the application deadline when the posting states one).
// Any other host (a company's own careers site) is not read here: the answer says so and gives the link, never a guess.
// Nothing is applied for.
export type PostingRecheck = { state: "open" | "closed" | "unknown"; board: string; url: string; checked_at: string; title?: string; deadline?: string | null; deadline_text?: string | null; why?: string }
  | { state: "not_readable"; host: string; url: string };
export const READABLE_BOARDS = ["Greenhouse", "Lever", "SmartRecruiters", "Ashby", "Workday"] as const;
export function postingJobId(url: string): { id: string; board: string } | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase(), seg = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const i = seg.indexOf("jobs"), board = (i > 0 ? seg[i - 1] : u.searchParams.get("for")) ?? "", id = i >= 0 ? seg[i + 1] : u.searchParams.get("token");
    return board && id && /^\d+$/.test(id) && /^[A-Za-z0-9._-]+$/.test(board) ? { id: `greenhouse:${board}:${id}`, board: "Greenhouse" } : null;
  }
  if (host === "jobs.lever.co" && seg.length >= 2 && /^[0-9a-f-]{8,}$/i.test(seg[1])) return { id: `lever:${seg[0]}:${seg[1].toLowerCase()}`, board: "Lever" };
  if (host === "jobs.ashbyhq.com" && seg.length >= 2 && /^[0-9a-f-]{8,}$/i.test(seg[1])) return { id: `ashby:${seg[0]}:${seg[1].toLowerCase()}`, board: "Ashby" };
  if (host === "jobs.smartrecruiters.com" && seg.length >= 2) { const id = /^(\d+)/.exec(seg[1])?.[1]; return id ? { id: `smartrecruiters:${seg[0]}:${id}`, board: "SmartRecruiters" } : null; }
  const wd = workdayUrl(url);
  if (wd) return { id: wd.key, board: "Workday" };
  return null;
}
// `workday`: the Workday posting reader (workday_posting.ts readWorkdayPosting); absent, a Workday link is checked by `check`
// (link_check.ts, the same CXS read without the deadline).
export async function recheckPosting(url: string, check: (job: { job_id?: string; url?: string }) => Promise<"live" | "dead" | "unknown">, now: () => number = Date.now,
  o: { workday?: ((url: string) => Promise<WorkdayRead | null>) | null } = {}): Promise<PostingRecheck> {
  const clean = String(url ?? "").trim();
  const job = isHttps(clean) && !isBlockedHost(clean) ? postingJobId(clean) : null;
  if (!job) return { state: "not_readable", host: hostOf(clean) || "that site", url: clean };
  if (job.board === "Workday" && o.workday) {
    const w = await o.workday(clean).catch(() => null);
    return { state: w?.state ?? "unknown", board: "Workday", url: clean, checked_at: new Date(now()).toISOString(), ...(w?.posting ? { title: w.posting.title, deadline: w.posting.deadline, deadline_text: w.posting.deadline_text } : {}), why: w?.why ?? "the Workday read did not finish" };
  }
  const s = await check({ job_id: job.id, url: clean }).catch(() => "unknown" as const);
  return { state: s === "live" ? "open" : s === "dead" ? "closed" : "unknown", board: job.board, url: clean, checked_at: new Date(now()).toISOString() };
}
