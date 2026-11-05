#!/usr/bin/env node
// The CI path filter (scripts/ci/job-inputs.json) and its proof.
//
//   node scripts/ci/job-inputs.cjs changes
//     For the `changes` job in ci.yml. Prints GITHUB_OUTPUT lines: draft=true|false and <job>=true|false for each job in
//     job-inputs.json. Reads EVENT (github.event_name) and DRAFT (github.event.pull_request.draft). Not a pull request:
//     every job true. A pull request: the tested merge commit (HEAD, checked out with fetch-depth 2) against its first
//     parent (the base tip); a job is true when a changed path is in `always` or in its list. Anything it cannot read (HEAD
//     not a merge, git failing, no files) makes every job true: a doubt runs the job, it never skips it.
//   node scripts/ci/job-inputs.cjs verify <job> <trace-file>
//     Fails (exit 1) when the trace (scripts/ci/trace-opens.py) is incomplete, or names a git-tracked file, or a directory
//     holding tracked files, that is outside `always` + the job's list: that read is an input the filter would miss.
//   node scripts/ci/job-inputs.cjs match <job> < paths     prints the paths in the job's inputs (for tests and by hand).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "job-inputs.json"), "utf8"));
const JOBS = Object.keys(SPEC.jobs);

function inputsOf(job) {
  if (!SPEC.jobs[job]) throw new Error(`unknown job "${job}" (known: ${JOBS.join(", ")})`);
  return [...SPEC.always, ...SPEC.jobs[job]];
}
// A changed or opened file is an input when it is a listed file or lies under a listed directory.
function fileIn(file, inputs) {
  return inputs.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}
// An opened directory (listed: its entries matter) is covered only when the whole directory is under a listed directory.
function dirIn(dir, inputs) {
  return inputs.some((p) => p.endsWith("/") && dir.startsWith(p));
}
function decide({ event, draft, files }) {
  const out = { draft: event === "pull_request" && draft === "true" ? "true" : "false" };
  for (const job of JOBS) {
    out[job] = event !== "pull_request" || files === null ? "true" : String(files.some((f) => fileIn(f, inputsOf(job))));
  }
  return out;
}
function changedFiles() {
  try {
    const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("rev-parse", "--verify", "HEAD^2"); // the pull_request checkout is the test merge commit: two parents
    const files = git("diff", "--no-renames", "--name-only", "HEAD^1", "HEAD").split("\n").map((s) => s.trim()).filter(Boolean);
    return files.length ? files : null;
  } catch (e) {
    console.error(`job-inputs: the changed files cannot be read (${String(e.message).split("\n")[0]}): every job runs`);
    return null;
  }
}
function verify(job, traceFile) {
  const inputs = inputsOf(job);
  const lines = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean);
  if (lines[0] !== "# complete") return [`the trace is not complete (${lines[0] ?? "empty"}): the inputs cannot be proven`];
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const files = new Set(tracked);
  const dirs = new Set();
  for (const f of tracked) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(d + "/");
  const bad = [];
  for (const p of lines.slice(1)) {
    if (p === "./") continue; // the working directory itself (a process's cwd); its listing reads no file's content
    if (p.endsWith("/")) { if (dirs.has(p) && !dirIn(p, inputs)) bad.push(`${p} (listed)`); }
    else if (files.has(p) && !fileIn(p, inputs)) bad.push(p);
  }
  return bad;
}

module.exports = { SPEC, JOBS, inputsOf, fileIn, dirIn, decide, verify };

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "changes") {
    const event = process.env.EVENT ?? "";
    const out = decide({ event, draft: process.env.DRAFT ?? "", files: event === "pull_request" ? changedFiles() : [] });
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  } else if (cmd === "verify" && args.length === 2) {
    const bad = verify(args[0], args[1]);
    if (bad.length) {
      console.error(`job "${args[0]}" read ${bad.length} tracked path(s) outside its inputs in scripts/ci/job-inputs.json; add them there (a pull request changing them would skip this job):`);
      for (const b of bad.slice(0, 100)) console.error(`  ${b}`);
      process.exit(1);
    }
    console.log(`job "${args[0]}": every tracked path it opened is in its inputs`);
  } else if (cmd === "match" && args.length === 1) {
    const inputs = inputsOf(args[0]);
    for (const f of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) if (fileIn(f, inputs)) console.log(f);
  } else {
    console.error("usage: job-inputs.cjs changes | verify <job> <trace-file> | match <job> < paths");
    process.exit(2);
  }
}
