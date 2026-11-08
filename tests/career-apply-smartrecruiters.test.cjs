"use strict";
// R9 (2026-11-07): SmartRecruiters form filling (workers/career-browser/ats-fill.cjs), the same way as Greenhouse, Lever and
// Ashby: the synthetic SmartRecruiters fixture (tests/fixtures/apply-dryrun/smartrecruiters-acme.html: every question inside a
// web component's open shadow root, as SmartRecruiters ships its form) is filled in a local Chromium from confirmed facts and
// the person's answers, read back, and stopped before Submit; nothing is posted. Without the answers, every screening question
// and the consent are handed back by name, never guessed; self-identification is filled only from the person's "decline".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { factValue, decide } = require("../workers/career-browser/ats-fill.cjs");
const { dryRunForm } = require("../workers/career-browser/dry-run.cjs");
const cases = require("./fixtures/apply-dryrun/cases.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SR = cases.interactive.find((c) => c.id === "smartrecruiters-acme");

test("SmartRecruiters asks for the email twice: the confirmation box takes the same confirmed address, nothing else", () => {
  const f = { email: "casey@example.invalid" };
  for (const l of ["Confirm your email", "Re-enter email", "Retype your email address", "Confirm email"]) assert.equal(factValue(l, f), "casey@example.invalid", l);
  assert.equal(factValue("Confirm your email", {}), undefined, "no address on file: not made up");
  assert.equal(factValue("Email of the person who referred you", f), undefined);
  assert.equal(decide({ kind: "text", label: "Message to the Hiring Team", required: false }, { facts: f, answers: {} }).status, "skip", "an optional free note stays blank");
});

test("SmartRecruiters: filled and read back inside the components' shadow roots, stopped before Submit; asked when unanswered", { skip, timeout: 120000 }, async () => {
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(req.url); return res.writeHead(200).end("posted"); }
    return req.url.split("?")[0] === "/smartrecruiters-acme" ? res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun", SR.file))) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sr-dryrun-"));
  const resumePath = path.join(out, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4 SYNTHETIC TEST RESUME\n");
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  try {
    const url = `http://127.0.0.1:${server.address().port}/smartrecruiters-acme`;
    const run = (id, facts, answers) => dryRunForm({ browser, id, ats: "smartrecruiters", url, facts, answers, resumePath, outDir: out });
    const full = await run("sr.full", cases.facts, SR.answers);
    const at = (l) => full.field_map.find((m) => norm(m.label) === norm(l));
    assert.equal(full.outcome, "ready", JSON.stringify(full.needs_you));
    for (const l of SR.must_fill) assert.equal((at(l) || {}).status, "filled", `${l}: ${JSON.stringify(at(l))}`);
    for (const [l, want] of Object.entries(SR.expect_selected)) assert.deepEqual(at(l).selected, want, l);
    assert.equal(full.field_map.filter((m) => m.kind === "file" && m.status === "filled").length, 1, "only the resume gets the resume");
    assert.equal((at("Message to the Hiring Team") || {}).status, "skipped");
    for (const m of full.field_map.filter((x) => x.eeo)) assert.notEqual(m.status, "filled", `${m.label}: no decline policy, left blank`);
    const bare = await run("sr.bare", cases.facts, {});
    assert.equal(bare.outcome, "needs_you");
    for (const l of SR.must_ask) assert.ok(bare.needs_you.some((n) => norm(n.label) === norm(l)), `asked: ${l}`);
    for (const l of SR.must_ask) assert.notEqual((bare.field_map.find((m) => norm(m.label) === norm(l)) || {}).status, "filled", `never guessed: ${l}`);
    const eeo = await run("sr.eeo", { ...cases.facts, eeo_policy: "decline" }, SR.answers);
    for (const [l, want] of Object.entries(SR.expect_eeo_decline)) assert.deepEqual((eeo.field_map.find((m) => norm(m.label) === norm(l)) || {}).selected, want, l);
    for (const l of [full, bare, eeo]) { assert.equal(l.submit_clicked, false); assert.equal(l.nothing_sent, true); assert.ok(!l.requests_blocked.some((r) => !r.startsWith("GET")), "no request but GET"); }
    assert.equal(posts.length, 0, "nothing reached the server but GETs");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(out, { recursive: true, force: true });
  }
});
