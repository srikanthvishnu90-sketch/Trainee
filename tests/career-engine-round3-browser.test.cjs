"use strict";
// Round 3 (review of #831) in Chromium, on the reviewer's pages (scratchpad s7), through the real runner. What was posted is read
// from the server. "stop": nothing posted; "submit": the application's own form posted with the approved answers only.
// The rules on plain data: tests/career-engine-round3.test.cjs.
// Run: node --test tests/career-engine-round3-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, F3, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, A = st.after, o = { skip, timeout: 300000 };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data">${inner}</form>`;
const FR = `<label>Prénom <input name="first_name" required></label><label>Nom <input name="last_name" required></label><label>E-mail <input type="email" name="email" required></label><label>CV <input type="file" name="cv"></label>`;
const pages = (m) => { for (const [k, v] of Object.entries(m)) P["/" + k] = doc(k, v); return Object.keys(m); };
const STOP = pages({
  w1: app("w1", F + `<div role="radiogroup" aria-label="Do you require visa sponsorship?"><span role="radio" aria-checked="true">Yes</span><span role="radio" aria-checked="false">No</span></div><p>More questions below</p><label>Portfolio <input name="portfolio"></label><p>footer</p>` + SUB + `<input type="hidden" name="q_88213" value="yes">`),
  w2: app("w2", F + `<div class="toggle on" onclick="this.classList.toggle('on');cq.value=this.classList.contains('on')?'Yes':'No'">Willing to relocate? <b>Yes</b></div>` + SUB + `<input type="hidden" id="cq" name="custom_question_4471" value="Yes">`),
  w4: app("w4", F + `<input type="hidden" name="answers[3]" value="I agree to the arbitration agreement">` + SUB),
  w6: app("w6", F + `<div role="switch" aria-checked="true" aria-label="Do you need sponsorship?" tabindex="0">On</div>` + SUB) + `<input type="hidden" form="app" name="x1" value="yes">`,
  z1: app("z1", F + `<label><input type="checkbox" name="mk" value="1"> Email me offers</label>` + SUB) + `<script>app.addEventListener('formdata',function(e){e.formData.set('mk','1');e.formData.append('sponsorship','yes')})</script>`,
  z2: app("z2", F + SUB) + `<script>app.addEventListener('submit',function(e){e.preventDefault();var fd=new FormData(app);fd.append('marketing_optin','1');fetch('/z2/submit',{method:'POST',body:fd}).then(function(){document.body.innerHTML='<h1>Thank you for applying</h1>'})})</script>`,
  z6: app("z6", F + `<label><input type="checkbox" name="consent_session" value="1"> I consent to share my data with partners</label>` + SUB) + `<script>document.addEventListener('click',function(e){if(e.target.closest('button[type=submit]'))app.consent_session.checked=true},true)</script>`,
  z7: app("z7", F + `<label>Session note <input name="session_note"></label>` + SUB) + `<script>document.addEventListener('click',function(e){if(e.target.closest('button[type=submit]'))app.session_note.value='I consent to a background check'},true)</script>`,
  l4: `<button type="button" data-k="LI:atob" onclick="location.href=atob('aHR0cHM6Ly93d3cubGlua2VkaW4uY29tL2pvYnMvdmlldy8x')">Apply</button>`,
  l8: app("l8", F + `<button type="submit" data-k="LI:icon" aria-label="Apply" onclick="event.preventDefault();location.href='https://www.linkedin.com/x'"><img src="/assets/brand-in.png" alt="" width="16" height="16"></button>`),
});
const SUBMIT = pages({
  u4: app("u4", FR + `<button type="submit">Envoyer</button>`),
  u7: app("u7", F + `<button type="submit" aria-label="Submit application"><svg width="20" height="20"><path d="M0 0h20v20H0z"/></svg></button>`),
  u12: app("u12", `<label>Namn <input name="candidate[first_name]"></label><label>Efternamn <input name="candidate[last_name]"></label><label>E-post <input type="email" name="candidate[email]"></label><label>CV <input type="file" name="candidate[resume]"></label><button type="submit">Skicka ansökan</button>`),
  u15: `<h2>Apply for this job</h2>` + app("u15", F + `<button type="button" data-k="IN:signin-autofill">Sign in to autofill</button>` + SUB),
  u16: app("u16", F + `<button type="submit" aria-label="Submit application form">Submit</button>`),
  u20: app("u20", F + `<button type="submit" aria-label="Submit"><span class="icon">✈</span></button>`),
  k28: app("k28", F3 + `<label>Phone <input name="phone"></label><script>document.querySelector('[name=phone]').addEventListener('blur',function(){var d=this.value.replace(/\\D/g,'');if(d.length===11)this.value='('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7)})</script>` + SUB),
  p2: app("p2", F + SUB),
});
A["/p2"] = (q, r, html) => html("<h1>Thank you for applying</h1><footer><a class='error-report' href='#'>Report an error on this page</a></footer>");
P["/p8"] = doc("p8", app("p8", F + SUB)); A["/p8"] = (q, r, html) => html("<h1>Oops</h1><p>Thank you for applying is what you'd see if this had worked. Session expired.</p>");
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });

test("1, 3: hidden answers under any name, data the page adds as it sends, LinkedIn in a click handler: nothing is posted, nothing LinkedIn pressed", o, async () => {
  for (const id of STOP) {
    const x = await h.run("/" + id, { beat: id.startsWith("z") ? 300 : 0 });
    assert.notEqual(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts, [], `${id}: nothing posted`);
    assert.ok(!x.clicks.some((c) => /^LI:/.test(c)), `${id}: ${x.clicks}`);
  }
});

test("3, 4: honest forms are sent with the right answers in the right boxes", o, async () => {
  for (const id of SUBMIT) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r)}`);
    assert.deepEqual(x.posts.map((p) => p.path), [`/${id}/submit`], id);
  }
  assert.deepEqual(Object.fromEntries(Object.entries((await h.run("/u12")).posts[0].fields).filter(([k]) => /name/.test(k))), { "candidate[first_name]": "Casey", "candidate[last_name]": "Example" });
  assert.deepEqual([(await h.run("/u4")).posts[0].fields.first_name, (await h.run("/u4")).posts[0].fields.last_name], ["Casey", "Example"]);
});

test("2: success words in a sentence that says it did not work are not success", o, async () => {
  const x = await h.run("/p8");
  assert.equal(x.r.status, "unknown_outcome", JSON.stringify(x.r));
});
