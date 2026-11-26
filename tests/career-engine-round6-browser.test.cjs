"use strict";
// Round 6 (review of round 5) in Chromium, on the reviewer's pages (scratchpad s10), through the real runner, read from a server
// that logs every POST, every GET address and every WebSocket frame. The WebSocket endpoint is real (RFC 6455 handshake, masked
// frames decoded): a control page outside the runner proves frames reach it; under the runner, none does.
// Run: node --test tests/career-engine-round6-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, st, doc, F, SUB, skip } = require("./fixtures/engine-round2/harness.cjs");
const P = st.pages, D = st.dyn, o = { skip, timeout: 600000 };
const app = (id, inner) => `<form id="app" action="/${id}/submit" method="post" enctype="multipart/form-data">${inner}</form>`;
const ON = (js) => `<script>app.addEventListener('submit',function(e){${js}})</script>`;
const base = (id, extra = "") => app(id, F + extra + SUB);
const DONE = `document.body.innerHTML='<h1>Thank you for applying</h1>'`;
P["/v1"] = doc("v1", base("v1") + ON(`e.preventDefault();fetch('/v1/submit',{method:'POST',body:new FormData(app)}).then(function(){location.href='/v1/done/consent/1/sponsorship/yes'})`));
P["/v1/done/consent/1/sponsorship/yes"] = doc("ok", "<h1>Thank you for applying</h1>");
P["/v2"] = doc("v2", base("v2") + ON(`new Image().src='/px/consent/1/sponsorship/yes/pixel.png'`));
P["/v3"] = doc("v3", `<p hidden>relocate-anywhere</p>` + base("v3") + ON(`e.preventDefault();var p=new URLSearchParams();new FormData(app).forEach(function(v,k){if(typeof v==='string')p.append(k,v)});p.append('q_77','relocate-anywhere');fetch('/v3/submit',{method:'POST',body:p}).then(function(){${DONE}})`));
P["/v4"] = doc("v4", `<p hidden>relocate-anywhere</p>` + base("v4") + ON(`e.preventDefault();fetch('/v4/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:app.email.value,q_77:'relocate-anywhere'})}).then(function(){${DONE}})`));
P["/v6"] = doc("v6", base("v6") + `<script>var ws=new WebSocket('ws://'+location.host+'/ws');var S=WebSocket.prototype.send;</script>` + ON(`e.preventDefault();S.call(ws,JSON.stringify({consent:true,sponsorship:'yes'}));setTimeout(function(){app.submit()},400)`));
P["/ws-control"] = doc("control", `<script>var ws=new WebSocket('ws://'+location.host+'/ws');ws.onopen=function(){ws.send(JSON.stringify({consent:true}));document.title='sent'}</script>`);
P["/y1"] = doc("y1", base("y1") + ON(`e.preventDefault();fetch('/y1/submit',{method:'POST',body:new FormData(app)}).then(function(){location.href='/y1/thanks?application_id=98765'})`));
P["/y1/thanks"] = doc("ok", `<h1>Thank you for applying</h1>`);
void D;
const SENS = /consent|sponsor|q_77|relocate/i;
let h;
before(async () => { if (!skip) h = await start(); });
after(async () => { if (h) await h.stop(); });

test("v1-v4: no answer the card did not show leaves in a path, a query, a form field or a JSON key", o, async () => {
  for (const id of ["v1", "v2", "v3", "v4"]) {
    const x = await h.run("/" + id);
    await new Promise((r) => setTimeout(r, 600));
    const leak = [...st.posts.filter((p) => SENS.test(JSON.stringify(p.fields))).map((p) => `POST ${p.path}`), ...st.hits.filter((u) => SENS.test(decodeURIComponent(u))).map((u) => `GET ${u}`)];
    assert.deepEqual(leak, [], `${id} ${JSON.stringify(x.r).slice(0, 200)}`);
  }
});

test("v6: the WebSocket endpoint records frames from a page outside the runner, and none from a page under it", o, async () => {
  const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "/opt/node-tools/node_modules/playwright");
  const b = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
  try {
    st.ws.length = 0;
    const page = await b.newPage(); await page.goto(st.base + "/ws-control"); await page.waitForFunction(() => document.title === "sent", null, { timeout: 5000 }); await page.waitForTimeout(300);
    assert.equal(st.ws.length, 1, "the endpoint records a frame (control)");
  } finally { await b.close(); }
  const x = await h.run("/v6");
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(x.ws.concat(st.ws), [], `no frame from the page under the runner ${JSON.stringify(x.r).slice(0, 160)}`);
});

test("y1: a single-page app that posts the approved form and then goes to its thank-you page with an id is submitted", o, async () => {
  const x = await h.run("/y1");
  assert.equal(x.r.status, "submitted_page_confirmed", JSON.stringify(x.r).slice(0, 300));
  assert.deepEqual(x.posts.map((p) => p.path), ["/y1/submit"]);
});
