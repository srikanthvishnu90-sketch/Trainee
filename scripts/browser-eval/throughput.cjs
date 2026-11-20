#!/usr/bin/env node
"use strict";
// Applications per minute of ONE runner process (parallel-apply.cjs runPool, the apply VM's engine) on the local mock employer
// (tests/fixtures/mock-ats-server.cjs, 127.0.0.1 only; every submit goes to the mock, nothing leaves this machine). Per
// concurrency level: apps/min, p50/p95 per application, and where the time goes (load, fill, the guarded gaps before Continue
// and Submit, the submit itself), so a serial wait of the runner's own shows up as time no concurrency removes.
//   node scripts/browser-eval/throughput.cjs [--n 48] [--levels 1,4,8,16] [--latency-ms 0] [--settle-ms 2000] [--json out.json]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAts } = require("../../tests/fixtures/mock-ats-server.cjs");
const { runPool, payloadHash, sha256 } = require("../../workers/career-browser/parallel-apply.cjs");

const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const facts = { first_name: "Test", last_name: "Person", email: "test.person@example.invalid", phone: "555-0100" };
const answers = { "Are you legally authorized to work in the United States?": "Yes", "Will you now or in the future require sponsorship for employment visa status?": "No" };

async function measure(browser, mock, { n, concurrency, latencyMs, settleMs, resume, rsha, tag }) {
  const payloads = Array.from({ length: n }, (_, i) => {
    const ats = i % 2 ? "lever" : "greenhouse";
    const p = { id: `${tag}-${i}`, ats, url: `${mock.base}/${ats}/${tag}-${i}${latencyMs ? `?latency=${latencyMs}` : ""}`, facts, answers, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { approval_id: `t-${p.id}`, hash: payloadHash(p) };
    return p;
  });
  const cpu0 = process.cpuUsage();
  const { results, wallMs } = await runPool(browser, payloads, { concurrency, retries: 0, checkSettleMs: settleMs });
  const cpu = process.cpuUsage(cpu0);
  const ok = results.filter((r) => r.status === "submitted_page_confirmed");
  const t = (k) => ok.map((r) => (r.timing || {})[k] || 0);
  return { concurrency, n, submitted: ok.length, other: [...new Set(results.filter((r) => r.status !== "submitted_page_confirmed").map((r) => `${r.status}:${r.reason}`))],
    wall_s: +(wallMs / 1000).toFixed(1), apps_per_min: +((ok.length / wallMs) * 60000).toFixed(1),
    per_app_ms: { p50: q(ok.map((r) => r.ms), 0.5), p95: q(ok.map((r) => r.ms), 0.95) },
    phase_p50_ms: { load: q(t("load"), 0.5), fill: q(t("fill"), 0.5), guard: q(t("guard"), 0.5), submit: q(t("submit"), 0.5) },
    node_cpu_s: +((cpu.user + cpu.system) / 1e6).toFixed(1) };
}

async function main() {
  let pw; for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const n = Number(arg("n", 48)), levels = String(arg("levels", "1,4,8,16")).split(",").map(Number), latencyMs = Number(arg("latency-ms", 0));
  const settleMs = arg("settle-ms", undefined) === undefined ? undefined : Number(arg("settle-ms"));
  const resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tp-")), "test-person-resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\n% TEST resume\n");
  const rsha = sha256(fs.readFileSync(resume));
  const mock = await startMockAts();
  const browser = await pw.chromium.launch({ headless: true });
  const out = { host: { cpus: os.cpus().length, mem_gb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version }, latency_ms: latencyMs, settle_ms: settleMs ?? "default", levels: [] };
  try {
    for (const c of levels) {
      const r = await measure(browser, mock, { n, concurrency: c, latencyMs, settleMs, resume, rsha, tag: `c${c}` });
      out.levels.push(r);
      console.log(`THROUGHPUT | c=${c} | ${r.submitted}/${n} submitted (mock) | ${r.apps_per_min} apps/min | p50 ${r.per_app_ms.p50} ms p95 ${r.per_app_ms.p95} ms | load ${r.phase_p50_ms.load} fill ${r.phase_p50_ms.fill} guard ${r.phase_p50_ms.guard} submit ${r.phase_p50_ms.submit} | loadavg ${os.loadavg()[0].toFixed(1)} | wall ${r.wall_s}s${r.other.length ? " | other " + r.other.join(",") : ""}`);
    }
  } finally { await browser.close(); await mock.close(); }
  if (arg("json", "")) fs.writeFileSync(arg("json"), JSON.stringify(out, null, 2));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { measure };
