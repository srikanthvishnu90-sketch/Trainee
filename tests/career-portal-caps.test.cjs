// NO LIMITS (owner, 2026-10-27: D-MS-2 "no product volume cap"; 19:55 CDT "no person limit, never set a limit").
// Module 149 sets no volume number of its own: the Spec 2 §6.4 caps (15/day, 5/vendor/day, 1/company/30 days; MI-110)
// are removed. What this file pins now:
//   - no count of submissions, today, per vendor or per company, ever stops a drive (the old caps' cases now submit);
//   - the exact same posting is never submitted twice for one person (DUPLICATE_APPLICATION), at the doorstep and again
//     at click time;
//   - the employer's site refusing (a rate limit at open: HTTP 429 / 503 Retry-After) stops that drive before any fill
//     (PORTAL_REFUSING), is kept in the ledger, holds every later drive to that site until the time it asked for, and
//     lets them go after; other sites are never held by it;
//   - capReport says the truth: no volume number (volumeLimit null), the gates enforced.
// FAIL-FIRST: on the base (the caps enforced) the no-cap cases are CAP_REACHED and the refusal cases have no gate.
// Check: node --test tests/career-portal-caps.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const Portal = require(path.join(root, "packages/domain/149-career-portal-apply.js"));

const USER = "user-alex-test";
const NOW = "2026-10-15T12:00:00Z";
const POSTING = {
  id: "JOB-GH-001",
  canonicalKey: "greenhouse:testsystems:software-engineering-intern",
  company: "TEST Systems",
  role: "Software Engineering Intern",
  url: "https://boards.greenhouse.io/testsystems/jobs/001",
  status: "open",
  atsFamily: "greenhouse",
};
const PROFILE = {
  name: "Alex Testcase (TEST)",
  email: "alex.testcase@example.test",
  phone: "+1 000 555 0100",
  location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: {
    work_authorization: { value: "Yes — authorized to work in the US", confirmed: true },
    sponsorship: { value: "No", confirmed: true },
    cover_note: { value: "I am excited to apply to TEST Systems for the intern role.", confirmed: true, draft: true },
  },
};
const ATT = { certify_true: { value: true, explicit: true } };
const submitted = (over = {}) => Object.assign({
  userId: USER, canonicalKey: `greenhouse:otherco-${Math.random().toString(36).slice(2, 9)}:role`,
  status: "submitted", timestamp: "2026-10-15T08:00:00Z", vendor: "greenhouse", company: "Other Co",
}, over);
const logOf = (records) => ({ records });
function sandboxSession(boardOver = {}) {
  const board = Portal.createSandboxBoard(boardOver);
  const session = Portal.createPortalSession({ userId: USER, board });
  return { board, session };
}
const drive = (session, over = {}) => Portal.runApply(session, Object.assign({
  posting: POSTING, profile: PROFILE, log: logOf([]), now: NOW,
  attestations: ATT, approval: { approvedByUser: true, approvalRef: "owner-batch-caps" },
}, over));

test("NO LIMITS: capReport says there is no volume number; the gates it reports are enforced", () => {
  const { session } = sandboxSession();
  const r = Portal.runApply(session, { posting: POSTING, profile: PROFILE, log: logOf([]), now: NOW });
  assert.equal(r.capReport.decisionPending, false);
  assert.equal(r.capReport.enforced, true);
  assert.equal(r.capReport.volumeLimit, null);
  assert.equal(r.capReport.specDefaults, undefined, "no decided numbers remain");
  assert.equal(r.capReport.remaining, undefined, "nothing is counted down");
  assert.equal(Portal.SPEC_CAPS, undefined, "the caps constant is gone");
});

test("NO LIMITS: 200 submissions today, 50 of them to this vendor and one to this company yesterday — the drive still submits", () => {
  const records = Array.from({ length: 200 }, (_, i) => submitted({ vendor: i < 50 ? "greenhouse" : "lever", company: `Other Co ${i}` }));
  records.push(submitted({ company: "TEST Systems", canonicalKey: "greenhouse:testsystems:other-role", timestamp: "2026-10-14T12:00:00Z" }));
  const { board, session } = sandboxSession();
  const r = drive(session, { log: logOf(records) });
  assert.equal(r.resultStatus, "completed", JSON.stringify({ code: r.code, reason: r.reason }));
  assert.equal(board.calls.submit, 1);
  assert.equal(r.capReport.counts.today, 200, "counted for the record, never compared with a number");
});

test("NO LIMITS: the exact same posting already submitted is never submitted again (DUPLICATE_APPLICATION, zero clicks)", () => {
  const records = [submitted({ canonicalKey: POSTING.canonicalKey, company: "TEST Systems" })];
  const { board, session } = sandboxSession();
  const r = drive(session, { log: logOf(records) });
  assert.equal(r.resultStatus, "blocked");
  assert.equal(r.code, "DUPLICATE_APPLICATION");
  assert.equal(board.calls.submit, 0);
  // Another posting at the same company the same day is not a duplicate.
  const other = Object.assign({}, POSTING, { canonicalKey: "greenhouse:testsystems:data-intern", url: "https://boards.greenhouse.io/testsystems/jobs/002" });
  const b = sandboxSession();
  const r2 = drive(b.session, { log: logOf(records), posting: other });
  assert.equal(r2.resultStatus, "completed", JSON.stringify({ code: r2.code }));
});

test("NO LIMITS: a site that refuses at open (429, Retry-After 120) stops that drive before any fill, holds later drives to that site until then, and lets them go after", () => {
  const log = logOf([]);
  const a = sandboxSession({ rateLimited: { retryAfterS: 120 } });
  const r = drive(a.session, { log });
  assert.equal(r.resultStatus, "blocked");
  assert.equal(r.code, "PORTAL_REFUSING");
  assert.equal(r.until, "2026-10-15T12:02:00.000Z", "as long as the site asked");
  assert.equal(a.board.calls.fill, 0, "nothing was filled");
  assert.equal(a.board.calls.submit, 0);
  const kept = log.records.filter((x) => x.status === "portal_refused");
  assert.equal(kept.length, 1, "the refusal is kept in the ledger");
  assert.equal(kept[0].host, "boards.greenhouse.io");
  // A minute later the same site is still held, without opening it again.
  const b = sandboxSession();
  const rb = drive(b.session, { log, now: "2026-10-15T12:01:00Z" });
  assert.equal(rb.code, "PORTAL_REFUSING");
  assert.equal(b.board.calls.open, 0, "a held site is not even opened");
  // Another site is never held by it.
  const lever = Object.assign({}, POSTING, { canonicalKey: "lever:testsystems:intern", url: "https://jobs.lever.co/testsystems/001", atsFamily: "lever" });
  const leverBoard = Object.assign(Portal.createSandboxBoard({}), { atsFamily: "lever" });
  const c = { board: leverBoard, session: Portal.createPortalSession({ userId: USER, board: leverBoard }) };
  const rc = drive(c.session, { log, posting: lever, now: "2026-10-15T12:01:00Z" });
  assert.equal(rc.resultStatus, "completed", JSON.stringify({ code: rc.code, reason: rc.reason }));
  // After the time it asked for, the same site goes on.
  const d = sandboxSession();
  const rd = drive(d.session, { log, now: "2026-10-15T12:02:01Z" });
  assert.equal(rd.resultStatus, "completed", JSON.stringify({ code: rd.code }));
  assert.equal(d.board.calls.submit, 1);
});

test("NO LIMITS: a refusal with no Retry-After holds the site 30 s, then 60 s on the next refusal in a row", () => {
  const log = logOf([]);
  const r1 = drive(sandboxSession({ rateLimited: {} }).session, { log });
  assert.equal(r1.until, "2026-10-15T12:00:30.000Z");
  const r2 = drive(sandboxSession({ rateLimited: {} }).session, { log, now: "2026-10-15T12:00:31Z" });
  assert.equal(r2.until, "2026-10-15T12:01:31.000Z");
});

test("NO LIMITS: day boundary and old submissions change nothing — the drive submits", () => {
  const records = Array.from({ length: 15 }, () => submitted({ timestamp: "2026-10-14T23:30:00Z" }));
  const { board, session } = sandboxSession();
  const r = drive(session, { log: logOf(records) });
  assert.equal(r.resultStatus, "completed");
  assert.equal(board.calls.submit, 1);
});

test("NO LIMITS: submitDoorstep re-checks at click time — the same posting submitted, or the site refusing, since the doorstep refuses before arming; a ledger of hundreds does not", () => {
  const prepare = (log) => {
    const s = sandboxSession();
    const prepared = Portal.runApply(s.session, { posting: POSTING, profile: PROFILE, log, now: NOW, attestations: ATT });
    assert.equal(prepared.resultStatus, "prepared");
    return { ...s, prepared };
  };
  const click = (s, log) => Portal.submitDoorstep(s.session, { approvedByUser: true, approvalRef: "owner-batch-caps", payloadSha256: s.prepared.doorstep.payloadSha256 }, { log, now: NOW, posting: POSTING });
  // hundreds submitted since: still clicks
  const l1 = logOf([]); const s1 = prepare(l1);
  for (let i = 0; i < 300; i += 1) l1.records.push(submitted());
  assert.equal(click(s1, l1).resultStatus, "completed");
  assert.equal(s1.board.calls.submit, 1);
  // the same posting submitted since: refused
  const l2 = logOf([]); const s2 = prepare(l2);
  l2.records.push(submitted({ canonicalKey: POSTING.canonicalKey, company: "TEST Systems" }));
  const r2 = click(s2, l2);
  assert.equal(r2.code, "DUPLICATE_APPLICATION");
  assert.equal(s2.board.calls.submit, 0);
  // the site refusing since: refused, until its time
  const l3 = logOf([]); const s3 = prepare(l3);
  Portal.recordRefusal(l3, POSTING, s3.board, NOW, 60, "rate_limited", USER);
  const r3 = click(s3, l3);
  assert.equal(r3.code, "PORTAL_REFUSING");
  assert.equal(s3.board.calls.submit, 0);
});
