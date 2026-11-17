// D-093 (owner, 2026-11-16, "All at once"): a batch's open questions go in ONE numbered message, each with how many
// applications it holds; a lone question keeps E3 (one fact, by name, why it matters).
import assertNode from "node:assert/strict";
import { questionsText, splitAnswers } from "../../../supabase/functions/_shared/career_apply_questions.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const q = (id: string, label: string, options: string[] = []) => ({ id, key: `fact:${id}`, kind: "fact", label, type: options.length ? "multi_value_single_select" : "input_text", options, job_ids: ["a", "b", "c"], company: null }) as any;
Deno.test("three open questions: one numbered message with all three, answered in one reply", () => {
  const t = questionsText([q("work_authorization", "Are you legally authorized to work in the United States?", ["Yes", "No"]), q("start_date", "Earliest start date"), q("gpa", "GPA")], 3)!;
  eq(t.take.length, 3);
  assert(/^3 questions only you can answer are holding up your applications\./.test(t.text), t.text);
  assert(/\n1\. Are you legally authorized.*\n2\. Earliest start date.*\n3\. GPA/s.test(t.text), t.text);
  eq([...splitAnswers("1 Yes\n2 June 2027\n3 3.7", 3)!.values()], ["Yes", "June 2027", "3.7"]);
});
Deno.test("one open question: E3, asked alone", () => {
  const t = questionsText([q("gpa", "GPA")], 1)!;
  eq(t.take.length, 1);
  assert(/^One question only you can answer/.test(t.text), t.text);
});
