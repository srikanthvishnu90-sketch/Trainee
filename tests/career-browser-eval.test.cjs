"use strict";
// WO-M: the real-site dry-run eval (scripts/browser-eval/) against LOCAL pages. Proves the safety rules the eval runs
// under on real sites: nothing but GET/HEAD/OPTIONS ever leaves the browser, no submit is clicked, robots.txt is obeyed,
// a visible captcha / password / emailed-code field stops the posting before anything is typed, at most 1 request a
// second per host, at most 20 postings per provider. Nothing leaves 127.0.0.1.
//   node --test tests/career-browser-eval.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("../scripts/browser-eval/eval-lib.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try { pw = require(id); break; } catch { /* next */ }
}
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const FORM = (extra = "") => `<!doctype html><html><head><title>Job</title></head><body><h1>Engineer</h1>
<form id="application-form" action="/submit" method="post">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="ln">Last Name *</label><input id="ln" name="last_name" required>
<label for="em">Email *</label><input id="em" name="email" type="email" required>
<label for="cv">Resume/CV *</label><input id="cv" name="resume" type="file" required>
<label for="why">Why do you want to work here? *</label><textarea id="why" name="why" required></textarea>
${extra}
<button type="submit" id="submit">Submit application</button></form>
<script>
// A page that tries to send on its own: an autosave POST, a beacon, and a submit on input.
fetch("/autosave", { method: "POST", body: "x" }).catch(() => {});
navigator.sendBeacon && navigator.sendBeacon("/beacon", "y");
document.getElementById("em").addEventListener("change", () => fetch("/track", { method: "PUT", body: "z" }).catch(() => {}));
</script></body></html>`;
const PAGES = {
  "/robots.txt": "User-agent: *\nDisallow: /private\n",
  "/gh/job": FORM(),
  "/hop/job": `<!doctype html><html><body><h1>Engineer</h1><p>About the job.</p><a href="/hop/job/form">Apply for this job</a></body></html>`,
  "/hop/job/form": FORM(),
  "/captcha/job": FORM(`<div class="g-recaptcha" style="width:300px;height:80px"></div>`),
  "/login/job": `<!doctype html><html><body><h1>Sign in</h1><form action="/login" method="post"><label for="u">Email</label><input id="u" name="email"><label for="p">Password</label><input id="p" type="password" name="password"><button type="submit">Sign in</button></form></body></html>`,
  "/code/job": FORM(`<label for="c">Security code</label><input id="c" name="security_code">`),
  "/private/job": FORM(),
};

let server, base, browser, resumePath;
const hits = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    hits.push({ method: req.method, path: req.url.split("?")[0], at: Date.now() });
    const body = PAGES[req.url.split("?")[0]];
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(200); return res.end("RECEIVED"); }
    if (!body) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resumePath = lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "beval-")));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const fast = () => ({ pacer: lib.createPacer({ gapMs: 0 }), robotsCache: new Map(), resumePath, settleMs: 1500, stepTimeoutMs: 8000 });
const run = (p, provider = "greenhouse", o = fast()) => lib.evalPosting(browser, { provider, url: base + p, n: 1 }, o);
const sentToServer = () => hits.filter((h) => h.method !== "GET" && h.method !== "HEAD");

test("a guest form is found, mapped to the schema, filled with the TEST person and the synthetic resume, and nothing is sent", { skip }, async () => {
  const r = await run("/gh/job");
  assert.equal(r.form_found, true);
  assert.equal(r.submit_clicked, false);
  assert.equal(r.questions, 5);
  assert.deepEqual(r.schema, { "fact:first_name": 1, "fact:last_name": 1, "fact:email": 1, resume: 1, custom: 1 });
  assert.equal(r.resume_attached, true);
  assert.equal(r.filled, 4);
  assert.deepEqual(r.required_unanswerable.map((q) => [q.label, q.schema]), [["Why do you want to work here?", "custom"]]);
  assert.ok(r.requests_blocked.some((b) => b.startsWith("POST") && b.includes("/autosave")), JSON.stringify(r.requests_blocked));
  assert.deepEqual(sentToServer(), [], "the server received only GET/HEAD");
});

test("the page's own Apply link is followed to the form; a submit control is never a candidate", { skip }, async () => {
  const r = await run("/hop/job", "bamboohr");
  assert.equal(r.form_found, true);
  assert.ok(r.hops.some((h) => /^click:Apply for this job$/.test(h)), r.hops.join(","));
  assert.ok(lib.APPLY_TEXT.test("Apply now") && lib.APPLY_TEXT.test("Apply Manually") && !lib.APPLY_TEXT.test("Submit application"));
  assert.ok(lib.NEVER_CLICK.test("Submit application") && lib.NEVER_CLICK.test("Send"));
  assert.deepEqual(sentToServer(), []);
});

test("a visible captcha, a password field and an emailed-code field each stop the posting before anything is typed", { skip }, async () => {
  for (const [p, wall] of [["/captcha/job", "captcha_challenge"], ["/login/job", "password"], ["/code/job", "email_code"]]) {
    const r = await run(p);
    assert.ok(r.walls.includes(wall), `${p}: ${r.walls}`);
    assert.equal(r.questions, 0, `${p}: nothing was read for filling`);
    assert.equal(r.filled, 0, `${p}: nothing typed`);
    assert.equal(r.form_found, false);
  }
  assert.deepEqual(sentToServer(), []);
});

test("robots.txt is obeyed: a disallowed posting is never requested", { skip }, async () => {
  const r = await run("/private/job");
  assert.equal(r.robots, "disallowed");
  assert.equal(r.opened, false);
  assert.ok(!hits.some((h) => h.path.startsWith("/private")), "no request to the disallowed path");
});

test("one request a second per host, measured at the server", { skip }, async () => {
  const from = hits.length;
  const o = { pacer: lib.createPacer({ gapMs: 1000 }), robotsCache: new Map(), resumePath, settleMs: 1500 };
  const r = await run("/hop/job", "bamboohr", o);
  assert.equal(r.form_found, true);
  const mine = hits.slice(from).map((h) => h.at);
  assert.ok(mine.length >= 3, `requests: ${mine.length}`);
  for (let i = 1; i < mine.length; i++) assert.ok(mine[i] - mine[i - 1] >= 950, `gap ${mine[i] - mine[i - 1]} ms`);
});

test("sample: at most 20 per provider, input order, unknown lines ignored", () => {
  const csv = ["provider,url", ...Array.from({ length: 25 }, (_, i) => `lever,https://jobs.lever.co/x/${i}`), "workday,https://a.wd1.myworkdayjobs.com/x/job/y", "junk"].join("\n");
  const s = lib.readSample(csv, { max: 50 });
  assert.equal(s.filter((x) => x.provider === "lever").length, 20);
  assert.equal(s[0].url, "https://jobs.lever.co/x/0");
  assert.equal(s.length, 21);
  assert.equal(lib.readSample(csv, { max: 3, providers: ["lever"] }).length, 3);
});

test("robots rules: longest match wins, Allow on a tie, our token's group over *, wildcards", () => {
  const g = lib.parseRobots("User-agent: *\nDisallow: /jobs\nAllow: /jobs/apply\nDisallow: /*.pdf$\n\nUser-agent: TraineeBrowserEval\nDisallow: /only-us\n");
  assert.equal(lib.robotsAllows(g, "/only-us/x"), false);
  assert.equal(lib.robotsAllows(g, "/jobs/1"), true, "our own group applies, not *");
  const star = lib.parseRobots("User-agent: *\nDisallow: /jobs\nAllow: /jobs/apply\nDisallow: /*.pdf$\nDisallow:\n");
  assert.equal(lib.robotsAllows(star, "/jobs/1"), false);
  assert.equal(lib.robotsAllows(star, "/jobs/apply/2"), true);
  assert.equal(lib.robotsAllows(star, "/a/b.pdf"), false);
  assert.equal(lib.robotsAllows(star, "/a/b.pdfx"), true);
  assert.equal(lib.robotsAllows([], "/anything"), true);
});

test("pacer: concurrent callers on one host queue a second apart; other hosts do not wait", async () => {
  let t = 0;
  const p = lib.createPacer({ gapMs: 1000, now: () => t, sleep: async (ms) => { t += ms; } });
  await Promise.all([p.wait("a.example"), p.wait("a.example"), p.wait("b.example")]);
  await p.wait("A.example");
  const a = p.log.filter((x) => x.host === "a.example").map((x) => x.at);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] - a[i - 1] >= 1000, JSON.stringify(p.log));
});

test("provider apply URLs and schema keys", () => {
  assert.equal(lib.applyUrlFor("lever", "https://jobs.lever.co/acme/a6c37876-d72a-4a85-9edd-242b94662a9b"), "https://jobs.lever.co/acme/a6c37876-d72a-4a85-9edd-242b94662a9b/apply");
  assert.equal(lib.applyUrlFor("ashby", "https://jobs.ashbyhq.com/acme/4ed8de60-7014-4ccc-91fc-9a16c72a64b8"), "https://jobs.ashbyhq.com/acme/4ed8de60-7014-4ccc-91fc-9a16c72a64b8/application");
  assert.equal(lib.applyUrlFor("breezy", "https://acme.breezy.hr/p/8c74db48559e-manager"), "https://acme.breezy.hr/p/8c74db48559e-manager/apply");
  assert.equal(lib.applyUrlFor("workable", "https://apply.workable.com/acme/j/E647F1C914/"), "https://apply.workable.com/acme/j/E647F1C914/apply/");
  assert.equal(lib.applyUrlFor("recruitee", "https://acme.recruitee.com/o/engineer"), "https://acme.recruitee.com/o/engineer/c/new");
  assert.equal(lib.applyUrlFor("greenhouse", "https://job-boards.greenhouse.io/a/jobs/1"), null);
  assert.equal(lib.schemaKeyOf({ kind: "text", label: "Email" }), "fact:email");
  assert.equal(lib.schemaKeyOf({ kind: "text", label: "Full name" }), "fact:full_name");
  assert.equal(lib.schemaKeyOf({ kind: "file", label: "Resume/CV" }), "resume");
  assert.equal(lib.schemaKeyOf({ kind: "select", label: "Gender", eeo: true }), "eeo");
  assert.equal(lib.schemaKeyOf({ kind: "checkbox", label: "I agree" }), "agreement");
  assert.equal(lib.schemaKeyOf({ kind: "text", label: "Phone number of your reference" }), "custom");
});
