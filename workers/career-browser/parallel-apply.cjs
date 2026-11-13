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
const { fillForm, heldNow, recheckFilled, MARK_SIGNIN, EXTRACT } = require("./ats-fill.cjs");
const { APPLY_TEXT, NEVER_CLICK, OVERLAY_APPLY, CLOSED_MARK, CLOSED_TEXT, applyUrlFor } = require("./apply-entry.cjs");
const { buildHandoff, PERSON_REASONS, pageDigest, unconfirmedDefaults } = require("./handoff.cjs");
const NOT_OFFERED = new Set(["no_matching_option", "ambiguous_option"]);
const crypto = require("node:crypto");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function payloadHash(p) {
  return sha256(canonical({ url: p.url, ats: p.ats, facts: p.facts, answers: p.answers || {}, resume: p.resume && p.resume.sha256 }));
}

// The same hosts as apply-vm.cjs REFUSED and apply-scheduler.cjs NEVER_HOSTS (lnkd.in is LinkedIn's link shortener).
const DENY_HOSTS = ["linkedin.com", "lnkd.in", "indeed.com", "joinhandshake.com", "handshake.com"];
// The browser itself cannot resolve a denied host (x-audit, 2026-11-10): every request to one, including a redirect hop
// the route handler never sees (a POST's 303, a hop inside a frame), fails with ERR_NAME_NOT_RESOLVED before it leaves the
// machine. Every runner that launches Chromium for an application launches it with denyLaunchOptions(). A proxy would
// resolve names itself, so the denied hosts also bypass any proxy (a --proxy-server flag, or the https_proxy environment
// Chromium reads on Linux): Chromium resolves them here, and they do not resolve.
const DENY_HOST_RULES = DENY_HOSTS.flatMap((d) => [`MAP ${d} ~NOTFOUND`, `MAP *.${d} ~NOTFOUND`]).join(", ");
const DENY_LAUNCH_ARGS = [`--host-resolver-rules=${DENY_HOST_RULES}`,
  `--proxy-bypass-list=${DENY_HOSTS.flatMap((d) => [d, `*.${d}`]).join(";")}`];
function denyLaunchOptions(o = {}, env = process.env) {
  const base = o.env || env;
  const noProxy = [base.no_proxy || base.NO_PROXY || "", ...DENY_HOSTS, ...DENY_HOSTS.map((d) => `.${d}`)].filter(Boolean).join(",");
  return { ...o, args: [...(o.args || []), ...DENY_LAUNCH_ARGS], env: { ...base, no_proxy: noProxy, NO_PROXY: noProxy } };
}
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
  const h = (await page.evaluateHandle(([at, nc, overlay]) => {
    const re = new RegExp(at, "i"), never = new RegExp(nc, "i");
    // Teamtailor's Apply control by its declared action (apply-entry.cjs OVERLAY_APPLY), outside every form, not a submit: the first
    // visible one (the board draws it twice, in the page and as a bar fixed to the bottom).
    const ov = [...document.querySelectorAll(overlay)].find((e) => !e.closest("form") && (e.offsetWidth || e.offsetHeight) && (e.getAttribute("type") || "").toLowerCase() !== "submit");
    if (ov) return ov;
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
  }, [APPLY_TEXT.source, NEVER_CLICK.source, OVERLAY_APPLY])).asElement();
  if (!h) return false;
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => null), h.click()]);
  // A board that renders its form in place (no navigation) gets a moment to draw it.
  await page.waitForSelector(FIELD_SEL, { timeout: Math.min(timeout, 8000) }).catch(() => null);
  return true;
}
// D-072 (item 4): a shown check that sits INSIDE the application form (BambooHR draws a reCAPTCHA checkbox above its Submit on every
// form, strict benchmark run 43192269304: 76 of 80 postings) is a wall at the end of the form, not at its door: everything else
// is filled and read back first, and the run stops at the check, untouched, as needs_user / bot_check with wall check_in_form.
// A check over the whole page (a Cloudflare or DataDome challenge, an interstitial, a check outside any form) still stops the
// run on load, before anything is typed. Read only: the check is never clicked, typed into or scored.
function CHECK_IN_FORM() {
  const sel = ".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha/api2/anchor'], iframe[src*='recaptcha/enterprise/anchor'], iframe[src*='hcaptcha.com/captcha'], iframe[src*='challenges.cloudflare.com']";
  if (/^(just a moment|attention required)/i.test(document.title || "")) return false;
  const checks = [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 60 && e.offsetHeight > 40);
  if (!checks.length) return false;
  return checks.every((e) => {
    const f = e.closest("form");
    if (!f || f.hasAttribute("data-upmore-signin")) return false;
    const fields = [...f.querySelectorAll("input, select, textarea")].filter((i) => !["hidden", "submit", "button"].includes(i.type) && !/captcha/i.test(i.name || ""));
    // A whole-page challenge covers the page; an in-form check is a small box among the form's own questions.
    return fields.length >= 3 && e.offsetWidth < innerWidth * 0.8 && e.offsetHeight < 200;
  });
}
// D-072: the posting's own page says it is gone (Greenhouse ?error=true, Workable ?not_found=true, BambooHR / Breezy sending the
// posting's link back to the job list). Named posting_closed, the real reason, instead of "no application form found".
function closedAfterLoad(asked, landed) {
  let a, b;
  try { a = new URL(asked); b = new URL(landed); } catch { return false; }
  return /[?&](?:error|not_found)=true\b/.test(b.search) && !/[?&](?:error|not_found)=true\b/.test(a.search);
}
// Review of #797: the posting's link sent to the same host's front page or job list (BambooHR, Breezy) says the link moved, not
// that the posting is closed (a renamed slug, a board that routes through its list). Closed only when that page says so
// (closedOnPage); otherwise the run stops as posting_not_confirmed_closed: nothing on a job list is this posting's form.
function sentToJobList(asked, landed) {
  let a, b;
  try { a = new URL(asked); b = new URL(landed); } catch { return false; }
  return b.host === a.host && a.pathname.replace(/\/+$/, "").length > 1 && a.pathname.replace(/\/+$/, "") !== b.pathname.replace(/\/+$/, "")
    && /^\/(?:careers|jobs)?\/?$/.test(b.pathname);
}
// Review of #797: a shown check is remembered for the whole run. `seen` is the in-form check an earlier gate noted, `shown` what is
// on the page now, `inForm` whether that is inside the application form. On the way in ("enter") an in-form check is noted and the
// step is filled first; any other shown check stops the run. Before the step form's Continue ("continue") and before Submit
// ("submit") a check shown now OR seen on any earlier step stops the run: a step that hides its check has not passed it. The stop
// is the hand-off to the person (needs_user / bot_check); the check is never clicked, typed into or scored.
function checkGate(seen, shown, inForm, phase) {
  if (phase === "enter") {
    if (!shown) return { seen: seen || null, stop: null };
    if (inForm) return { seen: seen || shown, stop: null };
    return { seen: seen || null, stop: { wall: seen ? "check_in_form" : null, detail: shown } };
  }
  if (!shown && !seen) return { seen: null, stop: null };
  return { seen: seen || shown, stop: { wall: seen || inForm ? "check_in_form" : null, detail: shown || seen } };
}
// Review of #797: which form is the application and which control is its Submit, decided here on what the page-side reader (SNAP)
// saw, so the rule is one tested function. The words are the boards' own (D-072 round 2: Recruitee's "Sūtīt", "Wyślij").
//  - An application form has a file upload (the resume), or two or more questions of which one is more than an email box, a
//    tick box or a search box (a name, a phone, a question of the employer's); a newsletter, job-alert or search box is not
//    one, and neither its fields nor its button are ever used.
//  - The Submit is a control OF that form: inside it, or tied to it by its own form attribute. A control outside every form is never
//    a form's Submit. When an application form has no Submit of its own and the page shows a Submit-worded control outside it, the
//    run is refused before anything is filled (submit_not_tied_to_form); `opener` says every such control is in the Apply words
//    (apply-entry.cjs), so it may be opened once, as a job page's Apply control always was, and the page read again.
//  - A board with no <form> at all (Ashby): the page is the form when its own fields are an application's and it has exactly one
//    visible Submit-worded control.
const SUBMIT_WORD = /^\s*(submit|send|apply)( (my|your))?( application| now)?\s*$|^\s*(bewerbung )?(absenden|senden|abschicken)\s*$|^\s*(sollicitatie )?(versturen|verzenden|verstuur|indienen)\s*$|^\s*(envoyer|enviar|verzenden|skicka|sende|send inn|indsend|l[äa]het[äa]|wy[śs]lij|s[ūu]t[īi]t|si[ųu]sti|saada|odeslat|odosla[ťt]|invia|inviare|trimite|g[öo]nder|k[üu]ld[ée]s|po[šs]alji|po[šs]lji|изпрати|отправить|надіслати|αποστολή|υποβολή)( .{0,24})?$/i;
const NEXT_WORD = /^\s*(continue|next|next step|weiter|suivant|siguiente|volgende|avanti|pr[oó]ximo)\s*[›»>→]?\s*$/i;
const PLAIN_SUBMIT = /^\s*(submit|send|apply)( (my|your))?( application| now)?\s*$/i;
const NOT_APPLICATION = /subscribe|newsletter|sign ?up|notify|alert|search|abonn|suchen/i;
const isApplicationForm = (fields = []) => fields.some((f) => f.type === "file") || (fields.length >= 2 && fields.some((f) => !["email", "checkbox", "search"].includes(f.type)));
function pickControls(snap) {
  const none = { form: null, submit: null, next: null, refuse: null };
  const ctl = (snap.controls || []).filter((c) => !c.signin);
  const forms = (snap.forms || []).map((f, i) => ({ ...f, i })).filter((f) => f.hasControl && !f.signin);
  // `was`: this run already took the form as the application (a board that swaps the upload's input for a chip once the resume is set).
  const apps = forms.filter((f) => f.was || isApplicationForm(f.fields));
  const typed = (c) => (c.tag === "BUTTON" && (c.type === "submit" || c.type === "")) || (c.tag === "INPUT" && c.type === "submit");
  for (const f of apps) {
    const own = ctl.filter((c) => c.form === f.i && c.vis), t = own.filter(typed), declared = t.filter((c) => c.type === "submit"), worded = own.filter((c) => SUBMIT_WORD.test(c.text));
    // A control the form itself declares its Submit (type="submit") is preferred over a button with no type beside it.
    const pick = worded.length === 1 ? worded[0] : t.length === 1 ? t[0] : worded.find((b) => t.includes(b)) || (declared.length === 1 ? declared[0] : null);
    if (pick && !NOT_APPLICATION.test(pick.text)) return { ...none, form: f.i, submit: pick.c };
  }
  // A form shown in steps (Breezy): one visible "Continue" (not a submit, so pressing it posts nothing) with the form's Submit
  // drawn but hidden until the last step. Two such controls, a submit-typed one, or no hidden Submit beside it: not a step form.
  for (const f of apps) {
    const mine = ctl.filter((c) => c.form === f.i && c.inside), nexts = mine.filter((c) => c.vis && NEXT_WORD.test(c.text));
    const hiddenSubmit = mine.some((c) => !c.vis && (c.tag === "BUTTON" || c.tag === "INPUT") && PLAIN_SUBMIT.test(c.text));
    if (nexts.length === 1 && hiddenSubmit && nexts[0].type !== "submit" && (nexts[0].tag !== "BUTTON" || nexts[0].type === "button")) return { ...none, form: f.i, next: nexts[0].c };
  }
  const loose = ctl.filter((c) => c.vis && c.form < 0 && SUBMIT_WORD.test(c.text));
  if (!forms.length) return isApplicationForm(snap.loose) && loose.length === 1 ? { ...none, form: -1, submit: loose[0].c } : none;
  if (apps.length && loose.length) return { ...none, refuse: "submit_not_tied_to_form", opener: loose.every((c) => APPLY_TEXT.test(c.text) && !NEVER_CLICK.test(c.text)) };
  return none;
}
// Page side: every form (its questions as { type, hint }, shadow roots included), the fields outside every form, and every control
// a person could press, numbered (data-upmore-c) so the one Node picks can be marked. Read only but for that number.
function SNAP() {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== "hidden";
  const squash = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const deep = (root, sel) => { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); if (c.shadowRoot) walk(c.shadowRoot); walk(c); } }; walk(root); return out; };
  const isField = (i) => !["hidden", "submit", "button", "image", "reset"].includes(i.type);
  const field = (i) => ({ type: i.type || "", hint: squash(`${(i.labels && i.labels[0] && i.labels[0].innerText) || ""} ${i.getAttribute("aria-label") || ""} ${i.placeholder || ""} ${i.name || ""} ${i.id || ""} ${i.autocomplete || ""}`).slice(0, 240) });
  const forms = [...document.querySelectorAll("form")];
  const controls = [...document.querySelectorAll("button, [role=button], input[type=button], input[type=submit]")].map((b, c) => {
    b.setAttribute("data-upmore-c", String(c));
    const f = b.form || b.closest("form");
    return { c, form: f ? forms.indexOf(f) : -1, inside: !!b.closest("form"), vis: vis(b), text: squash(b.innerText || b.value).slice(0, 120), tag: b.tagName, type: (b.getAttribute("type") || "").toLowerCase(), signin: !!b.closest("[data-upmore-signin]") };
  });
  return { controls, forms: forms.map((f) => ({ signin: f.hasAttribute("data-upmore-signin"), was: f.hasAttribute("data-upmore-app-seen"), hasControl: !!f.querySelector("input, select, textarea"), fields: deep(f, "input, select, textarea").filter(isField).map(field) })),
    loose: deep(document.body, "input, select, textarea").filter((i) => isField(i) && !i.closest("form") && !i.closest("[data-upmore-signin]")).map(field) };
}
// Page side: mark what pickControls chose: the application form (data-upmore-app: the one form ats-fill reads and fills), its
// Submit (data-upmore-submit) or its one Continue (data-upmore-next). Every older mark is cleared first.
function MARK(pick) {
  for (const a of ["data-upmore-submit", "data-upmore-next", "data-upmore-app"]) for (const e of document.querySelectorAll(`[${a}]`)) e.removeAttribute(a);
  const f = pick.form >= 0 ? document.querySelectorAll("form")[pick.form] : null;
  if (f) { f.setAttribute("data-upmore-app", "1"); f.setAttribute("data-upmore-app-seen", "1"); }
  for (const [k, a] of [["submit", "data-upmore-submit"], ["next", "data-upmore-next"]]) { const e = pick[k] === null || pick[k] === undefined ? null : document.querySelector(`[data-upmore-c="${pick[k]}"]`); if (e) e.setAttribute(a, "1"); }
}
// The last look before the click: the control about to be pressed belongs to the form that was filled, and every filled question
// is in that form. `t` is read from the page (attempt): formless (no form was marked), anyForm, sameForm, filledOutside.
const submitTieRefusal = (t) => ((t.formless ? !t.anyForm : t.sameForm && !t.filledOutside) ? null : "submit_not_tied_to_form");
// Page side, read only: what every control of the application form holds now (the whole page for a board with no <form>): the
// rows of handoff.cjs pageRows. A box or radio by its own option (value null when not ticked), a select by its chosen options'
// words (null on its empty placeholder), an upload by its file's name. `touched`: the engine filled that question (filledQs).
function CONTROLS(filledQs) {
  const app = document.querySelector("form[data-upmore-app]");
  const squash = (x) => String(x || "").replace(/\s+/g, " ").trim();
  return (app ? [...app.elements] : [...document.querySelectorAll("input, select, textarea")])
    .filter((e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !["submit", "button", "image", "reset", "password"].includes(e.type) && !e.closest("[data-upmore-signin]")).map((e) => {
      const box = e.type === "checkbox" || e.type === "radio", q = e.getAttribute("data-upmore-q");
      const value = box ? (e.checked ? squash(e.value) || "on" : null) : e.tagName === "SELECT" ? [...e.selectedOptions].filter((o) => o.value !== "").map((o) => squash(o.textContent)).join(", ") || null
        : e.type === "file" ? [...(e.files || [])].map((f) => f.name).join(", ") || null : String(e.value) === "" ? null : String(e.value);
      return { name: e.name || "", label: squash((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute("aria-label") || e.placeholder).slice(0, 200), type: e.type, option: box ? squash(e.value) : null, value, q, touched: q !== null && filledQs.includes(q), hidden: e.type === "hidden" };
    });
}
// D-072: an employer page that embeds the board's own form in a frame (Greenhouse's job_app embed on bitwarden.com, lucidmotors.com):
// the frame's address, when it is on an allowed host, is the application form one GET away.
async function embeddedFormUrl(page, allow) {
  const srcs = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.src || "")).catch(() => []);
  for (const src of srcs) {
    let u; try { u = new URL(src); } catch { continue; }
    if (!/\/embed\/job_app\b|\/embed\/job_board\/?$/.test(u.pathname) && !/[?&]for=/.test(u.search)) continue;
    if (/\/embed\/job_board/.test(u.pathname)) continue;
    if (urlVerdict(u.href, allow).ok) return u.href;
  }
  return null;
}
// D-072 (item 4, round 2): does the page say the posting is closed (apply-entry.cjs CLOSED_MARK / CLOSED_TEXT)? Read only, and only
// asked when no application form was found: words in a form's own questions are never read as a closed posting.
async function closedOnPage(page) {
  return page.evaluate(([mark, re]) => {
    if ([...document.querySelectorAll(mark)].some((e) => e.offsetWidth || e.offsetHeight || e.getClientRects().length)) return true;
    return new RegExp(re, "i").test(((document.body && document.body.innerText) || "").slice(0, 6000));
  }, [CLOSED_MARK, CLOSED_TEXT.source]).catch(() => false);
}
// D-072 (item 4, round 2): a cookie-consent layer drawn over the whole form (Workable's full-page backdrop, z-index 999999: 7 rows of
// "option covered" in strict run 43276162667) is closed with its own DECLINE control: never "accept", never anything else. A fresh
// browser context per run keeps nothing afterwards. One click at most; no layer, nothing pressed.
async function declineCookies(page) {
  const h = (await page.evaluateHandle(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== "hidden";
    const byId = [...document.querySelectorAll("[data-ui='cookie-consent-decline'], #onetrust-reject-all-handler, [data-automation-id='legalNoticeDeclineButton'], #CybotCookiebotDialogBodyButtonDecline")].find(vis);
    if (byId) return byId;
    const words = /^\s*(decline|reject|refuse|deny)( all)?( (cookies|non-?essential( cookies)?|optional( cookies)?|non-?necessary( cookies)?))?\s*$/i;
    return [...document.querySelectorAll("button, [role=button]")].find((b) => {
      if (!vis(b) || b.closest("form") || !words.test(b.innerText || "")) return false;
      for (let a = b.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) if (/cookie/i.test((a.innerText || "").slice(0, 2000))) return true;
      return false;
    }) || null;
  }).catch(() => null))?.asElement?.();
  if (!h) return false;
  await h.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
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

class NeedsUser extends Error { constructor(reason, field, wall) { super(`${reason}${field ? `: ${field}` : ""}`); this.reason = reason; this.field = field; this.needs = null; this.wall = wall || null; this.filled = null; this.at = null; } }

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
  // The visible controls a person could press (their words, type, and whether a form holds them): why no Submit was marked.
  out.buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")].filter((b) => b.offsetWidth || b.offsetHeight)
    .slice(0, 10).map((b) => cut(`${b.tagName} ${b.getAttribute("type") || ""} "${(b.innerText || b.value || "").trim()}" ${b.closest("form") ? "in-form" : "outside"}`, 80));
  return out;
}
// D-072 (item 4, round 2): the board's own redirect of a posting to the same employer's own copy of that posting (Workable's
// apply.workable.com/j/7046AFAA95 to apply.belmond.com/_/j/7046AFAA95, the employer's Workable site; Greenhouse's
// job-boards.greenhouse.io/cribl/jobs/5971252004 to cribl.io/...?gh_jid=5971252004, the employer's page that embeds the board's form;
// strict run 43276162667: 6 rows "redirect_off_board"). Followed only when the hop comes from a host the run was already allowed on,
// the target is https and not denied, and the target carries the posting's own id (a path segment or a query value, exactly).
// Anything else stays redirect_not_allowed. The id is the posting's: a run of 5+ digits, an 8+ capital-letter-and-digit code with a digit (Workable),
// or a UUID, taken from the posting's own path.
// A posting segment with its title after it ("8589342-category-retail-manager") is its number.
const slugless = (x) => String(x).replace(/^(\d{5,})-.*$/, "$1");
function postingIds(u) {
  let url; try { url = new URL(u); } catch { return []; }
  return url.pathname.split("/").map(slugless).filter((x) => /^\d{5,}$/.test(x) || (/^[A-Z0-9]{8,}$/.test(x) && /\d/.test(x)) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x));
}
function samePostingRedirect(from, to, posting, allow) {
  let a, b; try { a = new URL(from); b = new URL(to); } catch { return false; }
  if (b.protocol !== "https:" || isDeniedHost(b.hostname) || !urlVerdict(a.href, allow).ok) return false;
  const ids = postingIds(posting);
  if (!ids.length) return false;
  const parts = new Set([...b.pathname.split("/"), ...[...b.searchParams.values()]].map(slugless));
  return ids.some((id) => parts.has(id));
}
// The employer's own page a same-posting redirect led to (its host is in `followed`) is never the application form itself: the
// host it is refused as, or null when the page may hold the form (a host no redirect added, or Workable's own app on the
// employer's domain, /_/j/<id>). A page whose address cannot be read is refused.
function followedPageRefusal(pageUrl, ats, followed) {
  let u; try { u = new URL(pageUrl); } catch { return "unreadable_page_address"; }
  const host = normHost(u.hostname);
  if (!followed || !followed.has(host)) return null;
  if (ats === "workable" && /^\/_\/j\/[A-Z0-9]+(\/apply)?\/?$/.test(u.pathname)) return null;
  return host;
}
// A posting whose link the board sends to a "not found" page (Lever's cyara posting to apply.workable.com/...?not_found=true): closed.
const NOT_FOUND_URL = /[?&](?:error|not_found)=true\b/;
async function attempt(browser, p, opts, timing) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(opts.stepTimeoutMs || 15000);
  // A copy: a same-posting redirect (samePostingRedirect) adds the employer's own host for this attempt only.
  const allow = [...(opts.allowHosts || [])];
  // The employer hosts a same-posting redirect added: their own pages are never the application form themselves (below).
  const followed = new Set();
  const blocked = [], blockedUrls = [];
  // A new tab (window.open, target=_blank) is never driven: it is closed before it loads.
  ctx.on("page", (other) => { if (other !== page) other.close().catch(() => {}); });
  // Main-frame navigations (the first load, every redirect hop, any later navigation) to a host that is denied or not allowed
  // are aborted before a request leaves the browser.
  // GET navigations are fetched with redirects off so the Location of each hop is checked BEFORE the browser requests it
  // (a browser-followed redirect would already have reached the other host); the 3xx is handed back and the next hop comes
  // through this same handler. A POST (the Submit click) is continued untouched: route.fetch drops a multipart file body,
  // so its redirect hops are guarded by denyLaunchOptions() at the browser's resolver instead (x-audit, 2026-11-10).
  // A frame inside the page is never loaded from a denied host (x-audit: an embedded linkedin.com frame used to load). It
  // is refused quietly: the employer's form around it is still the person's approved application.
  // A benchmark's dry run (scripts/browser-eval/strict.cjs) adds its own guard on every request and a page script that cancels
  // any form submit; production passes neither.
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  // A request still being judged when its page or context closes (a timeout's teardown) rejects inside the route handler: that
  // request is dropped (aborted, never continued), and the rejection never escapes as an unhandled one that would end the
  // whole worker process with every other posting it holds (strict heldout run 42772190953: "route.fetch: Request context
  // disposed").
  await ctx.route("**/*", (route) => guardRoute(route).catch(() => route.abort("blockedbyclient").catch(() => {})));
  async function guardRoute(route) {
    const req = route.request();
    // A gate may answer a request inside the browser itself (the strict benchmark's simulated resume upload): nothing is sent.
    if (opts.requestGate) { const gv = await opts.requestGate(req); if (gv && typeof gv === "object" && gv.fulfill) return route.fulfill(gv.fulfill); if (!gv) return route.abort("blockedbyclient"); }
    if (!req.isNavigationRequest()) return route.continue();
    let sub = false;
    try { sub = !!req.frame().parentFrame(); } catch { /* no frame (service worker): judged as top-level */ }
    if (sub) return isDeniedHost(new URL(req.url()).hostname) ? route.abort("blockedbyclient") : route.continue();
    const g = urlVerdict(req.url(), allow);
    // The same employer's own posting reached by the board's script rather than a 3xx (Workable's apply.workable.com/j/<id> to the
    // employer's Workable domain /_/j/<id>, bench run 43303161774): the same rule as a redirect, from the page the run is on.
    let fromUrl = ""; try { fromUrl = page.url(); } catch { /* none */ }
    if (!g.ok && opts.followSamePosting !== false && /^https?:/.test(fromUrl) && samePostingRedirect(fromUrl, req.url(), p.url, allow)) { const h = normHost(new URL(req.url()).hostname); allow.push(h); followed.add(h); }
    else if (!g.ok) { blocked.push(g.host); blockedUrls.push(req.url()); return route.abort("blockedbyclient"); }
    if (req.method() !== "GET") return route.continue();
    const resp = await route.fetch({ maxRedirects: 0 });
    const loc = resp.status() >= 300 && resp.status() < 400 ? resp.headers().location : null;
    if (loc) {
      const to = new URL(loc, req.url()).href;
      const next = urlVerdict(to, allow);
      if (!next.ok && opts.followSamePosting !== false && samePostingRedirect(req.url(), to, p.url, allow)) { const h = normHost(new URL(to).hostname); allow.push(h); followed.add(h); }
      else if (!next.ok) { blocked.push(next.host); blockedUrls.push(to); return route.abort("blockedbyclient"); }
    }
    return route.fulfill({ response: resp });
  }
  const onAllowedHost = () => {
    // An employer that sends the candidate to its SSO: a sign-in wall the person finishes themselves, not a refused host.
    if (blocked.length && ssoSignIn(blockedUrls[0])) throw new NeedsUser("login_required", blocked[0], "sso_redirect");
    if (blocked.length && NOT_FOUND_URL.test(blockedUrls[0]) && !NOT_FOUND_URL.test(p.url)) throw new NeedsUser("posting_closed", blockedUrls[0]);
    if (blocked.length) throw new NeedsUser("redirect_not_allowed", blocked[0]);
    const g = urlVerdict(page.url(), allow);
    if (!g.ok) throw new NeedsUser("redirect_not_allowed", g.host);
  };
  // The shown-check gate (checkGate): on the way in an in-form check is noted and the form is filled first, any other shown check
  // stops the run before anything is typed; before the step form's Continue and before Submit, a check shown now or seen on any
  // earlier step of this run stops it, as wall check_in_form with everything else already filled and read back.
  let checkInForm = null;
  const gate = async (phase = "enter") => {
    const shown = await botCheck(page);
    const g = checkGate(checkInForm, shown, shown ? await page.evaluate(CHECK_IN_FORM).catch(() => false) : false, phase);
    checkInForm = g.seen;
    if (!g.stop) return;
    const e = new NeedsUser("bot_check", p.url, g.stop.wall);
    e.detail = g.stop.detail; throw e;
  };
  let filledSoFar = [];
  try {
    const t0 = Date.now();
    let resp;
    try { resp = await page.goto(p.url, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
    onAllowedHost();
    if (!resp || resp.status() >= 400) throw new Error(`page_load_${resp ? resp.status() : "none"}`);
    if (closedAfterLoad(p.url, page.url())) throw new NeedsUser("posting_closed", page.url());
    if (sentToJobList(p.url, page.url())) throw new NeedsUser((await closedOnPage(page)) ? "posting_closed" : "posting_not_confirmed_closed", page.url());
    await gate();
    // An employer that wants the person to sign in first: never signed into, never given a password (the person does that).
    await stopAtWall(page, p.url);
    // The form's own Submit control, as a person would press it: the visible one. A <button> with no type submits its form
    // (Breezy); Lever's visible "Submit application" is type="button" beside a hidden type="submit" its script presses
    // after the hCaptcha token. Marked data-upmore-submit, so the check below and the click use that same control.
    // An employee sign-in form (ats-fill MARK_SIGNIN: Teamtailor's "Already working at X?") is never the application: its
    // controls are never marked, filled or pressed (architect ruling on #741: a Submit reached there was a false pass).
    // Review of #797: the choice is pickControls' (above), on what SNAP read: the Submit is a control of the application form
    // itself, the step form's Continue likewise, and the form they belong to is the one filled (data-upmore-app).
    let lastPick = {};
    const mark = async () => { await page.evaluate(MARK_SIGNIN).catch(() => 0); lastPick = pickControls(await page.evaluate(SNAP)); await page.evaluate(MARK, lastPick); return lastPick; };
    const markSubmit = async () => (await mark()).submit !== null;
    const markNext = async () => (await mark()).next !== null;
    const hasForm = async () => { lastPick = {}; return !!(await page.$(FIELD_SEL)) && ((await markSubmit()) || (await markNext())); };
    // A board whose form lives at its own apply address one GET away (Lever /apply, Ashby /application, ...): loaded once,
    // through the same host rules, and checked like the first load.
    if (!(await page.waitForSelector(FIELD_SEL, { timeout: 5000 }).catch(() => null))) {
      const direct = applyUrlFor(p.ats, page.url());
      if (direct) {
        try { await page.goto(direct, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
        onAllowedHost();
        // A board drawn by its own script after the load (Workday): its form or its sign-in box, whichever it draws. D-072 (item 4,
        // round 2): Workday's own readiness signal is its app drawing one of its marked parts (data-automation-id: the sign-in or
        // create-account box, the form, "page doesn't exist", or its error), within 30 s; a page that drew none is loaded once more
        // (strict run 43276162667: 22 rows drew nothing within the old 12 s).
        const READY = `${FIELD_SEL}, input[type=password], [data-automation-id='signInContent'], [data-automation-id='invalid-content'], [data-automation-id='errorMessage'], [data-automation-id='applyFlowPage'] [data-automation-id='progressBar']`;
        const waitMs = p.ats === "workday" ? 30000 : 12000;
        if (!(await page.waitForSelector(READY, { timeout: waitMs }).catch(() => null)) && p.ats === "workday") {
          try { await page.reload({ waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
          onAllowedHost();
          await page.waitForSelector(READY, { timeout: waitMs }).catch(() => null);
        }
        // Its apply flow, once drawn, fills in its sign-in box or its first step a moment later.
        if (p.ats === "workday") await page.waitForSelector(`${FIELD_SEL}, input[type=password], [data-automation-id='invalid-content'], [data-automation-id='errorMessage']`, { timeout: 8000 }).catch(() => null);
        await gate();
        await stopAtWall(page, p.url);
      }
    }
    // D-072 (item 4, round 2): on the employer's own page a same-posting redirect led to, the only application form is the board's
    // own: its embedded form opened at its own address (Greenhouse's job_app frame), or Workable's own app on the employer's domain
    // (/_/j/<id>). Any other form there (a newsletter box, a site search; bench run 43303161774: cribl.io's page reached a Submit
    // with no field filled) is never the application: the run stops as the redirect off the board it was before.
    // Review of #800: the rule holds for every page the run reaches, not only the first. It is checked again after the page's
    // Apply control is opened (the control may itself lead to the employer's host, which the route guard then allows as the same
    // posting) and once more on the page as it is the instant before Submit (notOnFollowed, no navigation there): a newsletter
    // or job-alert box with one Email field there takes the confirmed email, and would otherwise pass every later check.
    const notOnFollowed = () => { const h = followedPageRefusal(page.url(), p.ats, followed); if (h) throw new NeedsUser("redirect_not_allowed", h); };
    const leaveFollowed = async () => {
      if (!followedPageRefusal(page.url(), p.ats, followed)) return;
      const embed = await embeddedFormUrl(page, allow);
      if (embed) {
        try { await page.goto(embed, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
        onAllowedHost();
        await page.waitForSelector(FIELD_SEL, { timeout: 8000 }).catch(() => null);
        await gate();
        await stopAtWall(page, p.url);
      }
      notOnFollowed();
    };
    await leaveFollowed();
    // D-072: the board's own form embedded in the employer's page (a frame on an allowed host): opened at its own address.
    if (!(await hasForm())) {
      const embed = await embeddedFormUrl(page, allow);
      if (embed) {
        try { await page.goto(embed, { waitUntil: "domcontentloaded" }); } catch (e) { onAllowedHost(); throw e; }
        onAllowedHost();
        await page.waitForSelector(FIELD_SEL, { timeout: 8000 }).catch(() => null);
        await gate();
        await stopAtWall(page, p.url);
      }
    }
    // A job page whose form is behind its "Apply" control: opened once, and what it leads to is checked like the first load.
    // Review of #797: a Submit-worded control outside the application form, tied to nothing, is never pressed and never "opened":
    // refused here, before anything is filled. Only a control in the Apply words is opened.
    if (!(await hasForm())) {
      if (lastPick.refuse && !lastPick.opener) throw new NeedsUser(lastPick.refuse, p.url);
      if (await openApply(page, opts.stepTimeoutMs || 15000)) {
        onAllowedHost();
        await gate();
        await stopAtWall(page, p.url);
      }
    }
    await leaveFollowed();
    timing.load = Date.now() - t0;
    const t1 = Date.now();
    if (!(await hasForm())) {
      // The page's only form is an employee sign-in form: a sign-in wall the person finishes themselves (WO-L), nothing typed.
      // The stop stays a sign-in wall (needs_user / login_required, nothing typed, nothing sent), marked employee_sign_in. D-072:
      // it is the employer's staff login beside the posting, not the person's own account, so it carries no hand-off
      // (handoff.cjs) and the 99% reading names it form_not_found:employee_sign_in_only (strict run 43192269304: 18 Teamtailor
      // postings), never a kept wall.
      if (await page.evaluate(MARK_SIGNIN).catch(() => 0)) throw new NeedsUser("login_required", p.url, "employee_sign_in");
      if (await closedOnPage(page)) throw new NeedsUser("posting_closed", page.url());
      if (lastPick.refuse) throw new NeedsUser(lastPick.refuse, p.url);
      throw new NeedsUser("no_application_form_found", p.url);
    }
    // The page's own questions, answered only from the approved facts / answers (ats-fill.cjs), each read back. A required
    // question with no confirmed answer, or one that could not be set and checked, stops the run: the person is asked.
    // A step form is filled one step at a time: each step's questions answered and read back, then its one Continue pressed, until
    // the step with the Submit control. A step with anything handed back stops there, as on a one-page form. At most 8 steps.
    await declineCookies(page);
    const fr = { map: [], filled: [], needsUser: [], failed: [], invalid: [] };
    for (let step = 0; ; step++) {
      const r = await fillForm(page, { ats: p.ats, facts: p.facts, answers: p.answers || {}, resumePath: p.resume.path });
      for (const k of Object.keys(fr)) fr[k].push(...(r[k] || []));
      filledSoFar = fr.filled.map((f) => f.label);
      if (fr.needsUser.length || fr.invalid.length || fr.failed.length || (await markSubmit())) break;
      if (step >= 7 || !(await markNext())) throw new NeedsUser("no_submit_control", p.url);
      onAllowedHost();
      await gate("continue");
      await stopAtWall(page, p.url);
      const before = await page.evaluate(() => [...document.querySelectorAll("input, select, textarea")].filter((e) => e.offsetWidth || e.offsetHeight).length + "|" + (document.body.innerText || "").length);
      await page.click("[data-upmore-next]");
      const moved = await page.waitForFunction((b) => [...document.querySelectorAll("input, select, textarea")].filter((e) => e.offsetWidth || e.offsetHeight).length + "|" + (document.body.innerText || "").length !== b, before, { timeout: 5000 }).then(() => true, () => false);
      // The page did not move on (its own check held the step back): handed back, never pressed again.
      if (!moved) {
        // What the page says held it back, in its own visible words (an error line on the step), for the person and the record.
        const said = await page.evaluate(() => [...document.querySelectorAll("form [class*='error' i], form [role=alert]")].filter((e) => (e.offsetWidth || e.offsetHeight) && !e.querySelector("[class*='error' i]"))
          .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3).map((t) => t.slice(0, 60))).catch(() => []);
        const e = new NeedsUser("field_not_filled", "step_did_not_advance");
        e.needs = [{ label: said.length ? `step_did_not_advance: ${said.join(" / ")}` : "step_did_not_advance", reason: "form_rejects_value" }];
        throw e;
      }
      await page.waitForTimeout(300);
      onAllowedHost();
    }
    if (fr.needsUser.length) {
      const first = fr.needsUser[0];
      // D-072 (item 4, round 2): a choice only the person can make is theirs too: an EEO or export-control question with no option
      // to decline (no_decline_option). Asked on the hand-off's card (strict run 43276162667: Greenhouse's "This position requires
      // access to information ..." was a fill failure with no hand-off). handoff.cjs PERSON_REASONS is the one list, less two:
      // an APPROVED answer or fact that is not exactly one of the offered options (no_matching_option, ambiguous_option) is a
      // question that could not be filled, not one with no answer: it stays field_not_filled (#340), so the person is never told
      // a question they answered "has no confirmed answer".
      const answersOnly = (PERSON_REASONS.has(first.reason) && !NOT_OFFERED.has(first.reason)) || /^(agreement|eeo|upload)_/.test(first.reason);
      // A form that also shows a check (CHECK_IN_FORM) stops as that check, with the person's answers beside it: both are theirs.
      const e = answersOnly && checkInForm ? new NeedsUser("bot_check", p.url, "check_in_form") : new NeedsUser(answersOnly ? "missing_required_answer" : "field_not_filled", first.label);
      if (answersOnly && checkInForm) e.detail = checkInForm;
      e.needs = fr.needsUser.map((n) => ({ label: n.label, reason: n.reason, ...(n.kind ? { kind: n.kind } : {}), ...(n.detail ? { detail: String(n.detail).slice(0, 400) } : {}), ...(Array.isArray(n.options) ? { options: n.options.slice(0, 60) } : {}) }));
      throw e;
    }
    if (fr.invalid.length) { const e = new NeedsUser("field_not_filled", fr.invalid[0].name); e.needs = fr.invalid.map((n) => ({ label: n.name, reason: "form_rejects_value" })); throw e; }
    // An optional question whose approved answer could not be set and read back (readback_mismatch, fill_error) is not a
    // question to skip: the field may hold something the person never approved. Handed back like a required one; nothing is sent
    // (independent review of #340: Submit used to go with such a field).
    if (fr.failed && fr.failed.length) { const e = new NeedsUser("field_not_filled", fr.failed[0].label); e.needs = fr.failed.map((n) => ({ label: n.label, reason: n.reason, ...(n.detail ? { detail: String(n.detail).slice(0, 200) } : {}) })); throw e; }
    // Every filled question still holds its approved value once the page has settled (ats-fill recheckFilled): a value the board
    // dropped is set once more and read back; one still empty stops the run here, unsent, named.
    { const lost = await recheckFilled(page, fr.filled, { facts: p.facts, answers: p.answers || {}, resumePath: p.resume.path }); if (lost.length) { const e = new NeedsUser("field_not_filled", lost[0]); e.needs = lost.map((l) => ({ label: l, reason: "value_dropped_before_submit" })); throw e; } }
    const filled = fr.filled.map((f) => ({ field: f.label, source: f.source }));
    timing.fill = Date.now() - t1;
    // Last checks before the click, on what is actually on the page now: still an allowed host, no bot check that appeared
    // while filling, the form posts to an allowed host, and the payload still hashes to what was approved.
    onAllowedHost();
    notOnFollowed();
    await gate("submit");
    await stopAtWall(page, p.url);
    if (!(await markSubmit())) throw new NeedsUser("no_submit_control", p.url);
    // A form in which nothing was filled from the approved application is never the application (no name, no email, no resume).
    if (!fr.filled.length) throw new NeedsUser("no_application_form_found", p.url);
    // Review of #797: the control about to be pressed is the filled form's own (submitTieRefusal), so the address checked below
    // is that form's: a control tied to no form used to fall back to the page's own address, which checked nothing.
    const tie = await page.$eval("[data-upmore-submit]", (b, qs) => {
      const app = document.querySelector("form[data-upmore-app]"), f = b.form || b.closest("form");
      const inApp = (el) => { for (let n = el; n; n = n.parentNode || n.host) if (n === app) return true; return false; };
      const a = b.getAttribute("formaction") ?? (f && f.getAttribute("action"));
      return { formless: !app, anyForm: !!document.querySelector("form:not([data-upmore-signin]) :is(input, select, textarea)"), sameForm: !!app && f === app,
        filledOutside: app ? qs.filter((q) => { const el = document.querySelector(`[data-upmore-q="${q}"]`); return el && !inApp(el); }).length : 0, action: new URL(a || location.href, document.baseURI).href };
    }, fr.filled.map((f) => String(f.d.q)));
    const untied = submitTieRefusal(tie);
    if (untied) throw new NeedsUser(untied, p.url);
    const av = urlVerdict(tie.action, allow);
    if (!av.ok) throw new NeedsUser("form_action_not_allowed", av.host);
    // Review of #797: what EVERY control of the form holds now, the engine's fills and the page's own defaults alike (CONTROLS),
    // each named as ats-fill names its question. A box the page ticked itself, or a consent / authorisation / demographic choice
    // it preselected, was never the person's answer: it is asked (the ask-once hand-off), never sent as it stands.
    const readControls = async () => {
      const labels = new Map((await page.evaluate(EXTRACT).catch(() => [])).map((d) => [String(d.q), d.label]));
      return (await page.evaluate(CONTROLS, fr.filled.map((f) => String(f.d.q)))).map((c) => ({ ...c, label: labels.get(String(c.q)) || c.label }));
    };
    const controls = await readControls();
    const unconfirmed = unconfirmedDefaults(controls);
    if (unconfirmed.length) { const e = new NeedsUser("missing_required_answer", unconfirmed[0].label); e.needs = unconfirmed; throw e; }
    if (!hasApproval(p)) throw new NeedsUser("not_approved", "payload changed after approval");
    if (opts.shotBefore) await page.screenshot({ path: opts.shotBefore, fullPage: true });
    // The caller records "submitting" (and re-checks its lease and kill switch) BEFORE the click; a refusal stops here, unsent.
    // A dry run's audit (opts.audit) also gets what each filled question holds at this instant; production passes only the phase.
    // The page as it is now, the last read before the caller's "submitting" record: never the employer's own page.
    notOnFollowed();
    // The control about to be pressed, for the caller's own check (the strict bench refuses one inside a sign-in form).
    const submitInfo = await page.$eval("[data-upmore-submit]", (b) => { const f = b.closest("form"); return { signin: !!b.closest("[data-upmore-signin]"), form: f ? f.getAttribute("action") || "" : null }; }).catch(() => ({ signin: false, form: null }));
    if (opts.onPhase) await opts.onPhase("submitting", opts.audit ? { id: p.id, fields: await heldNow(page, fr.filled), controls } : undefined, submitInfo);
    // Review of #797: the page is read once more, the instant before the click, and must hold exactly what it held when the caller
    // was shown it (the card's read): every control, and every hidden value that is not a per-load token. Any difference refuses.
    if (pageDigest(await readControls(), { hidden: true }) !== pageDigest(controls, { hidden: true })) throw new NeedsUser("page_changed_before_submit", p.url);
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
    if (e instanceof NeedsUser) {
      // What was filled and read back before the stop, and the page it stopped on: the hand-off's "everything else filled" (D-072).
      e.filled = e.filled || filledSoFar.slice();
      e.at = e.at || page.url();
      if (checkInForm && e.reason !== "bot_check") e.alsoCheck = checkInForm;
    }
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
      if (e instanceof NeedsUser && !t.submitClicked) {
        const r = { ...out, ...(e.detail ? { check: e.detail } : {}), ...(e.diag ? { diag: e.diag } : {}), status: HANDOFF_REASONS.includes(e.reason) ? "needs_user" : "not_submitted", reason: e.reason, field: e.field, wall: e.wall || undefined, needs: e.needs || undefined, filled_labels: e.filled || [], at: e.at || null, ...(e.alsoCheck ? { also_check: e.alsoCheck } : {}), ms: Date.now() - started };
        // D-072: a stop at a wall the rules keep carries its hand-off (workers/career-browser/handoff.cjs); any other stop carries none.
        const h = buildHandoff(r, p);
        if (h) r.handoff = h;
        return r;
      }
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

module.exports = { checkGate, pickControls, isApplicationForm, submitTieRefusal, sentToJobList, SNAP, MARK, CONTROLS, closedOnPage, declineCookies, samePostingRedirect, followedPageRefusal, postingIds, CHECK_IN_FORM, closedAfterLoad, embeddedFormUrl, botCheck, SHOWN_CHECK, applyOne, runPool, payloadHash, checkPayload, sha256, urlVerdict, ssoSignIn, DENY_HOSTS, DENY_HOST_RULES, DENY_LAUNCH_ARGS, denyLaunchOptions, HANDOFF_REASONS, NeedsUser };
