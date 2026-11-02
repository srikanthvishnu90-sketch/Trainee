// The results page in a real Chromium at phone width, light and dark (reqs Q551, Q553, Q557, Q567, Q568, Q718; owner 2026-11-02):
// the list with a black Apply on every card, What will be sent opened on a card, one tap on Apply, the card turning into its
// status, and the queue row carrying exactly the payload that was shown. Then "Apply to selected" for two roles, and a role that
// isn't ready: Apply opens "A few things first", the answers are saved and the card comes back with its Apply. The page is
// served by trainee-file's handler over the memory world (tests/helpers/results_world.ts) on 127.0.0.1; every other request
// (web fonts, logos) is aborted. Nothing reaches an employer.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { DARK_T, LIGHT_T } from "../../supabase/functions/_shared/results_design.ts";
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
  const ground = (el) => { if (el.closest(".filehead")) return [61,26,77]; for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr,[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || el.value || "").trim().slice(0, 40) + "'";
  const taps = [...document.querySelectorAll("a[href],button,summary,select,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),label.pick,label.opt")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE","OPTION"].includes(el.tagName) || el.closest("svg")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, ground: ground(el) });
  }
  const applies = [...document.querySelectorAll(".apply")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor).c, w: el.getBoundingClientRect().width }));
  const goes = [...document.querySelectorAll("li.card button.apply")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor), fg: rgb(getComputedStyle(el).color), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }));
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, taps, texts, applies, goes, body: ground(document.body), ink: rgb(getComputedStyle(document.body).color).c };
})()`;

Deno.test({
  name: "results page in Chromium (phone width, light and dark): list, black Apply on every card, What will be sent, one tap -> queued with that payload; Apply to selected; A few things first",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the results page browser test needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    if (chrome) { try { Deno.statSync(chrome); } catch { throw Error(`UPMORE_CHROMIUM_PATH is set but ${chrome} does not exist: the browser test cannot run`); } }
    // As root outside CI (a dev box), Chromium's sandbox can't start: run without it rather than skip. CI runs it sandboxed.
    const root = Deno.uid?.() === 0 && !CI;
    let browser: any;
    try {
      browser = await pw.chromium.launch({ headless: true, ...(root ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    } catch (e) {
      throw Error(`Chromium did not start, so the results page was not tested in a browser: ${(e as Error)?.message ?? e}`);
    }
    let steps = 0;
    try {
      for (const scheme of ["light", "dark"] as const) {
        const tok = scheme === "light" ? { bg: LIGHT_T.paper, ink: LIGHT_T.ink } : { bg: DARK_T.paper, ink: DARK_T.ink };
        await t.step(scheme, async () => {
          const w = world();
          const r = await made(w, U, undefined, { name: "Ada", source: "live" });
          const session = await w.A.tok(U, r.listId, NOW);
          const ac = new AbortController();
          const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, (req) => handleFile(req, w.deps));
          const origin = `http://127.0.0.1:${server.addr.port}`;
          const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: scheme, deviceScaleFactor: 1 });
          await ctx.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await ctx.addCookies([{ name: "tf_s", value: session, url: origin }]);
          const pg = await ctx.newPage();
          try {
            const check = async (where: string) => {
              const m = await pg.evaluate(MEASURE), bad: string[] = [];
              if (m.scrollW > m.innerW) bad.push(`scrolls sideways (${m.scrollW} > ${m.innerW})`);
              for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44 px: ${x.el} ${x.h}px`);
              for (const x of m.texts.filter((x: any) => x.size < 14 && !/\.(chip|kicker|eyebrow|rid)\b/.test(x.el))) bad.push(`text under 14 px: ${x.el}`);
              for (const x of m.texts.filter((x: any) => ratio(x.color, x.ground) < 4.5)) bad.push(`text under AA: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
              if (!near(m.body, rgbOf(tok.bg))) bad.push(`ground ${m.body} is not ${tok.bg}`);
              if (!near(m.ink, rgbOf(tok.ink))) bad.push(`ink ${m.ink} is not ${tok.ink}`);
              for (const a of m.applies) if (!near(a.bg, [0, 0, 0], 2)) bad.push(`the action ${a.el} is ${a.bg}, not black`);
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
            assert(sizes[1] >= 24 && sizes[0] < sizes[1] && sizes[2] < sizes[1], `a large title over small lines: ${sizes}`);
            assert(/^Made for Ada · Nov 1, 2026$/.test((await pg.textContent(".made"))!.trim()));
            // A solid black Apply on every card (owner, 2026-11-02), white text, 48px+, full width on a phone; Apply to selected is black too.
            eq(list.goes.length, 3, "an Apply on each card");
            eq(list.applies.length, 4, "three card Applys and Apply to selected, all black");
            assert(list.goes.every((a: any) => a.h >= 48 && near(a.bg.c, [0, 0, 0], 2) && near(a.fg.c, [255, 255, 255], 2)), "black pill, white text, 48px");
            assert(list.goes.every((a: any) => a.w >= 360 - 2 * 14 - 2 * 12 - 4), "each card's Apply is full width on a phone");
            assert(/Pay not listed/.test(await pg.textContent("main") ?? ""));
            // What will be sent, on the card, before the tap.
            const acmeCard = pg.locator("li.card", { hasText: "Acme Web" });
            await acmeCard.getByText("What will be sent").click();
            const sent = await acmeCard.locator("details.send").textContent() ?? "";
            for (const x of ["ada-resume.pdf", "Ada", "ada@example.test", "Are you authorized to work in the US?", "I'd love to build at Acme Web.", "boards.greenhouse.io"]) assert(sent.includes(x), `${x} shown before the tap`);
            await check("the card with What will be sent open");
            eq(w.queue.length, 0, "nothing queued by looking");
            // One tap.
            await acmeCard.getByRole("button", { name: /^Apply to/ }).click();
            await pg.waitForSelector("li.card .chip.queued");
            const acme = await acmeCard.textContent() ?? "";
            assert(/^Queued$/.test((await acmeCard.locator(".chip.queued").textContent())?.trim() ?? "") && /Approved\. It's queued to be sent exactly as its card showed/.test(acme), acme);
            await check("the list after Apply");
            eq(w.queue.length, 1);
            eq(w.queue[0].payload_hash, HASH(1));
            eq(w.queue[0].payload, w.preps.get("greenhouse:acme:1")!.payload, "the queue row carries exactly the payload shown");
            // Apply to selected: tick two, one tap.
            await pg.locator("li.card", { hasText: "Globex" }).getByRole("checkbox").check();
            await pg.locator("li.card", { hasText: "Initech" }).getByRole("checkbox").check();
            await pg.getByRole("button", { name: "Apply to selected" }).click();
            await pg.waitForSelector("text=2 of 2 approved and queued");
            eq(w.queue.map((q) => q.job_id).sort(), ["greenhouse:acme:1", "greenhouse:initech:3", "lever:globex:2"]);
            eq(w.queue.find((q) => q.job_id === "lever:globex:2")!.payload, w.preps.get("lever:globex:2")!.payload);
            // A role that isn't ready: Apply asks the employer's question first; the answer is saved; the card comes back with its Apply.
            const w2 = world({ unprepared: ["greenhouse:acme:1"] });
            w2.qs.push({ id: "11111111-aaaa-4aaa-8aaa-000000000001", key: "job:q1", kind: "text", label: "Will you now or in the future require sponsorship?", type: "select", options: ["Yes", "No"], company: null, job_ids: ["greenhouse:acme:1"], misfit: false, answer: null });
            const r2 = await made(w2, U, undefined, { name: "Ada", source: "live" });
            const s2 = await w2.A.tok(U, r2.listId, NOW);
            const ac2 = new AbortController();
            const server2 = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac2.signal, onListen() {} }, (req) => handleFile(req, w2.deps));
            const origin2 = `http://127.0.0.1:${server2.addr.port}`;
            await ctx.route("**/*", (route: any) => route.request().url().startsWith(origin) || route.request().url().startsWith(origin2) ? route.continue() : route.abort());
            await ctx.addCookies([{ name: "tf_s", value: s2, url: origin2 }]);
            try {
              await pg.goto(`${origin2}/file`);
              await pg.locator("li.card", { hasText: "Acme Web" }).getByRole("button", { name: /^Apply to/ }).click();
              await pg.waitForSelector("text=A few things first");
              await check("the questions page");
              eq(w2.queue.length, 0, "asking sends nothing");
              await pg.getByLabel("No", { exact: true }).check();
              await pg.getByRole("button", { name: "Save answers" }).click();
              await pg.waitForSelector("li.card >> text=What will be sent");
              eq(w2.saved, [{ id: "11111111-aaaa-4aaa-8aaa-000000000001", answer: "No" }]);
              eq(w2.queue.length, 0, "answering sends nothing");
              await check("the list with the fresh card");
            } finally {
              ac2.abort();
              await server2.finished;
            }
            steps++;
          } finally {
            await ctx.close();
            ac.abort();
            await server.finished;
          }
        });
      }
      // Both schemes really ran to the end (a silent skip is a failure, not a pass).
      eq(steps, 2, "light and dark both ran the whole flow");
    } finally {
      await browser.close();
    }
  },
});
