"use strict";
// x-audit (coordinator ruling 2026-11-10, migration 20261110170000): the approval binds the VALUES of the employer's hidden
// fields, except per-load tokens. Driven through scripts/apply.ts itself: a dry run prints the approval hash the person
// approves; then the approved run (--submit --approved <hash>) loads the page again and:
//   unchanged page                               -> submitted once
//   only the per-load token changed (every load) -> submitted once (tokens are bound by name only)
//   a non-token hidden value changed (source)    -> APPROVED_APPLICATION_CHANGED, nothing sent
// The engine refuses an unsandboxed browser: run as a non-root user.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const root = process.getuid && process.getuid() === 0;
const skip = root ? "the engine needs Chromium's sandbox: run as a non-root user" : false;
let server, base, source = "careers-page", loads = 0;
const receipts = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-values-"));
const page = () => `<!doctype html><h1>TEST role</h1><form method="post" action="/submit" enctype="multipart/form-data">
<input type="hidden" name="authenticity_token" value="tok-${++loads}-${crypto.randomUUID()}">
<input type="hidden" name="source" value="${source}">
<label for="first">First name</label><input name="first_name" id="first" required>
<label for="email">Email</label><input name="email" type="email" id="email" required>
<label for="resume">Resume</label><input type="file" id="resume" name="resume" required>
<button type="submit">Submit application</button></form>`;

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method === "POST") {
      const parts = []; for await (const c of req) parts.push(c);
      const data = await new Response(Buffer.concat(parts), { headers: { "content-type": req.headers["content-type"] } }).formData();
      receipts.push({ source: data.get("source"), first: data.get("first_name") });
      return res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1><p>Application submitted.</p>");
    }
    res.writeHead(200, { "content-type": "text/html" }).end(page());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const answer = (value, i) => ({ value, factId: `TEST-FACT-${i}`, confirmed: true, provenance: "owner stated (TEST)", confirmation_event_id: `evt-TEST-FACT-${i}` });
  fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify({ user_id: "TEST-OWNER", answers: { first_name: answer("Mary Jane", 0), email: answer("synthetic@example.test", 1) } }));
  fs.writeFileSync(path.join(dir, "resume.pdf"), "%PDF-1.4\nSYNTHETIC TEST RESUME\n");
});
after(async () => { if (server) await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

function engine(extra, caseDir, tag) {
  const args = ["run", "-A", path.join(__dirname, "../scripts/apply.ts"), "--url", `${base}/form`, "--facts", path.join(dir, "facts.json"),
    "--resume", path.join(dir, "resume.pdf"), "--state-dir", path.join(caseDir, "state"), "--evidence-dir", path.join(caseDir, `evidence-${tag}`), ...extra];
  return new Promise((res) => {
    const p = spawn(process.env.DENO_BIN || "deno", args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b; }); p.stderr.on("data", (b) => { out += b; });
    const timer = setTimeout(() => p.kill("SIGKILL"), 120000);
    p.on("exit", () => {
      clearTimeout(timer);
      const line = out.split("\n").filter((l) => l.startsWith("RESULT ")).at(-1);
      res({ out, result: line ? JSON.parse(line.slice(7)) : null, approval: /Approval hash: ([0-9a-f]{64})/.exec(out)?.[1] ?? null });
    });
  });
}
async function approveThenRun(change) {
  const caseDir = fs.mkdtempSync(path.join(dir, "case-"));
  source = "careers-page";
  const dry = await engine([], caseDir, "dry");
  assert.ok(dry.approval, `the dry run prints the approval hash: ${dry.out.slice(-400)}`);
  change();
  const n = receipts.length;
  const run = await engine(["--submit", "--approved", dry.approval], caseDir, "run");
  return { run, sent: receipts.slice(n) };
}

test("the approved application, page unchanged: submitted once", { skip }, async () => {
  const { run, sent } = await approveThenRun(() => {});
  assert.equal(sent.length, 1, `one application sent: ${JSON.stringify(run.result)}`);
  assert.equal(sent[0].source, "careers-page");
});

test("only the per-load anti-forgery token changed (it changes on every load): still the approved application, submitted once", { skip }, async () => {
  const { run, sent } = await approveThenRun(() => {}); // the token differs on every load by construction
  assert.equal(sent.length, 1, JSON.stringify(run.result));
});

test("a hidden value the approval binds changed after the yes: APPROVED_APPLICATION_CHANGED, nothing sent", { skip }, async () => {
  const { run, sent } = await approveThenRun(() => { source = "partner-board-x"; });
  assert.equal(sent.length, 0, "nothing sent");
  assert.equal(run.result && run.result.reason, "APPROVED_APPLICATION_CHANGED", JSON.stringify(run.result));
});
