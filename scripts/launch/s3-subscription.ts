// S3 EVIDENCE FROM THE OWNER'S SUBSCRIPTION (D-091; owner, 2026-11-16, in the architect's chat, answering a direct question:
// "Run it on subscription (Recommended)"). The release reply-quality check may be measured on the owner's Claude subscription
// (evals/career/run.ts --subscription, D-089) instead of an API run in CI. The bar does not move: the served brain, the dev
// set, both judges and the code-counted outcome, five passes, EVERY pass at least 95% in exact counts (D-038a, D-056).
//
// CI cannot make this measurement (the claude CLI runs only on the owner's machine), so the owner makes it and commits the
// evidence to ci/brain-eval as evals/career/subscription/<40-hex SHA>.json. CI does not trust its verdicts: it re-derives
// every one. verifySubscriptionEvidence below refuses unless
//   - the evidence names the candidate or a same-reply-code first-parent ancestor (deploy-standard.ts sameReplyCode), and the
//     reply-code tree (reply-code.ts, the same digest as deploy-standard's tree) AND the eval-code tree (EVAL_CODE: the set,
//     the judges, the harness, the runner, the CLI bridge) recorded in it equal both that SHA's and the candidate's;
//   - it is a subscription run (mode "subscription") whose every pass recorded the CLI's apiKeySource "none";
//   - the brain is the one the candidate serves, the harness and the judge fingerprint are the candidate's own;
//   - it has exactly five passes, each not stopped, whose item ids are exactly the dev set's at the candidate (no case missing,
//     extra or repeated), with the brain's replies, the end state and every raw judge answer of each case;
//   - re-judged by code from those raw answers (run.ts parseJudge, judges.ts parseJudgeB, harness.ts checkExpect/outcomeOf,
//     with run.ts makeJudge's retry rule), every case's verdict and every pass's count equal what the evidence claims, and no
//     judge errored (a judge error makes a pass NOT A SCORE, as in the score log).
// What CI cannot check: that the replies and judge answers came from the model (a CI run's rows rest on the same trust:
// whoever can push ci/brain-eval). That limit is stated in D-091.
//
//   deno run -A scripts/launch/s3-subscription.ts --sha <40-hex> --out <dir> <result1.json> ... <result5.json>
//     packs five evals/career/results/*.json of `run.ts --subscription` into <dir>/evals/career/subscription/<sha>.json,
//     checks it exactly as S3 will, and prints the verdict (docs/launch/TRAINEE-GO-LIVE.md, "S3 on the owner's subscription").
import { REPLY_CODE } from "./reply-code.ts";
import { checkExpect, HARNESS, outcomeOf } from "../../evals/career/harness.ts";
import { JUDGE_A_MODEL, JUDGE_A_SYSTEM, JUDGE_B_MODEL, judgeFingerprint, parseJudgeB } from "../../evals/career/judges.ts";
import { type EvalItem, JUDGE_PROMPT, parseJudge } from "../../evals/career/run.ts";

export const SUBSCRIPTION_DIR = "evals/career/subscription";
export const evidencePath = (sha: string) => `${SUBSCRIPTION_DIR}/${sha}.json`;
export const EVIDENCE_KIND = "trainee-s3-subscription-evidence";
export const S3_SUBSCRIPTION = { set: "dev", setPath: "evals/career/heldout-live.json", passes: 5, barPercent: 95, minSetSize: 30 } as const;
// The code that makes and scores the measurement besides the reply code: a change here between the measured SHA and the
// candidate means the evidence was scored by other rules, so it does not count.
export const EVAL_CODE: readonly string[] = ["evals/career/run.ts", "evals/career/judges.ts", "evals/career/harness.ts", S3_SUBSCRIPTION.setPath, "evals/subscription/claude_cli.ts"];
const SHA40 = /^[0-9a-f]{40}$/;
const short = (s: string) => s.slice(0, 10);

export type RawJudge = { judge: "a" | "b"; text?: string; error?: string };
export interface EvidenceItem { id: string; pass: boolean; replies: string[]; state: unknown; brain_error?: string; judge_raw: RawJudge[] }
export interface EvidencePass { label: string; run_at: string; api_key_source: string; stopped: string | null; total: number; passed: number; items: EvidenceItem[] }
export interface Evidence { kind: string; version: number; mode: string; sha: string; reply_tree: string; eval_tree: string; set: string; brain: string; harness: string; judge_model: string; judge_model_2: string; judge_prompt_sha: string; passes: EvidencePass[] }
export interface SubMeasurement { sha: string; set: string; size: number; passes: number; passed: number; worst: number; rate: number; perPass: number[]; harness: string; judges: string }
export type Tree = (sha: string, paths: readonly string[]) => Promise<string | null>;

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

export async function verifySubscriptionEvidence(text: string, o: { candidate: string; lineage: string[]; tree: Tree; setText: string | null; brain: string }): Promise<{ m: SubMeasurement | null; why: string }> {
  const no = (why: string) => ({ m: null, why });
  let ev: Evidence;
  try { ev = JSON.parse(text); } catch { return no("the evidence file is not JSON"); }
  if (ev?.kind !== EVIDENCE_KIND || ev.version !== 1) return no(`not ${EVIDENCE_KIND} version 1`);
  if (ev.mode !== "subscription") return no(`mode is ${JSON.stringify(ev.mode)}, not "subscription"`);
  if (!SHA40.test(String(ev.sha)) || !o.lineage.includes(ev.sha)) return no(`it measured ${String(ev.sha).slice(0, 10)}, not ${short(o.candidate)} or a same-reply-code ancestor`);
  const [rt, rc] = [await o.tree(ev.sha, REPLY_CODE), await o.tree(o.candidate, REPLY_CODE)];
  if (!rt || ev.reply_tree !== rt || ev.reply_tree !== rc) return no(`its reply-code tree ${String(ev.reply_tree).slice(0, 12)} is not the reply code of ${short(ev.sha)} and ${short(o.candidate)}`);
  const [et, ec] = [await o.tree(ev.sha, EVAL_CODE), await o.tree(o.candidate, EVAL_CODE)];
  if (!et || ev.eval_tree !== et || ev.eval_tree !== ec) return no(`its eval-code tree (set, judges, harness, runner) ${String(ev.eval_tree).slice(0, 12)} is not that of ${short(ev.sha)} and ${short(o.candidate)}`);
  if (ev.set !== S3_SUBSCRIPTION.set) return no(`set ${ev.set}, not ${S3_SUBSCRIPTION.set}`);
  if (ev.brain !== o.brain) return no(`brain ${ev.brain}, but the candidate serves ${o.brain}`);
  if (ev.harness !== HARNESS) return no("harness is not the candidate's");
  const fp = await judgeFingerprint(JUDGE_PROMPT, { a: JUDGE_A_MODEL, b: JUDGE_B_MODEL });
  if (ev.judge_model !== JUDGE_A_MODEL || ev.judge_model_2 !== JUDGE_B_MODEL || ev.judge_prompt_sha !== fp) return no(`judges ${ev.judge_model} + ${ev.judge_model_2} (${ev.judge_prompt_sha}) are not the candidate's ${JUDGE_A_MODEL} + ${JUDGE_B_MODEL} (${fp})`);
  let set: EvalItem[];
  try { set = JSON.parse(o.setText ?? "").items; } catch { return no(`${S3_SUBSCRIPTION.setPath} at ${short(o.candidate)} cannot be read`); }
  const byId = new Map(set.map((it) => [it.id, it]));
  const size = set.length;
  if (byId.size !== size || size < S3_SUBSCRIPTION.minSetSize) return no(`the set has ${size} cases (${byId.size} distinct); at least ${S3_SUBSCRIPTION.minSetSize} distinct are needed`);
  if (!Array.isArray(ev.passes) || ev.passes.length !== S3_SUBSCRIPTION.passes) return no(`${Array.isArray(ev.passes) ? ev.passes.length : 0} passes, not ${S3_SUBSCRIPTION.passes}`);
  const perPass: number[] = [];
  for (const [k, p] of ev.passes.entries()) {
    const at = `pass ${k + 1} (${p?.label})`;
    if (p?.api_key_source !== "none") return no(`${at}: apiKeySource ${JSON.stringify(p?.api_key_source)}, not "none" (not a subscription run)`);
    if (p.stopped) return no(`${at}: stopped (${p.stopped}), not a score`);
    const ids = (p.items ?? []).map((x) => x?.id);
    const seen = new Set(ids);
    const missing = set.filter((it) => !seen.has(it.id)).map((it) => it.id), extra = ids.filter((id) => !byId.has(id));
    if (missing.length || extra.length || seen.size !== ids.length) return no(`${at}: cases are not the set's: missing [${missing.join(", ")}], extra [${extra.join(", ")}], ${ids.length - seen.size} repeated`);
    let passed = 0;
    for (const x of p.items) {
      const item = byId.get(x.id)!;
      let pass = false;
      if (typeof x.brain_error === "string") pass = false;
      else {
        if (!Array.isArray(x.replies) || x.replies.some((r) => typeof r !== "string")) return no(`${at} ${x.id}: no transcript`);
        const reply = x.replies[x.replies.length - 1] ?? "", state = x.state ?? null, raw = Array.isArray(x.judge_raw) ? x.judge_raw : [];
        const a = verdictOf(raw.filter((j) => j.judge === "a"), parseJudge);
        const b = verdictOf(raw.filter((j) => j.judge === "b"), (t) => parseJudgeB(t, item, reply, state));
        if (a === "malformed" || b === "malformed") return no(`${at} ${x.id}: the raw judge answers are not what the runner records`);
        if (a === "error" || b === "error") return no(`${at} ${x.id}: a judge errored, so the pass is NOT A SCORE`);
        pass = a.pass && b.pass && checkExpect(item.expect, outcomeOf(state)).ok;
      }
      if (x.pass !== pass) return no(`${at} ${x.id}: claims ${x.pass ? "pass" : "fail"}, but its transcript and judge answers give ${pass ? "pass" : "fail"}`);
      if (pass) passed++;
    }
    if (p.total !== size || p.passed !== passed) return no(`${at}: claims ${p.passed}/${p.total}, but its transcripts give ${passed}/${size}`);
    perPass.push(passed);
  }
  const sum = perPass.reduce((s, n) => s + n, 0);
  return { m: { sha: ev.sha, set: ev.set, size, passes: perPass.length, passed: sum, worst: Math.min(...perPass), rate: sum / size / perPass.length, perPass, harness: ev.harness, judges: ev.judge_prompt_sha }, why: "" };
}

export const meetsSubscriptionBar = (m: SubMeasurement) => m.passes === S3_SUBSCRIPTION.passes && m.size >= S3_SUBSCRIPTION.minSetSize && m.perPass.every((n) => n * 100 >= m.size * S3_SUBSCRIPTION.barPercent);

// The newest evidence along the lineage (the SHA itself first), verified. found=false: no evidence file at all.
export async function subscriptionMeasurementOf(
  src: { subscriptionEvidence?(sha: string): Promise<string | null>; fileAt(sha: string, path: string): Promise<string | null>; tree: Tree },
  sha: string, lineage: string[], brain: string,
): Promise<{ found: boolean; m: SubMeasurement | null; why: string }> {
  if (!src.subscriptionEvidence) return { found: false, m: null, why: "" };
  for (const s of lineage) {
    const text = await src.subscriptionEvidence(s);
    if (text === null) continue;
    const r = await verifySubscriptionEvidence(text, { candidate: sha, lineage, tree: src.tree, setText: await src.fileAt(sha, S3_SUBSCRIPTION.setPath), brain });
    return { found: true, m: r.m, why: r.m ? "" : `subscription evidence ${evidencePath(s)} (D-091) refused: ${r.why}` };
  }
  return { found: false, m: null, why: "" };
}

// ------------------------------------------------------------------------------------------------ packing (the owner's machine)
export function packEvidence(results: any[], o: { sha: string; replyTree: string; evalTree: string }): Evidence {
  const r0 = results[0] ?? {};
  return {
    kind: EVIDENCE_KIND, version: 1, mode: results.every((r) => r?.subscription) ? "subscription" : "api", sha: o.sha, reply_tree: o.replyTree, eval_tree: o.evalTree,
    set: r0.set, brain: r0.brain, harness: r0.harness, judge_model: r0.judge_model, judge_model_2: r0.judge_model_2, judge_prompt_sha: r0.judge_prompt_sha,
    passes: results.map((r) => ({
      label: r.label, run_at: r.run_at, api_key_source: r.subscription?.api_key_source ?? "unknown", stopped: r.stopped ?? null, total: r.total, passed: r.passed,
      items: (r.items ?? []).map((x: any) => ({ id: x.id, pass: !!x.pass, replies: x.replies ?? [], state: x.state ?? null,
        ...(/^brain error/.test(String(x.note ?? "")) ? { brain_error: String(x.note) } : {}), judge_raw: x.judge_raw ?? [] })),
    })),
  };
}

if (import.meta.main) {
  const a = [...Deno.args], opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : undefined; };
  const sha = opt("--sha") ?? "", out = opt("--out") ?? "";
  if (!SHA40.test(sha) || !out || a.length !== S3_SUBSCRIPTION.passes) { console.error(`usage: s3-subscription.ts --sha <40-hex> --out <dir> <${S3_SUBSCRIPTION.passes} result files>`); Deno.exit(2); }
  const results = await Promise.all(a.map(async (f) => JSON.parse(await Deno.readTextFile(f))));
  const bad = results.filter((r) => r?.subscription?.sha !== sha).map((r) => r?.label);
  if (bad.length) { console.error(`refused: ${bad.join(", ")} did not measure ${sha} (run every pass on a clean checkout of it)`); Deno.exit(1); }
  const git = async (args: string[]) => new TextDecoder().decode((await new Deno.Command("git", { args, stdout: "piped" }).output()).stdout);
  const { parseProductionBrain, RELEASE_CONFIG_PATH } = await import("../../supabase/functions/agent-chat/release_config.ts");
  const ev = packEvidence(results, { sha, replyTree: (await gitTree(sha, REPLY_CODE)) ?? "", evalTree: (await gitTree(sha, EVAL_CODE)) ?? "" });
  const text = JSON.stringify(ev);
  const r = await verifySubscriptionEvidence(text, { candidate: sha, lineage: [sha], tree: gitTree, setText: await git(["show", `${sha}:${S3_SUBSCRIPTION.setPath}`]), brain: parseProductionBrain(await git(["show", `${sha}:${RELEASE_CONFIG_PATH}`])) });
  const file = `${out}/${evidencePath(sha)}`;
  await Deno.mkdir(`${out}/${SUBSCRIPTION_DIR}`, { recursive: true });
  await Deno.writeTextFile(file, text);
  if (!r.m) { console.log(`S3 subscription evidence for ${short(sha)}: REFUSED: ${r.why}\nwritten anyway (for inspection): ${file}`); Deno.exit(1); }
  const okBar = meetsSubscriptionBar(r.m);
  console.log(`S3 subscription evidence for ${short(sha)}: passes ${r.m.perPass.join(", ")} of ${r.m.size}; worst ${r.m.worst}/${r.m.size} ${okBar ? ">=" : "<"} ${S3_SUBSCRIPTION.barPercent}% -> ${okBar ? "MEETS" : "BELOW"} the bar\nwritten: ${file}`);
  Deno.exit(okBar ? 0 : 1);
}
