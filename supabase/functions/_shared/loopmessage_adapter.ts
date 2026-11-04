// LoopMessage (iMessage) behind the channel interface (WO-038). Nothing about it changes: the same secret (?secret= or
// x-trainee-secret, 32+ characters), the same NOT_WIRED without the key, the same parse (loopmessage.ts parseLoopInbound),
// the same bubbles (toBubbles), one request per bubble (loopSend). Kept out of loopmessage.ts, which stays import-free so
// tests/trainee-go-live.test.cjs can load it on its own.
import type { Send } from "./channel.ts";
import { equalSecret } from "./message_service.ts";
import { normalizeContact, toBubbles } from "./conversation.ts";
import { imessageNativeRender } from "./channel_voice.ts";
import { loopSend, parseLoopFailure, parseLoopInbound } from "./loopmessage.ts";
import type { ChannelAdapter, ParseResult } from "./channel_adapters.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// native (CAREER_TEXTING_NATIVE=on, CHANNEL DELIVERY SCENARIOS 2026-10-29): plain text, no markdown, in the same bubbles.
export function loopMessageAdapter(o: { apiKey: string; inboundSecret?: string; dailyContacts?: number; send?: Send; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; native?: boolean }): ChannelAdapter {
  const send = o.send ?? loopSend({ apiKey: o.apiKey, fetch: o.fetch, sleep: o.sleep });
  return {
    channel: "imessage", provider: "loopmessage",
    limits: { chars: 5000, packChars: 700, perChatGapMs: 250, overallPerSecond: null, windowMs: null, dailyContacts: o.dailyContacts ?? null, dailyTemplates: null },
    capabilities: { buttons: false, documents: false, previews: true, templates: false },
    render: o.native ? imessageNativeRender : toBubbles,
    send: (address, bubbles) => send(address, bubbles),
    async parseInbound(req): Promise<ParseResult> {
      if (req.method !== "POST") return { response: json({ error: "Method not allowed" }, 405) };
      const secret = o.inboundSecret || "";
      if (secret.length < 32) return { response: json({ error: "not configured: TRAINEE_INBOUND_SECRET must be set, 32 characters or more" }, 503) };
      const got = new URL(req.url).searchParams.get("secret") || req.headers.get("x-trainee-secret") || "";
      if (!equalSecret(got, secret)) return { response: json({ error: "forbidden" }, 403) };
      if (!o.apiKey) return { response: json({ error: "NOT_WIRED: LOOPMESSAGE_API_KEY is not set; no turn was run" }, 503) };
      const body = await req.json().catch(() => null);
      // CHANNEL DELIVERY ROUND 2: a message Trainee sent that LoopMessage could not deliver: its row is marked failed.
      const failed = parseLoopFailure(body);
      if (failed) return { messages: [], statuses: [{ providerMessageId: failed.messageId, code: null, hold: false, error: failed.error }], ignored: [] };
      const msg = parseLoopInbound(body);
      if (msg.kind === "ignored") return { messages: [], ignored: [msg.why] };
      if (!msg.messageId) return { messages: [], ignored: ["no message id, so a retry could not be told apart; nothing was run"] };
      let contact: string;
      try { contact = normalizeContact(msg.sender); } catch { return { messages: [], ignored: ["not a phone number or address"] }; }
      return { messages: [{ provider: "loopmessage", channel: "imessage", messageId: msg.messageId, kind: "text", contact, address: contact, replyToMessageId: null, /* SERIAL-1462/1480: no verified reply-id path in this integration */
        phone: contact.startsWith("+") ? contact : null, text: msg.text, ...(msg.sms ? { sms: true } : {}) }] };
    },
  };
}
