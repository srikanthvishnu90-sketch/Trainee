"use strict";
// The process mechanisms of docs/architect/PROCESS.md:
//   - scripts/ci/pr-hygiene.cjs labels and comments only (its one write door refuses anything else), and its rules
//     (stale, conflicting, stacked, based-on-red-trunk, oversize, needs-s2-approval) are functions of the facts and an
//     injected clock;
//   - .github/workflows/pr-hygiene.yml never closes, merges or pushes;
//   - ci.yml is merge-queue ready (merge_group) without changing how pushes and PRs are grouped or cancelled.
// node --test tests/career-ci-process.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const H = require("../scripts/ci/pr-hygiene.cjs");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const pr = (o = {}) => ({ number: 1, base: "trunk", labels: [], mergeableState: "clean", headCommittedAt: NOW - DAY, baseRed: false, files: [{ filename: "a.ts", additions: 10, deletions: 2 }], ...o });

test("a fresh, clean PR on green trunk gets no label", () => {
  assert.deepEqual(H.classify(pr(), NOW), []);
});

test("stale: strictly more than 7 days since the head commit, from the injected clock only", () => {
  assert.deepEqual(H.classify(pr({ headCommittedAt: NOW - 7 * DAY }), NOW), []);
  assert.deepEqual(H.classify(pr({ headCommittedAt: NOW - 7 * DAY - 1 }), NOW), ["stale"]);
  // The same facts judged at another instant give that instant's answer: classify never reads the wall clock.
  const RealNow = Date.now;
  Date.now = () => NOW + 365 * DAY;
  try { assert.deepEqual(H.classify(pr({ headCommittedAt: NOW - DAY }), NOW), []); } finally { Date.now = RealNow; }
});

test("conflicting, stacked and based-on-red-trunk", () => {
  assert.deepEqual(H.classify(pr({ mergeableState: "dirty" }), NOW), ["conflicting"]);
  assert.deepEqual(H.classify(pr({ base: "fix/other-branch" }), NOW), ["stacked"]);
  assert.deepEqual(H.classify(pr({ base: "release/production" }), NOW), [], "a PR into release/production is not a stacked PR");
  assert.deepEqual(H.classify(pr({ baseRed: true }), NOW), ["based-on-red-trunk"]);
  assert.deepEqual(H.classify(pr({ base: "x", baseRed: true }), NOW), ["stacked"], "red base is judged only against trunk");
});

test("oversize: generated files do not count; size-exception waives it", () => {
  const big = [{ filename: "supabase/functions/_shared/router_core.career.js", additions: 50_000, deletions: 49_000 }, { filename: "a.ts", additions: 100, deletions: 0 }];
  assert.deepEqual(H.classify(pr({ files: big }), NOW), [], "a regenerated bundle is not the PR's size");
  const over = [{ filename: "a.ts", additions: H.SIZE_CAP_LINES, deletions: 1 }];
  assert.deepEqual(H.classify(pr({ files: over }), NOW), ["oversize"]);
  assert.deepEqual(H.classify(pr({ files: over, labels: ["size-exception"] }), NOW), []);
  const many = Array.from({ length: H.SIZE_CAP_FILES + 1 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
  assert.deepEqual(H.classify(pr({ files: many }), NOW), ["oversize"]);
});

test("plan: adds and removes only managed labels; an unknown fact never removes the label it decides", () => {
  const managed = H.MANAGED_OPEN;
  assert.deepEqual(H.plan(pr({ labels: ["stale", "wip"] }), [], managed), { add: [], remove: ["stale"] });
  assert.deepEqual(H.plan(pr({ labels: ["conflicting"], mergeableState: null }), [], managed), { add: [], remove: [] });
  assert.deepEqual(H.plan(pr({ labels: ["oversize"], files: null }), [], managed), { add: [], remove: [] });
  assert.deepEqual(H.plan(pr({ labels: ["based-on-red-trunk"], baseRed: null }), [], managed), { add: [], remove: [] });
  assert.deepEqual(H.plan(pr({ labels: [] }), ["stale", "conflicting"], managed), { add: ["stale", "conflicting"], remove: [] });
});

test("the comment names every added label's reason and says nothing was closed", () => {
  const c = H.commentFor(["stale", "conflicting"]);
  assert.ok(c.startsWith(H.MARKER));
  assert.match(c, /`stale`: no new commit for more than 7 days/);
  assert.match(c, /`conflicting`/);
  assert.match(c, /Nothing was closed or changed/);
});

test("parseS2 reads deploy-standard.ts's report lines (ok / BAD per PR)", () => {
  const report = [
    "DEPLOY STANDARD for abc (last successful production deploy: def)",
    "S2 FAIL: 2/4 merges since def lack an approval at their merged head: #480, #481",
    "    docs/architect/approvals.txt read from the trunk tip",
    "    ok   #476 head 1234567890: APPROVED by someone (COLLABORATOR)",
    "    BAD  #480 head 1234567890: no independent approval at the merged head, and no docs/architect/approvals.txt line",
    "    BAD  #481: PR 481 files unreadable (the files API failed), and no independent approval at the merged head",
    "    ok   #484: exempt, its diff only adds lines to docs/architect/approvals.txt",
    "    BAD  0123456789 (no PR)",
  ].join("\n");
  assert.deepEqual(H.parseS2(report), { bad: [480, 481], ok: [476, 484] });
});

test("the only writes are: add labels, remove one label, comment; anything else is refused before any request", async () => {
  const logs = [];
  const gh = H.github({ repo: "o/r", token: "t", dryRun: true, log: (l) => logs.push(l) });
  await gh.write("POST", "/issues/12/labels", { labels: ["stale"] });
  await gh.write("DELETE", "/issues/12/labels/stale");
  await gh.write("POST", "/issues/12/comments", { body: "x" });
  assert.equal(logs.length, 3);
  for (const [m, p] of [["PATCH", "/pulls/12"], ["PUT", "/pulls/12/merge"], ["PATCH", "/issues/12"], ["POST", "/pulls"], ["DELETE", "/git/refs/heads/x"], ["POST", "/issues/12/lock"], ["PUT", "/issues/12/labels"], ["POST", "/issues/12/labels/extra"]]) {
    await assert.rejects(gh.write(m, p, {}), /only labels and comments/, `${m} ${p} must be refused`);
  }
});

test("the hygiene script and workflow contain no close, merge, push or edit path", () => {
  const src = read("scripts/ci/pr-hygiene.cjs");
  for (const bad of [/"PATCH"/, /"PUT"/, /state:\s*"closed"/, /\/merge["`]/, /git push/]) assert.ok(!bad.test(src), `pr-hygiene.cjs matches ${bad}`);
  const wf = read(".github/workflows/pr-hygiene.yml");
  for (const bad of [/gh pr (close|merge|edit)/, /state=closed/, /contents:\s*write/, /git push/, /secrets\./]) assert.ok(!bad.test(wf), `pr-hygiene.yml matches ${bad}`);
});

test("ci.yml is merge-queue ready without changing push and PR grouping", () => {
  const ci = read(".github/workflows/ci.yml");
  const on = /^on:\n([\s\S]*?)^concurrency:/m.exec(ci);
  assert.ok(on, "ci.yml has an on: block before concurrency:");
  assert.match(on[1], /^  merge_group:\n    types: \[checks_requested\]$/m, "ci.yml runs on merge_group checks_requested");
  assert.match(on[1], /^  push:\n    branches: \[trunk, release\/production\]$/m, "pushes still run on trunk and release/production");
  assert.match(on[1], /^  pull_request:$/m, "pull requests still run");
  // A merge_group run has no pull_request number: its group falls to ref@sha, one per SHA, and only PR runs are cancelled.
  assert.match(ci, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| format\('\{0\}@\{1\}', github\.ref, github\.sha\) \}\}/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  // No job is limited to push or PR events by an event-name equality, which would leave a required check unreported in the queue.
  for (const m of ci.matchAll(/^    if: (.*)$/gm)) assert.ok(!/event_name\s*==\s*'(push|pull_request)'/.test(m[1]), `a job runs only on one event: ${m[1]}`);
});
