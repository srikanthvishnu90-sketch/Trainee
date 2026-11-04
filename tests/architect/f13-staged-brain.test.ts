// FEATURE 13 (owner, 2026-10-25): the staged release of the brain, unit level. Which turns the staged mode gives the
// brain (questions, advice, conversation the router would only answer in words) and which stay code's (every action),
// the owner's kill switch and per-class hold, the probe's isolation from the real turn, the tool policy at the boundary,
// and the go-live switch. Free: no model, no network. The handler-level proof is f13-staged-brain-handler.test.ts.
//   deno test -A --no-check tests/architect/f13-staged-brain.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { brainMode, codeProduct, probeCtx, STAGED_TOOL_POLICY, STAGED_WITHHELD_TOOLS, stagedDecision, stagedRoute, UNCLAIMED } from "../../supabase/functions/agent-chat/career_staged.ts";
import { AGENT_BRAIN_RELEASED, withheld } from "../../supabase/functions/agent-chat/career_brain.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-f13", threadId: "t-f13", now: Date.UTC(2026, 9, 25, 15), snapshot: null, accountPersistence: true });
const STAGED = env({ CAREER_BRAIN: "staged" });
const decide = (message: string, e = STAGED, structured = false) => stagedDecision({ env: e, message, ctx: fresh(), host, structured });

// Questions, advice and conversation: each a phrasing a person types, with the router class that sends it to the brain.
export const TO_BRAIN: [string, string][] = [
  ["how should I follow up after an interview?", "career_catchall"],
  ["how do I explain a layoff in an interview?", "career_catchall"],
  ["I'm so overwhelmed with all of this", UNCLAIMED],
  ["what's a good way to answer tell me about yourself", UNCLAIMED],
  ["should I take a gap year before grad school?", "company_intel"],
  ["is it worth getting a PMP certification?", "company_intel"],
  ["how do I negotiate a raise?", "negotiation_advice"],
  ["hello", "career_greeting"],
  ["what's the weather like in Chicago today?", "career_out_of_scope"],
];
// Actions: each stays code's (the router here; the handler's code-first turns run before this is ever asked).
export const TO_CODE: string[] = [
  "find me data analyst jobs in Chicago",
  "watch data analyst roles in Chicago for me and alert me when new ones post",
  "apply to the Backend Software Engineer role at Ironstack Payments",
  "mock me for a data analyst interview at Northwind Ledger",
  "I applied to the Operations Analyst role at Cascade Retail Group today",
  "introduce me to an alum working at Bluepeak Networks",
  "show me job links",
  "show my applications",
  "STOP",
  "delete my career profile",
];

// D-035 (owner, 2026-11-01: "Ship staged brain"): the committed release config serves staged; CAREER_BRAIN only rolls back.
Deno.test("F13-1 the mode: the release config's staged when CAREER_BRAIN is unset or staged; router (or any other value) rolls back; agent stays pinned", () => {
  eq(brainMode(env({})), "staged", "unset serves the committed release brain");
  eq(brainMode(env({ CAREER_BRAIN: "router" })), "router", "the kill switch");
  eq(brainMode(env({ CAREER_BRAIN: "staged" })), "staged");
  eq(brainMode(env({ CAREER_BRAIN: " Staged " })), "staged");
  eq(brainMode(env({ CAREER_BRAIN: "agent" })), "router", "agent is never served: pinned off, so the router");
  eq(brainMode(env({ CAREER_BRAIN: "on" })), "router", "anything else is the router");
  eq(AGENT_BRAIN_RELEASED, false, "the full brain stays pinned off; staged is its own reviewed path");
});

Deno.test("F13-2 the rollback (router) or agent: no turn goes to the brain, and the router is not even probed", () => {
  let probed = 0;
  const spy = { ...host, runTurn: (t: string, c: any) => { probed++; return host.runTurn(t, c); }, isHostControlled: host.isHostControlled };
  for (const e of [env({ CAREER_BRAIN: "router" }), env({ CAREER_BRAIN: "agent" }), env({ CAREER_BRAIN: "off" })]) {
    for (const [m] of TO_BRAIN) eq(stagedDecision({ env: e, message: m, ctx: fresh(), host: spy, structured: false }).brain, false, m);
  }
  eq(probed, 0, "no probe outside staged mode");
});

Deno.test("F13-3 staged: question, advice and conversation turns go to the brain, with the router class that decided", () => {
  for (const [m, intent] of TO_BRAIN) {
    const d = decide(m);
    eq([d.brain, d.intent, d.reason], [true, intent, "question"], m);
  }
});

Deno.test("F13-4 staged: every action stays code's; host controls and structured requests are never probed", () => {
  for (const m of TO_CODE) {
    const d = decide(m);
    eq(d.brain, false, `${m}: ${d.reason} ${d.intent}`);
  }
  eq(decide("STOP").reason, "host_control");
  eq(decide("how should I follow up after an interview?", STAGED, true).reason, "structured_request");
  // A sourced record behind the answer keeps it the router's (a company file, a benchmark with figures, an offer).
  assert(codeProduct("company_intel", { company: "Goldman Sachs", payload: { kind: "company_file" } }));
  assert(codeProduct("company_intel", { payload: { kind: "role_kb_stats" } }));
  assert(!codeProduct("company_intel", { payload: { kind: "role_kb_absent" } }));
  assert(codeProduct("negotiation_advice", { bench: { figures: [{ p50: 1 }] } }));
  assert(codeProduct("negotiation_advice", { offer: { amount: 1 } }));
  assert(!codeProduct("negotiation_advice", { bench: { figures: [] } }));
  assert(codeProduct("career_guidance", { payload: { kind: "x" } }));
});

Deno.test("F13-5 the owner keeps a class on the router with CAREER_BRAIN_ROUTER_INTENTS", () => {
  const keep = env({ CAREER_BRAIN: "staged", CAREER_BRAIN_ROUTER_INTENTS: "career_catchall, unclaimed" });
  eq([decide("how should I follow up after an interview?", keep).brain, decide("how should I follow up after an interview?", keep).reason], [false, "kept_on_router"]);
  eq(decide("I'm so overwhelmed with all of this", keep).brain, false);
  eq(decide("how do I negotiate a raise?", keep).brain, true, "a class not named still goes");
});

Deno.test("F13-6 the probe never touches the real turn: state written by the router during the probe stays in the copy", () => {
  const ctx = fresh();
  const before = JSON.stringify(host.STATE_KEYS.map((k: string) => ctx[k] ?? null));
  const d = stagedDecision({ env: STAGED, message: "watch data analyst roles in Chicago for me and alert me when new ones post", ctx, host, structured: false });
  eq(d.brain, false);
  eq(JSON.stringify(host.STATE_KEYS.map((k: string) => ctx[k] ?? null)), before, "the real ctx is unchanged");
  eq(ctx.alertWatchState, undefined, "no watch was created on the real turn");
  eq(ctx.containmentRecords.length, 0, "the probe's containment records are its own");
  // The real run afterwards creates it, as today.
  eq(host.runTurn("watch data analyst roles in Chicago for me and alert me when new ones post", ctx).intent, "career_watch_create");
  // A copy: functions are carried one level, plain values are deep copies.
  const seam = { boardFor: () => null, delegateBatch: true };
  const c = probeCtx({ batchDeps: seam, profile: { facts: [{ kind: "skill", value: "SQL" }] } } as Record<string, any>);
  assert(c.batchDeps !== seam && c.batchDeps.boardFor === seam.boardFor);
  c.profile.facts.push({ kind: "skill", value: "x" });
});

Deno.test("F13-7 a module that claimed the turn and crashed keeps the router's contained reply; an unclaimed turn is the brain's", () => {
  const crash = { isHostControlled: () => false, runTurn: (_t: string, c: any) => { c.containmentRecords.push({ boundary: "throw" }); return { intent: null, handler: "CareerRouter", contained: true }; } };
  eq(stagedDecision({ env: STAGED, message: "x", ctx: fresh(), host: crash, structured: false }).reason, "router_contained");
  const none = { isHostControlled: () => false, runTurn: (_t: string, c: any) => { c.containmentRecords.push({ boundary: "null_result" }); return { intent: null, handler: null, contained: true }; } };
  eq(stagedDecision({ env: STAGED, message: "x", ctx: fresh(), host: none, structured: false }).intent, UNCLAIMED);
  const thrown = { isHostControlled: () => false, runTurn: () => { throw new Error("boom"); } };
  eq(stagedDecision({ env: STAGED, message: "x", ctx: fresh(), host: thrown, structured: false }).reason, "probe_failed");
});

Deno.test("F13-8 lazy and once: the route probes only when asked, at most once a turn", () => {
  let probed = 0;
  const spy = { isHostControlled: host.isHostControlled, runTurn: (t: string, c: any) => { probed++; return host.runTurn(t, c); } };
  const r = stagedRoute({ env: STAGED, message: "how do I negotiate a raise?", ctx: fresh(), host: spy, structured: false });
  eq([probed, r.chosen, r.decision], [0, false, null], "nothing runs until the brain test is reached");
  eq([r.toBrain(), r.toBrain(), probed, r.chosen, r.decision?.intent], [true, true, 1, true, "negotiation_advice"]);
});

Deno.test("F13-9 tool policy at the boundary: no external tool exists, and the actions with a code-first owner are withheld", () => {
  const all = careerTools({ postings: async () => [] });
  eq(all.filter((t) => t.effect === "external").map((t) => t.name), [], "no tool sends or submits");
  for (const n of STAGED_WITHHELD_TOOLS) assert(all.some((t) => t.name === n), `${n} is a real tool name`);
  const kept = withheld(STAGED_TOOL_POLICY.withhold, all);
  eq(kept.length, all.length - STAGED_WITHHELD_TOOLS.length);
  for (const n of ["queue_applications", "set_job_alerts", "stop_job_alerts", "verify_contacts"]) assert(!kept.some((t) => t.name === n), n);
  for (const n of ["search_jobs", "get_situation", "where_do_i_stand", "career_path_answer"]) assert(kept.some((t) => t.name === n), n);
  eq(withheld(undefined, all).length, all.length, "the full brain's tools are unchanged");
});

Deno.test("F13-10 go-live: --brain staged sets CAREER_BRAIN=staged; --brain router (the kill switch) sets CAREER_BRAIN=router (D-035)", async () => {
  const root = new URL("../..", import.meta.url).pathname;
  const run = async (args: string[]) => {
    const o = await new Deno.Command("bash", { args: ["scripts/launch/trainee-go-live.sh", "--dry-run", ...args], cwd: root, clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", HOME: Deno.makeTempDirSync(), SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst", SUPABASE_DB_URL: "postgresql://postgres:fake-f13-pass@db.example.test:5432/postgres" }, stdout: "piped", stderr: "piped" }).output();
    return { code: o.code, out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) };
  };
  const staged = await run(["--brain", "staged"]);
  eq(staged.code, 0, staged.out);
  assert(/--env-file <0600 temp file: .*CAREER_BRAIN=staged>/.test(staged.out), staged.out);
  assert(/CAREER_BRAIN=staged: the brain answers question and advice turns/.test(staged.out), staged.out);
  const router = await run(["--brain=router"]);
  assert(!/CAREER_BRAIN=staged/.test(router.out) && /--env-file <0600 temp file: .*CAREER_BRAIN=router>/.test(router.out) && !/secrets unset CAREER_BRAIN/.test(router.out), router.out);
  const plain = await run([]);
  assert(!/CAREER_BRAIN=staged/.test(plain.out) && /CAREER_BRAIN not touched/.test(plain.out), plain.out);
});
