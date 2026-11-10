"use strict";
// Item 2, the batch of 60 on held-out postings (run 42854228451: 16/60 reached Submit, 0 duplicates, 0 dropped, 0 breaches,
// 2 mismatches). The runner-side gaps it showed, each on a local copy of the markup the run saw (no live site; nothing posted):
//   1. Personio: the resume read back as field_gone at the instant before Submit, though the board showed the file;
//   2. Greenhouse: 14/15 held "Country" (the phone's dial-code picker) although the approved payload says "Country: United States";
//   3. Breezy "Email Address" / "Phone Number", Lever "Current location" re-asked though the payload has Email, Phone, Location;
//   4. held questions named by the form's ids ("section_..._question_N", "cSummary", "eeoc.veteran_status") instead of its words;
//   5. a posting whose page answers 404 reported as retries_exhausted.
// The apply VM's own payload shape throughout: no facts, the approved answers by the label they were confirmed under (apply-vm.cjs
// prepare), so the fill sees exactly what the VM hands it.
//   node --test tests/career-batch60-gaps.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { factsFrom, factValue, decide, holdsApproved, fillForm, heldNow } = require("../workers/career-browser/ats-fill.cjs");
const { applyOne, payloadHash, NeedsUser } = require("../workers/career-browser/parallel-apply.cjs");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");
const { fieldMismatch } = require("../scripts/browser-eval/pool.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// The batch's TEST person as the queue payload carries it (scripts/browser-eval/batch60.cjs TEST_FIELDS), keyed as prepare keys it.
const ANSWERS = { "First Name": "Testy", "Last Name": "Example", "Full name": "Testy Example", Name: "Testy Example", Email: "dry-run@example.invalid", Phone: "+1 555 0100", Location: "Chicago, IL", Country: "United States" };

// ---- 3. contact facts under the form's own words ----------------------------------------------------------------------------
test("an approved contact answer is that confirmed fact under the form's own words for it, and only there", () => {
  const f = factsFrom({}, ANSWERS);
  assert.equal(f.email, "dry-run@example.invalid");
  assert.equal(f.phone, "+1 555 0100");
  assert.equal(f.location, "Chicago, IL");
  assert.equal(f.country, "United States");
  assert.equal(f.full_name, "Testy Example");
  assert.equal(factValue("Email Address", f), "dry-run@example.invalid");
  assert.equal(factValue("Phone Number", f), "+1 555 0100");
  assert.equal(factValue("Current location", f), "Chicago, IL");
  // "Address" is a confirmed address only: the place is not an address, so it stays the person's question.
  assert.equal(factValue("Address", f), undefined);
  assert.equal(factValue("Home Address", f), undefined);
  // Someone else's email is never the person's own.
  assert.equal(factValue("Email address of the employee who referred you", f), undefined);
  // A fact the person confirmed outright wins over an answer; two answers that disagree on one fact give none.
  assert.equal(factsFrom({ email: "own@example.invalid" }, ANSWERS).email, "own@example.invalid");
  assert.equal(factsFrom({}, { Name: "Testy Example", "Full name": "Someone Else" }).full_name, undefined);
  // A confirmed address answers "Address" only when there is one.
  assert.equal(factValue("Address", factsFrom({}, { ...ANSWERS, Address: "1 Test St, Chicago, IL" })), "1 Test St, Chicago, IL");
});

test("decide: 'Email Address', 'Phone Number', 'Current location' are filled from the approved answers; 'Address' is asked", () => {
  const ctx = { facts: factsFrom({}, ANSWERS), answers: ANSWERS };
  assert.deepEqual(decide({ label: "Email Address", kind: "text", required: true }, ctx), { status: "fill", value: "dry-run@example.invalid", source: "fact" });
  assert.deepEqual(decide({ label: "Phone Number", kind: "text", required: true }, ctx), { status: "fill", value: "+1 555 0100", source: "fact" });
  assert.deepEqual(decide({ label: "Current location", kind: "text", required: true, place: true }, ctx), { status: "fill", value: "Chicago, IL", source: "fact" });
  assert.deepEqual(decide({ label: "Address", kind: "text", required: true }, ctx), { status: "ask", reason: "no_confirmed_answer" });
  // A consent checkbox that happens to start with "Email" is never given the address.
  assert.equal(decide({ label: "Email me about future jobs", kind: "checkbox", required: false }, ctx).status, "skip");
});

// ---- 2. Greenhouse's phone Country from the approved "Country" answer --------------------------------------------------------
test("decide: the phone's Country picker takes the approved 'Country' answer through the dial-code rule, never as plain text", () => {
  const ctx = { facts: factsFrom({}, ANSWERS), answers: ANSWERS };
  assert.deepEqual(decide({ label: "Country", kind: "combobox", required: true, phoneCountry: true }, ctx),
    { status: "fill", value: "United States", pick: "phone_country", source: "answer", soft: true });
  // No approved phone to check the dial code against: asked.
  const noPhone = { ...ANSWERS }; delete noPhone.Phone;
  assert.deepEqual(decide({ label: "Country", kind: "combobox", required: true, phoneCountry: true }, { facts: factsFrom({}, noPhone), answers: noPhone }), { status: "ask", reason: "no_confirmed_answer" });
});

test("holdsApproved: the same answer by the rule it was picked by, never another country, place or state", () => {
  const facts = factsFrom({}, ANSWERS);
  assert.equal(holdsApproved({ label: "Country", kind: "combobox", phoneCountry: true, held: "United States +1" }, "United States", facts), true);
  assert.equal(holdsApproved({ label: "Country", kind: "combobox", phoneCountry: true, held: "Canada +1" }, "United States", facts), false);
  assert.equal(holdsApproved({ label: "Country", kind: "combobox", phoneCountry: true, held: "+1" }, "United States", facts), false);
  assert.equal(holdsApproved({ label: "Current location", kind: "text", place: true, held: "Chicago, Illinois, United States" }, "Chicago, IL", facts), true);
  assert.equal(holdsApproved({ label: "Current location", kind: "text", place: true, held: "Chicago, Ohio, United States" }, "Chicago, IL", facts), false);
  assert.equal(holdsApproved({ label: "Country", kind: "select", held: ["USA"] }, "United States", facts), true);
  assert.equal(holdsApproved({ label: "Country", kind: "select", held: ["United States Minor Outlying Islands"] }, "United States", facts), false);
  // Any other question: only the same words.
  assert.equal(holdsApproved({ label: "Why us?", kind: "select", held: ["USA"] }, "United States", facts), false);
});

// ---- browser fixtures ----------------------------------------------------------------------------------------------------
const GH = fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun/greenhouse-jobboards.html"), "utf8");
// Breezy's application (the markup of the batch's Breezy postings: each question a list item with its heading, the contact
// questions worded "Email Address", "Phone Number", "Address").
const BREEZY = `<!doctype html><html><head><meta charset="utf-8"><title>TEST Breezy</title></head><body><form name="application" action="/submit/breezy" method="post"><ul>
<li><h3>Full Name<span class="required">*</span></h3><input type="text" name="cName" required></li>
<li><h3>Email Address<span class="required">*</span></h3><input type="email" name="cEmail" required></li>
<li><h3>Phone Number<span class="required">*</span></h3><input type="tel" name="cPhone" required></li>
<li><h3>Address<span class="required">*</span></h3><input type="text" name="cAddress" required></li>
<li><h3>Resume<span class="required">*</span></h3><input type="file" name="cResume" required></li>
</ul><button type="submit">Submit Application</button></form></body></html>`;
// Lever's "Current location" (tests/career-lever-strict-fill.test.cjs: typing asks /searchLocations, a result click fills the hidden selectedLocation).
const lq = (label, field, req = true) => `<li class="application-question"><label><div class="application-label">${label}${req ? '<span class="required">✱</span>' : ""}</div><div class="application-field">${field}</div></label></li>`;
const LEVER = `<!doctype html><html><head><meta charset="utf-8"><title>TEST Lever</title></head><body><div class="application-page"><form method="POST" action="/submit/lever" id="application-form" enctype="multipart/form-data"><ul>
${lq("Resume/CV", '<input type="file" name="resume" id="resume-upload-input" required>')}
${lq("Full name", '<input type="text" name="name" required>')}${lq("Email", '<input type="email" name="email" required>')}${lq("Phone", '<input type="text" name="phone">', false)}
<li class="application-question"><label><div class="application-label">Current location<span class="required">✱</span></div><div class="application-field">
<input type="text" name="location" id="location-input" class="location-input" required="" autocomplete="off"><input type="hidden" name="selectedLocation" id="selected-location">
<div class="dropdown-container"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display:none">No location found. Try entering a different location</div></div></div></label></li>
<script>(() => { const i = document.getElementById("location-input"), r = document.querySelector(".dropdown-results"), h = document.getElementById("selected-location");
  let t; i.addEventListener("input", () => { h.value = ""; clearTimeout(t); t = setTimeout(async () => { const xs = await (await fetch("/searchLocations?text=" + encodeURIComponent(i.value))).json();
    r.innerHTML = ""; for (const x of xs) { const d = document.createElement("div"); d.className = "dropdown-location"; d.textContent = x.name; d.addEventListener("mousedown", (e) => { e.preventDefault(); i.value = x.name; h.value = JSON.stringify(x); r.innerHTML = ""; }); r.appendChild(d); } }, 150); }); })();</script>
</ul><button type="submit" class="postings-btn template-btn-submit">Submit application</button></form></div></body></html>`;

let browser, server, base, resume, rsha;
const posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }
    if (u.pathname === "/searchLocations") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify((u.searchParams.get("text") || "").toLowerCase().startsWith("chic") ? [{ name: "Chicago, Illinois, United States", id: "c1" }, { name: "Chicago Heights, Illinois, United States", id: "c3" }] : []));
    const page = { "/gh": GH, "/breezy": BREEZY, "/lever": LEVER }[u.pathname];
    if (page) return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (u.pathname === "/lever/gone") return res.writeHead(410, { "content-type": "text/html" }).end("<h1>Gone</h1>");
    res.writeHead(404, { "content-type": "text/html" }).end("<h1>Sorry, we couldn't find anything here</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b60gaps-"));
  resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = crypto.createHash("sha256").update(fs.readFileSync(resume)).digest("hex");
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true }); });

// The VM's pool payload (apply-vm.cjs prepare): facts {}, the approved answers by label. Driven to the instant before the click,
// where the dry run's audit reads what every filled field holds; the run stops there (nothing is clicked).
const vmPool = (k, answers = ANSWERS, ats = "greenhouse") => {
  const p = { id: "b60-" + k, ats, url: `${base}/${k}`, facts: {}, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
async function toSubmit(p) {
  let audit = null;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, audit: true, onPhase: async (ph, a) => { if (ph === "submitting") { audit = a; throw new NeedsUser("dry_run_stopped_before_submit"); } } });
  return { r, audit };
}

test("Greenhouse job-boards: the approved 'Country: United States' picks 'United States +1' on the phone's picker; reaches Submit; every field holds the payload", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const p = vmPool("gh");
  const { r, audit } = await toSubmit(p);
  assert.equal(r.reason, "dry_run_stopped_before_submit", JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  const phone = audit.fields.find((f) => f.label === "Country" && f.phoneCountry);
  assert.ok(phone, JSON.stringify(audit.fields));
  // The box shows only "+1"; what it holds is read from the option its menu marks as selected.
  assert.equal(phone.held, "United States +1");
  assert.deepEqual(audit.fields.map((f) => [f.label, fieldMismatch(f, p)]).filter(([, w]) => w), []);
  assert.equal(posts.length, n, "nothing posted");
});

test("Greenhouse job-boards: a +44 approved phone with 'Country: United States' leaves the phone's Country to the person, never Canada or another +1", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const { r } = await toSubmit(vmPool("gh", { ...ANSWERS, Phone: "+44 20 7946 0000" }));
  assert.equal(r.status, "not_submitted");
  const c = (r.needs || []).find((x) => x.label === "Country");
  assert.ok(c, JSON.stringify(r.needs));
  assert.equal(posts.length, n);
});

test("Breezy: 'Email Address' and 'Phone Number' take the approved Email and Phone; 'Address' alone is asked; nothing posted", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const { r } = await toSubmit(vmPool("breezy", ANSWERS, "breezy"));
  assert.equal(r.reason, "missing_required_answer", JSON.stringify({ reason: r.reason, needs: r.needs }));
  assert.deepEqual((r.needs || []).map((x) => x.label), ["Address"]);
  assert.equal(posts.length, n);
  // With a confirmed address it reaches Submit, and every field holds exactly the payload's value.
  const p = vmPool("breezy", { ...ANSWERS, Address: "1 Test St, Chicago, IL 60601" }, "breezy");
  const ok = await toSubmit(p);
  assert.equal(ok.r.reason, "dry_run_stopped_before_submit", JSON.stringify(ok.r.needs));
  assert.deepEqual(ok.audit.fields.map((f) => [f.label, f.source]).sort(), [["Address", "answer"], ["Email Address", "fact"], ["Full Name", "answer"], ["Phone Number", "fact"], ["Resume", "resume"]]);
  assert.deepEqual(ok.audit.fields.map((f) => [f.label, fieldMismatch(f, p)]).filter(([, w]) => w), []);
  assert.equal(posts.length, n);
});

test("Lever: 'Current location' takes the approved Location as Lever's own place (same city and state); reaches Submit with no mismatch", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const p = vmPool("lever", ANSWERS, "lever");
  const { r, audit } = await toSubmit(p);
  assert.equal(r.reason, "dry_run_stopped_before_submit", JSON.stringify({ reason: r.reason, needs: r.needs }));
  const loc = audit.fields.find((f) => f.label === "Current location");
  assert.ok(loc, JSON.stringify(audit.fields));
  assert.equal(loc.held, "Chicago, Illinois, United States");
  assert.deepEqual(audit.fields.map((f) => [f.label, fieldMismatch(f, p)]).filter(([, w]) => w), []);
  assert.equal(posts.length, n);
});

// ---- 4. a held question named in the form's own words ----------------------------------------------------------------------
// Breezy's markup as the diag run read it (slim-in, montage-marketing, arch, associated-services-inspections): each custom choice
// in li.question > div.multiplechoice with its h3 beside ul.options > li.option > label > input; the EEO survey the same with
// h3.polygot; veteran status a list of boxes after the survey's paragraphs; the summary a textarea alone in its div.section under
// div.section-header "Experience Summary*" (beside a hidden error line).
const opt = (name, v, i) => `<li class="option ng-scope"><label><input class="ng-pristine ng-invalid ng-invalid-required" required="" type="radio" value="${v}" name="${name}"><span>${v}</span></label></li>`;
const BREEZY_IDS = `<!doctype html><html><head><meta charset="utf-8"><title>TEST Breezy ids</title></head><body><form name="form" novalidate>
<div class="section"><div class="section-header">Experience Summary<span class="required">*</span></div><input type="hidden" name="x"><div class="form-divider"></div><div class="error-container ng-hide" style="display:none">A response is required</div><textarea class="textarea" name="cSummary" required></textarea></div>
<div class="section questions ng-scope"><ul>
<li class="question ng-scope"><h3>Education<span>*</span></h3><div class="multiplechoice ng-scope"><ul class="options">${["Bachelors", "Masters"].map((v, i) => opt("section__question_0", v, i)).join("")}</ul></div></li>
<li class="question ng-scope"><div class="question-body">This can include internships.</div><h3>Do you have any experience in delivering group sessions?<span>*</span></h3><div class="multiplechoice ng-scope"><ul class="options">${["Yes", "No"].map((v, i) => opt("section_1781270362859_question_1", v, i)).join("")}</ul></div></li>
</ul></div>
<div class="eeoc-form-container"><div class="section-header">We're an equal opportunity employer</div><div class="section questions"><ul>
<li class="question"><h3 class="polygot">Race or Ethnicity</h3><div class="multiplechoice"><ul class="options"><li class="option"><input required type="radio" id="race_white" value="white" name="race_ethnicity"><label for="race_white"><span class="polygot">White (not Hispanic or Latino)</span></label></li><li class="option"><input required type="radio" id="race_no" value="decline" name="race_ethnicity"><label for="race_no"><span class="polygot">I don't wish to answer</span></label></li></ul></div></li>
</ul></div>
<div class="section questions"><h3 class="polygot">Veteran Status</h3><p class="polygot">Protected veterans may have additional rights under USERRA.</p><p class="polygot">Please check one of the boxes below:</p><ul>
<li><input required type="radio" id="vet_yes" value="true" name="eeoc.veteran_status"><label for="vet_yes"><strong class="polygot">I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE</strong></label></li>
<li><input required type="radio" id="vet_no" value="false" name="eeoc.veteran_status"><label for="vet_no"><strong class="polygot">I AM NOT A PROTECTED VETERAN</strong></label></li></ul></div></div>
<button type="submit">Submit Application</button></form></body></html>`;

test("Breezy: held questions are named in the form's own words (its heading, its survey's words), never its ids", { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(BREEZY_IDS);
    const fr = await fillForm(page, { facts: {}, answers: ANSWERS, resumePath: resume });
    const labels = fr.needsUser.map((n) => n.label);
    assert.deepEqual(labels, ["Experience Summary", "Education", "Do you have any experience in delivering group sessions?", "Race or Ethnicity", "Veteran Status: Please check one of the boxes below:"], JSON.stringify(fr.needsUser));
    for (const l of labels) assert.doesNotMatch(l, /section_|cSummary|eeoc|race_ethnicity|question_\d/);
    // The options go with the question, in the form's words, so the person can answer it.
    assert.deepEqual(fr.needsUser.find((n) => n.label === "Education").options, ["Bachelors", "Masters"]);
    assert.ok(fr.needsUser.find((n) => n.label === "Race or Ethnicity").reason === "eeo_needs_your_choice");
    assert.deepEqual(fr.filled, [], "nothing is answered for the person");
  } finally { await page.close(); }
});

// ---- 1. Personio: the resume read back from the board's own file chip once its input is replaced ------------------------------
// The CV block as the batch's Personio postings draw it (diag run on otonomee/2881499: after the upload the board replaces the
// file input with a fresh empty one for another file and shows "resume.pdf ×" in the block; the input the fill tagged is gone).
// ?lost: the board then drops the file again (the chip disappears): the upload is not held, and the read-back says so.
const PERSONIO = (lost) => `<!doctype html><html><head><meta charset="utf-8"><title>TEST Personio</title></head><body><form class="DynamicForm_formContainer__PHnT_"><fieldset>
<div class="DynamicForm_fullWidth__vAHrb"><div class="DynamicForm_fieldWrapper__bb5uT"><label for="field-email" class="DynamicForm_formLabel__aTROQ form-label">Email<span aria-hidden="true">*</span><span class="sr-only"> (required)</span></label><div class="form-control"><input id="field-email" type="email" name="email" value=""></div></div></div>
<div class="DynamicForm_documentCategoryWrapper__Hwpk_ document-field-wrapper"><span class="form-label">CV<span aria-hidden="true">*</span><span class="sr-only"> (required)</span></span>
<div class="document-input-wrapper"><label for="cv" class="sr-only">Upload CV</label><input id="cv" type="file" name="cv" required><button type="button">Add file</button></div></div>
</fieldset><button type="submit">Submit application</button></form><script>
const wire = (inp) => inp.addEventListener("change", (e) => { const f = e.target.files[0]; if (!f) return; setTimeout(() => {
  const w = document.querySelector(".document-input-wrapper"), fresh = document.createElement("input"); fresh.type = "file"; fresh.id = "cv"; fresh.name = "cv";
  const chip = document.createElement("div"); chip.className = "document-chip"; chip.innerHTML = "<span>" + f.name + "</span><button type=button aria-label=Remove>×</button>";
  inp.replaceWith(fresh); w.prepend(chip); wire(fresh);
  ${lost ? 'setTimeout(() => chip.remove(), 400);' : ""} }, 150); });
wire(document.getElementById("cv"));
</script></body></html>`;

test("Personio: the board swaps its file input for a chip naming the resume; at the instant before Submit the upload reads back as held, not field_gone", { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(PERSONIO(false));
    const fr = await fillForm(page, { facts: {}, answers: ANSWERS, resumePath: resume });
    assert.deepEqual(fr.needsUser, []);
    const cv = fr.filled.find((f) => f.kind === "file");
    assert.ok(cv, JSON.stringify(fr.map));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate((q) => !!document.querySelector(`input[data-upmore-q="${q}"]`), cv.d.q), false, "the tagged input is gone");
    const held = await heldNow(page, fr.filled);
    const f = held.find((x) => x.kind === "file");
    assert.equal(f.held, "resume.pdf");
    assert.equal(f.gone, false);
    const p = { facts: {}, answers: ANSWERS, resume: { path: resume } };
    assert.deepEqual(held.map((x) => [x.label, fieldMismatch(x, p)]).filter(([, w]) => w), []);
  } finally { await page.close(); }
});

test("Personio: a resume the board dropped again (no chip, no input holding it) reads back as field_gone; never claimed attached", { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(PERSONIO(true));
    const fr = await fillForm(page, { facts: {}, answers: ANSWERS, resumePath: resume });
    const cv = fr.filled.find((f) => f.kind === "file");
    assert.ok(cv, JSON.stringify(fr.map));
    await page.waitForTimeout(900);
    const f = (await heldNow(page, fr.filled)).find((x) => x.kind === "file");
    assert.equal(f.gone, true);
    assert.equal(fieldMismatch(f, { facts: {}, answers: ANSWERS, resume: { path: resume } }), "field_gone");
  } finally { await page.close(); }
});

// ---- 5. a posting whose page is gone ------------------------------------------------------------------------------------------
// The apply VM, end to end with the real engine and a browser: the posting's own page answers 404 (or 410) on every try.
function vmRow(url, RSHA) {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000001", job_id: "lever:acme:1", company: "Acme", url, resume_sha256: RSHA, fields: [{ label: "Email", value: "t@example.invalid", factId: "f1" }] };
  const h = queueHash(payload);
  return { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), url, user_id: payload.user_id, payload, payload_hash: h, approval_hash: h, approval_id: crypto.randomUUID() };
}
async function vmOnce(row, RES, engine, opts = {}) {
  const RSHA = crypto.createHash("sha256").update(RES).digest("hex");
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "career_apply_vm_claim") return calls.filter((c) => c.name === name).length === 1 ? [row] : [];
    if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: RSHA, b64: RES.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    return {};
  };
  const w = createWorker({ rpc, browser, applyOne: engine, allowHosts: ["jobs.lever.co"], evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-closed-")), log: () => {}, ...opts });
  assert.equal(await w.tick(), 1);
  while (w.inflight.size) await new Promise((r) => setTimeout(r, 5));
  return calls;
}

test("apply VM: a posting whose page answers 404 or 410 ends not_submitted / POSTING_CLOSED with the status as proof; nothing posted", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const RES = Buffer.from("%PDF-1.4 TEST\n"), RSHA = crypto.createHash("sha256").update(RES).digest("hex");
  for (const [k, code] of [["lever/acme-closed", "404"], ["gone", "410"]]) {
    const calls = await vmOnce(vmRow(`${base}/${k === "gone" ? "lever/gone" : k}`, RSHA), RES, undefined, { retries: 1 });
    const done = calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args);
    assert.equal(done.length, 1);
    assert.equal(done[0].p_state, "not_submitted");
    assert.equal(done[0].p_reason, "POSTING_CLOSED", JSON.stringify(done[0]));
    assert.equal(done[0].p_evidence.error, `page_load_${code}`);
    assert.equal(done[0].p_evidence.nothing_sent, true);
    assert.equal(calls.filter((c) => c.name === "career_apply_host_refused_for").length, 0, "a closed posting does not hold the portal off");
  }
  assert.equal(posts.length, n);
});

test("apply VM: a page that failed to load for any other reason is still 'did not load' (retries_exhausted), never called closed", async () => {
  const RES = Buffer.from("%PDF-1.4 TEST\n"), RSHA = crypto.createHash("sha256").update(RES).digest("hex");
  for (const error of ["page_load_500", "page_load_none", "net::ERR_TIMED_OUT"]) {
    const engine = async () => ({ status: "not_submitted", reason: "retries_exhausted", error, attempts: 3, ms: 3 });
    const calls = await vmOnce(vmRow("https://jobs.lever.co/acme/60caa9d6-f12b-4e0e-b359-db7e60644bc5", RSHA), RES, engine);
    const done = calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args);
    assert.equal(done[0].p_reason, "retries_exhausted");
    assert.equal(done[0].p_evidence.error, error);
  }
});
