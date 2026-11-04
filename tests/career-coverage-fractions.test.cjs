// COVERAGE FRACTIONS (P2, 2026-10-22) — the batch-apply run states the
// fraction that came through FIRST ("8/10 applications ready for your
// yes"), names every other selected application exactly once with its
// code and reason, says 0/0 when nothing was selected, and exposes a
// per-application field coverage {filled, total} from 149 where every
// unfilled field carries a reason. TEST persona + sandbox boards only.
// Check: node --test tests/career-coverage-fractions.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const Portal = require(path.join(root, "packages/domain/149-career-portal-apply.js"));
const Batch = require(path.join(root, "packages/domain/155-career-batch-apply.js"));

const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);
const PROFILE = {
  name: "Alex Testcase (TEST)",
  email: "alex.testcase@example.test",
  phone: "+1 000 555 0100",
  location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: {
    work_authorization: { value: "Yes", confirmed: true },
    sponsorship: { value: "No", confirmed: true },
  },
};
const posting = (n) => ({
  id: `JOB-C-${n}`, job_id: `JOB-C-${n}`, canonicalKey: `greenhouse:coverco${n}:swe-intern`,
  company: `CoverCo ${n}`, title: "Software Engineering Intern", role: "Software Engineering Intern",
  url: `https://boards.greenhouse.io/coverco${n}/jobs/${n}`, status: "open", atsFamily: "greenhouse",
});

function prepare(postings, opts = {}) {
  const run = Batch.createRun({ userId: "u-cover", familyText: "software engineering intern", count: opts.count || postings.length, now: NOW });
  Batch.prepareRun(run, Object.assign({
    postings, now: NOW, profile: PROFILE, log: { records: [] },
    boardFor: (p) => Portal.createSandboxBoard({}),
  }, opts.deps || {}));
  return run;
}

test("all ready: the first line is n/n and nothing else is named before the rest of the reply", () => {
  const run = prepare([posting(1), posting(2), posting(3)]);
  assert.equal(run.status, "awaiting_approval");
  const lines = Batch.speakSummary(run);
  assert.equal(lines[0], "3/3 applications ready for your yes.");
  assert.match(lines[1], /^Found 3 /, "the next line is the existing report — no drop lines when nothing dropped");
  assert.equal(run.summary.accounting.through, 3);
  assert.equal(run.summary.accounting.total, 3);
  Batch.assertAccounted(run);
  const prepared = run.events.find((e) => e.type === "prepared");
  assert.equal(prepared.coverage, "3/3");
  assert.equal(prepared.outcomes.length, 3);
  // field level: every field accounted, each unfilled one with its reason
  for (const key of run.selected) {
    const cov = run.apps[key].coverage;
    assert.ok(cov, "the application carries its field coverage");
    assert.equal(cov.total, 10, "the sandbox form has 10 fields");
    assert.equal(cov.filled + cov.unfilled.length, cov.total, "every field is filled or named unfilled — none goes missing");
    assert.deepEqual(cov.unfilled.map((u) => [u.field_id, u.reason]).sort(), [["certify_true", "attestation_pending_card"], ["cover_note", "needs_user_draft_confirmation"]]);
  }
});

// Launch readiness Q3 (2026-10-26): each stop is named in plain words in the reply; its code stays on the record
// (acc.outcomes below), never in the text the person reads.
test("mixed: k/n first, then each other application named exactly once, in plain words, its code on the record only", () => {
  const ps = [posting(1), posting(2), posting(3), posting(4)];
  const run = prepare(ps, { deps: {
    boardFor: (p) => p.id === "JOB-C-2" ? Portal.createSandboxBoard({ captchaAt: "open" })
      : p.id === "JOB-C-3" ? null
        : Portal.createSandboxBoard({}),
    profileFor: (p, base) => p.id === "JOB-C-4"
      ? Object.assign({}, base, { answers: { work_authorization: base.answers.work_authorization } })
      : base,
  } });
  const lines = Batch.speakSummary(run);
  assert.equal(lines[0], "1/4 applications ready for your yes.");
  const dropLines = lines.slice(1, 4);
  assert.equal(dropLines[0], "- CoverCo 2 — Software Engineering Intern: a captcha appeared, so the last step is yours.");
  assert.equal(dropLines[1], "- CoverCo 3 — Software Engineering Intern: Trainee can't reach this employer's application site from here, so nothing was filled or sent.");
  assert.equal(dropLines[2], "- CoverCo 4 — Software Engineering Intern: a required question has no confirmed fact on your profile, so I stopped instead of inventing an answer.");
  assert.ok(!/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(lines.join("\n")), `no internal code in the reply: ${lines.join(" | ")}`);
  assert.match(lines[4], /^Found 4 /);
  for (const n of [2, 3, 4]) {
    assert.equal(dropLines.filter((l) => l.includes(`CoverCo ${n} `)).length, 1, `CoverCo ${n} is named once in the coverage block`);
  }
  assert.ok(!dropLines.some((l) => l.includes("CoverCo 1 ")), "the ready one is counted, not listed as dropped");
  Batch.assertAccounted(run);
  const acc = run.summary.accounting;
  assert.deepEqual(acc.outcomes.map((o) => [o.company, o.through, o.code]), [
    ["CoverCo 1", true, null], ["CoverCo 2", false, "CAPTCHA_HANDOFF"], ["CoverCo 3", false, "BOARD_NOT_WIRED"], ["CoverCo 4", false, "UNCOVERED_QUESTION"],
  ]);
  for (const o of acc.outcomes) if (!o.through) assert.ok(o.reason && o.reason.length > 0, `${o.company} carries a reason`);
  // the awaiting_user stop still carries field coverage, with the missing answer named
  const c4 = run.apps[posting(4).canonicalKey].coverage;
  assert.ok(c4 && c4.unfilled.some((u) => u.field_id === "sponsorship" && u.reason === "no_confirmed_fact"));
  assert.equal(c4.filled + c4.unfilled.length, c4.total);
});

test("after the yes: the fraction is what was submitted", () => {
  const run = prepare([posting(1), posting(2)]);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  Batch.executeRun(run, { now: NOW, profile: PROFILE, log: { records: [] }, boardFor: () => Portal.createSandboxBoard({}) });
  const lines = Batch.speakSummary(run);
  assert.equal(lines[0], "2/2 applications submitted.");
  Batch.assertAccounted(run);
});

test("empty: 0/0, never reduced", () => {
  const run = prepare([]);
  const lines = Batch.speakSummary(run);
  assert.equal(lines[0], "0/0 applications ready for your yes.");
  assert.equal(run.events.find((e) => e.type === "prepared").coverage, "0/0");
  Batch.assertAccounted(run);
});

test("invariant: a broken run (one selected key missing, one counted twice) fails the exactly-once check", () => {
  const run = prepare([posting(1), posting(2), posting(3)]);
  const sm = JSON.parse(JSON.stringify(run.summary));
  sm.ready = [sm.ready[0], sm.ready[0]]; // key 1 twice, keys 2 and 3 gone
  sm.stops.push({ postingKey: "greenhouse:ghost:role", code: "X" }); // a key that was never selected
  const r = Batch.checkAccounted(run, sm);
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicated, [posting(1).canonicalKey]);
  assert.deepEqual(r.missing.sort(), [posting(2).canonicalKey, posting(3).canonicalKey].sort());
  assert.deepEqual(r.unknown, ["greenhouse:ghost:role"]);
  assert.throws(() => Batch.assertAccounted(run, sm), (e) => e.code === "ACCOUNTING_BROKEN");
  // and a run object whose app record vanished is named, not silently skipped
  const broken = JSON.parse(JSON.stringify(run));
  delete broken.apps[posting(2).canonicalKey];
  const acc = Batch.accountRun(broken);
  assert.equal(acc.total, 3);
  assert.equal(acc.outcomes.find((o) => o.postingKey === posting(2).canonicalKey).code, "NO_RECORD");
});
