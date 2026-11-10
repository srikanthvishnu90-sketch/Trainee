"use strict";
// r11 browser capability: the strict bench's full-profile persona (a separate column, never in place of the default) and the
// exact place / state pick. A confirmed place "Chicago, IL" goes onto a board's "Chicago, Illinois, United States" only when
// the city, the state (by name or postal code) and the person's confirmed country are all the same; an option that is the
// place's own text wins; never another state, never a guess between two. US work authorization and the sponsorship
// need are confirmed Yes/No facts that answer only a Yes/No choice. Local fixtures only; nothing reaches an employer.
// Run: node --test tests/career-browser-full-persona.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting } = require("../scripts/browser-eval/strict.cjs");
const { matchPlace, matchState, factKey, factValue, decide } = require("../workers/career-browser/ats-fill.cjs");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

test("place: the person's own spelling first, else the same city, the same US state by name or code, the confirmed country", () => {
  const US = "United States";
  assert.deepEqual(matchPlace(["Chicago Heights, Illinois, United States", "Chicago, Illinois, United States"], "Chicago, IL", US), { index: 1 });
  assert.equal(matchPlace(["Chicago, Illinois, United States", "Chicago, IL, United States"], "Chicago, IL", US).error, "ambiguous_option", "the same place twice is the person's to pick");
  assert.deepEqual(matchPlace(["Chicago, IL"], "Chicago, IL", US), { index: 0 });
  assert.deepEqual(matchPlace(["Chicago, Illinois, USA"], "Chicago, IL", US), { index: 0 });
  // Never another state, another country, or a country nobody confirmed.
  assert.equal(matchPlace(["Chicago, Indiana, United States"], "Chicago, IL", US).error, "no_matching_option");
  assert.equal(matchPlace(["Chicago, Illinois, Canada"], "Chicago, IL", US).error, "no_matching_option");
  assert.equal(matchPlace(["Chicago, Illinois, United States"], "Chicago, IL", "").error, "no_matching_option");
  assert.equal(matchPlace(["Chicago, Illinois, United States"], "Chicago, IL", "Canada").error, "no_matching_option");
  assert.deepEqual(matchPlace(["Paris, Texas, United States", "Paris, Ile-de-France, France"], "Paris, TX", US), { index: 0 });
  assert.equal(matchPlace(["Portland, ME, United States", "Portland, Oregon, United States"], "Portland, OR, US", US).index, 1);
  // No country to check (Lever's list): only the United States after a US state.
  assert.deepEqual(matchPlace(["Chicago, Illinois, United States"], "Chicago, IL"), { index: 0 });
  assert.equal(matchPlace(["Chicago, Illinois, Canada"], "Chicago, IL").error, "no_matching_option");
  assert.equal(matchPlace(["Chicago, Illinois, United States", "Chicago, Illinois, United States of America"], "Chicago, IL", US).error, "ambiguous_option");
});

test("state: the exact option first, else the one option that is the same state by name or postal code; never a neighbour", () => {
  assert.deepEqual(matchState(["Indiana", "Illinois", "Iowa"], "IL"), { index: 1 });
  assert.deepEqual(matchState(["IN", "IL", "IA"], "Illinois"), { index: 1 });
  assert.deepEqual(matchState(["Illinois", "IL"], "IL"), { index: 1 });
  assert.equal(matchState(["IN", "IA"], "IL").error, "no_matching_option");
  assert.equal(matchState(["Illinois"], "Ill").error, "no_matching_option");
  assert.equal(matchState(["Ontario", "Quebec"], "IL").error, "no_matching_option");
});

test("eligibility facts: US work authorization and the sponsorship need answer only a Yes/No choice, only where the question fits", () => {
  const facts = lib.FULL_FACTS;
  assert.equal(factKey("Are you legally authorized to work in the U.S.?"), "work_authorization");
  assert.equal(factKey("Are you authorized to work in the United States?*"), "work_authorization");
  assert.equal(factKey("Are you authorized to work in Canada?"), undefined);
  assert.equal(factKey("Are you legally authorized to work in the United States without sponsorship?"), undefined);
  assert.equal(factKey("Will you now or in the future require visa sponsorship?"), "sponsorship");
  assert.equal(factKey("Will you now or in the future require sponsorship to work in the UK?"), undefined);
  assert.equal(factKey("Do you have a visa that does not require sponsorship?"), undefined);
  assert.equal(factKey("Will you require sponsorship? We do not sponsor visas."), undefined);
  assert.equal(factValue("Do you require sponsorship?", facts), "No");
  assert.equal(factValue("Do you require sponsorship?", { sponsorship: "maybe" }), undefined, "only a confirmed yes or no");
  const opts = [{ label: "Yes" }, { label: "No" }];
  assert.deepEqual(decide({ kind: "radio", label: "Are you legally authorized to work in the United States?", required: true, options: opts }, { facts, answers: {} }), { status: "fill", value: "Yes", source: "fact" });
  assert.deepEqual(decide({ kind: "textarea", label: "Are you legally authorized to work in the United States?", required: true }, { facts, answers: {} }), { status: "ask", reason: "no_confirmed_answer" }, "never typed into a box");
  assert.equal(decide({ kind: "radio", label: "Are you legally authorized to work in the United States?", required: true, options: opts }, { facts: lib.TEST_FACTS, answers: {} }).status, "ask", "the default persona has no such fact");
  assert.equal(decide({ kind: "select", label: "State", required: true, options: [] }, { facts, answers: {} }).value, "Illinois");
  assert.equal(decide({ kind: "text", label: "City", required: true }, { facts, answers: {} }).value, "Chicago");
  assert.equal(decide({ kind: "text", label: "City", required: true }, { facts: lib.TEST_FACTS, answers: {} }).value, "Chicago, IL", "without a confirmed city, the place as before");
  // The default persona is unchanged; the full one only adds facts.
  for (const k of Object.keys(lib.TEST_FACTS)) assert.equal(lib.FULL_FACTS[k], lib.TEST_FACTS[k]);
  assert.deepEqual(Object.keys(lib.PERSONAS), ["default", "full"]);
});

// A form with the questions a first application asks: the full persona reaches Submit, the default one is "ready if answered".
const ELIG = `<!doctype html><html><body><h1>Engineer @ Acme</h1><form action="/submit" method="post">
<label for="fn">First Name*</label><input id="fn" name="first_name" required>
<label for="ln">Last Name*</label><input id="ln" name="last_name" required>
<label for="em">Email*</label><input id="em" name="email" type="email" required>
<label for="st">State*</label><select id="st" name="state" required><option value="">Select...</option><option value="IN">IN</option><option value="IL">IL</option><option value="IA">IA</option></select>
<fieldset><legend>Are you legally authorized to work in the United States?*</legend><label><input type="radio" name="wa" value="1" required>Yes</label><label><input type="radio" name="wa" value="0">No</label></fieldset>
<fieldset><legend>Will you now or in the future require visa sponsorship?*</legend><label><input type="radio" name="sp" value="1" required>Yes</label><label><input type="radio" name="sp" value="0">No</label></fieldset>
<button type="submit">Submit application</button></form></body></html>`;
const PLACES = ["Chicago Heights, Illinois, United States", "Chicago, Illinois, United States", "Chicago, Indiana, United States"];
const ASHBY = (places) => `<!doctype html><html><body><h1>Engineer @ Acme</h1><div id="app"></div><script>
setTimeout(() => {
  const f = (id, label, inner) => '<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x" for="' + id + '">' + label + '</label>' + inner + '</div>';
  document.getElementById("app").innerHTML = '<div class="ashby-application-form-container">' + f("n", "Name", '<input id="n">') + f("e", "Email", '<input id="e" type="email">')
    + f("loc", "Location", '<div class="_inputContainer"><input id="loc" class="ashby-application-form-input-autocomplete" aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox"></div>')
    + '<button type="button" id="go" class="ashby-application-form-submit-button">Submit Application</button></div>';
  const loc = document.getElementById("loc"), list = document.createElement("div"); document.body.appendChild(list);
  let t = null;
  loc.oninput = () => { clearTimeout(t); list.innerHTML = ""; loc.setAttribute("aria-expanded", "false");
    t = setTimeout(() => { const q = loc.value.toLowerCase().slice(0, 4);
      list.innerHTML = '<div class="_floatingContainer" role="listbox">' + ${JSON.stringify(places)}.filter((p) => p.toLowerCase().startsWith(q)).map((p) => '<div role="option" class="_result ashby-application-form-input-autocomplete-result">' + p + '</div>').join("") + '</div>';
      loc.setAttribute("aria-expanded", "true");
      for (const o of list.querySelectorAll("[role=option]")) o.onmousedown = o.onclick = () => { loc.value = o.textContent; list.innerHTML = ""; loc.setAttribute("aria-expanded", "false"); };
    }, 400); };
  document.getElementById("go").onclick = async () => {
    await fetch("/submit/ashby", { method: "POST", body: JSON.stringify({ location: loc.value }) });
    document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>';
  };
}, 200);
</script></body></html>`;

let browser, server, base, resume, rsha;
const posts = [];
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); });
      return;
    }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/elig") return res.writeHead(200, { "content-type": "text/html" }).end(ELIG);
    if (req.url === "/ashby") return res.writeHead(200, { "content-type": "text/html" }).end(ASHBY(PLACES));
    if (req.url === "/ashby-indiana") return res.writeHead(200, { "content-type": "text/html" }).end(ASHBY(["Chicago, Indiana, United States"]));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"));
  resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true }); });
const opts = (persona) => ({ persona, robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "strict-"))) });

test("strict bench: the full persona reaches Submit (state by code, eligibility radios); the default persona is only ready if answered; nothing posted", { skip, timeout: 90000 }, async () => {
  const n = posts.length;
  const full = await strictPosting(browser, { provider: "greenhouse", url: `${base}/elig` }, opts("full"));
  assert.equal(full.persona, "full");
  assert.equal(full.result, "pass", JSON.stringify(full));
  const def = await strictPosting(browser, { provider: "greenhouse", url: `${base}/elig` }, opts(undefined));
  assert.equal(def.persona, "default");
  assert.equal(def.result, "ready_if_answered", JSON.stringify(def));
  assert.deepEqual(def.needs.map((x) => x.label).sort(), ["Are you legally authorized to work in the United States?", "State", "Will you now or in the future require visa sponsorship?"].sort());
  assert.equal(posts.length, n, "the strict bench posts nothing");
  await assert.rejects(strictPosting(browser, { provider: "greenhouse", url: `${base}/elig` }, opts("someone")), /unknown persona/);
});

const job = (k, facts) => {
  const p = { id: "p-" + k, ats: "ashby", url: `${base}/${k}`, facts, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
const FACTS = { full_name: "Casey Example", email: "casey@example.invalid", location: "Chicago, IL", country: "United States" };

test("Ashby place: 'Chicago, IL' with the confirmed country picks 'Chicago, Illinois, United States', read back from the box", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("ashby", FACTS), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = posts.slice(n).filter((p) => p.url === "/submit/ashby");
  assert.equal(mine.length, 1);
  assert.deepEqual(JSON.parse(mine[0].body), { location: "Chicago, Illinois, United States" });
});

test("Ashby place: a list with only another state is handed back with its options, never picked; nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("ashby-indiana", FACTS), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(posts.slice(n).length, 0, "nothing may be sent");
  const loc = (r.needs || []).find((x) => x.label === "Location");
  assert.ok(loc, JSON.stringify(r));
  assert.equal(loc.reason, "no_matching_option");
  assert.deepEqual(loc.options, ["Chicago, Indiana, United States"]);
});

test("runner: a request whose judging fails (a page or context closing under it) is dropped, never an unhandled rejection", { skip, timeout: 60000 }, async () => {
  const seen = []; const onRej = (e) => seen.push(e); process.on("unhandledRejection", onRej);
  try {
    const n = posts.length;
    const gate = async (req) => { if (req.isNavigationRequest()) throw new Error("Request context disposed."); return true; };
    const r = await applyOne(browser, job("ashby", FACTS), { stepTimeoutMs: 4000, retries: 0, requestGate: gate });
    assert.notEqual(r.status, "submitted_page_confirmed", JSON.stringify(r));
    assert.equal(posts.length, n, "nothing sent");
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(seen, []);
  } finally { process.off("unhandledRejection", onRej); }
});
