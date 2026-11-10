// FILES LOOP (agent2/files, 2026-11-09; VERIFICATION-15 item 6; spec APP-LAYER-15-FIXES.md C.1, C.24; RESPONSE-RULES.md section 3):
// every File family in file_family.ts, drawn from its specimen (file_family_specimens.ts FILE_FAMILIES, the same fixtures the
// r10-files-browser-* tests use), every shared output state (C.24), and the live roles page (file_family_live.ts), loaded in Chromium
// at phone width (390 x 844) from a File origin. Every link, button, summary and form on each page is pressed, one at a time on a
// fresh load, and what happened is recorded: a request (a navigation, a form post, a download), a change to the page (a menu opening),
// or nothing.
//
// What counts as dead (asserted 0):
//   - a link whose href is empty, "#" or not http(s) or this site's own path or query; an external link that is not https;
//   - an enabled control that, pressed, makes no request and changes nothing on the page;
//   - a disabled control with no reason drawn beside it (C.1 item 5, Act.off);
//   - a form whose post carries no action or no page token.
// What counts as unserved (measured and printed, NOT asserted): an internal target that no File server code answers today. The served
// set is read from supabase/functions/trainee-file/handler.ts and _shared/file_kinds.ts at run time (the POST action lists the
// handler accepts, the GET parameters it reads, and the File kinds' action ids), so it grows by itself when the families are served.
// Serving the families (WO-E e4-e8) is the work that brings it to 0; this loop shows how far that is.
//
// C.1 (asserted 0 failures on the family pages): header with a labelled back link, the family title and its effect boundary (or the
// File's ids, F-06/F-09/F-10); a hero (F-11 and F-12 have none by spec) with a kicker, a title and a freshness time; at most one filled
// primary, at most two secondaries in the action bar; a primary named for the decision (not a bare "OK", "Submit", "Continue");
// a download is a retrieving link and never the filled primary; a submit, send or approve is always filled.
// C.24 (asserted 0 failures on the state pages): exactly one state; Prepared never reads as submitted; In progress has no green
// badge; Uncertain keeps the retry off; Confirmed shows green only with employer evidence, and a Confirmed page without it says so.
//
// Output: one line "FILES LOOP: families X, pages P, actions pressed Y, dead Z, unserved U, C.1 failures A, C.24 failures B", then
// each dead, unserved and failing item. Check: deno test -A --no-check tests/architect/files-actions-loop.test.ts
import assert from "node:assert/strict";
import { FAMILIES, familyStatePage, type FamilyId, type StateId, type StateInput } from "../../supabase/functions/_shared/file_family.ts";
import { FILE_FAMILIES, SPECIMEN_NOW, SPECIMEN_TOKEN, SPECIMEN_TZ } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { CI, playwright } from "./r10-files-check.ts";
import { feed } from "./r10-files-fixtures-live.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ORIGIN = "https://file.trainee.test";
const CTX = { now: SPECIMEN_NOW, tz: SPECIMEN_TZ };

// ------------------------------------------------------------------------------------------- what a File server answers today
export function servedSet(): { actions: Set<string>; params: Set<string> } {
  const handler = Deno.readTextFileSync(`${ROOT}/supabase/functions/trainee-file/handler.ts`);
  const kinds = Deno.readTextFileSync(`${ROOT}/supabase/functions/_shared/file_kinds.ts`);
  const actions = new Set<string>(), params = new Set<string>();
  for (const m of handler.matchAll(/\[((?:\s*"[a-z_]+",?)+)\]\.includes\(action\)/g)) for (const a of m[1].matchAll(/"([a-z_]+)"/g)) actions.add(a[1]);
  for (const m of handler.matchAll(/action === "([a-z_]+)"/g)) actions.add(m[1]);
  for (const m of handler.matchAll(/searchParams\.(?:get|has)\("([a-z_]+)"\)/g)) params.add(m[1]);
  const actionsOf = kinds.slice(kinds.indexOf("export function actionsOf"), kinds.indexOf("export async function actOn"));
  for (const m of actionsOf.matchAll(/id: "([a-z_]+)"/g)) actions.add(m[1]);
  return { actions, params };
}

// ------------------------------------------------------------------------------------------------------------- the pages
const kv = (k: string, v: string | null) => ({ k, v, src: v ? { label: "From Trainee's records" } : null });
const target = [kv("Role", "Operations Associate"), kv("Employer", "Example Carbon Co"), kv("Resume", "Operations v3")];
const STATES: Record<string, StateInput> = {
  loading: { state: "loading", family: "F-05", prior: { label: "Last verified", at: "2026-11-09T15:12:00Z" } },
  empty: { state: "empty", family: "F-05", scope: "9 boards + employer pages, US remote, operations, checked Nov 9, 2026, 9:40 AM CT", next: { label: "Explore adjacent roles", effect: "decide", href: "?widen=adjacent" } },
  needs_input: { state: "needs_input", family: "F-07", field: { name: "Graduation date", why: "The posting accepts only students graduating Dec 2027 to June 2028." }, draft: [kv("Resume", "Data analyst one-page draft v3"), kv("Expected graduation", null)], next: { label: "Add graduation date", effect: "decide", href: "?answer=graduation" } },
  prepared: { state: "prepared", family: "F-09", target, next: { label: "Review application", effect: "navigate", href: "?review=A-014" } },
  in_progress: { state: "in_progress", family: "F-09", step: "The reviewed answers were filled on the employer page; the final page has not answered yet.", target },
  uncertain: { state: "uncertain", family: "F-09", target, next: { label: "Check status", effect: "decide", post: { token: SPECIMEN_TOKEN, action: "status" } } },
  confirmed: { state: "confirmed", family: "F-09", target, evidence: { quote: "Thanks for applying to Operations Associate (CC-2214).", src: { label: "Employer email", href: "https://jobs.lever.co/examplecarbon/cc-2214", at: "2026-11-09T15:17:00Z" } } },
  confirmed_no_evidence: { state: "confirmed", family: "F-09", target },
  confirmed_page_only: { state: "confirmed", family: "F-09", target, evidence: { quote: "Application received.", src: { label: "Employer page" } } },
  error: { state: "error", family: "F-05", recover: { label: "Try again", effect: "decide", href: "?" } },
  expired: { state: "expired", family: "F-05", recover: { label: "Get a new link", effect: "decide", href: "https://t.me/TraineeBot" } },
};
interface Page { name: string; kind: "family" | "state" | "live"; family: FamilyId | "F-14n"; state?: StateId; evidence?: boolean; html: () => string }
const PAGES: Page[] = [
  ...FILE_FAMILIES.map((f): Page => ({ name: `${f.id} ${f.name}`, kind: "family", family: f.id, html: () => f.page(CTX) })),
  { name: "F-05 live roles page", kind: "live", family: "F-05", html: () => liveShortlistPage(feed(), CTX) },
  ...Object.entries(STATES).map(([k, s]): Page => ({ name: `state ${k}`, kind: "state", family: s.family, state: s.state, evidence: k === "confirmed", html: () => familyStatePage(s, CTX) })),
];

// --------------------------------------------------------------------------------------------------- reading one page in the browser
const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && (r.width > 0 || r.height > 0 || !!e.closest("details:not([open])")); };
  return [...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => {
    const form = e.closest("form"), post = !!form && (form.getAttribute("method") || "get").toLowerCase() === "post";
    const off = e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? e.getAttribute("title") ?? e.getAttribute("aria-describedby") ?? "").trim() : null;
    return { i, tag: e.tagName.toLowerCase(), label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60), href: e.tagName === "A" ? e.getAttribute("href") : null,
      type: e.getAttribute("type"), disabled: !!e.disabled, off, inForm: post, getForm: !!form && !post, formAction: form ? (form.querySelector("input[name=action]")?.value ?? null) : null,
      formToken: form ? !!form.querySelector("input[name=t]")?.value : null, effect: e.getAttribute("data-effect"), cls: e.getAttribute("class") || "", inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY", visible: vis(e) };
  });
})()`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;

// C.1 on a family page, C.24 on a state page: what the DOM shows.
const ANATOMY = `(() => {
  const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)], t = (e) => (e?.textContent || "").replace(/\\s+/g, " ").trim();
  return {
    back: !!q("header.ff-head a.ff-sq[aria-label=Back][href]"), title: t(q(".ff-head .ff-ht")), sub: t(q(".ff-head .ff-hs")),
    hero: !!q(".ff-hero"), heroText: t(q(".ff-hero")), kicker: t(q(".ff-hero .ff-kick")), h1: t(q(".ff-hero .ff-h1")), heroTime: !!q(".ff-hero .ff-metas time") || !!q(".ff-hero .ff-metas [data-unconfirmed]"),
    barPri: qa(".ff-bar > .ff-pri, .ff-bar > .ff-act > .ff-pri, .ff-bar > form .ff-pri").length, barPriLabel: t(q(".ff-bar .ff-pri")), barSec: qa(".ff-bar .ff-two > *").length,
    pageVisiblePri: qa(".ff-pri").filter((e) => !e.closest("details:not([open])") && !e.closest(".ff-item")).length,
    dlBad: qa("[data-effect=download]").filter((e) => e.classList.contains("ff-pri") || e.tagName !== "A" && !e.disabled || (e.tagName === "A" && !e.hasAttribute("download"))).map((e) => t(e)),
    filledBad: qa("[data-effect=submit],[data-effect=send],[data-effect=approve]").filter((e) => !e.classList.contains("ff-pri")).map((e) => t(e)),
    states: qa("[data-state]").map((e) => e.getAttribute("data-state")), text: t(document.body),
    greenChip: qa(".ff-c-confirmed").map((e) => t(e)), retryOff: qa("button[disabled]").some((b) => /submit again|retry/i.test(t(b))), evidence: !!q(".ff-ev"),
  };
})()`;
const BOUNDARY = /\b(private|only you|never sent|not sent|nothing (?:is )?(?:sent|submitted|accepted)|not applying|no applications|approval|inspectable|own state|no spreadsheet|not booked|honest)\b/i;
const CLOCK = /\b\d{1,2}:\d{2}\s?[AP]M\b/;
const GENERIC = /^(ok|okay|submit|continue|next|go|yes|confirm|done)$/i;
function anatomy(p: Page, a: any): string[] {
  const bad: string[] = [];
  if (p.kind === "family" || p.kind === "live") {
    const fam = FAMILIES[(p.family === "F-14n" ? "F-14" : p.family) as FamilyId];
    if (p.kind === "family" && !a.back) bad.push("C.1 header: no labelled back link");
    if (!a.title) bad.push("C.1 header: no title");
    // C.1 item 2: the subtitle states the File's privacy or effect boundary; F-06, F-09 and F-10 carry their ids there (p-58, p-67,
    // p-69); F-13 names the engagement ("Example Grid Co - stage 2 of 3", C.15) and says booked or not in its kicker instead.
    if (["F-06", "F-09", "F-10"].includes(p.family)) { if (!/\b[A-Z]-\d+/.test(a.sub)) bad.push(`C.1 header: subtitle "${a.sub}" does not carry the File's ids`); }
    else if (p.family === "F-13") { if (!/not booked|confirmed logistics/i.test(a.kicker)) bad.push(`C.1 F-13: the kicker "${a.kicker}" does not say whether the time is booked`); }
    else if (!BOUNDARY.test(a.sub)) bad.push(`C.1 header: subtitle "${a.sub}" states no privacy or effect boundary (family default: "${fam.boundary}")`);
    if (!["F-11", "F-12", "F-02", "F-08"].includes(p.family)) {
      if (!a.hero) bad.push("C.1 hero: missing");
      else { if (!a.kicker) bad.push("C.1 hero: no kicker"); if (!a.h1) bad.push("C.1 hero: no title"); if (!a.heroTime && !CLOCK.test(a.heroText)) bad.push("C.1 hero: no freshness time"); }
    }
    if (a.barPri > 1) bad.push(`C.1 action bar: ${a.barPri} filled primaries`);
    if (a.barSec > 2) bad.push(`C.1 action bar: ${a.barSec} secondaries (at most 2)`);
    if (a.barPri && GENERIC.test(a.barPriLabel)) bad.push(`C.1 action bar: primary "${a.barPriLabel}" is not named for the decision`);
    for (const d of a.dlBad) bad.push(`C.1 download "${d}" looks like a submit or does not retrieve`);
    for (const f of a.filledBad) bad.push(`C.1 "${f}" submits, sends or approves but is not drawn filled`);
  }
  if (p.kind === "state") {
    if (a.states.length !== 1) bad.push(`C.24: ${a.states.length} states on one page (${a.states.join(", ")})`);
    if (p.state === "prepared" && /\bsubmitted\b/i.test(a.text.replace(/not submitted/gi, ""))) bad.push("C.24 Prepared reads as submitted");
    if (p.state === "in_progress" && a.greenChip.length) bad.push(`C.24 In progress shows a green badge: ${a.greenChip.join(", ")}`);
    if (p.state === "uncertain" && !a.retryOff) bad.push("C.24 Uncertain does not keep the retry off");
    if (p.state === "confirmed" && p.evidence && (!a.greenChip.length || !a.evidence)) bad.push("C.24 Confirmed with employer evidence is not shown confirmed with it");
    if (p.state === "confirmed" && !p.evidence && (a.greenChip.length || !/not (shown as )?confirmed/i.test(a.text))) bad.push("C.24 Confirmed without employer evidence shows green or does not say it is unconfirmed");
  }
  return bad;
}

// -------------------------------------------------------------------------------------------------------------------- the loop
interface Pressed { page: string; label: string; what: string; result: "request" | "change" | "nothing" | "skipped"; target?: string; dead?: string; unserved?: string }
const safeTarget = (href: string) => /^https:\/\//i.test(href) || /^(\?|#.+|\/(?!\/))/.test(href);


// Press every control of every page; judge C.1 or C.24 on each. One browser, one phone-width context.
async function measure(pages: Page[]): Promise<{ pressed: Pressed[]; c1: string[]; c24: string[] } | null> {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the Files loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return null; }
  const served = servedSet();
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const pressed: Pressed[] = [], c1: string[] = [], c24: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", acceptDownloads: true });
    let current = "", loaded = "", requests: { method: string; url: string; body: string | null }[] = [];
    // The route answers only the page itself; everything else (fonts, links, posts, other sites) is aborted: nothing leaves the machine.
    await ctx.route("**/*", async (r: any) => {
      const req = r.request(), u = req.url();
      if (u === loaded && req.method() === "GET") return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: current });
      return r.abort();
    });
    const pg = await ctx.newPage();
    // Every request the page makes is recorded (a download's too, which the route never sees).
    pg.on("request", (req: any) => { if (req.url() !== loaded || req.method() !== "GET") requests.push({ method: req.method(), url: req.url(), body: req.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    const load = async (p: Page) => { current = p.html(); loaded = `${ORIGIN}/__page/${encodeURIComponent(p.name)}`; await pg.goto(loaded, { waitUntil: "load" }); requests = []; };
    for (const p of pages) {
      await load(p);
      for (const b of anatomy(p, await pg.evaluate(ANATOMY))) (p.kind === "state" ? c24 : c1).push(`${p.name}: ${b}`);
      const controls: any[] = await pg.evaluate(READ);
      for (const c of controls) {
        const what = `${c.tag}${c.effect ? `[${c.effect}]` : ""} "${c.label}"`;
        const rec: Pressed = { page: p.name, label: c.label, what, result: "skipped" };
        pressed.push(rec);
        if (c.disabled) { if (!c.off) rec.dead = "disabled with no reason drawn beside it"; continue; }
        if (c.tag === "a" && (c.href === null || !c.href.trim() || c.href === "#" || !safeTarget(c.href))) { rec.dead = `link target "${c.href}" goes nowhere`; continue; }
        if (c.inForm && (!c.formAction || !c.formToken)) { rec.dead = "form post carries no action or no page token"; continue; }
        await load(p);
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP); // after any menu holding it was opened: opening the menu is not this control's effect
        // A download starts after the click returns: wait for its event (up to 3 s) so it is not counted against the next control.
        const dl = c.effect === "download" ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.dead = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await dl;
        await pg.waitForTimeout(150);
        const after = await pg.evaluate(SNAP).catch(() => "navigated");
        const req = requests[0] ?? null;
        if (req) {
          rec.result = "request";
          const u = new URL(req.url);
          rec.target = `${req.method} ${u.origin === ORIGIN ? u.pathname.replace(/^\/__page\/[^/?]*/, "(this File)") + u.search : u.host + u.pathname}`;
          if (u.origin === ORIGIN) {
            if (req.method === "POST") {
              const f = new URLSearchParams(req.body ?? "");
              const action = f.get("action") ?? "";
              if (!action || !f.get("t")) rec.dead = "posted with no action or no page token";
              else if (!served.actions.has(action)) rec.unserved = `POST action "${action}" is not answered by any File server action today`;
            } else {
              const keys = [...u.searchParams.keys()];
              if (!u.pathname.startsWith("/__page")) rec.unserved = `GET ${u.pathname} is not a File server route (the File server draws the File its token opens, whatever the path)`;
              else if (keys.length && !keys.some((k) => served.params.has(k))) rec.unserved = `GET ?${keys.join("&")} is not read by the File server today`;
            }
          } else if (u.protocol !== "https:") rec.dead = `external link is not https: ${req.url}`;
        } else if (after !== before) rec.result = "change";
        else { rec.result = "nothing"; rec.dead ??= "pressing it made no request and changed nothing"; }
      }
    }
    await ctx.close();
  } finally { await browser.close(); }
  return { pressed, c1, c24 };
}

Deno.test({ name: "FILES LOOP: every File family, state and the live roles page at 390 px: every action pressed, none dead; C.1 and C.24 hold", sanitizeResources: false, sanitizeOps: false, async fn() {
  const m = await measure(PAGES);
  if (!m) return;
  const { pressed, c1, c24 } = m;
  const acted = pressed.filter((x) => x.result !== "skipped");
  const dead = pressed.filter((x) => x.dead), unserved = pressed.filter((x) => x.unserved && !x.dead);
  const families = new Set(PAGES.filter((p) => p.kind !== "state").map((p) => p.family)).size;
  console.log(`FILES LOOP: families ${families}, pages ${PAGES.length}, actions pressed ${acted.length} (of ${pressed.length} controls; ${pressed.length - acted.length} disabled with a reason), dead ${dead.length}, unserved ${unserved.length}, C.1 failures ${c1.length}, C.24 failures ${c24.length}`);
  for (const d of dead) console.log(`  DEAD     ${d.page}: ${d.what}: ${d.dead}`);
  const causes = new Map<string, number>();
  for (const u of unserved) { const k = u.unserved!.replace(/"[a-z_]+"/, "<action>").replace(/\?[a-z_&]+ is/, "?<param> is"); causes.set(k, (causes.get(k) ?? 0) + 1); }
  console.log(`  unserved by cause: ${[...causes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} x ${k}`).join("; ")}`);
  for (const u of unserved) console.log(`  UNSERVED ${u.page}: ${u.what} -> ${u.target}`);
  for (const f of [...c1, ...c24]) console.log(`  FAIL     ${f}`);
  const byPage = new Map<string, { n: number; unserved: number }>();
  for (const x of acted) { const e = byPage.get(x.page) ?? { n: 0, unserved: 0 }; e.n++; if (x.unserved) e.unserved++; byPage.set(x.page, e); }
  console.log(`  served by page: ${[...byPage].map(([k, v]) => `${k} ${v.n - v.unserved}/${v.n}`).join("; ")}`);
  assert.equal(dead.length, 0, `dead actions:\n${dead.map((d) => `${d.page}: ${d.what}: ${d.dead}`).join("\n")}`);
  assert.equal(c1.length, 0, `C.1 failures:\n${c1.join("\n")}`);
  assert.equal(c24.length, 0, `C.24 failures:\n${c24.join("\n")}`);
  assert.ok(acted.length >= 200, `only ${acted.length} actions were pressed: the loop is not reaching the pages`);
  // The live roles page is the one family page the File server serves today: every action on it must be one the server answers.
  const liveUnserved = unserved.filter((u) => u.page === "F-05 live roles page");
  assert.equal(liveUnserved.length, 0, `the served roles page has actions the File server does not answer:\n${liveUnserved.map((u) => `${u.what} -> ${u.target}`).join("\n")}`);
} });

// The loop's own rules: a page that breaks each one once must be reported for each (a loop that sees nothing proves nothing).
Deno.test({ name: "FILES LOOP: a page with a dead link, a dead button, a silent disabled button, a tokenless post and broken C.1/C.24 is reported for each", sanitizeResources: false, sanitizeOps: false, async fn() {
  const broken = `<!doctype html><html><body><div class="ff" data-family="F-09"><header class="ff-head"><div class="ff-hb"><p class="ff-ht">Application review</p><p class="ff-hs">Things</p></div></header><main>
    <section class="ff-hero"><p class="ff-kick"></p><h1 class="ff-h1">Review</h1></section>
    <a class="ff-btn ff-sec" href="#">Dead link</a><a class="ff-btn ff-sec" href="javascript:void(0)">Script link</a><button type="button" class="ff-btn ff-sec">Does nothing</button>
    <span class="ff-act"><button type="button" class="ff-btn ff-sec" disabled>Silent off</button></span>
    <form method="post"><input type="hidden" name="action" value="apply"><button type="submit" class="ff-btn ff-sec" data-effect="submit">Approve submission</button></form>
    <div class="ff-bar"><a class="ff-btn ff-pri" data-effect="download" href="/x.pdf">Download</a><a class="ff-btn ff-pri" href="?a">OK</a><div class="ff-two"><a class="ff-btn ff-sec" href="?b">B</a><a class="ff-btn ff-sec" href="?c">C</a><a class="ff-btn ff-sec" href="?d">D</a></div></div>
    </main></div></body></html>`;
  const prepared = `<!doctype html><html><body><div class="ff" data-state="prepared"><div data-state="in_progress"></div><p>Submitted to the employer.</p></div></body></html>`;
  const m = await measure([{ name: "broken family", kind: "family", family: "F-01", html: () => broken }, { name: "broken state", kind: "state", family: "F-09", state: "prepared", html: () => prepared }]);
  if (!m) return;
  const dead = m.pressed.filter((x) => x.dead).map((x) => `${x.label}: ${x.dead}`).join("\n");
  for (const want of [/Dead link: link target "#"/, /Script link: link target "javascript/, /Does nothing: pressing it made no request/, /Silent off: disabled with no reason/, /Approve submission: form post carries no action or no page token/]) assert.match(dead, want);
  const c1 = m.c1.join("\n"), c24 = m.c24.join("\n");
  for (const want of [/no labelled back link/, /states no privacy or effect boundary/, /no kicker/, /no freshness time/, /2 filled primaries/, /3 secondaries/, /download "Download" looks like a submit/, /"Approve submission" submits, sends or approves but is not drawn filled/]) assert.match(c1, want);
  for (const want of [/2 states on one page/, /Prepared reads as submitted/]) assert.match(c24, want);
} });
