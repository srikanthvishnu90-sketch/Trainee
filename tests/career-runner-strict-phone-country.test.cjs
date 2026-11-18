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
const ITI = `<div class="iti"><div class="iti__selected-flag" title="United States: +1"><div class="iti__selected-dial-code">+1</div></div>${BOX}</div>`;
// [want, shell, submit control (optional), facts beyond the default (optional)]
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
  // Round 4 of the rs-00 review (2026-11-17, probe p00-r4): every row the submit would send is read structurally (name tokens, values
  // that are dial codes, ISO codes, country names or JSON with such keys, the pressed submitter included), and every piece of the
  // box's own intl-tel-input display must agree. A "+1" country the person did not confirm (CA beside a confirmed US) refuses;
  // with no confirmed country, US and CA are the +1 countries.
  "A-iti+1+submitter-country-NL": ["refuse", ITI, `<button type="submit" name="candidate.phone_country" value="NL">Send</button>`],
  "A2-plain+submitter-cc-NL": ["refuse", BOX, `<button type="submit" name="cc" value="NL">Send</button>`],
  "B-iti+1+select-phone_code-31": ["refuse", `${ITI}<select name="candidate.phone_code"><option value="1">US</option><option value="31" selected>NL</option></select>`],
  "C-iti+1+hidden-phoneCC-NL": ["refuse", `${ITI}<input type="hidden" name="candidate.phoneCC" value="NL">`],
  "D-iti+1+hidden-phone_code-+31": ["refuse", `${ITI}<input type="hidden" name="candidate.phone_code" value="+31">`],
  "E-iti+1+hidden-json-country-NL": ["refuse", `${ITI}<input type="hidden" name="candidate.meta" value='{"country":"NL"}'>`],
  "F-iti+1+radio-code-+44": ["refuse", `${ITI}<input type="radio" name="candidate.code" value="+44" checked aria-label="UK"><input type="radio" name="candidate.code" value="+1" aria-label="US">`],
  "G-iti-dial+31-title+1": ["refuse", `<div class="iti"><div class="iti__selected-flag" title="United States: +1"><div class="iti__selected-dial-code">+31</div></div>${BOX}</div>`],
  "H-iti+1+hidden-iso-CA": ["post", `${ITI}<input type="hidden" name="candidate.phone_iso" value="CA">`],
  "I-iti+1+fetch-country-NL": ["refuse", ITI, `<button type="submit">Send</button><script>document.querySelector("form").addEventListener("submit",(e)=>{e.preventDefault();const fd=new FormData(e.target);fd.append("candidate.phone_country","NL");fetch("/apply",{method:"POST",body:new URLSearchParams(fd)}).then(()=>{document.body.innerHTML="<h1>Thank you for applying</h1>";});});</script>`],
  "J-iti+1+hidden-full-+31": ["refuse", `${ITI}<input type="hidden" name="candidate.phone_full" value="+31 312 555 0100">`],
  "K-iti+1+select-tel_code-0031": ["refuse", `${ITI}<select name="candidate.tel_code"><option value="001">US</option><option value="0031" selected>NL</option></select>`],
  "L-iti+1+hidden-nation-NL": ["refuse", `${ITI}<input type="hidden" name="candidate.nation" value="NL">`],
  "M-iti+1+hidden-country-Netherlands": ["refuse", `${ITI}<input type="hidden" name="candidate.phone_country" value="Netherlands">`],
  "N-plain+fetch-json-dial-31": ["refuse", BOX, `<button type="submit">Send</button><script>document.querySelector("form").addEventListener("submit",(e)=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));o.dial="+31";fetch("/apply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o)}).then(()=>{document.body.innerHTML="<h1>Thank you for applying</h1>";});});</script>`],
  "O-iti+1+data-attr-country-NL+js": ["refuse", `<div class="iti" data-country="nl"><div class="iti__selected-flag" title="United States: +1"><div class="iti__selected-dial-code">+1</div></div>${BOX}</div>`],
  "P-iti+1+hidden-iso-US": ["post", `${ITI}<input type="hidden" name="candidate.phone_iso" value="US">`],
  "H2-iti+1+hidden-iso-CA+confirmed-US": ["refuse", `${ITI}<input type="hidden" name="candidate.phone_iso" value="CA">`, null, { country: "United States" }],
  "Q-iti+1+confirmed-US": ["post", ITI, null, { country: "United States" }],
  // Second delta review of rs-00 (2026-11-17): a page-set country posted beside a plain box (no word the old list knew), a country
  // select outside the form that still posts with it, and a "+1" example in the help text beside an NL country field.
  "hidden-phone_iso": ["refuse", `${BOX}<input type="hidden" name="phone_iso" value="NL">`],
  "hidden-cc": ["refuse", `<div class="tel-wrap"><span><svg width="8" height="8"></svg> NL</span>${BOX}</div><input type="hidden" name="cc" value="NL">`],
  "hidden-phone-region": ["refuse", `${BOX}<input type="hidden" name="phone[region]" value="NL">`],
  "outside-form-select": ["refuse", `${BOX}</form><select form="F" name="phone_country"><option value="US">US</option><option value="NL" selected>Netherlands +31</option></select><form>`],
  "hint-plus1-with-NL": ["refuse", `<div class="phone-field">${BOX}<small>Example: +1 202 555 0100</small></div><input type="hidden" name="candidate.phone_country" value="NL">`],
  // Third review of rs-00 (2026-11-17): another phone widget's +1 in a parent beside the box, the box's own +1 beside a hidden NL,
  // a form-associated element posting NL, and a select whose words say +1 but whose value is NL.
  "other-widget-in-parent+hidden-NL": ["refuse", `<div class="phones"><div class="iti"><div class="iti__selected-flag" title="United States: +1"><div class="iti__selected-dial-code">+1</div></div><input type="tel" name="candidate.work_phone" aria-label="Work phone"></div>${BOX}</div><input type="hidden" name="candidate.phone_iso" value="NL">`],
  "sibling-widget-no-wrapper+hidden-NL": ["refuse", `<div><span class="iti"><span class="iti__selected-dial-code">+1</span><input type="tel" name="candidate.home_phone" aria-label="Home phone"></span>${BOX}</div><input type="hidden" name="candidate.phone_iso" value="NL">`],
  "form-associated-element-NL": ["refuse", `${BOX}<x-reg name="candidate.phone_reg"></x-reg><script>customElements.define("x-reg", class extends HTMLElement { static formAssociated = true; constructor() { super(); this.i = this.attachInternals(); this.i.setFormValue("NL"); } });</script>`],
  "display+1-but-hidden-NL": ["refuse", `<div class="iti"><div class="iti__selected-flag" title="United States: +1"><div class="iti__selected-dial-code">+1</div></div>${BOX}</div><input type="hidden" name="candidate.phone_iso" value="NL">`],
  "select-text+1-value-NL": ["refuse", `<div class="iti"><select name="candidate.cc" style="display:none"><option value="NL" selected>+1</option><option value="US">+1 </option></select>${BOX}</div>`],
};
const page = (shell, btn) => `<!doctype html><html><body><h1>Apply</h1><form id="F" action="/apply" method="post">
<label for="n">Full name *</label><input id="n" name="candidate.name" required><label for="e">Email address *</label><input id="e" type="email" name="candidate.email" required>
<label for="p">Phone number *</label>${shell}<label for="cv">CV</label><input id="cv" type="file" name="candidate.cv">${btn || `<button type="submit">Send</button>`}</form><script>
const ph = document.getElementById("p"); ph.addEventListener("input", () => setTimeout(() => { const v = ph.value; if (/^\\+1[\\s-]/.test(v)) ph.value = v.replace(/^\\+1[\\s-]*/, ""); }, 50));
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push(Buffer.concat(c).toString("latin1")); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    const k = decodeURIComponent(req.url.split("/")[1] || "");
    return SHELLS[k] ? res.writeHead(200, { "content-type": "text/html" }).end(page(SHELLS[k][1], SHELLS[k][2])) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
for (const [k, [want, , , more]] of Object.entries(SHELLS)) {
  test(`${k}: ${want === "post" ? "posted once with the approved number" : "refused, nothing posted"}`, { skip, timeout: 60000 }, async () => {
    const p = { id: k, ats: "recruitee", url: `${base}/${encodeURIComponent(k)}/o/x/c/new`, facts: { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100", ...(more || {}) }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { approval_id: "a-" + k, hash: payloadHash(p) };
    const n = posts.length;
    const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0 });
    if (want === "post") { assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r)); assert.equal(posts.length - n, 1); }
    else { assert.equal(r.status, "not_submitted", JSON.stringify(r)); assert.equal(posts.length, n); }
  });
}
