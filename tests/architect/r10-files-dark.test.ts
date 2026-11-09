// R10 WO-E: dark mode, measured. Every File family page (and the live roles page, open and paused) rendered with the person's
// device in dark mode (prefers-color-scheme: dark), judged by the same visual checker rules as light (r10-files-check.ts): no
// overflow, phone text >= 14px, AA contrast on the ground it sits on, every action labelled, sourced claims linked and dated.
import { CI, judge, MEASURE, playwright } from "./r10-files-check.ts";
import { FILE_FAMILIES } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { FILE_ROUTES } from "../../supabase/functions/_shared/file_routes.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { feed } from "./r10-files-fixtures-live.ts";

const PAGES: Record<string, () => string> = Object.fromEntries(FILE_FAMILIES.map((f) => [`${f.id}-dark`, () => f.page()]));
PAGES["F-05-live-dark"] = () => liveShortlistPage(feed(), { ...CTX, routes: FILE_ROUTES });
PAGES["F-05-live-paused-dark"] = () => liveShortlistPage(feed({ paused: true }), { ...CTX, routes: FILE_ROUTES });

Deno.test({ name: "R10 dark mode: every File family passes the visual checker in dark mode at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the R10 File checker needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  try {
    for (const width of [390, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });
      await ctx.route("**/*", (r: { abort(): Promise<void> }) => r.abort()); // no network: the page carries everything it needs
      const pg = await ctx.newPage();
      for (const [name, make] of Object.entries(PAGES)) {
        await t.step(`${name}, ${width} px`, async () => {
          await pg.setContent(make(), { waitUntil: "load" });
          if (await pg.evaluate("matchMedia('(prefers-color-scheme: dark)').matches") !== true) throw Error("not in dark mode");
          const bad = judge(await pg.evaluate(MEASURE), width);
          if (bad.length) throw Error(`${name} at ${width} px:\n  ${bad.join("\n  ")}`);
        });
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
} });
