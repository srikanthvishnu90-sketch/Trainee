"use strict";
// Round 2 (review of #818), click and fill targeting, on plain data: what the page-side readers (parallel-apply SNAP, ats-fill
// EXTRACT) hand to Node, and the rules that decide from it. A wrong click on an employer's site cannot be undone, so every rule
// here needs positive evidence and refuses otherwise. The same rules in Chromium: tests/career-engine-round2-targeting-browser.test.cjs.
// Run: node --test tests/career-engine-round2-targeting.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pa = require("../workers/career-browser/parallel-apply.cjs");
const af = require("../workers/career-browser/ats-fill.cjs");

const SRC = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");
const field = (type, hint) => ({ type, hint });
const F = [field("text", "First Name first_name"), field("text", "Last Name last_name"), field("email", "Email email"), field("file", "Resume resume")];
const b = (c, text, o = {}) => ({ c, form: 0, inside: true, vis: true, text, aria: "", blob: text, tag: "BUTTON", type: "", signin: false, disabled: false, link: false, ...o });
const page = (controls, o = {}) => ({ forms: [{ signin: false, hasControl: true, fields: o.fields || F, head: o.head || "", labels: o.labels || "", action: o.action || "/apply", password: !!o.password }], controls, loose: [], otherFrameForms: 0, ...(o.snap || {}) });

test("1: a control is the Submit only by its own words: the list, never the deny words, never \"the only button\"", () => {
  for (const w of ["Submit", "Submit application", "Submit my application", "Apply", "Apply now", "Send application", "Send", "Complete application", "Finish", "Finish application", "  SUBMIT APPLICATION ", "Bewerbung absenden", "Wyślij", "Enviar"])
    assert.equal(pa.controlLabel(b(0, w)), "yes", w);
  for (const w of ["Save for later", "Withdraw application", "Apply with LinkedIn", "Delete my data", "Next", "Create account", "Save draft", "Cancel", "Sign in", "Log in", "Register", "Subscribe", "Easy Apply", "Refer a friend",
    "Share", "Back", "Previous", "Reset", "Clear", "Upload", "Submit and create account", "Submit & subscribe", "Send message", "Join", "Request a demo", "Search", "Go", "Continue", "Sign in with Google", "", "Apply via Indeed"])
    assert.notEqual(pa.controlLabel(b(0, w)), "yes", w);
  // The only native button of the form, in none of the Submit words: never pressed (the review's t12a to t12f).
  for (const w of ["Save for later", "Withdraw application", "Apply with LinkedIn", "Delete my data", "Next", "Create account"]) {
    const r = pa.pickControls(page([b(0, w), b(1, "Submit application", { tag: "DIV", vis: false })]));
    assert.equal(r.submit, null, w);
  }
  // The accessible name and the visible words must not disagree.
  assert.equal(pa.controlLabel(b(0, "Save draft", { aria: "Submit application" })), "conflict");
  assert.equal(pa.controlLabel(b(0, "Submit", { aria: "Delete application" })), "conflict");
  assert.equal(pa.controlLabel(b(0, "", { aria: "Submit application" })), "conflict", "no visible words behind an accessible name");
  assert.equal(pa.controlLabel(b(0, "Submit", { aria: "Submit application" })), "yes", "both on the list");
  assert.equal(pa.controlLabel(b(0, "Submit application", { disabled: true })), "no");
  assert.equal(pa.pickControls(page([b(0, "Save draft", { type: "button", aria: "Submit application" }), b(1, "Submit", { type: "submit", aria: "Delete application" })])).refuse, "ambiguous_submit");
  // Two controls in the Submit words: ambiguous, unless exactly one is the form's declared Submit and it is the last of them.
  assert.equal(pa.pickControls(page([b(0, "Apply", { type: "submit" }), b(1, "Submit", { type: "submit" })])).refuse, "ambiguous_submit");
  assert.equal(pa.pickControls(page([b(0, "Submit", { type: "submit" }), b(1, "Apply", { type: "button" })])).refuse, "ambiguous_submit");
  assert.deepEqual(pa.pickControls(page([b(0, "Apply", { type: "button" }), b(1, "Submit application", { type: "submit" })])), { form: 0, submit: 1, next: null, refuse: null });
  assert.deepEqual(pa.pickControls(page([b(0, "Save for later"), b(1, "Submit application", { type: "submit" })])), { form: 0, submit: 1, next: null, refuse: null });
  // Continue is step navigation only: with the form's Submit drawn and hidden, and never when its words are denied.
  assert.equal(pa.pickControls(page([b(0, "Continue", { type: "button" }), b(1, "Submit application", { type: "submit", vis: false })])).next, 0);
  assert.equal(pa.pickControls(page([b(0, "Continue", { type: "button", aria: "Continue with LinkedIn", blob: "Continue with LinkedIn" }), b(1, "Submit application", { type: "submit", vis: false })])).next, null);
});

test("2: LinkedIn and Indeed are never pressed, as a Submit or as an opener, whatever names them", () => {
  for (const blob of ["Apply https://www.linkedin.com/oauth/apply", "Apply data-provider=indeed", "Apply in", "Apply lnkd.in/x", "Apply INDEED apply"].filter((x) => /linkedin|lnkd|indeed/i.test(x)))
    assert.equal(pa.controlLabel(b(0, "Apply", { blob })), "no", blob);
  assert.notEqual(pa.controlLabel(b(0, "Apply", { aria: "Apply with LinkedIn", blob: "Apply Apply with LinkedIn" })), "yes");
  // Outside an application form: not the form's Submit, and not an opener.
  const out = pa.pickControls(page([b(0, "Apply", { form: -1, inside: false, follows: true, gap: 0, aria: "Apply with LinkedIn", blob: "Apply with LinkedIn" })], { fields: F.slice(0, 3) }));
  assert.deepEqual([out.submit, out.refuse, !!out.opener], [null, "submit_not_tied_to_form", false]);
  const link = pa.pickControls(page([b(0, "Apply", { form: -1, inside: false, tag: "A", link: true, blob: "Apply https://www.indeed.com/applystart" })], { fields: F.slice(0, 3) }));
  assert.deepEqual([link.submit, !!link.opener], [null, false]);
  // The opener (openApply) filters the same way before it clicks anything.
  const open = SRC.slice(SRC.indexOf("async function openApply("), SRC.indexOf("function CHECK_IN_FORM"));
  assert.match(open, /const li = \(e\) => \/linkedin\|lnkd\\\.in\|indeed\/i\.test\(/);
  assert.equal((open.match(/!li\(e\)/g) || []).length, 2, "both the declared-action control and the worded controls");
  // A button beside an application form that is already on the page is never "opened".
  assert.equal(pa.pickControls(page([b(0, "Apply", { form: -1, inside: false, follows: false, gap: 0 })], { fields: F.slice(0, 3) })).opener, false);
});

test("3: a form gets the person's data only on positive evidence that it is the application, and never against contrary evidence", () => {
  const sub = [b(0, "Submit application", { type: "submit" })];
  assert.equal(pa.isApplicationForm({ fields: F }), true, "a resume upload");
  assert.equal(pa.isApplicationForm({ fields: [field("text", "Full name name"), field("email", "Email"), field("tel", "Phone phone")] }), true, "name, email and a phone question");
  assert.equal(pa.isApplicationForm({ fields: [field("text", "Name name"), field("email", "Email"), field("textarea", "Cover letter cover")] }), true);
  assert.equal(pa.isApplicationForm({ fields: [field("text", "First Name"), field("email", "Email")] }), false, "name and email alone, with no Submit of its own in the list");
  assert.equal(pa.isApplicationForm({ fields: [field("text", "Keyword q"), field("text", "Location loc")] }), false, "no name, no email");
  const contrary = {
    "a password box": { password: true }, "Contact us": { head: "Contact us | Send message" }, "Request a demo": { head: "Talk to sales | Request a demo" }, "newsletter": { head: "Subscribe to our newsletter" },
    "talent community": { head: "Join our talent community | Join" }, "job alerts": { head: "Get job alerts" }, "search": { head: "Find jobs" }, "sign in": { head: "Sign in" }, "login address": { action: "/login" },
    "returning candidate": { head: "Returning candidate | Continue" }, "refer a friend": { head: "Refer a friend | Send" }, "feedback": { head: "Was this page helpful? | Submit" }, "a search placeholder": { labels: "Search jobs" },
  };
  for (const [why, o] of Object.entries(contrary)) {
    assert.equal(pa.isApplicationForm({ fields: F, ...o }, 2), false, why);
    const r = pa.pickControls(page(sub, o));
    assert.deepEqual([r.form, r.submit], [null, null], `${why}: nothing marked to fill, nothing to press`);
  }
  // The review's forms: each has a name and an email, none is the application.
  const others = [["Send message", "Contact us"], ["Request a demo", "Talk to sales"], ["Join", "Join our talent community"], ["Continue", "Returning candidate"], ["Send", "Refer a friend"], ["Find jobs", ""]];
  for (const [btn, head] of others) {
    const r = pa.pickControls(page([b(0, btn, { type: "submit" })], { fields: [field("text", "First Name first"), field("text", "Last Name last"), field("email", "Email email")], head: `${head} | ${btn}` }));
    assert.deepEqual([r.form, r.submit], [null, null], btn);
  }
  // The application lives in a frame of the page: no form of the parent page is filled.
  const framed = pa.pickControls(page([b(0, "Send", { type: "submit" })], { fields: [field("text", "First Name"), field("email", "Email"), field("textarea", "Message")], snap: { frameApp: true } }));
  assert.deepEqual([framed.form, framed.submit, framed.refuse], [null, null, "application_in_frame"]);
  // The honest form still is one.
  assert.deepEqual(pa.pickControls(page(sub)), { form: 0, submit: 0, next: null, refuse: null });
});

test("4: a box a person cannot see is never typed into", () => {
  const seen = (o = {}) => ({ w: 200, h: 24, left: 10, right: 210, bottom: 300, pageW: 900, hidden: false, clipped: false, tabNeg: false, labelSeen: true, name: "first_name", widget: false, ...o });
  const q = (o, kind = "text") => ({ kind, label: "x", seen: seen(o) });
  assert.equal(af.isHoneypot(q()), false, "an ordinary box");
  const traps = { "off the page to the left": { left: -9999, right: -9799 }, "off the page above": { bottom: -50 }, "no size": { w: 0, h: 0 }, "a hidden, transparent or aria-hidden parent": { hidden: true },
    "clipped to nothing": { clipped: true }, "past the page's right edge": { left: 5000, right: 5200 }, "a trap's name with no visible label": { name: "website", labelSeen: false }, "honeypot by name": { name: "hp_field", labelSeen: false } };
  for (const [why, o] of Object.entries(traps)) { assert.equal(af.isHoneypot(q(o)), true, why); assert.equal(af.isHoneypot(q(o, "textarea")), true, why); }
  assert.equal(af.isHoneypot(q({ name: "website" })), false, "a Website question a person can see is a question");
  assert.equal(af.isHoneypot(q({ hidden: true, widget: true })), false, "a drawn widget's own input is the widget's");
  assert.equal(af.isHoneypot(q({ hidden: true }, "radio")), false, "a native radio under a drawn one is still the person's choice");
  assert.equal(af.isHoneypot({ kind: "text", label: "x" }), false);
  const fill = fs.readFileSync(path.join(__dirname, "../workers/career-browser/ats-fill.cjs"), "utf8");
  assert.ok(fill.indexOf("if (isHoneypot(d))") > 0 && fill.indexOf("if (isHoneypot(d))") < fill.indexOf("const dec = decide(d, ctx);"), "skipped before anything is decided or typed");
});

test("8: a challenge asked as a question is the check; a late widget is waited for before every Continue and Submit", () => {
  for (const l of ["Enter the characters shown in the image", "Captcha", "Type the text you see in the picture", "Prove you are human", "I'm not a robot"]) assert.match(l, pa.CAPTCHA_QUESTION, l);
  for (const l of ["Why do you want this job?", "First Name", "Describe your character"]) assert.doesNotMatch(l, pa.CAPTCHA_QUESTION, l);
  const gate = SRC.slice(SRC.indexOf("const gate = async (phase"), SRC.indexOf("let filledSoFar"));
  assert.ok(gate.indexOf('if (phase !== "enter" && settleMs > 0) await settled();') > 0 && gate.indexOf("await settled()") < gate.indexOf("await botCheck(page)"), "the page settles, then the check is read");
  assert.match(SRC, /fr\.needsUser = fr\.needsUser\.filter\(\(n\) => !CAPTCHA_QUESTION\.test\(n\.label \|\| ""\)\);/);
  for (const provider of ["frc-captcha", "enforcement-frame", "geetest", "px-captcha", "awswaf-captcha", "datadome", "arkoselabs", "mtcaptcha"]) assert.ok(SRC.includes(provider), provider);
});
