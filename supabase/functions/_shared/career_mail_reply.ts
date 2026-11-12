// D-062 (2) (owner, 2026-11-11: "be able to answer emails ... not gmail read, but gmail read and send"): the person asks Trainee
// to reply to an email in their own inbox. Three steps, each its own guard:
//   read    the person's connected Gmail (the career grant's gmail.readonly): a search of their inbox (sender, subject, date and
//           Gmail's snippet), and the plain text of the ONE email they chose to answer (capped). Nothing else is read.
//   card    the brain writes the reply's words (draft_email_reply); code checks them (followup_draft.ts checkFollowup: no invented
//           meeting, offer or relationship, no figure or name outside the person's words, their confirmed facts and the email being
//           answered) and builds the exact message: To is that email's own Reply-To or From address (never guessed; an automated
//           no-reply inbox gets no card), the subject "Re: <its subject>", the body and the person's signature. It is saved as one
//           outreach draft whose SHA-256 over [to, subject, text] is the approval's only key (D-MN-2), and shown word for word.
//   yes     while that card is the thread's last word (career_inbox_followups.ts followupTurn): a yes sends exactly that message
//           once, from the person's own Gmail (gmail.send, CAREER_EMAIL_SEND and CAREER_SEND_RAIL on), threaded to the email it
//           answers; a changed message, an old card, a paused account or a do-not-contact address sends nothing. No yes, nothing.
// Trainee never sends from its own identity, never Cc or Bcc, never to more than one address.
import { automatedInbox } from "./automated_inbox.ts";
import { checkFollowup } from "./followup_draft.ts";
import { dayStartOf, type Message, messageOf, type OutreachDraft, type OutreachStore, payloadHash } from "./career_outreach.ts";
import { MESSAGE_ID, ONE_ADDRESS, type Threading } from "./career_outreach_gmail.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const MAIL_REPLY_CARD_INTENT = "career_mail_reply_card";
export const MAIL_REPLY_ANSWER_INTENT = "career_mail_reply_answer";
export const BODY_MAX = 3000;

// account (D-062): the person's Gmail address the email reached; ref is "<gmail id>~<account>" so a later read asks the same account.
export interface InboxMail { ref: string; account: string | null; thread_id: string | null; from: string; from_name: string; reply_to: string | null; subject: string; date: string; snippet: string; message_id: string | null }
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
          mails.push(mailOf(await g.json().catch(() => ({})), account));
        }
      }
      if (!wired) return { status: "NOT_WIRED" };
      mails.sort((a, b) => b.date.localeCompare(a.date));
      return { status: "ok", mails: mails.slice(0, max), ...(all.length ? { accounts: all } : {}) };
    },
    // The one email the person chose, with its plain text, from the account it reached.
    async read(userId: string, ref: string): Promise<{ status: "ok"; mail: InboxMail; text: string } | { status: "NOT_WIRED" } | { status: "ERROR"; detail: string } | { status: "missing" }> {
      const p = parseRef(ref);
      if (!p) return { status: "missing" };
      const token = await d.token(userId, p.account);
      if (!token) return { status: "NOT_WIRED" };
      const g = await get(`${API}/${encodeURIComponent(p.id)}?format=full`, token);
      if (g.status === 404) return { status: "missing" };
      if (!g.ok) return { status: "ERROR", detail: `read the email: HTTP ${g.status}` };
      const m = await g.json().catch(() => ({}));
      if ((m?.labelIds ?? []).includes("SENT")) return { status: "missing" };
      return { status: "ok", mail: mailOf(m, p.account), text: plainText(m?.payload) || squash(m?.snippet) };
    },
  };
}
export type Inbox = ReturnType<typeof inboxReader>;

// What the card waits on (the assistant message's meta, written by the handler from the tool's show.meta).
// from_mailbox (D-062): the person's account the reply is sent from (by default the one the email reached). Shown on the card,
// kept on the draft (recipient.source) and checked again at the yes.
export interface ReplyCardMeta { mail_reply_card: string; mail_reply: { to: string; subject: string; in_reply_to: string; thread_id: string | null; from_name: string; from_mailbox?: string | null } }
const sourceFor = (from: string | null) => `reply to their email${from ? `, from ${from}` : ""}`;
export const replySubject = (s: string) => (/^\s*re\s*:/i.test(s) ? squash(s) : `Re: ${squash(s) || "your email"}`).slice(0, 200);

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
  // D-062: the person's own choice of account to send from; absent, the account the email reached.
  sendFrom?: string | null; accounts?: string[];
}): Promise<ReplyDraftOut> {
  const got = await o.inbox.read(o.userId, o.ref);
  if (got.status === "NOT_WIRED") return { status: "refused", reason: "gmail_not_connected", note: "No Gmail that Trainee may read is connected, so there is no email to answer. Say so and that they connect Gmail themselves (they sign in to Google); nothing was drafted or sent." };
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
  const want = o.sendFrom ? String(o.sendFrom).trim().toLowerCase() : null;
  if (want && !(o.accounts ?? []).includes(want)) return { status: "refused", reason: "not_your_account", note: `${want} is not one of the person's connected accounts (${(o.accounts ?? []).join(", ") || "none"}). Ask which of those to send from; nothing was drafted or sent.` };
  const from = want ?? got.mail.account ?? null;
  const signature = squash(o.signature);
  if (!signature) return { status: "refused", reason: "no_signature", note: "Ask how they sign their emails (say \"sign as\" and their name); nothing was drafted or sent." };
  const base = { n: 1, recipient: { name: mail.from_name.slice(0, 120) || to, firm: "", title: "", school: "", email: to, source: sourceFor(from) },
    subject: replySubject(mail.subject), body: checked.body.trim().slice(0, 4000), footer: signature.slice(0, 300), shared: [], status: "shown" as const,
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(o.now).toISOString() };
  const m = messageOf(base), hash = await payloadHash(m);
  const [d] = await o.outreach.saveBatch(o.userId, o.threadId, [{ ...base, hash }], o.now);
  const sends = await o.canSend(from).catch(() => false);
  // A reply sent from another account than the one the email reached starts a new thread there (Gmail threads per mailbox).
  const thread = from && got.mail.account && from !== got.mail.account ? null : mail.thread_id;
  const meta: ReplyCardMeta = { mail_reply_card: d.id, mail_reply: { to, subject: m.subject, in_reply_to: mail.message_id, thread_id: thread, from_name: mail.from_name, from_mailbox: from } };
  return { status: "ok", show: { intent: MAIL_REPLY_CARD_INTENT, text: replyCardText(m, { from_name: mail.from_name, original_subject: mail.subject, sends, from }), meta: { ...meta } }, to, subject: m.subject, hash,
    note: "The card with the exact reply is shown to the person by code. Nothing is sent until they say yes to it." };
}

// The yes or no to the card (followupTurn calls this while the card is the thread's last word).
export interface ReplyAnswerDeps {
  outreach: OutreachStore; sendOn: boolean; canSend: (userId: string, from?: string | null) => Promise<boolean>;
  send: (userId: string, m: Message, t?: Threading | null) => Promise<{ status: string; id?: string; thread_id?: string; detail?: string; reason?: string }>;
  sendConsent?: (userId: string) => Promise<string | null>;
}
const DAY = 86_400_000;
const ADMIT: Record<string, string> = { not_approved: "the approval was not recorded", changed: "the email changed after you saw it", expired: "the approval is too old",
  paused: "your account is paused", do_not_contact: "that address asked not to be contacted", bad_address: "that address bounced before", on_rail: "it is already on its way" };
export async function replyAnswer(o: { userId: string; now: number; answer: "yes" | "no"; meta: ReplyCardMeta; deps: ReplyAnswerDeps }): Promise<{ reply: string; status: string; intent: string; meta?: Record<string, unknown> }> {
  const done = (reply: string, status: string) => ({ reply, status, intent: MAIL_REPLY_ANSWER_INTENT });
  const waiting = (reply: string, status: string) => ({ reply, status, intent: MAIL_REPLY_CARD_INTENT, meta: { ...o.meta } as Record<string, unknown> });
  const s = o.deps.outreach, id = o.meta.mail_reply_card;
  const d: OutreachDraft | undefined = (await s.latestBatch(o.userId)).find((x) => x.id === id);
  if (!d) return done("That reply is no longer on record, so nothing was sent.", "missing");
  if (d.status === "sent") return done("That reply was already sent; nothing more went.", "already_sent");
  if (d.status !== "shown") return done("That reply is not waiting for a yes any more, so nothing was sent.", "not_waiting");
  if (Date.parse(d.created_at) < o.now - DAY) return done("That reply is more than a day old, so nothing was sent. Ask me to draft it again.", "expired");
  if (o.answer === "no") { await s.update(o.userId, { ...d, status: "skipped" }, { status: "shown" }); return done("Dropped. Nothing was sent.", "declined"); }
  const m = messageOf(d), h = await payloadHash(m);
  const from = o.meta.mail_reply.from_mailbox ?? null;
  if (h !== d.hash || m.to !== o.meta.mail_reply.to || m.subject !== o.meta.mail_reply.subject || (from && d.recipient.source !== sourceFor(from))) return done("Not sent: the reply changed after you saw it, so your yes was not for this version.", "changed");
  if (!o.deps.sendOn) return waiting("Not sent: sending email is switched off in Trainee right now. Copy the reply above into your own email.", "SEND_OFF");
  if (!(await o.deps.canSend(o.userId, from).catch(() => false))) {
    const allow = o.deps.sendConsent ? await o.deps.sendConsent(o.userId).catch(() => null) : null;
    return waiting(`Not sent: your Google connection lets Trainee read your mail, not send it.${allow ? ` To send from your Gmail, allow sending (you sign in to Google yourself): ${allow} then say yes again.` : ""} Or copy the reply above into your own email.`, "NOT_WIRED");
  }
  const at = new Date(o.now).toISOString();
  const approved: OutreachDraft = { ...d, status: "approved", approved_hash: h, approved_at: at };
  if (!(await s.update(o.userId, approved, { status: "shown", hash: h }))) return done("Not sent: the reply changed after you saw it, so your yes was not for this version.", "changed");
  const admit = await s.claim(o.userId, approved, h, o.now, dayStartOf(o.now));
  if (admit !== "ok") {
    await s.update(o.userId, { ...approved, status: "shown", approved_hash: null, approved_at: null, result: admit }, { status: "approved" });
    return waiting(`Not sent: ${ADMIT[admit] ?? admit}. Nothing went to ${m.to}.`, admit);
  }
  const sending: OutreachDraft = { ...approved, status: "sending", sent_at: at };
  const r = await o.deps.send(o.userId, m, { inReplyTo: o.meta.mail_reply.in_reply_to, threadId: o.meta.mail_reply.thread_id, from })
    .catch((e): { status: string; id?: string; thread_id?: string; detail?: string; reason?: string } => ({ status: "ERROR", detail: e instanceof Error ? e.message : String(e) }));
  if (r.status === "sent") {
    await s.update(o.userId, { ...sending, status: "sent", gmail_id: r.id ?? null, gmail_thread: r.thread_id ?? null, result: "sent" }, { status: "sending" });
    return done(`Sent to ${m.to} from ${from ?? "your Gmail"}${o.meta.mail_reply.thread_id ? ", in that email's thread" : ""}, exactly as shown.`, "sent");
  }
  await s.update(o.userId, { ...sending, status: "shown", approved_hash: null, approved_at: null, sent_at: null, result: `${r.status}: ${squash(r.detail ?? r.reason)}`.slice(0, 200) }, { status: "sending" });
  if (r.status === "NOT_WIRED") return waiting(`Not sent: your Google connection doesn't let Trainee send email, so nothing went to ${m.to}.`, "NOT_WIRED");
  if (r.status === "RATE_LIMITED") return waiting(`Not sent: Gmail asked Trainee to slow down. Nothing went to ${m.to}; say yes again in a few minutes.`, "rate_limited");
  return waiting(`Not sent: Gmail refused it (${squash(r.detail).slice(0, 120)}). Nothing went to ${m.to}; say yes to try once more.`, "refused");
}
