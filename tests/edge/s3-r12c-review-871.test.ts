// Review of PR #871 (B1, B2): the person's own words in this chat never let a sentence past the support judge, and they back only
// what the person said about themselves, in the first person. Every probe below stood on 4312fcc9d.
// Run: deno test -A --no-check tests/edge/s3-r12c-review-871.test.ts
import { Ledger, ownStatements, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { consentRule, heldReply, type Look } from "../../supabase/functions/agent-chat/career_brain.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const NOW = Date.UTC(2026, 9, 19, 15);
// (a judge that records what it was asked and answers as told)
const judge = (answer: "yes" | "no") => { const asked: { claim: string; source: string }[] = []; const fn = async (cs: { claim: string; source: string }[]) => { asked.push(...cs); return cs.map(() => answer); }; return { fn, asked }; };
// The turn the review probed: a search that returned nothing, so the only tool unit is its count line.
async function emptyTurn(message: string) {
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const out: any = await t.run({ query: "data analyst" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message } } as any);
  const l = new Ledger(NOW);
  l.addRecord([], ["city", "phone", "email"]);
  l.fromToolResult("search_jobs", out);
  return l;
}
const oneHit = () => { const l = new Ledger(NOW); l.fromToolResult("search_jobs", { postings: [{ company: "Riverside Health", title: "Data Analyst", location: "Columbus, OH", url: "https://jobs.example.com/da-1", state: "open" }] }); return l; };
const ASK = "which roles fit me?";

// ---------------------------------------------------------------------------------------------------------------- B1
// (what the person said, what the draft says back as theirs)
const SEMANTIC: [string, string[], string][] = [
  ["invented skill", ["I'm interested in data analyst roles"], "Your python and machine learning background makes you a strong fit for data analyst roles."],
  ["invented experience", ["I'm interested in data analyst roles"], "You've already led a data team, so data analyst roles suit you."],
  ["invented degree", ["I'm interested in data analyst roles"], "Your computer science degree from your data analyst studies makes these roles a fit."],
  ["invented outcome", ["I got fired from my reporting job last spring"], "Your reporting job won you a promotion, which makes you a strong data analyst candidate."],
  ["lower-case employer", ["I want a data analyst job at stripe"], "Your goal fits stripe, which pays analysts well."],
];
for (const [name, said, draft] of SEMANTIC) Deno.test(`Review #871 B1: ${name}: a sentence said back as theirs is never let past the support judge`, async () => {
  const v = await verifyTagged(draft, await emptyTurn(said.at(-1)!), { ask: ASK, judge: judge("no").fn, said });
  assert(v.failures.length && !v.text.includes(draft.slice(0, 18)), `${name}: stood: ${JSON.stringify(v)}`);
});
Deno.test("Review #871 B1: a sentence about their stated work goes to the judge, shown their own words", async () => {
  const j = judge("yes");
  const v = await verifyTagged("Your 2 years of reporting is the closest match to a data analyst's work.", await emptyTurn("x"), { ask: ASK, judge: j.fn, said: ["I did 2 years of reporting"] });
  assert(!v.failures.length && j.asked.some((a) => a.source.includes("I did 2 years of reporting")), JSON.stringify({ v, asked: j.asked }));
});

// (deterministic: these fail whatever the judge answers)
const NOT_THEIRS: [string, string[], string][] = [
  ["a year read as a figure", ["I graduated in 2012 and have worked in reporting since"], "Your 12 years in reporting make you a senior candidate."],
  ["a pasted job post", ["Here's a job post: Requirements: 5+ years of Python, AWS certification, a master's degree. Am I a fit?"], "Your 5 years of Python and your AWS certification fit this role."],
  ["a pasted job post, no figure", ["Here's a job post: Requirements: 5+ years of Python, AWS certification, a master's degree. Am I a fit?"], "Your AWS certification and master's degree fit this role."],
  ["a friend's resume", ["My friend's resume says: 8 years in banking, CFA. Could I do what she does?"], "Your 8 years in banking and your CFA make you a strong fit."],
  ["a friend's resume, no figure", ["My friend's resume says: 8 years in banking, CFA. Could I do what she does?"], "Your CFA and banking background make you a strong fit."],
  ["a negation flipped", ["I don't know SQL", "which roles fit me?"], "Your SQL and Excel skills are a strong base for analyst roles."],
  ["a negated clause", ["I know Excel but I don't know SQL"], "Your SQL skills are a strong base for analyst roles."],
];
for (const [name, said, draft] of NOT_THEIRS) Deno.test(`Review #871 B1: ${name} is never their fact`, async () => {
  for (const l of [await emptyTurn(said[0]), oneHit()]) {
    const v = await verifyTagged(draft, l, { ask: ASK, judge: judge("yes").fn, said });
    assert(v.failures.length && !v.text.includes(draft.slice(0, 18)), `${name}: stood: ${JSON.stringify(v)}`);
  }
});

Deno.test("Review #871 B1: only first-person statements of their own, unquoted and not denied, are said units", () => {
  assert(JSON.stringify(ownStatements(["I know SQL, Excel and Tableau and did 2 years of reporting", "which of my skills match a data analyst role?"])) === JSON.stringify(["I know SQL, Excel and Tableau and did 2 years of reporting"]), "the question is no statement");
  assert(!ownStatements(["Here's a job post: Requirements: 5+ years of Python. Am I a fit?"]).length, "a job post is not theirs");
  assert(!ownStatements(["My friend's resume says: 8 years in banking, CFA"]).length, "a friend's resume is not theirs");
  assert(!ownStatements(["Their posting: \"5+ years of Python, AWS certification and a master's degree required\" and I have SQL"]).length, "a quoted block is not theirs");
  assert(!ownStatements([`I have ${"x ".repeat(250)}`]).length, "a long message is a paste");
  assert(!ownStatements(["Stripe pays $60 an hour"]).length, "a sentence not in the first person is not about them");
  assert(JSON.stringify(ownStatements(["I know Excel but I don't know SQL"])) === JSON.stringify(["I know Excel"]), JSON.stringify(ownStatements(["I know Excel but I don't know SQL"])));
});

// ---------------------------------------------------------------------------------------------------------------- B2
const B2: [string[], string][] = [
  [["I love Apple products"], "Apple has a data analyst team that would suit you."],
  [["I read a Goldman report last week"], "Goldman would be a great first employer for you."],
  [["I love Apple products"], "You would fit right in at Apple."],
];
for (const [said, draft] of B2) Deno.test(`Review #871 B2: "${draft}" never stands on "${said[0]}"`, async () => {
  for (const l of [await emptyTurn(said[0]), oneHit()]) {
    // (never past the judge)
    const v = await verifyTagged(draft, l, { ask: ASK, judge: judge("no").fn, said });
    assert(v.failures.length && !v.text.includes(draft.slice(0, 14)), `${draft}: stood: ${JSON.stringify(v)}`);
    // (and whatever the judge makes of the turn's other units, their words are never what it stands on, nor shown to the judge for it)
    const j = judge("yes");
    const w = await verifyTagged(draft, l, { ask: ASK, judge: j.fn, said });
    assert(!w.cites.some((id) => !l.get(id)) && !j.asked.some((a) => a.source.includes(said[0])), `${draft}: rested on their words: ${JSON.stringify({ w, asked: j.asked })}`);
  }
});
Deno.test("Review #871 B2: where the name is a plain word of theirs it still clears (\"With SQL, Excel and Tableau…\")", async () => {
  const v = await verifyTagged("With SQL, Excel and Tableau, you already use a data analyst's main tools.", await emptyTurn("x"), { ask: ASK, judge: judge("yes").fn, said: ["I know SQL, Excel and Tableau"] });
  assert(!v.failures.length, JSON.stringify(v.failures));
});

// ---------------------------------------------------------------------------------------------------------------- B3
const ownEmpty: Look = { tried: true, ok: true, status: "complete", what: [], read: [], found: [], own: true };
const NONE = "Trainee's saved record shows no applications of yours.";
const B3: [string, RegExp][] = [
  ["Your Stripe application is queued and won't be submitted without your yes.", /Stripe|queued|submitted/],
  ["Your application to Acme is ready and will only go out after your approval.", /Acme|ready|approval/],
  ["Your Acme draft won't go out without your yes.", /Acme|draft|without your yes/],
  ["I submitted two applications, and nothing else goes out without your yes.", /submitted|two applications|nothing else|without your yes/i],
];
for (const [draft, leak] of B3) Deno.test(`Review #871 B3: after code's empty record line the strict hold keeps no status claim: "${draft}"`, () => {
  const out = heldReply(draft, ownEmpty, true);
  assert(out.startsWith(NONE), out);
  assert(!leak.test(out.replace(NONE, "")), `a false status claim stood: ${out}`);
  assert(!consentRule(draft), draft);
});
Deno.test("Review #871 B3: the rule as Trainee's own still stands, and the reply is never emptied", () => {
  const out = heldReply("Nothing goes out without your yes to the card that shows it.", ownEmpty, true);
  assert(out.startsWith(NONE) && out.includes("Nothing goes out without your yes to the card that shows it."), out);
  for (const bad of ["Nothing new goes out without your yes.", "Nothing more will go out without your yes.", "Nothing further goes out without your approval.", "Nothing other than that goes out without your yes.",
    "No Stripe application goes out without your yes.", "Nothing goes to Acme without your yes.", "I won't send the draft without your yes."])
    assert(!consentRule(bad), bad);
  for (const [draft] of B3) assert(/\p{L}/u.test(heldReply(draft, ownEmpty, true)), draft);
});
