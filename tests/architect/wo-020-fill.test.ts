// WO-020 part 2 (architect): what the planner fills by meaning is right, on the employer's own options from real captured
// forms, and what it cannot fill truthfully is asked. A TEST persona (evals/apply/fill-coverage.ts); synthetic data.
import { planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { chooseOption, yesNoOf } from "../../supabase/functions/_shared/answer_options.ts";
import { PERSONA, fillCoverage } from "../../evals/apply/fill-coverage.ts";
import { prepare } from "../../workers/career-browser/approve-first.ts";
import A from "../../evals/apply/questions-ci.json" with { type: "json" };
import B from "../../evals/apply/questions-ci-b.json" with { type: "json" };
import REPORT from "../../docs/apply/fill-coverage.md" with { type: "text" };

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
// One required question on one posting: the label the planner filled it with, or "ASKED".
function fill(label: string, options: string[], o: { company?: string; type?: string; answers?: Record<string, { value: string; factId: string }> } = {}) {
  const fields = [{ name: "q", label, required: true, type: o.type ?? (options.length ? "multi_value_single_select" : "input_text"), options: options.map((x) => ({ label: x, value: x })) }];
  const p = planBatch({ userId: "TEST", postings: [{ job_id: "TEST-1", company: o.company ?? "Example Co", title: "", fields }], answers: o.answers ?? PERSONA, saved: {}, log: [], now: 0 });
  return p.ready.length ? p.ready[0].fields[0].value : "ASKED";
}
const YN = ["Yes", "No"];

Deno.test("WO-020/F1 stated facts land on the employer's own wording of the answer", () => {
  eq(fill("Will you now or in the future require employment sponsorship?", ["Yes, I will require sponsorship", "No, I will not require sponsorship"]), "No, I will not require sponsorship");
  eq(fill("EXPORT COMPLIANCE", ["I am currently a “U.S. Person”", "I am not a “U.S. Person\""]), "I am currently a “U.S. Person”");
  // WO-052: most employees sign a confidentiality agreement; a "no" to non-competes does not answer one: asked.
  eq(fill("Are you subject to any non-compete, non-solicitation, or confidentiality agreements with your current or former employers?", ["I DO have an employment agreement with a previous employer", "I DO NOT have an employment agreement with a previous employer"]), "ASKED");
  eq(fill("Are you legally authorized to work in the United States?", ["I am authorized to work in the United States for any employer", "I am authorized to work in the United States for my present employer only", "I require sponsorship to work in the United States", "I am not authorized to work in the United States"]), "I am authorized to work in the United States for any employer");
  eq(fill("How did you hear about this job?", ["Campus - SpaceX event (indicate below)", "Careers site", "Glassdoor", "Indeed", "LinkedIn", "Other (indicate below)"]), "Careers site");
  eq(fill("Gender", ["Male", "Female", "Decline to self-identify"]), "Decline to self-identify");
});

Deno.test("WO-020/F2 yes/no answers that follow from a stated fact, and only those", () => {
  eq(fill("Are you a U.S. citizen?", YN), "Yes");
  eq(fill("Are you a Singapore citizen?", YN), "ASKED", "a U.S. citizen may also hold another citizenship: never a guessed no");
  eq(fill("Is your Notice period Less than 30 days?", YN), "Yes", "2 weeks is under 30 days");
  eq(fill("If offered a position at CFS, will you be able to start within 3 weeks?", ["yes", "no"]), "yes");
  eq(fill("Do you have at least a High School Diploma or equivalent (i.e. GED)?", YN), "Yes", "a bachelor's degree");
});

Deno.test("WO-020/F3 'worked here before' comes from the person's confirmed employer list; an unclear yes is asked", () => {
  const spacex = ["I have never worked for SpaceXSI, SpaceX, SpaceXAI, xAI, X, or Twitter", "I am a current or former SpaceXSI, SpaceX, SpaceXAI, xAI, X, or Twitter Intern", "I am a former SpaceXSI, SpaceX, SpaceXAI, xAI, X, or Twitter employee"];
  eq(fill("Have you worked with us before?", spacex, { company: "SpaceX" }), spacex[0]);
  const formerly = { ...PERSONA, former_employers: { value: "SpaceX; Sample Retail", factId: "TEST-persona" } };
  eq(fill("Have you worked with us before?", spacex, { company: "SpaceX", answers: formerly }), "ASKED", "intern or employee is theirs to say");
  eq(fill("Have you ever been employed by Stripe or a Stripe affiliate?", YN, { company: "Stripe" }), "No");
  const noList = { ...PERSONA };
  delete noList.former_employers;
  eq(fill("Have you ever been employed by Stripe or a Stripe affiliate?", YN, { company: "Stripe", answers: noList }), "ASKED", "no confirmed list, no answer");
});

Deno.test("WO-020/F4 never guessed: no option fits, an edge between two ranges, a graduate GPA, a commitment, a choice that is theirs", () => {
  eq(fill("What is your current notice period?", ["Immediately Available", "1 Month", "2 Months", "3 Months", "3+ Months"]), "ASKED", "2 weeks is not one of them");
  eq(fill("How many years of relevant professional experience do you have?", ["No experience", "Less than 1 year", "1-3 years", "3-5 years", "5-7 years"]), "ASKED", "3 years sits on two ranges");
  eq(fill("How many years of relevant professional experience do you have?", ["No experience", "Less than 1 year", "1-3 years", "3-5 years", "5-7 years"], { answers: { ...PERSONA, years_experience: { value: "6 years", factId: "TEST-persona" } } }), "5-7 years");
  eq(fill("GPA (Graduate)", ["Other/Not Applicable", "4.0 out of 4.0", "3.6 out of 4.0"]), "ASKED");
  eq(fill("Employees must commit to partner with Life.Church by attending Life.Church consistently, being involved in a LifeGroup, serving in a Life.Church ministry, and tithing. We ask you to consider if these commitments work for you.", ["I agree", "I am not in full agreement with the above"]), "ASKED");
  eq(fill("May we contact your current employer?", YN), "ASKED");
  eq(fill("Why do you want to work at Example Co?", [], { type: "textarea" }), "ASKED", "an essay is drafted in a later step, never filled from a fact");
  eq(chooseOption("years_experience", "4 years", [{ label: "1+ years", value: "1" }, { label: "2+ years", value: "2" }, { label: "4+ years", value: "4" }, { label: "5+ years", value: "5" }]), "4", "of N+ ranges, the highest it reaches");
  eq([yesNoOf("I am not a U.S. Person"), yesNoOf("I do not have an agreement"), yesNoOf("I have never worked here"), yesNoOf("Yes, I am")], ["no", "no", "no", "yes"]);
});

Deno.test("WO-020/F5 on the approval card, a consent, a legal statement and a term of the job say they are the person's", async () => {
  const r = await prepare({
    url: "https://jobs.lever.co/test/1", factsPath: "f", resumePath: "r", account: { epoch: 1, version: 1 }, now: 0,
    runEngine: async () => ({
      result: { state: "not_submitted", reason: "dry_run" },
      evidence: {
        approval_hash: "a".repeat(64), readback: {},
        fields: [
          { name: "p", label: "I acknowledge the Candidate Privacy Notice", value: "Acknowledge", factId: "TEST-1" },
          { name: "c", label: "Have you ever been convicted of a felony?", value: "No", factId: "TEST-1" },
          { name: "o", label: "Are you able to work from our Denver office 5 days a week?", value: "Yes", factId: "TEST-1" },
          { name: "e", label: "Email", value: "t@example.test", factId: "TEST-1" },
        ],
        payload: { user_id: "TEST", posting: "lever:test:1", company: "TEST Employer", destination: "https://jobs.lever.co/test/1/apply", resume: { filename: "r.pdf", sha256: "b".repeat(64) } },
      },
    }),
  });
  assert(r.ready);
  assert(r.card.includes("You agree: I acknowledge the Candidate Privacy Notice: Acknowledge"), r.card.join("\n"));
  assert(r.card.includes("Your statement: Have you ever been convicted of a felony?: No"));
  assert(r.card.includes("About this job: Are you able to work from our Denver office 5 days a week?: Yes"));
  assert(r.card.includes("Email: t@example.test"), "a plain fact carries no mark");
  eq(Object.keys(r.payload.fields[0]).sort(), ["factId", "label", "name", "value"], "the mark is the card's, never in what is approved");
});

Deno.test("WO-020/F6 fill coverage meets the bar and the committed report is today's", () => {
  const a = fillCoverage(A as any), b = fillCoverage(B as any);
  // WO-052: the floors are now fills an independent review judged right (1,458 on A and B: none judged wrong; 3 years-of-
  // experience fills judged unsure are kept, since fact_schema defines years_experience as relevant years),
  // not what was filled: the 84.6% / 84.1% before counted 73 wrong fills and 35 the persona did not settle.
  // WO-053: each posting's own location (evals/apply/posting-locations.json) settles what depends on where the job is.
  // 26 fills the review judged without it were wrong there (13 work-rights answers for jobs abroad, 13 yeses to an office
  // in another city for a person who will not relocate): A 78.9% -> 76.7%, B 78.5% -> 78.2%.
  // WO-055 (sealed sample D, scored once): at a job abroad, work rights and pay are that country's, and a question beyond
  // what a fact says is asked. 22 required fills on A and B were of these: 20 at postings in London, Dublin, Madrid,
  // Munich, Stockholm, Singapore, Sydney, Shanghai, Dubai, Hong Kong, India, Toronto and Latin America, and 2 beyond the
  // fact (a firm in Aprio's alliance; a vendor at Woven by Toyota): A 76.7% -> 75.3% (ready 24 -> 21), B 78.2% -> 77.2%.
  // WO-056 (sealed sample E, scored once): 4 more on A are asked: a clearance list that tells "Expired" from "Never held"
  // (SpaceX, CesiumAstro), a conflict of interest that is not a non-compete (Anduril), "a WPP agency" (any company in
  // WPP's group, not settled by the person's own list): A 75.3% -> 74.9%; B unchanged.
  // WO-058 (sealed sample G, scored once): work for this employer through an agency, a vendor or a third party is not on
  // the person's employer list (SpaceX's and xAI's lists offer "contracted by a third-party employer"; "a WPP agency" on
  // B), and "Additional information (for source)" is not how they heard: A 74.9% -> 74.7%, B 77.2% -> 77.1% (ready 38 -> 37).
  // architect amendment D-053 (owner, 2026-11-10): a salary expectation is asked per application, never filled from a fact
  // on file (the owner's choice, not a regression). Every lost fill is a required salary-expectation question: A 756 -> 748
  // of 1,011 (74.8% -> 74.0%, ready 22 -> 21), B 653 -> 635 of 847 (77.1% -> 75.0%, ready 37 -> 32).
  // Before: a.rate >= 0.746 && b.rate >= 0.770, a.ready >= 21 && b.ready >= 37. After: the salary rows asked.
  assert(a.rate >= 0.739 && b.rate >= 0.749, `${a.rate} ${b.rate}`);
  assert(a.ready >= 21 && b.ready >= 32, `${a.ready} ${b.ready}`);
  assert(REPORT.includes(`| ${a.postings} | ${a.required} | ${a.filled} (`) && REPORT.includes(`| ${b.postings} | ${b.required} | ${b.filled} (`), "docs/apply/fill-coverage.md is stale: regenerate it");
});
