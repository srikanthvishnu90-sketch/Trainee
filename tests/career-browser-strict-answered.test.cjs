"use strict";
// The strict benchmark's answered column (scripts/browser-eval/synth-answers.cjs, strict.cjs --answered): a form whose only stop
// is the employer's own questions is "ready if answered" in the headline and never a pass there; handed a synthetic answer to each
// question, the production runner fills and reads back every one and reaches the instant before Submit. Nothing is sent. Local pages.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, answeredPosting, summarize } = require("../scripts/browser-eval/strict.cjs");
const { synthesize, textAnswer } = require("../scripts/browser-eval/synth-answers.cjs");

test("synthetic answers: the page's first real option, a decline for a demographic question, a box's own kind of word; uploads are never answered", () => {
  const { answers, unanswerable } = synthesize([
    { label: "How did you hear about us?", reason: "no_confirmed_answer", kind: "select", options: ["Select...", "LinkedIn", "Referral", "Other"] },
    { label: "Gender", reason: "eeo_needs_your_choice", kind: "select", options: ["Male", "Female", "Decline to self-identify"] },
    { label: "I agree to the privacy notice", reason: "agreement_needs_you", kind: "checkbox" },
    { label: "LinkedIn Profile", reason: "no_confirmed_answer", kind: "text" },
    { label: "Why do you want to work here?", reason: "no_confirmed_answer", kind: "textarea" },
    { label: "Cover letter", reason: "upload_needs_you", kind: "file" },
    { label: "Country", reason: "no_matching_option", kind: "select", options: ["A"] },
  ]);
  assert.equal(answers["How did you hear about us?"], "LinkedIn");
  assert.equal(answers.Gender, "Decline to self-identify");
  assert.equal(answers["I agree to the privacy notice"], "Yes");
  assert.match(answers["LinkedIn Profile"], /^https:\/\/www\.linkedin\.com\/in\//);
  assert.match(answers["Why do you want to work here?"], /synthetic/);
  assert.deepEqual(unanswerable.map((u) => u.reason), ["upload_needs_you", "no_matching_option"]);
  assert.equal(textAnswer("Years of experience with Python", "text"), "3");
  // An answer already given and asked again is an execution failure, never answered twice.
  assert.deepEqual(synthesize([{ label: "A", reason: "no_confirmed_answer", kind: "text" }], { A: "x" }).unanswerable, [{ label: "A", reason: "answered_still_asked" }]);
});

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const posts = [];
const CUSTOM = `<form action="/submit" method="post">
  <label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label for="src">How did you hear about us? *</label><select id="src" name="src" required><option value="">Select...</option><option>LinkedIn</option><option>Referral</option></select>
  <label for="why">Why do you want to work here? *</label><textarea id="why" name="why" required></textarea>
  <fieldset><legend>Are you over 18? *</legend><label><input type="radio" name="adult" value="yes" required> Yes</label><label><input type="radio" name="adult" value="no"> No</label></fieldset>
  <button type="submit">Submit application</button></form>`;
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("<h1>Thank you</h1>"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/custom") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Apply</title>${CUSTOM}`);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "strict-ans-"))) });

test("the employer's own questions: 'ready if answered' in the headline, reached Submit once answered; nothing posted", { skip }, async () => {
  const o = opts();
  const item = { provider: "greenhouse", url: `${base}/custom` };
  const first = await strictPosting(browser, item, o);
  assert.equal(first.result, "ready_if_answered", JSON.stringify(first));
  const w = await answeredPosting(browser, item, o, first);
  assert.equal(w.result, "pass", JSON.stringify(w));
  assert.equal(w.asked, 3);
  first.answered = w;
  const s = summarize([first]);
  assert.equal(s.all.pass, 0, "the headline never counts the answered column");
  assert.equal(s.all.answered_pass, 1);
  assert.deepEqual(posts, []);
});
