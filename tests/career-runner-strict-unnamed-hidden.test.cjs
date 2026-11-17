"use strict";
// Breezy's form carries <input id="eeoc" type="hidden" value="true"> before its EEO section: a flag for the page's own script, with
// no name, so no form ever sends it. The runner read "true" as an answer the page set and stopped, with no label to ask the person
// (CI 44021741347: 4 Breezy rows). A nameless hidden value with no widget of its own is page data. A NAMED hidden "true" is still
// asked. Local page; the stop before the click is the test's; nothing is posted.
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
const page = (hidden) => `<!doctype html><html><body><h1>Apply</h1><form action="/apply" method="post"><label>Full Name <input name="cName" required></label>
<label>Email Address <input type="email" name="cEmail" required></label><label>Resume <input type="file" name="cResume"></label>
<div class="eeoc-form-container"><h2>We're an equal opportunity employer</h2>${hidden}</div><button type="submit">Submit application</button></form></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); }
    if (req.url.startsWith("/unnamed")) return res.writeHead(200, { "content-type": "text/html" }).end(page('<input id="eeoc" type="hidden" value="true">'));
    return res.writeHead(200, { "content-type": "text/html" }).end(page('<input id="eeoc" name="eeoc_opt_in" type="hidden" value="true">'));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uh-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
async function run(k) {
  const p = { id: k, ats: "breezy", url: `${base}/${k}/p/1`, facts: { full_name: "Casey Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  let reached = 0;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") { reached++; throw new NeedsUser("test_stop_before_click"); } } });
  return { r, reached };
}
test("an unnamed hidden page flag is page data: the form reaches the instant before Submit", { skip, timeout: 60000 }, async () => {
  const { r, reached } = await run("unnamed");
  assert.equal(reached, 1, JSON.stringify({ reason: r.reason, needs: r.needs }));
  assert.deepEqual(posts, []);
});
test("a named hidden 'true' the page set is still asked; never pressed", { skip, timeout: 60000 }, async () => {
  const { r, reached } = await run("named");
  assert.equal(reached, 0); assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  assert.deepEqual(posts, []);
});
