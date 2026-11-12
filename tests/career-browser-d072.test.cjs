"use strict";
// D-072 (item 4): the engine causes the strict benchmark's root-cause report named (docs/architect/reports/
// ITEM4-ROOT-CAUSES-20261112.md), each on a recorded local page shaped like the real board's, and the WO-L hand-off at a wall the
// rules keep, through the real apply-VM worker (createWorker) and the real runner (parallel-apply applyOne): the stop with
// everything else filled, one link, the person's "done", the re-check, the exact-answers card, and Submit only on a yes to that
// card's hash. Nothing reaches an employer: every page is on 127.0.0.1, and the only POST any test receives is the one Submit
// that follows the matching yes (counted).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const d072 = require("../scripts/browser-eval/d072.cjs");
const { strictPosting } = require("../scripts/browser-eval/strict.cjs");
const { buildHandoff, answersCard, yesMatches } = require("../workers/career-browser/handoff.cjs");
const { applyUrlFor } = require("../workers/career-browser/apply-entry.cjs");
const { closedAfterLoad } = require("../workers/career-browser/parallel-apply.cjs");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// ------------------------------------------------------------------------------------------------ recorded pages (local)
const FORM = (extra = "", submit = `<button type="submit">Submit application</button>`) => `<form action="/submit" method="post">
  <label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label>
  <label>Email <input name="email" type="email" required></label>${extra}${submit}</form>`;
// BambooHR (run 43192269304 DIAG: forms=1, inputs 17 to 31, a reCAPTCHA anchor frame 304x78 drawn above Submit, inside the form).
const BAMBOO = `<!doctype html><title>BambooHR</title><body>${FORM(`<div class="g-recaptcha" data-sitekey="6LfZ4-TEST" style="width:304px;height:78px;border:1px solid #ccc">I'm not a robot</div>`)}</body>`;
// A Cloudflare-style interstitial over the whole page (no form behind it yet): a wall at the door.
const INTERSTITIAL = `<!doctype html><title>Just a moment...</title><body><div id="challenge-form" style="width:600px;height:300px">Checking your browser</div></body>`;
// Greenhouse's job_app embed inside an employer's careers page (bitwarden.com, lucidmotors.com in the run).
const EMPLOYER_EMBED = (base) => `<!doctype html><title>Careers | Acme</title><body><h1>Product Manager</h1><iframe src="${base}/embed/job_app?for=acme&token=5240768007" width="800" height="900"></iframe></body>`;
// Workday's job page (two different apply links: Apply and Apply Manually), and the page Apply Manually draws: its account sign-in.
const WD_JOB = (p) => `<!doctype html><title>Analyst</title><body><h1>Analyst</h1><a href="${p}/apply">Apply</a> <a href="${p}/apply/applyManually">Apply Manually</a></body>`;
const WD_SIGNIN = `<!doctype html><title>Workday</title><body><div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML =
  '<h2>Create Account</h2><label>Email Address <input type="text" data-automation-id="email"></label><label>Password <input type="password" data-automation-id="password"></label><button>Create Account</button>'; }, 300);</script></body>`;
// Teamtailor: a posting whose only form is the employer's staff sign-in ("Already working at Acme?").
const TT_EMPLOYEE = `<!doctype html><title>Engineer - Acme</title><body><h1>Engineer</h1><p>Already working at Acme? Let's recruit together.</p>
  <form action="/connect/login" method="post"><input type="email" name="email" aria-label="Email"><button type="submit">Log in</button></form></body>`;

let browser, server, base;
const posts = [];
const state = { signedIn: false };
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const html = (s) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return html("<h1>Thank you for applying</h1>"); }
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (u.pathname === "/bamboo/careers/93") return html(BAMBOO);
    if (u.pathname === "/interstitial/job/1") return html(INTERSTITIAL);
    if (u.pathname === "/gh/jobs/9") return res.writeHead(302, { location: "/gh?error=true" }).end();
    if (u.pathname === "/gh") return html("<!doctype html><title>Jobs at Acme</title><body><h1>Jobs at Acme</h1></body>");
    if (u.pathname === "/careers/product-manager") return html(EMPLOYER_EMBED(base));
    if (u.pathname === "/embed/job_app") return html(`<!doctype html><title>Job Application</title><body>${FORM()}</body>`);
    if (u.pathname === "/wd/job/Chicago/Analyst_R1") return html(WD_JOB(u.pathname));
    if (u.pathname === "/wd/job/Chicago/Analyst_R1/apply/applyManually") return html(WD_SIGNIN);
    if (u.pathname === "/tt/jobs/123-engineer") return html(TT_EMPLOYEE);
    // The VM's posting (loopback /greenhouse/... is the only local path the VM drives): the employer's sign-in until the person
    // has finished it, then the application form. Answers come from the approved payload.
    if (u.pathname === "/greenhouse/acme/jobs/7") {
      if (!state.signedIn) return html(`<!doctype html><title>Acme</title><body><h2>Sign in to apply</h2><form action="/login"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form></body>`);
      return html(`<!doctype html><title>Job Application for Analyst at Acme</title><body><form action="/greenhouse/acme/jobs/7/submit" method="post">
        <label>First Name <input name="first_name" required></label><label>Email <input name="email" type="email" required></label>
        <label>Resume <input type="file" name="resume" required></label><button type="submit">Submit application</button></form></body>`);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "d072-"))) });

// ------------------------------------------------------------------------------------------------ pure: the 99% reading
test("D-072 reading: (a) at Submit, (b) only a kept wall WITH its hand-off, and every other stop named", () => {
  const h = (reason) => ({ reason, link: "https://x.example/apply", step: "do the one step", remaining: [], filled: [] });
  const c = (row) => d072.classify({ provider: "greenhouse", url: "https://job-boards.greenhouse.io/a/jobs/1", ...row });
  assert.deepEqual(c({ result: "pass", reason: "strict_reached_submit" }), { outcome: "a", cause: "reached_submit" });
  assert.equal(c({ result: "ready_except_upload" }).outcome, "a");
  const answers = { result: "ready_if_answered", reason: "missing_required_answer", needs: [{ label: "Why us?", reason: "no_confirmed_answer" }, { label: "Privacy", reason: "agreement_needs_you" }] };
  assert.deepEqual(c(answers), { outcome: "fail", cause: "person_answer_no_handoff", wall: "person_answer" }, "no hand-off: not (b)");
  assert.equal(c({ ...answers, handoff: { ...h("person_answer"), link: null, card: "ask_once" } }).outcome, "b");
  // An engine failure beside the person's answers is the engine's, never handed to the person.
  assert.equal(c({ ...answers, needs: [...answers.needs, { label: "Resume", reason: "upload_not_accepted" }] }).cause, "upload_not_accepted");
  assert.equal(c({ result: "fail", reason: "bot_check", wall: "check_in_form", handoff: h("bot_check_in_form") }).outcome, "b");
  assert.equal(c({ result: "fail", reason: "bot_check", handoff: h("login_required") }).outcome, "fail", "a hand-off must name the same wall");
  assert.equal(c({ result: "fail", reason: "login_required", handoff: h("login_required") }).outcome, "b");
  assert.equal(c({ result: "fail", reason: "retries_exhausted", error: "page_load_404" }).cause, "posting_closed:page_load_404");
  assert.equal(c({ result: "fail", reason: "no_application_form_found", diag: { url: "https://job-boards.greenhouse.io/a?error=true", forms: 0, inputs: 0 } }).cause, "posting_closed:board_says_not_found");
  assert.equal(c({ result: "fail", reason: "retries_exhausted", error: "page_load_429" }).cause, "rate_limited_429");
  assert.equal(c({ result: "fail", reason: "no_application_form_found", diag: { forms: 0, inputs: 1, frames: ["https://job-boards.greenhouse.io/embed/job_app?for=a"] } }).cause, "form_not_found:embedded_frame");
  assert.equal(d072.classify({ provider: "teamtailor", url: "https://a.teamtailor.com/jobs/1-x", result: "fail", reason: "login_required", diag: { forms: 1, inputs: 3 } }).cause, "form_not_found:employee_sign_in_only");
  const t = d072.tally([{ result: "pass" }, { ...answers, handoff: { ...h("person_answer"), card: "ask_once" } }, { result: "fail", reason: "host_unreachable" }]);
  assert.deepEqual([t.a, t.b, t.fail, t.need, t.meets, t.raw_pass], [1, 1, 1, 3, false, 1]);
});

test("the hand-off: one https link to the employer's page, only the wall's step, never a password or code through chat, and none for an engine failure", () => {
  const signin = buildHandoff({ status: "needs_user", reason: "login_required", wall: "password", at: "https://acme.wd5.myworkdayjobs.com/x/job/a_1/apply/applyManually", filled_labels: [] });
  assert.equal(signin.link, "https://acme.wd5.myworkdayjobs.com/x/job/a_1/apply/applyManually");
  assert.equal(signin.nothing_sent, true); assert.equal(signin.at_door, true);
  assert.match(signin.step, /sign in to your own account/i); assert.match(signin.step, /never asks for your password/i);
  assert.deepEqual(signin.then, ["person_says_done", "recheck", "answers_card", "yes_to_submit"]);
  const code = buildHandoff({ status: "needs_user", reason: "email_code", at: "https://boards.greenhouse.io/a/jobs/1" });
  assert.match(code.step, /never send it in chat/);
  const check = buildHandoff({ status: "needs_user", reason: "bot_check", wall: "check_in_form", at: "https://a.bamboohr.com/careers/93", filled_labels: ["First Name", "Email"] });
  assert.equal(check.reason, "bot_check_in_form"); assert.deepEqual(check.filled, ["First Name", "Email"]); assert.match(check.step, /Do not press Submit/);
  const ans = buildHandoff({ status: "not_submitted", reason: "missing_required_answer", at: "https://jobs.lever.co/a/b/apply", filled_labels: ["Email"], needs: [{ label: "Why us?", reason: "no_confirmed_answer" }], also_check: "widget" });
  assert.equal(ans.card, "ask_once"); assert.deepEqual(ans.remaining.map((x) => x.kind), ["answer", "bot_check"]);
  assert.equal(buildHandoff({ status: "not_submitted", reason: "missing_required_answer", needs: [{ label: "Resume", reason: "upload_not_accepted" }] }), null);
  assert.equal(buildHandoff({ status: "not_submitted", reason: "field_not_filled", needs: [{ label: "Phone", reason: "readback_mismatch" }] }), null);
  assert.equal(buildHandoff({ status: "not_submitted", reason: "no_application_form_found" }), null);
  for (const x of [signin, code, check, ans]) assert.doesNotMatch(JSON.stringify(x), /password"\s*:|"code"\s*:/);
  // A yes approves exactly the card it answers.
  const card = answersCard({ url: "https://a/1", payload_hash: "h", fields: [{ label: "Email", held: "t@example.invalid" }] });
  assert.equal(yesMatches(card, { card_hash: card.hash }), true);
  assert.equal(yesMatches(card, { card_hash: "0".repeat(64) }), false);
  assert.equal(yesMatches(answersCard({ url: "https://a/1", payload_hash: "h", fields: [{ label: "Email", held: "other@example.invalid" }] }), { card_hash: card.hash }), false);
});

test("Workday's own apply address, and a posting the board sent back to its job list is named closed", () => {
  assert.equal(applyUrlFor("workday", "https://avisbudget.wd1.myworkdayjobs.com/Zipcar_Careers/job/USA---Baltimore/Fleet-Associate_R0191881"),
    "https://avisbudget.wd1.myworkdayjobs.com/Zipcar_Careers/job/USA---Baltimore/Fleet-Associate_R0191881/apply/applyManually");
  assert.equal(applyUrlFor("workday", "https://a.wd1.myworkdayjobs.com/S/job/X/Y_R1/apply/applyManually"), null);
  assert.equal(closedAfterLoad("https://job-boards.greenhouse.io/a/jobs/1", "https://job-boards.greenhouse.io/a?error=true"), true);
  assert.equal(closedAfterLoad("https://apply.workable.com/j/E2", "https://apply.workable.com/co/?not_found=true"), true);
  assert.equal(closedAfterLoad("https://a.bamboohr.com/careers/757", "https://a.bamboohr.com/careers"), true);
  assert.equal(closedAfterLoad("https://jobs.lever.co/a/b", "https://jobs.lever.co/a/b/apply"), false);
  assert.equal(closedAfterLoad("https://a.breezy.hr/p/x", "https://a.breezy.hr/p/x/apply"), false);
});

// ------------------------------------------------------------------------------------------------ the engine on recorded pages
test("BambooHR's in-form check: every other field filled and read back first, then a stop at the check, untouched, with its hand-off", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "bamboohr", url: `${base}/bamboo/careers/93` }, opts());
  assert.equal(r.reason, "bot_check", JSON.stringify(r));
  assert.equal(r.wall, "check_in_form");
  assert.equal(r.filled_count, 3, "First Name, Last Name and Email were filled before the stop");
  assert.equal(r.handoff.reason, "bot_check_in_form"); assert.equal(r.handoff.link, `${base}/bamboo/careers/93`);
  assert.deepEqual(r.d072, { outcome: "b", cause: "bot_check_in_form_handed_off", wall: "bot_check_in_form" });
  assert.deepEqual(posts, []);
});

test("a whole-page challenge still stops at the door, before anything is typed", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "smartrecruiters", url: `${base}/interstitial/job/1` }, opts());
  assert.equal(r.reason, "bot_check"); assert.notEqual(r.wall, "check_in_form"); assert.equal(r.filled_count, 0);
  assert.deepEqual(posts, []);
});

test("a closed Greenhouse posting is named posting_closed; the employer-embedded Greenhouse form is reached and filled to Submit", { skip }, async () => {
  const closed = await strictPosting(browser, { provider: "greenhouse", url: `${base}/gh/jobs/9` }, opts());
  assert.equal(closed.reason, "posting_closed", JSON.stringify(closed));
  assert.equal(closed.d072.cause, "posting_closed:board_says_not_found");
  const embed = await strictPosting(browser, { provider: "greenhouse", url: `${base}/careers/product-manager` }, opts());
  assert.equal(embed.result, "pass", JSON.stringify(embed));
  assert.deepEqual(posts, []);
});

test("Workday: Apply Manually is opened at its own address and its account page is a sign-in wall the person finishes; nothing typed", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "workday", url: `${base}/wd/job/Chicago/Analyst_R1` }, opts());
  assert.equal(r.reason, "login_required", JSON.stringify(r));
  assert.equal(r.handoff.reason, "login_required");
  assert.equal(r.handoff.link, `${base}/wd/job/Chicago/Analyst_R1/apply/applyManually`);
  assert.equal(r.filled_count, 0);
  assert.deepEqual(posts, []);
});

test("Teamtailor's staff sign-in form is not the person's wall: the application form was not reached, and that is said", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "teamtailor", url: `${base}/tt/jobs/123-engineer` }, opts());
  assert.equal(r.reason, "no_application_form_found", JSON.stringify(r));
  assert.equal(r.handoff, null);
  assert.equal(r.d072.cause, "form_not_found:employee_sign_in_only");
});

// ------------------------------------------------------------------------------------------------ the hand-off, end to end, through the VM worker
const RESUME = Buffer.from("%PDF-1.4\n% TEST resume for the D-072 hand-off\n");
const RSHA = crypto.createHash("sha256").update(RESUME).digest("hex");
function vmRow(url, extra = {}) {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000072", job_id: "greenhouse:acme:7", company: "Acme", url, resume_sha256: RSHA,
    fields: [{ label: "First Name", value: "Test", factId: "f1" }, { label: "Email", value: "test.person@example.invalid", factId: "f3" }] };
  const h = queueHash(payload);
  return { id: "72727272-7272-4727-8727-727272727272", lease_token: "22222222-2222-4222-8222-222222222222", url, user_id: payload.user_id, payload, payload_hash: h, approval_hash: h, approval_id: "33333333-3333-4333-8333-333333333333", ...extra };
}
function vm(row) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "career_apply_vm_claim") return calls.filter((c) => c.name === name).length === 1 ? [row] : [];
    if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: RSHA, b64: RESUME.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    return {};
  };
  const w = createWorker({ rpc, browser, retries: 0, stepTimeoutMs: 8000, evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-d072-")), log: () => {} });
  const run = async () => { assert.equal(await w.tick(), 1); while (w.inflight.size) await new Promise((r) => setTimeout(r, 10)); };
  return { run, completed: () => calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args), phases: () => calls.filter((c) => c.name === "career_apply_vm_heartbeat").map((c) => c.args.p_phase) };
}

test("WO-L hand-off through the VM worker: wall -> one link -> done -> re-check -> exact-answers card -> Submit only on a yes to that card", { skip }, async () => {
  posts.length = 0; state.signedIn = false;
  const url = `${base}/greenhouse/acme/jobs/7`;
  // 1. The stop: the employer's sign-in wall, nothing typed, nothing sent, the hand-off recorded with its one link.
  const a = vm(vmRow(url)); await a.run();
  const [stop] = a.completed();
  assert.equal(stop.p_state, "needs_user"); assert.equal(stop.p_reason, "login_required");
  assert.equal(stop.p_evidence.nothing_sent, true);
  assert.equal(stop.p_evidence.handoff.link, url);
  assert.equal(stop.p_evidence.handoff.reason, "login_required");
  assert.deepEqual(posts, [], "nothing typed into the sign-in, nothing sent");
  // 2. The person finishes the step at the employer themselves, and says done.
  state.signedIn = true;
  // 3. The re-check: the same approved payload, driven to the instant before Submit, never pressed; the card is what the page holds.
  const b = vm(vmRow(url, { handoff_done_at: "2026-11-12T12:00:00Z" })); await b.run();
  const [ready] = b.completed();
  assert.equal(ready.p_state, "needs_user"); assert.equal(ready.p_reason, "ready_for_yes");
  const card = ready.p_evidence.answers_card;
  assert.deepEqual(card.answers.map((x) => [x.field, x.value]).filter(([f]) => f !== "Resume"), [["First Name", "Test"], ["Email", "test.person@example.invalid"]]);
  assert.match(card.hash, /^[0-9a-f]{64}$/);
  assert.ok(!b.phases().includes("submitting"), "a re-check never records a submitting phase");
  assert.deepEqual(posts, [], "the re-check sent nothing");
  // 4. A yes to another card (or an older one) is not a yes: stopped, unsent.
  const c = vm(vmRow(url, { handoff_done_at: "2026-11-12T12:00:00Z", handoff_yes: { card_hash: "0".repeat(64) } })); await c.run();
  const [refused] = c.completed();
  assert.equal(refused.p_state, "not_submitted"); assert.equal(refused.p_reason, "APPROVED_APPLICATION_CHANGED");
  assert.deepEqual(posts, []);
  // 5. The yes to exactly that card: Submit is pressed once, and only now does anything reach the employer.
  const d = vm(vmRow(url, { handoff_done_at: "2026-11-12T12:00:00Z", handoff_yes: { card_hash: card.hash } })); await d.run();
  const [sent] = d.completed();
  assert.equal(sent.p_state, "submitted_unconfirmed", JSON.stringify(sent));
  assert.deepEqual(posts, ["POST /greenhouse/acme/jobs/7/submit"]);
});
