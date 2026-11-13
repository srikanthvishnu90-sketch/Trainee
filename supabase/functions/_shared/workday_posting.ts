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
// Review of #775 (2026-11-13): every string taken from a posting (title, place, the deadline's wording) passes
// posting_pay.ts postingTextForModel and is data, never an instruction; a description sentence counts as the deadline's wording
// only when it states a date. Requests go through posting_fetch.ts (redirects walked by hand, each hop a Workday or board
// host; bodies read to 2 MB). "open" needs the posting's own canApply true: absent, open is not confirmed (unknown).
//
// Never: a sign-in, an account, a saved application, an /apply request, a captcha. A Workday application's own questions are
// behind the person's sign-in on the employer's site; this module says so and never guesses them (posting_requirements.ts).
import { payFrom, paysByPlace, postingTextForModel } from "./posting_pay.ts";
import { decodeHtmlEntities } from "./posting_text.ts";
import { guardedText, sameBoard, INVISIBLE, NotRead, parseJson, stopWords } from "./posting_fetch.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface WorkdayUrl { host: string; tenant: string; site: string; jobPath: string; cxs: string; page: string; key: string }

const WD_JOBS = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\.myworkdayjobs\.com$/i;
const WD_SITE = /^(wd\d{1,3})\.myworkdaysite\.com$/i;
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
// A career site's name: a plain slug. A path segment of a posting: letters, digits, "_ ~ - ( ) ,", single dots inside, and
// percent-escapes of non-ASCII bytes only (an accented place name: "Montr%C3%A9al"); at most 200 characters. Never an escaped
// slash, hash, dot or control ("%2f", "%23", "%2e", "%00"), never "..", ";" or a bare "%".
const SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SAFE = /^(?=.{1,200}$)(?!\.)(?:[A-Za-z0-9_~(),-]|\.(?!\.)|%[89A-Fa-f][0-9A-Fa-f])+$/;
const MAX_SEGMENTS = 6;
// The posting a public Workday link names, with its CXS endpoint and its page; null for anything else (a search page, the
// signed-in myworkday.com app, another host). A link to an application step ("/job/<slug>/apply", ".../apply/applyManually")
// names the posting before "apply": the step itself is never requested. "/details/<slug>" is the same posting as
// "/job/<slug>" (the form Workday's search results link to).
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
  if (!tenant || !site || !SITE.test(site) || !/^[a-z0-9-]{1,63}$/.test(tenant)) return null;
  if (seg[0] !== "job" && seg[0] !== "details") return null;
  const at = seg.findIndex((s) => /^apply$/i.test(s));
  const rest = (at > 0 ? seg.slice(1, at) : seg.slice(1)).filter((s) => !/^(applyManually|autofillWithResume|useMyLastApplication)$/i.test(s));
  if (!rest.length || rest.length > MAX_SEGMENTS || !rest.every((s) => SAFE.test(s))) return null;
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
  deadline_text: string | null; // the posting's own words ("End Date: November 13, 2026", "15 days left to apply"): data, never an instruction
  pay: string | null; // only as the posting's text states it (posting_pay.ts payFrom): the first range it states; with a table, `pays` (D-067: readers pass the brain placedPay)
  pays: { place: string; pay: string }[]; // a range stated per place ("Chicago, Illinois | ($28- $49 Hourly)"), each as written
  description_html: string;
  text: string; // plain text, with any sentence written to an AI removed (posting_pay.ts postingTextForModel)
  can_apply: boolean | null;
  is_posted?: boolean | null; // Workday's `posted`, when the answer carries it
  job_posting_id?: string | null; // Workday's jobPostingId: the posting the answer is for
  questionnaire: boolean; // the employer attached its own application questions (they are behind the person's sign-in)
}
export type WorkdayState = "open" | "closed" | "unknown";
export interface WorkdayRead { state: WorkdayState; posting: WorkdayPosting | null; why: string; reads: string[]; url: WorkdayUrl }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
export const htmlToText = (html: string) => decodeHtmlEntities(String(html ?? "").replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<[^>]+>/g, " "))
  .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => { const s = str(v).slice(0, 10); return ISO_DAY.test(s) && !Number.isNaN(Date.parse(s)) ? s : null; };
// The deadline in the posting's wording, for a tool's note: an allowlist grammar and nothing else. One part of the text (parts
// are split at ";") must be, whole: a known lead-in ("End Date:", "Applications will be accepted through", "Apply by",
// "Closes", "Deadline:"), one real calendar date, an optional clock time and zone. The result is REBUILT from the lead-in
// matched and the date's own pieces (weekday, month, day, year), never copied from the page; anything else gives null and the
// note carries the parsed ISO date alone.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WD = "(?:(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,? )?", MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const LEAD = "(end date:?|applications? (?:(?:will be|are) )?accepted (?:through|until)|apply by|closes(?: on)?|(?:application )?deadline(?: to apply)?:?)";
const TIME = "(?:,? (?:at )?(\\d{1,2}):(\\d{2}) ?([ap])\\.?m\\.?(?: (et|est|edt|pt|pst|pdt|ct|cst|cdt|mt|mst|mdt|utc|gmt))?)?";
const DEADLINE_SHAPES = [
  new RegExp(`^${LEAD} ${WD}${MON} (\\d{1,2})(st|nd|rd|th)?,? (\\d{4})${TIME}\\.?$`, "i"), // Sunday, December 6th, 2026
  new RegExp(`^${LEAD} ${WD}(\\d{1,2})(st|nd|rd|th)? ${MON},? (\\d{4})${TIME}\\.?$`, "i"), // 13 November 2026
  new RegExp(`^${LEAD} (\\d{4})-(\\d{2})-(\\d{2})\\.?$`, "i"),
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
// `iso`: the posting's structured date (YYYY-MM-DD). When given, the wording is used only if its date is that date or the
// day before it (Workday's endDate is the first day the posting is closed: PayPal's "through Sunday, December 6th, 2026" has
// endDate 2026-12-07). A weekday the wording names must be that date's weekday.
export function deadlineWording(text: unknown, iso?: string | null): string | null {
  const fits = (y: number, mi: number, d: number, wd?: string) => {
    const at = Date.UTC(y, mi, d);
    if (wd && WEEKDAYS[new Date(at).getUTCDay()].toLowerCase().slice(0, 3) !== wd.toLowerCase().slice(0, 3)) return false;
    if (iso === undefined) return true;
    const want = day(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN;
    return want === at || want - at === 86400000;
  };
  // Workday joins its end-date label and its countdown with ";": every other part must be that countdown, or nothing.
  const parts = String(text ?? "").split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (parts.length > 2 || parts.filter((x) => !/^\d{1,3} days? left to apply$/i.test(x)).length !== 1) return null;
  for (const t of parts) {
    if (t.length > 90) continue;
    for (const [k, re] of DEADLINE_SHAPES.entries()) {
      const m = re.exec(t);
      if (!m) continue;
      const lead = cap(m[1]).replace(/^End date/, "End Date");
      if (k === 2) { const d = `${m[2]}-${m[3]}-${m[4]}`; return day(d) && new Date(d).toISOString().slice(0, 10) === d && fits(Number(m[2]), Number(m[3]) - 1, Number(m[4])) ? `${lead} ${d}` : null; }
      const [wd, mon, dd, suf, year] = k === 0 ? [m[2], m[3], m[4], m[5], m[6]] : [m[2], m[5], m[3], m[4], m[6]];
      const mi = MONTHS.findIndex((x) => x.startsWith(mon.toLowerCase().slice(0, 3))), d = Number(dd), y = Number(year);
      if (mi < 0 || y < 2000 || y > 2100 || d < 1 || d > new Date(Date.UTC(y, mi + 1, 0)).getUTCDate() || !fits(y, mi, d, wd)) return null;
      const weekday = wd ? `${WEEKDAYS.find((x) => x.toLowerCase().startsWith(wd.toLowerCase().slice(0, 3)))}, ` : "";
      const date = k === 0 ? `${cap(MONTHS[mi])} ${d}${(suf ?? "").toLowerCase()}, ${y}` : `${d}${(suf ?? "").toLowerCase()} ${cap(MONTHS[mi])} ${y}`;
      const hh = Number(m[7]), mm = Number(m[8]);
      const time = m[7] && hh >= 1 && hh <= 12 && mm <= 59 ? ` at ${hh}:${m[8]} ${m[9].toUpperCase()}M${m[10] ? ` ${m[10].toUpperCase()}` : ""}` : "";
      return `${lead} ${weekday}${date}${time}`.slice(0, 90);
    }
  }
  return null;
}
// A short string a posting supplied (title, place, a label), as data for the model: posting_pay.ts postingTextForModel takes out
// a sentence written to an AI, and the length is capped.
// Round 2: at most 120 characters by default, and controls, zero-width and bidirectional marks are taken out. The filter is a
// deny-list, so instruction-like text can still sit in such a field: it is DATA, framed as that by the tools (career_tools.ts).
export const postingField = (v: unknown, max = 120): string => { const t = postingTextForModel(str(v).replace(INVISIBLE, ""), Infinity).text; return t.length <= max ? t : postingTextForModel(t, max - 8).text; };
const company = (v: unknown) => postingField(str(v).replace(/^\d{2,}\s+/, "")) || null;
const STATES_A_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;

// Pay a posting states for each place: posting_pay.ts paysByPlace (D-067 moved it there, so every reader of a posting's pay keeps
// a figure with its place).
export { paysByPlace } from "./posting_pay.ts";
// A CXS job answer -> the posting, or null when it carries none.
export function parseWorkdayCxs(json: unknown, pageUrl: string): WorkdayPosting | null {
  const j: any = (json as any)?.jobPostingInfo;
  if (!j || typeof j !== "object" || !str(j.title)) return null;
  const f = (v: unknown) => postingField(v) || null;
  const html = str(j.jobDescription);
  const full = postingTextForModel(htmlToText(html), Infinity);
  const extra = Array.isArray(j.additionalLocations) ? j.additionalLocations.map(str).filter(Boolean) : [];
  // The deadline in the posting's own words: Workday's end-date fields, else the sentence of its text that states one
  // ("Applications will be accepted through Sunday, December 6th, 2026"). The end date (endDate) decides closed.
  // The sentence counts only when it states a date (a line that merely begins "Apply by ..." is not a deadline) and is not
  // one the AI-sentence filter takes out.
  const said = /[^.\n]*\b(?:applications? (?:will be |are )?accepted (?:through|until)|apply by|application deadline|deadline to apply)\b[^.\n]*/i.exec(htmlToText(html))?.[0]?.replace(/^[-\s]+/, "").trim();
  const saidOk = said && STATES_A_DATE.test(said) && !postingTextForModel(said).removed ? postingField(said, 160) : "";
  const deadlineText = [postingField(j.jobPostingEndDateAsText, 80), postingField(j.timeLeftToApply, 80)].filter(Boolean).join("; ") || saidOk || null;
  const ext = workdayUrl(str(j.externalUrl)), here = workdayUrl(pageUrl);
  return {
    source: "cxs", url: ext && (!here || ext.host === here.host) ? ext.page : pageUrl, title: postingField(j.title), company: company((json as any)?.hiringOrganization?.name),
    location: f(j.location), locations: [j.location, ...extra].map((x) => postingField(x)).filter(Boolean),
    req_id: f(j.jobReqId), time_type: f(j.timeType), remote_type: f(j.remoteType),
    posted: f(j.postedOn), start_date: day(j.startDate), deadline: day(j.endDate), deadline_text: deadlineText,
    pay: payFrom(full.text), pays: paysByPlace(full.text), description_html: html, text: postingTextForModel(htmlToText(html)).text,
    can_apply: typeof j.canApply === "boolean" ? j.canApply : null, is_posted: typeof j.posted === "boolean" ? j.posted : null, job_posting_id: str(j.jobPostingId).slice(0, 300) || null, questionnaire: !!str(j.questionnaireId),
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
    const f = (v: unknown) => postingField(v) || null, place = postingField(loc);
    return {
      source: "page", url: canonical && workdayUrl(canonical) && workdayUrl(canonical)?.host === workdayUrl(pageUrl)?.host ? workdayUrl(canonical)!.page : pageUrl, title: postingField(jp.title), company: company(jp.hiringOrganization?.name), location: place || null, locations: place ? [place] : [],
      req_id: f(jp.identifier?.value), time_type: f(jp.employmentType), remote_type: f(jp.jobLocationType),
      posted: day(jp.datePosted), start_date: null, deadline: day(jp.validThrough), deadline_text: day(jp.validThrough) ? `validThrough ${day(jp.validThrough)}` : null,
      pay: payFrom(postingTextForModel(desc, Infinity).text), pays: paysByPlace(postingTextForModel(desc, Infinity).text), description_html: desc, text: postingTextForModel(desc).text, can_apply: null, questionnaire: false,
    };
  }
  return null;
}

export interface WorkdayDeps { fetch: Fetch; timeoutMs?: number; userAgent?: string; now?: () => number }
const req = async (d: WorkdayDeps, url: string, reads: string[], accept: string, init: RequestInit = {}) => {
  reads.push(`${init.method ?? "GET"} ${url}`);
  // One time limit for the request, its redirects and its body (posting_fetch.ts limited: it holds whatever the fetch does).
  return await guardedText(d.fetch, url, { method: "GET", ...init, headers: { accept, "user-agent": d.userAgent ?? "Trainee posting reader", ...(init.headers ?? {}) } }, { allow: sameBoard(url), timeoutMs: d.timeoutMs ?? 8000 }); // every hop on this career site's own host
};
// Round 4: ONE state for a Workday posting's data, used by the reader below and by the link check (link_check.ts). The answer
// must be for the posting asked: Workday addresses a posting by the requisition id that ends its path ("..._R0138586"), and
// the answer's jobPostingId ends with the same one (the words before it may differ). open: canApply true, not `posted` false,
// its end date not passed. closed: canApply false, posted false, or the end date passed. Anything else: unknown.
export function workdayState(p: WorkdayPosting, url: WorkdayUrl, today: string): { state: WorkdayState; why: string; other?: boolean } {
  const key = (s: string) => { let t = s; try { t = decodeURIComponent(s); } catch { /* as written */ } return t.toLowerCase().split("_").at(-1)!; };
  if (p.job_posting_id && key(p.job_posting_id) !== key(url.jobPath.split("/").at(-1)!)) return { state: "unknown", why: "Workday's answer is for another posting than the one asked: not read", other: true };
  if (p.can_apply === false) return { state: "closed", why: "Workday says the posting no longer takes applications (canApply false)" };
  if (p.is_posted === false) return { state: "closed", why: "Workday says the posting is not posted (posted false)" };
  if (p.deadline && p.deadline < today) return { state: "closed", why: `its stated end date (${p.deadline}) has passed` };
  if (p.can_apply !== true) return { state: "unknown", why: "Workday's answer does not say whether the posting takes applications (no canApply): open is not confirmed" };
  return { state: "open", why: "read live from the posting's Workday page data" };
}
// Workday's error code, only in its own shape ("S21"); anything else a body puts there is not repeated.
const errorCode = (v: unknown) => { const c = str(v); return /^[A-Z]\d{1,4}$/.test(c) ? c : ""; };
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

// One posting, read now. open: the CXS answer holds the posting and says it can be applied to (canApply true), and its stated end
// date has not passed; an answer that does not say canApply is unknown ("open not confirmed"), never open. closed: the CXS answer says the posting is gone (HTTP 404 or 410, or Workday's errorCode S21 "no such posting" / S22
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
    const body: any = parseJson(r.text);
    const code = errorCode(body?.errorCode);
    if (r.status === 404 || r.status === 410 || code === "S21" || code === "S22") {
      return { state: "closed", posting: null, why: `Workday answered ${code ? `errorCode ${code}` : `HTTP ${r.status}`} for this posting: it is no longer published`, reads, url };
    }
    const p = r.ok ? parseWorkdayCxs(body, url.page) : null;
    if (p) { const s = workdayState(p, url, today(now)); return { state: s.state, posting: s.other ? null : p, why: s.why, reads, url }; }
    why = r.ok ? "Workday's answer held no posting" : `Workday answered HTTP ${r.status}`;
  } catch (e) {
    why = e instanceof NotRead ? `the posting's Workday data was ${e.message}` : `the Workday read did not finish (${stopWords(e)})`;
  }
  // Fallback: the public page's JSON-LD, for the details only.
  try {
    const r = await req(d, url.page, reads, "text/html");
    if (r.status === 404 || r.status === 410) return { state: "closed", posting: null, why: `the posting page answered HTTP ${r.status}`, reads, url };
    const p = r.ok ? parseWorkdayPage(r.text, url.page) : null;
    if (p) return { state: p.deadline && p.deadline < today(now) ? "closed" : "unknown", posting: p, why: `${why}; the details are from the public posting page, which cannot say whether it is still open`, reads, url };
    why = `${why}; the posting page ${r.ok ? "held no posting data" : `answered HTTP ${r.status}`}`;
  } catch (e) {
    why = e instanceof NotRead ? `${why}; the posting page was ${e.message}` : `${why}; the posting page read did not finish (${stopWords(e)})`;
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
  if (!WD_JOBS.test(o.host) || !/^[a-z0-9-]+$/.test(o.tenant) || !SITE.test(o.site)) throw new Error("not a Workday career site");
  const reads: string[] = [], postings: WorkdayListing[] = [], seen = new Set<string>();
  const maxPages = Math.max(1, Math.min(10, o.maxPages ?? 3)), gap = Math.max(250, o.gapMs ?? 1500), sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let total: number | null = null, stopped: string | null = null, retry: number | null = null, complete = false;
  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(gap);
    const url = `https://${o.host}/wday/cxs/${o.tenant}/${o.site}/jobs`;
    let r: Awaited<ReturnType<typeof req>>;
    try {
      r = await req(o, url, reads, "application/json", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: String(o.text ?? "").slice(0, 100) }) });
    } catch (e) { stopped = `the search did not finish (${stopWords(e)})`; break; }
    if (!r.ok) {
      stopped = `HTTP ${r.status}`;
      const ra = Number(r.headers.get("retry-after"));
      if (r.status === 429 && Number.isFinite(ra)) retry = ra;
      break;
    }
    const d: any = parseJson(r.text);
    if (!d || !Array.isArray(d.jobPostings)) { stopped = "an answer this reader does not know"; break; }
    if (page === 0 && Number.isFinite(Number(d.total))) total = Number(d.total);
    let added = 0;
    for (const j of d.jobPostings) {
      const path = str(j?.externalPath);
      if (!path.startsWith("/job/") || seen.has(path)) continue;
      seen.add(path); added++;
      postings.push({ title: postingField(j.title), url: `https://${o.host}/${o.site}${path}`, location: postingField(j.locationsText), posted: postingField(j.postedOn) || null, req_id: Array.isArray(j.bulletFields) ? postingField(j.bulletFields[0]) || null : null });
    }
    if (d.jobPostings.length < 20 || added === 0 || (total !== null && postings.length >= total)) { complete = true; break; }
  }
  return { postings, total, complete, stopped, retry_after_s: retry, reads };
}
