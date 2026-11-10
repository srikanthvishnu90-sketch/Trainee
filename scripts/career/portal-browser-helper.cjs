/* Portal browser helper — the Playwright side of the CA-03 browser seam.
   A long-running child process owned by packages/domain/150-career-portal-browser.js.
   It is a DUMB DOM EXECUTOR: it holds one Chromium, one isolated browser
   context per board, and executes file-delivered commands (open / discover /
   fill / readback / review / screenshot / close) against the live page.
   All policy (host allowlist, field classification, confirmed-facts-only,
   attestation discipline) lives in module 150 + module 149 — never here.
   This process clicks a submit button ONLY for the "submit_and_capture"
   command, which module 150 issues solely for an explicitly armed board
   (owner-approved submit lane), exactly once — and even then it never
   clicks through a captcha: a challenge at submit returns
   { captcha: "challenge", clicked: false }.
   Protocol: watch <dir> for cmd-<boardId>-<seq>.json, write
   resp-<boardId>-<seq>.json. Exits on a cmd-sys-*.json {type:"shutdown"}
   or after 15 idle minutes. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateAction, assertObservation } = require("../../workers/career-browser/protocol.cjs");
// Where each ATS's resume upload lives and what the form shows once the employer took the file (docs/apply/RESUME-UPLOAD.md).
const { NEVER_THE_RESUME, fnFileSlot, fnFindSlotInput, fnSlotTookFile, fnMarkSlotAttach } = require("./resume-upload.cjs");

const dir = process.argv[2];
if (!dir && require.main === module) { console.error("usage: portal-browser-helper.cjs <sessionDir>"); process.exit(2); }

function resolvePlaywright() {
  const tries = [];
  if (process.env.UPMORE_PLAYWRIGHT_PATH) tries.push(process.env.UPMORE_PLAYWRIGHT_PATH);
  tries.push("playwright");
  // Restored at the v224 combine: the release line dropped this
  // fallback, which stranded every browser-tier test whose own
  // resolution uses it (the repo's test files and widget-canary all
  // resolve env → "playwright" → this sibling path). The sandboxed
  // launch below stands; this is resolution only.
  tries.push(path.join(__dirname, "..", "..", "..", "sporve-agent-clone", "node_modules", "playwright"));
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  return null;
}
const pw = resolvePlaywright();
if (!pw && require.main === module) { fs.writeFileSync(path.join(dir, "fatal.json"), JSON.stringify({ code: "PLAYWRIGHT_UNRESOLVABLE", message: "playwright not resolvable in helper (set UPMORE_PLAYWRIGHT_PATH)" })); process.exit(3); }

const boards = new Map(); // boardId -> { context, page, url }
let browser = null;
let lastActivity = Date.now();

// Upmore-owned Chromium only. Failure to start with its sandbox enabled is
// a runtime blocker, never a reason to disable isolation or add a proxy.
// Sandbox posture (v224 combine): sandboxed is the default and the
// production posture. Some grading hosts cannot run ANY sandboxed
// Chromium for ANY user (this VM: AppArmor-restricted unprivileged
// user namespaces behind a read-only sysctl, and root is refused by
// Chromium outright) — for those hosts an operator may set
// UPMORE_CHROMIUM_SANDBOX=off, an explicit opt-out that is recorded
// in ready.json below, never silently.
// Unset means sandboxed, always; the opt-out never engages silently.
const SANDBOX_OFF = process.env.UPMORE_CHROMIUM_SANDBOX === "off";
// WO-039: the cloud worker keeps its screenshots on a server, so every answer in them is masked, as the engine masks the
// page after an emailed code (scripts/apply.ts). The person's own runs keep the plain picture they can check.
const maskedShot = (page) => process.env.UPMORE_MASK_SCREENSHOTS === "1"
  ? { mask: [page.locator("input, textarea, select, [contenteditable]")] } : {};
async function getBrowser() {
  if (!pw) throw Object.assign(new Error("PLAYWRIGHT_UNRESOLVABLE"), { code: "PLAYWRIGHT_UNRESOLVABLE" });
  if (browser) return browser;
  // UPMORE_BROWSER_HEADED=1 opens a visible window: the owner's own runs (scripts/apply.ts --headed), so a
  // verification on the page is completed by the person, never by the code.
  const launchOpts = { headless: process.env.UPMORE_BROWSER_HEADED !== "1",
    ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) };
  if (SANDBOX_OFF) { launchOpts.args = ["--no-sandbox"]; }
  else { launchOpts.chromiumSandbox = true; }
  browser = await pw.chromium.launch(launchOpts);
  return browser;
}
// §6.3 hop gate (BUG-060 / D1): the allowlist holds on EVERY main-frame
// navigation, not just the URL module 150 was asked to open. Boards
// redirect off their own host (Greenhouse -> the employer's site); the
// redirect target must never even load. Only main-frame navigation
// requests are gated — subresources (scripts, trackers, CDNs) pass
// untouched, and the one armed submit's own landing navigation is
// checked during submission too; controlled tasks reject every redirect.
const NAV_SUFFIXES = ["greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com"];
function navAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (!/^https?:$/.test(u.protocol)) return true; // about:, data:, blob: — not network hops
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return NAV_SUFFIXES.some((d) => host === d || host.endsWith("." + d));
}
async function getBoard(boardId) {
  if (!boards.has(boardId)) {
    const b = await getBrowser();
    const context = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const entry = { context, page, url: null, blockedNav: null, submitInProgress: false, scope: null, mutationSent: false };
    boards.set(boardId, entry);
    // Redirect hops never pass through page.route (a 302 target is part
    // of the initial request chain in Chromium/Playwright), but they DO
    // surface as request events — record any off-allowlist main-frame
    // navigation attempt so cmdOpen/cmdReview can stop on it, and
    // module 150's post-load final-URL gate makes the typed refusal.
    page.on("request", (req) => {
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !navAllowed(req.url())) {
          entry.blockedNav = entry.blockedNav || req.url();
        }
      } catch (e) { /* frame may be gone; the final-URL gate still decides */ }
    });
    // x-audit (2026-11-10): a new tab (target=_blank, window.open) is never driven or loaded. It is closed at once, and
    // every navigation it makes is refused below, so a LinkedIn tab opened by an Apply control never reaches LinkedIn.
    context.on("page", (other) => { if (other !== page) other.close().catch(() => {}); });
    await context.route("**/*", async (route) => {
      try {
        const req = route.request();
        let otherTab = false;
        try { otherTab = req.isNavigationRequest() && req.frame().page() !== page; } catch (e) { otherTab = false; }
        if (otherTab) { await route.abort("blockedbyclient"); return; }
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !navAllowed(req.url())) {
          entry.blockedNav = req.url();
          await route.abort("blockedbyclient");
          return;
        }
        if (entry.scope) {
          if (req.frame() !== page.mainFrame()) { await route.abort("blockedbyclient"); return; }
          const u = new URL(req.url());
          if (u.origin !== entry.scope.origin) { await route.abort("blockedbyclient"); return; }
          if (!["GET", "HEAD"].includes(req.method())) {
            if (!entry.submitInProgress || entry.mutationSent || req.method() !== "POST" || req.url() !== entry.scope.submitUrl) {
              await route.abort("blockedbyclient"); return;
            }
            entry.mutationSent = true;
            const response = await route.fetch({ maxRedirects: 0, headers: { ...req.headers(), "x-upmore-task": entry.scope.taskId,
              "x-upmore-user": entry.scope.userId, "x-upmore-review": entry.scope.payloadSha256,
              "x-upmore-resume": entry.scope.resumeSha256 } });
            if (response.status() >= 300 && response.status() < 400) {
              entry.blockedNav = new URL(response.headers().location || "/", req.url()).href;
              await route.fulfill({ status: 403, body: "Controlled portal redirect refused" }); return;
            }
            await route.fulfill({ response });
            return;
          }
          // Following an HTTP redirect can escape request interception.
          // Controlled local portals must answer directly; stop every redirect
          // before a second request, including an authorized POST's landing.
          const response = await route.fetch({ maxRedirects: 0 });
          if (response.status() >= 300 && response.status() < 400) {
            entry.blockedNav = new URL(response.headers().location || "/", req.url()).href;
            await route.fulfill({ status: 403, body: "Controlled portal redirect refused" }); return;
          }
          await route.fulfill({ response }); return;
        }
        await route.continue();
      } catch (e) { try { await route.abort("blockedbyclient"); } catch (_) { /* already handled */ } }
    });
  }
  return boards.get(boardId);
}

// ---------- in-page helpers (self-contained; serialized by Playwright) ----------
// fnDetectChallenge, fnCaptchaTech and fnDiscoverFields live in page-functions.cjs, shared with the browser extension.
const { fnDetectChallenge, fnCaptchaTech, fnDiscoverFields } = require("./page-functions.cjs");
function fnFindApplyControl() {
  const els = Array.from(document.querySelectorAll("a, button"));
  for (const el of els) {
    if (el.offsetParent === null && el.getClientRects().length === 0) continue;
    const t = (el.innerText || el.textContent || "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
    const href = el.getAttribute("href") || "";
    if (/^apply( for this job| now)?$/i.test(t) || /^i'?m interested$/i.test(t) || /\/(apply|application)(\/|$|\?)/.test(href) && /apply/i.test(t)) {
      return { text: t, href };
    }
  }
  return null;
}
// ---------- command implementations ----------
async function cmdOpen(board, cmd) {
  const page = board.page;
  const navSteps = [];
  board.blockedNav = null;
  board.scope = cmd.scope || null;
  // "commit" + a soft domcontentloaded wait: heavy ATS pages hang for a
  // long time on third-party subresources, and the form is usable long
  // before every tracker finishes (a hard domcontentloaded wait timed
  // out at 45s on a live Greenhouse page that had in fact loaded). One
  // navigation retry on a timeout — a human would refresh too; nothing
  // has been filled or sent at this point, so a retry is stateless-safe.
  // A gate-blocked navigation (BUG-060) is NOT retried: it is the stop.
  try {
    await page.goto(cmd.url, { waitUntil: "commit", timeout: 60000 });
  } catch (e) {
    await page.waitForTimeout(300); // let the request listener record a redirect hop that raced the failure
    if (board.blockedNav) {
      navSteps.push("goto-blocked:" + board.blockedNav);
      return { ok: true, captcha: null, finalUrl: board.blockedNav, blockedNavigation: board.blockedNav, fieldCount: 0, captchaTech: [], navSteps };
    }
    navSteps.push("goto-retry:" + String(e.message || e).slice(0, 80));
    await page.waitForTimeout(3000);
    await page.goto(cmd.url, { waitUntil: "commit", timeout: 60000 });
  }
  if (board.blockedNav) {
    navSteps.push("goto-blocked:" + board.blockedNav);
    return { ok: true, captcha: null, finalUrl: board.blockedNav, blockedNavigation: board.blockedNav, fieldCount: 0, captchaTech: [], navSteps };
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  board.url = page.url();
  navSteps.push("goto:" + board.url);
  let captcha = await page.evaluate(fnDetectChallenge);
  if (!captcha) {
    let fields = await page.evaluate(fnDiscoverFields);
    if (fields.length < 2 && !board.scope) {
      const apply = await page.evaluate(fnFindApplyControl);
      if (apply) {
        try {
          await Promise.all([
            page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {}),
            page.evaluate((a) => {
              const els = Array.from(document.querySelectorAll("a, button"));
              const el = els.find((x) => (x.innerText || "").replace(/\s+/g, " ").trim() === a.text) || els.find((x) => (x.getAttribute("href") || "") === a.href);
              if (el) el.click();
            }, apply),
          ]);
          await page.waitForTimeout(800);
          board.url = page.url();
          navSteps.push("apply-click:" + board.url);
          captcha = await page.evaluate(fnDetectChallenge);
          fields = await page.evaluate(fnDiscoverFields);
        } catch (e) { /* stay on the posting page; discovery result stands */ }
      }
    }
    board.fieldCount = fields.length;
  }
  const tech = await page.evaluate(fnCaptchaTech).catch(() => []);
  if (board.blockedNav) {
    navSteps.push("apply-click-blocked:" + board.blockedNav);
    return { ok: true, captcha: null, finalUrl: board.blockedNav, blockedNavigation: board.blockedNav, fieldCount: 0, captchaTech: tech, navSteps };
  }
  return { ok: true, captcha, finalUrl: board.url, fieldCount: board.fieldCount || 0, captchaTech: tech, navSteps };
}

/* Handle capture for one discovered field. A selector that resolves
 * to more than one element (any same-name shape discovery did not
 * qualify) must degrade to the field's document index — never throw
 * and kill the whole drive in discovery (Depth-E, live Lever defect,
 * 2026-10-16: strict-mode violation on a radio group's shared name). */
async function resolveFieldHandle(page, f) {
  try {
    return f.selector.startsWith("upmore-idx-")
      ? await page.locator("input,select,textarea").nth(f.domIndex).elementHandle()
      : await page.locator(f.selector).elementHandle();
  } catch (e) {
    try { return await page.locator("input,select,textarea").nth(f.domIndex).elementHandle(); }
    catch (e2) { return null; }
  }
}

async function cmdDiscover(board) {
  const fields = await board.page.evaluate(fnDiscoverFields);
  await readFileSlots(board, fields);
  const version = crypto.randomUUID();
  const handles = board.handles || new Map(); // retained only for rechecking prior steps before commit
  for (const f of fields) {
    f.ref = version + ":f:" + f.domIndex;
    const h = await resolveFieldHandle(board.page, f);
    if (h) handles.set(f.ref, h);
  }
  const controls = [];
  const buttons = await board.page.locator("button,input[type=submit],a[role=button]").elementHandles();
  for (let i = 0; i < buttons.length; i++) {
    const value = await buttons[i].evaluate((el) => ({ label: (el.innerText || el.value || "").trim().slice(0, 200),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true", visible: !!el.getClientRects().length }));
    if (!value.visible) continue;
    const ref = version + ":b:" + i;
    controls.push({ ref, ...value, kind: /^next$|^continue$|^review application$|^save and continue$/i.test(value.label) ? "next" : /submit/i.test(value.label) ? "submit" : "other" });
    handles.set(ref, buttons[i]);
  }
  const text = await board.page.evaluate(() => {
    const visible = (el) => !!el.getClientRects().length;
    const lines = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 12);
    return { instructions: lines("h1,h2,p,legend,.instructions"), errors: lines('[role=alert],.error,.validation-error,[aria-invalid=true]') };
  });
  board.refMetadata = board.refMetadata || new Map();
  for (const field of fields) board.refMetadata.set(field.ref, field);
  board.observation = { version, frame: "main", origin: new URL(board.page.url()).origin, untrusted: true,
    fields, controls, ...text };
  board.handles = handles;
  board.fieldCount = fields.length;
  return { fields, observation: board.observation };
}
/* One meaning table per command (widget/attach fix, 2026-10-21 —
 * docs/career/widget-attach-root-cause-2026-10-21.md): connected()
 * used to run a FULL fnDiscoverFields scan on every ref check, so a
 * readback over ~30 bindings (one check per option of a 60-option
 * group) ran 100-225 scans and died at the caller's 30 s cap on live
 * Lever pages. The meaning comparison only needs the field table as
 * of THIS command: scan once, cache on the board, clear per command
 * in execute(). Node liveness stays per-ref and live (the
 * isConnected check below); only the meaning table is shared. */
async function meaningFields(board) {
  if (!board._snapshotFields) board._snapshotFields = await board.page.evaluate(fnDiscoverFields, true);
  return board._snapshotFields;
}
async function connected(board, ref) {
  const h = board.handles && board.handles.get(ref);
  if (!h || !await h.evaluate((el) => el.isConnected)) throw Object.assign(new Error("the observed DOM node changed; re-observe"), { code: "STALE_OBSERVATION" });
  const previous = board.refMetadata && board.refMetadata.get(ref);
  if (previous) {
    const fields = await meaningFields(board);
    const current = fields.find((f) => f.selector === previous.selector);
    if (!current || ["label", "name", "inputType", "groupLabel"].some((key) => current[key] !== previous[key])) {
      throw Object.assign(new Error("the field meaning changed; re-observe"), { code: "STALE_OBSERVATION" });
    }
  }
  return h;
}

const normOpt = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
// D8 (BUG-067): the EEO decline default is ONE semantic choice worded a
// dozen ways across boards ("Decline to self-identify", "Decline",
// "Prefer not to answer", "I don't wish to answer", "Do not wish to
// disclose"...). Exact text matching made the §6.1 default unreliable;
// decline-class equivalence is matched explicitly, nothing else is.
// F-024: Lever's disability select says "I do not want to answer".
// This is a decline choice; "I do not have a disability" remains substantive.
// The decline class has ONE home: module 149's EEO_DECLINE_MEANING (the gate that checks what was filled). This
// matcher used to carry its own copy and drifted (F-024 added a phrasing here that the gate refused).
const { EEO_DECLINE_SOURCE } = require(path.join(__dirname, "..", "..", "packages", "domain", "149-career-portal-apply.js"));
const DECLINE_RE = new RegExp(EEO_DECLINE_SOURCE);
const isDeclineText = (s) => DECLINE_RE.test(normOpt(s));
function matchOption(options, value) {
  const v = normOpt(value);
  if (!v) return null;
  let hit = options.find((o) => normOpt(o.label) === v || normOpt(o.value) === v);
  if (hit) return hit;
  const head = v.split(/\s*[—–(]\s*/)[0].trim(); // "yes — authorized..." -> "yes"
  hit = options.find((o) => normOpt(o.label) === head || normOpt(o.value) === head);
  if (hit) return hit;
  if (isDeclineText(v)) {
    hit = options.find((o) => isDeclineText(o.label) || isDeclineText(o.value));
    if (hit) return hit;
  }
  hit = options.find((o) => normOpt(o.label).startsWith(v) || v.startsWith(normOpt(o.label)) && normOpt(o.label).length > 1);
  return hit || null;
}

/* ---- v224 combine: R-1 (BUG-237/FR-395) fill semantics, ported onto
 * the release line's ref/observation protocol ----
 * A fill is not done when the fill call returns: the live boards'
 * remount cycles replace filled DOM nodes and the value vanishes while
 * the driver reports success (BUG-207, 2026-10-15: Arc kept 3/17
 * values, Labelbox 2/8 on the armed run). So every fill here is
 * FILL-THEN-READBACK per field — fill, let the board settle, read the
 * value back the way the BOARD renders it, and re-fill on a mismatch
 * (bounded attempts, growing settle). A field whose value will not
 * persist returns { filled: false, reason: "value_did_not_persist" }.
 * A STALE_OBSERVATION from the ref layer still propagates untouched:
 * module 150 re-discovers and re-fills with fresh refs, which is the
 * release protocol's own recovery for a replaced node. */
const normPersist = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
function persistedMatches(got, expect, inputType) {
  if (expect === "__absent__") return got === undefined;
  if (inputType === "checkbox_group") {
    if (!Array.isArray(got)) return false;
    const g = got.map(normPersist).sort(), e = (expect || []).map(normPersist).sort();
    return g.length === e.length && g.every((v, i) => v === e[i]);
  }
  if (expect === true) return got === true;
  return got !== undefined && normPersist(got) === normPersist(expect);
}
/* The value a react-select widget carries, read the way the board
 * renders it: the chosen single-value under the select CONTROL. The
 * search box's text is not a value, and the current UI's first
 * "-container" ancestor (.select__input-container) does NOT hold the
 * single-value — climbing there read every landed pick as empty
 * (BUG-237). Returns the rendered text or null. */
function fnWidgetValue(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const root = el.closest('[class*="select__control"]') || el.closest('[class*="select__container"], [class*="-container"]') || el.parentElement;
  const sv = root && root.querySelector('[class*="select__single-value"], [class*="-singleValue"]');
  const t = sv ? (sv.textContent || "").replace(/\s+/g, " ").trim() : "";
  return t || null;
}
/* Read ONE binding's current value as the board renders it (undefined
 * when the field carries no value). For a react-select widget that is
 * the single-value under the control — never the search text. */
// FEATURE E2E: the pressed button of an Ashby yes/no pair ("yes", "no"), or null when none is pressed or the box is not one.
function fnYesNoPressed(el) {
  const box = el.closest && el.closest("[class*='yesno']");
  if (!box) return null;
  for (const b of box.querySelectorAll("button[data-option]")) {
    if (b.getAttribute("aria-pressed") === "true") return String(b.getAttribute("data-option") || "").toLowerCase() || null;
  }
  return null;
}
async function readbackBinding(board, b) {
  const nodes = [];
  for (const ref of b.elementRefs || []) nodes.push(await connected(board, ref));
  if (!nodes.length) return undefined;
  let value;
  if (b.widget === "react-select") {
    value = await nodes[0].evaluate((el) => {
      const root = el.closest('[class*="select__control"]') || el.closest('[class*="select__container"], [class*="-container"]') || el.parentElement;
      const sv = root && root.querySelector('[class*="select__single-value"], [class*="-singleValue"]');
      const t = sv ? (sv.textContent || "").replace(/\s+/g, " ").trim() : "";
      return t || null;
    });
  }
  else if (b.inputType === "name_pair") value = [(await nodes[0].inputValue()), (await nodes[1].inputValue())].map((v) => String(v || "").trim()).filter(Boolean).join(" ");
  else if (b.inputType === "file") value = await nodes[0].evaluate(async (el) => {
    const f = el.files && el.files[0]; if (!f) return null;
    const digest = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
    return { filename: f.name, sha256: Array.from(new Uint8Array(digest)).map((n) => n.toString(16).padStart(2, "0")).join("") };
  });
  else if (b.inputType === "select") value = await nodes[0].evaluate((el) => el.options[el.selectedIndex]?.textContent.trim() || "");
  else if (b.inputType === "checkbox") {
    // FEATURE E2E: an Ashby yes/no question is a pair of buttons over a hidden box; a "No" leaves the box unchecked, so
    // the pressed button is the answer (true for Yes, false for No, absent when neither is pressed).
    const pressed = await nodes[0].evaluate(fnYesNoPressed);
    value = pressed === "yes" ? true : pressed === "no" ? false : (await nodes[0].isChecked()) ? true : undefined;
    if (value === false) return false;
  }
  else if (["radio_group", "checkbox_group"].includes(b.inputType)) {
    const chosen = [];
    for (const opt of b.options || []) if (await (await connected(board, opt.ref)).isChecked()) chosen.push(opt.label);
    value = b.inputType === "radio_group" ? chosen[0] : (chosen.length ? chosen : undefined);
  } else value = await nodes[0].inputValue();
  // BUG-QA-2026-10-21-02: absent means absent. An untouched field reads
  // back undefined — never " " (an empty name_pair joined naively), never
  // false (an unticked checkbox: fillOnceHandles already expects
  // "__absent__" for one), never a whitespace-only string. Consumers of
  // answers() are written against absent ⇔ undefined; a truthy " " made
  // a fresh board look like it held another board's values.
  if (value === null || value === undefined || value === "" || (typeof value === "string" && !value.trim()) || /^select/i.test(String(value))) return undefined;
  return value;
}

/* One handle-based fill attempt (the release protocol's fills).
 * Returns { filled } plus, on success, `expect`: the value a readback
 * must show for the fill to count as persisted. */
async function fillOnceHandles(board, cmd) {
  const b = cmd.binding, value = cmd.value;
  const nodes = [];
  for (const ref of b.elementRefs) nodes.push(await connected(board, ref));
  if (b.inputType === "name_pair") {
    const parts = String(value).trim().split(/\s+/);
    await nodes[0].fill(parts[0] || ""); await nodes[1].fill(parts.slice(1).join(" "));
    return { filled: true, expect: [parts[0] || "", parts.slice(1).join(" ")].filter(Boolean).join(" ") };
  }
  if (b.inputType === "select") {
    const hit = matchOption(b.options || [], value);
    if (!hit) return { filled: false, reason: "option_not_found", wanted: String(value) };
    // A select's first option with an empty value is its placeholder prompt
    // ("Select...", "Please select an option"), not an answer: selecting it
    // leaves the field unanswered even though the DOM takes the value (a
    // placeholder pick on a Shield AI card select was counted as a fill in
    // the forms-ci coverage measurement, 2026-10-23). Refuse it by name.
    if (hit.value === "" && (b.options || []).indexOf(hit) === 0) {
      return { filled: false, reason: "placeholder_option", wanted: String(value) };
    }
    await nodes[0].selectOption({ value: hit.value });
    return { filled: true, expect: hit.label };
  }
  if (["radio_group", "checkbox_group"].includes(b.inputType)) {
    const hits = [];
    for (const desired of (Array.isArray(value) ? value : [value])) {
      const hit = matchOption(b.options || [], desired);
      if (!hit) return { filled: false, reason: "option_not_found", wanted: String(desired) };
      await (await connected(board, hit.ref)).check();
      hits.push(hit.label);
    }
    return { filled: true, expect: b.inputType === "radio_group" ? hits[0] : hits };
  }
  if (b.inputType === "checkbox") {
    // FEATURE E2E: an Ashby yes/no question is answered by pressing its Yes or No button, as a person does; checking or
    // unchecking the hidden box leaves a "No" unanswered.
    const yes = value === true || value === "true";
    const button = await nodes[0].evaluateHandle((el, want) => {
      const box = el.closest && el.closest("[class*='yesno']");
      return box ? box.querySelector(`button[data-option="${want}"]`) : null;
    }, yes ? "yes" : "no");
    const el = button.asElement();
    if (el) {
      await el.click();
      return { filled: true, expect: yes ? true : false };
    }
    if (yes) await nodes[0].check(); else await nodes[0].uncheck();
    return { filled: true, expect: value === true || value === "true" ? true : "__absent__" };
  }
  // A number input takes a number: a non-numeric value (a date string sent to
  // an education-year field measured DRIVER_ERROR in the forms-ci coverage
  // pack, 2026-10-23) is refused by name instead of crashing the fill, so the
  // caller records a truthful non-fill and moves on.
  const elType = await nodes[0].evaluate((el) => (el.tagName === "INPUT" ? el.type : "")).catch(() => "");
  if (elType === "number") {
    const t = String(value).trim();
    if (t === "" || Number.isNaN(Number(t))) return { filled: false, reason: "value_not_numeric", wanted: String(value) };
  }
  await nodes[0].fill(String(value));
  return { filled: true, expect: String(value) };
}

/* The option matcher the widget drive runs inside the page: scan the
 * rendered option pools and mark (data-upmore-opt) the option that
 * names the wanted value, strongest match first. Returns the marked
 * option's text, or null. Shared by the ladder's poll and the
 * menu-first read, so both judge a rendered list by exactly the same
 * strengths. */
function fnMarkMatchingOption({ tok, full, declineSrc }) {
  const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  document.querySelectorAll("[data-upmore-opt]").forEach((e) => e.removeAttribute("data-upmore-opt"));
  const pools = [".select__option", '[role="option"]', '[role="listbox"] *', ".pac-item", '[class*="suggestion"] *', '[class*="autocomplete"] *'];
  // Match strength, strongest first: exact normalized; then the
  // wanted value's own first segment; then decline-class (only
  // when the WANTED value is itself decline-class — D8/BUG-067);
  // then first-token containment; then an option that is a
  // normalized PREFIX of the wanted value. Weaker hits are used
  // only when nothing stronger exists anywhere in the list.
  const seg = full.split(/\s+[-–—,]\s+/)[0].trim();
  let segHit = null, tokenHit = null, prefixHit = null, declineHit = null;
  const declineRe = new RegExp(declineSrc);
  const isDecline = (s) => declineRe.test(norm(s));
  const wantedDecline = isDecline(full);
  for (const sel of pools) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!vis(el)) continue;
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length >= 90) continue;
      if (norm(t) === norm(full)) { el.setAttribute("data-upmore-opt", "1"); return t; }
      if (!segHit && seg && norm(t) === norm(seg)) segHit = { el, t };
      if (!declineHit && wantedDecline && isDecline(t)) declineHit = { el, t };
      if (!tokenHit && t.toLowerCase().includes(tok)) tokenHit = { el, t };
      if (!prefixHit && norm(t).length >= 4 && norm(full).startsWith(norm(t))) prefixHit = { el, t };
    }
  }
  const hit = segHit || declineHit || tokenHit || prefixHit;
  if (hit) { hit.el.setAttribute("data-upmore-opt", "1"); return hit.t; }
  return null;
}
/* The pick fallback the widget drive runs inside the page when React
 * re-created the marked option node before the real click could land:
 * find the option fresh by its text and dispatch the pointer sequence
 * on it directly (react-select selects on mousedown). */
function fnPickMarkedOption(t) {
  const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const pools = [".select__option", '[role="option"]', '[role="listbox"] *'];
  for (const sel of pools) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!vis(el)) continue;
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt === t || norm(txt) === norm(t)) {
        for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        return true;
      }
    }
  }
  return false;
}
/* MENU-FIRST READ (2026-10-24): the drive's opening click has already
 * opened the widget's menu. Before anything is typed into the search
 * box — typing filters the menu by the typed text, and an option whose
 * label shares no token with the wanted value (the board's decline
 * wording against "Decline to self-identify") filters itself out of
 * its own menu, reachable again only at the ladder's cleared-search
 * rung, sixteen fixed polls later — read the options the opened menu
 * actually renders and judge the wanted value against that list with
 * the ladder's own matcher. A pick counts only when the widget's own
 * single-value renders it (the same verification the ladder's pick and
 * cmdFill apply). When the opened menu renders no options at all (a
 * scriptless capture, a search-first widget), renders no match, or a
 * pick does not land, this returns null and the ladder below runs
 * unchanged: the menu read is a first look, never a second verdict.
 * A value the widget already renders earns the ladder's own early
 * return before any pick — a landed value is never re-picked. */
async function pickFromOpenMenu(board, b, wanted, tok) {
  const page = board.page;
  const existing = await page.evaluate(fnWidgetValue, b.selector).catch(() => null);
  if (existing) {
    const nGot = normPersist(existing), nWant = normPersist(wanted);
    if (nGot === nWant || (nGot.length >= 4 && nWant.startsWith(nGot)) || nWant.endsWith(nGot)) {
      return { expect: existing, chosenText: wanted, via: "widget_option_pick" };
    }
    return null;
  }
  // The menu renders a beat after the opening click; poll briefly for
  // any rendered option. Presence only — the matcher judges the list.
  let rendered = false;
  for (let i = 0; i < 6 && !rendered; i++) {
    rendered = await page.evaluate(() => {
      const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      return Array.from(document.querySelectorAll('.select__option, [role="option"]')).some(vis);
    }).catch(() => false);
    if (!rendered) await page.waitForTimeout(150);
  }
  if (!rendered) return null;
  const chosen = await page.evaluate(fnMarkMatchingOption, { tok, full: wanted, declineSrc: EEO_DECLINE_SOURCE }).catch(() => null);
  if (!chosen) return null;
  const clicked = await page.click('[data-upmore-opt="1"]', { timeout: 5000 }).then(() => true).catch(() => false);
  if (!clicked) await page.evaluate(fnPickMarkedOption, chosen).catch(() => false);
  await page.waitForTimeout(300);
  let svText = null;
  for (let svTry = 0; svTry < 4 && !svText; svTry++) {
    svText = await page.evaluate(fnWidgetValue, b.selector).catch(() => null);
    if (!svText) await page.waitForTimeout(300);
  }
  if (!svText) { await page.keyboard.press("Escape").catch(() => {}); return null; }
  return { expect: svText, chosenText: chosen, via: "widget_option_pick" };
}

/* The react-select widget drive (BUG-207/BUG-237, ported): the visible
 * input is a search box — typed text is NOT a value. Type the value,
 * wait for the option list (the board's option service can take
 * seconds), and pick the option that names the same value with a real
 * click (or, when React re-creates the option nodes between marking
 * and clicking, an in-page pointer dispatch on a fresh node). The
 * ladder inside ONE drive — full value → first segment → first word →
 * cleared search — never retypes into a widget that is still loading
 * (a retype restarts its search), and a pick that already landed is
 * detected before any further typing so it is never overwritten. */
async function driveWidget(board, cmd) {
  const page = board.page;
  const b = cmd.binding;
  const wanted = String(cmd.value);
  const tok = wanted.split(",")[0].trim().toLowerCase();
  // One drive, one bounded patience budget (widget/attach fix,
  // 2026-10-21): the action timeouts used to be 20 s apiece, stacked
  // on top of the ~17 s option ladder — a never-actionable widget
  // burned ~77 s for ONE field on the live Greenhouse drive. The
  // engagement actions get 8/5/5 s, the in-ladder retries 3-5 s: a
  // live widget answers in milliseconds, a dead one fails inside
  // one bounded drive and the fill loop moves on.
  await page.click(b.selector, { timeout: 8000 }).catch(() => {});
  // MENU-FIRST READ: judge the opened menu's rendered options before
  // typing anything (see pickFromOpenMenu). A landed pick returns
  // here; anything else falls through to the ladder below, unchanged.
  const menuPick = await pickFromOpenMenu(board, b, wanted, tok);
  if (menuPick) return menuPick;
  await page.fill(b.selector, "", { timeout: 5000 }).catch(() => {});
  await page.type(b.selector, wanted, { delay: 25, timeout: 5000 }).catch(() => {});
  let chosen = null;
  let retyped = false;
  let wordRetyped = false;
  let clearedSearch = false;
  const widgetLoading = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const control = el.closest('[class*="select__control"]');
    const scope = (control && control.parentElement) || document;
    return !!scope.querySelector('[class*="loading-indicator"], [class*="loadingIndicator"]');
  }, b.selector).catch(() => false);
  for (let i = 0; i < 34 && !chosen; i++) {
    await page.waitForTimeout(500);
    if (i > 0) {
      const existing = await page.evaluate(fnWidgetValue, b.selector).catch(() => null);
      if (existing) {
        const nGot = normPersist(existing), nWant = normPersist(wanted);
        if (nGot === nWant || (nGot.length >= 4 && nWant.startsWith(nGot)) || nWant.endsWith(nGot)) {
          return { expect: existing, chosenText: wanted, via: "widget_option_pick" };
        }
      }
    }
    if (i === 5) {
      const expanded = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.getAttribute("aria-expanded") : null; }, b.selector).catch(() => null);
      if (expanded !== "true") await page.click(b.selector, { timeout: 3000 }).catch(() => {});
      const seg = wanted.split(/\s+[-–—,]\s+/)[0].trim();
      if (!retyped && seg && seg !== wanted && !(await widgetLoading())) {
        retyped = true;
        await page.fill(b.selector, "", { timeout: 3000 }).catch(() => {});
        await page.type(b.selector, seg, { delay: 25, timeout: 5000 }).catch(() => {});
      }
    }
    if (i === 10 && !wordRetyped) {
      const word = wanted.split(/\s+/)[0].trim();
      if (word && word.length >= 3 && word !== wanted && !(await widgetLoading())) {
        wordRetyped = true;
        await page.fill(b.selector, "", { timeout: 3000 }).catch(() => {});
        await page.type(b.selector, word, { delay: 25, timeout: 5000 }).catch(() => {});
      }
    }
    // When NO option shares a token with the wanted value, every
    // filtered list is empty (the board's veteran decline "I don't
    // wish to answer" shares no token with "Decline to self-identify"
    // and filters itself out of its own menu). Clearing the search
    // renders the FULL list, and the matcher judges that instead.
    if (i === 16 && !clearedSearch) {
      clearedSearch = true;
      if (!(await widgetLoading())) {
        await page.fill(b.selector, "", { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    chosen = await page.evaluate(fnMarkMatchingOption, { tok, full: wanted, declineSrc: EEO_DECLINE_SOURCE }).catch(() => null);
    if (chosen) {
      const clicked = await page.click('[data-upmore-opt="1"]', { timeout: 5000 }).then(() => true).catch(() => false);
      if (!clicked) {
        // React re-creates the option nodes between the marking
        // evaluate and the click — the marked node is gone. Fall back
        // to a pick executed in ONE evaluate turn: find the option
        // fresh and dispatch the pointer sequence on it directly
        // (react-select selects on mousedown).
        await page.evaluate(fnPickMarkedOption, chosen).catch(() => false);
      }
      await page.waitForTimeout(300);
      // The readback expectation is the widget's OWN rendering of the
      // pick (the country widget renders only "+1" for the option
      // whose menu text is "United States +1"). The single-value
      // settles a beat after the pick, so poll briefly before judging.
      let svText = null;
      for (let svTry = 0; svTry < 4 && !svText; svTry++) {
        svText = await page.evaluate(fnWidgetValue, b.selector).catch(() => null);
        if (!svText) await page.waitForTimeout(300);
      }
      if (!svText) { chosen = null; continue; } // the pick did not land — keep polling inside this one drive
      return { expect: svText || chosen, chosenText: chosen, via: "widget_option_pick" };
    }
  }
  // No option list arrived: close the widget's open menu before the
  // plain fill stands as page state (an open menu overlaying the form
  // degraded later fills on the live boards). The verification in
  // cmdFill judges it — search text alone never counts as a value.
  await page.keyboard.press("Escape").catch(() => {});
  await page.fill(b.selector, wanted, { timeout: 5000 }).catch(() => {});
  return { expect: wanted, chosenText: null, via: undefined };
}
function widgetPersisted(got, driven) {
  if (got === undefined || normPersist(got) === "") return false;
  if (normPersist(got) === normPersist(driven.expect)) return true;
  if (!driven.chosenText) return false;
  return normPersist(got) === normPersist(driven.chosenText)
    || normPersist(driven.chosenText).endsWith(normPersist(got))
    || (normPersist(got).length >= 4 && normPersist(driven.chosenText).startsWith(normPersist(got)));
}

/* Re-discover the resume's own live file input and return a selector for
 * it (its id, else a data marker — a positional selector breaks whenever
 * the board remounts siblings around it). Only the input in the bound
 * input's own place (its upload group, id, name or label: resume-upload.cjs),
 * never "the first file input on the page": that was Ashby's autofill parser
 * on every Ashby form, and a cover letter or another question's upload on a
 * Greenhouse form whose resume input the employer had already taken. */
async function rediscoverFileSelector(page, slot) {
  return await page.evaluate(fnFindSlotInput, { slot: slot || null, never: NEVER_THE_RESUME }).catch(() => null);
}
const slotKey = (b) => b.selector;
/* Every file input's place, read at discovery while the inputs are all on
 * the page (a board may take one away before its fill: BUG-207/237). */
async function readFileSlots(board, fields) {
  board.fileSlots = board.fileSlots || new Map();
  for (const f of fields) {
    if (f.inputType !== "file" || !f.selector || board.fileSlots.has(f.selector)) continue;
    const slot = await board.page.evaluate(fnFileSlot, { selector: f.selector, never: NEVER_THE_RESUME }).catch(() => null);
    if (slot) board.fileSlots.set(f.selector, slot);
  }
}
/* The bound file input's place: read at discovery, else now. */
async function fileSlot(board, b) {
  board.fileSlots = board.fileSlots || new Map();
  if (!board.fileSlots.has(slotKey(b))) {
    const slot = await board.page.evaluate(fnFileSlot, { selector: b.selector, never: NEVER_THE_RESUME }).catch(() => null);
    if (slot) board.fileSlots.set(slotKey(b), slot);
  }
  return board.fileSlots.get(slotKey(b)) || null;
}
/* The employer took the file this helper attached: the resume's upload group
 * holds no input any more and shows the attached file's name (Greenhouse,
 * live). Returns the attached {filename, sha256} — bytes sha-verified before
 * the attach — or undefined. */
async function takenFile(board, b) {
  const taken = board.takenFiles && board.takenFiles.get(slotKey(b));
  const slot = board.fileSlots && board.fileSlots.get(slotKey(b));
  if (!taken || !slot) return undefined;
  const shows = await board.page.evaluate(fnSlotTookFile, { slot, filename: taken.filename }).catch(() => false);
  return shows ? { filename: taken.filename, sha256: taken.sha256 } : undefined;
}
/* Page-level file attach for when the discovered handle cannot be
 * used — the current boards mount their file inputs late, hide them
 * behind a styled dropzone, lazy-mount them when the upload section
 * nears the viewport, or mount them only once the board's own Attach
 * control is engaged (BUG-207 addendum + BUG-237: file_input_not_
 * mounted on 18 of 24 boards in Drive Pass 2). Engages the board's
 * own controls, re-discovers the live input, and sets the files —
 * through CDP when the standard call cannot complete (the same
 * mechanism the browser's own file picker uses). Returns
 * { ok, selectorUsed } — only a board that still shows no input after
 * all of that earns a not-mounted report. */
async function attachFilePageLevel(board, cmd, slot) {
  const page = board.page;
  const b = cmd.binding;
  let selector = b.selector;
  await page.evaluate(() => {
    const l = document.querySelector('[class*="file-upload"], label[for="resume"], [data-testid*="resume" i]');
    if (l) l.scrollIntoView({ block: "center" });
  }).catch(() => {});
  await page.waitForTimeout(400);
  let attached = await page.waitForSelector(selector, { state: "attached", timeout: 1500 }).then(() => true).catch(() => false);
  if (!attached) {
    const fresh = await rediscoverFileSelector(page, slot);
    if (fresh && fresh !== selector) {
      attached = await page.waitForSelector(fresh, { state: "attached", timeout: 5000 }).then(() => true).catch(() => false);
      if (attached) selector = fresh;
    }
  }
  if (!attached) {
    // The attach control in the resume's own upload group when it has one (another upload's Attach is never pressed);
    // else the page's, outside Ashby's autofill parser.
    const marked = (slot && slot.group) ? await page.evaluate(fnMarkSlotAttach, { slot }).catch(() => false) : await page.evaluate((never) => {
      const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
      const textOf = (el) => ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\s+/g, " ").trim();
      const pools = ['button, label, [role="button"]', 'a, div, span'];
      for (const pool of pools) {
        const cand = Array.from(document.querySelectorAll(pool))
          .find((el) => vis(el) && !never.some((s) => el.closest(s)) && /attach|upload|add resume|add file|browse|choose file|drag/i.test(textOf(el)) && textOf(el).length < 90);
        if (cand) { cand.setAttribute("data-upmore-attach", "1"); return true; }
      }
      return false;
    }, NEVER_THE_RESUME).catch(() => false);
    if (marked) {
      await page.click('[data-upmore-attach="1"]', { timeout: 8000 }).catch(() => {});
      for (let t = 0; t < 10 && !attached; t++) {
        await page.waitForTimeout(600);
        const fresh2 = await rediscoverFileSelector(page, slot);
        if (fresh2) {
          attached = await page.waitForSelector(fresh2, { state: "attached", timeout: 1500 }).then(() => true).catch(() => false);
          if (attached) selector = fresh2;
        }
      }
    }
  }
  // Tail wait for a slow mount: the attach-control poll above already
  // waited ~21s; 12s here keeps the whole ladder inside the caller's
  // 60s ceiling (the ladder runs once per call — see cmdFill).
  if (!attached) attached = await page.waitForSelector(b.selector, { state: "attached", timeout: 12000 }).then(() => true).catch(() => false);
  if (!attached) return { ok: false, selectorUsed: selector };
  try {
    await page.setInputFiles(selector, cmd.filePath, { timeout: 20000 });
  } catch (e) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const doc = await cdp.send("DOM.getDocument", { depth: 1 });
      const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      if (!node || !node.nodeId) throw new Error("file input vanished before CDP attach");
      await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [cmd.filePath] });
    } finally { await cdp.detach().catch(() => {}); }
  }
  return { ok: true, selectorUsed: selector };
}

async function cmdFill(board, cmd) {
  const b = cmd.binding, value = cmd.value;
  const settleMs = [450, 650, 1000];
  if (b.widget === "react-select") {
    // A widget fill is ONE complete drive (click, type, option poll,
    // pick). Re-driving it verbatim when the board's option service
    // never answered does not change the answer — and repeated drives
    // degrade the page until later fields' inputs leave the DOM
    // (probe-bisected 2026-10-15). Single drive; the readback verdict
    // stands as reported.
    const driven = await driveWidget(board, cmd);
    await board.page.waitForTimeout(settleMs[0]);
    const rendered = await board.page.evaluate(fnWidgetValue, b.selector).catch(() => null);
    if (widgetPersisted(rendered === null ? undefined : rendered, driven)) {
      return { filled: true, verified: true, attempts: 1, via: driven.via || undefined, rendered: driven.expect };
    }
    return { filled: false, reason: "value_did_not_persist", wanted: String(value) };
  }
  if (b.inputType === "file") {
    const bytes = fs.readFileSync(cmd.filePath);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw Object.assign(new Error("resume bytes changed before upload"), { code: "RESUME_SHA_MISMATCH" });
    const slot = await fileSlot(board, b);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let attached = false;
      let selectorUsed = b.selector;
      try {
        const nodes = [];
        for (const ref of b.elementRefs) nodes.push(await connected(board, ref));
        if (nodes.length) {
          await nodes[0].setInputFiles({ name: value.filename, mimeType: "application/octet-stream", buffer: bytes });
          attached = true;
        }
      } catch (e) { if (e.code !== "STALE_OBSERVATION") throw e; }
      if (!attached) {
        const rec = await attachFilePageLevel(board, cmd, slot);
        attached = rec.ok; selectorUsed = rec.selectorUsed;
        // The ladder IS the recovery budget (scroll into view,
        // re-discovery, attach-control engagement, mount poll, long
        // wait). Re-running it verbatim inside the same call cannot
        // change the answer and stacks past the caller's 60s ceiling —
        // which would surface as a driver timeout instead of the
        // truthful not-mounted verdict (BUG-207's "the run does not
        // die" guard). Its negative verdict returns at once.
        if (!attached) return { filled: false, reason: "file_input_not_mounted" };
      }
      await board.page.waitForTimeout(settleMs[attempt - 1]);
      // Verified = the live input still holds the file. When the
      // discovered node is still the board's input, the handle
      // readback (name + sha256 of the attached bytes) decides. When
      // the board replaced the node (so the handle readback cannot
      // speak), the file's presence under the selector the recovery
      // actually used is the evidence — the bytes themselves were
      // sha-verified above before any upload.
      let got;
      try { got = await readbackBinding(board, b); } catch (e) { got = undefined; }
      if (got && got.sha256 === value.sha256) return { filled: true, verified: true, attempts: attempt };
      if (got === undefined) {
        const present = await board.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return !!(el && el.files && el.files.length > 0);
        }, selectorUsed).catch(() => false);
        if (present) return { filled: true, verified: true, attempts: attempt, via: "file_rediscovered" };
        // The employer took the file (Greenhouse, live): it uploaded what was
        // just attached and took the input out of the form, leaving the
        // file's name in the resume's own upload group. That is the attach
        // succeeding, not a missing input — attaching again would send the
        // resume a second time, or into the next upload on the page.
        board.takenFiles = board.takenFiles || new Map();
        board.takenFiles.set(slotKey(b), { filename: value.filename, sha256: value.sha256 });
        if (await takenFile(board, b)) return { filled: true, verified: true, attempts: attempt, via: "employer_took_file" };
        board.takenFiles.delete(slotKey(b));
      }
    }
    return { filled: false, reason: "value_did_not_persist", wanted: value.filename };
  }
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await fillOnceHandles(board, cmd);
    if (!last.filled) return last; // e.g. option_not_found — retrying cannot invent an option
    await board.page.waitForTimeout(settleMs[attempt - 1]);
    let got;
    // The verification readback re-observes on stale (readbackBindingFresh):
    // a node the board remounted mid-drive reads as its CURRENT value —
    // on a never-persist board that is "absent", which is the truth this
    // loop exists to judge, not an error that aborts the fill.
    try { got = await readbackBindingFresh(board, b); } catch (e) { if (e.code === "STALE_OBSERVATION") throw e; got = undefined; }
    if (persistedMatches(got, last.expect, b.inputType)) {
      return { filled: true, verified: true, attempts: attempt, rendered: last.expect };
    }
  }
  return { filled: false, reason: "value_did_not_persist", wanted: String(value && value.filename ? value.filename : value) };
}
// Re-observe ONE binding in place (v224 combine): a board that
// remounts a node between the drive and the readback (the Greenhouse
// delayed-reset / fresh-id shapes) leaves the observed refs pointing
// at detached husks, and connected() rightly calls that stale. The
// protocol's answer to stale is "re-observe" — here that means a
// fresh discovery, the field found again by its selector, and new
// handles minted under the current observation version (the same
// scheme cmdDiscover uses). Returns a cloned binding with live refs,
// or null when the field is gone from the page (which reads back as
// absent — the truth).
async function reresolveBinding(board, b) {
  board.handles = board.handles || new Map();
  board.refMetadata = board.refMetadata || new Map();
  // A re-resolution happens because the page changed under the
  // observed refs — the per-command meaning snapshot may predate
  // that change, so drop it: the next connected() in this command
  // takes one fresh scan instead of judging against the stale table.
  board._snapshotFields = null;
  const fields = await board.page.evaluate(fnDiscoverFields);
  const version = (board.observation && board.observation.version) || "re";
  // Mint under a per-call namespace (widget/attach fix, 2026-10-21):
  // refs are keyed version+domIndex, and a remount REORDERS the DOM —
  // a re-minted ref could land on the exact key another binding's
  // live ref already owns, silently swapping that binding's handle
  // and metadata for this field's (measured: a remounted upload
  // section made the resume read answer for the cover field and
  // vice versa; both then read absent). Fresh refs must never
  // clobber refs other bindings still hold.
  board._reresolveSeq = (board._reresolveSeq || 0) + 1;
  const mintNs = version + ":re" + board._reresolveSeq;
  const mint = async (f) => {
    const h = await resolveFieldHandle(board.page, f);
    if (!h) return null;
    const ref = mintNs + ":f:" + f.domIndex;
    board.handles.set(ref, h);
    board.refMetadata.set(ref, f);
    return ref;
  };
  const selectors = b.selectors || (b.selector ? [b.selector] : (b.options || []).map((x) => x.selector));
  const elementRefs = [];
  for (const sel of selectors) {
    const f = fields.find((x) => x.selector === sel);
    if (!f) continue;
    const ref = await mint(f);
    if (ref) elementRefs.push(ref);
  }
  if (!elementRefs.length) return null;
  const clone = Object.assign({}, b, { elementRefs });
  if (b.options) {
    clone.options = [];
    for (const opt of b.options) {
      const f = fields.find((x) => x.selector === opt.selector);
      const ref = f ? await mint(f) : null;
      clone.options.push(Object.assign({}, opt, { ref: ref || opt.ref }));
    }
  }
  return clone;
}

// readbackBinding with the protocol's re-observe recovery: one stale
// verdict triggers one re-resolution and one retry; a field that is
// gone reads back absent; a second stale verdict propagates.
async function readbackBindingFresh(board, b) {
  let value;
  try { value = await readbackBinding(board, b); }
  catch (e) {
    if (!e || e.code !== "STALE_OBSERVATION") throw e;
    const fresh = await reresolveBinding(board, b);
    value = fresh ? await readbackBinding(board, fresh) : undefined;
  }
  // A resume the employer took (its input gone, its name shown in the
  // resume's own upload group) reads back as the file this helper attached.
  if (value === undefined && b.inputType === "file") value = await takenFile(board, b);
  return value;
}

async function cmdReadback(board, cmd) {
  const answers = {};
  for (const b of cmd.bindings) {
    const value = await readbackBindingFresh(board, b);
    if (value !== undefined) answers[b.field_id] = value;
  }
  return { answers };
}

async function cmdReview(board, cmd) {
  const page = board.page;
  const captcha = await page.evaluate(fnDetectChallenge);
  if (captcha) return { captcha: "challenge", finalUrl: page.url() };
  const fields = await page.evaluate(fnDiscoverFields);
  if (fields.some((f) => !(cmd.knownSelectors || []).includes(f.selector))) return { needsFields: true, finalUrl: page.url() };
  const invalid = fields.filter((f) => !f.disabled && f.required && !f.valid);
  if (invalid.length) return { code: "FORM_VALIDATION_FAILED", finalUrl: page.url() };
  for (const control of board.observation.controls) {
    const handle = await connected(board, control.ref);
    if (control.disabled === await handle.isEnabled()) return { needsFields: true, finalUrl: page.url() };
  }
  const next = board.observation.controls.find((c) => c.kind === "next" && !c.disabled);
  if (next) {
    await (await connected(board, next.ref)).click({ timeout: 20000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    return { advanced: true, captcha: await page.evaluate(fnDetectChallenge), finalUrl: board.blockedNav || page.url(), blockedNavigation: board.blockedNav };
  }
  const submit = board.observation.controls.find((c) => c.kind === "submit" && !c.disabled);
  return { atFinalReview: !!submit, finalUrl: page.url() };
}

/* The one submit click in this process — reachable only from an armed
 * module-150 board. Clicks the marked submit control exactly once, lets
 * the destination settle, then captures the employer's answer: landing
 * URL, page text, and a screenshot. A challenge before or after the click
 * is reported, never fought. */
async function cmdSubmitCapture(board, cmd) {
  const page = board.page;
  const captchaBefore = await page.evaluate(fnDetectChallenge);
  if (captchaBefore) return { captcha: "challenge", clicked: false };
  const submit = board.observation.controls.find((c) => c.kind === "submit" && !c.disabled);
  if (!submit) return { clicked: false, reason: "no_submit_control" };
  const handle = await connected(board, submit.ref);
  if (!await handle.isEnabled()) return { clicked: false, reason: "submit_disabled" };
  // Approval never suspends destination checks. Scoped tasks permit one
  // POST to their exact controlled destination, with the task identity.
  board.mutationSent = false;
  board.submitInProgress = true;
  try { await handle.click({ timeout: 20000 }); }
  finally { /* landing waits below still belong to the submit capture */ }
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  board.submitInProgress = false;
  if (board.blockedNav) return { clicked: true, finalUrl: board.blockedNav, text: "", blockedNavigation: board.blockedNav };
  const captcha = await page.evaluate(fnDetectChallenge);
  const text = await page.evaluate(() => ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 6000)).catch(() => "");
  let screenshot = null;
  if (cmd.screenshotPath) {
    try { await page.screenshot({ path: cmd.screenshotPath, fullPage: true, ...maskedShot(page) }); screenshot = cmd.screenshotPath; } catch (e) { /* capture failure is reported as a null ref, never invented */ }
  }
  return { clicked: true, captcha: captcha || null, finalUrl: page.url(), text, screenshot };
}

async function execute(boardId, cmd) {
  validateAction(cmd);
  if (cmd.type === "shutdown") { setTimeout(() => process.exit(0), 50); return { ok: true }; }
  const board = await getBoard(boardId);
  board._snapshotFields = null; // meaning table is per-command (see meaningFields)
  if (["fill", "readback", "verify_payload", "review", "submit_and_capture"].includes(cmd.type)) assertObservation(cmd, board.observation, board.scope, board.page.url());
  switch (cmd.type) {
    case "open": return await cmdOpen(board, cmd);
    case "discover": return await cmdDiscover(board);
    case "fill": return await cmdFill(board, cmd);
    case "readback": return await cmdReadback(board, cmd);
    case "verify_payload": {
      const { answers } = await cmdReadback(board, cmd);
      if (answers.resume) answers.resume_sha256 = answers.resume.sha256;
      const mismatchedFields = Object.entries(cmd.payload).filter(([key, value]) => JSON.stringify(answers[key]) !== JSON.stringify(value)).map(([key]) => key);
      return { matches: mismatchedFields.length === 0, mismatchedFields };
    }
    case "review": return await cmdReview(board, cmd);
    case "submit_and_capture": return await cmdSubmitCapture(board, cmd);
    case "screenshot": await board.page.screenshot({ path: cmd.path, fullPage: true, ...maskedShot(board.page) }); return { path: cmd.path };
    case "close": await board.context.close().catch(() => {}); boards.delete(boardId); return { ok: true };
    default: throw Object.assign(new Error("unknown command " + cmd.type), { code: "BAD_COMMAND" });
  }
}

// ---------- file-command loop ----------
const seen = new Set();
async function pump() {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith("cmd-") && f.endsWith(".json")); } catch (e) { return; }
  files.sort();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    lastActivity = Date.now();
    const full = path.join(dir, f);
    let cmd;
    try { cmd = JSON.parse(fs.readFileSync(full, "utf8")); } catch (e) { continue; }
    const respName = "resp-" + f.slice(4);
    try {
      const data = await execute(cmd.boardId || "sys", cmd);
      fs.writeFileSync(path.join(dir, respName + ".tmp"), JSON.stringify({ ok: true, data }));
    } catch (e) {
      fs.writeFileSync(path.join(dir, respName + ".tmp"), JSON.stringify({ ok: false, error: { code: /SUID sandbox|sandbox.*abort|No usable sandbox/i.test(String(e.message)) ? "BROWSER_SANDBOX_UNAVAILABLE" : e.code || "DRIVER_ERROR", message: String(e.message || e) } }));
    }
    try { fs.renameSync(path.join(dir, respName + ".tmp"), path.join(dir, respName)); } catch (e) {}
    try { fs.unlinkSync(full); } catch (e) {}
  }
}
// Trusted worker/terminal seam (WO-009b): same executor and widgets, one owned
// context. A request can never choose another board or shut down its peers.
// The same challenge check the drive uses, for a caller that must re-check a page without reloading it (the person
// may just have completed a verification on it).
module.exports.detectChallenge = fnDetectChallenge;
module.exports.captchaTech = fnCaptchaTech;
module.exports.createSession = async () => {
  if (SANDBOX_OFF) throw Object.assign(new Error("BROWSER_SANDBOX_REQUIRED"), { code: "BROWSER_SANDBOX_REQUIRED" });
  const boardId = "worker-" + crypto.randomUUID();let closed = false;
  const active = () => { if (closed) throw new Error("BROWSER_SESSION_CLOSED"); };
  return {
    send: cmd => { active();if (cmd.type === "shutdown") throw new Error("SESSION_COMMAND_REFUSED");return execute(boardId, { ...cmd, boardId }); },
    page: async () => { active();return (await getBoard(boardId)).page; },
    async close() { if (closed) return;closed = true;if (boards.has(boardId)) await execute(boardId, { type: "close", boardId });if (!boards.size && browser) { await browser.close();browser = null; } },
  };
};
if (require.main === module) {
fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ pid: process.pid, at: Date.now(), chromiumSandbox: !SANDBOX_OFF }));
setInterval(() => {
  pump().catch(() => {});
  if (Date.now() - lastActivity > 15 * 60 * 1000) process.exit(0);
}, 25);
}
