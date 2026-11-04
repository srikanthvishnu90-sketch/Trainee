// One interface for every texting channel (WO-038): iMessage through LoopMessage, WhatsApp through Meta's Cloud API,
// Telegram through the Bot API. The brain never knows the channel; everything a platform needs (its webhook, its
// sizes, its pacing, its window, its errors) lives in its adapter, and the rest of the texting path speaks only this.
//
// A contact key names one address on one channel: the phone or email for iMessage (as before, so existing rows and
// tests are unchanged), "wa:<wa_id or business-scoped user id>" for WhatsApp, "tg:<chat_id>" for Telegram. It is the
// primary key of channel_contacts and what career_outbox.contact records; the database derives channel and address
// from it (20261021070000_channel_parity.sql), so the two can never disagree.
import { normalizeContact, splitLong, toBubbles } from "./conversation.ts";

export type Channel = "imessage" | "whatsapp" | "telegram";
export type Provider = "loopmessage" | "whatsapp" | "telegram";
export const CHANNELS: Channel[] = ["imessage", "whatsapp", "telegram"];
export const PROVIDER_OF: Record<Channel, Provider> = { imessage: "loopmessage", whatsapp: "whatsapp", telegram: "telegram" };
// The name a person reads ("Someone texted Trainee on WhatsApp ...").
export const CHANNEL_NAME: Record<Channel, string> = { imessage: "iMessage", whatsapp: "WhatsApp", telegram: "Telegram" };
const PREFIX: Record<Channel, string> = { imessage: "", whatsapp: "wa:", telegram: "tg:" };

export function channelOf(contact: string): Channel {
  const c = String(contact ?? "");
  return c.startsWith("wa:") ? "whatsapp" : c.startsWith("tg:") ? "telegram" : "imessage";
}
export function addressOf(contact: string): string {
  const ch = channelOf(contact);
  return ch === "imessage" ? contact : contact.slice(PREFIX[ch].length);
}
// Throws on an address the channel cannot have (the same shapes the database's check accepts).
export function contactKey(channel: Channel, address: string): string {
  const a = String(address ?? "").trim();
  if (channel === "imessage") return normalizeContact(a);
  if (channel === "whatsapp" && /^[A-Za-z0-9._-]{1,128}$/.test(a)) return `wa:${a}`;
  if (channel === "telegram" && /^[1-9][0-9]{0,19}$/.test(a)) return `tg:${a}`;
  throw new Error(`not a ${channel} address`);
}

// What a webhook brings in, whatever the platform. messageId is the provider's own id for dedupe, scoped by provider:
// Telegram update_id, WhatsApp messages[].id, LoopMessage message_id.
export interface InboundMessage {
  provider: Provider; channel: Channel; messageId: string;
  // blocked: the person blocked the bot (Telegram); seen: a non-text message (it still opens WhatsApp's window);
  // callback: FEATURE 16, a tap on a message's button (Telegram callback_query), carried in `callback`
  kind: "text" | "blocked" | "seen" | "callback";
  file?: boolean; // WO-106: the non-text message is a file or a photo (a resume sent as a PDF), so it gets an answer
  media?: "photo" | "voice" | "file"; // FEATURE 16 (Telegram): which kind, so the answer says what Trainee can read there
  contact: string; address: string;
  aliases?: string[]; // other contact keys of the same sender (WhatsApp: the business-scoped id when the key is the wa_id)
  alias?: string | null; // the alias to record on the contact row
  phone?: string | null; // +E.164 when the platform gives it (iMessage, WhatsApp wa_id); Telegram only from the person's own shared contact
  sharedPhone?: "own" | "other"; // Telegram contact share: own (contact.user_id is the sender) or somebody else's card
  text: string;
  command?: "start" | "stop" | "help" | null; // a platform command (Telegram /start, /stop, /help)
  startPayload?: string | null; // Telegram /start <payload> (a link nonce)
  // SERIAL-1462: the provider's id of the message the person replied to, when the platform says so (Telegram
  // message.reply_to_message.message_id; WhatsApp Cloud messages[].context.id). For iMessage this integration has no
  // verified reply-id path (LoopMessage's recorded payloads carry none, and its documentation could not be reached from
  // the build container), so no id is read there. A card's text yes approves only when this id is the message that
  // carried the card (career_apply_cards.ts).
  replyToMessageId?: string | null;
  // FEATURE 16: a file the person sent (Telegram message.document): the provider's id to download it by, its stable
  // unique id (the person's upload reference), its name, type and size as the platform reports them. `text` is its caption.
  document?: { fileId: string; uniqueId: string; name: string; mime: string; size: number | null } | null;
  // FEATURE 16: a button tap (Telegram callback_query): its id (answered once), the button's data, the message it was on.
  callback?: { id: string; data: string; messageId: string | null } | null;
}
// FEATURE 16: buttons under a sent message (Telegram's inline keyboard), rows of { text, data } (a tap comes back as a
// callback with data, at most 64 bytes) or { text, loginUrl } (Telegram's login: it opens the page signed in as the user).
export interface Button { text: string; data?: string; loginUrl?: string; url?: string; webApp?: string }
// shareContact: a one-tap "Share my phone number" button (Telegram's request_contact; the label); removeKeyboard: take that
// button away again once the number arrived.
export interface SendOptions { buttons?: Button[][]; shareContact?: string; removeKeyboard?: boolean }
// A WhatsApp status callback: a message we sent failed after Meta accepted it. hold: it failed for the window (131047)
// or the per-user marketing limit (131049), so it goes back in the queue for the person's next message.
export interface StatusEvent { providerMessageId: string; code: number | null; hold: boolean; error: string }
export type ParseResult = { messages: InboundMessage[]; statuses?: StatusEvent[]; ignored?: string[] } | { response: Response };

export type SendResult =
  | { ok: true; id: string | null; ids?: string[] }
  | { ok: false; error: string; retryable: boolean; hold?: boolean; optOut?: boolean };
export interface ChannelLimits {
  chars: number; // the platform's hard limit per message
  packChars: number; // what one message carries at most (longer text is split on purpose, lines kept together)
  perChatGapMs: number; // at least this long between two messages to one chat
  overallPerSecond: number | null; // across every chat
  windowMs: number | null; // free text only within this long of the person's last message (WhatsApp)
  dailyContacts: number | null; // a plan cap on distinct contacts a day (LoopMessage)
  dailyTemplates: number | null; // business-initiated templates a day (WhatsApp's messaging limit)
}
export interface ChannelCapabilities { buttons: boolean; documents: boolean; previews: boolean; templates: boolean }
// The delivery side of an adapter: what deliverDue needs.
export interface DeliveryAdapter {
  channel: Channel;
  limits: Partial<ChannelLimits>;
  render(text: string): string[];
  send(address: string, bubbles: string[], opts?: SendOptions): Promise<SendResult>;
  // The short utility template that says updates are waiting (WhatsApp, outside the window). null: no template is
  // configured, so the messages wait and nothing is sent.
  sendTemplate?(address: string, count: number): Promise<SendResult | null>;
}
export interface ChannelAdapter extends DeliveryAdapter {
  provider: Provider;
  limits: ChannelLimits;
  capabilities: ChannelCapabilities;
  parseInbound(req: Request): Promise<ParseResult>;
  // FEATURE 16 (Telegram): download a file the person sent, by the id its update gave; and answer a button tap once.
  fetchFile?(fileId: string, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>;
  answerCallback?(callbackId: string, text: string): Promise<boolean>;
  // JOB CARDS: a photo (public URL) with a caption and buttons; an edit of a sent message's text (or a photo's caption).
  sendPhoto?(address: string, p: { photoUrl: string; caption: string; buttons?: Button[][] }): Promise<SendResult>;
  editMessage?(address: string, messageId: string, e: { text: string; buttons?: Button[][]; caption?: boolean }): Promise<SendResult>;
  // FEATURE 16: a document (the tailored resume PDF) as a file in the chat.
  sendDocument?(address: string, doc: { bytes: Uint8Array; filename: string; mime: string }): Promise<SendResult>;
  // REPLY SHAPE (channel_shape.ts): one link as its own message with the platform's link preview card (title, image).
  sendLink?(address: string, url: string): Promise<SendResult>;
  // V1 TEXTING VOICE (channel_voice.ts): the platform's typing indicator while Trainee works, shown once (the platform
  // clears it after a few seconds or when the reply arrives), for the message `inboundId` the person just sent; where the
  // platform ties it to that message (WhatsApp), showing it also marks the message read. true: the platform took it.
  // Absent: the platform (or this integration) has none.
  typing?(address: string, inboundId: string | null): Promise<boolean>;
  typingEveryMs?: number; // how often to show it again while the turn runs
}

// One message carries at most `max` characters: paragraphs travel together while they fit, a longer paragraph is split
// on lines then words (conversation.ts splitLong: a posting keeps its link). Hidden markers are stripped as toBubbles does.
export function packMessages(text: string, max: number): string[] {
  const clean = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out: string[] = [];
  let buf = "";
  for (const para of clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    for (const piece of para.length <= max ? [para] : splitLong(para, max)) {
      if (buf && buf.length + 2 + piece.length <= max) buf += `\n\n${piece}`;
      else { if (buf) out.push(buf); buf = piece; }
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Pacing per chat and overall, on an injected clock (tests) or the real one. Sequential callers only (deliverDue is).
export function pacer(o: { perChatMs: number; overallPerSecond: number | null; clock?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const clock = o.clock ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = o.overallPerSecond ? Math.ceil(1000 / o.overallPerSecond) : 0;
  const lastByChat = new Map<string, number>();
  let lastAny = -Infinity;
  return async (chat: string) => {
    const now = clock();
    const wait = Math.max(0, (lastByChat.get(chat) ?? -Infinity) + o.perChatMs - now, lastAny + gap - now);
    if (wait > 0) await sleep(wait);
    const t = clock();
    lastByChat.set(chat, t);
    lastAny = t;
    if (lastByChat.size > 5000) lastByChat.clear(); // a run never reaches this; a long-lived instance stays bounded
  };
}

// The iMessage rendering stays exactly the one WO-013 shipped (bubbles of 700, a bare link alone for its preview card).
export const imessageRender = toBubbles;

export const HOUR_MS = 3600000;
// WhatsApp's customer service window is 24 hours from the person's last message. Trainee treats it as closed 10 minutes
// early, so a message never leaves inside the window and arrives outside it.
export const WHATSAPP_WINDOW_MS = 24 * HOUR_MS - 10 * 60000;
