"use strict";
// Round 4 (review of round 3) in Chromium, on the reviewer's pages (scratchpad s8), through the real runner. "clean": the employer
// may receive only what the card showed: no consent / sponsorship / marketing key anywhere, nothing posted elsewhere, no ping with
// answers. "submit": the honest application is posted to its own address. What left the browser is read from the server.
// The rules on plain data: tests/career-engine-round4.test.cjs.
// Run: node --test tests/career-engine-round4-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, EXP = {}, o = { skip, timeout: 600000 };
const def = (id, exp, body) => { EXP[id] = exp; P["/" + id] = doc(id, body); };
const app = (id, inner, attrs = "") => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data" ${attrs}>${inner}</form>`;
const ON = (js) => `<script>app.addEventListener('submit',function(e){${js}})</script>`;
const DONE = `.then(function(){document.body.innerHTML='<h1>Thank you for applying</h1>'})`;
const base = (id, extra = "") => app(id, F + extra + SUB);
// --- the page's own requests ---
def("x1", "clean", base("x1") + ON(`e.preventDefault();var o={};new FormData(app).forEach(function(v,k){if(typeof v==='string')o[k]=v});o.q_7='yes';o.q_9='I agree to the arbitration agreement';fetch('/x1/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)})${DONE}`));
def("x2", "clean", base("x2") + ON(`e.preventDefault();fetch('/x2/submit',{method:'POST',body:JSON.stringify({email:app.email.value,extra:{consent:true}})})${DONE}`));
def("x3", "clean", `<script>var F0=window.fetch;</script>` + base("x3") + ON(`e.preventDefault();F0('/x3/submit',{method:'POST',body:JSON.stringify({email:app.email.value,marketing_optin:true})})${DONE}`));
def("x4", "clean", base("x4") + ON(`e.preventDefault();fetch(new Request('/x4/submit',{method:'POST',body:JSON.stringify({email:app.email.value,consent:true})}))${DONE}`));
def("x5", "clean", base("x5") + ON(`e.preventDefault();fetch('/x5/submit',{method:'POST',body:new Blob([JSON.stringify({email:app.email.value,sponsorship:'yes'})],{type:'application/json'})})${DONE}`));
def("x6", "clean", base("x6") + ON(`var fd=new FormData();fd.append('consent','1');fd.append('email',app.email.value);navigator.sendBeacon('/x6/beacon',fd)`));
def("x7", "clean", base("x7") + ON(`new Image().src='/px?sponsorship=yes&marketing_optin=1&email='+encodeURIComponent(app.email.value)`));
def("x8", "clean", base("x8") + `<iframe name="ifr" id="ifr" srcdoc="<form action='/x8/side' method='post'><input name='consent' value='1'><input name='email'></form>" style="width:1px;height:1px;border:0"></iframe>` + ON(`var d=ifr.contentDocument;d.forms[0].email.value=app.email.value;d.forms[0].submit()`));
def("x9", "clean", `<script>var S0=XMLHttpRequest.prototype.send;</script>` + base("x9") + ON(`e.preventDefault();var x=new XMLHttpRequest();x.open('POST','/x9/submit');x.onload=function(){document.body.innerHTML='<h1>Thank you for applying</h1>'};S0.call(x,JSON.stringify({email:app.email.value,consent:true}))`));
def("x10", "clean", base("x10") + ON(`e.preventDefault();var p=new URLSearchParams();new FormData(app).forEach(function(v,k){if(typeof v==='string')p.append(k,v)});p.append('consent','1');fetch('/x10/submit',{method:'POST',body:p})${DONE}`));
def("x11", "clean", base("x11") + ON(`e.preventDefault();fetch('/x11/submit',{method:'POST',body:JSON.stringify({email:app.email.value,sponsorship_required:true})})${DONE}`));
def("x12", "clean", base("x12") + ON(`e.preventDefault();fetch('/x12/submit',{method:'POST',body:JSON.stringify({email:app.email.value,answers:[{id:12,value:'Yes'},{id:13,value:'I certify everything'}]})})${DONE}`));
def("x13", "clean", base("x13") + ON(`e.preventDefault();var f=document.createElement('form');f.method='post';f.action='/x13/submit';[['email',app.email.value],['consent','1']].forEach(function(p){var i=document.createElement('input');i.name=p[0];i.value=p[1];f.appendChild(i)});document.body.appendChild(f);f.submit()`));
def("x14", "clean", base("x14") + ON(`app.action='/x14/other'`));
def("x15", "clean", base("x15") + `<script>window.addEventListener('pagehide',function(){navigator.sendBeacon('/x15/beacon',JSON.stringify({email:app.email.value,consent:true}))})</script>`);
// --- labels ---
def("b1", "clean", app("b1", F + `<button type="submit" formaction="/b1/delete" aria-label="Submit"><svg width="18" height="18"><rect width="18" height="18"/></svg></button>`));
def("b4", "submit", app("b4", F + `<button type="submit" aria-label="Submit"><i class="fa fa-paper-plane" style="display:inline-block;width:16px;height:16px"></i></button>`));
def("b5", "submit", app("b5", F + `<button aria-label="Submit application form"><svg width="18" height="18"><rect width="18" height="18"/></svg></button>`));
def("b6", "clean", app("b6", F + `<span id="lbl" hidden>Save draft</span><button type="submit" aria-labelledby="lbl" formaction="/b6/draft">Submit</button>`));
def("b7", "clean", app("b7", F + `<button type="submit" name="intent" value="apply_and_subscribe_marketing">Submit</button>`));
// --- real ATS hidden fields (honest) ---
def("g1a", "submit", app("g1a", F + `<input type="hidden" name="job_application[gdpr_consent_given]" value="0"><label><input type="checkbox" name="job_application[gdpr_consent_given]" value="1"> I consent to the processing of my data (optional)</label>` + SUB));
def("g1b", "submit", app("g1b", F + `<input type="hidden" name="fingerprint" value="a8f3c2e1b7d94f6a"><input type="hidden" name="render_date" value="2026-11-13T10:00:00Z"><input type="hidden" name="page_load_time" value="1203"><input type="hidden" name="security_code" value="">` + SUB));
def("g2", "submit", app("g2", F + `<input type="hidden" name="accountId" value="3b1f2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"><input type="hidden" name="timezone" value="Europe/London"><input type="hidden" name="origin" value="https://jobs.example.test"><input type="hidden" name="linkedInData" value="">` + SUB));
def("g5", "submit", app("g5", F + `<input type="hidden" name="utm_source" value="Company Careers Page"><input type="hidden" name="source" value="Job board listing feed">` + SUB));
def("g6", "submit", app("g6", F + `<input type="hidden" name="job_application[answers_attributes][0][question_id]" value="12345678"><input type="hidden" name="job_application[answers_attributes][0][priority]" value="0"><label>Why us? <textarea name="job_application[answers_attributes][0][text_value]"></textarea></label>` + SUB));
def("g7", "clean", app("g7", F + `<input type="hidden" name="consent_given" value="true"><label><input type="checkbox" name="privacy_ack" value="1"> I have read the privacy notice</label>` + SUB));
def("g8", "clean", app("g8", F + `<input type="hidden" name="q_55" value="Yes">` + SUB));
// --- multi-step ---
const STEP = (id, s2, extraJs = "") => app(id, `<div id="s1">${F}</div><div id="s2" style="display:none">${s2}</div><button type="button" id="nx" onclick="s1.style.display='none';s2.style.display='';this.style.display='none';rv.style.display='';${extraJs}">Next</button><button type="button" id="rv" style="display:none" onclick="this.style.display='none';sb.style.display=''">Review</button><button type="submit" id="sb" style="display:none">Submit application</button>`);
def("m1", "submit", STEP("m1", "<p>Review your answers</p>"));
def("m2", "submit", app("m2", `<div id="s1">${F}</div><div id="s2" style="display:none"><p>Review</p><button type="button">Edit</button></div><button type="button" id="nx" onclick="s1.style.display='none';s2.style.display='';this.style.display='none';sb.style.display=''">Next</button><button type="submit" id="sb" style="display:none">Submit application</button>`));
def("m3", "clean", app("m3", `<div id="s1">${F}</div><div id="s2" style="display:none"><label>Website <input name="site"></label></div><button type="button" id="nx" onclick="s1.style.display='none';s2.style.display='';this.style.display='none';sb.style.display='';var h=document.createElement('input');h.type='hidden';h.name='marketing_optin';h.value='1';app.appendChild(h)">Continue</button><button type="submit" id="sb" style="display:none">Submit application</button>`));
// --- Indeed disguise ---
def("l11", "clean", `<button type="button" data-k="IND:split" onclick="window.location=['https://www.ind','eed.com/apply'].join('')">Apply</button>`);
const SENS = /consent|sponsor|marketing|optin|agree|certif|q_7|q_9|"answers"|intent|q_55/i;
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });
test("3, 1: nothing the card did not show leaves the browser: not by the page's own requests, not by the pressed control", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "clean")) {
    const x = await h.run("/" + id);
    const leak = x.posts.filter((p) => p.path !== `/${id}/submit` || Object.entries(p.fields).some(([k, v]) => SENS.test(k) || SENS.test(String(v))));
    assert.deepEqual(leak, [], `${id} ${JSON.stringify(x.r).slice(0, 300)}`);
    assert.deepEqual(x.hits.filter((u) => /\?/.test(u) && SENS.test(decodeURIComponent(u))), [], `${id}: a request carried answers in its address`);
    assert.ok(!x.clicks.some((c) => /^(LI|IND):/.test(c)), `${id}: ${x.clicks}`);
  }
});
test("2, 4: honest forms (structural hidden fields, a Review step, icon Submits) are sent to their own address", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "submit")) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r).slice(0, 400)}`);
    assert.deepEqual(x.posts.map((p) => p.path), [`/${id}/submit`], id);
  }
});
