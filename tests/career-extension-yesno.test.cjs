"use strict";
// Ashby yes/no parity (wo/first-real-submission). Ashby renders a yes/no question as two buttons (data-option yes/no,
// aria-pressed) over a hidden checkbox; a "No" leaves the box unchecked, exactly like a question nobody answered, so the
// pressed button is the only place the page shows it. The extension's reader (extension/src/dom.ts, in the bundle
// extension/lib/trainee-core.js) must read a pressed "No" as "No" for Trainee's press and for the person's own, bind it
// into what the approval covers, and never undo a press already there.
//
// The bundle runs in a real Chromium page holding the Crusoe capture's first yes/no question (tests/fixtures/forms-ci).
// The capture's scripts are not served (as in the TEST world, tests/fixtures/extension/world.cjs), so a TEST stand-in
// plays Ashby's part where a test needs the page to answer a press: React-like, it renders the press a microtask later
// (aria-pressed on both buttons, a selected-state class, the box checked for a Yes) and keeps the box to its state.
// Then the same against the extension itself: the Crusoe form in the TEST world, the stand-in added to the page, the
// card. Nothing reaches a real employer, Upmore or Supabase.
//
//   UPMORE_CHROMIUM_SANDBOX=off node --test tests/career-extension-yesno.test.cjs
// Needs Playwright and a Chromium, like tests/career-extension-browser.test.cjs.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startWorld } = require("./fixtures/extension/world.cjs");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
// D-MS-1 (x-audit, 2026-11-10): the shipped extension types nothing before the tap (config.js prefill: false); this test
// drives the fill engine itself, so it loads a copy with prefill switched on.
const EXT_RUN = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-prefill-"));
  fs.cpSync(EXT, dir, { recursive: true });
  const cfg = path.join(dir, "config.js"), src = fs.readFileSync(cfg, "utf8"), on = src.replace(/prefill:\s*false/, "prefill: true");
  if (on === src) throw Error("config.js has no prefill: false to switch");
  fs.writeFileSync(cfg, on);
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return dir;
})();
const BUNDLE = path.join(EXT, "lib", "trainee-core.js");
const ASHBY = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
const RESUME = { name: "test-yesno-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% TEST resume, not a real person\n") };

let pw = null, blocked = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try {
    pw = require(id);
    break;
  } catch { /* next */ }
}
if (!pw) blocked = "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH; nothing was downloaded";
const CHROME = [process.env.UPMORE_EXTENSION_CHROMIUM_PATH, (() => {
  try {
    return pw && pw.chromium.executablePath();
  } catch {
    return null;
  }
})(), "/opt/pw-browsers/chromium", process.env.UPMORE_CHROMIUM_PATH].find((p) => p && fs.existsSync(p));
const SANDBOX_OFF = process.env.UPMORE_CHROMIUM_SANDBOX === "off";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Crusoe capture's first yes/no question, as Ashby rendered it.
const html = fs.readFileSync(path.join(ROOT, "tests/fixtures/forms-ci", ASHBY + ".html"), "utf8");
const ENTRY = html.match(/<div class="[^"]*ashby-application-form-field-entry"[^>]*>(?:(?!ashby-application-form-field-entry).)*?ashby-application-form-input-yesno"[\s\S]*?<\/div><\/div>/)[0];
const NAME = ENTRY.match(/<input type="checkbox"[^>]*name="([^"]+)"/)[1];
const B = { selector: `[name="${NAME}"]`, inputType: "checkbox" };

// TEST stand-in for Ashby's yes/no script (stripped from the capture). opts.aria: render aria-pressed (Ashby does);
// opts.toggle: a press on the pressed button clears the answer. Runs in the page.
function ashbyYesNo(opts) {
  const state = new WeakMap();
  const render = (box) => {
    const v = state.get(box) ?? null;
    for (const b of box.querySelectorAll("button[data-option]")) {
      const on = v !== null && b.getAttribute("data-option") === (v ? "yes" : "no");
      if (opts.aria) b.setAttribute("aria-pressed", String(on));
      else b.removeAttribute("aria-pressed");
      b.className = b.className.replace(/ _active_test_1/g, "") + (on ? " _active_test_1" : "");
    }
    box.querySelector("input[type=checkbox]").checked = v === true;
  };
  const boxes = () => document.querySelectorAll(".ashby-application-form-input-yesno");
  if (!opts.aria) boxes().forEach(render);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".ashby-application-form-input-yesno-option");
    if (!b) return;
    e.preventDefault();
    const box = b.closest(".ashby-application-form-input-yesno");
    const v = b.getAttribute("data-option") === "yes";
    state.set(box, opts.toggle && state.get(box) === v ? null : v);
    queueMicrotask(() => render(box));
  });
  // The hidden box is controlled: a click on it is put back to the state on the next render.
  document.addEventListener("change", (e) => {
    const box = e.target.closest && e.target.closest(".ashby-application-form-input-yesno");
    if (box && e.target.type === "checkbox") queueMicrotask(() => render(box));
  });
}
const STANDIN = (opts) => `(${ashbyYesNo.toString()})(${JSON.stringify(opts)});`;

let browser = null, ctx = null, sw = null, world = null, persona = null;
before(async () => {
  if (blocked) return;
  try {
    browser = await pw.chromium.launch({ headless: true, ...(CHROME ? { executablePath: CHROME } : {}), ...(SANDBOX_OFF ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }) });
  } catch (e) {
    blocked = "BROWSER_UNAVAILABLE: " + String(e.message).split("\n")[0];
  }
});
after(async () => {
  await browser?.close().catch(() => {});
  await ctx?.close().catch(() => {});
  await world?.close();
});
const skip = (t) => {
  if (blocked) {
    if (process.env.CI === "true") assert.fail("CI cannot skip the yes/no suite: " + blocked);
    t.skip(blocked);
    return true;
  }
  return false;
};

// A page holding the question and the bundle; `standin` is the TEST stand-in's options, or null for no page script.
async function question(standin) {
  const page = await browser.newPage();
  // Ashby's form is a container, not a <form> (none in any Ashby capture): a button press submits nothing by itself.
  await page.setContent(`<!doctype html><html><body><div class="ashby-application-form-container">${ENTRY}</div></body></html>`);
  if (standin) await page.addScriptTag({ content: STANDIN(standin) });
  await page.addScriptTag({ path: BUNDLE });
  return page;
}
const D = (page, fn, ...args) => page.evaluate(([fn, b, args]) => globalThis.TraineeCore.dom[fn](b, ...args), [fn, B, args]);
const fill = (page, v) => page.evaluate(([b, v]) => globalThis.TraineeCore.dom.fill(b, v, null), [B, v]);
const state = async (page) => ({
  value: await D(page, "readValue"),
  detail: await D(page, "readDetail"),
  checked: await page.evaluate((s) => document.querySelector(s).checked, B.selector),
});
const ASHBY_LIKE = { aria: true, toggle: false };

test("yes/no: Trainee's No on Ashby's page reads No, the box stays unchecked, and the approval binds the No", async (t) => {
  if (skip(t)) return;
  const page = await question(ASHBY_LIKE);
  try {
    assert.equal(await fill(page, "No"), true, "the page took the No");
    const s = await state(page);
    assert.equal(s.value, "No");
    assert.equal(s.checked, false, "Ashby leaves the box unchecked for a No");
    assert.match(s.detail, /;pressed=no$/, "the approval binds the No");
  } finally {
    await page.close();
  }
});

test("yes/no: Trainee's Yes on Ashby's page reads Yes, the box checked by the page, bound as a Yes", async (t) => {
  if (skip(t)) return;
  const page = await question(ASHBY_LIKE);
  try {
    assert.equal(await fill(page, "Yes"), true);
    const s = await state(page);
    assert.deepEqual([s.value, s.checked], ["Yes", true]);
    assert.match(s.detail, /^checked=true;.*;pressed=yes$/);
  } finally {
    await page.close();
  }
});

test("yes/no: the person's own press of No (a trusted click) reads No and is bound; it is a yes/no press", async (t) => {
  if (skip(t)) return;
  const page = await question(ASHBY_LIKE);
  try {
    assert.equal(await D(page, "readValue"), "", "nobody answered yet");
    const before = await D(page, "readDetail");
    await page.locator('button[data-option="no"]').click();
    const s = await state(page);
    assert.equal(s.value, "No");
    assert.match(s.detail, /;pressed=no$/);
    assert.notEqual(s.detail, before, "a No is not the open question's approval");
    assert.equal(await page.evaluate(() => globalThis.TraineeCore.dom.yesNoPress(document.querySelector('button[data-option="no"]'))), true);
  } finally {
    await page.close();
  }
});

test("yes/no: a page that shows the press only by its selected-state class reads the person's No", async (t) => {
  if (skip(t)) return;
  const page = await question({ aria: false, toggle: false });
  try {
    await page.locator('button[data-option="no"]').click();
    const s = await state(page);
    assert.equal(s.value, "No");
    assert.match(s.detail, /;pressed=no$/);
  } finally {
    await page.close();
  }
});

test("yes/no: Trainee's No over the person's Yes changes it to No", async (t) => {
  if (skip(t)) return;
  const page = await question(ASHBY_LIKE);
  try {
    await page.locator('button[data-option="yes"]').click();
    assert.equal(await D(page, "readValue"), "Yes");
    assert.equal(await fill(page, "No"), true);
    const s = await state(page);
    assert.deepEqual([s.value, s.checked], ["No", false]);
  } finally {
    await page.close();
  }
});

test("yes/no: a No already pressed is not pressed again (on a page where a second press clears it)", async (t) => {
  if (skip(t)) return;
  const page = await question({ aria: true, toggle: true });
  try {
    await page.locator('button[data-option="no"]').click();
    assert.equal(await D(page, "readValue"), "No");
    assert.equal(await fill(page, "No"), true);
    assert.equal(await D(page, "readValue"), "No", "the No is still there");
  } finally {
    await page.close();
  }
});

test("yes/no: with no page script (the TEST world's stripped capture) the box is the answer, as before", async (t) => {
  if (skip(t)) return;
  const page = await question(null);
  try {
    assert.equal(await fill(page, "No"), true, "an unchecked box is what a No leaves");
    let s = await state(page);
    assert.deepEqual([s.value, s.checked], ["", false], "nothing on the page shows a No: content.js keeps its own record");
    assert.match(s.detail, /;pressed=none$/);
    assert.equal(await fill(page, "Yes"), true);
    s = await state(page);
    assert.deepEqual([s.value, s.checked], ["Yes (checked)", true]);
  } finally {
    await page.close();
  }
});

// The extension itself, on the Crusoe form in the TEST world, with the stand-in playing Ashby's part on the page.
async function extension() {
  persona = JSON.parse(execFileSync(process.env.DENO_BIN || "deno", ["run", "--allow-read", path.join(__dirname, "fixtures/extension/persona.ts")], { encoding: "utf8" }));
  world = await startWorld();
  for (const [k, v] of Object.entries(persona)) world.answer("fact:" + k, "fact", v);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-yesno-"));
  ctx = await pw.chromium.launchPersistentContext(ud, {
    headless: true,
    ...(CHROME ? { executablePath: CHROME } : {}),
    ...(SANDBOX_OFF ? {} : { chromiumSandbox: true }),
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT_RUN}`, `--load-extension=${EXT_RUN}`, `--host-resolver-rules=${world.hostRules}`,
      "--ignore-certificate-errors", "--no-proxy-server", ...(SANDBOX_OFF ? ["--no-sandbox"] : [])],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const app = await ctx.newPage();
  await app.goto("https://upmore-topaz.vercel.app/");
  const panel = await openPanel(null);
  await panel.click("#use-app");
  await panel.waitForSelector("#page:not([hidden])", { timeout: 10000 });
  await panel.setInputFiles("#resume", RESUME);
  await panel.waitForFunction(() => document.getElementById("resume-name").textContent.includes(".pdf"));
  await panel.close();
  await app.close();
}
async function openPanel(tabId) {
  const url = `chrome-extension://${new URL(sw.url()).host}/panel.html` + (tabId === null ? "" : `?tab=${tabId}`);
  const waiting = ctx.waitForEvent("page", { predicate: (p) => p.url() === url, timeout: 10000 });
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", focused: false, width: 440, height: 900 }), url);
  const p = await waiting;
  await p.waitForLoadState("domcontentloaded");
  return p;
}
const cardOf = (id) => sw.evaluate(async (t) => ((await chrome.storage.session.get("cards")).cards || {})[t] || null, id);
async function waitCard(id, pred, ms = 25000) {
  const end = Date.now() + ms;
  let c = null;
  while (Date.now() < end) {
    c = await cardOf(id);
    if (c && pred(c)) return c;
    await sleep(100);
  }
  throw Error("card did not reach the state in time: " + JSON.stringify(c && { status: c.status, message: c.message }));
}

test("yes/no, extension: Trainee's No on Crusoe's sponsorship question is the page's No on the card, bound, not open", async (t) => {
  if (skip(t)) return;
  try {
    await extension();
  } catch (e) {
    if (process.env.CI === "true") throw e;
    t.skip("EXTENSION_UNAVAILABLE: " + String(e.message).split("\n")[0]);
    return;
  }
  const page = await ctx.newPage();
  await page.addInitScript({ content: `window.addEventListener("DOMContentLoaded", function () { ${STANDIN(ASHBY_LIKE)} });` });
  await page.goto(world.urlOf(ASHBY), { waitUntil: "domcontentloaded" });
  await sleep(150);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u || x.pendingUrl === u)?.id ?? null, page.url());
  const panel = await openPanel(tabId);
  try {
    await panel.click("#fill");
    const card = await waitCard(tabId, (c) => ["ready", "blocked", "stopped"].includes(c.status) && (c.payload || c.status === "stopped"));
    assert.notEqual(card.status, "stopped", card.message);
    const sponsor = (card.payload?.fields || []).find((f) => /sponsorship/i.test(f.label));
    assert.ok(sponsor, "the sponsorship question is on the card");
    assert.equal(sponsor.value, "No", "the page's own No, not a remembered one");
    assert.equal(sponsor.source, "trainee");
    assert.match(sponsor.detail, /;pressed=no$/, "the approval binds the No");
    assert.ok(!(card.openRequired || []).some((l) => /sponsorship/i.test(l)), "the question is answered, not open");
    assert.equal(await page.locator('button[data-option="no"]').first().getAttribute("aria-pressed"), "true", "the page shows the No pressed");
  } finally {
    await panel.close().catch(() => {});
    await page.close().catch(() => {});
  }
});
