"use strict";
// Round 5 (review of round 4), the submit window's network guard on plain data: navigations with parameters, assets the page had not
// loaded, JSON under keys the form does not have, the bytes of an upload, and board constants. In Chromium (a logging server, a
// WebSocket, a cross-origin frame): tests/career-engine-round5-browser.test.cjs.
// Run: node --test tests/career-engine-round5.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const pa = require("../workers/career-browser/parallel-apply.cjs");

const RESUME = "%PDF-1.4 the approved resume\n", RSHA = crypto.createHash("sha256").update(Buffer.from(RESUME, "latin1")).digest("hex");
const want = [["first_name", "Casey"], ["last_name", "Example"], ["email", "c@x"], ["licence", "Yes"], ["resume", "file:resume.pdf:30"]];
const st = (o = {}) => ({ action: "http://h/app/submit", method: "POST", want, used: false, blocked: [], ats: "greenhouse", resumeSha: RSHA,
  assets: new Set(["http://h/static/", "http://h/img/"]), constants: `<script>fetch('/h2/api/v1/jobs/AB12CD34/apply'); var d='apply.example.test', src='job_board';</script>`, ...o });
const nav = (url, o = {}) => ({ method: "GET", url, resourceType: "document", navigation: true, redirected: false, ...o });
const get = (url, resourceType) => ({ method: "GET", url, resourceType, navigation: false });
const post = (body, o = {}) => ({ method: "POST", url: "http://h/app/submit", resourceType: "fetch", navigation: false, contentType: "application/json", body: JSON.stringify(body), ...o });

test("n2: a navigation with parameters is the approved POST's own redirect, or it is aborted", () => {
  assert.equal(pa.submitWindowVerdict(nav("http://h/app/submit?email=c%40x&consent=1"), st()), "abort", "the page's script sends answers in an address");
  const used = st({ used: true });
  assert.equal(pa.submitWindowVerdict(nav("http://h/app/a?step=1&ref=apply", { redirected: true }), used), "allow", "the board's redirect after the approved POST");
  assert.equal(pa.submitWindowVerdict(nav("http://h/app/a?step=1", { redirected: true }), st()), "abort", "a redirect before any approved POST");
  assert.equal(pa.submitWindowVerdict(nav("http://h/thanks"), used), "allow", "a navigation with no parameters");
});

test("n3, n16-n19: during the window only assets the page already loaded from, by an asset's own address, may be fetched", () => {
  for (const [u, t] of [["http://h/static/app.css", "stylesheet"], ["http://h/img/logo.png", "image"], ["http://h/static/fonts/x.woff2", "font"]]) assert.equal(pa.submitWindowVerdict(get(u, t), st()), "allow", u);
  for (const [u, t, why] of [["http://h/px/consent/1/sponsorship/yes/c%40x", "image", "answers in a ping's path"], ["http://h/jsonp?consent=1", "script", "a script with parameters"], ["http://h/css?consent=1", "stylesheet", "a stylesheet with parameters"],
    ["http://h/bg?consent=1", "image", "a background with parameters"], ["http://h/prefetch?consent=1", "other", "a prefetch"], ["http://h/collect?consent=1", "xhr", "an XHR with parameters"], ["http://h/static2/x.png", "image", "a folder the page never loaded from"],
    ["http://evil.test/img/logo.png", "image", "another host"], ["http://h/img/c%40x.png", "image", "an image named after an answer"], ["http://h/api/status", "fetch", "a fetch that is no asset"]])
    assert.equal(pa.submitWindowVerdict(get(u, t), st()), "abort", why);
});

test("n7, h2: a JSON body's keys must be the form's own names or the board's own schema; a constant must have been on the page before the fill", () => {
  assert.equal(pa.submitWindowVerdict(post({ candidate: { email: "c@x", first: "Casey" }, answers: { q_77: "Yes", q_78: "Casey" } }), st()), "abort", "answers under innocuous keys reusing form values");
  assert.equal(pa.submitWindowVerdict(post({ first_name: "Casey", email: "c@x", licence: "Yes" }), st()), "allow", "the form's own names");
  assert.equal(pa.submitWindowVerdict(post({ candidate: { firstname: "Casey", lastname: "Example", email: "c@x" }, job_shortcode: "AB12CD34", domain: "apply.example.test", answers: [] }, { url: "http://h/h2/api/v1/jobs/AB12CD34/apply" }), st({ ats: "workable" })), "allow", "Workable: its schema, two constants of the page");
  assert.equal(pa.submitWindowVerdict(post({ candidate: { firstname: "Casey", email: "c@x" }, job_shortcode: "ZZ99ZZ99" }), st({ ats: "workable" })), "abort", "a 'constant' the page never had");
  assert.equal(pa.submitWindowVerdict(post({ name: "Casey", email: "c@x", phone: "", resume: "resume.pdf" }), st({ ats: "breezy" })), "allow", "Breezy: its own schema");
  assert.equal(pa.submitWindowVerdict(post({ name: "Casey", email: "c@x", note: "Yes" }), st({ ats: "breezy" })), "abort", "a key outside the schema");
  assert.equal(pa.submitWindowVerdict(post({ first_name: "Casey", flag: "yes" }), st()), "abort", "a yes under a key the form does not have is never a constant");
});

test("h4: a form post with one extra field the page itself carried before the fill is allowed; a consent is not", () => {
  const mp = (extra) => `--B\r\nContent-Disposition: form-data; name="first_name"\r\n\r\nCasey\r\n--B\r\nContent-Disposition: form-data; name="email"\r\n\r\nc@x\r\n${extra}--B--\r\n`;
  const part = (n, v) => `--B\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const r = (body) => ({ method: "POST", url: "http://h/app/submit", resourceType: "fetch", navigation: false, contentType: "multipart/form-data; boundary=B", body });
  assert.equal(pa.submitWindowVerdict(r(mp(part("job_application[source]", "job_board"))), st()), "allow");
  assert.equal(pa.submitWindowVerdict(r(mp(part("consent", "1"))), st()), "abort");
  assert.equal(pa.submitWindowVerdict(r(mp(part("ref", "ZZZZ"))), st()), "abort", "not on the page before");
});

test("n6: an upload's bytes, when the request carries them, must be the approved resume's", () => {
  const file = (name, bytes) => `--B\r\nContent-Disposition: form-data; name="resume"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n${bytes}\r\n--B--\r\n`;
  const r = (body) => ({ method: "POST", url: "http://h/app/submit", resourceType: "document", navigation: true, contentType: "multipart/form-data; boundary=B", body });
  assert.equal(pa.submitWindowVerdict(r(file("resume.pdf", "")), st()), "allow", "a disk file the browser does not hand over (the engine attached the resume, hashed before)");
  assert.equal(pa.submitWindowVerdict(r(file("resume.pdf", RESUME)), st()), "allow", "the approved bytes");
  assert.equal(pa.submitWindowVerdict(r(file("resume.pdf", "NOT THE APPROVED RESUME, A DIFFERENT FILE")), st()), "abort", "another file under the same name");
});
