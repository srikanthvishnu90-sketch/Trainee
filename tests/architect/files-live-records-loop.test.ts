// FILES LIVE LOOP, record-backed families (item 6, S5): F-01 F-02 F-03 F-08 F-13 F-14 F-15 served by the real File server
// (trainee-file/handler.ts handleFile, the real file service over the in-memory store, a real signed-in phone session) from the
// person's records read at serve time (FileDeps.families: file_family_actions.ts familySource over file_family_records.ts), loaded
// in Chromium at 390 x 844, and every control pressed on a fresh load. Two people: one with records, one with none.
//
// Each press is classified as in files-live-loop.test.ts, plus the posts these pages make:
//   served   this File's own export (?format=json), or a POST with the page token that the File server answers 2xx with a page
//            saying what happened. A post must change only the person's own weekly-brief setting (the digest writer is recorded).
//   chat     the chat opens with the question filled in, naming this File; nothing changes.
//   source   an https page.   change   a menu opened on the page.
//   dead / unserved   anything else. A control shown off counts as "not yet served".
// Asserted: dead 0, unserved 0, not yet served 0 on every live page; the record changes only through the brief's pause.
//   FILES LIVE RECORDS LOOP: pages P, controls C, pressed Z, served S (exports, posts, sources, menus, chat), dead D, unserved U, not yet served N
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { LIVE_FAMILIES } from "../../supabase/functions/_shared/file_family_records.ts";
import { DRAWN_TOKEN, recordsFamilies, recordsFamily } from "../../supabase/functions/_shared/file_family_actions.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";
import { FULL, NONE, NOW } from "./files-records-fixtures.ts";

const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-live-records-0123456789", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const PEOPLE = { "33333333-3333-4333-8333-333333333333": FULL, "44444444-4444-4444-8444-444444444444": NONE } as const;
const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
  async save() { return "saved"; }, async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; },
  async wanted() { return false; } }) as unknown as FileStore;

async function world(o: { failRead?: boolean } = {}) {
  const A = signedIn(), store = memoryFileStore(), writes: [string, boolean][] = [];
  const enabled = new Map<string, boolean>();
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const familyRecords = recordsFamilies({
    now: () => NOW,
    read: async (u) => { if (o.failRead) throw new Error("records unreadable (test)"); const r = PEOPLE[u as keyof typeof PEOPLE]; return { ...r, digest: enabled.has(u) ? { ...(r.digest ?? { day: 0, hour: 18, tz: null }), enabled: enabled.get(u)! } : r.digest }; },
    digest: { async setEnabled(u, on) { writes.push([u, on]); enabled.set(u, on); } },
  });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } } as never, tap: {} as never, files, familyRecords };
  const pages: { family: string; who: string; sid: string }[] = [];
  for (const [u, r] of Object.entries(PEOPLE)) for (const f of LIVE_FAMILIES) {
    const made = await files.createFamily!(u, f, `${f} live`, null, { ref: { records: "live" } });
    if (!made.ok) throw new Error(`${f}: ${made.error}`);
    pages.push({ family: f, who: r === FULL ? "records" : "none", sid: await A.tok(u, made.id, NOW) });
  }
  const rows = () => JSON.stringify(store.all());
  const serve = (url: string, sid: string, init: { method?: string; body?: string | null } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin, ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: init.method === "POST" ? init.body ?? "" : undefined }), deps);
  return { pages, rows, serve, writes, enabled, store };
}

const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => ({ i, href: e.getAttribute("href"),
  label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? "").trim() : null, inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY" }))`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;
interface Press { family: string; who: string; label: string; result: "served" | "post" | "chat" | "source" | "change" | "off" | "dead" | "unserved"; why?: string }

Deno.test({ name: "FILES LIVE RECORDS LOOP: the seven record-backed families served from records at 390 px: none dead, none unserved, none shown off", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the Files live loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const w = await world();
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const out: Press[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
    let sid = "", requests: { method: string; url: string; body: string | null }[] = [];
    // The page is drawn by the File server; a post is recorded and aborted, then answered by the File server below.
    await ctx.route("**/*", async (r: any) => {
      const q = r.request();
      if (q.url() === BASE && q.method() === "GET") { const res = await w.serve(q.url(), sid); return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) }); }
      return r.abort();
    });
    const pg = await ctx.newPage();
    pg.on("request", (q: any) => { if (q.url() !== BASE || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    for (const p of w.pages) {
      sid = p.sid;
      const load = async () => { w.enabled.clear(); await pg.goto(BASE, { waitUntil: "load" }); requests = []; };
      await load();
      assert.match(await pg.content(), new RegExp(`data-family="${p.family}"`), `${p.family} (${p.who}): the File server drew the family page`);
      for (const c of await pg.evaluate(READ) as any[]) {
        const rec: Press = { family: p.family, who: p.who, label: c.label, result: "dead" };
        out.push(rec);
        if (c.disabled) { if (c.off) rec.result = "off", rec.why = c.off; else rec.why = "disabled with no reason drawn beside it"; continue; }
        await load();
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP), rowsBefore = w.rows(), writesBefore = w.writes.length;
        const dl = /format=json/.test(c.href ?? "") ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await dl; await pg.waitForTimeout(150);
        const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
        if (!q) { if (after !== before && !rec.why) rec.result = "change"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
        const u = new URL(q.url);
        if (u.origin === new URL(BASE).origin) {
          const res = await w.serve(q.url, sid, { method: q.method, body: q.body });
          const body = await res.text();
          if (res.status >= 400 || /Not done|not something this/i.test(body)) rec.result = "unserved", rec.why = `${q.method} ${u.search || u.pathname} answered ${res.status}`;
          else if (q.method === "GET" && [...u.searchParams.keys()].join() === "format" && /application\/json/.test(res.headers.get("content-type") ?? "")) rec.result = "served";
          else if (q.method === "POST") {
            const action = new URLSearchParams(q.body ?? "").get("action");
            const wrote = w.writes.slice(writesBefore);
            if (wrote.length !== 1 || !/^brief(pause|resume)$/.test(action ?? "") || wrote[0][1] !== (action === "briefresume")) rec.result = "unserved", rec.why = `POST ${action}: wrote ${JSON.stringify(wrote)}`;
            else if (w.rows() !== rowsBefore) rec.result = "dead", rec.why = `POST ${action} changed a File record`;
            else if (!/Weekly brief (paused|resumed)/.test(body)) rec.result = "unserved", rec.why = `POST ${action}: the page doesn't say what happened`;
            else rec.result = "post", rec.why = action!;
          } else rec.result = "unserved", rec.why = `${q.method} ${u.search || u.pathname}: not this File's export or a served action`;
        } else if (q.url.startsWith(`${BOT}?`)) {
          const text = u.searchParams.get("text") ?? "";
          rec.result = "chat"; rec.why = text;
          if (!/^About my \S.*: .+\. $/.test(text)) rec.result = "dead", rec.why = `the chat opens with no question: "${text}"`;
          else if (w.rows() !== rowsBefore || w.writes.length !== writesBefore) rec.result = "dead", rec.why = "opening the chat changed a row";
        } else if (q.url === BOT || q.url === `${BOT}/`) rec.result = "chat", rec.why = "back to chat";
        else if (u.protocol === "https:") rec.result = "source";
        else rec.why = `not https: ${q.url}`;
      }
    }
    await ctx.close();
  } finally { await browser.close(); }

  const n = (r: Press["result"]) => out.filter((x) => x.result === r).length;
  console.log(`FILES LIVE RECORDS LOOP: pages ${w.pages.length}, controls ${out.length}, pressed ${out.filter((x) => x.result !== "off").length}, served ${n("served") + n("post") + n("source") + n("change") + n("chat")} (exports ${n("served")}, posts ${n("post")}, source pages ${n("source")}, menus ${n("change")}, chat ${n("chat")}), dead ${n("dead")}, unserved ${n("unserved")}, not yet served ${n("off")}`);
  for (const x of out.filter((x) => ["dead", "unserved", "off"].includes(x.result))) console.log(`  ${x.result.toUpperCase()} ${x.family} (${x.who}): "${x.label}": ${x.why}`);
  for (const f of LIVE_FAMILIES) { const c = out.find((x) => x.family === f && x.result === "chat" && x.why !== "back to chat"); if (c) console.log(`  chat question, ${f} (${c.who}) "${c.label}": ${c.why}`); }
  assert.equal(n("dead"), 0, "dead controls");
  assert.equal(n("unserved"), 0, "unserved controls");
  assert.equal(n("off"), 0, "controls shown off on a live page");
  assert.ok(n("post") >= 1, "the weekly brief's pause was pressed and answered");
  for (const f of LIVE_FAMILIES) for (const who of ["records", "none"]) assert.ok(out.some((x) => x.family === f && x.who === who && x.result === "chat" && x.why !== "back to chat"), `${f} (${who}): a decision opens the chat`);
} });

// Without the browser: the live page reads the records now (a change shows on the next load, no stored copy); a post the family does
// not answer is refused and changes nothing; the export holds the view as served; unreadable records are the error state.
Deno.test("FILES LIVE RECORDS LOOP: a live page reads the records each time; unanswered posts are refused; unreadable records say so", async () => {
  const w = await world(), p = w.pages.find((x) => x.family === "F-14" && x.who === "records")!, page = async () => await (await w.serve(BASE, p.sid)).text();
  assert.ok(w.store.all().every((r) => r.data?.live === true && !("view" in r.data)), "a live family keeps no view in its record");
  assert.match(await page(), /name="action" value="briefpause"/);
  w.enabled.set(Object.keys(PEOPLE)[0], false);
  assert.match(await page(), /name="action" value="briefresume"/, "the next load reads the setting now");
  const token = /name="t" value="([^"]+)"/.exec(await page())![1];
  const refused = await w.serve(BASE, p.sid, { method: "POST", body: new URLSearchParams({ t: token, action: "approveapp" }).toString() });
  assert.equal(refused.status, 400); assert.match(await refused.text(), /Nothing was changed or sent/);
  const f15 = w.pages.find((x) => x.family === "F-15" && x.who === "records")!;
  const other = await w.serve(BASE, f15.sid, { method: "POST", body: new URLSearchParams({ t: token, action: "briefpause" }).toString() });
  assert.ok(other.status >= 400, "a brief post on another family's page (or with another page's token) changes nothing");
  assert.equal(w.writes.length, 0);
  const json = JSON.parse(await (await w.serve(`${BASE}?format=json`, p.sid)).text());
  assert.equal(json.family, "F-14"); assert.ok(json.view?.cadence, "the export is the view as served");
  const bad = await world({ failRead: true }), bp = bad.pages.find((x) => x.family === "F-02")!;
  const err = await (await bad.serve(BASE, bp.sid)).text();
  assert.match(err, /data-state="error"/);
  assert.doesNotMatch(err, /Unknown - not confirmed by you/, "no File is drawn from records that could not be read");
});

// The family's own load and posts (file_family_actions.ts), without the File server.
Deno.test("FILES LIVE RECORDS: the brief's pause changes only the person's own setting; no other family answers a post; unreadable is null", async () => {
  const writes: [string, boolean][] = [];
  const deps = { read: async () => FULL, now: () => NOW, digest: { async setEnabled(u: string, on: boolean) { writes.push([u, on]); } } };
  const fam = recordsFamily("F-14", deps), rec = { id: "f1", data: { family: "F-14" as const, ref: { records: "live" } } };
  const r = await fam.post!.briefpause("u1", rec, new URLSearchParams(), NOW);
  assert.ok(r.ok); assert.match(r.lines.join(" "), /Every record is kept/);
  assert.deepEqual(writes, [["u1", false]]);
  assert.equal(recordsFamily("F-15", deps).post, undefined, "no other family answers a post");
  const loaded = await fam.load("u1", rec);
  assert.ok(loaded && "view" in loaded && JSON.stringify(loaded.view).includes(`"token":"${DRAWN_TOKEN}"`), "the drawn post carries the placeholder the File server replaces with the page token");
  assert.ok((await recordsFamily("F-15", { ...deps, read: async () => NONE }).load("u1", rec)) && "state" in (await recordsFamily("F-15", { ...deps, read: async () => NONE }).load("u1", rec))!, "no offer on record: a C.24 state");
  const failing = recordsFamily("F-14", { read: async () => { throw new Error("db down"); }, now: () => NOW, digest: { async setEnabled() { throw new Error("db down"); } } });
  assert.equal(await failing.load("u1", rec), null, "unreadable records: null (the hook draws the C.24 error state), never a File from part of them");
  assert.equal((await failing.post!.briefresume("u1", rec, new URLSearchParams(), NOW)).ok, false);
});
