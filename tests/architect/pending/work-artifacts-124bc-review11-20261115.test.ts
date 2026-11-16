// WO-124c eleventh review (2026-11-15), under D-088's structural bar: a constraint's negation is read across the whole
// text, not cut off at a comma or bracket; "opt" is a visa word only as a whole word. Earlier test files unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

Deno.test("124c review 11: a subject the constraint rejects is never met, whatever punctuation splits the rejection", () => {
  const cases: [string, string, string][] = [
    ["c1", "Remote, not acceptable", "remote is available"], ["c1", "Remote (not acceptable)", "remote is available"],
    ["c1", "Remote. Not acceptable.", "remote is available"], ["c1", "Remote? No.", "remote is available"],
    ["c1", "Relocation, never", "relocation is available"], ["c1", "Visa sponsorship, not needed", "we sponsor visas"],
    ["remote", "Remote, not acceptable", "remote is available"], ["remote_work", "remote? no", "remote is available"],
    ["relocation", "Relocation, I will not", "relocation is available"], ["c1", "Avoid relocation", "relocation is available"],
    ["relocate_avoid", "", "relocation is available"], ["c1", "anything but remote", "remote is available"],
  ];
  for (const [id, text, says] of cases) {
    const r = triage.classify(says, { id, text });
    eq(r === "meets", false, `${id} / ${text} / ${says}`);
  }
  const v = triage.verdict([{ id: "c1", text: "Remote, not acceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { c1: "Remote is available" } }]);
  eq(triage.rank([{ id: "job", verdicts: v }]).actionable, [], "never actionable");
});

Deno.test("124c review 11: 'opt' is a visa word only as a whole word", () => {
  eq(triage.classify("visa sponsorship is available", { id: "c1", text: "Option to work from Austin" }) === "meets", false, "option");
  eq(triage.classify("we sponsor visas", { id: "optional_perks", text: "" }) === "meets", false, "optional_perks");
  eq(triage.classify("we sponsor visas", { id: "c1", text: "needs visa sponsorship" }), "meets", "a real visa constraint still meets");
});
