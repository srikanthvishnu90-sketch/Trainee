// Task a-sensitive (2026-11-10): sensitive and identity questions on real employer forms, through the planner
// (career_apply.ts planBatch), the ask-once store (ask-once.ts questionsToStore, apply_core.ts formAnswersToKeep), the text
// ask (career_apply_questions.ts questionsText) and the browser filler (ats-fill.cjs decide / matchOption). One number: how
// many of the real variants in tests/fixtures/apply/sensitive-questions.json meet every bar below.
//   guess    with the fact removed from the person's facts, nothing is filled; a required question is asked
//   reuse    an answer to a self-identification question (gender, race or ethnicity, sexual orientation, disability,
//            veteran status) or a date of birth is kept for that application only: the next employer's same question is
//            not filled from it, and an answer the person typed on the form is not kept to travel
//   name     such a question is asked by text with the employer's name ("For <company>.")
//   decline  where the form offers a way not to answer, the person's "Prefer not to say" lands on that option (planner and
//            browser filler), and never on any other option
//   scope    work rights: a question that names another country, or the job's country at a posting outside the US, is
//            asked; one that names the US, or where the person lives (HOME_PLACE), is the person's own
// Date of birth (interim ruling, 2026-11-10): asked only when the form marks it required, per application, never stored for
// reuse. No real capture holds one, so the date-of-birth cases are written here and counted apart from the real number.
// Run: deno run -A --no-check evals/apply/sensitive-loop.ts [--json]
import { createRequire } from "node:module";
import { planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { FOREIGN, mapQuestion, NAMES_US, RELATIVE_PLACE } from "../../supabase/functions/_shared/question_map.ts";
import { questionsText, type OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { formAnswersToKeep } from "../../extension/src/apply_core.ts";
import { postingCountry, postingPlaces } from "../../supabase/functions/_shared/posting_place.ts";
import { PERSONA } from "./fill-coverage.ts";
import FIXTURE from "../../tests/fixtures/apply/sensitive-questions.json" with { type: "json" };

const require = createRequire(import.meta.url);
const ATS = require("../../workers/career-browser/ats-fill.cjs");

export interface Q { id: string; category: string; source: string; company: string | null; location: string | null; label: string; kind: string; type: string; required: boolean; eeo: boolean; options: string[]; synthetic?: boolean }
const SELF_ID = new Set(["gender", "race_ethnicity", "orientation", "disability", "veteran"]);
const PER_APPLICATION = new Set([...SELF_ID, "date_of_birth"]);
const FACTS_OF: Record<string, string[]> = {
  work_authorization: ["work_authorization", "citizenship", "us_person", "sponsorship"], sponsorship: ["sponsorship", "work_authorization", "citizenship", "us_person"],
  gpa: ["gpa"], graduation_date: ["graduation_date", "education_level"], pronouns: ["pronouns"], date_of_birth: [],
  gender: ["eeo"], race_ethnicity: ["eeo"], orientation: ["eeo"], disability: ["eeo"], veteran: ["eeo"],
};
const DECLINE_OPT = ATS.DECLINE as RegExp;
const isDecline = (s: string) => DECLINE_OPT.test(ATS.norm(s));
const without = (keys: string[]) => Object.fromEntries(Object.entries(PERSONA).filter(([k]) => !keys.includes(k)));
const NOW = Date.UTC(2026, 10, 10);

export const DOB: Q[] = [
  ["Date of Birth", "input_text", true], ["Date of birth (MM/DD/YYYY)", "input_text", false], ["What is your date of birth?", "input_text", true],
  ["Birthdate", "input_text", true], ["DOB", "input_text", false],
].map(([label, type, required], i) => ({ id: `D${i + 1}`, category: "date_of_birth", source: "written for the interim ruling (no real capture)", company: "Example Co", location: "Chicago, IL",
  label: String(label), kind: "text", type: String(type), required: !!required, eeo: false, options: [], synthetic: true }));

function field(q: Q, required = q.required) {
  return { name: "q", label: q.label, required, type: q.type, options: q.options.map((x) => ({ label: x, value: x })) };
}
function plan(q: Q, jobId: string, company: string, answers: Record<string, any>, saved: Record<string, any>, required = q.required) {
  const p = planBatch({ userId: "TEST", postings: [{ job_id: jobId, company, title: "", location: q.location ?? undefined, fields: [field(q, required)] }], answers, saved, log: [], now: NOW });
  const value = p.ready[0]?.fields[0]?.value ?? null;
  const shown = value === null ? null : q.options.length ? (q.options.find((o) => o === value) ?? value) : value;
  return { filled: value !== null, value: shown, asked: p.needs.some((n: any) => n.label === q.label) };
}
const storeRow = (q: Q, jobId: string, company: string, facts: Record<string, any>) =>
  questionsToStore({ posting: jobId, company, location: q.location ?? undefined, questions: [{ label: q.label, type: q.type, options: q.options }] }, { facts, answered: new Set() }).questions[0] as any;

// Where a work-rights question's answer belongs, read from the label and the posting location (the bar, written apart
// from the code it checks): another country named -> asked; the US named -> the person's; the job's country -> the
// person's only at a US posting; a bare question at a posting abroad -> asked.
const HOME = /\bcountry (where |in which )?you (currently )?(reside|live)|\bcountry of residence\b|\byour current (location|country|work authori[sz]ation)\b/i;
function scopeWant(q: Q): "own" | "ask" {
  const place = postingCountry(postingPlaces(q.location ?? ""));
  if (FOREIGN.test(q.label) && !NAMES_US.test(q.label)) return "ask";
  if (NAMES_US.test(q.label)) return "own";
  if (HOME.test(q.label)) return "own";
  if (RELATIVE_PLACE.test(q.label) || /\bthis country\b|where (this|the) (job|role) is located/i.test(q.label)) return place === "us" ? "own" : "ask";
  return place === "abroad" ? "ask" : "own";
}

export function check(q: Q) {
  const fails: string[] = [];
  const facts = without(FACTS_OF[q.category] ?? []);
  const A = `A-${q.id}`, B = `B-${q.id}`, company = q.company ?? "Example Co";
  // guess: the fact removed, nothing is filled; a required question is asked.
  const g = plan(q, A, company, facts, {});
  if (g.filled) fails.push(`guess: filled "${g.value}" with the fact removed`);
  if (q.required && !g.asked) fails.push("guess: required but not asked");
  // ats-fill: no facts and no answers, never filled; required asked, optional left blank.
  const d = ATS.decide({ label: q.label, kind: q.kind, required: q.required, eeo: q.eeo, options: q.options.map((label, i) => ({ i, label })) }, { facts: {}, answers: {} });
  if (d.status === "fill") fails.push(`ats-fill: filled with no facts (${d.source})`);
  if (q.required && d.status !== "ask") fails.push("ats-fill: required but not asked");
  if (PER_APPLICATION.has(q.category)) {
    const row = storeRow(q, A, company, facts);
    if (!String(row?.key ?? "").startsWith("job:")) fails.push(`reuse: stored under ${row?.key}, not this application's key`);
    const answer = q.options.find((o) => !isDecline(o)) ?? "01/01/1990";
    const b = plan(q, B, "Other Employer", facts, { [row?.key]: { value: answer, factId: "text-answer:A" } }, true);
    if (b.filled) fails.push(`reuse: the next employer's question took "${b.value}" from application A`);
    const kept = formAnswersToKeep({ jobId: A, company, location: q.location ?? undefined, needs: [{ label: q.label, type: q.type, options: q.options }],
      fields: [{ name: "q", label: q.label, value: answer, source: "you" }], answers: facts, answered: new Set() });
    if (kept.answers.length) fails.push(`reuse: the form answer is kept to travel (${kept.answers[0].key})`);
    const open: OpenQuestion = { id: "1", key: row?.key, kind: row?.kind, label: q.label, type: q.type, options: q.options, company: row?.company ?? null, job_ids: [A], misfit: false, answer: null };
    const text = questionsText([open], 1)?.text ?? "";
    if (!text.includes(`For ${company}.`)) fails.push("name: asked without the employer's name");
  }
  const declineOpt = q.options.find(isDecline);
  if (declineOpt) {
    const key = storeRow(q, A, company, facts)?.key;
    const p = plan(q, A, company, facts, { [key]: { value: "Prefer not to say", factId: "text-answer:A" } });
    if (p.filled && !isDecline(String(p.value))) fails.push(`decline: "Prefer not to say" became "${p.value}"`);
    if (!p.filled) fails.push(`decline: "Prefer not to say" not placed on "${declineOpt}" (planner)`);
    const m = ATS.matchOption(q.options, "Prefer not to say");
    if (m.index === undefined || !isDecline(q.options[m.index])) fails.push(`decline: "Prefer not to say" not placed on "${declineOpt}" (ats-fill: ${m.error ?? q.options[m.index]})`);
  }
  if (q.category === "work_authorization" || q.category === "sponsorship") {
    const want = scopeWant(q);
    const f = plan(q, A, company, PERSONA, {}, true);
    if (want === "ask" && f.filled) fails.push(`scope: work rights outside the person's country filled "${f.value}"`);
    if (want === "own" && f.filled) {
      const yes = /^yes\b/i.test(String(f.value)), no = /^no\b/i.test(String(f.value));
      const sponsor = /sponsor|\bvisa\b/i.test(q.label.split("?")[0]);
      if ((sponsor && yes) || (!sponsor && no)) fails.push(`scope: filled "${f.value}", against the person's facts`);
      // A yes/no question typed in a box takes a yes or a no, never a country ("Are you a Dual citizen?" -> "United States").
      if (!q.options.length && /^(are|do|does|have|has|will|would|can|is)\b/i.test(q.label.trim()) && !yes && !no) fails.push(`shape: a yes/no question took "${f.value}"`);
    }
    const row = storeRow(q, A, company, facts);
    if (want === "ask" && String(row?.key ?? "").startsWith("fact:")) fails.push(`scope: an answer abroad would become the person's fact (${row.key})`);
  }
  if (q.category === "date_of_birth") {
    // Interim ruling: a date of birth is never read from a stored fact either.
    const withDob = { ...PERSONA, date_of_birth: { value: "01/01/1990", factId: "TEST-dob" } } as any;
    if (plan(q, A, company, withDob, {}).filled) fails.push("dob: filled from a stored fact");
    if (!q.required && g.asked) fails.push("dob: optional but asked");
  }
  return fails;
}

if (import.meta.main) {
  const real = (FIXTURE as any).questions as Q[];
  const out = (qs: Q[]) => qs.map((q) => ({ q, fails: check(q) }));
  const r = out(real), s = out(DOB);
  const byCat: Record<string, [number, number]> = {};
  for (const { q, fails } of r) { const c = (byCat[q.category] ??= [0, 0]); c[1]++; if (!fails.length) c[0]++; }
  if (Deno.args.includes("--json")) console.log(JSON.stringify({ real: r.map((x) => ({ id: x.q.id, fails: x.fails })), dob: s.map((x) => ({ id: x.q.id, fails: x.fails })) }, null, 1));
  else for (const { q, fails } of [...r, ...s]) if (fails.length) console.log(`${q.id} [${q.category}] ${q.company} @ ${q.location ?? "-"}: ${q.label.slice(0, 90)}\n   ${fails.join("\n   ")}`);
  console.log("by category:", Object.entries(byCat).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", "));
  console.log(`SENSITIVE real ${r.filter((x) => !x.fails.length).length}/${r.length}  date-of-birth (written) ${s.filter((x) => !x.fails.length).length}/${s.length}`);
}
