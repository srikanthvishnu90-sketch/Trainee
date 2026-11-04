// Signed, expiring link tokens for the hosted file pages.
//
// A link token says WHICH list (user id, list id, two times) and is signed so it cannot be altered; it is NOT proof of who
// opened it (owner, 2026-10-29): a forwarded or copied link reaches whoever holds it. So a link opens a phone sign-in and
// nothing private (./file_session.ts): the code goes to the confirmed phone of the account in the claims, and only a code
// that proves that account starts a session. The link is used up by that sign-in, once.
//
//   v1.<base64url claims JSON>.<base64url HMAC-SHA-256("v1." + claims, TRAINEE_FILE_LINK_SECRET)>
export const FILE_TTL_MS = 24 * 3600_000;
// k "l": the link the bot sends (opens a phone sign-in; used up by it, once). k "s": kept for the token format only; sessions are
// server side now (file_session.ts) and the page never accepts a signed "s" token. j: a random id, the link's sign-in row.
export type TokenKind = "l" | "s";
export interface FileClaims { u: string; r: string; k: TokenKind; j: string; i: number; e: number }
export type FileTokenCheck =
  | { ok: true; claims: FileClaims }
  | { ok: false; why: "malformed" | "bad_signature" | "expired" | "not_configured" };

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => { const p = s.replace(/-/g, "+").replace(/_/g, "/"); return atob(p + "=".repeat((4 - (p.length % 4)) % 4)); };
async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const SECRET_MIN = 24;
const LIST = /^[0-9a-f]{10}$/;

// null when no secret is configured (the bot then shows no link at all).
export async function mintFileToken(o: { secret: string | undefined; userId: string; list: string; now: number; ttlMs?: number; kind?: TokenKind }): Promise<string | null> {
  if (!o.secret || o.secret.length < SECRET_MIN || !o.userId || !LIST.test(o.list)) return null;
  const j = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims: FileClaims = { u: o.userId, r: o.list, k: o.kind ?? "s", j, i: o.now, e: o.now + Math.min(o.ttlMs ?? FILE_TTL_MS, 72 * 3600_000) };
  const body = b64(enc.encode(JSON.stringify(claims)));
  return `v1.${body}.${await sign(o.secret, `v1.${body}`)}`;
}

export async function verifyFileToken(token: unknown, secret: string | undefined, now: number): Promise<FileTokenCheck> {
  if (!secret || secret.length < SECRET_MIN) return { ok: false, why: "not_configured" };
  const m = /^v1\.([A-Za-z0-9_-]{10,1024})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ""));
  if (!m) return { ok: false, why: "malformed" };
  if (!same(await sign(secret, `v1.${m[1]}`), m[2])) return { ok: false, why: "bad_signature" };
  let c: Partial<FileClaims>;
  try { c = JSON.parse(unb64(m[1])); } catch { return { ok: false, why: "malformed" }; }
  if (typeof c.u !== "string" || !c.u || !LIST.test(String(c.r)) || (c.k !== "l" && c.k !== "s") || !/^[0-9a-f]{16}$/.test(String(c.j)) || !Number.isFinite(c.i) || !Number.isFinite(c.e)) return { ok: false, why: "malformed" };
  if (now >= (c.e as number) || (c.i as number) > now + 60_000) return { ok: false, why: "expired" };
  return { ok: true, claims: c as FileClaims };
}

// What the bot sends: the Mini App URL (Telegram signs who opened it) and the signed-link fallback. Null for each unless
// TRAINEE_FILE_BASE_URL is https (and, for the link, the secret is set).
export async function feedUrlsFor(env: { get(k: string): string | undefined }, userId: string, list: string, now: number): Promise<{ webApp: string | null; url: string | null }> {
  const base = (env.get("TRAINEE_FILE_BASE_URL") || "").trim();
  if (!/^https:\/\/[^\s?#]+$/.test(base) || !LIST.test(list)) return { webApp: null, url: null };
  const t = await mintFileToken({ secret: env.get("TRAINEE_FILE_LINK_SECRET"), userId, list, now, kind: "l" });
  return { webApp: env.get("TELEGRAM_BOT_TOKEN") ? `${base}?list=${list}` : null, url: t ? `${base}?t=${t}` : null };
}
