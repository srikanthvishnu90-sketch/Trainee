import { CARD_NEEDS_REPLY_STATUS, needsReplyTextFor } from "./career_apply_cards.ts";
// Texts coming in, on any channel (WO-038; first written for LoopMessage in WO-013b-2, whose order it keeps): the
// message id claimed per provider (a retried webhook never runs a second turn), the person found by the contact (or its
// alias), the time of their message recorded (it opens WhatsApp's window and makes this their most recent channel; held
// messages go back in the queue), STOP/START/HELP answered before any account exists, linking a second channel, who may
// sign up, then the turn through agent-chat as that person. The brain never learns the channel: the reply rides the
// outbox bound to the channel the message came in on, and the adapter renders it.
//
// Linking never trusts message text alone:
// - Telegram: "/start <nonce>" binds the chat only when the nonce was issued to a signed-in account (the app's Connect
//   Telegram, or "connect telegram" texted on a channel already linked), unused, under 10 minutes old; stored hashed.
//   TELEGRAM LINK OWNERSHIP (2026-10-31): and only on a YES from the account's own channel. Opening the link proves nothing
//   about who opened it (it may be forwarded, pasted or leaked): it asks the channel the person already uses, and the new
//   chat stays no one's (no private data, no approvals) until that YES (20261031040000_telegram_link_confirm.sql).
// - Same phone on another channel (WhatsApp and iMessage): nothing is merged. The channel already linked is asked, and only
//   a yes from it links the new one.
import { channelCommand, CHANNEL_REPLIES } from "./channel.ts";
import { fitOutbox as fitReply, normalizeContact, OUTBOX_CHARS } from "./conversation.ts";
import { type Channel, CHANNEL_NAME, channelOf, type ChannelAdapter, type InboundMessage, packMessages, type Provider, type SendOptions, type StatusEvent } from "./channel_adapters.ts";
import { telegramDeepLink } from "./telegram.ts";
import { deliverShaped, type ShapedFile } from "./channel_shape.ts";
import { safeCut } from "./channel_text.ts";
import { redactIdentity } from "./identity_redact.ts";
import { ackFor, ackOnce, typingLoop } from "./channel_voice.ts";
import { ACK_REACTION, slowWork } from "./telegram_brief.ts";

export const SIGNUP_CLOSED_REPLY = "Trainee is invite-only right now, so I can't set you up yet. Nothing about you was saved except that you texted.";
// PHONE LOGIN (owner, 2026-10-28): Telegram's own verified number, shared with one tap. Trainee never asks for a password or a
// code in chat.
export const SHARE_PHONE_BUTTON = "Share my phone number";
export const SHARE_PHONE_ASK = "You can also share your phone number with the button below. Telegram has already verified it, so there is no password or code to type, and I never ask for either in chat.";
export const PHONE_NOT_YOURS_REPLY = "That's someone else's contact, so I can't use it. Tap the button to share your own number.";
export const PHONE_ALREADY_REPLY = "This chat is already linked to your Trainee account, so nothing changed.";
export const PHONE_NO_ACCOUNT_REPLY = "Thanks. I don't have a Trainee account with that number yet. If you use Trainee on iMessage or WhatsApp with this number, text me there; otherwise sign in with the link below.";
export const CHAT_DOWN_REPLY = "I couldn't answer that just now. Try again in a minute.";
// The owner's wording for the question on the channel already linked (WO-038).
export const linkAskText = (newChannel: Channel) => `Someone texted Trainee on ${CHANNEL_NAME[newChannel]} from your number. Reply yes to link it.`;
export const linkPendingReply = (linkedOn: Channel) => `This number already has a Trainee account on ${CHANNEL_NAME[linkedOn]}. Reply yes there and this chat is linked to it.`;
export const linkedReply = (newChannel: Channel) => `Done: ${CHANNEL_NAME[newChannel]} is linked to your Trainee account. Trainee answers on whichever one you text.`;
export const LINKED_HERE_REPLY = "This chat is linked to your Trainee account now. Text here any time.";
// IDENTITY SCENARIOS (2026-10-30): the number's account said STOP, so a question there would be held unseen (STOP is the
// person's and holds a link question); and a number that is already an account's sign-in phone, with no channel to ask.
// Neither makes a second account for the number.
export const linkStoppedReply = (linkedOn: Channel) => `This number already has a Trainee account on ${CHANNEL_NAME[linkedOn]}, and it's stopped there, so I haven't linked this chat or made a new account. Text START on ${CHANNEL_NAME[linkedOn]}, then message me here again to link it.`;
export const PHONE_TAKEN_REPLY = "This number already belongs to a Trainee account, so I haven't made a second one, and this chat isn't linked to it. Nothing about you was saved except that you texted.";
// The store's createPerson throws this when Auth already holds the number as another account's phone (GoTrue phone_exists).
export class PhoneTakenError extends Error {
  readonly code = "phone_taken";
  constructor() { super("this number is already an account's phone"); }
}
export const isPhoneTaken = (e: unknown) => e instanceof PhoneTakenError || (!!e && typeof e === "object" && (e as { code?: unknown }).code === "phone_taken");
export const connectTelegramReply = (link: string) => `Open this link where you use Telegram and tap Start. It works once, for the next 10 minutes.\n${link}`;
export const TELEGRAM_NOT_WIRED_REPLY = "Telegram isn't set up on Trainee's side yet, so there's no link to send.";
export const ALREADY_TELEGRAM_REPLY = "This chat is already on Telegram, so there's nothing to connect.";
export const TELEGRAM_LINKED_REPLY = "Telegram is linked to your Trainee account. Text here any time; Trainee answers on whichever channel you text.";
export const TELEGRAM_LINK_INVALID_REPLY = "That link has expired or was already used. Text \"connect telegram\" to Trainee where you already use it for a new one.";
export const TELEGRAM_LINKED_ELSEWHERE_REPLY = "This Telegram account is already linked to a different Trainee account, so nothing changed.";
// TELEGRAM LINK OWNERSHIP (2026-10-31; owner rule of 2026-10-29: a forwarded or copied link must not let another person read
// the account or act as it). Opening the link asks the account's own channel; this chat is linked only on the YES there.
// Neither reply names that channel, a number or an email: whoever opened the link may not be the account's person.
export const LINK_CODE_ASK_MS = 15 * 60000; // the YES counts for 15 minutes after the question
export const telegramLinkAskText = (handle?: string | null) =>
  `Someone wants to link Telegram ${handle && /^[A-Za-z0-9_]{5,32}$/.test(handle) ? `@${handle}` : "(an account with no username)"} to your Trainee. Reply YES to allow; ignore if this wasn't you. Nothing is linked without your YES, and it counts for 15 minutes.`;
export const TELEGRAM_LINK_CONFIRM_REPLY = "Almost done. To link this chat, reply YES in the Trainee chat you already use, within 15 minutes. Until then this chat can't see or do anything in a Trainee account.";
export const TELEGRAM_LINK_WAITING_REPLY = "This chat isn't linked yet: it's waiting for a YES in the Trainee chat you already use. Until then it can't see or do anything in a Trainee account.";
export const TELEGRAM_LINK_CANT_ASK_REPLY = "I couldn't ask for a YES in the Trainee chat you already use (there isn't one, or Trainee is stopped there), so this chat isn't linked. If you stopped Trainee there, text START there, then text \"connect telegram\" for a new link.";
export const LINK_AMBIGUOUS_REPLY = "Two different chats asked to link to your Trainee account at the same time, so I linked neither. If one of them was you, text \"connect telegram\" for a new link and open it yourself.";
export const FILE_NOT_READ_REPLY = "I can't open files sent here yet, so I haven't read that one. Paste your resume as text in this chat and I'll read it now.";
// FEATURE 16 (Telegram, where a PDF or Word file is read): what a photo or a voice message is told instead.
export const PHOTO_NOT_READ_REPLY = "I can't read photos, so I haven't read that one. Send your resume as a PDF or Word file, or paste the text here.";
export const VOICE_NOT_READ_REPLY = "I can't listen to voice, audio or video messages here, so I haven't heard that one. Type it as a message and I'll answer.";
// TELEGRAM ROUND 2 (2026-10-30): the words sent with a photo, a video or a GIF are read; the picture itself is not, and the
// answer says so first.
export const MEDIA_CAPTION_NOTE = "I can't see or play what you attached, so I read only the words sent with it.";
// TELEGRAM ROUND 2: agent-chat reads at most 4,000 characters of one message; Telegram sends up to 4,096 (and a long paste
// arrives as messages of 4,096). The rest was dropped without a word (and a cut inside an emoji left half a character, which
// the database refuses). The message is cut on a whole word, and the answer says where reading stopped.
export const CHAT_MAX = 4000;
export function cutForChat(text: string, max = CHAT_MAX): { text: string; cut: boolean } {
  const t = String(text ?? "");
  if (t.length <= max) return { text: t, cut: false };
  const at = safeCut(t, max), nl = t.lastIndexOf("\n", at), sp = t.lastIndexOf(" ", at);
  const end = nl >= max * 0.75 ? nl : sp >= max * 0.75 ? sp : at;
  return { text: t.slice(0, end).trimEnd(), cut: true };
}
export function longCutNote(read: string): string {
  const words = redactIdentity(String(read ?? "")).text.trim().split(/\s+/).slice(-6).join(" ");
  let tail = words;
  if (tail.length > 60) { let i = tail.length - 60; const c = tail.charCodeAt(i); if (c >= 0xdc00 && c <= 0xdfff) i++; tail = tail.slice(i).trim(); }
  return `That message was longer than the 4,000 characters I can read at once, so I read it up to "${tail}". Send the rest as a new message and I'll read it too.`;
}
// TELEGRAM ROUND 2: a forwarded message is someone else's words: the brain reads who it came from, and the words in quotes
// (quoted speech is never taken as the person's own statement of a fact about themselves).
export function forwardedMessage(from: string, text: string, max = CHAT_MAX): { text: string; cut: boolean } {
  const head = `Forwarded from ${String(from ?? "").replace(/["\u201c\u201d]/g, "'").trim() || "someone"}:\n\u201c`;
  const body = cutForChat(String(text ?? "").replace(/["\u201c\u201d]/g, "'"), max - head.length - 1);
  return { text: `${head}${body.text}\u201d`, cut: body.cut };
}
// TELEGRAM ROUND 3 (2026-10-31): an edited message is never read again (Trainee acted on it as first sent); a decision edited
// afterwards ("yes" into "no", "ok" into "stop") was ignored without a word, and read as taken back. It is answered once.
export const EDIT_NOT_READ_REPLY = "I only read a message as it was first sent, so editing it didn't change anything I did. If you meant something else, send it as a new message.";
const DECISION_EDIT = /^(?:y|n|yes|yeah|yep|yup|no|nope|nah|stop|cancel|confirm|approve|approved|decline|withdraw|unsubscribe|ok|okay|sure|go ahead|do it|send it|don'?t|do not|start|\/stop|\/start)\b/i;
export const isDecisionEdit = (text: string) => { const t = String(text ?? "").trim().replace(/[.!?’']+$/g, ""); return t.length <= 40 && t.split(/\s+/).length <= 5 && DECISION_EDIT.test(t); };
// TELEGRAM ROUND 3: "/start <code>" from a chat already linked to an account, with a code that is used, expired or forged, was
// told to text "connect telegram" where they already use Trainee for a new link, though this chat already is their account.
export const TELEGRAM_LINK_INVALID_LINKED_REPLY = "That link has expired or was already used, and this chat is already linked to your Trainee account, so nothing changed.";
export const DOC_NOT_SENT_REPLY = "I couldn't attach the file here just now, so it wasn't sent. Ask me to send it again.";
// FEATURE 16 (owner decision 2026-10-26): Telegram's own login links a chat to an account (TELEGRAM_LOGIN_URL: the web
// page, telegram-link.html, on the domain set with BotFather /setdomain).
export const LINK_BUTTON = "Link your Trainee account";
export const TELEGRAM_LINK_REPLY = "To use Trainee in this chat, link your Trainee account: tap the button below and sign in to Trainee. Telegram tells Trainee only your Telegram name and id.";
export const TELEGRAM_UNLINKED_REPLY = "Telegram is unlinked from your Trainee account. Nothing from this chat reaches that account now.";
export const TELEGRAM_CHANNEL_ONLY_REPLY = "This chat is your Trainee account, so it can't be unlinked. Nothing changed.";
const LINK_ASK = /^(link|connect) (my (trainee )?account|telegram|this chat)[.!]*$/i, UNLINK_ASK = /^unlink (telegram|this chat|my account)[.!]*$/i;
export const LINK_NONCE_MS = 10 * 60000;
export const LINK_ASK_MS = 60 * 60000; // a yes counts for an hour after the question

// alias (CHANNEL DELIVERY ROUND 2): the WhatsApp business-scoped id recorded for the contact, when there is one.
export interface Person { userId: string; threadId: string | null; contact?: string; alias?: string | null }
// TELEGRAM LINK OWNERSHIP (2026-10-31): ok only when the chat already is the account's; "asked": the account's own channel was
// asked (the question queued under key, for the account userId), and this chat is linked only on the YES there.
export type Redeemed = { ok: true; userId: string; threadId: string | null } | { ok: false; why: "invalid" | "linked_elsewhere" | "cant_ask" }
  | { ok: false; why: "asked"; userId: string; key: string };
export interface InboundStore {
  claimMessage(id: string, at: number, provider?: Provider): Promise<boolean>; // false: this provider's message id was handled before
  person(contact: string): Promise<Person | null>; // a linked account, if any (by contact key or recorded alias)
  refusedBefore(contact: string, at: number): Promise<boolean>; // records the refusal; true when this contact was refused already
  createPerson(contact: string, at: number, phone?: string | null): Promise<Person>;
  setThread(contact: string, threadId: string, userId?: string): Promise<void>; // one thread per person, every channel
  setOptOut(contact: string, out: boolean, at: number): Promise<void>;
  enqueueReply(userId: string, key: string, text: string, at: number, channel?: Channel, part?: { of: string; n: number }, cardId?: string | null): Promise<boolean>;
  // WO-038 (optional, so a store written for WO-013 still runs the LoopMessage path unchanged):
  sawInbound?(contact: string, at: number, o: { alias?: string | null; phone?: string | null }): Promise<void>;
  // optedOut (IDENTITY SCENARIOS, 2026-10-30): the account is stopped (a STOP on any of its contacts), so a question there
  // would never be seen.
  linkCandidate?(phone: string, except: Channel): Promise<{ userId: string; contact: string; optedOut?: boolean } | null>;
  // IDENTITY SCENARIOS (2026-10-30): the contact an open question for this (not yet linked) contact was asked on, if any.
  pendingLink?(contact: string, at: number): Promise<string | null>;
  askToLink?(a: { userId: string; contact: string; phone: string; askedOn: string; at: number; text: string }): Promise<string | null>; // the outbox key, or null: asked already
  // ambiguous (TELEGRAM LINK OWNERSHIP): two questions were open on this contact, one a link code's: neither is linked.
  confirmLink?(a: { userId: string; askedOn: string; at: number; notice: string }): Promise<{ contact: string; key: string | null } | { ambiguous: true } | null>;
  issueLinkNonce?(userId: string, at: number): Promise<string>;
  // askText: the question for the account's own channel (telegramLinkAskText), queued only when the chat is no one's.
  redeemLinkNonce?(nonce: string, contact: string, at: number, askText: string): Promise<Redeemed>;
  pendingCodeLink?(contact: string, at: number): Promise<boolean>; // a link code's question waits for its YES for this chat
  reholdSent?(providerMessageId: string, at: number, error: string): Promise<number>; // a sent message that failed for the window
  unlinkTelegram?(userId: string, at: number): Promise<number>; // FEATURE 16: "unlink telegram"; how many contacts let go
  // CHANNEL DELIVERY ROUND 2 (2026-10-30), optional:
  // failSent: a sent message the provider later reported not delivered (WhatsApp 131026 and the like, a LoopMessage
  //   message_failed): its row is marked failed with the reason (retry: put back to go again from that message); how many.
  // releaseContact: the WhatsApp number now belongs to someone else (another business-scoped id wrote from it): the contact
  //   is let go from the account it was linked to.
  // movedNumber: the person changed their WhatsApp number: their account moves to the new one; false when it cannot.
  failSent?(providerMessageId: string, at: number, error: string, retry: boolean): Promise<number>;
  releaseContact?(contact: string, at: number): Promise<void>;
  movedNumber?(from: string, to: string, at: number): Promise<boolean>;
}
export interface CoreDeps {
  env: { get(k: string): string | undefined };
  now: () => number;
  store: InboundStore;
  // straight out on the inbound channel: no account, no outbox row. opts (FEATURE 16): buttons, where the channel has them.
  reply: (contact: string, bubbles: string[], opts?: SendOptions) => Promise<{ ok: boolean }>;
  render: (text: string) => string[];
  // parts (optional): a reply longer than one message's worth (an outreach batch of drafts, a long card), each part at most
  // OUTBOX_CHARS; when given with two or more, they are what the person reads, in order, and `reply` is not sent.
  // replyToMessageId (optional): the provider's id of the message the person replied to (SERIAL-1462). cardId (optional,
  // in the answer): the card this reply shows, so the outbox row that carries it is recorded against the card.
  chat: (a: { userId: string; threadId: string | null; message: string; turnKey: string; replyToMessageId?: string | null; channel?: string; screenTap?: { qid: string; answer: string } | null }) => Promise<{ status: number; reply: string; shape?: { attachments: ShapedFile[]; links: string[]; more?: string[] }; threadId: string | null; parts?: string[]; cardId?: string | null; resultStatus?: string | null; postings?: unknown[]; postingsAsFile?: boolean; screenButtons?: boolean; screenQid?: string | null; artifacts?: { ref: string; filename: string; mime: string }[] }>;
  // a head start on the every-minute run; what it did (deliverDue's counts), when the deliverer says (the #301 rest waits for its head)
  // replyTo (TELEGRAM BRIEF, brief P1.2): the person's message this answers, so the answer is threaded to it.
  deliver: (a: { userId: string; key: string; now: number; replyTo?: string | null }) => Promise<unknown>;
  // FEATURE 16 (Telegram; optional, so the other channels run unchanged):
  // resumeFile: a document the person sent, downloaded, read and stored as their upload (channel_resume_upload.ts); ok
  //   gives the message the chat receives for it, else the plain reply to say. Absent: the file is not read (WO-106 reply).
  resumeFile?: (a: { userId: string; doc: NonNullable<InboundMessage["document"]>; now: number }) => Promise<{ ok: true; message: string } | { ok: false; reply: string }>;
  // cardTap: a button tap on a card (channel_card_tap.ts tapCard); answerCallback: the tap answered once on the button.
  cardTap?: (a: { userId: string; data: string; now: number }) => Promise<{ toast: string; reply: string; status: string; parts?: string[] }>;
  answerCallback?: (callbackId: string, text: string) => Promise<boolean>;
  // JOB CARDS (telegram_jobs.ts): a tap on a posting's Apply / Details / Save / Next / Confirm / Edit / Cancel, and the postings a
  // turn found sent as cards (logo, caption, buttons) after its reply. Absent: the reply's words stand and no button exists.
  jobTap?: (a: { userId: string; data: string; messageId: string | null; contact: string }) => Promise<{ toast: string; status: string }>;
  // asFile (TELEGRAM BRIEF, brief P7.2): a set of roles goes as the list page's link (a File), never one card each.
  showPostings?: (a: { userId: string; contact: string; hits: unknown[]; asFile?: boolean; replyTo?: string | null }) => Promise<{ sent: number; total: number }>;
  // FEATURE 16: the turn's documents (owner-scoped refs) sent as files after its reply; how many went. Absent: the channel
  // sends no files, and the reply's own words stand (agent-chat says when a file could not be attached).
  // REPLY SHAPE (channel_shape.ts): a file and a link, each its own message, after the reply. Absent: the channel has none, and
  // the reply's own words stand.
  sendFile?: (a: { contact: string; filename: string; mime: string; bytes: Uint8Array }) => Promise<{ ok: boolean }>;
  sendLink?: (a: { contact: string; url: string; replyTo?: string | null }) => Promise<{ ok: boolean }>;
  // TELEGRAM BRIEF (brief P1.1, P7.5): the "on it" reaction on the person's message for slow work. Absent, or refused: the N12
  // interim line (ackAfterMs) is the acknowledgment instead; never both.
  react?: (address: string, messageId: string, emoji: string) => Promise<boolean>;
  sendArtifacts?: (a: { userId: string; threadId: string | null; contact: string; artifacts: { ref: string; filename: string; mime: string }[] }) => Promise<{ sent: number; failed: number }>;
  // N12/N13 (channel_voice.ts LATENCY_BUDGET; optional, so a channel without them runs unchanged):
  // typing: the platform's typing indicator to this address, shown as soon as a message arrives and every typingEveryMs
  //   while it is handled (best effort: a failure never touches the turn).
  // ackAfterMs: a turn (reading a file, then the chat) still running after this long gets ONE interim line (ackFor), sent
  //   straight out before the answer; null or absent: none. timers: the clock the two run on (tests inject one).
  typing?: (address: string) => Promise<unknown>;
  typingEveryMs?: number;
  ackAfterMs?: number | null;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}
type Out = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown>): Out => ({ status: 200, body: { ok: true, ...body } });

// TRAINEE_ALLOWED_CONTACTS lists phones and emails as before, and "telegram:<chat id>" or "whatsapp:<id>"; a WhatsApp
// sender whose number is listed is allowed too.
export function signupAllows(env: CoreDeps["env"], contact: string, phone?: string | null): boolean {
  if ((env.get("TRAINEE_SIGNUP") || "closed") === "open") return true;
  const list = (env.get("TRAINEE_ALLOWED_CONTACTS") || "").split(",").map((c) => c.trim()).filter(Boolean);
  return list.some((c) => {
    const p = /^(telegram|tg):\s*(.+)$/i.exec(c), w = /^(whatsapp|wa):\s*(.+)$/i.exec(c);
    if (p) return `tg:${p[2]}` === contact;
    if (w) return `wa:${w[2]}` === contact;
    try { const n = normalizeContact(c); return n === contact || (!!phone && n === phone); } catch { return false; }
  });
}
// The parts contract (WO-038, for WO-033's outreach batch and long cards): agent-chat may answer with `parts`, each at
// most OUTBOX_CHARS. Each becomes its own outbox row and is never cut: a part over the limit is split on purpose (lines
// kept together), never truncated. Fewer than two usable parts: null, and the single reply goes as before.
// NO LIMITS (owner, 2026-10-27 19:55 CDT): every part is delivered, however many (a card of 500 applications is about 40
// messages); the old 30-part ceiling, which cut the tail of a long card, is gone. Pacing is the provider's (pacer).
export function replyParts(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const parts = raw.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean)
    .flatMap((p) => (p.length <= OUTBOX_CHARS ? [p] : packMessages(p, OUTBOX_CHARS)));
  return parts.length < 2 ? null : parts;
}
// A provider id becomes a chat turn key the chat accepts (letters, digits, - and _), so agent-chat's own replay guard sees
// a retry of the same message as the same turn.
export async function turnKeyFor(messageId: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageId)));
  return "lm_" + Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
// LoopMessage keeps its keys (reply:<id>); the other providers' ids are namespaced, so a Telegram update id and a
// LoopMessage id that happen to be equal never collide in one person's outbox.
const scoped = (m: InboundMessage) => (m.provider === "loopmessage" ? m.messageId : `${m.provider === "telegram" ? "tg" : "wa"}:${m.messageId}`);
const YES = /^yes[.!]*$/i, CONNECT_TELEGRAM = /^connect telegram[.!]*$/i;

// F09: the Yes / No buttons under the posting screen's yes/no question. Their callback data is scr:<question id>:yes|no, bound to the one
// question that is open; a tap is an explicit screen answer (never a typed "yes" for another consumer).
export const screenButtons = (qid: string) => [[{ text: "Yes", data: `scr:${qid}:yes` }, { text: "No", data: `scr:${qid}:no` }]];
export const SCREEN_TAP = /^scr:([0-9a-f]{8}):(yes|no)$/;
export const SCREEN_REPLY_YES_NO = "Reply yes or no.";
const MORE_ONE_MESSAGE = 4000; // #301's second message, whole (Telegram takes 4,096; channel_shape.ts MORE_MAX_CHARS is 3,000)
export async function runInbound(msg: InboundMessage, d: CoreDeps): Promise<Out> {
  const now = d.now(), store = d.store;
  if (!(await store.claimMessage(msg.messageId, now, msg.provider))) return ok({ ignored: "duplicate webhook" });
  // N12: the typing indicator goes out as soon as the message is claimed (a retried update shows nothing), and again every
  // typingEveryMs until it is handled (the answer delivered). Not for a block or an edit, which answer nothing.
  const typing = d.typing && (msg.kind === "text" || msg.kind === "callback" || (msg.kind === "seen" && !!(msg.file || msg.media)))
    ? typingLoop({ typing: () => d.typing!(msg.address), everyMs: d.typingEveryMs, ...(d.timers ? { setTimer: d.timers.set, clearTimer: d.timers.clear } : {}) })
    : null;
  let contact = msg.contact;
  // TELEGRAM ROUND 2 (2026-10-30): a fixed answer sent straight back (not through the outbox) that Telegram refused because
  // the person blocked the bot or deleted their account (403) is that person's STOP, as it is on the outbox's sends.
  // TELEGRAM BRIEF (brief P1.2): everything said back to this person's message is threaded as a reply to it.
  const replyTo = msg.platformMessageId ?? null;
  const say = async (to: string, bubbles: string[], opts?: SendOptions): Promise<{ ok: boolean }> => {
    const r = await d.reply(to, bubbles, replyTo && to === msg.contact ? { ...opts, replyTo } : opts);
    if ((r as { optOut?: boolean }).optOut) await store.setOptOut(to, true, now).catch(() => {});
    return r;
  };
  // N12: the one interim line of a slow turn (armed by interim(), at most once per message; stopped before the answer).
  let working: ReturnType<typeof ackOnce> | null = null, reacted = false;
  const interim = (text: string) => {
    const w = ackOnce({ afterMs: d.ackAfterMs, ack: () => say(contact, d.render(text)), ...(d.timers ? { setTimer: d.timers.set, clearTimer: d.timers.clear } : {}) });
    w.start();
    return w;
  };
  // A forwarded message, and the words sent with a photo or a video, are never the person's command, yes or link request.
  // IDENTITY SCENARIOS (2026-10-30): WhatsApp's forwarded flag (messages[].context.forwarded) too: a forwarded "yes" linked
  // the chat that was asked.
  const passedOn = !!(msg.forwardedFrom || msg.caption || msg.forwarded);
  // The message id is claimed, so a failure past this point is never retried by the provider: say so to the person once
  // (best effort) rather than leave them with silence.
  try {
    let person = await store.person(contact);
    let released = false; // IDENTITY SCENARIOS: the number was just shown to be someone else's now (a recycled number)
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): a WhatsApp number given to someone else. Meta's business-scoped id is the
    // account's, not the number's: a message from the number with another id is another person. It ran as the number's old
    // owner (their thread, their account) and opened the window for their queued messages, which then went to the new owner.
    // The contact is let go from the old account first; the new owner is a stranger, as anyone new is.
    if (person && msg.channel === "whatsapp" && msg.alias && person.alias && person.alias !== msg.alias && person.contact === msg.contact && store.releaseContact) {
      await store.releaseContact(msg.contact, now);
      person = null;
      released = true;
    }
    for (const alias of msg.aliases ?? []) { if (person) break; person = await store.person(alias); }
    if (person?.contact) contact = person.contact;
    // The person changed their WhatsApp number: their account follows them (the old number is let go).
    if (msg.kind === "moved") {
      const moved = !!(person && msg.movedTo && store.movedNumber && await store.movedNumber(contact, `wa:${msg.movedTo}`, now));
      return ok({ moved, ...(moved ? {} : { ignored: "a number change for no account" }) });
    }
    // TELEGRAM ROUND 3: an edit is not a new message (it opens nothing and runs nothing); a decision edited after the fact is
    // answered once with why nothing changed. The update is claimed above, so a retried edit is answered once too.
    if (msg.kind === "edited") {
      if (!person || !isDecisionEdit(msg.text)) return ok({ ignored: "an edited message (not read again)" });
      const r = await say(contact, d.render(EDIT_NOT_READ_REPLY));
      return ok({ edited: "answered", sent: r.ok });
    }
    // CHANNEL DELIVERY ROUND 2: WhatsApp's window runs from when the person sent the message (its timestamp), not from when
    // a retried webhook reached Trainee; never later than now (a phone's clock ahead of ours).
    const seenAt = typeof msg.sentAt === "number" && Number.isFinite(msg.sentAt) && msg.sentAt < now && msg.sentAt > now - 7 * 86400000 ? msg.sentAt : now;
    if (store.sawInbound) await store.sawInbound(contact, seenAt, { alias: msg.alias ?? null, phone: msg.phone ?? null });
    if (msg.kind === "blocked") { await store.setOptOut(contact, true, now); return ok({ command: "stop", blocked: true }); }
    // FEATURE 16: a button tap from a chat that is no one's account approves nothing; the button is answered and that is all.
    if (msg.kind === "callback" && !person) {
      if (msg.callback && d.answerCallback) await d.answerCallback(msg.callback.id, "This button isn't for this chat. Nothing was approved.").catch(() => false);
      return ok({ ignored: "a button tap from an unknown chat" });
    }
    if (msg.kind === "seen") {
      // WO-106 (live 2026-10-21: a resume sent as a file got no answer at all): a file or photo from a known person is told
      // what to do instead; a sticker or reaction is still left alone.
      if ((msg.file || msg.media) && person) {
        const text = msg.media === "voice" ? VOICE_NOT_READ_REPLY : msg.media === "photo" && d.resumeFile ? PHOTO_NOT_READ_REPLY : FILE_NOT_READ_REPLY;
        const r = await say(contact, d.render(text));
        return ok({ ignored: `${msg.media ?? "a file"} (not read); told what to send`, sent: r.ok });
      }
      return ok({ ignored: "no text (attachments are not read yet)" });
    }

    // PHONE LOGIN: a contact card that is not the sender's own proves nothing and links nothing.
    if (msg.sharedPhone === "other") {
      const r = await say(contact, d.render(PHONE_NOT_YOURS_REPLY), { shareContact: SHARE_PHONE_BUTTON });
      return ok({ phone: "not_own", sent: r.ok });
    }
    // A chat that is already someone's account keeps it: sharing a number changes nothing.
    if (msg.sharedPhone === "own" && person) {
      const r = await say(contact, d.render(PHONE_ALREADY_REPLY), { removeKeyboard: true });
      return ok({ phone: "already_linked", sent: r.ok });
    }
    if (msg.startPayload && store.redeemLinkNonce) {
      // TELEGRAM LINK OWNERSHIP (2026-10-31): opening the link asks the account's own channel; nothing is linked here.
      const r = await store.redeemLinkNonce(msg.startPayload, contact, now, telegramLinkAskText(msg.senderHandle));
      if (!r.ok && r.why === "asked") {
        try { await d.deliver({ userId: r.userId, key: r.key, now }); } catch (e) { console.error("inbound: the link question waits in the outbox:", e instanceof Error ? e.message : String(e)); }
        const s = await say(contact, d.render(TELEGRAM_LINK_CONFIRM_REPLY));
        return ok({ link: "asked", sent: s.ok });
      }
      // The same chat opening its link again (or a used one) while its question waits is told what it waits for.
      const waiting = !r.ok && r.why === "invalid" && !person && !!store.pendingCodeLink && await store.pendingCodeLink(contact, now);
      const text = r.ok ? TELEGRAM_LINKED_REPLY : waiting ? TELEGRAM_LINK_WAITING_REPLY : r.why === "linked_elsewhere" ? TELEGRAM_LINKED_ELSEWHERE_REPLY
        : r.why === "cant_ask" ? TELEGRAM_LINK_CANT_ASK_REPLY : person ? TELEGRAM_LINK_INVALID_LINKED_REPLY : TELEGRAM_LINK_INVALID_REPLY;
      const s = await say(contact, d.render(text));
      return ok({ link: r.ok ? "linked" : waiting ? "waiting" : r.why, sent: s.ok });
    }
    // CHANNEL DELIVERY ROUND 2: a LoopMessage text that came over SMS reads the carrier keywords (CANCEL, REVOKE, ARRET...).
    const command = passedOn ? null : msg.command ?? channelCommand(msg.text, msg.sms ? "sms" : msg.channel);
    // Telegram's Start from a chat Trainee has never seen is the person's first message, not a START: it goes through
    // sign-up like any first text.
    const firstStart = command === "start" && !!msg.command && !person;
    // WO-106 (live 2026-10-21): on a chat channel a known person's HELP (or /help) and Telegram's /start are also a turn for
    // the brain, which knows their goal and what is in flight, so the reply ends in their next step; /start's "you're back
    // on" line goes first. STOP, the word START (a re-subscribe after STOP) and every command on SMS keep their fixed reply.
    // CHANNEL DELIVERY ROUND 2: a HELP that came over SMS gets the carrier's fixed answer, as every command on SMS does.
    const toBrain = !!msg.channel && !msg.sms && !!person && (command === "help" || (command === "start" && !!msg.command));
    if (command && !firstStart) {
      if (command !== "help") await store.setOptOut(contact, command === "stop", now);
      if (!toBrain) {
        const r = await say(contact, d.render(CHANNEL_REPLIES[command]));
        return ok({ command, sent: r.ok });
      }
    }

    if (!person) {
      // TELEGRAM LINK OWNERSHIP (2026-10-31): a chat that opened a link code waits for the YES on the account's own channel: it
      // reads nothing, signs up to nothing and approves nothing meanwhile; it is told what it waits for (STOP, above, still
      // stops it).
      if (msg.channel === "telegram" && store.pendingCodeLink && await store.pendingCodeLink(contact, now)) {
        const r = await say(contact, d.render(TELEGRAM_LINK_WAITING_REPLY));
        return ok({ link: "waiting", sent: r.ok });
      }
      // IDENTITY SCENARIOS (2026-10-30): a Telegram chat waiting for its yes carries no number on a typed message (only the
      // share did): it went on to sign-up, a second account with sign-up open, and the yes then linked nothing. It is told
      // again where the yes goes.
      if (msg.channel === "telegram" && !msg.phone && store.pendingLink) {
        const on = await store.pendingLink(contact, now);
        if (on) {
          const r = await say(contact, d.render(linkPendingReply(channelOf(on))));
          return ok({ link: "asked already", sent: r.ok });
        }
      }
      // The same number already has Trainee on another channel: ask there, never merge on our own.
      if (msg.phone && store.linkCandidate && store.askToLink) {
        const found = await store.linkCandidate(msg.phone, msg.channel);
        // IDENTITY SCENARIOS (2026-10-30): the number's account is stopped. The question was never asked (a stopped contact
        // was skipped) and the message went on to sign-up: a second account for the same number (or, with Auth's one phone
        // per account, "I couldn't answer that" on every message). Now it is said plainly, and nothing is made or linked.
        if (found?.optedOut) {
          const r = await say(contact, d.render(linkStoppedReply(channelOf(found.contact))), msg.sharedPhone === "own" ? { removeKeyboard: true } : undefined);
          return ok({ link: "stopped there", sent: r.ok });
        }
        if (found) {
          const key = await store.askToLink({ userId: found.userId, contact, phone: msg.phone, askedOn: found.contact, at: now, text: linkAskText(msg.channel) });
          // TELEGRAM SCENARIOS (2026-10-30): the share-phone button tapped again while the question waits got silence. It is
          // the person's own tap, so they are told again where the yes goes (no second question is asked). A WhatsApp
          // message carries the number on every text, and those stay quiet until the yes (WO-038).
          if (!key && msg.sharedPhone === "own") {
            const r = await say(contact, d.render(linkPendingReply(channelOf(found.contact))), { removeKeyboard: true });
            return ok({ link: "asked already", sent: r.ok });
          }
          if (!key) return ok({ ignored: "link asked already" });
          try { await d.deliver({ userId: found.userId, key, now }); } catch (e) { console.error("inbound: the link question waits in the outbox:", e instanceof Error ? e.message : String(e)); }
          const r = await say(contact, d.render(linkPendingReply(channelOf(found.contact))));
          return ok({ link: "asked", sent: r.ok });
        }
      }
      if (!signupAllows(d.env, contact, msg.phone)) {
        if (msg.sharedPhone === "own") {
          const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
          const r = await say(contact, d.render(PHONE_NO_ACCOUNT_REPLY), { removeKeyboard: true });
          if (/^https:\/\//.test(loginUrl)) await say(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
          return ok({ phone: "no_account", sent: r.ok });
        }
        // FEATURE 16: on Telegram, with the login page configured, the person links their existing account instead.
        const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
        if (msg.channel === "telegram" && /^https:\/\//.test(loginUrl)) {
          if (await store.refusedBefore(contact, now) && msg.command !== "start") return ok({ ignored: "not linked (already told)" });
          await say(contact, d.render(SHARE_PHONE_ASK), { shareContact: SHARE_PHONE_BUTTON }).catch(() => ({ ok: false }));
          const r = await say(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
          return ok({ link: "offered", sent: r.ok });
        }
        if (await store.refusedBefore(contact, now)) return ok({ ignored: "signup closed (already told)" });
        const r = await say(contact, d.render(SIGNUP_CLOSED_REPLY));
        return ok({ refused: "signup closed", sent: r.ok });
      }
      try { person = await store.createPerson(contact, now, msg.phone ?? null); }
      catch (e) {
        if (!isPhoneTaken(e)) throw e;
        // IDENTITY SCENARIOS (2026-10-30): Auth holds the number for an account no channel of Trainee's can ask. A WhatsApp
        // number just shown to be someone else's now (another business-scoped id) is a new person: their own account, without
        // the number (it is still the old owner's sign-in). Otherwise no second account is made, and it is said once.
        if (released && msg.channel === "whatsapp") person = await store.createPerson(contact, now, null);
        else {
          if (await store.refusedBefore(contact, now) && msg.sharedPhone !== "own") return ok({ ignored: "number taken (already told)" });
          const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
          const r = await say(contact, d.render(PHONE_TAKEN_REPLY), msg.sharedPhone === "own" ? { removeKeyboard: true } : undefined);
          if (msg.channel === "telegram" && /^https:\/\//.test(loginUrl)) await say(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] }).catch(() => ({ ok: false }));
          return ok({ refused: "number taken", sent: r.ok });
        }
      }
      if (store.sawInbound) await store.sawInbound(contact, seenAt, { alias: msg.alias ?? null, phone: msg.phone ?? null });
      // A first Start is the person's first message: the brain welcomes them with what to send first (WO-106).
    }

    const key = `reply:${scoped(msg)}`;
    let cardId: string | null = null; // the card the turn's reply shows, recorded on the outbox row (SERIAL-1462)
    const answer = async (text: string, extra: Record<string, unknown>) => {
      await store.enqueueReply(person!.userId, key, text, now, msg.channel, undefined, cardId);
      try { await d.deliver({ userId: person!.userId, key, now }); }
      catch (e) { console.error("inbound: immediate send failed (the outbox has it):", e instanceof Error ? e.message : String(e)); }
      return ok(extra);
    };
    // FEATURE 16: a tap on a card's Approve or Decline (Telegram's inline keyboard): answered exactly as the web tap
    // (channel_card_tap.ts), the button answered once, and the result said in the chat through the outbox.
    // F09: a tap on Yes / No (scr:<qid>:yes|no) goes to the chat as an EXPLICIT screen answer carrying the question id; the chat runs it
    // only if that question is still open (else "That question is no longer open") and skips every other yes/no consumer. It is never
    // turned into a typed "yes": no card is approved, no account linked, no employer question answered by it. A button from before
    // this change (data exactly "yes" / "no") is stale by definition and does nothing.
    let screenTap: { qid: string; answer: string } | null = null;
    if (msg.kind === "callback" && msg.callback) {
      const m = SCREEN_TAP.exec(msg.callback.data);
      if (m) {
        screenTap = { qid: m[1], answer: m[2] };
        if (d.answerCallback) await d.answerCallback(msg.callback.id, m[2] === "yes" ? "Yes" : "No").catch(() => false);
        msg = { ...msg, kind: "text", text: m[2], replyToMessageId: null, callback: null };
      } else if (/^(yes|no)$/.test(msg.callback.data)) {
        if (d.answerCallback) await d.answerCallback(msg.callback.id, "That question is no longer open.").catch(() => false);
        return ok({ ignored: "a stale yes/no button" });
      }
    }
    const tapped = !!screenTap;
    if (msg.kind === "callback") {
      if (!msg.callback || !d.cardTap) {
        if (msg.callback && d.answerCallback) await d.answerCallback(msg.callback.id, "Nothing was approved.").catch(() => false);
        return ok({ ignored: "a button tap (not wired)" });
      }
      if (/^jc[adsxeyn]:/.test(msg.callback.data) && d.jobTap) {
        const jt = await d.jobTap({ userId: person.userId, data: msg.callback.data, messageId: msg.callback.messageId, contact }).catch(() => ({ toast: "That didn't work. Nothing was sent.", status: "failed" }));
        if (d.answerCallback) await d.answerCallback(msg.callback.id, jt.toast).catch(() => false);
        return ok({ jobTap: jt.status });
      }
      const tap = await d.cardTap({ userId: person.userId, data: msg.callback.data, now });
      if (d.answerCallback) await d.answerCallback(msg.callback.id, tap.toast).catch(() => false);
      // A tap that approved a large batch answers in several messages (one line per application), each whole, in order.
      const tapParts = replyParts(tap.parts);
      if (!tapParts) return await answer(tap.reply, { tap: tap.status });
      const tapRows = tapParts.map((text, i) => ({ key: `${key}:${i + 1}`, text, part: { of: key, n: i + 1 } }));
      for (const r of tapRows) await store.enqueueReply(person.userId, r.key, r.text, now, msg.channel, r.part, null);
      try { for (const r of tapRows) await d.deliver({ userId: person.userId, key: r.key, now }); }
      catch (e) { console.error("inbound: immediate send failed (the outbox has it):", e instanceof Error ? e.message : String(e)); }
      return ok({ tap: tap.status, parts: tapRows.length });
    }
    // FEATURE 16: a document (a resume as a PDF or Word file): downloaded, read and stored as the person's upload; the
    // chat then reads its text as a pasted resume. Not wired, or not readable: said plainly, and no turn runs.
    let fileMessage: string | null = null;
    if (msg.document) {
      if (!d.resumeFile) return await answer(FILE_NOT_READ_REPLY, { ignored: "a file (not read here)" });
      working = interim(ackFor("resume"));
      const got = await d.resumeFile({ userId: person.userId, doc: msg.document, now });
      if (!got.ok) { await working.stop(); return await answer(got.reply, { file: "not read" }); }
      fileMessage = got.message;
    }
    // A yes to "Reply yes to link it", within the hour, on the channel that was asked.
    if (!tapped && !passedOn && YES.test(msg.text.trim()) && store.confirmLink) {
      const linked = await store.confirmLink({ userId: person.userId, askedOn: contact, at: now, notice: LINKED_HERE_REPLY });
      if (linked && "ambiguous" in linked) return await answer(LINK_AMBIGUOUS_REPLY, { linked: null, ambiguous: true });
      if (linked) {
        if (linked.key) { try { await d.deliver({ userId: person.userId, key: linked.key, now }); } catch { /* the outbox has it */ } }
        return await answer(linkedReply(channelOf(linked.contact)), { linked: channelOf(linked.contact) });
      }
    }
    // FEATURE 16: on Telegram, "link my account" offers Telegram's login; "unlink telegram" lets this chat go.
    if (msg.channel === "telegram" && !fileMessage && !passedOn) {
      const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
      if (LINK_ASK.test(msg.text.trim()) && /^https:\/\//.test(loginUrl)) {
        const r = await say(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
        return ok({ link: "offered", sent: r.ok });
      }
      if (UNLINK_ASK.test(msg.text.trim()) && store.unlinkTelegram) {
        const n = await store.unlinkTelegram(person.userId, now);
        const r = await say(contact, d.render(n < 0 ? TELEGRAM_CHANNEL_ONLY_REPLY : n ? TELEGRAM_UNLINKED_REPLY : "This chat isn't linked to a Trainee account, so there was nothing to unlink."));
        return ok({ unlinked: n, sent: r.ok });
      }
    }
    if (!passedOn && CONNECT_TELEGRAM.test(msg.text.trim()) && store.issueLinkNonce) {
      const bot = (d.env.get("TELEGRAM_BOT_USERNAME") || "").trim();
      const text = msg.channel === "telegram" ? ALREADY_TELEGRAM_REPLY
        : bot && d.env.get("TELEGRAM_BOT_TOKEN") ? connectTelegramReply(telegramDeepLink(bot, await store.issueLinkNonce(person.userId, now)))
        : TELEGRAM_NOT_WIRED_REPLY;
      return await answer(text, { connect: "telegram" });
    }

    let postingsAsFile = false;
    let postings: unknown[] = [], cardsShown = 0, screenQidOut: string | null = null, shape: { attachments: ShapedFile[]; links: string[]; more?: string[] } | null = null;
    const notes: string[] = [];
    let reply: string, parts: string[] | null = null, artifacts: { ref: string; filename: string; mime: string }[] = [], turnThread: string | null = person.threadId;
    try {
      const turnKey = await turnKeyFor(msg.provider === "loopmessage" ? msg.messageId : `${msg.provider}:${msg.messageId}`);
      // Telegram's /start and /help come as a command with no text; the brain reads them as the command itself.
      // TELEGRAM SCENARIOS (2026-10-30): a shared phone that made the account (sign-up open, or the number allow-listed) has no
      // words at all; the turn ran with an empty message, agent-chat refused it, and the person read "I couldn't answer that
      // just now" for their first tap. It is their first message, as a first /start is.
      const said = fileMessage ?? (msg.text || (command ? `/${command}` : msg.sharedPhone === "own" ? "/start" : ""));
      // TELEGRAM ROUND 2: a forwarded message is framed as someone else's words; a message over agent-chat's 4,000 characters
      // is cut on a whole word and the answer says where reading stopped; the words sent with a photo or a video are read,
      // and the answer says the picture was not.
      const fitted = !fileMessage && msg.forwardedFrom ? forwardedMessage(msg.forwardedFrom, said) : cutForChat(said);
      if (fitted.cut) notes.push(longCutNote(msg.forwardedFrom ? fitted.text.slice(0, -1) : fitted.text));
      if (msg.caption && msg.media && !fileMessage) notes.unshift(MEDIA_CAPTION_NOTE);
      // TELEGRAM BRIEF (brief P1.1, P5.1, P7.5): slow work (a live search, a draft, an apply) is acknowledged at once with the
      // eyes reaction on the person's message; then nothing until there is something real. A question answerable in one line
      // gets no acknowledgment. Where no reaction could be shown, the N12 interim below is the one line; never both.
      if (!working && !reacted && d.react && replyTo && msg.kind === "text" && !command && !fileMessage && !passedOn && slowWork(said)) {
        reacted = await d.react(msg.address, replyTo, ACK_REACTION).catch(() => false);
      }
      // N12: one interim if the turn runs past the budget (already armed when a file was being read: still one).
      if (!reacted) working ??= interim(ackFor(said));
      // The brain gets the person, the thread, the words and a turn key, and the reply-to id only when the platform gave one.
      const out = await d.chat({ userId: person.userId, threadId: person.threadId, message: fitted.text, turnKey, ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}), ...(screenTap ? { screenTap } : {}) });
      reply = out.reply.trim() || CHAT_DOWN_REPLY;
      // SERIAL-1480: a card's yes with no usable reply id is told how in this channel's own terms: where this
      // integration has a verified reply-id path (Telegram, WhatsApp Cloud) "reply directly to the card, or tap"; on
      // iMessage, where it has none, only "tap the card".
      if (out.resultStatus === CARD_NEEDS_REPLY_STATUS) reply = needsReplyTextFor(msg.channel);
      parts = replyParts(out.parts);
      shape = out.shape ?? null;
      cardId = typeof out.cardId === "string" && out.cardId ? out.cardId : null;
      artifacts = Array.isArray(out.artifacts) ? out.artifacts : [];
      screenQidOut = out.screenButtons === true && typeof out.screenQid === "string" ? out.screenQid : null;
      postings = Array.isArray(out.postings) ? out.postings.slice(0, 200) : [];
      postingsAsFile = out.postingsAsFile === true;
      turnThread = out.threadId ?? person.threadId;
      if (toBrain && command === "start") {
        reply = `${CHANNEL_REPLIES.start}\n\n${reply}`;
        if (parts) parts = [`${CHANNEL_REPLIES.start}\n\n${parts[0]}`, ...parts.slice(1)];
      }
      if (notes.length) {
        reply = [...notes, reply].join("\n\n");
        if (parts) parts = [[...notes, parts[0]].join("\n\n"), ...parts.slice(1)];
      }
      if (out.threadId && out.threadId !== person.threadId) await store.setThread(contact, out.threadId, person.userId);
    } catch (e) {
      console.error("inbound: chat failed:", e instanceof Error ? e.message : String(e));
      reply = CHAT_DOWN_REPLY;
    }
    // The turn is over: no interim after this point, and one already going reaches the person before the answer.
    if (working) await working.stop();
    // The reply is queued; sending it now is a head start on the every-minute run, never a second path. A failure there may
    // come after the provider took it, so it must not reach the catch below (which would also say "couldn't answer").
    // A reply in parts is one row per part (reply:<id>:<n>), each whole, sent in order.
    // #301 (TELEGRAM SCENARIOS, 2026-10-30): a long answer's rest (shape.more) follows its head as ONE message, and only after
    // the head. It was sent at once, through the channel's 1,500-character packing (a 3,000-character rest arrived as two or
    // three messages), and before the head when Telegram refused the head (429): the rest first, the answer a minute later.
    // Now the head is part 1 of the reply; when it went out, the rest goes as one message; when it did not, the rest waits
    // in the outbox as part 2, behind the head, in order (the outbox's own parts rule).
    const more = !parts && shape?.more?.length ? String(shape.more[0] ?? "").trim() : "";
    // TELEGRAM ROUND 3 (2026-10-31): what follows the answer (the #301 rest, each file, each link) went straight out, each on
    // its own: a rest or a link Telegram refused (a 429 asking to wait, a 502) was lost without a word, and with no rest an
    // answer whose head Telegram refused had its links arrive first (the head a minute later). Now the head is part 1 of the
    // reply whenever text or a link follows it; what follows goes out after it, in order, until one is refused, and that one
    // and everything after it wait in the outbox as the next parts, behind what went (a refused file is said there instead).
    // And the head start stops at the first part that did not go: the parts after it wait for the outbox, never overtaking it.
    type Step = { kind: "more"; text: string } | { kind: "file"; file: ShapedFile } | { kind: "link"; url: string };
    const shaping = !!shape && !!(d.sendFile || d.sendLink);
    const steps: Step[] = [...(more ? [{ kind: "more" as const, text: more }] : []),
      ...(shaping ? shape!.attachments.map((file) => ({ kind: "file" as const, file })) : []), ...(shaping ? shape!.links.map((url) => ({ kind: "link" as const, url })) : [])];
    const chained = !!parts || steps.some((x) => x.kind !== "file");
    const rows = parts ? parts.map((text, i) => ({ key: `${key}:${i + 1}`, text, part: { of: key, n: i + 1 } as { of: string; n: number } | undefined }))
      : chained ? [{ key: `${key}:1`, text: fitReply(reply), part: { of: key, n: 1 } as { of: string; n: number } | undefined }]
      : [{ key, text: fitReply(reply), part: undefined }];
    for (const r of rows) await store.enqueueReply(person.userId, r.key, r.text, now, msg.channel, r.part, cardId);
    let headWent = true;
    try {
      for (const r of rows) {
        const went = await d.deliver({ userId: person.userId, key: r.key, now, ...(replyTo ? { replyTo } : {}) });
        if (went && typeof went === "object" && "delivered" in went && !(Number((went as { delivered: unknown }).delivered) > 0)) { headWent = false; break; }
      }
    } catch (e) { headWent = false; console.error("inbound: immediate send failed (the outbox has it):", e instanceof Error ? e.message : String(e)); }
    // F09: the screen's yes/no question gets Yes / No buttons where the channel has them (Telegram), else the plain words.
    if (screenQidOut) {
      const buttons = msg.channel === "telegram" ? screenButtons(screenQidOut) : undefined;
      const already = /reply yes or no/i.test(reply) || (parts ?? []).some((p) => /reply yes or no/i.test(p));
      if (buttons || !already) await say(contact, d.render(buttons ? "Yes or no?" : SCREEN_REPLY_YES_NO), buttons ? { buttons } : undefined).catch(() => ({ ok: false }));
    }
    // JOB CARDS: the postings this turn found, each as its own card after the reply that introduces them. A failure here never
    // changes what was already said; the reply's own words stand.
    if (postings.length && d.showPostings) {
      const shown = await d.showPostings({ userId: person.userId, contact, hits: postings, ...(postingsAsFile ? { asFile: true } : {}), ...(replyTo ? { replyTo } : {}) }).catch((e) => { console.error("inbound: job cards failed:", e instanceof Error ? e.message : String(e)); return null; });
      if (shown) cardsShown = shown.sent;
    }
    // FEATURE 16: the documents, after the reply that names them; one that does not go is said, never claimed sent.
    let docs: { sent: number; failed: number } | null = null;
    if (artifacts.length && d.sendArtifacts) {
      docs = await d.sendArtifacts({ userId: person.userId, threadId: turnThread, contact, artifacts }).catch(() => ({ sent: 0, failed: artifacts.length }));
      if (docs.failed) await say(contact, d.render(DOC_NOT_SENT_REPLY)).catch(() => ({ ok: false }));
    }
    // REPLY SHAPE: the answer went first; now the rest, each file, then each link, one message each, in that order.
    let shaped: { files: number; links: number } | null = null;
    if (!more && shape?.more?.length) for (const m of shape.more.slice(0, 1)) await say(contact, d.render(m)).catch(() => ({ ok: false }));
    if (steps.length) {
      let n = rows.length, files = 0, links = 0, queued = !headWent, fileMissed = false;
      // A refusal that said how long to wait (Telegram's 429 retry_after) holds what waits until then; the parts after it wait
      // behind it (the outbox's parts rule).
      let waitUntil = now;
      const later = async (text: string) => { n++; await store.enqueueReply(person!.userId, `${key}:${n}`, text, waitUntil, msg.channel, { of: key, n }, null); };
      for (const st of steps) {
        if (st.kind === "file") {
          if (queued && headWent) { if (!fileMissed) await later(DOC_NOT_SENT_REPLY); fileMissed = true; continue; }
          const sf = d.sendFile;
          const r = await deliverShaped({ answer: "", attachments: [st.file], links: [], notes: [] }, { document: async (f) => sf ? await sf({ contact, ...f }) : { ok: false }, link: async () => ({ ok: false }) }, { includeAnswer: false });
          if (r.files) files++; else fileMissed = true;
          continue;
        }
        if (queued) { await later(st.kind === "link" ? st.url : fitReply(st.text)); continue; }
        let r: { ok: boolean; optOut?: boolean; sent?: number; retryAfterMs?: number };
        if (st.kind === "link") r = await d.sendLink!({ contact, url: st.url, ...(replyTo ? { replyTo } : {}) }).catch(() => ({ ok: false }));
        else {
          const bubbles = d.render(st.text), one = bubbles.join("\n\n");
          r = await say(contact, bubbles.length > 1 && one.length <= MORE_ONE_MESSAGE ? [one] : bubbles).catch(() => ({ ok: false }));
        }
        if (r.ok) { if (st.kind === "link") links++; continue; }
        if (r.optOut) break; // blocked: nothing more goes, nothing waits
        queued = true;
        if (typeof r.retryAfterMs === "number" && r.retryAfterMs > 0) waitUntil = Math.max(now, d.now()) + r.retryAfterMs;
        // A rest that went out in part (only one over 4,000 characters is sent as several messages) is not sent twice.
        if (st.kind === "more" && (r.sent ?? 0) > 0) continue;
        await later(st.kind === "link" ? st.url : fitReply(st.text));
      }
      if (fileMissed && !(queued && headWent)) await say(contact, d.render(DOC_NOT_SENT_REPLY)).catch(() => ({ ok: false }));
      if (shaping) shaped = { files, links };
    }
    return ok({ replied: true, ...(shaped ? { shaped } : {}), ...(cardsShown ? { cards: cardsShown } : {}), ...(parts ? { parts: parts.length } : {}), ...(docs ? { documents: docs } : {}) });
  } catch (e) {
    console.error("inbound failed:", e instanceof Error ? e.message : String(e));
    if (working) await working.stop();
    try { await say(contact, d.render(CHAT_DOWN_REPLY)); } catch { /* already logged */ }
    return { status: 500, body: { ok: false, error: "internal" } };
  } finally {
    if (working) await working.stop();
    if (typing) await typing.stop();
  }
}

// A webhook of a provider that may carry several messages and status callbacks (WhatsApp) or one update (Telegram). The
// provider gets 200 once its messages are claimed and run, so it does not retry what was handled; a failure inside one
// message was already said to that person.
export async function handleChannelWebhook(req: Request, adapter: ChannelAdapter, d: CoreDeps): Promise<Response> {
  const parsed = await adapter.parseInbound(req);
  if ("response" in parsed) return parsed.response;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let reheld = 0;
  let failed = 0;
  for (const s of parsed.statuses ?? [] as StatusEvent[]) {
    if (s.hold && d.store.reholdSent) reheld += await d.store.reholdSent(s.providerMessageId, d.now(), s.error);
    else if (!s.hold) {
      console.error(`${adapter.provider}: a sent message failed after it was accepted: ${s.error}`);
      // CHANNEL DELIVERY ROUND 2 (2026-10-30): the row said "delivered" while the provider said it was not (131026
      // undeliverable, 130429 throughput...). Now it is failed with the reason; a throughput refusal goes again from that
      // message.
      if (d.store.failSent) failed += await d.store.failSent(s.providerMessageId, d.now(), s.error, s.retry === true);
    }
  }
  if (!parsed.messages.length) return json({ ok: true, ...(reheld ? { reheld } : {}), ...(failed ? { failed } : {}), ignored: (parsed.ignored ?? [])[0] ?? "nothing to read" });
  const results: Record<string, unknown>[] = [];
  for (const m of parsed.messages) {
    const r = await runInbound(m, d);
    results.push(r.body);
  }
  return json({ ok: true, ...(reheld ? { reheld } : {}), ...(failed ? { failed } : {}), results });
}
