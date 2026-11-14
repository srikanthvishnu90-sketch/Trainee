// deno-lint-ignore-file require-await
// A scripted stand-in for the research support judge that answers per the page truth, for the group B amendments (owner decision
// 2026-11-13: research support check switched on). It is the shared test judge (support-test-judge.ts) with two changes, each one
// the real judge is told to make (support.ts SUPPORT_JUDGE_SYSTEM) and the word judge cannot see:
//   - a quote check ("The marked text "…" is the page's own statement of fact … and it answers the question: …") is "no" when the
//     marked unit is one the test names as not answering what was asked (a posting's header line, someone else's figure);
//   - a claim in the model's words is "no" when the test names it as not stated by the page (a denial the word list cannot read,
//     "It is false that …"; the same figure said of senior traders, not interns).
// Every other item is the shared judge's answer. It only ever turns a "yes" into a "no": it never passes what the shared judge refuses.
import { type SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { supportsClaim } from "./support-test-judge.ts";

type Pat = string | RegExp;
const hit = (p: Pat, t: string) => typeof p === "string" ? t.includes(p) : p.test(t);
const markedOf = (claim: string) => /^The marked text "(.*)" is the page's own statement/s.exec(claim)?.[1] ?? null;
export function pageTruthJudge(...notQuoted: Pat[]): SupportJudge {
  return truthJudge({ notQuoted });
}
export function truthJudge(o: { notQuoted?: Pat[]; notStated?: Pat[] }): SupportJudge {
  return async (cs) => cs.map((c) => {
    const unit = markedOf(c.claim);
    if (unit !== null && (o.notQuoted ?? []).some((p) => hit(p, unit))) return "no";
    if (unit === null && (o.notStated ?? []).some((p) => hit(p, c.claim))) return "no";
    return supportsClaim(c.claim, c.source) ? "yes" : "no";
  });
}
