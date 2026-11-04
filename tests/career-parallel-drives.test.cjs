"use strict";
// Chunk 70% — parallel drives: board-service sharding guards.
// The board service's core is synchronous BY DESIGN (149/150/155 are
// synchronous at every layer), so one process = one board call in
// flight, globally. These guards prove the sharded service (N cores
// in N worker threads of one process, sessions sticky to their
// shard) removes that serialization WITHOUT weakening any refusal:
//   - refusal parity (401 / 405 / 404 / user_mismatch / SESSION_LIMIT)
//   - two slow fills on two sessions OVERLAP in wall-clock on the
//     sharded service and SERIALIZE on the single-core service
//     (the fail-first control, over real HTTP both ways)
//   - no cross-talk: each session's answers() holds only its own fills
//   - a foreign user is refused mid-flight, while a slow fill runs
//   - one leg's board failure never touches a sibling leg
//   - maxSessionsPerUser stays a GLOBAL bound across shards (a resource
//     bound on browser sessions, not a volume limit)
//   - boardShards absent/1 = the original single-core service
// Check: node --test tests/career-parallel-drives.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { createBoardService, createBoardHttpServer, createShardedBoardService, startBoardService } = require(path.join(ROOT, "workers/career-browser/board-service.cjs"));
const FACTORY_MODULE = path.join(ROOT, "tests/helpers/parallel-fake-board.cjs");
const SECRET = "parallel-drives-test-secret";
const GH_URL = "https://boards.greenhouse.io/acme/jobs/123";

function listen(server) {
  return new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
}
function closeServer(server) {
  return new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
}
function post(port, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: Object.assign({ "content-type": "application/json", "x-upmore-board-secret": SECRET }, headers || {}), agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let b = null; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, body: b }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body || {}));
  });
}
const create = (port, userId) => post(port, "/board-sessions", { userId, url: GH_URL });
const call = (port, id, userId, method, args) => post(port, `/board-sessions/${id}/call`, { userId, method, args: args || [] });
const close = (port, id, userId) => post(port, `/board-sessions/${id}/close`, { userId });

test("sharded service: roundtrip + refusal parity", async (t) => {
  const started = startBoardService({ port: 0, secret: SECRET, boardShards: 3, familyVerdicts: { greenhouse: true }, boardFactoryModule: FACTORY_MODULE, sweepMs: 0 });
  const port = await listen(started.server);
  t.after(async () => { await closeServer(started.server); await started.service.close(); });

  const badSecret = await post(port, "/board-sessions", { userId: "u1", url: GH_URL }, { "x-upmore-board-secret": "wrong" });
  assert.equal(badSecret.status, 401);
  assert.equal(badSecret.body.error, "unauthorized");

  // an unauthenticated caller learns nothing about session existence:
  // a well-formed but unknown id with a bad secret is a 401, not a 404
  const oracle = await post(port, `/board-sessions/${"a".repeat(32)}/call`, { userId: "u1", method: "answers" }, { "x-upmore-board-secret": "wrong" });
  assert.equal(oracle.status, 401);

  const unknown = await call(port, "b".repeat(32), "u1", "answers");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "session_not_found");

  const refused = await post(port, "/board-sessions", { userId: "u1", url: "https://example.com/jobs/1" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "DRIVER_HOST_REFUSED");

  const made = await create(port, "u1");
  assert.equal(made.status, 201);
  assert.match(made.body.sessionId, /^[a-f0-9]{32}$/);
  const id = made.body.sessionId;

  const filled = await call(port, id, "u1", "fill", ["name", "Ada"]);
  assert.equal(filled.status, 200);
  assert.equal(filled.body.ok, true);
  const answers = await call(port, id, "u1", "answers");
  assert.equal(answers.body.result.name, "Ada");

  const closed = await close(port, id, "u1");
  assert.equal(closed.status, 200);
  const after = await call(port, id, "u1", "answers");
  assert.equal(after.status, 404);
});

test("the serialization, measured: single-core serializes two slow fills, shards overlap them", async (t) => {
  // control — the original single-core service over real HTTP
  const single = createBoardService({ secret: SECRET, familyVerdicts: { greenhouse: true }, boardFactory: require(FACTORY_MODULE) });
  const singleServer = createBoardHttpServer(single, {});
  singleServer.listen(0);
  const singlePort = await listen(singleServer);
  t.after(() => closeServer(singleServer));
  const s1 = (await create(singlePort, "u1")).body.sessionId;
  const s2 = (await create(singlePort, "u1")).body.sessionId;
  let t0 = Date.now();
  await Promise.all([call(singlePort, s1, "u1", "fill", ["slow", "x"]), call(singlePort, s2, "u1", "fill", ["slow", "y"])]);
  const serialMs = Date.now() - t0;
  assert.ok(serialMs >= 480, `single-core: two 250ms fills must serialize (>=480ms), took ${serialMs}ms`);

  // sharded — the same two fills on two sessions overlap
  const started = startBoardService({ port: 0, secret: SECRET, boardShards: 3, familyVerdicts: { greenhouse: true }, boardFactoryModule: FACTORY_MODULE, sweepMs: 0 });
  const port = await listen(started.server);
  t.after(async () => { await closeServer(started.server); await started.service.close(); });
  const h1 = (await create(port, "u1")).body.sessionId;
  const h2 = (await create(port, "u1")).body.sessionId;
  t0 = Date.now();
  await Promise.all([call(port, h1, "u1", "fill", ["slow", "x"]), call(port, h2, "u1", "fill", ["slow", "y"])]);
  const parallelMs = Date.now() - t0;
  assert.ok(parallelMs < 420, `sharded: two 250ms fills must overlap (<420ms), took ${parallelMs}ms`);
});

test("no cross-talk: concurrent sessions keep only their own fills", async (t) => {
  const started = startBoardService({ port: 0, secret: SECRET, boardShards: 3, familyVerdicts: { greenhouse: true }, boardFactoryModule: FACTORY_MODULE, sweepMs: 0 });
  const port = await listen(started.server);
  t.after(async () => { await closeServer(started.server); await started.service.close(); });
  const a = (await create(port, "u1")).body.sessionId;
  const b = (await create(port, "u1")).body.sessionId;
  await Promise.all([
    call(port, a, "u1", "fill", ["name", "AAA"]),
    call(port, b, "u1", "fill", ["name", "BBB"]),
    call(port, a, "u1", "fill", ["slow", "A-slow"]),
    call(port, b, "u1", "fill", ["slow", "B-slow"]),
  ]);
  const ansA = (await call(port, a, "u1", "answers")).body.result;
  const ansB = (await call(port, b, "u1", "answers")).body.result;
  assert.equal(ansA.name, "AAA");
  assert.equal(ansA.slow, "A-slow");
  assert.equal(ansB.name, "BBB");
  assert.equal(ansB.slow, "B-slow");
  assert.notEqual(ansA.__board, ansB.__board);
});

test("foreign user refused mid-flight; a leg's failure never touches its sibling", async (t) => {
  const started = startBoardService({ port: 0, secret: SECRET, boardShards: 3, familyVerdicts: { greenhouse: true }, boardFactoryModule: FACTORY_MODULE, sweepMs: 0 });
  const port = await listen(started.server);
  t.after(async () => { await closeServer(started.server); await started.service.close(); });
  const a = (await create(port, "owner-a")).body.sessionId;
  const b = (await create(port, "owner-a")).body.sessionId;

  const slowFill = call(port, a, "owner-a", "fill", ["slow", "in-flight"]);
  const foreign = await call(port, a, "owner-b", "answers");
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, "user_mismatch");
  const slowResult = await slowFill;
  assert.equal(slowResult.body.ok, true);

  const boom = await call(port, a, "owner-a", "fill", ["boom", "x"]);
  assert.equal(boom.status, 200);
  assert.equal(boom.body.ok, false);
  assert.equal(boom.body.code, "BOARD_FILL_FAILED");

  const bFill = await call(port, b, "owner-a", "fill", ["name", "sibling-fine"]);
  assert.equal(bFill.body.ok, true);
  const bAns = (await call(port, b, "owner-a", "answers")).body.result;
  assert.equal(bAns.name, "sibling-fine");
  const aAns = (await call(port, a, "owner-a", "answers")).body.result;
  assert.equal(aAns.slow, "in-flight");
  assert.equal(aAns.name, undefined);
});

test("maxSessionsPerUser stays a global cap across shards", async (t) => {
  const started = startBoardService({ port: 0, secret: SECRET, boardShards: 2, maxSessionsPerUser: 4, familyVerdicts: { greenhouse: true }, boardFactoryModule: FACTORY_MODULE, sweepMs: 0 });
  const port = await listen(started.server);
  t.after(async () => { await closeServer(started.server); await started.service.close(); });
  for (let i = 0; i < 4; i += 1) {
    const made = await create(port, "capped-user");
    assert.equal(made.status, 201, `create ${i + 1} of 4 must succeed`);
  }
  const fifth = await create(port, "capped-user");
  assert.equal(fifth.status, 409);
  assert.equal(fifth.body.error, "SESSION_LIMIT");
  const other = await create(port, "another-user");
  assert.equal(other.status, 201);
});

test("F-033: a request queued behind a >=5s board call is served, not reset", async (t) => {
  // Regression guard for the live-measured defect: with Node's
  // default 5s keepAliveTimeout, a request that arrives while the
  // service loop is blocked inside another session's long call sits
  // unparsed past its socket's keep-alive expiry; when the loop
  // frees, the expired timer destroys the socket (client:
  // ECONNRESET -> WORKER_UNREACHABLE) before the parser reads it.
  const single = createBoardService({ secret: SECRET, familyVerdicts: { greenhouse: true }, boardFactory: require(FACTORY_MODULE) });
  const server = createBoardHttpServer(single, {});
  server.listen(0);
  const port = await listen(server);
  t.after(() => closeServer(server));

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const postOnAgent = (p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "x-upmore-board-secret": SECRET }, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let b = null; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, body: b }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body || {}));
  });

  // client B: one full request/response on its pooled socket, so the
  // socket's keep-alive timer is armed — the precondition of the race
  const bMade = await postOnAgent("/board-sessions", { userId: "u-b", url: GH_URL });
  assert.equal(bMade.status, 201);
  const bId = bMade.body.sessionId;
  const bWarm = await postOnAgent(`/board-sessions/${bId}/call`, { userId: "u-b", method: "answers", args: [] });
  assert.equal(bWarm.status, 200);

  // client A parks the loop inside a 6s board call
  const aId = (await create(port, "u-a")).body.sessionId;
  const slowCall = call(port, aId, "u-a", "fill", ["slow6", "block"]);
  await new Promise((r) => setTimeout(r, 400)); // A's call is executing; the loop is blocked

  // B's next request is sent on its pooled socket and must queue
  // unparsed for the remaining ~5.6s — past the 5s default expiry
  const queued = await postOnAgent(`/board-sessions/${bId}/call`, { userId: "u-b", method: "answers", args: [] });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.ok, true);
  const slowResult = await slowCall;
  assert.equal(slowResult.body.ok, true);
});

test("ledger race and no volume cap: two approve drains racing; a fresh read lets both through; only a site's refusal defers one", async (t) => {
  // The drive-layer ledger seam, with the REAL modules end to end
  // (executor -> 155 -> 149 -> sandbox boards). The executor's
  // discipline is read-snapshot -> execute (mutates the snapshot) ->
  // whole-ledger replace (batch-executor buildDeps/saveLedger). Two
  // drains that snapshot CONCURRENTLY share one stale view. NO LIMITS
  // (owner, 2026-10-27): 149 has no per-day/vendor/company cap, so the
  // ledger matters for exactly-once and for a site's refusal, never for
  // a count. This guard pins, in order:
  //   (a) NAIVE store (whole replace, no version check): both legs
  //       submit and the second save ERASES the first leg's record (a
  //       lost write, characterized: the ledger is blind to one).
  //   (b) VERSIONED store (saveLedger refuses a stale snapshot with
  //       LEDGER_VERSION_CONFLICT): no record is lost; the loser's
  //       refusal is named.
  //   (c) FRESH-READ drain after the winner lands: the second leg
  //       SUBMITS (14 earlier submissions today stop nothing).
  //   (d) a site's refusal in the ledger (status portal_refused, until a
  //       minute from now) defers a leg to that site: 155 records it
  //       PORTAL_REFUSING with resumeOn = the site's own time; nothing
  //       is submitted for it.
  // The production ledger RPC (career_batch_save_ledger_v1) takes
  // only the records today — (b)'s version token is the discipline
  // it needs; that is the S-1 lane's draft-migration territory, and
  // this guard is its fail-first specification.
  const Batch = require(path.join(ROOT, "packages/domain/155-career-batch-apply.js"));
  const Portal = require(path.join(ROOT, "packages/domain/149-career-portal-apply.js"));
  const { createBatchExecutor } = require(path.join(ROOT, "workers/career-browser/batch-executor.cjs"));
  const USER = "user-cap-race";
  const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const PROFILE = {
    name: "Alex Testcase (TEST)", email: "alex.testcase@example.test",
    phone: "+1 000 555 0100", location: "Chicago, IL",
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
  const posting = (co) => ({
    id: `JOB-${co}`, job_id: `JOB-${co}`, canonicalKey: `greenhouse:${co.toLowerCase()}:software-engineering-intern`,
    company: co, role: "Software Engineering Intern", title: "Software Engineering Intern",
    url: `https://boards.greenhouse.io/${co.toLowerCase()}/jobs/1`,
    status: "open", atsFamily: "greenhouse", location: "Chicago, IL", posted_at: "2026-10-10",
    jd_text: "Software engineering intern role. JavaScript, testing, code review, agile team.",
  });
  // 14 earlier submissions today across vendors (under the removed
  // caps, one per-day slot would have been left; now they stop nothing).
  const SEED_VENDORS = ["greenhouse", "lever", "ashby", "workday", "greenhouse", "lever", "smartrecruiters", "greenhouse", "lever", "ashby", "greenhouse", "lever", "workday", "ashby"];
  const seedRecord = (i) => ({
    userId: USER, status: "submitted", timestamp: new Date(NOW - i * 60000).toISOString(),
    vendor: SEED_VENDORS[i], company: `Seed Co ${i}`, canonicalKey: `${SEED_VENDORS[i]}:seed${i}:role`,
  });

  function makeStore(versioned) {
    const state = { records: Array.from({ length: 14 }, (_, i) => seedRecord(i)), version: 1, runs: new Map(), intents: new Map(), states: new Map(), arrayVersions: new WeakMap() };
    let barrier = null;
    const store = {
      state,
      armBarrier(n) { barrier = { n, arrived: 0, waiters: [] }; },
      async pending() { return []; }, // replaced per-executor views below
      async claim() { return { claimed: true }; },
      async finish() {},
      async saveRun(record) { state.runs.set(record.runId, clone(record)); },
      async readRun({ runId }) { const r = state.runs.get(runId); return r ? clone(r) : null; },
      async ledgerFor(userId) {
        if (barrier) {
          const b = barrier;
          b.arrived += 1;
          if (b.arrived >= b.n) { barrier = null; for (const w of b.waiters) w(); }
          else await new Promise((r) => b.waiters.push(r));
        }
        const records = clone(state.records);
        state.arrayVersions.set(records, state.version);
        return { records };
      },
      async saveLedger(userId, records) {
        if (versioned) {
          const v = state.arrayVersions.get(records);
          if (v !== state.version) {
            const e = new Error(`the ledger moved under this drain (snapshot v${v}, current v${state.version}) — refusing to overwrite another drain's submissions`);
            e.code = "LEDGER_VERSION_CONFLICT";
            throw e;
          }
        }
        state.records = clone(records);
        state.version += 1;
        state.arrayVersions.set(state.records, state.version);
      },
    };
    return store;
  }

  // one executor process's view: its own intent queue, the shared ledger
  function executorView(store, myIntentIds) {
    const view = Object.assign({}, store, {
      async pending() {
        const out = [];
        for (const [id, it] of store.state.intents) {
          if (!myIntentIds.includes(id)) continue;
          const st = store.state.states.get(id);
          if (st && st.state !== "queued") continue;
          out.push({ userId: USER, intentId: id, binding: it.binding, request: it.binding.action === "prepare" ? { run: it.run } : null });
        }
        return out;
      },
      async claim({ intentId }) {
        const st = store.state.states.get(intentId);
        if (st && st.state !== "queued") return null;
        store.state.states.set(intentId, { state: "claimed" });
        return { claimed: true };
      },
      async finish({ intentId, state, result }) { store.state.states.set(intentId, { state, result }); },
    });
    return createBatchExecutor({
      store: view,
      postingsFor: async () => [],
      profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER, attestations: ATTEST }),
      boardForFor: () => (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily }),
      now: () => NOW,
    });
  }

  async function prepareAndApprove(store, tag, co) {
    const run = Batch.createRun({ userId: USER, familyText: "software engineering intern roles", count: 1, now: NOW });
    store.state.intents.set(`prep-${tag}`, { binding: { action: "prepare", run_id: run.id, family_text: "software engineering intern roles" }, run: Batch.serializeRun(run) });
    const prepExec = createBatchExecutor({
      store: Object.assign({}, store, {
        async pending() { const it = store.state.intents.get(`prep-${tag}`); return [{ userId: USER, intentId: `prep-${tag}`, binding: it.binding, request: { run: it.run } }]; },
        async claim() { return { claimed: true }; },
        async finish() {},
      }),
      postingsFor: async () => [posting(co)],
      profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER, attestations: ATTEST }),
      boardForFor: () => (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily }),
      now: () => NOW,
    });
    const [prep] = await prepExec.runBatchPending();
    assert.equal(prep.status, "completed", `prepare ${tag} completes: ${JSON.stringify(prep)}`);
    const record = await store.readRun({ userId: USER, runId: run.id });
    assert.ok(record && record.run && record.run.cardSha256, `prepare ${tag} produced a card`);
    store.state.intents.set(`appr-${tag}`, { binding: { action: "approve", run_id: run.id, card_sha256: record.run.cardSha256 } });
    return run.id;
  }

  async function scenario(versioned) {
    const store = makeStore(versioned);
    await prepareAndApprove(store, "a", "RaceA");
    await prepareAndApprove(store, "b", "RaceB");
    assert.equal(store.state.records.filter((r) => r.status === "submitted").length, 14, "seed: 14 submitted today");
    store.armBarrier(2); // both approve drains snapshot the ledger before either saves
    const execA = executorView(store, ["appr-a"]);
    const execB = executorView(store, ["appr-b"]);
    const settled = await Promise.allSettled([execA.runBatchPending(), execB.runBatchPending()]);
    return { store, settled };
  }

  // (a) naive store: the race is real. Both drains execute their
  // submission (each reports submitted=1; reality is 16 submissions
  // against a cap of 15), but whole-ledger replace means the second
  // save silently ERASES the first leg's record: the ledger shows a
  // compliant 15 while reality exceeded the cap — the worse failure,
  // because every later cap count is computed from the blind ledger.
  {
    const { store, settled } = await scenario(false);
    assert.ok(settled.every((s) => s.status === "fulfilled"));
    const results = settled.flatMap((s) => s.value);
    const reportedSubmitted = results.reduce((n, r) => n + (r.submitted || 0), 0);
    assert.equal(reportedSubmitted, 2, `both racing legs executed a submission: ${JSON.stringify(results)}`);
    const inLedger = store.state.records.filter((r) => r.status === "submitted");
    assert.equal(inLedger.length, 15, "the ledger reads a compliant 15…");
    const recorded = inLedger.filter((r) => r.company === "RaceA" || r.company === "RaceB");
    assert.equal(recorded.length, 1, "…but only one of the two real submissions is recorded — the other's record was overwritten, characterized");
  }

  // (b) versioned store: exactly one proceeds, the refusal is named
  let conflictCode = null;
  {
    const { store, settled } = await scenario(true);
    const submitted = store.state.records.filter((r) => r.status === "submitted").length;
    assert.equal(submitted, 15, `versioned discipline: the winner's record is kept, none lost (got ${submitted})`);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    const blocked = results.filter((r) => r.status === "blocked" || r.status === "uncertain");
    assert.equal(blocked.length, 1, `exactly one drain is refused: ${JSON.stringify(results)}`);
    conflictCode = blocked[0].code || (blocked[0].result && blocked[0].result.code) || null;
    assert.equal(conflictCode, "LEDGER_VERSION_CONFLICT");
  }

  // (c) fresh-read drain after the winner: the second leg submits too — no count stops it
  {
    const store = makeStore(true);
    await prepareAndApprove(store, "a", "FreshA");
    await prepareAndApprove(store, "b", "FreshB");
    const execA = executorView(store, ["appr-a"]);
    const [ra] = await execA.runBatchPending();
    assert.equal(ra.status, "completed");
    assert.equal(store.state.records.filter((r) => r.status === "submitted").length, 15);
    const execB = executorView(store, ["appr-b"]);
    const [rb] = await execB.runBatchPending();
    assert.equal(rb.submitted, 1, `the fresh-read leg submits: ${JSON.stringify(rb)}`);
    assert.equal(store.state.records.filter((r) => r.status === "submitted").length, 16, "16 today: no volume cap");
  }

  // (d) a site's refusal in the ledger defers the leg to that site until the site's own time
  {
    const store = makeStore(true);
    await prepareAndApprove(store, "c", "HeldC");
    const until = new Date(NOW + 60000).toISOString();
    store.state.records.push({ userId: USER, status: "portal_refused", host: "boards.greenhouse.io", vendor: "greenhouse", why: "rate_limited",
      timestamp: new Date(NOW).toISOString(), until, canonicalKey: null });
    store.state.version += 1;
    const execC = executorView(store, ["appr-c"]);
    const [rc] = await execC.runBatchPending();
    assert.equal(rc.submitted, 0, "nothing submitted to a refusing site");
    const cRun = ((await store.readRun({ userId: USER, runId: rc.runId })) || {}).run || {};
    const apps = Object.values(cRun.apps || {});
    assert.ok(apps.every((a) => a.stage === "deferred_refusal"), `deferred_refusal: ${JSON.stringify(apps.map((a) => a.stage))}`);
    const deferred = (cRun.deferred || []).filter((d) => d.code === "PORTAL_REFUSING");
    assert.equal(deferred.length, 1, `155 records PORTAL_REFUSING: ${JSON.stringify(cRun.deferred)}`);
    assert.equal(deferred[0].resumeOn, until, "it resumes at the site's own time");
    assert.equal(store.state.records.filter((r) => r.status === "submitted").length, 14);
  }
});

test("kill switch: no boardShards = the original single-core service; boardShards < 2 refused for the sharded factory", async (t) => {
  assert.throws(() => createShardedBoardService({ boardShards: 1, secret: SECRET }), /boardShards >= 2/);
  const started = startBoardService({ port: 0, secret: SECRET, familyVerdicts: { greenhouse: true }, boardFactory: require(FACTORY_MODULE) });
  const port = await listen(started.server);
  t.after(() => closeServer(started.server));
  const made = await create(port, "u1");
  assert.equal(made.status, 201);
  const filled = await call(port, made.body.sessionId, "u1", "fill", ["name", "Solo"]);
  assert.equal(filled.body.ok, true);
  const closed = await close(port, made.body.sessionId, "u1");
  assert.equal(closed.status, 200);
});
