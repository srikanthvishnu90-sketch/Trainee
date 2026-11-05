"use strict";
/* MASS APPLY END TO END (2026-11-04). The beta evidence of 2026-11-04 (A1 mass apply, A2 approval binding, A3 cloud
   apply, A14 tracking, A24 apply by email) ran each input through the router with an empty synthetic account and got:
     "Apply to all those roles" -> career_catchall          "Approve the second application" -> career_catchall
     "Show my pending approvals" -> generic containment      "Change the answer after approval" -> generic containment
     "The portal requires an account" -> containment         "Was the application actually submitted?" -> career_catchall
     "What did you send today?" -> containment               "Can you distinguish prepared from submitted?" -> containment
     "Explain applying by email ..." / "Draft an application email for review only" -> career_catchall
     "What happens if the attachment changes after approval?" / "Who is the email sent from?" -> containment
   and "I said no, nothing should be sent" said "Submitting to employers is not wired in this conversation" although real
   submission is ON (D-041).
   REQUIRED, against seeded list / batch / queue state: each input reaches an owner that reads the record (never the
   catch-all or containment), "those" and "the second" bind to the list and the pending approvals actually standing, the
   prepared / approved / submitted states are told apart from the records, and NOTHING is approved or submitted without
   the structured, hash-bound approval of the exact card.
   TEST personas and sandbox boards only. Check: node --test tests/career-mass-apply-state-20261104.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const Portal = D("149-career-portal-apply.js");
const Batch = D("155-career-batch-apply.js");
const Ledger = D("157-career-apply-ledger.js");
const Reply = D("140-career-reply.js");
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));

const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const USER = "user-mass-state-test";
const PROFILE = {
  name: "Jordan Lee (TEST)", email: "jordan.lee@example.test", phone: "+1 000 555 0101", location: "Chicago, IL",
  resume: { filename: "jordan-lee-resume.pdf", sha256: "b".repeat(64) },
  answers: { work_authorization: { value: "Yes — authorized to work in the US", confirmed: true }, sponsorship: { value: "No", confirmed: true } },
};
const MASTER = { basics: { name: "Jordan Lee (TEST)", email: "jordan.lee@example.test" },
  facts: [{ id: "F-T-101", kind: "skill", text: "Customer support and ticketing", confirmed: true }, { id: "F-T-102", kind: "education", text: "Associate degree", confirmed: true }] };
const ATTEST = { certify_true: { value: true, explicit: true } };
const FAMS = ["greenhouse", "lever", "ashby"];
const posting = (n) => ({ id: `JOB-M-${n}`, job_id: `JOB-M-${n}`, canonicalKey: `${FAMS[n % 3]}:supportco${n}:customer-support-specialist`, company: `SupportCo ${n}`,
  role: "Customer Support Specialist", title: "Customer Support Specialist", url: `https://boards.example.test/supportco${n}/jobs/${n}`, status: "open", atsFamily: FAMS[n % 3],
  location: "Chicago, IL", posted_at: "2026-11-01", jd_text: "Customer support specialist at a test company. Ticketing, chat support, written communication." });
const MARKET = [1, 2, 3].map(posting);
const SHORTLIST = MARKET.map((p) => ({ id: p.id, title: p.title, company: p.company, url: p.url, location: p.location }));
const boardFor = (p) => Object.assign({}, Portal.createSandboxBoard({ accountName: PROFILE.name }), { atsFamily: p.atsFamily });

const host = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"), CareerReply: Reply, CareerContainment: D("143-career-containment.js"),
});
const FALLBACK = (o) => !o || o.contained || o.intent == null || o.intent === "career_catchall" || o.intent === "career_fallback" || Reply.isFallbackText(String(o.reply || ""));
const submitted = (log) => log.records.filter((r) => r.status === "submitted").length;
const lintClean = (o) => { for (const b of Reply.splitBubbles(String(o.reply))) assert.ok(Reply.lint(b).ok, `${b} -> ${JSON.stringify(Reply.lint(b).violations)}`); };
const sendsOf = (o) => (o && o.result && o.result.sends) || 0;

// One turn on a fresh or restored thread. `o.list` seeds the shortlist the last discovery showed; `o.ledger` the queue
// records the handler reads into the turn (situation tasks); `o.live` the live switches.
function turn(message, o = {}) {
  const ctx = host.createTurnCtx({ userId: USER, threadId: "thread-mass", now: o.now || NOW, snapshot: o.snapshot || null, profile: o.profile === undefined ? MASTER : o.profile, postings: o.postings || MARKET });
  ctx.portalProfile = PROFILE;
  if (o.log) ctx.batchDeps = { log: o.log, boardFor, attestations: ATTEST };
  if (o.list) ctx.discovery = Object.assign({}, ctx.discovery || {}, { lastShortlist: o.list, lastParams: { roleText: "customer support" } });
  if (o.ledger) ctx.applyLedger = o.ledger;
  if (o.live) ctx.liveSwitches = o.live;
  if (o.approval) ctx.batchApproval = o.approval;
  const out = host.runTurn(message, ctx);
  return { out, ctx, snap: host.extractSnapshot(ctx) };
}

// ---------------------------------------------------------------- the empty account (the beta's own setting)
const EMPTY = [
  ["Apply to all those roles", "career_list_reference", /haven't shown you a list/],
  ["Show my pending approvals", "career_pending_approvals", /Nothing is waiting for your approval/],
  ["Approve the second application", "career_approval_select", /nothing was approved or sent/],
  ["Change the answer after approval", "career_answer_change_after_approval", /not sent on that yes/],
  ["The portal requires an account", "career_portal_account", /never create an account or sign in for you/],
  ["Was the application actually submitted?", "career_submission_check", /No application is on record as submitted/],
  ["What did you send today?", "career_sent_activity", /No application was sent in the last 24 hours/],
  ["Can you distinguish prepared from submitted?", "career_status_states", /Prepared means built/],
  ["Explain applying by email without sending anything", "career_apply_email_explain", /only after you reply yes to that exact email/],
  ["Draft an application email for review only", "career_apply_email_draft", /drafting never sends/],
  ["What happens if the attachment changes after approval?", "career_answer_change_after_approval", /different file than the one you approved stops the send/],
  ["Who is the email sent from?", "career_apply_email_sender", /your own Gmail account, never from Trainee's/],
  ["How many applications did you submit today?", "career_sent_activity", /No application was sent/],
];
for (const [ask, intent, words] of EMPTY) {
  test(`empty account: "${ask}" -> ${intent}, read from the (empty) record, nothing sent`, () => {
    const { out } = turn(ask, { profile: null });
    assert.equal(FALLBACK(out), false, `fell back: ${out.intent} ${out.reply}`);
    assert.equal(out.intent, intent, out.reply);
    assert.match(out.reply, words);
    assert.equal(sendsOf(out), 0);
    lintClean(out);
  });
}
test("empty account: the routes that already answered keep their owners (no regression)", () => {
  assert.equal(turn("Skip the first role", { profile: null }).out.intent, "career_list_reference");
  assert.equal(turn("Show the batch progress", { profile: null }).out.intent, "career_batch_apply");
  assert.equal(turn("Show my application status", { profile: null }).out.intent, "tracking_status");
  assert.equal(turn("Where do I stand?", { profile: null }).out.intent, "tracking_status");
  assert.equal(turn("The application has a CAPTCHA", { profile: null }).out.intent, "captcha_handoff");
  assert.equal(turn("have you applied anywhere for me yet?", { profile: null }).out.intent, "tracking_status");
  assert.equal(turn("how many jobs have I applied to", { profile: null }).out.intent, "tracking_status");
});

// ---------------------------------------------------------------- the list and the batch (A1, A2)
function preparedFromList() {
  const log = { records: [] };
  const r = turn("Apply to all those roles", { list: SHORTLIST, log });
  return { log, ...r };
}
test("A1: 'Apply to all those roles' binds to the list shown and prepares exactly it at one card; nothing is submitted", () => {
  const { out, ctx, log } = preparedFromList();
  assert.equal(out.intent, "career_batch_apply", out.reply);
  assert.equal(out.resultStatus, "awaiting_approval", out.reply);
  for (const p of MARKET) assert.ok(out.reply.includes(p.company), `the reply names ${p.company}: ${out.reply}`);
  const run = Batch.restoreRun(ctx.batchApplyState);
  assert.deepEqual(run.selected.map((k) => run.postings[k].id).sort(), MARKET.map((p) => p.id).sort(), "the batch is exactly the listed postings");
  assert.ok(run.cardSha256, "one card, bound by its hash");
  assert.equal(submitted(log), 0, "preparing submits nothing");
  assert.equal(sendsOf(out), 0);
});
test("A1: 'those' with a list but no profile, and with a list whose postings are gone, says so; nothing is prepared", () => {
  const a = turn("Apply to all those roles", { list: SHORTLIST, profile: null });
  assert.equal(a.out.intent, "career_list_reference", a.out.reply);
  assert.match(a.out.reply, /without your resume/);
  assert.equal(a.ctx.batchApplyState, undefined);
  const b = turn("apply to all of those jobs", { list: SHORTLIST, postings: [] });
  assert.equal(b.out.intent, "career_list_reference", b.out.reply);
  assert.match(b.out.reply, /can't find the postings/);
  assert.equal(b.ctx.batchApplyState, undefined);
});
test("A2: with the batch at its card, 'Show my pending approvals' lists exactly its applications; 'Approve the second application' binds to the second and approves NOTHING", () => {
  const { snap, log } = preparedFromList();
  const before = JSON.stringify(snap.stores.batchApplyState);
  const run = Batch.restoreRun(snap.stores.batchApplyState);
  const doorstep = run.selected.map((k) => run.apps[k]).filter((a) => a.stage === "doorstep");
  assert.ok(doorstep.length >= 2, "setup: at least two applications prepared");
  const pend = turn("Show my pending approvals", { snapshot: snap, log });
  assert.equal(pend.out.intent, "career_pending_approvals", pend.out.reply);
  for (const a of doorstep) assert.ok(pend.out.reply.includes(a.company), pend.out.reply);
  assert.match(pend.out.reply, /approved nothing/);
  const pick = turn("Approve the second application", { snapshot: snap, log, live: { employerSubmit: true, emailSend: true, batchExecutor: false } });
  assert.equal(pick.out.intent, "career_approval_select", pick.out.reply);
  assert.equal(pick.out.result.target.company, doorstep[1].company, "'the second' is the second application waiting");
  assert.match(pick.out.reply, new RegExp(doorstep[1].company));
  assert.match(pick.out.reply, /did not approve it from this message/);
  assert.match(pick.out.reply, /Real submission to employers is on/);
  assert.equal(JSON.stringify(pick.ctx.batchApplyState), before, "the run is exactly as it was: no approval recorded");
  assert.equal(Batch.restoreRun(pick.ctx.batchApplyState).status, "awaiting_approval");
  assert.equal(submitted(log), 0, "nothing submitted on words");
  const out3 = turn("Approve the fifth application", { snapshot: snap, log }).out;
  assert.equal(out3.resultStatus, "blocked");
  assert.match(out3.reply, /no number 5 to approve; nothing was approved or sent/);
});
test("A2/A3: before the hash-bound approval nothing is submitted; after it the status reads the receipts, never the words", () => {
  const { snap, log } = preparedFromList();
  for (const m of ["Was the application actually submitted?", "What did you send today?"]) {
    const o = turn(m, { snapshot: snap, log }).out;
    assert.equal(FALLBACK(o), false, o.reply);
    assert.doesNotMatch(o.reply, /(?:is|are) recorded as submitted;|\d+ applications? (?:was|were) sent/, `${m}: no receipt before the approval: ${o.reply}`);
  }
  assert.match(turn("Was the application actually submitted?", { snapshot: snap, log }).out.reply, /None of your applications is recorded as submitted/);
  // A typed yes alone never approves (the card's structured approval does).
  const yes = turn("yes go ahead and submit them", { snapshot: snap, log });
  assert.equal(submitted(log), 0, `a typed yes submitted something: ${yes.out.reply}`);
  // The structured approval of the exact card: 155 approves the set by its hash and the sandbox boards submit.
  const ap = turn("yes", { snapshot: snap, log, approval: { approvedByUser: true } });
  assert.equal(ap.out.intent, "career_batch_apply", ap.out.reply);
  const n = submitted(log);
  assert.ok(n >= 1, `the approved card submitted: ${ap.out.reply}`);
  const after = turn("Was the application actually submitted?", { snapshot: ap.snap, log }).out;
  assert.equal(after.intent, "career_submission_check", after.reply);
  assert.match(after.reply, /recorded as submitted/);
  assert.match(after.reply, /no receipt is on record yet/);
  assert.doesNotMatch(after.reply, /(?:its|their) receipts? (?:is|are) on record|\d+ with the receipt on record/, "a batch run has no database receipt, so none is claimed");
  const states = turn("Can you distinguish prepared from submitted?", { snapshot: ap.snap, log }).out;
  assert.match(states.reply, /\d+ submitted \(none with the receipt on record\)/);
  assert.equal(submitted(log), n, "reads submit nothing more");
});
test("A2: a payload changed after the card is refused by 155's hash check; the read routes never approve around it", () => {
  const { snap, log } = preparedFromList();
  const tampered = JSON.parse(JSON.stringify(snap));
  const run = tampered.stores.batchApplyState;
  const k = run.selected.find((x) => run.apps[x].stage === "doorstep");
  run.apps[k].payloadSha256 = "c".repeat(64); // the card no longer matches what was prepared
  const r = turn("yes", { snapshot: tampered, log, approval: { approvedByUser: true } });
  assert.equal(submitted(log), 0, `a changed payload submitted: ${r.out.reply}`);
  assert.match(r.out.reply, /did not submit anything|Nothing was submitted|re-?prepar/i);
});

// ---------------------------------------------------------------- the queue records (the deployed handler's situation)
const ISO = (ms) => new Date(ms).toISOString();
const LEDGER = { asOf: ISO(NOW), unreadable: [], tasks: [
  { id: "prep:1", kind: "application", company: "Acme Support", title: null, state: "awaiting_approval", since: ISO(NOW - 3600e3), evidence: {}, source: "career_apply_prepared" },
  { id: "prep:2", kind: "application", company: "Brightdesk", title: null, state: "awaiting_approval", since: ISO(NOW - 1800e3), evidence: {}, source: "career_apply_prepared" },
  { id: "job:3", kind: "application", company: "Calm Co", title: "Support Rep", state: "queued", since: ISO(NOW - 600e3), evidence: {}, source: "career_apply_jobs" },
  { id: "job:4", kind: "application", company: "Delta Help", title: "Support Agent", state: "submitted_unconfirmed", since: ISO(NOW - 7200e3), evidence: {}, source: "career_apply_jobs" },
  { id: "job:5", kind: "application", company: "Echo Care", title: "Care Specialist", state: "confirmed", since: ISO(NOW - 5 * 86400e3), evidence: { confirmation_id: "EC-77" }, source: "career_apply_jobs" },
  { id: "job:6", kind: "application", company: "Fjord Systems", title: "Support Analyst", state: "needs_user", since: ISO(NOW - 900e3), evidence: { reason: "login_required" }, source: "career_apply_jobs" },
  { id: "track:7", kind: "tracked", company: "Gamma Retail", title: "Associate", state: "tracked", since: "2026-10-20", evidence: { stage: "Submitted" }, source: "tracker (they told Trainee)" },
], receipts: [
  { application_id: "4", reached_employer: "yes", clicked_at: ISO(NOW - 7200e3), finished_at: ISO(NOW - 7190e3), confirmation_id: null },
  { application_id: "5", reached_employer: "yes", clicked_at: ISO(NOW - 5 * 86400e3), finished_at: ISO(NOW - 5 * 86400e3 + 10e3), confirmation_id: null },
] };
test("A14: queue records: prepared, approved, submitted and confirmed are told apart, each from its own record", () => {
  const o = turn("Can you distinguish prepared from submitted?", { ledger: LEDGER }).out;
  assert.equal(o.intent, "career_status_states", o.reply);
  assert.match(o.reply, /2 prepared and waiting for your approval/);
  assert.match(o.reply, /1 approved, not sent yet/);
  assert.match(o.reply, /2 submitted \(1 confirmed by the employer, 2 with the receipt on record\)/);
  assert.match(o.reply, /1 on your tracker that you applied to yourself/);
  lintClean(o);
  const today = turn("What did you send today?", { ledger: LEDGER }).out;
  assert.match(today.reply, /1 application was sent in the last 24 hours/);
  assert.match(today.reply, /Delta Help/);
  assert.doesNotMatch(today.reply, /Echo Care/, "five days ago is not today");
  assert.doesNotMatch(today.reply, /Gamma Retail/, "a tracker row the person sent is never counted as Trainee's send");
  const status = turn("Show my application status", { ledger: LEDGER }).out;
  assert.equal(status.intent, "tracking_status", status.reply);
  assert.match(status.reply, /Calm Co \(?|Support Rep at Calm Co: approved by you, not sent yet/);
  const latest = turn("Was the application actually submitted?", { ledger: LEDGER }).out;
  assert.equal(latest.intent, "career_submission_check");
  assert.match(latest.reply, /2 applications are recorded as submitted; their receipts are on record/);
});
test("A2/A3: queue records: pending approvals, the second one bound by position, the account step handed to the person", () => {
  const pend = turn("Show my pending approvals", { ledger: LEDGER }).out;
  assert.match(pend.reply, /\(1\) Acme Support; \(2\) Brightdesk/);
  assert.match(pend.reply, /show my applications/);
  const pick = turn("Approve the second application", { ledger: LEDGER }).out;
  assert.equal(pick.result.target.company, "Brightdesk");
  assert.equal(sendsOf(pick), 0);
  // With no profile on record the ledger answers the account step from the records; with one, the governed portal-account
  // flow keeps the ask (IB-AP-8 / SC-081: its typed step, committed:false), unchanged by this module.
  const acct = turn("The portal requires an account", { ledger: LEDGER, profile: null }).out;
  assert.match(acct.reply, /Waiting on a sign-in now: Support Analyst at Fjord Systems/);
  const governed = turn("The portal requires an account", { ledger: LEDGER }).out;
  assert.equal(governed.intent, "portal_account", governed.reply);
  assert.equal(((governed.result && governed.result.payload) || governed.payload || {}).committed, false, JSON.stringify(Object.keys(governed.result || {})));
  const pw = turn("The portal asks for another account's password", { ledger: LEDGER, profile: null }).out;
  assert.equal(pw.intent, "career_portal_account");
  assert.match(pw.reply, /never take a password/);
  const chg = turn("Change the answer after approval", { ledger: LEDGER }).out;
  assert.match(chg.reply, /Still changeable now: Acme Support; Brightdesk; Support Rep at Calm Co/);
  assert.match(chg.reply, /Already sent, so I can't change it with the employer: Support Agent at Delta Help; Care Specialist at Echo Care/);
});
test("an unreadable record is said, never counted as nothing", () => {
  const o = turn("What did you send today?", { ledger: { asOf: ISO(NOW), tasks: [], unreadable: ["jobs"] } }).out;
  assert.match(o.reply, /could not be read just now \(jobs\)/);
});

// ---------------------------------------------------------------- review of #496: proof, send time, positions
test("#496/2 'submitted' from the queue state alone never claims a receipt; only the database's receipt that reached the employer does", () => {
  const tasks = [{ id: "job:9", kind: "application", company: "Hollow Co", title: "Agent", state: "submitted_unconfirmed", since: ISO(NOW - 600e3), evidence: {} }];
  const none = turn("Was the application actually submitted?", { ledger: { asOf: ISO(NOW), unreadable: [], tasks } }).out;
  assert.match(none.reply, /1 application is recorded as submitted; no receipt is on record yet/);
  assert.match(none.reply, /Hollow Co: submitted; the employer hasn't confirmed it yet; no receipt is on record yet/);
  const unsure = turn("Was the application actually submitted?", { ledger: { asOf: ISO(NOW), unreadable: [], tasks, receipts: [{ application_id: "9", reached_employer: "unknown", clicked_at: ISO(NOW - 500e3), finished_at: ISO(NOW - 400e3) }] } }).out;
  assert.match(unsure.reply, /no receipt is on record yet/, "a receipt that does not say it reached the employer is not proof");
  const yes = turn("Was the application actually submitted?", { ledger: { asOf: ISO(NOW), unreadable: [], tasks, receipts: [{ application_id: "9", reached_employer: "yes", clicked_at: ISO(NOW - 500e3), finished_at: ISO(NOW - 400e3) }] } }).out;
  assert.match(yes.reply, /1 application is recorded as submitted; its receipt is on record/);
  const lost = turn("Was the application actually submitted?", { ledger: { asOf: ISO(NOW), unreadable: ["receipts"], tasks, receipts: [] } }).out;
  assert.match(lost.reply, /could not be read just now \(receipts\)/);
});
test("#496/3 'what did you send today?' windows on the receipt's send time, never on the row's updated_at", () => {
  const tasks = [
    { id: "job:1", kind: "application", company: "Old Send Co", title: null, state: "submitted_unconfirmed", since: ISO(NOW - 60e3), evidence: {} },   // touched a minute ago
    { id: "job:2", kind: "application", company: "No Receipt Co", title: null, state: "submitted_unconfirmed", since: ISO(NOW - 60e3), evidence: {} },
    { id: "job:3", kind: "application", company: "Fresh Co", title: null, state: "submitted_unconfirmed", since: ISO(NOW - 9 * 86400e3), evidence: {} }, // row old, send today
  ];
  const receipts = [
    { application_id: "1", reached_employer: "yes", clicked_at: ISO(NOW - 3 * 86400e3), finished_at: ISO(NOW - 3 * 86400e3) },
    { application_id: "3", reached_employer: "yes", clicked_at: ISO(NOW - 3600e3), finished_at: ISO(NOW - 3590e3) },
  ];
  const o = turn("What did you send today?", { ledger: { asOf: ISO(NOW), unreadable: [], tasks, receipts } }).out;
  assert.match(o.reply, /1 application was sent in the last 24 hours/);
  assert.match(o.reply, /Fresh Co/);
  assert.doesNotMatch(o.reply, /Old Send Co/, "sent three days ago, whatever its updated_at says");
  assert.match(o.reply, /1 sent application has no send time on record, so I left it out of the window/);
  const week = turn("What did you send this week?", { ledger: { asOf: ISO(NOW), unreadable: [], tasks, receipts } }).out;
  assert.match(week.reply, /2 applications were sent in the last 7 days/);
});
test("#496/4 'approve the second application': named oldest first, never given as the card's number; the card answer by name", () => {
  const tasks = [
    { id: "prep:b", kind: "application", company: "Brightdesk", title: null, state: "awaiting_approval", since: ISO(NOW - 1800e3), evidence: {} },
    { id: "prep:a", kind: "application", company: "Acme Support", title: null, state: "awaiting_approval", since: ISO(NOW - 3600e3), evidence: {} },
  ];
  const pend = turn("Show my pending approvals", { ledger: { asOf: ISO(NOW), unreadable: [], tasks } }).out;
  assert.match(pend.reply, /oldest first: \(1\) Acme Support; \(2\) Brightdesk/);
  const pick = turn("Approve the second application", { ledger: { asOf: ISO(NOW), unreadable: [], tasks } }).out;
  assert.equal(pick.result.target.company, "Brightdesk");
  assert.doesNotMatch(pick.reply, /Number 2\b/);
  assert.match(pick.reply, /the card may number it differently/);
  assert.match(pick.reply, /reply "only brightdesk"/);
  assert.equal(sendsOf(pick), 0);
});
test("#496/1 no reading of the switches (null): no claim either way, and never 'not wired'", () => {
  const live = { employerSubmit: null, emailSend: null, batchExecutor: false };
  const r = turn("I said no, nothing should be sent", { live }).out;
  assert.doesNotMatch(r.reply, /Real submission to employers is on|switched off right now|not wired/);
  const m = turn("Who is the email sent from?", { live }).out;
  assert.doesNotMatch(m.reply, /Sending is on|switched off right now/);
  const named = turn("can you apply to the Support Rep role at Calm Co for me", { live }).out;
  assert.doesNotMatch(named.reply, /not wired|can't do in this conversation: send an application myself/);
});

// ---------------------------------------------------------------- the live switches (A2.4)
test("A2.4: the approval rule says what the live switches serve, never the in-turn browser stamp", () => {
  const on = turn("I said no, nothing should be sent", { live: { employerSubmit: true, emailSend: true, batchExecutor: false } }).out;
  assert.equal(on.intent, "career_approval_rule");
  assert.match(on.reply, /Real submission to employers is on/);
  assert.doesNotMatch(on.reply, /not wired/);
  const off = turn("I said no, nothing should be sent", { live: { employerSubmit: false, emailSend: false, batchExecutor: false } }).out;
  assert.match(off.reply, /switched off right now/);
  const unknown = turn("I said no, nothing should be sent").out;
  assert.doesNotMatch(unknown.reply, /not wired/, "with no switch reading, no claim either way");
  const mail = turn("Who is the email sent from?", { live: { employerSubmit: true, emailSend: false, batchExecutor: false } }).out;
  assert.match(mail.reply, /Sending email is switched off right now/);
});

// ---------------------------------------------------------------- the classifier's edges
test("classifier: named employers and other owners' shapes are left alone", () => {
  for (const t of ["did my application to Acme go through?", "what did you send to Stripe?", "apply to the top 3 for me", "apply to 3 software engineering intern roles",
    "yes", "show my applications", "how do approvals work", "where do I stand with Acme"]) {
    const a = Ledger.askOf(t);
    assert.ok(!a || a.kind === "status_all" && false, `"${t}" was claimed as ${a && a.kind}`);
  }
  assert.equal(Ledger.askOf("approve the 2nd one").ordinal, 2);
  assert.equal(Ledger.askOf("approve application #3").ordinal, 3);
  assert.equal(Ledger.askOf("apply to all those roles").kind, "list_apply_all");
  assert.equal(Ledger.askOf("ok apply to these").kind, "list_apply_all");
});
test("the shipped career bundle carries module 157 and the dispatch", async () => {
  const career = await import(path.join(root, "supabase/functions/_shared/router_core.career.js"));
  assert.equal(typeof career.CareerApplyLedger.askOf, "function");
  const h = CareerHost.createCareerHost(Object.fromEntries(["CareerAccess", "CareerOnboarding", "CareerRouter", "CareerDoorstep", "CareerReply", "CareerContainment"].map((n) => [n, career[n]])));
  const o = h.runTurn("Show my pending approvals", h.createTurnCtx({ userId: USER, threadId: "t-bundle", now: NOW, snapshot: null, profile: null, postings: [] }));
  assert.equal(o.intent, "career_pending_approvals", o.reply);
  assert.ok(!CareerHost.STATE_KEYS.includes("applyLedger") && !CareerHost.STATE_KEYS.includes("liveSwitches"), "runtime only, never persisted");
});
