"use strict";
// x-audit (D-MS-1, coordinator priority, 2026-11-10): no value typed into an employer's form reaches the employer before
// the person's yes. Ashby autosaves every field with an ApiSetFormValue GraphQL mutation as it is typed; a form can do the
// same with a fetch POST, a beacon or a WebSocket. tests/fixtures/autosave-ats.cjs does all four (and a GET pixel) and
// counts what arrives. Measured per path that opens or fills a form before the yes: receipts that carry a typed value on
// ANY channel, GET included (coordinator ruling, 2026-11-10). The bar is 0.
//   control   a browser with no guard fills the form: every channel arrives (proves the mock autosaves).
//   engine    scripts/apply.ts without --submit: the dry run every preparation runs (approve-first.ts prepare,
//             prepare-ahead.ts prepareOne, workers/career-cloud/prepare.ts, the cloud engine's review step).
//   harness   workers/career-browser/dry-run.cjs (scripts/career/apply-dryrun.cjs).
//   after yes workers/career-browser/parallel-apply.cjs stopped midway (a required question with no confirmed answer):
//             whatever the form autosaved is only the approved values.
// The engine refuses an unsandboxed browser: run as a non-root user.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startAutosaveAts } = require("./fixtures/autosave-ats.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try { pw = require(id); break; } catch { /* next */ }
}
const root = process.getuid && process.getuid() === 0;
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const FACTS = { first_name: "Marigold", last_name: "Testperson", email: "marigold.autosave@example.test" };
const TYPED = Object.values(FACTS);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autosave-"));
const resume = path.join(dir, "resume.pdf");
fs.writeFileSync(resume, "%PDF-1.4\n% TEST resume\n");
let browser;
before(async () => { if (!skip) browser = await pw.chromium.launch({ headless: true, chromiumSandbox: !root && process.env.UPMORE_CHROMIUM_SANDBOX !== "off" }); });
after(async () => { if (browser) await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const settle = () => new Promise((r) => setTimeout(r, 1500));

test("control: a browser with no guard sends the typed values on every autosave channel", { skip }, async () => {
  const ats = await startAutosaveAts({ typed: TYPED });
  try {
    const page = await browser.newPage();
    await page.goto(`${ats.base}/form`);
    await page.waitForTimeout(300); // the socket opens
    for (const [k, v] of Object.entries(FACTS)) await page.fill(`#${k}`, v);
    await settle();
    await page.close();
    const ch = ats.byChannel();
    for (const c of ["graphql_mutation", "fetch_post", "beacon", "websocket", "get_pixel"]) assert.ok(ch[c] > 0, `the mock autosaves over ${c}: ${JSON.stringify(ch)}`);
  } finally { await ats.close(); }
});

test("engine dry run (scripts/apply.ts, no --submit): 0 typed values reach the employer before the yes", { skip: skip || (root ? "the engine needs Chromium's sandbox: run as a non-root user" : false) }, async () => {
  const ats = await startAutosaveAts({ typed: TYPED });
  try {
    const facts = { user_id: "TEST-OWNER", answers: Object.fromEntries(Object.entries(FACTS).map(([key, value], i) => [key, { value, factId: `TEST-FACT-${i}`, confirmed: true, provenance: "owner stated (TEST)", confirmation_event_id: `evt-TEST-FACT-${i}` }])) };
    const factsPath = path.join(dir, "facts.json");
    fs.writeFileSync(factsPath, JSON.stringify(facts));
    const args = ["run", "-A", path.join(__dirname, "../scripts/apply.ts"), "--url", `${ats.base}/form`, "--facts", factsPath, "--resume", resume,
      "--state-dir", path.join(dir, "state"), "--evidence-dir", path.join(dir, "evidence")];
    const out = await new Promise((res) => {
      const p = spawn(process.env.DENO_BIN || "deno", args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let o = "";
      p.stdout.on("data", (b) => { o += b; }); p.stderr.on("data", (b) => { o += b; });
      const timer = setTimeout(() => p.kill("SIGKILL"), 120000);
      p.on("exit", () => { clearTimeout(timer); res(o); });
    });
    await settle();
    const result = out.split("\n").filter((l) => l.startsWith("RESULT ")).at(-1);
    assert.ok(result && /"dry_run"/.test(result), `the dry run reached review: ${(result || out).slice(-400)}`);
    console.log(`ENGINE receipts carrying a typed value, by channel: ${JSON.stringify(ats.byChannel())}`);
    assert.deepEqual(ats.anyChannel().map((r) => r.channel), [], `typed values reached the employer before the yes: ${JSON.stringify(ats.byChannel())}`);
  } finally { await ats.close(); }
});

test("dry-run harness (workers/career-browser/dry-run.cjs): 0 typed values reach the employer", { skip }, async () => {
  const { dryRunForm } = require("../workers/career-browser/dry-run.cjs");
  const ats = await startAutosaveAts({ typed: TYPED });
  try {
    const log = await dryRunForm({ browser, id: "autosave", ats: "greenhouse", url: `${ats.base}/form`, facts: FACTS, answers: {}, resumePath: resume, outDir: path.join(dir, "harness") });
    await settle();
    assert.ok(log.field_map.length >= 3, "the form was filled");
    assert.deepEqual(ats.anyChannel().map((r) => r.channel), [], `typed values reached the employer: ${JSON.stringify(ats.byChannel())}`);
  } finally { await ats.close(); }
});

test("after the yes, a run stopped midway leaves only approved values on the employer's side", { skip }, async () => {
  const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");
  const ats = await startAutosaveAts({ typed: TYPED });
  try {
    const rsha = sha256(fs.readFileSync(resume));
    // The approved payload has no answer for a required question the page asks: the run stops before Submit.
    const p = { id: "after-yes", ats: "greenhouse", url: `${ats.base}/greenhouse/stop`, facts: { first_name: FACTS.first_name, email: FACTS.email }, answers: {},
      resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
    p.approval = { approval_id: "appr-after-yes", hash: payloadHash(p) };
    const out = await applyOne(browser, p, { allowHosts: [], retries: 0, stepTimeoutMs: 8000 });
    await settle();
    assert.notEqual(out.status, "submitted_page_confirmed", "stopped before Submit");
    const approved = new Set(Object.values(p.facts));
    const autosaved = ats.receipts.filter((r) => r.channel !== "submit" && r.channel !== "get_pixel");
    // The value each autosave carried: JSON's "value" (GraphQL, WebSocket), else the form body's name=value.
    const valueOf = (r) => { const j = /"value":"([^"]*)"/.exec(r.raw); if (j) return j[1]; const f = /\b[a-z_]+=([^&]*)\s*$/.exec(r.raw); return f ? f[1] : null; };
    const foreign = autosaved.filter((r) => { const v = valueOf(r); return v !== null && !approved.has(v.trim()); });
    assert.ok(autosaved.length > 0, "the form autosaved the approved values (the check is not vacuous)");
    assert.equal(ats.receipts.filter((r) => r.channel === "submit").length, 0, "nothing submitted");
    assert.deepEqual(foreign.map((r) => `${r.channel}: ${r.raw.slice(0, 80)}`), [], "every autosaved value is an approved one");
  } finally { await ats.close(); }
});
