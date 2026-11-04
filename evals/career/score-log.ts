// WO-061: the score log (owner, 2026-10-21: "one line per eval run: date/time, commit hash, score, set size"). Each result
// file named on the command line adds one line to evals/career/SCORE-LOG.md, never edits an earlier one.
//   deno run -A evals/career/score-log.ts evals/career/results/<label>.json [...] [--run <ci run id>]
export function judgeErrors(r: any): number {
  return (r.items ?? []).filter((x: any) => /^judge error/.test(x.note ?? "") || (x.judges ?? []).some((j: any) => /^judge error/.test(j.note ?? ""))).length;
}
// The judges column. The Claude pair (2026-11-02) is labelled judge=claude: S3 compares the pair with the counts stripped
// (deploy-standard.ts judgePair), so a constant label keeps every pass of one pair comparable.
export function judgesColumn(r: any): string {
  const per = [r.judge_model, r.judge_model_2].filter(Boolean).map((m: string) => `${m} ${(r.items ?? []).filter((x: any) => (x.judges ?? []).find((j: any) => j.model === m)?.pass ?? (m === r.judge_model ? x.pass : false)).length}`);
  const claude = /^claude-/i.test(String(r.judge_model ?? ""));
  return claude ? `${per.join(", ")}; both-pass; judge=claude` : (r.judge_model_2 ? `${per.join(", ")}; both-pass` : `${per[0]} alone`) + " (Instinct scores beside them)";
}
// One row. `run` is the CI run column (digits first: S3 reads it as the run id); `extra` follows it before the harness.
export function scoreLogRow(r: any, run: string, extra = ""): string {
  // A judge that errored scored nothing: the run is not a score (run 39541224991 logged 0/38 when its second judge failed every call).
  const errs = judgeErrors(r);
  return `| ${String(r.run_at).slice(0, 19).replace("T", " ")} | ${r.source_commit ?? r.commit} | ${r.set} | ${r.brain} | ${r.total} | ${r.passed} | ${(r.pass_rate * 100).toFixed(1)}% | ${judgesColumn(r)} | ${r.stopped ? "STOPPED" : errs ? `NOT A SCORE: ${errs} judge errors` : "no"} | ${run}${extra}${r.harness ? `; harness: ${r.harness}` : ""} |\n`;
}
export const SCORE_LOG_HEAD = "# Brain score log (WO-061)\n\nOne line per eval run, appended by CI; never edited. The bar (D-030): 95% on the held-out set, both judges pass, on the live build.\n\n| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
if (import.meta.main) {
const args = [...Deno.args];
const ri = args.indexOf("--run"), run = ri >= 0 ? args.splice(ri, 2)[1] : "";
const file = new URL("./SCORE-LOG.md", import.meta.url);
let log = "";
try { log = await Deno.readTextFile(file); } catch { /* first line */ }
if (!log.trim()) log = SCORE_LOG_HEAD;
for (const f of args) log += scoreLogRow(JSON.parse(await Deno.readTextFile(f)), run);
await Deno.writeTextFile(file, log);
console.log(log.trim().split("\n").slice(-args.length).join("\n"));
}
