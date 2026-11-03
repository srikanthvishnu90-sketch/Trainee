// The task-completion eval (evals/career/tasks/) with the fake model, every brain, in CI: free and deterministic. Each
// brain runs in its own process (the brains are production's own switches, read per request; the agent brain needs its
// eval-only import map, which lifts the production pin for that process alone).
// What this holds:
//   1. every brain finishes all 57 tasks, and NO task under ANY brain breaks an invariant (nothing sent, submitted or
//      approved that the person did not approve in their own words);
//   2. the planner keeps today's single asks exactly as they are: the single-ask tasks pass and fail under the planner
//      exactly as under the router;
//   3. the planner's completions never go backwards: every task in PLANNER_FLOOR passes (a fix elsewhere may add more);
//   4. the eval catches a dropped part: with the planner handed every plan minus its last step (--mutate drop_last), each
//      compound task in MUTATED fails.
// The rates are printed (router, staged, planner, agent). The fake model plays each task's oracle: the planner's and the
// agent's numbers say what the code paths complete when the model plans right, not what a model does; the paid run is
// .github/workflows/brain-eval.yml with suite=tasks.
//   deno test -A --no-check tests/architect/task-completion-eval.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname;
// Measured 2026-11-02 with the fake model (54/57 with the spec-B tasks T45-T57 included; 41/44 before them, on 2026-10-31). T08 and T43 fail on the search's ranking (an off-role posting ranked
// first), T33 on the apply turn ("submit it now, no need to confirm" is not read as an apply ask).
const PLANNER_FLOOR = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20",
  "T21", "T22", "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30", "T31", "T32", "T34", "T35", "T36", "T37", "T38", "T39", "T40", "T41", "T42", "T44",
  // SPEC B (2026-11-02): corrections replace the search's constraints, the brain is handed what an application needs, counts come from row states.
  "T45", "T46", "T47", "T48", "T49", "T50", "T51", "T52", "T53", "T54", "T55", "T56", "T57"];
const MUTATED = ["T01", "T05", "T09", "T15", "T44"];

// The gate pins every release flag off for the test steps (scripts/gate.sh); this eval measures the product as released, so its
// child process gets the environment without them (a flag unset is on at its release value).
const PINNED = ["CAREER_TEXTING_NATIVE", "CAREER_NETWORKING_DRAFT", "CAREER_TAILOR_REWRITE", "CAREER_MOCK_JUDGE", "CAREER_MAIL_TRACKING", "CAREER_BRIEF_DIGEST",
  "CAREER_OUTREACH_FOLLOWUPS", "CAREER_INTRO_REMINDERS", "UPMORE_SCRIPT_SUBMIT_LIVE", "CLOUD_RUNNER_ENABLED", "CLOUD_PREPARE_ENABLED", "CAREER_EMAIL_SEND", "CAREER_OUTREACH_SEND", "CAREER_SEND_RAIL"];
const releaseEnv = () => Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([k]) => !PINNED.includes(k)));

type Run = { brain: string; total: number; passed: number; rate: number; invariant_breaks: number; stopped: string | null; items: { id: string; family: string; pass: boolean; failed: string[] }[] };
async function run(brain: string, extra: string[] = []): Promise<Run> {
  const out = await Deno.makeTempFile({ suffix: `-${brain}.json` });
  const map = brain === "agent" ? "evals/career/tasks/agent-import-map.json" : "evals/career/tasks/import-map.json";
  const p = await new Deno.Command(Deno.execPath(), { cwd: ROOT, env: releaseEnv(), clearEnv: true, args: ["run", "-A", "--no-check", `--import-map=${map}`, "evals/career/tasks/run.ts", "--brain", brain, "--model", "fake", "--label", `ci-${brain}${extra.length ? "-mutated" : ""}`, "--out", out, ...extra], stdout: "piped", stderr: "piped" }).output();
  const log = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  if (!p.success) throw new Error(`${brain}: exit ${p.code}\n${log.slice(-3000)}`);
  console.log(log.trim().split("\n").slice(-2).join("\n"));
  const r = JSON.parse(await Deno.readTextFile(out));
  await Deno.remove(out);
  return r;
}

Deno.test({ name: "task-completion eval, fake model: no brain breaks an invariant; the planner keeps single asks, never goes backwards, and the eval catches a dropped part", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const [router, staged, planner, agent, mutated] = await Promise.all([run("router"), run("staged"), run("planner"), run("agent"), run("planner", ["--mutate", "drop_last", "--only", MUTATED.join(",")])]);
  const all = { router, staged, planner, agent };
  console.log(`TASK COMPLETION (fake model, ${planner.total} tasks): ${Object.entries(all).map(([k, r]) => `${k} ${r.passed}/${r.total} (${Math.round(r.rate * 100)}%)`).join(" · ")}`);
  for (const [k, r] of Object.entries(all)) {
    eq([r.total, r.stopped], [57, null], `${k} ran every task`);
    eq(r.items.filter((x) => x.failed.some((f) => f.startsWith("INVARIANT"))).map((x) => `${x.id}: ${x.failed.join("; ")}`), [], `${k}: no invariant broken`);
  }
  const single = (r: Run) => r.items.filter((x) => x.family.startsWith("single:")).map((x) => `${x.id}:${x.pass}`);
  eq(single(planner), single(router), "single asks: the planner leaves today's chain exactly as it is");
  const passing = new Set(planner.items.filter((x) => x.pass).map((x) => x.id));
  eq(PLANNER_FLOOR.filter((id) => !passing.has(id)), [], "planner completions never go backwards");
  eq(mutated.items.filter((x) => x.pass).map((x) => x.id), [], "every plan missing its last part is caught by the eval");
  assert(mutated.items.length === MUTATED.length);
} });
