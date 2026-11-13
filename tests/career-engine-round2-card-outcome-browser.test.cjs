"use strict";
// Round 2 (review of #818), the card and the outcome in Chromium, through the real runner and the real re-check. The reviewer's
// pages: hidden answers behind drawn controls, text the page typed itself, and success words that are hidden or negated. What was
// posted is read from the server. The rules on plain data: tests/career-engine-round2-card-outcome.test.cjs.
// Run: node --test tests/career-engine-round2-card-outcome-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F3, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");

const P = st.pages, A = st.after, o = { skip, timeout: 240000 };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post">${F3}${inner}${SUB}</form>`;
const K = {
  k11: `<div class="custom-toggle" role="switch" aria-checked="true" tabindex="0">Do you require visa sponsorship? <b>Yes</b></div><input type="hidden" name="sponsorship" value="yes">`,
  k12: `<label>Referral source <input name="referral" value="Agency Partner Ltd" readonly></label><label>Candidate ID <input name="cand" value="X-99" disabled></label>`,
  k13: `<div role="combobox" aria-label="Are you legally authorized to work in the United States?" tabindex="0" data-value="Yes">Yes</div><input type="hidden" name="work_auth" value="Yes">`,
  k13b: `<label id="cl">Cover note</label><div contenteditable="true" aria-labelledby="cl" id="note" style="border:1px solid;min-height:30px">I confirm I am authorised to work in the UK without sponsorship.</div>`,
  k16: `<label>Electronic signature (type I agree) <input name="esign" value="I agree"></label><label>Additional information <textarea name="info">I certify that all statements are true and consent to a background check.</textarea></label>`,
  k21: `<div role="checkbox" aria-checked="true" tabindex="0">&#9745; I agree to receive marketing emails from our partners</div><input type="hidden" name="marketing_optin" value="1">`,
  k22: `<label>Years of experience <input type="number" name="years" value="10"></label><label>Desired salary <input name="salary" value="30000"></label>`,
  k23: `<div role="group" aria-label="Are you over 18?"><button type="button" aria-pressed="true" class="on">Yes</button><button type="button" aria-pressed="false">No</button></div><input type="hidden" name="over18" value="yes">`,
  token: `<input type="hidden" name="csrf_token" value="abc123">`,
};
for (const [k, v] of Object.entries(K)) P["/" + k] = doc(k, app(k, v));
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });

test("5: a hidden answer, a contenteditable statement and text the page typed itself are asked of the person, never sent, on the ordinary path", o, async () => {
  for (const id of ["k11", "k12", "k13", "k13b", "k16", "k21", "k22", "k23"]) {
    const x = await h.run("/" + id);
    assert.deepEqual([x.r.status, x.r.reason], ["not_submitted", "missing_required_answer"], `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts, [], id);
    assert.ok((x.r.needs || []).every((n) => /set by the page/.test(n.detail || "")), id);
  }
  assert.match((await h.run("/k11")).r.needs[0].label, /^Do you require visa sponsorship\?/, "asked in the widget's own words");
  const tok = await h.run("/token");
  assert.equal(tok.r.status, "submitted_page_confirmed", "an opaque token alone stops nothing");
});

test("5: on the card, a hidden answer is shown with its widget's words and is in the hash", o, async () => {
  const id = "k11y";
  P["/" + id] = doc(id, app(id, K.k11));
  const ready = await h.rc("/" + id, { facts: { sponsorship: "Yes" }, answers: { "Do you require visa sponsorship?": "yes" } });
  assert.equal(ready.out.state, "ready_for_yes", JSON.stringify(ready.out));
  assert.deepEqual(ready.out.card.answers.filter((a) => a.source === "page_default").map((a) => a.value), ["yes"]);
  assert.equal(ready.out.card.hidden_not_hashed, 0);
});

const OUT = {
  hiddenOk: (q, r, html) => html(doc("o7", `<ul class="errors"><li>Please fix the errors below</li></ul>${app("o7x", "")}<div id="ok" style="display:none">Thank you for applying!</div>`)),
  negated: (q, r, html) => html(`<h1>Error</h1><p>We could not confirm that your application submitted successfully. Please try again.</p>`),
  failed: (q, r, html) => html("<h1>Thank you for applying</h1>", 500),
  fine: (q, r, html) => html("<h1>Thank you for applying</h1><p>Ref GH-12345</p>"),
};
for (const [k, f] of Object.entries(OUT)) { P["/" + k] = doc(k, app(k, "")); A["/" + k] = f; }
P["/ajax"] = doc("ajax", `${app("ajax", "")}<div id="ok" style="display:none">Thank you for applying!</div><div id="err" style="display:none">Something went wrong. Your application was not sent.</div><script>app.addEventListener('submit',function(e){e.preventDefault();fetch('/ajax/submit',{method:'POST',body:new FormData(app)}).then(function(r){(r.ok?ok:err).style.display=''},function(){err.style.display=''})})</script>`);
A["/ajax"] = (q, r, html) => html("no", 500);
test("7: hidden or negated success words, an error list, a failed POST: never submitted_page_confirmed; the honest page still is", o, async () => {
  for (const id of ["hiddenOk", "negated", "failed", "ajax"]) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "unknown_outcome", `${id} ${JSON.stringify(x.r)}`);
    assert.equal(x.posts.length, 1, `${id}: one click, one POST`);
  }
  const ok = await h.run("/fine");
  assert.deepEqual([ok.r.status, ok.r.confirmation], ["submitted_page_confirmed", "GH-12345"]);
});
