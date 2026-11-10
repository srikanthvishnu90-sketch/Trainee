// Task a-sensitive (2026-11-10): real employer questions about sensitive and identity facts (work authorization,
// sponsorship, graduation, GPA, gender, race and ethnicity, sexual orientation, pronouns, disability, veteran status) and the
// date-of-birth cases written for the interim ruling, each through the planner, the ask-once store, the text ask and the
// browser filler (evals/apply/sensitive-loop.ts says what each bar is). Baseline on trunk 2af8f1be: 56 of 90 real, 0 of 5
// date of birth. Synthetic persona; real employers' questions, options and locations (tests/fixtures/apply/sensitive-questions.json).
import { check, DOB, type Q } from "../../evals/apply/sensitive-loop.ts";
import FIXTURE from "../fixtures/apply/sensitive-questions.json" with { type: "json" };

const REAL = (FIXTURE as any).questions as Q[];
function none(qs: Q[]) {
  const bad = qs.map((q) => ({ q, fails: check(q) })).filter((x) => x.fails.length);
  if (bad.length) throw new Error(bad.map((x) => `${x.q.id} ${x.q.company}: ${x.q.label.slice(0, 80)}\n   ${x.fails.join("\n   ")}`).join("\n"));
}

Deno.test("a-sensitive/1 at least 60 real variants, from captured forms and the strict run, in every category", () => {
  if (REAL.length < 60) throw new Error(`${REAL.length} variants`);
  if (REAL.some((q) => q.synthetic)) throw new Error("a written case among the real ones");
  for (const c of ["work_authorization", "sponsorship", "graduation_date", "gpa", "gender", "race_ethnicity", "orientation", "pronouns", "disability", "veteran"]) {
    if (!REAL.some((q) => q.category === c)) throw new Error(`no ${c} question`);
  }
});

Deno.test("a-sensitive/2 every real variant: never guessed, asked per application by name, decline kept, work rights scoped", () => none(REAL));

Deno.test("a-sensitive/3 date of birth: asked only when required, for that application, never kept for reuse", () => none(DOB));
