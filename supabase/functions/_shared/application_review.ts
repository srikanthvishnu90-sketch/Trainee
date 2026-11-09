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
}
export interface ReviewItem {
  id: string; employer: string; role: string | null; url: string | null; destination: string | null;
  resume: { label: string; sha12: string } | null; files: string[];
  answers: { question: string; answer: string; sensitive: Sensitive | null }[];
  unresolved: { question: string; fact: Sensitive | null; ask: string }[];
  page_fields: string[]; hash12: string; approvable: boolean; covers: string[];
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
    else answers.push({ question, answer: String(f.value === true ? "Yes" : f.value === false ? "No" : f.value).replace(/\s+/g, " ").trim().slice(0, 2000), sensitive: fact });
  }
  for (const q of x.open ?? []) {
    const question = one(q.label, 200);
    if (!unresolved.some((u) => u.question === question)) unresolved.push({ question, fact: sensitiveOf(question), ask: narrowQuestion({ label: question, company: employer, options: q.options }) });
  }
  // The resume line the card already carries (career_prepared_card.ts resumeCardLine): "Resume: <name> (<sha12>)".
  const line = (x.card_lines ?? []).find((l) => /^Resume: /.test(String(l)));
  const label = line ? String(line).replace(/^Resume: /, "").replace(/\s*\([0-9a-f]{12}\)$/, "") : "your confirmed resume";
  const resume = /^[0-9a-f]{64}$/.test(sha) ? { label: one(label, 120), sha12: sha.slice(0, 12) } : null;
  const files = [...(resume ? [`Resume: ${resume.label}`] : []), ...(p.cover_note && typeof p.cover_note === "object" && p.cover_note.text ? ["Cover note (its full text is under the answers)"] : [])];
  if (p.cover_note?.text) answers.push({ question: "Cover note", answer: one(p.cover_note.text, 4000), sensitive: null });
  const page_fields = Array.isArray(p.page_field_names) ? p.page_field_names.map((s: unknown) => one(s, 80)) : [];
  const url = /^https?:\/\//.test(String(p.url ?? "")) ? one(p.url, 500) : null, destination = one(p.destination, 500) || null;
  const role = one(x.title, 120) || null, hash12 = String(x.payload_hash ?? "").slice(0, 12);
  const covers = [`the employer: ${employer}`, ...(role ? [`the role: ${role}`] : []), ...(url ? [`the application page: ${url}`] : []),
    ...(destination ? [`where it is sent: ${destination}`] : []), ...(resume ? [`the resume file ${resume.sha12}`] : []),
    `${answers.length} answer${answers.length === 1 ? "" : "s"}, word for word as shown`, ...(page_fields.length ? [`the fields the employer's page sets: ${page_fields.join(", ")}`] : [])];
  return { id: x.id, employer, role, url, destination, resume, files, answers, unresolved, page_fields, hash12, approvable: !!resume && !unresolved.length, covers };
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
  prepared: "Prepared, not submitted", approved: "Approved, not sent yet", sending: "Sending, not confirmed",
  uncertain: "Submission uncertain", submitted_unconfirmed: "Sent, not confirmed by the employer", employer_confirmed: "Confirmed by the employer",
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
  confirmation_id?: string | null; email_confirmed_at?: string | null; sent_at?: string | null;
}
// The employer's own evidence, as recorded: their email (matched by career_apply_confirm.ts), or the reference their page or
// ATS returned (an id label with a digit in it, career_apply.ts ID). Anything else is no evidence.
export function evidenceOf(r: RecordRow): { email_at: string } | { id: string } | null {
  if (r.email_confirmed_at && Number.isFinite(Date.parse(r.email_confirmed_at))) return { email_at: r.email_confirmed_at };
  const id = one(r.confirmation_id, 80);
  return /^[A-Z0-9][A-Z0-9-]{4,}$/i.test(id) && /\d/.test(id) ? { id } : null;
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
      return `Submitted ${name}${when ? ` at ${when}` : ""}. Confirmation: ${"id" in ev ? ev.id : `${who}'s confirmation email (${at(ev.email_at, tz)})`}.`;
    }
    case "submitted_unconfirmed": return `Sent ${name}${when ? ` at ${when}` : ""}; ${who} has not confirmed it yet, so it is not confirmed. Their email or status page is the proof.`;
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
  prepared(ids: string[]): Promise<{ id: string; job_id?: string | null; payload: any; payload_hash: string; card_lines?: string[] }[]>;
  titles?(jobIds: string[]): Promise<Map<string, string>>;
  open?(): Promise<{ label: string; options?: string[]; job_ids?: string[] }[]>;
  create(item: ReviewItem): Promise<{ url: string | null } | null>;
}
export async function reviewLinksFor(shown: { id: string }[], d: ReviewDeps): Promise<string | null> {
  const rows = await d.prepared(shown.map((p) => p.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const titles = d.titles ? await d.titles(rows.map((r) => String(r.job_id ?? "")).filter(Boolean)).catch(() => new Map<string, string>()) : new Map<string, string>();
  const open = d.open ? await d.open().catch(() => []) : [];
  const lines: string[] = [];
  for (const [i, p] of shown.entries()) {
    const r = byId.get(p.id);
    if (!r) continue;
    const job = String(r.job_id ?? "");
    const item = reviewOf({ ...r, title: titles.get(job) ?? null, open: open.filter((q) => job && (q.job_ids ?? []).includes(job)) });
    const made = await d.create(item).catch(() => null);
    if (made?.url) lines.push(`${i + 1}. ${item.employer}${item.role ? `, ${item.role}` : ""}: ${made.url}`);
  }
  return lines.length ? `The full review of each, with the application page, the resume file and exactly what your yes covers:\n${lines.join("\n")}` : null;
}
