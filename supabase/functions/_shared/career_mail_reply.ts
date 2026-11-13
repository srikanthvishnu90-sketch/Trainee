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
import { redactSecrets, securityMail, shownAddress } from "./mail_security.ts";
import { MESSAGE_ID, ONE_ADDRESS, type Threading } from "./career_outreach_gmail.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const MAIL_REPLY_CARD_INTENT = "career_mail_reply_card";
export const MAIL_REPLY_ANSWER_INTENT = "career_mail_reply_answer";
export const BODY_MAX = 3000;

// account (D-062): the person's Gmail address the email reached; ref is "<gmail id>~<account>" so a later read asks the same account.
// security: a one-time code, sign-in, password or account-security email: found, and its subject, snippet and text withheld.
export interface InboxMail { ref: string; account: string | null; thread_id: string | null; from: string; from_name: string; reply_to: string | null; subject: string; date: string; snippet: string; message_id: string | null; security?: true }
const guarded = (mail: InboxMail, text: string): InboxMail => securityMail({ from: mail.from, subject: mail.subject, text: `${mail.snippet}\n${text}` })
  ? { ...mail, from: shownAddress(mail.from), from_name: "", reply_to: null, subject: "", snippet: "", security: true }
  : { ...mail, from_name: redactSecrets(mail.from_name), subject: redactSecrets(mail.subject), snippet: redactSecrets(mail.snippet) };
export type InboxRead = { status: "ok"; mails: InboxMail[] } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };
// D-062: token for one account (null: the first grant); accounts: every Google account the person connected (absent: the first grant only).
export interface InboxDeps { fetch: typeof fetch; token: (userId: string, account: string | null) => Promise<string | null>; accounts?: (userId: string) => Promise<{ mailbox: string; can_read: boolean; can_send: boolean }[]> }
const refOf = (id: string, account: string | null) => (account ? `${id}~${account}` : id);
const parseRef = (ref: string): { id: string; account: string | null } | null => {
  const m = /^([A-Za-z0-9_-]{1,64})(?:~([a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}))?$/i.exec(String(ref ?? "").trim());
  return m ? { id: m[1], account: m[2] ? m[2].toLowerCase() : null } : null;
};

// Control, bidi and zero-width characters never reach a card, a header or a model from someone else's email.
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const squash = (s: unknown) => String(s ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim();
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
    async read(userId: string, ref: string): Promise<{ status: "ok"; mail: InboxMail; text: string } | { status: "security"; mail: InboxMail } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string } | { status: "missing" }> {
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
      return mail.security ? { status: "security", mail } : { status: "ok", mail, text: redactSecrets(text) };
    },
  };
}
export type Inbox = ReturnType<typeof inboxReader>;

// Whether one exact message is in the account's Sent mail.
//   found    proof that OUR message went: a message whose Message-ID is this card's own (Gmail's rfc822msgid search), or, should
//            Gmail have replaced that header, a sent message at or after our try with the same To, Subject, In-Reply-To and the
//            same whole text. Only "found" may be recorded as sent.
//   similar  some other reply is there (same thread or In-Reply-To, or same To and Subject) that is not provably ours: it may be
//            one the person wrote by hand. Never proof, and never "absent".
//   unknown  the search itself failed.
// What is known about the Message-ID (from Gmail's API documentation, not verified against the live service): users.messages.send
// takes an RFC 2822 message in `raw` and the reference does not say whether a client's Message-ID header is kept; rfc822msgid: is a
// documented search operator. Widely reported behaviour is that a well-formed Message-ID is kept and one is generated only when it
// is missing, but nothing here relies on that: when the id search finds nothing, the exact-text match above is the only other proof.
export type SentCheck = { status: "found"; id: string; thread_id: string | null } | { status: "similar"; id: string } | { status: "absent" } | { status: "unknown"; detail: string };
// since: when our try started. text: the whole text of the message, as sent.
export interface SentQuery { from: string | null; messageId: string; to: string; subject: string; inReplyTo: string; threadId?: string | null; text: string; since: number }
const sameText = (a: string, b: string) => { const n = (s: string) => s.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").trim(); return n(a) === n(b); };
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
      if (byId.length) return { status: "found", ...byId[0] };
      let similar: string | null = null;
      for (const c of await list(`in:sent to:${q.to} after:${Math.floor(q.since / 1000) - 86400}`)) {
        const g = await d.fetch(`${API}/${encodeURIComponent(c.id)}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
        if (!g.ok) throw new Error(`read a sent message: HTTP ${g.status}`);
        const m = await g.json();
        if (squash(header(m, "Message-ID") || header(m, "Message-Id")) === q.messageId) return { status: "found", ...c };
        const answers = squash(header(m, "In-Reply-To")) === q.inReplyTo;
        const heads = addressIn(header(m, "To")) === q.to && squash(decodeWords(header(m, "Subject"))) === squash(q.subject);
        if (answers && heads && Number(m?.internalDate) >= q.since && sameText(wholePlain(m?.payload), q.text)) return { status: "found", ...c };
        if (answers || heads || (!!q.threadId && c.thread_id === q.threadId)) similar ??= c.id;
      }
      return similar ? { status: "similar", id: similar } : { status: "absent" };
    } catch (e) { return { status: "unknown", detail: e instanceof Error ? e.message : String(e) }; }
  };
}

// What the card waits on (the assistant message's meta, written by the handler from the tool's show.meta).
// from_mailbox (D-062): the person's account the reply is sent from (by default the one the email reached). Shown on the card,
// kept on the row (recipient.reply, written once) and inside the hash. hash and text: the approval key and the exact text shown,
// kept with the card itself: the yes sends only a row that still equals what the card showed, so a row whose text and hash were
// both rewritten is refused. ack_similar: this card has told the person another reply already sits in Sent.
export interface ReplyCardMeta { mail_reply_card: string; mail_reply: { to: string; subject: string; in_reply_to: string; thread_id: string | null; from_name: string; from_mailbox?: string | null; hash?: string; text?: string; ack_similar?: boolean } }
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
// Whether the person, in their own message this turn, chose `want` (one of their own accounts) to send from: they wrote that
// address, or they said "my other account" (the word next to gmail, email, account, address, inbox or mailbox) and have exactly
// two. "The second interview", "another reply" and someone else's address choose nothing.
const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
function personChose(said: string, want: string, reached: string | null, accounts: string[]): boolean {
  const t = String(said ?? "").toLowerCase();
  if ((t.match(ADDRESS) ?? ([] as string[])).includes(want)) return true;
  return accounts.length === 2 && !!reached && accounts.includes(reached) && want !== reached
    && /\b(?:other|another|different|second|2nd)\s+(?:(?:gmail|google|e-?mail|mail|work|personal|school)\s+)?(?:gmail|e-?mail|account|address|inbox|mailbox)\b/.test(t.replace(ADDRESS, " "));
}

// The unknown-outcome record on a row that is still "sending": when the try ENDED (answered, threw or timed out). A row in
// "sending" without it has a try that never recorded its end: it may still be in flight, and is never sent again.
export const UNKNOWN_OUTCOME = "unknown_outcome";
const endedAt = (d: Pick<OutreachDraft, "result">): number | null => { const m = /^unknown_outcome@(\S+): /.exec(String(d.result ?? "")); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : null; };
const unknownResult = (end: number, why: string) => `${UNKNOWN_OUTCOME}@${new Date(end).toISOString()}: ${why}`.slice(0, 200);
// How long after a try ENDED Sent must still not hold the message before it may be tried again. The send request itself is cut
// off after SEND_TIMEOUT_MS (career_outreach_gmail.ts), so no call can still be in flight when this window closes.
export const UNKNOWN_SETTLE_MS = 120_000;
// A try that never recorded its end is taken as over only for REPLACING the row with a new card, and only this long after it began.
const ABANDONED_MS = 600_000;

// The card's exact text. Code shows the message it will send, word for word, and what a yes does. The heading is code's words
// and the address (or a display name that reads as a name); the sender's subject is not in it.
export function replyCardText(m: Message, o: { from_name: string; original_subject?: string; sends: boolean; from?: string | null }): string {
  const tail = o.sends
    ? `Nothing is sent until you say yes, and a yes sends exactly this, once, from ${o.from ?? "your Gmail"}, as a reply in that email's thread. Say no to drop it, or tell me what to change${o.from ? " (or which of your accounts to send it from)" : ""}.`
    : "Trainee can't send from your Gmail yet (sending isn't allowed on your Google connection), so nothing will be sent; copy it into your own reply, or allow sending and ask again.";
  return [`Reply to ${nameLike(o.from_name) ? o.from_name : m.to}, not sent:`, ...(o.from ? [`From: ${o.from}`] : []), `To: ${m.to}`, `Subject: ${m.subject}`, "", m.text, "", tail].join("\n");
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
}): Promise<ReplyDraftOut> {
  const got = await o.inbox.read(o.userId, o.ref);
  if (got.status === "NOT_WIRED") return { status: "refused", reason: "gmail_not_connected", note: "No Gmail that Trainee may read is connected, so there is no email to answer. Say so and that they connect Gmail themselves (they sign in to Google); nothing was drafted or sent." };
  if (got.status === "security") return { status: "refused", reason: "security_mail", note: "That is a security email (a code, sign-in or account notice): it was not read and is not answered. Say so; nothing was drafted or sent." };
  if (got.status !== "ok") return { status: "refused", reason: got.status === "missing" ? "email_not_found" : "read_failed", note: "That email could not be read. Use find_email to find it again; nothing was drafted or sent." };
  const mail = got.mail, to = (mail.reply_to || mail.from).toLowerCase();
  if (!ONE_ADDRESS.test(to)) return { status: "refused", reason: "no_address", note: "That email has no single reply address, so no reply can be sent. Say so; nothing was drafted or sent." };
  if (automatedInbox(to)) return { status: "refused", reason: "automated_inbox", note: "The email's reply address (data.address) is an automated no-reply inbox: a reply there reaches no one. Say so; nothing was drafted or sent.", data: { address: shownAddress(to) } };
  if (!mail.message_id) return { status: "refused", reason: "no_message_id", note: "That email can't be replied to in its thread. Say so; nothing was drafted or sent." };
  const name = nameLike(mail.from_name) ? mail.from_name : "";
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
  if (want && want !== reached && !personChose(o.said, want, reached, accounts)) return { status: "refused", reason: "confirm_account", note: `The person's message did not name ${want}. Ask which of their accounts to send this reply from (${listed}); nothing was drafted or sent. Leave send_from out to send from the account the email reached${reached ? ` (${reached})` : ""}.` };
  const from = want ?? reached ?? (accounts.length === 1 ? accounts[0] : null);
  if (!from && accounts.length > 1) return { status: "refused", reason: "which_account", note: `It is not known which of the person's accounts this email reached. Ask which to send the reply from (${listed}); nothing was drafted or sent.` };
  if (from && accounts.length && !accounts.includes(from)) return { status: "refused", reason: "not_your_account", note: `The account this email reached is no longer one of the person's connected accounts (${listed}). Ask which of those to send from; nothing was drafted or sent.` };
  const signature = squash(o.signature);
  if (!signature) return { status: "refused", reason: "no_signature", note: "Ask how they sign their emails (say \"sign as\" and their name); nothing was drafted or sent." };
  // An earlier reply to this same email whose outcome is unknown: a new card would be a second message. Sent is searched for the
  // earlier one first; only when it is not there, after its try ended, does a new card replace it (the old row closed as not sent).
  const earlier = (o.outreach.history ? await o.outreach.history(o.userId, 200) : []).filter((x) => isMailReply(x) && x.status === "sending" && x.recipient.email === to && x.recipient.reply?.in_reply_to === mail.message_id);
  for (const old of earlier) {
    const began = Date.parse(old.sent_at ?? "") || o.now, end = endedAt(old);
    const c: SentCheck = o.findSent ? await o.findSent(o.userId, queryOf(old, began)).catch((): SentCheck => ({ status: "unknown", detail: "" })) : { status: "unknown", detail: "" };
    if (c.status === "found") {
      await o.outreach.update(o.userId, { ...old, status: "sent", gmail_id: c.id, gmail_thread: c.thread_id, result: "sent (found in Sent)" }, { status: "sending" });
      return { status: "refused", reason: "already_sent", note: "An earlier reply to this same email is in the person's Sent mail: it went, once. Say so; no second reply was drafted, and nothing was sent now. If they want to write again, they ask for a new reply." };
    }
    const over = end !== null ? o.now - end >= UNKNOWN_SETTLE_MS : o.now - began >= ABANDONED_MS;
    if (c.status !== "absent" || !over) return { status: "refused", reason: "earlier_unconfirmed", note: `An earlier reply to this same email was tried and it is unconfirmed whether it went${c.status === "similar" ? " (a reply in that thread is in their Sent mail, but it can't be confirmed as that one)" : ""}. Say exactly that, and that they can look in their Sent folder; ask again in a few minutes and Trainee checks Sent before drafting. No new reply was drafted; nothing was sent now.` };
    if (!(await o.outreach.update(o.userId, { ...old, status: "failed", result: "not sent: not in Sent after its try; replaced by a new card" }, { status: "sending" }))) return { status: "refused", reason: "earlier_unconfirmed", note: "An earlier reply to this same email changed just now. Ask again; nothing was drafted or sent." };
  }
  // A reply sent from another account than the one the email reached starts a new thread there (Gmail threads per mailbox).
  const thread = from && reached && from !== reached ? null : mail.thread_id;
  const base = { n: 1, recipient: { name: (name || to).slice(0, 120), firm: "", title: "", school: "", email: to, source: sourceFor(from), kind: "mail_reply" as const, reply: { from, in_reply_to: mail.message_id, thread_id: thread } },
    subject: replySubject(mail.subject), body: checked.body.trim().slice(0, 4000), footer: signature.slice(0, 300), shared: [], status: "shown" as const,
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  const m = messageOf(base), hash = await replyHash({ from, to: m.to, subject: m.subject, text: m.text, in_reply_to: mail.message_id, thread_id: thread });
  const [d] = await o.outreach.saveBatch(o.userId, o.threadId, [{ ...base, hash }], o.now);
  const sends = await o.canSend(from).catch(() => false);
  const meta: ReplyCardMeta = { mail_reply_card: d.id, mail_reply: { to, subject: m.subject, in_reply_to: mail.message_id, thread_id: thread, from_name: name, from_mailbox: from, hash, text: m.text } };
  return { status: "ok", show: { intent: MAIL_REPLY_CARD_INTENT, text: replyCardText(m, { from_name: name, sends, from }), meta: { ...meta } }, to, subject: m.subject, hash,
    note: "The card with the exact reply is shown to the person by code. Nothing is sent until they say yes to it." };
}

// The yes or no to the card (followupTurn calls this while the card is the thread's last word).
export interface ReplyAnswerDeps {
  outreach: OutreachStore; sendOn: boolean; canSend: (userId: string, from?: string | null) => Promise<boolean>;
  send: (userId: string, m: Message, t?: Threading | null) => Promise<{ status: string; id?: string; thread_id?: string; detail?: string; reason?: string; not_sent?: boolean }>;
  sendConsent?: (userId: string) => Promise<string | null>;
  // The person's own Google accounts that may send. Given, the card's account must be one of them, and a card with no account
  // sends only when there is exactly one.
  accounts?: (userId: string) => Promise<string[]>;
  // The Sent mailbox check (sentFinder). Absent, a try with an unknown outcome is never sent again.
  findSent?: (userId: string, q: SentQuery) => Promise<SentCheck>;
}
const DAY = 86_400_000;
const ROW_FIELDS = new Set(["name", "firm", "title", "school", "email", "source", "kind", "reply"]);
const ADMIT: Record<string, string> = { not_approved: "the approval was not recorded", changed: "the email changed after you saw it", expired: "the approval is too old",
  paused: "your account is paused", do_not_contact: "that address asked not to be contacted", bad_address: "that address bounced before", on_rail: "it is already on its way" };
type Answer = { reply: string; status: string; intent: string; meta?: Record<string, unknown> };
export async function replyAnswer(o: { userId: string; now: number; answer: "yes" | "no"; meta: ReplyCardMeta; deps: ReplyAnswerDeps }): Promise<Answer> {
  const done = (reply: string, status: string): Answer => ({ reply, status, intent: MAIL_REPLY_ANSWER_INTENT });
  const waiting = (reply: string, status: string, more: Record<string, unknown> = {}): Answer => ({ reply, status, intent: MAIL_REPLY_CARD_INTENT, meta: { ...o.meta, mail_reply: { ...o.meta.mail_reply, ...more } } as Record<string, unknown> });
  const s = o.deps.outreach, id = o.meta.mail_reply_card;
  let d: OutreachDraft | undefined = (s.drafts ? await s.drafts(o.userId, [id]) : []).find((x) => x.id === id);
  if (!d || !isMailReply(d)) return done("That reply is no longer on record, so nothing was sent.", "missing");
  if (d.status === "sent") return done("That reply was already sent; nothing more went.", "already_sent");
  const p = payloadOf(d), to = p.to, mid = replyMessageId(d);
  const check = async (since: number): Promise<SentCheck> => o.deps.findSent ? await o.deps.findSent(o.userId, queryOf(d!, since)).catch((e): SentCheck => ({ status: "unknown", detail: e instanceof Error ? e.message : String(e) })) : { status: "unknown", detail: "your Sent mail can't be checked from here" };
  const unconfirmed = (why: string) => waiting(`Unconfirmed: I can't tell whether your reply to ${to} was sent (${why}). It may have gone. I have not tried again, and won't until your Sent mail shows it isn't there. Say yes and I'll check Sent first; you can also look in your Sent folder.`, UNKNOWN_OUTCOME);
  // Another reply sits in Sent that is not provably this one (the person may have written it by hand): never called sent, and the
  // card is sent as well only on a new yes given after being told so.
  const similar = () => waiting(`Unconfirmed: a reply to ${to} in this thread exists in your Sent mail, but I can't confirm it is the one shown above (you may have written it yourself). I have not sent anything more. Say yes only if you want the reply shown above sent as well; say no to leave it.`, UNKNOWN_OUTCOME, { ack_similar: true });
  const found = async (row: OutreachDraft, f: { id: string; thread_id: string | null }) => {
    await s.update(o.userId, { ...row, status: "sent", gmail_id: f.id, gmail_thread: f.thread_id, result: "sent (found in Sent)" }, { status: "sending" });
    return done(`Your reply to ${to} is in your Sent mail${p.from ? ` (${p.from})` : ""}: it went once, exactly as shown. Nothing more was sent.`, "sent");
  };
  let retry: { end: number; began: number; similarOk: boolean } | null = null;
  if (d.status === "sending") {
    // A try is on this row: in flight, or its outcome was never learned. Nothing is sent before Sent was searched for it.
    const began = Date.parse(d.sent_at ?? "") || o.now, end = endedAt(d);
    const c = await check(began);
    if (c.status === "found") return await found(d, c);
    if (o.answer === "no") return waiting(`I can't take that reply back: it is unconfirmed whether it already went to ${to}. Nothing more will be sent unless you say yes.`, UNKNOWN_OUTCOME);
    if (c.status === "unknown") return unconfirmed(squash(c.detail).slice(0, 120) || "your Sent mail could not be searched");
    if (end === null) return unconfirmed("that try has not finished, or its end was never recorded, so it is never tried again from this card");
    if (o.now - end < UNKNOWN_SETTLE_MS) return unconfirmed("it is not in your Sent mail yet, and the try ended moments ago");
    if (c.status === "similar" && o.meta.mail_reply.ack_similar !== true) return similar();
    // Not in Sent, minutes after the try ended: it did not go. The card waits again, and this yes (to the same exact card) goes on.
    const back: OutreachDraft = { ...d, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: "not in Sent after an unanswered try" };
    if (!(await s.update(o.userId, back, { status: "sending" }))) return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
    d = back; retry = { end, began, similarOk: c.status === "similar" };
  }
  if (d.status === "approved") {
    // An approval a failed claim left behind (no run sends this kind). One written moments ago is another yes still at work.
    if (o.now - (Date.parse(d.approved_at ?? "") || 0) < 60_000) return waiting(`That reply to ${to} is being handled right now; nothing more was sent. Say yes again in a minute if it has not gone.`, "in_progress");
    const back: OutreachDraft = { ...d, status: "shown", approved_hash: null, approved_at: null };
    if (!(await s.update(o.userId, back, { status: "approved" }))) return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
    d = back;
  }
  if (d.status !== "shown") return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
  if (Date.parse(d.created_at) < o.now - DAY) return done("That reply is more than a day old, so nothing was sent. Ask me to draft it again.", "expired");
  if (o.answer === "no") { await s.update(o.userId, { ...d, status: "skipped" }, { status: "shown" }); return done("Dropped. Nothing was sent.", "declined"); }
  const m = messageOf(d), h = await replyHash(p), c = o.meta.mail_reply, from = p.from;
  const changed = () => done("Not sent: the reply changed after you saw it, so your yes was not for this version.", "changed");
  // The row must still be the card: its own hash, and the hash and text the card itself carried when it was shown.
  // Nothing rides on the row that the card did not show: no field beyond a reply's own, nothing attached.
  if (Object.keys(d.recipient).some((k) => !ROW_FIELDS.has(k)) || (d.shared ?? []).length) return changed();
  if (h !== d.hash || c.hash !== h || c.text !== m.text || !MESSAGE_ID.test(p.in_reply_to) || to !== c.to || p.subject !== c.subject || p.in_reply_to !== c.in_reply_to || p.thread_id !== (c.thread_id ?? null) || from !== (c.from_mailbox ?? null)) return changed();
  if (!o.deps.sendOn) return waiting("Not sent: sending email is switched off in Trainee right now. Copy the reply above into your own email.", "SEND_OFF");
  if (o.deps.accounts) {
    const mine = (await o.deps.accounts(o.userId).catch(() => [] as string[])).map((a) => String(a).toLowerCase());
    if (from ? !mine.includes(from) : mine.length > 1) return waiting(`Not sent: ${from ? `${from} is not one of your connected Google accounts that may send` : "this card does not say which of your Google accounts to send from"}, so nothing went to ${to}. Ask me to draft the reply again and say which account to use.`, "NOT_WIRED");
  }
  if (!(await o.deps.canSend(o.userId, from).catch(() => false))) {
    const allow = o.deps.sendConsent ? await o.deps.sendConsent(o.userId).catch(() => null) : null;
    return waiting(`Not sent: your Google connection lets Trainee read your mail, not send it.${allow ? ` To send from your Gmail, allow sending (you sign in to Google yourself): ${allow} then say yes again.` : ""} Or copy the reply above into your own email.`, "NOT_WIRED");
  }
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
  if (retry) {
    // A second try of this card: Sent is searched once more, now, with the row already claimed (no other yes can act on it).
    const again = await check(retry.began);
    if (again.status === "found") return await found(sending, again);
    if (again.status !== "absent" && !(again.status === "similar" && retry.similarOk)) {
      await s.update(o.userId, { ...sending, result: unknownResult(retry.end, "Sent could not be confirmed empty before a second try") }, { status: "sending" });
      return again.status === "similar" ? similar() : unconfirmed(squash(again.detail).slice(0, 120) || "your Sent mail could not be searched");
    }
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
  // No answer, a timeout, a 5xx: Gmail may have taken it. The row stays claimed ("sending") with the time the try ended, so
  // nothing can send it again before the window after that end; Sent is searched now, and again at the next yes.
  const why = squash(r.detail ?? r.reason ?? r.status).slice(0, 100) || "no answer from Gmail";
  sending = { ...sending, result: unknownResult(ended, why) };
  await s.update(o.userId, sending, { status: "sending" });
  const now = await check(o.now);
  if (now.status === "found") return await found(sending, now);
  return unconfirmed(why);
}
