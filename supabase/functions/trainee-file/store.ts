// The jobs page's store over Supabase: the Telegram job store plus the application row and the "to be prepared" check.
import { supabaseJobStore } from "../_shared/telegram_jobs.ts";
import { wantsFrom } from "../_shared/career_apply_want.ts";
import type { FileStore } from "./handler.ts";
import type { LoginRow, PhoneAuth, SessionRow, SessionStore } from "../_shared/file_session.ts";

// deno-lint-ignore no-explicit-any
export function supabaseFileStore(admin: any): FileStore {
  const base = supabaseJobStore(admin);
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    ...base,
    // By the posting's id, else by its link: the same posting found under another id is already in the applications (each posting
    // goes at most once), and the row says where it stands instead of offering Apply again.
    async appRow(u, jobId, url) {
      const cols = "id,state,reason,confirmation_id,created_at,updated_at,email_confirmed_at,payload,company,url";
      const rows = must(await admin.from("career_apply_jobs").select(cols).eq("user_id", u).eq("job_id", jobId).limit(1), "read the application");
      if (rows?.[0] || !url) return rows?.[0] ?? null;
      const byLink = must(await admin.from("career_apply_jobs").select(cols).eq("user_id", u).eq("url", url).order("created_at", { ascending: false }).limit(1), "read the application");
      return byLink?.[0] ?? null;
    },
    // The queue stores a posting by its key and its board form's link (career_apply_want.ts wantsFrom: a Greenhouse posting's form is
    // on job-boards.greenhouse.io, a Lever posting's at .../apply), so the shown link alone never found it: a row queued to be
    // prepared kept offering Apply instead of saying Preparing (scenarios-file-apply.test.ts, real Postgres).
    async wanted(u, url, job) {
      const key = job ? wantsFrom([{ url: job.url, job_id: job.job_id, company: job.company, title: job.title }], 0).ok[0]?.posting_key ?? null : null;
      const q = admin.from("career_apply_wanted").select("posting_key").eq("user_id", u);
      const rows = must(await (key ? q.eq("posting_key", key) : q.eq("url", url)).limit(1), "read the queue");
      return !!rows?.length;
    },
  };
}

// The linked account of a Telegram identity (channel_contacts: contact 'tg:<id>').
// deno-lint-ignore no-explicit-any
export const supabaseUserOfTelegram = (admin: any) => async (telegramId: string): Promise<string | null> => {
  const r = await admin.from("channel_contacts").select("user_id").eq("contact", `tg:${telegramId}`).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return r.data?.user_id ?? null;
};

// Sessions and phone sign-ins (20261029230000_trainee_file_sessions.sql). The database holds a session id's SHA-256 only; the
// counts are atomic (two guesses at once cannot both get under the cap).
// deno-lint-ignore no-explicit-any
export function supabaseSessionStore(admin: any): SessionStore {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const iso = (t: number) => new Date(t).toISOString();
  return {
    async createSession(x) {
      must(await admin.from("trainee_file_sessions").insert({ id_hash: x.idHash, user_id: x.userId, via: x.via, phone: x.phone, telegram_id: x.telegramId, list: x.list, created_at: iso(x.at), expires_at: iso(x.expiresAt) }), "start the session");
    },
    async session(idHash) {
      return (must(await admin.from("trainee_file_sessions").select("user_id,via,phone,telegram_id,list,expires_at,revoked_at").eq("id_hash", idHash).maybeSingle(), "read the session") ?? null) as SessionRow | null;
    },
    async setList(idHash, list) { must(await admin.from("trainee_file_sessions").update({ list }).eq("id_hash", idHash).is("revoked_at", null), "set the list"); },
    async revoke(idHash, at) { must(await admin.from("trainee_file_sessions").update({ revoked_at: iso(at) }).eq("id_hash", idHash).is("revoked_at", null), "sign out"); },
    async revokeAll(userId, at) { return Number(must(await admin.rpc("trainee_file_sessions_revoke_all", { p_user: userId, p_at: iso(at) }), "sign out everywhere") ?? 0); },
    async beginLogin(l) {
      const rows = must(await admin.rpc("trainee_file_login_begin", { p_jti: l.jti, p_user: l.userId, p_list: l.list, p_at: iso(l.at), p_expires: iso(l.expiresAt) }), "begin the sign-in");
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) throw new Error("begin the sign-in: no row");
      return row as LoginRow;
    },
    async login(jti) {
      return (must(await admin.from("trainee_file_logins").select("jti,user_id,list,phone,matched,sends,tries,expires_at,done_at").eq("jti", jti).maybeSingle(), "read the sign-in") ?? null) as LoginRow | null;
    },
    async setPhone(jti, phone, matched) { must(await admin.from("trainee_file_logins").update({ phone, matched }).eq("jti", jti).is("done_at", null), "record the number"); },
    async countSend(jti, max) { return must(await admin.rpc("trainee_file_login_count", { p_jti: jti, p_what: "send", p_max: max }), "count the text") === true; },
    async countTry(jti, max) { return must(await admin.rpc("trainee_file_login_count", { p_jti: jti, p_what: "try", p_max: max }), "count the try") === true; },
    async finishLogin(jti, at) { return must(await admin.rpc("trainee_file_login_finish", { p_jti: jti, p_at: iso(at) }), "use the link") === true; },
  };
}

// Phone sign-in over Supabase Auth's own SMS one-time code (the project's SMS provider sends it; Trainee never sees or stores a
// code it sent). create_user is false: a code is only ever sent to a number that is already an account's confirmed phone, and
// the handler only asks for the account's OWN number. The Auth session a correct code returns is ended at once; the page keeps
// its own revocable session instead.
// deno-lint-ignore no-explicit-any
export function supabasePhoneAuth(admin: any, o: { url: string; anon: string | undefined; fetch?: typeof fetch }): PhoneAuth {
  const f = o.fetch ?? fetch;
  const auth = (path: string, body: unknown, bearer?: string) => f(`${o.url}/auth/v1/${path}`, { method: "POST", headers: { apikey: o.anon ?? "", "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return {
    async ready() { return !!o.anon; },
    async accountPhone(userId) {
      const r = await admin.auth.admin.getUserById(userId);
      if (r.error) { if (/not found/i.test(r.error.message ?? "")) return null; throw new Error(`read the account: ${r.error.message}`); }
      const u = r.data?.user;
      const d = String(u?.phone ?? "").replace(/[^0-9]/g, "");
      return u?.phone_confirmed_at && d.length >= 8 && d.length <= 15 ? `+${d}` : null;
    },
    async send(phone) {
      if (!o.anon) return { ok: false, why: "not_configured" };
      const r = await auth("otp", { phone, create_user: false, channel: "sms" });
      if (r.ok) return { ok: true };
      const t = await r.text().catch(() => "");
      return /sms provider|phone provider|unsupported phone|phone.*(disabled|not enabled)|sms.*not enabled/i.test(t) ? { ok: false, why: "not_configured" } : { ok: false, why: "refused" };
    },
    async check(phone, code) {
      if (!o.anon) return null;
      const r = await auth("verify", { type: "sms", phone, token: code });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
      const j = await r.json().catch(() => null);
      if (j?.access_token) await auth("logout", {}, j.access_token).then((x) => x.body?.cancel(), () => {});
      return typeof j?.user?.id === "string" ? j.user.id : null;
    },
  };
}

// The person's own time zone, for the days the page shows: the one they set for their weekly digest, else the one on their job
// alerts (both are the person's settings, career_digest_prefs.tz and career_alert_prefs.tz). Null when neither is set or readable;
// the page then reads days in Chicago and says so (file_page.ts postedLine).
// deno-lint-ignore no-explicit-any
export function supabaseTimeZone(admin: any): (userId: string) => Promise<string | null> {
  return async (userId: string) => {
    for (const table of ["career_digest_prefs", "career_alert_prefs"]) {
      let tz: unknown = null;
      try { const r = await admin.from(table).select("tz").eq("user_id", userId).maybeSingle(); tz = r?.error ? null : r?.data?.tz; } catch { tz = null; }
      if (typeof tz === "string" && tz.trim()) return tz.trim();
    }
    return null;
  };
}
