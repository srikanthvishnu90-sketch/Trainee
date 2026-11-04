// gate (core) runs its node suites in parallel shards (2026-10-30; scripts/node-shards.cjs). Every core suite the gate
// selects runs in exactly one shard, the workflow's matrix matches the shard count the gate is told to use, the
// duration table names only real files, and the packing is deterministic and balanced.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { assignShards, shardOf, verify, loadTable, durationOf } = require("../scripts/node-shards.cjs");

const ROOT = path.join(__dirname, "..");
const COUNT = 2;
const BALANCE = 1.3;
const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

// The gate's own core selection, printed by its verify mode (no step runs).
function coreSuites() {
  const out = execFileSync("bash", ["scripts/gate.sh"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, GATE_PARTITION: "core", GATE_CORE_VERIFY: String(COUNT) },
  });
  const m = /^(\d+) core node suites, each in exactly one of (\d+) shards$/m.exec(out);
  assert.ok(m, out);
  assert.equal(Number(m[2]), COUNT);
  return Number(m[1]);
}

// The gate's own core selection (GATE_CORE_LIST prints it and stops; no step runs).
function coreList() {
  const out = execFileSync("bash", ["scripts/gate.sh"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, GATE_PARTITION: "core", GATE_CORE_LIST: "1" },
  });
  return out.split("\n").filter((l) => /^tests\//.test(l));
}

test("every core node suite the gate selects is in exactly one shard", () => {
  const n = coreSuites();
  assert.ok(n > 200, `suspiciously few core suites: ${n}`);
  const listed = coreList();
  const files = [];
  for (let i = 1; i <= COUNT; i++) files.push(...shardOf(listed, i, COUNT));
  assert.equal(files.length, n);
  assert.equal(new Set(files).size, n);
  assert.ok(files.includes("tests/career-ci-core-shards.test.cjs"), "this suite is itself gated");
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test("the workflow runs COUNT core shards and its aggregate verifies COUNT", () => {
  const job = /\n  gate-core-shard:\n[\s\S]*?\n  gate:\n/.exec(yml);
  assert.ok(job, "gate-core-shard job before the gate (core) aggregate");
  assert.match(job[0], new RegExp(`shard: \\[${Array.from({ length: COUNT }, (_, i) => i + 1).join(", ")}\\]`));
  assert.match(job[0], new RegExp(`GATE_CORE_SHARD: \\$\\{\\{ matrix\\.shard \\}\\}/${COUNT}\\n`));
  assert.match(job[0], new RegExp(`name: gate \\(core shard \\$\\{\\{ matrix\\.shard \\}\\}/${COUNT}\\)`));
  const agg = /\n  gate:\n    name: gate \(core\)\n[\s\S]*?\n  gate-browser:\n/.exec(yml);
  assert.ok(agg, "the required check name gate (core) is the aggregate");
  assert.match(agg[0], /needs: gate-core-shard\n/);
  assert.match(agg[0], /if: always\(\)\n/);
  assert.match(agg[0], /test "\$\{\{ needs\.gate-core-shard\.result \}\}" = success/);
  assert.match(agg[0], new RegExp(`GATE_PARTITION=core GATE_CORE_VERIFY=${COUNT} bash scripts/gate.sh`));
});

test("the duration table names only existing files with measured numbers, and the packing is balanced and deterministic", () => {
  const t = loadTable();
  for (const [f, v] of Object.entries(t.files)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `scripts/core-shard-durations.json names a missing file: ${f}`);
    assert.ok(Number.isFinite(v) && v >= 0, f);
  }
  const files = [...new Set(coreList())];
  const shards = assignShards(files, COUNT, t);
  const mean = shards.reduce((s, x) => s + x.seconds, 0) / COUNT;
  const report = shards.map((s, i) => `${i + 1}: ${s.seconds.toFixed(0)} s`).join(", ");
  for (const s of shards) assert.ok(s.seconds <= BALANCE * mean, `a core shard is over ${BALANCE}x the mean: ${report}`);
  const again = assignShards([...files].reverse(), COUNT, t);
  assert.deepEqual(again.map((s) => s.files), shards.map((s) => s.files));
  const longest = Math.max(...files.map((f) => durationOf(f, t)));
  assert.ok(longest <= BALANCE * mean, `one suite takes ${longest} s, over ${BALANCE}x the mean shard`);
});

test("packing units: longest first to the least-loaded shard, shard 1 carries the reserve, unknown files count as the default", () => {
  const t = { default_s: 5, reserve_s: 4, files: { a: 10, b: 9, c: 8, d: 2, e: 1 } };
  const s = assignShards(["e", "d", "c", "b", "a", "x"], 3, t);
  // reserve 4 -> shard 1 starts at 4; a(10)->2, b(9)->3, c(8)->1 (12), x(5)->3 (14)? no: loads 12,10,9 -> x->3 (14),
  // d(2)->2 (12), e(1)->1 or 2 (12,12 -> lowest: 1, 13)
  assert.deepEqual(s.map((x) => [x.files, x.seconds]), [[["c", "e"], 13], [["a", "d"], 12], [["b", "x"], 14]]);
  assert.throws(() => shardOf(["a"], 0, 3, t));
  assert.throws(() => verify(["a"], 2, t), /empty/);
  assert.equal(verify(["a", "b", "a"], 2, t), 2);
});

test("the durations reporter writes each file's seconds and leaves TAP and the exit code alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-shards-"));
  try {
    fs.writeFileSync(path.join(dir, "p.test.cjs"), 'require("node:test")("p", async () => { await new Promise((r) => setTimeout(r, 150)); });\n');
    fs.writeFileSync(path.join(dir, "f.test.cjs"), 'require("node:test")("f", () => { throw new Error("no"); });\n');
    const out = path.join(dir, "d.jsonl");
    let stdout = "", status = 0;
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    try {
      stdout = execFileSync(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap", "--test-reporter-destination=stdout",
        `--test-reporter=${path.join(ROOT, "scripts", "node-test-durations.mjs")}`, `--test-reporter-destination=${out}`, "p.test.cjs", "f.test.cjs"],
      // NODE_TEST_CONTEXT (set by the runner this suite is under) would turn the child into a reporting subprocess.
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv });
    } catch (e) { stdout = e.stdout; status = e.status; }
    assert.equal(status, 1, "a failing file still fails the run");
    assert.match(stdout, /^TAP version 13$/m);
    assert.match(stdout, /^not ok \d+ - f$/m);
    const rows = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.file), ["f.test.cjs", "p.test.cjs"]);
    assert.ok(rows[1].seconds >= 0.1, JSON.stringify(rows));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
