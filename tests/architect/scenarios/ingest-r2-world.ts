// INGEST ROUND 2: the world the battery runs in. Fake ATS boards for every provider ingest reads (their public body shapes,
// written from a canonical list of jobs, so what each board lists is known exactly), a fake network that serves those
// bodies in random chunks (multi-byte characters split across chunks) or answers with the failures real boards give,
// and a postings store with Postgres's refusals (the table checks, NUL, a lone surrogate in JSON) so a row the database
// would refuse fails here too. Nothing here reads a network, a clock or a database.
import { memoryPostingsDb, type Posting, type PostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

export type Provider = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "recruitee" | "bamboohr" | "teamtailor" | "breezy" | "personio" | "workday";
export const PROVIDERS: Provider[] = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee", "bamboohr", "teamtailor", "breezy", "personio", "workday"];
export const JSON_ONE_REQUEST: Provider[] = ["greenhouse", "lever", "ashby", "workable", "recruitee", "bamboohr", "breezy"];
export const PAGED: Provider[] = ["smartrecruiters", "workday"];
export const XML: Provider[] = ["teamtailor", "personio"];
// Providers whose link comes from the board itself (the rest build it from the id).
export const OWN_LINK: Provider[] = ["greenhouse", "lever", "ashby", "workable", "recruitee", "breezy"];

// ------------------------------------------------------------------------------------------------ seeded randomness
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}
export type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------------------------------------ jobs
export type Link = "canon" | "http" | "none" | "linkedin" | "indeed";
export interface Pay { min: number; max: number; currency: string; interval?: string; title?: string } // min/max in whole units (Lever) or cents (Greenhouse: x100 below)
export interface Job {
  n: number; title: string; location: string; desc: string; link: Link;
  posted?: string | number | null; // Greenhouse first_published / Lever createdAt as the board gives it
  pay?: Pay | null; payText?: string | null; // Greenhouse/Lever structured; Ashby's own summary text
  dupeOf?: number; // a second entry under the id of job dupeOf (the board lists one id twice)
}
const hex = (n: number, len: number) => { let s = "", x = (n * 2654435761) >>> 0; while (s.length < len) { x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0; s += x.toString(16).padStart(8, "0"); } return s.slice(0, len); };
const uuid = (n: number) => { const h = hex(n + 17, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
// The id the ATS gives job n on this board, as ingest reads it back (career_ingest.ts RAW_ID / career_ingest_feeds.ts id).
export function atsId(p: Provider, n: number): string {
  switch (p) {
    case "greenhouse": return String(4000000 + n);
    case "lever": case "ashby": return uuid(n);
    case "smartrecruiters": return String(744000000000 + n);
    case "workable": return hex(n, 10).toUpperCase();
    case "recruitee": return String(90000 + n);
    case "bamboohr": return String(100 + n);
    case "teamtailor": return String(3100000 + n);
    case "breezy": return hex(n + 3, 12);
    case "personio": return String(1200000 + n);
    case "workday": return `Associate_R${20000 + n}`;
  }
}
export const jobIdOf = (p: Provider, board: string, n: number) => `${p}:${board.toLowerCase()}:${atsId(p, n)}`;
export function canonUrl(p: Provider, board: string, n: number): string {
  const id = atsId(p, n);
  switch (p) {
    case "greenhouse": return `https://boards.greenhouse.io/${board}/jobs/${id}`;
    case "lever": return `https://jobs.lever.co/${board}/${id}`;
    case "ashby": return `https://jobs.ashbyhq.com/${board}/${id}`;
    case "smartrecruiters": return `https://jobs.smartrecruiters.com/${board}/${id}`;
    case "workable": return `https://apply.workable.com/j/${id}`;
    case "recruitee": return `https://${board}.recruitee.com/o/associate-${id}`;
    case "bamboohr": return `https://${board}.bamboohr.com/careers/${id}`;
    case "teamtailor": return `https://${board}.teamtailor.com/jobs/${id}-associate`;
    case "breezy": return `https://${board}.breezy.hr/p/${id}-associate`;
    case "personio": return `https://${board}.jobs.personio.de/job/${id}`;
    case "workday": { const [t, rest] = board.split("."); const [wd, site] = rest.split("/"); return `https://${t}.${wd}.myworkdayjobs.com/${site}/job/Austin-TX/${id}`; }
  }
}
export function linkOf(p: Provider, board: string, j: Job): string | undefined {
  const id = atsId(p, j.n);
  switch (j.link) {
    case "canon": return canonUrl(p, board, j.n);
    case "http": return canonUrl(p, board, j.n).replace(/^https:/, "http:");
    case "linkedin": return `https://www.linkedin.com/jobs/view/${3900000000 + j.n}`;
    case "indeed": return `https://www.indeed.com/viewjob?jk=${id.toLowerCase().slice(0, 16)}`;
    case "none": return undefined;
  }
}
// Whether ingest can keep job j: a title and an https link (a board that builds its link from the id always has one).
export function keepable(p: Provider, j: Job): boolean {
  if (!cleanText(j.title)) return false;
  if (!OWN_LINK.includes(p)) return true;
  if (p === "workable" && j.link === "none") return true; // Workable's reader builds the link from the shortcode
  return j.link === "canon" || j.link === "linkedin" || j.link === "indeed";
}
// What a stored text is allowed to be for a source text: what Postgres stores (no NUL or control character, no lone
// surrogate), its runs of white space one space. Used as the oracle for a clean title / location.
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------------------------------------ texts the boards carry
export const TITLES = [
  "Store Associate", "Registered Nurse - ICU (Nights)", "Senior Software Engineer, Payments", "<b>Senior</b> Data Analyst",
  "<script>alert(1)</script>Pharmacy Technician", "مهندس برمجيات أول", "מהנדס תוכנה", "🚀 Growth Marketing Lead", "R&D Lab Technician",
  "Product Manager — Growth", "  Customer\n\tSuccess   Manager  ", "Nurse\u0000 Practitioner", "Barista \ud83d", "Ingénieur(e) Logiciel (H/F)",
  "Werkstudent (m/w/d) Vertrieb", "販売スタッフ", "Line Cook $18/hr", "Cashier (Part-Time) – Weekends", "x".repeat(499) + "🚀 Lead",
];
export const LOCATIONS = [
  "Remote", "Remote - US", "Remote (EU only)", "Remote, Canada", "New York, NY; San Francisco, CA", "Berlin, Germany", "", "Hybrid - Austin, TX",
  "São Paulo, Brazil", "Tel Aviv-Yafo, Israel", "London, England, United Kingdom", "Anywhere", "Multiple Locations", "Dubai, UAE 🇦🇪",
];
export const DESCS = [
  "<p>Stock shelves, help customers &amp; keep the floor clean.</p>", "Plain text description with no markup.",
  "<div><script>var tracking = 1;</script><p>Care for patients.</p></div>", "Salary: $100k–$120k DOE. Benefits included.",
  "Contains a NUL\u0000 byte from a broken export.", "Broken emoji at the end \ud83d", "عربي نص الوصف ✓", "",
];
export const GH_PAY: (Pay | null)[] = [
  null, { min: 10000000, max: 12000000, currency: "USD", title: "US base salary" }, { min: 1750, max: 2250, currency: "USD", title: "Hourly" },
  { min: 6823000, max: 12622500, currency: "EUR", title: "Ireland" }, { min: 8000000, max: 9000000, currency: "", title: "" },
  { min: 5000000, max: 7000000, currency: "€", title: "Germany" }, { min: 9000000, max: 5000000, currency: "USD" }, { min: 0, max: 0, currency: "USD", title: "Not stated" },
  { min: 4500000, max: 4500000, currency: "GBP", title: "London" },
];
export const LEVER_PAY: (Pay | null)[] = [
  null, { min: 85000, max: 175000, currency: "USD", interval: "per-year-salary" }, { min: 17.5, max: 22.25, currency: "USD", interval: "per-hour-wage" },
  { min: 9500, max: 10700, currency: "MXN", interval: "per-month-salary" }, { min: 60000, max: 80000, currency: "", interval: "per-year-salary" },
  { min: 33, max: 33, currency: "USD", interval: "per-hour-wage" }, { min: 50000, max: 70000, currency: "€", interval: "per-year-salary" },
];
export const ASHBY_PAY: (string | null)[] = [null, "$190.8K – $262.8K • Offers Equity", "€100K – €120K", "$45/hr", "DOE", "Competitive", "£40,000 - £50,000 per annum", "¥6,000,000 – ¥8,000,000"];
export const POSTED: (string | number | null)[] = [null, "2026-10-20T10:00:00-04:00", "2026-10-20", "2026-10-20T23:30:00+05:30", "not a date", Date.UTC(2026, 9, 1, 12)];

export function makeJob(r: Rng, n: number, p: Provider, o: { dirty?: boolean } = {}): Job {
  const dirty = o.dirty ?? r.chance(0.35);
  const title = dirty ? r.pick(TITLES) : r.pick(TITLES.slice(0, 4)) + ` ${n}`;
  const link: Link = OWN_LINK.includes(p) && dirty && r.chance(0.3) ? r.pick(["http", "none", "linkedin", "indeed"] as const) : "canon";
  return {
    n, title,
    location: r.pick(LOCATIONS), desc: dirty ? r.pick(DESCS) + (r.chance(0.05) ? longDesc(r) : "") : `Job ${n}. ${r.pick(DESCS.slice(0, 3))}`, link,
    posted: r.pick(POSTED),
    pay: p === "greenhouse" ? r.pick(GH_PAY) : p === "lever" ? r.pick(LEVER_PAY) : null,
    payText: p === "ashby" ? r.pick(ASHBY_PAY) : null,
  };
}
// A description past the 20,000-character limit with a surrogate pair straddling the cut.
export function longDesc(r: Rng): string { const pre = "lorem ipsum dolor ".repeat(1112).slice(0, 19999 - r.int(0, 1)); return pre + "😀".repeat(3) + " tail"; }

// ------------------------------------------------------------------------------------------------ board bodies
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, ">");
// One board's list of jobs as the provider's own body (one request; paged providers: the page asked for).
export function render(p: Provider, board: string, jobs: Job[], page?: { offset: number; limit: number; total?: number }): string {
  const id = (j: Job) => atsId(p, j.dupeOf ?? j.n);
  const link = (j: Job) => linkOf(p, board, j);
  switch (p) {
    case "greenhouse": return JSON.stringify({ jobs: jobs.map((j) => ({ id: Number(id(j)), title: j.title, location: { name: j.location }, absolute_url: link(j), first_published: typeof j.posted === "number" ? new Date(j.posted).toISOString() : j.posted,
      content: j.desc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), departments: [{ name: "Operations" }],
      ...(j.pay ? { pay_input_ranges: [{ min_cents: j.pay.min, max_cents: j.pay.max, currency_type: j.pay.currency, title: j.pay.title ?? "" }] } : {}) })), meta: { total: jobs.length } });
    case "lever": return JSON.stringify(jobs.map((j) => ({ id: id(j), text: j.title, categories: { location: j.location, team: "Retail" }, hostedUrl: link(j), applyUrl: link(j) ? `${link(j)}/apply` : undefined,
      createdAt: typeof j.posted === "number" ? j.posted : j.posted ? Date.parse(j.posted) || j.posted : undefined, descriptionPlain: j.desc, description: `<div>${j.desc}</div>`,
      ...(j.pay ? { salaryRange: { min: j.pay.min, max: j.pay.max, currency: j.pay.currency, interval: j.pay.interval } } : {}) })));
    case "ashby": return JSON.stringify({ apiVersion: "1", jobs: jobs.map((j) => ({ id: id(j), title: j.title, locationName: j.location || undefined, jobUrl: link(j), publishedAt: typeof j.posted === "string" ? j.posted : undefined,
      descriptionPlain: j.desc, departmentName: "Ops", ...(j.payText ? { compensation: { compensationTierSummary: j.payText } } : {}) })) });
    case "smartrecruiters": {
      const all = jobs.map((j) => ({ id: id(j), name: j.title, refNumber: `REF${j.n}`, location: { city: j.location.split(",")[0] || "Austin", region: "TX", country: "us", remote: /remote/i.test(j.location) }, releasedDate: "2026-10-20T00:00:00.000Z", department: { label: "Ops" } }));
      const off = page?.offset ?? 0, lim = page?.limit ?? 100;
      return JSON.stringify({ offset: off, limit: lim, totalFound: page?.total ?? all.length, content: all.slice(off, off + lim) });
    }
    case "workable": return JSON.stringify({ name: "Acme", description: "", jobs: jobs.map((j) => ({ title: j.title, shortcode: id(j), department: "Ops", url: link(j), published_on: typeof j.posted === "string" ? j.posted : undefined, city: j.location.split(",")[0], state: "", country: "US", telecommuting: /remote/i.test(j.location), description: j.desc })) });
    case "recruitee": return JSON.stringify({ offers: jobs.map((j) => ({ id: Number(id(j)), title: j.title, careers_url: link(j), location: j.location, department: "Ops", published_at: "2026-10-10 09:00:00 UTC", description: j.desc, requirements: "", company_name: "Acme BV" })) });
    case "bamboohr": return JSON.stringify({ meta: { totalCount: jobs.length }, result: jobs.map((j) => ({ id: id(j), jobOpeningName: j.title, departmentLabel: "Ops", atsLocation: { city: j.location.split(",")[0], state: "UT", country: "United States" }, isRemote: /remote/i.test(j.location) })) });
    case "teamtailor": return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme AB</title><link>https://${board}.teamtailor.com/jobs</link>\n` +
      jobs.map((j) => `<item><title>${xmlEsc(j.title)}</title><description><![CDATA[${j.desc}]]></description><pubDate>Tue, 13 Oct 2026 08:00:00 +0200</pubDate><link>https://${board}.teamtailor.com/jobs/${id(j)}-associate</link><guid>g-${id(j)}</guid><remoteStatus>${/remote/i.test(j.location) ? "fully" : "none"}</remoteStatus><tt:locations><tt:location><tt:name>${xmlEsc(j.location)}</tt:name><tt:city>${xmlEsc(j.location.split(",")[0])}</tt:city><tt:country>Sweden</tt:country></tt:location></tt:locations><tt:department>Ops</tt:department></item>`).join("\n") + "</channel></rss>";
    case "breezy": return JSON.stringify(jobs.map((j) => ({ id: id(j), name: j.title, url: link(j), published_date: "2026-10-11T12:00:00.000Z", location: { name: j.location, is_remote: /remote/i.test(j.location) }, department: "Ops", description: j.desc })));
    case "personio": return `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>` + jobs.map((j) => `<position><id>${id(j)}</id><subcompany>Acme GmbH</subcompany><office>${xmlEsc(j.location || "Berlin")}</office><department>Ops</department><name>${xmlEsc(j.title)}</name><jobDescriptions><jobDescription><name>About</name><value><![CDATA[${j.desc}]]></value></jobDescription></jobDescriptions><createdAt>2026-10-09T08:00:00+00:00</createdAt></position>`).join("") + "</workzag-jobs>";
    case "workday": {
      const all = jobs.map((j) => ({ title: j.title, externalPath: `/job/Austin-TX/${id(j)}`, locationsText: j.location || "Austin, TX", postedOn: "Posted 3 Days Ago", bulletFields: [id(j)] }));
      const off = page?.offset ?? 0, lim = page?.limit ?? 20;
      return JSON.stringify({ total: off === 0 ? (page?.total ?? all.length) : 0, jobPostings: all.slice(off, off + lim), facets: [] });
    }
  }
}

// ------------------------------------------------------------------------------------------------ the network
// How a board answers one request. "list": its jobs (paged providers page them; `shift` puts a new job at the top after
// the first page is served, `loop` answers every page with the first); the rest are the failures real boards give.
export type Answer =
  | { kind: "list"; jobs: Job[]; shift?: Job; loop?: boolean; total?: number; etag?: string; chunk?: number }
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "body"; body: string; status?: number; contentType?: string; chunk?: number }
  | { kind: "gzip"; jobs: Job[] }
  | { kind: "throw"; error: string; name?: string }
  | { kind: "not_modified" };
export interface Net { calls: { url: string; board: string }[]; answer: Map<string, Answer> } // key: provider:board

export function chunked(text: string, size: number, status = 200, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(i, i + size)); i += size; } }), { status, headers: { "content-type": "application/json", ...headers } });
}
// The provider and board a request is for (each provider's own URL shape).
export function whose(url: string): { provider: Provider; board: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs/.exec(url))) return { provider: "greenhouse", board: decodeURIComponent(m[1]) };
  if ((m = /api\.lever\.co\/v0\/postings\/([^/?]+)/.exec(url))) return { provider: "lever", board: decodeURIComponent(m[1]) };
  if ((m = /api\.ashbyhq\.com\/posting-api\/job-board\/([^/?]+)/.exec(url))) return { provider: "ashby", board: decodeURIComponent(m[1]) };
  if ((m = /api\.smartrecruiters\.com\/v1\/companies\/([^/]+)\/postings/.exec(url))) return { provider: "smartrecruiters", board: decodeURIComponent(m[1]) };
  if ((m = /apply\.workable\.com\/api\/v1\/widget\/accounts\/([^/?]+)/.exec(url))) return { provider: "workable", board: decodeURIComponent(m[1]) };
  if ((m = /^https:\/\/([^.]+)\.recruitee\.com\/api\/offers/.exec(url))) return { provider: "recruitee", board: m[1] };
  if ((m = /^https:\/\/([^.]+)\.bamboohr\.com\/careers\/list/.exec(url))) return { provider: "bamboohr", board: m[1] };
  if ((m = /^https:\/\/([^.]+)\.teamtailor\.com\/jobs\.rss/.exec(url))) return { provider: "teamtailor", board: m[1] };
  if ((m = /^https:\/\/([^.]+)\.breezy\.hr\/json/.exec(url))) return { provider: "breezy", board: m[1] };
  if ((m = /^https:\/\/([^.]+)\.jobs\.personio\.de\/xml/.exec(url))) return { provider: "personio", board: m[1] };
  if ((m = /^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/wday\/cxs\/[^/]+\/([^/]+)\/jobs/.exec(url))) return { provider: "workday", board: `${m[1]}.${m[2]}/${decodeURIComponent(m[3])}` };
  return null;
}
export async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// The fake fetch. Every answer is served as the board's real server would: a paged board pages, a list has an ETag.
export function fakeFetch(net: Net, r: Rng): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const who = whose(url);
    if (!who) return new Response("no such host", { status: 599 });
    const key = `${who.provider}:${who.board.toLowerCase()}`;
    net.calls.push({ url, board: key });
    const a = net.answer.get(key);
    if (!a) return new Response("{}", { status: 404 });
    const headers = new Headers(init?.headers);
    switch (a.kind) {
      case "throw": { const e = new Error(a.error); if (a.name) e.name = a.name; throw e; }
      case "status": return new Response(a.body ?? "", { status: a.status, headers: a.headers });
      case "body": return chunked(a.body, a.chunk ?? r.int(1, 70000), a.status ?? 200, a.contentType ? { "content-type": a.contentType } : {});
      case "not_modified": return headers.get("if-none-match") || headers.get("if-modified-since") ? new Response(null, { status: 304 }) : new Response("{}", { status: 500 });
      case "gzip": return new Response((await gzip(render(who.provider, who.board, a.jobs))) as unknown as BodyInit, { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
      case "list": {
        if (a.etag && headers.get("if-none-match") === a.etag) return new Response(null, { status: 304, headers: { etag: a.etag } });
        let page: { offset: number; limit: number; total?: number } | undefined, jobs = a.jobs;
        if (who.provider === "smartrecruiters") { const u = new URL(url); page = { offset: Number(u.searchParams.get("offset") || 0), limit: Number(u.searchParams.get("limit") || 100), total: a.total }; }
        if (who.provider === "workday") { const q = JSON.parse(String(init?.body ?? "{}")); page = { offset: Number(q.offset || 0), limit: Number(q.limit || 20), total: a.total }; }
        if (page && a.loop) page = { ...page, offset: 0 };
        if (page && a.shift && page.offset > 0) jobs = [a.shift, ...a.jobs]; // a job added at the top after the first page
        return chunked(render(who.provider, who.board, jobs, page), a.chunk ?? r.int(1, 70000), 200, a.etag ? { etag: a.etag } : {});
      }
    }
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------------------------------------ the store, as Postgres refuses
// memoryPostingsDb with the career_postings checks (20261019000001, 20261026060006, 20261022110000) and what Postgres refuses
// in any text: NUL ("unsupported Unicode escape sequence") and a lone surrogate in the request's JSON ("invalid input
// syntax for type json"). `fault` makes a call fail (statement timeouts, a store that goes away).
const PROV = /^(greenhouse|lever|ashby|smartrecruiters|workable|recruitee|bamboohr|teamtailor|breezy|personio|workday)$/;
const cps = (s: string) => [...s].length;
export function pgRefusal(p: Posting): string | null {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "string") continue;
    if (v.includes("\u0000")) return `unsupported Unicode escape sequence (${k})`;
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) return `invalid input syntax for type json: Unicode low surrogate must follow a high surrogate (${k})`;
  }
  const bad = (c: string) => `new row for relation "career_postings" violates check constraint "career_postings_${c}_check"`;
  if (!/^(greenhouse|lever|ashby|smartrecruiters|workable|recruitee|bamboohr|teamtailor|breezy|personio|workday):[^:]+:.+$/s.test(p.job_id)) return bad("job_id");
  if (!PROV.test(p.provider)) return bad("provider");
  if (cps(p.board) < 1 || cps(p.board) > 200) return bad("board");
  if (cps(p.company) < 1 || cps(p.company) > 300) return bad("company");
  if (cps(p.title) < 1 || cps(p.title) > 500) return bad("title");
  if (cps(p.location ?? "") > 1000) return bad("location");
  if (!/^https:\/\//.test(p.url) || cps(p.url) > 2000) return bad("url");
  if (cps(p.description ?? "") > 20000) return bad("description");
  if (cps(p.department ?? "") > 300) return bad("department");
  if (p.pay != null && cps(p.pay) > 200) return bad("pay");
  if (p.remote != null && !/^(remote|hybrid|onsite)$/.test(p.remote)) return bad("remote");
  if (p.posted_at != null && !Number.isFinite(Date.parse(p.posted_at))) return `invalid input syntax for type timestamp with time zone: "${p.posted_at}"`;
  if (Date.parse(p.last_seen_at) < Date.parse(p.first_seen_at)) return `new row for relation "career_postings" violates check constraint "career_postings_seen_order"`;
  return null;
}
export interface PgLike extends PostingsDb { fault: { on: ((op: string, n: number) => string | null) | null }; writes: number; refused: string[] }
export function pgLikeDb(): PgLike {
  const m = memoryPostingsDb();
  const self: PgLike = {
    ...m, fault: { on: null }, writes: 0, refused: [],
    async putMany(ps) {
      const f = self.fault.on?.("putMany", ps.length); if (f) throw new Error(`write postings: ${f}`);
      for (const p of ps) { const why = pgRefusal(p); if (why) { self.refused.push(why); throw new Error(`write postings: ${why}`); } }
      self.writes += ps.length;
      await m.putMany(ps);
    },
    async touch(ids, at) { const f = self.fault.on?.("touch", ids.length); if (f) throw new Error(`touch postings: ${f}`); await m.touch(ids, at); },
    async close(ids, at) { const f = self.fault.on?.("close", ids.length); if (f) throw new Error(`close postings: ${f}`); await m.close(ids, at); },
    async getMany(ids) { const f = self.fault.on?.("getMany", ids.length); if (f) throw new Error(`read postings: ${f}`); return m.getMany(ids); },
    async openForBoard(b) { const f = self.fault.on?.("openForBoard", 0); if (f) throw new Error(`read board postings: ${f}`); return m.openForBoard(b); },
  };
  return self;
}
