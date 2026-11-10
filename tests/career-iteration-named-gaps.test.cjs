/* ITERATION LANE guard (2026-10-17, branch iterate/named-gaps) — the
   depth-integration merge record's named NOT-PERFECT items, replayed
   on the DEPLOYED path (real CareerHost, real chain modules,
   production commit semantics), one section per gap:

   BUG-271 (merge record §6 item 1): a bare eligibility ask was
   answered by the record self-check's non-sequitur ("That is not on
   your record — you have not told me yet") because nothing owned the
   grading question. The journey: grade when a posting is resolvable,
   otherwise name the missing inputs (the posting; the specific fact
   the named requirement turns on, with the record's state for it) —
   never an invented verdict.

   BUG-266 (merge record §5.4/§6 item 2): an internship-headed find
   was served by the generic ranked discovery. The reroute is
   deliberate and the http-host pin moved with it; both directions
   are guarded here (internship-headed -> banded route with the
   summer headline; roles/jobs-headed -> generic, unchanged).

   BUG-272 (v227 live verification residue): restating an
   already-held fact ("I'm based in Denver" with Denver on record)
   wrote nothing — correctly — and then fell to the generic fallback
   because the stated-facts reply only fired on NEW captures. The
   journey: acknowledge the fact as already on record, read back from
   the record, write nothing, claim no fresh capture.

   Check: node --test tests/career-iteration-named-gaps.test.cjs */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const CareerProfile = D("122-career-profile.js");
const TAILOR = D("123-career-tailor.js");
function baseProfileTailor(facts) {
  return { basics: { name: "Casey Testcase (TEST)", email: "casey@example.test", location: "Chicago, IL (TEST)", links: {} }, constraints: {}, defaults: {}, preferences: {}, facts };
}
const skillsTextOf = (r) => { const l = (r.resume.lines || []).find((x) => x.type === "skills"); return l ? l.text : ""; };

const NOW = Date.parse("2026-10-17T17:00:00.000Z");
const WHITELIST = ["paused", "preferred_locations", "erase", "stated_facts"];
const clone = (v) => JSON.parse(JSON.stringify(v));
const FINANCE_MARKERS = ["connected bank", "Connect one in the app", "Name the subscription", "cancel_subscription", "bank or card"];

function makeHost() {
  return CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  });
}
function makeWorld() {
  const host = makeHost();
  const store = { accounts: new Map(), threads: new Map(), watches: new Map() };
  let n = 0;
  const say = (userId, threadId, text, opts) => {
    const o = opts || {};
    n += 1;
    const ctx = host.createTurnCtx({ userId, threadId, now: NOW + n * 60000, accountPersistence: true, snapshot: store.threads.get(threadId) || null, account: clone(store.accounts.get(userId) || {}), watchState: clone(store.watches.get(userId) || {}), postings: o.postings || [], profile: o.profile || null });
    const out = host.runTurn(text, ctx);
    const snap = host.extractSnapshot(ctx);
    store.threads.set(threadId, snap);
    if (ctx._hostPatch) {
      for (const k of Object.keys(ctx._hostPatch)) assert.ok(WHITELIST.includes(k), `commit patch key "${k}" is outside the career_host_commit whitelist`);
      if (ctx._hostPatch.erase === true) store.accounts.set(userId, { paused: true });
      else { const a = store.accounts.get(userId) || {}; for (const k of Object.keys(ctx._hostPatch)) a[k] = clone(ctx._hostPatch[k]); store.accounts.set(userId, a); }
    }
    return { out, ctx, snap };
  };
  const accountFacts = (userId) => {
    const a = store.accounts.get(userId) || {};
    return (a.stated_facts && Array.isArray(a.stated_facts.facts)) ? a.stated_facts.facts : [];
  };
  return { host, store, say, accountFacts };
}
function fixtureProfile() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/career-data/fixtures/gauntlet/profiles/p1-early-career-swe/profile.json"), "utf8"));
  return CareerProfile.profileFromData(data);
}

// ================= BUG-266: the internship find =================
test("BUG-266: the pinned shape now routes to the internship-banded route, fabricating nothing", () => {
  const { say } = makeWorld();
  const out = say("u-266a", "t", "Find me internships I can apply to this week.", { profile: fixtureProfile() }).out;
  assert.equal(out.intent, "career_internship_discovery");
  assert.equal(((out.result && out.result.shortlist) || []).length, 0, "empty pool -> empty shortlist, nothing invented");
  for (const m of FINANCE_MARKERS) assert.ok(!out.reply.includes(m), `no finance marker: ${m}`);
});

test("BUG-266: with a mixed pool, an internship find serves only intern-band roles under the summer headline", () => {
  const { say } = makeWorld();
  const pool = [
    { id: "fx-i", title: "Data Analytics Intern", company: "Lumen Grid", location: "Seattle, WA", remote_terms: "hybrid", requirements: ["SQL", "Python"], salary: "$30/hr", deadline: "2026-11-02", tradeoff: "" },
    { id: "fx-f", title: "Backend Engineer", company: "Lumen Grid", location: "Seattle, WA", remote_terms: "hybrid", requirements: ["Python", "SQL"], salary: "$120k", deadline: "2026-11-02", tradeoff: "" },
  ];
  const out = say("u-266b", "t", "find me internships", { profile: fixtureProfile(), postings: pool }).out;
  assert.equal(out.intent, "career_internship_discovery");
  assert.match(out.reply, /Summer/, "the banded route's headline frames the search as internships");
  const titles = ((out.result && out.result.shortlist) || []).map((r) => r.title);
  assert.ok(titles.some((x) => /Intern/.test(x)), `the intern role is served (have: ${titles.join(", ")})`);
  assert.ok(!titles.some((x) => /Backend Engineer/.test(x)), "the full-time role is not padded into an internship answer");
});

test("BUG-266: the other direction is unchanged — roles/jobs-headed finds keep the generic route", () => {
  const { say } = makeWorld();
  const p = fixtureProfile();
  assert.equal(say("u-266c", "t1", "find me roles", { profile: p }).out.intent, "career_discovery");
  assert.equal(say("u-266c", "t2", "find me data roles and internships", { profile: p }).out.intent, "career_discovery", "roles-headed stays generic even with internships named later");
  assert.equal(say("u-266c", "t3", "find me jobs in Chicago", { profile: p }).out.intent, "career_discovery");
  assert.equal(say("u-266c", "t4", "find internship programs", { profile: p }).out.intent, "career_internship_discovery", "the bare-find tail honors the head noun too");
  assert.equal(say("u-266c", "t5", "I need an internship for next summer", { profile: p }).out.intent, "career_internship_discovery", "the need/want shapes keep their pre-existing route");
});

// ================= BUG-272: the restated fact =================
test("BUG-272: the v227 journey — restating an on-record fact in a new thread is acknowledged, writes nothing, claims no capture", () => {
  const { say, accountFacts } = makeWorld();
  const u = "u-272a";
  say(u, "A", "I'm a sophomore studying economics, and I'm based in Denver");
  const before = clone(accountFacts(u));
  assert.ok(before.some((f) => f.kind === "geography" && /Denver/.test(f.value)), "Denver is on the committed record");
  const r = say(u, "B", "I'm based in Denver");
  assert.match(r.out.reply, /Already on your record/, "the restatement is acknowledged as already on record");
  assert.ok(!/Recorded — that is on your record now/.test(r.out.reply), "no fresh-capture claim is made");
  assert.ok(!/I didn't catch that|I'm Trainee, a career agent: I find roles/.test(r.out.reply), "never the generic fallback again");
  assert.deepEqual(accountFacts(u), before, "the committed record is byte-identical — the turn wrote nothing");
  assert.ok((((r.out.result || {}).restated_facts) || []).some((f) => f.kind === "geography"), "the result names the restated fact");
});

test("BUG-272: a same-thread restatement is acknowledged too, and a restatement riding a new fact keeps the recorded path", () => {
  const { say, accountFacts } = makeWorld();
  const u = "u-272b";
  say(u, "A", "I'm based in Denver");
  const r1 = say(u, "A", "I'm based in Denver");
  assert.match(r1.out.reply, /Already on your record/);
  const r2 = say(u, "A", "I'm based in Denver and I study economics");
  assert.match(r2.out.reply, /Recorded — that is on your record now/, "a NEW fact in the turn keeps the capture reply (additions win)");
  assert.ok(accountFacts(u).some((f) => f.kind === "majors" && /economics/.test(f.value)), "the new fact committed");
});

test("BUG-272: a restatement carrying another ask stands down — the find owns its turn", () => {
  const { say } = makeWorld();
  const u = "u-272c";
  say(u, "A", "I'm based in Denver");
  const r = say(u, "A", "I'm based in Denver — find me roles");
  assert.ok(!/Already on your record/.test(r.out.reply), "the acknowledgment does not swallow an actionable turn");
  assert.equal(r.out.intent, "career_discovery", "the find is served by discovery");
});

// ================= BUG-273: the whole-inventory skills line =================
test("BUG-273: the skills line is scoped to the posting — off-family inventory no longer prints; family vocabulary still does", () => {
  const p = baseProfileTailor([
    { id: "T-001", kind: "experience", title: "Paralegal, TEST Firm", org: "TEST Firm", start: "2024-01", end: "2026-05", needs_confirmation: false, evidence: [], skills: ["Legal Research", "Westlaw"], text: "Paralegal at TEST Firm. Researches case law in Westlaw for 30 active matters.", bullets: ["Researches case law in Westlaw for 30 active matters"] },
    { id: "T-002", kind: "experience", title: "Backend Developer, TEST Co", org: "TEST Co", start: "2024-01", end: "2026-05", needs_confirmation: false, evidence: [], skills: ["Python", "Flask"], text: "Backend Developer at TEST Co. Built Python services and Flask APIs for 50 users.", bullets: ["Built Python services and Flask APIs for 50 users"] },
  ]);
  const law = TAILOR.tailorResume(p, "Legal Assistant (TEST posting)\nRequired: Legal Research.\nYou will support attorneys.", {});
  assert.equal(law.ok, true, JSON.stringify(law.violations || []));
  const lawLine = skillsTextOf(law);
  assert.match(lawLine, /Legal Research/, "the named requirement prints");
  assert.match(lawLine, /Westlaw/, "evidenced law-family vocabulary still prints even when the JD never names it (the Crew B Cycle 2 protection)");
  assert.ok(!/Python|Flask/.test(lawLine), `the SWE inventory must not ride onto a law application (line: "${lawLine}")`);
  const swe = TAILOR.tailorResume(p, "Backend Engineer (TEST posting)\nRequired: Python.\nYou will build services.", {});
  assert.equal(swe.ok, true, JSON.stringify(swe.violations || []));
  const sweLine = skillsTextOf(swe);
  assert.match(sweLine, /Python/);
  assert.match(sweLine, /Flask/, "evidenced SWE-family vocabulary prints on the SWE posting");
  assert.ok(!/Westlaw|Legal Research/.test(sweLine), `the law inventory must not ride onto a SWE application (line: "${sweLine}")`);
  assert.ok(!(swe.gaps || []).some((g) => g.requirement === "Python"), "scoping the line never turns an evidenced skill into a gap");
});

// ================= BUG-271: the eligibility ask =================
test("BUG-271: the merge record's verbatim turn — a deflection naming the missing posting and the missing fact, no verdict, no non-sequitur", () => {
  const { say } = makeWorld();
  const out = say("u-271a", "t", "there's a posting for a licensed insurance adjuster — am I eligible for that?").out;
  assert.equal(out.intent, "eligibility_check");
  assert.match(out.reply, /haven't read that posting/, "the missing input is named: the posting");
  assert.match(out.reply, /insurance adjuster license/, "the specific fact the named requirement turns on is named");
  assert.match(out.reply, /does not show it/, "the record's state for that fact is spoken");
  assert.match(out.reply, /Send me the posting's link or its text/, "the closest path is offered");
  assert.ok(!/That is not on your record/.test(out.reply), "never the self-check non-sequitur again");
  assert.ok(!/Verdict:/.test(out.reply), "no verdict is invented without a posting");
});

test("BUG-271: the bare ask names the requirement classes it will turn on — still no verdict", () => {
  const { say } = makeWorld();
  const out = say("u-271b", "t", "am I eligible?").out;
  assert.equal(out.intent, "eligibility_check");
  assert.match(out.reply, /hard requirements/);
  assert.match(out.reply, /a license, a degree, years of experience or work authorization/);
  assert.ok(!/Verdict:/.test(out.reply));
  assert.ok(!/That is not on your record/.test(out.reply));
});

test("BUG-271: when the record DOES speak to the named fact, the deflection says so", () => {
  const { say } = makeWorld();
  const p = fixtureProfile();
  p.facts.push({ id: "TEST-LIC-1", kind: "certification", title: "Insurance adjuster license (TEST)", org: "", needs_confirmation: false, evidence: [], skills: [], text: "Holds an active insurance adjuster license (TEST).", bullets: [] });
  const out = say("u-271c", "t", "there's a posting for a licensed insurance adjuster — am I eligible for that?", { profile: p }).out;
  assert.equal(out.intent, "eligibility_check");
  assert.match(out.reply, /does speak to it/, "the record's evidence for the named fact is reported, not hidden");
  assert.ok(!/Verdict:/.test(out.reply), "still no verdict — the posting itself is still missing");
});

test("BUG-271: with the posting resolvable by company, the ask is GRADED — verdict spoken, unmet requirement named", () => {
  const { say } = makeWorld();
  const pool = [{ id: "fx-adj", title: "Claims Adjuster", company: "Acme Insurance", location: "Chicago, IL", jd_text: "Claims Adjuster at Acme Insurance. You must hold a valid insurance adjuster license. You will investigate claims, interview claimants, and settle coverage. Requirements: strong communication skills.", salary: "$70k", deadline: "2026-11-02", tradeoff: "" }];
  const out = say("u-271d", "t", "am I eligible for the adjuster role at Acme Insurance?", { profile: fixtureProfile(), postings: pool }).out;
  assert.equal(out.intent, "eligibility_check");
  assert.equal(out.resultStatus, "prepared");
  assert.equal(out.result && out.result.eligibility && out.result.eligibility.status, "not_eligible", "the license knockout is unmet on this record");
  assert.match(out.reply, /Verdict: this record does not meet every hard requirement/, "the spoken verdict is 123's own line");
  assert.match(out.reply, /license/i, "the unmet requirement is named");
});

test("BUG-271: the self-check keeps its own turns — 'am I a sophomore?' is still answered from the record", () => {
  const { say } = makeWorld();
  const u = "u-271e";
  say(u, "A", "I'm a sophomore studying economics");
  const out = say(u, "A", "am I a sophomore?").out;
  assert.match(out.reply, /sophomore/, "answered from the record");
  assert.ok(!/can't be graded without the posting/.test(out.reply), "not deflected to the eligibility journey");
});
