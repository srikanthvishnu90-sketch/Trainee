// D-034, the deploy standard's evidence: what the pipeline must produce for scripts/launch/deploy-standard.ts to judge a SHA.
//   S1/S4: ci.yml (with the acceptance job) runs on every push to trunk and release/production, each SHA in its own
//          concurrency group, so no push cancels another SHA's checks; pull requests keep their own runs.
//   S3:    reply code is one list (scripts/launch/reply-code.ts) that covers the brain eval's import closure; a measurement
//          commit maps to the commit it measured through its second parent; --missing-measurement names what to measure;
//          measure-reply.sh builds a measurement commit whose reply code is the measured commit's; deploy-production.yml
//          measures before it judges.
//   S5:    the deploy job's standard step has the deploy's own Supabase secrets, and the audit prints names, never values.
// Each rule has a mutation: the broken input must be caught. Fixture data, temp git repos; no network except `deno info`
// resolving the eval's imports.
// Run: deno test -A --no-check tests/architect/deploy-evidence.test.ts
import assertNode from "node:assert/strict";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import { liveSources, missingMeasurement, REPLY_CODE as STANDARD_REPLY_CODE, s3, type Sources } from "../../scripts/launch/deploy-standard.ts";
import { isReplyCode, MEASURE_ROOTS, REPLY_CODE } from "../../scripts/launch/reply-code.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const read = (p: string) => Deno.readTextFileSync(`${ROOT}/${p}`);

// ------------------------------------------------------------------------------------------------ S1 / S4: ci.yml
// deno-lint-ignore no-explicit-any
type Yaml = any;
export function ciEvidenceProblems(ci: Yaml): string[] {
  const out: string[] = [];
  const on = ci?.on ?? ci?.[true as unknown as string] ?? {};
  const branches: string[] = on?.push?.branches ?? [];
  for (const b of ["trunk", "release/production"]) if (!branches.includes(b)) out.push(`push does not run on ${b}`);
  if (on?.push?.paths || on?.push?.["paths-ignore"]) out.push("push is path-filtered: some SHAs would get no checks");
  if (!("pull_request" in on)) out.push("pull requests no longer run");
  const group = String(ci?.concurrency?.group ?? "");
  if (!/github\.sha/.test(group)) out.push(`concurrency group "${group}" is shared across SHAs: a newer push cancels an older pending one`);
  if (!/pull_request\.number/.test(group)) out.push("pull requests lost their per-PR group");
  const cancel = String(ci?.concurrency?.["cancel-in-progress"] ?? "");
  if (cancel !== "${{ github.event_name == 'pull_request' }}") out.push(`cancel-in-progress is "${cancel}": pushes must never be cancelled`);
  if (!Object.values(ci?.jobs ?? {}).some((j: Yaml) => j?.name === "acceptance (telegram)")) out.push('no "acceptance (telegram)" job (S4)');
  for (const [id, j] of Object.entries(ci?.jobs ?? {}) as [string, Yaml][]) {
    if (typeof j?.if === "string" && /event_name\s*==\s*'pull_request'|github\.event\.pull_request/.test(j.if)) out.push(`job ${id} runs only on pull requests`);
  }
  return out;
}
Deno.test("S1/S4: ci.yml runs every job on pushes to trunk and release/production, one group per SHA, PR runs kept", () => {
  eq(ciEvidenceProblems(parseYaml(read(".github/workflows/ci.yml"))), []);
});
Deno.test("S1/S4 mutations: PR-only, trunk-only, a shared push group, cancelled pushes, a PR-only acceptance job", () => {
  const text = read(".github/workflows/ci.yml");
  const mut = (f: (y: Yaml) => void) => { const y = parseYaml(text); f(y); return ciEvidenceProblems(y); };
  ok(mut((y) => { delete y.on.push; }).some((p) => /push does not run on trunk/.test(p)));
  ok(mut((y) => { y.on.push.branches = ["trunk"]; }).some((p) => /release\/production/.test(p)));
  ok(mut((y) => { y.concurrency.group = "ci-${{ github.event.pull_request.number || github.ref }}"; }).some((p) => /shared across SHAs/.test(p)));
  ok(mut((y) => { y.concurrency["cancel-in-progress"] = true; }).some((p) => /never be cancelled/.test(p)));
  ok(mut((y) => { delete y.on.pull_request; }).some((p) => /pull requests no longer run/.test(p)));
  ok(mut((y) => { y.jobs["acceptance-telegram"].if = "github.event_name == 'pull_request'"; }).some((p) => /acceptance-telegram runs only on pull requests/.test(p)));
  ok(mut((y) => { delete y.jobs["acceptance-telegram"]; }).some((p) => /acceptance \(telegram\)/.test(p)));
});

// ------------------------------------------------------------------------------------------------ S3: reply code
Deno.test("S3: reply code is the one list in reply-code.ts, and the standard uses it", () => {
  eq(STANDARD_REPLY_CODE, REPLY_CODE);
  eq([...REPLY_CODE], [...new Set(REPLY_CODE)].sort(), "sorted, no duplicates");
  for (const p of ["packages/domain", "supabase/functions/agent-chat", "supabase/functions/_shared/agent", "supabase/functions/_shared/router_core.career.js"]) {
    ok(REPLY_CODE.includes(p), `${p} is reply code`);
  }
  for (const p of REPLY_CODE) {
    let exists = true;
    try { Deno.statSync(`${ROOT}/${p}`); } catch { exists = false; }
    ok(exists, `${p} is listed but does not exist (remove it, or the list rots)`);
    ok(MEASURE_ROOTS.some((r) => p.startsWith(`${r}/`)), `${p} is under a measure root, so a measurement commit carries it`);
  }
  ok(isReplyCode("supabase/functions/_shared/agent/research/reply.ts") && isReplyCode("packages/domain/142-career-router.js"));
  ok(!isReplyCode("supabase/functions/_shared/stripe_webhook.ts") && !isReplyCode("supabase/functions/_shared/agentx.ts") && !isReplyCode("docs/x.md"));
});

// The repository files the brain eval loads: deno info's module graph of evals/career/run.ts (its brain imports are literal
// dynamic imports, which the graph includes), local files that exist (the router bundle's comments name sources that do not).
async function evalClosure(): Promise<string[]> {
  const r = await new Deno.Command(Deno.execPath(), { args: ["info", "--json", "evals/career/run.ts"], cwd: ROOT, stdout: "piped", stderr: "piped" }).output();
  ok(r.success, `deno info failed: ${new TextDecoder().decode(r.stderr).slice(0, 400)}`);
  const graph = JSON.parse(new TextDecoder().decode(r.stdout));
  const files = (graph.modules as { specifier: string }[]).map((m) => m.specifier).filter((s) => s.startsWith("file://"))
    .map((s) => decodeURIComponent(new URL(s).pathname).slice(ROOT.length + 1))
    .filter((f) => /^(supabase|packages)\//.test(f))
    .filter((f) => { try { return Deno.statSync(`${ROOT}/${f}`).isFile; } catch { return false; } });
  return [...new Set(files)].sort();
}
const uncovered = (files: string[], covers: (f: string) => boolean) => files.filter((f) => !covers(f) && !/\.(json|cjs)$/.test(f));
Deno.test("S3: every supabase/ or packages/ module the brain eval imports is reply code (a new import must be listed)", async () => {
  const files = await evalClosure();
  ok(files.length > 50, `the eval's closure is ${files.length} files: deno info did not resolve it`);
  ok(files.includes("supabase/functions/agent-chat/career_brain.ts") && files.includes("supabase/functions/_shared/model_gateway.ts"), files.join("\n"));
  eq(uncovered(files, isReplyCode), [], "imported by the eval, not in reply-code.ts");
  // Mutation: drop one listed module and the check names it.
  const minus = REPLY_CODE.filter((p) => p !== "supabase/functions/_shared/model_gateway.ts");
  eq(uncovered(files, (f) => minus.some((p) => f === p || f.startsWith(`${p}/`))), ["supabase/functions/_shared/model_gateway.ts"]);
});

// ------------------------------------------------------------------------------------------------ S3: measurement mapping
const C = "c".repeat(40), P = "b".repeat(40), D = "d".repeat(40), X = "e".repeat(40), Y = "f".repeat(40), Z = "9".repeat(40);
const HEAD = "| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
// One SCORE-LOG row, as evals/career/score-log.ts writes it: the judges column carries each judge's own count (it differs
// pass to pass), the CI run column the harness.
interface RowOpts { set?: string; size?: number; judges?: [number, number]; pair?: string; harness?: string; stopped?: string }
const line = (commit: string, brain: string, passed: number, run: string, o: RowOpts = {}) => {
  const [j1, j2] = o.judges ?? [passed + 1, passed + 2];
  const [m1, m2] = (o.pair ?? "gpt-5-mini,gpt-4.1-mini").split(",");
  return `| 2026-10-31 10:00:00 | ${commit.slice(0, 7)} | ${o.set ?? "dev"} | ${brain} | ${o.size ?? 38} | ${passed} | x% | ${m1} ${j1}, ${m2} ${j2}; both-pass (Instinct scores beside them) | ${o.stopped ?? "no"} | ${run}; harness: ${o.harness ?? "parity 2026-10-26"} |\n`;
};
// A CI run of brain-eval: five passes, one row each (measure-reply.sh asks for five; brain-eval.yml refuses fewer).
const row = (commit: string, brain: string, passed: number, run: string, set = "dev", size = 38, o: RowOpts = {}) =>
  [0, 1, 0, -1, 0].map((d, i) => line(commit, brain, passed + d, run, { set, size, judges: [passed + d + i, passed + d + 2], ...o })).join("");
interface W { log: string | null; trees: Record<string, string>; parents: Record<string, string>; second: Record<string, string>; ancestors: Record<string, string[]>; deployed: string | null }
function world(): W {
  return {
    log: HEAD + row(D, "router", 22, "100") + row(X, "router", 24, "200"),
    // X: a measurement commit on ci/brain-eval, second parent C, C's reply code; it is not on C's line (no descent here).
    trees: { [C]: "T2", [P]: "T1", [D]: "T1", [X]: "T2", [Y]: "T2", [Z]: "T3" },
    parents: { [C]: P, [P]: D, [X]: Z, [Y]: Z },
    second: { [X]: C, [Y]: Z },
    ancestors: {},
    deployed: D,
  };
}
function src(w: W, withSecond = true): Sources {
  const all = [C, P, D, X, Y, Z];
  const s: Sources = {
    checkRuns: async () => [], fileAt: async () => null, lastDeployedSha: async () => w.deployed, firstParent: async () => [],
    pull: async () => null, reviews: async () => [], pullFiles: async () => null, ledger: async () => null,
    scoreLog: async () => w.log,
    resolve: async (rev) => all.find((x) => x.startsWith(rev)) ?? null,
    parent: async (sha) => w.parents[sha] ?? null,
    isAncestor: async (a, b) => a === b || (w.ancestors[b] ?? []).includes(a),
    changed: async (a, b) => w.trees[a] !== w.trees[b],
    tree: async (sha) => w.trees[sha] ?? null,
    firstAdded: async () => null,
    secretsAudit: async () => ({ code: 0, out: "" }),
  };
  if (withSecond) s.secondParent = async (sha) => w.second[sha] ?? null;
  return s;
}
Deno.test("S3: a measurement commit stands for its second parent when their reply code is identical", async () => {
  const r = await s3(src(world()), C, D);
  ok(r.pass, r.summary + "\n" + r.evidence.join("\n"));
  ok(/candidate .*brain commit eeeeeee/.test(r.evidence.join("\n")), r.evidence.join("\n"));
});
Deno.test("S3 mutations: the second-parent rule needs that parent on the candidate's line and identical reply code", async () => {
  let w = world(); w.trees[X] = "T2-realigned"; // the measurement commit's reply code is not C's
  ok(/candidate: no router measurement/.test((await s3(src(w), C, D)).summary));
  w = world(); w.second[X] = Z; // it measured another commit
  ok(/candidate: no router measurement/.test((await s3(src(w), C, D)).summary));
  w = world(); w.log = HEAD + row(D, "router", 22, "100") + row(Y, "router", 24, "200"); // Y's second parent is not C
  ok(/candidate: no router measurement/.test((await s3(src(w), C, D)).summary));
  // Without the rule (a Sources with no secondParent) X does not count: the rule is what maps it.
  ok(/candidate: no router measurement/.test((await s3(src(world(), false), C, D)).summary));
});
Deno.test("--missing-measurement: the candidate first, then the deployed SHA on the candidate's set, then nothing", async () => {
  let w = world(); w.log = HEAD + row(D, "router", 22, "100");
  eq((await missingMeasurement(src(w), C, D)).sha, C, "candidate unmeasured");
  w = world(); w.log = HEAD + row(X, "router", 24, "200");
  eq((await missingMeasurement(src(w), C, D)).sha, D, "deployed unmeasured");
  w = world(); w.log = HEAD + row(X, "router", 24, "200") + row(D, "router", 22, "100", "heldout");
  eq((await missingMeasurement(src(w), C, D)).sha, D, "deployed measured only on another set");
  w = world(); w.log = HEAD + row(X, "router", 24, "200") + row(D, "agent", 30, "100");
  eq((await missingMeasurement(src(w), C, D)).sha, D, "deployed measured only for another brain");
  const both = await missingMeasurement(src(world()), C, D);
  eq(both.sha, null, both.why);
  ok(/both measured: candidate by CI run 200, deployed by CI run 100/.test(both.why), both.why);
  w = world(); w.log = HEAD + row(C, "router", 24, "200") + row(D, "router", 22, "100", "dev", 40);
  eq((await missingMeasurement(src(w), C, D)).sha, D, "deployed measured on another set size");
});

// ------------------------------------------------------------------------------------------------ S3: comparable measurements
// A measurement is one CI run's five qualifying passes (stopped "no": a STOPPED or NOT A SCORE row, or a pass that crashed
// and wrote no row, does not count), all on one set, size, harness and judge pair. The deployed side counts only on the
// candidate's set, size, harness and judges: otherwise --missing-measurement names the deployed SHA, to measure it again
// under the current harness.
Deno.test("S3: exactly five qualifying passes make a measurement; stopped and judge-error rows are not scores", async () => {
  const cand = async (log: string) => (await missingMeasurement(src({ ...world(), log: HEAD + row(D, "router", 22, "100") + log }), C, D)).sha;
  eq(await cand(row(X, "router", 24, "200")), null, "five passes: measured");
  eq(await cand(line(X, "router", 24, "200", { stopped: "STOPPED" }) + line(X, "router", 24, "200", { stopped: "NOT A SCORE: 3 judge errors" })), C, "a run of stopped and judge-error passes is no measurement");
  // Exactly five qualifying passes: a crashed pass writes no row, a stopped or judge-error pass does not qualify.
  const five = row(X, "router", 24, "200").split("\n").filter(Boolean);
  eq(await cand(five.slice(0, 4).join("\n") + "\n"), C, "four passes (one crashed, no row): no measurement");
  eq(await cand(five.join("\n") + "\n" + five[0] + "\n"), C, "six passes in one run: not a five-pass measurement");
  eq(await cand(five.slice(0, 4).join("\n") + "\n" + line(X, "router", 24, "200", { stopped: "STOPPED" })), C, "four and a stopped pass: no measurement");
  eq(await cand(five.slice(0, 4).join("\n") + "\n" + line(X, "router", 24, "200", { stopped: "NOT A SCORE: 3 judge errors" })), C, "four and a judge-error pass: no measurement");
  const depFour = { ...world(), log: HEAD + row(D, "router", 22, "100").split("\n").slice(0, 4).join("\n") + "\n" + row(X, "router", 24, "200") };
  eq((await missingMeasurement(src(depFour), C, D)).sha, D, "deployed with four passes: measure it again");
  // A sixth pass that stopped (0 passed) beside the five: the mean is over the five, not six.
  const w = { ...world(), log: HEAD + row(D, "router", 22, "100") + row(X, "router", 24, "200") + line(X, "router", 0, "200", { stopped: "STOPPED" }) + line(X, "router", 0, "200", { stopped: "NOT A SCORE: 38 judge errors" }) };
  const r = await s3(src(w), C, D);
  ok(r.pass, r.summary);
  ok(/mean of 5 passes of CI run 200/.test(r.evidence.join("\n")), r.evidence.join("\n"));
  // The mean is over the five: 24+25+24+23+24 = 120 of 5*38 against 22+23+22+21+22 = 110.
  ok(/candidate \S+: 63\.2%/.test(r.evidence[0]) && /deployed +\S+: 57\.9%/.test(r.evidence[1]), r.evidence.join("\n"));
});
Deno.test("S3: the deployed measurement counts only under the candidate's harness and judges; else it is measured again", async () => {
  const w = (dep: string) => ({ ...world(), log: HEAD + dep + row(X, "router", 24, "200", "dev", 38, { harness: "parity 2026-10-31" }) });
  // Deployed measured only under the older harness: not comparable.
  let m = await missingMeasurement(src(w(row(D, "router", 22, "100"))), C, D);
  eq(m.sha, D, m.why);
  ok(/harness/.test(m.why), m.why);
  let r = await s3(src(w(row(D, "router", 22, "100"))), C, D);
  ok(!r.pass && /deployed: /.test(r.summary) && /harness/.test(r.summary), r.summary);
  // Re-measured under the current harness (a later run): comparable, and that run is the one compared.
  const both = row(D, "router", 30, "100") + row(D, "router", 22, "300", "dev", 38, { harness: "parity 2026-10-31" });
  m = await missingMeasurement(src(w(both)), C, D);
  eq(m.sha, null, m.why);
  r = await s3(src(w(both)), C, D);
  ok(r.pass && /deployed .*CI run 300/.test(r.evidence.join("\n")), r.evidence.join("\n"));
  // Another judge pair on the deployed side: not comparable either.
  const judged = { ...world(), log: HEAD + row(D, "router", 22, "100", "dev", 38, { pair: "gpt-5-mini,gpt-4o-mini" }) + row(X, "router", 24, "200") };
  m = await missingMeasurement(src(judged), C, D);
  eq(m.sha, D, m.why);
  ok(/judges/.test(m.why), m.why);
  ok(!(await s3(src(judged), C, D)).pass);
  // Each judge's own count differs pass to pass (the default rows): the same pair is still the same judges.
  eq((await missingMeasurement(src(world()), C, D)).sha, null);
  // Within one run the five passes share a harness: a run whose passes disagree is no measurement.
  const mixed = row(X, "router", 24, "200").split("\n").filter(Boolean);
  mixed[4] = line(X, "router", 24, "200", { harness: "something else" }).trim();
  eq((await missingMeasurement(src({ ...world(), log: HEAD + row(D, "router", 22, "100") + mixed.join("\n") + "\n" }), C, D)).sha, C);
  // Five on one harness and a sixth on another, in one run: still not one comparable five-pass measurement.
  const sixth = row(X, "router", 24, "200") + line(X, "router", 24, "200", { harness: "something else" });
  eq((await missingMeasurement(src({ ...world(), log: HEAD + row(D, "router", 22, "100") + sixth }), C, D)).sha, C);
});

// ------------------------------------------------------------------------------------------------ S3: live git
async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped", env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).output();
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}
async function put(dir: string, files: Record<string, string | null>) {
  for (const [f, v] of Object.entries(files)) {
    if (v === null) { await Deno.remove(`${dir}/${f}`); continue; }
    await Deno.mkdir(`${dir}/${f.split("/").slice(0, -1).join("/")}`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${f}`, v);
  }
}
async function commit(dir: string, msg: string, files: Record<string, string | null>) {
  await put(dir, files);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", msg);
  return await sh(dir, "rev-parse", "HEAD");
}
// A repo shaped like this one: trunk A -> B (a non-reply change) -> C (a reply change), and ci/brain-eval (the harness, the
// score log) that merged A long ago.
async function repo() {
  const dir = await Deno.makeTempDir({ prefix: "deploy-evidence-" });
  await sh(dir, "init", "-q", "-b", "trunk");
  const A = await commit(dir, "A", {
    "packages/domain/142-career-router.js": "router v1\n", "packages/capabilities/registry.js": "caps\n",
    "supabase/functions/_shared/model_gateway.ts": "gw v1\n", "supabase/functions/_shared/stripe_webhook.ts": "stripe v1\n",
    "supabase/functions/agent-chat/career_brain.ts": "brain v1\n", "evals/career/run.ts": "harness trunk\n", "README": "r\n",
  });
  const B = await commit(dir, "B", { "supabase/functions/_shared/stripe_webhook.ts": "stripe v2\n", "README": "r2\n" });
  const Cc = await commit(dir, "C", { "supabase/functions/_shared/model_gateway.ts": "gw v2\n" });
  await sh(dir, "checkout", "-q", "-b", "ci/brain-eval", A);
  const tip = await commit(dir, "eval data", {
    "evals/career/run.ts": "harness branch\n", "evals/career/SCORE-LOG.md": "log\n", "evals/career/eval-request.json": "{}\n",
    "supabase/functions/_shared/agent/stale.ts": "a file only the branch has\n", "packages/domain/142-career-router.js": "router realigned\n",
  });
  await sh(dir, "checkout", "-q", "trunk");
  return { dir, A, B, C: Cc, tip };
}
async function inDir<T>(dir: string, f: () => Promise<T>): Promise<T> {
  const was = Deno.cwd();
  Deno.chdir(dir);
  try { return await f(); } finally { Deno.chdir(was); }
}
Deno.test("S3 live sources: reply-code change and identity over the whole list; a merge's second parent", async () => {
  const { dir, A, B, C: Cc } = await repo();
  try {
    await inDir(dir, async () => {
      const s = liveSources({ repo: "x/y", token: "t" });
      eq(await s.changed(A, B, REPLY_CODE), false, "B changed only stripe_webhook.ts and README: not reply code");
      eq(await s.tree(A, REPLY_CODE), await s.tree(B, REPLY_CODE));
      eq(await s.changed(B, Cc, REPLY_CODE), true, "C changed model_gateway.ts");
      ok((await s.tree(B, REPLY_CODE)) !== (await s.tree(Cc, REPLY_CODE)));
      eq(await s.tree(A, ["no/such/path"]), null);
      eq(await s.secondParent!(Cc), null);
      await sh(dir, "checkout", "-q", "-b", "m", "ci/brain-eval");
      await sh(dir, "merge", "-q", "--no-ff", "-X", "theirs", "-m", "merge", Cc);
      eq(await s.secondParent!(await sh(dir, "rev-parse", "HEAD")), Cc);
    });
  } finally { await Deno.remove(dir, { recursive: true }); }
});

// ------------------------------------------------------------------------------------------------ S3: measure-reply.sh
async function build(dir: string, sha: string, tip: string, script = `${ROOT}/scripts/launch/measure-reply.sh`) {
  // The script cds to its repository root: run a copy of scripts/launch from inside the temp repo.
  await Deno.mkdir(`${dir}/scripts/launch`, { recursive: true });
  for (const f of ["measure-reply.sh", "reply-code.ts"]) await Deno.copyFile(script.replace("measure-reply.sh", f), `${dir}/scripts/launch/${f}`);
  const r = await new Deno.Command("bash", { args: [`${dir}/scripts/launch/measure-reply.sh`, "--build-only", sha, tip], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr) };
}
Deno.test("measure-reply.sh: the measurement commit is the branch's harness with the measured commit's reply code, second parent the measured commit", async () => {
  const { dir, C: Cc, tip } = await repo();
  try {
    const r = await build(dir, Cc, "ci/brain-eval");
    eq(r.code, 0, r.err);
    const m = r.out;
    eq(await sh(dir, "rev-parse", `${m}^1`), tip, "first parent: the ci/brain-eval tip");
    eq(await sh(dir, "rev-parse", `${m}^2`), Cc, "second parent: the measured commit");
    eq(await sh(dir, "diff", "--name-only", Cc, m, "--", "packages", "supabase/functions"), "", "packages/ and supabase/functions/ are C's, file for file");
    eq(await sh(dir, "show", `${m}:evals/career/run.ts`), "harness branch", "the harness stays the branch's");
    eq(await sh(dir, "show", `${m}:evals/career/SCORE-LOG.md`), "log");
    const req = JSON.parse(await sh(dir, "show", `${m}:evals/career/eval-request.json`));
    eq([req.action, req.set, req.brains, req.passes], ["eval", "dev", ["router"], 5]);
    // The branch-only file under a measure root is gone: it is not the measured commit's code.
    ok((await sh(dir, "ls-tree", "-r", "--name-only", m)).split("\n").every((f) => f !== "supabase/functions/_shared/agent/stale.ts"));
    eq(await sh(dir, "rev-parse", "ci/brain-eval"), tip, "nothing was moved or pushed");
    eq(await sh(dir, "status", "--porcelain", "--untracked-files=no"), "", "the work tree and index are untouched");
  } finally { await Deno.remove(dir, { recursive: true }); }
});
Deno.test("measure-reply.sh mutation: a measure root that misses reply code is refused (the commit would measure other code)", async () => {
  const { dir, C: Cc } = await repo();
  try {
    // A copy of the script whose roots leave packages/ to the branch: packages/domain stays "router realigned", not C's.
    const tmp = await Deno.makeTempDir({ prefix: "measure-mut-" });
    await Deno.writeTextFile(`${tmp}/measure-reply.sh`, read("scripts/launch/measure-reply.sh"));
    await Deno.writeTextFile(`${tmp}/reply-code.ts`, read("scripts/launch/reply-code.ts").replace('MEASURE_ROOTS = ["packages", "supabase/functions"]', 'MEASURE_ROOTS = ["supabase/functions"]'));
    ok((await Deno.readTextFile(`${tmp}/reply-code.ts`)).includes('MEASURE_ROOTS = ["supabase/functions"]'), "the mutation applied");
    const r = await build(dir, Cc, "ci/brain-eval", `${tmp}/measure-reply.sh`);
    ok(r.code !== 0, `refused: ${r.out}`);
    ok(/reply code differs/.test(r.err), r.err);
    await Deno.remove(tmp, { recursive: true });
  } finally { await Deno.remove(dir, { recursive: true }); }
});

// ------------------------------------------------------------------------------------------------ deploy-production.yml
export function deployWorkflowProblems(wf: Yaml): string[] {
  const out: string[] = [];
  const jobs = wf?.jobs ?? {};
  const m = jobs.measure;
  if (!m) return ["no measure job: S3's missing measurement is never made"];
  if (m.permissions?.contents !== "write" || m.permissions?.actions !== "write") out.push("measure needs contents: write (the ci/brain-eval push) and actions: write (the dispatch)");
  if (m.environment) out.push("measure runs in an environment: it would wait for the owner's approval before the standard");
  const steps = (m.steps ?? []).map((s: Yaml) => String(s.run ?? "")).join("\n");
  if (!/--missing-measurement/.test(steps) || !/measure-reply\.sh/.test(steps)) out.push("measure does not ask what is missing and measure it");
  const st = jobs.standard;
  const needs = [st?.needs ?? []].flat();
  if (!needs.includes("measure") || !needs.includes("preflight")) out.push("the standard does not wait for the measurement and the preflight");
  if (!/!cancelled\(\)/.test(String(st?.if ?? "")) || !/needs\.preflight\.result == 'success'/.test(String(st?.if ?? ""))) out.push("the standard must run after a failed measurement (S3 says why) and never after a failed preflight");
  if (!/--checks S1,S2,S3,S4/.test((st?.steps ?? []).map((s: Yaml) => String(s.run ?? "")).join("\n"))) out.push("the standard job does not judge S1-S4");
  if ([jobs.deploy?.needs ?? []].flat().join() !== "standard") out.push("deploy does not need the standard");
  // S5: the deploy job's standard step runs S1-S5 with the deploy's own Supabase secrets, after the CLIs it needs.
  const ds: Yaml[] = jobs.deploy?.steps ?? [];
  const judge = ds.findIndex((s) => /deploy-standard\.ts/.test(String(s.run ?? "")));
  const golive = ds.find((s) => s.id === "golive");
  if (judge < 0 || !golive) return [...out, "the deploy job has no standard step or no go-live step"];
  const j = ds[judge];
  if (/--checks/.test(String(j.run))) out.push("the deploy job's standard step does not run every check (S5 needs it)");
  for (const k of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF"]) {
    if (!j.env?.[k] || j.env[k] !== golive.env?.[k]) out.push(`the standard step's ${k} is not the go-live step's (${j.env?.[k] ?? "unset"})`);
  }
  for (const k of Object.keys(j.env ?? {})) if (!["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF"].includes(k)) out.push(`the standard step gets ${k}: it needs no other secret`);
  if (/set -x|echo .*\$\{?SUPABASE|printenv|env\b\s*$/.test(String(j.run))) out.push("the standard step prints its environment");
  const before = ds.slice(0, judge).map((s) => String(s.uses ?? ""));
  if (!before.some((u) => u.startsWith("supabase/setup-cli@")) || !before.some((u) => u.startsWith("actions/setup-node@"))) out.push("the supabase CLI and node are not set up before the standard step (S5's audit needs both)");
  return out;
}
Deno.test("deploy-production.yml: measure before judging; S5 with the deploy's own Supabase secrets, nothing printed", () => {
  eq(deployWorkflowProblems(parseYaml(read(".github/workflows/deploy-production.yml"))), []);
});
Deno.test("deploy-production.yml mutations", () => {
  const text = read(".github/workflows/deploy-production.yml");
  const mut = (f: (y: Yaml) => void) => { const y = parseYaml(text); f(y); return deployWorkflowProblems(y).join("\n"); };
  ok(/no measure job/.test(mut((y) => { delete y.jobs.measure; })));
  ok(/contents: write/.test(mut((y) => { y.jobs.measure.permissions.actions = "read"; })));
  ok(/wait for the measurement/.test(mut((y) => { y.jobs.standard.needs = "preflight"; })));
  ok(/after a failed measurement/.test(mut((y) => { delete y.jobs.standard.if; })));
  const step = (y: Yaml) => y.jobs.deploy.steps.find((s: Yaml) => /deploy-standard\.ts/.test(String(s.run ?? "")));
  ok(/SUPABASE_ACCESS_TOKEN is not the go-live step's/.test(mut((y) => { delete step(y).env.SUPABASE_ACCESS_TOKEN; })));
  ok(/SUPABASE_PROJECT_REF is not the go-live step's/.test(mut((y) => { step(y).env.SUPABASE_PROJECT_REF = "${{ secrets.OTHER_REF }}"; })));
  ok(/gets SUPABASE_DB_URL/.test(mut((y) => { step(y).env.SUPABASE_DB_URL = "${{ secrets.SUPABASE_DB_URL }}"; })));
  ok(/prints its environment/.test(mut((y) => { step(y).run = "set -x\n" + step(y).run; })));
  ok(/does not run every check/.test(mut((y) => { step(y).run += " --checks S1,S2,S3,S4"; })));
  ok(/not set up before/.test(mut((y) => { y.jobs.deploy.steps = y.jobs.deploy.steps.filter((s: Yaml) => !String(s.uses ?? "").startsWith("supabase/setup-cli@")); })));
});

// ------------------------------------------------------------------------------------------------ the measure loop, run
// The measure step's own bash, run with stubs: deploy-standard.ts --missing-measurement answers from a script, git fetch is
// a no-op, measure-reply.sh only records what it was asked to measure. What it must do: at most two measurements (the
// candidate, then the deployed SHA), never the same SHA twice in one run (a SHA measured and still unscored fails S3 instead
// of spending again), and stop as soon as nothing is missing.
const measureRun = (wf: Yaml) => String((wf?.jobs?.measure?.steps ?? []).find((s: Yaml) => /--missing-measurement/.test(String(s.run ?? "")))?.run ?? "");
async function runMeasureLoop(script: string, answers: string[]): Promise<{ code: number; measured: string[]; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "measure-loop-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.mkdir(`${dir}/scripts/launch`, { recursive: true });
    await Deno.writeTextFile(`${dir}/answers`, answers.map((a) => `${a}\n`).join(""));
    await Deno.writeTextFile(`${dir}/bin/deno`, `#!/usr/bin/env bash\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/n"\na=$(sed -n "$((n+1))p" "${dir}/answers")\n[ -n "$a" ] && [ "$a" != - ] && echo "measure=$a" && echo "brain=router"\necho "why: stub answer $((n+1))"\n`);
    await Deno.writeTextFile(`${dir}/bin/git`, "#!/usr/bin/env bash\nexit 0\n");
    await Deno.writeTextFile(`${dir}/scripts/launch/measure-reply.sh`, `echo "$1" >> "${dir}/measured"\n`);
    for (const f of ["deno", "git"]) await Deno.chmod(`${dir}/bin/${f}`, 0o755);
    const r = await new Deno.Command("bash", {
      args: ["-e", "-c", script], cwd: dir, clearEnv: true, stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(20_000),
      env: { PATH: `${dir}/bin:${Deno.env.get("PATH")}`, GH_TOKEN: "tok", GITHUB_TOKEN: "tok", GITHUB_SHA: C, GITHUB_RUN_ID: "1" },
    }).output();
    let measured: string[] = [];
    try { measured = (await Deno.readTextFile(`${dir}/measured`)).trim().split("\n").filter(Boolean); } catch { /* none */ }
    return { code: r.code, measured, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
  } finally { await Deno.remove(dir, { recursive: true }); }
}
async function measureLoopProblems(script: string): Promise<string[]> {
  const out: string[] = [];
  if (!script) return ["no measure step"];
  let r = await runMeasureLoop(script, ["-"]);
  if (r.code !== 0 || r.measured.length) out.push(`nothing missing: measured ${r.measured.join(",") || "nothing"}, exit ${r.code}`);
  r = await runMeasureLoop(script, [C, "-"]);
  if (r.code !== 0 || r.measured.join() !== C) out.push(`candidate missing once: measured ${r.measured.join(",")}, exit ${r.code}`);
  r = await runMeasureLoop(script, [C, C, C, C]);
  if (r.measured.join() !== C || r.code === 0 || !/still has no score/.test(r.out)) out.push(`the same SHA still missing after its measurement: measured ${r.measured.length} times, exit ${r.code} (it must fail, not measure again)`);
  r = await runMeasureLoop(script, [C, D, X, Y, Z, P]);
  if (r.measured.join() !== `${C},${D}`) out.push(`a new SHA missing every round: measured ${r.measured.length} times (at most two rounds: the candidate, then the deployed SHA)`);
  return out;
}
Deno.test("deploy-production.yml measure loop, run: at most two rounds, never the same SHA twice, stops when nothing is missing", async () => {
  eq(await measureLoopProblems(measureRun(parseYaml(read(".github/workflows/deploy-production.yml")))), []);
});
Deno.test("deploy-production.yml measure loop mutations: an endless loop, no done_shas guard, no done_shas record", async () => {
  const run = measureRun(parseYaml(read(".github/workflows/deploy-production.yml")));
  const mut = async (from: string | RegExp, to: string) => {
    const m = run.replace(from, to);
    ok(m !== run, `the mutation applied: ${from}`);
    return (await measureLoopProblems(m)).join("\n");
  };
  ok(/at most two rounds/.test(await mut("for round in 1 2; do", "while true; do")));
  ok(/same SHA still missing/.test(await mut(/^ *case " \$\{done_shas:-\} ".*$\n/m, "")));
  ok(/same SHA still missing/.test(await mut(/^ *done_shas="\$\{done_shas:-\} \$need"$\n/m, "")));
});

// ------------------------------------------------------------------------------------------------ S5: no value printed
Deno.test("S5: the secrets audit reads names through the supabase CLI and never prints a value", async () => {
  const bin = await Deno.makeTempDir({ prefix: "fake-supabase-" });
  const SECRET = "sk-THIS-VALUE-MUST-NEVER-PRINT-12345";
  // A fake `supabase secrets list -o json`: names with values and digests, as the real CLI returns digests.
  const names = ["OPENAI_API_KEY", "CAREER_INGEST_SECRET", "INGEST_CONTACT_EMAIL", "CAREER_PROACTIVE_SECRET", "TRAINEE_DELIVER_SECRET", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN"];
  await Deno.writeTextFile(`${bin}/supabase`, `#!/usr/bin/env bash\n[ "$SUPABASE_ACCESS_TOKEN" = "tok-${SECRET}" ] || { echo "no token" >&2; exit 1; }\necho '${JSON.stringify(names.map((n) => ({ name: n, value: SECRET, digest: SECRET })))}'\n`);
  await Deno.chmod(`${bin}/supabase`, 0o755);
  try {
    const run = async (env: Record<string, string>) => {
      const r = await new Deno.Command("bash", { args: ["scripts/launch/secrets-audit.sh", "--features"], cwd: ROOT, clearEnv: true, env: { PATH: `${bin}:${Deno.env.get("PATH")}`, HOME: Deno.env.get("HOME") ?? "/tmp", ...env }, stdout: "piped", stderr: "piped" }).output();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
    };
    const good = await run({ SUPABASE_ACCESS_TOKEN: `tok-${SECRET}`, SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" });
    eq(good.code, 0, good.out);
    ok(/FEATURE telegram\s+ENABLED WIRED/.test(good.out) && /FEATURE whatsapp\s+OFF/.test(good.out), good.out);
    ok(!good.out.includes(SECRET), "a value was printed");
    // Mutation: without the token the CLI fails, and the audit fails closed (exit 2, nothing reported present).
    const noTok = await run({ SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" });
    eq(noTok.code, 2, noTok.out);
    ok(!noTok.out.includes(SECRET));
    const noRef = await run({ SUPABASE_ACCESS_TOKEN: `tok-${SECRET}` });
    eq(noRef.code, 2, noRef.out);
    ok(!noRef.out.includes(SECRET));
  } finally { await Deno.remove(bin, { recursive: true }); }
});
