// The deployed site is the contents of site/ (Vercel Output Directory 'site'); vercel.json and api/ sit at the repo root.
// Live check, 2026-11-03 (deployment dpl_Dep28fNj, release/production): the root vercel.json rewrites and the api/ functions DO
// deploy with that setting. /connect ran api/connect.js (503, TRAINEE_CONNECT_UPSTREAM unset) and /file ran api/file.js, whose
// upstream (the trainee-file edge function, not deployed on the Supabase project) answered its own 404 JSON; the proxy passed that
// through, so it looked like a missing page on this site. These tests keep: the pages the old deployment served, the rewrites, the
// honest answer when an upstream function is missing, no placeholder or example/sandbox contact in anything served, every
// in-page #link resolving, and the waitlist form's country selector unclipped.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { buildInterim, placeholdersIn } from "../../scripts/launch/build-legal-pages.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const CI = Deno.env.get("CI") === "true";

const walk = (dir: URL): string[] => readdirSync(dir).flatMap((n) => {
  const u = new URL(n, dir);
  return statSync(u).isDirectory() ? walk(new URL(n + "/", dir)) : [u.pathname];
});
const servedText = () => walk(new URL("site/", ROOT)).filter((f) => /\.(html|js|json|txt|css)$/.test(f));

Deno.test("every top-level page the old production deployment served still exists in site/", () => {
  for (const f of ["site/index.html", "site/privacy.html"]) assertNode.ok(existsSync(new URL(f, ROOT)), `${f} was served by the Oct 20 deployment and is gone`);
});

Deno.test("/ is the Trainee landing page; /privacy is the extension policy and says so, and is not offered as the service policy", () => {
  assertNode.match(read("site/index.html"), /<title>Trainee — your personal career agent<\/title>/);
  const p = read("site/privacy.html");
  assertNode.match(p, /<title>Browser extension privacy policy — Trainee — Assisted Apply<\/title>/);
  assertNode.match(p, /<h1>Trainee — Assisted Apply \(browser extension\): Privacy Policy<\/h1>/);
  assertNode.match(p, /This page covers the browser extension only\./);
  assertNode.match(p, /has not been published yet/);
  assertNode.match(p, /Last updated:/);
  // The homepage links no Trainee privacy or terms page until the owner's inputs exist (no /privacy, /terms, #product/privacy|terms).
  const h = read("site/index.html");
  assertNode.ok(!/href="(?:\/privacy|\/terms|\/google|#product\/(?:privacy|terms))"/.test(h), "no link to a policy page that is not published");
});

Deno.test("vercel.json keeps cleanUrls and rewrites /file and /connect to root api/ functions that exist; no outputDirectory override in the file", () => {
  const v = JSON.parse(read("vercel.json"));
  assertNode.equal(v.cleanUrls, true);
  assertNode.equal(v.outputDirectory, undefined, "the output directory is a dashboard setting; the file must not contradict it");
  const rw = new Map<string, string>((v.rewrites ?? []).map((r: { source: string; destination: string }) => [r.source, r.destination]));
  assertNode.equal(rw.get("/file"), "/api/file");
  assertNode.equal(rw.get("/connect"), "/api/connect");
  for (const d of rw.values()) {
    const f = `${d.slice(1)}.js`;
    assertNode.ok(existsSync(new URL(f, ROOT)), `${d} has no ${f}`);
    assertNode.match(read(f), /export const GET = pass;\s*export const POST = pass;/);
  }
  // Functions live at the root, outside the static output directory: nothing in site/ is named api.
  assertNode.ok(!existsSync(new URL("site/api", ROOT)));
});

async function proxy(file: "file" | "connect", env: string, upstream: Response | null) {
  const key = file === "file" ? "TRAINEE_FILE_UPSTREAM" : "TRAINEE_CONNECT_UPSTREAM";
  const before = Deno.env.get(key), realFetch = globalThis.fetch;
  try {
    if (env) Deno.env.set(key, env); else Deno.env.delete(key);
    globalThis.fetch = (() => Promise.resolve(upstream!)) as typeof fetch;
    const m = await import(`../../api/${file}.js?${crypto.randomUUID()}`);
    const r: Response = await m.GET(new Request(`https://trainee.test/${file}`));
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) Deno.env.delete(key); else Deno.env.set(key, before);
  }
}

Deno.test("/file and /connect: an unset upstream, or an upstream edge function that is not deployed, is an honest 503, never a bare 404; a real answer passes through", async () => {
  const notDeployed = () => new Response('{"code":"NOT_FOUND","message":"Requested function was not found"}', { status: 404, headers: { "content-type": "application/json" } });
  for (const f of ["file", "connect"] as const) {
    const unset = await proxy(f, "", null);
    assertNode.equal(unset.status, 503);
    assertNode.match(unset.body, /not set up yet/);
    const missing = await proxy(f, "https://ref.supabase.co/functions/v1/x", notDeployed());
    assertNode.equal(missing.status, 503, `${f}: upstream function not deployed`);
    assertNode.match(missing.body, /not available yet/);
    assertNode.ok(!/NOT_FOUND|Requested function/.test(missing.body), "Supabase's error text is not shown");
    const ok = await proxy(f, "https://ref.supabase.co/functions/v1/x", new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } }));
    assertNode.deepEqual([ok.status, ok.body], [200, "<html>hello</html>"]);
    const real404 = await proxy(f, "https://ref.supabase.co/functions/v1/x", new Response("<html>no such link</html>", { status: 404 }));
    assertNode.equal(real404.status, 404, "the function's own 404 page is still a 404");
  }
});

Deno.test("nothing served from site/ carries a placeholder, template note, example address or the Twilio sandbox; the homepage is exactly the interim build of its template", () => {
  for (const f of servedText()) {
    const t = readFileSync(f, "utf8");
    assertNode.deepEqual(placeholdersIn(t), [], `${f} ships a placeholder or template note`);
    assertNode.ok(!/@example\.(com|org|net)|wa\.me\/14155238886|basic-rocket|\+10000000000|support@|careers@/.test(t), `${f} ships a placeholder contact`);
  }
  const b = buildInterim(read("docs/launch/legal-pages/home.template.html"));
  assertNode.ok(b.ok);
  assertNode.equal(read("site/index.html"), (b as { html: string }).html, "site/index.html drifted: run deno run -A scripts/launch/build-legal-pages.ts --interim");
});

Deno.test("every in-page #link on the homepage resolves to an element, a route (home, about, careers, product) or a help page that exists", () => {
  const html = read("site/index.html");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const slugs = new Set([...html.matchAll(/\{ slug:'([a-z0-9-]+)'/g)].map((m) => m[1]));
  assertNode.ok(slugs.has("introduction") && slugs.has("support") && slugs.has("sms-terms"));
  const body = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<script[\s\S]*?<\/script>/g, (s) => s); // links in the help pages' markup count too
  const links = [...body.matchAll(/<a\b[^>]*?\shref="(#[^"]*)"/g)].map((m) => m[1].slice(1)).filter((h) => !/['+]/.test(h)); // not the ones the page's script builds
  assertNode.ok(links.length > 20);
  const bad = links.filter((h) => {
    if (h === "") return true; // a bare "#" goes nowhere
    const [page, slug] = h.split("/");
    if (page === "about" || page === "careers") return h !== page;
    if (page === "product") return !!slug && !slugs.has(slug);
    return !ids.has(h);
  });
  assertNode.deepEqual([...new Set(bad)], [], "dead in-page links");
});

function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT.pathname}tools/node_modules/playwright`, "/home/claude/.npm-global/lib/node_modules/playwright"]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}

Deno.test({
  name: "browser: About, Careers and the footer links show their page, and the waitlist country selector shows its longest label unclipped at 1280 and 1440",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the site check needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    try {
      for (const width of [1280, 1440]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        await ctx.route(/^https?:/, (r: any) => r.abort());
        const page = await ctx.newPage();
        const url = new URL("site/index.html", ROOT).href;
        await page.goto(url);
        const view = (n: string) => page.evaluate((n: string) => !document.querySelector(`[data-view="${n}"]`)!.hidden, n);
        for (const [link, v] of [["#about", "about"], ["#careers", "careers"], ["#product/support", "docs"], ["#product/security", "docs"]] as const) {
          await page.evaluate((h: string) => { document.querySelector(`footer a[href="${h}"], nav a[href="${h}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }, link).catch(() => {});
          await page.waitForTimeout(80);
          assertNode.ok(await view(v), `${link} shows the ${v} view at ${width}`);
          await page.goto(url);
        }
        await page.goto(url + "#signup");
        await page.waitForSelector("#su-country", { state: "attached" });
        const m = await page.evaluate(() => {
          const s = document.getElementById("su-country") as HTMLSelectElement, cs = getComputedStyle(s);
          const c = document.createElement("canvas").getContext("2d")!;
          c.font = `${cs.fontSize} ${cs.fontFamily}`;
          const text = Math.max(...[...s.options].map((o) => c.measureText(o.text).width));
          return { box: s.getBoundingClientRect().width, need: text + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 24 };
        });
        assertNode.ok(m.box >= m.need, `country selector ${m.box}px is narrower than its longest option needs (${Math.ceil(m.need)}px) at ${width}`);
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  },
});
