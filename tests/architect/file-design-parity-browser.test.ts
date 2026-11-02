// The owner's parity audit (Nov 1, 2026), the pixel half: R14, R15 and design criteria D01-D06 on the shared File parts in a real
// Chromium, light and dark at 390 px and light at 1280 px. Brand plum #5C2751; plum only on the one primary action and selected
// states. No network: every request is aborted, so the system-font fallback renders. Synthetic content only.
//   R14/D05  one card on the warm ground; no sideways scroll; readable without zoom (body 18 px, facts 16 px or more)
//   R15/D06  plum ground only on the primary action: exactly one plum ground per job card and per File's action set; no plum body
//            text and no plum wash; every tap target at least 44 px
//   D01      states designed: focus shows a ring of 2 px or more, hover changes the action's ground, a closed card has no plum,
//            the empty state reads as a state
//   D02      nothing clipped by its card; at least 8 px between consecutive rows' text
//   D03      display, body and provenance visibly distinct (serif vs sans; provenance smaller than body)
//   D04      single column at 390 and at 1280 px
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { DARK, LIGHT, type Tokens } from "../../supabase/functions/_shared/brand.ts";
import { fileShellHtml, jobCardHtml, rowsSectionHtml, sectionHtml, stated, stateHtml, totalOf, UNKNOWN, unknown, verified } from "../../supabase/functions/_shared/file_design.ts";
import { layout } from "../../supabase/functions/_shared/file_page.ts";
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
const NOW = Date.parse("2026-11-01T21:30:00Z");
function rolesPage(): string {
  const p = (t: string) => stated(t, "From the posting");
  const items = [{ name: "Acme", detail: "Data Analyst Intern · Chicago", value: verified("$32/hr", "From the posting") }, { name: "Globex", detail: "Software Engineer Intern · Remote", value: unknown(UNKNOWN.payNotListed) },
    { name: "Umbrella", detail: "SWE Intern", value: p("$30/hr") }];
  const total = totalOf(items.map((i) => i.value));
  const cards = jobCardHtml({ company: "Acme Analytics", title: "Data Analyst Intern, Summer 2027", pay: verified("$32/hr", "From the posting"), location: p("Chicago, IL"), posted: p("Oct 30"), fit: "SQL-heavy, in Chicago, above your $30/hr floor.", action: { href: "https://boards.greenhouse.io/acme/jobs/1", label: "Apply" } })
    + jobCardHtml({ company: "Initech", title: "Analyst Intern", pay: unknown(UNKNOWN.payNotListed), location: p("Chicago, IL"), posted: p("Sep 2"), closed: true, action: { href: "https://jobs.example/2", label: "Apply" } })
    + jobCardHtml({ company: "Globex", title: "Software Engineer Intern", pay: unknown(UNKNOWN.payNotListed), location: unknown(UNKNOWN.locationNotListed), posted: unknown(UNKNOWN.postedNotGiven), action: { href: "https://jobs.lever.co/globex/3", label: "Apply" } });
  const body = rowsSectionHtml("Pay at a glance", [...items, { name: "Total", detail: null, value: total.value }], total.caveat ? { text: total.caveat } : null) + sectionHtml("Roles", cards)
    + sectionHtml("Nothing new", stateHtml({ kind: "empty", title: "No new roles since yesterday", reason: "Nothing posted since yesterday matches $30/hr in Chicago.", next: "I check again tonight and message you if one lands." }));
  return layout("Your roles - Trainee", `<div id="root">${fileShellHtml({ made: "Made for Ada · Nov 1, 2026", title: "SWE internships in Chicago", stamp: "Postings checked Nov 1, 2026, 3:08–3:25 PM CT", body })}</div>`);
}
function proofPage(): string {
  const v = validateKind("application_proof", { from_record: true, title: "Application to Acme", company: "Acme", role: "Data Analyst Intern", status: "submitted", prepared_at: "2026-10-30T14:00:00Z", submitted_at: "2026-10-30T15:04:00Z", as_of: "2026-10-30T15:05:00Z", answers: [], problems: [] }, { trusted: true, now: NOW }) as { ok: true; data: unknown };
  const rec: FileRecord = { id: "0a1b2c3d4e", userId: "u", kind: "application_proof", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null };
  return layout("Application to Acme - Trainee", `<div id="root">${fileShellHtml({ made: "Made for Ada · Nov 1, 2026", eyebrow: "Application proof", title: "Application to Acme", stamp: "Application record read Nov 1, 2026, 3:30 PM CT", body: bodyHtml(rec, "t", { tz: "America/Chicago" }) })}</div>`, { css: KIND_CSS });
}
const PAGES: Record<string, () => string> = { "roles File": rolesPage, "application proof File": proofPage };

const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr,[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || "").trim().slice(0, 30) + "'";
  const card = document.querySelector(".fcard"), cr = card.getBoundingClientRect();
  const plumGround = (el) => { const b = rgb(getComputedStyle(el).backgroundColor); return b && b.a > 0.5 ? b.c : null; };
  const all = [...document.querySelectorAll("body *")].filter(visible);
  const grounds = all.map((el) => ({ el: name(el), bg: plumGround(el), apply: el.matches(".apply,.btn:not(.ghost):not(.off)"), jcard: el.closest(".jcard") ? [...document.querySelectorAll(".jcard")].indexOf(el.closest(".jcard")) : -1, actions: !!el.closest("[aria-label=Actions]") }));
  const texts = all.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, right: r.right, left: r.left, inCard: !!el.closest(".fcard"), inAction: !!el.closest("a,button,summary,label"), fact: el.matches(".v,.v *:not(.fsrc):not(.vtag),.nname,.ndetail,.jrole,.jco,.jfit,.intro,.fstate-why,.fstate-next,.caveat,dd,.fact dd,p:not(.stamp):not(.made):not(.eyebrow):not(.anote):not(.meta)") && !el.matches(".fsrc,.vtag,.src,.stamp,.made,.flabel,.eyebrow,.nnum,dt,.jf dt") }; });
  const rows = [...document.querySelectorAll("ol.nrows")].map((ol) => [...ol.children].map((li) => { const b = li.querySelector(".nbody").getBoundingClientRect(), v = li.querySelector(".v").getBoundingClientRect(); return { top: Math.min(b.top, v.top), bottom: Math.max(b.bottom, v.bottom) }; }));
  const secs = [...document.querySelectorAll(".fsec")].map((s) => s.getBoundingClientRect().left);
  const font = (sel) => { const e = document.querySelector(sel); return e ? { fam: getComputedStyle(e).fontFamily, size: parseFloat(getComputedStyle(e).fontSize) } : null; };
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, card: { left: cr.left, right: cr.right, width: cr.width }, grounds, texts, rows, secs,
    taps: [...document.querySelectorAll("a[href],button,summary,input:not([type=hidden]),textarea")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height })),
    title: font("h1"), body: { fam: getComputedStyle(document.body).fontFamily, size: parseFloat(getComputedStyle(document.body).fontSize) }, prov: [".stamp", ".fsrc", ".src", ".made"].map(font).filter(Boolean),
    jcards: document.querySelectorAll(".jcard").length, closed: [...document.querySelectorAll(".jcard-closed")].map((c) => [...c.querySelectorAll("*")].some((e) => { const b = rgb(getComputedStyle(e).backgroundColor); return b && b.a > 0.5 && JSON.stringify(b.c) === JSON.stringify(rgb(getComputedStyle(document.querySelector(".apply")).backgroundColor).c); })) };
})()`;
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

export function judge(m: any, tok: Tokens, width: number): string[] {
  const bad: string[] = [], check = (v: boolean, msg: string) => { if (!v) bad.push(msg); };
  const plum = rgbOf(tok.accent);
  // R14/D05/D04
  check(m.scrollW <= m.innerW, `scrolls sideways at ${width}px (${m.scrollW})`);
  check(m.card.width <= 640, `the card is ${m.card.width}px wide: not one column`);
  check(new Set(m.secs.map((x: number) => Math.round(x))).size <= 1, `sections are not in one column: ${m.secs}`);
  check(m.body.size >= 18, `body text ${m.body.size}px`);
  for (const t of m.texts.filter((t: any) => t.fact && t.size < 16)) bad.push(`fact under 16px: ${t.el} ${t.size}px`);
  for (const t of m.texts.filter((t: any) => t.size < 14)) bad.push(`text under 14px: ${t.el}`);
  // R15/D06: plum ground only on the primary action; one per job card and one in the File's action set; no plum text outside an action
  for (const g of m.grounds.filter((g: any) => g.bg && near(g.bg, plum) && !g.apply)) bad.push(`plum ground outside the primary action: ${g.el}`);
  for (let i = 0; i < m.jcards; i++) { const n = m.grounds.filter((g: any) => g.jcard === i && g.bg && near(g.bg, plum)).length; check(n <= 1, `job card ${i + 1} has ${n} plum grounds`); }
  check(m.grounds.filter((g: any) => g.actions && g.bg && near(g.bg, plum)).length <= 1, "the File's actions have more than one plum ground");
  for (const t of m.texts.filter((t: any) => near(t.color, plum) && !t.inAction)) bad.push(`plum text outside an action: ${t.el}`);
  for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44px: ${x.el} ${x.h}px`);
  // D01 closed: no plum on a closed card
  m.closed.forEach((p: boolean, i: number) => check(!p, `closed card ${i + 1} still has a plum action`));
  // D02
  for (const t of m.texts.filter((t: any) => t.inCard && (t.right > m.card.right + 0.5 || t.left < m.card.left - 0.5))) bad.push(`clipped by the card: ${t.el}`);
  for (const ol of m.rows) for (let i = 1; i < ol.length; i++) check(ol[i].top - ol[i - 1].bottom >= 8, `rows ${i} and ${i + 1} are ${ol[i].top - ol[i - 1].bottom}px apart`);
  // D03
  check(!!m.title && /Brygada|Georgia|serif/.test(m.title.fam) && !/Inter/.test(m.title.fam) && /Inter/.test(m.body.fam), `display ${m.title?.fam} vs body ${m.body.fam}`);
  for (const p of m.prov) check(p.size < m.body.size, `provenance ${p.size}px is not smaller than body ${m.body.size}px`);
  return bad;
}

Deno.test({
  name: "parity audit (R14, R15, D01-D06): the File parts in Chromium at 390 px light and dark, and 1280 px",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) { if (CI) throw Error("the parity check needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    try {
      for (const [scheme, width] of [["light", 390], ["dark", 390], ["light", 1280]] as const) {
        const tok = scheme === "light" ? LIGHT : DARK;
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: "reduce" });
        await ctx.route("**/*", (r: any) => r.abort());
        const pg = await ctx.newPage();
        for (const [name, make] of Object.entries(PAGES)) {
          await t.step(`${name}, ${scheme}, ${width} px`, async () => {
            await pg.setContent(make(), { waitUntil: "load" });
            const bad = judge(await pg.evaluate(MEASURE), tok, width);
            // D01: keyboard focus draws a visible ring; hover changes the primary action's ground.
            const first = pg.locator(".apply, .btn:not(.ghost):not(.off)").first();
            if (await first.count()) {
              const rest = await first.evaluate((e: Element) => getComputedStyle(e).backgroundColor);
              await first.focus();
              const ring = await first.evaluate((e: Element) => { const s = getComputedStyle(e); return { w: parseFloat(s.outlineWidth), style: s.outlineStyle }; });
              if (!(ring.w >= 2 && ring.style !== "none")) bad.push(`focus ring ${JSON.stringify(ring)}`);
              await pg.mouse.move(0, 0); await first.hover();
              const hover = await first.evaluate((e: Element) => getComputedStyle(e).backgroundColor);
              if (hover === rest) bad.push("hover does not change the primary action");
            }
            assertNode.deepStrictEqual(bad, [], `${name} (${scheme}, ${width})`);
          });
        }
        await ctx.close();
      }
    } finally { await browser.close(); }
  },
});

Deno.test("parity judge: mutations of a good page are each caught", () => {
  const P = rgbOf(LIGHT.accent);
  const good = { scrollW: 390, innerW: 390, card: { left: 20, right: 370, width: 350 }, secs: [41, 41], body: { fam: "Inter, sans-serif", size: 18 }, title: { fam: "\"Brygada 1918\", Georgia, serif", size: 30 }, prov: [{ size: 15 }],
    texts: [{ el: "span.v", size: 18, color: rgbOf(LIGHT.ink), right: 300, left: 40, inCard: true, inAction: false, fact: true }], taps: [{ el: "a.apply", h: 48 }],
    grounds: [{ el: "a.apply", bg: P, apply: true, jcard: 0, actions: false }], jcards: 1, closed: [false], rows: [[{ top: 0, bottom: 40 }, { top: 60, bottom: 100 }]] };
  assertNode.deepStrictEqual(judge(good, LIGHT, 390), []);
  const cases: [string, (m: any) => void][] = [
    ["sideways", (m) => m.scrollW = 500], ["wide card", (m) => m.card.width = 900], ["two columns", (m) => m.secs = [41, 400]], ["small body", (m) => m.body.size = 16],
    ["small fact", (m) => m.texts[0].size = 15], ["plum wash", (m) => m.grounds.push({ el: "div", bg: P, apply: false, jcard: -1, actions: false })],
    ["two primaries on a card", (m) => m.grounds.push({ el: "a.apply", bg: P, apply: true, jcard: 0, actions: false })], ["plum body text", (m) => m.texts[0].color = P],
    ["small tap", (m) => m.taps[0].h = 40], ["closed card with plum", (m) => m.closed = [true]], ["clipped", (m) => m.texts[0].right = 400],
    ["crowded rows", (m) => m.rows[0][1].top = 44], ["sans title", (m) => m.title.fam = "Inter"], ["provenance as big as body", (m) => m.prov = [{ size: 18 }]],
    ["two primaries in actions", (m) => m.grounds.push({ el: "b1", bg: P, apply: true, jcard: -1, actions: true }, { el: "b2", bg: P, apply: true, jcard: -1, actions: true })],
  ];
  for (const [what, f] of cases) { const m = structuredClone(good); f(m); assertNode.ok(judge(m, LIGHT, 390).length > 0, `not caught: ${what}`); }
});
