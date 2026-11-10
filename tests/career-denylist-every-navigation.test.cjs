"use strict";
// x-audit (2026-11-10): the LinkedIn / Indeed / Handshake denylist holds on EVERY navigation and redirect of the apply
// runner (workers/career-browser/parallel-apply.cjs), not only the first main-frame load. Counted, not assumed:
//  1. the denylist lists every host the other runners refuse (apply-vm.cjs REFUSED, apply-scheduler.cjs NEVER_HOSTS);
//  2. a frame inside the form page that points at linkedin.com is never loaded (0 requests reach the denied host);
//  3. a form post that the employer answers with a 303 to linkedin.com is not followed (0 requests reach it).
// Test only: everything listens on 127.0.0.1, nothing leaves the machine.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256, urlVerdict, DENY_HOST_RULES, denyLaunchOptions } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try { pw = require(id); break; } catch { /* next */ }
}
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const DENIED = ["linkedin.com", "www.linkedin.com", "uk.linkedin.com", "lnkd.in", "indeed.com", "uk.indeed.com",
  "joinhandshake.com", "app.joinhandshake.com", "handshake.com"];

test("the runner's denylist refuses every host the VM and the scheduler refuse, even when allow-listed", () => {
  const misses = [];
  for (const h of [...DENIED, "WWW.LINKEDIN.COM.", "Lnkd.In"]) {
    const v = urlVerdict(`https://${h}/jobs/view/1`, [h, h.toLowerCase().replace(/\.$/, "")]);
    if (v.ok || v.reason !== "host_denied") misses.push(`${h}: ${v.ok ? "ok" : v.reason}`);
  }
  assert.deepEqual(misses, [], `hosts not refused as host_denied: ${misses.join(", ")}`);
});

// --- browser scenarios ---------------------------------------------------------------------------------------------
// The browser is launched the way the apply VM launches it (denyLaunchOptions(): a denied host does not resolve), with one
// safety rule after it: any denied name those rules miss resolves to a closed port on 127.0.0.1, so nothing ever leaves
// the machine. Counted per request to a denied host: refused by the runner (ERR_BLOCKED_BY_CLIENT), never resolved
// (ERR_NAME_NOT_RESOLVED), or sent. Only "sent" fails, and a connection refused at the safety port counts as sent.
let browser, employer, resume, rsha;
const form = (extra, action) => `<!doctype html><html><head><title>Mock employer</title></head><body><h1>Engineer</h1>
<form method="post" action="${action}" enctype="multipart/form-data">
<label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
${extra}<button type="submit">Submit Application</button></form></body></html>`;

before(async () => {
  if (skip) return;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deny-")), "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\n% TEST resume\n");
  rsha = sha256(fs.readFileSync(resume));
  employer = await new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const u = new URL(req.url, "http://x");
      rsp.setHeader("content-type", "text/html");
      if (req.method === "POST") {
        req.resume();
        return req.on("end", () => {
          if (u.pathname === "/greenhouse/redirect/submit") { rsp.writeHead(303, { location: "https://www.linkedin.com/feed/" }); return rsp.end(); }
          rsp.end("<h1 id=confirmation>Thank you for applying</h1>");
        });
      }
      if (u.pathname === "/greenhouse/iframe") return rsp.end(form(`<iframe src="https://www.linkedin.com/embed/badge" width="300" height="80"></iframe>`, "/greenhouse/iframe/submit"));
      if (u.pathname === "/greenhouse/redirect") return rsp.end(form("", "/greenhouse/redirect/submit"));
      rsp.statusCode = 404; rsp.end("no");
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
  const safety = ["linkedin.com", "*.linkedin.com", "lnkd.in", "indeed.com", "*.indeed.com", "joinhandshake.com", "*.joinhandshake.com", "handshake.com", "*.handshake.com"]
    .map((h) => `MAP ${h} 127.0.0.1:9`).join(", ");
  // Launched as the apply VM launches it; the safety rule goes after the denied rules (Chromium takes the first match).
  const o = denyLaunchOptions({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  o.args = o.args.map((a) => (a.startsWith("--host-resolver-rules=") ? `--host-resolver-rules=${DENY_HOST_RULES}, ${safety}` : a));
  browser = await pw.chromium.launch(o);
});
after(async () => { if (browser) await browser.close(); if (employer) employer.close(); });

async function run(job) {
  const p = { id: job, ats: "greenhouse", url: `http://127.0.0.1:${employer.address().port}/greenhouse/${job}`,
    facts: { first_name: "Test", last_name: "Person", email: "test.person@example.invalid" }, answers: {},
    resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: `appr-${job}`, hash: payloadHash(p) };
  const tried = [], stopped = [], held = [];
  const orig = browser.newContext;
  browser.newContext = async (o) => {
    const ctx = await orig.call(browser, o);
    ctx.on("request", (r) => { if (urlVerdict(r.url()).reason === "host_denied") tried.push(r.url()); });
    ctx.on("requestfailed", (r) => {
      const why = r.failure()?.errorText || "";
      if (/BLOCKED_BY_CLIENT/i.test(why)) held.push(r.url());
      else if (/NAME_NOT_RESOLVED/i.test(why)) stopped.push(r.url());
    });
    return ctx;
  };
  try {
    const out = await applyOne(browser, p, { allowHosts: [], retries: 0, stepTimeoutMs: 8000 });
    return { out, sent: tried.filter((u) => !held.includes(u) && !stopped.includes(u)), byRunner: tried.filter((u) => held.includes(u)) };
  } finally { browser.newContext = orig; }
}

test("a frame inside the form page that points at linkedin.com is refused by the runner itself", { skip }, async () => {
  const { sent, byRunner } = await run("iframe");
  assert.deepEqual(sent, [], `requests to a denied host left the browser: ${sent.join(", ")}`);
  // Not only the launch flag: a runner launched without denyLaunchOptions() (approve-first.ts, a test) still refuses it.
  assert.deepEqual(byRunner, ["https://www.linkedin.com/embed/badge"]);
});

test("a form post the employer answers with a 303 to linkedin.com is not followed, and is not a confirmed submission", { skip }, async () => {
  const { out, sent } = await run("redirect");
  assert.deepEqual(sent, [], `requests to a denied host left the browser: ${sent.join(", ")}`);
  assert.notEqual(out.status, "submitted_page_confirmed");
});

test("the apply VM launches Chromium with denyLaunchOptions()", () => {
  const src = fs.readFileSync(path.join(__dirname, "../workers/career-browser/apply-vm-main.cjs"), "utf8");
  assert.match(src, /chromium\.launch\(denyLaunchOptions\(\{/);
});
