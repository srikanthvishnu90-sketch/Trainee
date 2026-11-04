// The account-connect page (owner, 2026-10-28): "look and feel like Instinct with a VERY easy process". The bot sends one short
// line and a link with a preview card; the link opens a single-purpose page; the person does one thing; the page confirms and sends
// them back to the chat; no password in chat ever. Same shell and tokens as the jobs page (file_page.ts), same login (Telegram
// Mini App initData, or the signed single-use link). Scopes on the page come from the code that builds the consent URL.
// Everything runs over memory fakes and a fake clock: no Google, no Microsoft, no database.
import assertNode from "node:assert/strict";
import { CONNECT_TTL_MS, connectLine, connectUrlsFor, mintConnectToken, REASONS, verifyConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { renderDone, scopeLines } from "../../supabase/functions/_shared/connect_page.ts";
import { handleConnect, type ConnectDeps, type ProviderId, type ProviderInfo, type ProviderState } from "../../supabase/functions/trainee-connect/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "connect-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const BASE = "https://trainee.example/connect", BOT_URL = "https://t.me/trainee_test_bot";
const READ = "https://www.googleapis.com/auth/gmail.readonly", SEND = "https://www.googleapis.com/auth/gmail.send";
const CLIENT_ID = "123456789-clientid.apps.googleusercontent.com", CLIENT_SECRET = "GOCSPX-super-secret-value";

async function signedInit(telegramId: string, authDate: number, token = BOT) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Ada" }) });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), token), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}

interface Opt { google?: Partial<ProviderInfo>; microsoft?: Partial<ProviderInfo>; state?: Partial<Record<ProviderId, ProviderState>>; disconnectOk?: boolean; startNull?: boolean }
function mem(o: Opt = {}) {
  const used = new Set<string>();
  const log = { started: [] as string[], disconnected: [] as string[], now: NOW };
  const info: Record<ProviderId, ProviderInfo> = {
    google: { configured: true, scopes: ["openid", "email", READ], ...o.google },
    microsoft: { configured: true, scopes: ["openid", "email", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite"], ...o.microsoft },
  };
  const none: ProviderState = { state: "not_connected", email: null };
  const d: ConnectDeps = {
    env: { get: (k) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_FILE_LINK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: BASE, GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET } as Record<string, string>)[k] },
    now: () => log.now,
    providers: () => info,
    status: async (u) => (u === U ? { google: o.state?.google ?? none, microsoft: o.state?.microsoft ?? none } : { google: none, microsoft: none }),
    start: async (p, u) => { log.started.push(`${p}:${u}`); return o.startNull ? null : `https://accounts.example/${p}/consent?state=s1`; },
    disconnect: async (p, u) => { log.disconnected.push(`${p}:${u}`); return o.disconnectOk === false ? { ok: false, reply: "I couldn't remove it just now." } : { ok: true, reply: "Gmail is disconnected. I revoked Trainee's access at Google and deleted what I kept." }; },
    claimLink: async (_u, jti) => { if (used.has(jti)) return false; used.add(jti); return true; },
    userOfTelegram: async (id) => (id === "777" ? U : null),
  };
  return { d, log };
}
const link = (u = U, reason = "replies", now = NOW, ttlMs?: number) => mintConnectToken({ secret: SECRET, userId: u, reason, channel: "telegram", now, kind: "l", ttlMs });
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
const get = (d: ConnectDeps, url: string, headers: Record<string, string> = {}) => handleConnect(new Request(url, { headers: { "user-agent": BROWSER, ...headers } }), d);
const post = (d: ConnectDeps, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() }), d);
// Opens the single-use link the way a browser does: GET ?t= -> 303 + cookie -> GET with the cookie.
async function open(d: ConnectDeps, t?: string) {
  const first = await get(d, `${BASE}?t=${encodeURIComponent(t ?? (await link())!)}`);
  if (first.status !== 303) return { first, page: first, html: await first.text(), cookie: "" };
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const page = await get(d, BASE, { cookie });
  return { first, page, html: await page.text(), cookie };
}
const session = async (d: ConnectDeps) => { const o = await open(d); return /name="t" value="([^"]+)"/.exec(o.html)?.[1] ?? ""; };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ================================================================== the bot's line and its link
Deno.test("the bot line is one short line: the reason, then the link; the link is signed, single-user and expiring", async () => {
  assert(REASONS.replies && REASONS.codes, "every reason is a fixed phrase in code");
  const url = "https://trainee.example/connect?t=abc";
  eq(connectLine("replies", url), `Connect your email so I can ${REASONS.replies}: ${url}`);
  eq(connectLine("nonsense", url), `Connect your email so I can ${REASONS.replies}: ${url}`, "an unknown reason falls back to the default phrase, never to free text");
  assert(!connectLine("replies", url).includes("\n"), "one line");

  const t = (await link())!;
  assert(/^c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(t));
  const ok = await verifyConnectToken(t, SECRET, NOW + 1000);
  assert(ok.ok && ok.claims.u === U && ok.claims.k === "l" && ok.claims.w === "replies" && ok.claims.ch === "telegram");
  eq(await verifyConnectToken(t, SECRET, NOW + CONNECT_TTL_MS + 1), { ok: false, why: "expired" });
  eq(await verifyConnectToken(t.slice(0, -2) + "xx", SECRET, NOW), { ok: false, why: "bad_signature" });
  eq(await verifyConnectToken(t, "another-secret-0123456789-abcdefgh", NOW), { ok: false, why: "bad_signature" });
  eq(await verifyConnectToken(t, undefined, NOW), { ok: false, why: "not_configured" });
  eq(await verifyConnectToken("v1.abc.def", SECRET, NOW), { ok: false, why: "malformed" }, "a jobs-page token is not a connect token");
  eq(await mintConnectToken({ secret: "short", userId: U, reason: "replies", channel: "telegram", now: NOW, kind: "l" }), null, "no secret, no link");

  const urls = await connectUrlsFor({ get: (k) => ({ TRAINEE_CONNECT_BASE_URL: BASE, TRAINEE_FILE_LINK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT } as Record<string, string>)[k] }, U, "replies", NOW);
  assert(urls.url?.startsWith(`${BASE}?t=c1.`) && urls.webApp === `${BASE}?w=replies`);
  eq(await connectUrlsFor({ get: () => undefined }, U, "replies", NOW), { webApp: null, url: null }, "nothing configured: no link");
  eq((await connectUrlsFor({ get: (k) => ({ TRAINEE_CONNECT_BASE_URL: "http://insecure.example/c", TRAINEE_FILE_LINK_SECRET: SECRET } as Record<string, string>)[k] }, U, "replies", NOW)).url, null, "https only");
});

// ================================================================== the page: one thing to do
Deno.test("the page: title, two plain lines, ONE primary button, Microsoft secondary, a muted Not now; Trainee tokens, both themes", async () => {
  const { d } = mem();
  const { first, page, html } = await open(d);
  eq(first.status, 303); assert(!(first.headers.get("location") ?? "").includes("c1."), "the token never stays in the URL");
  assert(/HttpOnly/.test(first.headers.get("set-cookie") ?? "") && /Secure/.test(first.headers.get("set-cookie") ?? ""));
  eq(page.status, 200);
  assert(/<h1>[^<]*Connect your email[^<]*<\/h1>/.test(html), "a title");
  eq(count(html, /class="primary"/g), 1, "exactly one primary button");
  assert(/class="primary"[^>]*>\s*Continue with Google\s*</.test(html), "its label");
  eq(count(html, /class="secondary"/g), 1);
  assert(/class="secondary"[^>]*>\s*Continue with Microsoft\s*</.test(html));
  assert(/class="notnow"[^>]*href="https:\/\/t\.me\/trainee_test_bot"[^>]*>\s*Not now\s*</.test(html), "a muted Not now that goes back to the chat");
  // Exactly two plain lines on what Trainee reads and what it never does.
  const lines = [...html.matchAll(/<p class="line">([^<]+)<\/p>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
  eq(lines.length, 2, "two plain lines");
  assert(/read/i.test(lines[0]) && /subject/i.test(lines[0]), lines[0]);
  assert(/approv/i.test(lines[1]) && /delet/i.test(lines[1]) && /exact/i.test(lines[1]), lines[1]);
  // The shell and tokens of the jobs page.
  assert(html.includes("--accent:#5C2751") && html.includes("--bg:#FAF8F4") && html.includes("prefers-color-scheme:dark"), "plum accent, warm off-white, dark mode");
  assert(html.includes("Brygada+1918") && html.includes("Inter"), "Inter and Brygada 1918");
  assert(html.includes('class="mark"') && html.includes(">T</text>"), "the T mark");
  // The plum fill is only the main action: no other element may take the accent as a background.
  eq(count(html, /class="(?:secondary|notnow|lnk)"/g) >= 2, true);
  assert(!/\.secondary\{[^}]*background:var\(--accent\)/.test(html), "secondary is not filled");
  // Nothing owner-provided is ever printed.
  for (const s of [CLIENT_ID, CLIENT_SECRET, SECRET, BOT]) assert(!html.includes(s), "no secret in the page");
  assert(!/type="password"/i.test(html), "no password field, ever");
  assert(page.headers.get("cache-control") === "no-store" && /noindex/.test(page.headers.get("x-robots-tag") ?? ""));
});

Deno.test("scopes on the page come from the code's consent scopes: read-only says it can't send; a send scope says approved-only", async () => {
  const read = scopeLines(["openid", "email", READ]);
  assert(/subject/i.test(read[0]) && /preview/i.test(read[0]) && !/\bsends?\b/i.test(read[0]), read[0]);
  assert(/can.t send/i.test(read[1]) && /delet/i.test(read[1]) && /exact/i.test(read[1]), read[1]);
  const send = scopeLines(["openid", "email", READ, SEND]);
  assert(/approv/i.test(send[1]) && /exact/i.test(send[1]) && /never delet/i.test(send[1]), send[1]);
  const { d } = mem({ google: { scopes: ["openid", "email", READ, SEND] } });
  const { html } = await open(d);
  assert(/exact/.test(html), "the page follows the scopes the consent asks for");
  const ms = scopeLines(["openid", "email", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite"]);
  assert(/calendar/i.test(ms.join(" ")) && /approv/i.test(ms.join(" ")), ms.join(" | "));
  // Only Google configured, read-only: the Microsoft button and its scope note are absent.
  const g = await open(mem({ microsoft: { configured: false } }).d);
  assert(!/Microsoft/.test(g.html), "Microsoft is not shown when it is not configured");
  eq(count(g.html, /class="primary"/g), 1);
  // Microsoft's extra reach (calendar, send) is stated under its own button, from its scopes.
  const both = await open(mem().d);
  assert(/calendar/i.test(both.html.split("Continue with Microsoft")[1] ?? ""), "Microsoft's calendar scope is stated near its button");
});

Deno.test("only Microsoft configured: it takes the primary place; nothing configured: an honest 'not available yet' and no button at all", async () => {
  const ms = await open(mem({ google: { configured: false } }).d);
  assert(/class="primary"[^>]*>\s*Continue with Microsoft\s*</.test(ms.html) && !/Google/.test(ms.html.replace(/Google's/g, "")), "Microsoft alone is the one primary action");
  eq(count(ms.html, /class="secondary"/g), 0);
  const none = await open(mem({ google: { configured: false }, microsoft: { configured: false } }).d);
  eq(none.page.status, 200);
  assert(/not available yet/i.test(none.html), "honest");
  eq(count(none.html, /<button/g) + count(none.html, /class="primary"/g) + count(none.html, /<form/g), 0, "no dead button, no form");
  assert(/Back to Telegram/.test(none.html));
});

// ================================================================== login: the link, and Telegram's own identity
Deno.test("the signed link works once; a second use, an expired one and a tampered one say so; a link-preview crawler does not use it up", async () => {
  const { d } = mem();
  const t = (await link())!;
  const crawler = await get(d, `${BASE}?t=${encodeURIComponent(t)}`, { "user-agent": "TelegramBot (like TwitterBot)" });
  eq(crawler.status, 200);
  const prev = await crawler.text();
  assert(prev.includes('property="og:title"') && prev.includes('property="og:description"'), "the preview card");
  assert(/so I can/i.test(prev) || /replies/i.test(prev), "the card says why");
  assert(!prev.includes(U) && !/class="primary"/.test(prev), "nothing about the person, no action");
  eq((await get(d, `${BASE}?t=${encodeURIComponent(t)}`)).status, 303, "the crawler did not use it up");
  const again = await get(d, `${BASE}?t=${encodeURIComponent(t)}`);
  eq(again.status, 410); assert(/already used/i.test(await again.text()));
  const old = await link(U, "replies", NOW - CONNECT_TTL_MS - 5000);
  const exp = await get(d, `${BASE}?t=${encodeURIComponent(old!)}`);
  eq(exp.status, 410); const expHtml = await exp.text();
  assert(/expired/i.test(expHtml) && /Back to Telegram|new link/i.test(expHtml), "expired says so and points back");
  eq((await get(d, `${BASE}?t=${encodeURIComponent(t.slice(0, -3) + "AAA")}`)).status, 403);
  eq((await get(d, BASE)).status, 403, "no link, no cookie: nothing");
  eq((await get(d, BASE, { cookie: "tc_s=garbage" })).status, 403);
  eq((await get(mem().d, `${BASE}?t=${encodeURIComponent(t)}`)).status, 303, "a fresh store has not seen it");
  // not configured: no secret
  const bare = mem().d; bare.env = { get: () => undefined };
  eq((await get(bare, `${BASE}?t=${encodeURIComponent(t)}`)).status, 503);
});

Deno.test("Telegram Mini App login: signed initData maps to the linked account; unlinked, forged and stale are refused", async () => {
  const { d } = mem({ state: { google: { state: "connected", email: "ada@gmail.example" } } });
  const boot = await get(d, `${BASE}?w=replies`);
  eq(boot.status, 200);
  const bh = await boot.text();
  assert(bh.includes("telegram-web-app.js") && /Signing you in/i.test(bh), "reads Telegram's signed data and posts it back");
  const ok = await post(d, { init: await signedInit("777", NOW / 1000 - 30), w: "replies" });
  eq(ok.status, 200);
  assert(/Connected as ada@gmail\.example/.test(await ok.text()), "the verified identity sees their own state");
  eq((await post(d, { init: await signedInit("999", NOW / 1000 - 30), w: "replies" })).status, 403, "Telegram id not linked to an account");
  eq((await post(d, { init: await signedInit("777", NOW / 1000 - 30, "999:OTHER-BOT"), w: "replies" })).status, 403, "forged");
  eq((await post(d, { init: await signedInit("777", NOW / 1000 - 7200), w: "replies" })).status, 410, "stale");
  eq((await post(d, { init: "x", w: "replies" })).status, 403);
  eq((await post(d, { w: "replies" })).status, 403, "no proof, nothing");
  // frame-ancestors: Telegram's clients only
  assert(/frame-ancestors https:\/\/web\.telegram\.org/.test(ok.headers.get("content-security-policy") ?? ""));
});

// ================================================================== the one thing: continue
Deno.test("Continue starts consent for the verified person only, from the session; the link token alone cannot start; no provider is guessed", async () => {
  const { d, log } = mem();
  const t = await session(d);
  const r = await post(d, { t, action: "start", provider: "google" });
  eq(r.status, 303); eq(r.headers.get("location"), "https://accounts.example/google/consent?state=s1");
  const j = await post(d, { t, action: "start", provider: "microsoft" }, { accept: "application/json" });
  eq(j.status, 200); eq(await j.json(), { url: "https://accounts.example/microsoft/consent?state=s1" }, "script path: JSON, so a Mini App can open it in the phone's browser");
  eq(log.started, [`google:${U}`, `microsoft:${U}`], "always the session's person");
  // a user id smuggled in the form changes nothing
  await post(d, { t, action: "start", provider: "google", u: V, user_id: V });
  eq(log.started[2], `google:${U}`);
  // the single-use link token is not a session
  const raw = (await link())!;
  eq((await post(d, { t: raw, action: "start", provider: "google" })).status, 403);
  eq((await post(d, { t, action: "start", provider: "yahoo" })).status, 400);
  eq((await post(d, { t, action: "start" })).status, 400);
  eq((await post(d, { t, action: "format-my-disk" })).status, 400);
  eq(log.started.length, 3);
  // GET never starts anything.
  const { cookie } = await open(d);
  await get(d, `${BASE}?action=start&provider=google`, { cookie });
  eq(log.started.length, 3);
});

Deno.test("a provider that is not configured never starts; a start that cannot be made says so and connects nothing", async () => {
  const off = mem({ microsoft: { configured: false } });
  const t = await session(off.d);
  const r = await post(off.d, { t, action: "start", provider: "microsoft" });
  eq(r.status, 503); assert(/not available yet/i.test(await r.text()));
  eq(off.log.started.length, 0);
  const broken = mem({ startNull: true });
  const t2 = await session(broken.d);
  const b = await post(broken.d, { t: t2, action: "start", provider: "google" });
  eq(b.status, 503); assert(/not available yet|nothing was connected/i.test(await b.text()));
});

// ================================================================== the other states
Deno.test("already connected: the page says who, offers one Disconnect and Back to Telegram, and no second connect", async () => {
  const { html } = await open(mem({ state: { google: { state: "connected", email: "ada@gmail.example" } } }).d);
  assert(/Connected as ada@gmail\.example/.test(html));
  assert(!/Continue with Google/.test(html), "no connect button for what is already connected");
  assert(/Disconnect/.test(html) && /Back to Telegram/.test(html) && html.includes(BOT_URL));
  const esc = await open(mem({ state: { google: { state: "connected", email: "<img src=x onerror=alert(1)>@x.test" } } }).d);
  assert(!esc.html.includes("<img src=x"), "an address is escaped");
});

Deno.test("token revoked: the page says access stopped working and offers Reconnect as the one primary action", async () => {
  const { html } = await open(mem({ state: { google: { state: "needs_reconnect", email: "ada@gmail.example" } } }).d);
  assert(/stopped working|no longer/i.test(html) && /ada@gmail\.example/.test(html));
  eq(count(html, /class="primary"/g), 1);
  assert(/class="primary"[^>]*>\s*Reconnect Google\s*</.test(html));
  assert(!/Connected as ada@gmail\.example/.test(html), "does not claim it is connected");
});

Deno.test("disconnect is one tap and a plain confirmation; it acts for the session's person only; a failure never says it worked", async () => {
  const { d, log } = mem({ state: { google: { state: "connected", email: "ada@gmail.example" } } });
  const t = await session(d);
  const r = await post(d, { t, action: "disconnect", provider: "google", u: V });
  eq(r.status, 200);
  const h = await r.text();
  assert(/disconnected/i.test(h) && /deleted/i.test(h), "a plain confirmation");
  assert(/Back to Telegram/.test(h));
  eq(log.disconnected, [`google:${U}`]);
  eq((await post(d, { t, action: "disconnect", provider: "yahoo" })).status, 400);
  eq((await post(d, { t: (await link())!, action: "disconnect", provider: "google" })).status, 403, "the link token cannot disconnect");
  const bad = mem({ state: { google: { state: "connected", email: "ada@gmail.example" } }, disconnectOk: false });
  const tb = await session(bad.d);
  const f = await post(bad.d, { t: tb, action: "disconnect", provider: "google" });
  eq(f.status, 500);
  const fh = (await f.text()).replace(/&#39;/g, "'");
  assert(/couldn't/i.test(fh) && !/is disconnected/i.test(fh), "no false success");
});

Deno.test("after consent: a calm done state names the account and sends them back; a denied consent says nothing was connected", () => {
  const ok = renderDone({ outcome: "connected", provider: "google", email: "ada@gmail.example", botUrl: BOT_URL });
  assert(/Connected as ada@gmail\.example/.test(ok) && /Back to Telegram/.test(ok) && ok.includes(`href="${BOT_URL}"`));
  eq(count(ok, /class="primary"/g), 1);
  const denied = renderDone({ outcome: "denied", provider: "google", email: null, botUrl: BOT_URL });
  assert(/nothing was connected/i.test(denied) && /Back to Telegram/.test(denied) && !/Connected as/.test(denied));
  const failed = renderDone({ outcome: "failed", provider: "microsoft", email: null, botUrl: null });
  assert(/nothing was (?:saved|connected)/i.test(failed) && !/Back to Telegram/.test(failed) && !/<a [^>]*href=""/.test(failed), "no dead link without a bot address");
  const xss = renderDone({ outcome: "connected", provider: "google", email: "<script>alert(1)</script>", botUrl: BOT_URL });
  assert(!xss.includes("<script>alert(1)"), "escaped");
  assert(ok.includes("--accent:#5C2751") && ok.includes("prefers-color-scheme:dark"), "same shell, both themes");
});

Deno.test("the page's scripts are exactly the ones the CSP allows (hashes), and it can be framed only by Telegram", async () => {
  const { d } = mem();
  const { page, html } = await open(d);
  const csp = page.headers.get("content-security-policy") ?? "";
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(scripts.length >= 1);
  for (const s of scripts) {
    const h = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
    assert(csp.includes(`'sha256-${h}'`), "every inline script is allowed by hash");
  }
  assert(/default-src 'none'/.test(csp) && /frame-ancestors https:\/\/web\.telegram\.org/.test(csp));
  assert(!/'unsafe-eval'/.test(csp));
  assert(/form-action 'self'/.test(csp), "forms post back to this page only");
});

// ================================================================== wiring: the bot's line, and the OAuth callbacks' landing
// deno-lint-ignore no-explicit-any
function stubAdmin(tables: Record<string, unknown[]> = {}): any {
  const make = (rows: unknown[]) => { const chain: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res({ data: rows, error: null }) : chain), apply: () => chain }); return chain; };
  return { from: (name: string) => make(tables[name] ?? []), rpc: async (name: string) => ({ data: name.endsWith("_issue") ? "N".repeat(32) : null, error: null }) };
}
Deno.test("the chat: 'connect gmail' with the page switched on is ONE line (reason, then link) with a preview-able link; switched off, the old link stands", async () => {
  const { connectorChatTurn } = await import("../../supabase/functions/_shared/connectors.ts");
  const env = (extra: Record<string, string>) => ({ get: (k: string) => ({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, OAUTH_STATE_SECRET: "state-secret-0123456789-abcdef", GMAIL_LINK_BASE: "https://x.example/functions/v1/gmail-oauth", ...extra } as Record<string, string>)[k] });
  const turn = (e: ReturnType<typeof env>) => connectorChatTurn({ admin: stubAdmin({ channel_contacts: [{ channel: "telegram" }] }), env: e, fetch: (() => { throw new Error("no network"); }) as unknown as typeof fetch, now: () => NOW, message: "connect gmail", userId: U, threadId: V, bridge: true });
  const on = await turn(env({ TRAINEE_CONNECT_BASE_URL: BASE, TRAINEE_FILE_LINK_SECRET: SECRET }));
  assert(on && /^Connect your email so I can [^\n]+: https:\/\/trainee\.example\/connect\?t=c1\.[A-Za-z0-9_.-]+$/.test(on.reply), on?.reply);
  assert(!on!.reply.includes("\n") && on!.resultStatus === "link", "one line");
  eq((on!.meta as { link_button: { text: string } }).link_button.text, "Connect email");
  const off = await turn(env({}));
  assert(off && /one-time link/.test(off.reply) && !/c1\./.test(off.reply), "unchanged until the owner switches the page on");
  // The page needs the secret too: a base without a secret sends the old link, never a link that can't open.
  const half = await turn(env({ TRAINEE_CONNECT_BASE_URL: BASE }));
  assert(half && /one-time link/.test(half.reply));
});

Deno.test("the OAuth callbacks land on the page's done state once it is switched on, and keep their own pages until then", async () => {
  const { connectLanding } = await import("../../supabase/functions/trainee-connect/handler.ts");
  const off = { get: () => undefined };
  eq(connectLanding(off, { provider: "google", ok: true, denied: false, email: "ada@gmail.example" }), null);
  const on = { get: (k: string) => ({ TRAINEE_CONNECT_BASE_URL: BASE, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] };
  const ok = await connectLanding(on, { provider: "google", ok: true, denied: false, email: "ada@gmail.example" })!;
  eq(ok.status, 200);
  const h = await ok.text();
  assert(/Connected as ada@gmail\.example/.test(h) && h.includes(`href="${BOT_URL}"`) && /Back to Telegram/.test(h));
  const denied = await connectLanding(on, { provider: "microsoft", ok: false, denied: true, email: null })!;
  eq(denied.status, 200); assert(/nothing was connected/i.test(await denied.text()));
  const failed = await connectLanding(on, { provider: "google", ok: false, denied: false, email: null })!;
  eq(failed.status, 400);
  assert(/frame-ancestors/.test(ok.headers.get("content-security-policy") ?? "") && ok.headers.get("cache-control") === "no-store");
  // Source pin: both callbacks use the landing, and the Google one reads which grant the state names before choosing the page.
  const g = await Deno.readTextFile(new URL("../../supabase/functions/gmail-oauth/index.ts", import.meta.url));
  assert(/connectLanding\(Deno\.env/.test(g) && /access_denied/.test(g));
  const o = await Deno.readTextFile(new URL("../../supabase/functions/outlook-oauth/index.ts", import.meta.url));
  assert(/landing: \(o\) => connectLanding\(Deno\.env, \{ provider: "microsoft"/.test(o));
});

Deno.test("the one-time link survives HEAD, scanners and fetchers with no browser identity; only a browser GET takes it", async () => {
  const { d } = mem();
  const t = (await link())!, u = `${BASE}?t=${encodeURIComponent(t)}`;
  const head = await handleConnect(new Request(u, { method: "HEAD", headers: { "user-agent": BROWSER } }), d);
  eq(head.status, 200, "HEAD answers with the preview and uses nothing up");
  for (const ua of ["", "Microsoft Office Protocol Discovery", "Mozilla/5.0 (compatible; Barracuda Sentinel)", "python-requests/2.31", "curl/8.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 Safari/537.36 SafeLinks"]) {
    const r = await handleConnect(new Request(u, { headers: ua ? { "user-agent": ua } : {} }), d);
    eq(r.status, 200, `scanner "${ua}" gets the preview`);
    assert(!/class="primary"/.test(await r.text()), "and no action");
  }
  eq((await get(d, u)).status, 303, "after all that, the person's own tap still works");
  eq((await get(d, u)).status, 410, "and only once");
});

Deno.test("an error is logged without the link token", async () => {
  const { d } = mem();
  d.status = async () => { throw new Error(`boom for ${BASE}?t=${"c1.AAAAAAAAAAAA.BBBBBBBBBBBB"} and c1.CCCCCCCCCCCC.DDDDDDDDDDDD`); };
  const logged: string[] = [], real = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try { const { html } = await open(d); assert(/Couldn't do that just now/.test(html.replace(/&#39;/g, "'"))); } finally { console.error = real; }
  assert(logged.length === 1 && !/c1\.[A-Z]{6}/.test(logged[0]) && /redacted/.test(logged[0]), logged.join("|"));
});

Deno.test("flag off, nothing changes: a denied career consent keeps the old landing; flag on, the page; no cross-function imports in the OAuth functions", async () => {
  const { connectPageOn } = await import("../../supabase/functions/_shared/connect_landing.ts");
  eq([connectPageOn({ get: () => undefined }), connectPageOn({ get: () => "http://x.example/c" }), connectPageOn({ get: () => BASE })], [false, false, true]);
  const src = async (f: string) => await Deno.readTextFile(new URL(`../../supabase/functions/${f}`, import.meta.url));
  const g = await src("gmail-oauth/index.ts");
  // The state is read for a denied consent only behind the flag, so with the flag off `purpose` stays "gmail": the legacy redirect, byte for byte.
  assert(/if \(connectPageOn\(Deno\.env\)\) try \{ purpose = \(await verifyState\(url\.searchParams\.get\("state"\)/.test(g), "denied-consent purpose lookup is behind the flag");
  assert(/purpose === "career" \? careerLanding\(ok\)/.test(g) && /Response\.redirect\(`\$\{APP_URL\}\/#you\?gmail=/.test(g), "the legacy landing is still there");
  for (const f of ["gmail-oauth/index.ts", "outlook-oauth/index.ts"]) {
    const imports = [...(await src(f)).matchAll(/from "(\.\.\/[^"]+)"/g)].map((m) => m[1]);
    assert(imports.every((i) => i.startsWith("../_shared/")), `${f} imports only ../_shared: ${imports.filter((i) => !i.startsWith("../_shared/"))}`);
  }
  // A flag-off run of the landing is null for every outcome.
  const { connectLanding } = await import("../../supabase/functions/_shared/connect_landing.ts");
  for (const o of [{ ok: true, denied: false }, { ok: false, denied: true }, { ok: false, denied: false }]) eq(connectLanding({ get: () => undefined }, { provider: "google", email: null, ...o }), null);
});
