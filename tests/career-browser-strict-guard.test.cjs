"use strict";
// The strict benchmark's dry-run guard holds even if its stop before the click failed. strictStop (onPhase "submitting" throws)
// is the first wall; this test takes it away and lets the production runner press Submit on local pages, and proves the other
// two walls still stop everything: the bench's request gate (strictGate: every request but GET/HEAD/OPTIONS aborted in the
// browser) and its page script (STRICT_INIT: every form submit cancelled, no WebSocket opened). The local employer receives
// 0 POSTs, 0 beacons, 0 sockets; nothing is reported as submitted. Local pages only; nothing leaves this machine.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictGate, STRICT_INIT, strictPosting } = require("../scripts/browser-eval/strict.cjs");
const { applyOne, payloadHash } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base, wsUpgrades = 0;
const received = [];
const FIELDS = `<label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label>
  <label>Email <input name="email" type="email" required></label>`;
const PAGES = {
  // A plain HTML form: the click is a native form submit.
  "/native": `<form action="/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form>`,
  // The board's own script sends the answers on the click (fetch, sendBeacon, a socket, then form.submit()).
  "/scripted": `<form id="f" action="/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form>
    <script>document.getElementById("f").querySelector("button").addEventListener("click", () => {
      fetch("/api/apply", { method: "POST", body: "x=1" }).catch(() => {});
      try { navigator.sendBeacon("/beacon", "y=1"); } catch (e) {}
      try { const ws = new WebSocket("ws://" + location.host + "/ws"); ws.onopen = () => ws.send("z=1"); } catch (e) {}
      setTimeout(() => { try { document.getElementById("f").submit(); } catch (e) {} }, 50);
    });</script>`,
};
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") { received.push(`${req.method} ${req.url}`); return res.writeHead(200).end("<h1>Thank you for applying</h1>"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (PAGES[req.url]) return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Apply</title><h2>Apply</h2>${PAGES[req.url]}`);
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => { wsUpgrades++; received.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const resumePath = () => lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "strict-guard-")));
function payload(url) {
  const rp = resumePath(), sha = crypto.createHash("sha256").update(fs.readFileSync(rp)).digest("hex");
  const p = { id: "guard", ats: "greenhouse", url, facts: lib.PERSONAS.default, answers: {}, resume: { path: rp, sha256: sha, preparedWithSha256: sha } };
  p.approval = { approval_id: "strict-dry-run", hash: payloadHash(p) };
  return p;
}

for (const route of ["/native", "/scripted"]) {
  test(`with the stop before the click taken away, the runner presses Submit on ${route} and nothing reaches the employer`, { skip }, async () => {
    received.length = 0;
    const r = { sent_blocked: 0, graphql_reads: 0, upload_simulated: 0 };
    const item = { provider: "greenhouse", url: `${base}${route}` };
    let phases = 0;
    const out = await applyOne(browser, payload(item.url), { allowHosts: ["127.0.0.1"], retries: 0, stepTimeoutMs: 4000, checkSettleMs: 0,
      requestGate: strictGate(item, r, { pacer: lib.createPacer({ gapMs: 0 }) }), initScript: STRICT_INIT,
      onPhase: async (phase) => { if (phase === "submitting") phases++; } });
    assert.equal(phases, 1, "the runner reached its Submit click (the first wall was really taken away)");
    assert.deepEqual(received, [], `the local employer received: ${received.join(", ")}`);
    assert.equal(wsUpgrades, 0);
    assert.notEqual(out.status, "submitted_page_confirmed", JSON.stringify(out));
    // The board's own script sends on the click: the production runner's submit window refuses what was not approved.
    if (route === "/scripted") assert.equal(out.reason, "page_changed_at_submit", JSON.stringify(out));
  });
}

test("the bench itself, with its stop in place, passes the scripted page at the instant before Submit and sends nothing", { skip }, async () => {
  received.length = 0;
  const x = await strictPosting(browser, { provider: "greenhouse", url: `${base}/scripted` }, { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: resumePath() });
  assert.equal(x.result, "pass", JSON.stringify(x));
  assert.deepEqual(received, []);
  assert.equal(x.sent_blocked, 0, "nothing was even attempted: the stop came before the click");
});

test("the bench's request gate on its own: only GET/HEAD/OPTIONS, a GraphQL read and a simulated upload pass; every send is aborted", async () => {
  const r = { sent_blocked: 0, graphql_reads: 0, upload_simulated: 0 };
  const gate = strictGate({ provider: "greenhouse" }, r, { pacer: lib.createPacer({ gapMs: 0 }) });
  const req = (method, url, body = null, extra = {}) => ({ method: () => method, url: () => url, postData: () => body, postDataBuffer: () => (body ? Buffer.from(body) : null), headers: () => ({}),
    resourceType: () => extra.type || "fetch", isNavigationRequest: () => !!extra.nav, frame: () => ({ url: () => "https://job-boards.greenhouse.io/x/jobs/1" }) });
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(await gate(req(m, "https://job-boards.greenhouse.io/x/jobs/1/applications", "first_name=TEST")), false, m);
  assert.equal(await gate(req("POST", "https://www.google-analytics.com/collect", "v=1", { type: "ping" })), false, "a beacon");
  assert.equal(await gate(req("POST", "https://x.example/graphql", JSON.stringify({ query: "mutation Apply { a }" }))), false, "a GraphQL mutation");
  assert.equal(r.sent_blocked, 6);
  assert.equal(await gate(req("GET", "https://job-boards.greenhouse.io/x/jobs/1", null, { nav: true, type: "document" })), true);
  assert.equal(await gate(req("POST", "https://x.example/graphql", JSON.stringify({ query: "query Job { a }" }))), true);
  assert.equal(await gate(req("GET", "https://x.example/a.png", null, { type: "image" })), false, "images are not fetched");
  const up = await gate(req("POST", "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/", "--b\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nk\r\n"));
  assert.ok(up && up.fulfill, "the board's resume upload is answered inside the browser, never sent");
  assert.equal(r.upload_simulated, 1);
});
