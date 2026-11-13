"use strict";
// Round 4 (review of round 3), on plain data: the pressed control's own target and its own name/value; Greenhouse's structural
// hidden fields; the network guard of the submit window (what may leave the browser between the click and the outcome); a Review
// step. In Chromium: tests/career-engine-round4-browser.test.cjs.
// Run: node --test tests/career-engine-round4.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const pa = require("../workers/career-browser/parallel-apply.cjs");

test("1: the control pressed must send to the approved form's own address, by its method", () => {
  const t = (o) => pa.submitTargetRefusal({ action: "http://h/app/submit", method: "post", formAction: "http://h/app/submit", formMethod: "post", ...o });
  assert.equal(t({}), null);
  assert.equal(t({ action: "http://h/app/delete" }), "submit_target_mismatch", "a formaction elsewhere");
  assert.equal(t({ method: "get" }), "submit_target_mismatch", "a formmethod other than the form's");
  assert.equal(t({ action: "http://h/app/submit#x" }), null, "a fragment is the same address");
});

test("1: the pressed control's own name and value are part of what is sent: a marketing or consent value is an answer", () => {
  assert.deepEqual(pa.submitterControl({ name: "intent", value: "apply_and_subscribe_marketing", text: "Submit" }), { name: "intent", label: "Submit (the button pressed)", type: "submit", option: null, value: "apply_and_subscribe_marketing", q: null, touched: false, hidden: false, answer: true, disabled: false });
  assert.equal(pa.submitterControl({ name: "commit", value: "Submit application", text: "Submit application" }).answer, false);
  assert.equal(pa.submitterControl({ name: "", value: "", text: "Submit" }), null);
});

test("2: Greenhouse's question ids, priorities and attribution fields are page data: never asked, shown and hashed", () => {
  for (const [n, v] of [["job_application[answers_attributes][0][question_id]", "12345678"], ["job_application[answers_attributes][0][priority]", "0"], ["utm_source", "Company Careers Page"], ["source", "Job board listing feed"],
    ["referrer", "https://example.test/x"], ["gh_src", "abc12"], ["position", "3"], ["sort_order", "1"]]) {
    assert.equal(pa.isStructuralHidden(n, v), true, `${n}=${v}`); assert.equal(pa.hiddenIsAnswer(n, false, v), false, `${n}=${v}`);
  }
  for (const [n, v] of [["q_55", "Yes"], ["consent_given", "true"], ["job_application[answers_attributes][0][text_value]", "I agree"], ["utm_consent", "yes"]]) assert.equal(pa.isStructuralHidden(n, v), false, `${n}=${v}`);
});

test("3: the submit window lets out exactly one request: the approved form, to its address, by its method, with exactly its fields", () => {
  const want = [["first_name", "Casey"], ["email", "c@x"], ["resume", "file:resume.pdf:14"], ["authenticity_token", "t"]];
  const st = () => ({ action: "http://h/app/submit", method: "POST", want, used: false, blocked: [] });
  const req = (o) => ({ method: "POST", url: "http://h/app/submit", resourceType: "document", navigation: true, contentType: "application/x-www-form-urlencoded", body: "first_name=Casey&email=c%40x&authenticity_token=t2", ...o });
  const s = st();
  assert.equal(pa.submitWindowVerdict(req({}), s), "allow", "the approved form (a token's value may differ)");
  assert.equal(s.used, true);
  assert.equal(pa.submitWindowVerdict(req({}), s), "abort", "only once");
  const mp = `--B\r\nContent-Disposition: form-data; name="first_name"\r\n\r\nCasey\r\n--B\r\nContent-Disposition: form-data; name="resume"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n\r\n--B--\r\n`;
  assert.equal(pa.submitWindowVerdict(req({ contentType: "multipart/form-data; boundary=B", body: mp }), st()), "allow", "multipart, the upload by its file's name");
  const abort = {
    "a field added": req({ body: "first_name=Casey&email=c%40x&consent=1" }),
    "a value changed": req({ body: "first_name=Casey&email=other%40x" }),
    "another file": req({ contentType: "multipart/form-data; boundary=B", body: mp.replace("resume.pdf\"", "other.pdf\"") }),
    "JSON with a key the form does not have": req({ contentType: "application/json", navigation: false, resourceType: "fetch", body: JSON.stringify({ first_name: "Casey", q_7: "yes" }) }),
    "JSON with a nested consent": req({ contentType: "text/plain", navigation: false, resourceType: "fetch", body: JSON.stringify({ email: "c@x", extra: { consent: true } }) }),
    "another address": req({ url: "http://h/app/other" }),
    "another method": req({ method: "PUT" }),
    "the page's own request to its API with one more field": req({ url: "http://h/api/apply", navigation: false, resourceType: "fetch", body: "first_name=Casey&email=c%40x&consent=1" }),
    "a beacon": req({ url: "http://h/x6/beacon", resourceType: "ping", navigation: false }),
    "a ping with parameters": { method: "GET", url: "http://h/px?sponsorship=yes", resourceType: "image", navigation: false, body: null },
    "an XHR with parameters": { method: "GET", url: "http://h/api/track?email=c%40x", resourceType: "xhr", navigation: false, body: null },
    "a frame's form": req({ url: "http://h/x8/side", resourceType: "document", body: "consent=1" }),
  };
  for (const [why, r] of Object.entries(abort)) assert.equal(pa.submitWindowVerdict(r, st()), "abort", why);
  // Round 5 (architect amendment, stricter): an asset is allowed only by an address or folder the page loaded before the window;
  // the same requests with no record of earlier loads are refused, and allowed once the page had loaded from there.
  const assets = [{ method: "GET", url: "http://h/app.css", resourceType: "stylesheet", navigation: false }, { method: "GET", url: "http://h/logo.png", resourceType: "image", navigation: false }];
  for (const r of assets) assert.equal(pa.submitWindowVerdict(r, st()), "abort", `${r.url} with no earlier load`);
  for (const r of assets) assert.equal(pa.submitWindowVerdict(r, { ...st(), assets: new Set(["http://h/"]) }), "allow", `${r.url} under a folder loaded before`);
  // A navigation with parameters is the approved post's own redirect only once that post has gone; before it, it is refused (n2).
  const thanks = { method: "GET", url: "http://h/app/thanks?ref=1", resourceType: "document", navigation: true };
  assert.equal(pa.submitWindowVerdict(thanks, st()), "abort", "a GET navigation with parameters before the approved post");
  assert.equal(pa.submitWindowVerdict({ ...thanks, redirected: true }, { ...st(), used: true }), "allow", "the approved post's own redirect");
  // Round 6 (architect amendment): and, once the approved POST has been answered, the page's own outcome page on its own origin with
  // parameters that carry no answer (y1).
  assert.equal(pa.submitWindowVerdict(thanks, { ...st(), used: true }), "abort", "the approved post sent, its answer not yet in");
  assert.equal(pa.submitWindowVerdict(thanks, { ...st(), used: true, answered: true }), "allow", "the outcome page after the approved post's answer");
  assert.equal(pa.submitWindowVerdict(req({ contentType: "application/json", navigation: false, resourceType: "fetch", body: JSON.stringify({ first_name: "Casey", email: "c@x" }) }), st()), "allow", "the same answers as JSON");
  // Round 5 (architect amendment, stricter, n7): a JSON body's keys must be the form's own names or that board's own schema (Breezy:
  // name, email, phone, resume); a key outside both (here "mail": not Breezy's schema) is refused even when its value is one of the
  // form's. This drops the round-4 allowed case of an API with its own key names: only a known board schema is accepted.
  const api = (body, ats) => pa.submitWindowVerdict(req({ url: "http://h/api/apply", contentType: "text/plain", navigation: false, resourceType: "fetch", body: JSON.stringify(body) }), { ...st(), ats });
  assert.equal(api({ name: "Casey", email: "c@x", resume: "resume.pdf" }, "breezy"), "allow", "a board's own API, its own schema, the form's values");
  assert.equal(api({ name: "Casey", mail: "c@x", resume: "resume.pdf" }, "breezy"), "abort", "a key outside the form's names and the board's schema");
});

test("4: a Review step is a step: pressed like Continue when the form's Submit is drawn and hidden", () => {
  const field = (type, hint) => ({ type, hint });
  const F = [field("text", "First Name first_name"), field("email", "Email email"), field("file", "Resume resume")];
  const b = (c, text, o = {}) => ({ c, form: 0, inside: true, vis: true, text, aria: "", blob: text, tag: "BUTTON", type: "button", signin: false, disabled: false, ...o });
  const snap = (controls) => ({ forms: [{ signin: false, hasControl: true, fields: F, head: "", labels: "", action: "/a", password: false }], controls, loose: [], otherFrameForms: 0 });
  assert.equal(pa.pickControls(snap([b(0, "Review"), b(1, "Submit application", { type: "submit", vis: false })])).next, 0);
  assert.equal(pa.pickControls(snap([b(0, "Review application"), b(1, "Submit application", { type: "submit", vis: false })])).next, 0);
  assert.equal(pa.controlLabel({ text: "", aria: "Submit application form", icon: true, tag: "BUTTON", type: "", blob: "" }), "yes", "an icon button with no type named 'Submit application form'");
});
