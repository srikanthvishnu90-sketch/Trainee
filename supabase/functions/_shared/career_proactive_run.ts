// One scheduled alerts run (WO-007b), over injected stores so it runs the same in the function, the simulator and tests:
// everyone with alerts on, the postings first seen in the last 26 hours (plus anything held back for a report), the plan
// from career_alerts.ts, the outbox written once per key, and each person's counters saved. Counters: alerts sent count
// against the person's local day (reset when their date changes); held postings are kept until a report carries them;
// last_checked_at moves to this run, so a posting is alerted at most once.
// WO-037, enforced here rather than trusted from the plan: an alert is queued only if its posting passes the person's
// own gate again at the moment of queuing (matchPosting: their keywords, place and relevance floor; and news, not
// backlog), so nothing below the person's threshold is ever sent; the planner holds no alert for a weekly count (but see the
// database's career_alert_enqueue, which still does). Each alert carries its posting's first_seen_at, for the latency report.
import { DEFAULT_PREFS, fitFloorOk, localDay, matchPosting, planProactive, quietAt, twinKey, zoneOr } from "./career_alerts.ts";
import { alertFits } from "./career_alert_fit.ts";
import { freshWhenSeen } from "./career_fresh.ts";
import type { AlertRow, AlertStore, Outbox } from "./career_alert_store.ts";
import { interestsFromWatch } from "./career_watch_alerts.ts";
import { planReceipts, type ReceiptRow } from "./career_apply_receipts.ts";
import { cardFor, type Prepared } from "./career_apply_cards.ts";
import { candidates, type Classified, classifyMail, decidedAs, draftOffer, foldEvents, fromEmployer, type MailIn, planUpdates, type StatusEvent, type TrackedApp } from "./career_mail.ts";
import type { ReadResult } from "./career_mail_gmail.ts";
import type { MailPerson, MailStore } from "./career_mail_store.ts";
import { MAIL_MODEL_DAILY_CAP, MAIL_MODEL_MAX_CALLS, MAIL_MODEL_MAX_RUN_CALLS, type MailModelWiring, secondPass, toAsk } from "./career_mail_model.ts";
import { newMeter } from "./model_gateway.ts";
import { type EventStore, recordEvent } from "./agent/timeline.ts";
import { type AskStore, type ConfirmStore, planConfirmations } from "./career_apply_confirm.ts";
import { receiptText } from "./career_apply_receipts.ts";
import { type OpenQuestion, questionsText } from "./career_apply_questions.ts";
import { cancelsInterview, extractInvite, type InterviewRow, interviewDrafts, interviewRow, inviteBrief, inviteRef, MOVES_INTERVIEW, whenLine } from "./career_invite.ts";
import type { DigestStore, InterviewStore } from "./career_brief_store.ts";
import { buildDigest, DEFAULT_DIGEST, digestDue } from "./career_digest.ts";
import { type AheadCandidate, aheadCap, aheadCardText, type AheadOutcome, type AheadStore, AHEAD_WINDOW_MS, selectAhead, stopWhy } from "./career_prepare_ahead.ts";

export interface RunStats { users: number; alerts: number; held: number; reports: number; duplicates: number; postings: number; receipts?: number; cards?: number; statuses?: number; followups?: number; briefs?: number; brief_ms_max?: number | null; digests?: number; questions?: number; confirmations?: number; asks?: number; mail_model?: string; mail_model_ask?: string; mail_model_calls?: number; mail_model_decided?: number; mail_model_capped?: number; below_threshold?: number; watch_off?: number; watch_unread?: number; ahead_people?: number; ahead_picked?: number; ahead_ready?: number; ahead_cards?: number; below_fit?: number; alerts_off?: number; fit_scored?: number; intro_reminders?: number; people_sweeps?: number }
// WO-091c: a rail that failed for some people still reports what it did for the rest. The error carries that result as
// `partial`, so the scheduled run records true counts beside the failure, and the message is unchanged.
export function partialError<T>(message: string, partial: T): Error & { partial: T } {
  return Object.assign(new Error(message), { partial });
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 3).trim()}...`; };
// The person's local date; a zone the runtime does not know reads as the default zone (career_alerts.ts zoneOr), never a
// RangeError that stops everyone's run.
const localDate = (at: number, tz: string | null | undefined) => localDay(at, tz);

// A row made from watches set by text (prefs.interests, career_watch_alerts.ts) sends only what the person's watch record
// says now (career_watch_kv, career:watch-profile:<user>, read through `watches`): the alert settings are a copy, and a
// copy whose write failed must never keep alerting after the person paused, stopped or erased. Record gone (erased): the
// row sends nothing and is removed. Paused, or no watch left: nothing. The watches matched are the record's. No reader,
// or a read that fails: no watch row sends anything this run. Rows set otherwise (no interests) are not touched.
// F7: with each verified row, the scoring profile its watch record carries (the person's confirmed facts in 121's shape),
// for the fit the alerts are ranked and floored by.
async function verifiedWatches(rows: AlertRow[], o: { store: AlertStore; watches?: (userIds: string[]) => Promise<Map<string, unknown>> }, stats: RunStats, profiles: Map<string, unknown>): Promise<AlertRow[]> {
  const theirs = rows.filter((r) => r.prefs?.interests?.length);
  if (!theirs.length) return rows;
  let record: Map<string, unknown> | null = null;
  try {
    if (o.watches) record = await o.watches(theirs.map((r) => r.id));
  } catch (e) {
    console.error("alerts: watch records unread, no watch alerts this run:", errText(e));
  }
  if (!record) {
    stats.watch_unread = theirs.length;
    return rows.filter((r) => !r.prefs?.interests?.length);
  }
  const out: AlertRow[] = [];
  for (const r of rows) {
    if (!r.prefs?.interests?.length) { out.push(r); continue; }
    const wp: any = record.get(r.id) ?? null, interests = interestsFromWatch(wp);
    if (!interests.length || wp?.opt_out?.global) {
      stats.watch_off = (stats.watch_off ?? 0) + 1;
      if (!wp && o.store.remove) await o.store.remove(r.id).catch((e) => console.error("alerts: remove an erased watch's settings:", errText(e)));
      continue;
    }
    if (wp?.scoring_profile && typeof wp.scoring_profile === "object") profiles.set(r.id, wp.scoring_profile);
    out.push({ ...r, prefs: { ...r.prefs, interests } });
  }
  return out;
}

export async function runAlerts(o: {
  store: AlertStore; outbox: Outbox; now: number;
  recentPostings: (sinceIso: string) => Promise<any[]>; postingsById: (ids: string[]) => Promise<any[]>;
  watches?: (userIds: string[]) => Promise<Map<string, unknown>>;
}): Promise<RunStats> {
  const stats: RunStats = { users: 0, alerts: 0, held: 0, reports: 0, duplicates: 0, postings: 0 };
  const profiles = new Map<string, unknown>();
  const rows = await verifiedWatches(await o.store.active(), o, stats, profiles);
  stats.users = rows.length;
  if (!rows.length) return stats;
  const recent = await o.recentPostings(new Date(o.now - 26 * 3600000).toISOString());
  const have = new Set(recent.map((p) => p.job_id));
  const heldIds = [...new Set(rows.flatMap((r) => r.held || []))].filter((id) => !have.has(id));
  const postings = heldIds.length ? [...recent, ...(await o.postingsById(heldIds.slice(0, 2000)))] : recent;
  stats.postings = postings.length;
  // A new local day starts the person's count over. There is no weekly cap (owner rule "no limits").
  // PROACTIVE SCENARIOS (2026-10-29): alerts a run queued and never counted. A run that queues and then dies before saving
  // its counters (a crash, a timeout, a save error) leaves the person's count and last check where they were; the next run
  // plans the same postings again and, freshest first, puts newer ones ahead of them: a cap of 3 a day became 5. The
  // alerts already queued for postings this run would plan again (first seen at or after the person's last check) count
  // against today before planning. A store that cannot say is counted at each duplicate the run meets instead.
  const checked = Math.max(o.now - 26 * 3600000, Math.min(...rows.map((r) => Date.parse(r.last_checked_at)).filter(Number.isFinite)));
  const queued = o.store.alertKeysSince
    ? await o.store.alertKeysSince(new Date(Number.isFinite(checked) ? checked : o.now - 26 * 3600000).toISOString())
      .catch((e) => { console.error("alerts: the queued alerts could not be read; each duplicate is counted instead:", errText(e)); return null; })
    : null;
  const seenAt = new Map(postings.map((p) => [`alert:${p.job_id}`, Date.parse(String(p.first_seen_at ?? ""))]));
  const counted = new Map<string, Set<string>>();
  for (const r of rows) {
    const since = Date.parse(r.last_checked_at);
    counted.set(r.id, new Set([...(queued?.get(r.id) ?? [])].filter((k) => (seenAt.get(k) ?? -Infinity) >= since)));
  }
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): with an outbox that queues each alert against the person's count in the same
  // step (enqueueAlert), that count is the truth, alerts a dead run queued included: the plan's room is only a first guess.
  const atomic = typeof o.outbox.enqueueAlert === "function";
  const byId = new Map(postings.map((p) => [p.job_id, p]));
  const users: AlertRow[] = rows.map((r) => ({ ...r, instant_sent_today: (r.sent_on === localDate(o.now, r.tz) ? r.instant_sent_today : 0) + (atomic ? 0 : counted.get(r.id)!.size),
    alerted_twins: [...(queued?.get(r.id) ?? [])].map((k) => byId.get(k.slice("alert:".length))).filter(Boolean).map(twinKey) }));
  // F7: the fit to each matching posting, for people whose watch record carries their confirmed facts; ranked and floored
  // by the planner, and the floor checked again below at the moment of queuing.
  const fits = await alertFits({ users, postings, profiles, full: o.postingsById });
  stats.fit_scored = [...fits.values()].reduce((n, m) => n + m.size, 0);
  const plan = planProactive({ users, postings, now: o.now, fits });
  // WO-091c: one person's failure (a queue or save error) is recorded and never stops the next person's alerts.
  const failed: string[] = [];
  for (const u of users) {
    try {
      const mine = plan.filter((p) => p.userId === u.id);
      let sent = 0;
      const held = new Set(u.held || []);
      let reported = false, legacy = !atomic;
      const today = localDate(o.now, u.tz), weekSince = new Date(o.now - 7 * 86400000).toISOString();
      for (const p of mine) {
        if (p.kind === "held") { held.add(p.job_id); stats.held++; continue; }
        let firstSeen: string | undefined;
        if (p.kind === "alert") {
          const posting = byId.get(p.job_id);
          if (!posting || !freshWhenSeen(posting) || !matchPosting(posting, u.prefs)) { stats.below_threshold = (stats.below_threshold ?? 0) + 1; continue; }
          if (!fitFloorOk(fits.get(u.id)?.get(p.job_id), u.prefs)) { stats.below_fit = (stats.below_fit ?? 0) + 1; continue; }
          const seen = Date.parse(String(posting.first_seen_at ?? ""));
          if (Number.isFinite(seen)) firstSeen = new Date(seen).toISOString();
          if (atomic) {
            const fit = fits.get(u.id)?.get(p.job_id)?.score;
            const got = await o.outbox.enqueueAlert!(u.id, { key: p.key, text: p.text, at: p.at, ...(firstSeen ? { first_seen_at: firstSeen } : {}), fit: typeof fit === "number" ? fit : null }, { day: today, weekSince });
            if (got === "queued") { sent++; stats.alerts++; continue; }
            if (got === "duplicate") { stats.duplicates++; continue; }
            if (got === "capped") { held.add(p.job_id); stats.held++; continue; }
            if (got === "below_fit") { stats.below_fit = (stats.below_fit ?? 0) + 1; continue; }
            if (got === "off") { stats.alerts_off = (stats.alerts_off ?? 0) + 1; continue; }
            legacy = true; // unsupported: queued below, counted by this run as before
          }
        }
        const fresh = await o.outbox.enqueue(u.id, { key: p.key, kind: p.kind, text: p.text, at: p.at, ...(firstSeen ? { first_seen_at: firstSeen } : {}) });
        // An alert already queued, not counted above (a run alongside this one queued it after this run read the outbox, or
        // the store cannot list them), counts against today's cap too.
        if (!fresh) { stats.duplicates++; if (p.kind === "alert" && !counted.get(u.id)!.has(p.key)) sent++; continue; }
        if (p.kind === "alert") { sent++; stats.alerts++; } else { reported = true; stats.reports++; }
      }
      const counters = {
        last_checked_at: new Date(o.now).toISOString(),
        instant_sent_today: u.instant_sent_today + sent, sent_on: today,
        held: reported ? [] : [...held], // a report lists what was held; after it, nothing is held
        last_report_on: reported ? today : u.last_report_on,
      };
      // WO-091c: only the run's own counters are written, never the settings read at the start of the run, so a "stop my
      // alerts" that lands while the run is going stays stopped. A store without saveCounters writes the whole row.
      // Every alert counted as it was queued (enqueueAlert): the day's count is the store's, never this run's copy of it.
      if (o.store.saveCounters) await o.store.saveCounters(u.id, counters, legacy ? undefined : { counted: true });
      else { const { alerted_twins: _twins, ...row } = u; await o.store.save({ ...row, ...counters }); }
    } catch (e) {
      failed.push(errText(e));
    }
  }
  if (failed.length) throw partialError(`alerts failed for ${failed.length} people (${stats.alerts} alerts queued): ${failed[0]}`, stats);
  return stats;
}

// FEATURE 3 (D-011; G4): applications prepared before the person asks. For each person with alerts on (the watch
// records verified as runAlerts verifies them), an account that is not paused and a resume on file: once a local day,
// today's best new matches for their watches (selectAhead), up to their cap (aheadCap), each prepared by `prepare` (the
// queue path's own preparation: the engine's dry run, the tailored resume and the drafted cover note bound into the
// payload hash), then ONE card for the day ("8/10 applications ready for your yes", each stop named), pushed through the
// database's own card push (career_apply_card_push_as: a texting thread, no STOP, no other card open, the thread not
// busy). Outside quiet hours only; a card held back is tried again by later runs that day. Nothing is approved, queued
// or sent here: the person's tap on the card is the only approval. One person's failure never stops the next.
export interface AheadStats { people: number; picked: number; ready: number; cards: number; no_resume: number; pace_unreadable: number }
export async function runPrepareAhead(o: {
  store: AlertStore; now: number; recentPostings: (sinceIso: string) => Promise<any[]>;
  watches?: (userIds: string[]) => Promise<Map<string, unknown>>;
  ahead: AheadStore; prepare: (c: AheadCandidate) => Promise<AheadOutcome>;
}): Promise<AheadStats> {
  const stats: AheadStats = { people: 0, picked: 0, ready: 0, cards: 0, no_resume: 0, pace_unreadable: 0 };
  const rows = (await verifiedWatches(await o.store.active(), o, { users: 0, alerts: 0, held: 0, reports: 0, duplicates: 0, postings: 0 }, new Map()))
    .filter((r) => r.prefs?.on);
  if (!rows.length) return stats;
  const accounts = await o.ahead.accounts(rows.map((r) => r.id));
  let postings: any[] | null = null;
  const failed: string[] = [];
  for (const u of rows) {
    const acct = accounts.get(u.id);
    if (!acct) continue;
    try {
      const date = localDate(o.now, u.tz);
      const quiet = quietAt(o.now, u.tz || "America/New_York", { quiet_start: u.prefs.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: u.prefs.quiet_end ?? DEFAULT_PREFS.quiet_end });
      let day = await o.ahead.day(u.id);
      if (!day || day.date !== date) {
        if (!(await o.ahead.resumeOnFile(u.id))) { stats.no_resume++; continue; }
        const { cap, why } = aheadCap(await o.ahead.pace(u.id));
        if (why) { stats.pace_unreadable++; continue; }
        postings ??= await o.recentPostings(new Date(o.now - AHEAD_WINDOW_MS).toISOString());
        const { picks } = selectAhead({ prefs: u.prefs, postings, now: o.now, taken: await o.ahead.taken(u.id, o.now), cap });
        stats.people++;
        const outcomes: { p: any; r: AheadOutcome }[] = [];
        for (const p of picks) {
          const c: AheadCandidate = { user_id: u.id, job_id: String(p.job_id), company: String(p.company ?? ""), title: String(p.title ?? ""), url: String(p.url ?? ""),
            location: String(p.location ?? ""), description: String(p.description ?? ""), epoch: acct.epoch, version: acct.version };
          const r = await o.prepare(c).catch((e): AheadOutcome => ({ job_id: c.job_id, outcome: "error", detail: errText(e) }));
          outcomes.push({ p, r });
        }
        const ready = outcomes.filter((x) => x.r.outcome === "ready" && x.r.prepared_id);
        stats.picked += picks.length;
        stats.ready += ready.length;
        day = {
          date, picked: picks.length, ready_ids: ready.map((x) => x.r.prepared_id!), card_id: null,
          stops: outcomes.filter((x) => !(x.r.outcome === "ready" && x.r.prepared_id)).map((x) => ({ company: String(x.p.company ?? ""), title: String(x.p.title ?? ""), why: stopWhy(x.r) })),
        };
        await o.ahead.saveDay(u.id, day);
      }
      if (day.card_id || !day.ready_ids.length || quiet) continue;
      const card = aheadCardText({ picked: day.picked, ready: await o.ahead.ready(u.id, day.ready_ids), stops: day.stops });
      if (!card) continue;
      const id = await o.ahead.push(u.id, card.take.map((p) => p.id), card.text);
      if (id) { stats.cards++; await o.ahead.saveDay(u.id, { ...day, card_id: id }); }
    } catch (e) {
      failed.push(errText(e));
    }
  }
  if (failed.length) throw partialError(`prepare ahead failed for ${failed.length} people (${stats.ready}/${stats.picked} ready): ${failed[0]}`, stats);
  return stats;
}

// Receipts (WO-021 step 5): every application that finished in the last 26 hours, said once (the outbox keeps one text
// per receipt:<id>, ever), whether or not the person has job alerts on. Returns how many were queued now.
// WO-027: a receipt queued for the first time is also written to the person's timeline (application_finished, once,
// since the outbox key is once ever); a timeline that cannot be written never stops a receipt.
// PROACTIVE SCENARIOS (2026-10-29): a receipt waits out the person's quiet hours like every other text Trainee starts. It
// was queued for the run's own time, so an application that finished overnight (the cloud runs through the night) was
// texted at 3 am. A row that carries the person's zone (`tz`, null when none is on file: the reader in index.ts adds it,
// with their quiet hours) is held to the end of their quiet hours; a reader that says nothing of the zone keeps the old
// timing.
export type ReceiptDue = ReceiptRow & { tz?: string | null; quiet_start?: number; quiet_end?: number };
export async function runReceipts(o: { outbox: Outbox; now: number; finished: (sinceIso: string) => Promise<ReceiptDue[]>; events?: EventStore | null }): Promise<number> {
  const rows = await o.finished(new Date(o.now - 26 * 3600000).toISOString());
  const byId = new Map(rows.map((r) => [`receipt:${r.id}`, r]));
  let n = 0;
  const failed: string[] = [];
  for (const r of planReceipts(rows, o.now)) {
    try {
      const row = byId.get(r.key);
      const at = row && row.tz !== undefined ? awake(o.now, row.tz, row) : r.at;
      if (!(await o.outbox.enqueue(r.userId, { key: r.key, kind: r.kind, text: r.text, at }))) continue;
      n++;
      await recordEvent(o.events, {
        user_id: r.userId, at: o.now, kind: "application_finished", subject: row?.company ?? "",
        detail: { application: row?.id ?? null, state: row?.state ?? null, url: row?.url ?? null, reason: row?.reason ?? null, confirmation_id: row?.confirmation_id ?? null },
        source: "receipt",
      });
    } catch (e) {
      failed.push(errText(e));
    }
  }
  if (failed.length) throw partialError(`receipts failed for ${failed.length} applications (${n} queued): ${failed[0]}`, n);
  return n;
}

// The card of prepared applications (WO-022 step 3), shown in the person's texting thread without being asked for. A batch
// counts once it has settled (nothing prepared in the last 10 minutes, so one batch is not split across cards), never in
// the person's quiet hours, one card per person per run, oldest first. The database decides the rest in one transaction
// (career_apply_card_push_for): no texting thread or a STOP, a card still open, a conversation under way, or a text that
// does not carry every line pushes nothing. One person's failure does not stop the others; the run then records it.
export interface ReadyRow extends Prepared { user_id: string; created_at: string; tz?: string | null; quiet_start?: number; quiet_end?: number }
export const CARD_SETTLE_MS = 10 * 60000;
export async function runCards(o: {
  now: number; ready: () => Promise<ReadyRow[]>; push: (userId: string, ids: string[], text: string) => Promise<string | null>;
}): Promise<number> {
  const byUser = new Map<string, ReadyRow[]>();
  for (const r of await o.ready()) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  let pushed = 0;
  const failed: string[] = [];
  for (const [userId, rows] of byUser) {
    rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (Date.parse(rows[rows.length - 1].created_at) > o.now - CARD_SETTLE_MS) continue;
    const first = rows[0];
    const quiet = { quiet_start: first.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: first.quiet_end ?? DEFAULT_PREFS.quiet_end };
    if (quietAt(o.now, first.tz || "America/New_York", quiet)) continue;
    // An application too long for a text is left for "show my applications" (which says so); it never holds back the rest.
    const c = cardFor(rows.filter((r) => { const one = cardFor([r]); return one !== null && "take" in one; }));
    if (!c || !("take" in c)) continue;
    try {
      if (await o.push(userId, c.take.map((p) => p.id), c.text)) pushed++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failed.length) throw partialError(`card push failed for ${failed.length} people (${pushed} pushed): ${failed[0]}`, pushed);
  return pushed;
}

// Mail tracking (WO-024): for each person with the career Google grant, the mail since their cursor (10 minutes of
// overlap; the first read looks back 3 days), classified in code, each status event recorded once per message, one short
// text per real change, and follow-ups drafted and offered by text. Nothing is ever sent by email: a draft is a row and a
// text that shows it. Texts wait out the person's quiet hours. The least recently read go first, a few at a time, so at
// the 5-minute schedule everyone is read within the hour up to MAIL_PEOPLE_PER_RUN x 12 people. A rate limit keeps what
// was read and moves the cursor only that far. One person's failure does not stop the others; the run then records it.
export const MAIL_PEOPLE_PER_RUN = 200, MAIL_OVERLAP_MS = 10 * 60000, MAIL_FIRST_LOOKBACK_MS = 3 * 86400000;
// model (WO-040): the second pass, "off" unless CAREER_MAIL_MODEL=on; model_calls asked, model_decided read with confidence.
export interface MailStats { people: number; not_wired: number; statuses: number; followups: number; briefs: number; brief_ms_max: number | null; confirmations: number; asks: number; model?: "off" | "on" | "NOT_WIRED"; model_ask?: string; model_calls?: number; model_decided?: number; model_capped?: number; disconnected?: number }
function awake(now: number, tz: string | null | undefined, q: { quiet_start?: number; quiet_end?: number }): number {
  const quiet = { quiet_start: q.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: q.quiet_end ?? DEFAULT_PREFS.quiet_end };
  let at = now;
  while (quietAt(at, zoneOr(tz), quiet) && at < now + 86400000) at += 15 * 60000;
  return at;
}
// WO-034: with an interview store, an interview invite found in this run is briefed in this run: its stated facts are
// stored (career_interviews, once per message), and the brief is queued as two texts (brief:<message hash>:1 and :2) right
// after the status text, at most one brief per application a week (a reschedule or a second email about the same round
// is stored, not briefed again). The time from the email's arrival to the brief being queued is recorded on the row and
// the run. An application with a stated interview date leaves its thank-you and nudge to runInterviewDrafts.
export const BRIEF_AGAIN_MS = 7 * 86400000;
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30):
//   - the brief says a stated time on the person's own clock too (`tz`, career_invite.ts whenLine);
//   - a brief whose queueing failed between its two texts is finished on the next read of the same mail (the same keys, so
//     nothing is said twice). The first text went out alone and the 10-point plan never followed: the mail's events were
//     already stored, so the next read skipped it;
//   - an email that moves the interview to a stated new time is said, once, with that time ("Interview update: ...").
//     It was stored and not briefed again, so the person was never told the new time by Trainee, and the thank-you was
//     still drafted for the date it moved away from (now marked moved).
async function briefMail(o: { outbox: Outbox; now: number; briefs: InterviewStore }, userId: string, e: StatusEvent, m: MailIn, had: InterviewRow[], at: number, tz: string | null): Promise<{ ms: number; row: InterviewRow } | null> {
  const sent = Date.parse(m.date) || o.now;
  const inv = extractInvite({ text: m.snippet, subject: m.subject, from: m.from, sentAt: sent, company: e.company, role: e.role ?? null });
  const row = interviewRow(inv, { key: e.hash, source: "mail", ref: e.ref, mail_at: new Date(sent).toISOString(), seen_at: o.now });
  const unfinished = had.find((r) => r.key === e.hash && !r.brief_at);
  if (!(await o.briefs.save(userId, row)) && !unfinished) return null;
  const prior = had.filter((r) => r.key !== e.hash && r.ref === e.ref && !r.cancelled_at && !r.moved_at);
  const movedFrom = inv.when.date && MOVES_INTERVIEW.test(`${m.subject}\n${m.snippet}`)
    ? prior.filter((r) => r.date && (r.date !== inv.when.date || (r.time ?? null) !== (inv.when.time ?? null)) && Date.parse(r.mail_at ?? r.seen_at) <= sent) : [];
  const ms = Math.max(0, o.now - sent);
  if (prior.some((r) => r.brief_at && o.now - Date.parse(r.brief_at) < BRIEF_AGAIN_MS)) {
    if (!movedFrom.length) return null;
    const who = clip(inv.company ?? e.company, 80), what = inv.role ? ` for ${clip(inv.role, 80)}` : "";
    const text = `Interview update: ${who} moved your interview${what}. ${whenLine(inv, tz).replace(/^When:/, "New time:")}`;
    await o.outbox.enqueue(userId, { key: `brief:${e.hash}:moved`, kind: "brief", text, at });
    for (const r of movedFrom) { await o.briefs.mark?.(userId, r.key, { moved_at: new Date(o.now).toISOString() }); r.moved_at = new Date(o.now).toISOString(); }
    await o.briefs.briefed(userId, e.hash, o.now, ms);
    return { ms, row: { ...row, brief_at: new Date(o.now).toISOString(), brief_ms: ms } };
  }
  const b = inviteBrief(inv, { now: o.now, tz });
  let queued = 0;
  for (const [i, text] of b.texts.entries()) if (await o.outbox.enqueue(userId, { key: `brief:${e.hash}:${i + 1}`, kind: "brief", text, at })) queued++;
  for (const r of movedFrom) { await o.briefs.mark?.(userId, r.key, { moved_at: new Date(o.now).toISOString() }); r.moved_at = new Date(o.now).toISOString(); }
  if (!queued && !unfinished) return null;
  await o.briefs.briefed(userId, e.hash, o.now, ms);
  return { ms, row: { ...row, brief_at: new Date(o.now).toISOString(), brief_ms: ms } };
}
const withInterviews = (apps: TrackedApp[], rows: InterviewRow[]) =>
  apps.map((a) => { const r = rows.find((x) => x.date && inviteRef(x) === a.ref); return r ? { ...a, interview_on: r.date! } : a; });

export async function runMail(o: {
  outbox: Outbox; now: number; store: MailStore; read: (userId: string, sinceMs: number, nowMs: number) => Promise<ReadResult>; batch?: number;
  briefs?: InterviewStore | null;
  confirm?: ConfirmStore | null;
  // WO-040: the model's second look at ambiguous mail. Absent: off, the rules alone decide.
  model?: MailModelWiring | null;
}): Promise<MailStats> {
  const stats: MailStats = { people: 0, not_wired: 0, statuses: 0, followups: 0, briefs: 0, brief_ms_max: null, confirmations: 0, asks: 0 };
  const second = o.model?.status === "on" ? o.model.deps : null;
  let reserved = 0; // model calls promised to people still running, so parallel people never pass the run's cap
  if (o.model) Object.assign(stats, { model: o.model.status, model_calls: 0, model_decided: 0, model_capped: 0 }, o.model.status === "NOT_WIRED" ? { model_ask: o.model.ask } : {});
  const failed: string[] = [];
  const one = async (p: MailPerson) => {
    const since = p.read_through ? Date.parse(p.read_through) - MAIL_OVERLAP_MS : o.now - MAIL_FIRST_LOOKBACK_MS;
    const r = await o.read(p.user_id, Math.max(since, o.now - 14 * 86400000), o.now);
    if (r.status === "NOT_WIRED") { stats.not_wired++; return; }
    if (r.status === "ERROR") failed.push(r.detail);
    stats.people++;
    const had = o.briefs ? await o.briefs.list(p.user_id) : [];
    const apps = withInterviews(foldEvents(await o.store.applications(p.user_id), await o.store.events(p.user_id)), had);
    // Each message is read by the rules once; the second pass (one meter per person, its cost recorded whatever it decided)
    // sees only mail newer than the last read, and the run as a whole asks at most MAIL_MODEL_MAX_RUN_CALLS times.
    const decided = new Map<string, Classified>(r.mails.map((m) => [m.hash, classifyMail(m)]));
    const budget = Math.max(0, Math.min(MAIL_MODEL_MAX_CALLS, MAIL_MODEL_MAX_RUN_CALLS - (stats.model_calls ?? 0) - reserved));
    // WO-051: only the mail the rules are unsure of is asked about, and the person's calls today are claimed in the database
    // first (MAIL_MODEL_DAILY_CAP); a store that cannot count grants none.
    const lastRead = p.read_through ? Date.parse(p.read_through) : null;
    const want = second && budget > 0 ? Math.min(budget, toAsk(r.mails, apps, { rules: decided, since: lastRead }).filter((x) => !x.why).length) : 0;
    if (second && want > 0) {
      reserved += want;
      try {
        const granted = o.store.claimModelCalls ? await o.store.claimModelCalls(p.user_id, want, MAIL_MODEL_DAILY_CAP, o.now).catch(() => 0) : 0;
        stats.model_capped! += want - Math.min(want, granted);
        if (granted > 0) {
          const meter = newMeter();
          const sp = await secondPass(r.mails, apps, (payload) => second.call(payload, meter), { rules: decided, since: lastRead, maxCalls: Math.min(want, granted) });
          for (const [h, c] of sp.decided) decided.set(h, c);
          stats.model_calls! += sp.asked;
          stats.model_decided! += sp.decided.size;
          if (meter.calls) await second.cost(p.user_id, meter).catch((e) => console.error("mail second pass cost:", e instanceof Error ? e.message : e));
        }
      } finally { reserved -= want; }
    }
    const plan = planUpdates(r.mails, apps, o.now, decided);
    // Google verification (2026-10-26): the Gmail was read before this point; if the person disconnected it meanwhile, nothing
    // read from it is saved or said (checked again before each kind of write below). A store that cannot tell never skips.
    const gone = async () => o.store.stillConnected ? !(await o.store.stillConnected(p.user_id)) : false;
    if (await gone()) { stats.disconnected = (stats.disconnected ?? 0) + 1; return; }
    const fresh = await o.store.record(p.user_id, plan.events);
    // CONNECTORS ROUND 3 (2026-10-31): the write itself is refused once the grant is gone or the person erased everything
    // since the run began (career_mail_record_events); then nothing read is said either (an interview brief included).
    if (await gone()) { stats.disconnected = (stats.disconnected ?? 0) + 1; return; }
    const at = awake(o.now, p.tz, p);
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): an employer's email that cancels an interview on file. It was read as
    // nothing ("other"), so the person was never told, and the thank-you for the interview that never happened was still
    // drafted. Said once (status:<message>), from the employer's own mail only, and the interview is marked cancelled.
    const cancels = new Map<string, TrackedApp>();
    if (o.briefs) {
      for (const m of r.mails) {
        if (!cancelsInterview(m.subject, m.snippet)) continue;
        const c = decidedAs(m, "interview", "cancellation");
        const hits = candidates(c, plan.apps).filter((a) => fromEmployer(c, a, m.from, m.auth));
        if (hits.length === 1) cancels.set(m.hash, hits[0]);
      }
    }
    for (const t of plan.texts) {
      if (cancels.has(t.hash)) continue; // said below, as a cancellation
      if (fresh.has(t.hash) && await o.outbox.enqueue(p.user_id, { key: t.key, kind: "status", text: t.text, at })) stats.statuses++;
    }
    if (o.briefs) {
      const byHash = new Map(r.mails.map((m) => [m.hash, m]));
      for (const e of plan.events) {
        const m = byHash.get(e.hash);
        if (e.kind !== "interview" || e.flagged || !m || cancels.has(e.hash) || cancelsInterview(m.subject, m.snippet)) continue;
        // Read again after a run that died part way (its cursor not saved): an invite stored and not briefed, or not stored
        // at all, is taken up again; one already briefed is not.
        if (!fresh.has(e.hash) && had.some((x) => x.key === e.hash && x.brief_at)) continue;
        const done = await briefMail({ outbox: o.outbox, now: o.now, briefs: o.briefs }, p.user_id, e, m, had, at, p.tz && zoneOr(p.tz, "") ? zoneOr(p.tz) : null);
        if (!done) continue;
        stats.briefs++;
        stats.brief_ms_max = Math.max(stats.brief_ms_max ?? 0, done.ms);
        had.push(done.row);
      }
      // The cancellations, against every interview on file for that application before the email (this run's included).
      const rows = cancels.size ? await o.briefs.list(p.user_id) : [];
      for (const [hash, app] of cancels) {
        const m = byHash.get(hash)!, sentAt = Date.parse(m.date) || o.now;
        const on = rows.filter((x) => x.date && inviteRef(x) === app.ref && !x.moved_at && Date.parse(x.mail_at ?? x.seen_at) <= sentAt);
        const days = [...new Set(on.map((x) => x.date!))].sort().map((d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }));
        const text = `${clip(app.company, 80)} cancelled your interview${app.role ? ` for ${clip(app.role, 80)}` : ""}${days.length ? ` on ${days.join(" and ")}` : ""} (email ${new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}). I won't draft a thank-you for it. Email: "${clip(m.subject, 120)}"`;
        if (await o.outbox.enqueue(p.user_id, { key: `status:${hash}`, kind: "status", text, at })) stats.statuses++;
        for (const x of on) if (!x.cancelled_at) await o.briefs.mark?.(p.user_id, x.key, { cancelled_at: new Date(o.now).toISOString() });
      }
    }
    if (await gone()) { stats.disconnected = (stats.disconnected ?? 0) + 1; return; }
    for (const d of plan.drafts) {
      if (await o.store.saveDraft(p.user_id, d) && await o.outbox.enqueue(p.user_id, { key: `followup:${d.key}`, kind: "followup", text: draftOffer(d), at })) stats.followups++;
    }
    // WO-032: the same mail confirms applications in the queue, only on the stricter match in career_apply_confirm.ts.
    // A received email that confirms one is said once (status:confirmed:<application>); a rejection, interview or offer
    // that confirms one already has its own status text. Two that fit are asked about once, by runAsks.
    if (o.confirm && r.mails.length) {
      for (const c of planConfirmations(r.mails, await o.confirm.queue(p.user_id))) {
        if (c.kind === "ask") { if (await o.confirm.ask(p.user_id, c)) stats.asks++; continue; }
        if ((await o.confirm.confirm(p.user_id, c)) !== "confirmed") continue;
        stats.confirmations++;
        if (c.mail_kind !== "received") continue;
        const text = receiptText({ company: c.company, url: c.url, state: "confirmed", email_confirmed_at: c.mail_at, tz: p.tz ? zoneOr(p.tz) : p.tz });
        if (await o.outbox.enqueue(p.user_id, { key: `status:confirmed:${c.id}`, kind: "status", text, at })) stats.statuses++;
      }
    }
    if (r.readThrough !== null && !(await gone())) await o.store.saveCursor(p.user_id, r.readThrough);
  };
  const people = await o.store.people(MAIL_PEOPLE_PER_RUN), size = o.batch ?? 5;
  for (let i = 0; i < people.length; i += size) {
    await Promise.all(people.slice(i, i + size).map((p) => one(p).catch((e) => { failed.push(e instanceof Error ? e.message : String(e)); })));
  }
  if (failed.length) throw partialError(`mail tracking failed for ${failed.length} people (${stats.statuses} status texts queued): ${failed[0]}`, stats);
  return stats;
}

// Thank-you and nudge for interviews with a stated date (WO-034), for everyone with one, mail grant or not: the planner
// in career_invite.ts decides, the draft is stored once (career_mail_drafts, key thank_you:...), and one text offers it in
// full, after quiet hours. Nothing is ever sent to the employer: the person sends the draft themselves.
export async function runInterviewDrafts(o: {
  outbox: Outbox; now: number; interviews: InterviewStore; drafts: Pick<MailStore, "applications" | "events" | "saveDraft">;
}): Promise<number> {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  let n = 0;
  const failed: string[] = [];
  for (const p of await o.interviews.dated(day(o.now - 31 * 86400000), day(o.now + 86400000))) {
    try {
      const rows = await o.interviews.list(p.user_id);
      const apps = foldEvents(await o.drafts.applications(p.user_id), await o.drafts.events(p.user_id));
      const at = awake(o.now, p.tz, p);
      for (const d of interviewDrafts(rows, apps, o.now, zoneOr(p.tz))) {
        if (await o.drafts.saveDraft(p.user_id, d) && await o.outbox.enqueue(p.user_id, { key: `followup:${d.key}`, kind: "followup", text: draftOffer(d), at })) n++;
      }
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failed.length) throw partialError(`interview drafts failed for ${failed.length} people (${n} queued): ${failed[0]}`, n);
  return n;
}

// The weekly digest (WO-034): checked in the first 5 minutes of each hour (the run is every 5 minutes, so once an hour),
// queued for each person whose day it is and whose hour has come, in their zone, keyed digest:<ISO week> so it is said
// once a week; a digest hour inside the person's quiet hours waits for them to end. Nothing on file, nothing said.
export const DIGEST_CHECK_MINUTES = 5;
export async function runDigest(o: { outbox: Outbox; now: number; store: DigestStore }): Promise<number> {
  if (new Date(o.now).getUTCMinutes() >= DIGEST_CHECK_MINUTES) return 0;
  let n = 0;
  const failed: string[] = [];
  for (const p of await o.store.people(o.now)) {
    const tz = zoneOr(p.tz);
    const { due, week } = digestDue(p.prefs ?? DEFAULT_DIGEST, o.now, tz);
    if (!due) continue;
    try {
      const d = buildDigest(await o.store.rows(p.user_id, new Date(o.now - 7 * 86400000).toISOString()), { now: o.now, tz });
      if (d && await o.outbox.enqueue(p.user_id, { key: `digest:${week}`, kind: "digest", text: d.text, at: awake(o.now, tz, p) })) n++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failed.length) throw partialError(`digest failed for ${failed.length} people (${n} queued): ${failed[0]}`, n);
  return n;
}

// The questions a preparation left open (WO-032, ask once pushed): texted once, without being asked for, with the same
// formatter as "what do you need from me" (questionsText: at most 5, the rest counted). Only questions never pushed, once
// the preparation has settled (nothing new in the last 10 minutes), never in the person's quiet hours, one text per person
// per run. The database decides the rest in one transaction (career_apply_questions_push_for): a texting thread and no
// STOP, at most one such text a day, nothing else waiting in the thread, every question still open and never pushed, the
// text carrying every question; and it makes the text the thread's last word with the questions intent and records the
// questions shown, so the numbered answers go to questionsTurn as if the person had asked.
export interface QuestionRow extends OpenQuestion {
  user_id: string; created_at: string; pushed_at?: string | null; tz?: string | null; quiet_start?: number; quiet_end?: number;
}
export const QUESTIONS_SETTLE_MS = CARD_SETTLE_MS;
export async function runQuestions(o: {
  now: number; open: () => Promise<QuestionRow[]>; push: (userId: string, ids: string[], text: string) => Promise<boolean>;
}): Promise<number> {
  const byUser = new Map<string, QuestionRow[]>();
  for (const q of await o.open()) byUser.set(q.user_id, [...(byUser.get(q.user_id) ?? []), q]);
  let pushed = 0;
  const failed: string[] = [];
  for (const [userId, rows] of byUser) {
    // Open only: an answered question is never asked again (the database checks it once more).
    const open = rows.filter((q) => !q.answer || q.misfit).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const fresh = open.filter((q) => !q.pushed_at);
    if (!fresh.length || Math.max(...open.map((q) => Date.parse(q.created_at))) > o.now - QUESTIONS_SETTLE_MS) continue;
    const quiet = { quiet_start: fresh[0].quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: fresh[0].quiet_end ?? DEFAULT_PREFS.quiet_end };
    if (quietAt(o.now, fresh[0].tz || "America/New_York", quiet)) continue;
    const t = questionsText(fresh, open.length);
    if (!t) continue;
    try {
      if (await o.push(userId, t.take.map((q) => q.id), t.text)) pushed++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failed.length) throw partialError(`questions push failed for ${failed.length} people (${pushed} pushed): ${failed[0]}`, pushed);
  return pushed;
}

// Which application an employer's email confirms, when two fit (WO-032): each ask texted once, outside quiet hours, one
// per person per run; the database refuses it while the thread waits on something else, and it waits for a later run.
export async function runAsks(o: { now: number; store: Pick<AskStore, "pending" | "push"> }): Promise<number> {
  const seen = new Set<string>();
  let pushed = 0;
  const failed: string[] = [];
  for (const a of await o.store.pending()) {
    if (seen.has(a.user_id) || !a.text) continue;
    const quiet = { quiet_start: a.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: a.quiet_end ?? DEFAULT_PREFS.quiet_end };
    if (quietAt(o.now, a.tz || "America/New_York", quiet)) continue;
    seen.add(a.user_id);
    try {
      if (await o.store.push(a.user_id, a.hash, a.text)) pushed++;
    } catch (e) {
      failed.push(errText(e));
    }
  }
  if (failed.length) throw partialError(`asks failed for ${failed.length} people (${pushed} pushed): ${failed[0]}`, pushed);
  return pushed;
}
