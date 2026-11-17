"use strict";
// One label over a number box and a choice (Ashby's "Phone" over the phone box and a texting-consent Yes/No; strict answered run
// of 2026-11-16: jobs.ashbyhq.com/vanta and /hiya stopped label_on_form_twice once the consent was answered). An approved answer
// that is exactly one of the choice's options is the choice's; the box takes the confirmed phone. Two boxes under one label, or an
// answer that is no option of the choice, still go back to the person. Local page, a mock employer that records what it gets.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const entry = (id, label, inner, req = true) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title${req ? " _required_x" : ""}" for="${id}">${label}</label>${inner}</div>`;
const YES = "Yes - I consent to receiving text messages", NO = "No - I do not consent to receiving text messages";
const yesno = (id, label) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x">${label}</label><div class="ashby-application-form-input-yesno"><button type="button" class="yn" aria-pressed="false">${YES}</button><button type="button" class="yn" aria-pressed="false">${NO}</button><input type="checkbox" name="${id}" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px"></div></div>`;
function page(k) {
  const fields = [
    entry("name", "Your Full Name", '<input id="name">'), entry("email", "Email", '<input id="email" type="email">'),
    entry("resume", "Resume", '<input id="resume" type="file">'), entry("phone", "Phone", '<input id="phone" type="tel">'),
    k === "two_boxes" ? entry("phone2", "Phone", '<input id="phone2" type="tel">') : yesno("sms", "Phone"),
  ].join("");
  return `<!doctype html><html><body><h1>Engineer</h1><div id="app">${`<div class="ashby-application-form-container">${fields}<button type="button" id="go" class="ashby-application-form-submit-button">Submit Application</button></div>`}</div><script>
  for (const b of document.querySelectorAll(".yn")) b.onclick = () => { for (const x of b.parentElement.querySelectorAll(".yn")) x.setAttribute("aria-pressed", String(x === b)); };
  document.getElementById("go").onclick = async () => { const v = (id) => (document.getElementById(id) || {}).value; const sms = [...document.querySelectorAll(".yn")].find((b) => b.getAttribute("aria-pressed") === "true");
    await fetch("/submit/${k}", { method: "POST", body: JSON.stringify({ name: v("name"), email: v("email"), phone: v("phone"), sms: sms ? sms.textContent : null }) });
    document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>'; };</script></body></html>`;
}
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(c).toString() }); res.writeHead(200).end("{}"); }); return; }
    const k = req.url.slice(1);
    return ["consent", "two_boxes"].includes(k) ? res.writeHead(200, { "content-type": "text/html" }).end(page(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twin-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const FACTS = { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100" };
const job = (k, answers) => { const p = { id: k, ats: "ashby", url: `${base}/${k}`, facts: FACTS, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "a-" + k, hash: payloadHash(p) }; return p; };

test("the consent answer goes to the choice, the confirmed phone to the box; sent once with both", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("consent", { Phone: YES }), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = posts.slice(n);
  assert.equal(mine.length, 1);
  assert.deepEqual(JSON.parse(mine[0].body), { name: "Casey Example", email: "casey@example.invalid", phone: FACTS.phone, sms: YES });
});
test("the VM's way (no facts; the phone approved under 'Phone'): the number goes to the box, the required consent is asked; nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const p = job("consent", { Phone: FACTS.phone }); p.facts = { full_name: FACTS.full_name, email: FACTS.email }; p.approval.hash = payloadHash(p);
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  assert.deepEqual((r.needs || []).map((x) => [x.label, x.reason, x.kind]), [["Phone", "no_confirmed_answer", "buttons"]]);
  assert.ok((r.filled_labels || []).includes("Phone"), JSON.stringify(r.filled_labels));
  assert.equal(posts.length, n);
});
test("an answer that is no option of the choice, or two boxes under the label: handed back, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const a = await applyOne(browser, job("consent", { Phone: "Maybe later" }), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(a.status, "not_submitted"); assert.ok((a.needs || []).some((x) => x.reason === "label_on_form_twice"), JSON.stringify(a.needs));
  const b = await applyOne(browser, job("two_boxes", { Phone: "+1 312 555 0100" }), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(b.status, "not_submitted"); assert.ok((b.needs || []).some((x) => x.reason === "label_on_form_twice"), JSON.stringify(b.needs));
  assert.equal(posts.length, n);
});
