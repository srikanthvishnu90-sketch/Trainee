"use strict";
// Independent review of #340: workers/career-browser/parallel-apply.cjs stopped only on needsUser and invalid. An OPTIONAL
// question whose approved answer could not be set and read back (ats-fill.cjs puts it in `failed`: readback_mismatch,
// fill_error) did not stop the run, so Submit went with the field holding something other than the approved value. The run
// must stop (field_not_filled) with nothing posted, whatever the field's required flag.
// Run: UPMORE_PLAYWRIGHT_PATH=tools/node_modules/playwright node --test tests/career-apply-optional-failed.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// "Nickname" is optional; the page rewrites whatever is typed into it, so the read-back never equals the approved answer.
const PAGE = (rewrite) => `<!doctype html><html><body><h2>Apply</h2><form method="post" action="/submit">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="nn">Nickname</label><input id="nn" name="nickname">
<label for="cv">Resume/CV *</label><input id="cv" type="file" name="resume" required>
<button type="submit">Submit application</button></form>
${rewrite ? `<script>for (const ev of ["input","change","blur"]) document.getElementById("nn").addEventListener(ev, (e) => { e.target.value = "REWRITTEN"; });</script>` : ""}
</body></html>`;

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") }); res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1 id=confirmation>Thank you for applying</h1></body></html>"); });
      return;
    }
    const k = req.url.split("?")[0];
    return k === "/rewrite" || k === "/plain" ? res.writeHead(200, { "content-type": "text/html" }).end(PAGE(k === "/rewrite")) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "opt-failed-"));
  resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const job = (k) => {
  const p = { id: "j-" + k, ats: "greenhouse", url: `${base}/${k}`, facts: { first_name: "Casey" }, answers: { Nickname: "Case" }, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};

test("control: an optional answer that reads back is posted exactly", { skip, timeout: 60000 }, async () => {
  const before = posts.length;
  const r = await applyOne(browser, job("plain"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.equal(new URLSearchParams(posts[before].body).get("nickname"), "Case");
});

test("an optional answer that cannot be read back stops the run: field_not_filled, nothing posted", { skip, timeout: 60000 }, async () => {
  const before = posts.length;
  const r = await applyOne(browser, job("rewrite"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(posts.length - before, 0, `nothing may be posted (the employer got ${JSON.stringify(posts.slice(before).map((p) => p.body))})`);
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.equal(r.reason, "field_not_filled", JSON.stringify(r));
});
