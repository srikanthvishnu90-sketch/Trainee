"use strict";
// Run the independent runner/manifest byte-for-byte. Only its original machine's
// absolute host path is remapped; source/ points to this checkout. No assertion,
// fixture, result rule or module 130 code is rewritten. On trunk (after WO-067) all 22 pass, H20 included.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."), fixture = path.join(root, "tests/fixtures/capability2-independent");
const args = process.argv.slice(2), option = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const hostRoot = path.resolve(option("--host-root") || root);
const output = path.resolve(option("--evidence-dir") || path.join(os.tmpdir(), "capability2-frozen-evidence"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "capability2-frozen-"));
const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
try {
  fs.mkdirSync(path.join(temp, "evidence")); fs.mkdirSync(output, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(fixture, "freeze-metadata.json")));
  if (hash(path.join(fixture, "INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json")) !== meta.manifest_sha256 || hash(path.join(fixture, "run_independent_holdouts.cjs")) !== meta.runner_sha256) throw Error("Frozen inputs changed");
  for (const name of ["INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json", "run_independent_holdouts.cjs"]) fs.copyFileSync(path.join(fixture, name), path.join(temp, name));
  fs.symlinkSync(root, path.join(temp, "source"), "dir");
  const from = "/workspace/upmore-muse-reliability-20261015/candidate/supabase/functions/_shared/career_host.js";
  const target = path.join(hostRoot, "supabase/functions/_shared/career_host.js");
  fs.writeFileSync(path.join(temp, "host-path-alias.cjs"), `const M=require('node:module'),resolve=M._resolveFilename;M._resolveFilename=function(r,...rest){return resolve.call(this,r===${JSON.stringify(from)}?${JSON.stringify(target)}:r,...rest);};`);
  const run = spawnSync(process.execPath, ["--require", path.join(temp, "host-path-alias.cjs"), path.join(temp, "run_independent_holdouts.cjs")], { cwd: temp, encoding: "utf8" });
  fs.writeFileSync(path.join(output, "original-runner.log"), run.stdout + run.stderr);
  if (run.status !== 0) throw Error("Original runner could not complete: " + run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(temp, "evidence/INDEPENDENT_HOLDOUT_RESULTS_v1.json")));
  fs.copyFileSync(path.join(temp, "evidence/INDEPENDENT_HOLDOUT_RESULTS_v1.json"), path.join(output, "original-results.json"));
  const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const sourceFiles = ["packages/domain/154-career-recommendations.js", "packages/domain/142-career-router.js", "packages/domain/130-career-onboarding.js"];
  const envelope = { executed_source_sha: sourceSha, source_hashes: Object.fromEntries(sourceFiles.map((p) => [p, hash(path.join(root, p))])), frozen_manifest_source_sha: report.source_sha, manifest_sha256: meta.manifest_sha256, runner_sha256: meta.runner_sha256, host_file: target, host_sha256: hash(target), pass: report.pass, fail: report.fail, failures: report.results.filter((r) => r.status === "FAIL"), rules_modified: false, source_alias_only: true, live_verification: false };
  fs.writeFileSync(path.join(output, "execution.json"), JSON.stringify(envelope, null, 2) + "\n");
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, failures: envelope.failures.map((r) => r.id), executed_source_sha: sourceSha, evidence: output }, null, 2));
  if (report.fail) process.exitCode = 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
