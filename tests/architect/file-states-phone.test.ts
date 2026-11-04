// Presentation fixes for the chat/File pages (draft frontend PR): an empty list says so instead of drawing a blank card, a queued
// row is not drawn in the success colour, the results page has a skip link, and at 360 px the Dismiss control keeps its width
// (it was squeezed to ~32 px beside the "View role" link) while the fixed bottom bar cannot hide a focused control.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { renderFeed } from "../../supabase/functions/_shared/file_page.ts";
import { renderResults, type ResultRow } from "../../supabase/functions/_shared/results_page.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}
const row = (i: number, o: Partial<ResultRow> = {}): ResultRow => ({
  ref: `ref${i}`, job: { job_id: `j${i}`, company: `Co${i}`, title: `Role ${i}`, url: `https://boards.example.test/${i}`, source: "greenhouse", location: "Austin, TX", remote: "hybrid", reasons: [] } as never,
  logo: null, snippet: "", full: null, status: null, tag: null, resume: null, byHand: false, blocked: null, why: [], posted: "Posted 2 d ago",
  payShown: "$30-40/hr", payGroup: "meets", payNote: null, payConv: null, place: "Austin, TX · Hybrid", rid: `R-0${i}`, ...o,
});
const feed = (rows: ResultRow[], o: Record<string, unknown> = {}) => ({ token: "tok", title: "frontend internships", floor: "$30/hr", rows, total: rows.length, filters: { pay: "any" as const, where: "" }, places: [], updated: "Nov 2, 2026, 9:00 AM CT", stamp: null, ...o });

Deno.test("jobs list with no rows: an empty state (what, why, what happens next), not a blank card; with rows there is none", () => {
  const empty = renderFeed({ token: "t", rows: [], setHash: null, setSize: 0 });
  ok(/class="fstate fstate-empty" role="status"/.test(empty) && /No jobs on this list yet/.test(empty) && /What happens next:/.test(empty));
  ok(!/<ul class="rows"><\/ul>/.test(empty), "no empty list element");
  ok(!/Sent|Submitted|Applied/.test(empty.replace(/<style[\s\S]*?<\/style>/g, "").replace(/nothing is sent until/i, "")), "the empty state claims nothing was sent");
  const row1 = { ref: "r1", job: { job_id: "j", company: "Acme", title: "Dev", url: "https://a.example/1", source: "x", location: "", remote: null, reasons: [] }, logo: null, snippet: "s", full: null, status: null, tag: null, resume: null, byHand: false } as never;
  ok(!/fstate-empty/.test(renderFeed({ token: "t", rows: [row1], setHash: null, setSize: 0 })));
});

Deno.test("jobs list: a queued row is not the success colour (nothing has started); submitted and confirmed keep theirs", () => {
  const css = renderFeed({ token: "t", rows: [], setHash: null, setSize: 0 });
  const good = /\.chip\.[^{]*\{color:var\(--good\)\}/.exec(css)![0];
  ok(!/queued/.test(good) && /confirmed/.test(good) && /submitted/.test(good), good);
});

Deno.test("results page: an empty list (total 0) is an empty state without filters or 'Show all 0'; a filtered-out list keeps its widen link", () => {
  const none = renderResults(feed([]));
  ok(/fstate-empty/.test(none) && /No roles on this list yet/.test(none));
  ok(!/Show all 0/.test(none) && !/class="filters"/.test(none));
  const filtered = renderResults({ ...feed([]), total: 4 } as never);
  ok(/No roles match these filters\./.test(filtered) && /Show all 4/.test(filtered) && /class="filters"/.test(filtered));
});

Deno.test("results page: a skip link to the roles is the first thing in the page, and the stylesheet keeps focus clear of the bottom bar and gives Dismiss its own row", () => {
  const html = renderResults(feed([row(1, { tag: "a".repeat(16) })]));
  ok(html.indexOf('<a class="skip" href="#main">Skip to the roles</a>') > 0 && html.indexOf('class="skip"') < html.indexOf("<header class=\"filehead\">"));
  ok(/<main id="main">/.test(html));
  ok(/scroll-padding-bottom:104px/.test(html) && /\.more form\.mark\{flex:1 1 100%\}/.test(html));
});

Deno.test({
  name: "results page at 360 px in Chromium (light and dark): no sideways scroll, Dismiss is a full-width tap target, the skip link appears on focus",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const pw = playwright();
    if (!pw) { if (CI) throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const b = await pw.chromium.launch(chrome ? { executablePath: chrome } : {});
    try {
      for (const scheme of ["light", "dark"]) {
        const ctx = await b.newContext({ viewport: { width: 360, height: 780 }, colorScheme: scheme });
        const p = await ctx.newPage();
        await p.route("**/*", (r: any) => r.abort());
        await p.setContent(renderResults(feed([row(1, { tag: "a".repeat(16) }), row(2)], { madeFor: "Made for Ada" })));
        const m = await p.evaluate(() => {
          const d = document.querySelector("li.card form.mark button") as HTMLElement, f = document.querySelector("li.card form.mark") as HTMLElement;
          return { sw: document.documentElement.scrollWidth, iw: innerWidth, btnH: d.getBoundingClientRect().height, formW: f.getBoundingClientRect().width, pad: getComputedStyle(document.documentElement).scrollPaddingBottom };
        });
        ok(m.sw <= m.iw, `${scheme}: sideways scroll`);
        ok(m.formW > 200 && m.btnH >= 44, `${scheme}: Dismiss form ${m.formW}px wide, ${m.btnH}px tall`);
        ok(m.pad === "104px", `${scheme}: scroll padding ${m.pad}`);
        await p.keyboard.press("Tab");
        const sk = await p.evaluate(() => { const a = document.activeElement as HTMLElement; const r = a.getBoundingClientRect(); return { cls: a.className, x: r.x, w: r.width }; });
        ok(sk.cls === "skip" && sk.x >= 0 && sk.w > 0, `${scheme}: skip link not shown on focus: ${JSON.stringify(sk)}`);
        await ctx.close();
      }
    } finally { await b.close(); }
  },
});
