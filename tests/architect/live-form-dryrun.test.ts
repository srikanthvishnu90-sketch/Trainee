// R4 of the test ladder (docs/architect/TEST-STRATEGY-2026-11-01.md): scripts/launch/live-form-dryrun.ts fills real public
// application forms up to the submit button and never presses it. Proven here on local employer pages (the Greenhouse, Lever
// and Ashby dry-run fixtures, tests/fixtures/apply-dryrun) that report to their own server every press of their submit
// button (pointerdown, before any click handler), every Enter in a field, and every request a submission would make (the
// Greenhouse fixture's form is method="get", so a submission is a GET the network policy alone would let through):
//   - the dry run fills the synthetic facts, finds the submit control, screenshots, and the employer saw no press, no Enter,
//     no submission and no POST;
//   - the guard bites: pressing the submit button, form.requestSubmit() and Enter in a field are each cancelled and counted,
//     and a page that submits itself while it is filled ends the run as submit_attempt (a FAIL), with nothing sent;
//   - drift is reported: a form without its resume upload, and a field set that differs from the baseline;
//   - the script's own source has no click, press, tap, keyboard or submit call.
// Run: deno test -A --no-check tests/architect/live-form-dryrun.test.ts (needs Chromium: UPMORE_PLAYWRIGHT_PATH, UPMORE_CHROMIUM_PATH).
import assertNode from "node:assert/strict";
import { dryRunLiveForm, loadPlaywright, schemaOf, SUBMIT_GUARD, SYNTHETIC_FACTS, syntheticFactsProblem } from "../../scripts/launch/live-form-dryrun.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url);
const FX = new URL("tests/fixtures/apply-dryrun/", ROOT);

// The employer's own reporting: a press of the submit button and an Enter in a field are sent home by GET before anything
// else on the page can see them (our guard listens for click and submit, not pointerdown or keydown).
const SPY = `<script>
document.addEventListener("pointerdown", (e) => { const b = e.target.closest('button[type="submit"], input[type="submit"]'); if (b) new Image().src = "/__pressed"; }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Enter") new Image().src = "/__enter"; }, true);
// Every value typed into a text field is reported home, so the test sees exactly what reached the employer's page.
document.addEventListener("change", (e) => { const t = e.target; if (t && t.matches && t.matches('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea') && t.value) new Image().src = "/__value?v=" + encodeURIComponent(t.value); }, true);
document.addEventListener("input", (e) => { const t = e.target; if (t && t.matches && t.matches('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea') && t.value) new Image().src = "/__value?v=" + encodeURIComponent(t.value); }, true);
</script>`;
// A page whose own scripts send what is typed, the way real application pages autosave: fetch POST, XHR POST and a beacon,
// on load and on every input.
const BACKGROUND = `<!doctype html><html><body><form method="post" action="/bg/submit"><label for="fn">First Name</label><input id="fn" name="first_name" type="text" required>
<label for="em">Email</label><input id="em" name="email" type="email" required><label for="rs">Resume/CV</label><input id="rs" name="resume" type="file" required>
<button type="submit">Submit application</button></form>
<script>
const send = (why) => {
  fetch("/bg/fetch?" + why, { method: "POST", body: JSON.stringify({ why, v: document.getElementById("em").value }) }).catch(() => {});
  try { const x = new XMLHttpRequest(); x.open("POST", "/bg/xhr?" + why); x.send(document.getElementById("fn").value); } catch {}
  try { navigator.sendBeacon("/bg/beacon?" + why, "v=" + document.getElementById("em").value); } catch {}
  fetch("/bg/put?" + why, { method: "PUT", body: "x" }).catch(() => {});
};
send("load");
document.addEventListener("input", () => send("input"), true);
</script></body></html>`;
// A page that installs a service worker which, once it controls the page, sends a POST of its own (on activate and for a
// request the page makes): a request a service worker makes is not the page's, so the page's route alone may not see it.
const SW_PAGE = `<!doctype html><html><body><form method="post" action="/sw/submit"><label for="em">Email</label><input id="em" name="email" type="email" required>
<label for="rs">Resume/CV</label><input id="rs" name="resume" type="file" required><button type="submit">Submit application</button></form>
<script>
(async () => {
  if (!("serviceWorker" in navigator)) { new Image().src = "/__sw?none"; return; }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    new Image().src = "/__sw?registered";
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => { navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }); setTimeout(r, 3000); });
    await fetch("/sw-trigger").catch(() => {});
  } catch (e) { new Image().src = "/__sw?refused"; }
})();
</script></body></html>`;
const SW_JS = `self.addEventListener("install", (e) => { e.waitUntil(fetch("/__sw?worker-ran").catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil((async () => { await self.clients.claim(); await fetch("/sw/leak-activate", { method: "POST", body: "from the worker" }).catch(() => {}); })()));
self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname === "/sw-trigger") e.respondWith(fetch("/sw/leak-fetch", { method: "POST", body: "from the worker" }).catch(() => new Response("blocked"))); });`;
const AUTOSUBMIT = `<!doctype html><html><body><form id="f" method="get" action="/auto/submit"><label for="em">Email</label><input id="em" name="email" type="email" required>
<label for="rs">Resume/CV</label><input id="rs" name="resume" type="file" required><button type="submit">Submit application</button></form>
<script>document.getElementById("em").addEventListener("input", function () { this.form.requestSubmit(); });</script></body></html>`;
const NO_RESUME = `<!doctype html><html><body><form method="post" action="/noresume/submit"><label for="fn">First Name</label><input id="fn" name="first_name" type="text" required>
<label for="em">Email</label><input id="em" name="email" type="email" required><button type="submit">Submit application</button></form></body></html>`;

function employer() {
  const seen = { pressed: 0, enter: 0, posts: [] as string[], submissions: [] as string[], values: [] as string[], sw: [] as string[] };
  const files: Record<string, string> = { "/greenhouse": "greenhouse-acme.html", "/lever": "lever-acme.html", "/ashby": "ashby-acme.html" };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") { seen.posts.push(`${req.method} ${u.pathname}`); return new Response("posted"); }
    if (u.pathname === "/__pressed") { seen.pressed++; return new Response(""); }
    if (u.pathname === "/__enter") { seen.enter++; return new Response(""); }
    if (u.pathname === "/__value") { seen.values.push(u.searchParams.get("v") ?? ""); return new Response(""); }
    if (u.pathname === "/__sw") { seen.sw.push(u.search.slice(1)); return new Response(""); }
    if (u.pathname === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript", "service-worker-allowed": "/" } });
    if (u.pathname === "/background") return new Response(BACKGROUND, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/serviceworker") return new Response(SW_PAGE, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/widgets.js") return new Response(await Deno.readTextFile(new URL("widgets.js", FX)), { headers: { "content-type": "text/javascript" } });
    const html = (b: string) => new Response(b.replace("</body>", `${SPY}</body>`), { headers: { "content-type": "text/html" } });
    if (files[u.pathname]) return html(await Deno.readTextFile(new URL(files[u.pathname], FX)));
    if (u.pathname === "/auto") return html(AUTOSUBMIT);
    if (u.pathname === "/noresume") return html(NO_RESUME);
    if (u.search) seen.submissions.push(`${u.pathname}${u.search.slice(0, 40)}`); // a GET form's submission carries its fields
    return new Response("not found", { status: 404 });
  });
  return { seen, base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, stop: () => server.shutdown() };
}

function browserReady(): boolean {
  if (!Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) {
    try { Deno.statSync(new URL("tools/node_modules/playwright", ROOT)); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", new URL("tools/node_modules/playwright", ROOT).pathname); } catch { /* none */ }
  }
  return !!loadPlaywright();
}

Deno.test("live-form dry run: its source never clicks, presses, taps, types Enter or submits", () => {
  const src = Deno.readTextFileSync(new URL("scripts/launch/live-form-dryrun.ts", ROOT));
  const code = src.replace(/export const SUBMIT_GUARD = `[\s\S]*?`;/, "").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.click\(/, /\.dblclick\(/, /\.tap\(/, /\.press\(/, /keyboard\./, /mouse\./, /requestSubmit\(/, /\.submit\(/, /dispatchEvent\(/, /\.check\(/, /"Enter"|'Enter'/]) {
    ok(!re.test(code), `live-form-dryrun.ts must not contain ${re}`);
  }
  ok(/route\.abort\("blockedbyclient"\)/.test(code) && /readOnly\(req\)/.test(code), "every request but a read is aborted");
  ok(/addInitScript\(\{ content: SUBMIT_GUARD \}\)/.test(code), "the guard is installed before the page's scripts");
  ok(/newContext\(\{.*serviceWorkers: "block"/.test(code), "service workers are blocked");
});

// The only person whose details may ever be typed into a real employer's page. Pinned: a change here is a change to what
// reaches employers, and must be made on purpose.
const PINNED = { first_name: "Casey", last_name: "Dryrun", full_name: "Casey Dryrun", email: "casey.dryrun@example.invalid", phone: "+1 555 010 0199", location: "Austin, TX" };
Deno.test("live-form dry run: the synthetic person is pinned, its email is on a reserved .invalid domain, and a real-looking person is refused", () => {
  eq(SYNTHETIC_FACTS, PINNED, "the synthetic person changed");
  eq(syntheticFactsProblem(SYNTHETIC_FACTS), null);
  ok(SYNTHETIC_FACTS.email.endsWith(".invalid"));
  ok(/^\+1 555 010 01\d\d$/.test(SYNTHETIC_FACTS.phone), "the fictional 555 number");
  for (const bad of [{ email: "casey.dryrun@gmail.com" }, { email: "vish@sporv.ai" }, { email: "casey@example.com" }, { phone: "+1 312 555 0100" }, { phone: "+1 773 202 5862" },
    { first_name: "Vishnu" }, { full_name: "Jordan Lee" }, { extra: "x" }]) {
    ok(syntheticFactsProblem({ ...SYNTHETIC_FACTS, ...bad }), `refused: ${JSON.stringify(bad)}`);
  }
});

Deno.test({
  name: "live-form dry run: fills Greenhouse, Lever and Ashby forms to the submit button and the employer sees no press, no Enter and no submission",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserReady()) { if (CI) throw new Error("the live-form dry run test needs Playwright in CI"); console.log("NOT_RUN: no Playwright"); return; }
    const emp = employer();
    const out = await Deno.makeTempDir({ prefix: "live-form-dryrun-test-" });
    const resumePath = `${out}/r.pdf`;
    await Deno.writeTextFile(resumePath, "%PDF-1.4 synthetic\n");
    const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await loadPlaywright().chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    try {
      const baseline: Record<string, string[]> = {};
      for (const family of ["greenhouse", "lever", "ashby"]) {
        const r = await dryRunLiveForm(browser, { id: `${family}-fixture`, family, url: `${emp.base}/${family}` }, { outDir: out, resumePath });
        ok(r.field_map.length >= 5, `${family}: the form was read: ${r.field_map.length}`);
        ok(r.submit_control && /submit/i.test(r.submit_control.text), `${family}: the submit control was found: ${JSON.stringify(r.submit_control)}`);
        eq(r.submit_guard.submit_events + r.submit_guard.submit_clicks + r.submit_guard.programmatic, 0, `${family}: nothing tried to submit`);
        ok(r.field_map.some((m) => /e-?mail/i.test(m.label) && m.status === "filled"), `${family}: the synthetic email was filled`);
        ok(r.field_map.some((m) => m.kind === "file" && m.status === "filled"), `${family}: the synthetic resume was attached`);
        ok(!r.field_map.some((m) => !m.required && m.status === "filled" && !/name|e-?mail|phone|resume|cv|location/i.test(m.label)), `${family}: no employer question was answered`);
        ok(r.screenshot && Deno.statSync(r.screenshot).size > 1000, `${family}: a screenshot`);
        eq([r.dry_run, r.submit_clicked], [true, false]);
        ok(["ok", "drift"].includes(r.status) && !r.drift.some((d) => /^(no_|submit_attempt|unknown_kind|fill_mechanics)/.test(d)), `${family}: no drift on the fixture: ${r.drift.join(" | ")}`);
        baseline[r.id] = schemaOf(r.field_map);
      }
      eq([emp.seen.pressed, emp.seen.enter, emp.seen.posts, emp.seen.submissions], [0, 0, [], []], "the employer saw no press, no Enter, no POST and no submission");
      ok(emp.seen.values.length >= 3, `the spy saw what was typed: ${emp.seen.values.length}`);
      const allowed = new Set(Object.values(PINNED));
      for (const v of emp.seen.values) ok([...allowed].some((a) => a.startsWith(v) || v === a), `only the pinned synthetic person reached the employer's page: ${JSON.stringify(v)}`);
      ok(emp.seen.values.some((v) => v === PINNED.email), "the .invalid email was typed");
      // Drift: the same Greenhouse posting against a baseline whose field set differs.
      baseline["greenhouse-fixture"] = [...baseline["greenhouse-fixture"].slice(1), "text|R|a question that is gone"];
      const again = await dryRunLiveForm(browser, { id: "greenhouse-fixture", family: "greenhouse", url: `${emp.base}/greenhouse` }, { outDir: out, resumePath, baseline });
      ok(again.status === "drift" && again.drift.some((d) => /^schema_changed:\+1\/-1/.test(d)), `a changed field set is drift: ${again.drift.join(" | ")}`);
      const nr = await dryRunLiveForm(browser, { id: "noresume", family: "greenhouse", url: `${emp.base}/noresume` }, { outDir: out, resumePath });
      ok(nr.status === "drift" && nr.drift.includes("no_resume_upload"), `a form without its resume upload is drift: ${nr.drift.join(" | ")}`);
      eq(emp.seen.posts, [], "still no POST");
    } finally {
      await browser.close();
      await emp.stop();
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "live-form dry run: the guard bites: a press of submit, requestSubmit() and Enter are cancelled and counted; a self-submitting page FAILS the run; nothing is sent",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserReady()) { if (CI) throw new Error("the live-form dry run test needs Playwright in CI"); console.log("NOT_RUN: no Playwright"); return; }
    const emp = employer();
    const out = await Deno.makeTempDir({ prefix: "live-form-guard-test-" });
    const resumePath = `${out}/r.pdf`;
    await Deno.writeTextFile(resumePath, "%PDF-1.4 synthetic\n");
    const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await loadPlaywright().chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    try {
      // What this test would see if the script DID press submit: the employer's spy counts it, the guard cancels it.
      const ctx = await browser.newContext();
      await ctx.addInitScript({ content: SUBMIT_GUARD });
      const page = await ctx.newPage();
      await page.goto(`${emp.base}/greenhouse`);
      await page.click('button[type="submit"]');
      await page.evaluate(`document.querySelector("form").requestSubmit()`);
      await page.evaluate(`document.querySelector("form").submit()`);
      await page.focus("input[type=text]");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      const g: any = await page.evaluate("window.__traineeSubmitGuard");
      ok(g.submit_clicks >= 1 && g.programmatic >= 2, `the guard counted the press and the calls: ${JSON.stringify(g)}`);
      ok(emp.seen.pressed >= 1 && emp.seen.enter >= 1, `the spy sees a press and an Enter (so a zero above means none happened): ${JSON.stringify(emp.seen)}`);
      eq(emp.seen.submissions, [], "the cancelled submission never left the page");
      eq(new URL(page.url()).pathname, "/greenhouse", "the page never navigated to the form's action");
      await ctx.close();
      // A page that submits itself while it is filled: the run is a submit_attempt (exit 1), and nothing was sent.
      const r = await dryRunLiveForm(browser, { id: "auto", family: "greenhouse", url: `${emp.base}/auto` }, { outDir: out, resumePath });
      eq(r.status, "submit_attempt", `a self-submitting page fails the run: ${JSON.stringify(r.submit_guard)}`);
      ok(r.drift.some((d) => d.startsWith("submit_attempt")));
      eq([emp.seen.posts, emp.seen.submissions], [[], []], "nothing was sent");
    } finally {
      await browser.close();
      await emp.stop();
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "live-form dry run: the page's own background POSTs (fetch, XHR, beacon, PUT) and a service worker's POSTs are blocked; nothing reaches the employer",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserReady()) { if (CI) throw new Error("the live-form dry run test needs Playwright in CI"); console.log("NOT_RUN: no Playwright"); return; }
    const emp = employer();
    const out = await Deno.makeTempDir({ prefix: "live-form-bg-test-" });
    const resumePath = `${out}/r.pdf`;
    await Deno.writeTextFile(resumePath, "%PDF-1.4 synthetic\n");
    const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await loadPlaywright().chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    try {
      const bg = await dryRunLiveForm(browser, { id: "background", family: "greenhouse", url: `${emp.base}/background` }, { outDir: out, resumePath });
      ok(bg.field_map.some((m) => /e-?mail/i.test(m.label) && m.status === "filled"), `the email was filled, so the page's input autosave fired: ${JSON.stringify(bg.field_map)}`);
      for (const kind of ["fetch", "xhr", "beacon", "put"]) ok(bg.requests_blocked.some((r) => r.includes(`/bg/${kind}`)), `the page's ${kind} was blocked and listed: ${bg.requests_blocked.join(", ")}`);
      eq(emp.seen.posts, [], "no background POST, PUT or beacon reached the employer");
      const sw = await dryRunLiveForm(browser, { id: "serviceworker", family: "greenhouse", url: `${emp.base}/serviceworker` }, { outDir: out, resumePath });
      await new Promise((r) => setTimeout(r, 1500));
      // (register() may still resolve under the block; the worker itself never runs, which is what matters.)
      ok(!emp.seen.sw.includes("worker-ran"), `no service worker ever runs: ${emp.seen.sw.join(",")}`);
      eq(emp.seen.posts, [], `no service worker request reached the employer (${sw.status})`);
      eq(emp.seen.submissions, []);
    } finally {
      await browser.close();
      await emp.stop();
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
});

// Without the block this page's worker does run, so "never runs" above is not vacuous. (Playwright's context
// route does see this Chromium's worker requests too; the block is the second lock, for a browser or version where it
// does not, and for a worker's cached responses that never touch the network.)
Deno.test({
  name: "live-form dry run: (control) a context that allows service workers lets this page's worker run",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!browserReady()) { if (CI) throw new Error("the live-form dry run test needs Playwright in CI"); console.log("NOT_RUN: no Playwright"); return; }
    const emp = employer();
    const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await loadPlaywright().chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    try {
      const ctx = await browser.newContext({ serviceWorkers: "allow" });
      await ctx.route("**/*", (route: any) => /^(GET|HEAD)$/.test(route.request().method()) ? route.continue() : route.abort("blockedbyclient"));
      const page = await ctx.newPage();
      await page.goto(`${emp.base}/serviceworker`);
      for (let i = 0; i < 30 && !emp.seen.sw.includes("worker-ran"); i++) await page.waitForTimeout(200);
      ok(emp.seen.sw.includes("worker-ran"), `the control's worker runs: ${emp.seen.sw.join(",")}`);
      await ctx.close();
    } finally {
      await browser.close();
      await emp.stop();
    }
  },
});
