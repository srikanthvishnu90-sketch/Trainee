// WO-055 (architect): sealed sample D, scored once on trunk 0175e523 (then spent), found 24 wrong fills of 636 and 13 not
// settled. Two causes: a job abroad (work rights and pay there are that country's, not the person's US facts) and a
// question that names a fact's topic but asks more than the fact says (a second degree, a visa type, whether moving is
// needed, a vendor's history). Each is asked; the person's own facts keep answering what they do say. Synthetic persona
// (Chicago, IL; US authorized, no sponsorship; expects 95000, earns 85000); real employers' questions and locations.
import { beyondFact, factStaysHere, otherCountry, planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { answerKey, mapQuestion } from "../../supabase/functions/_shared/question_map.ts";
import { questionsToStore } from "../../workers/career-browser/ask-once.ts";
import { PERSONA } from "../../evals/apply/fill-coverage.ts";
import AUDIT from "../fixtures/apply/wo-055-sample-d-audit.json" with { type: "json" };

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
// One required question on one posting at `location`: the label of the option (or the text) the planner filled, or "ASKED".
function fill(label: string, location: string | undefined, options: string[] = ["Yes", "No"], o: { company?: string; type?: string } = {}) {
  const fields = [{ name: "q", label, required: true, type: o.type ?? (options.length ? "multi_value_single_select" : "input_text"), options: options.map((x) => ({ label: x, value: x })) }];
  const p = planBatch({ userId: "TEST", postings: [{ job_id: "TEST-1", company: o.company ?? "Example Co", title: "", location, fields }], answers: PERSONA, saved: {}, log: [], now: Date.UTC(2026, 9, 20) });
  return p.ready.length ? p.ready[0].fields[0].value : "ASKED";
}

Deno.test("WO-055/1 every fill the review of sample D judged wrong or unsettled no longer gets that answer", () => {
  const still: string[] = [];
  for (const c of (AUDIT as any).cases) {
    const got = fill(c.label, c.location === "(not shown)" ? undefined : c.location, c.options, { company: c.company, type: c.type });
    if (got === c.was) still.push(`#${c.audit_id} ${c.verdict} ${c.company} @ ${c.location}: "${c.label.slice(0, 90)}" -> ${got}`);
  }
  eq(still, [], `${still.length} of ${(AUDIT as any).cases.length} still answered as before`);
  eq((AUDIT as any).cases.length, 36);
});

Deno.test("WO-055/2 a job abroad: work rights and pay there are asked; a question naming the US is still the person's", () => {
  const sponsor = "Will you now, or in the future, require sponsorship?";
  eq(fill(sponsor, "London"), "ASKED", "Neo4j's London posting");
  eq(fill("Would you now or in the future require a visa for employment for where this job is based?", "London", []), "ASKED", "Abound");
  eq(fill(sponsor, "New York, New York, United States"), "No");
  eq(fill(sponsor, undefined), "No", "no location: the person's sponsorship fact, as before WO-055");
  eq(fill("Are you legally authorized to work in the United States?", "London, United Kingdom"), "Yes", "a question naming the US is the person's anywhere");
  // A posting in the US and abroad does not say which country a bare question is about: asked (Binance).
  eq(fill("Will you now or will you in the future require employment visa sponsorship?", "Shanghai; U.S.; Canada; Toronto", []), "ASKED");
  // Work rights where the person lives are theirs wherever the job is (a home in Chicago): Okta Madrid, Oyster, GitLab,
  // Snowflake London. A foreign country named in the question is still that country's.
  eq(fill("Are you legally authorized to work in the country you reside?", "Madrid, Spain"), "Yes");
  eq(fill("Do you currently need, or will you need in the future, employer sponsorship to work legally in your country of residence?", "Mexico; Costa Rica; Chile; Brazil", [], { type: "checkbox" }), "No");
  eq(fill("Will you now or in the future require sponsorship for a visa to remain in your current location?", "Remote, Canada; Remote, United States"), "No");
  eq(fill("Will you require company sponsorship now or in the future to maintain or extend your current work authorization status?", "GB-London", [], { type: "checkbox" }), "No");
  eq(fill("Are you authorized to work in your country of residence (Canada)?", "Toronto, Canada"), "ASKED");
  // Pay: a bare number in a box at a job abroad reads as that country's currency.
  eq(fill("What is your salary expectation?", "London", []), "ASKED", "Faculty AI");
  // architect amendment D-053 (owner, 2026-11-10): a salary expectation is asked per application, never filled from the persona's fact.
  // Before: "95000". After: "ASKED".
  eq(fill("What is your salary expectation?", "Chicago, IL", []), "ASKED");
  eq(fill("What is your current compensation? (e.g. JPY XXX,XXX x 12months + performance bonus)", undefined, []), "ASKED", "Blue Bottle: another currency");
  eq(fill("What is your expected salary bracket?", undefined, []), "ASKED", "Carwow: a bracket is not a number");
  eq(fill("Variable Salary", undefined, []), "ASKED", "variable pay is not the expected salary");
  // The currency "of the country where this position is based" (Sword Health): the person's USD for a US posting only.
  const currency = "What currency should we use for your desired salary? Please select the currency of the country where this position is based.";
  eq(fill(currency, "Remote - US", ["USD ($)", "EUR (€)", "GBP (£)"]), "USD ($)");
  eq(fill(currency, "Lisbon, Portugal", ["USD ($)", "EUR (€)", "GBP (£)"]), "ASKED");
  eq(fill("Your expected salary (inclusive of bonus/commission).", undefined, []), "ASKED", "Liberis: more than the base expectation");
});

Deno.test("WO-055/3 the pay rules stop at the question asked: examples and notes around it are not the ask", () => {
  // FiscalNote (Washington, DC): the example list after the question names commission; the question is the expectation.
  // architect amendment D-053 (owner, 2026-11-10): a salary expectation is asked per application, never filled from the persona's fact.
  // Before: "95000 USD" and "95000". After: both "ASKED" (the otherCountry reading below is unchanged).
  eq(fill("Please share your compensation expectations (including currency) and please be as specific as possible. [Example: base salary, annual commission for relevant positions, etc]:",
    "Washington, DC", [], { type: "textarea" }), "ASKED");
  eq(fill("What is your expected yearly salary? In USD", undefined, [], { type: "textarea" }), "ASKED", "Wing Assistant");
  eq(otherCountry("salary_expectation", "What are your base salary expectations for your next role? Please note that we utilize geographic pay structures based on local market rates, and our final offers factor in total compensation including equity, bonus structures", "Salt Lake City, UT"), false, "Filevine: a note about pay, not the ask");
});

Deno.test("WO-055/4 a question beyond what the fact says is asked; the fact still answers its own question", () => {
  // The person's visa type is not their authorization; a sponsorship question listing OPT among its examples is still answered.
  eq(fill("Does your work authorization now, or will it in the future, involve CPT (Curricular Practical Training) or OPT (Optional Practical Training)?", "Westfield, IN"), "ASKED", "SEP");
  eq(fill("Will you now or at any point in the future require sponsorship for work authorization in the United States? (i.e. H-1B, TN, OPT)", undefined), "No", "Patreon");
  eq(fill("Will you require visa sponsorship now or at all in the future to work in the United States? (includes OPT, CPT)", undefined), "No", "Analytic Partners");
  // Thrive: a statement, then the question; the question asked is the sponsorship one.
  eq(fill("Applicants must be authorized to work for any employer in the U.S. without current or future sponsorship for an immigration-related work benefit. Thrive Causemetics does not hire H-1B, F-1 CPT, OPT, or STEM OPT candidates for this role. Will you now or in the future require sponsorship for employment?", "Los Angeles, CA"), "No");
  // School and degrees: the one attended now, a second one.
  eq(fill("What is the name of the school you are currently attending?", undefined, []), "ASKED", "EQ Bank");
  eq(fill("What is the field of study for your second highest academic qualification?", undefined, []), "ASKED");
  // Moving: whether it is needed, and a list of where they live and would move, are not their willingness.
  eq(fill("Would you need to relocate to work regularly from one of these Offices?", "Bristol, UK; Cambridge, UK", ["Yes", "No", "Unsure"]), "ASKED", "Graphcore");
  eq(beyondFact("relocation", { label: "Please indicate your current location and relocation preferences. (Select all that apply.)", type: "multi_value_multi_select" }), true);
  eq(beyondFact("relocation", { label: "Are you willing to relocate?", type: "multi_value_single_select" }), false);
  // Work history: an employer the person never worked for, not other firms of a kind or through a vendor.
  eq(fill("Have you ever worked for Microsoft as an employee or vendor?", undefined, ["Yes", "No"], { company: "Blueprint Technologies" }), "ASKED");
  eq(fill("Have you ever worked for a health insurance company?", undefined), "ASKED", "Quest Analytics");
  eq(fill("Have you ever worked for Robinhood as an employee, intern or contractor?", undefined, ["Yes", "No"], { company: "Robinhood" }), "No", "the person's own list says");
  eq(fill("Have you previously applied to Acme?", undefined, ["Yes", "No"], { company: "Acme" }), "No");
  eq(beyondFact("applied_before", { label: "Have you applied to any of our affiliated companies?", type: "radio" }), true);
  eq(beyondFact("us_person", { label: "Are you able to obtain a security clearance?", type: "radio" }), true);
});

Deno.test("WO-055/5 a y/n box takes a yes or a no; the map no longer reads three topics as another", () => {
  eq(fill("Applicants selected for this position may be subject to a U.S. Government security investigation and will be required to meet eligibility requirements for access to classified information; therefore, U.S. Citizenship is required. Are you able to meet this requirement? y/n", "Remote", []), "ASKED", "PingWind: not \"United States\"");
  const fact = (label: string) => mapQuestion({ label, type: "radio", options: [] }).fact;
  // A non-solicitation or restrictive covenant is not the non-compete fact (Hudl, H1, the American Institutes).
  eq(fact("Do you have any non-compete or non-solicitation agreements that would restrict you?") === "non_compete", false);
  eq(fact("Do you have a non-compete agreement with your current employer?"), "non_compete", "not the employer's name");
  // A referral by a government official is a disclosure question, not "who referred you" (Robinhood).
  eq(fact("Were you referred to Robinhood by a government official or a close relative of one?") === "referral", false);
  eq(fact("Were you referred by a current employee?"), "referral");
  // "Expected salary (with currency)" is the expectation, not the currency.
  eq(fact("What are your salary expectations? Please include currency") === "salary_currency", false);
  eq(fact("Preferred currency"), "salary_currency");
});

Deno.test("WO-055/6 an answer the person's fact does not give here is kept as this posting's alone, never as their fact", () => {
  const yn = ["Yes", "No"];
  const sponsor = "Will you now, or in the future, require sponsorship?";
  const ask = (posting: string, location: string | undefined, label: string, facts: Record<string, unknown> = {}) =>
    questionsToStore({ posting, company: "Example Co", location, questions: [{ label, type: "multi_value_single_select", options: yn }] }, { facts, answered: new Set() }).questions[0]?.key as string;
  // Stored: a London posting's sponsorship answer under that posting; a US posting's as the person's fact (as before).
  eq(ask("gh:neo4j:1", "London", sponsor).startsWith("job:"), true, "Neo4j London: the person's UK need is not their sponsorship fact");
  eq(ask("gh:acme:2", "Austin, TX", sponsor), "fact:sponsorship");
  eq(ask("gh:acme:2", undefined, sponsor), "fact:sponsorship", "no location: as before WO-055");
  eq(ask("lv:quest:3", "Overland Park, KS", "Have you ever worked for a health insurance company?").startsWith("job:"), true,
    "a kind of company is not \"worked here before\" for every employer");
  eq(ask("gh:lib:4", "Nottingham, United Kingdom", "What is your desired salary?").startsWith("job:"), true);
  // Read back: the person's "Yes" for London answers London only; a US "No" saved as their fact never answers London.
  const yesLondon = { [answerKey({ label: sponsor, type: "multi_value_single_select", options: yn.map((label) => ({ label })) } as any, "gh:neo4j:1", { here: true })]: { value: "Yes", factId: "TEXT" } };
  const noFact = { "fact:sponsorship": { value: "No", factId: "TEXT" } };
  const plan = (job: string, location: string, saved: Record<string, { value: string; factId: string }>) => {
    const { sponsorship: _, ...answers } = PERSONA as Record<string, { value: string; factId: string }>;
    return planBatch({ userId: "TEST", answers, saved, log: [], now: 0, postings: [{ job_id: job, company: "Example Co", title: "", location,
      fields: [{ name: "q", label: sponsor, required: true, type: "multi_value_single_select", options: yn.map((label) => ({ label, value: label })) }] }] }).ready[0]?.fields[0]?.value ?? "ASKED";
  };
  eq(plan("gh:neo4j:1", "London", yesLondon), "Yes", "the person's own answer for that posting");
  eq(plan("gh:acme:2", "Austin, TX", yesLondon), "ASKED", "the London yes is not the person's US answer");
  eq(plan("gh:neo4j:1", "London", noFact), "ASKED", "a US no saved as the fact never answers a job abroad");
  eq(plan("gh:acme:2", "Austin, TX", noFact), "No");
  eq(factStaysHere({ label: "Are you legally authorized to work in the United States?", type: "radio" }, "London"), false, "a question naming the US stays the person's");
});
