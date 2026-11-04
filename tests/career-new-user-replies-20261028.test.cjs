'use strict';
// PRODUCT AUDIT 2026-10-28 (docs/architect/PRODUCT-AUDIT-2026-10-28.md, items 1-3): what a brand-new person texts first.
// Through the production career bundle and host (router_core.career.js + career_host.js), as agent-chat runs it.
// (1) no catch-all reply opens with "I did not catch", dumps the capability list, or asks "what date does it turn on";
//     each is short (one text) with exactly one question, and it reads the person's record (resume or not)
// (2) the greeting is one text and its next step fits the record
// (3) texting shorthand is not "corrected" ("thx" was read as "the"); a lowercase "<role> jobs in <city>" is a search
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "..");

let host;
async function setup() {
  if (host) return;
  const B = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/router_core.career.js")));
  const { CareerHost } = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/career_host.js")));
  host = CareerHost.createCareerHost(B);
}
const copy = (x) => JSON.parse(JSON.stringify(x ?? null));
function convo() {
  let snap = null;
  return (text, extra = {}) => {
    const ctx = host.createTurnCtx({ userId: "u-audit", threadId: "t-audit", now: Date.parse("2026-10-28T15:00:00Z"), snapshot: copy(snap), postings: [], ...extra });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    return out;
  };
}
const questions = (r) => (String(r).match(/\?/g) || []).length;
const BAD = /did not catch|didn't catch|Here is what I can do|what date does it turn on/i;

test("(1) catch-all replies: no 'did not catch', no capability dump, one short text, one question", async () => {
  await setup();
  const say = convo();
  say("jobs"); // a career frame stands, so the catch-all owns the bare replies below
  for (const m of ["thx", "lol ok", "yes", "no", "idk", "nvm", "how much does this cost", "is this free", "upload resume", "i dont have a resume",
    "cancel", "that was wrong", "whats my status", "did i get any replies", "networking", "apply"]) {
    const o = say(m);
    if (o.intent !== "career_catchall") continue; // another handler owning it is fine; the catch-all's shape is what is tested
    const r = String(o.reply);
    assert.ok(!BAD.test(r), `${m}: ${r}`);
    assert.ok(r.length <= 160, `${m}: one text (${r.length} chars): ${r}`);
    assert.equal(questions(r), 1, `${m}: exactly one question: ${r}`);
  }
});

test("(1) the catch-all reads the record: no resume -> asks for it; never claims one", async () => {
  await setup();
  const say = convo();
  say("jobs");
  const r = String(say("idk").reply);
  assert.match(r, /resume/i, r);
  assert.ok(!/fit your resume/i.test(r), `no resume on record, so none is claimed: ${r}`);
});

test("(1) 'thx' is thanked, not misread", async () => {
  await setup();
  const say = convo();
  say("jobs");
  const o = say("thx");
  assert.match(String(o.reply), /^Anytime\./, String(o.reply));
});

test("(2) greeting and 'what can you do' are one text with a next step for a new person", async () => {
  await setup();
  for (const m of ["hi", "yo", "wat can u do", "what can you do", "hey whats up"]) {
    const o = convo()(m);
    assert.equal(o.intent, "career_greeting", `${m}: ${o.intent} ${o.reply}`);
    assert.ok(String(o.reply).length <= 240, `${m}: ${String(o.reply).length} chars`);
    assert.match(String(o.reply), /resume/i, `${m}: a new person is pointed at their resume: ${o.reply}`);
  }
});

test("(3) a lowercase '<role> jobs in <city>' is a role search", async () => {
  await setup();
  const o = convo()("data analyst jobs in chicago");
  assert.equal(o.intent, "career_discovery", String(o.reply).slice(0, 200));
});

// ---------- PRODUCT AUDIT 2026-10-28 items 5, 6, 8, 10 ----------
const fs = require("node:fs");
const POSTINGS = [
  { id: "gh:1", job_id: "gh:1", company: "Acme", title: "Data Analyst", location: "Chicago, IL", url: "https://boards.greenhouse.io/acme/jobs/1", description: "SQL Python dashboards", first_seen_at: "2026-10-25T00:00:00Z" },
  { id: "gh:2", job_id: "gh:2", company: "Globex", title: "Junior Data Analyst", location: "Remote", url: "https://jobs.lever.co/globex/2", description: "SQL Excel", first_seen_at: "2026-10-26T00:00:00Z" },
];

test("(5) a new person's job list is not 'ranked by your profile', says no 'caveat: no tradeoff', and Remote is never 'relocating'", async () => {
  await setup();
  const o = convo()("find me jobs", { postings: POSTINGS });
  const r = String(o.reply);
  assert.equal(o.intent, "career_discovery", r);
  assert.ok(!/ranked by fit with your profile|closest fit on your profile|no tradeoff stated|gaps named in the caveat/.test(r), r);
  assert.ok(!/Remote, outside the places|in Remote/.test(r), r);
  assert.match(r, /resume/i, "the next step asks for the resume");
});

test("(6) 'can u help me get a job' is a job search, not a Summer internship search", async () => {
  await setup();
  for (const m of ["can u help me get a job", "i need a job asap"]) {
    const o = convo()(m, { postings: POSTINGS });
    assert.notEqual(o.intent, "career_internship_discovery", `${m}: ${o.reply}`);
    assert.ok(!/Summer 20\d\d|internship/i.test(String(o.reply)), `${m}: ${o.reply}`);
  }
  assert.equal(convo()("i need a summer internship", { postings: POSTINGS }).intent, "career_internship_discovery", "an internship ask keeps its band");
});

test("(8) 'what do you know about me' after a confirmed resume reads the resume, never 'Nothing is on your record'", async () => {
  await setup();
  const RESUME = fs.readFileSync(path.join(ROOT, "packages/career-data/fixtures/test-resume.txt"), "utf8");
  // the account record carries the confirmed profile across turns, as agent-chat's host commit does
  let snap = null, account = { version: 0, epoch: 0 };
  const say = (text) => {
    const ctx = host.createTurnCtx({ userId: "u-recall", threadId: "t-recall", now: Date.parse("2026-10-28T15:00:00Z"), accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(account), watchState: {}, postings: [] });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx)); account = { ...account, ...copy(ctx._hostPatch || {}), version: account.version + 1 };
    return out;
  };
  say(`here is my resume:\n${RESUME}`);
  assert.equal(say("yes thats my resume").resultStatus, "completed");
  const r = String(say("what do you know about me").reply);
  assert.ok(!/Nothing is on your record/.test(r), r);
  assert.match(r, /resume you confirmed: \d+ entries/, r);
});

test("(8) 'remind me tomorrow to follow up' is not a read-back of the record", async () => {
  await setup();
  const say = convo();
  say("i want a job in marketing");
  const o = say("remind me tomorrow to follow up");
  assert.notEqual(o.intent, "conversation_recall", String(o.reply));
});

test("(7) 'how do i upload my resume' is about the resume, not the networking contact list", async () => {
  await setup();
  const o = convo()("how do i upload my resume");
  assert.equal(o.intent, "career_resume_guidance", String(o.reply));
  assert.ok(!/enrich|deduped|every name/i.test(String(o.reply)), String(o.reply));
  assert.equal(convo()("upload my contacts list").intent, "outreach_clarification", "a contact list keeps its intake");
});

test("(10) pause replies are plain words", async () => {
  await setup();
  const say = convo();
  const r1 = String(say("stop").reply), r2 = String(say("help").reply);
  for (const r of [r1, r2]) {
    assert.ok(!/uncertain/i.test(r), r);
    assert.match(r, /resume career work/, r);
  }
});

// ---------- Owner's Telegram-first list (2026-10-28): items 2, 3, 4, 5 ----------
// A person whose account record, profile and watch state persist across turns, as agent-chat's host commit keeps them.
function account(userId) {
  let snap = null, acct = { version: 0, epoch: 0 }, watch = {};
  const say = (text) => {
    const ctx = host.createTurnCtx({ userId, threadId: `t-${userId}`, now: Date.parse("2026-10-28T15:00:00Z"), accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(acct), watchState: copy(watch), postings: POSTINGS });
    const out = host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    const patch = copy(ctx._hostPatch || {});
    acct = { ...acct, ...patch, version: acct.version + 1 };
    if (ctx.alertWatchState) watch = copy(ctx.alertWatchState);
    return { out, patch, ctx };
  };
  return { say, watch: () => watch, snap: () => snap, account: () => acct };
}

test("(owner 2) 'how do I stop messages or delete my data?' answers both, and deletes nothing", async () => {
  await setup();
  const p = account("u-owner2");
  p.say("i want a job in marketing");
  const before = JSON.stringify(p.snap());
  const acctBefore = JSON.stringify(p.account());
  const { out, patch } = p.say("how do I stop messages or delete my data?");
  const r = String(out.reply);
  assert.match(r, /text "stop"/i, `how to stop: ${r}`);
  assert.match(r, /yes, erase it/i, `the exact approved deletion step: ${r}`);
  assert.match(r, /Nothing is deleted until/i, r);
  assert.ok(!patch.erase, "nothing erased");
  assert.ok(JSON.parse(before).stores, "a stored state existed");
  assert.deepEqual(JSON.parse(JSON.stringify(p.snap().stores.profile ?? null)), JSON.parse(before).stores.profile ?? null, "the profile is unchanged");
  assert.ok(JSON.stringify(p.account()).includes("marketing") === acctBefore.includes("marketing"), "the account record keeps the goal");
});

test("(owner 3) \"what's my status?\" is answered from the tracker, not the catch-all", async () => {
  await setup();
  for (const m of ["what's my status?", "whats my status", "status?"]) {
    const o = convo()(m);
    assert.equal(o.intent, "tracking_status", `${m}: ${o.intent} ${o.reply}`);
    assert.ok(!/not sure|did not catch|didn't catch/i.test(String(o.reply)), String(o.reply));
  }
});

test("(owner 4) 'set a job alert for data analyst roles in Chicago' creates the watch (persisted); 'find me entry level ...' returns jobs", async () => {
  await setup();
  const p = account("u-owner4");
  const { out } = p.say("set a job alert for data analyst roles in Chicago");
  assert.equal(out.intent, "career_watch_create", String(out.reply));
  assert.equal(out.resultStatus, "prepared", String(out.reply));
  const wp = Object.values(p.watch()).find((v) => v && v.type === "career_watch_profile");
  assert.ok(wp, "a watch profile is in the persisted watch state");
  assert.equal(wp.interests.length, 1);
  assert.equal(wp.interests[0].role.title, "Data Analyst");
  assert.deepEqual(wp.interests[0].filters.locations, ["Chicago"]);
  const f = convo()("find me entry level data analyst jobs in Chicago", { postings: POSTINGS });
  assert.equal(f.intent, "career_discovery", String(f.reply));
  assert.match(String(f.reply), /Data Analyst at Acme/, String(f.reply));
});

test("(e2e #227) 'my name is Priya Raman' is saved as the person's fact and acknowledged; 'what's my name?' reads it back", async () => {
  await setup();
  const p = account("u-priya");
  const { out } = p.say("my name is Priya Raman");
  assert.match(String(out.reply), /Nice to meet you, Priya — I'll use that name with you\./, String(out.reply));
  assert.ok(!/did not catch|not sure which part/i.test(String(out.reply)), String(out.reply));
  const persisted = JSON.stringify(p.snap()) + JSON.stringify(p.account());
  const facts = (p.account().statedFacts || p.snap().stores?.statedFacts || {}).facts || [];
  assert.ok(facts.some((f) => f.kind === "name" && f.value === "Priya Raman") || /"kind":"name","value":"Priya Raman"/.test(persisted), `the name is stored: ${persisted.slice(0, 400)}`);
  assert.match(String(p.say("what's my name?").out.reply), /Your name is Priya Raman/);
  const p2 = account("u-noname");
  assert.match(String(p2.say("what's my name?").out.reply), /haven't told me your name/, "never invented");
});

test("(coordinator B) a new person's first 'find jobs' with nothing on the list is pointed at onboarding, and no fact is invented", async () => {
  await setup();
  let snap = null;
  const ctx = host.createTurnCtx({ userId: "u-first", threadId: "t-first", now: Date.parse("2026-10-28T15:00:00Z"), snapshot: null, postings: [] });
  const o = host.runTurn("find jobs", ctx);
  snap = copy(host.extractSnapshot(ctx));
  const r = String(o.reply);
  assert.match(r, /resume/i, `onboarding next step: ${r}`);
  assert.ok(!/built from the boards|will be invented|something real/.test(r), r);
  const stated = (ctx.statedFacts && ctx.statedFacts.facts) || [];
  assert.equal(stated.length, 0, `no fact invented: ${JSON.stringify(stated)}`);
  assert.ok(!(snap.stores && snap.stores.profile && (snap.stores.profile.facts || []).length), "no profile facts");
});

test("(owner 5) search + tailor + alert in one message: every part is acknowledged, the alert is saved", async () => {
  await setup();
  const p = account("u-owner5");
  const { out } = p.say("find data analyst jobs in chicago, tailor my resume for the top one, and set an alert for new ones");
  const r = String(out.reply);
  assert.match(r, /Watch set: Data Analyst/, r);
  assert.match(r, /Data Analyst at Acme/, `the search is answered: ${r}`);
  assert.match(r, /tailoring your resume/i, `the tailor part is acknowledged: ${r}`);
  assert.ok(!/no job watches on file/i.test(r), r);
  const wp = Object.values(p.watch()).find((v) => v && v.type === "career_watch_profile");
  assert.ok(wp && wp.interests.length === 1, "the alert is in the persisted watch state");
});

test("(owner decision) alert first, then one ask for only what is missing; tailoring waits for the resume", async () => {
  await setup();
  const p = account("u-gateoff");
  const { out } = p.say("set a job alert for data analyst roles");
  const wp = Object.values(p.watch()).find((v) => v && v.type === "career_watch_profile");
  assert.ok(wp && wp.interests.length === 1, "the watch row is saved before the ask");
  assert.match(String(out.reply), /send your resume and the city/i, String(out.reply));
  const q = account("u-gateoff2").say("set a job alert for data analyst roles in Chicago");
  const r2 = String(q.out.reply);
  assert.match(r2, /send your resume/i, r2);
  assert.ok(!/city you want/i.test(r2), `place was given, not asked again: ${r2}`);
  const t = p.say("tailor my resume for the top one");
  assert.ok(!t.out.artifact, `no tailored artifact exists without a resume: ${String(t.out.reply)}`);
  assert.match(String(t.out.reply), /resume/i);
});
