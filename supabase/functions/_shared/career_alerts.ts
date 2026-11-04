// Job alerts and the daily report (WO-007): which new postings reach a person right away, which wait for their daily
// report, and when each goes out. Pure planning, no I/O: the scheduled runner (career-proactive) reads postings and
// people, calls planProactive, and hands the results to the conversation store's proactive queue (one per key, ever).
// Every word of an alert or report is written here from the posting's own fields, never by the model.
//   matchPosting   the person's keywords (every word, whole words, in the title), places or remote, open postings only
//   planProactive  instant alerts, freshest first, up to the person's daily cap; the rest held for the report; quiet
//                  hours move an alert to the end of quiet hours in the person's zone; one report per local day at or
//                  after their hour, with the last day's matches and the held ones, or a plain "no new matches"; a
//                  posting published days before it was first seen (a new board's backlog) is never news (freshWhenSeen)
//   WO-037         a weekly cap on top of the daily one: no more than the person's max_per_week (default 15, at most 25)
//                  alerts in any rolling 7 days (sent_this_week, counted from the outbox by the run); past it, held.
//   F7 (fit)       with the person's fit to each posting (career_alert_fit.ts: 121 scoreFit over their confirmed facts,
//                  the watch record's scoring_profile), the day's room goes to the best fits first (fit, then freshest),
//                  and the fit floor holds: a posting their confirmed facts are knocked out of (a license, a clearance,
//                  a degree) is never news, and one under the person's own min_fit (0-100), or with no fit to show for
//                  it when they set one, is never news either. Without fits the order is freshest first, as before.
import { regionDecision } from "./posting_region.ts";
import { freshWhenSeen } from "./career_fresh.ts";
import { type Floor, relevanceFloor, sameCompany } from "./career_floor.ts";

export interface AlertPrefs {
  on: boolean; keywords: string[]; locations: string[]; remote_ok: boolean;
  report_hour: number; quiet_start: number; quiet_end: number; max_instant_per_day: number;
  floor?: Floor; // the person's stated relevance floor (C-04); absent means nothing is hidden
  max_per_week?: number; // WO-037: alerts in any rolling 7 days; absent means WEEKLY_DEFAULT
  min_fit?: number; // F7: the lowest fit score (0-100) the person wants alerted; absent means only knockouts are held back
  // The watches the person set by text (career_watch_alerts.ts), each matched on its own: a posting is news when it
  // fits one watch whole (its role, its places, its floor, its firms), never one watch's role in another's city.
  // Present, these decide the match and `keywords` only lists their words (the table's shape).
  interests?: AlertInterest[];
}
// home (SERIAL-1530): the person's stated location, as they said it, for a posting's stated country or region restriction.
export interface AlertInterest { keywords: string[]; locations: string[]; remote_ok: boolean; floor?: Floor; companies?: string[]; home?: string }
export interface PlanUser {
  id: string; tz: string; prefs: AlertPrefs; last_checked_at: string; instant_sent_today: number;
  last_report_on: string | null; // YYYY-MM-DD in the person's zone
  held?: string[]; // job_ids the daily cap held back
  sent_this_week?: number; // WO-037: alerts queued for delivery in the last 7 days (the run counts them from the outbox)
}
export type Planned =
  | { userId: string; kind: "alert"; key: string; at: number; job_id: string; text: string }
  | { userId: string; kind: "held"; job_id: string }
  | { userId: string; kind: "report"; key: string; at: number; text: string };

// F7: a posting's fit to the person (career_alert_fit.ts), by job_id. Null score: scoreFit could not score it.
export interface AlertFit { score: number | null; excluded: boolean; reasons: string[] }
export type AlertFits = Map<string, Map<string, AlertFit>>; // user id -> job_id -> fit
// The fit floor: a knockout is never news; with min_fit set, a posting is news only when its fit is known and reaches it.
export function fitFloorOk(fit: AlertFit | null | undefined, prefs: Pick<AlertPrefs, "min_fit">): boolean {
  if (fit?.excluded) return false;
  if (prefs.min_fit === undefined || prefs.min_fit === null) return true;
  return !!fit && fit.score !== null && fit.score >= prefs.min_fit;
}
// Best fit first (an unscored posting after every scored one), then freshest.
function byFit(fits: Map<string, AlertFit> | undefined) {
  return (a: any, b: any) => {
    if (fits) {
      const fa = fits.get(a.job_id)?.score ?? -1, fb = fits.get(b.job_id)?.score ?? -1;
      if (fa !== fb) return fb - fa;
    }
    return ms(b.first_seen_at) - ms(a.first_seen_at);
  };
}

export const DEFAULT_PREFS: AlertPrefs = { on: true, keywords: [], locations: [], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 };
export const MAX_INSTANT_PER_DAY = 10, REPORT_LIMIT = 10;
export const WEEKLY_DEFAULT = 15, WEEKLY_MAX = 25;
export const weeklyCap = (p: AlertPrefs) => Math.max(0, Math.min(WEEKLY_MAX, Math.floor(p.max_per_week ?? WEEKLY_DEFAULT)));
const DAY = 86400000;

const words = (s: unknown) => String(s ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
// Postgres hands timestamps back as "+00:00", the feed as "Z": compare instants, never strings.
const ms = (t: unknown) => { const n = Date.parse(String(t ?? "")); return Number.isFinite(n) ? n : NaN; };
// Posting fields are other people's text: one line, bounded, before they go into a message.
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const httpsUrl = (u: unknown) => (/^https:\/\/\S+$/.test(String(u ?? "")) ? String(u) : null);

export function matchPosting(p: any, prefs: AlertPrefs): boolean {
  if (!p || p.closed_at || !httpsUrl(p.url)) return false;
  if (prefs.floor && !relevanceFloor(p, prefs.floor).pass) return false;
  if (prefs.interests?.length) return prefs.interests.some((i) => fits(p, i));
  return fits(p, prefs);
}
// One watch: its role words, its places, its own floor and firms.
function fits(p: any, w: { keywords: string[]; locations: string[]; remote_ok: boolean; floor?: Floor; companies?: string[]; home?: string }): boolean {
  if (w.floor && !relevanceFloor(p, w.floor).pass) return false;
  // A watch for named firms is news from those firms only (the same company rule as the floor's exclusions).
  if (w.companies?.length && !w.companies.some((c) => sameCompany(p.company, c))) return false;
  // A keyword matches when every one of its words is a whole word of the title ("data analyst" matches
  // "Analyst, Data Platform", never "Metadata Analyst" for "data"). No keywords means no alerts, never everything.
  const title = new Set(words(p.title));
  if (!w.keywords.some((k) => { const ws = words(k); return ws.length > 0 && ws.every((x) => title.has(x)); })) return false;
  // SERIAL-1530: the remote preference, the watched places and the posting's stated country or region against the
  // person's stated location, one rule (posting_region.ts); a restriction with no location on record is held, not passed.
  const loc = String(p.location ?? "").toLowerCase();
  const placeOk = () => ({ ok: !w.locations.length || w.locations.some((l) => { const t = String(l).trim().toLowerCase(); return t.length > 0 && loc.includes(t); }) });
  return regionDecision(p, w, placeOk).ok;
}

// PROACTIVE SCENARIOS (2026-10-29): the zone a person's clock is read in. A zone the runtime does not know ("Pacific Time",
// a typo, an empty string: the table checks only its length) or none at all is read as the default zone, the one the table
// and the settings tool start from; it never throws. One person's unknown zone used to throw a RangeError out of the whole
// alerts run (and the digest, cards, questions and asks rails), so nobody got anything that run.
export const DEFAULT_ZONE = "America/New_York";
const zoneOk = new Map<string, boolean>();
export function zoneOr(tz: unknown, fallback = DEFAULT_ZONE): string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return fallback;
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); ok = true; } catch { ok = false; }
    if (zoneOk.size < 1000) zoneOk.set(tz, ok);
  }
  return ok ? tz : fallback;
}
// The person's local date (YYYY-MM-DD) at an instant, in their zone (zoneOr).
export const localDay = (at: number, tz: unknown) => local(at, zoneOr(tz)).date;
// The person's local date, hour and minute at an instant.
function local(at: number, tz: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zoneOr(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "0";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
}
const isQuiet = (hour: number, p: AlertPrefs) =>
  p.quiet_start === p.quiet_end ? false : p.quiet_start > p.quiet_end ? hour >= p.quiet_start || hour < p.quiet_end : hour >= p.quiet_start && hour < p.quiet_end;
// Whether an instant falls in the person's quiet hours, in their zone.
export const quietAt = (at: number, tz: string, p: Pick<AlertPrefs, "quiet_start" | "quiet_end">) => isQuiet(local(at, tz).hour, p as AlertPrefs);
// The first instant at or after `from` outside the person's quiet hours. Steps of 15 minutes, so zones on a half or
// quarter hour (India, Nepal) land on their own hour, and a daylight-saving jump is crossed rather than assumed.
// PROACTIVE SCENARIOS (2026-10-29): it looked for the instant the clock reads quiet_end:00; on the night the clocks spring
// forward over that hour (quiet until 2, New York, March 8) there is no 2:00, and an alert found at 23:00 waited until
// 2:00 the night after, 27 hours late. Now the first quarter hour that is not quiet (3:00 that night).
export function nextAwake(from: number, tz: string, p: Pick<AlertPrefs, "quiet_start" | "quiet_end">): number {
  const start = Math.ceil(from / 900000) * 900000;
  for (let t = start; t < from + 2 * DAY; t += 900000) if (!isQuiet(local(t, tz).hour, p as AlertPrefs)) return t;
  return from;
}
function ago(mins: number) { return mins < 1 ? "under a minute ago" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} hours ago`; }
const line = (p: any) => `${clean(p.title, 120)} at ${clean(p.company, 80)}${p.location ? ` (${clean(p.location, 80)})` : ""}`;

export function planProactive(o: { users: PlanUser[]; postings: any[]; now: number; fits?: AlertFits }): Planned[] {
  const out: Planned[] = [];
  for (const u of o.users) {
    if (!u.prefs || !u.prefs.on) continue;
    const prefs = u.prefs, l = local(o.now, u.tz), since = ms(u.last_checked_at);
    const fits = o.fits?.get(u.id), floorOk = (p: any) => fitFloorOk(fits?.get(p.job_id), prefs);
    // Instant alerts: postings first seen at or after the last check, best fit first (then freshest), up to the cap left
    // today. "At or after": a posting first seen at the very instant of a check would otherwise be skipped forever; the
    // outbox's once-per-key rule keeps the rare re-plan from ever sending twice.
    const fresh = o.postings
      .filter((p) => ms(p.first_seen_at) >= since && freshWhenSeen(p) && matchPosting(p, prefs) && floorOk(p))
      .sort(byFit(fits));
    const dayRoom = Math.min(MAX_INSTANT_PER_DAY, Math.floor(prefs.max_instant_per_day)) - Math.max(0, u.instant_sent_today | 0);
    const weekRoom = weeklyCap(prefs) - Math.max(0, Number(u.sent_this_week ?? 0));
    let room = Math.max(0, Math.min(dayRoom, Number.isFinite(weekRoom) ? weekRoom : 0));
    const at = isQuiet(l.hour, prefs) ? nextAwake(o.now, u.tz, prefs) : o.now;
    for (const p of fresh) {
      if (room <= 0) { out.push({ userId: u.id, kind: "held", job_id: p.job_id }); continue; }
      room--;
      const mins = Math.max(0, Math.floor((o.now - ms(p.first_seen_at)) / 60000));
      out.push({ userId: u.id, kind: "alert", key: `alert:${p.job_id}`, at, job_id: p.job_id,
        text: `New match: ${line(p)}, first seen ${ago(mins)}.\n${httpsUrl(p.url)}` });
    }
    // The daily report: once per local day, at or after the person's hour.
    if (l.hour >= prefs.report_hour && u.last_report_on !== l.date) {
      const held = new Set(u.held || []);
      const day = o.postings
        .filter((p) => matchPosting(p, prefs) && floorOk(p) && ((ms(p.first_seen_at) > o.now - DAY && freshWhenSeen(p)) || held.has(p.job_id)))
        .sort(byFit(fits));
      const text = day.length
        ? [`Your daily job report: ${day.length} match${day.length === 1 ? "" : "es"} in the last day.`,
           ...day.slice(0, REPORT_LIMIT).map((p) => `- ${line(p)}\n  ${httpsUrl(p.url)}`),
           ...(day.length > REPORT_LIMIT ? [`…and ${day.length - REPORT_LIMIT} more. Ask me for the rest.`] : [])].join("\n")
        : "Your daily job report: no new matches in the last day. I'm still watching.";
      // PROACTIVE SCENARIOS (2026-10-29): the report waits out quiet hours like an alert. It went at the run's own time, so
      // a report hour inside quiet hours (report at 23, quiet from 22), or a run that caught up late in the evening, texted
      // the person in the middle of their quiet hours.
      out.push({ userId: u.id, kind: "report", key: `report:${l.date}`, at, text });
    }
  }
  return out;
}
