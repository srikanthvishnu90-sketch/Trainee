// Step 2: ground. Current real data through a web search (dark for now: see gatewayGroundSearch). Three limits keep it cheap:
//   cache      keyed by (field, stage, geography) with a TTL, so many similar questions share one set of searches; concurrent
//              identical misses share one in-flight run;
//   per answer at most MAX_SEARCHES searches and ANSWER_COST_CAP_USD counted at the worst case per search;
//   daily      the gateway's reserve refuses a search when the day's cap is used up (the answer then says what it could not verify).
import { webSearch } from "../../model_gateway.ts";
import type { Kind } from "./fields.ts";
import type { Understanding } from "./understand.ts";
import { acceptFacts, type Rejected } from "./guard.ts";

export interface Fact { id: string; kind: Kind; text: string; quote: string; url: string; label: string }
export interface Plan { q: string; kinds: Kind[] }
export type GroundOut = { status: "ok"; facts: Fact[]; urls: string[]; cost_usd: number | null } | { status: "blocked" | "error"; detail: string };
export type GroundSearch = (plan: Plan, ctx: { field: string; stage: string; geo: string }) => Promise<GroundOut>;

export const MAX_SEARCHES = 4;
export const WORST_PER_SEARCH_USD = 0.06;       // reserved per search in the answer's own cap (fee plus search content at a high input rate)
export const ANSWER_COST_CAP_USD = 0.25;
export const CACHE_TTL_MS = 14 * 24 * 3600_000;

export interface CacheEntry { at: number; facts: Fact[]; urls: string[] }
export interface GroundCache { get(key: string): Promise<CacheEntry | null>; set(key: string, e: CacheEntry): Promise<void> }
export const cacheKey = (field: string, stage: string, geoKey: string) => `${field}|${stage}|${geoKey}`;
export function memoryGroundCache(): GroundCache & { size(): number } {
  const m = new Map<string, CacheEntry>();
  return { async get(k) { return m.get(k) ?? null; }, async set(k, e) { m.set(k, e); }, size: () => m.size };
}
const inflight = new Map<string, Promise<Grounded>>();

export interface Grounded {
  facts: Fact[]; urls: string[]; from_cache: boolean; searches: number; cost_usd: number; worst_case_usd: number;
  notes: string[]; rejected: Rejected[];
}
export function queriesFor(u: Understanding): Plan[] {
  const fill = (s: string) => s.replace("{field}", u.field!.label).replace("{stage}", u.year ? `${u.year} college` : u.stageLabel.replace(/^an? /, "")).replace("{geo}", u.geo === "the US" ? "United States" : u.geo);
  return u.field!.queries.map((p) => ({ q: fill(p.q), kinds: p.kinds }));
}
export async function groundFor(o: { u: Understanding; search: GroundSearch; cache?: GroundCache; now: number; ttlMs?: number; maxSearches?: number; costCapUsd?: number }): Promise<Grounded> {
  const u = o.u;
  if (!u.field) return { facts: [], urls: [], from_cache: false, searches: 0, cost_usd: 0, worst_case_usd: 0, notes: ["no field to search for"], rejected: [] };
  const key = cacheKey(u.field.id, u.year ?? u.stage, u.geoKey), ttl = o.ttlMs ?? CACHE_TTL_MS;
  const hit = o.cache ? await o.cache.get(key).catch(() => null) : null;
  if (hit && o.now - hit.at < ttl) return { facts: hit.facts, urls: hit.urls, from_cache: true, searches: 0, cost_usd: 0, worst_case_usd: 0, notes: [], rejected: [] };
  const running = inflight.get(key);
  if (running) return { ...(await running), from_cache: true, searches: 0, cost_usd: 0, worst_case_usd: 0 };
  const run = (async (): Promise<Grounded> => {
    const cap = o.costCapUsd ?? ANSWER_COST_CAP_USD, max = o.maxSearches ?? MAX_SEARCHES;
    const g: Grounded = { facts: [], urls: [], from_cache: false, searches: 0, cost_usd: 0, worst_case_usd: 0, notes: [], rejected: [] };
    let failed = false;
    for (const plan of queriesFor(u).slice(0, max)) {
      if (g.worst_case_usd + WORST_PER_SEARCH_USD > cap) { g.notes.push("search stopped at the per-answer cost cap"); break; }
      g.searches++; g.worst_case_usd += WORST_PER_SEARCH_USD;
      let out: GroundOut;
      try { out = await o.search(plan, { field: u.field!.id, stage: u.stage, geo: u.geo }); }
      catch (e) { out = { status: "error", detail: e instanceof Error ? e.message.slice(0, 120) : "search failed" }; }
      if (out.status !== "ok") { failed = true; g.notes.push("a search was not completed, so some current data may be missing"); if (out.status === "blocked") break; continue; }
      if (out.cost_usd !== null) g.cost_usd += out.cost_usd;
      const { kept, rejected } = acceptFacts(out.facts, out.urls);
      g.rejected.push(...rejected);
      for (const f of kept) if (!g.facts.some((x) => x.text === f.text && x.url === f.url)) g.facts.push({ ...f, id: `F${g.facts.length + 1}` });
      g.urls.push(...out.urls.filter((x) => !g.urls.includes(x)));
    }
    if (o.cache && g.facts.length && !failed) await o.cache.set(key, { at: o.now, facts: g.facts, urls: g.urls }).catch(() => {});
    return g;
  })();
  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

// ------------------------------------------------------------------------------------------------ the searcher
// Research ships DARK (owner directive 2026-11-02: Claude-only; Claude web search is not verified on these models). The one
// searcher asks the gateway's web-search door, which answers "not available": nothing is reserved, sent or spent, and groundFor
// reports the search as not completed. The caller does not even offer research while WEB_SEARCH_AVAILABLE is false.
export function gatewayGroundSearch(): GroundSearch {
  return async () => {
    const r = await webSearch();
    return { status: "error", detail: r.detail.slice(0, 120) };
  };
}
