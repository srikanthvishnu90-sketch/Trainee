"use strict";
// WO-M (strict benchmark run 42712892939: all 20 Ashby postings had forms=0 and 19 to 48 fields, so the runner said
// no_application_form_found): a board that builds its application without a <form> element is still an application when the
// page has no form of its own, asks for a file or an email, and has exactly one visible control in the Submit words. That
// control is the one pressed, after every field is filled and read back. Two such controls: nothing is pressed. Local fixtures.
// Run: node --test tests/career-apply-formless.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// The fields are drawn by script after load (as Ashby's are), in a div, and sent with fetch.
const page = (k) => `<!doctype html><html><body><h1>Engineer @ Acme</h1><div id="app"></div><script>
setTimeout(() => {
  document.getElementById("app").innerHTML = \`<div class="ashby-application-form-container">
  <label for="nm">Name *</label><input id="nm" name="_systemfield_name" required>
  <label for="em">Email *</label><input id="em" type="email" name="_systemfield_email" required>
  <label for="cv">Resume *</label><input id="cv" type="file" name="_systemfield_resume" required>
  <button type="button" id="go">Submit Application</button>${k === "two_submits" ? '<button type="button">Submit application</button>' : ""}</div>\`;
  document.getElementById("go").onclick = async () => {
    await fetch("/submit/${k}", { method: "POST", body: JSON.stringify({ name: document.getElementById("nm").value, email: document.getElementById("em").value, resume: (document.getElementById("cv").files[0] || {}).name }) });
    document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>';
  };
}, 300);
</script></body></html>`;
const PAGES = ["one_submit", "two_submits"];

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return PAGES.includes(k) ? res.writeHead(200, { "content-type": "text/html" }).end(page(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "formless-"));
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
  const p = { id: "fl-" + k, ats: "ashby", url: `${base}/${k}`, facts: { full_name: "Casey Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};

test("an application without a <form>: filled, read back, its one Submit pressed once, the approved values sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("one_submit"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = posts.slice(n).filter((p) => p.url === "/submit/one_submit");
  assert.equal(mine.length, 1, "sent once");
  assert.deepEqual(JSON.parse(mine[0].body), { name: "Casey Example", email: "casey@example.invalid", resume: "resume.pdf" });
});

test("an application without a <form> and two Submit controls: nothing pressed, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("two_submits"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(posts.length - n, 0, "nothing may be sent");
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.equal(r.reason, "no_application_form_found");
});
