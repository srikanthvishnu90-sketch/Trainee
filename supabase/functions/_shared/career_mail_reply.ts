// D-062 (2) (owner, 2026-11-11: "be able to answer emails ... not gmail read, but gmail read and send"): the person asks Trainee
// to reply to an email in their own inbox. Three steps, each its own guard:
//   read    the person's connected Gmail (the career grant's gmail.readonly): a search of their inbox (sender, subject, date and
//           Gmail's snippet), and the plain text of the ONE email they chose to answer (capped). Nothing else is read.
//   card    the brain writes the reply's words (draft_email_reply); code checks them (followup_draft.ts checkFollowup: no invented
//           meeting, offer or relationship, no figure or name outside the person's words, their confirmed facts and the email being
//           answered) and builds the exact message: To is that email's own Reply-To or From address (never guessed; an automated
//           no-reply inbox gets no card), the subject "Re: <its subject>", the body and the person's signature. It is saved as a
//           row of its own kind (recipient.kind "mail_reply"; no outreach list, approval or scheduled run touches it) whose
//           SHA-256 over [sending account, to, cc, bcc, subject, text, In-Reply-To, thread] is the approval's only key (D-MN-2).
//   yes     while that card is the thread's last word (career_inbox_followups.ts followupTurn): a yes sends exactly that message
//           once, from the account the card names (gmail.send, CAREER_EMAIL_SEND and CAREER_SEND_RAIL on), threaded to the email
//           it answers; a changed message, an old card, a paused account or a do-not-contact address sends nothing. No yes, nothing.
//   proof   "sent" is said only with Gmail's message id. No answer, a timeout or a 5xx is an unknown outcome: the reply says it
//           is unconfirmed, the row stays claimed, and nothing is sent again until the Sent mailbox was searched for this exact
//           message (its own Message-ID, the same on every try) and it is not there.
// Trainee never sends from its own identity, never Cc or Bcc, never to more than one address.
// What is read for a model is guarded first (mail_security.ts): a security email's text is never returned.
import { automatedInbox } from "./automated_inbox.ts";
import { checkFollowup } from "./followup_draft.ts";
import { dayStartOf, isMailReply, type Message, messageOf, type OutreachDraft, type OutreachStore, sha256 } from "./career_outreach.ts";
import { codeInReply, mentionsRemoved, redact, securityMail, shownAddress, withheldTokens } from "./mail_security.ts";
import { MESSAGE_ID, ONE_ADDRESS, SEND_TIMEOUT_MS, type Threading } from "./career_outreach_gmail.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const MAIL_REPLY_CARD_INTENT = "career_mail_reply_card";
export const MAIL_REPLY_ANSWER_INTENT = "career_mail_reply_answer";
export const BODY_MAX = 3000;

// account (D-062): the person's Gmail address the email reached; ref is "<gmail id>~<account>" so a later read asks the same account.
// security: a one-time code, sign-in, password or account-security email: found, and its subject, snippet and text withheld.
// removed: what redaction took out of this mail, or every code-like token of a withheld one: for the turn's output guard only
// (agent/capability_tools.ts keeps it in memory and never passes it to the model; nothing stores it).
export interface InboxMail { ref: string; account: string | null; thread_id: string | null; from: string; from_name: string; reply_to: string | null; subject: string; date: string; snippet: string; message_id: string | null; security?: true; removed?: string[] }
// `removed` is not enumerable: read by property, never serialised (a log, a tool result or a spread copy never carries it).
const hide = <T extends object>(o: T, removed: string[]): T => Object.defineProperty(o, "removed", { value: removed, enumerable: false, writable: false });
const guarded = (mail: InboxMail, text: string): InboxMail => {
  if (securityMail({ from: mail.from, subject: mail.subject, text: `${mail.snippet}\n${text}` })) {
    return hide({ ...mail, from: shownAddress(mail.from), from_name: "", reply_to: null, subject: "", snippet: "", security: true as const }, withheldTokens(`${mail.subject}\n${mail.snippet}\n${text}`));
  }
  const n = redact(mail.from_name), sub = redact(mail.subject), snip = redact(mail.snippet);
  return hide({ ...mail, from_name: n.text, subject: sub.text, snippet: snip.text }, [...n.removed, ...sub.removed, ...snip.removed].map((r) => r.token));
};
export type InboxRead = { status: "ok"; mails: InboxMail[] } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };
// D-062: token for one account (null: the first grant); accounts: every Google account the person connected (absent: the first grant only).
export interface InboxDeps { fetch: typeof fetch; token: (userId: string, account: string | null) => Promise<string | null>; accounts?: (userId: string) => Promise<{ mailbox: string; can_read: boolean; can_send: boolean }[]> }
const refOf = (id: string, account: string | null) => (account ? `${id}~${account}` : id);
const parseRef = (ref: string): { id: string; account: string | null } | null => {
  const m = /^([A-Za-z0-9_-]{1,64})(?:~([a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}))?$/i.exec(String(ref ?? "").trim());
  return m ? { id: m[1], account: m[2] ? m[2].toLowerCase() : null } : null;
};

// Control, bidi and zero-width characters never reach a card, a header or a model from someone else's email.
// Zero-width and bidi marks are dropped (a word split by one stays one word); other control characters become spaces.
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const squash = (s: unknown) => String(s ?? "").replace(INVISIBLE, "").replace(CTRL, " ").replace(/\s+/g, " ").trim();
// RFC 2047 encoded words ("=?UTF-8?B?...?=") decoded for display, so what a card shows is what the header says.
const decodeWords = (v: string) => v.replace(/=\?([\w-]{1,40})\?([bq])\?([^?\s]*)\?=(?:\s+(?==\?))?/gi, (_all, cs: string, enc: string, data: string) => {
  try {
    const bin = enc.toLowerCase() === "b" ? atob(data) : data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return new TextDecoder(cs).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ""; }
});
// A display name is shown only when it reads as a name (letters, at most four words); anything else is shown as the address.
export const nameLike = (n: string) => n.length <= 40 && /^[\p{L}\p{M}][\p{L}\p{M}.'\u2019-]*(?: [\p{L}\p{M}][\p{L}\p{M}.'\u2019-]*){0,3}$/u.test(n);
const header = (msg: any, name: string) => String((msg?.payload?.headers ?? []).find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");
const addressIn = (v: string) => { const m = /<([^<>\s]+@[^<>\s]+)>/.exec(v) ?? /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(v); return m ? m[1].toLowerCase() : ""; };
const nameIn = (v: string) => squash(decodeWords(v).replace(/<[^>]*>/g, "").replace(/"/g, "")).slice(0, 80);
const decode = (s: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return ""; } };
// The text/plain part of a message (format=full), quoted history dropped, capped.
function wholePlain(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; if (/^text\/plain/i.test(String(p.mimeType ?? "")) && p.body?.data) parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  return parts.map((p) => decode(String(p.body.data))).join("\n");
}
export function plainText(payload: any): string {
  const text = wholePlain(payload);
  const cut = text.split(/\r?\n(?:On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|>)/)[0];
  return cut.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, BODY_MAX);
}
const mailOf = (m: any, account: string | null = null): InboxMail => {
  const from = header(m, "From"), rt = addressIn(header(m, "Reply-To"));
  const mid = squash(header(m, "Message-ID") || header(m, "Message-Id"));
  return { ref: refOf(String(m?.id ?? ""), account), account, thread_id: m?.threadId ? String(m.threadId) : null, from: addressIn(from), from_name: nameIn(from), reply_to: rt || null, subject: squash(decodeWords(header(m, "Subject"))).slice(0, 200),
    date: new Date(Number(m?.internalDate) || Date.parse(header(m, "Date")) || 0).toISOString(), snippet: squash(m?.snippet).slice(0, 300), message_id: MESSAGE_ID.test(mid) ? mid : null };
};

export function inboxReader(d: InboxDeps) {
  const get = async (url: string, token: string) => await d.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return {
    // The person's received mail that matches their words (Gmail's own search), in every account they connected, newest first.
    async search(userId: string, query: string, max = 5): Promise<InboxRead & { accounts?: string[] }> {
      const all = d.accounts ? (await d.accounts(userId)).filter((a) => a.can_read).map((a) => a.mailbox) : [];
      const accounts: (string | null)[] = all.length ? all : [null];
      const q = `${squash(query).slice(0, 200)} -in:sent -in:drafts -in:chats`.trim();
      const mails: InboxMail[] = [];
      let wired = false;
      for (const account of accounts) {
        const token = await d.token(userId, account);
        if (!token) continue;
        wired = true;
        const r = await get(`${API}?q=${encodeURIComponent(q)}&maxResults=${Math.max(1, Math.min(10, max))}`, token);
        if (!r.ok) return { status: "ERROR", detail: `search the inbox: HTTP ${r.status}` };
        const ids = ((await r.json().catch(() => ({})))?.messages ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean).slice(0, max);
        for (const id of ids) {
          const g = await get(`${API}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`, token);
          if (g.status === 404) continue;
          if (!g.ok) return { status: "ERROR", detail: `read a message: HTTP ${g.status}` };
          mails.push(guarded(mailOf(await g.json().catch(() => ({})), account), ""));
        }
      }
      if (!wired) return { status: "NOT_WIRED" };
      mails.sort((a, b) => b.date.localeCompare(a.date));
      return { status: "ok", mails: mails.slice(0, max), ...(all.length ? { accounts: all } : {}) };
    },
    // The one email the person chose, with its plain text, from the account it reached.
    async read(userId: string, ref: string): Promise<{ status: "ok"; mail: InboxMail; text: string; removed: string[] } | { status: "security"; mail: InboxMail } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string } | { status: "missing" }> {
      const p = parseRef(ref);
      if (!p) return { status: "missing" };
      const token = await d.token(userId, p.account);
      if (!token) return { status: "NOT_WIRED" };
      const g = await get(`${API}/${encodeURIComponent(p.id)}?format=full`, token);
      if (g.status === 404) return { status: "missing" };
      if (!g.ok) return { status: "ERROR", detail: `read the email: HTTP ${g.status}` };
      const m = await g.json().catch(() => ({}));
      if ((m?.labelIds ?? []).includes("SENT")) return { status: "missing" };
      const text = plainText(m?.payload) || squash(m?.snippet), mail = guarded(mailOf(m, p.account), text);
      if (mail.security) return { status: "security", mail };
      const body = redact(text);
      return hide({ status: "ok" as const, mail, text: body.text } as { status: "ok"; mail: InboxMail; text: string; removed: string[] }, [...(mail.removed ?? []), ...body.removed.map((r) => r.token)]);
    },
  };
}
export type Inbox = ReturnType<typeof inboxReader>;

// Whether one exact message is in the account's Sent mail.
//   found    by "id": a message whose Message-ID is this card's own (Gmail's rfc822msgid search): proof that Trainee's try went.
//            by "content": should Gmail have replaced that header, a sent message from no earlier than our try (5 s of clock
//            skew allowed) with the same To, Subject, In-Reply-To and the same text once normalised (soft line breaks unwrapped,
//            whitespace and no-break spaces collapsed, a trailing signature Gmail may add dropped). That proves a matching
//            message is there, not who sent it: it may be the person's own identical reply, and the reply says exactly that.
//   similar  some other reply is there (same thread or In-Reply-To, or same To and Subject) that does not match. Never proof.
//   unknown  the search itself failed.
// What is known about the Message-ID (from Gmail's API documentation, not verified against the live service): users.messages.send
// takes an RFC 2822 message in `raw` and the reference does not say whether a client's Message-ID header is kept; rfc822msgid: is a
// documented search operator. Widely reported behaviour is that a well-formed Message-ID is kept and one is generated only when it
// is missing, but nothing here relies on that: when the id search finds nothing, only the exact content match above counts.
export type SentCheck = { status: "found"; by?: "id" | "content"; id: string; thread_id: string | null } | { status: "similar"; id: string } | { status: "absent" } | { status: "unknown"; detail: string };
// since: when our try started. text: the whole text of the message, as sent.
export interface SentQuery { from: string | null; messageId: string; to: string; subject: string; inReplyTo: string; threadId?: string | null; text: string; since: number }
const flat = (s: string) => s.replace(/\r/g, "").replace(/=\n/g, "").replace(/\s+/g, " ").trim();
export function sameText(stored: string, ours: string): boolean {
  const a = flat(stored), b = flat(ours), bare = (x: string) => x.replace(/\s+/g, "");
  // A line wrapped by a mail system (even inside a word) changes only whitespace: the same characters in the same order count.
  return a === b || (b.length >= 20 && bare(a) === bare(b)) || (a.startsWith(b) && /^\s*(?:--\s|sent from |get outlook)/i.test(a.slice(b.length)));
}
export const CLOCK_SKEW_MS = 5_000;
export function sentFinder(d: InboxDeps) {
  return async (userId: string, q: SentQuery): Promise<SentCheck> => {
    try {
      const token = await d.token(userId, q.from);
      if (!token) return { status: "unknown", detail: "no Gmail that may be read" };
      const list = async (query: string) => {
        const r = await d.fetch(`${API}?q=${encodeURIComponent(query)}&maxResults=10`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error(`search Sent: HTTP ${r.status}`);
        const j: any = await r.json();
        return (Array.isArray(j?.messages) ? j.messages : []).map((m: any) => ({ id: String(m?.id ?? ""), thread_id: m?.threadId ? String(m.threadId) : null })).filter((m: { id: string }) => m.id);
      };
      const byId = await list(`rfc822msgid:${q.messageId.replace(/^<|>$/g, "")}`);
      if (byId.length) return { status: "found", by: "id", ...byId[0] };
      let similar: string | null = null, content: { id: string; thread_id: string | null } | null = null;
      for (const c of await list(`in:sent to:${q.to} after:${Math.floor(q.since / 1000) - 86400}`)) {
        const g = await d.fetch(`${API}/${encodeURIComponent(c.id)}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
        if (!g.ok) throw new Error(`read a sent message: HTTP ${g.status}`);
        const m = await g.json();
        if (squash(header(m, "Message-ID") || header(m, "Message-Id")) === q.messageId) return { status: "found", by: "id", ...c };
        const answers = squash(header(m, "In-Reply-To")) === q.inReplyTo;
        const heads = addressIn(header(m, "To")) === q.to && squash(decodeWords(header(m, "Subject"))) === squash(q.subject);
        if (answers && heads && Number(m?.internalDate) >= q.since - CLOCK_SKEW_MS && sameText(wholePlain(m?.payload), q.text)) content ??= c;
        else if (answers || heads || (!!q.threadId && c.thread_id === q.threadId)) similar ??= c.id;
      }
      return content ? { status: "found", by: "content", ...content } : similar ? { status: "similar", id: similar } : { status: "absent" };
    } catch (e) { return { status: "unknown", detail: e instanceof Error ? e.message : String(e) }; }
  };
}

// What the card waits on (the assistant message's meta, written by the handler from the tool's show.meta).
// from_mailbox (D-062): the person's account the reply is sent from (by default the one the email reached). Shown on the card,
// kept on the row (recipient.reply, written once) and inside the hash. hash, text and created_at: the approval key, the exact text
// shown and when the card was made, kept with the card itself: the yes sends only a row that still equals what the card showed.
// acknowledged: other replies to the same email (sent, or possibly sent) the person was told about before this yes: the card's
// own warning line, or the warning a first yes got. Any other such reply stops the send and is said first.
export interface ReplyCardMeta { mail_reply_card: string; mail_reply: { to: string; subject: string; in_reply_to: string; thread_id: string | null; from_name: string; from_mailbox?: string | null; hash?: string; text?: string; created_at?: string; prior_unconfirmed?: string; acknowledged?: string[] } }
const sourceFor = (from: string | null) => `reply to their email${from ? `, from ${from}` : ""}`;
export const replySubject = (s: string) => (/^\s*re\s*:/i.test(s) ? squash(s) : `Re: ${squash(s) || "your email"}`).slice(0, 200);
// The approval's key: everything a yes approves. Cc and Bcc are always empty (a reply goes to one address) and are in the key
// so that stays part of what was approved.
export interface ReplyPayload { from: string | null; to: string; subject: string; text: string; in_reply_to: string; thread_id: string | null }
export const replyHash = (p: ReplyPayload) => sha256(JSON.stringify(["mail_reply", p.from, p.to, [], [], p.subject, p.text, p.in_reply_to, p.thread_id]));
const payloadOf = (d: OutreachDraft): ReplyPayload => {
  const m = messageOf(d), r = d.recipient.reply;
  return { from: r?.from ?? null, to: m.to, subject: m.subject, text: m.text, in_reply_to: String(r?.in_reply_to ?? ""), thread_id: r?.thread_id ?? null };
};
// This card's own Message-ID: the same on every try, so a second try can never be a second, different message unnoticed.
export const replyMessageId = (d: Pick<OutreachDraft, "id" | "hash" | "recipient">): string =>
  `<trainee-reply.${String(d.id).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)}.${String(d.hash).slice(0, 24)}@${(d.recipient.reply?.from ?? "").split("@")[1] || "mail.gmail.com"}>`;
const queryOf = (d: OutreachDraft, since: number): SentQuery => { const p = payloadOf(d); return { from: p.from, messageId: replyMessageId(d), to: p.to, subject: p.subject, inReplyTo: p.in_reply_to, threadId: p.thread_id, text: p.text, since }; };

// Whether the person, in their own message this turn, chose `want` (one of their own accounts) to send from. A choice is an
// instruction in their words: "send/reply/use ... from <their address>" or "... my other/second/different account" (with
// exactly two accounts), or a clause that is only that phrase ("the other account", "from my other email"). A negation, a
// question, or the phrase as part of someone else's story ("her other email bounced", "ask whether she got my other email")
// chooses nothing, and the card asks which account.
const ACCT = String.raw`(?:gmail|google|e-?mail|mail|account|address|inbox|mailbox)(?:\s+(?:account|address))?`;
const OTHER = String.raw`(?:other|second|2nd|different|another)`;
const LEAD = String.raw`^(?:(?:ok(?:ay)?|and|then|please|also|but|so)\s+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const VERB = String.raw`(?:send|reply|respond|answer|write|use|go|switch|do)\b(?:\s+(?:it|this|that|them|the\s+reply|my\s+reply|the\s+email|back|to\s+[^\s,]+))*`;
const VIA = String.raw`(?:\s+(?:from|with|via|using|through|on))?`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function personChose(said: string, want: string, reached: string | null, accounts: string[]): boolean {
  const t = String(said ?? "").toLowerCase().replace(/[’`]/g, "'");
  const clauses = t.split(/[.;!?,]+(?=\s|$)|\n+|\s(?:and|but|then|anyway|also)\s/).map((c) => c.trim()).filter(Boolean);
  const addr = esc(want);
  const byAddress = new RegExp(`${LEAD}(?:${VERB}${VIA}|from)\\s+(?:my\\s+(?:\\w+\\s+)?(?:account|address|email|gmail)\\s+)?${addr}(?![\\w.@-])|^(?:from\\s+)?${addr}(?:\\s+please)?$`);
  if (clauses.some((c) => byAddress.test(c))) return true;
  if (!(accounts.length === 2 && !!reached && accounts.includes(reached) && want !== reached)) return false;
  const other = new RegExp(`${LEAD}${VERB}${VIA}\\s+(?:my|the|a)\\s+${OTHER}\\s+(?:(?:work|personal|school)\\s+)?${ACCT}(?:\\s+of\\s+mine)?(?:\\s+please)?$|${LEAD}${VERB}${VIA}\\s+(?:my|the|a)\\s+${OTHER}\\s+(?:(?:work|personal|school)\\s+)?${ACCT}\\b(?!\\s+(?:is|was|bounced|address\\s+is))|^(?:from\\s+)?(?:my\\s+|the\\s+)?${OTHER}\\s+(?:(?:work|personal|school)\\s+)?${ACCT}(?:\\s+of\\s+mine)?(?:\\s+please)?$`);
  return clauses.some((c) => other.test(c));
}

// The unknown-outcome record on a row that is still "sending": when the try ENDED (answered, threw, timed out, or was found
// abandoned). A row in "sending" without it has a try that may still be in flight.
export const UNKNOWN_OUTCOME = "unknown_outcome";
const endedAt = (d: Pick<OutreachDraft, "result">): number | null => { const m = /^unknown_outcome@(\S+): /.exec(String(d.result ?? "")); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : null; };
const unknownResult = (end: number, why: string) => `${UNKNOWN_OUTCOME}@${new Date(end).toISOString()}: ${why}`.slice(0, 200);
// After a try whose outcome is unknown, this card is never sent again. A fresh card for the same email may be made only when Sent
// shows no matching message and this long has passed since the try ended (Sent can lag; a request cut off may still land).
export const FRESH_CARD_AFTER_MS = 15 * 60_000;
// A try that never recorded its end (the process died mid-send) is taken as ended when it is found, once it is older than the
// send request's own limit and this margin; from then the rules above apply.
export const ABANDONED_AFTER_MS = SEND_TIMEOUT_MS + 30_000;
async function recordEnd(s: OutreachStore, userId: string, d: OutreachDraft, now: number): Promise<OutreachDraft> {
  if (endedAt(d) !== null || d.status !== "sending") return d;
  const began = Date.parse(d.sent_at ?? "") || now;
  if (now - began < ABANDONED_AFTER_MS) return d;
  const next = { ...d, result: unknownResult(now, "the try never recorded its end; found abandoned") };
  return (await s.update(userId, next, { status: "sending" })) ? next : d;
}
const minutesLeft = (end: number, now: number) => Math.max(1, Math.ceil((end + FRESH_CARD_AFTER_MS - now) / 60_000));
// The way out of an unconfirmed send, named in every reply about one.
function wayOut(d: OutreachDraft, now: number, sentRead: boolean): string {
  const end = endedAt(d), from = d.recipient.reply?.from;
  const when = end === null ? "once that try has finished" : now - end >= FRESH_CARD_AFTER_MS ? "now" : `in about ${minutesLeft(end, now)} minute${minutesLeft(end, now) === 1 ? "" : "s"}`;
  return `Trainee will not send this card again. Look in your Sent folder${from ? ` (${from})` : ""}${sentRead ? "" : " (I can't read your Sent mail right now)"}; if it is not there, ask me to draft the reply again ${when === "now" ? "and I can make a new card now" : `and I can make a new card ${when}`}. The new card will say this one is unconfirmed, and only your yes to it sends.`;
}

// The card's exact text. Code shows the message it will send, word for word, and what a yes does. The heading is code's words and
// the address, or a display name that reads as a plain name and carries no status or instruction word.
const NOT_A_NAME = /\b(?:trainee|system|assistant|admin|approved?|sent|send|sending|yes|no|ignore|instructions?|prior|previous|already|confirmed?|done|nothing|reply|replied|draft|card|now|urgent|ok|okay|test|claude|ai|bot|notice|alert|security|support|team|noreply|delivered|delivery|failed|error)\b/i;
export const headingName = (n: string) => (nameLike(n) && !NOT_A_NAME.test(n) ? n : "");
export function replyCardText(m: Message, o: { from_name: string; original_subject?: string; sends: boolean; from?: string | null; prior?: string | null }): string {
  const tail = o.sends
    ? `Nothing is sent until you say yes, and a yes sends exactly this, once, from ${o.from ?? "your Gmail"}, as a reply in that email's thread. Say no to drop it, or tell me what to change${o.from ? " (or which of your accounts to send it from)" : ""}.`
    : "Trainee can't send from your Gmail yet (sending isn't allowed on your Google connection), so nothing will be sent; copy it into your own reply, or allow sending and ask again.";
  return [...(o.prior ? [o.prior, ""] : []), `Reply to ${headingName(o.from_name) || m.to}, not sent:`, ...(o.from ? [`From: ${o.from}`] : []), `To: ${m.to}`, `Subject: ${m.subject}`, "", m.text, "", tail].join("\n");
}

// `data` carries anything that came from the email (an address): never part of the note's own words.
export type ReplyDraftOut =
  | { status: "ok"; show: { intent: string; text: string; meta: Record<string, unknown> }; to: string; subject: string; hash: string; note: string }
  | { status: "rewrite"; problems: string[]; note: string } | { status: "refused"; reason: string; note: string; data?: Record<string, unknown> };
// Builds and saves the card for the one email being answered. The brain wrote `body`; code decides whether it may be shown.
export async function draftReply(o: {
  userId: string; threadId: string; now: number; inbox: Inbox; outreach: OutreachStore; ref: string; body: string;
  said: string; facts: string[]; signature: string | null; canSend: (from: string | null) => Promise<boolean>;
  // D-062: the account to send from, honoured only when the person's own message this turn chose it (personChose); absent, the
  // account the email reached. accounts: every Google account the person connected.
  sendFrom?: string | null; accounts?: string[];
  findSent?: (userId: string, q: SentQuery) => Promise<SentCheck>;
  // The output guard: what this turn removed from mail or withheld (agent/capability_tools.ts), kept in memory only.
  withheld?: Iterable<string>;
}): Promise<ReplyDraftOut> {
  const got = await o.inbox.read(o.userId, o.ref);
  if (got.status === "NOT_WIRED") return { status: "refused", reason: "gmail_not_connected", note: "No Gmail that Trainee may read is connected, so there is no email to answer. Say so and that they connect Gmail themselves (they sign in to Google); nothing was drafted or sent." };
  if (got.status === "security") return { status: "refused", reason: "security_mail", note: "That is a security email (a code, sign-in or account notice): it was not read and is not answered. Say so; nothing was drafted or sent." };
  if (got.status !== "ok") return { status: "refused", reason: got.status === "missing" ? "email_not_found" : "read_failed", note: "That email could not be read. Use find_email to find it again; nothing was drafted or sent." };
  const mail = got.mail, to = (mail.reply_to || mail.from).toLowerCase();
  if (!ONE_ADDRESS.test(to)) return { status: "refused", reason: "no_address", note: "That email has no single reply address, so no reply can be sent. Say so; nothing was drafted or sent." };
  if (automatedInbox(to)) return { status: "refused", reason: "automated_inbox", note: "The email's reply address (data.address) is an automated no-reply inbox: a reply there reaches no one. Say so; nothing was drafted or sent.", data: { address: shownAddress(to) } };
  if (!mail.message_id) return { status: "refused", reason: "no_message_id", note: "That email can't be replied to in its thread. Say so; nothing was drafted or sent." };
  // The output guard: nothing Trainee removed from mail or withheld this turn, and no code next to a code word, is ever sent.
  if (mentionsRemoved(String(o.body ?? ""), [...(o.withheld ?? []), ...((got as { removed?: string[] }).removed ?? [])]).length) return { status: "refused", reason: "removed_text", note: "The reply repeats text Trainee removed from an email or did not read (a code, a link or a password). It can't be sent. Write the reply without it; if the person needs that code or link, tell them to open the original email themselves. Nothing was drafted or sent." };
  if (codeInReply(String(o.body ?? "")).length) return { status: "refused", reason: "code_in_reply", note: "The reply has a code, password or key next to a word like code, PIN or password. Trainee never sends one. Write the reply without it; nothing was drafted or sent." };
  const name = headingName(mail.from_name);
  const checked = checkFollowup({ kind: "note", recipient: name || null, recipient_options: [], document: null, documents: [], body: String(o.body ?? ""), tone: null },
    { said: [o.said, mail.from_name, mail.subject, got.text].join("\n"), facts: o.facts });
  if (checked.status === "rewrite") return { status: "rewrite", problems: checked.problems, note: checked.note };
  if (checked.status === "ask") return { status: "rewrite", problems: [checked.note], note: checked.note };
  if (/\[[^\]\n]{1,40}\]/.test(checked.body)) return { status: "rewrite", problems: ["a placeholder in brackets is left in the reply"], note: "A reply that will be sent can't keep a placeholder: write the words, or ask the person for the one thing missing." };
  // The sending account is never a guess: the account the email reached, or the one the person's own words chose; with several
  // accounts and neither, the person is asked. Never "the first one".
  const accounts = (o.accounts ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean), reached = got.mail.account ? got.mail.account.toLowerCase() : null;
  const listed = accounts.join(", ") || "none";
  const want = o.sendFrom ? String(o.sendFrom).trim().toLowerCase() : null;
  if (want && !accounts.includes(want)) return { status: "refused", reason: "not_your_account", note: `The account asked for is not one of the person's connected accounts (${listed}). Ask which of those to send from; nothing was drafted or sent.` };
  if (want && want !== reached && !personChose(o.said, want, reached, accounts)) return { status: "refused", reason: "confirm_account", note: `The person's message did not choose ${want}. Ask which of their accounts to send this reply from (${listed}); nothing was drafted or sent. Leave send_from out to send from the account the email reached${reached ? ` (${reached})` : ""}.` };
  const from = want ?? reached ?? (accounts.length === 1 ? accounts[0] : null);
  if (!from && accounts.length > 1) return { status: "refused", reason: "which_account", note: `It is not known which of the person's accounts this email reached. Ask which to send the reply from (${listed}); nothing was drafted or sent.` };
  if (from && accounts.length && !accounts.includes(from)) return { status: "refused", reason: "not_your_account", note: `The account this email reached is no longer one of the person's connected accounts (${listed}). Ask which of those to send from; nothing was drafted or sent.` };
  const signature = squash(o.signature);
  if (!signature) return { status: "refused", reason: "no_signature", note: "Ask how they sign their emails (say \"sign as\" and their name); nothing was drafted or sent." };
  // An earlier reply to this same email still in a send attempt, looked up by its own key (the address and the answered email's
  // Message-ID). Its outcome decides: in Sent, nothing new is drafted; unconfirmed, a new card only after the wait and a Sent
  // check that finds no matching message, and that card says the earlier one is unconfirmed.
  const earlier = o.outreach.replyAttempts ? await o.outreach.replyAttempts(o.userId, to, mail.message_id)
    : (o.outreach.history ? await o.outreach.history(o.userId, 5000) : []).filter((x) => isMailReply(x) && (x.status === "sending" || x.status === "approved") && x.recipient.email === to && x.recipient.reply?.in_reply_to === mail.message_id);
  let prior: string | null = null, priorId: string | null = null;
  const acknowledged: string[] = [], told: string[] = [];
  for (const first of earlier) {
    // A reply to this email already went from another card: the new card says so first (a second reply is the person's call).
    // A try whose outcome stayed unknown when a later card replaced it may still have landed: every later card says so first.
    if (first.status === "failed") { acknowledged.push(first.id); told.push(`Before you answer: an earlier reply to this email (tried ${String(first.sent_at ?? first.approved_at ?? first.created_at).slice(0, 16).replace("T", " ")} UTC) is unconfirmed: it may have gone. If it did, a yes here sends another reply.`); continue; }
    if (first.status === "sent") { acknowledged.push(first.id); told.push(`Before you answer: you already sent a reply to this email (${String(first.sent_at ?? first.created_at).slice(0, 16).replace("T", " ")} UTC). If you say yes here, a second reply goes.`); continue; }
    const old = await recordEnd(o.outreach, o.userId, first, o.now);
    const began = Date.parse(old.sent_at ?? old.approved_at ?? "") || o.now, end = endedAt(old);
    const c: SentCheck = o.findSent ? await o.findSent(o.userId, queryOf(old, began)).catch((): SentCheck => ({ status: "unknown", detail: "" })) : { status: "unknown", detail: "" };
    if (c.status === "found") {
      await o.outreach.update(o.userId, { ...old, status: "sent", gmail_id: c.id, gmail_thread: c.thread_id, result: c.by === "content" ? "a matching message is in Sent (by its content)" : "sent (found in Sent)" }, { status: old.status });
      return { status: "refused", reason: "already_sent", note: c.by === "content"
        ? "A message matching the earlier reply to this same email is in the person's Sent mail. Say so; no second reply was drafted, and nothing was sent now. If they want to write again, they ask for a new reply."
        : "An earlier reply to this same email is in the person's Sent mail: it went, once. Say so; no second reply was drafted, and nothing was sent now. If they want to write again, they ask for a new reply." };
    }
    if (old.status === "approved" || end === null || o.now - end < FRESH_CARD_AFTER_MS) {
      const wait = end === null ? "once that try has finished" : `in about ${minutesLeft(end, o.now)} minutes`;
      return { status: "refused", reason: "earlier_unconfirmed", note: `An earlier reply to this same email was tried and it is unconfirmed whether it went. Say exactly that; tell them to look in their Sent folder, and that if it is not there they can ask again ${wait} for a new card that says so. No new reply was drafted; nothing was sent now.` };
    }
    // The wait is over and Sent holds no matching message (or could not be read): the old card is closed, and the new card says it.
    if (!(await o.outreach.update(o.userId, { ...old, status: "failed", result: `unconfirmed; replaced by a new card (Sent: ${c.status})`.slice(0, 200) }, { status: "sending" }))) return { status: "refused", reason: "earlier_unconfirmed", note: "An earlier reply to this same email changed just now. Ask again; nothing was drafted or sent." };
    const sentSays = c.status === "absent" ? "your Sent mail does not show it" : c.status === "similar" ? "your Sent mail has a reply in that thread, but not this one word for word" : "I could not read your Sent mail to check";
    prior = `Before you answer: an earlier reply to this email (tried ${new Date(began).toISOString().slice(0, 16).replace("T", " ")} UTC) is unconfirmed: it may have gone, and ${sentSays}. If it did go, a yes here sends a second reply.`;
    priorId = old.id;
    acknowledged.push(old.id);
  }
  if (told.length) prior = [...told, ...(prior ? [prior] : [])].join("\n");
  // A reply sent from another account than the one the email reached starts a new thread there (Gmail threads per mailbox).
  const thread = from && reached && from !== reached ? null : mail.thread_id;
  const base = { n: 1, recipient: { name: (name || to).slice(0, 120), firm: "", title: "", school: "", email: to, source: sourceFor(from), kind: "mail_reply" as const, reply: { from, in_reply_to: mail.message_id, thread_id: thread } },
    subject: replySubject(mail.subject), body: checked.body.trim().slice(0, 4000), footer: signature.slice(0, 300), shared: [], status: "shown" as const,
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  const m = messageOf(base), hash = await replyHash({ from, to: m.to, subject: m.subject, text: m.text, in_reply_to: mail.message_id, thread_id: thread });
  const [d] = await o.outreach.saveBatch(o.userId, o.threadId, [{ ...base, hash }], o.now);
  const sends = await o.canSend(from).catch(() => false);
  const meta: ReplyCardMeta = { mail_reply_card: d.id, mail_reply: { to, subject: m.subject, in_reply_to: mail.message_id, thread_id: thread, from_name: name, from_mailbox: from, hash, text: m.text, created_at: d.created_at, ...(priorId ? { prior_unconfirmed: priorId } : {}), ...(acknowledged.length ? { acknowledged } : {}) } };
  return { status: "ok", show: { intent: MAIL_REPLY_CARD_INTENT, text: replyCardText(m, { from_name: name, sends, from, prior }), meta: { ...meta } }, to, subject: m.subject, hash,
    note: prior ? "The card with the exact reply is shown to the person by code, with a line saying an earlier reply to this email is unconfirmed. Nothing is sent until they say yes to it." : "The card with the exact reply is shown to the person by code. Nothing is sent until they say yes to it." };
}

// The yes or no to the card (followupTurn calls this while the card is the thread's last word).
export interface ReplyAnswerDeps {
  outreach: OutreachStore; sendOn: boolean; canSend: (userId: string, from?: string | null) => Promise<boolean>;
  send: (userId: string, m: Message, t?: Threading | null) => Promise<{ status: string; id?: string; thread_id?: string; detail?: string; reason?: string; not_sent?: boolean }>;
  sendConsent?: (userId: string) => Promise<string | null>;
  // The person's own Google accounts that may send. Given, the card's account must be one of them, and a card with no account
  // sends only when there is exactly one.
  accounts?: (userId: string) => Promise<string[]>;
  // The Sent mailbox check (sentFinder). Absent, an unknown outcome stays unconfirmed.
  findSent?: (userId: string, q: SentQuery) => Promise<SentCheck>;
}
const DAY = 86_400_000;
const ROW_FIELDS = new Set(["name", "firm", "title", "school", "email", "source", "kind", "reply"]);
const ADMIT: Record<string, string> = { not_approved: "the approval was not recorded", changed: "the email changed after you saw it", expired: "the approval is too old",
  paused: "your account is paused", do_not_contact: "that address asked not to be contacted", bad_address: "that address bounced before", on_rail: "it is already on its way" };
type Answer = { reply: string; status: string; intent: string; meta?: Record<string, unknown> };
export async function replyAnswer(o: { userId: string; now: number; answer: "yes" | "no"; meta: ReplyCardMeta; deps: ReplyAnswerDeps }): Promise<Answer> {
  const done = (reply: string, status: string): Answer => ({ reply, status, intent: MAIL_REPLY_ANSWER_INTENT });
  const waiting = (reply: string, status: string, more: Partial<ReplyCardMeta["mail_reply"]> = {}): Answer => ({ reply, status, intent: MAIL_REPLY_CARD_INTENT, meta: { ...o.meta, mail_reply: { ...o.meta.mail_reply, ...more } } as Record<string, unknown> });
  const s = o.deps.outreach, id = o.meta.mail_reply_card;
  let d: OutreachDraft | undefined = (s.drafts ? await s.drafts(o.userId, [id]) : []).find((x) => x.id === id);
  if (!d || !isMailReply(d)) return done("That reply is no longer on record, so nothing was sent.", "missing");
  if (d.status === "sent") return done(/^a matching message/.test(String(d.result ?? "")) ? "A message matching that reply is already in your Sent mail; nothing more went." : "That reply was already sent; nothing more went.", "already_sent");
  if (d.status === "failed" && /^unconfirmed/.test(String(d.result ?? ""))) return done("That reply is unconfirmed and was replaced by a newer card, so nothing was sent. Answer the newer card instead.", "replaced");
  const p = payloadOf(d), to = p.to, mid = replyMessageId(d);
  const check = async (row: OutreachDraft, since: number): Promise<SentCheck> => o.deps.findSent ? await o.deps.findSent(o.userId, queryOf(row, since)).catch((e): SentCheck => ({ status: "unknown", detail: e instanceof Error ? e.message : String(e) })) : { status: "unknown", detail: "your Sent mail can't be checked from here" };
  const found = async (row: OutreachDraft, f: { by?: "id" | "content"; id: string; thread_id: string | null }) => {
    const byId = f.by !== "content";
    await s.update(o.userId, { ...row, status: "sent", gmail_id: f.id, gmail_thread: f.thread_id, result: byId ? "sent (found in Sent)" : "a matching message is in Sent (by its content)" }, { status: "sending" });
    return byId ? done(`Your reply to ${to} is in your Sent mail${p.from ? ` (${p.from})` : ""}: it went once, exactly as shown. Nothing more was sent.`, "sent")
      : done(`A message matching this reply word for word is in your Sent mail${p.from ? ` (${p.from})` : ""}, so nothing more will be sent. I can't tell whether it is Trainee's try or one you sent yourself.`, "matched_in_sent");
  };
  const unconfirmed = (row: OutreachDraft, why: string, c: SentCheck) => waiting(`Unconfirmed: I can't tell whether your reply to ${to} was sent (${why}).${c.status === "similar" ? " A reply in that thread is in your Sent mail, but it is not this one word for word." : ""} It may have gone. ${wayOut(row, o.now, c.status !== "unknown")}`, UNKNOWN_OUTCOME);
  if (d.status === "sending") {
    // A try is on this row: in flight, or its outcome was never learned. This card is never sent again; Sent is checked so the
    // reply can say what is known.
    d = await recordEnd(s, o.userId, d, o.now);
    const began = Date.parse(d.sent_at ?? "") || o.now, c = await check(d, began);
    if (c.status === "found") return await found(d, c);
    if (endedAt(d) === null) return unconfirmed(d, "that try may still be on its way", c);
    if (o.answer === "no") return waiting(`I can't take that reply back: it is unconfirmed whether it already went to ${to}. ${wayOut(d, o.now, c.status !== "unknown")}`, UNKNOWN_OUTCOME);
    return unconfirmed(d, c.status === "unknown" ? squash(c.detail).slice(0, 120) || "your Sent mail could not be searched" : c.status === "similar" ? "your Sent mail does not show this exact message" : "it is not in your Sent mail yet", c);
  }
  if (d.status === "approved") {
    // An approval a failed claim left behind (no run sends this kind). One written moments ago is another yes still at work.
    if (o.now - (Date.parse(d.approved_at ?? "") || 0) < 60_000) return waiting(`That reply to ${to} is being handled right now; nothing more was sent. If it has not gone in a minute, say yes again.`, "in_progress");
    const back: OutreachDraft = { ...d, status: "shown", approved_hash: null, approved_at: null };
    if (!(await s.update(o.userId, back, { status: "approved" }))) return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
    d = back;
  }
  if (d.status !== "shown") return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
  const c = o.meta.mail_reply;
  if (Date.parse(c.created_at ?? d.created_at) < o.now - DAY || Date.parse(d.created_at) < o.now - DAY) return done("That reply is more than a day old, so nothing was sent. Ask me to draft it again.", "expired");
  if (o.answer === "no") { await s.update(o.userId, { ...d, status: "skipped" }, { status: "shown" }); return done("Dropped. Nothing was sent.", "declined"); }
  const m = messageOf(d), h = await replyHash(p), from = p.from;
  const changed = () => done("Not sent: the reply changed after you saw it, so your yes was not for this version.", "changed");
  // The row must still be the card: its own hash, and the hash, text and making time the card itself carried when it was shown.
  // Nothing rides on the row that the card did not show: no field beyond a reply's own, nothing attached.
  if (Object.keys(d.recipient).some((k) => !ROW_FIELDS.has(k)) || (d.shared ?? []).length) return changed();
  if (h !== d.hash || c.hash !== h || c.text !== m.text || c.created_at !== d.created_at || !MESSAGE_ID.test(p.in_reply_to) || to !== c.to || p.subject !== c.subject || p.in_reply_to !== c.in_reply_to || p.thread_id !== (c.thread_id ?? null) || from !== (c.from_mailbox ?? null)) return changed();
  if (codeInReply(m.text).length) return done("Not sent: the reply has a code, password or key in it next to a word like code or PIN, and Trainee never sends one. Ask me to draft it again without it.", "code_in_reply");
  if (!o.deps.sendOn) return waiting("Not sent: sending email is switched off in Trainee right now. Copy the reply above into your own email.", "SEND_OFF");
  if (o.deps.accounts) {
    const mine = (await o.deps.accounts(o.userId).catch(() => [] as string[])).map((a) => String(a).toLowerCase());
    if (from ? !mine.includes(from) : mine.length > 1) return waiting(`Not sent: ${from ? `${from} is not one of your connected Google accounts that may send` : "this card does not say which of your Google accounts to send from"}, so nothing went to ${to}. Ask me to draft the reply again and say which account to use.`, "NOT_WIRED");
  }
  if (!(await o.deps.canSend(o.userId, from).catch(() => false))) {
    const allow = o.deps.sendConsent ? await o.deps.sendConsent(o.userId).catch(() => null) : null;
    return waiting(`Not sent: your Google connection lets Trainee read your mail, not send it.${allow ? ` To send from your Gmail, allow sending (you sign in to Google yourself): ${allow} then say yes again.` : ""} Or copy the reply above into your own email.`, "NOT_WIRED");
  }
  // Another card's reply to this same email that went, or may have: said first, and this card sends only on a yes after that.
  const known = new Set([...(c.acknowledged ?? []), ...(c.prior_unconfirmed ? [c.prior_unconfirmed] : [])]);
  const others = async () => (s.replyAttempts ? await s.replyAttempts(o.userId, to, p.in_reply_to) : []).filter((x) => x.id !== id && !known.has(x.id));
  const another = (rows: OutreachDraft[]) => {
    const went = rows.find((x) => x.status === "sent"), when = (x: OutreachDraft) => String(x.sent_at ?? x.approved_at ?? x.created_at).slice(0, 16).replace("T", " ");
    const what = went ? `already went to ${to} (${when(went)} UTC)` : `may already have gone to ${to} (tried ${when(rows[0])} UTC; it is unconfirmed)`;
    return waiting(`Not sent: another reply to this same email, from another card, ${what}. Say yes again only if you want this reply sent as well; say no to drop it.`, "another_reply", { acknowledged: [...known, ...rows.map((x) => x.id)] });
  };
  const before = await others();
  if (before.length) return another(before);
  const at = new Date(o.now).toISOString();
  const approved: OutreachDraft = { ...d, status: "approved", approved_hash: h, approved_at: at };
  if (!(await s.update(o.userId, approved, { status: "shown", hash: h }))) return changed();
  // The approval stands only with its claim: a claim that fails or throws puts the card back to waiting, never left approved.
  let admit: string;
  try { admit = await s.claim(o.userId, approved, h, o.now, dayStartOf(o.now)); } catch (e) { console.error("mail reply: claim failed", e instanceof Error ? e.message : String(e)); admit = "error"; }
  if (admit !== "ok") {
    await s.update(o.userId, { ...approved, status: "shown", approved_hash: null, approved_at: null, result: admit }, { status: "approved" }).catch((e) => console.error("mail reply: approval not taken back", e instanceof Error ? e.message : String(e)));
    return waiting(`Not sent: ${admit === "error" ? "the approval could not be recorded just now" : ADMIT[admit] ?? admit}. Nothing went to ${to}.${admit === "error" ? " Say yes to try again." : ""}`, admit === "error" ? "not_recorded" : admit);
  }
  let sending: OutreachDraft = { ...approved, status: "sending", sent_at: at };
  // Two cards for one email said yes to at the same moment: after the claim, another one claimed or sent is said first and this
  // card waits (if both see each other, neither sends and both say so).
  const raced = await others();
  if (raced.length) {
    await s.update(o.userId, { ...sending, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: "held: another reply to this email" }, { status: "sending" });
    return another(raced);
  }
  const t0 = performance.now();
  const r = await o.deps.send(o.userId, m, { inReplyTo: p.in_reply_to, threadId: p.thread_id, from, messageId: mid })
    .catch((e): { status: string; id?: string; thread_id?: string; detail?: string; reason?: string; not_sent?: boolean } => ({ status: "ERROR", detail: e instanceof Error ? e.message : String(e) }));
  const ended = o.now + Math.max(0, Math.round(performance.now() - t0));
  if (r.status === "sent" && r.id) {
    await s.update(o.userId, { ...sending, status: "sent", gmail_id: r.id, gmail_thread: r.thread_id ?? null, result: "sent" }, { status: "sending" });
    return done(`Sent to ${to} from ${from ?? "your Gmail"}${p.thread_id ? ", in that email's thread" : ""}, exactly as shown.`, "sent");
  }
  // Nothing went only when the answer says so: no grant that may send, Gmail's limit, or its own refusal (a 4xx).
  if (r.status === "NOT_WIRED" || r.status === "RATE_LIMITED" || (r.status === "ERROR" && r.not_sent === true)) {
    await s.update(o.userId, { ...sending, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: `${r.status}: ${squash(r.detail ?? r.reason)}`.slice(0, 200) }, { status: "sending" });
    if (r.status === "NOT_WIRED") return waiting(`Not sent: your Google connection doesn't let Trainee send email, so nothing went to ${to}.`, "NOT_WIRED");
    if (r.status === "RATE_LIMITED") return waiting(`Not sent: Gmail asked Trainee to slow down. Nothing went to ${to}; say yes again in a few minutes.`, "rate_limited");
    return waiting(`Not sent: Gmail refused it (${squash(r.detail).slice(0, 120)}). Nothing went to ${to}; say yes to try once more.`, "refused");
  }
  // No answer, a timeout, a 5xx: Gmail may have taken it. The row stays claimed ("sending") with the time the try ended; this card
  // is never sent again. Sent is searched now; the reply names the way out.
  const why = squash(r.detail ?? r.reason ?? r.status).slice(0, 100) || "no answer from Gmail";
  sending = { ...sending, result: unknownResult(ended, why) };
  await s.update(o.userId, sending, { status: "sending" });
  const now = await check(sending, o.now);
  if (now.status === "found") return await found(sending, now);
  return unconfirmed(sending, why, now);
}
