// WO-G (R10 fixes 12 and 13, spec APP-LAYER-15-FIXES B.3, C.11, C.12, C.21, C.23 item 10, E.3): the application review is
// the exact approval artifact, and every state the person sees matches what really happened. Pure functions, no I/O.
//
//   reviewOf / reviewText   one section per employer: the role and its application page, the resume (its name, its file and
//                           the first 12 characters of the hash the approval binds), every file, every answer exactly as it
//                           will be sent, and every required question still unanswered. What the payload hash covers is said
//                           in words. An application with an unanswered required fact is never approvable.
//   sensitiveOf             graduation date, availability, work authorization, sponsorship, GPA, outside business and
//                           conflicts: facts only the person can give. A blank one stays visibly unresolved, never defaulted.
//   narrowQuestion          the one factual question for an unresolved fact, in the form's own words, for that employer.
//   stageOf                 the one visible state of an application: prepared, approved, sending, uncertain,
//                           submitted_unconfirmed, employer_confirmed (or needs_you, not_sent, failed). Confirmed needs the
//                           employer's own evidence (their email, or the reference their page or ATS returned); without it the
//                           row is said as sent and not confirmed. Nothing here ever makes up a confirmation.
//   closeoutText            spec B.3's closeout, from the real outcome only: "Submitted <role> at <employer> at <time>.
//                           Confirmation: <the employer's own reference>." for a confirmed one; everything else says what it is.
import { mapQuestion } from "./question_map.ts";
import { reasonWords } from "./career_apply_status.ts";

export const SENSITIVE = ["graduation_date", "availability", "work_authorization", "sponsorship", "gpa", "outside_business", "conflicts"] as const;
export type Sensitive = typeof SENSITIVE[number];
const SENSITIVE_WORDS: Record<Sensitive, string> = {
  graduation_date: "graduation date", availability: "availability", work_authorization: "work authorization", sponsorship: "sponsorship",
  gpa: "GPA", outside_business: "outside business activity", conflicts: "conflicts of interest",
};
const FACT_OF: Record<string, Sensitive> = {
  graduation_date: "graduation_date", gpa: "gpa", work_authorization: "work_authorization", us_person: "work_authorization",
  sponsorship: "sponsorship", start_date: "availability", job_onsite: "availability",
};
// A question about one of the facts only the person can answer, or null.
export function sensitiveOf(label: unknown): Sensitive | null {
  const t = String(label ?? "").toLowerCase();
  if (/\boutside (?:business|employment|work|activit)|\bside (?:business|job|gig)|\bmoonlight|\bother (?:business|employment)\b/.test(t)) return "outside_business";
  if (/\bconflicts? of interest\b|\bconflict(?:ing)? (?:interest|relationship|obligation)/.test(t)) return "conflicts";
  return FACT_OF[mapQuestion({ label: String(label ?? "") } as never).fact] ?? null;
}
const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

// The narrow factual question for one unresolved answer (spec B.3: "For [employer], the form asks ... I do not have your
// answer. What should I enter?"): the form's own words and choices, for that employer, never a questionnaire of known facts.
export function narrowQuestion(q: { label: string; company?: string | null; options?: string[] }): string {
  const who = one(q.company, 80) || "this employer", opts = (q.options ?? []).map((o) => one(o, 60)).filter(Boolean).slice(0, 6);
  return `For ${who}, the form asks: "${one(q.label, 200)}". I don't have your answer, and I won't pick one for you. What should I enter?` +
    (opts.length ? ` The form's choices: ${opts.join(" / ")}.` : "");
}

// ------------------------------------------------------------------------------------------------ the review
export interface ReviewInput {
  id: string; payload: any; payload_hash: string; card_lines?: string[];
  title?: string | null; // the posting's role, from the posting record (never from the model)
  open?: { label: string; options?: string[] }[]; // the employer's required questions still unanswered for this posting
  // Item 6 S1: the resume file's own record (career:resume-versions, career_resume_outcomes.ts VersionEntry) when Trainee made it.
  resume_version?: { n: number; at: string | null } | null;
}
// Item 6 S1: where an answer came from, in words, from the fact id the preparer bound it to (career_apply.ts PlannedField.factId).
// No fact id is said as such: it is never presented as confirmed (D-024).
export function sourceOf(factId: unknown): string {
  const f = String(factId ?? "").trim();
  if (!f) return "Source not on record";
  if (/^(basics|profile)\./.test(f)) return "From your confirmed profile";
  if (/^(text-answer|chat_answer|answer)[:.]/.test(f)) return "Your answer in the chat";
  if (f === "batch_approval") return "From your batch approval";
  return "From a fact you confirmed";
}
// Item 6 S1: the resume as a person reads it: name, version, what it targets, and the date it was made. Never a hash prefix.
export interface ResumeMeta { name: string; version: string; target: string; at: string | null }
export function resumeLabelOf(m: ResumeMeta, tz?: string | null): string {
  const d = m.at && Number.isFinite(Date.parse(m.at)) ? (() => { const f = (timeZone: string) => new Date(Date.parse(m.at!)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }); try { return f(tz || "UTC"); } catch { return f("UTC"); } })() : null;
  return [m.name, m.version, m.target, d ? `made ${d}` : "date not on file"].join(" - ");
}
// The resume on the chat review line: its name, then which version it is and what it targets ("base version, not tailored for
// this role"; "version 2, tailored for <role> at <employer>").
export function resumeChatLabel(m: ResumeMeta): string {
  const v = m.version === "your base resume" ? "base version" : m.version;
  return `${m.name} (${v}, ${m.target})`;
}
export interface ReviewItem {
  id: string; job_id: string | null; employer: string; role: string | null; url: string | null; destination: string | null;
  resume: { label: string; sha12: string } | null; files: string[];
  resume_meta?: ResumeMeta; // item 6 S1: the resume in words (name, version, target, date) for the F-09 page
  answers: { question: string; answer: string; sensitive: Sensitive | null; source?: string }[];
  payload_hash?: string; // item 6 S1: the full hash the review File's Approve is bound to (D-MS-1)
  unresolved: { question: string; fact: Sensitive | null; ask: string }[];
  page_fields: string[]; hash12: string; approvable: boolean; covers: string[]; expires_at: string | null; letter: boolean;
}
const isResumeField = (f: any, sha: string) => f?.value === sha || /file/i.test(String(f?.type ?? "")) || (f?.value && typeof f.value === "object");
export function reviewOf(x: ReviewInput): ReviewItem {
  const p = x.payload ?? {}, sha = String(p.resume_sha256 ?? ""), employer = one(p.company, 100) || "the employer";
  const fields = (Array.isArray(p.fields) ? p.fields : []).filter((f: any) => !isResumeField(f, sha));
  const answers: ReviewItem["answers"] = [], unresolved: ReviewItem["unresolved"] = [];
  for (const f of fields) {
    const question = one(f?.label ?? f?.name, 200), fact = sensitiveOf(question);
    // A blank answer is not an answer: shown unresolved, never sent as a default (D-007).
    if (blank(f?.value)) unresolved.push({ question, fact, ask: narrowQuestion({ label: question, company: employer }) });
    else answers.push({ question, answer: String(f.value === true ? "Yes" : f.value === false ? "No" : f.value).replace(/\s+/g, " ").trim().slice(0, 2000), sensitive: fact, source: sourceOf(f?.factId) });
  }
  for (const q of x.open ?? []) {
    const question = one(q.label, 200);
    if (!unresolved.some((u) => u.question === question)) unresolved.push({ question, fact: sensitiveOf(question), ask: narrowQuestion({ label: question, company: employer, options: q.options }) });
  }
  // The resume line the card already carries (career_prepared_card.ts resumeCardLine): "Resume: <name>" (before R6, with
  // "(<sha12>)" after it, which a card prepared earlier may still carry).
  const line = (x.card_lines ?? []).find((l) => /^Resume: /.test(String(l)));
  const label = line ? String(line).replace(/^Resume: /, "").replace(/\s*\([0-9a-f]{12}\)$/, "") : "your confirmed resume";
  const tailored = /, tailored for this role$/.test(label) || p.resume_tailored === true;
  const name = one(label.replace(/, tailored for this role$/, ""), 120);
  const meta: ResumeMeta = { name, version: x.resume_version ? `version ${x.resume_version.n}` : tailored ? "version not recorded" : "your base resume",
    target: tailored ? `tailored for ${one(x.title, 120) || "this role"} at ${employer}` : "not tailored for this role", at: x.resume_version?.at ?? null };
  const resume = /^[0-9a-f]{64}$/.test(sha) ? { label: name, sha12: sha.slice(0, 12) } : null;
  const files = [...(resume ? [`Resume: ${resume.label}`] : []), ...(p.cover_note && typeof p.cover_note === "object" && p.cover_note.text ? ["Cover note (its full text is under the answers)"] : [])];
  if (p.cover_note?.text) answers.push({ question: "Cover note", answer: one(p.cover_note.text, 4000), sensitive: null, source: "Drafted by Trainee; your yes approves this exact text" });
  const page_fields = Array.isArray(p.page_field_names) ? p.page_field_names.map((s: unknown) => one(s, 80)) : [];
  const url = /^https?:\/\//.test(String(p.url ?? "")) ? one(p.url, 500) : null, destination = one(p.destination, 500) || null;
  const role = one(x.title, 120) || null, hash12 = String(x.payload_hash ?? "").slice(0, 12);
  const covers = [`the employer: ${employer}`, ...(role ? [`the role: ${role}`] : []), ...(url ? [`the application page: ${url}`] : []),
    ...(destination ? [`where it is sent: ${destination}`] : []), ...(resume ? [`the resume file ${resume.sha12}`] : []),
    `${answers.length} answer${answers.length === 1 ? "" : "s"}, word for word as shown`, ...(page_fields.length ? [`the fields the employer's page sets: ${page_fields.join(", ")}`] : [])];
  const expires_at = Number.isFinite(Date.parse(String(p.expires_at ?? ""))) ? new Date(Date.parse(p.expires_at)).toISOString() : null;
  return { id: x.id, job_id: one(p.job_id, 200) || null, employer, role, url, destination, resume, files, answers, unresolved, page_fields, hash12, approvable: !!resume && !unresolved.length, covers, expires_at, letter: !!p.cover_note?.text,
    ...(resume ? { resume_meta: meta } : {}), ...(/^[0-9a-f]{64}$/.test(String(x.payload_hash ?? "")) ? { payload_hash: String(x.payload_hash) } : {}) };
}

// The review in words: the card's "full review" and the plain-text twin of the review File. Nothing here is a success word.
export function reviewText(items: ReviewItem[]): string {
  const out: string[] = [];
  items.forEach((r, i) => {
    out.push(`${i + 1}. ${r.employer}${r.role ? `: ${r.role}` : ""}. Not submitted.`);
    if (r.url) out.push(`   Application page: ${r.url}`);
    out.push(`   Resume: ${r.resume ? `${r.resume.label} (file ${r.resume.sha12})` : "none, so this cannot be sent"}`);
    if (r.files.length) out.push(`   Files: ${r.files.join("; ")}`);
    out.push(`   Answers that will be sent, exactly:`, ...r.answers.map((a) => `   - ${a.question}: ${a.answer}${a.sensitive ? " (your answer)" : ""}`));
    if (r.unresolved.length) out.push(`   Unresolved (nothing is sent until you answer):`, ...r.unresolved.map((u) => `   - ${u.question}: not entered. ${u.ask}`));
    out.push(r.approvable
      ? `   Your yes covers exactly this (approval ${r.hash12}): ${r.covers.join("; ")}. A different employer, role, resume, answer or a bigger batch needs a new review.`
      : `   Not ready to approve: ${r.resume ? `${r.unresolved.length} required answer${r.unresolved.length === 1 ? "" : "s"} still unresolved` : "no resume"}. Approving wording never answers these.`);
  });
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------ states
export type Stage = "prepared" | "approved" | "sending" | "uncertain" | "submitted_unconfirmed" | "employer_confirmed" | "needs_you" | "not_sent" | "failed";
export const STAGE_LABEL: Record<Stage, string> = {
  prepared: "Ready for review, not submitted", approved: "Approved, not sent yet", sending: "Approved, sending not confirmed",
  uncertain: "Submission may have landed", submitted_unconfirmed: "Sent, not confirmed by the employer", employer_confirmed: "Employer confirmation verified",
  needs_you: "Needs you", not_sent: "Not sent", failed: "Not accepted by the employer's form",
};
export const STAGE_NOTE: Record<Stage, string> = {
  prepared: "Ready for your review. A prepared form is not a submitted application.",
  approved: "You approved it; it has not been sent. A queue entry is not an application.",
  sending: "Being sent now. Not submitted until the employer's page answers.",
  uncertain: "The final step may have landed, but the employer has not confirmed it. It will not be sent again; it counts as submitted only once the employer's email or status page shows it.",
  submitted_unconfirmed: "It reached the employer's form, but the employer has not confirmed it yet. Their email or status page is the proof.",
  employer_confirmed: "The employer's own confirmation is on record.",
  needs_you: "Stopped; it needs you.", not_sent: "Nothing reached the employer.", failed: "The employer's form did not accept it.",
};
export interface RecordRow {
  state: string; reason?: string | null; company?: string | null; title?: string | null;
  confirmation_id?: string | null; email_confirmed_at?: string | null; confirmation_mail_hash?: string | null; sent_at?: string | null;
}
// The employer's own evidence (architect, #632 review 13-Obs): their email, matched to this application by
// career_apply_confirm.ts and recorded with the time and the matched message's hash. A reference the page or ATS showed
// (career_apply.ts ID) is said as what it is, "their page showed X", never as the employer's confirmation.
export function evidenceOf(r: RecordRow): { email_at: string } | null {
  return r.email_confirmed_at && Number.isFinite(Date.parse(r.email_confirmed_at)) && /^[0-9a-f]{16,128}$/i.test(String(r.confirmation_mail_hash ?? ""))
    ? { email_at: r.email_confirmed_at } : null;
}
// A reference the employer's page or ATS showed after the send (an id label with a digit in it), or null.
export function pageReferenceOf(r: RecordRow): string | null {
  const id = one(r.confirmation_id, 80);
  return /^[A-Z0-9][A-Z0-9-]{4,}$/i.test(id) && /\d/.test(id) ? id : null;
}
export function stageOf(r: RecordRow): Stage {
  switch (r.state) {
    case "queued": return "approved";
    case "driving": return "sending";
    case "unknown_outcome": return "uncertain";
    case "submitted_unconfirmed": return "submitted_unconfirmed";
    case "confirmed": return evidenceOf(r) ? "employer_confirmed" : "submitted_unconfirmed";
    case "needs_user": return "needs_you";
    case "failed": return "failed";
    case "not_submitted": return "not_sent";
    default: return "prepared";
  }
}

const at = (iso: string | null | undefined, tz?: string | null) => {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const f = (timeZone: string) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
  try { return f(tz || "UTC"); } catch { return f("UTC"); }
};
// Spec B.3's closeout, one line per application, from the record only.
export function closeoutLine(r: RecordRow, tz?: string | null): string {
  const who = one(r.company, 80) || "the employer", what = one(r.title, 120), name = what ? `${what} at ${who}` : `the application to ${who}`;
  const when = at(r.sent_at, tz), s = stageOf(r);
  switch (s) {
    case "employer_confirmed": {
      const ev = evidenceOf(r)!;
      const ref = pageReferenceOf(r);
      return `Submitted ${name}${when ? ` at ${when}` : ""}. Confirmation: ${who}'s confirmation email (${at(ev.email_at, tz)})${ref ? `; their page showed ${ref}` : ""}.`;
    }
    case "submitted_unconfirmed": {
      const ref = pageReferenceOf(r);
      return `Sent ${name}${when ? ` at ${when}` : ""}; ${ref ? `their page showed ${ref}, but ` : ""}${who} has not confirmed it by email yet, so it is not confirmed. Their email or status page is the proof.`;
    }
    case "uncertain": return `${cap(name)}: the final step may have landed, but ${who} has not confirmed it. I won't send it again; it counts as submitted only once ${who}'s email or status page shows it.`;
    case "sending": return `${cap(name)}: being sent now; not submitted yet.`;
    case "approved": return `${cap(name)}: approved, not sent yet.`;
    case "needs_you": case "not_sent": case "failed": return `${cap(name)}: not submitted (${reasonWords(r.state, r.reason)}).`;
    default: return `${cap(name)}: prepared, not submitted.`;
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The closeout for a batch: confirmed first, then the rest, then each prepared one held by an unanswered question, named.
// Counts are never mixed: a prepared or queued one is never in a "submitted" line.
export function closeoutText(rows: RecordRow[], o: { tz?: string | null; held?: ReviewItem[] } = {}): string {
  const order: Stage[] = ["employer_confirmed", "submitted_unconfirmed", "uncertain", "sending", "approved", "needs_you", "not_sent", "failed", "prepared"];
  const lines = [...rows].sort((a, b) => order.indexOf(stageOf(a)) - order.indexOf(stageOf(b))).map((r) => closeoutLine(r, o.tz));
  for (const h of o.held ?? []) {
    const name = `${h.role ? `${h.role} at ` : ""}${h.employer}`;
    lines.push(h.unresolved.length
      ? `${cap(name)} is ready but not submitted because "${h.unresolved[0].question}" is unanswered. ${h.unresolved[0].ask}`
      : `${cap(name)} is ready for your review, not submitted.`);
  }
  return lines.join("\n");
}

// The card's review links (career_apply_cards.ts cardTurn review): one review File per application shown, built from the
// prepared payload, the posting's own title and the employer's still-open required questions. Null when none could be made.
export interface ReviewDeps {
  prepared(ids: string[]): Promise<{ id: string; job_id?: string | null; payload: any; payload_hash: string; card_lines?: string[]; created_at?: string | null }[]>;
  titles?(jobIds: string[]): Promise<Map<string, string>>;
  open?(jobIds: string[]): Promise<{ label: string; options?: string[]; job_ids?: string[] }[]>;
  create(item: ReviewItem): Promise<{ url: string | null } | null>;
  // Item 6 S1: the person's resume-version record (career:resume-versions) by file sha256, when it can be read.
  versions?(): Promise<Record<string, { n: number; at?: string | null }>>;
}
export async function reviewLinksFor(shown: { id: string }[], d: ReviewDeps): Promise<string | null> {
  const rows = await d.prepared(shown.map((p) => p.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const titles = d.titles ? await d.titles(rows.map((r) => String(r.job_id ?? "")).filter(Boolean)).catch(() => new Map<string, string>()) : new Map<string, string>();
  const open = d.open ? await d.open(rows.map((r) => String(r.job_id ?? "")).filter(Boolean)).catch(() => []) : [];
  const versions = d.versions ? await d.versions().catch(() => ({} as Record<string, { n: number; at?: string | null }>)) : {};
  const lines: string[] = [], held: string[] = [];
  for (const [i, p] of shown.entries()) {
    const r = byId.get(p.id);
    if (!r) continue;
    const job = String(r.job_id ?? "");
    const v = versions[String(r.payload?.resume_sha256 ?? "")];
    const item = reviewOf({ ...r, title: titles.get(job) ?? null, open: open.filter((q) => job && (q.job_ids ?? []).includes(job)),
      resume_version: v && Number.isInteger(v.n) && v.n > 0 ? { n: v.n, at: typeof v.at === "string" ? v.at : null } : null });
    const made = await d.create(item).catch(() => null);
    // R10 fix 12 (spec B.3, E.3 25): the chat names what the File holds for each one, not only its link: the employer's
    // application page and the resume by a human label (never a hash prefix).
    if (made?.url) lines.push([`${i + 1}. ${item.employer}${item.role ? `, ${item.role}` : ""}: ${made.url}`,
      ...(item.url ? [`   Application page: ${item.url}`] : []), ...(item.resume_meta ? [`   Resume: ${resumeChatLabel(item.resume_meta)}`] : [])].join("\n"));
    // Owner clarification (2026-11-09, D-MS-1 item 4): one held for an unanswered required question stays out of the set a
    // yes approves, and the card says so, with the one narrow question.
    if (item.unresolved.length) held.push(`${i + 1}. ${item.employer}: held back, so a yes does not approve it. ${item.unresolved[0].ask}`);
  }
  const out = [
    held.length ? `Not covered by a yes until you answer:\n${held.join("\n")}` : "",
    lines.length ? `The full review of each, with the application page, the resume file and exactly what your yes covers:\n${lines.join("\n")}` : "",
    lines.length || held.length ? "Nothing is submitted until you reply \"yes\" to this card." : "",
  ].filter(Boolean);
  return out.length ? out.join("\n\n") : null;
}

// A card text with its review links after it, only while the whole stays one text (the outbox and the card push take at most
// `max` characters); a card that would not fit keeps its exact text and the links are left out, never the card cut.
export function withLinks(text: string, links: string | null, max = 4000): string {
  return links && text.length + 2 + links.length <= max ? `${text}\n\n${links}` : text;
}

// ------------------------------------------------------------------------------------------------ the approval guard
// Architect ruling (R10 fix 12): an unresolved fact is never approvable through any path. Every approval of prepared
// applications (a text yes, a Telegram tap, the jobs page's Apply, the File's Confirm) reaches the database through a card
// store's answer or confirm; there, before the database is asked, each item whose posting still has an open required question
// is held back and the narrow question is said instead. A check that cannot be read approves nothing (fail closed).
// deno-lint-ignore no-explicit-any
export async function unresolvedOf(admin: any, userId: string, preparedIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!preparedIds.length) return out;
  const fail = (what: string, r: any) => { if (r.error) throw new Error(`unresolved_unreadable: ${what}: ${r.error.message}`); return r.data ?? []; };
  const prepared = fail("read the prepared applications", await admin.from("career_apply_prepared").select("id,job_id,company,payload,payload_hash").eq("user_id", userId).in("id", preparedIds)) as
    { id: string; job_id: string | null; company: string; payload: any; payload_hash: string }[];
  const open = await openQuestionsFor(admin, userId, prepared.map((p) => String(p.job_id ?? "")).filter(Boolean)).catch((e) => { throw new Error(`unresolved_unreadable: ${e instanceof Error ? e.message : e}`); });
  for (const p of prepared) {
    const q = p.job_id ? open.find((x) => Array.isArray(x.job_ids) && x.job_ids.includes(String(p.job_id))) : undefined;
    if (q) { out.set(String(p.id), narrowQuestion({ label: q.label, company: p.company || q.company, options: q.options })); continue; }
    // 12-b, narrowed (architect, 2026-11-09): a blank answer is held only when it is a fact the person must supply (a
    // sensitive or identity question). An optional field the preparer left empty is not a question and does not block the yes;
    // a missing required answer is an open question, held above.
    const blank = reviewOf({ id: String(p.id), payload: p.payload, payload_hash: String(p.payload_hash ?? "") }).unresolved.find((u) => u.fact);
    if (blank) out.set(String(p.id), blank.ask);
  }
  return out;
}
// Every open question naming any of these postings, read straight from the table page by page (the texting path's
// career_apply_questions_open_as returns at most 20, so past 20 open questions a posting's would be missed).
// deno-lint-ignore no-explicit-any
export async function openQuestionsFor(admin: any, userId: string, jobIds: string[]): Promise<{ label: string; options?: string[]; company?: string | null; job_ids?: string[] }[]> {
  if (!jobIds.length) return [];
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await admin.from("career_apply_questions").select("label,options,company,job_ids").eq("user_id", userId).eq("state", "open")
      .overlaps("job_ids", [...new Set(jobIds)]).order("created_at", { ascending: true }).range(from, from + 999);
    if (r.error) throw new Error(`read open questions: ${r.error.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) return out;
  }
}
// The card's answer with every held-back item said as needing its answer; the rest go to the database as approved.
// 12-a: the database answers a card whole (an item not approved is declined and the card closes), so a held item is put back
// to ready right after (`reopen`): it is never declined for a question, and once the question is answered it comes back on the
// next card ("show my applications") under its own hash, approvable then.
export async function guardedAnswer<R extends { n: number; result: string; said?: string }>(o: {
  approve: number[]; items: { n: number; prepared_id: string }[]; held: (preparedIds: string[]) => Promise<Map<string, string>>; call: (approve: number[]) => Promise<R[]>;
  reopen?: (preparedIds: string[]) => Promise<void>;
}): Promise<R[]> {
  const asked = o.items.filter((i) => o.approve.includes(i.n));
  const held = asked.length ? await o.held(asked.map((i) => i.prepared_id)) : new Map<string, string>();
  const heldItems = asked.filter((i) => held.has(i.prepared_id));
  const byN = new Map(heldItems.map((i) => [i.n, held.get(i.prepared_id)!]));
  const results = await o.call(o.approve.filter((n) => !byN.has(n)));
  if (heldItems.length && o.reopen) await o.reopen(heldItems.map((i) => i.prepared_id));
  return results.map((r) => byN.has(r.n) ? { ...r, result: "needs_answer",
    said: `not approved yet: a required answer is still missing. ${byN.get(r.n)} It stays ready; once you answer, say "show my applications" to approve it.` } : r);
}
