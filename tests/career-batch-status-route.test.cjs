// MUSE-F-002 (audit 2026-10-22, P0): a plain-words batch status ask fell to the generic fallback. The apply reply itself
// says "ask me for the batch status", and live on 2026-10-20 and 2026-10-22 both "what's the batch status" and "where is
// my batch" got "I didn't catch that…". PR #145 defined handleBatchStatus but never dispatched it; this wires it:
// 142 dispatches it after handleBatchApply, the host carries the worker-written run record for the turn
// (ctx.batchRunRecord, never persisted), and the handler reads that record by the thread's batch id.
// The guard (the fixer inventory's spec): the recorded words against a prepared run -> its true summary, not the
// fallback; the worker's record outranks the thread's skeleton; a queued skeleton says queued; no batch says so; a
// second persona never sees the first's batch; a status ask approves, prepares and submits nothing; "Approve batch …"
// and a bare "yes" are not status asks. On the base (348c2d4a) the status asks fall to the fallback.
// TEST persona and sandbox boards only. Check: node --test tests/career-batch-status-route.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const Portal = D("149-career-portal-apply.js");
const Batch = D("155-career-batch-apply.js");
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));

const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);
const USER = "user-status-test", USER_B = "user-status-test-b";
const PROFILE = {
  name: "Alex Testcase (TEST)", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: { work_authorization: { value: "Yes — authorized to work in the US", confirmed: true }, sponsorship: { value: "No", confirmed: true } },
};
const MASTER = { basics: { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test" },
  facts: [{ id: "F-T-001", kind: "skill", text: "JavaScript and Node.js development", confirmed: true }, { id: "F-T-003", kind: "education", text: "Computer Science student", confirmed: true }] };
const ATTEST = { certify_true: { value: true, explicit: true } };
const FAMS = ["greenhouse", "lever", "ashby"];
const posting = (n) => ({ id: `JOB-S-${n}`, job_id: `JOB-S-${n}`, canonicalKey: `${FAMS[n % 3]}:statusco${n}:software-engineering-intern`, company: `StatusCo ${n}`,
  role: "Software Engineering Intern", title: "Software Engineering Intern", url: `https://boards.example.test/statusco${n}/jobs/${n}`, status: "open", atsFamily: FAMS[n % 3],
  location: "Chicago, IL", posted_at: "2026-10-18", jd_text: "Software engineering intern role at a test company. JavaScript, testing, code review." });
const MARKET = [1, 2, 3, 4, 5].map(posting);
const boardFor = (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily });
const ASKS = ["what's the batch status", "where is my batch"];
const FALLBACK = /I didn't catch that|I'm Trainee, a career agent: I find roles/;

const seam = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
});
function prepared(log) {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "thread-status-1", now: NOW, snapshot: null, profile: MASTER, postings: MARKET });
  ctx.portalProfile = PROFILE;
  ctx.batchDeps = { log, boardFor, attestations: ATTEST };
  const turn = seam.runTurn("apply to 3 software engineering intern roles", ctx);
  assert.equal(turn.resultStatus, "awaiting_approval", turn.reply);
  return seam.extractSnapshot(ctx);
}
const turnOn = (message, o = {}) => {
  const ctx = seam.createTurnCtx({ userId: o.user || USER, threadId: o.thread || "thread-status-2", now: NOW, snapshot: o.snapshot || null, profile: MASTER, postings: [], batchRunRecord: o.record || null });
  ctx.portalProfile = PROFILE;
  if (o.log) ctx.batchDeps = { log: o.log, boardFor, attestations: ATTEST };
  return { out: seam.runTurn(message, ctx), ctx };
};

test("F-002/1 the recorded words against a prepared run speak its true summary, never the fallback, and change nothing", () => {
  const log = { records: [] };
  const snap = prepared(log);
  const expected = Batch.speakSummary(Batch.restoreRun(snap.stores.batchApplyState)).join("\n");
  for (const ask of ASKS) {
    const { out, ctx } = turnOn(ask, { snapshot: snap, log });
    assert.doesNotMatch(out.reply, FALLBACK, `"${ask}" fell to the fallback`);
    assert.equal(out.intent, "career_batch_apply", ask);
    assert.equal(out.resultStatus, "awaiting_approval", ask);
    assert.ok(out.reply.startsWith(expected), `"${ask}" speaks the run's own summary (the host may add its closing line): ${out.reply}`);
    assert.equal((out.result && out.result.sends) || 0, 0, "a status ask sends nothing");
    assert.deepEqual(ctx.batchApplyState, snap.stores.batchApplyState, "a status ask leaves the run exactly as it was");
  }
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "a status ask submits nothing");
});

test("F-002/2 the worker-written record outranks the thread's queued skeleton; a skeleton alone says queued; no batch says so", () => {
  const log = { records: [] };
  const snap = prepared(log);
  const preparedRun = snap.stores.batchApplyState;
  const skeleton = Batch.serializeRun(Object.assign(Batch.createRun({ userId: USER, familyText: "software engineering intern", count: 3, now: NOW }), { status: "queued_prepare" }));
  const skeletonSnap = { ...snap, stores: { ...snap.stores, batchApplyState: skeleton } };
  const record = { runId: preparedRun.id, status: "awaiting_approval", summary: preparedRun.summary || null, run: preparedRun };
  const fromRecord = turnOn(ASKS[0], { snapshot: skeletonSnap, record }).out;
  assert.equal(fromRecord.resultStatus, "awaiting_approval", fromRecord.reply);
  assert.ok(fromRecord.reply.startsWith(Batch.speakSummary(Batch.restoreRun(preparedRun)).join("\n")), fromRecord.reply);
  const queued = turnOn(ASKS[1], { snapshot: skeletonSnap }).out;
  assert.equal(queued.resultStatus, "queued", queued.reply);
  assert.match(queued.reply, /with the browser worker being prepared — nothing has been filled or submitted yet/);
  const none = turnOn(ASKS[0]).out;
  assert.equal(none.resultStatus, "awaiting_user", none.reply);
  assert.match(none.reply, /You don't have a batch in flight right now/);
  assert.doesNotMatch(none.reply, FALLBACK);
});

test("F-002/3 a second persona never reads the first's batch", () => {
  const snap = prepared({ records: [] });
  assert.throws(() => turnOn(ASKS[0], { user: USER_B, snapshot: snap }), /career_snapshot_owner_mismatch/, "another account's snapshot is refused by the host");
  const b = turnOn(ASKS[0], { user: USER_B }).out;
  assert.match(b.reply, /You don't have a batch in flight right now/);
});

test("F-002/4 approvals stay the card's: 'Approve batch …' and a bare 'yes' are not status asks; a status ask approves nothing", () => {
  const log = { records: [] };
  const snap = prepared(log);
  for (const m of [`Approve batch ${snap.stores.batchApplyState.id}`, "yes"]) {
    const { out } = turnOn(m, { snapshot: snap, log });
    assert.notEqual(out.resultStatus, "awaiting_approval", `"${m}" was answered as a status read: ${out.reply}`);
  }
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "nothing submitted without the structured approval");
});

test("F-002/5 the deployed composition: the generated bundles carry the dispatch, and the handler reads the run record into the turn", async () => {
  for (const b of ["router_core.career.js"]) {
    const src = fs.readFileSync(path.join(root, "supabase/functions/_shared", b), "utf8");
    assert.match(src, /const batchStatus = handleBatchStatus\(text, c\);\s*if \(batchStatus\) return batchStatus;/, `${b} dispatches the status route`);
  }
  const career = await import(path.join(root, "supabase/functions/_shared/router_core.career.js"));
  const host = CareerHost.createCareerHost(Object.fromEntries(["CareerAccess", "CareerOnboarding", "CareerRouter", "CareerDoorstep", "CareerReply", "CareerContainment"].map((n) => [n, career[n]])));
  const out = host.runTurn(ASKS[0], host.createTurnCtx({ userId: USER, threadId: "thread-bundle", now: NOW, snapshot: null, profile: MASTER, postings: [] }));
  assert.doesNotMatch(out.reply, FALLBACK, "the shipped career bundle answers the status ask");
  const hostSrc = fs.readFileSync(path.join(root, "supabase/functions/_shared/career_host.js"), "utf8");
  assert.match(hostSrc, /if \(o\.batchRunRecord && typeof o\.batchRunRecord === "object"\) ctx\.batchRunRecord = o\.batchRunRecord;/);
  assert.ok(!CareerHost.STATE_KEYS.includes("batchRunRecord"), "the record is per-turn, never persisted");
  const h = fs.readFileSync(path.join(root, "supabase/functions/agent-chat/handler-career.ts"), "utf8");
  assert.match(h, /stores\?\.batchApplyState\?\.id/);
  assert.match(h, /persistence\.readBatchRun\(\{ userId: user\.id, runId: batchRunId \}\)/, "read by the person's own id: one account never reads another's run");
  assert.match(h, /createTurnCtx\(\{[^}]*batchRunRecord \}\)/);
});
