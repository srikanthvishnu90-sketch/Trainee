"use strict";
/* SPLIT-1146 (2026-10-25) — REWRITTEN under JOIN-1215 (2026-10-25):
   the four submission families, asserted at the HANDLER level.

   The first version of this suite asserted two ctx seams that were
   never part of the product (ctx.writeSubmitRecord /
   ctx.readApplicationStatus — invented stubs; the host never built
   them and they are asserted NOWHERE now). The real wiring is the
   production agent-chat handler on the merged tree, and this suite
   drives exactly its composition, in its order:

   - handler-career.ts:428 — a status ask is answered by
     applicationsTurn({ read: supabaseApplications(admin) }) from
     career_apply_jobs BEFORE the router runs.
   - handler-career.ts:518-521 — after host.runTurn, when the turn
     is the router's resume confirm (intent career_resume_ingest,
     completed), the handler runs resumeConfirmationContext over the
     thread and evidenceResumeConfirmation over the turn BEFORE the
     turn is saved (persistence.commit is below it).
   - The name/email/phone and work-authorization writes ride
     career_apply_questions.questionsTurn: the person's own words
     are offered back as drafts (contact_draft.ts /
     eligibility_draft.ts over the store's statements) and ONLY a
     "use N" saves one, through the same store.answer a typed answer
     takes. No "use N" — no write, and no reply claims one.

   The harness below composes the same real functions in the same
   order around CareerHost.runTurn (the router), with the
   production QuestionStore interface implemented in memory (the
   architect's own pattern, tests/architect/submit-real-person
   .test.ts fakeStore). Assertions are on behavior: what is
   stamped, offered, written, and said — never on a seam's calls.

   Disposition of the nine original seam tests (JOIN-1215):
   (a1) rewritten — handler evidence sequence over the live reply.
   (a2) rewritten — event store down: nothing stamped, executor
        keeps none (the trust contract's inputs asserted here;
        trustedProfile itself is proven in the deno suite, test 1).
   (b1) rewritten — questionsTurn offer + "use N" verbatim writes.
   (b2) rewritten — no "use N" / refused drafts: no write, no claim.
   (c1) rewritten — eligibility offer quotes the clause verbatim;
        "use N" writes the derived value.
   (c2) rewritten — hedged statement: no offer, no write, no claim.
   (d1) rewritten — applicationsTurn over career_apply_jobs rows.
   (d2) rewritten — applicationsTurn, named company, unconfirmed.
   (d3) rewritten — applicationsTurn with the record unreadable.
   Kept as they were (router-side, already seam-free, green):
   (a3) presented-content binding, (c3) correction wording,
   (d4) the 155 batch-row readback. New: (a4) an entry changed
   after presentation invalidates the yes (JOIN-1213 binding).

   Fixtures are synthetic. Nothing submits; CAREER_AGENT_SUBMIT
   stays OFF; the approve-first.ts certification carrier stays HELD.
   Check: node --test tests/career-submit-split-1146.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));
const Portal = D("149-career-portal-apply.js");
const Batch = D("155-career-batch-apply.js");
const { evidenceResumeConfirmation, resumeConfirmationContext, RESUME_CONFIRM_PROVENANCE } =
  require(path.join(root, "supabase/functions/_shared/career_router_evidence.ts"));
const { memoryEventStore } = require(path.join(root, "supabase/functions/_shared/agent/timeline.ts"));
const { questionsTurn, QUESTIONS_INTENT } = require(path.join(root, "supabase/functions/_shared/career_apply_questions.ts"));
const { applicationsTurn } = require(path.join(root, "supabase/functions/_shared/career_apply_status.ts"));

const NOW = Date.parse("2026-10-25T16:46:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const RESUME_TEXT = fs.readFileSync(path.join(root, "packages/career-data/fixtures/test-resume.txt"), "utf8");
const RESUME_SHA256 = crypto.createHash("sha256").update(RESUME_TEXT).digest("hex");

const MASTER_BASE = {
  basics: {
    name: "Alex Testcase", location: "Chicago, IL",
    email: "alex.testcase@example.test", phone: "+1 000 555 0100",
    resumeFile: "alex-testcase-resume.pdf", resumeSha256: "a".repeat(64),
  },
  facts: [
    { kind: "education", text: "B.S. Computer Science + Finance at TEST University, graduating May 2028", org: "TEST University", title: "B.S. Computer Science", end: "2028-05" },
    { kind: "skill", name: "Excel", text: "Skill: Excel", fact_id: "F-012", evidence: ["resume lists Excel"], unproven: false },
  ],
  constraints: { workAuthorization: "US citizen", needsSponsorship: false },
  preferences: { locations: ["Chicago"], starredCompanies: [] },
};
const FULL_ANSWERS = {
  work_authorization: { value: "Yes — authorized to work in the US", confirmed: true },
  sponsorship: { value: "No", confirmed: true },
  cover_note: { value: "I am excited to apply for the intern role.", confirmed: true, draft: true },
};
const ATTEST = { certify_true: { value: true, explicit: true } };

function makeWorld(opts) {
  const o = opts || {};
  const host = CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  });
  const master = clone(MASTER_BASE);
  if (o.master) Object.assign(master, clone(o.master));
  const store = { threads: new Map() };
  const log = { records: [] };
  let n = 0;
  const say = (userId, text, extra) => {
    const ex = extra || {};
    n += 1;
    const threadId = `t-${userId}`;
    const snap = ex.snapshot !== undefined ? ex.snapshot : (store.threads.get(threadId) || null);
    const input = { userId, threadId, now: NOW + (ex.nowOffset != null ? ex.nowOffset : n * 60000), accountPersistence: true, snapshot: snap, account: {}, watchState: {}, postings: ex.postings || [] };
    if (!ex.omitProfile) input.profile = master;
    const ctx = host.createTurnCtx(input);
    ctx.batchDeps = { log, boardFor: (p) => Object.assign({}, Portal.createSandboxBoard({}), { atsFamily: p.atsFamily }), attestations: ATTEST };
    const out = host.runTurn(text, ctx);
    store.threads.set(threadId, host.extractSnapshot(ctx));
    return { out, ctx };
  };
  const snapshotOf = (userId) => store.threads.get(`t-${userId}`);
  const profileOf = (userId) => { const s = snapshotOf(userId); return s && s.stores ? s.stores.profile : null; };
  return { say, snapshotOf, profileOf, master, log };
}

function pasteResume(w, U) {
  const { out } = w.say(U, RESUME_TEXT, { nowOffset: 0 });
  assert.equal(out.intent, "career_resume_ingest", `setup: the paste is ingested (got ${out.intent}: ${String(out.reply || "").slice(0, 160)})`);
  const drafts = (w.profileOf(U).facts || []).filter((f) => f && f.source === "resume-ingest" && f.needs_confirmation);
  assert.ok(drafts.length >= 3, "setup: resume drafts stand awaiting the person's word");
  return { drafts, pasteReply: out.reply };
}

// ---------- (a) 'yes that's my resume' — the handler evidence step ----------

test("(a) HANDLER: entries the router presented, confirmed by the person's exact yes, are stamped with their provenance event — and reach the executor's trust contract", async () => {
  const w = makeWorld({});
  const U = "split-a-handler";
  const { drafts, pasteReply } = pasteResume(w, U);
  for (const d of drafts) {
    assert.ok(pasteReply.includes(d.text), `the router's presenting reply shows the entry itself, not a count: ${d.text.slice(0, 60)}`);
  }
  const before = clone(w.profileOf(U));
  const yes = w.say(U, "Yes, that's my resume.", { nowOffset: 60000 });
  assert.equal(yes.out.intent, "career_resume_ingest");
  assert.equal(yes.out.resultStatus, "completed");
  const events = memoryEventStore();
  const rows = [
    { id: "2", role: "assistant", content: pasteReply },
    { id: "1", role: "user", content: RESUME_TEXT },
  ];
  const seen = await resumeConfirmationContext(rows, yes.ctx.profile);
  const r = await evidenceResumeConfirmation({
    userId: U, now: yes.ctx.now, message: "Yes, that's my resume.",
    before, after: yes.ctx.profile, out: yes.out,
    shown: seen.shown, upload: seen.upload, events,
  });
  assert.equal(r.stamped, drafts.length, "each presented, confirmed entry is stamped (a count-only reply stamps 0 — the 1a negative proof)");
  // The handler runs this step BEFORE persistence.commit
  // (handler-career.ts:518-521), so the record it saves is the
  // turn's own profile object, stamps included — not a snapshot
  // taken before the step ran.
  const after = yes.ctx.profile;
  const stampedFacts = (after.facts || []).filter((f) => f && f.confirmation_event_id);
  assert.equal(stampedFacts.length, drafts.length, "the stamped facts carry their confirmation event id — the field the executor's trust contract reads");
  for (const f of stampedFacts) {
    assert.ok(String(f.provenance || "").startsWith(RESUME_CONFIRM_PROVENANCE), `provenance is the owner-confirmation stamp: ${f.provenance}`);
  }
  const recorded = events.dump().filter((e) => e.kind === "fact_confirmed");
  assert.equal(recorded.length, drafts.length, "one persisted fact_confirmed event per stamped entry");
  for (const f of stampedFacts) {
    assert.ok(recorded.some((e) => e.detail && e.detail.confirmation_event_id === f.confirmation_event_id), `fact ${f.id} names its recorded event`);
  }
});

test("(a) HANDLER: when the provenance event cannot be recorded, nothing is stamped and the executor keeps none", async () => {
  const w = makeWorld({});
  const U = "split-a-noevent";
  const { drafts, pasteReply } = pasteResume(w, U);
  const before = clone(w.profileOf(U));
  const yes = w.say(U, "Yes, that's my resume.", { nowOffset: 60000 });
  const down = memoryEventStore();
  down.add = async () => { throw new Error("TEST: the event store is down"); };
  const rows = [
    { id: "2", role: "assistant", content: pasteReply },
    { id: "1", role: "user", content: RESUME_TEXT },
  ];
  const seen = await resumeConfirmationContext(rows, yes.ctx.profile);
  const r = await evidenceResumeConfirmation({
    userId: U, now: yes.ctx.now, message: "Yes, that's my resume.",
    before, after: yes.ctx.profile, out: yes.out,
    shown: seen.shown, upload: seen.upload, events: down,
  });
  assert.equal(r.stamped, 0, "an unrecordable event stamps nothing");
  const after = yes.ctx.profile; // the record the handler's commit would save (see (a1))
  const evidenced = (after.facts || []).filter((f) => f && (f.confirmation_event_id || f.provenance));
  assert.equal(evidenced.length, 0, "no fact carries a stamp or a provenance it does not have — the executor's trust contract keeps none of them");
  assert.ok(drafts.length >= 3, "setup held: the drafts were presented and confirmed in chat; they are simply unevidenced");
});

test("(a) ROUTER-SIDE binding: the yes confirms only the presented drafts — a draft that was never presented stays a draft", () => {
  const w = makeWorld({});
  const U = "split-a-binding";
  const { drafts } = pasteResume(w, U);
  const snap = clone(w.snapshotOf(U));
  snap.stores.profile.facts.push({ id: "F-UNPRESENTED", kind: "skill", name: "Unpresented Skill", title: "Unpresented Skill", text: "Skill: Unpresented Skill", source: "resume-ingest", needs_confirmation: true, status: "draft" });
  w.say(U, "Yes, that's my resume.", { snapshot: snap, omitProfile: true, nowOffset: 60000 });
  const facts = w.profileOf(U).facts || [];
  for (const d of drafts) {
    const now = facts.find((f) => f.id === d.id);
    assert.ok(now && !now.needs_confirmation, `presented draft ${d.id} is confirmed`);
  }
  const unpresented = facts.find((f) => f.id === "F-UNPRESENTED");
  assert.ok(unpresented && unpresented.needs_confirmation === true,
    "a generic yes must not approve content that was not in the presented resume");
});

test("(a) ROUTER-SIDE binding: an entry CHANGED after presentation invalidates the yes — nothing is confirmed from altered content", () => {
  const w = makeWorld({});
  const U = "split-a-tamper";
  pasteResume(w, U);
  const snap = clone(w.snapshotOf(U));
  const victim = snap.stores.profile.facts.find((f) => f && f.source === "resume-ingest" && f.needs_confirmation);
  assert.ok(victim, "setup: a presented draft stands");
  victim.text = `${victim.text} — EDITED AFTER PRESENTATION`;
  const { out } = w.say(U, "Yes, that's my resume.", { snapshot: snap, omitProfile: true, nowOffset: 60000 });
  const stillDrafts = (w.profileOf(U).facts || []).filter((f) => f && f.source === "resume-ingest" && f.needs_confirmation);
  assert.ok(stillDrafts.length >= 3, `the yes confirmed nothing from content that changed after it was shown: ${out.reply}`);
  assert.match(out.reply, /did not confirm/i, `the refusal is said plainly: ${out.reply}`);
});

// ---------- the questions store (production QuestionStore interface, in memory) ----------

const QQ = (id, key, label) => ({
  id, key, kind: "fact", label, type: "input_text", options: [], company: "TestCo 1", job_ids: ["j1"], misfit: false, answer: null,
});
function fakeQuestionStore(rows, statements) {
  const kv = {};
  const answers = [];
  let last = null;
  return {
    answers,
    setIntent(i) { last = i; },
    async open(_u, limit) { return rows.filter((r) => !r.answer || r.misfit).slice(0, limit); },
    async countOpen() { return rows.filter((r) => !r.answer || r.misfit).length; },
    async get(_u, ids) { return rows.filter((r) => ids.includes(r.id)); },
    async answer(_u, id, a) { const r = rows.find((x) => x.id === id); r.answer = a; r.misfit = false; answers.push([id, a]); },
    async shown() { return kv.shown ? clone(kv.shown) : null; },
    async setShown(_u, s) { kv.shown = clone(s); },
    async lastAssistantIntent() { return last; },
    statements: async () => statements,
  };
}
const QNOW = Date.parse("2026-10-25T16:46:00.000Z");
async function qSay(store, message, offsetMs) {
  const r = await questionsTurn({ message, userId: "split-q", threadId: "t-split-q", now: QNOW + (offsetMs || 0), store });
  if (r) store.setIntent(["shown", "partial", "answered_next"].includes(r.status) || r.status.startsWith("draft") ? QUESTIONS_INTENT : "career_apply_questions_answer");
  return r;
}
const CONTACT_TEXT = "My name is Rowan Ellery. My email is rowan.ellery@example.test. My phone is +1 555 010 0199.";
const CONTACT_QUESTIONS = () => [
  QQ("q-first", "fact:first_name", "First name"), QQ("q-last", "fact:last_name", "Last name"),
  QQ("q-email", "fact:email", "Email"), QQ("q-phone", "fact:phone", "Phone"),
];

// ---------- (b) name / email / phone from the person's own words ----------

test("(b) HANDLER: name/email/phone are offered back word for word from the person's own statement, and only 'use N' writes them — verbatim", async () => {
  const store = fakeQuestionStore(CONTACT_QUESTIONS(), [{ text: CONTACT_TEXT, at: "2026-10-24T14:00:00.000Z" }]);
  const shown = await qSay(store, "what do you need from me", 0);
  assert.ok(shown && shown.status === "shown", JSON.stringify(shown));
  assert.ok(shown.reply.includes(`"${CONTACT_TEXT}"`), `the offer quotes the person's exact words: ${shown.reply}`);
  assert.deepEqual(store.answers, [], "showing the offer writes nothing");
  // One question at a time (review of #360): each draft is "use 1" on the question shown; the next is asked in the reply.
  for (const n of [1, 2, 3, 4]) {
    const r = await qSay(store, "use 1", n * 1000);
    assert.ok(r && /Saved, as drafted/.test(r.reply), `draft ${n} saved: ${r && r.reply}`);
    if (n < 4) assert.ok(/Next: /.test(r.reply) && r.reply.includes(`"${CONTACT_TEXT}"`), `the next question with its offer: ${r.reply}`);
  }
  assert.deepEqual(store.answers, [
    ["q-first", "Rowan"], ["q-last", "Ellery"],
    ["q-email", "rowan.ellery@example.test"], ["q-phone", "+1 555 010 0199"],
  ], "each field is written with the person's verbatim value — no normalization, no paraphrase");
});

test("(b) HANDLER: with no 'use N' there is no write and no saved claim; a hedged or third-party statement is never offered", async () => {
  const store = fakeQuestionStore(CONTACT_QUESTIONS(), [{ text: CONTACT_TEXT, at: "2026-10-24T14:00:00.000Z" }]);
  const shown = await qSay(store, "what do you need from me", 0);
  assert.ok(shown && shown.status === "shown");
  const other = await qSay(store, "not yet — I'll answer later", 1000);
  assert.deepEqual(store.answers, [], "no 'use N' was said, so the host wrote nothing");
  assert.ok(!/Saved/.test((other && other.reply) || ""), "no reply claims a save that did not happen");
  const hedged = fakeQuestionStore(CONTACT_QUESTIONS(), [
    { text: "my email is changing soon, maybe jr@example.test", at: "2026-10-24T14:00:00.000Z" },
    { text: "my sister's phone number is 312-555-9999", at: "2026-10-24T14:00:00.000Z" },
  ]);
  const hShown = await qSay(hedged, "what do you need from me", 0);
  assert.ok(hShown, "the questions themselves are still shown");
  assert.ok(!hShown.reply.includes("jr@example.test") && !hShown.reply.includes("312-555-9999"),
    `a hedge and someone else's number are offered as nothing: ${hShown.reply}`);
  assert.deepEqual(hedged.answers, [], "and nothing is written from them");
});

// ---------- (c) work-authorization replies ----------

const WA_TEXT = "Update my work authorization — I no longer need sponsorship.";
const WA_MASTER = { constraints: { workAuthorization: "F-1 OPT (TEST) — will need sponsorship", needsSponsorship: true } };
const WA_QUESTIONS = () => [
  QQ("q-wa", "fact:work_authorization", "Are you authorized to work in the US?"),
  QQ("q-sp", "fact:sponsorship", "Will you require sponsorship?"),
];

test("(c) HANDLER: a work-authorization statement is offered back in the person's own words, and only 'use N' writes it", async () => {
  const store = fakeQuestionStore(WA_QUESTIONS(), [{ text: WA_TEXT, at: "2026-10-24T14:00:00.000Z" }]);
  const first = await qSay(store, "what do you need from me", 0);
  assert.ok(first && first.status === "shown", JSON.stringify(first));
  // One question at a time: work authorization first (the statement does not answer it), "skip" moves to sponsorship.
  const shown = await qSay(store, "skip", 500);
  assert.ok(shown && shown.status === "answered_next", JSON.stringify(shown));
  assert.ok(shown.reply.includes(`"${WA_TEXT}"`), `the offer quotes the person's verbatim clause: ${shown.reply}`);
  assert.deepEqual(store.answers, [], "the offer alone writes nothing");
  const used = await qSay(store, "use 1", 1000);
  assert.ok(used && /Saved, as drafted/.test(used.reply), used && used.reply);
  assert.deepEqual(store.answers, [["q-sp", "No"]],
    "the sponsorship answer the statement carries — needsSponsorship false — is what 'use N' writes; the work-authorization question the statement does not answer stays open");
});

test("(c) HANDLER: a hedged work-authorization statement offers nothing, writes nothing, and claims nothing", async () => {
  const store = fakeQuestionStore(WA_QUESTIONS(), [{ text: "I might not need sponsorship anymore, not sure yet", at: "2026-10-24T14:00:00.000Z" }]);
  const shown = await qSay(store, "what do you need from me", 0);
  assert.ok(shown, "the questions themselves are still shown");
  assert.ok(!shown.reply.includes("not sure yet"), `a hedge is never dressed as a draft answer: ${shown.reply}`);
  assert.deepEqual(store.answers, [], "nothing is written from a hedge");
  assert.ok(!/Saved/.test(shown.reply), "and no save is claimed");
});

test("(c) ROUTER-SIDE wording: with no host writer installed, the reply never claims 'saved' or a ready packet", () => {
  const w = makeWorld({ master: WA_MASTER }); // no writer seam exists in the real design at all
  const U = "split-c-wording";
  const { out } = w.say(U, WA_TEXT, { nowOffset: 0 });
  assert.doesNotMatch(out.reply, /I saved|saved your|packet is ready/i,
    `no success wording without a confirmed host write: ${out.reply}`);
  assert.match(out.reply, /not confirmed|not calling it saved|no confirmed .* write/i,
    `the reply says plainly the write is not confirmed: ${out.reply}`);
  assert.match(out.reply, /invalid|stale|will not be submitted/i,
    "the stale-packet protection is still spoken: a packet built on the old answer does not go out");
});

// ---------- (d) application status readback — career_apply_jobs, before the router ----------

const APP_ROWS = [
  { id: "row-1", company: "TestCo 1", title: "Software Engineering Intern", state: "queued", created_at: "2026-10-24T16:00:00.000Z", updated_at: "2026-10-24T16:00:00.000Z" },
  { id: "row-2", company: "TestCo 2", title: "Data Analyst Intern", state: "submitted_unconfirmed", confirmation_id: "SBX-0002", created_at: "2026-10-24T16:00:00.000Z", updated_at: "2026-10-24T16:00:00.000Z" },
  { id: "row-3", company: "TestCo 3", title: "Finance Intern", state: "confirmed", confirmation_id: "SBX-0001", created_at: "2026-10-24T16:00:00.000Z", updated_at: "2026-10-24T16:00:00.000Z" },
];
const readRows = (rows) => async () => clone(rows);

test("(d) HANDLER: 'where are my applications' is answered from career_apply_jobs, each row in its recorded state", async () => {
  const r = await applicationsTurn({ message: "where are my applications?", userId: "split-d", now: NOW, read: readRows(APP_ROWS) });
  assert.ok(r, "the handler answers the ask before the router");
  assert.ok(r.reply.includes("TestCo 1") && /approved, not sent yet/.test(r.reply), `the queued row reads as approved, not sent yet: ${r.reply}`);
  assert.ok(r.reply.includes("TestCo 2") && /has not confirmed it yet/.test(r.reply), `the unconfirmed row says the employer has not confirmed: ${r.reply}`);
  assert.ok(r.reply.includes("TestCo 3") && /submitted, and TestCo 3 confirmed it \(confirmation SBX-0001\)/.test(r.reply), `only the confirmed row reads as submitted, with its recorded id: ${r.reply}`);
  const line1 = r.reply.split("\n").find((l) => l.includes("TestCo 1"));
  const line2 = r.reply.split("\n").find((l) => l.includes("TestCo 2"));
  assert.ok(line1 && !/and TestCo 1 confirmed it/.test(line1), "no other row borrows the confirmed wording");
  assert.ok(line2 && !/and TestCo 2 confirmed it/.test(line2) && /has not confirmed it yet/.test(line2),
    "the unconfirmed row's own line says the opposite of confirmed");
});

test("(d) HANDLER: 'did X go through' never says submitted for a row with no recorded confirmation", async () => {
  const r = await applicationsTurn({ message: "did my application to TestCo 1 go through?", userId: "split-d", now: NOW, read: readRows(APP_ROWS) });
  assert.ok(r, "the named ask is answered from the record");
  assert.doesNotMatch(r.reply, /\bsubmitted\b/i, `no 'submitted' without a recorded confirmation: ${r.reply}`);
  assert.match(r.reply, /not sent yet/, `the row's real state is spoken: ${r.reply}`);
});

test("(d) HANDLER: when the record cannot be read, the reply says it cannot say — it does not invent an empty record", async () => {
  const r = await applicationsTurn({
    message: "where are my applications?", userId: "split-d", now: NOW,
    read: async () => { throw new Error("TEST: the record is down"); },
  });
  assert.ok(r, "the ask is still answered — honestly");
  assert.match(r.reply, /couldn't read your applications/i, r.reply);
  assert.match(r.reply, /can't say whether any were sent/i, r.reply);
  assert.doesNotMatch(r.reply, /holds no applications|no applications on record|no application to/i,
    "an unreadable record is never spoken as an empty one");
});

test("(d) ROUTER-SIDE wording on an existing batch row: a submission with no recorded confirmation is never spoken as submitted", () => {
  const log = { records: [] };
  const boardFor = (p) => Object.assign({}, Portal.createSandboxBoard({}), {
    atsFamily: p.atsFamily,
    submit() { return { outcome: "accepted" }; },
    submissionState() { return { submitted: true, confirmationId: null }; },
  });
  const profile = { name: "Alex Testcase", email: "alex.testcase@example.test", phone: "+1 000 555 0100", location: "Chicago, IL", resume: { filename: "alex-testcase-resume.pdf", sha256: "a".repeat(64) }, answers: clone(FULL_ANSWERS) };
  const posting = {
    id: "JOB-S-1", job_id: "JOB-S-1", canonicalKey: "greenhouse:testco1:software-engineering-intern",
    company: "TestCo 1", role: "Software Engineering Intern", title: "Software Engineering Intern",
    url: "https://boards.greenhouse.io/testco1/jobs/1", status: "open", atsFamily: "greenhouse",
    location: "Chicago, IL", posted_at: "2026-10-10",
    jd_text: "Software engineering intern role. JavaScript, testing, code review, agile team.",
  };
  const run = Batch.createRun({ userId: "split-d-row", familyKey: "software-engineering", familyText: "software engineering", count: 1, now: NOW });
  Batch.prepareRun(run, { postings: [posting], profile, log, boardFor, attestations: ATTEST });
  assert.equal(Batch.approveRun(run, { approvedByUser: true, now: NOW, userId: run.userId, profileSha256: run.profileSha256 }).ok, true);
  Batch.executeRun(run, { now: NOW, profile, log, boardFor });
  const app = Object.values(run.apps)[0];
  assert.equal(app.stage, "submitted", "setup: the drive landed");
  assert.ok(!app.confirmationId, "setup: no employer confirmation is recorded on the row");
  const lines = Batch.speakSummary(run);
  assert.notEqual(lines[0], "1/1 applications submitted.", "the headline must not claim submitted without a recorded confirmation");
  assert.ok(lines.some((l) => /not counted as submitted/i.test(l)), `the readback says so plainly: ${lines.join(" | ")}`);
  assert.ok(!lines.some((l) => l.includes("(null)")), "no fabricated '(null)' confirmation is printed");
  assert.equal(Batch.summarizeRun(run).confirmations.length, 0, "the confirmations list holds only recorded employer confirmations");
});
