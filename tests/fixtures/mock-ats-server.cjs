"use strict";
// Local mock employer pages that mimic the field layouts of a Greenhouse job-board form and a Lever form. Test only:
// it listens on 127.0.0.1, never contacts anything, and records what the worker posted so a test can compare it with the
// approved payload. Routes: GET /greenhouse/<job>, GET /lever/<job>, POST /<ats>/<job>/submit, GET /__submissions.
// A job id starting with "flaky" answers 503 to its first page load (to prove the worker's retry); "bot" shows a
// captcha-style check instead of a form (the worker must stop and hand it to the person); "latency=<ms>" in the query
// delays the page and the submit like a real employer. "captchaform-<recaptcha|hcaptcha|turnstile|text|iframe>" is a REAL
// application form that also carries a bot check (the worker must still hand it back unfilled); "redir-<n>?to=<url>" answers
// 302 to <url> (to prove redirects are validated); "?action=<url>" / "?formaction=<url>" on a greenhouse job point the form's
// post at <url> (to prove the form action is validated).
const http = require("node:http");
const crypto = require("node:crypto");

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{font:15px system-ui,sans-serif;max-width:640px;margin:24px auto;color:#1b1f24}label{display:block;font-weight:600;margin:12px 0 4px}
input[type=text],input[type=email],input[type=tel],select,textarea{width:100%;padding:8px;border:1px solid #9aa4b2;border-radius:4px;box-sizing:border-box}
button{margin-top:18px;padding:10px 18px;background:#1a7f5a;color:#fff;border:0;border-radius:4px;font-size:15px}.brand{color:#667}</style></head><body>${body}</body></html>`;

const GH = (job, { action, formaction, extra = "" } = {}) => page("Job Application for Software Engineer Intern at Mock Greenhouse Co", `
<p class="brand">MOCK GREENHOUSE (test fixture, not a real employer)</p><h1>Software Engineer Intern</h1>
<form id="application-form" method="post" action="${action || `/greenhouse/${job}/submit`}" enctype="multipart/form-data">
<label for="first_name">First Name <span>*</span></label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name <span>*</span></label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email <span>*</span></label><input id="email" name="email" type="email" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<label for="resume">Resume/CV <span>*</span></label><input id="resume" name="resume" type="file" required>
<label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="question_linkedin" type="text">
<label for="q_auth">Are you legally authorized to work in the United States? <span>*</span></label>
<select id="q_auth" name="question_auth" required><option value="">Please select</option><option>Yes</option><option>No</option></select>
<label for="q_spons">Will you now or in the future require sponsorship for employment visa status? <span>*</span></label>
<select id="q_spons" name="question_sponsorship" required><option value="">Please select</option><option>Yes</option><option>No</option></select>
${extra}<button type="submit" id="submit_app"${formaction ? ` formaction="${formaction}"` : ""}>Submit Application</button></form>`);

const LV = (job) => page("Mock Lever Co - Software Engineer Intern", `
<p class="brand">MOCK LEVER (test fixture, not a real employer)</p><h1>Software Engineer Intern</h1>
<form id="application-form" method="post" action="/lever/${job}/submit" enctype="multipart/form-data">
<label for="resume-upload-input">Resume/CV <span>*</span></label><input id="resume-upload-input" name="resume" type="file" required>
<label for="name">Full name <span>*</span></label><input id="name" name="name" type="text" required>
<label for="email">Email <span>*</span></label><input id="email" name="email" type="email" required>
<label for="phone">Phone</label><input id="phone" name="phone" type="text">
<label for="org">Current company</label><input id="org" name="org" type="text">
<label for="urls_linkedin">LinkedIn URL</label><input id="urls_linkedin" name="urls[LinkedIn]" type="text">
<label for="cards_auth">Are you legally authorized to work in the United States? <span>*</span></label>
<select id="cards_auth" name="cards[auth]" required><option value="">Select...</option><option>Yes</option><option>No</option></select>
<label for="comments">Additional information</label><textarea id="comments" name="comments"></textarea>
<button type="submit" id="btn-submit">Submit application</button></form>`);

const BOT = () => page("Verify you are human", `<h1>Please verify you are human</h1><div class="g-recaptcha" data-sitekey="TEST-NEVER-SOLVED"></div><p>This page has no application form until the check passes.</p>`);

function parseMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType || "")?.[1];
  const fields = {}, files = {};
  if (!boundary) return { fields, files };
  for (const part of buf.toString("latin1").split("--" + boundary).slice(1, -1)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const body = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name == null) continue;
    if (filename != null) files[name] = { filename, sha256: crypto.createHash("sha256").update(Buffer.from(body, "latin1")).digest("hex") };
    else fields[name] = Buffer.from(body, "latin1").toString("utf8");
  }
  return { fields, files };
}

function startMockAts({ port = 0 } = {}) {
  const submissions = [], loads = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, html, type = "text/html; charset=utf-8") => { res.writeHead(code, { "content-type": type }); res.end(html); };
    if (url.pathname === "/__submissions") return send(200, JSON.stringify(submissions), "application/json");
    const m = /^\/(greenhouse|lever)\/([\w-]+)(\/submit)?$/.exec(url.pathname);
    if (!m) return send(404, "not found");
    const [, ats, job, isSubmit] = m;
    const latency = Number(url.searchParams.get("latency") || 0);
    if (latency) await sleep(latency);
    if (req.method === "GET" && !isSubmit) {
      loads[job] = (loads[job] || 0) + 1;
      if (job.startsWith("flaky") && loads[job] === 1) return send(503, "temporarily unavailable");
      if (job.startsWith("bot")) return send(200, BOT());
      if (job.startsWith("redir")) { res.writeHead(302, { location: url.searchParams.get("to") || "/" }); return res.end(); }
      if (job.startsWith("captchaform")) {
        const kind = job.split("-")[1];
        const extra = { recaptcha: '<div class="g-recaptcha" data-sitekey="TEST-NEVER-SOLVED"></div>',
          hcaptcha: '<script src="/static/hcaptcha/api.js"></script>', turnstile: '<div class="cf-turnstile" data-sitekey="TEST-NEVER-SOLVED"></div>',
          text: "<p>Please verify you are human before applying.</p>", iframe: '<iframe src="/static/recaptcha/anchor" title="check"></iframe>' }[kind] || "";
        return send(200, GH(job, { extra }));
      }
      if (job.startsWith("login")) return send(200, page("Sign in", `<h1>Sign in to apply</h1><form method="post" action="/${ats}/${job}/login"><input type="text" name="user"><input type="password" name="pw"><button type="submit">Sign in</button></form>`));
      if (job.startsWith("rate")) { res.writeHead(429, { "retry-after": "60", "content-type": "text/plain" }); return res.end("slow down"); }
      // A cookie per page load: a context that shared cookies between people would show up as a foreign cookie at submit.
      res.setHeader("set-cookie", `sid=${job}; Path=/`);
      if (ats === "greenhouse" && (url.searchParams.get("action") || url.searchParams.get("formaction"))) return send(200, GH(job, { action: url.searchParams.get("action"), formaction: url.searchParams.get("formaction") }));
      return send(200, ats === "greenhouse" ? GH(job) : LV(job));
    }
    if (req.method === "POST" && isSubmit) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { fields, files } = parseMultipart(Buffer.concat(chunks), req.headers["content-type"]);
      if (submissions.some((s) => s.job === job && s.ats === ats)) return send(409, page("Duplicate", "<h1>Already applied</h1>"));
      submissions.push({ ats, job, fields, files, cookie: req.headers.cookie || "", at: Date.now() });
      return send(200, ats === "greenhouse"
        ? page("Confirmation", `<h1>Thank you for applying.</h1><p id="confirmation">Your application has been submitted. Confirmation code GH-${job.toUpperCase()}.</p>`)
        : page("Application submitted", `<h1>Application submitted!</h1><p id="confirmation">Thanks for applying. We've received your application. Reference LV-${job.toUpperCase()}.</p>`));
    }
    send(405, "method not allowed");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}`, submissions, loads,
    close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { startMockAts };
if (require.main === module) startMockAts({ port: Number(process.env.PORT || 0) }).then((s) => console.log(`MOCK_ATS ${s.base}`));
