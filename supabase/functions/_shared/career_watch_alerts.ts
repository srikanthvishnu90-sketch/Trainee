// Job watches set by text, as the scheduled alerts run reads them.
//
// The chat router keeps a person's watches in 152's watch profile (the account's watch state, career_watch_kv key
// career:watch-profile:<user>). The scheduled run (career-proactive) reads career_alert_prefs. syncWatchAlerts is the
// bridge: after a turn is saved, the watch the turn left becomes the person's alert settings, each watch kept whole
// (career_alerts.ts matches a posting against one watch at a time, never one watch's role in another's city).
//   - every turn with a watch makes the stored settings agree with it (a failed write is repaired by the next turn); a
//     turn with no watch at all reads and writes nothing;
//   - a watch set, changed or resumed: saved, starting from now (postings already on the boards are never alerted), with
//     the person's zone, report hour, quiet hours and caps as they were;
//   - paused, or the last watch stopped: alerts off, the settings kept;
//   - forget everything: the settings removed.
// What a watch carries over: its role's title terms (keywords) and blockers (exclude_words), its places and remote, its
// bands (intern, new grad) as levels, its firms (only these), the firms it and the opt-out exclude.
import { type AlertInterest, type AlertPrefs, type AlertSignal, alertText, DEFAULT_PREFS, matchPosting, MAX_INSTANT_PER_DAY, postingLine } from "./career_alerts.ts";
import { type AlertRow, type AlertStore, startWatching, validPrefs } from "./career_alert_store.ts";
import { type Floor, validFloor } from "./career_floor.ts";

export const WATCH_PROFILE_KEY = (userId: string) => `career:watch-profile:${userId}`;
const DEFAULT_TZ = "America/New_York";
const BAND_LEVELS: Record<string, "intern" | "entry"> = { intern: "intern", new_grad: "entry", junior: "entry" };
const text = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const texts = (v: unknown, n = 20) => [...new Set((Array.isArray(v) ? v : []).map(text).filter((x) => x && x.length <= 60))].slice(0, n);

export type WatchSync =
  | { action: "unchanged" | "none" | "saved" | "off" | "removed"; schedule?: Schedule }
  | { action: "refused"; reason: string };

// Each watch of a profile, as the alerts run matches it. A profile that is not 152's, or a watch with no title term, gives none.
export function interestsFromWatch(wp: any): AlertInterest[] {
  if (!wp || wp.type !== "career_watch_profile" || !Array.isArray(wp.interests)) return [];
  const optedOut = texts(wp.opt_out?.companies);
  const out: AlertInterest[] = [];
  for (const i of wp.interests) {
    const f = i?.filters || {};
    const levels = [...new Set(texts(f.bands).map((b) => BAND_LEVELS[b]).filter(Boolean))];
    // JOB ALERTS AS A REAL OUTCOME (2026-10-31): an internship watch's level is its floor's (levels: intern, read from the
    // title as intern, internship or co-op), so its title terms drop the level word: "frontend internships" matched only a
    // title with both "frontend" and "internships", never "Frontend Engineer Intern". A term that is only the level keeps it.
    const levelWord = levels.includes("intern") ? /\s*\b(?:interns?|internships?|co-?ops?)\b\s*/g : null;
    const keywords = [...new Set(texts(i?.role?.terms, 10).map((k) => {
      const t = k.toLowerCase(), bare = levelWord ? t.replace(levelWord, " ").replace(/\s+/g, " ").trim() : t;
      return bare || t;
    }))];
    if (!keywords.length) continue;
    const raw: Record<string, unknown> = {
      exclude_words: texts(i.role.blockers),
      exclude_companies: [...new Set([...texts(f.firms_exclude), ...optedOut])].slice(0, 20),
      ...(levels.length ? { levels } : {}),
    };
    const fl = validFloor(raw);
    const floor: Floor | undefined = fl.ok && Object.keys(fl.floor).length ? fl.floor : undefined;
    const companies = texts(f.firms_include);
    // SERIAL-1530: the person's stated location rides each watch, for a posting's stated country or region restriction.
    const home = text(wp.scoring_profile?.location).slice(0, 80);
    out.push({ keywords, locations: texts(f.locations, 10), remote_ok: f.remote_ok !== false, ...(floor ? { floor } : {}), ...(companies.length ? { companies } : {}), ...(home ? { home } : {}) });
  }
  return out;
}

// The profile as the person last set it, without the time it was written.
const same = (a: any, b: any) => JSON.stringify(a ? { ...a, updated_at: null } : null) === JSON.stringify(b ? { ...b, updated_at: null } : null);

// Every turn that has a watch makes the stored settings agree with that watch, whatever the last write did: a write that
// failed (the turn said "paused" and the row stayed on) is repaired by the next turn, not left on. A row the person's
// watches made (it has interests) follows the watch; settings made elsewhere follow it only on a turn that changed it.
// JOB ALERTS AS A REAL OUTCOME (2026-10-31): the cadence the person said with a watch ("every morning", "every morning at
// 6am central", "once a day", "every evening"), read from their own words: one message a day at that hour (Q326, Q336), with
// no instant alerts between, in the zone they named. "right away" / "as soon as" / "instantly" turns the daily message back
// into instant alerts. Nothing said: nothing changed.
const ZONES: Record<string, string> = {
  eastern: "America/New_York", et: "America/New_York", est: "America/New_York", edt: "America/New_York", "new york": "America/New_York",
  central: "America/Chicago", ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago", chicago: "America/Chicago",
  mountain: "America/Denver", mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", denver: "America/Denver",
  pacific: "America/Los_Angeles", pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
};
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as any)[k])])) : v;
const canonJson = (v: unknown) => JSON.stringify(canon(v));
// Re-review of PR #365: a stated hour is honored ("every evening at 7" is 7 PM, "every morning at 7" 7 AM, "every night
// at 9" 9 PM, "every evening at 7:30" 7:30 PM, "every day at noon" 12 PM); minutes are kept (report_minute); "every
// weekday" sends Monday to Friday only (weekdays_only); midnight is asked about, never set (it is inside quiet hours).
// Defaults with no time said: morning 8, evening 18, night 21, a day 8.
export interface Cadence { digest: boolean; report_hour?: number; report_minute?: number; tz?: string; weekdays?: boolean; ask?: "midnight" }
type Part = "morning" | "evening" | "night" | "day";
const DEFAULT_HOUR: Record<Part, number> = { morning: 8, evening: 18, night: 21, day: 8 };
// Weekdays only when the person asks for the ALERTS on weekdays (re-review of PR #365: "I'm free on weekdays, send roles
// every morning" is not a request): "every weekday (morning)", "weekdays only", "only on weekdays", or "on weekdays" /
// "Monday to Friday" in the same clause as the ask to send ("on weekdays send me...", "text me roles Mon-Fri"); a comma
// ends the clause ("I'm free on weekdays, send roles every morning" is about the person, not the alerts).
const SEND = "(?:send|text|message|alert|ping|email|notify)";
const WD = "(?:on weekdays|mon(?:day)?\\s*(?:-|to|through|thru)\\s*fri(?:day)?)";
const WEEKDAYS = new RegExp(`\\b(?:every|each) weekday\\b|\\bweekdays only\\b|\\bonly (?:on )?weekdays\\b|\\b${WD} (?:please )?${SEND}|\\b${SEND}\\b[^.,;!?]*\\b${WD}\\b`);
export function cadenceFrom(message: unknown): Cadence | null {
  const m = String(message ?? "").toLowerCase().replace(/\s+/g, " ");
  if (/\b(right away|as soon as (?:they|it|one|there)|instantly|in real[- ]time)\b/.test(m)) return { digest: false };
  const when = m.match(/\b(?:every|each) (morning|evening|night|day|weekday)s?\b|\b(daily|once a day|nightly|weekdays only)\b/);
  if (!when) return null;
  const w = when[1] ?? when[2];
  // "every weekday evening", "daily in the morning": a part of day said beside a day-only cadence is that part's.
  const named = w === "day" || w === "weekday" || w === "daily" || w === "once a day" || w === "weekdays only" ? /\b(morning|evening|night)s?\b/.exec(m)?.[1] : w;
  const part: Part = named === "morning" ? "morning" : named === "evening" ? "evening" : named === "night" || named === "nightly" ? "night" : "day";
  const weekdays = WEEKDAYS.test(m);
  const base = { digest: true as const, ...(weekdays ? { weekdays: true } : {}) };
  const t = timeSaid(m);
  const tz = zoneSaid(m, t);
  const zoned = tz ? { tz } : {};
  if (!t) return { ...base, report_hour: DEFAULT_HOUR[part], report_minute: 0, ...zoned };
  const hour = hourOf(t, part);
  if (hour === null) return { ...base, ...zoned };
  if (hour === 0 && t.minute === 0 || t.midnight) return { ...base, ask: "midnight", ...zoned };
  return { ...base, report_hour: hour, report_minute: t.minute, ...zoned };
}
// The hour on a 24-hour clock from what was said: am/pm as said; otherwise the part of day the time or the cadence names
// (evening, night and afternoon: 1-11 are PM); "every day at N" with no am/pm: 7-11 AM, 1-6 PM, 12 noon. 13-23 as said.
function hourOf(t: TimeSaid, part: Part): number | null {
  if (t.noon) return 12;
  if (t.midnight) return 0;
  const h = t.h;
  if (h > 23) return null;
  if (t.ampm) return h > 12 ? null : (h % 12) + (t.ampm === "pm" ? 12 : 0);
  if (h === 0 || h > 12) return h;
  const p = t.dayPart ?? part;
  if (p === "morning") return h === 12 ? 12 : h;
  if (p === "evening" || p === "night") return h === 12 ? 0 : h + 12;
  return h === 12 ? 12 : h >= 7 ? h : h + 12; // a day
}
// A time of day, only in a time's own form (review of PR #365: "at 3 companies" set the hour to 3): "6am", "6 pm", "6:30",
// "6 o'clock", "noon", "midnight", "at 6" followed by a time-of-day word ("at 7 in the evening") or a zone ("at 6
// central"), or "at 7" said right after the cadence ("every evening at 7", "daily at 9, please"). A number that runs on
// into other words ("at 3 companies") is never an hour.
const AMPM = "(am|pm|a\\.m\\.|p\\.m\\.)";
const ZONE_WORDS = "eastern|central|mountain|pacific|et|ct|mt|pt|est|edt|cst|cdt|mst|mdt|pst|pdt";
const CADENCE = "(?:(?:every|each) (?:morning|evening|night|day|weekday)s?|daily|nightly|once a day|weekdays only)";
const TIME_FORMS: RegExp[] = [
  new RegExp(`\\b(?:at )?(\\d{1,2})(?::(\\d\\d))? ?${AMPM}(?=\\W|$)`),
  new RegExp(`\\b(?:at )?(\\d{1,2}):(\\d\\d)\\b`),
  new RegExp(`\\b(?:at )?(\\d{1,2}) ?o'?clock(?: ?${AMPM}(?=\\W|$))?`), // "7 o'clock pm" is 7 PM
  new RegExp(`\\bat (\\d{1,2}) (?:in the |tomorrow |each |every )?(morning|evening|afternoon|night|tonight)\\b`),
  new RegExp(`\\bat (\\d{1,2}) (?=(?:${ZONE_WORDS})\\b)`),
  new RegExp(`\\b${CADENCE},? at (\\d{1,2})(?=\\s*(?:$|[,.;!?)]|and\\b|please\\b|then\\b|instead\\b|from now\\b|time\\b))`),
];
export interface TimeSaid { h: number; minute: number; ampm: "am" | "pm" | null; dayPart: "morning" | "evening" | null; end: number; noon?: boolean; midnight?: boolean }
export function timeSaid(m: string): TimeSaid | null {
  let best: TimeSaid | null = null;
  for (const re of TIME_FORMS) {
    const x = re.exec(m);
    if (!x) continue;
    const a = x.slice(2).find((g) => g && /^[ap]\.?m\.?$/.test(g)) ?? null;
    const dp = x.slice(2).find((g) => g && /^(morning|evening|afternoon|night|tonight)$/.test(g)) ?? null;
    const mm = x.slice(2).find((g) => g && /^\d\d$/.test(g));
    const t: TimeSaid = { h: Number(x[1]), minute: mm && Number(mm) < 60 ? Number(mm) : 0, ampm: a ? (a.startsWith("p") ? "pm" : "am") : null,
      dayPart: dp ? (dp === "morning" ? "morning" : "evening") : null, end: x.index + x[0].length };
    return t;
  }
  const n = /\b(?:at )?(noon|midday|midnight)\b/.exec(m);
  if (n) best = { h: n[1] === "midnight" ? 0 : 12, minute: 0, ampm: null, dayPart: null, end: n.index + n[0].length, ...(n[1] === "midnight" ? { midnight: true } : { noon: true }) };
  return best;
}
// A zone only where it can only be a zone (review of PR #365: "central London" became Chicago, "PT" is also part-time):
// right after a time ("at 6am PT", "6:30 central"), or said as a time zone ("eastern time", "Chicago time", "PST").
const UNAMBIGUOUS = /\b(est|edt|cst|cdt|mst|mdt|pst|pdt)\b|\b(eastern|central|mountain|pacific|new york|chicago|denver) time\b/;
export function zoneSaid(m: string, t: { end: number } | null = timeSaid(m)): string | null {
  if (t) {
    const after = new RegExp(`^ ?(?:${ZONE_WORDS})\\b`).exec(m.slice(t.end));
    if (after) return ZONES[after[0].trim()] ?? null;
  }
  const u = UNAMBIGUOUS.exec(m);
  return u ? ZONES[u[1] ?? u[2]] ?? null : null;
}
function withCadence(prefs: AlertPrefs, c: Cadence | null): AlertPrefs {
  if (!c || c.ask) return prefs; // midnight: asked about, nothing set
  if (!c.digest) return prefs.digest ? { ...prefs, digest: false, max_instant_per_day: DEFAULT_PREFS.max_instant_per_day } : prefs;
  const { weekdays_only: _w, report_minute: _m, ...rest } = prefs;
  const report_minute = c.report_hour !== undefined ? c.report_minute ?? 0 : prefs.report_minute ?? 0;
  return { ...rest, digest: true, max_instant_per_day: 0, report_hour: c.report_hour ?? prefs.report_hour,
    ...(report_minute ? { report_minute } : {}), ...(c.weekdays ?? prefs.weekdays_only ? { weekdays_only: true } : {}) };
}
// What the person is told after a turn that set or changed their daily message (handler-career.ts): the exact hour,
// minute and zone saved, weekdays only when so, and when quiet hours move it, the time it will really arrive. Midnight
// is asked about instead. Null when this turn set no daily schedule.
export function scheduleLine(r: WatchSync): string | null {
  if (!("schedule" in r) || !r.schedule) return null;
  const s = r.schedule;
  const quiet = `${clock(s.quiet_start, 0)} to ${clock(s.quiet_end, 0)}`;
  if (s.ask === "midnight") return `You asked for midnight, which is inside your quiet hours (${quiet}), so I didn't set a time for your daily job message. What time should it come?`;
  if (!s.digest) return null;
  const at = clock(s.hour, s.minute);
  const days = s.weekdays_only ? "every weekday (Monday to Friday)" : "every day";
  const moved = inQuiet(s.hour, s.quiet_start, s.quiet_end) ? ` ${at} is inside your quiet hours (${quiet}), so it will arrive at ${clock(s.quiet_end, 0)} instead.` : "";
  return `Your job matches will come once a day, ${days} at ${at} ${s.tz} time, with no alerts in between.${moved}`;
}
const clock = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const inQuiet = (h: number, a: number, b: number) => a === b ? false : a > b ? h >= a || h < b : h >= a && h < b;
export interface Schedule { digest: boolean; hour: number; minute: number; tz: string; weekdays_only: boolean; quiet_start: number; quiet_end: number; ask?: "midnight" }
const scheduleOf = (row: { tz: string; prefs: AlertPrefs }, c: Cadence | null): Schedule | undefined => c && (c.digest || c.ask)
  ? { digest: !!row.prefs.digest, hour: row.prefs.report_hour, minute: row.prefs.report_minute ?? 0, tz: row.tz, weekdays_only: !!row.prefs.weekdays_only,
    quiet_start: row.prefs.quiet_start, quiet_end: row.prefs.quiet_end, ...(c.ask ? { ask: c.ask } : {}) }
  : undefined;

// The honesty gap (coordinator, re-review of PR #365): the reply states the schedule before the turn commits, and the
// write stays after the commit (a refused save writes no alert settings). When that write fails, the person is told at
// once, in the place they asked (the web thread, or the channel the message came in on), and it is logged. Only when
// this turn meant to write (the preview said saved, off or removed): a turn that changed nothing has nothing to undo.
export const ALERT_SAVE_FAILED_REPLY = "I couldn't save that alert schedule \u2014 nothing changed; say it again to retry.";
export async function alertWriteFailed(o: { error: unknown; preview: WatchSync | null; tell: (text: string) => Promise<void>; log: (line: string) => void }): Promise<boolean> {
  o.log(`career watch alerts: the write after the commit failed: ${String((o.error as Error)?.message ?? o.error).slice(0, 300)}`);
  if (!o.preview || !["saved", "off", "removed"].includes(o.preview.action)) return false;
  try { await o.tell(ALERT_SAVE_FAILED_REPLY); return true; }
  catch (e) { o.log(`career watch alerts: the follow-up was not sent either: ${String((e as Error)?.message ?? e).slice(0, 300)}`); return false; }
}
// One message right after a turn, where the turn came from: the web thread gets an assistant message; a texting channel
// gets a status row on that channel, due now (trainee-deliver sends it on its next run; sms goes to the home channel).
export function supabaseTellAfterTurn(admin: any, w: { userId: string; threadId: string; channel: string; key: string; now: () => number }) {
  return async (text: string) => {
    if (w.channel === "web") {
      const r = await admin.from("agent_messages").insert({ thread_id: w.threadId, role: "assistant", content: text, meta: { career: true, intent: "career_alert_save_failed", key: w.key } });
      if (r.error) throw new Error(`write the follow-up: ${r.error.message}`);
      return;
    }
    const channel = ["imessage", "whatsapp", "telegram"].includes(w.channel) ? w.channel : null;
    const r = await admin.from("career_outbox").insert({ user_id: w.userId, key: `status:${w.key}`, kind: "status", text, deliver_at: new Date(w.now()).toISOString(), channel });
    if (r.error) throw new Error(`queue the follow-up: ${r.error.message}`);
  };
}

// The same decision as syncWatchAlerts with nothing written (re-review of PR #365): the handler reads it BEFORE the reply
// is written, so the reply states the exact schedule the save after the turn's commit writes (that save stays after the
// commit: a refused save writes no alert settings). Same inputs, same code, so the same row.
export function previewWatchAlerts(o: Parameters<typeof syncWatchAlerts>[0]): Promise<WatchSync> {
  const store: AlertStore = { ...o.store, save: async () => {}, ...(o.store.remove ? { remove: async () => {} } : {}) } as AlertStore;
  return syncWatchAlerts({ ...o, store });
}

export async function syncWatchAlerts(o: {
  userId: string; before: Record<string, unknown> | null | undefined; after: Record<string, unknown> | null | undefined;
  erased?: boolean; store: AlertStore; now: number;
  message?: string; // the person's words this turn, for the cadence they said (cadenceFrom)
}): Promise<WatchSync> {
  if (o.erased) {
    if (!o.store.remove) return { action: "refused", reason: "this alert store cannot remove settings" };
    await o.store.remove(o.userId);
    return { action: "removed" };
  }
  const key = WATCH_PROFILE_KEY(o.userId), was = o.before?.[key] ?? null, now = o.after?.[key] ?? null;
  if (!was && !now) return { action: "unchanged" }; // no watch, ever: nothing to agree with (the alerts run removes a stale copy)
  const changed = !same(was, now), prev = await o.store.get(o.userId);
  const interests = interestsFromWatch(now), active = interests.length > 0 && !(now as any)?.opt_out?.global;
  if (!active) {
    if (prev && prev.prefs.on && (prev.prefs.interests?.length || changed)) {
      await o.store.save({ ...prev, prefs: { ...prev.prefs, on: false } });
      return { action: "off" };
    }
    return { action: prev ? "unchanged" : "none" };
  }
  // A cadence is the person's only on the turn that set or changed the watch, or one about their alerts ("send them every
  // evening instead"): "I apply every day" on some later turn is not a request to change how alerts arrive.
  const cadence = changed || /\b(alerts?|jobs?|roles?|matches|internships?|postings?|openings?|send|text|message)\b/i.test(String(o.message ?? "")) ? cadenceFrom(o.message) : null;
  // Compared key-order-free: the row comes back from jsonb with its keys sorted, so the plain string compare never matched,
  // and EVERY turn by a person with a watch re-saved it through startWatching: "watching from now" (postings first seen
  // since the last run were never alerted) and, past the report hour, today's report marked done before it was sent.
  if (prev && prev.prefs.on && canonJson(prev.prefs.interests ?? null) === canonJson(interests)) {
    // The same watches, a new cadence ("make it every evening instead"): only the cadence changes, the counters stay.
    const next = withCadence(prev.prefs, cadence), tz = cadence?.ask ? prev.tz : cadence?.tz ?? prev.tz;
    const schedule = scheduleOf({ tz, prefs: next }, cadence);
    if (canonJson(next) === canonJson(prev.prefs) && tz === prev.tz) return { action: "unchanged", ...(schedule ? { schedule } : {}) };
    await o.store.save({ ...prev, tz, prefs: next });
    return { action: "saved", ...(schedule ? { schedule } : {}) };
  }
  // The table keeps the watches' words in `keywords` (1 to 10) and their places in `locations` (up to 10); the
  // watches themselves decide the match.
  // NO LIMITS (owner, 2026-10-27; Telegram list #7, 2026-10-28): the column is a summary of the watches' words, and the
  // match reads each watch's own terms (prefs.interests). It used to refuse the whole save past 10 distinct terms, so an
  // 11th title term silently turned every watch's alerts off. The summary keeps the first 10; every watch keeps all of its own.
  const keywords = [...new Set(interests.flatMap((i) => i.keywords))].slice(0, 10);
  const v = validPrefs({ keywords, locations: [...new Set(interests.flatMap((i) => i.locations))].slice(0, 10) }, prev?.prefs ?? DEFAULT_PREFS);
  if (!v.ok) return { action: "refused", reason: v.error };
  const row = startWatching(prev, { userId: o.userId, prefs: withCadence({ ...v.prefs, interests }, cadence), tz: (cadence?.ask ? null : cadence?.tz) ?? prev?.tz ?? DEFAULT_TZ, now: o.now });
  await o.store.save(row);
  const schedule = scheduleOf(row, cadence);
  return { action: "saved", ...(schedule ? { schedule } : {}) };
}

// JOB ALERTS AS A REAL OUTCOME (2026-10-31): the person's "less like N" / "more like N" (career_alert_feedback.ts) kept on
// their alert settings, here with every other write of the row (D-032). The same job's opposite rule is replaced, never kept
// beside it; at most 20 of each, the newest kept. Only prefs.feedback changes: the counters and watches stay as they are.
const MAX_SIGNALS = 20;
export async function saveAlertFeedback(store: Pick<AlertStore, "save">, row: AlertRow, kind: "less" | "more", sig: AlertSignal): Promise<void> {
  const fb = row.prefs.feedback ?? {}, other = kind === "less" ? "more" : "less";
  const mine = (fb[kind] ?? []).filter((s) => canonJson(s) !== canonJson(sig));
  const theirs = (fb[other] ?? []).filter((s) => s.company !== sig.company);
  await store.save({ ...row, prefs: { ...row.prefs, feedback: { ...fb, [kind]: [...mine, sig].slice(-MAX_SIGNALS), [other]: theirs } } });
}

// At delivery (channel.ts deliverDue): whether a queued job alert (career_outbox key alert:<job_id>) or report
// (report:<day>) is still the person's to get, from their alert settings now, the watch record behind a row their
// watches made, and the posting. Settings gone or off, the watch record gone, paused or empty, or a posting that no
// longer fits (gone, closed, or a watch stopped since): not sent. Nothing that cannot be shown to fit is sent.
export const isAlertKey = (key: string) => /^(alert|report):/.test(String(key ?? ""));
export function alertStillWanted(key: string, now: { row: Pick<AlertRow, "prefs"> | null; record: unknown; posting?: unknown }): boolean {
  const prefs = prefsNow(now);
  if (!prefs) return false;
  if (String(key).startsWith("alert:")) return !!now.posting && matchPosting(now.posting, prefs);
  return isAlertKey(key);
}
// The person's alert settings as they are now, their watches the record's; null: nothing is wanted (off, gone, paused).
function prefsNow(now: { row: Pick<AlertRow, "prefs"> | null; record: unknown }): AlertPrefs | null {
  const row = now.row;
  if (!row || !row.prefs?.on) return null;
  let prefs = row.prefs;
  if (prefs.interests?.length) {
    const wp: any = now.record ?? null, interests = interestsFromWatch(wp);
    if (!interests.length || wp?.opt_out?.global) return null;
    prefs = { ...prefs, interests };
  }
  return prefs;
}

// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): the words of a queued job alert or daily report as they are true when it goes.
// An alert waits in the outbox (quiet hours, a delivery run behind) while its posting changes: its title ("Data Analyst"
// became "Senior Data Analyst"), its place, its company's name, its link; and its "first seen 3 min ago" grows old. A
// report waits while the person changes their search ("only remote now", another title): its lines were the old search's.
// So at delivery: an alert says its posting as it is now, with its age now; a report keeps the lines whose postings still
// fit the person's search (each said as it is now; a closed one is kept as written, for the delivery to say it closed),
// and says how many those are; nothing of the old search's is said. null: nothing of it is still true for the person (the
// posting gone, or no line of the report still theirs); it is not sent. `postings`: by job id (an alert) or by link (a
// report's lines). The settings and the watch record are read as alertStillWanted reads them.
export function freshAlertText(key: string, text: string, now: { row: Pick<AlertRow, "prefs"> | null; record: unknown; postings: Map<string, any>; at: number }): string | null {
  const prefs = prefsNow(now);
  if (!prefs) return null;
  if (String(key).startsWith("alert:")) {
    const p = now.postings.get(String(key).slice("alert:".length));
    return p && matchPosting(p, prefs) ? alertText(p, now.at) : null;
  }
  if (!String(key).startsWith("report:")) return text;
  const lines = String(text).split("\n");
  if (!/^Your daily job report: \d+ match(es)? in the last day/.test(lines[0] ?? "")) return text; // "no new matches": nothing to check
  const items: { line: string; url: string }[] = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const m = /^ {2}(https:\/\/\S+)$/.exec(lines[i] ?? "");
    if (!m || !lines[i - 1].startsWith("- ")) continue;
    const p = now.postings.get(m[1]);
    if (p && p.closed_at) { items.push({ line: lines[i - 1], url: m[1] }); continue; } // said closed at delivery
    if (p && matchPosting(p, prefs)) { items.push({ line: `- ${postingLine(p)}`, url: m[1] }); continue; }
    dropped++;
  }
  if (!items.length) return null;
  const more = lines.find((l) => /^…and \d+ more\. Ask me for the rest\.$/.test(l));
  // The count said is the lines kept when any were dropped (the ones not listed were the old search's, unseen here).
  const head = dropped
    ? `Your daily job report: ${items.length} match${items.length === 1 ? "" : "es"} in the last day that still fit${items.length === 1 ? "s" : ""} your search.`
    : lines[0];
  return [head, ...items.map((x) => `${x.line}\n  ${x.url}`), ...(more && !dropped ? [more] : [])].join("\n");
}
// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a queued job alert against the person's fit floor and daily cap as they are
// now. An alert waits in the outbox (quiet hours, a delivery run behind) after it is planned; a person who raised their
// fit floor or asked for fewer alerts in that time still got everything planned under the old settings. `fit`: the fit
// the alert was queued with (null: not known, never held back on that account). `sentToday`: alerts already delivered to
// the person today on their own clock.
export function alertWithinLimits(prefs: Pick<AlertPrefs, "min_fit" | "max_instant_per_day"> | null | undefined, fit: number | null, sentToday: number): boolean {
  if (!prefs) return true; // no settings: alertStillWanted holds it
  if (typeof fit === "number" && typeof prefs.min_fit === "number" && fit < prefs.min_fit) return false;
  return sentToday < Math.min(MAX_INSTANT_PER_DAY, Math.floor(Number(prefs.max_instant_per_day) || 0));
}
