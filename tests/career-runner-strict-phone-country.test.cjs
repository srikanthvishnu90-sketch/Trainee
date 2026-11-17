"use strict";
// A phone widget that strips the approved "+1" and keeps only the national digits (review probes p11b and p00-phone-country-variants,
// 2026-11-17). Trunk accepted "the approved digits less only their own country code" whatever the widget's own country was, so the
// employer could join another country (+31, +44) with the digits: a number the person never approved. Default-deny since the delta
// review: the national digits hold the approved number only with positive evidence of the approved code: the phone's own shell shows
// "+1" in its selected dial-code display (never hint text), or the form posts no field the runner did not fill (a plain box the page
// only reformats). Every other shell is refused, whichever way it names its country (and also when it names the United States
// without showing +1). Local pages and a mock employer.
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
const BOX = `<input id="p" type="tel" name="candidate.phone" required>`;
// The shells, as the review probe drew them (p00-phone-country-variants).
const SHELLS = {
  "flag-title-NL+hidden": ["refuse", `<div class="iti"><div class="iti__flag" title="Netherlands">NL</div>${BOX}</div><input type="hidden" name="candidate.phone_country" value="NL">`],
  "flag-class-only+countryCode": ["refuse", `<div class="phone-field"><span class="fi fi-nl"></span>${BOX}</div><input type="hidden" name="countryCode" value="NL">`],
  "img-alt": ["refuse", `<div class="PhoneInput"><div class="PhoneInputCountry"><img class="PhoneInputCountryIconImg" alt="Netherlands" src="data:,"></div>${BOX}</div>`],
  "data-country": ["refuse", `<div class="tel-wrap" data-country="nl" data-dial-code="31"><span class="sel"></span>${BOX}</div>`],
  "hidden-country_code+44": ["refuse", `<div class="tel-wrap">${BOX}</div><input type="hidden" name="country_code" value="+44">`],
  "prefix-select-outside": ["refuse", `<select name="prefix" aria-label="Prefix"><option value="+1">US +1</option><option value="+44" selected>UK +44</option></select><div class="tel-wrap">${BOX}</div>`],
  "iti-dial-NL": ["refuse", `<div class="iti iti--separate-dial-code"><div class="iti__selected-flag" role="combobox" title="Netherlands (Nederland): +31"><div class="iti__flag iti__nl"></div><div class="iti__selected-dial-code">+31</div></div>${BOX}</div>`],
  "US-named-no-dial": ["refuse", `<div class="iti"><div class="iti__flag" title="United States">US</div>${BOX}</div>`],
  "iti-dial-US": ["post", `<div class="iti"><div class="iti__selected-flag" title="United States: +1"><div class="iti__flag iti__us"></div></div>${BOX}</div>`],
  "plain": ["post", BOX],
  // Second delta review of rs-00 (2026-11-17): a page-set country posted beside a plain box (no word the old list knew), a country
  // select outside the form that still posts with it, and a "+1" example in the help text beside an NL country field.
  "hidden-phone_iso": ["refuse", `${BOX}<input type="hidden" name="phone_iso" value="NL">`],
  "hidden-cc": ["refuse", `<div class="tel-wrap"><span><svg width="8" height="8"></svg> NL</span>${BOX}</div><input type="hidden" name="cc" value="NL">`],
  "hidden-phone-region": ["refuse", `${BOX}<input type="hidden" name="phone[region]" value="NL">`],
  "outside-form-select": ["refuse", `${BOX}</form><select form="F" name="phone_country"><option value="US">US</option><option value="NL" selected>Netherlands +31</option></select><form>`],
  "hint-plus1-with-NL": ["refuse", `<div class="phone-field">${BOX}<small>Example: +1 202 555 0100</small></div><input type="hidden" name="candidate.phone_country" value="NL">`],
};
const page = (shell) => `<!doctype html><html><body><h1>Apply</h1><form id="F" action="/apply" method="post">
<label for="n">Full name *</label><input id="n" name="candidate.name" required><label for="e">Email address *</label><input id="e" type="email" name="candidate.email" required>
<label for="p">Phone number *</label>${shell}<label for="cv">CV</label><input id="cv" type="file" name="candidate.cv"><button type="submit">Send</button></form><script>
const ph = document.getElementById("p"); ph.addEventListener("input", () => setTimeout(() => { const v = ph.value; if (/^\\+1[\\s-]/.test(v)) ph.value = v.replace(/^\\+1[\\s-]*/, ""); }, 50));
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push(Buffer.concat(c).toString("latin1")); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    const k = decodeURIComponent(req.url.split("/")[1] || "");
    return SHELLS[k] ? res.writeHead(200, { "content-type": "text/html" }).end(page(SHELLS[k][1])) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
for (const [k, [want]] of Object.entries(SHELLS)) {
  test(`${k}: ${want === "post" ? "posted once with the approved number" : "refused, nothing posted"}`, { skip, timeout: 60000 }, async () => {
    const p = { id: k, ats: "recruitee", url: `${base}/${encodeURIComponent(k)}/o/x/c/new`, facts: { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { approval_id: "a-" + k, hash: payloadHash(p) };
    const n = posts.length;
    const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
    if (want === "post") { assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r)); assert.equal(posts.length - n, 1); }
    else { assert.equal(r.status, "not_submitted", JSON.stringify(r)); assert.equal(posts.length, n); }
  });
}
