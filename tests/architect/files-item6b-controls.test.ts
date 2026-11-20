// ITEM 6(b), D-072 (2026-11-12): the 16 File page controls that were shown off ("Not available on this page yet. Ask Trainee in the
// chat.") on the served family pages, each now doing what it says. Root causes: docs/architect/reports/ITEM6B-ROOT-CAUSES-20261112.md.
//   - 11 decisions drawn with a query key the File server never read (file_family_serve.ts ASK_KEYS): each opens the chat with the
//     question filled in, naming the File and the item, as its record-backed twin already does.
//   - 5 posts (approve plan, approve document, approve submission, approve send, pause) on a page with no records behind it (a stored
//     view): never a form; each opens the chat with the question, which says nothing is approved, sent or changed until the yes to the
//     exact payload shown there (D-MS-1, D-MN-2). A post to it is still refused, unchanged.
// Part 1 ($0, no browser): the served HTML, every one of the 16, and every control on every stored-view family page (none shown off).
// Part 2 ($0, headless Chromium, desktop 1280 px; the phone 390 px pass is files-live-loop): each of the 16 pressed opens the chat with
// that question, and no row changes. Needs the gate's Playwright browser in CI.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { FILE_FAMILIES, SPECIMEN_NOW } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { isServedFamily } from "../../supabase/functions/_shared/file_family_serve.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";

const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", U = "33333333-3333-4333-8333-333333333333";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-item6b-0123456789abcd", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };

// The 16, by family: the label, the File title the question names, and the post a stored view refuses (approvals and the pause).
const SIXTEEN: { family: string; label: string; title: string; post?: string }[] = [
  { family: "F-02", label: "Review 2 conflicts", title: "Profile facts" }, { family: "F-02", label: "Stop reusing a fact", title: "Profile facts" },
  { family: "F-04", label: "Approve search scope", title: "Search plan", post: "approveplan" },
  { family: "F-07", label: "Approve v3 for R-07", title: "Materials", post: "approvedoc" }, { family: "F-07", label: "Compare changes", title: "Materials" },
  { family: "F-08", label: "Review 2 answers needed", title: "Answer library" }, { family: "F-08", label: "Use once", title: "Answer library" }, { family: "F-08", label: "Never reuse", title: "Answer library" },
  { family: "F-09", label: "Approve submission", title: "Application review", post: "approveapp" }, { family: "F-09", label: "Cancel", title: "Application review" },
  { family: "F-12", label: "Approve send", title: "Message review", post: "approvesend" },
  { family: "F-13", label: "Open prep brief", title: "Interview hub" },
  { family: "F-14", label: "Review 2 decisions", title: "Weekly brief" }, { family: "F-14", label: "Pause search", title: "Weekly brief", post: "pause" },
  { family: "F-14n", label: "Review draft", title: "Negotiation plan" }, { family: "F-14n", label: "Review the counter draft", title: "Negotiation plan" },
];

async function world() {
  const A = signedIn(), store = memoryFileStore();
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => SPECIMEN_NOW });
  const deps: FileDeps = { ...A.deps, store: {} as unknown as FileStore, now: () => SPECIMEN_NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files };
  const pages = new Map<string, string>();
  for (const f of FILE_FAMILIES) {
    if (!isServedFamily(f.id)) continue;
    const made = await files.createFamily!(U, f.id, f.name, f.specimen);
    if (!made.ok) throw new Error(`${f.id}: ${made.error}`);
    pages.set(f.id, await A.tok(U, made.id, SPECIMEN_NOW));
  }
  const get = async (sid: string) => await (await handleFile(new Request(BASE, { headers: { cookie: `tf_s=${sid}` } }), deps)).text();
  return { pages, get, store, handle: (r: Request) => handleFile(r, deps) };
}
const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// Every <a> on the page whose text is the label: its href.
function linksTo(html: string, label: string): string[] {
  return [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].filter((m) => m[2].replace(/<span aria-hidden="true">[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() === label)
    .map((m) => unesc(/href="([^"]*)"/.exec(m[1])?.[1] ?? ""));
}

Deno.test("ITEM 6B: each of the 16 controls opens the chat with its question naming the File; none shown off, none a form", async () => {
  const w = await world();
  for (const c of SIXTEEN) {
    const h = await w.get(w.pages.get(c.family)!);
    const esc = c.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(h, new RegExp(`disabled[^>]*>${esc}</button>`), `${c.family} "${c.label}": still drawn off`);
    assert.doesNotMatch(h, new RegExp(`<form method="post"[^>]*>(?:(?!</form>)[\\s\\S])*>${esc}</button>`), `${c.family} "${c.label}": a form on a page with no records`);
    const hrefs = linksTo(h, c.label);
    assert.ok(hrefs.length >= 1, `${c.family} "${c.label}": not a link`);
    for (const href of hrefs) {
      const u = new URL(href);
      assert.equal(`${u.origin}${u.pathname}`, BOT, `${c.family} "${c.label}": opens ${href}`);
      const text = u.searchParams.get("text") ?? "";
      assert.match(text, new RegExp(`^About my ${c.title}(, "[^"]+")?: ${esc}`), `${c.family} "${c.label}": the question names the File and the decision: ${text}`);
      assert.match(text, /\. $/, "the question ends as a sentence");
      // An approval, a send or a pause says nothing is done until the yes to the exact payload shown in the chat (D-MS-1).
      if (c.post) assert.match(text, /nothing is approved, sent or changed until I say yes to that/, `${c.family} "${c.label}": ${text}`);
      // The chat's yes-readers are anchored at the start of a message: a question that starts "About my" is never a yes.
      assert.doesNotMatch(text, /^(yes|y|approve|ok|sure|go ahead|do it|send)/i);
    }
  }
});

Deno.test("ITEM 6B: no control on any served stored-view family page is shown off; a post to one is still refused, unchanged", async () => {
  const w = await world();
  let controls = 0;
  for (const [fam, sid] of w.pages) {
    const h = await w.get(sid), body = h.slice(h.indexOf("<body"));
    controls += (body.match(/<a[\s>]|<button[\s>]|<summary[\s>]/g) ?? []).length;
    const off = [...body.matchAll(/disabled[^>]*>([^<]*)<\/button><span class="ff-off">([^<]*)</g)].map((m) => `${m[1]} (${m[2]})`);
    assert.deepEqual(off, [], `${fam}: shown off`);
  }
  assert.equal(controls, 99, "the measured count of stored-view family controls (files-live-loop)");
  const before = JSON.stringify(w.store.all());
  for (const c of SIXTEEN.filter((x) => x.post)) {
    const sid = w.pages.get(c.family)!;
    const r = await w.handle(new Request(BASE, await phonePost({ t: sid, action: c.post! }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } })));
    assert.equal(r.status, 400, `${c.family} ${c.post}`); assert.match(await r.text(), /Nothing was changed or sent/);
  }
  assert.equal(JSON.stringify(w.store.all()), before, "a refused post changed a row");
});

Deno.test({ name: "ITEM 6B: desktop 1280 px: each of the 16 pressed opens the chat with its question; no row changes", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the item 6b desktop check needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const w = await world();
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  let pressed = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    let sid = "";
    await ctx.route("**/*", async (r: any) => {
      const req = r.request();
      if (req.url() === BASE && req.method() === "GET") {
        const res = await w.handle(new Request(BASE, { headers: { cookie: `tf_s=${sid}` } }));
        return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) });
      }
      return r.abort();
    });
    for (const c of SIXTEEN) {
      sid = w.pages.get(c.family)!;
      const pg = await ctx.newPage();
      await pg.goto(BASE, { waitUntil: "load" });
      const asked: string[] = [];
      pg.on("request", (q: any) => { if (q.url() !== BASE) asked.push(q.url()); });
      // The served control's accessible name: "<label>: opens the chat with the question filled in..." (file_family_serve.ts servedAct).
      const loc = pg.locator(`a[aria-label^=${JSON.stringify(`${c.label}: opens the chat`)}]`).first();
      const inMenu = await loc.evaluate((e: any) => !!e.closest("details:not([open])"));
      if (inMenu) await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 });
      const box = await loc.boundingBox();
      assert.ok(box && box.width > 0 && box.x + box.width <= 1280, `${c.family} "${c.label}": visible on the desktop page`);
      const rows = JSON.stringify(w.store.all());
      await loc.click({ timeout: 2000, noWaitAfter: true });
      await pg.waitForTimeout(150);
      const q = asked[0] ?? "";
      assert.ok(q.startsWith(`${BOT}?text=`), `${c.family} "${c.label}": pressing it asked ${q || "nothing"}`);
      assert.match(new URL(q).searchParams.get("text") ?? "", new RegExp(`^About my ${c.title}`));
      assert.equal(JSON.stringify(w.store.all()), rows, `${c.family} "${c.label}": pressing it changed a row`);
      pressed++;
      await pg.close();
    }
    await ctx.close();
  } finally { await browser.close(); }
  console.log(`ITEM 6B DESKTOP: 1280 px, pressed ${pressed} of ${SIXTEEN.length}, each opened the chat with its question, rows unchanged`);
  assert.equal(pressed, SIXTEEN.length);
} });
