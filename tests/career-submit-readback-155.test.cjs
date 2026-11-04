"use strict";
/* JOIN-1202/1213 step: module 155's readback, verified by measured
   drive — three applications in one approved batch:
   - TestCo 1: submitted WITH a recorded employer confirmation.
   - TestCo 2: the board accepted it, NO confirmation recorded.
   - TestCo 3: the drive itself errors (the board throws at submit).
   The readback (summarizeRun + speakSummary + accountRun) must
   (1) count the confirmed submission APART from the sent-unconfirmed
   one — never merged into one "submitted" number — and
   (2) never drop the errored row: it still appears, with its error.
   Sandbox boards only; nothing submits to a real employer.
   Check: node --test tests/career-submit-readback-155.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const Portal = D("149-career-portal-apply.js");
const Batch = D("155-career-batch-apply.js");

const NOW = Date.parse("2026-10-25T16:46:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const FULL_ANSWERS = {
  work_authorization: { value: "Yes — authorized to work in the US", confirmed: true },
  sponsorship: { value: "No", confirmed: true },
  cover_note: { value: "I am excited to apply for the intern role.", confirmed: true, draft: true },
};
const ATTEST = { certify_true: { value: true, explicit: true } };
const PROFILE = {
  name: "Alex Testcase", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) }, answers: clone(FULL_ANSWERS),
};
function posting(n) {
  return {
    id: `JOB-R-${n}`, job_id: `JOB-R-${n}`, canonicalKey: `greenhouse:testco${n}:software-engineering-intern`,
    company: `TestCo ${n}`, role: "Software Engineering Intern", title: "Software Engineering Intern",
    url: `https://boards.greenhouse.io/testco${n}/jobs/${n}`, status: "open", atsFamily: "greenhouse",
    location: "Chicago, IL", posted_at: "2026-10-10",
    jd_text: "Software engineering intern role. JavaScript, testing, code review, agile team.",
  };
}

test("155 readback: confirmed counted apart from sent-unconfirmed, and the errored row appears with its error", () => {
  const log = { records: [] };
  const boardFor = (p) => {
    let b = Portal.createSandboxBoard({});
    if (p.id === "JOB-R-2") {
      b = Object.assign({}, b, {
        submit() { return { outcome: "accepted" }; },
        submissionState() { return { submitted: true, confirmationId: null }; },
      });
    }
    if (p.id === "JOB-R-3") {
      b = Object.assign({}, b, {
        submit() { const e = new Error("Target crashed (TEST)"); e.code = "DRIVER_ERROR"; throw e; },
      });
    }
    return Object.assign({}, b, { atsFamily: p.atsFamily });
  };
  const run = Batch.createRun({ userId: "u-readback-155", familyKey: "software-engineering", familyText: "software engineering", count: 3, now: NOW });
  Batch.prepareRun(run, { postings: [posting(1), posting(2), posting(3)], profile: clone(PROFILE), log, boardFor, attestations: ATTEST });
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true, "setup: the batch is approved");
  Batch.executeRun(run, { now: NOW, profile: clone(PROFILE), log, boardFor });

  const apps = Object.values(run.apps);
  const byCompany = (c) => apps.find((a) => a.company === c);
  assert.equal(byCompany("TestCo 1").stage, "submitted");
  assert.equal(byCompany("TestCo 1").confirmationId, "SBX-0001", "setup: a recorded employer confirmation");
  assert.equal(byCompany("TestCo 2").stage, "submitted");
  assert.ok(!byCompany("TestCo 2").confirmationId, "setup: sent, no confirmation recorded");
  assert.equal(byCompany("TestCo 3").stage, "stopped", "setup: the errored drive stopped the row");
  assert.ok(byCompany("TestCo 3").stop && byCompany("TestCo 3").stop.reason, "setup: the error is recorded on the row");

  // (1) the counts are separate groups, never one merged number
  const sm = Batch.summarizeRun(run);
  assert.equal(sm.confirmations.length, 1, "exactly one confirmed submission");
  assert.equal(sm.confirmations[0].company, "TestCo 1");
  assert.equal(sm.confirmations[0].confirmationId, "SBX-0001");
  assert.equal(sm.sentUnconfirmed.length, 1, "the sent-unconfirmed row is its own group");
  assert.equal(sm.sentUnconfirmed[0].company, "TestCo 2");

  // (2) the errored row is in the summary's stops, with its error
  assert.equal(sm.stops.length, 1, "the errored row is not dropped from the summary");
  assert.equal(sm.stops[0].company, "TestCo 3");
  assert.ok(sm.stops[0].code && sm.stops[0].reason, "the stop carries its code and its reason");

  // and in the spoken readback
  const lines = Batch.speakSummary(run);
  assert.equal(lines[0], "1/3 applications submitted with employer confirmations.",
    `the headline counts ONLY the confirmed one: ${lines[0]}`);
  assert.ok(lines.some((l) => l.includes("TestCo 2") && /SENT_WITHOUT_CONFIRMATION|not counted as submitted/.test(l)),
    `the sent-unconfirmed row is named as not submitted: ${lines.join(" | ")}`);
  const errLine = lines.find((l) => l.includes("TestCo 3"));
  assert.ok(errLine, `the errored row appears in the spoken readback: ${lines.join(" | ")}`);
  // Launch readiness Q3 (2026-10-26): the error is said in plain words; its code stays on the record (sm.stops above).
  assert.ok(typeof sm.stops[0].code === "string" && sm.stops[0].code.length > 0, "the record still carries the stop's code");
  // The exact sentence for the recorded code (EXECUTION_ERROR), not one any error code would match (DRIVER_ERROR says
  // "before it was submitted").
  assert.equal(sm.stops[0].code, "EXECUTION_ERROR", "the recorded stop is an execution error");
  assert.equal(errLine, "- TestCo 3 — Software Engineering Intern: it stopped with an error, so it is not counted as submitted.", `and it appears WITH its recorded error, in plain words: ${errLine}`);

  // the exactly-once accounting still holds over all three outcomes
  assert.doesNotThrow(() => Batch.assertAccounted(run), "every selected application is accounted for exactly once");
});
