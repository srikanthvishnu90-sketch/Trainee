// R9-C (2026-11-07): where market research finds pages to read. A search provider only proposes addresses; nothing it returns is
// shown to the person until research_sources.ts fetched that page itself (HTTP 200, readable text) and the link passed
// verifiedLinkGuard. Every hit keeps its URL and the time it was found; every page keeps the time it was fetched.
//
//   brave        Brave Search API web search. Needs BRAVE_SEARCH_API_KEY, an env secret only the owner sets (Brave's Search plan
//                carries a monthly free credit; signing up is the owner's decision and any spend past the credit is his). Only
//                the result URLs are used, as candidates to fetch: Brave's own result text is never stored or shown.
//   first_party  No key. Only first-party sources: SEC EDGAR (a company's latest 10-K, from data.sec.gov), BLS Occupational
//                Employment and Wage Statistics pages (national, and a metro area when its CBSA code is given), and company
//                sites the turn names. SEC asks every caller to declare a contact in the User-Agent: RESEARCH_USER_AGENT; unset,
//                EDGAR is skipped and the result says so.
//
// Configurable: RESEARCH_SEARCH_PROVIDER (brave | first_party; default brave when the key is set, else first_party),
// RESEARCH_SEARCH_ENDPOINT (default Brave's web search endpoint), RESEARCH_SEARCH_COUNT (1 to 10, default 5), RESEARCH_USER_AGENT.
// LinkedIn, Indeed and Handshake are never proposed (isBlockedHost), nor anything but https.
import { isBlockedHost, isHttps, normalizeUrl, readCapped } from "./research_sources.ts";
// Review of #628: a provider's JSON answer is read as a stream to 2 MB; over the cap it is not parsed (the call fails as unread).
const SEARCH_JSON_MAX_BYTES = 2_000_000;
async function cappedJson(r: Response): Promise<any> {
  const got = await readCapped(r, SEARCH_JSON_MAX_BYTES);
  if (got.truncated) throw new Error("answer over 2 MB");
  return JSON.parse(new TextDecoder().decode(got.bytes));
}

type Env = { get(k: string): string | undefined };
// R9 free sources (2026-11-08): research_free_sources.ts freeProvider proposes the other free kinds.
export interface SearchHit { url: string; title: string; provider: "brave" | "sec_edgar" | "bls_oes" | "company_site" | "sec_fts" | "bls_ooh" | "usajobs" | "ats_board" | "wikipedia" | "wikidata" | "github" | "news_rss"; foundAt: number }
// What the turn knows to look for. Free-text queries go to a search engine; the hints go to first-party sources.
export interface SearchPlan {
  queries: string[]; // at most 3
  companies?: string[]; // names, for SEC EDGAR
  sites?: string[]; // company domains the person or the turn named ("acme.com")
  soc?: string | null; // a BLS occupation code, "15-1252"
  cbsa?: string | null; // a metro area code, "42660"
}
// gaps: what a free source could not supply, in plain words for the brief ("SEC EDGAR has no 10-K for Ramp"), D-007.
// basis: how a free source was chosen when the turn did not say ("Pay figures use BLS occupation 15-1252 ..."), shown on the brief.
export type SearchOut = { hits: SearchHit[]; notes: string[]; provider: string; searches: number; gaps?: string[]; basis?: string[] };
export interface SearchProvider { id: "brave" | "first_party"; needsKey: boolean; search(plan: SearchPlan): Promise<SearchOut> }

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_QUERIES = 3, MAX_HITS = 8;
const keep = (hits: SearchHit[]) => {
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (!isHttps(h.url) || isBlockedHost(h.url)) continue;
    const url = normalizeUrl(h.url);
    if (!out.some((o) => o.url === url)) out.push({ ...h, url });
  }
  return out.slice(0, MAX_HITS);
};
const countOf = (env: Env) => { const n = Number(env.get("RESEARCH_SEARCH_COUNT")); return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5; };

export function braveProvider(o: { key: string; fetch: typeof fetch; now: () => number; endpoint?: string; count?: number }): SearchProvider {
  return {
    id: "brave", needsKey: true,
    async search(plan) {
      const hits: SearchHit[] = [], notes: string[] = [];
      let searches = 0;
      for (const q of plan.queries.map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_QUERIES)) {
        const u = new URL(o.endpoint ?? BRAVE_ENDPOINT);
        u.searchParams.set("q", q.slice(0, 300)); u.searchParams.set("count", String(o.count ?? 5)); u.searchParams.set("safesearch", "strict");
        searches++;
        try {
          const r = await o.fetch(u.toString(), { headers: { accept: "application/json", "x-subscription-token": o.key }, signal: AbortSignal.timeout(10000) });
          if (!r.ok) { await r.body?.cancel().catch(() => {}); notes.push(`a search was not completed (HTTP ${r.status})`); if (r.status === 401 || r.status === 403 || r.status === 429) break; continue; }
          const j = await cappedJson(r);
          for (const x of Array.isArray(j?.web?.results) ? j.web.results : []) if (typeof x?.url === "string") hits.push({ url: x.url, title: String(x.title ?? "").slice(0, 200), provider: "brave", foundAt: o.now() });
        } catch { notes.push("a search was not completed"); }
      }
      return { hits: keep(hits), notes, provider: "brave", searches };
    },
  };
}

const SOC = /^\d{2}-\d{4}$/, CBSA = /^\d{5}$/, DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|corp|corporation|co|ltd|llc|plc|holdings|group|the)\b/g, " ").replace(/\s+/g, " ").trim();
let tickers: { at: number; rows: { cik: number; ticker: string; title: string }[] } | null = null;

export function firstPartyProvider(o: { fetch: typeof fetch; now: () => number; userAgent?: string | null }): SearchProvider {
  const get = (url: string) => o.fetch(url, { headers: { accept: "application/json", "user-agent": o.userAgent! }, signal: AbortSignal.timeout(10000) });
  async function edgar(name: string): Promise<SearchHit | null> {
    if (!tickers || o.now() - tickers.at > 24 * 3600_000) {
      const r = await get("https://www.sec.gov/files/company_tickers.json");
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
      tickers = { at: o.now(), rows: Object.values(await cappedJson(r) as Record<string, any>).map((x) => ({ cik: Number(x.cik_str), ticker: String(x.ticker ?? ""), title: String(x.title ?? "") })) };
    }
    const want = squash(name);
    const row = tickers.rows.find((x) => x.ticker.toLowerCase() === name.trim().toLowerCase()) ?? tickers.rows.find((x) => squash(x.title) === want);
    if (!row || !want) return null;
    const cik = String(row.cik).padStart(10, "0");
    const r = await get(`https://data.sec.gov/submissions/CIK${cik}.json`);
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
    const rec = (await cappedJson(r))?.filings?.recent ?? {};
    const i = (rec.form ?? []).findIndex((f: string) => f === "10-K");
    if (i < 0 || !rec.accessionNumber?.[i] || !rec.primaryDocument?.[i]) return null;
    return { url: `https://www.sec.gov/Archives/edgar/data/${row.cik}/${String(rec.accessionNumber[i]).replace(/-/g, "")}/${rec.primaryDocument[i]}`, title: `${row.title} 10-K (SEC EDGAR)`, provider: "sec_edgar", foundAt: o.now() };
  }
  return {
    id: "first_party", needsKey: false,
    async search(plan) {
      const hits: SearchHit[] = [], notes: string[] = [];
      let searches = 0;
      const cos = (plan.companies ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 4);
      if (cos.length && !o.userAgent) notes.push("SEC EDGAR was not searched: RESEARCH_USER_AGENT (a contact SEC requires) is not set");
      else for (const c of cos) { searches++; try { const h = await edgar(c); if (h) hits.push(h); else notes.push(`no 10-K on SEC EDGAR for ${c.slice(0, 60)}`); } catch { notes.push("SEC EDGAR did not answer"); } }
      const soc = String(plan.soc ?? "").trim(), cbsa = String(plan.cbsa ?? "").trim();
      if (SOC.test(soc)) {
        hits.push({ url: `https://www.bls.gov/oes/current/oes${soc.replace("-", "")}.htm`, title: `BLS wage data, occupation ${soc}`, provider: "bls_oes", foundAt: o.now() });
        if (CBSA.test(cbsa)) hits.push({ url: `https://www.bls.gov/oes/current/oes_${cbsa}.htm`, title: `BLS wage data, metro area ${cbsa}`, provider: "bls_oes", foundAt: o.now() });
      } else if (soc) notes.push("the occupation code is not a BLS code like 15-1252");
      for (const s of (plan.sites ?? []).map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((d) => DOMAIN.test(d)).slice(0, 4)) {
        hits.push({ url: `https://${s}/`, title: s, provider: "company_site", foundAt: o.now() }, { url: `https://${s}/about`, title: s, provider: "company_site", foundAt: o.now() });
      }
      if (!hits.length && plan.queries.length) notes.push("no first-party source fits this question without a search key");
      return { hits: keep(hits), notes, provider: "first_party", searches };
    },
  };
}

export function searchProviderFor(env: Env, f: typeof fetch, now: () => number = Date.now): SearchProvider {
  const key = (env.get("BRAVE_SEARCH_API_KEY") ?? "").trim(), want = (env.get("RESEARCH_SEARCH_PROVIDER") ?? "").trim().toLowerCase();
  const ua = (env.get("RESEARCH_USER_AGENT") ?? "").trim() || null;
  const endpoint = (env.get("RESEARCH_SEARCH_ENDPOINT") ?? "").trim();
  if (key && want !== "first_party") return braveProvider({ key, fetch: f, now, endpoint: /^https:\/\//.test(endpoint) ? endpoint : BRAVE_ENDPOINT, count: countOf(env) });
  return firstPartyProvider({ fetch: f, now, userAgent: ua });
}
// For reading the pages themselves: SEC and BLS refuse requests without a declared User-Agent; every other site gets the default.
export function declaredFetch(f: typeof fetch, userAgent: string | null | undefined): typeof fetch {
  if (!userAgent) return f;
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const host = (() => { try { return new URL(String(input instanceof Request ? input.url : input)).hostname; } catch { return ""; } })();
    if (!/(^|\.)(sec\.gov|bls\.gov)$/.test(host)) return f(input, init);
    const h = new Headers(init.headers); h.set("user-agent", userAgent);
    return f(input, { ...init, headers: h });
  }) as typeof fetch;
}
