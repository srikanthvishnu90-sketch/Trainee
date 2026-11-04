#!/usr/bin/env node
"use strict";
// forms-ci coverage sharding (2026-10-26). tests/career-forms-ci-coverage.test.cjs runs its tests serially inside
// one process, and on trunk the gate (forms-ci coverage) job spent 2,676-2,683 s in that one node invocation
// (runs 40372383659 and 40423628274; checkout + installs took ~25 s) — the long pole of every PR. This script
// splits the suite's tests across parallel CI shards WITHOUT editing the suite: each shard runs the same file with
// node's own --test-name-pattern / --test-skip-pattern selection, which the suite already supports (its read-only
// proof drives its own form when it runs alone).
//
// Completeness is by construction and is then checked:
//  - shards 1..N-1 each name their tests exactly (anchored, escaped full names);
//  - the LAST shard runs the file with every one of those names skipped, so any test not assigned anywhere —
//    including a test added or renamed later — runs there; nothing can fall out of CI by omission;
//  - the read-only proof ("the replay stayed read-only ...") runs in EVERY shard, so each shard's helper command
//    log and local-server request log are proven read-only/GET-only, as the single process's were;
//  - `verify` (the aggregate gate (forms-ci coverage) job) lists the suite's tests statically and fails unless
//    every one of them passed ("ok", not skipped) in some shard's TAP output, and fails if a shard-table name no
//    longer exists in the suite (a rename would otherwise silently rebalance work onto the last shard).
//
// Subcommands:
//   list                       print the suite's top-level test names, one per line (static: node:test is stubbed,
//                              nothing is driven, no browser or helper is started)
//   args <shard> <count>       print the node --test selection arguments for one shard, one per line
//   report <tap-log> <out>     write the names of the top-level tests that passed in <tap-log> to <out> (JSON
//                              {passed:[], failed:[], durations:{}}) and print a ::notice with per-test seconds
//   verify <dir>               check every listed test passed in some shard report under <dir>
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const SUITE = path.join(ROOT, "tests", "career-forms-ci-coverage.test.cjs");
const READ_ONLY = "forms-ci coverage: the replay stayed read-only and never reached a submit path";
const form = (id) => `forms-ci coverage: ${id}`;

// The shard table. Balanced from measured per-test durations (the shard `report` notices); the last shard is the
// remainder and is not listed. The read-only proof is appended to every shard. It judges the helper command log and
// local-server request log of the tests registered BEFORE it in the suite (test line ~950), exactly as in the single
// process. In shards 1, 2, 4 and 5 a form drive precedes it. In shard 3 nothing does (the conditional guard is
// registered after the proof), so there the proof takes its own standalone path: it drives CAPTURED[0] (Prolific,
// ~150 s, part of shard 3's measured 619 s) and judges that drive's log. The guard's commands after the proof are
// unjudged there, just as the guards after the proof were in the single process.
const SHARDS = [
  // Seconds measured per test on PR #209's first sharded run (run 40441854421), from the shards' notices.
  // 1: Anduril's drive alone (668 s; its own 900 s test budget) — the floor of the sharded wall time.
  [form("greenhouse-andurilindustries-4802172007")],
  // 2: WPP's drive (466 s) plus Prolific's (153 s).
  [form("greenhouse-wppmedia-5437567008"), form("greenhouse-prolificacademicltd-4979452101")],
  // 3: the conditional-follow-up guard, which re-drives WPP in full (466 s).
  ["widget-gap guard: conditional follow-ups are gated on the persona's parent answer"],
  // 4: EOS's drive (325 s) and its number guard (2 s).
  [
    form("greenhouse-eosfitness-4336050009"),
    "widget-gap guard: number inputs take the profile's numeric value and refuse a non-numeric one by name",
  ],
  // 5 (remainder): SpaceX (496 s), the six Lever drives (9-17 s each), board isolation (10 s), the abort proof,
  // the other guards (attestation 27 s) and the pin/gate unit tests — and anything added later (~616 s).
];

function listTests() {
  const names = [];
  const fake = (name) => { names.push(String(name)); };
  fake.before = fake.after = fake.beforeEach = fake.afterEach = () => {};
  fake.test = fake;
  fake.describe = fake.it = fake;
  const realLoad = Module._load;
  const diag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forms-ci-list-")), "diag.jsonl");
  const prevDiag = process.env.FORMS_CI_COVERAGE_DIAG;
  process.env.FORMS_CI_COVERAGE_DIAG = diag; // the suite truncates its diag file at load; never touch the real one
  Module._load = function (request, ...rest) {
    if (request === "node:test" || request === "test") return fake;
    return realLoad.call(this, request, ...rest);
  };
  try { require(SUITE); } finally {
    Module._load = realLoad;
    if (prevDiag === undefined) delete process.env.FORMS_CI_COVERAGE_DIAG; else process.env.FORMS_CI_COVERAGE_DIAG = prevDiag;
  }
  return names;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const anchored = (name) => `^${escapeRe(name)}$`;

function checkTable(names) {
  const known = new Set(names);
  const seen = new Set();
  for (const [i, shard] of SHARDS.entries()) {
    for (const n of shard) {
      if (!known.has(n)) throw new Error(`forms-ci shard table: shard ${i + 1} names "${n}", which is not a test in the suite (renamed or removed?) — update scripts/forms-ci-shards.cjs`);
      if (seen.has(n)) throw new Error(`forms-ci shard table: "${n}" is assigned to two shards`);
      if (n === READ_ONLY) throw new Error("forms-ci shard table: the read-only proof runs in every shard and is not assigned");
      seen.add(n);
    }
  }
  if (names.length !== known.size) throw new Error("forms-ci shard table: the suite has duplicate test names; name patterns cannot shard it");
  // The proof is added to every shard by name: if it were renamed, shards 1..N-1 would silently run without it.
  if (!known.has(READ_ONLY)) throw new Error(`forms-ci shard table: the read-only proof "${READ_ONLY}" is not a test in the suite (renamed or removed?) — update READ_ONLY in scripts/forms-ci-shards.cjs`);
}

function args(shard, count, names = listTests()) {
  if (count !== SHARDS.length + 1) throw new Error(`forms-ci shards: the table defines ${SHARDS.length + 1} shards, the workflow asked for ${count}`);
  if (!(shard >= 1 && shard <= count)) throw new Error(`forms-ci shards: shard ${shard} is out of range 1..${count}`);
  checkTable(names);
  if (shard < count) return [...SHARDS[shard - 1], READ_ONLY].map((n) => `--test-name-pattern=${anchored(n)}`);
  return SHARDS.flat().map((n) => `--test-skip-pattern=${anchored(n)}`);
}

// Top-level TAP results only (subtests are indented). The gate log interleaves other output; only lines that are
// TAP test points at column 0 count, each followed by its YAML block carrying duration_ms.
function parseTap(text) {
  const passed = [], failed = [], durations = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|not ok) \d+ - (.*?)(\s+# (SKIP|TODO)\b.*)?$/.exec(lines[i]);
    if (!m) continue;
    const name = m[2].replace(/\\#/g, "#").replace(/\\\\/g, "\\");
    if (m[4]) continue; // skipped/todo do not count as having run
    (m[1] === "ok" ? passed : failed).push(name);
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const d = /^\s+duration_ms: ([\d.]+)/.exec(lines[j]);
      if (d) { durations[name] = Math.round(Number(d[1]) / 1000); break; }
      if (/^(ok|not ok) \d+ - /.test(lines[j])) break;
    }
  }
  // A failed step's TAP blocks are printed again at the end of the gate log; count each name once.
  return { passed: [...new Set(passed)], failed: [...new Set(failed)], durations };
}

// The aggregate check. Fails unless: the shard table matches the suite; there is one report per shard; no test
// failed in any shard; every test of the suite passed in some shard; no shard reported an unknown test; and the
// read-only proof passed in EVERY shard (it is appended to each shard by name and judges that shard's own logs).
function verifyReports(names, reports) {
  const errors = [];
  try { checkTable(names); } catch (e) { errors.push(String(e.message || e)); }
  const passedIn = new Map();
  let failed = [];
  const shardsWithoutProof = [];
  for (const rep of reports) {
    for (const n of rep.passed) passedIn.set(n, (passedIn.get(n) || 0) + 1);
    failed = failed.concat(rep.failed);
    if (!rep.passed.includes(READ_ONLY)) shardsWithoutProof.push(path.basename(rep.file || "?"));
  }
  const missing = names.filter((n) => !passedIn.has(n));
  const unknown = [...passedIn.keys()].filter((n) => !names.includes(n));
  const lines = [`forms-ci coverage: ${names.length} tests in the suite; ${reports.length} shard reports; ${names.length - missing.length} passed in some shard; read-only proof passed in ${passedIn.get(READ_ONLY) || 0} of ${SHARDS.length + 1} shards`];
  for (const n of names) lines.push(`  ${passedIn.has(n) ? "ran " + passedIn.get(n) + "x" : "MISSING"}  ${n}`);
  if (reports.length !== SHARDS.length + 1) errors.push(`expected ${SHARDS.length + 1} shard reports, found ${reports.length}`);
  if (failed.length) errors.push(`failed in a shard: ${failed.join("; ")}`);
  if (missing.length) errors.push(`did not pass in any shard: ${missing.join("; ")}`);
  if (unknown.length) errors.push(`reported tests the suite does not define: ${unknown.join("; ")}`);
  if (shardsWithoutProof.length) errors.push(`the read-only proof did not pass in shard report(s) ${shardsWithoutProof.join(", ")}; it must pass in every shard`);
  return { lines, errors };
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "list") {
    for (const n of listTests()) console.log(n);
  } else if (cmd === "args") {
    for (const x of args(Number(a), Number(b))) console.log(x);
  } else if (cmd === "report") {
    const rep = parseTap(fs.readFileSync(a, "utf8"));
    fs.writeFileSync(b, JSON.stringify(rep, null, 1));
    const lines = Object.entries(rep.durations).sort((x, y) => y[1] - x[1]).map(([n, s]) => `${s} s  ${n}`);
    const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=forms-ci shard tests - ${rep.passed.length} passed - ${rep.failed.length} failed::${esc(lines.join("\n").slice(0, 3800))}`);
  } else if (cmd === "verify") {
    const dir = a;
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
    const reports = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(f, "utf8")) }));
    const { lines, errors } = verifyReports(listTests(), reports);
    for (const l of lines) console.log(l);
    for (const e of errors) console.log(`::error title=forms-ci shards::${e.slice(0, 1500)}`);
    if (errors.length) process.exitCode = 1;
  } else {
    console.error("usage: forms-ci-shards.cjs list | args <shard> <count> | report <tap-log> <out.json> | verify <dir>");
    process.exitCode = 2;
  }
}
if (require.main === module) main();
module.exports = { SHARDS, READ_ONLY, listTests, checkTable, args, parseTap, verifyReports };
