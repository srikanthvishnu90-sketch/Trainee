"use strict";
// The apply path's dry-run harness and fill engine (workers/career-browser/ats-fill.cjs, dry-run.cjs, scripts/career/apply-dryrun.cjs):
//  - Greenhouse, Lever and Ashby fixtures are filled in a real local Chromium and stopped BEFORE Submit; an attempt log (field map,
//    screenshot, reason) is written for each run; nothing is ever posted;
//  - a required question with no confirmed answer is handed back by name, never filled with a guess; EEO questions are answered
//    only from an explicit answer or the person's recorded "decline" policy; only the resume question gets the resume file;
//  - the worker (applyOne) stops on an unanswered or unsettable required question and posts nothing;
//  - the words the person reads for a stop are truthful: not sent / needs you / never "submitted" without the employer's page saying so.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { matchOption, factValue } = require("../workers/career-browser/ats-fill.cjs");
const { runAll } = require("../scripts/career/apply-dryrun.cjs");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");
const cases = require("./fixtures/apply-dryrun/cases.cjs");

const root = path.join(__dirname, "..");
let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

test("matchOption: one clear match or an error, never the closest", () => {
  const L = ["Yes, I am authorized to work", "No, I need work authorization"];
  // #340: only the option's exact words; "Yes" is not "Yes, I am authorized to work" (tests/career-apply-exact-option.test.cjs).
  assert.deepEqual(matchOption(L, "yes, i am authorized to work"), { index: 0 });
  assert.deepEqual(matchOption(L, "No, I need work authorization"), { index: 1 });
  assert.equal(matchOption(L, "Yes").error, "no_matching_option");
  assert.equal(matchOption(L, "Maybe").error, "no_matching_option");
  assert.equal(matchOption(["No", "Not sure"], "Not applicable").error, "no_matching_option", "'Not applicable' is not 'No'");
  assert.deepEqual(matchOption(["No", "Not sure"], "no"), { index: 0 });
  assert.equal(matchOption(["Asian", "Asian American"], "asi").error, "no_matching_option");
  assert.equal(matchOption(["Male", "Female"], "male").index, 0, "an exact label wins over a longer one containing it");
});

test("identity facts fill only from what is confirmed; nothing is invented", () => {
  const f = { first_name: "A", last_name: "B", email: "a@b.invalid" };
  assert.equal(factValue("First Name", f), "A");
  assert.equal(factValue("Full name", f), "A B");
  assert.equal(factValue("Email", f), "a@b.invalid");
  assert.equal(factValue("Phone", f), undefined, "no phone on file: not made up");
  assert.equal(factValue("Why do you want this job?", f), undefined);
  assert.equal(factValue("Salary expectations", f), undefined);
});

let summary;
test("dry run: every fixture is filled, read back and stopped before Submit; each run leaves a log and a screenshot", { skip, timeout: 280000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "apply-dryrun-test-"));
  summary = await runAll({ outDir: out });
  assert.equal(summary.server_saw_post_requests, 0, "nothing was posted to the local server");
  assert.equal(summary.nothing_sent, true);
  for (const ats of ["greenhouse", "lever", "ashby"]) assert.ok(summary.by_ats[ats] && summary.by_ats[ats].total >= 3, `${ats} fixtures ran`);
  const failed = summary.results.filter((r) => !r.pass).map((r) => `${r.id}: ${Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(",")}`);
  assert.deepEqual(failed, [], "every fixture passes");
  for (const r of summary.results) for (const f of r.logs) {
    const log = JSON.parse(fs.readFileSync(path.join(out, f), "utf8"));
    assert.equal(log.dry_run, true); assert.equal(log.nothing_sent, true); assert.equal(log.submit_clicked, false);
    assert.ok(Array.isArray(log.field_map) && log.field_map.length > 0, "field map");
    assert.ok(log.reason, "a reason on every outcome");
    assert.ok(log.screenshot && fs.statSync(log.screenshot).size > 1000 && /^[0-9a-f]{64}$/.test(log.screenshot_sha256), "screenshot");
    assert.ok(!JSON.stringify(log).includes("casey.nguyen.test"), "the log holds labels and sources, never the person's values");
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test("interactive fixtures: ready only when everything required is answered; a bot check is reported, never solved", { skip }, () => {
  if (!summary) return;
  const byId = Object.fromEntries(summary.results.map((r) => [r.id, r]));
  for (const id of ["greenhouse-acme", "lever-acme", "ashby-acme"]) {
    assert.equal(byId[id].outcomes.full, "ready", id);
    assert.equal(byId[id].outcomes.bare, "needs_you", id + ": without the answers the person is asked");
  }
  assert.equal(byId["lever-acme"].bot_check, true, "the hCaptcha widget on the Lever fixture is reported");
});

// ---- the worker on the same fixtures: it stops and posts nothing --------------------------------------------------------
let server, base, posts = [], browser, resume, rsha;
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { posts.push(req.url); return res.writeHead(200).end("posted"); }
    const u = req.url.split("?")[0];
    if (u === "/widgets.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun/widgets.js")));
    const c = cases.interactive.find((x) => "/" + x.id === u);
    return c ? res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun", c.file))) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adr-")), "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise((r) => server.close(r)); });
const job = (id, answers) => {
  const p = { id: "j-" + id, ats: id.split("-")[0], url: `${base}/${id}`, facts: cases.facts, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + p.id, hash: payloadHash(p) };
  return p;
};

test("worker: an unanswered required question stops the run by name and posts nothing", { skip }, async () => {
  const r = await applyOne(browser, job("greenhouse-acme", {}), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted");
  assert.equal(r.reason, "missing_required_answer");
  assert.ok(r.needs.some((n) => /Why do you want to work at Acme/.test(n.label)), "the question is named");
  assert.equal(posts.length, 0);
});

test("worker: an answer that matches no option is handed back as 'not filled', never swapped for another option", { skip }, async () => {
  const answers = { ...cases.interactive[0].answers, "Are you legally authorized to work in the United States?": "Maybe" };
  const r = await applyOne(browser, job("greenhouse-acme", answers), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted");
  assert.equal(r.reason, "field_not_filled");
  assert.match(r.field, /legally authorized/);
  assert.equal(posts.length, 0);
});

test("worker: even with every answer given, a page carrying a verification check is handed back unsent (never solved)", { skip }, async () => {
  const p = job("lever-acme", cases.interactive[1].answers);
  // The Lever fixture carries an hCaptcha widget: the worker hands it back (never solves it), so nothing is posted.
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "needs_user");
  assert.equal(r.reason, "bot_check");
  assert.equal(posts.length, 0);
});

// ---- what the person reads ------------------------------------------------------------------------------------------------
test("the words for a stop never read as sent", () => {
  const { statusLine, reasonWords } = require(path.join(root, "supabase/functions/_shared/career_apply_status.ts"));
  const row = (state, reason) => ({ id: "1", company: "Acme", title: "Engineer", state, reason, created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" });
  const need = statusLine(row("needs_user", "missing_required_answer: Why do you want to work at Acme?"));
  assert.match(need, /stopped before it was sent; it needs you/);
  assert.match(need, /required question you have not answered/);
  assert.match(need, /the question: "Why do you want to work at Acme\?"/);
  assert.doesNotMatch(need, /missing_required_answer/);
  assert.match(statusLine(row("not_submitted", "field_not_filled: Are you legally authorized")), /not sent \(a required question could not be filled in and checked.*Are you legally authorized/);
  assert.match(statusLine(row("not_submitted", "no_application_form_found")), /no application form was found.*nothing was sent/);
  assert.match(statusLine(row("not_submitted", "WORKER_ERROR")), /something went wrong on our side before it was sent/);
  assert.match(statusLine(row("not_submitted", "page_load_503")), /did not load/);
  for (const [state, reason] of [["needs_user", "missing_required_answer: Q"], ["failed", "field_not_filled"], ["not_submitted", "NO_RESUME"], ["not_submitted", "host_not_allowed"], ["not_submitted", "a_code_nobody_named"]]) {
    const line = statusLine(row(state, reason));
    assert.match(line, /not sent|stopped before it was sent/i, line);
    assert.doesNotMatch(line, /\bsubmitted\b(?! yet)/i, line);
    assert.doesNotMatch(line, /[a-z]+_[a-z_]+|[A-Z]{3,}_[A-Z_]+/, "no raw code: " + line);
  }
  assert.match(statusLine(row("queued", null)), /approved, not sent yet/);
  assert.match(statusLine(row("driving", null)), /not submitted yet/);
  assert.match(statusLine(row("unknown_outcome", null)), /can't tell whether it reached/);
  assert.match(statusLine(row("submitted_unconfirmed", null)), /submitted.*has not confirmed it yet/);
  assert.match(statusLine(row("confirmed", null)), /confirmed it/);
  assert.ok(reasonWords("failed", ""), "an empty reason still says something true");
  const { statusOf } = require(path.join(root, "supabase/functions/_shared/file_page.ts"));
  const d = statusOf({ app: { ...row("needs_user", "missing_required_answer: Q"), confirmation_id: null }, wanted: true });
  assert.match(d.detail, /^Stopped before it was sent: .*nothing was sent/);
});
