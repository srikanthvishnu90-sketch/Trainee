// D-053c (architect ruling under the owner's D-053, 2026-11-10: "never filled into another employer's form from an earlier
// answer; each application asks again"). The yes/no question "does the posted range meet your expectations?" (fact_schema
// `pay_range_ok`) is a salary-expectation question in another shape: it is asked per application. It is never answered from
// the salary-expectation fact (whatever its source), never from a `pay_range_ok` fact, never from an answer saved under its
// wording, never from an answer given for another posting. The answer given for this posting fills it. A salary amount on
// file is never offered beside it (an amount is no answer to a yes/no), and an earlier yes or no to it is never offered as
// a salary on file (D-053b's suggestion reads only salary-expectation questions).
// Run: deno test -A --no-check tests/architect/d053c-pay-range.test.ts
import assertNode from "node:assert/strict";
import { answerKey, payRangeAsked, salaryExpectationAsked } from "../../supabase/functions/_shared/question_map.ts";
import { normLabel, planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { type OpenQuestion, type QuestionStore, QUESTIONS_INTENT, questionsTurn } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";

const T0 = Date.UTC(2026, 10, 10, 15);
const YN = [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }];
const q = (label: string, type = "multi_value_single_select", options = YN) => ({ label, type, options });

// The wordings real forms use to ask whether the posting's own range or rate is acceptable (evals/apply/questions-ci-b.json,
// questions-ci-d.json, and the shapes the question map already read as pay_range_ok).
const RANGE_OK = [
  "Does the posted range meet your expectations?",
  "Do your compensation expectations align with the posted range?",
  "Do your compensation expectations align with the posted range? (Base compensation)",
  "Are your salary expectations aligned with the posted range for this role?",
  "The salary range for this role is $120,000 - $140,000. Does this align with your expectations?",
  "This position pays a rate of $45/hour. Do you accept this rate?",
  "Is the compensation range for this role acceptable to you?",
  "Does the pay range align with my expectations?",
  "Is the posted salary range within your expectations?",
  "Does the salary band for this position meet your requirements?",
];
// Questions that ask the amount itself (D-053's own rule) or something else: not this one.
const NOT_RANGE_OK = [
  "What are your salary expectations?", "Expected salary range", "Salary expectation range", "Desired salary",
  "What is your expected compensation?", "Current salary", "What was your salary at your previous job?",
  "Are you willing to relocate?", "Do you require visa sponsorship?",
];

Deno.test("D-053c/1 the posted-range question is keyed to the posting in every wording; it is not read as the amount", () => {
  for (const l of RANGE_OK) {
    assertNode.ok(payRangeAsked(q(l)), `asked per application: ${l}`);
    assertNode.ok(payRangeAsked(q(l, "input_text", [])), `in a text box too: ${l}`);
    assertNode.equal(salaryExpectationAsked(q(l)), false, `a yes/no about the range is not the amount: ${l}`);
    const a = answerKey(q(l) as any, "gh:acme:1"), b = answerKey(q(l) as any, "gh:beta:2");
    assertNode.match(a, /^job:[0-9a-f]{16}$/, l);
    assertNode.notEqual(a, b, `one employer's key is not another's: ${l}`);
    assertNode.equal(answerKey(q(l) as any, "gh:acme:1", { haveFact: true }), a, l);
    assertNode.equal(answerKey(q(l) as any, "gh:acme:1", { here: true }), a, l);
  }
  for (const l of NOT_RANGE_OK) assertNode.equal(payRangeAsked(q(l, "input_text", [])), false, l);
});

const form = (label: string) => [
  { name: "first_name", label: "First Name", type: "input_text", required: true, options: [] },
  { name: "range", label, type: "multi_value_single_select", required: true, options: YN },
];
const facts = { first_name: { value: "Ana", factId: "F-001" } };
const plan = (label: string, job: string, o: { answers?: any; saved?: any } = {}) =>
  planBatch({ userId: "u1", postings: [{ job_id: job, company: job, title: "Analyst", fields: form(label) }], answers: { ...facts, ...(o.answers ?? {}) }, saved: o.saved ?? {}, log: [], now: T0 });

Deno.test("D-053c/2 no fact and no earlier answer fills it: the salary expectation, a pay_range_ok fact, the wording, another posting", () => {
  for (const label of RANGE_OK) {
    const sources: Record<string, { answers?: any; saved?: any }> = {
      "a confirmed salary-expectation fact": { answers: { salary_expectation: { value: "$95,000", factId: "F-030" } } },
      "a salary expectation texted to an earlier form": { answers: { salary_expectation: { value: "$95,000", factId: "text-answer:old" } } },
      "a pay_range_ok fact (yes)": { answers: { pay_range_ok: { value: "Yes", factId: "F-031" } } },
      "a pay_range_ok library row (no)": { answers: { pay_range_ok: { value: "No", factId: "text-answer:old-range" } } },
      "an answer saved under the question's wording (legacy key)": { saved: { [normLabel(label)]: { value: "Yes", factId: "F-032" } } },
      "an answer given for another posting": { saved: { [answerKey(q(label) as any, "gh:acme:1")]: { value: "Yes", factId: "text-answer:acme" } } },
    };
    for (const [why, s] of Object.entries(sources)) {
      const r = plan(label, "gh:beta:2", s);
      assertNode.equal(r.ready.length, 0, `${why}: ${label}`);
      assertNode.deepStrictEqual(r.needs.map((n: any) => [n.label, n.job_ids]), [[label, ["gh:beta:2"]]], `${why}: ${label}`);
    }
  }
  // Through the trust contract: library rows under the old fact keys reach the planner as facts and still do not fill it.
  const label = RANGE_OK[1];
  const m = trustedManifest({ owner: "u1", file: { user_id: "u1", answers: {} }, resume: null, rows: [
    { id: "r1", key: "fact:first_name", answer: "Ana" }, { id: "r2", key: "fact:salary_expectation", answer: "$85,000" },
    { id: "r3", key: "fact:pay_range_ok", answer: "Yes" },
  ] });
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:beta:2", company: "Beta", title: "", fields: form(label) }], answers: m.answers, saved: m.saved, log: [], now: T0 });
  assertNode.equal(r.ready.length, 0);
  assertNode.deepStrictEqual(r.needs.map((n: any) => n.label), [label]);
});

Deno.test("D-053c/3 the answer given for this posting fills it; three employers in turn carry nothing across", () => {
  const label = RANGE_OK[0];
  const saved: Record<string, { value: string; factId: string }> = {};
  const given: Record<string, string> = { "gh:acme:1": "Yes", "gh:beta:2": "No", "gh:gamma:3": "Yes" };
  let asked = 0, wrong = 0;
  for (const job of Object.keys(given)) {
    const before = plan(label, job, { saved, answers: { salary_expectation: { value: "$95,000", factId: "F-030" } } });
    if (before.ready.length === 0 && before.needs.some((n: any) => n.label === label)) asked++; else wrong++;
    saved[answerKey(q(label) as any, job)] = { value: given[job], factId: `text-answer:${job}` };
    const after = plan(label, job, { saved });
    assertNode.equal(after.ready.length, 1, job);
    const f = after.ready[0].fields.find((x: any) => x.name === "range")!;
    if (f.value !== given[job] || f.factId !== `text-answer:${job}`) wrong++;
  }
  assertNode.equal(asked, 3, "asked at every employer");
  assertNode.equal(wrong, 0, "answers carried to another employer");
});

// ------------------------------------------------------------------------------------------------ no suggestion
type Earlier = { value: string; factId: string; at?: string; job_ids: string[] };
function fakeStore(rows: OpenQuestion[], earlier: Earlier[]) {
  const kv: { shown?: any } = {};
  const answers: [string, string][] = [];
  let last: string | null = null;
  const store: QuestionStore & { answers: typeof answers; setIntent(i: string | null): void } = {
    answers,
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = rows.find((x) => x.id === id)!; r.answer = a; r.misfit = false; answers.push([id, a]); },
    async shown() { return kv.shown ? JSON.parse(JSON.stringify(kv.shown)) : null; },
    async setShown(_u, s) { kv.shown = JSON.parse(JSON.stringify(s)); },
    async lastAssistantIntent() { return last; },
    async earlierSalary() { return { answers: earlier }; },
  };
  return store;
}

Deno.test("D-053c/4 a salary amount on file is never offered beside the posted-range question", async () => {
  for (const [label, type, options] of [[RANGE_OK[0], "input_text", []], [RANGE_OK[1], "multi_value_single_select", YN]] as const) {
    const row: OpenQuestion = { id: "q-range", key: answerKey(q(label, type, options as any) as any, "gh:beta:2"), kind: "screen", label, type,
      options: options.map((o) => o.label), company: "Beta", job_ids: ["gh:beta:2"], misfit: false, answer: null } as OpenQuestion;
    const store = fakeStore([row], [{ value: "$95,000", factId: "F-030", job_ids: [] }, { value: "Yes", factId: "text-answer:r9", at: "2026-11-03T15:00:00.000Z", job_ids: ["gh:acme:1"] }]);
    const r = await questionsTurn({ message: "what do you need from me", userId: "u1", threadId: "t", now: T0, store });
    store.setIntent(QUESTIONS_INTENT);
    assertNode.ok(r && r.reply.includes(label), JSON.stringify(r));
    assertNode.ok(!r!.reply.includes("$95,000") && !/On file/.test(r!.reply) && !/use 1/.test(r!.reply), r!.reply);
    assertNode.deepStrictEqual(store.answers, []);
  }
});
