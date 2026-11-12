// D-062 (1) (owner, 2026-11-11: "your job is to know exactly what any job posting requires"): a READ-ONLY reader of a public
// Workday posting. Workday career sites (<tenant>.<wdN>.myworkdayjobs.com, and wdN.myworkdaysite.com/recruiting/...) load each
// posting from the site's own public JSON endpoint (CXS): GET https://<host>/wday/cxs/<tenant>/<site>/job/<path>. That is the
// request the posting page itself makes for an anonymous visitor ("userAuthenticated": false in its answer). Workday publishes no
// reference for it; the shape below is the one recorded in tests/fixtures/posting-reads/ (see sources.json there).
//
//   readWorkdayPosting  one GET of the posting's CXS endpoint: title, place(s), the pay its text states, the requirements, the
//                       deadline when the posting states one, and open/closed. Fallback: one GET of the public posting page, read
//                       from its JSON-LD JobPosting block (details only: the page is the same app shell for a live and a
//                       removed posting, so a page read never says "open").
//   searchWorkdayBoard  the tenant's public job search (the read-only POST the career site makes), paced and capped, for discovery.
//                       The scheduled ingest reads whole boards through career_ingest_feeds.ts (WO-044); this one is on demand.
//
// Never: a sign-in, an account, a saved application, an /apply request, a captcha. A Workday application's own questions are
// behind the person's sign-in on the employer's site; this module says so and never guesses them (posting_requirements.ts).
import { payFrom, paysByPlace, postingTextForModel } from "./posting_pay.ts";
import { decodeHtmlEntities } from "./posting_text.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface WorkdayUrl { host: string; tenant: string; site: string; jobPath: string; cxs: string; page: string; key: string }

const WD_JOBS = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\.myworkdayjobs\.com$/i;
const WD_SITE = /^(wd\d{1,3})\.myworkdaysite\.com$/i;
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.~%-]*$/;
// The posting a public Workday link names, with its CXS endpoint and its page; null for anything else (a search page, the
// signed-in myworkday.com app, another host). A link to an application step ("/job/<slug>/apply", ".../apply/applyManually")
// names the posting before "apply": the step itself is never requested.
export function workdayUrl(href: string): WorkdayUrl | null {
  let u: URL;
  try { u = new URL(String(href ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  let seg = u.pathname.split("/").filter(Boolean);
  let tenant = "", site = "";
  const jobs = WD_JOBS.exec(host), wsite = WD_SITE.exec(host);
  if (jobs) {
    tenant = jobs[1].toLowerCase();
    if (seg[0] && LOCALE.test(seg[0]) && seg[1] && seg[1] !== "job") seg = seg.slice(1);
    site = seg[0] ?? "";
    seg = seg.slice(1);
  } else if (wsite) {
    if (seg[0] && LOCALE.test(seg[0])) seg = seg.slice(1);
    if (seg[0] !== "recruiting") return null;
    tenant = (seg[1] ?? "").toLowerCase();
    site = seg[2] ?? "";
    seg = seg.slice(3);
  } else return null;
  if (!tenant || !site || !SAFE.test(site) || !/^[a-z0-9-]+$/.test(tenant)) return null;
  if (seg[0] !== "job") return null;
  const at = seg.findIndex((s) => /^apply$/i.test(s));
  const rest = (at > 0 ? seg.slice(1, at) : seg.slice(1)).filter((s) => !/^(applyManually|autofillWithResume|useMyLastApplication)$/i.test(s));
  if (!rest.length || !rest.every((s) => SAFE.test(s))) return null;
  const jobPath = `/job/${rest.join("/")}`;
  const base = jobs ? `https://${host}` : `https://${host}`;
  const page = jobs ? `${base}/${site}${jobPath}` : `${base}/recruiting/${tenant}/${site}${jobPath}`;
  return { host, tenant, site, jobPath, cxs: `${base}/wday/cxs/${tenant}/${site}${jobPath}`, page, key: `workday:${host}:${rest.at(-1)}` };
}
export const isWorkdayHost = (href: string): boolean => {
  try { return /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|myworkday\.com)$/i.test(new URL(href).hostname); } catch { return false; }
};

export interface WorkdayPosting {
  source: "cxs" | "page";
  url: string; // the public posting page
  title: string;
  company: string | null; // the hiring organization the posting names (a leading numeric entity code removed)
  location: string | null;
  locations: string[];
  req_id: string | null;
  time_type: string | null;
  remote_type: string | null;
  posted: string | null; // as Workday says it ("Posted 3 Days Ago") or the date the page states
  start_date: string | null;
  deadline: string | null; // YYYY-MM-DD, only when the posting states one
  deadline_text: string | null; // the posting's own words ("End Date: November 13, 2026", "15 days left to apply")
  pay: string | null; // only as the posting's text states it (posting_pay.ts payFrom): the first range it states; with a table, `pays` (D-067: readers pass the brain placedPay)
  pays: { place: string; pay: string }[]; // a range stated per place ("Chicago, Illinois | ($28- $49 Hourly)"), each as written
  description_html: string;
  text: string; // plain text, with any sentence written to an AI removed (posting_pay.ts postingTextForModel)
  can_apply: boolean | null;
  questionnaire: boolean; // the employer attached its own application questions (they are behind the person's sign-in)
}
export type WorkdayState = "open" | "closed" | "unknown";
export interface WorkdayRead { state: WorkdayState; posting: WorkdayPosting | null; why: string; reads: string[]; url: WorkdayUrl }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
export const htmlToText = (html: string) => decodeHtmlEntities(String(html ?? "").replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " "))
  .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => { const s = str(v).slice(0, 10); return ISO_DAY.test(s) && !Number.isNaN(Date.parse(s)) ? s : null; };
const company = (v: unknown) => str(v).replace(/^\d{2,}\s+/, "") || null;

// Pay a posting states for each place: posting_pay.ts paysByPlace (D-067 moved it there, so every reader of a posting's pay keeps
// a figure with its place).
export { paysByPlace } from "./posting_pay.ts";
// A CXS job answer -> the posting, or null when it carries none.
export function parseWorkdayCxs(json: unknown, pageUrl: string): WorkdayPosting | null {
  const j: any = (json as any)?.jobPostingInfo;
  if (!j || typeof j !== "object" || !str(j.title)) return null;
  const html = str(j.jobDescription);
  const full = postingTextForModel(htmlToText(html), Infinity);
  const extra = Array.isArray(j.additionalLocations) ? j.additionalLocations.map(str).filter(Boolean) : [];
  // The deadline in the posting's own words: Workday's end-date fields, else the sentence of its text that states one
  // ("Applications will be accepted through Sunday, December 6th, 2026"). The end date (endDate) decides closed.
  const said = /[^.\n]*\b(?:applications? (?:will be )?accepted (?:through|until)|apply by|application deadline|deadline to apply)\b[^.\n]*/i.exec(htmlToText(html))?.[0]?.replace(/^[-\s]+/, "").trim();
  const deadlineText = [str(j.jobPostingEndDateAsText), str(j.timeLeftToApply)].filter(Boolean).join("; ") || (said ? said.slice(0, 160) : null);
  return {
    source: "cxs", url: str(j.externalUrl) || pageUrl, title: str(j.title), company: company((json as any)?.hiringOrganization?.name),
    location: str(j.location) || null, locations: [str(j.location), ...extra].filter(Boolean),
    req_id: str(j.jobReqId) || null, time_type: str(j.timeType) || null, remote_type: str(j.remoteType) || null,
    posted: str(j.postedOn) || null, start_date: day(j.startDate), deadline: day(j.endDate), deadline_text: deadlineText,
    pay: payFrom(full.text), pays: paysByPlace(full.text), description_html: html, text: postingTextForModel(htmlToText(html)).text,
    can_apply: typeof j.canApply === "boolean" ? j.canApply : null, questionnaire: !!str(j.questionnaireId),
  };
}

// The public posting page -> the posting its JSON-LD JobPosting block states (title, place, date posted, validThrough as the
// deadline, the description); null when it has none. Never an open state.
export function parseWorkdayPage(html: string, pageUrl: string): WorkdayPosting | null {
  for (const m of String(html ?? "").matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let d: any;
    try { d = JSON.parse(m[1]); } catch { continue; }
    const jp = (Array.isArray(d) ? d : [d]).find((x) => x && (x["@type"] === "JobPosting" || (x.title && x.description && x.hiringOrganization)));
    if (!jp || !str(jp.title)) continue;
    const desc = decodeHtmlEntities(str(jp.description));
    const loc = jp.jobLocation?.address ? [jp.jobLocation.address.addressLocality, jp.jobLocation.address.addressCountry].map(str).filter(Boolean).join(", ") : "";
    const canonical = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
    return {
      source: "page", url: canonical || pageUrl, title: str(jp.title), company: company(jp.hiringOrganization?.name), location: loc || null, locations: loc ? [loc] : [],
      req_id: str(jp.identifier?.value) || null, time_type: str(jp.employmentType) || null, remote_type: str(jp.jobLocationType) || null,
      posted: day(jp.datePosted), start_date: null, deadline: day(jp.validThrough), deadline_text: day(jp.validThrough) ? `validThrough ${day(jp.validThrough)}` : null,
      pay: payFrom(postingTextForModel(desc, Infinity).text), pays: paysByPlace(postingTextForModel(desc, Infinity).text), description_html: desc, text: postingTextForModel(desc).text, can_apply: null, questionnaire: false,
    };
  }
  return null;
}

export interface WorkdayDeps { fetch: Fetch; timeoutMs?: number; userAgent?: string; now?: () => number }
const req = async (d: WorkdayDeps, url: string, reads: string[], accept: string, init: RequestInit = {}) => {
  reads.push(`${init.method ?? "GET"} ${url}`);
  return await d.fetch(url, { method: "GET", redirect: "follow", ...init, signal: AbortSignal.timeout(d.timeoutMs ?? 8000), headers: { accept, "user-agent": d.userAgent ?? "Trainee posting reader", ...(init.headers ?? {}) } });
};
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

// One posting, read now. open: the CXS answer holds the posting and says it can be applied to, and its stated end date has not
// passed. closed: the CXS answer says the posting is gone (HTTP 404 or 410, or Workday's errorCode S21 "no such posting" / S22
// "unpublished"), it says canApply false, or its stated end date has passed. unknown: anything else (a timeout, a bot wall, a
// shape this reader does not know): never called open, never hidden as closed.
export async function readWorkdayPosting(href: string, d: WorkdayDeps): Promise<WorkdayRead | null> {
  const url = workdayUrl(href);
  if (!url) return null;
  const reads: string[] = [];
  const now = (d.now ?? Date.now)();
  let why = "";
  try {
    const r = await req(d, url.cxs, reads, "application/json");
    const body: any = await r.json().catch(() => null);
    const code = str(body?.errorCode);
    if (r.status === 404 || r.status === 410 || code === "S21" || code === "S22") {
      return { state: "closed", posting: null, why: `Workday answered ${code ? `errorCode ${code}` : `HTTP ${r.status}`} for this posting: it is no longer published`, reads, url };
    }
    const p = r.ok ? parseWorkdayCxs(body, url.page) : null;
    if (p) {
      if (p.can_apply === false) return { state: "closed", posting: p, why: "Workday says the posting no longer takes applications (canApply false)", reads, url };
      if (p.deadline && p.deadline < today(now)) return { state: "closed", posting: p, why: `its stated end date (${p.deadline}) has passed`, reads, url };
      return { state: "open", posting: p, why: "read live from the posting's Workday page data", reads, url };
    }
    why = r.ok ? "Workday's answer held no posting" : `Workday answered HTTP ${r.status}`;
  } catch (e) {
    why = `the Workday read did not finish (${String((e as Error)?.name === "TimeoutError" ? "timeout" : (e as Error)?.message ?? e).slice(0, 80)})`;
  }
  // Fallback: the public page's JSON-LD, for the details only.
  try {
    const r = await req(d, url.page, reads, "text/html");
    if (r.status === 404 || r.status === 410) return { state: "closed", posting: null, why: `the posting page answered HTTP ${r.status}`, reads, url };
    const p = r.ok ? parseWorkdayPage(await r.text(), url.page) : (await r.body?.cancel().catch(() => {}), null);
    if (p) return { state: p.deadline && p.deadline < today(now) ? "closed" : "unknown", posting: p, why: `${why}; the details are from the public posting page, which cannot say whether it is still open`, reads, url };
    why = `${why}; the posting page ${r.ok ? "held no posting data" : `answered HTTP ${r.status}`}`;
  } catch (e) {
    why = `${why}; the posting page read did not finish (${String((e as Error)?.message ?? e).slice(0, 60)})`;
  }
  return { state: "unknown", posting: null, why, reads, url };
}

// ------------------------------------------------------------------------------------------------ discovery
// The tenant's public job search, paged 20 at a time: at most maxPages pages (default 3), gapMs apart (default 1,500 ms), and
// a 429 or any non-2xx stops the read (its Retry-After is returned, never slept through here). Read-only: the POST body is the
// search the career site itself sends (appliedFacets, limit, offset, searchText) and nothing else.
export interface WorkdayListing { title: string; url: string; location: string; posted: string | null; req_id: string | null }
export async function searchWorkdayBoard(o: { host: string; tenant: string; site: string; text?: string; maxPages?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> } & WorkdayDeps):
  Promise<{ postings: WorkdayListing[]; total: number | null; complete: boolean; stopped: string | null; retry_after_s: number | null; reads: string[] }> {
  if (!WD_JOBS.test(o.host) || !/^[a-z0-9-]+$/.test(o.tenant) || !SAFE.test(o.site)) throw new Error("not a Workday career site");
  const reads: string[] = [], postings: WorkdayListing[] = [], seen = new Set<string>();
  const maxPages = Math.max(1, Math.min(10, o.maxPages ?? 3)), gap = Math.max(250, o.gapMs ?? 1500), sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let total: number | null = null, stopped: string | null = null, retry: number | null = null, complete = false;
  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(gap);
    const url = `https://${o.host}/wday/cxs/${o.tenant}/${o.site}/jobs`;
    let r: Response;
    try {
      r = await req(o, url, reads, "application/json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: String(o.text ?? "").slice(0, 100) }) });
    } catch (e) { stopped = `the search did not finish (${String((e as Error)?.message ?? e).slice(0, 60)})`; break; }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      stopped = `HTTP ${r.status}`;
      const ra = Number(r.headers.get("retry-after"));
      if (r.status === 429 && Number.isFinite(ra)) retry = ra;
      break;
    }
    const d: any = await r.json().catch(() => null);
    if (!d || !Array.isArray(d.jobPostings)) { stopped = "an answer this reader does not know"; break; }
    if (page === 0 && Number.isFinite(Number(d.total))) total = Number(d.total);
    let added = 0;
    for (const j of d.jobPostings) {
      const path = str(j?.externalPath);
      if (!path.startsWith("/job/") || seen.has(path)) continue;
      seen.add(path); added++;
      postings.push({ title: str(j.title), url: `https://${o.host}/${o.site}${path}`, location: str(j.locationsText), posted: str(j.postedOn) || null, req_id: Array.isArray(j.bulletFields) ? str(j.bulletFields[0]) || null : null });
    }
    if (d.jobPostings.length < 20 || added === 0 || (total !== null && postings.length >= total)) { complete = true; break; }
  }
  return { postings, total, complete, stopped, retry_after_s: retry, reads };
}
