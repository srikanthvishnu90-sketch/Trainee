#!/usr/bin/env node
"use strict";
// x-audit (coordinator ruling 2026-11-10): what value-hashing the employer's hidden fields would cost. Each posting is opened
// TWICE, in two fresh contexts, through the dry-run eval (eval-lib.cjs: GET/HEAD/OPTIONS only, submits trapped, robots.txt
// obeyed, 1 request a second per host, nothing submitted). The hidden fields are read exactly as scripts/apply.ts reads them
// (input[type=hidden] in the page, a name and a non-empty value, not a captcha response). A field whose value differs between
// the two loads, and whose name is not a per-load token (EXEMPT, the ruling's pattern), would stop an approved application
// as approval_changed. Prints one HIDDEN line per posting and one HIDDEN_SUMMARY line.
//   node scripts/browser-eval/hidden-twice.cjs --sample scripts/browser-eval/sample.csv --max-per-provider 20
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const lib = require("./eval-lib.cjs");

const CAPTCHA_TOKEN = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/; // scripts/apply.ts:81
const EXEMPT = /csrf|xsrf|authenticity|nonce|(^|_)token$|captcha|recaptcha|turnstile|-captcha-response$/i;
const HIDDEN = () => Array.from(document.querySelectorAll("input[type=hidden]")).map((e) => ({ name: e.name, value: String(e.value ?? "") }));

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; } return o; }
function compare(a, b) {
  const changed = [], exemptChanged = [], onlyOne = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a) || !(k in b)) { onlyOne.push(k); continue; }
    if (a[k] !== b[k]) (EXEMPT.test(k) ? exemptChanged : changed).push(k);
  }
  return { changed, exemptChanged, onlyOne };
}

async function main() {
  const o = args(process.argv.slice(2));
  const items = lib.readSample(fs.readFileSync(o.sample, "utf8"), { max: o["max-per-provider"] });
  let pw;
  for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  const browser = await pw.chromium.launch({ headless: true });
  const probe = await browser.newPage();
  const userAgent = `${(await probe.evaluate(() => navigator.userAgent))} ${lib.UA_TOKEN}`;
  await probe.close();
  const pacer = lib.createPacer({ gapMs: 1000 });
  const robotsCache = new Map();
  const resumePath = lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "hidden-twice-")));
  const queues = new Map();
  for (const it of items) { if (!queues.has(it.provider)) queues.set(it.provider, []); queues.get(it.provider).push(it); }
  const tally = { postings: 0, both_forms: 0, with_hidden: 0, would_stop: 0, exempt_only_changed: 0, names: {}, exempt_names: {}, only_one_load: 0 };
  const provs = [...queues.keys()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, provs.length) }, async () => {
    while (next < provs.length) {
      const prov = provs[next++];
      for (const it of queues.get(prov)) {
        const loads = [];
        for (let k = 0; k < 2; k++) {
          let hidden = null;
          const r = await lib.evalPosting(browser, it, { pacer, robotsCache, resumePath, userAgent, onForm: async (page) => {
            hidden = {};
            for (const h of await page.evaluate(HIDDEN)) if (h.name && h.value && !CAPTCHA_TOKEN.test(h.name)) hidden[h.name] = h.value;
          } });
          // A page script that tries to submit is trapped and cancelled by eval-lib (submit_attempts, nothing sent); only a click is a breach.
          if (r.submit_clicked) { console.error("INVARIANT BROKEN: a submit was clicked"); process.exit(1); }
          if (!hidden) console.log(`LOAD ${prov} ${it.n} ${k + 1}: ${r.error || (r.walls.join(",") || (r.opened ? "opened, no form" : "not opened"))}`);
          loads.push(hidden);
        }
        tally.postings++;
        let line = "no_form";
        if (loads[0] && loads[1]) {
          tally.both_forms++;
          const n = Object.keys(loads[0]).length;
          if (n) tally.with_hidden++;
          const c = compare(loads[0], loads[1]);
          if (c.onlyOne.length) tally.only_one_load++;
          if (c.changed.length) { tally.would_stop++; for (const k of c.changed) tally.names[k] = (tally.names[k] || 0) + 1; }
          else if (c.exemptChanged.length) tally.exempt_only_changed++;
          for (const k of c.exemptChanged) tally.exempt_names[k] = (tally.exempt_names[k] || 0) + 1;
          line = `hidden=${n} changed=${c.changed.join(",") || "-"} exempt_changed=${c.exemptChanged.join(",") || "-"} only_one_load=${c.onlyOne.join(",") || "-"}`;
        }
        let host = ""; try { host = new URL(it.url).host; } catch { /* - */ }
        console.log(`HIDDEN | ${prov} | ${it.n} | ${host} | ${line}`);
      }
    }
  }));
  await browser.close();
  console.log(`HIDDEN_SUMMARY ${JSON.stringify(tally)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
