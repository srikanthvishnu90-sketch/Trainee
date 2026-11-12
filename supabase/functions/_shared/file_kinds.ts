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
import { type Stage, STAGE_LABEL, STAGE_NOTE } from "./application_review.ts";

export const SOURCES = ["From the posting", "From your resume", "From you", "Reported, not verified"] as const;
export type Source = typeof SOURCES[number] | "From Trainee's records" | "Made by Trainee";
// Counts and statuses that Trainee itself recorded (applications, interviews). Allowed on plan reviews and application proofs only.
const RECORDS: Source = "From Trainee's records";
// BETA C03 (2026-11-04): what Trainee itself wrote on a page code built (an interview prep File's practice questions, its timed plan
// and its "not on file" lines; career-prep 127 prepFileData). It says plainly that the line is not a fact about the person or a company.
// Accepted only on trusted (code-built) plan reviews: a model's create_file can never label its own text this way.
export const MADE: Source = "Made by Trainee";
const MADE_OK = new Set<string>(["plan_review"]);
export const RESUME_B64_MAX = 400_000; // about 290 KB of PDF
export const KIND_IDS = ["job_list", "introduction", "application_proof", "application_review", "plan_review", "comparison", "draft", "research_brief", "tracker"] as const;
export type KindId = typeof KIND_IDS[number];
export const KIND_LABEL: Record<KindId, string> = { job_list: "Your jobs", introduction: "Introduction", application_proof: "Application proof", application_review: "Application review", plan_review: "Plan review", comparison: "Comparison", draft: "Draft", research_brief: "Research brief", tracker: "Application tracker" };
// WO-G: the application review (spec C.11 F-09) is built by code from a prepared application only, never by a model.
// D-062 (MIRROR-PROCESS C16): the application tracker is built by code from the person's records and Gmail confirmations only
// (_shared/career_application_record.ts trackerData, the export_tracker tool), never by a model.
export const MODEL_KINDS = KIND_IDS.filter((k) => k !== "job_list" && k !== "application_review" && k !== "tracker");

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
  constructor(private records: boolean, private now: number | null = null, private made = false) {}
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
    const ok = typeof v === "string" && ((SOURCES as readonly string[]).includes(v) || (records && v === RECORDS) || (this.made && v === MADE));
    if (!ok) { this.err(path, `source is missing or not one of: ${[...SOURCES, ...(records ? [RECORDS] : []), ...(this.made ? [MADE] : [])].join(" / ")}. A fact without a source is not accepted`); return undefined; }
    return v as Source;
  }
  list(v: unknown, path: string, min: number, max: number): any[] {
    // D-071 (live-8 C1: "sections: must be a list", twice): the error says what came instead, so the model can fix that exactly.
    if (!Array.isArray(v)) { this.err(path, `must be a list (a JSON array), got ${v === undefined ? "nothing" : v === null ? "null" : typeof v === "string" ? "text" : typeof v === "object" ? "an object" : typeof v}`); return []; }
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

// WO-G (fixes 12, 13): code-built proofs carry the one visible stage (application_review.ts stageOf) and, for a prepared
// application, the review: what the approval covers, every answer word for word, every unresolved required question.
// Only code builds these (trusted): a model never writes a stage, an answer or a question here.
const STAGES = ["prepared", "approved", "sending", "uncertain", "submitted_unconfirmed", "employer_confirmed", "needs_you", "not_sent", "failed"] as const;
function stageAndReview(x: Record<string, any>, v: V) {
  if (!v.trusted) return {};
  const stage = v.one(x.stage, "stage", STAGES, true);
  if (stage === "employer_confirmed" && !x.confirmation && !x.email_confirmed_at) v.err("stage", "confirmed by the employer needs the employer's own evidence");
  const r = x.review === undefined ? null : v.obj(x.review, "review");
  const review = r ? {
    url: v.str(r.url, "review.url", { max: 500, opt: true }), letter: r.letter === true,
    ...(typeof r.expires_at === "string" && Number.isFinite(Date.parse(r.expires_at)) ? { expires_at: new Date(Date.parse(r.expires_at)).toISOString() } : {}), hash12: v.str(r.hash12, "review.hash12", { max: 12, opt: true }), approvable: r.approvable === true,
    files: v.list(r.files ?? [], "review.files", 0, 6).map((f, i) => v.str(f, `review.files[${i}]`, { max: 160 })),
    covers: v.list(r.covers ?? [], "review.covers", 0, 12).map((f, i) => v.str(f, `review.covers[${i}]`, { max: 600, templ: true })),
    answers: v.list(r.answers ?? [], "review.answers", 0, 40).map((a, i) => ({ question: v.str(a?.question, `review.answers[${i}].question`, { max: 200, templ: true }), answer: v.str(a?.answer, `review.answers[${i}].answer`, { max: 4000, multi: true, templ: true }), sensitive: a?.sensitive === true })),
    unresolved: v.list(r.unresolved ?? [], "review.unresolved", 0, 20).map((u, i) => ({ question: v.str(u?.question, `review.unresolved[${i}].question`, { max: 200, templ: true }), ask: v.str(u?.ask, `review.unresolved[${i}].ask`, { max: 600, templ: true }) })),
  } : null;
  if (review && review.approvable && review.unresolved.length) v.err("review", "an application with an unresolved required answer is never approvable");
  return { ...(stage ? { stage } : {}), ...(x.email_confirmed_at ? { email_confirmed_at: v.time(x.email_confirmed_at, "email_confirmed_at") } : {}), ...(review ? { review } : {}) };
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
    const status = v.one(x.status, "status", ["queued", "prepared", "submitted", "uncertain", "confirmed", "failed"] as const);
    const c = x.confirmation === undefined ? null : v.obj(x.confirmation, "confirmation");
    const conf = c ? { id: v.str(c.id, "confirmation.id", { max: 120, opt: true }), url: v.https(c.url, "confirmation.url"), screenshot_url: v.https(c.screenshot_url, "confirmation.screenshot_url") } : null;
    const answers = v.list(x.answers ?? [], "answers", 0, 30).map((a, i) => { const f = v.fact(a, `answers[${i}]`, { valueKey: "answer", labelKey: "question" }); return f; });
    const problems = v.list(x.problems ?? [], "problems", 0, 20).map((p, i) => { const q = v.obj(p, `problems[${i}]`); return { item: v.str(q.item, `problems[${i}].item`, { max: 120 }), outcome: v.one(q.outcome, `problems[${i}].outcome`, ["failed", "skipped"] as const), reason: v.str(q.reason, `problems[${i}].reason`, { max: 300 }) }; });
    const submitted_at = v.time(x.submitted_at, "submitted_at"), prepared_at = v.time(x.prepared_at, "prepared_at"), as_of = v.time(x.as_of, "as_of", false);
    const has = !!(conf && (conf.id || conf.url || conf.screenshot_url));
    if (status === "queued" || status === "prepared") { if (submitted_at || has) v.err("status", `${status} cannot carry a submit time or a confirmation: nothing was submitted`); }
    // A row has no submit time, so code-built data carries none and the page says "Last updated"; a hand-made one must give it.
    if (status === "submitted" && !submitted_at && !v.trusted) v.err("submitted_at", "submitted needs the time it was submitted");
    if (status === "confirmed") { if (!submitted_at && !v.trusted) v.err("submitted_at", "confirmed needs the time it was submitted"); if (!has && !(v.trusted && x.email_confirmed_at)) v.err("confirmation", "confirmed needs a confirmation id or link from the employer"); }
    if (status === "failed" && !problems.some((p) => p.outcome === "failed")) v.err("problems", "failed needs at least one failed item with its reason");
    return { from_record: true, title: v.str(x.title, "title", { max: 80 }), company: v.str(x.company, "company", { max: 100 }), role: v.str(x.role, "role", { max: 120, opt: true }), destination: v.str(x.destination, "destination", { max: 120, opt: true }), status, prepared_at, submitted_at, as_of,
      ...(has ? { confirmation: { id: conf!.id, url: conf!.url, screenshot_url: conf!.screenshot_url } } : {}), resume: v.str(x.resume, "resume", { max: 100, opt: true }), answers, problems,
      ...stageAndReview(x, v) };
  },
  application_review(raw, v) {
    const x = v.obj(raw, "data");
    if (!v.trusted || !x.review) { v.err("data", "an application review is built by Trainee from a prepared application only"); return {}; }
    return { from_prepared: true, title: v.str(x.title, "title", { max: 80 }), company: v.str(x.company, "company", { max: 100 }), role: v.str(x.role, "role", { max: 120, opt: true }),
      destination: v.str(x.destination, "destination", { max: 120, opt: true }), resume: v.str(x.resume, "resume", { max: 100, opt: true }), ids: v.str(x.ids, "ids", { max: 60, opt: true }),
      status: "prepared", prepared_at: v.time(x.prepared_at, "prepared_at"), as_of: v.time(x.as_of, "as_of", false), ...stageAndReview(x, v) };
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
    // R10 (privacy ruling): a resume file the resume task made, opened only on the signed-in File page (never a bearer link). Built by
    // code only: the model's create_file can never make one. The PDF rides the record; "Download PDF" returns it to its owner.
    if (x.variant === "resume") {
      if (!v.trusted) { v.err("variant", "a resume file is made by Trainee's resume task, not by create_file"); return {}; }
      const b64 = typeof x.pdf_b64 === "string" && /^[A-Za-z0-9+/]+=*$/.test(x.pdf_b64) && x.pdf_b64.length <= RESUME_B64_MAX ? x.pdf_b64 : (v.err("pdf_b64", `the PDF is larger than ${Math.round(RESUME_B64_MAX * 3 / 4 / 1024)} KB`), undefined);
      return { variant: "resume", title: v.str(x.title, "title", { max: 80 }), target: v.str(x.target, "target", { max: 120 }), filename: v.str(x.filename, "filename", { max: 120 }),
        review: x.review === true, note: v.str(x.note, "note", { max: 400, opt: true }), sha256: typeof x.sha256 === "string" && /^[0-9a-f]{64}$/.test(x.sha256) ? x.sha256 : (v.err("sha256", "must be the PDF's sha256"), undefined), pdf_b64: b64 };
    }
    return { title: v.str(x.title, "title", { max: 80 }), type: v.one(x.type, "type", ["email", "cover_letter", "message"] as const), to: v.str(x.to, "to", { max: 120, opt: true }), subject: v.str(x.subject, "subject", { max: 140, opt: true, templ: true }),
      body: v.str(x.body, "body", { max: 4000, multi: true, templ: true }), basis: v.list(x.basis ?? [], "basis", 0, 10).map((f, i) => v.fact(f, `basis[${i}]`)) };
  },
  // D-062 (C16): code-built only (trusted). Past applications with their evidence and dates, researched roles, unsubmitted drafts,
  // each with its status, and what the record covers (Gmail-based). Every value is read from a record; nothing is a model's.
  tracker(raw, v) {
    const x = v.obj(raw, "data");
    if (!v.trusted) { v.err("data", "an application tracker is built by Trainee from your records and Gmail confirmations, not by create_file"); return {}; }
    const day = (t: unknown, path: string) => (t === undefined ? {} : typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t) ? { [path]: t } : (v.err(path, "is a date like 2026-11-11"), {}));
    const applied = v.list(x.applied ?? [], "applied", 0, 60).map((r, i) => { const q = v.obj(r, `applied[${i}]`); const p = `applied[${i}]`;
      return { company: v.str(q.company, `${p}.company`, { max: 120, fact: true, links: false }), ...(q.role !== undefined ? { role: v.str(q.role, `${p}.role`, { max: 160, fact: true, links: false }) } : {}),
        ...day(q.applied_on, "applied_on"), status: v.str(q.status, `${p}.status`, { max: 120 }), source: v.one(q.source, `${p}.source`, ["employer email", "Trainee's submission record", "your word"] as const),
        evidence: v.list(q.evidence ?? [], `${p}.evidence`, 0, 6).map((e, j) => { const z = v.obj(e, `${p}.evidence[${j}]`); return { what: v.str(z.what, `${p}.evidence[${j}].what`, { max: 120 }), ...day(z.on, "on"), ...(z.text !== undefined ? { text: v.str(z.text, `${p}.evidence[${j}].text`, { max: 200, links: false }) } : {}) }; }) }; });
    const researched = v.list(x.researched ?? [], "researched", 0, 30).map((r, i) => { const q = v.obj(r, `researched[${i}]`); const p = `researched[${i}]`;
      return { company: v.str(q.company, `${p}.company`, { max: 120, fact: true, links: false }), ...(q.role !== undefined ? { role: v.str(q.role, `${p}.role`, { max: 160, fact: true, links: false }) } : {}),
        ...(q.url !== undefined ? { url: v.https(q.url, `${p}.url`) } : {}), status: v.str(q.status, `${p}.status`, { max: 80 }) }; });
    const drafts = v.list(x.drafts ?? [], "drafts", 0, 30).map((r, i) => { const q = v.obj(r, `drafts[${i}]`); const p = `drafts[${i}]`;
      return { ...(q.company !== undefined ? { company: v.str(q.company, `${p}.company`, { max: 120, links: false }) } : {}), what: v.str(q.what, `${p}.what`, { max: 120 }), status: v.str(q.status, `${p}.status`, { max: 120 }), ...day(q.since, "since") }; });
    return { title: v.str(x.title, "title", { max: 80 }), as_of: v.time(x.as_of, "as_of", false), applied, researched, drafts,
      coverage: v.list(x.coverage, "coverage", 1, 8).map((c, i) => v.str(c, `coverage[${i}]`, { max: 300 })),
      ...(x.changes !== undefined ? { changes: v.list(x.changes, "changes", 1, 10).map((c, i) => v.str(c, `changes[${i}]`, { max: 300 })) } : {}) };
  },
  research_brief(raw, v) {
    const x = v.obj(raw, "data");
    if (x.variant === "market") return marketBrief(x, v);
    if (x.variant === "company") return companyBrief(x, v);
    return { title: v.str(x.title, "title", { max: 80 }), subject: v.str(x.subject, "subject", { max: 120 }), findings: v.list(x.findings, "findings", 1, 12).map((f, i) => v.fact(f, `findings[${i}]`)),
      sources: v.list(x.sources, "sources", 1, 10).map((s, i) => { const q = v.obj(s, `sources[${i}]`); return { title: v.str(q.title, `sources[${i}].title`, { max: 120 }), url: v.https(q.url, `sources[${i}].url`, false) }; }) };
  },
};
// R10 WO-H fix 14 (2026-11-09): the company interview brief, a variant of research_brief (agent/research/company.ts builds it in code
// from guarded lines). Facts (business, dated developments, competitors, what the role page asks), Trainee's reading (the frame) and
// unknowns are separate blocks; every line names its numbered sources and every source is cited; a source may carry its limit
// (paywalled, outdated), which is shown beside each line citing it. Questions are code's sentence around a verified tension.
function companyBrief(x: Record<string, any>, v: V) {
  const sources = v.list(x.sources, "sources", 1, 12).map((s, i) => { const q = v.obj(s, `sources[${i}]`); return { title: v.str(q.title, `sources[${i}].title`, { max: 120, links: false }), url: v.https(q.url, `sources[${i}].url`, false),
    fetched_at: v.time(q.fetched_at, `sources[${i}].fetched_at`, false), by: v.one(q.by, `sources[${i}].by`, ["company", "reported"] as const), ...(q.limit !== undefined ? { limit: v.one(q.limit, `sources[${i}].limit`, ["paywalled", "outdated"] as const) } : {}),
    ...(q.dated !== undefined ? { dated: v.str(q.dated, `sources[${i}].dated`, { max: 20, links: false }) } : {}) }; });
  const n = sources.length, used = new Set<number>();
  const cite = (raw: unknown, path: string) => { const xs = v.list(raw, path, 1, 6), ok = xs.filter((i) => Number.isInteger(i) && i >= 1 && i <= n); if (ok.length !== xs.length) v.err(path, `each cite is a source number from 1 to ${n}`); ok.forEach((i) => used.add(i)); return [...new Set(ok as number[])]; };
  const text = (q: any, path: string, max = 400) => v.str(q.text, `${path}.text`, { max, links: false, fact: true });
  const lines = (raw: unknown, path: string, max: number, more: (q: any, p: string) => Record<string, unknown> = () => ({})) =>
    v.list(raw ?? [], path, 0, max).map((r, i) => { const q = v.obj(r, `${path}[${i}]`); return { ...more(q, `${path}[${i}]`), text: text(q, `${path}[${i}]`), cite: cite(q.cite, `${path}[${i}].cite`) }; });
  const out = { variant: "company", title: v.str(x.title, "title", { max: 80, links: false }), company: v.str(x.company, "company", { max: 80, links: false }),
    ...(x.role !== undefined ? { role: v.str(x.role, "role", { max: 80, links: false }) } : {}), ...(x.role_asked === true ? { role_asked: true } : {}),
    ...(x.focus !== undefined ? { focus: v.one(x.focus, "focus", ["business", "developments", "competitors", "role", "questions"] as const) } : {}),
    ...(x.audience !== undefined ? { audience: v.str(x.audience, "audience", { max: 40, links: false }) } : {}),
    ...(x.frame !== undefined ? { frame: (() => { const q = v.obj(x.frame, "frame"); return { text: text(q, "frame", 300), cite: cite(q.cite, "frame.cite") }; })() } : {}),
    business: lines(x.business, "business", 6, (q, p) => (q.product !== undefined ? { product: v.str(q.product, `${p}.product`, { max: 40, links: false }) } : {})), role_asks: lines(x.role_asks, "role_asks", 5),
    ...(x.products !== undefined ? { products: v.list(x.products, "products", 1, 3).map((r, i) => { const q = v.obj(r, `products[${i}]`); return { name: v.str(q.name, `products[${i}].name`, { max: 40, links: false }), angle: v.str(q.angle, `products[${i}].angle`, { max: 60, links: false }) }; }) } : {}),
    // The person's side, from their confirmed facts only (code-built, agent/research/company.ts): fact text, and the role lines it ties to.
    ...(x.project !== undefined ? { project: (() => { const q = v.obj(x.project, "project"); return { ties: v.list(q.ties ?? [], "project.ties", 0, 3).map((t, i) => { const z = v.obj(t, `project.ties[${i}]`);
      return { fact: v.str(z.fact, `project.ties[${i}].fact`, { max: 300, links: false }), ties: v.list(z.ties, `project.ties[${i}].ties`, 1, 2).map((y, j) => { const w = v.obj(y, `project.ties[${i}].ties[${j}]`); return { text: v.str(w.text, `project.ties[${i}].ties[${j}].text`, { max: 400, links: false }), cite: cite(w.cite, `project.ties[${i}].ties[${j}].cite`) }; }) }; }),
      ...(q.missing !== undefined ? { missing: v.str(q.missing, "project.missing", { max: 240, links: false }) } : {}) }; })() } : {}),
    ...(x.five !== undefined ? { five: v.list(x.five, "five", 1, 4).map((r, i) => { const q = v.obj(r, `five[${i}]`); return { label: v.str(q.label, `five[${i}].label`, { max: 40, links: false }), text: v.str(q.text, `five[${i}].text`, { max: 400, links: false }), ...(q.cite !== undefined ? { cite: cite(q.cite, `five[${i}].cite`) } : {}) }; }) } : {}),
    developments: lines(x.developments, "developments", 5, (q, p) => ({ date: v.str(q.date, `${p}.date`, { max: 20, links: false }), ...(q.measure ? { measure: v.one(q.measure, `${p}.measure`, ["volume", "forecast"] as const) } : {}) })),
    competitors: lines(x.competitors, "competitors", 4, (q, p) => ({ name: v.str(q.name, `${p}.name`, { max: 60, links: false }) })),
    questions: v.list(x.questions ?? [], "questions", 0, 6).map((r, i) => { const q = v.obj(r, `questions[${i}]`); return { text: v.str(q.text, `questions[${i}].text`, { max: 400, links: false }), cite: cite(q.cite, `questions[${i}].cite`) }; }),
    unknowns: v.list(x.unknowns ?? [], "unknowns", 0, 8).map((g, i) => v.str(g, `unknowns[${i}]`, { max: 240, links: false })),
    ...(x.unread !== undefined ? { unread: v.list(x.unread, "unread", 1, 10).map((g, i) => v.str(g, `unread[${i}]`, { max: 240, links: false })) } : {}), sources };
  if (![out.business, out.developments, out.competitors, out.role_asks, out.questions].some((xs) => xs.length)) v.err("data", "a company brief needs at least one sourced line");
  for (let i = 1; i <= n; i++) if (!used.has(i)) v.err(`sources[${i - 1}]`, "is not cited by any line; leave it out");
  return out;
}
// R9-C (2026-11-07): the market research brief, a variant of research_brief (KIND_IDS stays as it is). Blocks: a cover (title, one-line
// thesis, the date its sources were read), a summary, an optional comparison table, "what would have to be true", risks, sources. Every
// summary line and table cell is a sourced fact AND names the numbered sources it stands on; the conditions and risks are Trainee's
// reading and still name their sources. Every source is an https page with the time it was fetched (never in the future), and every
// source is cited at least once (no padding). The date on the cover is the newest fetch time: computed, never written by the model.
function marketBrief(x: Record<string, any>, v: V) {
  const sources = v.list(x.sources, "sources", 1, 10).map((s, i) => { const q = v.obj(s, `sources[${i}]`); return { title: v.str(q.title, `sources[${i}].title`, { max: 120, links: false }), url: v.https(q.url, `sources[${i}].url`, false), fetched_at: v.time(q.fetched_at, `sources[${i}].fetched_at`, false) }; });
  const n = sources.length, used = new Set<number>();
  const cite = (raw: unknown, path: string) => {
    const xs = v.list(raw, path, 1, 6), ok = xs.filter((i) => Number.isInteger(i) && i >= 1 && i <= n);
    if (ok.length !== xs.length) v.err(path, `each cite is a source number from 1 to ${n}`);
    ok.forEach((i) => used.add(i));
    return [...new Set(ok as number[])];
  };
  const line = (r: unknown, path: string, sourced: boolean) => {
    const q = v.obj(r, path), f = sourced ? v.fact(q, path, { valueKey: "text", labelKey: null }) : { text: v.str(q.text, `${path}.text`, { max: 400, links: false }) };
    if (sourced && typeof q.text === "string" && URL_RX.test(q.text)) v.err(`${path}.text`, "must not contain links; cite the source number");
    return { ...f, cite: cite(q.cite, `${path}.cite`) };
  };
  let comparison: unknown;
  if (x.comparison !== undefined) {
    const c = v.obj(x.comparison, "comparison"), options = v.list(c.options, "comparison.options", 2, 4).map((o, i) => ({ name: v.str(v.obj(o, `comparison.options[${i}]`).name, `comparison.options[${i}].name`, { max: 60 }) }));
    const rows = v.list(c.rows, "comparison.rows", 1, 10).map((r, i) => {
      const q = v.obj(r, `comparison.rows[${i}]`), cells = v.list(q.cells, `comparison.rows[${i}].cells`, options.length, options.length).map((c2, j) => {
        if (c2 === null) return null;
        const p = `comparison.rows[${i}].cells[${j}]`, f = v.fact(c2, p, { labelKey: null });
        return { ...f, cite: cite(v.obj(c2, p).cite, `${p}.cite`) };
      });
      if (cells.length && cells.every((z) => z === null)) v.err(`comparison.rows[${i}]`, "nothing is known for any option; leave the row out");
      return { label: v.str(q.label, `comparison.rows[${i}].label`, { max: 80 }), cells };
    });
    comparison = { options, rows };
  }
  // The cover thesis names the sources it stands on (thesis_cite), or says it summarizes the cited sections (thesis_summary).
  const thesisMark = x.thesis_cite !== undefined ? { thesis_cite: cite(x.thesis_cite, "thesis_cite") } : x.thesis_summary === true ? { thesis_summary: true } : {};
  const out = { variant: "market", title: v.str(x.title, "title", { max: 80, links: false }), subject: v.str(x.subject, "subject", { max: 120 }), thesis: v.str(x.thesis, "thesis", { max: 160, links: false }), ...thesisMark,
    summary: v.list(x.summary, "summary", 1, 5).map((r, i) => line(r, `summary[${i}]`, true)), ...(comparison ? { comparison } : {}),
    conditions: v.list(x.conditions, "conditions", 1, 6).map((r, i) => line(r, `conditions[${i}]`, false)),
    risks: v.list(x.risks, "risks", 1, 6).map((r, i) => line(r, `risks[${i}]`, false)),
    // R9 free sources: what no free source supplied (code-written from the sources' outcomes, D-007); optional, at most 8.
    // Where the cited sources give different figures for the same thing (code-detected, agent/research/market.ts disagreementsIn):
    // every value with the source it came from; Trainee never picks one. Optional, at most 4.
    ...(x.disagreements !== undefined ? { disagreements: v.list(x.disagreements, "disagreements", 1, 4).map((r, i) => { const q = v.obj(r, `disagreements[${i}]`);
      return { label: v.str(q.label, `disagreements[${i}].label`, { max: 120, links: false }), values: v.list(q.values, `disagreements[${i}].values`, 2, 4).map((y, j) => { const z = v.obj(y, `disagreements[${i}].values[${j}]`); return { value: v.str(z.value, `disagreements[${i}].values[${j}].value`, { max: 60, links: false }), cite: cite(z.cite, `disagreements[${i}].values[${j}].cite`) }; }) }; }) } : {}),
    // How a source was chosen when the person did not say (a role matched to a BLS occupation), code-written; optional, at most 4.
    ...(x.basis !== undefined ? { basis: v.list(x.basis, "basis", 1, 4).map((g, i) => v.str(g, `basis[${i}]`, { max: 240, links: false })) } : {}),
    ...(x.gaps !== undefined ? { gaps: v.list(x.gaps, "gaps", 1, 8).map((g, i) => v.str(g, `gaps[${i}]`, { max: 240, links: false })) } : {}), sources };
  for (let i = 1; i <= n; i++) if (!used.has(i)) v.err(`sources[${i - 1}]`, "is not cited by any line; leave it out");
  return out;
}

// The Trainee-records label is for the kinds that report Trainee's own records.
const RECORDS_OK = new Set<string>(["application_proof"]); // and only for data built by code from a record (trusted)

export function validateKind(kind: string, raw: unknown, o: { trusted?: boolean; now?: number } = {}): Validated {
  if (kind === "job_list") return { ok: false, errors: ["job_list is created by the job search, not by create_file"] };
  const fn = (KINDS as Record<string, (r: unknown, v: V) => any>)[kind];
  if (!fn) return { ok: false, errors: [`unknown kind "${kind}"; use one of: ${MODEL_KINDS.join(", ")}`] };
  if (!isObj(raw)) return { ok: false, errors: ["data: must be an object"] };
  const v = new V(!!o.trusted && RECORDS_OK.has(kind), o.now ?? null, !!o.trusted && MADE_OK.has(kind));
  v.trusted = !!o.trusted;
  let data: any;
  try { data = fn(raw, v); } catch (e) { return { ok: false, errors: [`data: could not be read (${e instanceof Error ? e.message : String(e)})`] }; }
  // A resume File carries its PDF (re-review of #644 (4): a real one- or two-page resume runs to tens of KB); every other kind stays small.
  const max = kind === "draft" && data?.variant === "resume" ? RESUME_B64_MAX + 8_000 : 24_000;
  if (!v.errors.length && JSON.stringify(data).length > max) v.err("data", `is over ${Math.round(max / 1000)} KB`);
  return v.errors.length ? { ok: false, errors: v.errors.slice(0, 12) } : { ok: true, data: JSON.parse(JSON.stringify(data)) };
}

// The hash an Introduce tap is bound to: the person and the exact message.
export async function tagOf(kind: string, data: any): Promise<string | null> {
  if (kind !== "introduction") return null;
  const b = new TextEncoder().encode(JSON.stringify({ p: data?.person?.name, m: data?.message }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ---------------------------------------------------------------- render helpers (a stored fact with no valid source is skipped)
const hasSrc = (f: any, records = false, made = false) => !!f && typeof f.source === "string" && ((SOURCES as readonly string[]).includes(f.source) || (records && f.source === RECORDS) || (made && f.source === MADE)) && typeof (f.value ?? f.text ?? f.answer) === "string" && !!String(f.value ?? f.text ?? f.answer).trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (t: string | number | null | undefined) => { const n = typeof t === "number" ? t : Date.parse(String(t ?? "")); if (Number.isNaN(n)) return ""; const d = new Date(n); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`; };
const Fs = (xs: any[] | undefined, records = false, made = false) => (xs ?? []).filter((f) => hasSrc(f, records, made));
const src = (s: string) => `<span class="src">${esc(s)}</span>`;
const factHtml = (f: any, label?: string) => `<div class="fact">${label ? `<dt>${esc(label)}</dt>` : ""}<dd>${esc(f.value ?? f.text ?? f.answer)} ${src(f.source)}</dd></div>`;
const factText = (f: any, label?: string) => `- ${label ? `${label}: ` : ""}${f.value ?? f.text ?? f.answer} [${f.source}]`;
const sec = (h: string, inner: string) => inner ? `<section class="blk"><h2>${esc(h)}</h2>${inner}</section>` : "";
const dl = (xs: string) => xs ? `<dl class="facts">${xs}</dl>` : "";
const linkHtml = (u: string | undefined, text: string) => u && HTTPS.test(u) ? `<a href="${esc(u)}" rel="noopener noreferrer">${esc(text)}</a>` : "";
// WO-G: the proof and review styles, emitted only on those pages (an inline <style>, which the File CSP allows), so no other
// File's page changes.
const PROOF_CSS = `.state.uncertain,.state.needs-you{color:var(--warn)}.notice{margin:0;padding:12px 14px;border-radius:10px;background:var(--panel)}.r-hero{margin:0 0 14px;padding:18px 18px 16px;border-radius:16px;background:var(--verified);color:var(--bg)}.r-kick{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.82}.r-title{margin:0 0 8px;font-family:'Brygada 1918',Georgia,serif;font-size:28px;line-height:1.15;overflow-wrap:anywhere}.r-sub{margin:0;font-size:16px;overflow-wrap:anywhere}.r-sub strong{margin-right:8px}
.r-card{margin:14px 0;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--card)}.r-card.r-warn{border-color:var(--warn)}.r-head{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
.r-rows{margin:0}.r-row{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--line)}.r-row:first-child{border-top:0}.r-row dt{color:var(--mute)}.r-row dd{margin:0;font-weight:600;text-align:right;overflow-wrap:anywhere;min-width:0}
.r-ans{margin:0}.r-ans>div{padding:8px 0;border-top:1px solid var(--line)}.r-ans>div:first-child{border-top:0}.r-ans dt{font-size:15px;color:var(--mute)}.r-ans dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.r-need,.r-checks{list-style:none;margin:0;padding:0}.r-need li{padding:8px 0;border-top:1px solid var(--line)}.r-need li:first-child{border-top:0}.r-checks li{position:relative;padding:6px 0 6px 34px}.r-checks li::before{content:"\\2713";position:absolute;left:0;top:7px;width:22px;height:22px;border-radius:6px;background:var(--good);color:#fff;font-size:14px;line-height:22px;text-align:center}
.r-after{margin:14px 0;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--tint)}.r-approve{margin:14px 0 0;padding:12px 14px;border-radius:12px;background:var(--panel);font-weight:500}.rv-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-4px 0 12px}.rv-ids{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.06em;color:var(--mute)}.rv-more{position:relative;margin-left:auto}.rv-more summary{list-style:none;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border:1px solid var(--line);border-radius:12px;cursor:pointer;font-size:22px}.rv-more summary::-webkit-details-marker{display:none}.rv-more[open] a{display:block;min-height:44px;padding:10px 12px;color:var(--link)}.rv-more[open]{background:var(--card)}`;
// WO-G: green only for the employer's own confirmation; every other stage keeps its own colour (spec D.4 rule 7).
const STAGE_CLASS: Partial<Record<Stage, string>> = { employer_confirmed: "confirmed", failed: "failed", not_sent: "failed", needs_you: "needs-you", uncertain: "uncertain" };
// The proof panel (spec C.21 section 5, C.23 item 10): what is and is not proven, never a made-up receipt.
const PROOF_HEAD: Record<string, string> = { uncertain: "Submission uncertain", submitted_unconfirmed: "Not confirmed by the employer yet" };
const PROOF_BODY: Record<string, string> = {
  none: "Nothing was submitted. An actual receipt, application ID or employer status appears here only after a real approved submission.",
  uncertain: "The final step may have landed. Check the employer's status before another attempt; Trainee will not send it again. No receipt or confirmation ID exists yet, and none is made up.",
  submitted_unconfirmed: "It reached the employer's form. Their confirmation email, application ID or status page is the proof, and it appears here when it exists.",
  sending: "Being sent now. Nothing is confirmed until the employer's page answers.",
};
// The review File (spec C.11 F-09, C.21 packet; target pages p-67, p-68, p-88): the hero names the role and employer, THE PACKAGE
// says what goes, the facts still needed come next, then every answer word for word, the conditions in plain words, what happens
// after approval and the proof panel. The approval itself is the chat card's yes (hash-bound); this page cannot submit.
const rowHtml = (k: string, v: string) => `<div class="r-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
const card = (head: string, inner: string, cls = "") => `<section class="r-card${cls ? ` ${cls}` : ""}"><h2 class="r-head">${esc(head)}</h2>${inner}</section>`;
const pkg = (d: any, r: any): [string, string][] => [["Status", "Prepared draft; not submitted"], ["Resume", d.resume ?? "None, so this cannot be sent"],
  ["Letter", r.letter ? "Cover note, full text below" : "Not requested by this form"], ["Answers", `${(r.answers ?? []).length} answers - full text below`],
  ["Destination", r.url ?? d.destination ?? "Employer application page"], ["Unresolved", (r.unresolved ?? []).length ? `${r.unresolved.length} required fact${r.unresolved.length === 1 ? "" : "s"}` : "None"]];
const conditions = (r: any, tz?: string | null): string[] => [
  `Only this employer, role, resume and these answers${r.hash12 ? ` (approval ${r.hash12})` : ""}. Another employer, resume or a bigger batch needs a new review.`,
  "A new required question or declaration returns this to review.", "A material destination change cancels this approval.",
  ...(r.expires_at ? [`Approval expires ${whenIn(r.expires_at, tz)}.`] : [])];
const AFTER = "Trainee fills the reviewed answers on the employer's page and submits once. You then see the employer's own confirmation - a click alone never counts as submitted.";
const APPROVE = (r: any) => (r.unresolved ?? []).length ? "Not ready to approve: answer the facts above first. Approving wording never answers them, and nothing can be submitted from this page."
  : "To approve exactly this, reply \"yes\" to the card in your Trainee chat. Nothing can be submitted from this page.";
const whenIn = (iso: string, tz?: string | null) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ""; const f = (z: string) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: z, timeZoneName: "short" }); try { return f(tz || "UTC"); } catch { return f("UTC"); } };
const reviewPageHtml = (d: any, tz?: string | null) => {
  const r = d.review, open = r.unresolved ?? [];
  return `<section class="r-hero"><p class="r-kick">${esc(r.approvable ? "Final review - approval covers exactly this" : "Review - not ready to approve")}</p><p class="r-title">${esc(d.role ?? d.company)}</p><p class="r-sub"><strong>${esc(d.company)}</strong> Prepared ${esc(whenIn(d.prepared_at, tz))}</p></section>`
    + `<p class="state prepared" role="status"><strong>${esc(STAGE_LABEL.prepared)}.</strong> ${esc(STAGE_NOTE.prepared)}</p>`
    + card("The package", `<dl class="r-rows">${pkg(d, r).map(([k, v]) => rowHtml(k, v)).join("")}</dl>`)
    + (open.length ? card("Needs your answer", `<ul class="r-need">${open.map((u: any) => `<li><strong>${esc(u.question)}: not entered.</strong> ${esc(u.ask)}</li>`).join("")}</ul>`, "r-warn") : "")
    + card("Exact answers that will be sent", `<dl class="r-ans">${(r.answers ?? []).map((a: any) => `<div><dt>${esc(a.question)}${a.sensitive ? ` <span class="src">Your answer</span>` : ""}</dt><dd>${esc(a.answer)}</dd></div>`).join("")}</dl>`)
    + card("Conditions - in plain words", `<ul class="r-checks">${conditions(r, tz).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)
    + `<p class="r-after"><strong>What happens after approval.</strong> <span>${esc(AFTER)}</span></p>`
    + card("Proof panel", `<p class="notice"><strong>No submission confirmation.</strong> ${esc(PROOF_BODY.none)}</p>`)
    + `<p class="r-approve" role="note">${esc(APPROVE(r))}</p>`;
};
const reviewLines = (d: any, tz?: string | null): string[] => {
  const r = d.review, open = r.unresolved ?? [];
  return [r.approvable ? "FINAL REVIEW - APPROVAL COVERS EXACTLY THIS" : "REVIEW - NOT READY TO APPROVE", `${d.role ?? d.company} · ${d.company} · Prepared ${whenIn(d.prepared_at, tz)}`, "",
    `Status: ${STAGE_LABEL.prepared}. ${STAGE_NOTE.prepared}`, "", "## The package", ...pkg(d, r).map(([k, v]) => `- ${k}: ${v}`), "",
    ...(open.length ? ["## Needs your answer", ...open.map((u: any) => `- ${u.question}: not entered. ${u.ask}`), ""] : []),
    "## Exact answers that will be sent", ...(r.answers ?? []).map((a: any) => `- ${a.question}: ${a.answer}${a.sensitive ? " (your answer)" : ""}`), "",
    "## Conditions - in plain words", ...conditions(r, tz).map((c) => `- ${c}`), "", `What happens after approval. ${AFTER}`, "",
    "## Proof panel", `No submission confirmation. ${PROOF_BODY.none}`, "", APPROVE(r)];
};
const STATUS_NOTE: Record<string, string> = { queued: "Queued. Nothing has been submitted yet.", prepared: "Prepared. Nothing has been submitted yet.", submitted: "Submitted. The employer hasn't confirmed it.", uncertain: "Submission may have landed; the employer has not confirmed it.", confirmed: "Confirmed by the employer.", failed: "Failed. It was not submitted." };

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
  if (rec.kind === "application_proof" || rec.kind === "application_review") {
    const flags = Array.isArray(st.flags) ? st.flags.length : 0;
    return [{ id: "status", label: "View status", state: "available", note: `Shows what is recorded as of ${when(rec.data?.as_of)}.` },
      { id: "flag", label: "Flag a problem", state: "available", note: flags ? `${flags} flagged.` : "Saves your note on this file." }];
  }
  if (rec.kind === "draft" && rec.data?.variant === "resume") return [{ id: "download", label: "Download PDF", state: "available", note: "Saves the file to this device. Nothing is sent to anyone." }];
  if (rec.kind === "draft") return [{ id: "copy", label: "Copy", state: "available", note: "Copies the text as it is in the box. Edits stay on this page." }];
  return [];
}

export interface ActResult { ok: boolean; status: number; note: string; patch?: Record<string, unknown>; file?: { filename: string; mime: string; base64: string } }
export interface Effects { introduce?(userId: string, rec: FileRecord): Promise<{ ok: boolean; reason?: string }> }
// One tap. Returns the note to show and the state to keep; never throws for a refused tap.
// `persist` stores a state patch at once: the approval is written BEFORE any send is attempted, so a crash or a second tap can never send twice.
// `claim` is the atomic, once-only decision (insert-if-absent in the store): the first caller gets true, every other tap false.
export async function actOn(rec: FileRecord, action: string, form: URLSearchParams, now: number, fx: Effects = {}, persist?: (patch: Record<string, unknown>) => Promise<void>, claim?: () => Promise<boolean>): Promise<ActResult> {
  const views = actionsOf(rec), view = views.find((a) => a.id === action);
  if (!view || action === "copy") return { ok: false, status: 400, note: "That is not something this file can do. Nothing was sent." };
  if (action === "download") return { ok: true, status: 200, note: "", file: { filename: String(rec.data.filename), mime: "application/pdf", base64: String(rec.data.pdf_b64) } };
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
  if (action === "status") return { ok: true, status: 200, note: `Status as recorded on ${when(rec.data?.as_of)}: ${rec.data?.stage && STAGE_LABEL[rec.data.stage as Stage] ? STAGE_LABEL[rec.data.stage as Stage] : cap1(String(rec.data?.status))}.` };
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
  // One primary action per File (audit D06): the first available action is the plum button; every other one is drawn as a secondary
  // (outlined) button, so the page never offers two plum choices.
  let primary = false;
  const kind = (ghost = false) => { if (ghost || primary) return "btn ghost"; primary = true; return "btn"; };
  const out = vs.map((a) => {
    const note = a.note ? `<p class="anote">${esc(a.note)}</p>` : "";
    if (a.id === "copy") return `<div class="act1"><button type="button" class="${kind()}" data-copy>Copy</button><span id="copy-status" role="status"></span>${note}</div>`;
    if (a.state !== "available") return `<div class="act1"><span class="btn off" role="status">${esc(a.label)}: ${STATE_WORD[a.state]}</span>${note}</div>`;
    // A download is a plain post (not the page's ajax form): the answer is the file itself.
    if (a.id === "download") return `<form method="post" class="act1">${hidden(token, a.id)}<button type="submit" class="${kind()}">${esc(a.label)}</button>${note}</form>`;
    if (a.id === "flag") return `<form method="post" class="ajax act1">${hidden(token, "flag")}<label for="flag-note">What looks wrong</label><textarea id="flag-note" name="note" rows="3" maxlength="500"></textarea><button type="submit" class="${kind()}">Flag a problem</button>${note}</form>`;
    const extra = a.id === "introduce" ? `<input type="hidden" name="tag" value="${esc(rec.tag ?? "")}">` : "";
    return `<form method="post" class="ajax act1">${hidden(token, a.id, extra)}<button type="submit" class="${kind(a.id === "pass")}">${esc(a.label)}</button>${note}</form>`;
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
    case "application_review":
      // The p-67 header's mono ids and its overflow menu (the plain-text version); the shell above carries the title.
      main = `<style>${PROOF_CSS}</style><div class="rv-top">${d.ids ? `<p class="rv-ids">${esc(d.ids)}</p>` : ""}<details class="rv-more"><summary aria-label="More">\u22EE</summary><a href="?format=text">Plain text version</a></details></div>`
        + reviewPageHtml(d, o.tz) + sec("Flagged by you", `<ul class="why">${(Array.isArray(rec.state?.flags) ? rec.state.flags : []).map((f: any) => `<li>${esc(when(f.at))}: ${esc(f.note)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""));
      break;
    case "application_proof": {
      if (d.review) {
        main = `<style>${PROOF_CSS}</style>` + reviewPageHtml(d, o.tz) + sec("Flagged by you", `<ul class="why">${(Array.isArray(rec.state?.flags) ? rec.state.flags : []).map((f: any) => `<li>${esc(when(f.at))}: ${esc(f.note)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""));
        break;
      }
      const c = d.confirmation ?? {};
      const kv = (k: string, v: unknown, s: Source = RECORDS) => v ? factHtml({ value: String(v), source: s }, k) : "";
      const st = d.stage as Stage | undefined, sent = !st || st === "employer_confirmed" || st === "submitted_unconfirmed";
      const pageOnly = !!st && st !== "employer_confirmed"; // 13-Obs: a page reference alone is never the employer's confirmation
      main = (st ? `<style>${PROOF_CSS}</style><p class="state ${esc(STAGE_CLASS[st] ?? st)}" role="status"><strong>${esc(STAGE_LABEL[st])}.</strong> ${esc(STAGE_NOTE[st])}</p>`
        : `<p class="state ${esc(d.status)}" role="status"><strong>${esc(cap1(d.status))}.</strong> ${esc(STATUS_NOTE[d.status] ?? "")}</p>`)
        + sec(sent ? "What was submitted" : "The application", dl(kv("Company", d.company) + kv("Role", d.role) + kv("Sent to", d.destination) + kv("Resume", d.resume) + kv("Prepared", when(d.prepared_at)) + kv("Submitted", when(d.submitted_at)) + kv("Last updated", when(d.as_of))))
        // The proof rides with the claim (brief P3.7, P6.6): the confirmation as a receipt (its snippet, where it came from and when,
        // the link, and the screenshot inline when the page may show it). Without one, "Not confirmed yet" is the value, said.
        + sec("Confirmation", (c.id || c.url || c.screenshot_url)
          ? evidenceHtml({ quote: c.id ? (pageOnly ? `Their page showed ${c.id}; this is not the employer's confirmation` : `Confirmation ID: ${c.id}`) : "The employer's confirmation page", source: RECORDS, at: d.submitted_at ?? d.as_of ?? null, href: c.url, hrefLabel: "Open the confirmation",
            image: o.evidenceImage?.(c.screenshot_url) ? c.screenshot_url : null, imageAlt: `${d.company ?? "The employer"}'s confirmation screen` }, o.tz)
            + (c.screenshot_url && !o.evidenceImage?.(c.screenshot_url) ? `<p>${linkHtml(c.screenshot_url, "Open the screenshot")}</p>` : "")
          : d.email_confirmed_at ? `<p>Confirmed by ${esc(d.company ?? "the employer")}'s own email, received ${esc(when(d.email_confirmed_at))}. ${src(RECORDS)}</p>`
          : d.status === "submitted" || d.status === "confirmed" ? `<p class="unconf">${valueHtml(unknown(UNKNOWN.notConfirmed))} The employer hasn't sent a confirmation Trainee can show.</p>` : "")
        + (st && st !== "employer_confirmed" ? sec("Proof", `<p class="notice"><strong>${esc(PROOF_HEAD[st] ?? "No submission confirmation")}.</strong> ${esc(PROOF_BODY[st] ?? PROOF_BODY.none)}</p>`) : "")
        + sec("Answers given", dl(Fs(d.answers, true).map((a) => factHtml(a, a.question)).join("")))
        + sec("Not done", `<ul class="why">${(d.problems ?? []).filter((p: any) => p?.reason).map((p: any) => `<li><strong>${esc(cap1(p.outcome))}:</strong> ${esc(p.item)}. ${esc(p.reason)} ${src(RECORDS)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""))

        + sec("Flagged by you", `<ul class="why">${(Array.isArray(rec.state?.flags) ? rec.state.flags : []).map((f: any) => `<li>${esc(when(f.at))}: ${esc(f.note)}</li>`).join("")}</ul>`.replace(/^<ul class="why"><\/ul>$/, ""));
      break;
    }
    case "plan_review":
      // A stored plan review was validated when it was made, so a "Made by Trainee" line on it came from code (MADE_OK, trusted only).
      // BETA C03 (2026-11-04): an interview prep File is one phone-sized sheet. Each line keeps its own source chip, but the chip sits on
      // the line's label row (which has room) instead of wrapping under the text, and the blocks are spaced tighter (.prep in KIND_CSS).
      // Every question and plan block stays visible; nothing is collapsed or hidden (tests/architect/prep-file.test.ts PF-6).
      if (d.variant === "interview_prep") {
        const row = (f: any) => `<div class="fact"><dt><span>${esc(f.label ?? "")}</span>${src(f.source)}</dt><dd>${esc(f.value ?? f.text ?? f.answer)}</dd></div>`;
        main = `<div class="prep">${d.period ? `<p class="meta">${esc(d.period)}</p>` : ""}${(d.sections ?? []).map((s: any) => sec(s.heading, dl(Fs(s.items, false, true).map(row).join("")))).join("")}</div>`;
        break;
      }
      main = (d.period ? `<p class="meta">${esc(d.period)}</p>` : "") + (d.sections ?? []).map((s: any) => sec(s.heading, dl(Fs(s.items, false, true).map((f) => factHtml(f, f.label)).join("")))).join("");
      break;
    case "comparison": {
      const opts = (d.options ?? []).map((o: any) => o.name);
      const cell = (c: any) => hasSrc(c) ? `${esc(c.value)}<br>${src(c.source)}` : `<span class="meta">Not stated</span>`;
      main = `<div class="tbl" tabindex="0" role="region" aria-label="Comparison table"><table><caption class="sr">${esc(d.title)}</caption><thead><tr><th scope="col"><span class="sr">Item</span></th>${opts.map((n: string) => `<th scope="col">${esc(n)}</th>`).join("")}</tr></thead><tbody>${(d.rows ?? []).map((r: any) => `<tr><th scope="row">${esc(r.label)}</th>${(r.cells ?? []).map((c: any) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      break;
    }
    case "draft":
      if (d.variant === "resume") {
        main = `<p class="meta">${esc(`For ${d.target}`)}</p>${d.review ? `<p class="meta"><strong>Review draft, not for external submission.</strong></p>` : ""}${d.note ? `<p>${esc(d.note)}</p>` : ""}<p class="meta">${esc(d.filename)}</p>`;
        break;
      }
      main = `<p class="meta">${esc([cap1(String(d.type).replace("_", " ")), d.to ? `to ${d.to}` : ""].filter(Boolean).join(" "))}</p>${d.subject ? `<p class="meta">Subject: ${esc(d.subject)}</p>` : ""}<label for="draft-body" class="lbl">Edit the text here. Edits stay on this page.</label><textarea id="draft-body" class="draft" rows="14">${esc(d.body)}</textarea>`
        + sec("What it says about you", dl(Fs(d.basis).map((f) => factHtml(f, f.label)).join("")))
        + `<p class="meta">This page cannot send it. To send it, ask Trainee in Telegram; you approve the exact message first.</p>`;
      break;
    case "tracker": {
      const tr = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
      const table = (label: string, head: string[], rows: string[]) => rows.length ? `<div class="tbl" tabindex="0" role="region" aria-label="${esc(label)}"><table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="meta">None on record.</p>`;
      main = (d.changes?.length ? sec("Corrected since last time", `<ul class="why">${d.changes.map((c: string) => `<li>${esc(c)}</li>`).join("")}</ul>`) : "")
        + sec("Applications", table("Applications", ["Company", "Role", "Applied", "Status", "Evidence"], (d.applied ?? []).map((a: any) => tr([esc(a.company), esc(a.role ?? ""), esc(a.applied_on ?? ""), `${esc(a.status)}<br><span class="meta">${esc(a.source)}</span>`,
          (a.evidence ?? []).map((e: any) => `${esc(e.what)}${e.on ? ` (${esc(e.on)})` : ""}${e.text ? `: ${esc(e.text)}` : ""}`).join("<br>")]))))
        + sec("Researched, not applied", table("Researched roles", ["Company", "Role", "Status"], (d.researched ?? []).map((r: any) => tr([esc(r.company), r.url ? linkHtml(r.url, r.role ?? "posting") : esc(r.role ?? ""), esc(r.status)]))))
        + sec("Drafts, not submitted or sent", table("Drafts", ["Company", "What", "Status", "Since"], (d.drafts ?? []).map((x: any) => tr([esc(x.company ?? ""), esc(x.what), esc(x.status), esc(x.since ?? "")]))))
        + sec("What this covers", `<ul class="why">${(d.coverage ?? []).map((c: string) => `<li>${esc(c)}</li>`).join("")}</ul>`);
      break;
    }
    case "research_brief":
      if (d.variant === "market") { main = marketHtml(d); break; }
      if (d.variant === "company") { main = companyHtml(d); break; }
      main = sec(`What we found about ${d.subject ?? ""}`, dl(Fs(d.findings).map((f) => factHtml(f, f.label)).join("")))
        + sec("Sources", `<ul class="why">${(d.sources ?? []).map((s: any) => `<li>${linkHtml(s.url, s.title) || esc(s.title)}</li>`).join("")}</ul>`);
      break;
  }
  return `${main}${actionsHtml(rec, token)}`;
}

// ---------------------------------------------------------------- the market research brief (R9-C)
// The cover echoes the link preview (og-research.png): the warm ground, the mark and name, the serif thesis, the date the sources were
// read. Citations are plain numbers ("[1]", not tap targets), each matching a numbered source at the end, which is the link.
const DAY = (t: string | number) => { const n = typeof t === "number" ? t : Date.parse(t); return Number.isNaN(n) ? "" : `${MONTHS[new Date(n).getUTCMonth()]} ${new Date(n).getUTCDate()}, ${new Date(n).getUTCFullYear()}`; };
export const marketReadOn = (d: any) => { const ts = (d?.sources ?? []).map((s: any) => Date.parse(s?.fetched_at)).filter((t: number) => !Number.isNaN(t)); return ts.length ? DAY(Math.max(...ts)) : ""; };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const cites = (c: unknown) => Array.isArray(c) && c.length ? ` <span class="rb-cite">${c.map((i) => `[${esc(i)}]`).join("")}</span>` : "";
const READING = `<span class="src rb-read">Trainee's reading</span>`;
const MARK = `<svg class="rb-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="var(--accent)"/><text x="32" y="45" font-family="Georgia,serif" font-size="40" font-weight="700" text-anchor="middle" fill="var(--accent-ink)">T</text></svg>`;
function marketHtml(d: any): string {
  const n = (d.sources ?? []).length, read = marketReadOn(d);
  const cover = `<section class="rb-cover" aria-label="Cover"><p class="rb-brand">${MARK}<span>Trainee</span><span class="rb-dot" aria-hidden="true">·</span><span>Research brief</span></p>`
    + `<p class="rb-thesis">${esc(d.thesis)}${cites(d.thesis_cite)}</p>${d.thesis_summary ? `<p class="rb-basis">A summary of the cited sections below.</p>` : ""}<p class="rb-date">${read ? `Sources read ${esc(read)} · ` : ""}${n} source${n === 1 ? "" : "s"}</p></section>`;
  const list = (xs: any[], sourced: boolean) => `<ul class="rb-list">${xs.filter((f) => sourced ? hasSrc(f) : !!f?.text).map((f) => `<li><span class="rb-t">${esc(f.text)}${cites(f.cite)}</span>${sourced ? src(f.source) : READING}</li>`).join("")}</ul>`;
  const c = d.comparison, opts = (c?.options ?? []).map((o: any) => o.name);
  const cell = (x: any) => hasSrc(x) ? `${esc(x.value)}${cites(x.cite)}<br>${src(x.source)}` : `<span class="meta">Not stated</span>`;
  // Under 560 px each row stacks as a card of option/value pairs (KIND_CSS .rb-tbl): the option name is repeated in each cell as a
  // visual label (aria-hidden; the table's own headers still name the cell), so no column is ever cut off at phone width.
  const table = c ? `<div class="tbl rb-tbl" tabindex="0" role="region" aria-label="Comparison table"><table><caption class="sr">Comparison</caption><thead><tr><th scope="col"><span class="sr">Item</span></th>${opts.map((o: string) => `<th scope="col">${esc(o)}</th>`).join("")}</tr></thead><tbody>${(c.rows ?? []).map((r: any) => `<tr><th scope="row">${esc(r.label)}</th>${(r.cells ?? []).map((x: any, i: number) => `<td><span class="rb-k" aria-hidden="true">${esc(opts[i] ?? "")}</span><span class="rb-v">${cell(x)}</span></td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  const srcs = `<ol class="rb-src">${(d.sources ?? []).map((s: any, i: number) => `<li id="src-${i + 1}"><span class="rb-n">[${i + 1}]</span>${linkHtml(s.url, s.title) || esc(s.title)}<span class="meta"><span class="rb-host" title="${esc(hostOf(s.url))}">${esc(hostOf(s.url))}</span> · Read ${esc(DAY(s.fetched_at))}</span></li>`).join("")}</ol>`;
  return cover + sec("Summary", list(d.summary ?? [], true)) + sec("Comparison", table) + sec("Where the sources differ", (d.disagreements ?? []).length ? `<ul class="rb-list rb-differ">${d.disagreements.map((x: any) => `<li><span class="rb-t">${esc(x.label)}: ${x.values.map((y: any) => `${esc(y.value)}${cites(y.cite)}`).join(" · ")}. The sources differ; Trainee has not picked one.</span></li>`).join("")}</ul>` : "") + sec("What would have to be true", list(d.conditions ?? [], false)) + sec("Risks", list(d.risks ?? [], false))
    + sec("How the sources were chosen", (d.basis ?? []).length ? `<ul class="rb-list rb-basis-list">${d.basis.map((g: string) => `<li><span class="rb-t">${esc(g)}</span></li>`).join("")}</ul>` : "")
    + sec("Not found in a free source", (d.gaps ?? []).length ? `<ul class="rb-list rb-gaps">${d.gaps.map((g: string) => `<li><span class="rb-t">${esc(g)}</span></li>`).join("")}</ul>` : "") + sec("Sources", srcs);
}
// R10 WO-H fix 14: the company interview brief. Order (spec C.22): the frame (Trainee's reading) on the cover; what the company sells;
// recent developments, each with its date and what its figure measures; competitors and tradeoffs; what the role page asks; questions
// to ask; what the brief cannot tell you; sources, each with its kind (the company's own page or reported elsewhere) and its limit.
const LIMIT_WORD: Record<string, string> = { paywalled: "paywalled", outdated: "outdated" };
const MEASURE_WORD: Record<string, string> = { volume: "Volume, not revenue", forecast: "A forecast at the time, not a result" };
// Headings and order follow the owner's target pages (app-layer-visuals p-88/p-89, the interview brief specimen, and spec C.22's
// sourced Stripe brief): the short answer, how the business works, evidence versus interpretation, then the dated and sourced detail.
const COMPANY_HEADS = { answer: "The short answer", business: "How the business works", evidence: "Evidence versus interpretation", developments: "Recent developments", competitors: "Competitors and tradeoffs",
  role_asks: "What the role page asks for", project: "How to use your project without overstating it", questions: "Questions worth asking", five: "Five minutes before the interview",
  unknowns: "What this brief cannot tell you", sources: "Sources" } as const;
const OVERSTATE = "Say only what the fact says: no scale, result, tool or title it does not name.";
// The evidence-versus-interpretation rows (p-89): one reported fact, Trainee's reading, one unknown, and the state of the sources.
function companyEvidence(d: any): [string, string][] {
  const S = d.sources ?? [], f = (d.developments ?? [])[0] ?? (d.business ?? [])[0];
  const lim = (k: string) => S.filter((s: any) => s.limit === k).length, unread = (d.unread ?? []).length;
  const state = [`${S.length} source${S.length === 1 ? "" : "s"} read ${marketReadOn(d)}`, lim("paywalled") ? `${lim("paywalled")} paywalled` : "", lim("outdated") ? `${lim("outdated")} outdated` : "", unread ? `${unread} could not be opened` : ""].filter(Boolean).join("; ");
  return [["Reported fact", f ? `${f.date ? `${f.date}: ` : ""}${f.text}` : ""], ["Interpretation", d.frame?.text ?? ""], ["Unknown", (d.unknowns ?? [])[0] ?? ""], ["Source state", state]].filter(([, v]) => v) as [string, string][];
}
function companyHtml(d: any): string {
  const S = d.sources ?? [], read = marketReadOn(d);
  const limits = (c: unknown) => (Array.isArray(c) ? c : []).filter((i: number) => S[i - 1]?.limit).map((i: number) => `<span class="src rb-limit">[${esc(i)}] ${esc(LIMIT_WORD[S[i - 1].limit])}${S[i - 1].dated ? ` · ${esc(S[i - 1].dated)}` : ""}</span>`).join("");
  const kind = (c: unknown) => { const ks = new Set((Array.isArray(c) ? c : []).map((i: number) => S[i - 1]?.by)); return `<span class="src">${ks.has("reported") ? (ks.has("company") ? "Company-reported and reported elsewhere" : "Reported elsewhere, not verified") : "Company-reported, not verified"}</span>`; };
  const li = (x: any, lead = "", chip = "") => `<li><span class="rb-t">${lead}${esc(x.text)}${cites(x.cite)}</span><span class="rb-chips">${chip}${kind(x.cite)}${limits(x.cite)}</span></li>`;
  const ul = (xs: any[], f: (x: any) => string) => xs.length ? `<ul class="rb-list">${xs.map(f).join("")}</ul>` : "";
  const sub = [d.role ? esc(d.role) : "", d.focus ? "One area, expanded" : "Interview brief", "Research only: nothing was sent or applied for"].filter(Boolean).join(" · ");
  const head = `<p class="meta rb-sub">${sub}</p>`;
  const answer = d.frame ? `<p class="rb-answer">${esc(d.frame.text)}${cites(d.frame.cite)}</p><span class="rb-chips">${READING}${limits(d.frame.cite)}</span>` : "";
  const ev = d.focus ? [] : companyEvidence(d);
  const evidence = ev.length ? `<dl class="rb-kv">${ev.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl><p class="rb-caution">Do not turn a plausible interpretation into a reported fact: each line below names its source, and what no source supports is listed as unknown.</p>` : "";
  const qs = (d.questions ?? []).length ? `<ol class="rb-qs">${d.questions.map((q: any) => `<li><span class="rb-t">${esc(q.text)}</span><span class="rb-chips"><span class="src">Grounded in ${q.cite.map((i: number) => `[${esc(i)}]`).join("")}</span>${limits(q.cite)}</span></li>`).join("")}</ol>` : "";
  const cannot = [...(d.unknowns ?? []), ...(d.unread ?? [])];
  const srcs = `<ol class="rb-src">${S.map((s: any, i: number) => `<li id="src-${i + 1}"><span class="rb-n">[${i + 1}]</span>${linkHtml(s.url, s.title) || esc(s.title)}<span class="meta">Source: <span class="rb-host" title="${esc(hostOf(s.url))}">${esc(hostOf(s.url))}</span> · ${s.by === "company" ? "The company's own page" : "Reported elsewhere"} · Read ${esc(DAY(s.fetched_at))}</span>${s.limit === "paywalled" ? `<span class="meta rb-lim">Paywalled: only the part shown without a subscription was read.</span>` : s.limit === "outdated" ? `<span class="meta rb-lim">Outdated: the newest date on this page is ${esc(s.dated ?? "old")}.</span>` : ""}</li>`).join("")}</ol>`;
  const prods = (d.products ?? []) as { name: string; angle: string }[], inProd = (x: any) => !!x.product && prods.some((p) => p.name.toLowerCase() === String(x.product).toLowerCase());
  const pj = d.project, proj = pj ? `${(pj.ties ?? []).map((t: any) => `<div class="rb-proj"><p class="rb-t"><b>Your confirmed fact:</b> ${esc(t.fact)}</p><ul class="rb-list">${t.ties.map((y: any) => li(y, "<b>The role page asks:</b> ")).join("")}</ul></div>`).join("")}${(pj.ties ?? []).length ? `<p class="rb-caution">${OVERSTATE}</p>` : ""}${pj.missing ? `<p class="rb-caution">${esc(pj.missing)}</p>` : ""}` : "";
  const five = (d.five ?? []).length ? `<dl class="rb-kv">${d.five.map((f: any) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.text)}${cites(f.cite)}</dd></div>`).join("")}</dl>` : "";
  return `<div class="rb-co">` + head + `<aside class="rb-notice"><b>Sourced research, not a verdict</b><span>Each fact names the page it came from; Trainee's reading is labelled; what no source says is listed as unknown.</span></aside>`
    + sec(COMPANY_HEADS.answer, answer) + sec(COMPANY_HEADS.business, ul((d.business ?? []).filter((x: any) => !inProd(x)), (x) => li(x)))
    + sec(COMPANY_HEADS.evidence, evidence)
    + prods.map((p) => sec(`${p.name}: ${p.angle}`, ul((d.business ?? []).filter((x: any) => String(x.product ?? "").toLowerCase() === p.name.toLowerCase()), (x) => li(x)))).join("")
    + sec(COMPANY_HEADS.developments, ul(d.developments ?? [], (x) => li(x, `<span class="rb-day">${esc(x.date)}</span> `, x.measure ? `<span class="src rb-measure">${esc(MEASURE_WORD[x.measure])}</span>` : "")))
    + sec(COMPANY_HEADS.competitors, ul(d.competitors ?? [], (x) => li(x, `<b>${esc(x.name)}</b>: `)))
    + sec(COMPANY_HEADS.role_asks, ul(d.role_asks ?? [], (x) => li(x)))
    + sec(COMPANY_HEADS.project, proj)
    + sec(COMPANY_HEADS.questions, qs)
    + sec(COMPANY_HEADS.five, five)
    + sec(COMPANY_HEADS.unknowns, cannot.length ? `<ul class="rb-list rb-gaps">${cannot.map((g: string) => `<li><span class="rb-t">${esc(g)}</span><span class="rb-chips"><span class="src">Unknown</span></span></li>`).join("")}</ul>` : "")
    + sec(COMPANY_HEADS.sources, srcs) + `</div>`;
}
function companyText(d: any, L: string[]) {
  const S = d.sources ?? [], c = (x: any) => Array.isArray(x?.cite) && x.cite.length ? ` ${x.cite.map((i: number) => `[${i}]`).join("")}` : "";
  const lim = (x: any) => (x?.cite ?? []).filter((i: number) => S[i - 1]?.limit).map((i: number) => ` (source [${i}] ${LIMIT_WORD[S[i - 1].limit]}${S[i - 1].dated ? `, ${S[i - 1].dated}` : ""})`).join("");
  if (d.role) L.push(`Role: ${d.role}`);
  if (d.frame) L.push(`## ${COMPANY_HEADS.answer}`, `${d.frame.text}${c(d.frame)} [Trainee's reading]${lim(d.frame)}`, "");
  L.push(`${marketReadOn(d) ? `Sources read ${marketReadOn(d)}. ` : ""}Research only: nothing was sent or applied for.`, "");
  const block = (h: string, xs: any[], f: (x: any) => string) => { if (!xs?.length) return; L.push(`## ${h}`); xs.forEach((x) => L.push(f(x))); L.push(""); };
  const prods = (d.products ?? []) as { name: string; angle: string }[], inProd = (x: any) => !!x.product && prods.some((p) => p.name.toLowerCase() === String(x.product).toLowerCase());
  block(COMPANY_HEADS.business, (d.business ?? []).filter((x: any) => !inProd(x)), (x) => `- ${x.text}${c(x)}${lim(x)}`);
  if (!d.focus) block(COMPANY_HEADS.evidence, companyEvidence(d), ([k, v]) => `- ${k}: ${v}`);
  prods.forEach((p) => block(`${p.name}: ${p.angle}`, (d.business ?? []).filter((x: any) => String(x.product ?? "").toLowerCase() === p.name.toLowerCase()), (x) => `- ${x.text}${c(x)}${lim(x)}`));
  block(COMPANY_HEADS.developments, d.developments, (x) => `- ${x.date}: ${x.text}${c(x)}${x.measure ? ` (${MEASURE_WORD[x.measure]})` : ""}${lim(x)}`);
  block(COMPANY_HEADS.competitors, d.competitors, (x) => `- ${x.name}: ${x.text}${c(x)}${lim(x)}`);
  block(COMPANY_HEADS.role_asks, d.role_asks, (x) => `- ${x.text}${c(x)}${lim(x)}`);
  if (d.project) { L.push(`## ${COMPANY_HEADS.project}`); (d.project.ties ?? []).forEach((t: any) => { L.push(`- Your confirmed fact: ${t.fact}`); t.ties.forEach((y: any) => L.push(`  - The role page asks: ${y.text}${c(y)}`)); }); if ((d.project.ties ?? []).length) L.push(OVERSTATE); if (d.project.missing) L.push(d.project.missing); L.push(""); }
  block(COMPANY_HEADS.questions, d.questions, (x) => `- ${x.text} (grounded in${c(x)})${lim(x)}`);
  block(COMPANY_HEADS.five, d.five, (f) => `- ${f.label}: ${f.text}${c(f)}`);
  block(COMPANY_HEADS.unknowns, [...(d.unknowns ?? []), ...(d.unread ?? [])], (g) => `- ${g} [Unknown]`);
  L.push(`## ${COMPANY_HEADS.sources}`); S.forEach((s: any, i: number) => L.push(`${i + 1}. ${s.title}: ${s.url} (${s.by === "company" ? "the company's own page" : "reported elsewhere"}; read ${DAY(s.fetched_at)}${s.limit ? `; ${LIMIT_WORD[s.limit]}${s.dated ? ` ${s.dated}` : ""}` : ""})`)); L.push("");
}
function marketText(d: any, L: string[]) {
  const c = (x: any) => Array.isArray(x?.cite) && x.cite.length ? ` ${x.cite.map((i: number) => `[${i}]`).join("")}` : "";
  const read = marketReadOn(d);
  L.push(`${d.thesis}${c({ cite: d.thesis_cite })}${d.thesis_summary ? " (A summary of the cited sections below.)" : ""}`, `${read ? `Sources read ${read}. ` : ""}${(d.sources ?? []).length} source${(d.sources ?? []).length === 1 ? "" : "s"}.`, "", "## Summary");
  Fs(d.summary).forEach((f) => L.push(`- ${f.text}${c(f)} [${f.source}]`)); L.push("");
  if (d.comparison) {
    const opts = (d.comparison.options ?? []).map((o: any) => o.name);
    L.push("## Comparison"); (d.comparison.rows ?? []).forEach((r: any) => { L.push(`### ${r.label}`); (r.cells ?? []).forEach((x: any, i: number) => L.push(hasSrc(x) ? `- ${opts[i]}: ${x.value}${c(x)} [${x.source}]` : `- ${opts[i]}: Not stated`)); }); L.push("");
  }
  if ((d.disagreements ?? []).length) { L.push("## Where the sources differ"); d.disagreements.forEach((x: any) => L.push(`- ${x.label}: ${x.values.map((y: any) => `${y.value}${c(y)}`).join(" · ")}. The sources differ; Trainee has not picked one.`)); L.push(""); }
  L.push("## What would have to be true"); (d.conditions ?? []).forEach((f: any) => L.push(`- ${f.text}${c(f)} [Trainee's reading]`)); L.push("");
  L.push("## Risks"); (d.risks ?? []).forEach((f: any) => L.push(`- ${f.text}${c(f)} [Trainee's reading]`)); L.push("");
  if ((d.basis ?? []).length) { L.push("## How the sources were chosen"); d.basis.forEach((g: string) => L.push(`- ${g}`)); L.push(""); }
  if ((d.gaps ?? []).length) { L.push("## Not found in a free source"); d.gaps.forEach((g: string) => L.push(`- ${g}`)); L.push(""); }
  L.push("## Sources"); (d.sources ?? []).forEach((s: any, i: number) => L.push(`${i + 1}. ${s.title}: ${s.url} (read ${DAY(s.fetched_at)})`)); L.push("");
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
    case "application_review":
      if (d.ids) L.push(d.ids, "");
      L.push(...reviewLines(d), "");
      break;
    case "application_proof": {
      const c = d.confirmation ?? {};
      if (d.review) { L.push(...reviewLines(d), ""); break; }
      const st = d.stage as Stage | undefined;
      L.push(st ? `Status: ${STAGE_LABEL[st]}. ${STAGE_NOTE[st]}` : `Status: ${cap1(d.status)}. ${STATUS_NOTE[d.status] ?? ""}`, "");
      if (st && st !== "employer_confirmed") { h("Proof"); L.push(`${PROOF_HEAD[st] ?? "No submission confirmation"}. ${PROOF_BODY[st] ?? PROOF_BODY.none}`, ""); }
      h(!st || st === "employer_confirmed" || st === "submitted_unconfirmed" ? "What was submitted" : "The application"); L.push(`- Company: ${d.company} [${RECORDS}]`);
      if (d.role) L.push(`- Role: ${d.role} [${RECORDS}]`);
      for (const [k, v] of [["Sent to", d.destination], ["Resume", d.resume], ["Prepared", when(d.prepared_at)], ["Submitted", when(d.submitted_at)], ["Last updated", when(d.as_of)]]) if (v) L.push(`- ${k}: ${v} [${RECORDS}]`);
      L.push(""); if (c.id || c.url || c.screenshot_url) { h("Confirmation"); if (c.id) L.push(st && st !== "employer_confirmed" ? `- Their page showed ${c.id}; this is not the employer's confirmation [${RECORDS}]` : `- Confirmation ID: ${c.id} [${RECORDS}]`); if (c.url) L.push(`- Confirmation: ${c.url}`); if (c.screenshot_url) L.push(`- Screenshot: ${c.screenshot_url}`); L.push(""); }
      else if (d.email_confirmed_at) { h("Confirmation"); L.push(`- Confirmed by ${d.company}'s own email, received ${when(d.email_confirmed_at)} [${RECORDS}]`, ""); }
      if (Fs(d.answers, true).length) { h("Answers given"); Fs(d.answers, true).forEach((a) => L.push(factText(a, a.question))); L.push(""); }
      const pr = (d.problems ?? []).filter((p: any) => p?.reason); if (pr.length) { h("Not done"); pr.forEach((p: any) => L.push(`- ${cap1(p.outcome)}: ${p.item}. ${p.reason} [${RECORDS}]`)); L.push(""); }
      const fl = Array.isArray(rec.state?.flags) ? rec.state.flags : []; if (fl.length) { h("Flagged by you"); fl.forEach((f: any) => L.push(`- ${when(f.at)}: ${f.note}`)); L.push(""); }
      break;
    }
    case "plan_review":
      if (d.period) L.push(d.period, "");
      for (const s of d.sections ?? []) { h(s.heading); Fs(s.items, false, true).forEach((f) => L.push(factText(f, f.label))); L.push(""); }
      break;
    case "comparison": {
      const opts = (d.options ?? []).map((o: any) => o.name);
      (d.rows ?? []).forEach((r: any) => { h(r.label); (r.cells ?? []).forEach((c: any, i: number) => L.push(hasSrc(c) ? factText(c, opts[i]) : `- ${opts[i]}: Not stated`)); L.push(""); });
      break;
    }
    case "draft":
      if (d.variant === "resume") { L.push(`For ${d.target}`, ...(d.review ? ["Review draft, not for external submission."] : []), ...(d.note ? [d.note] : []), `File: ${d.filename}`, ""); break; }
      L.push(`${cap1(String(d.type).replace("_", " "))}${d.to ? ` to ${d.to}` : ""}`); if (d.subject) L.push(`Subject: ${d.subject}`); L.push("", d.body, "");
      if (Fs(d.basis).length) { h("What it says about you"); Fs(d.basis).forEach((f) => L.push(factText(f, f.label))); L.push(""); }
      L.push("Sending: not from this file. Ask Trainee in Telegram; you approve the exact message first.", "");
      break;
    case "tracker":
      if (d.changes?.length) { h("Corrected since last time"); d.changes.forEach((c: string) => L.push(`- ${c}`)); L.push(""); }
      h("Applications"); if (!(d.applied ?? []).length) L.push("None on record.");
      (d.applied ?? []).forEach((a: any) => { L.push(`- ${a.company}${a.role ? `, ${a.role}` : ""}${a.applied_on ? `, applied ${a.applied_on}` : ""}: ${a.status} [${a.source}]`); (a.evidence ?? []).forEach((e: any) => L.push(`  - ${e.what}${e.on ? ` (${e.on})` : ""}${e.text ? `: ${e.text}` : ""}`)); });
      L.push(""); h("Researched, not applied"); if (!(d.researched ?? []).length) L.push("None on record.");
      (d.researched ?? []).forEach((r: any) => L.push(`- ${r.company}${r.role ? `, ${r.role}` : ""}: ${r.status}${r.url ? ` ${r.url}` : ""}`));
      L.push(""); h("Drafts, not submitted or sent"); if (!(d.drafts ?? []).length) L.push("None on record.");
      (d.drafts ?? []).forEach((x: any) => L.push(`- ${x.company ? `${x.company}: ` : ""}${x.what}, ${x.status}${x.since ? ` (since ${x.since})` : ""}`));
      L.push(""); h("What this covers"); (d.coverage ?? []).forEach((c: string) => L.push(`- ${c}`)); L.push("");
      break;
    case "research_brief":
      if (d.variant === "market") { marketText(d, L); break; }
      if (d.variant === "company") { companyText(d, L); break; }
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
.src{display:inline-block;margin-left:4px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;font-size:14px;color:var(--mute);white-space:nowrap}
ul.why{margin:0;padding-left:20px}ul.why li{margin:0 0 8px;overflow-wrap:anywhere}
.msg{margin:8px 0;padding:12px 14px;border-left:3px solid var(--accent);background:transparent;white-space:pre-wrap;overflow-wrap:anywhere}
.meta{margin:2px 0;font-size:15px;color:var(--mute)}.unconf{font-size:16px}.unconf .v{display:inline;max-width:none}.state{margin:0 0 8px;font-size:18px}.state.failed{color:var(--bad)}.state.confirmed,.state.submitted{color:var(--good)}
.note-top{margin:8px 0 14px;padding:10px 12px;border:1px solid var(--line);border-radius:10px}
.tbl{overflow-x:auto}.tbl:focus-visible{outline:3px solid var(--accent)}table{border-collapse:collapse;width:100%;font-size:16px}th,td{padding:10px 8px;border-top:1px solid var(--line);text-align:left;vertical-align:top}thead th{border-top:0;font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.act1{margin:0 0 14px}.anote{margin:4px 0 0;font-size:15px;color:var(--mute)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-width:96px;min-height:48px;padding:6px 20px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}.btn:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.ghost{background:transparent;color:var(--link)}.btn.off{background:transparent;color:var(--mute);border-color:var(--line);cursor:default}
label,.lbl{display:block;margin:8px 0 4px;font-size:15px;color:var(--mute)}
textarea{width:100%;min-height:96px;padding:10px 12px;border:1px solid var(--mute);border-radius:10px;background:transparent;color:var(--ink);font:inherit;font-size:16px}textarea.draft{min-height:240px}
.foot{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:15px;color:var(--mute)}.foot a{color:var(--link)}
/* BETA C03 (2026-11-04): the footer link was 40 px tall at 360 px; every tap target is 44 px (tests/architect/prep-file.test.ts PF-6). */
.foot a{display:inline-flex;align-items:center;min-height:44px}
/* BETA C03: the interview prep File, compact at 360 px (bodyHtml plan_review interview_prep). */
.prep .blk{padding:12px 0}.prep .blk h2{margin:0 0 6px}.prep .fact{margin:0 0 8px}.prep .fact:last-child{margin-bottom:0}
.prep .fact dt{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.prep .fact dt .src{margin-left:0;font-size:13px;padding:0 7px}
.prep .fact dd{font-size:17px;line-height:1.4}.fcard:has(.prep){padding:20px 14px 20px}
/* R9-C: the market research brief. Tokens only, no new hue: the cover is the warm ground inside the card, like the link preview. */
.rb-cover{margin:16px 0 4px;padding:18px 18px 16px;border:1px solid var(--line);border-radius:16px;background:var(--bg)}
.rb-brand{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:14px;font-weight:600;color:var(--mute)}.rb-brand span:nth-of-type(1){font-family:'Brygada 1918',Georgia,serif;font-size:17px;color:var(--ink)}
.rb-mark{width:22px;height:22px;flex:none}.rb-thesis{margin:0;font-family:'Brygada 1918',Georgia,serif;font-size:24px;line-height:1.25;font-weight:500;overflow-wrap:anywhere}
.rb-date{margin:12px 0 0;font-size:15px;color:var(--mute)}.rb-basis{margin:8px 0 0;font-size:15px;color:var(--mute)}.rb-thesis .rb-cite{font-family:'Inter',system-ui,sans-serif}
/* R9 free sources: a source's host never breaks mid-word; a host longer than the line ends in an ellipsis (its full name is the
   link above and the title attribute). */
ol.rb-src .rb-host{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
ul.rb-list{margin:0;padding-left:20px}ul.rb-list li{margin:0 0 12px;overflow-wrap:anywhere}.rb-list .src{display:block;margin:4px 0 0;width:fit-content}
/* R10 WO-H: the company interview brief. Chips sit on their own row under each line and wrap; dates stay with their line. */
.rb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}.rb-chips .src{margin-left:0;white-space:normal}.rb-day{font-weight:600;white-space:nowrap}
.rb-limit{border-color:var(--ink);color:var(--ink)}.rb-answer{margin:0;font-family:'Brygada 1918',Georgia,serif;font-size:20px;line-height:1.35;overflow-wrap:anywhere}
dl.rb-kv{margin:0}dl.rb-kv>div{display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr);gap:4px 16px;padding:10px 0;border-top:1px solid var(--line)}dl.rb-kv>div:first-child{border-top:0}
dl.rb-kv dt{color:var(--mute);font-size:15px}dl.rb-kv dd{margin:0;overflow-wrap:anywhere}@media (max-width:560px){dl.rb-kv>div{grid-template-columns:1fr}}/* R10 WO-H: the research brief is a document page (spec C.0/C.19, target p-87..p-89): no card frame, a large serif title, a text
   column near 640 px, a notice box, serif section heads, grey key-value labels and a thin-rule caution block. */
.fcard:has(.rb-co){background:transparent;border:0;box-shadow:none;padding:8px 0 28px}.fcard:has(.rb-co) .ftitle{font-size:34px}
.rb-co{max-width:680px}.rb-sub{margin:6px 0 0}.rb-notice{margin:16px 0 4px;padding:12px 14px;border-radius:6px;background:var(--tint);font-size:15px}.rb-notice b{display:block;margin:0 0 2px}
.rb-proj{margin:0 0 12px}.rb-proj p{margin:0 0 6px;overflow-wrap:anywhere}
.rb-co .blk h2{font-family:'Brygada 1918',Georgia,serif;font-size:21px;font-weight:500;line-height:1.25}.rb-caution{margin:12px 0 0;padding-left:12px;border-left:2px solid var(--line);font-size:15px;color:var(--mute)}ol.rb-qs{margin:0;padding-left:22px}ol.rb-qs li{margin:0 0 14px;overflow-wrap:anywhere}ol.rb-src .rb-lim{grid-column:2}
.rb-cite{font-size:14px;color:var(--mute);white-space:nowrap;font-variant-numeric:tabular-nums}
ol.rb-src{list-style:none;margin:0;padding:0}ol.rb-src li{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:6px;align-items:baseline;padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}ol.rb-src li:first-child{border-top:0}
ol.rb-src a{display:inline-flex;align-items:center;min-height:44px;color:var(--link);font-weight:600}ol.rb-src .meta{display:block;grid-column:2}.rb-n{color:var(--mute);font-variant-numeric:tabular-nums}
@media (min-width:720px){.rb-cover{padding:24px 26px 20px}.rb-thesis{font-size:28px}}
/* R9-F: the comparison table at phone width. Under 560 px each row is a card on the warm ground (like the cover), its label on top and
   one option/value pair per line; wider, it is the plain table and the per-cell option label is hidden. Tokens only. */
.rb-tbl .rb-k{display:none}
@media (max-width:559.98px){
.rb-tbl{overflow-x:visible}.rb-tbl table,.rb-tbl tbody,.rb-tbl tr,.rb-tbl th,.rb-tbl td{display:block;width:auto}
.rb-tbl thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rb-tbl tr{margin:0 0 12px;padding:2px 14px 4px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}.rb-tbl tr:last-child{margin-bottom:0}
.rb-tbl tbody th{padding:12px 0 8px;border-top:0;font-weight:600;overflow-wrap:anywhere}
.rb-tbl td{display:grid;grid-template-columns:minmax(0,38%) minmax(0,1fr);column-gap:12px;align-items:baseline;padding:10px 0;overflow-wrap:anywhere}
.rb-tbl .rb-k{display:block;font-size:15px;color:var(--mute)}.rb-tbl .rb-v .src{margin:4px 0 0}
}
`;
