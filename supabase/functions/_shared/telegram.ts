// Telegram as a texting channel (WO-038), over the Bot API. The official pages (core.telegram.org/bots/api,
// core.telegram.org/bots/faq) did not load from the build environment (DNS failure, proxy 403, 2026-10-20); each shape
// below is labeled with where it comes from, and the owner's smoke run checks them against the live bot.
//
// - Webhook: setWebhook's secret_token comes back on every update in X-Telegram-Bot-Api-Secret-Token, 1-256 of
//   A-Z a-z 0-9 _ - (SECONDARY: aiogram's mirror of https://core.telegram.org/bots/api#setwebhook).
// - Update: update_id is the update's unique id, the dedupe key (VERIFIED-S: https://core.telegram.org/bots/api#update).
//   message_id is unique only inside one chat, so it is never the key (ASSUMED: https://core.telegram.org/bots/api#message).
// - sendMessage: text 1-4,096 characters; no parse_mode, so the text is plain and nothing needs escaping (in MarkdownV2 an
//   unescaped "." fails the whole send); link_preview_options.is_disabled false keeps the preview of the first link
//   (ASSUMED field names: https://core.telegram.org/bots/api#sendmessage, #linkpreviewoptions).
// - Errors: {ok:false, error_code, description, parameters.retry_after}; 403 "Forbidden: bot was blocked by the user"
//   (SECONDARY) is the person's opt-out. A my_chat_member update whose new status is "kicked" is the same act, seen as it
//   happens (ASSUMED: https://core.telegram.org/bots/api#chatmemberupdated).
// - Pacing: no more than one message a second in one chat, about 30 a second overall (VERIFIED-S:
//   https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).
// - Deep links: t.me/<bot>?start=<payload>, payload up to 64 of A-Z a-z 0-9 _ -, arrives as "/start <payload>"
//   (SECONDARY: https://core.telegram.org/bots/features#deep-linking).
// Only private chats are read; a group's messages are ignored.
import { equalSecret } from "./message_service.ts";
import { type ChannelAdapter, type InboundMessage, packMessages, pacer, type ParseResult, type SendResult } from "./channel_adapters.ts";
import { formatForChannel, nativeRender, telegramPlain } from "./channel_voice.ts";
import { safeSlice, utf8Bytes } from "./channel_text.ts";
import { briefBubbles } from "./telegram_brief.ts";

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_CHARS = 4096;
export const TELEGRAM_CAPTION = 1024; // a photo's caption
// deno-lint-ignore no-explicit-any
// CHANNEL DELIVERY SCENARIOS (2026-10-29): a button's callback_data is 1 to 64 BYTES (Bot API, InlineKeyboardButton). It is
// sent exactly as made or the button is left off: a cut token is a different token (a tap that can never match its card),
// and a value over 64 bytes (any non-ASCII counts two to four) or empty made Telegram refuse the whole message, so the
// card's words never arrived. A label is cut at 64 characters, never inside one.
type KeyButton = { text: string; data?: string; loginUrl?: string; url?: string; webApp?: string };
const buttonOf = (b: KeyButton) => {
  const text = safeSlice(String(b.text ?? ""), 64);
  if (b.webApp) return { text, web_app: { url: b.webApp } };
  if (b.url) return { text, url: b.url };
  if (b.loginUrl) return { text, login_url: { url: b.loginUrl, request_write_access: true } };
  const data = String(b.data ?? "");
  return data && utf8Bytes(data) <= 64 ? { text, callback_data: data } : null;
};
// deno-lint-ignore no-explicit-any
export const inlineKeyboard = (rows: KeyButton[][]): any => ({ inline_keyboard: rows.map((row) => row.map(buttonOf).filter((b) => b !== null)).filter((row) => row.length) });
const keyboardOf = (rows: KeyButton[][] | undefined) => {
  const k = rows?.length ? inlineKeyboard(rows) : null;
  return k && k.inline_keyboard.length ? k : null;
};
export const TELEGRAM_FILE_MAX = 20 * 1024 * 1024; // what a bot may download (getFile)
const PACK = 1500; // the texting rule: one message carries at most 1,500 characters, longer text is split on purpose
// A 429's retry_after waited in place: up to 5 s for a reply's first message (a longer wait goes back to the outbox, nothing
// having gone out), up to 30 s once part of the reply went out (the rest would otherwise be lost: it cannot be sent alone).
export const WAIT_IN_PLACE_S = 5, WAIT_MID_REPLY_S = 30;
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
// TELEGRAM BRIEF (brief P1.2): every message of an answer is threaded as a reply to the person's message (reply_to_message_id;
// allow_sending_without_reply so a message the person deleted never stops the answer). ASSUMED field names, Bot API.
const threaded = (replyTo: string | null | undefined) => {
  const id = Number(replyTo);
  return Number.isSafeInteger(id) && id > 0 ? { reply_to_message_id: id, allow_sending_without_reply: true } : {};
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function telegramDeepLink(botUsername: string, nonce: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?start=${nonce}`;
}

// A Telegram update as zero or one inbound message. Exported for tests and the smoke check.
// deno-lint-ignore no-explicit-any
// KNOWN GAPS (2026-10-30, #311): a tap on a button in a group (a card forwarded there) was ignored without an answer, so the
// button spun until Telegram gave up. It is still never read (no account, no card, no data), but its callback is answered
// with this line, which carries nothing of the person's.
export const GROUP_TAP_ANSWER = "This button works in your private chat with me.";
// TELEGRAM ROUND 3 (2026-10-31): a tap whose sender is not the private chat its message is in (callback_query.from.id is not
// message.chat.id) is not that chat's person tapping their own card. It ran as the chat's account: someone else's Confirm
// approved the chat owner's application and the answer went to the owner. It is answered with this line and does nothing.
export const NOT_YOUR_TAP_ANSWER = "That button isn't yours, so nothing was done.";
export function parseTelegramUpdate(u: any): { message: InboundMessage | null; ignored?: string; answerTap?: string; answerText?: string } {
  if (!u || typeof u !== "object" || !Number.isSafeInteger(u.update_id)) return { message: null, ignored: "not a Telegram update" };
  const messageId = String(u.update_id);
  const member = u.my_chat_member;
  if (member && typeof member === "object") {
    const chat = member.chat;
    if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || chat.id <= 0) return { message: null, ignored: "not a private chat" };
    if (member.new_chat_member?.status !== "kicked") return { message: null, ignored: `chat member status ${String(member.new_chat_member?.status ?? "").slice(0, 20)}` };
    return { message: { provider: "telegram", channel: "telegram", messageId, kind: "blocked", contact: `tg:${chat.id}`, address: String(chat.id), text: "" } };
  }
  // FEATURE 16: a tap on a button Trainee sent (the card's Approve or Decline) arrives as callback_query, in the chat the
  // button's message is in (callback_query.message.chat; https://core.telegram.org/bots/api#callbackquery, ASSUMED field
  // names, the same shape telegram_bridge.ts reads on the live test bridge).
  // Review of PR #194: a tap whose callback carries no message (Telegram leaves it out when the message is too old) is still
  // a tap by that user; in a private chat the chat id is the user's id (callback_query.from.id), so it is answered there
  // and never left spinning. Its data is still checked; it approves nothing it would not approve with the message.
  const cb = u.callback_query;
  if (cb && typeof cb === "object") {
    if (cb.id === undefined || cb.id === null) return { message: null, ignored: "not a button tap" };
    if (cb.from?.is_bot) return { message: null, ignored: "from a bot" };
    const chat = cb.message?.chat;
    const chatId = chat ? (chat.type === "private" ? chat.id : null) : cb.from?.id;
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return { message: null, ignored: "not a private chat", answerTap: String(cb.id).slice(0, 100) };
    if (chat && cb.from?.id !== chatId) return { message: null, ignored: "a tap by someone other than the chat's person", answerTap: String(cb.id).slice(0, 100), answerText: NOT_YOUR_TAP_ANSWER };
    const data = typeof cb.data === "string" && cb.data.length <= 64 ? cb.data : "";
    return { message: { provider: "telegram", channel: "telegram", messageId, kind: "callback", contact: `tg:${chatId}`, address: String(chatId), text: "",
      callback: { id: String(cb.id).slice(0, 100), data, messageId: Number.isSafeInteger(cb.message?.message_id) ? String(cb.message.message_id) : null } } };
  }
  // TELEGRAM ROUND 3 (2026-10-31): an edit (edited_message) was ignored without a word, so a "yes" edited into "no" after
  // Trainee acted on the yes read as taken back. It is still never read as a message (no turn, no command, no yes); in a
  // private chat it is passed on as an edit, and the inbound core answers a decision edited after the fact (channel_inbound.ts).
  const e = u.edited_message;
  if (e && typeof e === "object" && !u.message) {
    if (e.chat?.type !== "private" || !Number.isSafeInteger(e.chat.id) || e.chat.id <= 0) return { message: null, ignored: "not a private chat" };
    if (e.from?.is_bot || e.from?.id !== e.chat.id) return { message: null, ignored: "an edit by someone other than the chat's person" };
    const t = typeof e.text === "string" ? e.text : typeof e.caption === "string" ? e.caption : "";
    return { message: { provider: "telegram", channel: "telegram", messageId, kind: "edited", contact: `tg:${e.chat.id}`, address: String(e.chat.id), text: safeSlice(t, 200) } };
  }
  const m = u.message;
  if (!m || typeof m !== "object") return { message: null, ignored: "not a new message" }; // channel posts
  if (m.chat?.type !== "private" || !Number.isSafeInteger(m.chat.id) || m.chat.id <= 0) return { message: null, ignored: "not a private chat" };
  if (m.from?.is_bot) return { message: null, ignored: "from a bot" };
  // SERIAL-1462: a reply in Telegram carries the replied-to message as message.reply_to_message (Bot API); its message_id
  // is the id sendMessage returned when that message went out.
  const repliedTo = m.reply_to_message && typeof m.reply_to_message === "object" && Number.isSafeInteger(m.reply_to_message.message_id) ? String(m.reply_to_message.message_id) : null;
  // TELEGRAM ROUND 2 (2026-10-30): a forwarded message (forward_origin; the older forward_from / forward_from_chat /
  // forward_sender_name) is someone else's words the person passed on: never their command, their yes, a link nonce or
  // their own contact card.
  const forwardedFrom = forwardOrigin(m);
  // TELEGRAM BRIEF: the person's own message id, for the reply thread and the reaction (brief P1.1, P1.2).
  const platformMessageId = Number.isSafeInteger(m.message_id) && m.message_id > 0 ? String(m.message_id) : null;
  const base = { provider: "telegram" as const, channel: "telegram" as const, messageId, contact: `tg:${m.chat.id}`, address: String(m.chat.id), replyToMessageId: repliedTo, platformMessageId,
    ...(forwardedFrom ? { forwardedFrom } : {}) };
  // FEATURE 16: a document (a resume as a PDF or Word file) is read: getFile, then the file itself (channel_inbound.ts).
  // message.document: file_id (to download), file_unique_id (stable across bots and time), file_name, mime_type,
  // file_size (https://core.telegram.org/bots/api#document, ASSUMED field names). Its caption is the message text.
  // TELEGRAM ROUND 2: a GIF (message.animation) carries message.document too, for old clients; it is a GIF, not a file, and
  // was read as a resume ("That file is neither a PDF nor a Word file"). It is left alone, as a sticker is (or its caption
  // read). Every cut is on a whole character (a name cut inside an emoji was refused by the database when it was stored).
  const d = m.animation ? null : m.document;
  if (d && typeof d === "object" && typeof d.file_id === "string" && d.file_id && typeof d.file_unique_id === "string" && d.file_unique_id) {
    return { message: { ...base, kind: "text", text: typeof m.caption === "string" ? safeSlice(withLinks(m.caption, m.caption_entities), 1000) : "",
      document: { fileId: safeSlice(d.file_id, 300), uniqueId: safeSlice(d.file_unique_id, 120), name: safeSlice(String(d.file_name ?? "resume"), 200) || "resume",
        mime: safeSlice(String(d.mime_type ?? ""), 120), size: Number.isSafeInteger(d.file_size) ? d.file_size : null } } };
  }
  // PHONE LOGIN (owner, 2026-10-28): the "Share my phone number" button (request_contact) comes back as message.contact
  // {phone_number, user_id} (https://core.telegram.org/bots/api#contact, ASSUMED field names). It is the sender's own number
  // only when contact.user_id is the sender's id; anyone can forward another person's contact card, and that proves nothing.
  const sc = m.contact;
  if (sc && typeof sc === "object") {
    const digits = String(sc.phone_number ?? "").replace(/[^0-9]/g, "");
    const own = !forwardedFrom && Number.isSafeInteger(sc.user_id) && sc.user_id === m.from?.id && digits.length >= 8 && digits.length <= 15;
    return { message: { ...base, kind: "text", text: "", sharedPhone: own ? "own" : "other", ...(own ? { phone: `+${digits}` } : {}) } };
  }
  // FEATURE 16: a photo or a file Trainee can't read, and a voice, audio or video message, each get a plain answer (never
  // silence); a sticker is still left alone.
  const media = m.voice || m.audio || m.video || m.video_note ? "voice" : m.photo || m.animation ? "photo" : m.document ? "file" : null;
  if (typeof m.text !== "string" || !m.text.trim()) {
    // TELEGRAM ROUND 2: the words sent WITH a photo, a video or a GIF (its caption) were dropped: a job post forwarded from a
    // channel (the flyer, with the role, the pay and its "Apply here" link as the caption) got "I can't read photos". The
    // caption is now read as the message (never as a command); the person is told the picture itself was not seen.
    const caption = typeof m.caption === "string" && m.caption.trim() && (media === "photo" || media === "voice") ? withLinks(m.caption, m.caption_entities) : "";
    if (caption) return { message: { ...base, kind: "text", text: caption, media: media as "photo" | "voice", caption: true } };
    if (m.animation) return { message: null, ignored: "a GIF (left alone, as a sticker is)" };
    return { message: { ...base, kind: "seen", text: "", file: !!(m.document || m.photo), ...(media ? { media } : {}) }, ignored: "no text (attachments are not read yet)" };
  }
  const cmd = forwardedFrom ? null : /^\/(start|stop|help)(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?\s*$/i.exec(m.text.trim());
  if (cmd) {
    const command = cmd[1].toLowerCase() as "start" | "stop" | "help";
    const payload = command === "start" && cmd[2] && /^[A-Za-z0-9_-]{1,64}$/.test(cmd[2]) ? cmd[2] : null;
    // TELEGRAM LINK OWNERSHIP (2026-10-31): who opened a link code, as Telegram names them (message.from.username), for the
    // question asked on the account's own channel; anything not shaped like a username is left out (it is the opener's text).
    const handle = payload && typeof m.from?.username === "string" && /^[A-Za-z0-9_]{5,32}$/.test(m.from.username) ? m.from.username : null;
    return { message: { ...base, kind: "text", text: m.text, command, startPayload: payload, ...(handle ? { senderHandle: handle } : {}) } };
  }
  // TELEGRAM ROUND 2: "Apply here" as a link (a text_link entity: the words show, the URL rides beside them) reached the
  // brain as the bare words, the URL lost. Each such link is written after its words.
  return { message: { ...base, kind: "text", text: withLinks(m.text, m.entities) } };
}
// TELEGRAM ROUND 2: who a forwarded message came from, as Telegram names it (forward_origin: user, hidden_user, chat,
// channel; https://core.telegram.org/bots/api#messageorigin, ASSUMED; the fields before Bot API 7.0 as a fallback).
// deno-lint-ignore no-explicit-any
export function forwardOrigin(m: any): string | null {
  // deno-lint-ignore no-explicit-any
  const nameOf = (x: any) => safeSlice([x?.first_name, x?.last_name].filter((v) => typeof v === "string" && v.trim()).join(" ").trim(), 80);
  // deno-lint-ignore no-explicit-any
  const chatName = (c: any) => safeSlice(String(c?.title ?? (c?.username ? `@${c.username}` : "")), 80);
  const o = m?.forward_origin;
  if (o && typeof o === "object") {
    const n = o.type === "user" ? nameOf(o.sender_user) : o.type === "hidden_user" ? safeSlice(String(o.sender_user_name ?? ""), 80)
      : o.type === "chat" ? chatName(o.sender_chat) : o.type === "channel" ? chatName(o.chat) : "";
    return n.trim() || "someone";
  }
  if (m?.forward_from_chat) return chatName(m.forward_from_chat).trim() || "someone";
  if (m?.forward_from) return nameOf(m.forward_from).trim() || "someone";
  if (typeof m?.forward_sender_name === "string" || Number.isSafeInteger(m?.forward_date)) return safeSlice(String(m.forward_sender_name ?? ""), 80).trim() || "someone";
  return null;
}
// TELEGRAM ROUND 2: a text_link entity's URL written after its words ("Apply here (https://...)"). Offsets are UTF-16 code
// units, as JavaScript strings index them (https://core.telegram.org/bots/api#messageentity). Only http(s) links; words that
// already are the URL, or a URL already in the text, are left as they are.
// deno-lint-ignore no-explicit-any
export function withLinks(text: string, entities: any): string {
  const s = String(text ?? "");
  if (!Array.isArray(entities)) return s;
  // deno-lint-ignore no-explicit-any
  const links = entities.filter((e: any) => e && e.type === "text_link" && typeof e.url === "string" && /^https?:\/\/\S+$/i.test(e.url) && e.url.length <= 2048
    && Number.isSafeInteger(e.offset) && Number.isSafeInteger(e.length) && e.offset >= 0 && e.length > 0 && e.offset + e.length <= s.length)
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => b.offset - a.offset);
  let out = s, floor = Infinity;
  for (const e of links) {
    const end = e.offset + e.length;
    if (end > floor) continue; // overlapping entities: the later-starting one stands
    floor = e.offset;
    if (s.includes(e.url)) continue;
    out = `${out.slice(0, end)} (${e.url})${out.slice(end)}`;
  }
  return out;
}

// V1 TEXTING VOICE (CAREER_TEXTING_NATIVE=on, `native`): messages split on the reply's own words (channel_voice.ts), light
// formatting sent with parse_mode HTML (bold, italic, code; everything else escaped), sent again as plain text if Telegram
// refuses the markup (a 400 "can't parse entities" means nothing was delivered); and the typing indicator, sendChatAction
// "typing", which "is set for 5 seconds or less (when a message arrives from your bot, Telegram clients clear its typing
// status)" (https://core.telegram.org/bots/api#sendchataction, read through docs.aiogram.dev/en/latest/api/methods/
// send_chat_action.html, which mirrors it; core.telegram.org is not reachable from the build environment). The Bot API has
// no read receipt for a private chat (readBusinessMessage is for business connections only), so none is sent.
export function telegramAdapter(o: {
  token: string; webhookSecret?: string; fetch?: typeof fetch; timeoutMs?: number;
  clock?: () => number; sleep?: (ms: number) => Promise<void>; native?: boolean; brief?: boolean;
}): ChannelAdapter {
  const f = o.fetch ?? fetch, timeout = o.timeoutMs ?? 15000;
  const pace = pacer({ perChatMs: 1000, overallPerSecond: 30, clock: o.clock, sleep: o.sleep });
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The token rides in the URL; nothing that may be logged carries it.
  const redact = (s: string) => (o.token ? s.split(o.token).join("***") : s);
  // TELEGRAM SCENARIOS (2026-10-30): a 429 says how long to wait (parameters.retry_after, seconds). It was never read: the row
  // went back for the fixed backoff (a minute, then five), early whenever Telegram asked for longer, and a 429 on the second
  // message of a reply ended the reply there ("after 1 of 3 messages went out"), the rest never sent. Now a short wait is
  // waited here, before the same call is made again (nothing went out with a 429, so nothing is sent twice); a longer one is
  // handed back (retryAfterMs) for the outbox to wait at least that long.
  const retryAfterOf = (b: any): number | null => { const n = Number(b?.parameters?.retry_after); return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null; };
  const call = async (method: string, body: unknown, waitUpToS = WAIT_IN_PLACE_S): Promise<{ status: number; body: any } | { error: unknown }> => {
    for (let tries = 0; ; tries++) {
      let out: { status: number; body: any };
      try {
        const res = await f(`${TELEGRAM_API}/bot${o.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        out = { status: res.status, body: await res.json().catch(() => null) };
      } catch (e) { return { error: e }; }
      const ra = out.status === 429 ? retryAfterOf(out.body) : null;
      if (ra === null || ra > waitUpToS || tries >= 2) return out;
      await sleep(ra * 1000 + 50);
    }
  };
  return {
    channel: "telegram", provider: "telegram",
    limits: { chars: TELEGRAM_CHARS, packChars: PACK, perChatGapMs: 1000, overallPerSecond: 30, windowMs: null, dailyContacts: null, dailyTemplates: null },
    capabilities: { buttons: true, documents: true, previews: true, templates: false },
    // TELEGRAM BRIEF (brief P1.2, P1.3, P2): bubbles of at most about three sentences, one idea each, no visible markdown, each
    // link its own message after its line of context; with the texting voice on, the same bubbles in its HTML.
    render: o.brief ? (o.native ? (text) => briefBubbles(text, PACK).map((b) => formatForChannel(b, "telegram")).filter((b) => b.trim()) : (text) => briefBubbles(text, PACK))
      : o.native ? nativeRender("telegram", PACK) : (text) => packMessages(text, PACK),
    // KNOWN GAPS (2026-10-30, #311): with the texting voice on, send() goes with parse_mode HTML, so text that did not come
    // through render (a job card's text) must be escaped by its sender (htmlText).
    ...(o.native ? { htmlText: true } : {}),
    typingEveryMs: 4000,
    async typing(address): Promise<boolean> {
      const r = await call("sendChatAction", { chat_id: Number(address), action: "typing" }, 0); // N12: never waits on a 429
      return !("error" in r) && r.status === 200 && r.body?.ok === true;
    },
    async parseInbound(req): Promise<ParseResult> {
      if (req.method !== "POST") return { response: json({ error: "Method not allowed" }, 405) };
      const secret = o.webhookSecret ?? "";
      if (!SECRET_RE.test(secret)) return { response: json({ error: "not configured: TELEGRAM_WEBHOOK_SECRET must be 32 to 256 of A-Z a-z 0-9 _ -" }, 503) };
      if (!equalSecret(req.headers.get("x-telegram-bot-api-secret-token") || "", secret)) return { response: json({ error: "forbidden" }, 403) };
      if (!o.token) return { response: json({ error: "NOT_WIRED: TELEGRAM_BOT_TOKEN is not set; no turn was run" }, 503) };
      const r = parseTelegramUpdate(await req.json().catch(() => null));
      // KNOWN GAPS (#311): a tap outside a private chat is answered (never left spinning), and nothing else is done with it.
      if (r.answerTap) {
        const a = await call("answerCallbackQuery", { callback_query_id: r.answerTap, text: r.answerText ?? GROUP_TAP_ANSWER });
        if ("error" in a || a.status !== 200) console.error("telegram: a tap outside a private chat was not answered:", "error" in a ? redact(String(a.error)).slice(0, 120) : `HTTP ${a.status}`);
      }
      return { messages: r.message ? [r.message] : [], ignored: r.ignored ? [r.ignored] : [] };
    },
    // FEATURE 16: getFile names the file's path and its size, and the file is downloaded from /file/bot<token>/<file_path>
    // (https://core.telegram.org/bots/api#getfile, ASSUMED; bots download files of up to 20 MB). Review of PR #194: the size
    // getFile reports is checked first (missing, or over the cap or Telegram's 20 MB: refused, nothing downloaded), then
    // the download is read as a stream and stopped the moment it passes the cap, never read whole first. The token never
    // leaves this function in an error.
    async fetchFile(fileId, maxBytes): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
      const cap = Math.min(maxBytes, TELEGRAM_FILE_MAX);
      const r = await call("getFile", { file_id: fileId });
      if ("error" in r) return { ok: false, error: redact(`Telegram unreachable: ${r.error instanceof Error ? r.error.message : String(r.error)}`).slice(0, 200) };
      const path = r.body?.result?.file_path, size = r.body?.result?.file_size;
      // TELEGRAM ROUND 2: a file over the 20 MB a bot may download is refused by getFile itself (400 "file is too big") when the
      // message did not state its size; that read "I couldn't download that file just now. Send it again in a minute", which
      // never works. It is too large, and said so.
      if (r.status === 400 && /too big|too large/i.test(String(r.body?.description ?? ""))) return { ok: false, error: "too_large" };
      if (r.status !== 200 || r.body?.ok !== true || typeof path !== "string" || !path) return { ok: false, error: `Telegram getFile HTTP ${r.status}: ${redact(String(r.body?.description ?? "no file path")).slice(0, 120)}` };
      if (!Number.isSafeInteger(size) || size < 1) return { ok: false, error: "Telegram getFile gave no file size" };
      if (size > cap) return { ok: false, error: "too_large" };
      try {
        const res = await f(`${TELEGRAM_API}/file/bot${o.token}/${path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(timeout) });
        if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); return { ok: false, error: `Telegram file HTTP ${res.status}` }; }
        const reader = res.body.getReader(), chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > cap) { await reader.cancel().catch(() => {}); return { ok: false, error: "too_large" }; }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) { bytes.set(c, at); at += c.length; }
        return { ok: true, bytes };
      } catch (e) { return { ok: false, error: redact(`Telegram file unreachable: ${e instanceof Error ? e.message : String(e)}`).slice(0, 200) }; }
    },
    // FEATURE 16: a document as a file (sendDocument, multipart; https://core.telegram.org/bots/api#senddocument, ASSUMED):
    // the bytes themselves, never a link to them.
    async sendDocument(address, doc): Promise<SendResult> {
      await pace(address);
      try {
        const form = new FormData();
        form.append("chat_id", String(Number(address)));
        form.append("document", new Blob([doc.bytes as BlobPart], { type: doc.mime || "application/octet-stream" }), doc.filename.replace(/[\\/]/g, "_").slice(0, 120) || "document.pdf");
        const res = await f(`${TELEGRAM_API}/bot${o.token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(timeout) });
        const body = await res.json().catch(() => null);
        if (res.status === 200 && body?.ok === true) return { ok: true, id: body?.result?.message_id != null ? String(body.result.message_id) : null };
        return { ok: false, error: `Telegram sendDocument HTTP ${res.status}: ${redact(String(body?.description ?? "")).slice(0, 120)}`, retryable: false };
      } catch (e) { return { ok: false, error: redact(`Telegram unreachable: ${e instanceof Error ? e.message : String(e)}`).slice(0, 200), retryable: false }; }
    },
    // REPLY SHAPE: a link alone in its message, preview on for exactly that URL (link_preview_options {is_disabled:false, url};
    // https://core.telegram.org/bots/api#linkpreviewoptions, ASSUMED field names), so Telegram shows the title and image card.
    async sendLink(address, url, lo): Promise<SendResult> {
      await pace(address);
      const r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(url, TELEGRAM_CHARS), link_preview_options: { is_disabled: false, url, prefer_large_media: true }, ...threaded(lo?.replyTo),
        ...(keyboardOf(lo?.buttons) ? { reply_markup: keyboardOf(lo?.buttons) } : {}) });
      if ("error" in r) return { ok: false, error: redact(`Telegram unreachable: ${r.error instanceof Error ? r.error.message : String(r.error)}`).slice(0, 200), retryable: false };
      if (r.status === 200 && r.body?.ok === true) return { ok: true, id: r.body?.result?.message_id != null ? String(r.body.result.message_id) : null };
      // TELEGRAM ROUND 3: a 429 says how long to wait, so the link waits that long in the outbox (channel_inbound.ts).
      const ra = r.status === 429 ? retryAfterOf(r.body) : null;
      return { ok: false, error: `Telegram sendLink HTTP ${r.status}: ${redact(String(r.body?.description ?? "")).slice(0, 120)}`, retryable: false, ...(ra !== null ? { retryAfterMs: ra * 1000 } : {}) };
    },
    // TELEGRAM BRIEF (brief P1.1): the eyes reaction on the person's message (setMessageReaction, reaction [{type:"emoji",
    // emoji}]; https://core.telegram.org/bots/api#setmessagereaction, ASSUMED field names, as aiogram mirrors them). Best
    // effort: a refusal (an older client, a reaction not allowed in the chat) is false, and the caller says one line instead.
    async react(address, messageId, emoji): Promise<boolean> {
      const r = await call("setMessageReaction", { chat_id: Number(address), message_id: Number(messageId), reaction: [{ type: "emoji", emoji }] }, 0);
      return !("error" in r) && r.status === 200 && r.body?.ok === true;
    },
    // FEATURE 16: every tap is answered once, so the person's button stops spinning (answerCallbackQuery; ASSUMED).
    async answerCallback(callbackId, text): Promise<boolean> {
      const r = await call("answerCallbackQuery", { callback_query_id: callbackId, text: String(text ?? "").slice(0, 200) });
      return !("error" in r) && r.status === 200 && r.body?.ok === true;
    },
    // JOB CARDS (owner, 2026-10-28): the company logo with the posting as its caption (sendPhoto; photo by public URL, caption
    // at most 1,024 characters, plain text; https://core.telegram.org/bots/api#sendphoto, ASSUMED). A refusal (Telegram could
    // not fetch the logo) is a plain failure, and the caller sends the same card as text.
    async sendPhoto(address, p): Promise<SendResult> {
      await pace(address);
      const r = await call("sendPhoto", { chat_id: Number(address), photo: p.photoUrl, caption: safeSlice(p.caption, TELEGRAM_CAPTION),
        ...(keyboardOf(p.buttons) ? { reply_markup: keyboardOf(p.buttons) } : {}) });
      if ("error" in r) return { ok: false, error: redact(`Telegram unreachable: ${r.error instanceof Error ? r.error.message : String(r.error)}`).slice(0, 200), retryable: false };
      if (r.status === 200 && r.body?.ok === true) return { ok: true, id: r.body?.result?.message_id != null ? String(r.body.result.message_id) : null };
      return { ok: false, error: `Telegram sendPhoto HTTP ${r.status}: ${redact(String(r.body?.description ?? "")).slice(0, 120)}`, retryable: false };
    },
    // JOB CARDS: Details on a text card expands it in place (editMessageText, ASSUMED); a photo card's caption is edited with
    // editMessageCaption. "message is not modified" (the same words twice) is not a failure.
    async editMessage(address, messageId, e): Promise<SendResult> {
      const photo = !!e.caption;
      const r = await call(photo ? "editMessageCaption" : "editMessageText", { chat_id: Number(address), message_id: Number(messageId),
        ...(photo ? { caption: safeSlice(e.text, TELEGRAM_CAPTION) } : { text: safeSlice(e.text, TELEGRAM_CHARS), link_preview_options: { is_disabled: true } }),
        ...(e.buttons ? { reply_markup: inlineKeyboard(e.buttons) } : {}) });
      if ("error" in r) return { ok: false, error: redact(`Telegram unreachable: ${r.error instanceof Error ? r.error.message : String(r.error)}`).slice(0, 200), retryable: false };
      if (r.status === 200 && r.body?.ok === true) return { ok: true, id: String(messageId) };
      if (r.status === 400 && /not modified/i.test(String(r.body?.description ?? ""))) return { ok: true, id: String(messageId) };
      return { ok: false, error: `Telegram edit HTTP ${r.status}: ${redact(String(r.body?.description ?? "")).slice(0, 120)}`, retryable: false };
    },
    async send(address, bubbles, opts): Promise<SendResult> {
      if (!bubbles.length) return { ok: false, error: "nothing to send: the message has no text", retryable: false };
      const ids: string[] = [];
      // retryAfterMs counts from when send began (the outbox adds it to the run's time): a 429 on a later message comes
      // after the pacing of the earlier ones.
      const now = o.clock ?? Date.now, t0 = now();
      for (let i = 0; i < bubbles.length; i++) {
        await pace(address);
        const after = i ? ` after ${i} of ${bubbles.length} messages went out` : "";
        // FEATURE 16: buttons (the card's Approve and Decline) ride the last part, under the whole card.
        const last = i === bubbles.length - 1;
        // PHONE LOGIN: a reply keyboard with one request_contact button (the person taps once; Telegram sends their own
        // verified number), or the removal of that keyboard once the number arrived.
        const keyboard = last && opts?.shareContact
          ? { reply_markup: { keyboard: [[{ text: opts.shareContact.slice(0, 64), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
          : last && opts?.removeKeyboard ? { reply_markup: { remove_keyboard: true } }
          : last && keyboardOf(opts?.buttons) ? { reply_markup: keyboardOf(opts?.buttons) } : {};
        const wait = i ? WAIT_MID_REPLY_S : WAIT_IN_PLACE_S;
        // TELEGRAM ROUND 2 (2026-10-30): HTML longer than 4,096 (a job page of 3,600-3,800 characters whose "&" and "<" were
        // escaped: "R&D" is "R&amp;D") was cut at 4,096: inside an entity (Telegram refuses it: a 400, then the plain resend)
        // or silently, its last lines lost; on the Apply page that was the end of the payload Confirm approves. Such a message
        // goes as its plain text, which fits whole.
        const html = !!o.native && !(bubbles[i].length > TELEGRAM_CHARS && telegramPlain(bubbles[i]).length <= TELEGRAM_CHARS);
        const text = html || !o.native ? bubbles[i] : telegramPlain(bubbles[i]);
        let r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(text, TELEGRAM_CHARS), link_preview_options: { is_disabled: false }, ...(html ? { parse_mode: "HTML" } : {}), ...keyboard, ...threaded(opts?.replyTo) }, wait);
        // V1: Telegram refused the markup, so nothing went out; the same words go again as plain text.
        if (html && !("error" in r) && r.status === 400 && /parse entities|can't find end|unsupported start tag/i.test(String(r.body?.description ?? ""))) {
          r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(telegramPlain(bubbles[i]), TELEGRAM_CHARS), link_preview_options: { is_disabled: false }, ...keyboard, ...threaded(opts?.replyTo) }, wait);
        }
        // CHANNEL DELIVERY ROUND 2 (2026-10-30): what went out before a failure is reported (sent, sentIds), so a failure on
        // the 2nd+ message that certainly sent nothing (a 429 asking for more than WAIT_MID_REPLY_S, 502, 503, a connection
        // that never opened) is retried from that message (career_outbox.sent_parts): the rest is no longer lost ("after 1 of
        // 3 messages went out") and nothing already sent goes again.
        const partial = i ? { sent: i, sentIds: [...ids] } : {};
        if ("error" in r) {
          const e = r.error, timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
          // TELEGRAM ROUND 3 (2026-10-31): a timeout on a message that is not the reply's last ended the reply there (failed,
          // never retried), so every message after it was lost. The message that timed out most likely went out (Telegram
          // took it and its answer never came back), so it is counted as sent, never sent twice, and the rest goes again
          // from the next message (career_outbox.sent_parts). A timeout on the last message is still reported as is.
          if (timedOut && i < bubbles.length - 1) return { ok: false, error: `Telegram timed out on message ${i + 1} of ${bubbles.length} (counted as delivered; the rest goes again)`, retryable: true, sent: i + 1, sentIds: [...ids] };
          return timedOut ? { ok: false, error: `Telegram timed out (it may have been delivered)${after}`, retryable: false, ...partial }
            : { ok: false, error: redact(`Telegram unreachable: ${e instanceof Error ? e.message : String(e)}`).slice(0, 200) + after, retryable: true, ...partial };
        }
        if (r.status === 200 && r.body?.ok === true) { const id = r.body?.result?.message_id; if (id !== undefined && id !== null) ids.push(String(id)); continue; }
        const desc = redact(String(r.body?.description ?? "")).slice(0, 120);
        if (r.status === 403 && /blocked|deactivated/i.test(desc)) return { ok: false, error: `Telegram 403: ${desc}${after}`, retryable: false, optOut: true, ...partial };
        const ra = r.status === 429 ? retryAfterOf(r.body) : null;
        return { ok: false, error: `Telegram HTTP ${r.status}${desc ? `: ${desc}` : ""}${after}`, retryable: r.status === 429 || r.status === 502 || r.status === 503, ...(ra !== null ? { retryAfterMs: ra * 1000 + Math.max(0, now() - t0) } : {}), ...partial };
      }
      return { ok: true, id: ids[0] ?? null, ids };
    },
  };
}
