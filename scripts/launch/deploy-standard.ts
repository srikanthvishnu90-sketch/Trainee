// THE DEPLOY STANDARD (D-034; owner, in writing, 2026-10-31 11:57 CT: "set a requirement a standard, whenever the product
// reaches that standard deploy, make that a set rule, make sure it verifies and meets that large scale standard. if it does
// then auto deploy, also make sure u test everytime if it does."). A commit on release/production may deploy only if every
// check below holds. Each prints PASS or FAIL with its evidence; a check whose evidence cannot be read FAILS (never a soft
// pass), and any FAIL exits 1.
//
//   S1 every required CI check on that exact SHA concluded success. The required list is read from the workflows AT that
//      SHA: every job of .github/workflows/ci.yml (matrix jobs expanded) and of deploy-preflight.yml (which
//      deploy-production.yml also calls as job "preflight", so its checks exist on every deployed SHA). Names match exactly:
//      a ci.yml job by its own name, a preflight job by its own name or "preflight / <name>", nothing else. The latest run
//      of each name decides.
//   S2 every PR merged (first-parent commits of trunk) since the last successful production deploy has an APPROVED review at
//      its merged head SHA by an owner, member or collaborator who is not the PR's author, or a line
//      `<PR> <40-hex merged head SHA> <reviewer> [note]` in docs/architect/approvals.txt read from the TRUNK TIP at check time
//      (so the ledger may approve PRs merged before the line was written) whose reviewer is neither blank, nor the PR's
//      author, nor the account that merged it. A PR whose diff only adds lines to approvals.txt is exempt (it is the approval
//      record itself); a PR whose files cannot be read is never exempt (FAIL). A first-parent commit that names no PR, or
//      whose PR does not own it, fails. Ledger reviewer names are an audit record, not a cryptographic proof; true
//      enforcement needs a second reviewer account plus trunk branch protection (owner decision, open).
//   S3 reply quality does not regress: on ci/brain-eval's evals/career/SCORE-LOG.md, the pass rate of the brain the
//      candidate SHA serves, measured for the candidate, >= the pass rate of the brain the deployed SHA serves, measured for
//      the deployed SHA, on the same set and set size (same harness and judges: both are rows of that log). The brain a SHA
//      serves is its committed release config (supabase/functions/agent-chat/release_config.ts PRODUCTION_BRAIN, D-035),
//      read at that SHA; a SHA without the file predates D-035 and served the router. A config that cannot be read is a
//      FAIL, never a guess. "Reply code" is the one list in scripts/launch/reply-code.ts (the router bundle and packages/domain,
//      agent-chat, the brain under _shared/agent, and the _shared modules the reply path imports). A measurement counts for
//      a SHA when its brain commit is that SHA, or a first-parent ancestor within 10 commits with no reply-code change
//      since, or a measurement commit on ci/brain-eval whose second parent is one of those (the brain-eval convention: a
//      measurement commit merges the measured commit as its second parent) and whose reply code is identical, or a
//      measurement-branch commit descending from one of those whose reply code is identical. Rows that stopped, or are NOT
//      A SCORE, are not measurements. The rate of one measurement is the mean over the passes of its latest CI run. No
//      measurement on either side: FAIL. No tolerance: the means are compared exactly (integer cross-multiplication); a
//      tolerance needs a written owner ruling. --missing-measurement prints the SHA S3 still lacks a measurement for (the
//      candidate first, then the deployed SHA on the candidate's set) and the brain to measure it with (that SHA's served
//      brain), which deploy-production.yml then measures (scripts/launch/measure-reply.sh, MEASURE_BRAINS) before it judges.
//   S4 the Telegram acceptance suite (tests/architect/telegram-acceptance.test.ts) passed in CI on that SHA (its check,
//      "acceptance (telegram)", concluded success: every step not in KNOWN_GAP passed), and its KNOWN_GAP list did not grow
//      against the deployed SHA's (shrink-only), and its STEPS list did not lose a step (removing a failing step is not a
//      pass). Where the deployed SHA predates the suite, the baseline is the suite as first committed.
//   S5 scripts/launch/secrets-audit.sh --features: no feature both enabled and NOT_WIRED (a feature without its secrets stays
//      off; it is never faked). Any non-zero exit of the audit, or no feature lines, is a FAIL.
//
//   deno run -A scripts/launch/deploy-standard.ts --sha <40-hex> [--checks S1,S2,S3,S4,S5] [--exclude-run <run id>]
//                                                 [--wait-checks <minutes>]
//   deno run -A scripts/launch/deploy-standard.ts --sha <40-hex> --missing-measurement [--exclude-run <run id>]
//     prints `measure=<sha>` (empty when S3 has both measurements) and writes it to GITHUB_OUTPUT; judges nothing.
// --wait-checks: first wait (polling each minute, at most that long) until every required check on the SHA has finished,
// so a push to release/production right after a merge is judged on finished CI, not on runs still going. Waiting decides
// nothing: a check still unfinished at the deadline is judged as it stands (not success: FAIL).
// Needs: a git checkout with full history and origin/ci/brain-eval fetched; GITHUB_TOKEN and GITHUB_REPOSITORY (the checks,
// PR and Actions APIs, read only); for S5, what secrets-audit.sh needs (SUPABASE_PROJECT_REF, the supabase CLI logged in).
// It changes nothing anywhere. Exit 0: the SHA meets the standard; 1: it does not; 2: usage.
import { parse as parseYaml } from "npm:yaml@2.9.1";
import { REPLY_CODE as REPLY_CODE_PATHS } from "./reply-code.ts";
import { parseProductionBrain, RELEASE_CONFIG_PATH } from "../../supabase/functions/agent-chat/release_config.ts";

export type CheckId = "S1" | "S2" | "S3" | "S4" | "S5";
export const ALL_CHECKS: CheckId[] = ["S1", "S2", "S3", "S4", "S5"];
export interface CheckRun { name: string; status: string; conclusion: string | null; id: number; completed_at?: string | null }
export interface Pull { number: number; merged: boolean; merge_commit_sha: string | null; head_sha: string; base: string; author: string; merged_by: string }
export interface Review { state: string; commit_id: string; user: string; association: string }
export interface PullFile { filename: string; status: string; additions: number; deletions: number }
export interface Commit { sha: string; subject: string }
export interface Sources {
  checkRuns(sha: string): Promise<CheckRun[]>;
  fileAt(sha: string, path: string): Promise<string | null>;
  lastDeployedSha(): Promise<string | null>;
  firstParent(from: string, to: string): Promise<Commit[]>; // commits in from..to on to's first-parent line, newest first
  pull(n: number): Promise<Pull | null>;
  reviews(n: number): Promise<Review[]>;
  pullFiles(n: number): Promise<PullFile[] | null>; // null: unreadable (an API error or a 404)
  ledger(): Promise<string | null>; // docs/architect/approvals.txt at the trunk tip, now
  scoreLog(): Promise<string | null>;
  resolve(rev: string): Promise<string | null>; // full sha of a (short) commit, or null
  parent(sha: string): Promise<string | null>; // first parent
  secondParent?(sha: string): Promise<string | null>; // the second parent of a merge (a measurement commit's measured SHA)
  isAncestor(a: string, b: string): Promise<boolean>;
  changed(a: string, b: string, paths: readonly string[]): Promise<boolean>; // any difference under the paths between a and b
  tree(sha: string, paths: readonly string[]): Promise<string | null>; // one identity of the content under the paths; null: none
  firstAdded(sha: string, path: string): Promise<string | null>; // the commit (on sha's history) that added path
  secretsAudit(): Promise<{ code: number; out: string }>;
}
export interface Result { id: CheckId; pass: boolean; summary: string; evidence: string[] }

export const REPLY_CODE: readonly string[] = REPLY_CODE_PATHS;
export const ACCEPTANCE_FILE = "tests/architect/telegram-acceptance.test.ts";
export const ACCEPTANCE_CHECK = "acceptance (telegram)";
export const CI_WORKFLOW = ".github/workflows/ci.yml", PREFLIGHT_WORKFLOW = ".github/workflows/deploy-preflight.yml";
export const PREFLIGHT_CALLER = "preflight"; // the job in deploy-production.yml that calls deploy-preflight.yml
export const LEDGER = "docs/architect/approvals.txt";
export const REVIEWER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
const SHA40 = /^[0-9a-f]{40}$/;
const short = (s: string | null | undefined) => (s ?? "").slice(0, 10);

// ------------------------------------------------------------------------------------------------ S1
// Every job's check name in a workflow: `name:` (or the job id), each matrix combination substituted.
export function jobCheckNames(yaml: string): string[] {
  const doc = parseYaml(yaml) as { jobs?: Record<string, { name?: string; strategy?: { matrix?: Record<string, unknown> } }> };
  const out: string[] = [];
  for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
    const name = String(job?.name ?? id);
    const matrix = job?.strategy?.matrix ?? {};
    const axes = Object.entries(matrix).filter(([k, v]) => Array.isArray(v) && k !== "include" && k !== "exclude") as [string, unknown[]][];
    let combos: Record<string, unknown>[] = [{}];
    for (const [k, vs] of axes) combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
    for (const c of combos) out.push(name.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_, k) => String(c[k] ?? `\${{ matrix.${k} }}`)));
  }
  return out;
}

// Each required check and the exact check-run names that stand for it.
export interface Required { name: string; accept: string[] }
export async function requiredChecks(src: Sources, sha: string): Promise<Required[] | null> {
  const ci = await src.fileAt(sha, CI_WORKFLOW), pre = await src.fileAt(sha, PREFLIGHT_WORKFLOW);
  if (ci === null || pre === null) return null;
  const out = new Map<string, Required>();
  for (const n of [...jobCheckNames(ci), ACCEPTANCE_CHECK]) out.set(n, { name: n, accept: [n] });
  for (const n of jobCheckNames(pre)) out.set(n, { name: n, accept: [n, `${PREFLIGHT_CALLER} / ${n}`] });
  return [...out.values()];
}
export function latestOf(runs: CheckRun[], accept: string[]): CheckRun | undefined {
  return runs.filter((r) => accept.includes(r.name)).sort((a, b) => b.id - a.id)[0]; // check run ids only grow
}
const verdictOf = (r: CheckRun | undefined) => !r ? "NO RUN" : r.status !== "completed" ? r.status : r.conclusion ?? "none";

export async function s1(src: Sources, sha: string): Promise<Result> {
  const evidence: string[] = [];
  const required = await requiredChecks(src, sha);
  if (required === null) return { id: "S1", pass: false, summary: `a workflow is not in ${short(sha)}: the required list cannot be read`, evidence };
  const runs = await src.checkRuns(sha);
  const bad: string[] = [];
  for (const req of required) {
    const latest = latestOf(runs, req.accept);
    const verdict = verdictOf(latest);
    evidence.push(`${verdict === "success" ? "ok  " : "BAD "} ${req.name}: ${verdict}${latest ? ` (check run ${latest.id}, "${latest.name}")` : ""}`);
    if (verdict !== "success") bad.push(`${req.name} (${verdict})`);
  }
  return bad.length
    ? { id: "S1", pass: false, summary: `${bad.length}/${required.length} required checks are not success on ${short(sha)}: ${bad.slice(0, 6).join(", ")}${bad.length > 6 ? ", ..." : ""}`, evidence }
    : { id: "S1", pass: true, summary: `all ${required.length} required checks are success on ${short(sha)}`, evidence };
}

// The required checks whose latest run has not finished (or not started) on the SHA: what --wait-checks waits for.
export async function unfinished(src: Sources, sha: string): Promise<string[]> {
  const required = (await requiredChecks(src, sha)) ?? [{ name: ACCEPTANCE_CHECK, accept: [ACCEPTANCE_CHECK] }];
  const runs = await src.checkRuns(sha);
  return required.filter((req) => latestOf(runs, req.accept)?.status !== "completed").map((r) => r.name);
}

// ------------------------------------------------------------------------------------------------ S2
export function prOf(subject: string): number | null {
  const m = /^Merge pull request #(\d+) /.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}
export interface LedgerEntry { sha: string; reviewer: string; note: string }
export function parseLedger(text: string | null): Map<number, LedgerEntry[]> {
  const out = new Map<number, LedgerEntry[]>();
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\d+)\s+([0-9a-f]{40})\s+([A-Za-z0-9][A-Za-z0-9._@-]*)(?:\s+(.*))?$/.exec(line);
    if (!m) continue; // a malformed line approves nothing
    const n = Number(m[1]);
    out.set(n, [...(out.get(n) ?? []), { sha: m[2], reviewer: m[3], note: (m[4] ?? "").trim() }]);
  }
  return out;
}
// A ledger line approves the PR only at its exact merged head, with a reviewer who is neither blank, nor the PR's author, nor
// the account that merged it. (An audit record, not a proof: D-034.)
export function ledgerApproves(e: LedgerEntry, pr: Pull): boolean {
  const who = e.reviewer.trim().toLowerCase();
  return e.sha === pr.head_sha && !!who && who !== pr.author.toLowerCase() && who !== pr.merged_by.toLowerCase();
}
// A PR whose whole diff is lines added to the ledger: the approval record itself, exempt from needing one.
// Missing evidence is never an exemption: an unreadable or empty list is not ledger-only, and a renamed file never is.
export function ledgerOnly(files: PullFile[] | null): boolean {
  return !!files && files.length > 0 && files.every((f) => f.filename === LEDGER && f.deletions === 0 && f.additions > 0 && (f.status === "modified" || f.status === "added"));
}

export async function s2(src: Sources, sha: string, deployed: string | null): Promise<Result> {
  const evidence: string[] = [];
  if (!deployed) return { id: "S2", pass: false, summary: "no successful production deploy found: the PRs to review cannot be bounded", evidence };
  if (deployed === sha) return { id: "S2", pass: true, summary: `${short(sha)} is the deployed SHA: no PR merged since`, evidence };
  if (!(await src.isAncestor(deployed, sha))) return { id: "S2", pass: false, summary: `the deployed ${short(deployed)} is not an ancestor of ${short(sha)}`, evidence };
  const ledgerText = await src.ledger();
  evidence.push(ledgerText === null ? `${LEDGER} is not on the trunk tip: no ledger approvals` : `${LEDGER} read from the trunk tip`);
  const ledger = parseLedger(ledgerText);
  const commits = await src.firstParent(deployed, sha);
  const bad: string[] = [];
  for (const c of commits) {
    const n = prOf(c.subject);
    if (n === null) { bad.push(`${short(c.sha)} (no PR)`); evidence.push(`BAD  ${short(c.sha)} "${c.subject.slice(0, 70)}": not merged through a PR`); continue; }
    const pr = await src.pull(n);
    if (!pr || !pr.merged || pr.merge_commit_sha !== c.sha) {
      bad.push(`#${n} (does not own ${short(c.sha)})`);
      evidence.push(`BAD  #${n}: ${!pr ? "not found" : !pr.merged ? "not merged" : `its merge commit is ${short(pr.merge_commit_sha)}, not ${short(c.sha)}`}`);
      continue;
    }
    const author = pr.author.toLowerCase();
    const reviews = await src.reviews(n);
    const review = reviews.find((r) => r.state === "APPROVED" && r.commit_id === pr.head_sha && r.user.toLowerCase() !== author && REVIEWER_ASSOCIATIONS.includes(r.association));
    const lines = ledger.get(n) ?? [];
    // The ledger's reviewer names are an audit record, not a proof (D-034): a line naming the PR's author or the account that
    // merged it, or no reviewer at all, approves nothing.
    const entry = lines.find((e) => ledgerApproves(e, pr));
    if (review) evidence.push(`ok   #${n} head ${short(pr.head_sha)}: APPROVED by ${review.user} (${review.association})`);
    else if (entry) evidence.push(`ok   #${n} head ${short(pr.head_sha)}: ${LEDGER}, reviewer ${entry.reviewer}${entry.note ? `: ${entry.note.slice(0, 70)}` : ""}`);
    else {
      const files = await src.pullFiles(n).catch(() => null);
      if (files === null || !files.length) {
        bad.push(`#${n} (files unreadable)`);
        evidence.push(`BAD  #${n}: PR ${n} files unreadable (${files === null ? "the files API failed" : "an empty files list"}), and no independent approval at the merged head`);
        continue;
      }
      if (ledgerOnly(files)) { evidence.push(`ok   #${n}: exempt, its diff only adds lines to ${LEDGER}`); continue; }
      const why: string[] = [];
      const ignored = reviews.filter((r) => r.state === "APPROVED" && r.commit_id === pr.head_sha);
      if (ignored.length) why.push(`APPROVED at the head only by ${ignored.map((r) => `${r.user} (${r.user.toLowerCase() === author ? "the author" : r.association})`).join(", ")}, not counted`);
      if (lines.some((e) => e.sha === pr.head_sha)) why.push(`the ${LEDGER} line names the author or the merging account as reviewer`);
      else if (lines.length) why.push(`${LEDGER} names ${lines.map((e) => short(e.sha)).join(", ")}, not the merged head`);
      bad.push(`#${n}`);
      evidence.push(`BAD  #${n} head ${short(pr.head_sha)}: no independent approval at the merged head${why.length ? `; ${why.join("; ")}` : `, and no ${LEDGER} line`}`);
    }
  }
  return bad.length
    ? { id: "S2", pass: false, summary: `${bad.length}/${commits.length} merges since ${short(deployed)} lack an approval at their merged head: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? ", ..." : ""}`, evidence }
    : { id: "S2", pass: true, summary: `all ${commits.length} merges since ${short(deployed)} are approved at their merged head`, evidence };
}

// ------------------------------------------------------------------------------------------------ S3
export interface ScoreRow { commit: string; set: string; brain: string; size: number; passed: number; stopped: string; run: string }
// What makes two measurements comparable beyond set and size: the harness (the CI run column's "; harness: ...") and the
// judge pair. Kept off ScoreRow's own keys (tests/architect/deploy-standard.test.ts pins that shape) as non-enumerable
// properties, read through these two functions.
const HARNESS = Symbol("harness"), JUDGES = Symbol("judges");
type Tagged = ScoreRow & { [HARNESS]?: string; [JUDGES]?: string };
export const harnessOf = (r: ScoreRow) => (r as Tagged)[HARNESS] ?? "";
export const judgesOf = (r: ScoreRow) => (r as Tagged)[JUDGES] ?? "";
// The judges column names the judge pair with each judge's own count of that pass ("gpt-5-mini 35, gpt-4.1-mini 34;
// both-pass ..."): the counts differ pass to pass, the pair does not. Without the counts it is the pair.
export function judgePair(col: string): string {
  return col.replace(/(^|[\s(])\d+(?=[\s,;)]|$)/g, "$1").replace(/\s+/g, " ").replace(/\s+([,;)])/g, "$1").trim();
}
// Five passes per measurement: measure-reply.sh asks brain-eval for five, and the pass-to-pass swing of 16-18 points
// (brain-eval.yml) means fewer cannot be compared. Only rows whose stopped column is "no" qualify: a pass that crashed
// writes no row, and a STOPPED or NOT A SCORE (judge or brain error) row is not a score.
export const MEASUREMENT_PASSES = 5;
export function parseScoreLog(text: string): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 10 || !/^[0-9a-f]{7,40}$/.test(c[1])) continue;
    const size = Number(c[4]), passed = Number(c[5]);
    if (!Number.isFinite(size) || !Number.isFinite(passed) || size <= 0) continue;
    const r: ScoreRow = { commit: c[1], set: c[2], brain: c[3], size, passed, stopped: c[8], run: (/^(\d+)/.exec(c[9]) ?? [])[1] ?? "" };
    Object.defineProperty(r, HARNESS, { value: (/;\s*harness:\s*(.*)$/.exec(c[9]) ?? [])[1]?.trim() ?? "", enumerable: false });
    Object.defineProperty(r, JUDGES, { value: judgePair(c[7]), enumerable: false });
    rows.push(r);
  }
  return rows;
}
export interface Measurement { set: string; size: number; run: string; rate: number; passes: number; passed: number; commit: string; harness: string; judges: string }
// The rows the deployed side may be measured by: the candidate's set, size, harness and judge pair. A deployed measurement
// under another harness or other judges is not comparable, so --missing-measurement names the deployed SHA to re-measure.
const comparable = (rows: ScoreRow[], m: Measurement) => rows.filter((r) => r.set === m.set && r.size === m.size && harnessOf(r) === m.harness && judgesOf(r) === m.judges);
const onWhat = (m: Measurement) => `set ${m.set}/${m.size}, harness "${m.harness || "(none)"}", judges "${m.judges}"`;

// The SHAs a measurement may stand for: sha and its first-parent ancestors within 10 commits, up to the first one whose
// reply code differs from sha's.
export async function sameReplyCode(src: Sources, sha: string): Promise<string[]> {
  const out = [sha];
  let cur = sha;
  for (let i = 0; i < 10; i++) {
    const p = await src.parent(cur);
    if (!p || (await src.changed(p, sha, REPLY_CODE))) break;
    out.push(p);
    cur = p;
  }
  return out;
}

export async function measurementOf(src: Sources, sha: string, rows: ScoreRow[], brain: string): Promise<{ m: Measurement | null; why: string }> {
  const lineage = await sameReplyCode(src, sha);
  const tree = await src.tree(sha, REPLY_CODE);
  const valid = rows.filter((r) => r.brain === brain && r.stopped === "no" && r.run);
  const cache = new Map<string, boolean>();
  const counts = async (short: string) => {
    if (cache.has(short)) return cache.get(short)!;
    let yes = false;
    const full = await src.resolve(short);
    if (full) {
      if (lineage.includes(full)) yes = true;
      else if (tree && (await src.tree(full, REPLY_CODE)) === tree) {
        // A measurement commit: its second parent is the commit it measured (and its reply code is that commit's).
        const measured = src.secondParent ? await src.secondParent(full) : null;
        if (measured && lineage.includes(measured)) yes = true;
        else for (const a of lineage) if (await src.isAncestor(a, full)) { yes = true; break; }
      }
    }
    cache.set(short, yes);
    return yes;
  };
  const mine: ScoreRow[] = [];
  for (const r of valid) if (await counts(r.commit)) mine.push(r);
  if (!mine.length) return { m: null, why: `no ${brain} measurement on ci/brain-eval for ${short(sha)} or its ${lineage.length - 1} same-reply-code ancestors` };
  const latestRun = mine.map((r) => r.run).sort((a, b) => Number(b) - Number(a))[0];
  const run = mine.filter((r) => r.run === latestRun);
  const { set, size } = run[0], harness = harnessOf(run[0]), judges = judgesOf(run[0]);
  // Only rows whose stopped column is "no" qualify (a STOPPED or NOT A SCORE row is not a score); one run's passes must
  // share one set, size, harness and judge pair, or the run is no measurement.
  const same = run.filter((r) => r.set === set && r.size === size && harnessOf(r) === harness && judgesOf(r) === judges);
  if (same.length !== run.length) {
    return { m: null, why: `CI run ${latestRun}, the latest ${brain} measurement of ${short(sha)}, mixes sets, harnesses or judge pairs across its passes` };
  }
  if (same.length !== MEASUREMENT_PASSES) {
    return { m: null, why: `CI run ${latestRun}, the latest ${brain} measurement of ${short(sha)}, has ${same.length} qualifying passes, not ${MEASUREMENT_PASSES} (crashed, brain-error, judge-error and stopped passes do not count)` };
  }
  const passed = same.reduce((a, r) => a + r.passed, 0);
  return { m: { set, size, run: latestRun, rate: passed / size / same.length, passes: same.length, passed, commit: same[0].commit, harness, judges }, why: "" };
}

// The brain a SHA serves in production (D-035): PRODUCTION_BRAIN in its committed release config; a SHA without the file
// predates the config and served the router (CAREER_BRAIN unset in production). Throws when the file is there but its
// value cannot be read, so S3 fails rather than measure the wrong brain.
export async function servedBrainAt(src: Sources, sha: string): Promise<string> {
  const text = await src.fileAt(sha, RELEASE_CONFIG_PATH);
  return text === null ? "router" : parseProductionBrain(text);
}

export async function s3(src: Sources, sha: string, deployed: string | null): Promise<Result> {
  const evidence: string[] = [];
  if (!deployed) return { id: "S3", pass: false, summary: "no successful production deploy found: nothing to compare with", evidence };
  const log = await src.scoreLog();
  if (log === null) return { id: "S3", pass: false, summary: "evals/career/SCORE-LOG.md on ci/brain-eval cannot be read", evidence };
  const rows = parseScoreLog(log);
  const cb = await servedBrainAt(src, sha), db = await servedBrainAt(src, deployed);
  const served = `served brains (${RELEASE_CONFIG_PATH}): candidate ${short(sha)} ${cb}, deployed ${short(deployed)} ${db}`;
  const cand = await measurementOf(src, sha, rows, cb);
  if (!cand.m) return { id: "S3", pass: false, summary: `candidate: ${cand.why}`, evidence: [served] };
  evidence.push(`candidate ${short(sha)}: ${(cand.m.rate * 100).toFixed(1)}% (${cb}, ${cand.m.set}/${cand.m.size}, mean of ${cand.m.passes} passes of CI run ${cand.m.run}, brain commit ${cand.m.commit})`);
  // The deployed side is measured on the candidate's set, size, harness and judges, with the brain it served: only those rows count.
  const dep = await measurementOf(src, deployed, comparable(rows, cand.m), db);
  if (!dep.m) return { id: "S3", pass: false, summary: `deployed: ${dep.why} on ${onWhat(cand.m)}`, evidence: [...evidence, served] };
  evidence.push(`deployed  ${short(deployed)}: ${(dep.m.rate * 100).toFixed(1)}% (${db}, ${dep.m.set}/${dep.m.size}, mean of ${dep.m.passes} passes of CI run ${dep.m.run}, brain commit ${dep.m.commit})`);
  // Same size on both sides: mean(c) >= mean(d)  <=>  sum(c) * passes(d) >= sum(d) * passes(c). Exact, no tolerance.
  const pass = cand.m.passed * dep.m.passes >= dep.m.passed * cand.m.passes;
  evidence.push(served);
  return { id: "S3", pass, summary: `${cb} pass rate ${(cand.m.rate * 100).toFixed(1)}% ${pass ? ">=" : "<"} deployed ${db === cb ? "" : `${db} `}${(dep.m.rate * 100).toFixed(1)}%`, evidence };
}

// The SHA S3 still needs a measurement for: the candidate when it has none; else the deployed SHA when it has none on the
// candidate's set, size, harness and judge pair (so a harness change re-measures the deployed SHA); else null. With it,
// the brain to measure it with: the brain that SHA serves (servedBrainAt). deploy-production.yml measures it
// (measure-reply.sh with MEASURE_BRAINS=<brain>) and asks again.
export async function missingMeasurement(src: Sources, sha: string, deployed: string | null): Promise<{ sha: string | null; brain: string | null; why: string }> {
  const log = await src.scoreLog();
  const rows = log === null ? [] : parseScoreLog(log);
  const cb = await servedBrainAt(src, sha);
  const cand = await measurementOf(src, sha, rows, cb);
  if (!cand.m) return { sha, brain: cb, why: `candidate: ${cand.why}` };
  if (!deployed) return { sha: null, brain: null, why: "no successful production deploy found: S3 fails whatever is measured" };
  const db = await servedBrainAt(src, deployed);
  const dep = await measurementOf(src, deployed, comparable(rows, cand.m), db);
  if (!dep.m) return { sha: deployed, brain: db, why: `deployed: ${dep.why} on ${onWhat(cand.m)}` };
  return { sha: null, brain: null, why: `both measured: candidate by CI run ${cand.m.run}, deployed by CI run ${dep.m.run} (served brains: candidate ${cb}, deployed ${db})` };
}

// ------------------------------------------------------------------------------------------------ S4
export function knownGaps(text: string): string[] | null {
  const m = /export const KNOWN_GAP\b[^=]*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) return null;
  const body = m[1].split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  return [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
}

export function stepIds(text: string): string[] | null {
  const m = /export const STEPS\b[^=]*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) return null;
  const body = m[1].split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  return [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
}

export async function s4(src: Sources, sha: string, deployed: string | null): Promise<Result> {
  const evidence: string[] = [];
  const now = await src.fileAt(sha, ACCEPTANCE_FILE);
  if (now === null) return { id: "S4", pass: false, summary: `${ACCEPTANCE_FILE} is not in ${short(sha)}`, evidence };
  const gaps = knownGaps(now);
  if (gaps === null) return { id: "S4", pass: false, summary: "the suite has no readable KNOWN_GAP list", evidence };
  const steps = stepIds(now);
  if (steps === null || !steps.length) return { id: "S4", pass: false, summary: "the suite has no readable STEPS list", evidence };
  const latest = latestOf(await src.checkRuns(sha), [ACCEPTANCE_CHECK]);
  const verdict = verdictOf(latest);
  evidence.push(`${ACCEPTANCE_CHECK} on ${short(sha)}: ${verdict}${latest ? ` (check run ${latest.id})` : ""}`);
  evidence.push(`KNOWN_GAP at ${short(sha)} (${gaps.length}): ${gaps.join(", ") || "none"}`);
  let baseText: string | null = null, baseFrom = "";
  if (deployed) {
    baseText = await src.fileAt(deployed, ACCEPTANCE_FILE);
    if (baseText !== null) baseFrom = `the deployed ${short(deployed)}`;
  }
  if (baseText === null) {
    const added = await src.firstAdded(sha, ACCEPTANCE_FILE);
    baseText = added ? await src.fileAt(added, ACCEPTANCE_FILE) : null;
    if (baseText !== null) baseFrom = `the suite as first committed (${short(added)}; the deployed SHA predates it)`;
  }
  const base = baseText === null ? null : knownGaps(baseText), baseSteps = baseText === null ? null : stepIds(baseText);
  if (base === null || baseSteps === null) return { id: "S4", pass: false, summary: "no baseline KNOWN_GAP and STEPS lists to compare with", evidence };
  evidence.push(`baseline from ${baseFrom}: KNOWN_GAP (${base.length}) ${base.join(", ") || "none"}; STEPS ${baseSteps.length}`);
  const grown = gaps.filter((g) => !base.includes(g));
  const dropped = baseSteps.filter((x) => !steps.includes(x));
  const problems: string[] = [];
  if (verdict !== "success") problems.push(`the suite is ${verdict} on ${short(sha)}`);
  if (grown.length) problems.push(`KNOWN_GAP grew: ${grown.join(", ")}`);
  if (dropped.length) problems.push(`steps removed from STEPS: ${dropped.join(", ")}`);
  return problems.length
    ? { id: "S4", pass: false, summary: problems.join("; "), evidence }
    : { id: "S4", pass: true, summary: `the suite passed on ${short(sha)}; KNOWN_GAP ${gaps.length} <= baseline ${base.length}, none added; STEPS ${steps.length}, none removed`, evidence };
}

// ------------------------------------------------------------------------------------------------ S5
export async function s5(src: Sources): Promise<Result> {
  const { code, out } = await src.secretsAudit();
  const lines = out.split("\n").filter((l) => /^FEATURE /.test(l));
  const evidence = lines.map((l) => l.replace(/^FEATURE /, ""));
  const bad = lines.filter((l) => /\bENABLED\b/.test(l) && /\bNOT_WIRED\b/.test(l)).map((l) => l.split(/\s+/)[1]);
  const last = out.trim().split("\n").pop() ?? "";
  // Exit 0 is the only pass; every other exit (1: something enabled and NOT_WIRED, 2: names unreadable, anything else) fails.
  if (code !== 0) return { id: "S5", pass: false, summary: `the secrets audit exited ${code}${bad.length ? `; enabled and NOT_WIRED: ${bad.join(", ")}` : `: ${last}`}`.slice(0, 300), evidence };
  if (!lines.length) return { id: "S5", pass: false, summary: `the secrets audit printed no feature lines: ${last}`.slice(0, 300), evidence };
  if (bad.length) return { id: "S5", pass: false, summary: `enabled and NOT_WIRED: ${bad.join(", ")}`, evidence };
  return { id: "S5", pass: true, summary: `${lines.length} features: none enabled and NOT_WIRED`, evidence };
}

export async function evaluate(src: Sources, sha: string, checks: CheckId[] = ALL_CHECKS): Promise<{ results: Result[]; deployed: string | null }> {
  const deployed = checks.some((c) => c === "S2" || c === "S3" || c === "S4") ? await src.lastDeployedSha() : null;
  const results: Result[] = [];
  for (const c of checks) {
    try {
      results.push(c === "S1" ? await s1(src, sha) : c === "S2" ? await s2(src, sha, deployed) : c === "S3" ? await s3(src, sha, deployed) : c === "S4" ? await s4(src, sha, deployed) : await s5(src));
    } catch (e) {
      results.push({ id: c, pass: false, summary: `could not be evaluated: ${String((e as Error)?.message ?? e).slice(0, 300)}`, evidence: [] });
    }
  }
  return { results, deployed };
}

export function report(sha: string, deployed: string | null, results: Result[]): string {
  const lines = [`DEPLOY STANDARD for ${sha} (last successful production deploy: ${deployed ?? "none found"})`];
  for (const r of results) {
    lines.push(`${r.id} ${r.pass ? "PASS" : "FAIL"}: ${r.summary}`);
    for (const e of r.evidence) lines.push(`    ${e}`);
  }
  const failed = results.filter((r) => !r.pass).map((r) => r.id);
  lines.push(failed.length ? `DEPLOY STANDARD: FAIL (${failed.join(", ")}): ${sha} does not deploy` : `DEPLOY STANDARD: PASS (${results.map((r) => r.id).join(", ")}): ${sha} meets the standard`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------ the live sources
async function git(args: string[]): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout) };
}
export function liveSources(o: { repo: string; token: string; excludeRun?: string; scoreRef?: string; trunkRef?: string; audit?: string[] }): Sources {
  const api = async (path: string): Promise<any> => {
    const res = await fetch(`https://api.github.com/repos/${o.repo}${path}`, { headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  };
  return {
    async checkRuns(sha) {
      const out: CheckRun[] = [];
      for (let page = 1; page < 20; page++) {
        const j = await api(`/commits/${sha}/check-runs?per_page=100&page=${page}`);
        const runs = j?.check_runs ?? [];
        out.push(...runs.map((r: any) => ({ name: r.name, status: r.status, conclusion: r.conclusion, id: r.id, completed_at: r.completed_at })));
        if (runs.length < 100) break;
      }
      return out;
    },
    async fileAt(sha, path) { const r = await git(["show", `${sha}:${path}`]); return r.code === 0 ? r.out : null; },
    async lastDeployedSha() {
      for (let page = 1; page < 10; page++) {
        const j = await api(`/actions/workflows/deploy-production.yml/runs?branch=release/production&status=success&per_page=50&page=${page}`);
        const runs = (j?.workflow_runs ?? []) as any[];
        const hit = runs.find((r) => String(r.id) !== o.excludeRun && r.conclusion === "success");
        if (hit) return hit.head_sha;
        if (runs.length < 50) break;
      }
      return null;
    },
    async firstParent(from, to) {
      const r = await git(["log", "--first-parent", "--format=%H%x09%s", `${from}..${to}`]);
      if (r.code !== 0) throw new Error(`git log ${short(from)}..${short(to)} failed`);
      return r.out.split("\n").filter(Boolean).map((l) => ({ sha: l.split("\t")[0], subject: l.slice(41) }));
    },
    async pull(n) {
      const j = await api(`/pulls/${n}`);
      return j ? { number: j.number, merged: !!j.merged, merge_commit_sha: j.merge_commit_sha, head_sha: j.head.sha, base: j.base.ref, author: j.user?.login ?? "", merged_by: j.merged_by?.login ?? "" } : null;
    },
    async reviews(n) {
      const out: Review[] = [];
      for (let page = 1; page < 10; page++) {
        const j = (await api(`/pulls/${n}/reviews?per_page=100&page=${page}`)) ?? [];
        out.push(...j.map((r: any) => ({ state: r.state, commit_id: r.commit_id, user: r.user?.login ?? "", association: r.author_association ?? "" })));
        if (j.length < 100) break;
      }
      return out;
    },
    async pullFiles(n) {
      const out: PullFile[] = [];
      for (let page = 1; page < 40; page++) {
        const j = await api(`/pulls/${n}/files?per_page=100&page=${page}`).catch(() => null);
        if (!Array.isArray(j)) return null; // a 404 or an error: unreadable, never "no files"
        out.push(...j.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })));
        if (j.length < 100) break;
      }
      return out;
    },
    async ledger() { const r = await git(["show", `${o.trunkRef ?? "origin/trunk"}:${LEDGER}`]); return r.code === 0 ? r.out : null; },
    async scoreLog() { const r = await git(["show", `${o.scoreRef ?? "origin/ci/brain-eval"}:evals/career/SCORE-LOG.md`]); return r.code === 0 ? r.out : null; },
    async resolve(rev) { const r = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]); return r.code === 0 ? r.out.trim() : null; },
    async parent(sha) { const r = await git(["rev-parse", "--verify", "--quiet", `${sha}^1`]); return r.code === 0 ? r.out.trim() : null; },
    async secondParent(sha) { const r = await git(["rev-parse", "--verify", "--quiet", `${sha}^2`]); return r.code === 0 ? r.out.trim() : null; },
    async isAncestor(a, b) { return (await git(["merge-base", "--is-ancestor", a, b])).code === 0; },
    async changed(a, b, paths) {
      const r = await git(["diff", "--quiet", a, b, "--", ...paths]);
      if (r.code > 1) throw new Error(`git diff ${short(a)} ${short(b)} failed`);
      return r.code === 1;
    },
    async tree(sha, paths) {
      // Every blob under the paths (mode, id, path): equal output is equal content. None of the paths at sha: null.
      const r = await git(["ls-tree", "-r", "--full-tree", sha, "--", ...paths]);
      if (r.code !== 0) throw new Error(`git ls-tree ${short(sha)} failed`);
      if (!r.out.trim()) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.out));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    async firstAdded(sha, path) {
      const r = await git(["log", "--diff-filter=A", "--format=%H", sha, "--", path]);
      const all = r.out.split("\n").filter(Boolean);
      return all.length ? all[all.length - 1] : null;
    },
    async secretsAudit() {
      const r = await new Deno.Command("bash", { args: o.audit ?? ["scripts/launch/secrets-audit.sh", "--features"], stdout: "piped", stderr: "piped" }).output();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
    },
  };
}

if (import.meta.main) {
  const args = [...Deno.args];
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const sha = opt("--sha") ?? "";
  const checks = (opt("--checks") ?? ALL_CHECKS.join(",")).split(",").map((s) => s.trim().toUpperCase()) as CheckId[];
  if (!SHA40.test(sha) || !checks.length || checks.some((c) => !ALL_CHECKS.includes(c))) {
    console.error("usage: deploy-standard.ts --sha <40-hex> [--checks S1,S2,S3,S4,S5] [--exclude-run <run id>] [--wait-checks <min>] | --missing-measurement");
    Deno.exit(2);
  }
  const repo = Deno.env.get("GITHUB_REPOSITORY") ?? "", token = Deno.env.get("GITHUB_TOKEN") ?? "";
  if (!repo || !token) { console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required (read-only API calls)"); Deno.exit(2); }
  const src = liveSources({ repo, token, excludeRun: opt("--exclude-run") });
  if (args.includes("--missing-measurement")) {
    const deployed = await src.lastDeployedSha();
    const need = await missingMeasurement(src, sha, deployed);
    console.log(`S3 measurements for ${sha} (deployed: ${deployed ?? "none found"}): ${need.sha ? `missing for ${need.sha} (${need.brain}): ${need.why}` : need.why}`);
    console.log(`measure=${need.sha ?? ""}`);
    console.log(`brain=${need.brain ?? ""}`);
    const out = Deno.env.get("GITHUB_OUTPUT");
    if (out) await Deno.writeTextFile(out, `measure=${need.sha ?? ""}\nbrain=${need.brain ?? ""}\n`, { append: true });
    Deno.exit(0);
  }
  const waitMin = Number(opt("--wait-checks") ?? 0);
  if (waitMin > 0 && checks.includes("S1")) {
    const deadline = Date.now() + waitMin * 60_000;
    for (;;) {
      const left = await unfinished(src, sha).catch(() => ["(the checks API)"]);
      if (!left.length) break;
      if (Date.now() >= deadline) { console.log(`waited ${waitMin} min; still unfinished: ${left.join(", ")}`); break; }
      console.log(`waiting for ${left.length} required checks to finish: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ", ..." : ""}`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
  const { results, deployed } = await evaluate(src, sha, checks);
  const text = report(sha, deployed, results);
  console.log(text);
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary) await Deno.writeTextFile(summary, `### Deploy standard\n\n\`\`\`\n${text}\n\`\`\`\n`, { append: true });
  const out = Deno.env.get("GITHUB_OUTPUT");
  if (out) await Deno.writeTextFile(out, `deployed_sha=${deployed ?? ""}\nverdict=${results.every((r) => r.pass) ? "pass" : "fail"}\n`, { append: true });
  Deno.exit(results.every((r) => r.pass) ? 0 : 1);
}
