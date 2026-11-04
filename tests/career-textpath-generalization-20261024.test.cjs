"use strict";
/* GENERALIZATION (coordinator directive 2026-10-24 14:04) — fail-first.
   File v1's fixes keyed too closely to its fifteen conversations:
   on a fresh private family the banner still took 24/30. These
   tests exercise the four MECHANISMS on families invented here —
   different topics and shapes from file v1's fifteen and from the
   coordinator's private families:
     (1) catch-all after all handlers (AMENDED 14:09: no claimed
         understanding, no restated intent — didn't catch + the
         REALLY served capabilities + ONE bounded question; no
         canned specifics on deadlines/legal/benefits)
     (2) bare-reply resolver (no pending question, no standing
         offer -> name the last thing discussed, never the banner,
         never a record confirm)
     (3) frame carry for follow-up/draft frames (silence reports
         and held drafts resolve their follow-ups from the frame)
     (4) intent/life-event statements are NOT goals (the event
         verb governs the job noun -> no goal write; a human reply
         plus a next-step offer instead)
   The coordinator's two NAMED wrong answers are in their own
   section at the bottom, labeled as what they are: coordinator-
   supplied regression shapes, not invented families.
   Check: node --test tests/career-textpath-generalization-20261024.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const { FALLBACK_TEXT_RE } = (() => { try { return require(path.join(ROOT, "packages/domain/140-career-reply.js")); } catch { return {}; } })();
const FALLBACK_RE = FALLBACK_TEXT_RE || /^(I didn't catch that|I'm Trainee, a career agent: I find roles)/;

const NOW = Date.parse("2026-10-24T15:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
const POSTINGS = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/career/conversations.json"), "utf8")).postings;

function makeWorld() {
  const host = CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  });
  const store = { accounts: new Map(), threads: new Map(), watches: new Map() };
  let n = 0;
  const say = (userId, text) => {
    n += 1;
    const threadId = `t-${userId}`;
    const ctx = host.createTurnCtx({ userId, threadId, now: NOW + n * 60000, accountPersistence: true, snapshot: store.threads.get(threadId) || null, account: clone(store.accounts.get(userId) || {}), watchState: clone(store.watches.get(userId) || {}), postings: POSTINGS });
    const out = host.runTurn(text, ctx);
    const snap = host.extractSnapshot(ctx);
    store.threads.set(threadId, snap);
    if (ctx._hostPatch) {
      if (ctx._hostPatch.erase === true) store.accounts.set(userId, { paused: true });
      else { const a = store.accounts.get(userId) || {}; for (const k of Object.keys(ctx._hostPatch)) a[k] = clone(ctx._hostPatch[k]); store.accounts.set(userId, a); }
    }
    const reply = String((out && out.reply) || "");
    const intent = out ? out.intent : null;
    return { intent, reply, fallback: Boolean(!intent || FALLBACK_RE.test(reply)), status: out ? out.resultStatus : null };
  };
  return { say };
}
const run = (uid, turns) => { const w = makeWorld(); return turns.map((t) => w.say(uid, t)); };
const questionsIn = (reply) => (String(reply).match(/\?/g) || []).length;

// ---------- (1) catch-all after all handlers ----------

test("mech1: an unmatched in-scope question gets didn't-catch + real capabilities + exactly one bounded question (no claimed understanding)", () => {
  const [t1] = run("gz-probation", ["can you explain how a probationary period usually changes notice obligations"]);
  assert.equal(t1.fallback, false, `fell back: ${t1.reply.slice(0, 120)}`);
  assert.equal(t1.intent, "career_catchall");
  assert.match(t1.reply, /did not catch|didn't catch|not sure which part|What role, and which|I can check on that|Which company should we start/i);
  assert.doesNotMatch(t1.reply, /i understand/i);
  assert.doesNotMatch(t1.reply, /notice obligations/);
  assert.match(t1.reply, /watch|track|prep/i);
  assert.equal(questionsIn(t1.reply), 1, `exactly one bounded question: ${t1.reply.slice(0, 200)}`);
});

test("mech1: a second unmatched topic (contract clawback) lands in the same catch-all, not a template", () => {
  const [t1] = run("gz-clawback", ["what is a clawback in an employment contract"]);
  assert.equal(t1.fallback, false, `fell back: ${t1.reply.slice(0, 120)}`);
  assert.equal(t1.intent, "career_catchall");
  assert.doesNotMatch(t1.reply, /weekly budget|study plan/i);
  assert.doesNotMatch(t1.reply, /i understand/i);
});

test("mech1 control: a non-career question is NOT claimed by the catch-all", () => {
  const [t1] = run("gz-noncareer", ["what is the capital of norway"]);
  assert.notEqual(t1.intent, "career_catchall");
});

// ---------- (2) bare-reply resolver ----------

test("mech2: 'never mind' after a completed serve names the last thing discussed", () => {
  const [, t2] = run("gz-bare-facts", ["I'm a junior at DePaul studying finance", "never mind"]);
  assert.equal(t2.fallback, false, `fell back: ${t2.reply.slice(0, 120)}`);
  assert.equal(t2.intent, "conversation_bare_reply");
  assert.match(t2.reply, /record|discussed/i);
});

test("mech2: 'undo' after a completed tracker read names the tracker and reverses nothing silently", () => {
  const [, t2] = run("gz-bare-undo", ["whats my status with all my applications", "undo"]);
  assert.equal(t2.fallback, false, `fell back: ${t2.reply.slice(0, 120)}`);
  assert.equal(t2.intent, "conversation_bare_reply");
  assert.match(t2.reply, /tracker|application/i);
});

test("mech2: a bare 'yes' with nothing discussed yet asks 'yes to what' instead of the banner", () => {
  const [t1] = run("gz-bare-first", ["yes"]);
  assert.equal(t1.fallback, false, `fell back: ${t1.reply.slice(0, 120)}`);
  assert.equal(t1.intent, "conversation_bare_reply");
  assert.match(t1.reply, /yes to what/i);
});

test("mech2: TWO standing frames and a bare 'yes' — the reply names BOTH and asks which, confirming nothing", () => {
  const [, t2] = run("gz-bare-twoframes", ["i applied at Northbridge two weeks ago and heard nothing", "yes"]);
  assert.equal(t2.fallback, false, `fell back: ${t2.reply.slice(0, 120)}`);
  assert.equal(t2.intent, "conversation_bare_reply", `intent: ${t2.intent}`);
  assert.match(t2.reply, /tracker/i);
  assert.match(t2.reply, /follow.?up/i);
  assert.match(t2.reply, /which/i);
  assert.doesNotMatch(t2.reply, /stands exactly as read back|recorded —/i);
});

test("mech2 control: a bare yes against a pending record read-back still record-confirms (existing binding owns it)", () => {
  const [, t2] = run("gz-bare-pending", ["I'm a sophomore at DePaul studying finance and computer science", "yes that's right"]);
  assert.equal(t2.intent, "profile_correction");
  assert.match(t2.reply, /stands exactly as read back/);
});

// ---------- (3) frame carry: silence report + held draft ----------

test("mech3: a silence report opens a follow-up frame; the deictic ask and the draft bind to it", () => {
  const [t1, t2, t3] = run("gz-ghost", ["i applied at Northbridge two weeks ago and heard nothing", "what should i do about that", "draft it"]);
  assert.equal(t1.intent, "tracking_log");
  assert.equal(t2.fallback, false, `T2 fell back: ${t2.reply.slice(0, 120)}`);
  assert.match(t2.reply, /Northbridge/);
  assert.equal(t3.fallback, false, `T3 fell back: ${t3.reply.slice(0, 120)}`);
  assert.match(t3.reply, /held|approval/i);
});

test("mech3: the held follow-up draft carries — a revision and a sent-status question bind to the draft frame", () => {
  const w = makeWorld();
  const uid = "gz-draft";
  w.say(uid, "i applied at Northbridge two weeks ago and heard nothing");
  w.say(uid, "what should i do about that");
  const t3 = w.say(uid, "draft it");
  assert.equal(t3.fallback, false, `T3 fell back: ${t3.reply.slice(0, 120)}`);
  assert.match(t3.reply, /Subject:|follow-up/i, "T3 must be the follow-up draft itself");
  const t4 = w.say(uid, "make it shorter");
  assert.equal(t4.fallback, false, `T4 fell back: ${t4.reply.slice(0, 120)}`);
  assert.doesNotMatch(t4.reply, /no draft in this conversation/i);
  assert.match(t4.reply, /Northbridge/);
  assert.ok(t4.reply.length < t3.reply.length + 400, "the revision is a shorter take on the standing draft, not a new topic");
  const t5 = w.say(uid, "did you send it");
  assert.equal(t5.fallback, false, `T5 fell back: ${t5.reply.slice(0, 120)}`);
  assert.match(t5.reply, /not sent|nothing (was |has been )?sent|held/i);
});

// ---------- (4) intent statements are not goals ----------

test("mech4: 'i want to accept this job offer' is a decision about a specific offer, not a career goal", () => {
  const [t1, t2] = run("gz-accept", ["i want to accept this job offer tomorrow", "what's my career goal?"]);
  assert.notEqual(t1.intent, "career_goal_record");
  assert.equal(t1.fallback, false, `T1 fell back: ${t1.reply.slice(0, 120)}`);
  // AMENDED shape (14:09 (2)): one human line, then ask what they
  // want help with — no canned plan, no stored anything.
  assert.match(t1.reply, /what do you want help with/i);
  assert.doesNotMatch(t1.reply, /the useful next step/i);
  assert.doesNotMatch(t2.reply, /career goal is to accept/i);
});

test("mech4: 'i want to decline the job offer' is likewise an event, not a target", () => {
  const [t1, t2] = run("gz-decline", ["i want to decline the job offer on friday", "what's my career goal?"]);
  assert.notEqual(t1.intent, "career_goal_record");
  assert.equal(t1.fallback, false, `T1 fell back: ${t1.reply.slice(0, 120)}`);
  assert.doesNotMatch(t2.reply, /career goal is to decline/i);
});

test("mech4 control: a genuine target statement still records as a goal", () => {
  const [t1] = run("gz-goal-ctl", ["i want product management jobs in chicago"]);
  assert.equal(t1.intent, "career_goal_record", `control intent: ${t1.intent}`);
});

// ---------- coordinator-named wrong answers (regression, NOT invented families) ----------

test("named: 'i want to quit my job tomorrow' is not saved as a career goal", () => {
  const [t1, t2] = run("gz-named-quit", ["i want to quit my job tomorrow", "what's my career goal?"]);
  assert.notEqual(t1.intent, "career_goal_record");
  assert.equal(t1.fallback, false, `T1 fell back: ${t1.reply.slice(0, 120)}`);
  assert.doesNotMatch(t2.reply, /career goal is to quit/i);
});

test("named: 'how much time do i have for unemployment' is not answered by the study-plan template", () => {
  const [t1] = run("gz-named-unemp", ["how much time do i have for unemployment"]);
  assert.notEqual(t1.intent, "company_intel");
  assert.doesNotMatch(t1.reply, /weekly budget|minutes total|study plan/i);
  assert.equal(t1.fallback, false, `fell back: ${t1.reply.slice(0, 120)}`);
  assert.equal(t1.intent, "career_catchall");
  // AMENDED (14:09 (1)): for entitlement topics the reply may
  // only say it depends on where they live and point to the
  // state agency — no deadlines, no amounts, no specifics.
  assert.match(t1.reply, /depend on where you live/i);
  assert.match(t1.reply, /state/i);
  assert.doesNotMatch(t1.reply, /\d+\s*(days?|weeks?|months?)\b/i);
});
