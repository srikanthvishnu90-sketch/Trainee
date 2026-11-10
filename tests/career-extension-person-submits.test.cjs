"use strict";
// Person-submits mode (first real submissions, plan v2; extension/config.js personSubmits, OFF by default): the extension
// fills, shows the card and runs every check up to the click, then presses nothing. The person reads the filled page and
// presses the site's own Submit; that press is checked against the approved card at the moment it happens.
//
// The real extension in a real Chromium, against the captured forms served by the local TEST world
// (tests/fixtures/extension/world.cjs): nothing reaches a real employer, Upmore or Supabase. A copy of extension/ with
// personSubmits switched on is loaded; the shipped config stays off (checked first, below).
//
//   node --test tests/career-extension-person-submits.test.cjs
// Needs Playwright and a Chromium, like tests/career-extension-browser.test.cjs (UPMORE_CHROMIUM_SANDBOX=off as root).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startWorld } = require("./fixtures/extension/world.cjs");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const RESUME = { name: "test-person-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% TEST resume, not a real person\n") };
const LEVER = "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d";
const ASHBY = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
const ASHBY_2 = "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c";

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
let world, ctx, sw, persona, extCopy;

// A copy of the extension with only personSubmits switched on.
function personSubmitsCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-person-"));
  fs.cpSync(EXT, dir, { recursive: true });
  const cfg = path.join(dir, "config.js");
  const src = fs.readFileSync(cfg, "utf8");
  const on = src.replace(/personSubmits:\s*false/, "personSubmits: true");
  if (on === src) throw Error("config.js has no personSubmits: false to switch");
  // D-MS-1 (x-audit, 2026-11-10): the shipped extension types nothing before the tap (prefill: false); this test drives the
  // fill engine, so its copy switches prefill on too.
  const filled = on.replace(/prefill:\s*false/, "prefill: true");
  if (filled === on) throw Error("config.js has no prefill: false to switch");
  fs.writeFileSync(cfg, filled);
  return dir;
}

const tabIdOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u || t.pendingUrl === u)?.id ?? null, url);
const cardOf = (id) => sw.evaluate(async (t) => ((await chrome.storage.session.get("cards")).cards || {})[t] || null, id);
async function waitCard(id, pred, ms = 20000) {
  const end = Date.now() + ms;
  let c = null;
  while (Date.now() < end) {
    c = await cardOf(id);
    if (c && pred(c)) return c;
    await sleep(100);
  }
  throw Error("card did not reach the state in time: " + JSON.stringify(c && { status: c.status, message: c.message }));
}
async function openPanel(tabId) {
  const url = `chrome-extension://${new URL(sw.url()).host}/panel.html` + (tabId === null ? "" : `?tab=${tabId}`);
  const waiting = ctx.waitForEvent("page", { predicate: (p) => p.url() === url, timeout: 10000 });
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", focused: false, width: 440, height: 900 }), url);
  const p = await waiting;
  await p.waitForLoadState("domcontentloaded");
  return p;
}
async function openForm(url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(150);
  const tabId = await tabIdOf(page.url());
  const panel = await openPanel(tabId);
  return { page, tabId, panel };
}
async function closeForm(f) {
  await f.panel.close().catch(() => {});
  await f.page.close().catch(() => {});
}
// The form as the extension reads it (its own reader, in the page), for the person's own answers to what is still open.
const formNow = (tabId) => sw.evaluate(async (t) => {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: t }, func: () => {
    const D = globalThis.TraineeCore.dom;
    const f = D.readForm();
    return f.schema.map((s) => ({ ...s, b: f.bindings[s.name], value: D.readValue(f.bindings[s.name]) }));
  } });
  return result;
}, tabId);
async function personAnswers(form) {
  const loc = (sel) => (/^upmore-idx-/.test(sel) ? form.page.locator("input,select,textarea").nth(Number(sel.slice(11))) : form.page.locator(sel).first());
  for (const f of await formNow(form.tabId)) {
    if (!f.required || f.value) continue;
    const b = f.b;
    if (b.widget) continue;
    if (b.inputType === "text") await loc(b.selector).fill("TEST answer typed by the person");
    else if (b.inputType === "select") {
      await loc(b.selector).focus();
      await form.page.keyboard.press("ArrowDown");
    } else if (b.inputType === "radio_group" || b.inputType === "checkbox_group") await loc(b.options[b.options.length - 1].selector).check();
    else if (b.inputType === "checkbox") await loc(b.selector).check();
  }
}
async function readyCard(form) {
  await form.panel.click("#fill");
  let card = await waitCard(form.tabId, (c) => ["ready", "blocked", "stopped"].includes(c.status) && (c.payload || c.status === "stopped"));
  if (card.status === "blocked") {
    await personAnswers(form);
    card = await waitCard(form.tabId, (c) => c.status === "ready" || c.status === "stopped", 10000);
  }
  return card;
}
// The site's own Submit, pressed by the person (Playwright's click is a trusted press).
const pressSubmit = (form) => form.page.getByRole("button", { name: /submit/i }).first().click();
const fresh = () => {
  world.state.jobs = [];
  world.state.submits = [];
  world.state.begins = [];
  world.state.finishes = [];
};
const submitsFor = (id) => world.state.submits.filter((s) => s.form === id);

before(async () => {
  if (blocked) return;
  try {
    persona = JSON.parse(execFileSync(process.env.DENO_BIN || "deno", ["run", "--allow-read", path.join(__dirname, "fixtures/extension/persona.ts")], { encoding: "utf8" }));
  } catch (e) {
    blocked = "DENO_UNAVAILABLE: " + String(e.message).split("\n")[0];
    return;
  }
  world = await startWorld();
  for (const [k, v] of Object.entries(persona)) world.answer("fact:" + k, "fact", v);
  extCopy = personSubmitsCopy();
  try {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-profile-"));
    ctx = await pw.chromium.launchPersistentContext(ud, {
      headless: true,
      ...(CHROME ? { executablePath: CHROME } : {}),
      ...(SANDBOX_OFF ? {} : { chromiumSandbox: true }),
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`, `--host-resolver-rules=${world.hostRules}`,
        "--ignore-certificate-errors", "--no-proxy-server", ...(SANDBOX_OFF ? ["--no-sandbox"] : [])],
    });
    sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  } catch (e) {
    blocked = "BROWSER_UNAVAILABLE: " + String(e.message).split("\n")[0];
    return;
  }
  const app = await ctx.newPage();
  await app.goto("https://upmore-topaz.vercel.app/");
  const panel = await openPanel(null);
  await panel.click("#use-app");
  await panel.waitForSelector("#page:not([hidden])", { timeout: 10000 });
  await panel.setInputFiles("#resume", RESUME);
  await panel.waitForFunction(() => document.getElementById("resume-name").textContent.includes(".pdf"));
  await panel.close();
  await app.close();
});
after(async () => {
  await ctx?.close().catch(() => {});
  await world?.close();
  if (extCopy) fs.rmSync(extCopy, { recursive: true, force: true });
});
const skip = (t) => {
  if (blocked) {
    if (process.env.CI === "true") assert.fail("CI cannot skip the person-submits suite: " + blocked);
    t.skip(blocked);
    return true;
  }
  return false;
};

test("person-submits: the shipped config is OFF (switching it on is the owner's call)", () => {
  assert.match(fs.readFileSync(path.join(EXT, "config.js"), "utf8"), /personSubmits:\s*false,/);
});

test("person-submits: after the tap Trainee presses nothing; the person's own press sends exactly once, confirmed", async (t) => {
  if (skip(t)) return;
  fresh();
  for (const id of [LEVER, ASHBY]) {
    const form = await openForm(world.urlOf(id));
    try {
      const card = await readyCard(form);
      assert.equal(card.status, "ready", card.message);
      await form.panel.click("#approve");
      const waiting = await waitCard(form.tabId, (c) => c.status === "awaiting_person");
      assert.match(waiting.message, /press the site's own Submit yourself\. Trainee will not press it/);
      await sleep(1500);
      assert.equal(submitsFor(id).length, 0, `${id}: Trainee pressed nothing`);
      assert.equal(world.state.begins.filter((b) => b.p_approval === card.hash).length, 1, "the start is recorded once, bound to the approved card");
      await pressSubmit(form);
      const done = await waitCard(form.tabId, (c) => c.status === "done", 20000);
      assert.equal(done.result, "confirmed", done.message);
      assert.equal(submitsFor(id).length, 1, `${id}: exactly one submission, the person's`);
      assert.equal(world.state.finishes.at(-1).p_state, "confirmed");
    } finally {
      await closeForm(form);
    }
  }
});

test("person-submits: a value changed after the tap stops the person's press; nothing is sent, the start is closed as not sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const form = await openForm(world.urlOf(ASHBY_2));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready", card.message);
    await form.panel.click("#approve");
    await waitCard(form.tabId, (c) => c.status === "awaiting_person");
    // A page script rewrites an answer the person approved, after the tap and before their press.
    await form.page.evaluate(() => {
      const el = document.querySelector("[name='_systemfield_email']");
      el.value = "planted@wrong.example.test";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pressSubmit(form);
    const stopped = await waitCard(form.tabId, (c) => c.status !== "awaiting_person" && c.status !== "submitting", 10000);
    assert.notEqual(stopped.status, "done");
    await sleep(1000);
    assert.equal(submitsFor(ASHBY_2).length, 0, "the changed application never went");
    assert.equal(world.state.finishes.at(-1)?.p_state, "not_submitted", "the start is closed as not sent");
  } finally {
    await closeForm(form);
  }
});

test("person-submits: leaving the page without pressing Submit sends nothing and closes the start as not sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const form = await openForm(world.urlOf(LEVER));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready", card.message);
    await form.panel.click("#approve");
    await waitCard(form.tabId, (c) => c.status === "awaiting_person");
    await form.page.goto(world.urlOf(ASHBY), { waitUntil: "domcontentloaded" });
    const end = Date.now() + 10000;
    while (Date.now() < end && !world.state.finishes.length) await sleep(150);
    assert.equal(submitsFor(LEVER).length, 0, "nothing was sent");
    assert.equal(world.state.finishes.at(-1)?.p_state, "not_submitted", "the start is closed as not sent");
  } finally {
    await closeForm(form);
  }
});
