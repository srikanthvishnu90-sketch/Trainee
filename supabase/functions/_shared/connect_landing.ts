// The connect page's headers and the OAuth callbacks' landing, in _shared so gmail-oauth and outlook-oauth import nothing from
// another function's folder (each function is bundled with its own folder and ../_shared).
import { CONNECT_BOOT, CONNECT_SCRIPT, renderDone, type DoneWhy, type ProviderId } from "./connect_page.ts";
import { CONNECT_SESSION_TTL_MS, connectSecret, mintConnectToken } from "./connect_link.ts";

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (h: string) => btoa(h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join(""));
const scriptHashes = (async () => `'sha256-${b64(await sha(CONNECT_SCRIPT))}' 'sha256-${b64(await sha(CONNECT_BOOT))}'`)();
const FRAMES = "https://web.telegram.org https://*.telegram.org";
export async function connectHeaders(type: string, formTo = ""): Promise<Record<string, string>> {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "content-type": type,
    "content-security-policy": `default-src 'none'; script-src ${await scriptHashes} https://telegram.org; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'${formTo ? ` ${formTo}` : ""} https://accounts.google.com https://login.microsoftonline.com; base-uri 'none'; frame-ancestors ${FRAMES}` };
}

// Where an OAuth callback (gmail-oauth, outlook-oauth) sends the person: the page's calm done state, with the way back to
// Telegram. Null until the owner has switched the connect page on (TRAINEE_CONNECT_BASE_URL), so the callbacks keep their own
// plain pages until then.
export const connectPageOn = (env: { get(k: string): string | undefined }) => /^https:\/\/[^\s?#]+$/.test((env.get("TRAINEE_CONNECT_BASE_URL") || "").trim());
// R10 fix 11: userId is passed only after the grant was stored (the code exchanged once, the state spent), so only a real success
// carries a session for this person (the page's Disconnect posts it to the connect page); every other outcome offers Retry as a
// plain link to the connect page, which signs the person in itself. why: a different account, or a redirect that never finished.
export function connectLanding(env: { get(k: string): string | undefined }, o: { provider: ProviderId; ok: boolean; denied: boolean; email: string | null; why?: DoneWhy; scopes?: string[]; userId?: string; now?: number }): Promise<Response> | null {
  const base = (env.get("TRAINEE_CONNECT_BASE_URL") || "").trim();
  if (!/^https:\/\/[^\s?#]+$/.test(base)) return null;
  const botUrl = (env.get("TRAINEE_BOT_URL") || "").trim();
  const outcome = o.ok ? "connected" : o.denied ? "denied" : "failed";
  return (async () => {
    const token = o.ok && o.userId ? await mintConnectToken({ secret: connectSecret(env), userId: o.userId, reason: "", channel: "web", now: o.now ?? Date.now(), ttlMs: CONNECT_SESSION_TTL_MS, kind: "s" }) : null;
    const h = await connectHeaders("text/html; charset=utf-8", token ? new URL(base).origin : "");
    return new Response(renderDone({ outcome, provider: o.provider, email: o.email, botUrl: /^https:\/\//.test(botUrl) ? botUrl : null, why: o.why, scopes: o.scopes,
      manage: token ? { action: base, token } : null, connectUrl: o.ok ? null : base }), { status: o.ok || o.denied ? 200 : 400, headers: h });
  })();
}
