// R10 WO-F fix 11 (spec C.23 panels 8-9, E.7 item 61): connecting an inbox is explicit and recoverable.
//   - before the provider's page: the account (chosen on the provider's page, then named here), the task's purpose, the exact
//     scopes the consent URL asks for, and reading / sending / deleting as separate effects;
//   - after the redirect: a stored grant ("connected", with the address, what it may do and a working Disconnect) is told apart
//     from a cancelled consent, an incomplete redirect, a failure and a different account ("Connection not finished / No access
//     saved", Retry), and a different account is named, never used in place of the one asked for;
//   - Disconnect works end to end through the page (the landing's form, and the connect page's own);
//   - opening a link (bare, expired, used, a link preview) never shows an address or any account without sign-in.
// Memory fakes and a fake clock: no Google, no Microsoft, no database. What these cannot show is listed in the PR: the real
// providers' consent screens and redirects (Google's test user is an open owner item).
import assertNode from "node:assert/strict";
import { mintConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { connectLanding } from "../../supabase/functions/_shared/connect_landing.ts";
import { handleConnect, type ConnectDeps, type ProviderId, type ProviderInfo, type ProviderState } from "../../supabase/functions/trainee-connect/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "connect-link-secret-r10-0123456789-abcdef";
const U = "11111111-1111-4111-8111-1111111110aa", V = "22222222-2222-4222-8222-2222222220bb";
const NOW = Date.parse("2026-11-09T15:00:00Z");
const BASE = "https://trainee.example/connect", BOT_URL = "https://t.me/trainee_test_bot";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_SCOPES = ["openid", "email", READ];
const MS_SCOPES = ["openid", "email", "offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite"];
const ADDR = "ada.fictional@example.test", OTHER = "someone.else@example.test";
const ENV: Record<string, string> = { TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: BASE };
const env = { get: (k: string) => ENV[k] };
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";

// A stateful memory world: connecting and disconnecting change what status() says.
function world() {
  const conn: Record<string, Record<ProviderId, ProviderState>> = {};
  const none = (): Record<ProviderId, ProviderState> => ({ google: { state: "not_connected", email: null }, microsoft: { state: "not_connected", email: null } });
  const used = new Set<string>();
  const log = { started: [] as string[], disconnected: [] as string[] };
  const info: Record<ProviderId, ProviderInfo> = { google: { configured: true, scopes: GOOGLE_SCOPES }, microsoft: { configured: true, scopes: MS_SCOPES } };
  const d: ConnectDeps = {
    env, now: () => NOW, providers: () => info,
    status: async (u) => conn[u] ?? none(),
    start: async (p, u) => { log.started.push(`${p}:${u}`); return `https://accounts.example/${p}/consent?state=s1`; },
    disconnect: async (p, u) => { log.disconnected.push(`${p}:${u}`); (conn[u] ??= none())[p] = { state: "not_connected", email: null }; return { ok: true, reply: "Gmail is disconnected. Trainee's access is removed." }; },
    claimLink: async (_u, jti) => { if (used.has(jti)) return false; used.add(jti); return true; },
  };
  const connect = (u: string, p: ProviderId, email: string) => { (conn[u] ??= none())[p] = { state: "connected", email }; };
  return { d, log, connect };
}
const link = (u = U, now = NOW, ttlMs?: number) => mintConnectToken({ secret: SECRET, userId: u, reason: "replies", channel: "telegram", now, kind: "l", ttlMs });
const get = (d: ConnectDeps, url: string, headers: Record<string, string> = {}) => handleConnect(new Request(url, { headers: { "user-agent": BROWSER, ...headers } }), d);
async function open(d: ConnectDeps, t?: string) {
  const first = await get(d, `${BASE}?t=${encodeURIComponent(t ?? (await link())!)}`);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  return await (await get(d, BASE, { cookie })).text();
}
// Posts a form exactly as the page drew it (its action and its hidden fields), the way a browser submits it.
async function submit(d: ConnectDeps, html: string, button: RegExp) {
  const forms = [...html.matchAll(/<form method="post"( action="([^"]*)")?[^>]*>([\s\S]*?)<\/form>/g)];
  const f = forms.find((m) => button.test(m[3]));
  assert(f, `a form whose button is ${button}`);
  const fields = Object.fromEntries([...f![3].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
  const to = f![2] ?? BASE;
  eq(new URL(to).origin, new URL(BASE).origin, "it posts to the connect page");
  return await handleConnect(new Request(to, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER }, body: new URLSearchParams(fields).toString() }), d);
}

Deno.test("R10 fix 11 consent: before the provider's page, the account, the purpose and the exact scopes, with read, send and delete as separate effects", async () => {
  const w = world();
  const html = await open(w.d);
  const t = plain(html);
  assert(/<h1>Connect your email<\/h1>/.test(html) && /So I can /.test(t), "the purpose");
  assert(/Account: you choose it on Google's page next\. Afterwards this page shows the exact address that was connected\./.test(t), "which account, before the provider step");
  assert(/Account: you choose it on Microsoft's page next/.test(t));
  // Gmail: read yes, send no, delete no; Outlook: send only what you approve; calendar listed on its own
  const gm = html.match(/<section class="acct perms" aria-label="Gmail permissions">([\s\S]*?)<\/section>/)?.[1] ?? "";
  const ms = html.match(/<section class="acct perms" aria-label="Outlook permissions">([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert(gm && ms, "a permissions panel per provider");
  assert(/Read email Yes: sender, subject and a short preview of new email/.test(plain(gm)) && /Send email No/.test(plain(gm)) && /Delete email No/.test(plain(gm)), plain(gm));
  assert(/Send email Only a message you approve word for word/.test(plain(ms)) && /Delete email No/.test(plain(ms)) && /Calendar Reads busy times/.test(plain(ms)), plain(ms));
  for (const s of GOOGLE_SCOPES) assert(gm.includes(`<code>${s}</code>`), `the exact Google scope ${s}`);
  for (const s of MS_SCOPES) assert(ms.includes(`<code>${s}</code>`), `the exact Microsoft scope ${s}`);
  assert(/>Continue with Google</.test(html) && /Not now/.test(html), "the provider step and Not now");
  assert(!/Connected as/.test(html), "nothing says connected before a grant exists");
});

Deno.test("R10 fix 11 success: only a stored grant reads connected, names the address and what it may do, and its Disconnect works end to end", async () => {
  const w = world();
  w.connect(U, "google", ADDR);
  const r = await connectLanding(env, { provider: "google", ok: true, denied: false, email: ADDR, userId: U, scopes: GOOGLE_SCOPES, now: NOW })!;
  eq(r.status, 200);
  const html = await r.text();
  assert(/<h1>Gmail connected<\/h1>/.test(html) && plain(html).includes(`Connected as ${ADDR}.`));
  assert(/Read email: Yes: sender, subject and a short preview of new email\. Send email: No\. Delete email: No\./.test(plain(html)), "what it is allowed to do");
  assert(/form-action 'self' https:\/\/trainee\.example /.test(r.headers.get("content-security-policy") ?? ""), "the Disconnect form may post to the connect page");
  const done = await submit(w.d, html, />Disconnect</);
  eq(done.status, 200);
  assert(/<h1>Gmail disconnected<\/h1>/.test(await done.text()));
  eq(w.log.disconnected, [`google:${U}`], "disconnected exactly this person's Gmail");
  eq((await w.d.status(U)).google.state, "not_connected");
  // and the connect page's own Disconnect, for an account connected before
  w.connect(U, "microsoft", ADDR);
  const page = await open(w.d);
  assert(/Your email is connected/.test(page) && plain(page).includes(`Connected as ${ADDR}`));
  eq((await submit(w.d, page, />Disconnect</)).status, 200);
  eq(w.log.disconnected, [`google:${U}`, `microsoft:${U}`]);
  assert(/Connect your email/.test(await open(w.d)), "after disconnecting, the page offers to connect again");
});

Deno.test("R10 fix 11 after the redirect: cancelled, incomplete, failed and a different account are 'Connection not finished / No access saved' with Retry; none says connected or carries a session", async () => {
  const cases: [string, Parameters<typeof connectLanding>[1], RegExp, number][] = [
    ["cancelled", { provider: "google", ok: false, denied: true, email: null }, /You chose not to allow access, so nothing was connected/, 200],
    ["incomplete (Google, an error other than declined)", { provider: "google", ok: false, denied: false, email: null, why: "incomplete" }, /The way back from Google was not finished, so nothing was saved/, 400],
    ["incomplete (Microsoft, back without a code)", { provider: "microsoft", ok: false, denied: true, email: null, why: "incomplete" }, /The way back from Microsoft was not finished, so nothing was saved/, 200],
    ["failed", { provider: "google", ok: false, denied: false, email: null }, /Something went wrong on the way back from Google, so nothing was saved/, 400],
    ["another Trainee account's address", { provider: "google", ok: false, denied: false, email: OTHER, why: "taken" }, new RegExp(`You signed in to ${OTHER.replace(/\./g, "\\.")}, which another Trainee account already uses, so nothing was connected`), 400],
    ["not the connected account", { provider: "google", ok: false, denied: false, email: OTHER, why: "other_account" }, new RegExp(`You signed in to ${OTHER.replace(/\./g, "\\.")}, not the account connected to Trainee, so nothing was changed`), 400],
  ];
  for (const [name, o, words, status] of cases) {
    const r = await connectLanding(env, { ...o, userId: U })!;
    eq(r.status, status, name);
    const html = await r.text(), t = plain(html);
    assert(/Connection not finished No access saved\./.test(t), `${name}: Connection not finished / No access saved`);
    assert(words.test(t), `${name}: says what happened (${t})`);
    assert(html.includes(`<a class="primary" href="${BASE}">Retry connection</a>`), `${name}: Retry`);
    assert(html.includes(BOT_URL) && /Back to Telegram/.test(html), `${name}: back to the task`);
    assert(!/Connected as/.test(t) && !/>Disconnect</.test(html) && !/name="t"/.test(html), `${name}: never connected, no session in the page`);
    if (o.why === "taken" || o.why === "other_account") assert(/<h1>A different account was used<\/h1>/.test(html) && /Trainee never uses one account in place of another/.test(t), `${name}: wrong-account recovery`);
  }
});

Deno.test("R10 fix 11 opening a link without sign-in never shows an address or any account; every refusal keeps the way back", async () => {
  const w = world();
  w.connect(U, "google", ADDR);
  const expired = (await link(U, NOW - 2 * 3600_000))!;
  const once = (await link())!;
  await open(w.d, once);
  const pages: [string, Response][] = [
    ["bare /connect", await get(w.d, BASE)],
    ["expired", await get(w.d, `${BASE}?t=${encodeURIComponent(expired)}`)],
    ["used", await get(w.d, `${BASE}?t=${encodeURIComponent(once)}`)],
    ["tampered", await get(w.d, `${BASE}?t=${encodeURIComponent(once.slice(0, -4) + "AAAA")}`)],
    ["a link preview", await handleConnect(new Request(`${BASE}?t=${encodeURIComponent((await link())!)}`, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), w.d)],
    ["a session for someone else", await get(w.d, BASE, { cookie: `tc_s=${await mintConnectToken({ secret: SECRET, userId: V, reason: "replies", channel: "telegram", now: NOW, kind: "s" })}` })],
  ];
  for (const [name, r] of pages) {
    const html = await r.text();
    assert(!html.includes(ADDR), `${name}: no address`);
    assert(!/Connected as/.test(html), `${name}: no account`);
    if (name !== "a link preview" && name !== "a session for someone else") assert(/<div class="actions recovery"><a class="primary" href="https:\/\/t\.me\/trainee_test_bot"[^>]*>Back to Telegram<\/a>/.test(html), `${name}: the way back`);
  }
  // with no bot address configured, the way back is still said, in words
  const bare = await handleConnect(new Request(BASE, { headers: { "user-agent": BROWSER } }), { ...w.d, env: { get: (k: string) => (k === "TRAINEE_BOT_URL" ? undefined : ENV[k]) } });
  assert(/<p class="recovery">Ask Trainee in your chat for a new link to the same task\.<\/p>/.test(await bare.text()));
});
