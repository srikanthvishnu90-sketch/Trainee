"use strict";
// D-072 (item 4, round 2) driver (Node, run by tests/architect/handoff-recheck-live.test.ts): the REAL apply-VM worker
// (workers/career-browser/apply-vm.cjs createWorker, the real runner parallel-apply.cjs in real headless Chromium) against the test's
// own Postgres (every migration, the card-cloud bridge's stored approvals) through the worker's own database role, and the person's
// OWN browser (a separate Chromium context of theirs) doing the one step at the employer's link. The employer pages are the test's
// (127.0.0.1, fictional). Prints one JSON line. Nothing leaves 127.0.0.1.
//   node handoff-recheck-driver.cjs <root> drain <pgHost> <pgPort>            one pass of the worker over everything queued
//   node handoff-recheck-driver.cjs <root> person-code <link>                 the person enters the code the employer emailed them
//   node handoff-recheck-driver.cjs <root> person-signin <link>               the person signs in to the employer, in their browser
const ROOT = process.argv[2], MODE = process.argv[3];
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const launch = () => pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });

(async () => {
  if (MODE === "drain") {
    const { psqlRpc } = require(`${ROOT}/tests/fixtures/psql-rpc.cjs`);
    const { createWorker } = require(`${ROOT}/workers/career-browser/apply-vm.cjs`);
    const rpc = psqlRpc({ dir: process.argv[4], port: Number(process.argv[5]), size: 2 });
    const browser = await launch();
    const done = [];
    const counted = async (name, a) => { const r = await rpc(name, a); if (name === "career_apply_vm_complete") done.push({ id: a.p_id, state: a.p_state, reason: a.p_reason, evidence: a.p_evidence }); return r; };
    const w = createWorker({ rpc: counted, browser, workerId: "vm-handoff", concurrency: 2, perUser: 1, pollMs: 50, heartbeatMs: 1000, sweepMs: 600000, evidenceDir: null, retries: 0, stepTimeoutMs: 8000 });
    const run = w.run();
    const t0 = Date.now();
    // One pass: until nothing was claimed for a moment and nothing is in flight.
    let idle = 0;
    while (Date.now() - t0 < 90000) { await new Promise((r) => setTimeout(r, 250)); if (w.inflight.size === 0 && w.stats.claimed >= 0) idle++; else idle = 0; if (idle > 8) break; }
    w.stop(); await run;
    await browser.close(); rpc.close();
    console.log(JSON.stringify({ done }));
    return;
  }
  // The person's own browser: a context of theirs (its cookies are theirs), at the link the hand-off gave them.
  const browser = await launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(process.argv[4], { waitUntil: "domcontentloaded" });
  if (MODE === "person-code") { await page.fill("input[autocomplete=one-time-code]", "246810"); await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("button:has-text('Verify')")]); }
  if (MODE === "person-signin") { await page.fill("input[type=email]", "person@example.invalid"); await page.fill("input[type=password]", "the person's own password, typed by them"); await Promise.all([page.waitForNavigation(), page.click("button:has-text('Sign in')")]); }
  const cookies = (await ctx.cookies()).map((c) => c.name);
  const title = await page.title();
  await browser.close();
  console.log(JSON.stringify({ cookies, title }));
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.stack || e).slice(0, 1500) })); process.exit(1); });
