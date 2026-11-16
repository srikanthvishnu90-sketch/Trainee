// D-091 (owner, 2026-11-16: "Run it on subscription (Recommended)"): S3 accepts a reply-quality measurement made on the
// owner's Claude subscription, committed to ci/brain-eval as evals/career/subscription/<sha>.json, with the bar unchanged
// (five passes of the served brain on the dev set, both judges and the code-counted outcome, EVERY pass >= 95%). CI re-derives
// every verdict from the evidence's transcripts and raw judge answers; anything it cannot re-derive is refused.
// The evidence here is written by hand from the repository's real dev set and scorer (not by the packer under test).
// No network, no git: in-memory sources, as tests/architect/deploy-standard.test.ts.
// Run: deno test -A --no-check tests/architect/s3-subscription-evidence.test.ts
import assertNode from "node:assert/strict";
import { missingMeasurement, S3_RULING_D056, s3, type Sources } from "../../scripts/launch/deploy-standard.ts";
import { REPLY_CODE } from "../../scripts/launch/reply-code.ts";
import { HARNESS } from "../../evals/career/harness.ts";
import { checklistOf, JUDGE_A_MODEL, JUDGE_B_MODEL, judgeFingerprint } from "../../evals/career/judges.ts";
import { type EvalItem, JUDGE_PROMPT } from "../../evals/career/run.ts";
import { RELEASE_CONFIG_PATH } from "../../supabase/functions/agent-chat/release_config.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SET_PATH = "evals/career/heldout-live.json";
const SET_TEXT = Deno.readTextFileSync(`${ROOT}/${SET_PATH}`), SET: EvalItem[] = JSON.parse(SET_TEXT).items;
const CONFIG = Deno.readTextFileSync(`${ROOT}/${RELEASE_CONFIG_PATH}`); // serves "staged"
const C = "c".repeat(40), B = "b".repeat(40), A = "a".repeat(40), X = "9".repeat(40), W = S3_RULING_D056.deployed, D = "d".repeat(40);
const LOG_HEAD = "# Brain score log\n\n| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
const QUOTE = "here is what I found for you";
const FP = await judgeFingerprint(JUDGE_PROMPT, { a: JUDGE_A_MODEL, b: JUDGE_B_MODEL });

// One case as run.ts --subscription records it: the replies, the end state, every raw judge answer.
function item(it: EvalItem, pass: boolean) {
  const a = JSON.stringify({ pass, failed: pass ? [] : [it.must[0]], score: pass ? 5 : 2, note: "graded" });
  const b = JSON.stringify({ checks: checklistOf(it).map((c) => ({ n: c.n, met: pass, quote: QUOTE })), score: 4, note: "audited" });
  return { id: it.id, pass, replies: [`Hi. ${QUOTE}.`], state: null, judge_raw: [{ judge: "a", text: a }, { judge: "b", text: b }] };
}
// A pass with `fails` failing cases (the first ones).
const pass = (k: number, fails = 0) => {
  const items = SET.map((it, i) => item(it, i >= fails));
  return { label: `s3sub-p${k}`, run_at: "2026-11-16T10:00:00Z", api_key_source: "none", stopped: null, total: SET.length, passed: SET.length - fails, items };
};
function evidence(o: { sha?: string; fails?: number[] } = {}): any {
  return {
    kind: "trainee-s3-subscription-evidence", version: 1, mode: "subscription", sha: o.sha ?? C, reply_tree: "R:T2", eval_tree: "E:V2",
    set: "dev", brain: "staged", harness: HARNESS, judge_model: JUDGE_A_MODEL, judge_model_2: JUDGE_B_MODEL, judge_prompt_sha: FP,
    passes: (o.fails ?? [0, 1, 0, 1, 0]).map((f, k) => pass(k + 1, f)),
  };
}

interface World { evidence: Record<string, string>; trees: Record<string, string>; evalTrees: Record<string, string>; parents: Record<string, string>; deployed: string; log: string }
function world(ev: any = evidence()): World {
  return {
    evidence: { [C]: JSON.stringify(ev) }, trees: { [C]: "T2", [B]: "T2", [A]: "T1", [W]: "T1", [D]: "T1", [X]: "T9" },
    evalTrees: { [C]: "V2", [B]: "V2", [A]: "V1", [W]: "V1", [D]: "V1", [X]: "V2" }, parents: { [C]: B, [B]: A, [A]: W }, deployed: W, log: LOG_HEAD,
  };
}
const isReply = (paths: readonly string[]) => paths.length === REPLY_CODE.length && paths.every((p, i) => p === REPLY_CODE[i]);
function sources(w: World): Sources {
  const src = {
    checkRuns: async () => [], lastDeployedSha: async () => w.deployed, firstParent: async () => [], pull: async () => null, reviews: async () => [],
    pullFiles: async () => [], ledger: async () => "", scoreLog: async () => w.log, firstAdded: async () => null, secretsAudit: async () => ({ code: 0, out: "" }),
    fileAt: async (_sha: string, path: string) => path === RELEASE_CONFIG_PATH ? CONFIG : path === SET_PATH ? SET_TEXT : null,
    resolve: async (rev: string) => [A, B, C, W, D, X].find((s) => s.startsWith(rev)) ?? null,
    parent: async (sha: string) => w.parents[sha] ?? null,
    isAncestor: async () => false,
    changed: async (a: string, b: string, paths: readonly string[]) => isReply(paths) ? w.trees[a] !== w.trees[b] : w.evalTrees[a] !== w.evalTrees[b],
    tree: async (sha: string, paths: readonly string[]) => isReply(paths) ? (w.trees[sha] ? `R:${w.trees[sha]}` : null) : (w.evalTrees[sha] ? `E:${w.evalTrees[sha]}` : null),
    subscriptionEvidence: async (sha: string) => w.evidence[sha] ?? null,
  };
  return src as unknown as Sources;
}
async function judge(w: World) {
  const r = await s3(sources(w), C, w.deployed);
  return { pass: r.pass, text: `${r.summary}\n${r.evidence.join("\n")}` };
}
async function refused(w: World, why: RegExp) {
  const r = await judge(w);
  eq(r.pass, false, r.text);
  ok(/D-091/.test(r.text) && why.test(r.text), `S3 names the D-091 refusal (${why}):\n${r.text}`);
}

Deno.test("D-091: valid subscription evidence (5 passes, worst 37/38 >= 95%) passes S3 and needs no CI measurement", async () => {
  const w = world();
  const r = await judge(w);
  eq(r.pass, true, r.text);
  ok(/SUBSCRIPTION \(D-091\).*worst pass 37\/38 >= 95%/.test(r.text), r.text);
  ok(/apiKeySource none/.test(r.text) && /cccccccccc/.test(r.text), r.text);
  const need = await missingMeasurement(sources(w), C, w.deployed);
  eq(need.sha, null, need.why); // the release workflow then dispatches no API measurement
  ok(/D-091/.test(need.why), need.why);
});
Deno.test("D-091: evidence of a same-reply-code ancestor stands for the candidate; it is looked up along the lineage", async () => {
  const w = world(evidence({ sha: B })); w.evidence = { [B]: w.evidence[C] };
  const r = await judge(w);
  eq(r.pass, true, r.text);
});
Deno.test("D-091 refusal: evidence for a different SHA (not the candidate or a same-reply-code ancestor)", async () => {
  await refused(world(evidence({ sha: X })), /measured 9999999999, not cccccccccc/);
  const w = world(evidence({ sha: A })); // A is an ancestor, but its reply code differs
  await refused(w, /measured aaaaaaaaaa/);
});
Deno.test("D-091 refusal: a different reply-code tree, or a different eval-code tree (set, judges, harness)", async () => {
  const w = world(); w.trees[C] = "T3"; w.trees[B] = "T3";
  await refused(w, /reply-code tree/);
  const v = world(); v.evalTrees[C] = "V3";
  await refused(v, /eval-code tree/);
});
Deno.test("D-091 refusal: a missing case, an extra case, a repeated case", async () => {
  const miss = evidence(); miss.passes[2].items.pop();
  await refused(world(miss), new RegExp(`pass 3 .*missing \\[${SET[SET.length - 1].id}\\]`));
  const extra = evidence(); extra.passes[0].items.push({ ...extra.passes[0].items[0], id: "Z999" });
  await refused(world(extra), /pass 1 .*extra \[Z999\]/);
  const dup = evidence(); dup.passes[1].items[1] = { ...dup.passes[1].items[0] };
  await refused(world(dup), /pass 2 .*missing \[.+\].*1 repeated/);
});
Deno.test("D-091 refusal: a pass under 95% (36/38) fails S3, whatever the mean", async () => {
  await refused(world(evidence({ fails: [0, 0, 2, 0, 0] })), /worst pass 36\/38 < 95%/);
});
Deno.test("D-091 refusal: a tampered count or a tampered verdict (the transcripts and judge answers decide)", async () => {
  const count = evidence({ fails: [1, 1, 1, 1, 1] }); count.passes[3].passed = 38;
  await refused(world(count), /pass 4 .*claims 38\/38, but its transcripts give 37\/38/);
  const verdict = evidence({ fails: [1, 1, 1, 1, 1] }); verdict.passes[0].items[0].pass = true; verdict.passes[0].passed = 38;
  await refused(world(verdict), /pass 1 .*claims pass, but its transcript and judge answers give fail/);
  const quote = evidence(); quote.passes[0].items[5].replies = ["something else entirely"]; // judge B's quotes are not in the reply
  await refused(world(quote), /pass 1 .*claims pass, but .* give fail/);
});
Deno.test("D-091 refusal: a run that is not apiKeySource none, or not a subscription run", async () => {
  const key = evidence(); key.passes[4].api_key_source = "ANTHROPIC_API_KEY";
  await refused(world(key), /pass 5 .*apiKeySource "ANTHROPIC_API_KEY", not "none"/);
  const mode = evidence(); mode.mode = "api";
  await refused(world(mode), /mode is "api"/);
});
Deno.test("D-091 refusal: four passes, a judge error (NOT A SCORE), another brain, another scorer", async () => {
  const four = evidence(); four.passes.pop();
  await refused(world(four), /4 passes, not 5/);
  const err = evidence(); err.passes[0].items[0].judge_raw = [{ judge: "a", error: "HTTP 500" }, { judge: "a", error: "HTTP 500" }, err.passes[0].items[0].judge_raw[1]];
  await refused(world(err), /judge errored.*NOT A SCORE/);
  const brain = evidence(); brain.brain = "router";
  await refused(world(brain), /brain router, but the candidate serves staged/);
  const fp = evidence(); fp.judge_prompt_sha = "0000000000000000";
  await refused(world(fp), /judges .* are not the candidate's/);
});
Deno.test("D-091: invalid evidence for the candidate never triggers a CI (API) measurement; no evidence at all is S3 as before", async () => {
  const bad = evidence(); bad.passes[0].api_key_source = "ANTHROPIC_API_KEY";
  const need = await missingMeasurement(sources(world(bad)), C, W);
  eq(need.sha, null, need.why); ok(/D-091.*refused/.test(need.why), need.why);
  const none = world(); none.evidence = {};
  eq((await missingMeasurement(sources(none), C, W)).sha, C); // unchanged: CI measures the candidate
  const r = await judge(none); eq(r.pass, false); ok(/candidate: no staged measurement/.test(r.text), r.text);
});
Deno.test("D-091 against any other deployed SHA: the bar AND no regression from the deployed SHA's own subscription measurement", async () => {
  const w = world(); w.deployed = D; w.parents[A] = D;
  await refused(w, /deployed dddddddddd has no comparable subscription measurement/);
  w.evidence[D] = JSON.stringify({ ...evidence({ sha: D, fails: [0, 0, 0, 0, 0] }), reply_tree: "R:T1", eval_tree: "E:V1" });
  w.evalTrees[D] = "V2"; w.evidence[D] = JSON.stringify({ ...JSON.parse(w.evidence[D]), eval_tree: "E:V2" });
  await refused(w, /subscription pass rate 98\.9% < deployed 100\.0%/);
  w.evidence[D] = JSON.stringify({ ...evidence({ sha: D, fails: [1, 1, 1, 1, 1] }), reply_tree: "R:T1", eval_tree: "E:V2" });
  const r = await judge(w); eq(r.pass, true, r.text);
});
Deno.test("D-091: the owner's packer turns five run.ts --subscription result files into evidence S3 accepts (one format)", async () => {
  const { packEvidence } = await import("../../scripts/launch/s3-subscription.ts");
  const ev = evidence();
  // run.ts's result shape: the pass fields, items with note (judges' notes), subscription.{api_key_source, sha}.
  const results = ev.passes.map((p: any) => ({ label: p.label, run_at: p.run_at, set: ev.set, brain: ev.brain, harness: ev.harness, judge_model: ev.judge_model,
    judge_model_2: ev.judge_model_2, judge_prompt_sha: ev.judge_prompt_sha, subscription: { mode: "claude CLI", api_key_source: "none", sha: C },
    total: p.total, passed: p.passed, stopped: null, items: p.items.map((x: any) => ({ ...x, failed: [], score: 5, note: "[judge: pass] ok" })) }));
  const packed = packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" });
  const r = await judge(world(packed));
  eq(r.pass, true, r.text);
  results[2].subscription = { mode: "claude CLI", api_key_source: "ANTHROPIC_API_KEY", sha: C };
  await refused(world(packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /pass 3 .*apiKeySource/);
  delete results[1].subscription;
  await refused(world(packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /mode is "api"/);
});
