// R9 free sources (owner, 2026-11-08): research brief Files work from FREE, first-party sources only. No search API key and no
// paid data. A source only proposes an address; research_sources.ts fetchSources reads it on every hop through the same checks
// (https for links, never-list on any TLD, private names, the RESOLVED addresses of every hop, robots.txt), and the market facts
// guard (agent/research/market.ts) keeps a claim only when its subject, figures and words are in a quoted passage of a fetched page.
//
// What the no-key provider (freeProvider, id "first_party") proposes, on top of research_search.ts firstPartyProvider (BLS OEWS
// pages from a SOC/CBSA code, a company's latest 10-K from data.sec.gov, a named site's / and /about):
//   company sites     /careers, /press and /team of each site the turn names (robots.txt decides each path);
//   SEC EDGAR FTS     efts.sec.gov full-text search for the company's name (10-K, 10-Q, 8-K, S-1), the filing documents themselves;
//   BLS OOH           the Occupational Outlook Handbook page for the SOC code (a reviewed table; an unknown code says so);
//   USAJOBS           federal announcements in the OPM series for that SOC: the keyless historic announcements API, or the
//                     search API when the owner set the free USAJOBS_API_KEY (and RESEARCH_USER_AGENT, which USAJOBS requires);
//   ATS job boards    the public JSON of Greenhouse, Lever, Ashby and SmartRecruiters boards for the company (open roles, by
//                     place, and how many say intern, new grad, junior or entry level): hiring signal;
//   Wikipedia         the company's article (only when Wikipedia's summary describes an organization), and its Wikidata entity
//                     (employees, founding year, official website);
//   GitHub            the company's organization (only when its name or website matches the company);
//   news              GDELT's public RSS of recent headlines naming the company (headlines are reported, never verified).
// JSON, RSS and XML answers become plain sentences in code (convertFree), from the fields of the answer: a count is counted
// by code, nothing is paraphrased, and nothing a model wrote is in them. Where a fact has no free source the result says so in
// `gaps`, and the brief shows them (D-007).
//
// The documented public APIs (DOCUMENTED_API_HOSTS) are governed by their own terms, which invite programs; every other host is
// governed by robots.txt (robotsGate: 404 = no rules, unreadable = no read). Probes to fixed API hosts (the slug in the path is
// URL-encoded) only decide what to propose; the page shown is always the one the reader fetched.
// deno-lint-ignore-file no-explicit-any require-await
import { braveProvider, BRAVE_ENDPOINT, firstPartyProvider, type SearchHit, type SearchOut, type SearchPlan, type SearchProvider } from "./research_search.ts";
import { type Convert, fetchSources, type FetchedSources, isBlockedHost, normalizeUrl, type Resolver, type RobotsCheck } from "./research_sources.ts";
import { parseRobots, robotsAllows } from "./contact_sources/web_gate.ts";

type Env = { get(k: string): string | undefined };
export type FreeKind = "company_site" | "sec_edgar" | "sec_fts" | "bls_oes" | "bls_ooh" | "usajobs" | "ats_board" | "wikipedia" | "wikidata" | "github" | "news_rss";
export const FREE_KINDS: FreeKind[] = ["company_site", "sec_edgar", "sec_fts", "bls_oes", "bls_ooh", "usajobs", "ats_board", "wikipedia", "wikidata", "github", "news_rss"];
export const MAX_FREE_HITS = 16;
export const ROBOTS_TOKEN = "TraineeBot";
export const DEFAULT_UA = "TraineeBot/1.0 (+https://trainee.chat/bot)";

// Documented public APIs: their own terms govern (they are meant for programs). Everything else obeys robots.txt.
export const DOCUMENTED_API_HOSTS = new Set(["data.sec.gov", "efts.sec.gov", "data.usajobs.gov", "boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com",
  "api.smartrecruiters.com", "api.github.com", "www.wikidata.org", "api.gdeltproject.org"]);

// ---------------------------------------------------------------- BLS OOH and OPM series, by SOC code (reviewed 2026-11-08)
export const OOH: Record<string, { path: string; title: string }> = {
  "15-1252": { path: "computer-and-information-technology/software-developers.htm", title: "Software developers" },
  "15-1253": { path: "computer-and-information-technology/software-developers.htm", title: "Software quality assurance analysts and testers" },
  "15-1254": { path: "computer-and-information-technology/web-developers.htm", title: "Web developers" },
  "15-1255": { path: "computer-and-information-technology/web-developers.htm", title: "Web and digital interface designers" },
  "15-1211": { path: "computer-and-information-technology/computer-systems-analysts.htm", title: "Computer systems analysts" },
  "15-1212": { path: "computer-and-information-technology/information-security-analysts.htm", title: "Information security analysts" },
  "15-1232": { path: "computer-and-information-technology/computer-support-specialists.htm", title: "Computer support specialists" },
  "15-1242": { path: "computer-and-information-technology/database-administrators.htm", title: "Database administrators" },
  "15-1244": { path: "computer-and-information-technology/network-and-computer-systems-administrators.htm", title: "Network and computer systems administrators" },
  "15-2031": { path: "math/operations-research-analysts.htm", title: "Operations research analysts" },
  "15-2041": { path: "math/mathematicians-and-statisticians.htm", title: "Statisticians" },
  "15-2051": { path: "math/data-scientists.htm", title: "Data scientists" },
  "13-1111": { path: "business-and-financial/management-analysts.htm", title: "Management analysts" },
  "13-1161": { path: "business-and-financial/market-research-analysts.htm", title: "Market research analysts" },
  "13-1071": { path: "business-and-financial/human-resources-specialists.htm", title: "Human resources specialists" },
  "13-2011": { path: "business-and-financial/accountants-and-auditors.htm", title: "Accountants and auditors" },
  "13-2051": { path: "business-and-financial/financial-analysts.htm", title: "Financial analysts" },
  "13-2052": { path: "business-and-financial/personal-financial-advisors.htm", title: "Personal financial advisors" },
  "17-2051": { path: "architecture-and-engineering/civil-engineers.htm", title: "Civil engineers" },
  "17-2071": { path: "architecture-and-engineering/electrical-and-electronics-engineers.htm", title: "Electrical engineers" },
  "17-2141": { path: "architecture-and-engineering/mechanical-engineers.htm", title: "Mechanical engineers" },
  "29-1141": { path: "healthcare/registered-nurses.htm", title: "Registered nurses" },
  "47-2111": { path: "construction-and-extraction/electricians.htm", title: "Electricians" },
};
export const OPM_SERIES: Record<string, string> = {
  "15-1252": "2210", "15-1253": "2210", "15-1254": "2210", "15-1211": "2210", "15-1212": "2210", "15-1232": "2210", "15-1242": "2210", "15-1244": "2210",
  "15-2051": "1560", "15-2041": "1530", "15-2031": "1515", "13-1111": "0343", "13-1071": "0201", "13-2011": "0510", "13-2051": "1160",
  "17-2051": "0810", "17-2071": "0850", "17-2141": "0830", "29-1141": "0610",
};

// ---------------------------------------------------------------- helpers
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|corp|corporation|co|ltd|llc|plc|holdings|group|the|company)\b/g, " ").replace(/\s+/g, " ").trim();
const clean = (s: unknown, n = 200) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const siteOf = (s: string) => String(s).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
const apex = (host: string) => host.toLowerCase().replace(/^www\./, "");
// Board/org slugs to try for a company: its named site's first label, then its name squashed ("Acme Energy" -> acmeenergy, acme-energy).
export function slugsFor(company: string, sites: string[]): string[] {
  const out: string[] = [];
  const add = (x: string) => { const v = x.toLowerCase().replace(/[^a-z0-9-]/g, ""); if (v.length >= 2 && v.length <= 60 && !out.includes(v)) out.push(v); };
  const want = squash(company);
  for (const s of sites) { const label = siteOf(s).split(".")[0]; if (label && (!want || want.replace(/ /g, "").includes(label) || label.includes(want.split(" ")[0] ?? ""))) add(label); }
  if (want) { add(want.replace(/ /g, "")); add(want.replace(/ /g, "-")); }
  return out.slice(0, 2);
}
const fmt = (n: number) => n.toLocaleString("en-US");
const day = (t: unknown) => { const n = Date.parse(String(t ?? "")); return Number.isNaN(n) ? "" : new Date(n).toISOString().slice(0, 10); };
const ENTRY = /\b(intern(ship)?s?|new\s+grad(uate)?s?|graduate|junior|entry[\s-]level|early[\s-]career|apprentice|associate)\b/i;

// What an open-roles list says, in plain sentences: computed counts, then the roles themselves (title and place).
export function boardText(ats: string, token: string, roles: { title: string; location: string }[], total?: number): { title: string; text: string } {
  const n = Number.isInteger(total) && total! >= roles.length ? total! : roles.length;
  const lines = [`The ${ats} job board ${token} lists ${fmt(n)} open roles.`];
  const entry = roles.filter((r) => ENTRY.test(r.title)).length;
  if (roles.length) lines.push(`${fmt(entry)} of the ${fmt(roles.length)} open roles on the ${ats} job board ${token} say intern, new grad, junior, associate or entry level in the title.`);
  const by = new Map<string, number>();
  for (const r of roles) if (r.location) by.set(r.location, (by.get(r.location) ?? 0) + 1);
  for (const [loc, k] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) lines.push(`${fmt(k)} open roles on the ${ats} job board ${token} are in ${loc}.`);
  for (const r of roles.slice(0, 30)) lines.push(`Open role on the ${ats} job board ${token}: ${r.title}${r.location ? `, ${r.location}` : ""}.`);
  return { title: `${ats} job board: ${token}`, text: lines.join("\n") };
}
function rssItems(xml: string): { title: string; link: string; date: string; source: string }[] {
  const out: { title: string; link: string; date: string; source: string }[] = [];
  const cdata = (s: string) => s.replace(/^<!\[CDATA\[|\]\]>$/g, "");
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0], tag = (t: string) => decode(cdata((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, "i"))?.[1] ?? "").trim()));
    const link = tag("link"), title = clean(tag("title"), 200);
    let host = ""; try { host = new URL(link).hostname.replace(/^www\./, ""); } catch { /* no link */ }
    if (!title || !host || isBlockedHost(link)) continue;
    out.push({ title, link, date: day(tag("pubDate")), source: clean(tag("source"), 80) || host });
  }
  return out;
}

// ---------------------------------------------------------------- JSON / RSS answers to plain sentences
export const convertFree: Convert = (url, type, body) => {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase(), path = u.pathname;
  const J = () => JSON.parse(body);
  if (host === "boards-api.greenhouse.io") {
    const token = decodeURIComponent(path.split("/")[3] ?? ""), j = J();
    if (!Array.isArray(j?.jobs)) return null;
    return boardText("Greenhouse", token, j.jobs.map((x: any) => ({ title: clean(x?.title, 120), location: clean(x?.location?.name, 80) })).filter((r: any) => r.title), Number(j?.meta?.total));
  }
  if (host === "api.lever.co") {
    const token = decodeURIComponent(path.split("/")[3] ?? ""), j = J();
    if (!Array.isArray(j)) return null;
    return boardText("Lever", token, j.map((x: any) => ({ title: clean(x?.text, 120), location: clean(x?.categories?.location, 80) })).filter((r: any) => r.title));
  }
  if (host === "api.ashbyhq.com") {
    const token = decodeURIComponent(path.split("/")[3] ?? ""), j = J();
    if (!Array.isArray(j?.jobs)) return null;
    return boardText("Ashby", token, j.jobs.filter((x: any) => x?.isListed !== false).map((x: any) => ({ title: clean(x?.title, 120), location: clean(x?.location, 80) })).filter((r: any) => r.title));
  }
  if (host === "api.smartrecruiters.com") {
    const token = decodeURIComponent(path.split("/")[3] ?? ""), j = J();
    if (!Array.isArray(j?.content)) return null;
    const loc = (l: any) => [l?.city, l?.region, l?.country?.toUpperCase?.()].map((x) => clean(x, 40)).filter(Boolean).join(", ");
    return boardText("SmartRecruiters", token, j.content.map((x: any) => ({ title: clean(x?.name, 120), location: loc(x?.location) })).filter((r: any) => r.title), Number(j?.totalFound));
  }
  if (host === "api.github.com") {
    const j = J();
    if (!j?.login) return null;
    const lines = [`The GitHub organization ${clean(j.login, 60)}${j.name ? ` (${clean(j.name, 80)})` : ""} has ${fmt(Number(j.public_repos) || 0)} public repositories.`];
    if (j.description) lines.push(`The GitHub organization ${clean(j.login, 60)} describes itself as: ${clean(j.description, 200)}.`);
    if (j.location) lines.push(`The GitHub organization ${clean(j.login, 60)} lists its location as ${clean(j.location, 80)}.`);
    if (j.created_at) lines.push(`The GitHub organization ${clean(j.login, 60)} was created on ${day(j.created_at)}.`);
    return { title: `GitHub organization: ${clean(j.login, 60)}`, text: lines.join("\n") };
  }
  if (host === "www.wikidata.org") {
    const j = J(), e: any = Object.values(j?.entities ?? {})[0];
    if (!e?.labels?.en?.value) return null;
    const name = clean(e.labels.en.value, 80), lines = [`${name} (Wikidata ${clean(e.id, 20)}): ${clean(e.descriptions?.en?.value, 160) || "no English description"}.`];
    const best = (p: string) => { const xs = (e.claims?.[p] ?? []).filter((c: any) => c?.mainsnak?.datavalue); return xs.find((c: any) => c.rank === "preferred") ?? xs.at(-1) ?? null; };
    const emp = best("P1128");
    if (emp) { const n = Math.round(Number(String(emp.mainsnak.datavalue.value?.amount ?? "").replace("+", ""))); const at = String(emp.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? "").slice(1, 5);
      if (Number.isFinite(n) && n > 0) lines.push(`${name} had ${fmt(n)} employees${/^\d{4}$/.test(at) ? ` as of ${at}` : ""}, according to Wikidata.`); }
    const inc = best("P571");
    if (inc) { const y = String(inc.mainsnak.datavalue.value?.time ?? "").slice(1, 5); if (/^\d{4}$/.test(y)) lines.push(`${name} was founded in ${y}, according to Wikidata.`); }
    const web = best("P856");
    if (web) { const h = (() => { try { return new URL(String(web.mainsnak.datavalue.value)).hostname.replace(/^www\./, ""); } catch { return ""; } })(); if (h) lines.push(`${name}'s official website is ${h}, according to Wikidata.`); }
    return { title: `${name} (Wikidata)`, text: lines.join("\n") };
  }
  if (host === "data.usajobs.gov" && path.startsWith("/api/historicjoa")) {
    const j = J(), rows = Array.isArray(j?.data) ? j.data : null;
    if (!rows) return null;
    const series = u.searchParams.get("PositionSeries") ?? "", since = u.searchParams.get("StartPositionOpenDate") ?? "";
    const total = Number(j?.paging?.metadata?.totalCount);
    const lines = [`USAJOBS lists ${fmt(Number.isInteger(total) ? total : rows.length)} federal job announcements in occupational series ${series}${since ? ` opened since ${since}` : ""}.`];
    for (const r of rows.slice(0, 20)) {
      const where = (r?.positionLocations ?? []).slice(0, 1).map((l: any) => [l?.positionLocationCity, l?.positionLocationState].map((x) => clean(x, 40)).filter(Boolean).join(", ")).join("");
      const lo = Number(r?.minimumSalary), hi = Number(r?.maximumSalary);
      lines.push(`Federal announcement in series ${series}: ${clean(r?.positionTitle, 120)}, ${clean(r?.hiringAgencyName, 80)}${where ? `, ${where}` : ""}${lo > 0 && hi > 0 ? `, salary $${fmt(lo)} to $${fmt(hi)} a year` : ""}.`);
    }
    return { title: `USAJOBS federal announcements, series ${series}`, text: lines.join("\n") };
  }
  if (host === "data.usajobs.gov" && path.startsWith("/api/search")) {
    const r = J()?.SearchResult, items = Array.isArray(r?.SearchResultItems) ? r.SearchResultItems : null;
    if (!items) return null;
    const kw = u.searchParams.get("Keyword") ?? "";
    const lines = [`USAJOBS lists ${fmt(Number(r?.SearchResultCountAll) || items.length)} open federal job announcements for ${kw}.`];
    for (const it of items.slice(0, 20)) {
      const d = it?.MatchedObjectDescriptor ?? {}, pay = (d.PositionRemuneration ?? [])[0] ?? {};
      const lo = Number(pay.MinimumRange), hi = Number(pay.MaximumRange), per = pay.RateIntervalCode === "PA" ? " a year" : pay.RateIntervalCode === "PH" ? " an hour" : "";
      lines.push(`Open federal announcement for ${kw}: ${clean(d.PositionTitle, 120)}, ${clean(d.OrganizationName, 80)}${d.PositionLocationDisplay ? `, ${clean(d.PositionLocationDisplay, 80)}` : ""}${lo > 0 && hi > 0 ? `, salary $${fmt(lo)} to $${fmt(hi)}${per}` : ""}.`);
    }
    return { title: `USAJOBS open announcements: ${kw}`, text: lines.join("\n") };
  }
  if (/xml|rss|atom/.test(type)) {
    const items = rssItems(body);
    if (!items.length) return null;
    const q = (u.searchParams.get("query") ?? "").replace(/"/g, "").slice(0, 80);
    return { title: `News headlines${q ? `: ${q}` : ""}`, text: items.slice(0, 15).map((x) => `News headline (${x.source}${x.date ? `, ${x.date}` : ""}): ${x.title}.`).join("\n") };
  }
  return null;
};

// ---------------------------------------------------------------- robots.txt
// One robots.txt read per host per reader: 200 parsed for TraineeBot (or *), 404/410 no rules, anything else (3xx, 401, 403,
// 429, 5xx, unreachable) no read. Documented APIs are governed by their terms instead.
export function robotsGate(f: typeof fetch, o: { timeoutMs?: number } = {}): RobotsCheck {
  const cache = new Map<string, Promise<ReturnType<typeof parseRobots> | "deny">>();
  const load = (origin: string) => {
    let p = cache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const r = await f(`${origin}/robots.txt`, { redirect: "manual", headers: { accept: "text/plain" }, signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
          if (r.status === 200) return parseRobots(await r.text(), ROBOTS_TOKEN);
          await r.body?.cancel().catch(() => {});
          return r.status === 404 || r.status === 410 ? { rules: [], crawlDelayS: 0 } : "deny";
        } catch { return "deny"; }
      })();
      cache.set(origin, p);
    }
    return p;
  };
  return async (url) => {
    const u = new URL(url);
    if (DOCUMENTED_API_HOSTS.has(u.hostname.toLowerCase())) return true;
    const rb = await load(u.origin);
    return rb !== "deny" && robotsAllows(rb, u.pathname + u.search);
  };
}

// ---------------------------------------------------------------- DNS
// The production resolver: A and AAAA now, through Deno.resolveDns (looked up at call time). No answer throws: unreachable.
export const systemResolver: Resolver = async (host) => {
  const D: any = (globalThis as any).Deno;
  if (!D?.resolveDns) throw new Error("no DNS resolver");
  const ips: string[] = [];
  for (const t of ["A", "AAAA"]) { try { ips.push(...(await D.resolveDns(host, t)).map(String)); } catch { /* no records of this type */ } }
  if (!ips.length) throw new Error("no address");
  return ips;
};

// ---------------------------------------------------------------- the User-Agent each host is sent
// SEC and BLS refuse a request without a declared contact; Wikimedia, GitHub and USAJOBS ask for a descriptive one. USAJOBS's
// search API also takes the owner's free key in its header. Every other site gets the default.
export function freeFetch(f: typeof fetch, o: { userAgent?: string | null; usajobsKey?: string | null }): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    let host = "", path = "";
    try { const u = new URL(String(input instanceof Request ? input.url : input)); host = u.hostname.toLowerCase(); path = u.pathname; } catch { /* the fetch fails on its own */ }
    const h = new Headers(init.headers);
    if (/(^|\.)(sec\.gov|bls\.gov|usajobs\.gov)$/.test(host)) { if (o.userAgent) h.set("user-agent", o.userAgent); }
    else if (/(^|\.)(wikipedia\.org|wikidata\.org|github\.com|gdeltproject\.org)$/.test(host)) h.set("user-agent", o.userAgent || DEFAULT_UA);
    if (host === "api.github.com") h.set("accept", "application/vnd.github+json");
    if (host === "data.usajobs.gov" && path.startsWith("/api/search") && o.usajobsKey) h.set("authorization-key", o.usajobsKey);
    return f(input, { ...init, headers: h });
  }) as typeof fetch;
}

// ---------------------------------------------------------------- the provider
const WIKI_ORG = /\b(compan(y|ies)|corporation|firm|business|bank|startup|manufacturer|retailer|provider|conglomerate|agency|organi[sz]ation|insurer|developer|maker|platform|publisher|airline|brand|subsidiary|enterprise|operator)\b/i;
export function freeProvider(o: { fetch: typeof fetch; now: () => number; userAgent?: string | null; usajobsKey?: string | null }): SearchProvider {
  const f = freeFetch(o.fetch, o), base = firstPartyProvider({ fetch: f, now: o.now, userAgent: o.userAgent ?? null });
  const hit = (url: string, title: string, provider: string): SearchHit => ({ url, title, provider: provider as SearchHit["provider"], foundAt: o.now() });
  const getJson = async (url: string): Promise<any | null> => {
    try {
      const r = await f(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(8000) });
      if (r.status !== 200 || !/json/.test(r.headers.get("content-type") ?? "")) { await r.body?.cancel().catch(() => {}); return null; }
      return await r.json();
    } catch { return null; }
  };
  async function board(slug: string): Promise<SearchHit | null> {
    const s = encodeURIComponent(slug);
    const tries: [string, string, (j: any) => boolean][] = [
      [`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, "Greenhouse", (j) => Array.isArray(j?.jobs)],
      [`https://api.lever.co/v0/postings/${s}?mode=json`, "Lever", (j) => Array.isArray(j) && j.length > 0],
      [`https://api.ashbyhq.com/posting-api/job-board/${s}`, "Ashby", (j) => Array.isArray(j?.jobs)],
      [`https://api.smartrecruiters.com/v1/companies/${s}/postings`, "SmartRecruiters", (j) => Array.isArray(j?.content) && j.content.length > 0],
    ];
    const got = await Promise.all(tries.map(async ([u, , ok]) => ok(await getJson(u))));
    const i = got.indexOf(true);
    return i < 0 ? null : hit(tries[i][0], `${tries[i][1]} job board: ${slug}`, "ats_board");
  }
  async function wiki(name: string): Promise<SearchHit[]> {
    for (const t of [name, `${name} (company)`]) {
      const j = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`);
      if (!j || j.type !== "standard" || !WIKI_ORG.test(`${j.description ?? ""} ${String(j.extract ?? "").slice(0, 300)}`)) continue;
      const page = String(j.content_urls?.desktop?.page ?? "");
      if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(page)) continue;
      const out = [hit(page, `${clean(j.title, 100)} (Wikipedia)`, "wikipedia")];
      if (/^Q\d+$/.test(String(j.wikibase_item ?? ""))) out.push(hit(`https://www.wikidata.org/wiki/Special:EntityData/${j.wikibase_item}.json`, `${clean(j.title, 100)} (Wikidata)`, "wikidata"));
      return out;
    }
    return [];
  }
  async function github(name: string, slugs: string[], sites: string[]): Promise<SearchHit | null> {
    for (const s of slugs) {
      const j = await getJson(`https://api.github.com/orgs/${encodeURIComponent(s)}`);
      if (!j?.login) continue;
      const blog = (() => { try { return apex(new URL(/^https?:/.test(j.blog ?? "") ? j.blog : `https://${j.blog}`).hostname); } catch { return ""; } })();
      if ((blog && sites.some((x) => siteOf(x) === blog)) || (squash(String(j.name ?? "")) && squash(String(j.name)) === squash(name))) return hit(`https://api.github.com/orgs/${encodeURIComponent(s)}`, `GitHub organization: ${clean(j.login, 60)}`, "github");
    }
    return null;
  }
  async function fts(name: string): Promise<SearchHit[]> {
    const u = new URL("https://efts.sec.gov/LATEST/search-index");
    u.searchParams.set("q", `"${name.replace(/"/g, "")}"`); u.searchParams.set("forms", "10-K,10-Q,8-K,S-1");
    const j = await getJson(u.toString());
    const rows = Array.isArray(j?.hits?.hits) ? j.hits.hits : [];
    const want = squash(name), out: SearchHit[] = [];
    // The company's own filings first (the filer's name is the company), then filings by others that name it.
    const own = (r: any) => (r?._source?.display_names ?? []).some((d: string) => squash(String(d).replace(/\(.*$/, "")) === want);
    for (const r of [...rows.filter(own), ...rows.filter((r: any) => !own(r))].slice(0, 2)) {
      const [adsh, file] = String(r?._id ?? "").split(":"), cik = Number(String(r?._source?.ciks?.[0] ?? "").replace(/^0+/, ""));
      if (!/^\d{10}-\d{2}-\d{6}$/.test(adsh) || !/^[\w.-]+$/.test(file ?? "") || !cik) continue;
      out.push(hit(`https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}`, `${clean(r._source?.display_names?.[0], 80) || name} ${clean(r._source?.form, 10)} ${clean(r._source?.file_date, 10)} (SEC EDGAR full-text search)`, "sec_fts"));
    }
    return out;
  }
  return {
    id: "first_party", needsKey: false,
    async search(plan: SearchPlan): Promise<SearchOut> {
      const b = await base.search(plan);
      const notes = [...b.notes], gaps: string[] = [];
      let searches = b.searches;
      const companies = (plan.companies ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 3);
      const sites = (plan.sites ?? []).map(siteOf).filter((d) => DOMAIN.test(d)).slice(0, 3);
      const soc = String(plan.soc ?? "").trim();
      // Government data first (few pages, the pay and outlook figures), then each company in turn, its best sources first.
      const gov: SearchHit[] = b.hits.filter((h) => h.provider === "bls_oes");
      if (/^\d{2}-\d{4}$/.test(soc)) {
        const ooh = OOH[soc];
        if (ooh) gov.push(hit(`https://www.bls.gov/ooh/${ooh.path}`, `${ooh.title} (BLS Occupational Outlook Handbook)`, "bls_ooh"));
        else gaps.push(`The BLS Occupational Outlook Handbook has no page on file here for occupation code ${soc}.`);
        const series = OPM_SERIES[soc];
        if (series && o.usajobsKey && o.userAgent) {
          const u = new URL("https://data.usajobs.gov/api/search"); u.searchParams.set("Keyword", OOH[soc]?.title ?? soc); u.searchParams.set("ResultsPerPage", "25");
          gov.push(hit(u.toString(), `USAJOBS open announcements: ${OOH[soc]?.title ?? soc}`, "usajobs"));
        } else if (series) {
          const since = new Date(o.now() - 90 * 86400_000).toISOString().slice(0, 10);
          gov.push(hit(`https://data.usajobs.gov/api/historicjoa?PositionSeries=${series}&StartPositionOpenDate=${since}`, `USAJOBS federal announcements, series ${series}`, "usajobs"));
        }
      } else if (!soc && /\b(pay|salary|salaries|earn|wage|wages|comp(ensation)?|make)\b/i.test(plan.queries.join(" "))) {
        gaps.push("No government pay figure: the question did not give an occupation code, so BLS wage data was not read.");
      }
      const tiers: SearchHit[][] = [];
      const put = (t: number, h: SearchHit | null | undefined) => { if (h) (tiers[t] ??= []).push(h); };
      for (const h of b.hits.filter((h) => h.provider === "company_site")) put(0, h);
      for (const s of sites) { put(0, hit(`https://${s}/careers`, s, "company_site")); put(2, hit(`https://${s}/press`, s, "company_site")); put(3, hit(`https://${s}/team`, s, "company_site")); }
      for (const h of b.hits.filter((h) => h.provider === "sec_edgar")) put(1, h);
      const work = companies.map(async (c) => {
        const slugs = slugsFor(c, sites);
        searches += 3 + (o.userAgent ? 1 : 0);
        const [bd, wk, gh, ft] = await Promise.all([
          slugs.length ? Promise.any(slugs.map(async (s) => { const r = await board(s); if (!r) throw 0; return r; })).catch(() => null) : null,
          wiki(c), github(c, slugs, sites), o.userAgent ? fts(c) : Promise.resolve([] as SearchHit[]),
        ]);
        if (bd) put(0, bd); else gaps.push(`No public Greenhouse, Lever, Ashby or SmartRecruiters job board was found for ${c.slice(0, 60)}, so its open roles were not counted.`);
        wk.forEach((h) => put(1, h)); if (!wk.length) gaps.push(`Wikipedia has no company article found for ${c.slice(0, 60)}.`);
        put(3, gh);
        ft.forEach((h) => put(2, h));
        const n = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
        n.searchParams.set("query", `"${c.replace(/"/g, "")}"`); n.searchParams.set("mode", "artlist"); n.searchParams.set("format", "rss"); n.searchParams.set("maxrecords", "15"); n.searchParams.set("timespan", "3months"); n.searchParams.set("sourcelang", "english");
        put(3, hit(n.toString(), `News headlines: ${c.slice(0, 60)}`, "news_rss"));
      });
      await Promise.all(work);
      if (companies.length && !o.userAgent) gaps.push("SEC filings were not read: SEC asks every reader to declare a contact, and none is set up here yet.");
      for (const n of b.notes) if (/^no 10-K on SEC EDGAR for /.test(n)) gaps.push(`SEC EDGAR has no 10-K for ${n.replace(/^no 10-K on SEC EDGAR for /, "")} (it may be private).`);
      const seen = new Set<string>(), hits: SearchHit[] = [];
      for (const h of [...gov, ...tiers.flat()]) {
        if (isBlockedHost(h.url)) continue;
        const k = normalizeUrl(h.url);
        if (!seen.has(k)) { seen.add(k); hits.push({ ...h, url: k }); }
      }
      if (hits.length) for (let i = notes.length - 1; i >= 0; i--) if (/no first-party source fits/.test(notes[i])) notes.splice(i, 1);
      return { hits: hits.slice(0, MAX_FREE_HITS), notes, gaps, provider: "first_party", searches };
    },
  };
}

// ---------------------------------------------------------------- the reader
// The production reader for free research: every hop's resolved addresses checked, robots.txt obeyed, documented JSON and RSS
// converted, up to MAX_FREE_HITS pages, six at a time (order kept).
export function freeReader(o: { fetch: typeof fetch; userAgent?: string | null; usajobsKey?: string | null; resolver?: Resolver; now?: () => number }) {
  const f = freeFetch(o.fetch, o), robots = robotsGate(f), resolver = o.resolver ?? systemResolver;
  return async (urls: string[]): Promise<FetchedSources> => {
    const list = [...new Set(urls.map(normalizeUrl))].slice(0, MAX_FREE_HITS), out: FetchedSources = { verified: [], rejected: [] };
    const parts: FetchedSources[] = new Array(list.length);
    for (let i = 0; i < list.length; i += 6) {
      const batch = list.slice(i, i + 6);
      const got = await Promise.all(batch.map((u) => fetchSources([u], { fetch: f, resolver, robots, convert: convertFree, now: o.now, max: 1 })));
      got.forEach((g, j) => { parts[i + j] = g; });
    }
    for (const p of parts) { for (const v of p.verified) if (!out.verified.some((x) => x.url === v.url)) out.verified.push(v); out.rejected.push(...p.rejected); }
    return out;
  };
}
export function freeResearchFor(env: Env, f: typeof fetch, now: () => number = Date.now) {
  const userAgent = (env.get("RESEARCH_USER_AGENT") ?? "").trim() || null, usajobsKey = (env.get("USAJOBS_API_KEY") ?? "").trim() || null;
  return { search: freeProvider({ fetch: f, now, userAgent, usajobsKey }), read: freeReader({ fetch: f, userAgent, usajobsKey, now }) };
}
// The turn's search: Brave when the owner set BRAVE_SEARCH_API_KEY (and did not ask for first_party), else the free sources
// above. The reader is the free reader either way, so a Brave hit passes the same DNS, robots and never-list checks.
export function researchSearchFor(env: Env, f: typeof fetch, now: () => number = Date.now) {
  const key = (env.get("BRAVE_SEARCH_API_KEY") ?? "").trim(), want = (env.get("RESEARCH_SEARCH_PROVIDER") ?? "").trim().toLowerCase();
  const free = freeResearchFor(env, f, now);
  if (!key || want === "first_party") return free;
  const endpoint = (env.get("RESEARCH_SEARCH_ENDPOINT") ?? "").trim(), n = Number(env.get("RESEARCH_SEARCH_COUNT"));
  return { search: braveProvider({ key, fetch: f, now, endpoint: /^https:\/\//.test(endpoint) ? endpoint : BRAVE_ENDPOINT, count: Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5 }), read: free.read };
}
