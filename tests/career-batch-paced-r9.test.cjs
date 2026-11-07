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
  return { call, intents, runs, ledgers, seed: (id, binding, request) => intents.set(id, { userId: USER, binding, request, state: "queued" }) };
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
