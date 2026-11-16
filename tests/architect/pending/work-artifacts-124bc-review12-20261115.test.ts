// WO-124c twelfth review (2026-11-15), under D-088's structural bar: a rejection in the text counts when the subject is named only
// in the id, and a commitment that names no subject ("yes", "it is available") never meets a constraint that rejects its subject.
// Earlier test files unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

Deno.test("124c review 12: the subject named only in the id, the rejection in the text, never meets", () => {
  for (const [id, text, says] of [["remote", "Not acceptable", "remote work is available"], ["remote", "No.", "remote work is available"], ["remote", "dealbreaker", "remote is available"],
    ["relocation", "never", "relocation is available"], ["visa", "not needed", "we sponsor visas"], ["hybrid", "no thanks", "hybrid is available"], ["remote", "avoid", "remote is available"]]) {
    eq(triage.classify(says, { id, text }) === "meets", false, `${id} / ${text} / ${says}`);
  }
  const v = triage.verdict([{ id: "remote", text: "Not acceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { remote: "Remote work is available." } }]);
  eq(triage.rank([{ id: "job", verdicts: v }]).actionable, [], "never actionable");
});

Deno.test("124c review 12: a commitment that names no subject never meets a constraint that rejects its subject", () => {
  for (const [text, says] of [["Remote, not acceptable", "it is available"], ["No relocation", "we offer it"], ["Remote, not acceptable", "yes"]]) {
    eq(triage.classify(says, { id: "c1", text }) === "meets", false, `${text} / ${says}`);
  }
  eq(triage.classify("yes", { id: "c1", text: "Fully remote" }), "meets", "a constraint that wants its subject still meets on yes");
  eq(triage.classify("remote is available", { id: "remote", text: "Must be remote" }), "meets", "and on its subject");
});
