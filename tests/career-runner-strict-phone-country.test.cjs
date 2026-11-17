"use strict";
// Review probe p11b (2026-11-17): a phone widget that strips the approved "+1" and keeps only the national digits, while the form
// carries its own phone country (a hidden candidate.phone_country = NL, a Netherlands flag beside the box). Trunk accepted the national
// digits ("the approved digits less only their own country code") and posted them, so the employer read +31 312 555 0100, a number
// the person never approved. The national digits are that number only when nothing beside the box names another country. The same
// widget with no country named beside it (the national-format box of career-apply-phone-format) still goes. Local page and mock employer.
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
// country: what the page names beside the phone box ("NL": a Netherlands flag and phone_country=NL; "US": the same, United States;
// "": nothing named). The widget strips the typed "+1" a moment after each input, as p11b's does.
const page = (country) => `<!doctype html><html><body><h1>Apply</h1><form action="/apply" method="post">
<label for="n">Full name *</label><input id="n" name="candidate.name" required><label for="e">Email address *</label><input id="e" type="email" name="candidate.email" required>
<label for="p">Phone number *</label><div class="iti">${country ? `<div class="iti__flag" title="${country === "NL" ? "Netherlands" : "United States"}">${country}</div>` : ""}<input id="p" type="tel" name="candidate.phone" required></div>
${country ? `<input type="hidden" name="candidate.phone_country" value="${country}">` : ""}
<label for="cv">CV</label><input id="cv" type="file" name="candidate.cv"><button type="submit">Send</button></form><script>
const ph = document.getElementById("p"); ph.addEventListener("input", () => setTimeout(() => { const v = ph.value; if (/^\\+1[\\s-]/.test(v)) ph.value = v.replace(/^\\+1[\\s-]*/, ""); }, 50));
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(c).toString("latin1") }); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    const m = /^\/(NL|US|none)\//.exec(req.url);
    return m ? res.writeHead(200, { "content-type": "text/html" }).end(page(m[1] === "none" ? "" : m[1])) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
async function run(k) {
  const p = { id: k, ats: "recruitee", url: `${base}/${k}/o/x/c/new`, facts: { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a-" + k, hash: payloadHash(p) };
  const n = posts.length;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
  return { r, sent: posts.slice(n) };
}
test("the widget names the Netherlands beside the box: the national digits are another number; handed back, nothing posted", { skip, timeout: 60000 }, async () => {
  const { r, sent } = await run("NL");
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.deepEqual(sent, []);
});
test("the widget names the United States, or nothing: the national digits are the approved number; posted once", { skip, timeout: 90000 }, async () => {
  for (const k of ["US", "none"]) {
    const { r, sent } = await run(k);
    assert.equal(r.status, "submitted_page_confirmed", `${k}: ${JSON.stringify(r)}`);
    assert.equal(sent.length, 1, k);
  }
});
