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
  return async (contact, bubbles) => {
    if (!bubbles.length) return { ok: false, error: "nothing to send: the message has no text", retryable: false };
    let id: string | null = null;
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await sleep(pause);
      const after = i ? ` after ${i} of ${bubbles.length} bubbles went out` : "";
      let res: Response;
      try {
        res = await f(LOOPMESSAGE_SEND_URL, { method: "POST", headers: { Authorization: o.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ contact, text: safeText(bubbles[i]) }), signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
        return timedOut ? { ok: false, error: `LoopMessage timed out (it may have been delivered)${after}`, retryable: false }
          : { ok: false, error: `LoopMessage unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) + after, retryable: i === 0 };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, error: `LoopMessage HTTP ${res.status}${after}`, retryable: i === 0 && RETRYABLE_STATUS.has(res.status) };
      }
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      const got = body?.message_id ?? body?.id;
      if (id === null && (typeof got === "string" || typeof got === "number")) id = String(got);
    }
    return { ok: true, id };
  };
}

// An inbound webhook body. LoopMessage posts inbound messages AND delivery callbacks to the same webhook; only real
// inbound text reaches the agent. The candidate fields are the ones the owner's test bridge handled (documented and
// observed shapes); the owner confirms them against LoopMessage's documentation before go-live.
export type LoopInbound = { kind: "text"; text: string; sender: string; messageId: string | null } | { kind: "ignored"; why: string };
export function parseLoopInbound(raw: unknown): LoopInbound {
  // deno-lint-ignore no-explicit-any
  const b: any = raw && typeof raw === "object" ? raw : {};
  const msg = b.message && typeof b.message === "object" ? b.message : b.data && typeof b.data === "object" ? b.data : b;
  const event = String(b.alert_type ?? b.event ?? b.type ?? msg.event ?? msg.type ?? "").toLowerCase();
  if (event && (!/message|inbound|received/.test(event) || /status|deliver|sent|read|typing|fail/.test(event))) return { kind: "ignored", why: `not an inbound text (${event.slice(0, 40)})` };
  const text = msg.text ?? msg.body ?? msg.content ?? b.text ?? b.body ?? "";
  const sender = msg.from ?? msg.sender ?? msg.contact ?? msg.recipient ?? msg.phone ?? b.from ?? b.sender ?? b.contact ?? b.recipient ?? b.phone ?? "";
  const id = msg.message_id ?? msg.id ?? b.message_id ?? b.id ?? null;
  if (typeof text !== "string" || !text.trim()) return { kind: "ignored", why: "no text (attachments are not read yet)" };
  if (typeof sender !== "string" || !sender.trim()) return { kind: "ignored", why: "no sender" };
  return { kind: "text", text, sender, messageId: id === null || id === undefined || id === "" ? null : String(id).slice(0, 200) };
}
