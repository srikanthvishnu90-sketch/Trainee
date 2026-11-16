// WO-124c fifteenth review (2026-11-15), under D-088's structural bar: a mixed-case subject word ("ReLocation") stays a subject
// when camelCase is split; U+2212 is a dash. Earlier test files unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const not = (says: string, id: string, text: string) => eq(triage.classify(says, { id, text }) === "meets", false, `${id} / ${text} / ${says}`);

Deno.test("124c review 15: mixed-case subject words and U+2212 dashes", () => {
  not("yes", "c1", "ReLocation is unacceptable"); not("meets", "c1", "reLocation: dealbreaker"); not("yes", "c1", "ReMote: not ok");
  not("it is available", "c1", "HyBrid is a dealbreaker"); not("yes", "reLocation", "not ok");
  not("yes", "c1", "Remote is a deal−breaker"); not("yes", "c1", "Remote: un−acceptable");
  const v = triage.verdict([{ id: "c1", text: "ReLocation is unacceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { c1: "yes" } }]);
  eq(triage.rank([{ id: "j", verdicts: v }]).actionable, [], "never actionable");
  eq(triage.classify("yes", { id: "remoteOK", text: "" }), "meets", "a wanted camelCase subject still meets");
});
