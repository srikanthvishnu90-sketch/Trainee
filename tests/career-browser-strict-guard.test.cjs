"use strict";
// The strict benchmark's dry-run guard holds even if its stop before the click failed. strictStop (onPhase "submitting" throws)
// is the first wall; this test takes it away and lets the production runner press Submit on local pages, and proves the other
// two walls still stop everything: the bench's request gate (strictGate: every request but GET/HEAD/OPTIONS aborted in the
// browser) and its page script (STRICT_INIT: every form submit cancelled, no WebSocket opened from the page or a worker it starts). The local employer receives
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
const received = [], gets = [];
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
    if (req.method === "GET") gets.push(req.url);
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") { received.push(`${req.method} ${req.url}`); return res.writeHead(200).end("<h1>Thank you for applying</h1>"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (PAGES[req.url]) return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Apply</title><h2>Apply</h2>${PAGES[req.url]}`);
    // A board's own worker scripts (review probe p01-worker-ws-bench): each opens a socket and sends what the page posts to it;
    // /wf.js also POSTs it with fetch; /wn.js starts a nested worker that does the socket.
    const sock = `let s = new WebSocket("ws://" + self.location.host.replace(/^$/, "") + "/telemetry"); const q = []; s.onopen = () => { while (q.length) s.send(q.shift()); }; onmessage = (e) => { s.readyState === 1 ? s.send(e.data) : q.push(e.data); };`;
    const host = req.headers.host;
    const W = { "/w.js": sock.replace('self.location.host.replace(/^$/, "")', JSON.stringify(host)), "/wm.js": sock.replace('self.location.host.replace(/^$/, "")', JSON.stringify(host)),
      "/wf.js": `onmessage = (e) => { fetch("http://${host}/api/apply", { method: "POST", body: e.data }).catch(() => {}); };`,
      "/wn.js": `const inner = new Worker("http://${host}/w.js"); onmessage = (e) => inner.postMessage(e.data);` };
    // The positive control's worker scripts: each only asks for a page by a RELATIVE address (GETs, which the dry run lets through),
    // so the employer sees them only if the page's own worker really ran under the bench's page script.
    W["/wp.js"] = `fetch("ping-classic"); importScripts("wp2.js"); const n = new Worker("wp3.js"); onmessage = () => {};`;
    W["/wp2.js"] = `fetch("/ping-relative-import");`;
    W["/wp3.js"] = `fetch("ping-nested");`;
    W["/wpm.js"] = `import "./wpm2.js"; fetch("ping-module"); export {};`;
    W["/wpm2.js"] = `fetch("/ping-module-import"); export {};`;
    if (W[req.url]) return res.writeHead(200, { "content-type": "text/javascript" }).end(W[req.url]);
    // A same-origin frame that sends the typed answers over WebSocketStream and WebSocket (review probe p01-iframe-wsstream-bench).
    if (req.url === "/frame") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><script>let wr; try { const x = new WebSocketStream("ws://${host}/wss"); x.opened.then(({ writable }) => { wr = writable.getWriter(); wr.write("open"); }); } catch (e) {}
      let so; try { so = new WebSocket("ws://${host}/ws"); } catch (e) {} onmessage = (e) => { if (wr) wr.write(e.data); try { so.send(e.data); } catch (x) {} };</script>`);
    res.writeHead(404).end();
  });
  // A socket upgrade is answered as a real server would (so a socket that got through would open and send): counted, and every frame.
  server.on("upgrade", (req, socket) => { wsUpgrades++; received.push(`UPGRADE ${req.url}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64") + "\r\n\r\n");
    socket.on("data", (d) => received.push(`WS-FRAME ${d.length}B`)); socket.on("error", () => {}); });
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

// Review of the rs-01 split (probe p01-worker-ws-bench, 2026-11-17): a socket opened from the page's own dedicated worker reached the
// employer (the upgrade and 4 frames) while the bench reported a pass. Each worker shape below is driven by the bench itself, all its
// walls in place: nothing reaches the employer, no upgrade, no frame, no POST.
const WORKER_PAGE = (start) => `<!doctype html><title>Apply</title><h2>Apply</h2><form action="/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form>
  <script>const w = ${start}; document.addEventListener("input", () => w${start.startsWith("new SharedWorker") ? ".port" : ""}.postMessage(new URLSearchParams(new FormData(document.querySelector("form"))).toString()), true);</script>`;
for (const [k, start] of [["classic", 'new Worker("/w.js")'], ["module", 'new Worker("/wm.js", { type: "module" })'], ["nested", 'new Worker("/wn.js")'], ["fetch", 'new Worker("/wf.js")']]) {
  test(`a ${k} worker the page starts sends nothing: no socket upgrade, no frame, no POST; the bench still passes at the instant before Submit`, { skip, timeout: 60000 }, async () => {
    received.length = 0; wsUpgrades = 0;
    PAGES[`/worker-${k}`] = WORKER_PAGE(start).replace(/^<!doctype html><title>Apply<\/title><h2>Apply<\/h2>/, "");
    const x = await strictPosting(browser, { provider: "greenhouse", url: `${base}/worker-${k}` }, { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: resumePath(), openCheck: false });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(x.result, "pass", JSON.stringify({ reason: x.reason, error: x.error }));
    assert.deepEqual(received, [], `the local employer received: ${received.join(", ")}`);
    assert.equal(wsUpgrades, 0);
  });
}

// Review of the rs-01 fix (2026-11-17, probes p01-worker-runs, p01-iframe-wsstream-bench): the worker tests above passed while the
// bootstrap threw a SyntaxError and no worker ran at all. POSITIVE control: under the bench, the page's own classic worker, its
// relative importScripts, the nested worker it starts by a relative address, and a module worker with a relative static import all
// really run: the employer receives each of their GETs. Then a same-origin frame's WebSocketStream and WebSocket send nothing.
test("positive control: the page's own workers really run under the bench (relative fetch, importScripts, nested worker, module import)", { skip, timeout: 60000 }, async () => {
  received.length = 0; gets.length = 0;
  PAGES["/worker-positive"] = `<form action="/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form><script>new Worker("/wp.js"); new Worker("/wpm.js", { type: "module" });</script>`;
  const x = await strictPosting(browser, { provider: "greenhouse", url: `${base}/worker-positive` }, { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: resumePath(), openCheck: false });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(x.result, "pass", JSON.stringify({ reason: x.reason, error: x.error }));
  for (const u of ["/wp.js", "/ping-classic", "/wp2.js", "/ping-relative-import", "/wp3.js", "/ping-nested", "/wpm.js", "/wpm2.js", "/ping-module-import", "/ping-module"]) assert.ok(gets.includes(u), `${u} was asked for: ${gets.join(", ")}`);
  assert.deepEqual(received, []);
});
test("a same-origin frame's WebSocketStream and WebSocket send nothing; the bench still passes", { skip, timeout: 60000 }, async () => {
  received.length = 0; wsUpgrades = 0;
  PAGES["/framed"] = `<form action="/submit" method="post">${FIELDS}<button type="submit">Submit application</button></form><iframe src="/frame" style="width:1px;height:1px;border:0"></iframe>
    <script>document.addEventListener("input", () => document.querySelector("iframe").contentWindow.postMessage(new URLSearchParams(new FormData(document.querySelector("form"))).toString(), "*"), true);</script>`;
  const x = await strictPosting(browser, { provider: "greenhouse", url: `${base}/framed` }, { robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: resumePath(), openCheck: false });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(x.result, "pass", JSON.stringify({ reason: x.reason, error: x.error }));
  assert.deepEqual(received, []); assert.equal(wsUpgrades, 0);
});
