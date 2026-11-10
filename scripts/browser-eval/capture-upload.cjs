#!/usr/bin/env node
"use strict";
// Bench-only: which request Breezy makes when a resume is chosen. Every non-GET is ABORTED (nothing leaves); only its method,
// host and path are logged. The synthetic TEST resume is the only file set; no control is clicked.
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const lib = require("./eval-lib.cjs");
(async () => {
  const b = await pw.chromium.launch({ headless: true });
  const resume = lib.syntheticResume(require("node:path").join(process.env.RUNNER_TEMP || "/tmp", "fx"));
  for (const url of process.argv.slice(2)) {
    const ctx = await b.newContext();
    await ctx.addInitScript(lib.SUBMIT_TRAP);
    let phase = "load";
    await ctx.route("**/*", (r) => {
      const q = r.request();
      if (/^(GET|HEAD|OPTIONS)$/.test(q.method())) return ["image", "media", "font"].includes(q.resourceType()) ? r.abort() : r.continue();
      const u = new URL(q.url());
      console.log(`ABORTED | ${phase} | ${q.method()} | ${u.host} | ${u.pathname} | ${u.search.slice(0, 80)} | ${q.headers()["content-type"] || ""} | ${url}`);
      return r.abort();
    });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector("#main-attachment", { state: "attached", timeout: 12000 });
      await page.waitForTimeout(2000);
      phase = "after_file_chosen";
      await page.setInputFiles("#main-attachment", resume);
      await page.waitForTimeout(4000);
    } catch (e) { console.log("CAPTURE_ERR " + url + " " + String(e.message).split("\n")[0]); }
    await ctx.close();
  }
  await b.close();
})();
