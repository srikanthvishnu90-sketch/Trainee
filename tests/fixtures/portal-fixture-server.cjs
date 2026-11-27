// Fixture pages for tests/career-portal-browser.test.cjs — served by THIS
// standalone process, never by the test process itself. Why: module 150's
// synchronous bridge (Atomics.wait) blocks the caller's event loop while a
// command is in flight, so a fixture server living in the test process
// could never answer Chromium's requests and every navigation timed out
// (BUG-045). Prints "FIXTURE_PORT <n>" on stdout once listening.
"use strict";
const http = require("node:http");

const GH_FORM = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">
  <div><label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required></div>
  <div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div><label for="location">Location (City)</label><input id="location" name="location" type="text"></div>
  <div><label for="school">School</label><input id="school" name="school" type="text"></div>
  <div><label for="degree">Degree</label><input id="degree" name="degree" type="text"></div>
  <div><label for="fos">Field of Study</label><input id="fos" name="field_of_study" type="text"></div>
  <div><label for="gpa">GPA</label><input id="gpa" name="gpa" type="text"></div>
  <div><label for="gy">Graduation Year</label><input id="gy" name="graduation_year" type="text"></div>
  <div><label for="country">Country</label>
    <select id="country" name="country"><option value="">Select...</option><option>United States</option><option>Canada</option></select></div>
  <div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
  <div><label for="wa">Are you authorized to work in the US? *</label>
    <select id="wa" name="work_authorization" required><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select></div>
  <div><label for="sp">Will you require sponsorship? *</label>
    <select id="sp" name="sponsorship" required><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select></div>
  <div><label for="gender">Gender (voluntary)</label>
    <select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></div>
  <div><label><input id="certify" name="certify_true" type="checkbox" required> I certify the above is true *</label></div>
  <button type="submit" id="submit-btn">Submit application</button>
</form></body></html>`;

const CAPTCHA_OPEN = `<!doctype html><html><head><title>Apply (TEST fixture)</title></head><body>
<h1>Apply</h1><p>Please verify you are human to continue.</p>
<div class="g-recaptcha" data-sitekey="TEST-KEY-NEVER-SOLVED"></div>
<form><div><label for="email">Email *</label><input id="email" type="email" required></div>
<button type="submit">Submit application</button></form></body></html>`;

const CAPTCHA_REVIEW_STEP1 = `<!doctype html><html><head><title>Apply step 1 (TEST fixture)</title></head><body>
<h1>Apply — step 1</h1>
<form id="f"><div><label for="first_name">First Name *</label><input id="first_name" type="text" required></div>
<div><label for="last_name">Last Name *</label><input id="last_name" type="text" required></div>
<div><label for="email">Email *</label><input id="email" type="email" required></div>
<button type="button" id="next-btn">Next</button></form>
<script>document.getElementById('next-btn').addEventListener('click', () => {
  document.body.innerHTML = '<h1>Review your application</h1><p>Please verify you are human.</p>' +
    '<div class="h-captcha" data-sitekey="TEST-KEY-NEVER-SOLVED"></div>' +
    '<button type="submit">Submit application</button>';
});</script></body></html>`;

// Submit-landing fixtures for the confirmation-capture tests: same form as
// GH_FORM, but the submit button swaps the page (SPA-style) to a landing
// page — one with a real employer confirmation, one deliberately ambiguous.
const FORM_FIELDS = `
  <div><label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required></div>
  <div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div><label for="location">Location (City)</label><input id="location" name="location" type="text"></div>
  <div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
  <div><label for="wa">Are you authorized to work in the US? *</label>
    <select id="wa" name="work_authorization" required><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select></div>
  <div><label for="sp">Will you require sponsorship? *</label>
    <select id="sp" name="sponsorship" required><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select></div>
  <div><label><input id="certify" name="certify_true" type="checkbox" required> I certify the above is true *</label></div>`;

const GH_CONFIRM = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="button" id="submit-btn">Submit application</button>
</form>
<script>document.getElementById('submit-btn').addEventListener('click', () => {
  document.body.innerHTML = '<h1>Thank you for applying</h1><p>Your application has been received.</p><p>Application ID: TEST-APP-12345</p>';
});</script></body></html>`;

const GH_AMBIGUOUS = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="button" id="submit-btn">Submit application</button>
</form>
<script>document.getElementById('submit-btn').addEventListener('click', () => {
  document.body.innerHTML = '<h1>Done</h1><p>You may now close this window.</p>';
});</script></body></html>`;

// D8 fixture: same confirm form, but the EEO select offers the decline
// default only in the "Prefer not to answer" wording (no exact match for
// 149's "Decline to self-identify" string).
const GH_EEO_VARIANT = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <div><label for="gender">Gender (voluntary)</label>
    <select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Prefer not to answer</option></select></div>
  <button type="button" id="submit-btn">Submit application</button>
</form></body></html>`;

// D9 fixture (Lever custom-card shape): the card question has NO <label>;
// its human text is the card's .question heading, and the input's name is
// a machine name (cards_<id>_field<n>) — the ask must quote the heading.
const LEVER_CARD = `<!doctype html><html><head><title>Apply (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="card"><div class="question">Are you willing to relocate to New York?</div>
    <div class="field"><input name="cards_9f2abc_field0" type="text" required></div></div>
  <button type="submit" id="submit-btn">Submit application</button>
</form></body></html>`;

// Depth-E fixture (live Neighbor/Lever shape, 2026-10-16): a Lever card
// whose question is answered by a RADIO GROUP — both radios share one
// machine name (cards[<uuid>][field0]), values Yes/No, no ids. Discovery
// built a bare name selector for the group, which matches BOTH inputs;
// the helper's strict elementHandle() threw and the whole drive died as
// DRIVER_ERROR before a single field was classified.
const LEVER_RADIO = `<!doctype html><html><head><title>Apply (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">
  <div><label for="name">Full Name *</label><input id="name" name="name" type="text" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div class="card"><div class="question">Are you legally authorized to work in the United States?</div>
    <ul>
      <li><label><input type="radio" name="cards[fcd87568-ba1e-4bfd-8962-24d1142d97d6][field0]" value="Yes" required> Yes</label></li>
      <li><label><input type="radio" name="cards[fcd87568-ba1e-4bfd-8962-24d1142d97d6][field0]" value="No" required> No</label></li>
    </ul></div>
  <button type="submit" id="submit-btn">Submit application</button>
</form></body></html>`;

// D11 fixture (BUG-207): a Greenhouse-shaped form whose framework REMOUNTS
// its fields — the first input/change on a field replaces its DOM node with
// a fresh empty clone ~300ms later (once per field), exactly the loss the
// 2026-10-15 live run proved (fills "successful", readback empty). A
// fill-once driver loses every value; a fill-then-readback-per-field driver
// detects the loss and re-fills the fresh node.
const REMOUNT_SCRIPT = (forever) => `<script>
const __replaced = new Set();
function __remount(el) {
  const id = el.id; if (!id) return;
  ${forever ? "" : "if (__replaced.has(id)) return; __replaced.add(id);"}
  setTimeout(() => {
    const cur = document.getElementById(id); if (!cur || cur !== el) return;
    const clone = cur.cloneNode(cur.tagName === 'SELECT');
    if (clone.tagName === 'SELECT') clone.selectedIndex = 0;
    cur.replaceWith(clone);
  }, 300);
}
document.addEventListener('input', (e) => __remount(e.target), true);
document.addEventListener('change', (e) => __remount(e.target), true);
</script>`;

const GH_REMOUNT = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="submit" id="submit-btn">Submit application</button>
</form>${REMOUNT_SCRIPT(false)}</body></html>`;

// D11/D13 end-to-end fixture: the remount NEVER stops — no fill can ever
// persist. The product must end at a typed INCOMPLETE_PAYLOAD stop and the
// submit control must never be clicked, however it was approved.
const GH_REMOUNT_FOREVER = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="submit" id="submit-btn">Submit application</button>
</form>${REMOUNT_SCRIPT(true)}</body></html>`;

// D12 fixture (BUG-208): the Labelbox shape end to end — the submit click
// lands on the SAME still-open form, now showing required-field errors,
// with the posting's own prose (including the token "security" right after
// the word "application", plus unrelated IDs) still on the page. A
// confirmation minted from this page is a manufactured false SUBMITTED.
const GH_FALSE_CONFIRM = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Cyber Security Intern</h1>
<p>Job ID: 5442881008. Our application security team reviews every submission
for tracking quality. This role works on application security tooling and
reference architectures for customer data protection.</p>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="button" id="submit-btn">Submit application</button>
</form>
<script>document.getElementById('submit-btn').addEventListener('click', () => {
  const errs = document.createElement('div');
  errs.innerHTML = '<p class="error">First Name is required</p><p class="error">Email is required</p>';
  document.querySelector('form').prepend(errs);
  window.scrollTo(0, 0);
});</script></body></html>`;

// Delayed board-wide reset fixture (the live Labelbox shape, 2026-10-15):
// every fill verifies, then — shortly after the resume upload — the board
// re-renders and the text/select fields filled BEFORE the upload lose
// their values. Per-field verification cannot see a loss that happens
// later; only a doorstep readback + repair pass recovers it, and the
// required-field gate must stop the run if the repair does not hold.
const GH_REMOUNT_LATE = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">${FORM_FIELDS}
  <button type="submit" id="submit-btn">Submit application</button>
</form>
<script>
let __resetArmed = false;
let __resetDone = false;
document.addEventListener('change', (e) => {
  if (__resetDone || !e.target) return;
  if (e.target.type === 'file') { __resetArmed = true; return; }
  if (!__resetArmed) return;
  // Deterministic delayed reset (the live Labelbox shape): the board
  // wipes every filled field once the driver moves past the resume
  // upload — fired by the NEXT field's change event, never by a clock,
  // so the loss cannot be outrun by a fast or slow driver.
  __resetDone = true;
  document.querySelectorAll('input[type=text], input[type=email], input[type=tel], select').forEach((el) => {
    if (!el.id) return;
    const clone = el.cloneNode(el.tagName === 'SELECT');
    if (clone.tagName === 'SELECT') clone.selectedIndex = 0;
    // A real board remount re-creates inputs EMPTY (the live Labelbox
    // reset dropped the values outright). cloneNode alone would carry
    // the filled value attribute over — the clone must be cleared, or
    // the "wipe" silently keeps every text value and nothing is lost.
    else { clone.removeAttribute('value'); clone.value = ''; }
    el.replaceWith(clone);
  });
}, true);
</script></body></html>`;

// Location-widget fixture (BUG-207, live Greenhouse shape): the location
// field is a react-select async component — the visible input
// (class select__input) is only a SEARCH BOX; typed text is not a value
// and is cleared by the widget; the field's value exists only as the
// component's chosen .select__single-value after an option is picked.
// A driver that fills/reads the box's text proves nothing.
const GH_TYPEAHEAD = `<!doctype html><html><head><title>Job Application (TEST fixture)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">
  <div><label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required></div>
  <div><label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><label for="candidate-location">Location (City) *</label>
    <div class="select__container"><div class="select__control"><div class="select__value-container">
      <div class="select__single-value" style="display:none"></div>
      <input id="candidate-location" class="select__input" type="text" autocomplete="off">
    </div></div>
    <div class="select__menu" style="display:none">
      <div class="select__option">Chicago, IL, United States</div>
      <div class="select__option">Chicago Heights, IL, United States</div>
    </div></div></div>
  <div><label for="country">Country *</label>
    <div class="select__container"><div class="select__control"><div class="select__value-container">
      <div class="select__single-value" style="display:none"></div>
      <input id="country" class="select__input" type="text" autocomplete="off">
    </div></div>
    <div class="select__menu" style="display:none">
      <div class="select__option">United States</div>
      <div class="select__option">Canada</div>
    </div></div></div>
  <div><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></div>
  <div><label><input id="certify" name="certify_true" type="checkbox" required> I certify the above is true *</label></div>
  <button type="submit" id="submit-btn">Submit application</button>
</form>
<script>
document.querySelectorAll('.select__container').forEach((c) => {
  const inp = c.querySelector('.select__input');
  const menu = c.querySelector('.select__menu');
  const sv = c.querySelector('.select__single-value');
  inp.addEventListener('input', () => { menu.style.display = inp.value ? 'block' : 'none'; });
  menu.querySelectorAll('.select__option').forEach((o) => o.addEventListener('click', () => {
    sv.textContent = o.textContent; sv.style.display = 'block'; inp.value = ''; menu.style.display = 'none';
  }));
});
</script></body></html>`;

// CURRENT-UI fixture (BUG-237 / FR-395): the Greenhouse application
// form as captured live on 2026-10-15 (probes of the live liontree
// board, job-boards.greenhouse.io). This is the shape that defeated
// the drive while GH_TYPEAHEAD above (the OLD shape, with an outer
// .select__container the readback climbs to) kept passing:
//   - EVERY widget is a react-select v5 combobox: .select__control >
//     .select__value-container > (.select__placeholder +
//     .select__input-container[data-value] > input.select__input
//     [role=combobox]) + .select__indicators. There is NO
//     .select__container and NO native <select> anywhere.
//   - the chosen value renders as .select__single-value INSIDE the
//     value container — a sibling of the input container, never
//     inside it;
//   - the country widget's options read "United States +1" but its
//     single-value renders ONLY the dial code ("+1");
//   - hidden remix-css *-requiredInput dummy inputs sit after widgets;
//   - typed search text is discarded on blur unless an option was
//     picked; options are local (no network);
//   - the resume input is visually-hidden inside an Attach
//     button-container, present at rest.
// The late-file variant removes the resume input on the first form
// input and returns it only when the Attach control is engaged —
// the 18-of-24-boards file_input_not_mounted shape.
const GHX_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function ghxWidget(id, label, required, options, widgetOpts) {
  const opts = options.map((o, i) => {
    const text = Array.isArray(o) ? o[0] : o;
    const sv = Array.isArray(o) ? ` data-sv="${o[1]}"` : "";
    return `<div class="select__option remix-css-18355b6-option" id="react-select-${id}-option-${i}" role="option"${sv}>${text}</div>`;
  }).join("");
  const asyncAttr = widgetOpts && widgetOpts.async ? ` data-ghx-async="1"` : "";
  return `<div class="ghx-field"${asyncAttr}><label id="${id}-label" for="${id}">${label}${required ? " *" : ""}</label>
  <div><div class="select__control remix-css-13cymwt-control"><div class="select__value-container remix-css-hlgwow">
    <div class="select__placeholder remix-css-1jqq78o-placeholder" id="react-select-${id}-placeholder">Select...</div>
    <div class="select__input-container remix-css-19bb58m" data-value=""><input class="select__input" id="${id}" type="text" role="combobox" aria-expanded="false" aria-haspopup="true" aria-labelledby="${id}-label" autocomplete="off" value=""></div>
  </div><div class="select__indicators remix-css-1wy0on6"><button type="button" class="icon-button icon-button--sm" aria-label="Toggle flyout" tabindex="-1"></button></div></div>
  <div class="select__menu remix-css-sohgwi-menu" style="display:none"><div class="select__menu-list remix-css-qr46ko" id="react-select-${id}-listbox" role="listbox">${opts}</div></div></div>
  <input class="remix-css-1a0ro4n-requiredInput" tabindex="-1" aria-hidden="true" value=""></div>`;
}
function ghCurrentPage(lateFile) {
  return `<!doctype html><html><head><title>Job Application (TEST fixture — current Greenhouse UI shape, captured 2026-10-15)</title></head><body>
<h1>Software Engineering Intern</h1>
<form id="application" method="post" action="/never-submit">
  <div><label for="first_name">First Name *</label><input id="first_name" type="text" class="input input__single-line" required></div>
  <div><label for="last_name">Last Name *</label><input id="last_name" type="text" class="input input__single-line" required></div>
  <div><label for="email">Email *</label><input id="email" type="email" class="input input__single-line" required></div>
  ${ghxWidget("country", "Country", false, [["United States +1", "+1"], ["Canada +1", "+1"], ["United Kingdom +44", "+44"], ["Germany +49", "+49"]])}
  <div><label for="phone">Phone</label><input id="phone" type="tel" class="input input__single-line"></div>
  <div><span>Resume/CV *</span><div class="button-container"><div class="secondary-button"><div><button type="button" class="btn btn--pill" data-ghx-attach="1">Attach</button><label class="visually-hidden" for="resume">Attach</label><input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" required></div></div></div></div>
  ${ghxWidget("school--0", "School", true, ["DePaul University", "Northwestern University", "University of Chicago", "Other"])}
  ${ghxWidget("degree--0", "Degree", true, ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctor of Philosophy (PhD)"])}
  ${ghxWidget("discipline--0", "Discipline", false, ["Computer Science", "Computer Science and Finance", "Finance", "Economics"], { async: true })}
  ${ghxWidget("start-month--0", "Start date month", false, GHX_MONTHS)}
  <div><label for="start-year--0">Start date year *</label><input id="start-year--0" type="number" class="input input__single-line" required></div>
  ${ghxWidget("end-month--0", "End date month", false, GHX_MONTHS)}
  <div><label for="end-year--0">End date year *</label><input id="end-year--0" type="number" class="input input__single-line" required></div>
  ${ghxWidget("question_13006485007", "Do you require visa sponsorship to work in the United States?", true, ["Yes", "No"])}
  ${ghxWidget("gender", "Gender", false, ["Male", "Female", "Decline To Self Identify"])}
  ${ghxWidget("hispanic_ethnicity", "Are you Hispanic/Latino?", false, ["Yes", "No", "Decline to self-identify"])}
  ${ghxWidget("veteran_status", "Veteran Status", false, ["I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran", "I don't wish to answer"])}
  <div><label><input id="certify" name="certify_true" type="checkbox" required> I certify the above is true *</label></div>
  <button type="submit" id="submit-btn">Submit application</button>
</form>
<script>
document.querySelectorAll('.ghx-field').forEach((wrap) => {
  const inp = wrap.querySelector('.select__input');
  const menu = wrap.querySelector('.select__menu');
  const vc = wrap.querySelector('.select__value-container');
  const ph = wrap.querySelector('.select__placeholder');
  const ic = wrap.querySelector('.select__input-container');
  const all = () => Array.from(wrap.querySelectorAll('.select__option'));
  const open = () => { menu.style.display = 'block'; inp.setAttribute('aria-expanded', 'true'); filter(); churn(); };
  const close = () => { menu.style.display = 'none'; inp.setAttribute('aria-expanded', 'false'); };
  const filter = () => { const q = inp.value.toLowerCase(); all().forEach((o) => { o.style.display = o.hasAttribute('data-ghx-pending') ? 'none' : (o.textContent.toLowerCase().includes(q) ? 'block' : 'none'); }); };
  const pick = (o) => {
    let sv = vc.querySelector('.select__single-value');
    if (!sv) { sv = document.createElement('div'); sv.className = 'select__single-value remix-css-1dimb5e-singleValue'; vc.insertBefore(sv, ic); }
    sv.textContent = o.getAttribute('data-sv') || o.textContent;
    sv.style.display = 'block';
    if (ph) ph.style.display = 'none';
    inp.value = ''; ic.setAttribute('data-value', '');
    close();
  };
  // Live-tenancy realism (BUG-237): React re-creates the option nodes
  // shortly after the menu opens — a driver that marks a node in one
  // call and clicks it in another finds it gone. Picks here are
  // delegation-based so the churn changes nothing for a driver that
  // acts on live nodes; the churn exists so the fixture's DOM behaves
  // like the tenants', not like a static page.
  const list = wrap.querySelector('.select__menu-list');
  let churned = false;
  const churn = () => { if (churned) return; churned = true; setTimeout(() => { all().forEach((o) => { const c = o.cloneNode(true); o.replaceWith(c); }); filter(); }, 250); };
  inp.addEventListener('click', open);
  inp.addEventListener('input', () => { ic.setAttribute('data-value', inp.value); open(); });
  list.addEventListener('mousedown', (e) => { const o = e.target.closest('.select__option'); if (o) { e.preventDefault(); pick(o); } });
  list.addEventListener('click', (e) => { const o = e.target.closest('.select__option'); if (o) pick(o); });
  // Async option service (BUG-237, captured live 2026-10-15): the
  // discipline/school widgets answer from a remote search — a loading
  // indicator spins and NO options exist for seconds after the menu
  // opens. 7s here: longer than the pre-fix driver's whole poll
  // budget, so the old drive fails this fixture and the ladder drive
  // (segment/first-word retype + a poll that waits out the load)
  // passes it.
  if (wrap.hasAttribute('data-ghx-async')) {
    let loading = false;
    let timer = null;
    const ind = wrap.querySelector('.select__indicators');
    const spin = document.createElement('span');
    spin.className = 'select__loading-indicator remix-css-o9ehiq-loadingIndicator';
    spin.style.display = 'none';
    if (ind) ind.appendChild(spin);
    all().forEach((o) => o.setAttribute('data-ghx-pending', '1'));
    filter();
    // The board's search restarts on every new query: a driver that
    // retypes mid-load pushes the answer out by the full delay again
    // (the live degree search answered in 6-10s; a retype at 5s made
    // it land past the old driver's whole budget).
    const armLoad = () => { loading = true; spin.style.display = 'inline-block';
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { spin.style.display = 'none'; all().forEach((o) => o.removeAttribute('data-ghx-pending')); filter(); }, 7000); };
    inp.addEventListener('click', armLoad);
    inp.addEventListener('input', armLoad);
  }
  inp.addEventListener('blur', () => { setTimeout(() => { if (!vc.querySelector('.select__single-value')) { inp.value = ''; ic.setAttribute('data-value', ''); } close(); }, 0); });
});
const attachBtn = document.querySelector('[data-ghx-attach]');
if (attachBtn) attachBtn.addEventListener('click', () => {
  if (!document.getElementById('resume')) {
    const inp = document.createElement('input');
    inp.id = 'resume'; inp.className = 'visually-hidden'; inp.type = 'file'; inp.setAttribute('accept', '.pdf,.doc,.docx,.txt,.rtf'); inp.required = true;
    attachBtn.parentElement.appendChild(inp);
  }
});
${lateFile ? "document.addEventListener('input', () => { const r = document.getElementById('resume'); if (r) r.remove(); }, { capture: true, once: true });" : ""}
</script></body></html>`;
}
const GH_CURRENT = ghCurrentPage(false);
const GH_CURRENT_LATE_FILE = ghCurrentPage(true);

// The resume input is present at discovery and REMOVED shortly after
// load — the live boards' mount/unmount churn in miniature. A driver
// that lets the file fill throw loses the whole run; the honest end is
// a recorded fill failure and the completeness gate's stop.
const GH_FILE_VANISH = GH_FORM.replace(
  "</body>",
  `<script>document.getElementById('email').addEventListener('input', () => { const r = document.getElementById('resume'); if (r) r.remove(); });</script></body>`
);

// The resume input is REMOUNTED under a fresh id once filling starts
// (the live boards regenerate input ids when the form re-renders): the
// discovery-time selector goes stale, and the fill must re-discover
// the live input rather than wait on a node that will never return.
const GH_FILE_REMOUNT = GH_FORM.replace(
  "</body>",
  `<script>document.getElementById('email').addEventListener('input', () => { const r = document.getElementById('resume'); if (r) { const n = document.createElement('input'); n.type = 'file'; n.id = 'resume-file-2'; n.name = 'resume'; n.required = true; r.replaceWith(n); } });</script></body>`
);

const pages = { "/gh-form": GH_FORM, "/captcha-open": CAPTCHA_OPEN, "/captcha-review": CAPTCHA_REVIEW_STEP1, "/gh-confirm": GH_CONFIRM, "/gh-ambiguous": GH_AMBIGUOUS, "/gh-eeo-variant": GH_EEO_VARIANT, "/lever-card": LEVER_CARD, "/lever-radio": LEVER_RADIO, "/gh-remount": GH_REMOUNT, "/gh-remount-forever": GH_REMOUNT_FOREVER, "/gh-false-confirm": GH_FALSE_CONFIRM, "/gh-remount-late": GH_REMOUNT_LATE, "/gh-typeahead": GH_TYPEAHEAD, "/gh-file-vanish": GH_FILE_VANISH, "/gh-file-remount": GH_FILE_REMOUNT, "/gh-current": GH_CURRENT, "/gh-current-late-file": GH_CURRENT_LATE_FILE };const server = http.createServer((req, res) => {
  // D1 fixture: an allowed-host page that server-redirects OFF the
  // allowlist (the HRT Greenhouse -> employer-site shape). The target is
  // a .invalid host: pre-fix Chromium burned minutes on proxy/DNS; the
  // fixed driver's navigation gate aborts the hop before any network.
  if (req.url === "/redirect-offlist") {
    res.writeHead(302, { Location: "http://employer.example.invalid/apply" });
    res.end(); return;
  }
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
  res.end(body || "<html><body>not found</body></html>");
});
// WO-009b-3: offline saved-page harness. Legacy routes above remain unchanged.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const families = {
  greenhouse: "greenhouse.io",
  lever: "lever.co",
  ashby: "ashbyhq.com",
  smartrecruiters: "smartrecruiters.com",
};
function loadSnapshots(root) {
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) {
    return {
      status: "NOT_RUN",
      expected: 17,
      real_count: 0,
      snapshots: [],
      handoffs: [],
      unavailable: [],
    };
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")),
    snapshots = [],
    handoffs = [],
    unavailable = [],
    ids = new Set(),
    urls = new Set();
  const rendered = (manifest.forms || []).some((r) =>
      ["application", "no_application", "blocked_403"].includes(r.status)
    ),
    expected = rendered ? 17 : 24;
  for (const row of manifest.forms || []) {
    if (
      !["captured", "application", "no_application", "blocked_403"].includes(
        row.status,
      )
    ) continue;
    if (!/^[a-z0-9_-]{1,160}$/.test(row.id) || ids.has(row.id)) {
      throw Error("CAPTURE_ID_INVALID");
    }
    ids.add(row.id);
    if (row.synthetic === true) throw Error("SYNTHETIC_CAPTURE_NOT_REAL");
    const u = new URL(row.source_url), suffix = families[row.family];
    u.hash = "";
    if (
      !suffix || u.protocol !== "https:" || u.username || u.password ||
      !(u.hostname === suffix || u.hostname.endsWith("." + suffix)) ||
      urls.has(u.href)
    ) throw Error("CAPTURE_PROVENANCE_INVALID");
    urls.add(u.href);
    const read = (name) => {
      if (name !== path.basename(name) || !name.startsWith(row.id + ".")) {
        throw Error("CAPTURE_PATH_INVALID");
      }
      const p = path.join(root, name);
      if (fs.lstatSync(p).isSymbolicLink()) throw Error("CAPTURE_SYMLINK");
      return fs.readFileSync(p);
    };
    const isRendered = row.status !== "captured";
    if (isRendered && !Number.isFinite(Date.parse(row.rendered_at))) {
      throw Error("CAPTURE_PROVENANCE_INVALID");
    }
    if (row.status === "blocked_403") {
      if (
        row.family !== "smartrecruiters" || row.http_status !== 403 ||
        !row.bot_check?.includes("datadome")
      ) throw Error("CAPTURE_HANDOFF_INVALID");
      handoffs.push({
        id: row.id,
        family: row.family,
        source_url: row.source_url,
        reason: "DATADOME_MANUAL_HANDOFF",
      });
      continue;
    }
    if (row.status === "no_application") {
      unavailable.push({
        id: row.id,
        family: row.family,
        source_url: row.source_url,
        reason: "NO_APPLICATION_CAPTURED",
      });
      continue;
    }
    const bytes = read(isRendered ? row.html : row.id + ".html"),
      meta = isRendered ? row : JSON.parse(read(row.id + ".json"));
    if (hash(bytes) !== (isRendered ? meta.html_sha256 : meta.sha256)) {
      throw Error("CAPTURE_HASH_MISMATCH");
    }
    if (meta.synthetic === true) throw Error("SYNTHETIC_CAPTURE_NOT_REAL");
    if (
      meta.source_url !== row.source_url ||
      !Number.isFinite(
        Date.parse(isRendered ? meta.rendered_at : meta.captured_at),
      )
    ) throw Error("CAPTURE_PROVENANCE_INVALID");
    const fields = isRendered
      ? meta.required?.map((f) => ({ ...f, required: true }))
      : meta.fields;
    if (
      meta.http_status !== 200 || !Array.isArray(fields) || !fields.some((f) =>
        f.required && f.name
      ) || !(isRendered
        ? meta.resume_inputs > 0
        : fields.some((f) => f.type === "file"))
    ) throw Error("CAPTURE_PROVENANCE_INVALID");
    snapshots.push({
      ...row,
      ...meta,
      fields,
      rendered: isRendered,
      sha256: hash(bytes),
      html: bytes.toString("utf8"),
      synthetic: false,
    });
  }
  const familiesReady = !rendered ||
    ["greenhouse", "lever", "ashby"].every((f) =>
      snapshots.filter((s) => s.family === f).length >= 5
    );
  return {
    status: snapshots.length === expected && familiesReady
      ? "AVAILABLE"
      : snapshots.length
      ? "PARTIAL"
      : "NOT_RUN",
    expected,
    real_count: snapshots.length,
    snapshots,
    handoffs,
    unavailable,
  };
}
function createSnapshotServer(snapshots) {
  const pages = new Map();
  for (const s of snapshots) {
    if (
      !/^[a-z0-9_-]{1,160}$/.test(s.id) || pages.has(s.id) ||
      typeof s.html !== "string"
    ) throw Error("SNAPSHOT_INVALID");
    pages.set(s.id, s);
  }
  const stats = { gets: 0, mutations: 0 };
  const instance = http.createServer((req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      stats.mutations++;
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/__snapshot_stats") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(stats),
      );
      return;
    }
    let id;
    try {
      id = decodeURIComponent(
        new URL(req.url, "http://fixture.invalid").pathname.slice(
          "/snapshots/".length,
        ),
      );
    } catch {
      res.writeHead(404).end();
      return;
    }
    const s =
      req.url.startsWith("/snapshots/") && /^[a-z0-9_-]{1,160}$/.test(id)
        ? pages.get(id)
        : null;
    stats.gets++;
    res.writeHead(s ? 200 : 404, {
      "content-type": "text/html",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'",
    });
    res.end(s ? s.html : "Not a saved snapshot");
  });
  return { server: instance, stats };
}
function probeSnapshot({ url, snapshot, packet, resumePath, evidenceDir }) {
  if (packet.synthetic !== true || !/^TEST[-_]/.test(packet.user_id)) {
    throw Error("SYNTHETIC_PROFILE_REQUIRED");
  }
  const u = new URL(url);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) || u.username || u.password
  ) throw Error("LOOPBACK_FIXTURE_REQUIRED");
  const Portal = require("../../packages/domain/149-career-portal-apply.js"),
    Browser = require("../../packages/domain/150-career-portal-browser.js");
  const sha256 = hash(Buffer.from(packet.resume.text)),
    profile = {
      ...packet.profile,
      resume: { filename: packet.resume.filename, sha256 },
    };
  const board = Browser.createBrowserBoard({
      url,
      userId: packet.user_id,
      resumePath,
      evidenceDir,
      scope: { origin: u.origin },
    }),
    defs = new Map(),
    planned = new Map(),
    raws = new Map(),
    liveWidgets = new Map(),
    bindings = new Map(),
    attemptedWidgets = new Set();
  let reviews = 0, result;
  const form = board.form.bind(board),
    fill = board.fill.bind(board),
    review = board.atReview.bind(board);
  board.form = () => {
    const r = form(),
      raw = board.lastObservation?.fields || [],
      classified = Browser.classifyFields(raw);
    for (const [id, b] of Object.entries(classified.bindings)) {
      bindings.set(id, b);
    }
    for (const f of r.fields) defs.set(f.field_id, f);
    for (const f of raw) raws.set(f.selector, f);
    if (snapshot.rendered) {
      for (const [id, b] of Object.entries(classified.bindings)) {
        if (b.widget) liveWidgets.set(id, defs.get(id)?.label || id);
      }
    }
    return r;
  };
  board.fill = (id, value) => {
    planned.set(id, JSON.parse(JSON.stringify(value)));
    if (liveWidgets.has(id)) {
      attemptedWidgets.add(id);
      return undefined;
    }
    return fill(id, value);
  };
  board.atReview = () => {
    if (attemptedWidgets.size) {
      throw Object.assign(
        Error("Stripped fixture cannot execute this widget"),
        { code: "RENDERED_WIDGET_REQUIRES_LIVE_PAGE" },
      );
    }
    reviews++;
    return review();
  };
  try {
    const session = Portal.createPortalSession({
      userId: packet.user_id,
      board,
    });
    try {
      result = Portal.runApply(session, {
        posting: {
          id: snapshot.id,
          canonicalKey: "TEST:" + snapshot.id,
          company: "SYNTHETIC fixture",
          url,
          status: "open",
        },
        profile,
        attestations: packet.attestations,
        log: { records: [] },
      });
    } catch (e) {
      if (e.code === "RESUME_SHA_MISMATCH") throw e;
      result = { resultStatus: "blocked", code: e.code || "BROWSER_BLOCKED" };
    }
    if (
      attemptedWidgets.size &&
      ["awaiting_user", "prepared"].includes(result.resultStatus)
    ) {
      result = {
        ...result,
        resultStatus: "blocked",
        code: "RENDERED_WIDGET_REQUIRES_LIVE_PAGE",
      };
    }
    let current = {};
    try {
      current = board.answers();
    } catch {
      result = { resultStatus: "blocked", code: "READBACK_UNAVAILABLE" };
    }
    const answers = current,
      required = [...defs.values()].filter((f) => f.required),
      equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const bound = required.filter((f) => planned.has(f.field_id)),
      read = bound.filter((f) =>
        equal(
          answers[f.field_id],
          board.renderedValues[f.field_id] ?? planned.get(f.field_id),
        )
      );
    const raw = [...raws.values()],
      expected = (snapshot.fields || []).filter((f) => f.required),
      available = raw.filter((r) => r.required),
      detected = [],
      undetected = [];
    const type = (t) =>
        /^select-(one|multiple)$/.test(t)
          ? "select"
          : t === "input"
          ? "text"
          : t,
      label = (t) =>
        String(t || "").replace(/[*✱]\s*$/, "").trim().replace(/\s+/g, " ");
    for (const [i, f] of expected.entries()) {
      const n = available.findIndex((r) =>
        (f.name
          ? (r.name || r.id) === f.name
          : !r.name && !r.id && !!label(f.label) &&
            label(r.label) === label(f.label)) &&
        (!f.type || type(r.inputType) === type(f.type))
      );
      if (n >= 0) detected.push(available.splice(n, 1)[0]);
      else {undetected.push(
          f.label || f.name || `[unnamed ${f.type || "control"} #${i + 1}]`,
        );}
    }
    const unknown = (result.asks || []).filter((a) =>
      defs.get(a.field_id)?.required
    ).map((a) => defs.get(a.field_id).label);
    const answerable = (f) => {
      if (f.kind === "standard") {
        const v = Portal.profileValue(profile, f.profile_key);
        return v !== undefined && v !== null && v !== "";
      }
      const a = profile.answers?.[f.question_key];
      if (f.kind === "screening") {
        return a?.confirmed === true && a.value !== undefined;
      }
      if (f.kind === "free_text") {
        return a?.confirmed === true && a.draft === true &&
          a.value !== undefined;
      }
      if (f.kind === "eeo") return true;
      return f.kind === "attestation" &&
        packet.attestations?.[f.field_id]?.explicit === true &&
        packet.attestations[f.field_id].value !== undefined;
    };
    const native = required.filter((f) =>
      !bindings.get(f.field_id)?.widget && answerable(f)
    );
    const nativeBound = native.filter((f) => planned.has(f.field_id));
    const nativeRead = nativeBound.filter((f) => read.includes(f));
    const nativeGaps = native.filter((f) => !nativeRead.includes(f)).map(
      (f) => ({
        id: f.field_id,
        label: f.label,
        planned: planned.get(f.field_id),
        observed: answers[f.field_id],
        rendered: board.renderedValues[f.field_id],
        binding: bindings.get(f.field_id)?.inputType,
      }),
    );
    const resumeVerified = Object.values(answers).some((a) =>
      a && typeof a === "object" && a.sha256 === sha256 &&
      a.filename === packet.resume.filename
    );
    if (
      result.resultStatus === "prepared" &&
      (!resumeVerified || !required.length ||
        read.length / required.length < 0.95)
    ) {
      result = {
        resultStatus: "blocked",
        code: "FINAL_OBSERVATION_INCOMPLETE",
      };
    }
    return {
      id: snapshot.id,
      evidence: snapshot.synthetic ? "SYNTHETIC_CONTROL" : "SAVED_REAL_FORM",
      source_url: snapshot.source_url || null,
      status: result.resultStatus,
      code: result.code || null,
      expected_raw: expected.length,
      detected_raw: detected.length,
      undetected,
      required: required.length,
      bound: bound.length,
      read_back: read.length,
      ratio: required.length ? read.length / required.length : 0,
      unknown,
      unknown_required: required.filter((f) => !answerable(f)).map((f) =>
        f.label
      ),
      native_answerable: native.length,
      native_bound: nativeBound.length,
      native_read_back: nativeRead.length,
      native_gaps: nativeGaps,
      fill_calls: board.calls.fill,
      requires_live_widget: [...liveWidgets.values()],
      resume_verified: resumeVerified,
      review_calls: reviews,
      submit_calls: board.calls.submit,
    };
  } finally {
    board.close();
  }
}
function shutdownProbe() {
  require("../../packages/domain/150-career-portal-browser.js").shutdownAll();
}
if (require.main === module) {
  if (["--snapshot-bundle", "--snapshots"].includes(process.argv[2])) {
    const bundle = process.argv[2] === "--snapshot-bundle",
      snapshots = bundle
        ? JSON.parse(fs.readFileSync(process.argv[3], "utf8"))
        : loadSnapshots(process.argv[3]).snapshots;
    if (
      bundle && snapshots.some((s) =>
        s.synthetic !== true &&
        (s.synthetic !== false || s.sha256 !== hash(Buffer.from(s.html)))
      )
    ) throw Error("SNAPSHOT_BUNDLE_LABEL_OR_HASH_REQUIRED");
    const local = createSnapshotServer(snapshots).server;
    local.listen(
      0,
      "127.0.0.1",
      () => console.log(`FIXTURE_PORT ${local.address().port}`),
    );
  } else {server.listen(0, () =>
      console.log(`FIXTURE_PORT ${server.address().port}`));}
}
module.exports = {
  loadSnapshots,
  createSnapshotServer,
  probeSnapshot,
  shutdownProbe,
};
