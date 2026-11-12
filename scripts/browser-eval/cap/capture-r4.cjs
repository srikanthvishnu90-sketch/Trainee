#!/usr/bin/env node
"use strict";
// D-072 item 4 round 2, capture 3 (bench branch only, never a PR): READ-ONLY. (1) Breezy's portal script around its upload
// callback, and Teamtailor's careersite module chunks around presigned_data, both read with GET; (2) the strict harness's own
// simulated Greenhouse S3 answer on the three job-boards forms whose resume did not show, with every request after the file is
// chosen logged. Every request but GET/HEAD/OPTIONS is aborted or answered inside the browser; nothing is sent.
const path = require("node:path");
const lib = require(path.resolve("scripts/browser-eval/eval-lib.cjs"));
const { robotsOk, simulatedUpload } = require(path.resolve("scripts/browser-eval/strict.cjs"));
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const cut = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
(async () => {
  const browser = await pw.chromium.launch({ headless: true });
  const o = { robots: new Map(), pacer: lib.createPacer(), ua: `Mozilla/5.0 ${lib.UA_TOKEN}` };
  const resume = lib.syntheticResume(path.resolve("artifacts/cap"));
  const log = (k, u, x) => console.log(`CAP3-${k} | ${u} | ${typeof x === "string" ? x : JSON.stringify(x)}`);
  const ctx0 = await browser.newContext({ userAgent: o.ua });
  // (1) scripts
  for (const [src, needles] of [["https://assets-cdn.breezy.hr/breezy-portal/react/assets/portal-ga9Z0GTh.js", ["function iS(", "Bu(", "E_(", ".resume=So("]]]) {
    const t = await (await ctx0.request.get(src, { timeout: 30000 })).text().catch(() => "");
    for (const n of needles) { let at = t.indexOf(n), k = 0; while (at >= 0 && k < 3) { log("JS", src, { n, around: t.slice(Math.max(0, at - 300), at + 2600) }); at = t.indexOf(n, at + n.length); k++; } }
  }
  {
    const u = "https://careers.axpo.com/jobs/8635826-operational-excellence-ai-specialist-f-m-d";
    if ((await robotsOk(u, o.robots, o.ua, o.pacer)) === true) {
      const r = await ctx0.request.get(u, { timeout: 30000 }); const html = await r.text();
      const refs = [...new Set([...(html.match(/https:\/\/assets-aws\.teamtailor-cdn\.com\/[^"'\s<>]+\.js/g) || []), ...(html.match(/"[a-z0-9_\/-]+":\s*"https:\/\/[^"]+\.js"/g) || []).map((x) => x.split('"')[3])])];
      log("TT-REFS", u, refs.slice(0, 80));
      let found = 0;
      for (const ref of refs.slice(0, 120)) {
        const t = await (await ctx0.request.get(ref, { timeout: 30000 })).text().catch(() => "");
        for (const n of ["presigned_data", "presignedData"]) { let at = t.indexOf(n), k = 0; while (at >= 0 && k < 3) { found++; log("TT-JS", ref, { n, around: t.slice(Math.max(0, at - 1500), at + 2500) }); at = t.indexOf(n, at + n.length); k++; } }
      }
      log("TT-FOUND", u, String(found));
    }
  }
  await ctx0.close();
  // (2) Greenhouse with the strict harness's simulated S3 answer
  for (const u of ["https://job-boards.greenhouse.io/speechify/jobs/6229060004", "https://job-boards.greenhouse.io/oosmanagementcorp/jobs/4405048009", "https://job-boards.greenhouse.io/clearviewhealthcarepartners/jobs/5449752008"]) {
    if ((await robotsOk(u, o.robots, o.ua, o.pacer)) !== true) continue;
    const ctx = await browser.newContext({ userAgent: o.ua, viewport: { width: 1000, height: 1200 } });
    await ctx.addInitScript(lib.SUBMIT_TRAP); await ctx.exposeBinding("__evalSubmitAttempt", () => {});
    let after = false;
    await ctx.route("**/*", async (route) => {
      const r = route.request();
      const sim = simulatedUpload(r, "greenhouse");
      if (sim) { log("SIM", u, { m: r.method(), url: cut(r.url(), 120), status: sim.status, body: cut(sim.body, 300), reqBody: cut((r.postDataBuffer() || Buffer.alloc(0)).toString("latin1").replace(/[^\x20-\x7e]/g, "."), 900) }); return route.fulfill(sim); }
      if (after) log("REQ", u, { m: r.method(), type: r.resourceType(), url: cut(r.url(), 200) });
      if (!/^(GET|HEAD|OPTIONS)$/.test(r.method())) return route.abort();
      if (["image", "media", "font"].includes(r.resourceType())) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on("response", async (resp) => { if (after && ["xhr", "fetch"].includes(resp.request().resourceType())) log("RESP", u, { s: resp.status(), url: cut(resp.url(), 160), body: cut(await resp.text().catch(() => ""), 300) }); });
    page.on("console", (m) => { if (after) log("CONSOLE", u, cut(m.text(), 300)); });
    try {
      await o.pacer.wait("greenhouse.io");
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      after = true;
      await page.locator("input#resume[type=file]").first().setInputFiles(resume);
      for (const ms of [1000, 4000, 8000]) {
        await page.waitForTimeout(ms);
        log("BLOCK-" + ms, u, await page.evaluate(() => { const g = document.querySelector("[aria-labelledby='upload-label-resume']") || document.querySelector("#upload-label-resume"); const b = g && (g.closest(".field-wrapper") || g); return cut2(b ? b.outerHTML : "none"); function cut2(s) { return String(s).replace(/\s+/g, " ").slice(0, 1800); } }));
      }
    } catch (e) { log("ERR", u, cut(e.message, 200)); }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
