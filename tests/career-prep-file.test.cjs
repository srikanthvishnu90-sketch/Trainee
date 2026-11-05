/* BETA C03 / A15.1 (2026-11-04): the interview prep File.
   Live beta C03 asked "Make a one-page interview prep File with five questions and a 30-minute plan" (with an interview
   tomorrow, "No external actions and no changes to my profile"). Trainee answered with chat text from the night-before
   template (one question, "tonight, then stop", and the unsupported "sleep is a scored input") and made NO File; the
   offline A15.1 replay of the same words got the interview brief (three questions, no plan, no File). Root cause: no prep
   route had an artifact path at all; Files were made only by the brain's create_file and the search results page, and the
   staged brain never sees an instruction-shaped prep turn.

   This guard runs the real CareerHost with the real chain modules on those words and asserts the turn carries a File
   built from code (result.file, a plan_review interview_prep page): exactly the asked number of questions, a plan whose
   blocks add up to exactly the asked minutes, no company invented, gaps named, confirmed facts only, one page.
   Check: node --test tests/career-prep-file.test.cjs */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const Prep = D("127-career-prep.js");

const C03 = "I have a customer support interview tomorrow. Make a one-page interview prep File with five questions and a 30-minute plan. No external actions and no changes to my profile.";
const A15_1 = "Make a one-page interview prep File with five questions and a 30-minute plan";
const NOW = Date.parse("2026-11-04T22:20:00.000Z");

const host = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
  CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
  CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
});
const turn = (text, stores) => {
  const snapshot = stores ? { v: 1, scope: { userId: "u-pf" }, stores: JSON.parse(JSON.stringify(stores)) } : null;
  const ctx = host.createTurnCtx({ userId: "u-pf", threadId: "t-pf", now: NOW, snapshot, accountPersistence: true });
  return { out: host.runTurn(text, ctx), ctx };
};
const section = (data, re) => data.sections.find((s) => re.test(s.heading));
const questionsOf = (data) => section(data, /practice questions?$/).items;
const planOf = (data) => section(data, /-minute plan$/).items.map((it) => { const m = it.label.match(/^Minute (\d+) to (\d+) \((\d+) min\)$/); assert.ok(m, `plan label: ${it.label}`); return { from: +m[1], to: +m[2], min: +m[3], text: it.value }; });
const allText = (data) => JSON.stringify(data);
// One printed page: the File's own text (headings, labels, values) stays inside this budget.
const ONE_PAGE_CHARS = 3200;
const pageChars = (data) => [data.title, data.period, ...data.sections.flatMap((s) => [s.heading, ...s.items.flatMap((i) => [i.label, i.value, i.source])])].join("\n").length;

function assertPrepFile(out, n, minutes) {
  assert.equal(out.contained, false, out.reply);
  assert.equal(out.intent, "prep_brief", `intent (reply: ${out.reply})`);
  const f = out.result && out.result.file;
  assert.ok(f, `a File rides the turn (result keys: ${Object.keys(out.result || {})}; reply: ${out.reply})`);
  assert.equal(f.kind, "plan_review");
  assert.equal(f.data.variant, "interview_prep");
  const qs = questionsOf(f.data);
  assert.equal(qs.length, n, `exactly ${n} questions`);
  assert.equal(new Set(qs.map((q) => q.value)).size, n, "no question repeats");
  const plan = planOf(f.data);
  assert.equal(plan.reduce((a, b) => a + b.min, 0), minutes, `the plan adds up to exactly ${minutes} minutes`);
  assert.equal(plan[0].from, 0);
  assert.equal(plan.at(-1).to, minutes);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].from, plan[i - 1].to, "blocks are back to back");
  for (const b of plan) { assert.ok(b.min >= 1); assert.equal(b.to - b.from, b.min); }
  assert.ok(pageChars(f.data) <= ONE_PAGE_CHARS, `one page: ${pageChars(f.data)} chars`);
  assert.ok(f.data.sections.length <= 6 && plan.length <= 5);
  assert.ok(!/<img|https?:\/\/|\.png|\.jpe?g|illustration/i.test(allText(f.data)), "no images or decorative links");
  for (const s of f.data.sections) for (const it of s.items) assert.ok(["From you", "From your resume", "Made by Trainee"].includes(it.source), `${it.label}: ${it.source}`);
  assert.equal(out.result.sends, 0);
  assert.ok(new RegExp(`\\b${n} (?:practice )?questions?\\b`).test(out.reply) && new RegExp(`\\b${minutes}-minute plan\\b`).test(out.reply), `the reply names what was asked: ${out.reply}`);
  assert.ok(!/scored input/i.test(out.reply + allText(f.data)), "no claim that sleep is scored");
  return f.data;
}

test("C03 verbatim: a File with exactly 5 questions and a 30-minute plan, the stated details only, gaps named", () => {
  const { out, ctx } = turn(C03);
  const data = assertPrepFile(out, 5, 30);
  const said = section(data, /as you said it/);
  assert.deepEqual(said.items.map((i) => [i.label, i.value, i.source]), [["Role", "customer support", "From you"], ["When", "tomorrow", "From you"]]);
  const gaps = section(data, /^Not on file/).items.map((i) => i.label);
  assert.deepEqual(gaps, ["Company", "Where"], "what was not said is named, never filled in");
  assert.ok(/\bcompany\b/.test(out.reply) && /where it is or how you join/.test(out.reply), out.reply);
  assert.ok(!/tonight|then stop/i.test(out.reply), "not the night-before template");
  assert.ok(questionsOf(data).some((q) => /customer/i.test(q.value)), "a support role gets customer-facing practice");
  assert.ok(!ctx.statedFacts || !(ctx.statedFacts.facts || []).length, "nothing was recorded about the person from this ask");
});

test("A15.1 verbatim (offline replay): the File, not the interview brief", () => {
  const { out } = turn(A15_1);
  const data = assertPrepFile(out, 5, 30);
  assert.ok(!/Your interview brief/.test(out.reply));
  assert.deepEqual(section(data, /^Not on file/).items.map((i) => i.label), ["Company", "When", "Where", "Role"]);
  assert.equal(section(data, /as you said it/), undefined, "nothing was said, so nothing is listed as said");
});

test("counts and lengths are honored exactly: 3 questions / 15 minutes, 8 / 45, 1 / 5, 10 / 60, an hour, half an hour", () => {
  for (const [m, n, min] of [
    ["make me a one page prep file for my interview with 3 questions and a 15 minute plan", 3, 15],
    ["Create an interview prep page with eight questions and a 45-minute plan", 8, 45],
    ["Make a one-page interview prep File with 1 question and a 5 minute plan", 1, 5],
    ["Put together a one-pager for my interview: 10 practice questions and a 60 min plan", 10, 60],
    ["Make an interview prep file with 4 questions for an hour of practice", 4, 60],
    ["Make an interview prep file with 6 questions, half an hour", 6, 30],
  ]) assertPrepFile(turn(m).out, n, min);
});

test("no count or length said: 5 and 30 are used and the reply says so", () => {
  const { out } = turn("Make me a one-page interview prep File");
  assertPrepFile(out, 5, 30);
  assert.ok(/didn't say how many questions or how long/.test(out.reply), out.reply);
});

test("no company is invented: a named company is the person's words with no claims about it; none named, none appears", () => {
  const { out } = turn("make me a one page prep file for my interview at Acme Robotics with 3 questions and a 15 minute plan");
  const data = assertPrepFile(out, 3, 15);
  const co = section(data, /as you said it/).items.find((i) => i.label === "Company");
  assert.equal(co.source, "From you");
  assert.match(co.value, /^Acme Robotics\. Nothing on this page is about how Acme Robotics interviews: no company file is on record for it\.$/);
  assert.equal(allText(data).split("Acme Robotics").length - 1, 2, "the name appears only in that one line");
  // None named: no company name from the company-file library appears anywhere on the page.
  const plain = assertPrepFile(turn(A15_1).out, 5, 30);
  const names = Prep.cirLibrary().map((c) => (Prep.normalizeCir(c) || {}).company_name).filter((n) => n && n.length > 3);
  assert.ok(names.length > 5, "the library is loaded");
  for (const n of names) assert.ok(!allText(plain).includes(n), `no company invented: ${n}`);
});

test("confirmed facts only: a draft fact from a resume is never on the page", () => {
  const profile = { basics: { name: "Jordan Lee" }, facts: [
    { id: "F1", kind: "experience", text: "Cashier at a grocery store, 2 years; trained 4 new hires on the register.", source: "resume-ingest", needs_confirmation: false },
    { id: "F2", kind: "experience", text: "Shift lead at a call center handling 60 calls a day.", source: "resume-ingest", needs_confirmation: true },
  ] };
  const { out } = turn(A15_1, { profile });
  const data = assertPrepFile(out, 5, 30);
  const rec = section(data, /^From your record/);
  assert.ok(rec, "the confirmed fact is on the page");
  assert.deepEqual(rec.items.map((i) => [i.value, i.source]), [["Cashier at a grocery store, 2 years; trained 4 new hires on the register.", "From your resume"]]);
  assert.ok(!/call center|60 calls/.test(allText(data)), "the unconfirmed draft is not used");
  assert.ok(/1 confirmed fact/.test(out.reply), out.reply);
});

test("a count or length one page cannot honor is said, and no File is made with a different number", () => {
  for (const [m, problem] of [["Make a one-page interview prep File with 25 questions and a 30-minute plan", "questions"], ["Make a one-page interview prep File with five questions and a 3-minute plan", "minutes"], ["Make a one-page interview prep File with ten questions and a 6-minute plan", "fit"]]) {
    const { out } = turn(m);
    assert.equal(out.result.file, undefined, `${m}: no File`);
    assert.equal(out.result.payload.kind, "prep_file_refused");
    assert.equal(out.result.payload.problem, problem);
    assert.match(out.reply, /didn't make the File/);
  }
});

test("not a prep File ask: the other prep routes keep their asks", () => {
  for (const m of ["give me a practice question", "I have an interview tomorrow; do not invent company facts", "what's on file for me?", "how do I prepare for an interview?", "tailor my resume and send me the PDF file in this chat"]) {
    const r = turn(m).out;
    assert.ok(!(r.result && r.result.file), `${m} -> ${r.intent}`);
  }
});

test("the night-before answer no longer claims sleep is a scored input", () => {
  const { out } = turn("I have an interview tomorrow; do not invent company facts");
  assert.equal(out.intent, "prep_brief");
  assert.match(out.reply, /plan for tonight/);
  assert.ok(!/scored input/i.test(out.reply), out.reply);
});

test("prepFilePlan adds up exactly for every length and count it accepts", () => {
  assert.equal(typeof Prep.prepFilePlan, "function");
  assert.deepEqual([Prep.PREP_FILE_MAX_QUESTIONS, Prep.PREP_FILE_MIN_MINUTES, Prep.PREP_FILE_MAX_MINUTES], [10, 5, 180]);
  for (let n = 1; n <= Prep.PREP_FILE_MAX_QUESTIONS; n++) for (let m = Math.max(Prep.PREP_FILE_MIN_MINUTES, n + 2); m <= Prep.PREP_FILE_MAX_MINUTES; m++) {
    const plan = Prep.prepFilePlan(m, n, {});
    assert.equal(plan.reduce((a, b) => a + b.min, 0), m, `${n} questions, ${m} min`);
    assert.ok(plan.every((b) => b.min >= 1));
    assert.ok(plan[1].min >= n, "a minute a question out loud");
  }
});
