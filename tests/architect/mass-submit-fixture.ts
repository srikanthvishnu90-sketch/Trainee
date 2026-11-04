// The database's card half, in memory, for the mass-submission chat tests (mass-submit-chat.test.ts,
// mass-submit-channels.test.ts). It does what career_apply_card_open_for / career_apply_card_answer_for do
// (20261020030000, 20261025170000): one open card per person (a newer card closes the older one), a card is answered once,
// an item whose prepared payload no longer hashes to what the card carries is 'changed' and not queued while the rest go
// on, approvals only within 10 minutes, nothing after 24 hours. `cap` refuses a card of more than 8, as the database does
// before builder A's D-MS-2 migration. Synthetic only.
import { CARD_INTENT, type CardStore, cardTurn, cardWaiting, type Prepared } from "../../supabase/functions/_shared/career_apply_cards.ts";

export const T = Date.parse("2026-10-27T15:00:00Z");
export const U = "TEST-USER";
export const COMPANIES = ["Acme Robotics", "Beta Labs", "Gamma Data", "Delta Freight", "Echo Health", "Foxtrot Bank"];
export const prep = (i: number): Prepared => ({
  id: `P${i}`,
  company: COMPANIES[i - 1] ?? `TEST Employer ${i}`,
  card_lines: [`${COMPANIES[i - 1] ?? `TEST Employer ${i}`}: TEST Analyst`, `Email: t@example.test`, `Resume: resume-${i}.pdf`, `Sends to https://jobs.lever.co/test/${i}`],
  // OWNER RULE (2026-10-26, #194): a card shows only applications that send a resume (the payload binds its sha256).
  resume_sha256: "a".repeat(64),
});

// The database, in memory: prepared rows with their current hash, cards, the queue (career_apply_jobs).
export function db(o: { n?: number; cap?: boolean } = {}) {
  const prepared = Array.from({ length: o.n ?? 3 }, (_, i) => ({ ...prep(i + 1), hash: `h${i + 1}`, state: "ready" }));
  const cards: { id: string; items: { n: number; prepared_id: string; payload_hash: string }[]; shown_at: string; state: string; closed?: boolean }[] = [];
  const queue: { prepared_id: string; approval: string }[] = [];
  const answerCalls: { card: string; approve: number[] }[] = [];
  let now = T, seq = 0, lastIntent: string | null = null, lastCard: string | null = null;
  const messages: Record<string, string> = {}; // message id -> card id it carried
  const store: CardStore = {
    pending: async () => prepared.filter((p) => ["ready", "shown"].includes(p.state)).map(({ id, company, card_lines, resume_sha256 }) => ({ id, company, card_lines, resume_sha256 })),
    open: async (_u, ids) => {
      if (!ids.length || (o.cap && ids.length > 8)) throw new Error("open a card: invalid card");
      for (const c of cards) if (c.state === "open") { c.state = "answered"; c.closed = true; }
      const card = { id: `C${++seq}`, items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: prepared.find((p) => p.id === id)!.hash })), shown_at: new Date(now).toISOString(), state: "open" };
      for (const id of ids) prepared.find((p) => p.id === id)!.state = "shown";
      cards.push(card);
      return card;
    },
    latestOpen: async () => cards.filter((c) => c.state === "open").at(-1) ?? null,
    answer: async (_u, cardId, approve) => {
      answerCalls.push({ card: cardId, approve });
      const c = cards.find((x) => x.id === cardId)!;
      if (c.state !== "open") throw new Error("answer the card: card_answered");
      if (Date.parse(c.shown_at) < now - 24 * 3600_000) throw new Error("answer the card: card_expired");
      if (approve.length && Date.parse(c.shown_at) < now - 10 * 60_000) throw new Error("answer the card: card_stale");
      if (approve.some((n) => n < 1 || n > c.items.length)) throw new Error("answer the card: not_on_card");
      const out = c.items.map((it) => {
        const p = prepared.find((x) => x.id === it.prepared_id)!;
        let result: string;
        if (p.hash !== it.payload_hash) result = "changed";
        else if (approve.includes(it.n)) { queue.push({ prepared_id: p.id, approval: it.payload_hash }); result = "queued"; }
        else result = "declined";
        p.state = result === "queued" ? "approved" : "declined";
        return { n: it.n, company: p.company, result };
      });
      c.state = "answered";
      return out;
    },
    lastAssistantIntent: async () => lastIntent,
    lastShownCard: async () => (lastIntent === CARD_INTENT ? lastCard : null),
    cardOfMessage: async (_t, id) => messages[String(id)] ?? null,
    cardState: async (_u, id) => {
      const c = cards.find((x) => x.id === id);
      return !c ? null : c.state === "open" ? "open" : c.closed ? "closed" : "answered";
    },
  };
  // One turn as the handler runs it: the card's reply becomes the thread's last word while it waits (CARD_WAITING).
  const say = async (message: string, extra: { replyTo?: string; at?: number } = {}) => {
    if (extra.at !== undefined) now = extra.at;
    const r = await cardTurn({ message, userId: U, threadId: "TH", now, store, replyTo: extra.replyTo });
    if (r) {
      const waiting = cardWaiting(r);
      lastIntent = waiting ? CARD_INTENT : "career_apply_card_answer";
      if (waiting && r.card_id) { lastCard = r.card_id; messages[`M-${r.card_id}-${seq}`] = r.card_id; }
    } else lastIntent = "agent";
    return r;
  };
  return {
    store, say, queue, answerCalls, prepared, cards,
    change: (i: number) => { prepared[i - 1].hash = `h${i}-changed`; },
    queuedCompanies: () => queue.map((q) => prepared.find((p) => p.id === q.prepared_id)!.company),
    setNow: (t: number) => { now = t; },
    otherReply: () => { lastIntent = "agent"; },
  };
}

