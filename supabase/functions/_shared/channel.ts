// The texting channel's rules (WO-013a), before any provider: STOP means Trainee sends nothing on its own to that contact
// until START (an answer to a message the person sends is still delivered); every queued message goes out at most once, is retried on a provider's temporary failure, and is never dropped
// silently; a provider's daily contact cap holds (LoopMessage plans: 300 or 1,000 contacts a day). The provider is a
// `Send` function (LoopMessage in WO-013b); the store is memory here and Supabase in 013b.
// WO-038: or one adapter per channel (channel_adapters.ts): iMessage, WhatsApp, Telegram.
import { toBubbles } from "./conversation.ts";
import { closingExpired } from "./career_closing.ts";
import { addressOf, type Channel, channelOf, type DeliveryAdapter, type SendResult } from "./channel_adapters.ts";
import { DEFAULT_PREFS, nextAwake, quietAt, zoneOr } from "./career_alerts.ts";

export type ChannelCommand = "stop" | "start" | "help";
const COMMANDS: Record<string, ChannelCommand> = {
  stop: "stop", stopall: "stop", unsubscribe: "stop",
  // CHANNEL DELIVERY ROUND 2 (2026-10-30): "opt out" said whole is a STOP on every channel (the FCC's 2025 revocation rule
  // names it; it was read as a message for the brain).
  optout: "stop", "opt out": "stop", "opt-out": "stop",
  start: "start", unstop: "start", help: "help", info: "help",
};
// CANCEL, END and QUIT are opt-out words only on SMS: they are in the carrier keyword list (CTIA's opt-out keywords for
// SMS programs) that WO-013 wrote for a texting number. iMessage (LoopMessage), WhatsApp and Telegram are not SMS, and on
// them these are ordinary words a person says to an agent that asks yes/no and cancel questions ("Say cancel and I will
// stop them", "end mock"), so they go to the brain (WO-091c). STOP, STOPALL and UNSUBSCRIBE stay commands everywhere.
// CHANNEL DELIVERY ROUND 2 (2026-10-30): on SMS also REVOKE (the FCC's 2025 revocation rule: "stop, quit, end, revoke, opt
// out, cancel, unsubscribe"), the French ARRET / ARRÊT and AIDE (Canadian carriers' bilingual keywords), and the Spanish
// PARAR, BAJA, CANCELAR and AYUDA (US carriers' Spanish keywords). A text over LoopMessage that came as SMS (iMessage not
// available) is SMS: it was always read as iMessage, so CANCEL from an SMS phone went to the brain and nothing stopped.
const SMS_ONLY: Record<string, ChannelCommand> = { cancel: "stop", end: "stop", quit: "stop", revoke: "stop", arret: "stop", parar: "stop", baja: "stop", cancelar: "stop", aide: "help", ayuda: "help" };
// The whole message is the command (any case, end punctuation ignored); "stop sending me sales jobs" is a message.
// `channel`: where the text came in. No channel named (the WO-013a simulator, a bare number) keeps the full SMS list.
// CHANNEL DELIVERY SCENARIOS (2026-10-29): what a phone puts around a typed word is not the word: "STOP…" (iOS turns
// "..." into one "…"), "Stop," and "STOP;" and quotes around it ("“STOP”"), and the invisible characters a copy and paste
// carries (zero-width space, word joiner, byte-order mark). Each was read as a message for the brain, so a STOP was a
// model call and nothing was stopped.
export function channelCommand(text: string, channel?: Channel | "sms"): ChannelCommand | null {
  const t = String(text ?? "").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim().toLowerCase()
    .replace(/^[\s"'“”‘’«»(\[¡¿]+/, "").replace(/[.!?,;:…~"'“”‘’«»)\]\s]+$/g, "").replace(/\s+/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): when this row was first held by WhatsApp's window; null: never held;
  // absent: the store cannot say.
  heldAt?: number | null;
  // CHANNEL DELIVERY ROUND 2 (2026-10-30): how many of this row's messages (its rendered bubbles) already went out in an
  // earlier attempt, and their provider ids; the row resumes after them. Absent or 0: none went.
  sentParts?: number; sentIds?: string[];
}
// "queued" with deliverAt: put back for a later time (the person's quiet hours on their clock as it is now).
// sentParts (CHANNEL DELIVERY ROUND 2): on a failed or held row, how many of its messages went out so far (providerIds then
// their ids); the next attempt starts after them.
export type DeliveryMark = { status: "delivered" | "failed" | "skipped_opt_out" | "held" | "queued"; at: number; error?: string; providerId?: string; providerIds?: string[]; retryAt?: number; deliverAt?: number; sentParts?: number };
export interface ChannelStore {
  due(now: number, limit: number): Promise<OutboxRow[]>; // undelivered, deliver_at <= now, oldest first
  optedOut(contact: string): Promise<boolean>;
  // CHANNEL DELIVERY SCENARIOS (2026-10-29): when the person (any of their contacts) last said STOP, null when they are not
  // opted out or the time is not known. Absent: an answer is never held by a STOP (the WO-013a behaviour).
  optedOutAt?(contact: string): Promise<number | null>;
  // WO-091c: the person's account is paused, opted out or erased (career_user_quiet). Absent: only STOP holds a row.
  quiet?(userId: string): Promise<boolean>;
  // ERASE SCENARIOS ROUND 2 (2026-10-30): the person's account no longer exists (career_account_gone). Absent: not checked.
  gone?(userId: string): Promise<boolean>;
  // IDENTITY SCENARIOS (2026-10-30): the contact a claimed row is about to go to is still the person's (channel_contacts).
  // Absent: not checked.
  stillTheirs?(userId: string, contact: string): Promise<boolean>;
  // A queued job alert or report (key alert:… or report:…) still wanted now: the person's alert settings, the watch behind
  // them and the posting, read at delivery (career_watch_alerts.ts, alertStillWanted). Absent: not checked (memory stores).
  alertWanted?(row: OutboxRow): Promise<boolean>;
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a queued job alert (alert:…) still within the person's fit floor and daily
  // cap as they are now (career_watch_alerts.ts alertWithinLimits), `now` the run's time. Absent: not checked.
  alertWithinLimits?(row: OutboxRow, now: number): Promise<boolean>;
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): of a daily report's links, the postings closed since (career_postings).
  // Absent: not checked.
  closedLinks?(urls: string[]): Promise<Set<string>>;
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): the person's zone and quiet hours as they are now (their alert settings),
  // null when they have none on file. Absent: not checked (the time a row was planned for stands).
  quietHours?(userId: string): Promise<{ tz: string | null; quiet_start?: number; quiet_end?: number } | null>;
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): one waiting-updates template counted against the day's budget and recorded
  // for the contact in one step (two delivery runs at once each read the count and both sent past it). true: claimed;
  // false: the day's budget is spent; null: the store cannot claim (nudgesOn and setNudged are used). unclaimTemplate
  // gives the slot back when the template was not sent.
  claimTemplate?(contact: string, day: string, cap: number, at: number): Promise<boolean | null>;
  unclaimTemplate?(contact: string, at: number): Promise<void>;
  setOptOut(contact: string, out: boolean, at: number): Promise<void>;
  contactsSentOn(day: string, channel?: Channel): Promise<number>; // distinct contacts sent to on a UTC day (on one channel, if named)
  sentTo(contact: string, day: string): Promise<boolean>;
  mark(id: string, r: DeliveryMark): Promise<void>; // a retry is status "failed" with retryAt set and attempts + 1
  // WO-038, for a windowed channel: how many messages wait for the person, templates sent on a day, a nudge recorded.
  heldFor?(userId: string): Promise<number>;
  nudgesOn?(day: string): Promise<number>;
  setNudged?(contact: string, at: number): Promise<void>;
}
export type Send = (contact: string, bubbles: string[]) => Promise<{ ok: true; id: string | null; ids?: string[] } | { ok: false; error: string; retryable: boolean; sent?: number; sentIds?: string[] }>;

// The answer to a message the person sent (trainee-inbound queues it as reply:<provider message id>).
export const isReply = (key: string) => String(key ?? "").startsWith("reply:");
export const MAX_ATTEMPTS = 3;
// TELEGRAM ROUND 3 (2026-10-31): a refusal that names how long to wait (Telegram's 429 retry_after) is the platform pacing
// Trainee, not a failure of the message. It counted as one of the 3 attempts, so a chat rate-limited three times in a row lost
// that part of the answer for good, and the parts after it then went out without it. Such a row is tried up to this many times,
// each no sooner than the platform asked.
export const MAX_PACED_ATTEMPTS = 12;
const BACKOFF_MS = [60000, 5 * 60000, 30 * 60000]; // after attempt 1, 2, 3
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const HELD_NOTE = "held: outside WhatsApp's 24-hour window; it goes out whole when the person next writes";
export const PAUSED_NOTE = "not sent: the person paused Trainee (or stopped or erased it) after this was queued";
export const ALERTS_OFF_NOTE = "not sent: the person's job alerts no longer ask for this (paused, stopped or changed after it was queued)";
export const GONE_NOTE = "not sent: the person deleted their account after this was queued";
export const STOPPED_REPLY_NOTE = "not sent: the person texted STOP after the message this answers; only a message sent after STOP is answered";
// PROACTIVE SCENARIOS (2026-10-29): a job alert or daily report is news on its day, not later. Rows wait in the outbox while
// the person has no texting channel (the dashboard's matches feed reads them there), and when they connected one, every
// alert and report of the weeks before went out at once, each still saying "first seen 20 min ago". Past this age, an
// alert or report is not sent; the dashboard still lists it. Not on a channel with a service window (WhatsApp): there a
// row held for the window goes out whole when the person next writes, however late (WO-038/W5).
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): on WhatsApp too, for a row that was never held by the window. A web-only person
// who connected WhatsApp days later got the whole backlog the moment they wrote to connect it (the window was open),
// each alert still "first seen 20 min ago". A row the window held still goes out whole when they write (heldAt set).
export const ALERT_STALE_MS = 48 * 3600000;
const CLOSING_PAST_NOTE = "not sent: the role's closing day had come before it could go out";
export const STALE_NOTE = "not sent: a job alert or report more than 48 hours past its time is no longer news";
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): what Trainee starts on a schedule waits out the person's quiet hours on their
// clock as it is at delivery, not only as it was when it was planned: a person who moved zones (or changed their quiet
// hours) after a row was queued got it in the middle of their night.
const QUIET_AWARE = /^(alert|report|receipt|status|followup|brief|digest):/;
// The zone on a chat reminder's key, status:reminder:<id>:<zone> (career_reminders.ts reminderKey); null for any other row.
const reminderZoneOf = (key: string) => { const z = /^status:reminder:[^:]+:([A-Za-z0-9_+\-\/]+)$/.exec(key)?.[1]; return z ? zoneOr(z, "") || null : null; };
export const LIMITS_NOTE = "not sent: under the fit floor the person set, or past the alerts a day they asked for, since it was queued";
export const CLOSED_SINCE =" (this posting has closed since this report was written)";
// CHANNEL DELIVERY ROUND 2 (2026-10-30): a row bound to a channel the person no longer has, and no other channel to send it on.
export const NO_CHANNEL_NOTE = "not sent: the channel this answers was unlinked and the person has no other texting channel";

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
  const hold = async (m: OutboxRow, adapter: DeliveryAdapter, error: string, optedOut = false, sent?: { parts: number; ids: string[] }) => {
    await o.store.mark(m.id, { status: "held", at: o.now, error: error.slice(0, 500), ...(sent && sent.parts ? { sentParts: sent.parts, providerIds: sent.ids } : {}) });
    r.held++;
    if (optedOut) return;
    // One nudge per silence: none when a template already went after the person's last message.
    const since = m.nudgedAt ?? null;
    if (since !== null && (m.lastInboundAt == null || since >= m.lastInboundAt)) return;
    if (adapter.sendTemplate && !toNudge.has(m.contact)) toNudge.set(m.contact, { row: m, adapter });
  };
  // Answers keep their order: once one of a person's replies (or one part of a reply in parts) did not go out in this run,
  // their later replies wait for the next run instead of overtaking it. CHANNEL DELIVERY ROUND 2 (2026-10-30): on that
  // channel only. A person on two channels had their Telegram answer wait behind an iMessage answer held by LoopMessage's
  // daily cap (run after run, until the next day) or behind a WhatsApp answer held by the window; order matters within a
  // conversation, and each channel is its own.
  const stalled = new Set<string>();
  const lane = (m: OutboxRow) => `${m.userId}|${channelOf(m.contact)}`;
  // The person's zone and quiet hours now, once per run; undefined: they could not be read.
  const hoursOf = new Map<string, { tz: string | null; quiet_start?: number; quiet_end?: number } | null | undefined>();
  const quietHoursOf = async (userId: string) => {
    if (!hoursOf.has(userId)) hoursOf.set(userId, await o.store.quietHours!(userId).catch((e) => { console.error("deliver: the quiet hours could not be read:", e instanceof Error ? e.message : String(e)); return undefined; }));
    return hoursOf.get(userId);
  };
  const quiet = new Map<string, boolean | null>(); // per person, once per run; null: it could not be read
  const isQuiet = async (userId: string) => {
    if (!o.store.quiet) return false;
    if (!quiet.has(userId)) quiet.set(userId, await o.store.quiet(userId).catch((e) => { console.error("deliver: the pause could not be read:", e instanceof Error ? e.message : String(e)); return null; }));
    return quiet.get(userId)!;
  };
  for (const m of await o.store.due(o.now, o.limit ?? 100)) {
    if (o.clock && o.budgetMs !== undefined && o.clock() - o.now >= o.budgetMs) { r.deferred++; continue; }
    if (isReply(m.key) && stalled.has(lane(m))) { r.deferred++; continue; }
    const channel = channelOf(m.contact), adapter = adapterFor(channel);
    if (!adapter) { r.not_wired++; continue; } // claimed but untouched: the run's release puts it back, queued
    // IDENTITY SCENARIOS (2026-10-30): a run claims up to a hundred rows at once, each with the contact it targeted then. A
    // Telegram chat unlinked, a WhatsApp number shown to be someone else's, or a chat moved by a link while the run was
    // sending got the rest of the claimed rows anyway (the rest of a long answer went to the chat just unlinked). Each row is
    // checked against the contact's owner now; one that is no longer theirs goes back in the queue (sent home on the next run,
    // or failed with the reason when no channel is left). A check that cannot be read leaves the row for the next run.
    if (o.store.stillTheirs) {
      let mine: boolean | null;
      try { mine = await o.store.stillTheirs(m.userId, m.contact); } catch (e) { console.error("deliver: the contact's owner could not be read:", e instanceof Error ? e.message : String(e)); mine = null; }
      if (mine === null) { r.deferred++; continue; }
      if (!mine) { await o.store.mark(m.id, { status: "queued", at: o.now }); r.deferred++; continue; }
    }
    // STOP holds what Trainee starts (alerts, reports, cards, receipts); the answer to a message the person sent after STOP
    // still goes out, as the STOP reply promises.
    const out = await o.store.optedOut(m.contact);
    if (!isReply(m.key) && out) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now }); r.skipped_opt_out++; continue; }
    // CHANNEL DELIVERY SCENARIOS (2026-10-29): an answer to a message sent BEFORE the STOP is not one sent after it. The
    // rest of a long answer still queued (its later parts, a retry) went out after the person said STOP; now it is held
    // like everything else. The answer row's deliver_at is the time of the message it answers.
    if (isReply(m.key) && out && o.store.optedOutAt) {
      const since = await o.store.optedOutAt(m.contact);
      // TELEGRAM ROUND 3 (2026-10-31): or AT it: a 403 (the person blocked the bot) on part k of an answer, in the run that
      // answered their message, is recorded at that message's time, and every later part of the same answer still went to the
      // chat that had just blocked Trainee, one refused call each.
      if (since !== null && m.deliver_at <= since) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STOPPED_REPLY_NOTE }); r.skipped_opt_out++; continue; }
    }
    // ERASE SCENARIOS ROUND 2 (2026-10-30): an answer a run had claimed went out after the person's account was deleted
    // (a pause does not hold an answer, and the account's pause was gone with it). A deleted account gets nothing; a check
    // that cannot be read leaves the row claimed and untouched, never sent on a guess.
    if (isReply(m.key) && o.store.gone) {
      let g: boolean | null;
      try { g = await o.store.gone(m.userId); } catch (e) { console.error("deliver: the account could not be read:", e instanceof Error ? e.message : String(e)); g = null; }
      if (g === null) { r.deferred++; continue; }
      if (g) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: GONE_NOTE }); r.skipped_opt_out++; continue; }
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
    if (/^(alert|report):/.test(m.key) && o.now - m.deliver_at > ALERT_STALE_MS && ((adapter.limits.windowMs ?? null) === null || m.heldAt === null)) {
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STALE_NOTE }); r.skipped_opt_out++; continue;
    }
    // Reqs doc 2 (career_closing.ts): a closing-date text held past its day is not sent after the role closed.
    if (closingExpired(m.key, o.now)) {
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: CLOSING_PAST_NOTE }); r.skipped_opt_out++; continue;
    }
    if (/^(alert|report):/.test(m.key) && o.store.alertWanted) {
      let wanted: boolean | null;
      try { wanted = await o.store.alertWanted(m); } catch (e) { console.error("deliver: the job alerts could not be read:", e instanceof Error ? e.message : String(e)); wanted = null; }
      if (wanted === null) { r.deferred++; continue; }
      if (!wanted) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: ALERTS_OFF_NOTE }); r.skipped_opt_out++; continue; }
    }
    if (m.key.startsWith("alert:") && o.store.alertWithinLimits) {
      let within: boolean | null;
      try { within = await o.store.alertWithinLimits(m, o.now); } catch (e) { console.error("deliver: the alert limits could not be read:", e instanceof Error ? e.message : String(e)); within = null; }
      if (within === null) { r.deferred++; continue; }
      if (!within) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: LIMITS_NOTE }); r.skipped_opt_out++; continue; }
    }
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): quiet hours on the person's clock as it is now. Inside them, the row goes
    // back in the queue for the first quarter hour after them (after the checks above: a stale or unwanted row is not
    // kept for the morning); a read that fails leaves it for the next run.
    if (QUIET_AWARE.test(m.key) && o.store.quietHours) {
      const q = await quietHoursOf(m.userId);
      if (q === undefined) { r.deferred++; continue; }
      // REVIEW (PR #355): a reminder set in chat carries the zone the person named on its key (career_reminders.ts
      // reminderKey); its quiet hours are on that clock, with the default hours when none are saved, as its reply said.
      // Held on the saved zone (or Eastern), "9am London time" from a Chicago account waited until 7 AM Chicago.
      const own = reminderZoneOf(m.key);
      if (q || own) {
        const tz = own ?? zoneOr(q!.tz), hours = { quiet_start: q?.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: q?.quiet_end ?? DEFAULT_PREFS.quiet_end };
        if (quietAt(o.now, tz, hours)) { await o.store.mark(m.id, { status: "queued", at: o.now, deliverAt: Math.max(o.now + 60000, nextAwake(o.now, tz, hours)) }); r.deferred++; continue; }
      }
    }
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a daily report waits in the outbox (quiet hours, a channel behind) while
    // postings on it close. Each one closed since it was written is said to be closed, on its own line; a read that fails
    // leaves the report for the next run.
    let text = m.text;
    if (m.key.startsWith("report:") && o.store.closedLinks) {
      const urls = [...m.text.matchAll(/^ {2}(https:\/\/\S+)$/gm)].map((x) => x[1]);
      if (urls.length) {
        let closed: Set<string> | null;
        try { closed = await o.store.closedLinks(urls); } catch (e) { console.error("deliver: the report's postings could not be read:", e instanceof Error ? e.message : String(e)); closed = null; }
        if (closed === null) { r.deferred++; continue; }
        if (closed.size) {
          const lines = m.text.split("\n");
          for (let i = 1; i < lines.length; i++) if (closed.has(lines[i].trim()) && lines[i - 1].startsWith("- ") && !lines[i - 1].endsWith(CLOSED_SINCE)) lines[i - 1] += CLOSED_SINCE;
          text = lines.join("\n");
        }
      }
    }
    const window = adapter.limits.windowMs ?? null;
    const stall = () => { if (isReply(m.key)) stalled.add(lane(m)); };
    // An opted-out person's held answer waits for their next message; Trainee never starts a template to them.
    if (window !== null && (m.lastInboundAt == null || o.now - m.lastInboundAt >= window)) { stall(); await hold(m, adapter, HELD_NOTE, out); continue; }
    const cap = adapter.limits.dailyContacts ?? Infinity;
    const known = await o.store.sentTo(m.contact, day);
    if (!known && cap !== Infinity && await counted(channel) >= cap) { stall(); r.capped++; continue; } // stays queued for tomorrow's allowance
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): a row some of whose messages already went out (an earlier attempt stopped by a
    // 429 or the window part way) sends only the rest; every id it went out as is kept, in order, so a provider's later
    // "failed" for one of them maps back to the right place.
    const all = adapter.render(text), skip = Math.min(Math.max(0, m.sentParts ?? 0), all.length), before = m.sentIds ?? [];
    const bubbles = all.slice(skip);
    let res: SendResult;
    if (skip > 0 && !bubbles.length) res = { ok: true, id: before[0] ?? null, ids: [] };
    else {
      try { res = await adapter.send(addressOf(m.contact), bubbles, m.buttons?.length ? { buttons: m.buttons } : undefined); }
      catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }; }
    }
    if (res.ok) {
      const ids = [...before, ...(res.ids ?? (res.id ? [res.id] : []))];
      await o.store.mark(m.id, { status: "delivered", at: o.now, providerId: ids[0] ?? res.id ?? undefined, ...(ids.length ? { providerIds: ids } : {}) });
      r.delivered++;
      if (!known && contacts.has(channel)) contacts.set(channel, contacts.get(channel)! + 1);
      continue;
    }
    const went = res.sent && res.sent > 0 ? { parts: skip + res.sent, ids: [...before, ...(res.sentIds ?? [])] } : skip > 0 ? { parts: skip, ids: before } : undefined;
    const progress = went ? { sentParts: went.parts, providerIds: went.ids } : {};
    // WhatsApp refused it for the window or the per-user limit: nothing of that message went out, so it waits for the next
    // message (from the first message that did not go).
    stall();
    if (res.hold) { await hold(m, adapter, res.error, out, went); continue; }
    if (res.optOut) {
      // The person blocked Trainee on this channel (Telegram's 403): that is their STOP; recorded, not retried.
      await o.store.setOptOut(m.contact, true, o.now);
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: res.error, ...progress });
      r.skipped_opt_out++;
      continue;
    }
    const attempt = m.attempts + 1;
    // TELEGRAM SCENARIOS (2026-10-30): never sooner than the provider asked (Telegram's 429 retry_after). CHANNEL DELIVERY
    // ROUND 2: counted from when the 429 came (the run's clock), not the run's start: a 429 on a row's 2nd message, a paced
    // second later, was retried that much early.
    const paced = res.retryAfterMs !== undefined;
    if (res.retryable && (attempt < MAX_ATTEMPTS || (paced && attempt < MAX_PACED_ATTEMPTS))) {
      const backoff = paced ? BACKOFF_MS[0] : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
      await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error, retryAt: Math.max(o.now + backoff, (o.clock ? Math.max(o.now, o.clock()) : o.now) + (res.retryAfterMs ?? 0)), ...progress }); r.retried++;
    }
    else { await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error, ...progress }); r.failed++; }
  }
  // After every row of the run is held, so the count is whole ("Trainee has 3 new update(s) for you").
  let templates: number | null = null;
  for (const [contact, { row, adapter }] of toNudge) {
    const cap = adapter.limits.dailyTemplates ?? null;
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): the day's budget is claimed in the store, one template at a time, before
    // it is sent. Each run read the count once and counted on from there, so two delivery runs at once (a run that ran
    // long, the head start of an inbound message) each sent up to the whole budget. A store that cannot claim keeps the
    // old count.
    let claimed = false;
    if (cap !== null) {
      const got = o.store.claimTemplate ? await o.store.claimTemplate(contact, day, cap, o.now).catch((e) => { console.error("deliver: the template budget could not be claimed:", e instanceof Error ? e.message : String(e)); return false; }) : null;
      if (got === false) continue; // the budget is spent (or unreadable): the held rows wait for the person's next message
      if (got === true) claimed = true;
      else {
        templates ??= o.store.nudgesOn ? await o.store.nudgesOn(day) : 0;
        if (templates >= cap) continue; // the held rows wait for the person's next message either way
      }
    }
    const n = o.store.heldFor ? await o.store.heldFor(row.userId) : 1;
    let res: SendResult | null;
    try { res = await adapter.sendTemplate!(addressOf(contact), Math.max(1, n)); }
    catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }; }
    if (res === null || !res.ok) {
      if (claimed) await o.store.unclaimTemplate?.(contact, o.now).catch(() => {});
      if (res) console.error("deliver: the waiting-updates template failed:", res.error);
      continue; // no template configured (null): the messages wait and nothing is said
    }
    if (!claimed) await o.store.setNudged?.(contact, o.now);
    r.nudged++;
    if (templates !== null) templates++;
  }
  return r;
}

// ------------------------------------------------------------------------------------------------ memory
type MemRow = Omit<OutboxRow, "heldAt"> & { status: "queued" | "delivered" | "failed" | "skipped_opt_out" | "held"; retryAt: number | null; sentAt: number | null; error: string | null; heldAt?: number | null; providerIds?: string[] | null };
export function memoryChannel(rows: OutboxRow[] = []): ChannelStore & { rows(): MemRow[]; queue(row: OutboxRow): void; optOuts(): string[]; unhold(userId: string): number } {
  const st: MemRow[] = rows.map((x) => ({ ...x, status: "queued", retryAt: null, sentAt: null, error: null }));
  const optOut = new Map<string, boolean>(), optOutAt = new Map<string, number>(), nudged = new Map<string, number>();
  return {
    async due(now, limit) {
      return st.filter((x) => (x.status === "queued" || (x.status === "failed" && x.retryAt !== null && x.retryAt <= now)) && x.deliver_at <= now)
        .sort((a, b) => a.deliver_at - b.deliver_at).slice(0, limit).map((x) => ({ id: x.id, userId: x.userId, contact: x.contact, key: x.key, text: x.text, deliver_at: x.deliver_at, attempts: x.attempts,
          ...(x.lastInboundAt !== undefined || nudged.has(x.contact) ? { lastInboundAt: x.lastInboundAt ?? null, nudgedAt: nudged.get(x.contact) ?? null } : {}),
          ...(x.heldAt !== undefined ? { heldAt: x.heldAt } : {}), ...(x.sentParts ? { sentParts: x.sentParts, sentIds: [...(x.providerIds ?? [])] } : {}) }));
    },
    async optedOut(c) { return optOut.get(c) === true; },
    async optedOutAt(c) { return optOut.get(c) === true ? optOutAt.get(c) ?? null : null; },
    async setOptOut(c, out, at) { optOut.set(c, out); if (out) optOutAt.set(c, at); else optOutAt.delete(c); },
    async contactsSentOn(day, channel) { return new Set(st.filter((x) => x.status === "delivered" && x.sentAt !== null && utcDay(x.sentAt) === day && (!channel || channelOf(x.contact) === channel)).map((x) => x.contact)).size; },
    async sentTo(c, day) { return st.some((x) => x.contact === c && x.status === "delivered" && x.sentAt !== null && utcDay(x.sentAt) === day); },
    async mark(id, m) {
      const x = st.find((y) => y.id === id); if (!x) return;
      x.status = m.status; x.error = m.error ?? null;
      if (m.sentParts !== undefined) { x.sentParts = m.sentParts; x.providerIds = m.providerIds ?? x.providerIds ?? null; }
      if (m.status === "delivered") { x.sentAt = m.at; x.providerIds = m.providerIds ?? (m.providerId ? [m.providerId] : null); }
      if (m.status === "held") x.heldAt ??= m.at;
      if (m.status === "queued" && m.deliverAt !== undefined) x.deliver_at = m.deliverAt;
      if (m.status === "failed") { x.attempts++; x.retryAt = m.retryAt ?? null; }
    },
    async heldFor(userId) { return st.filter((x) => x.userId === userId && x.status === "held").length; },
    async nudgesOn(day) { return [...nudged.values()].filter((t) => utcDay(t) === day).length; },
    async setNudged(c, at) { nudged.set(c, at); },
    async claimTemplate(c, day, cap, at) {
      if ([...nudged.values()].filter((t) => utcDay(t) === day).length >= cap) return false;
      nudged.set(c, at);
      return true;
    },
    async unclaimTemplate(c, at) { if (nudged.get(c) === at) nudged.delete(c); },
    rows() { return st.map((x) => ({ ...x })); },
    queue(row) { st.push({ ...row, status: "queued", retryAt: null, sentAt: null, error: null }); },
    optOuts() { return [...optOut].filter(([, v]) => v).map(([k]) => k); },
    unhold(userId) { let n = 0; for (const x of st) if (x.userId === userId && x.status === "held") { x.status = "queued"; n++; } return n; },
  };
}
