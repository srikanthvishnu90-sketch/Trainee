// D-035 (owner, 2026-11-01: "Ship staged brain"): the staged brain is the committed production brain, part of the deployed
// SHA. Unit level, free (no model, no network):
//   R1-R3  the release config: staged in production, router on the rollback override, an override never turns a brain on;
//          the deploy standard reads PRODUCTION_BRAIN from the file as written.
//   R4     the release config (and the crisis guard) are reply code (scripts/launch/reply-code.ts), so a change to either
//          needs a fresh reply measurement before it can deploy.
//   R5-R7  S3 measures the brain each SHA serves: the candidate's staged rows against the deployed SHA's router rows
//          (33f7d00, run 41233949107: 21, 25, 23, 22, 24 of 38 = 60.5%), same set and size; mutations fail it.
//   R8-R11 the code-enforced rules hold with the release default (CAREER_BRAIN unset): crisis text, STOP and pause, a bare
//          approval, and the rollback. The handler-level proof is f13-staged-brain-handler.test.ts.
//   R12    the fact lock (D-007) reads a GPA written before "GPA" ("your 3.9 GPA"), the gap the D-035 review found.
//   deno test -A --no-check tests/architect/staged-release.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { parseProductionBrain, PRODUCTION_BRAIN, RELEASE_CONFIG_PATH, ROLLBACK_ENV, ROLLBACK_VALUE, servedBrain } from "../../supabase/functions/agent-chat/release_config.ts";
import { crisisReply } from "../../supabase/functions/agent-chat/crisis.ts";
import { brainMode, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { isReplyCode } from "../../scripts/launch/reply-code.ts";
import { bracketUntraced, factSources, untracedFacts } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { evaluate, missingMeasurement, s3, servedBrainAt, type Sources } from "../../scripts/launch/deploy-standard.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname;
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const RELEASE = env({}); // production as deployed: CAREER_BRAIN unset

Deno.test("R1 the committed release config serves staged in production; the rollback override serves the router", () => {
  eq(PRODUCTION_BRAIN, "staged", "D-035: the production brain is staged");
  eq([ROLLBACK_ENV, ROLLBACK_VALUE], ["CAREER_BRAIN", "router"]);
  eq(servedBrain(env({})), "staged", "unset: the release brain");
  eq(servedBrain(env({ CAREER_BRAIN: "" })), "staged", "empty: the release brain");
  eq(servedBrain(env({ CAREER_BRAIN: "staged" })), "staged");
  eq(servedBrain(env({ CAREER_BRAIN: "router" })), "router", "the emergency rollback");
  eq(servedBrain(env({ CAREER_BRAIN: " Router " })), "router");
  eq(brainMode(env({})), "staged", "career_staged reads the same rule");
  eq(brainMode(env({ CAREER_BRAIN: "router" })), "router");
});

Deno.test("R2 an override never turns on a brain the commit did not ship; a typo still rolls back", () => {
  eq(servedBrain(env({ CAREER_BRAIN: "agent" })), "router", "agent is pinned off");
  eq(servedBrain(env({ CAREER_BRAIN: "routr" })), "router", "a mistyped rollback still rolls back");
  eq(servedBrain(env({ CAREER_BRAIN: "staged" }), "router"), "router", "with a router release, CAREER_BRAIN=staged turns nothing on");
  eq(servedBrain(env({}), "router"), "router");
});

Deno.test("R3 the deploy standard reads PRODUCTION_BRAIN from the file as written; anything else is an error, not a guess", async () => {
  const text = await Deno.readTextFile(`${ROOT}${RELEASE_CONFIG_PATH}`);
  eq(parseProductionBrain(text), "staged");
  eq(parseProductionBrain(text.replace('PRODUCTION_BRAIN: ServedBrain = "staged"', 'PRODUCTION_BRAIN: ServedBrain = "router"')), "router");
  assertNode.throws(() => parseProductionBrain(text.replace('= "staged";', "= pick();")), /not one quoted/);
  assertNode.throws(() => parseProductionBrain(text.replace('= "staged";', '= "agent";')), /not one quoted/);
  assertNode.throws(() => parseProductionBrain(""), /not one quoted/);
});

Deno.test("R4 the release config and the crisis guard are reply code (one list: scripts/launch/reply-code.ts)", () => {
  ok(isReplyCode(RELEASE_CONFIG_PATH), RELEASE_CONFIG_PATH);
  ok(isReplyCode("supabase/functions/agent-chat/crisis.ts"));
  ok(isReplyCode("supabase/functions/agent-chat/career_staged.ts"));
});

// ------------------------------------------------------------------------------------------------ S3: the served brain
const C = "c".repeat(40), D = "d".repeat(40), A = "a".repeat(40);
const HEAD = "| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n";
const row = (commit: string, brain: string, passed: number, run: string, set = "dev", size = 38) =>
  `| 2026-11-01 10:00:00 | ${commit.slice(0, 7)} | ${set} | ${brain} | ${size} | ${passed} | x% | gpt-5-mini x, gpt-4.1-mini y; both-pass | no | ${run}; harness |\n`;
const DEPLOYED_ROUTER = [21, 25, 23, 22, 24].map((p) => row(D, "router", p, "41233949107")).join(""); // 115/190 = 60.5%
const STAGED_CONFIG = `export const PRODUCTION_BRAIN: ServedBrain = "staged";\n`;
interface W { log: string | null; files: Record<string, string> }
function src(w: W): Sources {
  const all = [A, C, D];
  return {
    checkRuns: async () => [], fileAt: async (sha, path) => w.files[`${sha}:${path}`] ?? null, lastDeployedSha: async () => D,
    firstParent: async () => [], pull: async () => null, reviews: async () => [], pullFiles: async () => null, ledger: async () => null,
    scoreLog: async () => w.log, resolve: async (rev) => all.find((x) => x.startsWith(rev)) ?? null,
    parent: async (sha) => (sha === C ? D : sha === D ? A : null), isAncestor: async (a, b) => a === b,
    changed: async () => true, tree: async (sha) => sha, firstAdded: async () => null, secretsAudit: async () => ({ code: 0, out: "" }),
  };
}
const world = (candidate: number[], o: { brain?: string } = {}): W => ({
  log: HEAD + DEPLOYED_ROUTER + candidate.map((p) => row(C, o.brain ?? "staged", p, "41300000000")).join(""),
  files: { [`${C}:${RELEASE_CONFIG_PATH}`]: STAGED_CONFIG }, // the deployed SHA predates the file: it served the router
});

Deno.test("R5 S3 compares the candidate's served brain (staged) with the deployed SHA's (router, 60.5%), five passes each", async () => {
  const w = world([33, 34, 33, 32, 35]);
  eq([await servedBrainAt(src(w), C), await servedBrainAt(src(w), D)], ["staged", "router"]);
  const r = await s3(src(w), C, D);
  ok(r.pass, r.summary + "\n" + r.evidence.join("\n"));
  eq(r.summary, "staged pass rate 87.9% >= deployed router 60.5%");
  ok(r.evidence.some((e) => /served brains .*candidate cccccccccc staged, deployed dddddddddd router/.test(e)), r.evidence.join("\n"));
  ok(r.evidence.some((e) => /deployed  dddddddddd: 60\.5% \(router, dev\/38, mean of 5 passes of CI run 41233949107/.test(e)), r.evidence.join("\n"));
  ok(r.evidence.some((e) => /candidate cccccccccc: 87\.9% \(staged, dev\/38, mean of 5 passes/.test(e)), r.evidence.join("\n"));
});

Deno.test("R6 S3 mutations: the candidate's staged rows must exist and must not be below the deployed router's", async () => {
  // Only router rows for a candidate that serves staged: the router's score does not stand for the staged brain.
  let r = await s3(src(world([30, 30, 30, 30, 30], { brain: "router" })), C, D);
  ok(!r.pass && /candidate: no staged measurement/.test(r.summary), r.summary);
  // Staged below the deployed router (22.8 < 23 a pass): FAIL, no tolerance.
  r = await s3(src(world([23, 23, 23, 22, 23])), C, D);
  ok(!r.pass && r.summary === "staged pass rate 60.0% < deployed router 60.5%", r.summary);
  // Equal means pass (the bar is "beats what's live or equals it", exactly).
  ok((await s3(src(world([23, 23, 23, 23, 23])), C, D)).pass);
  // The deployed SHA measured only with the staged brain: not the brain it served.
  const w = world([33, 34, 33, 32, 35]); w.log = HEAD + [23, 23, 23, 23, 23].map((p) => row(D, "staged", p, "1")).join("") + [33, 34, 33, 32, 35].map((p) => row(C, "staged", p, "2")).join("");
  r = await s3(src(w), C, D);
  ok(!r.pass && /deployed: no router measurement/.test(r.summary), r.summary);
  // A release config that cannot be read fails S3 (evaluate turns the error into a FAIL with its reason).
  const bad = world([33, 34, 33, 32, 35]); bad.files[`${C}:${RELEASE_CONFIG_PATH}`] = "export const PRODUCTION_BRAIN = pick();\n";
  const ev = await evaluate(src(bad), C, ["S3"]);
  ok(!ev.results[0].pass && /could not be evaluated: release_config\.ts: PRODUCTION_BRAIN is not one quoted/.test(ev.results[0].summary), ev.results[0].summary);
});

Deno.test("R7 --missing-measurement names the brain to measure each SHA with: staged for the candidate, router for the deployed", async () => {
  let w = world([]); w.log = HEAD + DEPLOYED_ROUTER;
  eq(await missingMeasurement(src(w), C, D).then((m) => [m.sha, m.brain]), [C, "staged"]);
  w = world([33, 34, 33, 32, 35]); w.log = HEAD + [33, 34, 33, 32, 35].map((p) => row(C, "staged", p, "2")).join("");
  eq(await missingMeasurement(src(w), C, D).then((m) => [m.sha, m.brain]), [D, "router"]);
  const both = await missingMeasurement(src(world([33, 34, 33, 32, 35])), C, D);
  eq([both.sha, both.brain], [null, null], both.why);
  ok(/served brains: candidate staged, deployed router/.test(both.why), both.why);
});

// ------------------------------------------------------------------------------------------------ code-enforced rules
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-d035", threadId: "t-d035", now: Date.UTC(2026, 10, 1, 15), snapshot: null, accountPersistence: true });
const decide = (message: string, e = RELEASE, ctx = fresh()) => stagedDecision({ env: e, message, ctx, host, structured: false });

// Crisis phrasings the router did not answer with its safety reply before D-035 (they went "unclaimed" or to another module).
export const CRISIS: string[] = [
  "I'm thinking about suicide",
  "i want to end it all",
  "I don't want to live anymore, this job search is hopeless",
  "I don’t want to live anymore",
  "I feel suicidal",
  "I want to kill myself",
  "how do I deal with self-harm thoughts during a job search?",
];

Deno.test("R8 crisis text is code's: never the brain's, and code's own crisis reply carries 988", () => {
  for (const m of CRISIS) {
    const d = decide(m);
    eq([d.brain, d.reason], [false, "crisis"], m);
    ok(/\b988\b/.test(crisisReply(m) ?? ""), `${m}: the crisis reply names 988`);
  }
  // Hard days that are not a crisis stay advice (the brain may answer them); code's screens decide, not a new list.
  for (const m of ["I feel worthless, nobody will hire me", "this job search is killing me", "I'm so overwhelmed with all of this"]) eq(crisisReply(m), null, m);
  // Under the rollback nothing here runs: the router's turn is exactly as before.
  eq(decide("I'm thinking about suicide", env({ CAREER_BRAIN: "router" })).reason, "not_staged");
});

Deno.test("R9 STOP, pause and erase are the host's controls; a paused account sends nothing to the brain", () => {
  for (const m of ["STOP", "stop everything", "UNSUBSCRIBE", "pause all career work", "resume career work", "delete my career profile"]) eq(decide(m).reason, "host_control", m);
  const paused = fresh();
  paused.globalPause = { set: true, source: "account_control" };
  for (const m of ["how should I follow up after an interview?", "I'm so overwhelmed with all of this"]) eq(decide(m, RELEASE, paused).reason, "host_control", `paused: ${m}`);
});

Deno.test("R10 a bare approval and every action stay code's under the release default", () => {
  eq([decide("yes").brain, decide("yes").reason], [false, "action"], "a bare yes is answered by code (what it approves is code's)");
  for (const m of ["apply to the Backend Software Engineer role at Ironstack Payments", "send it", "pause everything", "write my cover letter for the Stripe role", "what's my GPA?"]) {
    eq(decide(m).brain, false, m);
  }
  eq(decide("how should I follow up after an interview?").brain, true, "advice is the brain's");
});

Deno.test("R11 the rollback (CAREER_BRAIN=router): no turn goes to the brain and the router is not probed", () => {
  let probed = 0;
  const spy = { isHostControlled: host.isHostControlled, runTurn: (t: string, c: any) => { probed++; return host.runTurn(t, c); } };
  for (const m of ["how should I follow up after an interview?", "I'm so overwhelmed with all of this", ...CRISIS]) {
    eq(stagedDecision({ env: env({ CAREER_BRAIN: "router" }), message: m, ctx: fresh(), host: spy, structured: false }).brain, false, m);
  }
  eq(probed, 0);
});

Deno.test("R12 fact lock (D-007): a GPA the person never gave is not delivered, written before or after \"GPA\"; their own stays", () => {
  const none = factSources({ state: { profile: { facts: [] } }, message: "how should I talk about my education in an interview?", history: [], results: [] });
  for (const [t, fixed] of [
    ["With your 3.9 GPA from Stanford University you are a strong fit.", "With your [number] GPA from [employer or school] you are a strong fit."],
    ["You have a 3.9 GPA.", "You have a [number] GPA."],
    ["You have a 3.7/4.0 cumulative GPA.", "You have a [number]/4.0 cumulative GPA."],
    ["Your 3.85 GPA stands out.", "Your [number] GPA stands out."],
    ["Your GPA is 3.9.", "Your GPA is [number]."],
  ]) {
    ok(untracedFacts(t, none, none).some((f) => f.kind === "number"), t);
    eq(bracketUntraced(t, none, none), fixed, t);
  }
  // Their own GPA traces (no stray "9" from "3.9"), and a general bar about employers is not a claim about them.
  const own = factSources({ state: { profile: { facts: [] } }, message: "my GPA is 3.9, how do I mention it?", history: [], results: [] });
  for (const t of ["With your 3.9 GPA you are a strong fit.", "You have a 3.9 GPA.", "Your 3.9 GPA is strong."]) eq(untracedFacts(t, own, own), [], t);
  for (const t of ["Most banks screen for a 3.5 GPA.", "Many firms want a 3.5 GPA or higher, so lead with your projects."]) eq(untracedFacts(t, none, none), [], t);
});

Deno.test("R13 deploy-production.yml measures each missing SHA with the brain --missing-measurement names for it", async () => {
  const wf = await Deno.readTextFile(`${ROOT}.github/workflows/deploy-production.yml`);
  ok(/sed -n 's\/\^brain=\/\/p'/.test(wf), "the measure loop reads brain=");
  ok(/MEASURE_BRAINS="\$brain" bash scripts\/launch\/measure-reply\.sh "\$need"/.test(wf), "measure-reply.sh gets that brain");
  ok(/case "\$brain" in router\|staged\) ;; \*\)/.test(wf), "an unknown brain stops the loop");
  const mr = await Deno.readTextFile(`${ROOT}scripts/launch/measure-reply.sh`);
  ok(/BRAINS="\$\{MEASURE_BRAINS:-router\}"/.test(mr) && !/DEPLOY_STANDARD_BRAIN/.test(mr), "measure-reply.sh measures MEASURE_BRAINS");
});
