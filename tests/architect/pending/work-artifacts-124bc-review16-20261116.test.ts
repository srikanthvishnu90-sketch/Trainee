// WO-124c sixteenth review (2026-11-16), under D-088's structural bar: an invisible character between two words is a word break,
// and a constraint that refuses anything meets no subject-less commitment. Earlier test files unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const not = (says: string, id: string, text: string) => eq(triage.classify(says, { id, text }) === "meets", false, `${id} / ${JSON.stringify(text)} / ${says}`);

Deno.test("124c review 16: an invisible character between words does not glue a refusal", () => {
  not("remote is available", "c1", "Remote is not​acceptable"); not("yes", "c1", "Remote is not​acceptable");
  not("remote is available", "c1", "Remote is a​dealbreaker"); not("remote is available", "c1", "Remote is not⁠OK");
  not("remote is available", "c1", "Remote is never​ok"); not("remote is available", "remote", "not​ok");
  not("yes", "remote", "no​way"); not("yes", "c1", "no​remote"); not("yes", "no​remote", "");
  const v = triage.verdict([{ id: "c1", text: "Remote is not​acceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { c1: "remote is available" } }]);
  eq(triage.rank([{ id: "j", verdicts: v }]).actionable, [], "never actionable");
});

Deno.test("124c review 16: a refusal of an unlisted thing meets no subject-less commitment", () => {
  for (const text of ["On-site work is unacceptable", "Moving is a dealbreaker", "Work permit: no", "WFH is unacceptable"]) for (const says of ["yes", "meets", "it is available"]) not(says, "c1", text);
  eq(triage.classify("yes", { id: "c1", text: "Fully remote" }), "meets", "a plain want still meets on yes");
});
