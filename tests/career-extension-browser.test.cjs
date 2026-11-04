"use strict";
// WO-031: the browser extension, loaded unpacked into a real Chromium, against the captured application forms
// (tests/fixtures/forms-ci) served at their real URLs by a local TEST world (tests/fixtures/extension/world.cjs). Chromium
// resolves only the world's hosts (MAP * ~NOTFOUND): nothing reaches a real employer, Upmore or Supabase.
//
//   node --test tests/career-extension-browser.test.cjs
// Needs Playwright and a Chromium (UPMORE_PLAYWRIGHT_PATH, UPMORE_CHROMIUM_PATH; /opt/pw-browsers/chromium is used when
// present). Chromium refuses its sandbox as root: run as a normal user, or set UPMORE_CHROMIUM_SANDBOX=off on a
// throwaway machine. Without Playwright or a Chromium the suite skips and says why.
//
// Field accuracy: each form is filled from the complete TEST persona (tests/fixtures/extension/persona.ts), given to the
// extension the way a real person's answers arrive (career_apply_answers_own rows, "fact:<name>"). What the card says
// Trainee filled is compared with tests/fixtures/extension/answer-key.json. Precision = filled correctly / filled;
// coverage = filled correctly / fields the key says should be filled. Reported per family, dev and held-out separately,
// and written to EXTENSION_ACCURACY_OUT when set.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startWorld } = require("./fixtures/extension/world.cjs");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const KEY = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/extension/answer-key.json"), "utf8"));
const RESUME = { name: "test-person-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% TEST resume for WO-031, not a real person\n") };

let pw = null, blocked = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!id) continue;
  try {
    pw = require(id);
    break;
  } catch { /* next */ }
}
if (!pw) blocked = "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH; nothing was downloaded";
// An unpacked extension loads only in Chromium (branded Google Chrome 137+ ignores --load-extension): the extension's
// own Chromium if named, else Playwright's, else this machine's, else the gate's browser.
const CHROME = [process.env.UPMORE_EXTENSION_CHROMIUM_PATH, (() => {
  try {
    return pw && pw.chromium.executablePath();
  } catch {
    return null;
  }
})(), "/opt/pw-browsers/chromium", process.env.UPMORE_CHROMIUM_PATH].find((p) => p && fs.existsSync(p));
const SANDBOX_OFF = process.env.UPMORE_CHROMIUM_SANDBOX === "off";

let world, ctx, sw, persona;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "trainee-ext-profile-"));
  const c = await pw.chromium.launchPersistentContext(ud, {
    headless: true,
    ...(CHROME ? { executablePath: CHROME } : {}),
    ...(SANDBOX_OFF ? {} : { chromiumSandbox: true }),
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${world.hostRules}`,
      "--ignore-certificate-errors", "--no-proxy-server", ...(SANDBOX_OFF ? ["--no-sandbox"] : []),
    ],
  });
  let w = c.serviceWorkers()[0];
  if (!w) {
    try {
      w = await c.waitForEvent("serviceworker", { timeout: 15000 });
    } catch {
      await c.close();
      throw Error(`EXTENSION_NOT_LOADED: ${CHROME || "the default browser"} did not load the unpacked extension (set UPMORE_EXTENSION_CHROMIUM_PATH to a Chromium)`);
    }
  }
  return { c, w, ud };
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
  const trail = await sw.evaluate(async (t) => ((await chrome.storage.session.get("card_trail")).card_trail || []).filter((x) => x.tabId === t).map((x) => x.by), id);
  throw Error("card did not reach the state in time: " + JSON.stringify(c && { status: c.status, message: c.message, url: c.url, blockers: c.blockers }) + " trail=" + trail.join(">"));
}
// Every "by" a tab's card went through (the background's own trail of card changes).
const trailOf = (id) => sw.evaluate(async (t) => ((await chrome.storage.session.get("card_trail")).card_trail || []).filter((x) => x.tabId === t), id);
async function openPanel(tabId) {
  const url = `chrome-extension://${new URL(sw.url()).host}/panel.html` + (tabId === null ? "" : `?tab=${tabId}`);
  const waiting = ctx.waitForEvent("page", { predicate: (p) => p.url() === url, timeout: 10000 });
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", focused: false, width: 440, height: 900 }), url);
  const p = await waiting;
  await p.waitForLoadState("domcontentloaded");
  return p;
}
// A posting in its own tab with the panel beside it (its own window, so the form stays the visible tab).
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
async function fill(f) {
  await f.panel.click("#fill");
  return await waitCard(f.tabId, (c) => ["ready", "blocked", "stopped"].includes(c.status) && (c.payload || c.status === "stopped"));
}
const traineeFields = (card) => (card.payload?.fields || []).filter((x) => x.source === "trainee");

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
  try {
    ({ c: ctx, w: sw } = await launch());
  } catch (e) {
    blocked = "BROWSER_UNAVAILABLE: " + String(e.message).split("\n")[0];
    return;
  }
  // The person signs in the way they already are: the Upmore app's own session, picked up from its tab.
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
});
// Locally a missing browser skips with the reason; in CI it fails, so the gate can never pass without running these.
const skip = (t) => {
  if (blocked) {
    if (process.env.CI === "true") assert.fail("CI cannot skip the extension suite: " + blocked);
    t.skip(blocked);
    return true;
  }
  return false;
};

// ------------------------------------------------------------------------------------------------ sign-in
test("auth: the session lives only in chrome.storage.session, no token in local storage, no password anywhere", async (t) => {
  if (skip(t)) return;
  const s = await sw.evaluate(async () => ({ session: await chrome.storage.session.get(null), local: await chrome.storage.local.get(null) }));
  assert.equal(s.session.auth.user_id, world.userId);
  assert.ok(s.session.auth.access_token && s.session.auth.refresh_token);
  assert.ok(!JSON.stringify(s.local).includes(s.session.auth.access_token), "no token in chrome.storage.local");
  assert.ok(!JSON.stringify(s.local).includes(s.session.auth.refresh_token), "no refresh token in chrome.storage.local");
  assert.ok(!/password/i.test(JSON.stringify(s)), "no password anywhere the extension keeps");
  assert.equal(JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).manifest_version, 3);
});

test("auth: a service-role key in the app tab is refused; the person's own session is taken", async (t) => {
  if (skip(t)) return;
  const kept = await sw.evaluate(async () => (await chrome.storage.session.get("auth")).auth);
  world.state.serviceKeySession = true;
  const app = await ctx.newPage();
  await app.goto("https://upmore-topaz.vercel.app/?service=1");
  const panel = await openPanel(null);
  try {
    await sw.evaluate(() => chrome.storage.session.remove("auth"));
    const r = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "signin-app" }));
    assert.equal(r.ok, false);
    assert.equal(await sw.evaluate(async () => (await chrome.storage.session.get("auth")).auth ?? null), null, "a service-role token is never kept");
  } finally {
    world.state.serviceKeySession = false;
    await app.goto("https://upmore-topaz.vercel.app/?person=1");
    const r = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "signin-app" }));
    assert.equal(r.ok, true);
    assert.equal((await sw.evaluate(async () => (await chrome.storage.session.get("auth")).auth)).user_id, kept.user_id);
    await panel.close();
    await app.close();
  }
});

test("auth: a sign-in link is asked for by email (no account created, no password, no code typed anywhere)", async (t) => {
  if (skip(t)) return;
  const panel = await openPanel(null);
  const out = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "signin-magic", email: "test.person@example.test" }));
  assert.equal(out.ok, true);
  assert.match(out.message, /Open the link/);
  const sent = world.state.otp.at(-1);
  assert.deepEqual(sent, { email: "test.person@example.test", redirect_to: "https://upmore-topaz.vercel.app", create_user: false });
  await panel.close();
});

// ------------------------------------------------------------------------------------------------ field accuracy
// The answer key's grading, shared with the 60-in-30 benchmark (evals/apply/sixty-in-thirty.cjs).
const { norm, same, emptyish, expectedValue: expectedFrom } = require("./fixtures/extension/grade.cjs");
const expectedValue = (spec, field, isWidget) => expectedFrom(spec, field, isWidget, persona, RESUME.name);

const results = [];
for (const f of (KEY.forms ? Object.keys(KEY.forms) : [])) {
  test(`accuracy: ${f}`, async (t) => {
    if (skip(t)) return;
    const form = await openForm(world.urlOf(f));
    try {
      const card = await fill(form);
      assert.notEqual(card.status, "stopped", card.message);
      const schema = await form.page.evaluate(() => globalThis.__traineeSchema || null).catch(() => null);
      void schema;
      const key = KEY.forms[f];
      const fieldsNow = await sw.evaluate(async (id) => {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
          const f = globalThis.TraineeCore.dom.readForm();
          return f.schema.map((s) => ({ ...s, widget: f.bindings[s.name].widget }));
        } });
        return result;
      }, form.tabId);
      const names = fieldsNow.map((x) => x.name);
      for (const n of names) assert.ok(Object.hasOwn(key, n), `the answer key covers ${n} on ${f}`);
      const byName = Object.fromEntries((card.payload?.fields || []).map((x) => [x.name, x]));
      const rows = [];
      for (const fld of fieldsNow) {
        const spec = key[fld.name];
        const want = expectedValue(spec, fld, !!fld.widget);
        const got = byName[fld.name];
        const filled = !!got && got.source === "trainee" && !emptyish(got.value);
        const chose = !!got && got.source === "trainee" && norm(got.value) === "no (left unchecked)";
        let verdict;
        if (want === "any") verdict = "any";
        else if (want === null) verdict = filled ? "wrong_filled" : "empty_ok";
        else if (filled || chose) verdict = same(got.value, want) ? "correct" : "wrong_value";
        else verdict = "missed";
        rows.push({ name: fld.name, label: fld.label.slice(0, 120), type: fld.type, widget: !!fld.widget, want, got: got ? got.value : null, verdict });
      }
      results.push({ form: f, family: f.split("-")[0], heldout: KEY.split.heldout.includes(f), rows, status: card.status });
      // Never an EEO answer the person did not give, never an identity number: the persona gave none.
      for (const x of traineeFields(card)) assert.ok(!/\b(gender|race|ethnicity|veteran|disability|hispanic)\b/i.test(x.label) || /sponsor|authori/i.test(x.label), `no EEO answer filled: ${x.label}`);
    } finally {
      await closeForm(form);
    }
  });
}

test("accuracy: report (precision and coverage per family; dev and held-out)", async (t) => {
  if (skip(t)) return;
  assert.ok(results.length >= 17, "every captured form was run");
  const agg = (rows) => {
    const filled = rows.filter((r) => ["correct", "wrong_value", "wrong_filled"].includes(r.verdict)).length;
    const correct = rows.filter((r) => r.verdict === "correct").length;
    const should = rows.filter((r) => r.want !== null && r.want !== "any").length;
    return { filled, correct, should, precision: filled ? correct / filled : 1, coverage: should ? correct / should : 1 };
  };
  const report = { measured_at: new Date().toISOString(), families: {} };
  for (const fam of ["greenhouse", "lever", "ashby"]) {
    const rs = results.filter((r) => r.family === fam);
    const all = rs.flatMap((r) => r.rows), dev = rs.filter((r) => !r.heldout).flatMap((r) => r.rows), held = rs.filter((r) => r.heldout).flatMap((r) => r.rows);
    const noWidget = all.filter((r) => !r.widget);
    report.families[fam] = {
      forms: rs.length, all: agg(all), dev: agg(dev), heldout: agg(held), excluding_widgets: agg(noWidget),
      misses: all.filter((r) => r.verdict === "missed").map((r) => ({ label: r.label, type: r.type, widget: r.widget, want: r.want })),
      wrong: all.filter((r) => r.verdict.startsWith("wrong")).map((r) => ({ label: r.label, type: r.type, want: r.want, got: r.got, verdict: r.verdict })),
    };
  }
  const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + "%";
  for (const [fam, r] of Object.entries(report.families)) {
    console.log(`${fam}: precision ${pct(r.all.precision)} (${r.all.correct}/${r.all.filled}), coverage ${pct(r.all.coverage)} (${r.all.correct}/${r.all.should}); held-out precision ${pct(r.heldout.precision)}, coverage ${pct(r.heldout.coverage)}; without react-select widgets coverage ${pct(r.excluding_widgets.coverage)}`);
  }
  if (process.env.EXTENSION_ACCURACY_OUT) fs.writeFileSync(process.env.EXTENSION_ACCURACY_OUT, JSON.stringify({ report, results }, null, 1));
  // Regression floors at what was measured (WO-042 Run 2, docs/architect/work-orders/WO-042-sixty-in-thirty.md): a
  // reader or planner change that loses ground fails here. Precision is held at 100%: one wrong answer fails the suite.
  // Every wrong fill is listed in the report and shown on the card, where the person reads it before the one tap.
  // WO-052: lever 0.96 -> 0.95. Two Lever answers the key had as fills are the person's (an agreement beyond the
  // standing privacy consent; a pay box with its own format), so 73/76 became 71/74 with the same three misses.
  // WO-102 (the second judge's submission-quality contract, 2026-10-21): answers that are an inference or an
  // attestation are asked, not filled. Precision stays 1 in every family; coverage drops by exactly these 11 fields,
  // measured against the previous build on the same captures: "End date year" twice (a date fact reformatted), "What's
  // your citizenship / employment eligibility?" (an option mapped from another wording), Lyra, Crusoe, Snowflake and
  // PwC "have you worked here" (inferred from the employer list), "native Basque translator" (inferred), and the
  // Snowflake privacy notice, Crusoe's text-message consent and Airwallex's AI statement (attestations: his own answer).
  const FLOOR = { greenhouse: [1, 0.94], lever: [1, 0.9], ashby: [1, 0.8] };
  for (const [fam, r] of Object.entries(report.families)) {
    assert.ok(r.all.precision >= FLOOR[fam][0], `${fam} precision ${r.all.precision} fell below ${FLOOR[fam][0]}: ${JSON.stringify(r.wrong)}`);
    assert.ok(r.excluding_widgets.coverage >= FLOOR[fam][1], `${fam} coverage ${r.excluding_widgets.coverage} fell below ${FLOOR[fam][1]}`);
  }
});

// ------------------------------------------------------------------------------------------------ the submit
// The form as the extension reads it now: each field, its binding and its current value.
const formNow = (tabId) => sw.evaluate(async (id) => {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
    const D = globalThis.TraineeCore.dom, f = D.readForm();
    return f.schema.map((s) => ({ ...s, b: f.bindings[s.name], value: D.readValue(f.bindings[s.name]) }));
  } });
  return result;
}, tabId);
// The person answers what is still open, on the page, with real input (trusted events): what a person does by hand.
// skip: fields the person leaves for later (WO-049: the written question Trainee drafts on the card).
async function personAnswers(form, values = {}, skip = new Set()) {
  const loc = (sel) => (/^upmore-idx-/.test(sel) ? form.page.locator("input,select,textarea").nth(Number(sel.slice(11))) : form.page.locator(sel).first());
  for (const f of await formNow(form.tabId)) {
    if (!f.required || f.value || skip.has(f.name)) continue;
    const b = f.b;
    if (b.widget) continue;
    if (b.inputType === "text") await loc(b.selector).fill(values[f.name] ?? "TEST answer typed by the person");
    // A person picks with the keyboard (Playwright's selectOption is a script setting the value, not a person).
    else if (b.inputType === "select") {
      await loc(b.selector).focus();
      await form.page.keyboard.press("ArrowDown");
    }
    else if (b.inputType === "radio_group" || b.inputType === "checkbox_group") await loc(b.options[b.options.length - 1].selector).check();
    else if (b.inputType === "checkbox") await loc(b.selector).check();
  }
}
async function readyCard(form) {
  let card = await fill(form);
  if (card.status === "blocked") card = await answeredByText(form, card);
  if (card.status === "blocked") {
    await personAnswers(form);
    card = await waitCard(form.tabId, (c) => c.status === "ready" || c.status === "stopped", 10000);
  }
  return card;
}
// WO-102: a required choice Trainee may not infer (has the person worked here, a yes or no the page cannot show a "No"
// for) is answered by the TEST person by text ("No" where offered), under the key the extension asks it by
// (TraineeCore.questionsForTrainee), as the ask-once path does; then the form is read again and Trainee fills the
// person's own answer. Typed fields stay the person's to type (personAnswers).
async function answeredByText(form, card) {
  const now = await formNow(form.tabId);
  const yesNo = (f) => f.b.inputType === "checkbox" || (f.options || []).some((o) => /^no\b/i.test(String(o.label)));
  const needs = now.filter((f) => f.required && !f.value && !f.b.widget && yesNo(f))
    .map((f) => ({ label: f.label, type: f.type || "input_text", options: (f.options || []).map((o) => String(o.label)) }));
  if (!needs.length) return card;
  const rows = await sw.evaluate((o) => globalThis.TraineeCore.questionsForTrainee({ ...o, answers: {}, answered: new Set() }).questions, { jobId: card.jobId, company: card.company, needs });
  if (!rows.length) return card;
  for (const q of rows) world.answer(q.key, q.kind, (q.options || []).find((o) => /^no\b/i.test(o)) ?? "No");
  const at = Date.now();
  await form.panel.click("#fill");
  return await waitCard(form.tabId, (c) => c.updated_at > at && ["ready", "blocked", "stopped"].includes(c.status) && (c.payload || c.status === "stopped"), 20000);
}
const fresh = () => {
  world.state.jobs = [];
  world.state.submits = [];
  world.state.begins = [];
  world.state.finishes = [];
};
const submitsFor = (id) => world.state.submits.filter((s) => s.form === id);

test("submit: nothing goes before the person's own tap; the tap sends exactly the reviewed answers once, recorded and evidenced", async (t) => {
  if (skip(t)) return;
  fresh();
  for (const id of ["lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"]) {
    const form = await openForm(world.urlOf(id));
    try {
      const card = await readyCard(form);
      assert.equal(card.status, "ready", card.message);
      const shape = Object.fromEntries((await formNow(form.tabId)).map((f) => [f.name, f.b]));
      await sleep(1500);
      assert.equal(submitsFor(id).length, 0, "nothing is sent while the card waits");
      // A click a script makes is not the person's tap.
      await form.panel.evaluate(() => document.getElementById("approve").click());
      await sleep(800);
      assert.equal(submitsFor(id).length, 0, "an untrusted click approves nothing");
      assert.equal(world.state.begins.filter((b) => b.p_payload.url === world.urlOf(id)).length, 0, "nothing recorded before the tap");
      await form.panel.click("#approve");
      const done = await waitCard(form.tabId, (c) => c.status === "done", 20000);
      assert.equal(done.result, "confirmed", done.message);
      const sent = submitsFor(id);
      assert.equal(sent.length, 1, "exactly one submission");
      // Exactly what the card showed: every typed answer as it was reviewed, the resume by name and bytes.
      for (const fld of card.payload.fields) {
        const b = shape[fld.name];
        if (b.inputType === "file") {
          assert.equal(sent[0].files[fld.name]?.name, RESUME.name, "the resume, by name");
          assert.equal(sent[0].files[fld.name]?.sha256, require("node:crypto").createHash("sha256").update(RESUME.buffer).digest("hex"), "and by its bytes");
          continue;
        }
        if (fld.value === "No (left unchecked)") {
          assert.equal(sent[0].fields[fld.name], undefined, `${fld.label}: left unchecked, so not sent`);
          continue;
        }
        const got = sent[0].fields[fld.name];
        assert.ok(got !== undefined, `${fld.label} reached the employer`);
        if (b.inputType === "text") assert.equal(got, fld.value, `${fld.label} exactly as reviewed`);
        // A radio's own value (a page that gives none sends "on", the browser's default, for the checked one).
        if (b.inputType === "radio_group" && got !== "on") assert.equal(got, b.options.find((o) => o.label === fld.value)?.value, `${fld.label} as reviewed`);
      }
      assert.equal(world.state.begins.at(-1).p_approval, card.hash, "the record is bound to the approved hash");
      const fin = world.state.finishes.at(-1);
      assert.equal(fin.p_state, "confirmed");
      assert.ok(fin.p_evidence.answers.length >= card.payload.fields.length - 1);
      assert.match(fin.p_evidence.screenshot_sha256, /^[0-9a-f]{64}$/);
      assert.match(fin.p_evidence.confirmation_text, /Thank you for applying/);
      assert.ok(fin.p_evidence.ms_card_to_done > 0);
      const local = await sw.evaluate(async () => (await chrome.storage.local.get("evidence")).evidence[0]);
      assert.equal(local.job_id, card.payload.job_id);
      assert.match(local.screenshot, /^data:image\/png;base64,/);
      assert.equal(local.state, "confirmed");
    } finally {
      await closeForm(form);
    }
  }
});

test("submit: the same posting twice is refused by the record, so nothing is sent again", async (t) => {
  if (skip(t)) return;
  const id = "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d";
  const before = submitsFor(id).length;
  assert.ok(world.state.jobs.some((j) => j.job_id.includes("35bffe8b")), "the earlier application is on record");
  const form = await openForm(world.urlOf(id));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready");
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped").catch(async (e) => {
      const p = await form.panel.evaluate(() => ({ status: document.getElementById("status").textContent, disabled: document.getElementById("approve").disabled, hash: document.getElementById("approve").dataset.hash }));
      const c = await cardOf(form.tabId);
      const trail = await sw.evaluate(async (id) => ((await chrome.storage.session.get("card_trail")).card_trail || []).filter((x) => x.tabId === id), form.tabId);
      throw Error(e.message + " panel=" + JSON.stringify(p) + " card.hash=" + c?.hash + " begins=" + world.state.begins.length + " trail=" + JSON.stringify(trail));
    });
    assert.match(stopped.message, /already in your applications/);
    await sleep(500);
    assert.equal(submitsFor(id).length, before, "nothing sent");
  } finally {
    await closeForm(form);
  }
});

test("zero wrong answers: a value changed after review blocks the submit; nothing is recorded or sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c";
  const form = await openForm(world.urlOf(id));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready", card.message);
    // A page script rewrites an answer the person already reviewed (no trusted event: the card does not move).
    await form.page.evaluate(() => {
      const el = document.querySelector("[name='_systemfield_email']");
      el.value = "planted@wrong.example.test";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped" || c.status === "done" || c.status === "blocked");
    assert.notEqual(stopped.status, "done");
    assert.match(String(stopped.message), /changed after you reviewed|set by the page|Not ready/);
    await sleep(800);
    assert.equal(submitsFor(id).length, 0, "the changed application never went");
    assert.equal(world.state.begins.length, 0, "and was never recorded as started");
  } finally {
    await closeForm(form);
  }
});

test("zero wrong answers: a value the page set itself (nobody gave it) blocks the tap", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "lever-tsmg-9e43a7f6-3476-482f-9cdd-ed5b73fb9df7";
  const form = await openForm(world.urlOf(id, "prefill"));
  try {
    await fill(form);
    await personAnswers(form);
    const card = await waitCard(form.tabId, (c) => c.status === "blocked" && c.payload?.fields.some((x) => x.source === "page"), 10000);
    assert.ok(card.lines.some((l) => /set by the page/.test(l)));
    assert.equal(await form.panel.isDisabled("#approve"), true, "the tap is not offered");
    const r = await form.panel.evaluate((h) => chrome.runtime.sendMessage({ type: "approve", tabId: Number(new URLSearchParams(location.search).get("tab")), hash: h }), card.hash);
    assert.equal(r.ok, false, "an approval of a blocked card is refused");
    await sleep(800);
    assert.equal(submitsFor(id).length, 0);
  } finally {
    await closeForm(form);
  }
});

test("a value the page drops while it hydrates is set again after the rest (live run 12, Anduril's First Name)", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "lever-tsmg-9e43a7f6-3476-482f-9cdd-ed5b73fb9df7";
  const form = await openForm(world.urlOf(id, "hydrate"));
  try {
    const card = await fill(form);
    const name = card.payload?.fields.find((x) => x.name === "name");
    assert.equal(name?.value, "Test Person", "the name the page dropped was set again, and is on the card");
    assert.equal((await formNow(form.tabId)).find((f) => f.name === "name")?.value, name.value, "and the page holds it");
  } finally {
    await closeForm(form);
  }
});

test("ask once, from the form: what the person typed on an approved card fills the same question at another company; a stop keeps nothing", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "lever-weloglobal-6e0ac589-3fba-429a-8ce4-5c48a2cf0e2d";
  const before = (world.state.formAnswerCalls || []).length, answersBefore = world.state.answers.length;
  // A stop before the click keeps nothing.
  let form = await openForm(world.cloneUrl(id, 901));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready");
    // The person's own edit while the approved application is being recorded stops it before the click.
    world.state.beginDelayMs = 700;
    await form.panel.click("#approve");
    await sleep(250);
    await form.page.fill("[name='email']", "changed.by.me@example.test");
    await waitCard(form.tabId, (c) => c.status === "stopped");
    await sleep(500);
    assert.equal(submitsFor(id).length, 0, "nothing sent");
    assert.equal((world.state.formAnswerCalls || []).length, before, "nothing kept when nothing was sent");
  } finally {
    world.state.beginDelayMs = 0;
    await closeForm(form);
  }
  // Sent: the person's own answers go to the questions this posting raised.
  form = await openForm(world.cloneUrl(id, 902));
  let typed;
  try {
    const card = await readyCard(form);
    typed = card.payload.fields.filter((f) => f.source === "you");
    assert.ok(typed.length >= 1, "the person typed at least one answer on this form");
    await form.panel.click("#approve");
    await waitCard(form.tabId, (c) => c.status === "done");
    const call = world.state.formAnswerCalls.at(-1);
    assert.equal(world.state.formAnswerCalls.length, before + 1, "kept once, after the send");
    assert.ok(call.p_answers.length >= 1 && call.p_answers.every((a) => typed.some((f) => f.value.trim() === a.answer)), "only the person's own answers");
    assert.ok(world.state.answers.length > answersBefore, "they read back as answers");
  } finally {
    await closeForm(form);
  }
  // The same form at another company: the questions answered once are filled from those answers, not asked again.
  form = await openForm(world.cloneUrl(id, 903));
  try {
    const card = await fill(form);
    const kept = world.state.formAnswerCalls.at(-1).p_answers;
    const reused = card.payload.fields.filter((f) => f.source === "trainee" && /^text-answer:/.test(f.factId || ""));
    const travels = kept.filter((a) => !a.key.startsWith("job:"));
    assert.ok(travels.length >= 1, "at least one answer travels beyond its posting");
    for (const a of travels) assert.ok(reused.some((f) => f.label.replace(/\s+/g, " ").trim() === a.label && f.value.trim() === a.answer), "filled again: " + a.label);
  } finally {
    await closeForm(form);
  }
});

test("verification: a challenge on the page stops before anything is filled and hands off to the person", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "lever-veeva-9ac55b31-df46-4acb-b305-2c0b7ed56027";
  const form = await openForm(world.urlOf(id, "captcha"));
  try {
    const card = await fill(form);
    assert.equal(card.status, "stopped");
    assert.match(card.message, /verification check.*yourself.*never answers one/i);
    assert.equal((await formNow(form.tabId)).filter((f) => f.value).length, 0, "nothing was filled");
  } finally {
    await closeForm(form);
  }
  // A challenge that appears after the review: the tap stops, nothing is sent.
  const id2 = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  const f2 = await openForm(world.urlOf(id2));
  try {
    const card = await readyCard(f2);
    assert.equal(card.status, "ready");
    await f2.page.evaluate(() => {
      const fr = document.createElement("iframe");
      fr.src = "https://www.google.com/recaptcha/api2/bframe?k=TEST";
      fr.style.cssText = "display:block;width:320px;height:200px";
      document.body.appendChild(fr);
    });
    await f2.panel.click("#approve");
    const stopped = await waitCard(f2.tabId, (c) => c.status === "stopped");
    assert.match(stopped.message, /verification check/);
    await sleep(800);
    assert.equal(submitsFor(id2).length, 0);
    assert.equal(world.state.begins.length, 0);
  } finally {
    await closeForm(f2);
  }
});

test("identity numbers: never filled, typed by the person, masked in the screenshot, never in any record", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  const form = await openForm(world.urlOf(id, "ssn"));
  try {
    await form.page.evaluate(() => {
      window.__masks = 0;
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.getAttribute?.("data-trainee-mask") && window.__masks++)))
        .observe(document.documentElement, { childList: true });
    });
    const card = await fill(form);
    assert.equal(await form.page.inputValue("#ssn_test"), "", "Trainee never fills it");
    assert.ok(card.lines.some((l) => /Type this yourself on the form: Social Security Number/.test(l)));
    await form.page.fill("#ssn_test", "123-45-6789");
    const ready = await waitCard(form.tabId, (c) => c.status === "ready", 10000);
    const ssnField = ready.payload.fields.find((f) => f.name === "ssn_test");
    assert.equal(ssnField.source, "you");
    assert.ok(!JSON.stringify(ready).includes("123-45-6789"), "the card never carries the number");
    await form.panel.click("#approve");
    await waitCard(form.tabId, (c) => c.status === "done", 20000);
    assert.ok((await form.page.evaluate(() => window.__masks).catch(() => 1)) >= 1, "the field was covered for the screenshot");
    const everything = JSON.stringify({ b: world.state.begins, f: world.state.finishes, local: await sw.evaluate(async () => (await chrome.storage.local.get("evidence")).evidence.map((e) => ({ ...e, screenshot: null }))) });
    assert.ok(!everything.includes("123-45-6789"), "no identity number in the record or the local evidence");
    assert.equal(submitsFor(id)[0].fields.ssn_test, "123-45-6789", "the person's own answer went to the employer as they typed it");
  } finally {
    await closeForm(form);
  }
});

test("ask once: a required question nobody answered is stored once; answered once by text, it fills the next form", async (t) => {
  if (skip(t)) return;
  fresh();
  const saved = world.state.answers;
  world.state.answers = saved.filter((a) => a.key !== "fact:sponsorship");
  // A new browser session: nothing has been stored from this browser yet.
  await sw.evaluate(() => chrome.storage.session.remove("asked"));
  const calls = world.state.putCalls.length;
  try {
    const id = "lever-veeva-9ac55b31-df46-4acb-b305-2c0b7ed56027";
    let form = await openForm(world.urlOf(id));
    let card = await fill(form);
    assert.ok(card.openRequired.some((l) => /sponsorship/i.test(l)));
    await waitFor(() => world.state.putCalls.length > calls);
    const put = world.state.putCalls.at(-1);
    assert.ok(put.p_questions.some((q) => q.key === "fact:sponsorship"), JSON.stringify(put.p_questions.map((q) => q.key)));
    await closeForm(form);
    // The same posting again in this session: not stored twice.
    form = await openForm(world.urlOf(id) + "?again=1");
    await fill(form);
    await sleep(500);
    assert.equal(world.state.putCalls.length, calls + 1, "asked once");
    await closeForm(form);
    // The person answers Trainee by text; the next form with the same question fills from it.
    world.answer("fact:sponsorship", "fact", "No");
    const id2 = "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d";
    form = await openForm(world.urlOf(id2));
    card = await fill(form);
    const spons = card.payload.fields.find((f) => /sponsorship/i.test(f.label));
    assert.equal(spons.value, "No");
    assert.equal(spons.source, "trainee");
    assert.match(spons.factId, /^text-answer:/);
    await closeForm(form);
  } finally {
    world.state.answers = saved;
  }
});

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(50);
  }
  throw Error("timed out");
}

// WO-066: what the person asked Trainee to apply to in chat reaches the extension's queue with one press, through their own
// session; each is then prepared here and goes only on its card's tap (the queue tests above). Taken once, never twice.
test("queue: Trainee's picks from chat join the queue once, and are marked taken", async (t) => {
  if (skip(t)) return;
  fresh();
  const ids = ["lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"];
  const key = (u) => sw.evaluate((x) => globalThis.TraineeCore.postingKey(x), u);
  world.state.wanted = [];
  for (const id of ids) world.state.wanted.push({ posting_key: await key(world.urlOf(id)), url: world.urlOf(id), company: "TEST", title: "TEST", state: "waiting" });
  const page = await ctx.newPage();
  await page.goto("https://upmore-topaz.vercel.app/?picks=1");
  await sleep(100);
  const panel = await openPanel(await tabIdOf(page.url()));
  try {
    await sw.evaluate(async () => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
    await panel.click("#q-picks");
    await panel.waitForFunction(() => /added\./.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 });
    const q = await sw.evaluate(async () => (await chrome.storage.session.get("queue")).queue);
    assert.deepEqual(q.items.map((x) => x.url), ids.map((id) => world.urlOf(id)), "both picks, in the order queued");
    assert.ok(world.state.wanted.every((w) => w.state === "taken"), "marked taken");
    await panel.click("#q-picks");
    await panel.waitForFunction(() => /no postings waiting/.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 });
    const q2 = await sw.evaluate(async () => (await chrome.storage.session.get("queue")).queue);
    assert.equal(q2.items.length, ids.length, "taken picks never join twice");
  } finally {
    await panel.close();
    await page.close();
    await sw.evaluate(async () => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
  }
});

test("queue: postings open one after another, each fills and waits for its tap; time from card to confirmed is measured", async (t) => {
  if (skip(t)) return;
  fresh();
  const ids = ["lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03",
    "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c", "lever-cgsfederal-0130d854-9bae-48d4-8ef0-e9da1ee778a5",
    "ashby-lilt-production-959498b8-a18e-457b-9e93-07662c38f3d3"];
  const page = await ctx.newPage();
  await page.goto("https://upmore-topaz.vercel.app/?queue=1");
  await sleep(100);
  const tabId = await tabIdOf(page.url());
  assert.equal(typeof tabId, "number");
  const panel = await openPanel(tabId);
  const times = [];
  try {
    await panel.fill("#links", ids.map((id) => world.urlOf(id)).join("\n") + "\nhttps://www.linkedin.com/jobs/view/123 (never queued)");
    await panel.click("#q-add");
    // A click resolves when it is dispatched, before the panel's handler has the background store the queue: wait for the
    // panel's own "N postings added." before reading the store (WO-059: the read raced the write on slow runners).
    await panel.waitForFunction(() => /added\./.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 });
    const q = await sw.evaluate(async () => (await chrome.storage.session.get("queue")).queue);
    assert.equal(q.items.length, ids.length, "only Greenhouse, Lever and Ashby postings are queued");
    const wall = Date.now();
    await panel.click("#q-start");
    for (const id of ids) {
      const url = world.urlOf(id);
      await waitFor(() => page.url() === url, 15000);
      const form = { page, tabId, panel };
      let card = await waitCard(tabId, (c) => c.url === url && ["ready", "blocked"].includes(c.status), 20000);
      if (card.status === "blocked") {
        await personAnswers(form);
        card = await waitCard(tabId, (c) => c.url === url && c.status === "ready", 10000);
      }
      await panel.click("#approve");
      const done = await waitCard(tabId, (c) => c.url === url && c.status === "done", 20000);
      assert.equal(done.result, "confirmed", `${id}: ${done.message}`);
      times.push(done.ms);
    }
    const queue = await sw.evaluate(async () => (await chrome.storage.session.get("queue")).queue);
    assert.deepEqual(queue.items.map((x) => x.state), ids.map(() => "confirmed"), JSON.stringify(queue));
    assert.equal(world.state.submits.length, ids.length, "one submission per approved posting");
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`queue: ${ids.length} applications, card shown to employer confirmed: ${times.map((x) => (x / 1000).toFixed(2) + "s").join(", ")}; average ${(avg / 1000).toFixed(2)}s; wall clock including the TEST person's typing ${((Date.now() - wall) / 1000).toFixed(1)}s`);
    if (process.env.EXTENSION_ACCURACY_OUT) {
      const out = JSON.parse(fs.readFileSync(process.env.EXTENSION_ACCURACY_OUT, "utf8"));
      out.queue = { n: ids.length, ms_card_to_confirmed: times, avg_ms: avg, wall_ms: Date.now() - wall };
      fs.writeFileSync(process.env.EXTENSION_ACCURACY_OUT, JSON.stringify(out, null, 1));
    }
    assert.ok(times.every((x) => x < 10000), "each under 10 seconds from card to confirmed");
  } finally {
    await sw.evaluate(() => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
    await panel.close();
    await page.close();
  }
});

test("Workday: recognized, said plainly, only the basic contact fields filled; never claimed", async (t) => {
  if (skip(t)) return;
  const url = "https://acme.wd1.myworkdayjobs.com/en-US/External/job/Chicago/Analyst_R123/apply";
  const form = await openForm(url);
  try {
    const card = await fill(form);
    assert.ok(card.lines.includes("Workday needs you signed in on the employer's site; I fill the fields I can."));
    const mine = traineeFields(card).map((f) => f.name).sort();
    assert.deepEqual(mine, ["email", "legalName--firstName", "legalName--lastName", "phoneNumber"]);
    assert.ok(card.openRequired.some((l) => /authorized/i.test(l)) && card.openRequired.some((l) => /sponsorship/i.test(l)), "the rest is the person's, on the employer's site");
  } finally {
    await closeForm(form);
  }
});

// ------------------------------------------------------------------------------------------------ WO-031 review round
const { LABELS_URL } = require("./fixtures/extension/world.cjs");
const evidenceLocal = () => sw.evaluate(async () => (await chrome.storage.local.get("evidence")).evidence || []);
const inPage = (tabId, func, args = []) => sw.evaluate(async ({ id, src, args }) => {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id }, args, func: new Function("return (" + src + ")")() });
  return result;
}, { id: tabId, src: func.toString(), args });

test("review 1: a page script that rewrites an answer between the record and the click is caught next to the click; nothing sent; the posting can be tried again", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  world.state.beginDelayMs = 450;
  let form = await openForm(world.urlOf(id, "ssn,race"));
  try {
    await fill(form);
    await form.page.fill("#ssn_test", "123-45-6789");
    await waitCard(form.tabId, (c) => c.status === "ready", 10000);
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped");
    assert.match(stopped.message, /changed after you reviewed it/);
    await sleep(500);
    assert.equal(submitsFor(id).length, 0, "the employer never got the planted address");
    assert.equal(world.state.begins.length, 1, "the application was recorded before the last look");
    const fin = world.state.finishes.at(-1);
    assert.equal(fin.p_state, "not_submitted");
    assert.equal(fin.p_evidence.reason, "stopped before the click", "finished as stopped before the click");
  } finally {
    world.state.beginDelayMs = 0;
    await closeForm(form);
  }
  // Stopped before the click: the same posting can be approved again, and goes once.
  form = await openForm(world.urlOf(id));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready");
    await form.panel.click("#approve");
    const done = await waitCard(form.tabId, (c) => c.status === "done");
    assert.equal(done.result, "confirmed");
    assert.equal(submitsFor(id).length, 1);
  } finally {
    await closeForm(form);
  }
});

test("review 1: the person's own edit while the approved application is being recorded stops it; nothing sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  world.state.beginDelayMs = 700;
  const form = await openForm(world.urlOf(id));
  try {
    const card = await readyCard(form);
    assert.equal(card.status, "ready");
    await form.panel.click("#approve");
    await sleep(250);
    await form.page.fill("[name='_systemfield_email']", "changed.by.me@example.test");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped");
    // The edit itself stops it (not only the comparison next to the click): the person's own change is never ignored.
    assert.match(stopped.message, /^You changed the form after approving/);
    await sleep(800);
    assert.equal(submitsFor(id).length, 0);
  } finally {
    world.state.beginDelayMs = 0;
    await closeForm(form);
  }
});

test("review 8: filling again never writes over what the person typed", async (t) => {
  if (skip(t)) return;
  const form = await openForm(world.urlOf("ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"));
  try {
    await fill(form);
    await form.page.fill("[name='_systemfield_email']", "my.other.address@example.test");
    await form.panel.click("#fill");
    const card = await waitCard(form.tabId, (c) => c.payload?.fields.some((f) => f.name === "_systemfield_email" && f.source === "you"), 10000);
    assert.equal(card.payload.fields.find((f) => f.name === "_systemfield_email").value, "my.other.address@example.test");
    assert.equal(await form.page.inputValue("[name='_systemfield_email']"), "my.other.address@example.test");
  } finally {
    await closeForm(form);
  }
});

test("review 8: Trainee's own clicks on radios and boxes are not the person's edits: one card per Fill", async (t) => {
  if (skip(t)) return;
  const form = await openForm(world.urlOf("ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"));
  try {
    const t0 = Date.now();
    const card = await fill(form);
    assert.ok(traineeFields(card).some((f) => /^checked=/.test(f.detail || "")), "Trainee clicked at least one radio or box");
    await sleep(1200); // a refresh caused by those clicks would land here
    const cards = (await trailOf(form.tabId)).filter((x) => x.at >= t0 && x.by === "card");
    assert.equal(cards.length, 1, "one card for one Fill: " + JSON.stringify(cards));
  } finally {
    await closeForm(form);
  }
});

test("review 2: a notice already on the page is not the employer's answer; the same posting never goes twice", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-lilt-production-959498b8-a18e-457b-9e93-07662c38f3d3";
  for (let round = 1; round <= 2; round++) {
    const form = await openForm(world.urlOf(id, "banner,slowthanks"));
    try {
      const card = await readyCard(form);
      assert.equal(card.status, "ready", card.message);
      await form.panel.click("#approve");
      const end = await waitCard(form.tabId, (c) => c.status === "done" || c.status === "stopped", 40000);
      if (round === 1) assert.equal(end.result, "confirmed", end.message);
      else assert.match(end.message, /already in your applications/);
    } finally {
      await closeForm(form);
    }
  }
  assert.equal(submitsFor(id).length, 1, "one submission, whatever the page showed");
});

test("review 2: a click the employer answered with an error is never sent again", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c";
  let form = await openForm(world.urlOf(id, "rejects"));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    const end = await waitCard(form.tabId, (c) => c.status === "done", 45000);
    assert.equal(end.result, "failed", end.message);
    assert.equal(world.state.finishes.at(-1).p_state, "failed");
  } finally {
    await closeForm(form);
  }
  form = await openForm(world.urlOf(id));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    const again = await waitCard(form.tabId, (c) => c.status === "stopped");
    assert.match(again.message, /already in your applications/);
  } finally {
    await closeForm(form);
  }
  assert.equal(submitsFor(id).length, 1, "the employer got it once");
});

test("review 2: an employer that never answers: unknown, counted as applied, never sent again", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c";
  let form = await openForm(world.urlOf(id, "silent"));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    const end = await waitCard(form.tabId, (c) => c.status === "done", 45000);
    assert.equal(end.result, "unknown_outcome");
    assert.match(end.message, /could not be captured/);
    assert.equal(world.state.finishes.at(-1).p_state, "unknown_outcome");
  } finally {
    await closeForm(form);
  }
  form = await openForm(world.urlOf(id));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    const again = await waitCard(form.tabId, (c) => c.status === "stopped");
    assert.match(again.message, /already in your applications/);
  } finally {
    await closeForm(form);
  }
  assert.equal(submitsFor(id).length, 1);
});

test("review 3: a label that belongs to another field never answers this one; two fields under one label are the person's", async (t) => {
  if (skip(t)) return;
  const form = await openForm(LABELS_URL);
  try {
    const card = await fill(form);
    const mine = Object.fromEntries(traineeFields(card).map((f) => [f.name, f.value]));
    assert.equal(mine.phone, persona.phone, "the person's phone in the person's field");
    assert.equal(mine.spons, "No");
    assert.equal(mine.ref_phone, undefined, "never the referrer's");
    assert.equal(mine.auth, undefined, "the authorization radios are never answered from the sponsorship label");
    assert.equal(mine.email1, undefined);
    assert.equal(mine.email2, undefined);
    assert.equal(await form.page.inputValue("[name='ref_phone']"), "");
    assert.equal(await form.page.isChecked("input[name='auth'][value='no']"), false);
    assert.ok(card.lines.some((l) => /^Still needed: Email\. Two fields on this form share that label/.test(l)));
  } finally {
    await closeForm(form);
  }
});

test("review 4: other countries' identity numbers and long digit strings never leave the page", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  const form = await openForm(world.urlOf(id, "sin,freefield"));
  try {
    await form.page.evaluate(() => {
      window.__masks = 0;
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.getAttribute?.("data-trainee-mask") && window.__masks++)))
        .observe(document.documentElement, { childList: true });
    });
    const card = await fill(form);
    assert.equal(await form.page.inputValue("#sin_test"), "");
    assert.ok(card.lines.some((l) => /Type this yourself on the form: SIN/.test(l)));
    await form.page.fill("#sin_test", "046 454 286");
    await form.page.fill("#ref_free", "My badge 1234567890123");
    const ready = await waitCard(form.tabId, (c) => c.status === "ready", 10000);
    assert.ok(!JSON.stringify(ready).includes("046 454 286") && !JSON.stringify(ready).includes("1234567890123"));
    await form.panel.click("#approve");
    await waitCard(form.tabId, (c) => c.status === "done");
    assert.ok((await form.page.evaluate(() => window.__masks).catch(() => 2)) >= 2, "both covered for the screenshot");
    const all = JSON.stringify({ b: world.state.begins, f: world.state.finishes, local: (await evidenceLocal()).map((e) => ({ ...e, screenshot: null, screenshot_after: null })) });
    assert.ok(!all.includes("046 454 286") && !all.includes("046454286") && !all.includes("1234567890123"), "not in the record, the begin payload or the local proof");
  } finally {
    await closeForm(form);
  }
});

test("review 5: the approval covers what is sent: other file bytes under the same name, or another option value, stop it", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  let form = await openForm(world.urlOf(id));
  try {
    assert.equal((await readyCard(form)).status, "ready");
    await form.page.evaluate((name) => {
      const el = document.querySelector("input[type=file][name='_systemfield_resume'], input[type=file][id='_systemfield_resume']") || document.querySelector("input[type=file]");
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.4 PLANTED other bytes"], name, { type: "application/pdf" }));
      el.files = dt.files;
    }, RESUME.name);
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped");
    assert.match(stopped.message, /changed after you reviewed it/);
    assert.equal(submitsFor(id).length, 0);
  } finally {
    await closeForm(form);
  }
  const id2 = "lever-tsmg-9e43a7f6-3476-482f-9cdd-ed5b73fb9df7";
  form = await openForm(world.urlOf(id2));
  try {
    assert.equal((await readyCard(form)).status, "ready");
    // The visible text stays "I agree"; what the browser would send changes.
    await form.page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll("select")).find((s) => s.options[s.selectedIndex]?.textContent.trim() === "I agree");
      sel.options[sel.selectedIndex].value = "PLANTED-value";
    });
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => c.status === "stopped");
    assert.match(stopped.message, /changed after you reviewed it/);
    assert.equal(submitsFor(id2).length, 0);
  } finally {
    await closeForm(form);
  }
});

test("review 9: a read-only field the page set is shown on the card and bound to the approval", async (t) => {
  if (skip(t)) return;
  const form = await openForm(world.urlOf("ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03", "readonly"));
  try {
    const card = await readyCard(form);
    assert.ok(card.lines.includes("Posting reference: TEST-REF-42 (set by the employer's page, read-only)"), card.lines.join("\n"));
    assert.ok(card.payload.fields.some((f) => f.source === "fixed" && f.value === "TEST-REF-42"));
  } finally {
    await closeForm(form);
  }
});

test("review 9: two reports of the same application finish it once", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c";
  const form = await openForm(world.urlOf(id, "silent"));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    await waitFor(() => submitsFor(id).length === 1, 10000);
    const before = world.state.rpcCalls.filter((x) => x === "career_apply_finish_own").length;
    // The page after a navigating submit and the content script can both report; here two reports arrive together.
    const obs = { url_before: "https://x", url_after: "https://x", form_present_after: false, required_empty_after: 0, validation_errors: [], captcha: false,
      email_code_prompt: false, page_text: "Thank you for applying. Reference TEST-2" };
    await inPage(form.tabId, (o) => Promise.all([chrome.runtime.sendMessage({ type: "outcome", observation: o }), chrome.runtime.sendMessage({ type: "outcome", observation: o })]), [obs]);
    const done = await waitCard(form.tabId, (c) => c.status === "done");
    await sleep(1500);
    assert.equal(world.state.rpcCalls.filter((x) => x === "career_apply_finish_own").length - before, 1, "one finish call");
    assert.equal(world.state.finishes.length, 1);
    assert.notEqual(done.recorded, false);
    assert.equal((await evidenceLocal()).filter((e) => e.id === world.state.finishes[0].p_id).length, 1, "one proof kept");
  } finally {
    await closeForm(form);
  }
});

test("review 6 and 7: a content script cannot approve, set the resume, sign out or run the queue, nor send the session elsewhere", async (t) => {
  if (skip(t)) return;
  const form = await openForm(world.urlOf("ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"));
  try {
    await fill(form);
    const resumeBefore = await sw.evaluate(async () => (await chrome.storage.local.get("resume")).resume.sha256);
    for (const m of [{ type: "approve", tabId: form.tabId, hash: "x" }, { type: "set-resume", name: "evil.pdf", base64: "UExBTlRFRA==" }, { type: "signout" },
      { type: "queue-start" }, { type: "proof", id: "x" }, { type: "clear-proof", confirm: "clear" }]) {
      const r = await inPage(form.tabId, (msg) => chrome.runtime.sendMessage(msg), [m]);
      assert.equal(r.ok, false, m.type);
      assert.match(r.message, /Only the Trainee panel/, m.type);
    }
    assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get("resume")).resume.sha256), resumeBefore);
    assert.ok(await sw.evaluate(async () => !!(await chrome.storage.session.get("auth")).auth), "still signed in");
    // A content script can write chrome.storage.local; the server the token goes to is fixed by config.js.
    await inPage(form.tabId, () => chrome.storage.local.set({ config: { supabaseUrl: "https://evil.example.test", anonKey: "x", appUrl: "https://evil.example.test" } }));
    const calls = world.state.rpcCalls.length;
    await form.panel.click("#fill");
    await waitFor(() => world.state.rpcCalls.length > calls, 10000).catch(() => {});
    assert.ok(world.state.rpcCalls.length > calls, "the session's calls still reach the Upmore project");
  } finally {
    await sw.evaluate(() => chrome.storage.local.remove("config"));
    await closeForm(form);
  }
});

test("proof: Lever (navigates) and Ashby (in place): two screenshots, both hashes recorded, the employer's words quoted, a Proof view; the card never says 'nothing was sent'", async (t) => {
  if (skip(t)) return;
  fresh();
  for (const id of ["lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"]) {
    const form = await openForm(world.urlOf(id));
    try {
      await readyCard(form);
      await form.panel.click("#approve");
      const done = await waitCard(form.tabId, (c) => c.status === "done");
      assert.equal(done.result, "confirmed");
      assert.match(done.message, /^Sent; the employer's page confirmed it/);
      await sleep(1200); // a late "page closed" would land here
      const trail = await trailOf(form.tabId);
      const after = trail.slice(trail.findIndex((x) => x.by === "approve"));
      assert.ok(!after.some((x) => x.status === "stopped"), "never 'stopped' after the tap: " + JSON.stringify(after));
      assert.equal((await cardOf(form.tabId)).status, "done");
      const fin = world.state.finishes.at(-1);
      const ev = (await evidenceLocal())[0];
      assert.match(ev.screenshot, /^data:image\/png;base64,/);
      assert.match(ev.screenshot_after, /^data:image\/png;base64,/);
      assert.notEqual(ev.screenshot, ev.screenshot_after, "two different pictures");
      assert.match(fin.p_evidence.screenshot_sha256, /^[0-9a-f]{64}$/);
      assert.match(fin.p_evidence.screenshot_after_sha256, /^[0-9a-f]{64}$/);
      assert.notEqual(fin.p_evidence.screenshot_sha256, fin.p_evidence.screenshot_after_sha256);
      const sha = (d) => require("node:crypto").createHash("sha256").update(Buffer.from(d.split(",")[1], "base64")).digest("hex");
      assert.equal(sha(ev.screenshot_after), fin.p_evidence.screenshot_after_sha256);
      assert.match(fin.p_evidence.confirmation_text, /Thank you for applying/);
      // The Proof view.
      await form.panel.waitForSelector("#card-proof:not([hidden])");
      await form.panel.click("#card-proof");
      await form.panel.waitForSelector("#proof:not([hidden])");
      const view = await form.panel.evaluate(() => ({
        heading: document.getElementById("proof-heading").textContent, answers: document.getElementById("proof-answers").children.length,
        before: document.getElementById("proof-before").src, after: document.getElementById("proof-after").src,
        quote: document.getElementById("proof-text").textContent, url: document.getElementById("proof-url").textContent,
        times: document.getElementById("proof-times").textContent, meta: document.getElementById("proof-meta").textContent,
      }));
      assert.match(view.heading, /sent; the employer's page confirmed it/);
      assert.equal(view.answers, done.payload.fields.length);
      assert.match(view.before, /^data:image\/png/);
      assert.match(view.after, /^data:image\/png/);
      assert.match(view.quote, /^".*Thank you for applying/);
      assert.match(view.url, /^Final page: https:\/\//);
      assert.match(view.times, /Card .*approved .*clicked .*answer read/);
      assert.match(view.meta, new RegExp("approval " + done.hash.slice(0, 12)));
    } finally {
      await closeForm(form);
    }
  }
});

test("proof: without the picture after the click, the card never says confirmed; clearing the proof asks first", async (t) => {
  if (skip(t)) return;
  fresh();
  const id = "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03";
  const form = await openForm(world.urlOf(id, "slowthanks"));
  try {
    await readyCard(form);
    await form.panel.click("#approve");
    // Once clicked, another tab comes to the front of the form's window: the page after the click cannot be photographed.
    await waitFor(() => submitsFor(id).length === 1, 5000);
    await sw.evaluate(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.create({ windowId: tab.windowId, url: "about:blank", active: true });
    }, form.tabId);
    const done = await waitCard(form.tabId, (c) => c.status === "done");
    assert.equal(done.result, "confirmed", "the employer did confirm");
    assert.equal(done.message, "Sent; the employer's answer could not be captured. Check your email for their confirmation.");
    assert.equal(world.state.finishes.at(-1).p_evidence.screenshot_after_sha256, null);
    await form.panel.click("#card-proof");
    await form.panel.waitForSelector("#proof:not([hidden])");
    assert.match(await form.panel.textContent("#proof-heading"), /^Not confirmed: the page after the click could not be photographed/);
    // Clear proof: asks, then clears.
    await form.panel.click("#clear-proof");
    assert.equal((await evidenceLocal()).length > 0, true, "nothing cleared before the confirm");
    await form.panel.click("#clear-yes");
    await waitFor(async () => true);
    await sleep(300);
    assert.equal((await evidenceLocal()).length, 0);
  } finally {
    await sw.evaluate(async () => {
      for (const t of await chrome.tabs.query({ url: "about:blank" })) await chrome.tabs.remove(t.id);
    });
    await closeForm(form);
  }
});

test("queue: after a posting that stops (already in your applications), Skip moves on and every later posting is sent and confirmed", async (t) => {
  if (skip(t)) return;
  fresh();
  const applied = "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d";
  world.state.jobs.push({ id: "TEST-prior", lease: "x", job_id: "lever:lyrahealth:35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", company: "lyrahealth", state: "confirmed", at: Date.now() });
  const ids = [applied, "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03", "lever-veeva-9ac55b31-df46-4acb-b305-2c0b7ed56027", "ashby-airwallex-cba0ab2e-5ab8-416b-ac9b-115638e3c65c"];
  const page = await ctx.newPage();
  await page.goto("https://upmore-topaz.vercel.app/?queue=2");
  const tabId = await tabIdOf(page.url());
  const panel = await openPanel(tabId);
  try {
    await panel.fill("#links", ids.map((id) => world.urlOf(id)).join("\n"));
    await panel.click("#q-add");
    await panel.waitForFunction(() => /added\./.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 }); // WO-072: the same race
    await panel.click("#q-start");
    for (const id of ids) {
      const url = world.urlOf(id);
      await waitFor(() => page.url() === url, 15000);
      let card = await waitCard(tabId, (c) => c.url === url && ["ready", "blocked"].includes(c.status), 20000);
      if (card.status === "blocked") {
        await personAnswers({ page, tabId, panel });
        card = await waitCard(tabId, (c) => c.url === url && c.status === "ready", 10000);
      }
      await panel.click("#approve");
      if (id === applied) {
        const stopped = await waitCard(tabId, (c) => c.url === url && c.status === "stopped");
        assert.match(stopped.message, /already in your applications/);
        await panel.click("#q-skip");
        continue;
      }
      const done = await waitCard(tabId, (c) => c.url === url && c.status === "done", 20000);
      assert.equal(done.result, "confirmed", `${id}: ${done.message}`);
    }
    const trail = await trailOf(tabId);
    assert.ok(!trail.some((x) => x.by === "unreachable"), JSON.stringify(trail.map((x) => x.by)));
    assert.equal(world.state.submits.length, 3, "every posting after the stopped one was sent once");
  } finally {
    await sw.evaluate(() => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
    await panel.close();
    await page.close();
  }
});

// ------------------------------------------------------------------------------------------------ written answers (WO-049)
// A required written question ("Why do you want to work here?", the TEST "essay" variant) on a real captured form. The
// draft comes from the world's TEST stand-in for career-essay-draft; its real logic is tested with a stub model in
// tests/architect/wo-049-essay-card.test.ts.
const ESSAY_FORM = "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d";
const WHY_NAME = "why_test";
const essayEl = (sel) => `.essay[data-name="${WHY_NAME}"] ${sel}`;
const fieldOf = (card, name = WHY_NAME) => (card.payload?.fields || []).find((f) => f.name === name) || null;
// WO-102: a drafted answer goes only when every fact behind it is one the person gave. The essay stand-in drafts from
// TEST-F1 and TEST-F2, so the TEST person holds both as owner-stated facts (an imported confirmed-facts file).
const ownEssayFacts = () => sw.evaluate((uid) => chrome.storage.session.set({ imported_file: { user_id: uid, saved: {}, answers: {
  essay_fact_one: { value: "TEST fact one", factId: "TEST-F1", confirmed: true, user_id: uid, provenance: "owner stated in chat (TEST)", confirmation_event_id: "evt-TEST-F1" },
  essay_fact_two: { value: "TEST fact two", factId: "TEST-F2", confirmed: true, user_id: uid, provenance: "owner stated in chat (TEST)", confirmation_event_id: "evt-TEST-F2" },
} } }), world.userId);
async function essayForm(k, variant = "essay") {
  await ownEssayFacts();
  const form = await openForm(world.cloneUrl(ESSAY_FORM, k) + "?trainee_test=" + variant);
  await fill(form);
  // The person answers everything else themselves and leaves the written question for the card.
  await personAnswers(form, {}, new Set([WHY_NAME]));
  const card = await waitCard(form.tabId, (c) => (c.essays || []).some((e) => e.name === WHY_NAME) && c.status === "blocked" &&
    c.openRequired.length === 1, 10000);
  // A form that asks for the person's own words shows its reason instead of a button.
  await form.panel.waitForSelector(essayEl(variant.includes("aiban") ? ".essay-msg" : ".essay-draft:not([hidden])"), { timeout: 10000 });
  return { form, card };
}
const pageValue = async (form) => (await formNow(form.tabId)).find((f) => f.name === WHY_NAME)?.value ?? null;

test("essay card: nothing is drafted without the person's tap; the draft is shown whole and goes on the form only by Use this; the approved payload carries it", async (t) => {
  if (skip(t)) return;
  fresh();
  world.state.essayCalls = [];
  world.state.essayReply = null;
  const before = (world.state.formAnswerCalls || []).length;
  const { form, card } = await essayForm(811);
  try {
    assert.equal(card.essays.find((e) => e.name === WHY_NAME).chars, 1500, "the field's own limit rides along");
    // No tap, no draft: not on Fill, not while the card waits, not on a click a script makes.
    await sleep(1500);
    assert.equal(world.state.essayCalls.length, 0, "no draft without the tap");
    await form.panel.evaluate((s) => document.querySelector(s).click(), essayEl(".essay-draft"));
    await sleep(800);
    assert.equal(world.state.essayCalls.length, 0, "a click a script makes drafts nothing");
    assert.equal(await form.panel.isHidden(essayEl(".essay-text")), true);
    // The person's tap.
    await form.panel.click(essayEl(".essay-draft"));
    await form.panel.waitForSelector(essayEl(".essay-text:not([hidden])"), { timeout: 10000 });
    assert.equal(world.state.essayCalls.length, 1);
    const asked = world.state.essayCalls[0];
    assert.equal(asked.posting, card.jobId);
    assert.match(asked.label, /^Why do you want to work here\?/);
    assert.equal(asked.limit.chars, 1500);
    assert.ok(asked.siblings.length >= 3 && !asked.siblings.includes(asked.label), "the form's other labels, for the employer's AI policy");
    assert.ok(!("facts" in asked) && !("fact_ids" in asked) && !/Test Person|test\.person@/.test(JSON.stringify(asked)), "no fact and no answer leaves the extension");
    const draft = await form.panel.inputValue(essayEl(".essay-text"));
    assert.match(draft, /^TEST draft 1: .*\.$/, "shown whole");
    assert.match(await form.panel.textContent(essayEl(".essay-facts")), /From your confirmed facts: experience: Data Analyst at Example Analytics; education: Statistics/);
    assert.equal(await form.panel.isVisible(essayEl(".essay-use")), true);
    assert.equal(await form.panel.isVisible(essayEl(".essay-redo")), true);
    // Shown is not used: the form and the card do not have it yet, and the tap is not offered.
    await sleep(500);
    assert.equal(await pageValue(form), "", "not on the form before Use this");
    let c = await cardOf(form.tabId);
    assert.equal(fieldOf(c), null, "not in the payload before Use this");
    assert.equal(c.status, "blocked");
    // Use this.
    await form.panel.click(essayEl(".essay-use"));
    c = await waitCard(form.tabId, (x) => fieldOf(x)?.value === draft && x.status === "ready", 10000);
    const f = fieldOf(c);
    assert.equal(f.source, "drafted");
    assert.equal(f.factId, "essay-draft:TEST-F1,TEST-F2");
    assert.equal(await pageValue(form), draft, "on the form");
    assert.ok(c.lines.some((l) => l.includes(draft) && /drafted by Trainee from your confirmed facts TEST-F1, TEST-F2; put on the form by you/.test(l)), "the card says whose it is");
    await form.panel.waitForFunction((h) => document.getElementById("approve").dataset.hash === h && !document.getElementById("approve").disabled, c.hash, { timeout: 10000 });
    await form.panel.click("#approve");
    const done = await waitCard(form.tabId, (x) => x.status === "done", 20000);
    assert.equal(done.result, "confirmed", done.message);
    // The approval bound exactly this text, and exactly this text reached the employer.
    const begin = world.state.begins.at(-1);
    assert.equal(begin.p_approval, c.hash);
    assert.equal(begin.p_payload.fields.find((x) => x.name === WHY_NAME).value, draft);
    const sent = world.state.submits.at(-1);
    assert.equal(sent.fields[WHY_NAME], draft, "the employer got the used draft");
    // The proof: drafted by Trainee from the person's facts, used by them, with the fact ids.
    const proof = (await evidenceLocal())[0];
    const a = proof.approved_answers.find((x) => x.name === WHY_NAME);
    assert.equal(a.provenance, "drafted by Trainee from your facts (TEST-F1, TEST-F2), used by you as drafted");
    assert.deepEqual(a.fact_ids, ["TEST-F1", "TEST-F2"]);
    const rec = world.state.finishes.at(-1).p_evidence.answers.find((x) => x.value === draft);
    assert.deepEqual([rec.source, rec.fact_ids, rec.edited], ["drafted", ["TEST-F1", "TEST-F2"], false]);
    // Kept for this posting only (job:), never as a fact or a wording.
    assert.equal((world.state.formAnswerCalls || []).length, before + 1);
    const kept = world.state.formAnswerCalls.at(-1).p_answers.filter((x) => x.answer === draft);
    assert.equal(kept.length, 1, "the used essay is kept once");
    assert.match(kept[0].key, /^job:[0-9a-f]{16}$/);
    assert.equal(world.state.answers.filter((x) => x.answer === draft && !x.key.startsWith("job:")).length, 0, "never fact: or label:");
  } finally {
    await closeForm(form);
  }
  // The same question at another employer is asked again, not filled from that essay.
  const other = await essayForm(812);
  try {
    assert.equal(fieldOf(other.card), null, "another employer's form never gets it");
    assert.equal(await pageValue(other.form), "");
  } finally {
    await closeForm(other.form);
  }
});

test("essay card: Redo replaces the draft (and takes a used one back off the form); an edit after Use this re-binds the approval to the edited text", async (t) => {
  if (skip(t)) return;
  fresh();
  world.state.essayCalls = [];
  world.state.essayReply = null;
  const { form } = await essayForm(821);
  try {
    await form.panel.click(essayEl(".essay-draft"));
    await form.panel.waitForSelector(essayEl(".essay-text:not([hidden])"), { timeout: 10000 });
    const first = await form.panel.inputValue(essayEl(".essay-text"));
    await form.panel.click(essayEl(".essay-use"));
    const used = await waitCard(form.tabId, (x) => fieldOf(x)?.value === first && x.status === "ready", 10000);
    // Redo: a new draft, written to differ from the first; the first comes off the form until Use this.
    await form.panel.click(essayEl(".essay-redo"));
    await form.panel.waitForFunction(([s, v]) => document.querySelector(s).value !== v && !document.querySelector(s).hidden, [essayEl(".essay-text"), first], { timeout: 10000 });
    assert.equal(world.state.essayCalls.length, 2);
    assert.equal(world.state.essayCalls[1].previous, first, "the model is asked for a different version");
    const second = await form.panel.inputValue(essayEl(".essay-text"));
    assert.match(second, /^TEST draft 2: /, "replaced");
    const cleared = await waitCard(form.tabId, (x) => !fieldOf(x) && x.status === "blocked", 10000);
    assert.notEqual(cleared.hash, used.hash);
    assert.equal(await pageValue(form), "", "the old draft is off the form");
    await form.panel.click(essayEl(".essay-use"));
    const c2 = await waitCard(form.tabId, (x) => fieldOf(x)?.value === second && x.status === "ready", 10000);
    // The person edits the used text on the card: the form and the payload follow, and the approval binds the edit.
    const extra = " I also mentor new analysts.";
    await form.panel.focus(essayEl(".essay-text"));
    await form.panel.press(essayEl(".essay-text"), "End");
    await form.panel.type(essayEl(".essay-text"), extra);
    const edited = second + extra;
    const c3 = await waitCard(form.tabId, (x) => fieldOf(x)?.value === edited && x.status === "ready", 10000);
    assert.equal(fieldOf(c3).source, "drafted");
    assert.notEqual(c3.hash, c2.hash, "a new approval for the edited text");
    assert.equal(await pageValue(form), edited);
    // The approval of the text before the edit is refused.
    const old = await form.panel.evaluate((h) => chrome.runtime.sendMessage({ type: "approve", tabId: Number(new URLSearchParams(location.search).get("tab")), hash: h }), c2.hash);
    assert.equal(old.ok, false, "the card before the edit cannot be approved");
    await form.panel.waitForFunction((h) => document.getElementById("approve").dataset.hash === h && !document.getElementById("approve").disabled, c3.hash, { timeout: 10000 });
    await form.panel.click("#approve");
    const done = await waitCard(form.tabId, (x) => x.status === "done", 20000);
    assert.equal(done.result, "confirmed", done.message);
    assert.equal(world.state.begins.at(-1).p_approval, c3.hash);
    assert.equal(world.state.submits.at(-1).fields[WHY_NAME], edited, "the employer got the edited text");
    const a = (await evidenceLocal())[0].approved_answers.find((x) => x.name === WHY_NAME);
    assert.equal(a.provenance, "drafted by Trainee from your facts (TEST-F1, TEST-F2), edited and used by you");
  } finally {
    await closeForm(form);
  }
});

test("essay card: the form changed after Use this (a page script rewrote the essay): nothing is sent", async (t) => {
  if (skip(t)) return;
  fresh();
  world.state.essayReply = null;
  const { form } = await essayForm(831);
  try {
    await form.panel.click(essayEl(".essay-draft"));
    await form.panel.waitForSelector(essayEl(".essay-text:not([hidden])"), { timeout: 10000 });
    const draft = await form.panel.inputValue(essayEl(".essay-text"));
    await form.panel.click(essayEl(".essay-use"));
    await waitCard(form.tabId, (x) => fieldOf(x)?.value === draft && x.status === "ready", 10000);
    await form.page.evaluate((n) => {
      const el = document.querySelector(`[name='${n}']`);
      el.value = "TEST planted by the page.";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, WHY_NAME);
    await form.panel.click("#approve");
    const stopped = await waitCard(form.tabId, (c) => ["stopped", "done", "blocked"].includes(c.status));
    assert.notEqual(stopped.status, "done");
    assert.match(String(stopped.message), /changed after you reviewed|set by the page|Not ready/);
    await sleep(800);
    assert.equal(world.state.submits.length, 0, "nothing sent");
    assert.equal(world.state.begins.length, 0, "nothing recorded");
  } finally {
    await closeForm(form);
  }
});

test("essay card: a form that asks for answers without AI shows the refusal and no draft; thin facts, a cut-off draft and a failure each say so in one line and leave the question asked", async (t) => {
  if (skip(t)) return;
  fresh();
  world.state.essayCalls = [];
  world.state.essayReply = null;
  let { form } = await essayForm(841, "essay,aiban");
  try {
    // The card reads the employer's policy itself: the reason is shown up front, with no button and no request.
    await form.panel.waitForFunction((s) => /without AI/.test(document.querySelector(s)?.textContent || ""), essayEl(".essay-msg"), { timeout: 10000 });
    assert.match(await form.panel.textContent(essayEl(".essay-msg")), /^This form asks for answers written without AI, so Trainee won't draft this one: it needs your own words\.$/);
    assert.equal(world.state.essayCalls.length, 0, "nothing was sent to the drafting service");
    assert.equal(await form.panel.isHidden(essayEl(".essay-text")), true, "no draft shown");
    assert.equal(await form.panel.isHidden(essayEl(".essay-use")), true, "nothing to use");
    assert.equal(await form.panel.isHidden(essayEl(".essay-draft")), true, "and no button to try again");
    const c = await cardOf(form.tabId);
    assert.equal(fieldOf(c), null);
    assert.equal(c.status, "blocked", "the question stays asked");
  } finally {
    await closeForm(form);
  }
  const cases = [
    { reply: { ok: false, why: "thin", message: "Only 1 of your confirmed facts fit this question and Trainee needs 2, so nothing was drafted. Tell Trainee a job or project you're proud of, confirm it, then tap Draft again." }, says: /^Only 1 of your confirmed facts fit this question/ },
    { reply: { ok: true, text: "TEST draft cut off at the token limit and", facts: [], fact_ids: [], message: "Drafted." }, says: /couldn't draft this right now/ },
    { reply: { ok: false, why: "unverified", message: "No draft shown: it kept naming things you haven't confirmed (Stripe). The question is still yours to answer." }, says: /^No draft shown: it kept naming/ },
  ];
  for (const [i, x] of cases.entries()) {
    world.state.essayReply = () => x.reply;
    ({ form } = await essayForm(842 + i));
    try {
      await form.panel.click(essayEl(".essay-draft"));
      await form.panel.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [essayEl(".essay-msg"), x.says.source], { timeout: 10000 });
      assert.equal(await form.panel.isHidden(essayEl(".essay-text")), true, "nothing shown");
      assert.equal(await form.panel.isHidden(essayEl(".essay-use")), true);
      assert.equal(await form.panel.isVisible(essayEl(".essay-draft")), true, "the question stays asked, and can be drafted again");
      assert.equal(fieldOf(await cardOf(form.tabId)), null);
      assert.ok(!(await form.panel.textContent(essayEl(".essay-msg"))).includes("\n"), "one line");
    } finally {
      await closeForm(form);
    }
  }
  world.state.essayReply = null;
});

// ------------------------------------------------------------------------------------------------ answer once (WO-054)
// Three captured forms that each ask about sponsorship in their own words, for a TEST person who has not said. Prepare
// reads them in hidden tabs (the "watch" variant reports anything done to a page), the panel asks the merged questions
// once, the TEST person answers them there, and the queue's cards then carry those answers, marked, with nothing sent.
test("answer once: Prepare reads 3 forms without touching them; the panel asks each question once; the cards carry the answers, marked; nothing is sent", async (t) => {
  if (skip(t)) return;
  fresh();
  const saved = world.state.answers;
  world.state.answers = saved.filter((a) => a.key !== "fact:sponsorship");
  const ids = ["lever-veeva-9ac55b31-df46-4acb-b305-2c0b7ed56027", "lever-lyrahealth-35bffe8b-ac9f-4749-ba4c-5f3a4d2bd77d", "ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03"];
  const urls = ids.map((id, k) => world.cloneUrl(id, 54 + k) + "?trainee_test=watch");
  const page = await ctx.newPage();
  await page.goto("https://upmore-topaz.vercel.app/?answer-once=1");
  const tabId = await tabIdOf(page.url());
  const panel = await openPanel(tabId);
  const tabCount = async () => (await sw.evaluate(() => chrome.tabs.query({}))).length;
  try {
    await panel.fill("#links", urls.join("\n"));
    await panel.click("#q-add");
    // WO-072: as in the queue test (WO-059), the click resolves before the background has stored the queue; Prepare
    // pressed in that moment read a short queue on a loaded CI runner. Wait for the panel's own "N postings added."
    await panel.waitForFunction(() => /added\./.test(document.getElementById("q-msg")?.textContent || ""), null, { timeout: 5000 });
    const tabsBefore = await tabCount();
    const trailBefore = (await sw.evaluate(async () => (await chrome.storage.session.get("card_trail")).card_trail || [])).length;
    await panel.click("#q-prepare");
    await panel.waitForFunction(() => document.querySelectorAll("#ao-list li").length > 0, null, { timeout: 60000 });
    const ao = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "status" }))).answerOnce;
    assert.equal(ao.status, "ready");
    assert.equal(ao.postings, 3, JSON.stringify(ao.failed));
    // Read only: nothing was set, clicked or submitted on any posting, no card was made, and every hidden tab is closed.
    await sleep(500); // a beacon from the page arrives a moment later
    assert.deepEqual(world.state.touched, [], "Prepare never fills or clicks");
    assert.equal(world.state.submits.length, 0);
    assert.equal((await sw.evaluate(async () => (await chrome.storage.session.get("card_trail")).card_trail || [])).length, trailBefore, "no card during Prepare");
    for (let i = 0; i < 50 && (await tabCount()) !== tabsBefore; i++) await sleep(100);
    assert.equal(await tabCount(), tabsBefore, "the hidden tabs are closed");
    // One entry for sponsorship, asked by all three; nothing pre-selected; never an essay, EEO, identity or file question.
    const spons = ao.questions.find((q) => q.key === "fact:sponsorship");
    assert.ok(spons, JSON.stringify(ao.questions.map((q) => q.key + " " + q.label)));
    assert.equal(spons.postings.length, 3);
    assert.equal(spons.similar, 2, "three wordings: one shown, and 2 similar");
    assert.equal(ao.questions[0].key, "fact:sponsorship", "the most asked first");
    for (const q of ao.questions) assert.ok(!/gender|race|veteran|disabilit|resume|cover letter|social security/i.test(q.label), q.label);
    const items = await panel.$$eval("#ao-list li", (lis) => lis.map((li) => ({ key: li.dataset.key, text: li.textContent, value: li.querySelector(".ao-answer").value,
      tag: li.querySelector(".ao-answer").tagName, options: [...li.querySelectorAll("option")].map((o) => o.value) })));
    assert.equal(items.length, ao.questions.length);
    console.log(`answer once: ${ao.open} open questions on 3 forms; the panel asks ${ao.questions.length}: ` +
      ao.questions.map((q) => `"${q.label.slice(0, 60)}" x${q.postings.length}${q.perPosting ? " (one posting)" : ""}`).join("; ") + `; left for the cards ${JSON.stringify(ao.left)}`);
    for (const it of items) assert.equal(it.value, "", `${it.text}: nothing pre-selected`);
    assert.match(items[0].text, /Asked by 3 postings/);
    assert.match(items[0].text, /and 2 similar/);
    // The TEST person answers every question in the panel: No to sponsorship, the last option elsewhere, a typed answer.
    for (const it of items) {
      const el = panel.locator(`#ao-list li[data-key="${it.key}"] .ao-answer`);
      if (it.key === "fact:sponsorship") await el.selectOption("No");
      else if (it.tag === "SELECT") await el.selectOption(it.options.at(-1));
      else await el.fill("TEST answer given in the panel");
    }
    const calls = (world.state.formAnswerCalls || []).length;
    await panel.click("#ao-save");
    await panel.waitForFunction(() => document.querySelectorAll("#ao-list li").length === 0, null, { timeout: 10000 });
    const after = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "status" }))).answerOnce;
    assert.equal(after.saved.length + after.refused.length, items.length, JSON.stringify(after.refused));
    assert.ok(after.saved.includes("fact:sponsorship"));
    assert.ok(world.state.formAnswerCalls.length > calls, "stored through career_apply_questions_answer_from_form_own");
    assert.ok(world.state.answers.some((a) => a.key === "fact:sponsorship" && a.answer === "No"));
    // The queue fills each posting: sponsorship on every card from the panel's answer, marked; nothing goes without a tap.
    await panel.click("#q-start");
    for (const url of urls) {
      await waitFor(() => page.url() === url, 15000);
      const card = await waitCard(tabId, (c) => c.url === url && ["ready", "blocked"].includes(c.status), 20000);
      const f = card.payload.fields.find((x) => /sponsorship/i.test(x.label));
      assert.ok(f, `${url}: ${JSON.stringify(card.lines)}`);
      assert.equal(f.source, "trainee");
      assert.match(f.factId, /^text-answer:/);
      assert.ok(card.before.includes(f.name), `${url}: marked`);
      assert.ok(card.lines.some((l) => l.includes(C_label(f.label)) && l.includes("answered before the session")), JSON.stringify(card.lines));
      assert.equal(card.lines.filter((l) => l.includes("answered before the session")).length, card.before.length, "only those answers are marked");
      await panel.click("#q-skip");
    }
    assert.equal(world.state.submits.length, 0, "nothing was sent");
    assert.equal(world.state.begins.length, 0, "nothing was recorded as an application");
  } finally {
    world.state.answers = saved;
    await sw.evaluate(() => chrome.storage.session.set({ queue: { items: [], index: -1, tabId: null, running: false } }));
    await sw.evaluate(() => chrome.storage.session.remove(["answer_once", "answered_before"]));
    await panel.close();
    await page.close();
  }
});
// A label as the card shows it (apply_core shortLabel: the required star dropped, cut at 160).
const C_label = (l) => {
  const t = String(l || "").replace(/\s*[*✱]+\s*$/, "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
};

module.exports = { expectedValue };
