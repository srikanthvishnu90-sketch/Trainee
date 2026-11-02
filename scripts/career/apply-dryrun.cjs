#!/usr/bin/env node
"use strict";
// Dry-run harness for the apply path: serves local ATS form fixtures (hand-built interactive ones for Greenhouse, Lever and
// Ashby, plus the captured real forms in tests/fixtures/forms-ci with scripts removed), fills each in a local Playwright
// Chromium with the worker's own fill code, STOPS before Submit, and writes one attempt log per run (field map, screenshot,
// reason). Nothing is sent anywhere. Usage: node scripts/career/apply-dryrun.cjs [--out DIR]
// Per fixture it runs scenarios:
//   full      confirmed facts + answers: every required question must be filled and read back (outcome ready)
//   bare      facts only: every required custom question must come back as needs_you; no custom field may be filled
//   eeo       full + facts.eeo_policy "decline": self-identification questions take the decline option, not a guess
//   synth     (captured forms) answers made up from the form's own questions, to exercise the fill mechanics on real markup
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { dryRunForm } = require("../../workers/career-browser/dry-run.cjs");
const cases = require("../../tests/fixtures/apply-dryrun/cases.cjs");

const FX = path.join(__dirname, "../../tests/fixtures/apply-dryrun");
const CI = path.join(__dirname, "../../tests/fixtures/forms-ci");
const strip = (h) => h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "").replace(/\s(src|srcset)="https?:[^"]*"/gi, "");
const HARD = /^(readback_mismatch|fill_error|still_empty_after_fill|upload_not_accepted|driver_error)/;
const ASKABLE = ["options_not_readable", "agreement_needs_you", "no_matching_option", "ambiguous_option", "upload_needs_you", "eeo_needs_your_choice", "no_confirmed_answer", "not_agreed", "answer_not_a_number", "label_on_form_twice"];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function loadPlaywright() {
  for (const p of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { return require(p); } catch { /* next */ } }
  throw new Error("playwright is not installed");
}

async function runAll({ outDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-dryrun-")), onlyInteractive = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(CI, "manifest.json"), "utf8"));
  const captured = manifest.forms.filter((f) => f.status === "application" && f.html);
  const submits = [];
  const server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (req.method === "POST") { submits.push(u); return res.writeHead(200).end("posted"); }
    if (u === "/widgets.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(path.join(FX, "widgets.js")));
    const fx = cases.interactive.find((c) => "/" + c.id === u);
    if (fx) return res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(path.join(FX, fx.file)));
    const cf = captured.find((f) => "/" + f.id === u);
    if (cf) return res.writeHead(200, { "content-type": "text/html" }).end(strip(fs.readFileSync(path.join(CI, cf.html), "utf8")) + '<script src="/widgets.js"></script>'); // the shim stands in for the site script that was removed (yes/no toggles); test-only
    res.writeHead(404).end("nf");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(outDir, { recursive: true });
  const resumePath = path.join(outDir, "synthetic-resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4 SYNTHETIC TEST RESUME\n");
  const browser = await loadPlaywright().chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const results = [];
  const run = (id, ats, scenario, facts, answers) => dryRunForm({ browser, id: `${id}.${scenario}`, ats, url: `${base}/${id}`, facts, answers, resumePath, outDir });
  try {
    for (const c of cases.interactive) {
      const full = await run(c.id, c.ats, "full", cases.facts, c.answers);
      const bare = await run(c.id, c.ats, "bare", cases.facts, {});
      const eeo = await run(c.id, c.ats, "eeo", { ...cases.facts, eeo_policy: "decline" }, c.answers);
      const filled = (l) => full.field_map.some((m) => norm(m.label) === norm(l) && m.status === "filled");
      const checks = {
        full_ready: full.outcome === "ready",
        full_all_must_fill: c.must_fill.every(filled),
        full_choices_exact: Object.entries(c.expect_selected).every(([l, want]) => JSON.stringify((full.field_map.find((m) => norm(m.label) === norm(l)) || {}).selected) === JSON.stringify(want)),
        eeo_decline_exact: Object.entries(c.expect_eeo_decline).every(([l, want]) => JSON.stringify((eeo.field_map.find((m) => norm(m.label) === norm(l)) || {}).selected) === JSON.stringify(want)),
        bare_asks: bare.outcome === "needs_you" && c.must_ask.every((l) => bare.needs_you.some((n) => norm(n.label) === norm(l))),
        bare_no_guess: !bare.field_map.some((m) => c.must_ask.some((l) => norm(l) === norm(m.label)) && m.status === "filled"),
        eeo_without_policy_left_blank: full.field_map.filter((m) => m.eeo).every((m) => m.status !== "filled" || m.source === "answer"),
        eeo_decline_filled: eeo.field_map.filter((m) => m.eeo).length > 0 && eeo.field_map.filter((m) => m.eeo).every((m) => m.status === "filled" && m.source === "eeo_policy"),
        only_resume_gets_resume: full.field_map.filter((m) => m.kind === "file" && m.status === "filled").length === 1,
        never_clicked_submit: [full, bare, eeo].every((l) => l.submit_clicked === false && l.nothing_sent === true && !l.requests_blocked.some((r) => !r.startsWith("GET"))),
      };
      results.push({ id: c.id, ats: c.ats, class: "interactive", checks, pass: Object.values(checks).every(Boolean), outcomes: { full: full.outcome, bare: bare.outcome, eeo: eeo.outcome }, bot_check: full.bot_check, logs: [full, bare, eeo].map((l) => l.id + ".attempt.json") });
    }
    if (!onlyInteractive) {
      for (const f of captured) {
        const bare = await run(f.id, f.family, "bare", cases.facts, {});
        // Answers made up from the form's own questions (test data only), to drive every control on the real markup. Up to three
        // rounds: a question whose options only show once asked (a dropdown) gets its first listed option the next round.
        const synth = {};
        let second = bare, prev = bare;
        for (let round = 0; round < 3; round++) {
          for (const n of prev.needs_you) if (!(n.label in synth) || (n.options && n.options.length)) synth[n.label] = n.options && n.options.length ? n.options[0] : n.reason === "answer_not_a_number" ? "2024" : "Synthetic answer";
          second = await run(f.id, f.family, "synth", cases.facts, synth);
          if (!second.needs_you.some((n) => (n.options && n.options.length && synth[n.label] !== n.options[0]) || (n.reason === "answer_not_a_number" && synth[n.label] !== "2024"))) break;
          prev = second;
        }
        const hard = (l) => [...l.needs_you, ...l.failed_fields].filter((n) => HARD.test(n.reason));
        const checks = {
          bare_no_hard_failure: bare.outcome !== "failed" && !hard(bare).length,
          synth_no_hard_failure: second.outcome !== "failed" && !hard(second).length,
          // What is left is a question the capture cannot show (a dropdown whose options were not saved) or a consent: asked, not guessed.
          leftovers_are_asked: second.needs_you.every((n) => ASKABLE.includes(n.reason)),
          resume_only_once: second.field_map.filter((m) => m.kind === "file" && m.status === "filled").length <= 1,
          never_clicked_submit: [bare, second].every((l) => l.submit_clicked === false && !l.requests_blocked.some((r) => !r.startsWith("GET"))),
        };
        results.push({ id: f.id, ats: f.family, class: "captured", checks, pass: Object.values(checks).every(Boolean), outcomes: { bare: bare.outcome, synth: second.outcome }, bot_check: second.bot_check, left: second.needs_you.map((n) => n.reason), why: second.reason, logs: [bare.id + ".attempt.json", second.id + ".attempt.json"] });
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  const byAts = {};
  for (const r of results) { const a = (byAts[r.ats] ||= { pass: 0, total: 0 }); a.total++; if (r.pass) a.pass++; }
  const summary = { dry_run: true, nothing_sent: true, server_saw_post_requests: submits.length, by_ats: byAts, results, outDir };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  return summary;
}

module.exports = { runAll };
if (require.main === module) {
  const i = process.argv.indexOf("--out");
  runAll(i > 0 ? { outDir: path.resolve(process.argv[i + 1]) } : {}).then((s) => {
    for (const r of s.results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.ats.padEnd(10)} ${r.class.padEnd(11)} ${r.id}${r.pass ? "" : "  " + Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(",")}`);
    for (const [a, v] of Object.entries(s.by_ats)) console.log(`${a}: ${v.pass}/${v.total}`);
    console.log(`logs: ${s.outDir}  posts seen by server: ${s.server_saw_post_requests}`);
    process.exit(Object.values(s.by_ats).every((v) => v.pass === v.total) ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(2); });
}
