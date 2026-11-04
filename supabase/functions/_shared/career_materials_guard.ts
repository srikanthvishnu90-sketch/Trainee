// COMPETITIVE-BAR G5 / B2 (owner 2026-10-27): truthful materials. The last check at the tailoring output boundary, on
// exactly what an employer will read: a tailored resume's lines, a cover letter, or a form answer may not add a skill,
// employer, title, date or number the person did not confirm. Massive and Jobright lose here (invented skills, metrics
// the user never gave). An injected "Led a team of 12 at Google as Senior Manager since 2015" is refused, with reasons.
//
// It never rewrites anything: it says ok, or which words are not on the person's confirmed record. The caller refuses
// the document (or the answer) on a no. Drafts are not facts: only confirmed facts and the person's own basics count.
import { CareerProfile, CareerTailor } from "./router_core.career.js";
import { claimProblems } from "./person_claims.ts";

export interface GuardLine { text: string; factIds?: string[] }
export interface GuardResult { ok: boolean; refused: { text: string; reasons: string[] }[] }

const MONTHS = "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec present current";
// Words that may be capitalized without naming anyone: sentence words, headings, months.
const COMMON = new Set((MONTHS + " i a an the and or of in on for to by with at as my our we you your it this that these those " +
  "experience projects project education skills leadership certifications summary work employment history references contact " +
  "dear hello hi thanks thank regards sincerely best yes no n/a na none").split(/\s+/));
const TITLE = /\b(?:senior|sr\.?|junior|jr\.?|lead|principal|staff|head of [a-z]+|director|manager|vice president|vp|chief [a-z]+ officer|c[etfo]o|founder|co-?founder|partner|supervisor|team lead|tech lead)\b/gi;
const LEADERSHIP = /\b(?:led|lead|leading|managed|manage|managing|supervised|supervising|oversaw|oversee|directed|directing|mentored|mentoring|headed|hired)\b/gi;

const numbersIn = (t: string) => (String(t || "").replace(/(\d)-(\d)/g, "$1 $2").match(/\d[\d,.]*%?/g) || []).map((x) => x.replace(/,/g, "").replace(/\.$/, "").replace(/%$/, ""));
const lc = (t: unknown) => ` ${String(t ?? "").toLowerCase().replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ")} `;

function factText(f: any): string {
  return [f?.title, f?.text, ...(f?.bullets || []), f?.org, f?.name, f?.role, f?.school, f?.degree, ...(f?.skills || []), f?.start, f?.end, f?.dates, f?.location]
    .filter((x) => x !== null && x !== undefined).map(String).join(" \n ");
}

// What the person confirmed, as one searchable record. `extra` is more of their own confirmed words (a typed answer,
// a confirmed form fact's value), never a draft and never the posting.
export interface Record_ { text: string; lower: string; numbers: Set<string>; byFact: Map<string, string>; own: string; ownNumbers: Set<string> }
export function confirmedRecord(profile: any, extra: string[] = []): Record_ {
  const facts = (CareerProfile.confirmedFacts(profile || {}) as any[]).filter((f) => f && f.status !== "draft" && !f.needs_confirmation);
  const byFact = new Map<string, string>();
  for (const f of facts) if (f.id) byFact.set(String(f.id), factText(f));
  const basics = profile?.basics || {};
  const own = [basics.name, basics.email, basics.phone, basics.location, basics.url, ...extra].filter(Boolean).join(" \n ");
  const text = [...byFact.values(), own].join(" \n ");
  return { text, lower: lc(text), numbers: new Set(numbersIn(text)), byFact, own, ownNumbers: new Set(numbersIn(own)) };
}

const hasWord = (lower: string, w: string) => {
  const x = w.toLowerCase().replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();
  return !!x && (lower.includes(` ${x} `) || lower.includes(` ${x}.`) || lower.includes(` ${x}s `));
};
const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, "");

// One line against the record. A line that cites facts is checked against those facts (plus skills and basics) for
// names, titles and leadership; numbers and dates are checked against the whole confirmed record.
export function lineProblems(text: string, rec: Record_, factIds?: string[]): string[] {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  // A secret is refused by name; its digits are never quoted back in a reason.
  const secret = claimProblems(t, { record: [] }).filter((x) => x.startsWith("it holds a"));
  if (secret.length) return secret;
  const scoped = factIds?.length
    ? lc([...factIds.map((id) => rec.byFact.get(String(id)) ?? ""), rec.own].join(" "))
    : rec.lower;
  const reasons: string[] = [];
  // Numbers and dates (a year is a number): every one on the record.
  const nums = factIds?.length ? new Set(numbersIn(scoped)) : rec.numbers;
  for (const n of numbersIn(t)) if (!nums.has(n)) reasons.push(/^(19|20)\d\d$/.test(n) ? `date "${n}" is not on your record` : `number "${n}" is not on your record`);
  // "N years": a claim of time only as the person stated it (their years fact, or the same words on the record).
  for (const m of t.matchAll(/\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi)) {
    if (!rec.ownNumbers.has(m[1]) && !rec.lower.includes(` ${m[1]} year`) && !rec.lower.includes(` ${m[1]}+ year`)) reasons.push(`"${m[0]}" is not what you told me`);
  }
  // Skills the lexicon knows: each one confirmed.
  for (const sk of (CareerTailor.skillsInText(t) as string[]) || []) if (!hasWord(rec.lower, sk)) reasons.push(`skill "${sk}" is not on your record`);
  // Titles and leadership claims: on the fact the line cites (or the record).
  for (const m of t.matchAll(TITLE)) if (!hasWord(scoped, m[0])) reasons.push(`title "${m[0]}" is not on your record`);
  const lead = (w: string) => { const s = stem(w); return s === "led" ? "lead" : s; };
  for (const m of t.matchAll(LEADERSHIP)) if (!scoped.split(" ").some((w) => w && lead(w) === lead(m[0]))) reasons.push(`"${m[0]}" (a leadership claim) is not on your record`);
  // Names: a capitalized word or run that is not the first word of a sentence (employers, schools, clients, tools).
  for (const m of t.matchAll(/(?<=[a-z0-9,;:)]\s+|\bat\s+|\bfor\s+)([A-Z][A-Za-z0-9&'.+-]*(?:\s+[A-Z][A-Za-z0-9&'.+-]*)*)/g)) {
    for (const w of m[1].split(/\s+/)) {
      const x = w.replace(/[.'-]+$/, "");
      if (!x || COMMON.has(x.toLowerCase()) || /^\d/.test(x)) continue;
      if (!hasWord(rec.lower, x)) { reasons.push(`name "${x}" is not on your record`); }
    }
  }
  // TAILORING SCENARIOS (2026-10-29): the claims the checks above do not see (a degree written out, a spelled-out or
  // multiplied metric, "40+" for 40, work authorization, how the person identifies, a lower-case employer, a secret).
  reasons.push(...claimProblems(t, { record: [rec.text] }));
  return [...new Set(reasons)];
}

// A whole document: a tailored resume (its lines, each with the facts it cites), or a cover letter's paragraphs.
export function guardMaterials(lines: (GuardLine | string)[], profile: any, extra: string[] = []): GuardResult {
  const rec = confirmedRecord(profile, extra);
  const refused: GuardResult["refused"] = [];
  for (const l of lines ?? []) {
    const line = typeof l === "string" ? { text: l } : l;
    const reasons = lineProblems(line.text, rec, line.factIds);
    if (reasons.length) refused.push({ text: line.text, reasons });
  }
  return { ok: refused.length === 0, refused };
}

// The lines of a tailored document (submissionResume / tailorResume shape): { lines: [{text, factIds}] } or sections.
export function documentLines(doc: any): GuardLine[] {
  if (Array.isArray(doc?.lines)) return doc.lines.map((l: any) => ({ text: String(l?.text ?? ""), factIds: l?.factIds }));
  if (Array.isArray(doc?.sections)) return doc.sections.flatMap((s: any) => (s.lines || []).map((l: any) => ({ text: String(l?.text ?? ""), factIds: l?.factIds })));
  return [];
}

// A form answer (a question's free-text or essay answer) before it goes in a payload. `confirmed` are the person's other
// confirmed facts' values (years_experience, current_title...) and their own typed answers, word for word.
export function guardFormAnswer(answer: string, profile: any, confirmed: string[] = []): GuardResult {
  return guardMaterials([String(answer ?? "")], profile, confirmed);
}
