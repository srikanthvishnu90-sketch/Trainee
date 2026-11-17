"use strict";
// Personio's application form as of 2026-11-16 (captured read-only, tests/fixtures/runner-strict/personio-adragos-2840187.html):
// its Submit "Bewerbung senden" is disabled until the required questions are answered, and "required" is the word "(erforderlich)"
// in a screen-reader span after the label's asterisk, with no required attribute. Before this change the runner saw no Submit (a
// disabled control was no control), called the page "no application form" (19 of 20 Personio postings in the strict run of
// 2026-11-16), and read "E-Mail* (erforderlich)" as an optional question no fact answers. The fixture's one added script plays the
// board's part: it enables the Submit once every "(erforderlich)" question holds a value. Local page; nothing is sent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, answeredPosting } = require("../scripts/browser-eval/strict.cjs");
const { pickControls } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const posts = [];
const captured = fs.readFileSync(path.join(__dirname, "fixtures/runner-strict/personio-adragos-2840187.html"), "utf8");
// The board's part: Submit enabled once every question marked "(erforderlich)" holds a value (input, select).
const ENABLE = `<script>(() => { const btn = document.querySelector("button[type=submit]");
  const req = () => [...document.querySelectorAll("label")].filter((l) => /\\(erforderlich\\)/.test(l.textContent)).map((l) => document.getElementById(l.htmlFor)).filter(Boolean);
  const check = () => { btn.disabled = !req().every((e) => String(e.value || "").trim()); };
  document.addEventListener("input", check, true); document.addEventListener("change", check, true); check(); })();</script>`;
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("ok"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/job/2840187") return res.writeHead(200, { "content-type": "text/html" }).end(captured.replace("</body>", `${ENABLE}</body>`));
    // The captured page also carries Cloudflare Turnstile's widget just after its form, its cf-turnstile-response empty (its
    // challenge requests are POSTs the dry run aborts). "never": that widget taken out, a Submit the board never enables.
    // "turnstile": the page as captured, the token never issued, so the Submit waits.
    if (req.url === "/job/2840187/never") return res.writeHead(200, { "content-type": "text/html" }).end(captured.replace(/<div id="cf-turnstile">.*?<\/div><\/div><\/div>/, ""));
    if (req.url === "/job/2840187/turnstile") return res.writeHead(200, { "content-type": "text/html" }).end(captured);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "personio-"))) });

test("on a board that disables its Submit until valid, the disabled Submit still names the form; elsewhere it does not", () => {
  const snap = { forms: [{ hasControl: true, fields: [{ type: "text", hint: "Vorname first_name" }, { type: "email", hint: "E-Mail" }, { type: "file", hint: "Upload Lebenslauf documents.cv" }] }],
    controls: [{ c: 0, tag: "BUTTON", type: "submit", text: "Bewerbung senden", form: 0, inside: true, vis: true, disabled: true }] };
  // On any other board a disabled Submit is still no Submit (round 2): nothing is picked, nothing typed.
  assert.equal(pickControls(snap).submit, null);
  snap.waitsForValid = true;
  assert.deepEqual(pickControls(snap), { form: 0, submit: 0, next: null, refuse: null, disabled: true });
  snap.controls[0].disabled = false;
  assert.deepEqual(pickControls(snap), { form: 0, submit: 0, next: null, refuse: null });
});

test("Personio: the form is found, '(erforderlich)' questions are required, contact facts fill them; the rest is the person's", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "personio", url: `${base}/job/2840187` }, opts());
  assert.equal(r.result, "ready_if_answered", JSON.stringify({ reason: r.reason, field: r.field, needs: r.needs }));
  assert.deepEqual(r.needs.map((n) => n.label).sort(), ["Geschlecht", "Verfügbar ab"]);
  assert.deepEqual(posts, []);
});

test("Personio answered: the Submit the board enables once everything is filled is reached; one it keeps disabled is never pressed", { skip }, async () => {
  const o = opts();
  const item = { provider: "personio", url: `${base}/job/2840187` };
  const w = await answeredPosting(browser, item, o, await strictPosting(browser, item, o));
  assert.equal(w.result, "pass", JSON.stringify(w));
  const never = { provider: "personio", url: `${base}/job/2840187/never` };
  const n = await answeredPosting(browser, never, o, await strictPosting(browser, never, o));
  assert.equal(n.result, "fail"); assert.equal(n.reason, "field_not_filled"); assert.equal(n.field, "submit_disabled");
  assert.deepEqual(posts, []);
});

test("Personio with its invisible check's token never issued: the stop is the check, everything else filled; never pressed", { skip }, async () => {
  const o = opts();
  const item = { provider: "personio", url: `${base}/job/2840187/turnstile` };
  const w = await answeredPosting(browser, item, o, await strictPosting(browser, item, o));
  assert.equal(w.result, "fail"); assert.equal(w.reason, "bot_check", JSON.stringify(w));
  assert.deepEqual(posts, []);
});
