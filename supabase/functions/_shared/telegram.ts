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
import { nativeRender, telegramPlain } from "./channel_voice.ts";
import { safeSlice, utf8Bytes } from "./channel_text.ts";

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
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function telegramDeepLink(botUsername: string, nonce: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?start=${nonce}`;
}

// A Telegram update as zero or one inbound message. Exported for tests and the smoke check.
// deno-lint-ignore no-explicit-any
export function parseTelegramUpdate(u: any): { message: InboundMessage | null; ignored?: string } {
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
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return { message: null, ignored: "not a private chat" };
    const data = typeof cb.data === "string" && cb.data.length <= 64 ? cb.data : "";
    return { message: { provider: "telegram", channel: "telegram", messageId, kind: "callback", contact: `tg:${chatId}`, address: String(chatId), text: "",
      callback: { id: String(cb.id).slice(0, 100), data, messageId: Number.isSafeInteger(cb.message?.message_id) ? String(cb.message.message_id) : null } } };
  }
  const m = u.message;
  if (!m || typeof m !== "object") return { message: null, ignored: "not a new message" }; // edits, channel posts
  if (m.chat?.type !== "private" || !Number.isSafeInteger(m.chat.id) || m.chat.id <= 0) return { message: null, ignored: "not a private chat" };
  if (m.from?.is_bot) return { message: null, ignored: "from a bot" };
  // SERIAL-1462: a reply in Telegram carries the replied-to message as message.reply_to_message (Bot API); its message_id
  // is the id sendMessage returned when that message went out.
  const repliedTo = m.reply_to_message && typeof m.reply_to_message === "object" && Number.isSafeInteger(m.reply_to_message.message_id) ? String(m.reply_to_message.message_id) : null;
  const base = { provider: "telegram" as const, channel: "telegram" as const, messageId, contact: `tg:${m.chat.id}`, address: String(m.chat.id), replyToMessageId: repliedTo };
  // FEATURE 16: a document (a resume as a PDF or Word file) is read: getFile, then the file itself (channel_inbound.ts).
  // message.document: file_id (to download), file_unique_id (stable across bots and time), file_name, mime_type,
  // file_size (https://core.telegram.org/bots/api#document, ASSUMED field names). Its caption is the message text.
  const d = m.document;
  if (d && typeof d === "object" && typeof d.file_id === "string" && d.file_id && typeof d.file_unique_id === "string" && d.file_unique_id) {
    return { message: { ...base, kind: "text", text: typeof m.caption === "string" ? m.caption.slice(0, 1000) : "",
      document: { fileId: d.file_id.slice(0, 300), uniqueId: d.file_unique_id.slice(0, 120), name: String(d.file_name ?? "resume").slice(0, 200) || "resume",
        mime: String(d.mime_type ?? "").slice(0, 120), size: Number.isSafeInteger(d.file_size) ? d.file_size : null } } };
  }
  // PHONE LOGIN (owner, 2026-10-28): the "Share my phone number" button (request_contact) comes back as message.contact
  // {phone_number, user_id} (https://core.telegram.org/bots/api#contact, ASSUMED field names). It is the sender's own number
  // only when contact.user_id is the sender's id; anyone can forward another person's contact card, and that proves nothing.
  const sc = m.contact;
  if (sc && typeof sc === "object") {
    const digits = String(sc.phone_number ?? "").replace(/[^0-9]/g, "");
    const own = Number.isSafeInteger(sc.user_id) && sc.user_id === m.from?.id && digits.length >= 8 && digits.length <= 15;
    return { message: { ...base, kind: "text", text: "", sharedPhone: own ? "own" : "other", ...(own ? { phone: `+${digits}` } : {}) } };
  }
  // FEATURE 16: a photo or a file Trainee can't read, and a voice, audio or video message, each get a plain answer (never
  // silence); a sticker is still left alone.
  if (typeof m.text !== "string" || !m.text.trim()) {
    const media = m.voice || m.audio || m.video || m.video_note ? "voice" : m.photo ? "photo" : m.document ? "file" : null;
    return { message: { ...base, kind: "seen", text: "", file: !!(m.document || m.photo), ...(media ? { media } : {}) }, ignored: "no text (attachments are not read yet)" };
  }
  const cmd = /^\/(start|stop|help)(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?\s*$/i.exec(m.text.trim());
  if (cmd) {
    const command = cmd[1].toLowerCase() as "start" | "stop" | "help";
    const payload = command === "start" && cmd[2] && /^[A-Za-z0-9_-]{1,64}$/.test(cmd[2]) ? cmd[2] : null;
    return { message: { ...base, kind: "text", text: m.text, command, startPayload: payload } };
  }
  return { message: { ...base, kind: "text", text: m.text } };
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
  clock?: () => number; sleep?: (ms: number) => Promise<void>; native?: boolean;
}): ChannelAdapter {
  const f = o.fetch ?? fetch, timeout = o.timeoutMs ?? 15000;
  const pace = pacer({ perChatMs: 1000, overallPerSecond: 30, clock: o.clock, sleep: o.sleep });
  // The token rides in the URL; nothing that may be logged carries it.
  const redact = (s: string) => (o.token ? s.split(o.token).join("***") : s);
  const call = async (method: string, body: unknown): Promise<{ status: number; body: any } | { error: unknown }> => {
    try {
      const res = await f(`${TELEGRAM_API}/bot${o.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) { return { error: e }; }
  };
  return {
    channel: "telegram", provider: "telegram",
    limits: { chars: TELEGRAM_CHARS, packChars: PACK, perChatGapMs: 1000, overallPerSecond: 30, windowMs: null, dailyContacts: null, dailyTemplates: null },
    capabilities: { buttons: true, documents: true, previews: true, templates: false },
    render: o.native ? nativeRender("telegram", PACK) : (text) => packMessages(text, PACK),
    typingEveryMs: 4000,
    async typing(address): Promise<boolean> {
      const r = await call("sendChatAction", { chat_id: Number(address), action: "typing" });
      return !("error" in r) && r.status === 200 && r.body?.ok === true;
    },
    async parseInbound(req): Promise<ParseResult> {
      if (req.method !== "POST") return { response: json({ error: "Method not allowed" }, 405) };
      const secret = o.webhookSecret ?? "";
      if (!SECRET_RE.test(secret)) return { response: json({ error: "not configured: TELEGRAM_WEBHOOK_SECRET must be 32 to 256 of A-Z a-z 0-9 _ -" }, 503) };
      if (!equalSecret(req.headers.get("x-telegram-bot-api-secret-token") || "", secret)) return { response: json({ error: "forbidden" }, 403) };
      if (!o.token) return { response: json({ error: "NOT_WIRED: TELEGRAM_BOT_TOKEN is not set; no turn was run" }, 503) };
      const r = parseTelegramUpdate(await req.json().catch(() => null));
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
    async sendLink(address, url): Promise<SendResult> {
      await pace(address);
      const r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(url, TELEGRAM_CHARS), link_preview_options: { is_disabled: false, url, prefer_large_media: true } });
      if ("error" in r) return { ok: false, error: redact(`Telegram unreachable: ${r.error instanceof Error ? r.error.message : String(r.error)}`).slice(0, 200), retryable: false };
      if (r.status === 200 && r.body?.ok === true) return { ok: true, id: r.body?.result?.message_id != null ? String(r.body.result.message_id) : null };
      return { ok: false, error: `Telegram sendLink HTTP ${r.status}: ${redact(String(r.body?.description ?? "")).slice(0, 120)}`, retryable: false };
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
        let r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(bubbles[i], TELEGRAM_CHARS), link_preview_options: { is_disabled: false }, ...(o.native ? { parse_mode: "HTML" } : {}), ...keyboard });
        // V1: Telegram refused the markup, so nothing went out; the same words go again as plain text.
        if (o.native && !("error" in r) && r.status === 400 && /parse entities|can't find end|unsupported start tag/i.test(String(r.body?.description ?? ""))) {
          r = await call("sendMessage", { chat_id: Number(address), text: safeSlice(telegramPlain(bubbles[i]), TELEGRAM_CHARS), link_preview_options: { is_disabled: false }, ...keyboard });
        }
        if ("error" in r) {
          const e = r.error, timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
          return timedOut ? { ok: false, error: `Telegram timed out (it may have been delivered)${after}`, retryable: false }
            : { ok: false, error: redact(`Telegram unreachable: ${e instanceof Error ? e.message : String(e)}`).slice(0, 200) + after, retryable: i === 0 };
        }
        if (r.status === 200 && r.body?.ok === true) { const id = r.body?.result?.message_id; if (id !== undefined && id !== null) ids.push(String(id)); continue; }
        const desc = redact(String(r.body?.description ?? "")).slice(0, 120);
        if (r.status === 403 && /blocked|deactivated/i.test(desc)) return { ok: false, error: `Telegram 403: ${desc}${after}`, retryable: false, optOut: true };
        return { ok: false, error: `Telegram HTTP ${r.status}${desc ? `: ${desc}` : ""}${after}`, retryable: i === 0 && (r.status === 429 || r.status === 502 || r.status === 503) };
      }
      return { ok: true, id: ids[0] ?? null, ids };
    },
  };
}
