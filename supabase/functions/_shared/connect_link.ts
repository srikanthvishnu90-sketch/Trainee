// The account-connect page's link (owner, 2026-10-28): the bot sends ONE short line and a link; the link opens a single-purpose
// page. Same login as the jobs page (file_link.ts): Telegram's signed Mini App data, or this signed, expiring, single-user link.
// The token is a capability for ONE person to open ONE page, never proof of who someone is; it carries no email, no token for a
// provider and no free text. The reason is a key into the fixed table below, so no model or user text can reach the bot line.
//
//   c1.<base64url claims JSON>.<base64url HMAC-SHA-256("c1." + claims, secret)>
// Secret: TRAINEE_CONNECT_LINK_SECRET, else TRAINEE_FILE_LINK_SECRET (the "c1." prefix keeps the two token kinds apart).
export const CONNECT_TTL_MS = 60 * 60_000; // the link the bot sends: one hour, and once
export const CONNECT_SESSION_TTL_MS = 2 * 3600_000; // a session minted after a link or Telegram's signed data checks out

// Why Trainee wants the mailbox: the words after "so I can". Fixed here; the default is the first.
export const REASONS: Record<string, string> = {
  replies: "track replies to your applications",
  codes: "read the security code an employer emails you",
  send: "send the emails you approve",
  calendar: "find interview times that fit your calendar",
};
export const DEFAULT_REASON = "replies";
export const reasonKey = (k: unknown): string => (typeof k === "string" && Object.hasOwn(REASONS, k) ? k : DEFAULT_REASON);
export const connectLine = (reason: string, url: string) => `Connect your email so I can ${REASONS[reasonKey(reason)]}: ${url}`;

export type ConnectKind = "l" | "s"; // l: the link the bot sends (single-use); s: a session (cookie or Mini App)
export interface ConnectClaims { u: string; w: string; ch: string; k: ConnectKind; j: string; i: number; e: number }
export type ConnectCheck = { ok: true; claims: ConnectClaims } | { ok: false; why: "malformed" | "bad_signature" | "expired" | "not_configured" };

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
const CHANNEL = /^[a-z]{3,16}$/;
export const connectSecret = (env: { get(k: string): string | undefined }) => env.get("TRAINEE_CONNECT_LINK_SECRET") || env.get("TRAINEE_FILE_LINK_SECRET");

export async function mintConnectToken(o: { secret: string | undefined; userId: string; reason: string; channel: string; now: number; ttlMs?: number; kind?: ConnectKind }): Promise<string | null> {
  if (!o.secret || o.secret.length < SECRET_MIN || !o.userId || !CHANNEL.test(o.channel)) return null;
  const j = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims: ConnectClaims = { u: o.userId, w: reasonKey(o.reason), ch: o.channel, k: o.kind ?? "s", j, i: o.now, e: o.now + Math.min(o.ttlMs ?? CONNECT_TTL_MS, 24 * 3600_000) };
  // An array, not an object: an object's base64 starts "eyJ", which the chat's reply guard (connectors.ts say) takes for a JWT.
  const body = b64(enc.encode(JSON.stringify([claims.u, claims.w, claims.ch, claims.k, claims.j, claims.i, claims.e])));
  return `c1.${body}.${await sign(o.secret, `c1.${body}`)}`;
}

export async function verifyConnectToken(token: unknown, secret: string | undefined, now: number): Promise<ConnectCheck> {
  if (!secret || secret.length < SECRET_MIN) return { ok: false, why: "not_configured" };
  const m = /^c1\.([A-Za-z0-9_-]{10,1024})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ""));
  if (!m) return { ok: false, why: "malformed" };
  if (!same(await sign(secret, `c1.${m[1]}`), m[2])) return { ok: false, why: "bad_signature" };
  let c: Partial<ConnectClaims>;
  try {
    const a = JSON.parse(unb64(m[1]));
    if (!Array.isArray(a) || a.length !== 7) return { ok: false, why: "malformed" };
    c = { u: a[0], w: a[1], ch: a[2], k: a[3], j: a[4], i: a[5], e: a[6] };
  } catch { return { ok: false, why: "malformed" }; }
  if (typeof c.u !== "string" || !c.u || !Object.hasOwn(REASONS, String(c.w)) || !CHANNEL.test(String(c.ch)) || (c.k !== "l" && c.k !== "s") || !/^[0-9a-f]{16}$/.test(String(c.j)) || !Number.isFinite(c.i) || !Number.isFinite(c.e)) return { ok: false, why: "malformed" };
  if (now >= (c.e as number) || (c.i as number) > now + 60_000) return { ok: false, why: "expired" };
  return { ok: true, claims: c as ConnectClaims };
}

// What the bot sends: the signed-link fallback and the Mini App URL (Telegram signs who opened it). Null for each unless
// TRAINEE_CONNECT_BASE_URL is https (and, for the link, the secret is set; for the Mini App, the bot token is).
export async function connectUrlsFor(env: { get(k: string): string | undefined }, userId: string, reason: string, now: number, channel = "telegram"): Promise<{ webApp: string | null; url: string | null }> {
  const base = (env.get("TRAINEE_CONNECT_BASE_URL") || "").trim();
  if (!/^https:\/\/[^\s?#]+$/.test(base)) return { webApp: null, url: null };
  const t = await mintConnectToken({ secret: connectSecret(env), userId, reason, channel, now, kind: "l" });
  return { webApp: env.get("TELEGRAM_BOT_TOKEN") ? `${base}?w=${reasonKey(reason)}` : null, url: t ? `${base}?t=${t}` : null };
}
