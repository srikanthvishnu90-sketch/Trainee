"use strict";
// Round 6 (review of round 5), on plain data. v3/v4: a "constant" is only a hidden input that was on the page at load, sent under its
// own name with its own value (never a value merely found in the page's text). y1: once the approved POST has been answered, the
// page may go to its own outcome page with an id in the address. v1/v2: no request in the window may carry an answer in its path or
// query, and an asset must be one the page loaded before. In Chromium: tests/career-engine-round6-browser.test.cjs.
// Run: node --test tests/career-engine-round6.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pa = require("../workers/career-browser/parallel-apply.cjs");

const want = [["first_name", "Casey"], ["email", "c@x"], ["resume", "file:resume.pdf:30"]];
const st = (o = {}) => ({ action: "http://h/app/submit", method: "POST", want, used: false, answered: false, blocked: [], ats: "greenhouse",
  hiddenAtLoad: [["job_id", "4802172007"], ["source", "careers"]], seen: new Set(["http://h/static/app.css"]), assets: new Set(["http://h/static/"]), ...o });
const post = (body, ct = "application/x-www-form-urlencoded") => ({ method: "POST", url: "http://h/app/submit", resourceType: "fetch", navigation: false, contentType: ct, body });

test("v3/v4: a field or JSON key the approval does not hold passes only as a hidden input of the page at load, same name, same value", () => {
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&q_77=relocate-anywhere"), st()), "abort", "v3: a value found in the page's text is no constant");
  assert.equal(pa.submitWindowVerdict(post(JSON.stringify({ email: "c@x", q_77: "relocate-anywhere" }), "application/json"), st()), "abort", "v4: the same as a JSON key");
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&job_id=4802172007"), st()), "allow", "the page's own hidden job id at load, same name and value");
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&job_id=1111111111"), st()), "abort", "the same name, another value");
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&ref=4802172007"), st()), "abort", "the same value, another name");
  assert.equal(pa.submitWindowVerdict(post(JSON.stringify({ first_name: "Casey", source: "careers" }), "application/json"), st()), "allow", "JSON: a hidden input's own name and value");
  assert.equal(pa.submitWindowVerdict(post(JSON.stringify({ first_name: "Casey", job_shortcode: "AB12CD34" }), "application/json"), st({ ats: "workable" })), "abort", "a value merely in a script is not a constant");
});

test("y1: the outcome page after the approved POST has been answered, with an id in its address; before the answer, refused", () => {
  const nav = (url) => ({ method: "GET", url, resourceType: "document", navigation: true, redirected: false });
  assert.equal(pa.submitWindowVerdict(nav("http://h/y1/thanks?application_id=98765"), st()), "abort", "before the approved POST");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y1/thanks?application_id=98765"), st({ used: true })), "abort", "the POST sent, its answer not yet in");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y1/thanks?application_id=98765"), st({ used: true, answered: true })), "allow");
  assert.equal(pa.submitWindowVerdict(nav("http://other.test/thanks?application_id=98765"), st({ used: true, answered: true })), "abort", "another origin");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y1/thanks?consent=1&sponsorship=yes"), st({ used: true, answered: true })), "abort", "answers in the outcome page's address");
});

test("v1/v2: no request in the window carries an answer in its path or query; an asset only as loaded before", () => {
  const used = st({ used: true, answered: true });
  assert.equal(pa.submitWindowVerdict({ method: "GET", url: "http://h/v1/done/consent/1/sponsorship/yes", resourceType: "document", navigation: true }, used), "abort", "v1: answers in a navigation's path");
  assert.equal(pa.submitWindowVerdict({ method: "GET", url: "http://h/px/consent/1/sponsorship/yes/pixel.png", resourceType: "image", navigation: false }, used), "abort", "v2: answers in an image's path");
  // Round 7 (architect amendment, stricter): a folder of assets loaded before is not enough; only the very address (below).
  assert.equal(pa.submitWindowVerdict({ method: "GET", url: "http://h/static/check.png", resourceType: "image", navigation: false }, used), "abort", "an asset under a folder of assets loaded before");
  assert.equal(pa.submitWindowVerdict({ method: "GET", url: "http://h/px/pixel.png", resourceType: "image", navigation: false }, used), "abort", "a folder no asset was loaded from");
  assert.equal(pa.submitWindowVerdict({ method: "GET", url: "http://h/static/app.css", resourceType: "stylesheet", navigation: false }, used), "allow", "the very address loaded before");
  assert.equal(pa.carriesAnswer("http://h/v1/done/consent/1/sponsorship/yes", want), true);
  assert.equal(pa.carriesAnswer("http://h/thanks?application_id=98765", want), false);
  assert.equal(pa.carriesAnswer("http://h/thanks/i-agree", want), true);
});
