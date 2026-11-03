// WO-009a acceptance tests (architect-authored). Speed comes from preparing every application before a browser opens:
// the employer's own form questions (Greenhouse publishes them) are answered from the person's confirmed facts; anything
// missing is asked ONCE and reused for every later application; the batch is admitted against the limits up front.
// Contract: docs/architect/work-orders/WO-009-real-submissions.md (009a). Run: deno test -A --no-check tests/architect/
import { greenhouseQuestions, classifyField, planBatch } from "../../supabase/functions/_shared/career_apply.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const T0 = Date.UTC(2026, 9, 20, 15);

// The shape of GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true (questions[].fields[]).
const ghJob = (id: string, extra: any[] = []) => ({
  id, title: "Data Analyst", absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
    { label: "Last Name", required: true, fields: [{ name: "last_name", type: "input_text", values: [] }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text", values: [] }] },
    { label: "Phone", required: false, fields: [{ name: "phone", type: "input_text", values: [] }] },
    { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file", values: [] }] },
    { label: "LinkedIn Profile", required: false, fields: [{ name: "question_111", type: "input_text", values: [] }] },
    { label: "Are you legally authorized to work in the United States?", required: true, fields: [{ name: "question_222", type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }] },
    { label: "Will you now or in the future require visa sponsorship?", required: true, fields: [{ name: "question_333", type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }] },
    ...extra,
  ],
});
const answers = {
  first_name: { value: "Ana", factId: "F-001" }, last_name: { value: "Diaz", factId: "F-001" }, email: { value: "ana@example.com", factId: "F-002" },
  resume: { value: "resume:sha256:ab12", factId: "F-010" }, work_authorization: { value: "Yes", factId: "F-020" }, sponsorship: { value: "No", factId: "F-021" },
};

Deno.test("WO-009a/1 greenhouseQuestions turns the employer's published form into fields with required flags and options", () => {
  const f = greenhouseQuestions(ghJob("1"));
  eq(f.length, 8);
  eq(f[0], { name: "first_name", label: "First Name", required: true, type: "input_text", options: [] });
  eq(f[6].options, [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
});

Deno.test("WO-009a/2 classifyField maps common labels to answer keys and leaves the rest unknown", () => {
  eq(classifyField("First Name", "input_text"), "first_name");
  eq(classifyField("Resume/CV", "input_file"), "resume");
  eq(classifyField("Are you legally authorized to work in the United States?", "multi_value_single_select"), "work_authorization");
  eq(classifyField("Will you now or in the future require visa sponsorship?", "multi_value_single_select"), "sponsorship");
  eq(classifyField("LinkedIn Profile", "input_text"), "linkedin");
  eq(classifyField("Why do you want to work at Acme?", "textarea"), "unknown");
});

Deno.test("WO-009a/3 a posting whose required questions are all answered from confirmed facts is ready, each value citing its fact", () => {
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:acme:1", company: "Acme", title: "Data Analyst", fields: greenhouseQuestions(ghJob("1")) }], answers, saved: {}, log: [], now: T0 });
  eq(r.ready.length, 1);
  const byName = Object.fromEntries(r.ready[0].fields.map((x: any) => [x.name, x]));
  eq([byName.first_name.value, byName.first_name.factId], ["Ana", "F-001"]);
  eq(byName.question_222.value, "1", "a select is answered with the employer's own option value");
  eq(byName.question_333.value, "0");
  assert(!("phone" in byName) && !("question_111" in byName), "optional fields with no fact are left empty, never guessed");
  eq(r.needs, []);
});

Deno.test("WO-009a/4 a required question with no answer blocks only that posting and is asked ONCE across the batch", () => {
  const why = { label: "Why do you want to work here?", required: true, fields: [{ name: "question_444", type: "textarea", values: [] }] };
  const salary = { label: "What are your salary expectations?", required: true, fields: [{ name: "question_555", type: "input_text", values: [] }] };
  const postings = [
    { job_id: "gh:acme:1", company: "Acme", title: "Data Analyst", fields: greenhouseQuestions(ghJob("1", [salary])) },
    { job_id: "gh:beta:2", company: "Beta", title: "Data Analyst", fields: greenhouseQuestions(ghJob("2", [salary, why])) },
    { job_id: "gh:gamma:3", company: "Gamma", title: "Data Analyst", fields: greenhouseQuestions(ghJob("3")) },
  ];
  const r = planBatch({ userId: "u1", postings, answers, saved: {}, log: [], now: T0 });
  eq(r.ready.map((x: any) => x.job_id), ["gh:gamma:3"]);
  eq(r.needs.map((n: any) => [n.label, n.job_ids]), [
    ["What are your salary expectations?", ["gh:acme:1", "gh:beta:2"]],
    ["Why do you want to work here?", ["gh:beta:2"]],
  ], "each missing question once, with every posting it unblocks");
});

Deno.test("WO-009a/5 an answer the person gave once (saved by its normalized label) fills that question everywhere after", () => {
  const salary = { label: "What are your salary expectations? ", required: true, fields: [{ name: "question_555", type: "input_text", values: [] }] };
  const saved = { "what are your salary expectations": { value: "$85,000", factId: "F-030" } };
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:acme:1", company: "Acme", title: "Data Analyst", fields: greenhouseQuestions(ghJob("1", [salary])) }], answers, saved, log: [], now: T0 });
  eq(r.ready.length, 1);
  eq(r.ready[0].fields.find((x: any) => x.name === "question_555").factId, "F-030");
});

Deno.test("WO-009a/6 a select answer that matches none of the employer's options is never forced: the question is asked", () => {
  const r = planBatch({ userId: "u1", postings: [{ job_id: "gh:acme:1", company: "Acme", title: "Data Analyst", fields: greenhouseQuestions(ghJob("1")) }],
    answers: { ...answers, work_authorization: { value: "Authorized via OPT", factId: "F-020" } }, saved: {}, log: [], now: T0 });
  eq(r.ready.length, 0);
  eq(r.needs[0].label, "Are you legally authorized to work in the United States?");
});

Deno.test("WO-009a/7 the batch is admitted up front: duplicates are skipped with reasons; no company rule (D-MS-3); no product daily ceiling, only a pace the person set (CAPS-1390)", () => {
  const postings = Array.from({ length: 30 }, (_, i) => ({ job_id: `gh:co${i}:1`, company: `Co${i}`, title: "Data Analyst", fields: greenhouseQuestions(ghJob(String(i))) }));
  postings.push({ job_id: "gh:co0:1", company: "Co0", title: "Data Analyst", fields: greenhouseQuestions(ghJob("0")) });
  const log = [{ user_id: "u1", job_id: "gh:old:1", company: "Co5", at: T0 - 86400000 * 3, state: "confirmed" }];
  const r = planBatch({ userId: "u1", postings, answers, saved: {}, log, now: T0 });
  eq(r.ready.length, 30, "no product daily ceiling and no company rule: all but the duplicate");
  const reasons = r.skipped.map((s: any) => s.reason);
  assert(!reasons.includes("company_cooldown"), "Co5 was applied to 3 days ago, for another role: it is still planned (D-MS-3)");
  assert(reasons.includes("duplicate_job"), "the repeated posting");
  assert(!reasons.includes("daily_cap"), "nothing is refused for volume when the person set no pace");
  const paced = planBatch({ userId: "u1", postings, answers, saved: {}, log, now: T0, limits: { daily: 25 } });
  eq(paced.ready.length, 25, "a pace the person set holds, counting this batch");
  assert(paced.skipped.map((s: any) => s.reason).includes("daily_cap"), "the rest wait for tomorrow by their own pace");
  const many = Array.from({ length: 70 }, (_, i) => ({ job_id: `gh:m${i}:1`, company: `M${i}`, title: "Data Analyst", fields: greenhouseQuestions(ghJob(String(i))) }));
  eq(planBatch({ userId: "u1", postings: many, answers, saved: {}, log: [], now: T0, limits: { daily: 500 } }).ready.length, 70, "a person's own pace has no maximum");
  eq(planBatch({ userId: "u1", postings: many, answers, saved: {}, log: [], now: T0 }).ready.length, 70, "and with none set, nothing caps the batch");
});
