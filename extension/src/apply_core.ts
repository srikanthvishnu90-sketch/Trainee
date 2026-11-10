// WO-031: what the browser extension decides, as pure functions (no DOM, no chrome.*). The planner, the question map,
// the answer keys and the payload hash are the apply stack's own (D-014), imported, never copied:
//   planBatch / classifyField   supabase/functions/_shared/career_apply.ts
//   mapQuestion / NEVER_BY_TEXT supabase/functions/_shared/question_map.ts
//   hashApplyPayload            supabase/functions/_shared/career_apply_store.ts (the same canonical hash the queue's SQL computes)
//   questionsToStore            workers/career-browser/ask-once.ts (ask once, shared with the desktop runner)
// Bundled into extension/lib/trainee-core.js by extension/build.ts; tested by tests/architect/wo-031-extension.test.ts.
import { canonicalTypedValue, classifyField, classifyOutcome, fileAlternative, type FormField, normLabel, type Observation, planBatch, questionFieldType } from "../../supabase/functions/_shared/career_apply.ts";
import { BIRTH_DATE, mapQuestion, NEVER_BY_TEXT } from "../../supabase/functions/_shared/question_map.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { reusedSourceSuffix } from "../../supabase/functions/_shared/career_prepared_card.ts";
import { questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { assertsSeparateSponsorshipPosition, assertsSponsorshipNeed, howHeardChannel, yesNoOf } from "../../supabase/functions/_shared/answer_options.ts";
import { readAiPolicy } from "../../supabase/functions/_shared/ai_policy.ts";
import { STATE_NAMES } from "../../supabase/functions/_shared/posting_place.ts";
import { typedProfileFile } from "../../supabase/functions/_shared/typed_profile_fields.ts";
import { rowAnswerKey, rowQuestionLabel, rowQuestionType } from "../../supabase/functions/_shared/row_answer.ts";
import { factDependencies, quarantinedFact as sharedQuarantinedFact } from "../../supabase/functions/_shared/fact_quarantine.ts";

export { applyUrl, detectPortal, type Family, type Portal, postingKey, tenantOf } from "../../supabase/functions/_shared/posting_key.ts";
import { applyUrl, detectPortal, type Family, type Portal, postingKey, tenantOf } from "../../supabase/functions/_shared/posting_key.ts";

// A question that asks for an identity number, a bank or card number, or a secret: never filled, never stored, never in
// evidence. The person types it on the form; its value never leaves the page (NEVER_BY_TEXT, the texting side's rule).
// NEVER_BY_TEXT is the texting side's list; the extension also knows the identity numbers of other countries and the
// ways forms write "number" (WO-031 review: SIN, Aadhaar, Personnummer, "Passport #" and others went through).
export const IDENTITY_EXTRA =
  /\bsin\b|social insurance|social security|\bssn\b|national (identification|identity|id|insurance)\b|\bnin\b|\bni (number|no\b)|passport\s*(#|no\b|num|number)|driver'?s'? licen[cs]e\s*(#|no\b|num|number)|licen[cs]e\s*(#|number)|tax file number|\btfn\b|aadhaa?r|government[- ]issued( photo)? id|personnummer|\bcpf\b|\bcurp\b|\bpesel\b|\bnric\b|\bbsn\b|\bdni\b|\bnie\b|\bpps\b|\b(id|identity|identification) (card |document )?(number|no\b|#)|\btax (id|identification)|\biban\b|sort code|account number|routing number|card number|\bcvv\b|\bpassword\b|\bpin\b/i;
export const isIdentityField = (f: { label: string; name?: string }) => {
  const label = String(f.label || ""), name = String(f.name || "").replace(/[_\-\[\]]+/g, " ");
  return NEVER_BY_TEXT.test(label) || NEVER_BY_TEXT.test(name) || IDENTITY_EXTRA.test(label) || IDENTITY_EXTRA.test(name);
};
// A value the person typed with eight or more digits in a row (separators ignored) and no confirmed fact behind it may be
// an identity number whatever its label says: it is masked in the payload, the record, the evidence and the screenshot.
export const looksLikeIdNumber = (v: string) => /\d{8,}/.test(String(v || "").replace(/[\s.\-\/()+]/g, ""));

// On a Workday page that is not the application flow the extension reads (WO-048: no formField-* wrappers, an unknown
// layout), only the basic contact fields are filled (WO-031); in the flow, every field goes to the planner.
const WORKDAY_BASIC = new Set(["first_name", "last_name", "full_name", "legal_name", "preferred_name", "email", "phone", "street_address",
  "full_address", "city", "state", "postal_code", "country", "location", "linkedin", "github", "website", "resume"]);
export const WORKDAY_NOTICE = "Workday needs you signed in on the employer's site; I fill the fields I can.";
// WO-048: the words the person reads on a Workday card.
export const WORKDAY_PAGE_SET = "Filled by Workday from your resume: check them";
export const workdayDraftLine = (employer: string) => `Save and Continue sends this page to ${employer} as a draft; nothing is submitted.`;
export const workdaySubmitLine = (employer: string) => `Approve submits this application to ${employer} with Workday's own Submit. This is the last step.`;
export const workdaySignIn = (employer: string) => `Sign in to ${employer}'s Workday yourself; I'll fill the application after.`;
export const WORKDAY_PERSONAL = "The disability form (Voluntary Self-Identification of Disability) is yours: Trainee never fills it. Answer it yourself on the page.";
// The employer as its Workday tenant names it: the first label of the tenant's host ("northwind" of northwind.wd5...).
export function workdayEmployer(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase().split(".")[0] || "the employer";
  } catch {
    return "the employer";
  }
}

export interface Answer { value: string; factId: string }
export interface PlannedField { name: string; label: string; value: string; factId: string }
// What the extension fills on this form and what it cannot answer, from the person's confirmed facts and saved answers.
// Both come from planBatch itself: once with every field optional (every answer the planner is sure of, even when a
// required question is still open, so the person sees the form mostly done), once as the form is (the required questions
// left, asked once by text). Identity numbers never reach the planner.
export function planForm(o: {
  userId: string; jobId: string; company: string; family: Family; schema: FormField[];
  answers: Record<string, Answer>; saved: Record<string, Answer>; now: number; workdayFlow?: boolean; location?: string;
}) {
  const identity = o.schema.filter((f) => isIdentityField(f));
  // Two fields under one label: the label belongs to at most one of them, so neither is answered from it (WO-031
  // review: a referrer's phone read as "Phone"). Both are left to the person and listed as still needed.
  // WO-075: Greenhouse's paste box beside its upload (resume_text by resume) is the upload's alternative, not a second
  // field under the label; planBatch answers the pair with the approved file (fileAlternative).
  const count = new Map<string, number>();
  for (const f of o.schema) if (!fileAlternative(f, o.schema)) count.set(normLabel(f.label), (count.get(normLabel(f.label)) ?? 0) + 1);
  const rowKeys = o.schema.map((f) => rowAnswerKey(f, o.jobId));
  const ambiguous = o.schema.filter((f, i) => !isIdentityField(f) && !f.personal && (count.get(normLabel(f.label)) ?? 0) > 1 &&
    !(rowKeys[i] && rowKeys.filter((key) => key === rowKeys[i]).length === 1));
  // WO-048: a form only the person fills (the disability self-identification) is neither planned nor asked by text.
  const fields = o.schema.filter((f) => !isIdentityField(f) && !ambiguous.includes(f) && !f.personal);
  // WO-053: the posting's own location as its page shows it, for the questions that depend on where the job is.
  const posting = (fs: FormField[]) => [{ job_id: o.jobId, company: o.company, title: "", fields: fs, location: o.location }];
  const all = planBatch({ userId: o.userId, postings: posting(fields.map((f) => ({ ...f, required: false }))), answers: o.answers, saved: o.saved, log: [], now: o.now });
  let fill: PlannedField[] = all.ready[0]?.fields ?? [];
  const basicOnly = o.family === "workday" && !o.workdayFlow;
  if (basicOnly) {
    fill = fill.filter((p) => {
      const f = fields.find((x) => x.name === p.name)!;
      return WORKDAY_BASIC.has(classifyField(f.label, f.type)) || WORKDAY_BASIC.has(mapQuestion(f).fact);
    });
  }
  const strict = planBatch({ userId: o.userId, postings: posting(fields), answers: o.answers, saved: o.saved, log: [], now: o.now });
  const planned = new Set(fill.map((f) => f.name));
  const needs = basicOnly
    ? fields.filter((f) => f.required && !planned.has(f.name)).map((f) => ({ label: f.label, field_name: f.name }))
    : strict.needs.map((n) => ({ label: n.label, field_name: (n as { field_name?: string }).field_name }));
  // Each open question as the form asks it, the engine's shape, so it is asked once by text in the form's own terms.
  const questions = needs.map((n) => {
    const f = fields.find((x) => n.field_name ? x.name === n.field_name : x.label === n.label) || ({} as FormField);
    const opts = (f.options || []).filter((x) => x.label && !/^select\b/i.test(x.label.trim()));
    return { label: rowQuestionLabel(f) || n.label, type: rowQuestionType(f, o.jobId, questionFieldType(f)), options: opts.length <= 60 ? opts.map((x) => String(x.label)) : [] };
  });
  return {
    ...(o.jobId ? { jobId: o.jobId } : {}),
    fill, needs: questions, identity: identity.map((f) => ({ name: f.name, label: f.label, required: f.required })),
    ambiguous: ambiguous.map((f) => ({ name: f.name, label: f.label, required: f.required })),
  };
}

// WO-042: a dropdown widget's options exist only once its menu opens on the page (Greenhouse's react-select). The choice
// among them is the planner's, exactly as for an ordinary select: the field is planned again with the employer's own
// option texts. A phone-country list ("United States +1") is matched by its country. Nothing the planner would not choose
// is ever picked: no answer, or one that is not on the list, leaves the widget for the person.
// FRS: nor anything the contract would refuse on a select (WO-102): the option must derive from the fact behind it
// (optionRule), the fact that was approved (`factId`), never one the planner reached by meaning ("Yes" put on "I am
// authorized to work ... for any employer"). Such a widget is left for the person, and asked.
export function chooseWidgetOption(o: {
  userId: string; jobId: string; company: string; family: Family; field: FormField; labels: string[];
  answers: Record<string, Answer>; saved: Record<string, Answer>; now: number; form?: FormField[]; location?: string; factId?: string;
}): string | null {
  const labels = o.labels.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!labels.length) return null;
  const dial = labels.length > 20 && labels.filter((l) => /\s\+\d{1,4}$/.test(l)).length > labels.length * 0.8;
  const options = labels.map((l) => ({ label: dial ? l.replace(/\s\+\d{1,4}$/, "") : l, value: l }));
  // The rest of the form rides along without options, for the rules that read a field beside its neighbours.
  const rest = (o.form ?? []).filter((f) => f.name !== o.field.name).map((f) => ({ ...f, options: [] }));
  const r = planForm({ userId: o.userId, jobId: o.jobId, company: o.company, family: o.family, schema: [{ ...o.field, options }, ...rest], answers: o.answers, saved: o.saved, now: o.now, location: o.location });
  const p = r.fill.find((x) => x.name === o.field.name);
  if (!p || !labels.includes(p.value) || (o.factId && p.factId !== o.factId)) return null;
  const [key, fact] = [...Object.entries(o.answers), ...Object.entries(o.saved)].find(([, a]) => a?.factId === p.factId) ?? [];
  // An attestation or a personal choice is clicked only from the person's own answer to that question (a saved
  // answer), never from a standing fact — contractFill's judge applies the same rule before the drive; the click
  // itself is held to it too, so no caller of this chooser can auto-accept an attestation from a fact.
  if (ownAnswerOnly(o.field.label) && !Object.values(o.saved).some((a) => a?.factId === p.factId)) return null;
  const shown = options.find((x) => x.value === p.value)!.label;
  return fact && optionRule(shown, fact.value, SEARCHED.has(String(key).replace(/^fact:/, "")), String(key).replace(/^fact:/, ""), combinedEligibility(o.answers)) ? p.value : null;
}
// A place or a school is searched by its name, not picked from a fixed list: the employer's entry must name the fact (its
// first word: "Chicago, Illinois, United States" for "Chicago, IL"). Any other widget is a select whose list opens late.
const SEARCHED = new Set(["location", "city", "state", "school"]);
const optN = (x: string) => String(x ?? "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").toLowerCase();
// How an employer's option derives from the fact (WO-102's select rules, or listed-name for a search), or null: asked.
// The one conjunction career_apply's authorizedWithoutSponsorship sanctions for a combined eligibility answer:
// authorized (yes) AND no sponsorship need (no), both standing as facts. Anything weaker is not a combined answer.
const combinedEligibility = (answers: Record<string, { value?: unknown } | undefined> | undefined) =>
  yesNoOf(String(answers?.work_authorization?.value ?? "")) === "yes" && yesNoOf(String(answers?.sponsorship?.value ?? "")) === "no";
function optionRule(option: string, fact: string, searched: boolean, key?: string, combinedOk = false): string | null {
  // The two-class eligibility classification (answer_options, shared verbatim with chooseOption): a positive
  // sponsorship-need assertion is the sponsorship fact's own territory — it derives only from an affirmative
  // sponsorship fact (the bare yes-prefix class below once admitted "Yes, I will require sponsorship" on the
  // authorization fact alone; the widget battery pins that as a wrong answer, never chosen) — and a COMBINED
  // answer, one that takes a separate sponsorship position in a compound phrasing ("Yes, I am authorized and
  // do not require sponsorship"), derives from NO single fact. The one sanctioned exception is the planner's
  // both-facts derivation (career_apply's authorizedWithoutSponsorship): where both facts stand in the exact
  // conjunction above, the option asserts nothing beyond them (no positive need, a yes), and the plan entry
  // rides on the authorization fact, the choice is that derivation's — answered from both facts, never from
  // the authorization fact alone (combinedOk is false whenever either fact is missing or says otherwise).
  if (assertsSeparateSponsorshipPosition(option)) {
    return combinedOk && key === "work_authorization" && !assertsSponsorshipNeed(option) && yesNoOf(option) === "yes" ? "option-combined-eligibility" : null;
  }
  if (assertsSponsorshipNeed(option) && !(key === "sponsorship" && yesNoOf(fact) === "yes")) return null;
  if (searched) {
    // A US state code is named by the state ("IL": "Illinois, United States").
    const word = STATE_NAMES[optN(fact)] ?? optN(fact).split(/[^a-z0-9]+/).find((x) => x.length >= 3) ?? optN(fact);
    return word && optN(option).includes(word) ? "listed-name" : null;
  }
  if (optN(option) === optN(fact)) return "option-exact";
  const yn = /^(yes|no)$/.exec(optN(fact))?.[1];
  return yn && new RegExp(`^${yn}\\b`).test(optN(option)) ? "option-yes-no" : null;
}

// The rows career_apply_questions_put_own stores, keyed by how far each answer may travel (answerKey).
export function questionsForTrainee(o: { jobId: string; company: string; location?: string; needs: { label: string; type: string; options: string[] }[]; answers: Record<string, unknown>; answered: Set<string> }) {
  return questionsToStore({ posting: o.jobId, company: o.company, location: o.location, questions: o.needs }, { facts: o.answers, answered: o.answered });
}

// Ask once, from the form (WO-042, session run 4: every repeat of a question cost the person the same seconds, since
// only answers given by text were kept). A question this posting could not answer, which the person then answered on the
// form themselves and approved on the card, is kept under the same key the text path uses (answerKey: a fact for every
// employer, a wording, or this posting only), so it travels exactly as far as a texted answer would. Never a masked or
// identity value, never a file, never anything the page or Trainee filled. An answer that would travel beyond this
// posting is kept only when it can be true elsewhere: never one naming this employer, and a how-heard answer only when it
// names a channel ("A friend here told me" is about this employer). Two kinds never leave their posting (session run 5,
// where an acknowledgment ticked for one employer and a veteran-status answer were filled again at the next):
//   a statement the person agreed to (a consent, an attestation, "I understand / acknowledge / agree / confirm ..."): an
//     agreement is given to one employer, and another employer's identical words are agreed to only by the person;
//   a self-identification answer (gender, race, ethnicity, veteran or disability status): voluntary, and given to one
//     employer; the planner never fills it from facts either.
const AGREEMENT = /^\s*(i|we)\s+(hereby\s+)?(understand|acknowledge|agree|confirm|certify|consent|accept|attest|authori[sz]e|have read|declare)\b/i;
const staysWithPosting = (row: { kind: string; label: string; type: string; options: string[] }) => {
  if (row.kind === "consent" || row.kind === "attestation" || AGREEMENT.test(row.label)) return true;
  // a-sensitive (interim ruling, 2026-11-10): a date of birth is given to one application and never kept for reuse.
  if (BIRTH_DATE.test(row.label)) return true;
  const m = mapQuestion({ label: row.label, type: row.type, options: row.options.map((l) => ({ label: l })) }) as { fact?: string };
  return m.fact === "eeo" || classifyField(row.label, row.type) === "eeo";
};
const namesEmployer = (answer: string, company: string) => {
  const c = String(company ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(inc|llc|ltd|corp|co|the)\b/g, "").replace(/\s+/g, " ").trim();
  return c.length >= 3 && ` ${answer.toLowerCase().replace(/[^a-z0-9 ]/g, " ")} `.includes(` ${c} `);
};
export function formAnswersToKeep(o: {
  jobId: string; company: string; location?: string; needs: { label: string; type: string; options: string[] }[];
  fields: { name: string; label: string; value: string; source: string }[]; answers: Record<string, unknown>; answered: Set<string>;
}) {
  const q = questionsForTrainee(o);
  const norm = (x: string) => String(x ?? "").replace(/\s+/g, " ").trim();
  const out: { key: string; kind: string; label: string; type: string; options: string[]; company: string | null; answer: string }[] = [];
  for (const row of q.questions as any[]) {
    if (/file/.test(String(row.type))) continue;
    const f = o.fields.find((x) => (x.source === "you" || x.source === "drafted") && !x.name.startsWith("fixed:") && norm(x.label) === row.label);
    const answer = norm(f?.value ?? "");
    if (!f || !answer || answer === MASKED || answer.length > 2000 || staysWithPosting(row)) continue;
    // WO-049: a written answer (and above all one Trainee drafted on the card) is kept for this posting only, never as a
    // fact or a wording that would put it on another employer's form.
    if ((row.kind === "essay" || f.source === "drafted") && !String(row.key).startsWith("job:")) continue;
    if (!String(row.key).startsWith("job:") && (namesEmployer(answer, o.company) || (row.key === "fact:how_heard" && !howHeardChannel(answer)))) continue;
    out.push({ key: row.key, kind: row.kind, label: row.label, type: row.type, options: row.options, company: row.company, answer });
  }
  return { posting: q.posting, answers: out };
}

// ------------------------------------------------------------------------------------------------ answer once (WO-054)
// Before the session the queue's postings are read in hidden tabs (planForm, strict; nothing filled or clicked) and the
// questions only the person can answer are asked once in the panel. They are grouped by the key the planner reads saved
// answers by (answerKey, through questionsToStore, so a fact the person stated that did not fit a form is that posting's):
// a fact or a wording is one entry for every posting that asks it; a question about one job (job:) stays that posting's
// and is shown with its company. Never listed (left for the card): an identity number, a self-identification (EEO, the
// disability form), a written answer (drafted on the card, WO-049), a file, and an agreement (an agreement is given to one
// employer: formAnswersToKeep's rule). The panel starts every choice empty; only the person's own pick is ever stored.
export interface OpenQuestion { label: string; type: string; options: string[]; personal?: boolean }
export interface PreparedPosting { jobId: string; company: string; url?: string; location?: string; needs: OpenQuestion[] }
export interface AskedAt { jobId: string; company: string; label: string; type: string; options: string[]; misfit: boolean }
export interface PanelQuestion {
  key: string; kind: string; label: string; type: string; options: string[]; similar: number; postings: AskedAt[]; perPosting: boolean; selected: null;
}
export type LeftReason = "identity" | "personal" | "essay" | "file" | "agreement";
function leftForCard(n: OpenQuestion): LeftReason | null {
  const q = { label: n.label, type: n.type, options: (n.options || []).map((l) => ({ label: l })) };
  if (isIdentityField({ label: n.label }) || NEVER_BY_TEXT.test(n.label)) return "identity";
  const m = mapQuestion(q);
  if (n.personal || m.fact === "eeo" || classifyField(n.label, n.type) === "eeo") return "personal";
  if (/file/.test(String(n.type)) || m.kind === "file") return "file";
  if (m.kind === "essay") return "essay";
  // A statement whose only answers accept it ("Agreement to Arbitrate" over "I understand and agree ...") is an agreement.
  if (n.options?.length && n.options.every((l) => /^\s*(i\s+)?(will read|accept|agree|acknowledge|understand|consent|confirm|certify|attest)\b/i.test(l))) return "agreement";
  return null;
}
export function answerOnceQuestions(o: { postings: PreparedPosting[]; answers: Record<string, unknown>; answered: Set<string> }) {
  const by = new Map<string, Omit<PanelQuestion, "label" | "type" | "options" | "similar" | "selected">>();
  const left: { jobId: string; label: string; why: LeftReason }[] = [];
  for (const p of o.postings) {
    const keep: OpenQuestion[] = [];
    for (const n of p.needs) {
      const why = leftForCard(n);
      if (why) left.push({ jobId: p.jobId, label: n.label, why });
      else keep.push(n);
    }
    for (const r of questionsForTrainee({ jobId: p.jobId, company: p.company, location: p.location, needs: keep, answers: o.answers, answered: o.answered }).questions as any[]) {
      if (staysWithPosting(r)) {
        left.push({ jobId: p.jobId, label: r.label, why: "agreement" });
        continue;
      }
      const g = by.get(r.key) ?? { key: r.key, kind: r.kind, postings: [] as PanelQuestion["postings"], perPosting: String(r.key).startsWith("job:") };
      g.postings.push({ jobId: p.jobId, company: p.company, label: r.label, type: r.type, options: r.options, misfit: !!r.misfit });
      by.set(r.key, g);
    }
  }
  const questions: PanelQuestion[] = [...by.values()].map((g) => {
    // The wording most postings use (the first seen on a tie), and that posting's own options; it goes first.
    const count = new Map<string, number>();
    for (const a of g.postings) count.set(shortLabel(a.label), (count.get(shortLabel(a.label)) ?? 0) + 1);
    const top = [...count].reduce((b, x) => (x[1] > b[1] ? x : b))[0];
    const rep = g.postings.find((a) => shortLabel(a.label) === top)!;
    const postings = [rep, ...g.postings.filter((a) => a !== rep)];
    return { ...g, postings, label: rep.label, type: rep.type, options: rep.options, similar: count.size - 1, selected: null };
  });
  // Asked by the most postings first; otherwise in queue order (sort is stable).
  questions.sort((a, b) => b.postings.length - a.postings.length);
  return { questions, left };
}
// The person's picks as the rows the store already takes: per posting, the questions (career_apply_questions_put_own, so
// the row names that posting) and the answers (career_apply_questions_answer_from_form_own, under the same key the text
// path uses). An empty pick is a skip, left for the card. A pick that is not one of the shown options, an identity-shaped
// number, or (beyond one posting) an answer naming an employer or a how-heard that names no channel is refused, never kept.
export function answerOnceRows(o: { questions: PanelQuestion[]; picks: { key: string; answer: string }[] }) {
  const groups = new Map<string, { posting: string; questions: Record<string, unknown>[]; answers: { key: string; kind: string; label: string; type: string; options: string[]; company: string; answer: string }[] }>();
  const refused: { key: string; why: string }[] = [];
  for (const pick of o.picks) {
    const q = o.questions.find((x) => x.key === pick.key);
    const answer = String(pick.answer ?? "").replace(/\s+/g, " ").trim();
    if (!q || !answer) continue;
    const why = answer.length > 2000 || answer === MASKED || looksLikeIdNumber(answer) ? "not an answer Trainee keeps"
      : q.options.length && !q.options.includes(answer) ? "not one of the employer's options"
      : !q.perPosting && (q.postings.some((a) => namesEmployer(answer, a.company)) || (q.key === "fact:how_heard" && !howHeardChannel(answer)))
      ? "it names one employer, so it is answered on that card" : null;
    if (why) {
      refused.push({ key: q.key, why });
      continue;
    }
    const at = q.postings[0];
    const g = groups.get(at.jobId) ?? { posting: at.jobId, questions: [], answers: [] };
    g.questions.push({ key: q.key, kind: q.kind, label: at.label, type: at.type, options: at.options, company: at.company, misfit: at.misfit });
    g.answers.push({ key: q.key, kind: q.kind, label: at.label, type: at.type, options: at.options, company: at.company, answer });
    groups.set(at.jobId, g);
  }
  return { groups: [...groups.values()], refused };
}
// The fields on a card Trainee filled from an answer the person gave in the panel before the session (its stored row).
export const beforeSession = (fields: SnapField[], factIds: string[]) =>
  fields.filter((f) => f.source === "trainee" && !!f.factId && factIds.includes(f.factId)).map((f) => f.name);

// ------------------------------------------------------------------------------------------------ the reviewed payload
// Every answer the form will send, read back from the page, with where it came from:
//   trainee  filled by the extension from a confirmed fact (its fact id), unchanged since
//   you      typed or picked by the person on the page (a trusted input event)
//   page     set by the employer's page or changed by a script, not by the person: never approved (blocks the tap)
//   fixed    a read-only field the employer's page set (a reference code): shown, bound to the approval, not blocking
//   drafted  a written answer Trainee drafted on the card from the person's confirmed facts, put on the form by the
//            person's own "Use this" (and edited by them, if they did); its factId names the facts (WO-049)
// `detail` is what the browser actually sends for the field beyond its visible text: a select's option value, the checked
// state and value of radios and checkboxes, the SHA-256 and size of an attached file's bytes (WO-031 review: the hash
// covered what was shown, not what was sent).
//   workday  (WO-048) a value Workday itself had set when Trainee first read the page (a tenant's default, a resume parse):
//            shown under "Filled by Workday from your resume: check them", never counted as Trainee's, never overwritten
export type Source = "trainee" | "you" | "page" | "fixed" | "drafted" | "workday";
export interface SnapField { name: string; label: string; value: string; source: Source; factId: string | null; masked: boolean; detail?: string }
export const MASKED = "[typed by you on the form; never kept by Trainee]";

export interface Account { epoch: number; version: number }
export function reviewPayload(o: {
  userId: string; jobId: string; company: string; url: string; family: Family;
  fields: SnapField[]; resume: { filename: string; sha256: string } | null; account: Account; expiresAt: string;
  manifest?: { hash: string; version: string } | null;
}) {
  return {
    // WO-102: the approval binds the trusted fact manifest and the quarantine version it was made under.
    ...(o.manifest ? { manifest_hash: o.manifest.hash, quarantine_version: o.manifest.version } : {}),
    version: 1 as const,
    source: "extension",
    user_id: o.userId,
    job_id: o.jobId,
    company: o.company,
    url: o.url,
    family: o.family,
    fields: o.fields.map((f) => ({ name: f.name, label: f.label, value: f.masked ? MASKED : f.value, source: f.source, factId: f.factId, detail: f.masked ? "" : f.detail ?? "" })),
    resume_name: o.resume?.filename ?? null,
    resume_sha256: o.resume?.sha256 ?? null,
    privacy_epoch: o.account.epoch,
    account_version: o.account.version,
    expires_at: o.expiresAt,
  };
}
export type ReviewPayload = ReturnType<typeof reviewPayload>;
// The approval is bound to this hash: the same canonical SHA-256 the queue's SQL computes (career_apply_canonical), so
// the database can check the person approved exactly what is recorded.
export const approvalHash = (p: ReviewPayload) => hashApplyPayload(p);
// The same payload as one string, for the check made in the same task as the click (a hash needs an await; this does not).
export const payloadText = (p: ReviewPayload) => JSON.stringify(p);

// Which answers differ between what the person reviewed and what the page holds now.
export function changedFields(reviewed: SnapField[], now: SnapField[]): string[] {
  const out: string[] = [];
  const at = new Map(now.map((f) => [f.name, f]));
  for (const r of reviewed) {
    const n = at.get(r.name);
    if (!n || n.value !== r.value || n.source !== r.source || (n.detail ?? "") !== (r.detail ?? "")) out.push(r.label);
  }
  for (const n of now) if (!reviewed.some((r) => r.name === n.name)) out.push(n.label);
  return out;
}

// What stops the one tap: a value the page set, a required question left open, a verification on the page.
export function blockers(o: { fields: SnapField[]; openRequired: string[]; challenge: boolean; family: Family }) {
  const out: string[] = [];
  if (o.challenge) out.push("A verification check is showing on the page. Finish it yourself there; Trainee never answers one.");
  for (const f of o.fields.filter((x) => x.source === "page")) {
    out.push(`"${f.label}" was set by the page, not by you or Trainee. Change or clear it yourself on the form.`);
  }
  for (const l of o.openRequired) out.push(`"${l}" is required and not answered yet.`);
  return out;
}

// What the page shows after the click, judged by the engine's classifyOutcome, with two rules of the extension's own
// (WO-031 review: one posting reached the employer twice). An error that was already on the page before the click (a
// cookie banner, a notice) is not the employer's answer. And after a click nothing is ever "not submitted": an end the
// page does not make clear (no answer within the wait, the form gone without a word) is unknown_outcome, which counts as
// applied and is never sent again.
export const NO_ANSWER_WAIT_MS = 30_000;
export function outcomeAfterClick(o: Observation, before: string[] = [], timedOut = false) {
  // An error counts only while the form is still there (a notice on a thank-you page is not a refused form), and only if
  // it was not already showing before the click.
  const fresh = o.form_present_after ? (o.validation_errors || []).filter((e) => !before.includes(e)) : [];
  const r = classifyOutcome({ ...o, validation_errors: fresh });
  if (timedOut && o.form_present_after && !fresh.length && !o.captcha && !o.email_code_prompt) {
    return { state: "unknown_outcome", reason: "the employer did not answer within 30 seconds; counted as applied, never sent again", confirmation_id: null };
  }
  if (r.state === "not_submitted") return { state: "unknown_outcome", reason: `after the click, ${r.reason}; counted as applied, never sent again`, confirmation_id: null };
  return r;
}
export const BEFORE_CLICK = "stopped before the click";

// The card the person reads before the tap: plain text, every answer exactly as it will be sent.
const MARK: Record<string, string> = { consent: "You agree: ", attestation: "Your statement: ", screen: "About this job: " };
// A label as the person reads it: the form's required star dropped, a long statement cut at 160 characters.
export const shortLabel = (l: string) => {
  const t = String(l || "").replace(/\s*[*✱]+\s*$/, "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
};
// WO-048: what one Workday step's card says. A page step ("draft"): that page's answers exactly as Save and Continue will
// send them, Workday's own values apart, and that nothing is submitted. The Review step ("submit"): the review page's own
// reading of every answer, and the one Submit.
export interface WorkdayCard {
  action: "draft" | "submit"; step: string; employer: string; conflicts?: { label: string; workday: string; yours: string }[]; personal?: boolean;
}
export function cardLines(o: {
  company: string; family: Family; payload: ReviewPayload; openRequired: string[]; identity: { label: string }[];
  blockers: string[]; verification: string[]; ambiguous?: { label: string }[]; workday?: WorkdayCard; before?: string[]; coverFiles?: CoverFile[];
}) {
  if (o.family === "workday" && o.workday) return workdayLines(o as typeof o & { workday: WorkdayCard });
  const lines: string[] = [`${o.company}`];
  if (o.family === "workday") lines.push(WORKDAY_NOTICE);
  lines.push("Every answer exactly as it will be sent:");
  for (const f of o.payload.fields) {
    const ids = draftFactIds(f.factId);
    // WO-054: an answer the person gave in the panel before the session says so, so they check it here.
    const from = f.source === "trainee" ? (o.before?.includes(f.name) ? " (your answer, answered before the session)" : "") : f.source === "you" ? " (typed by you)" : f.source === "fixed" ? " (set by the employer's page, read-only)"
      : f.source === "drafted" ? ` (drafted by Trainee from your confirmed facts${ids.length ? ` ${ids.join(", ")}` : ""}; put on the form by you)` : " (set by the page)";
    // WO-122: a sensitive answer Trainee reused says where it came from (the shared formatter; the panel's payload carries
    // no answer date or zone, so a texted one's freshness is unknown and it takes none).
    const reused = f.source === "trainee" ? reusedSourceSuffix({ label: f.label, factId: f.factId }, o.payload.job_id) : "";
    lines.push(`${MARK[mapQuestion({ label: f.label }).kind] ?? ""}${shortLabel(f.label)}: ${f.value}${reused}${from}`);
  }
  lines.push(`Resume: ${o.payload.resume_name ?? "none attached"}`);
  // FRS: a cover-letter upload is the person's to attach (never asked by text, never the resume); an optional one left empty says so.
  const covers = (o.coverFiles ?? []).filter((c) => !c.attached && !c.pasted);
  for (const l of o.openRequired) {
    const c = covers.find((x) => x.required && shortLabel(x.label) === l);
    lines.push(c ? coverLetterLine(c) : `Still needed: ${l}. Answer it on the form, or answer Trainee once by text and it fills on every later form.`);
  }
  for (const c of covers.filter((x) => !x.required)) lines.push(coverLetterLine(c));
  for (const f of o.ambiguous ?? []) lines.push(`Still needed: ${shortLabel(f.label)}. Two fields on this form share that label, so Trainee left both for you.`);
  for (const f of o.identity) lines.push(`Type this yourself on the form: ${f.label}. Trainee never fills, keeps or sends it anywhere.`);
  if (o.verification.length) lines.push(`The page runs a verification check (${o.verification.join(", ")}). If it asks you something, you answer it.`);
  lines.push(`Approve sends it with the site's own Submit at ${new URL(o.payload.url).host}.`);
  for (const b of o.blockers) lines.push(`Before you can approve: ${b}`);
  return lines.map((l) => l.trim()).filter(Boolean);
}
function workdayLines(o: Parameters<typeof cardLines>[0] & { workday: WorkdayCard }) {
  const w = o.workday;
  const lines: string[] = [`${o.company}`, WORKDAY_NOTICE];
  const line = (f: ReviewPayload["fields"][number], from = "") => `${MARK[mapQuestion({ label: f.label }).kind] ?? ""}${shortLabel(f.label)}: ${f.value}${from}`;
  if (w.action === "submit") {
    lines.push(`${w.step || "Review"}: your application exactly as Workday shows it before Submit:`);
    // The review's labels carry their step and section ("My Experience: Languages 1 — Writing"); read as they are.
    for (const f of o.payload.fields) lines.push(`${shortLabel(f.label)}: ${f.value}`);
  } else {
    lines.push(`${w.step || "This page"}: every answer on this page exactly as Save and Continue will send it:`);
    for (const f of o.payload.fields.filter((x) => x.source !== "workday")) {
      lines.push(line(f, f.source === "you" ? " (typed by you)" : f.source === "fixed" ? " (set by the employer's page, read-only)" : f.source === "page" ? " (set by the page)" : ""));
    }
    const ws = o.payload.fields.filter((x) => x.source === "workday");
    if (ws.length || w.conflicts?.length) lines.push(WORKDAY_PAGE_SET);
    for (const f of ws) lines.push(line(f));
    for (const c of w.conflicts ?? []) {
      lines.push(`${shortLabel(c.label)}: Workday has "${c.workday}"; your confirmed answer is "${c.yours}". Trainee left Workday's value; change it on the page if yours is right.`);
    }
  }
  if (w.personal) lines.push(WORKDAY_PERSONAL);
  for (const l of o.openRequired) lines.push(`Still needed: ${l}. Answer it on the page.`);
  for (const f of o.ambiguous ?? []) lines.push(`Still needed: ${shortLabel(f.label)}. Two fields on this page share that label, so Trainee left both for you.`);
  for (const f of o.identity) lines.push(`Type this yourself on the form: ${f.label}. Trainee never fills, keeps or sends it anywhere.`);
  if (o.verification.length) lines.push(`The page runs a verification check (${o.verification.join(", ")}). If it asks you something, you answer it.`);
  lines.push(w.action === "submit" ? workdaySubmitLine(w.employer) : workdayDraftLine(w.employer));
  for (const b of o.blockers) lines.push(`Before you can approve: ${b}`);
  return lines.map((l) => l.trim()).filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ evidence
// No identity number leaves the page: the reviewed payload already carries MASKED for those fields; the confirmation text
// is scrubbed of anything shaped like one (an SSN, a nine-digit number) before it is kept or recorded.
export function scrubIdentity(text: string): string {
  return String(text || "").replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[number removed]").replace(/\b\d{9}\b/g, "[number removed]");
}
export function outcomeOf(o: Observation) {
  return classifyOutcome(o);
}
// The record must fit the queue's 64 KB evidence limit, or every try to record it fails (WO-031 review): an answer over
// 500 characters is kept as its first 500, its length and the SHA-256 of the whole; if the record is still too big, the
// answers are kept as hashes only. Its shape is fixed (WO-042 counts on it): times, screenshot_sha256,
// screenshot_after_sha256, confirmation_text, confirmation_id, url_after.
const sha256Text = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((n) => n.toString(16).padStart(2, "0")).join("");
export const EVIDENCE_LIMIT = 60_000;
export async function evidenceRecord(o: {
  payload: ReviewPayload; hash: string; outcome: { state: string; reason: string; confirmation_id: string | null };
  pageText: string; urlAfter: string; screenshotSha256: string | null; screenshotAfterSha256: string | null;
  times: { card: number; approved: number; clicked: number; done: number }; drafts?: Record<string, { original: string; factIds: string[] }>;
}) {
  const answers: Record<string, unknown>[] = [];
  // WO-049 (D-024): a drafted answer says so in the record, with the facts it came from and whether the person edited it.
  const drafted = draftProvenance(o.payload.fields, o.drafts ?? {});
  for (const f of o.payload.fields) {
    const d = drafted[f.name];
    const prov = d ? { fact_ids: d.fact_ids, edited: d.edited, provenance: d.said } : {};
    answers.push(f.value.length > 500
      ? { label: f.label.slice(0, 300), value: f.value.slice(0, 500), value_length: f.value.length, value_sha256: await sha256Text(f.value), source: f.source, ...prov }
      : { label: f.label.slice(0, 300), value: f.value, source: f.source, ...prov });
  }
  const iso = (t: number) => new Date(t).toISOString();
  const rec = {
    reason: o.outcome.reason,
    confirmation_id: o.outcome.confirmation_id,
    source: "extension",
    approval_hash: o.hash,
    answers,
    screenshot_after_sha256: o.screenshotAfterSha256,
    times: { card_shown_at: iso(o.times.card), approved_at: iso(o.times.approved), clicked_at: iso(o.times.clicked), finished_at: iso(o.times.done) },
    resume_name: o.payload.resume_name,
    screenshot_sha256: o.screenshotSha256,
    confirmation_text: scrubIdentity(o.pageText).slice(0, 2000),
    url_after: o.urlAfter,
    card_shown_at: new Date(o.times.card).toISOString(),
    approved_at: new Date(o.times.approved).toISOString(),
    clicked_at: new Date(o.times.clicked).toISOString(),
    finished_at: new Date(o.times.done).toISOString(),
    ms_card_to_done: o.times.done - o.times.card,
  };
  if (JSON.stringify(rec).length > EVIDENCE_LIMIT) {
    rec.answers = await Promise.all(o.payload.fields.map(async (f) => ({ value_sha256: await sha256Text(f.label + "\n" + f.value), source: f.source,
      ...(drafted[f.name] ? { fact_ids: drafted[f.name].fact_ids, edited: drafted[f.name].edited } : {}) })));
  }
  return rec;
}

// "Confirmed" needs proof the person can see: the page after the click was read and photographed. Without the after
// screenshot the card never says confirmed (the owner: "when someone submits... they need to show proof").
// WO-096: codeStop is what the person does about an emailed code Trainee could not type for them (connect Google, or
// type it), said instead of the general line. Never the code.
export function cardOutcome(o: { state: string; reason: string; confirmation_id: string | null }, hasAfterShot: boolean, codeStop?: string | null) {
  if (o.state === "needs_user" && o.reason === "email_code" && codeStop) {
    return { status: "done", message: `Sent, and the page now asks for the code the employer emailed you. ${codeStop}` };
  }
  if (o.state === "confirmed" && hasAfterShot) {
    return { status: "done", message: `Sent; the employer's page confirmed it${o.confirmation_id ? ` (${o.confirmation_id})` : ""}. Their email makes it final.` };
  }
  if (o.state === "confirmed" || o.state === "submitted_unconfirmed" || o.state === "unknown_outcome") {
    return { status: "done", message: "Sent; the employer's answer could not be captured. Check your email for their confirmation." };
  }
  if (o.state === "needs_user") return { status: "done", message: "Sent, and the page now asks you for something (a check or a code). Finish it yourself on the page." };
  return { status: "done", message: `Not confirmed: ${o.reason}.` };
}

// Links to postings in a pasted list or in Trainee's alert texts: one posting each, in order, the form's own page.
export function postingLinks(text: string, max = 100): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const m of String(text || "").matchAll(/https:\/\/[^\s<>"')]+/g)) {
    const url = m[0].replace(/[.,;]+$/, "");
    const key = postingKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(applyUrl(url));
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ written answers (WO-049)
// The card offers "Draft from my facts" on each written question the form still needs (question_map: kind essay). The
// draft is the server's (supabase/functions/career-essay-draft): the employer's AI policy first, the person's confirmed
// facts only, every item traced, the form's limit met by writing again. It reaches the form only by the person's "Use
// this", as source "drafted", and the approval binds its exact text like any other answer.
export const DRAFT_PREFIX = "essay-draft:";
// The facts a drafted answer came from, carried in the payload field's factId (at most 200 characters, as a fact id).
export function draftFactId(ids: string[]): string {
  let out = DRAFT_PREFIX;
  for (const id of ids.map((x) => String(x).replace(/[,\s]+/g, "")).filter(Boolean)) {
    const next = out === DRAFT_PREFIX ? out + id : `${out},${id}`;
    if (next.length > 200) break;
    out = next;
  }
  return out;
}
export const draftFactIds = (factId: string | null | undefined): string[] =>
  typeof factId === "string" && factId.startsWith(DRAFT_PREFIX) ? factId.slice(DRAFT_PREFIX.length).split(",").filter(Boolean) : [];

export interface EssayAsk { name: string; label: string; type: string; chars: number | null; own: string | null }
// The employer's own AI policy, read on the card as the server reads it (ai_policy.ts over the question and the form's
// other labels): a form that asks for answers written without AI, or names a policy it does not spell out, is never
// offered a draft; the card says so up front and no request is sent (WO-049 follow-up).
export const OWN_WORDS_BANNED = "This form asks for answers written without AI, so Trainee won't draft this one: it needs your own words.";
export const OWN_WORDS_UNREAD = "This form names its own AI policy without saying what it allows, so Trainee won't draft this one: it needs your own words.";
// The written questions the card offers to draft: required, not an identity number, a written answer by the question map,
// and not answered yet, or answered with a draft the person used (so its text stays editable on the card). One the person
// typed themselves, or that Trainee filled from a saved answer, is theirs and not offered.
// FRS: a cover letter typed into a text box is offered too when it is optional (the person may send one or not).
export function essayQuestions(o: { schema: FormField[]; fields: { name: string; source: string }[]; maxLength?: Record<string, number> }): EssayAsk[] {
  const by = new Map(o.fields.map((f) => [f.name, f]));
  const mapped = (f: FormField) => mapQuestion({ label: f.label, type: f.type, options: f.options || [] });
  return o.schema
    .filter((f) => !isIdentityField(f) && mapped(f).kind === "essay" && (f.required || mapped(f).fact === "essay_cover_letter"))
    .filter((f) => !by.has(f.name) || by.get(f.name)!.source === "drafted")
    .map((f) => {
      const n = Number(o.maxLength?.[f.name]);
      const policy = readAiPolicy([f.label, ...o.schema.map((x) => x.label).filter((l) => l !== f.label)]).policy;
      const own = policy === "prohibited" ? OWN_WORDS_BANNED : policy === "unread" ? OWN_WORDS_UNREAD : null;
      return { name: f.name, label: String(f.label), type: String(f.type || "textarea"), chars: Number.isInteger(n) && n > 0 ? n : null, own };
    });
}
// A draft the card may show: the server said ok, whole text that ends a sentence, within one answer's size. Anything else
// (a refusal, an unverified or cut-off draft) is never shown; the card says why in one line.
export function showableDraft(r: unknown): boolean {
  const x = r as any;
  return !!x && x.ok === true && typeof x.text === "string" && x.text.trim().length > 0 && x.text.length <= 2000 &&
    /[.!?]["”')\]]?$/.test(x.text.trim()) && Array.isArray(x.fact_ids) && x.fact_ids.every((i: unknown) => typeof i === "string");
}
// FRS: the form's cover-letter uploads (a file whose label names a cover letter and not a resume), whether the person
// attached one, and whether its paste box (Greenhouse's cover_letter_text, a fileAlternative) holds one instead. Trainee
// never attaches one: it makes no cover-letter file, and never sends the resume as one (judge).
export interface CoverFile { name: string; label: string; required: boolean; attached: boolean; pasted: boolean }
export const isCoverLetterFile = (f: { label: string; type: string }) => /file/.test(String(f.type)) && mapQuestion({ label: f.label, type: "file" }).fact === "cover_letter";
export function coverLetterFiles(o: { schema: FormField[]; fields: { name: string }[] }): CoverFile[] {
  const have = new Set(o.fields.map((f) => f.name));
  return o.schema.filter(isCoverLetterFile).map((f) => ({ name: f.name, label: f.label, required: !!f.required, attached: have.has(f.name),
    pasted: o.schema.some((x) => x.name === `${f.name}_text` && fileAlternative(x, o.schema) && have.has(x.name)) }));
}
export const coverLetterLine = (c: { label: string; required: boolean }) => c.required
  ? `Still needed: ${shortLabel(c.label)}. Attach your cover letter on the form yourself; Trainee never attaches your resume as a cover letter.`
  : `Left empty: ${shortLabel(c.label)} (optional). Trainee doesn't attach a cover letter, and never your resume as one; attach one yourself if you want to send it.`;

// For the proof (D-024): each drafted answer, the facts it came from and whether the person edited it before it went.
export function draftProvenance(fields: { name: string; value: string; source: string; factId: string | null }[],
  drafts: Record<string, { original: string; factIds: string[] }>) {
  const out: Record<string, { fact_ids: string[]; edited: boolean; said: string }> = {};
  const flat = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();
  for (const f of fields) {
    if (f.source !== "drafted") continue;
    const d = drafts[f.name];
    const ids = draftFactIds(f.factId).length ? draftFactIds(f.factId) : d?.factIds ?? [];
    const edited = !d || flat(f.value) !== flat(d.original);
    out[f.name] = { fact_ids: ids, edited, said: `drafted by Trainee from your facts${ids.length ? ` (${ids.join(", ")})` : ""}, ${edited ? "edited and used by you" : "used by you as drafted"}` };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ trusted facts (WO-102)
// The second judge's submission-quality contract. Only facts the owner gave reach a batch: a positive allowlist, not a
// blocklist. A fact from his confirmed-facts file is kept only when it is confirmed, his own, says where it came from in
// a positive way ("owner stated ...", "owner confirmed ..."), names the event that confirmed it, is not quarantined
// (D-007: the answer-all delegation of 2026-10-17, by id or provenance), does not borrow an id reserved for another
// source, and is not derived from anything not kept. His own answers to asked questions (career_apply_questions rows)
// are kept as his. A text answer that disagrees with the file excludes both: the question is asked again. The resume is
// the file he picked. The manifest's hash and the quarantine version are bound into every batch approval.
export const QUARANTINE_VERSION = "d007-v1";
const POSITIVE = /^owner (stated|confirmed|typed|answered|gave|provided|picked)\b/i;
const RESERVED = /^(text-answer:|approved-local-resume:|essay-draft:)/;
// WO-122: a texted answer keeps when it was answered (`at`) and the postings its question was asked for (`job_ids`), for
// the card's source label. Neither is in the manifest's hash nor its identity: they say where, never what, it is.
export interface TrustedFact { table: "answers" | "saved"; key: string; value: string; factId: string; event: string; provenance: string; authorizes: boolean; at?: string; job_ids?: string[] }
export interface Manifest {
  answers: Record<string, Answer>; saved: Record<string, Answer>; byFactId: Record<string, TrustedFact>;
  excluded: { key: string; factId: string; why: string }[]; conflicts: { key: string; factIds: string[] }[]; hash: string; version: string;
}
export function trustedManifest(o: { owner: string; file: any; rows: { id: string; key: string; kind?: string; answer: string; at?: string; job_ids?: string[] }[]; resume: { sha256: string } | null }): Manifest {
  const excluded: Manifest["excluded"] = [], conflicts: Manifest["conflicts"] = [];
  const kept = new Map<string, TrustedFact>(); // table + key -> fact
  const file = o.file && typeof o.file === "object" ? o.file : null;
  let projectedAnswers: Record<string, unknown> = {};
  // Raw profile facts supply shape only. The existing allowlist below still decides source authority,
  // quarantine, derivation and conflicts; projection cannot create a confirmation event.
  if (Array.isArray(file?.facts)) {
    const projected = typedProfileFile({ owner: o.owner, profile: file });
    projectedAnswers = projected.file.answers;
    excluded.push(...projected.needs.map((n) => ({ key: "profile", factId: n.factId, why: n.reason })));
  }
  const fileOwn = !!file && file.user_id === o.owner;
  const candidates: { t: "answers" | "saved"; key: string; a: any }[] = [];
  for (const t of ["answers", "saved"] as const) {
    for (const [key, a] of [...Object.entries((file?.[t] ?? {}) as Record<string, any>), ...Object.entries(t === "answers" ? projectedAnswers : {})] as [string, any][]) {
      const id = String(a?.factId ?? "");
      const why = !fileOwn ? "another person's file" : a?.user_id && a.user_id !== o.owner ? "another person's fact"
        : a?.confirmed !== true ? "not confirmed" : typeof a?.value !== "string" || !a.value.trim() ? "no value"
        : !id || id.length > 200 ? "no fact id" : RESERVED.test(id) ? "an id reserved for another source (forged)"
        : quarantinedFact(a) ? `quarantined (D-007, ${QUARANTINE_VERSION})` : !POSITIVE.test(String(a?.provenance ?? "")) ? "no positive provenance (not stated by the owner)"
        : typeof a?.confirmation_event_id !== "string" || !a.confirmation_event_id.trim() ? "no confirmation event" : "";
      if (why) excluded.push({ key, factId: id, why });
      else candidates.push({ t, key, a });
    }
  }
  // Derived facts stand only on kept facts: drop, until nothing changes, any whose sources are not all kept.
  const grouped = new Map<string, typeof candidates>();
  for (const c of candidates) { const key = c.t + "\n" + c.key; grouped.set(key, [...grouped.get(key) ?? [], c]); }
  const conflicting = new Set<string>();
  for (const [key, rows] of grouped) {
    if (new Set(rows.map((c) => c.a.value.trim().replace(/\s+/g, " ").toLowerCase())).size <= 1) continue;
    conflicting.add(key);
    conflicts.push({ key: rows[0].key, factIds: rows.map((c) => String(c.a.factId)) });
    for (const c of rows) excluded.push({ key: c.key, factId: String(c.a.factId), why: "conflicts with another confirmed source for this field" });
  }
  let live = candidates.filter((c) => !conflicting.has(c.t + "\n" + c.key));
  for (let changed = true; changed;) {
    changed = false;
    const ids = new Set(live.map((c) => String(c.a.factId)));
    live = live.filter((c) => {
      const from = factDependencies(c.a);
      if (from !== null && from.every((x: string) => ids.has(x))) return true;
      excluded.push({ key: c.key, factId: String(c.a.factId), why: from === null ? "malformed dependency metadata" : "derived from an excluded or unknown fact" });
      changed = true;
      return false;
    });
  }
  for (const c of live) {
    if (kept.has(c.t + "\n" + c.key)) continue; // agreeing raw projection does not replace the original canonical source
    kept.set(c.t + "\n" + c.key, { table: c.t, key: c.key, value: c.a.value, factId: String(c.a.factId), event: String(c.a.confirmation_event_id),
      provenance: String(c.a.provenance), authorizes: c.a.authorizes === true });
  }
  // His own answers to asked questions.
  const n = (x: string) => String(x ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const r of o.rows || []) {
    if (!r || typeof r.answer !== "string" || !r.answer.trim() || typeof r.key !== "string") continue;
    const t = r.key.startsWith("fact:") ? "answers" : /^(label|job):[0-9a-f]{16}$/.test(r.key) ? "saved" : null;
    if (!t) continue;
    const key = t === "answers" ? r.key.slice(5) : r.key;
    const tf: TrustedFact = { table: t, key, value: r.answer, factId: `text-answer:${r.id}`, event: `text-answer:${r.id}`,
      provenance: `owner answered this question (text-answer:${r.id})`, authorizes: t === "saved",
      ...(typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) ? { at: r.at } : {}),
      ...(Array.isArray(r.job_ids) ? { job_ids: r.job_ids.map(String).slice(0, 200) } : {}) };
    const prior = kept.get(t + "\n" + key);
    if (!prior) kept.set(t + "\n" + key, tf);
    else if (n(prior.value) !== n(tf.value)) {
      kept.delete(t + "\n" + key);
      conflicts.push({ key, factIds: [prior.factId, tf.factId] });
      excluded.push({ key, factId: prior.factId, why: `conflicts with ${tf.factId}` }, { key, factId: tf.factId, why: `conflicts with ${prior.factId}` });
    }
  }
  if (o.resume?.sha256) {
    kept.set("answers\nresume", { table: "answers", key: "resume", value: o.resume.sha256, factId: "approved-local-resume:" + o.resume.sha256,
      event: "resume:" + o.resume.sha256, provenance: "owner picked this file in the panel", authorizes: false });
  }
  const answers: Record<string, Answer> = {}, saved: Record<string, Answer> = {}, byFactId: Record<string, TrustedFact> = {};
  for (const tf of kept.values()) {
    (tf.table === "answers" ? answers : saved)[tf.key] = { value: tf.value, factId: tf.factId };
    byFactId[tf.factId] = tf;
  }
  const rows = [...kept.values()].map((x) => [x.table, x.key, x.factId, x.value, x.event, x.provenance, x.authorizes]).sort((a, b) => (String(a) < String(b) ? -1 : 1));
  return { answers, saved, byFactId, excluded, conflicts, version: QUARANTINE_VERSION, hash: sha256Hex(canonicalJson({ version: QUARANTINE_VERSION, rows })) };
}
// Questions that are an attestation or a personal choice: only the owner's own answer to that question fills them.
const ATTESTATION = /\b(certify|certif(y|ies)|attest|acknowledg\w*|i agree|agree to|consent|i understand|truthful|true and (complete|correct|accurate)|privacy (policy|notice))\b/i;
const PERSONAL = /\b(gender|pronoun|race|ethnic\w*|hispanic|latin[oax]?|veteran|disabilit\w*|sexual orientation|transgender|lgbt\w*)\b/i;
// The same test for every reader of saved answers (module 149 reads it from the bundle, MUSE-F-007).
export const ownAnswerOnly = (label: string) => ATTESTATION.test(label) || PERSONAL.test(label);
// The canonical JSON the apply stack hashes (sorted keys, compact), and a synchronous SHA-256 for the ledger's hashes.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v as Record<string, unknown>).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k])).join(",") + "}";
}
export function sha256Hex(text: string): string {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = r(w[t - 15], 7) ^ r(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = r(w[t - 2], 17) ^ r(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g, g = f, f = e, e = (d + t1) >>> 0, d = c, c = b, b = a, a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0, h[1] = (h[1] + b) >>> 0, h[2] = (h[2] + c) >>> 0, h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0, h[5] = (h[5] + f) >>> 0, h[6] = (h[6] + g) >>> 0, h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

// ------------------------------------------------------------------------------------------------ agent batch (WO-101)
// The agent submits; the person approves a batch up front, of the exact answers (CLAUDE.md: "external effects need the
// user's approval of the exact payload"). One posting's entry is every answer the planner will send, as the browser sends
// it (`value`) and as the page will show it (`shown`: a select's option text, the resume's file name), with the fact
// behind it, and every field left blank. A posting with anything the person must answer or do first is not in a batch.
// A field whose options exist only on the page (a place search, a dropdown widget: `listed`, read by the content script)
// shows the person's answer; on the page Trainee puts it on the employer's own entry for it (chooseWidgetOption, WO-042).
// The checkbox state the page reads for a box Trainee leaves unchecked (content.js shows it so the card says so).
export const NO_UNCHECKED = "No (left unchecked)";
export type BatchKind = "text" | "select" | "choice" | "checkbox" | "file" | "listed";
export interface BatchAnswer { name: string; label: string; value: string; shown: string; kind: BatchKind; factId: string; file: string | null }
// One ledger row per answer (WO-102): where it goes, what was asked, what is sent, the facts and events behind it, and the
// rule that turned the fact into the answer. Batch 1 allows only rules that keep the owner's meaning exactly.
export interface LedgerRow {
  application_id: string; field_id: string; question_hash: string; answer_hash: string; fact_refs: string[]; source_refs: string[];
  confirmation_event_id: string; derivation_rule: string;
}
export interface BatchPosting {
  jobId: string; company: string; url: string; answers: BatchAnswer[]; blank: string[];
  ledger: LedgerRow[]; question_set_hash: string; manifest_hash: string | null; quarantine_version: string | null;
}
export type BatchPlan = { ok: true; posting: BatchPosting } | { ok: false; why: string[] };
const YES = /^(true|yes|y|on|checked)\b/i;
// A checkbox with more than one option is a group (the reader's checkbox_group), read back as its checked options' texts.
const kindOf = (f: FormField, listed: Set<string>): BatchKind =>
  /file/.test(f.type) ? "file" : listed.has(f.name) || f.widget ? "listed" : f.type === "checkbox" && f.options.length < 2 ? "checkbox"
  : f.type === "checkbox" || /radio|checkbox_group|multi_value_multi_select/.test(f.type) ? "choice" : f.options.length ? "select" : "text";
const optionText = (f: FormField, v: string) => {
  const one = (x: string) => f.options.find((o) => o.value === x) ?? f.options.find((o) => o.label === x);
  const o = one(v);
  if (o) return { value: o.value, shown: String(o.label).replace(/\s+/g, " ").trim() };
  const parts = v.split(/,\s*/).map(one);
  return parts.length > 1 && parts.every(Boolean) ? { value: v, shown: parts.map((x) => String(x!.label).replace(/\s+/g, " ").trim()).join(", ") } : null;
};
export function batchPlan(o: {
  jobId: string; company: string; url: string; family: Family; schema: FormField[]; plan: ReturnType<typeof planForm>;
  challenge: boolean; resume: { filename: string; sha256: string } | null; listed?: string[]; manifest?: Manifest;
}): BatchPlan {
  const listed = new Set(o.listed ?? []);
  const m = o.manifest ?? null;
  const why: string[] = [];
  if (!o.schema.length) why.push("No application form was read on this posting.");
  if (o.family === "workday") why.push("Workday applications are sent card by card by you, not in a batch.");
  if (o.challenge) why.push("A verification check is on the page. Trainee never answers one, so this one is yours to send.");
  for (const n of o.plan.needs) {
    why.push(o.schema.some((f) => f.label === n.label && isCoverLetterFile(f))
      ? `"${n.label}" asks for a cover letter file: only you attach one (Trainee never sends your resume as one), so this one is yours to send.`
      : `"${n.label}" needs your answer first.`);
  }
  for (const f of o.plan.identity.filter((x) => x.required)) why.push(`"${f.label}" is an identity number: only you type it, so this one is yours to send.`);
  for (const f of o.plan.ambiguous.filter((x) => x.required)) why.push(`"${f.label}" is asked twice on the form: only you can tell which is which.`);
  const answers: BatchAnswer[] = [], ledger: LedgerRow[] = [];
  for (const p of o.plan.fill) {
    const f = o.schema.find((x) => x.name === p.name);
    if (!f) continue;
    const kind = kindOf(f, listed);
    if (kind === "file" && !o.resume) {
      why.push(`"${p.label}" needs your resume file in Trainee first.`);
      continue;
    }
    const a = answerOf(f, p, kind, o.resume);
    if (m) {
      // WO-102: every answer stands on a trusted fact, by a rule that keeps its meaning; an attestation or a personal
      // choice only on his own answer to that question. Otherwise a required question is asked; an optional one is left empty.
      const j = judge(f, a, m, o.schema, o.jobId);
      if ("problem" in j) {
        if (f.required) why.push(`"${p.label}": ${j.problem}; it needs your answer first.`);
        continue;
      }
      ledger.push({ application_id: o.jobId, field_id: p.name, question_hash: sha256Hex(canonicalJson({ name: f.name, label: f.label, type: f.type, required: f.required, options: f.options })),
        answer_hash: sha256Hex(canonicalJson({ value: a.value, shown: a.shown, file: a.file })), fact_refs: [j.tf.factId], source_refs: [j.tf.provenance],
        confirmation_event_id: j.tf.event, derivation_rule: j.rule });
    }
    answers.push(a);
  }
  // A required question nothing answers is asked (WO-102: never sent blank, never guessed).
  const said = new Set(why.join("\n").match(/"[^"]+"/g) ?? []);
  for (const f of o.schema) {
    if (!f.required || answers.some((a) => a.name === f.name) || fileAlternative(f, o.schema) || isIdentityField(f) || f.personal) continue;
    if (!said.has(`"${f.label}"`) && !why.some((w) => w.startsWith(`"${f.label}"`))) why.push(`"${f.label}" needs your answer first.`);
  }
  if (why.length) return { ok: false, why };
  answers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sent = new Set(answers.map((a) => a.name));
  const blank = [...new Set(o.schema.filter((f) => !sent.has(f.name)).map((f) => f.label))].sort();
  ledger.sort((a, b) => (a.field_id < b.field_id ? -1 : a.field_id > b.field_id ? 1 : 0));
  const question_set_hash = sha256Hex(canonicalJson([...o.schema].sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((f) => ({ name: f.name, label: f.label, type: f.type, required: f.required, options: f.options }))));
  return { ok: true, posting: { jobId: o.jobId, company: o.company, url: o.url, answers, blank, ledger, question_set_hash,
    manifest_hash: m ? m.hash : null, quarantine_version: m ? m.version : null } };
}
function answerOf(f: FormField, p: PlannedField, kind: BatchKind, resume: { filename: string; sha256: string } | null): BatchAnswer {
  const opt = kind === "select" || kind === "choice" || (kind === "listed" && f.options.length) ? optionText(f, p.value) : null;
  const shown = kind === "file" ? resume?.filename ?? "" : kind === "checkbox" ? (YES.test(p.value) ? "Yes (checked)" : NO_UNCHECKED) : opt ? opt.shown : p.value;
  return { name: p.name, label: p.label, value: opt ? opt.value : p.value, shown, kind, factId: p.factId, file: kind === "file" ? resume?.sha256 ?? null : null };
}
function judge(f: FormField, a: BatchAnswer, m: Manifest, schema: FormField[], jobId?: string): { rule: string; tf: TrustedFact } | { problem: string } {
  const tf = m.byFactId[a.factId];
  if (a.kind === "file" && isCoverLetterFile(f)) return { problem: "it asks for a cover letter, and Trainee never attaches your resume as one" };
  if (!tf) return { problem: "its answer is not from a fact you gave" };
  // Equal spelling cannot make a full name a legal-name assertion. Recheck the source's question meaning even
  // when a caller presents a stale/forged plan; a saved answer stands only on this exact legal-name question.
  if (classifyField(f.label, f.type) === "legal_name" || mapQuestion(f).fact === "legal_name") {
    let legal = tf.table === "answers" && tf.key === "legal_name" && m.answers?.legal_name?.factId === tf.factId;
    if (!legal && tf.table === "saved") {
      const again = planBatch({ userId: "contract-legal-name", postings: [{ job_id: jobId ?? "contract-legal-name", company: "", title: "", fields: [f] }],
        answers: {}, saved: { [tf.key]: { value: tf.value, factId: tf.factId } }, log: [], now: 0 }).ready[0]?.fields.find(p => p.name === f.name);
      legal = !!again && again.factId === a.factId && again.label === a.label && again.value === a.value;
    }
    if (!legal) return { problem: "a legal name needs your stated legal name or your own answer to this exact question" };
  }
  if (ownAnswerOnly(f.label) && !tf.authorizes) return { problem: "it is an attestation or a personal choice, so it takes your own answer to it" };
  const rule = (f.section && tf.table === "saved" ? savedRowRule(f, a, tf, m, jobId) : f.section?.kind === "work" ? workRowRule(f, a, tf, m, schema) : derivation(f, a.kind, a, tf, combinedEligibility(m.answers))) ||
    (!f.section && a.kind === "text" && ["date", "month"].includes(f.type) && canonicalTypedValue(f, tf.value) === a.value ? "calendar-equivalent" : null);
  return rule ? { rule, tf } : { problem: `the answer Trainee would give ("${a.shown}") is not what you said ("${tf.value}")` };
}
function savedRowRule(f: FormField, a: BatchAnswer, tf: TrustedFact, m: Manifest, jobId?: string): string | null {
  const key = rowAnswerKey(f, jobId);
  if (!key || tf.table !== "saved" || tf.key !== key || m.saved[key]?.factId !== tf.factId || m.saved[key]?.value !== tf.value) return null;
  const plan = planBatch({ userId: "contract-row-answer", postings: [{ job_id: jobId!, company: "", title: "", fields: [f] }],
    answers: {}, saved: { [key]: { value: tf.value, factId: tf.factId } }, log: [], now: 0 });
  const p = plan.ready[0]?.fields.find((x) => x.name === f.name);
  if (!p || p.factId !== a.factId || p.label !== a.label) return null;
  const expected = answerOf(f, p, a.kind, null);
  return expected.value === a.value && expected.shown === a.shown ? "row-answer-exact" : null;
}
// Re-derive a work row from the original, trusted JSON through the same planner and actual row/anchor schema.
// A substring somewhere in the history, an answer cached under a label, or another property's value is not proof.
function workRowRule(f: FormField, a: BatchAnswer, tf: TrustedFact, m: Manifest, schema: FormField[]): string | null {
  if (tf.table !== "answers" || tf.key !== "work_history" || m.answers.work_history?.factId !== tf.factId ||
    m.answers.work_history?.value !== tf.value || !f.section || f.section.row < 1) return null;
  const fields = schema.filter((x) => x.section?.kind === "work");
  if (new Set(fields.map((x) => x.name)).size !== fields.length) return null;
  const plan = planBatch({ userId: "contract-rederive", postings: [{ job_id: "contract-rederive", company: "", title: "", fields: fields.map((x) => ({ ...x, required: false })) }],
    answers: { work_history: { value: tf.value, factId: tf.factId } }, saved: {}, log: [], now: 0 });
  const p = plan.ready[0]?.fields.find((x) => x.name === f.name);
  if (!p || p.factId !== a.factId || p.label !== a.label) return null;
  const expected = answerOf(f, p, a.kind, null);
  if (f.options.length && !optionText(f, p.value)) return null;
  return expected.value === a.value && expected.shown === a.shown ? `work-history-row:${f.section.row}:${f.section.part}` : null;
}
// WO-102, in every path before anything is filled: the planner's answers that the contract allows, and the questions it
// turns back to the person (required ones are asked; optional ones are left empty).
export function contractFill(o: { schema: FormField[]; plan: ReturnType<typeof planForm>; manifest: Manifest; listed?: string[]; resume: { filename: string; sha256: string } | null; jobId?: string }) {
  const listed = new Set(o.listed ?? []);
  const askedNames = new Set<string>();
  const fill: PlannedField[] = [], asks: { label: string; type: string; options: string[]; why: string; field_name?: string }[] = [], dropped: string[] = [];
  for (const p of o.plan.fill) {
    const f = o.schema.find((x) => x.name === p.name);
    if (!f) continue;
    const kind = kindOf(f, listed);
    if (kind === "file" && !o.resume && !isCoverLetterFile(f)) {
      fill.push(p);
      continue;
    }
    const jobId = o.jobId ?? o.plan.jobId;
    const j = judge(f, answerOf(f, p, kind, o.resume), o.manifest, o.schema, jobId);
    if (!("problem" in j)) fill.push(p);
    else if (f.required) {
      askedNames.add(f.name);
      const opts = (f.options || []).filter((x) => x.label && !/^select\b/i.test(x.label.trim()));
      asks.push({ label: rowQuestionLabel(f), type: rowQuestionType(f, jobId, questionFieldType(f)), options: opts.length <= 60 ? opts.map((x) => String(x.label)) : [], why: j.problem,
        ...(f.section ? { field_name: f.name } : {}) });
    } else dropped.push(f.label);
  }
  for (const f of o.schema) {
    if (!f.section || !f.required || f.personal || isIdentityField(f) || fill.some((p) => p.name === f.name) || askedNames.has(f.name)) continue;
    const opts = (f.options || []).filter((x) => x.label && !/^select\b/i.test(x.label.trim()));
    asks.push({ label: rowQuestionLabel(f), type: rowQuestionType(f, o.jobId ?? o.plan.jobId, questionFieldType(f)),
      options: opts.length <= 60 ? opts.map((x) => String(x.label)) : [], why: "this row has no matching confirmed answer", field_name: f.name });
  }
  return { fill, asks, dropped };
}
// Batch 1's rules from a fact to an answer: the same words; the employer's option that is those words; a yes or no put
// on the employer's yes or no option or box; the resume he picked. Anything else changes meaning and is asked.
// A widget (`listed`) is a select: by its option when its list is known; else the fact's own words now, and the option it
// opens on is held to the same rules when clicked (chooseWidgetOption) and at the send (batchMatch).
function derivation(f: FormField, kind: BatchKind, a: BatchAnswer, tf: TrustedFact, combinedOk = false): string | null {
  const n = (x: string) => String(x ?? "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").toLowerCase();
  const yn = /^(yes|no)$/.exec(n(tf.value))?.[1] ?? null;
  if (kind === "file") return tf.factId.startsWith("approved-local-resume:") && a.file === tf.value ? "attachment" : null;
  if (kind === "checkbox") return yn && (yn === "yes") === YES.test(a.value) ? "checkbox-yes-no" : null;
  if (kind === "select" || kind === "choice") {
    if (n(a.shown) === n(tf.value) || a.value === tf.value) return "option-exact";
    return yn && new RegExp(`^${yn}\\b`).test(n(a.shown)) ? "option-yes-no" : null;
  }
  if (kind === "listed" && f.options.length) return !optionText(f, a.value) ? null : a.value === tf.value ? "option-exact" : optionRule(a.shown, tf.value, false, tf.key, combinedOk);
  if (kind === "listed") return n(a.value) === n(tf.value) ? (SEARCHED.has(tf.key.replace(/^fact:/, "")) ? "listed-name" : "widget-option") : null;
  return n(a.value) === n(tf.value) ? "verbatim" : null;
}
// What the batch approval is bound to: the same canonical SHA-256 as the one-tap approval (hashApplyPayload).
export const batchHash = (p: BatchPosting) => hashApplyPayload({ version: 1, kind: "agent-batch", ...p });

// At the send: code approves the card itself only when the page holds exactly what the person approved for this posting.
// The planner, run again on the live form, must give the same entry; every answer on the card must be Trainee's own, with
// the approved fact, value and label (a select by its option value, a file by its bytes' hash); nothing more, nothing
// missing, nothing open, no blocker. Anything else stops this posting for the person, with what differs.
const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
export function batchMatch(o: { approved: BatchPosting; now: BatchPlan; card: SnapField[]; openRequired: string[]; blockers: string[] }): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  if (!o.now.ok) diffs.push(...o.now.why);
  else {
    // WO-102: the approval binds the facts behind the answers, the quarantine rules and the questions asked.
    if (o.now.posting.manifest_hash !== o.approved.manifest_hash) diffs.push("The facts behind your answers changed since you approved (a fact was added, changed or withdrawn).");
    if (o.now.posting.quarantine_version !== o.approved.quarantine_version) diffs.push("The quarantine rules changed since you approved.");
    if (o.now.posting.question_set_hash !== o.approved.question_set_hash) diffs.push("The form's questions changed since you approved.");
    if (canonicalJson(o.now.posting.ledger ?? []) !== canonicalJson(o.approved.ledger ?? [])) diffs.push("The sources behind your answers changed since you approved.");
    const at = new Map(o.now.posting.answers.map((a) => [a.name, a]));
    for (const a of o.approved.answers) {
      const n = at.get(a.name);
      if (!n) diffs.push(`"${a.label}": Trainee would no longer answer it.`);
      else if (n.value !== a.value || n.shown !== a.shown || n.label !== a.label || n.factId !== a.factId || n.file !== a.file) {
        diffs.push(`"${a.label}": Trainee would now answer "${n.shown}", not the approved "${a.shown}".`);
      }
    }
    for (const n of o.now.posting.answers) if (!o.approved.answers.some((a) => a.name === n.name)) diffs.push(`"${n.label}": a new answer not approved.`);
    const labels = (p: BatchPosting) => new Set([...p.blank, ...p.answers.map((a) => a.label)]);
    const was = labels(o.approved), is = labels(o.now.posting);
    const added = [...is].filter((l) => !was.has(l)), gone = [...was].filter((l) => !is.has(l));
    if (added.length || gone.length) {
      diffs.push(`The form's fields changed since the batch was approved: ${[...added.map((l) => `"${l}" is new`), ...gone.map((l) => `"${l}" is gone`)].join("; ")}.`);
    }
  }
  const want = new Map(o.approved.answers.map((a) => [a.name, a]));
  for (const c of o.card) {
    const a = want.get(c.name);
    if (c.source !== "trainee") {
      diffs.push(`"${c.label}" was ${c.source === "page" || c.source === "fixed" ? "set by the page" : "typed on the page"}, not approved in the batch.`);
      continue;
    }
    if (!a) {
      diffs.push(`"${c.label}" is on the form but not in the approved answers.`);
      continue;
    }
    const detailOk = a.kind === "file" ? String(c.detail ?? "").startsWith(`${a.file}:`) && !String(c.detail).includes(",")
      : a.kind === "select" ? c.detail === `value=${a.value}` : true;
    // A listed field's page text is the employer's own entry Trainee picked for the approved answer (the planner's answer
    // itself is checked above against the approval); any other field's must be the approved text.
    // WO-102 (FRS): the option the widget holds must derive from the approved answer by the rule approved with it: a place
    // or school search's entry names it (its first word); any other widget's option is it, or its yes or no.
    const rule = o.approved.ledger?.find((l) => l.field_id === a.name)?.derivation_rule;
    const searched = rule ? rule === "listed-name" : SEARCHED.has(classifyField(a.label, "input_text")) || /^(school|college|university)\b/i.test(a.label);
    const dial = (x: string) => String(x ?? "").replace(/\s\+\d{1,4}$/, "");
    const valueOk = a.kind === "listed" ? norm(c.value) !== "" && !!optionRule(dial(c.value), dial(a.shown), searched) : norm(c.value) === norm(a.shown);
    if (c.label !== a.label || c.factId !== a.factId || !valueOk || !detailOk) {
      diffs.push(`"${a.label}": the page holds "${c.value}", not the approved "${a.shown}".`);
    }
  }
  for (const a of o.approved.answers) if (!o.card.some((c) => c.name === a.name)) diffs.push(`"${a.label}" was not filled.`);
  for (const l of o.openRequired) diffs.push(`"${l}" is required and not answered yet.`);
  diffs.push(...o.blockers);
  return { ok: diffs.length === 0, diffs };
}

// The receipt after each agent submission (WO-101, A8): one line the person reads, from the recorded outcome. A page's
// confirmation counts only with its picture after the click (as on the card); the employer's email makes it final.
// `proof` false: stopped before anything was recorded, so no proof was kept and none is claimed.
export function agentReceiptLine(o: { company: string; url: string; state: string; confirmation_id: string | null; reason?: string; proved: boolean; proof?: boolean }): string {
  const c = o.company || "the employer";
  const why = (o.reason || "").replace(/[.\s]+$/, "");
  const says = o.state === "confirmed" && o.proved
    ? `Sent to ${c}: the employer confirmed it on the page${o.confirmation_id ? ` (${o.confirmation_id})` : ""}. Their email makes it final.`
    : o.state === "confirmed" || o.state === "submitted_unconfirmed" || o.state === "unknown_outcome"
    ? `Sent to ${c}; their answer could not be captured. Watch your email for their confirmation.`
    : o.state === "needs_user" ? `Sent to ${c}, and the page now asks you for something (a check or a code). Finish it yourself there.`
    : o.state === "not_submitted" ? `Not sent to ${c}: ${why || BEFORE_CLICK}. Nothing was sent.`
    : `Sent to ${c}, but it was not confirmed: ${why || "the page did not say"}.`;
  return `${says}${o.proof === false ? "" : " The proof (answers, pictures, times) is on this computer."} ${o.url}`;
}

// D-007: the 47 agent-invented "confirmed" facts (F-027..F-079, entered from the owner's answer-all delegation of
// 2026-10-17) never reach a real application. They are not deleted (the owner's bank is his); every import leaves them
// out, by id and by that provenance, and counts them so the panel can say so.
export function quarantinedFact(value: unknown): boolean {
  return sharedQuarantinedFact(value);
}
