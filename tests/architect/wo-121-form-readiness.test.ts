// WO-121 (D-042 M4, D-007): the captured form mapped to the person's CONFIRMED facts, by code. A value comes only from a
// fact with confirmed: true; a select's value is one of the form's own options or the field is asked; an essay, an
// attestation or a question the map does not know is asked, never drafted; an optional field with no fact is left
// blank; identity and secrets are typed by the person on the form. The oracle at the end is independent of the module:
// every answered value must be exactly the value of the confirmed fact it names.
// PENDING; DRAFT (2026-11-06): not run; no reference implementation proved it.
import assertNode from "node:assert/strict";
import { type ConfirmedFact, formReadiness, mapForm } from "../../supabase/functions/_shared/form_readiness.ts";
import type { FormSchema } from "../../supabase/functions/_shared/posting_schema.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const form = (fields: FormSchema["fields"]): FormSchema =>
  ({ v: 1, job_id: "greenhouse:test:1", source: "greenhouse_boards_api", fields, uploads: ["resume"], captcha_expected: false, sha256: "a".repeat(64), read_at: "2026-11-07T12:00:00Z" });
const f = (id: string, label: string, type: any, required: boolean, options: string[] = [], section: any = "main") =>
  ({ id, label, type, raw_type: String(type), required, options: options.map((o, i) => ({ label: o, value: String(i) })), section });

const FORM = form([
  f("first_name", "First Name", "text", true),
  f("email", "Email", "email", true),
  f("question_111", "Will you now or in the future require sponsorship for employment visa status?", "select", true, ["Yes", "No"]),
  f("question_112", "Why do you want to work at TEST Employer?", "textarea", true),
  f("gender", "Gender", "select", false, ["Male", "Female", "Decline To Self Identify"], "eeo"),
]);
const FACTS: ConfirmedFact[] = [
  { id: "F-1", key: "first_name", value: "Tess", confirmed: true },
  { id: "F-2", key: "email", value: "tess@example.test", confirmed: true },
  { id: "F-3", key: "sponsorship", value: "No", confirmed: true },
];

// The independent oracle (D-007): nothing answered that is not a confirmed fact's exact value, on the form's own options.
function oracle(r: ReturnType<typeof formReadiness>, facts: ConfirmedFact[], s: FormSchema) {
  const byId = new Map(facts.filter((x) => x.confirmed === true).map((x) => [x.id, x]));
  for (const a of r.answered) {
    const fact = byId.get(a.fact_id);
    assert(fact, `${a.id}: answered from fact ${a.fact_id}, which is not a confirmed fact`);
    const field = s.fields.find((x) => x.id === a.id)!;
    if (field.options.length) assert(field.options.some((o) => o.label === a.value || o.value === a.value), `${a.id}: '${a.value}' is the form's own option`);
    else eq(a.value, fact!.value, `${a.id}: the confirmed value exactly`);
  }
  const done = new Set([...r.answered.map((x) => x.id), ...r.needs_answer.map((x) => x.id), ...r.never_by_text.map((x) => x.id), ...r.left_blank]);
  for (const x of s.fields) assert(done.has(x.id), `${x.id} is accounted for`);
  if (r.ready) eq([r.needs_answer.length, r.never_by_text.length], [0, 0], "ready only with nothing open");
}

Deno.test("WO-121/5a three confirmed facts: answered 3, the essay asked, the optional EEO left blank, not ready", () => {
  const r = formReadiness(mapForm(FORM), FORM, FACTS);
  eq(r.answered.map((a) => a.id).sort(), ["email", "first_name", "question_111"]);
  eq(r.answered.find((a) => a.id === "question_111")?.value, "No");
  eq(r.needs_answer.map((n) => [n.id, n.why]), [["question_112", "essay"]]);
  eq(r.left_blank, ["gender"]);
  eq(r.ready, false);
  oracle(r, FACTS, FORM);
});

Deno.test("WO-121/5b an unconfirmed fact is no fact: the question is asked, never filled", () => {
  const facts = FACTS.map((x) => x.key === "sponsorship" ? { ...x, confirmed: undefined as unknown as true } : x);
  const r = formReadiness(mapForm(FORM), FORM, facts);
  eq(r.answered.some((a) => a.id === "question_111"), false);
  eq(r.needs_answer.find((n) => n.id === "question_111")?.why, "no_confirmed_fact");
  oracle(r, facts, FORM);
});

Deno.test("WO-121/5c a value that is not one of the form's options is asked (option_not_matched), never the nearest option", () => {
  const facts = FACTS.map((x) => x.key === "sponsorship" ? { ...x, value: "Only after two years" } : x);
  const r = formReadiness(mapForm(FORM), FORM, facts);
  eq(r.needs_answer.find((n) => n.id === "question_111")?.why, "option_not_matched");
  oracle(r, facts, FORM);
});

Deno.test("WO-121/5d every required field from a confirmed fact: ready, and every value is a fact's", () => {
  const s = form([f("first_name", "First Name", "text", true), f("email", "Email", "email", true),
    f("question_111", "Will you now or in the future require sponsorship for employment visa status?", "select", true, ["Yes", "No"])]);
  const r = formReadiness(mapForm(s), s, FACTS);
  eq(r.ready, true);
  eq(r.answered.length, 3);
  oracle(r, FACTS, s);
});

Deno.test("WO-121/5e an attestation and an unknown question are asked; an identity number is typed by the person on the form", () => {
  const s = form([
    f("q_att", "I certify that the information I have provided is true and complete.", "checkbox", true),
    f("q_unknown", "Which of our three values resonates most with you?", "select", true, ["Grit", "Craft", "Care"]),
    f("q_ssn", "Social Security Number", "text", true),
  ]);
  const r = formReadiness(mapForm(s), s, [...FACTS, { id: "F-9", key: "ssn", value: "000-00-0000", confirmed: true }]);
  eq(r.needs_answer.find((n) => n.id === "q_att")?.why, "attestation");
  eq(r.needs_answer.find((n) => n.id === "q_unknown")?.why, "unknown_question");
  eq(r.never_by_text.map((n) => n.id), ["q_ssn"], "never answered from a stored value, never asked by text (NEVER_BY_TEXT)");
  eq(r.answered.some((a) => a.id === "q_ssn"), false);
  eq(r.ready, false);
});

Deno.test("WO-121/5f mapForm is person-independent and deterministic (stored once per posting)", () => {
  eq(mapForm(FORM), mapForm(structuredClone(FORM)));
  for (const m of mapForm(FORM)) assert(!("value" in (m as any)), `${m.id}: the stored map holds no person's value`);
});
