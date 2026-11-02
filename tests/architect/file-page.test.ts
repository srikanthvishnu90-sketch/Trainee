// The hosted jobs list page (owner, 2026-10-28): a plain list of rows (logo, company, Apply at the right, a short role description
// under it), opened by a link from the bot, logged in by Telegram identity (Mini App initData) or a signed single-user link.
// Everything runs over memory stores and a fake clock: no network, no model, no database.
import assertNode from "node:assert/strict";
import { FILE_TTL_MS, feedUrlsFor, mintFileToken, verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { initDataHash, verifyInitData } from "../../supabase/functions/_shared/telegram_webapp.ts";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, sendJobCards, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { SESSION_ID, SESSION_TTL_MS as SESSION_MS, sha256 } from "../../supabase/functions/_shared/file_session.ts";
import { signedIn } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const H = "ab".repeat(32), H2 = "cd".repeat(32), CARD = "44444444-4444-4444-8444-444444444444";
const BASE = "https://trainee.example/file", LIST = "0123456789";
const pid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

const hit = (n: number, extra: Record<string, unknown> = {}) => ({ job_id: `greenhouse:acme:${n}`, company: n === 1 ? "Acme" : `Co${n}`, title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/acme/jobs/${n}`, pay: "$90k", ...extra });
const row = (n: number, extra: Record<string, unknown> = {}) => ({ job_id: `greenhouse:acme:${n}`, provider: "greenhouse", company_domain: n === 1 ? "acme.com" : null,
  description: "<p>Build dashboards and own the weekly pricing report for the growth team.</p><p>Requirements</p><ul><li>3 years of SQL</li></ul>", ...extra });
const prepared = (n: number, hash = H): PreparedRow => ({ id: pid(n), job_id: `greenhouse:acme:${n}`, company: "Acme", url: `https://boards.greenhouse.io/acme/jobs/${n}`, payload_hash: hash, state: "ready",
  card_lines: [], payload: { resume_sha256: "f".repeat(64), resume_name: "ada-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Ada" }] } });
const appRow = (state: string, extra: Partial<AppRow> = {}): AppRow => ({ id: "j", state, reason: null, confirmation_id: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), email_confirmed_at: null, payload: {}, company: "Acme", url: "u", ...extra });

// A memory store holding user U's list of N postings (ids 1..N), each prepared unless told otherwise.
function mem(n = 3, o: { unprepared?: number[]; apps?: Record<number, AppRow>; wanted?: number[]; users?: string[] } = {}) {
  const kv = new Map<string, any>();
  const preps = new Map<number, PreparedRow | null>();
  const apps = new Map<number, AppRow>(Object.entries(o.apps ?? {}).map(([k, v]) => [Number(k), v]));
  const log = { wants: [] as number[], answered: [] as any[], opened: [] as string[] };
  const num = (jobId: string) => Number(jobId.split(":").pop());
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return kv.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, refs); },
    async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings(ids) { return ids.map((id) => row(num(id))); },
    async save() { return "saved"; },
    async prepared(u, jobId) { return u === U ? preps.get(num(jobId)) ?? null : null; },
    async applied(u, jobId) { return u === U && apps.has(num(jobId)); },
    async want(_u, job) { log.wants.push(num(job.job_id)); return { result: "queued" }; },
    async appRow(u, jobId) { return u === U ? apps.get(num(jobId)) ?? null : null; },
    async wanted(u, url) { return u === U && (o.wanted ?? []).includes(Number(url.split("/").pop())); },
  };
  const refs: string[] = [];
  const ready = (async () => {
    for (let i = 1; i <= n; i++) {
      const view = jobViewOf(hit(i), row(i));
      const ref = await refOf(U, view.job_id);
      refs.push(ref);
      await store.remember(U, ref, view, "text");
      if (!(o.unprepared ?? []).includes(i)) preps.set(i, prepared(i));
    }
    await store.rememberList(U, LIST, refs);
  })();
  return { store, log, refs, ready, preps, apps };
}
function deps(m: ReturnType<typeof mem>, o: { now?: number; hash?: (n: number) => string; env?: Record<string, string | undefined>; telegramUsers?: Record<string, string> } = {}): FileDeps {
  const hash = o.hash ?? (() => H);
  let current = 1;
  const tap: TapStore = {
    async card(_u, id) { return { id, items: [{ n: 1, prepared_id: pid(current), payload_hash: hash(current) }], state: "open", user_id: U } as any; },
    async prepared() { return [{ id: pid(current), payload_hash: hash(current), company: "Acme" }]; },
    async answer(_u, card, approve) { m.log.answered.push({ card, approve, n: current }); return approve.length ? [{ n: 1, company: "Acme", result: "queued" }] : [{ n: 1, company: "Acme", result: "declined" }]; },
  };
  const env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: "https://t.me/TraineeBot", ...(o.env ?? {}) };
  return { ...A.deps, store: m.store, now: () => o.now ?? NOW, env: { get: (k) => env[k] },
    cards: { async open(_u, ids) { m.log.opened.push(...ids); current = Number(ids[0].split("-").pop()); return { id: CARD, items: [{ n: 1, prepared_id: ids[0], payload_hash: hash(current) }], shown_at: new Date(NOW).toISOString() }; } },
    tap, userOfTelegram: async (id) => o.telegramUsers?.[id] ?? null };
}
// Sign-in (20261029230000): a server session per account, opened the way the phone code step opens one.
const A = signedIn();
const tok = async (user = U, list = LIST, now = NOW) => await A.tok(user, list, now);
const signed = async (user = U, list = LIST, now = NOW) => (await mintFileToken({ secret: SECRET, userId: user, list, now }))!;
const linkTok = async (user = U, list = LIST) => (await mintFileToken({ secret: SECRET, userId: user, list, now: NOW, kind: "l" }))!;
// A signed-in page read: the session cookie (the link itself is exchanged once, see the link tests).
const get = (d: FileDeps, t: string, extra = "") => handleFile(new Request(`https://x.example/f${extra ? "?" + extra.replace(/^&/, "") : ""}`, { headers: { cookie: `tf_s=${t}` } }), d);
const post = (d: FileDeps, f: Record<string, string>) => handleFile(new Request("https://x.example/f", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), d);
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
async function ref(n: number) { return await refOf(U, `greenhouse:acme:${n}`); }

// Telegram's own signing of Mini App data, as the documented algorithm says (an independent implementation of it here).
async function signedInit(telegramId: string, authDate: number, token = BOT, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Ada" }), ...extra });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), token), check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  p.set("hash", hash);
  return p.toString();
}

// ================================================================== tokens
Deno.test("token: binds one user and one list; expires; refuses forgery, a wrong key, garbage and a missing secret", async () => {
  const t = await signed();
  const v = await verifyFileToken(t, SECRET, NOW + 1000);
  assert(v.ok && v.claims.u === U && v.claims.r === LIST && v.claims.e === NOW + FILE_TTL_MS);
  eq(await verifyFileToken(t, SECRET, NOW + FILE_TTL_MS), { ok: false, why: "expired" });
  const other = await signed(V);
  eq(await verifyFileToken(`${other.split(".").slice(0, 2).join(".")}.${t.split(".")[2]}`, SECRET, NOW), { ok: false, why: "bad_signature" });
  eq(await verifyFileToken(t, "another-secret-0123456789-abcdef", NOW), { ok: false, why: "bad_signature" });
  for (const junk of ["", "x", "v1.a.b", null, undefined, 5]) assert(!(await verifyFileToken(junk, SECRET, NOW)).ok);
  eq(await verifyFileToken(t, undefined, NOW), { ok: false, why: "not_configured" });
  eq(await mintFileToken({ secret: undefined, userId: U, list: LIST, now: NOW }), null);
  eq(await mintFileToken({ secret: SECRET, userId: U, list: "nope", now: NOW }), null);
  const long = (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW, ttlMs: 999 * 3600_000 }))!;
  eq(await verifyFileToken(long, SECRET, NOW + 73 * 3600_000), { ok: false, why: "expired" });
});

Deno.test("links: the bot gets a Mini App URL and a signed-link fallback only when configured (https base)", async () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  eq(await feedUrlsFor(env({}), U, LIST, NOW), { webApp: null, url: null });
  eq(await feedUrlsFor(env({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "http://x.example/file" }), U, LIST, NOW), { webApp: null, url: null });
  const l = await feedUrlsFor(env({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TELEGRAM_BOT_TOKEN: BOT }), U, LIST, NOW);
  eq(l.webApp, `${BASE}?list=${LIST}`);
  assert(l.url!.startsWith(`${BASE}?t=v1.`));
  const lv = await verifyFileToken(new URL(l.url!).searchParams.get("t"), SECRET, NOW);
  assert(lv.ok && lv.claims.k === "l", "the bot's link is the single-use kind");
});

// ================================================================== Telegram initData (Mini App login)
Deno.test("initData: a correctly signed payload gives the Telegram id; tampered, wrong-bot, expired, future and malformed are refused", async () => {
  const good = await signedInit("777", NOW / 1000 - 60);
  eq(await verifyInitData(good, BOT, NOW), { ok: true, telegramId: "777", authDate: NOW / 1000 - 60 });
  eq((await initDataHash(good, BOT)).length, 64);
  // tampered: a different user id under the same hash
  const p = new URLSearchParams(good); p.set("user", JSON.stringify({ id: 888 }));
  eq(await verifyInitData(p.toString(), BOT, NOW), { ok: false, why: "bad_hash" });
  // an added field, a different bot, a stolen hash on other data
  const added = new URLSearchParams(good); added.set("start_param", "x");
  eq(await verifyInitData(added.toString(), BOT, NOW), { ok: false, why: "bad_hash" });
  eq(await verifyInitData(good, "999:OTHER-BOT-TOKEN-for-tests", NOW), { ok: false, why: "bad_hash" });
  // expired (older than an hour) and from the future
  eq(await verifyInitData(await signedInit("777", NOW / 1000 - 3601), BOT, NOW), { ok: false, why: "stale" });
  eq(await verifyInitData(await signedInit("777", NOW / 1000 + 600), BOT, NOW), { ok: false, why: "future" });
  for (const junk of ["", "hash=abc", "auth_date=1", null, undefined, 5]) assert(!(await verifyInitData(junk, BOT, NOW)).ok);
  eq(await verifyInitData(good, undefined, NOW), { ok: false, why: "not_configured" });
  eq(await verifyInitData(await signedInit("0", NOW / 1000), BOT, NOW), { ok: false, why: "missing" });
});

Deno.test("mini app: opening the page with no token serves the sign-in step; signed initData of a linked account opens that account's list; nothing else does", async () => {
  const m = mem(2); await m.ready;
  const d = deps(m, { telegramUsers: { "777": U } });
  const boot = await handleFile(new Request(`https://x.example/f?list=${LIST}`), d);
  eq(boot.status, 200);
  const bootHtml = await boot.text();
  assert(bootHtml.includes("tgWebAppData") && bootHtml.includes(`data-list="${LIST}"`) && !bootHtml.includes("Acme"), "the bootstrap page shows no job");
  assert(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(boot.headers.get("content-security-policy") ?? ""), "the inline script is allowed by hash only");
  const ok = await post(d, { list: LIST, init: await signedInit("777", NOW / 1000 - 10) });
  eq(ok.status, 200);
  const html = await ok.text();
  assert(html.includes("Acme") && html.includes("Co2"));
  const t = html.match(/name="t" value="([^"]+)"/)![1];
  assert(SESSION_ID.test(t), "an opaque server session id, never a signed token");
  const row = A.sessions.get(await sha256(t))!;
  assert(row.user_id === U && row.list === LIST && row.via === "telegram" && row.telegram_id === "777" && row.phone === null && Date.parse(row.expires_at) === NOW + SESSION_MS, "a Telegram session for the verified account only");
  assert(![...A.sessions.keys()].includes(t), "the database side holds the hash, never the id");
  // a Telegram account that is not linked, a tampered payload, an expired one
  eq((await post(d, { list: LIST, init: await signedInit("999", NOW / 1000) })).status, 403);
  const bad = new URLSearchParams(await signedInit("777", NOW / 1000)); bad.set("user", JSON.stringify({ id: 999 }));
  eq((await post(d, { list: LIST, init: bad.toString() })).status, 403);
  eq((await post(d, { list: LIST, init: await signedInit("777", NOW / 1000 - 7200) })).status, 410);
  eq((await handleFile(new Request("https://x.example/f?list=zzz"), d)).status, 403);
  // the linked account asking for another account's list id gets nothing (lists are read under the verified user)
  const other = deps(m, { telegramUsers: { "888": V } });
  const none = await post(other, { list: LIST, init: await signedInit("888", NOW / 1000) });
  eq(none.status, 404);
  assert(!(await none.text()).includes("Acme"));
});

// ================================================================== the list
Deno.test("list: a row per posting with logo or lettermark, company, Apply, and a short description; one h1; own fonts and colors; no banner, labels or bullets", async () => {
  const m = mem(10); await m.ready;
  const r = await get(deps(m), await tok());
  eq(r.status, 200);
  assert(/no-store/.test(r.headers.get("cache-control")!) && r.headers.get("referrer-policy") === "same-origin"); // same-origin (web-security round): the page's own posts carry its Origin; nothing goes to another site
  const html = await r.text();
  eq((html.match(/<li class="row"/g) ?? []).length, 10);
  eq((html.match(/<h1[ >]/g) ?? []).length, 1);
  eq((html.match(/>Apply<\/button>/g) ?? []).length, 10, "an Apply button on every row");
  assert(/alt="Acme logo"/.test(html) && html.includes("acme.com"), "logo from the employer's own domain");
  assert(/class="lettermark"[^>]*>C</.test(html), "a lettermark where there is no verified domain");
  assert(!html.includes("favicons?sz=128&amp;domain=greenhouse") && !/domain=boards\.greenhouse/.test(html));
  const text = plain(html);
  assert(text.includes("Build dashboards and own the weekly pricing report"), "short description from the posting's own text");
  for (const gone of ["From your resume", "Why this fits", "Pass", "Confirm"]) assert(!text.includes(gone), `no ${gone}`);
  assert(text.includes("Applying with: ada-resume.pdf"));
  assert(text.includes("Austin, TX · $90k · Greenhouse · Reported, not verified"), "key details with a muted source label (the fixture posting row has no location or pay, so these are search-reported)");
  assert(!/Why it fits you/.test(text), "no fit line when there are no confirmed reasons");
  assert(/<details>\s*<summary>/.test(html) && html.includes("class=\"full\""), "the full posting is behind a tap, closed by default");
  assert(!/<details[^>]* open/.test(html));
  // brand: Trainee's tokens and fonts, both themes by prefers-color-scheme
  for (const tokenValue of ["#5C2751", "#D4C2E2", "#141414", "#4F4F57", "#FAF8F4", "#E6E3DD", "#B42318", "#EDEDF0", "#A6A6B0", "#1F1F25"]) assert(html.includes(tokenValue), `brand token ${tokenValue}`);
  assert(/Brygada 1918/.test(html) && /family=Inter/.test(html) && /prefers-color-scheme:dark/.test(html) && /name="theme-color" content="#5C2751"/.test(html));
  assert(/<html lang="en"/.test(html) && /name="viewport"/.test(html) && /min-height:\s*(4[4-9]|[5-9][0-9])px/.test(html));
  assert(/script-src 'sha256-/.test(r.headers.get("content-security-policy")!) && !/unsafe-eval|script-src[^;]*unsafe-inline/.test(r.headers.get("content-security-policy")!));
  for (const img of html.matchAll(/<img\b[^>]*>/g)) assert(/\balt="[^"]+"/.test(img[0]));
});

Deno.test("list: posting text is untrusted and always escaped", async () => {
  const m = mem(1); await m.ready;
  m.store.postings = async () => [row(1, { description: `<img src=x onerror=alert(1)> 3 < 5 & "quotes" <script>alert(2)</script> and more text here` })];
  const html = await (await get(deps(m), await tok())).text();
  assert(!/<script>alert/.test(html) && !/<img src=x/.test(html));
});

Deno.test("list: the plain-text version carries every row, its state and what Apply does", async () => {
  const m = mem(3, { apps: { 2: appRow("queued") } }); await m.ready;
  const r = await get(deps(m), await tok(), "&format=text");
  assert(/^text\/plain/.test(r.headers.get("content-type")!));
  const txt = await r.text();
  for (const want of ["Applying with: ada-resume.pdf", "Apply to all: available (2 rows)", "1. Acme - Data Analyst 1", "Status: available", "2. Co2 - Data Analyst 2", "Status: queued", "Apply: closed", "Apply: available", "Posting: https://boards.greenhouse.io/acme/jobs/3"]) assert(txt.includes(want), `text has "${want}":\n${txt}`);
  assert(!/<[a-z]/i.test(txt));
});

// ================================================================== isolation and link states
Deno.test("isolation: user V's token never shows U's list, even with U's list id; no leak in any answer", async () => {
  const m = mem(2); await m.ready;
  const tv = await tok(V);
  const r = await get(deps(m), tv);
  eq(r.status, 404);
  const body = await r.text();
  for (const secret of ["Acme", "Data Analyst", "Co2", "ada-resume"]) assert(!body.includes(secret));
  const p = await post(deps(m), { t: tv, action: "apply", ref: await ref(1), tag: hashTag(H) });
  eq(p.status, 404);
  eq(m.log.answered, []);
  eq(m.log.opened, []);
  const pa = await post(deps(m), { t: tv, action: "applyall", set: "0".repeat(16) });
  eq(pa.status, 404);
  eq(m.log.answered, []);
});

Deno.test("link states: an expired session, an invalid one and an unconfigured page show a clear state, no job data, no Apply, and a 'Get a new link' button", async () => {
  const m = mem(2); await m.ready;
  const t = await tok();
  const late = await get(deps(m, { now: NOW + SESSION_MS + 5 }), t);
  eq(late.status, 401);
  const h = await late.text();
  assert(/signed out/i.test(plain(h)) && !h.includes("Acme") && !/<form/.test(h) && /href="https:\/\/t\.me\/TraineeBot"[^>]*>Get a new link</.test(h));
  eq((await get(deps(m), t.slice(0, -3) + "aaa")).status, 403);
  eq((await get(deps(m, { env: { TRAINEE_FILE_LINK_SECRET: undefined } }), t)).status, 200, "a signed-in session does not need the link secret");
  eq((await handleFile(new Request("https://x.example/f"), deps(m))).status, 403);
  eq((await post(deps(m, { now: NOW + SESSION_MS + 5 }), { t, action: "apply", ref: await ref(1), tag: hashTag(H) })).status, 401);
  eq(m.log.answered, []);
  eq((await handleFile(new Request("https://x.example/f", { method: "DELETE" }), deps(m))).status, 405);
  const off = { ...deps(m) }; delete off.sessions;
  eq((await get(off, t)).status, 503, "no session store: nothing opens");
});

// ================================================================== status words
Deno.test("status: each state flips the row to its own truthful word; 'applied' is never said before a submit", async () => {
  const cases: [string, ReturnType<typeof mem>, string][] = [
    ["approved", mem(1, { apps: { 1: appRow("queued") } }), "Queued"],
    ["preparing (wanted)", mem(1, { unprepared: [1], wanted: [1] }), "Preparing"],
    ["being sent", mem(1, { apps: { 1: appRow("driving") } }), "Sending"],
    ["submitted", mem(1, { apps: { 1: appRow("submitted_unconfirmed") } }), "Submitted"],
    ["confirmed", mem(1, { apps: { 1: appRow("confirmed", { confirmation_id: "C-123" }) } }), "Confirmed"],
    ["failed", mem(1, { apps: { 1: appRow("failed", { reason: "the form changed" }) } }), "Failed"],
    ["needs you", mem(1, { apps: { 1: appRow("needs_user", { reason: "a captcha" }) } }), "Needs you"],
  ];
  for (const [name, m, word] of cases) {
    await m.ready;
    const html = await (await get(deps(m), await tok())).text();
    assert(new RegExp(`class="chip [a-z-]+" role="status">${word}</span>`).test(html), `${name}: ${word}`);
    assert(!/>Apply<\/button>/.test(html), `${name}: no Apply button once it is in motion`);
    if (word !== "Submitted" && word !== "Confirmed") assert(!/\bapplied\b/i.test(plain(html)), `${name}: never 'applied'`);
    if (word === "Failed") assert(plain(html).includes("the form changed"));
    if (word === "Needs you") assert(plain(html).includes("a captcha"));
    if (word === "Confirmed") assert(plain(html).includes("C-123"));
  }
});

Deno.test("status: LinkedIn, Indeed and Handshake postings are never applied for; the row links out", async () => {
  const m = mem(1); await m.ready;
  const view = jobViewOf(hit(1, { url: "https://www.linkedin.com/jobs/view/1" }), row(1));
  await m.store.remember(U, await ref(1), view, "text");
  const html = await (await get(deps(m), await tok())).text();
  assert(!/>Apply<\/button>/.test(html) && /href="https:\/\/www\.linkedin\.com\/jobs\/view\/1"[^>]*>Apply there</.test(html));
  const p = await post(deps(m), { t: await tok(), action: "apply", ref: await ref(1), tag: hashTag(H) });
  assert(/apply there yourself/i.test(plain(await p.text())));
  eq(m.log.answered, []);
  eq(m.log.wants, []);
});

// ================================================================== one-tap Apply is the hash-bound approval
Deno.test("apply: one tap on a prepared row approves exactly that row's payload (once, through the card path) and flips it to Queued; other rows stay available", async () => {
  const m = mem(3); await m.ready;
  const d = deps(m);
  const t = await tok();
  const first = await (await get(d, t)).text();
  eq(m.log.answered, [], "rendering approves nothing");
  assert(first.includes(`name="tag" value="${hashTag(H)}"`));
  const r = await post(d, { t, action: "apply", ref: await ref(2), tag: hashTag(H) });
  eq(r.status, 200);
  eq(m.log.answered.length, 1);
  eq(m.log.answered[0].approve, [1]);
  eq(m.log.answered[0].n, 2, "the second row's application");
  eq(m.log.opened, [pid(2)]);
  // the store now holds the queued application: the list shows Queued on that row and Apply on the others
  m.apps.set(2, appRow("queued"));
  const after = await (await get(d, t)).text();
  eq((after.match(/>Apply<\/button>/g) ?? []).length, 2);
  assert(/>Queued<\/span>/.test(after));
  // GET never approves, whatever the query says
  await get(d, t, `&action=apply&ref=${await ref(1)}&tag=${hashTag(H)}`);
  eq(m.log.answered.length, 1);
});

Deno.test("apply: a payload that changed since the page was drawn is refused with a refresh prompt; a wrong, missing or other-row tag approves nothing", async () => {
  const m = mem(2); await m.ready;
  let h = H;
  const d = deps(m, { hash: () => h });
  const t = await tok();
  // the page was drawn with H; then the application changes underneath
  m.preps.set(1, prepared(1, H2)); h = H2;
  const r = await post(d, { t, action: "apply", ref: await ref(1), tag: hashTag(H) });
  const txt = plain(await r.text());
  assert(/Changed since you opened this page, so nothing was sent/.test(txt) && /Refresh/.test(txt));
  eq(m.log.answered, []);
  // wrong tag, missing tag, a ref that is not on the list
  for (const f of [{ tag: "0".repeat(16) }, { tag: "" }, { tag: "zz" }]) {
    await post(d, { t, action: "apply", ref: await ref(2), ...f });
  }
  const gone = await post(d, { t, action: "apply", ref: "f".repeat(12), tag: hashTag(H) });
  eq(gone.status, 404);
  eq(m.log.answered, []);
  // the refreshed page carries the new tag, and tapping it approves
  const fresh = await (await get(d, t)).text();
  assert(fresh.includes(`value="${hashTag(H2)}"`));
  await post(d, { t, action: "apply", ref: await ref(1), tag: hashTag(H2) });
  eq(m.log.answered.length, 1);
});

Deno.test("apply: a row with nothing prepared yet is queued to be prepared (Preparing), never approved or called applied", async () => {
  const m = mem(2, { unprepared: [1] }); await m.ready;
  const d = deps(m);
  const r = await post(d, { t: await tok(), action: "apply", ref: await ref(1), tag: "none" });
  eq(r.status, 200);
  eq(m.log.wants, [1]);
  eq(m.log.answered, []);
  eq(m.log.opened, []);
  // a "none" tag cannot approve a row that has a prepared application the person never saw
  await post(d, { t: await tok(), action: "apply", ref: await ref(2), tag: "none" });
  eq(m.log.answered, []);
  eq(m.log.wants, [1]);
});

Deno.test("apply: a row already in the queue is not queued twice", async () => {
  const m = mem(1, { apps: { 1: appRow("queued") } }); await m.ready;
  await post(deps(m), { t: await tok(), action: "apply", ref: await ref(1), tag: hashTag(H) });
  eq(m.log.answered, []);
  eq(m.log.wants, []);
});

Deno.test("apply: unknown actions do nothing", async () => {
  const m = mem(1); await m.ready;
  eq((await post(deps(m), { t: await tok(), action: "pass", ref: await ref(1) })).status, 400);
  eq((await post(deps(m), { t: await tok(), action: "delete" })).status, 400);
  eq(m.log.answered, []);
});

// ================================================================== Apply to all: exactly the set shown
Deno.test("apply to all: approves exactly the shown set when its hash still matches, each row bound to its own tag", async () => {
  const m = mem(4, { unprepared: [4] }); await m.ready;
  const d = deps(m);
  const t = await tok();
  const html = await (await get(d, t)).text();
  assert(/>Apply to all 3</.test(html), "only rows that can be approved are in the set");
  const set = html.match(/name="set" value="([0-9a-f]{16})"/)![1];
  const r = await post(d, { t, action: "applyall", set });
  eq(r.status, 200);
  eq(m.log.answered.map((a) => a.n).sort(), [1, 2, 3]);
  eq(m.log.opened.length, 3);
});

Deno.test("apply to all: a changed payload, a changed set or a wrong hash approves nothing and says to refresh", async () => {
  const m = mem(3); await m.ready;
  let h = H;
  const d = deps(m, { hash: () => h });
  const t = await tok();
  const html = await (await get(d, t)).text();
  const set = html.match(/name="set" value="([0-9a-f]{16})"/)![1];
  for (const bad of ["0".repeat(16), "", "x"]) {
    const r = await post(d, { t, action: "applyall", set: bad });
    assert(/changed since you opened it, so nothing was approved/.test(plain(await r.text())));
  }
  // one row's application changed after the page was drawn: the set is no longer the one shown
  m.preps.set(2, prepared(2, H2));
  const r2 = await post(d, { t, action: "applyall", set });
  assert(/changed since you opened it, so nothing was approved/.test(plain(await r2.text())));
  // one row got approved elsewhere: the set shrinks, so the old hash is refused
  m.preps.set(2, prepared(2, H)); m.apps.set(3, appRow("queued"));
  const r3 = await post(d, { t, action: "applyall", set });
  assert(/nothing was approved/.test(plain(await r3.text())));
  eq(m.log.answered, []);
  eq(m.log.opened, []);
});

Deno.test("apply to all: shown only for two or more approvable rows", async () => {
  const one = mem(3, { unprepared: [2, 3] }); await one.ready;
  assert(!/Apply to all/.test(await (await get(deps(one), await tok())).text()));
  const two = mem(2); await two.ready;
  assert(/Apply to all 2/.test(await (await get(deps(two), await tok())).text()));
});

// ================================================================== the bot's message
Deno.test("bot: a mass list is ONE short line plus the link and a Mini App button, no per-job cards; a short list keeps its cards", async () => {
  const sent: any[] = [];
  const m = mem(0); await m.ready;
  const d = deps(m);
  const send = { photo: async (a: any) => { sent.push({ kind: "photo", ...a }); return { ok: true }; }, text: async (a: any) => { sent.push({ kind: "text", ...a }); return { ok: true, id: "1" }; } };
  const full = { ...d, feedLinks: (u: string, l: string) => feedUrlsFor(d.env, u, l, NOW) };
  const many = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => hit(n));
  const res = await sendJobCards({ userId: U, hits: many, deps: full, send });
  eq(res, { sent: 1, total: 8 });
  eq(sent.length, 1);
  assert(/^8 jobs for you\. Open the list: https:\/\/trainee\.example\/file\?t=v1\./.test(sent[0].text) && sent[0].text.split("\n").length === 1);
  eq(sent[0].buttons[0][0].text, "Open the list");
  assert(sent[0].buttons[0][0].webApp.startsWith(`${BASE}?list=`));
  // the list is remembered so the page can read it, under this user only
  const listId = sent[0].buttons[0][0].webApp.split("list=")[1];
  eq((await m.store.recallList(U, listId))!.length, 8);
  eq(await m.store.recallList(V, listId), null);
  sent.length = 0;
  await sendJobCards({ userId: U, hits: [hit(1), hit(2)], deps: full, send });
  eq(sent.filter((s) => s.kind === "text" && /jobs for you/.test(s.text)).length, 0);
  assert(sent.length === 2, "two postings keep their own cards");
});

Deno.test("list: a fit line shows at most two short reasons and only when the tools gave them; a search-only figure says 'Reported, not verified'", async () => {
  const m = mem(2); await m.ready;
  const v = jobViewOf(hit(1, { fit: { reasons: ["You list SQL", "Your last role was analytics", "A third"], gaps: [] }, pay: "$95k" }), null);
  await m.store.remember(U, await ref(1), v, "text");
  m.store.postings = async (ids) => ids.map((id) => row(Number(id.split(":").pop()), id.endsWith(":1") ? { pay: null } : {}));
  const text = plain(await (await get(deps(m), await tok())).text());
  assert(text.includes("Why it fits you: You list SQL Your last role was analytics") && !text.includes("A third"));
  assert(text.includes("$95k") && text.includes("Reported, not verified"));
  assert(text.includes("Co2") && !/Co2[^]*Why it fits you[^]*$/.test(text.split("Acme")[1]?.split("Co2")[1] ?? ""), "the row without reasons has no fit line");
});

Deno.test("link preview and Mini App: og/twitter tags from real counts, theme-color, full-height viewport with safe-area insets, Telegram ready/expand with colors from the page's own background", async () => {
  const m = mem(2); await m.ready;
  const r = await get(deps(m), await tok());
  const html = await r.text();
  assert(/property="og:title" content="2 matches for you"/.test(html) && /property="og:description" content="Tap Apply on any job\. Opens in Trainee\."/.test(html));
  assert(html.includes('property="og:image" content="https://trainee.example/og-file.png"') && html.includes('og:image:width" content="1200"') && html.includes('og:image:height" content="630"') && html.includes('twitter:card" content="summary_large_image"'));
  assert(!/Acme|Co2|ada-resume/.test(html.match(/<head>[\s\S]*<\/head>/)![0]), "nothing about the person in the head tags");
  assert(/name="theme-color" content="#5C2751"/.test(html) && /viewport-fit=cover/.test(html) && /env\(safe-area-inset-bottom\)/.test(html) && /100dvh/.test(html));
  assert(html.includes('src="https://telegram.org/js/telegram-web-app.js"') && /w\.ready\(\);w\.expand\(\)/.test(html) && /setBackgroundColor/.test(html) && /setHeaderColor/.test(html));
  assert(/script-src 'sha256-[^']+' 'sha256-[^']+' https:\/\/telegram\.org/.test(r.headers.get("content-security-policy")!));
  const m1 = mem(1); await m1.ready;
  assert(/content="1 match for you"/.test(await (await get(deps(m1), await tok())).text()));
});

// ================================================================== single-use link, cookie session
Deno.test("link: the bot's link opens a phone sign-in, never the list; the pending link rides in an HttpOnly cookie and the URL is clean", async () => {
  const m = mem(2); await m.ready;
  const d = deps(m);
  const link = await linkTok();
  const r = await handleFile(new Request(`https://x.example/file?t=${encodeURIComponent(link)}`), d);
  eq(r.status, 303);
  eq(r.headers.get("location"), "/file");
  const sc = r.headers.get("set-cookie")!;
  assert(/^tf_l=v1\./.test(sc) && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc) && /Max-Age=900/.test(sc), sc);
  assert(!/tf_s=/.test(sc), "no session from a link");
  const page = await handleFile(new Request("https://x.example/file", { headers: { cookie: sc.split(";")[0] } }), d);
  eq(page.status, 200);
  const html = await page.text();
  assert(/Sign in/.test(html) && /name="phone"/.test(html) && /autocomplete="tel"/.test(html), "the phone step");
  for (const secret of ["Acme", "Data Analyst", "Co2", "ada-resume", ">Apply<", 'value="apply"', "+1512555"]) assert(!html.includes(secret), `the sign-in page shows no ${secret}`);
  assert(!/name="t"/.test(html), "no session on the sign-in page");
  // a link token is never a session: not for actions, not as a cookie
  eq((await post(d, { t: link, action: "apply", ref: await ref(1), tag: hashTag(H) })).status, 403);
  eq((await handleFile(new Request("https://x.example/file", { headers: { cookie: `tf_s=${link}` } }), d)).status, 403);
  eq(m.log.answered, []);
});

Deno.test("link: a preview crawler (Telegram) reads the brand card only, never a count or a job, and does not touch the link; an expired or forged link never sets a cookie", async () => {
  const m = mem(3); await m.ready;
  const d = deps(m);
  const link = await linkTok();
  const bot = await handleFile(new Request(`https://x.example/file?t=${encodeURIComponent(link)}`, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), d);
  eq(bot.status, 200);
  const h = await bot.text();
  assert(h.includes('og:title" content="Your jobs from Trainee"') && !/\b3\b match/.test(h) && !h.includes("Acme") && !bot.headers.get("set-cookie"));
  const jti = JSON.parse(atob(link.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).j;
  assert(!A.logins.has(jti), "the crawler began no sign-in");
  eq((await handleFile(new Request(`https://x.example/file?t=${encodeURIComponent(link)}`), d)).status, 303, "the person's own open still works");
  const late = await handleFile(new Request(`https://x.example/file?t=${encodeURIComponent(await linkTok())}`), deps(m, { now: NOW + FILE_TTL_MS + 5 }));
  eq(late.status, 410); assert(!late.headers.get("set-cookie"));
  const forged = await handleFile(new Request(`https://x.example/file?t=${encodeURIComponent((await linkTok()).slice(0, -3) + "AAA")}`), d);
  eq(forged.status, 403); assert(!forged.headers.get("set-cookie"));
});

Deno.test("headers: Mini App framing is allowed for Telegram's web clients only; img-src is the logo provider only; no wildcard framing", async () => {
  const m = mem(1); await m.ready;
  const csp = (await get(deps(m), await tok())).headers.get("content-security-policy")!;
  const fa = csp.match(/frame-ancestors ([^;]+)/)![1];
  eq(fa, "https://web.telegram.org https://*.telegram.org");
  assert(!/'none'|(^| )\*( |$)|https:( |$)|http:/.test(fa));
  const img = csp.match(/img-src ([^;]+)/)![1];
  eq(img, "https://www.google.com https://*.gstatic.com");
  assert(!/(^| )https:( |$)|data:/.test(img));
  const own = (await get(deps(m, { env: { TRAINEE_LOGO_URL: "https://logos.example/{domain}.png" } }), await tok())).headers.get("content-security-policy")!;
  eq(own.match(/img-src ([^;]+)/)![1], "https://logos.example");
  const none = (await get(deps(m, { env: { TRAINEE_LOGO_URL: "http://logos.example/{domain}.png" } }), await tok()));
  assert(/img-src 'none'/.test(none.headers.get("content-security-policy")!) && !(await none.text()).includes("<img"), "an http logo provider gives no logos at all");
});

Deno.test("escaping and logo allowlist: a hostile ref and a hostile company domain never become markup; the logo needs the employer's own domain on the configured https provider", async () => {
  const m = mem(1); await m.ready;
  const evilRef = `x"><script>alert(1)</script><b a="`;
  const view = jobViewOf(hit(1, { company_domain: `evil"onerror="alert(1).com` }), row(1, { company_domain: `evil"onerror="alert(1).com` }));
  await m.store.remember(U, evilRef, view, "text");
  await m.store.rememberList(U, LIST, [evilRef]);
  const html = await (await get(deps(m), await tok())).text();
  assert(!html.includes(evilRef) && !/<script>alert/.test(html) && !/<b a="/.test(html), "ref escaped everywhere");
  assert(html.includes("x&quot;&gt;&lt;script&gt;"));
  assert(!html.includes("<img") && /class="lettermark"[^>]*>A</.test(html), "a malformed domain gives a lettermark, not a guessed image");
  const ok = mem(1); await ok.ready;
  const h2 = await (await get(deps(ok), await tok())).text();
  const src = h2.match(/<img src="([^"]+)"/)![1].replace(/&amp;/g, "&");
  assert(new URL(src).origin === "https://www.google.com" && src.includes("domain=acme.com"));
});

// ================================================================== the approval covers only what is shown
Deno.test("what we send: the expanded row lists every value of the real payload, the collapsed row one 'Sends:' line; a secret-looking field is 'Needs you' and cannot be one-tapped", async () => {
  const m = mem(3); await m.ready;
  const p = prepared(1);
  (p.payload as any).fields = [
    { name: "first_name", label: "First name", value: "Ada" }, { name: "email", label: "Email", value: "ada@example.com" },
    { name: "work_auth", label: "Authorized to work in the US?", value: "Yes" }, { name: "resume", label: "Resume", type: "input_file", value: "ada-resume.pdf" }];
  (p.payload as any).cover_note = { text: "I built the pricing model." };
  (p.payload as any).page_field_names = ["g-recaptcha-response"];
  (p.payload as any).destination = "https://boards.greenhouse.io/acme/jobs/1/apply";
  m.preps.set(1, p);
  const sec = prepared(2);
  (sec.payload as any).fields = [{ name: "first_name", label: "First name", value: "Ada" }, { name: "account_password", label: "Account password", value: "hunter2" }];
  m.preps.set(2, sec);
  const html = await (await get(deps(m), await tok())).text();
  const rows = html.split('<li class="row"').slice(1);
  const row1 = rows[0];
  const t1 = plain(row1);
  for (const want of ["What we send", "Resume: ada-resume.pdf", "First name: Ada", "Email: ada@example.com", "Authorized to work in the US?: Yes", "Cover note: I built the pricing model.", "Also sent, set by the employer's page, unchanged: g-recaptcha-response", "Sends to: boards.greenhouse.io", "Sends: ada-resume.pdf + your saved answers"]) assert(t1.includes(want), `row shows "${want}": ${t1}`);
  assert(/<details>[\s\S]*What we send[\s\S]*<\/details>/.test(row1) && /<p class="meta">Sends: /.test(row1), "values inside the expansion, one muted line outside");
  const r2 = rows[1];
  assert(/Account password: <strong>Needs you<\/strong>/.test(r2) && !r2.includes("hunter2"), "a secret is never printed");
  assert(/class="chip needs-you"/.test(r2) && !/>Apply<\/button>/.test(r2) && !/Sends: /.test(r2));
  assert(/Apply to all 2</.test(html), "the secret row is not in the set (two approvable rows of three)");
  const set = html.match(/name="set" value="([0-9a-f]{16})"/)![1];
  await post(deps(m), { t: await tok(), action: "applyall", set });
  eq(m.log.answered.map((a) => a.n).sort(), [1, 3], "Apply to all never includes the row that needs you");
  m.log.answered.length = 0; m.log.opened.length = 0;
  const r = await post(deps(m), { t: await tok(), action: "apply", ref: await ref(2), tag: hashTag(H) });
  eq(r.status, 200);
  eq(m.log.answered, [], "a row that needs you cannot be approved by a posted tag");
  await post(deps(m), { t: await tok(), action: "apply", ref: await ref(1), tag: hashTag(H) });
  eq(m.log.answered.length, 1, "the fully shown row can");
});
