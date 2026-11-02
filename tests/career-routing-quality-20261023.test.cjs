'use strict';
// Routing quality (2026-10-23, coordinator's remaining block). Synthetic cases only; no eval or held-out text.
// (a) "I want to be a <role>" reaches the role library like "become"; the generic ladder never routes a field switch
//     through promotions in the old field ("teacher -> senior teacher -> ... -> director-level seat -> tech").
// (b) a non-company interview-prep ask gets a brief for its role family, not one generic brief for every role.
// (c) "becme" reads as "become".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const Reply = D("140-career-reply.js");
const host = CareerHost.createCareerHost({ CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"), CareerReply: Reply, CareerContainment: D("143-career-containment.js") });
let n = 0;
const ask = (text) => { n += 1; const ctx = host.createTurnCtx({ userId: `q-${n}`, threadId: `q-${n}`, now: Date.parse("2026-10-23T15:00:00Z"), snapshot: null, postings: [] }); return host.runTurn(text, ctx); };
const isFallback = (o) => !String(o.reply || "").trim() || Reply.isFallbackText(String(o.reply)) || o.contained || o.intent === "career_fallback";

test("(a) 'I want to be a data analyst' gets the same owner and answer shape as 'I want to become a data analyst'", () => {
  const be = ask("I want to be a data analyst"), become = ask("I want to become a data analyst");
  assert.equal(be.intent, become.intent);
  assert.match(String(be.reply), /Data Analyst — what its postings actually ask for/);
});
for (const q of ["I want to be a teacher", "I want to be a pharmacist one day"]) {
  test(`(a) "${q}" never gets a ladder built from 'your current role'`, () => {
    const r = String(ask(q).reply);
    assert.ok(!/senior your current role|your current role manager/.test(r), r.slice(0, 200));
    assert.ok(!isFallback(ask(q)));
  });
}
test("(a) a field switch is never routed through promotions in the old field", () => {
  const r = String(ask("I'm a teacher and want to move into tech, what are my options?").reply);
  assert.ok(!/senior teacher|teacher manager|director-level seat/.test(r), r.slice(0, 300));
  assert.match(r, /tech/);
});
test("(a) control: a climb inside one field keeps its ladder", () => {
  const r = String(ask("I'm an analyst and I want to be a director one day").reply);
  assert.match(r, /senior analyst/);
});
test("(a) control: an authored switch ladder (retail -> HR) is unchanged", () => {
  assert.match(String(ask("I'm a retail manager and want to move into HR eventually").reply), /HR coordinator/);
});

const PREP = [
  ["How do I prepare for a software engineering interview?", /coding|data structures/i, /linked list|time and space|system design/i],
  ["what should I do to get ready for a finance interview", /three statements|valuation|DCF/i, /three financial statements|depreciation|DCF/i],
  ["how should I prepare for a nursing interview", /patient/i, /patient/i],
  ["help me prepare for a consulting interview", /case/i, /market size|profits fell/i],
];
for (const [q, tests, qs] of PREP) {
  test(`(b) "${q}" gets a brief for its role family`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "prep_brief");
    assert.ok(!/for this company/i.test(r), "no company named, so no 'this company'");
    assert.match(r, tests); assert.match(r, qs);
    for (const b of Reply.splitBubbles(r)) assert.ok(Reply.lint(b).ok, `${b} -> ${Reply.lint(b).violations}`);
  });
}
test("(b) two role families get two different briefs", () => {
  assert.notEqual(String(ask("How do I prepare for a software engineering interview?").reply), String(ask("what should I do to get ready for a finance interview").reply));
});

test("(c) 'I want to becme a data analyst' reads as become", () => {
  const o = ask("I want to becme a data analyst");
  assert.ok(!isFallback(o));
  assert.match(String(o.reply), /Data Analyst/);
});
test("(c) control: 'became' is a real word and is never rewritten", () => {
  assert.equal(D("142-career-router.js").detypo("I became a nurse last year"), "I became a nurse last year");
});

// (d) Coordinator probe on a48b1a9d: a practice request asked politely or as a question fell back after a prep brief,
//     while the imperative "give me a practice question" reached the practice owner.
function afterBrief(q) {
  n += 1; const th = `prac-${n}`; let snap = null, out = null;
  for (const text of ["help me prepare for my interview with a hospital", q]) {
    const ctx = host.createTurnCtx({ userId: th, threadId: th, now: Date.parse("2026-10-23T15:00:00Z") + n * 1000, snapshot: snap, postings: [] });
    out = host.runTurn(text, ctx); snap = host.extractSnapshot(ctx);
  }
  return out;
}
for (const q of ["can we do a practice question?", "can we practice?", "what else should I practice?", "could you ask me another practice question?", "let's practice", "can I practice an answer with you?"]) {
  test(`(d) "${q}" after a prep brief reaches the practice owner`, () => {
    const o = afterBrief(q);
    assert.ok(!isFallback(o), `${o.handler || "-"}/${o.intent || "-"}${o.contained ? " contained" : ""}`);
    assert.match(String(o.reply), /question/i);
  });
}
test("(d) control: 'practice' as a noun is not a practice request", () => {
  for (const q of ["what are the best practices for a resume?", "I work at a small law practice"]) {
    const r = String(ask(q).reply);
    assert.ok(!/^Here is your question/.test(r), `${q} -> ${r.slice(0, 120)}`);
  }
});

// (e) Coordinator probe on b3307448: resume-guidance and two-field decision asks had no owner. Synthetic cases only.
// 1v1 (2026-11-01): each ask gets its own short answer (format: the layout; length: one page); the general asks still
// name results with numbers and tailoring. Wording pins only; the owner and the lint are unchanged.
for (const [q, want] of [["what are best practices for resumes?", [/result|number/i, /tailor/i]], ["how should I format my resume?", [/headings|tables/i]], ["what makes a good resume", [/result|number/i, /tailor/i]], ["give me resume tips", [/result|number/i, /tailor/i]], ["how long should my resume be?", [/one page/i]]]) {
  test(`(e) resume guidance: "${q}" is answered as guidance`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_resume_guidance", `${o.intent}: ${r.slice(0, 160)}`);
    for (const re of want) assert.match(r, re);
    for (const b of Reply.splitBubbles(r)) assert.ok(Reply.lint(b).ok, `${b} -> ${Reply.lint(b).violations}`);
  });
}
test("(e) control: a real document ask still reaches document delivery", () => {
  assert.equal(ask("send me my resume pdf").intent, "career_document_delivery");
});
for (const [q, a, b] of [["should I practice law or medicine?", /law/i, /medic/i], ["should I go into law or medicine?", /law/i, /medic/i], ["law or medicine, which should I pick?", /law/i, /medic/i], ["should I become a lawyer or a doctor?", /law/i, /medic/i], ["should I study nursing or teaching?", /nurs/i, /teach/i]]) {
  test(`(e) decision: "${q}" names both fields and does not pick for the person`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_field_decision", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, a); assert.match(r, b);
    for (const bb of Reply.splitBubbles(r)) assert.ok(Reply.lint(bb).ok, `${bb} -> ${Reply.lint(bb).violations}`);
  });
}
test("(e) decision: a licensed field carries its training path", () => {
  const r = String(ask("should I go into law or medicine?").reply);
  assert.match(r, /bar exam/); assert.match(r, /residency/);
});
test("(e) control: two companies are not a field decision", () => {
  assert.notEqual(ask("should I apply to Google or Meta?").intent, "career_field_decision");
});

// (f) Found reading (e)'s replies: a resume-improvement ask reached tailoring, which said "The target is set — the
// role you named" when no role was named; a review ask fell back. Synthetic cases only.
test("(f) 'how do I make my resume better' is guidance, not a tailoring target", () => {
  const o = ask("how do I make my resume better"), r = String(o.reply);
  assert.equal(o.intent, "career_resume_guidance", `${o.intent}: ${r.slice(0, 160)}`);
});
test("(f) a tailor ask that names no role never claims a target is set", () => {
  const r = String(ask("tailor my resume").reply);
  assert.ok(!/target is set|the role you named/i.test(r), r.slice(0, 200));
  assert.match(r, /resume/i);
});
test("(f) a tailor ask that names a role reads that role back", () => {
  const r = String(ask("tailor my resume for a data analyst role").reply);
  assert.match(r, /data analyst/i, r.slice(0, 200));
});
test("(f) control: a tailor ask naming a company keeps its target", () => {
  const o = ask("tailor my resume to the Google software engineering internship");
  assert.equal(o.intent, "career_tailor"); assert.match(String(o.reply), /Google/);
});
for (const q of ["can you review my resume?", "resume feedback please", "is my resume good?", "can you look at my resume?"]) {
  test(`(f) review: "${q}" says no resume is on file and gives what it checks`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_resume_guidance", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, /no resume (?:of yours )?(?:is )?on file/i, r.slice(0, 200));
    for (const b of Reply.splitBubbles(r)) assert.ok(Reply.lint(b).ok, `${b} -> ${Reply.lint(b).violations}`);
  });
}
test("(f) control: 'do you have my resume?' stays the on-file answer", () => {
  assert.equal(ask("do you have my resume?").intent, "career_resume_on_file");
});
test("(f) a cover-letter ask that names no role never claims a target is set", () => {
  const r = String(ask("write me a cover letter").reply);
  assert.ok(!/target is set|the role you named|\bnull\b/i.test(r), r.slice(0, 200));
});
test("(f) control: improving a resume FOR a target is tailoring", () => {
  assert.equal(ask("improve my resume for this posting").intent, "career_tailor");
});

// (g) Coordinator 2026-10-23, the four known gaps before candidate freeze. Synthetic cases only.
const lintAll = (r) => { for (const b of Reply.splitBubbles(r)) assert.ok(Reply.lint(b).ok, `${b} -> ${Reply.lint(b).violations}`); };
for (const [q, a, b] of [["should I take the Google offer or the Meta offer?", /Google/, /Meta/], ["I have two offers, one from Stripe and one from Airbnb. Which should I take?", /Stripe/, /Airbnb/], ["Stripe offer vs Airbnb offer, which is better?", /Stripe/, /Airbnb/], ["how do I choose between two job offers?", /offer/i, /offer/i]]) {
  test(`(g) offer decision: "${q}" compares the offers and leaves the choice to the person`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_offer_decision", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, a); assert.match(r, b); assert.match(r, /equity/i); assert.match(r, /stays yours/i);
    assert.ok(!/\bfile —|The bar:/.test(r), r.slice(0, 160));
    lintAll(r);
  });
}
test("(g) offer decision: an offer in hand against one still pending speaks to the deadline", () => {
  const o = ask("should I accept the offer from Amazon or wait for Microsoft?"), r = String(o.reply);
  assert.equal(o.intent, "career_offer_decision", `${o.intent}: ${r.slice(0, 160)}`);
  assert.match(r, /deadline/i); assert.match(r, /Amazon/); assert.match(r, /Microsoft/);
});
test("(g) control: a company's interview process stays a company question", () => {
  assert.equal(ask("what is Google's interview process?").intent, "company_intel");
});
for (const [q, re] of [["should I put my GPA on my resume?", /GPA[\s\S]*3\.5/], ["should I include my GPA?", /GPA[\s\S]*3\.5/], ["should I put a photo on my resume?", /photo/i], ["should I list references on my resume?", /references/i], ["do I need an objective on my resume?", /summary/i]]) {
  test(`(g) resume item: "${q}" is answered on that item`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_resume_guidance", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, re); assert.ok(!/^What makes a resume work/.test(r), r.slice(0, 120));
    lintAll(r);
  });
}
test("(g) resume item: the GPA answer never tells anyone to misstate it", () => {
  assert.match(String(ask("should I put my GPA on my resume?").reply), /true number/i);
});
for (const q of ["update my resume", "I need to update my resume with my new job"]) {
  test(`(g) "${q}" is an update, answered on what is on file`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_resume_update", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, /no resume (?:of yours )?(?:is )?on file/i); assert.match(r, /confirm/i);
    lintAll(r);
  });
}
for (const [q, re] of [["tips for a cover letter", /specific/i], ["how do I write a good cover letter?", /specific/i], ["what should a cover letter say?", /posting/i], ["do I need a cover letter?", /asks for/i], ["how long should a cover letter be?", /words|page/i]]) {
  test(`(g) cover-letter guidance: "${q}"`, () => {
    const o = ask(q), r = String(o.reply);
    assert.equal(o.intent, "career_cover_letter_guidance", `${o.intent}: ${r.slice(0, 160)}`);
    assert.match(r, re); lintAll(r);
  });
}
test("(g) control: a cover letter for a named company is still a draft request", () => {
  assert.equal(ask("write me a cover letter for Stripe").intent, "career_tailor");
});
function thread(turns) {
  n += 1; const th = `seq-${n}`; let snap = null; const outs = [];
  turns.forEach((text, i) => { const ctx = host.createTurnCtx({ userId: th, threadId: th, now: Date.parse("2026-10-23T15:00:00Z") + i * 60000, snapshot: snap, postings: [] }); outs.push(host.runTurn(text, ctx)); snap = host.extractSnapshot(ctx); });
  return outs;
}
const servedQ = (o) => { const m = String(o.reply).match(/^Here is your question: ([^\n]+)/); return m ? m[1] : null; };
test("(g) practice: repeated asks in a thread with no bank sector serve different questions", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "another practice question", "what else should I practice?", "one more question"]);
  const qs = outs.slice(1).map(servedQ);
  assert.ok(qs.every(Boolean), JSON.stringify(outs.slice(1).map((o) => String(o.reply).slice(0, 80))));
  assert.equal(new Set(qs).size, qs.length, JSON.stringify(qs));
});
test("(g) practice: a nursing thread draws on nursing questions first", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question"]);
  assert.match(String(outs[1].reply), /patient/i, String(outs[1].reply).slice(0, 160));
});
test("(g) practice: a consulting practice ask serves a case, never a method card", () => {
  const outs = thread(["help me prep for a consulting case interview", "give me a practice question", "another question"]);
  for (const o of outs.slice(1)) assert.ok(!/Clarify the objective|issue tree|framework/i.test(String(o.reply).split("\n")[0]), String(o.reply).slice(0, 160));
});
for (const [brief, answer] of [["help me prepare for my interview with a hospital", "I have three years on a cardiac floor, and I chose nursing because my grandmother's nurse changed how I saw care; I led our unit's falls project and falls dropped 20 percent."], ["help me prep for a data analyst interview", "I would group by candidate, count distinct skills among python, tableau and postgres, and keep candidates having a count of exactly three."]]) {
  test(`(g) practice: an answer to the served question is scored (${brief.slice(-20)})`, () => {
    const outs = thread([brief, "give me a practice question", answer]);
    const o = outs[2], r = String(o.reply);
    assert.ok(!isFallback(o), `${o.handler}/${o.intent}: ${r.slice(0, 120)}`);
    assert.equal(o.intent, "prep_brief"); assert.match(r, /\d\/5/, r.slice(0, 200));
    lintAll(r);
  });
}
test("(g) practice: a non-finance answer is not graded on finance linkage", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "I have three years on a cardiac floor, and I chose nursing because my grandmother's nurse changed how I saw care."]);
  assert.ok(!/linkage|drill key|statements/i.test(String(outs[2].reply)), String(outs[2].reply));
});
test("(g) practice: a model-answer ask on a non-finance question carries no finance grading points", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "what is the model answer?"]);
  assert.ok(!/retained earnings|three statements|cash flow/i.test(String(outs[2].reply)), String(outs[2].reply));
});
test("(g) control: a job ask after a served question is not taken as an answer", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "actually can you find me nursing jobs in Boston instead of this practice"]);
  assert.ok(!/scored/i.test(String(outs[2].reply)), String(outs[2].reply).slice(0, 160));
});
test("(g) practice: 'next question' in a thread with no bank sector serves the next question", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "next question"]);
  assert.ok(servedQ(outs[2]) && servedQ(outs[2]) !== servedQ(outs[1]), String(outs[2].reply).slice(0, 160));
});
test("(g) practice: a model-answer ask with no banked answer says what a strong answer does", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "what is the model answer?"]);
  assert.match(String(outs[2].reply), /strong answer/i, String(outs[2].reply));
});
test("(g) practice: a case prompt is never cut at 'vs.'", () => {
  const outs = thread(["help me prep for a consulting case interview", "give me a practice question"]);
  assert.ok(!/\bvs\.\s*(?:\n|$)|\bvs\.\s+From\b/.test(String(outs[1].reply)), String(outs[1].reply).slice(0, 200));
});
test("(g) control: an ask phrased as a statement after a served question is not scored as an answer", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "harder one please, I'm weakest on prioritizing patients under pressure"]);
  assert.ok(!/scored/i.test(String(outs[2].reply)), String(outs[2].reply).slice(0, 160));
});
test("(g) practice: 'harder one, I'm weakest on X' in a thread with no bank sector serves a question on X", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "harder one please, I'm weakest on prioritizing patients under pressure"]);
  assert.ok(servedQ(outs[2]), `${outs[2].handler}/${outs[2].intent}: ${String(outs[2].reply).slice(0, 120)}`);
  assert.match(servedQ(outs[2]), /prioriti/i);
});

// (h) Coordinator 2026-10-23, last fix before freeze: the practice rubric's tech bias. Specificity scored tech keywords
//     (python, react, sql ...) and told every answer to "name the tool". Synthetic answers only.
const Prep = D("127-career-prep.js");
const CLINICAL = "On my cardiac telemetry unit during a night shift, a patient's heart rate climbed and his blood pressure dropped after a new medication. I held the next dose, called the physician, and we caught early sepsis; I led the handoff and he was stable by morning.";
const CLIENT = "At my last internship our retail client's margin fell from 12 to 8 percent in a year. I split revenue and cost, found freight costs had doubled, and recommended consolidating two warehouses, which the client estimated would save 3 million dollars.";
test("(h) a clinical answer earns specificity on clinical detail, not tech keywords", () => {
  const plain = Prep.scoreAnswer(CLINICAL).scores.specificity, clinical = Prep.scoreAnswer(CLINICAL, { family: "clinical" }).scores.specificity;
  assert.ok(clinical >= 3 && clinical > plain, `clinical ${clinical} vs default ${plain}`);
});
test("(h) a consulting answer earns specificity on client numbers", () => {
  assert.ok(Prep.scoreAnswer(CLIENT, { family: "consulting" }).scores.specificity >= 3);
});
test("(h) control: with no family the rubric is unchanged, and the tech family scores tech answers as before", () => {
  const tech = "I built a Flask app in Python over one summer and 40 classmates used it to plan study groups.";
  assert.deepEqual(Prep.scoreAnswer(tech, { family: "tech" }).scores, Prep.scoreAnswer(tech).scores);
});
// Answers carry a number, so the evidence gap does not mask the specificity advice (the shape the probe surfaced).
for (const [brief, answer, re] of [
  ["help me prepare for my interview with a hospital", "I really care about people and I helped a lot of them, and over 2 years things got about 20 percent better overall.", /patient|clinical/i],
  ["help me prep for a consulting case interview", "I would look at the problem and think about it, and in my experience things improved by about 20 percent overall in 2 years.", /client/i],
  ["help me prepare for my interview", "I am a hard worker and I like people, and over 2 years things got about 20 percent better overall.", /setting/i],
]) {
  test(`(h) the specificity advice fits the role (${brief.slice(-28)})`, () => {
    const outs = thread([brief, "give me a practice question", answer]);
    const r = String(outs[2].reply);
    assert.match(r, /Fix first: Specificity/, r);
    assert.ok(!/name the tool/i.test(r), r);
    assert.match(r, re, r);
  });
}
test("(h) the probe's nursing answer (clinical detail, a number) is not told specificity is its top fix", () => {
  const outs = thread(["help me prepare for my interview with a hospital", "give me a practice question", "I have three years on a cardiac floor, and I chose nursing because my grandmother's nurse changed how I saw care; I led our unit's falls project and falls dropped 20 percent."]);
  const r = String(outs[2].reply);
  assert.match(r, /scored/i); assert.ok(!/name the tool|Fix first: Specificity/.test(r), r);
  assert.match(r, /cannot tell whether/i);
});
test("(h) structure credits the role's own action verbs (recommended, held, called), not only built/wrote/designed", () => {
  assert.ok(Prep.scoreAnswer(CLIENT, { family: "consulting" }).scores.structure >= 3, JSON.stringify(Prep.scoreAnswer(CLIENT, { family: "consulting" }).scores));
  assert.ok(Prep.scoreAnswer(CLINICAL, { family: "clinical" }).scores.structure >= 3, JSON.stringify(Prep.scoreAnswer(CLINICAL, { family: "clinical" }).scores));
});
