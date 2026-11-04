"use strict";
// Demo: 5 applications in parallel (3 Greenhouse-style, 2 Lever-style) plus a serial baseline, against the LOCAL mock
// employer (tests/fixtures/mock-ats-server.cjs). Writes screenshots and a summary into OUT (default ./apply-proof).
//   node scripts/career/parallel-apply-demo.cjs [OUT_DIR]
// Uses the preinstalled Playwright/Chromium (UPMORE_PLAYWRIGHT_PATH / UPMORE_CHROMIUM_PATH); downloads nothing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockAts } = require("../../tests/fixtures/mock-ats-server.cjs");
const { runPool, payloadHash, sha256 } = require("../../workers/career-browser/parallel-apply.cjs");

const out = path.resolve(process.argv[2] || "apply-proof");
fs.mkdirSync(out, { recursive: true });
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");

// TEST persona only: not a real person; the resume is a stand-in file.
const resumePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apply-demo-")), "test-person-resume.pdf");
fs.writeFileSync(resumePath, "%PDF-1.4\n% TEST resume, not a real person\n");
const rsha = sha256(fs.readFileSync(resumePath));
const facts = { first_name: "Test", last_name: "Person", email: "test.person@example.invalid", phone: "555-0100", linkedin_url: "https://example.invalid/in/test-person" };
const answers = { "Are you legally authorized to work in the United States?": "Yes", "Will you now or in the future require sponsorship for employment visa status?": "No" };

function build(base, specs) {
  return specs.map(([ats, job, latency]) => {
    const p = { id: `${ats}-${job}`, ats, url: `${base}/${ats}/${job}?latency=${latency}`, facts, answers, resume: { path: resumePath, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { payloadHash: payloadHash(p) };
    return p;
  });
}

(async () => {
  const ats = await startMockAts();
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" ? true : false,
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const specs = [["greenhouse", "gh1", 400], ["greenhouse", "flaky-gh2", 400], ["lever", "lv1", 400], ["lever", "lv2", 400], ["greenhouse", "gh3", 400]];
  const serialSpecs = specs.map(([a, j, l]) => [a, `s-${j}`.replace("s-flaky-", "flaky-s-"), l]);
  const run = runPool;
  const serial = await run(browser, build(ats.base, serialSpecs), { concurrency: 1, shotDir: null });
  const par = await run(browser, build(ats.base, specs), { concurrency: 5, shotDir: out });
  await browser.close();
  const rows = par.results.map((r) => ({ id: r.id, status: r.status, attempts: r.attempts, ms: r.ms, fill_ms: r.timing && r.timing.fill, submit_ms: r.timing && r.timing.submit, confirmation: r.confirmation }));
  const summary = { concurrency: 5, parallel_wall_ms: par.wallMs, serial_wall_ms: serial.wallMs, per_application: rows, mock_received: ats.submissions.length };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  const ctxBrowser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const pg = await ctxBrowser.newPage({ viewport: { width: 900, height: 520 } });
  const tr = rows.map((r) => `<tr><td>${r.id}</td><td>${r.status}</td><td>${r.attempts}</td><td>${r.fill_ms ?? ""}</td><td>${r.submit_ms ?? ""}</td><td><b>${r.ms}</b></td><td>${r.confirmation ?? ""}</td></tr>`).join("");
  await pg.setContent(`<body style="font:14px system-ui;margin:24px"><h2>5 applications in parallel, local mock Greenhouse/Lever (test fixtures)</h2>
  <table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>application</th><th>status</th><th>attempts</th><th>fill ms</th><th>submit ms</th><th>total ms</th><th>confirmation</th></tr>${tr}</table>
  <p><b>Parallel wall time: ${par.wallMs} ms</b> (5 at once). Serial baseline for the same 5: ${serial.wallMs} ms. Mock employer received ${ats.submissions.length} submissions (5 parallel + 5 serial).</p>
  <p>Each mock page adds 400 ms of employer latency on load and on submit. flaky-gh2 answered 503 once and was retried (attempts=2).</p></body>`);
  await pg.screenshot({ path: path.join(out, "parallel-summary.png") });
  await ctxBrowser.close();
  await ats.close();
})().catch((e) => { console.error(e); process.exit(1); });
