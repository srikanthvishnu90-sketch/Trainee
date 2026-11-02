// D-034, the deploy standard: scripts/launch/deploy-standard.ts over fixture data. A base world meets every check; each test
// breaks exactly one condition and the check it belongs to must FAIL (a mutation per check), and every other check must
// still pass. Plus the parsers against the repository's own files (the workflows, the acceptance suite, the score log
// format). No network, no git: the sources are in-memory.
// Run: deno test -A --no-check tests/architect/deploy-standard.test.ts
import assertNode from "node:assert/strict";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import {
  ACCEPTANCE_CHECK, ACCEPTANCE_FILE, type CheckId, type CheckRun, evaluate, jobCheckNames, knownGaps, LEDGER, parseLedger, parseScoreLog, prOf, type PullFile, report, type Review,
  ledgerApproves, ledgerOnly, type Sources, stepIds,
} from "../../scripts/launch/deploy-standard.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const C = "c".repeat(40), B = "b".repeat(40), D = "d".repeat(40), A = "a".repeat(40), M = "e".repeat(40);
const H1 = "1".repeat(40), H2 = "2".repeat(40);
const CI_YML = `name: ci
on: { push: { branches: [trunk] }, pull_request: {} }
jobs:
  gate-shard:
    name: gate (core shard \${{ matrix.shard }}/2)
    runs-on: ubuntu-24.04
    strategy: { fail-fast: false, matrix: { shard: [1, 2] } }
    steps: [{ run: "true" }]
  gate:
    name: gate (core)
    needs: gate-shard
    runs-on: ubuntu-24.04
    steps: [{ run: "true" }]
  database:
    runs-on: ubuntu-24.04
    steps: [{ run: "true" }]
  acceptance-telegram:
    name: acceptance (telegram)
    runs-on: ubuntu-24.04
    steps: [{ run: "true" }]
`;
const PREFLIGHT_YML = `name: deploy-preflight
on: { workflow_call: {}, pull_request: {} }
jobs:
  dry-run:
    name: go-live dry run (PR head)
    runs-on: ubuntu-24.04
    steps: [{ run: "true" }]
`;
const STEPS_ALL = ["new-account-from-hi", "fit-question-answered", "older-gap", "missing-fact-asks"];
const SUITE = (gaps: string[], steps = STEPS_ALL) => `export const KNOWN_GAP: readonly string[] = [\n  // why\n${gaps.map((g) => `  "${g}",`).join("\n")}\n] as const;\n\nexport const STEPS = [\n${steps.map((x) => `  "${x}",`).join("\n")}\n] as const;\n`;
const LOG_HEAD = "# Brain score log\n\n| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
const row = (commit: string, brain: string, passed: number, run: string, o: { set?: string; size?: number; stopped?: string } = {}) =>
  `| 2026-10-31 10:00:00 | ${commit.slice(0, 7)} | ${o.set ?? "dev"} | ${brain} | ${o.size ?? 38} | ${passed} | ${(passed / (o.size ?? 38) * 100).toFixed(1)}% | gpt-5-mini x, gpt-4.1-mini y; both-pass | ${o.stopped ?? "no"} | ${run}; harness: parity |\n`;
// One CI run's five passes (a measurement is exactly five qualifying passes). Sizes 76 and 114 keep the rates the
// assertions name exact over five passes: 225/380 = 59.2%, 235/380 = 61.8%, 300/380 = 78.9%, 350/570 = 61.4%, 352/570 = 61.8%.
const run5 = (commit: string, brain: string, passed: number[], run: string, o: { set?: string; size?: number; stopped?: string } = {}) => passed.map((p) => row(commit, brain, p, run, o)).join("");

interface World {
  files: Map<string, string>; // `${sha}:${path}`
  runs: CheckRun[];
  deployed: string | null;
  commits: { sha: string; subject: string }[];
  pulls: Record<number, { merged: boolean; merge_commit_sha: string; head_sha: string; author: string; merged_by: string }>;
  reviews: Record<number, Review[]>;
  prFiles: Record<number, PullFile[] | null | "throws">;
  ledger: string | null; // approvals.txt at the trunk tip
  log: string | null;
  parents: Record<string, string>;
  trees: Record<string, string>; // the supabase/functions tree of each commit
  ancestors: Record<string, string[]>; // sha -> all its ancestors
  added: string | null;
  audit: { code: number; out: string };
}
const FEATURES_OK = "FEATURE model ENABLED WIRED\nFEATURE telegram ENABLED WIRED\nFEATURE whatsapp OFF NOT_WIRED missing=WHATSAPP_APP_SECRET\nfeatures enabled and NOT_WIRED: 0\n";
function base(): World {
  const runNames = ["gate (core shard 1/2)", "gate (core shard 2/2)", "gate (core)", "database", ACCEPTANCE_CHECK, "preflight / go-live dry run (PR head)"];
  return {
    files: new Map([
      [`${C}:.github/workflows/ci.yml`, CI_YML], [`${C}:.github/workflows/deploy-preflight.yml`, PREFLIGHT_YML],
      [`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"])], [`${D}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered", "older-gap"])],
    ]),
    runs: runNames.map((name, i) => ({ name, status: "completed", conclusion: "success", id: 100 + i, completed_at: "2026-10-31T10:00:00Z" })),
    deployed: D,
    commits: [{ sha: C, subject: "Merge pull request #2 from x/feature" }, { sha: B, subject: "fix: something small (#1)" }],
    pulls: { 1: { merged: true, merge_commit_sha: B, head_sha: H1, author: "builder", merged_by: "owner-acct" }, 2: { merged: true, merge_commit_sha: C, head_sha: H2, author: "builder", merged_by: "owner-acct" } },
    reviews: { 1: [{ state: "COMMENTED", commit_id: H1, user: "x", association: "NONE" }, { state: "APPROVED", commit_id: H1, user: "architect", association: "COLLABORATOR" }], 2: [] },
    prFiles: { 1: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 }], 2: [{ filename: "src/b.ts", status: "modified", additions: 1, deletions: 0 }] },
    ledger: `# PR SHA reviewer [note]\n2 ${H2} architect-claude reviewed against WO-200, gate green\n`,
    log: LOG_HEAD + run5(D, "router", [44, 45, 45, 45, 46], "100", { size: 76 }) + run5(C, "router", [46, 47, 47, 47, 48], "200", { size: 76 }) + run5(C, "agent", [70, 70, 70, 70, 70], "200", { size: 76 }),
    parents: { [C]: B, [B]: D, [D]: A, [M]: C },
    trees: { [C]: "T2", [B]: "T2", [D]: "T1", [A]: "T1", [M]: "T2" },
    ancestors: { [C]: [B, D, A], [B]: [D, A], [D]: [A], [A]: [], [M]: [C, B, D, A] },
    added: C,
    audit: { code: 0, out: FEATURES_OK },
  };
}
function sources(w: World): Sources {
  const all = [A, B, C, D, M];
  return {
    checkRuns: async () => w.runs,
    fileAt: async (sha, path) => w.files.get(`${sha}:${path}`) ?? null,
    lastDeployedSha: async () => w.deployed,
    firstParent: async () => w.commits,
    pull: async (n) => w.pulls[n] ? { number: n, base: "trunk", ...w.pulls[n] } : null,
    reviews: async (n) => w.reviews[n] ?? [],
    pullFiles: async (n) => { const f = w.prFiles[n]; if (f === "throws") throw new Error("GitHub /pulls/files: HTTP 502"); return f === undefined ? [] : f; },
    ledger: async () => w.ledger,
    scoreLog: async () => w.log,
    resolve: async (rev) => all.find((s) => s.startsWith(rev)) ?? null,
    parent: async (sha) => w.parents[sha] ?? null,
    isAncestor: async (a, b) => a === b || (w.ancestors[b] ?? []).includes(a),
    changed: async (a, b) => w.trees[a] !== w.trees[b],
    tree: async (sha) => w.trees[sha] ?? null,
    firstAdded: async () => w.added,
    secretsAudit: async () => w.audit,
  };
}
async function verdicts(w: World) {
  const { results, deployed } = await evaluate(sources(w), C);
  return { v: Object.fromEntries(results.map((r) => [r.id, r.pass])) as Record<CheckId, boolean>, results, text: report(C, deployed, results) };
}
async function onlyFails(w: World, id: CheckId, why: RegExp) {
  const { v, results, text } = await verdicts(w);
  for (const c of ["S1", "S2", "S3", "S4", "S5"] as CheckId[]) eq(v[c], c !== id, `${c} ${c === id ? "fails" : "still passes"}:\n${text}`);
  ok(why.test(results.find((r) => r.id === id)!.summary + "\n" + results.find((r) => r.id === id)!.evidence.join("\n")), `${id} says why:\n${text}`);
  ok(/DEPLOY STANDARD: FAIL/.test(text), text);
}

Deno.test("the base world meets the standard: every check PASS, with evidence", async () => {
  const { v, text } = await verdicts(base());
  eq(v, { S1: true, S2: true, S3: true, S4: true, S5: true }, text);
  ok(/S1 PASS: all 6 required checks are success/.test(text), text);
  ok(/ok   #1 head 1111111111: APPROVED by architect \(COLLABORATOR\)/.test(text) && /ok   #2 head 2222222222: docs\/architect\/approvals\.txt, reviewer architect-claude: reviewed/.test(text), text);
  ok(/S3 PASS: router pass rate 61\.8% >= deployed 59\.2%/.test(text), text);
  ok(/DEPLOY STANDARD: PASS/.test(text), text);
});

// ------------------------------------------------------------------------------------------------ S1
Deno.test("S1 mutation: one required check failed on the SHA", async () => {
  const w = base(); w.runs[1].conclusion = "failure";
  await onlyFails(w, "S1", /gate \(core shard 2\/2\) \(failure\)/);
});
Deno.test("S1 mutation: one required check never ran on the SHA (missing evidence is a FAIL)", async () => {
  const w = base(); w.runs = w.runs.filter((r) => r.name !== "database");
  await onlyFails(w, "S1", /database \(NO RUN\)/);
});
Deno.test("S1 mutation: a required check still running is not a pass", async () => {
  const w = base(); w.runs[2] = { ...w.runs[2], status: "in_progress", conclusion: null };
  await onlyFails(w, "S1", /gate \(core\) \(in_progress\)/);
});
Deno.test("S1 mutation: an old success is overruled by a later failure of the same check", async () => {
  const w = base(); w.runs.push({ name: "gate (core)", status: "completed", conclusion: "failure", id: 999, completed_at: "2026-10-31T11:00:00Z" });
  await onlyFails(w, "S1", /gate \(core\) \(failure\)/);
});
Deno.test("S1 mutation: the workflow that lists the gates is unreadable at the SHA", async () => {
  const w = base(); w.files.delete(`${C}:.github/workflows/deploy-preflight.yml`);
  await onlyFails(w, "S1", /required list cannot be read/);
});

// ------------------------------------------------------------------------------------------------ S2
Deno.test("S2 mutation: a merged PR with neither an approved review nor a ledger line", async () => {
  const w = base(); w.ledger = "# PR SHA reviewer [note]\n";
  await onlyFails(w, "S2", /#2 head 2222222222: no independent approval at the merged head, and no/);
});
Deno.test("S2 mutation: the review approved an earlier head, not the merged one", async () => {
  const w = base(); w.reviews[1] = [{ state: "APPROVED", commit_id: "9".repeat(40), user: "architect", association: "COLLABORATOR" }];
  await onlyFails(w, "S2", /#1 head 1111111111: no independent approval at the merged head/);
});
Deno.test("S2 mutation: the ledger names a SHA that is not the merged head", async () => {
  const w = base(); w.ledger = `2 ${"3".repeat(40)} architect-claude an earlier push\n`;
  await onlyFails(w, "S2", /approvals\.txt names 3333333333, not the merged head/);
});
Deno.test("S2 mutation: a commit on trunk that no PR merged", async () => {
  const w = base(); w.commits.push({ sha: A, subject: "direct push to trunk" });
  await onlyFails(w, "S2", /not merged through a PR/);
});
Deno.test("S2 mutation: a subject that claims a PR the PR does not own", async () => {
  const w = base(); w.pulls[1] = { ...w.pulls[1], merge_commit_sha: "f".repeat(40) };
  await onlyFails(w, "S2", /#1: its merge commit is ffffffffff, not bbbbbbbbbb/);
});
Deno.test("S2/S3 mutation: no successful production deploy to bound from", async () => {
  const w = base(); w.deployed = null;
  const { v, text } = await verdicts(w);
  eq([v.S2, v.S3], [false, false], text);
  ok(/S2 FAIL: no successful production deploy found/.test(text) && /S3 FAIL: no successful production deploy found/.test(text), text);
});

// Review of #351, item 1: only an independent, trusted reviewer's APPROVED counts.
Deno.test("S2 mutation: an APPROVED review by someone with no standing on the repo (public repo) does not count", async () => {
  const w = base(); w.reviews[1] = [{ state: "APPROVED", commit_id: H1, user: "drive-by", association: "NONE" }];
  await onlyFails(w, "S2", /#1 head 1111111111: no independent approval .*APPROVED at the head only by drive-by \(NONE\), not counted/);
  w.reviews[1] = [{ state: "APPROVED", commit_id: H1, user: "first-timer", association: "CONTRIBUTOR" }];
  await onlyFails(w, "S2", /first-timer \(CONTRIBUTOR\), not counted/);
});
Deno.test("S2 mutation: the PR's author approving their own PR does not count, even as OWNER", async () => {
  const w = base(); w.reviews[1] = [{ state: "APPROVED", commit_id: H1, user: "Builder", association: "OWNER" }];
  await onlyFails(w, "S2", /APPROVED at the head only by Builder \(the author\), not counted/);
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    w.reviews[1] = [{ state: "APPROVED", commit_id: H1, user: "architect", association: a }];
    eq((await verdicts(w)).v.S2, true, `${a} counts`);
  }
});
// Review of #351, item 2: the ledger is read from the trunk tip, needs an independent reviewer, and ledger-only PRs are exempt.
Deno.test("S2: the ledger is read from the trunk tip at check time (it may approve PRs merged before it); a line only at the candidate SHA counts for nothing", async () => {
  const w = base(); w.files.set(`${C}:${LEDGER}`, w.ledger!); w.ledger = null;
  await onlyFails(w, "S2", /approvals\.txt is not on the trunk tip/);
});
Deno.test("S2 mutation: a ledger line naming the PR's author or the merging account as reviewer does not count; a line with no reviewer is malformed", async () => {
  const w = base(); w.ledger = `2 ${H2} builder self-approved\n`;
  await onlyFails(w, "S2", /#2 head 2222222222: no independent approval .*line names the author or the merging account as reviewer/);
  w.ledger = `2 ${H2} Owner-Acct merged it myself\n`;
  await onlyFails(w, "S2", /#2 head 2222222222: no independent approval .*line names the author or the merging account as reviewer/);
  const pr = { number: 2, merged: true, merge_commit_sha: C, head_sha: H2, base: "trunk", author: "builder", merged_by: "owner-acct" };
  eq([ledgerApproves({ sha: H2, reviewer: "architect", note: "" }, pr), ledgerApproves({ sha: H2, reviewer: "  ", note: "" }, pr), ledgerApproves({ sha: H2, reviewer: "", note: "" }, pr),
    ledgerApproves({ sha: H2, reviewer: "OWNER-ACCT", note: "" }, pr), ledgerApproves({ sha: H1, reviewer: "architect", note: "" }, pr)], [true, false, false, false, false]);
  w.ledger = `2 ${H2}\n`;
  await onlyFails(w, "S2", /#2 head 2222222222: no independent approval at the merged head, and no/);
});
Deno.test("S2: a PR whose diff only adds lines to the ledger is exempt; one that also deletes a line or touches another file is not", async () => {
  const w = base(); w.commits.unshift({ sha: M, subject: "Merge pull request #3 from x/approvals" });
  w.pulls[3] = { merged: true, merge_commit_sha: M, head_sha: "4".repeat(40), author: "builder", merged_by: "owner-acct" };
  w.prFiles[3] = [{ filename: LEDGER, status: "modified", additions: 2, deletions: 0 }];
  const r = await verdicts(w);
  eq(ledgerOnly(null), false, "unreadable is not ledger-only");
  eq(ledgerOnly([]), false, "an empty list is not ledger-only");
  eq(r.v.S2, true, r.text);
  ok(/ok   #3: exempt, its diff only adds lines to docs\/architect\/approvals\.txt/.test(r.text), r.text);
  w.prFiles[3] = [{ filename: LEDGER, status: "modified", additions: 2, deletions: 1 }];
  await onlyFails(w, "S2", /#3 head 4444444444: no independent approval/);
  w.prFiles[3] = [{ filename: LEDGER, status: "modified", additions: 2, deletions: 0 }, { filename: "scripts/launch/deploy-standard.ts", status: "modified", additions: 1, deletions: 0 }];
  await onlyFails(w, "S2", /#3 head 4444444444: no independent approval/);
  // A rename of any file is not ledger-only, even a rename onto the ledger with lines only added.
  w.prFiles[3] = [{ filename: LEDGER, status: "renamed", additions: 2, deletions: 0 }];
  await onlyFails(w, "S2", /#3 head 4444444444: no independent approval/);
});
// Re-review of #351, item 1: missing evidence fails, it never exempts.
Deno.test("S2 mutation: a PR whose files cannot be read (404, an error, an empty list) is never exempt: PR N files unreadable", async () => {
  for (const f of [null, "throws", []] as const) {
    const w = base(); w.commits.unshift({ sha: M, subject: "Merge pull request #3 from x/approvals" });
    w.pulls[3] = { merged: true, merge_commit_sha: M, head_sha: "4".repeat(40), author: "builder", merged_by: "owner-acct" };
    w.prFiles[3] = f as any;
    await onlyFails(w, "S2", /#3: PR 3 files unreadable/);
  }
});

// ------------------------------------------------------------------------------------------------ S3
Deno.test("S3 mutation: any drop fails, however small (no tolerance); equal passes", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [70, 70, 70, 71, 71], "100", { size: 114 }) + run5(C, "router", [70, 70, 70, 70, 70], "200", { size: 114 });
  // deployed 47/2 = 23.5 a pass; candidate 70/3 = 23.33: 0.4 points lower
  await onlyFails(w, "S3", /router pass rate 61\.4% < deployed 61\.8%/);
  w.log = LOG_HEAD + run5(D, "router", [70, 70, 70, 71, 71], "100", { size: 114 }) + run5(C, "router", [68, 69, 70, 72, 73], "200", { size: 114 });
  eq((await verdicts(w)).v.S3, true, "equal means pass");
});
Deno.test("S3 mutation: the candidate's router pass rate is below the deployed one's", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [60, 60, 60, 60, 60], "100", { size: 76 }) + run5(C, "router", [46, 47, 47, 47, 48], "200", { size: 76 });
  await onlyFails(w, "S3", /router pass rate 61\.8% < deployed 78\.9%/);
});
Deno.test("S3 mutation: no measurement of the deployed SHA", async () => {
  const w = base(); w.log = LOG_HEAD + run5(C, "router", [23, 23, 23, 23, 23], "200");
  await onlyFails(w, "S3", /deployed: no router measurement/);
});
Deno.test("S3 mutation: no measurement of the candidate (only the agent brain was measured)", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100") + run5(C, "agent", [35, 35, 35, 35, 35], "200");
  await onlyFails(w, "S3", /candidate: no router measurement/);
});
Deno.test("S3 mutation: a stopped run or a NOT A SCORE row is not a measurement", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100") + run5(C, "router", [30, 30, 30, 30, 30], "200", { stopped: "yes" }) + run5(C, "router", [30, 30, 30, 30, 30], "201", { stopped: "NOT A SCORE: 38 judge errors" });
  await onlyFails(w, "S3", /candidate: no router measurement/);
});
Deno.test("S3 mutation: four qualifying passes (one crashed, one stopped) are not a measurement", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100") + run5(C, "router", [30, 30, 30, 30], "200") + row(C, "router", 30, "200", { stopped: "yes" });
  await onlyFails(w, "S3", /candidate: .*has 4 qualifying passes, not 5/);
});
Deno.test("S3 mutation: the deployed SHA measured only on another set", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100", { set: "heldout" }) + run5(C, "router", [23, 23, 23, 23, 23], "200");
  await onlyFails(w, "S3", /deployed: no router measurement .* on set dev\/38/);
});
Deno.test("S3: a first-parent ancestor with the same reply code stands for the candidate; one with different reply code does not", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100") + run5(B, "router", [25, 25, 25, 25, 25], "200");
  eq((await verdicts(w)).v.S3, true, "B (C's parent, same supabase/functions tree) measures C");
  w.trees[B] = "T-other";
  await onlyFails(w, "S3", /candidate: no router measurement/);
});
Deno.test("S3: a measurement-branch commit with the identical reply tree, descending from the candidate, measures it", async () => {
  const w = base(); w.log = LOG_HEAD + run5(D, "router", [22, 22, 22, 22, 22], "100") + run5(M, "router", [25, 25, 25, 25, 25], "200");
  eq((await verdicts(w)).v.S3, true, (await verdicts(w)).text);
  w.trees[M] = "T-aligned-differently";
  await onlyFails(w, "S3", /candidate: no router measurement/);
});
Deno.test("S3 mutation: the score log cannot be read", async () => {
  const w = base(); w.log = null;
  await onlyFails(w, "S3", /SCORE-LOG\.md on ci\/brain-eval cannot be read/);
});

// ------------------------------------------------------------------------------------------------ S4
Deno.test("S4 mutation: the acceptance suite failed in CI on the SHA (S1 fails with it: it is a required check)", async () => {
  const w = base(); w.runs.find((r) => r.name === ACCEPTANCE_CHECK)!.conclusion = "failure";
  const { v, text } = await verdicts(w);
  eq(v, { S1: false, S2: true, S3: true, S4: false, S5: true }, text);
  ok(/S4 FAIL: the suite is failure on/.test(text), text);
});
Deno.test("S4 mutation: the KNOWN_GAP list grew against the deployed SHA", async () => {
  const w = base(); w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered", "new-hole"]));
  await onlyFails(w, "S4", /KNOWN_GAP grew: new-hole/);
});
Deno.test("S4 mutation: the suite is missing at the SHA", async () => {
  const w = base(); w.files.delete(`${C}:${ACCEPTANCE_FILE}`);
  await onlyFails(w, "S4", /telegram-acceptance\.test\.ts is not in/);
});
Deno.test("S4: when the deployed SHA predates the suite, the baseline is the list as first committed (shrink-only from there)", async () => {
  const w = base(); w.files.delete(`${D}:${ACCEPTANCE_FILE}`); w.added = B; w.files.set(`${B}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"]));
  const r = await verdicts(w);
  eq(r.v.S4, true, r.text);
  ok(/baseline from the suite as first committed/.test(r.text), r.text);
  w.files.set(`${B}:${ACCEPTANCE_FILE}`, SUITE([]));
  await onlyFails(w, "S4", /KNOWN_GAP grew: fit-question-answered/);
});

// Review of #351, item 3: removing a failing step is not a pass.
Deno.test("S4 mutation: a step removed from STEPS (the gap list unchanged) fails", async () => {
  const w = base(); w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"], STEPS_ALL.filter((x) => x !== "missing-fact-asks")));
  await onlyFails(w, "S4", /steps removed from STEPS: missing-fact-asks/);
  w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE([], STEPS_ALL.filter((x) => x !== "fit-question-answered")));
  await onlyFails(w, "S4", /steps removed from STEPS: fit-question-answered/);
  w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"], [...STEPS_ALL, "a-new-step"]));
  eq((await verdicts(w)).v.S4, true, "adding a step is fine");
});

// Re-review of #351, item 2: a suite without a readable, non-empty STEPS list fails S4.
Deno.test("S4 mutation: a missing or empty STEPS list fails", async () => {
  const w = base(); w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"]).replace(/export const STEPS[\s\S]*$/, ""));
  await onlyFails(w, "S4", /no readable STEPS list/);
  w.files.set(`${C}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered"], []));
  await onlyFails(w, "S4", /no readable STEPS list/);
  const v = base(); v.files.set(`${D}:${ACCEPTANCE_FILE}`, SUITE(["fit-question-answered", "older-gap"]).replace(/export const STEPS[\s\S]*$/, ""));
  await onlyFails(v, "S4", /no baseline KNOWN_GAP and STEPS lists/);
});

// ------------------------------------------------------------------------------------------------ S5
Deno.test("S5 mutation: a feature enabled and NOT_WIRED", async () => {
  const w = base(); w.audit = { code: 1, out: FEATURES_OK.replace("FEATURE telegram ENABLED WIRED", "FEATURE telegram ENABLED NOT_WIRED missing=TELEGRAM_BOT_TOKEN") };
  await onlyFails(w, "S5", /enabled and NOT_WIRED: telegram/);
});
Deno.test("S5 mutation: the audit could not read the names (exit 2) is a FAIL, never a pass", async () => {
  const w = base(); w.audit = { code: 2, out: "NOT RUN: could not read Supabase function secrets" };
  await onlyFails(w, "S5", /exited 2: NOT RUN/);
});
Deno.test("S5 mutation: every non-zero exit fails, even with every printed feature wired; exit 0 with an enabled NOT_WIRED line fails", async () => {
  const w = base();
  for (const code of [1, 3, 127, -1]) { w.audit = { code, out: FEATURES_OK }; await onlyFails(w, "S5", new RegExp(`the secrets audit exited ${code}`)); }
  w.audit = { code: 0, out: FEATURES_OK.replace("FEATURE telegram ENABLED WIRED", "FEATURE telegram ENABLED NOT_WIRED missing=TELEGRAM_BOT_TOKEN") };
  await onlyFails(w, "S5", /enabled and NOT_WIRED: telegram/);
});
Deno.test("S5 mutation: an audit that printed no feature lines proves nothing", async () => {
  const w = base(); w.audit = { code: 0, out: "" };
  await onlyFails(w, "S5", /printed no feature lines/);
});

// ------------------------------------------------------------------------------------------------ exact check names
Deno.test("S1 mutation: check names match exactly: any other prefix or suffix does not stand for a required check", async () => {
  const w = base(); w.runs = w.runs.map((r) => r.name === "database" ? { ...r, name: "evil / database" } : r);
  await onlyFails(w, "S1", /database \(NO RUN\)/);
  const v = base(); v.runs = v.runs.map((r) => r.name === "preflight / go-live dry run (PR head)" ? { ...r, name: "other / go-live dry run (PR head)" } : r);
  await onlyFails(v, "S1", /go-live dry run \(PR head\) \(NO RUN\)/);
  const u = base(); u.runs = u.runs.map((r) => r.name === "gate (core)" ? { ...r, name: "gate (core) " } : r);
  await onlyFails(u, "S1", /gate \(core\) \(NO RUN\)/);
  const x = base(); x.runs = x.runs.map((r) => r.name === ACCEPTANCE_CHECK ? { ...r, name: `wrapper / ${ACCEPTANCE_CHECK}` } : r);
  const r = await verdicts(x);
  eq([r.v.S1, r.v.S4], [false, false], r.text);
  // The "preflight / " alias is for the jobs deploy-preflight.yml defines, never for a ci.yml job.
  const z = base(); z.runs = z.runs.map((r) => r.name === "database" ? { ...r, name: "preflight / database" } : r);
  await onlyFails(z, "S1", /database \(NO RUN\)/);
  const zz = base(); zz.runs = zz.runs.map((r) => r.name === ACCEPTANCE_CHECK ? { ...r, name: `preflight / ${ACCEPTANCE_CHECK}` } : r);
  const rz = await verdicts(zz);
  eq([rz.v.S1, rz.v.S4], [false, false], rz.text);
  for (const ok_ of ["preflight / go-live dry run (PR head)", "go-live dry run (PR head)"]) {
    const y = base(); y.runs = y.runs.map((r) => r.name === "preflight / go-live dry run (PR head)" ? { ...r, name: ok_ } : r);
    eq((await verdicts(y)).v.S1, true, `${ok_} stands for the preflight job`);
  }
});

// ------------------------------------------------------------------------------------------------ the rollback condition
// Review of #351, item 4: GitHub's own expression for the two rollback steps, evaluated for each outcome go-live and the
// smoke can end in. A timed-out step ends "failure"; a cancelled one "cancelled"; neither may skip the rollback.
function ghIf(expr: string, steps: { golive: string; smoke: string }, deployed = "d".repeat(40)): boolean {
  const js = expr.replace(/always\(\)/g, "true").replace(/steps\.(golive|smoke)\.outcome/g, (_, k) => JSON.stringify((steps as any)[k]))
    .replace(/needs\.standard\.outputs\.deployed_sha/g, JSON.stringify(deployed)).replace(/'([^']*)'/g, (_, v) => JSON.stringify(v));
  ok(!/[A-Za-z_]+\(/.test(js.replace(/\btrue\b/g, "")), `only always() and outcomes in the condition: ${expr}`);
  return Function(`"use strict"; return (${js});`)() as boolean;
}
Deno.test("deploy-production.yml: rollback runs on go-live or smoke failure, cancellation or timeout once go-live started; never otherwise; step timeouts leave it room", async () => {
  const wf = parseYaml(await Deno.readTextFile(`${ROOT}/.github/workflows/deploy-production.yml`)) as any;
  const job = wf.jobs.deploy, steps: any[] = job.steps;
  const golive = steps.find((s) => s.id === "golive"), smoke = steps.find((s) => s.id === "smoke");
  const rollback = steps.filter((s) => /^Roll ?back/i.test(s.name ?? ""));
  eq(rollback.length, 2, "the checkout and the redeploy");
  ok(steps.indexOf(golive) < steps.indexOf(smoke) && steps.indexOf(smoke) < steps.indexOf(rollback[0]));
  for (const s of rollback) {
    const run = (g: string, k: string) => ghIf(s.if, { golive: g, smoke: k });
    for (const [g, k] of [["failure", ""], ["cancelled", ""], ["success", "failure"], ["success", "cancelled"], ["success", "skipped"], ["success", ""]]) ok(run(g, k), `rollback when go-live ${g}, smoke ${k || "not reached"}: ${s.if}`);
    for (const [g, k] of [["success", "success"], ["skipped", ""], ["", ""]]) ok(!run(g, k), `no rollback when go-live ${g || "not reached"}, smoke ${k || "not reached"}: ${s.if}`);
  }
  ok(!ghIf(rollback[0].if, { golive: "failure", smoke: "" }, ""), "no checkout without a previous deployed SHA (the redeploy step then fails loudly)");
  ok(golive["timeout-minutes"] && smoke["timeout-minutes"] && rollback[1]["timeout-minutes"], "each has its own timeout");
  ok(golive["timeout-minutes"] + smoke["timeout-minutes"] + rollback[1]["timeout-minutes"] + 10 <= job["timeout-minutes"], "a timed-out go-live and smoke still leave the rollback its full time inside the job's");
  ok(/exit 1/.test(rollback[1].run), "the run is failed after a rollback");
  eq(job.environment, "production", "the environment's reviewers stay");
});

// ------------------------------------------------------------------------------------------------ an error in a source
Deno.test("a source that throws fails its check, with the error, and the run fails", async () => {
  const w = base();
  const src = { ...sources(w), checkRuns: async () => { throw new Error("GitHub /commits: HTTP 502"); } } as Sources;
  const { results } = await evaluate(src, C, ["S1"]);
  eq(results[0].pass, false);
  ok(/could not be evaluated: GitHub \/commits: HTTP 502/.test(results[0].summary), results[0].summary);
});

// ------------------------------------------------------------------------------------------------ the parsers on the repository's own files
Deno.test("the required list read from this repository's workflows: every gate, the matrix expanded, the acceptance job, the preflight", async () => {
  const ci = jobCheckNames(await Deno.readTextFile(`${ROOT}/.github/workflows/ci.yml`));
  for (const n of ["gate (core shard 1/2)", "gate (core shard 2/2)", "gate (core)", "gate (browser)", "gate (architect shard 6/6)", "gate (architect)", "gate (forms-ci coverage shard 5/5)",
    "gate (forms-ci coverage)", "database", "load (send rail)", ACCEPTANCE_CHECK]) ok(ci.includes(n), `${n} in ${JSON.stringify(ci)}`);
  ok(!ci.some((n) => /\$\{\{/.test(n)), `no unexpanded matrix name: ${JSON.stringify(ci)}`);
  const pre = jobCheckNames(await Deno.readTextFile(`${ROOT}/.github/workflows/deploy-preflight.yml`));
  eq(pre.sort(), ["go-live dry run (PR head)", "migration rehearsal (live-shaped schema)"]);
  ok(ci.length + pre.length >= 22, `${ci.length + pre.length} required checks`);
});
Deno.test("KNOWN_GAP is read from the acceptance suite itself, and every entry names one of its steps", async () => {
  const text = await Deno.readTextFile(`${ROOT}/${ACCEPTANCE_FILE}`);
  const gaps = knownGaps(text);
  eq(stepIds(text)?.length, 12, "the suite's STEPS are readable");
  ok(Array.isArray(gaps), "readable");
  const steps = [...(/export const STEPS = \[([\s\S]*?)\]/.exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  ok(steps.length >= 10, `steps: ${steps}`);
  for (const g of gaps!) ok(steps.includes(g), `${g} is a step`);
  eq(knownGaps(`export const KNOWN_GAP: readonly string[] = [\n  // "not-this": a comment\n  "x",\n] as const;`), ["x"], "a commented-out name is not on the list");
  eq(knownGaps("const nothing = 1;"), null);
});
Deno.test("parsers: PR numbers from merge subjects, the approvals ledger, the score log's rows", async () => {
  eq([prOf("Merge pull request #348 from a/b"), prOf("networking: short opener (#336)"), prOf("direct push"), prOf("mentions #12 in the middle")], [348, 336, null, null]);
  const l = parseLedger(`# PR SHA reviewer [note]\n348 ${H1} architect-claude reviewed: ok\n#349 ${H2} architect ok\n350 abc1234 architect too short\n351 ${H2}\nnot a line\n352 ${H1} jane.doe\n`);
  eq([...l.keys()], [348, 352], "a # line is a comment; a short SHA or a missing reviewer approves nothing");
  eq(l.get(348), [{ sha: H1, reviewer: "architect-claude", note: "reviewed: ok" }]);
  eq(l.get(352), [{ sha: H1, reviewer: "jane.doe", note: "" }]);
  const rows = parseScoreLog(await Deno.readTextFile(`${ROOT}/evals/career/SCORE-LOG.md`).catch(() => LOG_HEAD) + "\n" + row(C, "router", 22, "41220587684"));
  ok(rows.length >= 1);
  eq(rows[rows.length - 1], { commit: "ccccccc", set: "dev", brain: "router", size: 38, passed: 22, stopped: "no", run: "41220587684" });
  const ledger = await Deno.readTextFile(`${ROOT}/docs/architect/approvals.txt`);
  ok(/^# PR SHA reviewer \[note\]/m.test(ledger), "the committed ledger states its format");
});
