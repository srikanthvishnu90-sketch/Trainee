// Who may see a Trainee file page, and for how long (owner, 2026-10-29).
//
// A signed, expiring, single-use link says WHICH list; it never says WHO opened it: whoever first opens a forwarded or copied
// link would otherwise get its session. So a link opens nothing private by itself. The page asks for a phone number, texts a
// code only when that number is the confirmed phone of the account the link was issued for, and opens the list only after the
// code checks out for that same account. Telegram's signed Mini App data is a separate login (Telegram's identity, mapped to the
// linked account); it is never called a phone check.
//
// Either way the result is a SERVER-SIDE session: a random id (the person's browser holds it; the database holds only its
// SHA-256), bound to one account, revocable one at a time or all at once, and checked again on every request: not revoked,
// not expired, and the account still has that confirmed phone (or that Telegram identity is still linked to it).
export const SESSION_TTL_MS = 2 * 3600_000;
export const LOGIN_TTL_MS = 15 * 60_000; // a phone login started from a link: the code must be typed within this
export const MAX_CODE_TRIES = 5; // wrong codes per link before it is locked (security, not a product limit)
export const MAX_CODE_SENDS = 3; // texts per link

export type SessionVia = "phone" | "telegram";
export interface SessionRow { user_id: string; via: SessionVia; phone: string | null; telegram_id: string | null; list: string; expires_at: string; revoked_at: string | null }
export interface LoginRow { jti: string; user_id: string; list: string; phone: string | null; matched: boolean; sends: number; tries: number; expires_at: string; done_at: string | null }
export interface SessionStore {
  createSession(s: { idHash: string; userId: string; via: SessionVia; phone: string | null; telegramId: string | null; list: string; at: number; expiresAt: number }): Promise<void>;
  session(idHash: string): Promise<SessionRow | null>;
  setList(idHash: string, list: string): Promise<void>;
  revoke(idHash: string, at: number): Promise<void>;
  revokeAll(userId: string, at: number): Promise<number>;
  // A phone login for one link (its jti): begun once, a number recorded (and whether it is the account's), counted atomically.
  beginLogin(l: { jti: string; userId: string; list: string; at: number; expiresAt: number }): Promise<LoginRow>;
  login(jti: string): Promise<LoginRow | null>;
  setPhone(jti: string, phone: string | null, matched: boolean): Promise<void>; // null: "use a different number"
  countSend(jti: string, max: number): Promise<boolean>; // false: the cap is reached (the row is not changed)
  countTry(jti: string, max: number): Promise<boolean>; // false: locked
  finishLogin(jti: string, at: number): Promise<boolean>; // true only the first time (the link is used up)
}
export interface PhoneAuth {
  // Whether codes can be texted at all (asked before a typed number is compared, so the answer never depends on the number).
  ready?(): Promise<boolean>;
  // The account's own confirmed phone ("+<digits>"), or null when it has none.
  accountPhone(userId: string): Promise<string | null>;
  // Text a one-time code to the number. Only ever called for the account's own confirmed number.
  send(phone: string): Promise<{ ok: true } | { ok: false; why: "not_configured" | "refused" }>;
  // The account the code proves, or null when the code is wrong or expired.
  check(phone: string, code: string): Promise<string | null>;
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const newSessionId = () => `fs1.${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
export const SESSION_ID = /^fs1\.[0-9a-f]{64}$/;

// A phone number as typed ("(512) 555-0100", "+1 512 555 0100", "15125550100") to "+<digits>"; a 10-digit number is read as
// North American (+1). Null when it cannot be a phone number.
export function normalizePhone(typed: unknown): string | null {
  const s = String(typed ?? "").trim();
  if (!s || s.length > 32 || /[^0-9+().\s-]/.test(s)) return null;
  let d = s.replace(/[^0-9]/g, "");
  if (!s.startsWith("+") && d.length === 10) d = `1${d}`;
  return d.length >= 8 && d.length <= 15 && !d.startsWith("0") ? `+${d}` : null;
}
export const CODE = /^[0-9]{6}$/;
export const codeOf = (typed: unknown) => { const c = String(typed ?? "").replace(/[\s-]/g, ""); return CODE.test(c) ? c : null; };

export async function startSession(store: SessionStore, s: { userId: string; via: SessionVia; phone: string | null; telegramId: string | null; list: string; now: number }): Promise<string> {
  const id = newSessionId();
  await store.createSession({ idHash: await sha256(id), userId: s.userId, via: s.via, phone: s.phone, telegramId: s.telegramId, list: s.list, at: s.now, expiresAt: s.now + SESSION_TTL_MS });
  return id;
}

export type SessionCheck = { ok: true; userId: string; list: string; idHash: string; row: SessionRow } | { ok: false; why: "none" | "expired" | "revoked" | "unbound" | "error" };
// The session behind an id, checked again against the account: a phone session needs the account's confirmed phone to still
// be the number it was opened with; a Telegram session needs that Telegram identity to still be linked to the account. A
// session that no longer binds is revoked on the spot.
export async function checkSession(id: string, d: { sessions: SessionStore; phone?: PhoneAuth; userOfTelegram?: (tg: string) => Promise<string | null>; now: number }): Promise<SessionCheck> {
  if (!SESSION_ID.test(id)) return { ok: false, why: "none" };
  const idHash = await sha256(id);
  let row: SessionRow | null;
  try { row = await d.sessions.session(idHash); } catch { return { ok: false, why: "error" }; }
  if (!row) return { ok: false, why: "none" };
  if (row.revoked_at) return { ok: false, why: "revoked" };
  if (d.now >= Date.parse(row.expires_at)) return { ok: false, why: "expired" };
  let bound = false;
  try {
    if (row.via === "phone") bound = !!row.phone && !!d.phone && (await d.phone.accountPhone(row.user_id)) === row.phone;
    else bound = !!row.telegram_id && !!d.userOfTelegram && (await d.userOfTelegram(row.telegram_id)) === row.user_id;
  } catch { return { ok: false, why: "error" }; }
  if (!bound) { await d.sessions.revoke(idHash, d.now).catch(() => {}); return { ok: false, why: "unbound" }; }
  return { ok: true, userId: row.user_id, list: row.list, idHash, row };
}

export const sessionCookie = (id: string) => `tf_s=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
export const loginCookie = (link: string) => `tf_l=${link}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(LOGIN_TTL_MS / 1000)}`;
export const CLEAR_SESSION = "tf_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
export const CLEAR_LOGIN = "tf_l=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
