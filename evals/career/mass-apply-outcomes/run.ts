// DT-1 mass-apply outcome eval: the command line. See README.md.
//   deno run --allow-read evals/career/mass-apply-outcomes/run.ts                 print the scorecard (deterministic, CI-cheap)
//   deno run --allow-read --allow-write evals/career/mass-apply-outcomes/run.ts --write [--trunk <sha>]
//                                                                                  refresh results/baseline.json and results/SCORECARD.md
//   deno run --allow-read evals/career/mass-apply-outcomes/run.ts --check          exit 1 when the run differs from the baseline
//   deno run --allow-read --allow-run=claude --allow-env evals/career/mass-apply-outcomes/run.ts --judge [--judge-max N]
//                                                                                  OFF by default: a second opinion on every wrong or
//                                                                                  contested answer from the `claude` CLI (subscription)
// The deterministic mode needs only --allow-read (and --allow-write for --write): it cannot reach the network or a model.
import { HERE, runAll, score, scorecardMd } from "./harness.ts";

const args = Deno.args;
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const { apps, failures } = await runAll();
const s = score(apps, failures);
const baselineUrl = new URL("results/baseline.json", HERE);
const trunk = opt("--trunk") ?? (() => { try { return JSON.parse(Deno.readTextFileSync(baselineUrl)).trunk; } catch { return "unknown"; } })();
const result = { version: 1, mode: "deterministic", trunk, scorecard: s, applications: apps, failures };
const md = scorecardMd(s, { trunk });

if (flag("--write")) {
  Deno.mkdirSync(new URL("results/", HERE), { recursive: true });
  Deno.writeTextFileSync(baselineUrl, JSON.stringify(result, null, 1) + "\n");
  Deno.writeTextFileSync(new URL("results/SCORECARD.md", HERE), md);
}
if (flag("--check")) {
  const base = JSON.parse(Deno.readTextFileSync(baselineUrl));
  const strip = (x: any) => JSON.stringify({ ...x, trunk: undefined });
  if (strip(base) !== strip(JSON.parse(JSON.stringify(result)))) {
    console.error("the run differs from results/baseline.json: refresh it with --write (and say why in the PR) if the change is intended");
    console.log(md);
    Deno.exit(1);
  }
}
console.log(md);

if (flag("--judge")) {
  const { judgeAll } = await import("./judge.ts");
  const max = Number(opt("--judge-max") ?? 40);
  const out = await judgeAll(apps, { max });
  console.log("\n## Model second opinion (claude CLI, subscription; not part of the score)\n");
  for (const j of out) console.log(`- ${j.key} [${j.verdict}] ${j.label}: "${j.shown}" (${j.why})`);
}
