"use strict";
// The strict benchmark answers a board's own resume upload inside the browser (SIMULATED_UPLOADS), so the browser fires no upload
// progress for it. Greenhouse's job-boards form shows the chosen file only once its upload reached 100%; with none, its 'Attach'
// stayed at 0% and the runner reported upload_not_accepted (CI 44021741347: 19 Greenhouse rows). The bench's page script now
// dispatches the upload's own progress events for exactly those simulated addresses. A local page with Greenhouse's behaviour:
// the file shows only after upload progress reaches its total. Still nothing is sent (the upload is answered in the browser).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting } = require("../scripts/browser-eval/strict.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const PAGE = `<!doctype html><html><body><h1>Apply</h1><form id="application-form" action="/apply" method="post">
<label for="first_name">First Name *</label><input id="first_name" name="first_name" required><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload"><div id="upload-label-resume" class="label upload-label">Resume/CV<span class="required">*</span></div>
<div class="file-upload__wrapper" id="wrap"><button type="button">Attach</button><label class="visually-hidden" for="resume">Attach</label><input id="resume" type="file" required></div></div>
<button type="submit">Submit application</button></form><script>
document.getElementById("resume").addEventListener("change", (e) => { const f = e.target.files[0]; const w = document.getElementById("wrap");
  w.innerHTML = '<div role="progressbar" aria-valuenow="0"><span style="width:0%"></span></div>';
  const fd = new FormData(); fd.append("key", "stash/applications/resumes/1-\${filename}"); fd.append("success_action_status", "201"); fd.append("file", f);
  const x = new XMLHttpRequest(); let pct = 0;
  x.upload.onprogress = (ev) => { if (ev.lengthComputable) pct = Math.round(100 * ev.loaded / ev.total); };
  x.onload = () => { if (x.status === 201 && pct === 100) w.innerHTML = '<div class="file-upload__filename"><p>' + f.name + '</p><button type="button" aria-label="Remove file"></button></div>'; };
  x.open("POST", "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/"); x.send(fd); });
</script></body></html>`;
let server, base, browser;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("Greenhouse's upload under simulation shows the file: the posting reaches the instant before Submit, upload simulated, nothing sent", { skip, timeout: 60000 }, async () => {
  const o = { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "ghup-"))) };
  const r = await strictPosting(browser, { provider: "greenhouse", url: `${base}/acme/jobs/123456` }, o);
  assert.equal(r.result, "ready_except_upload", JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  assert.equal(r.upload_simulated, 1);
  assert.deepEqual(posts, []);
});
