// The file kinds (owner, 2026-10-28): the jobs list page is ONE kind of file. Every other thing the agent hands over as a page
// (an introduction, proof of an application, a weekly plan, a comparison, a draft, a research brief) is a kind in this registry:
// a typed data schema, a renderer (html body inside the shared shell, plain-text twin from the same data), and a truthful action set.
//
// Rules that do not move: every fact carries a source label and a fact without one is neither accepted nor rendered; an unknown value
// is omitted, never guessed (a placeholder like "unknown" is refused); the plain-text twin carries every fact, its label and every
// action's state; an action's state says what is true ("Approved. Not sent yet" until a sender really sent it); nothing in a file
// sends anything except through the exact-payload approval flow (an introduction's Introduce is bound to the hash of its exact message).
// Pure functions: data in, string out. Untrusted text is always escaped.
import { evidenceHtml, unknown, UNKNOWN, valueHtml } from "./file_design.ts";
import { cap1, esc } from "./file_page.ts";

export const SOURCES = ["From the posting", "From your resume", "From you", "Reported, not verified"] as const;
export type Source = typeof SOURCES[number] | "From Trainee's records";
// Counts and statuses that Trainee itself recorded (applications, interviews). Allowed on plan reviews and application proofs only.
const RECORDS: Source = "From Trainee's records";
export const KIND_IDS = ["job_list", "introduction", "application_proof", "plan_review", "comparison", "draft", "research_brief"] as const;
export type KindId = typeof KIND_IDS[number];
export const KIND_LABEL: Record<KindId, string> = { job_list: "Your jobs", introduction: "Introduction", application_proof: "Application proof", plan_review: "Plan review", comparison: "Comparison", draft: "Draft", research_brief: "Research brief" };
export const MODEL_KINDS = KIND_IDS.filter((k) => k !== "job_list");

export interface FileRecord {
  id: string; userId: string; kind: KindId; data: any; state: Record<string, any>;
  tag: string | null; // introduction: first 16 hex of the hash of the exact message; null for the other kinds
  created_at: number; expires_at: number; revoked_at: number | null;
}
export interface ActionView { id: string; label: string; state: "available" | "done" | "unavailable" | "approved_not_sent"; note?: string }
export type Validated = { ok: true; data: any } | { ok: false; errors: string[] };

// ---------------------------------------------------------------- validation helpers
// Normalised before comparing: Unicode folded, zero-width and format characters dropped, everything but letters and digits turned into
// single spaces, lower case. So "n/a.", "TBD.", "unknown" + a zero-width space, an em dash and "..." all read as what they are.
// The denylist is deliberately small: it catches the usual stand-ins, not every way of saying "no value". The schema's real defence is
// that a fact needs a source label and the fact guard checks it against what the person or a tool said.
const PLACEHOLDERS = new Set(["none given", "pending", "not disclosed", "unknown", "n a", "na", "none", "null", "undefined", "nil", "tbd", "tba", "tbc", "todo", "tk", "xxx", "not known", "unknown value", "not given", "not stated", "not available", "not specified", "not applicable", "not provided", "unspecified", "undisclosed", "to be determined", "to be announced", "to be confirmed", "placeholder", "redacted", "empty", "blank", "no data", "no info", "no information", "nothing", "lorem ipsum"]);
// Look-alike letters from Cyrillic and Greek, mapped to the Latin letter they imitate (a small map, not the full Unicode confusables table).
const CONFUSABLE = new Map(Object.entries({ "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u043A": "k", "\u043D": "h", "\u0432": "b", "\u043C": "m", "\u0442": "t", "\u044C": "b", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04CF": "l",
  "\u03B1": "a", "\u03BF": "o", "\u03BD": "v", "\u03C5": "u", "\u03C1": "p", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03C4": "t", "\u03C7": "x", "\u03B7": "n", "\u03B2": "b", "\u03B3": "y" }));
// Capitals first (Greek capital Nu looks like N, its lower case looks like v), then lower case.
for (const [from, to] of [["\u0391", "a"], ["\u0392", "b"], ["\u0395", "e"], ["\u0396", "z"], ["\u0397", "h"], ["\u0399", "i"], ["\u039A", "k"], ["\u039C", "m"], ["\u039D", "n"], ["\u039F", "o"], ["\u03A1", "p"], ["\u03A4", "t"], ["\u03A5", "y"], ["\u03A7", "x"],
  ["\u0410", "a"], ["\u0412", "b"], ["\u0415", "e"], ["\u041A", "k"], ["\u041C", "m"], ["\u041D", "h"], ["\u041E", "o"], ["\u0420", "p"], ["\u0421", "c"], ["\u0422", "t"], ["\u0423", "y"], ["\u0425", "x"]]) CONFUSABLE.set(from, to);
const fold = (t: string) => [...t.normalize("NFKC").replace(/[\p{Cf}]/gu, "")].map((c) => CONFUSABLE.get(c) ?? c).join("").toLowerCase();
const isPlaceholder = (t: string) => {
  let n = fold(t).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const parts = n.split(" ");
  if (parts.length > 1 && parts.every((p) => p.length === 1)) n = parts.join(""); // "u n k n o w n" and "n a"
  return n === "" || PLACEHOLDERS.has(n);
};
// Template tokens ("[Your Name]", "{{first_name}}", "<name>") are never an approvable fact or message.
const TEMPLATE = /\[[^\]\n]{1,60}\]|\{\{[^}]*\}\}|\{[A-Za-z_ ]{2,30}\}|<[^>\n]{1,40}>|\byour[_ ](?:name|company|title|role)\b|\binsert\b/i;
// Text that imitates a source label inside a value ("Python [From the posting]") would pass for one.
const LABELS = "from the posting|from your resume|from you|reported,? not verified|from trainee['\u2019]?s records";
const SPOOF = new RegExp(`[\\[(\u3010\uFF62]\\s*(?:${LABELS})\\s*[\\])\u3011\uFF63]|(?:^|[\u00B7|\u2014\u2013:\\-]\\s*)(?:${LABELS})\\s*$`, "i");
const SECRETISH = /pass(?:word|wd|code)?\b|one[- ]?time|\botp\b|\b[2m]fa\b|\bssn\b|social security|card number|\bcvv\b|\bcvc\b|\bpin\b|passport|api[-_ ]?key|secret|\btoken\b/i;
const URL_RX = /https?:\/\/|www\./i;
const HTTPS = /^https:\/\/[^\s/]+\.[^\s/]+\S*$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (s: string, multi = false) => (multi ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ")).trim();

class V {
  errors: string[] = [];
  trusted = false;
  constructor(private records: boolean, private now: number | null = null) {}
  err(path: string, why: string) { this.errors.push(`${path}: ${why}`); }
  obj(v: unknown, path: string): Record<string, any> { if (!isObj(v)) { this.err(path, "must be an object"); return {}; } return v; }
  str(v: unknown, path: string, o: { max?: number; opt?: boolean; multi?: boolean; fact?: boolean; links?: boolean; templ?: boolean } = {}): string | undefined {
    if (v === undefined || v === null) { if (!o.opt) this.err(path, "is required"); return undefined; }
    if (typeof v !== "string") { this.err(path, "must be text"); return undefined; }
    const t = clean(v, o.multi);
    if (!t) { if (!o.opt) this.err(path, "is empty; omit what you do not know"); else this.err(path, "is empty; omit the field instead"); return undefined; }
    if (o.fact && isPlaceholder(t)) { this.err(path, `"${t}" is a placeholder; unknown values are omitted, not written`); return undefined; }
    if (t.length > (o.max ?? 400)) { this.err(path, `is over ${o.max ?? 400} characters`); return undefined; }
    if (!o.templ && TEMPLATE.test(fold(t))) { this.err(path, "contains a template token like [Your Name]; write the real text or leave it out"); return undefined; }
    if (SPOOF.test(fold(t).replace(/\s+/g, " "))) { this.err(path, "contains text that looks like a source label; the label goes in the source field only"); return undefined; }
    if (o.links === false && URL_RX.test(t)) { this.err(path, "must not contain links"); return undefined; }
    return t;
  }
  one<T extends string>(v: unknown, path: string, set: readonly T[], opt = false): T | undefined {
    if (v === undefined && opt) return undefined;
    if (typeof v !== "string" || !set.includes(v as T)) { this.err(path, `must be one of: ${set.join(", ")}`); return undefined; }
    return v as T;
  }
  src(v: unknown, path: string, records = this.records): Source | undefined {
    const ok = typeof v === "string" && ((SOURCES as readonly string[]).includes(v) || (records && v === RECORDS));
    if (!ok) { this.err(path, `source is missing or not one of: ${[...SOURCES, ...(records ? [RECORDS] : [])].join(" / ")}. A fact without a source is not accepted`); return undefined; }
    return v as Source;
  }
  list(v: unknown, path: string, min: number, max: number): any[] {
    if (!Array.isArray(v)) { this.err(path, "must be a list"); return []; }
    if (v.length < min || v.length > max) this.err(path, `needs ${min === max ? min : `${min} to ${max}`} item(s), has ${v.length}`);
    return v.slice(0, max);
  }
  https(v: unknown, path: string, opt = true): string | undefined {
    if (v === undefined && opt) return undefined;
    if (typeof v !== "string" || !HTTPS.test(v.trim()) || v.length > 500) { this.err(path, "must be an https link"); return undefined; }
    return v.trim();
  }
  time(v: unknown, path: string, opt = true): string | undefined {
    if (v === undefined && opt) return undefined;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) { this.err(path, "must be a date-time such as 2026-10-28T10:00:00Z"); return undefined; }
    if (this.now !== null && Date.parse(v) > this.now + 60_000) { this.err(path, "is in the future"); return undefined; }
    return new Date(Date.parse(v)).toISOString();
  }
  // A sourced fact: label + value + source.
  fact(v: unknown, path: string, o: { valueKey?: string; labelKey?: string | null; records?: boolean } = {}) {
    const x = this.obj(v, path), vk = o.valueKey ?? "value", lk = o.labelKey === undefined ? "label" : o.labelKey;
    const label = lk ? this.str(x[lk], `${path}.${lk}`, { max: 80 }) : undefined;
    if (label && SECRETISH.test(label)) this.err(`${path}.${lk}`, "a password, code or ID number never goes in a file");
    const value = this.str(x[vk], `${path}.${vk}`, { max: 600, fact: true });
    const source = this.src(x.source, `${path}.source`, o.records ?? this.records);
    return { ...(lk ? { [lk]: label } : {}), [vk]: value, source };
  }
}

// ---------------------------------------------------------------- schemas (validate -> cleaned data)
const KINDS: Record<Exclude<KindId, "job_list">, (raw: unknown, v: V) => any> = {
  introduction(raw, v) {
    const x = v.obj(raw, "data"), p = v.obj(x.person, "person"), m = v.obj(x.message, "message");
    const why = v.list(x.why, "why", 3, 3).map((b, i) => { const f = v.fact(b, `why[${i}]`, { valueKey: "text", labelKey: null }); if (f.source === "Reported, not verified") v.err(`why[${i}].source`, "relevance bullets come from confirmed facts only (the posting, your resume, or what you said)"); return f; });
    return { title: v.str(x.title, "title", { max: 80 }), person: { name: v.str(p.name, "person.name", { max: 80, fact: true }), role: v.str(p.role, "person.role", { max: 100, opt: true, fact: true }), company: v.str(p.company, "person.company", { max: 100, opt: true, fact: true }), source: v.src(p.source, "person.source") },
      why, message: { channel: v.one(m.channel, "message.channel", ["email", "text"] as const), to: v.str(m.to, "message.to", { max: 120, opt: true }), subject: v.str(m.subject, "message.subject", { max: 120, opt: true, links: false }), body: v.str(m.body, "message.body", { max: 1200, multi: true, links: false }) } };
  },
  application_proof(raw, v) {
    const x = v.obj(raw, "data");
    // The model names the application; code reads the record. Company, role, status, dates and confirmation are never model-written.
    if (!v.trusted) {
      const extra = Object.keys(x).filter((k) => k !== "application_id");
      if (extra.length) v.err("data", `only application_id is accepted (${extra.slice(0, 4).join(", ")} come from the application record, not from you)`);
      return { application_id: v.str(x.application_id, "application_id", { max: 200 }) };
    }
    const status = v.one(x.status, "status", ["queued", "prepared", "submitted", "confirmed", "failed"] as const);
    const c = x.confirmation === undefined ? null : v.obj(x.confirmation, "confirmation");
    const conf = c ? { id: v.str(c.id, "confirmation.id", { max: 120, opt: true }), url: v.https(c.url, "confirmation.url"), screenshot_url: v.https(c.screenshot_url, "confirmation.screenshot_url") } : null;
    const answers = v.list(x.answers ?? [], "answers", 0, 30).map((a, i) => { const f = v.fact(a, `answers[${i}]`, { valueKey: "answer", labelKey: "question" }); return f; });
    const problems = v.list(x.problems ?? [], "problems", 0, 20).map((p, i) => { const q = v.obj(p, `problems[${i}]`); return { item: v.str(q.item, `problems[${i}].item`, { max: 120 }), outcome: v.one(q.outcome, `problems[${i}].outcome`, ["failed", "skipped"] as const), reason: v.str(q.reason, `problems[${i}].reason`, { max: 300 }) }; });
    const submitted_at = v.time(x.submitted_at, "submitted_at"), prepared_at = v.time(x.prepared_at, "prepared_at"), as_of = v.time(x.as_of, "as_of", false);
    const has = !!(conf && (conf.id || conf.url || conf.screenshot_url));
    if (status === "queued" || status === "prepared") { if (submitted_at || has) v.err("status", `${status} cannot carry a submit time or a confirmation: nothing was submitted`); }
    // A row has no submit time, so code-built data carries none and the page says "Last updated"; a hand-made one must give it.
    if (status === "submitted" && !submitted_at && !v.trusted) v.err("submitted_at", "submitted needs the time it was submitted");
    if (status === "confirmed") { if (!submitted_at && !v.trusted) v.err("submitted_at", "confirmed needs the time it was submitted"); if (!has) v.err("confirmation", "confirmed needs a confirmation id or link from the employer"); }
    if (status === "failed" && !problems.some((p) => p.outcome === "failed")) v.err("problems", "failed needs at least one failed item with its reason");
    return { from_record: true, title: v.str(x.title, "title", { max: 80 }), company: v.str(x.company, "company", { max: 100 }), role: v.str(x.role, "role", { max: 120, opt: true }), destination: v.str(x.destination, "destination", { max: 120, opt: true }), status, prepared_at, submitted_at, as_of,
      ...(has ? { confirmation: { id: conf!.id, url: conf!.url, screenshot_url: conf!.screenshot_url } } : {}), resume: v.str(x.resume, "resume", { max: 100, opt: true }), answers, problems };
  },
  plan_review(raw, v) {
    const x = v.obj(raw, "data");
    const sections = v.list(x.sections, "sections", 1, 8).map((s, i) => { const q = v.obj(s, `sections[${i}]`); return { heading: v.str(q.heading, `sections[${i}].heading`, { max: 80 }), items: v.list(q.items, `sections[${i}].items`, 1, 12).map((f, j) => v.fact(f, `sections[${i}].items[${j}]`)) }; });
    return { title: v.str(x.title, "title", { max: 80 }), variant: v.one(x.variant, "variant", ["pipeline", "interview_prep"] as const), period: v.str(x.period, "period", { max: 60, opt: true }), sections };
  },
  comparison(raw, v) {
    const x = v.obj(raw, "data"), options = v.list(x.options, "options", 2, 4).map((o, i) => ({ name: v.str(v.obj(o, `options[${i}]`).name, `options[${i}].name`, { max: 80 }) }));
    const rows = v.list(x.rows, "rows", 1, 12).map((r, i) => {
      const q = v.obj(r, `rows[${i}]`), cells = v.list(q.cells, `rows[${i}].cells`, options.length, options.length).map((c, j) => c === null ? null : v.fact(c, `rows[${i}].cells[${j}]`, { labelKey: null }));
      if (cells.length && cells.every((c) => c === null)) v.err(`rows[${i}]`, "nothing is known for any option; leave the row out");
      return { label: v.str(q.label, `rows[${i}].label`, { max: 80 }), cells };
    });
    return { title: v.str(x.title, "title", { max: 80 }), options, rows };
  },
  draft(raw, v) {
    const x = v.obj(raw, "data");
    return { title: v.str(x.title, "title", { max: 80 }), type: v.one(x.type, "type", ["email", "cover_letter", "message"] as const), to: v.str(x.to, "to", { max: 120, opt: true }), subject: v.str(x.subject, "subject", { max: 140, opt: true, templ: true }),
      body: v.str(x.body, "body", { max: 4000, multi: true, templ: true }), basis: v.list(x.basis ?? [], "basis", 0, 10).map((f, i) => v.fact(f, `basis[${i}]`)) };
  },
  research_brief(raw, v) {
    const x = v.obj(raw, "data");
    return { title: v.str(x.title, "title", { max: 80 }), subject: v.str(x.subject, "subject", { max: 120 }), findings: v.list(x.findings, "findings", 1, 12).map((f, i) => v.fact(f, `findings[${i}]`)),
      sources: v.list(x.sources, "sources", 1, 10).map((s, i) => { const q = v.obj(s, `sources[${i}]`); return { title: v.str(q.title, `sources[${i}].title`, { max: 120 }), url: v.https(q.url, `sources[${i}].url`, false) }; }) };
  },
};
// The Trainee-records label is for the kinds that report Trainee's own records.
const RECORDS_OK = new Set<string>(["application_proof"]); // and only for data built by code from a record (trusted)

export function validateKind(kind: string, raw: unknown, o: { trusted?: boolean; now?: number } = {}): Validated {
  if (kind === "job_list") return { ok: false, errors: ["job_list is created by the job search, not by create_file"] };
  const fn = (KINDS as Record<string, (r: unknown, v: V) => any>)[kind];
  if (!fn) return { ok: false, errors: [`unknown kind "${kind}"; use one of: ${MODEL_KINDS.join(", ")}`] };
  if (!isObj(raw)) return { ok: false, errors: ["data: must be an object"] };
  const v = new V(!!o.trusted && RECORDS_OK.has(kind), o.now ?? null);
  v.trusted = !!o.trusted;
  let data: any;
  try { data = fn(raw, v); } catch (e) { return { ok: false, errors: [`data: could not be read (${e instanceof Error ? e.message : String(e)})`] }; }
  if (!v.errors.length && JSON.stringify(data).length > 24_000) v.err("data", "is over 24 KB");
  return v.errors.length ? { ok: false, errors: v.errors.slice(0, 12) } : { ok: true, data: JSON.parse(JSON.stringify(data)) };
}

// The hash an Introduce tap is bound to: the person and the exact message.
export async function tagOf(kind: string, data: any): Promise<string | null> {
  if (kind !== "introduction") return null;
  const b = new TextEncoder().encode(JSON.stringify({ p: data?.person?.name, m: data?.message }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ---------------------------------------------------------------- render helpers (a stored fact with no valid source is skipped)
const hasSrc = (f: any, records = false) => !!f && typeof f.source === "string" && ((SOURCES as readonly string[]).includes(f.source) || (records && f.source === RECORDS)) && typeof (f.value ?? f.text ?? f.answer) === "string" && !!String(f.value ?? f.text ?? f.answer).trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (t: string | number | null | undefined) => { const n = typeof t === "number" ? t : Date.parse(String(t ?? "")); if (Number.isNaN(n)) return ""; const d = new Date(n); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`; };
const Fs = (xs: any[] | undefined, records = false) => (xs ?? []).filter((f) => hasSrc(f, records));
const src = (s: string) => `<span class="src">${esc(s)}</span>`;
const factHtml = (f: any, label?: string) => `<div class="fact">${label ? `<dt>${esc(label)}</dt>` : ""}<dd>${esc(f.value ?? f.text ?? f.answer)} ${src(f.source)}</dd></div>`;
const factText = (f: any, label?: string) => `- ${label ? `${label}: ` : ""}${f.value ?? f.text ?? f.answer} [${f.source}]`;
const sec = (h: string, inner: string) => inner ? `<section class="blk"><h2>${esc(h)}</h2>${inner}</section>` : "";
const dl = (xs: string) => xs ? `<dl class="facts">${xs}</dl>` : "";
const linkHtml = (u: string | undefined, text: string) => u && HTTPS.test(u) ? `<a href="${esc(u)}" rel="noopener noreferrer">${esc(text)}</a>` : "";
const STATUS_NOTE: Record<string, string> = { queued: "Queued. Nothing has been submitted yet.", prepared: "Prepared. Nothing has been submitted yet.", submitted: "Submitted. The employer hasn't confirmed it.", confirmed: "Confirmed by the employer.", failed: "Failed. It was not submitted." };

// ---------------------------------------------------------------- actions: what each kind offers, in what state
export function actionsOf(rec: FileRecord): ActionView[] {
  const st = rec.state ?? {};
  if (rec.kind === "introduction") {
    const c = st.choice as string | undefined;
    const intro: ActionView = c === "introduced" ? { id: "introduce", label: "Introduce", state: "done", note: "Approved and sent." }
      : c === "approved" ? { id: "introduce", label: "Introduce", state: "approved_not_sent", note: `Approved. Not sent: ${String(st.reason ?? "sending isn't switched on yet").replace(/[.\s]+$/, "")}.` }
      : c === "passed" ? { id: "introduce", label: "Introduce", state: "unavailable", note: "You passed on this one." }
      : { id: "introduce", label: "Introduce", state: "available", note: "Approves exactly this message. Nothing is sent before you tap it." };
    const pass: ActionView = c === "passed" ? { id: "pass", label: "Pass", state: "done", note: "You passed. Nothing was sent." }
      : c ? { id: "pass", label: "Pass", state: "unavailable", note: "Already decided." } : { id: "pass", label: "Pass", state: "available", note: "Skips this introduction. Nothing is sent." };
    return [pass, intro];
  }
  if (rec.kind === "application_proof") {
    const flags = Array.isArray(st.flags) ? st.flags.length : 0;
    return [{ id: "status", label: "View status", state: "available", note: `Shows what is recorded as of ${when(rec.data?.as_of)}.` },
      { id: "flag", label: "Flag a problem", state: "available", note: flags ? `${flags} flagged.` : "Saves your note on this file." }];
  }
  if (rec.kind === "draft") return [{ id: "copy", label: "Copy", state: "available", note: "Copies the text as it is in the box. Edits stay on this page." }];
  return [];
}

export interface ActResult { ok: boolean; status: number; note: string; patch?: Record<string, unknown> }
export interface Effects { introduce?(userId: string, rec: FileRecord): Promise<{ ok: boolean; reason?: string }> }
// One tap. Returns the note to show and the state to keep; never throws for a refused tap.
// `persist` stores a state patch at once: the approval is written BEFORE any send is attempted, so a crash or a second tap can never send twice.
// `claim` is the atomic, once-only decision (insert-if-absent in the store): the first caller gets true, every other tap false.
export async function actOn(rec: FileRecord, action: string, form: URLSearchParams, now: number, fx: Effects = {}, persist?: (patch: Record<string, unknown>) => Promise<void>, claim?: () => Promise<boolean>): Promise<ActResult> {
  const views = actionsOf(rec), view = views.find((a) => a.id === action);
  if (!view || action === "copy") return { ok: false, status: 400, note: "That is not something this file can do. Nothing was sent." };
  if (rec.kind === "introduction") {
    if (view.state !== "available") return { ok: false, status: 200, note: view.note ?? "Already decided." };
    const decided = { ok: false, status: 200, note: "Already decided. Nothing more was sent." };
    if (action === "pass") { if (claim && !(await claim())) return decided; return { ok: true, status: 200, note: "Passed. Nothing was sent.", patch: { choice: "passed", at: now } }; }
    const tag = form.get("tag") ?? "";
    if (!/^[0-9a-f]{16}$/.test(tag) || tag !== rec.tag || tag !== await tagOf(rec.kind, rec.data)) return { ok: false, status: 200, note: "Changed since you opened this page, so nothing was sent." };
    if (claim && !(await claim())) return decided; // two taps at once: only the first goes on
    await persist?.({ choice: "approved", at: now, tag });
    if (!fx.introduce) return { ok: true, status: 200, note: "Approved. Not sent: sending isn't switched on yet.", patch: { choice: "approved", at: now, tag } };
    const r = await fx.introduce(rec.userId, rec).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : "failed" }));
    if (r.ok) return { ok: true, status: 200, note: "Approved and sent.", patch: { choice: "introduced", at: now, sent_at: now, tag } };
    const reason = String(r.reason ?? "it could not be sent").replace(/[.\s]+$/, "").slice(0, 140);
    return { ok: true, status: 200, note: `Approved. Not sent: ${reason}.`, patch: { choice: "approved", at: now, tag, reason } };
  }
  if (action === "status") return { ok: true, status: 200, note: `Status as recorded on ${when(rec.data?.as_of)}: ${cap1(String(rec.data?.status))}.` };
  const note = clean(form.get("note") ?? "").slice(0, 500);
  if (!note) return { ok: false, status: 200, note: "Write what looks wrong in the note box, then tap Flag a problem." };
  const flags = [...(Array.isArray(rec.state?.flags) ? rec.state.flags : []), { at: now, note }].slice(-10);
  return { ok: true, status: 200, note: "Flagged. Your note is saved on this file.", patch: { flags } };
}

// ---------------------------------------------------------------- bodies (html)
export const COPY_SCRIPT = `(function(){document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;var t=document.getElementById("draft-body"),s=document.getElementById("copy-status");if(!t)return;var done=function(m){if(s)s.textContent=m};t.select();if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value).then(function(){done("Copied.")},function(){done("Couldn't copy. Select the text and copy it.")})}else{try{done(document.execCommand("copy")?"Copied.":"Couldn't copy. Select the text and copy it.")}catch(x){done("Couldn't copy. Select the text and copy it.")}}})})();`;
const hidden = (token: string, action: string, extra = "") => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}">${extra}`;

const STATE_WORD = { available: "available", done: "done", unavailable: "not available", approved_not_sent: "approved, not sent" } as const;
function actionsHtml(rec: FileRecord, token: string): string {
  const vs = actionsOf(rec);
  if (!vs.length) return "";
  const out = vs.map((a) => {
    const note = a.note ? `<p class="anote">${esc(a.note)}</p>` : "";
    if (a.id === "copy") return `<div class="act1"><button type="button" class="btn" data-copy>Copy</button><span id="copy-status" role="status"></span>${note}</div>`;
    if (a.state !== "available") return `<div class="act1"><span class="btn off" role="status">${esc(a.label)}: ${STATE_WORD[a.state]}</span>${note}</div>`;
    if (a.id === "flag") return `<form method="post" class="ajax act1">${hidden(token, "flag")}<label for="flag-note">What looks wrong</label><textarea id="flag-note" name="note" rows="3" maxlength="500"></textarea><button type="submit" class="btn">Flag a problem</button>${note}</form>`;
    const extra = a.id === "introduce" ? `<input type="hidden" name="tag" value="${esc(rec.tag ?? "")}">` : "";
    return `<form method="post" class="ajax act1">${hidden(token, a.id, extra)}<button type="submit" class="btn${a.id === "pass" ? " ghost" : ""}">${esc(a.label)}</button>${note}</form>`;
  }).join("");
  return `<section class="blk" aria-label="Actions"><h2>Actions</h2>${out}</section>`;
}

// o.tz: the person's zone for times on the page; o.evidenceImage: whether a screenshot URL may be shown inline (its origin is one the
// page's Content-Security-Policy allows); otherwise it is a link.
export function bodyHtml(rec: FileRecord, token: string, o: { tz?: string | null; evidenceImage?: (url: string) => boolean } = {}): string {
  const d = rec.data ?? {};
  let main = "";
  switch (rec.kind) {
    case "introduction": {
      const p = d.person ?? {}, m = d.message ?? {};
      main = sec("Who", dl(`<div class="fact"><dt>${esc(p.name)}</dt><dd>${esc([p.role, p.company].filter(Boolean).join(", "))} ${hasSrc({ ...p, value: p.name }) ? src(p.source) : ""}</dd></div>`))
        + sec("Why this person", `<ul class="why">${Fs(d.why).map((b) => `<li>${esc(b.text)} ${src(b.source)}</li>`).join("")}</ul>`)
        + sec("The exact message", `<p class="meta">${esc([m.channel === "email" ? "By email" : "By text", m.to ? `to ${m.to}` : ""].filter(Boolean).join(" "))}</p>${m.subject ? `<p class="meta">Subject: ${esc(m.subject)}</p>` : ""}<blockquote class="msg">${esc(m.body)}</blockquote><p class="meta">Approval code ${esc(rec.tag ?? "")}</p>`);
      break;
    }
    case "application_proof": {
      const c = d.confirmation ?? {};
      const kv = (k: string, v: unknown, s: Source = RECORDS) => v ? factHtml({ value: String(v), source: s }, k) : "";
      main = `<p class="state ${esc(d.status)}" role="status"><strong>${esc(cap1(d.status))}.</strong> ${esc(STATUS_NOTE[d.status] ?? "")}</p>`
        + sec("What was submitted", dl(kv("Company", d.company) + kv("Role", d.role) + kv("Sent to", d.destination) + kv("Resume", d.resume) + kv("Prepared", when(d.prepared_at)) + kv("Submitted", when(d.submitted_at)) + kv("Last updated", when(d.as_of))))
        // The proof rides with the claim (brief P3.7, P6.6): the confirmation as a receipt (its snippet, where it came from and when,
        // the link, and the screenshot inline when the page may show it). Without one, "Not confirmed yet" is the value, said.
        + sec("Confirmation", (c.id || c.url || c.screenshot_url)
          ? evidenceHtml({ quote: c.id ? `Confirmation ID: ${c.id}` : "The employer's confirmation page", source: RECORDS, at: d.submitted_at ?? d.as_of ?? null, href: c.url, hrefLabel: "Open the confirmation",
            image: o.evidenceImage?.(c.screenshot_url) ? c.screenshot_url : null, imageAlt: `${d.company ?? "The employer"}'s confirmation screen` }, o.tz)
            + (c.screenshot_url && !o.evidenceImage?.(c.screenshot_url) ? `<p>${linkHtml(c.screenshot_url, "Open the screenshot")}</p>` : "")
          : d.status === "submitted" || d.status === "confirmed" ? `<p class="meta">${valueHtml(unknown(UNKNOWN.notConfirmed))} The employer hasn't sent a confirmation Trainee can show.</p>` : "")
        + sec("Answers given", dl(Fs(d.answers, true).map((a) => factHtml(a, a.question)).join("")))
        + sec("Not done", `<ul class="why">${(d.problems ?? []).filter((p: any) => p?.reason).map((p: any) => `<li><strong>${esc(cap1(p.outcome))}:</strong> ${esc(p.item)}. ${esc(p.reason)} ${src(RECORDS)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""))

        + sec("Flagged by you", `<ul class="why">${(Array.isArray(rec.state?.flags) ? rec.state.flags : []).map((f: any) => `<li>${esc(when(f.at))}: ${esc(f.note)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""));
      break;
    }
    case "plan_review":
      main = (d.period ? `<p class="meta">${esc(d.period)}</p>` : "") + (d.sections ?? []).map((s: any) => sec(s.heading, dl(Fs(s.items).map((f) => factHtml(f, f.label)).join("")))).join("");
      break;
    case "comparison": {
      const opts = (d.options ?? []).map((o: any) => o.name);
      const cell = (c: any) => hasSrc(c) ? `${esc(c.value)}<br>${src(c.source)}` : `<span class="meta">Not stated</span>`;
      main = `<div class="tbl" tabindex="0" role="region" aria-label="Comparison table"><table><caption class="sr">${esc(d.title)}</caption><thead><tr><th scope="col"><span class="sr">Item</span></th>${opts.map((n: string) => `<th scope="col">${esc(n)}</th>`).join("")}</tr></thead><tbody>${(d.rows ?? []).map((r: any) => `<tr><th scope="row">${esc(r.label)}</th>${(r.cells ?? []).map((c: any) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      break;
    }
    case "draft":
      main = `<p class="meta">${esc([cap1(String(d.type).replace("_", " ")), d.to ? `to ${d.to}` : ""].filter(Boolean).join(" "))}</p>${d.subject ? `<p class="meta">Subject: ${esc(d.subject)}</p>` : ""}<label for="draft-body" class="lbl">Edit the text here. Edits stay on this page.</label><textarea id="draft-body" class="draft" rows="14">${esc(d.body)}</textarea>`
        + sec("What it says about you", dl(Fs(d.basis).map((f) => factHtml(f, f.label)).join("")))
        + `<p class="meta">This page cannot send it. To send it, ask Trainee in Telegram; you approve the exact message first.</p>`;
      break;
    case "research_brief":
      main = sec(`What we found about ${d.subject ?? ""}`, dl(Fs(d.findings).map((f) => factHtml(f, f.label)).join("")))
        + sec("Sources", `<ul class="why">${(d.sources ?? []).map((s: any) => `<li>${linkHtml(s.url, s.title) || esc(s.title)}</li>`).join("")}</ul>`);
      break;
  }
  return `${main}${actionsHtml(rec, token)}`;
}

// ---------------------------------------------------------------- plain-text twin (also the .md that can be attached)
export function textOf(rec: FileRecord, o: { now: number; url?: string }): string {
  const d = rec.data ?? {}, L: string[] = [`# ${d.title ?? KIND_LABEL[rec.kind]}`, `${KIND_LABEL[rec.kind]}. Expires ${when(rec.expires_at)}.`, ""];
  const h = (t: string) => L.push(`## ${t}`);
  switch (rec.kind) {
    case "introduction": {
      const p = d.person ?? {}, m = d.message ?? {};
      h("Who"); L.push(`- ${p.name}${[p.role, p.company].filter(Boolean).length ? `, ${[p.role, p.company].filter(Boolean).join(", ")}` : ""} [${p.source}]`, "");
      h("Why this person"); Fs(d.why).forEach((b) => L.push(factText(b))); L.push("");
      h("The exact message"); L.push(`${m.channel === "email" ? "By email" : "By text"}${m.to ? ` to ${m.to}` : ""}`); if (m.subject) L.push(`Subject: ${m.subject}`); L.push("", m.body, "", `Approval code: ${rec.tag}`, "");
      break;
    }
    case "application_proof": {
      const c = d.confirmation ?? {};
      L.push(`Status: ${cap1(d.status)}. ${STATUS_NOTE[d.status] ?? ""}`, "");
      h("What was submitted"); L.push(`- Company: ${d.company} [${RECORDS}]`);
      if (d.role) L.push(`- Role: ${d.role} [${RECORDS}]`);
      for (const [k, v] of [["Sent to", d.destination], ["Resume", d.resume], ["Prepared", when(d.prepared_at)], ["Submitted", when(d.submitted_at)], ["Last updated", when(d.as_of)]]) if (v) L.push(`- ${k}: ${v} [${RECORDS}]`);
      L.push(""); if (c.id || c.url || c.screenshot_url) { h("Confirmation"); if (c.id) L.push(`- Confirmation ID: ${c.id} [${RECORDS}]`); if (c.url) L.push(`- Confirmation: ${c.url}`); if (c.screenshot_url) L.push(`- Screenshot: ${c.screenshot_url}`); L.push(""); }
      if (Fs(d.answers, true).length) { h("Answers given"); Fs(d.answers, true).forEach((a) => L.push(factText(a, a.question))); L.push(""); }
      const pr = (d.problems ?? []).filter((p: any) => p?.reason); if (pr.length) { h("Not done"); pr.forEach((p: any) => L.push(`- ${cap1(p.outcome)}: ${p.item}. ${p.reason} [${RECORDS}]`)); L.push(""); }
      const fl = Array.isArray(rec.state?.flags) ? rec.state.flags : []; if (fl.length) { h("Flagged by you"); fl.forEach((f: any) => L.push(`- ${when(f.at)}: ${f.note}`)); L.push(""); }
      break;
    }
    case "plan_review":
      if (d.period) L.push(d.period, "");
      for (const s of d.sections ?? []) { h(s.heading); Fs(s.items).forEach((f) => L.push(factText(f, f.label))); L.push(""); }
      break;
    case "comparison": {
      const opts = (d.options ?? []).map((o: any) => o.name);
      (d.rows ?? []).forEach((r: any) => { h(r.label); (r.cells ?? []).forEach((c: any, i: number) => L.push(hasSrc(c) ? factText(c, opts[i]) : `- ${opts[i]}: Not stated`)); L.push(""); });
      break;
    }
    case "draft":
      L.push(`${cap1(String(d.type).replace("_", " "))}${d.to ? ` to ${d.to}` : ""}`); if (d.subject) L.push(`Subject: ${d.subject}`); L.push("", d.body, "");
      if (Fs(d.basis).length) { h("What it says about you"); Fs(d.basis).forEach((f) => L.push(factText(f, f.label))); L.push(""); }
      L.push("Sending: not from this file. Ask Trainee in Telegram; you approve the exact message first.", "");
      break;
    case "research_brief":
      h(`What we found about ${d.subject}`); Fs(d.findings).forEach((f) => L.push(factText(f, f.label))); L.push("");
      h("Sources"); (d.sources ?? []).forEach((s: any) => L.push(`- ${s.title}: ${s.url}`)); L.push("");
      break;
  }
  const acts = actionsOf(rec);
  if (acts.length) { h("Actions"); acts.forEach((a) => L.push(`- ${a.label}: ${STATE_WORD[a.state]}${a.note ? `. ${a.note}` : ""}`)); L.push(""); }
  if (o.url) L.push(`Open the page: ${o.url}`);
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export const KIND_CSS = `
.eyebrow{margin:0 0 4px;font-size:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
.blk{padding:18px 0;border-top:1px solid var(--line)}.blk h2{margin:0 0 8px;font-size:17px;font-weight:600}
dl.facts{margin:0}.fact{margin:0 0 10px}.fact dt{font-size:15px;color:var(--mute)}.fact dd{margin:0;overflow-wrap:anywhere}
.src{display:inline-block;margin-left:4px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--mute);white-space:nowrap}
ul.why{margin:0;padding-left:20px}ul.why li{margin:0 0 8px;overflow-wrap:anywhere}
.msg{margin:8px 0;padding:12px 14px;border-left:3px solid var(--accent);background:transparent;white-space:pre-wrap;overflow-wrap:anywhere}
.meta{margin:2px 0;font-size:15px;color:var(--mute)}.state{margin:0 0 8px;font-size:18px}.state.failed{color:var(--bad)}.state.confirmed,.state.submitted{color:var(--good)}
.note-top{margin:8px 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:10px}
.tbl{overflow-x:auto}.tbl:focus-visible{outline:3px solid var(--accent)}table{border-collapse:collapse;width:100%;font-size:16px}th,td{padding:10px 8px;border-top:1px solid var(--line);text-align:left;vertical-align:top}thead th{border-top:0;font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.act1{margin:0 0 14px}.anote{margin:4px 0 0;font-size:15px;color:var(--mute)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-width:96px;min-height:48px;padding:6px 20px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}.btn:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.ghost{background:transparent;color:var(--link)}.btn.off{background:transparent;color:var(--mute);border-color:var(--line);cursor:default}
label,.lbl{display:block;margin:8px 0 4px;font-size:15px;color:var(--mute)}
textarea{width:100%;min-height:96px;padding:10px 12px;border:1px solid var(--mute);border-radius:10px;background:transparent;color:var(--ink);font:inherit;font-size:16px}textarea.draft{min-height:240px}
.foot{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:15px;color:var(--mute)}.foot a{color:var(--link)}
`;
