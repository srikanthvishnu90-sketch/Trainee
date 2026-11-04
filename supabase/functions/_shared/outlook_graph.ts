// M4 (2026-10-27): Outlook through Microsoft Graph, a peer of the Gmail rail. No I/O of its own: every call goes through the
// injected fetch, every store through injected functions, so tests fake Microsoft at the HTTP boundary.
//
// Microsoft identity platform (authorization code + PKCE, https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow):
//   authorize  https://login.microsoftonline.com/common/oauth2/v2.0/authorize  (common: work, school and personal accounts)
//   token      https://login.microsoftonline.com/common/oauth2/v2.0/token      (authorization_code with code_verifier; refresh_token)
//   offline_access is what returns a refresh token; a refresh may return a NEW refresh token, which replaces the old one.
//   There is no per-app token revocation endpoint (Microsoft Q&A 993951): a disconnect deletes the tokens here and tells the
//   person where to remove the app (account.live.com/consent/Manage, myapps.microsoft.com).
// Graph (https://graph.microsoft.com/v1.0):
//   POST /me/sendMail                                  Mail.Send; 202 Accepted with no body (user-sendmail)
//   GET  /me/mailFolders/inbox/messages/delta          Mail.Read; @odata.nextLink pages, @odata.deltaLink for the next round
//   GET  /me/calendarView?startDateTime&endDateTime    Calendars.ReadWrite covers read; supported for personal accounts
//                                                      (calendar getSchedule is not, so free/busy is read from calendarView)
//   GET  /me/calendar                                  allowedOnlineMeetingProviders (teamsForBusiness on work accounts)
//   POST /me/events                                    Calendars.ReadWrite; isOnlineMeeting + onlineMeetingProvider -> joinUrl
//   429 Too Many Requests: wait Retry-After seconds, then retry; without it, back off exponentially (graph/throttling).
// No volume limit of Trainee's own (owner, 2026-10-27): the only waits are Microsoft's.
// deno-lint-ignore-file no-explicit-any

export const MS_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MS_AUTHORIZE = `${MS_AUTHORITY}/authorize`;
export const MS_TOKEN = `${MS_AUTHORITY}/token`;
export const GRAPH = "https://graph.microsoft.com/v1.0";
export const PROVIDER = "microsoft";
export const SCOPES = ["openid", "email", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite"];
export const ENV = { clientId: "MICROSOFT_OAUTH_CLIENT_ID", clientSecret: "MICROSOFT_OAUTH_CLIENT_SECRET", stateSecret: "OAUTH_STATE_SECRET" };
export const vaultNameOf = (userId: string) => `oauth_${PROVIDER}_${userId}`;
// Graph scopes come back as full URIs on some tenants ("https://graph.microsoft.com/Mail.Send"); compare on the last segment.
export const scopeName = (s: string) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
export const hasScope = (granted: string[] | string | null | undefined, want: string) =>
  (Array.isArray(granted) ? granted : String(granted ?? "").split(/[\s,]+/)).some((g) => scopeName(g) === want.toLowerCase());

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
export async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------------------------------ state + PKCE
// The state names one link (career_outlook_links.id) and expires with it; it is HMAC-signed, so nothing in a query string
// can name another person. The PKCE verifier is derived from the secret and the link (never stored, never in a URL).
const STATE_MS = 15 * 60 * 1000;
export async function issueState(linkId: string, secret: string, now: number): Promise<string> {
  const payload = `o1.${linkId}.${now + STATE_MS}`;
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}
export async function verifyState(state: string, secret: string, now: number): Promise<string | null> {
  const m = /^(o1\.([0-9a-f-]{36})\.(\d{10,16}))\.([A-Za-z0-9_-]{43})$/.exec(String(state ?? ""));
  if (!m || !secret || Number(m[3]) < now) return null;
  const want = b64url(await hmac(secret, m[1]));
  let diff = want.length ^ m[4].length;
  for (let i = 0; i < Math.min(want.length, m[4].length); i++) diff |= want.charCodeAt(i) ^ m[4].charCodeAt(i);
  return diff === 0 ? m[2] : null;
}
export async function pkceVerifier(linkId: string, secret: string): Promise<string> {
  return b64url(await hmac(secret, `pkce.${linkId}`)); // 43 characters of [A-Za-z0-9_-], within RFC 7636's 43..128
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string | null }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, response_type: "code", redirect_uri: o.redirectUri, response_mode: "query",
    scope: SCOPES.join(" "), state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  if (o.loginHint) q.set("login_hint", o.loginHint);
  return `${MS_AUTHORIZE}?${q}`;
}

// ------------------------------------------------------------------------------------------------ tokens
export interface Tokens { access_token: string; refresh_token: string | null; expires_at: number; email: string | null; scopes: string }
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const part = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const c = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
    const e = c.email ?? c.preferred_username ?? c.upn;
    return typeof e === "string" && /@/.test(e) ? e : null;
  } catch { return null; }
}
export async function exchangeCode(f: typeof fetch, o: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string; now: number }): Promise<Tokens> {
  const r = await f(MS_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    client_id: o.clientId, client_secret: o.clientSecret, grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri,
    code_verifier: o.verifier, scope: SCOPES.join(" ") }) });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || typeof t.access_token !== "string") throw new Error(`token exchange: HTTP ${r.status}${t?.error ? ` ${String(t.error).slice(0, 40)}` : ""}`);
  let email = emailFromIdToken(t.id_token);
  if (!email) {
    const me = await f(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${t.access_token}` } });
    const j: any = await me.json().catch(() => ({}));
    email = me.ok ? (j.mail ?? j.userPrincipalName ?? null) : null;
  }
  return { access_token: t.access_token, refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : null,
    expires_at: o.now + (Number(t.expires_in) || 3600) * 1000, email, scopes: typeof t.scope === "string" ? t.scope : SCOPES.join(" ") };
}

export type TokenResult = { status: "ok"; token: string } | { status: "NOT_WIRED"; reason: string } | { status: "NEEDS_RECONNECT"; reason: string }
  | { status: "RATE_LIMITED"; retryAfterMs: number } | { status: "ERROR"; detail: string };
export interface TokenDeps {
  fetch: typeof fetch;
  env: { get(k: string): string | undefined };
  now: () => number;
  connection: (userId: string) => Promise<{ vault_name: string; scopes?: string | null } | null>;
  readVault: (name: string) => Promise<string | null>;
  writeVault: (name: string, secret: string) => Promise<void>;
  // needs_reconnect: the grant was refused by Microsoft (invalid_grant, a 401); the person must connect again.
  markReconnect: (userId: string, reason: string) => Promise<void>;
  // Records the new expiry (career_outlook_state.token_expires_at), so the refresh batch knows when to come back.
  noteExpiry?: (userId: string, expiresAt: number) => Promise<void>;
  isReconnect?: (userId: string) => Promise<boolean>;
}
// The person's access token for a scope, refreshed when it is about to expire (the new refresh token replaces the old).
export async function outlookToken(d: TokenDeps, userId: string, scope: string, force = false): Promise<TokenResult> {
  const name = vaultNameOf(userId);
  const conn = await d.connection(userId);
  if (!conn || conn.vault_name !== name) return { status: "NOT_WIRED", reason: "Outlook is not connected" };
  if (!hasScope(conn.scopes, scope)) return { status: "NOT_WIRED", reason: `the Outlook connection does not allow ${scope}` };
  if (d.isReconnect && await d.isReconnect(userId)) return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access" };
  const raw = await d.readVault(name);
  let tok: any = null;
  try { tok = JSON.parse(String(raw ?? "")); } catch { tok = null; }
  if (!tok?.access_token) return { status: "NOT_WIRED", reason: "no stored Outlook access" };
  if (!force && d.now() < Number(tok.expires_at || 0) - 60_000) return { status: "ok", token: String(tok.access_token) };
  const id = d.env.get(ENV.clientId), secret = d.env.get(ENV.clientSecret);
  if (!id || !secret) return { status: "NOT_WIRED", reason: "the Microsoft app is not configured" };
  if (!tok.refresh_token) { await d.markReconnect(userId, "no refresh token"); return { status: "NEEDS_RECONNECT", reason: "no refresh token" }; }
  const r = await d.fetch(MS_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
    client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: String(tok.refresh_token), scope: SCOPES.join(" ") }) });
  const nt: any = await r.json().catch(() => ({}));
  if (r.status === 429) return { status: "RATE_LIMITED", retryAfterMs: retryAfterMs(r, 0) };
  if (!r.ok || typeof nt.access_token !== "string") {
    if (r.status === 400 || r.status === 401) {
      const why = String(nt.error ?? `HTTP ${r.status}`).slice(0, 60);
      await d.markReconnect(userId, why);
      return { status: "NEEDS_RECONNECT", reason: why };
    }
    return { status: "ERROR", detail: `refresh: HTTP ${r.status}` };
  }
  const expiresAt = d.now() + (Number(nt.expires_in) || 3600) * 1000;
  await d.writeVault(name, JSON.stringify({ ...tok, access_token: nt.access_token, refresh_token: nt.refresh_token || tok.refresh_token, expires_at: expiresAt }));
  await d.noteExpiry?.(userId, expiresAt);
  return { status: "ok", token: String(nt.access_token) };
}

// ------------------------------------------------------------------------------------------------ Graph calls, 429-aware
export function retryAfterMs(r: Response, attempt: number): number {
  const h = r.headers.get("retry-after");
  const s = Number(h);
  if (h !== null && Number.isFinite(s) && s >= 0) return s * 1000;
  const at = h ? Date.parse(h) : NaN;
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return 1000 * 2 ** Math.min(attempt, 6); // no Retry-After: exponential backoff (graph/throttling)
}
export interface CallDeps { fetch: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }
// One Graph request. A 429 (or a 503 with Retry-After) is waited out and retried for as long as the caller's run can wait
// (waitMs: the time left in this run, a runtime limit, not a volume one); past that the caller gets RATE_LIMITED with
// Microsoft's own wait, records it, and resumes then. Never a tight loop: every retry waits what Microsoft asked.
export async function graphCall(d: CallDeps, url: string, init: RequestInit, waitMs: number):
  Promise<{ r: Response } | { limited: number }> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const r = await d.fetch(url, init);
    if (r.status !== 429 && !(r.status === 503 && r.headers.has("retry-after"))) return { r };
    const wait = retryAfterMs(r, attempt);
    await r.body?.cancel().catch(() => {});
    if (waited + wait > waitMs) return { limited: wait };
    await sleep(wait);
    waited += wait;
  }
}

// ------------------------------------------------------------------------------------------------ sending
// One message to one recipient from the person's own Outlook: To and Subject from the approved payload, plain text, and
// for an application at most one PDF or Word attachment. Never Cc, Bcc, Reply-To or any header the person did not see,
// except one x-trainee-send header carrying the idempotency key's hash (Graph accepts only x- custom headers). A value
// with a line break, a second address, a display name or a separator is refused, never cleaned.
export interface OutMail {
  to: string; subject: string; text: string;
  attachment?: { filename: string; bytes: Uint8Array; mime?: string } | null;
}
export const ONE_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$/;
// CR, LF, NUL and the Unicode line and paragraph separators (U+2028, U+2029).
export const HEADER_BREAK = new RegExp("[\\r\\n\\u0000\\u2028\\u2029]");
export const ATTACHMENT_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
export function graphMessage(m: OutMail, sendIdHash: string): Record<string, unknown> {
  if (typeof m.to !== "string" || !ONE_ADDRESS.test(m.to)) throw new Error("one recipient, one plain address: no lists, names or separators");
  if (typeof m.subject !== "string" || HEADER_BREAK.test(m.subject)) throw new Error("a header with a line break is refused");
  if (!m.subject.trim() || m.subject.length > 255) throw new Error("a subject is 1 to 255 characters");
  if (typeof m.text !== "string" || !m.text.trim()) throw new Error("an empty message is refused");
  const msg: Record<string, unknown> = {
    subject: m.subject,
    body: { contentType: "Text", content: m.text },
    toRecipients: [{ emailAddress: { address: m.to } }],
    internetMessageHeaders: [{ name: "x-trainee-send", value: sendIdHash.slice(0, 32) }],
  };
  if (m.attachment) {
    const mime = m.attachment.mime ?? "application/pdf";
    if (!ATTACHMENT_TYPES.includes(mime)) throw new Error("an attachment is a PDF or a Word document");
    const name = String(m.attachment.filename ?? "").replace(/["\\\r\n/]/g, "").slice(0, 120) || "resume.pdf";
    msg.attachments = [{ "@odata.type": "#microsoft.graph.fileAttachment", name, contentType: mime, contentBytes: b64(m.attachment.bytes) }];
  }
  return msg;
}
export const payloadHashOf = (m: OutMail) =>
  sha256Hex(JSON.stringify([m.to.trim().toLowerCase(), m.subject, m.text, m.attachment ? [m.attachment.filename, m.attachment.mime ?? "application/pdf", m.attachment.bytes.length] : null]));

export type SendStatus =
  | { status: "sent"; provider: "outlook"; id: string | null; thread_id: string | null }
  | { status: "already_sent"; provider: "outlook" }
  | { status: "NOT_WIRED"; reason: string }
  | { status: "NEEDS_RECONNECT"; reason: string }
  | { status: "REFUSED"; detail: string }
  | { status: "CHANGED"; detail: string }
  | { status: "CANCELLED"; detail: string }
  | { status: "OPTED_OUT" }
  | { status: "BOUNCED" }
  | { status: "RATE_LIMITED"; retryAfterMs: number }
  | { status: "UNKNOWN"; detail: string };
export interface SendLedger {
  begin(userId: string, key: string, hash: string, purpose: string, recipientHash: string, now: number): Promise<string>;
  finish(userId: string, key: string, status: "sent" | "refused" | "unknown" | "rate_limited", detail: string | null, now: number): Promise<void>;
}
export interface SendDeps extends CallDeps {
  token: (userId: string, scope: string) => Promise<TokenResult>; ledger: SendLedger; waitMs?: number;
  markReconnect?: (userId: string, reason: string) => Promise<void>;
}
export type Purpose = "outreach" | "application" | "followup" | "general";
// Exactly once per (person, idemKey): the ledger says go before Microsoft is called; a 202 is sent; a 4xx is Microsoft's
// refusal (nothing went); a 401 marks needs_reconnect; a network failure or a 5xx may have sent it, so it is UNKNOWN and
// never retried. A 429 is waited out (Retry-After) within waitMs, else RATE_LIMITED and the key may go again later.
export async function sendOutlook(d: SendDeps, userId: string, m: OutMail, o: { idemKey: string; purpose: Purpose }): Promise<SendStatus> {
  const now = (d.now ?? Date.now)();
  const keyHash = await sha256Hex(`outlook:${userId}:${o.idemKey}`);
  let message: Record<string, unknown>;
  try { message = graphMessage(m, keyHash); } catch (e) { return { status: "REFUSED", detail: (e as Error).message }; }
  const tok = await d.token(userId, "Mail.Send");
  if (tok.status === "NOT_WIRED" || tok.status === "NEEDS_RECONNECT") return tok;
  if (tok.status === "RATE_LIMITED") return tok;
  if (tok.status !== "ok") return { status: "UNKNOWN", detail: tok.detail }; // nothing was sent; the ledger was not touched
  const hash = await payloadHashOf(m);
  const go = await d.ledger.begin(userId, o.idemKey, hash, o.purpose, await sha256Hex(m.to.trim().toLowerCase()), now);
  if (go === "sent") return { status: "already_sent", provider: "outlook" };
  if (go === "changed") return { status: "CHANGED", detail: "the message changed after it was approved" };
  if (go === "cancelled") return { status: "CANCELLED", detail: "Outlook was disconnected before it went" };
  if (go === "opted_out") return { status: "OPTED_OUT" };
  if (go === "bounced") return { status: "BOUNCED" };
  if (go === "not_connected") return { status: "NOT_WIRED", reason: "Outlook is not connected" };
  if (go === "needs_reconnect") return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access" };
  if (go !== "go") return { status: "UNKNOWN", detail: `a send under this key may already have gone (${go})` };
  let res: { r: Response } | { limited: number };
  try {
    res = await graphCall(d, `${GRAPH}/me/sendMail`, { method: "POST", headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }) }, d.waitMs ?? 30_000);
  } catch (e) {
    await d.ledger.finish(userId, o.idemKey, "unknown", `network: ${(e as Error).message}`.slice(0, 200), now);
    return { status: "UNKNOWN", detail: "the connection to Microsoft broke while sending; it may have gone, so it is not sent again" };
  }
  if ("limited" in res) {
    await d.ledger.finish(userId, o.idemKey, "rate_limited", `retry after ${res.limited} ms`, now);
    return { status: "RATE_LIMITED", retryAfterMs: res.limited };
  }
  const r = res.r;
  await r.body?.cancel().catch(() => {});
  if (r.status === 202 || r.status === 200) {
    await d.ledger.finish(userId, o.idemKey, "sent", null, now);
    return { status: "sent", provider: "outlook", id: null, thread_id: null };
  }
  if (r.status === 401) {
    await d.ledger.finish(userId, o.idemKey, "refused", "HTTP 401", now);
    await d.markReconnect?.(userId, "HTTP 401 on send");
    return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access (401)" };
  }
  if (r.status >= 400 && r.status < 500) {
    await d.ledger.finish(userId, o.idemKey, "refused", `HTTP ${r.status}`, now);
    return { status: "REFUSED", detail: `send: HTTP ${r.status}` };
  }
  await d.ledger.finish(userId, o.idemKey, "unknown", `HTTP ${r.status}`, now);
  return { status: "UNKNOWN", detail: `send: HTTP ${r.status}; it may have gone, so it is not sent again` };
}

// ------------------------------------------------------------------------------------------------ inbox delta (reply tracking)
// MailIn is career_mail.ts's shape (hash, from, subject, snippet, date, auth), so the existing classifier reads Outlook mail
// unchanged; Graph gives no Authentication-Results, so auth is empty and the classifier's trust rules treat it as unverified.
export interface OutlookMail { hash: string; conversationHash: string | null; fromAddress: string; from: string; subject: string; snippet: string; date: string; auth: string[] }
export type DeltaResult =
  | { status: "ok"; mails: OutlookMail[]; deltaLink: string; removed: number }
  | { status: "NOT_WIRED"; reason: string } | { status: "NEEDS_RECONNECT"; reason: string }
  | { status: "RATE_LIMITED"; retryAfterMs: number; mails: OutlookMail[]; resumeLink: string | null }
  | { status: "ERROR"; detail: string; mails: OutlookMail[] };
const DELTA_SELECT = "from,subject,bodyPreview,receivedDateTime,conversationId,internetMessageId";
export function firstDeltaUrl(sinceIso: string): string {
  return `${GRAPH}/me/mailFolders/inbox/messages/delta?$select=${DELTA_SELECT}&$filter=receivedDateTime+ge+${encodeURIComponent(sinceIso)}`;
}
// One round: the stored delta link (or the first URL), then every nextLink, to the new deltaLink. The links are Graph's own
// and are only ever followed when they are on graph.microsoft.com. A 410 (sync state gone) restarts from sinceIso.
export async function readInboxDelta(d: CallDeps & { token: (u: string, s: string) => Promise<TokenResult>; waitMs?: number },
  userId: string, o: { deltaLink: string | null; sinceIso: string }): Promise<DeltaResult> {
  const tok = await d.token(userId, "Mail.Read");
  if (tok.status === "NOT_WIRED" || tok.status === "NEEDS_RECONNECT") return tok;
  if (tok.status === "RATE_LIMITED") return { ...tok, mails: [], resumeLink: o.deltaLink };
  if (tok.status !== "ok") return { status: "ERROR", detail: tok.detail, mails: [] };
  const mails: OutlookMail[] = [];
  let removed = 0, url = o.deltaLink && /^https:\/\/graph\.microsoft\.com\//.test(o.deltaLink) ? o.deltaLink : firstDeltaUrl(o.sinceIso), restarted = false;
  for (;;) {
    const res = await graphCall(d, url, { headers: { authorization: `Bearer ${tok.token}`, prefer: 'odata.maxpagesize=50, outlook.body-content-type="text"' } }, d.waitMs ?? 30_000);
    if ("limited" in res) return { status: "RATE_LIMITED", retryAfterMs: res.limited, mails, resumeLink: url };
    const r = res.r;
    if (r.status === 401) return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access (401)" };
    if (r.status === 410 && !restarted) { restarted = true; url = firstDeltaUrl(o.sinceIso); await r.body?.cancel().catch(() => {}); continue; }
    if (!r.ok) return { status: "ERROR", detail: `delta: HTTP ${r.status}`, mails };
    const j: any = await r.json().catch(() => ({}));
    for (const m of Array.isArray(j.value) ? j.value : []) {
      if (m?.["@removed"]) { removed++; continue; }
      if (!m?.id) continue;
      const addr = String(m?.from?.emailAddress?.address ?? "").trim().toLowerCase();
      const name = String(m?.from?.emailAddress?.name ?? "").replace(/[\r\n]/g, " ").trim();
      mails.push({
        hash: await sha256Hex(`outlook:${userId}:${m.id}`),
        conversationHash: m.conversationId ? await sha256Hex(`outlook-conv:${userId}:${m.conversationId}`) : null,
        fromAddress: addr, from: name ? `${name} <${addr}>` : addr,
        subject: String(m.subject ?? "").slice(0, 500), snippet: String(m.bodyPreview ?? "").slice(0, 500),
        date: new Date(Date.parse(m.receivedDateTime) || Date.now()).toISOString(), auth: [],
      });
    }
    const next = j["@odata.nextLink"], delta = j["@odata.deltaLink"];
    if (typeof next === "string" && /^https:\/\/graph\.microsoft\.com\//.test(next)) { url = next; continue; }
    if (typeof delta === "string" && /^https:\/\/graph\.microsoft\.com\//.test(delta)) return { status: "ok", mails, deltaLink: delta, removed };
    return { status: "ERROR", detail: "delta: no next or delta link", mails };
  }
}

// ------------------------------------------------------------------------------------------------ calendar (for M5)
export interface Window { start: string; end: string; timeZone?: string }
export interface Busy { start: string; end: string; status: "busy" | "tentative" | "oof" }
export type FreeBusy = { status: "ok"; busy: Busy[]; source: "calendarView" } | { status: "NOT_WIRED"; reason: string } | { status: "NEEDS_RECONNECT"; reason: string }
  | { status: "RATE_LIMITED"; retryAfterMs: number } | { status: "ERROR"; detail: string };
const BUSY: Record<string, Busy["status"]> = { busy: "busy", tentative: "tentative", oof: "oof" }; // free and workingElsewhere are free
const iso = (s: string) => { const t = Date.parse(s); if (!Number.isFinite(t)) throw new Error("a window is two ISO 8601 times"); return new Date(t).toISOString(); };
export async function freeBusy(d: CallDeps & { token: (u: string, s: string) => Promise<TokenResult>; waitMs?: number }, userId: string, w: Window): Promise<FreeBusy> {
  let start: string, end: string;
  try { start = iso(w.start); end = iso(w.end); } catch (e) { return { status: "ERROR", detail: (e as Error).message }; }
  if (Date.parse(end) <= Date.parse(start)) return { status: "ERROR", detail: "the window ends before it starts" };
  const tok = await d.token(userId, "Calendars.ReadWrite");
  if (tok.status !== "ok") return tok;
  const busy: Busy[] = [];
  let url = `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=showAs,start,end,isCancelled&$top=100`;
  for (;;) {
    const res = await graphCall(d, url, { headers: { authorization: `Bearer ${tok.token}`, prefer: 'outlook.timezone="UTC"' } }, d.waitMs ?? 30_000);
    if ("limited" in res) return { status: "RATE_LIMITED", retryAfterMs: res.limited };
    if (res.r.status === 401) return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access (401)" };
    if (!res.r.ok) return { status: "ERROR", detail: `calendarView: HTTP ${res.r.status}` };
    const j: any = await res.r.json().catch(() => ({}));
    for (const e of Array.isArray(j.value) ? j.value : []) {
      const kind = BUSY[String(e?.showAs ?? "")];
      if (!kind || e?.isCancelled) continue;
      const s = Date.parse(`${String(e?.start?.dateTime ?? "").replace(/Z?$/, "")}Z`), t = Date.parse(`${String(e?.end?.dateTime ?? "").replace(/Z?$/, "")}Z`);
      if (Number.isFinite(s) && Number.isFinite(t)) busy.push({ start: new Date(s).toISOString(), end: new Date(t).toISOString(), status: kind });
    }
    const next = j["@odata.nextLink"];
    if (typeof next === "string" && /^https:\/\/graph\.microsoft\.com\//.test(next)) { url = next; continue; }
    busy.sort((a, b) => a.start.localeCompare(b.start));
    return { status: "ok", busy, source: "calendarView" };
  }
}

export interface NewEvent {
  subject: string; start: string; end: string; timeZone?: string;
  attendees: string[]; body?: string; online?: boolean; idemKey: string;
}
export type Created = { status: "created"; id: string; joinUrl: string | null; teams: boolean; note: string | null }
  | { status: "NOT_WIRED"; reason: string } | { status: "NEEDS_RECONNECT"; reason: string } | { status: "REFUSED"; detail: string }
  | { status: "RATE_LIMITED"; retryAfterMs: number } | { status: "UNKNOWN"; detail: string };
export const eventHashOf = (e: NewEvent) => sha256Hex(JSON.stringify([e.subject, iso(e.start), iso(e.end), [...e.attendees].map((a) => a.toLowerCase()).sort(), e.body ?? "", !!e.online]));
// transactionId: a GUID from the idempotency key, so a retried POST of the same event is the same event to Exchange.
export async function transactionIdOf(userId: string, idemKey: string): Promise<string> {
  const h = await sha256Hex(`outlook-event:${userId}:${idemKey}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// Creating an invite is an external effect: the caller passes the hash of the exact event the person approved, and an event
// that differs from it in any field is refused. A Teams link is added only when the calendar allows teamsForBusiness;
// otherwise the event is made without one and the note says so (personal accounts usually have no Teams for business).
export async function createEvent(d: CallDeps & { token: (u: string, s: string) => Promise<TokenResult>; waitMs?: number }, userId: string, e: NewEvent, approvedHash: string): Promise<Created> {
  let start: string, end: string;
  try { start = iso(e.start); end = iso(e.end); } catch (x) { return { status: "REFUSED", detail: (x as Error).message }; }
  if (/[\r\n]/.test(e.subject) || !e.subject.trim()) return { status: "REFUSED", detail: "a subject is one line" };
  if (!e.attendees.length || e.attendees.some((a) => !ONE_ADDRESS.test(a))) return { status: "REFUSED", detail: "every attendee is one plain address" };
  if (await eventHashOf(e) !== approvedHash) return { status: "REFUSED", detail: "the event differs from the one approved" };
  const tok = await d.token(userId, "Calendars.ReadWrite");
  if (tok.status === "ERROR") return { status: "UNKNOWN", detail: tok.detail };
  if (tok.status !== "ok") return tok;
  const auth = { authorization: `Bearer ${tok.token}` };
  let teams = false, note: string | null = null;
  if (e.online) {
    const cal = await graphCall(d, `${GRAPH}/me/calendar?$select=allowedOnlineMeetingProviders`, { headers: auth }, d.waitMs ?? 30_000);
    if ("limited" in cal) return { status: "RATE_LIMITED", retryAfterMs: cal.limited };
    const j: any = cal.r.ok ? await cal.r.json().catch(() => ({})) : {};
    teams = Array.isArray(j.allowedOnlineMeetingProviders) && j.allowedOnlineMeetingProviders.includes("teamsForBusiness");
    if (!teams) note = "This Outlook calendar can't add a Teams link, so the invite has no meeting link.";
  }
  const body = {
    subject: e.subject, start: { dateTime: start.replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: end.replace(/Z$/, ""), timeZone: "UTC" },
    attendees: e.attendees.map((a) => ({ emailAddress: { address: a }, type: "required" })),
    ...(e.body ? { body: { contentType: "Text", content: e.body } } : {}),
    ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
    transactionId: await transactionIdOf(userId, e.idemKey),
  };
  let res: { r: Response } | { limited: number };
  try {
    res = await graphCall(d, `${GRAPH}/me/events`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }, d.waitMs ?? 30_000);
  } catch (x) { return { status: "UNKNOWN", detail: `network: ${(x as Error).message}` }; }
  if ("limited" in res) return { status: "RATE_LIMITED", retryAfterMs: res.limited };
  if (res.r.status === 401) return { status: "NEEDS_RECONNECT", reason: "Microsoft refused the stored access (401)" };
  if (res.r.status >= 400 && res.r.status < 500) return { status: "REFUSED", detail: `events: HTTP ${res.r.status}` };
  if (!res.r.ok) return { status: "UNKNOWN", detail: `events: HTTP ${res.r.status}` };
  const j: any = await res.r.json().catch(() => ({}));
  return { status: "created", id: String(j.id ?? ""), joinUrl: typeof j?.onlineMeeting?.joinUrl === "string" ? j.onlineMeeting.joinUrl : null, teams, note };
}
