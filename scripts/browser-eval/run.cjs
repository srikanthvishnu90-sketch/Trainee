#!/usr/bin/env node
"use strict";
// WO-M: the real-site browser DRY-RUN eval (scripts/browser-eval/eval-lib.cjs says exactly what it does and cannot do).
//   node scripts/browser-eval/run.cjs --sample artifacts/browser-eval/sample.csv --label baseline-2026-11-09
// Options: --max-per-provider N (at most 20), --providers greenhouse,lever, --concurrency N (providers at once, default 4),
// --shots (keep a screenshot of each filled form), --out DIR (default artifacts/browser-eval/<label>).
// The sample is `provider,url` lines, a read-only export of open postings (docs/architect/specs/BROWSER-COVERAGE.md has
// the query). Output: results.jsonl (one line per posting), summary.json, summary.md. Nothing here is committed: artifacts/
// is gitignored. It never submits: see eval-lib.cjs.
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./eval-lib.cjs");

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.sample) { console.error("USAGE: node scripts/browser-eval/run.cjs --sample <provider,url csv> [--label L] [--max-per-provider 20] [--providers a,b] [--concurrency 4] [--shots]"); process.exit(2); }
  const label = String(o.label || new Date().toISOString().slice(0, 10)).replace(/[^A-Za-z0-9._-]/g, "-");
  const out = path.resolve(o.out || path.join("artifacts", "browser-eval", label));
  fs.mkdirSync(out, { recursive: true });
  const items = lib.readSample(fs.readFileSync(o.sample, "utf8"), { max: o["max-per-provider"], providers: o.providers ? String(o.providers).split(",") : null });
  if (!items.length) { console.error("no provider,url lines in the sample"); process.exit(2); }
  let pw;
  for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const browser = await pw.chromium.launch({ headless: true, ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const probe = await browser.newPage();
  const userAgent = `${(await probe.evaluate(() => navigator.userAgent))} ${lib.UA_TOKEN}`;
  await probe.close();
  const pacer = lib.createPacer({ gapMs: 1000 });
  const robotsCache = new Map();
  const resumePath = lib.syntheticResume(path.join(out, "resume"));
  const started = new Date().toISOString();
  const sink = fs.createWriteStream(path.join(out, "results.jsonl"));
  const results = [];
  // One queue per provider, run in turn inside it; providers in parallel. The pacer holds every host to 1 request a second.
  const queues = new Map();
  for (const it of items) { if (!queues.has(it.provider)) queues.set(it.provider, []); queues.get(it.provider).push(it); }
  const provs = [...queues.keys()];
  const conc = Math.max(1, Math.min(Number(o.concurrency) || 4, 11));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, provs.length) }, async () => {
    while (next < provs.length) {
      const prov = provs[next++];
      for (const it of queues.get(prov)) {
        const r = await lib.evalPosting(browser, it, { pacer, robotsCache, resumePath, userAgent, shotDir: o.shots ? path.join(out, "shots") : null });
        results.push(r); sink.write(JSON.stringify(r) + "\n");
        console.log(`${prov} ${it.n}/${queues.get(prov).length} ${r.form_found ? "form" : "no-form"} q=${r.questions} unans=${r.required_unanswerable.length} walls=${r.walls.join(",") || "-"} ${r.error || ""} ${(r.ms / 1000).toFixed(1)}s`);
      }
    }
  }));
  sink.end();
  await browser.close();
  const rows = lib.summarize(results);
  const meta = { label, started, finished: new Date().toISOString(), sample: path.basename(o.sample), postings: results.length };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ meta, rows }, null, 1));
  fs.writeFileSync(path.join(out, "summary.md"), lib.markdown(rows, meta));
  process.stdout.write("\n" + lib.markdown(rows, meta));
  if (results.some((r) => r.submit_clicked)) { console.error("INVARIANT BROKEN: a submit was clicked"); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
