"use strict";
// Workable's Yes/No (its markup as read on 2026-11-16 from apply.workable.com/j/E4A687F064/apply): a fieldset role=radiogroup of
// role=radio wrappers, each a label around an aria-hidden radio input and the shown words. A click on the words marks the wrapper
// aria-checked=true; the page then re-mounts the inputs, so the hidden input's own checked property stays false. The runner read
// the choice from the input only and handed every Workable Yes/No back as readback_mismatch once answered (answered run of
// 2026-11-16: 11 of 20 postings). A drawn option is now read as the page shows it: its wrapper's aria-checked. Local page.
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
const opt = (id, v, words) => `<div data-ui="option" role="radio" aria-checked="false" aria-labelledby="ql rl_${id}" id="w_${id}" tabindex="0"><label><input aria-required="true" required id="${id}" tabindex="-1" aria-hidden="true" type="radio" name="QA_1" value="${v}" style="position:absolute;opacity:0;width:13px;height:13px"><div><span id="rl_${id}">${words}</span></div></label></div>`;
const PAGE = `<!doctype html><html><body><h1>Apply</h1><form id="f" action="/apply" method="post">
<label>First name <input name="firstname" required></label><label>Last name <input name="lastname" required></label><label>Email <input type="email" name="email" required></label>
<div><span id="ql">Do you have the right to work in the UK without requiring employer sponsorship?</span><span>*</span>
<fieldset role="radiogroup" data-ui="QA_1" aria-labelledby="ql">${opt("a", "true", "YES")}${opt("b", "false", "NO")}</fieldset></div>
<button type="submit">Submit application</button></form><script>
// The board's part: a click marks the wrapper; the inputs are re-mounted (checked not kept; required and aria-required dropped, as read).
document.querySelector("fieldset").addEventListener("click", (e) => { const w = e.target.closest("[role=radio]"); if (!w) return; e.preventDefault();
  for (const x of document.querySelectorAll("[role=radio]")) x.setAttribute("aria-checked", String(x === w));
  setTimeout(() => { for (const i of document.querySelectorAll("input[type=radio]")) { const n = i.cloneNode(true); n.checked = false; n.removeAttribute("required"); n.setAttribute("aria-required", "false"); i.replaceWith(n); } }, 0); }, true);
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); } res.writeHead(200, { "content-type": "text/html" }).end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wk-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("the drawn Yes/No is read back as the page shows it (its wrapper), and the form reaches the instant before Submit", { skip, timeout: 60000 }, async () => {
  const p = { id: "wk", ats: "workable", url: `${base}/j/E4A687F064/apply`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" },
    answers: { "Do you have the right to work in the UK without requiring employer sponsorship?": "YES" }, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  let reached = 0;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") { reached++; throw new NeedsUser("test_stop_before_click"); } } });
  assert.equal(reached, 1, JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  assert.deepEqual(posts, []);
});
