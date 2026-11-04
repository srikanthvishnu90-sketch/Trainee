// WhatsApp as a texting channel (WO-038), through Meta's WhatsApp Cloud API directly (owner, 2026-10-20: no reseller).
// The official pages (developers.facebook.com) did not load from the build environment (DNS failure, proxy 403,
// 2026-10-20); each shape is labeled with where it comes from, and the owner's smoke run checks them on the live number.
//
// - Webhook verification: Meta sends GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...; answer the challenge
//   with 200 only when the token is ours (VERIFIED-S:
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint).
// - Every POST carries X-Hub-Signature-256: "sha256=" + HMAC-SHA256 of the raw body with the app secret (SECONDARY;
//   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads). It is checked on the raw
//   bytes before anything is parsed.
// - Payload: entry[].changes[] with field "messages"; value.metadata.phone_number_id; value.contacts[] (wa_id, and the
//   business-scoped user_id); value.messages[] (id, from, from_user_id, type, text.body, button.text, interactive.*);
//   value.statuses[] (id, status, errors[].code) (VERIFIED-S/SECONDARY:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components,
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/ — wa_id only when
//   a phone number is available, user_id always).
// - Sending: POST https://graph.facebook.com/<version>/<phone number id>/messages with a Bearer token; body
//   {messaging_product:"whatsapp", to, type:"text", text:{preview_url:true, body}}; body up to 4,096 characters; with
//   preview_url only the first link previews (VERIFIED-S:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages). A business-scoped id goes in
//   "recipient" instead of "to" (SECONDARY: provider docs mirroring the BSUID page).
// - Templates: type "template", template {name, language {code}, components [{type:"body", parameters [{type:"text"}]}]}
//   (VERIFIED-S: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates).
// - Errors: 131047 = more than 24 hours since the person's last message, only a template may go (SECONDARY);
//   131049 = held back by the per-user marketing limit (VERIFIED-S:
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/).
//   Either may come back on the send itself or later in a "failed" status (SECONDARY), so both paths hold the message.
import { equalSecret } from "./message_service.ts";
import { type ChannelAdapter, type InboundMessage, packMessages, pacer, type ParseResult, type SendResult, type StatusEvent, WHATSAPP_WINDOW_MS } from "./channel_adapters.ts";
import { nativeRender } from "./channel_voice.ts";
import { safeSlice } from "./channel_text.ts";

export const WHATSAPP_GRAPH = "https://graph.facebook.com";
export const WHATSAPP_DEFAULT_VERSION = "v21.0"; // ASSUMED still served; WHATSAPP_GRAPH_VERSION overrides it
export const WHATSAPP_CHARS = 4096;
export const DEFAULT_DAILY_TEMPLATES = 250; // a new account's business-initiated limit (SECONDARY); WHATSAPP_DAILY_TEMPLATES overrides
export const HOLD_CODES = new Set([131047, 131049]);
const RETRY_CODES = new Set([130429, 131056, 80007]); // throughput, pair rate, rate limit (SECONDARY): nothing went out
const PACK = 1500;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function hmacHex(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, body)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function whatsappSignature(appSecret: string, raw: Uint8Array<ArrayBuffer>): Promise<string> { return `sha256=${await hmacHex(appSecret, raw)}`; }

// The webhook body as messages and status events. Exported for tests and the smoke check.
// deno-lint-ignore no-explicit-any
export function parseWhatsAppBody(b: any, phoneNumberId?: string): { messages: InboundMessage[]; statuses: StatusEvent[]; ignored: string[] } {
  const messages: InboundMessage[] = [], statuses: StatusEvent[] = [], ignored: string[] = [];
  if (!b || b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return { messages, statuses, ignored: ["not a WhatsApp Business webhook"] };
  for (const entry of b.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") { ignored.push(`field ${String(change?.field ?? "").slice(0, 30)}`); continue; }
      const v = change.value ?? {};
      if (phoneNumberId && String(v.metadata?.phone_number_id ?? "") !== phoneNumberId) { ignored.push("another phone number"); continue; }
      const contacts: any[] = Array.isArray(v.contacts) ? v.contacts : [];
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const waId = typeof m?.from === "string" && /^[0-9]{6,20}$/.test(m.from) ? m.from : null;
        const c = contacts.find((x) => (waId && x?.wa_id === waId) || (m?.from_user_id && x?.user_id === m.from_user_id)) ?? (contacts.length === 1 ? contacts[0] : null);
        const bsuidRaw = m?.from_user_id ?? c?.user_id ?? null;
        const bsuid = typeof bsuidRaw === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(bsuidRaw) ? bsuidRaw : null;
        if (typeof m?.id !== "string" || !m.id || (!waId && !bsuid)) { ignored.push("no message id or sender"); continue; }
        const address = waId ?? bsuid!;
        const base = {
          provider: "whatsapp" as const, channel: "whatsapp" as const, messageId: m.id.slice(0, 200), contact: `wa:${address}`, address,
          // SERIAL-1462: a reply in WhatsApp carries the replied-to message as messages[].context.id (Cloud API).
          replyToMessageId: typeof m?.context?.id === "string" && m.context.id ? m.context.id.slice(0, 200) : null,
          aliases: waId && bsuid ? [`wa:${bsuid}`] : [], alias: waId && bsuid ? bsuid : null,
          phone: waId && waId.length >= 8 && waId.length <= 15 ? `+${waId}` : null,
          // IDENTITY SCENARIOS (2026-10-30): messages[].context.forwarded / frequently_forwarded (Cloud API): someone else's
          // words, never the person's answer to "Reply yes to link it".
          ...(m?.context?.forwarded === true || m?.context?.frequently_forwarded === true ? { forwarded: true } : {}),
        };
        // CHANNEL DELIVERY ROUND 2 (2026-10-30): the person's own time for the message (messages[].timestamp, Unix seconds;
        // VERIFIED-S: webhooks/components), so WhatsApp's window is counted from it and not from a retried webhook's arrival.
        const ts = Number(m?.timestamp);
        const sentAt = Number.isFinite(ts) && ts > 0 ? ts * 1000 : null;
        // CHANNEL DELIVERY ROUND 2: the person changed their WhatsApp number (type "system", system.type
        // "user_changed_number", system.wa_id the new number; SECONDARY: webhooks/components). Their account follows them to
        // the new number; the old one is let go (a carrier gives it to someone else in time).
        if (m.type === "system") {
          const to = typeof m.system?.wa_id === "string" && /^[0-9]{6,20}$/.test(m.system.wa_id) ? m.system.wa_id : null;
          if (m.system?.type === "user_changed_number" && to && waId && to !== waId) messages.push({ ...base, kind: "moved", text: "", movedTo: to, sentAt });
          else ignored.push("a system message");
          continue;
        }
        // A typed message, a tap on a template's quick reply, a tap on a reply button or a list row: all read as text.
        const text = m.type === "text" ? m.text?.body : m.type === "button" ? m.button?.text
          : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
        if (typeof text === "string" && text.trim()) messages.push({ ...base, kind: "text", text, sentAt });
        else {
          // CHANNEL DELIVERY ROUND 2: a voice note, audio or video is told what to do instead, as on Telegram (it got
          // silence); a photo or a file as before; a sticker, a reaction or a location is left alone.
          const media = m.type === "audio" || m.type === "video" ? "voice" as const : m.type === "image" ? "photo" as const : m.type === "document" ? "file" as const : undefined;
          messages.push({ ...base, kind: "seen", text: "", file: m.type === "document" || m.type === "image", ...(media ? { media } : {}), sentAt });
          ignored.push(`a ${String(m.type ?? "message").slice(0, 20)} message (not read yet)`);
        }
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        if (s?.status !== "failed" || typeof s.id !== "string") continue;
        const err = Array.isArray(s.errors) ? s.errors[0] : null;
        const code = Number.isInteger(err?.code) ? err.code : null;
        statuses.push({ providerMessageId: s.id.slice(0, 200), code, hold: code !== null && HOLD_CODES.has(code), retry: code !== null && RETRY_CODES.has(code),
          error: `WhatsApp ${code ?? "failed"}: ${String(err?.title ?? err?.message ?? "").slice(0, 120)}` });
      }
    }
  }
  return { messages, statuses, ignored };
}

// V1 TEXTING VOICE (CAREER_TEXTING_NATIVE=on, `native`): messages split on the reply's own words with WhatsApp's own
// *bold* (channel_voice.ts); and the typing indicator, which also marks the person's message read: POST
// /<phone number id>/messages {messaging_product:"whatsapp", status:"read", message_id:<their message's id>,
// typing_indicator:{type:"text"}}; "The typing indicator will be dismissed once you respond, or after 25 seconds, whichever
// comes first" (VERIFIED-S: https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators/).
export function whatsappAdapter(o: {
  token: string; phoneNumberId: string; appSecret?: string; verifyToken?: string; version?: string;
  template?: { name: string; language: string } | null; dailyTemplates?: number;
  fetch?: typeof fetch; timeoutMs?: number; clock?: () => number; sleep?: (ms: number) => Promise<void>; native?: boolean;
}): ChannelAdapter {
  const f = o.fetch ?? fetch, timeout = o.timeoutMs ?? 15000, version = o.version || WHATSAPP_DEFAULT_VERSION;
  // One message a second to one person: separate messages keep their order, and Meta's per-pair limit is not tested
  // (its exact rate is UNKNOWN; 131056 is retried on the first message only).
  const pace = pacer({ perChatMs: 1000, overallPerSecond: 50, clock: o.clock, sleep: o.sleep });
  const target = (address: string) => (/^[0-9]{6,20}$/.test(address) ? { to: address } : { recipient: address });
  const post = async (body: Record<string, unknown>): Promise<{ ok: true; id: string | null } | { ok: false; error: string; code: number | null; status: number; network: boolean; timedOut: boolean }> => {
    let res: Response;
    try {
      res = await f(`${WHATSAPP_GRAPH}/${version}/${o.phoneNumberId}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }), signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, error: timedOut ? "WhatsApp timed out (it may have been delivered)" : `WhatsApp unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), code: null, status: 0, network: !timedOut, timedOut };
    }
    const b = await res.json().catch(() => null) as any;
    if (res.ok && Array.isArray(b?.messages)) return { ok: true, id: typeof b.messages[0]?.id === "string" ? b.messages[0].id : null };
    const code = Number.isInteger(b?.error?.code) ? b.error.code : null;
    return { ok: false, error: `WhatsApp HTTP ${res.status}${code !== null ? ` (${code})` : ""}: ${String(b?.error?.message ?? "").slice(0, 120)}`, code, status: res.status, network: false, timedOut: false };
  };
  return {
    channel: "whatsapp", provider: "whatsapp",
    limits: { chars: WHATSAPP_CHARS, packChars: PACK, perChatGapMs: 1000, overallPerSecond: 50, windowMs: WHATSAPP_WINDOW_MS, dailyContacts: null, dailyTemplates: o.dailyTemplates ?? DEFAULT_DAILY_TEMPLATES },
    capabilities: { buttons: true, documents: true, previews: true, templates: !!o.template },
    render: o.native ? nativeRender("whatsapp", PACK) : (text) => packMessages(text, PACK),
    typingEveryMs: 20000,
    async typing(_address, inboundId): Promise<boolean> {
      // Tied to the message they sent (a wamid); without it there is nothing to show the indicator against.
      if (!inboundId || !/^wamid\./.test(inboundId)) return false;
      try {
        const res = await f(`${WHATSAPP_GRAPH}/${version}/${o.phoneNumberId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: inboundId, typing_indicator: { type: "text" } }), signal: AbortSignal.timeout(timeout),
        });
        const b = await res.json().catch(() => null) as any;
        return res.ok && b?.success === true;
      } catch { return false; }
    },
    async parseInbound(req): Promise<ParseResult> {
      if (req.method === "GET") {
        const u = new URL(req.url), verify = o.verifyToken ?? "";
        if (verify.length < 32) return { response: json({ error: "not configured: WHATSAPP_VERIFY_TOKEN must be set, 32 characters or more" }, 503) };
        const challenge = u.searchParams.get("hub.challenge") ?? "";
        if (u.searchParams.get("hub.mode") !== "subscribe" || !equalSecret(u.searchParams.get("hub.verify_token") ?? "", verify) || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) return { response: json({ error: "forbidden" }, 403) };
        return { response: new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } }) };
      }
      if (req.method !== "POST") return { response: json({ error: "Method not allowed" }, 405) };
      const appSecret = o.appSecret ?? "";
      if (!appSecret) return { response: json({ error: "not configured: WHATSAPP_APP_SECRET must be set (it signs every webhook)" }, 503) };
      const raw = new Uint8Array(await req.arrayBuffer());
      if (!equalSecretAny(req.headers.get("x-hub-signature-256") || "", await whatsappSignature(appSecret, raw))) return { response: json({ error: "forbidden" }, 403) };
      if (!o.token || !o.phoneNumberId) return { response: json({ error: "NOT_WIRED: WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set; no turn was run" }, 503) };
      let body: unknown = null;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* not JSON: ignored below */ }
      return parseWhatsAppBody(body, o.phoneNumberId);
    },
    async send(address, bubbles): Promise<SendResult> {
      if (!bubbles.length) return { ok: false, error: "nothing to send: the message has no text", retryable: false };
      const ids: string[] = [];
      for (let i = 0; i < bubbles.length; i++) {
        await pace(address);
        const after = i ? ` after ${i} of ${bubbles.length} messages went out` : "";
        const r = await post({ ...target(address), type: "text", text: { preview_url: true, body: safeSlice(bubbles[i], WHATSAPP_CHARS) } });
        if (r.ok) { if (r.id) ids.push(r.id); continue; }
        // The window closed or the marketing limit held it: nothing of this message went out, so the row waits for the
        // person's next message. CHANNEL DELIVERY ROUND 2 (2026-10-30): after a first message went out, what went is
        // reported (sent, sentIds) and the row resumes from this message (career_outbox.sent_parts); it was final ("after 1
        // of 2 messages went out") and the rest was never sent. The same for a throughput refusal (130429, 429...).
        const partial = i ? { sent: i, sentIds: [...ids] } : {};
        if (r.code !== null && HOLD_CODES.has(r.code)) return { ok: false, error: r.error + after, retryable: false, hold: true, ...partial };
        const retry = r.network || (r.code !== null && RETRY_CODES.has(r.code)) || r.status === 429 || r.status === 502 || r.status === 503;
        return { ok: false, error: r.error + after, retryable: retry, ...partial };
      }
      return { ok: true, id: ids[0] ?? null, ids };
    },
    async sendTemplate(address, count): Promise<SendResult | null> {
      if (!o.template?.name) return null;
      await pace(address);
      const r = await post({ ...target(address), type: "template", template: { name: o.template.name, language: { code: o.template.language || "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: String(Math.max(1, Math.floor(count))) }] }] } });
      if (r.ok) return { ok: true, id: r.id, ids: r.id ? [r.id] : [] };
      return { ok: false, error: r.error, retryable: r.network || r.status === 429 || r.status === 503 };
    },
  };
}
// equalSecret refuses values under 32 characters; a signature header is 71, so it applies as is.
const equalSecretAny = (a: string, b: string) => equalSecret(a.toLowerCase(), b);
