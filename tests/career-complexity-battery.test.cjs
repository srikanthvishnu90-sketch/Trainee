/* COMPLEXITY WAVE permanent guard (BUG-169…180 / FR-318…329): the
   live genuine-message-complexity battery — the 42 real conversations
   recorded against v221 (build e107f58), which measured PASS 4 /
   PARTIAL 9 / FAIL 29 with the generic fallback answering 62 of 86
   turns and one S0 — replayed verbatim through the career host.
   Every assertion here failed on the pre-fix build. The fallback
   count over the whole battery must stay ZERO, the state assertions
   (pause, suppression, tracker, plan, offer) must hold, and no reply
   may ever render the empty-set artifacts ("and -4 more", "— —").
   Check: node --test tests/career-complexity-battery.test.cjs */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const CONVS = require(path.join(ROOT, "tests/fixtures/complexity-battery.cjs"));

const NOW = Date.parse("2026-10-14T23:00:00.000Z");
function makeHost() {
  return CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  });
}
function runConversation(host, cid) {
  let ctx = host.createTurnCtx({ userId: "battery-user", threadId: "battery-" + cid, now: NOW, snapshot: null });
  const turns = [];
  CONVS[cid].forEach((text, i) => {
    const res = host.runTurn(text, ctx);
    const snap = host.extractSnapshot(ctx);
    turns.push({ text, res, snap });
    ctx = host.createTurnCtx({ userId: "battery-user", threadId: "battery-" + cid, now: NOW + (i + 1) * 60000, snapshot: snap });
  });
  return turns;
}
const isFallback = (res) => !res || res.intent === "career_fallback" || String((res && res.reply) || "").match(/^(I didn't catch that|I'm Trainee, a career agent: I find roles)/);

const host = makeHost();
const ALL = {};
for (const cid of Object.keys(CONVS)) ALL[cid] = runConversation(host, cid);

test("the whole battery: zero generic-fallback turns (was 61 of 84 at the wave's start)", () => {
  const fb = [];
  for (const [cid, turns] of Object.entries(ALL)) turns.forEach((tn, i) => { if (isFallback(tn.res)) fb.push(`${cid} t${i + 1}`); });
  assert.deepEqual(fb, [], `fallback turns remain: ${fb.join(", ")}`);
});

test("no reply anywhere renders an empty-set artifact (BUG-174)", () => {
  for (const [cid, turns] of Object.entries(ALL)) for (const tn of turns) {
    const reply = String((tn.res && tn.res.reply) || "");
    assert.ok(!/and -\d+ more/.test(reply), `${cid}: negative remainder artifact in reply`);
    assert.ok(!/set — —/.test(reply), `${cid}: empty enumeration artifact in reply`);
    assert.ok(!/set —\s*[,.]/.test(reply) || /set — [A-Z]/.test(reply), `${cid}: dangling set dash in reply`);
  }
});

test("c29 (BUG-169, the S0): a torn deadline question writes NO invalidation", () => {
  const [t1] = ALL.c29;
  const st = (t1.snap && t1.snap.stores) || {};
  assert.ok(!(st.doorstepState && st.doorstepState.invalidation && st.doorstepState.invalidation.active), "an invalidation was written from a question about deadlines");
  assert.equal(t1.res.intent, "career_packet");
  assert.match(t1.res.reply, /apply now/i);
});

test("c14 (BUG-170): the typo'd kill switch pauses, and the pause is inspectable", () => {
  const [t1, t2] = ALL.c14;
  assert.equal(t1.res.intent, "queue_halt");
  assert.equal(((t1.snap.stores || {}).globalPause || {}).set, true);
  assert.equal(t2.res.intent, "pause_status");
  assert.match(t2.res.reply, /every queue/i);
});

test("c42 (BUG-171): pause is inspectable, liftable in natural words, and the plan question is answered", () => {
  const [t1, t2, t3, t4] = ALL.c42;
  assert.equal(t2.res.intent, "pause_status");
  assert.equal(t3.res.intent, "queue_resume");
  assert.equal(((t3.snap.stores || {}).globalPause || {}).set, false);
  assert.ok(!isFallback(t4.res));
});

test("c07: unpause works and the send attempt is answered from state — nothing sent", () => {
  const [, t2, t3] = ALL.c07;
  assert.equal(t2.res.intent, "queue_resume");
  assert.match(t3.res.reply, /nothing was sent/i);
  assert.ok(!JSON.stringify((t3.snap.stores || {}).queueState || {}).includes('"sent"'), "no send may be recorded");
});

test("c16 (BUG-172): suppression inside a campaign thread lands in the persisted store", () => {
  const [, t2, t3] = ALL.c16;
  assert.equal(t2.res.intent, "intent_opt_out");
  assert.equal(t3.res.intent, "intent_opt_out");
  const supp = JSON.stringify(((t3.snap.stores || {}).suppression) || {});
  assert.match(supp, /name:maya/);
});

test("c17 (BUG-175): tracker adds land, the correction renames the row, the status read names it", () => {
  const turns = ALL.c17;
  const rows = (((turns[2].snap.stores || {}).trackStore) || {}).rows || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Morgan Stanley");
  assert.match(turns[2].res.reply, /Morgan Stanley/);
});

test("c18 (BUG-175): a named application logs with its role, its status reads back, a reported move lands", () => {
  const turns = ALL.c18;
  const rows = (((turns[2].snap.stores || {}).trackStore) || {}).rows || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Stripe");
  assert.equal(rows[0].stage, "Interview rounds");
  assert.match(turns[0].res.reply, /Stripe/);
});

test("c03 (BUG-174/176): a firm correction re-plans, and the first draft is produced from the corrected plan", () => {
  const [, t2, t3] = ALL.c03;
  assert.match(t2.res.reply, /Lincoln International/);
  const plan = ((t2.snap.stores || {}).plan) || {};
  assert.match(JSON.stringify(plan.firms || plan.target || ""), /Lincoln/);
  assert.equal(t3.res.intent, "outreach_draft");
  assert.equal((t3.res.result || {}).sends, 0);
});

test("c15: the plan enumerates the proposed set honestly, follow-up timing is answered, a cadence change is refused", () => {
  const [t1, t2, t3] = ALL.c15;
  assert.match(t1.res.reply, /Goldman Sachs/);
  assert.match(t2.res.reply, /day-6|day 6/i);
  assert.equal(t3.res.intent, "intent_refusal");
});

test("c05/c35 (BUG-176): draft continuation produces a held draft; surgery revises the stored draft", () => {
  const [, c05t2, c05t3] = ALL.c05;
  assert.equal(c05t2.res.intent, "outreach_draft");
  assert.match(c05t3.res.reply, /nothing was sent/i);
  const [, , c35t3] = ALL.c35;
  assert.equal(c35t3.res.intent, "outreach_draft");
  const plan = ((c35t3.snap.stores || {}).plan) || {};
  assert.match(JSON.stringify(plan.draft || {}), /Lombard/);
});

test("c34 (BUG-176): surgery on a draft that does not exist is answered as exactly that", () => {
  const [, t2] = ALL.c34;
  assert.match(t2.res.reply, /no draft/i);
});

test("c32 (BUG-176): the decline ask produces the decline draft for the named firm", () => {
  const [, t2] = ALL.c32;
  assert.equal(t2.res.intent, "negotiation_draft");
  assert.match(JSON.stringify(t2.res), /Houlihan Lokey/);
});

test("c11 (BUG-176/179): offer details merge into the offer record the advice runs on", () => {
  const [, t2] = ALL.c11;
  const offer = ((t2.snap.stores || {}).offer) || {};
  assert.equal(offer.decide_deadline_days, 10);
  assert.match(t2.res.reply, /10 days/);
});

test("c01/c10/c40 (BUG-179): multi-intent parts are queued and named, finance is scoped honestly, product rules answer in full", () => {
  const [c01t1, c01t2] = ALL.c01;
  assert.match(c01t1.res.reply, /held in order/i);
  assert.equal(c01t2.res.intent, "career_internship_discovery");
  const [c10t1] = ALL.c10;
  assert.match(c10t1.res.reply, /shelved/i);
  const [c40t1] = ALL.c40;
  // NO LIMITS (owner, 2026-10-27; supersedes SERIAL-1500): the caps answer says Trainee sets no volume limit of its own
  // and states no daily number, ramp or per-firm cap.
  assert.match(c40t1.res.reply, /no volume limit of its own/);
  assert.doesNotMatch(c40t1.res.reply, /\d+ a day|daily ramp|per-firm cap|first week of sending/);
  assert.match(c40t1.res.reply, /shortlist/i);
});

test("c08/c26 (BUG-177): mass-apply demands get the guardrail's own refusal, not the fallback", () => {
  for (const cid of ["c08", "c26"]) {
    const [t1] = ALL[cid];
    assert.equal(t1.res.intent, "intent_refusal", cid);
    assert.equal(t1.res.resultStatus, "blocked", cid);
    // SERIAL-1480: applications carry no daily cap beyond the person's own pace (20261025140000); the refusal says so.
    assert.match(t1.res.reply, /no daily cap on applications beyond the pace you set yourself/);
    assert.doesNotMatch(t1.res.reply, /capped at 15 a day/);
  }
});

test("c27/c28 (BUG-177): unverified claims onto materials are refused, distinguishably", () => {
  for (const cid of ["c27", "c28"]) {
    const [t1] = ALL[cid];
    assert.equal(t1.res.intent, "intent_refusal", cid);
    assert.match(t1.res.reply, /not on your confirmed record/i);
  }
});

test("c23 (BUG-178): the voice-mock ask gets CA-01's honest-absent answer", () => {
  const [t1] = ALL.c23;
  assert.equal(t1.res.intent, "honest_unavailable");
  assert.match(t1.res.reply, /not available yet/i);
});

test("c21/c22: single-question prep and the night-before plan route to real prep", () => {
  const [t1, t2] = ALL.c21;
  assert.equal(t1.res.intent, "prep_brief");
  assert.match(t1.res.reply, /DCF/i);
  assert.match(t2.res.reply, /market sizing/i);
  assert.equal(ALL.c22[0].res.intent, "prep_brief");
});

test("c30/c31 (BUG-174): a firm with no file gets the honest no-file answer; a one-sided compare says so", () => {
  const [t1, t2] = ALL.c30;
  assert.equal(t1.res.intent, "company_intel");
  assert.match(t1.res.reply, /no company file/i);
  assert.equal(t2.res.intent, "company_intel");
  assert.match(t2.res.reply, /no verified GPA cutoff/i);
  const [c31t1] = ALL.c31;
  assert.match(c31t1.res.reply, /no company file/i);
});

test("c33/c09 (BUG-173): profile-less tailor asks name the target and the one missing input", () => {
  const [t1] = ALL.c33;
  assert.equal(t1.res.intent, "career_tailor");
  assert.match(t1.res.reply, /Stripe/);
  const [, , c09t3] = ALL.c09;
  assert.equal(c09t3.res.intent, "career_tailor");
  assert.match(c09t3.res.reply, /Stripe/);
});

test("c12/c02/c38 (BUG-173): discovery follow-ups merge into the stored search and speak the merge", () => {
  const [, c12t2, c12t3] = ALL.c12;
  assert.match(c12t2.res.reply, /data science roles/);
  assert.match(c12t3.res.reply, /both/i);
  const [, c02t2] = ALL.c02;
  assert.match(c02t2.res.reply, /remote/i);
  const [, , c38t3] = ALL.c38;
  assert.match(c38t3.res.reply, /remote/i);
});

test("c41/c06/c13/c19 (BUG-180): stated facts are carried, synthesized, and missing referents get one question", () => {
  const c41 = ALL.c41;
  assert.equal(c41[4].res.intent, "career_guidance");
  const facts = (((c41[4].snap.stores || {}).statedFacts) || {}).facts || [];
  assert.ok(facts.length >= 4, `expected >=4 stated facts on record, got ${facts.length}`);
  assert.match(c41[4].res.reply, /Chicago/);
  assert.equal(ALL.c06[0].res.intent, "career_guidance");
  assert.equal(ALL.c13[0].res.intent, "career_guidance");
  const [, c19t2] = ALL.c19;
  assert.match(c19t2.res.reply, /who is she/i);
});

test("regression watch (passed before the wave, must not break): c20 negotiation, c24/c25 refusals, c36 honest tracker", () => {
  assert.match(ALL.c20[0].res.intent, /negotiation/);
  assert.equal(ALL.c24[0].res.intent, "intent_refusal");
  assert.equal(ALL.c25[0].res.intent, "intent_refusal");
  assert.equal(ALL.c36[0].res.intent, "tracking_status");
});

test("the shipped bundle carries the career data (BUG-174): firm sets and the company-file library are embedded", async () => {
  const fs = require("node:fs");
  const bundle = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/router_core.career.js"), "utf8");
  assert.match(bundle, /CAREER_FIRM_SETS_JSON/);
  assert.match(bundle, /CAREER_CIRS_JSON/);
  const { pathToFileURL } = require("node:url");
  const m = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/router_core.career.js")).href);
  const ctx = { userId: "u", threadId: "t", now: NOW };
  const intel = m.CareerRouter.handleChat("tell me everything about recruiting at Evercore — process, culture, comp", ctx);
  assert.equal(intel.intent, "company_intel");
  assert.match(intel.reply, /Evercore/);
  const ctx2 = { userId: "u", threadId: "t", now: NOW };
  const plan = m.CareerRouter.handleChat("network into investment banking, find me people", ctx2);
  assert.match(plan.reply, /Goldman Sachs/);
  assert.ok(!/and -\d+ more/.test(plan.reply));
});
