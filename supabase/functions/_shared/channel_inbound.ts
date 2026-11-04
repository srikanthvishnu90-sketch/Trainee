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
// - Same phone on another channel (WhatsApp and iMessage): nothing is merged. The channel already linked is asked, and only
//   a yes from it links the new one.
import { channelCommand, CHANNEL_REPLIES } from "./channel.ts";
import { fitOutbox as fitReply, normalizeContact, OUTBOX_CHARS } from "./conversation.ts";
import { type Channel, CHANNEL_NAME, channelOf, type ChannelAdapter, type InboundMessage, packMessages, type Provider, type SendOptions, type StatusEvent } from "./channel_adapters.ts";
import { telegramDeepLink } from "./telegram.ts";
import { deliverShaped, type ShapedFile } from "./channel_shape.ts";

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
export const connectTelegramReply = (link: string) => `Open this link where you use Telegram and tap Start. It works once, for the next 10 minutes.\n${link}`;
export const TELEGRAM_NOT_WIRED_REPLY = "Telegram isn't set up on Trainee's side yet, so there's no link to send.";
export const ALREADY_TELEGRAM_REPLY = "This chat is already on Telegram, so there's nothing to connect.";
export const TELEGRAM_LINKED_REPLY = "Telegram is linked to your Trainee account. Text here any time; Trainee answers on whichever channel you text.";
export const TELEGRAM_LINK_INVALID_REPLY = "That link has expired or was already used. Text \"connect telegram\" to Trainee where you already use it for a new one.";
export const TELEGRAM_LINKED_ELSEWHERE_REPLY = "This Telegram account is already linked to a different Trainee account, so nothing changed.";
export const FILE_NOT_READ_REPLY = "I can't open files sent here yet, so I haven't read that one. Paste your resume as text in this chat and I'll read it now.";
// FEATURE 16 (Telegram, where a PDF or Word file is read): what a photo or a voice message is told instead.
export const PHOTO_NOT_READ_REPLY = "I can't read photos, so I haven't read that one. Send your resume as a PDF or Word file, or paste the text here.";
export const VOICE_NOT_READ_REPLY = "I can't listen to voice, audio or video messages here, so I haven't heard that one. Type it as a message and I'll answer.";
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

export interface Person { userId: string; threadId: string | null; contact?: string }
export type Redeemed = { ok: true; userId: string; threadId: string | null } | { ok: false; why: "invalid" | "linked_elsewhere" };
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
  linkCandidate?(phone: string, except: Channel): Promise<{ userId: string; contact: string } | null>;
  askToLink?(a: { userId: string; contact: string; phone: string; askedOn: string; at: number; text: string }): Promise<string | null>; // the outbox key, or null: asked already
  confirmLink?(a: { userId: string; askedOn: string; at: number; notice: string }): Promise<{ contact: string; key: string | null } | null>;
  issueLinkNonce?(userId: string, at: number): Promise<string>;
  redeemLinkNonce?(nonce: string, contact: string, at: number): Promise<Redeemed>;
  reholdSent?(providerMessageId: string, at: number, error: string): Promise<number>; // a sent message that failed for the window
  unlinkTelegram?(userId: string, at: number): Promise<number>; // FEATURE 16: "unlink telegram"; how many contacts let go
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
  chat: (a: { userId: string; threadId: string | null; message: string; turnKey: string; replyToMessageId?: string | null; channel?: string; screenTap?: { qid: string; answer: string } | null }) => Promise<{ status: number; reply: string; shape?: { attachments: ShapedFile[]; links: string[]; more?: string[] }; threadId: string | null; parts?: string[]; cardId?: string | null; resultStatus?: string | null; postings?: unknown[]; screenButtons?: boolean; screenQid?: string | null; artifacts?: { ref: string; filename: string; mime: string }[] }>;
  deliver: (a: { userId: string; key: string; now: number }) => Promise<void>; // a head start on the every-minute run
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
  showPostings?: (a: { userId: string; contact: string; hits: unknown[] }) => Promise<{ sent: number; total: number }>;
  // FEATURE 16: the turn's documents (owner-scoped refs) sent as files after its reply; how many went. Absent: the channel
  // sends no files, and the reply's own words stand (agent-chat says when a file could not be attached).
  // REPLY SHAPE (channel_shape.ts): a file and a link, each its own message, after the reply. Absent: the channel has none, and
  // the reply's own words stand.
  sendFile?: (a: { contact: string; filename: string; mime: string; bytes: Uint8Array }) => Promise<{ ok: boolean }>;
  sendLink?: (a: { contact: string; url: string }) => Promise<{ ok: boolean }>;
  sendArtifacts?: (a: { userId: string; threadId: string | null; contact: string; artifacts: { ref: string; filename: string; mime: string }[] }) => Promise<{ sent: number; failed: number }>;
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
export async function runInbound(msg: InboundMessage, d: CoreDeps): Promise<Out> {
  const now = d.now(), store = d.store;
  if (!(await store.claimMessage(msg.messageId, now, msg.provider))) return ok({ ignored: "duplicate webhook" });
  let contact = msg.contact;
  // The message id is claimed, so a failure past this point is never retried by the provider: say so to the person once
  // (best effort) rather than leave them with silence.
  try {
    let person = await store.person(contact);
    for (const alias of msg.aliases ?? []) { if (person) break; person = await store.person(alias); }
    if (person?.contact) contact = person.contact;
    if (store.sawInbound) await store.sawInbound(contact, now, { alias: msg.alias ?? null, phone: msg.phone ?? null });
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
        const r = await d.reply(contact, d.render(text));
        return ok({ ignored: `${msg.media ?? "a file"} (not read); told what to send`, sent: r.ok });
      }
      return ok({ ignored: "no text (attachments are not read yet)" });
    }

    // PHONE LOGIN: a contact card that is not the sender's own proves nothing and links nothing.
    if (msg.sharedPhone === "other") {
      const r = await d.reply(contact, d.render(PHONE_NOT_YOURS_REPLY), { shareContact: SHARE_PHONE_BUTTON });
      return ok({ phone: "not_own", sent: r.ok });
    }
    // A chat that is already someone's account keeps it: sharing a number changes nothing.
    if (msg.sharedPhone === "own" && person) {
      const r = await d.reply(contact, d.render(PHONE_ALREADY_REPLY), { removeKeyboard: true });
      return ok({ phone: "already_linked", sent: r.ok });
    }
    if (msg.startPayload && store.redeemLinkNonce) {
      const r = await store.redeemLinkNonce(msg.startPayload, contact, now);
      const text = r.ok ? TELEGRAM_LINKED_REPLY : r.why === "linked_elsewhere" ? TELEGRAM_LINKED_ELSEWHERE_REPLY : TELEGRAM_LINK_INVALID_REPLY;
      const s = await d.reply(contact, d.render(text));
      return ok({ link: r.ok ? "linked" : r.why, sent: s.ok });
    }
    const command = msg.command ?? channelCommand(msg.text, msg.channel);
    // Telegram's Start from a chat Trainee has never seen is the person's first message, not a START: it goes through
    // sign-up like any first text.
    const firstStart = command === "start" && !!msg.command && !person;
    // WO-106 (live 2026-10-21): on a chat channel a known person's HELP (or /help) and Telegram's /start are also a turn for
    // the brain, which knows their goal and what is in flight, so the reply ends in their next step; /start's "you're back
    // on" line goes first. STOP, the word START (a re-subscribe after STOP) and every command on SMS keep their fixed reply.
    const toBrain = !!msg.channel && !!person && (command === "help" || (command === "start" && !!msg.command));
    if (command && !firstStart) {
      if (command !== "help") await store.setOptOut(contact, command === "stop", now);
      if (!toBrain) {
        const r = await d.reply(contact, d.render(CHANNEL_REPLIES[command]));
        return ok({ command, sent: r.ok });
      }
    }

    if (!person) {
      // The same number already has Trainee on another channel: ask there, never merge on our own.
      if (msg.phone && store.linkCandidate && store.askToLink) {
        const found = await store.linkCandidate(msg.phone, msg.channel);
        if (found) {
          const key = await store.askToLink({ userId: found.userId, contact, phone: msg.phone, askedOn: found.contact, at: now, text: linkAskText(msg.channel) });
          if (!key) return ok({ ignored: "link asked already" });
          try { await d.deliver({ userId: found.userId, key, now }); } catch (e) { console.error("inbound: the link question waits in the outbox:", e instanceof Error ? e.message : String(e)); }
          const r = await d.reply(contact, d.render(linkPendingReply(channelOf(found.contact))));
          return ok({ link: "asked", sent: r.ok });
        }
      }
      if (!signupAllows(d.env, contact, msg.phone)) {
        if (msg.sharedPhone === "own") {
          const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
          const r = await d.reply(contact, d.render(PHONE_NO_ACCOUNT_REPLY), { removeKeyboard: true });
          if (/^https:\/\//.test(loginUrl)) await d.reply(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
          return ok({ phone: "no_account", sent: r.ok });
        }
        // FEATURE 16: on Telegram, with the login page configured, the person links their existing account instead.
        const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
        if (msg.channel === "telegram" && /^https:\/\//.test(loginUrl)) {
          if (await store.refusedBefore(contact, now) && msg.command !== "start") return ok({ ignored: "not linked (already told)" });
          await d.reply(contact, d.render(SHARE_PHONE_ASK), { shareContact: SHARE_PHONE_BUTTON }).catch(() => ({ ok: false }));
          const r = await d.reply(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
          return ok({ link: "offered", sent: r.ok });
        }
        if (await store.refusedBefore(contact, now)) return ok({ ignored: "signup closed (already told)" });
        const r = await d.reply(contact, d.render(SIGNUP_CLOSED_REPLY));
        return ok({ refused: "signup closed", sent: r.ok });
      }
      person = await store.createPerson(contact, now, msg.phone ?? null);
      if (store.sawInbound) await store.sawInbound(contact, now, { alias: msg.alias ?? null, phone: msg.phone ?? null });
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
      const got = await d.resumeFile({ userId: person.userId, doc: msg.document, now });
      if (!got.ok) return await answer(got.reply, { file: "not read" });
      fileMessage = got.message;
    }
    // A yes to "Reply yes to link it", within the hour, on the channel that was asked.
    if (!tapped && YES.test(msg.text.trim()) && store.confirmLink) {
      const linked = await store.confirmLink({ userId: person.userId, askedOn: contact, at: now, notice: LINKED_HERE_REPLY });
      if (linked) {
        if (linked.key) { try { await d.deliver({ userId: person.userId, key: linked.key, now }); } catch { /* the outbox has it */ } }
        return await answer(linkedReply(channelOf(linked.contact)), { linked: channelOf(linked.contact) });
      }
    }
    // FEATURE 16: on Telegram, "link my account" offers Telegram's login; "unlink telegram" lets this chat go.
    if (msg.channel === "telegram" && !fileMessage) {
      const loginUrl = (d.env.get("TELEGRAM_LOGIN_URL") || "").trim();
      if (LINK_ASK.test(msg.text.trim()) && /^https:\/\//.test(loginUrl)) {
        const r = await d.reply(contact, d.render(TELEGRAM_LINK_REPLY), { buttons: [[{ text: LINK_BUTTON, loginUrl }]] });
        return ok({ link: "offered", sent: r.ok });
      }
      if (UNLINK_ASK.test(msg.text.trim()) && store.unlinkTelegram) {
        const n = await store.unlinkTelegram(person.userId, now);
        const r = await d.reply(contact, d.render(n < 0 ? TELEGRAM_CHANNEL_ONLY_REPLY : n ? TELEGRAM_UNLINKED_REPLY : "This chat isn't linked to a Trainee account, so there was nothing to unlink."));
        return ok({ unlinked: n, sent: r.ok });
      }
    }
    if (CONNECT_TELEGRAM.test(msg.text.trim()) && store.issueLinkNonce) {
      const bot = (d.env.get("TELEGRAM_BOT_USERNAME") || "").trim();
      const text = msg.channel === "telegram" ? ALREADY_TELEGRAM_REPLY
        : bot && d.env.get("TELEGRAM_BOT_TOKEN") ? connectTelegramReply(telegramDeepLink(bot, await store.issueLinkNonce(person.userId, now)))
        : TELEGRAM_NOT_WIRED_REPLY;
      return await answer(text, { connect: "telegram" });
    }

    let postings: unknown[] = [], cardsShown = 0, screenQidOut: string | null = null, shape: { attachments: ShapedFile[]; links: string[]; more?: string[] } | null = null;
    let reply: string, parts: string[] | null = null, artifacts: { ref: string; filename: string; mime: string }[] = [], turnThread: string | null = person.threadId;
    try {
      const turnKey = await turnKeyFor(msg.provider === "loopmessage" ? msg.messageId : `${msg.provider}:${msg.messageId}`);
      // Telegram's /start and /help come as a command with no text; the brain reads them as the command itself.
      const said = fileMessage ?? (msg.text || (command ? `/${command}` : ""));
      // The brain gets the person, the thread, the words and a turn key, and the reply-to id only when the platform gave one.
      const out = await d.chat({ userId: person.userId, threadId: person.threadId, message: said.slice(0, 4000), turnKey, ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}), ...(screenTap ? { screenTap } : {}) });
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
      turnThread = out.threadId ?? person.threadId;
      if (toBrain && command === "start") {
        reply = `${CHANNEL_REPLIES.start}\n\n${reply}`;
        if (parts) parts = [`${CHANNEL_REPLIES.start}\n\n${parts[0]}`, ...parts.slice(1)];
      }
      if (out.threadId && out.threadId !== person.threadId) await store.setThread(contact, out.threadId, person.userId);
    } catch (e) {
      console.error("inbound: chat failed:", e instanceof Error ? e.message : String(e));
      reply = CHAT_DOWN_REPLY;
    }
    // The reply is queued; sending it now is a head start on the every-minute run, never a second path. A failure there may
    // come after the provider took it, so it must not reach the catch below (which would also say "couldn't answer").
    // A reply in parts is one row per part (reply:<id>:<n>), each whole, sent in order.
    const rows = parts ? parts.map((text, i) => ({ key: `${key}:${i + 1}`, text, part: { of: key, n: i + 1 } })) : [{ key, text: fitReply(reply), part: undefined }];
    for (const r of rows) await store.enqueueReply(person.userId, r.key, r.text, now, msg.channel, r.part, cardId);
    try { for (const r of rows) await d.deliver({ userId: person.userId, key: r.key, now }); }
    catch (e) { console.error("inbound: immediate send failed (the outbox has it):", e instanceof Error ? e.message : String(e)); }
    // F09: the screen's yes/no question gets Yes / No buttons where the channel has them (Telegram), else the plain words.
    if (screenQidOut) {
      const buttons = msg.channel === "telegram" ? screenButtons(screenQidOut) : undefined;
      const already = /reply yes or no/i.test(reply) || (parts ?? []).some((p) => /reply yes or no/i.test(p));
      if (buttons || !already) await d.reply(contact, d.render(buttons ? "Yes or no?" : SCREEN_REPLY_YES_NO), buttons ? { buttons } : undefined).catch(() => ({ ok: false }));
    }
    // JOB CARDS: the postings this turn found, each as its own card after the reply that introduces them. A failure here never
    // changes what was already said; the reply's own words stand.
    if (postings.length && d.showPostings) {
      const shown = await d.showPostings({ userId: person.userId, contact, hits: postings }).catch((e) => { console.error("inbound: job cards failed:", e instanceof Error ? e.message : String(e)); return null; });
      if (shown) cardsShown = shown.sent;
    }
    // FEATURE 16: the documents, after the reply that names them; one that does not go is said, never claimed sent.
    let docs: { sent: number; failed: number } | null = null;
    if (artifacts.length && d.sendArtifacts) {
      docs = await d.sendArtifacts({ userId: person.userId, threadId: turnThread, contact, artifacts }).catch(() => ({ sent: 0, failed: artifacts.length }));
      if (docs.failed) await d.reply(contact, d.render(DOC_NOT_SENT_REPLY)).catch(() => ({ ok: false }));
    }
    // REPLY SHAPE: the answer went first; now each file, then each link, one message each, in that order. A step that fails is said.
    let shaped: { files: number; links: number } | null = null;
    if (shape?.more?.length) for (const m of shape.more.slice(0, 1)) await d.reply(contact, d.render(m)).catch(() => ({ ok: false }));
    if (shape && (d.sendFile || d.sendLink)) {
      const sf = d.sendFile, sl = d.sendLink;
      const r = await deliverShaped({ answer: "", attachments: shape.attachments, links: shape.links, notes: [] }, {
        document: async (f) => sf ? await sf({ contact, ...f }) : { ok: false }, link: async (url) => sl ? await sl({ contact, url }) : { ok: false } }, { includeAnswer: false });
      shaped = { files: r.files, links: r.links };
      if (r.files < shape.attachments.length) await d.reply(contact, d.render(DOC_NOT_SENT_REPLY)).catch(() => ({ ok: false }));
    }
    return ok({ replied: true, ...(shaped ? { shaped } : {}), ...(cardsShown ? { cards: cardsShown } : {}), ...(parts ? { parts: parts.length } : {}), ...(docs ? { documents: docs } : {}) });
  } catch (e) {
    console.error("inbound failed:", e instanceof Error ? e.message : String(e));
    try { await d.reply(contact, d.render(CHAT_DOWN_REPLY)); } catch { /* already logged */ }
    return { status: 500, body: { ok: false, error: "internal" } };
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
  for (const s of parsed.statuses ?? [] as StatusEvent[]) {
    if (s.hold && d.store.reholdSent) reheld += await d.store.reholdSent(s.providerMessageId, d.now(), s.error);
    else if (!s.hold) console.error(`${adapter.provider}: a sent message failed after it was accepted: ${s.error}`);
  }
  if (!parsed.messages.length) return json({ ok: true, ...(reheld ? { reheld } : {}), ignored: (parsed.ignored ?? [])[0] ?? "nothing to read" });
  const results: Record<string, unknown>[] = [];
  for (const m of parsed.messages) {
    const r = await runInbound(m, d);
    results.push(r.body);
  }
  return json({ ok: true, ...(reheld ? { reheld } : {}), results });
}
