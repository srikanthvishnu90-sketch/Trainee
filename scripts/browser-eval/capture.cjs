#!/usr/bin/env node
"use strict";
// Bench-only: GET-only capture of the markup around the questions the strict runner stopped on. Nothing is sent: every
// request but GET/HEAD/OPTIONS is aborted, a page script cancels every submit, no control but the Apply link is clicked.
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const lib = require("./eval-lib.cjs");
const URLS = process.argv.slice(2);
(async () => {
  const b = await pw.chromium.launch({ headless: true });
  for (const url of URLS) {
    const ctx = await b.newContext({ viewport: { width: 900, height: 1100 } });
    await ctx.addInitScript(lib.SUBMIT_TRAP);
    await ctx.route("**/*", (r) => (/^(GET|HEAD|OPTIONS)$/.test(r.request().method()) && !["image", "media", "font"].includes(r.request().resourceType()) ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector("form input", { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout(2500);
      const out = await page.evaluate(() => {
        const cut = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
        const o = { url: location.href, forms: document.forms.length };
        o.buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")].map((e) => cut(`${e.tagName} type=${e.getAttribute("type")} vis=${vis(e)} ${e.offsetWidth}x${e.offsetHeight} inForm=${!!e.closest("form")} dis=${e.disabled} cls=${e.className} "${(e.innerText || e.value || "").trim()}"`, 200)).slice(0, 40);
        o.invalid = [...document.querySelectorAll("input:invalid, select:invalid, textarea:invalid")].map((e) => {
          let box = e; for (let i = 0; i < 6 && box.parentElement && box.parentElement.outerHTML.length < 3500; i++) box = box.parentElement;
          return { name: e.name, type: e.type, vis: vis(e), wh: `${e.offsetWidth}x${e.offsetHeight}`, html: cut(box.outerHTML, 3500) };
        }).filter((x, i, a) => a.findIndex((y) => y.html === x.html) === i).slice(0, 6);
        const f = document.querySelector("form");
        o.form_len = f ? f.outerHTML.length : 0;
        o.form_head = f ? cut(f.outerHTML, 6000) : "";
        o.form_tail = f ? cut(f.outerHTML.slice(-5000), 5000) : "";
        o.address = [...document.querySelectorAll("input, textarea")].filter((e) => /address|street|city|zip|postal/i.test(`${e.name} ${e.id} ${e.placeholder}`)).map((e) => cut((e.closest("li, .form-group, div") || e).outerHTML, 800)).slice(0, 4);
        return o;
      });
      console.log("CAPTURE " + JSON.stringify(out));
    } catch (e) { console.log("CAPTURE_ERR " + url + " " + String(e.message).split("\n")[0]); }
    await ctx.close();
    await new Promise((r) => setTimeout(r, 1200));
  }
  await b.close();
})();
