// WO-048: Workday in the extension, the pure parts. The shared planner (planBatch) answers Workday's fields with the
// same answer keys and zero-wrong shape rules; repeating sections (work experience, education, languages) are filled only
// from confirmed facts with the dates as stated; the card says what Save and Continue sends and that nothing is submitted;
// a sign-in page is never the extension's. The extension in a real Chromium on the TEST Workday-shaped pages is
// tests/career-extension-workday.test.cjs; the measurement is evals/apply/workday-fill.cjs.
// Contract: docs/architect/work-orders/WO-048-workday.md.
import {
  cardLines, planForm, postingKey, reviewPayload, type SnapField, WORKDAY_NOTICE, WORKDAY_PAGE_SET, workdayDraftLine, workdayEmployer,
  workdaySignIn, workdaySubmitLine,
} from "../../extension/src/apply_core.ts";
import { type FormField, planBatch, rowsToAdd } from "../../supabase/functions/_shared/career_apply.ts";
import { mapQuestion } from "../../supabase/functions/_shared/question_map.ts";
import { chooseOption } from "../../supabase/functions/_shared/answer_options.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const fact = (value: string, id = "TEST-fact") => ({ value, factId: id });
const opts = (...ls: string[]) => ls.map((l) => ({ label: l, value: l }));
const YN = opts("Yes", "No");
const field = (name: string, label: string, o: Partial<FormField> = {}): FormField =>
  ({ name, label, type: o.type ?? "text", required: o.required ?? false, options: o.options ?? [], ...o } as FormField);
const row = (kind: string, n: number, part: string, label: string, o: Partial<FormField> & { anchor?: string; format?: string } = {}) =>
  field(`${kind}-${n}--${part}`, `${kind} ${n}: ${label}`, { ...o, section: { kind, row: n, part, anchor: o.anchor ?? "", format: o.format } } as any);

// The TEST persona of the Workday fixtures (tests/fixtures/workday/sources.md, Persona), as confirmed facts.
const WORK = JSON.stringify([
  { employer: "Example Analytics", title: "Data Analyst", start: "06/2022", end: "present" },
  { employer: "Sample Retail", title: "Sales Associate", start: "01/2020", end: "05/2022" },
]);
const PERSONA = {
  first_name: fact("Test"), last_name: fact("Person"), email: fact("test.person@example.test"), phone: fact("+1 555 010 0000"),
  phone_type: fact("Mobile"), street_address: fact("1 Example St"), full_address: fact("1 Example St, Chicago, IL 60601"),
  city: fact("Chicago"), state: fact("IL"), postal_code: fact("60601"), country: fact("United States"),
  work_history: fact(WORK, "TEST-work"), former_employers: fact("Example Analytics; Sample Retail"),
  school: fact("Example State University"), education_level: fact("bachelor"), major: fact("Statistics"), gpa: fact("3.6"),
  graduation_date: fact("05/2022", "TEST-grad"), languages: fact("English (native)"), salary_expectation: fact("95000"),
  work_authorization: fact("Yes"), sponsorship: fact("No"), over_18: fact("Yes"), relocation: fact("No"), notice_period: fact("2 weeks"),
  how_heard: fact("Company website"),
};
const plan = (fields: FormField[], answers: Record<string, { value: string; factId: string }> = PERSONA, company = "northwind") =>
  planBatch({ userId: "u", postings: [{ job_id: "workday:northwind:R1", company, title: "", fields: fields.map((f) => ({ ...f, required: false })) }], answers, saved: {}, log: [], now: 0 })
    .ready[0].fields;
const valueOf = (fields: { name: string; value: string }[], name: string) => fields.find((f) => f.name === name)?.value ?? null;

Deno.test("WO-048/1 work experience rows: from confirmed facts only, dates exactly as stated, the current job's end left", () => {
  const fields = [1, 2].flatMap((n) => [
    row("work", n, "title", "Job Title"), row("work", n, "employer", "Company"), row("work", n, "location", "Location"),
    row("work", n, "current", "I currently work here", { type: "checkbox" }), row("work", n, "start", "From", { type: "date", format: "MM/YYYY" }),
    row("work", n, "end", "To", { type: "date", format: "MM/YYYY" }), row("work", n, "description", "Role Description", { type: "textarea" }),
  ]);
  const got = plan(fields);
  eq(valueOf(got, "work-1--title"), "Data Analyst");
  eq(valueOf(got, "work-1--employer"), "Example Analytics");
  eq(valueOf(got, "work-1--start"), "06/2022");
  eq(valueOf(got, "work-1--current"), "Yes");
  eq(valueOf(got, "work-1--end"), null, "the current job has no end date: left");
  eq(valueOf(got, "work-2--current"), "No");
  eq(valueOf(got, "work-2--start"), "01/2020");
  eq(valueOf(got, "work-2--end"), "05/2022");
  for (const n of [1, 2]) {
    eq(valueOf(got, `work-${n}--location`), null, "a job's location was never stated: left, never the person's home city");
    eq(valueOf(got, `work-${n}--description`), null, "a role description was never stated: left");
  }
  assert(got.filter((f) => f.name.startsWith("work-")).every((f) => f.factId === "TEST-work"), "every row value cites the work history fact");
  // A date given only as a year never fills a month: nothing invented.
  const yearOnly = { ...PERSONA, work_history: fact(JSON.stringify([{ employer: "Example Analytics", title: "Data Analyst", start: "2022", end: "present" }])) };
  eq(valueOf(plan(fields.slice(0, 7), yearOnly), "work-1--start"), null, "MM/YYYY from a year alone: left and asked");
  eq(valueOf(plan([row("work", 1, "start", "From", { type: "date", format: "YYYY" })], yearOnly), "work-1--start"), "2022", "a year field takes the stated year");
  // No work history fact: no row is filled, whatever the labels say.
  const none = { ...PERSONA } as Record<string, { value: string; factId: string }>;
  delete none.work_history;
  eq(plan(fields, none).filter((f) => f.name.startsWith("work-")), [], "no confirmed history, no rows");
  // A fact that is not a list of jobs fills nothing.
  eq(plan(fields, { ...PERSONA, work_history: fact("I worked at a few places") }).filter((f) => f.name.startsWith("work-")), []);
});

Deno.test("WO-048/2 rows are matched by employer: a row Workday filled for another job is never written into", () => {
  // Row 1 was filled by Workday from the resume (Sample Retail); row 2 is empty. Sample Retail's facts go to row 1 only
  // where it is empty; the empty row takes the job no row names.
  const fields = [
    row("work", 1, "employer", "Company", { anchor: "Sample Retail" }), row("work", 1, "title", "Job Title", { anchor: "Sample Retail" }),
    row("work", 2, "employer", "Company"), row("work", 2, "title", "Job Title"),
    row("work", 3, "employer", "Company", { anchor: "Unlisted Co" }), row("work", 3, "title", "Job Title", { anchor: "Unlisted Co" }),
  ];
  const got = plan(fields);
  eq(valueOf(got, "work-1--title"), "Sales Associate", "the row naming Sample Retail is Sample Retail's");
  eq(valueOf(got, "work-2--employer"), "Example Analytics");
  eq(valueOf(got, "work-2--title"), "Data Analyst");
  eq(valueOf(got, "work-3--title"), null, "a row for a job the person never stated is not Trainee's");
  // How many rows to add: one per stated job no row holds yet, less the empty rows already there.
  eq(rowsToAdd("work", [], PERSONA), 2);
  eq(rowsToAdd("work", [""], PERSONA), 1);
  eq(rowsToAdd("work", ["Sample Retail", ""], PERSONA), 0);
  eq(rowsToAdd("work", ["Unlisted Co"], PERSONA), 2);
  eq(rowsToAdd("education", [], PERSONA), 1);
  eq(rowsToAdd("language", [], PERSONA), 1);
  eq(rowsToAdd("website", [], PERSONA), 0, "only work, education and languages are added");
  eq(rowsToAdd("work", [], { first_name: fact("Test") }), 0, "no facts, no rows");
});

Deno.test("WO-048/3 education and languages: the person's stated school, degree, field, GPA, graduation year; native means fluent", () => {
  const fields = [
    row("education", 1, "school", "School or University"), row("education", 1, "degree", "Degree", { type: "select", options: opts("High School", "Associates", "Bachelors", "Masters", "Other") }),
    row("education", 1, "major", "Field of Study", { type: "select", options: opts("Statistics", "Statistics and Data Science", "Physics") }),
    row("education", 1, "gpa", "Overall Result (GPA)"), row("education", 1, "start", "From", { type: "date", format: "YYYY" }),
    row("education", 1, "end", "To (Actual or Expected)", { type: "date", format: "YYYY" }),
    row("language", 1, "language", "Language", { type: "select", options: opts("Dutch", "English", "French") }),
    row("language", 1, "fluent", "I am fluent in this language.", { type: "checkbox" }),
    row("language", 1, "proficiency", "Reading", { type: "select", options: opts("1 - Beginner", "3 - Intermediate", "5 - Fluent") }),
  ];
  const got = plan(fields);
  eq(valueOf(got, "education-1--school"), "Example State University");
  eq(valueOf(got, "education-1--degree"), "Bachelors");
  eq(valueOf(got, "education-1--major"), "Statistics", "the exact field, not the longer one that contains it");
  eq(valueOf(got, "education-1--gpa"), "3.6");
  eq(valueOf(got, "education-1--end"), "2022");
  eq(valueOf(got, "education-1--start"), null, "a start year never stated: left and asked");
  eq(valueOf(got, "language-1--language"), "English");
  eq(valueOf(got, "language-1--fluent"), "Yes");
  eq(valueOf(got, "language-1--proficiency"), "5 - Fluent");
  // A degree list that splits arts from science is the person's call; a level never stated fills no proficiency.
  const split = [row("education", 1, "degree", "Degree", { type: "select", options: opts("Bachelor of Arts", "Bachelor of Science", "Master of Science") })];
  eq(valueOf(plan(split), "education-1--degree"), null);
  const plain = plan(fields, { ...PERSONA, languages: fact("English") });
  eq(valueOf(plain, "language-1--language"), "English");
  eq(valueOf(plain, "language-1--fluent"), null);
  eq(valueOf(plain, "language-1--proficiency"), null);
  // A row the reader could not place (a website row, an unknown part) is never filled.
  eq(plan([row("website", 1, "url", "URL"), row("work", 1, "salary", "Salary")]), []);
});

Deno.test("WO-048/4 field shapes Workday asks: national number beside its country code, no extension, no second address line", () => {
  const phone = (dial?: string) => plan([field("ph", "Phone Number", dial === undefined ? {} : { dial } as any)]);
  eq(valueOf(phone("+1"), "ph"), "555 010 0000", "the country code is its own field: the national number only");
  eq(valueOf(phone("+44"), "ph"), null, "another country's code: the person's call");
  eq(valueOf(phone(""), "ph"), null, "no country code chosen yet: left");
  eq(valueOf(phone(), "ph"), "+1 555 010 0000", "a plain phone box (no code field) is unchanged");
  eq(valueOf(plan([field("ext", "Phone Extension")]), "ext"), null, "never the phone number in the extension");
  eq(valueOf(plan([field("a2", "Address Line 2")]), "a2"), null, "never the full address in the second line");
  eq(valueOf(plan([field("a1", "Address Line 1")]), "a1"), "1 Example St");
  eq(valueOf(plan([field("pt", "Phone Device Type", { type: "select", options: opts("Landline", "Mobile") })]), "pt"), "Mobile");
  eq(mapQuestion({ label: "Phone Device Type" }).fact, "phone_type");
  eq(valueOf(plan([field("pt", "Phone Device Type", { type: "select", options: opts("Home", "Work") })]), "pt"), null);
  // A salary range list takes the one range the stated amount is in; two ranges sharing the amount is asked.
  const sal = opts("$40,000 - $59,999", "$60,000 - $79,999", "$80,000 - $99,999", "$100,000 - $119,999", "$120,000+");
  // architect amendment D-053 (owner, 2026-11-10): the salary expectation is asked per application, never filled from the
  // persona's fact. Before: "$80,000 - $99,999". After: null (asked). The range choice itself is held by chooseOption below.
  eq(valueOf(plan([field("s", "What are your base salary expectations (USD)?", { type: "select", options: sal })]), "s"), null);
  eq(chooseOption("salary_expectation", "95000", opts("$80,000 - $95,000", "$95,000 - $110,000")), null, "an edge shared by two ranges: asked");
  eq(chooseOption("salary_expectation", "95000", opts("80k - 100k", "100k+")), "80k - 100k");
  eq(chooseOption("salary_expectation", "competitive", sal), null);
});

Deno.test("WO-048/5 voluntary disclosures: only the person's own answer, a decline only where the form offers one", () => {
  const vets = opts("I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE", "I AM NOT A VETERAN", "I DO NOT WISH TO SELF-IDENTIFY");
  const fields = [
    field("g", "Gender", { type: "select", options: opts("Male", "Female", "I do not wish to self-identify") }),
    field("h", "Are you Hispanic or Latino?", { type: "select", options: YN }),
    field("v", "Please select one of the options below:", { type: "select", options: vets }),
    field("r", "Race Category: (Please select all that apply.)", { type: "checkbox", options: opts("Asian", "White") }),
  ];
  eq(mapQuestion({ label: "Please select one of the options below:", options: vets }).fact, "eeo", "a veteran list under a generic label is a disclosure");
  eq(mapQuestion({ label: "Please select one of the options below:", options: YN }).fact === "eeo", false);
  eq(plan(fields), [], "the person gave no disclosure: nothing, never a default");
  const declined = plan(fields, { ...PERSONA, eeo: fact("decline") });
  eq(declined.map((f) => [f.name, f.value]), [["g", "I do not wish to self-identify"], ["v", "I DO NOT WISH TO SELF-IDENTIFY"]],
    "a decline only where a decline option exists");
});

Deno.test("WO-048/6 the Workday flow uses the whole planner; an unrecognised Workday page keeps the basic contact fields only", () => {
  const schema = [field("first", "First Name*", { required: true }), field("auth", "Are you legally authorized to work in the United States?*", { type: "select", required: true, options: YN })];
  const base = { userId: "u", jobId: "workday:northwind:R1", company: "northwind", family: "workday" as const, schema, answers: PERSONA, saved: {}, now: 0 };
  eq(planForm({ ...base, workdayFlow: true }).fill.map((f) => f.name), ["first", "auth"]);
  eq(planForm(base).fill.map((f) => f.name), ["first"], "WO-031: a Workday page that is not the application flow");
  // The disability form (CC-305) is always the person's: never planned, whatever facts exist.
  const personal = [field("dn", "Name", { personal: true } as any), field("dd", "Language", { type: "select", options: opts("English"), personal: true } as any)];
  const p = planForm({ ...base, workdayFlow: true, schema: personal, answers: { ...PERSONA, full_name: fact("Test Person"), eeo: fact("decline") } });
  eq(p.fill, [], "the disability form is never filled");
  eq(p.needs, [], "and never asked by text: it is filled by the person on the page");
  // The planner itself holds the line too, for any caller that does not go through planForm.
  eq(plan(personal, { ...PERSONA, full_name: fact("Test Person"), languages: fact("English") }), [], "planBatch never plans a personal field");
});

Deno.test("WO-048/7 one posting across every step; the employer named from the tenant", () => {
  const steps = ["1-my-information.html", "2-my-experience.html", "6-review.html"].map((s) => postingKey(`https://northwind.wd5.myworkdayjobs.com/en-US/External/job/Chicago/Data-Analyst_R-10421/apply/${s}`));
  eq(new Set(steps).size, 1);
  eq(steps[0], "workday:northwind.wd5.myworkdayjobs.com:Data-Analyst_R-10421");
  eq(postingKey("https://northwind.wd5.myworkdayjobs.com/en-US/External/job/Chicago/Data-Analyst_R-10421/apply/applyManually"), steps[0]);
  eq(postingKey("https://acme.wd1.myworkdayjobs.com/en-US/External/job/Chicago/Analyst_R123/apply"), "workday:acme.wd1.myworkdayjobs.com:Analyst_R123", "WO-031's key unchanged");
  eq(workdayEmployer("https://northwind.wd5.myworkdayjobs.com/x"), "northwind");
  eq(workdaySignIn("northwind"), "Sign in to northwind's Workday yourself; I'll fill the application after.");
});

Deno.test("WO-048/9 zero wrong where Workday's wording or Workday's own rows could mislead", () => {
  // A row Workday filled with nearly a stated employer: never filled by Trainee, and no second row for that job.
  const near = [row("work", 1, "employer", "Company", { anchor: "Example Analytic" }), row("work", 1, "title", "Job Title", { anchor: "Example Analytic" }),
    row("work", 2, "employer", "Company"), row("work", 2, "title", "Job Title")];
  const got = plan(near);
  eq(valueOf(got, "work-1--title"), null);
  eq(valueOf(got, "work-2--employer"), "Sample Retail", "the empty row takes the job no row names, not Example Analytics again");
  eq(rowsToAdd("work", ["Example Analytic"], PERSONA), 1, "only Sample Retail is added");
  // Two questions in one: neither fact answers it.
  eq(valueOf(plan([field("lr", "Are you local to Chicago, IL or willing to relocate?", { type: "select", options: YN })]), "lr"), null);
  eq(valueOf(plan([field("r", "Are you willing to relocate?", { type: "select", options: YN })]), "r"), "No");
  // A decline worded "Not declared"; other disclosures (orientation) follow the same decline, never a default.
  const dec = { ...PERSONA, eeo: fact("decline") };
  eq(valueOf(plan([field("g", "Gender", { type: "select", options: opts("Male", "Female", "Not declared") })], dec), "g"), "Not declared");
  eq(valueOf(plan([field("so", "Sexual Orientation", { type: "select", options: opts("Heterosexual", "Gay", "I do not wish to answer") })], dec), "so"), "I do not wish to answer");
  eq(valueOf(plan([field("so", "Sexual Orientation", { type: "select", options: opts("Heterosexual", "Gay", "I do not wish to answer") })]), "so"), null);
  // A school or field list takes only the stated name itself.
  eq(valueOf(plan([row("education", 1, "school", "School", { type: "select", options: opts("Example State University Online", "Other") })]), "education-1--school"), null);
  eq(valueOf(plan([row("education", 1, "major", "Field of Study", { type: "select", options: opts("Applied Statistics", "Physics") })]), "education-1--major"), null);
  // A phone code list answered from the country only when the person's phone carries that code.
  const codes = opts("Canada (+1)", "United States Minor Outlying Islands (+1)", "United States of America (+1)", "United Kingdom (+44)");
  eq(valueOf(plan([field("cc", "Country Phone Code", { type: "select", options: codes })]), "cc"), "United States of America (+1)");
  eq(valueOf(plan([field("cc", "Country Phone Code", { type: "select", options: codes })], { ...PERSONA, phone: fact("+44 20 7946 0000") }), "cc"), null);
  // The former-employer question in Workday's longer wording is derived from the person's own list.
  eq(valueOf(plan([field("pw", "Have you previously been employed by Contoso Test Health as a Full-time, Part-time, Contractor or Temporary worker in any of our locations?",
    { type: "radio", options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] })], PERSONA, "contoso-test-health"), "pw"), "false");
});

const snap = (o: Partial<SnapField>): SnapField => ({ name: "n", label: "L", value: "v", source: "trainee", factId: "f", masked: false, detail: "", ...o });
const payloadOf = (fields: SnapField[]) =>
  reviewPayload({ userId: "u", jobId: "workday:northwind:R1", company: "northwind", url: "https://northwind.wd5.myworkdayjobs.com/x/apply/1.html", family: "workday",
    fields, resume: null, account: { epoch: 0, version: 1 }, expiresAt: "2026-10-20T00:00:00.000Z" });

Deno.test("WO-048/8 a page's card: its answers exactly as sent, Workday's own values apart and never Trainee's, what Save and Continue does", () => {
  const p = payloadOf([snap({ name: "first", label: "First Name*", value: "Test" }), snap({ name: "country", label: "Country*", value: "United States of America", source: "workday", factId: null }),
    snap({ name: "w1", label: "Work Experience 1: Job Title", value: "Data Analyst II", source: "workday", factId: null }),
    snap({ name: "why", label: "Why us?", value: "TEST typed", source: "you", factId: null })]);
  const lines = cardLines({ company: "northwind", family: "workday", payload: p, openRequired: [], identity: [], blockers: [], verification: [],
    workday: { action: "draft", step: "My Information", employer: "northwind", conflicts: [{ label: "Work Experience 1: Job Title", workday: "Data Analyst II", yours: "Data Analyst" }] } });
  eq(lines[1], WORKDAY_NOTICE);
  assert(lines.includes("First Name: Test"));
  assert(lines.includes("Why us?: TEST typed (typed by you)"));
  const at = lines.indexOf(WORKDAY_PAGE_SET);
  assert(at > 0 && lines.indexOf("Country: United States of America") > at, "Workday's values under their own heading");
  eq(WORKDAY_PAGE_SET, "Filled by Workday from your resume: check them");
  assert(lines.some((l) => l.includes("Data Analyst II") && l.includes("Data Analyst") && /Workday/.test(l) && /your confirmed/i.test(l)), "a contradiction is side by side");
  assert(lines.includes(workdayDraftLine("northwind")));
  eq(workdayDraftLine("northwind"), "Save and Continue sends this page to northwind as a draft; nothing is submitted.");
  assert(!lines.some((l) => /submits? (this|your) application/i.test(l)), "a draft page never speaks of submitting");
  // The review page: the reading of every answer, and the one Submit.
  const r = payloadOf([snap({ name: "review:1", label: "My Information: First Name", value: "Test", source: "fixed", factId: null })]);
  const rl = cardLines({ company: "northwind", family: "workday", payload: r, openRequired: [], identity: [], blockers: [], verification: [], workday: { action: "submit", step: "Review", employer: "northwind" } });
  assert(rl.includes("My Information: First Name: Test"));
  assert(rl.includes(workdaySubmitLine("northwind")));
  assert(!rl.includes(workdayDraftLine("northwind")));
  // Without the Workday flow (WO-031's flat page), the card is the one it was.
  const old = cardLines({ company: "northwind", family: "workday", payload: p, openRequired: [], identity: [], blockers: [], verification: [] });
  assert(old.some((l) => l.startsWith("Approve sends it with the site's own Submit")));
});

// ------------------------------------------------------------------------------------------------ round 2 (spent s1-s4)
const YN_RADIO = [{ label: "Yes", value: "true" }, { label: "No", value: "false" }];

Deno.test("WO-048/10 'a previous employee of X or any of its affiliates': No only from a complete list that names nothing like X", () => {
  const q = "Were you a previous employee of Tailspin Test Air or any of its affiliates?";
  eq(mapQuestion({ label: q, type: "radio", options: YN_RADIO }).fact, "worked_here_before");
  const ask = (answers = PERSONA as Record<string, { value: string; factId: string }>) =>
    valueOf(plan([field("pw", q, { type: "radio", options: YN_RADIO })], answers, "tailspin-test-air"), "pw");
  eq(ask(), "false", "every stated job is in the confirmed list, and none is Tailspin's: No");
  eq(ask({ ...PERSONA, former_employers: fact("Example Analytics; Sample Retail; Tailspin Test Air") }), "true", "listed: Yes");
  eq(ask({ ...PERSONA, former_employers: fact("Example Analytics; Sample Retail; Tailspin Cargo") }), null, "a listed company that may be an affiliate: asked");
  eq(ask({ ...PERSONA, former_employers: fact("Example Analytics") }), null, "a job the person stated is missing from the list: not complete, asked");
  const none = { ...PERSONA } as Record<string, { value: string; factId: string }>;
  delete none.former_employers;
  eq(ask(none), null, "no confirmed list: asked");
  // The same wording naming one of the person's employers among others is theirs to answer (the existing guard).
  eq(valueOf(plan([field("pw", "Were you a previous employee of Tailspin Test Air, Sample Retail or any of their affiliates?", { type: "radio", options: YN_RADIO })],
    PERSONA, "tailspin-test-air"), "pw"), null);
});

Deno.test("WO-048/11 a language's level on a list: native or fluent only when the person said so, onto the one option that says it", () => {
  const levels = opts("Elementary", "Limited working", "Professional working", "Full professional", "Native or bilingual");
  const q = (label: string, answers = PERSONA as Record<string, { value: string; factId: string }>, o = levels) =>
    valueOf(plan([field("lp", label, { type: "select", options: o })], answers), "lp");
  eq(mapQuestion({ label: "How would you rate your English proficiency?", options: levels }).fact, "languages");
  eq(q("How would you rate your English proficiency?"), "Native or bilingual");
  eq(q("How would you rate your English proficiency?", { ...PERSONA, languages: fact("English") }), null, "no level stated: asked");
  eq(q("How would you rate your English proficiency?", { ...PERSONA, languages: fact("English (fluent)") }), null, "fluent is not 'Native or bilingual', and no option says fluent");
  eq(q("How would you rate your English proficiency?", { ...PERSONA, languages: fact("English (fluent)") }, opts("Basic", "Conversational", "Fluent")), "Fluent");
  eq(q("How would you rate your English proficiency?", { ...PERSONA, languages: fact("Spanish (native)") }), null, "another language's level is not English's");
  eq(q("How would you rate your Spanish proficiency?"), null, "a language the person never named");
  eq(q("Rate your English and Spanish proficiency", { ...PERSONA, languages: fact("English (native); Spanish (native)") }), null, "two languages in one question");
  eq(q("Are you fluent in English?", PERSONA, YN), null, "a yes/no about English is read as before");
  eq(q("How would you rate your English proficiency?", PERSONA, opts("Native", "Native-like", "Fluent")), null, "two options that say native: asked");
  // Never typed into a box: a score or a free-text level is the person's.
  eq(valueOf(plan([field("ts", "English proficiency test score (TOEFL)")]), "ts"), null);
  // The same rule on a language row's level list: native onto Native beside Fluent.
  const row5 = opts("Beginner", "Intermediate", "Advanced", "Fluent", "Native");
  const rows = [row("language", 1, "language", "Language", { type: "select", options: opts("English", "French") }),
    row("language", 1, "proficiency", "Overall", { type: "select", options: row5 })];
  eq(valueOf(plan(rows), "language-1--proficiency"), "Native");
  eq(valueOf(plan(rows, { ...PERSONA, languages: fact("English (fluent)") }), "language-1--proficiency"), "Fluent");
});

Deno.test("WO-048/12 a Websites row takes the person's one link, only when the form has no field of its own for it", () => {
  const LI = "https://www.linkedin.com/in/test-person";
  const P = { ...PERSONA, linkedin: fact(LI, "TEST-li") };
  const url = [row("website", 1, "url", "URL")];
  const got = plan(url, P);
  eq(valueOf(got, "website-1--url"), LI);
  eq(got[0].factId, "TEST-li", "cites the LinkedIn fact");
  eq(rowsToAdd("website", [], P, url), 1, "one row added for the one link");
  eq(rowsToAdd("website", [LI], P, url), 0, "a row already holding it (Workday's parse): none added");
  eq(rowsToAdd("website", [], P), 0, "without the form's fields, nothing is added");
  const own = [...url, field("li", "LinkedIn")];
  eq(valueOf(plan(own, P), "website-1--url"), null, "the form asks for LinkedIn on its own: the generic URL is left");
  eq(rowsToAdd("website", [], P, own), 0);
  const two = { ...P, github: fact("https://github.com/test-person") };
  eq(valueOf(plan(url, two), "website-1--url"), null, "two links: which one is the person's call");
  eq(rowsToAdd("website", [], two, url), 0);
  eq(valueOf(plan(url, { ...PERSONA, linkedin: fact("test-person on LinkedIn") }), "website-1--url"), null, "not a URL as stated: left");
  eq(valueOf(plan([row("website", 1, "url", "URL", { type: "select", options: opts(LI) })], P), "website-1--url"), null, "never onto a list");
});

Deno.test("WO-048/13 'when could you start' over spans of time: from the notice period, the tightest span that holds it", () => {
  const starts = opts("Immediately", "Within 2 weeks", "Within 1 month", "More than 1 month");
  const q = (answers: Record<string, { value: string; factId: string }>, o = starts, label = "If offered this position, when could you start?") =>
    valueOf(plan([field("st", label, { type: "select", options: o })], answers), "st");
  eq(q(PERSONA), "Within 2 weeks");
  eq(q({ ...PERSONA, notice_period: fact("1 month") }), "Within 1 month");
  eq(q({ ...PERSONA, notice_period: fact("6 weeks") }), "More than 1 month");
  eq(q({ ...PERSONA, notice_period: fact("immediately") }), "Immediately");
  eq(q({ ...PERSONA, notice_period: fact("whenever suits") }), null, "not a span: asked");
  eq(q(PERSONA, opts("Within 1-2 weeks", "Within 3-4 weeks", "1 month+")), "Within 1-2 weeks", "a range is read as a range");
  eq(q(PERSONA, opts("Within 2 weeks", "Within 2 weeks or less")), null, "two spans that say the same: asked");
  eq(q(PERSONA, YN, "Can you start within 2 weeks?"), null, "a yes or no is never derived from the notice period here");
  eq(valueOf(plan([field("sd", "When could you start?")]), "sd"), null, "a free-text start date is never the notice period");
  const none = { ...PERSONA } as Record<string, { value: string; factId: string }>;
  delete none.notice_period;
  eq(q(none), null, "no notice period: asked");
  eq(chooseOption("notice_period", "2 weeks", opts("1-2 weeks", "2-4 weeks")), null, "two closed spans sharing the edge: still asked");
});

Deno.test("WO-048/14 how the person heard, on a nested list: the careers site by its own name, never 'Other Website', a twin leaf asked", () => {
  const ask = (o: string[], answers = PERSONA as Record<string, { value: string; factId: string }>) =>
    valueOf(plan([field("hh", "How Did You Hear About Us?", { type: "select", options: opts(...o) })], answers), "hh");
  eq(ask(["Website > Litware Careers Website", "Website > Other Website", "Job Board > Indeed", "Other"]), "Website > Litware Careers Website");
  eq(ask(["Litware Careers Website", "Other Website", "Indeed"]), "Litware Careers Website");
  eq(ask(["Company Website > Careers Site", "Job Board > Indeed"]), "Company Website > Careers Site");
  eq(ask(["Corporate Website", "Indeed"]), "Corporate Website", "a plain website option when none names the careers page");
  eq(ask(["Other Website", "LinkedIn"]), null, "another website is not the company's");
  eq(ask(["Careers Page", "Join Our Pride Website"]), "Careers Page");
  const li = { ...PERSONA, how_heard: fact("LinkedIn") };
  eq(ask(["Job Board > LinkedIn Jobs", "Social Media > LinkedIn"], li), null, "two LinkedIn leaves under two categories: asked");
  eq(ask(["Job Board > Indeed", "Social Media > LinkedIn"], li), "Social Media > LinkedIn");
  eq(ask(["Website", "Job Board"], { ...PERSONA, how_heard: fact("a friend told me") }), null, "no sure match: asked, never guessed");
});

// Round 3.
import { normLabel } from "../../supabase/functions/_shared/career_apply.ts";

Deno.test("WO-048/15 a field of a repeating section's row never takes a person-level fact, even when no row was recognised", () => {
  // sealed-wd2 t4: a past job's Location (id `workExperience-31--location`) was not read as part of its section and took
  // the person's home "Chicago, IL". A field the form names as a row's part (Workday's `<section>-<n>--<part>` id) that
  // the reader did not tie to a row, or that the reader marks as in a section but with no row (row 0), is left: asked when
  // required, never filled from the person's location, city, phone, email, name, current employer or title.
  const P = { ...PERSONA, location: fact("Chicago, IL"), current_employer: fact("Example Analytics"), current_title: fact("Data Analyst"),
    linkedin: fact("https://www.linkedin.com/in/test-person") };
  const loose = [
    field("workExperience-31--location", "Location"), field("workExperience-31--jobTitle", "Job Title"),
    field("workExperience-31--companyName", "Company"), field("workExperience-44--email", "Supervisor Email"),
    field("workExperience-44--phone", "Employer Phone Number"), field("education-7--city", "City"), field("education-7--schoolName", "School or University"),
    field("languages-3--language", "Language"), field("websites-12--url", "Website"), field("webAddress-2--url", "LinkedIn"),
    field("workExperienceSection-5--fullName", "Name"), field("education-9--address", "Address"),
  ];
  eq(plan(loose, P), [], "no row part takes a person-level fact");
  // The same labels outside any section are the person's own questions and are still answered (the control).
  const own = plan(loose.map((f) => ({ ...f, name: "q-" + f.name.replace(/^.*--/, "") })), P);
  eq(valueOf(own, "q-location"), "Chicago, IL");
  eq(valueOf(own, "q-city"), "Chicago");
  eq(valueOf(own, "q-phone"), "+1 555 010 0000");
  eq(valueOf(own, "q-address"), "1 Example St, Chicago, IL 60601");
  // Required: asked (the person states it), never guessed.
  const req = planBatch({ userId: "u", postings: [{ job_id: "j", company: "northwind", title: "", fields: [{ ...loose[0], required: true }] }], answers: P, saved: {}, log: [], now: 0 });
  eq(req.ready.length, 0, "the required row part blocks");
  eq(req.needs.map((n) => n.label), ["Location"]);
  // A saved answer under the same wording is not a row's answer either.
  const saved = planBatch({ userId: "u", postings: [{ job_id: "j", company: "northwind", title: "", fields: [loose[0]] }], answers: P,
    saved: { [normLabel("Location")]: fact("Chicago, IL") }, log: [], now: 0 });
  eq(saved.ready[0].fields, [], "an ask-once answer by wording never fills a row part");
  // The reader saw the section but no row (row 0): left, and it takes no entry from the real empty rows.
  const fields = [
    row("work", 0, "unknown", "Location"), row("work", 0, "unknown", "Job Title"),
    row("work", 1, "employer", "Company"), row("work", 1, "title", "Job Title"), row("work", 2, "employer", "Company"),
  ];
  const got = plan(fields, P);
  eq(valueOf(got, "work-0--unknown"), null);
  eq(valueOf(got, "work-1--employer"), "Example Analytics", "row 1 still takes the first job");
  eq(valueOf(got, "work-2--employer"), "Sample Retail", "row 2 still takes the second job");
  // A recognised row still fills from the person's own list, under the same names Workday uses.
  const wd = [
    field("workExperience-30--companyName", "Work Experience 1: Company", { section: { kind: "work", row: 1, part: "employer", anchor: "" } } as any),
    field("workExperience-31--companyName", "Work Experience 2: Company", { section: { kind: "work", row: 2, part: "employer", anchor: "" } } as any),
    field("workExperience-31--location", "Work Experience 2: Location", { section: { kind: "work", row: 2, part: "location", anchor: "" } } as any),
  ];
  const r = plan(wd, P);
  eq(valueOf(r, "workExperience-30--companyName"), "Example Analytics");
  eq(valueOf(r, "workExperience-31--companyName"), "Sample Retail");
  eq(valueOf(r, "workExperience-31--location"), null, "a job's location never stated: left");
});

Deno.test("WO-048/16 work authorization and sponsorship stay separate facts in the option choice (eligibility separation, spent-s1 regression)", () => {
  const STATUS = "What is your current work authorization status in the United States?";
  // A positive sponsorship need belongs to the sponsorship fact alone: never filled from a yes to work
  // authorization, and passed over for the option that speaks to authorization alone.
  eq(chooseOption("work_authorization", "Yes", opts("Authorized to work for any employer; sponsorship is necessary", "Not currently authorized to work in the U.S.", "Prefer not to say"), STATUS), null,
    "sponsorship is necessary: a positive need, not filled from authorization alone");
  eq(chooseOption("work_authorization", "Yes", opts("Authorized to work for any employer; sponsorship is necessary", "Authorized to work in the U.S. without sponsorship"), STATUS), "Authorized to work in the U.S. without sponsorship",
    "the necessary-sponsorship option is passed over for the authorized-without-sponsorship one");
  // A negation is not a need: the authorized-without-sponsorship class stays fillable. The bare word
  // "sponsor" excludes nothing — the first eligibility landing's !/sponsor/ test emptied this dropdown
  // on spent-s1 (tests/career-extension-workday.test.cjs).
  eq(chooseOption("work_authorization", "Yes", opts("Authorized to work in the U.S.; sponsorship is not required", "Not currently authorized to work in the U.S.", "Prefer not to say"), STATUS), "Authorized to work in the U.S.; sponsorship is not required",
    "sponsorship is not required: a negated need stays fillable");
  // A combined answer takes its own sponsorship position in a second clause: never picked from the
  // authorization fact alone (the same pin as the pending eligibility composition's reader/answer_options).
  eq(chooseOption("work_authorization", "Yes", opts("Yes, I am authorized and do not require sponsorship", "Yes, but I will require sponsorship in the future", "No"), "Are you legally authorized to work in the US?"), null,
    "a combined answer is answered from both facts, never from authorization alone");
});
