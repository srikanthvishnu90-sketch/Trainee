"use strict";
// Round 7 (review of round 6) in Chromium, on the reviewer's pages (scratchpad s11), through the real runner, read from a server that
// logs every POST and every GET address. "clean": no answer the card did not show reaches any address; "honest": sent.
// The rules on plain data: tests/career-engine-round7.test.cjs.
// Run: node --test tests/career-engine-round7-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, D = st.dyn, EXP = {}, o = { skip, timeout: 600000 };
const def = (id, exp, body) => { EXP[id] = exp; P["/" + id] = doc(id, body); };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data">${inner}</form>`;
const ON = (js) => `<script>app.addEventListener('submit',function(e){${js}})</script>`;
const OK = `document.body.innerHTML='<h1>Thank you for applying</h1>'`;
const CSS = `<link rel="stylesheet" href="/static/app.css">`;
const base = (id, extra = "") => CSS + app(id, F + extra + SUB);
P["/static/app.css"] = "body{}";
def("q1", "clean", base("q1") + ON(`e.preventDefault();fetch('/q1/submit',{method:'POST',body:new FormData(app)}).then(function(){location.href='/q1/done?d='+btoa(JSON.stringify({relocate:'anywhere',sponsor:'yes',email:app.email.value}))})`));
P["/q1/done"] = doc("ok", "<h1>Thank you for applying</h1>");
def("q2", "clean", base("q2") + ON(`e.preventDefault();location.href='/q2/a/relocate-anywhere/'+encodeURIComponent(app.email.value)`));
def("q3", "clean", base("q3") + ON(`new Image().src='/static/relocate-anywhere-salary-200k.png'`));
def("q4", "clean", base("q4") + ON(`new Image().src='/static/'+btoa('consent=1&sponsorship=yes').replace(/=/g,'')+'.png'`));
def("q5", "clean", `<input type="hidden" name="q_77" value="relocate-anywhere">` + base("q5") + ON(`e.preventDefault();var p=new URLSearchParams();new FormData(app).forEach(function(v,k){if(typeof v==='string')p.append(k,v)});p.append('q_77','relocate-anywhere');fetch('/q5/submit',{method:'POST',body:p}).then(function(){${OK}})`));
def("q6", "clean", base("q6", `<input type="hidden" name="ref_code" value="abc">`) + `<script>setTimeout(function(){app.ref_code.value='relocate-anywhere'},300)</script>`);
def("y4", "honest", base("y4") + ON(`e.preventDefault();fetch('/y4/submit',{method:'POST',body:new FormData(app)}).then(function(){location.href='/y4/thanks'})`));
P["/y4/thanks"] = doc("ok", "<h1>Thank you for applying</h1>");
def("y5", "honest", base("y5")); D["/y5"] = { after: (q, r) => r.writeHead(303, { location: "/consent-manager/continue?to=%2Fy5%2Fthanks" }).end() };
P["/consent-manager/continue"] = null; D["/consent-manager/continue"] = { get: (q, r) => r.writeHead(302, { location: "/y5/thanks" }).end() }; P["/y5/thanks"] = doc("ok", "<h1>Thank you for applying</h1>");
def("y6", "honest", base("y6")); D["/y6"] = { after: (q, r) => r.writeHead(303, { location: "/y6/thanks?application=abc123&source=careers" }).end() }; P["/y6/thanks"] = doc("ok", "<h1>Thank you for applying</h1>");
def("y7", "honest", base("y7")); D["/y7"] = { after: (q, r) => r.writeHead(303, { location: "/y7/thanks" }).end() }; P["/y7/thanks"] = doc("ok", `<img src="/img/thanks/ok.png" width="5" height="5"><h1>Thank you for applying</h1>`);
def("y8", "honest", base("y8")); D["/y8"] = { after: (q, r) => r.writeHead(303, { location: "/y8/thanks" }).end() }; P["/y8/thanks"] = doc("ok", `<script src="/static/cookie-consent-banner.js"></script><h1>Thank you for applying</h1>`);
for (const k of Object.keys(P)) if (P[k] === null) delete P[k];
const SENS = /consent|sponsor|relocate|salary|q_77|eyJ|Y29uc2VudD/i;
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });
test("q1-q6: nothing the card did not show reaches any address", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "clean")) {
    const x = await h.run("/" + id);
    await new Promise((r) => setTimeout(r, 600));
    const leak = [...st.posts.filter((p) => SENS.test(JSON.stringify(p.fields))).map((p) => `POST ${p.path}`), ...st.hits.filter((u) => SENS.test(u) && !/^\/consent-manager/.test(u)).map((u) => `GET ${u}`)];
    assert.deepEqual(leak, [], `${id} ${JSON.stringify(x.r).slice(0, 200)}`);
  }
});
test("y4-y8: honest outcome shapes are still sent", o, async () => {
  for (const id of Object.keys(EXP).filter((k) => EXP[k] === "honest")) {
    const x = await h.run("/" + id);
    assert.equal(x.r.status, "submitted_page_confirmed", `${id} ${JSON.stringify(x.r).slice(0, 300)}`);
  }
});
