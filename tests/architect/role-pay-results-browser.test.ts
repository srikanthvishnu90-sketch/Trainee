// The results page in a real Chromium at phone width, light and dark (reqs Q551, Q553, Q557, Q567, Q568, Q718): the list, a
// card's Apply opening the exact application, the code from the person's chat typed in, Approve, the card turning into its
// status, and the queue row carrying exactly the payload that was shown. Then "Apply to selected" for two roles. The page is
// served by trainee-file's handler over the memory world (tests/helpers/results_world.ts) on 127.0.0.1; every other request
// (web fonts, logos) is aborted. Nothing reaches an employer.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { DARK, LIGHT, type Tokens } from "../../supabase/functions/_shared/brand.ts";
import { HASH, made, NOW, U, world } from "../helpers/results_world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Measured in the page: sideways scroll, tap targets, text sizes and contrast against the ground each text sits on, grounds.
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr,[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || el.value || "").trim().slice(0, 40) + "'";
  const taps = [...document.querySelectorAll("a[href],button,summary,select,input:not([type=hidden]):not([type=checkbox]),label.pick")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE","OPTION"].includes(el.tagName) || el.closest("svg")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, ground: ground(el) });
  }
  const applies = [...document.querySelectorAll(".apply")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor).c, w: el.getBoundingClientRect().width }));
  const goes = [...document.querySelectorAll("button.ghost.go")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor), w: el.getBoundingClientRect().width }));
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, taps, texts, applies, goes, body: ground(document.body), ink: rgb(getComputedStyle(document.body).color).c };
})()`;

Deno.test({
  name: "results page in Chromium (phone width, light and dark): list, Apply -> the exact application -> code from chat -> Approve -> queued with that payload; Apply to selected",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the results page browser test needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: true, ...(chrome ? { executablePath: chrome } : {}) });
    try {
      for (const scheme of ["light", "dark"] as const) {
        const tok: Tokens = scheme === "light" ? LIGHT : DARK;
        await t.step(scheme, async () => {
          const w = world();
          const r = await made(w, U, undefined, { name: "Ada", source: "live" });
          const session = await w.A.tok(U, r.listId, NOW);
          const ac = new AbortController();
          const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, (req) => handleFile(req, w.deps));
          const origin = `http://127.0.0.1:${server.addr.port}`;
          const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
          await ctx.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await ctx.addCookies([{ name: "tf_s", value: session, url: origin }]);
          const pg = await ctx.newPage();
          try {
            const check = async (where: string) => {
              const m = await pg.evaluate(MEASURE), bad: string[] = [];
              if (m.scrollW > m.innerW) bad.push(`scrolls sideways (${m.scrollW} > ${m.innerW})`);
              for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44 px: ${x.el} ${x.h}px`);
              for (const x of m.texts.filter((x: any) => x.size < 14)) bad.push(`text under 14 px: ${x.el}`);
              for (const x of m.texts.filter((x: any) => ratio(x.color, x.ground) < 4.5)) bad.push(`text under AA: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
              if (!near(m.body, rgbOf(tok.bg))) bad.push(`ground ${m.body} is not ${tok.bg}`);
              if (!near(m.ink, rgbOf(tok.ink))) bad.push(`ink ${m.ink} is not ${tok.ink}`);
              for (const a of m.applies) if (!near(a.bg, rgbOf(tok.accent))) bad.push(`the action ${a.el} is ${a.bg}, not the plum ${tok.accent}`);
              eq(bad, [], `${where} (${scheme})`);
              return m;
            };
            // The list.
            await pg.goto(`${origin}/file`);
            assert(/Frontend internships, \$30\/hr or more/.test(await pg.textContent("h1")));
            const list = await check("the list");
            // The header, in reading order on screen: made for, title, what was read, the caveat, the quick read, then the cards.
            const ys = await pg.evaluate(`[".made","h1",".stamp",".caveat",".quick","li.card"].map((q) => { const e = document.querySelector(q); return e ? e.getBoundingClientRect().top : null; })`);
            assert(ys.every((y: number | null) => y !== null), `every header part is on the page: ${ys}`);
            assert(ys.every((y: number, i: number) => i === 0 || y > ys[i - 1]), `in order down the page: ${ys}`);
            const sizes = await pg.evaluate(`[".made","h1",".stamp",".caveat",".quick p"].map((q) => parseFloat(getComputedStyle(document.querySelector(q)).fontSize))`);
            assert(sizes[1] >= 28 && sizes[0] < sizes[1] && sizes[2] < sizes[1], `a large title over small lines: ${sizes}`);
            assert(/^Made for Ada · Nov 1, 2026$/.test((await pg.textContent(".made"))!.trim()));
            // Plum only on the one primary action (owner, 2026-11-01): Apply to selected; each card's Apply is the secondary button.
            eq(list.applies.map((a: any) => a.el), ["button.apply 'Apply to selected'"], "one primary action on the list");
            eq(list.goes.length, 3, "an Apply on each card");
            assert(list.goes.every((a: any) => a.w >= 390 - 2 * 20 - 2 * 18 - 4), "each card's Apply is full width on a phone");
            assert(list.goes.every((a: any) => !a.bg || a.bg.a < 0.5 || !near(a.bg.c, rgbOf(tok.accent))), "card Apply is not plum");
            assert(/Pay not listed/.test(await pg.textContent("main") ?? ""));
            // Apply on Acme's card: the exact application.
            await pg.locator("li.card", { hasText: "Acme Web" }).getByRole("button", { name: /^Apply to/ }).click();
            await pg.waitForSelector("text=Check your application");
            const review = await pg.textContent("main") ?? "";
            for (const x of ["ada-resume.pdf", "Ada", "ada@example.test", "Are you authorized to work in the US?", "I'd love to build at Acme Web.", "boards.greenhouse.io"]) assert(review.includes(x), `${x} shown before approval`);
            await check("the review");
            eq(w.queue.length, 0, "nothing queued by looking");
            // The code goes to the person's chat; typed here; Approve.
            await pg.getByRole("button", { name: "Text me a code" }).click();
            await pg.waitForSelector("text=We sent a 6-digit code to your Trainee chat");
            eq(w.outbox.length, 1);
            const code = /code is (\d{6})/.exec(w.outbox[0].text)![1];
            await pg.fill("#code", code);
            await pg.getByRole("button", { name: "Approve and send" }).click();
            await pg.waitForSelector("li.card >> text=Queued");
            const acme = await pg.locator("li.card", { hasText: "Acme Web" }).textContent() ?? "";
            assert(/Queued/.test(acme) && /Approved\. It's queued to be sent exactly as you checked it/.test(acme), acme);
            await check("the list after Approve");
            eq(w.queue.length, 1);
            eq(w.queue[0].payload_hash, HASH(1));
            eq(w.queue[0].payload, w.preps.get("greenhouse:acme:1")!.payload, "the queue row carries exactly the payload shown");
            // Apply to selected: tick two, review both, one code, approve both.
            await pg.locator("li.card", { hasText: "Globex" }).getByRole("checkbox").check();
            await pg.locator("li.card", { hasText: "Initech" }).getByRole("checkbox").check();
            await pg.getByRole("button", { name: "Apply to selected" }).click();
            await pg.waitForSelector("text=Check 2 applications");
            await check("the batch review");
            await pg.getByRole("button", { name: "Text me a code" }).click();
            await pg.waitForSelector("text=We sent a 6-digit code to your Trainee chat");
            await pg.fill("#code", /code is (\d{6})/.exec(w.outbox.at(-1)!.text)![1]);
            await pg.getByRole("button", { name: "Approve and send all 2" }).click();
            await pg.waitForSelector("text=All 2 approved and queued");
            eq(w.queue.map((q) => q.job_id).sort(), ["greenhouse:acme:1", "greenhouse:initech:3", "lever:globex:2"]);
            eq(w.queue.find((q) => q.job_id === "lever:globex:2")!.payload, w.preps.get("lever:globex:2")!.payload);
          } finally {
            await ctx.close();
            ac.abort();
            await server.finished;
          }
        });
      }
    } finally {
      await browser.close();
    }
  },
});
