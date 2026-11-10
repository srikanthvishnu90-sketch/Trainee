#!/usr/bin/env node
"use strict";
// Bench-only diagnostic (never in a PR): drives a few held-out postings through applyOne exactly as batch60 does (dry run: every
// non-GET aborted, submits trapped, stopped before the click) and prints the markup around the upload and around held questions.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const af = require("../../workers/career-browser/ats-fill.cjs");
const cut = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
function DUMP(names) {
  const cutp = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
  const out = { files: [], fbox: [], named: [] };
  for (const f of document.querySelectorAll("input[type=file]")) {
    let a = f; for (let i = 0; i < 5 && a.parentElement; i++) a = a.parentElement;
    out.files.push({ q: f.getAttribute("data-upmore-q"), n: f.files ? f.files.length : -1, html: cutp(a.outerHTML, 2500) });
  }
  for (const b of document.querySelectorAll("[data-upmore-fbox]")) out.fbox.push(cutp(b.tagName + "." + b.className + " txt=" + (b.innerText || ""), 200));
  out.name_on_page = (document.body.innerText || "").includes("resume.pdf") || (document.body.innerText || "").includes("TEST-synthetic");
  for (const n of names) {
    const el = [...document.querySelectorAll("input, select, textarea")].find((e) => e.name === n || e.id === n);
    if (!el) { out.named.push({ n, html: "not found" }); continue; }
    const path = []; let a = el;
    for (let i = 0; i < 9 && a.parentElement; i++) {
      const par = a.parentElement, prev = [];
      for (let c = a.previousElementSibling; c && prev.length < 4; c = c.previousElementSibling) prev.push(`${c.tagName}.${cutp(c.className, 40)}[${cutp(c.getAttribute("ng-bind-html") || c.getAttribute("ng-bind") || "", 40)}] "${cutp(c.innerText, 120)}"`);
      path.push(`${par.tagName}.${cutp(par.className, 60)} <- prev: ${prev.join(" || ")}`);
      a = par;
    }
    out.named.push({ n, tag: el.tagName + "." + el.type + " id=" + el.id, path });
  }
  return out;
}
const origFill = af.fillForm, origHeld = af.heldNow;
af.fillForm = async (page, ctx) => {
  const r = await origFill(page, ctx);
  const names = [...r.needsUser, ...r.failed].map((x) => x.label).filter((l) => /^(section_|c[A-Z]|eeoc|race|gender|veteran|disab)/.test(l) || !/\s/.test(l));
  const d = await page.evaluate(DUMP, names).catch((e) => ({ err: e.message }));
  console.log("DIAGB60-FILL " + page.url() + " " + JSON.stringify({ needs: r.needsUser.map((x) => [x.label, x.reason, x.kind, cut(x.detail, 200), (x.options || []).slice(0, 8)]), failed: r.failed, filled: r.filled.map((f) => [f.label, f.kind, f.source]), dump: d }));
  return r;
};
af.heldNow = async (page, filled) => {
  const d1 = await page.evaluate(DUMP, []).catch((e) => ({ err: e.message }));
  const h = await origHeld(page, filled);
  console.log("DIAGB60-HELD " + page.url() + " " + JSON.stringify({ held: h.map((x) => [x.label, x.kind, x.source, x.held === null ? null : (x.kind === "file" ? x.held : "<v>"), x.gone]), dump: d1 }));
  return h;
};
const { applyOne, payloadHash, NeedsUser } = require("../../workers/career-browser/parallel-apply.cjs");
const lib = require("./eval-lib.cjs");
const { graphqlRead, robotsOk, PROVIDER_HOSTS } = require("./strict.cjs");
const { TEST_FIELDS } = require("./batch60.cjs");
const URLS = process.argv.slice(2);
(async () => {
  const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH);
  const browser = await pw.chromium.launch({ headless: true });
  const out = fs.mkdtempSync("/tmp/diag-");
  const resumePath = path.join(out, "resume.pdf"); fs.copyFileSync(lib.syntheticResume(path.join(out, "fx")), resumePath);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(resumePath)).digest("hex");
  const pacer = lib.createPacer(), robots = new Map(), ua = `Mozilla/5.0 ${lib.UA_TOKEN}`;
  const answers = {}; for (const f of TEST_FIELDS) answers[f.label] = f.value;
  for (const url of URLS) {
    const provider = /greenhouse/.test(url) ? "greenhouse" : /lever/.test(url) ? "lever" : /personio/.test(url) ? "personio" : "breezy";
    const rb = await robotsOk(url, robots, ua); if (rb !== true) { console.log("DIAGB60-ROBOTS " + url + " " + rb); continue; }
    const hosts = [new URL(url).hostname, ...(PROVIDER_HOSTS[provider] || [])];
    const gate = async (req) => { let u; try { u = new URL(req.url()); } catch { return false; } if (/^(data|blob|about):$/.test(u.protocol)) return true;
      if (!/^(GET|HEAD|OPTIONS)$/.test(req.method()) && !graphqlRead(req)) return false;
      if (["image", "media", "font"].includes(req.resourceType())) return false; if (req.isNavigationRequest()) await pacer.wait(u.host); return true; };
    const p = { id: "d", ats: provider, url, facts: {}, answers, resume: { path: resumePath, sha256: sha, preparedWithSha256: sha } };
    p.approval = { approval_id: "diag", hash: payloadHash(p) };
    const r = await applyOne(browser, p, { allowHosts: hosts, retries: 0, stepTimeoutMs: 20000, requestGate: gate, initScript: lib.SUBMIT_TRAP, audit: true, diag: true,
      onPhase: async (ph) => { if (ph === "submitting") throw new NeedsUser("dry_run_stopped_before_submit"); } });
    console.log("DIAGB60-RESULT " + url + " " + JSON.stringify({ status: r.status, reason: r.reason, field: r.field, error: r.error, needs: (r.needs || []).map((n) => [n.label, n.reason, cut(n.detail, 160)]) }));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
