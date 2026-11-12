// WO-033 part 3: the send rail. One approved message at a time through Gmail's users.messages.send, with the career
// Google grant's token (provider google_career, vault oauth_google_career_<uid>, scopes from gmail-oauth/career.ts).
// No grant, no gmail.send scope, no refresh token or no OAuth client: NOT_WIRED, and nothing is sent.
// No blast mode: exactly one recipient, no Cc or Bcc header ever, no header the person did not see (only To, Subject,
// MIME-Version and Content-Type are written; Gmail adds From as the signed-in account). A header value with a line
// break is refused (header injection), never cleaned.
// Replies are read per thread (gmail.readonly, format=metadata), for "stop", bounces and answers: who, subject, snippet.
import type { Message, ReplyRead, SendResult } from "./career_outreach.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
// RFC 2047 for a subject that is not plain ASCII.
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
export const ONE_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$/;

// D-062 (answering an email): a reply is threaded to the email it answers, In-Reply-To and References set to that email's own
// Message-ID (one id, angle brackets, no spaces or line breaks; anything else is refused, never cleaned) and the Gmail thread id.
// from (D-062): which of the person's own Google accounts sends it (the caller's token picks it); absent, the first grant.
export interface Threading { inReplyTo: string; threadId: string | null; from?: string | null }
export const MESSAGE_ID = /^<[^<>\s@]{1,200}@[^<>\s@]{1,200}>$/;
export function buildRaw(m: Message, t?: Threading | null): string {
  if (!ONE_ADDRESS.test(m.to)) throw new Error("one recipient, one plain address: no lists, names or separators");
  if (/[\r\n]/.test(m.subject) || /[\r\n]/.test(m.to)) throw new Error("a header with a line break is refused");
  if (t && !MESSAGE_ID.test(t.inReplyTo)) throw new Error("the email being answered has no usable Message-ID");
  const head = [`To: ${m.to}`, `Subject: ${encodeWord(m.subject)}`, ...(t ? [`In-Reply-To: ${t.inReplyTo}`, `References: ${t.inReplyTo}`] : []), "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit"];
  return b64url(`${head.join("\r\n")}\r\n\r\n${m.text.replace(/\r?\n/g, "\r\n")}`);
}

export interface GmailDeps { fetch: typeof fetch; token: (userId: string, scope: string) => Promise<string | null> }

export function gmailSender(d: GmailDeps) {
  return {
    async send(userId: string, m: Message, t?: Threading | null): Promise<SendResult> {
      let raw: string;
      try { raw = buildRaw(m, t); } catch (e) { return { status: "ERROR", detail: e instanceof Error ? e.message : String(e) }; }
      const token = await d.token(userId, GMAIL_SEND_SCOPE);
      if (!token) return { status: "NOT_WIRED", reason: "no career Google grant with gmail.send" };
      const thread = t?.threadId && /^[A-Za-z0-9_-]{1,64}$/.test(t.threadId) ? { threadId: t.threadId } : {};
      const r = await d.fetch(`${API}/messages/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw, ...thread }) });
      if (r.status === 429 || r.status === 403 && /rateLimit|quota/i.test(await r.clone().text())) return { status: "RATE_LIMITED", detail: `HTTP ${r.status}` };
      if (!r.ok) return { status: "ERROR", detail: `send: HTTP ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      return j?.id ? { status: "sent", id: String(j.id), thread_id: String(j.threadId ?? "") } : { status: "ERROR", detail: "send: no message id" };
    },
  };
}

const header = (msg: any, name: string) => String((msg?.payload?.headers ?? []).find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");
// The messages on a thread Trainee started, except the person's own (Gmail labels them SENT).
export function gmailThreadReader(d: GmailDeps) {
  return async (userId: string, threadId: string): Promise<ReplyRead> => {
    const token = await d.token(userId, GMAIL_READ_SCOPE);
    if (!token) return { status: "NOT_WIRED" };
    const r = await d.fetch(`${API}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { status: "ERROR", detail: `read a thread: HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    const messages = (Array.isArray(j?.messages) ? j.messages : []).filter((m: any) => !(m?.labelIds ?? []).includes("SENT"))
      .map((m: any) => ({ from: header(m, "From"), subject: header(m, "Subject"), snippet: String(m?.snippet ?? ""), at: new Date(Number(m?.internalDate) || Date.now()).toISOString() }));
    return { status: "ok", messages };
  };
}

// ------------------------------------------------------------------------------------------------ the token
// WO-024's reader of the career grant (career_mail_gmail.ts careerTokenFor), asked for the scope each rail needs: null
// (NOT_WIRED) when there is no career grant, it lacks the scope, there is no refresh token, the OAuth client is not
// configured, or Google says the grant was revoked.
export { careerTokenFor, type TokenDeps } from "./career_mail_gmail.ts";
