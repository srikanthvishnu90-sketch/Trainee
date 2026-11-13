"use strict";
// Round 5 (review of round 4) in Chromium, on the reviewer's pages (scratchpad s9): what leaves the browser during the submit window,
// read from a server that logs every POST, every GET address and every WebSocket message. "clean": nothing the card did not show
// reaches any address (no consent / sponsorship, no other file); "honest": the board's own shape is sent.
// The rules on plain data: tests/career-engine-round5.test.cjs.
// Run: node --test tests/career-engine-round5-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, A = st.after, EXP = {}, X = {}, o = { skip, timeout: 900000 };
const D = st.dyn; void A;
const def = (id, exp, body, x) => { EXP[id] = exp; P["/" + id] = typeof body === "function" ? () => doc(id, body()) : doc(id, body); if (x) X[id] = x; };
const app = (id, inner, attrs = "") => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data" ${attrs}>${inner}</form>`;
const ON = (js) => `<script>app.addEventListener('submit',function(e){${js}})</script>`;
const DONE = `document.body.innerHTML='<h1>Thank you for applying</h1>'`;
const base = (id, extra = "") => app(id, F + extra + SUB);
def("n1", "clean", base("n1") + `<script>var ws=new WebSocket('ws://'+location.host+'/ws');</script>` + ON(`ws.send(JSON.stringify({email:app.email.value,consent:true,sponsorship:'yes'}))`));
def("n2", "clean", base("n2") + ON(`e.preventDefault();location.href='/n2/submit?email='+encodeURIComponent(app.email.value)+'&consent=1&sponsorship=yes'`));
def("n3", "clean", base("n3") + ON(`new Image().src='/px/consent/1/sponsorship/yes/'+encodeURIComponent(app.email.value)`));
def("n4", "clean", base("n4") + ON(`e.preventDefault();fetch('/n4/submit',{method:'POST',body:new FormData(app)}).then(function(){var f=document.createElement('form');f.method='post';f.action='/n4/second';f.innerHTML='<input name=consent value=1>';document.body.appendChild(f);f.submit()})`));
def("n5", "clean", `<script>var F0=window.fetch;</script>` + base("n5") + ON(`e.preventDefault();var fd=new FormData(app);fd.append('consent','1');F0('/n5/submit',{method:'POST',body:fd}).then(function(){${DONE}})`));
def("n6", "clean", `<script>var F0=window.fetch;</script>` + base("n6") + ON(`e.preventDefault();var fd=new FormData(app);fd.set('resume',new File(['NOT THE APPROVED RESUME, A DIFFERENT FILE'],'resume.pdf',{type:'application/pdf'}));F0('/n6/submit',{method:'POST',body:fd}).then(function(){${DONE}})`));
def("n7", "clean", `<script>var F0=window.fetch;</script>` + app("n7", F + `<label>Do you hold a driving licence? <select name="licence" required><option value="">Select</option><option>Yes</option><option>No</option></select></label>` + SUB) + ON(`e.preventDefault();F0('/n7/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({candidate:{email:app.email.value,first:app.first_name.value},answers:{q_77:'Yes',q_78:'Casey'}})}).then(function(){${DONE}})`), { answers: { "Do you hold a driving licence?": "Yes" } });
def("n9", "clean", () => base("n9") + `<iframe id="xo" src="${st.base.replace("127.0.0.1", "localhost")}/xo-frame" style="width:2px;height:2px;border:0"></iframe>` + ON(`xo.contentWindow.postMessage(app.email.value,'*')`));
P["/xo-frame"] = `<!doctype html><script>addEventListener('message',function(m){fetch('/n9/side',{method:'POST',body:new URLSearchParams({email:m.data,consent:'1'})});var f=document.createElement('form');f.method='post';f.action='/n9/side-form';f.innerHTML='<input name=consent value=1><input name=email value=\"'+m.data+'\">';document.body.appendChild(f);f.submit()})</script>`;
def("n10", "clean", base("n10") + `<script>navigator.serviceWorker.register('/sw.js');</script>` + ON(`navigator.serviceWorker.controller&&navigator.serviceWorker.controller.postMessage(app.email.value);navigator.serviceWorker.ready.then(function(r){r.active.postMessage(app.email.value)})`));
P["/sw.js"] = null; D["/sw.js"] = { get: (q, r) => r.writeHead(200, { "content-type": "text/javascript" }).end(`self.addEventListener('install',function(){self.skipWaiting()});self.addEventListener('activate',function(e){e.waitUntil(clients.claim())});self.addEventListener('message',function(m){fetch('/n10/sw-side',{method:'POST',body:'consent=1&email='+encodeURIComponent(m.data),headers:{'content-type':'application/x-www-form-urlencoded'}});fetch('/n10/sw-get?consent=1&email='+encodeURIComponent(m.data))})`) };
def("n11", "honest", base("n11")); D["/n11"] = { after: (q, r) => r.writeHead(302, { location: "/n11/a?step=1&ref=apply" }).end() };
P["/n11/a"] = null; D["/n11/a"] = { get: (q, r) => r.writeHead(302, { location: "/n11/done" }).end() }; P["/n11/done"] = doc("ok", "<h1>Thank you for applying</h1>");
def("n12", "clean", base("n12") + ON(`e.preventDefault();fetch('/n12/submit',{method:'POST',body:new FormData(app)}).then(function(){${DONE};setTimeout(function(){fetch('/n12/late',{method:'POST',body:'consent=1&sponsorship=yes',headers:{'content-type':'application/x-www-form-urlencoded'}})},2500);setTimeout(function(){fetch('/n12/later',{method:'POST',body:'consent=1',headers:{'content-type':'application/x-www-form-urlencoded'}})},6500)})`));
def("n13", "clean", `<script>var SB=navigator.sendBeacon.bind(navigator);</script>` + base("n13") + ON(`SB('/n13/beacon',new URLSearchParams({consent:'1',email:app.email.value}))`));
def("n14", "clean", base("n14") + ON(`e.preventDefault();var fd=new FormData(app);fetch('/n14/submit',{method:'POST',body:fd}).then(function(){${DONE}});var g=new FormData(app);g.append('consent','1');fetch('/n14/submit',{method:'POST',body:g,keepalive:true})`));
def("n15", "clean", base("n15") + ON(`var x=new XMLHttpRequest();x.open('GET','/collect?consent=1&email='+encodeURIComponent(app.email.value));x.send()`));
def("n16", "clean", base("n16") + ON(`var l=document.createElement('link');l.rel='prefetch';l.href='/prefetch?consent=1&sponsorship=yes';document.head.appendChild(l)`));
def("n17", "clean", base("n17") + ON(`document.body.style.backgroundImage='url(/bg?consent=1&sponsorship=yes)'`));
def("n18", "clean", base("n18") + ON(`var s=document.createElement('script');s.src='/jsonp?consent=1&sponsorship=yes&email='+encodeURIComponent(app.email.value);document.head.appendChild(s)`));
def("n19", "clean", base("n19") + ON(`var l=document.createElement('link');l.rel='stylesheet';l.href='/css?consent=1&sponsorship=yes&email='+encodeURIComponent(app.email.value);document.head.appendChild(l)`));
// --- honest board shapes ---
def("h1", "honest", app("h1", `<label>First Name <input name="job_application[first_name]"></label><label>Last Name <input name="job_application[last_name]"></label><label>Email <input type="email" name="job_application[email]"></label><label>Resume <input type="file" name="job_application[resume]"></label><input type="hidden" name="job_application[answers_attributes][0][question_id]" value="12345678"><input type="hidden" name="job_application[answers_attributes][0][priority]" value="0"><label>LinkedIn Profile <input name="job_application[answers_attributes][0][text_value]"></label><input type="hidden" name="utm_source" value="Company Careers Page"><input type="hidden" name="gh_src" value="a1b2c3"><input type="button" id="submit_app" value="Submit Application" onclick="this.form.submit()">`));
def("h2", "honest", app("h2", F + SUB) + ON(`e.preventDefault();fetch('/h2/api/v1/jobs/AB12CD34/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({candidate:{firstname:app.first_name.value,lastname:app.last_name.value,email:app.email.value},job_shortcode:'AB12CD34',domain:'apply.example.test',answers:[]})}).then(function(){${DONE}})`));
def("h3", "honest", app("h3", `<label>Full name <input name="name"></label><label>Email <input type="email" name="email"></label><label>Resume <input type="file" name="resume"></label><input type="hidden" name="accountId" value="3b1f2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"><input type="hidden" name="origin" value="https://jobs.example.test"><input type="hidden" name="h-captcha-response" value=""><button type="submit" style="display:none" id="hs">x</button><button type="button" onclick="this.form['h-captcha-response'].value='P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.token';this.form.submit()">Submit application</button>`));
def("h4", "honest", app("h4", F + SUB) + ON(`e.preventDefault();var fd=new FormData(app);fd.append('job_application[source]','job_board');fetch('/h4/submit',{method:'POST',body:fd}).then(function(){${DONE}})`));
def("h5", "honest", app("h5", `<label>Full name <input name="candidate[name]"></label><label>Email address <input type="email" name="candidate[email]"></label><label>CV or resume <input type="file" name="candidate[cv]"></label><input type="hidden" name="utf8" value="✓"><input type="submit" name="commit" value="Submit application">`));
def("h6", "honest", app("h6", `<div id="s1">${F}</div><div id="s2" style="display:none"><label>Website <input name="site"></label></div><button type="button" id="nx" onclick="s1.style.display='none';s2.style.display='';this.style.display='none';sb.style.display=''">Continue</button><button type="submit" id="sb" style="display:none">Submit application</button>`, `method="post" enctype="application/x-www-form-urlencoded"`));
// The same two with the page holding its own submission back long enough for the side channel to deliver (the reviewer's n1 and
// n9 navigate at once, so the socket message and the frame's request may die with the page): proves the channel is closed.
def("n1b", "clean", base("n1b") + `<script>var ws=new WebSocket('ws://'+location.host+'/ws');</script>` + ON(`e.preventDefault();ws.send(JSON.stringify({email:app.email.value,consent:true,sponsorship:'yes'}));setTimeout(function(){app.submit()},400)`));
def("n9b", "clean", () => base("n9b") + `<iframe id="xo" src="${st.base.replace("127.0.0.1", "localhost")}/xo-frame" style="width:2px;height:2px;border:0"></iframe>` + ON(`e.preventDefault();xo.contentWindow.postMessage(app.email.value,'*');setTimeout(function(){app.submit()},600)`));
for (const k of Object.keys(P)) if (P[k] === null) delete P[k];
const SENS = /consent|sponsor|NOT THE APPROVED|q_77|q_78/i;
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });
test("nothing the card did not show leaves the browser during the submit window, by any request or a WebSocket", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "clean")) {
    const x = await h.run("/" + id, X[id] || {});
    await new Promise((r) => setTimeout(r, 600));
    const leak = [...st.posts.filter((p) => SENS.test(JSON.stringify(p.fields))).map((p) => `POST ${p.path}`), ...st.hits.filter((u) => SENS.test(decodeURIComponent(u))).map((u) => `GET ${u}`), ...st.ws.filter((m) => SENS.test(m)).map((m) => `WS ${m}`)];
    assert.deepEqual(leak, [], `${id} ${JSON.stringify(x.r).slice(0, 200)}`);
  }
});
test("the boards' honest shapes are sent", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "honest")) {
    const x = await h.run("/" + id, X[id] || {});
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r).slice(0, 300)}`);
  }
});
