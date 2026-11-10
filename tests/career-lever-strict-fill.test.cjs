"use strict";
// b-lever (strict run 6, 42719264485: Lever 3 of 20 pass). Three Lever causes that were the runner's, not the person's, each on
// a local copy of the markup the run's DIAG lines showed, driven through the strict benchmark (the production runner, stopped
// at the instant before Submit, nothing posted):
//   1. "Current location": Lever keeps its result list inside the label ("Current location ✱No location found. Try entering a
//      different location"), so the question was never recognised; and the box counts only once one of Lever's own places is
//      picked. The confirmed "Chicago, IL" now picks Lever's "Chicago, Illinois, United States" and nothing else.
//   2. An optional "What gender do you identify as?" survey with no way to decline (boxlunch): a blank is the decline, so it is
//      left blank instead of failing the posting (field_not_filled). A REQUIRED one is still handed back.
//   3. A required "Country" select offering "USA" for the confirmed "United States" (insomniacookies: no_matching_option).
// Run: node --test tests/career-lever-strict-fill.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting } = require("../scripts/browser-eval/strict.cjs");
const { matchPlace, countryNames } = require("../workers/career-browser/ats-fill.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const q = (label, field, req = true) => `<li class="application-question"><label><div class="application-label">${label}${req ? '<span class="required">✱</span>' : ""}</div><div class="application-field">${field}</div></label></li>`;
// Lever's location box: typing asks /searchLocations (a GET); a result click fills the hidden selectedLocation.
const LOCATION = `<li class="application-question"><label><div class="application-label">Current location<span class="required">✱</span></div><div class="application-field">
<input type="text" name="location" id="location-input" class="location-input" data-qa="location-input" required="" autocomplete="off">
<input type="hidden" name="selectedLocation" id="selected-location">
<div class="dropdown-container"><div class="dropdown-results"></div><div class="dropdown-no-results" style="display:none">No location found. Try entering a different location</div><div class="dropdown-loading-results" style="display:none">Loading</div></div>
</div></label></li>
<script>(() => { const i = document.getElementById("location-input"), r = document.querySelector(".dropdown-results"), h = document.getElementById("selected-location"), none = document.querySelector(".dropdown-no-results");
  let t; i.addEventListener("input", () => { h.value = ""; clearTimeout(t); t = setTimeout(async () => { const xs = await (await fetch("/searchLocations?text=" + encodeURIComponent(i.value))).json();
    r.innerHTML = ""; none.style.display = xs.length ? "none" : "block";
    for (const x of xs) { const d = document.createElement("div"); d.className = "dropdown-location"; d.textContent = x.name; d.addEventListener("mousedown", (e) => { e.preventDefault(); i.value = x.name; h.value = JSON.stringify(x); r.innerHTML = ""; }); r.appendChild(d); } }, 150); }); })();</script>`;
// Copied from the run 6 DIAG line for boxlunch/bc3bda8b (survey, not required, no decline option).
const GENDER = (req) => `<li class="application-question"><div class="application-label full-width multiple-choice"><div class="text">What gender do you identify as?${req ? '<span class="required">✱</span>' : ""}</div></div><div class="application-field full-width"><ul data-qa="multiple-choice">${["Female", "Male", "Non-binary"].map((v) => `<li><label><input type="radio" name="surveysResponses[92315ae6-b1ff-4114-bc27-aca107d76cdf][responses][field2]" value="${v}"${req ? " required" : ""}><span class="application-answer-alternative">${v}</span></label></li>`).join("")}</ul></div></li>`;
const COUNTRY = `<li class="application-question custom-question"><div><div class="application-label full-width multiple-choice"><div class="text">Country<span class="required">✱</span></div></div><div class="application-field full-width required-field"><div class="application-dropdown"><select name="cards[5c0f][field5]" required="required"><option value="">Select...</option><option value="USA">USA</option><option value="Canada">Canada</option></select></div></div></div></li>`;
const PAGE = (extra) => `<!doctype html><html><head><title>TEST Lever posting</title></head><body><div class="application-page"><form method="POST" action="/apply" id="application-form" enctype="multipart/form-data"><ul>
${q("Resume/CV", '<input type="file" name="resume" id="resume-upload-input" required>')}
${q("Full name", '<input type="text" name="name" required>')}${q("Email", '<input type="email" name="email" required>')}${q("Phone", '<input type="text" name="phone">', false)}
${extra}</ul><div class="h-captcha" data-size="invisible"></div><button type="submit" class="postings-btn template-btn-submit">Submit application</button></form></div></body></html>`;
const PAGES = { "/location": PAGE(LOCATION), "/location-elsewhere": PAGE(LOCATION), "/gender-optional": PAGE(GENDER(false)), "/gender-required": PAGE(GENDER(true)), "/country": PAGE(COUNTRY) };

let browser, server, base;
const posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("<h1>Thank you for applying</h1>"); }
    if (u.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (u.pathname === "/searchLocations") {
      const ref = req.headers.referer || "";
      const t = (u.searchParams.get("text") || "").toLowerCase();
      const places = /elsewhere/.test(ref) ? [{ name: "Chicago, Ohio, United States", id: "c2" }] : [{ name: "Chicago, Illinois, United States", id: "c1" }, { name: "Chicago Heights, Illinois, United States", id: "c3" }];
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(t.startsWith("chic") ? places : []));
    }
    if (PAGES[u.pathname]) return res.writeHead(200, { "content-type": "text/html" }).end(PAGES[u.pathname]);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "lever-strict-"))) });
const run = (p) => strictPosting(browser, { provider: "lever", url: base + p }, opts());

test("a confirmed place matches a board's place by city and region only; one country's other names", () => {
  const xs = ["Chicago, Illinois, United States", "Chicago Heights, Illinois, United States"];
  assert.deepEqual(matchPlace(xs, "Chicago, IL"), { index: 0 });
  assert.deepEqual(matchPlace(xs, "Chicago, Illinois"), { index: 0 });
  assert.equal(matchPlace(["Chicago, Ohio, United States"], "Chicago, IL").error, "no_matching_option");
  assert.equal(matchPlace(["Chicago, Illinois, United States", "Chicago, IL, USA"], "Chicago, IL").error, "ambiguous_option");
  assert.equal(matchPlace(xs, "Chicago").error, "no_matching_option", "a city alone is not enough to pick a place");
  assert.ok(countryNames("United States").includes("usa"));
  assert.deepEqual(countryNames("Canada"), []);
});

test("Lever 'Current location': the confirmed city is picked from Lever's own list; the posting reaches Submit; nothing posted", { skip, timeout: 60000 }, async () => {
  const r = await run("/location");
  assert.equal(r.result, "pass", JSON.stringify({ ...r, diag: undefined }));
  assert.deepEqual(posts, []);
});

test("Lever 'Current location' that offers only another Chicago is handed back, never a pass", { skip, timeout: 60000 }, async () => {
  const r = await run("/location-elsewhere");
  assert.notEqual(r.result, "pass", JSON.stringify({ ...r, diag: undefined }));
  assert.ok((r.needs || []).some((n) => /location/i.test(n.label)), JSON.stringify(r.needs));
  assert.deepEqual(posts, []);
});

test("an optional gender survey with no decline option is left blank (pass); a required one is handed back", { skip, timeout: 60000 }, async () => {
  const a = await run("/gender-optional");
  assert.equal(a.result, "pass", JSON.stringify({ ...a, diag: undefined }));
  const b = await run("/gender-required");
  assert.notEqual(b.result, "pass", JSON.stringify({ ...b, diag: undefined }));
  assert.deepEqual(posts, []);
});

test("a required Country select listing 'USA' takes the confirmed 'United States'", { skip, timeout: 60000 }, async () => {
  const r = await run("/country");
  assert.equal(r.result, "pass", JSON.stringify({ ...r, diag: undefined }));
  assert.deepEqual(posts, []);
});
