"use strict";
// Round 7 (review of round 6), on plain data: the submit window as a destination allowlist. Allowed: the approved POST with its exact
// body; that POST's redirects; once its answer is in, the page's own outcome page (an address of plain words and short ids) and that
// page's own subresources; addresses the page loaded before the window, exactly. Everything else is refused, whatever its words.
// A constant is a hidden input of the FILLED form at load (q5), sent with its value at load (q6).
// In Chromium (the reviewer's s11 pages): tests/career-engine-round7-browser.test.cjs.
// Run: node --test tests/career-engine-round7.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pa = require("../workers/career-browser/parallel-apply.cjs");

const want = [["first_name", "Casey"], ["email", "c@x"], ["resume", "file:resume.pdf:30"]];
const st = (o = {}) => ({ action: "http://h/app/submit", method: "POST", want, used: false, answered: false, blocked: [], ats: "greenhouse", hiddenAtLoad: [["job_id", "4802172007"]],
  seen: new Set(["http://h/static/app.css"]), ...o });
const nav = (url, o = {}) => ({ method: "GET", url, resourceType: "document", navigation: true, redirected: false, ...o });
const sub = (url, o = {}) => ({ method: "GET", url, resourceType: "image", navigation: false, ...o });
const answered = () => st({ used: true, answered: true });

test("q1: an outcome address carrying data (a long encoded value) is refused; the page's own plain thank-you page is not", () => {
  const d = Buffer.from(JSON.stringify({ relocate: "anywhere", sponsor: "yes", email: "c@x" })).toString("base64");
  assert.equal(pa.submitWindowVerdict(nav(`http://h/q1/done?d=${d}`), answered()), "abort");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y4/thanks"), answered()), "allow", "y4: no id");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y1/thanks?application_id=98765"), answered()), "allow", "y1: a short id");
  assert.equal(pa.submitWindowVerdict(nav("http://h/q2/a/relocate-anywhere/c%40x"), answered()), "abort", "an answer of the form in the path");
  assert.equal(pa.submitWindowVerdict(nav("http://h/y4/thanks"), st({ used: true })), "abort", "before the approved POST's answer");
  assert.equal(pa.submitWindowVerdict(nav("http://h/consent-manager/continue?to=%2Fy5%2Fthanks", { redirected: true }), st({ used: true })), "allow", "y5: the approved POST's own redirect");
});

test("q3/q4: a subresource is an address loaded before, exactly, or the outcome page's own; a new name in an old folder is refused", () => {
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/app.css", { resourceType: "stylesheet" }), answered()), "allow", "loaded before");
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/Y29uc2VudD0xJnNwb25zb3JzaGlwPXllcw.png"), answered()), "abort", "q4");
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/relocate-anywhere-salary-200k.png"), answered()), "abort", "q3");
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/app.css?v=consent", { resourceType: "stylesheet" }), answered()), "abort", "a new parameter");
  assert.equal(pa.submitWindowVerdict(sub("http://h/img/thanks/ok.png", { frameUrl: "http://h/y7/thanks" }), st({ used: true, answered: true, outcome: "http://h/y7/thanks" })), "allow", "y7: the outcome page's own image");
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/cookie-consent-banner.js", { resourceType: "script", frameUrl: "http://h/y8/thanks" }), st({ used: true, answered: true, outcome: "http://h/y8/thanks" })), "allow", "y8: its own script, whatever its name");
  assert.equal(pa.submitWindowVerdict(sub("http://h/static/x.png", { frameUrl: "http://h/form" }), st({ used: true, answered: true, outcome: "http://h/y8/thanks" })), "abort", "the old page's ping as it leaves");
});

test("q5/q6: a field outside the approval passes only as a hidden input of the filled form at load, with its value at load", () => {
  const post = (body) => ({ method: "POST", url: "http://h/app/submit", resourceType: "fetch", navigation: false, contentType: "application/x-www-form-urlencoded", body });
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&job_id=4802172007"), st()), "allow");
  assert.equal(pa.submitWindowVerdict(post("first_name=Casey&email=c%40x&q_77=relocate-anywhere"), st()), "abort", "q5: a hidden input outside the form is no constant");
  assert.deepEqual(pa.hiddenChangedSinceLoad([["ref_code", "abc"], ["job_id", "1"]], [{ name: "ref_code", type: "hidden", value: "relocate-anywhere", touched: false }, { name: "job_id", type: "hidden", value: "1", touched: false }]), ["ref_code"], "q6");
  assert.deepEqual(pa.hiddenChangedSinceLoad([["authenticity_token", "a"]], [{ name: "authenticity_token", type: "hidden", value: "b", touched: false }]), [], "a token may change");
  assert.deepEqual(pa.hiddenChangedSinceLoad([["cq", ""]], [{ name: "cq", type: "hidden", value: "Yes", touched: true }]), [], "a widget's own field the engine set by answering it");
  assert.deepEqual(pa.hiddenChangedSinceLoad([["resume_name", ""]], [{ name: "resume_name", type: "hidden", value: "resume.pdf", touched: false }], ["resume.pdf"]), [], "an uploader echoing the approved file's name");
});
