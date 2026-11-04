// The texting channel's rules (WO-013a), before any provider: STOP means Trainee sends nothing on its own to that contact
// until START (an answer to a message the person sends is still delivered); every queued message goes out at most once, is retried on a provider's temporary failure, and is never dropped
// silently; a provider's daily contact cap holds (LoopMessage plans: 300 or 1,000 contacts a day). The provider is a
// `Send` function (LoopMessage in WO-013b); the store is memory here and Supabase in 013b.
// WO-038: or one adapter per channel (channel_adapters.ts): iMessage, WhatsApp, Telegram.
import { toBubbles } from "./conversation.ts";
import { addressOf, type Channel, channelOf, type DeliveryAdapter, type SendResult } from "./channel_adapters.ts";

export type ChannelCommand = "stop" | "start" | "help";
const COMMANDS: Record<string, ChannelCommand> = {
  stop: "stop", stopall: "stop", unsubscribe: "stop",
  start: "start", unstop: "start", help: "help", info: "help",
};
// CANCEL, END and QUIT are opt-out words only on SMS: they are in the carrier keyword list (CTIA's opt-out keywords for
// SMS programs) that WO-013 wrote for a texting number. iMessage (LoopMessage), WhatsApp and Telegram are not SMS, and on
// them these are ordinary words a person says to an agent that asks yes/no and cancel questions ("Say cancel and I will
// stop them", "end mock"), so they go to the brain (WO-091c). STOP, STOPALL and UNSUBSCRIBE stay commands everywhere.
const SMS_ONLY: Record<string, ChannelCommand> = { cancel: "stop", end: "stop", quit: "stop" };
// The whole message is the command (any case, end punctuation ignored); "stop sending me sales jobs" is a message.
// `channel`: where the text came in. No channel named (the WO-013a simulator, a bare number) keeps the full SMS list.
// CHANNEL DELIVERY SCENARIOS (2026-10-29): what a phone puts around a typed word is not the word: "STOP…" (iOS turns
// "..." into one "…"), "Stop," and "STOP;" and quotes around it ("“STOP”"), and the invisible characters a copy and paste
// carries (zero-width space, word joiner, byte-order mark). Each was read as a message for the brain, so a STOP was a
// model call and nothing was stopped.
export function channelCommand(text: string, channel?: Channel | "sms"): ChannelCommand | null {
  const t = String(text ?? "").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim().toLowerCase()
    .replace(/^[\s"'“”‘’«»(\[]+/, "").replace(/[.!?,;:…~"'“”‘’«»)\]\s]+$/g, "");
  return COMMANDS[t] ?? (channel === undefined || channel === "sms" ? SMS_ONLY[t] ?? null : null);
}
export const CHANNEL_REPLIES: Record<ChannelCommand, string> = {
  // After STOP nothing goes out on Trainee's own (alerts, reports, nudges); a message the person starts is still answered.
  stop: "You're unsubscribed. Trainee won't message you on its own again, alerts and reports included; it only answers if you text it. Text START to turn messages back on.",
  start: "You're back on. Text STOP any time and every message stops.",
  help: "Trainee is a job-search agent you text: real postings, alerts, applications you approve, interview practice. Text STOP to stop all messages.",
};

export interface OutboxRow {
  id: string; userId: string; contact: string; key: string; text: string; deliver_at: number; attempts: number;
  // WO-038, for a channel with a service window (WhatsApp): the person's last message there and the last template nudge.
  lastInboundAt?: number | null; nudgedAt?: number | null;
  // FEATURE 16: buttons under this message (the card's Approve and Decline on Telegram), set by the store from the row's card.
  buttons?: { text: string; data?: string; loginUrl?: string; url?: string; webApp?: string }[][] | null;
}
export type DeliveryMark = { status: "delivered" | "failed" | "skipped_opt_out" | "held"; at: number; error?: string; providerId?: string; providerIds?: string[]; retryAt?: number };
export interface ChannelStore {
  due(now: number, limit: number): Promise<OutboxRow[]>; // undelivered, deliver_at <= now, oldest first
  optedOut(contact: string): Promise<boolean>;
  // CHANNEL DELIVERY SCENARIOS (2026-10-29): when the person (any of their contacts) last said STOP, null when they are not
  // opted out or the time is not known. Absent: an answer is never held by a STOP (the WO-013a behaviour).
  optedOutAt?(contact: string): Promise<number | null>;
  // WO-091c: the person's account is paused, opted out or erased (career_user_quiet). Absent: only STOP holds a row.
  quiet?(userId: string): Promise<boolean>;
  // A queued job alert or report (key alert:… or report:…) still wanted now: the person's alert settings, the watch behind
  // them and the posting, read at delivery (career_watch_alerts.ts, alertStillWanted). Absent: not checked (memory stores).
  alertWanted?(row: OutboxRow): Promise<boolean>;
  setOptOut(contact: string, out: boolean, at: number): Promise<void>;
  contactsSentOn(day: string, channel?: Channel): Promise<number>; // distinct contacts sent to on a UTC day (on one channel, if named)
  sentTo(contact: string, day: string): Promise<boolean>;
  mark(id: string, r: DeliveryMark): Promise<void>; // a retry is status "failed" with retryAt set and attempts + 1
  // WO-038, for a windowed channel: how many messages wait for the person, templates sent on a day, a nudge recorded.
  heldFor?(userId: string): Promise<number>;
  nudgesOn?(day: string): Promise<number>;
  setNudged?(contact: string, at: number): Promise<void>;
}
export type Send = (contact: string, bubbles: string[]) => Promise<{ ok: true; id: string | null } | { ok: false; error: string; retryable: boolean }>;

// The answer to a message the person sent (trainee-inbound queues it as reply:<provider message id>).
export const isReply = (key: string) => String(key ?? "").startsWith("reply:");
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60000, 5 * 60000, 30 * 60000]; // after attempt 1, 2, 3
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const HELD_NOTE = "held: outside WhatsApp's 24-hour window; it goes out whole when the person next writes";
export const PAUSED_NOTE = "not sent: the person paused Trainee (or stopped or erased it) after this was queued";
export const ALERTS_OFF_NOTE = "not sent: the person's job alerts no longer ask for this (paused, stopped or changed after it was queued)";
export const STOPPED_REPLY_NOTE = "not sent: the person texted STOP after the message this answers; only a message sent after STOP is answered";
// PROACTIVE SCENARIOS (2026-10-29): a job alert or daily report is news on its day, not later. Rows wait in the outbox while
// the person has no texting channel (the dashboard's matches feed reads them there), and when they connected one, every
// alert and report of the weeks before went out at once, each still saying "first seen 20 min ago". Past this age, an
// alert or report is not sent; the dashboard still lists it. Not on a channel with a service window (WhatsApp): there a
// row held for the window goes out whole when the person next writes, however late (WO-038/W5).
export const ALERT_STALE_MS = 48 * 3600000;
export const STALE_NOTE = "not sent: a job alert or report more than 48 hours past its time is no longer news";

// budgetMs: a run that has used its time stops before the next row (a long card is many bubbles, each paced by the
// provider); what it claimed and did not reach goes back for the next run (the store's release), never half sent.
//
// WO-038: `adapters` gives each channel its adapter, and each row goes out on the channel of the contact it was claimed
// for (the claim resolved it: a reply's own channel, otherwise the person's home channel). Without `adapters`, `send` is
// iMessage's, exactly as before. A row whose channel has no adapter (that provider is not wired) stays queued. On a
// channel with a window (WhatsApp), a row outside it is held: never sent, never lost. The person gets one short template
// saying updates are waiting (when one is configured), and their next message puts the held rows back in the queue.
export async function deliverDue(o: {
  store: ChannelStore; send?: Send; adapters?: Partial<Record<Channel, DeliveryAdapter>>; now: number; limit?: number;
  dailyContactCap?: number; clock?: () => number; budgetMs?: number;
}) {
  const r = { delivered: 0, failed: 0, retried: 0, skipped_opt_out: 0, capped: 0, deferred: 0, held: 0, nudged: 0, not_wired: 0 };
  const day = utcDay(o.now);
  const legacy: DeliveryAdapter | undefined = o.send ? { channel: "imessage", limits: { dailyContacts: o.dailyContactCap ?? null }, render: toBubbles, send: o.send } : undefined;
  const adapterFor = (ch: Channel) => (o.adapters ? o.adapters[ch] : ch === "imessage" ? legacy : undefined);
  // A plan's cap counts people per provider (LoopMessage counts every contact it texts in a day).
  const contacts = new Map<Channel, number>();
  const counted = async (ch: Channel) => {
    if (!contacts.has(ch)) contacts.set(ch, o.adapters ? await o.store.contactsSentOn(day, ch) : await o.store.contactsSentOn(day));
    return contacts.get(ch)!;
  };
  const toNudge = new Map<string, { row: OutboxRow; adapter: DeliveryAdapter }>();
  const hold = async (m: OutboxRow, adapter: DeliveryAdapter, error: string, optedOut = false) => {
    await o.store.mark(m.id, { status: "held", at: o.now, error: error.slice(0, 500) });
    r.held++;
    if (optedOut) return;
    // One nudge per silence: none when a template already went after the person's last message.
    const since = m.nudgedAt ?? null;
    if (since !== null && (m.lastInboundAt == null || since >= m.lastInboundAt)) return;
    if (adapter.sendTemplate && !toNudge.has(m.contact)) toNudge.set(m.contact, { row: m, adapter });
  };
  // Answers keep their order: once one of a person's replies (or one part of a reply in parts) did not go out in this run,
  // their later replies wait for the next run instead of overtaking it.
  const stalled = new Set<string>();
  const quiet = new Map<string, boolean | null>(); // per person, once per run; null: it could not be read
  const isQuiet = async (userId: string) => {
    if (!o.store.quiet) return false;
    if (!quiet.has(userId)) quiet.set(userId, await o.store.quiet(userId).catch((e) => { console.error("deliver: the pause could not be read:", e instanceof Error ? e.message : String(e)); return null; }));
    return quiet.get(userId)!;
  };
  for (const m of await o.store.due(o.now, o.limit ?? 100)) {
    if (o.clock && o.budgetMs !== undefined && o.clock() - o.now >= o.budgetMs) { r.deferred++; continue; }
    if (isReply(m.key) && stalled.has(m.userId)) { r.deferred++; continue; }
    const channel = channelOf(m.contact), adapter = adapterFor(channel);
    if (!adapter) { r.not_wired++; continue; } // claimed but untouched: the run's release puts it back, queued
    // STOP holds what Trainee starts (alerts, reports, cards, receipts); the answer to a message the person sent after STOP
    // still goes out, as the STOP reply promises.
    const out = await o.store.optedOut(m.contact);
    if (!isReply(m.key) && out) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now }); r.skipped_opt_out++; continue; }
    // CHANNEL DELIVERY SCENARIOS (2026-10-29): an answer to a message sent BEFORE the STOP is not one sent after it. The
    // rest of a long answer still queued (its later parts, a retry) went out after the person said STOP; now it is held
    // like everything else. The answer row's deliver_at is the time of the message it answers.
    if (isReply(m.key) && out && o.store.optedOutAt) {
      const since = await o.store.optedOutAt(m.contact);
      if (since !== null && m.deliver_at < since) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STOPPED_REPLY_NOTE }); r.skipped_opt_out++; continue; }
    }
    // WO-091c: the same for a pause or an erase that came after the row was queued, checked now, at delivery. A pause that
    // cannot be read leaves the row claimed and untouched (the run's release puts it back), never sent on a guess.
    if (!isReply(m.key)) {
      const q = await isQuiet(m.userId);
      if (q === null) { r.deferred++; continue; }
      if (q) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: PAUSED_NOTE }); r.skipped_opt_out++; continue; }
    }
    // A job alert or report queued before the person paused or stopped their alerts by text (their watch, not the
    // account) is checked again now. Not wanted: not sent. A check that cannot be read leaves the row for the next run.
    if (/^(alert|report):/.test(m.key) && o.now - m.deliver_at > ALERT_STALE_MS && (adapter.limits.windowMs ?? null) === null) {
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STALE_NOTE }); r.skipped_opt_out++; continue;
    }
    if (/^(alert|report):/.test(m.key) && o.store.alertWanted) {
      let wanted: boolean | null;
      try { wanted = await o.store.alertWanted(m); } catch (e) { console.error("deliver: the job alerts could not be read:", e instanceof Error ? e.message : String(e)); wanted = null; }
      if (wanted === null) { r.deferred++; continue; }
      if (!wanted) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: ALERTS_OFF_NOTE }); r.skipped_opt_out++; continue; }
    }
    const window = adapter.limits.windowMs ?? null;
    const stall = () => { if (isReply(m.key)) stalled.add(m.userId); };
    // An opted-out person's held answer waits for their next message; Trainee never starts a template to them.
    if (window !== null && (m.lastInboundAt == null || o.now - m.lastInboundAt >= window)) { stall(); await hold(m, adapter, HELD_NOTE, out); continue; }
    const cap = adapter.limits.dailyContacts ?? Infinity;
    const known = await o.store.sentTo(m.contact, day);
    if (!known && cap !== Infinity && await counted(channel) >= cap) { stall(); r.capped++; continue; } // stays queued for tomorrow's allowance
    let res: SendResult;
    try { res = await adapter.send(addressOf(m.contact), adapter.render(m.text), m.buttons?.length ? { buttons: m.buttons } : undefined); }
    catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }; }
    if (res.ok) {
      await o.store.mark(m.id, { status: "delivered", at: o.now, providerId: res.id ?? undefined, ...(res.ids && res.ids.length > 1 ? { providerIds: res.ids } : {}) });
      r.delivered++;
      if (!known && contacts.has(channel)) contacts.set(channel, contacts.get(channel)! + 1);
      continue;
    }
    // WhatsApp refused it for the window or the per-user limit: nothing went out, so it waits whole for the next message.
    stall();
    if (res.hold) { await hold(m, adapter, res.error, out); continue; }
    if (res.optOut) {
      // The person blocked Trainee on this channel (Telegram's 403): that is their STOP; recorded, not retried.
      await o.store.setOptOut(m.contact, true, o.now);
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: res.error });
      r.skipped_opt_out++;
      continue;
    }
    const attempt = m.attempts + 1;
    if (res.retryable && attempt < MAX_ATTEMPTS) { await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error, retryAt: o.now + BACKOFF_MS[attempt - 1] }); r.retried++; }
    else { await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error }); r.failed++; }
  }
  // After every row of the run is held, so the count is whole ("Trainee has 3 new update(s) for you").
  let templates: number | null = null;
  for (const [contact, { row, adapter }] of toNudge) {
    const cap = adapter.limits.dailyTemplates ?? null;
    if (cap !== null) {
      templates ??= o.store.nudgesOn ? await o.store.nudgesOn(day) : 0;
      if (templates >= cap) continue; // the held rows wait for the person's next message either way
    }
    const n = o.store.heldFor ? await o.store.heldFor(row.userId) : 1;
    let res: SendResult | null;
    try { res = await adapter.sendTemplate!(addressOf(contact), Math.max(1, n)); }
    catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }; }
    if (res === null) continue; // no template configured: the messages wait and nothing is said
    if (res.ok) { await o.store.setNudged?.(contact, o.now); r.nudged++; if (templates !== null) templates++; }
    else console.error("deliver: the waiting-updates template failed:", res.error);
  }
  return r;
}

// ------------------------------------------------------------------------------------------------ memory
type MemRow = OutboxRow & { status: "queued" | "delivered" | "failed" | "skipped_opt_out" | "held"; retryAt: number | null; sentAt: number | null; error: string | null };
export function memoryChannel(rows: OutboxRow[] = []): ChannelStore & { rows(): MemRow[]; queue(row: OutboxRow): void; optOuts(): string[]; unhold(userId: string): number } {
  const st: MemRow[] = rows.map((x) => ({ ...x, status: "queued", retryAt: null, sentAt: null, error: null }));
  const optOut = new Map<string, boolean>(), optOutAt = new Map<string, number>(), nudged = new Map<string, number>();
  return {
    async due(now, limit) {
      return st.filter((x) => (x.status === "queued" || (x.status === "failed" && x.retryAt !== null && x.retryAt <= now)) && x.deliver_at <= now)
        .sort((a, b) => a.deliver_at - b.deliver_at).slice(0, limit).map((x) => ({ id: x.id, userId: x.userId, contact: x.contact, key: x.key, text: x.text, deliver_at: x.deliver_at, attempts: x.attempts,
          ...(x.lastInboundAt !== undefined || nudged.has(x.contact) ? { lastInboundAt: x.lastInboundAt ?? null, nudgedAt: nudged.get(x.contact) ?? null } : {}) }));
    },
    async optedOut(c) { return optOut.get(c) === true; },
    async optedOutAt(c) { return optOut.get(c) === true ? optOutAt.get(c) ?? null : null; },
    async setOptOut(c, out, at) { optOut.set(c, out); if (out) optOutAt.set(c, at); else optOutAt.delete(c); },
    async contactsSentOn(day, channel) { return new Set(st.filter((x) => x.status === "delivered" && x.sentAt !== null && utcDay(x.sentAt) === day && (!channel || channelOf(x.contact) === channel)).map((x) => x.contact)).size; },
    async sentTo(c, day) { return st.some((x) => x.contact === c && x.status === "delivered" && x.sentAt !== null && utcDay(x.sentAt) === day); },
    async mark(id, m) {
      const x = st.find((y) => y.id === id); if (!x) return;
      x.status = m.status; x.error = m.error ?? null;
      if (m.status === "delivered") x.sentAt = m.at;
      if (m.status === "failed") { x.attempts++; x.retryAt = m.retryAt ?? null; }
    },
    async heldFor(userId) { return st.filter((x) => x.userId === userId && x.status === "held").length; },
    async nudgesOn(day) { return [...nudged.values()].filter((t) => utcDay(t) === day).length; },
    async setNudged(c, at) { nudged.set(c, at); },
    rows() { return st.map((x) => ({ ...x })); },
    queue(row) { st.push({ ...row, status: "queued", retryAt: null, sentAt: null, error: null }); },
    optOuts() { return [...optOut].filter(([, v]) => v).map(([k]) => k); },
    unhold(userId) { let n = 0; for (const x of st) if (x.userId === userId && x.status === "held") { x.status = "queued"; n++; } return n; },
  };
}
