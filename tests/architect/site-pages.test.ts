// The deployed site is the contents of site/ (inferred from the Oct 20 production deployment dpl_9yvMT6zD...,
// b09c3c57d: GET / served site/index.html "Trainee — your personal career agent", /privacy served site/privacy.html,
// while /connect/gmail and /icon-192.png at the repo root returned 404). cleanUrls maps /privacy -> privacy.html.
// This test keeps the next release from silently dropping a page the old deployment served.
import assertNode from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

// Every top-level file the old production deployment served from site/ (list from origin/main:site/).
const SERVED_BY_OLD_DEPLOYMENT = ["site/index.html", "site/privacy.html"];
// Intentionally dropped: none. (site/.gitkeep is not served as a page.)
const INTENTIONALLY_DROPPED: string[] = [];

Deno.test("every top-level page the old production deployment served still exists in site/", () => {
  for (const f of SERVED_BY_OLD_DEPLOYMENT) {
    if (INTENTIONALLY_DROPPED.includes(f)) continue;
    assertNode.ok(existsSync(new URL(f, root)), `${f} was served by the Oct 20 deployment and is gone`);
  }
});

Deno.test("/ is the Trainee landing page and /privacy is the extension privacy policy", () => {
  assertNode.match(read("site/index.html"), /<title>Trainee — your personal career agent<\/title>/);
  const p = read("site/privacy.html");
  assertNode.match(p, /<title>Privacy Policy — Trainee — Assisted Apply<\/title>/);
  assertNode.match(p, /Last updated:/);
});

Deno.test("vercel.json keeps cleanUrls (so /privacy resolves) and the /file and /connect rewrites", () => {
  const v = JSON.parse(read("vercel.json"));
  assertNode.equal(v.cleanUrls, true);
  const rw = new Map<string, string>((v.rewrites ?? []).map((r: { source: string; destination: string }) => [r.source, r.destination]));
  assertNode.equal(rw.get("/file"), "/api/file");
  assertNode.equal(rw.get("/connect"), "/api/connect");
  assertNode.ok(existsSync(new URL("api/file.js", root)) && existsSync(new URL("api/connect.js", root)));
});
