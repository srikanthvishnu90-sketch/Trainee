"use strict";
// WO-M (strict benchmark run 42712892939, Greenhouse "Attach"): a board that swaps its file input for a chip naming the file
// once it has it still holds the resume. The runner reads the upload back from that chip, in the upload's own block, by the
// resume's own file name; a chip naming any other file is not the resume, and the run is handed back with nothing posted.
// Run: node --test tests/career-apply-upload-chip.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// On change the page keeps the file in script, removes the input and shows a chip ("<name> x"), as Greenhouse's uploader does.
const html = (k) => `<!doctype html><html><body><h2>Apply</h2><form method="post" action="/submit/${k}">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<div class="file-upload"><div class="label">Resume/CV *</div><div id="up"><button type="button">Attach</button>
<label class="visually-hidden" for="resume">Attach</label><input id="resume" type="file" name="resume" style="position:absolute;width:1px;height:1px;opacity:0"></div></div>
<input type="hidden" name="resume_name" id="rn">
<button type="submit">Submit application</button></form>
<script>document.getElementById("resume").addEventListener("change", (e) => { const f = e.target.files[0];
  const shown = ${k === "other_name" ? '"someone-else.pdf"' : "f.name"};
  document.getElementById("rn").value = f.name;
  document.getElementById("up").innerHTML = '<span class="chip">' + shown + '</span> <button type="button">x</button>'; });</script>
</body></html>`;
const PAGES = ["chip", "other_name"];

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") }); res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1 id=confirmation>Thank you for applying</h1></body></html>"); });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return PAGES.includes(k) ? res.writeHead(200, { "content-type": "text/html" }).end(html(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "upload-chip-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const job = (k) => {
  const p = { id: "up-" + k, ats: "greenhouse", url: `${base}/${k}`, facts: { first_name: "Casey" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};

test("an uploader that swaps its input for a chip naming the resume: filled, posted once", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("chip"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = posts.slice(n).filter((p) => p.url === "/submit/chip");
  assert.equal(mine.length, 1, "posted once");
  assert.equal(new URLSearchParams(mine[0].body).get("resume_name"), "resume.pdf");
});

test("an uploader whose chip names another file: handed back, nothing posted", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("other_name"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(posts.length - n, 0, "nothing may be posted");
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => x.reason === "upload_not_accepted"), JSON.stringify(r));
});
