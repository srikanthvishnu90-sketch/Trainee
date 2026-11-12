#!/usr/bin/env node
"use strict";
// D-072 item 4 round 2: a READ-ONLY capture of the pages the round-1 bench could not finish, to fix the engine from their real
// structure. Bench branch only, never a PR. Every request but GET/HEAD/OPTIONS is aborted in the browser (its method, address,
// content type and the first bytes of its body are logged, so the upload request's shape is known without sending it), a page
// script cancels every form submit, no Submit is clicked, robots.txt obeyed, 1 page load a second per provider. No secrets.
const fs = require("node:fs");
const path = require("node:path");
const lib = require(path.resolve("scripts/browser-eval/eval-lib.cjs"));
const { robotsOk } = require(path.resolve("scripts/browser-eval/strict.cjs"));
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");
const cut = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
const SHARED = /(?:^|\.)(recruitee\.com|teamtailor\.com|bamboohr\.com|breezy\.hr|jobs\.personio\.de|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|lever\.co|ashbyhq\.com|greenhouse\.io)$/i;
const paceKey = (h) => { const m = SHARED.exec(String(h).toLowerCase()); return m ? m[1] : String(h).toLowerCase(); };

function DUMP() {
  const cut = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const attrs = (e) => [...e.attributes].filter((a) => a.name !== "style" && a.name !== "d").map((a) => `${a.name}="${cut(a.value, 80)}"`).join(" ");
  const chain = (e) => { const out = []; for (let a = e.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) out.push(`${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}${[...a.classList].slice(0, 3).map((c) => "." + c).join("")}`); return out.join(" < "); };
  const ctl = [...document.querySelectorAll("a, button, [role=button], input[type=submit], input[type=button]")].filter(vis)
    .filter((e) => !/cookie|informationskapsl|slapuk|share|dela|del sid|menu|meny|cookies/i.test(e.innerText || ""))
    .slice(0, 40).map((e) => `${e.tagName} "${cut(e.innerText || e.value, 50)}" [${attrs(e)}] form=${!!e.closest("form")} {${chain(e)}} ${e.offsetWidth}x${e.offsetHeight}`);
  const hosts = []; const walk = (n) => { for (const c of n.children) { if (c.shadowRoot) hosts.push(c); walk(c); if (c.shadowRoot) walk(c.shadowRoot); } }; walk(document.body || document.documentElement);
  const shadow = hosts.slice(0, 15).map((h) => `${h.tagName} [${attrs(h)}] btn=${[...h.shadowRoot.querySelectorAll("a,button,[role=button]")].slice(0, 4).map((b) => `${b.tagName}"${cut(b.innerText, 30)}"[${attrs(b)}]`).join(" ; ")}`);
  const forms = [...document.forms].map((f) => `FORM [${attrs(f)}] inputs=${f.querySelectorAll("input:not([type=hidden]),select,textarea").length} files=${f.querySelectorAll("input[type=file]").length}`);
  const html = document.documentElement.outerHTML;
  const grab = (re) => { const m = html.match(re); return m ? m.slice(0, 4).map((x) => cut(x, 200)) : []; };
  const custom = [...new Set([...document.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()).filter((t) => t.includes("-")))].slice(0, 30);
  return { url: location.href, title: cut(document.title, 100), ready: document.readyState, forms, inputs: document.querySelectorAll("input:not([type=hidden]),select,textarea").length,
    ctl, shadow, custom, oneclick: grab(/oneclick-ui[^"'<\s]{0,160}/g), applyLinks: grab(/https?:\/\/[^"'\s<]*apply[^"'\s<]{0,120}/g),
    wd: [...document.querySelectorAll("[data-automation-id]")].slice(0, 30).map((e) => e.getAttribute("data-automation-id")),
    body: cut((document.body && document.body.innerText) || "", 400) };
}
// One question's own HTML: its label's container (the field named), the element drawn at its centre, overlays on the page.
function FIELD(label) {
  const cut = (s, n = 300) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
  const want = String(label).toLowerCase();
  const labs = [...document.querySelectorAll("label, legend, h3, [class*=label]")].filter((e) => (e.innerText || "").toLowerCase().includes(want)).sort((a, b) => a.innerText.length - b.innerText.length);
  const out = [];
  for (const l of labs.slice(0, 3)) {
    const box = l.closest("li, fieldset, .field, .form-group, [class*=field], [class*=question]") || l.parentElement;
    const ins = [...box.querySelectorAll("input, select, textarea")];
    const hits = ins.slice(0, 4).map((i) => { const r = i.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const cs = getComputedStyle(i);
      return `${i.tagName} type=${i.type} name=${i.name} id=${i.id} dis=${i.disabled} ro=${i.readOnly} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} vis=${cs.visibility} op=${cs.opacity} pe=${cs.pointerEvents} top=${h ? h.tagName + "." + cut(h.className, 50) : "none"}`; });
    out.push({ html: cut(box.outerHTML, 1800), hits });
  }
  const overlays = [...document.querySelectorAll("body *")].filter((e) => { const cs = getComputedStyle(e); return (cs.position === "fixed" || cs.position === "absolute") && e.offsetWidth > 300 && e.offsetHeight > 200 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05; })
    .slice(0, 5).map((e) => `${e.tagName}#${e.id}.${cut(e.className, 60)} ${e.offsetWidth}x${e.offsetHeight} z=${getComputedStyle(e).zIndex} "${cut(e.innerText, 80)}"`);
  return { out, overlays, active: document.activeElement ? document.activeElement.tagName + "#" + document.activeElement.id : "" };
}

async function one(browser, item, o) {
  const tag = `${item.provider}|${item.cause}`;
  const log = (k, x) => console.log(`CAP-${k} | ${tag} | ${item.url} | ${typeof x === "string" ? x : JSON.stringify(x)}`);
  const rb = await robotsOk(item.url, o.robots, o.ua, o.pacer);
  if (rb !== true) return log("ROBOTS", String(rb));
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 }, userAgent: o.ua, locale: "en-US" });
  await ctx.addInitScript(lib.SUBMIT_TRAP);
  await ctx.exposeBinding("__evalSubmitAttempt", () => log("SUBMIT-TRAPPED", "a submit was cancelled in the page"));
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const t0 = Date.now();
  let watch = false;
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    let u; try { u = new URL(req.url()); } catch { return route.abort(); }
    if (/^(data|blob|about):$/.test(u.protocol)) return route.continue();
    if (!/^(GET|HEAD|OPTIONS)$/.test(req.method())) {
      let body = ""; try { body = (req.postDataBuffer() || Buffer.alloc(0)).toString("latin1"); } catch { /* none */ }
      if (!/google-analytics|googletagmanager|snowplow|bugsnag|pageview|collect|sentry|segment|hotjar|datadog|cookie/i.test(u.href))
        log("POST-BLOCKED", { m: req.method(), url: cut(u.href, 220), ct: req.headers()["content-type"] || "", type: req.resourceType(), body: cut(body.replace(/[^\x20-\x7e\r\n]/g, "."), 700), t: Date.now() - t0 });
      return route.abort("blockedbyclient");
    }
    if (["image", "media", "font"].includes(req.resourceType())) return route.abort("blockedbyclient");
    if (req.isNavigationRequest()) await o.pacer.wait(paceKey(u.host));
    if (watch && ["xhr", "fetch"].includes(req.resourceType())) log("XHR", { m: req.method(), url: cut(u.href, 220), t: Date.now() - t0 });
    return route.continue();
  });
  page.on("response", async (r) => {
    const rt = r.request().resourceType();
    if (!["xhr", "fetch", "document"].includes(rt)) return;
    const u = r.url();
    if (item.provider === "workday" || /location|presign|upload|oneclick|publication|posting/i.test(u))
      log("RESP", { s: r.status(), type: rt, url: cut(u, 220), ct: cut(r.headers()["content-type"], 40), t: Date.now() - t0, body: /json/.test(r.headers()["content-type"] || "") ? cut(await r.text().catch(() => ""), 400) : "" });
    if (rt === "document" && r.status() >= 300 && r.status() < 400) log("REDIRECT", { s: r.status(), from: cut(u, 200), to: cut(r.headers().location, 200) });
  });
  try {
    watch = true;
    const resp = await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => ({ err: cut(e.message, 200) }));
    if (resp && resp.err) { log("GOTO-ERR", resp.err); }
    else log("LOADED", { s: resp && resp.status(), url: page.url(), t: Date.now() - t0 });
    if (item.provider === "workday") {
      for (let i = 0; i < 25; i++) { await page.waitForTimeout(2000); const d = await page.evaluate(DUMP).catch((e) => ({ err: cut(e.message, 80) })); log("WD-POLL", { t: Date.now() - t0, url: d.url, title: d.title, inputs: d.inputs, wd: (d.wd || []).slice(0, 12), body: cut(d.body, 120) }); if (d.inputs > 2 || (d.wd || []).includes("applyManually")) break; }
      // The posting's own apply-manually address, as the runner opens it.
      const am = page.url().replace(/\/+$/, "").replace(/(\/job\/[^?#]+?)(\/apply.*)?$/, "$1/apply/applyManually");
      if (am !== page.url()) {
        await page.goto(am, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => log("GOTO-ERR", cut(e.message, 120)));
        for (let i = 0; i < 25; i++) { await page.waitForTimeout(2000); const d = await page.evaluate(DUMP).catch((e) => ({ err: cut(e.message, 80) })); log("WD-AM-POLL", { t: Date.now() - t0, url: d.url, title: d.title, inputs: d.inputs, wd: (d.wd || []).slice(0, 14), body: cut(d.body, 160) }); if (d.inputs > 2) break; }
      }
    } else {
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    }
    log("DUMP", await page.evaluate(DUMP).catch((e) => ({ err: cut(e.message, 120) })));
    // Teamtailor / Personio / SmartRecruiters / Breezy: what the page's own apply control is and what clicking it draws.
    if (/apply_control|no_submit|page_not_rendered/.test(item.cause) && item.provider !== "recruitee") {
      const picks = await page.evaluate(() => {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
        const c = [...document.querySelectorAll("a, button, [role=button]")].filter((e) => vis(e) && !e.closest("form") && !/cookie|informationskapsl|slapuk|share|dela|menu|meny|login|connect|linkedin/i.test(e.innerText || ""));
        const words = new Map(); for (const e of c) { const t = (e.innerText || "").trim(); if (t) words.set(t, (words.get(t) || 0) + 1); }
        return [...words].filter(([, n]) => n >= 2).map(([t]) => t).slice(0, 3);
      }).catch(() => []);
      log("REPEATED", picks);
      for (const t of picks.slice(0, 1)) {
        const loc = page.locator("a, button, [role=button]").filter({ hasText: t }).first();
        const href = await loc.getAttribute("href").catch(() => null);
        log("CLICK", { text: t, href });
        await loc.evaluate((e) => e.removeAttribute("target")).catch(() => {});
        await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), loc.click({ timeout: 8000 }).catch((e) => log("CLICK-ERR", cut(e.message, 120)))]);
        await page.waitForTimeout(3000);
        log("AFTER-CLICK", await page.evaluate(DUMP).catch((e) => ({ err: cut(e.message, 120) })));
      }
    }
    // The form's questions named by the round-1 stop: their HTML, what sits at their centre, overlays.
    const fieldOf = { field_fill_error: "First Name", option_covered: "authorized", label_on_form_twice: "Phone", place_not_offered: "location", form_rejects_value: "phone", person_answer_no_handoff: "requires access" };
    if (fieldOf[item.cause]) {
      const direct = lib.applyUrlFor(item.provider, page.url());
      if (direct && !/\/apply/.test(page.url())) { await page.goto(direct, { waitUntil: "domcontentloaded" }).catch(() => {}); await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}); }
      const lab = item.provider === "workable" && item.cause === "field_fill_error" ? "authorized" : fieldOf[item.cause];
      log("FIELD", await page.evaluate(FIELD, lab).catch((e) => ({ err: cut(e.message, 120) })));
      if (item.cause === "place_not_offered") {
        const inp = page.locator("input[name='location'], input#location-input, .application-question input[type=text]").filter({ hasNot: page.locator("xpath=..") }).first();
        const box = page.locator("input#location-input, input[name=location]").first();
        await box.click({ timeout: 5000 }).catch(() => {}); await box.pressSequentially("Chicago, IL", { delay: 40 }).catch((e) => log("TYPE-ERR", cut(e.message, 100)));
        await page.waitForTimeout(5000);
        log("FIELD-AFTER-TYPE", await page.evaluate(FIELD, "location").catch((e) => ({ err: cut(e.message, 120) })));
        void inp;
      }
      if (item.cause === "field_fill_error" && item.provider === "greenhouse") {
        const fn = page.locator("input#first_name, input[name='first_name'], input[autocomplete='given-name']").first();
        const t1 = Date.now(); const ok = await fn.fill("Testy", { timeout: 8000 }).then(() => "filled", (e) => cut(e.message, 400)); log("FILL-TRY", { ok, ms: Date.now() - t1 });
      }
      if (item.cause === "option_covered") {
        const r = page.locator("input[type=radio]").first();
        log("RADIO", await r.evaluate((e) => { const box = e.closest("[role=radiogroup], fieldset") || e.parentElement.parentElement.parentElement; const rr = e.getBoundingClientRect(); const lab = e.closest("label") || (e.id && document.querySelector(`label[for="${e.id}"]`)); const lr = lab ? lab.getBoundingClientRect() : null; const h = lr ? document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2) : null; return { html: String(box.outerHTML).slice(0, 2000), input: `${Math.round(rr.width)}x${Math.round(rr.height)}`, lab: lr ? `${Math.round(lr.width)}x${Math.round(lr.height)}` : null, atLabel: h ? `${h.tagName}.${h.className}` : null }; }).catch((e) => cut(e.message, 160)));
      }
    }
    // Uploads: which request the board makes with the resume (blocked here and logged by the route above), and the board's own
    // script around its upload endpoint (read with GET only).
    if (item.cause === "upload_not_accepted") {
      const direct = lib.applyUrlFor(item.provider, page.url());
      if (direct && !/\/apply/.test(page.url())) { await page.goto(direct, { waitUntil: "domcontentloaded" }).catch(() => {}); await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}); }
      if (item.provider === "teamtailor") {
        const t = await page.evaluate(() => { const vis = (e) => !!(e.offsetWidth || e.offsetHeight); const c = [...document.querySelectorAll("button, a")].filter((e) => vis(e) && !e.closest("form") && /apply|søk|ansök|ansøg|bewerb|postul/i.test(e.innerText || "") && !/linkedin|connect/i.test(e.innerText || "")); return c.length ? c[0].innerText.trim() : null; }).catch(() => null);
        if (t) { await page.locator("button, a").filter({ hasText: t }).first().click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(2500); }
      }
      const files = await page.$$("input[type=file]");
      log("FILES", { n: files.length, html: await page.evaluate(() => [...document.querySelectorAll("input[type=file]")].slice(0, 3).map((i) => { let b = i; for (let k = 0; k < 4 && b.parentElement; k++) b = b.parentElement; return String(b.outerHTML).replace(/\s+/g, " ").slice(0, 1500); })).catch(() => []) });
      if (files.length) {
        await files[0].setInputFiles(o.resume).catch((e) => log("SET-ERR", cut(e.message, 120)));
        await page.waitForTimeout(6000);
        log("AFTER-SET", await page.evaluate(() => [...document.querySelectorAll("input[type=file]")].slice(0, 2).map((i) => { let b = i; for (let k = 0; k < 4 && b.parentElement; k++) b = b.parentElement; return String(b.outerHTML).replace(/\s+/g, " ").slice(0, 1200); })).catch(() => []));
      }
      if (!o.bundles.has(item.provider)) {
        o.bundles.add(item.provider);
        const srcs = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean)).catch(() => []);
        log("SCRIPTS", srcs.slice(0, 20));
        const needle = { teamtailor: ["presigned_data", "presignedData", "uploads/"], breezy: ["resume", "upload", "s3"], greenhouse: ["presigned", "s3", "upload"] }[item.provider] || ["upload"];
        for (const src of srcs.slice(0, 20)) {
          const txt = await page.evaluate((s) => fetch(s).then((r) => r.text()).catch(() => ""), src).catch(() => "");
          for (const n of needle.slice(0, 1)) { let at = txt.indexOf(n), k = 0; while (at >= 0 && k < 3) { log("JS", { src: cut(src, 120), n, around: txt.slice(Math.max(0, at - 700), at + 900).replace(/\s+/g, " ") }); at = txt.indexOf(n, at + n.length); k++; } }
        }
      }
    }
    // Redirect chains: each hop's Location, read with GET and redirects off.
    if (/redirect/.test(item.cause)) {
      let u = item.url;
      for (let i = 0; i < 6; i++) { const r = await ctx.request.get(u, { maxRedirects: 0, timeout: 15000 }).catch((e) => ({ err: cut(e.message, 100) })); if (r.err) { log("HOP-ERR", r.err); break; } const loc = r.headers().location; log("HOP", { u: cut(u, 200), s: r.status(), loc: cut(loc, 200) }); if (!loc) break; u = new URL(loc, u).href; }
    }
    if (item.cause === "person_answer_no_handoff") log("FIELD", await page.evaluate(FIELD, "requires access").catch(() => null));
  } catch (e) {
    log("ERR", cut(e && e.message, 200));
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const rows = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map((l) => { const [provider, cause, url] = l.split(","); return { provider, cause, url }; });
  const browser = await pw.chromium.launch({ headless: true });
  const o = { robots: new Map(), pacer: lib.createPacer(), ua: `Mozilla/5.0 ${lib.UA_TOKEN}`, resume: lib.syntheticResume(path.resolve("artifacts/cap")), bundles: new Set() };
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < rows.length) { const i = next++; await Promise.race([one(browser, rows[i], o), new Promise((r) => setTimeout(r, 150000))]); } }));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
