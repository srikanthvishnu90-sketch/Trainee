// F-09 LIVE (item 6, S1): the Application review File served by the real File server (trainee-file/handler.ts handleFile, the real
// file service over the in-memory store, a real signed-in phone session) through the S0 hook: the File names one prepared application
// (FileService.createReview over reviewOf, as application_review_links.ts makes it for every card) and FileDeps.familyRecords["F-09"]
// (file_family_review.ts reviewRecords) reads the prepared application row, the posting's title, its open questions, the resume-version
// record and the application record on every GET.
//
// 1. The page, loaded in Chromium at 390 x 844, has every control pressed on a fresh load, judged by the Files loop's rules
//    (files-actions-loop.test.ts): dead = an empty or non-http(s) link, an enabled control that makes no request and changes nothing,
//    a disabled control with no reason drawn beside it, a post with no action or no page token; unserved = a request the File server
//    does not answer (here: the request is handed to handleFile itself, with the person's cookie; a 4xx, "Not done", or a POST action
//    that is not in the handler's answered list counts). Asserted: dead 0, unserved 0, and the page shows the role, the company, the
//    resume in words (never a hash prefix), every answer with its source, and every open question named.
// 2. Right hash: approveapp with the page's hash approves exactly that prepared application at exactly that hash, once
//    (cards.confirm is called with [prepared id], [that hash]); the page then reads "Approved" and the approve control is off.
// 3. Stale hash: the prepared application changed after the page was shown; approveapp with the shown hash approves nothing, answers
//    409, and reads back both approval ids and why. A hash no review showed, or another application's id, approves nothing either.
// 4. checkstatus reads the record and changes nothing.
// Check: deno test -A --no-check tests/architect/files-review-live.test.ts
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { reviewOf } from "../../supabase/functions/_shared/application_review.ts";
import { reviewRecords } from "../../supabase/functions/_shared/file_family_review.ts";
import { SERVED_POSTS } from "../../supabase/functions/_shared/file_family_serve.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, sha256, signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", U = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-11-10T15:00:00Z");
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-review-live-0123456789", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const SHA = "ab".repeat(32), H1 = "1".repeat(64), H2 = "2".repeat(64), JOB = "lever:examplecarbon:cc-2214", PREP = "9f1c2d3e-0000-4000-8000-000000000001";
const payload = (o: Record<string, unknown> = {}) => ({
  job_id: JOB, company: "Example Carbon Co", url: "https://jobs.lever.co/examplecarbon/cc-2214", destination: "https://jobs.lever.co/examplecarbon/cc-2214/apply",
  resume_sha256: SHA, resume_tailored: true, expires_at: "2026-11-12T15:00:00Z",
  fields: [
    { name: "name", label: "Full name", value: "Sam Rivera", factId: "basics.name" },
    { name: "why", label: "Why this role?", value: "I led a scheduling rollout across 4 teams at Northwind.", factId: "text-answer:3", source: { key: "why_this_role" } },
    { name: "auth", label: "Are you authorized to work in the US?", value: "Yes", factId: "fact-7c1" },
    { name: "start", label: "Earliest start date", value: "" },
    { name: "resume", label: "Resume", type: "file", value: SHA, factId: "profile.resume" },
  ], ...o,
});

async function world(o: { ready?: boolean } = {}) {
  const A = signedIn(), kinds = memoryFileStore();
  const files = createFileService({ store: kinds, env: { get: (k) => ENV[k] }, now: () => NOW });
  const confirms: { ids: string[]; hashes: string[] }[] = [];
  let prepared = { id: PREP, job_id: JOB, company: "Example Carbon Co", url: payload().url, payload: payload(o.ready ? { fields: payload().fields.filter((f) => f.name !== "start") } : {}), payload_hash: H1,
    card_lines: [`Resume: Operations v3, tailored for this role (${SHA.slice(0, 12)})`], state: "ready", created_at: "2026-11-10T14:20:00Z" };
  let app: Record<string, unknown> | null = null;
  const store = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
    async save() { return "saved"; }, async prepared() { return prepared; }, async want() { return { result: "queued" }; }, async appRow() { return app; }, async claimLink() { return true; },
    async applied() { return !!app; }, async wanted() { return false; } } as unknown as FileStore;
  const cards = { async open() { throw new Error("no"); }, async confirm(_u: string, ids: string[], hashes: string[]) {
    confirms.push({ ids, hashes });
    if (hashes[0] !== prepared.payload_hash) throw new Error("card_changed");
    app = { id: "j1", state: "queued", reason: null, confirmation_id: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), email_confirmed_at: null, payload: prepared.payload, company: prepared.company, url: prepared.url };
    return { card: { id: "c1" }, results: [{ n: 1, result: "queued", company: prepared.company }] };
  } };
  const records = reviewRecords({
    review: () => ({ prepared: async (ids: string[]) => ids.includes(prepared.id) ? [prepared] : [], titles: async () => new Map([[JOB, "Operations Associate"]]),
      open: async () => o.ready ? [] : [{ label: "Earliest start date", job_ids: [JOB] }], versions: async () => ({ [SHA]: { n: 3, at: "2026-11-08T14:00:00Z" } }) }),
    current: async () => prepared as never, appRow: async () => app as never, cards: cards as never,
  }, () => NOW);
  const deps: FileDeps = { ...A.deps, store, now: () => NOW, env: { get: (k) => ENV[k] }, cards: cards as never, tap: {} as never, files, familyRecords: { "F-09": records } };
  // The review File exactly as the card's link makes it (application_review_links.ts: reviewOf over the prepared row, createReview).
  const made = await files.createReview!(U, reviewOf({ ...prepared, title: "Operations Associate", open: o.ready ? [] : [{ label: "Earliest start date" }] }));
  if (!made.ok) throw new Error(made.error);
  const sid = await A.tok(U, made.id, NOW);
  const rows = async () => JSON.stringify([kinds.all(), app, await A.store.session(await sha256(sid))]);
  const serve = (url: string, init: { method?: string; body?: string | null } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin, ...(init.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: init.method === "POST" ? init.body ?? "" : undefined }), deps);
  const post = async (f: Record<string, string>) => handleFile(new Request(BASE, await phonePost({ t: sid, ...f }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } })), deps);
  return { sid, serve, post, rows, confirms, change: (h: string) => { prepared = { ...prepared, payload_hash: h }; }, app: () => app, gone: () => { prepared = { ...prepared, id: "gone" }; } };
}
const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

Deno.test("F-09 LIVE: the served page shows the role, company, resume in words, every answer with its source, and the open question named", async () => {
  const w = await world();
  const res = await w.serve(BASE);
  assert.equal(res.status, 200);
  const html = await res.text(), text = visible(html);
  assert.match(html, /data-family="F-09"/);
  assert.match(text, /Operations Associate/); assert.match(text, /Example Carbon Co/);
  assert.match(text, /Operations v3 - version 3 - tailored for Operations Associate at Example Carbon Co - made Nov 8, 2026/);
  assert.doesNotMatch(text, new RegExp(SHA.slice(0, 12)), "the resume is never named by a hash prefix");
  for (const [a, src] of [["Sam Rivera", "From your confirmed profile"], ["I led a scheduling rollout across 4 teams at Northwind.", "Your answer in the chat"], ["Yes", "From a fact you confirmed"]]) {
    assert.ok(text.includes(a), `answer shown: ${a}`); assert.ok(text.includes(src), `source shown: ${src}`);
  }
  assert.match(text, /Open questions - 1 required answer not entered/); assert.match(text, /For Example Carbon Co, the form asks: "Earliest start date"/);
  assert.match(text, /Approval stays off until you answer/);
  assert.doesNotMatch(html, /name="action" value="approveapp"/, "an open required question keeps Approve off");
  assert.match(html, /name="action" value="checkstatus"/);
});

Deno.test("F-09 LIVE: right hash approves exactly that application at exactly that hash, once", async () => {
  const w = await world({ ready: true });
  const page = await (await w.serve(BASE)).text();
  assert.match(page, new RegExp(`name="action" value="approveapp"><input type="hidden" name="app" value="${PREP}"><input type="hidden" name="hash" value="${H1}">`));
  const r = await w.post({ action: "approveapp", app: PREP, hash: H1 });
  assert.equal(r.status, 200);
  const text = visible(await r.text());
  assert.deepEqual(w.confirms, [{ ids: [PREP], hashes: [H1] }]);
  assert.match(text, new RegExp(`Approved, not sent yet Approval ${H1.slice(0, 12)}, exactly as the review showed`)); assert.match(text, /Not submitted yet/);
  assert.match(visible(await (await w.serve(BASE)).text()), /Approved, not sent yet\. Nothing more is approved from this page/, "the page now shows it approved, with Approve off");
  const again = await w.post({ action: "approveapp", app: PREP, hash: H1 });
  assert.match(visible(await again.text()), /Already in your applications/);
  assert.equal(w.confirms.length, 1, "a second press approves nothing more");
});

Deno.test("F-09 LIVE: a stale hash is refused with the reason read back, and nothing is approved; a forged hash too", async () => {
  const w = await world({ ready: true });
  w.change(H2); // the application changed after this page was made
  const before = await w.rows();
  const r = await w.post({ action: "approveapp", app: PREP, hash: H1 });
  assert.equal(r.status, 409);
  const text = visible(await r.text());
  assert.match(text, /the application changed after this page was shown/);
  assert.match(text, new RegExp(`This page showed approval ${H1.slice(0, 12)}; the application on file is now approval ${H2.slice(0, 12)}`));
  assert.match(text, /Nothing was approved or sent/);
  assert.equal(w.confirms.length, 0); assert.equal(await w.rows(), before, "a refused approval changed a row");
  // A hash no review ever showed (a forged form) is refused and read back the same way; so is another application's id.
  const forged = await w.post({ action: "approveapp", app: PREP, hash: "3".repeat(64) });
  assert.equal(forged.status, 409);
  assert.match(visible(await forged.text()), new RegExp(`This page showed approval ${"3".repeat(12)}; the application on file is now approval ${H2.slice(0, 12)}.*Nothing was approved or sent`));
  const other = await w.post({ action: "approveapp", app: "9f1c2d3e-0000-4000-8000-000000000999", hash: H2 });
  assert.equal(other.status, 409); assert.match(visible(await other.text()), /That approval is not the one this page shows/);
  assert.equal(w.confirms.length, 0); assert.equal(w.app(), null);
});

Deno.test("F-09 LIVE: Check status reads the record and changes nothing", async () => {
  const w = await world({ ready: true });
  const before = await w.rows();
  const r = await w.post({ action: "checkstatus", app: PREP });
  assert.equal(r.status, 200);
  assert.match(visible(await r.text()), /Checked now: Ready for review, not submitted.*Nothing was changed/);
  assert.equal(await w.rows(), before);
});

Deno.test("F-09 LIVE: a prepared application no longer on record is the expired state, and Approve is refused", async () => {
  const w = await world({ ready: true });
  w.gone();
  const r = await w.serve(BASE), html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /data-state="expired"/); assert.doesNotMatch(html, /name="action" value="approveapp"/);
  const a = await w.post({ action: "approveapp", app: PREP, hash: H1 });
  assert.equal(a.status, 409); assert.match(visible(await a.text()), /no longer on record.*Nothing was approved or sent/);
  assert.equal(w.confirms.length, 0);
});

// ---------------------------------------------------------------- the Files loop's rules, on the served page
const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => { const form = e.closest("form"), post = !!form && (form.getAttribute("method") || "get").toLowerCase() === "post";
  return { i, tag: e.tagName.toLowerCase(), href: e.tagName === "A" ? e.getAttribute("href") : null, label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? "").trim() : null, inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY",
  inForm: post, formAction: form ? (form.querySelector("input[name=action]")?.value ?? null) : null, formToken: form ? !!form.querySelector("input[name=t]")?.value : null }; })`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;
// The POST actions the File server answers: the handler's own lists (read the way files-actions-loop.test.ts servedSet() reads them)
// and the posts the S0 hook dispatches for F-09 (SERVED_POSTS["F-09"]); each one pressed is then answered by handleFile itself.
function answered(): Set<string> {
  const handler = Deno.readTextFileSync(`${ROOT}/supabase/functions/trainee-file/handler.ts`), out = new Set<string>(SERVED_POSTS["F-09"]);
  for (const m of handler.matchAll(/\[((?:\s*"[a-z_]+",?)+)\]\.includes\(action\)/g)) for (const a of m[1].matchAll(/"([a-z_]+)"/g)) out.add(a[1]);
  for (const m of handler.matchAll(/action === "([a-z_]+)"/g)) out.add(m[1]);
  return out;
}

for (const ready of [true, false]) {
  Deno.test({ name: `F-09 LIVE LOOP (${ready ? "ready to approve" : "an open question"}): every control on the served page pressed at 390 px: dead 0, unserved 0`, sanitizeResources: false, sanitizeOps: false, async fn() {
    const pw = playwright();
    if (!pw) { if (CI) throw Error("the F-09 live loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
    const served = answered();
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    const out: { label: string; result: string; why?: string }[] = [];
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
      let w = await world({ ready }), requests: { method: string; url: string; body: string | null }[] = [];
      await ctx.route("**/*", async (r: any) => {
        const q = r.request();
        if (q.url() === BASE && q.method() === "GET") { const res = await w.serve(BASE); return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) }); }
        return r.abort();
      });
      const pg = await ctx.newPage();
      pg.on("request", (q: any) => { if (q.url() !== BASE || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
      pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
      const load = async () => { w = await world({ ready }); await pg.goto(BASE, { waitUntil: "load" }); requests = []; };
      await load();
      // C.1 (files-actions-loop.test.ts anatomy): a labelled back link, the title, the File's ids in the subtitle; a hero with a kicker,
      // a title and a freshness time; at most one filled primary and two secondaries in the bar; a submit is always drawn filled.
      const a: any = await pg.evaluate(`(() => { const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)], t = (e) => (e?.textContent || "").replace(/\\s+/g, " ").trim();
        return { back: !!q("header.ff-head a.ff-sq[aria-label=Back][href]"), title: t(q(".ff-head .ff-ht")), sub: t(q(".ff-head .ff-hs")), kicker: t(q(".ff-hero .ff-kick")), h1: t(q(".ff-hero .ff-h1")),
          time: !!q(".ff-hero .ff-metas time"), pri: qa(".ff-bar > .ff-pri, .ff-bar > .ff-act > .ff-pri, .ff-bar > form .ff-pri").length, sec: qa(".ff-bar .ff-two > *").length,
          unfilled: qa("[data-effect=submit],[data-effect=send],[data-effect=approve]").filter((e) => !e.classList.contains("ff-pri")).length }; })()`);
      const c1 = [!a.back && "no labelled back link", !a.title && "no title", !/\b[A-Z]-\w+/.test(a.sub) && `subtitle "${a.sub}" carries no ids`, !a.kicker && "no kicker", !a.h1 && "no hero title",
        !a.time && "no freshness time", a.pri > 1 && `${a.pri} filled primaries`, a.sec > 2 && `${a.sec} secondaries`, a.unfilled && "a submit not drawn filled"].filter(Boolean);
      console.log(`F-09 LIVE C.1 failures ${c1.length}${c1.length ? `: ${c1.join("; ")}` : ""}`);
      assert.deepEqual(c1, [], "C.1 holds on the served F-09 page");
      const controls: any[] = await pg.evaluate(READ);
      assert.ok(controls.length >= 6, `only ${controls.length} controls on the page`);
      for (const c of controls) {
        const rec: { label: string; result: string; why?: string } = { label: c.label, result: "dead" };
        out.push(rec);
        if (c.disabled) { if (c.off) rec.result = "off", rec.why = c.off; else rec.why = "disabled with no reason drawn beside it"; continue; }
        if (c.tag === "a" && (!c.href || c.href === "#" || !/^(https:\/\/|\?|\/(?!\/))/.test(c.href))) { rec.why = `link target "${c.href}" goes nowhere`; continue; }
        if (c.inForm && (!c.formAction || !c.formToken)) { rec.why = "form post carries no action or no page token"; continue; }
        await load();
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP);
        const dl = /format=/.test(c.href ?? "") ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await dl; await pg.waitForTimeout(150);
        const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
        if (!q) { if (after !== before && !rec.why) rec.result = "change"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
        const u = new URL(q.url);
        if (u.origin === new URL(BASE).origin) {
          const res = await w.serve(q.url, { method: q.method, body: q.body }), body = await res.text();
          const action = q.method === "POST" ? new URLSearchParams(q.body ?? "").get("action") ?? "" : "";
          if (q.method === "POST" && (!action || !new URLSearchParams(q.body ?? "").get("t"))) rec.why = "posted with no action or no page token";
          else if (q.method === "POST" && !served.has(action)) rec.result = "unserved", rec.why = `POST action "${action}" is not answered by the handler`;
          else if (res.status >= 400 || /Not done|not something this/i.test(body)) rec.result = "unserved", rec.why = `${q.method} ${u.search || action} answered ${res.status}`;
          else if (q.method === "GET" && u.searchParams.get("format") === "json" && /application\/json/.test(res.headers.get("content-type") ?? "") && JSON.parse(body).family === "F-09") rec.result = "served";
          else if (q.method === "POST" && /(Approved, not sent yet|Checked now:)/.test(body)) rec.result = "served", rec.why = visible(body).match(/(Approved, not sent yet Approval [0-9a-f]+|Checked now: [^.-]*)/)?.[0]?.trim();
          else rec.result = "unserved", rec.why = `${q.method} ${u.search || action}: not a served action or this File's text version`;
        } else if (q.url.startsWith(`${BOT}?`)) {
          const t = u.searchParams.get("text") ?? "";
          rec.result = /^About my Application review(, "[^"]+")?: .+\. $/.test(t) ? "chat" : "dead"; rec.why = t;
        } else if (q.url === BOT || q.url === `${BOT}/`) rec.result = "chat", rec.why = "back to chat";
        else if (u.protocol === "https:") rec.result = "source";
        else rec.why = `not https: ${q.url}`;
      }
      await ctx.close();
    } finally { await browser.close(); }
    const n = (r: string) => out.filter((x) => x.result === r).length;
    console.log(`F-09 LIVE LOOP (${ready ? "ready" : "open question"}): controls ${out.length}, pressed ${out.length - n("off")}, served ${n("served")}, chat ${n("chat")}, source ${n("source")}, menus ${n("change")}, dead ${n("dead")}, unserved ${n("unserved")}, off with a reason ${n("off")}`);
    for (const x of out) console.log(`  ${x.result.padEnd(8)} "${x.label}"${x.why ? `: ${x.why}` : ""}`);
    assert.equal(n("dead"), 0, "dead controls"); assert.equal(n("unserved"), 0, "unserved controls");
    assert.ok(out.some((x) => x.result === "served" && /Checked now/.test(x.why ?? "")), "Check status was pressed and served");
    if (ready) assert.ok(out.some((x) => x.result === "served" && /^Approved, not sent yet Approval/.test(x.why ?? "")), "Approve was pressed and approved");
  } });
}
