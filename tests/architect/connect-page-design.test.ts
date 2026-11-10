// The account-connect page keeps Trainee's one identity (brand.ts tokens, the contract design-pages-browser.test.ts measures in Chromium:
// shared ground and ink, plum only on the primary action and links) and adds the results page's habits: 16px body, 14px at the very
// least for anything a person decides on, 44px hit areas, every text/ground pair computed here, and states in words. Also the connect
// page's own rules (plain words, nothing sent without approval, no token in a URL) and the chat link for "Submitted - confirmed".
// The browser half is CI-only: locally it logs NOT_RUN when there is no Playwright.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { contrast, DARK, LIGHT, readablePairs, TOKENS_CSS } from "../../supabase/functions/_shared/brand.ts";
import { CONNECT_CSS, renderBootstrap, renderConnect, renderDone, renderPreview, renderState, previewOg, type ProviderView } from "../../supabase/functions/_shared/connect_page.ts";
import { connectLine, connectUrlsFor, mintConnectToken, REASONS, reasonKey, verifyConnectToken, connectPageToken } from "../../supabase/functions/_shared/connect_link.ts";
import { confirmMailAsk } from "../../supabase/functions/_shared/connectors.ts";
import { handleConnect, type ConnectDeps, type ProviderId, type ProviderInfo, type ProviderState } from "../../supabase/functions/trainee-connect/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "connect-link-secret-0123456789-abcdef", BOT = "123456:BOT-TOKEN-for-tests";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const BASE = "https://trainee.example/connect", BOT_URL = "https://t.me/trainee_test_bot";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

// ---------------------------------------------------------------- the pages, all of them
const google = (state: ProviderView["state"], email: string | null = null): ProviderView => ({ id: "google", configured: true, state, email, scopes: ["openid", "email", READ] });
const microsoft = (state: ProviderView["state"] = "not_connected"): ProviderView => ({ id: "microsoft", configured: true, state, email: null, scopes: ["Mail.Read", "Mail.Send", "Calendars.ReadWrite"] });
const PAGES: Record<string, string> = {
  "connect (Google and Microsoft)": renderConnect({ token: "s", reason: "confirm", providers: [google("not_connected"), microsoft()], botUrl: BOT_URL }),
  "connect (no bot link)": renderConnect({ token: "s", reason: "replies", providers: [google("not_connected")], botUrl: null }),
  "reconnect": renderConnect({ token: "s", reason: "replies", providers: [google("needs_reconnect", "ada@gmail.example"), microsoft()], botUrl: BOT_URL }),
  "connected": renderConnect({ token: "s", reason: "replies", providers: [google("connected", "ada@gmail.example"), microsoft()], botUrl: BOT_URL }),
  "not available": renderConnect({ token: "s", reason: "replies", providers: [{ ...google("not_connected"), configured: false }], botUrl: BOT_URL }),
  "done: connected": renderDone({ outcome: "connected", provider: "google", email: "ada@gmail.example", botUrl: BOT_URL }),
  "done: denied": renderDone({ outcome: "denied", provider: "google", email: null, botUrl: BOT_URL }),
  "done: failed": renderDone({ outcome: "failed", provider: "microsoft", email: null, botUrl: null }),
  "done: disconnected": renderDone({ outcome: "disconnected", provider: "google", email: null, botUrl: BOT_URL, message: "Gmail is disconnected." }),
  "state: expired": renderState("This link has expired", ["Links last an hour so a forwarded one stops working."], BOT_URL),
  "bootstrap": renderBootstrap("confirm"),
  "preview": renderPreview(previewOg("confirm")),
};

// ---------------------------------------------------------------- css, read as numbers
const rules = (css: string): { sel: string; body: string }[] => [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const declared = (body: string, prop: string) => { const m = new RegExp(`(?:^|;)\\s*${prop}:([^;]+)`).exec(body); return m ? m[1].trim() : null; };
const px = (v: string | null) => { const m = v && /^(\d+(?:\.\d+)?)px$/.exec(v); return m ? Number(m[1]) : null; };

Deno.test("the page is drawn from the shared Trainee tokens in both schemes, with a 16px body and the plum only on the primary action", () => {
  for (const [name, html] of Object.entries(PAGES)) {
    assert(html.includes(TOKENS_CSS), `${name}: the shared tokens`);
    assert(html.includes(CONNECT_CSS), `${name}: carries the connect styles`);
    assert(html.includes("Brygada+1918") && html.includes("Inter"), `${name}: the shared fonts`);
    assert(/<h1>[^<]+<\/h1>/.test(html), `${name}: one title`);
    assert(html.includes('class="mark"'), `${name}: the T mark`);
  }
  const r = rules(CONNECT_CSS);
  const of = (sel: string) => r.filter((x) => x.sel.split(",").map((s) => s.trim()).includes(sel));
  assert(of(".connect").some((x) => declared(x.body, "font-size") === "16px"), "body text is 16px");
  assert(of(".line").some((x) => declared(x.body, "font-size") === "16px"), "the plain lines are 16px");
  const primary = r.find((x) => x.sel === ".primary")!;
  assert(/background:var\(--accent\)/.test(primary.body) && /color:var\(--accent-ink\)/.test(primary.body), "the primary is the plum action");
  assert(px(declared(r.find((x) => x.sel === ".primary,.secondary")!.body, "min-height")) === 48, "48px tall");
  assert(/background:transparent/.test(r.find((x) => x.sel === ".secondary")!.body), "the secondary is not filled");
  assert(!/background:var\(--accent\)/.test(CONNECT_CSS.replace(/\.primary\{[^}]*\}/, "")), "no other plum fill");
  assert(/\.primary:disabled\{background:var\(--disabled-bg\)/.test(CONNECT_CSS), "a disabled primary is muted, never still plum");
});

Deno.test("every text size on the page is at least 14px, and every tap target is at least 44px tall", () => {
  const r = rules(CONNECT_CSS);
  for (const { sel, body } of r) {
    const size = declared(body, "font-size");
    if (size) assert((px(size) ?? 99) >= 14, `${sel} text is ${size}, under 14px`);
  }
  for (const sel of [".primary,.secondary", ".notnow,.back", ".lnk"]) {
    const x = r.find((y) => y.sel === sel)!;
    assert(px(declared(x.body, "min-height"))! >= 44, `${sel} has a min-height of at least 44px`);
    assert(/display:(?:inline-)?flex/.test(x.body), `${sel} is a flex box, so its height is real (min-height does nothing on an inline box)`);
  }
  for (const [name, html] of Object.entries(PAGES)) for (const m of html.matchAll(/style="([^"]*)"/g)) assert(!/font-size/.test(m[1]), `${name}: no inline font size`);
});

Deno.test("contrast: every pair the page draws as text meets its minimum in light and dark (computed, WCAG relative luminance)", () => {
  for (const [scheme, t] of [["light", LIGHT], ["dark", DARK]] as const) {
    for (const [what, fg, bg, min] of readablePairs(t)) assert(contrast(fg, bg) >= min, `${scheme}: ${what} ${contrast(fg, bg).toFixed(2)}:1 < ${min}`);
    const mine: [string, string, string, number][] = [
      ["account name on card", t.ink, t.panel, 4.5], ["muted line on card", t.mute, t.panel, 4.5], ["Connected chip", t.good, t.bg, 4.5], ["Needs reconnecting chip", t.warn, t.bg, 4.5],
      ["Disconnect on card", t.bad, t.panel, 4.5], ["Disconnect on ground", t.bad, t.bg, 4.5], ["Back to Telegram link", t.link, t.bg, 4.5], ["Not now", t.mute, t.bg, 4.5],
      ["primary text on plum", t.accentInk, t.accent, 7], ["Microsoft button text", t.ink, t.bg, 4.5], ["disabled primary", t.disabledInk, t.disabledBg, 4.5],
    ];
    for (const [what, fg, bg, min] of mine) assert(contrast(fg, bg) >= min, `${scheme}: ${what} ${contrast(fg, bg).toFixed(2)}:1 < ${min}`);
  }
});

Deno.test("states are words, never colour alone: Connected and Needs reconnecting, exactly as the chat says them", () => {
  const chips = (h: string) => [...h.matchAll(/<span class="chip (t-[a-z]+)">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
  eq(chips(PAGES["connected"]), [["t-confirmed", "Connected"]]);
  eq(chips(PAGES["reconnect"]), [["t-attention", "Needs reconnecting"]], "the reconnect page names the state it is in");
  for (const [name, html] of Object.entries(PAGES)) for (const [, word] of chips(html)) assert(word.trim().length > 0, `${name}: a chip with no word`);
  assert(/Connected as ada@gmail\.example/.test(PAGES["done: connected"]), "the account is named only when it exists");
  assert(!/Connected as/.test(PAGES["done: denied"]) && /nothing was connected/i.test(PAGES["done: denied"]), "a denied consent does not say connected");
});

Deno.test("the rules hold on the redesigned page: plain words, nothing sent without approval, no password, no secret or token in any URL", () => {
  const home = PAGES["connect (Google and Microsoft)"];
  const lines = [...home.matchAll(/<p class="line">([^<]+)<\/p>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
  eq(lines.length, 2);
  assert(/approv/i.test(lines[1]) && /exact/i.test(lines[1]) && /delet/i.test(lines[1]), lines[1]);
  for (const [name, html] of Object.entries(PAGES)) {
    assert(!/type="password"/i.test(html), `${name}: no password field`);
    for (const m of html.matchAll(/(?:href|action|src)="([^"]*)"/g)) assert(!/c1\.|[?&]t=|token|secret/i.test(m[1]), `${name}: a token in a URL: ${m[1]}`);
    for (const m of html.matchAll(/<form[^>]*>/g)) assert(/method="post"/.test(m[0]), `${name}: every form posts (a GET form would put its fields in the URL)`);
    assert(!/GOCSPX|client_secret|client_id|BOT-TOKEN/i.test(html), `${name}: no owner secret`);
  }
  // Words a person can say aloud: no internal codes on any page.
  for (const [name, html] of Object.entries(PAGES)) {
    const text = html.replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>|<[^>]+>/g, " ");
    assert(!/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|NOT_WIRED|NEEDS_RECONNECT/.test(text), `${name}: an internal code is on the page`);
  }
});

Deno.test("the reason 'confirm': a fixed phrase in code, signed into the link, shown on the page, and an unknown reason still falls back", async () => {
  assert(REASONS.confirm && /Submitted - confirmed/.test(REASONS.confirm) && /confirmation email/.test(REASONS.confirm), REASONS.confirm);
  eq(reasonKey("confirm"), "confirm");
  eq(reasonKey("<script>"), "replies");
  const tok = await mintConnectToken({ secret: SECRET, userId: U, reason: "confirm", channel: "telegram", now: NOW, kind: "l" });
  const c = await verifyConnectToken(tok, SECRET, NOW);
  assert(c.ok && c.claims.w === "confirm");
  assert(PAGES["connect (Google and Microsoft)"].includes("So I can see the employer&#39;s confirmation email and mark an application Submitted - confirmed."), "the page says why");
  eq(connectLine("confirm", "https://x.example/c"), `Connect your email so I can ${REASONS.confirm}: https://x.example/c`);
  const og = previewOg("confirm");
  assert(/Submitted - confirmed/.test(og.description) && /nothing is sent without your approval/.test(og.description), og.description);
});

// ---------------------------------------------------------------- the handler, end to end over memory fakes
function mem(state: Partial<Record<ProviderId, ProviderState>> = {}) {
  const used = new Set<string>();
  const info: Record<ProviderId, ProviderInfo> = { google: { configured: true, scopes: ["openid", "email", READ] }, microsoft: { configured: true, scopes: ["Mail.Read"] } };
  const none: ProviderState = { state: "not_connected", email: null };
  const d: ConnectDeps = {
    env: { get: (k) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: BASE } as Record<string, string>)[k] },
    now: () => NOW, providers: () => info,
    status: async () => ({ google: state.google ?? none, microsoft: state.microsoft ?? none }),
    start: async (p) => `https://accounts.example/${p}/consent?state=s1`,
    disconnect: async () => ({ ok: true, reply: "Gmail is disconnected." }),
    claimLink: async (_u, jti) => { if (used.has(jti)) return false; used.add(jti); return true; },
    userOfTelegram: async () => U,
  };
  return d;
}
const get = (d: ConnectDeps, url: string, headers: Record<string, string> = {}) => handleConnect(new Request(url, { headers: { "user-agent": BROWSER, ...headers } }), d);
// Architect amendment, security: link scanners (x-audit, coordinator ruling 2026-11-10). A GET of the link draws the open page
// (200, nothing used up); its one button POSTs the link with the page token, which takes the link: 303 + cookie, once.
async function tap(d: ConnectDeps, url: string) {
  const shown = await get(d, url);
  if (shown.status !== 200) return shown;
  const html = await shown.text();
  const link = /name="link" value="([^"]+)"/.exec(html)?.[1], pt = /name="pt" value="([^"]+)"/.exec(html)?.[1];
  if (!link || !pt) return new Response(html, { status: 299 });
  return handleConnect(new Request(url.split("?")[0], { method: "POST", headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ link, pt }).toString() }), d);
}

Deno.test("every page the handler serves wears the design, with the same safe headers; a link opens once and never stays in the URL", async () => {
  const d = mem();
  const tok = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirm", channel: "telegram", now: NOW, kind: "l" }))!;
  const first = await tap(d, `${BASE}?t=${encodeURIComponent(tok)}`);
  eq(first.status, 303);
  eq(first.headers.get("location"), "/connect", "redirected to a clean URL");
  assert(!(first.headers.get("location") ?? "").includes("c1.") && /HttpOnly/.test(first.headers.get("set-cookie") ?? ""));
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const page = await get(d, BASE, { cookie });
  const html = await page.text();
  assert(html.includes(CONNECT_CSS) && /So I can see the employer&#39;s confirmation email/.test(html), "the page, with the reason from the signed link");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert(/style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/.test(csp) && /font-src https:\/\/fonts\.gstatic\.com/.test(csp), "the fonts are allowed, nothing else");
  assert(!/script-src[^;]*\*/.test(csp) && /img-src 'none'/.test(csp));
  eq(page.headers.get("referrer-policy"), "no-referrer");
  eq(page.headers.get("cache-control"), "no-store");
  // The states a handler answers with: each wears the design and has no button.
  const used = await tap(d, `${BASE}?t=${encodeURIComponent(tok)}`);
  eq(used.status, 410);
  const usedHtml = await used.text();
  assert(usedHtml.includes(CONNECT_CSS) && /already used/.test(usedHtml) && !/<button/.test(usedHtml) && /Ask Trainee in Telegram/.test(usedHtml), "a used link: the reason and the way forward in plain words");
  const bad = await get(d, `${BASE}?t=c1.tampered`);
  eq(bad.status, 403);
  assert((await bad.text()).includes(CONNECT_CSS));
  const nope = await handleConnect(new Request(BASE, { method: "DELETE", headers: { "user-agent": BROWSER } }), d);
  eq(nope.status, 405);
  assert((await nope.text()).includes(CONNECT_CSS));
  const boot = await get(d, `${BASE}?w=confirm`);
  const bootHtml = await boot.text();
  assert(bootHtml.includes(CONNECT_CSS) && /data-w="confirm"/.test(bootHtml) && /id="nodata" hidden/.test(bootHtml), "the Mini App page: styled, reason kept");
  // A crawler sees the preview, in the same design, and the link is not used up.
  const tok2 = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirm", channel: "telegram", now: NOW, kind: "l" }))!;
  const crawl = await handleConnect(new Request(`${BASE}?t=${encodeURIComponent(tok2)}`, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), d);
  const crawlHtml = await crawl.text();
  assert(crawl.status === 200 && crawlHtml.includes(CONNECT_CSS) && /Submitted - confirmed/.test(crawlHtml) && !crawlHtml.includes(tok2), "the preview card: no token, no person");
  eq((await tap(d, `${BASE}?t=${encodeURIComponent(tok2)}`)).status, 303, "and it still opens afterward");
});

Deno.test("Continue starts consent from the session only and answers JSON for the page's script; the provider's URL carries no Trainee token", async () => {
  const d = mem();
  const tok = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirm", channel: "telegram", now: NOW, kind: "l" }))!;
  const cookie = ((await tap(d, `${BASE}?t=${encodeURIComponent(tok)}`)).headers.get("set-cookie") ?? "").split(";")[0];
  // Architect amendment, security (item 14, 2026-11-10): the page's forms carry a page token bound to the HttpOnly cookie, posted with it.
  const pageToken = (await connectPageToken(cookie.slice("tc_s=".length), SECRET))!;
  const r = await handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", cookie }, body: new URLSearchParams({ t: pageToken, action: "start", provider: "google" }).toString() }), d);
  eq(r.status, 200);
  const j = await r.json() as { url: string };
  assert(/^https:\/\/accounts\.example\/google\/consent/.test(j.url) && !j.url.includes("c1."), j.url);
  eq((await handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: tok, action: "start", provider: "google" }).toString() }), d)).status, 403, "the single-use link cannot start anything");
});

// ---------------------------------------------------------------- the chat: why "Submitted - confirmed" needs the email, with the link
// deno-lint-ignore no-explicit-any
function stubAdmin(tables: Record<string, unknown[]> = {}): any {
  // deno-lint-ignore no-explicit-any
  const make = (rows: unknown[]) => { const chain: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? (res: (v: unknown) => void) => res({ data: rows, error: null }) : chain), apply: () => chain }); return chain; };
  return { from: (name: string) => make(tables[name] ?? []), rpc: async () => ({ data: null, error: null }) };
}
const chatEnv = (extra: Record<string, string> = {}) => ({ get: (k: string) => ({ GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com", OAUTH_STATE_SECRET: "state-secret-0123456789-abcdef", GMAIL_LINK_BASE: "https://x.example/functions/v1/gmail-oauth", TRAINEE_CONNECT_BASE_URL: BASE, TRAINEE_FILE_LINK_SECRET: SECRET, ...extra } as Record<string, string>)[k] });
const noNet = (() => { throw new Error("no network"); }) as unknown as typeof fetch;

Deno.test("chat: submitted-but-unconfirmed applications and no email connected -> the answer says why and carries the connect link", async () => {
  const d = { admin: stubAdmin(), env: chatEnv(), fetch: noNet, now: () => NOW };
  const one = await confirmMailAsk(d, { userId: U, channel: "telegram", unconfirmed: 1 });
  assert(one, "an ask is made");
  assert(/1 of your applications is submitted, but the employer hasn't confirmed it yet/.test(one!.text), one!.text);
  assert(/Only the employer's confirmation email can mark it Submitted - confirmed/.test(one!.text), "why");
  assert(/I never send anything you haven't approved/.test(one!.text) && /sender, subject and a short preview/.test(one!.text), "what it reads, and the approval rule");
  const url = /Connect it here: (https:\/\/trainee\.example\/connect\?t=c1\.[A-Za-z0-9_.-]+)$/.exec(one!.text)?.[1];
  assert(url, one!.text);
  const claims = await verifyConnectToken(new URL(url!).searchParams.get("t"), SECRET, NOW);
  assert(claims.ok && claims.claims.w === "confirm" && claims.claims.k === "l" && claims.claims.u === U && claims.claims.ch === "telegram", "a single-use link for this person, with the reason confirm");
  eq(one!.meta, { link_button: { text: "Connect email", url } }, "Telegram gets the button");
  const many = await confirmMailAsk(d, { userId: U, channel: "web", unconfirmed: 3 });
  assert(/3 of your applications are submitted, but the employer hasn't confirmed them yet/.test(many!.text) && /mark one Submitted - confirmed/.test(many!.text));
  eq(many!.meta, null, "no button off Telegram");
  const odd = await confirmMailAsk(d, { userId: U, channel: "Not A Channel!", unconfirmed: 1 });
  assert(odd && /\?t=c1\./.test(odd.text), "an odd channel name still gets a link, as web");
});

Deno.test("chat: nothing to ask when nothing waits, when an email is already connected, or when nothing can be connected yet", async () => {
  const d = { admin: stubAdmin(), env: chatEnv(), fetch: noNet, now: () => NOW };
  eq(await confirmMailAsk(d, { userId: U, channel: "telegram", unconfirmed: 0 }), null, "nothing waits on a confirmation");
  const connected = { ...d, admin: stubAdmin({ user_oauth_connections: [{ provider: "google_career", email: "ada@gmail.example", scopes: READ }] }) };
  eq(await confirmMailAsk(connected, { userId: U, channel: "telegram", unconfirmed: 2 }), null, "an email is connected: the mail run does the confirming");
  const neither = { ...d, env: { get: () => undefined } };
  eq(await confirmMailAsk(neither, { userId: U, channel: "telegram", unconfirmed: 2 }), null, "nothing is switched on: no promise of a link");
  // The connect page is off but Gmail is wired: the old way in, in words, no invented link.
  const old = await confirmMailAsk({ ...d, env: chatEnv({ TRAINEE_CONNECT_BASE_URL: "" }) }, { userId: U, channel: "telegram", unconfirmed: 1 });
  assert(old && /Say "connect gmail" and I'll send you a link\.$/.test(old.text) && !/c1\./.test(old.text) && old.meta === null, old?.text);
  const urls = await connectUrlsFor(chatEnv({ TRAINEE_CONNECT_BASE_URL: "" }), U, "confirm", NOW);
  eq(urls, { webApp: null, url: null });
});

Deno.test("chat wiring (source pin): both status answers append the ask from the summary's own count, and a failed ask never breaks the answer", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  assert(/import \{ confirmMailAsk,/.test(src));
  const uses = [...src.matchAll(/confirmMailAsk\(\{ admin, env: Deno\.env, fetch, now: Date\.now \}, \{ userId: user\.id, channel: writerChannel\(\(body as any\)\?\.channel\), unconfirmed: Number\(\((stood|status) as any\)\.summary\?\.submitted_not_confirmed\) \|\| 0 \}\)\.catch\(/g)].map((m) => m[1]);
  eq(uses.sort(), ["status", "stood"], "the standing answer and the status answer");
  assert((src.match(/\$\{(?:stood|status)\.reply\}\\n\\n\$\{needMail\.text\}/g) ?? []).length === 2, "the ask follows the answer; it never replaces it");
});

// ---------------------------------------------------------------- the browser half: real Chromium, phone width, light and dark (CI)
const CI = Deno.env.get("CI") === "true";
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const lum = (c: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Measured in the page: sideways scroll, tap targets, text sizes and each text's contrast against the ground it sits on.
const MEASURE = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.5) return b.c; } return [255,255,255]; };
  const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden]"); };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " '" + (el.textContent || el.value || "").trim().slice(0, 40) + "'";
  const taps = [...document.querySelectorAll("a[href],button")].filter(visible).map((el) => ({ el: name(el), h: el.getBoundingClientRect().height }));
  const texts = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || ["SCRIPT","STYLE"].includes(el.tagName) || el.closest("svg")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    texts.push({ el: name(el), size: parseFloat(s.fontSize), color: rgb(s.color).c, ground: ground(el), family: s.fontFamily });
  }
  const prim = [...document.querySelectorAll(".primary")].filter(visible).map((el) => ({ el: name(el), bg: rgb(getComputedStyle(el).backgroundColor).c, fg: rgb(getComputedStyle(el).color).c, h: el.getBoundingClientRect().height }));
  const h1 = document.querySelector("h1");
  return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, taps, texts, prim, body: ground(document.body), ink: rgb(getComputedStyle(document.body).color).c, h1: h1 ? getComputedStyle(h1).fontFamily : "", bodySize: parseFloat(getComputedStyle(document.body.querySelector(".line") || document.body).fontSize) };
})()`;

Deno.test({
  name: "connect page in Chromium (phone width, light and dark): shared ground, plum primary, 16px body, 14px minimum, 44px taps, AA contrast on every text, no sideways scroll",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pw = playwright();
    if (!pw) {
      if (CI) throw Error("the connect page browser test needs the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Playwright");
      return;
    }
    const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
    if (chrome) { try { Deno.statSync(chrome); } catch { throw Error(`UPMORE_CHROMIUM_PATH is set but ${chrome} does not exist: the browser test cannot run`); } }
    // As root outside CI (a dev box), Chromium's sandbox can't start: run without it rather than skip. CI runs it sandboxed.
    const root = Deno.uid?.() === 0 && !CI;
    let browser: any;
    try {
      browser = await pw.chromium.launch({ headless: true, ...(root ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }), ...(chrome ? { executablePath: chrome } : {}) });
    } catch (e) {
      throw Error(`Chromium did not start, so the connect page was not tested in a browser: ${(e as Error)?.message ?? e}`);
    }
    let seen = 0;
    try {
      const variants: [string, Partial<Record<ProviderId, ProviderState>>, RegExp][] = [
        ["not connected", {}, /Continue with Google/],
        // Architect ruling 2026-11-10 (item 14): a page opened from a link shows the address masked.
        ["connected", { google: { state: "connected", email: "ada@gmail.example" } }, /Connected as a\*\*\*@g\*\*\*\.example/],
        ["needs reconnecting", { google: { state: "needs_reconnect", email: "ada@gmail.example" } }, /Reconnect Google/],
      ];
      for (const scheme of ["light", "dark"] as const) {
        const tok = scheme === "light" ? LIGHT : DARK;
        for (const [label, state, expect] of variants) {
          const d = mem(state);
          const ac = new AbortController();
          const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, (req) => handleConnect(req, d));
          const origin = `http://127.0.0.1:${server.addr.port}`;
          const link = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirm", channel: "telegram", now: NOW, kind: "l" }))!;
          const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: scheme, deviceScaleFactor: 1, userAgent: BROWSER });
          await ctx.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          const pg = await ctx.newPage();
          try {
            await pg.goto(`${origin}/?t=${encodeURIComponent(link)}`);
            // Architect amendment, security: link scanners (x-audit, coordinator ruling 2026-11-10): the link opens a page with one
            // button and uses nothing up; the person's tap on it takes the link (303 to the clean URL).
            await Promise.all([pg.waitForNavigation({ waitUntil: "domcontentloaded" }), pg.click("form.open button.primary")]);
            assert(!pg.url().includes("c1."), `the token is not left in the address bar (${pg.url()})`);
            assert(expect.test(await pg.textContent("main") ?? ""), `${label}: ${expect}`);
            const m = await pg.evaluate(MEASURE), bad: string[] = [];
            if (m.scrollW > m.innerW) bad.push(`scrolls sideways (${m.scrollW} > ${m.innerW})`);
            for (const x of m.taps.filter((x: any) => x.h < 44)) bad.push(`tap target under 44 px: ${x.el} ${x.h}px`);
            for (const x of m.texts.filter((x: any) => x.size < 14)) bad.push(`text under 14 px: ${x.el}`);
            for (const x of m.texts.filter((x: any) => ratio(x.color, x.ground) < 4.5)) bad.push(`text under AA: ${x.el} ${ratio(x.color, x.ground).toFixed(2)}:1`);
            if (!near(m.body, rgbOf(tok.bg))) bad.push(`ground ${m.body} is not ${tok.bg}`);
            if (!near(m.ink, rgbOf(tok.ink))) bad.push(`ink ${m.ink} is not ${tok.ink}`);
            if (m.bodySize < 16) bad.push(`body text ${m.bodySize}px is under 16px`);
            for (const a of m.prim) {
              if (!near(a.bg, rgbOf(tok.accent), 2) || !near(a.fg, rgbOf(tok.accentInk), 2)) bad.push(`the primary ${a.el} is ${a.bg} on ${a.fg}, not the plum action`);
              if (a.h < 48) bad.push(`the primary is ${a.h}px tall`);
            }
            eq(bad, [], `${label} (${scheme})`);
            eq(m.prim.length, 1, `${label}: exactly one primary action`);
            seen++;
          } finally {
            await ctx.close();
            ac.abort();
            await server.finished;
          }
        }
      }
      eq(seen, 6, "light and dark both ran every state");
    } finally {
      await browser.close();
    }
  },
});
