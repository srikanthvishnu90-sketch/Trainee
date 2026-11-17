// S3 EVIDENCE FROM THE OWNER'S SUBSCRIPTION (D-091; owner, 2026-11-16, in the architect's chat, answering a direct question:
// "Run it on subscription (Recommended)"). The release reply-quality check may be measured on the owner's Claude subscription
// (evals/career/run.ts --subscription, D-089) instead of an API run in CI. The bar does not move: the served brain, the dev
// set, both judges and the code-counted outcome, five passes, EVERY pass at least 95% in exact counts (D-038a, D-056).
//
// CI cannot make this measurement (the claude CLI runs only on the owner's machine), so the owner makes it and commits every
// SITTING to ci/brain-eval, append-only, as evals/career/subscription/<40-hex SHA>/<first pass's run_at, ":" as "-">.json,
// whatever its verdict (BELOW the bar, incomplete or refused included). S3 does not pick among sittings: the FIRST sitting
// recorded on ci/brain-eval (first-parent order of the commits that added the files, each read as it was added) whose
// reply-code tree and eval-code tree, claimed or actual, are the candidate's decides S3 for that pair of trees; a later
// sitting for the same pair never overrides it, and a commit that changes neither tree (an empty commit, a docs change) is
// the same pair. CI does not trust its verdicts either: it re-derives every one. verifySubscriptionEvidence refuses unless
//   - the sitting names the candidate or a same-reply-code first-parent ancestor (deploy-standard.ts sameReplyCode), is
//     recorded at its own path, and the reply-code tree (reply-code.ts, the same digest as deploy-standard's tree) AND the
//     eval-code tree (EVAL_CODE: the set, the judges, the harness, the runner, the CLI bridge) recorded in it equal that
//     SHA's and the candidate's;
//   - it is a subscription run (mode "subscription") whose every pass recorded the CLI's apiKeySource "none" and the
//     runner's environment check (run.ts brainEnvCheck, nothing overridden: D-089 B3);
//   - the brain is the one the candidate serves, the harness and the judge fingerprint are the candidate's own;
//   - it is ONE sitting: exactly five passes with distinct labels and run ids and strictly increasing run_at, all within 24 hours;
//   - each pass is not stopped, its item ids are exactly the dev set's at the candidate (no case missing, extra or repeated),
//     with the brain's replies, the end state and every raw judge answer of each case;
//   - re-judged by code from those raw answers (run.ts parseJudge, judges.ts parseJudgeB, harness.ts checkExpect/outcomeOf,
//     with run.ts makeJudge's retry rule), every case's verdict and every pass's count equal what the evidence claims, and no
//     judge or brain errored (either makes a pass NOT A SCORE, as in CI: score-log.ts, verdict.ts problems).
// What CI cannot check: that the replies and judge answers came from the model (a CI run's rows rest on the same trust:
// whoever can push ci/brain-eval), and a sitting that was never pushed (it cannot see it). Both limits are stated in D-091.
//
//   deno run -A scripts/launch/s3-subscription.ts --sha <40-hex> --out <dir> <result1.json> [... <result5.json>]
//     packs the result files of ONE sitting of `run.ts --subscription` (one to five; fewer is an incomplete sitting, still
//     recorded) into <dir>/<sittingPath>, refuses the same file, label or run_at twice, checks it exactly as S3 will, and
//     prints the verdict (docs/launch/TRAINEE-GO-LIVE.md, "S3 on the owner's subscription"). Push what it writes, always.
import { REPLY_CODE } from "./reply-code.ts";
import { checkExpect, HARNESS, outcomeOf } from "../../evals/career/harness.ts";
import { JUDGE_A_MODEL, JUDGE_A_SYSTEM, JUDGE_B_MODEL, judgeFingerprint, parseJudgeB } from "../../evals/career/judges.ts";
import { brainEnvCheck, type EvalItem, JUDGE_PROMPT, parseJudge } from "../../evals/career/run.ts";

export const SUBSCRIPTION_DIR = "evals/career/subscription";
// One sitting's file: append-only, one per sitting, never edited (S3 reads each file as the commit that added it wrote it).
export const sittingPath = (sha: string, runAt: string) => `${SUBSCRIPTION_DIR}/${sha}/${String(runAt).replace(/:/g, "-")}.json`;
const SITTING_FILE = /^evals\/career\/subscription\/([0-9a-f]{40})\/[^/]+\.json$/;
export const EVIDENCE_KIND = "trainee-s3-subscription-evidence";
export const EVIDENCE_VERSION = 2;
export const S3_SUBSCRIPTION = { set: "dev", setPath: "evals/career/heldout-live.json", passes: 5, barPercent: 95, minSetSize: 30, sittingHours: 24 } as const;
// The code that makes and scores the measurement besides the reply code: a change here between the measured SHA and the
// candidate means the evidence was scored by other rules, so it does not count.
export const EVAL_CODE: readonly string[] = ["evals/career/run.ts", "evals/career/judges.ts", "evals/career/harness.ts", S3_SUBSCRIPTION.setPath, "evals/subscription/claude_cli.ts"];
const SHA40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const short = (s: string) => s.slice(0, 10);

export type RawJudge = { judge: "a" | "b"; text?: string; error?: string };
export interface EvidenceItem { id: string; pass: boolean; replies: string[]; state: unknown; brain_error?: string; judge_raw: RawJudge[] }
export interface EvidencePass { label: string; run_at: string; run_id: string; api_key_source: string; env_check: unknown; env_overrides: unknown; stopped: string | null; total: number; passed: number; items: EvidenceItem[] }
export interface Evidence { kind: string; version: number; mode: string; sha: string; reply_tree: string; eval_tree: string; set: string; brain: string; harness: string; judge_model: string; judge_model_2: string; judge_prompt_sha: string; passes: EvidencePass[] }
export interface SubMeasurement { sha: string; path: string; set: string; size: number; passes: number; passed: number; worst: number; rate: number; perPass: number[]; harness: string; judges: string; replyTree: string; evalTree: string }
export type Tree = (sha: string, paths: readonly string[]) => Promise<string | null>;
// A sitting file as the commit that added it to ci/brain-eval wrote it; a list of them is oldest first (first-parent order).
export interface Sitting { path: string; text: string }

// The digest deploy-standard.ts liveSources().tree uses: every blob under the paths (mode, id, path); none at sha: null.
export async function gitTree(sha: string, paths: readonly string[]): Promise<string | null> {
  const r = await new Deno.Command("git", { args: ["ls-tree", "-r", "--full-tree", sha, "--", ...paths], stdout: "piped", stderr: "piped" }).output();
  if (r.code !== 0) throw new Error(`git ls-tree ${short(sha)} failed`);
  const out = new TextDecoder().decode(r.stdout);
  if (!out.trim()) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(out));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One judge's verdict from its raw answers, by makeJudge's rule: up to two attempts, the first that parses decides, nothing
// after it; two failed attempts are a judge error. Any other shape was not produced by the runner.
function verdictOf(raw: RawJudge[], parse: (text: string) => { pass: boolean }): { pass: boolean } | "error" | "malformed" {
  if (raw.length < 1 || raw.length > 2) return "malformed";
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i].text !== "string") continue;
    let v: { pass: boolean } | null = null;
    try { v = parse(raw[i].text!); } catch { /* not a verdict: the runner tried again */ }
    if (v) return i === raw.length - 1 ? v : "malformed";
  }
  return raw.length === 2 ? "error" : "malformed";
}

export async function verifySubscriptionEvidence(text: string, o: { path: string; candidate: string; lineage: string[]; tree: Tree; setText: string | null; brain: string }): Promise<{ m: SubMeasurement | null; why: string }> {
  const no = (why: string) => ({ m: null, why });
  let ev: Evidence;
  try { ev = JSON.parse(text); } catch { return no("the evidence file is not JSON"); }
  if (ev?.kind !== EVIDENCE_KIND || ev.version !== EVIDENCE_VERSION) return no(`not ${EVIDENCE_KIND} version ${EVIDENCE_VERSION}`);
  if (ev.mode !== "subscription") return no(`mode is ${JSON.stringify(ev.mode)}, not "subscription"`);
  if (!SHA40.test(String(ev.sha)) || !o.lineage.includes(ev.sha)) return no(`it measured ${String(ev.sha).slice(0, 10)}, not ${short(o.candidate)} or a same-reply-code ancestor`);
  const [rt, rc] = [await o.tree(ev.sha, REPLY_CODE), await o.tree(o.candidate, REPLY_CODE)];
  if (!rt || ev.reply_tree !== rt) return no(`its reply-code tree ${String(ev.reply_tree).slice(0, 12)} is not the reply code of the measured ${short(ev.sha)}`);
  if (ev.reply_tree !== rc) return no(`its reply-code tree ${String(ev.reply_tree).slice(0, 12)} is not the reply code of the candidate ${short(o.candidate)}`);
  const [et, ec] = [await o.tree(ev.sha, EVAL_CODE), await o.tree(o.candidate, EVAL_CODE)];
  if (!et || ev.eval_tree !== et) return no(`its eval-code tree (set, judges, harness, runner) ${String(ev.eval_tree).slice(0, 12)} is not that of the measured ${short(ev.sha)}`);
  if (ev.eval_tree !== ec) return no(`its eval-code tree (set, judges, harness, runner) ${String(ev.eval_tree).slice(0, 12)} is not that of the candidate ${short(o.candidate)}`);
  if (ev.set !== S3_SUBSCRIPTION.set) return no(`set ${ev.set}, not ${S3_SUBSCRIPTION.set}`);
  if (ev.brain !== o.brain) return no(`brain ${ev.brain}, but the candidate serves ${o.brain}`);
  if (ev.harness !== HARNESS) return no("harness is not the candidate's");
  const fp = await judgeFingerprint(JUDGE_PROMPT, { a: JUDGE_A_MODEL, b: JUDGE_B_MODEL });
  if (ev.judge_model !== JUDGE_A_MODEL || ev.judge_model_2 !== JUDGE_B_MODEL) return no(`judges ${ev.judge_model} + ${ev.judge_model_2} are not the candidate's ${JUDGE_A_MODEL} + ${JUDGE_B_MODEL}`);
  if (ev.judge_prompt_sha !== fp) return no(`judge fingerprint ${ev.judge_prompt_sha} is not the candidate's ${fp}`);
  let set: EvalItem[];
  try { set = JSON.parse(o.setText ?? "").items; } catch { return no(`${S3_SUBSCRIPTION.setPath} at ${short(o.candidate)} cannot be read`); }
  const byId = new Map(set.map((it) => [it.id, it]));
  const size = set.length;
  if (byId.size !== size || size < S3_SUBSCRIPTION.minSetSize) return no(`the set has ${size} cases (${byId.size} distinct); at least ${S3_SUBSCRIPTION.minSetSize} distinct are needed`);
  if (!Array.isArray(ev.passes) || ev.passes.length !== S3_SUBSCRIPTION.passes) return no(`${Array.isArray(ev.passes) ? ev.passes.length : 0} passes, not ${S3_SUBSCRIPTION.passes}`);
  if (o.path !== sittingPath(ev.sha, ev.passes[0]?.run_at)) return no(`it is recorded at ${o.path}, not at its own path ${sittingPath(ev.sha, ev.passes[0]?.run_at)}`);
  // ONE sitting (review of #853, B1): five distinct passes, run one after another within 24 hours, never chosen from more.
  const labels = ev.passes.map((p) => p?.label), times = ev.passes.map((p) => String(p?.run_at)), runIds = ev.passes.map((p) => p?.run_id);
  if (new Set(labels).size !== labels.length) return no(`pass labels repeat (${labels.join(", ")}): five copies of one pass are not five passes`);
  // run.ts writes a random run_id for every pass: a pass copied under new labels and times keeps its run_id.
  if (runIds.some((r) => typeof r !== "string" || !UUID.test(r)) || new Set(runIds).size !== runIds.length) return no(`pass run ids are missing or repeat (${runIds.join(", ")}): five copies of one pass are not five passes`);
  const ms = times.map((t) => ISO.test(t) ? Date.parse(t) : NaN);
  if (ms.some((t) => !Number.isFinite(t))) return no(`a pass's run_at is not an ISO time (${times.join(", ")})`);
  for (let k = 1; k < ms.length; k++) if (!(ms[k] > ms[k - 1])) return no(`pass ${k + 1} ran at ${times[k]}, not after pass ${k} (${times[k - 1]}): the passes must be distinct and in order`);
  if (ms[ms.length - 1] - ms[0] > S3_SUBSCRIPTION.sittingHours * 3600_000) return no(`the passes span ${times[0]} to ${times[times.length - 1]}, more than ${S3_SUBSCRIPTION.sittingHours} hours: not one sitting`);
  const envRule = JSON.stringify(brainEnvCheck());
  const perPass: number[] = [];
  for (const [k, p] of ev.passes.entries()) {
    const at = `pass ${k + 1} (${p?.label})`;
    if (p?.api_key_source !== "none") return no(`${at}: apiKeySource ${JSON.stringify(p?.api_key_source)}, not "none" (not a subscription run)`);
    if (JSON.stringify(p.env_check) !== envRule) return no(`${at}: the runner's environment check is missing or is not the candidate's (run.ts brainEnvCheck, D-089)`);
    if (!Array.isArray(p.env_overrides) || p.env_overrides.length) return no(`${at}: the environment overrode ${JSON.stringify(p.env_overrides)}, so it did not measure the committed code`);
    if (p.stopped) return no(`${at}: stopped (${p.stopped}), not a score`);
    const ids = (p.items ?? []).map((x) => x?.id);
    const seen = new Set(ids);
    const missing = set.filter((it) => !seen.has(it.id)).map((it) => it.id), extra = ids.filter((id) => !byId.has(id));
    if (missing.length || extra.length || seen.size !== ids.length) return no(`${at}: cases are not the set's: missing [${missing.join(", ")}], extra [${extra.join(", ")}], ${ids.length - seen.size} repeated`);
    let passed = 0;
    for (const x of p.items) {
      const item = byId.get(x.id)!;
      // A brain error is NOT A SCORE, as in CI (verdict.ts problems: "brain errors"), never a counted fail.
      if (x.brain_error !== undefined) return no(`${at} ${x.id}: a brain error (${String(x.brain_error).slice(0, 80)}), so the pass is NOT A SCORE`);
      if (!Array.isArray(x.replies) || x.replies.some((r) => typeof r !== "string")) return no(`${at} ${x.id}: no transcript`);
      const reply = x.replies[x.replies.length - 1] ?? "", state = x.state ?? null, raw = Array.isArray(x.judge_raw) ? x.judge_raw : [];
      if (raw.some((j) => j?.judge !== "a" && j?.judge !== "b")) return no(`${at} ${x.id}: the raw judge answers are not what the runner records (a judge other than a and b)`);
      const a = verdictOf(raw.filter((j) => j.judge === "a"), parseJudge);
      const b = verdictOf(raw.filter((j) => j.judge === "b"), (t) => parseJudgeB(t, item, reply, state));
      if (a === "malformed" || b === "malformed") return no(`${at} ${x.id}: the raw judge answers are not what the runner records`);
      if (a === "error" || b === "error") return no(`${at} ${x.id}: a judge errored, so the pass is NOT A SCORE`);
      const pass = a.pass && b.pass && checkExpect(item.expect, outcomeOf(state)).ok;
      if (x.pass !== pass) return no(`${at} ${x.id}: claims ${x.pass ? "pass" : "fail"}, but its transcript and judge answers give ${pass ? "pass" : "fail"}`);
      if (pass) passed++;
    }
    if (p.total !== size || p.passed !== passed) return no(`${at}: claims ${p.passed}/${p.total}, but its transcripts give ${passed}/${size}`);
    perPass.push(passed);
  }
  const sum = perPass.reduce((s, n) => s + n, 0);
  return { m: { sha: ev.sha, path: o.path, set: ev.set, size, passes: perPass.length, passed: sum, worst: Math.min(...perPass), rate: sum / size / perPass.length, perPass, harness: ev.harness, judges: ev.judge_prompt_sha, replyTree: ev.reply_tree, evalTree: ev.eval_tree }, why: "" };
}

export const meetsSubscriptionBar = (m: SubMeasurement) => m.passes === S3_SUBSCRIPTION.passes && m.size >= S3_SUBSCRIPTION.minSetSize && m.perPass.every((n) => n * 100 >= m.size * S3_SUBSCRIPTION.barPercent);

// The sitting that decides S3 for sha (review of #853, B2): the FIRST sitting recorded on ci/brain-eval whose reply-code and
// eval-code trees, as it claims them or as its SHA actually has them, are sha's. It is verified, and its verdict stands:
// a later sitting for the same pair is never read. found=false: no sitting was ever recorded for this pair.
export async function subscriptionMeasurementOf(
  src: { subscriptionSittings?(): Promise<Sitting[]>; fileAt(sha: string, path: string): Promise<string | null>; tree: Tree },
  sha: string, lineage: string[], brain: string,
): Promise<{ found: boolean; m: SubMeasurement | null; why: string }> {
  if (!src.subscriptionSittings) return { found: false, m: null, why: "" };
  const pair = [await src.tree(sha, REPLY_CODE), await src.tree(sha, EVAL_CODE)];
  if (!pair[0] || !pair[1]) return { found: false, m: null, why: "" };
  const isPair = (x: unknown[] | null) => !!x && x[0] === pair[0] && x[1] === pair[1];
  for (const s of await src.subscriptionSittings()) {
    const file = SITTING_FILE.exec(s.path);
    if (!file) continue; // not a sitting file
    let claimed: unknown[] | null = null, actual: unknown[] | null = null;
    try { const ev = JSON.parse(s.text); claimed = [ev?.reply_tree, ev?.eval_tree]; } catch { /* its SHA's trees decide whether it is this pair's */ }
    try { actual = [await src.tree(file[1], REPLY_CODE), await src.tree(file[1], EVAL_CODE)]; } catch { /* a SHA this checkout does not have */ }
    if (!isPair(claimed) && !isPair(actual)) continue;
    const r = await verifySubscriptionEvidence(s.text, { path: s.path, candidate: sha, lineage, tree: src.tree, setText: await src.fileAt(sha, S3_SUBSCRIPTION.setPath), brain });
    return { found: true, m: r.m, why: r.m ? "" : `the first subscription sitting recorded for this reply code and eval code, ${s.path} (D-091), is refused, and a later sitting does not replace it: ${r.why}` };
  }
  return { found: false, m: null, why: "" };
}

// ------------------------------------------------------------------------------------------------ packing (the owner's machine)
// One sitting's result files, in the order they ran. Refuses the same file, label, run_at or content twice (B1).
export function packEvidence(results: any[], o: { sha: string; replyTree: string; evalTree: string; files?: string[] }): Evidence {
  const dup = (xs: unknown[]) => xs.find((x, i) => xs.indexOf(x) !== i);
  for (const [what, xs] of [["file", o.files ?? []], ["label", results.map((r) => r?.label)], ["run_at", results.map((r) => r?.run_at)], ["result", results.map((r) => JSON.stringify(r))]] as [string, unknown[]][]) {
    const d = dup(xs);
    if (d !== undefined) throw new Error(`refused: the same ${what} is given twice${what === "result" ? "" : ` (${String(d).slice(0, 80)})`}: a sitting's passes are distinct runs`);
  }
  const sorted = [...results].sort((a, b) => String(a?.run_at).localeCompare(String(b?.run_at)));
  const r0 = sorted[0] ?? {};
  return {
    kind: EVIDENCE_KIND, version: EVIDENCE_VERSION, mode: sorted.every((r) => r?.subscription) ? "subscription" : "api", sha: o.sha, reply_tree: o.replyTree, eval_tree: o.evalTree,
    set: r0.set, brain: r0.brain, harness: r0.harness, judge_model: r0.judge_model, judge_model_2: r0.judge_model_2, judge_prompt_sha: r0.judge_prompt_sha,
    passes: sorted.map((r) => ({
      label: r.label, run_at: r.run_at, run_id: r.subscription?.run_id ?? null, api_key_source: r.subscription?.api_key_source ?? "unknown", env_check: r.subscription?.env_check ?? null, env_overrides: r.subscription?.env_overrides ?? null,
      stopped: r.stopped ?? null, total: r.total, passed: r.passed,
      items: (r.items ?? []).map((x: any) => ({ id: x.id, pass: !!x.pass, replies: x.replies ?? [], state: x.state ?? null,
        ...(/^brain error/.test(String(x.note ?? "")) ? { brain_error: String(x.note) } : {}), judge_raw: x.judge_raw ?? [] })),
    })),
  };
}

if (import.meta.main) {
  const a = [...Deno.args], opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
  const sha = opt("--sha") ?? "", out = opt("--out") ?? "";
  if (!SHA40.test(sha) || !out || a.length < 1 || a.length > S3_SUBSCRIPTION.passes) { console.error(`usage: s3-subscription.ts --sha <40-hex> --out <dir> <1 to ${S3_SUBSCRIPTION.passes} result files of one sitting>`); Deno.exit(2); }
  const files = await Promise.all(a.map((f) => Deno.realPath(f)));
  const results = await Promise.all(files.map(async (f) => JSON.parse(await Deno.readTextFile(f))));
  const bad = results.filter((r) => r?.subscription?.sha !== sha).map((r) => r?.label);
  if (bad.length) { console.error(`refused: ${bad.join(", ")} did not measure ${sha} (run every pass on a clean checkout of it)`); Deno.exit(1); }
  const git = async (args: string[]) => new TextDecoder().decode((await new Deno.Command("git", { args, stdout: "piped" }).output()).stdout);
  const { parseProductionBrain, RELEASE_CONFIG_PATH } = await import("../../supabase/functions/agent-chat/release_config.ts");
  let ev: Evidence;
  try { ev = packEvidence(results, { sha, replyTree: (await gitTree(sha, REPLY_CODE)) ?? "", evalTree: (await gitTree(sha, EVAL_CODE)) ?? "", files }); } catch (e) { console.error((e as Error).message); Deno.exit(1); }
  const text = JSON.stringify(ev);
  const path = sittingPath(sha, ev.passes[0].run_at);
  const r = await verifySubscriptionEvidence(text, { path, candidate: sha, lineage: [sha], tree: gitTree, setText: await git(["show", `${sha}:${S3_SUBSCRIPTION.setPath}`]), brain: parseProductionBrain(await git(["show", `${sha}:${RELEASE_CONFIG_PATH}`])) });
  const file = `${out}/${path}`;
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(file, text);
  const push = `push it to ci/brain-eval whatever the verdict: the first sitting recorded for this reply code and eval code decides S3 (D-091)`;
  if (!r.m) { console.log(`S3 subscription sitting for ${short(sha)}: REFUSED: ${r.why}\nwritten: ${file}\n${push}`); Deno.exit(1); }
  const okBar = meetsSubscriptionBar(r.m);
  console.log(`S3 subscription sitting for ${short(sha)}: passes ${r.m.perPass.join(", ")} of ${r.m.size}; worst ${r.m.worst}/${r.m.size} ${okBar ? ">=" : "<"} ${S3_SUBSCRIPTION.barPercent}% -> ${okBar ? "MEETS" : "BELOW"} the bar\nwritten: ${file}\n${push}`);
  Deno.exit(okBar ? 0 : 1);
}
