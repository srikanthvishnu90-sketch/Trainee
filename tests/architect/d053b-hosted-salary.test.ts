// D-053 follow-up (architect ruling, 2026-11-10, under the owner's D-053: "never filled into another employer's form from
// an earlier answer; each application asks again"). A confirmed salary expectation IS an earlier answer, whatever path it
// reaches the planner by: a confirmed profile fact (the hosted path) is never filled, as an answer-library row is not (the
// extension path, #747). The two paths do not differ. A salary expectation on file may only be OFFERED, beside this
// posting's question: labelled with its source by WO-122's reusedSourceSuffix, and saved only on the person's "use N".
// Salary history's legacy wording key is closed as date of birth's was (#731): history never crosses employers either.
// Run: deno test -A --no-check tests/architect/d053b-hosted-salary.test.ts
import assertNode from "node:assert/strict";
import { normLabel, planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { planApplication, trustedFacts } from "../../scripts/apply.ts";
import { type OpenQuestion, type QuestionStore, QUESTIONS_INTENT, questionsTurn } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { reusedSourceSuffix } from "../../supabase/functions/_shared/career_prepared_card.ts";

const T0 = Date.UTC(2026, 10, 10, 15);
const SALARY = "What are your salary expectations?";
const form = (salary = SALARY) => [
  { name: "first_name", label: "First Name", type: "input_text", required: true, options: [] },
  { name: "email", label: "Email", type: "input_text", required: true, options: [] },
  { name: "salary", label: salary, type: "input_text", required: true, options: [] },
];
const own = (k: string, v: string) => ({ value: v, factId: `F-${k}`, confirmed: true, user_id: "u1", provenance: "owner stated in chat 2026-11-01", confirmation_event_id: `evt-${k}` });

Deno.test("D-053b/1 hosted path: a confirmed profile fact of salary expectation is never filled; the second employer asks again", async () => {
  // The facts file the hosted preparation hands the engine (scripts/apply.ts trustedFacts + planApplication).
  const facts = { user_id: "u1", answers: { first_name: own("first_name", "Ana"), email: own("email", "ana@example.test"), salary_expectation: own("salary_expectation", "$95,000") } };
  const artifact = { filename: "resume.pdf", sha256: "a".repeat(64) };
  const manifest = trustedFacts(facts, artifact);
  assertNode.equal(manifest.answers.salary_expectation?.value, "$95,000", "the fact is confirmed and trusted");
  for (const [job, employer] of [["gh:acme:1", "Acme"], ["gh:beta:2", "Beta"]]) {
    for (const label of [SALARY, "Desired salary", "Expected compensation", "Salary", "Prétentions salariales"]) {
      const p = planApplication({ manifest, userId: "u1", jobId: job, employer, schema: form(label), artifact, now: T0 });
      assertNode.equal(p.ready, false, `${employer} / ${label}: asked, not filled`);
      if (!p.ready) assertNode.deepStrictEqual(p.needs.map((n) => n.label), [label], `${employer} / ${label}`);
    }
  }
  // The same through the planner directly, with the fact under any factId: asked; the shared facts beside it still fill.
  for (const factId of ["F-030", "text-answer:old", "profile:salary"]) {
    const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:beta:2", company: "Beta", title: "", fields: form() }],
      answers: { first_name: { value: "Ana", factId: "F-1" }, email: { value: "ana@example.test", factId: "F-2" }, salary_expectation: { value: "$95,000", factId } },
      saved: {}, log: [], now: T0 });
    assertNode.equal(r.ready.length, 0, factId);
    assertNode.deepStrictEqual(r.needs.map((n: any) => n.label), [SALARY], factId);
  }
  // The answer given for this posting still fills it.
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:beta:2", company: "Beta", title: "", fields: form() }],
    answers: { first_name: { value: "Ana", factId: "F-1" }, email: { value: "ana@example.test", factId: "F-2" }, salary_expectation: { value: "$95,000", factId: "F-030" } },
    saved: { [answerKey({ label: SALARY, type: "input_text", options: [] }, "gh:beta:2")]: { value: "$100,000", factId: "text-answer:beta" } }, log: [], now: T0 });
  assertNode.equal(r.ready.length, 1);
  assertNode.deepStrictEqual(r.ready[0].fields.find((f: any) => f.name === "salary"), { name: "salary", label: SALARY, value: "$100,000", factId: "text-answer:beta" });
});

Deno.test("D-053b/2 salary history's legacy wording key never fills it at another employer (closed as date of birth's was)", () => {
  for (const label of ["What was your salary at your previous job?", "Salary history", "Previous salary"]) {
    const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:beta:2", company: "Beta", title: "", fields: form(label) }],
      answers: { first_name: { value: "Ana", factId: "F-1" }, email: { value: "ana@example.test", factId: "F-2" } },
      saved: { [normLabel(label)]: { value: "$22 an hour", factId: "F-legacy" } }, log: [], now: T0 });
    assertNode.equal(r.ready.length, 0, label);
    assertNode.deepStrictEqual(r.needs.map((n: any) => n.label), [label], label);
  }
  // An ordinary question's wording-keyed answer still travels (the legacy key is closed only for per-application questions).
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:beta:2", company: "Beta", title: "", fields: form("What is your favorite programming language?") }],
    answers: { first_name: { value: "Ana", factId: "F-1" }, email: { value: "ana@example.test", factId: "F-2" } },
    saved: { [normLabel("What is your favorite programming language?")]: { value: "Python", factId: "F-legacy" } }, log: [], now: T0 });
  assertNode.equal(r.ready.length, 1);
});

// ------------------------------------------------------------------------------------------------ the suggestion
type Earlier = { value: string; factId: string; at?: string; job_ids: string[] };
const Q = (o: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: "q-sal", key: answerKey({ label: SALARY, type: "input_text", options: [] }, "gh:beta:2"), kind: "fact", label: SALARY, type: "input_text",
  options: [], company: "Beta", job_ids: ["gh:beta:2"], misfit: false, answer: null, ...o,
});
function fakeStore(rows: OpenQuestion[], earlier: Earlier[] | null, tz?: string) {
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
  };
  if (earlier) store.earlierSalary = async () => ({ answers: earlier, ...(tz ? { tz } : {}) });
  return store;
}
const waiting = (s: string) => ["shown", "partial"].includes(s) || s.startsWith("draft");
async function say(store: ReturnType<typeof fakeStore>, message: string) {
  const r = await questionsTurn({ message, userId: "u1", threadId: "t", now: T0, store });
  if (r) store.setIntent(waiting(r.status) ? QUESTIONS_INTENT : "career_apply_questions_answer");
  return r;
}
const ASK = "what do you need from me";

Deno.test("D-053b/3 a salary expectation on file is offered beside this posting's question, labelled with its source; showing saves nothing", async () => {
  // A confirmed fact (no date): labelled as the person's confirmed facts.
  const fact: Earlier = { value: "$95,000", factId: "F-030", job_ids: [] };
  let store = fakeStore([Q()], [fact]);
  let r = await say(store, ASK);
  assertNode.ok(r && r.status === "shown", JSON.stringify(r));
  const label = reusedSourceSuffix({ label: SALARY, factId: "F-030", source: { for_posting: false } }, "gh:beta:2");
  assertNode.equal(label, " (from your confirmed facts)");
  assertNode.ok(r!.reply.includes(`$95,000${label}`), r!.reply);
  assertNode.match(r!.reply, /use 1/);
  assertNode.match(r!.reply, /not (used|filled)/i, "says it is not used unless they confirm: " + r!.reply);
  assertNode.deepStrictEqual(store.answers, [], "nothing saved by showing it");
  // An answer they gave another employer, in their own zone: labelled with the day it was given.
  const answered: Earlier = { value: "$90,000", factId: "text-answer:r1", at: "2026-11-03T15:00:00.000Z", job_ids: ["gh:acme:1"] };
  store = fakeStore([Q()], [answered], "America/Chicago");
  r = await say(store, ASK);
  assertNode.ok(r!.reply.includes("$90,000 (from your answer on Nov 3)"), r!.reply);
  assertNode.deepStrictEqual(store.answers, []);
});

Deno.test("D-053b/4 only the person's yes ('use 1') saves the suggestion, for this posting; their own answer replaces it", async () => {
  let store = fakeStore([Q()], [{ value: "$95,000", factId: "F-030", job_ids: [] }]);
  await say(store, ASK);
  const r = await say(store, "use 1");
  assertNode.ok(r && /Saved, as drafted/.test(r.reply), JSON.stringify(r));
  assertNode.match(r!.reply, /Beta application only|isn't reused/, "kept for this posting only: " + r!.reply);
  assertNode.deepStrictEqual(store.answers, [["q-sal", "$95,000"]]);
  // Their own answer instead: saved as typed, the suggestion is not.
  store = fakeStore([Q()], [{ value: "$95,000", factId: "F-030", job_ids: [] }]);
  await say(store, ASK);
  await say(store, "$110,000");
  assertNode.deepStrictEqual(store.answers, [["q-sal", "$110,000"]]);
});

Deno.test("D-053b/5 nothing is offered from this posting's own row, from another kind of question, or with no reader", async () => {
  // The only earlier answer is for this same posting (it already fills it; not a suggestion from elsewhere).
  let store = fakeStore([Q()], [{ value: "$95,000", factId: "text-answer:same", at: "2026-11-03T15:00:00.000Z", job_ids: ["gh:beta:2"] }]);
  let r = await say(store, ASK);
  assertNode.ok(!r!.reply.includes("$95,000"), r!.reply);
  // Salary history is never offered from an expectation (nor from anything).
  store = fakeStore([Q({ id: "q-hist", label: "What was your salary at your previous job?", key: answerKey({ label: "What was your salary at your previous job?" }, "gh:beta:2") })],
    [{ value: "$95,000", factId: "F-030", job_ids: [] }]);
  r = await say(store, ASK);
  assertNode.ok(!r!.reply.includes("$95,000"), r!.reply);
  // A store with no reader: the question is shown as before.
  store = fakeStore([Q()], null);
  r = await say(store, ASK);
  assertNode.ok(r && r.status === "shown" && !/use 1/.test(r.reply), JSON.stringify(r));
});
