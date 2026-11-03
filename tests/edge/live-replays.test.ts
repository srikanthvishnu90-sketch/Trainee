// Every live gauntlet failure, replayed on every run (v3 standing instruction, 2026-10-11). Fixtures are written by
// evals/gauntlet/record-replays.cjs after each live run (evals/gauntlet/replays/live-failures.json). What each kind proves:
//   provider_outage  the reply was silence (a 502); now a dead provider gives the outage sentence, in chat and planner
//   planner_wording  a money question answered with payment-planner words while the model was down; now the outage sentence
//   flow             the same thread replayed through the real router with the live test user's data (Sam saved, no
//                    transactions, no brokerage) and the router model down, as it was live; the corpus checks must pass
//   career_tailor    a career tailor turn replayed through the staged career bundle in a child Deno process with the
//                    Buffer global removed (the edge-runtime realm): intent career_tailor, uncontained, artifact.pdf real
//   other            needs a person: triage verdict fixed (with a test_ref that exists), precondition, not_built or grader
// A flow or other fixture that still fails and is not triaged FAILS here: a live failure stays red until it is fixed
// or a person writes down why it is not the code's. Simulation only: this never claims a live pass.
import { routeFlows, mapFlowData, userBroker, type FlowDb } from "../../supabase/functions/_shared/flow_router.ts";
import { chatReply, plannerModel, OUTAGE_REPLY } from "../../supabase/functions/_shared/model_gateway.ts";
import { runFinancialPlanner } from "../../supabase/functions/_shared/financial_planner.ts";
import { fixture, user } from "./lib/financial_fixture.ts";
// Static imports only, so this runs with no permissions (the evidence recorder runs deno test without -A).
import checks from "../../evals/gauntlet/checks.cjs";
import DB from "../../evals/gauntlet/replays/live-failures.json" with { type: "json" };
const { check } = checks as any;
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const T0 = Date.UTC(2026, 9, 11, 19, 1, 0);
const DEAD_KEY = "sk-proj-TESTKEY-should-never-appear-anywhere-0000";
const dead = { provider: "anthropic" as const, model: "claude-haiku-5-5", apiKey: DEAD_KEY, reasoningEffort: "low" };
const refuse = (async () => Response.json({ error: { message: "This API key is not scoped to a workspace", type: "invalid_request_error" } }, { status: 400 })) as any;
const admin = () => ({ async rpc() { return { data: { ok: true, call_id: "slot" }, error: null }; } });
const TRIAGED = new Set(["precondition", "not_built", "grader"]);

// The live gauntlet user's world (scripts/launch/seed-gauntlet-test-user.sql): Sam saved on Venmo and Zelle, nothing else.
function liveWorld(): FlowDb {
  let state: any = null;
  const recipients = [
    { id: "r-venmo", handle: "@sam-upmore-test", display_name: "Sam", channel: "in-app", source: "confirmed", rail: "venmo", last_used_at: new Date(T0).toISOString() },
    { id: "r-zelle", handle: "sam.test@upmore.test", display_name: "Sam", channel: "in-app", source: "confirmed", rail: "zelle", last_used_at: new Date(T0 - 60000).toISOString() },
  ];
  return {
    async loadState() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    async saveState(s: any) { state = JSON.parse(JSON.stringify(s)); },
    async loadData() { return { ok: true, ...mapFlowData([], [], [], recipients) }; },
    async saveRecipients() {},
  } as FlowDb;
}
const routerDown = async () => { throw new Error("router model HTTP 400 invalid_request_error"); };
const noBroker = () => userBroker({ get: () => undefined }, user, { rows: async () => [], token: async () => null, markReconnect: async () => {} } as any);

async function replayFlow(f: any) {
  const db = liveWorld(); let r: any = null;
  for (const text of f.context.concat([f.text])) {
    r = await routeFlows(text, { db, extract: routerDown, now: () => T0, brokerFactory: noBroker } as any);
  }
  return r && !r.fallthrough ? { reply: r.reply, route: r.route } : { reply: null, route: null, fallthrough: true };
}

assert(Array.isArray((DB as any).fixtures), "the replay file holds fixtures");
for (const f of (DB as any).fixtures as any[]) {
  Deno.test(`live ${f.last_label} ${f.suite} ${f.id} [${f.kind}] ${JSON.stringify(f.text)}`, async () => {
    // A fixed verdict's test_ref must exist: checked in tests/gauntlet-replays.test.cjs (it needs the file system).
    if (f.triage && f.triage.verdict === "fixed") assert(f.triage.test_ref, `${f.id}: a fixed verdict names its test`);
    if (f.kind === "provider_outage") {
      const c = await chatReply(dead, { messages: [{ role: "user", content: f.text }] }, { request: refuse });
      assert(!c.ok && (c as any).reply === OUTAGE_REPLY, `${f.id}: a dead provider is the outage sentence, never silence`);
      return;
    }
    if (f.kind === "planner_wording") {
      const r = await runFinancialPlanner(fixture().session, plannerModel(admin(), user, "thread", dead, { request: refuse }), f.text);
      assert(r.reply === OUTAGE_REPLY && !/financial plan|payment was approved/i.test(r.reply), `${f.id}: ${r.reply}`);
      return;
    }
    if (f.kind === "career_tailor") {
      // MUSE-F-011 (live on v246, 2026-10-21): a tailor turn whose render
      // threw "ReferenceError: Buffer is not defined" — module 148 read the
      // bare Node Buffer global, which the Deno edge runtime (2.1.4) does
      // not have; module 143's containment served "Something went wrong on
      // my end". The turn replays through the STAGED career bundle in a
      // child Deno process whose realm has the Buffer global REMOVED
      // before import (tests/edge/lib/career-replay-child.ts) — the local
      // Deno's own Buffer global would mask the defect in-process. The
      // replay passes only when the turn lands on career_tailor,
      // uncontained, with a real PDF artifact.
      const child = new URL("./lib/career-replay-child.ts", import.meta.url).pathname;
      const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", child, f.id], stdout: "piped", stderr: "piped" }).output();
      const stdout = new TextDecoder().decode(out.stdout).trim();
      const stderr = new TextDecoder().decode(out.stderr).trim();
      const line = stdout.split("\n").filter(Boolean).pop() || "";
      let v: any = null;
      try { v = JSON.parse(line); } catch { /* asserted below */ }
      assert(v, `${f.id}: the replay child produced no verdict (exit ${out.code}): ${stderr.slice(0, 400)}`);
      assert(!v.stage, `${f.id}: the replay failed at stage ${v.stage}: ${v.error}`);
      assert(v.contained === false, `${f.id}: the turn was contained — the live MUSE-F-011 failure (reply: ${JSON.stringify(v.reply).slice(0, 160)})`);
      assert(v.intent === "career_tailor", `${f.id}: intent is ${JSON.stringify(v.intent)}, expected career_tailor (reply: ${JSON.stringify(v.reply).slice(0, 160)})`);
      assert(v.artifactPdf === true, `${f.id}: artifact.pdf is null in the Buffer-free realm — MUSE-F-011 (the render threw before any bytes existed)`);
      return;
    }
    const triaged = f.triage && TRIAGED.has(f.triage.verdict) && String(f.triage.note || "").length >= 20 && !f.triage.stale;
    if (f.kind === "flow") {
      const res = await replayFlow(f);
      const reasons = check(f.checks || {}, res);
      if (!reasons.length) return;
      assert(triaged, `${f.id} still fails when replayed: ${reasons.join("; ")} | reply: ${res.reply}${f.triage && f.triage.stale ? ` | triage is stale: ${f.triage.stale}` : ""}`);
      console.log(`  known (${f.triage.verdict}): ${f.triage.note}`);
      return;
    }
    assert(triaged || (f.triage && f.triage.verdict === "fixed"), `${f.id} [other] needs a person: fix it (verdict fixed + test_ref) or triage it (precondition, not_built, grader)`);
  });
}
