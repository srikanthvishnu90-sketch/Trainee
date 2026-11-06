// R4 of the test ladder (docs/architect/TEST-STRATEGY-2026-11-01.md): a daily dry run on REAL public application forms. For each
// posting (one Greenhouse, one Ashby, one Lever, picked by scripts/career/pick-form-sources.cjs), it opens the application page
// in Chromium, fills it with the apply worker's own fill code (workers/career-browser/ats-fill.cjs) from a synthetic person's
// facts only (name, email, phone, resume: no answer to any employer question), screenshots it, finds the submit control
// and STOPS. It never clicks submit, and it cannot send:
//   - the network: no service worker may register (serviceWorkers: "block"); GET and HEAD only, plus a GraphQL POST whose every operation is a query (Ashby builds its form that way;
//     scripts/career/render-form.cjs readOnly). Every other request (a form post, a mutation, an autosave, an upload, a
//     beacon) is aborted in the browser and listed in the report (requests_blocked);
//   - the page: before any page script runs, a guard cancels every submit event, every click on a submit control and every
//     form.submit()/requestSubmit() call, and counts them (submit_guard). Any count above zero FAILS the run: it would mean
//     the fill code tried to send;
//   - this file has no code that clicks, presses Enter on, or submits anything (tests/architect/live-form-dryrun.test.ts
//     reads it and drives the guard against local forms that report every press of their submit button).
// Drift (the form-schema changed under the fill code), per posting: no application form; no email field or no resume upload;
// no submit control; a fill the engine could not read back; a question kind the engine does not know; and, with --baseline
// (the previous run's schema file), the field set of the same posting changed. A bot check or a closed posting is reported,
// not drift. Writes <out>/report.json, <out>/schema.json and one screenshot per posting.
//   node scripts/career/pick-form-sources.cjs <dir>/sources.json greenhouse=1,lever=1,ashby=1
//   deno run -A scripts/launch/live-form-dryrun.ts --sources <dir>/sources.json --out <dir>/out [--baseline <prev schema.json>]
// Exit: 0 no drift, 1 drift or a submit attempt, 2 NOT RUN (no Chromium, no sources). Needs UPMORE_PLAYWRIGHT_PATH (and
// UPMORE_CHROMIUM_PATH for a system Chrome). Cost: GitHub-hosted runner minutes only (no model, no Vercel Sandbox).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fillForm } = require("../../workers/career-browser/ats-fill.cjs");
const { readOnly } = require("../career/render-form.cjs");

export const KNOWN_KINDS = new Set(["text", "textarea", "select", "radio", "checkgroup", "buttons", "checkbox", "combobox", "file"]);
// A synthetic person (reserved .invalid domain): facts only, so no employer question is ever answered.
export const SYNTHETIC_FACTS = { first_name: "Casey", last_name: "Dryrun", full_name: "Casey Dryrun", email: "casey.dryrun@example.invalid", phone: "+1 555 010 0199", location: "Austin, TX" };
// What may ever be typed into a real employer's page: exactly these keys, an email on a reserved .invalid domain, the
// fictional 555 number, and the fixed synthetic name. Anything else is refused before a browser starts.
export function syntheticFactsProblem(f: Record<string, string>): string | null {
  const keys = Object.keys(SYNTHETIC_FACTS).sort().join(",");
  if (Object.keys(f).sort().join(",") !== keys) return `the synthetic person has exactly ${keys}`;
  if (!/^[a-z.]+@example\.invalid$/.test(f.email)) return "the email must be on example.invalid (RFC 2606)";
  if (!/^\+1 555 010 01\d\d$/.test(f.phone)) return "the phone must be the fictional +1 555 010 01xx";
  if (f.first_name !== "Casey" || f.last_name !== "Dryrun" || f.full_name !== "Casey Dryrun") return "the name is the fixed synthetic Casey Dryrun";
  return null;
}
const BOT_RE = /verify\s+(?:that\s+)?you(?:\s+are|'re)\s+(?:a\s+)?(?:human|not a robot)|captcha|turnstile|challenges\.cloudflare\.com|are you a robot/i;
const CLOSED_RE = /no longer (accepting|available|open)|position (has been )?(filled|closed)|job (is )?(closed|not found)|page (you'?re looking for )?(could not|can't|cannot) be found/i;

// Installed in every page before its own scripts. Counts every way a form could be sent and cancels each.
export const SUBMIT_GUARD = `(() => {
  const g = { submit_events: 0, submit_clicks: 0, programmatic: 0, last: [] };
  Object.defineProperty(window, "__traineeSubmitGuard", { value: g, configurable: false, writable: false });
  const note = (k, el) => { g[k]++; if (g.last.length < 5) g.last.push(k + ":" + (el && (el.id || el.name || el.textContent || "")).toString().trim().slice(0, 60)); };
  const isSubmit = (el) => {
    const b = el && el.closest && el.closest('button, input[type="submit"], input[type="image"], [role="button"]');
    if (!b) return null;
    if (b.tagName === "INPUT") return b;
    if (b.tagName === "BUTTON") return (b.getAttribute("type") || "submit").toLowerCase() === "submit" && b.form ? b : null;
    return /^\\s*(submit|send)( (my )?application)?\\s*$/i.test(b.textContent || "") ? b : null;
  };
  window.addEventListener("click", (e) => { const b = isSubmit(e.target); if (b) { e.preventDefault(); e.stopImmediatePropagation(); note("submit_clicks", b); } }, true);
  window.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); note("submit_events", e.target); }, true);
  const P = HTMLFormElement.prototype;
  P.submit = function () { note("programmatic", this); };
  P.requestSubmit = function () { note("programmatic", this); };
})();`;

// The control a person would press to send the application, as a description (never a handle that is acted on).
const FIND_SUBMIT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const all = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(vis);
  const typed = all.filter((b) => (b.tagName === "INPUT") || (b.tagName === "BUTTON" && (b.getAttribute("type") || "submit").toLowerCase() === "submit" && b.form));
  const worded = all.filter((b) => /submit|send application|apply/i.test(b.textContent || b.value || ""));
  const b = typed.find((x) => /submit|apply|send/i.test(x.textContent || x.value || "")) || worded[0] || typed[0];
  return b ? { text: (b.textContent || b.value || "").trim().slice(0, 60), tag: b.tagName.toLowerCase(), type: b.getAttribute("type") || "" } : null;
})()`;

export interface Source { id: string; family: string; company?: string; url: string }
export interface FormRun {
  id: string; family: string; url: string; final_url: string | null; status: "ok" | "drift" | "bot_check" | "closed" | "submit_attempt" | "error";
  drift: string[]; field_map: { label: string; kind: string; required: boolean; status?: string; reason?: string }[]; schema_sha256: string | null;
  submit_control: { text: string; tag: string; type: string } | null; submit_guard: { submit_events: number; submit_clicks: number; programmatic: number; last: string[] };
  requests_blocked: string[]; screenshot: string | null; dry_run: true; submit_clicked: false; ms: number; error?: string;
}

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const schemaOf = (map: FormRun["field_map"]) => map.map((m) => `${m.kind}|${m.required ? "R" : "o"}|${m.label.toLowerCase().replace(/\s+/g, " ").trim()}`).sort();

export function loadPlaywright(): any {
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean) as string[]) { try { return require(p); } catch { /* next */ } }
  return null;
}

// One posting. `browser` is a Playwright browser; `outDir` gets the screenshot. Exported for the guard's test.
export async function dryRunLiveForm(browser: any, s: Source, o: { outDir: string; resumePath: string; baseline?: Record<string, string[]>; timeoutMs?: number }): Promise<FormRun> {
  const t0 = Date.now();
  const run: FormRun = { id: s.id, family: s.family, url: s.url, final_url: null, status: "error", drift: [], field_map: [], schema_sha256: null, submit_control: null,
    submit_guard: { submit_events: 0, submit_clicks: 0, programmatic: 0, last: [] }, requests_blocked: [], screenshot: null, dry_run: true, submit_clicked: false, ms: 0 };
  const problem = syntheticFactsProblem(SYNTHETIC_FACTS);
  if (problem) throw new Error(`refused: ${problem}`);
  // No service workers: a worker's own requests and cached responses are not the page's, so the page's route is not the
  // only door they could use.
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 }, serviceWorkers: "block" });
  await ctx.addInitScript({ content: SUBMIT_GUARD });
  await ctx.route("**/*", (route: any) => {
    const req = route.request();
    if (readOnly(req)) return route.continue();
    const u = new URL(req.url());
    if (run.requests_blocked.length < 50) run.requests_blocked.push(`${req.method()} ${u.hostname}${u.pathname}`.slice(0, 140));
    return route.abort("blockedbyclient");
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(o.timeoutMs ?? 20000);
  try {
    const resp = await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    run.final_url = page.url();
    const html = await page.content();
    if (!resp || resp.status() >= 400 || CLOSED_RE.test(html.slice(0, 200000))) { run.status = "closed"; run.error = `page ${resp ? resp.status() : "none"}`; return run; }
    if (BOT_RE.test(html) && !(await page.$("form"))) { run.status = "bot_check"; return run; }
    const r = await fillForm(page, { ats: s.family, facts: SYNTHETIC_FACTS, answers: {}, resumePath: o.resumePath });
    run.field_map = r.map.map((m: any) => ({ label: m.label, kind: m.kind, required: !!m.required, status: m.status, reason: m.reason }));
    run.submit_control = await page.evaluate(FIND_SUBMIT);
    run.submit_guard = await page.evaluate("window.__traineeSubmitGuard ? JSON.parse(JSON.stringify(window.__traineeSubmitGuard)) : null") ?? { submit_events: -1, submit_clicks: -1, programmatic: -1, last: ["guard missing"] };
    const shot = `${o.outDir}/${s.id}.filled.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => page.screenshot({ path: shot }));
    run.screenshot = shot;
    // ---- drift
    const map = run.field_map;
    if (!map.length) run.drift.push("no_application_form_found");
    else {
      if (!map.some((m) => m.kind === "text" && /e-?mail/i.test(m.label))) run.drift.push("no_email_field");
      if (!map.some((m) => m.kind === "file" && /resume|\bcv\b/i.test(m.label))) run.drift.push("no_resume_upload");
      if (!run.submit_control) run.drift.push("no_submit_control");
      for (const m of map) if (!KNOWN_KINDS.has(m.kind)) run.drift.push(`unknown_kind:${m.kind}:${m.label.slice(0, 50)}`);
      for (const m of map) if (/^(readback_mismatch|fill_error|still_empty_after_fill|driver_error)/.test(m.reason ?? "") && m.kind !== "file") run.drift.push(`fill_mechanics:${m.reason}:${m.label.slice(0, 50)}`);
      // Our own facts must land: a name and email field that exists but did not take the synthetic fact is drift.
      for (const m of map) if (/^(e-?mail|first name|last name|full name|name)$/i.test(m.label.trim()) && m.status !== "filled" && m.status !== "prefilled") run.drift.push(`fact_not_filled:${m.label}`);
      const schema = schemaOf(map);
      run.schema_sha256 = await sha256(schema.join("\n"));
      const before = o.baseline?.[s.id];
      if (before && before.join("\n") !== schema.join("\n")) {
        const added = schema.filter((x) => !before.includes(x)), removed = before.filter((x) => !schema.includes(x));
        run.drift.push(`schema_changed:+${added.length}/-${removed.length}:${[...added.map((x) => `+${x}`), ...removed.map((x) => `-${x}`)].slice(0, 4).join("; ").slice(0, 300)}`);
      }
    }
    const g = run.submit_guard;
    run.status = g.submit_events || g.submit_clicks || g.programmatic ? "submit_attempt" : run.drift.length ? "drift" : "ok";
    if (run.status === "submit_attempt") run.drift.push(`submit_attempt:${g.last.join(",")}`);
  } catch (e) {
    run.status = "error"; run.error = String((e as Error).message).split("\n")[0].slice(0, 200);
  } finally {
    run.ms = Date.now() - t0;
    await ctx.close().catch(() => {});
  }
  return run;
}

export async function runAll(sources: Source[], o: { outDir: string; baseline?: Record<string, string[]>; launch?: Record<string, unknown> }) {
  const pw = loadPlaywright();
  if (!pw) return { notRun: "playwright is not installed (UPMORE_PLAYWRIGHT_PATH)", runs: [] as FormRun[] };
  await Deno.mkdir(o.outDir, { recursive: true });
  const resumePath = `${o.outDir}/synthetic-resume.pdf`;
  await Deno.writeTextFile(resumePath, "%PDF-1.4\n% SYNTHETIC TEST RESUME (Trainee live-form dry run; not a person)\n");
  const exe = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), ...(o.launch ?? {}) });
  const runs: FormRun[] = [];
  try {
    for (const s of sources) runs.push(await dryRunLiveForm(browser, s, { outDir: o.outDir, resumePath, baseline: o.baseline }));
  } finally { await browser.close(); }
  return { notRun: null, runs };
}

async function main(args: string[]): Promise<number> {
  const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const src = flag("--sources"), out = flag("--out") ?? await Deno.makeTempDir({ prefix: "live-form-dryrun-" }), base = flag("--baseline");
  if (!src) { console.error("usage: live-form-dryrun.ts --sources <sources.json> [--out DIR] [--baseline schema.json]"); return 2; }
  const sources: Source[] = JSON.parse(await Deno.readTextFile(src)).filter((s: Source) => ["greenhouse", "lever", "ashby"].includes(s.family));
  if (!sources.length) { console.log("LIVE_FORM NOT RUN: no Greenhouse, Lever or Ashby source"); return 2; }
  const baseline = base ? JSON.parse(await Deno.readTextFile(base).catch(() => "{}")) : undefined;
  const { notRun, runs } = await runAll(sources, { outDir: out, baseline });
  if (notRun) { console.log(`LIVE_FORM NOT RUN: ${notRun}`); return 2; }
  const schema = Object.fromEntries(runs.filter((r) => r.field_map.length).map((r) => [r.id, schemaOf(r.field_map)]));
  await Deno.writeTextFile(`${out}/schema.json`, JSON.stringify(schema, null, 1));
  await Deno.writeTextFile(`${out}/report.json`, JSON.stringify({ at: new Date().toISOString(), runs }, null, 1));
  for (const r of runs) {
    console.log(`LIVE_FORM ${r.family} ${r.id} ${r.status.toUpperCase()} fields=${r.field_map.length} submit_control=${r.submit_control ? JSON.stringify(r.submit_control.text) : "none"} blocked=${r.requests_blocked.length} guard=${r.submit_guard.submit_events}/${r.submit_guard.submit_clicks}/${r.submit_guard.programmatic}${r.drift.length ? ` drift=${r.drift.join(" | ")}` : ""}${r.error ? ` error=${r.error}` : ""}`);
  }
  const attempted = runs.some((r) => r.status === "submit_attempt");
  const drift = runs.filter((r) => r.status === "drift" || r.status === "error");
  const families = new Set(runs.filter((r) => r.status === "ok" || r.status === "drift").map((r) => r.family));
  console.log(`LIVE_FORM ${attempted ? "FAIL (a submit was attempted and blocked)" : drift.length ? "DRIFT" : "OK"} forms=${runs.length} ok=${runs.filter((r) => r.status === "ok").length} drift=${drift.length} bot_check=${runs.filter((r) => r.status === "bot_check").length} closed=${runs.filter((r) => r.status === "closed").length} families_read=${[...families].join(",")}`);
  return attempted || drift.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
