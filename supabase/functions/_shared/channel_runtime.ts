// What the three inbound webhooks share at deploy time (WO-038): the turn through agent-chat as the person, and the head
// start that sends a just-queued answer at once through whichever channel adapters are wired. Tests inject fakes for both.
import { deliverDue } from "./channel.ts";
import { supabaseChannelStore } from "./channel_store.ts";
import { adaptersFromEnv } from "./channel_registry.ts";
import { shapeReply } from "./channel_shape.ts";

// The turn runs as the person through agent-chat's service-role path, so history, erase, the host's STOP and pause,
// persistence and the hourly turn limit are the chat's own. The channel is never sent: the brain is channel-blind.
// agent-chat may answer with `parts` (a reply in several messages, each at most 4,000 characters: channel_inbound.ts
// replyParts); they are passed on as they are.
// LAUNCH READINESS R1 (2026-10-26): agent-chat runs one person's turns one at a time (career_turn_gate.ts). If a turn still
// meets revision_conflict (the gate timed out or is not applied) and the turn did nothing before its save, nothing of it
// was saved, so the same turn key is sent once more and agent-chat runs it again on a fresh read; any other refusal is not retried.
export const CONFLICT_RETRIES = 1;
export function chatThroughAgent(url: string, key: string, o: { retryDelayMs?: number; channel?: string } = {}) {
  return async (a: { userId: string; threadId: string | null; message: string; turnKey: string; replyToMessageId?: string | null; screenTap?: { qid: string; answer: string } | null }) => {
    let res: Response, body: Record<string, unknown>;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${url}/functions/v1/agent-chat`, {
        method: "POST", signal: AbortSignal.timeout(120000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // SERIAL-1462: the provider's reply-to id travels to the turn; a card's text yes counts only in reply to the card.
        body: JSON.stringify({ as_user_id: a.userId, message: a.message, turn_key: a.turnKey, ...(a.threadId ? { thread_id: a.threadId } : {}),
          ...(a.replyToMessageId ? { reply_to_message_id: a.replyToMessageId } : {}), ...(a.screenTap ? { screen_tap: { qid: a.screenTap.qid, answer: a.screenTap.answer } } : {}),
          // REPLY SHAPE: only the channel's name, fixed when the webhook builds this function (never a per-turn argument), so the turn can lay its reply out for it (agent-chat shapes Telegram only).
          ...(o.channel ? { channel: o.channel } : {}) }),
      });
      body = await res.json().catch(() => ({})) as Record<string, unknown>;
      // Only a turn that did nothing before its refused save is run again: one that answered a card, sent an email or
      // saved something already acted, and running it again could act twice; its reply says what it did.
      if (res.status === 409 && body.error === "revision_conflict" && body.turn_effects === false && attempt < CONFLICT_RETRIES) {
        await new Promise((r) => setTimeout(r, o.retryDelayMs ?? 250));
        continue;
      }
      break;
    }
    if (res.status === 429) return { status: 429, reply: String(body.message || "Slow down a little, then try again."), threadId: null };
    // A refused save carries its own plain reply, true to what the turn did (_shared/career_save_replies.ts): that is
    // what the person reads, not "I couldn't answer that just now" (a card yes may already have queued applications).
    if (res.status === 409 && typeof body.reply === "string" && body.reply.trim()) return { status: 409, reply: body.reply, threadId: typeof body.thread_id === "string" ? body.thread_id : null };
    if (!res.ok) throw new Error(`agent-chat HTTP ${res.status}`);
    const parts = Array.isArray(body.parts) ? body.parts.filter((p): p is string => typeof p === "string") : undefined;
    const meta = body.meta && typeof body.meta === "object" ? body.meta as Record<string, unknown> : {};
    // The card this reply shows (career_apply_cards.ts puts its id on the reply's meta), so the outbox row is recorded against it.
    const cardId = typeof meta.card_id === "string" && meta.card_id ? meta.card_id : null;
    const resultStatus = typeof meta.result_status === "string" ? meta.result_status : null;
    // FEATURE 16: the documents the turn produced (the tailored resume PDF), as owner-scoped refs (channel_artifacts.ts).
    const artifacts = Array.isArray(body.artifacts)
      ? (body.artifacts as any[]).filter((a) => a && typeof a.ref === "string" && a.ref).map((a) => ({ ref: String(a.ref), filename: String(a.filename ?? "document.pdf"), mime: String(a.mime ?? "application/pdf") }))
      : [];
    // JOB CARDS: the postings the turn's search found (agent-chat puts them on the response), sent as cards after the reply.
    const postings = Array.isArray(body.postings) ? (body.postings as unknown[]).filter((p) => p && typeof p === "object").slice(0, 200) : [];
    // TELEGRAM BRIEF (brief P7.2): a set of roles goes as one File link after the summary line, never one card each.
    const postingsAsFile = body.postings_as_file === true && postings.length > 0;
    // F09: the posting screen's yes/no question rides meta.screen_buttons = ["Yes","No"]; only exactly that is honored.
    const sb = Array.isArray(meta.screen_buttons) ? meta.screen_buttons : null;
    const screenQid = typeof meta.screen_qid === "string" && /^[0-9a-f]{8}$/.test(meta.screen_qid) ? meta.screen_qid : null;
    const screenButtons = !!sb && sb.length === 2 && sb[0] === "Yes" && sb[1] === "No" && !!screenQid;
    // REPLY SHAPE: the files and links that follow the reply, clamped again here (names, sizes, counts) before they are sent.
    const sh = body.shape && typeof body.shape === "object" ? body.shape as Record<string, unknown> : null;
    const shaped = sh ? shapeReply({ attachments: sh.attachments, links: sh.links }) : null;
    const more = sh && Array.isArray(sh.more) ? sh.more.map((m) => String(m ?? "").trim()).filter(Boolean).slice(0, 1) : [];
    const shape = shaped && (shaped.attachments.length || shaped.links.length || more.length) ? { attachments: shaped.attachments, links: shaped.links, ...(more.length ? { more } : {}) } : null;
    return { status: res.status, reply: String(body.reply ?? ""), ...(shape ? { shape } : {}), threadId: typeof body.thread_id === "string" ? body.thread_id : null, ...(parts ? { parts } : {}), ...(cardId ? { cardId } : {}), ...(resultStatus ? { resultStatus } : {}), ...(artifacts.length ? { artifacts } : {}), ...(postings.length ? { postings } : {}), ...(screenButtons ? { screenButtons, screenQid } : {}), ...(postingsAsFile ? { postingsAsFile } : {}) };
  };
}

// One request's head-start sender. The adapters are made once per request, so the parts of one reply share Telegram's
// pacing (one message a second to a chat) instead of each part starting a fresh clock.
// key: one row (a reply, or one part of it); wholeUser: everything due for the person, oldest first (WhatsApp: what
// waited for the window, then the answer).
// deno-lint-ignore no-explicit-any
export function deliverer(admin: any, env: { get(k: string): string | undefined }) {
  let adapters: ReturnType<typeof adaptersFromEnv> | null = null;
  // replyTo (TELEGRAM BRIEF, brief P1.2): the head start threads the answer to the person's message. The every-minute run (a
  // retry) has no such id and sends unthreaded: the words are the same, only the reply arrow is missing.
  return async (a: { userId: string; key?: string; now: number; wholeUser?: boolean; replyTo?: string | null }) => {
    adapters ??= adaptersFromEnv(env);
    const store = supabaseChannelStore(admin, a.wholeUser ? { user: a.userId } : { only: { userId: a.userId, key: a.key! } });
    const r = await deliverDue({ store, adapters: a.replyTo ? threadedAdapters(adapters, a.replyTo) : adapters, now: a.now, limit: a.wholeUser ? 40 : 1 });
    await store.release();
    return r; // what went (the inbound core sends a long answer's rest only after its head went: #301)
  };
}

// TELEGRAM BRIEF: the same adapters, each send threaded to one message (only where the adapter threads: Telegram reads replyTo).
export function threadedAdapters<T extends Record<string, unknown>>(adapters: T, replyTo: string): T {
  const out: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(adapters)) {
    // deno-lint-ignore no-explicit-any
    const ad = a as any;
    out[k] = ad && typeof ad.send === "function" ? { ...ad, send: (address: string, bubbles: string[], opts?: Record<string, unknown>) => ad.send(address, bubbles, { ...opts, replyTo }) } : a;
  }
  return out as T;
}
