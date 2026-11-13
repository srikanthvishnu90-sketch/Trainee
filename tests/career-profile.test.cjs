/* TEST fixtures only — synthetic TEST persona, never real user data. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Profile = require("../packages/domain/122-career-profile.js");

const fixtureDir = path.join(__dirname, "..", "packages", "career-data", "fixtures");
function loadFixture() {
  const data = JSON.parse(fs.readFileSync(path.join(fixtureDir, "test-persona.json"), "utf8"));
  return Profile.profileFromData(data);
}

test("fact IDs are stable: assigned once, kept on update, never reused", () => {
  const p = Profile.createProfile({ basics: { name: "TEST Person" } });
  const a = Profile.addFact(p, { kind: "experience", title: "TEST job A", text: "Did TEST work A" });
  const b = Profile.addFact(p, { kind: "project", title: "TEST project B", text: "Built TEST thing B" });
  assert.equal(a.id, "F-001"); assert.equal(b.id, "F-002");
  const updated = Profile.updateFact(p, a.id, { text: "Did TEST work A, updated" });
  assert.equal(updated.id, "F-001");
  assert.equal(Profile.getFact(p, "F-001").text, "Did TEST work A, updated");
  const c = Profile.addFact(p, { kind: "other", title: "TEST c", text: "TEST c" });
  assert.equal(c.id, "F-003");
  assert.equal(Profile.getFact(p, "F-999"), null);
});

test("fixture persona loads with its stated fact IDs intact", () => {
  const p = loadFixture();
  assert.ok(p.isTestFixture);
  assert.equal(Profile.getFact(p, "F-002").org, "TEST Systems Inc");
  assert.equal(Profile.getFact(p, "F-013").name, "Kubernetes");
});

test("unproven skill flag: a skill with no evidence is flagged, an evidenced one is not", () => {
  const p = loadFixture();
  const unproven = Profile.unprovenSkills(p).map((f) => f.name);
  assert.deepEqual(unproven, ["Rust"]);
  assert.equal(Profile.skillEvidence(p, "Kubernetes").proven, true);
  assert.ok(Profile.skillEvidence(p, "Kubernetes").evidenceFactIds.includes("F-003"));
  assert.equal(Profile.skillEvidence(p, "Rust").proven, false);
});

test("LinkedIn Connections.csv + Profile.csv parse (real export headers)", () => {
  const connections = [
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    'Testy,One (TEST),https://www.linkedin.com/in/testy-one,,TEST Corp,Intern,01 Jan 2025',
    '"Doe, Jr (TEST)",John,https://www.linkedin.com/in/johndoe,,Example LLC,Analyst,02 Feb 2025',
  ].join("\n");
  const r = Profile.parseLinkedInConnections(connections);
  assert.equal(r.errors.length, 0);
  assert.equal(r.connections.length, 2);
  assert.equal(r.connections[0].company, "TEST Corp");
  assert.equal(r.connections[1].firstName, "Doe, Jr (TEST)");
  assert.equal(r.connections[0].source, "linkedin-export");

  const profileCsv = [
    "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers",
    "Alex,Testcase (TEST),,,,TEST headline,TEST summary,Technology,,Chicago Illinois United States,,,",
  ].join("\n");
  const pr = Profile.parseLinkedInProfile(profileCsv);
  assert.equal(pr.profileRow.headline, "TEST headline");
  assert.equal(pr.profileRow.source, "linkedin-export");
});

test("LinkedIn malformed-row replay: bad rows are collected, good rows still parse", () => {
  const csv = [
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Good,Row (TEST),https://www.linkedin.com/in/good,,TEST Corp,Intern,01 Jan 2025",
    "Bad,RowOnlyThree,https://www.linkedin.com/in/bad",
    "Also,Good (TEST),https://www.linkedin.com/in/also,,Example LLC,Analyst,03 Mar 2025",
  ].join("\n");
  const r = Profile.parseLinkedInConnections(csv);
  assert.equal(r.connections.length, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /expected 7 columns, got 3/);
  // ingestion surfaces the same errors and does not throw
  const p = Profile.createProfile({});
  const ing = Profile.ingestLinkedIn(p, { connectionsCsv: csv });
  assert.equal(ing.errors.length, 1);
  assert.equal(p.connections.length, 2);
});

test("LinkedIn preamble lines before the header are skipped", () => {
  const csv = ["Notes:", '"When exporting your connection data, ... TEST preamble"', "", "First Name,Last Name,URL,Email Address,Company,Position,Connected On", "A,B (TEST),https://www.linkedin.com/in/ab,,TEST Corp,Intern,01 Jan 2025"].join("\n");
  const r = Profile.parseLinkedInConnections(csv);
  assert.equal(r.connections.length, 1);
});

test("fact-mining questions for a thin entry ask stack / users / replaced / metric", () => {
  const qs = Profile.factMiningQuestions({ kind: "experience", title: "Built a dashboard (TEST)", text: "Built a dashboard", bullets: [] });
  const joined = qs.join(" ").toLowerCase();
  assert.ok(qs.length >= 3);
  assert.match(joined, /stack|tools/);
  assert.match(joined, /how many users/);
  assert.match(joined, /replace/);
  assert.match(joined, /metric/);
  // a rich entry (the fixture internship) needs no digging
  const p = loadFixture();
  assert.equal(Profile.factMiningQuestions(Profile.getFact(p, "F-002")).length, 0);
});

test("resume ingestion: drafts only, every draft needs_confirmation until confirmed", () => {
  const text = fs.readFileSync(path.join(fixtureDir, "test-resume.txt"), "utf8");
  const p = Profile.createProfile({ basics: { name: "TEST Resume Person" } });
  const { drafts } = Profile.ingestResume(p, text);
  assert.ok(drafts.length >= 8, `expected >=8 drafts, got ${drafts.length}`);
  assert.ok(drafts.every((f) => f.needs_confirmation === true && f.status === "draft"));
  assert.ok(drafts.some((f) => f.kind === "experience"));
  assert.ok(drafts.some((f) => f.kind === "skill" && f.name === "Python"));
  // confirming one flips only that one
  const one = drafts[0];
  Profile.confirmFact(p, one.id);
  assert.equal(Profile.getFact(p, one.id).needs_confirmation, false);
  assert.ok(drafts.slice(1).every((f) => Profile.getFact(p, f.id).needs_confirmation === true));
});

test("preferences / constraints / defaults round-trip from the fixture", () => {
  const p = loadFixture();
  assert.equal(p.constraints.graduationDate, "2028-05");
  assert.equal(p.constraints.needsSponsorship, false);
  assert.equal(p.defaults.demographicPreference, "decline to answer");
  assert.ok(p.preferences.targetCompanies.length >= 1);
});

// 2026-11-13 (review of PR #788): a short or ordinary-word skill name (R, C, Go, ML, TS, Excel, Swift ...) is named by a
// fact only in a skills context (a list whose neighbour is a known skill, an explicit cue such as "in", "using", "with",
// "skills:", or a following word such as "models" or "scripts"), and no skill is named inside a negation.
const SKILL_CASES = [
  // hostile: ordinary words, names and negations
  ["Toys R Us cashier", "R", false], ["Section R of the compliance manual", "R", false], ["Reported to the VP of R and D", "R", false],
  ["Worked in R and D on new flavors", "R", false], ["Rated R film festival usher", "R", false],
  ["Vitamin C study assistant", "C", false], ["Grade: C in organic chemistry", "C", false], ["Level C clearance", "C", false], ["Terminal C gate agent", "C", false],
  ["Go Bears! Cheer captain", "Go", false], ["Go to market lead", "Go", false], ["Helped customers Go paperless", "Go", false], ["Tasked with Go to market planning", "Go", false],
  ["Dispensed 5 ML doses", "ML", false], ["ML Strategies LLC intern", "ML", false], ["Dispensed 5 ML doses", "Machine Learning", false],
  ["TS/SCI clearance", "TS", false], ["TS clearance held", "TS", false], ["TS/SCI clearance", "TypeScript", false],
  ["JS Bach recital", "JS", false], ["AI Weiwei exhibit docent", "AI", false],
  ["Excel Academy tutor", "Excel", false], ["Worked with Excel Academy students", "Excel", false], ["I excel at teamwork", "Excel", false],
  ["Swift Transportation driver", "Swift", false], ["Rust Belt oral history project", "Rust", false], ["Word of mouth marketing lead", "Word", false],
  ["Access control desk attendant", "Access", false], ["Spark Notes editor", "Spark", false], ["Ruby Tuesday server", "Ruby", false],
  ["Dart league treasurer", "Dart", false], ["Julia Child Foundation volunteer", "Julia", false], ["Chef de partie at Bistro TEST", "Chef", false],
  ["Puppet theater stagehand", "Puppet", false], ["Unity Church youth leader", "Unity", false], ["Flask and beaker inventory", "Flask", false],
  ["Express delivery driver", "Express", false], ["React quickly to incidents", "React", false], ["Sketch comedy troupe writer", "Sketch", false],
  ["Spring Break volunteer", "Spring", false], ["Interned in Spring 2024", "Spring", false], ["Built REST of the pipeline", "REST", false],
  ["I have never used SQL", "SQL", false], ["No experience with Python", "Python", false], ["Not familiar with Go", "Go", false],
  ["No experience with Python, R or SQL", "SQL", false], ["I don't know Java", "Java", false], ["Have not used Excel", "Excel", false],
  // true: a skills context
  ["Python, R, SQL", "R", true], ["Python, R, SQL", "SQL", true], ["Python, R, SQL", "Python", true], ["Built services in Go", "Go", true],
  ["TS/React front end", "TS", true], ["TS/React front end", "React", true], ["TS/React front end", "TypeScript", true],
  ["Excel (pivot tables)", "Excel", true], ["ML models in PyTorch", "ML", true], ["ML models in PyTorch", "Machine Learning", true],
  ["C, C++ and Rust", "C", true], ["C, C++ and Rust", "Rust", true], ["C, C++ and Rust", "C++", true],
  ["Analysis in R.", "R", true], ["R/Shiny dashboards", "R", true], ["C/C++ firmware", "C", true], ["Skills: Go, Swift, Ruby", "Swift", true],
  ["Languages: Go", "Go", true], ["Proficient in Excel and Word", "Word", true], ["Wrote ETL jobs using Spark", "Spark", true],
  ["Programming in Julia and Dart", "Dart", true], ["Configuration management with Chef and Puppet", "Puppet", true], ["Games in Unity", "Unity", true],
  ["APIs with Flask and Express", "Express", true], ["Go", "Go", true], ["R scripts for survival analysis", "R", true],
  // lower case counts inside a list of known skills, and only there
  ["python, react, sql", "React", true], ["built with react and typescript", "React", true], ["python, r, sql", "R", true], ["java, go, rust", "Go", true],
  ["java, go, rust", "Rust", true], ["excel, word and powerpoint", "Word", true], ["swift/kotlin mobile apps", "Swift", true], ["docker, chef, puppet", "Chef", true],
  ["flask and django services", "Flask", true], ["spark, hadoop, hive", "Hive", true],
  ["helped the team react quickly", "React", false], ["with access to payroll records", "Access", false], ["in word and deed", "Word", false],
  ["learned python and go to meetups", "Go", false], ["I excel at sql", "Excel", false], ["a spark of interest in rust removal", "Rust", false],
  // round 2 (second review): learning, intent, a third party, a negation later in the sentence, an initial, a company name
  ["I am learning Go", "Go", false], ["Interested in learning Swift", "Swift", false], ["I want to learn Go", "Go", false], ["I'd like to learn Python someday", "Python", false],
  ["Familiar with the idea of SQL but never used it", "SQL", false], ["My manager used SQL, I did not", "SQL", false], ["Worked with R. Smith on audits", "R", false],
  ["Drove for Express Scripts", "Express", false], ["Rather than Python, we used spreadsheets", "Python", false], ["Worked with Word of Life church", "Word", false],
  ["I go, python club meets", "Go", false], ["Wanted to use Rust but the team chose Java", "Rust", false], ["Read a book about Python", "Python", false],
  ["Attended a talk on Kubernetes", "Kubernetes", false], ["Beginner course in SQL (not completed)", "SQL", false], ["Hoping to pick up Rust next year", "Rust", false],
  // round 2: experience cues are a skills context
  ["Excel modelling", "Excel", true], ["C programmer for 5 years", "C", true], ["3 years of Go", "Go", true], ["Taught myself R", "R", true], ["Spring Boot microservices", "Spring", true],
  ["Ruby on Rails developer", "Ruby", true], ["Rust CLI tool for log parsing", "Rust", true], ["Swift iOS app with 10k downloads", "Swift", true], ["Spark jobs on EMR", "Spark", true],
  ["Embedded C for microcontrollers", "C", true], ["Built AI chatbots", "AI", true], ["Go (3 yrs), Python (5 yrs)", "Go", true], ["Advanced Excel", "Excel", true], ["MS Access databases", "Access", true],
  ["Unity game developer", "Unity", true], ["Express.js server", "Express", true], ["Elixir/Phoenix", "Elixir", true], ["Dart and Flutter mobile app", "Dart", true],
  ["Ported the service from Python to Go", "Go", true], ["Daily Excel user", "Excel", true], ["My stack is Go + Postgres", "Go", true], ["Migrated services to Go", "Go", true],
  ["Excel power user", "Excel", true], ["Strong C fundamentals", "C", true], ["Not only Python but also Go", "Go", true], ["Go lang microservices", "Go", true], ["Julia for numerical simulation", "Julia", true],
  ["Models in R, a REST API in Go, Node.js on k8s, CI/CD.", "Go", true], ["Used SQL daily; never missed a deadline", "SQL", true], ["Mockups in Sketch", "Sketch", true],
];
test(`textNamesSkill on ${SKILL_CASES.length} texts: short and ordinary-word skills only in a skills context, never in a negation`, () => {
  assert.ok(SKILL_CASES.length >= 40);
  const wrong = SKILL_CASES.filter(([text, skill, want]) => Profile.textNamesSkill(text, skill) !== want).map(([text, skill, want]) => `${JSON.stringify(skill)} in ${JSON.stringify(text)} should be ${want}`);
  assert.deepEqual(wrong, []);
  // The proof a skill rests on follows: an ordinary word proves nothing, a skills line does.
  const p = { facts: [{ id: "a", kind: "experience", text: "Toys R Us cashier; Go Bears! Cheer captain; I have never used SQL" }, { id: "b", kind: "project", text: "Dashboards in R, SQL and Go" }] };
  for (const sk of ["R", "Go", "SQL"]) assert.deepEqual(Profile.skillEvidence(p, sk).supportingFactIds, ["b"], sk);
});
