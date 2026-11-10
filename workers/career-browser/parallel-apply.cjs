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
//  - no bot-check work: a SHOWN check (a reCAPTCHA / hCaptcha / Turnstile widget or challenge frame, or "verify you are
//    human" in the visible text; SHOWN_CHECK below) stops the run as needs_user/bot_check whether or not the page has a
//    form, on load and again right before submit. A captcha script alone (invisible reCAPTCHA) is not a stop.
//    Never solved, never submitted past.
//  - hard denylist: linkedin.com, indeed.com, joinhandshake.com and every subdomain are refused before any navigation,
//    independent of `allowHosts`. Every main-frame navigation (redirects included) and the form action (checked before the
//    submit click) must be on an allowed host too, else the run is refused.
//  - sign-in walls (WO-L): an SSO redirect (to an identity provider, or to a sign-in path), a password field, a
//    create-account or sign-in-to-apply page, on load or after the one "Apply" control is opened, stops the run as
//    needs_user/login_required; a page asking for a code the employer emailed stops it as needs_user/email_code. Nothing
//    is typed into such a page (no field at all, so never a credential), nothing is sent, and the person signs in
//    themselves. The reason words are HANDOFF_REASONS, the same in apply-vm.cjs and scripts/apply.ts.
//  - at most once: a failure BEFORE the submit click is retried (fresh context); once submit is clicked the run is never
//    retried: a missing confirmation is unknown_outcome.
//  - local only by default: only loopback hosts are driven. Real employer hosts need `allowHosts` from the caller
//    (the owner-run approve-first path), and this module never discovers or logs in anywhere.
const fs = require("node:fs");
const { fillForm, heldNow } = require("./ats-fill.cjs");
const { APPLY_TEXT, NEVER_CLICK, applyUrlFor } = require("./apply-entry.cjs");
const crypto = require("node:crypto");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function payloadHash(p) {
  return sha256(canonical({ url: p.url, ats: p.ats, facts: p.facts, answers: p.answers || {}, resume: p.resume && p.resume.sha256 }));
}

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
// WO-M (architect, 2026-11-09): stop only when a check is actually SHOWN, never because a page loads a captcha script. An
// invisible reCAPTCHA / hCaptcha script (Greenhouse, Ashby load one on every form) put the word "captcha" in the page source,
// and the old test (BOT_RE over page.content()) stopped every such form before it was filled. Shown means one of:
//  - an explicit widget the person must complete (.g-recaptcha, .h-captcha, .cf-turnstile, not data-size="invisible");
//  - a challenge frame rendered on the page at a real size (reCAPTCHA anchor/bframe that is not size=invisible, hCaptcha,
//    Cloudflare challenges / Turnstile);
//  - the challenge's words in the text a person sees (innerText, never the source), or a Cloudflare interstitial page.
// Still never solved, never submitted past: a shown check stops the run as needs_user / bot_check.
function SHOWN_CHECK() {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  // Shown means a person can see it: at least 60x40 of it on the page (scrolling allowed), and neither it nor any parent hidden, collapsed or
  // transparent. reCAPTCHA keeps its challenge frame (bframe) on every page, hidden and off-screen until it raises one (every
  // Ashby form, strict benchmark run 42707036468).
  const onScreen = (e) => {
    // On the page, not parked above or left of it (a person scrolls down to a check below the fold; never to top:-10000px).
    const r = e.getBoundingClientRect(), top = r.top + scrollY, left = r.left + scrollX;
    const pageW = Math.max(document.documentElement.scrollWidth, innerWidth);
    if (r.width <= 60 || r.height <= 40 || top + r.height <= 0 || left + r.width <= 0 || left >= pageW) return false;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const text = ((document.body && document.body.innerText) || "").slice(0, 20000);
  if (/verify\s+(?:that\s+)?you(?:\s+are|['\u2019]re)\s+(?:a\s+)?(?:human|not a robot)|are you a robot|i['\u2019]?m not a robot|complete the (security )?check|press (and|&) hold/i.test(text)) return "text";
  if (/^(just a moment|attention required)/i.test(document.title || "")) return "interstitial";
  // A reCAPTCHA or hCaptcha container the page runs invisibly at its own click is not shown either: a hidden *-captcha-response
  // field with a hidden submit button in the same form (every captured Lever form), or the reCAPTCHA badge (Greenhouse, Ashby).
  // The 2026-11-09 benchmark (run 42676274898) saw 0 shown checks on these boards (architect ruling of 2026-10-19).
  const hiddenEl = (b) => !vis(b) || b.hidden || /(^|\s)hidden(\s|$)/.test(b.className || "");
  const runsInvisibly = (e) => {
    if (!e.matches(".g-recaptcha, .h-captcha")) return false;
    const scope = e.closest("form") || document;
    const token = [...scope.querySelectorAll("[name$='-captcha-response']")].some((t) => t.type === "hidden" || !vis(t));
    const hiddenSubmit = [...scope.querySelectorAll("button[type=submit], input[type=submit]")].some(hiddenEl);
    return (token && hiddenSubmit) || (e.matches(".g-recaptcha") && !!document.querySelector(".grecaptcha-badge"));
  };
  const widget = [...document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running")]
    .find((e) => (e.getAttribute("data-size") || "").toLowerCase() !== "invisible" && !/invisible/i.test(e.getAttribute("data-badge") || "") && !runsInvisibly(e)
      // A reCAPTCHA or hCaptcha container is shown only once it has drawn its checkbox: an empty 680x0 box (every live Lever
      // form, strict benchmark run 42696835430) is not something a person can see or tick.
      && (!e.matches(".g-recaptcha, .h-captcha") || onScreen(e)));
  const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${[...e.classList].slice(0, 3).map((c) => "." + c).join("")} ${e.offsetWidth}x${e.offsetHeight}${e.getAttribute("data-size") ? " size=" + e.getAttribute("data-size") : ""}${e.children.length ? " children=" + e.children.length : ""}`;
  if (widget) return `widget ${desc(widget)}`;
  const frame = [...document.querySelectorAll("iframe")].find((f) => {
    const src = f.src || "";
    if (!/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)|\/recaptcha\/anchor|hcaptcha\.com\/captcha|challenges\.cloudflare\.com|captcha-delivery\.com/i.test(src)) return false;
    if (/[?&]size=invisible\b/i.test(src)) return false;
    // hCaptcha's enclave frame (hcaptcha-enclave.html, #frame=enclave) is its background scoring frame on every Lever form, never
    // a challenge (strict benchmark run 42707036468); its checkbox and challenge frames are.
    if (/hcaptcha-enclave\.html|[#&]frame=enclave\b/i.test(src)) return false;
    return onScreen(f);
  });
  if (!frame) return null;
  let src = ""; try { const u = new URL(frame.src); src = u.host + u.pathname.slice(0, 50); } catch { /* opaque */ }
  return `frame ${src} ${frame.offsetWidth}x${frame.offsetHeight}`;
}
// The needs_user reasons a sign-in or verification wall gives, in every runner (apply-vm.cjs, scripts/apply.ts).
const HANDOFF_REASONS = ["login_required", "bot_check", "email_code"];
// Identity providers an employer's SSO sends a candidate to. Any host here, or any path that names a sign-in step, is a
// sign-in wall, not just a host the run may not drive.
const IDP_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "login.windows.net", "appleid.apple.com"];
const IDP_SUFFIXES = ["okta.com", "oktapreview.com", "okta-emea.com", "auth0.com", "onelogin.com", "pingone.com", "pingidentity.com", "duosecurity.com", "b2clogin.com", "jumpcloud.com"];
const SIGNIN_PATH = /\/(?:login|log-in|signin|sign-in|sso|saml2?|oauth2?|openid|oidc|authorize)(?:[/?#.;]|$)/i;
// Is this blocked navigation an SSO sign-in? Never for a denied host (LinkedIn's sign-in stays refused, not handed over).
function ssoSignIn(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  const host = normHost(url.hostname);
  if (isDeniedHost(host)) return false;
  if (IDP_HOSTS.includes(host) || IDP_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return SIGNIN_PATH.test(url.pathname);
}
// What kind of wall the page in front of the run is, or null. Read only: nothing on the page is touched.
// A password field anywhere is a wall (as before WO-L). A create-account or sign-in page counts only when the page has no
// file upload (an application form always asks for the resume), so a form that merely mentions an account is not one.
async function signInWall(page) {
  if (await page.$('input[type="password"]')) return "password";
  return page.evaluate(() => {
    const seen = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const text = ((document.body && document.body.innerText) || "").replace(/\s+/g, " ");
    const inputs = [...document.querySelectorAll("input")].filter((i) => seen(i) && !["hidden", "submit", "button"].includes(i.type));
    const named = (i) => `${i.name} ${i.id} ${i.autocomplete} ${i.getAttribute("aria-label") || ""} ${i.placeholder || ""}`;
    const codeBox = inputs.some((i) => i.autocomplete === "one-time-code" || /code|otp|one.?time|passcode/i.test(named(i)));
    if (codeBox && /\b(?:enter|type)\b.{0,40}\bcode\b|\bcode (?:we|that we) (?:sent|emailed)|\b(?:sent|emailed) (?:you )?(?:a|an) (?:\d[- ]digit |verification |security |one-time )?(?:code|passcode)/i.test(text)) return "email_code";
    if (document.querySelector('input[type="file"]')) return null;
    const emailBox = inputs.some((i) => i.type === "email" || /e-?mail/i.test(named(i)));
    if (emailBox && /\bcreate (?:an |your )?(?:candidate )?account\b|\bsign up to apply\b|\bregister to apply\b/i.test(text)) return "create_account";
    if (/\b(?:sign|log) ?in to (?:apply|continue)\b|\bplease (?:sign|log) ?in\b|\bsign in with (?:your )?(?:sso|company|work|google|microsoft)/i.test(text)) return "sign_in";
    return null;
  });
}
async function stopAtWall(page, url) {
  const w = await signInWall(page);
  if (w) throw new NeedsUser(w === "email_code" ? "email_code" : "login_required", url, w);
}
// The one "Apply" control on a job page that has no form yet: opened (never a control inside a form, never a new tab), so
// the wall or the form behind it can be read. Opening it sends nothing; the same host rules guard where it leads.
// A field of an application: inside a form, or (a board without a <form>, Ashby) the resume upload or an email box on the page.
const FIELD_SEL = "form input, form select, form textarea, input[type=file], input[type=email]";
async function openApply(page, timeout) {
  // Job pages repeat their Apply control (top and bottom of the posting): several controls are one control when they all lead
  // to the same address. Controls that lead to different places, or buttons with no address, stay ambiguous unless there is one.
  const h = (await page.evaluateHandle(([at, nc]) => {
    const re = new RegExp(at, "i"), never = new RegExp(nc, "i");
    const c = [...document.querySelectorAll("a, button, [role=button]")].filter((e) => {
      const t = (e.innerText || e.getAttribute("aria-label") || "").trim();
      return !e.closest("form") && (e.offsetWidth || e.offsetHeight) && re.test(t) && !never.test(t);
    });
    if (!c.length) return null;
    // Repeats of one control: every link goes to the same address and every button carries a link's words (Personio), or
    // there are no links and every button says the same thing (BambooHR). Anything else is ambiguous and is not clicked.
    const words = (e) => (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase();
    const links = c.filter((e) => e.tagName === "A" && e.href), buttons = c.filter((e) => !(e.tagName === "A" && e.href));
    let pick = null;
    if (links.length) {
      const hrefs = new Set(links.map((e) => e.href)), lw = new Set(links.map(words));
      if (hrefs.size === 1 && buttons.every((b) => lw.has(words(b)))) pick = links[0];
    } else if (new Set(buttons.map(words)).size === 1) pick = buttons[0];
    if (!pick) return null;
    pick.removeAttribute("target");
    return pick;
  }, [APPLY_TEXT.source, NEVER_CLICK.source])).asElement();
  if (!h) return false;
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => null), h.click()]);
  // A board that renders its form in place (no navigation) gets a moment to draw it.
  await page.waitForSelector(FIELD_SEL, { timeout: Math.min(timeout, 8000) }).catch(() => null);
  return true;
}
async function botCheck(page) {
  // The page and its own frames (an employer's site embedding the ATS form). A captcha provider's frame is judged from its
  // parent, by its iframe's src and rendered size: an invisible badge frame is not a shown check.
  for (const f of page.frames()) {
    if (f !== page.mainFrame() && /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile/i.test(f.url())) continue;
    const shown = await f.evaluate(SHOWN_CHECK).catch(() => null);
    if (shown) return String(shown).slice(0, 160); // what was shown, for the record (truthy)
  }
  return false;
}
const hasApproval = (p) => !!p.approval && typeof p.approval.approval_id === "string" && p.approval.approval_id.trim() !== ""
  && typeof p.approval.hash === "string" && p.approval.hash === payloadHash(p);
const CONFIRM_RE = /thank you for applying|application (has been )?submitted|we['’]ve received your application/i;

class NeedsUser extends Error { constructor(reason, field, wall) { super(`${reason}${field ? `: ${field}` : ""}`); this.reason = reason; this.field = field; this.needs = null; this.wall = wall || null; } }

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
// What a page showed when the run stopped, for a benchmark's record only: the control the stop names, the apply controls, the
// forms, frames and captcha containers on the page. Plain data, cut short; nothing typed by the person is on a benchmark page.
function DIAG(field) {
  const cut = (x, n = 300) => String(x || "").replace(/\s+/g, " ").slice(0, n);
  const out = { url: location.href.slice(0, 120), title: cut(document.title, 80), forms: document.forms.length,
    inputs: document.querySelectorAll("input:not([type=hidden]), textarea, select").length };
  if (field && !/^https?:/.test(field)) {
    const want = field.toLowerCase().slice(0, 30);
    const cands = [...document.querySelectorAll("label, legend, [id*=label], .application-label")].filter((e) => (e.innerText || "").toLowerCase().includes(want));
    const lab = cands.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
    const box = lab && (lab.closest(".application-question, .field, .form-group, li, fieldset") || lab.parentElement);
    if (box && box.outerHTML.length > 4000) out.field_note = "container too large; label only";
    out.field = cut(box ? box.outerHTML : lab ? lab.outerHTML : "", 600);
  }
  out.captcha = [...document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*=captcha], iframe[src*=challenges]")].slice(0, 3)
    .map((e) => cut(`${e.tagName} ${e.className || ""} ${e.getAttribute("src") || ""} ${e.offsetWidth}x${e.offsetHeight} vis=${getComputedStyle(e).visibility}`, 160));
  out.apply = [...document.querySelectorAll("a, button, [role=button]")].filter((e) => /apply|bewerb|postul|solicit|interest|candidat/i.test(e.innerText || ""))
    .slice(0, 5).map((e) => cut(`${e.tagName} "${(e.innerText || "").trim()}" ${e.getAttribute("href") || ""} ${e.offsetWidth}x${e.offsetHeight}`, 140));
  out.frames = [...document.querySelectorAll("iframe")].slice(0, 4).map((f) => cut(f.getAttribute("src"), 100));
  return out;
}
async function attempt(browser, p, opts, timing) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.stepTimeoutMs || 15000);
  const allow = opts.allowHosts || [];
  const blocked = [], blockedUrls = [];
  // A new tab (window.open, target=_blank) is never driven: it is closed before it loads.
  ctx.on("page", (other) => { if (other !== page) other.close().catch(() => {}); });
  // Main-frame navigations (the first load, every redirect hop, any later navigation) to a host that is denied or not allowed
  // are aborted before a request leaves the browser.
  // GET navigations are fetched with redirects off so the Location of each hop is checked BEFORE the browser requests it
  // (a browser-followed redirect would already have reached the other host); the 3xx is handed back and the next hop comes
  // through this same handler.
  // A benchmark's dry run (scripts/browser-eval/strict.cjs) adds its own guard on every request and a page script that cancels
  // any form submit; production passes neither.
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    if (opts.requestGate && !(await opts.requestGate(req))) return route.abort("blockedbyclient");
    // Every top-level navigation, of this page or of any tab it tries to open, is checked.
    if (req.isNavigationRequest() && !req.frame().parentFrame()) {
      const g = urlVerdict(req.url(), allow);
      if (!g.ok) { blocked.push(g.host); blockedUrls.push(req.url()); return route.abort("blockedbyclient"); }
      if (req.method() === "GET") {
        const resp = await route.fetch({ maxRedirects: 0 });
        const loc = resp.status() >= 300 && resp.status() < 400 ? resp.headers().location : null;
        if (loc) {
          const to = new URL(loc, req.url()).href;
          const next = urlVerdict(to, allow);
          if (!next.ok) { blocked.push(next.host); blockedUrls.push(to); return route.abort("blockedbyclient"); }
        }
        return route.fulfill({ response: resp });
      }
    }
    return route.continue();
  });
  const onAllowedHost = () => {
    // An employer that sends the candidate to its SSO: a sign-in wall the person finishes themselves, not a refused host.
    if (blocked.length && ssoSignIn(blockedUrls[0])) throw new NeedsUser("login_required", blocked[0], "sso_redirect");
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
    { const shown = await botCheck(page); if (shown) { const e = new NeedsUser("bot_check", p.url); e.detail = shown; throw e; } }
    // An employer that wants the person to sign in first: never signed into, never given a password (the person does that).
    await stopAtWall(page, p.url);
    // The form's own Submit control, as a person would press it: the visible one. A <button> with no type submits its form
    // (Breezy); Lever's visible "Submit application" is type="button" beside a hidden type="submit" its script presses
    // after the hCaptcha token. Marked data-upmore-submit, so the check below and the click use that same control.
    const markSubmit = () => page.evaluate(() => {
      const vis = (e) => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== "hidden";
      for (const e of document.querySelectorAll("[data-upmore-submit]")) e.removeAttribute("data-upmore-submit");
      const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelector("input, select, textarea"));
      const word = /^\s*(submit|send|apply)( (my|your))?( application| now)?\s*$|^\s*(bewerbung )?(absenden|senden)\s*$|^\s*(envoyer|enviar|verzenden|skicka)( .{0,20})?$/i;
      for (const f of forms) {
        const typed = [...f.querySelectorAll("button[type=submit], button:not([type]), input[type=submit]")].filter(vis);
        const worded = [...f.querySelectorAll("button, [role=button], input[type=button]")].filter((b) => vis(b) && word.test(b.innerText || b.value || ""));
        const pick = worded.length === 1 ? worded[0] : typed.length === 1 ? typed[0] : worded.find((b) => typed.includes(b)) || null;
        if (pick) { pick.setAttribute("data-upmore-submit", "1"); return true; }
      }
      // A board that builds its application without a <form> (Ashby: every posting, strict benchmark run 42712892939, forms=0 with
      // 19 to 48 fields): the page is the form when it has no form of its own, asks for a file or an email, and has exactly one
      // visible control in the Submit words. Two or none: no Submit is pressed.
      if (!forms.length && document.querySelector("input[type=file], input[type=email]")) {
        const worded = [...document.querySelectorAll("button, [role=button], input[type=button], input[type=submit]")].filter((b) => vis(b) && word.test(b.innerText || b.value || ""));
        if (worded.length === 1) { worded[0].setAttribute("data-upmore-submit", "1"); return true; }
      }
      return false;
    });
    const hasForm = async () => !!(await page.$(FIELD_SEL)) && (await markSubmit());
    // A board whose form lives at its own apply address one GET away (Lever /apply, Ashby /application, ...): loaded once,
    // through the same host rules, and checked like the first load.
    if (!(await page.waitForSelector(FIELD_SEL, { timeout: 5000 }).catch(() => null))) {
      const direct = applyUrlFor(p.ats, page.url());
      if (direct) {
        try { await page.goto(direct, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
        onAllowedHost();
        await page.waitForSelector(FIELD_SEL, { timeout: 8000 }).catch(() => null);
        { const shown = await botCheck(page); if (shown) { const e = new NeedsUser("bot_check", p.url); e.detail = shown; throw e; } }
        await stopAtWall(page, p.url);
      }
    }
    // A job page whose form is behind its "Apply" control: opened once, and what it leads to is checked like the first load.
    if (!(await hasForm()) && (await openApply(page, opts.stepTimeoutMs || 15000))) {
      onAllowedHost();
      { const shown = await botCheck(page); if (shown) { const e = new NeedsUser("bot_check", p.url); e.detail = shown; throw e; } }
      await stopAtWall(page, p.url);
    }
    timing.load = Date.now() - t0;
    const t1 = Date.now();
    if (!(await hasForm())) throw new NeedsUser("no_application_form_found", p.url);
    // The page's own questions, answered only from the approved facts / answers (ats-fill.cjs), each read back. A required
    // question with no confirmed answer, or one that could not be set and checked, stops the run: the person is asked.
    const fr = await fillForm(page, { ats: p.ats, facts: p.facts, answers: p.answers || {}, resumePath: p.resume.path });
    if (fr.needsUser.length) {
      const first = fr.needsUser[0];
      const e = new NeedsUser(first.reason === "no_confirmed_answer" || /^(agreement|eeo|upload)_/.test(first.reason) || first.reason === "no_resume" ? "missing_required_answer" : "field_not_filled", first.label);
      e.needs = fr.needsUser.map((n) => ({ label: n.label, reason: n.reason, ...(n.kind ? { kind: n.kind } : {}), ...(n.detail ? { detail: String(n.detail).slice(0, 400) } : {}), ...(Array.isArray(n.options) ? { options: n.options.slice(0, 60) } : {}) }));
      throw e;
    }
    if (fr.invalid.length) { const e = new NeedsUser("field_not_filled", fr.invalid[0].name); e.needs = fr.invalid.map((n) => ({ label: n.name, reason: "form_rejects_value" })); throw e; }
    // An optional question whose approved answer could not be set and read back (readback_mismatch, fill_error) is not a
    // question to skip: the field may hold something the person never approved. Handed back like a required one; nothing is sent
    // (independent review of #340: Submit used to go with such a field).
    if (fr.failed && fr.failed.length) { const e = new NeedsUser("field_not_filled", fr.failed[0].label); e.needs = fr.failed.map((n) => ({ label: n.label, reason: n.reason })); throw e; }
    const filled = fr.filled.map((f) => ({ field: f.label, source: f.source }));
    timing.fill = Date.now() - t1;
    // Last checks before the click, on what is actually on the page now: still an allowed host, no bot check that appeared
    // while filling, the form posts to an allowed host, and the payload still hashes to what was approved.
    onAllowedHost();
    { const shown = await botCheck(page); if (shown) { const e = new NeedsUser("bot_check", p.url); e.detail = shown; throw e; } }
    await stopAtWall(page, p.url);
    if (!(await markSubmit())) throw new NeedsUser("no_submit_control", p.url);
    const action = await page.$eval("[data-upmore-submit]", (b) => {
      const a = b.getAttribute("formaction") ?? (b.form && b.form.getAttribute("action"));
      return new URL(a || location.href, document.baseURI).href;
    });
    const av = urlVerdict(action, allow);
    if (!av.ok) throw new NeedsUser("form_action_not_allowed", av.host);
    if (!hasApproval(p)) throw new NeedsUser("not_approved", "payload changed after approval");
    if (opts.shotBefore) await page.screenshot({ path: opts.shotBefore, fullPage: true });
    // The caller records "submitting" (and re-checks its lease and kill switch) BEFORE the click; a refusal stops here, unsent.
    // A dry run's audit (opts.audit) also gets what each filled question holds at this instant; production passes only the phase.
    if (opts.onPhase) await opts.onPhase("submitting", opts.audit ? { id: p.id, fields: await heldNow(page, fr.filled) } : undefined);
    // Past this line nothing is retried: the employer may have received it.
    const t2 = Date.now();
    timing.submitClicked = true;
    try {
      await Promise.all([page.waitForLoadState("domcontentloaded"), page.click("[data-upmore-submit]")]);
      await page.waitForSelector("#confirmation, h1", { timeout: opts.stepTimeoutMs || 15000 });
      if (blocked.length) return { status: "unknown_outcome", reason: `after submit: navigation to a disallowed host was refused (${blocked[0]})`, filled };
    } catch (e) {
      return { status: "unknown_outcome", reason: `after submit: ${e.message.split("\n")[0]}`, filled };
    }
    timing.submit = Date.now() - t2;
    const text = (await page.textContent("body")) || "";
    if (opts.shotAfter) await page.screenshot({ path: opts.shotAfter, fullPage: true });
    if (!CONFIRM_RE.test(text)) {
      // The page's own check can become a shown challenge at the click: the person finishes it; it is never solved or retried.
      if (await botCheck(page)) return { status: "unknown_outcome", reason: "after submit: the page showed a verification check; nothing is confirmed until you finish it", filled };
      return { status: "unknown_outcome", reason: "no confirmation text on the page after submit", filled };
    }
    const code = /\b(?:GH|LV)-[A-Z0-9-]+/.exec(text);
    return { status: "submitted_page_confirmed", confirmation: code ? code[0] : null, filled };
  } catch (e) {
    // A benchmark's dry run asks what the page showed at a stop (opts.diag); production never does.
    if (opts.diag && e instanceof NeedsUser) e.diag = await page.evaluate(DIAG, e.field || "").catch(() => null);
    throw e;
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
      if (e instanceof NeedsUser && !t.submitClicked) return { ...out, ...(e.detail ? { check: e.detail } : {}), ...(e.diag ? { diag: e.diag } : {}), status: HANDOFF_REASONS.includes(e.reason) ? "needs_user" : "not_submitted", reason: e.reason, field: e.field, wall: e.wall || undefined, needs: e.needs || undefined, ms: Date.now() - started };
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

module.exports = { botCheck, SHOWN_CHECK, applyOne, runPool, payloadHash, checkPayload, sha256, urlVerdict, ssoSignIn, DENY_HOSTS, HANDOFF_REASONS, NeedsUser };
