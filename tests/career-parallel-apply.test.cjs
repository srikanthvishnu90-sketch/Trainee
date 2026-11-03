"use strict";
// The deterministic browser apply worker (workers/career-browser/parallel-apply.cjs) against the LOCAL mock Greenhouse and
// Lever forms (tests/fixtures/mock-ats-server.cjs). Nothing leaves 127.0.0.1; no model calls.
//   node --test tests/career-parallel-apply.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAts } = require("./fixtures/mock-ats-server.cjs");
const http = require("node:http");
const { applyOne, runPool, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try { pw = require(id); break; } catch { /* next */ }
}
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let mock, browser, resume, rsha;
const facts = { first_name: "Test", last_name: "Person", email: "test.person@example.invalid", phone: "555-0100" };
const answers = { "Are you legally authorized to work in the United States?": "Yes", "Will you now or in the future require sponsorship for employment visa status?": "No" };
const mk = (ats, job, over = {}) => {
  const p = { id: `${ats}-${job}`, ats, url: `${mock.base}/${ats}/${job}`, facts, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha }, ...over };
  p.approval = { approval_id: `appr-${p.id}`, hash: payloadHash(p) };
  return p;
};

before(async () => {
  if (skip) return;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-")), "test-person-resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\n% TEST resume\n");
  rsha = sha256(fs.readFileSync(resume));
  mock = await startMockAts();
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => { if (browser) await browser.close(); if (mock) await mock.close(); });

test("fills and submits a Greenhouse-style and a Lever-style form with only the approved facts and the one resume", { skip }, async () => {
  const gh = await applyOne(browser, mk("greenhouse", "t1"));
  const lv = await applyOne(browser, mk("lever", "t1"));
  assert.equal(gh.status, "submitted_page_confirmed");
  assert.equal(lv.status, "submitted_page_confirmed");
  const [g, l] = [mock.submissions.find((s) => s.ats === "greenhouse" && s.job === "t1"), mock.submissions.find((s) => s.ats === "lever" && s.job === "t1")];
  assert.equal(g.fields.first_name, "Test");
  assert.equal(g.fields.question_auth, "Yes");
  assert.equal(g.fields.question_linkedin, "", "a fact the person never gave is left blank, not invented");
  assert.equal(l.fields.name, "Test Person");
  assert.equal(g.files.resume.sha256, rsha);
  assert.equal(l.files.resume.sha256, rsha);
});

test("a required question with no confirmed answer stops the run, names the field and submits nothing", { skip }, async () => {
  const p = mk("greenhouse", "t2", { answers: {} });
  p.approval = { approval_id: `appr-${p.id}`, hash: payloadHash(p) };
  const r = await applyOne(browser, p);
  assert.equal(r.status, "not_submitted");
  assert.equal(r.reason, "missing_required_answer");
  assert.match(r.field, /authorized to work/);
  assert.equal(mock.submissions.some((s) => s.job === "t2"), false);
});

test("a changed payload, a different resume, an unapproved host and a bot check are all refused or handed back", { skip }, async () => {
  const tampered = mk("lever", "t3");
  tampered.facts = { ...facts, email: "someone.else@example.invalid" };
  assert.equal((await applyOne(browser, tampered)).reason, "not_approved");
  const other = path.join(path.dirname(resume), "other.pdf");
  fs.writeFileSync(other, "%PDF-1.4\n% a different resume\n");
  const wrongResume = mk("lever", "t4", { resume: { path: other, sha256: rsha, preparedWithSha256: rsha } });
  assert.equal((await applyOne(browser, wrongResume)).reason, "resume_mismatch");
  const real = mk("lever", "t5", { url: "https://jobs.lever.co/example/abc/apply" });
  assert.equal((await applyOne(browser, real)).reason, "host_not_allowed");
  const bot = await applyOne(browser, mk("greenhouse", "bot1"));
  assert.equal(bot.status, "needs_user");
  assert.equal(bot.reason, "bot_check");
  assert.equal(mock.submissions.some((s) => ["t3", "t4", "t5", "bot1"].includes(s.job)), false);
});

test("a transient page failure before submit is retried; a dead page is not_submitted after the retries", { skip }, async () => {
  const r = await applyOne(browser, mk("greenhouse", "flaky-t6"), { backoffMs: 10 });
  assert.equal(r.status, "submitted_page_confirmed");
  assert.equal(r.attempts, 2);
  const dead = await applyOne(browser, mk("greenhouse", "t7", { url: `${mock.base}/nowhere/t7` }), { retries: 1, backoffMs: 10 });
  assert.equal(dead.status, "not_submitted");
  assert.equal(dead.attempts, 2);
  assert.equal(dead.reason, "retries_exhausted");
});

test("five at once: all confirmed, each posting submitted exactly once, concurrency capped", { skip }, async () => {
  const payloads = ["greenhouse", "lever", "greenhouse", "lever", "greenhouse", "lever", "greenhouse"].map((a, i) => mk(a, `p${i}`));
  const { results } = await runPool(browser, payloads, { concurrency: 5 });
  assert.deepEqual(results.map((r) => r.status), payloads.map(() => "submitted_page_confirmed"));
  for (const p of payloads) assert.equal(mock.submissions.filter((s) => s.ats === p.ats && s.job === p.id.split("-")[1]).length, 1);
});

test("a second run of an already-submitted posting is never counted as success", { skip }, async () => {
  const r = await applyOne(browser, mk("greenhouse", "t1"));
  assert.notEqual(r.status, "submitted_page_confirmed");
  assert.equal(mock.submissions.filter((s) => s.job === "t1" && s.ats === "greenhouse").length, 1);
});

// --- hardening (PR #262 review): bot check anywhere, hard denylist, redirect + form-action validation, real approval ---
const listen = (host) => new Promise((resolve) => {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>should never be reached</h1>"); });
  server.on("error", () => resolve(null));
  server.listen(0, host, () => resolve({ hits, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
});
const noBrowser = { newContext() { throw new Error("a browser context was opened: the run was not refused before navigation"); } };
const bare = (url, over = {}) => { const p = { id: "x", ats: "greenhouse", url, facts, answers: {}, resume: { path: "/nonexistent", sha256: "0".repeat(64), preparedWithSha256: "0".repeat(64) }, ...over }; p.approval = { approval_id: "a1", hash: payloadHash(p) }; return p; };

test("a bot check inside a REAL form (recaptcha, hcaptcha, turnstile, text, iframe) is handed back: nothing filled, nothing submitted", { skip }, async () => {
  for (const kind of ["recaptcha", "hcaptcha", "turnstile", "text", "iframe"]) {
    const r = await applyOne(browser, mk("greenhouse", `captchaform-${kind}`));
    assert.equal(r.status, "needs_user", kind);
    assert.equal(r.reason, "bot_check", kind);
    assert.equal(r.filled, undefined, `${kind}: nothing was filled`);
  }
  assert.equal(mock.submissions.some((s) => s.job.startsWith("captchaform")), false);
});

test("linkedin.com, indeed.com, joinhandshake.com and their subdomains are refused before any navigation, even when allow-listed", async () => {
  const urls = ["https://www.linkedin.com/jobs/view/1", "https://linkedin.com/jobs/1", "https://jobs.linkedin.com/x", "https://www.indeed.com/viewjob?jk=1", "https://boards.indeed.com/a",
    "https://app.joinhandshake.com/jobs/1", "https://joinhandshake.com/", "https://WWW.LinkedIn.com./jobs/1"];
  for (const u of urls) {
    const host = new URL(u).hostname.replace(/\.$/, "");
    const r = await applyOne(noBrowser, bare(u), { allowHosts: [host, new URL(u).hostname] });
    assert.equal(r.status, "not_submitted", u);
    assert.equal(r.reason, "host_denied", u);
  }
  // look-alikes are not on the denylist (they are simply not allowed hosts, a different refusal)
  for (const u of ["https://notlinkedin.com/x", "https://linkedin.com.evil.example/x", "https://indeed.com.example/x"]) {
    assert.equal((await applyOne(noBrowser, bare(u))).reason, "host_not_allowed", u);
  }
});

test("a redirect to a host that is not allowed is refused before it is requested; a redirect within allowed hosts still works", { skip }, async (t) => {
  const far = await listen("127.0.0.2");
  if (!far) return t.skip("cannot bind 127.0.0.2");
  try {
    const out = await applyOne(browser, mk("greenhouse", "redir-out", { url: `${mock.base}/greenhouse/redir-out?to=${encodeURIComponent(`http://127.0.0.2:${far.port}/greenhouse/z`)}` }), { retries: 0 });
    assert.equal(out.status, "not_submitted");
    assert.equal(out.reason, "redirect_not_allowed");
    const li = await applyOne(browser, mk("greenhouse", "redir-li", { url: `${mock.base}/greenhouse/redir-li?to=${encodeURIComponent("https://www.linkedin.com/jobs/view/1")}` }), { retries: 0, allowHosts: ["www.linkedin.com"] });
    assert.equal(li.reason, "redirect_not_allowed", "the denylist wins over allowHosts on a redirect too");
    assert.deepEqual(far.hits, [], "the disallowed host was never contacted");
  } finally { await far.close(); }
  const ok = await applyOne(browser, mk("greenhouse", "redir-ok", { url: `${mock.base}/greenhouse/redir-ok?to=/greenhouse/landing1` }));
  assert.equal(ok.status, "submitted_page_confirmed");
  assert.equal(mock.submissions.some((s) => s.job === "redir-out" || s.job === "redir-li"), false);
});

test("a form that posts to a host that is not allowed (form action or button formaction) is refused before the click", { skip }, async (t) => {
  const far = await listen("127.0.0.2");
  if (!far) return t.skip("cannot bind 127.0.0.2");
  try {
    const target = encodeURIComponent(`http://127.0.0.2:${far.port}/greenhouse/x/submit`);
    const a = await applyOne(browser, mk("greenhouse", "act1", { url: `${mock.base}/greenhouse/act1?action=${target}` }), { retries: 0 });
    const b = await applyOne(browser, mk("greenhouse", "act2", { url: `${mock.base}/greenhouse/act2?formaction=${target}` }), { retries: 0 });
    const c = await applyOne(browser, mk("greenhouse", "act3", { url: `${mock.base}/greenhouse/act3?action=${encodeURIComponent("https://www.linkedin.com/apply")}` }), { retries: 0, allowHosts: ["www.linkedin.com"] });
    for (const r of [a, b, c]) { assert.equal(r.status, "not_submitted"); assert.equal(r.reason, "form_action_not_allowed"); }
    assert.deepEqual(far.hits, [], "nothing was posted to the disallowed host");
  } finally { await far.close(); }
  assert.equal(mock.submissions.some((s) => s.job.startsWith("act")), false);
});

test("submission needs an approval {approval_id, hash} whose hash is the hash of the payload to be submitted", { skip }, async () => {
  const none = mk("lever", "ap1"); delete none.approval;
  assert.equal((await applyOne(browser, none)).reason, "not_approved");
  const legacy = mk("lever", "ap2"); legacy.approval = { payloadHash: payloadHash(legacy) };
  assert.equal((await applyOne(browser, legacy)).reason, "not_approved", "the old integrity-only shape is no longer an approval");
  for (const [i, approval_id] of [undefined, "", "   ", 7].entries()) {
    const p = mk("lever", `ap3${i}`); p.approval = { approval_id, hash: payloadHash(p) };
    assert.equal((await applyOne(browser, p)).reason, "not_approved", `approval_id ${JSON.stringify(approval_id)}`);
  }
  const noHash = mk("lever", "ap4"); noHash.approval = { approval_id: "a1" };
  assert.equal((await applyOne(browser, noHash)).reason, "not_approved");
  const wrong = mk("lever", "ap5"); wrong.approval = { approval_id: "a1", hash: "0".repeat(64) };
  assert.equal((await applyOne(browser, wrong)).reason, "not_approved");
  const edited = mk("lever", "ap6"); edited.answers = { ...answers, "Additional information": "added after approval" };
  assert.equal((await applyOne(browser, edited)).reason, "not_approved", "a payload edited after the hash was taken");
  assert.equal(mock.submissions.some((s) => s.job.startsWith("ap")), false);
  assert.equal((await applyOne(browser, mk("lever", "ap7"))).status, "submitted_page_confirmed");
});
