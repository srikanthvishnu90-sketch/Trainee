"use strict";
/* CATCH-ALL REACHABILITY + BARE-REPLY WORDING (coordinator held-out
   rerun at 42621793, 2026-10-24) — fail-first.

   His private fresh set went banner 24/30 -> 17/30 at the
   generalization head, but the catch-all fired ONCE in 30 turns:
   unmatched in-scope asks still exited as the banner. Diagnosis
   (recorded in the lane report): the catch-all's gate required a
   question/request SPEECH ACT and a closed domain word list, so
   career statements, reported speech, fragments and context-only
   follow-ups were declined and exited via the legacy keyword tail
   inside dispatch or as a null the host containment wraps in the
   same banner text. Two wording defects ride along: a closing
   phrase ("never mind") recorded as the last-discussed topic, and
   "Nothing has been discussed yet" after earlier (unserved) turns,
   because the discussion record was serve-gated.

   These families are invented HERE — different topics and shapes
   from file v1's fifteen and from the coordinator's private set:
     - passed over for a promotion (statement)
     - which skill to learn first (question, no career lexicon)
     - a trainee got the role the user wanted (statement)
     - is a masters worth it (question, credential vocabulary)
     - bombed the final round (statement)
     - performance-plan news, then "what do i do first" (context)
     - references, then "can you email them" (context)
     - a bare fragment naming a profession and a city
   Controls pin the other side of the line: trivia, food, a
   pleasantry and a finance ask are NOT claimed by the catch-all.
   Check: node --test tests/career-textpath-catchall-reach-20261024.test.cjs */
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

function assertCatchAll(turn, what) {
  assert.equal(turn.fallback, false, `${what}: fell to the banner: ${turn.reply.slice(0, 140)}`);
  assert.equal(turn.intent, "career_catchall", `${what}: intent ${turn.intent}`);
  assert.match(turn.reply, /did not catch|didn't catch|not sure which part|What role, and which|I can check on that|Which company should we start/i, `${what}: catch-all shape (no claimed understanding)`);
  assert.doesNotMatch(turn.reply, /i understand/i, `${what}: must not claim understanding`);
  assert.equal(questionsIn(turn.reply), 1, `${what}: exactly one bounded question: ${turn.reply.slice(0, 200)}`);
}

// ---------- catch-all reachability: statements ----------

test("reach: a passed-over statement (no question, no request lead) does not exit as the banner", () => {
  // A named handler owns this shape (career_os_status) — the
  // property under test is the exit: served, never the banner.
  // The catch-all mechanism itself is pinned by the shapes
  // below that no handler owns.
  const [t1] = run("cr-passed", ["i got passed over for the promotion again"]);
  assert.equal(t1.fallback, false, `passed-over statement fell to the banner: ${t1.reply.slice(0, 140)}`);
  assert.equal(t1.intent, "career_os_status", `intent: ${t1.intent}`);
});

test("reach: a trainee-got-the-role statement exits via the catch-all", () => {
  const [t1] = run("cr-coworker", ["the person i trained just got the role i wanted"]);
  assertCatchAll(t1, "coworker statement");
});

test("reach: a bombed-the-final-round statement exits via the catch-all", () => {
  const [t1] = run("cr-bombed", ["pretty sure i bombed the final round yesterday"]);
  assertCatchAll(t1, "bombed statement");
});

test("reach: reported speech about a recruiter's ask exits via the catch-all", () => {
  const [t1] = run("cr-reported", ["a recruiter emailed asking what i earned in my last role"]);
  assertCatchAll(t1, "reported speech");
});

// ---------- catch-all reachability: questions without career lexicon ----------

test("reach: a which-skill-first question (no career word in it) exits via the catch-all", () => {
  const [t1] = run("cr-skill", ["which should i learn first, sql or tableau"]);
  assertCatchAll(t1, "skill-choice question");
});

test("reach: a masters-worth-it question exits via the catch-all", () => {
  const [t1] = run("cr-masters", ["is a masters worth it for breaking into product"]);
  assertCatchAll(t1, "masters question");
});

// ---------- catch-all reachability: fragments and context-only follow-ups ----------

test("reach: a bare fragment naming a profession and a city exits via the catch-all", () => {
  const [t1] = run("cr-fragment", ["roles for line cooks in tulsa"]);
  assertCatchAll(t1, "fragment");
});

test("reach: 'what do i do first' after career news resolves from the standing context", () => {
  const [t1, t2] = run("cr-newsfirst", ["i just got put on a performance plan", "what do i do first"]);
  assertCatchAll(t1, "performance-plan news");
  assertCatchAll(t2, "what-do-i-do-first follow-up");
});

test("reach: 'can you email them' after a references turn is not the banner", () => {
  const [t1, t2] = run("cr-refs", ["i need to line up my references", "can you email them for me"]);
  assertCatchAll(t1, "references turn");
  assert.equal(t2.fallback, false, `email follow-up fell to the banner: ${t2.reply.slice(0, 140)}`);
  assert.equal(t2.intent, "career_catchall", `email follow-up intent: ${t2.intent}`);
});

// ---------- controls: the banner keeps its (only) territory ----------

test("control: a trivia question is NOT claimed by the catch-all", () => {
  const [t1] = run("cr-trivia", ["what is the capital of norway"]);
  assert.notEqual(t1.intent, "career_catchall");
});

test("control: a food question is NOT claimed by the catch-all", () => {
  const [t1] = run("cr-food", ["what's a good marinade for salmon"]);
  assert.notEqual(t1.intent, "career_catchall");
});

test("control: a bare pleasantry is NOT claimed by the catch-all", () => {
  const [t1] = run("cr-thanks", ["thanks!"]);
  assert.notEqual(t1.intent, "career_catchall");
});

test("control: a finance ask keeps its own scope answer, NOT the catch-all", () => {
  const [t1] = run("cr-finance", ["how much did i spend on coffee last month"]);
  assert.notEqual(t1.intent, "career_catchall");
  assert.equal(t1.fallback, false, `finance ask fell to the banner: ${t1.reply.slice(0, 140)}`);
});

// ---------- defect A: a closing phrase is never the topic ----------

test("defect A: 'never mind' then 'yes' — the yes names the real topic, never the closing phrase", () => {
  const [, , t3] = run("cr-defect-a", ["whats my status with all my applications", "never mind", "yes"]);
  assert.equal(t3.intent, "conversation_bare_reply", `intent: ${t3.intent}`);
  assert.doesNotMatch(t3.reply, /“never mind”|was never mind/i, `closing phrase named as topic: ${t3.reply.slice(0, 200)}`);
  assert.match(t3.reply, /application tracker/i, `real topic not named: ${t3.reply.slice(0, 200)}`);
});

test("defect A: 'never mind' then 'undo' — same rule on the undo family", () => {
  const [, , t3] = run("cr-defect-a2", ["whats my status with all my applications", "never mind", "undo"]);
  assert.equal(t3.intent, "conversation_bare_reply", `intent: ${t3.intent}`);
  assert.doesNotMatch(t3.reply, /“never mind”|was never mind/i, `closing phrase named as topic: ${t3.reply.slice(0, 200)}`);
  assert.match(t3.reply, /application tracker/i, `real topic not named: ${t3.reply.slice(0, 200)}`);
});

// ---------- defect B: unserved turns still count as discussed ----------

test("defect B: a bare reply after an unserved turn names what was raised — never 'nothing discussed'", () => {
  const [, t2] = run("cr-defect-b", ["what's a good marinade for salmon", "yes"]);
  assert.equal(t2.intent, "conversation_bare_reply", `intent: ${t2.intent}`);
  assert.doesNotMatch(t2.reply, /Nothing has been discussed/i, `false empty-history claim: ${t2.reply.slice(0, 200)}`);
  assert.match(t2.reply, /raised/i, `raised topic not named as raised: ${t2.reply.slice(0, 200)}`);
  assert.match(t2.reply, /marinade/i, `the actual raised ask not named: ${t2.reply.slice(0, 200)}`);
});

test("defect B: two unserved turns, then 'go' — still no false 'nothing discussed' claim", () => {
  const [, , t3] = run("cr-defect-b2", ["the quarterly all-hands moved to friday", "and the offsite is now in march", "go"]);
  assert.equal(t3.intent, "conversation_bare_reply", `intent: ${t3.intent}`);
  assert.doesNotMatch(t3.reply, /Nothing has been discussed/i, `false empty-history claim: ${t3.reply.slice(0, 200)}`);
  assert.match(t3.reply, /raised/i, `raised topic not named as raised: ${t3.reply.slice(0, 200)}`);
});
