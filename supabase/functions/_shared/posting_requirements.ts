// D-062 (1) (owner, 2026-11-11: "your job is to know exactly what any job posting requires"): what a posting requires and what
// its application asks, read from PUBLIC pages only, before any sign-in (benchmark turn C11, docs/architect/specs/MIRROR-PROCESS.md).
//
//   Greenhouse       GET boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true: the posting and every question of
//                    its form (labels, required, types, options), the board's own public API.
//   Lever            GET api.lever.co/v0/postings/<site>/<id> (the posting) and GET jobs.lever.co/<site>/<id>/apply (the form
//                    page: every question with its label, required mark and options).
//   Ashby            GET jobs.ashbyhq.com/<board>/<id> (the posting page's data) and ONE read-only GraphQL query, the one the
//                    page itself makes for an anonymous visitor (op ApiJobPosting: the form's fields; a fixed query string,
//                    never a mutation). ON under D-062 (1a) (architect ruling, 2026-11-11: "Ashby's public question query,
//                    read-only").
//   SmartRecruiters  GET api.smartrecruiters.com/v1/companies/<company>/postings/<id> (the posting). Its application questions
//                    are not public (its application API needs a partner key; the form page is behind a bot wall): said so.
//   Workday          workday_posting.ts (the posting's CXS data). Its application's questions are behind the person's own
//                    sign-in on the employer's careers site: said so, never guessed.
//
// Nothing here creates an account, a saved application or a submission; nothing is ever sent to a submit, upload or sign-in
// endpoint. The only request to an application page is the one GET of Lever's public apply page named above (the form's HTML,
// read for its questions; nothing is posted to it). A captcha on the form is recorded (captcha_expected), never touched.
// Every request made is returned (reads). The questions are the form's shape only: never an answer and never a payload (D-007).
//
// Review of #775 (2026-11-13): requests go through posting_fetch.ts (redirects walked by hand, at most 3, every hop on a job
// board's own host; bodies read to 2 MB); a refused address or hop, or a body past the cap, is status "not_readable" with a why
// that begins "not read". A board name or posting id that is not a plain slug builds no address. Every string a posting
// supplied (title, company, place, pay, question labels and options) passes posting_pay.ts postingTextForModel: it is data,
// and none of it is placed in a tool's note (agent/career_tools.ts).
import { schemaFromGreenhouse } from "./posting_schema.ts";
import { placedPay, postingTextForModel } from "./posting_pay.ts";
import { decodeHtmlEntities } from "./posting_text.ts";
import { htmlToText, postingField, readWorkdayPosting, workdayUrl, type WorkdayDeps } from "./workday_posting.ts";
import { BOARD_SLUG, guardedText, sameBoard, INVISIBLE, NotRead, parseJson, POSTING_UUID, refusedAddress, stopWords } from "./posting_fetch.ts";
import { neverOpen } from "./career_people_sites.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Board = "Greenhouse" | "Lever" | "Ashby" | "SmartRecruiters" | "Workday";
export interface Question { label: string; required: boolean; type: string; options?: string[]; more_options?: number }
export interface Requirements { required: string[]; preferred: string[] }
export type QuestionsRead = "read" | "behind_sign_in" | "not_public" | "not_read";
export interface ApplyFlow {
  status: "ok" | "unknown" | "not_readable";
  board: Board | null;
  url: string;
  posting: { title: string; company: string | null; location: string | null; pay: string | null; pay_by_place?: { place: string; pay: string }[]; deadline: string | null; deadline_text: string | null; state: "open" | "closed" | "unknown" } | null;
  requirements: Requirements;
  questions: Question[] | null; // at most MAX_QUESTIONS of them
  questions_more?: number; // how many more the form has, when the list was cut
  questions_read: QuestionsRead;
  questions_why: string;
  entry: string[]; // the application's entry flow as far as it is known without signing in
  sign_in_required: boolean;
  captcha_expected: boolean;
  reads: string[]; // every request made, method and address
  why: string;
  boundary: string;
}
export const MAX_QUESTIONS = 60;
export const READ_ONLY_BOUNDARY = "Read only: no account, saved application or submission was created.";

// ------------------------------------------------------------------------------------------------ requirements
const REQ_H = /(requirement|qualification|what you(?:'|’)?ll need|what you need|need to succeed|must[- ]haves?|who you are|what we(?:'|’)?re looking for|what we look for|we(?:'|’)?re looking for|you (?:have|bring|should have|will have)|about you|skills|experience|we require|what we require|ideal candidate|competenc|eligib|thrive|we expect you|you should|you will need|you(?:'|’)?ll bring|you might be|you may be|a (?:good |great )?fit|you(?:'|’)?re a fit)/i;
const PREF_H = /(nice[- ]to[- ]haves?|preferred|bonus|pluses|a plus|desired|great if|what we value|even better)/i;
const OTHER_H = /(what you(?:'|’)?ll (?:do|be doing|work on)|responsibilit|about (?:the|us|our)|benefits|perks|who we are|our team|compensation|salary|\bpay\b|why join|what we offer|the role|the opportunity|job description|location|equal (?:employment )?opportunit|accommodation|how to apply|company description|additional information|what you will do|your impact|day to day)/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// The requirement lines a posting states, under its own requirement headings ("What you'll need", "Must have", "Qualifications";
// "Nice to have" and "Preferred" kept apart). Each line is the posting's words; nothing is summarised or added.
export function requirementsFrom(html: string): Requirements {
  let h = String(html ?? "");
  if (/&lt;\/?(p|li|ul|h\d|div|strong|b)\b/i.test(h)) h = decodeHtmlEntities(h);
  // Line by line; a line written to an AI assistant rather than to applicants is dropped (posting_pay.ts postingTextForModel).
  const lines = htmlToText(h).split("\n").map((l) => l.trim()).map((l) => l.replace(INVISIBLE, "")).filter((l) => l && !postingTextForModel(l, Infinity).removed);
  const out: Requirements = { required: [], preferred: [] };
  let at: "required" | "preferred" | null = null;
  let bullets = 0; // bullets read in the current section: a paragraph after its list ends the section
  for (const raw of lines) {
    const bullet = /^[-•*·]\s+/.test(raw), line = raw.replace(/^[-•*·]\s+/, "").trim();
    // A heading: a short line that is not a list item and not a sentence ("About OpenAI", "Must have", "What you'll need:").
    const headingish = !bullet && line.length <= 100 && (/[:?]$/.test(line) || (line.length <= 60 && !/[.!]$/.test(line)));
    if (headingish) {
      at = PREF_H.test(line) ? "preferred" : REQ_H.test(line) && !OTHER_H.test(line) ? "required" : null;
      bullets = 0;
      // "Basic Qualifications: <the line itself>" carries its own requirement after the colon.
      const after = line.split(/:\s+/).slice(1).join(": ").trim();
      if (at && after.length > 12) out[at].push(clip(after, 220));
      continue;
    }
    if (!at || line.length < 3) continue;
    if (!bullet && bullets > 0) { at = null; continue; }
    if (!bullet && line.length > 300) continue;
    if (bullet) bullets++;
    if (out[at].length < (at === "required" ? 15 : 10)) out[at].push(clip(line, 220));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the boards
// `eu`: the address is on the board's EU site (jobs.eu.lever.co, job-boards.eu.greenhouse.io), whose postings the global API
// does not hold.
export function boardOf(url: string): { board: Board; parts: string[]; eu?: boolean } | null {
  let u: URL;
  try { u = new URL(String(url ?? "").trim()); } catch { return null; }
  if (refusedAddress(u.href)) return null; // https, no userinfo or port, a named public host
  const host = u.hostname.toLowerCase(), seg = u.pathname.split("/").filter(Boolean);
  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host) || host === "boards-api.greenhouse.io") {
    const i = seg.indexOf("jobs"), board = (i > 0 ? seg[i - 1] : u.searchParams.get("for")) ?? "", id = i >= 0 ? seg[i + 1] : u.searchParams.get("token");
    return board && id && /^\d{1,20}$/.test(id) && BOARD_SLUG.test(board) ? { board: "Greenhouse", parts: [board, id], ...(/\.eu\./.test(host) ? { eu: true } : {}) } : null;
  }
  // A board name that is not a plain slug ("..%2f..%2fx") names no board: no address is built from it.
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && seg.length >= 2) return BOARD_SLUG.test(seg[0]) && POSTING_UUID.test(seg[1]) ? { board: "Lever", parts: [seg[0], seg[1].toLowerCase()], ...(/\.eu\./.test(host) ? { eu: true } : {}) } : null;
  if (host === "jobs.ashbyhq.com" && seg.length >= 2) return BOARD_SLUG.test(seg[0]) && POSTING_UUID.test(seg[1]) ? { board: "Ashby", parts: [seg[0], seg[1].toLowerCase()] } : null;
  if (host === "jobs.smartrecruiters.com" && seg.length >= 2) { const id = /^(\d{1,20})/.exec(seg[1])?.[1]; return id && BOARD_SLUG.test(seg[0]) ? { board: "SmartRecruiters", parts: [seg[0], id] } : null; }
  if (workdayUrl(url)) return { board: "Workday", parts: [] };
  return null;
}

// A label as the form shows it, as data: tags out, and a sentence written to an AI taken out (postingField).
const strip = (s: string) => postingField(decodeHtmlEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/✱|\*$/g, "").replace(/\s+/g, " ").trim(), 200);
const opts = (list: string[]): Pick<Question, "options" | "more_options"> => {
  const o = list.map((x) => postingField(x, 80)).filter(Boolean);
  return o.length ? { options: o.slice(0, 12), ...(o.length > 12 ? { more_options: o.length - 12 } : {}) } : {};
};
// A question's type is one of the kinds this reader knows, or "other": a board's raw type string is never passed on.
const known = (map: Record<string, string>, t: unknown): string => typeof t === "string" && Object.hasOwn(map, t) ? map[t] : "other";
const GH_TYPE: Record<string, string> = { input_text: "text", textarea: "long text", input_file: "file", multi_value_single_select: "choose one", multi_value_multi_select: "choose any", input_hidden: "hidden" };
export function greenhouseQuestions(json: any): Question[] | null {
  if (!json || !Array.isArray(json.questions)) return null;
  const out: Question[] = [];
  for (const q of [...json.questions, ...(Array.isArray(json.location_questions) ? json.location_questions : [])]) {
    const fields = (Array.isArray(q?.fields) ? q.fields : []).filter((f: any) => f?.type !== "input_hidden");
    if (!fields.length) continue;
    const f = fields[0];
    out.push({ label: strip(q.label), required: q.required === true, type: fields.slice(0, 3).map((x: any) => known(GH_TYPE, x?.type)).join(" or "), ...opts((Array.isArray(f.values) ? f.values : []).map((v: any) => String(v?.label ?? ""))) });
  }
  const demo = json.demographic_questions?.questions;
  if (Array.isArray(demo) && demo.length) out.push({ label: `Voluntary self-identification (${demo.length} question${demo.length === 1 ? "" : "s"})`, required: false, type: "voluntary" });
  return schemaFromGreenhouse(json) ? out : null;
}
export function leverQuestions(html: string): Question[] | null {
  const h = String(html ?? "");
  const starts = [...h.matchAll(/<li class="application-question[^"]*"/g)].map((m) => m.index!);
  if (!starts.length) return null;
  const out: Question[] = [];
  for (const [k, at] of starts.entries()) {
    const block = h.slice(at, starts[k + 1] ?? at + 6000).split(/<\/ul>\s*<\/div>/)[0];
    const label = strip(/<div class="application-label[^"]*">([\s\S]*?)<\/div>\s*(?:<\/div>\s*)?<div class="application-field/.exec(block)?.[1] ?? "");
    if (!label) continue;
    const required = /class="required"/.test(/<div class="application-label[\s\S]*?<div class="application-field/.exec(block)?.[0] ?? "");
    const type = /type="file"/.test(block) ? "file" : /<select/.test(block) ? "choose one" : /type="checkbox"/.test(block) ? "choose any" : /type="radio"/.test(block) ? "choose one" : /<textarea/.test(block) ? "long text" : "text";
    const options = [...block.matchAll(/<option value="([^"]+)"/g), ...block.matchAll(/<input type="(?:checkbox|radio)"[^>]*value="([^"]*)"/g)].map((m) => decodeHtmlEntities(m[1]));
    out.push({ label, required, type, ...opts(options) });
  }
  return out.length ? out : null;
}
const ASHBY_TYPE: Record<string, string> = { String: "text", Email: "email", File: "file", LongText: "long text", Phone: "phone", ValueSelect: "choose one", MultiValueSelect: "choose any", Boolean: "yes or no", Date: "date", Number: "number", Location: "location", SocialLink: "link", Url: "link", Score: "score" };
export function ashbyQuestions(json: any): Question[] | null {
  const sections = json?.data?.jobPosting?.applicationForm?.sections;
  if (!Array.isArray(sections)) return null;
  const out: Question[] = [];
  for (const s of sections) for (const e of Array.isArray(s?.fieldEntries) ? s.fieldEntries : []) {
    const f = e?.field;
    if (!f || f.isDeactivated || !String(f.title ?? "").trim()) continue;
    out.push({ label: strip(f.title), required: e.isRequired === true, type: known(ASHBY_TYPE, f.type), ...opts((Array.isArray(f.selectableValues) ? f.selectableValues : []).map((v: any) => String(v?.label ?? ""))) });
  }
  return out;
}
export const ASHBY_FORM_QUERY = "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title applicationForm { sections { title fieldEntries { field isRequired descriptionHtml } } } } }";
export function ashbyAppData(html: string): any | null {
  const at = String(html ?? "").indexOf("window.__appData = ");
  if (at < 0) return null;
  // The object literal, to its matching brace (strings and escapes respected).
  const rest = html.slice(at + "window.__appData = ".length);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = 0; i < rest.length && end < 0; i++) {
    const c = rest[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) end = i + 1;
  }
  try { return end > 0 ? JSON.parse(rest.slice(0, end)) : null; } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ the read
// Round 4: ONE state for a board's answer, used by the reader below and by the link check (link_check.ts), so they cannot
// disagree. null: the answer is not this posting's data (an error body, another posting's id, no title). "open" needs the
// board's own signal: the posting itself from an API that lists only published postings (Greenhouse; Lever, unless it carries
// a `state` other than "published"), `active` true and not a non-public `visibility` (SmartRecruiters), `isListed` true
// (Ashby). A stated deadline that has passed is closed. Anything else is unknown. (Workday: workday_posting.ts workdayState.)
export type PostingState = "open" | "closed" | "unknown";
export function boardState(board: Exclude<Board, "Workday">, j: any, id: string, today: string): PostingState | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const named = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const past = (v: unknown) => { const d = isoDay(v); return !!d && d < today; };
  if (board === "Greenhouse") return String(j.id) !== id || !named(j.title) ? null : past(j.application_deadline) ? "closed" : "open";
  if (board === "Lever") return String(j.id ?? "").toLowerCase() !== id.toLowerCase() || !named(j.text) ? null : j.state === undefined || j.state === "published" ? "open" : typeof j.state === "string" ? "closed" : "unknown";
  if (board === "SmartRecruiters") return String(j.id) !== id || !named(j.name) ? null : j.active === false ? "closed" : j.visibility !== undefined && j.visibility !== "PUBLIC" ? "unknown" : j.active === true ? "open" : "unknown";
  return String(j.id ?? "").toLowerCase() !== id.toLowerCase() || !named(j.title) ? null : past(j.applicationDeadline) ? "closed" : j.isListed === true ? "open" : "unknown";
}
const isoDay = (v: unknown) => { const s = String(v ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null; };
export interface ReadDeps { fetch: Fetch; timeoutMs?: number; userAgent?: string; now?: () => number }
export async function readApplyFlow(href: string, d: ReadDeps): Promise<ApplyFlow> {
  const url = String(href ?? "").trim();
  const reads: string[] = [];
  const base = (b: Board | null): ApplyFlow => ({ status: "unknown", board: b, url, posting: null, requirements: { required: [], preferred: [] }, questions: null, questions_read: "not_read", questions_why: "", entry: [], sign_in_required: false, captcha_expected: false, reads, why: "", boundary: READ_ONLY_BOUNDARY });
  let host = "";
  try { host = new URL(url).hostname; } catch { /* below */ }
  // why is our own words: a host name is someone else's text, so it is not repeated there (it is in `url`).
  if (!host || neverOpen(host)) return { ...base(null), status: "not_readable", why: host ? "not read: it is a site Trainee never opens" : "not read: that is not a link" };
  const b = boardOf(url);
  if (!b) return { ...base(null), status: "not_readable", why: "not read: Trainee does not read postings on that site" };
  const get = async (u: string, accept: string, init: RequestInit = {}) => {
    reads.push(`${init.method ?? "GET"} ${u}`);
    // One time limit for the request, its redirects and its body (posting_fetch.ts limited: it holds whatever the fetch does).
    // Every hop stays on this board's own hosts: an answer that came from another board is not this board's (sameBoard).
    return await guardedText(d.fetch, u, { method: "GET", ...init, headers: { accept, "user-agent": d.userAgent ?? "Trainee posting reader", ...(init.headers ?? {}) } }, { allow: sameBoard(u), timeoutMs: d.timeoutMs ?? 8000 });
  };
  // What stopped a read, in fixed words (an error's message can quote the page). A refused address or hop, or a body past the
  // cap: not read, never "ok".
  const failed = (o: ApplyFlow, e: unknown, what: string): ApplyFlow => e instanceof NotRead ? { ...o, status: "not_readable", posting: null, why: `${e.message} (${what})` } : { ...o, why: `${what} did not finish (${stopWords(e)})` };
  const formStop = (e: unknown) => e instanceof NotRead ? e.message : stopWords(e);
  const out = base(b.board);
  const today = new Date((d.now ?? Date.now)()).toISOString().slice(0, 10);
  // Round 2: "open" is never the default: the state is boardState's (above), the same one the link check uses.
  const posting = (title: string, company: unknown, location: unknown, text: string, state: PostingState, deadline: unknown = null) =>
    ({ title: postingField(title), company: postingField(company) || null, location: postingField(location) || null, pay: placedPay(postingTextForModel(text, Infinity).text, postingField(location) || null), deadline: isoDay(deadline), deadline_text: isoDay(deadline), state });
  const said = (v: unknown, max = 120) => postingField(v, max) || null; // a pay summary as the board states it
  // An answer that is not this posting's data (an error body, another posting, HTML where JSON belongs): not read.
  const notIt = (who: string): ApplyFlow => ({ ...out, status: "not_readable", why: `not read: ${who} answer was not this posting's data` });
  const capped = (qs: Question[] | null) => qs && qs.length > MAX_QUESTIONS ? { questions: qs.slice(0, MAX_QUESTIONS), questions_more: qs.length - MAX_QUESTIONS } : { questions: qs };

  if (b.board === "Workday") {
    const w = await readWorkdayPosting(url, d as WorkdayDeps);
    reads.push(...(w?.reads ?? []));
    const p = w?.posting;
    return {
      ...out, status: p ? "ok" : /not read/.test(w?.why ?? "") ? "not_readable" : "unknown", why: w?.why ?? "",
      // D-067 (C1): a posting that states pay by place never hands over one place's range unlabelled: `pay` is each range with its place.
      posting: p ? { title: p.title, company: p.company, location: p.location, pay: said(p.pays.length > 1 && new Set(p.pays.map((x) => x.pay)).size > 1 ? p.pays.slice(0, 12).map((x) => `${x.place}: ${x.pay}`).join("; ") : p.pay, 600), ...(p.pays.length ? { pay_by_place: p.pays.slice(0, 12).map((x) => ({ place: postingField(x.place, 80), pay: postingField(x.pay, 80) })) } : {}), deadline: p.deadline, deadline_text: p.deadline_text, state: w!.state } : null,
      requirements: p ? requirementsFrom(p.description_html) : out.requirements,
      questions: null, questions_read: "behind_sign_in",
      questions_why: `Workday shows an application's questions only after the person signs in to (or creates) their own careers account on the employer's Workday site${p?.questionnaire ? "; this posting has employer questions of its own" : ""}. They were not read, and are not known.`,
      entry: ["Apply on the employer's Workday careers site", "sign in to, or create, a careers account on that site (the person does this themselves)", "then the employer's steps: contact details, experience and resume, the employer's own questions, voluntary disclosures, review and submit"],
      sign_in_required: true,
    };
  }
  if (b.board === "Greenhouse") {
    const [board, id] = b.parts;
    try {
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`, "application/json");
      // A board on Greenhouse's EU site is not in the global API, and its regional API host is not known here: a 404 from the
      // global API says nothing about that posting.
      if ((r.status === 404 || r.status === 410) && b.eu) return { ...out, status: "not_readable", why: "not read: this board is on Greenhouse's EU site, whose posting API this reader does not know" };
      if (r.status === 404 || r.status === 410) return { ...out, status: "ok", posting: null, why: "Greenhouse no longer lists this posting (closed)", questions_why: "The posting is closed." };
      if (!r.ok) return { ...out, why: `Greenhouse answered HTTP ${r.status}` };
      const j: any = parseJson(r.text);
      const st = boardState("Greenhouse", j, id, today);
      if (st === null) return notIt("Greenhouse's");
      const qs = greenhouseQuestions(j);
      return { ...out, status: "ok", why: "read live from Greenhouse's public posting API",
        posting: posting(j.title, j.company_name, j.location?.name, htmlToText(decodeHtmlEntities(String(j.content ?? ""))), st, j.application_deadline),
        requirements: requirementsFrom(String(j.content ?? "")), ...capped(qs), questions_read: qs ? "read" : "not_read",
        questions_why: qs ? "Every question on the posting's form, from Greenhouse's public posting API (no sign-in on Greenhouse)." : "The form's questions were not in Greenhouse's answer.",
        entry: ["one form on the posting page; no account needed"] };
    } catch (e) { return failed(out, e, "the Greenhouse read"); }
  }
  if (b.board === "Lever") {
    const [site, id] = b.parts;
    let o: ApplyFlow = out;
    try {
      const r = await get(`https://${b.eu ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${site}/${id}`, "application/json"); // an EU site's postings are in Lever's EU API
      if (r.status === 404 || r.status === 410) return { ...out, status: "ok", why: "Lever no longer lists this posting (closed)", questions_why: "The posting is closed." };
      if (!r.ok) return { ...out, why: `Lever answered HTTP ${r.status}` };
      const j: any = parseJson(r.text);
      const st = boardState("Lever", j, id, today);
      if (st === null) return notIt("Lever's");
      const lists = (Array.isArray(j.lists) ? j.lists : []).map((l: any) => `<h3>${l?.text ?? ""}</h3><ul>${l?.content ?? ""}</ul>`).join("");
      const text = [j.descriptionPlain, (Array.isArray(j.lists) ? j.lists : []).map((l: any) => `${l?.text}\n${htmlToText(l?.content ?? "")}`).join("\n"), j.additionalPlain].filter(Boolean).join("\n");
      const sal = j.salaryRange && Number.isFinite(j.salaryRange.min) ? `${j.salaryRange.currency ?? ""} ${j.salaryRange.min} - ${j.salaryRange.max} ${String(j.salaryRange.interval ?? "").replace(/-/g, " ")}`.trim() : null;
      const p = posting(j.text, null, j.categories?.location, text, st);
      o = { ...out, status: "ok", why: "read live from Lever's public posting API", posting: { ...p, pay: said(sal) ?? p.pay }, requirements: requirementsFrom(`${j.description ?? ""}${lists}${j.additional ?? ""}`), entry: ["one form on the posting's apply page; no account needed"] };
    } catch (e) { return failed(out, e, "the Lever read"); }
    try {
      const r = await get(`https://${b.eu ? "jobs.eu.lever.co" : "jobs.lever.co"}/${site}/${id}/apply`, "text/html");
      if (!r.ok) return { ...o, questions_why: `The form page answered HTTP ${r.status}; its questions were not read.` };
      const qs = leverQuestions(r.text);
      return { ...o, ...capped(qs), questions_read: qs ? "read" : "not_read", captcha_expected: /h-captcha|hcaptcha/i.test(r.text),
        questions_why: qs ? "Every question on the posting's public apply page (no sign-in on Lever)." : "The apply page held no questions this reader knows." };
    } catch (e) { return { ...o, questions_why: `The form page read did not finish (${formStop(e)}); its questions were not read.` }; }
  }
  if (b.board === "Ashby") {
    const [board, id] = b.parts;
    let o: ApplyFlow = out;
    try {
      const r = await get(`https://jobs.ashbyhq.com/${board}/${id}`, "text/html");
      if (r.status === 404 || r.status === 410) return { ...out, status: "ok", why: "Ashby no longer shows this posting (closed)", questions_why: "The posting is closed." };
      if (!r.ok) return { ...out, why: `Ashby answered HTTP ${r.status}` };
      const data = ashbyAppData(r.text), p = data?.posting;
      if (!p || String(p.id ?? "").toLowerCase() !== id) return { ...out, status: "ok", why: "Ashby's page does not hold this posting (closed, or never there)", questions_why: "The posting is not on Ashby's page." };
      const st = boardState("Ashby", p, id, today);
      if (st === null) return notIt("Ashby's");
      const base = posting(p.title, data?.organization?.name, p.locationName, htmlToText(String(p.descriptionHtml ?? "")), st, p.applicationDeadline);
      o = { ...out, status: "ok", why: "read live from the posting's Ashby page", posting: { ...base, pay: said(p.scrapeableCompensationSalarySummary) || said(p.compensationTierSummary) || base.pay }, requirements: requirementsFrom(String(p.descriptionHtml ?? "")), entry: ["one form on the posting's application page; no account needed"] };
    } catch (e) { return failed(out, e, "the Ashby read"); }
    try {
      const r = await get("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", "application/json", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationName: "ApiJobPosting", variables: { organizationHostedJobsPageName: board, jobPostingId: id }, query: ASHBY_FORM_QUERY }) });
      if (!r.ok) return { ...o, questions_why: `Ashby's form read answered HTTP ${r.status}; its questions were not read.` };
      const qs = ashbyQuestions(parseJson(r.text));
      return { ...o, ...capped(qs), questions_read: qs ? "read" : "not_read", captcha_expected: true,
        questions_why: qs ? "Every question on the posting's form, from the read-only query Ashby's own page makes (no sign-in on Ashby)." : "Ashby's answer held no form." };
    } catch (e) { return { ...o, questions_why: `Ashby's form read did not finish (${formStop(e)}); its questions were not read.` }; }
  }
  // SmartRecruiters
  const [company, id] = b.parts;
  try {
    const r = await get(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`, "application/json");
    if (r.status === 404 || r.status === 410) return { ...out, status: "ok", why: "SmartRecruiters no longer lists this posting (closed)", questions_why: "The posting is closed." };
    if (!r.ok) return { ...out, why: `SmartRecruiters answered HTTP ${r.status}` };
    const j: any = parseJson(r.text);
    const st = boardState("SmartRecruiters", j, id, today);
    if (st === null) return notIt("SmartRecruiters'");
    const s = j.jobAd?.sections ?? {};
    const html = ["jobDescription", "qualifications", "additionalInformation"].map((k) => s[k] ? `<h3>${s[k].title ?? ""}</h3>${s[k].text ?? ""}` : "").join("");
    return { ...out, status: "ok", why: "read live from SmartRecruiters' public posting API",
      posting: posting(j.name, j.company?.name, j.location?.fullLocation, htmlToText(html), st),
      requirements: requirementsFrom(html), questions_read: "not_public",
      questions_why: "SmartRecruiters does not publish an application's questions (its application API needs a partner key, and its form page is behind a bot check Trainee never solves). They were not read, and are not known.",
      entry: ["one form on SmartRecruiters' apply page; no account needed"] };
  } catch (e) { return failed(out, e, "the SmartRecruiters read"); }
}
