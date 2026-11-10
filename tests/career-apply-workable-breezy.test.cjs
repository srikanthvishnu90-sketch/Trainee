"use strict";
// b-workable-breezy (strict benchmark run 42735825405). Fixtures copy the real markup the run captured (GET only):
//  - Workable draws each Yes/No question as a fieldset[role=radiogroup] of role=radio options around radio inputs it marks
//    aria-hidden; the runner skipped them as hidden, so a required "Are you authorized to work in the U.S.?" was never seen
//    (5 of 20 postings stopped as form_rejects_value). Its dropdown is a read-only combobox whose hidden value input carries
//    `required`. Both are questions: asked when unanswered, filled and read back from an approved answer.
//  - Breezy shows some forms in steps (4 of 20 postings stopped as no_application_form_found): one visible "Continue"
//    (type=button, ng-click nextSection()) and "Submit Application" drawn but hidden until the last step. Each step is filled
//    and read back, its Continue pressed, and the Submit pressed once on the last step. A step that does not advance stops.
// Run: node --test tests/career-apply-workable-breezy.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// ---- Workable (markup from apply.workable.com/advisacare-2/j/E647F1C914 and blue-united-sourcing/j/575B5471B7) ----
const wText = (id, label, type = "text") => `<div class="styles--3IYUq styles--3JEd1"><label class="styles--3aPac"><span class="styles--1-9tY"><span class="styles--33eUF styles--2TdGW styles--3Y34Z"><strong class="styles--2kqW6">*</strong></span><span><span class="styles--QTMDv styles--2TdGW" id="${id}_label"><strong class="styles--2kqW6">${label}</strong></span></span></span><div data-role="illustrated-input" class="styles--1tBNa"><div class="styles--3qHIU"><input aria-required="true" id="${id}" maxlength="127" data-ui="${id}" name="${id}" aria-labelledby="${id}_label" required="" type="${type}" class="styles--2e9Cp" dir="auto" value=""></div></div></label></div>`;
const wRadio = (name, lid, label) => `<div class="styles--3IYUq styles--3JEd1"><div class="styles--3aPac"><span class="styles--1-9tY"><span class="styles--33eUF styles--2TdGW styles--3Y34Z"><strong class="styles--2kqW6">*</strong></span><span><span class="styles--QTMDv styles--2TdGW" id="${lid}_label"><strong class="styles--2kqW6">${label}</strong></span></span></span><div class="styles--Bnumk" style="--items-count: 2;"><fieldset role="radiogroup" data-ui="${name}" aria-labelledby="${lid}_label" class="styles--2-TzV"><div data-ui="option" class="styles--2uZxz" aria-labelledby="${lid}_label radio_label_${name}y" id="wrapper_${name}y" role="radio" aria-checked="false" aria-required="true" tabindex="0"><label><input aria-required="true" required="" id="${name}y" tabindex="-1" aria-hidden="true" type="radio" name="${name}" class="styles--2e9Cp" dir="auto" value="true"><div><div class="styles--3qHIU"><span class="styles--1h-sV styles--2TdGW" id="radio_label_${name}y">YES</span></div></div></label></div><div data-ui="option" class="styles--2uZxz" aria-labelledby="${lid}_label radio_label_${name}n" id="wrapper_${name}n" role="radio" aria-checked="false" aria-required="true" tabindex="-1"><label><input aria-required="true" required="" id="${name}n" tabindex="-1" aria-hidden="true" type="radio" name="${name}" class="styles--2e9Cp" dir="auto" value="false"><div><div class="styles--3qHIU"><span class="styles--1h-sV styles--2TdGW" id="radio_label_${name}n">NO</span></div></div></label></div></fieldset></div></div></div>`;
const wCombo = (name, label, opts) => `<div class="styles--3IYUq styles--aZ3VQ styles--3JEd1"><div class="styles--3aPac"><span class="styles--1-9tY"><span class="styles--33eUF styles--2TdGW styles--3Y34Z"><strong class="styles--2kqW6">*</strong></span><span><span class="styles--QTMDv styles--2TdGW" id="${name}_label"><strong class="styles--2kqW6">${label}</strong></span></span></span><div data-ui="${name}" class="styles--2N29s" data-open="false" data-input-type="select"><label class="styles--2bW8g"><div data-role="illustrated-input" class="styles--1tBNa styles--2JAdl"><div class="styles--3qHIU"><input id="input_${name}_input" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-owns="input_${name}_listbox" aria-controls="input_${name}_listbox" aria-autocomplete="list" autocomplete="off" aria-labelledby="${name}_label" placeholder="Select an option…" type="text" class="styles--2e9Cp" dir="auto" value="" readonly="true"></div></div></label><input name="${name}" required="" class="styles--3eBMS" tabindex="-1" aria-hidden="true" value="" style="opacity:0;width:1px;height:1px"><ul id="input_${name}_listbox" role="listbox" style="display:none">${opts.map((o) => `<li role="option">${o}</li>`).join("")}</ul></div></div></div>`;
const workable = (k) => `<!doctype html><html><body><h1>Physical Therapist - Application</h1><form id="f" novalidate>
${wText("firstname", "First name")}${wText("lastname", "Last name")}${wText("email", "Email", "email")}
<div><span id="cv_label"><strong>Resume</strong></span><input data-ui="resume" id="cv" type="file" aria-labelledby="cv_label"></div>
${wRadio("QA_8385838", "zTNX", "Are you authorized to work in the U.S.?")}
${wRadio("CA_6871", "bf4e", "Are you willing to undergo a background check?")}
${wCombo("CA_46635", "How did you hear about this opportunity?", ["Indeed", "Company website", "Other"])}
<button type="submit" data-ui="apply-button">Submit application</button></form><script>
// The page's own script: a choice ticks its radio and sets aria-checked; the dropdown opens its list and writes the chosen option
// into the read-only box and the hidden value input.
for (const w of document.querySelectorAll("[role=radio]")) w.querySelector("input").addEventListener("change", () => { for (const o of w.parentElement.querySelectorAll("[role=radio]")) o.setAttribute("aria-checked", String(o.querySelector("input").checked)); });
for (const c of document.querySelectorAll("[role=combobox]")) {
  const list = document.getElementById(c.getAttribute("aria-controls")), hid = c.closest("[data-ui]").querySelector("input[aria-hidden]");
  c.addEventListener("click", () => { list.style.display = "block"; c.setAttribute("aria-expanded", "true"); });
  for (const li of list.children) li.addEventListener("click", () => { c.value = li.textContent; hid.value = li.textContent; list.style.display = "none"; });
}
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), body = {};
  for (const [k, v] of fd) body[k] = typeof v === "string" ? v : v.name;
  await fetch("/submit/${k}", { method: "POST", body: JSON.stringify(body) });
  document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>';
});
</script></body></html>`;

// ---- Breezy (markup from north-wind-group.breezy.hr/p/ec078fe1ad56-.../apply and lexlegis.breezy.hr/p/8c74db48559e-.../apply) ----
const breezy = (k) => `<!doctype html><html><head><style>.ng-hide{display:none!important}</style></head><body><h1>Mechanical Design Engineer</h1>
<form name="form" novalidate class="ng-pristine ng-invalid">
<div data-section="application"><div class="section-header"><div class="file-input-container type"><input id="main-attachment" name="cResume" style="display:none;" type="file" required accept=".pdf, .doc, .docx"></div></div>
<div class="section"><div class="section-header"><h2 class="polygot">Personal Details</h2></div>
<h3><span class="polygot">Full Name</span><span class="required" title="Required">*</span></h3><input class="polygot" required ng-model="candidate.name" placeholder="Full Name" type="text" name="cName">
<h3><span class="polygot">Email Address</span><span class="required" title="Required">*</span></h3><input class="email-address polygot" required placeholder="Email Address" type="email" name="cEmail">
<h3><span class="polygot">Phone Number</span><span class="required" title="Required">*</span></h3><input class="phone-number polygot" required placeholder="Phone Number" type="text" name="cPhoneNumber"></div></div>
${k === "breezy_question" ? `<div data-section="q1" class="ng-hide"><ul><li><h3><span>What is your dream job?</span><span class="required" title="Required">*</span></h3><textarea name="section_1790498884469_question_1" required></textarea><input type="file" name="section_1790498884469_question_1_file" style="display:none"></li><li><h3><span>How many years have you worked in total?</span><span class="required" title="Required">*</span></h3><select name="section_1790498884469_question_0" required><option value="? undefined:undefined ?"></option><option value="&lt;2">&lt;2</option><option value="3 to 5">3 to 5</option></select></li></ul></div>` : ""}
<div data-section="submission" class="ng-hide"><h2><span class="polygot">You're nearly done</span></h2><div class="section-body">Click the Submit button below to finish.</div></div>
<div class="apply-container"><ul class="navigation-buttons">
<li class="apply-button ng-hide" id="li-back"><button class="button green large bzyButtonColor" type="button"><span class="polygot">Back</span></button></li>
<li class="apply-button" id="li-next"><button id="next" class="button green large bzyButtonColor" type="button"><span class="polygot">Continue</span></button></li>
<li class="apply-button ng-hide" id="li-submit"><button id="go" class="button green large bzyButtonColor" type="button"><span class="polygot">Submit Application</span></button></li></ul><div id="err" class="ng-hide error-container"><span class="error polygot">A resume is required</span></div></div></form>
<script>
// nextSection(): the page's own script checks the shown step and shows the next one; nothing is sent until apply().
const secs = [...document.querySelectorAll("[data-section]")];
let cur = 0;
document.getElementById("next").onclick = () => {
  ${k === "breezy_stuck" ? 'document.getElementById("err").classList.remove("ng-hide"); return;' : ""}
  if ([...secs[cur].querySelectorAll("[required]")].some((e) => e.type === "file" ? !e.files.length : !e.value || /undefined/.test(e.value))) return;
  secs[cur].classList.add("ng-hide"); cur++; secs[cur].classList.remove("ng-hide");
  if (cur === secs.length - 1) { document.getElementById("li-next").classList.add("ng-hide"); document.getElementById("li-submit").classList.remove("ng-hide"); }
  document.getElementById("li-back").classList.remove("ng-hide");
};
document.getElementById("go").onclick = async () => {
  const f = document.forms.form;
  await fetch("/submit/${k}", { method: "POST", body: JSON.stringify({ name: f.cName.value, email: f.cEmail.value, phone: f.cPhoneNumber.value, resume: (f.cResume.files[0] || {}).name }) });
  document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>';
};
</script></body></html>`;

const PAGES = { workable_ask: workable, workable_answered: workable, breezy_steps: breezy, breezy_question: breezy, breezy_stuck: breezy };
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return PAGES[k] ? res.writeHead(200, { "content-type": "text/html" }).end(PAGES[k](k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "wb-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const FACTS = { first_name: "Casey", last_name: "Example", full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100" };
const job = (k, ats, answers = {}) => {
  const p = { id: "wb-" + k, ats, url: `${base}/${k}`, facts: FACTS, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
const sent = (n, k) => posts.slice(n).filter((p) => p.url === `/submit/${k}`);

test("Workable: aria-hidden Yes/No radios and a required read-only dropdown are questions; unanswered, they are asked (not form_rejects_value)", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("workable_ask", "workable"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent(n, "workable_ask").length, 0, "nothing may be sent");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  assert.deepEqual(r.needs.map((x) => [x.label, x.reason]), [
    ["Are you authorized to work in the U.S.?", "no_confirmed_answer"],
    ["Are you willing to undergo a background check?", "no_confirmed_answer"],
    ["How did you hear about this opportunity?", "no_confirmed_answer"],
  ]);
  assert.deepEqual(r.needs[0].options, ["YES", "NO"]);
});

test("Workable: approved answers tick the hidden radios and set the dropdown, each read back; Submit sends exactly those values", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const answers = { "Are you authorized to work in the U.S.?": "Yes", "Are you willing to undergo a background check?": "No", "How did you hear about this opportunity?": "Other" };
  const r = await applyOne(browser, job("workable_answered", "workable", answers), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = sent(n, "workable_answered");
  assert.equal(mine.length, 1, "sent once");
  assert.deepEqual(JSON.parse(mine[0].body), { firstname: "Casey", lastname: "Example", email: "casey@example.invalid", QA_8385838: "true", CA_6871: "false", CA_46635: "Other" });
});

test("Breezy step form: each step filled and read back, Continue pressed, Submit Application pressed once on the last step", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const phases = [];
  const r = await applyOne(browser, job("breezy_steps", "breezy"), { stepTimeoutMs: 8000, retries: 0, audit: true, onPhase: (ph, a) => { phases.push([ph, a]); } });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = sent(n, "breezy_steps");
  assert.equal(mine.length, 1, "sent once");
  assert.deepEqual(JSON.parse(mine[0].body), { name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100", resume: "resume.pdf" });
  // The last look before the click still reads every step-1 field, though that step is hidden now.
  const held = Object.fromEntries(phases[0][1].fields.map((f) => [f.label, f.held]));
  assert.equal(held["Full Name"], "Casey Example");
  assert.equal(held["Email Address"], "casey@example.invalid");
  assert.ok(phases[0][1].fields.every((f) => !f.gone), JSON.stringify(phases[0][1].fields));
});

test("Breezy step form: a later step's required question with no confirmed answer is asked; nothing is sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("breezy_question", "breezy"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent(n, "breezy_question").length, 0, "nothing may be sent");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  // The written answer is asked by its heading; the optional attachment beside it is not a required upload.
  assert.deepEqual(r.needs.map((x) => [x.label, x.reason]), [["What is your dream job?", "no_confirmed_answer"], ["How many years have you worked in total?", "no_confirmed_answer"]]);
});

test("Breezy step form whose Continue does not advance: handed back, Continue not pressed again, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("breezy_stuck", "breezy"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent(n, "breezy_stuck").length, 0, "nothing may be sent");
  assert.equal(r.status, "not_submitted");
  assert.equal(r.reason, "field_not_filled", JSON.stringify(r));
  assert.equal(r.field, "step_did_not_advance");
  assert.deepEqual(r.needs, [{ label: "step_did_not_advance: A resume is required", reason: "form_rejects_value" }]);
});

test("an Address box takes only the person's confirmed address fact, never another fact in its place", () => {
  const { factValue } = require("../workers/career-browser/ats-fill.cjs");
  assert.equal(factValue("Address", { full_address: "1 Main St, Chicago, IL 60601", location: "Chicago, IL" }), "1 Main St, Chicago, IL 60601");
  assert.equal(factValue("Address", { location: "Chicago, IL", street_address: "1 Main St" }), undefined, "no full address confirmed: asked");
  assert.equal(factValue("Your residential street address", { street_address: "1 Main St" }), "1 Main St");
  assert.equal(factValue("Email address", { email: "a@b.c", full_address: "x" }), "a@b.c");
  assert.equal(factValue("Address of your reference", { full_address: "x" }), undefined);
});
