// deno-lint-ignore-file no-explicit-any require-await
// A synthetic free web for the research tests (R9 free sources, split out of #615 on 2026-11-09): every company, figure and page
// is made up. No network.
export const NOW = Date.parse("2026-11-08T15:00:00Z");
export const html = (t: string, b: string) => new Response(`<!doctype html><html><head><title>${t}</title></head><body><p>${b}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
export const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json; charset=utf-8" } });
export const nf = () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
export const PUBLIC = async () => ["203.0.113.10"];

// ---------------------------------------------------------------- a synthetic free web
export const GH_JOBS = { jobs: [
  { title: "Software Engineer, New Grad", location: { name: "New York, NY" } }, { title: "Senior Software Engineer", location: { name: "New York, NY" } },
  { title: "Data Analyst Intern", location: { name: "Chicago, IL" } }, { title: "Account Executive", location: { name: "Remote" } },
], meta: { total: 4 } };
export const WIKI = { type: "standard", title: "Zentrafin", description: "American financial technology company", extract: "Zentrafin is a payments company.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Zentrafin" } }, wikibase_item: "Q999001" };
export const WD = { entities: { Q999001: { id: "Q999001", labels: { en: { value: "Zentrafin" } }, descriptions: { en: { value: "American financial technology company" } }, claims: {
  P1128: [{ rank: "normal", mainsnak: { datavalue: { value: { amount: "+2400" } } }, qualifiers: { P585: [{ datavalue: { value: { time: "+2025-00-00T00:00:00Z" } } }] } }],
  P571: [{ rank: "normal", mainsnak: { datavalue: { value: { time: "+2016-01-01T00:00:00Z" } } } }],
  P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.zentrafin.example" } } }] } } } };
export const GH_ORG = { login: "zentrafin", name: "Zentrafin", public_repos: 37, blog: "https://zentrafin.example", location: "New York", created_at: "2017-03-01T00:00:00Z", description: "Payments infrastructure" };
export const RSS = `<?xml version="1.0"?><rss><channel><item><title>Zentrafin opens a Chicago office</title><link>https://news.example/zentrafin-chicago</link><pubDate>Tue, 04 Nov 2026 10:00:00 GMT</pubDate></item><item><title>Zentrafin review roundup</title><link>https://www.glassdoor.co.uk/zentrafin</link></item></channel></rss>`;
export const FTS = { hits: { hits: [{ _id: "0009990001-26-000004:zen-8k.htm", _source: { ciks: ["0009990001"], display_names: ["Zentrafin Inc (ZEN) (CIK 0009990001)"], form: "8-K", file_date: "2026-10-01" } }] } };
export function freeWeb(log: string[] = [], o: { robots?: Record<string, Response | (() => Response)> } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input), u = new URL(url);
    log.push(`${url} ua=${new Headers(init.headers).get("user-agent") ?? ""} key=${new Headers(init.headers).get("authorization-key") ?? ""}`);
    if (u.pathname === "/robots.txt") { const r = o.robots?.[u.hostname]; return r ? (typeof r === "function" ? r() : r) : nf(); }
    if (url === "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs") return json(GH_JOBS);
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Zentrafin") return json(WIKI);
    if (url === "https://en.wikipedia.org/wiki/Zentrafin") return html("Zentrafin - Wikipedia", "Zentrafin is an American financial technology company founded in 2016.");
    if (url === "https://www.wikidata.org/wiki/Special:EntityData/Q999001.json") return json(WD);
    if (url === "https://api.github.com/orgs/zentrafin") return json(GH_ORG);
    if (u.hostname === "efts.sec.gov") return json(FTS);
    if (u.hostname === "api.gdeltproject.org") return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
    if (u.hostname === "data.usajobs.gov" && u.pathname === "/api/search") return json({ SearchResult: { SearchResultCountAll: 48, SearchResultItems: [{ MatchedObjectDescriptor: { PositionTitle: "IT Specialist", OrganizationName: "Department of Synthetic Affairs", PositionLocationDisplay: "Chicago, Illinois", PositionRemuneration: [{ MinimumRange: "72000", MaximumRange: "98000", RateIntervalCode: "PA" }] } }] } });
    if (u.hostname === "data.usajobs.gov") return json({ paging: { metadata: { totalCount: 212 } }, data: [{ positionTitle: "IT Specialist (APPSW)", hiringAgencyName: "Department of Synthetic Affairs", minimumSalary: 72000, maximumSalary: 98000, positionLocations: [{ positionLocationCity: "Chicago", positionLocationState: "Illinois" }] }] });
    if (url === "https://zentrafin.example/") return html("Zentrafin", "Zentrafin builds payment software.");
    if (url === "https://zentrafin.example/careers") return html("Careers at Zentrafin", "Zentrafin hires new grads into engineering every fall.");
    return nf();
  }) as typeof fetch;
}

