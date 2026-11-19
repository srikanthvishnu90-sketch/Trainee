"use strict";
// Architect ruling (2026-11-16): the strict benchmark measures open postings only. A row whose address answers 404 or 410 at the
// start of its run is closed at the start and never driven; a posting the runner finds closed on the page is closed too. Both are
// reported apart and left out of the open denominator; the all-rows headline stays beside it. Local pages only; nothing sent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, summarize, markdown } = require("../scripts/browser-eval/strict.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const hits = {}, posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/gone") return res.writeHead(410).end("gone");
    if (req.url === "/open") return res.writeHead(200, { "content-type": "text/html" }).end(`<form action="/s" method="post"><label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label><label>Email <input name="email" type="email" required></label><button type="submit">Submit application</button></form>`);
    res.writeHead(404).end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "open-"))) });

test("closed at the start: not driven, reported apart, out of the open denominator; the all-rows headline unchanged", { skip }, async () => {
  const o = opts();
  const rows = [await strictPosting(browser, { provider: "greenhouse", url: `${base}/gone` }, o), await strictPosting(browser, { provider: "greenhouse", url: `${base}/missing` }, o), await strictPosting(browser, { provider: "greenhouse", url: `${base}/open` }, o)];
  assert.equal(rows[0].closed_at_start, "page_load_410"); assert.equal(rows[1].closed_at_start, "page_load_404");
  assert.equal(hits["/gone"], 1, "one GET at the start, never opened in the browser");
  assert.equal(rows[2].result, "pass", JSON.stringify(rows[2]));
  const s = summarize(rows);
  assert.equal(s.all.sampled, 3); assert.equal(s.all.pass, 1);
  assert.deepEqual([s.all.open.sampled, s.all.open.closed, s.all.open.closed_at_start, s.all.open.pass], [1, 2, 2, 1]);
  assert.match(markdown("t", s), /Open postings only .*pass 1 \/ 1/);
  assert.deepEqual(posts, []);
});
