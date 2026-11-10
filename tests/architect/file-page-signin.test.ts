// trainee-file sign-in (owner, 2026-10-29): "A signed, expiring, single-use link is not proof of who opened it." The link
// opens a phone sign-in; a session starts only when a code texted to the confirmed phone of the link's account proves that
// same account; sessions are server side, revocable, and checked against the account again on every request. Each owner
// case is here: the intended flow, a forwarded link, the wrong account, an expired link, replay, revoked sessions; the job
// details, the exact payload approval and duplicate protection still hold after sign-in. Memory stores, a fake clock and a
// fake text message: no network, no model, no database.
import assertNode from "node:assert/strict";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { LOGIN_TTL_MS, MAX_CODE_SENDS, MAX_CODE_TRIES, normalizePhone, PAGE_TOKEN, sha256, SESSION_TTL_MS } from "../../supabase/functions/_shared/file_session.ts";
import { handleFile, type AppRow, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { hashTag, jobViewOf, refOf, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { fakePhone, memSessions, phonePost, sessionFor, signedInit } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const U_PHONE = "+15125550100", V_PHONE = "+15125550199", STRANGER = "+14155550123";
const NOW = Date.parse("2026-10-29T15:00:00Z");
const H = "ab".repeat(32), CARD = "44444444-4444-4444-8444-444444444444", LIST = "0123456789", LIST_V = "9876543210";
const pid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const COMPANIES = [["Acme", "acme.com"], ["Ramp", "ramp.com"], ["Figma", "figma.com"]];
const hit = (n: number) => ({ job_id: `greenhouse:co:${n}`, company: COMPANIES[n - 1][0], title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/co/jobs/${n}`, pay: "$90k" });
const row = (n: number) => ({ job_id: `greenhouse:co:${n}`, provider: "greenhouse", company_domain: COMPANIES[n - 1][1],
  description: "<p>Build dashboards and own the weekly pricing report for the growth team.</p><p>Requirements</p><ul><li>3 years of SQL</li></ul>" });
const prepared = (n: number): PreparedRow => ({ id: pid(n), job_id: `greenhouse:co:${n}`, company: COMPANIES[n - 1][0], url: `https://boards.greenhouse.io/co/jobs/${n}`, payload_hash: H, state: "ready",
  card_lines: [], payload: { resume_sha256: "f".repeat(64), resume_name: "ada-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Ada" }] } });
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const PRIVATE = ["Acme", "Ramp", "Figma", "Data Analyst", "ada-resume", "Ada", U_PHONE, "0100"];

// One world: U's list of three prepared postings, V's own list, the session store, the accounts' confirmed phones and the texts.
async function world(o: { phones?: Record<string, string | null>; smsOff?: boolean } = {}) {
  const kv = new Map<string, any>(), apps = new Map<string, AppRow>();
  const log = { answered: [] as any[], opened: [] as string[], wants: [] as string[] };
  const num = (j: string) => Number(j.split(":").pop());
  const store: FileStore = {
    async remember(u, ref, job, shownAs) { kv.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return kv.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u, id, refs) { kv.set(`${u}|list|${id}`, refs); },
    async recallList(u, id) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings(ids) { return ids.map((id) => row(num(id))); },
    async save() { return "saved"; },
    async prepared(u, jobId) { return u === U && !apps.has(jobId) ? prepared(num(jobId)) : null; },
    async applied(u, jobId) { return u === U && apps.has(jobId); },
    async want(_u, job) { log.wants.push(job.job_id); return { result: "queued" }; },
    async appRow(u, jobId) { return u === U ? apps.get(jobId) ?? null : null; },
    async wanted() { return false; },
  };
  const refs: string[] = [];
  for (let i = 1; i <= 3; i++) { const v = jobViewOf(hit(i), row(i)); const r = await refOf(U, v.job_id); refs.push(r); await store.remember(U, r, v, "text"); }
  await store.rememberList(U, LIST, refs);
  { const v = jobViewOf({ ...hit(1), company: "Vcorp" }, row(1)); const r = await refOf(V, v.job_id); await store.remember(V, r, v, "text"); await store.rememberList(V, LIST_V, [r]); }
  const S = memSessions();
  const phones: Record<string, string | null> = o.phones ?? { [U]: U_PHONE, [V]: V_PHONE };
  const P = fakePhone(phones, { configured: !o.smsOff });
  const tg: Record<string, string> = {};
  let current = 1;
  // The approval path: one card per tap, the answer recorded once per prepared row (a second tap on the same row is a duplicate).
  const tap: TapStore = {
    async card(_u, id) { return { id, items: [{ n: 1, prepared_id: pid(current), payload_hash: H }], state: "open", user_id: U } as any; },
    async prepared() { return [{ id: pid(current), payload_hash: H, company: COMPANIES[current - 1][0] }]; },
    async answer(_u, card, approve) {
      const job = `greenhouse:co:${current}`;
      if (apps.has(job)) return [{ n: 1, company: COMPANIES[current - 1][0], result: "duplicate" }];
      log.answered.push({ card, approve, n: current });
      apps.set(job, { id: `j${current}`, state: "queued", reason: null, confirmation_id: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), email_confirmed_at: null, payload: {}, company: COMPANIES[current - 1][0], url: `https://boards.greenhouse.io/co/jobs/${current}` });
      return [{ n: 1, company: COMPANIES[current - 1][0], result: "queued" }];
    },
  };
  const env: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: "https://t.me/TraineeBot" };
  const clock = { t: NOW };
  const d: FileDeps = { store, now: () => clock.t, env: { get: (k) => env[k] }, sessions: S.store, phone: P.auth, userOfTelegram: async (id) => tg[id] ?? null,
    cards: { async open(_u, ids) { log.opened.push(...ids); current = Number(ids[0].split("-").pop()); return { id: CARD, items: [{ n: 1, prepared_id: ids[0], payload_hash: H }], shown_at: new Date(clock.t).toISOString() }; } },
    tap };
  const link = async (user = U, list = LIST, at = clock.t) => (await mintFileToken({ secret: SECRET, userId: user, list, now: at, kind: "l" }))!;
  return { d, S, P, log, refs, apps, phones, tg, clock, link };
}

// A browser: keeps its own cookies (what Set-Cookie sets and clears), sends them with every request.
function browser(d: FileDeps) {
  const jar = new Map<string, string>();
  const take = (r: Response) => {
    for (const c of r.headers.getSetCookie()) { const [kv, ...attrs] = c.split(";"); const [k, v] = kv.split("="); if (attrs.some((a) => /Max-Age=0/i.test(a))) jar.delete(k.trim()); else jar.set(k.trim(), v); }
    return r;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    jar,
    open: async (path: string, ua = "Mozilla/5.0") => take(await handleFile(new Request(`https://trainee.example${path}`, { headers: { cookie: cookie(), "user-agent": ua } }), d)),
    post: async (f: Record<string, string>) => take(await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), d)),
  };
}
const fieldT = (html: string) => html.match(/name="t" value="([^"]+)"/)?.[1] ?? "";
const tagOf = (html: string, company: string) => { const m = new RegExp(`name="tag" value="([0-9a-f]{16}|none)"><button type="submit" class="apply" aria-label="Apply to [^"]+ at ${company}"`).exec(html); return m?.[1] ?? ""; };
const refIn = (html: string, company: string) => new RegExp(`name="ref" value="([^"]+)"><input type="hidden" name="tag" value="[^"]+"><button type="submit" class="apply" aria-label="Apply to [^"]+ at ${company}"`).exec(html)?.[1] ?? "";
async function signIn(w: Awaited<ReturnType<typeof world>>, b: ReturnType<typeof browser>, typed = "(512) 555-0100", l?: string) {
  eq((await b.open(`/file?t=${encodeURIComponent(l ?? await w.link())}`)).status, 303);
  const asked = await b.post({ action: "phone_start", phone: typed });
  eq(asked.status, 200);
  return { asked: await asked.text(), verify: (code: string) => b.post({ action: "phone_verify", code }) };
}

// ================================================================== the intended flow
Deno.test("flow: link -> phone number -> code texted to the account's own phone -> the list with logos, roles and details -> Apply approves that exact payload once", async () => {
  const w = await world(), b = browser(w.d);
  const first = await b.open(`/file?t=${encodeURIComponent(await w.link())}`);
  eq(first.status, 303); eq(first.headers.get("location"), "/file");
  const phonePage = await (await b.open("/file")).text();
  assert(/Sign in with your phone number/.test(plain(phonePage)) && /type="tel"/.test(phonePage));
  for (const p of PRIVATE) assert(!phonePage.includes(p), `the phone step shows nothing private (${p})`);
  const s = await signIn(w, b);
  eq(w.P.texts, [{ phone: U_PHONE, code: w.P.lastCode() }], "one text, to the account's confirmed phone");
  assert(/autocomplete="one-time-code"/.test(s.asked) && !s.asked.includes(U_PHONE), "the code step; the number is not echoed");
  const ok = await s.verify(` ${w.P.lastCode().slice(0, 3)} ${w.P.lastCode().slice(3)} `);
  eq(ok.status, 303);
  assert(b.jar.has("tf_s") && !b.jar.has("tf_l"), "a session cookie; the pending link cleared");
  const sid = b.jar.get("tf_s")!;
  const row = w.S.sessions.get(await sha256(sid))!;
  eq([row.user_id, row.via, row.phone, row.list, Date.parse(row.expires_at)], [U, "phone", U_PHONE, LIST, NOW + SESSION_TTL_MS]);
  const feed = await b.open("/file");
  eq(feed.status, 200);
  const html = await feed.text();
  for (const c of ["Acme", "Ramp", "Figma"]) assert(html.includes(c), `${c} is listed`);
  assert(/Data Analyst 1/.test(html) && /Austin, TX/.test(html) && /Build dashboards/.test(html) && /3 years of SQL/.test(html), "roles and details");
  // R16: employer-domain default. The employer's own domain, through this page's own origin; no third-party favicon service.
  assert(html.includes(`<img src="?logo=acme.com"`) && !/s2\/favicons/.test(html), "the employer's logo from its own domain");
  assert(/Sign out everywhere/.test(html));
  // Apply: the hash the row shows, the session's page token in the form (never its id: that is in the HttpOnly cookie only)
  const t = fieldT(html), tag = tagOf(html, "Acme"), ref = refIn(html, "Acme");
  assert(PAGE_TOKEN.test(t) && t !== sid && !html.includes(sid), "the page carries a page token, never the session id"); eq(tag, hashTag(H));
  const applied = await (await b.post({ t, action: "apply", ref, tag })).text();
  eq(w.log.answered.length, 1); eq(w.log.answered[0].n, 1);
  assert(/Queued/.test(applied) && !/Applied/.test(plain(applied).replace(/Applying with/g, "")), "queued, never called applied before a submit");
  // duplicate: the same Apply again sends nothing new
  await b.post({ t, action: "apply", ref, tag });
  eq(w.log.answered.length, 1, "the same posting is never approved twice");
  // a payload that changed since the page was drawn is refused
  const changed = await (await b.post({ t, action: "apply", ref: refIn(html, "Ramp"), tag: "0".repeat(16) })).text();
  assert(/Changed since you opened this page, so nothing was sent/.test(changed)); eq(w.log.answered.length, 1);
});

Deno.test("flow: any way of typing the number works; it must be the account's number", () => {
  for (const [typed, want] of [["(512) 555-0100", U_PHONE], ["+1 512 555 0100", U_PHONE], ["512.555.0100", U_PHONE], ["15125550100", U_PHONE], ["+44 20 7946 0958", "+442079460958"]] as const) eq(normalizePhone(typed), want, typed);
  for (const bad of ["", "12345", "call me", "+1 512 555 0100 ext 9", "0207 946 0958", "<script>", "5".repeat(40)]) eq(normalizePhone(bad), null, bad);
});

// ================================================================== a forwarded or copied link
Deno.test("forwarded link: whoever opens it gets a sign-in, never the list; their own number gets no text; guessing locks the link; nothing applies", async () => {
  const w = await world(), stranger = browser(w.d);
  const l = await w.link();
  const s = await signIn(w, stranger, STRANGER, l);
  eq(w.P.texts, [], "no text to the stranger's number (and none to anyone)");
  assert(/If that is the number on your Trainee account, we texted it a code/.test(plain(s.asked)), "the same answer as for the right number: the link never says whose it is");
  for (const p of PRIVATE) assert(!s.asked.includes(p), `nothing private (${p})`);
  for (let i = 0; i < MAX_CODE_TRIES; i++) eq((await s.verify(String(100000 + i))).status, 401);
  const locked = await s.verify("314166");
  eq(locked.status, 429);
  assert(!stranger.jar.has("tf_s"));
  // locked for every step: the page, a new number, a new text; and the list, a cookie-less action and every read: nothing
  const page = await stranger.open("/file");
  eq(page.status, 429); assert(!/name="code"|name="phone"/.test(await page.text()));
  eq((await stranger.post({ action: "phone_start", phone: U_PHONE })).status, 429);
  eq(w.P.texts, [], "still no text to anyone");
  eq(w.log.answered, []); eq(w.log.opened, []);
});

Deno.test("forwarded link: a stranger who knows the person's number can trigger a text to the PERSON only, and cannot use it", async () => {
  const w = await world(), stranger = browser(w.d);
  const s = await signIn(w, stranger, U_PHONE);
  eq(w.P.texts.map((x) => x.phone), [U_PHONE], "the code went to the person's own phone");
  eq((await s.verify("000000")).status, 401);
  assert(!stranger.jar.has("tf_s"));
  for (let i = 0; i < MAX_CODE_SENDS + 2; i++) await stranger.post({ action: "phone_start", phone: U_PHONE });
  eq(w.P.texts.length, MAX_CODE_SENDS, "at most three texts per link");
});

// ================================================================== the wrong account
Deno.test("wrong account: a browser signed in as V opens U's link and sees nothing of U; V's own phone and V's own valid code cannot open U's list", async () => {
  const w = await world(), b = browser(w.d);
  // V signs in to V's own list
  const sv = await signIn(w, b, V_PHONE, await w.link(V, LIST_V));
  eq((await sv.verify(w.P.lastCode())).status, 303);
  assert((await (await b.open("/file")).text()).includes("Vcorp"));
  // U's link in V's browser: refused, nothing of U, V's session kept
  const other = await b.open(`/file?t=${encodeURIComponent(await w.link())}`);
  eq(other.status, 403);
  const h = await other.text();
  assert(/This link is for a different Trainee account/.test(plain(h)));
  // The page carries V's own random page token (fp1. + 64 hex), which by chance can contain "0100" (about 1 run in 1000);
  // U's private words are checked on the page without that token, which can hold no word of U's.
  const shown = h.replace(/fp1\.[0-9a-f]{64}/g, "fp1.<token>");
  for (const p of PRIVATE) assert(!shown.includes(p), `nothing of U (${p})`);
  assert((await (await b.open("/file")).text()).includes("Vcorp"), "still V's own list");
  // a fresh browser: U's link, V types V's own number -> no text; V's valid code from V's own link -> refused
  const b2 = browser(w.d);
  const vlink = browser(w.d);
  await signIn(w, vlink, V_PHONE, await w.link(V, LIST_V));
  const vcode = w.P.lastCode();
  const su = await signIn(w, b2, V_PHONE);
  eq(w.P.texts.filter((x) => x.phone === U_PHONE).length, 0);
  eq((await su.verify(vcode)).status, 401, "a code that proves V never opens U's link");
  assert(!b2.jar.has("tf_s"));
  // and V's session (V's browser: cookie and page token) posted against U's rows approves nothing
  const vsid = b.jar.get("tf_s")!;
  const p = await handleFile(new Request("https://trainee.example/file", await phonePost({ t: vsid, action: "apply", ref: w.refs[0], tag: hashTag(H) }, SECRET)), w.d);
  eq(p.status, 404); eq(w.log.answered, []);
});

Deno.test("wrong account: a code that Auth says proves a DIFFERENT account than the link's is refused even when the number matched", async () => {
  const w = await world();
  const d: FileDeps = { ...w.d, phone: { ...w.P.auth, check: async () => V } };
  const b = browser(d);
  const s = await signIn(w, b);
  eq((await s.verify(w.P.lastCode())).status, 401);
  assert(!b.jar.has("tf_s"));
});

// ================================================================== expired
Deno.test("expired: an expired link opens nothing; a sign-in not finished within 15 minutes is over; a session past two hours is signed out", async () => {
  const w = await world(), b = browser(w.d);
  const old = await w.link(U, LIST, NOW - 25 * 3600_000);
  const r = await b.open(`/file?t=${encodeURIComponent(old)}`);
  eq(r.status, 410); assert(/expired/i.test(plain(await r.text())) && !b.jar.size);
  const s = await signIn(w, b);
  w.clock.t = NOW + LOGIN_TTL_MS + 1;
  const late = await s.verify(w.P.lastCode());
  eq(late.status, 410); assert(!b.jar.has("tf_s"));
  // a link that itself runs out mid-sign-in: the sign-in ends with the link
  w.clock.t = NOW;
  const b2 = browser(w.d);
  const s2 = await signIn(w, b2, U_PHONE, await w.link(U, LIST, NOW - 24 * 3600_000 + 60_000));
  w.clock.t = NOW + 61_000;
  eq((await s2.verify(w.P.lastCode())).status, 410);
  // a session past its two hours
  w.clock.t = NOW;
  const b3 = browser(w.d);
  const s3 = await signIn(w, b3);
  eq((await s3.verify(w.P.lastCode())).status, 303);
  w.clock.t = NOW + SESSION_TTL_MS + 1;
  const gone = await b3.open("/file");
  eq(gone.status, 401); assert(!(await gone.text()).includes("Acme"));
});

// ================================================================== replay
Deno.test("replay: a used link opens nothing for anyone else; the code works once; replaying the sign-in or an Apply sends nothing", async () => {
  const w = await world(), b = browser(w.d);
  const l = await w.link();
  const s = await signIn(w, b, U_PHONE, l);
  const code = w.P.lastCode();
  eq((await s.verify(code)).status, 303);
  // the same link in another browser: used
  const other = browser(w.d);
  const again = await other.open(`/file?t=${encodeURIComponent(l)}`);
  eq(again.status, 410); assert(/already used/.test(plain(await again.text())));
  // the same code, replayed with the old pending-link cookie
  const replay = await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { cookie: `tf_l=${l}`, "content-type": "application/x-www-form-urlencoded" }, body: "action=phone_verify&code=" + code }), w.d);
  eq(replay.status, 410); assert(!replay.headers.getSetCookie().some((c) => c.startsWith("tf_s=fs1")));
  eq([...w.S.sessions.values()].length, 1, "one session from one sign-in");
  // the same link in the SAME signed-in browser just picks the list (nothing new is started)
  eq((await b.open(`/file?t=${encodeURIComponent(l)}`)).status, 303);
  eq([...w.S.sessions.values()].length, 1);
  // Apply replayed: once
  const html = await (await b.open("/file")).text();
  const f = { t: fieldT(html), action: "apply", ref: refIn(html, "Figma"), tag: tagOf(html, "Figma") };
  await b.post(f); await b.post(f); await b.post(f);
  eq(w.log.answered.length, 1);
});

Deno.test("replay: a cookie alone approves nothing (a cross-site post carries no session id), and a session id is never a link", async () => {
  const w = await world(), b = browser(w.d);
  const s = await signIn(w, b);
  await s.verify(w.P.lastCode());
  const html = await (await b.open("/file")).text();
  const r = await b.post({ action: "apply", ref: refIn(html, "Acme"), tag: tagOf(html, "Acme") });
  eq(r.status, 403); eq(w.log.answered, []);
  eq((await browser(w.d).open(`/file?t=${encodeURIComponent(b.jar.get("tf_s")!)}`)).status, 403);
});

// ================================================================== revoked sessions
Deno.test("revoked: sign out ends this session for reads and Apply; sign out everywhere ends every device, phone and Telegram alike", async () => {
  const w = await world();
  const laptop = browser(w.d), phone = browser(w.d);
  for (const b of [laptop, phone]) { const s = await signIn(w, b); eq((await s.verify(w.P.lastCode())).status, 303); }
  w.tg["777"] = U;
  const mini = await sessionFor(w.S.store, { userId: U, list: LIST, now: NOW, via: "telegram", telegramId: "777" });
  const lt = fieldT(await (await laptop.open("/file")).text()), lsid = laptop.jar.get("tf_s")!;
  const out = await laptop.post({ t: lt, action: "signout" });
  eq(out.status, 200); assert(/signed out on this device/.test(plain(await out.text())) && !laptop.jar.has("tf_s"));
  eq((await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${lsid}` } }), w.d)).status, 401, "the old id reads nothing");
  const applyOld = await handleFile(new Request("https://trainee.example/file", await phonePost({ t: lsid, action: "apply", ref: w.refs[0], tag: hashTag(H) }, SECRET)), w.d);
  eq(applyOld.status, 401); eq(w.log.answered, []);
  eq((await phone.open("/file")).status, 200, "the other device is still signed in");
  const pt = fieldT(await (await phone.open("/file")).text()), psid = phone.jar.get("tf_s")!;
  eq((await phone.post({ t: pt, action: "signout_all" })).status, 200);
  eq((await phone.open("/file")).status, 403);
  eq((await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${psid}` } }), w.d)).status, 401);
  const miniApply = await handleFile(new Request("https://trainee.example/file", await phonePost({ t: mini, action: "apply", ref: w.refs[0], tag: hashTag(H), init: await signedInit("777", NOW / 1000 - 30, BOT) }, SECRET)), w.d);
  eq(miniApply.status, 401, "the Telegram session ended too"); eq(w.log.answered, []);
  assert([...w.S.sessions.values()].every((x) => x.revoked_at));
});

Deno.test("revoked: the account checked again on every request — a changed phone, a deleted account or an unlinked Telegram ends the session at once", async () => {
  const w = await world(), b = browser(w.d);
  const s = await signIn(w, b); await s.verify(w.P.lastCode());
  const t = fieldT(await (await b.open("/file")).text());
  w.phones[U] = "+15125550111"; // the person changed their number on the account
  const r = await b.post({ t, action: "apply", ref: w.refs[0], tag: hashTag(H) });
  eq(r.status, 401); eq(w.log.answered, []);
  w.phones[U] = U_PHONE;
  eq((await b.open("/file")).status, 401, "and it stays ended (revoked on the spot), even if the number comes back");
  // deleted account
  const b2 = browser(w.d); const s2 = await signIn(w, b2); await s2.verify(w.P.lastCode());
  w.phones[U] = null;
  eq((await b2.open("/file")).status, 401);
  // Telegram unlinked
  w.phones[U] = U_PHONE; w.tg["777"] = U;
  const mini = await sessionFor(w.S.store, { userId: U, list: LIST, now: NOW, via: "telegram", telegramId: "777" });
  const get = async () => handleFile(new Request("https://trainee.example/file", await phonePost({ t: mini, action: "refresh", init: await signedInit("777", NOW / 1000 - 30, BOT) }, SECRET)), w.d);
  eq((await get()).status, 200);
  delete w.tg["777"];
  eq((await get()).status, 401);
});

// ================================================================== off, or failing
Deno.test("off: with no SMS provider (or no phone sign-in at all) nothing opens and nothing is sent; a store error never opens the list", async () => {
  const w = await world({ smsOff: true }), b = browser(w.d);
  eq((await b.open(`/file?t=${encodeURIComponent(await w.link())}`)).status, 303);
  const r = await b.post({ action: "phone_start", phone: U_PHONE });
  eq(r.status, 503); assert(/isn't switched on yet/.test(plain(await r.text())));
  const w2 = await world(); const d2 = { ...w2.d }; delete d2.phone;
  const b2 = browser(d2);
  await b2.open(`/file?t=${encodeURIComponent(await w2.link())}`);
  eq((await b2.post({ action: "phone_start", phone: U_PHONE })).status, 503);
  const w3 = await world(), b3 = browser(w3.d);
  const s3 = await signIn(w3, b3); await s3.verify(w3.P.lastCode());
  w3.S.store.session = async () => { throw new Error("db down"); };
  const down = await b3.open("/file");
  eq(down.status, 503); assert(!(await down.text()).includes("Acme"));
});

// ================================================================== the deployed phone adapter (Supabase Auth's SMS code)
Deno.test("phone adapter: the account's phone only when confirmed; a code is asked for with create_user false; a correct code's Auth session is ended at once; no provider is 'not switched on'", async () => {
  const { supabasePhoneAuth } = await import("../../supabase/functions/trainee-file/store.ts");
  const users: Record<string, any> = { [U]: { id: U, phone: "15125550100", phone_confirmed_at: "2026-10-28T00:00:00Z" }, [V]: { id: V, phone: "15125550199", phone_confirmed_at: null } };
  const admin = { auth: { admin: { async getUserById(id: string) { return users[id] ? { data: { user: users[id] }, error: null } : { data: { user: null }, error: { message: "User not found" } }; } } } };
  const calls: { path: string; body: any; auth: string | null; apikey: string | null }[] = [];
  let mode: "ok" | "noprovider" | "wrong" = "ok";
  const fetchFake = (async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname, h = new Headers(init.headers);
    calls.push({ path, body: JSON.parse(String(init.body)), auth: h.get("authorization"), apikey: h.get("apikey") });
    if (path === "/auth/v1/otp") return mode === "noprovider" ? new Response(JSON.stringify({ msg: "Unsupported phone provider" }), { status: 400 }) : new Response("{}", { status: 200 });
    if (path === "/auth/v1/verify") return mode === "wrong" ? new Response(JSON.stringify({ msg: "Token has expired or is invalid" }), { status: 403 }) : new Response(JSON.stringify({ access_token: "at-1", user: { id: U } }), { status: 200 });
    if (path === "/auth/v1/logout") return new Response(null, { status: 204 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const a = supabasePhoneAuth(admin, { url: "https://proj.supabase.co", anon: "anon-key", fetch: fetchFake });
  eq(await a.accountPhone(U), U_PHONE);
  eq(await a.accountPhone(V), null, "an unconfirmed phone is no phone");
  eq(await a.accountPhone("33333333-3333-4333-8333-333333333333"), null, "no account");
  eq(await a.send(U_PHONE), { ok: true });
  eq(calls.at(-1), { path: "/auth/v1/otp", body: { phone: U_PHONE, create_user: false, channel: "sms" }, auth: null, apikey: "anon-key" });
  eq(await a.check(U_PHONE, "123456"), U);
  eq(calls.slice(-2).map((c) => [c.path, c.body, c.auth]), [["/auth/v1/verify", { type: "sms", phone: U_PHONE, token: "123456" }, null], ["/auth/v1/logout", {}, "Bearer at-1"]]);
  mode = "wrong"; eq(await a.check(U_PHONE, "000000"), null);
  mode = "noprovider"; eq(await a.send(U_PHONE), { ok: false, why: "not_configured" });
  eq(await supabasePhoneAuth(admin, { url: "https://proj.supabase.co", anon: undefined, fetch: fetchFake }).send(U_PHONE), { ok: false, why: "not_configured" });
});
