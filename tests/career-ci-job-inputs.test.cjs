// The CI path filter (scripts/ci/job-inputs.cjs + job-inputs.json) and its open trace (scripts/ci/trace-opens.py):
// a pull request may skip a job only when it changes none of that job's inputs, a push never skips, a doubt runs the job,
// and a job that opens a tracked file outside its list fails.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const ROOT = path.join(__dirname, "..");
const { SPEC, JOBS, decide, fileIn, inputsOf } = require("../scripts/ci/job-inputs.cjs");
const CLI = path.join(ROOT, "scripts", "ci", "job-inputs.cjs");
const TRACE = path.join(ROOT, "scripts", "ci", "trace-opens.py");

test("the list names only paths that exist, and ci.yml has a skippable job for each entry", () => {
  for (const p of [...SPEC.always, ...Object.values(SPEC.jobs).flat()]) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} does not exist`);
  assert.deepEqual(JOBS.sort(), ["coverage", "database"]);
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const j of JOBS) assert.match(ci, new RegExp(`needs\\.changes\\.outputs\\.${j} (!=|==) 'false'`), `ci.yml does not gate on ${j}`);
  assert.match(ci, /node scripts\/ci\/job-inputs\.cjs verify coverage/);
  assert.match(ci, /node scripts\/ci\/job-inputs\.cjs verify database/);
});

test("decide: a push runs everything; a PR runs a job only when it changes one of its inputs; unreadable runs all", () => {
  const all = Object.fromEntries(JOBS.map((j) => [j, "true"]));
  assert.deepEqual(decide({ event: "push", draft: "", files: [] }), { draft: "false", ...all });
  assert.deepEqual(decide({ event: "pull_request", draft: "false", files: null }), { draft: "false", ...all });
  const docsOnly = decide({ event: "pull_request", draft: "false", files: ["docs/architect/DECISIONS.md", "supabase/functions/agent-chat/index.ts"] });
  assert.equal(docsOnly.coverage, "false"); assert.equal(docsOnly.database, "false");
  assert.equal(decide({ event: "pull_request", draft: "false", files: ["supabase/migrations/x.sql"] }).database, "true");
  assert.equal(decide({ event: "pull_request", draft: "false", files: ["scripts/career/render-form.cjs"] }).coverage, "true");
  for (const j of JOBS) assert.equal(decide({ event: "pull_request", draft: "false", files: [".github/workflows/ci.yml"] })[j], "true");
  assert.equal(decide({ event: "pull_request", draft: "true", files: [] }).draft, "true");
  assert.equal(decide({ event: "push", draft: "true", files: [] }).draft, "false");
});

test("fileIn: a directory entry covers what is under it, a file entry only itself", () => {
  const inputs = ["a/b/", "c/d.js"];
  assert.ok(fileIn("a/b/x/y.js", inputs)); assert.ok(fileIn("c/d.js", inputs));
  assert.ok(!fileIn("a/bc/x.js", inputs)); assert.ok(!fileIn("c/d.json", inputs)); assert.ok(!fileIn("a/x.js", inputs));
});

test("changes: a renamed-out input counts (delete + add), read from the test merge commit against its base parent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-inputs-"));
  const git = (...a) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "base");
  fs.mkdirSync(path.join(dir, "supabase/migrations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "supabase/migrations/a.sql"), "select 1;\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "pr");
  fs.mkdirSync(path.join(dir, "attic"));
  git("mv", "supabase/migrations/a.sql", "attic/a.sql"); git("commit", "-q", "-m", "move");
  git("checkout", "-q", "base");
  fs.writeFileSync(path.join(dir, "other.txt"), "x\n"); git("add", "."); git("commit", "-q", "-m", "trunk moved");
  git("merge", "-q", "--no-ff", "-m", "merge", "pr");
  const run = (env) => execFileSync("node", [CLI, "changes"], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.match(run({ EVENT: "pull_request", DRAFT: "false" }), /^database=true$/m);
  assert.match(run({ EVENT: "pull_request", DRAFT: "false" }), /^coverage=false$/m);
  git("checkout", "-q", "HEAD^1"); // not a merge: the changed files cannot be read, so every job runs
  assert.match(run({ EVENT: "pull_request", DRAFT: "false" }), /^coverage=true$/m);
});

test("trace-opens + verify: files opened while the command runs are recorded; one outside the list fails the job", { skip: process.platform !== "linux" }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trace-")), "opens.txt");
  const inside = inputsOf("database").find((p) => p.endsWith(".json")) ?? "tests/fixtures/export-tables.json";
  const r = spawnSync("python3", [TRACE, out, "--", "node", "-e", `require("fs").readFileSync(${JSON.stringify(inside)}); process.exit(3)`], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr); // the command's own exit status
  const lines = fs.readFileSync(out, "utf8").split("\n");
  assert.equal(lines[0], "# complete"); assert.ok(lines.includes(inside), lines.join("\n"));
  assert.ok(!lines.includes("scripts/gate.sh"), "the tracer's own setup walk is not recorded");
  assert.equal(spawnSync("node", [CLI, "verify", "database", out], { cwd: ROOT }).status, 0);
  spawnSync("python3", [TRACE, out, "--", "node", "-e", `require("fs").readFileSync("README.md")`], { cwd: ROOT });
  if (fs.existsSync(path.join(ROOT, "README.md"))) {
    const v = spawnSync("node", [CLI, "verify", "database", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(v.status, 1); assert.match(v.stderr, /README\.md/);
  }
  fs.writeFileSync(out, "# INCOMPLETE the inotify event queue overflowed\n");
  assert.equal(spawnSync("node", [CLI, "verify", "database", out], { cwd: ROOT }).status, 1);
});
