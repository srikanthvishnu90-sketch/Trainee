// R10 WO-E, the S2 review of #631: a green "confirmed" needs the same proof as a sourced claim (an https link and a time); an error
// says nothing was sent only with the caller's proof; every link a File draws is http(s) or this site's own (never javascript:,
// data: or a protocol-relative //host); the check mark draws under trainee-file's real CSP (no data: image); F-05 writes
// "location unknown" and counts only roles you could still act on as open.
import assert from "node:assert/strict";
import { actHtml, familyBodyHtml, FAMILY_CSS, familyStateHtml, safeHref, type FamilyFile } from "../../supabase/functions/_shared/file_family.ts";
import { layout } from "../../supabase/functions/_shared/file_page.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { rolesShortlistPage } from "../../supabase/functions/_shared/file_family_roles.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { CI, playwright } from "./r10-files-check.ts";
import { CTX, role, shortlist } from "./r10-files-fixtures.ts";
import { signedIn } from "./file-session-fakes.ts";

const QUOTE = "Thanks for applying to Operations Associate (CC-2214).";

Deno.test("S2-1: \"Submitted - confirmed\" turns green only with an https link and a time, the test claimHtml uses", () => {
  const conf = (src: Record<string, unknown>) => familyStateHtml({ state: "confirmed", family: "F-09", evidence: { quote: QUOTE, src: { label: "Employer email", ...src } } }, CTX);
  for (const src of [{ external: true, at: "2026-11-09T15:17:00Z" }, { href: "https://jobs.lever.co/x/receipt" }, { href: "http://jobs.lever.co/x/receipt", at: "2026-11-09T15:17:00Z" }, { href: "javascript:alert(1)", at: "2026-11-09T15:17:00Z" }]) {
    const h = conf(src);
    assert.doesNotMatch(h, /Submitted - confirmed/, JSON.stringify(src)); assert.match(h, /Not confirmed yet/, JSON.stringify(src));
  }
  assert.match(conf({ href: "https://jobs.lever.co/x/receipt", at: "2026-11-09T15:17:00Z" }), /Submitted - confirmed/);
});

Deno.test("S2-2: an error says nothing was changed or sent, and that typing is kept, only with the caller's proof", () => {
  const plain = familyStateHtml({ state: "error", family: "F-09" }, CTX);
  assert.doesNotMatch(plain, /Nothing was changed and nothing was sent/); assert.doesNotMatch(plain, /Anything you typed here is kept/);
  assert.match(plain, /It is not known yet whether anything changed/);
  const proved = familyStateHtml({ state: "error", family: "F-09", nothingSent: true }, CTX);
  assert.match(proved, /Nothing was changed and nothing was sent\./); assert.match(proved, /Anything you typed here is kept\./);
});

Deno.test("S2-3: back, segment and action links are http(s) or this site's own; javascript:, data: and //host are refused", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "//evil.example/f", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "vbscript:x"]) {
    assert.equal(safeHref(bad), null, bad);
    const f: FamilyFile = { family: "F-05", back: bad, hero: null, title: "t", segments: [{ label: "All", n: 1, href: bad }], blocks: [], actions: { primary: { label: "Go", effect: "navigate", href: bad } } };
    const h = familyBodyHtml(f, CTX);
    assert.ok(!h.includes(`href="${bad.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`), `${bad} reached an href`);
    assert.doesNotMatch(h, /aria-label="Back"/, `${bad}: no back link`);
    assert.match(actHtml({ label: "Go", effect: "navigate", href: bad }), /disabled/, `${bad}: the action is off`);
  }
  for (const good of ["/f", "?pay=meets", "#r-ref1", "https://boards.greenhouse.io/x/jobs/1"]) assert.equal(safeHref(good), good, good);
  const ok = familyBodyHtml({ family: "F-05", back: "/f", hero: null, title: "t", segments: [{ label: "All", n: 1, href: "?state=ready" }], blocks: [] }, CTX);
  assert.match(ok, /<a class="ff-sq" href="\/f" aria-label="Back">/); assert.match(ok, /<a href="\?state=ready"/);
});

Deno.test("S2-5: F-05 writes \"location unknown\" in words, and never counts blocked or uncertain roles as open", () => {
  const f = shortlist();
  f.rows = [role(1, { place: "" }), role(2, { blocked: "your state may be excluded", restriction: "Location restriction" }), role(3, { status: { word: "unknown", detail: "The final page timed out." } } as never), role(4)];
  const h = rolesShortlistPage(f, CTX);
  assert.match(h, /location unknown/); assert.doesNotMatch(h, /Location not listed/);
  assert.match(h, /Example Solar Co - 2 open roles/);
});

// S2-4: the check mark is drawn by CSS, so it shows under the CSP trainee-file sends with every page (img-src does not allow data:).
Deno.test({ name: "S2-4: a File's check marks draw under trainee-file's real Content-Security-Policy, with no violation", sanitizeResources: false, sanitizeOps: false, async fn() {
  assert.doesNotMatch(FAMILY_CSS, /url\(\s*["']?data:/i, "no data: image in the File CSS");
  const A = signedIn(), env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const svc = createFileService({ store: memoryFileStore(), env: { get: (k) => env[k] }, now: () => CTX.now });
  const d = { ...A.deps, store: { async recallList() { return null; }, async recall() { return null; } } as unknown as FileStore, now: () => CTX.now, env: { get: (k: string) => env[k] },
    cards: { async open() { return null; } }, tap: {} as never, files: svc } as unknown as FileDeps;
  const csp = (await handleFile(new Request("https://trainee.example/file"), d)).headers.get("content-security-policy");
  assert.ok(csp && /img-src/.test(csp), `the handler's CSP: ${csp}`);
  const pw = playwright();
  if (!pw) { if (CI) throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const page = (checks: boolean) => layout("Check", familyBodyHtml({ family: "F-01", hero: null, title: "t", blocks: [{ b: "card", label: "First actions", parts: checks ? [{ p: "check", items: [{ state: "done", text: "Read your resume" }, { state: "met", text: "US remote" }] }] : [{ p: "text", text: "No checks." }] }] }, CTX), { css: FAMILY_CSS });
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }) });
  try {
    // The page shell's own favicon (brand.ts, every trainee-file page) is the baseline; the File's check marks must add nothing to it.
    const violations = async (html: string) => {
      const pg = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      await pg.addInitScript("window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));");
      await pg.route("https://trainee.example/file", (r: { fulfill(o: unknown): Promise<void> }) => r.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp! }, body: html }));
      await pg.route(/^(?!https:\/\/trainee\.example\/file$).*/, (r: { abort(): Promise<void> }) => r.abort());
      await pg.goto("https://trainee.example/file");
      await pg.waitForTimeout(200);
      return { pg, v: (await pg.evaluate("window.__csp") as string[]).filter((x) => /^img-src/.test(x)) };
    };
    const base = await violations(page(false)), withChecks = await violations(page(true)), pg = withChecks.pg;
    assert.deepEqual(withChecks.v, base.v, `the check marks were blocked by the CSP: ${withChecks.v.join("; ")}`);
    const mark = await pg.evaluate(`(() => { const b = document.querySelector('.ff-ck-done .ff-box'); const s = getComputedStyle(b, '::after'); return { content: s.content, w: s.borderRightWidth, color: s.borderRightColor }; })()`) as { content: string; w: string; color: string };
    assert.equal(mark.content, '""'); assert.notEqual(mark.w, "0px"); assert.equal(mark.color, "rgb(255, 255, 255)");
  } finally { await browser.close(); }
} });
