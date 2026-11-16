// WO-124c thirteenth review (2026-11-15), under D-088's structural bar: a literal "meets" goes through the subject check, and a
// hyphenated refusal word counts. Earlier test files unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

Deno.test("124c review 13: a literal 'meets' never meets a constraint that rejects its subject", () => {
  for (const says of ["meets", "MEETS", " Meets "]) {
    eq(triage.classify(says, { id: "remote", text: "Not acceptable" }) === "meets", false, says);
    eq(triage.classify(says, { id: "c1", text: "Remote, not acceptable" }) === "meets", false, says);
  }
  const v = triage.verdict([{ id: "remote", text: "Not acceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { remote: "meets" } }]);
  eq(triage.rank([{ id: "job", verdicts: v }]).actionable, [], "never actionable");
  eq(triage.classify("meets", { id: "c1", text: "Fully remote" }), "meets", "a wanted subject still meets");
});

Deno.test("124c review 13: hyphenated and listed refusals count", () => {
  for (const [id, text] of [["c1", "Remote is a deal-breaker"], ["remote", "deal-breaker"], ["c1", "Remote: un-acceptable"], ["c1", "Remote is off the table"], ["c1", "Remote ❌"]]) {
    eq(triage.classify("remote is available", { id, text }) === "meets", false, `${id} / ${text}`);
  }
});
