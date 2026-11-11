// trainee-connect: the hosted account-connect page. Tests: tests/architect/connect-page.test.ts.
//
// The bot sends one short line and a link; the link opens this one page; the person does one thing (Continue with Google or
// Microsoft); the provider's own page takes the password (never this page, never the chat); the OAuth callback (gmail-oauth /
// outlook-oauth, unchanged redirect URIs) lands on a calm done state with a way back to Telegram.
//
// Login is the jobs page's (trainee-file): Telegram's signed Mini App initData mapped to the linked account, or the signed,
// expiring, single-use link (../_shared/connect_link.ts) exchanged once for an HttpOnly session cookie. Every read and action is
// scoped to the user id inside the verified claims; a user id in a form is never read.
import { CONNECT_SESSION_TTL_MS, connectOpenToken, connectPageToken, connectSecret, mintConnectToken, mintMiniToken, reasonKey, sameOpenToken, samePageToken, verifyConnectToken, verifyMiniToken, type ConnectClaims } from "../_shared/connect_link.ts";
import { verifyInitData } from "../_shared/telegram_webapp.ts";
import { connectHeaders as headers } from "../_shared/connect_landing.ts";
import { DISCONNECT_IN_CHAT, previewOg, renderBootstrap, renderConnect, renderDone, renderOpenLink, renderPreview, renderState, renderUnfinished, type PState, type ProviderId, type ProviderView } from "../_shared/connect_page.ts";

export type { ProviderId } from "../_shared/connect_page.ts";
export { connectLanding } from "../_shared/connect_landing.ts";
export interface ProviderInfo { configured: boolean; scopes: string[]; sendScopes?: string[] } // sendScopes: what "Allow sending" asks for on a connected account (store.ts consentScopes) // scopes: what the consent URL asks for, from the code that builds it
export interface ProviderState { state: PState; email: string | null; canSend?: boolean } // canSend: the grant already includes sending
export interface ConnectDeps {
  env: { get(k: string): string | undefined };
  now: () => number;
  providers(purpose?: string): Record<ProviderId, ProviderInfo>; // the scopes each consent asks for this purpose (store.ts consentScopes)
  status(userId: string): Promise<Record<ProviderId, ProviderState>>;
  start(provider: ProviderId, userId: string, channel: string, reason?: string): Promise<string | null>; // the provider's consent URL for this person, or null when it can't be made
  disconnect(provider: ProviderId, userId: string): Promise<{ ok: boolean; reply: string }>;
  claimLink(userId: string, jti: string, at: number): Promise<boolean>; // true only the first time a link token id is taken
  userOfTelegram?: (telegramId: string) => Promise<string | null>; // channel_contacts: 'tg:<id>' -> the linked account
}

const scrub = (s: string) => s.replace(/c1\.[A-Za-z0-9_.-]+/g, "c1.[redacted]").replace(/([?&]t=)[^\s&]+/g, "$1[redacted]");
const PROVIDERS: ProviderId[] = ["google", "microsoft"];
// Link-preview fetchers, security scanners and anything that does not look like a person's browser: they get the preview card and
// never use up the link. HEAD never does either.
const CRAWLER = /bot|crawl|spider|preview|scan|facebookexternalhit|Slack|WhatsApp|Discord|Embedly|Skype|SafeLinks|Barracuda|Proofpoint|Mimecast|curl|wget|python-requests|okhttp|HeadlessChrome/i;
const looksAutomated = (req: Request) => { const ua = req.headers.get("user-agent") ?? ""; return req.method === "HEAD" || !/^Mozilla\//.test(ua) || CRAWLER.test(ua); };
const cookieOf = (req: Request, name: string) => {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
  return "";
};
const PENDING = "tc_p"; // the provider whose consent was started from this browser and has not come back connected
const NEW_LINK = "Ask Trainee in Telegram to connect your email again and open the new link.";

export async function handleConnect(req: Request, d: ConnectDeps): Promise<Response> {
  const html = async (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...(await headers("text/html; charset=utf-8")), ...extra } });
  const json = async (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...(await headers("application/json; charset=utf-8")), ...extra } });
  const botUrl = (d.env.get("TRAINEE_BOT_URL") || "").trim();
  const bot = /^https:\/\//.test(botUrl) ? botUrl : null;
  const state = (title: string, paras: string[], status: number) => html(renderState(title, paras, bot), status);
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return state("Not supported", ["This page only opens and answers."], 405);
  const url = new URL(req.url);
  let fields: URLSearchParams = url.searchParams;
  if (req.method === "POST") { try { fields = new URLSearchParams(await req.text()); } catch { fields = new URLSearchParams(); } }
  const secret = connectSecret(d.env);
  const unavailable = (status = 503) => state("Not available yet", ["Connecting your email isn't switched on yet, so nothing was connected."], status);
  const bad = (why: string) => why === "not_configured" ? state("Links aren't set up yet", ["The connect page isn't switched on yet, so nothing can be opened. Nothing was connected."], 503)
    : why === "expired" ? state("This link has expired", ["Links last an hour so a forwarded one stops working. " + NEW_LINK], 410)
    : state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);

  // Who this is, and what the page's forms carry (item 14, architect amendment, security): never the session itself.
  //   cookie:   the HttpOnly tc_s session a link was exchanged for; forms carry its page token (connect_link.ts connectPageToken),
  //             which opens nothing without that cookie. A link is the credential and may have been forwarded, so this viewer sees
  //             addresses masked and disconnects in the chat (ruling 2026-11-10).
  //   telegram: Telegram's signed Mini App data; forms carry a Mini App token that opens nothing without Telegram's fresh signed data
  //             for the same Telegram user on the same post.
  //   landing:  the OAuth landing's Disconnect (kind "d", its provider only, minutes long): the person who just finished consent.
  let claims: ConnectClaims;
  let viewer: "cookie" | "telegram" | "landing";
  let pageTok = "";
  const given = fields.get("t") ?? "";
  const notHere = () => state("Open this page from your link again", ["This page works only in the browser or Telegram screen where it was opened, so nothing was changed. " + NEW_LINK], 401);
  const miniSession = async (): Promise<Response | { u: string; tg: string } | null> => {
    const init = await verifyInitData(fields.get("init"), d.env.get("TELEGRAM_BOT_TOKEN"), d.now());
    if (!init.ok) {
      if (init.why === "not_configured") return state("Sign-in isn't set up yet", ["Telegram sign-in isn't switched on yet, so nothing can be opened. Nothing was connected."], 503);
      if (init.why === "stale") return state("This sign-in has expired", ["Close this screen and open the page again from Telegram."], 410);
      return state("Telegram couldn't verify this sign-in", ["Nothing was opened. Open the page again from the button in Telegram."], 403);
    }
    const user = d.userOfTelegram ? await d.userOfTelegram(init.telegramId).catch(() => null) : null;
    return user ? { u: user, tg: init.telegramId } : null;
  };
  const sessionClaims = async (tok: string): Promise<ConnectClaims | Response> => {
    const c = await verifyConnectToken(tok, secret, d.now());
    if (!c.ok) return bad(c.why);
    if (c.claims.k !== "s") return bad("malformed");
    return c.claims;
  };
  const linkField = req.method === "POST" ? (fields.get("link") ?? "") : "";
  if (linkField) {
    // The open page's button: the link, taken ONCE, exchanged for an HttpOnly session cookie, then redirected to a clean URL.
    // Only a POST carrying the page token drawn for this link takes it (a GET never does: link scanners, x-audit).
    const c = await verifyConnectToken(linkField, secret, d.now());
    if (!c.ok) return bad(c.why);
    if (c.claims.k !== "l") return bad("malformed");
    if (!(await sameOpenToken(fields.get("pt") ?? "", c.claims.j, secret))) return bad("malformed");
    const first = await d.claimLink(c.claims.u, c.claims.j, d.now()).catch(() => null);
    if (first === null) return state("Couldn't open this just now", ["Nothing was used up. Try the link again in a minute."], 503);
    if (!first) return state("This link was already used", ["A link opens this page once, so a forwarded copy can't. " + NEW_LINK], 410);
    const session = await mintConnectToken({ secret, userId: c.claims.u, reason: c.claims.w, channel: c.claims.ch, now: d.now(), ttlMs: CONNECT_SESSION_TTL_MS, kind: "s" });
    if (!session) return bad("not_configured");
    return html("", 303, { location: url.pathname, "set-cookie": `tc_s=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(CONNECT_SESSION_TTL_MS / 1000)}` });
  }
  if (req.method === "POST") {
    if (given.startsWith("cp1.")) {
      const cookie = cookieOf(req, "tc_s");
      if (!cookie || !(await samePageToken(given, cookie, secret))) return notHere();
      const c = await sessionClaims(cookie);
      if (c instanceof Response) return c;
      claims = c; viewer = "cookie"; pageTok = given;
    } else if (given.startsWith("cpm.")) {
      const mc = await verifyMiniToken(given, secret, d.now());
      if (!mc) return bad("malformed");
      if (!fields.get("init")) return notHere();
      const who = await miniSession();
      if (who instanceof Response) return who;
      if (!who || who.u !== mc.u || who.tg !== mc.tg) return notHere();
      claims = { u: mc.u, w: mc.w, ch: "telegram", k: "s", j: "0".repeat(16), i: d.now(), e: mc.e }; viewer = "telegram"; pageTok = given;
    } else if (given) {
      // A token in a form is never a session (a scraped or saved page), and never the single-use link.
      const c = await verifyConnectToken(given, secret, d.now());
      if (!c.ok) return bad(c.why);
      if (c.claims.k !== "d" || fields.get("action") !== "disconnect" || fields.get("provider") !== c.claims.ch) return c.claims.k === "s" ? notHere() : bad("malformed");
      claims = c.claims; viewer = "landing";
    } else {
      if (!fields.get("init")) return state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);
      // Mini App login: Telegram's signed initData, then the account that Telegram identity is linked to.
      const who = await miniSession();
      if (who instanceof Response) return who;
      if (!who) return state("This Telegram account isn't linked", ["Share your phone number with Trainee in the Telegram chat first, then open this page again."], 403);
      const minted = await mintMiniToken({ secret, userId: who.u, reason: fields.get("w") ?? "", telegramId: who.tg, now: d.now(), ttlMs: CONNECT_SESSION_TTL_MS });
      if (!minted) return state("Sign-in isn't set up yet", ["The page's link signing isn't switched on yet, so nothing can be opened."], 503);
      claims = { u: who.u, w: reasonKey(fields.get("w")), ch: "telegram", k: "s", j: "0".repeat(16), i: d.now(), e: d.now() + CONNECT_SESSION_TTL_MS }; viewer = "telegram"; pageTok = minted;
    }
  } else if (given) {
    // The link: a GET only draws the page with its one button; it never uses the link up (x-audit, 2026-11-10: a mail
    // scanner that sends a browser's identity used to spend it). The button's POST takes it (above).
    const c = await verifyConnectToken(given, secret, d.now());
    if (!c.ok) return bad(c.why);
    if (c.claims.k !== "l") return bad("malformed");
    if (looksAutomated(req)) {
      // A link preview fetch gets the preview card and nothing about any person.
      return html(renderPreview(previewOg(c.claims.w)));
    }
    const pt = await connectOpenToken(c.claims.j, secret);
    if (!pt) return bad("not_configured");
    return html(renderOpenLink({ link: given, pageToken: pt, reason: c.claims.w }));
  } else {
    if (url.searchParams.has("w")) return html(renderBootstrap(url.searchParams.get("w") ?? "")); // the Mini App page: reads Telegram's signed data and posts it back
    const cookie = cookieOf(req, "tc_s");
    if (!cookie) return state("This link isn't valid", ["It may be cut short or changed. " + NEW_LINK], 403);
    const c = await sessionClaims(cookie);
    if (c instanceof Response) return c;
    claims = c; viewer = "cookie"; pageTok = (await connectPageToken(cookie, secret)) ?? "";
    if (!pageTok) return bad("not_configured");
  }
  const u = claims.u;
  const action = req.method === "POST" && (given || !fields.get("init")) ? (fields.get("action") ?? "") : "";
  const provider = fields.get("provider") ?? "";
  const token = pageTok;

  try {
    if (action) {
      if (!["start", "disconnect", "refresh", "cancel"].includes(action)) return state("Not done", ["That is not something this page can do. Nothing was changed."], 400);
      if (action !== "refresh" && !PROVIDERS.includes(provider as ProviderId)) return state("Not done", ["That is not something this page can do. Nothing was changed."], 400);
      const p = provider as ProviderId;
      if (action === "start") {
        if (!d.providers(reasonKey(claims.w))[p].configured) return unavailable();
        const to = await d.start(p, u, claims.ch, claims.w); // D-037: reason "send" is the incremental gmail.send consent
        if (!to) return unavailable();
        // R10 fix 11: remember that this consent was started, so coming back without finishing it shows "Connecting didn't finish".
        const started = { "set-cookie": `${PENDING}=${p}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(CONNECT_SESSION_TTL_MS / 1000)}` };
        if ((req.headers.get("accept") ?? "").includes("application/json")) return json({ url: to }, 200, started);
        return html("", 303, { location: to, ...started });
      }
      if (action === "cancel") {
        return html(renderState("Nothing was connected", [`You cancelled connecting ${p === "google" ? "Gmail" : "Outlook"}. No access was saved.`], bot), 200, { "set-cookie": `${PENDING}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
      }
      if (action === "disconnect") {
        // A page opened from a link changes no connection: the link may have been forwarded (ruling 2026-11-10).
        if (viewer === "cookie") return state("Not disconnected", [DISCONNECT_IN_CHAT(p), "Nothing was changed."], 403);
        const r = await d.disconnect(p, u);
        if (!r.ok) return state("Not disconnected", [r.reply, "Nothing is confirmed removed. Try again from this page."], 500);
        return html(renderDone({ outcome: "disconnected", provider: p, email: null, botUrl: bot, message: r.reply }));
      }
    }
    const info = d.providers(reasonKey(claims.w)), st = await d.status(u);
    const pending = cookieOf(req, PENDING) as ProviderId;
    if (viewer === "landing") return state("Not done", ["That is not something this page can do. Nothing was changed."], 400);
    if (!action && PROVIDERS.includes(pending) && info[pending].configured && st[pending].state === "not_connected") return html(renderUnfinished({ token, provider: pending, botUrl: bot }));
    const providers: ProviderView[] = PROVIDERS.map((id) => ({ id, configured: info[id].configured, state: st[id].state, email: st[id].email, scopes: info[id].scopes, canSend: st[id].canSend, sendScopes: info[id].sendScopes }));
    return html(renderConnect({ token, reason: reasonKey(claims.w), providers, botUrl: bot, masked: viewer === "cookie" }));
  } catch (e) {
    console.error("[trainee-connect]", scrub(String((e as Error)?.message ?? e)).slice(0, 160)); // never a link token
    return state("Couldn't do that just now", ["Nothing was changed that I can confirm. Try again in a minute."], 503);
  }
}
