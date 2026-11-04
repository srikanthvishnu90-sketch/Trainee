// Product requirements doc 3 (design): every page Trainee serves, opened in a real Chromium at phone width, checked against the
// written design criteria rather than against a picture someone liked.
//   Q551  phone width first: no sideways scrolling, every tap target at least 44 px tall.
//   Q544  facts (role, description, key details, fit line, status notes) at 16 px or more; nothing under 14 px.
//   Q553  text contrast at least WCAG AA (4.5:1) against what it sits on, in light AND dark.
//   Q557/Q575  plum only for actions: a plum ground is only ever the primary action; plum text only on a link or a button.
//   Q561  a routine notice is a neutral callout, never red.
//   Q564/Q565/Q726  one identity: every page has the same ground and the same ink (the shared tokens, _shared/brand.ts).
//   Screenshot check: the PNG the browser renders is read back pixel by pixel; the Apply button's centre is the plum and the page's
//   corner is the ground, in both schemes.
// No network: every request the page makes (web fonts, Telegram's script) is aborted, so the system-font fallback is what renders.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { renderFeed, renderLinkState, renderPhoneLogin, type Row } from "../../supabase/functions/_shared/file_page.ts";
import { renderConnect } from "../../supabase/functions/_shared/connect_page.ts";
import { page as gmailPage } from "../../supabase/functions/_shared/connectors.ts";
import { page as outlookPage } from "../../supabase/functions/_shared/outlook_connector.ts";
import { careerLanding } from "../../supabase/functions/gmail-oauth/career.ts";
import { DARK, LIGHT, type Tokens } from "../../supabase/functions/_shared/brand.ts";

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

// ---------------------------------------------------------------- the pages, with synthetic content only
const job = (n: number, extra: Record<string, unknown> = {}) => ({
  job_id: `greenhouse:acme:${n}`, company: n === 1 ? "Acme Analytics" : "Globex", title: n === 1 ? "Senior Product Analyst" : "Data Analyst", location: "Austin, TX",
  url: `https://boards.greenhouse.io/acme/jobs/${n}`, pay: "$90k-$120k", level: null, remote: "hybrid", posted_at: "2026-10-28T12:00:00Z",
  first_seen_at: "2026-10-28T13:00:00Z", deadline: null, source: "Greenhouse", reasons: ["You named product analytics."], company_domain: null, ...extra,
}) as any;
const row = (n: number, extra: Partial<Row> = {}): Row => ({
  ref: `ref${n}`, job: job(n), logo: null, snippet: "Own the weekly pricing report and build dashboards for the growth team.", full: "Own the weekly pricing report.\nRequirements\n• 3 years of SQL",
  status: null, tag: "0123456789abcdef", resume: "resume 0123456789ab", byHand: false, meta: "Austin, TX · $90k-$120k · Greenhouse", metaSrc: "From the posting",
  why: ["You named product analytics."], posted: "Posted 3 d ago (Oct 28)", ...extra,
} as Row);
const feed = () => renderFeed({ token: "fs1." + "a".repeat(64), rows: [row(1), row(2, { status: { word: "queued", detail: "We haven't started it yet." }, tag: null, note: "Queued just now." })],
  setHash: "b".repeat(64), setSize: 2, top: "That list changed since you opened it, so nothing was sent." });
const connect = () => renderConnect({ token: "fs1." + "c".repeat(64), reason: "replies", botUrl: "https://t.me/TraineeBot", providers: [
  { id: "google", configured: true, state: "not_connected", email: null, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
  { id: "microsoft", configured: true, state: "connected", email: "ada@example.test", scopes: ["Mail.Read"] }] });
const text = async (r: Response) => await r.text();
async function pages(): Promise<Record<string, string>> {
  return {
    "jobs list": feed(),
    "phone sign-in": renderPhoneLogin({ step: "phone", note: "That number isn't the one on this account.", botUrl: "https://t.me/TraineeBot" }),
    "code step": renderPhoneLogin({ step: "code", botUrl: "https://t.me/TraineeBot" }),
    "link state": renderLinkState("This link expired", ["Links last 24 hours. Nothing was sent."], "https://t.me/TraineeBot"),
    "connect page": connect(),
    "gmail connect page": await text(gmailPage("Connect Gmail to Trainee", ["This connects your Gmail to your Trainee account."], 200, { action: "/connect", token: "t", label: "Continue to Google" })),
    "outlook page": await text(outlookPage("Outlook connected", ["You can close this tab and go back to your chat with Trainee."])),
    "gmail landing": await text(careerLanding(true)),
  };
}

// ---------------------------------------------------------------- PNG read-back (8-bit RGB/RGBA, non-interlaced: what Chromium writes)
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await out.arrayBuffer());
}
async function decodePng(png: Uint8Array): Promise<{ w: number; h: number; px: (x: number, y: number) => [number, number, number] }> {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, w = 0, h = 0, type = 0;
  const idat: Uint8Array[] = [];
  while (off < png.length) {
    const len = dv.getUint32(off), kind = String.fromCharCode(...png.subarray(off + 4, off + 8)), body = png.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); if (png[off + 16] !== 8 || png[off + 20] !== 0) throw Error("unsupported PNG"); type = png[off + 17]; }
    if (kind === "IDAT") idat.push(body);
    if (kind === "IEND") break;
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw Error(`PNG colour type ${type}`);
  const all = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of idat) { all.set(c, at); at += c.length; }
  const raw = await inflate(all), stride = w * bpp, img = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = img.subarray(y * stride, (y + 1) * stride), prev = y ? img.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      cur[i] = (src[i] + pred) & 255;
    }
  }
  return { w, h, px: (x, y) => { const i = Math.round(y) * stride + Math.round(x) * bpp; return [img[i], img[i + 1], img[i + 2]]; } };
}
const rgbOf = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---------------------------------------------------------------- what the page measures in itself
// Runs in the page. Colours come back as [r,g,b] (alpha-blended grounds resolved by walking up to the first opaque one).
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return rgb(getComputedStyle(document.documentElement).backgroundColor)?.c ?? [255,255,255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr,[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || el.value || "").trim().slice(0, 40) + "'";
  const taps = [...document.querySelectorAll("a[href],button,summary,input:not([type=hidden])")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE","svg","SVG"].includes(el.tagName) || el.closest("svg")) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, ground: ground(el), cls: el.className || "", tag: el.tagName, inAction: !!el.closest("a,button,summary,label") });
  }
  const plumGrounds = [...document.querySelectorAll("body *")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor), apply: el.classList.contains("apply") || el.classList.contains("primary") }));
  const b = getComputedStyle(document.body);
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, taps, texts, plumGrounds, body: { color: rgb(b.color).c, bg: ground(document.body) },
    notes: [...document.querySelectorAll(".top-note")].map((el) => rgb(getComputedStyle(el).color).c),
    apply: (() => { const a = [...document.querySelectorAll(".apply,.primary")].filter(visible)[0]; if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })() };
})()`;
const DISABLED = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b.a > 0.5) return b.c; } return [255,255,255]; };
  return [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height > 0).map((b) => { b.disabled = true; const s = getComputedStyle(b); return { el: "button '" + b.textContent.trim().slice(0, 30) + "'", apply: b.classList.contains("apply"), bg: rgb(s.backgroundColor).c, color: rgb(s.color).c, ground: ground(b) }; });
})()`;
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// A fact is what a person reads to decide: the role, its description, the key details, the fit line, a status note, a paragraph.
const FACT = /\b(role|desc|meta|why|note|full|posted)\b/;

Deno.test({
  name: "design (Q544, Q551, Q553, Q557, Q561, Q564, Q575): every Trainee page at phone width, light and dark, measured in Chromium",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the design check needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    const shots = Deno.env.get("DESIGN_SHOTS_DIR"); // optional: where the owner's demo writes the screenshots it measured
    try {
      const all = await pages();
      for (const scheme of ["light", "dark"] as const) {
        const tok: Tokens = scheme === "light" ? LIGHT : DARK;
        for (const width of [320, 390]) {
          const ctx = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
          await ctx.route("**/*", (r: any) => r.abort());
          const pg = await ctx.newPage();
          for (const [name, html] of Object.entries(all)) {
            await t.step(`${name}, ${scheme}, ${width} px`, async () => {
              await pg.setContent(html, { waitUntil: "load" });
              const m = await pg.evaluate(MEASURE);
              const where = `${name} (${scheme}, ${width} px)`;
              const bad: string[] = [];
              const check = (ok: boolean, msg: string) => { if (!ok) bad.push(msg); };
              // Q551
              check(m.scrollW <= m.innerW, `scrolls sideways (${m.scrollW} > ${m.innerW})`);
              for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44 px: ${x.el} ${x.h}px`);
              // Q544
              for (const x of m.texts.filter((x: any) => x.size < 14 || (FACT.test(String(x.cls)) && x.size < 16) || (x.tag === "P" && !x.cls && x.size < 16))) bad.push(`text under the size floor: ${x.el} ${x.size}px`);
              // Q553
              for (const x of m.texts.filter((x: any) => ratio(x.color, x.ground) < 4.5)) bad.push(`text under AA contrast: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
              // Q564/Q565/Q726: the same ground and ink on every page
              check(near(m.body.bg, rgbOf(tok.bg)), `page ground ${m.body.bg} is not the Trainee ground ${tok.bg}`);
              check(near(m.body.color, rgbOf(tok.ink)), `body text ${m.body.color} is not the Trainee ink ${tok.ink}`);
              // Q557/Q575: a plum ground is only ever the primary action; plum text only on a link or button
              const plum = rgbOf(tok.accent);
              for (const x of m.plumGrounds.filter((x: any) => x.bg && x.bg.a > 0.5 && near(x.bg.c, plum) && !x.apply)) bad.push(`plum ground outside the primary action: ${x.el}`);
              for (const x of m.texts.filter((x: any) => near(x.color, plum) && !x.inAction)) bad.push(`plum text outside a link or button: ${x.el}`);
              // Q561
              for (const c of m.notes) check(!near(c, rgbOf(tok.bad), 8), "a routine notice is drawn in the error red");
              // The screenshot itself: the pixels a person sees.
              const png = await pg.screenshot({ fullPage: false });
              if (shots) await Deno.writeFile(`${shots}/${name.replace(/\W+/g, "-")}-${scheme}-${width}.png`, png);
              const img = await decodePng(new Uint8Array(png));
              check(near(img.px(2, img.h - 2), rgbOf(tok.bg)), `screenshot corner ${img.px(2, img.h - 2)} is not the ground ${tok.bg}`);
              if (m.apply && m.apply.y < img.h) {
                const c = img.px(m.apply.x, m.apply.y), edge = img.px(m.apply.x, m.apply.y - 10);
                check(near(c, plum, 6) || near(edge, plum, 6), `the primary action in the screenshot is ${edge}, not the plum ${tok.accent}`);
              }
              // Disabled buttons (the page disables a button while its request runs): still AA against their own ground.
              const dis = await pg.evaluate(DISABLED);
              // ... and visibly muted: a disabled Apply is drawn in the brand's disabled tokens, never still plum.
              for (const x of dis.filter((x: any) => x.apply)) {
                if (!near(x.bg, rgbOf(tok.disabledBg)) || !near(x.color, rgbOf(tok.disabledInk))) bad.push(`disabled Apply not muted: ${x.el} ${x.bg} on ${x.color}`);
              }
              for (const x of dis) if (ratio(x.color, x.ground) < 4.5) bad.push(`disabled button under AA contrast: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
              assertNode.deepStrictEqual(bad, [], where);
            });
          }
          await ctx.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
});
