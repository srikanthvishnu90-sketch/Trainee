// WO-124c fourteenth review (2026-11-15), under D-088's structural bar: "H-1B" stays a subject after dashes become spaces, in
// the id or the text; every dash, invisible format characters and camelCase ids are read as word breaks. Earlier test files
// unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const not = (says: string, id: string, text: string) => eq(triage.classify(says, { id, text }) === "meets", false, `${id} / ${text} / ${says}`);

Deno.test("124c review 14: a refused H-1B never meets", () => {
  not("yes", "c1", "H-1B: not acceptable"); not("it is available", "c1", "No H-1B"); not("meets", "c1", "H-1B transfer is a dealbreaker");
  not("yes", "h-1b", "not acceptable"); not("yes", "h-1b", "No");
  const v = triage.verdict([{ id: "c1", text: "H-1B: not acceptable", kind: "hard" }], [{ source: "A", date: "2026-11-10", says: { c1: "yes" } }]);
  eq(triage.rank([{ id: "j", verdicts: v }]).actionable, [], "never actionable");
  eq(triage.classify("we sponsor visas", { id: "c1", text: "Needs H-1B sponsorship" }), "meets", "a wanted H-1B still meets");
});

Deno.test("124c review 14: Unicode dashes, invisible characters and camelCase ids are word breaks", () => {
  not("remote is available", "c1", "Remote is a deal‐breaker"); not("remote is available", "c1", "Remote: un‐acceptable");
  not("remote is available", "c1", "Remote: n‎ot ok"); not("remote is available", "c1", "Remote: n⁣o"); not("remote is available", "c1", "Remote: n͏o");
  not("yes", "noRemote", ""); not("meets", "remoteNotOk", ""); not("yes", "noRelocation", ""); not("remote is available", "c1", "Remote, I wonʼt work");
});
