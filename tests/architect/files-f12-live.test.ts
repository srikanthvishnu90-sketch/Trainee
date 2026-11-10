// FILES F-12 LIVE (item 6, S2; VERIFICATION-15 item 6; D-MN-2, D-024): the F-12 People and messages File served by the real File server
// (trainee-file/handler.ts handleFile, the real file service over the in-memory store, a real signed-in phone session) from one real
// outreach draft (career_outreach.ts memoryOutreachStore, the draft saved the way the outreach turn saves one, its hash payloadHash).
// The send rail is the OUTBOX TEST MODE: a recording rail (career_send_enqueue is recorded and answered "queued"); no worker, no Gmail,
// and fetch throws for the whole file, so nothing can be sent from here.
//
//   1. The Files loop on the live F-12 page at 390 x 844: every control pressed on a fresh world; Approve send is a POST with the page
//      token, answered 2xx by the File server, and it queues exactly the words shown. Asserted: dead 0, unserved 0.
//      FILES F-12 LIVE: controls C, pressed P, served S (posts X, exports E, chat Q, menus M), dead D, unserved U, off O
//   2. The right hash: the draft is approved with approved_hash = the shown words' hash, the outbox holds exactly those words, and the
//      page then says "Approved - not sent yet", never Sent.
//   3. A stale hash (the words changed after the page was drawn), a forged hash and another draft's id are refused with the reason;
//      nothing changes and the outbox stays empty.
//   4. The page reads "Not sent" until the draft's own row says sent (with the provider's id); the exact text and the attachment are drawn.
// Check: deno test -A --no-check tests/architect/files-f12-live.test.ts
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { memoryOutreachStore, messageOf, type OutreachDraft, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { messageRecords } from "../../supabase/functions/_shared/file_family_message.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";
import { CI, playwright } from "./r10-files-check.ts";

const NOW = Date.parse("2026-11-10T15:00:00Z");
const BASE = "https://trainee.example/file", BOT = "https://t.me/TraineeBot", U = "44444444-4444-4444-8444-444444444444";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-f12-live-0123456789", TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: BOT };
const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
  async save() { return "saved"; }, async prepared() { return null; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; },
  async wanted() { return false; } }) as unknown as FileStore;
// Nothing in this file may reach the network: a send would have to.
globalThis.fetch = () => Promise.reject(new Error("no network in the F-12 test: nothing is sent"));

const DRAFT = { n: 1, recipient: { name: "Dana Lee", firm: "Example Grid Co", title: "Operations Manager", school: "", email: "dana.lee@examplegrid.com", source: "https://examplegrid.com/team", address: "published" as const },
  subject: "Operations roles at Example Grid Co", body: "Hi Dana,\n\nI read your team page and the note on grid storage planning. Would you have 15 minutes for a short call about the operations team?",
  footer: "Ada Park\n\nIf you'd rather not hear from me, reply stop and I won't write again.", shared: [], approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null };

async function world() {
  const A = signedIn(), store = memoryFileStore(), outreach = memoryOutreachStore();
  const draft = { ...DRAFT, status: "shown" as const, hash: "" } as unknown as Omit<OutreachDraft, "id" | "batch_id" | "thread_id">;
  (draft as OutreachDraft).hash = await payloadHash(messageOf(draft as OutreachDraft));
  const [d] = await outreach.saveBatch(U, null, [draft], NOW);
  // The outbox test mode: career_send_enqueue recorded and answered queued. Nothing sends: there is no worker and no Gmail.
  const outbox: { to: string; subject: string; body: string; approval_hash: string; source_id: string }[] = [];
  const rail = { drafts: (u: string, ids: string[]) => outreach.drafts!(u, ids),
    rpc: (name: string, a: { p: any }) => {
      if (name !== "career_send_enqueue") return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
      const got = a.p.items.map((x: any, i: number) => { outbox.push(x); return { source_id: x.source_id, status: "queued", id: `Q${outbox.length + i}` }; });
      return Promise.resolve({ data: got, error: null });
    } };
  const files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const deps: FileDeps = { ...A.deps, store: stub(), now: () => NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files, familyRecords: { "F-12": messageRecords({ store: outreach as never, rail }) } };
  const made = await files.createFamily!(U, "F-12", `Email to ${d.recipient.name}`, null, { ref: { draft_id: d.id } });
  if (!made.ok) throw new Error(made.error);
  const sid = await A.tok(U, made.id, NOW);
  const serve = (url: string, init: { method?: string; body?: string | null } = {}) =>
    handleFile(new Request(url, { method: init.method ?? "GET", headers: { cookie: `tf_s=${sid}`, origin: new URL(BASE).origin, ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: init.method === "POST" ? init.body ?? "" : undefined }), deps);
  const post = async (f: Record<string, string>) => await handleFile(new Request(BASE, await phonePost({ t: sid, ...f }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } })), deps);
  const row = async () => (await outreach.drafts!(U, [d.id]))[0];
  return { d, sid, outreach, outbox, serve, post, row };
}
const hashOnPage = (html: string) => html.match(/name="h" value="([0-9a-f]{64})"/)?.[1] ?? "";
const words = (html: string) => html.replace(/<(style|script|title)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => ({ i, tag: e.tagName.toLowerCase(), href: e.getAttribute("href"),
  label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? "").trim() : null, inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY" }))`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + location.href`;
interface Press { label: string; result: "post" | "export" | "chat" | "source" | "change" | "off" | "dead" | "unserved"; why?: string }

Deno.test({ name: "FILES F-12 LIVE: the F-12 page from a real draft at 390 px: every control pressed, Approve send served with the exact words, none dead, none unserved", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the F-12 live loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const out: Press[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
    let w = await world(), requests: { method: string; url: string; body: string | null }[] = [];
    await ctx.route("**/*", async (r: any) => {
      const q = r.request();
      if (q.url() === BASE && q.method() === "GET") { const res = await w.serve(BASE); return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) }); }
      return r.abort();
    });
    const pg = await ctx.newPage();
    pg.on("request", (q: any) => { if (q.url() !== BASE || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    const load = async () => { await pg.goto(BASE, { waitUntil: "load" }); requests = []; };
    await load();
    const html = await pg.content();
    assert.match(html, /data-family="F-12"/, "the File server drew F-12");
    const controls: any[] = await pg.evaluate(READ);
    for (const c of controls) {
      const rec: Press = { label: c.label, result: "dead" };
      out.push(rec);
      if (c.disabled) { if (c.off) rec.result = "off", rec.why = c.off; else rec.why = "disabled with no reason drawn beside it"; continue; }
      w = await world(); // a fresh draft, still waiting, for every press
      await load();
      const loc = pg.locator(CONTROLS).nth(c.i);
      if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
      const before = await pg.evaluate(SNAP);
      const dl = /format=json/.test(c.href ?? "") ? pg.waitForEvent("download", { timeout: 3000 }).catch(() => null) : Promise.resolve(null);
      await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
      await dl; await pg.waitForTimeout(150);
      const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
      if (!q) { if (after !== before && !rec.why) rec.result = "change"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
      const u = new URL(q.url);
      if (u.origin === new URL(BASE).origin) {
        const res = await w.serve(q.url, { method: q.method, body: q.body }), body = await res.text();
        if (q.method === "POST") {
          const f = new URLSearchParams(q.body ?? ""), r = await w.row(), m = messageOf(r);
          if (res.status >= 400 || /Not done|not something this/i.test(body)) rec.result = "unserved", rec.why = `POST ${f.get("action")} answered ${res.status}: ${words(body).slice(0, 120)}`;
          else if (f.get("action") !== "approvesend" || r.status !== "approved" || r.approved_hash !== await payloadHash(m)) rec.result = "unserved", rec.why = `POST ${f.get("action")}: the draft is ${r.status}`;
          else if (w.outbox.length !== 1 || w.outbox[0].to !== m.to || w.outbox[0].subject !== m.subject || w.outbox[0].body !== m.text) rec.result = "dead", rec.why = "the outbox does not hold exactly the approved words";
          else rec.result = "post", rec.why = words(body).slice(0, 140);
        } else if (u.searchParams.get("format") === "json" && /application\/json/.test(res.headers.get("content-type") ?? "")) rec.result = "export";
        else rec.result = "unserved", rec.why = `${q.method} ${u.search || u.pathname} answered ${res.status}`;
      } else if (q.url.startsWith(`${BOT}?`)) {
        const text = u.searchParams.get("text") ?? "";
        rec.result = /^About my .+: .+\. $/.test(text) ? "chat" : "dead"; rec.why = text;
        if ((await w.row()).status !== "shown" || w.outbox.length) rec.result = "dead", rec.why = "opening the chat changed the draft or queued a send";
      } else if (q.url === BOT || q.url === `${BOT}/`) rec.result = "chat", rec.why = "back to chat";
      else if (u.protocol === "https:") rec.result = "source";
      else rec.why = `not https: ${q.url}`;
    }
    await ctx.close();
  } finally { await browser.close(); }
  const n = (r: Press["result"]) => out.filter((x) => x.result === r).length;
  console.log(`FILES F-12 LIVE: controls ${out.length}, pressed ${out.length - n("off")}, served ${n("post") + n("export") + n("chat") + n("change") + n("source")} (posts ${n("post")}, exports ${n("export")}, chat ${n("chat")}, menus ${n("change")}, source pages ${n("source")}), dead ${n("dead")}, unserved ${n("unserved")}, off ${n("off")}`);
  for (const x of out) console.log(`  ${x.result.toUpperCase().padEnd(8)} "${x.label}"${x.why ? `: ${x.why}` : ""}`);
  assert.equal(n("dead"), 0, "dead controls");
  assert.equal(n("unserved"), 0, "unserved controls");
  assert.equal(n("post"), 1, "Approve send is served as the page's one post");
} });

Deno.test("FILES F-12 LIVE: the right hash approves exactly the shown words and queues them to the outbox; the page then says not sent yet", async () => {
  const w = await world();
  const page = await (await w.serve(BASE)).text(), h = hashOnPage(page), m = messageOf(w.d);
  assert.equal(h, await payloadHash(m), "the page carries the hash of the words it shows");
  const r = await w.post({ action: "approvesend", msg: w.d.id, h });
  assert.equal(r.status, 200);
  const said = words(await r.text());
  assert.match(said, /Approved - not sent yet/); assert.match(said, /is not sent yet/); assert.doesNotMatch(said, /\bSent\b(?! once)/);
  const row = await w.row();
  assert.equal(row.status, "approved"); assert.equal(row.approved_hash, h); assert.equal(row.approved_at, new Date(NOW).toISOString());
  assert.deepEqual(w.outbox.map((x) => [x.source_id, x.approval_hash, x.to, x.subject, x.body]), [[w.d.id, h, m.to, m.subject, m.text]], "the outbox holds exactly the approved words, once");
  const again = words(await (await w.serve(BASE)).text());
  assert.match(again, /Approved - not sent yet/); assert.doesNotMatch(again, /Message review Sent/);
  const twice = await w.post({ action: "approvesend", msg: w.d.id, h });
  assert.equal(twice.status, 409, "a second yes queues nothing more"); assert.equal(w.outbox.length, 1);
});

Deno.test("FILES F-12 LIVE: a stale hash, a forged hash and another draft's id are refused with the reason; nothing changes, nothing is queued", async () => {
  const w = await world();
  const shown = hashOnPage(await (await w.serve(BASE)).text());
  // The words change after the page was drawn (an edit in the chat): the page's hash is now stale.
  const cur = await w.row(), edited = { ...cur, body: `${cur.body} Thank you.` };
  edited.hash = await payloadHash(messageOf(edited));
  assert.ok(await w.outreach.update(U, edited, { status: "shown" }));
  const stale = await w.post({ action: "approvesend", msg: w.d.id, h: shown });
  assert.equal(stale.status, 409);
  const why = words(await stale.text());
  assert.match(why, /older version/); assert.match(why, /words of this message changed after this page was drawn/); assert.match(why, /Nothing was approved or sent/);
  for (const [f, code] of [[{ msg: w.d.id, h: "0".repeat(64) }, 409], [{ msg: w.d.id, h: "" }, 409], [{ msg: "D999", h: edited.hash }, 409]] as const) {
    const r = await w.post({ action: "approvesend", ...f });
    assert.equal(r.status, code, JSON.stringify(f)); assert.match(words(await r.text()), /Nothing was approved or sent/);
  }
  const row = await w.row();
  assert.equal(row.status, "shown"); assert.equal(row.approved_hash, null); assert.equal(row.hash, edited.hash);
  assert.equal(w.outbox.length, 0, "nothing was queued");
  // The page drawn now carries the new words and their hash, and that yes is taken.
  const fresh = await (await w.serve(BASE)).text();
  assert.equal(hashOnPage(fresh), edited.hash); assert.match(words(fresh), /Thank you\./);
  assert.equal((await w.post({ action: "approvesend", msg: w.d.id, h: edited.hash })).status, 200);
  assert.equal(w.outbox.length, 1); assert.equal(w.outbox[0].body, messageOf(edited).text);
});

Deno.test("FILES F-12 LIVE: the page draws the recipient, the exact text and the attachment, and says Not sent until the draft's row says sent", async () => {
  const w = await world(), m = messageOf(w.d);
  const html = await (await w.serve(BASE)).text(), t = words(html);
  assert.match(html, /data-family="F-12"/);
  assert.match(t, /Dana Lee - recipient verified/); assert.match(t, /dana\.lee@examplegrid\.com/);
  for (const line of [`Subject: ${m.subject}`, ...m.text.split("\n").filter(Boolean)]) assert.ok(t.includes(line.replace(/\s+/g, " ").trim()), `the exact words are drawn: ${line}`);
  assert.match(t, /Attachments None \(the send rail sends text only\)/);
  assert.match(t, /Message review Not sent/);
  assert.match(html, /<form method="post"[^>]*>.*name="action" value="approvesend".*name="msg" value="D\d+".*name="h" value="[0-9a-f]{64}"/s);
  // The rail sends later (the worker, not this page): only the row's own sent, with the provider's id, reads Sent.
  const row = await w.row();
  assert.ok(await w.outreach.update(U, { ...row, status: "sending" }, {}));
  assert.match(words(await (await w.serve(BASE)).text()), /Sending - not confirmed/);
  assert.ok(await w.outreach.update(U, { ...row, status: "sent", sent_at: "2026-11-10T16:05:00Z", gmail_id: "18c0ffee" }, {}));
  const sent = words(await (await w.serve(BASE)).text());
  assert.match(sent, /Message review Sent 2026-11-10 16:05 UTC/); assert.match(sent, /Already sent/);
  const json = JSON.parse(await (await w.serve(`${BASE}?format=json`)).text());
  assert.equal(json.family, "F-12"); assert.equal(json.view.words, `Subject: ${m.subject}\n\n${m.text}`);
});

Deno.test("FILES F-12 LIVE: a File whose draft can't be read shows the error state, never stale words, and approves nothing", async () => {
  const w = await world();
  await w.outreach.update(U, { ...(await w.row()), id: w.d.id }, {});
  // The draft is gone from the person's records (forgotten): the page loads nothing.
  (w.outreach as any).drafts = async () => [];
  const r = await w.serve(BASE);
  assert.equal(r.status, 503);
  const t = words(await r.text());
  assert.doesNotMatch(t, /Operations roles at Example Grid Co/); assert.doesNotMatch(t, /Approve send/);
  const p = await w.post({ action: "approvesend", msg: w.d.id, h: await payloadHash(messageOf(w.d)) });
  assert.equal(p.status, 409); assert.equal(w.outbox.length, 0);
});
