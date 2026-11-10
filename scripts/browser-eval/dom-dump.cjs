#!/usr/bin/env node
"use strict";
// Read-only DOM dump of a few postings, for diagnosing why the runner misses their form (bench branches only; nothing is sent:
// every request but GET/HEAD/OPTIONS is aborted and logged, the submit trap cancels every submit, robots are the caller's job
// since the URLs are the committed sample's). Optional step: set the synthetic resume on the first file input and log what
// the page then tries to send (aborted) and what the upload block shows.
//   node scripts/browser-eval/dom-dump.cjs URL [URL...]
const path = require("node:path");
const lib = require("./eval-lib.cjs");
const APPLYISH = /apply|bewerb|solicit|enviar|postul|candidat|soliciteer|sollicit|versturen|ansök|ansøg|søk|pateik|kandid|iesniegt|pieteik|submit|send|absenden/i;
function DUMP(applyish) {
  const re = new RegExp(applyish, "i");
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}${cs.visibility === "hidden" ? " vh" : ""}${cs.display === "none" ? " dn" : ""}${Number(cs.opacity) === 0 ? " op0" : ""}`; };
  const t = (s, n = 90) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const lab = (e) => { const l = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`); return t((l && l.textContent) || (e.closest("label") || {}).textContent || e.getAttribute("aria-label") || e.placeholder || ""); };
  const chain = (e) => { const a = []; for (let p = e.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) a.push(`${p.tagName.toLowerCase()}.${t(p.className, 40)}`); return a.join("<"); };
  const out = { url: location.href, title: document.title, forms: [] };
  for (const f of document.querySelectorAll("form")) {
    out.forms.push({ action: f.getAttribute("action"), method: f.method, id: f.id, cls: t(f.className, 60), vis: vis(f),
      fields: [...f.querySelectorAll("input, select, textarea, button")].map((e) => `${e.tagName.toLowerCase()}[${e.type || ""}] name=${e.name || ""} id=${t(e.id, 30)} req=${e.required ? 1 : 0}${e.getAttribute("aria-required") === "true" ? "a" : ""} ${vis(e)} tabindex=${e.getAttribute("tabindex") || ""} ac=${e.getAttribute("autocomplete") || ""} label="${lab(e)}" text="${t(e.innerText || e.value, 50)}" in=${chain(e)}`) });
  }
  out.loose = [...document.querySelectorAll("input, select, textarea")].filter((e) => !e.closest("form")).map((e) => `${e.tagName.toLowerCase()}[${e.type}] name=${e.name} req=${e.required ? 1 : 0} ${vis(e)} label="${lab(e)}"`);
  out.controls = [...document.querySelectorAll("a, button, [role=button]")].filter((e) => re.test(e.innerText || e.getAttribute("aria-label") || "")).map((e) => `${e.tagName} "${t(e.innerText || e.getAttribute("aria-label"), 50)}" href=${e.getAttribute("href") || ""} type=${e.getAttribute("type") || ""} inForm=${!!e.closest("form")} ${vis(e)}`).slice(0, 20);
  return out;
}
async function main() {
  const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
  const browser = await pw.chromium.launch({ headless: true });
  const resume = lib.syntheticResume(path.join("artifacts", "dom-dump"));
  for (const url of process.argv.slice(2)) {
    const ctx = await browser.newContext({ userAgent: `Mozilla/5.0 ${lib.UA_TOKEN}`, locale: "en-US" });
    await ctx.addInitScript(lib.SUBMIT_TRAP);
    const sent = [];
    await ctx.route("**/*", (r) => { const q = r.request(); if (!/^(GET|HEAD|OPTIONS)$/.test(q.method())) { sent.push(`${q.method()} ${q.url().slice(0, 120)}`); return r.abort(); } if (["image", "media", "font"].includes(q.resourceType())) return r.abort(); return r.continue(); });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      console.log("DUMP " + JSON.stringify({ status: resp && resp.status(), ...(await page.evaluate(DUMP, APPLYISH.source)) }));
      // Open the first visible apply-like control outside a form (a modal or in-place form; submits are trapped, sends aborted).
      const h = await page.evaluateHandle(() => [...document.querySelectorAll("a, button")].find((e) => !e.closest("form") && (e.offsetWidth || e.offsetHeight) && /^\s*(apply|apply for this job|jetzt bewerben|enviar solicitud|postuler|solicitar este puesto de trabajo|pateikti paraišką|kandidatuoti|ansök( nu)?|solliciteer( nu)?)\s*$/i.test(e.innerText || ""))).catch(() => null);
      const el = h && h.asElement();
      if (el) { const w = await el.innerText(); await el.click().catch(() => {}); await page.waitForTimeout(3000); console.log("AFTER_CLICK " + JSON.stringify({ clicked: w, ...(await page.evaluate(DUMP, APPLYISH.source)) })); }
      const f = await page.$("input[type=file]");
      if (f) {
        await f.setInputFiles(resume).catch((e) => sent.push("setInputFiles error " + e.message.slice(0, 80)));
        await page.waitForTimeout(3000);
        const box = await f.evaluate((e) => { let b = e; for (let i = 0; i < 4 && b.parentElement; i++) b = b.parentElement; return { files: e.files ? e.files.length : -1, connected: e.isConnected, box: (b.innerText || "").replace(/\s+/g, " ").slice(0, 200) }; }).catch((e) => ({ err: e.message.slice(0, 80) }));
        console.log("UPLOAD " + JSON.stringify({ url, ...box, fileInputsNow: await page.$$eval("input[type=file]", (xs) => xs.map((x) => `${x.name}:${x.files ? x.files.length : -1}`)) }));
      }
    } catch (e) { console.log("ERR " + url + " " + e.message.split("\n")[0]); }
    console.log("SENT " + JSON.stringify({ url, sent }));
    await ctx.close();
    await new Promise((r) => setTimeout(r, 1500));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
