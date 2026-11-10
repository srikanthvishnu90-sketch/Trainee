"use strict";
// Architect rulings on #741 (2026-11-10):
//  - Teamtailor: every job page carries an "Already working at X?" employee sign-in form (action /auto_join, an email box or
//    only a "Log in" button) ahead of the application, which appears only after "Apply for this job". The runner took that
//    sign-in form for the application (the strict bench counted a Submit reached on it as a pass: a FALSE PASS). The runner
//    never treats a sign-in form as the application: it opens the job's Apply control and fills the application; a page whose
//    only form is the sign-in form is a sign-in wall (needs_user / login_required, nothing typed, nothing sent; WO-L). The strict
//    harness refuses a Submit reached on a sign-in form even if a runner ever got there.
//  - Workable: the strict bench answers Workable's resume upload to its S3 bucket inside the browser (never sent), as it does
//    Greenhouse's; a posting that then reaches Submit is ready_except_upload, never a pass.
// Fixtures: the markup of the diag run 42865716555 (aafdinair, approvalmax, askattest, virtasant, bearingpoint). Local only.
//   node --test tests/career-teamtailor-signin.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, strictStop, simulatedUpload } = require("../scripts/browser-eval/strict.cjs");
const { applyOne, payloadHash, NeedsUser } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// The employee sign-in block as Teamtailor draws it: an email box (aafdinair, approvalmax, askattest) or only "Log in"
// (virtasant, bearingpoint), posting to /auto_join, under "Already working at Acme?".
const SIGNIN = (withEmail) => `<section><h2 class="text-center font-company-header text-4xl">Already working at Acme?</h2><p class="text-center text-xl">Let's recruit together and find your next colleague.</p>
<form class="flex items-center justify-between leading-tight text-md" data-turbo="false" action="/en-GB/auto_join" accept-charset="UTF-8" method="post"><input type="hidden" name="authenticity_token" value="TEST">
${withEmail ? '<input value="acme.example" type="hidden" name="domain" id="domain"><input type="hidden" name="email" id="email"><label>@acme.example<input required="required" type="email" autocomplete="off" aria-label="Email address without domain" name="full_email"></label>' : ""}
<button type="submit" class="careersite-button careersite-button--secondary">Log in</button></form></section>`;
// The application, drawn only once "Apply for this job" is pressed (action /applications).
const APPLICATION = `<form id="job-application-form" class="mx-auto max-w-650" novalidate="novalidate" action="/applications" accept-charset="UTF-8" method="post">
<div><label for="candidate_first_name">First name</label><input type="text" id="candidate_first_name" name="candidate[first_name]"></div>
<div><label for="candidate_last_name">Last name</label><input type="text" id="candidate_last_name" name="candidate[last_name]"></div>
<div><label for="candidate_email">Email</label><input type="email" id="candidate_email" name="candidate[email]"></div>
<div><label for="candidate_resume">Resume</label><input type="file" id="candidate_resume" required></div>
<div><input type="checkbox" id="consent" name="candidate[consent_given]"><label for="consent">I agree to the privacy policy (optional)</label></div>
<input type="submit" name="commit" value="Send application"></form>`;
const PAGE = (withEmail, withApply = true) => `<!doctype html><html><head><meta charset="utf-8"><title>TEST Teamtailor job</title></head><body><main><h1>Engineer</h1>
${withApply ? '<button type="button" class="apply">Apply for this job</button>' : ""}<div id="slot"></div>
${withApply ? '<button type="button" class="apply">Apply for this job</button>' : ""}<a href="/connect/login">Candidate Connect login</a></main>${SIGNIN(withEmail)}
<script>for (const b of document.querySelectorAll("button.apply")) b.addEventListener("click", () => { if (!document.getElementById("job-application-form")) document.getElementById("slot").innerHTML = ${JSON.stringify(APPLICATION)}; });</script></body></html>`;

let browser, server, base, resume, rsha;
const posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }
    if (u.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    const page = { "/tt": PAGE(true), "/tt-button": PAGE(false), "/tt-signin-only": PAGE(true, false) }[u.pathname];
    if (page) return res.writeHead(200, { "content-type": "text/html" }).end(page);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-signin-"));
  resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = require("node:crypto").createHash("sha256").update(fs.readFileSync(resume)).digest("hex");
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true }); });

const job = (k) => {
  const p = { id: "tt-" + k, ats: "teamtailor", url: `${base}/${k}`, facts: lib.TEST_FACTS, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
// Drive to the instant before the click and read what the page holds there (the run's own page is the one with its address).
async function toSubmit(k) {
  let at = null;
  const r = await applyOne(browser, job(k), { stepTimeoutMs: 8000, retries: 0, audit: true, onPhase: async (ph, audit, submit) => {
    if (ph !== "submitting") return;
    const pg = browser.contexts().flatMap((c) => c.pages()).find((x) => x.url().endsWith("/" + k));
    at = { audit, submit, page: await pg.evaluate(() => ({ submitIn: (document.querySelector("[data-upmore-submit]") || {}).closest ? (document.querySelector("[data-upmore-submit]").closest("form") || {}).id : null,
      signinEmail: (document.querySelector("input[name=full_email]") || { value: "" }).value })) };
    throw new NeedsUser("dry_run_stopped_before_submit");
  } });
  return { r, at };
}

for (const k of ["tt", "tt-button"]) {
  test(`Teamtailor (${k === "tt" ? "sign-in form with an email box" : "sign-in form with only 'Log in'"}): the application behind 'Apply for this job' is filled and its own Submit is the one reached; the sign-in form is never filled or pressed`, { skip, timeout: 60000 }, async () => {
    const n = posts.length;
    const { r, at } = await toSubmit(k);
    assert.equal(r.reason, "dry_run_stopped_before_submit", JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
    assert.equal(at.page.submitIn, "job-application-form");
    assert.equal(at.submit.signin, false);
    assert.equal(at.page.signinEmail, "", "nothing is typed into the employee sign-in box");
    assert.ok(at.audit.fields.some((f) => f.label === "Email" && f.approved === lib.TEST_FACTS.email));
    assert.ok(at.audit.fields.some((f) => f.kind === "file"));
    assert.equal(posts.length, n, "nothing posted");
  });
}

test("Teamtailor: a page whose only form is the employee sign-in form is a sign-in wall: needs_user / login_required, nothing typed, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  let reached = 0;
  const r = await applyOne(browser, job("tt-signin-only"), { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") reached++; } });
  assert.equal(reached, 0);
  assert.equal(r.status, "needs_user");
  assert.equal(r.reason, "login_required");
  assert.equal(r.wall, "employee_sign_in");
  assert.equal(posts.length, n);
});

test("strict bench: the sign-in-only page is never a pass; a Submit reached on a sign-in form is refused by the harness", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const o = { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "tt-strict-"))) };
  const only = await strictPosting(browser, { provider: "teamtailor", url: `${base}/tt-signin-only` }, o);
  assert.notEqual(only.result, "pass", JSON.stringify({ ...only, diag: undefined }));
  assert.equal(only.reason, "login_required");
  const app = await strictPosting(browser, { provider: "teamtailor", url: `${base}/tt` }, o);
  assert.equal(app.result, "pass", JSON.stringify({ ...app, diag: undefined }));
  assert.equal(posts.length, n);
  // The harness's own stop: a Submit on a sign-in form (were a runner ever to reach one) is refused, never counted.
  await assert.rejects(strictStop()("submitting", undefined, { signin: true, form: "/auto_join" }), (e) => e instanceof NeedsUser && e.reason === "strict_signin_form");
  await assert.rejects(strictStop()("submitting", undefined, { signin: false }), (e) => e.reason === "strict_reached_submit");
  await strictStop()("filling");
});

test("strict bench: Workable's resume upload to its S3 bucket is answered inside the browser (never sent); other hosts and boards are not", () => {
  const req = (url, method = "POST", provider) => ({ url: () => url, method: () => method, headers: () => ({ origin: "https://apply.workable.com" }), postDataBuffer: () => Buffer.from('--x\r\nContent-Disposition: form-data; name="key"\r\n\r\nuploads/abc/${filename}\r\n--x--') });
  const ok = simulatedUpload(req("https://workable-application-form.s3.us-east-1.amazonaws.com/"), "workable");
  assert.ok(ok && ok.status === 204, JSON.stringify(ok));
  assert.equal(simulatedUpload(req("https://workable-application-form.s3.us-east-1.amazonaws.com/", "OPTIONS"), "workable").status, 204);
  assert.equal(simulatedUpload(req("https://workable-application-form.s3.us-east-1.amazonaws.com/"), "lever"), null, "only for Workable's own postings");
  assert.equal(simulatedUpload(req("https://workable-application-form.s3.us-east-1.amazonaws.com/other"), "workable"), null, "only the bucket's upload path");
  assert.equal(simulatedUpload(req("https://evil-application-form.s3.us-east-1.amazonaws.com/"), "workable"), null);
  assert.equal(simulatedUpload(req("https://workable-application-form.s3.us-east-1.amazonaws.com/", "PUT"), "workable"), null);
});
