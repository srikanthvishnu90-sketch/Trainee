/* 148 CONTACT FLOOR (review of #776/#785, 2026-11-13): parse-check blocked only the bracketed "[your email]". A header
   email of you@example.com / name@domain.com, or a placeholder phone on the contact line, came back PASS. A resume
   whose contact email is missing, bracketed or a placeholder, or whose phone is one, is never a pass; a real-looking
   contact still is. TEST fixtures only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const Render = require("../packages/domain/148-career-render.js");

const lines = [{ text: "Software Engineer, TEST Co, 2024–2025", factIds: ["F-001"], type: "entry" }, { text: "Built data pipelines in Python", factIds: ["F-001"], type: "bullet" }];
function check(header) {
  const resume = { header: { name: "Casey Rivers", links: {}, ...header }, sections: [{ heading: "Experience", lines }], lines: lines.map((l) => ({ ...l, section: "Experience" })) };
  const pdf = Render.renderPdf(resume), docx = Render.renderDocx(resume);
  assert.ok(pdf.ok && docx.ok, "fixture resume must render");
  return Render.parseCheck({ resume, pdf: pdf.buffer, docx: docx.buffer });
}
const unconfirmed = (pc, field) => pc.status === "FAIL" && pc.reasons.some((x) => x.check === "contact_unconfirmed" && x.level === "fail" && x.detail.includes(`the ${field} is not confirmed`) && /not ready to submit/.test(x.detail));

test("148 contact: a placeholder, bracketed or missing header email FAILS parse-check as not confirmed", () => {
  for (const email of ["you@example.com", "name@domain.com", "your.email@email.com", "firstname.lastname@gmail.com", "jane.doe@gmail.com", "user@localhost", "casey@example.org", "[your email]", "", null, undefined]) {
    assert.ok(unconfirmed(check({ email }), "email"), `must FAIL: ${JSON.stringify(email)}`);
  }
});

test("148 contact: a placeholder phone or a second, placeholder email on the confirmed contact line FAILS parse-check", () => {
  const email = "casey.rivers@gmail.com";
  for (const phone of ["(555) 555-5555", "555-0100", "312-555-0199", "123-456-7890", "(xxx) xxx-xxxx", "000-000-0000"]) {
    assert.ok(unconfirmed(check({ email, contactLine: `${email} | ${phone} | Chicago, IL` }), "phone"), `must FAIL: ${phone}`);
  }
  assert.ok(unconfirmed(check({ email, contactLine: `${email} | you@example.com` }), "email"));
});

test("148 contact: real-looking emails and phones do NOT fail on this check, and the resume still passes", () => {
  for (const [email, phone] of [["a.khan@gmail.com", "(415) 867-5309"], ["first.last@university.edu", "+1 212-736-5000"], ["casey.rivers@outlook.com", "646.555.0234"], ["c.rivers+jobs@proton.me", "+44 20 7946 0958"]]) {
    const pc = check({ email, contactLine: `${email} | ${phone} | Chicago, IL 60614` });
    assert.deepEqual(pc.reasons.filter((x) => x.level === "fail"), [], `${email} ${phone}`);
    assert.notEqual(pc.status, "FAIL");
    assert.equal(check({ email }).reasons.some((x) => x.check === "contact_unconfirmed"), false);
  }
});

test("148 contact: the same check reads a file's own text (the submit gates hold only the bytes)", () => {
  const top = (email) => Render.fileContactProblems(["Casey Rivers", email, "EXPERIENCE", "Support lead: answered help@example.com tickets, 555-0100 line"]);
  assert.deepEqual(top("casey.rivers@gmail.com | (415) 867-5309"), [], "the body below the first heading is not the contact");
  assert.deepEqual(top("you@example.com").map((x) => x.field), ["email"]);
  assert.deepEqual(top("casey.rivers@gmail.com | (555) 555-5555").map((x) => x.field), ["phone"]);
  assert.deepEqual(top("Chicago, IL").map((x) => [x.field, x.why]), [["email", "missing"]]);
});
