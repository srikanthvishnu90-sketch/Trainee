"use strict";
// Release item 2 (scripts/browser-eval/pool.cjs): the dry-run batch through the production pool, on local fixtures only.
// Every payload gets exactly one result, reaches its Submit at most once, and at that instant each filled field's approved
// value is the payload's own and is what the field holds. A field that holds anything else is counted as a mismatch.
// Run: node --test tests/career-browser-pool.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { pickBatch, fieldMismatch } = require("../scripts/browser-eval/pool.cjs");
const { runPool, payloadHash, sha256, NeedsUser } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

test("pickBatch: round robin over the boards, in file order", () => {
  const items = ["a", "a", "a", "b", "c", "c"].map((provider, i) => ({ provider, url: `u${i}` }));
  assert.deepEqual(pickBatch(items, 5).map((x) => x.url), ["u0", "u3", "u4", "u1", "u5"]);
  assert.equal(pickBatch(items, 60).length, 6);
});

test("fieldMismatch: only the payload's value, held as approved", () => {
  const p = { facts: { first_name: "Casey", phone: "+1 312 555 0100", eeo_policy: "decline" }, answers: { "Years?": "3" }, resume: { path: "/x/resume.pdf" } };
  assert.equal(fieldMismatch({ label: "First Name", source: "fact", kind: "text", approved: "Casey", held: "Casey" }, p), null);
  assert.equal(fieldMismatch({ label: "First Name", source: "fact", kind: "text", approved: "Casey", held: "Casey2" }, p), "holds_other_text");
  assert.equal(fieldMismatch({ label: "First Name", source: "fact", kind: "text", approved: "Kasey", held: "Kasey" }, p), "approved_value_not_in_payload");
  assert.equal(fieldMismatch({ label: "Phone", source: "fact", kind: "text", approved: "+1 312 555 0100", held: "(312) 555-0100" }, p), null);
  assert.equal(fieldMismatch({ label: "Phone", source: "fact", kind: "text", approved: "+1 312 555 0100", held: "(312) 555-0199" }, p), "holds_other_text");
  assert.equal(fieldMismatch({ label: "Years?", source: "answer", kind: "select", approved: "3", held: ["3"] }, p), null);
  assert.equal(fieldMismatch({ label: "Years?", source: "answer", kind: "select", approved: "3", held: ["30"] }, p), "holds_other_option");
  assert.equal(fieldMismatch({ label: "Gender", source: "eeo_policy", kind: "select", approved: "decline", held: ["Decline to self-identify"] }, p), null);
  assert.equal(fieldMismatch({ label: "Gender", source: "eeo_policy", kind: "select", approved: "decline", held: ["Male"] }, p), "holds_other_than_decline");
  assert.equal(fieldMismatch({ label: "Resume", source: "resume", kind: "file", approved: "resume.pdf", held: "resume.pdf" }, p), null);
  assert.equal(fieldMismatch({ label: "Resume", source: "resume", kind: "file", approved: "resume.pdf", held: "", gone: true }, p), "field_gone");
});

const html = (k) => `<!doctype html><html><body><form method="post" action="/submit/${k}">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="ph">Phone</label><input id="ph" type="tel" name="phone">
<label for="g">Gender</label><select id="g" name="g"><option value="">Select...</option><option value="1">Male</option><option value="2">Decline to self-identify</option></select>
<label for="cv">Resume/CV *</label><input id="cv" type="file" name="resume" required>
${k.endsWith("-ask") ? '<label for="w">Why us? *</label><textarea id="w" name="w" required></textarea>' : ""}
<button type="submit">Submit application</button></form></body></html>`;

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { posts.push(req.url); req.resume(); return res.writeHead(200).end("<h1>Thank you for applying</h1>"); }
    return res.writeHead(200, { "content-type": "text/html" }).end(html(req.url.slice(1)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-"));
  resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});

test("a batch through runPool, stopped before every Submit: one result each, none dropped, none twice, every field as approved", { skip, timeout: 120000 }, async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `p${i}${i % 4 === 3 ? "-ask" : ""}`);
  const facts = { first_name: "Casey", phone: "+1 312 555 0100", eeo_policy: "decline" };
  const payloads = ids.map((k) => { const p = { id: k, ats: "greenhouse", url: `${base}/${k}`, facts, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "a-" + k, hash: payloadHash(p) }; return p; });
  const reached = new Map(), audits = new Map();
  const onPhase = async (phase, audit) => { reached.set(audit.id, (reached.get(audit.id) || 0) + 1); audits.set(audit.id, audit.fields); throw new NeedsUser("strict_reached_submit"); };
  const { results } = await runPool(browser, payloads, { concurrency: 3, retries: 0, stepTimeoutMs: 8000, onPhase, audit: true });
  assert.equal(posts.length, 0, "nothing posted");
  assert.deepEqual(results.map((r) => r.id), ids, "one result per payload, in order");
  for (const r of results) {
    if (r.id.endsWith("-ask")) { assert.equal(r.reason, "missing_required_answer"); assert.equal(reached.get(r.id), undefined); continue; }
    assert.equal(r.reason, "strict_reached_submit", JSON.stringify(r));
    assert.equal(reached.get(r.id), 1);
    const fields = audits.get(r.id);
    assert.deepEqual(fields.map((f) => f.label).sort(), ["First Name", "Gender", "Phone", "Resume/CV"].sort());
    const p = payloads.find((x) => x.id === r.id);
    assert.deepEqual(fields.map((f) => fieldMismatch(f, p)).filter(Boolean), []);
  }
});
