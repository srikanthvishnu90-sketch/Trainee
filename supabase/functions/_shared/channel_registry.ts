// Which channels are wired, from the project's secrets (WO-038). A channel whose secrets are missing is NOT_WIRED: its
// messages stay queued and its webhook answers 503 with the setting it needs; the other channels run.
//   iMessage: LOOPMESSAGE_API_KEY (LOOPMESSAGE_DAILY_CONTACTS, default 300)
//   Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (inbound), TELEGRAM_BOT_USERNAME (the Connect Telegram link)
//   WhatsApp: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN (inbound),
//             WHATSAPP_TEMPLATE_UPDATES and WHATSAPP_TEMPLATE_LANGUAGE (the waiting-updates template; without a name,
//             messages outside the window wait and nothing is sent), WHATSAPP_DAILY_TEMPLATES (default 250),
//             WHATSAPP_GRAPH_VERSION (default v21.0)
import type { Channel, ChannelAdapter } from "./channel_adapters.ts";
import { loopMessageAdapter } from "./loopmessage_adapter.ts";
import { telegramAdapter } from "./telegram.ts";
import { DEFAULT_DAILY_TEMPLATES, whatsappAdapter } from "./whatsapp.ts";
import { textingNativeOn } from "./channel_voice.ts"; // V1 TEXTING VOICE: CAREER_TEXTING_NATIVE=on splits and formats per channel
import { telegramBriefOn } from "./telegram_brief.ts";

export const DEFAULT_DAILY_CONTACTS = 300; // LoopMessage's smaller plan
type Env = { get(k: string): string | undefined };
const whole = (v: string | undefined, d: number) => { const n = v === undefined || v === "" ? d : Number(v); return Number.isInteger(n) && n > 0 ? n : NaN; };

export const NOT_WIRED: Record<Channel, string> = {
  imessage: "LOOPMESSAGE_API_KEY is not set",
  telegram: "TELEGRAM_BOT_TOKEN is not set",
  whatsapp: "WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set",
};
export function wiredChannels(env: Env): Channel[] {
  const out: Channel[] = [];
  if (env.get("LOOPMESSAGE_API_KEY")) out.push("imessage");
  if (env.get("WHATSAPP_TOKEN") && env.get("WHATSAPP_PHONE_NUMBER_ID")) out.push("whatsapp");
  if (env.get("TELEGRAM_BOT_TOKEN")) out.push("telegram");
  return out;
}

// Every wired channel's adapter. A bad number setting throws (the function answers 503 with it, sending nothing).
export function adaptersFromEnv(env: Env, o: { fetch?: typeof fetch; clock?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Partial<Record<Channel, ChannelAdapter>> {
  const out: Partial<Record<Channel, ChannelAdapter>> = {};
  const wired = wiredChannels(env);
  if (wired.includes("imessage")) {
    const cap = whole(env.get("LOOPMESSAGE_DAILY_CONTACTS"), DEFAULT_DAILY_CONTACTS);
    if (Number.isNaN(cap)) throw new Error("not configured: LOOPMESSAGE_DAILY_CONTACTS must be a whole number of contacts a day");
    out.imessage = loopMessageAdapter({ apiKey: env.get("LOOPMESSAGE_API_KEY")!, inboundSecret: env.get("TRAINEE_INBOUND_SECRET"), dailyContacts: cap, fetch: o.fetch, sleep: o.sleep, native: textingNativeOn(env) });
  }
  if (wired.includes("telegram")) {
    out.telegram = telegramAdapter({ token: env.get("TELEGRAM_BOT_TOKEN")!, webhookSecret: env.get("TELEGRAM_WEBHOOK_SECRET"), fetch: o.fetch, clock: o.clock, sleep: o.sleep, native: textingNativeOn(env), brief: telegramBriefOn(env) });
  }
  if (wired.includes("whatsapp")) {
    const cap = whole(env.get("WHATSAPP_DAILY_TEMPLATES"), DEFAULT_DAILY_TEMPLATES);
    if (Number.isNaN(cap)) throw new Error("not configured: WHATSAPP_DAILY_TEMPLATES must be a whole number of templates a day");
    const name = (env.get("WHATSAPP_TEMPLATE_UPDATES") || "").trim();
    out.whatsapp = whatsappAdapter({
      token: env.get("WHATSAPP_TOKEN")!, phoneNumberId: env.get("WHATSAPP_PHONE_NUMBER_ID")!, appSecret: env.get("WHATSAPP_APP_SECRET"),
      verifyToken: env.get("WHATSAPP_VERIFY_TOKEN"), version: env.get("WHATSAPP_GRAPH_VERSION"), dailyTemplates: cap,
      template: name ? { name, language: (env.get("WHATSAPP_TEMPLATE_LANGUAGE") || "en_US").trim() } : null,
      fetch: o.fetch, clock: o.clock, sleep: o.sleep, native: textingNativeOn(env),
    });
  }
  return out;
}
