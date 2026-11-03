// Re-judge stored transcripts with the Claude judges, without running any brain (owner directive 2026-11-02: Claude only, $70).
//
//   Replay (the baseline for S3 and the judge-pair calibration):
//     deno run -A evals/career/rejudge.ts --from-branch ci/brain-eval --run <ci run id> [--new-run <id>] [--parallel 1] [--no-log]
//   reads every stored pass file evals/career/results/<set>-<brain>-<run id>-p<N>.json from that branch (git show; the working
//   tree is not touched), judges each stored final reply and end state with judge A and judge B (judges.ts), recomputes the
//   code-counted state check from the stored state, and writes a full run.ts-compatible result file
//   evals/career/results/<set>-<brain>-<new run>-p<N>.json plus one SCORE-LOG.md row per pass (judges column "... judge=claude",
//   commit = the stored run's source commit), so verdict.ts, score-log.ts and S3 (deploy-standard.ts) accept it.
//   It makes NO model call except the two judges: a fetch guard refuses every other host and every other model id. It never
//   overwrites a result file. Spend is metered, gated by the shared ledger and quoted first (eval_budget.ts), like any run.
//
//   Legacy (one judge, one file):  deno run -A evals/career/rejudge.ts <label> <claude judge model>
//   writes results/<label>-rejudge-<model>.json once (both-pass.ts reads it).
import { type EvalItem, type EvalItemResult, judgePrompt, type Judge, JUDGE_PROMPT, makeJudge, parseJudge } from "./run.ts";
import { checkExpect, HARNESS, outcomeOf } from "./harness.ts";
import { JUDGE_A_MAX_TOKENS, JUDGE_A_MODEL, JUDGE_A_SYSTEM, JUDGE_B_MODEL, judgeFingerprint, judgeModelProblem } from "./judges.ts";
import { attribute } from "./attribution.ts";
import { budgetTargets, claudeSpentUsd, openGate, preflight, quoteRun, spendLine } from "./eval_budget.ts";
import { SCORE_LOG_HEAD, scoreLogRow } from "./score-log.ts";

// The only network request a re-judge may make: Anthropic's messages endpoint, for one of the two judge models.
export function guardFetch(allowedModels: string[], real: typeof fetch): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const url = new URL(req.url);
    if (url.hostname !== "api.anthropic.com") throw new Error(`rejudge makes no call except the judges: ${url.hostname} refused`);
    let model = "";
    try { model = String(JSON.parse(await req.clone().text()).model ?? ""); } catch { /* not JSON */ }
    if (!allowedModels.includes(model)) throw new Error(`rejudge makes no call except the judges: model ${model || "(none)"} refused`);
    return real(req);
  }) as typeof fetch;
}

// A stored pass file's name: <set>-<brain>-<run>-p<N>.json (brain may carry a model, e.g. staged:claude-haiku-5-5).
export const STORED = /^(?<set>[a-z]+)-(?<brain>.+)-(?<run>\d+)-p(?<p>\d+)\.json$/;
// The item set a stored file was scored on. dev and the old 38-item heldout are heldout-live.json; official is messages.json.
// The sealed and fresh sets' results keep no replies or state, so they cannot be re-judged.
export function setFileOf(set: string): string {
  if (set === "dev" || set === "heldout") return "./heldout-live.json";
  if (set === "official") return "./messages.json";
  throw new Error(`the ${set} set's stored results keep no replies or state (redacted): nothing to re-judge`);
}

export interface StoredFile { name: string; text: string }
export interface RejudgeDeps {
  stored: StoredFile[];
  itemsOf: (set: string) => Promise<EvalItem[]>;
  judge: Judge;
  judgeModels: { a: string; b: string };
  newRun: string;
  branch: string;
  now?: () => Date;
  judgeCost?: () => number; // cumulative judge spend, to attribute per file
}
export interface RejudgeOut { name: string; result: any; row: string }

// Re-judge one stored pass. The pass is a score only on the same terms as a live one: every item judged by both judges.
export async function rejudgeFile(f: StoredFile, d: RejudgeDeps): Promise<RejudgeOut> {
  const m = STORED.exec(f.name);
  if (!m?.groups) throw new Error(`${f.name} is not a stored pass file (<set>-<brain>-<run>-p<N>.json)`);
  const { set, brain, run, p } = m.groups;
  const src = JSON.parse(f.text);
  const byId = new Map((await d.itemsOf(src.set ?? set)).map((i) => [i.id, i]));
  const before = d.judgeCost?.() ?? 0;
  const items: EvalItemResult[] = [];
  for (const x of src.items ?? []) {
    const it = byId.get(x.id);
    if (!it) { items.push({ id: x.id, pass: false, failed: [], score: 1, replies: x.replies ?? [], note: "judge error: item no longer in the set" }); continue; }
    // A brain error is carried over unchanged: the stored pass was not a score for that reason, and still is not.
    if (/^brain error/.test(x.note ?? "")) { items.push({ id: x.id, ...(x.category ? { category: x.category } : {}), pass: false, failed: it.must, score: 1, replies: x.replies ?? [], note: x.note }); continue; }
    const state = x.state ?? null, reply = (x.replies ?? []).at(-1) ?? "";
    const outcome = outcomeOf(state), sc = checkExpect(it.expect, outcome);
    try {
      const j: any = await d.judge(it, reply, state);
      items.push({ id: x.id, ...(x.category ? { category: x.category } : {}), ...(j.disagree !== undefined ? { disagree: !!j.disagree } : {}), pass: !!j.pass && sc.ok,
        failed: [...(j.failed || []), ...sc.failed.map((s: string) => `state: ${s}`)], score: Number(j.score) || 1, replies: x.replies ?? [], note: j.note || "",
        ...(j.judges ? { judges: j.judges } : {}), outcome, state_check: sc, state, ...(x.trace ? { trace: x.trace } : {}) });
    } catch (e) {
      items.push({ id: x.id, pass: false, failed: it.must, score: 1, replies: x.replies ?? [], note: `judge error: ${e instanceof Error ? e.message : String(e)}`, outcome, state_check: sc });
    }
  }
  const passed = items.filter((x) => x.pass).length, split = items.filter((x) => x.disagree).length;
  const label = `${set}-${brain}-${d.newRun}-p${p}`;
  const judgeUsd = (d.judgeCost?.() ?? 0) - before;
  const result = {
    label, harness: src.harness ?? HARNESS, set: src.set === "heldout" ? "dev" : src.set, brain: src.brain, model: src.model ?? null,
    judge_model: d.judgeModels.a, judge_model_2: d.judgeModels.b, judge: "claude",
    judge_prompt_sha: await judgeFingerprint(JUDGE_PROMPT, d.judgeModels), judge_disagreement: { items: split, rate: items.length ? split / items.length : 0 },
    commit: src.commit, source_commit: src.source_commit ?? src.commit, run_at: (d.now?.() ?? new Date()).toISOString(),
    rejudge_of: { branch: d.branch, run, label: src.label ?? `${set}-${brain}-${run}-p${p}`, judges_before: [src.judge_model, src.judge_model_2].filter(Boolean) },
    cost_usd: { brain: 0, judge: judgeUsd }, route_attribution: attribute(items, String(src.brain)),
    total: items.length, planned: src.planned ?? items.length, passed, pass_rate: items.length ? passed / items.length : 0, stopped: null as string | null, items,
  };
  return { name: `${label}.json`, result, row: scoreLogRow(result, d.newRun, `; rejudge of ${run}`) };
}

export async function rejudgeRun(d: RejudgeDeps): Promise<RejudgeOut[]> {
  const files = d.stored.filter((f) => STORED.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) throw new Error("no stored pass files for that run");
  const out: RejudgeOut[] = [];
  for (const f of files) out.push(await rejudgeFile(f, d));
  return out;
}

// ---------------------------------------------------------------------------------------------------- CLI
async function git(args: string[]): Promise<{ ok: boolean; out: string }> {
  const o = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  return { ok: o.success, out: new TextDecoder().decode(o.stdout) };
}

if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const get = (k: string) => Deno.env.get(k);
  const a = get("EVAL_JUDGE_MODEL") || JUDGE_A_MODEL, b = get("EVAL_JUDGE_MODEL_2") || JUDGE_B_MODEL;
  for (const m of [a, b]) { const why = judgeModelProblem(m, Deno.env); if (why) { console.log(`NOT RUN: ${why}.`); Deno.exit(2); } }
  const gw = await import("../../supabase/functions/_shared/model_gateway.ts");
  const bud = await import("../../supabase/functions/_shared/model_budget.ts");
  globalThis.fetch = guardFetch([a, b], globalThis.fetch);
  const { target, hard } = budgetTargets(get);
  const prior: any[] = [];
  for (const dir of ["./results/", "./tasks/results/"]) {
    try { for await (const e of Deno.readDir(new URL(dir, import.meta.url))) if (e.name.endsWith(".json")) prior.push(JSON.parse(await Deno.readTextFile(new URL(`${dir}${e.name}`, import.meta.url)))); } catch { /* none */ }
  }
  let before = claudeSpentUsd(prior);
  const parallel = Math.max(1, Number(opt("--parallel") ?? get("EVAL_PARALLEL") ?? 1) || 1);
  const opened = openGate(bud, get, before, target, parallel);
  if ("error" in opened) { console.log(`NOT RUN: ${opened.error}.`); Deno.exit(2); }
  // Shared ledger: refuse to start unless the one $70 ledger can be read; spend before = what ALL runs recorded in it.
  try { const st = await bud.assertRunMayStart(opened.gate, undefined, { model: "rejudge", role: "eval" }); if (opened.shared) { before = st.total / 1e6; console.log(`shared ledger: $${(st.total / 1e6).toFixed(3)} recorded across all runs; remaining allowance $${Math.max(0, (st.target - st.total) / 1e6).toFixed(3)} of $${(st.target / 1e6).toFixed(2)}`); } }
  catch (e) { console.log(e instanceof Error ? e.message : String(e)); Deno.exit(2); }
  const meter = gw.newMeter();
  const cfgA = gw.modelConfigFor(Deno.env, a), cfgB = gw.modelConfigFor(Deno.env, b);
  const call = (cfg: any, payload: any) => gw.callModel(cfg, payload, { meter, role: "chat", budget: opened.gate });

  const branch = opt("--from-branch"), run = opt("--run");
  if (branch && run) {
    // ---- replay
    const ref = (await git(["rev-parse", "--verify", "--quiet", `origin/${branch}`])).ok ? `origin/${branch}` : branch;
    const ls = await git(["ls-tree", "--name-only", ref, "evals/career/results/"]);
    if (!ls.ok) { console.log(`NOT RUN: cannot list evals/career/results/ on ${ref}.`); Deno.exit(2); }
    const names = ls.out.split("\n").map((x) => x.replace(/^evals\/career\/results\//, "")).filter((n) => STORED.exec(n)?.groups?.run === run);
    const stored: StoredFile[] = [];
    for (const n of names) stored.push({ name: n, text: (await git(["show", `${ref}:evals/career/results/${n}`])).out });
    if (!stored.length) { console.log(`NOT RUN: no stored pass files of run ${run} on ${ref}.`); Deno.exit(2); }
    const newRun = opt("--new-run") ?? get("GITHUB_RUN_ID") ?? String(Date.now());
    const itemsCache = new Map<string, EvalItem[]>();
    const itemsOf = async (set: string) => {
      const f = setFileOf(set);
      if (!itemsCache.has(f)) itemsCache.set(f, JSON.parse(await Deno.readTextFile(new URL(f, import.meta.url))).items);
      return itemsCache.get(f)!;
    };
    // Quote before the first call: every stored item is judged by both judges.
    let n = 0; for (const f of stored) n += (JSON.parse(f.text).items ?? []).length;
    let quote;
    try { quote = quoteRun({ items: n, brain: "router", brainModel: null, judgeA: a, judgeB: b, prices: gw.PRICES }); } catch (e) { console.log(`NOT RUN: ${e instanceof Error ? e.message : e}`); Deno.exit(2); }
    const pre = preflight({ quote, parallel, spent_usd: before, target_usd: target, hard_usd: hard, ledger: opened.shared ? "shared" : "process-local" });
    console.log(pre.line);
    if (!pre.ok) { console.log("NOT RUN: the preflight quote was refused; nothing was spent."); Deno.exit(2); }
    try { await bud.assertRunMayStart(opened.gate, Math.ceil(quote.total_usd * 1e6), { model: "rejudge", role: "eval" }); } catch (e) { console.log(e instanceof Error ? e.message : String(e)); Deno.exit(2); }
    const outs = await rejudgeRun({ stored, itemsOf, judge: makeJudge({ cfgA, cfgB, call }), judgeModels: { a, b }, newRun, branch, judgeCost: () => meter.usd_micros / 1e6 });
    await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
    let log = ""; try { log = await Deno.readTextFile(new URL("./SCORE-LOG.md", import.meta.url)); } catch { /* new */ }
    if (!log.trim()) log = SCORE_LOG_HEAD;
    for (const o of outs) {
      const url = new URL(`./results/${o.name}`, import.meta.url);
      try { await Deno.stat(url); console.log(`already re-judged, not rewritten: ${o.name}`); continue; } catch { /* not yet */ }
      await Deno.writeTextFile(url, JSON.stringify(o.result, null, 1));
      if (!args.includes("--no-log")) log += o.row;
      console.log(`${o.result.label}: ${o.result.passed}/${o.result.total} · split ${o.result.judge_disagreement.items} · judge cost $${o.result.cost_usd.judge.toFixed(4)}`);
    }
    if (!args.includes("--no-log")) await Deno.writeTextFile(new URL("./SCORE-LOG.md", import.meta.url), log);
    const spend = spendLine({ label: `rejudge of ${run}`, quote_usd: quote.total_usd, brain_usd: 0, judge_usd: meter.usd_micros / 1e6, spent_before_usd: before, target_usd: target, hard_usd: hard });
    console.log(spend);
    const sum = get("GITHUB_STEP_SUMMARY"); if (sum) { try { await Deno.writeTextFile(sum, spend + "\n", { append: true }); } catch { /* none */ } }
    Deno.exit(0);
  }

  // ---- legacy: one judge, one file
  const [label, model] = args;
  if (!label || !model || label.startsWith("--")) { console.log("usage: rejudge.ts --from-branch <branch> --run <ci run id>   |   rejudge.ts <label> <claude judge model>"); Deno.exit(2); }
  const why = judgeModelProblem(model, Deno.env); if (why) { console.log(`NOT RUN: ${why}.`); Deno.exit(2); }
  const out = new URL(`./results/${label}-rejudge-${model}.json`, import.meta.url);
  try { await Deno.stat(out); console.log(`already re-scored: ${out.pathname}`); Deno.exit(0); } catch { /* not yet */ }
  if (!gw.PRICES[model]) { console.log(`NOT RUN: ${model} is unpriced, so its spend cannot be capped.`); Deno.exit(2); }
  const src = JSON.parse(await Deno.readTextFile(new URL(`./results/${label}.json`, import.meta.url)));
  let setItems: EvalItem[];
  try { setItems = JSON.parse(await Deno.readTextFile(new URL(setFileOf(src.set), import.meta.url))).items; } catch (e) { console.log(`NOT RUN: ${e instanceof Error ? e.message : e}`); Deno.exit(2); }
  const byId = new Map<string, EvalItem>(setItems.map((i) => [i.id, i]));
  const cfg = gw.modelConfigFor(Deno.env, model);
  const items: any[] = [];
  for (const x of src.items) {
    if (before + meter.usd_micros / 1e6 + 0.05 >= target) { console.log("STOPPED at the spend target: not a score."); break; }
    const it = byId.get(x.id);
    if (!it) { items.push({ id: x.id, pass: false, failed: [], note: "item no longer in the set" }); continue; }
    let v;
    try {
      const res = await call(cfg, { system: JUDGE_A_SYSTEM, messages: [{ role: "user", content: judgePrompt(it, (x.replies ?? []).at(-1) ?? "", x.state ?? null) }], max_tokens: JUDGE_A_MAX_TOKENS });
      v = parseJudge((res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
    } catch (e) { v = { pass: false, failed: it.must, score: 1, note: `judge error: ${e instanceof Error ? e.message : String(e)}` }; }
    items.push({ id: x.id, ...v });
  }
  const passed = items.filter((x) => x.pass).length;
  const result = { label: `${label}-rejudge-${model}`, of: label, judge_model: model, state_given: src.items.some((x: any) => "state" in x) ? "the end state the run's judges saw" : "null (this run's file does not keep the brain's end state)", set: src.set, brain: src.brain, source_commit: src.source_commit, run_at: new Date().toISOString(),
    cost_usd: { brain: 0, judge: meter.usd_micros / 1e6 }, total: items.length, passed, pass_rate: items.length ? passed / items.length : 0, stopped: items.length < src.items.length ? "spend target" : null, items };
  await Deno.writeTextFile(out, JSON.stringify(result, null, 1));
  console.log(`${result.label}: ${passed}/${items.length} · judge ${model} · cost $${(meter.usd_micros / 1e6).toFixed(4)} · judge errors ${items.filter((x) => /^judge error/.test(x.note ?? "")).length}`);
}
