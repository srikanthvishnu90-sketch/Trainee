// FILES S3 (item 6; task f-s3): the F-04 Search plan and F-07 Materials studio Files SERVED by the real File server
// (trainee-file/handler.ts handleFile, the real file service, a real signed-in phone session) from their real records
// (career_search_plans, career_material_versions: file_family_records_materials.ts; the in-memory store keeps the database's rules, which
// tests/db/career_file_plans_materials.test.sql checks on Postgres).
//
// The bar: both live pages loaded in Chromium at 390 x 844 through that server, every control pressed on a fresh world:
//   dead 0, unserved 0, and not-yet-served 0 (no control on these two pages is shown off: approveplan, approvedoc and the
//   document download are served). Printed:
//   FILES S3 LOOP: pages P, controls C, pressed N, served S (posts, downloads, exports, chat, menus), dead D, unserved U, not yet served O
// Then, without the browser: the right hash approves; a stale hash (and a superseded plan, another role) changes nothing and says
// so; an approved document is never overwritten (approving v3 keeps v2 approved; neither row changes after); a wrong page token
// is refused; a GET changes nothing; the download is a secondary button that never looks like submit, and gives the real file.
// Check: deno test -A --no-check tests/architect/files-s3-plan-materials.test.ts
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { memoryPlanMaterialStore, planMaterialRecords } from "../../supabase/functions/_shared/file_family_records_materials.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, sha256, signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";

const NOW = Date.parse("2026-11-10T15:00:00Z");
const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", U = "44444444-4444-4444-8444-444444444444";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-s3-loop-0123456789ab", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const PDF = new TextEncoder().encode("%PDF-1.4\n% operations resume v3\n%%EOF\n");
const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
  async save() { return "saved"; }, async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; },
  async wanted() { return false; } }) as unknown as FileStore;

// The person's real records: a search plan (v1, not approved) and one resume with v2 approved for R-07 and v3 drafted for R-07.
async function world() {
  const A = signedIn(), store = memoryFileStore(), recs = memoryPlanMaterialStore();
  await recs.addPlan(U, { version: 1, title: "Climate operations search", batch_cap: 12, created_at: "2026-11-10T14:00:00Z",
    hard: [{ k: "Work arrangement", v: "US remote only", src: { kind: "you", at: "2026-11-09T15:00:00Z" } }, { k: "Role scope", v: "Individual contributor", src: { kind: "you" } }, { k: "Pay floor", v: "$80,000 base if listed", src: { kind: "you" } }],
    prefs: [{ k: "Sector", v: "Grid, solar, carbon", src: { kind: "you" } }, { k: "Company size", v: "50-500 preferred", src: { kind: "plan" } }],
    watch: { text: "Weekday mornings, quiet hours 9 PM-8 AM, stops Dec 15 or when you say stop.", active: true } });
  const doc = { doc_key: "operations-resume", doc_kind: "resume" as const, based_on: "master v6", role_job_id: "job-r07", rid: "R-07", format_check: "Dates, page flow, contact line verified" };
  await recs.addDoc(U, { ...doc, version: 2, label: "the operations resume for R-07", changes: [], created_at: "2026-11-09T12:00:00Z", file: { name: "operations-resume-v2.pdf", bytes: PDF },
    approved_at: "2026-11-09T13:00:00Z", approved_role: "job-r07" });
  await recs.addDoc(U, { ...doc, version: 3, label: "the operations resume, process work first", created_at: "2026-11-10T14:30:00Z", file: { name: "operations-resume-v3.pdf", bytes: PDF },
    changes: [{ kind: "Emphasis", after: "Reordered evidence", text: "Process-rollout bullet moved above support work. No facts changed." },
      { kind: "Wording", before: "Managed scheduling tools", after: "Led scheduling rollout, 4 teams", text: "Stronger wording of a confirmed fact - source: your resume, confirmed Oct 12." }] });
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } } as never, tap: {} as never, files, familyRecords: planMaterialRecords(recs, () => NOW) };
  const pages: { family: "F-04" | "F-07"; sid: string }[] = [];
  for (const [family, title, ref] of [["F-04", "Search plan", {}], ["F-07", "Operations resume", { doc: "operations-resume" }]] as const) {
    const made = await files.createFamily!(U, family, title, null, { ref });
    if (!made.ok) throw new Error(`${family}: ${made.error}`);
    pages.push({ family, sid: await A.tok(U, made.id, NOW) });
  }
  const rows = async () => JSON.stringify([recs.all(), store.all(), await Promise.all(pages.map(async (p) => await A.store.session(await sha256(p.sid))))]);
  const serve = (url: string, sid: string, init: { method?: string; body?: string | null } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin, ...(init.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: init.method === "POST" ? init.body ?? "" : undefined }), deps);
  const post = async (sid: string, f: Record<string, string>, token?: string) => {
    const init = await phonePost({ ...f, t: sid }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } });
    if (token !== undefined) init.body = new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(String(init.body))), t: token }).toString();
    return await handleFile(new Request(BASE, init), deps);
  };
  return { pages, rows, serve, post, recs, page: (f: "F-04" | "F-07") => pages.find((p) => p.family === f)! };
}
const formOf = (html: string, action: string) => {
  const m = html.match(new RegExp(`<form method="post"[^>]*>((?:(?!</form>).)*name="action" value="${action}"(?:(?!</form>).)*)</form>`, "s"));
  return m ? Object.fromEntries([...m[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2]])) : null;
};

const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => ({ i, href: e.getAttribute("href"), cls: e.className, effect: e.getAttribute("data-effect"),
  label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? "").trim() : null, inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY" }))`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;
type Result = "post" | "download" | "export" | "chat" | "menu" | "source" | "off" | "dead" | "unserved";

Deno.test({ name: "FILES S3 LOOP: the F-04 and F-07 pages from real records at 390 px: every control pressed; none dead, unserved or shown off", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the S3 loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const out: { family: string; label: string; result: Result; why?: string }[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
    let w = await world(), sid = "", requests: { method: string; url: string; body: string | null }[] = [];
    await ctx.route("**/*", async (r: any) => {
      const req = r.request();
      if (req.url() === BASE && req.method() === "GET") { const res = await w.serve(req.url(), sid); return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) }); }
      return r.abort();
    });
    const pg = await ctx.newPage();
    pg.on("request", (q: any) => { if (q.url() !== BASE || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    for (const family of ["F-04", "F-07"] as const) {
      // Each press on a fresh world (a fresh copy of the records), so an approval pressed once does not change what the next press sees.
      const fresh = async () => { w = await world(); sid = w.page(family).sid; await pg.goto(BASE, { waitUntil: "load" }); requests = []; };
      await fresh();
      const html = await pg.content();
      assert.match(html, new RegExp(`data-family="${family}"`), `${family}: the File server drew the family page`);
      if (family === "F-04") { assert.match(html, /Plan v1 - searching is not applying/); assert.match(html, /Hard constraints - cannot be overridden by fit score/i); assert.match(html, /Preferences - influence ranking, never gate/i); assert.match(html, /US remote only/); }
      else { assert.match(html, /Resume - for R-07 - nothing sent/); assert.match(html, /the operations resume for R-07/); assert.match(html, /the operations resume, process work first/); assert.match(html, /v2 approved/); }
      const controls: any[] = await pg.evaluate(READ);
      for (const c of controls) {
        const rec: (typeof out)[number] = { family, label: c.label, result: "dead" };
        out.push(rec);
        if (c.disabled) { rec.result = c.off ? "off" : "dead"; rec.why = c.off || "disabled with no reason drawn beside it"; continue; }
        if (c.effect === "download") assert.ok(/ff-sec/.test(c.cls) && !/ff-pri/.test(c.cls) && !/submit|apply|send/i.test(c.label), `${family} "${c.label}": a download must never look like submit (${c.cls})`);
        await fresh();
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP), rowsBefore = await w.rows();
        const dl = c.effect === "download" ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await dl; await pg.waitForTimeout(150);
        const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
        if (!q) { if (after !== before && !rec.why) rec.result = "menu"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
        const u = new URL(q.url);
        if (u.origin === new URL(BASE).origin) {
          const res = await w.serve(q.url, sid, { method: q.method, body: q.body });
          const type = res.headers.get("content-type") ?? "", disp = res.headers.get("content-disposition") ?? "", body = new Uint8Array(await res.arrayBuffer()), text = new TextDecoder().decode(body);
          if (q.method === "POST") {
            const f = new URLSearchParams(q.body ?? "");
            if (res.status === 200 && /approved/i.test(text) && /Nothing was (applied to|sent)/.test(text) && (await w.rows()) !== rowsBefore) rec.result = "post", rec.why = `${f.get("action")} v${f.get("v")}`;
            else rec.result = "unserved", rec.why = `POST ${f.get("action")} answered ${res.status}`;
          } else if (u.searchParams.has("download")) {
            if (res.status === 200 && /attachment/.test(disp) && type === "application/pdf" && Buffer.from(body).equals(Buffer.from(PDF)) && (await w.rows()) === rowsBefore) rec.result = "download";
            else rec.result = "unserved", rec.why = `download answered ${res.status} ${type}`;
          } else if ([...u.searchParams.keys()].join() === "format" && u.searchParams.get("format") === "json" && /application\/json/.test(type)) rec.result = "export";
          else rec.result = "unserved", rec.why = `${q.method} ${u.search} answered ${res.status}`;
        } else if (q.url.startsWith(`${BOT}?`)) {
          const t = u.searchParams.get("text") ?? "";
          rec.result = /^About my \S/.test(t) && (await w.rows()) === rowsBefore ? "chat" : "dead"; rec.why = t;
        } else if (q.url === BOT || q.url === `${BOT}/`) rec.result = "chat", rec.why = "back to chat";
        else if (u.protocol === "https:") rec.result = "source";
        else rec.why = `not https: ${q.url}`;
      }
    }
    await ctx.close();
  } finally { await browser.close(); }
  const n = (r: Result) => out.filter((x) => x.result === r).length;
  console.log(`FILES S3 LOOP: pages 2, controls ${out.length}, pressed ${out.length - n("off")}, served ${n("post") + n("download") + n("export") + n("chat") + n("menu") + n("source")} (posts ${n("post")}, downloads ${n("download")}, exports ${n("export")}, chat ${n("chat")}, menus ${n("menu")}, source pages ${n("source")}), dead ${n("dead")}, unserved ${n("unserved")}, not yet served ${n("off")}`);
  for (const x of out.filter((x) => ["dead", "unserved", "off"].includes(x.result))) console.log(`  ${x.result.toUpperCase()} ${x.family}: "${x.label}": ${x.why}`);
  for (const x of out.filter((x) => x.result === "post" || x.result === "download")) console.log(`  ${x.result} ${x.family}: "${x.label}"${x.why ? `: ${x.why}` : ""}`);
  assert.equal(n("dead"), 0, "dead controls"); assert.equal(n("unserved"), 0, "unserved controls"); assert.equal(n("off"), 0, "controls not yet served");
  assert.equal(out.filter((x) => x.result === "post" && x.family === "F-04").length, 1, "approveplan pressed and served");
  assert.equal(out.filter((x) => x.result === "post" && x.family === "F-07").length, 1, "approvedoc pressed and served");
  assert.equal(n("download"), 1, "the document download pressed and served");
} });

Deno.test("FILES S3: approveplan binds the hash: the right hash approves (search only); a stale hash and a superseded plan change nothing", async () => {
  const w = await world(), p = w.page("F-04");
  const before = await w.rows();
  const page = await (await w.serve(BASE, p.sid)).text();
  assert.equal(await w.rows(), before, "a GET changed a row");
  const form = formOf(page, "approveplan");
  assert.ok(form && form.v === "1" && /^[a-f0-9]{64}$/.test(form.h) && form.t, `the approve form carries the version, its hash and the page token: ${JSON.stringify(form)}`);
  // a wrong page token: refused, nothing changes
  const bad = await w.post(p.sid, { action: "approveplan", v: "1", h: form!.h }, "0".repeat(form!.t.length));
  assert.ok(bad.status >= 400, `a wrong page token: ${bad.status}`); assert.equal(await w.rows(), before, "a wrong token changed a row");
  // a stale hash: 409, nothing changes
  const stale = await w.post(p.sid, { action: "approveplan", v: "1", h: "f".repeat(64) });
  assert.equal(stale.status, 409); assert.match(await stale.text(), /nothing was approved/i); assert.equal(await w.rows(), before, "a stale hash changed a row");
  // the right hash: approved, and it says search only
  const ok = await w.post(p.sid, { action: "approveplan", v: "1", h: form!.h });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /Search plan v1 approved[\s\S]*Nothing was applied to/);
  assert.ok((await w.recs.plans(U))[0].approved_at, "v1 approved");
  const again = await (await w.serve(BASE, p.sid)).text();
  assert.equal(formOf(again, "approveplan"), null, "an approved plan offers no second approval"); assert.match(again, /You approved v1/);
  // a newer version: an approval from the old page is superseded and changes nothing
  await w.recs.addPlan(U, { version: 2, title: "Wider search", batch_cap: 20, hard: [], prefs: [], watch: null, created_at: "2026-11-10T16:00:00Z" });
  await w.recs.addPlan(U, { version: 3, title: "Wider still", batch_cap: 20, hard: [], prefs: [], watch: null, created_at: "2026-11-10T17:00:00Z" });
  const v2 = (await w.recs.plans(U)).find((x) => x.version === 2)!, mid = await w.rows();
  const sup = await w.post(p.sid, { action: "approveplan", v: "2", h: v2.payload_hash });
  assert.equal(sup.status, 409); assert.match(await sup.text(), /newer version/); assert.equal(await w.rows(), mid);
  assert.match(await (await w.serve(BASE, p.sid)).text(), /Plan v3 - searching is not applying/, "the page is drawn from the newest row, not a snapshot");
});

Deno.test("FILES S3: approvedoc binds hash and role; approving v3 never overwrites the approved v2; the download is the real file", async () => {
  const w = await world(), p = w.page("F-07");
  const page = await (await w.serve(BASE, p.sid)).text();
  const form = formOf(page, "approvedoc");
  assert.ok(form && form.doc === "operations-resume" && form.v === "3" && form.role === "job-r07" && /^[a-f0-9]{64}$/.test(form.h), JSON.stringify(form));
  assert.match(page, /data-effect="download"[^>]*>|class="ff-btn ff-sec ff-dl"/, "the download is a secondary button");
  assert.doesNotMatch(page.match(/<a class="ff-btn[^"]*ff-dl[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "", /ff-pri|Submit|Apply|Send/, "the download never looks like submit");
  const before = await w.rows();
  for (const [f, status] of [[{ ...form!, h: "e".repeat(64) }, 409], [{ ...form!, role: "job-other" }, 409], [{ ...form!, doc: "another-doc" }, 409], [{ ...form!, v: "9" }, 409]] as const) {
    const r = await w.post(p.sid, { ...f, action: "approvedoc" });
    assert.equal(r.status, status, JSON.stringify(f)); assert.match(await r.text(), /nothing was approved/i); assert.equal(await w.rows(), before, `${JSON.stringify(f)} changed a row`);
  }
  const v2Before = JSON.stringify((await w.recs.docs(U, "operations-resume")).find((x) => x.version === 2));
  const ok = await w.post(p.sid, { ...form!, action: "approvedoc" });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /the one used for this role, not any newer one[\s\S]*Earlier approved versions are kept/);
  const docs = await w.recs.docs(U, "operations-resume");
  assert.equal(JSON.stringify(docs.find((x) => x.version === 2)), v2Before, "approving v3 changed the approved v2");
  assert.ok(docs.find((x) => x.version === 3)?.approved_at, "v3 approved");
  await assert.rejects(() => w.recs.addDoc(U, { doc_key: "operations-resume", doc_kind: "resume", version: 3, label: "x", based_on: null, role_job_id: "job-r07", rid: "R-07", changes: [], format_check: null, created_at: "x" }), /never overwritten/);
  const again = await (await w.serve(BASE, p.sid)).text();
  assert.equal(formOf(again, "approvedoc"), null); assert.match(again, /approved - the one used/);
  const dl = await w.serve(`${BASE}?download=operations-resume&v=3`, p.sid);
  assert.equal(dl.status, 200); assert.match(dl.headers.get("content-disposition") ?? "", /attachment; filename="operations-resume-v3.pdf"/);
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), PDF);
  assert.equal((await w.serve(`${BASE}?download=another-doc&v=3`, p.sid)).status, 404, "another document is not downloadable from this File");
});

Deno.test("FILES S3: a File with nothing on record is the C.24 empty state; a page token for another File is refused", async () => {
  const w = await world();
  const A = signedIn(), store = memoryFileStore(), recs = memoryPlanMaterialStore(), files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const made = await files.createFamily!(U, "F-07", "Gone", null, { ref: { doc: "never-made" } });
  assert.ok(made.ok);
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files, familyRecords: planMaterialRecords(recs, () => NOW) };
  if (made.ok) {
    const r = await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${await A.tok(U, made.id, NOW)}` } }), deps);
    const html = await r.text();
    assert.equal(r.status, 200); assert.match(html, /No versions of this document on file/, "the C.24 empty state, never an invented document"); assert.equal(formOf(html, "approvedoc"), null);
  }
  // F-04's form token on the F-07 page's session: refused
  const t04 = formOf(await (await w.serve(BASE, w.page("F-04").sid)).text(), "approveplan")!.t;
  const before = await w.rows();
  const r = await w.post(w.page("F-07").sid, { action: "approvedoc", doc: "operations-resume", v: "3", role: "job-r07", h: "0".repeat(64) }, t04);
  assert.ok(r.status >= 400); assert.equal(await w.rows(), before);
});

// S0 amendment (FamilyRecords.get, spec agreed with Agent 2): the download is drawn only on a live File, and a GET for another
// person's document gives no bytes.
Deno.test("FILES S3: the document download is drawn only on a live File; another person's document is a 404 with no bytes", async () => {
  const w = await world(), p = w.page("F-07");
  // another person, signed in, with their own live F-07 File naming the same document key: none of U's bytes
  const B = "55555555-5555-4555-8555-555555555555", A = signedIn(), store = memoryFileStore();
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files, familyRecords: planMaterialRecords(w.recs, () => NOW) };
  const theirs = await files.createFamily!(B, "F-07", "Operations resume", null, { ref: { doc: "operations-resume" } });
  assert.ok(theirs.ok);
  if (theirs.ok) {
    const sid = await A.tok(B, theirs.id, NOW);
    const r = await handleFile(new Request(`${BASE}?download=operations-resume&v=3`, { headers: { cookie: `tf_s=${sid}` } }), deps);
    const body = new Uint8Array(await r.arrayBuffer());
    assert.equal(r.status, 404, "another person's document was downloadable");
    assert.ok(!new TextDecoder().decode(body).includes("%PDF"), "another person's bytes were served");
    assert.doesNotMatch(r.headers.get("content-disposition") ?? "", /attachment/);
  }
  // a stored view (not live) with the same materials: the download is this File's export, never the ?download= route
  const view = { rid: "R-07", docTitle: "Operations resume - v3", base: "master v6", draft: "v3", updatedAt: null, changes: [], format: null, usedBy: "R-07 only",
    download: { label: "Download v3", effect: "download", href: "?download=operations-resume&v=3" } };
  const stored = await files.createFamily!(B, "F-07", "Stored", view);
  assert.ok(stored.ok);
  if (stored.ok) {
    const sid = await A.tok(B, stored.id, NOW);
    const html = await (await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${sid}` } }), deps)).text();
    assert.doesNotMatch(html, /href="\?download=/, "a stored view drew the real-file download");
    assert.match(html, /href="\?format=json"[^>]*download/, "a stored view's download is the File's export");
    const g = await handleFile(new Request(`${BASE}?download=operations-resume&v=3`, { headers: { cookie: `tf_s=${sid}` } }), deps);
    assert.doesNotMatch(g.headers.get("content-disposition") ?? "", /operations-resume/, "a stored view answered the real-file GET");
  }
  // and on the live page it is drawn
  assert.match(await (await w.serve(BASE, p.sid)).text(), /href="\?download=operations-resume&amp;v=3"/);
});
