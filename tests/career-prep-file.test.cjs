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
  // BETA B1 (2026-11-05): the reply makes no claim about the record ("Your side comes only from 1 confirmed fact" was said of a
  // page whose questions and plan are general); the page shows what it lists under its own heading.
  assert.ok(!/confirmed facts?|your record/i.test(out.reply), out.reply);
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

/* Review of PR #494 (2026-11-04): a refusal of the File, "file" as a verb, and lengths said as compound words or hour
   phrases. The claim is dispatched early, so every message that is not a prep File ask must reach the route it reached
   without the claim (checked by running the same turn with prepFileRequest switched off). */
const withoutClaim = (fn) => { const real = Prep.prepFileRequest; Prep.prepFileRequest = () => null; try { return fn(); } finally { Prep.prepFileRequest = real; } };

test("review 1: a refusal of the File makes no File; five questions asked are answered as text, exactly five", () => {
  const { out } = turn("Don't make a file, just give me five interview questions");
  assert.equal(out.result && out.result.file, undefined, out.reply);
  assert.equal(out.result.sends, 0);
  const lines = out.reply.split("\n").filter((l) => /^\d+\. \S/.test(l));
  assert.equal(lines.length, 5, out.reply);
  assert.match(out.reply, /No File was made/);
  for (const m of ["I don't want a file for my interview, just tell me what to expect", "Stop. Do not create a prep file for the interview.", "No file please, just give me 3 interview questions", "Skip the one-pager and give me two interview questions"]) {
    const r = turn(m).out;
    assert.ok(!(r.result && r.result.file), `${m}: no File (${r.intent})`);
    assert.notEqual(r.result && r.result.payload && r.result.payload.kind, "prep_file", m);
  }
  const three = turn("No file please, just give me 3 interview questions").out;
  assert.equal(three.reply.split("\n").filter((l) => /^\d+\. \S/.test(l)).length, 3, three.reply);
  // A plain "not" about something else is not a refusal of the File.
  assertPrepFile(turn("Make a one-page interview prep file with five questions, not a long doc, and a 30 minute plan").out, 5, 30);
});

test("review 2: 'file' as a verb is never a File ask, and no role is read from it", () => {
  for (const m of ["I need to file my W-2 before the interview", "I need to file my expenses from the interview trip", "Can I file a complaint about the interview?", "I'll file the interview notes later", "should I file for unemployment while I wait to hear back from my interview?"]) {
    assert.equal(Prep.prepFileRequest(m), null, m);
    const r = turn(m).out;
    assert.ok(!(r.result && r.result.file), `${m}: no File`);
    assert.ok(!/expenses from the/.test(JSON.stringify(r)), `${m}: no invented role`);
  }
  assert.equal(Prep.prepFileStated("I need to file my expenses from the interview trip", null).role, undefined);
  assert.equal(Prep.prepFileStated("my trip to the interview", null).role, undefined);
  assert.equal(Prep.prepFileStated("make a prep file for my data analyst interview", null).role, "data analyst");
});

test("review 3: lengths and counts in compound words and hour phrases are read exactly, and a refusal quotes them right", () => {
  const minutes = { "an hour and a half": 90, "one and a half hours": 90, "1.5 hours": 90, "two and a half hours": 150, "twenty-five minute": 25, "twenty five minutes": 25, "forty-five minutes": 45, "fifty five mins": 55,
    "half an hour": 30, "a half-hour": 30, "a quarter of an hour": 15, "quarter-hour": 15, "three quarters of an hour": 45, "an hour": 60, "two hours": 120, "ninety minutes": 90, "an hour and a quarter": 75, "35 min": 35 };
  for (const [p, want] of Object.entries(minutes)) assert.equal(Prep.prepFileMinutes(p), want, p);
  for (const [m, n, min] of [["Make an interview prep file with 4 questions and an hour and a half plan", 4, 90], ["Make an interview prep file with 6 questions and a twenty-five minute plan", 6, 25],
    ["Make an interview prep file with seven questions for a quarter of an hour", 7, 15], ["Make an interview prep file with 2 questions, forty five minutes", 2, 45]]) assertPrepFile(turn(m).out, n, min);
  const q = turn("Make a one-page interview prep File with twenty-five questions and a 30-minute plan").out;
  assert.equal(q.result.payload.problem, "questions");
  assert.equal(q.result.payload.questions, 25);
  assert.match(q.reply, /you asked for 25\b/);
  const m = turn("Make a one-page interview prep File with five questions and a three hour and a half plan").out;
  assert.equal(m.result.payload.minutes, 210);
  assert.match(m.reply, /\b210 minutes is outside/);
});

test("review 4: messages mentioning 'file' or 'interview' that are not prep File asks reach their normal routes", () => {
  for (const m of ["I need to file my W-2 before the interview", "I need to file my expenses from the interview trip",
    "what's on file for me?", "what goes in an interview prep file?", "how should I prepare for my interview tomorrow?", "give me a practice question for my interview",
    "I have an interview tomorrow; do not invent company facts", "tailor my resume and send me the PDF file in this chat", "did I upload my resume file?", "mock interview please",
    "I have a phone interview with Acme on Friday", "how did my interview go? I think it went badly"]) {
    const a = turn(m).out, b = withoutClaim(() => turn(m).out);
    assert.ok(!(a.result && a.result.file), `${m}: no File`);
    assert.equal(a.intent, b.intent, `${m}: same route as without the prep File claim`);
    assert.equal(a.reply, b.reply, `${m}: same reply as without the prep File claim`);
  }
});

/* Re-review of PR #494 (2026-11-04): a length or count said in words ("a couple of hours", "a few questions") is read, and
   one that is not an exact number ("several hours") is quoted with how it was read: the reply never says it was unsaid.
   A count-less "no file" prep ask gets the interview prep (the brief), with no File, not the generic catch-all. */
const numberedLines = (r) => r.split("\n").filter((l) => /^\d+\. \S/.test(l)).length;

test("re-review 1: 'a couple (of) hours' is 120, 'a few hours' is 180, and words for a length are never called unsaid", () => {
  for (const [p, want] of Object.entries({ "a couple of hours": 120, "a couple hours": 120, "couple of hours": 120, "a few hours": 180, "a couple of minutes": 2, "a couple minutes": 2, "a few minutes": 3, "a few mins": 3 })) assert.equal(Prep.prepFileMinutes(p), want, p);
  for (const [m, n, min] of [["Make an interview prep file with 4 questions for a couple of hours", 4, 120], ["Make an interview prep file with 3 questions and a couple hours", 3, 120], ["Make an interview prep file with 6 questions, a few hours", 6, 180]]) {
    const out = turn(m).out;
    assertPrepFile(out, n, min);
    assert.ok(!/didn't say/.test(out.reply), `${m}: ${out.reply}`);
  }
  for (const [m, phrase] of [["Make an interview prep file with five questions and a couple of minutes", "a couple of minutes"], ["Make an interview prep file with five questions and a few minutes", "a few minutes"]]) {
    const out = turn(m).out;
    assert.equal(out.result.file, undefined, m);
    assert.equal(out.result.payload.problem, "minutes");
    assert.ok(out.reply.includes(`you said "${phrase}"`), out.reply);
    assert.ok(!/didn't say/.test(out.reply), out.reply);
  }
  // A length in words that is not an exact number: the default is used, the words are quoted, and how they were read is said.
  const vague = turn("Make an interview prep file with 4 questions for several hours").out;
  assertPrepFile(vague, 4, 30);
  assert.ok(vague.reply.includes('You said "several hours", which isn\'t an exact length, so I read it as 30 minutes.'), vague.reply);
  assert.ok(!/didn't say/.test(vague.reply), vague.reply);
  // A numeric length is quoted as its number, not as "a 30-minute".
  const r = turn("Make a one-page interview prep File with five questions and a 3-minute plan").out;
  assert.ok(/; 3 minutes is outside that/.test(r.reply) && !/you said "a 3/.test(r.reply), r.reply);
});

test("re-review 2: 'a couple (of) questions' is 2 and 'a few questions' is 3; 'some questions' is quoted with how it was read", () => {
  for (const [m, n] of [["Make an interview prep file with a couple questions and a 15 minute plan", 2], ["Make an interview prep file with a couple of questions and a 15 minute plan", 2], ["Make an interview prep file with a few questions and a 15 minute plan", 3], ["Make an interview prep file with a few practice questions and a 15 minute plan", 3], ["Make an interview prep file with a dozen questions and a 30 minute plan", null]]) {
    const out = turn(m).out;
    if (n === null) { assert.equal(out.result.payload.problem, "questions"); assert.equal(out.result.payload.questions, 12); continue; }
    assertPrepFile(out, n, 15);
    assert.ok(!/didn't say/.test(out.reply), `${m}: ${out.reply}`);
  }
  const vague = turn("Make an interview prep file with some questions and a 20 minute plan").out;
  assertPrepFile(vague, 5, 20);
  assert.ok(vague.reply.includes('You said "some questions", which isn\'t an exact number, so I read it as 5 questions.'), vague.reply);
  assert.ok(!/didn't say/.test(vague.reply), vague.reply);
  // A count in words with no File: the text answer has that many.
  assert.equal(numberedLines(turn("Don't make a file, just give me a couple of interview questions").out.reply), 2);
  // Nothing said at all is still said plainly.
  assert.ok(/didn't say how many questions or how long/.test(turn("Make me a one-page interview prep File").out.reply));
});

test("re-review 3: a count-less 'no file' interview prep ask gets the prep brief with no File, never the catch-all", () => {
  for (const m of ["I don't want a file for my interview, just tell me what to expect", "Make me interview questions, no file needed"]) {
    const out = turn(m).out;
    assert.equal(out.intent, "prep_brief", `${m}: ${out.intent} ${out.reply}`);
    assert.ok(!(out.result && out.result.file), `${m}: no File`);
    assert.match(out.reply, /^No File was made, as you asked\./, m);
    assert.equal(out.result.sends, 0);
  }
  // Third review: one whose route without the claim is already the brief keeps that route and reply exactly.
  const stop = "Stop. Do not create a prep file for the interview.";
  const a = turn(stop).out, b = withoutClaim(() => turn(stop).out);
  assert.equal(a.intent, "prep_brief");
  assert.ok(!(a.result && a.result.file));
  assert.equal(a.reply, b.reply);
});

/* Third review of PR #494 (2026-11-04): a count-less "no file" message is routed as the original message, with the prep File
   claim off, so the real ask keeps its route (a mock, a pay question, a cancel, a send). Only when that route is the generic
   catch-all and the rest of the message is itself an interview prep ask does the interview brief answer it. */
test("third review: a 'no file' message with another ask keeps the route it has without the prep File claim", () => {
  for (const m of [
    "Don't make a file for my mock interview, start a mock interview",
    "No file, but how much does Google pay interns? I have an interview",
    "I don't need a document, I have an interview tomorrow, what should I wear?",
    "I don't want a file, I want to cancel my interview with Acme",
    "no file. send my application to Acme before the interview",
    "No file please, can you run a mock interview with me?",
    "I don't want a doc; what is the interview process at Goldman Sachs?",
    "Skip the file, I have an interview tomorrow; do not invent company facts",
  ]) {
    const a = turn(m).out, b = withoutClaim(() => turn(m).out);
    assert.ok(!(a.result && a.result.file), `${m}: no File`);
    assert.equal(a.intent, b.intent, `${m}: same route as without the prep File claim`);
    assert.equal(a.reply, b.reply, `${m}: same reply as without the prep File claim`);
  }
  // The three named in the review, by route.
  assert.equal(turn("Don't make a file for my mock interview, start a mock interview").out.intent, "prep_mock_start");
  assert.equal(turn("No file, but how much does Google pay interns? I have an interview").out.intent, "company_intel");
  const wear = turn("I don't need a document, I have an interview tomorrow, what should I wear?").out;
  assert.ok(!/^No File was made, as you asked/.test(wear.reply), wear.reply);
  // A pure prep ask whose route without the claim is the catch-all gets the brief, and only then.
  for (const m of ["I don't want a file for my interview, just tell me what to expect", "Make me interview questions, no file needed"]) {
    assert.equal(withoutClaim(() => turn(m).out).intent, "career_catchall", `${m}: the catch-all without the claim`);
    const out = turn(m).out;
    assert.equal(out.intent, "prep_brief", m);
    assert.match(out.reply, /^No File was made, as you asked\./, m);
  }
});
