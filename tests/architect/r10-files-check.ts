// R10 WO-E visual checker (spec C.24, C.25, D): every File family page, measured in a real Chromium.
//   - no horizontal overflow at 390 px (the page, and no visible element past the right edge);
//   - every visible text at least 14 px on a phone;
//   - every visible text at least WCAG AA (4.5:1) against the ground it sits on;
//   - every action (link, button, summary, field) has a label, and every tap target is at least 44 px tall;
//   - every sourced claim (data-src="external": a posting, an employer page, a document) carries an https source link and a time;
//   - a download is a link that retrieves (a[download]) and never the filled primary; a submit, send or approve is a filled button;
//   - a restriction sits inside the role it qualifies;
//   - desktop (1280 px) is one centered column no wider than 720 px, with no overflow.
// Shared by the r10-files-browser-*.test.ts files. R10_SHOTS=1 writes PNGs (deviceScaleFactor 2) to tests/architect/snapshots/r10-files/.
// R10_FONT_DIR, if set, serves the brand faces from local woff2 files for the screenshots; otherwise every request is aborted.
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const SHOTS_DIR = `${ROOT}/tests/architect/snapshots/r10-files`;
export const CI = Deno.env.get("CI") === "true";
export function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`, "playwright"]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}

export const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const hiddenSr = (el) => !!el.closest(".ff-sr,.sr,[hidden]") || !!el.closest("details:not([open]) > :not(summary)");
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !hiddenSr(el); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || "").trim().slice(0, 40) + "'";
  const texts = [], wide = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE"].includes(el.tagName) || el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1) wide.push(name(el) + " right=" + Math.round(r.right));
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, ground: ground(el) });
  }
  const label = (el) => (el.getAttribute("aria-label") || (el.labels && el.labels[0] ? el.labels[0].textContent : "") || el.closest("label")?.textContent || el.textContent || "").trim();
  const actions = [...document.querySelectorAll("a[href],button,summary,input:not([type=hidden]),select,textarea")].filter(visible).map((el) => {
    const t = el.closest("label") || el; return { el: name(el), label: label(el), h: t.getBoundingClientRect().height };
  });
  const claims = [...document.querySelectorAll("[data-src=external]")].map((el) => ({ el: name(el), link: !!el.querySelector('a[href^="https://"]'), time: !!el.querySelector("time[datetime]") }));
  const effects = [...document.querySelectorAll("[data-effect]")].map((el) => ({ el: name(el), effect: el.dataset.effect, tag: el.tagName, download: el.hasAttribute("download"), pri: el.classList.contains("ff-pri"), disabled: !!el.disabled }));
  const restrictions = [...document.querySelectorAll(".ff-restr")].map((el) => { const a = el.closest(".ff-role"); if (!a) return false; const x = el.getBoundingClientRect(), y = a.getBoundingClientRect(); return x.top >= y.top && x.bottom <= y.bottom; });
  const ff = document.querySelector(".ff"), fr = ff ? ff.getBoundingClientRect() : null;
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, wide, texts, actions, claims, effects, restrictions,
    column: fr ? { x: fr.x, w: fr.width, right: window.innerWidth - fr.right } : null, unconfirmed: [...document.querySelectorAll("[data-unconfirmed]")].map((e) => e.textContent.trim()) };
})()`;
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
export const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Every rule for one page at one width; returns the failures (empty = pass).
export function judge(m: any, width: number): string[] {
  const bad: string[] = [];
  if (m.scrollW > m.innerW) bad.push(`scrolls sideways (${m.scrollW} > ${m.innerW})`);
  for (const w of m.wide) bad.push(`past the right edge: ${w}`);
  if (width <= 480) for (const t of m.texts.filter((t: any) => t.size < 14)) bad.push(`text under 14 px: ${t.el} ${t.size}px`);
  for (const t of m.texts.filter((t: any) => ratio(t.color, t.ground) < 4.5)) bad.push(`text under AA: ${t.el} ${ratio(t.color, t.ground).toFixed(2)}:1`);
  for (const a of m.actions) { if (!a.label) bad.push(`action without a label: ${a.el}`); if (a.h < 44) bad.push(`tap target under 44 px: ${a.el} ${a.h}px`); }
  for (const c of m.claims) { if (!c.link) bad.push(`sourced claim without a source link: ${c.el}`); if (!c.time) bad.push(`sourced claim without a date: ${c.el}`); }
  for (const e of m.effects) {
    if (e.effect === "download" && (e.pri || (!e.download && !e.disabled) || (e.tag !== "A" && !e.disabled))) bad.push(`download that does not look like a download: ${e.el}`);
    if (["submit", "send", "approve"].includes(e.effect) && (!e.pri || e.tag !== "BUTTON")) bad.push(`submit that looks like a preview: ${e.el}`);
  }
  m.restrictions.forEach((ok: boolean, i: number) => { if (!ok) bad.push(`restriction ${i + 1} is not inside the role it qualifies`); });
  if (width >= 1024 && m.column && (m.column.w > 720 || Math.abs(m.column.x - m.column.right) > 2)) bad.push(`desktop column is not one centered column of at most 720 px (${JSON.stringify(m.column)})`);
  for (const u of m.unconfirmed) if (!u) bad.push("an unconfirmed value with no words");
  return bad;
}

const FONTS: Record<string, string> = { "500": "brygada-1918-latin-500-normal.woff2", "700": "brygada-1918-latin-700-normal.woff2" };
async function route(ctx: any) {
  const dir = Deno.env.get("R10_FONT_DIR");
  await ctx.route("**/*", async (r: any) => {
    const u = r.request().url();
    if (dir && u.startsWith("https://fonts.googleapis.com/css2")) {
      return r.fulfill({ status: 200, contentType: "text/css", body: Object.entries(FONTS).map(([w, f]) => `@font-face{font-family:'Brygada 1918';font-weight:${w};src:url(https://fonts.gstatic.com/r10/${f}) format('woff2')}`).join("") });
    }
    if (dir && u.startsWith("https://fonts.gstatic.com/r10/")) return r.fulfill({ status: 200, contentType: "font/woff2", body: Buffer.from(await Deno.readFile(`${dir}/${u.split("/").pop()}`)) });
    return r.abort();
  });
}

// Render every page at 390 and 1280 px, judge it, and (R10_SHOTS=1) save a deviceScaleFactor 2 full-page screenshot.
export async function checkPages(t: Deno.TestContext, pages: Record<string, () => string>): Promise<string[]> {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the R10 File checker needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return []; }
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const shots = Deno.env.get("R10_SHOTS") === "1", written: string[] = [];
  if (shots) await Deno.mkdir(SHOTS_DIR, { recursive: true });
  try {
    for (const width of [390, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
      await route(ctx);
      const pg = await ctx.newPage();
      for (const [name, make] of Object.entries(pages)) {
        await t.step(`${name}, ${width} px`, async () => {
          await pg.setContent(make(), { waitUntil: "load" });
          await pg.evaluate("document.fonts.ready");
          const bad = judge(await pg.evaluate(MEASURE), width);
          if (shots) { const p = `${SHOTS_DIR}/${name}-${width}.png`; await pg.screenshot({ path: p, fullPage: true, animations: "disabled" }); written.push(p); }
          if (bad.length) throw Error(`${name} at ${width} px:\n  ${bad.join("\n  ")}`);
        });
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
  return written;
}
