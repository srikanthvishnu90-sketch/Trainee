"use strict";
// b-ashby (strict benchmark run 42719264485, Ashby 1 of 20): an Ashby application, built by script with no <form>, as the
// strict benchmark saw it. The employer words its standard questions as sentences ("Your Full Name", "What's your phone
// number?"), puts one "Phone" label over the number box and over a Yes/No texting consent, and asks for a place through an
// autocomplete whose list comes from a lookup and whose pick is written into the box. The runner fills each from the
// person's facts, reads each back, and presses the one visible Submit. What stays the person's: a consent nobody approved,
// two boxes that could both take the same fact, a place the list does not offer word for word. Local fixtures only.
// Run: node --test tests/career-apply-ashby.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

const entry = (id, label, inner, req = true) => `<div class="ashby-application-form-field-entry" data-field-path="${id}"><label class="ashby-application-form-question-title${req ? " _required_x" : ""}" for="${id}">${label}</label>${inner}</div>`;
const yesno = (id, label, req) => `<div class="ashby-application-form-field-entry" data-field-path="${id}"><label class="ashby-application-form-question-title${req ? " _required_x" : ""}">${label}</label><div class="ashby-application-form-input-yesno"><button type="button" class="yn" aria-pressed="false">Yes - I consent to receiving text messages</button><button type="button" class="yn" aria-pressed="false">No - I do not consent to receiving text messages</button><input type="checkbox" name="${id}" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px"></div></div>`;
const PLACES = ["Chicago, IL", "Chicago Heights, IL", "Chico, CA"];
function page(k) {
  const consentReq = k === "consent_required";
  const fields = [
    entry("_systemfield_name", "Your Full Name", '<input id="_systemfield_name" name="_systemfield_name">'),
    entry("_systemfield_email", "Email", '<input id="_systemfield_email" type="email" name="_systemfield_email">'),
    entry("_systemfield_resume", "Resume", '<input id="_systemfield_resume" type="file" name="_systemfield_resume">'),
    entry("q_phone_ask", "What's your phone number?", '<input id="q_phone_ask" type="tel">'),
    entry("q_phone", "Phone", '<input id="q_phone" type="tel">'),
    k === "phone_twice" ? entry("q_phone2", "Phone", '<input id="q_phone2" type="tel">', false) : yesno("q_sms", "Phone", consentReq),
    entry("_systemfield_location", "Location", '<div class="_inputContainer"><input id="_systemfield_location" class="ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox"><div class="list"></div></div>'),
  ].join("");
  const places = k === "place_not_offered" ? ["Chicago, Illinois, United States"] : PLACES;
  return `<!doctype html><html><body><h1>Engineer @ Acme</h1><div id="app"></div><script>
setTimeout(() => {
  document.getElementById("app").innerHTML = ${JSON.stringify(`<div class="ashby-application-form-container">${fields}<button type="button" id="go" class="ashby-application-form-submit-button">Submit Application</button></div>`)};
  for (const b of document.querySelectorAll(".yn")) b.onclick = () => { for (const x of b.parentElement.querySelectorAll(".yn")) x.setAttribute("aria-pressed", String(x === b)); };
  const loc = document.getElementById("_systemfield_location"), list = loc.parentElement.querySelector(".list");
  let t = null;
  loc.oninput = () => { clearTimeout(t); list.innerHTML = ""; loc.setAttribute("aria-expanded", "false");
    // The places arrive from a lookup, a moment after typing.
    t = setTimeout(() => { const q = loc.value.toLowerCase().slice(0, 4);
      list.innerHTML = '<div role="listbox">' + ${JSON.stringify(places)}.filter((p) => p.toLowerCase().startsWith(q)).map((p) => '<div role="option">' + p + '</div>').join("") + '</div>';
      loc.setAttribute("aria-expanded", "true");
      for (const o of list.querySelectorAll("[role=option]")) o.onmousedown = o.onclick = () => { loc.value = o.textContent; list.innerHTML = ""; loc.setAttribute("aria-expanded", "false"); };
    }, 700); };
  document.getElementById("go").onclick = async () => {
    const v = (id) => (document.getElementById(id) || {}).value;
    const sms = [...document.querySelectorAll(".yn")].find((b) => b.getAttribute("aria-pressed") === "true");
    await fetch("/submit/${k}", { method: "POST", body: JSON.stringify({ name: v("_systemfield_name"), email: v("_systemfield_email"), phone_ask: v("q_phone_ask"), phone: v("q_phone"), location: v("_systemfield_location"), sms: sms ? sms.textContent : null, resume: (document.getElementById("_systemfield_resume").files[0] || {}).name }) });
    document.body.innerHTML = '<h1 id="confirmation">Thank you for applying</h1>';
  };
}, 300);
</script></body></html>`;
}
const PAGES = ["plain", "phone_twice", "consent_required", "place_not_offered"];

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return PAGES.includes(k) ? res.writeHead(200, { "content-type": "text/html" }).end(page(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "ashby-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const FACTS = { full_name: "Casey Example", email: "casey@example.invalid", phone: "+1 312 555 0100", location: "Chicago, IL" };
const job = (k) => {
  const p = { id: "ash-" + k, ats: "ashby", url: `${base}/${k}`, facts: FACTS, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
const sent = (k, n) => posts.slice(n).filter((p) => p.url === `/submit/${k}`);

test("Ashby: sentence-worded name and phone, the number box under a shared Phone label, the place from the lookup: filled, read back, sent once", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("plain"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = sent("plain", n);
  assert.equal(mine.length, 1, "sent once");
  // The optional texting consent nobody approved is left alone.
  assert.deepEqual(JSON.parse(mine[0].body), { name: "Casey Example", email: "casey@example.invalid", phone_ask: FACTS.phone, phone: FACTS.phone, location: "Chicago, IL", sms: null, resume: "resume.pdf" });
});

test("Ashby: two boxes that could each take the phone under one label: handed back, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("phone_twice"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent("phone_twice", n).length, 0, "nothing may be sent");
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => x.label === "Phone" && x.reason === "label_on_form_twice"), JSON.stringify(r.needs));
});

test("Ashby: a required texting consent under the Phone label is the person's to answer, never taken from the phone fact", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("consent_required"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent("consent_required", n).length, 0, "nothing may be sent");
  assert.equal(r.reason, "missing_required_answer", JSON.stringify(r));
  assert.deepEqual((r.needs || []).map((x) => [x.label, x.reason, x.kind]), [["Phone", "no_confirmed_answer", "buttons"]]);
});

test("Ashby: a place the lookup does not offer word for word is handed back with the offered places, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("place_not_offered"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(sent("place_not_offered", n).length, 0, "nothing may be sent");
  const loc = (r.needs || []).find((x) => x.label === "Location");
  assert.ok(loc, JSON.stringify(r));
  assert.equal(loc.reason, "no_matching_option");
  assert.deepEqual(loc.options, ["Chicago, Illinois, United States"]);
});
