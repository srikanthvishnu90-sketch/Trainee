// A scripted stand-in for the research support judge that answers per the page truth, for the group B amendments (owner decision
// 2026-11-13: research support check switched on). It is the shared test judge (support-test-judge.ts) with one change: a quote
// check ("The marked text "…" is the page's own statement of fact … and it answers the question: …") is answered "no" when the
// marked unit is one the test names as not stating what was asked (a posting's header line, a page's denial, someone else's figure),
// as the real judge is told to answer. Every other item is the shared judge's answer.
import { type SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { supportsClaim } from "./support-test-judge.ts";

const markedOf = (claim: string) => /^The marked text "(.*)" is the page's own statement/s.exec(claim)?.[1] ?? null;
export function pageTruthJudge(...notStated: (string | RegExp)[]): SupportJudge {
  const refused = (unit: string) => notStated.some((x) => typeof x === "string" ? unit.includes(x) : x.test(unit));
  return async (cs) => cs.map((c) => {
    const unit = markedOf(c.claim);
    if (unit !== null && refused(unit)) return "no";
    return supportsClaim(c.claim, c.source) ? "yes" : "no";
  });
}
