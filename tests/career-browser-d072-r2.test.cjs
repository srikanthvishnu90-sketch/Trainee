"use strict";
// D-072 (item 4, round 2): the causes the round-1 after-run (bench run 43276162667) left, each on a recorded local page shaped like
// the real board's (the read-only captures of 2026-11-12 on bench/browser-cap-r2: the boards' own markup, words and upload calls),
// driven through the strict benchmark's own harness (scripts/browser-eval/strict.cjs strictPosting -> the production runner
// parallel-apply.cjs applyOne). Nothing reaches an employer: every page is on 127.0.0.1 and every POST any page makes is counted
// (the harness blocks it in the browser before it leaves).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const d072 = require("../scripts/browser-eval/d072.cjs");
const { strictPosting, simulatedUpload, simulatedFileRead, SIMULATED_FILE } = require("../scripts/browser-eval/strict.cjs");
const { APPLY_TEXT, NEVER_CLICK } = require("../workers/career-browser/apply-entry.cjs");
const { samePostingRedirect, postingIds } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const NAME_FIELDS = `<label for="fn">First Name *</label><input id="fn" name="first_name" required><label for="ln">Last Name *</label><input id="ln" name="last_name" required><label for="em">Email *</label><input id="em" name="email" type="email" required>`;
// Teamtailor (capture: careers.axpo.com, jobb.a-hub.se, ambit.teamtailor.com): the Apply control is a button outside every form whose
// declared action draws the application form's overlay; its words are the employer's language, here "Skicka ansökan" ("send
// application"). The staff sign-in form ("auto join") sits beside it. The form is drawn only when the button is pressed.
const TT = (words) => page("Säljare - Acme", `<header><button>KARRIÄRMENY</button></header><section class="block-cover">
  <button role="button" class="careersite-button" data-action="click->careersite--jobs--form-overlay#showFormOverlay" data-careersite--jobs--form-overlay-target="coverButton">${words}</button></section>
  <form action="/sv/auto_join" method="post" data-blocks--auto-join--form-target="form"><input type="email" name="email" aria-label="E-post"><button type="submit">Logga in</button></form>
  <div id="overlay"></div>
  <button class="fixed" data-action="click->careersite--jobs--form-overlay#showFormOverlay">${words}</button>
  <script>document.querySelectorAll("[data-action*=showFormOverlay]").forEach((b) => b.addEventListener("click", () => {
    document.getElementById("overlay").innerHTML = '<form id="job-application-form" action="/tt/apply" method="post">${NAME_FIELDS.replace(/'/g, "\\'")}<button type="submit">Skicka ansökan</button></form>';
  }));</script>`);
// Teamtailor in Norwegian, no declared action: only the words lead to it.
const TT_NO = page("Utvikler - Acme", `<button id="apply">Søk på denne stillingen</button><div id="o"></div><script>document.getElementById("apply").onclick = () => {
  document.getElementById("o").innerHTML = '<form action="/tt/apply" method="post">${NAME_FIELDS.replace(/'/g, "\\'")}<button type="submit">Send søknad</button></form>'; };</script>`);
// Personio in Spanish (capture: grupoenhol.jobs.personio.de): a link and a button in the same words to /job/<id>/apply.
const PERSONIO = page("Especialista", `<a href="/personio/job/2831159/apply">Solicitar este puesto de trabajo</a><button type="button">Solicitar este puesto de trabajo</button>`);
// SmartRecruiters (capture: jobs.smartrecruiters.com/SGS/...): #st-apply links to the board's own /oneclick-ui/ form, in the
// employer's language; that form answers 403 with DataDome's challenge drawn over the page. A disabled #st-apply is an expired posting.
const SR_JOB = (href) => page("SGS Supervisor | SmartRecruiters", `<a class="button js-oneclick" data-sr-track="apply" href="${href}?dcr_ci=SGS">Me interesa</a>
  <a class="button js-oneclick" id="st-apply" data-sr-track="apply" href="${href}?dcr_ci=SGS">Me interesa</a>
  <a class="button js-oneclick" data-sr-track="apply" tabindex="-1" aria-hidden="true" href="${href}?dcr_ci=SGS&utm_source=job-ad-smartr-apply">Me interesa</a>`);
const SR_CHALLENGE = page("smartrecruiters.com", `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=TEST" width="600" height="400" style="border:0"></iframe>`);
const SR_EXPIRED = page("Securitas | SmartRecruiters", `<section class="job-apply"><button class="button is-disabled job-button" disabled>Es tut uns leid, diese Stellenanzeige ist abgelaufen</button></section><aside><button id="st-apply" class="button is-disabled" disabled>Es tut uns leid, diese Stellenanzeige ist abgelaufen</button></aside>`);
// Workday (capture: gfs.wd5, meredith.wd5): the app draws its marked parts late; here the sign-in box after 14 s (beyond the old 12 s).
// And its "page doesn't exist" (hcsc.wd1, uline.wd1, philips.wd3): data-automation-id invalid-content.
const WD_LATE = page("Workday", `<div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML = '<div data-automation-id="applyFlowPage"><div data-automation-id="progressBar"></div><div data-automation-id="signInContent"><h2>Create Account</h2><input type="email" data-automation-id="email"><input type="password" data-automation-id="password"><button type="submit">Create Account</button></div></div>'; }, 14000);</script>`);
const WD_GONE = page("Careers", `<div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML = '<div data-automation-id="invalid-content">The page you are looking for doesn\\'t exist.</div>'; }, 2500);</script>`);
// Breezy "Position Closed" (capture: katapult.breezy.hr).
const BREEZY_CLOSED = page("Position Closed", `<h1>Position Closed</h1><p>Sorry, this position is no longer accepting candidates.</p>`);
// Workable (capture: apply.workable.com/advisacare-2/...): a cookie-consent layer drawn over the whole page (z-index 999999) with
// Accept all / Decline all, above a drawn Yes/No question (the radio input hidden, its words drawn).
const WORKABLE = page("Application", `<form action="/wk/apply" method="post">${NAME_FIELDS}
  <fieldset role="radiogroup" aria-labelledby="q1l"><span id="q1l">Are you willing to undergo a background check? *</span>
   <div role="radio" aria-checked="false"><input type="radio" name="q1" value="YES" required style="opacity:0;position:absolute;width:1px;height:1px"><span>YES</span></div>
   <div role="radio" aria-checked="false"><input type="radio" name="q1" value="NO" required style="opacity:0;position:absolute;width:1px;height:1px"><span>NO</span></div></fieldset>
  <button type="submit">Submit application</button></form>
  <div id="bd" style="position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.3)"><div style="position:fixed;bottom:0;left:0;right:0;background:#fff;z-index:1000000">This website uses cookies to improve user's experience.
   <button data-ui="cookie-consent-accept">Accept all</button><button data-ui="cookie-consent-decline" onclick="document.getElementById('bd').remove()">Decline all</button></div></div>
  <script>document.querySelectorAll("[role=radio]").forEach((w) => w.addEventListener("click", () => { document.querySelectorAll("[role=radio]").forEach((x) => { x.setAttribute("aria-checked", "false"); x.querySelector("input").checked = false; }); w.setAttribute("aria-checked", "true"); w.querySelector("input").checked = true; }));</script>`);
// Lever's place lookup (capture: jobs.lever.co/Gantri/...: still loading after 5 s; GET /searchLocations).
const LEVER = page("Acme - Engineer", `<form action="/lever/apply" method="post">
  <ul><li class="application-question"><label><div class="application-label">Full name ✱</div><div class="application-field"><input name="name" required></div></label></li>
  <li class="application-question"><label><div class="application-label">Email ✱</div><div class="application-field"><input name="email" type="email" required></div></label></li>
  <li class="application-question" data-qa="structured-contact-location-question"><label><div class="application-label">Current location ✱</div><div class="application-field">
   <input class="location-input" id="location-input" type="text" name="location" required><input id="selected-location" type="hidden" name="selectedLocation">
   <div class="dropdown-container"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display:none">No location found.</div><div class="dropdown-loading-results" style="display:none">Loading</div></div></div></label></li></ul>
  <button type="button" class="postings-btn" onclick="this.form.requestSubmit()">Submit application</button></form>
  <script>const i = document.getElementById("location-input"), res = document.querySelector(".dropdown-results"), load = document.querySelector(".dropdown-loading-results"); let t;
   i.addEventListener("input", () => { clearTimeout(t); res.innerHTML = ""; load.style.display = "block"; t = setTimeout(() => { load.style.display = "none";
     res.innerHTML = '<div class="dropdown-location" id="location-0">Chicago, IL, USA</div>';
     res.firstChild.addEventListener("click", () => { i.value = "Chicago, IL, USA"; document.getElementById("selected-location").value = '{"name":"Chicago, IL, USA"}'; res.innerHTML = ""; }); }, 8000); });</script>`);
// Breezy: the board's own "Phone Number" (name cPhoneNumber) and the employer's custom question in the same words.
const BREEZY_PHONE = page("Inspector", `<form action="/breezy/apply" method="post"><div class="section"><h3><span>Full Name</span><span class="required">*</span></h3><input required name="cName" type="text" placeholder="Full Name">
  <h3><span>Email Address</span><span class="required">*</span></h3><input required name="cEmail" type="email" placeholder="Email Address">
  <h3><span>Phone Number</span><span class="required">*</span></h3><input required name="cPhoneNumber" type="text" placeholder="Phone Number"></div>
  <ul><li class="question"><h3><span>Phone Number</span><span class="required">*</span></h3><input required name="section_1769632133065_question_1" type="text"></li></ul>
  <button type="submit">Submit Application</button></form>`);
// Recruitee (capture: gong.recruitee.com): the Submit in Polish ("Wyślij", type=submit) beside a button with no type.
const RECRUITEE = page("GONG - Project Manager - Formularz", `<form id="offer-application-form" action="/rc/apply" method="post">${NAME_FIELDS}<button>Napisz go tutaj</button><button type="submit">Wyślij</button></form>`);
// Greenhouse's job-boards form re-rendering every input a moment after load (React hydration): the first tags are gone.
const GH_RERENDER = page("Job Application for Analyst at Acme", `<form id="f" action="/ghr/apply" method="post"></form><script>
  const draw = () => { document.getElementById("f").innerHTML = '${NAME_FIELDS}<button type="submit">Submit application</button>'; };
  draw(); setTimeout(draw, 1500);</script>`);
// A required export-control choice with no option to decline (capture: job-boards.greenhouse.io/divergent/...).
const GH_EXPORT = page("Job Application for Engineer at Divergent", `<form action="/gh-export/apply" method="post">${NAME_FIELDS}
  <label for="ec">This position requires access to information that is subject to U.S. export controls. Which applies to you? *</label>
  <select id="ec" name="ec" required><option value="">Select...</option><option>US citizen or national</option><option>US permanent resident</option><option>None of the above</option></select>
  <button type="submit">Submit application</button></form>`);

let browser, server, base;
const posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const html = (s, code = 200) => res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(s);
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return html("<h1>Thank you for applying</h1>"); }
    const u = new URL(req.url, "http://x");
    const r = {
      "/robots.txt": () => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n"),
      "/tt/jobs/8510421-saljare": () => html(TT("Skicka ansökan")), "/tt/jobs/8485375-utvikler": () => html(TT_NO),
      "/personio/job/2831159": () => html(PERSONIO), "/personio/job/2831159/apply": () => html(page("Especialista", `<form action="/personio/submit" method="post">${NAME_FIELDS}<button type="submit">Enviar</button></form>`)),
      "/sr/SGS/744000068788026": () => html(SR_JOB(`${base}/oneclick-ui/company/SGS/publication/f46446a2-9dbd-49ca-9167-e623bf8ab66b`)),
      "/oneclick-ui/company/SGS/publication/f46446a2-9dbd-49ca-9167-e623bf8ab66b": () => html(SR_CHALLENGE, 403),
      "/sr/Securitas/744000156496379": () => html(SR_EXPIRED),
      "/wd/job/Chicago/Analyst_R2": () => html(page("Analyst", "<h1>Analyst</h1>")), "/wd/job/Chicago/Analyst_R2/apply/applyManually": () => html(WD_LATE),
      "/wd/job/Chicago/Gone_R3": () => html(page("Careers", "<div></div>")), "/wd/job/Chicago/Gone_R3/apply/applyManually": () => html(WD_GONE),
      "/breezy/p/5f19dfaee2c3-coordinator": () => html(BREEZY_CLOSED),
      "/wk/j/E647F1C914/apply/": () => html(WORKABLE),
      "/lever/acme/6c1d84b8-7305-42d7-bf69-5ace8a5b932f/apply": () => html(LEVER),
      "/breezy/p/913460a2bba7-inspector/apply": () => html(BREEZY_PHONE),
      "/rc/o/project-manager/c/new": () => html(RECRUITEE),
      "/ghr/jobs/5312426": () => html(GH_RERENDER), "/gh-export/jobs/5364611008": () => html(GH_EXPORT),
      "/careers/job-detail/5971252004": () => html(page("Careers | Cribl", `<form action="/search" method="get"><label for="q">Search the site</label><input id="q" name="q"><button type="submit">Submit</button></form>`)),
      "/lv/cyara/aaa5ce22-78a3-4159-baa4-b7eb7994400d": () => res.writeHead(302, { location: "https://apply.workable.com/australian-christian-college/?not_found=true" }).end(),
    }[u.pathname];
    return r ? r() : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = (persona) => ({ persona, robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "d072r2-"))) });
const run = (provider, p, persona) => strictPosting(browser, { provider, url: `${base}${p}` }, opts(persona));

// ------------------------------------------------------------------------------------------------ pure
test("the Apply words of the samples' languages, a trailing '!', and never a word that sends", () => {
  for (const t of ["Søk på denne stillingen", "Ansøg om dette job", "Reageer op deze vacature", "Apply here!", "ANSÖK HÄR!", "Solicitar este puesto de trabajo", "apply in 30 seconds", "Søk uten søknadsbrev", "Jetzt bewerben", "Je postule"]) assert.ok(APPLY_TEXT.test(t), t);
  for (const t of ["Candidate Connect login", "Share page", "Accept all cookies", "Submit application"]) assert.ok(!APPLY_TEXT.test(t), t);
  assert.ok(NEVER_CLICK.test("Skicka ansökan") && NEVER_CLICK.test("Enviar solicitud"), "words that send stay never-click words (Teamtailor's own control is found by its declared action instead)");
});

test("the same employer's own posting: followed only from an allowed host, with the posting's own id, over https", () => {
  assert.deepEqual(postingIds("https://apply.workable.com/j/7046AFAA95"), ["7046AFAA95"]);
  assert.deepEqual(postingIds("https://x.teamtailor.com/jobs/8589342-category-retail"), ["8589342"]);
  assert.equal(samePostingRedirect("https://apply.workable.com/j/7046AFAA95", "https://apply.belmond.com/_/j/7046AFAA95", "https://apply.workable.com/j/7046AFAA95", ["apply.workable.com"]), true);
  assert.equal(samePostingRedirect("https://job-boards.greenhouse.io/cribl/jobs/5971252004", "https://cribl.io/job-detail/?gh_jid=5971252004", "https://job-boards.greenhouse.io/cribl/jobs/5971252004", ["job-boards.greenhouse.io"]), true);
  assert.equal(samePostingRedirect("https://apply.workable.com/j/7046AFAA95", "https://elsewhere.example/careers", "https://apply.workable.com/j/7046AFAA95", ["apply.workable.com"]), false, "no posting id: not the same posting");
  assert.equal(samePostingRedirect("https://evil.example/x", "https://apply.belmond.com/_/j/7046AFAA95", "https://apply.workable.com/j/7046AFAA95", ["apply.workable.com"]), false, "only a hop from an allowed host");
  assert.equal(samePostingRedirect("https://apply.workable.com/j/7046AFAA95", "http://apply.belmond.com/_/j/7046AFAA95", "https://apply.workable.com/j/7046AFAA95", ["apply.workable.com"]), false, "https only");
  assert.equal(samePostingRedirect("https://apply.workable.com/j/7046AFAA95", "https://www.linkedin.com/jobs/7046AFAA95", "https://apply.workable.com/j/7046AFAA95", ["apply.workable.com"]), false, "a denied host never");
});

test("dry-run upload answers (the strict bench only, never production): Teamtailor's presign and storage calls, Breezy's own upload call gets a simulated stored-file address; the address is never fetched; Greenhouse's S3 answer names the page's origin", () => {
  const req = (method, url, headers = {}, frameUrl = "https://degate.breezy.hr/p/x/apply") => ({ url: () => url, method: () => method, headers: () => headers, postDataBuffer: () => Buffer.from(""), frame: () => ({ url: () => frameUrl }) });
  const b = simulatedUpload(req("POST", "https://app.breezy.hr/api/portal/degate/upload"), "breezy");
  assert.equal(b.status, 200); assert.equal(JSON.parse(b.body).url, SIMULATED_FILE);
  assert.equal(b.headers["access-control-allow-origin"], "https://degate.breezy.hr"); assert.equal(b.headers["access-control-allow-credentials"], "true");
  assert.equal(simulatedUpload(req("POST", "https://app.breezy.hr/api/portal/degate/apply"), "breezy"), null, "only the upload path");
  assert.equal(simulatedUpload(req("POST", "https://app.breezy.hr/api/portal/degate/upload"), "greenhouse"), null, "only that provider's");
  assert.equal(simulatedFileRead(req("GET", `https://app.breezy.hr/resume/parse?friendly_id=degate&url=${encodeURIComponent(SIMULATED_FILE)}`)), true);
  // Teamtailor: its own site's presign call (only on the page's own host) names a storage address that does not exist; that address's
  // POST answers 204 with the stored file's Location; any read of it goes nowhere.
  const tp = simulatedUpload(req("POST", "https://careers.axpo.com/uploads/presigned_data", {}, "https://careers.axpo.com/jobs/8635826-x"), "teamtailor");
  assert.equal(JSON.parse(tp.body).url, "https://simulated-upload.invalid/"); assert.match(JSON.parse(tp.body).fields.key, /\$\{filename\}/);
  assert.equal(simulatedUpload(req("POST", "https://other.example/uploads/presigned_data", {}, "https://careers.axpo.com/jobs/8635826-x"), "teamtailor"), null, "only the page's own site");
  const ts = simulatedUpload({ ...req("POST", "https://simulated-upload.invalid/", {}, "https://careers.axpo.com/jobs/1"), postDataBuffer: () => Buffer.from('--b\r\nContent-Disposition: form-data; name="key"\r\n\r\nuploads/simulated/test-synthetic-resume.pdf\r\n--b--') }, "teamtailor");
  assert.equal(ts.status, 204); assert.match(ts.headers.location, /^https:\/\/simulated-upload\.invalid\/uploads/); assert.match(ts.headers["access-control-expose-headers"], /Location/);
  assert.equal(simulatedFileRead(req("GET", "https://simulated-upload.invalid/uploads/simulated/x.pdf")), true);
  const g = simulatedUpload(req("POST", "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/", {}, "https://job-boards.greenhouse.io/speechify/jobs/6229060004"), "greenhouse");
  assert.equal(g.headers["access-control-allow-origin"], "https://job-boards.greenhouse.io");
});

test("the 99% reading names a Workday guest application the dry run cannot start", () => {
  const c = d072.classify({ provider: "workday", url: "https://slihrms.wd3.myworkdayjobs.com/careers/job/X/Y_R-1", result: "fail", reason: "no_application_form_found", workday_start_blocked: true, diag: { forms: 0, inputs: 0 } });
  assert.deepEqual(c, { outcome: "fail", cause: "dry_run_blocks_send:workday_application_start" });
});

// ------------------------------------------------------------------------------------------------ the engine on recorded pages
test("Teamtailor: the Apply control found by its declared action whatever its words ('Skicka ansökan'), and by the Norwegian words; filled to Submit", { skip }, async () => {
  const sv = await run("teamtailor", "/tt/jobs/8510421-saljare");
  assert.equal(sv.result, "pass", JSON.stringify(sv).slice(0, 600));
  const no = await run("teamtailor", "/tt/jobs/8485375-utvikler");
  assert.equal(no.result, "pass", JSON.stringify(no).slice(0, 600));
  assert.deepEqual(posts, []);
});

test("Personio's Spanish Apply opens the form", { skip }, async () => {
  const r = await run("personio", "/personio/job/2831159");
  assert.equal(r.result, "pass", JSON.stringify(r).slice(0, 600));
});

test("SmartRecruiters: #st-apply ('Me interesa') is opened; the board's DataDome challenge is a kept wall with its hand-off; an expired posting is named closed", { skip }, async () => {
  const r = await run("smartrecruiters", "/sr/SGS/744000068788026");
  assert.equal(r.reason, "bot_check", JSON.stringify(r).slice(0, 600));
  assert.equal(r.d072.outcome, "b"); assert.equal(r.filled_count, 0, "nothing typed at a check");
  const gone = await run("smartrecruiters", "/sr/Securitas/744000156496379");
  assert.equal(gone.reason, "posting_closed", JSON.stringify(gone).slice(0, 400));
  assert.match(gone.d072.cause, /^posting_closed/);
});

test("Workday: its app drawn after 14 s is waited for (the sign-in wall, handed off); its 'page doesn't exist' is a closed posting", { skip, timeout: 120000 }, async () => {
  const r = await run("workday", "/wd/job/Chicago/Analyst_R2");
  assert.equal(r.reason, "login_required", JSON.stringify(r).slice(0, 600));
  assert.equal(r.d072.outcome, "b");
  const gone = await run("workday", "/wd/job/Chicago/Gone_R3");
  assert.equal(gone.reason, "posting_closed", JSON.stringify(gone).slice(0, 400));
});

test("Breezy's 'Position Closed' is a closed posting", { skip }, async () => {
  const r = await run("breezy", "/breezy/p/5f19dfaee2c3-coordinator");
  assert.equal(r.reason, "posting_closed", JSON.stringify(r).slice(0, 400));
});

test("Workable: the cookie layer over the form is closed with its Decline (never Accept); the drawn choice is then the person's question, not an option covered", { skip }, async () => {
  const r = await run("workable", "/wk/j/E647F1C914/apply/");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r).slice(0, 600));
  assert.deepEqual(r.needs.map((n) => n.reason), ["no_confirmed_answer"]);
  assert.equal(r.d072.outcome, "b");
});

test("Lever: a place lookup that answers after 8 s is waited for and the confirmed place chosen", { skip, timeout: 60000 }, async () => {
  const r = await run("lever", "/lever/acme/6c1d84b8-7305-42d7-bf69-5ace8a5b932f/apply");
  assert.equal(r.result, "pass", JSON.stringify(r).slice(0, 800));
});

test("Breezy: the board's own Phone Number takes the confirmed phone; the employer's copy in the same words is asked of the person (hand-off)", { skip }, async () => {
  const r = await run("breezy", "/breezy/p/913460a2bba7-inspector/apply");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r).slice(0, 600));
  assert.deepEqual(r.needs.map((n) => [n.label, n.reason]), [["Phone Number", "no_confirmed_answer"]]);
  assert.equal(r.d072.outcome, "b");
});

test("Recruitee: the Polish Submit ('Wyślij', type=submit) beside a button with no type is the form's Submit", { skip }, async () => {
  const r = await run("recruitee", "/rc/o/project-manager/c/new");
  assert.equal(r.result, "pass", JSON.stringify(r).slice(0, 600));
});

test("Greenhouse: a form that re-renders every input after load is read again and filled, not timed out", { skip, timeout: 60000 }, async () => {
  const t0 = Date.now();
  const r = await run("greenhouse", "/ghr/jobs/5312426");
  assert.equal(r.result, "pass", JSON.stringify(r).slice(0, 600));
  assert.ok(Date.now() - t0 < 40000, "not one 20 s timeout per field");
});

test("an export-control (EEO-like) choice with no option to decline is the person's answer, on the hand-off card", { skip }, async () => {
  const r = await run("greenhouse", "/gh-export/jobs/5364611008");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r).slice(0, 600));
  assert.equal(r.handoff.card, "ask_once");
  assert.equal(r.d072.outcome, "b");
});

test("a posting whose link the board sends to another board's 'not found' page is closed, not a redirect off the board", { skip }, async () => {
  const r = await run("lever", "/lv/cyara/aaa5ce22-78a3-4159-baa4-b7eb7994400d");
  assert.equal(r.reason, "posting_closed", JSON.stringify(r).slice(0, 400));
  assert.deepEqual(posts, [], "no page posted anything that reached the employer");
});

test("a page whose only form takes nothing from the approved application (a site search) is never the application: no Submit is reached", { skip }, async () => {
  const r = await run("greenhouse", "/careers/job-detail/5971252004");
  assert.notEqual(r.result, "pass", JSON.stringify(r).slice(0, 400));
  assert.equal(r.reason, "no_application_form_found", JSON.stringify(r).slice(0, 400));
});
