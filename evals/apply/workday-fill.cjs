#!/usr/bin/env node
"use strict";
// WO-048: how the extension fills a Workday application, measured on a TEST Workday-shaped tenant.
//
//   node evals/apply/workday-fill.cjs --tenant <dir> [--out file] [--persona file]
//
// <dir> holds one HTML file per step and key.json (the shape of tests/fixtures/workday/dev-a: pages, fields, actions; or the
// second key schema {company, pages, rows, actions, notes}, normalized into that shape by normalizeKey below). The
// steps are served locally at a Workday tenant's URL by the TEST world (tests/fixtures/extension/world.cjs; Chromium
// resolves only the world's hosts, so nothing reaches a real Workday, Upmore or Supabase). The real extension runs in
// Chromium, signed in to the TEST world as the TEST persona (tests/fixtures/workday/persona.json, the persona of
// tests/fixtures/workday/sources.md, given as confirmed facts). Step by step, as a test person would:
//   1. press Fill on the first step (later steps fill themselves after an approved Save and Continue or a sign-in);
//   2. when the card is ready, grade every key row of the step against the page and the card, before the person touches
//      anything: fill-correct / fill-wrong / missed / asked-correctly / wrongly-filled-ask / never-ok / never-violation
//      (a value Workday set itself is "page-set": shown on the card as Workday's, never counted as Trainee's);
//   3. answer, as the person, every required field still empty (real input: clicks and typing), sign in on a sign-in
//      step, then tap Approve; the extension clicks Save and Continue;
//   4. on the review step, tap Submit only when the key's submit action says so (the dev keys say "ask": it stops there).
// Output: JSON (--out) and one summary line. coverage = correct / should-fill; precision = Trainee's correct fills /
// Trainee's fills; wrong = a wrong value or a filled ask; never-violations = a never row Trainee touched.
// Evidence label: VERIFIED-S on TEST Workday-shaped pages; real Workday NOT_RUN (needs a person signed in).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startWorld } = require("../../tests/fixtures/extension/world.cjs");

const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const PERSONA = path.join(ROOT, "tests/fixtures/workday/persona.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_FILE = { name: "test-person-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% TEST resume uploaded by the test person, WO-048\n") };

function playwright() {
  for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright", "/opt/node-tools/node_modules/playwright"]) {
    if (!id) continue;
    try {
      return require(id);
    } catch { /* next */ }
  }
  throw Error("PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH; nothing was downloaded");
}

// D-MS-1 (x-audit, 2026-11-10): the shipped extension types nothing before the tap (extension/config.js prefill: false).
// This harness measures the fill engine, and its Chromium resolves only the TEST world's hosts, so it loads a copy with
// prefill switched on (as tests/career-extension-browser.test.cjs does); the copy is removed on close.
function prefillCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-wd-ext-prefill-"));
  fs.cpSync(EXT, dir, { recursive: true });
  const cfg = path.join(dir, "config.js"), src = fs.readFileSync(cfg, "utf8"), on = src.replace(/prefill:\s*false/, "prefill: true");
  if (on === src) throw Error("config.js has no prefill: false to switch");
  fs.writeFileSync(cfg, on);
  return dir;
}

// The extension, unpacked, in a Chromium that resolves only the TEST world's hosts.
async function launch(world) {
  const pw = playwright();
  let auto = null;
  try {
    auto = pw.chromium.executablePath();
  } catch { /* none */ }
  const chrome = [process.env.UPMORE_EXTENSION_CHROMIUM_PATH, auto, "/opt/pw-browsers/chromium", process.env.UPMORE_CHROMIUM_PATH].find((p) => p && fs.existsSync(p));
  const sandboxOff = process.env.UPMORE_CHROMIUM_SANDBOX === "off";
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-wd-profile-"));
  const ext = prefillCopy();
  const ctx = await pw.chromium.launchPersistentContext(ud, {
    headless: true, ...(chrome ? { executablePath: chrome } : {}), ...(sandboxOff ? {} : { chromiumSandbox: true }), viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=${world.hostRules}`, "--ignore-certificate-errors", "--no-proxy-server",
      ...(sandboxOff ? ["--no-sandbox"] : [])],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  return { ctx, sw, close: async () => (await ctx.close().catch(() => {}), fs.rmSync(ud, { recursive: true, force: true }), fs.rmSync(ext, { recursive: true, force: true })) };
}
async function openPanel(ctx, sw, tabId) {
  const url = `chrome-extension://${new URL(sw.url()).host}/panel.html` + (tabId === null ? "" : `?tab=${tabId}`);
  const waiting = ctx.waitForEvent("page", { predicate: (p) => p.url() === url, timeout: 10000 });
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", focused: false, width: 440, height: 900 }), url);
  const p = await waiting;
  await p.waitForLoadState("domcontentloaded");
  return p;
}
// The person signs in to Upmore the way they already are: the app's own session, picked up from its tab.
async function signIn(ctx, sw) {
  const app = await ctx.newPage();
  await app.goto("https://upmore-topaz.vercel.app/");
  const panel = await openPanel(ctx, sw, null);
  await panel.click("#use-app");
  await panel.waitForSelector("#page:not([hidden])", { timeout: 10000 });
  await panel.close();
  await app.close();
}
const tabIdOf = (sw, url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u || t.pendingUrl === u)?.id ?? null, url);
const cardOf = (sw, id) => sw.evaluate(async (t) => ((await chrome.storage.session.get("cards")).cards || {})[t] || null, id);
async function waitCard(sw, id, pred, ms = 30000) {
  const end = Date.now() + ms;
  let c = null;
  while (Date.now() < end) {
    c = await cardOf(sw, id);
    if (c && pred(c)) return c;
    await sleep(150);
  }
  return null;
}
const settled = (url) => (c) => c.url === url && ["ready", "blocked", "stopped"].includes(c.status) && (c.payload || c.status === "stopped");

// ------------------------------------------------------------------------------------------------ the key's two schemas
// Schema 1 (tests/fixtures/workday/dev-a): {tenant, company, job, jobLocation, pages, persona, conventions, fields, actions}
// with page names without ".html" and actions {action: "sign-in"|"create-account"|"add-row"|"submit", section,
// rowsNeeded}. It is used exactly as written (normalizeKey returns the same object).
// Schema 2 (an independently written key): {company, pages, rows, actions, notes}. normalizeKey turns it into schema 1:
//   - tenant = the key's tenant, else the directory's name; job / jobLocation absent keep the harness defaults;
//   - rows -> fields: page without ".html", automationId = automationId or formField, section id -> the section's name
//     (kept as sectionId); `match`, `entity`, `path` carried as they are (`path` is not used in grading);
//   - actions {kind, page, should, nth, target} -> {action, page, should, section, ...}: sign_in -> sign-in,
//     create_account -> create-account, submit -> submit (graded as schema 1's are: sign-in is the person's step, submit
//     "ask" stops at review), add_row -> per section one add-row {rowsNeeded = the highest nth with should "fill"}; when
//     any nth says "never", one more add-row {should "never", rowsMax = rowsNeeded}: rows beyond rowsNeeded must not be
//     added (graded per step by gradeAddRow); "ask" nths are recorded, not graded;
//   - match: how a row's page value compares to expected (matchBy); absent -> the harness's own comparison;
//   - entity: a repeating-section slot is graded against whichever row of its section holds that entity, when the row
//     selectors name the slot ([aria-labelledby="<Section>-<n>-panel"] ...) and the slot has a row whose expected is the
//     entity; otherwise the label rule (Company / School / Language) as for schema 1; otherwise by slot.
// Anything the harness cannot read faithfully is listed in key_warnings (in the report) instead of being guessed.
// Round 3: a schema-2 key may also name its sections without the "Section" suffix.
const SECTION_NAMES = { workExperienceSection: "Work Experience", educationSection: "Education", languageSection: "Languages", languagesSection: "Languages", websiteSection: "Websites", websitesSection: "Websites",
  workExperience: "Work Experience", education: "Education", language: "Languages", languages: "Languages", website: "Websites", websites: "Websites" };
const ACTION_KINDS = { sign_in: "sign-in", create_account: "create-account", add_row: "add-row", submit: "submit" };
// WO-058: a schema-2 key's own type names for two kinds the reader knows by schema 1's names (sealed-wd2: a race
// "checkbox-group" read as a fieldset's value, a how-heard "multiselect" read as the search box, both always "").
const TYPE_KINDS = { "checkbox-group": "checkboxGroup", multiselect: "multiPrompt" };
const MATCH_KINDS = ["exact", "casefold", "contains-casefold", "digits", "url", "empty", "empty-or-na", "set"];
const pageName = (p) => String(p ?? "").replace(/\.html$/, "");
function normalizeKey(key, dir) {
  if (!key || Array.isArray(key.fields) || !Array.isArray(key.rows)) return key; // schema 1 (or no rows at all): as written
  const warnings = [];
  const fields = key.rows.map((r, i) => {
    const f = { ...r, page: pageName(r.page), expected: r.expected === undefined ? null : r.expected };
    if (TYPE_KINDS[r.type]) f.type = TYPE_KINDS[r.type];
    if (f.automationId === undefined && r.formField !== undefined) f.automationId = r.formField;
    if (r.section !== undefined) {
      f.sectionId = r.section;
      f.section = SECTION_NAMES[r.section] || r.section;
      if (!SECTION_NAMES[r.section]) warnings.push(`row ${i} (${r.label}): section "${r.section}" is not a known section id`);
    }
    if (r.match !== undefined && r.match !== null && !MATCH_KINDS.includes(r.match)) {
      warnings.push(`row ${i} (${r.label}): match "${r.match}" is unknown; graded by the harness's own comparison`);
      delete f.match;
    }
    if (!r.selector) warnings.push(`row ${i} (${r.label}): no selector; the harness cannot find it on the page`);
    return f;
  });
  const actions = [];
  const addRows = new Map();
  for (const a of key.actions || []) {
    const action = ACTION_KINDS[a.kind];
    if (!action) {
      warnings.push(`action kind "${a.kind}" is unknown; kept but not graded`);
      actions.push({ ...a, action: String(a.kind), page: pageName(a.page) });
      continue;
    }
    if (action !== "add-row") {
      actions.push({ action, page: pageName(a.page), should: a.should, ...(a.target !== undefined ? { target: a.target } : {}) });
      continue;
    }
    if (!SECTION_NAMES[a.target]) warnings.push(`add_row target "${a.target}" is not a known section id`);
    if (!addRows.has(a.target)) addRows.set(a.target, []);
    addRows.get(a.target).push(a);
  }
  for (const [target, list] of addRows) {
    const section = SECTION_NAMES[target] || target;
    const page = pageName(list[0].page);
    const nths = (should) => list.filter((a) => a.should === should).map((a) => Number(a.nth)).filter(Number.isFinite);
    const fills = nths("fill"), nevers = nths("never"), asks = nths("ask");
    const rowsNeeded = fills.length ? Math.max(...fills) : 0;
    if (list.some((a) => !Number.isFinite(Number(a.nth)))) warnings.push(`add_row ${target}: an action without a numeric nth`);
    if (fills.length) actions.push({ action: "add-row", page, section, target, rowsNeeded, should: "fill" });
    // Any "never" nth: rows beyond rowsNeeded must not be added (one graded check per section). Round 3: with no "fill" nth
    // (the first rows are the person's call, "ask"), the rows below the lowest "never" may be there: lowest never - 1.
    nevers.sort((x, y) => x - y);
    if (nevers.length) actions.push({ action: "add-row", page, section, target, rowsMax: fills.length ? rowsNeeded : Math.max(0, nevers[0] - 1), nths: nevers, should: "never" });
    // An "ask" nth (the person decides whether to add it) is recorded, not graded.
    if (asks.length) actions.push({ action: "add-row", page, section, target, nths: asks.sort((x, y) => x - y), should: "ask" });
  }
  const out = { tenant: key.tenant || (dir ? path.basename(path.resolve(dir)) : undefined), company: key.company, pages: key.pages || [], fields, actions, schema: 2 };
  if (key.job !== undefined) out.job = key.job;
  if (key.jobLocation !== undefined) out.jobLocation = key.jobLocation;
  if (key.notes !== undefined) out.notes = key.notes;
  out.key_warnings = warnings;
  return out;
}
// How many rows a repeating section holds now (rows the extension must not add are graded by this).
function countSectionRows(list) {
  const re = /-\d+-panel$/;
  return list.map(({ target, section }) => {
    const box = target ? document.querySelector(`[data-automation-id="${CSS.escape(target)}"]`) : null;
    const groups = Array.from((box || document).querySelectorAll('[role="group"][aria-labelledby$="-panel"]')).filter((g) => re.test(g.getAttribute("aria-labelledby")));
    const prefix = String(section || "").trim().replace(/\s+/g, "-") + "-";
    return box ? groups.length : groups.filter((g) => g.getAttribute("aria-labelledby").startsWith(prefix)).length;
  });
}
// A schema-2 section with a "never" add_row: once the step is filled it must hold at most rowsMax (= rowsNeeded) rows.
// The harness cannot tell who added a row; rows already present when Workday served the page would count too.
function gradeAddRow(a, count) {
  const base = { page: a.page, label: `${a.section}: no rows beyond ${a.rowsMax} (add_row never: ${a.nths.join(", ")})`, type: "add-row", should: "never",
    expected: `at most ${a.rowsMax} rows`, got: count, source: null, selector: null };
  return count > a.rowsMax ? { ...base, verdict: "never-violation", why: `the section holds ${count} rows; at most ${a.rowsMax} may be added` } : { ...base, verdict: "never-ok" };
}

// ------------------------------------------------------------------------------------------------ reading the key rows
// Each row's control as the key names it, read in the page: its value by the key's type, whether it is hidden, and the
// names the extension may know it by (the control's id or name, its date group, its wrapper).
function readRows(rows) {
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const hidden = (n) => {
    for (; n && n !== document.body; n = n.parentElement) if (n.hidden || getComputedStyle(n).display === "none") return true;
    return false;
  };
  const labelFor = (i) => clean(i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent : i.closest("label")?.textContent);
  return rows.map((r) => {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(r.selector));
    } catch { /* a selector this page cannot read */ }
    // WO-058: a schema-2 radio row names its group (`[id="<name>"]`, the radios' shared name, no element of that id).
    const group = !els.length && r.type === "radio" ? /^\[id="([^"]+)"\]$/.exec(String(r.selector)) : null;
    if (group) els = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(group[1])}"]`));
    if (!els.length) return { found: false, hidden: true, value: "", names: [] };
    // WO-058: a row that names the group's own box (a fieldset with the radios or checkboxes inside, sealed-wd2 t2) is read
    // by the inputs inside it.
    const kind = r.type === "radio" ? "radio" : r.type === "checkboxGroup" ? "checkbox" : null;
    if (kind && !els.some((x) => x.matches?.(`input[type="${kind}"]`))) {
      const inner = els.flatMap((x) => Array.from(x.querySelectorAll(`input[type="${kind}"]`)));
      if (inner.length) els = inner;
    }
    const el = els[0];
    const wrap = el.closest('[data-automation-id^="formField-"], [data-automation-id="attachments-FileUpload"]');
    let value, list; // list: the chosen labels one by one, for a schema-2 "set" comparison (not used by schema 1)
    const spins = () => {
      const ps = Array.from(el.querySelectorAll('[role="spinbutton"]'));
      const v = ps.map((p) => p.value);
      return v.every((x) => !x) ? "" : v.join("/");
    };
    switch (r.type) {
      case "text": case "textarea": case "email": case "tel": value = String(el.value ?? ""); break;
      case "dropdown": { const t = clean(el.textContent); value = /^select one$/i.test(t) ? "" : t; break; }
      case "prompt": case "multiPrompt": {
        const c = el.closest('[data-automation-id="multiSelectContainer"]') || wrap || document;
        list = Array.from(c.querySelectorAll('[data-automation-id="promptSelectionLabel"]')).map((p) => clean(p.textContent));
        value = list.join(", ");
        break;
      }
      case "radio": list = els.filter((x) => x.checked).map(labelFor); value = list.join(", "); break;
      case "checkbox": value = !!el.checked; break;
      case "checkboxGroup": value = els.filter((x) => x.checked).map(labelFor); break;
      case "monthYear": case "year": case "date": value = el.matches('[role="spinbutton"]') ? String(el.value || "") : spins(); break;
      case "file": value = Array.from((wrap || document).querySelectorAll('[data-automation-id="file-upload-item-name"]')).map((n) => clean(n.textContent)).join(", "); break;
      case "password": value = el.value ? "(something typed)" : ""; break;
      default: value = el.matches("button") ? clean(el.textContent) : String(el.value ?? "");
    }
    const names = [el.id, el.getAttribute("name"), el.closest('[data-automation-id="dateInputWrapper"]')?.id, wrap?.getAttribute("data-automation-id"),
      wrap?.querySelector('[data-automation-id="select-files"]')?.id].filter(Boolean);
    return { found: true, hidden: hidden(el), value, names, ...(list ? { list } : {}) };
  });
}
// Rows of a repeating section match by their company, school or language, not by their order (the key's convention).
function remapRows(groups) {
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const val = (el) => (!el ? "" : el.matches("button") ? clean(el.textContent) : el.matches('[data-automation-id="searchBox"]')
    ? Array.from((el.closest('[data-automation-id="multiSelectContainer"]') || document).querySelectorAll('[data-automation-id="promptSelectionLabel"]')).map((p) => clean(p.textContent)).join(", ")
    : clean(el.value));
  const used = new Set(), out = {};
  for (const g of groups) {
    const rows = Array.from(document.querySelectorAll(`[role="group"][aria-labelledby^="${g.panel}-"][aria-labelledby$="-panel"]`));
    for (const row of rows) {
      const n = Number(/-(\d+)-panel$/.exec(row.getAttribute("aria-labelledby"))[1]);
      if (used.has(g.panel + n)) continue;
      let el = null;
      try {
        el = row.querySelector(g.anchorSub);
      } catch { /* none */ }
      if (val(el) && val(el) === clean(g.expected)) {
        used.add(g.panel + n);
        out[g.panel + "-" + g.n] = n;
        break;
      }
    }
  }
  return out;
}
const PANEL = /^\[aria-labelledby="([A-Za-z-]+?)-(\d+)-panel"\]\s*(.*)$/;
function rowGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const m = PANEL.exec(r.selector);
    if (!m) continue;
    const k = m[1] + "-" + m[2];
    if (!groups.has(k)) groups.set(k, { panel: m[1], n: Number(m[2]), rows: [] });
    groups.get(k).rows.push({ r, sub: m[3] });
  }
  const out = [];
  for (const g of groups.values()) {
    // Schema 2: a slot's rows name their entity (the employer, school, language or site the slot is about). The anchor is
    // the slot's row whose expected value is that entity; with none, the label rule below; with neither, by slot.
    const ent = g.rows.map((x) => x.r.entity).find((e) => typeof e === "string" && e.trim());
    const same = (x) => ent && x.r.expected != null && !Array.isArray(x.r.expected) && norm(x.r.expected) === norm(ent);
    const byEntity = ent ? g.rows.find((x) => same(x) && x.r.should === "fill") || g.rows.find(same) : null;
    const a = byEntity || g.rows.find((x) => x.r.should === "fill" && /^(company|company name|employer|school|school or university|university|school name|language)$/i.test(String(x.r.label).trim()) && x.r.expected);
    if (a) out.push({ panel: g.panel, n: g.n, anchorSub: a.sub, expected: String(a.r.expected) });
  }
  return out;
}
function remapSelector(sel, map) {
  const m = PANEL.exec(sel);
  if (!m) return sel;
  const to = map[m[1] + "-" + m[2]];
  return to ? `[aria-labelledby="${m[1]}-${to}-panel"] ${m[3]}` : sel;
}

// ------------------------------------------------------------------------------------------------ grading
const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const digits = (v) => String(v ?? "").replace(/\D/g, "");
const emptyExpected = (e) => e === "" || e === false || (Array.isArray(e) && !e.length);
const isEmpty = (v) => v === "" || v === false || v === null || v === undefined || (Array.isArray(v) && !v.length);
// Schema 2's `match`: how the page's value compares to `expected`.
const isBlank = (v) => isEmpty(v) || (typeof v === "string" && !v.trim());
const urlKey = (v) => {
  const s = String(v ?? "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const cut = s.search(/[/?#]/);
  const host = (cut < 0 ? s : s.slice(0, cut)).toLowerCase().replace(/^www\./, ""); // hosts are case-insensitive; paths are not
  return host + (cut < 0 ? "" : s.slice(cut));
};
function matchBy(kind, e, value, list) {
  switch (kind) {
    case "exact": return String(value ?? "").trim() === String(e ?? "").trim();
    case "casefold": return norm(value) === norm(e);
    case "contains-casefold": return norm(value).includes(norm(e));
    case "digits": return digits(value) === digits(e);
    case "url": return urlKey(value) === urlKey(e);
    case "empty": return isBlank(value);
    case "empty-or-na": return isBlank(value) || /^(n\/a|not applicable)$/.test(norm(value));
    case "set": {
      const got = Array.isArray(list) ? list : Array.isArray(value) ? value : isBlank(value) ? [] : String(value).split(",");
      const a = [...new Set((Array.isArray(e) ? e : e == null ? [] : [e]).map(norm).filter(Boolean))].sort();
      const b = [...new Set(got.map(norm).filter(Boolean))].sort();
      return JSON.stringify(a) === JSON.stringify(b);
    }
  }
  return null; // unknown: the harness's own comparison decides
}
// The correct final state is empty: schema 1 says so with an empty expected, schema 2 also with match "empty"/"empty-or-na".
const wantsEmpty = (row) => emptyExpected(row.expected) || row.match === "empty" || row.match === "empty-or-na";
function matches(row, value, list) {
  const e = row.expected;
  if (row.match) {
    const r = matchBy(row.match, e, value, list);
    if (r !== null) return r;
  }
  if (row.type === "checkbox") return !!value === !!e;
  if (Array.isArray(e) || Array.isArray(value)) {
    const a = (Array.isArray(e) ? e : [e]).map(norm).sort(), b = (Array.isArray(value) ? value : [value]).filter((x) => x !== "").map(norm).sort();
    return JSON.stringify(a.filter(Boolean)) === JSON.stringify(b);
  }
  if (emptyExpected(e)) return isEmpty(value);
  if (norm(value) === norm(e)) return true;
  // A number, a phone or a pay amount: the same digits in any rendering ("$95,000", "555-010-0000"); never with letters in the expected.
  return /^[\d\s$,.()+-]+$/.test(String(e)) && digits(e).length >= 4 && !/[a-z]/i.test(String(value).replace(/\b(usd|dollars)\b/gi, "")) && digits(value) === digits(e);
}
function cardField(fields, names) {
  return fields.find((f) => names.includes(f.name)) ||
    fields.find((f) => names.some((n) => f.name.startsWith(n + "@") || f.name.startsWith(n + "~"))) || null;
}
function grade(row, read, fields) {
  const f = read.found ? cardField(fields, read.names) : null;
  const src = f?.source ?? null, trainee = src === "trainee";
  const base = { page: row.page, label: row.label, type: row.type, should: row.should, expected: row.expected ?? null, got: read.value, source: src, selector: row.selector,
    ...(row.match ? { match: row.match } : {}), ...(row.entity ? { entity: row.entity } : {}) };
  if (row.should === "fill") {
    if (!read.found) return { ...base, verdict: "missed", why: "the control is not on the page (a row not added?)" };
    if (matches(row, read.value, read.list)) {
      if (trainee) return { ...base, verdict: "fill-correct" };
      if (wantsEmpty(row)) return { ...base, verdict: "fill-correct", by_leaving: true };
      if (src === "workday") return { ...base, verdict: "page-set", why: "set by Workday before Trainee read the page: shown as Workday's, not Trainee's" };
      return { ...base, verdict: "page-set", why: "a value nobody on the card claims" };
    }
    if (trainee) return { ...base, verdict: "fill-wrong" };
    if (isEmpty(read.value)) return { ...base, verdict: "missed" };
    return { ...base, verdict: src === "workday" ? "page-set-wrong" : "missed", why: "a value Trainee did not set, and not the right one" };
  }
  if (row.should === "ask") return { ...base, verdict: trainee ? "wrongly-filled-ask" : "asked-correctly" };
  if (row.should === "never") {
    if (trainee) return { ...base, verdict: "never-violation" };
    if (row.conditional && read.found && !read.hidden) return { ...base, verdict: "never-violation", why: "a conditional field that must stay hidden is showing" };
    return { ...base, verdict: "never-ok" };
  }
  return { ...base, verdict: "unknown-should" };
}

// ------------------------------------------------------------------------------------------------ the test person
// The person answers, with real input, what is theirs: every required field still empty, what the card says is still
// needed, and (round 3) a value the page set itself that blocks the tap. What they give is never graded (each step is
// graded before they touch it). Round 3: where the key has the answer, the person gives the key's answer (the expected
// value; a clear where the right state is empty; the TEST resume for a file); elsewhere a generic one (the first option, a
// TEST text).
function personAnswerFor(row) {
  if (!row) return null;
  if (row.type === "file") return { upload: true };
  if (row.should === "never" || wantsEmpty(row)) return { clear: true };
  if (row.expected === null || row.expected === undefined) return null;
  return { value: row.expected };
}
// Tags each field the person answers now: o.selectors are the step's key rows (to find a field's row), o.required which
// of them the key says are required, o.names the card's fields the page set (to change or clear), o.labels what the card
// still needs. A field's required mark: a "*" in an abbr, Workday's abbr[title=required] (a star drawn by CSS), an
// aria-required control, or the key.
function tagForPerson(o) {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sel = '[data-automation-id^="formField-"], [data-automation-id="attachments-FileUpload"]';
  const clean = (t) => String(t || "").replace(/[*✱]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const asked = (o.labels || []).map(clean).filter(Boolean);
  const pageSet = new Set((o.names || []).map((n) => String(n).replace(/~\d+$/, "").replace(/@.*$/, "")));
  const out = [];
  document.querySelectorAll("[data-eval-person]").forEach((e) => e.removeAttribute("data-eval-person"));
  Array.from(document.querySelectorAll(sel)).filter((w) => !w.parentElement.closest(sel) && vis(w)).forEach((w, i) => {
    if (w.querySelector('input[type="password"]')) return;
    const file = w.querySelector('input[type="file"]'), date = w.querySelector('[data-automation-id="dateInputWrapper"]');
    const prompt = w.querySelector('[data-automation-id="searchBox"]') || w.querySelector('[data-automation-id="multiSelectContainer"] input[type="text"]');
    const list = w.querySelector('button[aria-haspopup="listbox"]');
    const radios = w.querySelectorAll('input[type="radio"]'), boxes = w.querySelectorAll('input[type="checkbox"]');
    const area = w.querySelector("textarea"), text = w.querySelector('input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"]');
    let kind = null, empty = false, parts = 0;
    if (file) [kind, empty] = ["file", !w.querySelector('[data-automation-id="file-upload-item"]')];
    else if (date) {
      const ps = Array.from(date.querySelectorAll('[role="spinbutton"]'));
      [kind, empty, parts] = ["date", ps.some((p) => !p.value), ps.length];
    } else if (prompt) [kind, empty] = ["prompt", !w.querySelector('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"]')];
    else if (list) [kind, empty] = ["list", /^select one$/i.test(list.textContent.trim()) || !list.textContent.trim()];
    else if (radios.length) [kind, empty] = ["radio", !Array.from(radios).some((r) => r.checked)];
    else if (boxes.length) [kind, empty] = ["box", !Array.from(boxes).some((r) => r.checked)];
    else if (area) [kind, empty] = ["text", !area.value.trim()];
    else if (text) [kind, empty] = ["text", !text.value.trim()];
    if (!kind) return;
    let row = -1;
    (o.selectors || []).some((s, k) => {
      try {
        if (Array.from(document.querySelectorAll(s)).some((e) => w === e || w.contains(e))) row = k;
      } catch { /* a selector this page cannot read */ }
      return row >= 0;
    });
    const req = Array.from(w.querySelectorAll("abbr")).some((a) => /\*/.test(a.textContent) || /^required$/i.test(a.getAttribute("title") || "")) ||
      !!w.querySelector('[aria-required="true"]') || (row >= 0 && !!(o.required || [])[row]);
    const lab = clean((w.querySelector("legend") || w.querySelector("label"))?.textContent);
    const needed = !!lab && asked.some((l) => l === lab || l.endsWith(": " + lab));
    const ids = [w.getAttribute("data-automation-id"), ...Array.from(w.querySelectorAll("input, button, textarea, [data-automation-id=dateInputWrapper]")).flatMap((e) => [e.id, e.getAttribute("name")])].filter(Boolean);
    let mode = null;
    if (!empty && ids.some((x) => pageSet.has(x))) mode = "pageSet";
    else if (empty && (req || needed)) mode = "empty";
    if (!mode) return;
    w.setAttribute("data-eval-person", String(i));
    out.push({ i, kind, parts, row, mode });
  });
  return out;
}
// The person drags their file onto Workday's drop zone: a real (trusted) drop, as the browser makes it. Playwright's own
// file setters fire untrusted events, which the extension rightly treats as the page's, not the person's. Round 3: a
// drop zone that takes no drop gets the person's click on "Select files" and the file chosen in the browser's own chooser.
function testResumeFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trainee-wd-file-")), TEST_FILE.name);
  fs.writeFileSync(file, TEST_FILE.buffer);
  return file;
}
async function personDropsFile(page, wrapper) {
  const zone = wrapper.locator('[data-automation-id="file-upload-drop-zone"]').first();
  await (await zone.count() ? zone : wrapper).scrollIntoViewIfNeeded();
  const box = (await zone.count()) ? await zone.boundingBox() : await wrapper.boundingBox();
  const file = testResumeFile();
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x, y, data });
  await cdp.detach().catch(() => {});
}
const uploaded = (w) => w.locator('[data-automation-id="file-upload-item"], [data-automation-id="file-upload-item-name"]').count().then((n) => n > 0).catch(() => false);
async function personUploads(page, w) {
  await personDropsFile(page, w);
  for (let k = 0; k < 15 && !(await uploaded(w)); k++) await sleep(100);
  if (await uploaded(w)) return;
  const pick = w.locator('[data-automation-id="select-files"], button:has-text("Select files"), button:has-text("Upload")').first();
  if (!(await pick.count())) throw Error("no drop zone took the file and there is no Select files button");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 4000 }), pick.click()]);
  await chooser.setFiles(testResumeFile());
  for (let k = 0; k < 20 && !(await uploaded(w)); k++) await sleep(100);
}
const POPUP = '[role="listbox"]:not([data-automation-id="selectedItemList"])';
const same = (a, b) => norm(String(a).replace(/[›*]/g, "")) === norm(String(b).replace(/[›*]/g, ""));
// The index of the open list's option whose text is `label` (-1: none).
async function optionIndex(page, label) {
  const texts = await page.locator(`${POPUP} [role="option"]`).allTextContents().catch(() => []);
  return texts.findIndex((t) => same(t, label));
}
// The person picks `value` on a search prompt: types the leaf, searches, and clicks the one result that is it.
async function personPrompts(page, w, value) {
  const leaf = String(value).split(" > ").pop();
  const box = w.locator('[data-automation-id="searchBox"], [data-automation-id="multiSelectContainer"] input[type="text"]').first();
  await box.click();
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(leaf, { delay: 10 });
  await page.keyboard.press("Enter");
  const end = Date.now() + 3000;
  let i = -1;
  while (Date.now() < end && (i = await optionIndex(page, leaf)) < 0) await sleep(100);
  if (i < 0) {
    await page.keyboard.press("Escape").catch(() => {});
    throw Error(`no option "${leaf}" on the prompt`);
  }
  await page.locator(`${POPUP} [role="option"]`).nth(i).click();
  await sleep(100);
  await page.keyboard.press("Escape").catch(() => {});
}
// The person gives one answer (`a` from personAnswerFor, or null for a generic one; `same` re-confirms what is there).
async function personGives(page, w, t, a) {
  const v = a && "value" in a ? a.value : undefined;
  if (t.kind === "file") return personUploads(page, w);
  if (t.kind === "text") {
    const box = w.locator("textarea, input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=number], input[type=url]").first();
    return box.fill(a?.clear ? "" : v !== undefined ? (Array.isArray(v) ? v.join(", ") : String(v)) : a?.same ? await box.inputValue() : "TEST answer typed by the person");
  }
  if (t.kind === "radio") {
    const labels = await w.locator('input[type="radio"]').evaluateAll((rs) => rs.map((r) => (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent) || r.closest("label")?.textContent || r.value));
    const k = v !== undefined ? labels.findIndex((l) => same(l, v)) : a?.same ? await w.locator('input[type="radio"]').evaluateAll((rs) => rs.findIndex((r) => r.checked)) : 0;
    return w.locator('input[type="radio"]').nth(Math.max(0, k)).check();
  }
  if (t.kind === "box") {
    const boxes = w.locator('input[type="checkbox"]');
    if ((await boxes.count()) > 1 && Array.isArray(v)) {
      const labels = await boxes.evaluateAll((rs) => rs.map((r) => (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent) || r.closest("label")?.textContent || r.value));
      for (const [k, l] of labels.entries()) await boxes.nth(k).setChecked(v.some((x) => same(x, l)));
      return;
    }
    return boxes.first().setChecked(a?.clear ? false : v !== undefined ? v === true || /^(yes|true|on|checked)$/i.test(String(v)) : true);
  }
  if (t.kind === "date") {
    await w.locator('[role="spinbutton"]').first().click();
    const d = v !== undefined ? String(v).replace(/\D/g, "") : "";
    return page.keyboard.type(d || (t.parts === 1 ? "2020" : t.parts === 2 ? "012020" : "01012020"), { delay: 15 });
  }
  if (t.kind === "list") {
    const btn = w.locator('button[aria-haspopup="listbox"]').first();
    const now = (await btn.textContent()).trim();
    await btn.click();
    const opts = page.locator(`${POPUP} [role="option"]:not([aria-disabled="true"])`);
    await opts.first().waitFor({ timeout: 3000 });
    const want = a?.clear ? "Select One" : v !== undefined ? String(v) : a?.same ? now : null;
    const k = want === null ? -1 : await optionIndex(page, want);
    if (want !== null && k < 0) throw Error(`no option "${want}" on the list`);
    return (k >= 0 ? page.locator(`${POPUP} [role="option"]`).nth(k) : opts.filter({ hasNotText: /^\s*Select One\s*$/i }).first()).click({ timeout: 3000 });
  }
  if (t.kind === "prompt") {
    if (a?.clear || (v !== undefined && t.mode === "pageSet")) {
      const x = w.locator('[data-automation-id="DELETE_charm"]');
      for (let n = await x.count(); n > 0; n--) await x.first().click().catch(() => {});
      if (a?.clear) return;
    }
    if (v !== undefined) {
      for (const one of Array.isArray(v) ? v : [v]) await personPrompts(page, w, one);
      return;
    }
    // Generic: the open list's options (never a chosen pill of another prompt, which is an option of its own list); a
    // category opens the next level, which replaces the list.
    await w.locator('[data-automation-id="searchBox"], [data-automation-id="multiSelectContainer"] input[type="text"]').first().click();
    for (let k = 0; k < 4; k++) {
      const opt = page.locator(`${POPUP} [role="option"]`).first();
      await opt.waitFor({ timeout: 3000 });
      const cat = (await opt.getAttribute("aria-haspopup")) === "true" || (await opt.locator('[data-automation-id="promptOptionMore"], .wd-icon-chevron-right-small').count()) > 0;
      await opt.click();
      if (!cat) break;
      await sleep(150);
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
}
// One pass of the person over the step. o: { rows (the step's key rows, selectors as on the page), names, labels }.
async function personAnswers(page, log, o = {}) {
  const rows = o.rows || [];
  const done = [], seen = new Set();
  for (let round = 0; round < 4; round++) {
    const todo = (await page.evaluate(tagForPerson, { selectors: rows.map((r) => r.selector), required: rows.map((r) => r.required === true),
      names: round === 0 ? o.names || [] : [], labels: round === 0 ? o.labels || [] : [] })).filter((t) => !seen.has(t.mode + t.i));
    if (!todo.length) break;
    for (const t of todo) {
      seen.add(t.mode + t.i);
      const w = page.locator(`[data-eval-person="${t.i}"]`).first();
      // A required field still empty that the key keeps empty for Trainee ("never", or the person's to state): the person
      // still answers it (generically: the key has no answer of theirs to give).
      const a0 = personAnswerFor(rows[t.row]), a = t.mode === "empty" && a0?.clear ? null : a0;
      try {
        // A page-set value with nothing in the key: the person keeps it, as their own choice (re-confirmed).
        await personGives(page, w, t, t.mode === "pageSet" && !a ? { same: true } : a);
        done.push(t.mode === "pageSet" ? "page-set:" + t.kind : t.kind);
        o.gave?.push({ kind: t.kind, mode: t.mode, from: !a ? (t.mode === "pageSet" ? "kept" : "generic") : a.upload ? "TEST resume" : a.clear ? "cleared" : "key" });
      } catch (e) {
        log(`  the test person could not answer a ${t.mode === "pageSet" ? "page-set" : "required"} ${t.kind}${a && "value" in a ? ` (${JSON.stringify(a.value)})` : ""}: ${String(e.message).split("\n")[0]}`);
        if (a && "value" in a && t.mode === "empty") {
          // The key's answer is not on the page as written: the person's own generic answer, so the step can go on.
          await personGives(page, w, t, null).then(() => done.push(t.kind)).catch(() => {});
        }
      }
      await sleep(80);
    }
    await sleep(300);
  }
  await page.evaluate(() => document.querySelectorAll("[data-eval-person]").forEach((e) => e.removeAttribute("data-eval-person")));
  return done;
}
// The person signs in on Workday's own sign-in step, themselves (TEST credentials, typed by the test person, with real
// keys and a real pointer). Round 2: Workday lays a click_filter over its own Sign In button, so the person's click lands
// on whatever is on top at the button's centre (as a real click does), never on a hidden control; an email-first sign-in
// (only the email and Next, the password on the next view) takes two rounds. Round 3: the password a person would choose
// (letters, a number, a symbol: a password rule refuses one without), a custom "I agree" box ticked, and the wait after
// the click is for the person to be in (a new page, or the application shown in place), up to 45 s; a sign-in that does
// not let them in says why (the page's own message). Nothing here is the extension's.
const PERSON_PASSWORD = "TEST-password-typed-by-the-person-2026!";
const signInGone = () => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  if (Array.from(document.querySelectorAll('input[type="password"], [data-automation-id="signInContent"], [data-automation-id="createAccountContent"]')).some(vis)) return false;
  return Array.from(document.querySelectorAll('[data-automation-id^="formField-"], [data-automation-id="applyFlowPage"], [data-automation-id="applyFlowReviewPage"], [data-automation-id="progressBar"]')).some(vis);
};
const pageMessage = (page) => page.evaluate(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  return Array.from(document.querySelectorAll('[role="alert"], [data-automation-id="errorMessage"], .wd-error-banner'))
    .filter(vis).map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ").slice(0, 300);
}).catch(() => "");
// Signed in: the page moved on, or the application is shown where the sign-in was. null while neither.
async function signedIn(page, before) {
  if (page.url() !== before) return "navigated";
  return (await page.evaluate(signInGone).catch(() => false)) ? "in-place" : null;
}
async function waitSignedIn(page, before, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await signedIn(page, before);
    if (s) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return s;
    }
    await sleep(250);
  }
  const why = await pageMessage(page);
  throw Error(`the test person's sign-in did not let them in within ${Math.round(ms / 1000)} s${why ? `: the page says "${why}"` : " (the page showed no message)"}`);
}
async function personSignsIn(page) {
  const before = page.url();
  for (let round = 0; round < 3; round++) {
    // The click of the round before may have signed them in while it was being checked: never type into the application.
    if (round > 0 && (await sleep(300), await signedIn(page, before))) return;
    const inputs = await page.evaluate(() => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const view = Array.from(document.querySelectorAll('[data-automation-id="signInContent"], [data-automation-id="createAccountContent"]')).find(vis) || document.body;
      document.querySelectorAll("[data-eval-signin]").forEach((e) => e.removeAttribute("data-eval-signin"));
      const boxes = Array.from(view.querySelectorAll('input, [role="checkbox"]')).filter((i) => vis(i) && i.type !== "hidden" && i.getAttribute("data-automation-id") !== "beecatcher" && i.tabIndex !== -1);
      return boxes.map((i, n) => {
        i.setAttribute("data-eval-signin", String(n));
        const custom = i.tagName !== "INPUT";
        return { n: String(n), type: custom ? "checkbox" : i.type, custom, empty: custom ? i.getAttribute("aria-checked") !== "true" : i.type === "checkbox" ? !i.checked : !i.value };
      });
    }).catch(() => []);
    for (const i of inputs.filter((x) => x.empty)) {
      const loc = page.locator(`[data-eval-signin="${i.n}"]`);
      if (i.type === "checkbox") await (i.custom ? loc.click() : loc.check()).catch(() => {});
      else if (i.type !== "radio") {
        await loc.click().catch(() => {});
        await page.keyboard.type(i.type === "password" ? PERSON_PASSWORD : "test.person@example.test", { delay: 5 });
      }
    }
    // The button the person presses: the view's own submit (Sign In, Create Account, Next, Continue), by its centre.
    const box = await page.evaluate(() => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const label = (b) => String(b.getAttribute("aria-label") || b.value || b.textContent || "").replace(/\s+/g, " ").trim();
      const b = Array.from(document.querySelectorAll('[data-automation-id="click_filter"], button, [role="button"], input[type="submit"]'))
        .find((x) => vis(x) && /^(sign in|create account|next|continue|log in)$/i.test(label(x)));
      if (!b) return null;
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (!box) {
      if (await signedIn(page, before)) return;
      throw Error("the test person found no Sign In, Next or Continue button");
    }
    await page.mouse.click(box.x, box.y);
    // Moved on (signed in, or on its way: "Signing in..."), the next view of the same sign-in (the password after the
    // email), or an error the page shows.
    const end = Date.now() + 8000;
    let more = false, why = "";
    while (Date.now() < end) {
      if (await signedIn(page, before)) return;
      // More of the sign-in: an empty password box, or an empty box of Workday's sign-in view (never the application's).
      more = await page.evaluate(() => Array.from(document.querySelectorAll('input[type="password"], [data-automation-id="signInContent"] input, [data-automation-id="createAccountContent"] input'))
        .some((i) => i.getClientRects().length > 0 && i.type !== "hidden" && i.getAttribute("data-automation-id") !== "beecatcher" && i.tabIndex !== -1 &&
          (i.type === "checkbox" ? false : !i.value))).catch(() => false);
      if (more) break;
      why = await pageMessage(page);
      if (why) break;
      await sleep(150);
    }
    if (!more && !why) {
      // Workday answered nothing yet: a slow sign-in moves on by itself; otherwise the person presses Enter in the last box.
      if (await waitSignedIn(page, before, 10000).catch(() => null)) return;
      await page.keyboard.press("Enter").catch(() => {});
      await sleep(1500);
      if (await signedIn(page, before)) return;
    }
  }
}

// ------------------------------------------------------------------------------------------------ one tenant
function slug(s) {
  return String(s || "").replace(/\(.*?\)/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tenant";
}
async function runTenant(o) {
  const log = o.log || ((m) => console.error(m));
  const dir = path.resolve(o.tenant);
  const key = normalizeKey(JSON.parse(fs.readFileSync(path.join(dir, "key.json"), "utf8")), dir);
  const persona = JSON.parse(fs.readFileSync(o.persona || PERSONA, "utf8")).facts;
  const pages = key.pages || [];
  const submitAction = (key.actions || []).find((a) => a.action === "submit");
  const report = {
    measured_at: new Date().toISOString(), tenant: key.tenant || path.basename(dir), company: key.company, evidence: "VERIFIED-S on TEST Workday-shaped pages; real Workday NOT_RUN",
    pages: [], rows: [], actions: [], submitted: false, records: 0, errors: [],
  };
  if (key.schema === 2) {
    report.key_schema = 2;
    report.key_warnings = key.key_warnings || [];
    for (const w of report.key_warnings) log(`${report.tenant}: key warning: ${w}`);
  }
  const world = await startWorld();
  const host = `${slug(key.company)}.wd5.myworkdayjobs.com`;
  const base = `/en-US/External/job/${slug(key.jobLocation || "Remote")}/${slug(key.job || "Job")}_R-10001/apply/`;
  const tenant = world.workdayTenant({ host, dir, base });
  for (const [k, v] of Object.entries(persona)) world.answer("fact:" + k, "fact", String(v));
  let browser = null;
  try {
    browser = await launch(world);
    const { ctx, sw } = browser;
    await signIn(ctx, sw);
    const page = await ctx.newPage();
    await page.goto(tenant.url(pages[0]), { waitUntil: "domcontentloaded" });
    await sleep(200);
    const tabId = await tabIdOf(sw, page.url());
    const panel = await openPanel(ctx, sw, tabId);
    let pressedFill = false;
    let inPlace = null; // round 3: the step a sign-in showed where it was (same URL), by the key's page order
    for (let step = 0; step < pages.length + 2; step++) {
      await page.waitForLoadState("domcontentloaded");
      const url = page.url();
      const file = inPlace ?? decodeURIComponent(new URL(url).pathname.slice(base.length));
      inPlace = null;
      const name = file.replace(/\.html$/, "");
      const rows = (key.fields || []).filter((r) => r.page === name);
      log(`${report.tenant}: ${file}`);
      // Fill: the person presses it on the first step; afterwards each step fills itself.
      let card = await waitCard(sw, tabId, settled(url), pressedFill ? 12000 : 1500);
      if (!card) {
        await panel.click("#fill");
        pressedFill = true;
        card = await waitCard(sw, tabId, settled(url), 60000);
      }
      if (!card) {
        const c = await cardOf(sw, tabId);
        report.errors.push(`${file}: no card for this step (the card now: ${JSON.stringify(c && { status: c.status, url: c.url, message: c.message })})`);
        break;
      }
      // Grade before the person touches anything.
      const map = await page.evaluate(remapRows, rowGroups(rows));
      const read = await page.evaluate(readRows, rows.map((r) => ({ ...r, selector: remapSelector(r.selector, map) })));
      const fields = card.payload?.fields || [];
      const graded = rows.map((r, i) => grade(r, read[i], fields));
      // Schema 2: rows the key says must not be added (add_row, should "never").
      const neverRows = (key.actions || []).filter((a) => a.action === "add-row" && a.page === name && a.should === "never" && Number.isFinite(a.rowsMax));
      if (neverRows.length) {
        const counts = await page.evaluate(countSectionRows, neverRows.map((a) => ({ target: a.target, section: a.section })));
        neverRows.forEach((a, i) => graded.push(gradeAddRow(a, counts[i])));
      }
      report.rows.push(...graded);
      const traineeNames = new Set(fields.filter((f) => f.source === "trainee").map((f) => f.name));
      const keyed = new Set(read.flatMap((x) => x.names));
      const unkeyed = [...traineeNames].filter((n) => !keyed.has(n) && ![...keyed].some((k) => n.startsWith(k + "@") || n.startsWith(k + "~")));
      const pg = { file, status: card.status, action: card.action || null, message: card.message, lines: card.lines || [], blockers: card.blockers || [], unkeyed_trainee_fills: unkeyed,
        verdicts: graded.reduce((a, g) => ((a[g.verdict] = (a[g.verdict] || 0) + 1), a), {}) };
      report.pages.push(pg);
      if (card.status === "stopped" && /Sign in to/.test(card.message || "")) {
        // A sign-in step: the person signs in themselves; the next step fills itself.
        report.actions.push({ page: file, action: "sign-in", by: "the test person" });
        const before = url;
        await personSignsIn(page);
        if ((await waitSignedIn(page, before)) === "in-place") {
          const at = pages.map(pageName).indexOf(name);
          inPlace = at >= 0 && pages[at + 1] ? pages[at + 1] : null;
          if (!inPlace) throw Error(`${file}: signed in on the same page, and the key names no step after it`);
          await sleep(500);
        }
        continue;
      }
      if (card.action === "submit") {
        const want = submitAction?.should;
        report.actions.push({ page: file, action: "submit", should: want ?? null, card_offers_submit: card.status === "ready" || card.status === "blocked" });
        if (want === "fill" || want === "do") {
          await panel.waitForSelector("#approve:not([disabled])", { timeout: 15000 });
          await panel.click("#approve");
          await waitCard(sw, tabId, (c) => c.status === "done", 40000);
        }
        break;
      }
      // A draft step: the person answers what is theirs (from the key where it has the answer), then approves this page's
      // exact payload. Round 3: while the card still blocks, the person answers what it names: a required question still
      // open, a value the page set (changed to the key's answer, cleared, or kept as theirs).
      const keyRows = rows.map((r) => ({ ...r, selector: remapSelector(r.selector, map) }));
      pg.person_gave = []; // how each answer was given: from the key, generic, the TEST resume, cleared or kept
      const answered = await personAnswers(page, log, { rows: keyRows, gave: pg.person_gave });
      const ready = (c) => c.url === url && c.status === "ready";
      card = await waitCard(sw, tabId, ready, 5000);
      for (let k = 0; !card && k < 3; k++) {
        const c = await cardOf(sw, tabId);
        if (c?.url !== url || c.status !== "blocked") {
          card = await waitCard(sw, tabId, ready, 10000);
          continue;
        }
        const names = (c.payload?.fields || []).filter((f) => f.source === "page").map((f) => f.name);
        answered.push(...await personAnswers(page, log, { rows: keyRows, names, labels: c.openRequired || [], gave: pg.person_gave }));
        card = await waitCard(sw, tabId, ready, 6000);
      }
      if (!card) {
        const c = await cardOf(sw, tabId);
        report.errors.push(`${file}: the card never became ready: ${JSON.stringify(c?.blockers || c?.message || null).slice(0, 400)}`);
        break;
      }
      pg.person_answered = answered;
      const before = url;
      let moved = false;
      for (let k = 0; k < 2 && !moved; k++) {
        await panel.waitForSelector("#approve:not([disabled])", { timeout: 10000 });
        await panel.click("#approve");
        try {
          await page.waitForURL((u) => String(u) !== before, { timeout: 20000 });
          moved = true;
        } catch {
          // Workday refused the page (a required answer the page asks for and nobody marked): the person answers what the
          // key says is required, presses Fill again and approves the new card, once.
          const c = await cardOf(sw, tabId);
          if (k === 1) {
            report.errors.push(`${file}: Save and Continue did not move on: ${String(c?.message || "").slice(0, 300)}`);
            break;
          }
          log(`  ${file}: Workday did not save the page (${String(c?.message || "").slice(0, 160)}); the person answers what it needs and approves again`);
          const more = await personAnswers(page, log, { rows: keyRows, gave: pg.person_gave });
          answered.push(...more);
          await panel.click("#fill");
          if (!(await waitCard(sw, tabId, ready, 30000))) {
            const d = await cardOf(sw, tabId);
            report.errors.push(`${file}: Save and Continue did not move on, and the card was not ready again: ${JSON.stringify(d?.blockers || d?.message || null).slice(0, 300)}`);
            break;
          }
        }
      }
      if (!moved) break;
    }
    report.submitted = await page.evaluate(() => window.__submitted === true).catch(() => false);
    report.records = world.state.begins.length;
    // Ask once (round 2): what the extension sent Trainee to ask by text, step by step (labels only).
    report.questions_stored = world.state.putCalls.map((c) => (c.p_questions || []).map((q) => q.label));
    report.served = tenant.served.slice();
    report.drafts_kept = (await sw.evaluate(async () => (await chrome.storage.local.get("workday_drafts")).workday_drafts || [])).length;
  } catch (e) {
    report.errors.push(String(e && e.stack || e).slice(0, 2000));
  } finally {
    await browser?.close();
    await world.close();
  }
  return summarize(report);
}
function summarize(report) {
  const rows = report.rows;
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  const should = rows.filter((r) => r.should === "fill").length;
  const correct = n("fill-correct");
  const traineeCorrect = rows.filter((r) => r.verdict === "fill-correct" && !r.by_leaving).length;
  const traineeFilled = rows.filter((r) => r.source === "trainee").length;
  const nonEmptyShould = rows.filter((r) => r.should === "fill" && !wantsEmpty(r)).length;
  const traineeCorrectNonEmpty = rows.filter((r) => r.verdict === "fill-correct" && !r.by_leaving && !wantsEmpty(r)).length;
  report.counts = {
    should_fill: should, fill_correct: correct, fill_correct_by_leaving_empty: rows.filter((r) => r.by_leaving).length, fill_wrong: n("fill-wrong"), missed: n("missed"),
    page_set: n("page-set"), page_set_wrong: n("page-set-wrong"), asked_correctly: n("asked-correctly"), wrongly_filled_ask: n("wrongly-filled-ask"),
    never_ok: n("never-ok"), never_violations: n("never-violation"), trainee_filled: traineeFilled, trainee_correct: traineeCorrect,
  };
  report.coverage = should ? correct / should : 0;
  report.coverage_strict = nonEmptyShould ? traineeCorrectNonEmpty / nonEmptyShould : 0; // only rows with a value to fill, only Trainee's fills
  report.precision = traineeFilled ? traineeCorrect / traineeFilled : 1;
  report.wrong = n("fill-wrong") + n("wrongly-filled-ask");
  report.never_violations = n("never-violation");
  const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + "%";
  report.summary = `workday-fill ${report.tenant}: coverage ${pct(report.coverage)} (${correct}/${should}), strict ${pct(report.coverage_strict)} (${traineeCorrectNonEmpty}/${nonEmptyShould}), ` +
    `precision ${pct(report.precision)} (${traineeCorrect}/${traineeFilled}), wrong ${report.wrong}, never-violations ${report.never_violations}, ` +
    `submitted ${report.submitted ? "YES" : "no"}, records ${report.records}, errors ${report.errors.length} [${report.evidence}]`;
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : null);
  const tenant = opt("--tenant");
  if (!tenant) {
    console.error("usage: node evals/apply/workday-fill.cjs --tenant <dir> [--out file] [--persona file]");
    process.exit(2);
  }
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    console.error("NOT_RUN: openssl is needed for the TEST world's certificate");
    process.exit(2);
  }
  const report = await runTenant({ tenant, persona: opt("--persona") || undefined });
  const out = opt("--out");
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(report.summary);
  process.exit(report.errors.length ? 1 : 0);
}
module.exports = { runTenant, launch, openPanel, signIn, waitCard, cardOf, tabIdOf, matches, matchBy, grade, gradeAddRow, summarize, slug, personSignsIn, personAnswers,
  normalizeKey, rowGroups, wantsEmpty, personAnswerFor, waitSignedIn, PERSON_PASSWORD };
if (require.main === module) main();
