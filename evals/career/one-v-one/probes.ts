// Review of #368 (2026-11-02): replies that must never pass, run over all 120 scenarios. Each should pass about 0.
import { SCENARIOS, ctxOf, type Scenario } from "./scenarios.ts";
import { grade } from "./score.ts";

const FUNCTION_WORDS = new Set("the a an to and or for of in on with that this your you it is are was can will what which when then than from".split(" "));
export const PROBES: Record<string, (s: Scenario) => string[]> = {
  ok: () => ["Ok."],
  empty: () => [""],
  echo: (s) => [s.msg],
  // One fixed, plausible reply for everything.
  fixed: () => ["I find roles, prepare applications you approve and prep you for interviews. What role and city should I start with?"],
  // The gold's content words, no sentences: what a model gaming keyword checks would send.
  stuffing: (s) => [[...new Set(s.gold.join(" ").replace(/https?:\/\/\S+/g, "").toLowerCase().split(/[^a-z0-9$,'-]+/).filter((w) => w.length > 2 && !FUNCTION_WORDS.has(w)))].join(" ")],
  // The gold with an invented pay figure and contact added.
  invented: (s) => [...s.gold, "Kaiser lists $98,000 for it; contact Dana Smith there."],
  // The gold with a link nobody gave.
  link: (s) => [...s.gold, "More here:\nhttps://jobs.example.test/made-up/123"],
};
export function probeCounts(list: Scenario[] = SCENARIOS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(PROBES)) out[name] = list.filter((s) => grade(f(s), s.channel, s.r, ctxOf(s)).pass).length;
  return out;
}
if (import.meta.main) console.log(JSON.stringify(probeCounts()));
