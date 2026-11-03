"use strict";
// ROUTER-EVAL FIX 3 (2026-10-22): the job-watch profile gate must leave
// the record in the state the reply states.
//
// The gate in 142's handleWatchCreate tested only ctx.profile (the 122
// master profile, which rides the PER-THREAD snapshot), while the 152
// watch record is PER-USER and carries its own scoring basis. A user in
// a fresh thread — no master profile in the thread snapshot, a standing
// watch record on the account — was told "I need your profile on file
// first… with no profile there is nothing honest to match against… say
// the watch again", while the record held a live watch profile the
// read-back listed in the same thread, and the requested watch was
// refused even though the record carries the basis creation uses.
//
// These cases are synthetic (invented users, roles, cities); no
// held-out eval case is used as a fixture. Driven through the
// career_host seam (120 -> 130 -> 142 -> 141), the product's own
// composition.
// Check: node --test tests/career-router-fix3-watch-gate.test.cjs
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

const NOW = Date.parse("2026-10-22T16:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));

const USER = "user-fix3-lena";
const ASK = "Watch for software engineering intern roles in Seattle";

// A standing 152 watch record, as an earlier session (when a master
// profile existed) would have saved it: one Data Analyst interest in
// Austin, plus — when withBasis — its own scoring_profile, the match
// basis the host cycle polls on.
function standingRecord(userId, withBasis) {
  const wp = A.createWatchProfile(userId, withBasis
    ? { scoring_profile: { skills: [{ name: "SQL" }], degree: "B.S.", level: "student", experience_years: 1, experience_text: "", summary: "", constraints: {}, preferences: { locations: ["Austin"] } } }
    : {});
  if (!withBasis) delete wp.scoring_profile;
  A.upsertInterest(wp, {
    interest_id: "int-data-analyst",
    role: A.roleSpecFor({ split: "Data Analyst" }),
    filters: { locations: ["Austin"], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] },
    created_at: new Date(NOW - 86400000).toISOString(),
  });
  return wp;
}

function turn(userId, threadId, text, opts) {
  const o = opts || {};
  const ctx = seam.createTurnCtx({
    userId, threadId, now: o.now || NOW, accountPersistence: true,
    snapshot: o.snapshot || null, account: {}, watchState: o.watchState || {},
    postings: [], profile: o.profile,
  });
  const out = seam.runTurn(text, ctx);
  const snap = seam.extractSnapshot(ctx);
  return { out, ctx, snap };
}

const recordOf = (snap, userId) => ((snap.stores || {}).alertWatchState || {})[A.PROFILE_KEY(userId)] || null;
const titlesOf = (wp) => (wp ? wp.interests.map((i) => i.role.title) : []);

test("fix3 defect: standing watch record + no master profile in thread -> the watch ask is served, not gated", () => {
  const seed = standingRecord(USER, true);
  const watchState = { [A.PROFILE_KEY(USER)]: clone(seed) };
  const r = turn(USER, "fx3-t1", ASK, { watchState });
  assert.equal(r.out.intent, "career_watch_create", r.out.reply);
  assert.equal(r.out.resultStatus, "prepared", `the record carries the basis, so creation must proceed — got: ${r.out.reply}`);
  assert.doesNotMatch(r.out.reply, /profile on file first/i, "the reply must not claim a profile is missing when the watch record stands");
  assert.match(r.out.reply, /Software Engineering/, r.out.reply);
  const wp = recordOf(r.snap, USER);
  assert.ok(wp, "the watch record must persist");
  assert.deepEqual(titlesOf(wp).sort(), ["Data Analyst", "Software Engineering Intern / New-Grad"], `both interests on the record: ${JSON.stringify(titlesOf(wp))}`);
  // The standing record's own scoring basis is kept, never overwritten.
  assert.deepEqual(wp.scoring_profile, seed.scoring_profile, "the record's scoring basis is the one it already held");
});

test("fix3 read-back: after the served ask, 'what am I watching?' names both roles from the record", () => {
  const seed = standingRecord(USER, true);
  const watchState = { [A.PROFILE_KEY(USER)]: clone(seed) };
  const first = turn(USER, "fx3-t2", ASK, { watchState });
  // The next turn loads the watch state the first turn's commit wrote
  // back (the deployed load returns the committed per-user record),
  // not the stale seed this test started from.
  const committed = (first.snap.stores || {}).alertWatchState || {};
  const second = turn(USER, "fx3-t2", "What am I watching?", { snapshot: first.snap, watchState: committed, now: NOW + 60000 });
  assert.equal(second.out.intent, "career_watch_manage", second.out.reply);
  assert.match(second.out.reply, /Data Analyst/, second.out.reply);
  assert.match(second.out.reply, /Software Engineering/, second.out.reply);
  assert.doesNotMatch(second.out.reply, /no job watches/i, second.out.reply);
});

// OWNER RULE (2026-10-28, Telegram-first list #4): a new person's "set a job alert for <role> in <city>" creates the
// watch on the role and place they stated; the old profile gate held every first alert. Only an ask with no role stops.
test("fix3 control (owner 2026-10-28): no master profile and no standing record -> the stated watch is created", () => {
  const r = turn(USER, "fx3-t3", ASK, { watchState: {} });
  assert.equal(r.out.intent, "career_watch_create", r.out.reply);
  assert.equal(r.out.resultStatus, "prepared", r.out.reply);
  const wp = recordOf(r.snap, USER);
  assert.ok(wp && wp.interests.length === 1, "the watch record holds the stated watch");
});

test("fix3 control (owner 2026-10-28): standing record WITHOUT a scoring basis + no master profile -> the stated watch is added", () => {
  const seed = standingRecord(USER, false);
  assert.ok(!seed.scoring_profile, "fixture check: the seed carries no scoring basis");
  const watchState = { [A.PROFILE_KEY(USER)]: clone(seed) };
  const r = turn(USER, "fx3-t4", ASK, { watchState });
  assert.equal(r.out.intent, "career_watch_create", r.out.reply);
  assert.equal(r.out.resultStatus, "prepared", r.out.reply);
  const wp = recordOf(r.snap, USER);
  assert.ok(wp.interests.length >= seed.interests.length, "nothing standing is removed");
});

test("fix3 control: master profile on file -> the watch is created and recorded as the reply states", () => {
  const profile = {
    basics: { name: "Lena Ortiz", location: "Austin, TX" },
    facts: [
      { kind: "education", text: "B.S. Information Systems at TEST State University, graduating May 2027", org: "TEST State University", title: "B.S. Information Systems", end: "2027-05" },
      { kind: "skill", name: "SQL", text: "Skill: SQL", fact_id: "F-101", evidence: ["resume lists SQL"], unproven: false },
    ],
    constraints: { workAuthorization: "US citizen", needsSponsorship: false },
    preferences: { locations: ["Austin", "Seattle"], starredCompanies: [] },
  };
  const r = turn(USER, "fx3-t5", ASK, { profile, watchState: {} });
  assert.equal(r.out.intent, "career_watch_create", r.out.reply);
  assert.equal(r.out.resultStatus, "prepared", r.out.reply);
  assert.match(r.out.reply, /Watch set: Software Engineering/, r.out.reply);
  const wp = recordOf(r.snap, USER);
  assert.ok(wp, "the watch record must be saved");
  assert.deepEqual(titlesOf(wp), ["Software Engineering Intern / New-Grad"]);
  assert.deepEqual(wp.interests[0].filters.locations, ["Seattle"]);
});
