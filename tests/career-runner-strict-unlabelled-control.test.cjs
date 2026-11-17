"use strict";
// Breezy's "Desired Salary" holds an amount box and a salary-period select with no label, name or placeholder of its own, preset by the
// page to "Yearly" (read 2026-11-16). The runner asked about it as a value "set by the page, not confirmed by you" with an empty name,
// which nobody could answer (CI 44021741347). It is now named by the heading just before it and its kind ("Desired Salary
// (select-one)"): handed back in words, and once the person confirms the shown value the form reaches the instant before Submit.
// Local page; the stop before the click is the test's; nothing is posted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256, NeedsUser } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const PAGE = `<!doctype html><html><body><h1>Apply</h1><form action="/apply" method="post">
<h3>Full Name *</h3><input name="cName" placeholder="Full Name" required><h3>Email Address *</h3><input type="email" name="cEmail" placeholder="Email Address" required>
<div class="desired-salary"><h3>Desired Salary</h3><input type="text" name="salaryAmount" placeholder="Amount">
<select class="salary-period"><option value="yearly" selected>Yearly</option><option value="hourly">Hourly</option></select></div>
<button type="submit">Submit application</button></form></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); } res.writeHead(200, { "content-type": "text/html" }).end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ul-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
async function run(answers) {
  const p = { id: "ul", ats: "breezy", url: `${base}/p/1-x`, facts: { full_name: "Casey Example", email: "casey@example.invalid" }, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  let reached = 0;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") { reached++; throw new NeedsUser("test_stop_before_click"); } } });
  return { r, reached };
}
test("the unlabelled preset select is handed back named by its heading, and reaches Submit once the person confirms it", { skip, timeout: 60000 }, async () => {
  const a = await run({});
  assert.equal(a.reached, 0);
  const q = (a.r.needs || []).find((n) => /set by the page/.test(n.detail || ""));
  assert.equal(q && q.label, "Desired Salary (select-one)", JSON.stringify(a.r.needs));
  const b = await run({ "Desired Salary (select-one)": "Yearly" });
  assert.equal(b.reached, 1, JSON.stringify({ reason: b.r.reason, needs: b.r.needs }));
  assert.deepEqual(posts, []);
});
