"use strict";
// Architect ruling (2026-11-16): the apply VM drives Ashby. Through the real worker (createWorker: claim, resume, approval hash,
// "submitting" before the click) and the real engine in Chromium, an approved Ashby-style application (no <form>; system fields
// worded as sentences; an optional texting consent under the Phone label) on a local page is filled from the approved answers, read back, sent
// exactly once, and ends submitted_unconfirmed with the labels it sent. A posting whose approval hash no longer matches is never
// opened. Local only (a loopback /ashby/ path, as the VM's mock Greenhouse and Lever tests).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { createWorker, queueHash, atsOf } = require("../workers/career-browser/apply-vm.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const entry = (id, label, inner) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="${id}">${label}</label>${inner}</div>`;
const YES = "Yes - I consent to receiving text messages", NO = "No - I do not consent to receiving text messages";
const PAGE = `<!doctype html><html><body><h1>Engineer @ Acme</h1><div id="app"></div><script>
setTimeout(() => { document.getElementById("app").innerHTML = ${JSON.stringify(`<div class="ashby-application-form-container">${[
  entry("name", "Your Full Name", '<input id="name">'), entry("email", "Email", '<input id="email" type="email">'),
  entry("resume", "Resume", '<input id="resume" type="file">'), entry("phone", "Phone", '<input id="phone" type="tel">'),
  `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Phone</label><div class="ashby-application-form-input-yesno"><button type="button" class="yn" aria-pressed="false">${YES}</button><button type="button" class="yn" aria-pressed="false">${NO}</button><input type="checkbox" name="sms" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px"></div></div>`,
  entry("why", "Why Acme?", '<textarea id="why"></textarea>'),
].join("")}<button type="button" id="go" class="ashby-application-form-submit-button">Submit Application</button></div>`)};
  for (const b of document.querySelectorAll(".yn")) b.onclick = () => { for (const x of b.parentElement.querySelectorAll(".yn")) x.setAttribute("aria-pressed", String(x === b)); };
  document.getElementById("go").onclick = async () => { const v = (id) => document.getElementById(id).value; const sms = [...document.querySelectorAll(".yn")].find((b) => b.getAttribute("aria-pressed") === "true");
    await fetch(location.pathname + "/submit", { method: "POST", body: JSON.stringify({ name: v("name"), email: v("email"), phone: v("phone"), sms: sms ? sms.textContent : null, why: v("why"), resume: (document.getElementById("resume").files[0] || {}).name }) });
    document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>'; };
}, 200);</script></body></html>`;
let server, base, browser;
const posts = [], loads = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(c).toString() }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); }); return; }
    loads.push(req.url);
    return /^\/ashby\/acme\/[\w-]+$/.test(req.url) ? res.writeHead(200, { "content-type": "text/html" }).end(PAGE) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const RES = Buffer.from("%PDF-1.4 TEST resume\n"), RSHA = crypto.createHash("sha256").update(RES).digest("hex");
function row(url, { tamper = false } = {}) {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000001", job_id: "ashby:acme:1", company: "Acme", url, resume_sha256: RSHA,
    fields: [{ label: "Your Full Name", value: "Casey Example", factId: "f1" }, { label: "Email", value: "casey@example.invalid", factId: "f2" }, { label: "Phone", value: "+1 312 555 0100", factId: "f3" }, { label: "Why Acme?", value: "I build payment systems.", factId: "a1" }] };
  const h = queueHash(payload);
  return { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), url, user_id: payload.user_id, payload, payload_hash: h, approval_hash: tamper ? "0".repeat(64) : h, approval_id: crypto.randomUUID() };
}
async function once(r) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "career_apply_vm_claim") return calls.filter((c) => c.name === name).length === 1 ? [r] : [];
    if (name === "career_apply_vm_resume") return { filename: "Casey-Example-Resume.pdf", sha256: RSHA, b64: RES.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    return {};
  };
  const w = createWorker({ rpc, browser, evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-ashby-")), log: () => {}, retries: 0, stepTimeoutMs: 8000 });
  assert.equal(await w.tick(), 1);
  while (w.inflight.size) await new Promise((x) => setTimeout(x, 10));
  return calls;
}

test("the VM takes jobs.ashbyhq.com as Ashby (exact host) and the loopback /ashby/ path for this test", () => {
  assert.equal(atsOf("https://jobs.ashbyhq.com/acme/9b6c").ats, "ashby");
  assert.equal(atsOf(`http://127.0.0.1:9/ashby/acme/1`).ats, "ashby");
});

test("an approved Ashby application through the VM: filled from the approved answers, sent once, submitted_unconfirmed", { skip, timeout: 90000 }, async () => {
  const n = posts.length;
  const calls = await once(row(`${base}/ashby/acme/9b6c`));
  const done = calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args);
  assert.equal(done.length, 1, JSON.stringify(calls.map((c) => c.name)));
  assert.equal(done[0].p_state, "submitted_unconfirmed", JSON.stringify(done[0]));
  const phases = calls.filter((c) => c.name === "career_apply_vm_heartbeat").map((c) => c.args.p_phase);
  assert.ok(phases.includes("submitting"), `"submitting" recorded before the click: ${phases}`);
  const mine = posts.slice(n);
  assert.equal(mine.length, 1, "sent exactly once");
  const body = JSON.parse(mine[0].body);
  assert.deepEqual({ name: body.name, email: body.email, phone: body.phone, why: body.why, resume: body.resume }, { name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100", why: "I build payment systems.", resume: "Casey-Example-Resume.pdf" });
  assert.equal(body.sms, null, "the texting consent nobody approved is left alone");
});

test("an Ashby row whose approval no longer matches its payload is never opened; nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length, l = loads.length;
  const calls = await once(row(`${base}/ashby/acme/tampered`, { tamper: true }));
  const done = calls.filter((c) => c.name === "career_apply_vm_complete").map((c) => c.args);
  assert.equal(done[0].p_state, "not_submitted");
  assert.equal(posts.length, n); assert.equal(loads.length, l, "the page was never loaded");
});
