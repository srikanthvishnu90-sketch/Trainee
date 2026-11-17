"use strict";
// Teamtailor's scale question (captured read-only 2026-11-16, tests/fixtures/runner-strict/teamtailor-bonhambrook-8544693.html): a
// required 1 to 10 slider (type=range) shown at 1 with an unlabeled number box mirroring it (range-custom_number), its label marked
// "*Required" without brackets. Before: the slider could not take an answer (a range cannot be typed into) and the mirror box was
// "set by the page, not confirmed by you", so the form never reached Submit once answered (answered run of 2026-11-16: 6 Teamtailor
// postings). Now an approved number within the slider's own bounds is set and read back, the label loses "*Required", and the
// question goes back to the person with its bounds. Local page; nothing posted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, answeredPosting } = require("../scripts/browser-eval/strict.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const html = fs.readFileSync(path.join(__dirname, "fixtures/runner-strict/teamtailor-bonhambrook-8544693.html"), "utf8");
// The board's part (its range controller, a script in the live page): the number box follows the slider.
const MIRROR = `<script>document.addEventListener("input", (e) => { if (e.target.type === "range") { const w = e.target.closest("[data-controller='forms--inputs--range']"); const nr = w && w.querySelector("[data-forms--inputs--range-target='nrInput']"); if (nr) nr.value = e.target.value; } }, true);</script>`;
let server, base, browser;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    res.writeHead(200, { "content-type": "text/html" }).end(html.replace("</body>", MIRROR + "</body>"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("answered, the slider takes the approved number within its bounds and the form reaches the instant before Submit", { skip, timeout: 180000 }, async () => {
  const o = { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "ttr-"))) };
  const item = { provider: "teamtailor", url: `${base}/jobs/8544693-software-technical-consultant` };
  const first = await strictPosting(browser, item, o);
  const w = await answeredPosting(browser, item, o, first);
  assert.equal(w.result, "pass", JSON.stringify(w));
  assert.deepEqual(posts, []);
});
