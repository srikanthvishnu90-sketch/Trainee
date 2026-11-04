"use strict";
// P8 (Depth Lane D, 2026-10-16) — the frozen gauntlet probe, verbatim:
//   t1 "let me know the second any new grad data roles open up in Chicago"
//   t2 "yes, set that up for me"
// On v223 both turns fell to the generic fallback live. The seam showed
// why, in three layers: (1) 142's create-watch dispatch regexes only knew
// the manual's dialect ("watch for", "alert me when") — "let me know …
// open up" matched nothing; (2) watchRoleFromText resolved roles only by
// curated title terms, and nobody's ask says "data analyst roles" — they
// say "data roles"; (3) a bare affirmation had no handler at all, so the
// confirmation turn could only fall back. The fix is chat-layer only
// (142's dispatch + role aliases + a recency-gated, read-only affirm
// handler) and is NOT deployed by this lane — it rides the branch for the
// owner's deploy tap. These tests pin, through the career_host seam:
//   P8 verbatim, profile on file -> t1 CREATES the Data Analyst watch
//   (Chicago, new_grad), t2 confirms it from the saved record and creates
//   nothing twice; P8 verbatim with NO profile -> t1 reaches the watch
//   intent's own profile gate (its honest reply), never the generic
//   fallback; a stray affirmation with no recent watch falls through.
// Fail-first: on the base commit all three P8 assertions fail (fallback).
// Check: node --test tests/career-p8-watch-phrasing.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));
const A = D("152-career-assign.js");

const seam = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"),
  CareerOnboarding: D("130-career-onboarding.js"),
  CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"),
  CareerReply: D("140-career-reply.js"),
  CareerContainment: D("143-career-containment.js"),
});

const USER = "user-p8-lane-d";
const NOW = Date.parse("2026-10-16T15:00:00.000Z");
const PROFILE122 = {
  basics: { name: "Alex Testcase", location: "Chicago, IL" },
  facts: [
    { kind: "education", text: "B.S. Computer Science + Finance at TEST University, graduating May 2028", org: "TEST University", title: "B.S. Computer Science", end: "2028-05" },
    { kind: "skill", name: "Python", text: "Skill: Python", fact_id: "F-010", evidence: ["resume lists Python"], unproven: false },
  ],
  constraints: { workAuthorization: "US citizen", needsSponsorship: false },
  preferences: { locations: ["Chicago"], starredCompanies: [] },
};
const P8_T1 = "let me know the second any new grad data roles open up in Chicago";
const P8_T2 = "yes, set that up for me";

test("P8 t1 verbatim creates the Data Analyst watch (Chicago, new-grad) when a profile is on file", () => {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "p8-1", now: NOW, snapshot: null, profile: PROFILE122 });
  const r = seam.runTurn(P8_T1, ctx);
  assert.equal(r.intent, "career_watch_create", r.reply);
  assert.equal(r.resultStatus, "prepared", r.reply);
  assert.doesNotMatch(r.reply, /didn't catch that|I'm Trainee, a career agent: I find roles/i);
  const wp = seam.extractSnapshot(ctx).stores.alertWatchState[A.PROFILE_KEY(USER)];
  assert.ok(wp, "the watch profile must be saved");
  assert.equal(wp.interests.length, 1);
  assert.equal(wp.interests[0].role.title, "Data Analyst");
  assert.deepEqual(wp.interests[0].filters.locations, ["Chicago"]);
  assert.ok(wp.interests[0].filters.bands.includes("new_grad"), JSON.stringify(wp.interests[0].filters));
});

test("P8 t2 verbatim confirms the just-created watch and creates nothing twice", () => {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "p8-2", now: NOW, snapshot: null, profile: PROFILE122 });
  seam.runTurn(P8_T1, ctx);
  const r2 = seam.runTurn(P8_T2, ctx);
  assert.doesNotMatch(r2.reply, /didn't catch that|I'm Trainee, a career agent: I find roles/i, r2.reply);
  assert.match(r2.reply, /Data Analyst/, r2.reply);
  const wp = seam.extractSnapshot(ctx).stores.alertWatchState[A.PROFILE_KEY(USER)];
  assert.equal(wp.interests.length, 1, "the affirmation must not duplicate the watch");
});

// OWNER RULE (2026-10-28): with no profile the stated watch is created (it was held at a profile gate).
test("P8 t1 verbatim with no profile creates the watch — never the generic fallback", () => {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "p8-3", now: NOW, snapshot: null, profile: null });
  const r = seam.runTurn(P8_T1, ctx);
  assert.equal(r.intent, "career_watch_create", r.reply);
  assert.equal(r.resultStatus, "prepared", r.reply);
  assert.doesNotMatch(r.reply, /didn't catch that|I'm Trainee, a career agent: I find roles/i);
});

test("control: a bare affirmation with no recent watch is not watch business", () => {
  const ctx = seam.createTurnCtx({ userId: USER, threadId: "p8-4", now: NOW, snapshot: null, profile: PROFILE122 });
  const r = seam.runTurn(P8_T2, ctx);
  assert.notEqual(r.intent, "career_watch_affirm");
  assert.doesNotMatch(r.reply, /Already set/, r.reply || "");
});
