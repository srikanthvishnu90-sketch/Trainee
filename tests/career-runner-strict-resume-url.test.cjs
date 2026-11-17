"use strict";
// Teamtailor's upload script stores the chosen resume and writes where it stored it into a box of the form,
// candidate[resume_remote_url] (answered run of 2026-11-16: 9 Teamtailor postings stopped on it as "set by the page, not confirmed
// by you"). That box carries the approved resume itself: an https address ending in the resume's own file name. Any other value
// the page puts there (another file, a plain http address) is still asked. Local page and mock employer.
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
const page = (stored, prefill) => `<!doctype html><html><body><h1>Apply</h1><form id="f" action="/applications" method="post">
<label>First name <input name="candidate[first_name]" required></label><label>Last name <input name="candidate[last_name]" required></label>
<label>Email <input type="email" name="candidate[email]" required></label>
<label>Resume <input type="file" id="cv" name="candidate[resume]"></label>
<input type="text" name="candidate[resume_remote_url]" value="${prefill || ""}" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true">
<button type="submit">Send application</button></form><script>
document.getElementById("cv").addEventListener("change", (e) => { const f = e.target.files[0];
  document.querySelector("[name='candidate[resume_remote_url]']").value = ${JSON.stringify(stored)}.replace("{name}", f ? f.name : ""); });
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(c).toString() }); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    if (req.url === "/own") return res.writeHead(200, { "content-type": "text/html" }).end(page("https://storage.example/uploads/7f3a/{name}"));
    // Review probe p05-resume-url-stale: the page itself puts another file's address there at load (no upload by this run), one
    // that merely ends in the approved file's name; this run's upload then leaves it as it is.
    if (req.url === "/stale") return res.writeHead(200, { "content-type": "text/html" }).end(page("", "https://attacker-or-stale.example/someone-else/Casey-Example-Resume.pdf").replace(/document\.getElementById\("cv"\)\.addEventListener[\s\S]*?\}\);/, ""));
    if (req.url === "/other") return res.writeHead(200, { "content-type": "text/html" }).end(page("https://storage.example/uploads/7f3a/someone-else.pdf"));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rurl-")), "Casey-Example-Resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const job = (k) => { const p = { id: k, ats: "teamtailor", url: `${base}/${k}`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "a-" + k, hash: payloadHash(p) }; return p; };

test("the box holding the stored resume's own address is the resume, not a page default: sent once", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("own"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.equal(posts.length - n, 1);
});
test("another file's address in that box is still asked; nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("other"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
  assert.equal(posts.length, n);
});

test("an address the page put in that box at load is never the resume, even with the approved file's name: asked, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("stale"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
  assert.equal(posts.length, n);
});
