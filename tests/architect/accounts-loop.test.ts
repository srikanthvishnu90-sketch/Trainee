// Item 14 loop (accounts and connections; brief task c-accounts): every way into an account, driven end to end on local fixtures, and
// one number per bar. No live provider: the person's phone is a Supabase Auth double behind the deployed phone client
// (trainee-file/store.ts supabasePhoneAuth, over a fake fetch), the sessions are the memory twin of the deployed store, and the
// /file and /connect proxies (api/) run over a fake upstream. What is counted:
//   leaks:     a one-time code, a link token, a session id, a secret or a full phone number in a log line, in a reply to the chat,
//              or in a page (a page may carry a session's page token, never the session itself, except where listed below);
//   unrefused: an expired, tampered, used, bare, foreign or ended link or session that opens anything, or that is refused with
//              no recovery (a "Get a new link" action or the recovery words);
//   dead:      a sign-in form or link on any page that leads nowhere (a 5xx, "not something this page can do", a link to no page).
// The run prints ACCOUNTS_LOOP leaks=<n> unrefused=<n> dead=<n> checks=<n>; the bar is 0 0 0.
import nodeAssert from "node:assert/strict";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { LOGIN_TTL_MS, MAX_CODE_SENDS, MAX_CODE_TRIES, SESSION_TTL_MS } from "../../supabase/functions/_shared/file_session.ts";
import { HELP_URL, RECOVERY_WORDS } from "../../supabase/functions/_shared/file_page.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { supabasePhoneAuth } from "../../supabase/functions/trainee-file/store.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { connectPageToken, mintConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { connectLanding } from "../../supabase/functions/_shared/connect_landing.ts";
import { disconnectOf } from "../../supabase/functions/_shared/connector_words.ts";
import { handleConnect, type ConnectDeps, type ProviderId, type ProviderState } from "../../supabase/functions/trainee-connect/handler.ts";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { resumeTaskTurn } from "../../supabase/functions/_shared/career_resume_task.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { memSessions, signedInit } from "./file-session-fakes.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import type { SessionStore } from "../../supabase/functions/_shared/file_session.ts";

const U = "8c0f8f8e-6a43-4a49-9d2c-0000000c1401", V = "8c0f8f8e-6a43-4a49-9d2c-0000000c1402";
const U_PHONE = "+15125550171", V_PHONE = "+15125550172";
const U_LIST = "0c0c0c0c0c", V_LIST = "0d0d0d0d0d";
const U_CO = "Lakefront Analytics (fictional)", V_CO = "Harbor Robotics (fictional)";
const FILE_SECRET = "file-link-secret-c14-0123456789-abcdef", CONNECT_SECRET = "connect-link-secret-c14-0123456789-abcdef";
const BOT_TOKEN = "123456:c14-test-bot-token", ANON = "anon-key-c14-fixture", BOT_URL = "https://t.me/TraineeTestBot";
const FILE_BASE = "https://trainee.example/file", CONNECT_BASE = "https://trainee.example/connect";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
const T0 = Date.parse("2026-11-10T15:00:00Z");
const SITE = await Deno.readTextFile(new URL("../../site/index.html", import.meta.url));

// ---- the counters
type Bucket = "leaks" | "unrefused" | "dead";
const tally = { leaks: 0, unrefused: 0, dead: 0, checks: 0 };
// Findings that need the coordinator's ruling before a fix (a pinned architect test asserts the current behaviour): counted and
// printed, not part of the bar until ruled. Each names the pinned test.
const ruling: string[] = [];
const failures: string[] = [];
const check = (b: Bucket, ok: unknown, what: string) => { tally.checks++; if (!ok) { tally[b]++; failures.push(`${b}: ${what}`); } };

// ---- every log line, as the edge runtime would keep it
const LOGS: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
const capture = () => { for (const k of Object.keys(realConsole) as (keyof typeof realConsole)[]) console[k] = (...a: unknown[]) => { LOGS.push(a.map((x) => x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x)).join(" ")); }; };
const release = () => Object.assign(console, realConsole);

// ---- what must never travel: every code texted, every link and session minted, every configured secret, full phone numbers
const SECRETS = new Set<string>([FILE_SECRET, CONNECT_SECRET, BOT_TOKEN, ANON]);
const PHONES = [U_PHONE, V_PHONE, U_PHONE.slice(2), V_PHONE.slice(2)];
const texted: { phone: string; code: string }[] = [];
const sessionIds = new Set<string>(); // tf_s values; tc_s values are listed apart (see connect below)
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const h1 = (h: string) => plain((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? "");
function leaked(s: string, o: { allow?: string[] } = {}): string | null {
  const allow = new Set(o.allow ?? []);
  for (const x of SECRETS) if (!allow.has(x) && s.includes(x)) return `a secret or token (${x.slice(0, 10)}...)`;
  for (const x of sessionIds) if (!allow.has(x) && s.includes(x)) return `a session id (${x.slice(0, 6)}...)`;
  for (const t of texted) if (new RegExp(`(?<!\\d)${t.code}(?!\\d)`).test(s)) return `the one-time code ${t.code}`;
  for (const p of PHONES) if (s.includes(p)) return `a full phone number`;
  return null;
}

// ---- Supabase Auth's SMS endpoints, as a fixture: the deployed phone client (supabasePhoneAuth) talks to it over a fake fetch
function authDouble() {
  const accounts: Record<string, string | null> = { [U]: U_PHONE, [V]: V_PHONE };
  const live = new Map<string, string>();
  let n = 0;
  const fetchDouble = (async (u: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(u instanceof Request ? u.url : u)).pathname, body = JSON.parse(String(init?.body ?? "{}"));
    if ((init?.headers as Record<string, string>)?.apikey !== ANON) return new Response("{}", { status: 401 });
    if (path.endsWith("/otp")) { const code = String(271828 + 13 * ++n).slice(-6); live.set(body.phone, code); texted.push({ phone: body.phone, code }); return new Response("{}", { status: 200 }); }
    if (path.endsWith("/verify")) {
      if (live.get(body.phone) !== body.token) return new Response(JSON.stringify({ error: "invalid" }), { status: 400 });
      live.delete(body.phone);
      const id = Object.entries(accounts).find(([, p]) => p === body.phone)?.[0];
      return new Response(JSON.stringify({ access_token: "at-c14-fixture", user: { id } }), { status: 200 });
    }
    if (path.endsWith("/logout")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const admin = { auth: { admin: { getUserById: async (id: string) => accounts[id] !== undefined
    ? { data: { user: { id, phone: accounts[id]?.slice(1) ?? null, phone_confirmed_at: accounts[id] ? "2026-10-01T00:00:00Z" : null } }, error: null }
    : { data: null, error: { message: "User not found" } } } } };
  SECRETS.add("at-c14-fixture");
  return { phone: supabasePhoneAuth(admin, { url: "http://supabase.test", anon: ANON, fetch: fetchDouble }), accounts };
}

// ---- the File world: two people, each with one list of one fictional posting
// The session store: the memory twin, or (STORE=pg) the deployed store over real Postgres 16 with every migration. On one shared
// database each world starts three hours after the last, so the per-account hourly caps of one walk never reach the next.
let sessionStoreOf: () => SessionStore = () => memSessions().store;
let worldClock = T0;
async function fileWorld(o: { bot?: boolean } = {}) {
  const s = { store: sessionStoreOf() };
  const base = (worldClock += 3 * 3600_000);
  const kv = new Map<string, unknown>();
  const store = { async recall(u: string, r: string) { return kv.get(`${u}|${r}`) ?? null; }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return []; }, async prepared() { return null; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
  for (const [u, list, co, n] of [[U, U_LIST, U_CO, 1], [V, V_LIST, V_CO, 2]] as const) {
    const v = jobViewOf({ job_id: `greenhouse:c14:${n}`, company: co, title: "Data Analyst", url: `https://boards.greenhouse.io/c14/jobs/${n}` }, null);
    const ref = await refOf(u, v.job_id); kv.set(`${u}|${ref}`, { job: v, shownAs: "text" }); kv.set(`${u}|list|${list}`, [ref]);
  }
  const A = authDouble();
  let now = base;
  const paced: string[] = [];
  const bg: Promise<unknown>[] = [];
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: FILE_SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN, ...(o.bot === false ? {} : { TRAINEE_BOT_URL: BOT_URL }) };
  const d: FileDeps = { store, sessions: s.store, phone: A.phone, now: () => now, userOfTelegram: async (id) => ({ "7101": U, "7102": V } as Record<string, string>)[id] ?? null,
    pace: async (step) => { paced.push(step); }, background: (w) => { bg.push(w); },
    env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never };
  const link = async (user: string, list: string, at = now, ttlMs?: number) => { const t = (await mintFileToken({ secret: FILE_SECRET, userId: user, list, now: at, kind: "l", ttlMs }))!; SECRETS.add(t); return t; };
  const jar = new Map<string, string>();
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv0] = c.split(";"); const [k, ...x] = kv0.split("="); const v = x.join("="); if (/Max-Age=0/.test(c) || !v) jar.delete(k); else { jar.set(k, v); if (k === "tf_s") sessionIds.add(v); } } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const go = async (path: string, form?: Record<string, string>, extra: Record<string, string> = {}) => {
    const r = await handleFile(new Request(`${FILE_BASE}${path}`, form
      ? { method: "POST", headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER, origin: "https://trainee.example", ...extra }, body: new URLSearchParams(form).toString() }
      : { headers: { cookie: cookie(), "user-agent": BROWSER, ...extra } }), d);
    await Promise.all(bg.splice(0));
    take(r);
    return { r, html: r.status >= 300 && r.status < 400 ? "" : await r.text() };
  };
  return { d, s, link, go, jar, paced, accounts: A.accounts, setNow: (t: number) => { now = t; }, now: () => now, bot: o.bot !== false };
}
type FW = Awaited<ReturnType<typeof fileWorld>>;

// A refused page: no private content, and a recovery (the bot's "Get a new link", or the recovery words when no bot is configured).
function refusedWell(w: FW, html: string, status: number, what: string) {
  check("unrefused", status >= 400, `${what}: refused (status ${status})`);
  check("unrefused", !html.includes(U_CO) && !html.includes(V_CO), `${what}: no private content`);
  const recovery = w.bot ? html.includes(`href="${BOT_URL}"`) && />Get a new link</.test(html) : html.includes(RECOVERY_WORDS);
  const other = /This link is for a different Trainee account/.test(h1(html)) && /name="action" value="signout"/.test(html);
  check("unrefused", recovery || other, `${what}: a plain recovery path ("${h1(html)}")`);
}

// Every form and link a sign-in page draws must lead somewhere: a form's post answers without a 5xx and without "not something
// this page can do"; a link is the bot, the site's support page, the posting, or this page.
async function liveActions(w: FW, html: string, what: string, opts: { post?: boolean } = {}) {
  for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    const ok = href === BOT_URL || href === HELP_URL && /slug:'support'/.test(SITE) || /^https:\/\/boards\.greenhouse\.io\//.test(href) || href.startsWith("#") || href.startsWith("/file");
    check("dead", ok, `${what}: the link ${href} leads to a page`);
  }
  if (!opts.post) return;
  for (const m of html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields = Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&")]));
    if (fields.action === "phone_start") fields.phone = "512-555-0199"; // a number, so the post is the form's own
    if (fields.action === "phone_verify") fields.code = "000000";
    if (fields.action === "signout" || fields.action === "signout_all") continue; // walked on its own (it ends the session)
    const snap = new Map(w.jar);
    const { r, html: back } = await w.go("", fields);
    check("dead", r.status < 500 && !/not something this page can do/i.test(back) && (r.status < 400 || r.status === 401 && /That code did not work/.test(h1(back)) || r.status === 400), `${what}: the "${fields.action}" form answers (status ${r.status}, "${h1(back)}")`);
    w.jar.clear(); for (const [k, v] of snap) w.jar.set(k, v);
  }
}
function pageLeaks(w: FW, html: string, what: string) {
  const hit = leaked(html);
  check("leaks", !hit, `${what}: the page carries ${hit}`);
  void w;
}

// ---------------------------------------------------------------------------------------------------------------- the File walks
async function codeStepForms(bot: boolean, tag: string) {
  // every form of the code step and of the wrong-code step, each posted from its own fresh sign-in (a post changes the sign-in)
  for (const stepName of ["code", "wrong_code"] as const) {
    const at = async () => { const x = await fileWorld({ bot }); await x.go(`?t=${encodeURIComponent(await x.link(U, U_LIST))}`); const a = await x.go("", { action: "phone_start", phone: U_PHONE });
      return stepName === "code" ? { x, html: a.html } : { x, html: (await x.go("", { action: "phone_verify", code: "000002" })).html }; };
    const { html: drawn } = await at();
    const forms = [...drawn.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)];
    check("dead", forms.length >= 3, `${tag} ${stepName}: its three forms (sign in, new code, different number)`);
    for (let i = 0; i < forms.length; i++) {
      const { x, html } = await at();
      const m = [...html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)][i];
      const f = Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((y) => [y[1], y[2]]));
      if (f.action === "phone_verify") f.code = texted.at(-1)!.code;
      const r = await x.go("", f);
      const want = f.action === "phone_verify" ? r.r.status === 303 && x.jar.has("tf_s") : f.action === "phone_resend" ? h1(r.html) === "Check your phone" : f.action === "phone_reset" ? h1(r.html) === "Sign in" : false;
      check("dead", want, `${tag} ${stepName}: the "${f.action}" form does what it says (${r.r.status} "${h1(r.html)}")`);
    }
  }
}
async function fileWalks(bot: boolean) {
  const tag = bot ? "file" : "file(no bot)";
  // 1. bare /file, a tampered link, a session-kind link, an expired link: refused with recovery, nothing used up
  { const w = await fileWorld({ bot }); const { r, html } = await w.go(""); refusedWell(w, html, r.status, `${tag} bare`); await liveActions(w, html, `${tag} bare`); pageLeaks(w, html, `${tag} bare`); }
  { const w = await fileWorld({ bot }); const t = await w.link(U, U_LIST); const bad = t.slice(0, -3) + (t.endsWith("a") ? "bcd" : "abc");
    const { r, html } = await w.go(`?t=${encodeURIComponent(bad)}`); refusedWell(w, html, r.status, `${tag} tampered`); }
  { const w = await fileWorld({ bot }); const t = (await mintFileToken({ secret: FILE_SECRET, userId: U, list: U_LIST, now: w.now(), kind: "s" }))!; SECRETS.add(t);
    const { r, html } = await w.go(`?t=${encodeURIComponent(t)}`); refusedWell(w, html, r.status, `${tag} session-kind link`); }
  { const w = await fileWorld({ bot }); const t = await w.link(U, U_LIST, w.now() - 25 * 3600_000); const { r, html } = await w.go(`?t=${encodeURIComponent(t)}`);
    refusedWell(w, html, r.status, `${tag} expired link`); check("unrefused", /expired/i.test(h1(html)), `${tag} expired link: says it expired`); }
  // 2. a valid link: the sign-in entry, then each phone step, paced; a code texted only to the account's own number
  const w = await fileWorld({ bot });
  const t = await w.link(U, U_LIST);
  const open = await w.go(`?t=${encodeURIComponent(t)}`);
  check("unrefused", open.r.status === 303 && w.jar.has("tf_l"), `${tag} link: a pending sign-in, nothing private yet`);
  const entry = await w.go("");
  check("unrefused", h1(entry.html) === "Sign in" && !entry.html.includes(U_CO), `${tag} entry: Sign in, nothing private`);
  pageLeaks(w, entry.html, `${tag} entry`); await liveActions(w, entry.html, `${tag} entry`, { post: true });
  check("dead", /name="phone"/.test(entry.html) && />Send code</.test(entry.html) && />Get help</.test(entry.html) && (!bot || />Open from Telegram</.test(entry.html)), `${tag} entry: Send code, Get help${bot ? ", Open from Telegram" : ""}`);
  const before = texted.length;
  const other = await w.go("", { action: "phone_start", phone: "512-555-0199" });
  check("leaks", texted.length === before, `${tag} a stranger's number: no text sent`);
  const otherWords = plain(other.html);
  await w.go("", { action: "phone_reset" });
  const sent = await w.go("", { action: "phone_start", phone: "(512) 555-0171" });
  check("leaks", texted.length === before + 1 && texted.at(-1)!.phone === U_PHONE, `${tag} the account's number: one code, to that number only`);
  check("leaks", plain(sent.html) === otherWords, `${tag} the same words for any number (a link never learns whose number it is)`);
  check("dead", h1(sent.html) === "Check your phone" && />Send a new code</.test(sent.html) && />Use a different number</.test(sent.html), `${tag} code step: Sign in, Send a new code, Use a different number`);
  pageLeaks(w, sent.html, `${tag} code step`); await liveActions(w, sent.html, `${tag} code step`);
  // resend pacing: each resend is the same capped step; the cap is the link's, and the page keeps saying so without a countdown
  for (let i = 0; i < MAX_CODE_SENDS + 1; i++) { const rs = await w.go("", { action: "phone_resend" }); check("dead", rs.r.status === 200 && h1(rs.html) === "Check your phone", `${tag} resend ${i + 1}: answers`); }
  check("leaks", texted.filter((x) => x.phone === U_PHONE).length - texted.slice(0, before).filter((x) => x.phone === U_PHONE).length === MAX_CODE_SENDS, `${tag} resend: at most ${MAX_CODE_SENDS} codes per link`);
  check("leaks", w.paced.length >= MAX_CODE_SENDS + 3 && w.paced.every((p) => /^phone_(start|verify|resend)$/.test(p)), `${tag} every phone step is paced (${w.paced.join(",")})`);
  // a wrong code, then the right one
  const wrong = await w.go("", { action: "phone_verify", code: "000001" });
  check("unrefused", wrong.r.status === 401 && h1(wrong.html) === "That code did not work" && !wrong.html.includes(U_CO), `${tag} wrong code: refused, nothing private`);
  check("dead", />Try again</.test(wrong.html) && />Use a different number</.test(wrong.html), `${tag} wrong code: Try again, Use a different number`);
  pageLeaks(w, wrong.html, `${tag} wrong code`);
  const code = texted.at(-1)!.code;
  const ok = await w.go("", { action: "phone_verify", code: code.slice(0, 3) + " " + code.slice(3) });
  check("unrefused", ok.r.status === 303 && w.jar.has("tf_s") && !w.jar.has("tf_l"), `${tag} right code: a session, the pending link cleared`);
  const page = await w.go("");
  check("unrefused", page.r.status === 200 && page.html.includes(U_CO) && !page.html.includes(V_CO), `${tag} signed in: exactly this account's list`);
  pageLeaks(w, page.html, `${tag} signed-in page`);
  check("dead", /name="action" value="signout"/.test(page.html), `${tag} signed in: a Sign out control`);
  // 3. the used link again, and another person's link and list in this browser: refused, never the other's content
  const used = await w.go(`?t=${encodeURIComponent(t)}`);
  check("unrefused", used.r.status === 303 && !(await w.go("")).html.includes(V_CO), `${tag} the used link while signed in: only picks this account's list`);
  const vLink = await w.link(V, V_LIST);
  const foreign = await w.go(`?t=${encodeURIComponent(vLink)}`);
  refusedWell(w, foreign.html, foreign.r.status, `${tag} another person's link while signed in`);
  pageLeaks(w, foreign.html, `${tag} foreign link`);
  const vListPost = await w.go(`?list=${V_LIST}`);
  check("unrefused", !vListPost.html.includes(V_CO), `${tag} another person's list id: nothing of theirs`);
  // binding: the account's confirmed phone changes after the sign-in; the session ends with it (and stays ended when it is restored)
  { const x = await fileWorld({ bot }); await x.go(`?t=${encodeURIComponent(await x.link(U, U_LIST))}`); await x.go("", { action: "phone_start", phone: U_PHONE });
    await x.go("", { action: "phone_verify", code: texted.at(-1)!.code });
    check("unrefused", (await x.go("")).html.includes(U_CO), `${tag} binding: signed in`);
    x.accounts[U] = "+15125550179"; const moved = await x.go(""); refusedWell(x, moved.html, moved.r.status, `${tag} binding: the phone changed after sign-in`);
    x.accounts[U] = U_PHONE; }
  // sign out everywhere: two browsers on one account (V: on one shared database "everywhere" would also end this walk's own U session)
  { const x = await fileWorld({ bot }); const signIn = async () => { await x.go(`?t=${encodeURIComponent(await x.link(V, V_LIST))}`); await x.go("", { action: "phone_start", phone: V_PHONE }); await x.go("", { action: "phone_verify", code: texted.at(-1)!.code }); };
    await signIn(); const first = new Map(x.jar); x.jar.clear(); await signIn();
    const pg2 = await x.go(""); const tk = pg2.html.match(/name="t" value="([^"]+)"/)?.[1] ?? "";
    const all = await x.go("", { action: "signout_all", t: tk }); check("unrefused", all.r.status === 200 && h1(all.html) === "Signed out", `${tag} sign out everywhere: signed out`);
    x.jar.clear(); for (const [k, v] of first) x.jar.set(k, v);
    const gone = await x.go(""); refusedWell(x, gone.html, gone.r.status, `${tag} sign out everywhere: the other browser`); }
  // 4. sign out; the old cookie opens nothing and says how to get back in
  const tokenField = page.html.match(/name="t" value="([^"]+)"/)?.[1] ?? "";
  const oldSession = w.jar.get("tf_s")!;
  const out = await w.go("", { action: "signout", t: tokenField });
  check("unrefused", out.r.status === 200 && h1(out.html) === "Signed out" && !w.jar.has("tf_s"), `${tag} sign out: signed out, the cookie cleared (${out.r.status} "${h1(out.html)}" ${plain(out.html).slice(0, 160)})`);
  await liveActions(w, out.html, `${tag} signed out`);
  w.jar.set("tf_s", oldSession);
  const after = await w.go("");
  refusedWell(w, after.html, after.r.status, `${tag} the old session after sign out`);
  const replay = await w.go("", { action: "refresh", t: tokenField });
  refusedWell(w, replay.html, replay.r.status, `${tag} a post from the signed-out page`);
  w.jar.clear();
  // 5. the used link in a fresh browser, an expired sign-in (15 min), a locked sign-in, an expired session (2 h)
  { const fresh = await w.go(`?t=${encodeURIComponent(t)}`); refusedWell(w, fresh.html, fresh.r.status, `${tag} the used link in another browser`); w.jar.clear(); }
  { const x = await fileWorld({ bot }); const l = await x.link(V, V_LIST); await x.go(`?t=${encodeURIComponent(l)}`); await x.go("", { action: "phone_start", phone: V_PHONE });
    x.setNow(x.now() + LOGIN_TTL_MS + 1000); const late = await x.go("", { action: "phone_verify", code: texted.at(-1)!.code });
    refusedWell(x, late.html, late.r.status, `${tag} a code after 15 minutes`); }
  { const x = await fileWorld({ bot }); const l = await x.link(V, V_LIST); await x.go(`?t=${encodeURIComponent(l)}`); await x.go("", { action: "phone_start", phone: V_PHONE });
    let last = { r: new Response(), html: "" }; for (let i = 0; i <= MAX_CODE_TRIES; i++) last = await x.go("", { action: "phone_verify", code: "999999" });
    refusedWell(x, last.html, last.r.status, `${tag} locked after ${MAX_CODE_TRIES} wrong codes`);
    const rightAfter = await x.go("", { action: "phone_verify", code: texted.at(-1)!.code });
    check("unrefused", !x.jar.has("tf_s") && !rightAfter.html.includes(V_CO), `${tag} locked: even the right code opens nothing`); }
  { const x = await fileWorld({ bot }); const l = await x.link(U, U_LIST); await x.go(`?t=${encodeURIComponent(l)}`); await x.go("", { action: "phone_start", phone: U_PHONE });
    await x.go("", { action: "phone_verify", code: texted.at(-1)!.code }); x.setNow(x.now() + SESSION_TTL_MS + 1000);
    const stale = await x.go(""); refusedWell(x, stale.html, stale.r.status, `${tag} a session after two hours`); }
  // 6. a cross-site post, the Mini App: unsigned, stale, unlinked, signed (that person only), and a forwarded Mini App page
  { const x = await fileWorld({ bot }); const l = await x.link(U, U_LIST); await x.go(`?t=${encodeURIComponent(l)}`); const n = texted.length;
    const cs = await x.go("", { action: "phone_start", phone: U_PHONE }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    check("leaks", cs.r.status === 403 && texted.length === n, `${tag} a cross-site post: refused, no text`); }
  { const x = await fileWorld({ bot });
    const boot = await x.go(`?list=${U_LIST}`);
    check("dead", h1(boot.html) === "Open from your Trainee chat" && /Sign in another way/.test(boot.html) && (!bot || />Open Telegram</.test(boot.html)), `${tag} Telegram entry: Open Telegram, Sign in another way`);
    await liveActions(x, boot.html, `${tag} Telegram entry`);
    const unsigned = await x.go("", { list: U_LIST, init: "user=%7B%22id%22%3A7101%7D&hash=00" }); refusedWell(x, unsigned.html, unsigned.r.status, `${tag} Mini App: unsigned data`);
    const stale = await x.go("", { list: U_LIST, init: await signedInit("7101", (x.now() - 2 * 86400_000) / 1000, BOT_TOKEN) }); refusedWell(x, stale.html, stale.r.status, `${tag} Mini App: stale data`);
    const unlinked = await x.go("", { list: U_LIST, init: await signedInit("7999", x.now() / 1000, BOT_TOKEN) });
    check("unrefused", unlinked.r.status === 403 && !unlinked.html.includes(U_CO), `${tag} Mini App: an unlinked Telegram account opens nothing`);
    const tg = await x.go("", { list: U_LIST, init: await signedInit("7101", x.now() / 1000, BOT_TOKEN) });
    check("unrefused", tg.r.status === 200 && tg.html.includes(U_CO) && !tg.html.includes(V_CO) && !x.jar.has("tf_s"), `${tag} Mini App: this person's list only, no cookie`);
    const sid = tg.html.match(/name="t" value="([^"]+)"/)?.[1] ?? ""; sessionIds.add(sid);
    // A Mini App page carries its session id in its forms by design (file_session.ts: only with Telegram's fresh signed data);
    // a forwarded copy of the page opens nothing without it.
    const fwd = await x.go("", { action: "refresh", t: sid }); refusedWell(x, fwd.html, fwd.r.status, `${tag} a forwarded Mini App page`);
    const fwdV = await x.go("", { action: "refresh", t: sid, init: await signedInit("7102", x.now() / 1000, BOT_TOKEN) }); refusedWell(x, fwdV.html, fwdV.r.status, `${tag} a Mini App page posted with another person's Telegram`);
    sessionIds.delete(sid); }
  await codeStepForms(bot, tag);
}

// ------------------------------------------------------------------------------------------------------------- the /connect walks
function connectWorld(o: { bot?: boolean } = {}) {
  const none = (): Record<ProviderId, ProviderState> => ({ google: { state: "not_connected", email: null }, microsoft: { state: "not_connected", email: null } });
  const conn: Record<string, Record<ProviderId, ProviderState>> = {};
  const used = new Set<string>();
  const ENV: Record<string, string> = { TRAINEE_CONNECT_LINK_SECRET: CONNECT_SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRAINEE_CONNECT_BASE_URL: CONNECT_BASE, ...(o.bot === false ? {} : { TRAINEE_BOT_URL: BOT_URL }) };
  const started: string[] = [];
  const d: ConnectDeps = { env: { get: (k) => ENV[k] }, now: () => T0,
    providers: () => ({ google: { configured: true, scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] }, microsoft: { configured: true, scopes: ["openid", "email", "Mail.Read"] } }),
    status: async (u) => conn[u] ?? none(),
    start: async (p, u) => { started.push(`${p}:${u}`); return `https://accounts.google.com/o/oauth2/v2/auth?state=c14-${p}`; },
    disconnect: async (p, u) => { (conn[u] ??= none())[p] = { state: "not_connected", email: null }; return { ok: true, reply: "Disconnected. Trainee's access is removed." }; },
    claimLink: async (_u, jti) => { if (used.has(jti)) return false; used.add(jti); return true; },
    userOfTelegram: async (id) => ({ "7101": U, "7102": V } as Record<string, string>)[id] ?? null };
  const link = async (u: string, at = T0, ttlMs?: number) => { const t = (await mintConnectToken({ secret: CONNECT_SECRET, userId: u, reason: "replies", channel: "telegram", now: at, kind: "l", ttlMs }))!; SECRETS.add(t); return t; };
  const jar = new Map<string, string>();
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv0] = c.split(";"); const [k, ...x] = kv0.split("="); const v = x.join("="); if (/Max-Age=0/.test(c) || !v) jar.delete(k); else jar.set(k, v); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const go = async (path: string, form?: Record<string, string>, ua = BROWSER) => {
    const r = await handleConnect(new Request(`${CONNECT_BASE}${path}`, form ? { method: "POST", headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded", "user-agent": ua }, body: new URLSearchParams(form).toString() } : { headers: { cookie: cookie(), "user-agent": ua } }), d);
    take(r);
    return { r, html: r.status >= 300 && r.status < 400 ? "" : await r.text() };
  };
  return { d, conn, started, link, go, jar, bot: o.bot !== false };
}
type CW = ReturnType<typeof connectWorld>;
function connectRefused(w: CW, html: string, status: number, what: string) {
  check("unrefused", status >= 400, `${what}: refused (status ${status})`);
  check("unrefused", !/@example\.test/.test(html) && !/Continue with Google/.test(html), `${what}: no account and no connect action`);
  check("unrefused", w.bot ? html.includes(`href="${BOT_URL}"`) : /Ask Trainee|new link/i.test(plain(html)), `${what}: a plain recovery path ("${h1(html)}")`);
}
async function connectWalks(bot: boolean) {
  const tag = bot ? "connect" : "connect(no bot)";
  { const w = connectWorld({ bot }); const { r, html } = await w.go(""); connectRefused(w, html, r.status, `${tag} bare`); }
  { const w = connectWorld({ bot }); const t = await w.link(U, T0 - 2 * 3600_000); const { r, html } = await w.go(`?t=${encodeURIComponent(t)}`); connectRefused(w, html, r.status, `${tag} expired link`); }
  { const w = connectWorld({ bot }); const t = await w.link(U); const { r, html } = await w.go(`?t=${encodeURIComponent(t.slice(0, -4) + "AAAA")}`); connectRefused(w, html, r.status, `${tag} tampered link`); }
  { const w = connectWorld({ bot }); const t = (await mintConnectToken({ secret: CONNECT_SECRET, userId: U, reason: "replies", channel: "telegram", now: T0, kind: "s" }))!; SECRETS.add(t);
    const { r, html } = await w.go(`?t=${encodeURIComponent(t)}`); connectRefused(w, html, r.status, `${tag} a session token as a link`); }
  const w = connectWorld({ bot });
  const t = await w.link(U);
  const preview = await w.go(`?t=${encodeURIComponent(t)}`, undefined, "TelegramBot (like TwitterBot)");
  check("unrefused", preview.r.status === 200 && !w.jar.has("tc_s") && !/Continue with/.test(preview.html), `${tag} a link preview: the card, the link not used up`);
  const open = await w.go(`?t=${encodeURIComponent(t)}`);
  check("unrefused", open.r.status === 303 && w.jar.has("tc_s") && open.r.headers.get("location") === "/connect", `${tag} link: one session cookie, a clean URL`);
  const consent = await w.go("");
  // The session lives in the HttpOnly tc_s cookie; a page that prints it hands it to anything that reads or saves the page.
  // The session lives in the HttpOnly tc_s cookie; the forms carry a page token bound to it (architect amendment, security, 2026-11-10).
  check("leaks", !consent.html.includes(w.jar.get("tc_s") ?? "\u0000") && /name="t" value="cp1\./.test(consent.html), `${tag} consent: the forms carry a page token, never the session`);
  { const t0 = consent.html.match(/name="t" value="([^"]+)"/)?.[1] ?? ""; const keep = new Map(w.jar);
    w.jar.clear(); const scraped = await w.go("", { t: t0, action: "start", provider: "google" }); check("unrefused", scraped.r.status === 401 && !scraped.r.headers.get("location"), `${tag} a scraped page token without the cookie: refused (${scraped.r.status})`);
    for (const [k, v] of keep) w.jar.set(k, v);
    const bare = await w.go("", { action: "start", provider: "google" }); check("unrefused", bare.r.status === 403 && !bare.r.headers.get("location"), `${tag} the cookie without the page token: refused (${bare.r.status})`);
    const raw = await w.go("", { t: w.jar.get("tc_s") ?? "", action: "start", provider: "google" }); check("unrefused", raw.r.status === 401, `${tag} the session value posted in a form: refused (${raw.r.status})`); }
  check("dead", /<h1>Connect your email<\/h1>/.test(consent.html) && /Continue with Google/.test(consent.html), `${tag} consent: Connect your email, Continue with Google`);
  // Every post the consent page draws must answer (start leads to the provider's own sign-in page).
  for (const m of consent.html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    const f = Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&")]));
    const r = await w.go("", f);
    check("dead", r.r.status < 500 && !/not something this page can do/i.test(r.html) && (f.action !== "start" || /^https:\/\/accounts\.google\.com\//.test(r.r.headers.get("location") ?? "")), `${tag} consent: the "${f.action}:${f.provider}" form answers (${r.r.status})`);
  }
  // back without finishing: Resume and Cancel both answer
  const unfinished = await w.go("");
  for (const m of unfinished.html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    const f = Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&")]));
    const r = await w.go("", f); check("dead", r.r.status < 500 && !/not something this page can do/i.test(r.html), `${tag} unfinished: the "${f.action}" form answers (${r.r.status})`);
  }
  for (const m of unfinished.html.matchAll(/<a [^>]*href="([^"]+)"/g)) check("dead", m[1] === BOT_URL || m[1].startsWith("/") || m[1].startsWith("#"), `${tag} unfinished: the link ${m[1]} leads to a page`);
  // connected, opened from a link (ruling 2026-11-10: a forwarded, unused link may be opened by anyone): the address masked, no
  // Disconnect here, and the chat's words for it, which the chat really answers
  w.conn[U] = { google: { state: "connected", email: "ada.fictional@example.test" }, microsoft: { state: "not_connected", email: null } };
  const connected = await w.go("");
  check("leaks", !connected.html.includes("ada.fictional@example.test") && plain(connected.html).includes("Connected as a***@e***.test"), `${tag} connected from a link: the address masked`);
  const words = plain(connected.html).match(/Reply (DISCONNECT \w+) in your chat with Trainee to disconnect\./)?.[1] ?? "";
  check("dead", disconnectOf(words) === "gmail" && !/name="action" value="disconnect"/.test(connected.html), `${tag} connected from a link: the chat's own words ("${words}") instead of a Disconnect`);
  const forced = await w.go("", { t: (await connectPageToken(w.jar.get("tc_s") ?? "", CONNECT_SECRET))!, action: "disconnect", provider: "google" });
  check("unrefused", forced.r.status === 403 && w.conn[U].google.state === "connected" && /Reply DISCONNECT GMAIL/.test(plain(forced.html)), `${tag} a disconnect posted from a link's page: changes nothing, says how`);
  // identified by Telegram (Mini App): the address and a Disconnect that works, only with fresh signed data on the post
  { const jarBefore = new Map(w.jar); w.jar.clear();
    const mini = await w.go("", { init: await signedInit("7101", T0 / 1000, BOT_TOKEN), w: "replies" });
    check("unrefused", plain(mini.html).includes("Connected as ada.fictional@example.test") && !/c1\./.test(mini.html), `${tag} Mini App: the address, and no session in the page`);
    const f = [...mini.html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2]]))).find((x) => x.action === "disconnect");
    check("dead", !!f, `${tag} Mini App connected: a Disconnect control`);
    if (f) {
      const noInit = await w.go("", f); check("unrefused", noInit.r.status === 401 && w.conn[U].google.state === "connected", `${tag} Mini App page token without Telegram's data: refused`);
      const other = await w.go("", { ...f, init: await signedInit("7102", T0 / 1000, BOT_TOKEN) }); check("unrefused", other.r.status === 401 && w.conn[U].google.state === "connected", `${tag} Mini App page token with another person's Telegram: refused`);
      const ok = await w.go("", { ...f, init: await signedInit("7101", T0 / 1000, BOT_TOKEN) }); check("dead", ok.r.status === 200 && w.conn[U].google.state === "not_connected", `${tag} Mini App Disconnect: done`);
    }
    for (const [k, v] of jarBefore) w.jar.set(k, v); }
  // the OAuth landing: its Disconnect carries a disconnect-only token for that provider (never a session), and it works
  { w.conn[U] = { google: { state: "connected", email: "ada.fictional@example.test" }, microsoft: { state: "not_connected", email: null } };
    const land = await (await connectLanding(w.d.env, { provider: "google", ok: true, denied: false, email: "ada.fictional@example.test", userId: U, scopes: ["openid"], now: T0 })!).text();
    const f = [...land.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2]]))).find((x) => x.action === "disconnect");
    check("dead", !!f, `${tag} landing: a Disconnect control`);
    if (f) {
      SECRETS.add(f.t);
      const jarBefore = new Map(w.jar); w.jar.clear();
      const start = await w.go("", { ...f, action: "start" }); check("unrefused", start.r.status >= 400 && !start.r.headers.get("location"), `${tag} the landing's token cannot start a connection (${start.r.status})`);
      const ms = await w.go("", { ...f, provider: "microsoft" }); check("unrefused", ms.r.status >= 400, `${tag} the landing's token cannot disconnect another provider (${ms.r.status})`);
      const ok = await w.go("", f); check("dead", ok.r.status === 200 && w.conn[U].google.state === "not_connected", `${tag} landing Disconnect: done`);
      for (const [k, v] of jarBefore) w.jar.set(k, v);
    }
  }
  // the used link again, in another browser
  w.jar.clear();
  const again = await w.go(`?t=${encodeURIComponent(t)}`); connectRefused(w, again.html, again.r.status, `${tag} the used link`);
  // the Mini App: unsigned and unlinked open nothing
  const un = await w.go("", { init: "user=%7B%22id%22%3A7101%7D&hash=00" }); connectRefused(w, un.html, un.r.status, `${tag} Mini App: unsigned data`);
  const ul = await w.go("", { init: await signedInit("7999", T0 / 1000, BOT_TOKEN) }); check("unrefused", ul.r.status === 403 && !/Continue with/.test(ul.html), `${tag} Mini App: an unlinked Telegram account`);
  // an expired session cookie
  const old = (await mintConnectToken({ secret: CONNECT_SECRET, userId: U, reason: "replies", channel: "telegram", now: T0 - 3 * 3600_000, kind: "s" }))!; SECRETS.add(old);
  w.jar.set("tc_s", old); const ex = await w.go(""); connectRefused(w, ex.html, ex.r.status, `${tag} an expired session`);
}

// ------------------------------------------------------------------------------------------------------------ the /file and /connect proxies
async function proxyWalks() {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  const real = globalThis.fetch;
  for (const name of ["file", "connect"] as const) {
    const key = name === "file" ? "TRAINEE_FILE_UPSTREAM" : "TRAINEE_CONNECT_UPSTREAM";
    const before = proc.env[key];
    // not set up: a plain answer, no crash
    delete proc.env[key];
    const off = await import(`../../api/${name}.js?c14off=${Math.random()}`);
    const r0: Response = await off.GET(new Request(`https://trainee.example/${name}`));
    check("dead", r0.status === 503 && /not set up yet/.test(await r0.text()), `proxy ${name}: not configured says so`);
    proc.env[key] = `https://abc.supabase.co/functions/v1/trainee-${name}`;
    try {
      const mod = await import(`../../api/${name}.js?c14=${Math.random()}`);
      const cases: [string, Response, (r: Response, body: string) => boolean][] = [
        ["a redirect to another host becomes the clean URL", new Response(null, { status: 303, headers: { location: "https://evil.example/x" } }), (r) => r.headers.get("location") === `/${name}`],
        ["a 404 of a function not deployed", new Response(JSON.stringify({ code: "NOT_FOUND", message: "Requested function was not found" }), { status: 404 }), (r) => r.status === 503],
        ["the upstream's sandbox CSP never passes", new Response("<h1>x</h1>", { status: 200, headers: { "content-security-policy": "default-src 'none'; sandbox" } }), (r) => !/sandbox/.test(r.headers.get("content-security-policy") ?? "")],
        ...(name === "connect" ? [["a provider sign-in redirect passes as it is", new Response(null, { status: 303, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } }), (r: Response) => /^https:\/\/accounts\.google\.com\//.test(r.headers.get("location") ?? "")] as [string, Response, (r: Response, b: string) => boolean]] : []),
      ];
      for (const [what, up, ok] of cases) {
        globalThis.fetch = (async () => up.clone()) as typeof fetch;
        const r: Response = await mod.GET(new Request(`https://trainee.example/${name}?t=abc`));
        check("dead", ok(r, await r.text()), `proxy ${name}: ${what}`);
      }
      // a sign-in sets the session and clears the pending link in one answer: both cookies reach the browser apart
      const two = new Headers(); two.append("set-cookie", "tf_s=s1; HttpOnly; Path=/"); two.append("set-cookie", "tf_l=; Max-Age=0; Path=/"); two.set("location", "/x");
      globalThis.fetch = (async () => new Response(null, { status: 303, headers: two })) as typeof fetch;
      const r2: Response = await mod.POST(new Request(`https://trainee.example/${name}`, { method: "POST", body: "a=1" }));
      if (name === "file") check("dead", r2.headers.getSetCookie().length === 2, `proxy file: the session cookie and the cleared link cookie both pass`);
    } finally {
      globalThis.fetch = real;
      if (before === undefined) delete proc.env[key]; else proc.env[key] = before;
    }
  }
}

// ---------------------------------------------------------------------------------------------- the chat: a texted code never stays
function chatWalks() {
  const codes = texted.slice(0, 6).map((x) => x.code);
  for (const c of codes) for (const say of [`my code is ${c}`, `here's the code ${c}`, `Trainee texted me ${c}`, `${c} is the sign in code`, `verification code: ${c.slice(0, 3)} ${c.slice(3)}`]) {
    const got = codeInChat(say);
    check("leaks", !!got && got.reply && !got.text.includes(c) && !got.text.includes(`${c.slice(0, 3)} ${c.slice(3)}`), `chat: "${say}" is answered by the safety text and the code is removed`);
  }
}

// ------------------------------------------------------------------------- the chat: a resume's files ride the reply, never a bearer link
// The privacy ruling (2026-11-09, career_resume_task.ts): the PDF is a document on the reply; a link is sent only when asked for, and
// then it is the File page's link, which opens a sign-in and never the bytes.
async function resumeWalks() {
  const fixture = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
  const intake = () => { const p = CareerProfile.createProfile({}); CareerProfile.ingestResume(p, { text: fixture.split("\n").slice(5).join("\n"), fileName: "intake.txt" }); for (const f of p.facts as { id: string }[]) CareerProfile.confirmFact(p, f.id); return p; };
  const w = await fileWorld();
  const asks: [string, boolean][] = [
    ["Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Send me the actual PDF.", false],
    ["Make my resume a one-page PDF for data analyst internships and send it here.", false],
    ["Make my resume a one-page PDF for data analyst internships, and send a download link for the PDF too since the attachment isn't opening.", true],
  ];
  for (const [ask, wantsLink] of asks) {
    const made: string[] = [];
    const file = async () => { const l = await w.link(U, U_LIST); const url = `${FILE_BASE}?t=${encodeURIComponent(l)}`; made.push(url); return { url }; };
    const turn = await resumeTaskTurn({ message: ask, ctx: { profile: intake() }, userId: U, now: w.now(), deps: { uploaded: async () => true, file } });
    const docs = turn?.documents ?? [];
    check("leaks", docs.length >= 1, `resume "${ask.slice(0, 40)}...": the PDF rides the reply (${docs.length})`);
    const urls = (turn?.reply ?? "").match(/https?:\/\/\S+/g) ?? [];
    if (!wantsLink) check("leaks", urls.length === 0 && made.length === 0, `resume "${ask.slice(0, 40)}...": files attached, no link in the reply (${urls.join(" ")})`);
    else {
      check("leaks", urls.length === 1 && urls[0] === made[0], `resume link ask: one link, the File page's`);
      const t = new URL(urls[0] ?? FILE_BASE).searchParams.get("t") ?? "";
      w.jar.clear();
      const open = await w.go(`?t=${encodeURIComponent(t)}`); const page = await w.go("");
      check("leaks", open.r.status === 303 && h1(page.html) === "Sign in" && !/%PDF|application\/pdf/.test(page.html), `resume link: opens a sign-in, never the bytes`);
    }
    // The File link asked for is the one token allowed in the reply: it says which file, never who, and opens only a sign-in.
    const asked = made.map((u) => new URL(u).searchParams.get("t") ?? "");
    for (const d of docs as { base64?: string }[]) { const hit = leaked(turn?.reply ?? "", { allow: asked }); check("leaks", !hit && !(turn?.reply ?? "").includes(d.base64?.slice(0, 40) ?? "\u0000"), `resume reply: no token, code or bytes`); }
  }
}

Deno.test({ name: "item 14 accounts loop: sign-in, links, connections, sign-out (ACCOUNTS_LOOP leaks unrefused dead)", sanitizeResources: false, sanitizeOps: false, async fn() {
  let pg: Pg | null = null;
  // STORE=pg or CI: the deployed store over Postgres 16 (CI has it); STORE=memory or a local run without it: the memory twin.
  const want = Deno.env.get("STORE") ?? (Deno.env.get("CI") === "true" ? "pg" : "memory");
  if (want === "pg") {
    if (!pgBinDir()) throw new Error("STORE=pg needs Postgres 16 binaries (PGBIN=)");
    if (Deno.uid?.() === 0) throw new Error("STORE=pg runs as an unprivileged user (initdb)");
    pg = await startPg();
    for (const id of [U, V]) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test');`);
    const double = postgrestDouble(pg, { url: "http://supabase.test", serviceKey: "service-c14", users: {} });
    const admin = createClient("http://supabase.test", "service-c14", { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
    sessionStoreOf = () => supabaseSessionStore(admin);
  }
  capture();
  try {
    await fileWalks(true);
    await fileWalks(false);
    await connectWalks(true);
    await connectWalks(false);
    await proxyWalks();
    chatWalks();
    await resumeWalks();
  } finally { release(); await pg?.stop(); }
  for (const line of LOGS) { const hit = leaked(line); check("leaks", !hit, `log line carries ${hit}: ${line.slice(0, 80)}`); }
  console.log(`ACCOUNTS_LOOP store=${pg ? "pg" : "memory"} leaks=${tally.leaks} unrefused=${tally.unrefused} dead=${tally.dead} checks=${tally.checks} codes_texted=${texted.length} log_lines=${LOGS.length}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`ACCOUNTS_LOOP pending_ruling=${ruling.length}`); for (const r of ruling) console.log(`  RULING ${r}`);
  nodeAssert.equal(tally.leaks + tally.unrefused + tally.dead, 0, failures.join("\n"));
} });
