// WO-024: read the person's new mail through the career Google grant (gmail.readonly, vault oauth_google_career_<uid>).
// Only what classification needs is asked for: From, Subject, Date and Gmail's snippet (format=metadata), never a body.
// What leaves this file is that metadata with a hash of the message id; the raw id is used to fetch and then dropped.
// No grant, no refresh token or no OAuth client: NOT_WIRED, and nothing is read. A rate limit stops the read where it is,
// and the cursor moves only past what was read, so the next run picks up the rest.
import type { MailIn } from "./career_mail.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const CAREER_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
// WO-032: the same career grant carries gmail.send (gmail-oauth start_career); it is used only to send an application the
// person approved word for word (career_apply_email.ts), never anything else.
export const CAREER_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export type ReadResult =
  | { status: "ok"; mails: MailIn[]; readThrough: number; listed: number }
  | { status: "NOT_WIRED"; reason: string; mails: MailIn[]; readThrough: null; listed: 0 }
  | { status: "RATE_LIMITED"; mails: MailIn[]; readThrough: number | null; listed: number; retryAfterMs: number }
  | { status: "ERROR"; detail: string; mails: MailIn[]; readThrough: number | null; listed: number };

export interface GmailDeps {
  fetch: typeof fetch;
  // An access token for the person's career grant, or null when there is none to use (never connected, revoked).
  token: (userId: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
}

export async function messageHash(userId: string, messageId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`gmail:${userId}:${messageId}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gmail's quota answers: 429, or 403 with a rate-limit reason. Anything else is not a rate limit.
async function limited(r: Response): Promise<number | null> {
  if (r.status !== 429 && r.status !== 403) return null;
  const body = await r.clone().json().catch(() => ({}));
  const reasons = ((body as any)?.error?.errors ?? []).map((e: any) => String(e?.reason ?? ""));
  if (r.status === 403 && !reasons.some((x: string) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(x))) return null;
  const after = Number(r.headers.get("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60000) : 2000;
}

// One GET with one polite retry on a rate limit; a second limit is returned to the caller to stop on.
async function get(d: GmailDeps, url: string, token: string): Promise<{ r: Response } | { limited: number }> {
  for (let attempt = 0; ; attempt++) {
    const r = await d.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const wait = await limited(r);
    if (wait === null) return { r };
    if (attempt >= 1) return { limited: wait };
    await (d.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))))(Math.min(wait, 8000));
  }
}

// Gmail's snippet is HTML-escaped text ("we won&#39;t be moving forward"), and HTML-only mail often opens with invisible
// preheader padding (U+034F, U+200B-U+200D, U+FEFF, U+00AD). The classifier reads words, so the snippet is read as the words
// it shows: the escapes decoded once (&amp;#39; stays the text "&#39;"), the padding dropped, spaces collapsed.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…" };
export function plainSnippet(s: unknown): string {
  return String(s ?? "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
      if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? all;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
    })
    .replace(/[͏­​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

const header = (msg: any, name: string) =>
  String((msg?.payload?.headers ?? []).find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");

// Mail that arrived after sinceMs, oldest first, at most maxMessages of it. Sent mail, drafts and chats are left out.
export async function readMailSince(
  d: GmailDeps, userId: string, sinceMs: number, nowMs: number, o: { maxMessages?: number; maxList?: number } = {},
): Promise<ReadResult> {
  const maxMessages = o.maxMessages ?? 100, maxList = o.maxList ?? 500;
  const token = await d.token(userId);
  if (!token) return { status: "NOT_WIRED", reason: "no career Google grant to read mail with", mails: [], readThrough: null, listed: 0 };
  const q = `after:${Math.floor(sinceMs / 1000)} -in:sent -in:drafts -in:chats`;
  const ids: string[] = [];
  let page = "";
  do {
    const got = await get(d, `${API}?q=${encodeURIComponent(q)}&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, token);
    if ("limited" in got) return { status: "RATE_LIMITED", mails: [], readThrough: null, listed: 0, retryAfterMs: got.limited };
    if (!got.r.ok) return { status: "ERROR", detail: `list messages: HTTP ${got.r.status}`, mails: [], readThrough: null, listed: 0 };
    const body = await got.r.json().catch(() => ({}));
    for (const m of body?.messages ?? []) if (m?.id) ids.push(String(m.id));
    page = String(body?.nextPageToken ?? "");
  } while (page && ids.length < maxList);
  // Gmail lists newest first; reading oldest first lets the cursor stop at the last message actually read.
  const todo = ids.slice(0, maxList).reverse();
  const mails: MailIn[] = [];
  let through: number | null = null;
  for (const id of todo.slice(0, maxMessages)) {
    const url = `${API}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Authentication-Results&fields=id,internalDate,snippet,payload/headers`;
    const got = await get(d, url, token);
    if ("limited" in got) return { status: "RATE_LIMITED", mails, readThrough: through, listed: ids.length, retryAfterMs: got.limited };
    if (got.r.status === 404) continue; // deleted since it was listed
    if (!got.r.ok) return { status: "ERROR", detail: `read a message: HTTP ${got.r.status}`, mails, readThrough: through, listed: ids.length };
    const msg = await got.r.json().catch(() => null);
    const at = Number(msg?.internalDate) || Date.parse(header(msg, "Date")) || nowMs;
    // Every Authentication-Results header, in order: only the first (Gmail's own) is ever trusted (career_mail.ts).
    const auth = (msg?.payload?.headers ?? []).filter((h: any) => String(h?.name ?? "").toLowerCase() === "authentication-results").map((h: any) => String(h?.value ?? "")).slice(0, 5);
    mails.push({ hash: await messageHash(userId, id), from: header(msg, "From"), subject: header(msg, "Subject"), snippet: plainSnippet(msg?.snippet), date: new Date(at).toISOString(), auth });
    through = Math.max(through ?? 0, at);
  }
  const all = todo.length <= maxMessages;
  return { status: "ok", mails, readThrough: all ? nowMs : (through ?? sinceMs), listed: ids.length };
}

// ------------------------------------------------------------------------------------------------ the token
// The career grant's access token, refreshed when it is about to expire and written back to the vault. Returns null (so
// the read is NOT_WIRED) when the person has no career grant, it lacks the scope asked for (gmail.readonly unless the
// caller asks for gmail.send), there is no refresh token, the OAuth client is not configured, or Google says the grant was
// revoked.
export interface TokenDeps {
  connection: (userId: string) => Promise<{ vault_name: string; scopes?: string | string[] | null } | null>;
  readVault: (name: string) => Promise<string | null>;
  // false: the connection went while the token was refreshed (oauth_vault_refresh wrote nothing): the token is not used.
  writeVault: (name: string, secret: string) => Promise<void | boolean>;
  fetch: typeof fetch;
  env: { get(k: string): string | undefined };
  now: () => number;
}
export function careerToken(d: TokenDeps): (userId: string) => Promise<string | null> {
  return careerTokenFor(d, CAREER_READ_SCOPE);
}
// The same token for any scope the grant must carry (WO-033 sends with gmail.send through this reader).
export function careerTokenFor(d: TokenDeps, scope: string): (userId: string) => Promise<string | null> {
  return async (userId) => {
    const name = `oauth_google_career_${userId}`;
    const conn = await d.connection(userId);
    if (!conn || conn.vault_name !== name) return null;
    const scopes = Array.isArray(conn.scopes) ? conn.scopes : String(conn.scopes ?? "").split(/[\s,]+/);
    if (!scopes.includes(scope)) return null;
    const raw = await d.readVault(name);
    if (!raw) return null;
    let tok: any;
    try { tok = JSON.parse(raw); } catch { return null; }
    if (tok.access_token && d.now() < Number(tok.expires_at || 0) - 60000) return String(tok.access_token);
    const id = d.env.get("GOOGLE_OAUTH_CLIENT_ID"), secret = d.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    if (!tok.refresh_token || !id || !secret) return null;
    const r = await d.fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: String(tok.refresh_token), grant_type: "refresh_token" }),
    });
    const nt = await r.json().catch(() => ({}));
    if (!r.ok || !nt.access_token) {
      if (r.status === 400 || r.status === 401) return null; // invalid_grant: revoked; the person reconnects in the app
      throw new Error(`refresh the career grant: HTTP ${r.status}`);
    }
    const kept = await d.writeVault(name, JSON.stringify({ ...tok, access_token: nt.access_token, refresh_token: nt.refresh_token || tok.refresh_token, expires_at: d.now() + (Number(nt.expires_in) || 3600) * 1000 }));
    if (kept === false) return null; // disconnected (or the account deleted) while this refresh ran: nothing is read or sent with it
    return String(nt.access_token);
  };
}

// ------------------------------------------------------------------------------------------------ sending (WO-032)
// One message, to one recipient, from the person's own Gmail (users.messages.send): To and Subject only, never Cc or Bcc,
// the text and one attachment. The caller has the person's yes to exactly this payload; this only refuses what no
// approved payload may hold (a second address, a header break). No token: NOT_WIRED and nothing is sent. Gmail's own 4xx
// refusal means nothing went (REFUSED); a network failure or a 5xx may have sent it (UNKNOWN), and it is never retried.
export type SendResult =
  | { status: "sent"; idHash: string }
  | { status: "NOT_WIRED"; reason: string }
  | { status: "REFUSED"; detail: string }
  | { status: "UNKNOWN"; detail: string };
export interface OutMail { to: string; subject: string; body: string; attachment?: { filename: string; bytes: Uint8Array; mime?: string } | null }
export const ONE_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const b64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const lines76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n").replace(/\r\n$/, "");
const utf8 = (s: string) => new TextEncoder().encode(s);
const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(utf8(s))}?=`);
// The only attachment types an application carries: a PDF or a Word document. Anything else (or a value carrying a line
// break, which would start a MIME part of its own) is refused.
export const ATTACHMENT_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
export function mimeOf(m: OutMail, boundary = "trainee-application-boundary"): string {
  if (!ONE_ADDRESS.test(m.to)) throw new Error("one recipient only");
  if (m.attachment && !ATTACHMENT_TYPES.includes(m.attachment.mime ?? "application/pdf")) throw new Error("an attachment is a PDF or a Word document");
  if (/[\r\n]/.test(m.subject)) throw new Error("a header may not break a line");
  const name = String(m.attachment?.filename ?? "").replace(/["\\\r\n]/g, "").slice(0, 120) || "resume.pdf";
  const parts = [
    `To: ${m.to}`, `Subject: ${encodedWord(m.subject)}`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines76(b64(utf8(m.body))),
  ];
  if (m.attachment) {
    parts.push(`--${boundary}`, `Content-Type: ${m.attachment.mime ?? "application/pdf"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", lines76(b64(m.attachment.bytes)));
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}
export async function sendMail(d: { fetch: typeof fetch; token: (userId: string) => Promise<string | null> }, userId: string, m: OutMail): Promise<SendResult> {
  const raw = b64(utf8(mimeOf(m))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const token = await d.token(userId);
  if (!token) return { status: "NOT_WIRED", reason: "no career Google grant that may send" };
  let r: Response;
  try {
    r = await d.fetch(`${API}/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw }) });
  } catch (e) {
    return { status: "UNKNOWN", detail: `send: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.status >= 400 && r.status < 500) return { status: "REFUSED", detail: `send: HTTP ${r.status}` };
  if (!r.ok) return { status: "UNKNOWN", detail: `send: HTTP ${r.status}` };
  const body = await r.json().catch(() => ({}));
  return { status: "sent", idHash: await messageHash(userId, String((body as any)?.id ?? "")) };
}
