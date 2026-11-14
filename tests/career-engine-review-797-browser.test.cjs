"use strict";
// Independent review of #797, on local pages in Chromium through the real runner (parallel-apply applyOne) and the real re-check
// (handoff recheck). Every page is on 127.0.0.1; the server counts every POST and every beacon a page's own script sends, so
// "nothing typed, nothing pressed, nothing sent" is read from the server, not from the runner's word.
// The same decisions without a browser: tests/career-engine-review-797.test.cjs.
// Run: node --test tests/career-engine-review-797-browser.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");
const { recheck } = require("../workers/career-browser/handoff.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const beacon = (k) => `fetch('/beacon/${k}')`;
const FIELDS = `<label>First Name <input name="first_name" required oninput="${beacon("typed")}"></label><label>Last Name <input name="last_name" required></label>
  <label>Email <input name="email" type="email" required oninput="${beacon("typed")}"></label>`;
const CHECK = `<div class="g-recaptcha" data-sitekey="6L-TEST" style="width:304px;height:78px;border:1px solid #ccc">I'm not a robot</div>`;
const NEWS = `<form action="/newsletter" method="post"><label>Your email <input type="email" name="newsletter_email" oninput="${beacon("typed")}"></label><button type="submit">Subscribe</button></form>`;
const doc = (title, body) => `<!doctype html><title>${title}</title><body><h1>${title}</h1>${body}</body>`;
const PAGES = {
  // A form in two steps: the check is drawn on step 1, inside the form; Continue hides step 1 (and the check) and shows Submit.
  "/steps": doc("Engineer", `<form action="/steps/submit" method="post"><div id="s1">${FIELDS}${CHECK}</div><div id="s2" style="display:none"><label>LinkedIn <input name="linkedin"></label></div>
    <button type="button" onclick="${beacon("continue")};s1.style.display='none';s2.style.display='';sub.style.display=''">Continue</button><button id="sub" type="submit" style="display:none">Submit application</button></form>`),
  // The review's page: the only form is a newsletter box; one "Apply" button outside it that leads nowhere.
  "/news": doc("Designer", `<button type="button" onclick="${beacon("apply")}">Apply</button>${NEWS}`),
  // The same page whose Apply control opens the real application.
  "/opens": doc("Designer", `<a href="/appform">Apply</a>${NEWS}`),
  "/appform": doc("Application", `<form action="/appform/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form>`),
  // BambooHR's recorded shape: the page's one form, an application, and its one Submit drawn directly after it.
  "/outside": doc("Analyst", `<form action="/outside/submit" method="post">${FIELDS}</form><button type="button" onclick="document.forms[0].submit()">Submit Application</button>`),
  // The same control with anything else in the way: a newsletter form on the page; a search box between the form and the control; a link.
  "/outside-news": doc("Analyst", `<form action="/outside/submit" method="post">${FIELDS}</form><button type="button" onclick="document.forms[0].submit()">Submit Application</button>${NEWS}`),
  "/outside-search": doc("Analyst", `<form action="/outside/submit" method="post">${FIELDS}</form><input type="search" aria-label="Search jobs"><button type="button" onclick="document.forms[0].submit()">Submit Application</button>`),
  "/outside-link": doc("Analyst", `<form action="/outside/submit" method="post">${FIELDS}</form><a role="button" href="/appform">Apply</a>`),
  // A consent box the page ticked itself (not required, so nothing asks for it).
  "/preticked": doc("Writer", `<form action="/preticked/submit" method="post">${FIELDS}<label><input type="checkbox" name="share" checked> I agree to share my application with partner companies</label><button type="submit">Submit application</button></form>`),
};
let server, base, browser, resume, rsha;
const posts = [], beacons = [];
const state = { city: "Leeds", lang: "English", listSaysClosed: false };
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    const html = (s) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET") { posts.push(u.pathname); return html("<h1>Thank you for applying</h1>"); }
    if (u.pathname.startsWith("/beacon/")) { beacons.push(u.pathname.slice(8)); return res.writeHead(204).end(); }
    if (PAGES[u.pathname]) return html(PAGES[u.pathname]);
    // Architect amendment (round 2, stricter): a value the page sets itself that round 2 still allows without asking (the form's
    // language, a presentational default), which the server can change between two loads.
    if (u.pathname === "/default") return html(doc("Planner", `<form action="/default/submit" method="post">${FIELDS}<label>Language <select name="lang">${["English", "Français"].map((l) => `<option${l === state.lang ? " selected" : ""}>${l}</option>`).join("")}</select></label><input type="hidden" name="csrf_token" value="${Math.random()}"><button type="submit">Submit application</button></form>`));
    // A box the page prefilled with text the person never gave: asked (round 2).
    if (u.pathname === "/prefilled") return html(doc("Planner", `<form action="/default/submit" method="post">${FIELDS}<label>Preferred office <input name="office" value="${state.city}"></label><input type="hidden" name="csrf_token" value="${Math.random()}"><button type="submit">Submit application</button></form>`));
    if (u.pathname === "/jobs/55") return res.writeHead(302, { location: "/jobs" }).end();
    if (u.pathname === "/jobs") return html(doc("Open roles", state.listSaysClosed ? "<p>This job is no longer available.</p>" : "<ul><li>Engineer</li></ul>"));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev797-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise((r) => server.close(r)); if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true }); });
const job = (p0) => {
  const p = { id: "r797" + p0.replace(/\W/g, "-"), ats: "greenhouse", url: base + p0, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-797", hash: payloadHash(p) };
  return p;
};
const run = async (p0) => { posts.length = 0; beacons.length = 0; return applyOne(browser, job(p0), { stepTimeoutMs: 8000, retries: 0 }); };
const o = { skip, timeout: 60000 };

test("1: a check on step 1 of a step form: Continue is not pressed past it, Submit is never reached, and it is the person's hand-off", o, async () => {
  const r = await run("/steps");
  assert.deepEqual([r.status, r.reason, r.wall], ["needs_user", "bot_check", "check_in_form"], JSON.stringify(r));
  assert.equal(r.handoff.reason, "bot_check_in_form"); assert.equal(r.handoff.person_sees, "empty_form");
  assert.ok(!beacons.includes("continue"), "Continue was not pressed"); assert.deepEqual(posts, []);
});

test("2: a newsletter box and an outside Apply button are not the application: nothing typed, nothing sent, the reason named", o, async () => {
  const r = await run("/news");
  assert.deepEqual([r.status, r.reason], ["not_submitted", "no_application_form_found"], JSON.stringify(r));
  assert.ok(!beacons.includes("typed"), "the email was not typed into the newsletter box"); assert.deepEqual(posts, []);
  assert.ok(beacons.filter((b) => b === "apply").length <= 1, "the Apply control is opened at most once, as an opener");
});

test("2: an Apply control that opens the application is opened, and the application's own form is the one filled and submitted", o, async () => {
  const r = await run("/opens");
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.deepEqual(posts, ["/appform/submit"]);
});

test("2: the page's one application form with its one Submit drawn directly after it (BambooHR): that form is filled and submitted", o, async () => {
  const r = await run("/outside");
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.deepEqual(posts, ["/outside/submit"]);
});

test("2: the same outside Submit beside a second form, or past a search box: refused before anything is typed", o, async () => {
  for (const p0 of ["/outside-news", "/outside-search"]) {
    const r = await run(p0);
    assert.deepEqual([r.status, r.reason], ["not_submitted", "submit_not_tied_to_form"], `${p0} ${JSON.stringify(r)}`);
    assert.ok(!beacons.includes("typed"), p0); assert.deepEqual(posts, [], p0);
  }
});

test("2: an outside link in the Apply words is opened as a link, never pressed as the form's Submit", o, async () => {
  const r = await run("/outside-link");
  assert.deepEqual(posts.filter((x) => x === "/outside/submit"), [], JSON.stringify(r));
  assert.deepEqual(posts, ["/appform/submit"], "the link led to the application's own form, and that one was submitted");
});

test("4: a consent box the page ticked itself is asked of the person, never sent", o, async () => {
  const r = await run("/preticked");
  assert.deepEqual([r.status, r.reason], ["not_submitted", "missing_required_answer"], JSON.stringify(r));
  assert.deepEqual(r.needs.map((n) => [n.label, n.reason]), [["I agree to share my application with partner companies", "agreement_needs_you"]]);
  assert.equal(r.handoff.card, "ask_once"); assert.deepEqual(posts, []);
});

// Architect amendment (round 2, stricter): the page-set value is now a presentational default (the form's language), which round 2
// shows and hashes without asking; a prefilled text box the person never gave is asked (last assertion).
test("4: the card carries a value the page set itself; a yes to that card is refused once the page holds another value, and sent when it holds the same", o, async () => {
  posts.length = 0; state.lang = "English";
  const ready = await recheck(browser, job("/default"), { stepTimeoutMs: 8000 });
  assert.equal(ready.state, "ready_for_yes", JSON.stringify(ready));
  assert.deepEqual(ready.card.answers.filter((a) => a.source === "page_default").map((a) => [a.field, a.value]), [["Language", "English"]]);
  assert.equal(ready.card.hidden_not_hashed, 1);
  state.lang = "Français";
  const changed = await recheck(browser, job("/default"), { stepTimeoutMs: 8000, yes: { card_hash: ready.card.hash } });
  assert.deepEqual([changed.state, changed.reason], ["stopped", "APPROVED_APPLICATION_CHANGED"]); assert.deepEqual(posts, []);
  state.lang = "English";
  const sent = await recheck(browser, job("/default"), { stepTimeoutMs: 8000, yes: { card_hash: ready.card.hash } });
  assert.equal(sent.state, "submitted", JSON.stringify(sent)); assert.deepEqual(posts, ["/default/submit"]);
  posts.length = 0;
  const asked = await recheck(browser, job("/prefilled"), { stepTimeoutMs: 8000 });
  assert.notEqual(asked.state, "ready_for_yes", JSON.stringify(asked));
  assert.deepEqual((asked.handoff ? asked.handoff.remaining : []).filter((x) => x.kind === "answer").map((x) => x.what), ["Preferred office"], "a prefilled text box the person never gave is asked");
  assert.deepEqual(posts, []);
});

test("5: a posting the board sends to its job list is closed only when that page says so", o, async () => {
  state.listSaysClosed = false;
  const open = await run("/jobs/55");
  assert.deepEqual([open.status, open.reason], ["not_submitted", "posting_not_confirmed_closed"], JSON.stringify(open));
  state.listSaysClosed = true;
  assert.equal((await run("/jobs/55")).reason, "posting_closed");
});
