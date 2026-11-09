"use strict";
// WO-L driver (Node, run by tests/architect/wo-l-signin-walls.test.ts): local employer pages that put a sign-in wall in
// front of the form, the real parallel-apply engine in real headless Chromium, and the real apply-VM worker with a fake
// database (rpc). Prints one JSON line. Nothing leaves 127.0.0.1: every non-loopback host is refused by the engine before
// it is requested. Test fixture only; the pages are fictional.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ROOT = process.argv[2];
const { applyOne, payloadHash, sha256, HANDOFF_REASONS } = require(`${ROOT}/workers/career-browser/parallel-apply.cjs`);
const { createWorker, queueHash } = require(`${ROOT}/workers/career-browser/apply-vm.cjs`);
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || "playwright");

const EMAIL = "wo-l.person@example.invalid";
const watch = `<script>for (const k of ["input","change","keydown"]) document.addEventListener(k, (e) => { fetch("/typed?n=" + encodeURIComponent(e.target.name || e.target.id || "?")); }, true);</script>`;
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>FICTIONAL EMPLOYER (test fixture)</p>${body}${watch}</body></html>`;
const FORM = (job) => page("Application", `<h1>Intern</h1><form method="post" action="/greenhouse/${job}/submit" enctype="multipart/form-data">
<label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
<button type="submit">Submit Application</button></form>`);
const SIGNIN_PW = page("Sign in", `<h1>Sign in to apply</h1><form method="post" action="/signin"><label for="u">Email</label><input id="u" name="username" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>`);
const CREATE = page("Create account", `<h1>Create an account to apply</h1><form method="post" action="/create"><label for="e">Email address</label><input id="e" name="email" type="email"><button type="submit">Continue</button></form>`);
const CODE = page("Check your email", `<h1>Check your email</h1><p>We sent a 6-digit code to your email. Enter the code to continue.</p><form method="post" action="/code"><label for="c">Code</label><input id="c" name="code" type="text" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);
const JOB = (apply) => page("Intern at Fictional Co", `<h1>Software Engineer Intern</h1><p>About the role.</p>${apply}`);

const CASES = {
  "sso-google": { redirect: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional" },
  "sso-path": { redirect: "https://careers.fictional-sso.example/login?next=%2Fapply" },
  "sso-okta-apply": { html: JOB(`<a href="https://fictional.okta.com/app/fictional/exk1/sso/saml">Apply</a>`) },
  "not-sso": { redirect: "https://careers.other-fictional.example/jobs/1" },
  "linkedin-sso": { redirect: "https://www.linkedin.com/oauth/v2/authorization?client_id=x" },
  "pw-after-apply": { html: JOB(`<a href="/greenhouse/pw-after-apply/apply">Apply</a>`), apply: SIGNIN_PW },
  "create-after-apply": { html: JOB(`<button type="button" onclick="location.href='/greenhouse/create-after-apply/apply'">Apply now</button>`), apply: CREATE },
  "code-on-load": { html: CODE },
  "form-after-apply": { html: JOB(`<a href="/greenhouse/form-after-apply/apply">Apply for this job</a>`), apply: null },
};

function server() {
  const hits = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    hits.push({ method: req.method, path: u.pathname, query: u.search });
    const send = (code, html) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
    if (u.pathname === "/typed") return send(204, "");
    const m = /^\/greenhouse\/([\w-]+)(\/apply|\/submit)?$/.exec(u.pathname);
    const c = m && CASES[m[1]];
    if (!c) return send(404, "not found");
    if (m[2] === "/submit" && req.method === "POST") { req.resume(); return send(200, page("Thanks", `<h1>Thank you for applying.</h1><p id="confirmation">Your application has been submitted.</p>`)); }
    if (m[2] === "/apply") return send(200, c.apply === null ? FORM(m[1]) : c.apply);
    if (c.redirect) { res.writeHead(302, { location: c.redirect }); return res.end(); }
    return send(200, c.html);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ hits, base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((x) => s.close(x)) })));
}

(async () => {
  const srv = await server();
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo-l-"));
  const resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\n% WO-L test resume\n");
  const rsha = sha256(fs.readFileSync(resume));
  const out = { handoff_reasons: HANDOFF_REASONS, engine: {}, vm: {}, hits: null };
  try {
    // 1. The engine on its own.
    for (const job of Object.keys(CASES)) {
      const p = { id: job, ats: "greenhouse", url: `${srv.base}/greenhouse/${job}`, facts: { first_name: "Wo", last_name: "Person", email: EMAIL },
        answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
      p.approval = { approval_id: `appr-${job}`, hash: payloadHash(p) };
      const r = await applyOne(browser, p, { retries: 0, stepTimeoutMs: 8000 });
      out.engine[job] = { status: r.status, reason: r.reason, wall: r.wall || null };
    }
    // 2. The apply-VM worker, through its claim -> prepare -> drive -> settle path, with a fake database.
    const userId = "00000000-0000-4000-8000-0000000000a1";
    for (const job of ["sso-google", "pw-after-apply", "create-after-apply", "code-on-load", "form-after-apply"]) {
      const url = `${srv.base}/greenhouse/${job}`;
      const payload = { version: 1, user_id: userId, job_id: job, company: "Fictional Co", url, resume_sha256: rsha,
        fields: [{ label: "First Name", value: "Wo" }, { label: "Last Name", value: "Person" }, { label: "Email", value: EMAIL }] };
      const h = queueHash(payload);
      const row = { id: `10000000-0000-4000-8000-${String(Object.keys(out.vm).length + 1).padStart(12, "0")}`, lease_token: "20000000-0000-4000-8000-000000000001",
        user_id: userId, url, payload, payload_hash: h, approval_hash: h, approval_id: "30000000-0000-4000-8000-000000000001" };
      const done = [];
      const w = createWorker({ workerId: "wo-l", browser, concurrency: 1, evidenceDir: null, retries: 0, stepTimeoutMs: 8000, log: () => {},
        rpc: async (name, a) => {
          if (name === "career_apply_vm_claim") return done.length || w.__claimed ? [] : ((w.__claimed = true), [row]);
          if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: rsha, b64: fs.readFileSync(resume).toString("base64") };
          if (name === "career_apply_vm_heartbeat") return { ok: true };
          if (name === "career_apply_vm_complete") { done.push({ state: a.p_state, reason: a.p_reason, evidence: a.p_evidence }); return {}; }
          return {};
        } });
      await w.tick();
      while (w.inflight.size) await new Promise((x) => setTimeout(x, 20));
      out.vm[job] = done;
    }
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  out.hits = srv.hits;
  process.stdout.write(JSON.stringify(out) + "\n");
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) }) + "\n"); process.exit(1); });
