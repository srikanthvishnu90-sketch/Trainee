#!/usr/bin/env node
"use strict";
// Bench-only diagnostic (never in a PR). Dry run: every non-GET request aborted (and logged), submits trapped, robots.txt obeyed,
// paced. Prints each page's forms before and after its one "Apply" control, and, for Workable, the upload requests.
const lib = require("./eval-lib.cjs");
const { robotsOk } = require("./strict.cjs");
const cut = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
function FORMS() {
  const c = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  return [...document.querySelectorAll("form")].map((f) => {
    const prev = [];
    for (let a = f, i = 0; a && i < 3; a = a.parentElement, i++) for (let p = a.previousElementSibling, k = 0; p && k < 3; p = p.previousElementSibling, k++) if (vis(p)) prev.push(`${p.tagName}.${c(p.className, 40)} "${c(p.innerText, 80)}"`);
    return { vis: vis(f), action: f.getAttribute("action"), id: f.id, cls: c(f.className, 80),
      inputs: [...f.querySelectorAll("input,select,textarea")].filter((x) => x.type !== "hidden").map((x) => `${x.tagName}.${x.type}[${x.name}] ph=${c(x.placeholder, 30)} req=${x.required} vis=${vis(x)}`).slice(0, 25),
      buttons: [...f.querySelectorAll("button,input[type=submit]")].map((b) => `${b.type} "${c(b.innerText || b.value, 40)}" vis=${vis(b)}`).slice(0, 8),
      text: c(f.innerText, 300), prev: prev.slice(0, 4), html: c(f.outerHTML, 1500) };
  });
}
(async () => {
  const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH);
  const browser = await pw.chromium.launch({ headless: true });
  const pacer = lib.createPacer(), robots = new Map(), ua = `Mozilla/5.0 ${lib.UA_TOKEN}`;
  for (const url of process.argv.slice(2)) {
    if ((await robotsOk(url, robots, ua)) !== true) { console.log("DIAGTT-ROBOTS " + url); continue; }
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
    await ctx.addInitScript(lib.SUBMIT_TRAP);
    const blocked = [];
    await ctx.route("**/*", async (route) => {
      const r = route.request();
      if (!/^(GET|HEAD|OPTIONS)$/.test(r.method())) { blocked.push(`${r.method()} ${cut(r.url(), 140)}`); return route.abort("blockedbyclient"); }
      if (["image", "media", "font"].includes(r.resourceType())) return route.abort();
      if (r.isNavigationRequest()) await pacer.wait(new URL(r.url()).host);
      return route.continue();
    });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      console.log("DIAGTT-BEFORE " + url + " " + resp.status() + " " + JSON.stringify(await page.evaluate(FORMS)));
      const btns = await page.evaluate(() => [...document.querySelectorAll("a,button,[role=button]")].filter((e) => !e.closest("form") && (e.offsetWidth || e.offsetHeight) && /apply|ansök|bewerb|søk|sök|postul|candidat/i.test(e.innerText || "")).map((e) => `${e.tagName} "${(e.innerText || "").trim().slice(0, 40)}" href=${e.getAttribute("href") || ""}`));
      console.log("DIAGTT-APPLY " + url + " " + JSON.stringify(btns));
      for (const b of await page.$$("button:visible, a:visible")) {
        const t = (await b.innerText().catch(() => "")).trim();
        if (/^(apply for this job|apply now|apply|ansök nu|ansök|søk nå|søk|jetzt bewerben)$/i.test(t) && !(await b.evaluate((e) => !!e.closest("form")))) {
          await b.evaluate((e) => e.removeAttribute("target"));
          await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), b.click().catch(() => null)]);
          break;
        }
      }
      await page.waitForTimeout(4000);
      console.log("DIAGTT-AFTER " + page.url() + " " + JSON.stringify(await page.evaluate(FORMS)));
      const file = await page.$("input[type=file]");
      if (file && /workable/.test(url)) {
        const p = "/tmp/diagtt-resume.pdf"; require("fs").writeFileSync(p, "%PDF-1.4 TEST\n");
        await file.setInputFiles(p).catch((e) => console.log("DIAGTT-SETFILE-ERR " + e.message));
        await page.waitForTimeout(4000);
        console.log("DIAGTT-AFTERFILE " + url + " forms=" + (await page.evaluate(() => document.forms.length)) + " inputs=" + (await page.evaluate(() => document.querySelectorAll("input:not([type=hidden])").length)));
      }
      console.log("DIAGTT-BLOCKED " + url + " " + JSON.stringify(blocked.slice(0, 20)));
    } catch (e) { console.log("DIAGTT-ERR " + url + " " + cut(e.message, 200)); }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
