#!/usr/bin/env node
"use strict";
// D-072 item 4 round 2, capture 2 (bench branch only, never a PR): READ-ONLY. The boards' own upload code (their public JS, read with
// GET) around the upload endpoints the first capture saw, and what Greenhouse's resume block shows once a file is chosen. Every
// request but GET/HEAD/OPTIONS is aborted in the browser; submits cancelled in the page; robots.txt obeyed; paced. Nothing is sent.
const path = require("node:path");
const lib = require(path.resolve("scripts/browser-eval/eval-lib.cjs"));
const { robotsOk } = require(path.resolve("scripts/browser-eval/strict.cjs"));
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const cut = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
const ITEMS = [
  { p: "teamtailor", u: "https://careers.axpo.com/jobs/8635826-operational-excellence-ai-specialist-f-m-d", needles: ["presigned_data", "presignedData", "uploads/", "s3"] },
  { p: "breezy", u: "https://degate.breezy.hr/p/8d0b5f3a25be-senior-platform-engineer/apply", needles: ["/upload", "api/portal"] },
  { p: "greenhouse", u: "https://job-boards.greenhouse.io/speechify/jobs/6229060004", needles: ["presigned_fields", "success_action_status", "grnhse"] },
  { p: "greenhouse", u: "https://job-boards.greenhouse.io/oosmanagementcorp/jobs/4405048009", needles: [] },
];
(async () => {
  const browser = await pw.chromium.launch({ headless: true });
  const o = { robots: new Map(), pacer: lib.createPacer(), ua: `Mozilla/5.0 ${lib.UA_TOKEN}` };
  const resume = lib.syntheticResume(path.resolve("artifacts/cap"));
  for (const it of ITEMS) {
    const log = (k, x) => console.log(`CAP2-${k} | ${it.p} | ${it.u} | ${typeof x === "string" ? x : JSON.stringify(x)}`);
    if ((await robotsOk(it.u, o.robots, o.ua, o.pacer)) !== true) { log("ROBOTS", "no"); continue; }
    const ctx = await browser.newContext({ userAgent: o.ua, viewport: { width: 1000, height: 1200 } });
    await ctx.addInitScript(lib.SUBMIT_TRAP);
    await ctx.exposeBinding("__evalSubmitAttempt", () => {});
    await ctx.route("**/*", async (route) => { const r = route.request(); if (!/^(GET|HEAD|OPTIONS)$/.test(r.method())) { log("POST-BLOCKED", { url: cut(r.url(), 200), ct: r.headers()["content-type"] || "" }); return route.abort(); } if (["image", "media", "font"].includes(r.resourceType())) return route.abort(); return route.continue(); });
    const page = await ctx.newPage();
    try {
      await o.pacer.wait(new URL(it.u).host);
      await page.goto(it.u, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      const srcs = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
      log("SCRIPTS", srcs);
      for (const src of srcs) {
        if (!it.needles.length || /google|bugsnag|ziggeo|linkedin|recaptcha|dropbox|gstatic|apis\.google|recruitics|cookie|font-awesome|analytics|polyglot|translate|jquery|async\.js|marked|tooltip/i.test(src)) continue;
        const r = await ctx.request.get(src, { timeout: 30000 }).catch(() => null);
        const txt = r ? await r.text().catch(() => "") : "";
        log("JSLEN", { src: cut(src, 140), len: txt.length });
        for (const n of it.needles) { let at = txt.indexOf(n), k = 0; while (at >= 0 && k < 4) { log("JS", { src: cut(src, 100), n, around: txt.slice(Math.max(0, at - 900), at + 1100).replace(/\s+/g, " ") }); at = txt.indexOf(n, at + n.length); k++; } }
        // Lazy chunks named by the main bundle (Vite / webpack): the ones whose names mention an upload or a form.
        for (const m of [...new Set((txt.match(/["'(]\.?\/?(?:assets\/)?[A-Za-z0-9_-]*(?:[Uu]pload|[Ff]ile|[Ff]orm|[Aa]pply|[Cc]areersite|[Aa]pplication)[A-Za-z0-9_.-]*\.js["')]/g) || []))].slice(0, 8)) log("CHUNK", m);
      }
      if (it.p === "greenhouse") {
        const inp = page.locator("input#resume[type=file]").first();
        if (await inp.count()) {
          await inp.setInputFiles(resume);
          for (const ms of [500, 2000, 6000]) {
            await page.waitForTimeout(ms);
            log("GH-AFTER-" + ms, await page.evaluate(() => {
              const lab = [...document.querySelectorAll("label, div, span")].find((e) => /^Resume\/CV/.test((e.innerText || "").trim()));
              let box = lab; for (let i = 0; box && i < 4 && !(box.innerText || "").includes("Accepted file") && !box.querySelector("[class*=file]"); i++) box = box.parentElement;
              return { text: String(box ? box.innerText : "").replace(/\s+/g, " ").slice(0, 400), html: String(box ? box.outerHTML : "").replace(/\s+/g, " ").slice(0, 2500), files: [...document.querySelectorAll("input[type=file]")].map((i) => i.id + ":" + (i.files ? i.files.length : "?")), errors: [...document.querySelectorAll("[class*=error], [role=alert]")].map((e) => (e.innerText || "").trim()).filter(Boolean).slice(0, 5) };
            }));
          }
        }
      }
    } catch (e) { log("ERR", cut(e.message, 200)); }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
