// WO-044: the readers for the job boards past the four the 121 bundle reads (Greenhouse, Lever, Ashby, SmartRecruiters).
// One spec per provider: the request for a page of a board, how its body is read (JSON, or XML for the two XML feeds),
// the shape a real board answers with (discovery's verdict and ingest's read use the same test), the raw jobs, the ATS's
// own id for each, and each job rewritten into the Greenhouse job shape so the product's own normalizer
// (CareerJobs.normalizeGreenhouse: role family, seniority, remote, knockouts) runs on every provider alike.
//
// Every endpoint is public, read-only and keyless. Each one's source, and whether the provider documents it:
//   workable    GET  https://apply.workable.com/api/v1/widget/accounts/<slug>     {name, jobs: [...]}
//               the endpoint behind Workable's job widget (help.workable.com/hc/en-us/articles/115012801727); Workable
//               publishes no reference for it (described by third parties, dev.to/zsevic/integration-with-workable-public-jobs-api-3nk4)
//   recruitee   GET  https://<slug>.recruitee.com/api/offers/                     {offers: [...]}
//               Recruitee's Careers Site API, "does not require authorization" (support.recruitee.com/en/articles/1066282)
//   bamboohr    GET  https://<slug>.bamboohr.com/careers/list                     {meta: {totalCount}, result: [...]}
//               the JSON the BambooHR careers page itself loads; BambooHR documents only its keyed API, not this one
//   teamtailor  GET  https://<slug>.teamtailor.com/jobs.rss                       RSS 2.0, one <item> per job
//               the career site's public RSS feed (support.teamtailor.com, "RSS feed"); Teamtailor's JSON API needs a key
//   breezy      GET  https://<slug>.breezy.hr/json                                [...] one object per position
//               Breezy HR's public JSON feed of published positions (help.breezy.hr, "JSON feed of your positions")
//   personio    GET  https://<slug>.jobs.personio.de/xml                          <workzag-jobs><position>...</position>
//               Personio's documented XML feed of open positions (developer.personio.de, "Retrieving open job positions")
//   workday     POST https://<tenant>.<wdN>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
//               body {"appliedFacets":{},"limit":20,"offset":0,"searchText":""} -> {total, jobPostings: [...]}
//               the read-only job SEARCH the Workday career site itself calls (a POST that only reads: it creates, changes
//               and submits nothing). Workday publishes no reference for it. The board token is "<tenant>.<wdN>/<site>".
// The fixtures in tests/architect/wo-044-*.test.ts are hand-written from these shapes, not recorded responses.

export type MoreProvider = "workable" | "recruitee" | "bamboohr" | "teamtailor" | "breezy" | "personio" | "workday";
export const MORE_PROVIDERS: MoreProvider[] = ["workable", "recruitee", "bamboohr", "teamtailor", "breezy", "personio", "workday"];

export interface FeedRequest { url: string; method: "GET" | "POST"; body?: string; accept: string; host: string }
// A job in the Greenhouse job shape (what CareerJobs.normalizeGreenhouse reads).
export interface GhJob { id: string; title: string; absolute_url: string; location: { name: string }; first_published: string | null; content: string; departments: { name: string }[] }
export interface FeedSpec {
  request(board: string, page: number, probe?: boolean): FeedRequest;
  parse(text: string): unknown; // the body as data; undefined when it is not this provider's format at all
  shape(data: unknown): { postings: number; name: string | null } | null; // null: not this provider's board shape
  jobs(data: unknown): any[];
  total(data: unknown, page: number): number | null; // how many the board says it has (paged providers)
  pageSize: number; maxPages: number; // 1 page: the whole board in one request
  id(job: any): string;
  toGreenhouse(job: any, board: string): GhJob;
  company(data: unknown): string | null;
}

// ------------------------------------------------------------------------------------------------ a small XML reader
// Enough XML for two flat feeds: blocks by tag (not nested in themselves), a field's text with CDATA unwrapped and the
// five XML entities (and numeric ones) decoded. Tag names may carry a namespace prefix ("tt:location").
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function xmlUnescape(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/&/g, "\u0000AMP\u0000"))
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
    }).replace(/\u0000AMP\u0000/g, "&").trim();
}
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, "g");
  return [...String(xml || "").matchAll(re)].map((m) => m[1]);
}
export function xmlField(block: string, tag: string): string | null {
  const m = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`).exec(block);
  return m ? xmlUnescape(m[1]) : null;
}
const isRoot = (text: string, tag: string) => new RegExp(`^\\s*(?:<\\?xml[^>]*\\?>\\s*)?(?:<!--[\\s\\S]*?-->\\s*)*<${esc(tag)}[\\s>]`).test(text);

// ------------------------------------------------------------------------------------------------ helpers
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s.replace(/ UTC$/, "Z").replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const joinPlace = (...parts: unknown[]) => [...new Set(parts.map(str).filter(Boolean))].join(", ");
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const gh = (id: string, title: unknown, url: string, location: string, posted: string | null, content: unknown, department: unknown): GhJob =>
  ({ id, title: str(title), absolute_url: url, location: { name: location }, first_published: posted, content: str(content), departments: str(department) ? [{ name: str(department) }] : [] });
const get = (url: string, accept = "application/json"): FeedRequest => ({ url, method: "GET", accept, host: new URL(url).host });
const one = { total: () => null, pageSize: 0, maxPages: 1 };

// Workday says how old a posting is, not when it was posted ("Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago").
// Read as the latest date that wording allows ("30+" -> 30 days), relative to `now`; anything else -> null.
export function workdayPostedAt(text: unknown, now = Date.now()): string | null {
  const s = str(text).toLowerCase();
  const day = 86400000, at = (d: number) => new Date(Math.floor(now / day) * day - d * day).toISOString();
  if (/posted today/.test(s)) return at(0);
  if (/posted yesterday/.test(s)) return at(1);
  const m = /posted (\d+)\+? days? ago/.exec(s);
  return m ? at(Number(m[1])) : null;
}
// "<tenant>.<wdN>/<site>" -> its parts; null when the token is not that shape.
export function workdayParts(board: string): { tenant: string; wd: string; site: string; host: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/i.exec(String(board || ""));
  return m ? { tenant: m[1].toLowerCase(), wd: m[2].toLowerCase(), site: m[3], host: `${m[1].toLowerCase()}.${m[2].toLowerCase()}.myworkdayjobs.com` } : null;
}

// ------------------------------------------------------------------------------------------------ the specs
export const FEEDS: Record<MoreProvider, FeedSpec> = {
  workable: {
    ...one,
    request: (b, _p, probe) => get(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(b)}${probe ? "" : "?details=true"}`),
    parse: json,
    shape: (d: any) => (d && typeof d === "object" && Array.isArray(d.jobs) && typeof d.name === "string" ? { postings: d.jobs.length, name: d.name } : null),
    jobs: (d: any) => (d && Array.isArray(d.jobs) ? d.jobs : []),
    id: (j) => str(j && (j.shortcode || j.code)),
    company: (d: any) => (d && typeof d.name === "string" ? d.name : null),
    toGreenhouse: (j) => {
      const loc0 = Array.isArray(j.locations) && j.locations[0] ? j.locations[0] : {};
      const place = joinPlace(j.city || loc0.city, j.state || loc0.region, j.country || loc0.country) + (j.telecommuting ? " (Remote)" : "");
      return gh(str(j.shortcode || j.code), j.title, str(j.url || j.shortlink || (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : "")), place,
        iso(j.published_on || j.created_at), j.description || "", j.department);
    },
  },
  recruitee: {
    ...one,
    request: (b) => get(`https://${b}.recruitee.com/api/offers/`),
    parse: json,
    shape: (d: any) => (d && typeof d === "object" && Array.isArray(d.offers) ? { postings: d.offers.length, name: null } : null),
    jobs: (d: any) => (d && Array.isArray(d.offers) ? d.offers : []),
    id: (j) => str(j && j.id),
    company: (d: any) => str(d && Array.isArray(d.offers) && d.offers[0] && d.offers[0].company_name) || null,
    toGreenhouse: (j) => gh(str(j.id), j.title, str(j.careers_url), str(j.location) || joinPlace(j.city, j.state_name || j.state_code, j.country) + (j.remote ? " (Remote)" : ""),
      iso(j.published_at || j.created_at), `${str(j.description)} ${str(j.requirements)}`, j.department),
  },
  bamboohr: {
    ...one,
    request: (b) => get(`https://${b}.bamboohr.com/careers/list`),
    parse: json,
    shape: (d: any) => (d && typeof d === "object" && Array.isArray(d.result) && d.meta && typeof d.meta === "object" ? { postings: d.result.length, name: null } : null),
    jobs: (d: any) => (d && Array.isArray(d.result) ? d.result : []),
    id: (j) => str(j && j.id),
    company: () => null,
    toGreenhouse: (j, b) => {
      const l = j.atsLocation || j.location || {};
      const remote = j.isRemote === true || String(j.locationType) === "1";
      return gh(str(j.id), j.jobOpeningName, `https://${b}.bamboohr.com/careers/${encodeURIComponent(str(j.id))}`,
        joinPlace(l.city, l.state || l.province, l.country) + (remote ? " (Remote)" : ""), null, "", j.departmentLabel);
    },
  },
  teamtailor: {
    ...one,
    request: (b) => get(`https://${b}.teamtailor.com/jobs.rss`, "application/rss+xml, application/xml, text/xml"),
    parse: (text) => {
      if (!isRoot(text, "rss")) return undefined;
      const channel = xmlBlocks(text, "channel")[0];
      if (channel === undefined) return undefined;
      return { title: xmlField(channel.replace(/<item[\s>][\s\S]*$/, ""), "title"), items: xmlBlocks(channel, "item").map((it) => ({
        title: xmlField(it, "title"), link: xmlField(it, "link"), guid: xmlField(it, "guid"), pubDate: xmlField(it, "pubDate"),
        description: xmlField(it, "description"), remoteStatus: xmlField(it, "remoteStatus"), department: xmlField(it, "tt:department"),
        locations: xmlBlocks(it, "tt:location").map((l) => ({ name: xmlField(l, "tt:name"), city: xmlField(l, "tt:city"), country: xmlField(l, "tt:country") })),
      })) };
    },
    shape: (d: any) => (d && Array.isArray(d.items) ? { postings: d.items.length, name: d.title ?? null } : null),
    jobs: (d: any) => (d && Array.isArray(d.items) ? d.items : []),
    id: (j) => { const m = /\/jobs\/(\d+)/.exec(str(j && j.link)); return m ? m[1] : str(j && j.guid); },
    company: () => null,
    toGreenhouse: (j) => {
      const m = /\/jobs\/(\d+)/.exec(str(j.link));
      const place = (j.locations || []).map((l: any) => joinPlace(l.city || l.name, l.country)).filter(Boolean).join("; ");
      return gh(m ? m[1] : str(j.guid), j.title, str(j.link), place + (/^(fully|remote)/i.test(str(j.remoteStatus)) ? " (Remote)" : /hybrid/i.test(str(j.remoteStatus)) ? " (Hybrid)" : ""),
        iso(j.pubDate), j.description || "", j.department);
    },
  },
  breezy: {
    ...one,
    request: (b) => get(`https://${b}.breezy.hr/json`),
    parse: json,
    shape: (d: any) => (Array.isArray(d) && d.every((x) => x && typeof x === "object" && "name" in x && "id" in x) ? { postings: d.length, name: null } : null),
    jobs: (d: any) => (Array.isArray(d) ? d : []),
    id: (j) => str(j && j.id),
    company: (d: any) => str(Array.isArray(d) && d[0] && d[0].company && d[0].company.name) || null,
    toGreenhouse: (j) => {
      const l = j.location || {};
      const place = str(l.name) || joinPlace(l.city, l.state && l.state.name, l.country && l.country.name);
      return gh(str(j.id), j.name, str(j.url), place + (l.is_remote ? " (Remote)" : ""), iso(j.published_date), j.description || "", typeof j.department === "string" ? j.department : j.department && j.department.name);
    },
  },
  personio: {
    ...one,
    request: (b) => get(`https://${b}.jobs.personio.de/xml`, "application/xml, text/xml"),
    parse: (text) => {
      if (!isRoot(text, "workzag-jobs")) return undefined;
      return { positions: xmlBlocks(text, "position").map((p) => ({
        id: xmlField(p, "id"), name: xmlField(p, "name"), office: xmlField(p, "office"), subcompany: xmlField(p, "subcompany"),
        department: xmlField(p, "department"), createdAt: xmlField(p, "createdAt"), schedule: xmlField(p, "schedule"),
        additionalOffices: xmlBlocks(xmlBlocks(p, "additionalOffices")[0] ?? "", "office").map(xmlUnescape),
        descriptions: xmlBlocks(p, "jobDescription").map((d) => ({ name: xmlField(d, "name"), value: xmlField(d, "value") })),
      })) };
    },
    shape: (d: any) => (d && Array.isArray(d.positions) ? { postings: d.positions.length, name: null } : null),
    jobs: (d: any) => (d && Array.isArray(d.positions) ? d.positions : []),
    id: (j) => str(j && j.id),
    company: (d: any) => str(d && d.positions && d.positions[0] && d.positions[0].subcompany) || null,
    toGreenhouse: (j, b) => gh(str(j.id), j.name, `https://${b}.jobs.personio.de/job/${encodeURIComponent(str(j.id))}`,
      [j.office, ...(j.additionalOffices || [])].map(str).filter(Boolean).join("; "), iso(j.createdAt),
      (j.descriptions || []).map((d: any) => `<h3>${str(d.name)}</h3>${str(d.value)}`).join(""), j.department),
  },
  workday: {
    request: (b, page, probe) => {
      const w = workdayParts(b);
      if (!w) throw new Error(`not a Workday board token: ${b}`);
      const limit = probe ? 1 : 20;
      return { url: `https://${w.host}/wday/cxs/${w.tenant}/${encodeURIComponent(w.site)}/jobs`, method: "POST", accept: "application/json", host: w.host,
        body: JSON.stringify({ appliedFacets: {}, limit, offset: page * 20, searchText: "" }) };
    },
    parse: json,
    shape: (d: any) => (d && typeof d === "object" && Array.isArray(d.jobPostings) && Number.isFinite(Number(d.total)) ? { postings: Number(d.total), name: null } : null),
    jobs: (d: any) => (d && Array.isArray(d.jobPostings) ? d.jobPostings : []),
    // Workday answers the total on the first page only (later pages say 0).
    total: (d: any, page) => (page === 0 && d && Number.isFinite(Number(d.total)) ? Number(d.total) : null),
    pageSize: 20, maxPages: 50, // 1,000 postings; a larger board is a partial read (closes nothing)
    id: (j) => str(j && j.externalPath).replace(/^.*\//, ""),
    company: () => null,
    toGreenhouse: (j, b) => {
      const w = workdayParts(b)!;
      const path = str(j.externalPath);
      return gh(path.replace(/^.*\//, ""), j.title, `https://${w.host}/${w.site}${path.startsWith("/") ? path : "/" + path}`, str(j.locationsText), workdayPostedAt(j.postedOn), "", "");
    },
  },
};
export const isMoreProvider = (p: string): p is MoreProvider => Object.prototype.hasOwnProperty.call(FEEDS, p);
