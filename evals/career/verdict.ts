// The brain-eval verdict (2026-10-26). Reads one run's result files (evals/career/results/<set>-<brain>-<run>-p<N>.json)
// and says, per brain, whether every pass is a score, each pass's both-judge count, and the pass rate per category.
//
// A pass is a score only when it finished (not stopped by the spend cap), every planned item ran, no item has a brain
// error, and BOTH CI judges returned a verdict on EVERY item (no judge error, no missing verdict). Anything else is NOT A
// SCORE, and the job fails: a measurement that did not happen is never shown as a result.
// The bar (D-030, owner): 95%, both judges pass an item, on the held-out set; the owner also requires five passes. This
// verdict reads that strictly: the bar is met only when every one of the five passes is at 95% or more on the sealed set
// (not the best pass, not the mean). The dev set (the 38 the builder has seen) is reported, never judged against the bar.
// Judges (owner, 2026-11-02): Claude only, claude-sonnet-5-5 and claude-haiku-5-5 (judges.ts). Instinct is retired from the gate.
// D-030 (one full pass at 95%) and this strict reading (all five passes at 95%) disagree in writing; the owner ruled 2026-11-02
// that the bar means all FIVE passes, and this file implements it (D-030's wording is to be aligned).
//   deno run -A evals/career/verdict.ts --run <id> --set dev|sealed --brains router,staged,agent --passes 5 [--out <file>]
import { attributeMany, attributionLines } from "./attribution.ts";
export type R = { label: string; set: string; brain: string; total: number; planned: number; passed: number; pass_rate: number; stopped: string | null;
  judge_model: string; judge_model_2: string | null; items: { id: string; category?: string; pass: boolean; note?: string; judges?: { model: string; pass: boolean; note?: string }[] }[];
  cost_usd: { brain: number; judge: number }; source_commit?: string; judge_disagreement?: { items: number; rate: number }; quote_usd?: number };

export function problems(r: R | null, judges = 2): string[] {
  if (!r) return ["no result file"];
  const p: string[] = [];
  if (r.stopped) p.push(`stopped: ${r.stopped}`);
  if (r.total !== r.planned) p.push(`${r.total} of ${r.planned} items ran`);
  const brainErr = r.items.filter((x) => /^brain error/.test(x.note ?? "")).length;
  if (brainErr) p.push(`${brainErr} brain errors`);
  const models = [r.judge_model, r.judge_model_2].filter(Boolean) as string[];
  if (models.length < judges) p.push(`${models.length} judge(s) configured, ${judges} required`);
  for (const m of models) {
    const missing = r.items.filter((x) => { const j = (x.judges ?? []).find((y) => y.model === m); return !j || /^judge error/.test(j.note ?? ""); }).length;
    if (missing) p.push(`${m} did not score ${missing} of ${r.items.length} items`);
  }
  const judgeErr = r.items.filter((x) => /^judge error/.test(x.note ?? "")).length;
  if (judgeErr) p.push(`${judgeErr} items with a judge error`);
  return p;
}
export function byCategory(passes: R[]): Record<string, { items: number; passed: number; rate: number }> {
  const out: Record<string, { items: number; passed: number; rate: number }> = {};
  for (const r of passes) for (const x of r.items) {
    const c = x.category ?? "uncategorized";
    out[c] ??= { items: 0, passed: 0, rate: 0 };
    out[c].items++; if (x.pass) out[c].passed++;
  }
  for (const v of Object.values(out)) v.rate = v.items ? v.passed / v.items : 0;
  return out;
}
export function verdict(set: string, byBrain: Record<string, (R | null)[]>, passes: number, bar = 0.95) {
  const lines: string[] = [];
  let invalid = false, barMet: Record<string, boolean> = {};
  for (const [brain, rs] of Object.entries(byBrain)) {
    const probs = rs.map((r) => problems(r));
    const ok = rs.filter((r, i) => r && !probs[i].length) as R[];
    const counts = rs.map((r, i) => !r ? "missing" : probs[i].length ? `NOT A SCORE (${probs[i].join("; ")})` : `${r.passed}/${r.total}`);
    if (ok.length !== passes) invalid = true;
    const rates = ok.map((r) => r.pass_rate);
    const min = rates.length ? Math.min(...rates) : 0, mean = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0, max = rates.length ? Math.max(...rates) : 0;
    const spend = rs.reduce((a, r) => a + (r ? r.cost_usd.brain + r.cost_usd.judge : 0), 0);
    const brainSpend = rs.reduce((a, r) => a + (r ? r.cost_usd.brain : 0), 0);
    const turns = ok.length ? ok[0].items.length : 0;
    barMet[brain] = set === "sealed" && ok.length === passes && min >= bar;
    lines.push(`${brain}: ${counts.join(", ")} both-pass` + (rates.length ? ` · min ${(min * 100).toFixed(1)}% mean ${(mean * 100).toFixed(1)}% max ${(max * 100).toFixed(1)}%` : "") +
      ` · spend $${spend.toFixed(3)} (brain $${brainSpend.toFixed(3)}${turns ? `, $${(brainSpend / Math.max(1, ok.length) / turns).toFixed(4)} per item` : ""})` +
      (set === "sealed" ? (barMet[brain] ? " · BAR MET on the two Claude judges (every one of five passes at 95%+)" : " · BELOW THE BAR (95% on every one of five passes)") : " · dev set: not the bar"));
    // A/B disagreement: the two Claude judges share blind spots, so how often they split is part of every report. Above 15% the
    // pair is treated as unreliable (plan 1.3, threshold to be ratified by the owner).
    const splits = ok.reduce((a, r) => a + (r.judge_disagreement?.items ?? 0), 0), judged = ok.reduce((a, r) => a + r.items.length, 0);
    if (judged) lines.push(`  judge A/B disagreement: ${splits}/${judged} items (${(splits / judged * 100).toFixed(1)}%)${splits / judged > 0.15 ? " · UNRELIABLE JUDGE PAIR (over 15%)" : ""}`);
    const quoted = rs.reduce((a, r) => a + (r?.quote_usd ?? 0), 0);
    if (quoted) lines.push(`  spend line: actual $${spend.toFixed(3)} vs preflight quote $${quoted.toFixed(3)}`);
    for (const l of attributionLines(attributeMany(ok as any, brain))) lines.push(`  ${l}`);
    const cats = byCategory(ok);
    lines.push(`  by category (all passes): ${Object.entries(cats).sort().map(([c, v]) => `${c} ${v.passed}/${v.items} (${(v.rate * 100).toFixed(0)}%)`).join(", ")}`);
  }
  // The job fails when a measurement did not happen, and on the sealed set when no brain met the bar.
  const fail = invalid || (set === "sealed" && !Object.values(barMet).some(Boolean));
  return { lines, invalid, barMet, fail };
}

if (import.meta.main) {
  const opt = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] ?? null : null; };
  const run = opt("--run")!, set = opt("--set")!, brains = (opt("--brains") ?? "agent").split(","), passes = Number(opt("--passes") ?? 5);
  const byBrain: Record<string, (R | null)[]> = {};
  for (const b of brains) {
    byBrain[b] = [];
    for (let p = 1; p <= passes; p++) {
      try { byBrain[b].push(JSON.parse(await Deno.readTextFile(new URL(`./results/${set}-${b}-${run}-p${p}.json`, import.meta.url)))); } catch { byBrain[b].push(null); }
    }
  }
  const v = verdict(set, byBrain, passes);
  const head = `brain-eval ${run}: ${set} set, ${passes} passes per brain, an item passes only when both Claude judges (judge A and judge B) pass it and its code-checked outcome holds` +
    (v.invalid ? " · NOT A SCORE: a pass did not finish with both judges on every item" : "");
  const text = [head, ...v.lines].join("\n");
  console.log(text);
  const out = opt("--out");
  if (out) await Deno.writeTextFile(out, text + "\n");
  Deno.exit(v.fail ? 1 : 0);
}
