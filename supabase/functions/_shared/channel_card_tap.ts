// FEATURE 16 (2026-10-26): the card's Approve and Decline as buttons on a texting channel (Telegram's inline keyboard),
// answered exactly as the web chat's tap answers them (src/career-apply-card.js): the card and the prepared applications
// it names are read; the card must still be open and every item's prepared payload must still hash to the hash the card
// carries; then one call, career_apply_card_answer_for through its service-role door career_apply_card_answer_as (the
// webhook has no person's session; career_apply_card_answer_own is the same function for a signed-in person), with
// exactly the card's numbers (Approve) or none (Decline). The database approves each item only if it still hashes to the
// card's hash, within 10 minutes of the card's showing, once, and queues exactly that payload. Nothing is sent here.
//
// The button binds the card: its data is "tca:<card id>:<digest>" (Approve) or "tcd:<card id>:<digest>" (Decline), the
// digest being the first 16 hex of sha256 over the card's id and each item's number and payload hash. A tap whose card
// is gone, answered, someone else's, or whose items changed since the buttons were made approves nothing, and says so.
import { answerText, type CardResult, pagesOf } from "./career_apply_cards.ts";
import { type EventStore, recordEvents } from "./agent/timeline.ts";

export interface TapCard { id: string; user_id?: string; items: { n: number; prepared_id: string; payload_hash: string }[]; state: string; shown_at?: string }
export interface TapStore {
  card(userId: string, cardId: string): Promise<TapCard | null>;
  prepared(userId: string, ids: string[]): Promise<{ id: string; payload_hash: string; company?: string }[]>;
  answer(userId: string, cardId: string, approve: number[]): Promise<CardResult[]>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function cardDigest(card: Pick<TapCard, "id" | "items">): Promise<string> {
  const items = [...(card.items ?? [])].sort((a, b) => a.n - b.n).map((i) => `${i.n}:${i.payload_hash}`).join(",");
  return (await hex(`${card.id}|${items}`)).slice(0, 16);
}
export async function cardButtons(card: Pick<TapCard, "id" | "items">): Promise<{ text: string; data: string }[][]> {
  const d = await cardDigest(card), n = card.items.length;
  return [[{ text: n === 1 ? "Approve" : `Approve all ${n}`, data: `tca:${card.id}:${d}` }, { text: "Decline", data: `tcd:${card.id}:${d}` }]];
}
export function parseTap(data: string): { approve: boolean; cardId: string; digest: string } | null {
  const m = /^(tca|tcd):([0-9a-f-]{36}):([0-9a-f]{16})$/.exec(String(data ?? ""));
  if (!m || !UUID.test(m[2])) return null;
  return { approve: m[1] === "tca", cardId: m[2], digest: m[3] };
}

export const TAP_UNKNOWN = "That button no longer works, so nothing was approved. Say \"show my applications\" for the current card.";
export const TAP_CHANGED = "That card changed after it was shown, so nothing was approved. Say \"show my applications\" for the current one.";
export const TAP_ANSWERED = "That card was already answered. Nothing more was sent.";
export const TAP_STALE = "That card was shown more than 10 minutes ago, so nothing was approved. Say \"show my applications\" for a fresh card.";
export const TAP_EXPIRED = "That card is more than a day old, so nothing was approved. Say \"show my applications\" to see it again.";
export const TAP_FAILED = "Nothing was approved: the card could not be answered just now. Try the button again in a minute.";

// toast: the short line on the button (answerCallbackQuery); reply: the message in the chat, when there is one.
export async function tapCard(o: { userId: string; data: string; now: number; store: TapStore; events?: EventStore | null }):
  Promise<{ toast: string; reply: string; status: string; parts?: string[] }> {
  const t = parseTap(o.data);
  if (!t) return { toast: "Nothing was approved.", reply: TAP_UNKNOWN, status: "unknown" };
  let card: TapCard | null;
  try { card = await o.store.card(o.userId, t.cardId); } catch { return { toast: "Nothing was approved.", reply: TAP_FAILED, status: "unreadable" }; }
  if (!card || (card.user_id && card.user_id !== o.userId)) return { toast: "Nothing was approved.", reply: TAP_UNKNOWN, status: "unknown" };
  if (await cardDigest(card) !== t.digest) return { toast: "Nothing was approved.", reply: TAP_CHANGED, status: "changed" };
  if (card.state !== "open") return { toast: "Already answered.", reply: TAP_ANSWERED, status: "answered_before" };
  let prepared: { id: string; payload_hash: string }[];
  try { prepared = await o.store.prepared(o.userId, card.items.map((i) => i.prepared_id)); } catch { return { toast: "Nothing was approved.", reply: TAP_FAILED, status: "unreadable" }; }
  const byId = new Map(prepared.map((p) => [p.id, p]));
  if (card.items.some((i) => byId.get(i.prepared_id)?.payload_hash !== i.payload_hash)) return { toast: "Nothing was approved.", reply: TAP_CHANGED, status: "changed" };
  const approve = t.approve ? card.items.map((i) => i.n).sort((a, b) => a - b) : [];
  let results: CardResult[];
  try { results = await o.store.answer(o.userId, card.id, approve); }
  catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/card_stale/.test(msg)) return { toast: "Nothing was approved.", reply: TAP_STALE, status: "stale_card" };
    if (/card_expired/.test(msg)) return { toast: "Nothing was approved.", reply: TAP_EXPIRED, status: "expired" };
    if (/card_answered/.test(msg)) return { toast: "Already answered.", reply: TAP_ANSWERED, status: "answered_before" };
    console.error("card tap:", msg.slice(0, 200));
    return { toast: "Nothing was approved.", reply: TAP_FAILED, status: "failed" };
  }
  // SCALE (owner, 2026-10-27): the batch's timeline lines in one write, never one round trip per item.
  await recordEvents(o.events, results.map((r) => ({
    user_id: o.userId, at: o.now, kind: r.result === "queued" ? "application_approved" : "status_change", subject: r.company,
    detail: { card: card.id, n: r.n, result: r.result, via: "telegram button" }, source: "card",
  })));
  const queued = results.filter((r) => r.result === "queued").length;
  const reply = answerText(results, { declined: t.approve ? undefined : "said_no" });
  const parts = pagesOf(reply);
  return { toast: t.approve ? (queued ? "Approved." : "Nothing was approved.") : "Declined. Nothing was sent.", reply, status: "answered", ...(parts.length ? { parts } : {}) };
}

// The store over the service client, every read scoped to the person who tapped.
// deno-lint-ignore no-explicit-any
export function supabaseTapStore(admin: any): TapStore {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    async card(userId, cardId) {
      const rows = must(await admin.from("career_apply_cards").select("id,user_id,items,state,shown_at").eq("id", cardId).eq("user_id", userId).limit(1), "read the card");
      return rows?.[0] ?? null;
    },
    async prepared(userId, ids) {
      if (!ids.length) return [];
      return must(await admin.from("career_apply_prepared").select("id,payload_hash,company").eq("user_id", userId).in("id", ids), "read the prepared applications") ?? [];
    },
    async answer(userId, cardId, approve) {
      return must(await admin.rpc("career_apply_card_answer_as", { p_user: userId, p_card: cardId, p_approve: approve }), "answer the card");
    },
  };
}

// The buttons for the outbox rows a delivery run claimed that carry an open card (career_outbox.card_id), by row id.
// deno-lint-ignore no-explicit-any
export async function buttonsForRows(admin: any, rowIds: string[]): Promise<Map<string, { text: string; data: string }[][]>> {
  const out = new Map<string, { text: string; data: string }[][]>();
  if (!rowIds.length) return out;
  const rows = (await admin.from("career_outbox").select("id,card_id").in("id", rowIds.map(Number))).data ?? [];
  // deno-lint-ignore no-explicit-any
  const cardIds = [...new Set(rows.map((r: any) => r.card_id).filter((x: unknown) => typeof x === "string" && x))] as string[];
  if (!cardIds.length) return out;
  const cards = (await admin.from("career_apply_cards").select("id,items,state").in("id", cardIds)).data ?? [];
  // deno-lint-ignore no-explicit-any
  const byId = new Map<string, any>(cards.map((c: any) => [c.id, c]));
  for (const r of rows) {
    const c = byId.get(r.card_id);
    if (c && c.state === "open" && Array.isArray(c.items) && c.items.length) out.set(String(r.id), await cardButtons(c));
  }
  return out;
}
