"use strict";
// S2 follow-up (2026-11-08, batch-executor.cjs pacedSubmit): a stop that may come after the click is never read as
// "nothing was posted". EXECUTION_ERROR (the drive threw, the submit included) and any code not known to come before
// the click are posted:null: the pace slot stays spent and the posting is never sent again on its own. A stop known to
// come before the click (149's submit gate, the prepare drive's own) still gives the slot back.
// On the REAL 155 and 149 over 149's sandbox board, the batch RPCs' in-memory shape and a virtual clock (as
// tests/career-batch-paced-r9.test.cjs).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");
const Batch = require(path.join(root, "packages/domain/155-career-batch-apply.js"));
const Portal = require(path.join(root, "packages/domain/149-career-portal-apply.js"));
const { createBatchExecutor, createBatchRpcStore, postedForStop } = require(path.join(root, "workers/career-browser/batch-executor.cjs"));

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


// Two postings at one employer, one send an hour there. The board's submit reaches the employer, then throws.
function acmeWorld(throwAfterPost) {
  const b = backend();
  let t = T0;
  const reached = [];
  const titles = ["Software Engineering Intern", "Software Engineering Intern, Backend"];
  const postings = [1, 2].map((i) => Object.assign(posting(i), { company: "Acme", role: titles[i - 1], title: titles[i - 1],
    canonicalKey: `greenhouse:acme:${9000 + i}`, url: `https://boards.greenhouse.io/acme/jobs/${9000 + i}` }));
  const executor = createBatchExecutor({
    store: createBatchRpcStore({ call: b.call }),
    postingsFor: async () => clone(postings),
    profileFor: async () => ({ profile: PROFILE, profileMaster: MASTER }),
    boardForFor: () => (p) => {
      const board = Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily });
      const submit = board.submit;
      board.submit = (...args) => {
        reached.push(p.url);
        const r = submit.apply(board, args);
        if (throwAfterPost && reached.length === 1) throw new Error("socket hang up after the form was posted");
        return r;
      };
      return board;
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    scheduler: { limits: { perPersonHour: 60, perPersonDay: 200, perEmployerHour: 1 } },
    driveBudgetMs: 10 * MIN,
  });
  return { b, executor, clock: () => t, reached, postings };
}

test("a throw after the click is posted:null: the employer's slot stays spent and the next Acme send waits its hour", async () => {
  const w = acmeWorld(true);
  const { run } = await prepareAndApprove(w, "acme", w.postings);
  const stopped = Object.values(run.apps).filter((a) => a.stop && a.stop.code === "EXECUTION_ERROR");
  assert.equal(stopped.length, 1, "the first send stopped EXECUTION_ERROR after reaching the employer");
  assert.equal(w.reached.length, 1, "nothing else reached Acme: the uncertain send kept Acme's slot for the hour");
  assert.equal(run.summary.submitted, 0);
  assert.equal(run.summary.deferred.filter((d) => d.code === "PACE_DEFERRED").length, 1, "the second Acme posting waits, approved, at its doorstep");
});

test("control: with a clean first send, the second Acme posting also waits its hour (the limit itself)", async () => {
  const w = acmeWorld(false);
  const { run } = await prepareAndApprove(w, "acme", w.postings);
  assert.equal(w.reached.length, 1);
  assert.equal(run.summary.submitted, 1);
});

test("postedForStop: only a stop known to come before the click says nothing was posted", () => {
  for (const code of ["EXECUTION_ERROR", "UNKNOWN_OUTCOME", "NO_RESULT", "RECONCILE_REQUIRED", "ALREADY_SUBMITTED", "SUBMIT_BLOCKED", "SOME_NEW_CODE", "submitted", ""]) {
    assert.equal(postedForStop(code), null, code);
  }
  for (const code of ["BOARD_NOT_WIRED", "UNCOVERED_QUESTION", "DRIVER_ERROR", "APPROVAL_PAYLOAD_MISMATCH", "INCOMPLETE_PAYLOAD", "ATTESTATION_REQUIRED",
    "DUPLICATE_APPLICATION", "PORTAL_REFUSING", "APPROVAL_REQUIRED", "NO_DOORSTEP", "ALREADY_APPLIED_BY_USER", "JOB_CLOSED", "KNOCKOUT_UNMET", "doorstep"]) {
    assert.equal(postedForStop(code), false, code);
  }
});
