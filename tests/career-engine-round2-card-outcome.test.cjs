"use strict";
// Round 2 (review of #818), what the person is shown and what is reported, on plain data:
//  5. a hidden input that carries an ANSWER (a drawn Yes/No, a toggle, a combobox writing into a hidden field; names such as
//     sponsorship, work_auth, marketing_optin, over18) is a control like any other: shown on the card under its widget's words,
//     hashed, and asked when the person never gave that answer. Text the page put in a box (an e-signature "I agree", an
//     attestation, a salary) that the person never supplied is asked on every path. Only opaque tokens stay out of the card.
//  7. "submitted" only on visible, un-negated success words, with no visible error list, and no failed POST.
// The same on local pages in Chromium: tests/career-engine-round2-card-outcome-browser.test.cjs.
// Run: node --test tests/career-engine-round2-card-outcome.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pa = require("../workers/career-browser/parallel-apply.cjs");
const h = require("../workers/career-browser/handoff.cjs");

const SRC = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");
const c = (name, type, value, o = {}) => ({ name, label: o.label ?? name, type, option: o.option ?? null, value, touched: !!o.touched, hidden: !!o.hidden, answer: !!o.answer, disabled: !!o.disabled, q: null });
const nobody = { answer: () => undefined };

test("5: a hidden input is an answer by its name or by the drawn control beside it; an opaque token is not", () => {
  for (const n of ["sponsorship", "requires_sponsorship", "work_auth", "workAuthorization", "visa_status", "marketing_optin", "opt_in", "consent", "over18", "age_confirm", "gender", "race", "ethnicity", "veteran", "disability", "relocate", "salary_expectation", "agree_terms", "certify"])
    assert.equal(pa.hiddenIsAnswer(n, false), true, n);
  for (const n of ["csrf_token", "authenticity_token", "_nonce", "session_id", "ts", "g-recaptcha-response", "utf8", "job_id", "source"]) assert.equal(pa.hiddenIsAnswer(n, false), false, n);
  assert.equal(pa.hiddenIsAnswer("cover_note", true), true, "any hidden input written by a drawn control beside it");
  assert.equal(pa.hiddenIsAnswer("q_1234", true), true);
  assert.equal(pa.hiddenIsAnswer("csrf_token", true), false, "a token stays a token");
});

test("5: a hidden answer is shown under its widget's words, hashed, and asked; tokens are only counted", () => {
  const filled = [{ label: "Email", held: "a@example.invalid", source: "answer" }];
  const controls = [c("email", "email", "a@example.invalid", { label: "Email", touched: true }), c("sponsorship", "hidden", "yes", { label: "Do you require visa sponsorship?", answer: true }),
    c("csrf_token", "hidden", "t-1", { hidden: true }), c("marketing_optin", "hidden", "1", { label: "I agree to receive marketing emails from our partners", answer: true })];
  const card = h.answersCard({ url: "https://x/1", payload_hash: "ph", fields: filled, controls });
  assert.deepEqual(card.answers.filter((a) => a.source === "page_default").map((a) => [a.field, a.value]), [["Do you require visa sponsorship?", "yes"], ["I agree to receive marketing emails from our partners", "1"]]);
  assert.equal(card.hidden_not_hashed, 1, "only the token");
  assert.notEqual(card.hash, h.answersCard({ url: "https://x/1", payload_hash: "ph", fields: filled, controls: controls.map((x) => (x.name === "sponsorship" ? { ...x, value: "no" } : x)) }).hash, "the hidden answer is in the hash");
  assert.deepEqual(h.unconfirmedDefaults(controls, nobody).map((n) => [n.label, n.reason]), [["Do you require visa sponsorship?", "agreement_needs_you"], ["I agree to receive marketing emails from our partners", "agreement_needs_you"]]);
  assert.deepEqual(h.unconfirmedDefaults(controls, { answer: (l) => (/sponsorship/.test(l) ? "yes" : /marketing/.test(l) ? "Yes" : undefined) }).map((n) => n.label), [], "the person's own confirmed answers");
});

test("5: text the page put in a box that the person never supplied is asked; a disabled box is shown, never asked; confirmed text is not", () => {
  const k16 = [c("esign", "text", "I agree", { label: "Electronic signature (type I agree)" }), c("info", "textarea", "I certify that all statements are true and consent to a background check.", { label: "Additional information" })];
  assert.deepEqual(h.unconfirmedDefaults(k16, nobody).map((n) => n.reason), ["agreement_needs_you", "agreement_needs_you"]);
  const k22 = [c("years", "number", "10", { label: "Years of experience" }), c("salary", "text", "30000", { label: "Desired salary" }), c("start", "date", "2026-12-01", { label: "Earliest start date" })];
  assert.deepEqual(h.unconfirmedDefaults(k22, nobody).map((n) => [n.label, n.reason]), [["Years of experience", "no_confirmed_answer"], ["Desired salary", "no_confirmed_answer"], ["Earliest start date", "no_confirmed_answer"]]);
  const k12 = [c("referral", "text", "Agency Partner Ltd", { label: "Referral source" }), c("cand", "text", "X-99", { label: "Candidate ID", disabled: true })];
  assert.deepEqual(h.unconfirmedDefaults(k12, nobody).map((n) => n.label), ["Referral source"], "a disabled box is not sent, so not asked");
  assert.equal(h.answersCard({ url: "u", payload_hash: "p", fields: [], controls: k12 }).answers.length, 2, "both shown");
  const note = [c("", "contenteditable", "I confirm I am authorised to work in the UK without sponsorship.", { label: "Cover note" })];
  assert.equal(h.unconfirmedDefaults(note, nobody)[0].reason, "agreement_needs_you", "a contenteditable region is a control");
  assert.deepEqual(h.unconfirmedDefaults(k22, { answer: (l) => ({ "Years of experience": "10", "Desired salary": "30000", "Earliest start date": "2026-12-01" })[l] }), [], "the person's own answers");
  assert.deepEqual(h.unconfirmedDefaults([c("city", "text", "Leeds", { label: "City", touched: true })], nobody), [], "what the engine filled from the person's facts");
  // Asked on the ordinary path, before the submitting record, not only on the card's re-check.
  const fill = SRC.indexOf("await fillForm(page");
  assert.ok(SRC.indexOf("unconfirmedDefaults(controls", fill) > fill && SRC.indexOf("unconfirmedDefaults(controls", fill) < SRC.indexOf('opts.onPhase("submitting"', fill));
});

test("7: submitted only on visible success words that are not negated, with no visible error and no failed POST", () => {
  const v = (o) => pa.outcomeVerdict({ text: "", errors: [], posts: [], ...o });
  assert.deepEqual(v({ text: "Thank you for applying\nRef GH-12345", posts: [200] }), { confirmed: true, code: "GH-12345" });
  assert.equal(v({ text: "Thank you for applying!", posts: [] }).confirmed, true, "an AJAX form whose POST the page sent itself, unobserved");
  assert.equal(v({ text: "Your application has been submitted.", posts: [303, 200] }).confirmed, true);
  const no = {
    "no success words": { text: "Apply for Engineer" },
    "negated: could not confirm": { text: "Error\nWe could not confirm that your application submitted successfully. Please try again." },
    "negated: not submitted": { text: "Your application was not submitted." },
    "negated: unable": { text: "Unable to submit: thank you for applying again later" },
    "a visible error list": { text: "Thank you for applying!", errors: ["Email is invalid"] },
    "a failed POST": { text: "Thank you for applying!", posts: [0] },
    "a 500": { text: "Thank you for applying!", posts: [500] },
    "a 4xx among the POSTs": { text: "Thank you for applying!", posts: [200, 422] },
    "already applied": { text: "You have already applied to this job" },
  };
  for (const [why, o] of Object.entries(no)) assert.equal(v(o).confirmed, false, why);
  assert.match(v(no["a failed POST"]).reason, /POST/);
  // The runner reads what is rendered (innerText), not the page source, and listens for the POST's answer from before the click.
  const after = SRC.slice(SRC.indexOf("timing.submitClicked = true;"));
  assert.doesNotMatch(after.slice(0, after.indexOf("return { status: \"submitted_page_confirmed\"")), /page\.textContent\("body"\)/);
  assert.ok(SRC.indexOf('page.on("response"', SRC.indexOf("async function attempt(")) < SRC.indexOf('page.click("[data-upmore-submit]")'));
});
