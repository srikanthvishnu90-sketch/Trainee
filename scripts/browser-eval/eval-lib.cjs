"use strict";
// WO-M real-site DRY-RUN eval: what the browser runner can do on real postings, measured without sending anything.
// For each sampled posting: open it in headless Chromium, find the application form (following the provider's own apply
// link when the form is one page further), map every question to the approved-answer schema, attach a synthetic test
// resume, fill everything a synthetic TEST person's facts answer, and STOP. It can never submit:
//  - every request that is not GET/HEAD/OPTIONS is aborted inside the browser before it leaves (a form post, an upload,
//    an autosave, a beacon), and counted; WebSockets are closed. Nothing the page does can send an application;
//  - no code path clicks a submit control: the only clicks are on an "Apply"-type link or button, and never on one whose
//    text says submit / send, nor on a type=submit control;
//  - a visible verification check (captcha, Cloudflare challenge), a password field or an emailed-code field stops the
//    posting BEFORE anything is typed; nothing is solved, nothing is typed into a password or code field;
//  - robots.txt is read first for every host (5xx or unreadable = disallowed) and a disallowed path is never opened;
//  - at most 1 request per second per host (every request the page makes, the robots read included), images, fonts and
//    media are not fetched at all, and at most 20 postings per provider per run.
// Pure helpers are exported for tests/career-browser-eval.test.cjs; run.cjs is the CLI. Data goes to artifacts/ (gitignored).
const fs = require("node:fs");
const path = require("node:path");
const { fillForm, factValue } = require("../../workers/career-browser/ats-fill.cjs");
const { atsOf } = require("../../workers/career-browser/apply-vm.cjs");

const MAX_PER_PROVIDER = 20;
const UA_TOKEN = "TraineeBrowserEval/1 (dry run; never submits)";
// The runner's own captcha words (parallel-apply.cjs BOT_RE): measured here to show what the VM would do with the page.
const RUNNER_BOT_RE = /verify\s+(?:that\s+)?you(?:\s+are|(?:'|’|&#0*39;|&rsquo;|&apos;)re)\s+(?:a\s+)?(?:human|not a robot)|captcha|turnstile|challenges\.cloudflare\.com|are you a robot|not a robot/i;
const SEND_METHODS = /^(GET|HEAD|OPTIONS)$/;
const APPLY_TEXT = /^\s*(apply|apply now|apply here|apply for (this|the) (job|position|role)|apply to (this )?(job|position|role)|apply manually|i['’]?m interested|start (your )?application|bewerben|jetzt bewerben|ansök( nu)?|ansøg( nu)?|søk( nå)?|solliciteer( nu)?|postuler|candidatar(-se|me)?|inscr[ií]bete|candidati)\s*[»>→]?\s*$/i;
const NEVER_CLICK = /submit|send|senden|absenden|envoyer|enviar|verzenden|skicka|finish|complete|confirm/i;

// ---------------------------------------------------------------------------------------------------------- sample
// CSV: provider,url (a header line is optional). Deterministic: input order, capped per provider.
function readSample(text, { max = MAX_PER_PROVIDER, providers = null } = {}) {
  const cap = Math.min(MAX_PER_PROVIDER, Math.max(1, Number(max) || MAX_PER_PROVIDER));
  const out = [], per = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([a-z0-9_-]+)\s*,\s*(https?:\/\/\S+)\s*$/i.exec(line);
    if (!m) continue;
    const provider = m[1].toLowerCase();
    if (providers && !providers.includes(provider)) continue;
    const n = per.get(provider) || 0;
    if (n >= cap) continue;
    per.set(provider, n + 1);
    out.push({ provider, url: m[2], n: n + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- robots
// RFC 9309: the group for our token, else "*"; the longest matching Allow/Disallow wins (Allow on a tie); * and $ patterns.
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") cur.rules.push({ allow: key === "allow", path: val });
  }
  return groups;
}
function robotsAllows(groups, pathname, token = "traineebrowsereval") {
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of use) for (const r of g.rules) {
    if (r.path === "") continue; // "Disallow:" with no path allows everything
    const re = new RegExp("^" + r.path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
    if (!re.test(pathname)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------------------------------------- pacing
// At most one request per `gapMs` per host. `now` and `sleep` are inputs so tests run on a fake clock.
function createPacer({ gapMs = 1000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const next = new Map(); // host -> earliest time the next request may start
  const log = [];
  return {
    log,
    async wait(host) {
      const h = String(host).toLowerCase();
      const t = now(), at = Math.max(t, next.get(h) || 0);
      next.set(h, at + gapMs); // reserve the slot before sleeping, so concurrent callers queue behind it
      if (at > t) await sleep(at - t);
      log.push({ host: h, at: now() });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- providers
// Where a provider's application form lives, one GET away from the posting page (null: follow the page's own Apply link).
function applyUrlFor(provider, landed) {
  let u;
  try { u = new URL(landed); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, "");
  switch (provider) {
    case "lever": return /^\/[^/]+\/[0-9a-f-]{36}$/i.test(p) ? `${u.origin}${p}/apply` : null;
    case "ashby": return /^\/[^/]+\/[0-9a-f-]{36}$/i.test(p) ? `${u.origin}${p}/application` : null;
    case "breezy": return /^\/p\/[^/]+$/.test(p) ? `${u.origin}${p}/apply` : null;
    case "workable": return /^\/[^/]+\/j\/[A-Z0-9]+$/i.test(p) ? `${u.origin}${p}/apply/` : null;
    case "recruitee": return /^\/o\/[^/]+$/.test(p) ? `${u.origin}${p}/c/new` : null;
    default: return null;
  }
}
// The schema key an approved answer would come from, for one question the page asked (ats-fill's own decision).
const FACT_KEYS = ["first_name", "last_name", "preferred_name", "full_name", "email", "phone", "current_company", "current_title", "linkedin_url", "github_url", "website_url", "location"];
const PROBE = Object.fromEntries(FACT_KEYS.map((k) => [k, `@${k}`]));
function schemaKeyOf(q) {
  if (q.kind === "file") return /resume|\bcv\b|curriculum|lebenslauf/i.test(q.label) ? "resume" : /cover|anschreiben/i.test(q.label) ? "cover_letter" : "upload_other";
  if (q.eeo) return "eeo";
  if (q.kind === "checkbox") return "agreement";
  const f = factValue(q.label, PROBE);
  if (typeof f === "string" && f.startsWith("@")) return `fact:${f.slice(1)}`;
  return "custom";
}

// ---------------------------------------------------------------------------------------------------------- walls
// What stands between the page and a guest application. Evaluated in the page; plain data out.
function WALLS() {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const text = (document.body && document.body.innerText) || "";
  const inputs = [...document.querySelectorAll("input")].filter(vis);
  const labelOf = (e) => `${e.name || ""} ${e.id || ""} ${e.getAttribute("autocomplete") || ""} ${e.getAttribute("aria-label") || ""} ${e.placeholder || ""} ${(e.labels && e.labels[0] && e.labels[0].textContent) || ""}`;
  const frames = [...document.querySelectorAll("iframe")];
  const frameVisible = (re) => frames.some((f) => re.test(f.src || "") && vis(f) && f.offsetWidth > 60 && f.offsetHeight > 40);
  const captchaChallenge = frameVisible(/recaptcha\/(api2|enterprise)\/(anchor|bframe)|hcaptcha\.com|challenges\.cloudflare\.com|turnstile/) ||
    /^just a moment|attention required|verify you are human|are you a robot|press (and|&) hold/i.test(document.title + " " + text.slice(0, 400)) ||
    !!document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile, .h-captcha:not([data-size='invisible']), .g-recaptcha:not([data-size='invisible'])");
  const captchaScript = !!document.querySelector("script[src*='recaptcha'], script[src*='hcaptcha'], script[src*='turnstile'], iframe[src*='recaptcha'], iframe[src*='hcaptcha']");
  return {
    title: document.title.slice(0, 120),
    password: inputs.some((e) => e.type === "password"),
    email_code: inputs.some((e) => e.type !== "hidden" && /one[- _]?time|verification[\s_-]*code|security[\s_-]*code|\botp\b|passcode|confirmation[\s_-]*code/i.test(labelOf(e))),
    login_text: /\b(sign in|log ?in|create (an )?account|anmelden|registrieren|konto erstellen)\b/i.test(text.slice(0, 6000)),
    sso: [...document.querySelectorAll("a,button")].filter(vis).some((e) => /\b(sign in|continue|log in|apply) with (google|linkedin|apple|microsoft|facebook|indeed)\b/i.test(e.textContent || "")),
    captcha_challenge: captchaChallenge,
    captcha_script: captchaScript,
    closed: /\b(no longer (accepting|available|open)|position (has been )?(filled|closed)|job (is )?(closed|expired)|this job (posting )?(has )?expired|page (you are looking for )?(not found|doesn['’]t exist)|stelle ist (leider )?(nicht mehr|bereits besetzt))\b/i.test(text.slice(0, 4000)),
    inputs: inputs.filter((e) => !["hidden", "search", "submit", "button"].includes(e.type)).length + [...document.querySelectorAll("select,textarea")].filter(vis).length,
  };
}
// The page's own Apply control: a link or a button whose whole text says apply. Never a submit control.
function APPLY_CANDIDATES(args) {
  const [applySrc, neverSrc] = args;
  const APPLY = new RegExp(applySrc, "i"), NEVER = new RegExp(neverSrc, "i");
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const out = [];
  document.querySelectorAll("a, button, [role='button']").forEach((e, i) => {
    const t = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
    if (!vis(e) || !APPLY.test(t) || NEVER.test(t)) return;
    if ((e.getAttribute("type") || "").toLowerCase() === "submit" || (e.tagName === "BUTTON" && e.form && (e.type || "submit") === "submit")) return;
    const href = e.tagName === "A" ? e.href : null;
    if (href && /^javascript:/i.test(href) && e.closest("form")) return;
    e.setAttribute("data-eval-apply", String(i));
    out.push({ i, text: t.slice(0, 60), href });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------- one posting
const TEST_FACTS = { first_name: "Testy", last_name: "Example", full_name: "Testy Example", email: "dry-run@example.invalid", phone: "+1 555 0100", location: "Test City", eeo_policy: "decline" };
function syntheticResume(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "TEST-synthetic-resume.pdf");
  if (!fs.existsSync(p)) fs.writeFileSync(p, "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n% SYNTHETIC TEST RESUME: Testy Example, dry-run@example.invalid. Not a real person.\n");
  return p;
}

async function evalPosting(browser, item, o) {
  const t0 = Date.now();
  const pacer = o.pacer, robotsCache = o.robotsCache || new Map();
  const r = {
    provider: item.provider, url: item.url, dry_run: true, submit_clicked: false, nothing_sent: true,
    vm_today: atsOf(item.url).refuse || "drivable", submit_attempts: 0, robots: null, opened: false, status: null, final_url: null,
    form_found: false, hops: [], questions: 0, required: 0, schema: {}, filled: 0, fill_failed: 0,
    required_unanswerable: [], walls: [], runner_bot_re: false, requests: 0, requests_blocked: [], error: null, ms: 0,
  };
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1300 }, userAgent: o.userAgent, locale: "en-US" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(o.stepTimeoutMs || 20000);
  const robotsOk = async (u) => {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return true;
    let groups = robotsCache.get(url.origin);
    if (groups === undefined) {
      await pacer.wait(url.host);
      try {
        const resp = await ctx.request.get(`${url.origin}/robots.txt`, { timeout: 15000, maxRedirects: 3 });
        groups = resp.status() >= 500 ? "deny" : resp.ok() ? parseRobots(await resp.text()) : [];
      } catch { groups = "unreachable"; } // not read: never opened, and reported as unreachable, not as a robots refusal
      robotsCache.set(url.origin, groups);
    }
    if (groups === "unreachable") return "unreachable";
    return groups !== "deny" && robotsAllows(groups, url.pathname + url.search);
  };
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.abort("blockedbyclient"); }
    if (/^(data|blob|about):$/.test(u.protocol)) return route.continue();
    if (!SEND_METHODS.test(req.method())) { r.requests_blocked.push(`${req.method()} ${u.host}${u.pathname}`.slice(0, 140)); return route.abort("blockedbyclient"); }
    if (["image", "media", "font"].includes(req.resourceType())) return route.abort("blockedbyclient");
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && (await robotsOk(u.href)) !== true) { r.requests_blocked.push(`ROBOTS ${u.host}${u.pathname}`.slice(0, 140)); return route.abort("blockedbyclient"); }
    await pacer.wait(u.host);
    r.requests++;
    return route.continue();
  });
  // Belt to the request rule's braces: a form cannot be submitted in this page at all. Every submit event is cancelled before
  // the page's own handlers see it, form.submit() / requestSubmit() do nothing, and each attempt is counted (submit_attempts).
  await ctx.addInitScript(SUBMIT_TRAP);
  await ctx.exposeBinding("__evalSubmitAttempt", () => { r.submit_attempts++; });
  if (typeof page.routeWebSocket === "function") await page.routeWebSocket(/.*/, (ws) => ws.close()).catch(() => {});
  const settle = async () => { await page.waitForLoadState("networkidle", { timeout: o.settleMs || 8000 }).catch(() => {}); };
  const walls = async () => {
    const w = await page.evaluate(WALLS).catch(() => null);
    if (!w) return null;
    const content = await page.content().catch(() => "");
    r.runner_bot_re = r.runner_bot_re || RUNNER_BOT_RE.test(content) || page.frames().some((f) => RUNNER_BOT_RE.test(f.url()));
    for (const k of ["password", "email_code", "sso", "captcha_challenge", "captcha_script", "closed"]) if (w[k] && !r.walls.includes(k)) r.walls.push(k);
    return w;
  };
  const go = async (u, why) => {
    r.hops.push(why);
    const resp = await page.goto(u, { waitUntil: "domcontentloaded" }).catch((e) => ({ err: e }));
    if (resp && resp.err) { if (r.requests_blocked.some((b) => b.startsWith("ROBOTS"))) return "robots"; throw resp.err; }
    await settle();
    r.status = resp ? resp.status() : null; r.final_url = page.url();
    return r.status && r.status < 400 ? "ok" : "http";
  };
  try {
    const rb = await robotsOk(item.url);
    if (rb === "unreachable") { r.robots = "unreachable"; r.error = "host_unreachable"; return r; }
    if (!rb) { r.robots = "disallowed"; r.walls.push("robots_disallowed"); return r; }
    r.robots = "allowed";
    const first = await go(item.url, "posting");
    if (first !== "ok") { r.error = first === "robots" ? "robots_disallowed_redirect" : `http_${r.status}`; return r; }
    r.opened = true;
    // Find the form: on the page, in a same-provider iframe (an employer's own site embedding the ATS), one GET away at the
    // provider's apply URL, or behind the page's own Apply link (at most two clicks, e.g. Workday's Apply then Apply Manually).
    let w = await walls();
    for (let hop = 0; hop < 4 && w && !stopWall(w) && w.inputs < 2; hop++) {
      const embed = page.frames().find((f) => f !== page.mainFrame() && /greenhouse\.io\/embed|greenhouse\.io\/.+\/jobs|lever\.co\/.+\/apply|ashbyhq\.com|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com|personio\.(de|com)|teamtailor\.com|breezy\.hr/i.test(f.url()));
      const direct = hop === 0 ? applyUrlFor(item.provider, page.url()) : null;
      if (embed && !r.hops.includes("embedded_form")) { if ((await go(embed.url(), "embedded_form")) !== "ok") break; }
      else if (direct && !r.hops.includes("provider_apply_url")) { if ((await go(direct, "provider_apply_url")) !== "ok") break; }
      else {
        const c = await page.evaluate(APPLY_CANDIDATES, [APPLY_TEXT.source, NEVER_CLICK.source]).catch(() => []);
        if (!c.length) break;
        r.hops.push(`click:${c[0].text}`);
        const popup = ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
        await page.click(`[data-eval-apply="${c[0].i}"]`, { timeout: 8000 }).catch(() => {});
        const np = await popup;
        if (np) { const target = np.url(); await np.close().catch(() => {}); if (/^https?:/.test(target) && (await go(target, "apply_popup")) !== "ok") break; }
        await settle();
        r.final_url = page.url();
      }
      w = await walls();
    }
    if (!w) { r.error = "page_unreadable"; return r; }
    if (stopWall(w)) return r; // stopped before anything was typed
    if (w.inputs < 2) { if (w.login_text) r.walls.push("login"); return r; }
    // x-audit: a read-only look at the form as found, before anything is typed (hidden-twice.cjs reads its hidden fields).
    if (o.onForm) await o.onForm(page, r).catch(() => {});
    // Fill with the synthetic TEST person only. Custom questions get no answer: they are what the person would be asked.
    const fr = await fillForm(page, { ats: item.provider, facts: TEST_FACTS, answers: {}, resumePath: o.resumePath });
    const qs = fr.map;
    r.questions = qs.length;
    r.form_found = qs.length >= 2 && qs.some((q) => q.kind === "file" || /e ?mail/i.test(q.label));
    r.required = qs.filter((q) => q.required).length;
    for (const q of qs) { const k = schemaKeyOf(q); r.schema[k] = (r.schema[k] || 0) + 1; }
    r.filled = fr.filled.length;
    r.fill_failed = fr.failed.length + fr.needsUser.filter((n) => !/^(no_confirmed_answer|agreement_needs_you|eeo_needs_your_choice|upload_needs_you|still_empty_after_fill|label_on_form_twice)$/.test(n.reason)).length;
    r.required_unanswerable = fr.needsUser.map((n) => ({ label: String(n.label).slice(0, 80), reason: n.reason, schema: schemaKeyOf(qs.find((q) => q.label === n.label) || { label: n.label }) }));
    r.resume_attached = fr.filled.some((f) => f.kind === "file");
    await walls(); // a check that appeared while filling is recorded too
    if (o.shotDir) { fs.mkdirSync(o.shotDir, { recursive: true }); await page.screenshot({ path: path.join(o.shotDir, `${item.provider}-${item.n}.png`), fullPage: false }).catch(() => {}); }
  } catch (e) {
    r.error = `driver_error: ${String(e && e.message).split("\n")[0].slice(0, 160)}`;
  } finally {
    r.ms = Date.now() - t0;
    await ctx.close().catch(() => {});
  }
  return r;
}
// Runs before any page script, in every frame.
function SUBMIT_TRAP() {
  const hit = () => { try { window.__evalSubmitAttempt(); } catch { /* the binding is per page */ } };
  window.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); hit(); }, true);
  HTMLFormElement.prototype.submit = function () { hit(); };
  HTMLFormElement.prototype.requestSubmit = function () { hit(); };
}
const stopWall = (w) => w.captcha_challenge || w.password || w.email_code || w.closed;

// ---------------------------------------------------------------------------------------------------------- report
const pctl = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
function summarize(results) {
  const by = new Map();
  for (const r of results) { if (!by.has(r.provider)) by.set(r.provider, []); by.get(r.provider).push(r); }
  const rows = [];
  for (const [provider, rs] of [...by.entries()].sort()) {
    const n = (f) => rs.filter(f).length;
    const forms = rs.filter((r) => r.form_found);
    const schema = {};
    for (const r of forms) for (const [k, v] of Object.entries(r.schema)) schema[k] = (schema[k] || 0) + v;
    rows.push({
      provider, sampled: rs.length,
      robots_disallowed: n((r) => r.robots === "disallowed" || r.error === "robots_disallowed_redirect"),
      opened: n((r) => r.opened), form_found: forms.length,
      guest_fillable: n((r) => r.form_found && r.fill_failed === 0 && !r.walls.some((w) => ["captcha_challenge", "password", "email_code", "login"].includes(w))),
      ready_if_answered: n((r) => r.form_found && r.fill_failed === 0 && r.required_unanswerable.every((q) => q.schema === "custom" || q.schema === "agreement" || q.schema === "eeo")),
      questions_median: pctl(forms.map((r) => r.questions), 0.5), required_median: pctl(forms.map((r) => r.required), 0.5),
      unanswerable_required_median: pctl(forms.map((r) => r.required_unanswerable.length), 0.5),
      postings_with_unanswerable: n((r) => r.form_found && r.required_unanswerable.length > 0),
      fill_failed_postings: n((r) => r.form_found && r.fill_failed > 0), resume_attached: n((r) => r.resume_attached),
      schema,
      walls: Object.fromEntries(["login", "password", "sso", "email_code", "captcha_challenge", "captcha_script", "closed", "robots_disallowed"].map((k) => [k, n((r) => r.walls.includes(k))])),
      runner_bot_re_stops: n((r) => r.runner_bot_re), vm_today: [...new Set(rs.map((r) => r.vm_today))].join("/"),
      errors: n((r) => !!r.error), unreachable: n((r) => r.robots === "unreachable"), posts_blocked: rs.reduce((a, r) => a + r.requests_blocked.filter((b) => !b.startsWith("ROBOTS")).length, 0),
      submit_clicked: n((r) => r.submit_clicked), submit_attempts: rs.reduce((a, r) => a + r.submit_attempts, 0), ms_median: pctl(rs.map((r) => r.ms), 0.5), ms_p90: pctl(rs.map((r) => r.ms), 0.9),
    });
  }
  return rows;
}
function markdown(rows, meta = {}) {
  const h = "| provider | sampled | opened | form found | guest-fillable | ready if answered | questions (med) | required unanswerable (med) | fill failed | resume attached | login | sso | email code | captcha shown | captcha script | runner BOT_RE stops | closed | robots no | VM today | median s | p90 s |";
  const lines = [`# Browser dry-run eval ${meta.label || ""}`, "", `Run ${meta.started || ""}; ${meta.note || "dry run, nothing submitted"}.`, "", h, "|" + h.split("|").slice(1, -1).map(() => "---").join("|") + "|"];
  for (const x of rows) lines.push(`| ${x.provider} | ${x.sampled} | ${x.opened} | ${x.form_found} | ${x.guest_fillable} | ${x.ready_if_answered} | ${x.questions_median ?? "-"} | ${x.unanswerable_required_median ?? "-"} | ${x.fill_failed_postings} | ${x.resume_attached} | ${x.walls.login + x.walls.password} | ${x.walls.sso} | ${x.walls.email_code} | ${x.walls.captcha_challenge} | ${x.walls.captcha_script} | ${x.runner_bot_re_stops} | ${x.walls.closed} | ${x.robots_disallowed} | ${x.vm_today} | ${x.ms_median == null ? "-" : (x.ms_median / 1000).toFixed(1)} | ${x.ms_p90 == null ? "-" : (x.ms_p90 / 1000).toFixed(1)} |`);
  lines.push("", `Requests that would have sent something and were aborted in the browser: ${rows.reduce((a, x) => a + x.posts_blocked, 0)}. Submit clicks: ${rows.reduce((a, x) => a + x.submit_clicked, 0)}. Form submits the page attempted, cancelled in the page: ${rows.reduce((a, x) => a + x.submit_attempts, 0)}. Postings whose host could not be reached (not opened, not counted as robots refusals): ${rows.reduce((a, x) => a + x.unreachable, 0)}.`);
  return lines.join("\n") + "\n";
}

module.exports = { SUBMIT_TRAP, MAX_PER_PROVIDER, UA_TOKEN, readSample, parseRobots, robotsAllows, createPacer, applyUrlFor, schemaKeyOf, evalPosting, summarize, markdown, syntheticResume, TEST_FACTS, APPLY_TEXT, NEVER_CLICK };
