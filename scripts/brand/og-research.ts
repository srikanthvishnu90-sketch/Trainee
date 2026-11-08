// Renders the research brief's link-preview card (supabase/functions/_shared/research_og.ts) to og-research.png at the repo root
// (served at the site root, next to og-file.png). Run after a brand change:
//   UPMORE_PLAYWRIGHT_PATH=/path/to/node_modules/playwright deno run -A scripts/brand/og-research.ts [--offline]
// --offline aborts every request (the fonts fall back to Georgia and the system sans), for a sandbox without network.
import { createRequire } from "node:module";
import { RESEARCH_OG_FILE, RESEARCH_OG_SIZE, researchOgCardHtml } from "../../supabase/functions/_shared/research_og.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const pwPath = Deno.env.get("UPMORE_PLAYWRIGHT_PATH") ?? `${ROOT}tools/node_modules/playwright`;
const pw = createRequire(import.meta.url)(pwPath);
const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 ? { args: ["--no-sandbox"] } : {}) });
try {
  const ctx = await browser.newContext({ viewport: RESEARCH_OG_SIZE, deviceScaleFactor: 1 });
  if (Deno.args.includes("--offline")) await ctx.route("**/*", (r: any) => r.abort());
  const page = await ctx.newPage();
  await page.setContent(researchOgCardHtml(), { waitUntil: "load" });
  await Deno.writeFile(`${ROOT}${RESEARCH_OG_FILE}`, new Uint8Array(await page.screenshot({ type: "png", clip: { x: 0, y: 0, ...RESEARCH_OG_SIZE } })));
  console.log(`wrote ${RESEARCH_OG_FILE}`);
} finally { await browser.close(); }
