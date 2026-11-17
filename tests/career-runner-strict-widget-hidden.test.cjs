"use strict";
// Review probe p07-widget-hidden (2026-11-17): a drawn listbox (no input) whose value lives in a hidden input the board pre-sets to
// "Remote", beside two other questions in one container. The rs-07 rule (a crowded container's widget is not the hidden value's) let
// that page-set "Remote" be posted as if confirmed. A crowded container's widget is dropped only when the hidden value is page
// structure (Teamtailor's job id: tests/career-runner-strict-teamtailor-jobid.test.cjs); here the value is asked. Mock employer.
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
// The drawn listbox's hidden value, by name and value: the page's preset choice as words, and (delta review probe p07-widget-hidden-id)
// as an id, which structural() would call page structure.
const mk = (name, val) => `<!doctype html><html><body><h1>Apply</h1><form action="/applications" method="post">
<label>First name <input name="first_name" required></label><label>Last name <input name="last_name" required></label>
<label>Email <input type="email" name="email" required></label>
<div class="section"><label>Nickname <input name="nickname"></label><label>Phone <input name="phone"></label>
<span id="wl">Preferred work location</span><div role="listbox" aria-labelledby="wl"><div role="option" aria-selected="true" data-id="3">Remote</div><div role="option" aria-selected="false" data-id="4">Office</div></div></div>
<input type="hidden" name="${name}" value="${val}">
<button type="submit">Submit application</button></form></body></html>`;
const PAGES = { "/a": mk("work_location", "Remote"), "/office_id": mk("office_id", "3"), "/location_id": mk("location[id]", "3"), "/officeId": mk("officeId", "3") };
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push(Buffer.concat(c).toString("latin1")); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; } res.writeHead(PAGES[req.url] ? 200 : 404, { "content-type": "text/html" }).end(PAGES[req.url] || ""); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wh-")), "cv.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("a page-set hidden value beside a drawn listbox in a crowded container is asked, never posted unconfirmed", { skip, timeout: 60000 }, async () => {
  const p = { id: "wh", ats: "greenhouse", url: `${base}/a`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((n) => /Remote/.test(n.detail || "")), JSON.stringify(r.needs));
  assert.deepEqual(posts, []);
});

for (const k of ["office_id", "location_id", "officeId"]) {
  test(`delta review of rs-07: an id-valued page-set hidden value (${k}=3) beside that listbox is asked, never posted unconfirmed`, { skip, timeout: 60000 }, async () => {
    const n = posts.length;
    const p = { id: "wh-" + k, ats: "greenhouse", url: `${base}/${k}`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { approval_id: "a-" + k, hash: payloadHash(p) };
    const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
    assert.equal(r.status, "not_submitted", JSON.stringify(r));
    assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
    assert.equal(posts.length, n);
  });
}
