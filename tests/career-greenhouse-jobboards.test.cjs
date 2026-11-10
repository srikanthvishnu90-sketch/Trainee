"use strict";
// job-boards.greenhouse.io (the React form): the phone's own "Country" dial-code picker is filled from the confirmed country
// only when its option names that country with the approved phone's own dial code; a second, address "Country" is its own
// question; the "Attach" upload is read back from the file name the board shows in its place. Strict run 42719264485: 13 of 20
// Greenhouse postings stopped on "Country". Local fixture only; nothing is posted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting } = require("../scripts/browser-eval/strict.cjs");
const { phoneCountryMatch, fillForm, labelCounts, decide } = require("../workers/career-browser/ats-fill.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const posts = [];
const html = fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun/greenhouse-jobboards.html"), "utf8");
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/gh") return res.writeHead(200, { "content-type": "text/html" }).end(html);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const resume = () => lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "ghjb-")));

test("phone country: the confirmed country with the phone's own dial code, one option or none", () => {
  const L = ["Canada +1", "United Kingdom +44", "United States +1", "United States Minor Outlying Islands +1"];
  assert.deepEqual(phoneCountryMatch(L, "United States", "+1 555 0100"), { index: 2 });
  assert.deepEqual(phoneCountryMatch(L, "United Kingdom", "+44 20 7946 0000"), { index: 1 });
  // A number from another country, or no dial code to check against: nothing is picked.
  assert.equal(phoneCountryMatch(L, "United States", "+44 20 7946 0000").error, "no_matching_option");
  assert.equal(phoneCountryMatch(L, "United States", "312 555 0100").error, "no_matching_option");
  assert.equal(phoneCountryMatch(L, "", "+1 555 0100").error, "no_matching_option");
  // The country's own name alone is that country.
  assert.deepEqual(phoneCountryMatch(["Canada", "United States"], "United States", "312 555 0100"), { index: 1 });
});

test("the phone's country picker is not a second 'Country' question; with no confirmed country it is asked", () => {
  const qs = [{ q: 0, label: "Country", kind: "combobox", required: true, phoneCountry: true }, { q: 1, label: "Country", kind: "combobox", required: true }];
  const lc = labelCounts(qs);
  const facts = { country: "United States", phone: "+1 555 0100" };
  assert.equal(decide(qs[0], { facts, answers: {}, labelCount: lc }).status, "fill");
  assert.equal(decide(qs[1], { facts, answers: {}, labelCount: lc }).status, "fill");
  assert.deepEqual(decide(qs[0], { facts: { phone: "+1 555 0100" }, answers: {}, labelCount: lc }), { status: "ask", reason: "no_confirmed_answer" });
});

test("job-boards form: Country (phone and address), phone and the Attach resume all filled and read back; strict pass; nothing posted", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "greenhouse", url: `${base}/gh` }, { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: resume() });
  assert.equal(r.result, "pass", JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  assert.deepEqual(posts, []);
});

test("job-boards form: a +44 number with a US country leaves the phone's Country unanswered (asked), never another country", { skip }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/gh`);
    const fr = await fillForm(page, { facts: { ...lib.TEST_FACTS, phone: "+44 20 7946 0000" }, answers: {}, resumePath: resume() });
    const c = fr.needsUser.find((n) => n.label === "Country");
    assert.ok(c, JSON.stringify(fr.needsUser));
    assert.equal(c.reason, "no_confirmed_answer");
    assert.match(String(c.detail), /no_matching_option/);
    const held = await page.evaluate(() => document.querySelector(".phone-input .select__single-value"));
    assert.equal(held, null);
  } finally { await page.close(); }
});
