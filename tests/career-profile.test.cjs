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
