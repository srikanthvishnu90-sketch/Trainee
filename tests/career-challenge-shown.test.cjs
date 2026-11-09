"use strict";
// The runner stops only on a verification check that is SHOWN (workers/career-browser/parallel-apply.cjs SHOWN_CHECK), never on one that only
// loads. Before this, a word match on the page source stopped 133 of the 220 real postings of the 2026-11-09 browser
// benchmark (run 42676274898) although none of them showed a check. Every page here is local: the 17 captured real
// Greenhouse, Lever and Ashby forms (tests/fixtures/forms-ci, external requests refused), plus small shapes for what must
// still stop. Nothing is solved; a shown check still hands the posting to the person.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { botCheck: challengeShown } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser;
before(async () => { if (pw) browser = await pw.chromium.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

async function shown(html) {
  const ctx = await browser.newContext();
  await ctx.route("**/*", (r) => r.abort("blockedbyclient")); // nothing leaves this machine
  const page = await ctx.newPage();
  try { await page.setContent(html, { waitUntil: "domcontentloaded" }); return await challengeShown(page); } finally { await ctx.close(); }
}
const dir = path.join(__dirname, "fixtures/forms-ci");
const captured = fs.readdirSync(dir).filter((f) => /^(greenhouse|lever|ashby)-.*\.html$/.test(f));

test("captured real Greenhouse, Lever and Ashby forms show no check: the runner goes on to fill them", { skip }, async () => {
  assert.ok(captured.length >= 17, `captured forms present (${captured.length})`);
  const loadsACheck = captured.filter((f) => /captcha/i.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.ok(loadsACheck.length >= 12, `most captured forms load an invisible check (${loadsACheck.length}), which the old word match stopped on`);
  for (const f of captured) assert.equal(await shown(fs.readFileSync(path.join(dir, f), "utf8")), false, f);
});

test("Lever's invisible hCaptcha (hidden token field and hidden submit) and the reCAPTCHA badge are not challenges", { skip }, async () => {
  assert.equal(await shown(`<form><input type="email" name="email"><input id="hcaptchaResponseInput" type="hidden" name="h-captcha-response" value="">
    <button id="hcaptchaSubmitBtn" type="submit" style="display:none"></button><div id="h-captcha" class="h-captcha" data-sitekey="k"></div>
    <button type="button" id="btn-submit">Submit application</button></form>`), false);
  assert.equal(await shown(`<form><input name="email"><textarea name="g-recaptcha-response" style="display:none"></textarea><button type="submit">Submit</button></form>
    <div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:-186px">
    <iframe src="https://www.google.com/recaptcha/enterprise/anchor?k=x&size=invisible" width="256" height="60"></iframe></div>`), false);
  assert.equal(await shown(`<script src="https://www.google.com/recaptcha/api.js"></script><p>This site is protected by reCAPTCHA.</p><form><input name="a"><input name="b"><button type="submit">Apply</button></form>`), false);
});

test("a shown check still stops: checkbox widget, challenge frame, interstitial, Turnstile", { skip }, async () => {
  assert.equal(await shown(fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun/lever-acme.html"), "utf8")), true, "the dry-run Lever fixture's bare checkbox container");
  assert.equal(await shown(`<form><input name="email"><div class="g-recaptcha" data-sitekey="k"></div><button type="submit">Submit</button></form>`), true);
  assert.equal(await shown(`<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=normal" width="304" height="78"></iframe>`), true);
  assert.equal(await shown(`<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox" width="303" height="78"></iframe>`), true);
  assert.equal(await shown(`<title>Just a moment...</title><p>Checking your browser before accessing the site.</p>`), true);
  assert.equal(await shown(`<p>Verify you are human by completing the action below.</p>`), true);
  assert.equal(await shown(`<form><div class="cf-turnstile" data-sitekey="k"></div></form>`), true);
});
