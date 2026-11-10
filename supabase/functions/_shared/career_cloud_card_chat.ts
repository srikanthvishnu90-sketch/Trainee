// Option A (chosen 2026-10-22 under the owner's delegation): a text yes never approves or sends; only the person's tap
// on the exact payload does. The card is the only cloud authorization route (C9). While the cloud card is the thread's
// last word, a yes only OPENS that card: it is read back as the person (career_apply_message_card_read_own) and the
// reply points them to its Approve button, with the card's id so the app can open it. The binding is minted only by the
// person's tap on the exact hash-bound card (career_apply_message_card_approve_own -> cloud_tap, 20261024130000), never
// from here. This module holds no approve, begin, enqueue, claim or finish call: its store has no method that could
// make one.
//
// It answers only when all of these hold, else the turn goes on as before:
//   - an explicit yes ("ok", "sure" and "y" are too easily a reply to something else);
//   - the thread's last word is the cloud card itself (career_apply_message_cloud_card_show_as writes it with intent
//     career_message_approval and the card's id), so the yes is about that card and no other;
//   - the turn runs on the person's own session (a texting channel's service-role turn is left alone: F-037's work).

export const CLOUD_CARD_INTENT = "career_message_approval";
const YES = /^(yes|approve|approve it|yes,? approve( it)?|yes,? apply|yes,? send it)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCardYes(text: string): boolean {
  return YES.test(String(text ?? "").toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ").trim());
}

export interface CloudCardChatStore {
  // The thread's last assistant message.
  lastAssistant(threadId: string): Promise<{ meta: Record<string, unknown> } | null>;
  // career_apply_message_card_read_own, as the person: read only.
  read(cardId: string): Promise<{ id?: unknown; state?: unknown }>;
}
export type CardYes = { reply: string; status: "open_card" | "closed" | "unreadable"; card_id: string };

export const TAP_TO_SEND = "I didn't send it because a text yes can't approve this card. Tap Approve on the card above to send exactly what it shows; nothing goes until you do.";

export async function cloudCardYesTurn(o: { message: string; threadId: string; ownSession: boolean; store: CloudCardChatStore }): Promise<CardYes | null> {
  if (!o.ownSession || !parseCardYes(o.message)) return null;
  let last;
  try { last = await o.store.lastAssistant(o.threadId); } catch { return null; }
  const cardId = last?.meta?.career_approval_card_id;
  if (!last || last.meta?.intent !== CLOUD_CARD_INTENT || typeof cardId !== "string" || !UUID.test(cardId)) return null;
  try {
    const card = await o.store.read(cardId);
    if (card?.id !== cardId) return { reply: "I couldn't open that card. Nothing was sent.", status: "unreadable", card_id: cardId };
    if (card.state !== "open") {
      return { reply: card.state === "approved" ? "That card is already approved; nothing more was sent." : "That card has expired, so nothing was sent. Ask me to show it again.", status: "closed", card_id: cardId };
    }
    return { reply: TAP_TO_SEND, status: "open_card", card_id: cardId };
  } catch {
    return { reply: "I couldn't open that card. Nothing was sent.", status: "unreadable", card_id: cardId };
  }
}

// The store over the person's own Supabase session (anon key plus their JWT), read only: one table read, one read RPC.
// deno-lint-ignore no-explicit-any
export function personCloudCardStore(personClient: any): CloudCardChatStore {
  const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data as T;
  };
  return {
    async lastAssistant(threadId) {
      const rows = must<any[]>(await personClient.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant")
        .order("id", { ascending: false }).limit(1), "read the last reply") ?? [];
      return rows[0]?.meta ? { meta: rows[0].meta } : null;
    },
    async read(cardId) { return must(await personClient.rpc("career_apply_message_card_read_own", { p_card: cardId }), "read the card") ?? {}; },
  };
}
