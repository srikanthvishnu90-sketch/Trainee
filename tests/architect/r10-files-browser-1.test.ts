// R10 WO-E part 1 (spec C.1, C.7, C.24, C.25, D): the shared File shell, the nine shared output states and F-05 Roles shortlist,
// measured in Chromium at 390 and 1280 px by the visual checker (r10-files-check.ts). Fails on trunk: file_family.ts does not exist there.
// The checker's own rules are proven by a page that breaks each one (it must report every break).
import assert from "node:assert/strict";
import { familyStatePage, FAMILY_CSS, type StateId } from "../../supabase/functions/_shared/file_family.ts";
import { rolesShortlistPage } from "../../supabase/functions/_shared/file_family_roles.ts";
import { layout } from "../../supabase/functions/_shared/file_page.ts";
import { checkPages, judge, MEASURE, playwright } from "./r10-files-check.ts";
import { CTX, shortlist, TOKEN } from "./r10-files-fixtures.ts";

const kv = (k: string, v: string | null) => ({ k, v, src: v ? { label: "From Trainee's records" } : null });
const target = [kv("Role", "Operations Associate"), kv("Employer", "Example Carbon Co"), kv("Resume", "Operations v3")];
const STATES: Record<StateId, Parameters<typeof familyStatePage>[0]> = {
  loading: { state: "loading", family: "F-05", prior: { label: "Last verified", at: "2026-11-09T15:12:00Z" } },
  empty: { state: "empty", family: "F-05", scope: "9 boards + employer pages, US remote, operations, $80k+ base if listed, checked Nov 9, 2026, 9:40 AM CT", next: { label: "Explore adjacent roles", effect: "decide", href: "?widen=adjacent" } },
  needs_input: { state: "needs_input", family: "F-07", field: { name: "Graduation date", why: "The posting accepts only students graduating Dec 2027 to June 2028, so the application cannot go without it." }, draft: [kv("Resume", "Data analyst one-page draft v3"), kv("Expected graduation", null)], next: { label: "Add graduation date", effect: "decide", href: "?answer=graduation" } },
  prepared: { state: "prepared", family: "F-09", target, next: { label: "Review application", effect: "navigate", href: "?review=A-014" } },
  in_progress: { state: "in_progress", family: "F-09", step: "The reviewed answers were filled on the employer page; the final page has not answered yet.", target },
  uncertain: { state: "uncertain", family: "F-09", target, next: { label: "Check status", effect: "decide", post: { token: TOKEN, action: "checkstatus" } } },
  confirmed: { state: "confirmed", family: "F-09", target, evidence: { quote: "Thanks for applying to Operations Associate (CC-2214).", src: { label: "Employer email", href: "https://jobs.lever.co/examplecarbon/cc-2214", at: "2026-11-09T15:17:00Z" } } },
  error: { state: "error", family: "F-05", recover: { label: "Try again", effect: "decide", href: "?" } },
  expired: { state: "expired", family: "F-05", recover: { label: "Get a new link", effect: "decide", href: "https://t.me/TraineeBot" } },
};
const PAGES: Record<string, () => string> = { "F-05-roles-shortlist": () => rolesShortlistPage(shortlist(), CTX) };
for (const [k, s] of Object.entries(STATES)) PAGES[`state-${k.replace("_", "-")}`] = () => familyStatePage(s, CTX);

Deno.test({ name: "R10 WO-E 1: the File shell, the nine shared states and F-05 pass the visual checker at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false,
  async fn(t) { await checkPages(t, PAGES); } });

// A page that breaks every rule once: the checker must name each break.
Deno.test({ name: "R10 WO-E 1: the visual checker reports each broken rule", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { console.log("NOT_RUN locally: no Playwright"); return; }
  const browser = await pw.chromium.launch({ headless: true, args: Deno.uid?.() === 0 ? ["--no-sandbox"] : [] });
  try {
    const pg = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await pg.route("**/*", (r: any) => r.abort());
    await pg.setContent(layout("Broken", `<div class="ff"><p style="font-size:12px">tiny</p><p style="color:#bbbbbb">faint</p><button></button><div style="width:600px">wide</div>
      <span data-src="external">a claim with no source</span><button data-effect="submit" class="ff-btn ff-sec">Approve submission</button><a data-effect="download" class="ff-btn ff-pri" href="/x">Download</a></div>`, { css: FAMILY_CSS }));
    const bad = judge(await pg.evaluate(MEASURE), 390).join("\n");
    for (const rule of ["scrolls sideways", "text under 14 px", "text under AA", "action without a label", "sourced claim without a source link", "sourced claim without a date", "submit that looks like a preview", "download that does not look like a download"])
      assert.ok(bad.includes(rule), `the checker missed: ${rule}\n${bad}`);
  } finally { await browser.close(); }
} });
