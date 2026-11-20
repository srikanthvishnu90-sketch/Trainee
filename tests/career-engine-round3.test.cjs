"use strict";
// Round 3 (review of #831), on plain data. 1: a hidden value is classified by what it says, not only by its name; what the page adds
// to the data it sends (a formdata handler, its own fetch) is compared with what was approved. 2: success words inside a sentence
// that says otherwise are not success. 3: honest forms the earlier rounds refused. 4: a bare "Name" field beside a first- or
// last-name field is the other half, never the full name. In Chromium: tests/career-engine-round3-browser.test.cjs.
// Run: node --test tests/career-engine-round3.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pa = require("../workers/career-browser/parallel-apply.cjs");
const af = require("../workers/career-browser/ats-fill.cjs");

test("1: a hidden value that is an answer is an answer, whatever the field is called; only a token's shape or a token's exact name is not", () => {
  const yes = [["q_88213", "yes"], ["custom_question_4471", "Yes"], ["answers[3]", "I agree to the arbitration agreement"], ["x1", "yes"], ["field_12", "No"], ["q_7", "1"], ["notes", "I consent to a background check"],
    ["extra", "Authorized to work"], ["cq", "true"]];
  for (const [n, v] of yes) assert.equal(pa.hiddenIsAnswer(n, false, v), true, `${n}=${v}`);
  const no = [["authenticity_token", "x"], ["csrf_token", "yes"], ["_nonce", "abc"], ["session_id", "s1"], ["job_id", "5312426"], ["source", "careers"], ["utf8", "✓"], ["ts", "1794588590529"],
    ["state", "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"], ["req", "550e8400-e29b-41d4-a716-446655440000"], ["h", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"], ["g-recaptcha-response", ""], ["locale", "en"]];
  for (const [n, v] of no) assert.equal(pa.hiddenIsAnswer(n, false, v), false, `${n}=${v}`);
  assert.equal(pa.hiddenIsAnswer("consent_session", false, "1"), true, "a name that only contains 'session' is no token");
  // A JSON value is the page's structured data (Lever's question templates), an answer only when a key of it is one.
  assert.equal(pa.hiddenIsAnswer("cards[a1][baseTemplate]", false, JSON.stringify({ createdAt: 1699385798902, text: "Are you authorized to work in the US?", fields: [{ type: "multiple-choice", text: "Yes or no" }] })), false);
  assert.equal(pa.hiddenIsAnswer("payload", false, JSON.stringify({ applicant: { marketingOptIn: true } })), true);
  assert.equal(pa.isOpaqueName("session_note"), false); assert.equal(pa.isOpaqueName("consent_session"), false); assert.equal(pa.isOpaqueName("csrfmiddlewaretoken"), true);
});

test("1: data the page adds or changes as it sends the form is refused", () => {
  const want = [["first_name", "Casey"], ["email", "c@x"], ["resume", "file:r.pdf:14"]];
  assert.deepEqual(pa.sentDiffers(want, want), null);
  assert.match(pa.sentDiffers(want, [...want, ["mk", "1"]]), /mk/, "a formdata handler's extra field");
  assert.match(pa.sentDiffers(want, [["first_name", "Casey"], ["email", "other@x"], ["resume", "file:r.pdf:14"]]), /email/, "a changed value");
  assert.match(pa.sentDiffers(want, [...want, ["marketing_optin", "1"]]), /marketing_optin/, "the page's own fetch with one more field");
  assert.equal(pa.sentDiffers(want, [...want, ["g-recaptcha-response", "03AG"]]), null, "a token the page sets as it sends is no answer");
  assert.equal(pa.sentDiffers(want, want.slice(0, 2)), null, "sending less is not sending something unapproved");
  // A JSON body is read for answers: a consent or opt-in key the approval did not have is refused; ordinary keys are not compared.
  assert.match(pa.jsonDiffers(want, JSON.stringify({ firstName: "Casey", marketingOptIn: true })), /marketingOptIn/);
  assert.equal(pa.jsonDiffers(want, JSON.stringify({ firstName: "Casey", email: "c@x" })), null);
  assert.equal(pa.jsonDiffers(want, "not json"), null);
});

test("2: success words inside a sentence that says it did not happen are not success", () => {
  const v = (text) => pa.outcomeVerdict({ text, errors: [], posts: [200] }).confirmed;
  assert.equal(v("Oops\nThank you for applying is what you'd see if this had worked. Session expired."), false);
  assert.equal(v("Thank you for applying would appear here, for example."), false);
  assert.equal(v("Your session has expired. Thank you for applying."), false);
  assert.equal(v("Thank you for applying to Example Corp!"), true, "a company named Example is not a negation");
  assert.equal(v("Submitted\nWe've received your application. Note: you can't edit it now."), true, "'can't edit' is not 'not submitted'");
});

test("3: an icon-only Submit by its accessible name; a name that adds 'form'; LinkedIn named in a click handler, even encoded", () => {
  const b = (text, aria, o = {}) => ({ text, aria, blob: `${text} ${aria}`, disabled: false, ...o });
  assert.equal(pa.controlLabel(b("", "Submit application", { icon: true, tag: "BUTTON", type: "submit" })), "yes", "icon-only, an allowed accessible name");
  assert.equal(pa.controlLabel(b("✈", "Submit", { icon: true, tag: "BUTTON", type: "submit" })), "yes", "a glyph is no words");
  assert.equal(pa.controlLabel(b("", "Submit application")), "conflict", "no icon and no words: still refused");
  assert.equal(pa.controlLabel(b("", "Submit application", { icon: true, tag: "BUTTON", type: "button" })), "conflict", "an icon button that does not declare itself the Submit");
  assert.equal(pa.controlLabel(b("Submit", "Submit application form")), "yes", "both allowed and the same meaning");
  assert.equal(pa.controlLabel(b("Save draft", "Submit application")), "conflict");
  assert.equal(pa.controlLabel(b("", "Apply", { icon: true, blob: "Apply event.preventDefault();location.href='https://www.linkedin.com/x'" })), "no");
  assert.equal(pa.controlLabel(b("Apply", "", { blob: "Apply location.href=atob('aHR0cHM6Ly93d3cubGlua2VkaW4uY29tL2pvYnMvdmlldy8x') https://www.linkedin.com/jobs/view/1" })), "no", "SNAP decodes atob literals into the blob");
  // Errors: only visible error words count, never a footer link named "error-report".
  assert.equal(pa.isErrorText("Report an error on this page", true), false);
  assert.equal(pa.isErrorText("Email is invalid", false), true);
  assert.equal(pa.isErrorText("", false), false);
});

test("4: a bare 'Name' beside a first- or last-name field is the other half; alone it is the full name; both beside it: asked", () => {
  const facts = af.factsFrom({ first_name: "Casey", last_name: "Example", email: "c@x" }, {});
  const q = (label, name = "") => ({ kind: "text", label, name, q: 1 });
  const ctx = (labels) => ({ facts, answers: {}, siblings: labels });
  assert.deepEqual(af.decide(q("Namn"), ctx(["Namn", "Efternamn", "E-post"])).value, "Casey");
  assert.deepEqual(af.decide(q("Nome"), ctx(["Nome", "Cognome"])).value, "Casey");
  assert.deepEqual(af.decide(q("Nom"), ctx(["Prénom", "Nom", "E-mail"])).value, "Example");
  assert.deepEqual(af.decide(q("Nombre"), ctx(["Nombre", "Apellidos"])).value, "Casey");
  assert.deepEqual(af.decide(q("Name"), ctx(["Name", "Email"])).value, "Casey Example", "alone: the full name");
  assert.equal(af.decide(q("Namn"), ctx(["Namn", "Förnamn", "Efternamn"])).status, "ask", "both halves beside it: which one it is cannot be told");
  assert.deepEqual(af.decide(q("Name", "candidate[first_name]"), ctx(["Name", "Email"])).value, "Casey", "the box's own name says first name");
});
