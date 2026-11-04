// BATCH DELEGATION (LOOP J10 — the deployed-runtime transport, tier 2)
// — the done-test from the design of record (joins doc "J10 — DESIGN"):
// the staged REAL handler (index-career.ts -> handler-career.ts ->
// the career bundle, ESM realm, only the two remote services replaced)
// runs the exact owner message through the chosen composition:
//   ask turn    -> delegate mode: the seam creates the run skeleton,
//                  a career_batch_intent/v1 prepare intent commits
//                  transactionally with the reply (nothing prepared,
//                  nothing submitted, the reply says queued);
//   executor    -> the worker-side batch executor claims the intent
//                  and runs module 155 in ITS process, boards vended
//                  by the board service running as a SEPARATE PROCESS
//                  over its real synchronous HTTP transport — the
//                  prepared run lands in the batch run record;
//   status turn -> the worker-written card reads back in-thread;
//   yes turn    -> structured approve + the exact message commits an
//                  approve intent carrying the card set hash;
//   executor    -> claims it, re-verifies the set hash against the
//                  stored run, approves (Leg-1 approvalRef minted),
//                  executes — 13 submitted with SBX confirmations;
//   status turn -> the final record speaks the submitted end states.
// Plus the degradation cases: no worker configured (no delegation —
// the honest in-turn outcome, no intent committed) and worker
// configured but board service down (every selected application
// stops named BOARD_NOT_WIRED, nothing submitted).
// Check: node --test tests/career-batch-delegation.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");

const root = path.resolve(__dirname, "..");
const Bridge = require(path.join(root, "supabase/functions/_shared/career_task_bridge.js"));
const { createBatchExecutor, createBatchRpcStore } = require(path.join(root, "workers/career-browser/batch-executor.cjs"));
const { createSyncHttpTransport } = require(path.join(root, "workers/career-browser/board-transport.cjs"));
const persistenceFake = require(path.join(root, "tests/helpers/career-persistence-fake.cjs"));

const USER = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000099";
const THREAD = "00000000-0000-4000-8000-000000000002";
const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
const SECRET = "delegation-test-board-secret";
const WORKER_URL = "http://127.0.0.1:8124";

// The snapshot profile the handler loads (122-shaped master, the
// reachability suite's synthetic record).
const SNAPSHOT_PROFILE = {
  basics: { name: "Bundle Test", location: "Chicago, IL" },
  facts: [
    { kind: "education", text: "B.S. Computer Science at TEST University, graduating May 2028", org: "TEST University", title: "B.S. Computer Science", end: "2028-05" },
    { kind: "skill", name: "Python", text: "Skill: Python", fact_id: "TEST-F1", evidence: ["synthetic resume lists Python"], unproven: false },
  ],
  constraints: { workAuthorization: "US citizen", needsSponsorship: false },
  preferences: { locations: ["Chicago"], starredCompanies: [] },
};
// The executor's per-user sources (the production seams): the 149
// profile + 122 master + attestations, same fixtures as the loop suite.
const PORTAL_PROFILE = {
  name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: {
    work_authorization: { value: "Yes — authorized to work in the US", confirmed: true },
    sponsorship: { value: "No", confirmed: true },
    cover_note: { value: "I am excited to apply for the intern role.", confirmed: true, draft: true },
  },
};
const MASTER = {
  basics: { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test" },
  facts: [
    { id: "F-T-001", kind: "skill", text: "JavaScript and Node.js development", confirmed: true },
    { id: "F-T-002", kind: "experience", text: "Built web applications as a student developer", confirmed: true },
    { id: "F-T-003", kind: "education", text: "Computer Science student", confirmed: true },
  ],
};
const ATTEST = { certify_true: { value: true, explicit: true } };

// The loop suite's fixture market (same generator, same variants:
// duplicate, knockout, closed, count overflow; testco7/testco11 carry
// their board variants worker-side via the sandbox helper's factory).
const FAMS = [
  { atsFamily: "greenhouse", urlFor: (co, n) => `https://boards.greenhouse.io/${co}/jobs/${n}` },
  { atsFamily: "lever", urlFor: (co, n) => `https://jobs.lever.co/${co}/${n}` },
  { atsFamily: "ashby", urlFor: (co, n) => `https://jobs.ashbyhq.com/${co}/${n}` },
];
function posting(n, over = {}) {
  const fam = FAMS[n % 3];
  const co = `testco${n}`;
  return Object.assign({
    id: `JOB-T-${String(n).padStart(2, "0")}`, job_id: `JOB-T-${String(n).padStart(2, "0")}`,
    canonicalKey: `${fam.atsFamily}:${co}:software-engineering-intern`,
    company: `TestCo ${n}`, role: "Software Engineering Intern", title: "Software Engineering Intern",
    url: fam.urlFor(co, n), status: "open", atsFamily: fam.atsFamily, location: "Chicago, IL",
    posted_at: "2026-10-10", jd_text: "Software engineering intern role at a test company. JavaScript, testing, code review, agile team.",
  }, over);
}
const MARKET = [
  posting(1), posting(2), posting(3), posting(4), posting(5), posting(6), posting(7), posting(8),
  posting(9), posting(10), posting(11), posting(12), posting(13), posting(14), posting(15),
  posting(16, { id: "JOB-T-16", job_id: "JOB-T-16", canonicalKey: "lever:testco3:software-engineering-intern", company: "TestCo 3", url: "https://jobs.lever.co/testco3/16", atsFamily: "lever" }),
  posting(17, { knockouts: [{ type: "license", requirement: "an active CPA license", tokens: ["cpa"] }] }),
  posting(18, { status: "closed" }),
  posting(19), posting(20),
];
const clone = (v) => JSON.parse(JSON.stringify(v));

// The staged-entry cases need VM modules (the reachability suite's
// pattern): under a plain `node --test` invocation this file respawns
// itself once with the flag and asserts the inner run, so the sweep
// grades the same proof either way.
if (!vm.SourceTextModule) {
  test("batch delegation staged-entry suites (respawned with VM modules)", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // the nested runner must report its own exit status
    const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", __filename], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
} else {
// ---------------- the staged real handler (reachability pattern) ----
async function stagedApp(db, user, workerEnv, executorEnv = workerEnv) {
  if (!vm.SourceTextModule) throw new Error("run with --experimental-vm-modules");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "career-batch-delegation-"));
  execFileSync(process.execPath, [path.join(root, "scripts/career/stage-career.cjs"), stage, "--json"]);
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } } }) },
    rpc: (name, args) => persistenceFake(db, user, THREAD, name, args),
    from(table) {
      assert.ok(["profiles", "agent_threads", "agent_flow_state", "agent_messages", "career_watch_kv"].includes(table), `unexpected table: ${table}`);
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          assert.equal(filters.user_id, user);
          if (table === "career_watch_kv") { assert.match(filters.key, /^career:(mock:|questions-shown$)/); return { data: null, error: null }; } // the per-turn reads: no mock running, no questions showing
          if (table === "agent_threads") { assert.equal(filters.id, THREAD); return { data: { id: THREAD, user_id: user }, error: null }; }
          assert.equal(table, "agent_flow_state");
          assert.equal(filters.thread_id, THREAD);
          return { data: { state: clone(db.state) }, error: null };
        },
        async upsert(row) {
          db.writes.push(table);
          if (table === "agent_flow_state") { assert.equal(row.user_id, user); assert.equal(row.thread_id, THREAD); db.state = clone(row.state); }
          else assert.equal(table, "profiles");
          return { error: null };
        },
        async insert(row) { assert.equal(table, "agent_messages"); assert.equal(row.thread_id, THREAD); db.messages.push(clone(row)); return { error: null }; },
      };
      return query;
    },
  };
  let handle;
  let networkCalls = 0;
  const context = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, AbortController, crypto: require("node:crypto").webcrypto,
    setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} },
    fetch() { networkCalls++; throw new Error("external network forbidden in staged handler"); },
    Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://supabase.example.test", SUPABASE_ANON_KEY: "mock-anon", SUPABASE_SERVICE_ROLE_KEY: "mock-service", UPMORE_CAREER_WORKER_URL: workerEnv ? WORKER_URL : undefined, UPMORE_CAREER_WORKER_SECRET: workerEnv ? SECRET : undefined, CAREER_BATCH_EXECUTOR: executorEnv ? "on" : undefined })[name] } },
  });
  const modules = new Map();
  function load(id) {
    if (modules.has(id)) return modules.get(id);
    let mod;
    if (id === "https://deno.land/std@0.208.0/http/server.ts") {
      mod = new vm.SyntheticModule(["serve"], function () { this.setExport("serve", (fn) => { handle = fn; }); }, { context, identifier: id });
    } else if (id === "https://esm.sh/@supabase/supabase-js@2.117.1") {
      mod = new vm.SyntheticModule(["createClient"], function () { this.setExport("createClient", () => client); }, { context, identifier: id });
    } else {
      assert.ok(id.startsWith(stage + path.sep), `import escaped staged tree: ${id}`);
      let code = fs.readFileSync(id, "utf8");
      if (id.endsWith(".ts")) code = stripTypeScriptTypes(code, { mode: "transform" });
      mod = new vm.SourceTextModule(code, { context, identifier: id });
    }
    modules.set(id, mod);
    return mod;
  }
  const entry = load(path.join(stage, "agent-chat/index.ts"));
  await entry.link((specifier, referencing) => load(specifier.startsWith("https:") ? specifier : path.resolve(path.dirname(referencing.identifier), specifier)));
  await entry.evaluate();
  assert.equal(typeof handle, "function", "the staged entry registered the real handler");
  return {
    async chat(message, key, careerBatch) {
      const res = await handle(new Request("https://upmore.example.test/chat", {
        method: "POST", headers: { Authorization: "Bearer mock-user-token", "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD, message, turn_key: key, career_batch: careerBatch }),
      }));
      const body = await res.json();
      assert.equal(networkCalls, 0, "the handler attempted no external network call");
      return { status: res.status, body };
    },
    close() { fs.rmSync(stage, { recursive: true, force: true }); },
  };
}
function freshDb() {
  return { state: { career: { v: 1, stores: { profile: clone(SNAPSHOT_PROFILE) } } }, messages: [], writes: [] };
}

// ---------------- the executor's harness store (over the fake's db) --
function harnessStore(db) {
  db.batchIntentState ||= new Map(); // intentId -> {state, result}
  db.batchRuns ||= new Map();        // runId -> record (the fake RPC reads this same map)
  db.batchLedgers ||= new Map();     // userId -> {records}
  return {
    async pending() {
      const out = [];
      for (const intent of (db.batchIntents || new Map()).values()) {
        const st = db.batchIntentState.get(intent.intent_id);
        if (st && st.state !== "queued") continue;
        const binding = { ...intent }; delete binding.run;
        out.push({ userId: intent.user_id, intentId: intent.intent_id, binding, request: intent.action === "prepare" ? { run: intent.run } : null });
      }
      return out;
    },
    async claim({ intentId }) {
      const st = db.batchIntentState.get(intentId);
      if (st && st.state !== "queued") return null;
      db.batchIntentState.set(intentId, { state: "claimed" });
      return { claimed: true };
    },
    async finish({ intentId, state, result }) { db.batchIntentState.set(intentId, { state, result }); },
    async saveRun(record) { db.batchRuns.set(record.runId, clone(record)); },
    async readRun({ userId, runId }) { const r = db.batchRuns.get(runId); return r && r.userId === userId ? clone(r) : null; },
    async ledgerFor(userId) { if (!db.batchLedgers.has(userId)) db.batchLedgers.set(userId, { records: [] }); return db.batchLedgers.get(userId); },
    async saveLedger(userId, records) { db.batchLedgers.set(userId, { records }); },
  };
}
function makeExecutor(db, boardForFor) {
  return createBatchExecutor({
    store: harnessStore(db),
    postingsFor: async () => clone(MARKET),
    profileFor: async () => ({ profile: PORTAL_PROFILE, profileMaster: MASTER, attestations: ATTEST }),
    boardForFor,
    now: () => NOW,
  });
}
function providerBoardFor(baseUrl, userId) {
  const transport = createSyncHttpTransport({ baseUrl, timeoutMs: 20000 });
  const boardFor = Bridge.createCareerBoardFor(Bridge.createWorkerBoardProvider({ workerUrl: baseUrl, secret: SECRET, userId, transport }));
  return { boardFor, close: () => transport.close() };
}

// ---------------- the board service as a separate process -----------
async function spawnBoardService() {
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/board-service-sandbox.cjs"), SECRET], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const m = buf.match(/PORT (\d+)/); if (m) resolve(Number(m[1])); });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => reject(new Error(`board service helper exited early (${code})`)));
    setTimeout(() => reject(new Error("board service helper did not announce a port")), 10000);
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

// ---------------- request normalization (bridge) --------------------
test("normalize: batch requests are strictly shaped — approve/status only, hash-bound approve", () => {
  assert.equal(Bridge.normalizeCareerBatchRequest(null), null);
  assert.deepEqual(Bridge.normalizeCareerBatchRequest({ action: "status", runId: "batch-abc123" }), { version: "career_batch_intent/v1", action: "status", runId: "batch-abc123" });
  assert.equal(Bridge.normalizeCareerBatchRequest({ action: "approve", runId: "batch-abc123", cardSha256: "a".repeat(64), eventId: "evt-1" }).action, "approve");
  assert.throws(() => Bridge.normalizeCareerBatchRequest({ action: "prepare", runId: "batch-abc123" }), /invalid_career_task/, "prepare is message-triggered only, never client-requested");
  assert.throws(() => Bridge.normalizeCareerBatchRequest({ action: "approve", runId: "batch-abc123", eventId: "evt-1" }), /invalid_career_task/, "an approve without the card hash is not an approve");
  assert.throws(() => Bridge.normalizeCareerBatchRequest({ action: "status", runId: "batch-abc123", extra: 1 }), /invalid_career_task/, "unknown fields refuse");
  assert.throws(() => Bridge.normalizeCareerBatchRequest({ action: "status", runId: "not-a-run" }), /invalid_career_task/);
});

// ---------------- the RPC store's wire shape -------------------------
test("rpc store: pending/claim/finish speak the batch RPCs, and finish carries the claim's lease", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === "career_batch_pending_v1") return { intents: [{ userId: "u1", intentId: "i1", binding: { action: "prepare" }, request: { run: { id: "batch-x" } } }] };
    if (name === "career_batch_claim_v1") return { claimed: true, leaseToken: "lease-1" };
    if (name === "career_batch_ledger_v1") return { records: [] };
    return {};
  };
  const store = createBatchRpcStore({ call });
  assert.equal((await store.pending()).length, 1);
  assert.ok(await store.claim({ userId: "u1", intentId: "i1" }));
  await store.finish({ userId: "u1", intentId: "i1", state: "completed", result: { runId: "batch-x" } });
  const finishCall = calls.find(([n]) => n === "career_batch_finish_v1");
  assert.equal(finishCall[1].p_lease, "lease-1", "the finish is bound to the claim's lease");
  assert.equal(finishCall[1].p_state, "completed");
});

// ---------------- the full composition ------------------------------
test("delegation: the exact owner message runs ask -> prepare -> card -> yes -> execute -> submitted end states", { timeout: 180000 }, async () => {
  const { child, baseUrl } = await spawnBoardService();
  const provider = providerBoardFor(baseUrl, USER);
  const db = freshDb();
  const app = await stagedApp(db, USER, true);
  try {
    // 1. THE ASK — one message; the seam delegates; the reply is an
    // honest queued claim and one prepare intent is committed.
    const ask = await app.chat("apply to 15 software engineering intern roles", "dk-ask-1");
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    assert.equal(ask.body.meta.intent, "career_batch_apply", ask.body.reply);
    assert.equal(ask.body.meta.result_status, "queued", ask.body.reply);
    assert.match(ask.body.reply, /browser worker to prepare/);
    assert.doesNotMatch(ask.body.reply, /Submitted \d|sitting at the final review/, "the ask reply claims neither a submission nor a presented card — preparation is the worker's, later");
    assert.ok(ask.body.batch && ask.body.batch.kind === "pending_batch_intent" && ask.body.batch.status === "queued", "the committed prepare intent rides the reply");
    const runId = ask.body.batch.id;
    assert.ok(runId && runId.startsWith("batch-"), "the run id is named in the reply's batch record");
    assert.equal((db.batchIntents || new Map()).size, 1, "exactly one intent committed with the turn");
    const prepareIntent = [...db.batchIntents.values()][0];
    assert.equal(prepareIntent.action, "prepare");
    assert.equal(prepareIntent.run.status, "queued_prepare", "the intent carries the untouched skeleton — preparation is the worker's work");
    assert.ok(!db.batchRuns || db.batchRuns.size === 0, "no run record exists yet — nothing is claimed prepared");

    // 2. THE WORKER PREPARES — module 155 in the executor's process,
    // boards vended by the board service over the real HTTP wire.
    const executor = makeExecutor(db, () => provider.boardFor);
    const prepResults = await executor.runBatchPending();
    assert.equal(prepResults.length, 1);
    assert.equal(prepResults[0].action, "prepare");
    assert.equal(prepResults[0].status, "completed");
    assert.equal(prepResults[0].doorstep, 13, "the fixture trajectory holds through the delegation: 13 doorsteps");
    const prepared = db.batchRuns.get(runId);
    assert.ok(prepared, "the worker wrote the batch run record");
    assert.equal(prepared.status, "awaiting_approval");
    assert.equal(prepared.summary.submitted, 0);
    assert.deepEqual(prepared.summary.stops.map((x) => x.code).sort(), ["CAPTCHA_HANDOFF", "UNCOVERED_QUESTION"], "the two in-window stops are named in the worker's record");

    // 3. THE CARD READS BACK — a status turn speaks the worker's record.
    const status1 = await app.chat("batch status", "dk-status-1", { action: "status", runId });
    assert.equal(status1.status, 200, JSON.stringify(status1.body));
    assert.ok(status1.body.batch && status1.body.batch.kind === "batch_run" && status1.body.batch.status === "awaiting_approval");
    assert.match(status1.body.reply, /final review screen/, "the card is presented from the worker's written record");
    assert.doesNotMatch(status1.body.reply, /Submitted [1-9]/, "nothing claims a submission before the yes");

    // 4. THE YES, DISCIPLINED — a bare yes authorizes nothing; a yes
    // for a moved card queues nothing.
    const bare = await app.chat("yes", "dk-approve-bare", { action: "approve", runId, cardSha256: prepared.run.cardSha256, eventId: "evt-bare" });
    assert.match(bare.body.reply, /bare yes authorizes nothing/);
    assert.equal(db.batchIntents.size, 1, "no approve intent was committed for a bare yes");
    const moved = await app.chat("Approve batch " + runId, "dk-approve-moved", { action: "approve", runId, cardSha256: "0".repeat(64), eventId: "evt-moved" });
    assert.match(moved.body.reply, /changed since the card/);
    assert.equal(db.batchIntents.size, 1, "no approve intent was committed against a moved card");

    // 5. THE YES — exact message + the card's own hash.
    const yes = await app.chat("Approve batch " + runId, "dk-approve-1", { action: "approve", runId, cardSha256: prepared.run.cardSha256, eventId: "evt-approve-1" });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.ok(yes.body.batch && yes.body.batch.kind === "pending_batch_intent", "the approve intent rides the reply");
    assert.match(yes.body.reply, /This reply itself submitted nothing/);
    assert.equal(db.batchIntents.size, 2, "the approve intent committed with the turn");

    // 6. THE WORKER EXECUTES — set hash re-verified against the
    // stored run, approvalRef minted, 13 submit under it.
    const execResults = await executor.runBatchPending();
    const execResult = execResults.find((r) => r.action === "approve");
    assert.ok(execResult, JSON.stringify(execResults));
    assert.equal(execResult.status, "completed");
    assert.equal(execResult.submitted, 13, "13 applications submitted by the worker under the committed approval");
    const final = db.batchRuns.get(runId);
    assert.equal(final.summary.submitted, 13);
    assert.equal(final.summary.confirmations.length, 13);
    for (const c of final.summary.confirmations) assert.match(c.confirmationId, /^SBX-\d{4}$/);
    assert.ok(final.summary.approvalRef && final.summary.approvalRef.includes(runId), "the Leg-1 approvalRef that armed the boards is on the final record");
    assert.equal(db.batchLedgers.get(USER).records.filter((r) => r.status === "submitted").length, 13, "the shared cap ledger holds all 13 submissions");

    // 7. THE REPORT READS BACK — the thread now speaks submitted end states.
    const status2 = await app.chat("batch status", "dk-status-2", { action: "status", runId });
    assert.ok(status2.body.batch && status2.body.batch.summary.submitted === 13);
    assert.match(status2.body.reply, /Submitted 13/);

    // 8. CROSS-OWNER — another user's status read gets nothing. The
    // second app gets its OWN thread state (production: agent_flow_
    // state is per user+thread) sharing only the backend batch-runs
    // table the readback RPC reads.
    const dbB = freshDb();
    dbB.batchRuns = db.batchRuns;
    const appB = await stagedApp(dbB, USER_B, true);
    try {
      const foreign = await appB.chat("batch status", "dk-status-foreign", { action: "status", runId });
      assert.match(foreign.body.reply, /only ever readable by its owner/);
      assert.ok(!foreign.body.batch, "no run record crosses to another user");
    } finally { appB.close(); }
  } finally {
    app.close();
    provider.close();
    child.kill("SIGTERM");
  }
});

// ---------------- degradation: no worker configured ------------------
test("degradation: with no worker configured there is no delegation — the honest in-turn outcome and no intent", { timeout: 120000 }, async () => {
  const db = freshDb();
  const app = await stagedApp(db, USER, false);
  try {
    const ask = await app.chat("apply to 15 software engineering intern roles", "dk-unwired-1");
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    assert.equal(ask.body.meta.intent, "career_batch_apply", ask.body.reply);
    assert.ok(!ask.body.batch, "no batch intent is attached — nothing was delegated");
    assert.ok(!db.batchIntents || db.batchIntents.size === 0, "no intent was committed");
    assert.match(ask.body.reply, /Found 0/, "the in-turn path ran against the handler's (empty) hosted pool and said so — no worker was invented to fill it");
  } finally { app.close(); }
});

// ---------------- WO-106 (F5): a worker URL but no executor deployed ---------------
// Live 2026-10-21: production has the worker URL and secret but nothing drains career_batch_intent, so "I've handed this
// batch to the browser worker" was false. Without CAREER_BATCH_EXECUTOR=on there is no handoff claim and no intent.
test("WO-106/F5 a worker URL without a deployed executor: no handoff claim, no intent, and the reply says nothing was searched, prepared or sent", { timeout: 120000 }, async (t) => {
  const db = freshDb();
  const app = await stagedApp(db, USER, true, false);
  try {
    const ask = await app.chat("apply to 15 software engineering intern roles", "dk-noexec-1");
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    assert.doesNotMatch(ask.body.reply, /browser worker|handed/, ask.body.reply);
    assert.match(ask.body.reply, /nothing was searched, prepared or sent/, ask.body.reply);
    assert.ok(!ask.body.batch, "no batch intent rides the reply");
    assert.ok(!db.batchIntents || db.batchIntents.size === 0, "no intent was committed");
    t.diagnostic(`person: apply to 15 software engineering intern roles  ->  Trainee: ${ask.body.reply}`);
    const status = await app.chat("what's my batch status", "dk-noexec-2");
    t.diagnostic(`person: what's my batch status  ->  Trainee: ${status.body.reply}`);
    assert.doesNotMatch(status.body.reply, /queued_prepare|browser worker|handed/, `no phantom batch reads back: ${status.body.reply}`);
  } finally { app.close(); }
});

// ---------------- degradation: worker down at the boards ------------
test("degradation: worker configured but the board service is down — every selected application stops named BOARD_NOT_WIRED", { timeout: 180000 }, async () => {
  const { child, baseUrl } = await spawnBoardService();
  child.kill("SIGTERM"); // the board service is down before any drive
  await new Promise((r) => child.on("exit", r));
  const db = freshDb();
  const app = await stagedApp(db, USER, true);
  const provider = providerBoardFor(baseUrl, USER);
  try {
    const ask = await app.chat("apply to 15 software engineering intern roles", "dk-down-1");
    assert.equal(ask.body.meta.result_status, "queued", ask.body.reply);
    const runId = ask.body.batch.id;
    const executor = makeExecutor(db, () => provider.boardFor);
    const results = await executor.runBatchPending();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "completed", "preparation completes — with every drive stopped, named");
    assert.equal(results[0].doorstep, 0);
    const record = db.batchRuns.get(runId);
    assert.equal(record.summary.submitted, 0, "nothing was submitted through a dead worker");
    assert.equal(record.summary.stops.length, 15, "all 15 selected applications reached the drive stage and stopped there");
    assert.ok(record.summary.stops.every((x) => x.code === "BOARD_NOT_WIRED"), "one honest name on every stop");
    const status = await app.chat("batch status", "dk-down-status", { action: "status", runId });
    // Launch readiness Q3 (2026-10-26): the stop reaches the person in plain words; its code stays on the record only.
    assert.match(status.body.reply, /Trainee can't reach this employer's application site from here, so nothing was filled or sent/, "the readback names the stop in-thread");
    assert.doesNotMatch(status.body.reply, /BOARD_NOT_WIRED/, "in plain words, never its code");
  } finally {
    app.close();
    provider.close();
  }
});

}
