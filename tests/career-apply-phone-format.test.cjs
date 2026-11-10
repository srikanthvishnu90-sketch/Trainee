"use strict";
// WO-M (strict benchmark run 42707036468: 12 of 20 Workable forms stopped at "Phone"): a phone box that reformats what is typed
// (intl-tel-input style: the dial code moves into a country picker, the rest is shown as "(312) 555-0100") still holds the
// approved number. The runner accepts the readback only when its digits are the approved digits, or the approved digits less a
// dial code that the field's own picker shows. A box that changes any digit, or shows another country's dial code, is handed
// back (field_not_filled) and nothing is posted. Local fixtures only.
// Run: node --test tests/career-apply-phone-format.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

// How each page's phone widget rewrites what is typed into it.
const WIDGETS = {
  // Dial code to the picker, national format in the box (the Workable / intl-tel-input shape).
  national: { dial: "+1", js: `const d=v.replace(/\\D/g,"").replace(/^1/,"");return d.length===10?"("+d.slice(0,3)+") "+d.slice(3,6)+"-"+d.slice(6):d;` },
  // Same digits, different punctuation.
  punctuated: { dial: "+1", js: `return v.replace(/\\s+/g,"-");` },
  // The picker says +44: the box would post a UK number the person never approved.
  wrong_country: { dial: "+44", js: `return v.replace(/\\D/g,"").replace(/^1/,"");` },
  // A digit is lost.
  truncated: { dial: "+1", js: `return v.replace(/\\D/g,"").slice(0,-1);` },
};
const html = (k) => `<!doctype html><html><body><h2>Apply</h2><form method="post" action="/submit/${k}">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="ph">Phone *</label>
<div class="iti"><div class="iti__country-container"><button type="button" class="iti__selected-country" aria-label="Selected country ${WIDGETS[k].dial}"><span class="iti__selected-dial-code">${WIDGETS[k].dial}</span></button>
<ul class="iti__country-list" hidden><li>United Kingdom +44</li><li>United States +1</li></ul></div>
<input id="ph" type="tel" name="phone" class="iti__tel-input" required></div>
<label for="cv">Resume/CV *</label><input id="cv" type="file" name="resume" required>
<button type="submit">Submit application</button></form>
<script>const fmt=(v)=>{${WIDGETS[k].js}};const ph=document.getElementById("ph");ph.addEventListener("input",()=>{const n=fmt(ph.value);if(n!==ph.value)ph.value=n;});</script>
</body></html>`;

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") }); res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1 id=confirmation>Thank you for applying</h1></body></html>"); });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return WIDGETS[k] ? res.writeHead(200, { "content-type": "text/html" }).end(html(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "phone-fmt-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const job = (k) => {
  const p = { id: "ph-" + k, ats: "workable", url: `${base}/${k}`, facts: { first_name: "Casey", phone: "+1 312 555 0100" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};

for (const [k, shown] of [["national", "(312) 555-0100"], ["punctuated", "+1-312-555-0100"]]) {
  test(`a phone box that shows the approved number as ${shown}: filled, posted once with those digits`, { skip, timeout: 60000 }, async () => {
    const n = posts.length;
    const r = await applyOne(browser, job(k), { stepTimeoutMs: 8000, retries: 0 });
    assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
    const mine = posts.slice(n).filter((p) => p.url === `/submit/${k}`);
    assert.equal(mine.length, 1, "posted once");
    assert.equal(new URLSearchParams(mine[0].body).get("phone"), shown);
  });
}

for (const [k, why] of [["wrong_country", "its picker shows +44"], ["truncated", "it drops a digit"]]) {
  test(`a phone box where ${why}: handed back, nothing posted`, { skip, timeout: 60000 }, async () => {
    const n = posts.length;
    const r = await applyOne(browser, job(k), { stepTimeoutMs: 8000, retries: 0 });
    assert.equal(posts.length - n, 0, "nothing may be posted");
    assert.equal(r.status, "not_submitted", JSON.stringify(r));
    assert.equal(r.reason, "field_not_filled");
    assert.ok((r.needs || []).some((x) => x.label === "Phone" && x.reason === "readback_mismatch"), JSON.stringify(r.needs));
  });
}
