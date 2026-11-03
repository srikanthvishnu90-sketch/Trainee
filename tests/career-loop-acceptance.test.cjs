// LOOP ACCEPTANCE (tier 2 rehearsal) — the owner's done-test for the
// apply loop (2026-10-15): ONE message, "apply to 15 <role-family>
// roles", and Upmore itself runs discover -> dedupe -> screen ->
// tailor -> batch approval -> portal drives inside the caps ->
// confirmations -> per-application report. Graded on END STATES
// (employer-shaped confirmations and named stops), never stage claims.
//
// Fixture market: 20 postings in one family — 15 clean-eligible in the
// selected window (one of them stops on an uncovered required question,
// one on a staged captcha), 1 duplicate, 1 license-knockout, 1 closed,
// 2 eligible beyond the named count. TEST persona + sandbox boards
// only; no real portal is opened by this suite, ever.
// Check: node --test tests/career-loop-acceptance.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const Batch = require(path.join(root, "packages/domain/155-career-batch-apply.js"));
const Portal = require(path.join(root, "packages/domain/149-career-portal-apply.js"));

const USER = "user-alex-test";
const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);

const PROFILE = {
  name: "Alex Testcase (TEST)",
  email: "alex.testcase@example.test",
  phone: "+1 000 555 0100",
  location: "Chicago, IL",
  resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) },
  answers: {
    work_authorization: { value: "Yes — authorized to work in the US", confirmed: true },
    sponsorship: { value: "No", confirmed: true },
    cover_note: { value: "I am excited to apply for the intern role.", confirmed: true, draft: true },
  },
};
// 122-shaped master profile (facts only — nothing a knockout needs).
const MASTER = {
  basics: { name: "Alex Testcase (TEST)", email: "alex.testcase@example.test" },
  facts: [
    { id: "F-T-001", kind: "skill", text: "JavaScript and Node.js development", confirmed: true },
    { id: "F-T-002", kind: "experience", text: "Built web applications as a student developer", confirmed: true },
    { id: "F-T-003", kind: "education", text: "Computer Science student", confirmed: true },
  ],
};
const ATTEST = { certify_true: { value: true, explicit: true } };

const FAMS = [
  { atsFamily: "greenhouse", urlFor: (co, n) => `https://boards.greenhouse.io/${co}/jobs/${n}` },
  { atsFamily: "lever", urlFor: (co, n) => `https://jobs.lever.co/${co}/${n}` },
  { atsFamily: "ashby", urlFor: (co, n) => `https://jobs.ashbyhq.com/${co}/${n}` },
];
// The market spreads across ATS families (a realistic market). Since the
// owner's NO LIMITS rule (2026-10-27) 149 has no per-day, per-vendor or
// per-company cap; scenario 2 pins that 13 earlier submissions today stop
// nothing, and that only a site's own refusal defers an application.
function posting(n, over = {}) {
  const fam = FAMS[n % 3];
  const co = `testco${n}`;
  return Object.assign({
    id: `JOB-T-${String(n).padStart(2, "0")}`,
    job_id: `JOB-T-${String(n).padStart(2, "0")}`,
    canonicalKey: `${fam.atsFamily}:${co}:software-engineering-intern`,
    company: `TestCo ${n}`,
    role: "Software Engineering Intern",
    title: "Software Engineering Intern",
    url: fam.urlFor(co, n),
    status: "open",
    atsFamily: fam.atsFamily,
    location: "Chicago, IL",
    posted_at: "2026-10-10",
    jd_text: "Software engineering intern role at a test company. JavaScript, testing, code review, agile team.",
  }, over);
}

const MARKET = [
  posting(1), posting(2), posting(3), posting(4), posting(5), posting(6),
  posting(7), // uncovered: its board asks a required question with no confirmed fact
  posting(8), posting(9), posting(10),
  posting(11), // captcha staged at open
  posting(12), posting(13), posting(14), posting(15),
  posting(16, { // duplicate of posting 3 on another board: same opening
    id: "JOB-T-16", job_id: "JOB-T-16",
    canonicalKey: "lever:testco3:software-engineering-intern",
    company: "TestCo 3", url: "https://jobs.lever.co/testco3/16", atsFamily: "lever",
  }),
  posting(17, { knockouts: [{ type: "license", requirement: "an active CPA license", tokens: ["cpa"] }] }),
  posting(18, { status: "closed" }),
  posting(19), posting(20), // eligible, beyond the named count
];

function boardFor(p) {
  // The sandbox board is Greenhouse-SHAPED (its field set), but a board
  // adapter declares the family it serves — 149 refuses a board whose
  // family differs from the posting's (BOARD_POSTING_MISMATCH). The real
  // 150 adapter declares the family of the board it drives; the test
  // double declares the same contract here.
  const fam = { atsFamily: p.atsFamily };
  if (p.id === "JOB-T-11") return Object.assign({}, Portal.createSandboxBoard({ captchaAt: "open" }), fam);
  if (p.id === "JOB-T-07") {
    const base = Portal.createSandboxBoard({});
    return Object.assign({}, base, fam, {
      form() {
        const f = base.form();
        f.fields = f.fields.concat([{ field_id: "start_date", label: "Earliest start date", kind: "screening", question_key: "start_date", required: true }]);
        return f;
      },
    });
  }
  return Object.assign({}, Portal.createSandboxBoard({}), fam);
}

function makeDeps(log, extra = {}) {
  const tracked = [];
  const deps = Object.assign({
    postings: MARKET, profile: PROFILE, profileMaster: MASTER,
    log, now: NOW, attestations: ATTEST, boardFor,
    track: (r) => tracked.push(r),
  }, extra);
  return { deps, tracked };
}
const newRun = () => Batch.createRun({ userId: USER, familyText: "software engineering intern", count: 15, now: NOW });

// ---------------- J7: the exact message shapes ----------------
test("parse: the owner's message shapes resolve to count + family", () => {
  assert.deepEqual(Batch.parseApplyAsk("apply to 15 investment banking intern roles"), { count: 15, familyText: "investment banking intern", unit: "roles" });
  assert.equal(Batch.parseApplyAsk("apply to 15 software engineering roles").familyText, "software engineering");
  assert.equal(Batch.parseApplyAsk("apply to 15 nursing roles").familyText, "nursing");
  assert.equal(Batch.parseApplyAsk("apply for 15 data analyst jobs").count, 15);
  assert.equal(Batch.parseApplyAsk("apply to fifteen nursing roles").count, 15);
  assert.equal(Batch.parseApplyAsk("Apply to 15 Healthcare Roles").count, 15);
});

test("parse: count-less and non-apply asks are NOT claimed by this intent", () => {
  assert.equal(Batch.parseApplyAsk("apply to nursing roles"), null);
  assert.equal(Batch.parseApplyAsk("find me 15 nursing roles"), null);
  assert.equal(Batch.parseApplyAsk("apply to 15 roles"), null);
  assert.equal(Batch.parseApplyAsk("show me software engineering roles"), null);
  assert.equal(Batch.parseApplyAsk("tailor my resume for 15 roles"), null);
});

// ---------------- Scenario 1: the full trajectory ----------------
test("loop: 15 requested -> 13 submitted-confirmed, every other outcome named", () => {
  const log = { records: [] };
  const { deps, tracked } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);

  // found -> dedupe -> screen
  assert.equal(run.found, 20);
  assert.equal(run.duplicatesRemoved, 1, "the cross-board duplicate merged");
  assert.deepEqual(run.screenedOut.map((x) => x.code).sort(), ["JOB_CLOSED", "KNOCKOUT_UNMET"]);
  assert.equal(run.eligible, 17);
  assert.equal(run.selected.length, 15);

  // doorsteps + the card
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.summary.doorstep, 13, "13 of the selected reached the final review screen");
  assert.ok(run.card && run.card.type === "batch_approval");
  assert.equal(run.card.items.length, 13, "the card carries the 13 doorstep-ready applications");
  assert.ok(run.cardSha256, "the card is hash-bound (MI-116 set integrity)");

  // the two in-window stops are already named BEFORE any approval
  const stopsAtCard = Object.fromEntries(run.summary.stops.map((x) => [x.company, x.code]));
  assert.equal(stopsAtCard["TestCo 7"], "UNCOVERED_QUESTION");
  assert.equal(stopsAtCard["TestCo 11"], "CAPTCHA_HANDOFF");
  // the uncovered stop carries 149's own asks — the question is named, not hidden
  const unc = run.apps[Batch.postingKeyOf(MARKET[6])];
  assert.equal(unc.stop.code, "UNCOVERED_QUESTION");
  assert.ok((unc.stop.asks || []).some((a) => a.field_id === "start_date"), "the uncovered field is named");

  // count overflow deferred, not dropped
  assert.deepEqual(run.deferred.map((x) => x.code), ["COUNT_DEFERRED", "COUNT_DEFERRED"]);

  // one yes approves the set
  const ap = Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 });
  assert.equal(ap.ok, true);
  assert.equal(ap.approved, 13);

  // execution: employer-shaped confirmations, tracker writes, cap log
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 13);
  assert.equal(run.summary.confirmations.length, 13);
  for (const c of run.summary.confirmations) assert.match(c.confirmationId, /^SBX-\d{4}$/, "sandbox confirmation id");
  assert.equal(tracked.length, 13, "every submission wrote a tracker record");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 13, "the submission log (the exactly-once source) holds all 13");
  // the report speaks the whole trajectory
  const spoken = Batch.speakSummary(run).join("\n");
  assert.match(spoken, /Found 20/);
  assert.match(spoken, /Submitted 13/);
  assert.match(spoken, /captcha/i);
});

// ---------------- Scenario 2: no volume cap; only a site's refusal defers ----------------
test("loop: with 13 already submitted today, all 13 doorstep-ready applications still submit — no count defers them", () => {
  const log = { records: [] };
  for (let i = 0; i < 13; i++) log.records.push({ userId: USER, status: "submitted", timestamp: NOW, canonicalKey: `seed:other:${i}`, company: `Seed Co ${i}` });
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 13, "no 15/day cap: every approved, doorstep-ready application submits");
  assert.equal(run.deferred.filter((x) => x.code === "CAP_REACHED").length, 0, "nothing is deferred by a count");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 26, "the day goes past the old cap of 15");
});

test("loop: a site that is refusing (a rate limit in the ledger) defers only ITS applications, each to the site's own time; the other sites submit", () => {
  const log = { records: [] };
  const until = new Date(NOW + 5 * 60000).toISOString();
  // Lever is refusing for five minutes (as 149 records a 429 with Retry-After at open).
  log.records.push({ userId: USER, status: "portal_refused", host: "jobs.lever.co", vendor: "lever", why: "rate_limited", timestamp: NOW, until, canonicalKey: null });
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  const held = Object.values(run.apps).filter((a) => a.stage === "deferred_refusal");
  assert.ok(held.length > 0 && held.every((a) => /jobs\.lever\.co/.test(a.url)), `only lever's are held: ${JSON.stringify(held.map((a) => a.url))}`);
  const deferred = run.deferred.filter((x) => x.code === "PORTAL_REFUSING");
  assert.equal(deferred.length, held.length);
  assert.ok(deferred.every((x) => x.resumeOn === until), "each resumes at the site's own time");
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  Batch.executeRun(run, deps);
  assert.ok(run.summary.submitted > 0, "the sites that answer submit");
  assert.equal(log.records.filter((r) => r.status === "submitted" && /lever/.test(r.vendor || "")).length, 0, "nothing went to the refusing site");
  assert.match(Batch.speakSummary(run).join("\n"), /turning requests away/);
});

// ---------------- Scenario 3: tamper truth (MI-116 across invocations) ----
test("loop: a payload changed after the card stops THAT application at submit; the rest proceed", () => {
  const log = { records: [] };
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  // simulate the cross-invocation rebuild: sessions do not survive
  Batch._runtime.delete(run.id);
  // ...and one posting's confirmed answer changes before the run resumes
  const tampered = Object.assign({}, deps, {
    profileFor: (p, base) => (p.id === "JOB-T-05"
      ? Object.assign({}, base, { answers: Object.assign({}, base.answers, { sponsorship: { value: "Yes", confirmed: true } }) })
      : base),
  });
  const ex = Batch.executeRun(run, tampered);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 12);
  const mismatch = run.summary.stops.find((x) => x.code === "APPROVAL_PAYLOAD_MISMATCH");
  assert.ok(mismatch, "the changed application stopped by name");
  assert.equal(mismatch.company, "TestCo 5");
});

test("loop: the approval itself refuses when the doorstep set changed after the card", () => {
  const log = { records: [] };
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  const anyKey = run.selected.find((k) => run.apps[k].stage === "doorstep");
  run.apps[anyKey].payloadSha256 = "0".repeat(64); // a payload was rebuilt after the card
  const ap = Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 });
  assert.equal(ap.ok, false);
  assert.equal(ap.code, "APPROVAL_SET_CHANGED");
  assert.equal(run.status, "awaiting_approval", "no approval was minted against a changed set");
});

test("loop: no approval, no execution — the batch stops at the card", () => {
  const log = { records: [] };
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, false);
  assert.equal(ex.code, "RUN_NOT_APPROVED");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "nothing submitted without the yes");
});

test("loop: the run object is pure JSON — it survives the host snapshot round-trip", () => {
  const log = { records: [] };
  const { deps } = makeDeps(log);
  const run = newRun();
  Batch.prepareRun(run, deps);
  const restored = Batch.restoreRun(JSON.parse(JSON.stringify(Batch.serializeRun(run))));
  assert.equal(restored.id, run.id);
  assert.equal(restored.status, "awaiting_approval");
  assert.equal(restored.cardSha256, run.cardSha256);
  assert.equal(Batch.approveRun(restored, { approvedByUser: true, now: NOW, userId: restored.userId, profileSha256: restored.profileSha256 }).ok, true, "an approval lands on the restored run");
});

// ---------------- The chat path itself (142 seam + host snapshot) --------
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));
const D = (n) => require(path.join(root, "packages/domain", n));
const seam = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"),
  CareerOnboarding: D("130-career-onboarding.js"),
  CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"),
  CareerReply: D("140-career-reply.js"),
  CareerContainment: D("143-career-containment.js"),
});

test("host plumbing: STATE_KEYS carries batchApplyState (J6)", () => {
  assert.ok(CareerHost.STATE_KEYS.includes("batchApplyState"), "career_host STATE_KEYS must whitelist the batch-apply run box");
  assert.ok(seam.STATE_KEYS.includes("batchApplyState"));
});

test("chat path: one message prepares the batch at the card; the yes — in a fresh thread, snapshot only — submits it", () => {
  const log = { records: [] };
  const ctx1 = seam.createTurnCtx({ userId: USER, threadId: "thread-loop-1", now: NOW, snapshot: null, profile: MASTER, postings: MARKET });
  ctx1.portalProfile = PROFILE;
  ctx1.batchDeps = { log, boardFor, attestations: ATTEST };
  const turn1 = seam.runTurn("apply to 15 software engineering intern roles", ctx1);
  assert.equal(turn1.intent, "career_batch_apply", turn1.reply);
  assert.equal(turn1.resultStatus, "awaiting_approval", turn1.reply);
  assert.ok(ctx1.batchApplyState, "the prepared run is on the thread state");
  assert.equal(ctx1.batchApplyState.summary.doorstep, 13);
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "nothing submitted before the yes");

  const snap = seam.extractSnapshot(ctx1);
  assert.ok(snap.stores.batchApplyState, "the run rides the host snapshot");

  // A brand-new thread: only the snapshot carries over. The yes arrives
  // as the card tap — structured ctx, never inferred from chat text.
  const ctx2 = seam.createTurnCtx({ userId: USER, threadId: "thread-loop-2", now: NOW, snapshot: snap, profile: MASTER, postings: [] });
  ctx2.portalProfile = PROFILE;
  ctx2.batchDeps = { log, boardFor, attestations: ATTEST };
  ctx2.batchApproval = { approvedByUser: true };
  const turn2 = seam.runTurn("yes", ctx2);
  assert.equal(turn2.intent, "career_batch_apply", turn2.reply);
  assert.equal(ctx2.batchApplyState.summary.submitted, 13, "13 employer confirmations captured through the chat path");
  assert.equal(ctx2.batchApplyState.summary.confirmations.length, 13);
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 13);
  assert.match(turn2.reply, /Submitted 13/);
});

test("chat path: the three owner message shapes all reach the batch intent", () => {
  for (const [msg, fam] of [["apply to 15 investment banking intern roles", "investment banking intern"], ["apply to 15 software engineering roles", "software engineering"], ["apply to 15 nursing roles", "nursing"]]) {
    const ctx = seam.createTurnCtx({ userId: USER, threadId: `thread-shape-${fam}`, now: NOW, snapshot: null, profile: MASTER, postings: [] });
    const r = seam.runTurn(msg, ctx);
    assert.equal(r.intent, "career_batch_apply", `${msg} -> ${r.intent}: ${r.reply}`);
    assert.equal(ctx.batchApplyState.familyText, fam);
    assert.equal(ctx.batchApplyState.requested, 15);
  }
});

// ---------------------------------------------------------------------------
// J8: the tier-1 join (Crew B, 2026-10-15). The deployed composition:
// handler-career.ts builds the host with a boardFor resolved through
// career_task_bridge (createCareerBoardFor) and the host attaches it to
// every turn ctx as ctx.batchDeps.boardFor. These cases compose the
// host EXACTLY that way — the tests never put boardFor into ctx
// themselves. J9 (same day) replaced the bridge's session-supply double
// with the REAL worker board provider + board service: the only
// doubles left are at the transport boundary (an in-process call into
// the service core — the wire, nothing behind it) and at the service's
// board-factory seam (149's sandbox board; Chromium cannot start
// sandboxed in this executor, the owned-worker doc's recorded limit).
// They run as a fresh user (J8USER) and sit BEFORE the pause case on
// purpose: a global pause mirrors across an account's threads by
// design, so any turn composed after that case would be held —
// ordering, not isolation, is the honest arrangement.
// ---------------------------------------------------------------------------
const Bridge = require(path.join(root, "supabase/functions/_shared/career_task_bridge.js"));
const { createBoardService } = require(path.join(root, "workers/career-browser/board-service.cjs"));
const BOARD_SECRET = "loop-test-board-secret";
// The service's factory seam: 149's sandbox board keyed by the URL's
// board — testco7 carries the extra uncovered question, testco11
// stages the captcha (the J8 double keyed the same variants by id).
function loopSandboxFactory(opts) {
  const url = (opts && opts.url) || "";
  let base;
  if (/testco11/.test(url)) base = Portal.createSandboxBoard({ captchaAt: "open" });
  else base = Portal.createSandboxBoard({});
  const fam = /lever\.co/.test(url) ? "lever" : /ashbyhq\.com/.test(url) ? "ashby" : "greenhouse";
  const board = Object.assign({}, base, { atsFamily: fam });
  if (/testco7/.test(url)) {
    const origForm = board.form;
    board.form = () => { const f = origForm(); f.fields = f.fields.concat([{ field_id: "start_date", label: "Earliest start date", kind: "screening", question_key: "start_date", required: true }]); return f; };
  }
  return board;
}
function loopBoardService(extra = {}) {
  return createBoardService(Object.assign({ secret: BOARD_SECRET, familyVerdicts: { greenhouse: true, lever: true, ashby: true }, boardFactory: loopSandboxFactory }, extra));
}
function loopProvider(service, userId, transport) {
  return Bridge.createWorkerBoardProvider({ workerUrl: "http://127.0.0.1/board-service", secret: BOARD_SECRET, userId, transport: transport || ((req) => service.handle(req)) });
}
const J8USER = "user-j8-join";
function hostShapedLikeHandler(boardForFn) {
  return CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"),
    CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"),
    CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"),
    CareerContainment: D("143-career-containment.js"),
    boardFor: boardForFn || undefined,
  });
}

test("join: the bridge resolves no provider, a down worker, and a malformed board all to no board", () => {
  assert.equal(Bridge.createCareerBoardFor(null), null, "no provider -> no boardFor at all");
  assert.equal(Bridge.createCareerBoardFor({}), null, "a provider without boardFor is no provider");
  const down = Bridge.createCareerBoardFor({ boardFor() { throw new Error("worker unreachable"); } });
  assert.equal(typeof down, "function");
  assert.equal(down(MARKET[0]), null, "an unreachable worker yields no board — the stop stays BOARD_NOT_WIRED");
  const malformed = Bridge.createCareerBoardFor({ boardFor: () => ({ atsFamily: "greenhouse" }) });
  assert.equal(malformed(MARKET[0]), null, "an object without module 149's board methods is no board, never a fake drive");
  const good = Bridge.createCareerBoardFor({ transport: "owned_browser_worker", boardFor });
  const b = good(MARKET[0]);
  assert.ok(b && typeof b.submit === "function" && b.atsFamily === MARKET[0].atsFamily, "a contract-satisfying board passes through");
});

test("join: composed as the handler composes it with no provider, the loop stops named BOARD_NOT_WIRED at the drive stage", () => {
  const host = hostShapedLikeHandler(Bridge.createCareerBoardFor(null));
  const log = { records: [] };
  const ctx = host.createTurnCtx({ userId: J8USER, threadId: "thread-j8-unwired", now: NOW, snapshot: null, profile: MASTER, postings: MARKET, batchDeps: { log, attestations: ATTEST } });
  ctx.portalProfile = PROFILE;
  assert.equal(ctx.batchDeps.boardFor, undefined, "no boardFor is attached when the bridge resolved no provider");
  const turn = host.runTurn("apply to 15 software engineering intern roles", ctx);
  assert.equal(turn.intent, "career_batch_apply", turn.reply);
  assert.equal(turn.capabilities.portal_browser.status, "NOT_WIRED");
  const run = ctx.batchApplyState;
  assert.equal(run.summary.submitted, 0);
  assert.equal(run.summary.doorstep, 0);
  assert.equal(run.summary.stops.length, 15, "every selected application reaches the drive stage and stops there");
  assert.ok(run.summary.stops.every((x) => x.code === "BOARD_NOT_WIRED"), "one honest name on every stop");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0, "nothing was faked into a submission");
});

test("join: with the worker board provider wired through the host (J9 — real service behind the transport), the same message submits 13", () => {
  const service = loopBoardService();
  const boardForFn = Bridge.createCareerBoardFor(loopProvider(service, J8USER));
  assert.equal(typeof boardForFn, "function");
  const host = hostShapedLikeHandler(boardForFn);
  const log = { records: [] };
  const deps = { log, attestations: ATTEST };
  const ctx1 = host.createTurnCtx({ userId: J8USER, threadId: "thread-j8-wired-1", now: NOW, snapshot: null, profile: MASTER, postings: MARKET, batchDeps: deps });
  assert.equal(ctx1.batchDeps.boardFor, boardForFn, "the boardFor arrived from the host composition — the test never set it on ctx");
  ctx1.portalProfile = PROFILE;
  const turn1 = host.runTurn("apply to 15 software engineering intern roles", ctx1);
  assert.equal(turn1.intent, "career_batch_apply", turn1.reply);
  assert.equal(turn1.resultStatus, "awaiting_approval", turn1.reply);
  assert.equal(turn1.capabilities.portal_browser.status, "WIRED");
  assert.equal(turn1.capabilities.portal_browser.transport, "career_task_bridge");
  assert.equal(ctx1.batchApplyState.summary.doorstep, 13, "the full fixture trajectory still holds through the join");
  const snap = host.extractSnapshot(ctx1);
  assert.ok(!("batchDeps" in snap.stores), "runtime wiring never rides the snapshot");
  const ctx2 = host.createTurnCtx({ userId: J8USER, threadId: "thread-j8-wired-2", now: NOW, snapshot: snap, profile: MASTER, postings: [], batchDeps: deps });
  assert.equal(ctx2.batchDeps.boardFor, boardForFn, "the host re-attaches boardFor on the resumed invocation");
  ctx2.portalProfile = PROFILE;
  ctx2.batchApproval = { approvedByUser: true };
  const turn2 = host.runTurn("yes", ctx2);
  assert.equal(turn2.intent, "career_batch_apply", turn2.reply);
  assert.equal(ctx2.batchApplyState.summary.submitted, 13, "the wired path submits where the unwired path stopped BOARD_NOT_WIRED");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 13);
});

test("join: a wired bridge whose worker is down stops every drive named BOARD_NOT_WIRED — nothing faked, nothing submitted", () => {
  const downProvider = Bridge.createWorkerBoardProvider({ workerUrl: "http://127.0.0.1/board-service", secret: BOARD_SECRET, userId: J8USER, transport() { throw new Error("worker unreachable"); } });
  const downBoardFor = Bridge.createCareerBoardFor(downProvider);
  const host = hostShapedLikeHandler(downBoardFor);
  const log = { records: [] };
  const ctx = host.createTurnCtx({ userId: J8USER, threadId: "thread-j8-down", now: NOW, snapshot: null, profile: MASTER, postings: MARKET, batchDeps: { log, attestations: ATTEST } });
  ctx.portalProfile = PROFILE;
  const turn = host.runTurn("apply to 15 software engineering intern roles", ctx);
  assert.equal(turn.intent, "career_batch_apply", turn.reply);
  const run = ctx.batchApplyState;
  assert.equal(run.summary.submitted, 0);
  assert.equal(run.summary.stops.length, 15);
  assert.ok(run.summary.stops.every((x) => x.code === "BOARD_NOT_WIRED"), "the worker being down degrades to the same named stop, per application");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 0);
});

// ---------------------------------------------------------------------------
// J9 trajectories: the provider's failure modes inside a real batch
// (Batch-level, own services — order-independent of the pause case).
// ---------------------------------------------------------------------------
test("loop (J9): the worker dying mid-execution keeps the completed submission and stops the rest named — nothing is retried", () => {
  const service = loopBoardService();
  const control = { down: false, submits: 0 };
  const transport = (req) => {
    if (control.down) throw Object.assign(new Error("worker process gone"), { code: "WORKER_UNREACHABLE" });
    const res = service.handle(req);
    if (req.path.endsWith("/call") && req.body && req.body.method === "submit" && res.body && res.body.ok) { control.submits += 1; control.down = true; }
    return res;
  };
  const boardForFn = Bridge.createCareerBoardFor(loopProvider(service, USER, transport));
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: boardForFn });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(run.summary.doorstep, 13, "the batch prepared fully while the worker was up");
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 1, "the one submission that completed before the worker died stands");
  assert.equal(control.submits, 1, "exactly one submit ever crossed the wire — nothing was retried blind");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 1);
  const execStops = run.summary.stops.filter((x) => x.code === "EXECUTION_ERROR");
  assert.equal(execStops.length, 12, "every other doorstep application stopped at execution");
  assert.ok(execStops.every((x) => /worker/i.test(x.reason)), "each stop names the dead worker as its reason");
});

test("loop (J9): sessions expiring between approval and execution stop every application named — no stale-session submit", () => {
  let clock = NOW;
  const registry = [];
  const service = loopBoardService({ now: () => clock, sessionTtlMs: 60000, boardFactory: (opts) => { const b = loopSandboxFactory(opts); registry.push(b); return b; } });
  const boardForFn = Bridge.createCareerBoardFor(loopProvider(service, USER));
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: boardForFn });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(run.summary.doorstep, 13);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  clock += 61000; // every prepared session is now past its idle TTL
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 0, "nothing submitted through a stale session");
  const execStops = run.summary.stops.filter((x) => x.code === "EXECUTION_ERROR");
  assert.equal(execStops.length, 13, "every doorstep application stopped at execution");
  assert.ok(execStops.every((x) => /expired/.test(x.reason)), "each stop names the session expiry as its reason");
  assert.equal(registry.reduce((n, b) => n + b.calls.submit, 0), 0, "no submit ever reached a worker board");
  assert.ok(service.counters().refused.expired >= 1, "the service recorded the expiries it served");
});

// ---------------------------------------------------------------------------
// LEG 1 — the approvalRef seam (Crew B, 2026-10-15; the defect the J9
// build observed and filed for Crew A allocation): 155's execute path
// minted approvals {approvedByUser, payloadSha256} with NO approvalRef,
// so a REAL module-150 board could never arm through the batch path —
// its submit throws REAL_SUBMIT_DISABLED and every real-board batch
// submit died as a per-application EXECUTION_ERROR. Sandbox boards
// have no arming wire, which is why every trajectory above passed
// while the real path was dead. The double below is 150-faithful at
// the wire that matters: armForSubmit arms ONLY on approvedByUser ===
// true AND a non-empty approvalRef, and submit() throws
// REAL_SUBMIT_DISABLED until armed. These cases are the permanent
// guard: the batch path submits real boards only by carrying the
// batch approvalRef (minted at the card's one yes, bound to the card
// set hash) into submitDoorstep.
// ---------------------------------------------------------------------------
function realBoardDouble(base) {
  const arm = { armed: false, approvalRef: null, armCalls: [], submits: 0 };
  const board = Object.assign({}, base, {
    kind: "browser", sandbox: false, browserDriver: true,
    armForSubmit(ctx) {
      arm.armCalls.push(ctx || {});
      const ref = ctx && typeof ctx.approvalRef === "string" ? ctx.approvalRef.trim() : "";
      if (ctx && ctx.approvedByUser === true && ref) {
        arm.armed = true; arm.approvalRef = ref;
        return { armed: true, approvalRef: ref };
      }
      return { armed: false, reason: "approval_ref_required" };
    },
    submit() {
      if (!arm.armed) throw Object.assign(new Error("this browser board is not armed for submission — the doorstep is the end of the line until 149's approval gate arms it with the owner's batch approval reference"), { code: "REAL_SUBMIT_DISABLED" });
      arm.submits += 1;
      return base.submit();
    },
  });
  board._arm = arm;
  return board;
}
function realBoardFor(registry) {
  return (p) => { const b = realBoardDouble(boardFor(p)); if (registry) registry.push({ posting: p, board: b }); return b; };
}
function loopRealFactory(registry) {
  return (opts) => { const b = realBoardDouble(loopSandboxFactory(opts)); if (registry) registry.push(b); return b; };
}

test("leg1: REAL boards (arming wire present) submit through the batch path — armed by the batch approvalRef bound to the set hash", () => {
  const registry = [];
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: realBoardFor(registry) });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(run.summary.doorstep, 13);
  const ap = Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 });
  assert.equal(ap.ok, true);
  assert.equal(typeof run.approvalRef, "string", "the one yes minted an approvalRef on the run");
  assert.ok(run.approvalRef.includes(run.id), "the ref names the run it approves");
  assert.ok(run.approvalRef.includes(run.cardSha256), "the ref is bound to the card set hash");
  assert.equal(ap.approvalRef, run.approvalRef, "approveRun reports the ref it minted");
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 13, "all 13 doorstep applications submitted on real boards");
  const doorstepBoards = registry.filter((r) => r.board._arm.submits > 0 || r.board._arm.armCalls.length > 0);
  assert.equal(doorstepBoards.length, 13, "exactly the 13 doorstep boards were armed");
  for (const r of doorstepBoards) {
    assert.equal(r.board._arm.armCalls.length, 1, "armed exactly once");
    assert.equal(r.board._arm.approvalRef, run.approvalRef, "armed under the batch approvalRef");
    assert.equal(r.board._arm.submits, 1, "submitted exactly once");
  }
  assert.equal(registry.reduce((n, r) => n + r.board._arm.submits, 0), 13, "no board outside the doorstep set ever submitted");
  assert.equal(log.records.filter((r) => r.status === "submitted").length, 13);
});

test("leg1: an approval in the pre-fix shape (hash only, NO approvalRef) still cannot arm a real board — every submit refuses", () => {
  const registry = [];
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: realBoardFor(registry) });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(run.summary.doorstep, 13);
  // Hand-mint the approvals exactly as the pre-fix execute path did:
  // per-application payload hashes, status approved, no ref anywhere.
  run.approvals = {};
  for (const k of run.selected) { const a = run.apps[k]; if (a && a.stage === "doorstep") run.approvals[k] = a.payloadSha256; }
  // WO-094: the card's per-application attestation (what approveRun
  // records) is minted too, so this test still isolates the arming wire:
  // the certification is given, only the approvalRef is missing.
  run.attestations = {};
  for (const k of Object.keys(run.approvals)) {
    run.attestations[k] = {};
    for (const at of run.apps[k].attestations || []) run.attestations[k][at.field_id] = { explicit: true, value: at.value, text: at.text, payloadSha256: run.approvals[k], approvalRef: null };
  }
  run.status = "approved";
  assert.ok(!run.approvalRef, "the run carries no approvalRef (the pre-fix shape)");
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 0, "nothing submitted — a hash-bound approval without a ref never arms a real board");
  const stops = run.summary.stops.filter((x) => x.code === "EXECUTION_ERROR");
  assert.equal(stops.length, 13, "every doorstep application stopped at execution");
  assert.ok(stops.every((x) => /not armed for submission/.test(x.reason)), "each stop carries the board's REAL_SUBMIT_DISABLED refusal in its reason");
  assert.equal(registry.reduce((n, r) => n + r.board._arm.submits, 0), 0, "no real board ever fired a submit");
});

test("leg1: a payload changed after the card stops at MI-116 BEFORE the arming wire — the tampered real board is never armed", () => {
  const registry = [];
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: realBoardFor(registry) });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  Batch._runtime.delete(run.id); // sessions do not survive the invocation gap
  const tampered = Object.assign({}, deps, {
    profileFor: (p, base) => (p.id === "JOB-T-05"
      ? Object.assign({}, base, { answers: Object.assign({}, base.answers, { sponsorship: { value: "Yes", confirmed: true } }) })
      : base),
  });
  const ex = Batch.executeRun(run, tampered);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 12, "the untampered applications still submit on real boards");
  const mismatch = run.summary.stops.find((x) => x.code === "APPROVAL_PAYLOAD_MISMATCH");
  assert.ok(mismatch && mismatch.company === "TestCo 5");
  const t5 = registry.filter((r) => r.posting.id === "JOB-T-05");
  assert.ok(t5.length >= 1);
  for (const r of t5) {
    assert.equal(r.board._arm.armCalls.length, 0, "the tampered application's board was never armed — the mismatch stops before the wire");
    assert.equal(r.board._arm.submits, 0);
  }
});

test("leg1: the approvalRef crosses the worker wire — service-backed REAL boards arm under the batch ref and submit", () => {
  const registry = [];
  const service = loopBoardService({ boardFactory: loopRealFactory(registry) });
  const boardForFn = Bridge.createCareerBoardFor(loopProvider(service, USER));
  const log = { records: [] };
  const { deps } = makeDeps(log, { boardFor: boardForFn });
  const run = newRun();
  Batch.prepareRun(run, deps);
  assert.equal(run.summary.doorstep, 13);
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  assert.ok(run.approvalRef, "the batch approval minted its ref");
  const ex = Batch.executeRun(run, deps);
  assert.equal(ex.ok, true);
  assert.equal(run.summary.submitted, 13, "the batch submitted end-to-end with real boards behind the worker service");
  const armed = registry.filter((b) => b._arm.armCalls.length > 0);
  assert.equal(armed.length, 13, "13 worker-side boards were armed");
  for (const b of armed) {
    assert.equal(b._arm.approvalRef, run.approvalRef, "the ref that armed the worker board is the batch's own ref — it crossed the wire intact");
    assert.equal(b._arm.submits, 1);
  }
});

test("chat path: under the global pause the batch does NOT run (the pause gate keeps priority over the seam)", () => {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "thread-loop-paused", now: NOW, snapshot: null, profile: MASTER, postings: MARKET });
  ctx.globalPause = { set: true, at: new Date(NOW).toISOString(), source: "user" };
  ctx.portalProfile = PROFILE;
  ctx.batchDeps = { log: { records: [] }, boardFor, attestations: ATTEST };
  const r = seam.runTurn("apply to 15 software engineering intern roles", ctx);
  assert.notEqual(r.intent, "career_batch_apply", r.reply);
  assert.equal(ctx.batchApplyState, undefined, "no run was prepared under the pause");
});
