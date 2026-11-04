// The texting channel's database in memory (WO-038): the inbound store and the delivery store over one state, with the
// rules of 20261021070000_channel_parity.sql (a contact per channel, one thread per person, the home channel, STOP across
// channels, held rows, link tokens and link questions). Tests and the simulator run the real handlers over it.
import type { DeliveryMark, OutboxRow } from "./channel.ts";
import type { DeliveryStore } from "./channel_store.ts";
import { type Channel, channelOf } from "./channel_adapters.ts";
import type { InboundStore, Person, Redeemed } from "./channel_inbound.ts";
import { LINK_ASK_MS, LINK_NONCE_MS } from "./channel_inbound.ts";

export interface MemContact { contact: string; userId: string | null; threadId: string | null; optedOut: boolean; phone: string | null; alias: string | null; home: boolean; lastInboundAt: number | null; nudgedAt: number | null; createdAt: number }
export interface MemOutbox {
  id: string; userId: string; key: string; kind: string; text: string; deliverAt: number; channel: Channel | null; createdAt: number;
  status: "queued" | "sending" | "delivered" | "failed" | "skipped_opt_out" | "held"; attempts: number; retryAt: number | null;
  contact: string | null; providerId: string | null; providerIds: string[] | null; deliveredAt: number | null; error: string | null;
  partOf: string | null; part: number | null;
}
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
async function sha256(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
}
const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function memoryChannelWorld() {
  const contacts = new Map<string, MemContact>();
  const outbox: MemOutbox[] = [];
  const claimedIds = new Set<string>();
  const paused = new Set<string>(); // WO-091c: accounts paused or erased (career:account paused), as career_user_quiet reads
  const nonces = new Map<string, { userId: string; expiresAt: number; usedAt: number | null }>();
  const asks: { id: number; userId: string; contact: string; phone: string; askedOn: string; createdAt: number; expiresAt: number; answeredAt: number | null }[] = [];
  let users = 0, seq = 0, asksSeq = 0;
  const phoneOf = (contact: string, phone?: string | null) => (contact.startsWith("+") ? contact : contact.startsWith("tg:") ? null : phone ?? null);
  const upsert = (contact: string, at: number, patch: Partial<MemContact> = {}) => {
    const c = contacts.get(contact) ?? { contact, userId: null, threadId: null, optedOut: false, phone: phoneOf(contact), alias: null, home: false, lastInboundAt: null, nudgedAt: null, createdAt: at };
    Object.assign(c, patch);
    contacts.set(contact, c);
    return c;
  };
  const ofUser = (userId: string) => [...contacts.values()].filter((c) => c.userId === userId);
  const target = (userId: string, channel: Channel | null) => ofUser(userId).filter((c) => !channel || channelOf(c.contact) === channel)
    .sort((a, b) => Number(b.home) - Number(a.home) || (b.lastInboundAt ?? -Infinity) - (a.lastInboundAt ?? -Infinity) || a.createdAt - b.createdAt || a.contact.localeCompare(b.contact))[0]?.contact ?? null;
  const optedOut = (contact: string) => {
    const c = contacts.get(contact);
    if (!c) return false;
    return c.userId ? ofUser(c.userId).some((x) => x.optedOut) : c.optedOut;
  };
  const enqueue = (userId: string, m: { key: string; kind: string; text: string; at: number; channel?: Channel | null; part?: { of: string; n: number } }) => {
    if (outbox.some((o) => o.userId === userId && o.key === m.key)) return false;
    outbox.push({ id: String(++seq), userId, key: m.key, kind: m.kind, text: m.text, deliverAt: m.at, channel: m.channel ?? null, createdAt: m.at, status: "queued", attempts: 0, retryAt: null, contact: null, providerId: null, providerIds: null, deliveredAt: null, error: null,
      partOf: m.part?.of ?? null, part: m.part?.n ?? null });
    return true;
  };
  // A part waits while an earlier part of the same reply waits on something else (the SQL claims' rule); with one key
  // claimed alone, an earlier part still queued must go first.
  const partBlocked = (o: MemOutbox, now: number, single: boolean) => o.partOf !== null && outbox.some((e) => e.userId === o.userId && e.partOf === o.partOf && e.part! < o.part!
    && (e.status === "sending" || e.status === "held" || (e.status === "failed" && e.retryAt !== null && e.retryAt > now) || (e.status === "queued" && (single || e.deliverAt > now))));

  const inbound: InboundStore & { claimed: Set<string> } = {
    claimed: new Set<string>(),
    async claimMessage(id, _at, provider) { const k = `${provider ?? "loopmessage"}:${id}`; if (inbound.claimed.has(k)) return false; inbound.claimed.add(k); return true; },
    async person(contact) {
      const c = contacts.get(contact) ?? (contact.startsWith("wa:") ? [...contacts.values()].find((x) => x.alias === contact.slice(3)) : undefined);
      return c?.userId ? { userId: c.userId, threadId: c.threadId, contact: c.contact } : null;
    },
    async refusedBefore(contact, at) { if (contacts.has(contact)) return true; upsert(contact, at); return false; },
    async createPerson(contact, at, phone): Promise<Person> {
      const userId = `u${++users}`;
      upsert(contact, at, { userId, phone: phoneOf(contact, phone) });
      return { userId, threadId: null, contact };
    },
    async setThread(contact, threadId, userId) { for (const c of contacts.values()) if (userId ? c.userId === userId : c.contact === contact) c.threadId = threadId; },
    async setOptOut(contact, out, at) {
      const c = upsert(contact, at, { optedOut: out });
      if (!out && c.userId) for (const x of ofUser(c.userId)) x.optedOut = false;
    },
    async enqueueReply(userId, key, text, at, channel, part) { return enqueue(userId, { key, kind: "reply", text, at, channel: channel ?? null, part }); },
    async sawInbound(contact, at, o) {
      const c = contacts.get(contact);
      if (!c) return;
      c.lastInboundAt = Math.max(c.lastInboundAt ?? at, at);
      if (!c.alias && o.alias && ![...contacts.values()].some((x) => x.alias === o.alias)) c.alias = o.alias;
      if (channelOf(contact) === "whatsapp" && o.phone) c.phone = o.phone;
      if (!c.userId) return;
      for (const r of outbox) if (r.userId === c.userId && r.status === "held" && (r.channel === null || r.channel === channelOf(contact))) { r.status = "queued"; r.deliverAt = Math.min(r.deliverAt, at); r.error = null; }
    },
    async linkCandidate(phone, except) {
      const c = [...contacts.values()].filter((x) => x.phone === phone && x.userId && channelOf(x.contact) !== except && !x.optedOut).sort((a, b) => (b.lastInboundAt ?? -Infinity) - (a.lastInboundAt ?? -Infinity))[0];
      return c ? { userId: c.userId!, contact: c.contact } : null;
    },
    async askToLink(a) {
      if (asks.some((x) => x.userId === a.userId && x.contact === a.contact && x.answeredAt === null && x.expiresAt > a.at)) return null;
      const on = contacts.get(a.askedOn);
      if (!on || on.userId !== a.userId) return null;
      // The new contact's message is recorded (no account): its answer later is inside WhatsApp's window.
      const seen = contacts.get(a.contact);
      upsert(a.contact, a.at, { lastInboundAt: Math.max(seen?.lastInboundAt ?? a.at, a.at), phone: seen?.phone ?? a.phone });
      const id = ++asksSeq;
      asks.push({ id, userId: a.userId, contact: a.contact, phone: a.phone, askedOn: a.askedOn, createdAt: a.at, expiresAt: a.at + LINK_ASK_MS, answeredAt: null });
      enqueue(a.userId, { key: `link:${id}`, kind: "link", text: a.text, at: a.at, channel: channelOf(a.askedOn) });
      return `link:${id}`;
    },
    async confirmLink(a) {
      const r = asks.filter((x) => x.userId === a.userId && x.askedOn === a.askedOn && x.answeredAt === null && x.expiresAt > a.at).sort((x, y) => y.createdAt - x.createdAt)[0];
      if (!r) return null;
      r.answeredAt = a.at;
      const other = contacts.get(r.contact)?.userId;
      if (other && other !== a.userId) return null;
      upsert(r.contact, a.at, { userId: a.userId, threadId: contacts.get(a.askedOn)?.threadId ?? null, phone: r.phone });
      enqueue(a.userId, { key: `link:${r.id}:done`, kind: "link", text: a.notice, at: a.at, channel: channelOf(r.contact) });
      return { contact: r.contact, key: `link:${r.id}:done` };
    },
    async issueLinkNonce(userId, at) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const n = Array.from(bytes, (b) => NONCE_CHARS[b & 63]).join("");
      nonces.set(await sha256(n), { userId, expiresAt: at + LINK_NONCE_MS, usedAt: null });
      return n;
    },
    async redeemLinkNonce(nonce, contact, at): Promise<Redeemed> {
      const row = nonces.get(await sha256(nonce));
      if (!row || row.usedAt !== null || row.expiresAt <= at) return { ok: false, why: "invalid" };
      row.usedAt = at;
      const other = contacts.get(contact)?.userId;
      if (other && other !== row.userId) return { ok: false, why: "linked_elsewhere" };
      const thread = ofUser(row.userId).find((c) => c.threadId)?.threadId ?? null;
      for (const c of ofUser(row.userId)) if (channelOf(c.contact) === "telegram" && c.contact !== contact) { c.userId = null; c.threadId = null; c.home = false; }
      upsert(contact, at, { userId: row.userId, threadId: contacts.get(contact)?.threadId ?? thread, lastInboundAt: at });
      return { ok: true, userId: row.userId, threadId: thread };
    },
    async reholdSent(providerMessageId, _at, error) {
      let n = 0;
      for (const r of outbox) if (r.status === "delivered" && (r.providerId === providerMessageId || r.providerIds?.includes(providerMessageId))) { r.status = "held"; r.deliveredAt = null; r.error = error; n++; }
      return n;
    },
  };

  // A delivery store over the same state; scope: one row (a reply) or one person (everything due for them).
  const delivery = (scope: { only?: { userId: string; key: string }; user?: string } = {}): DeliveryStore => {
    const mine = new Map<string, string>(); // id -> prior status
    return {
      async due(now, limit) {
        const rows = outbox.filter((o) => !claimedIds.has(o.id) && o.deliverAt <= now && (o.status === "queued" || (o.status === "failed" && o.retryAt !== null && o.retryAt <= now))
          && (!scope.only || (o.userId === scope.only.userId && o.key === scope.only.key)) && (!scope.user || o.userId === scope.user) && !partBlocked(o, now, !!scope.only))
          .sort((a, b) => a.deliverAt - b.deliverAt || Number(a.id) - Number(b.id));
        const out: OutboxRow[] = [];
        for (const o of rows) {
          if (out.length >= limit) break;
          const contact = target(o.userId, o.channel);
          if (!contact) continue;
          mine.set(o.id, o.status); claimedIds.add(o.id);
          o.status = "sending"; o.contact = contact;
          const c = contacts.get(contact)!;
          out.push({ id: o.id, userId: o.userId, contact, key: o.key, text: o.text, deliver_at: o.deliverAt, attempts: o.attempts,
            ...(channelOf(contact) === "whatsapp" ? { lastInboundAt: c.lastInboundAt, nudgedAt: c.nudgedAt } : {}) });
        }
        return out;
      },
      async optedOut(contact) { return optedOut(contact); },
      async quiet(userId) { return paused.has(userId) || ofUser(userId).some((c) => c.optedOut); },
      async setOptOut(contact, out, at) { await inbound.setOptOut(contact, out, at); },
      async contactsSentOn(day, channel) { return new Set(outbox.filter((o) => o.status === "delivered" && o.deliveredAt !== null && utcDay(o.deliveredAt) === day && (!channel || channelOf(o.contact!) === channel)).map((o) => o.contact)).size; },
      async sentTo(contact, day) { return outbox.some((o) => o.contact === contact && o.status === "delivered" && o.deliveredAt !== null && utcDay(o.deliveredAt) === day); },
      async mark(id, m: DeliveryMark) {
        const o = outbox.find((x) => x.id === id);
        if (!o || o.status !== "sending") return;
        o.status = m.status; o.error = m.error ?? null; claimedIds.delete(id); mine.delete(id);
        if (m.status === "delivered") { o.deliveredAt = m.at; o.providerId = m.providerId ?? null; o.providerIds = m.providerIds ?? (m.providerId ? [m.providerId] : null); o.retryAt = null; }
        else if (m.status === "failed") { o.attempts++; o.retryAt = m.retryAt ?? null; }
        else o.retryAt = null;
      },
      async heldFor(userId) { return outbox.filter((o) => o.userId === userId && o.status === "held").length; },
      async nudgesOn(day) { return [...contacts.values()].filter((c) => channelOf(c.contact) === "whatsapp" && c.nudgedAt !== null && utcDay(c.nudgedAt) === day).length; },
      async setNudged(contact, at) { const c = contacts.get(contact); if (c) c.nudgedAt = at; },
      async release() { let n = 0; for (const [id, prior] of mine) { const o = outbox.find((x) => x.id === id)!; if (o.status === "sending") { o.status = prior as MemOutbox["status"]; o.contact = null; n++; } claimedIds.delete(id); mine.delete(id); } return n; },
      async sweep() { return 0; },
    };
  };

  return {
    inbound, delivery, contacts, outbox, asks,
    paused, // WO-091c: add a user id to pause that account
    // What Trainee starts (alerts, reports, receipts, cards): queued for the home channel at delivery time.
    queue: (userId: string, m: { key: string; kind: string; text: string; at: number; channel?: Channel | null }) => enqueue(userId, m),
    link: (contact: string, userId: string, at: number, patch: Partial<MemContact> = {}) => upsert(contact, at, { userId, ...patch }),
    person: (userId: string) => ofUser(userId),
    newUser: () => `u${++users}`,
  };
}
