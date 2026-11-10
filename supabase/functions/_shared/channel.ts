// The texting channel's rules (WO-013a), before any provider: STOP means Trainee sends nothing on its own to that contact
// until START (an answer to a message the person sends is still delivered); every queued message goes out at most once, is retried on a provider's temporary failure, and is never dropped
// silently; a provider's daily contact cap holds (LoopMessage plans: 300 or 1,000 contacts a day). The provider is a
// `Send` function (LoopMessage in WO-013b); the store is memory here and Supabase in 013b.
// WO-038: or one adapter per channel (channel_adapters.ts): iMessage, WhatsApp, Telegram.
import { toBubbles } from "./conversation.ts";
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
  stop: "Messages stop now: Trainee won't message you on its own again, alerts and reports included; it only answers if you text it. Text START to turn messages back on.",
  start: "Started again: you're back on. Text STOP any time and every message stops.",
  help: "Here's how Trainee works: it's a job-search agent you text for real postings, alerts, applications you approve and interview practice. Text STOP to stop all messages.",
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
  // CHANNEL R4 FLAKE (2026-11-05): the reason the row's last attempt recorded (a row tried before); absent: the store cannot say.
  lastError?: string | null;
}
// "queued" with deliverAt: put back for a later time (the person's quiet hours on their clock as it is now).
// sentParts (CHANNEL DELIVERY ROUND 2): on a failed or held row, how many of its messages went out so far (providerIds then
// their ids); the next attempt starts after them.
// text (PROACTIVE SCENARIOS ROUND 3): on a delivered row, the words that went when delivery wrote them anew (an alert's
// posting as it was then, a report's lines that still fit, a closed posting said); the row keeps what was sent.
export type DeliveryMark = { status: "delivered" | "failed" | "skipped_opt_out" | "held" | "queued"; at: number; error?: string; providerId?: string; providerIds?: string[]; retryAt?: number; deliverAt?: number; sentParts?: number; text?: string };
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
  // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): a queued job alert's or daily report's words as they are true now
  // (career_watch_alerts.ts freshAlertText: the posting as it is now, its age now; a report's lines that still fit the
  // person's search). null: nothing of it is still true for the person (not sent, FRESH_NOTE). Absent: the words as queued.
  freshText?(row: OutboxRow, now: number): Promise<string | null>;
  // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): a queued interview brief (brief:<invite>:<n>) whose interview a later email
  // cancelled or moved: false (not sent, BRIEF_GONE_NOTE). Absent: not checked.
  briefWanted?(row: OutboxRow): Promise<boolean>;
  // CONNECTORS ROUND 4 (2026-11-05): is a text made from the person's mail (mailboxText) still queued? "disconnect gmail" (or
  // connecting another Google account) deletes every such undelivered row (20261105130000); a run that had claimed one before
  // that sent it after. false: the row is gone (not sent). Absent: not checked.
  stillQueued?(row: OutboxRow): Promise<boolean>;
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
  // CHANNEL DELIVERY ROUND 4 (2026-11-05): put back, exactly as they were, claimed rows this run never handed to a provider
  // (a run that failed part way: see deliverDue). Absent: they wait for the sweep, as before.
  putBack?(ids: string[]): Promise<number>;
  contactsSentOn(day: string, channel?: Channel): Promise<number>; // distinct contacts sent to on a UTC day (on one channel, if named)
  sentTo(contact: string, day: string): Promise<boolean>;
  mark(id: string, r: DeliveryMark): Promise<void>; // a retry is status "failed" with retryAt set and attempts + 1
  // WO-038, for a windowed channel: how many messages wait for the person, templates sent on a day, a nudge recorded.
  heldFor?(userId: string): Promise<number>;
  nudgesOn?(day: string): Promise<number>;
  setNudged?(contact: string, at: number): Promise<void>;
}
export type Send = (contact: string, bubbles: string[]) => Promise<{ ok: true; id: string | null; ids?: string[] } | { ok: false; error: string; retryable: boolean; sent?: number; sentIds?: string[]; unauthorized?: boolean }>;

// The answer to a message the person sent (trainee-inbound queues it as reply:<provider message id>).
export const isReply = (key: string) => String(key ?? "").startsWith("reply:");
export const MAX_ATTEMPTS = 3;
// TELEGRAM ROUND 3 (2026-10-31): a refusal that names how long to wait (Telegram's 429 retry_after) is the platform pacing
// Trainee, not a failure of the message. It counted as one of the 3 attempts, so a chat rate-limited three times in a row lost
// that part of the answer for good, and the parts after it then went out without it. Such a row is tried up to this many times,
// each no sooner than the platform asked.
// OUTBOX ATTEMPTS CAP (2026-11-05): career_outbox's check allows attempts between 0 and 10, and this was 12. A row paced ten
// times was refused the write recording its 11th attempt; the row had been handed to the provider, so it stayed "sending"
// and the sweep failed it as "delivery outcome unknown" although a 429 sends nothing, and the run stopped there. No path
// records more than OUTBOX_MAX_ATTEMPTS: a paced row ends failed with its reason on its 10th attempt, a run failure on the
// 10th is the last (deliverDue), and the store never writes more (channel_store.ts mark, for a row an older build left
// waiting at 10).
export const OUTBOX_MAX_ATTEMPTS = 10;
export const MAX_PACED_ATTEMPTS = OUTBOX_MAX_ATTEMPTS;
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
export const STALE_NOTE = "not sent: a job alert or report more than 48 hours past its time is no longer news";
// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): every row not sent says why. A STOP held a row with no reason recorded.
export const STOP_NOTE = "not sent: the person texted STOP; Trainee sends nothing on its own until START";
export const FRESH_NOTE = "not sent: nothing in it is still true for the person (the posting changed or went, or their search changed) since it was queued";
// Whether a queued interview brief (brief:<invite>:1, :2, or :moved for a new time) still says a real interview, from its
// interview's row, the invite's own (null: not on file, so nothing says otherwise): not once a later email cancelled that
// interview or moved it to another time (the ":moved" brief is its own invite's row: a second move or a cancel holds it too).
export function briefStillTrue(_key: string, row: { moved_at?: string | null; cancelled_at?: string | null } | null): boolean {
  return !row || (!row.cancelled_at && !row.moved_at);
}
export const BRIEF_GONE_NOTE = "not sent: a later email cancelled or moved this interview after the brief was queued";
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): what Trainee starts on a schedule waits out the person's quiet hours on their
// clock as it is at delivery, not only as it was when it was planned: a person who moved zones (or changed their quiet
// hours) after a row was queued got it in the middle of their night.
const QUIET_AWARE = /^(alert|report|receipt|status|followup|brief|digest):/;
// The zone on a chat reminder's key, status:reminder:<id>:<zone> (career_reminders.ts reminderKey); null for any other row.
const reminderZoneOf = (key: string) => { const z = /^status:reminder:[^:]+:([A-Za-z0-9_+\-\/]+)$/.exec(key)?.[1]; return z ? zoneOr(z, "") || null : null; };
export const LIMITS_NOTE = "not sent: under the fit floor the person set, or past the alerts a day they asked for, since it was queued";
export const CLOSED_SINCE =" (this posting has closed since this report was written)";
// CHANNEL DELIVERY ROUND 2 (2026-10-30): a row bound to a channel the person no longer has, and no other channel to send it on.
// CONNECTORS ROUND 4 (2026-11-05): the keys of texts made from a person's mail by the scheduled Gmail run, as the database
// knows them (career_mail_text_key, 20261105130000): a status read from an email (status:<message hash>), a deadline reminder
// (status:deadline:<message hash>), an application an email confirmed (status:confirmed:<application>), the "which
// application?" ask (status:which:<message hash>), an interview brief (brief:<message hash>:<n|moved>). Not the daily brief
// (brief:<day>), not a reminder set in chat (status:reminder:...), not a connector's own status.
export const MAIL_TEXT_KEY = /^(status:([0-9a-f]{64}|deadline:[0-9a-f]{64}|confirmed:[^:]+|which:[0-9a-f]{64})|brief:[0-9a-f]{64}:[^:]+)$/;
export const mailTextKey = (key: string) => MAIL_TEXT_KEY.test(String(key ?? ""));
// What "disconnect gmail" deletes from the outbox: those texts, and the offers of the drafts it deletes with the mail
// (followup:followup:<ref>, followup:thank_you:<ref>:<day>, career_mail_drafts), whose "yes" would find nothing.
export const mailboxText = (key: string) => mailTextKey(key) || /^followup:(followup|thank_you):/.test(String(key ?? ""));
// CHANNEL DELIVERY ROUND 4 (2026-11-05): a row whose handling failed before anything of it was sent (a read or a write the
// database refused): one attempt, tried again with the backoff, failed with this reason after MAX_ATTEMPTS.
// CHANNEL R4 FLAKE (2026-11-05): ... only when the row's own handling failed this way in its last attempt too. A row whose
// first two attempts the provider refused (a 502, a 429) and whose third run had one read refused (the STOP read) was failed
// for good on that one refusal: an answer lost to a database blip it had nothing to do with. Now such a row is tried again
// (the run failure still counts an attempt, so the provider's own refusals stay bounded); a row whose handling fails in two
// runs in a row once its attempts are used is still failed with the reason, never retried forever.
export const RUN_FAILED_NOTE = "not sent yet: the delivery run failed before sending it (a database read or write was refused)";
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
  dailyContactCap?: number; clock?: () => number; budgetMs?: number; concurrency?: number;
  // CHANNEL DELIVERY ROUND 4: the channels whose provider refused Trainee's own credentials, shared by the rounds of one run.
  down?: Set<Channel>;
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
  const inflightNew = new Map<Channel, number>();
  // CHANNEL DELIVERY ROUND 4 (2026-11-05): a provider that refuses Trainee's own credentials (Telegram's 401 for a revoked bot
  // token, WhatsApp's 401 / code 190 for an expired access token, LoopMessage's 401) refused the request, not the message:
  // nothing of it went out, and the next message will be refused the same way. Each such refusal was a final failure, so one
  // expired token failed every queued message of that channel, run after run, until the secret was fixed: every answer,
  // alert and card lost. Now the channel is down for the run: the row goes back untouched (as for a channel not wired) and no
  // other row of that channel is tried this run; the rows go out once the credentials work again.
  const down = o.down ?? new Set<Channel>();
  // CHANNEL DELIVERY ROUND 4 (2026-11-05): the rows a provider was asked to send (or may have been). A run that fails part
  // way (a write the database refused, a read that threw) left every row it had claimed "sending", and the sweep later
  // failed each one as "delivery outcome unknown; not resent": the rows it never reached were never sent, yet were lost the
  // same way (one refused write lost up to a whole batch of answers). Only a row in `handed` may be with the provider.
  const handed = new Set<string>();
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
  const handle = async (m: OutboxRow): Promise<void> => {
    if (o.clock && o.budgetMs !== undefined && o.clock() - o.now >= o.budgetMs) { r.deferred++; return; }
    if (isReply(m.key) && stalled.has(lane(m))) { r.deferred++; return; }
    const channel = channelOf(m.contact), adapter = adapterFor(channel);
    if (!adapter || down.has(channel)) { r.not_wired++; return; } // claimed but untouched: the run's release puts it back, queued
    // IDENTITY SCENARIOS (2026-10-30): a run claims up to a hundred rows at once, each with the contact it targeted then. A
    // Telegram chat unlinked, a WhatsApp number shown to be someone else's, or a chat moved by a link while the run was
    // sending got the rest of the claimed rows anyway (the rest of a long answer went to the chat just unlinked). Each row is
    // checked against the contact's owner now; one that is no longer theirs goes back in the queue (sent home on the next run,
    // or failed with the reason when no channel is left). A check that cannot be read leaves the row for the next run.
    if (o.store.stillTheirs) {
      let mine: boolean | null;
      try { mine = await o.store.stillTheirs(m.userId, m.contact); } catch (e) { console.error("deliver: the contact's owner could not be read:", e instanceof Error ? e.message : String(e)); mine = null; }
      if (mine === null) { r.deferred++; return; }
      if (!mine) { await o.store.mark(m.id, { status: "queued", at: o.now }); r.deferred++; return; }
    }
    // STOP holds what Trainee starts (alerts, reports, cards, receipts); the answer to a message the person sent after STOP
    // still goes out, as the STOP reply promises.
    const out = await o.store.optedOut(m.contact);
    if (!isReply(m.key) && out) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STOP_NOTE }); r.skipped_opt_out++; return; }
    // CHANNEL DELIVERY SCENARIOS (2026-10-29): an answer to a message sent BEFORE the STOP is not one sent after it. The
    // rest of a long answer still queued (its later parts, a retry) went out after the person said STOP; now it is held
    // like everything else. The answer row's deliver_at is the time of the message it answers.
    if (isReply(m.key) && out && o.store.optedOutAt) {
      const since = await o.store.optedOutAt(m.contact);
      // TELEGRAM ROUND 3 (2026-10-31): or AT it: a 403 (the person blocked the bot) on part k of an answer, in the run that
      // answered their message, is recorded at that message's time, and every later part of the same answer still went to the
      // chat that had just blocked Trainee, one refused call each.
      if (since !== null && m.deliver_at <= since) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STOPPED_REPLY_NOTE }); r.skipped_opt_out++; return; }
    }
    // ERASE SCENARIOS ROUND 2 (2026-10-30): an answer a run had claimed went out after the person's account was deleted
    // (a pause does not hold an answer, and the account's pause was gone with it). A deleted account gets nothing; a check
    // that cannot be read leaves the row claimed and untouched, never sent on a guess.
    if (isReply(m.key) && o.store.gone) {
      let g: boolean | null;
      try { g = await o.store.gone(m.userId); } catch (e) { console.error("deliver: the account could not be read:", e instanceof Error ? e.message : String(e)); g = null; }
      if (g === null) { r.deferred++; return; }
      if (g) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: GONE_NOTE }); r.skipped_opt_out++; return; }
    }
    // CONNECTORS ROUND 4 (2026-11-05): and any later row of a person this run already looked at. The pause (which counts a
    // deleted account as quiet) is read once per person per run, so an account deleted while the run held several of the
    // person's rows (a job alert, a receipt, the rest of a card) got every row after the first: the auth user's delete
    // cascaded their outbox rows, and the run sent from what it held. A look that cannot be made leaves the row to the pause
    // read for this run, as before.
    if (!isReply(m.key) && quiet.has(m.userId) && o.store.gone) {
      let g: boolean | null;
      try { g = await o.store.gone(m.userId); } catch { g = null; }
      if (g) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: GONE_NOTE }); r.skipped_opt_out++; return; }
    }
    // WO-091c: the same for a pause or an erase that came after the row was queued, checked now, at delivery. A pause that
    // cannot be read leaves the row claimed and untouched (the run's release puts it back), never sent on a guess.
    if (!isReply(m.key)) {
      const q = await isQuiet(m.userId);
      if (q === null) { r.deferred++; return; }
      if (q) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: PAUSED_NOTE }); r.skipped_opt_out++; return; }
    }
    // A job alert or report queued before the person paused or stopped their alerts by text (their watch, not the
    // account) is checked again now. Not wanted: not sent. A check that cannot be read leaves the row for the next run.
    if (/^(alert|report):/.test(m.key) && o.now - m.deliver_at > ALERT_STALE_MS && ((adapter.limits.windowMs ?? null) === null || m.heldAt === null)) {
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: STALE_NOTE }); r.skipped_opt_out++; return;
    }
    if (m.key.startsWith("brief:") && o.store.briefWanted) {
      let wanted: boolean | null;
      try { wanted = await o.store.briefWanted(m); } catch (e) { console.error("deliver: the interview could not be read:", e instanceof Error ? e.message : String(e)); wanted = null; }
      if (wanted === null) { r.deferred++; return; }
      if (!wanted) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: BRIEF_GONE_NOTE }); r.skipped_opt_out++; return; }
    }
    if (/^(alert|report):/.test(m.key) && o.store.alertWanted) {
      let wanted: boolean | null;
      try { wanted = await o.store.alertWanted(m); } catch (e) { console.error("deliver: the job alerts could not be read:", e instanceof Error ? e.message : String(e)); wanted = null; }
      if (wanted === null) { r.deferred++; return; }
      if (!wanted) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: ALERTS_OFF_NOTE }); r.skipped_opt_out++; return; }
    }
    if (m.key.startsWith("alert:") && o.store.alertWithinLimits) {
      let within: boolean | null;
      try { within = await o.store.alertWithinLimits(m, o.now); } catch (e) { console.error("deliver: the alert limits could not be read:", e instanceof Error ? e.message : String(e)); within = null; }
      if (within === null) { r.deferred++; return; }
      if (!within) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: LIMITS_NOTE }); r.skipped_opt_out++; return; }
    }
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): quiet hours on the person's clock as it is now. Inside them, the row goes
    // back in the queue for the first quarter hour after them (after the checks above: a stale or unwanted row is not
    // kept for the morning); a read that fails leaves it for the next run.
    if (QUIET_AWARE.test(m.key) && o.store.quietHours) {
      const q = await quietHoursOf(m.userId);
      if (q === undefined) { r.deferred++; return; }
      // REVIEW (PR #355): a reminder set in chat carries the zone the person named on its key (career_reminders.ts
      // reminderKey); its quiet hours are on that clock, with the default hours when none are saved, as its reply said.
      // Held on the saved zone (or Eastern), "9am London time" from a Chicago account waited until 7 AM Chicago.
      const own = reminderZoneOf(m.key);
      if (q || own) {
        const tz = own ?? zoneOr(q!.tz), hours = { quiet_start: q?.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: q?.quiet_end ?? DEFAULT_PREFS.quiet_end };
        if (quietAt(o.now, tz, hours)) { await o.store.mark(m.id, { status: "queued", at: o.now, deliverAt: Math.max(o.now + 60000, nextAwake(o.now, tz, hours)) }); r.deferred++; return; }
      }
    }
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a daily report waits in the outbox (quiet hours, a channel behind) while
    // postings on it close. Each one closed since it was written is said to be closed, on its own line; a read that fails
    // leaves the report for the next run.
    let text = m.text;
    // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): the alert or report as it is true now (the posting's words now, its age
    // now, the person's search now); a read that fails leaves the row for the next run.
    if (/^(alert|report):/.test(m.key) && o.store.freshText) {
      let fresh: string | null | undefined;
      try { fresh = await o.store.freshText(m, o.now); } catch (e) { console.error("deliver: the alert's posting could not be read:", e instanceof Error ? e.message : String(e)); fresh = undefined; }
      if (fresh === undefined) { r.deferred++; return; }
      if (fresh === null) { await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: FRESH_NOTE }); r.skipped_opt_out++; return; }
      text = fresh;
    }
    if (m.key.startsWith("report:") && o.store.closedLinks) {
      const urls = [...text.matchAll(/^ {2}(https:\/\/\S+)$/gm)].map((x) => x[1]);
      if (urls.length) {
        let closed: Set<string> | null;
        try { closed = await o.store.closedLinks(urls); } catch (e) { console.error("deliver: the report's postings could not be read:", e instanceof Error ? e.message : String(e)); closed = null; }
        if (closed === null) { r.deferred++; return; }
        if (closed.size) {
          const lines = text.split("\n");
          for (let i = 1; i < lines.length; i++) if (closed.has(lines[i].trim()) && lines[i - 1].startsWith("- ") && !lines[i - 1].endsWith(CLOSED_SINCE)) lines[i - 1] += CLOSED_SINCE;
          text = lines.join("\n");
        }
      }
    }
    // CONNECTORS ROUND 4 (2026-11-05): a text made from the person's mail, looked at again right before it goes. The person
    // said "disconnect gmail" (or connected another Google account) after this run claimed it: the disconnect deleted it
    // with every other undelivered text from that mailbox, and it is not sent. A look that cannot be made leaves it.
    if (mailboxText(m.key) && o.store.stillQueued) {
      let there: boolean | null;
      try { there = await o.store.stillQueued(m); } catch (e) { console.error("deliver: the queued mail text could not be read:", e instanceof Error ? e.message : String(e)); there = null; }
      if (there === null) { r.deferred++; return; }
      if (!there) { r.skipped_opt_out++; return; }
    }
    const window = adapter.limits.windowMs ?? null;
    const stall = () => { if (isReply(m.key)) stalled.add(lane(m)); };
    // An opted-out person's held answer waits for their next message; Trainee never starts a template to them.
    if (window !== null && (m.lastInboundAt == null || o.now - m.lastInboundAt >= window)) { stall(); await hold(m, adapter, HELD_NOTE, out); return; }
    const cap = adapter.limits.dailyContacts ?? Infinity;
    const known = await o.store.sentTo(m.contact, day);
    // Rows of other people may be in flight (concurrency): a new contact being sent to now counts against the plan's cap
    // before its send ends, so the cap is never passed by the rows that were checked together.
    let reserved = false;
    if (!known && cap !== Infinity) {
      if (await counted(channel) + (inflightNew.get(channel) ?? 0) >= cap) { stall(); r.capped++; return; } // stays queued for tomorrow's allowance
      inflightNew.set(channel, (inflightNew.get(channel) ?? 0) + 1); reserved = true;
    }
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): a row some of whose messages already went out (an earlier attempt stopped by a
    // 429 or the window part way) sends only the rest; every id it went out as is kept, in order, so a provider's later
    // "failed" for one of them maps back to the right place.
    const all = adapter.render(text), skip = Math.min(Math.max(0, m.sentParts ?? 0), all.length), before = m.sentIds ?? [];
    const bubbles = all.slice(skip);
    let res: SendResult;
    if (skip > 0 && !bubbles.length) res = { ok: true, id: before[0] ?? null, ids: [] };
    else {
      handed.add(m.id);
      try { res = await adapter.send(addressOf(m.contact), bubbles, m.buttons?.length || isReply(m.key) ? { ...(m.buttons?.length ? { buttons: m.buttons } : {}), ...(isReply(m.key) ? { urgent: true } : {}) } : undefined); }
      catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }; }
    }
    if (reserved) {
      inflightNew.set(channel, (inflightNew.get(channel) ?? 1) - 1);
      if (res.ok && contacts.has(channel)) contacts.set(channel, contacts.get(channel)! + 1);
    }
    if (res.ok) {
      const ids = [...before, ...(res.ids ?? (res.id ? [res.id] : []))];
      await o.store.mark(m.id, { status: "delivered", at: o.now, providerId: ids[0] ?? res.id ?? undefined, ...(ids.length ? { providerIds: ids } : {}), ...(text !== m.text ? { text } : {}) });
      r.delivered++;
      return;
    }
    const went = res.sent && res.sent > 0 ? { parts: skip + res.sent, ids: [...before, ...(res.sentIds ?? [])] } : skip > 0 ? { parts: skip, ids: before } : undefined;
    const progress = went ? { sentParts: went.parts, providerIds: went.ids } : {};
    if (res.unauthorized) {
      if (!down.has(channel)) console.error(`deliver: ${channel} refused Trainee's credentials; its messages wait until they work:`, res.error);
      down.add(channel);
      // Nothing went in this attempt (parts sent by an earlier attempt stay recorded as they are): the row is untouched and
      // goes back, no attempt counted. Part of it went now (the credentials stopped working mid-row): the rest waits like any
      // temporary failure, from the message that did not go.
      if (!(res.sent && res.sent > 0)) { handed.delete(m.id); stall(); r.not_wired++; return; }
    }
    // WhatsApp refused it for the window or the per-user limit: nothing of that message went out, so it waits for the next
    // message (from the first message that did not go).
    stall();
    if (res.hold) { await hold(m, adapter, res.error, out, went); return; }
    if (res.optOut) {
      // The person blocked Trainee on this channel (Telegram's 403): that is their STOP; recorded, not retried.
      await o.store.setOptOut(m.contact, true, o.now);
      await o.store.mark(m.id, { status: "skipped_opt_out", at: o.now, error: res.error, ...progress });
      r.skipped_opt_out++;
      return;
    }
    const attempt = m.attempts + 1;
    const retryable = res.retryable || res.unauthorized === true;
    // TELEGRAM SCENARIOS (2026-10-30): never sooner than the provider asked (Telegram's 429 retry_after). CHANNEL DELIVERY
    // ROUND 2: counted from when the 429 came (the run's clock), not the run's start: a 429 on a row's 2nd message, a paced
    // second later, was retried that much early.
    const paced = res.retryAfterMs !== undefined;
    if (retryable && (attempt < MAX_ATTEMPTS || (paced && attempt < MAX_PACED_ATTEMPTS))) {
      const backoff = paced ? BACKOFF_MS[0] : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
      await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error, retryAt: Math.max(o.now + backoff, (o.clock ? Math.max(o.now, o.clock()) : o.now) + (res.retryAfterMs ?? 0)), ...progress }); r.retried++;
    }
    else { await o.store.mark(m.id, { status: "failed", at: o.now, error: res.error, ...progress }); r.failed++; }
  };
  // WO-DT: with concurrency above 1, rows of different people (and channels) go out side by side; the rows of one person on one
  // channel stay one after another, in order (a reply's parts, "later replies wait for a stalled one"). Concurrency 1 (the
  // default) is the old single file, row by row.
  const due = await o.store.due(o.now, o.limit ?? 100);
  const workers = Math.max(1, Math.min(64, Math.floor(o.concurrency ?? 1)));
  // CHANNEL DELIVERY ROUND 4 (2026-11-05): the first failure stops the run: no row is started after it (with concurrency, the
  // other workers finish the row they are on and stop; before, Promise.all gave up on them while they went on sending). A row
  // that was handed to a provider stays "sending" for the sweep, never resent (at most once). The row whose own handling
  // failed before any send counts the failure as one attempt (RUN_FAILED_NOTE; a failure that is that row's own would
  // otherwise stop every run at it, the rows behind it never sent); every other row no provider was asked to send goes back
  // as it was (putBack). Then the failure is thrown, as before.
  let failure: { e: unknown } | null = null;
  const own = new Set<string>();
  const step = async (m: OutboxRow) => {
    if (failure) return;
    try { await handle(m); } catch (e) { failure ??= { e }; if (!handed.has(m.id)) own.add(m.id); }
  };
  if (workers === 1) for (const m of due) await step(m);
  else {
    const lanes = new Map<string, OutboxRow[]>();
    for (const m of due) { const k = lane(m); (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(m); }
    const queue = [...lanes.values()];
    await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (let next = queue.shift(); next && !failure; next = queue.shift()) for (const m of next) await step(m);
    }));
  }
  const failed = failure as { e: unknown } | null; // set inside the workers
  if (failed) {
    const said = (e: unknown) => e instanceof Error ? e.message : String(e);
    for (const m of due.filter((x) => own.has(x.id))) {
      const attempt = m.attempts + 1;
      const last = attempt >= OUTBOX_MAX_ATTEMPTS || (attempt >= MAX_ATTEMPTS && (m.lastError === undefined || m.lastError === RUN_FAILED_NOTE));
      await o.store.mark(m.id, { status: "failed", at: o.now, error: RUN_FAILED_NOTE, ...(last ? {} : { retryAt: o.now + BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] }) })
        .catch((e) => console.error("deliver: a row whose handling failed could not be recorded (the sweep fails it):", said(e)));
    }
    const untouched = due.filter((m) => !handed.has(m.id) && !own.has(m.id)).map((m) => m.id);
    if (untouched.length && o.store.putBack) await o.store.putBack(untouched).catch((e) => console.error("deliver: claimed rows could not be put back (the sweep fails them):", said(e)));
    throw failed.e;
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
      if (m.status === "delivered") { x.sentAt = m.at; x.providerIds = m.providerIds ?? (m.providerId ? [m.providerId] : null); if (m.text !== undefined) x.text = m.text; }
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
