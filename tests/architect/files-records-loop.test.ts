// FILES RECORDS LOOP (item 6 S4; VERIFICATION-15 item 6; spec APP-LAYER-15-FIXES.md C.1, C.8, C.12, C.13, C.24): the live roles page
// (F-05), the Batch File (F-10, ?view=batch), the Pipeline (F-11, ?view=pipeline) and every Role workspace (F-06, ?role=<ref>), each
// SERVED by the real File server (trainee-file/handler.ts handleFile) from the results list's own records (the memory world of
// tests/helpers/results_world.ts: postings, prepared applications, the hash-bound queue, the employer's open questions), loaded in
// Chromium at 390 x 844 and every control pressed, each on a fresh world and a fresh load.
//
// For each press:
//   - a request to the File server is served by handleFile itself. A POST must carry the page token and an action; it is served when
//     the answer is 2xx and is not "Not done". A GET is served when it is 2xx and every query key it carries is one the server reads.
//   - the chat (TRAINEE_BOT_URL) with ?text=: the question names the File and the decision, and pressing it changes no record.
//   - an https page that is not the File server is a source link (not fetched: no network in the gate).
//   - no request but the page changed (a disclosure opened): a change.
//   - anything else is dead.
// Asserted: dead 0, unserved 0 over every page; C.1 holds on F-06, F-10 and F-11; F-10's counts are exclusive and sum to the roles.
// Printed: FILES RECORDS LOOP: pages P, controls C, pressed X, served S (posts, gets, chat, source, change), dead D, unserved U, C.1 failures A
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import type { OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { BASE, ENV, get, made, NOW, POSTINGS, post, refIn, U, world, type W } from "../helpers/results_world.ts";
import { CI, playwright } from "./r10-files-check.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const BOT = ENV.TRAINEE_BOT_URL;
const ACME_ID = POSTINGS[0].job_id, INITECH = POSTINGS[2].job_id;
// A fifth posting, so that two roles are ready at once and the batch yes is drawn.
const UMBRELLA = { ...POSTINGS[1], job_id: "lever:umbrella:5", company: "Umbrella Labs", title: "Web Platform Intern", url: "https://jobs.lever.co/umbrella/5", description: "<p>Frontend platform work. $36/hr.</p>", score: 75 };
const BOARD = [...POSTINGS, UMBRELLA];
const Q: OpenQuestion = { id: "11111111-aaaa-4aaa-8aaa-000000000009", key: "job:q9", kind: "text", label: "What is your strongest programming language?", type: "text", options: [], company: null, job_ids: [INITECH], misfit: false, answer: null } as OpenQuestion;

// The query keys the File server reads (handler.ts: searchParams.get/has), read from the source so the set grows with the server.
function servedParams(): Set<string> {
  const h = Deno.readTextFileSync(`${ROOT}/supabase/functions/trainee-file/handler.ts`);
  return new Set([...h.matchAll(/searchParams\.(?:get|has)\("([a-z_]+)"\)/g)].map((m) => m[1]));
}

// One world in a mix of states: Acme approved (queued), Globex and Umbrella ready (prepared, not approved), Initech waiting on an answer.
async function scene() {
  const w = world({ unprepared: [INITECH], postings: BOARD });
  w.qs.push({ ...Q });
  const r = await made(w);
  const s = await w.A.tok(U, r.listId, NOW);
  const html = await (await get(w, s)).text();
  const acme = refIn(html, "Frontend Engineering Intern", "Acme Web");
  const tag = /name="ref" value="([0-9a-f]+)"><input type="hidden" name="tag" value="([0-9a-f]{16})">/g;
  const tags = new Map([...html.matchAll(tag)].map((m) => [m[1], m[2]]));
  const ap = await post(w, s, { action: "apply", ref: acme, tag: tags.get(acme)! });
  assert.equal(ap.status, 200);
  assert.equal(w.queue.length, 1, "Acme approved");
  const refs = [...(await (await get(w, s)).text()).matchAll(/<li class="card" id="r-([0-9a-f]+)">/g)].map((m) => m[1]);
  return { w, s, refs };
}
const records = (w: W) => JSON.stringify([w.queue, w.saved, w.wants, w.prepared]);

const CONTROLS = "a[href], a:not([href]), button, [role=button], summary, input[type=submit]";
const READ = `[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => ({ i, tag: e.tagName.toLowerCase(), href: e.getAttribute("href"),
  label: (e.getAttribute("aria-label") || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 70), disabled: !!e.disabled,
  off: e.disabled ? (e.closest(".ff-act")?.querySelector(".ff-off")?.textContent ?? e.getAttribute("title") ?? "").trim() : null,
  inClosedMenu: !!e.closest("details:not([open])") && e.tagName !== "SUMMARY", visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) }))`;
const SNAP = `document.body.innerHTML.length + ":" + [...document.querySelectorAll("details")].map((d) => d.open ? 1 : 0).join("") + ":" + [...document.querySelectorAll("input")].map((x) => x.checked ? 1 : 0).join("") + ":" + location.href`;
// C.1 on a family page (the same checks as files-actions-loop.test.ts, on the served page).
const ANATOMY = `(() => {
  const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)], t = (e) => (e?.textContent || "").replace(/\\s+/g, " ").trim();
  return { family: q("[data-family]")?.getAttribute("data-family") ?? null, back: !!q("header.ff-head a.ff-sq[aria-label=Back][href]"), title: t(q(".ff-head .ff-ht")), sub: t(q(".ff-head .ff-hs")),
    hero: !!q(".ff-hero"), kicker: t(q(".ff-hero .ff-kick")), h1: t(q(".ff-hero .ff-h1")), heroTime: !!q(".ff-hero .ff-metas time") || !!q(".ff-hero .ff-metas [data-unconfirmed]") || /\\d{1,2}:\\d{2}\\s?[AP]M/.test(t(q(".ff-hero"))),
    barPri: qa(".ff-bar > .ff-pri, .ff-bar > .ff-act > .ff-pri, .ff-bar > form .ff-pri").length, barPriLabel: t(q(".ff-bar .ff-pri")), barSec: qa(".ff-bar .ff-two > *").length,
    filledBad: qa("[data-effect=submit],[data-effect=send],[data-effect=approve]").filter((e) => !e.classList.contains("ff-pri")).map((e) => t(e)),
    counts: qa(".ff-hero .ff-counts li b").map((b) => +t(b)), heroTitle: t(q(".ff-hero .ff-h1")) };
})()`;
function c1(page: string, a: any): string[] {
  const bad: string[] = [];
  if (!a.family) return [`${page}: not drawn as a File family`];
  if (!a.back) bad.push("header: no labelled back link");
  if (!a.title) bad.push("header: no title");
  if (["F-06", "F-10"].includes(a.family) && !/\b[A-Z]-\d+/.test(a.sub)) bad.push(`header: subtitle "${a.sub}" does not carry the File's ids`);
  if (a.family !== "F-11") { if (!a.hero) bad.push("hero: missing"); else { if (!a.kicker) bad.push("hero: no kicker"); if (!a.h1) bad.push("hero: no title"); if (!a.heroTime) bad.push("hero: no freshness time"); } }
  if (a.barPri > 1) bad.push(`action bar: ${a.barPri} filled primaries`);
  if (a.barSec > 2) bad.push(`action bar: ${a.barSec} secondaries`);
  if (a.barPri && /^(ok|okay|submit|continue|next|go|yes|confirm|done)$/i.test(a.barPriLabel)) bad.push(`action bar: primary "${a.barPriLabel}" is not named for the decision`);
  for (const f of a.filledBad) bad.push(`"${f}" approves but is not drawn filled`);
  return bad.map((b) => `${page}: C.1 ${b}`);
}

interface Press { page: string; label: string; result: "post" | "get" | "chat" | "source" | "change" | "off" | "dead" | "unserved"; why?: string }

Deno.test({ name: "FILES RECORDS LOOP: F-05, F-10, F-11 and every F-06 served from real records at 390 px: every control pressed, none dead, none unserved; C.1 holds", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw Error("the Files records loop needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  const params = servedParams();
  const first = await scene();
  const PAGES = [{ name: "F-05 roles", q: "" }, { name: "F-10 batch", q: "view=batch" }, { name: "F-11 pipeline", q: "view=pipeline" }, ...first.refs.map((r, i) => ({ name: `F-06 role ${i + 1}`, q: `role=${r}` }))];
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({ headless: true, ...(Deno.uid?.() === 0 && !CI ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
  const out: Press[] = [], c1bad: string[] = [];
  let cur = first, loaded = "", requests: { method: string; url: string; body: string | null }[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce", acceptDownloads: true });
    await ctx.route("**/*", async (r: any) => {
      const req = r.request();
      if (req.url() === loaded && req.method() === "GET") {
        const res = await handleFile(new Request(req.url(), { headers: { cookie: `tf_s=${cur.s}` } }), cur.w.deps);
        return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "text/html", body: Buffer.from(await res.arrayBuffer()) });
      }
      return r.abort();
    });
    const pg = await ctx.newPage();
    pg.on("request", (q: any) => { if (q.url() !== loaded || q.method() !== "GET") requests.push({ method: q.method(), url: q.url(), body: q.postData() }); });
    pg.on("download", (d: any) => { if (!requests.some((x) => x.url === d.url())) requests.push({ method: "GET", url: d.url(), body: null }); d.cancel().catch(() => {}); });
    for (const p of PAGES) {
      const load = async () => { cur = await scene(); loaded = `${BASE}${p.q ? `?${p.q}` : ""}`; await pg.goto(loaded, { waitUntil: "load" }); requests = []; };
      await load();
      if (p.q) { const a = await pg.evaluate(ANATOMY); c1bad.push(...c1(p.name, a));
        if (a.family === "F-10") { const roles = +(/^(\d+) roles?/.exec(a.heroTitle)?.[1] ?? NaN); assert.equal(a.counts.reduce((x: number, y: number) => x + y, 0), roles, `F-10 counts ${a.counts} sum to ${roles}`); } }
      const controls: any[] = await pg.evaluate(READ);
      for (const c of controls) {
        const rec: Press = { page: p.name, label: c.label, result: "dead" };
        out.push(rec);
        if (c.disabled) { if (c.off) rec.result = "off", rec.why = c.off; else rec.why = "disabled with no reason drawn beside it"; continue; }
        if (!c.visible && !c.inClosedMenu) { rec.result = "off", rec.why = "not visible"; continue; }
        await load();
        const loc = pg.locator(CONTROLS).nth(c.i);
        if (c.inClosedMenu) { await loc.locator("xpath=ancestor::details[1]/summary").click({ timeout: 2000 }).catch(() => {}); requests = []; }
        const before = await pg.evaluate(SNAP), rowsBefore = records(cur.w);
        await loc.click({ timeout: 2000, noWaitAfter: true }).catch((e: Error) => { rec.why = `could not be pressed: ${e.message.split("\n")[0]}`; });
        await pg.waitForTimeout(120);
        const after = await pg.evaluate(SNAP).catch(() => "navigated"), q = requests[0];
        if (!q && /^#[\w-]+$/.test(c.href ?? "") && await pg.evaluate(`!!document.getElementById(${JSON.stringify((c.href as string).slice(1))})`)) { rec.result = "change", rec.why = `in-page link to ${c.href}`; continue; }
        if (!q) { if (after !== before && !rec.why) rec.result = "change"; else rec.why ??= "pressing it made no request and changed nothing"; continue; }
        const u = new URL(q.url);
        if (u.origin === new URL(BASE).origin) {
          if (q.method === "POST") {
            const f = new URLSearchParams(q.body ?? "");
            if (!f.get("t") || !f.get("action")) { rec.why = "posted with no page token or no action"; continue; }
            const res = await handleFile(new Request(q.url, { method: "POST", body: q.body ?? "", headers: { cookie: `tf_s=${cur.s}`, origin: new URL(BASE).origin, "content-type": "application/x-www-form-urlencoded" } }), cur.w.deps);
            const body = await res.text();
            if (res.status >= 400 || /Not done|not something this page can do/i.test(body)) rec.result = "unserved", rec.why = `POST ${f.get("action")} answered ${res.status}`;
            else rec.result = "post", rec.why = f.get("action")!;
          } else {
            const keys = [...u.searchParams.keys()].filter((k) => k !== "t"), res = await handleFile(new Request(q.url, { headers: { cookie: `tf_s=${cur.s}` } }), cur.w.deps);
            if (res.status >= 400) rec.result = "unserved", rec.why = `GET ${u.search} answered ${res.status}`;
            else if (keys.some((k) => !params.has(k))) rec.result = "unserved", rec.why = `GET ${u.search}: ${keys.filter((k) => !params.has(k)).join(", ")} not read by the File server`;
            else rec.result = "get", rec.why = u.search || "/";
            await res.body?.cancel();
            if (records(cur.w) !== rowsBefore) rec.result = "dead", rec.why = `GET ${u.search} changed a record`;
          }
        } else if (q.url.startsWith(`${BOT}?`)) {
          const text = u.searchParams.get("text") ?? "";
          rec.result = "chat"; rec.why = text;
          if (!/^About my .+: .+\. $/.test(text)) rec.result = "dead", rec.why = `the chat opens with no question: "${text}"`;
          else if (records(cur.w) !== rowsBefore) rec.result = "dead", rec.why = "opening the chat changed a record";
        } else if (u.protocol === "https:") rec.result = "source", rec.why = q.url;
        else rec.why = `not https: ${q.url}`;
      }
    }
    await ctx.close();
  } finally { await browser.close(); }
  const n = (r: Press["result"]) => out.filter((x) => x.result === r).length;
  console.log(`FILES RECORDS LOOP: pages ${PAGES.length}, controls ${out.length}, pressed ${out.length - n("off")}, served ${n("post") + n("get") + n("chat") + n("source") + n("change")} (posts ${n("post")}, gets ${n("get")}, chat ${n("chat")}, source ${n("source")}, change ${n("change")}), dead ${n("dead")}, unserved ${n("unserved")}, off with a reason ${n("off")}, C.1 failures ${c1bad.length}`);
  for (const x of out.filter((x) => x.result === "dead" || x.result === "unserved")) console.log(`  ${x.result.toUpperCase()} ${x.page}: "${x.label}": ${x.why}`);
  for (const x of out.filter((x) => x.result === "off")) console.log(`  off ${x.page}: "${x.label}": ${x.why}`);
  for (const b of c1bad) console.log(`  ${b}`);
  const posts = new Map<string, number>(); for (const x of out.filter((x) => x.result === "post")) posts.set(x.why!, (posts.get(x.why!) ?? 0) + 1);
  console.log(`  posts by action: ${[...posts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  assert.equal(n("dead"), 0, "dead controls");
  assert.equal(n("unserved"), 0, "unserved controls");
  assert.equal(c1bad.length, 0, "C.1 failures");
} });

// What the posts do, through the real handler (no browser): the batch yes approves exactly the set F-10 drew; a changed set approves
// nothing; each role keeps its own state and the counts are exclusive; a GET of any view or the chat link changes no record; Pause
// takes the batch yes off; the Role workspace's yes approves that one role only and lands back on it; F-11 counts no interview or offer.
const hidden = (html: string, action: string) => {
  const f = new RegExp(`<form method="post"[^>]*>((?:(?!</form>).)*?name="action" value="${action}"(?:(?!</form>).)*?)</form>`, "s").exec(html)?.[1] ?? null;
  return f ? Object.fromEntries([...f.matchAll(/name="([a-z]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]])) : null;
};
const postAt = async (w: W, s: string, q: string, f: Record<string, string>) => {
  const init = await (await import("./file-session-fakes.ts")).phonePost({ ...f, t: s }, ENV.TRAINEE_FILE_LINK_SECRET, { headers: { origin: new URL(BASE).origin } });
  return handleFile(new Request(`${BASE}?${q}`, init), w.deps);
};
Deno.test("FILES RECORDS: F-10's yes approves exactly the ready set it drew, a changed set approves nothing, counts are exclusive; F-06 approves one role; GETs, chat and F-11 change and claim nothing", async () => {
  const { w, s, refs } = await scene();
  const before = records(w);
  const views = ["view=batch", "view=pipeline", ...refs.map((r) => `role=${r}`)];
  const pages = new Map<string, string>();
  for (const q of views) { const r = await get(w, s, q); assert.equal(r.status, 200, q); pages.set(q, await r.text()); }
  assert.equal(records(w), before, "a GET of a view changed a record");
  // F-10: four roles, one approved (Acme), two ready, one needing an answer: the counts are one per role and sum to four.
  const batch = pages.get("view=batch")!;
  assert.match(batch, /data-family="F-10"/);
  const counts = [...(/<ul class="ff-counts"[^>]*>(.*?)<\/ul>/s.exec(batch)?.[1] ?? "").matchAll(/<b>(\d+)<\/b> ([a-z ]+)/g)].map((m) => [m[2], +m[1]] as const);
  assert.deepEqual(Object.fromEntries(counts), { "in progress": 1, "not approved": 3 }, JSON.stringify(counts));
  assert.match(batch, /4 roles - 1 approved/);
  const yes = hidden(batch, "applyall");
  assert.ok(yes && !!yes.t && /^[0-9a-f]{16}$/.test(yes.set), `the batch yes is a token-carrying post bound to the set hash: ${JSON.stringify(yes)}`);
  assert.match(batch, /Approve these 2 applications/);
  // A different set: nothing is approved.
  const bad = await postAt(w, s, "view=batch", { action: "applyall", set: "0".repeat(16) });
  assert.match(await bad.text(), /This list changed since you opened it, so nothing was approved/);
  assert.equal(w.queue.length, 1, "a changed set approved something");
  // The exact set: exactly Globex and Umbrella, and the answer is the Batch File again.
  const ok = await postAt(w, s, "view=batch", { action: "applyall", set: yes!.set });
  const after = await ok.text();
  assert.match(after, /data-family="F-10"/, "the post lands back on the Batch File");
  assert.match(after, /2 of 2 approved and queued/);
  assert.deepEqual(w.queue.map((q) => q.job_id).sort(), [ACME_ID, POSTINGS[1].job_id, UMBRELLA.job_id].sort(), "exactly the shown set was approved");
  assert.ok(!w.queue.some((q) => q.job_id === INITECH), "the role that needs an answer was not approved");
  // F-06: a ready role's yes approves that role alone, bound to its tag, and lands on its workspace.
  const two = await scene();
  const role = [...two.refs].find((r) => /Approve and apply/.test(pages.get(`role=${r}`) ?? "") && /Web Platform Intern/.test(pages.get(`role=${r}`) ?? ""))!;
  const one = hidden(pages.get(`role=${role}`)!, "apply")!;
  assert.ok(one.t && one.ref === role && /^[0-9a-f]{16}$/.test(one.tag), JSON.stringify(one));
  const r1 = await postAt(two.w, two.s, `role=${role}`, { action: "apply", ref: one.ref, tag: one.tag });
  assert.match(await r1.text(), /data-family="F-06"/);
  assert.deepEqual(two.w.queue.map((q) => q.job_id).sort(), [ACME_ID, UMBRELLA.job_id].sort());
  // The chat questions name the File and the decision, and are links (no post).
  const chat = [...pages.values()].flatMap((h) => [...h.matchAll(/href="(https:\/\/t\.me\/TraineeBot\?text=[^"]+)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, "&")).searchParams.get("text")!));
  assert.ok(chat.length >= 5, `${chat.length} chat questions`);
  for (const t of chat) assert.match(t, /^About my (Role workspace|Pipeline), ".+"|^About my (Role workspace|Pipeline): /, t);
  // F-11: applications counted from the records; interviews and offers are not read, so not counted.
  const pipe = pages.get("view=pipeline")!;
  assert.match(pipe, /data-family="F-11"/);
  assert.match(pipe, /Applications <b>1<\/b>/);
  assert.doesNotMatch(pipe, /Interviews <b>|Offers <b>/);
  // Paused: the batch yes is gone and an applyall post approves nothing.
  const three = await scene();
  await postAt(three.w, three.s, "view=batch", { action: "pause" });
  const paused = await (await get(three.w, three.s, "view=batch")).text();
  assert.equal(hidden(paused, "applyall"), null, "a paused batch still offers its yes");
  assert.ok(hidden(paused, "resume"), "a paused batch offers Resume");
  const p2 = await postAt(three.w, three.s, "view=batch", { action: "applyall", set: yes!.set });
  assert.match(await p2.text(), /Paused/);
  assert.equal(three.w.queue.length, 1);
  // A role that is not on the list: the roles page says so and changes nothing.
  const none = await (await get(w, s, "role=ffffffffffff")).text();
  assert.match(none, /That role isn(?:'|&#39;)t on this list/);
});
