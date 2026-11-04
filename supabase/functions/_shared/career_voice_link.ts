// WO-035: the voice mock's link. "start a voice mock for Goldman IB" answers with one link, bare on its own line, to the
// app's voice page. The link carries a token that is:
//   - signed: HMAC-SHA256 over its claims with a key derived from the server's service-role key (never sent anywhere);
//   - bound to the person's account: the claims name the session and the user, and the session row must match both;
//   - expiring: 10 minutes to start (the claim and the session row both say so);
//   - single-use: the row records the start once (career_voice_start in 20261021020000_career_voice_mock.sql).
// The token sits after "#" in the link, so the browser never sends it to the web host; the page posts it to the
// career-voice function only. No password or code is ever in chat.
//
// Pure (Web Crypto only), so it loads on the chat path, in the function and in Node.
export const LINK_TTL_MS = 10 * 60_000;
export const VOICE_PAGE_PATH = "/voice/mock";
// Same default as broker_connect.ts (not imported: that module pulls in the full bundle).
export const DEFAULT_APP_URL = "https://upmore-srikanthvishnu90-sketchs-projects.vercel.app";

// "start": the link the chat sends (opens the call once). "call": handed to the page when the call starts; it posts the
// transcript (the debrief) or moves to the text mock with it, until the call window closes.
export type TokenKind = "start" | "call";
export interface LinkClaims { s: string; u: string; k: TokenKind; exp: number }
export type Verified = { ok: true; claims: LinkClaims } | { ok: false; why: "malformed" | "bad_signature" | "expired" | "wrong_kind" };

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  // The signing key is derived from the server secret with its own label, so the token key is never the secret itself.
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, enc.encode("career-voice-link-v1")));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(claims: LinkClaims, secret: string): Promise<string> {
  if (!secret) throw new Error("no signing secret");
  const body = b64url(enc.encode(JSON.stringify({ s: claims.s, u: claims.u, k: claims.k, exp: claims.exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`v1.${body}`)));
  return `v1.${body}.${b64url(sig)}`;
}

export async function verifyToken(token: unknown, secret: string, now: number, want: TokenKind | "any"): Promise<Verified> {
  if (typeof token !== "string" || token.length > 600 || !secret) return { ok: false, why: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, why: "malformed" };
  const sig = unb64url(parts[2]), body = unb64url(parts[1]);
  if (!sig || !body || sig.length !== 32) return { ok: false, why: "malformed" };
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`v1.${parts[1]}`)))) return { ok: false, why: "bad_signature" };
  let c: any;
  try { c = JSON.parse(new TextDecoder().decode(body)); } catch { return { ok: false, why: "malformed" }; }
  if (!c || !UUID.test(String(c.s)) || !UUID.test(String(c.u)) || (c.k !== "start" && c.k !== "call") || !Number.isFinite(c.exp)) {
    return { ok: false, why: "malformed" };
  }
  if (want !== "any" && c.k !== want) return { ok: false, why: "wrong_kind" };
  if (now >= c.exp) return { ok: false, why: "expired" };
  return { ok: true, claims: { s: c.s, u: c.u, k: c.k, exp: c.exp } };
}

export function appUrl(get: (k: string) => string | undefined): string {
  const u = String(get("UPMORE_APP_URL") || DEFAULT_APP_URL).trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/.test(u) ? u : DEFAULT_APP_URL;
}
export const voiceLink = (base: string, token: string) => `${base}${VOICE_PAGE_PATH}#t=${token}`;

// The rail is wired when the server holds both the OpenAI key (the voice) and the service key (the signature), and the
// owner has turned voice on (CAREER_VOICE=on): the OpenAI key is already set for the chat's model, and a voice minute
// costs far more than a text turn, so the key alone never starts spending on calls. Neither key is returned, logged or
// put in a link.
export function voiceWired(get: (k: string) => string | undefined): { ok: true } | { ok: false; missing: string[] } {
  const missing = ["OPENAI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !get(k));
  if (get("CAREER_VOICE") !== "on") missing.push("CAREER_VOICE=on");
  return missing.length ? { ok: false, missing } : { ok: true };
}

export interface VoiceLinks {
  // A new single-use link for this person's thread, or why there is none.
  create(userId: string, threadId: string, state: unknown, now: number): Promise<{ ok: true; url: string } | { ok: false; reason: "not_wired" | "limit" }>;
}
// The chat's side over Supabase: the session row first (career_voice_create), then the signed link to it.
// deno-lint-ignore no-explicit-any
export function supabaseVoiceLinks(admin: any, get: (k: string) => string | undefined): VoiceLinks {
  return {
    async create(userId, threadId, state, now) {
      if (!voiceWired(get).ok) return { ok: false, reason: "not_wired" };
      const r = await admin.rpc("career_voice_create", { p_user: userId, p_thread: threadId, p_state: state, p_now: new Date(now).toISOString() });
      if (r.error) throw new Error(`create the voice session: ${r.error.message}`);
      if (!r.data) return { ok: false, reason: "limit" };
      const token = await signToken({ s: String(r.data), u: userId, k: "start", exp: now + LINK_TTL_MS }, get("SUPABASE_SERVICE_ROLE_KEY")!);
      return { ok: true, url: voiceLink(appUrl(get), token) };
    },
  };
}
// Deno's environment when there is one (the chat and the function), nothing otherwise (Node test hosts).
export function hostEnv(): (k: string) => string | undefined {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return (k) => { try { return d?.env?.get(k); } catch { return undefined; } };
}
