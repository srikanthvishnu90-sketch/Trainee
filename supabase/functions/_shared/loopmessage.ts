// LoopMessage as the texting channel's Send (WO-013b-1). The request shape is the one the owner's test bridge used live
// (2026-10-08..11): POST, the raw key in Authorization, body { contact, text }, one request per bubble, 250 ms apart so
// iMessage keeps their order. NOT verified against LoopMessage's documentation (unreachable from the build environment):
// the owner checks the fields and which statuses LoopMessage retries before go-live.
//
// Retry only when the message certainly did not go out: a connection that never opened, 429, 502, 503. A timeout, 500 or
// 504 may have been delivered, and a failure after the first bubble would resend the earlier ones, so those are final:
// the channel's rule is at most once, and a final failure is recorded, never silent.
import type { Send } from "./channel.ts";

export const LOOPMESSAGE_SEND_URL = "https://a.loopmessage.com/api/v1/message/send/";
const RETRYABLE_STATUS = new Set([429, 502, 503]);
const MAX_TEXT = 5000;
// Never half a character at the cut (an emoji's two halves); kept import-free (tests/trainee-go-live.test.cjs loads this file).
const safeText = (t: string) => { const c = t.charCodeAt(MAX_TEXT - 1); return t.length <= MAX_TEXT ? t : t.slice(0, c >= 0xd800 && c <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT); };

export function loopSend(o: { apiKey: string; fetch?: typeof fetch; pauseMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): Send {
  const f = o.fetch ?? fetch, pause = o.pauseMs ?? 250, timeout = o.timeoutMs ?? 15000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // CHANNEL DELIVERY ROUND 2 (2026-10-30): every bubble's id (a message_failed callback names the bubble that failed), and
  // on a failure what went out before it (sent, sentIds): a 429 / 502 / 503 or a connection that never opened on the 2nd+
  // bubble sent nothing of that bubble, so the row resumes from it (career_outbox.sent_parts) instead of ending "after 1 of
  // 3 bubbles went out" with the rest never sent.
  return async (contact, bubbles) => {
    if (!bubbles.length) return { ok: false, error: "nothing to send: the message has no text", retryable: false };
    let id: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await sleep(pause);
      const after = i ? ` after ${i} of ${bubbles.length} bubbles went out` : "";
      const partial = i ? { sent: i, sentIds: [...ids] } : {};
      let res: Response;
      try {
        res = await f(LOOPMESSAGE_SEND_URL, { method: "POST", headers: { Authorization: o.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ contact, text: safeText(bubbles[i]) }), signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
        return timedOut ? { ok: false, error: `LoopMessage timed out (it may have been delivered)${after}`, retryable: false, ...partial }
          : { ok: false, error: `LoopMessage unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) + after, retryable: true, ...partial };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, error: `LoopMessage HTTP ${res.status}${after}`, retryable: RETRYABLE_STATUS.has(res.status), ...partial };
      }
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      const got = body?.message_id ?? body?.id;
      if (typeof got === "string" || typeof got === "number") { if (id === null) id = String(got); ids.push(String(got).slice(0, 200)); }
    }
    // Every bubble's id when they differ (a single id is `id`).
    return new Set(ids).size > 1 ? { ok: true, id, ids } : { ok: true, id };
  };
}

// An inbound webhook body. LoopMessage posts inbound messages AND delivery callbacks to the same webhook; only real
// inbound text reaches the agent. The candidate fields are the ones the owner's test bridge handled (documented and
// observed shapes); the owner confirms them against LoopMessage's documentation before go-live.
// CHANNEL DELIVERY ROUND 2 (2026-10-30), with the fields of LoopMessage's webhook reference as recalled (ASSUMED: the
// documentation is not reachable from the build environment; the owner confirms them before go-live): alert_type
// message_inbound is the person's message; message_scheduled, message_sent, message_reaction, conversation_inited,
// group_created and inbound_call are not; message_failed and message_timeout say a message Trainee sent was not delivered
// (parseLoopFailure, by its message_id); a message in a group (a "group" object, or group_id) is not answered (Trainee
// answers one to one only, as on Telegram); delivery_type "sms" says it came over SMS (iMessage was not available), where
// the carrier keywords apply. Before, any alert_type with "message" in it and a text was read as the person's words:
// message_scheduled and message_timeout carry the text Trainee itself sent, and ran it as a turn.
export type LoopInbound = { kind: "text"; text: string; sender: string; messageId: string | null; sms?: boolean } | { kind: "ignored"; why: string };
// A delivery callback that says a message Trainee sent was not delivered (message_failed, message_timeout): its message id
// and the reason; null for anything else.
export function parseLoopFailure(raw: unknown): { messageId: string; error: string } | null {
  // deno-lint-ignore no-explicit-any
  const b: any = raw && typeof raw === "object" ? raw : {};
  const msg = b.message && typeof b.message === "object" ? b.message : b.data && typeof b.data === "object" ? b.data : b;
  const event = String(b.alert_type ?? b.event ?? b.type ?? msg.event ?? msg.type ?? "").toLowerCase();
  const id = msg.message_id ?? msg.id ?? b.message_id ?? b.id ?? null;
  if (!/fail|timeout/.test(event) || id === null || id === undefined || id === "") return null;
  const code = msg.error_code ?? b.error_code ?? null;
  return { messageId: String(id).slice(0, 200), error: `LoopMessage ${event.slice(0, 40)}${code !== null && code !== undefined && code !== "" ? ` (${String(code).slice(0, 20)})` : ""}: not delivered` };
}
export function parseLoopInbound(raw: unknown): LoopInbound {
  // deno-lint-ignore no-explicit-any
  const b: any = raw && typeof raw === "object" ? raw : {};
  const msg = b.message && typeof b.message === "object" ? b.message : b.data && typeof b.data === "object" ? b.data : b;
  const event = String(b.alert_type ?? b.event ?? b.type ?? msg.event ?? msg.type ?? "").toLowerCase();
  const id = msg.message_id ?? msg.id ?? b.message_id ?? b.id ?? null;
  if (event && (!/inbound|received|^message$/.test(event) || /status|deliver|sent|read|typing|fail|schedul|reaction|group_created|call/.test(event))) return { kind: "ignored", why: `not an inbound text (${event.slice(0, 40)})` };
  const group = msg.group ?? b.group ?? msg.group_id ?? b.group_id ?? null;
  if (group !== null && group !== undefined && group !== "" && group !== false) return { kind: "ignored", why: "a group chat (Trainee answers one to one only)" };
  const text = msg.text ?? msg.body ?? msg.content ?? b.text ?? b.body ?? "";
  const sender = msg.from ?? msg.sender ?? msg.contact ?? msg.recipient ?? msg.phone ?? b.from ?? b.sender ?? b.contact ?? b.recipient ?? b.phone ?? "";
  if (typeof text !== "string" || !text.trim()) return { kind: "ignored", why: "no text (attachments are not read yet)" };
  if (typeof sender !== "string" || !sender.trim()) return { kind: "ignored", why: "no sender" };
  const sms = String(msg.delivery_type ?? b.delivery_type ?? "").toLowerCase() === "sms";
  return { kind: "text", text, sender, messageId: id === null || id === undefined || id === "" ? null : String(id).slice(0, 200), ...(sms ? { sms } : {}) };
}
