"use strict";
// Recruitee's phone widget (as read on 2026-11-16, deephealth.recruitee.com): once the page re-renders after the form is filled, the
// widget falls back to its own country and the box holds only "+31" (CI 44021741347: 13 held-out Recruitee postings ended
// value_changed_by_page). A box left with a bare dial code holds no number: the approved phone is set once more and read back by its
// digits. A box the page rewrote to OTHER digits is still refused. Local page; the stop before the click is the test's; nothing posted.
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
// The board's part: the first time the page settles after the phone was typed, the widget resets the box to its own dial code
// ("reset") or rewrites it to another number ("rewrite").
const page = (mode) => `<!doctype html><html><body><h1>Apply</h1><form action="/apply" method="post">
<label for="n">Full name *</label><input id="n" name="candidate.name" required><label for="e">Email address *</label><input id="e" type="email" name="candidate.email" required>
<label for="p">Phone number *</label><input id="p" type="tel" name="candidate.phone" required><label for="cv">CV</label><input id="cv" type="file" name="candidate.cv">
<button type="submit">Send</button></form><script>
let done = false; const ph = document.getElementById("p");
ph.addEventListener("input", () => { if (done) return; done = true; setTimeout(() => { ph.value = ${JSON.stringify(mode === "reset" ? "+31" : "+31 20 555 0199")}; }, 400); });
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); } res.writeHead(200, { "content-type": "text/html" }).end(page(req.url.includes("rewrite") ? "rewrite" : "reset")); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ph-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
async function run(k) {
  const p = { id: k, ats: "recruitee", url: `${base}/o/${k}/c/new`, facts: { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  let reached = 0;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") { reached++; throw new NeedsUser("test_stop_before_click"); } } });
  return { r, reached };
}
test("a phone box reset to a bare dial code is set again and read back: the form reaches the instant before Submit", { skip, timeout: 60000 }, async () => {
  const { r, reached } = await run("reset");
  assert.equal(reached, 1, JSON.stringify({ reason: r.reason, needs: r.needs }));
  assert.deepEqual(posts, []);
});
test("a phone box the page rewrote to other digits is still refused; never pressed", { skip, timeout: 60000 }, async () => {
  const { r, reached } = await run("rewrite");
  assert.equal(reached, 0); assert.equal(r.reason, "field_not_filled", JSON.stringify(r));
  assert.deepEqual(posts, []);
});
