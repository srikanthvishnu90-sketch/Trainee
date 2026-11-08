"use strict";
// R9 (2026-11-07): the batch executor's paced drive (workers/career-browser/apply-scheduler.cjs through
// batch-executor.cjs), on the REAL 155 and 149 over 149's sandbox board, an in-memory store with the batch RPCs' shape and
// a virtual clock. An approved batch is sent one application a minute, each through 149's own click-time check; what the
// drive's budget leaves is named PACE_DEFERRED, still at its doorstep, never sent; a second approve of the same postings
// sends nothing twice; the person's window holds across their batches.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const Batch = require(path.join(root, "packages/domain/155-career-batch-apply.js"));
const Portal = require(path.join(root, "packages/domain/149-career-portal-apply.js"));
const { createBatchExecutor, createBatchRpcStore } = require(path.join(root, "workers/career-browser/batch-executor.cjs"));

const USER = "user-paced-r9";
const T0 = Date.UTC(2026, 10, 9, 15, 0, 0);
const MIN = 60_000;
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const PROFILE = {
  name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: { work_authorization: { value: "Yes", confirmed: true }, sponsorship: { value: "No", confirmed: true } },
};
const MASTER = { basics: { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test" },
  facts: [{ id: "F-T-001", kind: "skill", text: "JavaScript and Node.js development", confirmed: true }, { id: "F-T-002", kind: "experience", text: "Built web applications as a student developer", confirmed: true }] };
const posting = (i) => ({
  id: `JOB-${i}`, job_id: `JOB-${i}`, canonicalKey: `greenhouse:co${i}:software-engineering-intern`, company: `Co${i}`, role: "Software Engineering Intern",
  title: "Software Engineering Intern", url: `https://boards.greenhouse.io/co${i}/jobs/${9000 + i}`, status: "open", atsFamily: "greenhouse",
  location: "Chicago, IL", posted_at: "2026-11-01", jd_text: "Software engineering intern role. JavaScript, testing, code review, agile team.",
});

function backend() {
  const intents = new Map(), runs = new Map(), ledgers = new Map();
  async function call(name, a) {
    switch (name) {
      case "career_batch_pending_v1": return { intents: [...intents].filter(([, i]) => i.state === "queued").map(([intentId, i]) => ({ userId: i.userId, intentId, binding: clone(i.binding), request: clone(i.request) })) };
      case "career_batch_claim_v1": { const i = intents.get(a.p_intent); if (!i || i.state !== "queued") return { claimed: false }; i.state = "claimed"; return { claimed: true, leaseToken: "L", binding: clone(i.binding), request: clone(i.request) }; }
      case "career_batch_finish_v1": { const i = intents.get(a.p_intent); i.state = a.p_state; i.result = clone(a.p_result); return { finished: true }; }
      case "career_batch_save_run_v1": runs.set(a.p_run.runId, clone(a.p_run)); return { saved: true };
      case "career_batch_result_v1": { const r = runs.get(a.p_run); return { batch: r ? clone(r) : null }; }
      case "career_batch_ledger_v1": return { records: clone(ledgers.get(a.p_user) || []) };
      case "career_batch_save_ledger_v1": ledgers.set(a.p_user, clone(a.p_records || [])); return { saved: true };
      default: { const e = new Error("unexpected RPC " + name); throw e; }
    }
  }
  return { call, intents, runs, ledgers, seed: (id, binding, request, userId = USER) => intents.set(id, { userId, binding, request, state: "queued" }) };
}

function world(postings, o = {}) {
  const b = backend();
  let t = T0;
  const sends = [];
  const executor = createBatchExecutor({
    store: createBatchRpcStore({ call: b.call }),
    postingsFor: async (u, tag) => clone(o.byTag ? o.byTag[tag] : postings),
    profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER }),
    boardForFor: () => (p) => {
      const board = Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily });
      const click = board.clickSubmit;
      if (typeof click === "function") board.clickSubmit = (...args) => { sends.push({ at: t, company: p.company }); return click.apply(board, args); };
      return board;
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    scheduler: { limits: { perPersonHour: 60, perPersonDay: 200, ...(o.limits || {}) } },
    driveBudgetMs: o.budget ?? 3 * MIN,
  });
  return { b, executor, sends, clock: () => t };
}
async function prepareAndApprove(w, tag, postings) {
  const run = Batch.createRun({ userId: USER, familyText: tag, count: postings.length, now: w.clock() });
  w.b.seed(`p-${tag}`, { action: "prepare", run_id: run.id, family_text: tag }, { run: clone(run) });
  await w.executor.runBatchPending();
  const stored = Batch.restoreRun(clone(w.b.runs.get(run.id).run));
  assert.equal(stored.summary.doorstep, postings.length, "every posting at its doorstep");
  w.b.seed(`a-${tag}`, { action: "approve", run_id: run.id, card_sha256: stored.cardSha256 }, null);
  const res = await w.executor.runBatchPending();
  return { res: res.find((r) => r.action === "approve"), run: Batch.restoreRun(clone(w.b.runs.get(run.id).run)) };
}

test("R9 an approved batch is sent one a minute; what the drive's budget leaves is PACE_DEFERRED at its doorstep, never sent", async () => {
  const postings = [1, 2, 3, 4, 5, 6].map(posting);
  const w = world(postings);
  const { res, run } = await prepareAndApprove(w, "paced", postings);
  assert.equal(res.status, "completed", JSON.stringify(res));
  assert.equal(run.summary.submitted, 4, "sent at 0, 1, 2 and 3 minutes inside a 3-minute budget");
  const deferred = run.summary.deferred.filter((d) => d.code === "PACE_DEFERRED");
  assert.equal(deferred.length, 2);
  assert.equal(run.summary.doorstep, 2, "the deferred two are still at their doorstep: approved, not sent");
  assert.equal(res.paced, 2);
  assert.ok(["completed", "completed_with_stops"].includes(run.status));
  if (w.sends.length) for (let i = 1; i < w.sends.length; i++) assert.ok(w.sends[i].at - w.sends[i - 1].at >= MIN, "a minute apart");
});

test("R9 without a scheduler the executor drives the whole batch at once, as before", async () => {
  const postings = [1, 2, 3].map(posting);
  const b = backend();
  const executor = createBatchExecutor({ store: createBatchRpcStore({ call: b.call }), postingsFor: async () => clone(postings), profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER }),
    boardForFor: () => (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily }), now: () => T0 });
  const { run } = await prepareAndApprove({ b, executor, clock: () => T0 }, "unpaced", postings);
  assert.equal(run.summary.submitted, 3);
  assert.equal(run.summary.deferred.filter((d) => d.code === "PACE_DEFERRED").length, 0);
});

test("R9 the person's window holds across batches: a second batch in the same minute waits its turn", async () => {
  const first = [1, 2].map(posting), second = [3, 4].map(posting);
  const w = world([], { budget: 1, byTag: { one: first, two: second } }); // one executor process, one scheduler
  const one = await prepareAndApprove(w, "one", first);
  assert.equal(one.run.summary.submitted, 1, "a 1 ms budget sends only what is due now");
  const two = await prepareAndApprove(w, "two", second);
  assert.equal(two.run.summary.submitted, 0, "the person sent one this minute: the next is a minute away");
  assert.equal(two.run.summary.deferred.filter((d) => d.code === "PACE_DEFERRED").length, 2);
});

test("R9 one person's paced drive does not hold another person's batch: different people are driven side by side", async () => {
  // A virtual clock that only moves forward while every drive waits: each sleep yields to the other drives first.
  const b = backend();
  let t = T0;
  const sends = [];
  const executor = createBatchExecutor({
    store: createBatchRpcStore({ call: b.call }),
    postingsFor: async (u) => clone(u === "user-b" ? [7, 8].map(posting) : [1, 2, 3, 4, 5, 6].map(posting)),
    profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER }),
    boardForFor: (u) => (p) => {
      const board = Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily });
      const submit = board.submit; // the one call that reaches the (sandbox) employer
      board.submit = (...args) => { sends.push({ at: t, user: u, company: p.company }); return submit.apply(board, args); };
      return board;
    },
    now: () => t,
    sleep: async (ms) => { const until = t + ms; await new Promise((r) => setTimeout(r, 5)); if (t < until) t = until; },
    scheduler: { limits: { perPersonHour: 60, perPersonDay: 200 } },
    driveBudgetMs: 3 * MIN,
  });
  const runs = {};
  for (const u of ["user-a", "user-b"]) {
    const run = Batch.createRun({ userId: u, familyText: u, count: u === "user-b" ? 2 : 6, now: t });
    runs[u] = run.id;
    b.seed(`p-${u}`, { action: "prepare", run_id: run.id, family_text: u }, { run: clone(run) }, u);
  }
  await executor.runBatchPending();
  for (const u of ["user-a", "user-b"]) {
    const stored = Batch.restoreRun(clone(b.runs.get(runs[u]).run));
    b.seed(`a-${u}`, { action: "approve", run_id: runs[u], card_sha256: stored.cardSha256 }, null, u);
  }
  const res = await executor.runBatchPending();
  assert.deepEqual(res.map((r) => [r.intentId, r.status]), [["a-user-a", "completed"], ["a-user-b", "completed"]], "results in the order the intents came");
  const a = Batch.restoreRun(clone(b.runs.get(runs["user-a"]).run)), bb = Batch.restoreRun(clone(b.runs.get(runs["user-b"]).run));
  assert.equal(a.summary.submitted, 4, "A: one a minute inside the 3-minute budget");
  assert.equal(bb.summary.submitted, 2, "B: both sent");
  const firstB = sends.find((x) => x.user === "user-b");
  assert.equal(sends.length, 6, "every send reached the board's submit");
  assert.ok(firstB && firstB.at < T0 + MIN, `B's first send waited behind A's drive (at +${firstB && (firstB.at - T0) / MIN} min)`);
  for (const u of ["user-a", "user-b"]) {
    const mine = sends.filter((x) => x.user === u);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].at - mine[i - 1].at >= MIN, `${u}: a minute apart`);
  }
});

test("R9 drives side by side never pass one employer's limit together; a send that posted nothing gives its slot back", async () => {
  const Pace = require(path.join(root, "workers/career-browser/apply-scheduler.cjs"));
  let t = T0;
  const posted = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const pace = Pace.createApplyScheduler({
    now: () => t,
    limits: { perEmployerHour: 1 },
    submit: async (job) => {
      await gate; // both drives are on the employer's form at once
      posted.push(job.userId);
      return { posted: true, outcome: "submitted", proof: { kind: "api_receipt", ref: `r-${job.id}` } };
    },
  });
  const add = (id, userId, url) => {
    const payload = { id, url };
    const h = Pace.payloadSha256(payload);
    assert.equal(pace.enqueue({ id, runId: id, userId, company: "Acme, Inc.", url, payload, payloadSha256: h, approvalHash: h }).ok, true);
  };
  add("j1", "u-1", "https://boards.greenhouse.io/acme/jobs/1");
  add("j2", "u-2", "https://boards.greenhouse.io/acme/jobs/2");
  const both = Promise.all([pace.tick((j) => j.runId === "j1"), pace.tick((j) => j.runId === "j2")]);
  release();
  await both;
  assert.deepEqual(posted, ["u-1"], "one an hour to Acme, even with two drives in flight");
  assert.equal(pace.job("j2").state, "queued", "the second waits for Acme's next slot");

  // A send that posted nothing does not spend the employer's slot.
  const p2 = Pace.createApplyScheduler({ now: () => t, limits: { perEmployerHour: 1 }, submit: async (job) => (job.userId === "u-fail" ? { posted: false, outcome: "transient", reason: "timeout before post" } : { posted: true, outcome: "submitted", proof: { kind: "api_receipt", ref: "r" } }) });
  for (const [id, u, n] of [["f1", "u-fail", 3], ["ok1", "u-3", 4]]) {
    const payload = { id }; const h = Pace.payloadSha256(payload);
    p2.enqueue({ id, runId: id, userId: u, company: "Acme", url: `https://boards.greenhouse.io/acme/jobs/${n}`, payload, payloadSha256: h, approvalHash: h });
  }
  await p2.tick();
  assert.equal(p2.job("f1").state, "retry_wait");
  assert.equal(p2.job("ok1").state, "submitted_unconfirmed", "the failed send's Acme slot was given back");
});
