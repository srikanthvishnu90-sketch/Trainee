"use strict";
// A dropdown whose list floats in a layer at the end of the page once it is opened (Ashby's own dropdowns; strict answered run of
// 2026-11-16: "How did you hear about iwoca and / or this role?" stopped options_not_readable with the person's answer in hand). The
// runner reads that one new list as the box's own, picks the approved option and reads it back; handed back unanswered, the question
// carries the options it offers. Another list already on the page is never read as this box's. Local page and mock employer.
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
const entry = (id, label, inner) => `<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="${id}">${label}</label>${inner}</div>`;
const SOURCES = ["LinkedIn", "Referral", "Company website"];
const PAGE = `<!doctype html><html><body><h1>Engineer</h1>
<div role="listbox" aria-label="Elsewhere"><div role="option">Referral</div></div>
<div class="ashby-application-form-container">
${entry("name", "Your Full Name", '<input id="name">')}${entry("email", "Email", '<input id="email" type="email">')}${entry("resume", "Resume", '<input id="resume" type="file">')}
${entry("src", "How did you hear about us?", '<input id="src" role="combobox" aria-expanded="false" aria-haspopup="listbox" readonly>')}
<button type="button" id="go" class="ashby-application-form-submit-button">Submit Application</button></div>
<script>
const src = document.getElementById("src");
src.onclick = () => { if (document.getElementById("float")) return; const l = document.createElement("div"); l.id = "float"; l.innerHTML = '<div role="listbox">' + ${JSON.stringify(SOURCES)}.map((s) => '<div role="option">' + s + '</div>').join("") + '</div>';
  document.body.appendChild(l); src.setAttribute("aria-expanded", "true");
  for (const o of l.querySelectorAll("[role=option]")) o.onclick = () => { src.value = o.textContent; l.remove(); src.setAttribute("aria-expanded", "false"); }; };
src.onkeydown = (e) => { if (e.key === "Escape") { const l = document.getElementById("float"); if (l) l.remove(); src.setAttribute("aria-expanded", "false"); } };
document.getElementById("go").onclick = async () => { await fetch("/submit", { method: "POST", body: JSON.stringify({ name: document.getElementById("name").value, src: src.value }) }); document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>'; };
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push(Buffer.concat(c).toString()); res.writeHead(200).end("{}"); }); return; }
    return req.url === "/job" ? res.writeHead(200, { "content-type": "text/html" }).end(PAGE) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "float-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const job = (answers) => { const p = { id: "f", ats: "ashby", url: `${base}/job`, facts: { full_name: "Casey Example", email: "casey@example.invalid" }, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "a", hash: payloadHash(p) }; return p; };

test("unanswered, the floating dropdown goes back to the person with the options it offers; nothing sent", { skip, timeout: 60000 }, async () => {
  const r = await applyOne(browser, job({}), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  const q = (r.needs || []).find((n) => n.label === "How did you hear about us?");
  assert.deepEqual(q && q.options, SOURCES, JSON.stringify(r.needs));
  assert.deepEqual(posts, []);
});
test("answered, the approved option is picked from the floating list and read back; sent once", { skip, timeout: 60000 }, async () => {
  const r = await applyOne(browser, job({ "How did you hear about us?": "Company website" }), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0]), { name: "Casey Example", src: "Company website" });
});
