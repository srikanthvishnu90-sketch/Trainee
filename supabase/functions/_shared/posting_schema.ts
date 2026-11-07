// MASS APPLY (2026-11-01): a posting's application form read from the ATS's public board API, without a browser, cached.
// Greenhouse publishes every question of a posting (boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true:
// labels, required, field names, types and option values); Lever's postings API and Ashby's posting API publish the posting
// but not its application questions, so those (and any Greenhouse read that fails) answer null: the browser reads the form.
// Read-only, one GET per posting per TTL. What this returns is the form's shape only; it is never an answer and never a
// payload (the engine still fills and checks the live form before anything is sent).
export interface SchemaField { name: string; label: string; required: boolean; type: string; options: { label: string; value: string }[] }
export interface PostingSchema { source: "greenhouse_boards_api"; fields: SchemaField[]; read_at: number }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// The board API link for a posting link, or null when the ATS publishes no questions.
export function schemaUrlFor(url: string, o: { greenhouseApi?: string } = {}): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const m = /^\/(?:embed\/job_app\?for=)?([A-Za-z0-9_-]+)\/jobs\/(\d+)/.exec(u.pathname);
  const gh = /(^|\.)greenhouse\.io$/.test(u.hostname) || (o.greenhouseApi && u.origin === new URL(o.greenhouseApi).origin);
  if (!gh || !m) return null;
  return `${o.greenhouseApi ?? "https://boards-api.greenhouse.io"}/v1/boards/${m[1]}/jobs/${m[2]}?questions=true`;
}

export function schemaFromGreenhouse(json: any): SchemaField[] | null {
  if (!json || !Array.isArray(json.questions)) return null;
  const out: SchemaField[] = [];
  for (const q of json.questions) {
    for (const f of Array.isArray(q?.fields) ? q.fields : []) {
      if (typeof f?.name !== "string" || !f.name) continue;
      out.push({ name: f.name, label: String(q.label ?? ""), required: q.required === true && !/_text$/.test(f.name), type: String(f.type ?? ""),
        options: (Array.isArray(f.values) ? f.values : []).map((v: any) => ({ label: String(v?.label ?? ""), value: String(v?.value ?? "") })) });
    }
  }
  return out;
}

export function schemaCache(ttlMs = 6 * 3600_000, now: () => number = Date.now) {
  const m = new Map<string, PostingSchema | null>(), at = new Map<string, number>();
  return {
    get: (k: string) => (at.has(k) && now() - at.get(k)! < ttlMs ? m.get(k) : undefined),
    put: (k: string, v: PostingSchema | null) => { m.set(k, v); at.set(k, now()); },
  };
}

// The schema, from the cache or one GET; null (use the browser) when the ATS publishes none or the read fails.
export async function postingSchema(url: string, d: { fetch: Fetch; cache?: ReturnType<typeof schemaCache>; greenhouseApi?: string; now?: () => number }): Promise<PostingSchema | null> {
  const api = schemaUrlFor(url, { greenhouseApi: d.greenhouseApi });
  if (!api) return null;
  const hit = d.cache?.get(api);
  if (hit !== undefined) return hit;
  let v: PostingSchema | null = null;
  try {
    const r = await d.fetch(api, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const fields = r.ok ? schemaFromGreenhouse(await r.json()) : null;
    v = fields ? { source: "greenhouse_boards_api", fields, read_at: (d.now ?? Date.now)() } : null;
  } catch { v = null; }
  d.cache?.put(api, v);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------- WO-121
// The form read once, when the posting is first seen (the career-form-schema lane), from the ATS's public read and with
// no browser: Greenhouse's board API (?questions=true), Lever's server-rendered /apply page, and Ashby's job page read
// (POST /api/non-user-graphql, the page's own, undocumented: only with the owner's yes, CAREER_FORM_ASHBY_GRAPHQL=on).
// SmartRecruiters (a partner key) and Workday (the applicant's sign-in) are recorded unread with their reason. LinkedIn,
// Indeed and Handshake are never requested. What this returns is the form's shape: never an answer, never a payload.
export type FormSource = "greenhouse_boards_api" | "lever_apply_html" | "ashby_posting_graphql";
export type FieldType = "text" | "textarea" | "email" | "phone" | "url" | "number" | "date" | "select" | "multiselect"
  | "radio" | "checkbox" | "boolean" | "file" | "location" | "hidden";
export type Section = "main" | "location" | "compliance" | "eeo" | "consent";
export interface FormField { id: string; label: string; type: FieldType; raw_type: string; required: boolean;
  options: { label: string; value: string }[]; section: Section }
export interface FormSchema { v: 1; job_id: string; source: FormSource; fields: FormField[]; uploads: string[];
  captcha_expected: boolean; sha256: string; read_at: string }
export type Unread = "not_public" | "needs_partner_key" | "sign_in_required" | "no_form" | "http_error" | "rate_limited" | "parse_error";
export interface FormUnread { v: 1; job_id: string; unread: Unread; detail: string; read_at: string; retry_after_s?: number }
export type FormRequest = { url: string; method: "GET" | "POST"; body?: string; headers: Record<string, string> };
type Posting = { job_id: string; provider: string; board: string; ats_id: string | null; url: string };
type Parsed = Omit<FormSchema, "v" | "job_id" | "read_at" | "sha256">;

const NEVER_READ = /(^|\.)(linkedin\.com|indeed\.com|indeed\.[a-z]{2,3}(\.[a-z]{2})?|joinhandshake\.com|handshake\.com)$/i;
const unread = (job_id: string, why: Unread, detail: string, at = Date.now(), retry?: number): FormUnread =>
  ({ v: 1, job_id, unread: why, detail: detail.slice(0, 300), read_at: new Date(at).toISOString(), ...(retry !== undefined ? { retry_after_s: retry } : {}) });
const seg = (s: string) => encodeURIComponent(s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASHBY_QUERY = "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id applicationForm { sections { title fieldEntries { field isRequired } } } } }";

// The one request that reads a posting's form, or why none is made.
export function formRequestFor(p: Posting, o: { ashbyGraphql?: boolean; greenhouseApi?: string; leverOrigin?: string; ashbyOrigin?: string } = {}): FormRequest | FormUnread {
  let host = "";
  try { host = new URL(p.url).hostname; } catch { /* checked per provider below */ }
  if (NEVER_READ.test(host)) return unread(p.job_id, "not_public", `${host} is never read`);
  const id = String(p.ats_id ?? "");
  if (p.provider === "greenhouse") {
    const api = /^\d+$/.test(id) && p.board ? `${o.greenhouseApi ?? "https://boards-api.greenhouse.io"}/v1/boards/${seg(p.board)}/jobs/${id}?questions=true` : schemaUrlFor(p.url, o);
    return api ? { url: api, method: "GET", headers: { accept: "application/json" } } : unread(p.job_id, "parse_error", "no Greenhouse board and job id");
  }
  if (p.provider === "lever") {
    if (!UUID.test(id) || !p.board) return unread(p.job_id, "parse_error", "no Lever site and posting id");
    return { url: `${o.leverOrigin ?? "https://jobs.lever.co"}/${seg(p.board)}/${id}/apply`, method: "GET", headers: { accept: "text/html" } };
  }
  if (p.provider === "ashby") {
    if (!o.ashbyGraphql) return unread(p.job_id, "not_public", "Ashby publishes its form only through the page's own read; the owner has not switched it on (CAREER_FORM_ASHBY_GRAPHQL)");
    if (!UUID.test(id) || !p.board) return unread(p.job_id, "parse_error", "no Ashby board and posting id");
    return { url: `${o.ashbyOrigin ?? "https://jobs.ashbyhq.com"}/api/non-user-graphql?op=ApiJobPosting`, method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ operationName: "ApiJobPosting", variables: { organizationHostedJobsPageName: p.board, jobPostingId: id }, query: ASHBY_QUERY }) };
  }
  if (p.provider === "smartrecruiters") return unread(p.job_id, "needs_partner_key", "the application configuration needs an X-SmartToken or OAuth key");
  if (p.provider === "workday") return unread(p.job_id, "sign_in_required", "Workday's questions are behind the applicant's sign-in");
  return unread(p.job_id, "not_public", `no public form read for ${p.provider}`);
}

const field = (id: string, label: string, type: FieldType, raw_type: string, required: boolean, options: FormField["options"], section: Section): FormField =>
  ({ id, label: label.trim(), type, raw_type, required, options, section });
const dedupe = (fs: FormField[]) => { const seen = new Set<string>(); return fs.filter((f) => !seen.has(f.id) && !!seen.add(f.id)); };
const done = (source: FormSource, fields: FormField[], captcha_expected: boolean): Parsed => {
  const fs = dedupe(fields);
  return { source, fields: fs, uploads: fs.filter((f) => f.type === "file").map((f) => f.id), captcha_expected };
};

const GH_TYPES: Record<string, FieldType> = { input_text: "text", textarea: "textarea", input_file: "file", input_hidden: "hidden",
  multi_value_single_select: "select", multi_value_multi_select: "multiselect", boolean: "boolean" };
function ghType(raw: string, name: string): FieldType {
  const t = GH_TYPES[raw] ?? "text";
  if (t !== "text") return t;
  return name === "email" ? "email" : name === "phone" ? "phone" : name === "location" ? "location" : /url|linkedin|website|github/i.test(name) ? "url" : "text";
}
export function parseGreenhouseForm(json: unknown): Parsed | null {
  const j = json as any;
  if (!j || !Array.isArray(j.questions)) return null;
  const out: FormField[] = [];
  const add = (qs: unknown, section: Section) => {
    for (const q of Array.isArray(qs) ? qs : []) {
      if (Array.isArray(q?.fields)) {
        for (const f of q.fields) {
          if (typeof f?.name !== "string" || !f.name) continue;
          const opts = (Array.isArray(f.values) ? f.values : []).map((v: any) => ({ label: String(v?.label ?? ""), value: String(v?.value ?? "") }));
          out.push(field(f.name, String(q.label ?? ""), ghType(String(f.type ?? ""), f.name), String(f.type ?? ""), q.required === true && !/_text$/.test(f.name), opts, section));
        }
      } else if (q?.id !== undefined && Array.isArray(q?.answer_options)) { // the demographic shape: one question, its answer options
        const opts = q.answer_options.map((v: any) => ({ label: String(v?.label ?? ""), value: String(v?.id ?? "") }));
        const raw = String(q.type ?? "multi_value_single_select");
        out.push(field(`demographic_question_${q.id}`, String(q.label ?? ""), GH_TYPES[raw] ?? "select", raw, q.required === true, opts, section));
      }
    }
  };
  add(j.questions, "main");
  add(j.location_questions, "location");
  for (const c of Array.isArray(j.compliance) ? j.compliance : []) add(c?.questions, "eeo");
  add(Array.isArray(j.demographic_questions) ? j.demographic_questions : j.demographic_questions?.questions, "eeo");
  return done("greenhouse_boards_api", out, false);
}

// Lever's /apply page as the server renders it. Every input, select and textarea of the application form, labelled by the
// application-label before it (reset at each question), or by the answer text beside a lone checkbox. Hidden inputs
// (the posting's card templates, origin, referer, the captcha token, the parsed-resume store) are page state, not questions.
const ENT = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const TEXT = (s: string) => ENT(s.replace(/<[^>]*>/g, " ")).replace(/✱/g, "").replace(/\s+/g, " ").trim();
// An attribute's value ("" for a bare one such as required), or null when the tag does not carry it.
const attr = (a: string, n: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${n}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=[\\s/>]|$)`, "i").exec(a);
  return m ? ENT(m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};
export function parseLeverApplyHtml(html: string): Parsed | null {
  if (typeof html !== "string") return null;
  const start = html.search(/<form\b[^>]*id="application-form"/i);
  const end = start >= 0 ? html.indexOf("</form>", start) : -1;
  const form = start < 0 ? html : html.slice(start, end < 0 ? undefined : end);
  const re = /class="application-question\b|<div class="application-label[^"]*"[^>]*>([\s\S]*?)(?=<div class="application-field|<input\b|<select\b|<textarea\b|<ul\b)|<select\b([^>]*)>([\s\S]*?)<\/select>|<(input|textarea)\b([^>]*)>/gi;
  const byId = new Map<string, FormField>();
  let label = "", labelRequired = false;
  for (let m; (m = re.exec(form));) {
    if (m[0].startsWith("class=")) { label = ""; labelRequired = false; continue; }
    if (m[1] !== undefined) { label = TEXT(m[1]); labelRequired = /class="required"/.test(m[1]); continue; }
    const tag = m[2] !== undefined ? "select" : m[4].toLowerCase(), a = m[2] ?? m[5];
    const name = attr(a, "name"), type = (attr(a, "type") || tag).toLowerCase();
    if (!name || type === "hidden" || type === "submit" || type === "button") continue;
    const required = labelRequired || attr(a, "required") !== null;
    const answer = /^[\s\S]{0,400}?class="application-answer-alternative"[^>]*>([\s\S]*?)<\/(?:span|p)>/.exec(form.slice(re.lastIndex));
    const own = answer ? TEXT(answer[1]) : "";
    const prev = byId.get(name);
    if (prev && (type === "radio" || type === "checkbox")) {
      prev.options.push({ label: own || attr(a, "value") || "", value: attr(a, "value") ?? "" });
      if (type === "checkbox") prev.type = "multiselect";
      prev.required ||= required;
      continue;
    }
    if (prev) continue;
    const options = tag === "select"
      ? [...m[3].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({ label: TEXT(o[2]), value: attr(o[1], "value") ?? TEXT(o[2]) })).filter((o) => o.value !== "")
      : type === "radio" || type === "checkbox" ? [{ label: own || attr(a, "value") || "", value: attr(a, "value") ?? "" }] : [];
    const ft: FieldType = tag === "select" ? "select" : tag === "textarea" ? "textarea" : type === "file" ? "file" : type === "email" ? "email"
      : type === "radio" ? "radio" : type === "checkbox" ? "checkbox" : type === "tel" || name === "phone" ? "phone" : name === "location" ? "location"
      : type === "url" || /^urls\[/.test(name) ? "url" : type === "number" ? "number" : type === "date" ? "date" : "text";
    const section: Section = /^(eeo|surveysResponses)\[/.test(name) ? "eeo" : /^consent\[/.test(name) ? "consent" : "main";
    byId.set(name, field(name, label || own, ft, tag === "input" ? type : tag, required, options, section));
  }
  if (!byId.size) return null;
  return done("lever_apply_html", [...byId.values()], /name="h-captcha-response"/.test(html));
}

// Ashby's ApiJobPosting answer: sections of field entries, each a field (path, title, type, selectable values) and whether
// this posting requires it.
const ASHBY_TYPES: Record<string, FieldType> = { String: "text", Email: "email", Phone: "phone", LongText: "textarea", File: "file",
  Boolean: "boolean", ValueSelect: "select", MultiValueSelect: "multiselect", Number: "number", Date: "date", Location: "location", SocialLink: "url" };
export function parseAshbyPosting(json: unknown): Parsed | null {
  const j = json as any, post = j?.data?.jobPosting ?? j?.jobPosting;
  const sections = post?.applicationForm?.sections;
  if (!Array.isArray(sections)) return null;
  const out: FormField[] = [];
  for (const s of sections) {
    for (const e of Array.isArray(s?.fieldEntries) ? s.fieldEntries : []) {
      const f = e?.field;
      if (typeof f?.path !== "string" || !f.path) continue;
      const raw = String(f.type ?? "");
      const opts = (Array.isArray(f.selectableValues) ? f.selectableValues : []).map((v: any) => ({ label: String(v?.label ?? ""), value: String(v?.value ?? "") }));
      out.push(field(f.path, String(f.title ?? ""), ASHBY_TYPES[raw] ?? "text", raw, e.isRequired === true, opts, /eeoc|eeo_/i.test(f.path) ? "eeo" : "main"));
    }
  }
  return done("ashby_posting_graphql", out, false);
}

async function sha256Of(fields: FormField[]): Promise<string> {
  const canon = JSON.stringify(fields.map((f) => [f.id, f.label, f.type, f.raw_type, f.required, f.options.map((o) => [o.label, o.value]), f.section]));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function retryAfter(v: string | null, now: number): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : undefined;
}

// One request per posting; a captured schema or why it is unread. Never an empty form for a page that did not parse.
export async function readForm(p: Posting, d: { fetch: typeof fetch; now: () => number; ashbyGraphql: boolean; userAgent?: string }): Promise<FormSchema | FormUnread> {
  const req = formRequestFor(p, { ashbyGraphql: d.ashbyGraphql });
  if ("unread" in req) return { ...req, read_at: new Date(d.now()).toISOString() };
  let r: Response;
  try {
    r = await d.fetch(req.url, { method: req.method, body: req.body, headers: { ...req.headers, ...(d.userAgent ? { "user-agent": d.userAgent } : {}) }, signal: AbortSignal.timeout(15_000) });
  } catch (e) { return unread(p.job_id, "http_error", `request failed: ${String((e as Error)?.message ?? e)}`, d.now()); }
  if (r.status === 429) { await r.body?.cancel(); return unread(p.job_id, "rate_limited", "HTTP 429", d.now(), retryAfter(r.headers.get("retry-after"), d.now())); }
  if (r.status === 404 || r.status === 410) { await r.body?.cancel(); return unread(p.job_id, "no_form", `HTTP ${r.status}`, d.now()); }
  if (!r.ok) { await r.body?.cancel(); return unread(p.job_id, "http_error", `HTTP ${r.status}`, d.now()); }
  let parsed: Parsed | null = null;
  try {
    const text = await r.text();
    if (p.provider === "lever") parsed = parseLeverApplyHtml(text);
    else {
      const j = JSON.parse(text);
      if (p.provider === "ashby" && j?.data && j.data.jobPosting === null) return unread(p.job_id, "no_form", "Ashby answered no posting", d.now());
      parsed = p.provider === "ashby" ? parseAshbyPosting(j) : parseGreenhouseForm(j);
    }
  } catch (e) { return unread(p.job_id, "parse_error", String((e as Error)?.message ?? e), d.now()); }
  if (!parsed || parsed.fields.length === 0) return unread(p.job_id, "parse_error", "no form fields in the answer", d.now());
  return { v: 1, job_id: p.job_id, ...parsed, sha256: await sha256Of(parsed.fields), read_at: new Date(d.now()).toISOString() };
}
