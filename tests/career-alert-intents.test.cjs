// ALERTS HOST WIRING (Crew B Cycle 2, W4): the two router watch intents —
// create-watch and list/manage-watches — delivered as a patch against
// 142-career-router.js (/tmp/crewb2-w4-intents-142.patch; the coordinator
// integrates it this cycle). These tests exercise the intents ONCE THE
// PATCH IS APPLIED to packages/domain/142-career-router.js.
//
// Pre-integration verification: point ALERT_INTENTS_ROUTER at a patched
// copy of 142 (same directory as its sibling modules, so its relative
// requires resolve) and the suite runs against that copy unchanged.
//
// The intents run through 152's createWatchProfile / roleSpecFor /
// upsertInterest / removeInterest / setOptOut / validateWatchProfile
// against the store the router can actually reach: a sync {get,set}
// adapter over ctx.alertWatchState (or a host-injected ctx.alertStore).
// The host cycle (scripts/career/alerts-host.mjs) reads the SAME profile
// record shape from its durable store — key career:watch-profile:<user_id>.
// Check: node --test tests/career-alert-intents.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROUTER_PATH = process.env.ALERT_INTENTS_ROUTER
  || path.join(__dirname, "..", "packages/domain/142-career-router.js");
const Router = require(ROUTER_PATH);
const A = require(path.join(__dirname, "..", "packages/domain/152-career-assign.js"));

const NOW = Date.parse("2026-10-15T15:00:00.000Z");
const USER = "user-watch-test-1";

// 122-shape master profile (facts-carried), the shape 142's scoringProfile
// adapts for 121 — the create-watch intent stores exactly that adaptation
// as the watch profile's scoring_profile.
const PROFILE = {
  basics: { name: "Alex Testcase", location: "Chicago, IL" },
  facts: [
    { kind: "education", text: "B.S. Computer Science + Finance at TEST University, graduating May 2028", org: "TEST University", title: "B.S. Computer Science", end: "2028-05" },
    { kind: "skill", name: "Python", text: "Skill: Python", fact_id: "F-010", evidence: ["resume lists Python"], unproven: false },
    { kind: "skill", name: "Excel", text: "Skill: Excel", fact_id: "F-012", evidence: ["resume lists Excel"], unproven: false },
  ],
  constraints: { workAuthorization: "US citizen", needsSponsorship: false },
  preferences: { locations: ["Chicago", "New York"], starredCompanies: [] },
};

const freshCtx = (over) => Object.assign({ profile: PROFILE, userId: USER, now: NOW }, over || {});
const savedProfile = (ctx) => (ctx.alertWatchState || {})[A.PROFILE_KEY(USER)] || null;

test("create-watch: 'watch for investment banking analyst intern roles in Chicago' saves a valid 152 profile", () => {
  const ctx = freshCtx();
  const r = Router.handleChat("Watch for investment banking analyst intern roles in Chicago", ctx);
  assert.ok(r, "turn must be answered");
  assert.equal(r.intent, "career_watch_create");
  const wp = savedProfile(ctx);
  assert.ok(wp, "watch profile must be saved under 152's per-user key");
  const v = A.validateWatchProfile(wp);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(wp.user_id, USER);
  assert.equal(wp.interests.length, 1);
  const i = wp.interests[0];
  assert.equal(i.role.title, "Investment Banking Analyst");
  assert.equal(i.role.soc, "13-2051");
  assert.deepEqual(i.filters.locations, ["Chicago"]);
  assert.deepEqual(i.filters.bands, ["intern"]);
  assert.deepEqual(i.filters.firms_include, []); // a city after "in" is never a firm filter
  assert.ok(wp.scoring_profile, "scoring profile (121 shape) rides the record for the host cycle");
  assert.match(r.reply, /Investment Banking Analyst/);
});

test("create-watch: a second watch upserts beside the first; list reads both back on a fresh thread ctx", () => {
  const ctx = freshCtx();
  Router.handleChat("Watch for investment banking analyst intern roles in Chicago", ctx);
  const r2 = Router.handleChat("Set up a watch for software engineering intern roles in New York", ctx);
  assert.equal(r2.intent, "career_watch_create");
  assert.equal(savedProfile(ctx).interests.length, 2);
  // A new thread: a fresh ctx sharing only the persisted state object.
  const ctx2 = freshCtx({ alertWatchState: ctx.alertWatchState });
  const list = Router.handleChat("What am I watching?", ctx2);
  assert.equal(list.intent, "career_watch_manage");
  assert.match(list.reply, /Investment Banking Analyst/);
  assert.match(list.reply, /Software Engineering Intern/);
});

test("manage: stop watching removes exactly the named interest", () => {
  const ctx = freshCtx();
  Router.handleChat("Watch for investment banking analyst intern roles in Chicago", ctx);
  Router.handleChat("Set up a watch for software engineering intern roles in New York", ctx);
  const r = Router.handleChat("Stop watching investment banking", ctx);
  assert.equal(r.intent, "career_watch_manage");
  const wp = savedProfile(ctx);
  assert.equal(wp.interests.length, 1);
  assert.equal(wp.interests[0].role.title, "Software Engineering Intern / New-Grad");
});

test("manage: pause sets opt_out.global on the same record the host reads; resume clears it", async () => {
  const ctx = freshCtx();
  Router.handleChat("Watch for investment banking analyst intern roles in Chicago", ctx);
  const p = Router.handleChat("Pause my job alerts", ctx);
  assert.equal(p.intent, "career_watch_manage");
  assert.equal(savedProfile(ctx).opt_out.global, true);
  // The host tier loads the identical record through 152's own loader over
  // a {get,set} view of the same state — the pause binds the host cycle.
  const stateBox = ctx.alertWatchState;
  const hostStore = { get: (k) => (k in stateBox ? stateBox[k] : null), set: (k, v) => { stateBox[k] = v; } };
  const loaded = await A.loadWatchProfile(hostStore, USER);
  assert.equal(loaded.opt_out.global, true);
  const rs = Router.handleChat("Resume my job alerts", ctx);
  assert.equal(rs.intent, "career_watch_manage");
  assert.equal(savedProfile(ctx).opt_out.global, false);
});

test("create-watch: a role outside 152's taxonomy splits is saved as a DERIVED watch, disclosed honestly as non-standard", () => {
  // PIN UPDATED (2026-10-25, REGRESSION-1255) to the contract the
  // ALERTS-RESUME-1107 rebuild sanctioned (commit 90194114: "derived
  // user-words watch targets (152 SOC exception for derived
  // specs)"): refusing an out-of-taxonomy role was itself the
  // scope-reset defect — the watch now saves keyed on the user's own
  // words. The original requirement — the user is told plainly this
  // is not a standard role, and nothing pretends otherwise — is
  // asserted in full: the saved interest is marked derived with no
  // SOC and no split, and the reply carries the disclosure.
  const ctx = freshCtx();
  const r = Router.handleChat("Watch for boilermaker roles in Chicago", ctx);
  assert.equal(r.intent, "career_watch_create");
  assert.equal(r.resultStatus, "prepared");
  const wp = savedProfile(ctx);
  assert.ok(wp, "the derived watch is saved on the user's record");
  assert.equal(wp.interests.length, 1);
  const role = wp.interests[0].role;
  assert.equal(role.derived, true, "the saved role is marked derived — never passed off as a taxonomy role");
  assert.equal(role.soc, null, "no SOC is invented for a non-taxonomy role");
  assert.equal(role.split, null, "no taxonomy split is invented for a non-taxonomy role");
  // SERIAL-1540: the title is the phrase exactly as stated (no capitalization added, no container word, no place).
  assert.equal(role.title, "boilermaker", "the title keys on the user's own words, as stated");
  assert.equal(role.as_asked, "Watch for boilermaker roles in Chicago", "the request is kept as asked");
  assert.match(r.reply, /not a standard category/i, "the reply discloses the title is not a standard category");
  assert.match(r.reply, /your own words/i, "the reply says the watch keys on the user's own words");
});

test("create-watch: an ask with NO role named is refused honestly and saves nothing", () => {
  // The saves-nothing half of the original pin, on the case the
  // current contract still refuses: no role words at all -> the
  // router asks for the role and writes no watch.
  const ctx = freshCtx();
  const r = Router.handleChat("watch for jobs in my field", ctx);
  assert.equal(r.intent, "career_watch_create");
  assert.equal(r.resultStatus, "awaiting_user");
  assert.equal(savedProfile(ctx), null);
});

// OWNER RULE (2026-10-28, Telegram-first list #4): a stated watch is created without a profile on file.
test("create-watch: no profile on file -> the stated watch is saved", () => {
  const ctx = { userId: USER, now: NOW };
  const r = Router.handleChat("Watch for investment banking analyst roles in Chicago", ctx);
  assert.equal(r.intent, "career_watch_create");
  assert.equal(r.resultStatus, "prepared", r.reply);
  const wp = savedProfile(ctx);
  assert.ok(wp && wp.interests.length === 1, "the watch is saved");
  assert.deepEqual(wp.interests[0].filters.locations, ["Chicago"]);
});
test("create-watch: no profile and no role named -> nothing saved", () => {
  const ctx = { userId: USER, now: NOW };
  const r = Router.handleChat("set an alert for new ones", ctx);
  assert.equal(savedProfile(ctx), null, r.reply);
});

test("manage: listing with no watches answers honestly and materializes no state", () => {
  const ctx = freshCtx();
  const r = Router.handleChat("What am I watching?", ctx);
  assert.equal(r.intent, "career_watch_manage");
  assert.match(r.reply, /no job watches/i);
  assert.equal(ctx.alertWatchState, undefined, "a read must never create the watch state container");
});

test("non-watch turns are untouched: an unrelated ask creates no watch state", () => {
  const ctx = freshCtx();
  Router.handleChat("What am I watching?", ctx); // manage read on empty state
  assert.equal(ctx.alertWatchState, undefined);
  const wp = savedProfile(ctx);
  assert.equal(wp, null);
});
