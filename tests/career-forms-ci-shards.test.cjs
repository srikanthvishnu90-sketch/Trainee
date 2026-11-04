"use strict";
// Self-check for scripts/forms-ci-shards.cjs, the forms-ci coverage sharding behind the required
// "gate (forms-ci coverage)" check (PR #209). It runs in the gate's core partition (tests/career-*.test.cjs) and
// drives nothing: the suite is listed statically and the shard reports are synthetic.
// Pinned here: the shards cover every test of the suite; the read-only proof is in every shard; a renamed proof
// fails both `args` and `verify` (review of #209: it used to drop out of shards 1-4 with a green check); a proof
// that fails, or is missing, in any one shard fails `verify`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const shards = require("../scripts/forms-ci-shards.cjs");

const SCRIPT = path.join(__dirname, "..", "scripts", "forms-ci-shards.cjs");
const COUNT = shards.SHARDS.length + 1;
const NAMES = shards.listTests();
const RENAMED = NAMES.map((n) => (n === shards.READ_ONLY ? n + " (renamed)" : n));

// What node's own pattern flags select for one shard (node compiles each flag value with new RegExp).
function selected(names, argv) {
  const get = (k) => argv.filter((x) => x.startsWith(k)).map((x) => new RegExp(x.slice(k.length)));
  const inc = get("--test-name-pattern="), skip = get("--test-skip-pattern=");
  return names.filter((n) => (inc.length ? inc.some((r) => r.test(n)) : true) && !skip.some((r) => r.test(n)));
}
// One synthetic report per shard, as if every selected test passed.
function goodReports(names = NAMES) {
  const out = [];
  for (let s = 1; s <= COUNT; s++) out.push({ file: `shard-${s}.json`, passed: selected(names, shards.args(s, COUNT, NAMES)), failed: [], durations: {} });
  return out;
}

test("forms-ci shards: every test of the suite is selected by some shard, and the read-only proof by all of them", () => {
  assert.ok(NAMES.length >= 27, "the suite listing came back short: " + NAMES.length);
  assert.ok(NAMES.includes(shards.READ_ONLY));
  const seen = new Map();
  for (let s = 1; s <= COUNT; s++) {
    const sel = selected(NAMES, shards.args(s, COUNT, NAMES));
    assert.ok(sel.includes(shards.READ_ONLY), `shard ${s} does not select the read-only proof`);
    for (const n of sel) seen.set(n, (seen.get(n) || 0) + 1);
  }
  assert.deepEqual(NAMES.filter((n) => !seen.has(n)), [], "tests no shard selects");
  for (const [n, c] of seen) if (n !== shards.READ_ONLY) assert.equal(c, 1, `${n} is selected by ${c} shards`);
  assert.deepEqual(shards.verifyReports(NAMES, goodReports()).errors, []);
});

test("forms-ci shards: a renamed read-only proof fails args and verify", () => {
  assert.throws(() => shards.checkTable(RENAMED), /read-only proof .* is not a test in the suite/);
  for (let s = 1; s <= COUNT; s++) assert.throws(() => shards.args(s, COUNT, RENAMED), /read-only proof/);
  // Even with every shard green on the renamed suite (the proof silently gone from shards 1..N-1), verify fails.
  const reports = [];
  for (let s = 1; s <= COUNT; s++) {
    const argv = s < COUNT ? [...shards.SHARDS[s - 1]].map((n) => `--test-name-pattern=^${n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`)
      : shards.SHARDS.flat().map((n) => `--test-skip-pattern=^${n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
    reports.push({ file: `shard-${s}.json`, passed: selected(RENAMED, argv), failed: [], durations: {} });
  }
  const { errors } = shards.verifyReports(RENAMED, reports);
  assert.ok(errors.some((e) => /read-only proof .* is not a test in the suite/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /read-only proof did not pass in shard report/.test(e)), errors.join("\n"));
});

test("forms-ci shards: the read-only proof failing, or missing, in one shard fails verify", () => {
  for (let s = 0; s < COUNT; s++) {
    const failedIn = goodReports();
    failedIn[s].passed = failedIn[s].passed.filter((n) => n !== shards.READ_ONLY);
    failedIn[s].failed = [shards.READ_ONLY];
    const a = shards.verifyReports(NAMES, failedIn).errors;
    assert.ok(a.some((e) => /failed in a shard/.test(e)) && a.some((e) => /read-only proof did not pass/.test(e)), `shard ${s + 1}: ${a.join("\n")}`);
    const missingIn = goodReports();
    missingIn[s].passed = missingIn[s].passed.filter((n) => n !== shards.READ_ONLY);
    const b = shards.verifyReports(NAMES, missingIn).errors;
    assert.ok(b.some((e) => /read-only proof did not pass in shard report\(s\) shard-/.test(e)), `shard ${s + 1}: ${b.join("\n")}`);
  }
});

test("forms-ci shards: verify fails on a missing test, a missing shard report, or any failed test", () => {
  const r1 = goodReports(); r1[COUNT - 1].passed = r1[COUNT - 1].passed.filter((n) => !n.startsWith("widget-gap guard: an unfilled"));
  assert.ok(shards.verifyReports(NAMES, r1).errors.some((e) => /did not pass in any shard/.test(e)));
  assert.ok(shards.verifyReports(NAMES, goodReports().slice(1)).errors.some((e) => /expected \d+ shard reports/.test(e)));
  const r3 = goodReports(); r3[0].failed = ["x"];
  assert.ok(shards.verifyReports(NAMES, r3).errors.some((e) => /failed in a shard/.test(e)));
});

test("forms-ci shards: the CLI verify exits non-zero when one shard's proof failed, zero when all passed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forms-ci-shards-"));
  const write = (reports) => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); for (const r of reports) fs.writeFileSync(path.join(dir, r.file), JSON.stringify(r)); };
  write(goodReports());
  assert.match(execFileSync(process.execPath, [SCRIPT, "verify", dir]).toString(), new RegExp(`read-only proof passed in ${COUNT} of ${COUNT} shards`));
  const bad = goodReports(); bad[1].passed = bad[1].passed.filter((n) => n !== shards.READ_ONLY); bad[1].failed = [shards.READ_ONLY];
  write(bad);
  const r = spawnSync(process.execPath, [SCRIPT, "verify", dir]);
  assert.equal(r.status, 1, r.stdout.toString());
  assert.match(r.stdout.toString(), /::error title=forms-ci shards::.*read-only proof did not pass/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forms-ci shards: the TAP report counts top-level points once and ignores skips", () => {
  const tap = ["ok 1 - a", "  ---", "  duration_ms: 2500.1", "  ...", "not ok 2 - b", "ok 3 - c # SKIP x", "  ok 1 - nested", "not ok 2 - b"].join("\n");
  const r = shards.parseTap(tap);
  assert.deepEqual(r.passed, ["a"]);
  assert.deepEqual(r.failed, ["b"]);
  assert.equal(r.durations.a, 3);
});
