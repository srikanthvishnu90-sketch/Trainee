// Release 9 workstream D, review regressions for PR #591. Each test reproduces one review finding and fails on the code
// before its fix:
//   S6 counts only a production-brain, claude-model, full-set measurement (never router/staged/planner, fake or a
//   partial or padded set), and a change under tests/flow/ needs a fresh measurement;
//   a File link without a slash before its query is delivered when its token verifies for this person, and only then;
//   a comparison File fails research with the reason it cannot carry sources;
//   a typo in --budget-usd is refused instead of removing the cap;
//   the confirmed resume sent back unchanged, or the same PDF twice, is not a tailored result;
//   a number is backed only by the same whole number (3.7 never backs 3, 2025 never backs 202).
import { inventedIn, judgeResearch, judgeResume, linkedFileIds, type E2EState } from "../../evals/career/e2e/judge.ts";
import { appendRow, type E2ERun, parseBudgetUsd, scoreRow } from "../../evals/career/e2e/score_log.ts";
import { E2E_CODE, s6, S6_BAR, type Sources } from "../../scripts/launch/deploy-standard.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`); };
const empty = (): E2EState => ({ wanted: [], jobs: [], ats: [], confirmed: { text: "Alex Testcase", resume_sha256: "a".repeat(64), name: "Alex Testcase" }, drafts: [], sendQueue: [], mail: [], contacts: [], hashOf: {}, files: [], documents: [], stage: [] });

const run = (o: Partial<E2ERun> = {}): E2ERun => ({ label: "e2e-x", brain: "production", model: "claude", commit: "c".repeat(40), total: 40, passed: 40, rate: 1,
  areas: { apply: { total: 10, passed: 10 }, outreach: { total: 10, passed: 10 }, research: { total: 10, passed: 10 }, resume: { total: 10, passed: 10 } }, guards: { total: 6, held: 6 }, stopped: null, cost_usd: 1, items: [], run_at: "2026-11-07T12:00:00.000Z", ...o });
const LOG = "# Brain score log\n\n| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
const src = (log: string, changed: (paths: readonly string[]) => boolean = () => false, parents: Record<string, string> = {}): Sources =>
  ({ scoreLog: () => Promise.resolve(log), parent: (s: string) => Promise.resolve(parents[s] ?? null), changed: (_a: string, _b: string, p: readonly string[]) => Promise.resolve(changed(p)) }) as unknown as Sources;
const C = "c".repeat(40);

Deno.test("S6 review: only a production-brain claude run on the full set counts", async () => {
  eq((await s6(src(appendRow(LOG, scoreRow(run()))), C)).pass, true, "production, claude, 40 tasks and 6 guards: counts");
  for (const brain of ["router", "staged", "planner"]) eq((await s6(src(appendRow(LOG, scoreRow(run({ brain })))), C)).pass, false, `a --brain ${brain} run is an experiment, never the release bar`);
  eq((await s6(src(appendRow(LOG, scoreRow(run({ model: "fake" })))), C)).pass, false, "a fake-model run never counts");
  eq((await s6(src(appendRow(LOG, scoreRow(run({ total: 41, passed: 41 })))), C)).pass, false, "a padded set (41 tasks) is not the held-out set");
  eq((await s6(src(appendRow(LOG, scoreRow(run({ guards: { total: 2, held: 2 } })))), C)).pass, false, "a set with guards left out is not the full set");
  // A newer experimental row never overrides (or stands in for) the production measurement.
  const failing = appendRow(LOG, scoreRow(run({ passed: 30 })));
  eq((await s6(src(appendRow(failing, scoreRow(run({ brain: "planner" })))), C)).pass, false, "a passing planner row after a failing production row: still a fail");
});

Deno.test("S6 review: the full-set sizes are the held-out set's, and tests/flow/ changes need a new measurement", async () => {
  const set = JSON.parse(await Deno.readTextFile(new URL("../../evals/career/e2e/tasks.json", import.meta.url)));
  const tasks = set.tasks as { kind: string }[];
  eq([tasks.filter((t) => t.kind !== "guard").length, tasks.filter((t) => t.kind === "guard").length], [S6_BAR.fullTasks, S6_BAR.fullGuards], "S6_BAR matches tasks.json");
  assert(E2E_CODE.includes("tests/flow/"), "the runner's database, HTTP double and handler wrapper are part of what was measured");
  const P = "p".repeat(40), onParent = appendRow(LOG, scoreRow(run({ commit: P })));
  eq((await s6(src(onParent, (p) => p.includes("tests/flow/"), { [C]: P }), C)).pass, false, "a change under tests/flow/ since the measured ancestor");
});

Deno.test("E2E review: a File link is delivered when its token verifies for this person, slash or not", async () => {
  const secret = "e2e-stub-world-file-link-key-not-real", now = Date.parse("2026-11-04T15:00:00Z");
  const t = await mintFileToken({ secret, userId: "user-a", list: "0123456789", now });
  assert(t, "minted");
  const ids = (text: string, userId = "user-a", key = secret) => linkedFileIds(text, { base: "https://file.e2e.test", secret: key, userId, now: now + 1000 });
  eq([...await ids(`Here is your file: https://file.e2e.test?t=${t}`)], ["0123456789"], "no slash before the query");
  eq([...await ids(`Open https://file.e2e.test/?t=${t}.`)], ["0123456789"], "with a slash, trailing period");
  eq([...await ids(`https://file.e2e.test?t=${t}`, "user-b")], [], "another person's File is not delivered to this one");
  eq([...await ids(`https://file.e2e.test?t=${t}`, "user-a", "a-different-key-that-is-long-enough-0")], [], "a token that does not verify delivers nothing");
  eq([...await ids("I made File 0123456789 for you.")], [], "naming the record id is not a link");
});

Deno.test("E2E review: a comparison File fails research with the reason (no sources field), not a silent miss", () => {
  const f = { id: "c1", kind: "comparison", html: "", text: "Stripe Ramp starting pay 120,000", delivered: true, findings: [{ text: "Starting pay 120,000", source: "Reported, not verified" }], sources: [] };
  const failed = judgeResearch({ has: ["Stripe", "Ramp"] }, { ...empty(), files: [f] });
  assert(failed.some((x) => /comparison File has no sources field/.test(x)), JSON.stringify(failed));
});

Deno.test("E2E review: --budget-usd must be a finite positive number", () => {
  for (const bad of ["3x", "Infinity", "NaN", "0", "-1", "", "1e3", " "]) eq(parseBudgetUsd(bad), null, `"${bad}" is refused`);
  eq([parseBudgetUsd("3"), parseBudgetUsd("2.5"), parseBudgetUsd(" 70 ")], [3, 2.5, 70]);
});

Deno.test("E2E review: the unchanged resume, or one PDF twice, is not a tailored result", () => {
  const text = `Alex Testcase\n${"Built dashboards and reporting pipelines for internal teams. ".repeat(6)}`;
  const pdf = { opens: true, pages: 1, text, why: "" } as unknown as E2EState["documents"][number]["pdf"];
  const doc = (sha: string) => ({ filename: "Resume.pdf", mime: "application/pdf", delivered: true, pdf, sha256: sha });
  const s = empty();
  eq(judgeResume({ min: 1 }, { ...s, confirmed: { ...s.confirmed, text }, documents: [doc("b".repeat(64))] }), [], "a tailored PDF passes");
  assert(judgeResume({ min: 1 }, { ...s, confirmed: { ...s.confirmed, text }, documents: [doc("a".repeat(64))] }).some((x) => /unchanged/.test(x)), "the confirmed resume itself");
  assert(judgeResume({ min: 2 }, { ...s, confirmed: { ...s.confirmed, text }, documents: [doc("b".repeat(64)), doc("b".repeat(64))] }).length > 0, "two copies of one PDF are one result");
});

Deno.test("E2E review: numbers are backed only by the same whole number", () => {
  eq(inventedIn("3 years of experience", "GPA 3.7"), ["3"], "3.7 does not back 3");
  eq(inventedIn("Shipped 202 releases", "Class of 2025"), ["202"], "2025 does not back 202");
  eq(inventedIn("Cut time by 40% and GPA 3.7 in 2025", "GPA 3.7, class of 2025, cut reporting time by 40%"), [], "whole tokens match");
  eq(inventedIn("Cut time by 40", "cut reporting time by 40%"), [], "a bare number is backed by the same number with a percent sign");
  eq(inventedIn("Cut time by 40%", "40 users"), ["40%"], "a percent is not backed by a bare count");
});
