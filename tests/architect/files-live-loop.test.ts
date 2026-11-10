// FILES LIVE LOOP (item 6, S0; coordinator rulings 2026-11-10): every File family SERVED by the real File server
// (trainee-file/handler.ts handleFile, the real file service over the in-memory store, a real signed-in phone session), loaded in
// Chromium at 390 x 844 through that server, and every control pressed on a fresh load. Each family's view data is its specimen
// (file_family_specimens.ts), stored as a File record the way code makes one (FileService.createFamily).
//
// For each press:
//   - a request to the File server is answered by the File server itself (handleFile, with the person's cookie). Served: a 2xx that
//     is this File's own export (?format=json, JSON) or a page that says what happened. Unserved: a 4xx, "Not done", or a GET whose
//     query the server does not read.
//   - the chat link (TRAINEE_BOT_URL) opens the chat with the question filled in (ruling 2): its text names this File, and the item
//     when the control sits on one. Pressing it changes no row (the File store and the sessions are compared before and after).
//   - an https source page is a source link (not fetched: no network in the gate).
//   - a control shown off with its reason is counted as "not yet served": the state changes and approvals S1-S6 serve as POST forms
//     with the page token (approvals bound to the payload hash, D-MS-1, D-MN-2).
// Asserted: dead 0, unserved 0, every chat question names its File. Printed: the line below, and the not-yet-served controls by family.
//   FILES LIVE LOOP: families X, controls Y, pressed Z, served S, chat questions Q, dead D, unserved U, not yet served N
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { FILE_FAMILIES, SPECIMEN_NOW } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { isServedFamily, SERVED_FAMILIES } from "../../supabase/functions/_shared/file_family_serve.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, sha256, signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";

const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", U = "33333333-3333-4333-8333-333333333333";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-live-loop-0123456789", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
  async save() { return "saved"; }, async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; },
  async wanted() { return false; } }) as unknown as FileStore;

async function world() {
  const A = signedIn(), store = memoryFileStore();
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => SPECIMEN_NOW });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => SPECIMEN_NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } } as never, tap: {} as never, files };
  const pages: { family: string; title: string; sid: string }[] = [];
  for (const f of FILE_FAMILIES) {
    if (!isServedFamily(f.id)) continue;
    const made = await files.createFamily!(U, f.id, f.name, f.specimen);
    if (!made.ok) throw new Error(`${f.id}: ${made.error}`);
    pages.push({ family: f.id, title: f.name, sid: await A.tok(U, made.id, SPECIMEN_NOW) });
  }
  // What a press could change: every File record (data and state) and every session (a sign-out, a revocation).
  const rows = async () => JSON.stringify([store.all(), await Promise.all(pages.map(async (p) => await A.store.session(await sha256(p.sid))))]);
  const serve = (url: string, sid: string, init: { method?: string; body?: string | null; headers?: Record<string, string> } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { ...(init.headers ?? {}), cookie: `tf_s=${sid}`, origin: new URL(BASE).origin }, body: init.method === "POST" ? init.body ?? "" : undefined }), deps);
  return { pages, rows, serve, handle: (r: Request) => handleFile(r, deps) };
}

const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => ({ i, tag: e.tagName.toLowerCase(), href: e.getAttribute("href"),
  label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? "").trim() : null, inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY" }))`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;
interface Press { family: string; label: string; result: "served" | "chat" | "source" | "change" | "off" | "dead" | "unserved"; why?: string }

Deno.test({ name: "FILES LIVE LOOP: every File family served by the File server at 390 px: every control pressed, none dead, none unserved; chat questions name the File", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the Files live loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const w = await world();
  assert.equal(w.pages.length, SERVED_FAMILIES.length, "every served family has a page");
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const out: Press[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
    let sid = "", loaded = "", requests: { method: string; url: string; body: string | null }[] = [];
    // The page itself is drawn by the File server; nothing else is fetched (fonts, sources and the chat are recorded and aborted).
    await ctx.route("**/*", async (r: any) => {
      const req = r.request();
      if (req.url() === loaded && req.method() === "GET") { const res = await w.serve(req.url(), sid); return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) }); }
      return r.abort();
    });
    const pg = await ctx.newPage();
    pg.on("request", (q: any) => { if (q.url() !== loaded || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    for (const p of w.pages) {
      sid = p.sid; loaded = BASE;
      const load = async () => { await pg.goto(loaded, { waitUntil: "load" }); requests = []; };
      await load();
      assert.match(await pg.content(), new RegExp(`data-family="${p.family === "F-14n" ? "F-14" : p.family}"`), `${p.family}: the File server drew the family page`);
      const controls: any[] = await pg.evaluate(READ);
      for (const c of controls) {
        const rec: Press = { family: p.family, label: c.label, result: "dead" };
        out.push(rec);
        if (c.disabled) { if (c.off) rec.result = "off", rec.why = c.off; else rec.why = "disabled with no reason drawn beside it"; continue; }
        await load();
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP), rowsBefore = await w.rows();
        const dl = /format=json/.test(c.href ?? "") ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await dl; await pg.waitForTimeout(150);
        const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
        if (!q) { if (after !== before && !rec.why) rec.result = "change"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
        const u = new URL(q.url);
        if (u.origin === new URL(BASE).origin) {
          const res = await w.serve(q.url, sid, { method: q.method, body: q.body, headers: q.body ? { "content-type": "application/x-www-form-urlencoded" } : {} });
          const body = await res.text(), keys = [...u.searchParams.keys()];
          if (res.status >= 400 || /Not done|not something this/i.test(body)) rec.result = "unserved", rec.why = `${q.method} ${u.search || u.pathname} answered ${res.status}`;
          else if (q.method === "GET" && keys.join() === "format" && u.searchParams.get("format") === "json" && /application\/json/.test(res.headers.get("content-type") ?? "")) rec.result = "served";
          else rec.result = "unserved", rec.why = `${q.method} ${u.search || u.pathname}: not this File's export or a served action`;
        } else if (q.url.startsWith(`${BOT}?`)) {
          const text = u.searchParams.get("text") ?? "";
          rec.result = "chat"; rec.why = text;
          if (!/^About my \S/.test(text)) rec.result = "dead", rec.why = `the chat opens with no question: "${text}"`;
          else if (await w.rows() !== rowsBefore) rec.result = "dead", rec.why = "opening the chat changed a row";
        } else if (q.url === BOT || q.url === `${BOT}/`) rec.result = "chat", rec.why = "back to chat";
        else if (u.protocol === "https:") rec.result = "source";
        else rec.why = `not https: ${q.url}`;
      }
    }
    await ctx.close();
  } finally { await browser.close(); }

  const n = (r: Press["result"]) => out.filter((x) => x.result === r).length;
  const pressed = out.filter((x) => x.result !== "off");
  const chats = out.filter((x) => x.result === "chat" && x.why !== "back to chat");
  console.log(`FILES LIVE LOOP: families ${w.pages.length}, controls ${out.length}, pressed ${pressed.length}, served ${n("served") + n("source") + n("change") + n("chat")} (exports ${n("served")}, source pages ${n("source")}, menus ${n("change")}, chat ${n("chat")}), dead ${n("dead")}, unserved ${n("unserved")}, not yet served (shown off with the reason) ${n("off")}`);
  for (const x of out.filter((x) => x.result === "dead" || x.result === "unserved")) console.log(`  ${x.result.toUpperCase()} ${x.family}: "${x.label}": ${x.why}`);
  const offBy = new Map<string, string[]>();
  for (const x of out.filter((x) => x.result === "off")) offBy.set(x.family, [...(offBy.get(x.family) ?? []), x.label]);
  console.log(`  not yet served by family: ${[...offBy].map(([f, l]) => `${f} ${l.length} (${l.join(", ")})`).join("; ")}`);
  for (const c of chats.slice(0, 3)) console.log(`  chat question, ${c.family} "${c.label}": ${c.why}`);
  assert.equal(n("dead"), 0, "dead controls");
  assert.equal(n("unserved"), 0, "unserved controls");
  // Ruling 2: the question names the File item it is about (the item's title in quotes) and the decision; nothing changed (above).
  for (const c of chats) assert.match(c.why!, /^About my .+: .+\. $/, `${c.family} "${c.label}": the chat question names the File and the decision: ${c.why}`);
  assert.ok(chats.length >= 20, `only ${chats.length} chat questions: the decisions are not reaching the chat`);
} });

// The family page is code's only (createFamily): a model's create() of the same data is never drawn as a family page; a GET (the page,
// its export) changes no row; a post on a family page, with the right cookie and page token, is refused and changes nothing (ruling 1:
// S1-S6 serve each post).
Deno.test("FILES LIVE LOOP: a model cannot make a family page; a GET changes nothing; a post on a family page is refused and changes nothing", async () => {
  const w = await world(), p = w.pages.find((x) => x.family === "F-09")!;
  const before = await w.rows();
  const page = await w.serve(BASE, p.sid), json = await w.serve(`${BASE}?format=json`, p.sid);
  assert.equal(page.status, 200); assert.match(await page.text(), /data-family="F-09"/);
  assert.equal(json.status, 200); assert.equal(JSON.parse(await json.text()).family, "F-09");
  assert.equal(await w.rows(), before, "a GET changed a row");
  for (const action of ["approveapp", "approvesend", "remove", "status"]) {
    const init = await phonePost({ t: p.sid, action }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } });
    const r = await w.handle(new Request(BASE, init));
    assert.equal(r.status, 400, `${action}: ${r.status}`);
    assert.match(await r.text(), /Nothing was changed or sent/, action);
  }
  assert.equal(await w.rows(), before, "a refused post changed a row");
  const A = signedIn(), store = memoryFileStore(), files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => SPECIMEN_NOW });
  const made = await files.create(U, "plan_review", { title: "Plan", family: "F-09", from_code: true, view: FILE_FAMILIES.find((f) => f.id === "F-09")!.specimen, variant: "pipeline",
    sections: [{ heading: "Applications", items: [{ label: "Submitted", value: "1", source: "From you" }] }] });
  assert.ok(made.ok, JSON.stringify(made));
  if (made.ok) {
    assert.ok(!store.all().some((r) => r.data?.from_code === true), "create() kept from_code");
    const deps: FileDeps = { ...A.deps, store: stub(), now: () => SPECIMEN_NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files };
    const r = await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${await A.tok(U, made.id, SPECIMEN_NOW)}` } }), deps);
    assert.doesNotMatch(await r.text(), /data-family=/, "a model-made File was drawn as a family page");
  }
});
