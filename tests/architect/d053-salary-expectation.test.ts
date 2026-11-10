// D-053 (owner, 2026-11-10, PR #742): salary expectation is asked per application. A salary-expectation answer is keyed
// to the posting it was given for, like a date of birth and a salary history (#731): it is never filled into another
// employer's form from an earlier answer (an answer texted for another posting, an answer saved under the question's
// wording, or one kept as the fact `salary_expectation` by the answer library before D-053); each application asks again.
// Read here as written: the ruling is about ANSWERS given for a posting. A salary expectation the person stated as their
// own confirmed fact (given for no posting) is not such an answer and fills as before (D-053/4 pins both sides). The earlier answer may only ever be shown
// as a suggestion the person confirms, labelled with its source (WO-122); nothing here fills one.
// What does not change: salary history and date of birth stay per posting (#731); the current salary, the currency, the
// years of experience, the GPA and the graduation date keep the keys they had.
// Run: deno test -A --no-check tests/architect/d053-salary-expectation.test.ts
import assertNode from "node:assert/strict";
import { answerKey, BIRTH_DATE, PAY_HISTORY_ASKED, SALARY_EXPECTATION_ASKED, salaryExpectationAsked } from "../../supabase/functions/_shared/question_map.ts";
import { normLabel, planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";

const T0 = Date.UTC(2026, 10, 10, 15);
const q = (label: string, type = "input_text") => ({ label, type, options: [] as { label: string }[] });
const k = (label: string, job: string) => answerKey(q(label) as any, job);

// The wordings real forms use for what the person expects to be paid, in the languages question_map reads.
const EXPECTATION = [
  "What are your salary expectations?", "Salary expectations", "Salary expectation", "Desired salary", "Expected salary",
  "Expected salary (USD)", "Compensation expectations", "What is your expected compensation?", "Desired compensation",
  "Salary requirements", "Expected CTC", "Expected pay", "Desired pay", "Desired hourly rate", "What is your expected hourly pay?",
  "What is your desired monthly salary?", "Expected salary range", "Salary expectation range", "Minimum salary",
  "What salary are you looking for?", "What compensation would you expect for this role?", "Ideal annual compensation",
  "Expected total annual compensation", "Salary expectations (including currency)",
  "Prétentions salariales", "Quelles sont vos attentes salariales ?", "Rémunération souhaitée", "Salaire souhaité",
  "Pretensiones salariales", "Expectativa salarial", "Salario deseado", "Aspiración salarial",
  "Salarisverwachting", "Gewenst salaris", "Gehaltsvorstellung", "Gehaltswunsch", "Wunschgehalt", "希望年収",
];
// Pay questions that are not the expectation, and other numeric questions: their keys do not move.
const NOT_EXPECTATION: [string, string][] = [
  ["Current salary", "fact:current_compensation"],
  ["Current CTC", "fact:current_compensation"],
  ["What currency should we use for your compensation?", "fact:salary_currency"],
  ["Expected graduation date", "fact:graduation_date"],
];
const OTHER_NUMERIC = ["Years of experience", "How many years of relevant experience do you have?", "What is your GPA?", "Notice period", "Expected graduation date", "Current salary", "Phone number"];

Deno.test("D-053/1 a salary-expectation question is keyed to the posting, in every wording and language question_map reads", () => {
  for (const l of EXPECTATION) {
    assertNode.ok(salaryExpectationAsked(q(l)), `asked per application: ${l}`);
    const a = k(l, "greenhouse:acme:1"), b = k(l, "greenhouse:beta:2");
    assertNode.match(a, /^job:[0-9a-f]{16}$/, l);
    assertNode.notEqual(a, b, `one employer's key is not another's: ${l}`);
    // Whatever the planner is told about the person's facts or the posting's place, still this posting's.
    assertNode.equal(answerKey(q(l) as any, "greenhouse:acme:1", { haveFact: true }), a, l);
    assertNode.equal(answerKey(q(l) as any, "greenhouse:acme:1", { here: true }), a, l);
  }
});

Deno.test("D-053/2 salary history and date of birth are unchanged (#731); other pay and numeric questions keep their keys", () => {
  for (const l of ["What was your salary at your previous job?", "Salary history", "Previous salary", "Date of birth", "Date de naissance", "Fecha de nacimiento"]) {
    const a = k(l, "greenhouse:acme:1");
    assertNode.match(a, /^job:/, l);
    assertNode.notEqual(a, k(l, "greenhouse:beta:2"), l);
  }
  // Salary history is its own rule, never caught twice as an expectation.
  for (const l of ["What was your salary at your previous job?", "Salary history", "Previous salary", "What was your compensation at your last employer?"]) {
    assertNode.ok(PAY_HISTORY_ASKED.test(l), l);
    assertNode.equal(salaryExpectationAsked(q(l)), false, `history is not the expectation: ${l}`);
  }
  assertNode.ok(BIRTH_DATE.test("Date of birth"));
  assertNode.equal(salaryExpectationAsked(q("Date of birth")), false);
  for (const [l, key] of NOT_EXPECTATION) {
    assertNode.equal(salaryExpectationAsked(q(l)), false, l);
    assertNode.equal(k(l, "greenhouse:acme:1"), key, l);
  }
  for (const l of OTHER_NUMERIC) {
    assertNode.equal(salaryExpectationAsked(q(l)), false, l);
    assertNode.equal(SALARY_EXPECTATION_ASKED.test(l), false, l);
    // a key that is not a posting's stays the same for every employer
    const a = k(l, "greenhouse:acme:1");
    if (!a.startsWith("job:")) assertNode.equal(a, k(l, "greenhouse:beta:2"), l);
  }
});

// The same form at two employers: name, email and the salary expectation.
const form = (label = "What are your salary expectations?") => [
  { name: "first_name", label: "First Name", type: "input_text", required: true, options: [] },
  { name: "email", label: "Email", type: "input_text", required: true, options: [] },
  { name: "salary", label, type: "input_text", required: true, options: [] },
];
const facts = { first_name: { value: "Ana", factId: "F-001" }, email: { value: "ana@example.test", factId: "F-002" } };
const posting = (job_id: string, company: string, label?: string) => ({ job_id, company, title: "Data Analyst", fields: form(label) });

Deno.test("D-053/3 a second employer asks the salary expectation again: the first employer's answer is never filled", () => {
  for (const label of ["What are your salary expectations?", "Desired salary", "Salary", "Prétentions salariales", "Expected pay"]) {
    const firstKey = answerKey(q(label) as any, "gh:acme:1");
    const saved = { [firstKey]: { value: "$95,000", factId: "text-answer:acme-salary" } };
    // At the employer it was given for, it is that application's answer.
    const atAcme = planBatch({ userId: "u1", postings: [posting("gh:acme:1", "Acme", label)], answers: facts, saved, log: [], now: T0 });
    assertNode.equal(atAcme.ready.length, 1, label);
    const filled = atAcme.ready[0].fields.find((f: any) => f.name === "salary")!;
    assertNode.deepStrictEqual([filled.value, filled.factId], ["$95,000", "text-answer:acme-salary"], label);
    // At the next employer it is asked; the earlier answer is nowhere on the plan.
    const atBeta = planBatch({ userId: "u1", postings: [posting("gh:beta:2", "Beta", label)], answers: facts, saved, log: [], now: T0 });
    assertNode.equal(atBeta.ready.length, 0, label);
    assertNode.deepStrictEqual(atBeta.needs.map((n: any) => [n.label, n.job_ids]), [[label, ["gh:beta:2"]]], label);
    assertNode.ok(!JSON.stringify(atBeta).includes("95,000"), `the first answer is never on the second plan: ${label}`);
  }
});

Deno.test("D-053/4 no other earlier answer fills it either: not a wording-keyed answer, not a salary expectation kept as a fact", () => {
  const label = "What are your salary expectations?";
  const sources: Record<string, { answers?: any; saved?: any }> = {
    "an answer saved under the question's wording (legacy key)": { saved: { [normLabel(label)]: { value: "$85,000", factId: "F-030" } } },
    "an answer saved under the old shared key": { saved: { ["label:" + "0".repeat(16)]: { value: "$85,000", factId: "F-031" } } },
    "an earlier employer's answer kept as the fact (an old fact:salary_expectation library row)": { answers: { salary_expectation: { value: "$85,000", factId: "text-answer:old" } } },
  };
  for (const [why, s] of Object.entries(sources)) {
    const r = planBatch({ userId: "u1", postings: [posting("gh:beta:2", "Beta")], answers: { ...facts, ...(s.answers ?? {}) }, saved: s.saved ?? {}, log: [], now: T0 });
    assertNode.equal(r.ready.length, 0, why);
    assertNode.deepStrictEqual(r.needs.map((n: any) => n.label), [label], why);
  }
  // A salary expectation the person stated as their own confirmed fact (not an answer to any employer's question) is
  // unchanged by D-053: it fills, citing that fact.
  const stated = planBatch({ userId: "u1", postings: [posting("gh:beta:2", "Beta")], answers: { ...facts, salary_expectation: { value: "$85,000", factId: "F-030" } }, saved: {}, log: [], now: T0 });
  assertNode.equal(stated.ready.length, 1);
  assertNode.deepStrictEqual(stated.ready[0].fields.find((f: any) => f.name === "salary")!.factId, "F-030");
  // Through the trust contract too: a library row stored under the old fact key (before D-053) reaches the planner as a
  // fact; it is still not used for the salary expectation, while the shared facts beside it still are.
  const m = trustedManifest({ owner: "u1", file: { user_id: "u1", answers: {} }, resume: null, rows: [
    { id: "r1", key: "fact:first_name", answer: "Ana" }, { id: "r2", key: "fact:email", answer: "ana@example.test" },
    { id: "r3", key: "fact:salary_expectation", answer: "$85,000" },
  ] });
  const r = planBatch({ userId: "u1", postings: [posting("gh:beta:2", "Beta")], answers: m.answers, saved: m.saved, log: [], now: T0 });
  assertNode.equal(r.ready.length, 0);
  assertNode.deepStrictEqual(r.needs.map((n: any) => n.label), [label]);
});

Deno.test("D-053/5 three employers in turn, each answered when asked: per-employer answers carried to another employer = 0", () => {
  // The planner-level shape of the item 9 battery (tests/architect/loop-09-memory-apply.test.ts): one person, three
  // employers, each asked the same per-application questions; each answer saved under the key the planner reads it by.
  const per = [
    { name: "salary", label: "What are your salary expectations?" },
    { name: "paid", label: "What was your salary at your previous job?" },
    { name: "dob", label: "Date of birth" },
  ];
  const fields = [...form().slice(0, 2), ...per.map((p) => ({ ...p, type: "input_text", required: true, options: [] }))];
  const jobs = ["gh:acme:1", "gh:beta:2", "gh:gamma:3"];
  const given: Record<string, Record<string, string>> = {
    "gh:acme:1": { salary: "$95,000", paid: "$22 an hour", dob: "2004-03-02" },
    "gh:beta:2": { salary: "$100,000", paid: "$24 an hour", dob: "2004-03-02" },
    "gh:gamma:3": { salary: "$90,000", paid: "$25 an hour", dob: "2004-03-02" },
  };
  const saved: Record<string, { value: string; factId: string }> = {};
  let wrong = 0, asked = 0;
  for (const job of jobs) {
    const before = planBatch({ userId: "u1", postings: [{ job_id: job, company: job, title: "Analyst", fields }], answers: facts, saved, log: [], now: T0 });
    // Everything per-application is asked at this employer before it is answered; nothing comes from an earlier one.
    const needs = new Set(before.needs.map((n: any) => n.label));
    for (const p of per) if (needs.has(p.label)) asked++; else wrong++;
    for (const p of per) saved[answerKey(q(p.label) as any, job)] = { value: given[job][p.name], factId: `text-answer:${job}:${p.name}` };
    const after = planBatch({ userId: "u1", postings: [{ job_id: job, company: job, title: "Analyst", fields }], answers: facts, saved, log: [], now: T0 });
    assertNode.equal(after.ready.length, 1, job);
    for (const p of per) {
      const f = after.ready[0].fields.find((x: any) => x.name === p.name)!;
      if (f.value !== given[job][p.name] || f.factId !== `text-answer:${job}:${p.name}`) wrong++;
    }
  }
  assertNode.equal(asked, per.length * jobs.length, "every per-application question asked at every employer");
  assertNode.equal(wrong, 0, "per-employer answers carried to another employer");
});
