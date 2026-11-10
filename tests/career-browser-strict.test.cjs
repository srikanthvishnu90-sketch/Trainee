"use strict";
// The strict browser benchmark (scripts/browser-eval/strict.cjs) on local fixtures only: it drives the production runner, it
// passes a posting only at the instant before Submit, and nothing it does ever reaches the employer (0 POSTs received).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const lib = require("../scripts/browser-eval/eval-lib.cjs");
const { strictPosting, graphqlRead, summarize } = require("../scripts/browser-eval/strict.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
let browser, server, base;
const posts = [];
const fx = (f) => fs.readFileSync(path.join(__dirname, "fixtures/apply-dryrun", f), "utf8");
before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { posts.push(`${req.method} ${req.url}`); return res.writeHead(200).end("<h1>Thank you for applying</h1>"); }
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
    if (req.url === "/widgets.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(fx("widgets.js"));
    const m = /^\/(greenhouse-acme|lever-acme)$/.exec(req.url);
    if (m) return res.writeHead(200, { "content-type": "text/html" }).end(fx(`${m[1]}.html`));
    if (req.url === "/simple") return res.writeHead(200, { "content-type": "text/html" }).end(`<form action="/submit" method="post"><label>First Name <input name="first_name" required></label>
      <label>Last Name <input name="last_name" required></label><label>Email <input name="email" type="email" required></label><button type="submit">Submit application</button></form>`);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const opts = () => ({ robots: new Map(), pacer: lib.createPacer({ gapMs: 0 }), ua: "test", resumePath: lib.syntheticResume(fs.mkdtempSync(path.join(os.tmpdir(), "strict-"))) });

test("a form the runner completes passes only at the instant before Submit; nothing is posted", { skip }, async () => {
  const r = await strictPosting(browser, { provider: "greenhouse", url: `${base}/simple` }, opts());
  assert.equal(r.result, "pass", JSON.stringify(r));
  assert.equal(r.reason, "strict_reached_submit");
  assert.deepEqual(posts, []);
});

test("a required custom question is 'ready if answered', never a pass; a shown check is a failure; still nothing posted", { skip }, async () => {
  const gh = await strictPosting(browser, { provider: "greenhouse", url: `${base}/greenhouse-acme` }, opts());
  assert.notEqual(gh.result, "pass", JSON.stringify(gh));
  const lv = await strictPosting(browser, { provider: "lever", url: `${base}/lever-acme` }, opts());
  assert.equal(lv.result, "fail"); assert.equal(lv.reason, "bot_check");
  assert.deepEqual(posts, []);
});

test("only a GraphQL read may be POSTed; the summary counts every sampled posting", () => {
  const q = (b) => ({ method: () => "POST", postData: () => JSON.stringify(b) });
  assert.equal(graphqlRead(q({ query: "query ApiJobPosting { a }" })), true);
  assert.equal(graphqlRead(q({ query: "mutation ApplyToJob { a }" })), false);
  assert.equal(graphqlRead(q([{ query: "query A { a }" }, { query: "mutation B { b }" }])), false);
  assert.equal(graphqlRead({ method: () => "POST", postData: () => "first_name=x" }), false);
  const s = summarize([{ provider: "a", result: "pass", reason: "strict_reached_submit", sent_blocked: 0, graphql_reads: 0 }, { provider: "a", result: "fail", reason: "host_unreachable", sent_blocked: 0, graphql_reads: 0 }]);
  assert.equal(s.all.sampled, 2); assert.equal(s.all.pass, 1);
});
