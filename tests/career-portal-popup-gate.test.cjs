"use strict";
// x-audit (2026-11-10): the cloud engine's browser (scripts/career/portal-browser-helper.cjs) holds its host allowlist on
// a NEW TAB too. Its route judged only the first page's main frame. A tab's very first request has no frame yet, so it
// was refused only by the route's catch; a tab opened blank and then sent elsewhere (window.open(""), then location) has a
// frame, passed the check, and loaded any host, linkedin.com included. Measured: requests that ARRIVED at a host off the
// allowlist, counted by that host. The off-list host is 127.0.0.2 (loopback, never proxied), so nothing leaves the
// machine even when the gate fails.
// Run: node --test tests/career-portal-popup-gate.test.cjs (as a non-root user: the helper refuses an unsandboxed browser)
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

let helper = null, why = "";
try { helper = require(path.join(__dirname, "../scripts/career/portal-browser-helper.cjs")); } catch (e) { why = String(e.message).slice(0, 80); }
const skip = helper ? (process.getuid && process.getuid() === 0 ? "the helper needs Chromium's sandbox (run as a non-root user)" : false) : `helper not loadable: ${why}`;

let server, session;
after(async () => { if (session) await session.close().catch(() => {}); if (server) server.close(); });

test("a new tab opened by the page never loads a host off the allowlist", { skip }, async () => {
  // The off-list host counts every request that reaches it: the measure is what arrived, not what the browser reported.
  const hits = [];
  const off = await new Promise((r, j) => { const s = http.createServer((q, a) => { hits.push(q.url); a.end("off-list"); }); s.on("error", j); s.listen(0, "127.0.0.2", () => r(s)); });
  const offUrl = `http://127.0.0.2:${off.address().port}/jobs/view/1`;
  server = await new Promise((r) => {
    const s = http.createServer((_q, a) => {
      a.setHeader("content-type", "text/html");
      a.end(`<!doctype html><title>Job</title><a id="apply" href="${offUrl}" target="_blank">Apply</a>
        <button id="win" onclick="window.open('${offUrl}?w=1')">Apply in a window</button>
        <button id="blank" onclick="const w = window.open(''); w.location.href = '${offUrl}?w=2'">Apply (blank tab, then sent)</button>`);
    });
    s.listen(0, "127.0.0.1", () => r(s));
  });
  session = await helper.createSession();
  const page = await session.page();
  const ctx = page.context();
  const tried = [];
  ctx.on("request", (r) => { if (r.url().startsWith("http://127.0.0.2")) tried.push(r.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const sel of ["#apply", "#win", "#blank"]) {
    const popup = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.click(sel);
    const p = await popup;
    if (p) await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1000));
  off.close();
  assert.ok(tried.length >= 2, `the tabs tried to load the off-list host (${tried.length})`);
  assert.deepEqual(hits, [], `a new tab reached a host off the allowlist: ${hits.join(", ")}`);
});
