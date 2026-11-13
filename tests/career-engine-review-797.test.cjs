"use strict";
// Independent review of #797 (the apply engine), each finding as a decision that needs no browser: the rule itself on plain data
// (what the page-side readers hand to Node), the hand-off and the card through the real recheck() with a stand-in runner, and the
// VM worker (createWorker) with a stand-in engine. tests/career-engine-review-797-browser.test.cjs drives the same findings on
// local pages in Chromium. Nothing here opens a browser or reaches a network.
// Run: node --test tests/career-engine-review-797.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pa = require("../workers/career-browser/parallel-apply.cjs");
const h = require("../workers/career-browser/handoff.cjs");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");

const SRC = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");
const at = (s, from = 0) => { const i = SRC.indexOf(s, from); assert.ok(i >= 0, `"${s}" is in the runner`); return i; };
class NeedsUser extends Error { constructor(r) { super(r); this.reason = r; } }

// ------------------------------------------------------------------------------------------------ 1. a check seen on any step
test("1: a check seen inside the form on an earlier step is remembered: no Continue and no Submit past it, even when it is no longer shown", () => {
  let g = pa.checkGate(null, "widget div.g-recaptcha 304x78", true, "enter");
  assert.equal(g.stop, null, "an in-form check is noted on the way in; the step is filled first");
  const seen = g.seen; assert.ok(seen);
  g = pa.checkGate(seen, false, false, "continue");
  assert.deepEqual(g.stop && g.stop.wall, "check_in_form", "Continue is not pressed past a check this run saw");
  g = pa.checkGate(seen, false, false, "submit");
  assert.deepEqual(g.stop && g.stop.wall, "check_in_form", "Submit is not pressed: the check is gone from view, not from the run");
  assert.equal(pa.checkGate(null, false, false, "continue").stop, null);
  assert.equal(pa.checkGate(null, false, false, "submit").stop, null, "a run that never saw a check goes on");
  assert.deepEqual(pa.checkGate(null, "text", false, "enter").stop, { wall: null, detail: "text" }, "a whole-page check still stops at the door");
  assert.equal(pa.checkGate(null, "frame", true, "submit").stop.wall, "check_in_form");
  // The runner asks the rule before its one Continue click and before the Submit click.
  const fill = at("await fillForm(page");
  assert.ok(at('await gate("continue")', fill) < at('page.click("[data-upmore-next]")', fill));
  assert.ok(at('await gate("submit")', fill) < at('page.click("[data-upmore-submit]")', fill));
  // The stop is the existing hand-off, to the person.
  const ho = h.buildHandoff({ status: "needs_user", reason: "bot_check", wall: "check_in_form", at: "https://x.breezy.hr/p/a/apply", filled_labels: ["Email"] });
  assert.equal(ho.reason, "bot_check_in_form");
});

// ------------------------------------------------------------------------------------------------ 2. the Submit of the filled form
const field = (type, hint) => ({ type, hint });
const APP = [field("text", "First Name first_name"), field("email", "Email email"), field("file", "Resume resume")];
const ctl = (c, form, text, o = {}) => ({ c, form, inside: form >= 0, vis: true, text, tag: "BUTTON", type: "", signin: false, ...o });
const snap = (forms, controls, loose = []) => ({ forms: forms.map((fields) => ({ signin: false, hasControl: true, fields })), controls, loose });
test("2: a control outside the form is never that form's Submit; a form with no application field is not the application", () => {
  // The review's page: a newsletter box and one "Apply" button outside it.
  const news = pa.pickControls(snap([[field("email", "Your email newsletter_email")]], [ctl(0, 0, "Subscribe", { type: "submit" }), ctl(1, -1, "Apply")]));
  assert.equal(news.submit, null, "the outside Apply is not a Submit, and the newsletter's own button is not the application's");
  assert.equal(news.form, null, "nothing is marked as the form to fill");
  assert.equal(pa.isApplicationForm([field("email", "Your email newsletter_email")]), false);
  assert.equal(pa.isApplicationForm(APP), true);
  // An application form whose only Submit-worded control is outside it and not tied to it: refused, with its own reason.
  const out = pa.pickControls(snap([APP], [ctl(0, -1, "Submit Application", { type: "button", follows: true, gap: 1 })]));
  assert.deepEqual([out.submit, out.refuse, !!out.opener], [null, "submit_not_tied_to_form", false]);
  // The same with an "Apply" control: it is an opener (opened once, as before), never the Submit.
  const opener = pa.pickControls(snap([APP], [ctl(0, -1, "Apply now", { tag: "A" })]));
  assert.deepEqual([opener.submit, opener.refuse, opener.opener], [null, "submit_not_tied_to_form", true]);
  // Tied by the form itself: inside it, or by the control's own form attribute (HTML's association).
  assert.deepEqual(pa.pickControls(snap([APP], [ctl(4, 0, "Submit application", { type: "submit" })])), { form: 0, submit: 4, next: null, refuse: null });
  // The application is the second form: its Submit, and that form is the one filled.
  const two = pa.pickControls(snap([[field("search", "Search jobs q")], APP], [ctl(0, 0, "Search", { type: "submit" }), ctl(1, 1, "Send application", { type: "submit" })]));
  assert.deepEqual([two.form, two.submit], [1, 1]);
  // A board with no <form> (Ashby): the page is the form only when it asks application questions.
  const ashby = pa.pickControls({ forms: [], controls: [ctl(2, -1, "Submit Application", { type: "button" })], loose: APP });
  assert.deepEqual([ashby.form, ashby.submit], [-1, 2]);
  assert.equal(pa.pickControls({ forms: [], controls: [ctl(2, -1, "Apply")], loose: [field("email", "newsletter")] }).submit, null);
  // A step form's one Continue, in an application form only.
  const step = [ctl(0, 0, "Continue", { type: "button" }), ctl(1, 0, "Submit application", { type: "submit", vis: false })];
  assert.deepEqual(pa.pickControls(snap([APP], step)), { form: 0, submit: null, next: 0, refuse: null });
  assert.equal(pa.pickControls(snap([[field("email", "newsletter")]], step)).next, null);
  // The last look before the click: the control pressed belongs to the form that was filled, and every filled field is in it.
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: true, filledOutside: 0 }), null);
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: false, filledOutside: 0 }), "submit_not_tied_to_form");
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: true, filledOutside: 1 }), "submit_not_tied_to_form");
  assert.equal(pa.submitTieRefusal({ formless: true, anyForm: true }), "submit_not_tied_to_form", "a form appeared on a page taken as formless");
  assert.equal(pa.submitTieRefusal({ formless: true, anyForm: false }), null);
  // The refusal comes before anything is filled, and the tie is checked before the click.
  assert.ok(at("if (lastPick.refuse") < at("await fillForm(page"));
  assert.ok(at("submitTieRefusal({ ...tie", at("await fillForm(page")) < at('opts.onPhase("submitting"'));
});

// The one narrow exception (BambooHR's recorded shape): every condition, or submit_not_tied_to_form as before.
test("2: a Submit outside the page's one application form is that form's only when every condition holds", () => {
  const NAMES = [field("text", "First Name first_name"), field("text", "Last Name last_name"), field("email", "Email email")];
  const btn = (o = {}) => ctl(0, -1, "Submit Application", { type: "button", follows: true, sameBox: false, gap: 0, link: false, ...o });
  const page = (o = {}) => ({ ...snap([o.fields || NAMES], o.controls || [btn(o.btn)]), otherFrameForms: o.frames || 0, ...(o.forms ? { forms: o.forms } : {}) });
  assert.deepEqual(pa.pickControls(page()), { form: 0, submit: 0, next: null, refuse: null, outside: true }, "BambooHR: one form, names and email, one Submit right after it");
  assert.equal(pa.pickControls(page({ fields: [field("text", "Full name name"), field("file", "Resume resume")] })).outside, true, "a name and the resume upload");
  assert.equal(pa.pickControls(page({ btn: { follows: false, sameBox: true } })).outside, true, "in the form's own container");
  for (const label of ["Submit", "Apply", "Send application"]) assert.equal(pa.pickControls(page({ btn: { text: label } })).outside, true, label);
  const form = (fields) => ({ signin: false, hasControl: true, fields });
  const refused = {
    "a second form on the page (a newsletter box)": page({ forms: [form(NAMES), form([field("email", "newsletter")])] }),
    "a second form that is a sign-in form": page({ forms: [form(NAMES), { ...form([field("email", "login")]), signin: true }] }),
    "a form in another frame": page({ frames: 1 }),
    "no name or email question": page({ fields: [field("text", "City city"), field("text", "Country country"), field("tel", "Phone phone")] }),
    "an email and one other question only": page({ fields: [field("email", "Email email"), field("text", "City city")] }),
    "two Submit-like controls outside": page({ controls: [btn(), ctl(1, -1, "Send application", { type: "button", follows: true, gap: 0 })] }),
    "an untyped button outside beside it": page({ controls: [btn(), ctl(1, -1, "Save")] }),
    "Submit-like controls inside the form too": page({ controls: [btn(), ctl(1, 0, "Save draft"), ctl(2, 0, "Attach")] }),
    "the control is a link": page({ btn: { link: true } }),
    "its words are not a Submit label": page({ btn: { text: "Send" } }),
    "a search or newsletter box between the form and the control": page({ btn: { gap: 1 } }),
    "neither after the form nor in its container": page({ btn: { follows: false, sameBox: false } }),
  };
  for (const [why, sn] of Object.entries(refused)) {
    const r = pa.pickControls(sn);
    assert.deepEqual([r.submit, r.outside, r.refuse], [null, undefined, "submit_not_tied_to_form"], why);
  }
  // The review's page still refuses: the newsletter box is no application, whatever sits beside it.
  const news = pa.pickControls({ ...snap([[field("email", "Your email newsletter_email")]], [ctl(0, 0, "Subscribe", { type: "submit" }), ctl(1, -1, "Apply", { follows: true, gap: 0 })]), otherFrameForms: 0 });
  assert.deepEqual([news.form, news.submit, news.outside], [null, null, undefined]);
  // Before the click: the outside control is accepted only as the pick's exception, and only while it still belongs to no form.
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: false, noForm: true, outside: true, filledOutside: 0 }), null);
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: false, noForm: true, outside: false, filledOutside: 0 }), "submit_not_tied_to_form");
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: false, noForm: false, outside: true, filledOutside: 0 }), "submit_not_tied_to_form");
  assert.equal(pa.submitTieRefusal({ formless: false, sameForm: false, noForm: true, outside: true, filledOutside: 1 }), "submit_not_tied_to_form");
});

// ------------------------------------------------------------------------------------------------ 3. the hand-off says what is true
const RESUME = Buffer.from("%PDF-1.4\n% TEST resume, review of #797\n");
const RSHA = crypto.createHash("sha256").update(RESUME).digest("hex");
const URL_ = "https://jobs.lever.co/acme/6c1d84b8-7305-42d7-bf69-5ace8a5b932f";
function row(extra = {}) {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000797", job_id: "lever:acme:1", company: "Acme", url: URL_, resume_sha256: RSHA, fields: [{ label: "Email", value: "test.person@example.invalid", factId: "f1" }] };
  const hash = queueHash(payload);
  return { id: "79779779-0797-4797-8797-797797797797", lease_token: "22222222-2222-4222-8222-222222222222", url: URL_, user_id: payload.user_id, payload, payload_hash: hash, approval_hash: hash, approval_id: "33333333-3333-4333-8333-333333333333", ...extra };
}
async function vm(r, { applyOne, recheck }) {
  const done = [], rechecks = [];
  const rpc = async (name, args) => {
    if (name === "career_apply_vm_claim_handoff") return done.claimed ? [] : ((done.claimed = true), [r]);
    if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: RSHA, b64: RESUME.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    if (name === "career_apply_vm_complete") done.push(args);
    return {};
  };
  const w = createWorker({ rpc, browser: {}, allowHosts: ["jobs.lever.co"], retries: 0, evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-797-")), log: () => {}, applyOne,
    recheck: async (b, p, o) => { rechecks.push(o.yes); return recheck(b, p, o); } });
  await w.tick(); while (w.inflight.size) await new Promise((x) => setTimeout(x, 5));
  return { done, rechecks };
}
const CHECK = { status: "needs_user", reason: "bot_check", wall: "check_in_form", at: URL_, filled_labels: ["Email"] };
const ASKED = [{ label: "Are you authorised to work in the UK?", reason: "no_confirmed_answer", options: ["Yes", "No"] }];
test("3: the in-form check's hand-off never says the person will find the form filled, and answers missing beside it are asked", async () => {
  const ho = h.buildHandoff(CHECK, { url: URL_ });
  assert.doesNotMatch(JSON.stringify(ho), /already filled|is filled|are filled/i, "the person's own browser opens the form empty");
  assert.equal(ho.person_sees, "empty_form", "the fact the reply layer gets: what the link shows in the person's browser");
  assert.equal(ho.nothing_sent, true); assert.deepEqual(ho.filled, ["Email"], "what Trainee filled in its own browser stays on the record");
  for (const r of [{ status: "needs_user", reason: "login_required", wall: "password", at: URL_ }, { status: "needs_user", reason: "email_code", at: URL_ },
    { status: "not_submitted", reason: "missing_required_answer", at: URL_, needs: ASKED }]) {
    const x = h.buildHandoff(r, { url: URL_ });
    assert.doesNotMatch(x.step, /already filled/i); assert.ok(["page_from_start", "nothing_to_open"].includes(x.person_sees), x.person_sees);
  }
  const both = h.buildHandoff({ ...CHECK, needs: ASKED }, { url: URL_ });
  assert.deepEqual(h.askedQuestions(both), [{ label: ASKED[0].label, options: ["Yes", "No"] }]);
  assert.deepEqual(h.askedQuestions(ho), []);
  // Through the VM: the first stop asks the answers (the state the database re-prepares from), never a bare check stop.
  const first = await vm(row({ handoff: { done_at: null, yes: null } }), { applyOne: async () => ({ ...CHECK, needs: ASKED, handoff: both, attempts: 1 }) });
  assert.deepEqual([first.done[0].p_state, first.done[0].p_reason], ["not_submitted", "needs_answers"]);
  assert.deepEqual(first.done[0].p_evidence.questions, [{ label: ASKED[0].label, options: ["Yes", "No"] }]);
  assert.equal(first.done[0].p_evidence.nothing_sent, true); assert.equal(first.done[0].p_evidence.also_check, true);
  // A re-check that meets the check again with answers still missing: asked, not ended as needs_extension.
  const again = await vm(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes: null } }), { recheck: async () => ({ state: "still_walled", handoff: both }) });
  assert.deepEqual([again.done[0].p_state, again.done[0].p_reason], ["not_submitted", "needs_answers"]);
  assert.ok(!again.done[0].p_evidence.needs_extension);
  // The check alone, still there: the person's own browser, as before.
  const alone = await vm(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes: null } }), { recheck: async () => ({ state: "still_walled", handoff: ho }) });
  assert.deepEqual([alone.done[0].p_state, alone.done[0].p_reason, alone.done[0].p_evidence.needs_extension], ["needs_user", "bot_check", true]);
});

// ------------------------------------------------------------------------------------------------ 4. the card is the whole page
const c = (name, type, value, o = {}) => ({ name, label: o.label || name, type, option: o.option || null, value, touched: !!o.touched, hidden: type === "hidden", q: null });
const FILLED = [{ label: "Email", held: "a@example.invalid", source: "answer" }];
const PAGE = [c("email", "email", "a@example.invalid", { label: "Email", touched: true }), c("city", "text", "Leeds", { label: "City" }), c("csrf_token", "hidden", "t-1"), c("source", "hidden", "careers")];
test("4: the card shows and hashes what every control holds, a pre-ticked box is the person's to answer, and the page is read again before the click", async () => {
  const card = h.answersCard({ url: URL_, payload_hash: "ph", fields: FILLED, controls: PAGE });
  assert.deepEqual(card.answers.map((a) => [a.field, a.value, a.source]), [["Email", "a@example.invalid", "answer"], ["City", "Leeds", "page_default"]], "a value the page set itself is on the card");
  assert.equal(card.hidden_not_hashed, 2, "hidden fields are not shown and not in the card's hash, and the card says so");
  assert.doesNotMatch(JSON.stringify(card), /t-1/);
  assert.equal(h.yesMatches(card, { card_hash: card.hash }), true);
  const ticked = [...PAGE, c("marketing", "checkbox", "on", { label: "I agree to be contacted about other roles" })];
  assert.notEqual(h.answersCard({ url: URL_, payload_hash: "ph", fields: FILLED, controls: ticked }).hash, card.hash, "a box the engine never touched changes the card");
  assert.notEqual(h.answersCard({ url: URL_, payload_hash: "ph", fields: FILLED, controls: PAGE.map((x) => (x.name === "city" ? { ...x, value: "York" } : x)) }).hash, card.hash);
  assert.equal(h.answersCard({ url: URL_, payload_hash: "ph", fields: FILLED, controls: PAGE.map((x) => (x.hidden ? { ...x, value: "other" } : x)) }).hash, card.hash, "a per-load hidden value does not make every yes stale");
  // A box or a sensitive choice the page set and the person never confirmed is asked, never sent.
  const un = h.unconfirmedDefaults([...ticked, c("gender", "select-one", "Male", { label: "Gender" }), c("auth", "radio", "yes", { label: "Are you authorised to work here?", option: "yes" }),
    c("office", "text", "Leeds", { label: "Preferred office" }), c("terms", "checkbox", "on", { label: "I accept the terms", touched: true }), c("news", "checkbox", null, { label: "Newsletter" })]);
  // Engine round 2 (stricter, architect amendment): text the page prefilled and the person never gave (City, Preferred office) is
  // asked too, not sent as if it were theirs.
  assert.deepEqual(un.map((n) => [n.label, n.reason]), [["City", "no_confirmed_answer"], ["I agree to be contacted about other roles", "agreement_needs_you"], ["Gender", "eeo_needs_your_choice"], ["Are you authorised to work here?", "agreement_needs_you"], ["Preferred office", "no_confirmed_answer"]]);
  for (const n of un) assert.ok(h.PERSON_REASONS.has(n.reason));
  // The same page, read twice in one run: a stable hidden value counts, a per-load token (#710's pattern) does not.
  const d = (cs) => h.pageDigest(cs, { hidden: true });
  assert.equal(d(PAGE), d(PAGE.map((x) => (x.name === "csrf_token" ? { ...x, value: "t-2" } : x))));
  assert.notEqual(d(PAGE), d(PAGE.map((x) => (x.name === "source" ? { ...x, value: "other" } : x))));
  assert.notEqual(d(PAGE), d(ticked));
  // recheck(): a yes to the card is refused when the page holds one more ticked box than the card did (the same filled fields).
  const runner = (controls, log) => ({ NeedsUser, applyOne: async (_b, _p, o) => {
    try { await o.onPhase("submitting", { fields: FILLED, controls }); log.push("CLICK"); return { status: "submitted_page_confirmed" }; } catch (e) { return { status: "not_submitted", reason: e.reason }; } } });
  const p = { url: URL_, approval: { hash: "ph" } };
  let log = [];
  const ready = await h.recheck(null, p, {}, { runner: runner(PAGE, log) });
  assert.equal(ready.state, "ready_for_yes"); assert.deepEqual(log, []);
  const changed = await h.recheck(null, p, { yes: { card_hash: ready.card.hash } }, { runner: runner(ticked, log) });
  assert.deepEqual([changed.state, changed.reason, log], ["stopped", "APPROVED_APPLICATION_CHANGED", []]);
  const same = await h.recheck(null, p, { yes: { card_hash: ready.card.hash } }, { runner: runner(PAGE, log) });
  assert.equal(same.state, "submitted"); assert.deepEqual(log, ["CLICK"]);
  // The runner: unconfirmed defaults refuse before the submitting record; the page is read again between that record and the click.
  const fill = at("await fillForm(page"), rec = at('opts.onPhase("submitting"', fill), click = at('page.click("[data-upmore-submit]")', rec);
  const reread = at('"page_changed_before_submit"', fill);
  assert.ok(at("unconfirmedDefaults(controls", fill) < reread && reread < rec && rec < click, "re-read and compared before the submitting record: a refusal there is not_submitted, never unknown");
  assert.equal(SRC.indexOf("readControls()", rec), -1, "nothing between the record and the click can refuse");
});

// What the page set itself, control by control: asked, or shown and hashed without a stop.
test("4: page defaults, one by one: a question the person has not answered is asked; their own confirmed answer and presentational defaults are not", () => {
  const person = { phone: "+44 7700 900123", country: "United Kingdom", answer: (l) => ({ "Are you authorised to work in the UK?": "Yes", "Country": "United Kingdom", "Gender": "Female", "I confirm the information is true": "Yes", "Notice period": "1 month" })[l] };
  const ASK = "ask", OK = "ok";
  const table = [
    [c("gdpr", "checkbox", "checked", { label: "I consent to the processing of my data" }), ASK, "agreement_needs_you"],
    [c("auth_us", "radio", "Yes", { label: "Are you legally authorized to work in the US?" }), ASK, "agreement_needs_you"],
    [c("sponsor", "select-one", "No", { label: "Will you require visa sponsorship?" }), ASK, "agreement_needs_you"],
    [c("race", "select-one", "White", { label: "Race / Ethnicity" }), ASK, "eeo_needs_your_choice"],
    [c("veteran", "radio", "I am not a protected veteran", { label: "Veteran status" }), ASK, "eeo_needs_your_choice"],
    [c("disability", "radio", "No", { label: "Disability" }), ASK, "eeo_needs_your_choice"],
    [c("attest", "checkbox", "checked", { label: "I certify that my answers are true and complete" }), ASK, "agreement_needs_you"],
    [c("talent", "checkbox", "checked", { label: "Keep me in the talent pool" }), ASK, "agreement_needs_you"],
    [c("mkt", "checkbox", "checked", { label: "Send me marketing emails" }), ASK, "agreement_needs_you"],
    [c("convict", "radio", "No", { label: "Have you ever been convicted of a crime?" }), ASK, "agreement_needs_you"],
    [c("relocate", "radio", "Yes", { label: "Are you willing to relocate?" }), ASK, "no_confirmed_answer"],
    [c("salary", "select-one", "50-60k", { label: "Salary expectation" }), ASK, "no_confirmed_answer"],
    [c("lang_spoken", "select-one", "English", { label: "Which languages do you speak?" }), ASK, "no_confirmed_answer"],
    [c("phone_cc", "select-one", "United States (+1)", { label: "Country code" }), ASK, "no_confirmed_answer"],
    [c("gender", "select-one", "Male", { label: "Gender" }), ASK, "eeo_needs_your_choice"],
    [c("notice", "select-one", "3 months", { label: "Notice period" }), ASK, "no_confirmed_answer"],
    [c("auth_uk", "radio", "Yes", { label: "Are you authorised to work in the UK?" }), OK],
    [c("country", "select-one", "United Kingdom", { label: "Country" }), OK],
    [c("gender2", "select-one", "female", { label: "Gender" }), OK],
    [c("true", "checkbox", "checked", { label: "I confirm the information is true" }), OK],
    [c("phone_cc2", "select-one", "United Kingdom (+44)", { label: "Country code" }), OK],
    [c("dial", "select-one", "+44", { label: "Phone country" }), OK],
    [c("lang", "select-one", "English", { label: "Language" }), OK],
    [c("locale", "select-one", "en-GB", { label: "", option: null }), OK],
    [c("sort", "select-one", "Newest", { label: "Sort by" }), OK],
    [c("per_page", "select-one", "25", { label: "Results per page" }), OK],
    [c("same", "checkbox", null, { label: "Same as above" }), OK],
    [c("city", "text", "Leeds", { label: "City" }), ASK, "no_confirmed_answer"], // round 2: prefilled text the person never gave is asked
    [c("csrf", "hidden", "t", {}), OK],
    [c("terms", "checkbox", "checked", { label: "I accept the terms", touched: true }), OK],
  ];
  assert.ok(table.length >= 20);
  for (const [control, want, reason] of table) {
    const got = h.unconfirmedDefaults([control], person);
    assert.deepEqual(got.map((n) => n.reason), want === ASK ? [reason] : [], `${control.name}: ${control.label} = ${control.value}`);
    if (want === ASK) assert.ok(h.PERSON_REASONS.has(got[0].reason));
  }
  // Not a stop does not mean not on the card: every one of them is hashed, and the visible ones are shown.
  const quiet = table.filter(([, want]) => want === OK).map(([x]) => x);
  const card = h.answersCard({ url: URL_, payload_hash: "ph", fields: [], controls: quiet });
  assert.deepEqual(card.answers.map((a) => a.source), quiet.filter((x) => !x.hidden && !x.touched && x.value !== null).map(() => "page_default"));
  assert.notEqual(card.hash, h.answersCard({ url: URL_, payload_hash: "ph", fields: [], controls: quiet.map((x) => (x.name === "sort" ? { ...x, value: "Oldest" } : x)) }).hash);
});

// ------------------------------------------------------------------------------------------------ 5. closed, and the one source of the yes
test("5: a posting sent to the board's job list is not called closed by its address alone; the yes comes only from the claim", async () => {
  for (const [a, b] of [["https://x.breezy.hr/p/abc-dev", "https://x.breezy.hr/"], ["https://jobs.acme.com/o/dev", "https://jobs.acme.com/jobs"], ["https://a.bamboohr.com/careers/757", "https://a.bamboohr.com/careers"]]) {
    assert.equal(pa.closedAfterLoad(a, b), false, `${a} -> ${b}`);
    assert.equal(pa.sentToJobList(a, b), true);
  }
  assert.equal(pa.closedAfterLoad("https://job-boards.greenhouse.io/a/jobs/1", "https://job-boards.greenhouse.io/a?error=true"), true, "the board's own not-found address still is");
  assert.equal(pa.sentToJobList("https://x.bamboohr.com/careers/12", "https://x.bamboohr.com/careers/12?source=x"), false);
  const load = at("closedAfterLoad(p.url, page.url())");
  assert.ok(at("sentToJobList(p.url, page.url())", load) < at("closedOnPage(page)", load) && at('"posting_not_confirmed_closed"', load) < at("await gate()", load), "closed only when the page says so");
  // A yes written anywhere but the row's own hand-off state (the claim, 20261112160000) is not a yes.
  const card_hash = "c".repeat(64);
  const a = await vm(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes: null }, evidence: { handoff_yes: { card_hash } } }), { recheck: async () => ({ state: "stopped", reason: "x" }) });
  assert.deepEqual(a.rechecks, [null], "evidence.handoff_yes is not read");
  const b = await vm(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes: { card_hash } } }), { recheck: async () => ({ state: "stopped", reason: "x" }) });
  assert.deepEqual(b.rechecks, [{ card_hash }]);
});
