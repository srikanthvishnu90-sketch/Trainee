"use strict";
// WO-101: the agent submits (extension/config.js agentSubmits, OFF by default; the owner's CAREER_AGENT_SUBMIT in the
// database). The person approves a batch up front, of every answer per posting exactly as it will be sent; Trainee then
// sends each posting itself with the site's own Submit only when the page holds exactly those answers; a posting that
// differs waits for the person and the batch goes on; "Stop applying" ends it; a receipt line after each.
//
// The real extension in a real Chromium, against the captured forms served by the local TEST world
// (tests/fixtures/extension/world.cjs): nothing reaches a real employer, Upmore or Supabase. A copy of extension/ with
// agentSubmits switched on is loaded; the shipped config stays off (checked first, below).
//
//   node --test tests/career-extension-agent-submits.test.cjs
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
// Lever and Ashby captures; Prepare decides which of them the TEST persona's confirmed facts answer whole.
const CANDIDATES = ["lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03",
  "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c", "lever-cgsfederal-0130d854-9bae-48d4-8ef0-e9da1ee778a5",
  "ashby-lilt-production-959498b8-a18e-457b-9e93-07662c38f3d3", "lever-veeva-9ac55b31-df46-4acb-b305-2c0b7ed56027"];

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
let world, ctx, sw, persona, extCopy, clone = 300;

// A copy of the extension with only agentSubmits switched on.
function agentCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-agent-"));
  fs.cpSync(EXT, dir, { recursive: true });
  const cfg = path.join(dir, "config.js");
  const src = fs.readFileSync(cfg, "utf8");
  const on = src.replace(/agentSubmits:\s*false/, "agentSubmits: true");
  if (on === src) throw Error("config.js has no agentSubmits: false to switch");
  // D-MS-1 (x-audit, 2026-11-10): the shipped extension types nothing before the tap (prefill: false); this test drives the
  // fill engine, so its copy switches prefill on too.
  const filled = on.replace(/prefill:\s*false/, "prefill: true");
  if (filled === on) throw Error("config.js has no prefill: false to switch");
  fs.writeFileSync(cfg, filled);
  return dir;
}
async function openPanel(tabId) {
  const url = `chrome-extension://${new URL(sw.url()).host}/panel.html` + (tabId === null ? "" : `?tab=${tabId}`);
  const waiting = ctx.waitForEvent("page", { predicate: (p) => p.url() === url, timeout: 10000 });
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", focused: false, width: 440, height: 900 }), url);
  const p = await waiting;
  await p.waitForLoadState("domcontentloaded");
  return p;
}
const tabIdOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u || t.pendingUrl === u)?.id ?? null, url);
const store = (area, key) => sw.evaluate(async ([a, k]) => (await chrome.storage[a].get(k))[k] ?? null, [area, key]);
async function waitFor(f, ms, what = "condition") {
  const end = Date.now() + ms;
  let v = null;
  while (Date.now() < end) {
    v = await f();
    if (v) return v;
    await sleep(150);
  }
  throw Error(`${what} not reached in time`);
}
const fresh = () => {
  world.state.jobs = [];
  world.state.submits = [];
  world.state.begins = [];
  world.state.finishes = [];
  world.state.batchApprovals = [];
  world.state.agentBegins = [];
  world.state.changed = {};
  world.state.agentSubmit = "off";
};
// A session: the queue's own tab and its panel, with these postings queued (each a distinct clone: its own company).
async function session(ids) {
  const urls = ids.map((id) => world.cloneUrl(id, clone++));
  const page = await ctx.newPage();
  await page.goto(`https://upmore-topaz.vercel.app/?agent=${clone}`);
  await sleep(100);
  const tabId = await tabIdOf(page.url());
  const panel = await openPanel(tabId);
  await panel.fill("#links", urls.join("\n"));
  await panel.click("#q-add");
  await panel.waitForFunction(() => /added\./.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 });
  return { page, tabId, panel, urls };
}
async function prepareOnce(s) {
  await sw.evaluate(() => chrome.storage.session.remove("agent_batch"));
  await s.panel.click("#q-prepare");
  return await waitFor(async () => {
    const x = await store("session", "agent_batch");
    return x && x.status === "ready" && x.ready.length + x.out.length === s.urls.length ? x : null;
  }, 90000, "the batch");
}
// WO-102: what the TEST person's facts do not support is asked in the panel first, never guessed. The TEST person answers
// each question there ("No" where the employer offers it), then Prepare reads the postings again.
async function prepare(s, log = false) {
  const first = await prepareOnce(s);
  const asked = (await s.panel.evaluate(() => chrome.runtime.sendMessage({ type: "status" }))).answerOnce;
  if (log) console.log(`asked first: ${asked.questions.length} questions (${asked.questions.map((q) => q.label.slice(0, 50)).join(" | ")}); ready before answering: ${first.ready.length}`);
  if (!asked.questions.length) return first;
  for (const q of asked.questions) {
    const el = s.panel.locator(`#ao-list li[data-key="${q.key}"] .ao-answer`);
    if (q.options.length) await el.selectOption(q.options.find((o) => /^no\b/i.test(o)) ?? q.options.at(-1));
    else await el.fill("TEST answer given in the panel");
  }
  await s.panel.click("#ao-save");
  await s.panel.waitForFunction(() => document.querySelectorAll("#ao-list li").length === 0, null, { timeout: 10000 });
  return await prepareOnce(s);
}
async function end(s) {
  await sw.evaluate(() => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
  await sw.evaluate(() => chrome.storage.session.remove(["agent_batch", "agent_approved", "answer_once", "cards", "pending"]));
  await s.panel.close().catch(() => {});
  await s.page.close().catch(() => {});
}
const queueNow = () => store("session", "queue");
const pathOf = (u) => new URL(u).pathname;
const submitsAt = (u) => world.state.submits.filter((x) => (x.path || "").toLowerCase() === pathOf(u).toLowerCase() || (x.host === new URL(u).host && (x.url || "").includes(pathOf(u))));

let ready = null; // the candidates the TEST persona's facts answer whole (from the first test)

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
  extCopy = agentCopy();
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
    if (process.env.CI === "true") assert.fail("CI cannot skip the agent-submits suite: " + blocked);
    t.skip(blocked);
    return true;
  }
  return false;
};

test("agent-submits: the shipped config is OFF (switching it on is the owner's call)", () => {
  assert.match(fs.readFileSync(path.join(EXT, "config.js"), "utf8"), /agentSubmits:\s*false,/);
});

test("A2: Prepare shows every answer per posting exactly as it will be sent; a posting with anything open is left out, with why; nothing is filled or sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const s = await session(CANDIDATES);
  try {
    const b = await prepare(s, true);
    console.log(`batch: ${b.ready.length} ready (${b.ready.map((e) => `${e.company}: ${e.posting.answers.length} answers`).join("; ")}); ` +
      `${b.out.length} left out (${b.out.map((o) => `${o.company || o.url}: ${o.why.slice(0, 2).join(" ")}`).join("; ")})`);
    for (const o of b.out) assert.ok(o.why.length && o.why.every((w) => typeof w === "string" && w.length > 10), JSON.stringify(o));
    for (const e of b.ready) {
      assert.match(e.hash, /^[0-9a-f]{64}$/);
      assert.ok(e.posting.answers.length > 0);
      for (const a of e.posting.answers) assert.ok(a.shown && a.label && a.factId, JSON.stringify(a));
    }
    assert.ok(b.ready.length >= 2, `at least two postings the TEST persona's facts answer whole: ${JSON.stringify(b.out)}`);
    assert.ok(b.out.some((o) => o.why.some((w) => /needs your answer first/.test(w))), "a posting with an open question is left out: asked, never guessed");
    ready = b.ready.map((e) => CANDIDATES[s.urls.indexOf(e.url)]).filter(Boolean);
    assert.equal(ready.length, b.ready.length);
    // The panel shows each ready posting with every answer, and the approve button; nothing was filled, sent or started.
    await s.panel.waitForFunction((n) => document.querySelectorAll("#agent-ready > li").length === n, b.ready.length, { timeout: 5000 });
    const shown = await s.panel.$$eval("#agent-ready > li", (lis) => lis.map((li) => li.querySelectorAll("ul > li").length));
    assert.deepEqual(shown, b.ready.map((e) => e.posting.answers.length), "every answer is on the panel");
    assert.equal(await s.panel.isVisible("#agent-approve"), true);
    assert.equal(world.state.submits.length, 0);
    assert.equal(world.state.begins.length + world.state.agentBegins.length, 0);
    assert.equal(world.state.batchApprovals.length, 0, "nothing approved without the tap");
  } finally {
    await end(s);
  }
});

test("A4 + A8: an approved batch is sent by the agent, one each, no tap per card; a posting changed after approval waits and the next still goes; a receipt per posting", async (t) => {
  if (skip(t)) return;
  assert.ok(ready && ready.length >= 2, "needs the ready postings from A2");
  fresh();
  world.state.agentSubmit = "on";
  // Three postings at three companies (each its own clone): the first and last of one form, the middle of the other, so
  // the one changed after the approval is a different form from the two that go.
  const ids = [ready[0], ready[1], ready[0]];
  const s = await session(ids);
  try {
    const b = await prepare(s);
    assert.equal(b.ready.length, 3, JSON.stringify(b.out));
    await s.panel.click("#agent-approve");
    await waitFor(async () => world.state.batchApprovals.length === 3, 5000, "the approval recorded");
    assert.deepEqual(world.state.batchApprovals.map((a) => a.batch_hash).sort(), b.ready.map((e) => e.hash).sort(), "bound to the hashes shown");
    // The second employer changes its form after the approval (a new field): that posting must wait for the person.
    const changed = s.urls[1];
    world.state.changed[ids[1]] = "freefield";
    const receiptsBefore = (await store("local", "agent_receipts") || []).length;
    await s.panel.click("#q-start");
    const q = await waitFor(async () => {
      const x = await queueNow();
      return x && !x.running && x.items.every((i) => !["waiting", "open"].includes(i.state)) ? x : null;
    }, 90000, "the queue to finish");
    assert.deepEqual(q.items.map((i) => i.state), ["confirmed", "needs_you", "confirmed"], JSON.stringify(q.items));
    assert.equal(world.state.agentBegins.length, 2, "two agent starts, both through the owner-switched start");
    assert.equal(world.state.begins.length, 2);
    assert.equal(world.state.submits.length, 2, "exactly two applications reached employers");
    assert.ok(world.state.batchApprovals.filter((a) => a.used).length === 2, "each used approval once");
    assert.ok(!world.state.submits.some((x) => JSON.stringify(x).includes("ref_free")), "the changed form never went");
    // The approved answers are what went: the recorded payload's Trainee answers are exactly the batch's.
    for (const j of world.state.jobs) {
      const e = b.ready.find((x) => x.posting.jobId === j.job_id);
      assert.ok(e, j.job_id);
      const sent = j.payload.fields.filter((f) => f.source === "trainee").map((f) => f.name).sort();
      assert.deepEqual(sent, e.posting.answers.map((a) => a.name).sort(), `${j.job_id}: the answers sent are the approved ones`);
      assert.ok(j.payload.fields.every((f) => f.source === "trainee"), `${j.job_id}: nothing else on the form`);
    }
    // A receipt line per posting: two sent (with the posting link), one not sent with what differed.
    const receipts = (await store("local", "agent_receipts")).slice(0, (await store("local", "agent_receipts")).length - receiptsBefore);
    assert.equal(receipts.length, 3, JSON.stringify(receipts));
    for (const u of [s.urls[0], s.urls[2]]) assert.ok(receipts.some((r) => r.url === u && /^Sent to /.test(r.line) && r.line.endsWith(u)), `${u}: ${JSON.stringify(receipts)}`);
    const notSent = receipts.find((r) => r.url === changed);
    assert.ok(notSent && /^Not sent to /.test(notSent.line) && /changed|differs/.test(notSent.line), JSON.stringify(notSent));
    await s.panel.waitForFunction(() => document.querySelectorAll("#agent-receipts li").length >= 3, null, { timeout: 5000 });
    console.log("receipts: " + receipts.map((r) => r.line).join(" | "));
  } finally {
    await end(s);
  }
});

test("A5: Stop applying stops the queue before the next submit; nothing more is sent, and the approvals are withdrawn", async (t) => {
  if (skip(t)) return;
  assert.ok(ready && ready.length >= 2);
  fresh();
  world.state.agentSubmit = "on";
  const s = await session([ready[0], ready[1], ready[0]]);
  try {
    const b = await prepare(s);
    assert.equal(b.ready.length, 3);
    await s.panel.click("#agent-approve");
    await waitFor(async () => world.state.batchApprovals.length === 3, 5000, "the approval recorded");
    await s.panel.click("#q-start");
    await waitFor(async () => world.state.submits.length >= 1, 30000, "the first submit");
    await s.panel.click("#agent-stop");
    await waitFor(async () => !(await queueNow()).running, 5000, "the queue stopped");
    const sentAtStop = world.state.submits.length;
    await sleep(6000);
    assert.equal(world.state.submits.length, sentAtStop, "nothing more is sent after Stop applying");
    assert.ok(sentAtStop <= 2, `at most the send already past its checks: ${sentAtStop}`);
    assert.equal(world.state.batchApprovals.filter((a) => !a.used && !a.revoked).length, 0, "every unused approval withdrawn on the account");
    assert.equal(await store("session", "agent_approved"), null, "and removed on this computer");
  } finally {
    await end(s);
  }
});

test("A6 in the browser: the owner's switch off refuses the agent's start; nothing is sent; the posting waits for the person", async (t) => {
  if (skip(t)) return;
  assert.ok(ready && ready.length >= 1);
  fresh(); // agentSubmit "off"
  const s = await session(ready.slice(0, 1));
  try {
    const b = await prepare(s);
    assert.equal(b.ready.length, 1);
    await s.panel.click("#agent-approve");
    await waitFor(async () => world.state.batchApprovals.length === 1, 5000, "the approval recorded");
    await s.panel.click("#q-start");
    const q = await waitFor(async () => {
      const x = await queueNow();
      return x && !x.running && x.items.every((i) => !["waiting", "open"].includes(i.state)) ? x : null;
    }, 60000, "the queue to finish");
    assert.deepEqual(q.items.map((i) => i.state), ["needs_you"]);
    assert.equal(world.state.agentBegins.length, 1, "the agent's start was asked once");
    assert.equal(world.state.begins.length, 0, "and refused before any application was recorded");
    assert.equal(world.state.submits.length, 0, "nothing was sent");
    const r = (await store("local", "agent_receipts"))[0];
    assert.match(r.line, /^Not sent to .*switched off/);
  } finally {
    await end(s);
  }
});

test("WO-102 rehearsal: the batch is filled and checked exactly as for a send, and nothing is approved on the account, started, clicked or sent; the report says how well every answer is supported", async (t) => {
  if (skip(t)) return;
  assert.ok(ready && ready.length >= 2);
  fresh();
  world.state.agentSubmit = "on"; // even with the owner's switch on, a rehearsal sends nothing
  // A contaminated facts file is loaded too: an invented fact (F-033) and a legacy fact without provenance never feed it.
  await sw.evaluate((uid) => chrome.storage.session.set({ imported_file: { user_id: uid, saved: {}, answers: {
    sponsorship: { value: "Yes", factId: "F-033", confirmed: true, user_id: uid, provenance: "owner stated in chat", confirmation_event_id: "evt-33" },
    linkedin: { value: "https://www.linkedin.com/in/someone-invented", factId: "F-010", confirmed: true, user_id: uid },
  } } }), world.userId);
  const s = await session([ready[0], ready[1]]);
  try {
    const b = await prepare(s);
    assert.equal(b.ready.length, 2, JSON.stringify(b.out));
    for (const e of b.ready) {
      assert.ok(!e.posting.ledger.some((l) => l.fact_refs.some((r) => r === "F-033" || r === "F-010")), "no quarantined or legacy fact behind any answer");
      assert.equal(e.posting.ledger.length, e.posting.answers.length, "a ledger row for every answer");
    }
    await s.panel.click("#agent-rehearse");
    const q = await waitFor(async () => {
      const x = await queueNow();
      return x && !x.running && x.items.every((i) => !["waiting", "open"].includes(i.state)) ? x : null;
    }, 90000, "the rehearsal to finish");
    assert.deepEqual(q.items.map((i) => i.state), ["rehearsed", "rehearsed"], JSON.stringify(q.items));
    assert.equal(world.state.submits.length, 0, "nothing reached an employer");
    assert.equal(world.state.begins.length + world.state.agentBegins.length, 0, "nothing was started");
    assert.equal(world.state.batchApprovals.length, 0, "nothing was approved on the account");
    const r = await store("local", "agent_rehearsals");
    assert.equal(r.length >= 2, true);
    for (const x of r.slice(0, 2)) {
      assert.equal(x.matched, true, JSON.stringify(x.diffs));
      assert.equal(x.supported_pct, 100);
      assert.equal(x.quarantined_dependencies, 0);
      assert.equal(x.unanswered_required, 0);
      assert.ok(x.ledger.length >= 5 && x.readback.length === x.ledger.length, "the final form readback, one per answer");
    }
    console.log("rehearsal: " + r.slice(0, 2).map((x) => `${x.company}: ${x.answers} answers, ${x.supported_pct}% supported, ${x.quarantined_dependencies} quarantined, ${x.unanswered_required} unanswered`).join("; "));
  } finally {
    await sw.evaluate(() => chrome.storage.session.remove(["imported_file"]));
    await end(s);
  }
});
