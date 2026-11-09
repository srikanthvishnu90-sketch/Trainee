"use strict";
// WO-M fix a: the apply VM ends a required question the person has not answered exactly as the cloud runner does,
// not_submitted / needs_answers (nothing sent), the one state the database re-prepares from
// (career_apply_reprepare_on_needs_answers, supabase/migrations/20261101130000: state 'not_submitted' and reason exactly
// 'needs_answers'). Before this, the VM wrote needs_user / "missing_required_answer: <question>", which the trigger never
// sees, so the posting stayed stopped. The worker is driven end to end (prepare, the engine, settle) with an in-memory RPC
// and a stand-in engine; no browser, no database, nothing leaves the process.
//   node --test tests/career-apply-vm-needs-answers.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");
const { applyOne, payloadHash } = require("../workers/career-browser/parallel-apply.cjs");
const { startMockAts } = require("./fixtures/mock-ats-server.cjs");
let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const RESUME = Buffer.from("%PDF-1.4\n% TEST resume for the apply VM\n");
const RSHA = crypto.createHash("sha256").update(RESUME).digest("hex");
const URL_ = "https://boards.greenhouse.io/acme/jobs/123";
function row() {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000001", job_id: "greenhouse:acme:123", company: "Acme", url: URL_, resume_sha256: RSHA,
    fields: [{ label: "First Name", value: "Test", factId: "f1" }, { label: "Email", value: "test.person@example.invalid", factId: "f3" }] };
  const h = queueHash(payload);
  return { id: "11111111-1111-4111-8111-111111111111", lease_token: "22222222-2222-4222-8222-222222222222", url: URL_, user_id: payload.user_id, payload, payload_hash: h, approval_hash: h, approval_id: "33333333-3333-4333-8333-333333333333" };
}
function worker(engine) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "career_apply_vm_claim") return calls.filter((c) => c.name === name).length === 1 ? [row()] : [];
    if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: RSHA, b64: RESUME.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    return {};
  };
  const w = createWorker({ rpc, browser: {}, applyOne: engine, allowHosts: ["boards.greenhouse.io"], evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-na-")), log: () => {} });
  // The VM's own loop for one row: claim, then prepare -> engine -> settle.
  const run = async () => { assert.equal(await w.tick(), 1); while (w.inflight.size) await new Promise((r) => setTimeout(r, 5)); };
  return { run, completed: () => calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args) };
}

test("a required question with no confirmed answer ends not_submitted / needs_answers, with the questions in the form's own words", async () => {
  const seen = [];
  const engine = async (_browser, pool) => {
    seen.push(pool);
    return { status: "not_submitted", reason: "missing_required_answer", field: "Why do you want to work at Acme?", attempts: 1, ms: 5,
      needs: [{ label: "Why do you want to work at Acme?", reason: "no_confirmed_answer" }, { label: "Which office?", reason: "no_confirmed_answer", options: ["London", "Berlin"] }] };
  };
  const h = worker(engine);
  await h.run();
  assert.equal(seen.length, 1, "the engine ran once, on the approved application");
  const done = h.completed();
  assert.equal(done.length, 1);
  const c = done[0];
  assert.equal(c.p_state, "not_submitted");
  assert.equal(c.p_reason, "needs_answers", "the reason is exactly the one the re-prepare trigger matches");
  assert.equal(c.p_evidence.nothing_sent, true);
  assert.deepEqual(c.p_evidence.fields, ["Why do you want to work at Acme?", "Which office?"]);
  assert.deepEqual(c.p_evidence.questions, [{ label: "Why do you want to work at Acme?" }, { label: "Which office?", options: ["London", "Berlin"] }]);
  assert.ok(!JSON.stringify(c.p_evidence).includes("test.person@example.invalid"), "no answer value in the evidence");
});

test("a question that could not be set and read back stays needs_user / field_not_filled (a fill failure, not a missing answer)", async () => {
  const engine = async () => ({ status: "not_submitted", reason: "field_not_filled", field: "Start date", attempts: 1, ms: 5, needs: [{ label: "Start date", reason: "readback_mismatch" }] });
  const h = worker(engine);
  await h.run();
  const [c] = h.completed();
  assert.equal(c.p_state, "needs_user");
  assert.equal(c.p_reason, "field_not_filled: Start date");
});

// The real engine on the LOCAL mock Greenhouse form (tests/fixtures/mock-ats-server.cjs): its unanswered required questions
// come back with the form's own options, which the VM passes on as the questions to ask.
test("the engine's needs carry the form's own options (real engine, local mock form, nothing submitted)", { skip }, async () => {
  const mock = await startMockAts();
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  try {
    const resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vm-na-r-")), "test-person-resume.pdf");
    fs.writeFileSync(resume, RESUME);
    const p = { id: "gh-na", ats: "greenhouse", url: `${mock.base}/greenhouse/na1`, facts: { first_name: "Test", last_name: "Person", email: "test.person@example.invalid" }, answers: {},
      resume: { path: resume, sha256: RSHA, preparedWithSha256: RSHA } };
    p.approval = { approval_id: "appr-gh-na", hash: payloadHash(p) };
    const r = await applyOne(browser, p, { retries: 0 });
    assert.equal(r.status, "not_submitted");
    assert.equal(r.reason, "missing_required_answer");
    const auth = r.needs.find((n) => /authorized to work/.test(n.label));
    assert.deepEqual(auth.options, ["Yes", "No"]);
    assert.equal(mock.submissions.some((s) => s.job === "na1"), false, "nothing was submitted");
  } finally { await browser.close(); await mock.close(); }
});
