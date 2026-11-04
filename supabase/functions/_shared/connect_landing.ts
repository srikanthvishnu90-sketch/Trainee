// The connect page's headers and the OAuth callbacks' landing, in _shared so gmail-oauth and outlook-oauth import nothing from
// another function's folder (each function is bundled with its own folder and ../_shared).
import { CONNECT_BOOT, CONNECT_SCRIPT, renderDone, type ProviderId } from "./connect_page.ts";

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (h: string) => btoa(h.match(/../g)!.map((x) => String.fromCharCode(parseInt(x, 16))).join(""));
const scriptHashes = (async () => `'sha256-${b64(await sha(CONNECT_SCRIPT))}' 'sha256-${b64(await sha(CONNECT_BOOT))}'`)();
const FRAMES = "https://web.telegram.org https://*.telegram.org";
export async function connectHeaders(type: string): Promise<Record<string, string>> {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "content-type": type,
    "content-security-policy": `default-src 'none'; script-src ${await scriptHashes} https://telegram.org; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self' https://accounts.google.com https://login.microsoftonline.com; base-uri 'none'; frame-ancestors ${FRAMES}` };
}

// Where an OAuth callback (gmail-oauth, outlook-oauth) sends the person: the page's calm done state, with the way back to
// Telegram. Null until the owner has switched the connect page on (TRAINEE_CONNECT_BASE_URL), so the callbacks keep their own
// plain pages until then.
export const connectPageOn = (env: { get(k: string): string | undefined }) => /^https:\/\/[^\s?#]+$/.test((env.get("TRAINEE_CONNECT_BASE_URL") || "").trim());
export function connectLanding(env: { get(k: string): string | undefined }, o: { provider: ProviderId; ok: boolean; denied: boolean; email: string | null }): Promise<Response> | null {
  const base = (env.get("TRAINEE_CONNECT_BASE_URL") || "").trim();
  if (!/^https:\/\/[^\s?#]+$/.test(base)) return null;
  const botUrl = (env.get("TRAINEE_BOT_URL") || "").trim();
  const outcome = o.ok ? "connected" : o.denied ? "denied" : "failed";
  return connectHeaders("text/html; charset=utf-8").then((h) => new Response(renderDone({ outcome, provider: o.provider, email: o.email, botUrl: /^https:\/\//.test(botUrl) ? botUrl : null }), { status: o.ok || o.denied ? 200 : 400, headers: h }));
}
