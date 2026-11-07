// R9-C (2026-11-07): the market research brief in a real Chromium, at 390 px (phone) and 1280 px (desktop), light and dark:
// no sideways scrolling, every tap target at least 44 px, every visible text at least WCAG AA on its ground, the brand ground and
// card, the serif title and cover thesis, the cover on the warm ground (like the link preview), plum only on links and the mark, and
// the comparison table scrolls inside its own box rather than widening the page. No network (fonts fall back). DESIGN_SHOTS_DIR, if
// set, receives the screenshots.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { DARK, LIGHT, type Tokens } from "../../supabase/functions/_shared/brand.ts";
import { marketPage } from "./research-brief-fixture.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr"); };
  const name = (el) => el.tagName.toLowerCase() + "." + String(el.className || "") + " '" + (el.textContent || "").trim().slice(0, 30) + "'";
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el) || el.closest("svg") || ["SCRIPT","STYLE"].includes(el.tagName) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    texts.push({ el: name(el), color: rgb(getComputedStyle(el).color).c, ground: ground(el), link: !!el.closest("a,button") });
  }
  const taps = [...document.querySelectorAll("a[href],button")].filter(vis).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const card = document.querySelector(".fcard"), cover = document.querySelector(".rb-cover"), tbl = document.querySelector(".tbl");
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, texts, taps, body: ground(document.body),
    card: rgb(getComputedStyle(card).backgroundColor).c, cover: rgb(getComputedStyle(cover).backgroundColor).c,
    title: getComputedStyle(document.querySelector("h1")).fontFamily, thesis: getComputedStyle(document.querySelector(".rb-thesis")).fontFamily,
    tblFits: tbl.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5 };
})()`;
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function judge(m: any, t: Tokens): string[] {
  const bad: string[] = [];
  if (m.scrollW > m.innerW) bad.push(`scrolls sideways (${m.scrollW} > ${m.innerW})`);
  for (const x of m.taps) if (x.h < 44) bad.push(`tap target under 44 px: ${x.el} ${x.h}`);
  for (const x of m.texts) if (ratio(x.color, x.ground) < 4.5) bad.push(`text under AA: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}`);
  for (const x of m.texts) if (near(x.color, rgbOf(t.accent)) && !x.link) bad.push(`plum text outside a link: ${x.el}`);
  if (!near(m.body, rgbOf(t.bg))) bad.push(`ground ${m.body} is not ${t.bg}`);
  if (!near(m.card, rgbOf(t.card))) bad.push(`card ${m.card} is not ${t.card}`);
  if (!near(m.cover, rgbOf(t.bg))) bad.push(`cover ${m.cover} is not the warm ground ${t.bg}`);
  for (const f of [m.title, m.thesis]) if (!/Brygada 1918|Georgia|serif/.test(f) || /Inter/.test(f)) bad.push(`not the serif face: ${f}`);
  if (!m.tblFits) bad.push("the comparison table widens the card");
  return bad;
}

Deno.test({
  name: "market research brief in Chromium: 390 and 1280 px, light and dark",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) { if (CI) throw Error("the research brief design check needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH"), shots = Deno.env.get("DESIGN_SHOTS_DIR");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    try {
      // The judge itself catches a widened page (mutation check).
      assertNode.ok(judge({ scrollW: 500, innerW: 390, texts: [], taps: [], body: rgbOf(LIGHT.bg), card: rgbOf(LIGHT.card), cover: rgbOf(LIGHT.bg), title: "Georgia", thesis: "Georgia", tblFits: true }, LIGHT).length === 1);
      for (const scheme of ["light", "dark"] as const) for (const width of [390, 1280]) {
        await t.step(`${scheme}, ${width} px`, async () => {
          const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
          await ctx.route("**/*", (r: any) => r.abort());
          const pg = await ctx.newPage();
          await pg.setContent(marketPage(), { waitUntil: "load" });
          const bad = judge(await pg.evaluate(MEASURE), scheme === "light" ? LIGHT : DARK);
          if (shots) await Deno.writeFile(`${shots}/research-brief-${scheme}-${width}.png`, new Uint8Array(await pg.screenshot({ fullPage: true, animations: "disabled" })));
          await ctx.close();
          assertNode.deepStrictEqual(bad, [], `${scheme} ${width}`);
        });
      }
    } finally { await browser.close(); }
  },
});
