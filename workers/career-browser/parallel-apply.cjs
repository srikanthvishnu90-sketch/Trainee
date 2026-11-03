"use strict";
// Deterministic browser apply worker (no model calls, no network beyond the page it is given): takes prepared
// application payloads and fills + submits Greenhouse-style and Lever-style forms in a bounded pool of headless
// Chromium contexts, with retries.
//
// Rules it enforces in code (CLAUDE.md, D-007):
//  - exact payload: the job input must carry `approval: { approval_id, hash }`. `hash` must equal the hash of
//    {url, ats, facts, answers, resume.sha256} (computed here, at the start AND again just before the submit click); an
//    absent approval, an empty approval_id or any mismatch refuses the run. NOTE: a hash only proves integrity. This
//    module cannot know whether `approval_id` is a real approval, so the CALLER (the apply-VM worker, #279) MUST verify
//    approval_id against the stored approval record (exists, not revoked/expired, bound to this payload) BEFORE calling.
//  - one resume: the file at resume.path must hash to resume.sha256 and resume.preparedWithSha256 (the file the
//    application was prepared with); it is the only file ever uploaded.
//  - no invented facts: a field is filled only from payload.facts / payload.answers. A required field with no value stops
//    the run as needs_user naming the field. An optional field with no value is left blank.
//  - no bot-check work: a captcha/"verify you are human" (recaptcha/hcaptcha/turnstile iframes, scripts, widgets or text)
//    stops the run as needs_user/bot_check whether or not the page has a form, on load and again right before submit.
//    Never solved, never submitted past.
//  - hard denylist: linkedin.com, indeed.com, joinhandshake.com and every subdomain are refused before any navigation,
//    independent of `allowHosts`. Every main-frame navigation (redirects included) and the form action (checked before the
//    submit click) must be on an allowed host too, else the run is refused.
//  - at most once: a failure BEFORE the submit click is retried (fresh context); once submit is clicked the run is never
//    retried: a missing confirmation is unknown_outcome.
//  - local only by default: only loopback hosts are driven. Real employer hosts need `allowHosts` from the caller
//    (the owner-run approve-first path), and this module never discovers or logs in anywhere.
const fs = require("node:fs");
const { fillForm } = require("./ats-fill.cjs");
const crypto = require("node:crypto");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function payloadHash(p) {
  return sha256(canonical({ url: p.url, ats: p.ats, facts: p.facts, answers: p.answers || {}, resume: p.resume && p.resume.sha256 }));
}

const BOT_RE = /verify\s+(?:that\s+)?you(?:\s+are|(?:'|\u2019|&#0*39;|&rsquo;|&apos;)re)\s+(?:a\s+)?(?:human|not a robot)|captcha|turnstile|challenges\.cloudflare\.com|are you a robot|not a robot/i;
const DENY_HOSTS = ["linkedin.com", "indeed.com", "joinhandshake.com"];
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
const normHost = (h) => String(h || "").toLowerCase().replace(/\.+$/, "");
const isDeniedHost = (h) => { const n = normHost(h); return DENY_HOSTS.some((d) => n === d || n.endsWith(`.${d}`)); };
// Verdict for a URL a page is about to load or post to. The denylist always wins over allowHosts.
function urlVerdict(u, allowHosts = []) {
  let url;
  try { url = new URL(u); } catch { return { ok: false, reason: "host_not_allowed", host: String(u).slice(0, 80) }; }
  const host = normHost(url.hostname);
  if (isDeniedHost(host)) return { ok: false, reason: "host_denied", host };
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: "host_not_allowed", host: url.protocol };
  if (!LOOPBACK.includes(host) && !allowHosts.map(normHost).includes(host)) return { ok: false, reason: "host_not_allowed", host };
  return { ok: true, host };
}
async function botCheck(page) {
  if (BOT_RE.test(await page.content())) return true;
  return page.frames().some((f) => BOT_RE.test(f.url()));
}
const hasApproval = (p) => !!p.approval && typeof p.approval.approval_id === "string" && p.approval.approval_id.trim() !== ""
  && typeof p.approval.hash === "string" && p.approval.hash === payloadHash(p);
const CONFIRM_RE = /thank you for applying|application (has been )?submitted|we['’]ve received your application/i;

class NeedsUser extends Error { constructor(reason, field) { super(`${reason}${field ? `: ${field}` : ""}`); this.reason = reason; this.field = field; this.needs = null; } }

function checkPayload(p, { allowHosts = [] } = {}) {
  if (!p || !p.url || !p.facts || !p.resume) throw new NeedsUser("invalid_payload");
  const v = urlVerdict(p.url, allowHosts);
  if (!v.ok) throw new NeedsUser(v.reason, v.host);
  if (!hasApproval(p)) throw new NeedsUser("not_approved", "no approval {approval_id, hash}, or the payload changed after approval");
  const bytes = fs.readFileSync(p.resume.path);
  const h = sha256(bytes);
  if (h !== p.resume.sha256 || h !== p.resume.preparedWithSha256) throw new NeedsUser("resume_mismatch", "the resume is not the one this application was prepared with");
}

// One attempt in its own fresh context. Returns a result; throws NeedsUser for a stop, Error for a retryable failure.
async function attempt(browser, p, opts, timing) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.stepTimeoutMs || 15000);
  const allow = opts.allowHosts || [];
  const blocked = [];
  // Main-frame navigations (the first load, every redirect hop, any later navigation) to a host that is denied or not allowed
  // are aborted before a request leaves the browser.
  // GET navigations are fetched with redirects off so the Location of each hop is checked BEFORE the browser requests it
  // (a browser-followed redirect would already have reached the other host); the 3xx is handed back and the next hop comes
  // through this same handler.
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const g = urlVerdict(req.url(), allow);
      if (!g.ok) { blocked.push(g.host); return route.abort("blockedbyclient"); }
      if (req.method() === "GET") {
        const resp = await route.fetch({ maxRedirects: 0 });
        const loc = resp.status() >= 300 && resp.status() < 400 ? resp.headers().location : null;
        if (loc) {
          const next = urlVerdict(new URL(loc, req.url()).href, allow);
          if (!next.ok) { blocked.push(next.host); return route.abort("blockedbyclient"); }
        }
        return route.fulfill({ response: resp });
      }
    }
    return route.continue();
  });
  const onAllowedHost = () => {
    if (blocked.length) throw new NeedsUser("redirect_not_allowed", blocked[0]);
    const g = urlVerdict(page.url(), allow);
    if (!g.ok) throw new NeedsUser("redirect_not_allowed", g.host);
  };
  try {
    const t0 = Date.now();
    let resp;
    try { resp = await page.goto(p.url, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
    onAllowedHost();
    if (!resp || resp.status() >= 400) throw new Error(`page_load_${resp ? resp.status() : "none"}`);
    if (await botCheck(page)) throw new NeedsUser("bot_check", p.url);
    // An employer that wants the person to sign in first: never signed into, never given a password (the person does that).
    if (await page.$('input[type="password"]')) throw new NeedsUser("login_required", p.url);
    timing.load = Date.now() - t0;
    const t1 = Date.now();
    if (!(await page.$("form input, form select, form textarea")) || !(await page.$('form button[type="submit"]'))) throw new NeedsUser("no_application_form_found", p.url);
    // The page's own questions, answered only from the approved facts / answers (ats-fill.cjs), each read back. A required
    // question with no confirmed answer, or one that could not be set and checked, stops the run: the person is asked.
    const fr = await fillForm(page, { ats: p.ats, facts: p.facts, answers: p.answers || {}, resumePath: p.resume.path });
    if (fr.needsUser.length) {
      const first = fr.needsUser[0];
      const e = new NeedsUser(first.reason === "no_confirmed_answer" || /^(agreement|eeo|upload)_/.test(first.reason) || first.reason === "no_resume" ? "missing_required_answer" : "field_not_filled", first.label);
      e.needs = fr.needsUser.map((n) => ({ label: n.label, reason: n.reason }));
      throw e;
    }
    if (fr.invalid.length) { const e = new NeedsUser("field_not_filled", fr.invalid[0].name); e.needs = fr.invalid.map((n) => ({ label: n.name, reason: "form_rejects_value" })); throw e; }
    const filled = fr.filled.map((f) => ({ field: f.label, source: f.source }));
    timing.fill = Date.now() - t1;
    // Last checks before the click, on what is actually on the page now: still an allowed host, no bot check that appeared
    // while filling, the form posts to an allowed host, and the payload still hashes to what was approved.
    onAllowedHost();
    if (await botCheck(page)) throw new NeedsUser("bot_check", p.url);
    const action = await page.$eval('form button[type="submit"]', (b) => {
      const a = b.getAttribute("formaction") ?? (b.form && b.form.getAttribute("action"));
      return new URL(a || location.href, document.baseURI).href;
    });
    const av = urlVerdict(action, allow);
    if (!av.ok) throw new NeedsUser("form_action_not_allowed", av.host);
    if (!hasApproval(p)) throw new NeedsUser("not_approved", "payload changed after approval");
    if (opts.shotBefore) await page.screenshot({ path: opts.shotBefore, fullPage: true });
    // The caller records "submitting" (and re-checks its lease and kill switch) BEFORE the click; a refusal stops here, unsent.
    if (opts.onPhase) await opts.onPhase("submitting");
    // Past this line nothing is retried: the employer may have received it.
    const t2 = Date.now();
    timing.submitClicked = true;
    try {
      await Promise.all([page.waitForLoadState("domcontentloaded"), page.click('button[type="submit"]')]);
      await page.waitForSelector("#confirmation, h1", { timeout: opts.stepTimeoutMs || 15000 });
      if (blocked.length) return { status: "unknown_outcome", reason: `after submit: navigation to a disallowed host was refused (${blocked[0]})`, filled };
    } catch (e) {
      return { status: "unknown_outcome", reason: `after submit: ${e.message.split("\n")[0]}`, filled };
    }
    timing.submit = Date.now() - t2;
    const text = (await page.textContent("body")) || "";
    if (opts.shotAfter) await page.screenshot({ path: opts.shotAfter, fullPage: true });
    if (!CONFIRM_RE.test(text)) return { status: "unknown_outcome", reason: "no confirmation text on the page after submit", filled };
    const code = /\b(?:GH|LV)-[A-Z0-9-]+/.exec(text);
    return { status: "submitted_page_confirmed", confirmation: code ? code[0] : null, filled };
  } finally {
    await ctx.close();
  }
}

async function applyOne(browser, p, opts = {}) {
  const started = Date.now();
  const timing = {};
  const out = { id: p.id, ats: p.ats, url: p.url, attempts: 0 };
  try {
    checkPayload(p, opts);
  } catch (e) {
    if (e instanceof NeedsUser) return { ...out, status: "not_submitted", reason: e.reason, field: e.field, ms: Date.now() - started };
    throw e;
  }
  const max = 1 + (opts.retries ?? 2);
  for (let n = 1; n <= max; n++) {
    out.attempts = n;
    const t = {};
    try {
      const r = await attempt(browser, p, { ...opts, shotBefore: opts.shotDir && `${opts.shotDir}/${p.id}-1-filled.png`, shotAfter: opts.shotDir && `${opts.shotDir}/${p.id}-2-confirmation.png` }, t);
      return { ...out, ...r, timing: t, ms: Date.now() - started };
    } catch (e) {
      if (e instanceof NeedsUser) return { ...out, status: e.reason === "bot_check" || e.reason === "login_required" ? "needs_user" : "not_submitted", reason: e.reason, field: e.field, needs: e.needs || undefined, ms: Date.now() - started };
      if (t.submitClicked) return { ...out, status: "unknown_outcome", reason: e.message, ms: Date.now() - started };
      out.lastError = e.message.split("\n")[0];
      if (out.lastError === "page_load_429") break; // the portal said slow down: not asked again by this run
      if (n < max) await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 200) * n));
    }
  }
  return { ...out, status: "not_submitted", reason: "retries_exhausted", error: out.lastError, ms: Date.now() - started };
}

// A pool of `concurrency` applications at once, results in input order.
async function runPool(browser, payloads, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 5);
  const results = new Array(payloads.length);
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, payloads.length) }, async () => {
    while (next < payloads.length) {
      const i = next++;
      results[i] = await applyOne(browser, payloads[i], opts);
    }
  }));
  return { results, wallMs: Date.now() - started, concurrency };
}

module.exports = { applyOne, runPool, payloadHash, checkPayload, sha256, urlVerdict, DENY_HOSTS, NeedsUser };
