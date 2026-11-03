// WO-061 (architect): the eval's spend cap. The owner gave the brain-versus-router eval $15 of OpenAI spend in total
// (D-027); the runner counts what earlier runs recorded and stops before the item that would cross it. A stopped run is
// marked and is never read as a score.
import { budgetStop, runEval, spentUsd, type EvalItem } from "../../evals/career/run.ts";

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const items: EvalItem[] = Array.from({ length: 10 }, (_, i) => ({ id: `E${i}`, persona: "p", turns: ["hi"], must: ["x"] }));

Deno.test("WO-061/1 the spend already recorded counts every earlier run, not the label being written", () => {
  const prior = [
    { label: "router-1", cost_usd: { brain: 0, judge: 0.4 } },
    { label: "agent-1", cost_usd: { brain: 2.1, judge: 0.5 } },
    { label: "agent-2", cost_usd: { brain: 9, judge: 9 } },
    { label: "broken" },
  ];
  eq(Math.round(spentUsd(prior, "agent-2") * 1000), 3000, "agent-2 is being rewritten: not counted twice");
});

Deno.test("WO-061/2 the run stops before the item that would cross the cap, and says so", async () => {
  let spent = 13.5; // $1.50 left; each item costs $0.20, under the $0.25 reserve
  const brain = async () => { spent += 0.2; return { replies: ["ok"], state: null }; };
  const judge = async () => ({ pass: true, failed: [], score: 5, note: "" });
  const r = await runEval(items, brain, judge, budgetStop(15, () => spent));
  eq(r.total, 7, "items start at 13.5, 13.7 ... 14.7; at 14.9 the next could cross");
  eq(r.planned, 10);
  if (!r.stopped || !/budget/.test(r.stopped)) throw new Error(`not marked stopped: ${r.stopped}`);
  if (spent > 15) throw new Error(`spent ${spent}: over the cap`);
});

Deno.test("WO-061/3 no budget: every item runs and the run is not marked stopped", async () => {
  const r = await runEval(items, async () => ({ replies: ["ok"], state: null }), async () => ({ pass: false, failed: ["x"], score: 1, note: "" }), budgetStop(null, () => 99));
  eq([r.total, r.stopped, r.pass_rate], [10, null, 0]);
});

Deno.test("WO-061/4 a run already at the cap runs nothing", async () => {
  const r = await runEval(items, async () => { throw new Error("must not run"); }, async () => ({ pass: true, failed: [], score: 5, note: "" }), budgetStop(15, () => 14.9));
  eq([r.total, r.passed], [0, 0]);
  if (!r.stopped) throw new Error("not stopped");
});

// Owner, 2026-10-21: "It scores 95% or better on the held-out evaluation set" with "Two independent judges"; the bar moved
// from the official set (D-027) to the held-out set, both judges must pass an item, and every run is logged.
Deno.test("WO-061/5 the workflow passes the cap, never reads a stopped run as a score, judges twice with Claude and logs every run", async () => {
  const wf = await Deno.readTextFile(".github/workflows/brain-eval.yml");
  { const m = wf.match(/MODEL_BUDGET_TARGET_USD: "([0-9.]+)"/), h = wf.match(/MODEL_BUDGET_HARD_USD: "([0-9.]+)"/);
    if (!m || Number(m[1]) !== 70 || !h || Number(h[1]) !== 70) throw new Error("the owner's directive (2026-11-02) is one $70 total: target and hard max both 70"); }
  if (!/ANTHROPIC_EVAL_BUDGET_USD: "[0-9.]+"/.test(wf)) throw new Error("no Anthropic budget cap env");
  { const vt = await Deno.readTextFile("evals/career/verdict.ts"), second = wf.slice(wf.indexOf("A second, independent reading"));
    if (!/\.stopped/.test(vt) || !/judge error/.test(vt)) throw new Error("the verdict reads a stopped run or a run whose judge errored");
    if (!/import\("file:\/\/" \+ Deno\.cwd\(\) \+ "\/evals\/career\/verdict\.ts"\)/.test(second) || !/releaseGate\(set, ps\)/.test(second) || /0\.95/.test(second)) throw new Error("the second reading must call verdict.ts releaseGate, not repeat the threshold");
    if (!/passed \* 20 >= total \* 19/.test(vt)) throw new Error("the bar is exact counts: passed/total >= 0.95"); }
  if (!/--set heldout/.test(wf)) throw new Error("the owner's bar (95% on the held-out set) is not the verdict");
  if (!/for p in 1 2 3 4 5;/.test(wf)) throw new Error("fewer than five passes decide whether a fix helped (second judge, 2026-10-21: three passes cannot resolve a change under about 5 points)");
  if (!/score-log\.ts/.test(wf)) throw new Error("the run is not logged");
  if (!/EVAL_JUDGE_MODEL: claude-sonnet-5-5/.test(wf) || !/EVAL_JUDGE_MODEL_2: claude-haiku-5-5/.test(wf)) throw new Error("the two Claude judges do not judge every run (owner, 2026-10-21: a judge that runs only sometimes makes runs incomparable)");
});
