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
// Per ACCOUNT, across all of its links (file page web-security round, 2026-11-02): someone holding many forwarded links of one
// account got 3 texts and 5 code checks from EACH (12 links: 36 texts to the owner's phone, 60 guesses at the code). Counted over
// the sign-ins of the account begun within an hour of each other, only those whose number is the account's (only they text a
// code or check one). The database counts them atomically (20261031100000_trainee_file_signin_limits.sql, the same numbers).
// A phone number is one account's confirmed phone (Supabase Auth keeps phones unique), so this is also the per-phone cap.
export const ACCOUNT_MAX_SENDS = 10; // texts to one account's phone per hour, all links together
export const ACCOUNT_MAX_TRIES = 15; // codes checked for one account per hour, all links together
export const ACCOUNT_WINDOW_MS = 3600_000;
// Time must not tell whether a typed number is the account's (only then is a code texted, and only then is a typed code checked
// with the provider): every phone step answers no sooner than this after it began (deps.ts paces it; the text itself is sent in
// the background, never awaited by the answer).
export const PHONE_STEP_FLOOR_MS = 1500;
export const phonePace = (floorMs = PHONE_STEP_FLOOR_MS) => (_step: string, elapsedMs: number) =>
  new Promise<void>((res) => setTimeout(res, Math.max(0, Math.min(floorMs, floorMs - elapsedMs))));

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
  // false: the link's cap, or the account's (ACCOUNT_MAX_SENDS / ACCOUNT_MAX_TRIES within ACCOUNT_WINDOW_MS), is reached; the row
  // is not changed
  countSend(jti: string, max: number): Promise<boolean>;
  countTry(jti: string, max: number): Promise<boolean>; // false: locked (the link's tries, or the account's)
  // The code tries of ALL the account's sign-ins begun within ACCOUNT_WINDOW_MS of this one, this one included, whatever number
  // each holds. The page locks a sign-in once this reaches ACCOUNT_MAX_TRIES, before countTry, whatever number it holds (file page
  // sign-in round 4: the account's cap counted only sign-ins holding the account's number, so with four forwarded links the
  // fourth answered "Too many wrong codes" for the account's number and "That code didn't work" for any other: whether a typed
  // number is the account's was readable from the answer). countTry's own caps are unchanged. Absent: no such check.
  accountTries?(jti: string): Promise<number>;
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

// WHERE a session may be presented (owner, 2026-10-29: "an unused, forwarded or copied link must not let another person read my
// private data or apply as me"; follow-up 2026-11-02). A page is copied, saved, cached, shared or screenshotted with its HTML, so
// nothing in the HTML may work as the session by itself:
//   phone    the id lives ONLY in the HttpOnly tf_s cookie, and every request needs it. The page's forms carry a page token (below),
//            an HMAC of the session's hash under TRAINEE_FILE_LINK_SECRET: it proves a post came from a page drawn for that
//            session (a cross-site form cannot read it), and it is worth nothing without the cookie (the token never yields the id).
//   telegram the Mini App runs inside Telegram's webview, where this site's cookies may not be kept (a third-party frame on
//            web.telegram.org), so its forms carry the session id; but every request must also carry Telegram's signed initData,
//            still fresh (telegram_webapp.ts INITDATA_MAX_AGE_S) and for the very Telegram user the session is bound to. The
//            initData is never in the HTML (Telegram hands it to the page's script), so a copied Mini App page opens nothing.
// A phone session's id in a form, or a Telegram session's id in a cookie, opens nothing.
export const PAGE_TOKEN = /^fp1\.[0-9a-f]{64}$/;
export async function pageTokenOf(idHash: string, secret: string | undefined): Promise<string | null> {
  if (!secret || !/^[0-9a-f]{64}$/.test(idHash)) return null;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `fp1.${hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`trainee-file/page-token/v1|${idHash}`)))}`;
}
// Constant time over equal lengths.
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const sessionCookie = (id: string) => `tf_s=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
export const loginCookie = (link: string) => `tf_l=${link}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(LOGIN_TTL_MS / 1000)}`;
export const CLEAR_SESSION = "tf_s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
export const CLEAR_LOGIN = "tf_l=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
