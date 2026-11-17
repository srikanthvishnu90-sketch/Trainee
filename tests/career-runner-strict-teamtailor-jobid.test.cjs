"use strict";
// Teamtailor's application form (captured read-only 2026-11-16, tests/fixtures/runner-strict/teamtailor-bwb-6531346.html) keeps
// the posting's job_id as a hidden value in the container of the whole form, which also holds the phone widget's country search box
// (role=combobox, "Search"). The runner read the job_id as the value of that box and stopped: "Search: set by the page, not confirmed
// by you: 6531346" (answered run of 2026-11-16, 9 Teamtailor postings). A widget is a hidden value's own only when the container
// beside it holds at most one question. Local page, through the strict bench's answered column; nothing is posted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, answeredPosting } = require("../scripts/browser-eval/strict.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const html = fs.readFileSync(path.join(__dirname, "fixtures/runner-strict/teamtailor-bwb-6531346.html"), "utf8");
const CONSENT = "Required.By submitting this application, I agree that I have read the Privacy Policy and confirm that BWB Consulting store my personal details to be able to process my job application.";
let server, base, browser;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); } if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n"); res.writeHead(200, { "content-type": "text/html" }).end(html); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("the job_id beside the phone's country search is page data, not that box's answer: answered, the form reaches the instant before Submit", { skip, timeout: 180000 }, async () => {
  const o = { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tt-"))) };
  const item = { provider: "teamtailor", url: `${base}/jobs/6531346-senior-engineering-geologist` };
  const first = await strictPosting(browser, item, o);
  assert.ok((first.needs || []).some((n) => n.label === CONSENT), JSON.stringify(first.needs));
  const w = await answeredPosting(browser, item, o, first);
  assert.equal(w.result, "pass", JSON.stringify(w));
  assert.deepEqual(posts, []);
});
