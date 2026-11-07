// A world for the three texting webhooks (GREETING and CHANNEL PARITY, 2026-11-05): the REAL handlers (trainee-telegram,
// trainee-whatsapp, trainee-inbound), composed as their index.ts files compose them (agent-chat through the real
// chatThroughAgent, named with the webhook's channel; the head start through the real deliverDue), over the in-memory
// channel database (channel_memory.ts) and a fake network: Telegram's Bot API, Meta's Graph API and LoopMessage are fakes
// that record what each person reads, and agent-chat is a scripted fake that records every request the webhooks make to
// it. Nothing leaves the process and no real message is sent.
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import type { Channel } from "../../supabase/functions/_shared/channel_adapters.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";
import { LOOPMESSAGE_SEND_URL, loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { WHATSAPP_GRAPH, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";

export const CHANNELS: Channel[] = ["telegram", "whatsapp", "imessage"];
export const NOW = Date.UTC(2026, 10, 5, 15);
const SECRET = "i".repeat(40), TG_TOKEN = "123456:fake-telegram-token-TTTTTTTT", TG_SECRET = "t".repeat(40);
const WA_APP = "fake-wa-app-secret-AAAAAAAA", PNID = "100200300";
export const AGENT_URL = "https://agent.test";
// The channel name each webhook's index.ts gives chatThroughAgent (tests/edge/channel-parity.test.ts checks the files say so).
export const AGENT_CHANNEL: Record<Channel, string> = { telegram: "telegram", whatsapp: "whatsapp", imessage: "imessage" };

export type Sent = { channel: Channel; address: string; text: string; buttons: string[]; at: number };
// What the scripted agent-chat answers: the JSON body of agent-chat's response.
export type AgentScript = (message: string, body: Record<string, unknown>) => Record<string, unknown>;
export const echoAgent: AgentScript = (m) => ({ reply: `Answer to: ${m}` });

export function channelWorld(o: { env?: Record<string, string>; agent?: AgentScript; greeting?: boolean } = {}) {
  const W = memoryChannelWorld({ greeting: o.greeting ?? true });
  const clock = { t: NOW };
  const sleep = async (ms: number) => { clock.t += ms; };
  const sent: Sent[] = [];
  const agentCalls: Record<string, unknown>[] = [];
  let n = 0, upd = 1000, seq = 0;
  const resp = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const buttonsOf = (markup: any): string[] => Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard.flat().map((b: any) => String(b.text)) : [];
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url === LOOPMESSAGE_SEND_URL) { sent.push({ channel: "imessage", address: body.contact, text: body.text, buttons: [], at: clock.t }); return resp({ message_id: `lm-${++n}` }); }
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/sendChatAction`)) return resp({ ok: true, result: true });
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/sendMessage`)) {
      sent.push({ channel: "telegram", address: String(body.chat_id), text: body.text, buttons: buttonsOf(body.reply_markup), at: clock.t });
      return resp({ ok: true, result: { message_id: ++n } });
    }
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/`)) return resp({ ok: true, result: true });
    if (url === `${WHATSAPP_GRAPH}/v21.0/${PNID}/messages`) {
      if (body.status === "read") return resp({ success: true });
      sent.push({ channel: "whatsapp", address: body.to ?? body.recipient, text: body.text?.body ?? "", buttons: [], at: clock.t });
      return resp({ messages: [{ id: `wamid.out.${++n}` }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = {
    // D-036: the release config turns the texting voice on; the world runs as production does.
    CAREER_TEXTING_NATIVE: "on",
    TRAINEE_INBOUND_SECRET: SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key", TRAINEE_SIGNUP: "open",
    TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot",
    WHATSAPP_TOKEN: "fake-wa-token-WWWWWWWW", WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: "v".repeat(40),
    ...o.env,
  };
  const env = { get: (k: string) => vars[k] || undefined };
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => clock.t, sleep });
  const script = o.agent ?? echoAgent;
  // agent-chat, scripted: it records the request each webhook made (the body chatThroughAgent posts) and answers.
  const agentFetch = (async (url: string, init: RequestInit) => {
    if (!String(url).startsWith(`${AGENT_URL}/functions/v1/agent-chat`)) return await net(url, init);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    agentCalls.push(body);
    const { httpStatus, ...out } = script(String(body.message), body) as Record<string, unknown> & { httpStatus?: number };
    if (httpStatus) return resp({ error: "scripted failure" }, httpStatus);
    return resp({ thread_id: body.thread_id ?? `t-${body.as_user_id}`, ...out });
  }) as unknown as typeof fetch;
  const chatFor = (ch: Channel) => {
    const real = chatThroughAgent(AGENT_URL, "service-key", { channel: AGENT_CHANNEL[ch] });
    return async (a: Parameters<typeof real>[0]) => {
      const was = globalThis.fetch;
      globalThis.fetch = agentFetch;
      try { return await real(a); } finally { globalThis.fetch = was; }
    };
  };
  const runDeliver = async (scope?: { only?: { userId: string; key: string }; user?: string }) => {
    const s = W.delivery(scope);
    const r = await deliverDue({ store: s, adapters, now: clock.t });
    await s.release();
    return r;
  };
  // As each index.ts composes it: Telegram and iMessage deliver the one row, WhatsApp everything due for the person.
  const deps = (ch: "telegram" | "whatsapp") => ({
    env, now: () => clock.t, store: () => W.inbound, chat: chatFor(ch),
    deliver: (a: any) => runDeliver(ch === "whatsapp" ? { user: a.userId } : { only: { userId: a.userId, key: a.key } }),
    adapter: () => adapters[ch]!,
  });
  const tgPost = (u: unknown) => handleTelegram(new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify(u) }), deps("telegram"));
  const waPost = async (b: unknown) => {
    const raw = new TextEncoder().encode(JSON.stringify(b));
    return await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), deps("whatsapp"));
  };
  const lmPost = (b: unknown) => handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${SECRET}`, { method: "POST", body: JSON.stringify(b) }), {
    env, now: () => clock.t, store: () => W.inbound, send: (apiKey: string) => loopSend({ apiKey, fetch: net, sleep }), chat: chatFor("imessage"),
    deliverReply: (a: any) => runDeliver({ only: { userId: a.userId, key: a.key } }),
  });
  const tgMessage = (chat: string, m: Record<string, unknown>, updateId?: number) => ({ update_id: updateId ?? ++upd, message: { message_id: ++seq, from: { id: Number(chat), is_bot: false }, chat: { id: Number(chat), type: "private" }, date: Math.floor(clock.t / 1000), ...m } });
  const waMessage = (from: string, m: Record<string, unknown>, id?: string) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, contacts: [{ wa_id: from, profile: { name: "Test Person" } }],
    messages: [{ from, id: id ?? `wamid.in.${++seq}`, timestamp: String(Math.floor(clock.t / 1000)), ...m }] } }] }] });
  // A person texts words on a channel; the webhook's JSON back. id: a provider message id to send again (a retried webhook).
  const text = async (ch: Channel, from: string, words: string, id?: string) => {
    clock.t += 2000;
    const res = ch === "telegram" ? await tgPost(tgMessage(from, { text: words }, id ? Number(id) : undefined))
      : ch === "whatsapp" ? await waPost(waMessage(from, { type: "text", text: { body: words } }, id))
      : await lmPost({ alert_type: "message_inbound", message_id: id ?? `lm-in-${++seq}`, recipient: from, text: words });
    return await res.json();
  };
  // A file with no words (a resume sent as a PDF), as each platform carries it.
  const file = async (ch: Channel, from: string) => {
    clock.t += 2000;
    const res = ch === "telegram" ? await tgPost(tgMessage(from, { document: { file_id: `f${++seq}`, file_unique_id: `u${seq}`, file_name: "resume.pdf", mime_type: "application/pdf", file_size: 2000 } }))
      : ch === "whatsapp" ? await waPost(waMessage(from, { type: "document", document: { id: `media${++seq}`, filename: "resume.pdf", mime_type: "application/pdf" } }))
      : await lmPost({ alert_type: "message_inbound", message_id: `lm-in-${++seq}`, recipient: from, text: "", attachments: ["https://cdn.loopmessage.test/resume.pdf"] });
    return await res.json();
  };
  const mark = () => sent.length;
  const read = (address: string, from = 0) => sent.slice(from).filter((s) => s.address === address);
  const contactOf = (ch: Channel, addr: string) => (ch === "whatsapp" ? `wa:${addr}` : ch === "telegram" ? `tg:${addr}` : addr);
  const userOf = (ch: Channel, addr: string) => W.contacts.get(contactOf(ch, addr))?.userId ?? null;
  return { W, clock, sent, agentCalls, env, adapters, runDeliver, tgPost, tgMessage, waPost, waMessage, lmPost, text, file, mark, read, contactOf, userOf };
}
export const ADDR: Record<Channel, string> = { telegram: "7001", whatsapp: "15550002222", imessage: "+15550001111" };

// What a person reads, with the transport's own formatting taken off (Telegram's HTML escaping and tags); nothing else.
export function plain(text: string): string {
  return String(text ?? "").replace(/<\/?(?:b|i|u|s|code|pre|a)(?:\s[^>]*)?>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
export const words = (msgs: Sent[]) => msgs.map((m) => plain(m.text)).join("\n").replace(/\s+/g, " ").trim();
