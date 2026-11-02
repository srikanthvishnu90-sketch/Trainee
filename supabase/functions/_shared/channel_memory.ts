// The texting channel's database in memory (WO-038): the inbound store and the delivery store over one state, with the
// rules of 20261021070000_channel_parity.sql (a contact per channel, one thread per person, the home channel, STOP across
// channels, held rows, link tokens and link questions). Tests and the simulator run the real handlers over it.
import type { DeliveryMark, OutboxRow } from "./channel.ts";
import type { DeliveryStore } from "./channel_store.ts";
import { type Channel, channelOf } from "./channel_adapters.ts";
import type { InboundStore, Person, Redeemed } from "./channel_inbound.ts";
import { LINK_ASK_MS, LINK_CODE_ASK_MS, LINK_NONCE_MS } from "./channel_inbound.ts";
import { NO_CHANNEL_NOTE } from "./channel.ts";

// refusedAt (IDENTITY SCENARIOS, 2026-10-30): channel_contacts.refused_at, the sign-up refusal said to this contact.
export interface MemContact { contact: string; userId: string | null; threadId: string | null; optedOut: boolean; phone: string | null; alias: string | null; home: boolean; lastInboundAt: number | null; nudgedAt: number | null; createdAt: number; refusedAt?: number | null; optedOutAt?: number | null }
export interface MemOutbox {
  id: string; userId: string; key: string; kind: string; text: string; deliverAt: number; channel: Channel | null; createdAt: number;
  status: "queued" | "sending" | "delivered" | "failed" | "skipped_opt_out" | "held"; attempts: number; retryAt: number | null;
  contact: string | null; providerId: string | null; providerIds: string[] | null; deliveredAt: number | null; error: string | null;
  partOf: string | null; part: number | null;
  sentParts?: number; // CHANNEL DELIVERY ROUND 2: career_outbox.sent_parts
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
  // byCode (TELEGRAM LINK OWNERSHIP, 2026-10-31): the question a link code's opening asked (no number; channel_link_requests.by_code).
  const asks: { id: number; userId: string; contact: string; phone: string | null; askedOn: string; createdAt: number; expiresAt: number; answeredAt: number | null; byCode?: boolean }[] = [];
  let users = 0, seq = 0, asksSeq = 0;
  // IDENTITY SCENARIOS (2026-10-30): a Telegram contact keeps a number only from the person's own share (Telegram's verified
  // number, the only way one reaches Trainee there), as 20261030120000_channel_identity.sql allows.
  const phoneOf = (contact: string, phone?: string | null) => (contact.startsWith("+") ? contact : phone ?? null);
  const upsert = (contact: string, at: number, patch: Partial<MemContact> = {}) => {
    const c = contacts.get(contact) ?? { contact, userId: null, threadId: null, optedOut: false, phone: phoneOf(contact), alias: null, home: false, lastInboundAt: null, nudgedAt: null, createdAt: at };
    Object.assign(c, patch);
    if (c.userId) c.refusedAt = null; // a contact that gets an account starts afresh (channel_contacts_refusal_reset)
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

  const backTo = (providerMessageId: string, at: number, error: string, to: "held" | "failed" | "retry") => {
    let n = 0;
    for (const r of outbox) {
      // Out of order: a row already held or failed by a later message's status goes back to this earlier one too.
      if ((r.status === "held" || r.status === "failed") && r.providerIds?.includes(providerMessageId)) {
        const k = r.providerIds.indexOf(providerMessageId);
        r.sentParts = k; r.providerIds = k ? r.providerIds.slice(0, k) : null; r.providerId = k ? r.providerIds![0] : null;
        n++;
        continue;
      }
      if (r.status !== "delivered" || !(r.providerId === providerMessageId || r.providerIds?.includes(providerMessageId))) continue;
      const k = Math.max(0, (r.providerIds ?? []).indexOf(providerMessageId));
      r.sentParts = k; r.providerIds = k ? r.providerIds!.slice(0, k) : null; r.providerId = k ? r.providerIds![0] : null;
      r.deliveredAt = null; r.error = error;
      if (to === "held") { r.status = "held"; r.retryAt = null; }
      else { r.attempts = Math.min(r.attempts + 1, 10); r.status = "failed"; r.retryAt = to === "retry" && r.attempts < 3 ? at + 60000 : null; }
      n++;
    }
    return n;
  };
  const inbound: InboundStore & { claimed: Set<string> } = {
    claimed: new Set<string>(),
    async claimMessage(id, _at, provider) { const k = `${provider ?? "loopmessage"}:${id}`; if (inbound.claimed.has(k)) return false; inbound.claimed.add(k); return true; },
    async person(contact) {
      const c = contacts.get(contact) ?? (contact.startsWith("wa:") ? [...contacts.values()].find((x) => x.alias === contact.slice(3)) : undefined);
      return c?.userId ? { userId: c.userId, threadId: c.threadId, contact: c.contact, alias: c.alias } : null;
    },
    // IDENTITY SCENARIOS (2026-10-30): the refusal itself is what is remembered, not that a row exists.
    async refusedBefore(contact, at) {
      const c = contacts.get(contact);
      if (c && !c.userId && c.refusedAt != null) return true;
      upsert(contact, at, { refusedAt: at });
      return false;
    },
    async pendingLink(contact, at) {
      const r = asks.filter((x) => x.contact === contact && x.answeredAt === null && x.expiresAt > at).sort((x, y) => y.createdAt - x.createdAt || y.id - x.id)[0];
      return r ? r.askedOn : null;
    },
    async createPerson(contact, at, phone): Promise<Person> {
      const userId = `u${++users}`;
      upsert(contact, at, { userId, phone: phoneOf(contact, phone) });
      return { userId, threadId: null, contact };
    },
    async setThread(contact, threadId, userId) { for (const c of contacts.values()) if (userId ? c.userId === userId : c.contact === contact) c.threadId = threadId; },
    async setOptOut(contact, out, at) {
      const c = upsert(contact, at, { optedOut: out, optedOutAt: out ? at : null });
      if (!out && c.userId) for (const x of ofUser(c.userId)) { x.optedOut = false; x.optedOutAt = null; }
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
    // IDENTITY SCENARIOS (2026-10-30): a stopped account is still the number's account (it was skipped, and the number signed
    // up a second time); it is returned marked, after any account that is not stopped. Stopped is the person's (any contact).
    async linkCandidate(phone, except) {
      const c = [...contacts.values()].filter((x) => x.phone === phone && x.userId && channelOf(x.contact) !== except)
        .sort((a, b) => Number(optedOut(a.contact)) - Number(optedOut(b.contact)) || (b.lastInboundAt ?? -Infinity) - (a.lastInboundAt ?? -Infinity))[0];
      return c ? { userId: c.userId!, contact: c.contact, optedOut: optedOut(c.contact) } : null;
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
      const open = asks.filter((x) => x.userId === a.userId && x.askedOn === a.askedOn && x.answeredAt === null && x.expiresAt > a.at).sort((x, y) => y.createdAt - x.createdAt || y.id - x.id);
      const r = open[0];
      if (!r) return null;
      // TELEGRAM LINK OWNERSHIP (2026-10-31; 20261031040000): two questions open, one a link code's: a yes cannot say which it
      // meant, so neither is linked and both close; a code's question whose contact is stopped since links nothing.
      if (open.length > 1 && open.some((x) => x.byCode)) { for (const x of open) x.answeredAt = a.at; return { ambiguous: true as const }; }
      r.answeredAt = a.at;
      if (r.byCode && optedOut(a.askedOn)) return null;
      const other = contacts.get(r.contact)?.userId;
      if (other && other !== a.userId) return null;
      // IDENTITY SCENARIOS (2026-10-30): one contact per channel: the account's earlier chat on that channel is let go.
      for (const c of ofUser(a.userId)) if (channelOf(c.contact) === channelOf(r.contact) && c.contact !== r.contact) { c.userId = null; c.threadId = null; c.home = false; }
      upsert(r.contact, a.at, { userId: a.userId, threadId: contacts.get(a.askedOn)?.threadId ?? null, ...(r.phone ? { phone: r.phone } : {}) });
      enqueue(a.userId, { key: `link:${r.id}:done`, kind: "link", text: a.notice, at: a.at, channel: channelOf(r.contact) });
      return { contact: r.contact, key: `link:${r.id}:done` };
    },
    async issueLinkNonce(userId, at) {
      // At most three live links a person: an older one is burned (channel_link_nonce_issue).
      const live = [...nonces.values()].filter((n) => n.userId === userId && n.usedAt === null && n.expiresAt > at).sort((a, b) => b.expiresAt - a.expiresAt);
      for (const n of live.slice(2)) n.usedAt = at;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const n = Array.from(bytes, (b) => NONCE_CHARS[b & 63]).join("");
      nonces.set(await sha256(n), { userId, expiresAt: at + LINK_NONCE_MS, usedAt: null });
      return n;
    },
    // TELEGRAM LINK OWNERSHIP (2026-10-31), as 20261031040000_telegram_link_confirm.sql channel_link_nonce_ask: opening a code
    // links nothing new. It asks the account's own channel (a contact that is not stopped first, the one written from last),
    // the code is used by that one question, and the chat is linked only on the YES there (confirmLink).
    async redeemLinkNonce(nonce, contact, at, askText): Promise<Redeemed> {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(nonce) || !/^tg:[1-9][0-9]{0,19}$/.test(contact)) return { ok: false, why: "invalid" };
      const row = nonces.get(await sha256(nonce));
      if (!row || row.usedAt !== null || row.expiresAt <= at) return { ok: false, why: "invalid" };
      // TELEGRAM ROUND 3 (2026-10-31): a chat that is another account's links nothing and no longer uses the code up (as
      // 20261031030000_telegram_link_code_kept.sql): the code's owner can still open it in their own chat.
      const here = contacts.get(contact);
      if (here?.userId && here.userId !== row.userId) return { ok: false, why: "linked_elsewhere" };
      if (here?.userId === row.userId) { row.usedAt = at; return { ok: true, userId: row.userId, threadId: here.threadId }; }
      const on = ofUser(row.userId).filter((c) => c.contact !== contact)
        .sort((a, b) => Number(optedOut(a.contact)) - Number(optedOut(b.contact)) || (b.lastInboundAt ?? -Infinity) - (a.lastInboundAt ?? -Infinity) || a.createdAt - b.createdAt || a.contact.localeCompare(b.contact))[0];
      if (!on || optedOut(on.contact)) return { ok: false, why: "cant_ask" };
      row.usedAt = at;
      const id = ++asksSeq;
      asks.push({ id, userId: row.userId, contact, phone: null, askedOn: on.contact, createdAt: at, expiresAt: at + LINK_CODE_ASK_MS, answeredAt: null, byCode: true });
      enqueue(row.userId, { key: `link:${id}`, kind: "link", text: askText, at, channel: channelOf(on.contact) });
      return { ok: false, why: "asked", userId: row.userId, key: `link:${id}` };
    },
    async pendingCodeLink(contact, at) {
      return asks.some((x) => x.contact === contact && x.byCode && x.answeredAt === null && x.expiresAt > at);
    },
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): as 20261030100000's career_outbox_rehold and career_outbox_fail_sent: the row
    // keeps what went before the failed message (sent_parts, the ids before it), so it resumes from that message and a late
    // copy of the same status finds nothing.
    async reholdSent(providerMessageId, at, error) { return backTo(providerMessageId, at, error, "held"); },
    async failSent(providerMessageId, at, error, retry) { return backTo(providerMessageId, at, error, retry ? "retry" : "failed"); },
    async releaseContact(contact, at) {
      if (contacts.get(contact)?.userId) contacts.delete(contact);
      void at;
    },
    async movedNumber(from, to, at) {
      const c = contacts.get(from);
      if (!c?.userId || from === to || !/^wa:[0-9]{6,20}$/.test(to)) return false;
      const other = contacts.get(to);
      if (other?.userId && other.userId !== c.userId) return false;
      const keep = { userId: c.userId, threadId: c.threadId, home: c.home, alias: c.alias, optedOut: c.optedOut, lastInboundAt: c.lastInboundAt };
      Object.assign(c, { userId: null, threadId: null, home: false, alias: null, nudgedAt: null, optedOut: false });
      const digits = to.slice(3);
      upsert(to, at, { ...keep, phone: digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null });
      return true;
    },
    async unlinkTelegram(userId, at) {
      let n = 0;
      for (const c of ofUser(userId)) if (channelOf(c.contact) === "telegram") { c.userId = null; c.threadId = null; c.home = false; n++; }
      void at;
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
            ...(channelOf(contact) === "whatsapp" ? { lastInboundAt: c.lastInboundAt, nudgedAt: c.nudgedAt } : {}),
            ...(o.sentParts ? { sentParts: o.sentParts, sentIds: [...(o.providerIds ?? [])] } : {}) });
        }
        return out;
      },
      async optedOut(contact) { return optedOut(contact); },
      // TELEGRAM ROUND 3: the time of the STOP, as channel_store.ts reads it (this contact, or any of its account's).
      async optedOutAt(contact) {
        const c = contacts.get(contact);
        const rows = c?.userId ? ofUser(c.userId) : c ? [c] : [];
        const at = rows.filter((x) => x.optedOut && typeof x.optedOutAt === "number").map((x) => x.optedOutAt as number);
        return at.length ? Math.max(...at) : null;
      },
      async stillTheirs(userId, contact) { return contacts.get(contact)?.userId === userId; },
      async quiet(userId) { return paused.has(userId) || ofUser(userId).some((c) => c.optedOut); },
      async setOptOut(contact, out, at) { await inbound.setOptOut(contact, out, at); },
      async contactsSentOn(day, channel) { return new Set(outbox.filter((o) => o.status === "delivered" && o.deliveredAt !== null && utcDay(o.deliveredAt) === day && (!channel || channelOf(o.contact!) === channel)).map((o) => o.contact)).size; },
      async sentTo(contact, day) { return outbox.some((o) => o.contact === contact && o.status === "delivered" && o.deliveredAt !== null && utcDay(o.deliveredAt) === day); },
      async mark(id, m: DeliveryMark) {
        const o = outbox.find((x) => x.id === id);
        if (!o || o.status !== "sending") return;
        o.status = m.status; o.error = m.error ?? null; claimedIds.delete(id); mine.delete(id);
        if (m.sentParts !== undefined) { o.sentParts = m.sentParts; o.providerIds = m.providerIds?.length ? m.providerIds.slice(0, 10) : null; }
        if (m.status === "delivered") { if (m.text !== undefined) o.text = m.text; o.deliveredAt = m.at; o.providerId = m.providerId ?? null; o.providerIds = m.providerIds ?? (m.providerId ? [m.providerId] : null); o.retryAt = null; o.sentParts = 0; }
        else if (m.status === "queued") { o.contact = null; o.retryAt = null; if (m.deliverAt !== undefined) o.deliverAt = m.deliverAt; }
        else if (m.status === "failed") { o.attempts++; o.retryAt = m.retryAt ?? null; }
        else o.retryAt = null;
      },
      // CHANNEL DELIVERY ROUND 2: what waits for the person on WhatsApp: held, and still to go (a run takes 20 at a time).
      async heldFor(userId) { return outbox.filter((o) => o.userId === userId && (o.channel === null || o.channel === "whatsapp") && (o.status === "held" || o.status === "queued" || o.status === "sending")).length; },
      async nudgesOn(day) { return [...contacts.values()].filter((c) => channelOf(c.contact) === "whatsapp" && c.nudgedAt !== null && utcDay(c.nudgedAt) === day).length; },
      async setNudged(contact, at) { const c = contacts.get(contact); if (c) c.nudgedAt = at; },
      async release() { let n = 0; for (const [id, prior] of mine) { const o = outbox.find((x) => x.id === id)!; if (o.status === "sending") { o.status = prior as MemOutbox["status"]; o.contact = null; n++; } claimedIds.delete(id); mine.delete(id); } return n; },
      async sweep() { return 0; },
      // CHANNEL DELIVERY ROUND 2 (2026-10-30): as career_outbox_reroute.
      async reroute(now) { return reroute(now); },
    };
  };
  const reroute = (now: number) => {
    let n = 0;
    for (const o of outbox) {
      if (o.channel === null || !(o.status === "queued" || o.status === "held" || (o.status === "failed" && o.retryAt !== null))) continue;
      if (target(o.userId, o.channel)) continue;
      if (ofUser(o.userId).length) { o.channel = null; if (o.status === "held") o.status = "queued"; o.sentParts = 0; o.providerIds = null; o.providerId = null; }
      else { o.status = "failed"; o.retryAt = null; o.error = NO_CHANNEL_NOTE; }
      n++;
    }
    void now;
    return n;
  };

  return {
    inbound, delivery, contacts, outbox, asks,
    paused, // WO-091c: add a user id to pause that account
    // What Trainee starts (alerts, reports, receipts, cards): queued for the home channel at delivery time.
    queue: (userId: string, m: { key: string; kind: string; text: string; at: number; channel?: Channel | null }) => enqueue(userId, m),
    link: (contact: string, userId: string, at: number, patch: Partial<MemContact> = {}) => upsert(contact, at, { userId, ...patch }),
    person: (userId: string) => ofUser(userId),
    newUser: () => `u${++users}`,
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): the app's home channel (channel_set_home): held rows for the home channel go
    // back in the queue, so they go out on the new home (or are held again there).
    // IDENTITY SCENARIOS (2026-10-30): an account deleted (delete-account): what references auth.users goes with it (on delete
    // cascade): its contacts, its outbox, its link questions and its link tokens.
    deleteUser: (userId: string) => {
      for (const [k, c] of contacts) if (c.userId === userId) contacts.delete(k);
      for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].userId === userId) { claimedIds.delete(outbox[i].id); outbox.splice(i, 1); }
      for (let i = asks.length - 1; i >= 0; i--) if (asks[i].userId === userId) asks.splice(i, 1);
      for (const [k, n] of nonces) if (n.userId === userId) nonces.delete(k);
      paused.delete(userId);
    },
    setHome: (userId: string, channel: Channel) => {
      if (!ofUser(userId).some((c) => channelOf(c.contact) === channel)) return false;
      for (const c of ofUser(userId)) c.home = channelOf(c.contact) === channel;
      for (const o of outbox) if (o.userId === userId && o.status === "held" && o.channel === null) { o.status = "queued"; o.error = null; }
      return true;
    },
  };
}
