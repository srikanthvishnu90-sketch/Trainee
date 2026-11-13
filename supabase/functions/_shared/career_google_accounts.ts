// D-062 (owner, 2026-11-11: "do all of it"; Instinct read three Gmail accounts): every Google account a person has connected.
// The first career grant is user_oauth_connections (provider google_career, Vault oauth_google_career_<uid>) and keeps every
// guard it had; each further address is a row of career_google_accounts (20261111120000), with its own token under a name the
// database derives from the owner and the address. Here:
//   googleAccounts        the person's accounts, the first grant first: address, whether it may read and send.
//   accountToken          an access token for one account and one scope, refreshed and written back only over that account's
//                         own grant (career_google_account_vault_refresh); the first grant through careerTokenFor as before.
//   readAllMailboxes      mail tracking's reader across every account: each email carries the address it was read from.
//   disconnectGoogleAccount  one account alone: revoked at Google, its token and its events deleted, read back.
// Nothing here sends; sending stays the send rail's and the reply card's, each after the person's yes to the exact message.
// deno-lint-ignore-file no-explicit-any
import { careerTokenFor, readMailSince, type ReadResult, type TokenDeps } from "./career_mail_gmail.ts";
import { revokeAtGoogle, type RevokeDeps, type RevokeOutcome } from "./google_disconnect.ts";

export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const ADDED_ACCOUNTS_MAX = 5;
export interface GoogleAccount { mailbox: string; primary: boolean; can_read: boolean; can_send: boolean; connected_at: string | null }
const addr = (s: unknown) => String(s ?? "").trim().toLowerCase();
const scopesOf = (s: unknown) => String(s ?? "").split(/[\s,]+/).filter(Boolean);

// A store without career_google_accounts (a project before 20261111120000, or a test double that knows only older tables).
export const addedTableAbsent = (e: unknown) => /career_google_accounts|does not exist|schema cache|PGRST20[25]/i.test(String((e as any)?.message ?? e ?? ""));
const one = (d: any) => (Array.isArray(d) ? d[0] ?? null : d ?? null);
export async function googleAccounts(admin: any, userId: string): Promise<GoogleAccount[]> {
  const first = await admin.from("user_oauth_connections").select("email,scopes,connected_at").eq("user_id", userId).eq("provider", "google_career").maybeSingle();
  if (first.error) throw new Error(`read the Google connection: ${first.error.message}`);
  let rows: any[] = [];
  try {
    const more = await admin.from("career_google_accounts").select("mailbox,scopes,connected_at").eq("user_id", userId).order("connected_at", { ascending: true });
    if (more.error && !addedTableAbsent(more.error)) throw new Error(`read the Google accounts: ${more.error.message}`);
    rows = more.error ? [] : (Array.isArray(more.data) ? more.data : []);
  } catch (e) { if (!addedTableAbsent(e)) throw e; }
  const out: GoogleAccount[] = [];
  const f = one(first.data);
  if (f && (f.email || f.scopes)) { const s = scopesOf(f.scopes); out.push({ mailbox: addr(f.email), primary: true, can_read: s.includes(GMAIL_READ), can_send: s.includes(GMAIL_SEND), connected_at: f.connected_at ?? null }); }
  for (const r of rows) {
    if (!r?.mailbox || out.some((a) => a.mailbox === addr(r.mailbox))) continue;
    const s = scopesOf(r.scopes);
    out.push({ mailbox: addr(r.mailbox), primary: false, can_read: s.includes(GMAIL_READ), can_send: s.includes(GMAIL_SEND), connected_at: r.connected_at ?? null });
  }
  return out;
}

// An access token for one account. mailbox null or the first grant's address: the first grant (careerTokenFor, unchanged).
export function accountToken(d: TokenDeps & { admin: any }, scope: string) {
  const first = careerTokenFor(d, scope);
  return async (userId: string, mailbox: string | null): Promise<string | null> => {
    const accounts = await googleAccounts(d.admin, userId);
    const a = mailbox ? accounts.find((x) => x.mailbox === addr(mailbox)) : accounts[0];
    if (!a) return null;
    if (a.primary) return await first(userId);
    if ((scope === GMAIL_READ && !a.can_read) || (scope === GMAIL_SEND && !a.can_send)) return null;
    const v = await d.admin.rpc("career_google_account_vault_read", { p_user: userId, p_mailbox: a.mailbox });
    if (v.error || typeof v.data !== "string") return null;
    let tok: any;
    try { tok = JSON.parse(v.data); } catch { return null; }
    if (tok.access_token && d.now() < Number(tok.expires_at || 0) - 60000) return String(tok.access_token);
    const id = d.env.get("GOOGLE_OAUTH_CLIENT_ID"), secret = d.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    if (!tok.refresh_token || !id || !secret) return tok.access_token && !tok.expires_at ? String(tok.access_token) : null;
    const r = await d.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: String(tok.refresh_token), grant_type: "refresh_token" }) });
    const nt = await r.json().catch(() => ({}));
    if (!r.ok || !nt.access_token) { if (r.status === 400 || r.status === 401) return null; throw new Error(`refresh the Google account: HTTP ${r.status}`); }
    const kept = await d.admin.rpc("career_google_account_vault_refresh", { p_user: userId, p_mailbox: a.mailbox,
      p_secret: JSON.stringify({ ...tok, access_token: nt.access_token, refresh_token: nt.refresh_token || tok.refresh_token, expires_at: d.now() + (Number(nt.expires_in) || 3600) * 1000 }) });
    if (kept.error || kept.data !== true) return null; // disconnected (or connected again) while this refresh ran: not used
    return String(nt.access_token);
  };
}

// The token a reply is sent with: the named account when it is one of the person's own; with no account named, their only
// account. Several accounts and none named, or a name that is not theirs: null (nothing is sent; never the first grant).
export function ownSendToken(d: TokenDeps & { admin: any }, scope: string) {
  const token = accountToken(d, scope);
  return async (userId: string, mailbox: string | null): Promise<string | null> => {
    const accounts = await googleAccounts(d.admin, userId);
    if (mailbox ? !accounts.some((a) => a.mailbox === addr(mailbox)) : accounts.length > 1) return null;
    return await token(userId, mailbox);
  };
}

// Mail tracking's reader across every account the person connected: each account read since the same cursor, each email tagged
// with the address it was read from; the read position is the earliest any account reached (none is skipped past). Accounts
// that may not read are left out and named in `skipped`.
export function readAllMailboxes(o: { fetch: typeof fetch; accounts: (userId: string) => Promise<GoogleAccount[]>; token: (userId: string, mailbox: string | null) => Promise<string | null> }) {
  return async (userId: string, since: number, now: number): Promise<ReadResult & { mailboxes?: string[]; skipped?: string[] }> => {
    const accounts = (await o.accounts(userId)).filter((a) => a.can_read);
    if (accounts.length <= 1) {
      const a = accounts[0] ?? null;
      const r = await readMailSince({ fetch: o.fetch, token: (u) => o.token(u, a?.mailbox ?? null) }, userId, since, now);
      return { ...r, mails: r.mails.map((m) => (a?.mailbox ? { ...m, mailbox: a.mailbox } : m)), mailboxes: a && r.status === "ok" ? [a.mailbox] : [] } as any;
    }
    const mails: any[] = [], read: string[] = [];
    let through: number | null = now, listed = 0, wired = false, err: ReadResult | null = null;
    for (const a of accounts) {
      const r = await readMailSince({ fetch: o.fetch, token: (u) => o.token(u, a.mailbox) }, userId, since, now);
      if (r.status === "NOT_WIRED") continue;
      wired = true;
      mails.push(...r.mails.map((m) => ({ ...m, mailbox: a.mailbox })));
      listed += r.listed;
      if (r.status === "ok") read.push(a.mailbox);
      else err = r;
      through = r.readThrough === null ? null : through === null ? null : Math.min(through, r.readThrough);
    }
    mails.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    if (!wired) return { status: "NOT_WIRED", reason: "no Google account that may read mail", mails: [], readThrough: null, listed: 0 };
    if (err) return { ...err, mails, readThrough: through, listed, mailboxes: read } as any;
    return { status: "ok", mails, readThrough: through ?? now, listed, mailboxes: read };
  };
}

// One account alone. The first grant goes through the existing disconnect (google_disconnect.ts disconnectGoogle) by the caller;
// this removes an added account: revoked at Google, its row deleted (its token and the events read from it go with the row,
// 20261111120000), read back.
export interface AccountDisconnect { ok: boolean; found: boolean; mailbox: string; revoke: RevokeOutcome | null; failures: string[] }
export async function disconnectGoogleAccount(admin: any, userId: string, mailbox: string, d: RevokeDeps): Promise<AccountDisconnect> {
  const m = addr(mailbox), failures: string[] = [];
  const row = await admin.from("career_google_accounts").select("mailbox").eq("user_id", userId).eq("mailbox", m).maybeSingle();
  if (row.error) return { ok: false, found: false, mailbox: m, revoke: null, failures: ["read which Google accounts are connected"] };
  if (!row.data) return { ok: true, found: false, mailbox: m, revoke: null, failures };
  const v = await admin.rpc("career_google_account_vault_read", { p_user: userId, p_mailbox: m });
  const revoke = v.error ? "not_confirmed" as RevokeOutcome : await revokeAtGoogle(d, typeof v.data === "string" ? v.data : null);
  const del = await admin.from("career_google_accounts").delete().eq("user_id", userId).eq("mailbox", m);
  if (del.error) failures.push("delete the Google connection");
  const left = await admin.from("career_google_accounts").select("mailbox").eq("user_id", userId).eq("mailbox", m).maybeSingle();
  if (left.error || left.data) failures.push("delete the Google connection");
  const tok = await admin.rpc("career_google_account_vault_read", { p_user: userId, p_mailbox: m });
  if (!tok.error && tok.data) failures.push("delete the stored Google tokens");
  return { ok: failures.length === 0, found: true, mailbox: m, revoke, failures: [...new Set(failures)] };
}
// Every added account (the "disconnect gmail" of all of them, with the first grant).
export async function disconnectAddedAccounts(admin: any, userId: string, d: RevokeDeps): Promise<{ ok: boolean; removed: string[]; failures: string[] }> {
  let rows: any;
  try { rows = await admin.from("career_google_accounts").select("mailbox").eq("user_id", userId); } catch (e) { if (addedTableAbsent(e)) return { ok: true, removed: [], failures: [] }; throw e; }
  if (rows.error) return addedTableAbsent(rows.error) ? { ok: true, removed: [], failures: [] } : { ok: false, removed: [], failures: ["read which Google accounts are connected"] };
  const removed: string[] = [], failures: string[] = [];
  for (const r of rows.data ?? []) {
    const x = await disconnectGoogleAccount(admin, userId, r.mailbox, d);
    if (x.found) removed.push(x.mailbox);
    failures.push(...x.failures);
  }
  return { ok: failures.length === 0, removed, failures: [...new Set(failures)] };
}

// The connect's commit for a career Google grant: an address other than the first grant's is ADDED. 'primary': the caller stores
// it as the first grant (oauth_connect_commit), as before. A project without the function: 'primary' (the old behaviour).
export async function commitAddedAccount(admin: any, g: { userId: string; secret: string; email: string | null; scopes: string; now: number }): Promise<"primary" | "added" | "taken" | "limit" | "gone" | "invalid"> {
  if (!g.email) return "primary";
  let r: any;
  try { r = await admin.rpc("career_google_account_commit", { p_user: g.userId, p_secret: g.secret, p_email: g.email, p_scopes: g.scopes, p_now: new Date(g.now).toISOString() }); }
  catch (e) { if (/career_google_account_commit|PGRST202|unknown|not (?:found|faked|stubbed)/i.test(String((e as any)?.message ?? e))) return "primary"; throw e; }
  if (r?.error) { if (/career_google_account_commit|PGRST202/.test(`${r.error.code ?? ""} ${r.error.message ?? ""}`)) return "primary"; throw new Error("record the connection"); }
  // A double that answers every function with nothing (an older store): the first grant's path, as before.
  return ["primary", "added", "taken", "limit", "gone", "invalid"].includes(r?.data) ? r.data : r?.data == null ? "primary" : "invalid";
}
