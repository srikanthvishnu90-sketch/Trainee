// DT-1: the mass-apply outcome eval (evals/career/mass-apply-outcomes/) runs in the gate's node selection. Its Deno tests
// run with --allow-read ONLY: no network, no subprocess, no environment, so the deterministic mode provably calls no model
// and reaches no employer. They check the grader, the gold labels, determinism, and that the committed baseline does not
// get worse (wrong answers, unsafe ready, duplicates, hash, state, receipt and proof checks).
// Check: node --test tests/career-mass-apply-outcomes.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

test("mass-apply outcome eval: deterministic mode passes its own tests with read-only permissions", () => {
  const r = spawnSync(process.env.DENO_BIN || "deno",
    ["test", "--allow-read", "--no-check", "--no-prompt", "evals/career/mass-apply-outcomes/outcomes.test.ts"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
