"use strict";
// Dry-run of one application form in a local Playwright browser: opens the page, fills it exactly as the worker would
// (ats-fill.cjs), takes a screenshot, writes an attempt log, and STOPS. It never clicks Submit and cannot submit:
//  - this module has no code path that clicks a submit control or calls form.submit();
//  - every request that is not a GET/HEAD to loopback is aborted before it leaves the browser and counted in the log
//    (requests_blocked); a log with submit_clicked false and no blocked POST is the proof nothing was sent;
//  - a verification check is reported (bot_check: true) and never solved; a password field ends the run as login_required.
// Outcome: ready (every required question answered and read back; Submit would be the next step, which a dry run never takes),
// needs_you (questions only the person can answer, listed), or failed (the page could not be read or a step errored, with why).
// "ready" is NOT "submitted": the log says dry_run true and nothing_sent true on every outcome.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fillForm } = require("./ats-fill.cjs");

const BOT_RE = /verify\s+(?:that\s+)?you(?:\s+are|(?:'|’|&#0*39;|&rsquo;|&apos;)re)\s+(?:a\s+)?(?:human|not a robot)|captcha|turnstile|challenges\.cloudflare\.com|are you a robot|not a robot/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function dryRunForm({ browser, id, ats, url, facts = {}, answers = {}, resumePath, outDir, stepTimeoutMs = 15000 }) {
  const t0 = Date.now();
  const log = { id, ats, url, dry_run: true, nothing_sent: true, submit_clicked: false, outcome: "failed", reason: null, bot_check: false, field_map: [], needs_you: [], failed_fields: [], invalid_after_fill: [], screenshot: null, screenshot_sha256: null, requests_blocked: [], ms: 0 };
  if (!LOOPBACK.has(new URL(url).hostname)) { log.reason = "dry_run_is_local_only"; return finish(log, outDir, t0); }
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(stepTimeoutMs);
  await ctx.route("**/*", (route) => {
    const req = route.request(), u = new URL(req.url());
    const local = LOOPBACK.has(u.hostname) || /^(data|blob|about):$/.test(u.protocol);
    if (!local || !/^(GET|HEAD)$/.test(req.method())) { log.requests_blocked.push(`${req.method()} ${local ? u.pathname : u.hostname}`.slice(0, 120)); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!resp || resp.status() >= 400) { log.reason = `page_load_${resp ? resp.status() : "none"}`; return finish(log, outDir, t0); }
    log.bot_check = BOT_RE.test(await page.content()) || page.frames().some((f) => BOT_RE.test(f.url()));
    if (await page.$('input[type="password"]')) { log.outcome = "needs_you"; log.reason = "login_required"; return finish(log, outDir, t0); }
    const r = await fillForm(page, { ats, facts, answers, resumePath });
    log.field_map = r.map; log.needs_you = r.needsUser; log.failed_fields = r.failed; log.invalid_after_fill = r.invalid;
    if (!r.map.length) { log.reason = "no_application_form_found"; return finish(log, outDir, t0); }
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const shot = path.join(outDir, `${id}.filled.png`);
      await page.screenshot({ path: shot, fullPage: true });
      log.screenshot = shot; log.screenshot_sha256 = sha256(fs.readFileSync(shot));
    }
    if (r.needsUser.length) { log.outcome = "needs_you"; log.reason = `${r.needsUser.length} required question(s) only you can answer: ${r.needsUser.slice(0, 3).map((n) => n.label).join("; ")}`; }
    else if (r.invalid.length) { log.outcome = "failed"; log.reason = `the form rejects what was filled: ${r.invalid.slice(0, 3).map((x) => `${x.name} (${x.message})`).join("; ")}`; }
    else { log.outcome = "ready"; log.reason = log.bot_check ? "filled; a verification check is on the page, which Trainee never solves" : "filled and read back; a dry run stops before Submit"; }
  } catch (e) {
    log.outcome = "failed"; log.reason = `driver_error: ${String(e.message).split("\n")[0].slice(0, 160)}`;
  } finally {
    await ctx.close();
  }
  return finish(log, outDir, t0);
}

function finish(log, outDir, t0) {
  log.ms = Date.now() - t0;
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${log.id}.attempt.json`), JSON.stringify(log, null, 1)); }
  return log;
}

module.exports = { dryRunForm };
