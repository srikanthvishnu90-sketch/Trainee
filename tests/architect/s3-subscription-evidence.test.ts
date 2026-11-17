// D-091 (owner, 2026-11-16: "Run it on subscription (Recommended)"): S3 accepts a reply-quality measurement made on the
// owner's Claude subscription, committed to ci/brain-eval as append-only sittings evals/career/subscription/<sha>/<run_at>.json,
// with the bar unchanged (five passes of the served brain on the dev set, both judges and the code-counted outcome, EVERY
// pass >= 95%). The FIRST sitting recorded for a (reply-code tree, eval-code tree) pair decides; CI re-derives every verdict
// from its transcripts and raw judge answers; anything it cannot re-derive is refused.
// The evidence here is written by hand from the repository's real dev set and scorer (not by the packer under test).
// In-memory sources, as tests/architect/deploy-standard.test.ts; one test builds a real git branch for liveSources.
// Run: deno test -A --no-check tests/architect/s3-subscription-evidence.test.ts
import assertNode from "node:assert/strict";
import { liveSources, missingMeasurement, S3_RULING_D056, s3, type Sources } from "../../scripts/launch/deploy-standard.ts";
import { REPLY_CODE } from "../../scripts/launch/reply-code.ts";
import { HARNESS } from "../../evals/career/harness.ts";
import { checklistOf, JUDGE_A_MODEL, JUDGE_B_MODEL, judgeFingerprint } from "../../evals/career/judges.ts";
import { brainEnvCheck, type EvalItem, JUDGE_PROMPT } from "../../evals/career/run.ts";
import { RELEASE_CONFIG_PATH } from "../../supabase/functions/agent-chat/release_config.ts";
import { meetsSubscriptionBar, packEvidence, type Sitting, sittingPath, type SubMeasurement, SUBSCRIPTION_DIR, subscriptionMeasurementOf, verifySubscriptionEvidence } from "../../scripts/launch/s3-subscription.ts";
import { parse as parseYaml } from "npm:yaml@2.9.1";

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
const rawA = (it: EvalItem, pass: boolean) => JSON.stringify({ pass, failed: pass ? [] : [it.must[0]], score: pass ? 5 : 2, note: "graded" });
const rawB = (it: EvalItem, pass: boolean) => JSON.stringify({ checks: checklistOf(it).map((c) => ({ n: c.n, met: pass, quote: QUOTE })), score: 4, note: "audited" });
function item(it: EvalItem, pass: boolean, state: unknown = null) {
  return { id: it.id, pass, replies: [`Hi. ${QUOTE}.`], state, judge_raw: [{ judge: "a", text: rawA(it, pass) }, { judge: "b", text: rawB(it, pass) }] };
}
// Pass k of one sitting (k = 1..5, an hour apart) with `fails` failing cases (the first ones).
const pass = (k: number, fails = 0, set: EvalItem[] = SET) => {
  const items = set.map((it, i) => item(it, i >= fails));
  return { label: `s3sub-p${k}`, run_at: `2026-11-16T1${k}:00:00Z`, run_id: `00000000-0000-4000-8000-00000000000${k}`, api_key_source: "none", env_check: brainEnvCheck(), env_overrides: [], stopped: null, total: set.length, passed: set.length - fails, items };
};
function evidence(o: { sha?: string; fails?: number[]; set?: EvalItem[]; reply?: string; eval?: string } = {}): any {
  return {
    kind: "trainee-s3-subscription-evidence", version: 2, mode: "subscription", sha: o.sha ?? C, reply_tree: o.reply ?? "R:T2", eval_tree: o.eval ?? "E:V2",
    set: "dev", brain: "staged", harness: HARNESS, judge_model: JUDGE_A_MODEL, judge_model_2: JUDGE_B_MODEL, judge_prompt_sha: FP,
    passes: (o.fails ?? [0, 1, 0, 1, 0]).map((f, k) => pass(k + 1, f, o.set)),
  };
}
// A sitting recorded at its own path.
const rec = (ev: any): Sitting => ({ path: sittingPath(ev.sha, ev.passes?.[0]?.run_at ?? "none"), text: JSON.stringify(ev) });

interface World { sittings: Sitting[]; trees: Record<string, string>; evalTrees: Record<string, string>; parents: Record<string, string>; sets: Record<string, string>; configs: Record<string, string>; deployed: string; log: string }
function world(...evs: any[]): World {
  return {
    sittings: (evs.length ? evs : [evidence()]).map(rec), trees: { [C]: "T2", [B]: "T2", [A]: "T1", [W]: "T1", [D]: "T1", [X]: "T9" },
    evalTrees: { [C]: "V2", [B]: "V2", [A]: "V1", [W]: "V1", [D]: "V1", [X]: "V2" }, parents: { [C]: B, [B]: A, [A]: W }, sets: {}, configs: {}, deployed: W, log: LOG_HEAD,
  };
}
const isReply = (paths: readonly string[]) => paths.length === REPLY_CODE.length && paths.every((p, i) => p === REPLY_CODE[i]);
const treeOf = (w: World) => async (sha: string, paths: readonly string[]) => isReply(paths) ? (w.trees[sha] ? `R:${w.trees[sha]}` : null) : (w.evalTrees[sha] ? `E:${w.evalTrees[sha]}` : null);
function sources(w: World): Sources {
  const src = {
    checkRuns: async () => [], lastDeployedSha: async () => w.deployed, firstParent: async () => [], pull: async () => null, reviews: async () => [],
    pullFiles: async () => [], ledger: async () => "", scoreLog: async () => w.log, firstAdded: async () => null, secretsAudit: async () => ({ code: 0, out: "" }),
    fileAt: async (sha: string, path: string) => path === RELEASE_CONFIG_PATH ? (w.configs[sha] ?? CONFIG) : path === SET_PATH ? (w.sets[sha] ?? SET_TEXT) : null,
    resolve: async (rev: string) => [A, B, C, W, D, X].find((s) => s.startsWith(rev)) ?? null,
    parent: async (sha: string) => w.parents[sha] ?? null,
    isAncestor: async () => false,
    changed: async (a: string, b: string, paths: readonly string[]) => isReply(paths) ? w.trees[a] !== w.trees[b] : w.evalTrees[a] !== w.evalTrees[b],
    tree: treeOf(w),
    subscriptionSittings: async () => w.sittings,
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
const accepted = async (w: World) => { const r = await judge(w); eq(r.pass, true, r.text); };

Deno.test("D-091: valid subscription evidence (5 passes, worst 37/38 >= 95%) passes S3 and needs no CI measurement", async () => {
  const w = world();
  const r = await judge(w);
  eq(r.pass, true, r.text);
  ok(/SUBSCRIPTION \(D-091\).*worst pass 37\/38 >= 95%/.test(r.text), r.text);
  ok(/apiKeySource none/.test(r.text) && /cccccccccc/.test(r.text), r.text);
  ok(r.text.includes(sittingPath(C, "2026-11-16T11:00:00Z")), r.text);
  const need = await missingMeasurement(sources(w), C, w.deployed);
  eq(need.sha, null, need.why); // the release workflow then dispatches no API measurement
  ok(/D-091/.test(need.why), need.why);
});
Deno.test("D-091: evidence of a same-reply-code ancestor stands for the candidate", async () => {
  await accepted(world(evidence({ sha: B })));
});
Deno.test("D-091 refusal: evidence for a different SHA (not the candidate or a same-reply-code ancestor)", async () => {
  await refused(world(evidence({ sha: X })), /measured 9999999999, not cccccccccc/);
  await refused(world(evidence({ sha: A })), /measured aaaaaaaaaa/); // A is an ancestor, but its reply code differs
});
Deno.test("D-091 refusal: a different reply-code tree, or a different eval-code tree (set, judges, harness)", async () => {
  const w = world(); w.trees[C] = "T3"; w.trees[B] = "T3";
  await refused(w, /reply-code tree/);
  const v = world(); v.evalTrees[C] = "V3";
  await refused(v, /eval-code tree/);
});
Deno.test("D-091 refusal: an ancestor's own trees must be the ones the evidence claims (PROBE6), each side checked alone", async () => {
  const e = world(evidence({ sha: B })); e.evalTrees[B] = "V7"; // B's eval code differs; the evidence claims the candidate's
  await refused(e, /eval-code tree .* is not that of the measured bbbbbbbbbb/);
  // Each side alone, at the verifier (the packer calls it directly; S3 reaches it with B in the lineage).
  const w = world(); const tree = treeOf(w);
  const base = { candidate: C, lineage: [C, B], tree, setText: SET_TEXT, brain: "staged" };
  const ev = evidence({ sha: B });
  w.trees[B] = "T7";
  ok(/reply-code tree .* is not the reply code of the measured bbbbbbbbbb/.test((await verifySubscriptionEvidence(JSON.stringify(ev), { ...base, path: rec(ev).path })).why));
  w.trees[B] = "T2";
  eq((await verifySubscriptionEvidence(JSON.stringify(ev), { ...base, path: rec(ev).path })).why, "");
  w.trees[C] = "T8";
  ok(/not the reply code of the candidate cccccccccc/.test((await verifySubscriptionEvidence(JSON.stringify(ev), { ...base, path: rec(ev).path })).why));
  w.trees[C] = "T2"; w.evalTrees[C] = "V8";
  ok(/eval-code tree .* is not that of the candidate cccccccccc/.test((await verifySubscriptionEvidence(JSON.stringify(ev), { ...base, path: rec(ev).path })).why));
});
Deno.test("D-091 refusal: a missing case, an extra case, a repeated case, and a repeated case alone (nothing missing)", async () => {
  const miss = evidence(); miss.passes[2].items.pop();
  await refused(world(miss), new RegExp(`pass 3 .*missing \\[${SET[SET.length - 1].id}\\]`));
  const extra = evidence(); extra.passes[0].items.push({ ...extra.passes[0].items[0], id: "Z999" });
  await refused(world(extra), /pass 1 .*extra \[Z999\]/);
  const dup = evidence(); dup.passes[1].items[1] = { ...dup.passes[1].items[0] };
  await refused(world(dup), /pass 2 .*missing \[.+\].*1 repeated/);
  const again = evidence(); again.passes[3].items.push({ ...again.passes[3].items[5] }); // every case there, one twice
  await refused(world(again), /pass 4 .*missing \[\], extra \[\], 1 repeated/);
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
  await refused(world(fp), /judge fingerprint .* is not the candidate's/);
  const jm = evidence(); jm.judge_model = "claude-haiku-4-5"; // PROBE9
  await refused(world(jm), /judges claude-haiku-4-5 \+ .* are not the candidate's/);
  const harness = evidence(); harness.harness = "another harness";
  await refused(world(harness), /harness is not the candidate's/);
  const set = evidence(); set.set = "heldout";
  await refused(world(set), /set heldout, not dev/);
});
Deno.test("D-091 refusal: a stopped pass, a pass without a transcript, a brain error (NOT A SCORE, as in CI)", async () => {
  const stopped = evidence(); stopped.passes[2].stopped = "budget reached"; // PROBE8
  await refused(world(stopped), /pass 3 .*stopped \(budget reached\), not a score/);
  const none = evidence(); none.passes[1].items[3].replies = "Hi.";
  await refused(world(none), /pass 2 .*: no transcript/);
  const brainErr = evidence({ fails: [0, 0, 0, 0, 0] }); const x = brainErr.passes[0].items[0]; // PROBE3
  brainErr.passes[0].items[0] = { id: x.id, pass: false, brain_error: "brain error: CLI 500", replies: [], state: null, judge_raw: [] }; brainErr.passes[0].passed = 37;
  await refused(world(brainErr), /pass 1 .*a brain error .*NOT A SCORE/);
});
Deno.test("D-091 refusal: raw judge answers the runner cannot have written; the runner's retry is accepted", async () => {
  const twice = evidence(); const i0 = twice.passes[0].items[0]; // two answers that both parse: makeJudge stops at the first
  i0.judge_raw = [{ judge: "a", text: rawA(SET[0], true) }, { judge: "a", text: rawA(SET[0], true) }, i0.judge_raw[1]];
  await refused(world(twice), /pass 1 .*not what the runner records/);
  const one = evidence(); one.passes[0].items[1].judge_raw = [{ judge: "a", error: "HTTP 500" }, one.passes[0].items[1].judge_raw[1]]; // one failed attempt and no retry
  await refused(world(one), /pass 1 .*not what the runner records/);
  const junk = evidence(); junk.passes[0].items[0].judge_raw.push({ judge: "c", text: "anything" }); // PROBE7
  await refused(world(junk), /pass 1 .*a judge other than a and b/);
  const retry = evidence(); retry.passes[0].items[2].judge_raw = [{ judge: "a", text: "not json" }, { judge: "a", text: rawA(SET[2], true) }, retry.passes[0].items[2].judge_raw[1]];
  await accepted(world(retry));
});
Deno.test("D-091: the code-counted outcome decides beside the judges (a real expected state)", async () => {
  // A dev case whose end state sent a draft: both judges pass it, but checkExpect's default sent: 0 fails it.
  const sent = { account: { outreach: { drafts: [{ status: "sent" }] } } };
  const claimPass = evidence({ fails: [0, 0, 0, 0, 0] }); claimPass.passes[0].items[4] = item(SET[4], true, sent);
  await refused(world(claimPass), /pass 1 .*claims pass, but its transcript and judge answers give fail/);
  // A set whose first case expects one tracked application: the state with it passes, the state without it fails.
  const set = SET.map((it, i) => i === 0 ? { ...it, expect: { tracked: 1 } } : it);
  const tracked = { stores: { trackStore: { rows: [{ company: "Acme" }] } } };
  const good = evidence({ fails: [0, 0, 0, 0, 0], set }); for (const p of good.passes) p.items[0] = item(set[0], true, tracked);
  const w = world(good); w.sets[C] = JSON.stringify({ items: set });
  await accepted(w);
  const bad = structuredClone(good); bad.passes[1].items[0] = item(set[0], true, { stores: { trackStore: { rows: [] } } });
  const wb = world(bad); wb.sets[C] = JSON.stringify({ items: set });
  await refused(wb, /pass 2 .*claims pass, but its transcript and judge answers give fail/);
});
Deno.test("D-091 refusal: a set under 30 cases, at the verifier and at the bar", async () => {
  const small = SET.slice(0, 29);
  const w = world(evidence({ fails: [0, 0, 0, 0, 0], set: small })); w.sets[C] = JSON.stringify({ items: small });
  await refused(w, /the set has 29 cases .*at least 30 distinct/);
  const m: SubMeasurement = { sha: C, path: "p", set: "dev", size: 29, passes: 5, passed: 145, worst: 29, rate: 1, perPass: [29, 29, 29, 29, 29], harness: HARNESS, judges: FP, replyTree: "R:T2", evalTree: "E:V2" };
  eq(meetsSubscriptionBar(m), false);
  eq(meetsSubscriptionBar({ ...m, size: 30, perPass: [30, 30, 30, 30, 30] }), true);
});
Deno.test("B1: one sitting: five copies of one pass, passes weeks apart, out of order or untimed are refused", async () => {
  const copies = evidence(); const p = copies.passes[1]; copies.passes = [p, p, p, p, p]; // PROBE1
  await refused(world(copies), /pass labels repeat/);
  const sameTime = evidence(); sameTime.passes.forEach((q: any) => q.run_at = "2026-11-16T11:00:00Z");
  await refused(world(sameTime), /pass 2 ran at .*not after pass 1/);
  const order = evidence(); [order.passes[2].run_at, order.passes[3].run_at] = [order.passes[3].run_at, order.passes[2].run_at];
  await refused(world(order), /pass 4 ran at .*not after pass 3/);
  const weeks = evidence(); weeks.passes.forEach((q: any, k: number) => q.run_at = `2026-1${k < 3 ? 0 : 1}-0${k + 1}T00:00:00Z`); // PROBE2
  await refused(world(weeks), /more than 24 hours: not one sitting/);
  const day = evidence(); day.passes[4].run_at = "2026-11-17T11:00:00Z"; // 24 h after the first: still one sitting
  await accepted(world(day));
  const late = evidence(); late.passes[4].run_at = "2026-11-17T11:00:01Z";
  await refused(world(late), /more than 24 hours/);
  const untimed = evidence(); untimed.passes[3].run_at = "yesterday";
  await refused(world(untimed), /not an ISO time/);
});
Deno.test("B1: the packer refuses the same file, label, run_at or result twice", async () => {
  const results = resultsOf(evidence());
  const pk = (rs: any[], files?: string[]) => () => packEvidence(rs, { sha: C, replyTree: "R:T2", evalTree: "E:V2", files });
  assertNode.throws(pk(results, ["/r/1.json", "/r/2.json", "/r/3.json", "/r/2.json", "/r/5.json"]), /same file is given twice/);
  assertNode.throws(pk([results[0], results[1], results[2], results[3], results[0]]), /same label is given twice/);
  assertNode.throws(pk([results[0], results[1], results[2], results[3], { ...results[4], run_at: results[0].run_at }]), /same run_at is given twice/);
  assertNode.throws(pk([results[0], results[1], results[2], results[3], { ...results[4], label: results[0].label, run_at: results[0].run_at }]), /given twice/);
  const packed = packEvidence([results[4], results[2], results[0], results[1], results[3]], { sha: C, replyTree: "R:T2", evalTree: "E:V2" }); // sorted by run_at
  await accepted(world(packed));
});
Deno.test("B2: the first sitting recorded for a pair of trees decides; a later one never overrides it", async () => {
  const below = evidence({ fails: [0, 0, 2, 0, 0] }), meets = { ...evidence(), passes: evidence().passes.map((p: any) => ({ ...p, run_at: p.run_at.replace("-16T", "-18T") })) };
  await accepted(world(meets));
  const w = world(below, meets); // a BELOW sitting, then a retry that meets the bar
  await refused(w, /SUBSCRIPTION \(D-091\): staged worst pass 36\/38 < 95%[^]*evals\/career\/subscription\/c{40}\/2026-11-16T11-00-00Z\.json.*the first sitting recorded for this reply code and eval code \(later sittings never replace it\)/);
  eq((await missingMeasurement(sources(w), C, W)).sha, null, "and no API measurement is triggered");
  const incomplete = evidence(); incomplete.passes = incomplete.passes.slice(0, 2); // a sitting given up after two passes
  await refused(world(incomplete, meets), /first subscription sitting .*2 passes, not 5/);
  // An empty commit (C's trees are B's) is the same pair: a BELOW sitting of B decides for C too.
  await refused(world(evidence({ sha: B, fails: [0, 0, 2, 0, 0] }), meets), /worst pass 36\/38 < 95%[^]*b{40}\/2026-11-16T11-00-00Z\.json, measured bbbbbbbbbb.*the first sitting recorded/);
  // A sitting that lies about its trees still counts for its SHA's real pair, and is refused for the lie.
  const lie = evidence({ fails: [0, 0, 2, 0, 0], reply: "R:T9" });
  await refused(world(lie, meets), /first subscription sitting .*reply-code tree R:T9 is not the reply code of the measured/);
  // A sitting recorded at another path than its own is refused (it cannot be the sitting it claims to be).
  const moved = rec(evidence()); moved.path = `evals/career/subscription/${C}/2026-11-20T00-00-00Z.json`;
  const wm = world(); wm.sittings = [moved];
  await refused(wm, /recorded at .*2026-11-20T00-00-00Z\.json, not at its own path/);
  // Another pair's sittings (an older reply code) do not decide for the candidate.
  await accepted(world(evidence({ sha: A, reply: "R:T1", eval: "E:V1", fails: [0, 0, 9, 0, 0] }), meets));
});
Deno.test("B3: every pass must carry the runner's environment check with nothing overridden", async () => {
  const missing = evidence(); delete missing.passes[1].env_check;
  await refused(world(missing), /pass 2 .*environment check is missing or is not the candidate's/);
  const other = evidence(); other.passes[0].env_check = { ...brainEnvCheck(), prefixes: ["CAREER_"] };
  await refused(world(other), /pass 1 .*environment check is missing or is not the candidate's/);
  const over = evidence(); over.passes[3].env_overrides = ["CAREER_MODEL"];
  await refused(world(over), /pass 4 .*the environment overrode \["CAREER_MODEL"\]/);
  const absent = evidence(); delete absent.passes[3].env_overrides;
  await refused(world(absent), /pass 4 .*the environment overrode/);
});
Deno.test("D-091: invalid evidence for the candidate never triggers a CI (API) measurement; no evidence at all is S3 as before", async () => {
  const bad = evidence(); bad.passes[0].api_key_source = "ANTHROPIC_API_KEY";
  const need = await missingMeasurement(sources(world(bad)), C, W);
  eq(need.sha, null, need.why); ok(/D-091.*refused/.test(need.why), need.why);
  const none = world(); none.sittings = [];
  eq((await missingMeasurement(sources(none), C, W)).sha, C); // unchanged: CI measures the candidate
  const r = await judge(none); eq(r.pass, false); ok(/candidate: no staged measurement/.test(r.text), r.text);
});
Deno.test("D-091 against any other deployed SHA: the bar AND no regression from the deployed SHA's own comparable subscription measurement", async () => {
  const w = world(); w.deployed = D; w.parents[A] = D; w.evalTrees[D] = "V2";
  await refused(w, /deployed dddddddddd has no comparable subscription measurement/);
  const dep = (fails: number[], o: { eval?: string; set?: EvalItem[] } = {}) => ({ ...evidence({ sha: D, fails, reply: "R:T1", eval: o.eval ?? "E:V2", set: o.set }) });
  w.sittings = [...world().sittings, rec(dep([0, 0, 0, 0, 0]))];
  await refused(w, /subscription pass rate 98\.9% < deployed 100\.0%/);
  w.sittings = [...world().sittings, rec(dep([1, 1, 1, 1, 1]))];
  await accepted(w);
  // A later, better-for-the-candidate deployed sitting does not replace the deployed side's first one either.
  w.sittings = [...world().sittings, rec(dep([0, 0, 0, 0, 0])), rec({ ...dep([2, 2, 2, 2, 2]), passes: dep([2, 2, 2, 2, 2]).passes.map((p: any) => ({ ...p, run_at: p.run_at.replace("-16T", "-19T") })) })];
  await refused(w, /98\.9% < deployed 100\.0%/);
  // Not comparable: another set size, or other eval code (set, judges, harness, runner) on the deployed side.
  const short = SET.slice(0, 37);
  const ws = world(); ws.deployed = D; ws.parents[A] = D; ws.evalTrees[D] = "V2"; ws.sets[D] = JSON.stringify({ items: short });
  ws.sittings = [...world().sittings, rec(dep([1, 1, 1, 1, 1], { set: short }))];
  await refused(ws, /deployed dddddddddd has no comparable subscription measurement/);
  const we = world(); we.deployed = D; we.parents[A] = D;
  we.sittings = [...world().sittings, rec(dep([1, 1, 1, 1, 1], { eval: "E:V1" }))];
  await refused(we, /deployed dddddddddd has no comparable subscription measurement/);
});
// run.ts's result shape for the passes of one sitting: the pass fields, items with note, subscription.{api_key_source, sha, env}.
function resultsOf(ev: any) {
  return ev.passes.map((p: any) => ({ label: p.label, run_at: p.run_at, set: ev.set, brain: ev.brain, harness: ev.harness, judge_model: ev.judge_model,
    judge_model_2: ev.judge_model_2, judge_prompt_sha: ev.judge_prompt_sha, subscription: { mode: "claude CLI", api_key_source: "none", sha: C, run_id: p.run_id, env_check: brainEnvCheck(), env_overrides: [] },
    total: p.total, passed: p.passed, stopped: null, items: p.items.map((x: any) => ({ ...x, failed: [], score: 5, note: "[judge: pass] ok" })) }));
}
Deno.test("D-091: the owner's packer turns run.ts --subscription result files into evidence S3 accepts (one format)", async () => {
  const results = resultsOf(evidence());
  const packed = packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" });
  await accepted(world(packed));
  results[2].subscription = { ...results[2].subscription, api_key_source: "ANTHROPIC_API_KEY" };
  await refused(world(packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /pass 3 .*apiKeySource/);
  results[2].subscription = { ...results[2].subscription, api_key_source: "none", env_overrides: ["ANTHROPIC_EFFORT"] };
  await refused(world(packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /pass 3 .*overrode/);
  delete results[1].subscription;
  await refused(world(packEvidence(results, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /mode is "api"/);
  // A brain error in a result file is packed as one (and refused as NOT A SCORE).
  const r2 = resultsOf(evidence()); r2[0].items[0] = { id: SET[0].id, pass: false, replies: [], note: "brain error: CLI 500" };
  await refused(world(packEvidence(r2, { sha: C, replyTree: "R:T2", evalTree: "E:V2" })), /brain error .*NOT A SCORE/);
});
Deno.test("B2: liveSources lists every sitting ever added on ci/brain-eval in first-parent order, each as it was added", async () => {
  const dir = await Deno.makeTempDir();
  const g = async (...args: string[]) => {
    const r = await new Deno.Command("git", { args, cwd: dir, stdout: "piped", stderr: "piped", env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).output();
    if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
    return new TextDecoder().decode(r.stdout).trim();
  };
  const put = async (path: string, text: string, date: string) => {
    await Deno.mkdir(`${dir}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${path}`, text);
    await g("add", "-A");
    await new Deno.Command("git", { args: ["commit", "-q", "-m", path], cwd: dir, env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).output();
  };
  await g("init", "-q", "-b", "ci/brain-eval");
  const p1 = `evals/career/subscription/${C}/2026-11-16T11-00-00Z.json`, p2 = `evals/career/subscription/${C}/2026-11-18T11-00-00Z.json`;
  await put("evals/career/SCORE-LOG.md", "log", "2026-11-16T00:00:00Z");
  await put(p1, "FIRST BELOW", "2026-11-17T00:00:00Z");
  await put(p2, "SECOND MEETS", "2020-01-01T00:00:00Z"); // a backdated commit is still second in the branch's order
  await put(p1, "EDITED", "2026-11-19T00:00:00Z"); // an edit does not change what the first sitting said
  await Deno.remove(`${dir}/${p1}`); await g("add", "-A"); await g("commit", "-q", "-m", "delete"); // nor does a deletion
  // A sitting merged in from a side branch counts when the merge lands on ci/brain-eval, not by its (earlier) commit date.
  const p3 = `evals/career/subscription/${B}/2026-11-15T11-00-00Z.json`, p4 = `evals/career/subscription/${B}/2026-11-21T11-00-00Z.json`;
  await put(p4, "MAINLINE FIRST", "2026-11-21T00:00:00Z");
  const tip = await g("rev-parse", "HEAD");
  await g("checkout", "-q", "-b", "side", "HEAD~1");
  await put(p3, "SIDE, DATED EARLIER", "2026-11-15T00:00:00Z");
  await g("checkout", "-q", "ci/brain-eval"); eq(await g("rev-parse", "HEAD"), tip);
  await new Deno.Command("git", { args: ["merge", "-q", "--no-ff", "-m", "merge side", "side"], cwd: dir, env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).output();
  const cwd = Deno.cwd();
  try {
    Deno.chdir(dir);
    const src = liveSources({ repo: "o/r", token: "t", scoreRef: "ci/brain-eval" });
    eq(await src.subscriptionSittings!(), [{ path: p1, text: "FIRST BELOW" }, { path: p2, text: "SECOND MEETS" }, { path: p4, text: "MAINLINE FIRST" }, { path: p3, text: "SIDE, DATED EARLIER" }]);
    eq(await liveSources({ repo: "o/r", token: "t", scoreRef: "no/such-ref" }).subscriptionSittings!(), []);
  } finally { Deno.chdir(cwd); }
});
Deno.test("D-091 refusal (mutation review): an old evidence version, judge B's model, a set with a repeated id, a non-ISO time, three judge answers, no reply code", async () => {
  const v1 = evidence(); v1.version = 1;
  await refused(world(v1), /not trainee-s3-subscription-evidence version 2/);
  const jb = evidence(); jb.judge_model_2 = "claude-haiku-4-5";
  await refused(world(jb), /judges .* \+ claude-haiku-4-5 are not the candidate's/);
  const dupSet = [...SET.slice(0, 37), { ...SET[0] }];
  const ws = world(evidence({ fails: [0, 0, 0, 0, 0], set: dupSet })); ws.sets[C] = JSON.stringify({ items: dupSet });
  await refused(ws, /the set has 38 cases \(37 distinct\)/);
  const rfc = evidence(); rfc.passes[2].run_at = "Mon, 16 Nov 2026 13:30:00 GMT"; // Date.parse reads it; run.ts never writes it
  await refused(world(rfc), /not an ISO time/);
  const three = evidence(); const i0 = three.passes[0].items[0];
  i0.judge_raw = [{ judge: "a", text: "x" }, { judge: "a", text: "y" }, { judge: "a", text: rawA(SET[0], true) }, i0.judge_raw[1]];
  await refused(world(three), /pass 1 .*not what the runner records/);
  // A measured SHA without reply code (and a candidate without it) is never a measurement, whatever the evidence says.
  const w = world(); w.trees = {}; const ev = { ...evidence(), reply_tree: null };
  ok(/reply-code tree .* is not the reply code of the measured cccccccccc/.test((await verifySubscriptionEvidence(JSON.stringify(ev), { path: rec(ev).path, candidate: C, lineage: [C], tree: treeOf(w), setText: SET_TEXT, brain: "staged" })).why));
});

Deno.test("B1 (review of #854): a sitting pushed to ci/brain-eval never starts the paid brain eval (the push paths exclude it)", () => {
  const wf: any = parseYaml(Deno.readTextFileSync(`${ROOT}/.github/workflows/brain-eval.yml`));
  const paths: string[] = wf.on.push.paths;
  // GitHub's rule: the patterns are read in order and the last one that matches a file decides; a "!" pattern excludes.
  const glob = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
  const runs = (file: string) => paths.reduce((on, p) => p.startsWith("!") ? (glob(p.slice(1)).test(file) ? false : on) : (glob(p).test(file) ? true : on), false);
  ok(paths.includes("!evals/career/subscription/**") && paths.indexOf("!evals/career/subscription/**") > paths.indexOf("evals/career/**"), JSON.stringify(paths));
  eq(runs(sittingPath(C, "2026-11-16T11:00:00Z")), false, "a sitting alone starts no eval");
  eq(runs(`${SUBSCRIPTION_DIR}/${C}/x.json`), false);
  eq(runs("evals/career/run.ts"), true, "the eval code still does");
  eq(runs("evals/career/SCORE-LOG.md"), true);
});
Deno.test("B4 (review of #854): an existing CI measurement beats a subscription sitting; the deployed side is verified with the deployed brain", async () => {
  // Five qualifying CI passes of the candidate at 38/38: S3 judges them (D-056 here), never the BELOW sitting beside them.
  const row = (passed: number) => `| 2026-11-16 10:00:00 | ${C.slice(0, 7)} | dev | staged | 38 | ${passed} | ${(passed / 38 * 100).toFixed(1)}% | claude x; both-pass; judge=claude | no | 4242; harness: ${HARNESS} |\n`;
  const ci = world(evidence({ fails: [0, 0, 9, 0, 0] })); ci.log = LOG_HEAD + row(38).repeat(5);
  const r = await judge(ci); eq(r.pass, true, r.text); ok(!/SUBSCRIPTION/.test(r.text) && /OWNER RULING D-056/.test(r.text), r.text);
  // A deployed SHA that served the router: its own sitting is verified against the router, the brain it served.
  const routerConfig = CONFIG.replace(/^export const PRODUCTION_BRAIN(\s*:\s*ServedBrain)?\s*=\s*"staged"\s*;/m, 'export const PRODUCTION_BRAIN: ServedBrain = "router";');
  ok(routerConfig !== CONFIG);
  const w = world(); w.deployed = D; w.parents[A] = D; w.evalTrees[D] = "V2"; w.configs[D] = routerConfig;
  w.sittings = [...world().sittings, rec({ ...evidence({ sha: D, fails: [1, 1, 1, 1, 1], reply: "R:T1", eval: "E:V2" }), brain: "router" })];
  await accepted(w);
});
Deno.test("B4 (review of #854): judge B is re-scored on the LAST reply; a missing end state is null; a non-sitting file is skipped; no reply code is no pair", async () => {
  const early = evidence({ fails: [0, 0, 0, 0, 0] }); early.passes[0].items[3].replies = [`Hi. ${QUOTE}.`, "Anything else?"];
  await refused(world(early), /pass 1 .*claims pass, but its transcript and judge answers give fail/);
  // A case without a recorded state: judge B's quote "null" is found in the state read as null, as the runner judged it.
  const nul = evidence({ fails: [0, 0, 0, 0, 0] });
  for (const p of nul.passes) { const it = SET[2]; p.items[2] = { ...item(it, true), replies: ["Hi."], judge_raw: [{ judge: "a", text: rawA(it, true) }, { judge: "b", text: JSON.stringify({ checks: checklistOf(it).map((c) => ({ n: c.n, met: true, quote: "null" })), score: 4, note: "x" }) }] }; delete p.items[2].state; }
  await accepted(world(nul));
  const notes = world(); notes.sittings = [{ path: `${SUBSCRIPTION_DIR}/README.md`, text: "how to push a sitting" }, ...notes.sittings];
  await accepted(notes);
  // A JSON copy of a BELOW sitting kept at a path that is not a sitting's is not a sitting: it decides nothing.
  const copy = world(); copy.sittings = [{ path: `${SUBSCRIPTION_DIR}/${C}/notes/below.json`, text: JSON.stringify(evidence({ fails: [0, 0, 9, 0, 0] })) }, ...copy.sittings];
  await accepted(copy);
  // A candidate without reply code: no pair, so no sitting decides (not even one that claims null trees).
  const w = world(); const src = sources(w) as any; const tree = treeOf(w);
  src.tree = async (sha: string, p: readonly string[]) => sha === C ? null : await tree(sha, p);
  w.sittings = [rec({ ...evidence(), reply_tree: null, eval_tree: null })];
  eq((await subscriptionMeasurementOf(src, C, [C], "staged")).found, false);
  // The bar itself needs five passes.
  const m: SubMeasurement = { sha: C, path: "p", set: "dev", size: 38, passes: 4, passed: 152, worst: 38, rate: 1, perPass: [38, 38, 38, 38], harness: HARNESS, judges: FP, replyTree: "R:T2", evalTree: "E:V2" };
  eq(meetsSubscriptionBar(m), false);
});
Deno.test("PROBE1b: one pass copied under five labels and times keeps its run id, and is refused", async () => {
  const ev = evidence(); const p = ev.passes[1];
  ev.passes = [1, 2, 3, 4, 5].map((k) => ({ ...p, label: `s3sub-p${k}`, run_at: `2026-11-16T1${k}:00:00Z` }));
  await refused(world(ev), /pass run ids are missing or repeat/);
  const none = evidence(); delete none.passes[3].run_id;
  await refused(world(none), /pass run ids are missing or repeat/);
});
