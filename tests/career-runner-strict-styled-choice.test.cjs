"use strict";
// A styled Yes/No whose radio input sits outside the page's view under its own label (answered run of 2026-11-16: "Clicking the
// checkbox did not change its state" on 8 postings across Teamtailor, Ashby, Lever and Recruitee): a click at the input's point
// changes nothing. The runner clicks that same tagged input in the page, and reads back the choice. Same for a
// styled consent box. Local page and mock employer.
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
// The input is drawn under the board's own decoration (a layer outside the label, over the input's point), as styled options are.
const HIDE = 'style="position:relative;z-index:0"';
const COVER = '<i style="position:absolute;display:block;width:22px;height:22px;margin-top:-20px;z-index:5;background:#fff"></i>';
const PAGE = `<!doctype html><html><body><h1>Apply</h1><form action="/applications" method="post">
<label>First name <input name="first_name" required></label><label>Last name <input name="last_name" required></label>
<label>Email <input type="email" name="email" required></label><label>Resume <input type="file" name="resume"></label>
<fieldset><legend>Are you comfortable travelling? *</legend>
<div><label class="opt"><input type="radio" name="travel" value="yes" required ${HIDE}><span>Yes</span></label>${COVER}</div>
<div><label class="opt"><input type="radio" name="travel" value="no" ${HIDE}><span>No</span></label>${COVER}</div></fieldset>
<div><label class="opt"><input type="checkbox" name="consent" value="1" required ${HIDE}><span>I agree to the privacy policy *</span></label>${COVER}</div>
<button type="submit">Send application</button></form></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push(Buffer.concat(c).toString()); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    return req.url === "/job" ? res.writeHead(200, { "content-type": "text/html" }).end(PAGE) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "styled-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("a styled radio and consent box are chosen through their own inputs and read back; sent once with exactly them", { skip, timeout: 60000 }, async () => {
  const p = { id: "s", ats: "recruitee", url: `${base}/job`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" },
    answers: { "Are you comfortable travelling?": "No", "I agree to the privacy policy": "Yes" }, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.equal(posts.length, 1);
  assert.match(posts[0], /name="travel"\r\n\r\nno\r\n|travel=no/);
  assert.match(posts[0], /name="consent"\r\n\r\n1\r\n|consent=1/);
});
