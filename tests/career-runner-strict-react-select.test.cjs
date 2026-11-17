"use strict";
// Greenhouse job-boards' react-select boxes as they behave on 2026-11-16 (read from job-boards.greenhouse.io/playq/jobs/3055199):
//  - the phone's Country picker shows only "+1" once picked and marks the chosen option by its class (select__option--is-selected),
//    not aria-selected, so the runner's reopen-and-read found nothing ("picked: United States +1 | shows: +1 | menu selected: ''");
//  - a list question is a multi-select whose choice shows as a chip (select__multi-value__label), not a single value, so it read back
//    empty (CI 44021741347: 10 Greenhouse rows "picked: ... | shows: ''").
// Local page with those two widgets; the runner stops before the click; nothing is posted.
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
const PAGE = `<!doctype html><html><body><h1>Apply</h1><form id="application-form" action="/apply" method="post">
<div class="field-wrapper"><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></div>
<div class="field-wrapper"><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></div>
<div class="field-wrapper"><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
<fieldset class="phone-input"><div class="phone-input__country"><div class="select__container"><label for="country" id="country-label">Country *</label>
  <div class="select__control"><div class="select__value"></div><input id="country" role="combobox" aria-expanded="false" aria-haspopup="true" aria-required="true" class="select__input"></div></div></div>
  <div class="field-wrapper"><label for="phone">Phone *</label><input id="phone" name="phone" type="tel" required></div></fieldset>
<div class="field-wrapper"><div class="select__container"><label for="dept" id="dept-label">Select the department you are interested in *</label>
  <div class="select__control"><div class="select__value"></div><input id="dept" role="combobox" aria-expanded="false" aria-haspopup="true" aria-required="true" class="select__input"></div></div></div>
<button type="submit">Submit application</button></form><script>
function rs(id, opts, multi, shown) { const inp = document.getElementById(id), box = inp.closest(".select__container"), val = box.querySelector(".select__value"); let chosen = [];
  const close = () => { const m = box.querySelector(".select__menu"); if (m) m.remove(); inp.setAttribute("aria-expanded", "false"); };
  const draw = (q) => { close(); const m = document.createElement("div"); m.className = "select__menu"; m.innerHTML = '<div role="listbox" class="select__menu-list">' + opts.filter((o) => !q || o.toLowerCase().includes(q.toLowerCase())).map((o) => '<div role="option" class="select__option' + (chosen.includes(o) ? ' select__option--is-selected' : '') + '">' + o + '</div>').join("") + '</div>';
    box.appendChild(m); inp.setAttribute("aria-expanded", "true");
    for (const el of m.querySelectorAll("[role=option]")) el.onclick = () => { const o = el.textContent; chosen = multi ? [...new Set([...chosen, o])] : [o]; inp.value = "";
      val.innerHTML = multi ? chosen.map((c) => '<div class="select__multi-value"><div class="select__multi-value__label">' + c + '</div></div>').join("") : '<div class="select__single-value">' + shown(o) + '</div>'; close(); }; };
  inp.addEventListener("click", () => draw("")); inp.addEventListener("input", () => draw(inp.value)); inp.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") draw(""); if (e.key === "Escape") close(); }); }
rs("country", ["United States +1", "Canada +1", "United Kingdom +44"], false, (o) => o.replace(/^.* (\\+\\d+)$/, "$1"));
rs("dept", ["Art", "Data", "Engineering"], true);
</script></body></html>`;
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => { if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("ok"); } res.writeHead(200, { "content-type": "text/html" }).end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")), "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test("the phone's Country (chosen option marked by class) and a multi-select chip read back; the form reaches the instant before Submit", { skip, timeout: 90000 }, async () => {
  const p = { id: "rs", ats: "greenhouse", url: `${base}/playq/jobs/3055199`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid", phone: "+1 312 555 0100", country: "United States" },
    answers: { "Select the department you are interested in": "Art" }, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "a", hash: payloadHash(p) };
  let reached = 0;
  const r = await applyOne(browser, p, { stepTimeoutMs: 8000, retries: 0, onPhase: async (ph) => { if (ph === "submitting") { reached++; throw new NeedsUser("test_stop_before_click"); } } });
  assert.equal(reached, 1, JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  assert.deepEqual(posts, []);
});
