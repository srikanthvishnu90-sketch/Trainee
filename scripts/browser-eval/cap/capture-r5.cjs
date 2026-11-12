#!/usr/bin/env node
"use strict";
// D-072 item 4 round 2, capture 4 (bench branch only, never a PR): READ-ONLY. Teamtailor's careersite script and every module it
// imports from its own CDN (GET only), searched for the resume upload's presigned_data call and what it does with the answer.
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const log = (k, x) => console.log(`CAP4-${k} | ${typeof x === "string" ? x : JSON.stringify(x)}`);
(async () => {
  const b = await pw.chromium.launch({ headless: true });
  const ctx = await b.newContext({ userAgent: "Mozilla/5.0 TraineeBrowserEval/1 (dry run; never submits)" });
  const page = await ctx.newPage();
  const seen = new Set(); const loaded = [];
  page.on("response", (r) => { const u = r.url(); if (/\.js(\?|$)/.test(u) && /teamtailor/.test(u)) loaded.push(u); });
  await ctx.route("**/*", (route) => (/^(GET|HEAD|OPTIONS)$/.test(route.request().method()) ? route.continue() : route.abort()));
  await page.goto("https://careers.axpo.com/jobs/8635826-operational-excellence-ai-specialist-f-m-d", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.locator("button[data-action*='form-overlay#showFormOverlay']").first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const html = await page.content();
  const im = /<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  log("IMPORTMAP", im ? im[1].slice(0, 3000) : "none");
  const queue = [...new Set([...loaded, ...(im ? [...im[1].matchAll(/"(https:\/\/[^"]+\.js)"/g)].map((m) => m[1]) : [])])];
  log("QUEUE", queue.slice(0, 100));
  let hits = 0;
  while (queue.length && seen.size < 150) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const t = await (await ctx.request.get(u, { timeout: 30000 }).catch(() => null))?.text().catch(() => "") || "";
    for (const m of t.matchAll(/(?:from\s*|import\(\s*)["']([^"']+\.js)["']/g)) { try { queue.push(new URL(m[1], u).href); } catch { /* skip */ } }
    for (const n of ["presigned_data", "presignedData", "presigned"]) { let at = t.indexOf(n), k = 0; while (at >= 0 && k < 3) { hits++; log("JS", { u: u.slice(0, 140), n, around: t.slice(Math.max(0, at - 2000), at + 3000) }); at = t.indexOf(n, at + n.length); k++; } }
  }
  log("DONE", { seen: seen.size, hits });
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
