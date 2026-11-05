// Memory twins of the trainee-file session store (20261029230000_trainee_file_sessions.sql) and of Supabase Auth's SMS code,
// for the file page tests. No network, no database, no real text message.
import type { LoginRow, PhoneAuth, SessionRow, SessionStore } from "../../supabase/functions/_shared/file_session.ts";
import { ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES, ACCOUNT_WINDOW_MS, pageTokenOf, SESSION_ID, sha256, startSession } from "../../supabase/functions/_shared/file_session.ts";

export function memSessions() {
  const sessions = new Map<string, SessionRow>();
  const logins = new Map<string, LoginRow>();
  const iso = (t: number) => new Date(t).toISOString();
  // The per-account caps, as the database counts them (20261031100000_trainee_file_signin_limits.sql): the texts or tries of the
  // account's sign-ins whose number is the account's, begun within ACCOUNT_WINDOW_MS of this one.
  const born = new Map<string, number>();
  const account = (r: LoginRow, k: "sends" | "tries") => [...logins.values()]
    .filter((x) => x.user_id === r.user_id && x.matched && Math.abs((born.get(x.jti) ?? 0) - (born.get(r.jti) ?? 0)) < ACCOUNT_WINDOW_MS).reduce((a, x) => a + x[k], 0);
  const store: SessionStore & { eraseAccount(u: string, at: number): void } = {
    async createSession(x) { sessions.set(x.idHash, { user_id: x.userId, via: x.via, phone: x.phone, telegram_id: x.telegramId, list: x.list, expires_at: iso(x.expiresAt), revoked_at: null }); },
    async session(h) { const r = sessions.get(h); return r ? { ...r } : null; },
    async setList(h, list) { const r = sessions.get(h); if (r && !r.revoked_at) r.list = list; },
    async revoke(h, at) { const r = sessions.get(h); if (r && !r.revoked_at) r.revoked_at = iso(at); },
    async revokeAll(u, at) { let n = 0; for (const r of sessions.values()) if (r.user_id === u && !r.revoked_at) { r.revoked_at = iso(at); n++; } return n; },
    async beginLogin(l) { if (!logins.has(l.jti)) { logins.set(l.jti, { jti: l.jti, user_id: l.userId, list: l.list, phone: null, matched: false, sends: 0, tries: 0, expires_at: iso(l.expiresAt), done_at: null }); born.set(l.jti, l.at); } return { ...logins.get(l.jti)! }; },
    async login(j) { const r = logins.get(j); return r ? { ...r } : null; },
    async setPhone(j, phone, matched) { const r = logins.get(j); if (r && !r.done_at) { r.phone = phone; r.matched = matched; } },
    async countSend(j, max) { const r = logins.get(j); if (!r || r.done_at || r.sends >= max || (r.matched && account(r, "sends") >= ACCOUNT_MAX_SENDS)) return false; r.sends++; return true; },
    async countTry(j, max) { const r = logins.get(j); if (!r || r.done_at || r.tries >= max || (r.matched && account(r, "tries") >= ACCOUNT_MAX_TRIES)) return false; r.tries++; return true; },
    // As supabaseSessionStore.accountTries: the tries of every sign-in of the account begun within the window of this one.
    async accountTries(j) { const r = logins.get(j); if (!r) return 0; return [...logins.values()].filter((x) => x.user_id === r.user_id && Math.abs((born.get(x.jti) ?? 0) - (born.get(r.jti) ?? 0)) < ACCOUNT_WINDOW_MS).reduce((a, x) => a + x.tries, 0); },
    // As 20261105150000_trainee_file_erase_r4.sql does on "forget everything": the account's sessions deleted, every sign-in of it
    // used up with its typed number cleared (its counts kept).
    eraseAccount(u: string, at: number) { for (const [h, x] of sessions) if (x.user_id === u) sessions.delete(h); for (const x of logins.values()) if (x.user_id === u) { x.phone = null; x.done_at ??= iso(at); } },
    async finishLogin(j, at) { const r = logins.get(j); if (!r || r.done_at) return false; r.done_at = iso(at); return true; },
  };
  return { store, sessions, logins };
}

// Accounts and their confirmed phones; send() records the code it "texts" (the test reads it as the person's phone would).
export function fakePhone(accounts: Record<string, string | null>, o: { configured?: boolean } = {}) {
  const texts: { phone: string; code: string }[] = [];
  const live = new Map<string, string>(); // phone -> the latest code
  let n = 0;
  const auth: PhoneAuth = {
    async ready() { return o.configured !== false; },
    async accountPhone(u) { return accounts[u] ?? null; },
    async send(phone) {
      if (o.configured === false) return { ok: false, why: "not_configured" };
      const code = String(314159 + 7 * ++n).slice(-6);
      texts.push({ phone, code }); live.set(phone, code);
      return { ok: true };
    },
    async check(phone, code) {
      if (live.get(phone) !== code) return null;
      live.delete(phone); // one use, as Supabase Auth's
      return Object.entries(accounts).find(([, p]) => p === phone)?.[0] ?? null;
    },
  };
  return { auth, texts, accounts, lastCode: () => texts.at(-1)?.code ?? "" };
}

// A session the way a sign-in makes one (for tests about what a signed-in page does).
export async function sessionFor(s: SessionStore, o: { userId: string; list: string; now: number; via?: "phone" | "telegram"; phone?: string; telegramId?: string }) {
  return await startSession(s, { userId: o.userId, via: o.via ?? "phone", phone: (o.via ?? "phone") === "phone" ? o.phone ?? "+15125550100" : null, telegramId: o.via === "telegram" ? o.telegramId ?? "777" : null, list: o.list, now: o.now });
}
export { sha256 };

// One sign-in world for a test file: every account gets its own confirmed phone the first time it signs in, and tok() opens a
// phone session for it the way the code step would. Pass `auth` into FileDeps as { sessions: auth.store, phone: auth.phone.auth }.
export function signedIn() {
  const s = memSessions();
  const accounts: Record<string, string | null> = {};
  const phone = fakePhone(accounts);
  const phoneOf = (u: string) => (accounts[u] ??= `+1512555${String(1000 + Object.keys(accounts).length).slice(-4)}`);
  const tok = async (userId: string, list: string, now: number) => await sessionFor(s.store, { userId, list, now, phone: phoneOf(userId) });
  return { store: s.store, sessions: s.sessions, logins: s.logins, phone, accounts, phoneOf, tok, deps: { sessions: s.store, phone: phone.auth } };
}

// A post the way a signed-in phone browser sends it (file_session.ts PAGE_TOKEN): the session id only in the HttpOnly tf_s cookie,
// the page's token (drawn for that session) in the form. A test hands the fields with `t` = the session id it opened; a Mini App
// post (one with `init`) or one whose `t` is not a session id goes as it is, with no cookie. `cookie` adds other cookies.
export async function phonePost(f: Record<string, string>, secret: string, o: { cookie?: string; headers?: Record<string, string> } = {}): Promise<RequestInit> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", ...(o.headers ?? {}) };
  const jar = o.cookie ? [o.cookie] : [];
  const fields = { ...f };
  if (!fields.init && SESSION_ID.test(fields.t ?? "")) {
    jar.push(`tf_s=${fields.t}`);
    fields.t = (await pageTokenOf(await sha256(fields.t), secret)) ?? "";
  }
  if (jar.length) headers.cookie = jar.join("; ");
  return { method: "POST", headers, body: new URLSearchParams(fields).toString() };
}
// Telegram's own signing of Mini App data (the documented algorithm; an independent implementation), for a Mini App post.
export async function signedInit(telegramId: string, authDate: number, botToken: string): Promise<string> {
  const p = new URLSearchParams({ auth_date: String(Math.floor(authDate)), query_id: "AAH", user: JSON.stringify({ id: Number(telegramId), first_name: "Ada" }) });
  const enc = new TextEncoder();
  const hmac = async (k: BufferSource, m: string) => await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), botToken), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}
