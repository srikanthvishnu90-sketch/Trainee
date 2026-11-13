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
import { redactSecrets, securityMail } from "./mail_security.ts";
import { MESSAGE_ID, ONE_ADDRESS, type Threading } from "./career_outreach_gmail.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const MAIL_REPLY_CARD_INTENT = "career_mail_reply_card";
export const MAIL_REPLY_ANSWER_INTENT = "career_mail_reply_answer";
export const BODY_MAX = 3000;

// account (D-062): the person's Gmail address the email reached; ref is "<gmail id>~<account>" so a later read asks the same account.
// security: a one-time code, sign-in, password or account-security email: found, and its subject, snippet and text withheld.
export interface InboxMail { ref: string; account: string | null; thread_id: string | null; from: string; from_name: string; reply_to: string | null; subject: string; date: string; snippet: string; message_id: string | null; security?: true }
const guarded = (mail: InboxMail, text: string): InboxMail => securityMail({ from: mail.from, subject: mail.subject, text: `${mail.snippet}\n${text}` })
  ? { ...mail, subject: "", snippet: "", security: true } : { ...mail, subject: redactSecrets(mail.subject), snippet: redactSecrets(mail.snippet) };
export type InboxRead = { status: "ok"; mails: InboxMail[] } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string };
// D-062: token for one account (null: the first grant); accounts: every Google account the person connected (absent: the first grant only).
export interface InboxDeps { fetch: typeof fetch; token: (userId: string, account: string | null) => Promise<string | null>; accounts?: (userId: string) => Promise<{ mailbox: string; can_read: boolean; can_send: boolean }[]> }
const refOf = (id: string, account: string | null) => (account ? `${id}~${account}` : id);
const parseRef = (ref: string): { id: string; account: string | null } | null => {
  const m = /^([A-Za-z0-9_-]{1,64})(?:~([a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}))?$/i.exec(String(ref ?? "").trim());
  return m ? { id: m[1], account: m[2] ? m[2].toLowerCase() : null } : null;
};

const squash = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const header = (msg: any, name: string) => String((msg?.payload?.headers ?? []).find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");
const addressIn = (v: string) => { const m = /<([^<>\s]+@[^<>\s]+)>/.exec(v) ?? /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(v); return m ? m[1].toLowerCase() : ""; };
const nameIn = (v: string) => squash(v.replace(/<[^>]*>/g, "").replace(/"/g, "")).slice(0, 80);
const decode = (s: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return ""; } };
// The text/plain part of a message (format=full), quoted history dropped, capped.
export function plainText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; if (/^text\/plain/i.test(String(p.mimeType ?? "")) && p.body?.data) parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  const text = parts.map((p) => decode(String(p.body.data))).join("\n");
  const cut = text.split(/\r?\n(?:On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|>)/)[0];
  return cut.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, BODY_MAX);
}
const mailOf = (m: any, account: string | null = null): InboxMail => {
  const from = header(m, "From"), rt = addressIn(header(m, "Reply-To"));
  const mid = squash(header(m, "Message-ID") || header(m, "Message-Id"));
  return { ref: refOf(String(m?.id ?? ""), account), account, thread_id: m?.threadId ? String(m.threadId) : null, from: addressIn(from), from_name: nameIn(from), reply_to: rt || null, subject: squash(header(m, "Subject")).slice(0, 200),
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

// Whether one exact message is in the account's Sent mail: by its own Message-ID, and (should Gmail have rewritten that header)
// by a sent message to the same address since the try with the same In-Reply-To and subject. "unknown": the search itself failed.
export type SentCheck = { status: "found"; id: string; thread_id: string | null } | { status: "absent" } | { status: "unknown"; detail: string };
export interface SentQuery { from: string | null; messageId: string; to: string; subject: string; inReplyTo: string; since: number }
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
      for (const c of await list(`in:sent to:${q.to} after:${Math.floor(q.since / 1000) - 120}`)) {
        const g = await d.fetch(`${API}/${encodeURIComponent(c.id)}?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID`, { headers: { Authorization: `Bearer ${token}` } });
        if (!g.ok) throw new Error(`read a sent message: HTTP ${g.status}`);
        const m = await g.json();
        if (squash(header(m, "Message-ID")) === q.messageId || (squash(header(m, "In-Reply-To")) === q.inReplyTo && squash(header(m, "Subject")) === squash(q.subject))) return { status: "found", ...c };
      }
      return { status: "absent" };
    } catch (e) { return { status: "unknown", detail: e instanceof Error ? e.message : String(e) }; }
  };
}

// What the card waits on (the assistant message's meta, written by the handler from the tool's show.meta).
// from_mailbox (D-062): the person's account the reply is sent from (by default the one the email reached). Shown on the card,
// kept on the row (recipient.reply, written once) and inside the hash; the yes sends what the row holds, and only when the card's
// meta says the same.
export interface ReplyCardMeta { mail_reply_card: string; mail_reply: { to: string; subject: string; in_reply_to: string; thread_id: string | null; from_name: string; from_mailbox?: string | null } }
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
// Whether the person, in their own message this turn, chose `want` to send from: they wrote the address, or they said "my other
// account" and have exactly two (the other one is then not a choice anyone made for them).
function personChose(said: string, want: string, reached: string | null, accounts: string[]): boolean {
  const t = String(said ?? "").toLowerCase();
  if (t.includes(want)) return true;
  return accounts.length === 2 && !!reached && accounts.includes(reached) && want !== reached && /\b(?:other|another|different|second)\b/.test(t);
}

// The card's exact text. Code shows the message it will send, word for word, and what a yes does.
export function replyCardText(m: Message, o: { from_name: string; original_subject: string; sends: boolean; from?: string | null }): string {
  const tail = o.sends
    ? `Nothing is sent until you say yes, and a yes sends exactly this, once, from ${o.from ?? "your Gmail"}, as a reply in that email's thread. Say no to drop it, or tell me what to change${o.from ? " (or which of your accounts to send it from)" : ""}.`
    : "Trainee can't send from your Gmail yet (sending isn't allowed on your Google connection), so nothing will be sent; copy it into your own reply, or allow sending and ask again.";
  return [`Reply to ${o.from_name || m.to} ("${o.original_subject}"), not sent:`, ...(o.from ? [`From: ${o.from}`] : []), `To: ${m.to}`, `Subject: ${m.subject}`, "", m.text, "", tail].join("\n");
}

export type ReplyDraftOut =
  | { status: "ok"; show: { intent: string; text: string; meta: Record<string, unknown> }; to: string; subject: string; hash: string; note: string }
  | { status: "rewrite"; problems: string[]; note: string } | { status: "refused"; reason: string; note: string };
// Builds and saves the card for the one email being answered. The brain wrote `body`; code decides whether it may be shown.
export async function draftReply(o: {
  userId: string; threadId: string; now: number; inbox: Inbox; outreach: OutreachStore; ref: string; body: string;
  said: string; facts: string[]; signature: string | null; canSend: (from: string | null) => Promise<boolean>;
  // D-062: the account to send from, honoured only when the person's own message this turn chose it (personChose); absent, the
  // account the email reached. accounts: every Google account the person connected.
  sendFrom?: string | null; accounts?: string[];
}): Promise<ReplyDraftOut> {
  const got = await o.inbox.read(o.userId, o.ref);
  if (got.status === "NOT_WIRED") return { status: "refused", reason: "gmail_not_connected", note: "No Gmail that Trainee may read is connected, so there is no email to answer. Say so and that they connect Gmail themselves (they sign in to Google); nothing was drafted or sent." };
  if (got.status === "security") return { status: "refused", reason: "security_mail", note: `That is a security email from ${got.mail.from || "an automated sender"} (a code, sign-in or account notice): it was not read and is not answered. Say so; nothing was drafted or sent.` };
  if (got.status !== "ok") return { status: "refused", reason: got.status === "missing" ? "email_not_found" : "read_failed", note: "That email could not be read. Use find_email to find it again; nothing was drafted or sent." };
  const mail = got.mail, to = (mail.reply_to || mail.from).toLowerCase();
  if (!ONE_ADDRESS.test(to)) return { status: "refused", reason: "no_address", note: "That email has no single reply address, so no reply can be sent. Say so; nothing was drafted or sent." };
  if (automatedInbox(to)) return { status: "refused", reason: "automated_inbox", note: `${to} is an automated no-reply inbox: a reply there reaches no one. Say so; nothing was drafted or sent.` };
  if (!mail.message_id) return { status: "refused", reason: "no_message_id", note: "That email can't be replied to in its thread. Say so; nothing was drafted or sent." };
  const checked = checkFollowup({ kind: "note", recipient: mail.from_name || null, recipient_options: [], document: null, documents: [], body: String(o.body ?? ""), tone: null },
    { said: [o.said, mail.from_name, mail.subject, got.text].join("\n"), facts: o.facts });
  if (checked.status === "rewrite") return { status: "rewrite", problems: checked.problems, note: checked.note };
  if (checked.status === "ask") return { status: "rewrite", problems: [checked.note], note: checked.note };
  if (/\[[^\]\n]{1,40}\]/.test(checked.body)) return { status: "rewrite", problems: ["a placeholder in brackets is left in the reply"], note: "A reply that will be sent can't keep a placeholder: write the words, or ask the person for the one thing missing." };
  // The sending account is never a guess: the account the email reached, or the one the person's own words chose; with several
  // accounts and neither, the person is asked. Never "the first one".
  const accounts = (o.accounts ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean), reached = got.mail.account ? got.mail.account.toLowerCase() : null;
  const listed = accounts.join(", ") || "none";
  const want = o.sendFrom ? String(o.sendFrom).trim().toLowerCase() : null;
  if (want && !accounts.includes(want)) return { status: "refused", reason: "not_your_account", note: `${want} is not one of the person's connected accounts (${listed}). Ask which of those to send from; nothing was drafted or sent.` };
  if (want && want !== reached && !personChose(o.said, want, reached, accounts)) return { status: "refused", reason: "confirm_account", note: `The person's message did not name ${want}. Ask which of their accounts to send this reply from (${listed}); nothing was drafted or sent. Leave send_from out to send from the account the email reached${reached ? ` (${reached})` : ""}.` };
  const from = want ?? reached ?? (accounts.length === 1 ? accounts[0] : null);
  if (!from && accounts.length > 1) return { status: "refused", reason: "which_account", note: `It is not known which of the person's accounts this email reached. Ask which to send the reply from (${listed}); nothing was drafted or sent.` };
  if (from && accounts.length && !accounts.includes(from)) return { status: "refused", reason: "not_your_account", note: `${from} is no longer one of the person's connected accounts (${listed}). Ask which of those to send from; nothing was drafted or sent.` };
  const signature = squash(o.signature);
  if (!signature) return { status: "refused", reason: "no_signature", note: "Ask how they sign their emails (say \"sign as\" and their name); nothing was drafted or sent." };
  // A reply sent from another account than the one the email reached starts a new thread there (Gmail threads per mailbox).
  const thread = from && reached && from !== reached ? null : mail.thread_id;
  const base = { n: 1, recipient: { name: mail.from_name.slice(0, 120) || to, firm: "", title: "", school: "", email: to, source: sourceFor(from), kind: "mail_reply" as const, reply: { from, in_reply_to: mail.message_id, thread_id: thread } },
    subject: replySubject(mail.subject), body: checked.body.trim().slice(0, 4000), footer: signature.slice(0, 300), shared: [], status: "shown" as const,
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  const m = messageOf(base), hash = await replyHash({ from, to: m.to, subject: m.subject, text: m.text, in_reply_to: mail.message_id, thread_id: thread });
  const [d] = await o.outreach.saveBatch(o.userId, o.threadId, [{ ...base, hash }], o.now);
  const sends = await o.canSend(from).catch(() => false);
  const meta: ReplyCardMeta = { mail_reply_card: d.id, mail_reply: { to, subject: m.subject, in_reply_to: mail.message_id, thread_id: thread, from_name: mail.from_name, from_mailbox: from } };
  return { status: "ok", show: { intent: MAIL_REPLY_CARD_INTENT, text: replyCardText(m, { from_name: mail.from_name, original_subject: mail.subject, sends, from }), meta: { ...meta } }, to, subject: m.subject, hash,
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
// How long after a try with no answer Sent must still not hold the message before it may be tried again.
export const UNKNOWN_SETTLE_MS = 120_000;
export const UNKNOWN_OUTCOME = "unknown_outcome";
const ADMIT: Record<string, string> = { not_approved: "the approval was not recorded", changed: "the email changed after you saw it", expired: "the approval is too old",
  paused: "your account is paused", do_not_contact: "that address asked not to be contacted", bad_address: "that address bounced before", on_rail: "it is already on its way" };
type Answer = { reply: string; status: string; intent: string; meta?: Record<string, unknown> };
export async function replyAnswer(o: { userId: string; now: number; answer: "yes" | "no"; meta: ReplyCardMeta; deps: ReplyAnswerDeps }): Promise<Answer> {
  const done = (reply: string, status: string): Answer => ({ reply, status, intent: MAIL_REPLY_ANSWER_INTENT });
  const waiting = (reply: string, status: string): Answer => ({ reply, status, intent: MAIL_REPLY_CARD_INTENT, meta: { ...o.meta } as Record<string, unknown> });
  const s = o.deps.outreach, id = o.meta.mail_reply_card;
  let d: OutreachDraft | undefined = (s.drafts ? await s.drafts(o.userId, [id]) : []).find((x) => x.id === id);
  if (!d || !isMailReply(d)) return done("That reply is no longer on record, so nothing was sent.", "missing");
  if (d.status === "sent") return done("That reply was already sent; nothing more went.", "already_sent");
  const p = payloadOf(d), to = p.to, mid = replyMessageId(d);
  const query: SentQuery = { from: p.from, messageId: mid, to, subject: p.subject, inReplyTo: p.in_reply_to, since: Date.parse(d.sent_at ?? "") || o.now };
  const unconfirmed = (why: string) => waiting(`Unconfirmed: I can't tell whether your reply to ${to} was sent (${why}). It may have gone. I have not tried again, and won't until your Sent mail shows it isn't there. Say yes and I'll check Sent first; you can also look in your Sent folder.`, UNKNOWN_OUTCOME);
  const found = async (row: OutreachDraft, f: { id: string; thread_id: string | null }) => {
    await s.update(o.userId, { ...row, status: "sent", gmail_id: f.id, gmail_thread: f.thread_id, result: "sent (found in Sent)" }, { status: "sending" });
    return done(`Your reply to ${to} is in your Sent mail${p.from ? ` (${p.from})` : ""}: it went once, exactly as shown. Nothing more was sent.`, "sent");
  };
  if (d.status === "sending") {
    // A try is on this row: in flight, or its outcome was never learned. Nothing is sent before Sent was searched for it.
    if (o.answer === "no") return waiting(`I can't take that reply back: it is unconfirmed whether it already went to ${to}. Nothing more will be sent unless you say yes.`, UNKNOWN_OUTCOME);
    const c: SentCheck = o.deps.findSent ? await o.deps.findSent(o.userId, query).catch((e): SentCheck => ({ status: "unknown", detail: e instanceof Error ? e.message : String(e) })) : { status: "unknown", detail: "your Sent mail can't be checked from here" };
    if (c.status === "found") return await found(d, c);
    if (c.status === "unknown") return unconfirmed(squash(c.detail).slice(0, 120));
    if (o.now - query.since < UNKNOWN_SETTLE_MS) return unconfirmed("it is not in your Sent mail yet, and the try was moments ago");
    // Not in Sent, minutes after the try: it did not go. The card waits again, and this yes (to the same exact card) goes on.
    const back: OutreachDraft = { ...d, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: "not in Sent after an unanswered try" };
    if (!(await s.update(o.userId, back, { status: "sending" }))) return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
    d = back;
  }
  if (d.status === "approved") {
    // An approval a failed claim left behind (no run sends this kind): the card waits again, as it did.
    const back: OutreachDraft = { ...d, status: "shown", approved_hash: null, approved_at: null };
    if (!(await s.update(o.userId, back, { status: "approved" }))) return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
    d = back;
  }
  if (d.status !== "shown") return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
  if (Date.parse(d.created_at) < o.now - DAY) return done("That reply is more than a day old, so nothing was sent. Ask me to draft it again.", "expired");
  if (o.answer === "no") { await s.update(o.userId, { ...d, status: "skipped" }, { status: "shown" }); return done("Dropped. Nothing was sent.", "declined"); }
  const m = messageOf(d), h = await replyHash(p), c = o.meta.mail_reply, from = p.from;
  const changed = () => done("Not sent: the reply changed after you saw it, so your yes was not for this version.", "changed");
  if (h !== d.hash || !MESSAGE_ID.test(p.in_reply_to) || to !== c.to || p.subject !== c.subject || p.in_reply_to !== c.in_reply_to || p.thread_id !== (c.thread_id ?? null) || from !== (c.from_mailbox ?? null)) return changed();
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
  const sending: OutreachDraft = { ...approved, status: "sending", sent_at: at };
  query.since = o.now;
  const r = await o.deps.send(o.userId, m, { inReplyTo: p.in_reply_to, threadId: p.thread_id, from, messageId: mid })
    .catch((e): { status: string; id?: string; thread_id?: string; detail?: string; reason?: string; not_sent?: boolean } => ({ status: "ERROR", detail: e instanceof Error ? e.message : String(e) }));
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
  // No answer, a timeout, a 5xx: Gmail may have taken it. The row stays claimed ("sending"), so nothing can send it again; Sent
  // is searched now, and again at the next yes.
  const why = squash(r.detail ?? r.reason ?? r.status).slice(0, 120) || "no answer from Gmail";
  await s.update(o.userId, { ...sending, result: `${UNKNOWN_OUTCOME}: ${why}`.slice(0, 200) }, { status: "sending" });
  const now: SentCheck = o.deps.findSent ? await o.deps.findSent(o.userId, query).catch((): SentCheck => ({ status: "unknown", detail: "" })) : { status: "unknown", detail: "" };
  if (now.status === "found") return await found(sending, now);
  return unconfirmed(why);
}
