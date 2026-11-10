// R10 WO-F, owner readiness review of #640: the connect page's permission words come from ONE source, the scopes each provider's
// consent asks for this purpose (trainee-connect/store.ts consentScopes), and never contradict each other.
//   1. For every provider and every purpose, the scopes the consent URL really asks for (start(), parsed from the URL) equal the
//      scopes the page shows (providers(purpose)). Also for a "send" link with a Gmail already connected (D-037), and with an
//      owner-approved gmail.send (GOOGLE_APPROVED_EXTRA_SCOPES, the D-048 outreach path): then the row says Send email "Only a
//      message you approve word for word", and the receipts-only connect says "No".
//   2. The intro never says "can't send" while any row shown allows sending.
//   3. Each variant at 390x844 in Chromium (R10_SNAPSHOTS=1 writes tests/architect/snapshots/r10-entry/connect-consent-<variant>-390x844.png).
// Memory fakes for the database; no Google, no Microsoft, no network.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { REASONS } from "../../supabase/functions/_shared/connect_link.ts";
import { effectRows, renderConnect, type ProviderView } from "../../supabase/functions/_shared/connect_page.ts";
import { GMAIL_SEND } from "../../supabase/functions/_shared/google_scopes.ts";
import { consentScopes, supabaseConnectDeps } from "../../supabase/functions/trainee-connect/store.ts";
import type { ProviderId } from "../../supabase/functions/trainee-connect/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const U = "11111111-1111-4111-8111-1111111110cc", NOW = Date.parse("2026-11-09T15:00:00Z");
const BASE_ENV: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "test-google-client", OAUTH_STATE_SECRET: "test-state-secret-0123456789abcdef", SUPABASE_URL: "https://project.supabase.test",
  MICROSOFT_OAUTH_CLIENT_ID: "test-ms-client", MICROSOFT_OAUTH_CLIENT_SECRET: "test-ms-secret" };
const envOf = (extra: Record<string, string> = {}) => ({ get: (k: string) => ({ ...BASE_ENV, ...extra } as Record<string, string>)[k] });
// The database calls start() makes, answered in memory: a link issued and opened; the Gmail connection read for a "send" link.
function admin(connectedEmail: string | null) {
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: connectedEmail ? { email: connectedEmail } : null, error: null }) };
  return { rpc: async (name: string) => ({ data: /issue$/.test(name) ? "nonce-1" : { link_id: "link-1" }, error: null }), from: () => chain };
}
const requested = (url: string | null) => { assert(url, "a consent URL"); return new URL(url!).searchParams.get("scope")!.split(" "); };
const sorted = (x: string[]) => [...x].sort();
const PROVIDERS: ProviderId[] = ["google", "microsoft"];
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

Deno.test("R10 owner review: for every provider and purpose, the scopes the consent URL asks for equal the scopes the page shows", async () => {
  for (const extra of [{}, { GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND }]) {
    const env = envOf(extra);
    const d = supabaseConnectDeps(admin(null), env, fetch, () => NOW);
    for (const purpose of Object.keys(REASONS)) for (const p of PROVIDERS) {
      const shown = d.providers(purpose)[p].scopes;
      eq(sorted(requested(await d.start(p, U, "telegram", purpose))), sorted(shown), `${p} / ${purpose}${extra.GOOGLE_APPROVED_EXTRA_SCOPES ? " / gmail.send approved" : ""}: asked = shown`);
      eq(shown, consentScopes(p, purpose, false, env), "the page reads the one table");
    }
  }
  // D-037: a "send" link with a Gmail already connected asks only for gmail.send on that account; the table says the same
  const env = envOf();
  const d = supabaseConnectDeps(admin("ada.fictional@example.test"), env, fetch, () => NOW);
  const url = await d.start("google", U, "telegram", "send");
  eq(sorted(requested(url)), sorted(consentScopes("google", "send", true, env)));
  assert(requested(url).includes(GMAIL_SEND) && new URL(url!).searchParams.get("include_granted_scopes") === "true");
});

Deno.test("R10 owner review: the send row follows the scopes (receipts-only says No; an approved gmail.send says approved-only), and the intro never says 'can't send' when a row allows sending", () => {
  const view = (p: ProviderId, scopes: string[]): ProviderView => ({ id: p, configured: true, state: "not_connected", email: null, scopes });
  const plainG = consentScopes("google", "replies", false, envOf()), sendG = consentScopes("google", "replies", false, envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND }));
  const ms = consentScopes("microsoft", "replies", false, envOf());
  eq(effectRows(plainG).find((r) => r.effect === "Send email")!.answer, "No", "receipts-only Gmail: Send email No");
  eq(effectRows(sendG).find((r) => r.effect === "Send email")!.answer, "Only a message you approve word for word", "Gmail with send: approved-only");
  const variants: [string, ProviderView[]][] = [["gmail-only", [view("google", plainG)]], ["gmail-and-outlook", [view("google", plainG), view("microsoft", ms)]],
    ["gmail-send", [view("google", sendG)]], ["outlook-only", [view("microsoft", ms)]]];
  for (const [name, providers] of variants) {
    const html = renderConnect({ token: "t", reason: "replies", providers, botUrl: "https://t.me/TraineeTestBot" });
    const intro = [...html.matchAll(/<p class="line">([^<]+)<\/p>/g)].map((m) => m[1].replace(/&#39;/g, "'")).join(" ");
    const sends = providers.some((p) => effectRows(p.scopes).find((r) => r.effect === "Send email")!.answer !== "No");
    if (sends) assert(!/can't send|cannot send/i.test(intro), `${name}: the intro says it can't send while a row allows sending: ${intro}`);
    else assert(/can't send/i.test(intro), `${name}: read-only, and the intro says so: ${intro}`);
    for (const p of providers) for (const s of p.scopes) assert(html.includes(`<code>${s}</code>`), `${name}: the exact scope ${s}`);
  }
});


// Screenshots carry the real brand fonts (owner review V: Brygada 1918 and Inter, not a Times fallback): in R10_SNAPSHOTS mode the
// pages' Google Fonts stylesheet and font files are fetched once, before the browser starts, and served from memory (a fetch made
// inside a route handler never resolves under Playwright in Deno). Every other run stays offline: font requests are aborted.
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Brygada+1918:wght@500;700&family=Inter:wght@400;500;600;700&display=swap";
const FONTS = new Map<string, { type: string; body: Uint8Array }>();
async function prefetchFonts() {
  if (!WRITE_FONTS || FONTS.size) return;
  const css = await (await fetch(FONT_CSS, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" } })).text();
  FONTS.set(FONT_CSS, { type: "text/css", body: new TextEncoder().encode(css) });
  for (const u of new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))) FONTS.set(u, { type: "font/woff2", body: new Uint8Array(await (await fetch(u)).arrayBuffer()) });
}
async function fontRoute(route: any): Promise<boolean> {
  const f = FONTS.get(route.request().url());
  if (!f) return false;
  await route.fulfill({ status: 200, headers: { "content-type": f.type, "access-control-allow-origin": "*" }, body: Buffer.from(f.body) });
  return true;
}
const WRITE_FONTS = Deno.env.get("R10_SNAPSHOTS") === "1";
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}
Deno.test({ name: "R10 owner review: each consent variant at 390x844: the permissions start in the first screen with their Continue right after, rows and intro agree, nothing sideways", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw new Error("Playwright is missing in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
  const write = Deno.env.get("R10_SNAPSHOTS") === "1", out = `${ROOT}/tests/architect/snapshots/r10-entry`;
  if (write) await Deno.mkdir(out, { recursive: true });
  const view = (p: ProviderId, scopes: string[]): ProviderView => ({ id: p, configured: true, state: "not_connected", email: null, scopes });
  const g = consentScopes("google", "confirm", false, envOf()), gs = consentScopes("google", "confirm", false, envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND })), m = consentScopes("microsoft", "confirm", false, envOf());
  const allow: ProviderView = { id: "google", configured: true, state: "connected", email: "ada.fictional@example.test", scopes: g, canSend: false, sendScopes: consentScopes("google", "send", true, envOf()) };
  const variants: [string, ProviderView[], string][] = [["gmail-only", [view("google", g)], "confirm"], ["gmail-and-outlook", [view("google", g), view("microsoft", m)], "confirm"], ["gmail-send", [view("google", gs)], "confirm"],
    ["outlook-only", [view("microsoft", m)], "confirm"], ["allow-sending", [allow], "send"]];
  await prefetchFonts();
  const browser = await pw.chromium.launch({ args: ["--no-proxy-server"] });
  const problems: string[] = [];
  try {
    for (const [name, providers, reason] of variants) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await ctx.route("**/*", async (r: any) => { if (!(await fontRoute(r))) await r.abort(); });
      const page = await ctx.newPage();
      await page.setContent(renderConnect({ token: "t", reason, providers, botUrl: "https://t.me/TraineeTestBot" }), { waitUntil: "load" });
      if (WRITE_FONTS) await page.evaluate(() => document.fonts.ready);
      // The permissions come before the Continue button (owner review R11): the first provider's panel starts in the first screen,
      // and its button follows it directly (the person reads what is asked before the step, scrolling if the rows are long).
      const mm = await page.evaluate(() => { const perms = document.querySelector("section.perms") as HTMLElement, btn = document.querySelector("button.primary") as HTMLElement;
        return { perms: perms.getBoundingClientRect().top, follows: perms.getBoundingClientRect().bottom <= btn.getBoundingClientRect().top, sideways: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText }; });
      if (mm.perms > 844) problems.push(`${name}: the permissions start at ${mm.perms}, below the first screen`);
      if (!mm.follows) problems.push(`${name}: the Continue button is not right after its permissions`);
      if (mm.sideways) problems.push(`${name}: scrolls sideways`);
      const sends = providers.some((p) => effectRows(p.scopes).find((r) => r.effect === "Send email")!.answer !== "No");
      if (sends && /can't send/i.test(plain(mm.text))) problems.push(`${name}: "can't send" on screen while a row allows sending`);
      const png = await page.screenshot({ fullPage: true });
      if (write) await Deno.writeFile(`${out}/connect-consent-${name}-390x844.png`, png);
      await ctx.close();
    }
  } finally { await browser.close(); }
  assert(!problems.length, problems.join("\n"));
} });

// ---------------------------------------------------------------- the independent read of #640 (R11, N4, N5)
import { handleConnect, type ConnectDeps } from "../../supabase/functions/trainee-connect/handler.ts";
import { mintConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { connectLanding } from "../../supabase/functions/_shared/connect_landing.ts";
import { SEND_CONSENT_SCOPES } from "../../supabase/functions/_shared/google_scopes.ts";
const SECRET = "connect-scopes-secret-0123456789-abcdef", BASE = "https://trainee.example/connect", BOT = "https://t.me/TraineeTestBot";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
// The real store (consentScopes, start) over the in-memory database; status says whether Gmail is connected and can send.
function sendWorld(gmail: { email: string | null; canSend?: boolean }) {
  const env = envOf({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT });
  const real = supabaseConnectDeps(admin(gmail.email), env, fetch, () => NOW);
  const started: string[] = [];
  const d: ConnectDeps = { ...real, env,
    providers: (purpose) => { const p = real.providers(purpose); return { google: { ...p.google, configured: true }, microsoft: { ...p.microsoft, configured: false } }; },
    status: async () => ({ google: gmail.email ? { state: "connected", email: gmail.email, canSend: !!gmail.canSend } : { state: "not_connected", email: null }, microsoft: { state: "not_connected", email: null } }),
    start: async (p, u, ch, w) => { const url = await real.start(p, u, ch, w); started.push(url!); return url; },
    claimLink: async () => true, disconnect: async () => ({ ok: true, reply: "" }) };
  return { d, started };
}
// Architect amendment, security (item 14, 2026-11-10): the page's forms carry a page token bound to the HttpOnly cookie, so a form is
// posted with the cookie of the page it came from, as a browser does.
let jar = "";
async function openWith(d: ConnectDeps, reason: string) {
  const t = (await mintConnectToken({ secret: SECRET, userId: U, reason, channel: "telegram", now: NOW, kind: "l" }))!;
  // Architect amendment, security: link scanners (x-audit, coordinator ruling 2026-11-10): the GET draws the open page (200,
  // nothing used up); its one button POSTs the link with the page token, which takes the link (303 + cookie).
  const shown = await (await handleConnect(new Request(`${BASE}?t=${encodeURIComponent(t)}`, { headers: { "user-agent": BROWSER } }), d)).text();
  const link = /name="link" value="([^"]+)"/.exec(shown)?.[1] ?? "", pt = /name="pt" value="([^"]+)"/.exec(shown)?.[1] ?? "";
  const first = await handleConnect(new Request(BASE, { method: "POST", headers: { "user-agent": BROWSER, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ link, pt }).toString() }), d);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  jar = cookie;
  return await (await handleConnect(new Request(BASE, { headers: { "user-agent": BROWSER, cookie } }), d)).text();
}
async function post(d: ConnectDeps, html: string, button: RegExp) {
  const f = [...html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].find((m) => button.test(m[1]))!;
  assert(f, `a form for ${button}`);
  const fields = Object.fromEntries([...f[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  return await handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER, cookie: jar }, body: new URLSearchParams(fields).toString() }), d);
}

Deno.test("N4: an allow-sending link (reason=send) for a connected Gmail that can't send is 'Allow sending' asking exactly gmail.send on that account; not connected, the purpose line never promises sending", async () => {
  const w = sendWorld({ email: "ada.fictional@example.test" });
  const html = await openWith(w.d, "send");
  const t = plain(html);
  assert(/<h1>Allow sending from your email<\/h1>/.test(html) && />Allow sending</.test(html), "the allow-sending state, not a dead end");
  // Architect ruling 2026-11-10 (item 14): opened from a link, which may have been forwarded, the address is masked.
  assert(/Account: a\*\*\*@e\*\*\*\.test\. Google's page asks for this same account/.test(t) && !html.includes("ada.fictional@example.test"), "the bound account, masked");
  assert(/Send email Only a message you approve word for word/.test(t) && /Delete email No/.test(t), t);
  for (const s of SEND_CONSENT_SCOPES) assert(html.includes(`<code>${s}</code>`), `asks ${s}`);
  assert(!html.includes(`<code>${"https://www.googleapis.com/auth/gmail.readonly"}</code>`), "the exact list is what this consent asks, not the earlier grant");
  const go = await post(w.d, html, />Allow sending</);
  eq(go.status, 303);
  eq(sorted(requested(go.headers.get("location"))), sorted([...SEND_CONSENT_SCOPES]), "the request is exactly what the page listed");
  // already allowed: nothing more to ask
  assert(/Your email is connected/.test(await openWith(sendWorld({ email: "ada.fictional@example.test", canSend: true }).d, "send")));
  // not connected yet: the first step connects (read-only), and the purpose line says sending comes after, never that it is allowed now
  const first = plain(await openWith(sendWorld({ email: null }).d, "send"));
  assert(/Connect your email/.test(first) && /Send email No/.test(first), first);
  assert(!/So I can send the emails you approve/.test(first) && /Sending is a separate step you allow after this/.test(first), first);
});

Deno.test("R11: the Gmail read row names the security-code emails, the Outlook calendar row says create, change and delete on approval, and the rows come before the Continue buttons", () => {
  const html = renderConnect({ token: "t", reason: "replies", botUrl: BOT, providers: [
    { id: "google", configured: true, state: "not_connected", email: null, scopes: consentScopes("google", "replies", false, envOf()) },
    { id: "microsoft", configured: true, state: "not_connected", email: null, scopes: consentScopes("microsoft", "replies", false, envOf()) }] });
  const t = plain(html);
  assert(/Gmail Account: [^]*Read email Yes: sender, subject and a short preview of new email, and the security codes employers email you/.test(t), "Gmail read row");
  assert(/Calendar Reads busy times; creates, changes or deletes an event only after you approve it/.test(t), "Outlook calendar row");
  assert(html.indexOf('aria-label="Gmail permissions"') < html.indexOf(">Continue with Google<") && html.indexOf('aria-label="Outlook permissions"') < html.indexOf(">Continue with Microsoft<"), "permissions before the buttons");
});

Deno.test("N5: a different account is never substituted: the page names it and offers Retry, or using it instead (via the connect page, nothing changes until the person does it)", async () => {
  const env = { get: (k: string) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT, TRAINEE_CONNECT_BASE_URL: BASE } as Record<string, string>)[k] };
  const other = await (await connectLanding(env, { provider: "google", ok: false, denied: false, email: "other.fictional@example.test", why: "other_account" })!).text();
  assert(other.includes(`<a class="primary" href="${BASE}">Retry connection</a>`) && other.includes(`<a class="secondary" href="${BASE}">Use other.fictional@example.test instead</a>`), "both choices");
  assert(/disconnects the account connected now, then connects other\.fictional@example\.test\. Nothing changes until you do it/.test(plain(other)));
  const taken = await (await connectLanding(env, { provider: "google", ok: false, denied: false, email: "other.fictional@example.test", why: "taken" })!).text();
  assert(/Retry connection/.test(taken) && !/instead</.test(taken), "an address another Trainee account holds can't be used: only Retry");
});
