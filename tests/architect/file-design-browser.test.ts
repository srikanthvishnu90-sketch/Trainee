// The File design system in a real Chromium (owner brief P3, P6; owner colour ruling 2026-11-01 18:27 CT): every shared File part
// (file_design.ts) and the Files that use it, at 390 px, light and dark, measured in the page and in its screenshot.
//   - phone first: no sideways scrolling at 390 px; every tap target at least 44 px tall;
//   - contrast: every visible text at least WCAG AA against the ground it sits on, both schemes;
//   - one card on the warm ground: the page ground is the brand ground, the card is the card token, the title is the serif face;
//   - the verified shade only on a verified value, and every verified value says "Verified"; unknowns drawn as values in the muted
//     metadata colour (never the verified shade, never the action plum);
//   - a caveat sits on the plum-derived tint directly above the rows it qualifies;
//   - the job card's one primary action is its last part, at the bottom of the card;
//   - screenshots: two renders of the same page are pixel-identical (deterministic: no network, fonts aborted, animation off), and
//     pixel thresholds hold (the ground at the corner, the card colour inside the card, the tint inside the caveat, the plum on the
//     action, and plum pixels a small share of the page: plum is for the action only).
// No network: every request is aborted, so the system-font fallback renders. DESIGN_SHOTS_DIR, if set, receives the PNGs.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { DARK, LIGHT, type Tokens } from "../../supabase/functions/_shared/brand.ts";
import { fileShellHtml, jobCardHtml, rowsHtml, sectionHtml, stated, stateHtml, UNKNOWN, unknown, verified } from "../../supabase/functions/_shared/file_design.ts";
import { layout, renderFeed, type Row } from "../../supabase/functions/_shared/file_page.ts";
import { bodyHtml, KIND_CSS, validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";

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

// ---------------------------------------------------------------- the pages: synthetic content only
const NOW = Date.parse("2026-11-01T21:30:00Z");
const PROOF = { from_record: true, title: "Application to Acme", company: "Acme", role: "Data Analyst Intern", destination: "boards.greenhouse.io", status: "confirmed", prepared_at: "2026-10-30T14:00:00Z",
  submitted_at: "2026-10-30T15:04:00Z", as_of: "2026-10-30T15:05:00Z", confirmation: { id: "GH-4471", url: "https://boards.greenhouse.io/acme/confirmation/4471" }, resume: "resume.pdf",
  answers: [{ question: "Years of SQL", answer: "2", source: "From your resume" }], problems: [{ item: "Portfolio link", outcome: "skipped", reason: "You haven't given Trainee a portfolio link." }] };
function proofPage(): string {
  const v = validateKind("application_proof", PROOF, { trusted: true, now: NOW }) as { ok: true; data: unknown };
  const rec: FileRecord = { id: "0a1b2c3d4e", userId: "u", kind: "application_proof", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null };
  return layout("Application to Acme - Trainee", `<div id="root">${fileShellHtml({ made: "Made for Ada · Nov 1, 2026", eyebrow: "Application proof", title: "Application to Acme",
    stamp: "Application record read Nov 1, 2026, 3:30 PM CT", body: bodyHtml(rec, "fs1." + "a".repeat(64), { tz: "America/Chicago" }) })}</div>`, { css: KIND_CSS });
}
function cardsPage(): string {
  const rows = rowsHtml([{ name: "Acme", detail: "Data Analyst Intern · Chicago", value: verified("$32/hr") }, { name: "Globex", detail: "Software Engineer Intern · Remote", value: unknown(UNKNOWN.payNotListed) },
    { name: "Initech", detail: "Analyst Intern", value: unknown(UNKNOWN.closed) }, { name: "Umbrella", detail: "SWE Intern", value: stated("$30/hr") }]);
  const apply = (href: string) => ({ href, label: "Apply" });
  const cards = jobCardHtml({ company: "Acme Analytics", title: "Data Analyst Intern, Summer 2027", logo: null, pay: verified("$32/hr"), location: stated("Chicago, IL"), posted: stated("Oct 30"), fit: "SQL-heavy, in Chicago, above your $30/hr floor.", action: apply("https://boards.greenhouse.io/acme/jobs/1") })
    + jobCardHtml({ company: "Globex", title: "Software Engineer Intern", logo: null, pay: unknown(UNKNOWN.payNotListed), location: unknown(UNKNOWN.locationNotListed), posted: unknown(UNKNOWN.postedNotGiven), fit: null, action: apply("https://jobs.lever.co/globex/2") });
  const body = sectionHtml("Pay at a glance", rows, { caveat: { title: "Two of these aren't verified.", text: "Globex lists no pay and Initech's posting has closed." } }) + sectionHtml("Roles", cards);
  return layout("Your roles - Trainee", `<div id="root">${fileShellHtml({ made: "Made for Ada · Nov 1, 2026", title: "SWE internships in Chicago", stamp: "Postings checked Nov 1, 2026, 3:08–3:25 PM CT", intro: "Found 4 roles; 1 posted this week.", body })}</div>`);
}
function statesPage(): string {
  const body = stateHtml({ kind: "empty", title: "No matching roles yet", reason: "Nothing posted since yesterday matches $30/hr in Chicago.", next: "I check again tonight and message you if one lands." })
    + stateHtml({ kind: "loading", title: "Checking live postings", reason: "Reading 6 boards now.", next: "This page fills in when the check finishes." })
    + stateHtml({ kind: "error", title: "Couldn't reach the job boards", reason: "Greenhouse didn't answer, so nothing new was checked.", next: "Try again in a minute.", retry: { href: "/f", label: "Try again" } });
  return layout("States - Trainee", `<div id="root">${fileShellHtml({ made: "Made for you · Nov 1, 2026", title: "Your roles", stamp: null, body })}</div>`);
}
const job = (n: number) => ({ job_id: `greenhouse:acme:${n}`, company: n === 1 ? "Acme Analytics" : "Globex", title: "Data Analyst Intern", location: "Chicago, IL", url: `https://boards.greenhouse.io/acme/jobs/${n}`, pay: "$32/hr",
  level: null, remote: "hybrid", posted_at: "2026-10-30T12:00:00Z", first_seen_at: "2026-10-30T13:00:00Z", deadline: null, source: "Greenhouse", reasons: ["You named SQL."], company_domain: null }) as any;
const row = (n: number): Row => ({ ref: `ref${n}`, job: job(n), logo: null, snippet: "Build weekly pricing dashboards for the growth team.", full: "Build dashboards.", status: null, tag: "0123456789abcdef",
  resume: "resume.pdf", byHand: false, meta: "Chicago, IL · $32/hr · Greenhouse", metaSrc: "From the posting", why: ["You named SQL."], posted: "Posted 2 d ago (Oct 30)" } as Row);
const feedPage = () => renderFeed({ token: "fs1." + "a".repeat(64), rows: [row(1), row(2)], setHash: "b".repeat(16), setSize: 2, made: "Made for Ada · Nov 1, 2026", stamp: "Postings checked Nov 1, 2026, 3:08–3:25 PM CT" });
const PAGES: Record<string, () => string> = { "application proof": proofPage, "roles and job cards": cardsPage, "empty, loading, error": statesPage, "jobs list": feedPage };

// ---------------------------------------------------------------- measured in the page
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return rgb(getComputedStyle(document.documentElement).backgroundColor)?.c ?? [255,255,255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr,[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || "").trim().slice(0, 40) + "'";
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE"].includes(el.tagName) || el.closest("svg")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), color: rgb(s.color).c, ground: ground(el), verifiedValue: !!el.closest(".v-verified"), unknownValue: !!el.closest(".v-unknown"), inAction: !!el.closest("a,button,summary,label") });
  }
  const taps = [...document.querySelectorAll("a[href],button,summary,input:not([type=hidden])")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const card = document.querySelector(".fcard"), title = document.querySelector("h1");
  const sections = [...document.querySelectorAll(".fsec")].map((s) => { const c = s.querySelector(":scope > .caveat"), r = s.querySelector(":scope > ol.nrows, :scope > .jcard"); return { caveat: c ? { ...box(c), bg: rgb(getComputedStyle(c).backgroundColor).c } : null, rowsTop: r ? box(r).y : null }; });
  const jcards = [...document.querySelectorAll(".jcard")].map((c) => { const a = c.querySelector(".jact"), last = c.lastElementChild; const btn = a ? a.querySelector(".apply") : null; return { last: last ? last.className : "", act: a ? box(a) : null, card: box(c), btn: btn ? { ...box(btn), bg: rgb(getComputedStyle(btn).backgroundColor).c } : null }; });
  const verifiedValues = [...document.querySelectorAll(".v-verified")].map((v) => ({ text: v.textContent, color: rgb(getComputedStyle(v).color).c }));
  const unknownValues = [...document.querySelectorAll(".v-unknown")].map((v) => ({ text: v.textContent.trim(), color: rgb(getComputedStyle(v).color).c }));
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, texts, taps, body: ground(document.body), card: card ? { ...box(card), bg: rgb(getComputedStyle(card).backgroundColor).c } : null,
    titleFont: title ? getComputedStyle(title).fontFamily : "", bodyFont: getComputedStyle(document.body).fontFamily, sections, jcards, verifiedValues, unknownValues };
})()`;
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Every check for one page in one scheme; returns the failures (empty = pass). Exported for the mutation self-test below.
export function judge(m: any, tok: Tokens): string[] {
  const bad: string[] = [];
  const check = (okv: boolean, msg: string) => { if (!okv) bad.push(msg); };
  check(m.scrollW <= m.innerW, `scrolls sideways (${m.scrollW} > ${m.innerW})`);
  for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44 px: ${x.el} ${x.h}px`);
  for (const x of m.texts.filter((x: any) => ratio(x.color, x.ground) < 4.5)) bad.push(`text under AA: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
  check(near(m.body, rgbOf(tok.bg)), `page ground ${m.body} is not ${tok.bg}`);
  check(!!m.card && near(m.card.bg, rgbOf(tok.card)), `the card ${m.card?.bg} is not ${tok.card}`);
  check(/Brygada 1918|Georgia|serif/.test(m.titleFont) && !/Inter/.test(m.titleFont), `title is not the serif display face: ${m.titleFont}`);
  check(/Inter/.test(m.bodyFont) && !/Brygada/.test(m.bodyFont), `body is not the plain sans: ${m.bodyFont}`);
  // The verified shade: only on a verified value; every verified value says so in words.
  for (const x of m.texts.filter((x: any) => near(x.color, rgbOf(tok.verified)) && !x.verifiedValue)) bad.push(`verified shade outside a verified value: ${x.el}`);
  for (const v of m.verifiedValues) { check(near(v.color, rgbOf(tok.verified)), `verified value not in the verified shade: ${v.text}`); check(/\bVerified$/.test(v.text.trim()), `verified value without the word: ${v.text}`); }
  for (const v of m.unknownValues) { check(near(v.color, rgbOf(tok.mute)), `unknown value "${v.text}" not in the metadata colour`); check(!!v.text, "an unknown value with no words"); }
  for (const x of m.texts.filter((x: any) => near(x.color, rgbOf(tok.accent)) && !x.inAction)) bad.push(`plum text outside a link or button: ${x.el}`);
  for (const s of m.sections.filter((s: any) => s.caveat)) {
    check(near(s.caveat.bg, rgbOf(tok.tint)), `caveat panel ${s.caveat.bg} is not the plum tint ${tok.tint}`);
    check(s.rowsTop !== null && s.caveat.y + s.caveat.h <= s.rowsTop + 1 && s.rowsTop - (s.caveat.y + s.caveat.h) < 40, "the caveat is not directly above the rows it qualifies");
  }
  for (const c of m.jcards) {
    check(c.last === "jact", `the job card's last part is ${c.last}, not its one action`);
    check(!!c.btn && c.btn.h >= 44 && c.btn.w >= c.act.w - 1, "the job card's action is a full-width tap target of 44 px or more");
    check(!!c.btn && near(c.btn.bg, rgbOf(tok.accent)), "the job card's action is the plum");
    check(!!c.act && c.card.y + c.card.h - (c.act.y + c.act.h) <= 24, "the action sits at the bottom of the card");
  }
  return bad;
}

Deno.test({
  name: "File design (brief P3, P6; colour ruling 2026-11-01): every File part at 390 px, light and dark, measured in Chromium and in its screenshot",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the File design check needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    const shots = Deno.env.get("DESIGN_SHOTS_DIR");
    try {
      for (const scheme of ["light", "dark"] as const) {
        const tok: Tokens = scheme === "light" ? LIGHT : DARK;
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
        await ctx.route("**/*", (r: any) => r.abort());
        const pg = await ctx.newPage();
        for (const [name, make] of Object.entries(PAGES)) {
          await t.step(`${name}, ${scheme}, 390 px`, async () => {
            const html = make();
            await pg.setContent(html, { waitUntil: "load" });
            const m = await pg.evaluate(MEASURE);
            const bad = judge(m, tok);
            // The screenshot: deterministic, and the pixels say what the page claims.
            const png1 = new Uint8Array(await pg.screenshot({ fullPage: true, animations: "disabled" }));
            await pg.setContent(html, { waitUntil: "load" });
            const png2 = new Uint8Array(await pg.screenshot({ fullPage: true, animations: "disabled" }));
            if (shots) await Deno.writeFile(`${shots}/file-${name.replace(/\W+/g, "-")}-${scheme}-390.png`, png1);
            const a = await decodePng(png1), b = await decodePng(png2);
            let diff = 0;
            for (let y = 0; y < Math.min(a.h, b.h); y += 2) for (let x = 0; x < a.w; x += 2) if (!near(a.px(x, y), b.px(x, y), 0)) diff++;
            if (a.w !== b.w || a.h !== b.h || diff) bad.push(`two renders differ (${a.w}x${a.h} vs ${b.w}x${b.h}, ${diff} sampled pixels)`);
            if (!near(a.px(2, 2), rgbOf(tok.bg))) bad.push(`screenshot corner ${a.px(2, 2)} is not the ground ${tok.bg}`);
            if (m.card && !near(a.px(m.card.x + 24, m.card.y + m.card.h - 8), rgbOf(tok.card))) bad.push(`inside the card ${a.px(m.card.x + 24, m.card.y + m.card.h - 8)} is not ${tok.card}`);
            for (const s of m.sections.filter((s: any) => s.caveat)) if (!near(a.px(s.caveat.x + 4, s.caveat.y + 4), rgbOf(tok.tint))) bad.push(`caveat pixels ${a.px(s.caveat.x + 4, s.caveat.y + 4)} are not the tint ${tok.tint}`);
            for (const c of m.jcards.filter((c: any) => c.btn)) if (!near(a.px(c.btn.x + 12, c.btn.y + c.btn.h / 2), rgbOf(tok.accent), 6)) bad.push(`the action's pixels are not the plum ${tok.accent}`);
            // Plum is for the action: a small share of the page's pixels (threshold 6%).
            let plum = 0, all = 0;
            for (let y = 0; y < a.h; y += 3) for (let x = 0; x < a.w; x += 3) { all++; if (near(a.px(x, y), rgbOf(tok.accent), 6)) plum++; }
            if (plum / all > 0.06) bad.push(`plum covers ${(100 * plum / all).toFixed(1)}% of the page`);
            assertNode.deepStrictEqual(bad, [], `${name} (${scheme})`);
          });
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  },
});

// The checks catch what they claim to: each mutation of a passing measurement is caught (no browser needed).
Deno.test("File design judge: mutations of a good page are each caught", () => {
  const good = { scrollW: 390, innerW: 390, body: rgbOf(LIGHT.bg), card: { x: 20, y: 60, w: 350, h: 600, bg: rgbOf(LIGHT.card) }, titleFont: "\"Brygada 1918\", Georgia, serif", bodyFont: "Inter, sans-serif",
    texts: [{ el: "span.v", color: rgbOf(LIGHT.verified), ground: rgbOf(LIGHT.card), verifiedValue: true, unknownValue: false, inAction: false }, { el: "p", color: rgbOf(LIGHT.ink), ground: rgbOf(LIGHT.card), verifiedValue: false, unknownValue: false, inAction: false }],
    taps: [{ el: "a.apply", h: 48 }], sections: [{ caveat: { x: 40, y: 100, w: 300, h: 50, bg: rgbOf(LIGHT.tint) }, rowsTop: 162 }],
    jcards: [{ last: "jact", act: { x: 40, y: 500, w: 300, h: 48 }, card: { x: 30, y: 300, w: 320, h: 266 }, btn: { x: 40, y: 500, w: 300, h: 48, bg: rgbOf(LIGHT.accent) } }],
    verifiedValues: [{ text: "$32/hr Verified", color: rgbOf(LIGHT.verified) }], unknownValues: [{ text: "Pay not listed", color: rgbOf(LIGHT.mute) }] };
  assertNode.deepStrictEqual(judge(good, LIGHT), []);
  const mut = (f: (m: any) => void) => { const m = structuredClone(good); f(m); return judge(m, LIGHT).length; };
  const cases: [string, (m: any) => void][] = [
    ["sideways scroll", (m) => m.scrollW = 420], ["small tap", (m) => m.taps[0].h = 40], ["low contrast", (m) => m.texts[1].color = [200, 200, 200]],
    ["wrong ground", (m) => m.body = [255, 255, 255]], ["no card", (m) => m.card = null], ["sans title", (m) => m.titleFont = "Inter, sans-serif"],
    ["verified shade off a value", (m) => m.texts[1].color = rgbOf(LIGHT.verified)], ["verified without the word", (m) => m.verifiedValues[0].text = "$32/hr"],
    ["unknown drawn as verified", (m) => m.unknownValues[0].color = rgbOf(LIGHT.verified)], ["plum text", (m) => m.texts[1].color = rgbOf(LIGHT.accent)],
    ["caveat not tinted", (m) => m.sections[0].caveat.bg = rgbOf(LIGHT.card)], ["caveat below its rows", (m) => m.sections[0].rowsTop = 60], ["caveat far from its rows", (m) => m.sections[0].rowsTop = 400],
    ["action not last", (m) => m.jcards[0].last = "jfit"], ["action not at the bottom", (m) => m.jcards[0].card.h = 400], ["small action", (m) => m.jcards[0].btn.h = 40],
  ];
  for (const [what, f] of cases) assertNode.ok(mut(f) > 0, `not caught: ${what}`);
});
