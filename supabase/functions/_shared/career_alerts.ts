// Job alerts and the daily report (WO-007): which new postings reach a person right away, which wait for their daily
// report, and when each goes out. Pure planning, no I/O: the scheduled runner (career-proactive) reads postings and
// people, calls planProactive, and hands the results to the conversation store's proactive queue (one per key, ever).
// Every word of an alert or report is written here from the posting's own fields, never by the model.
//   matchPosting   the person's keywords (every word, whole words, in the title), places or remote, open postings only
//   planProactive  instant alerts, freshest first, up to the person's daily cap; the rest held for the report; quiet
//                  hours move an alert to the end of quiet hours in the person's zone; one report per local day at or
//                  after their hour, with the last day's matches and the held ones, or a plain "no new matches"; a
//                  posting published days before it was first seen (a new board's backlog) is never news (freshWhenSeen)
//   no weekly cap (owner rule "no limits"): alerts are paced per day (max_instant_per_day) never by a count per week, in the planner or in the database (career_alert_enqueue, 20261030180000). max_per_week / sent_this_week are accepted and ignored.
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
  max_per_week?: number; // ignored: there is no weekly cap
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
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): the jobs (twinKeys) of alerts already queued for the person: the same job
  // seen again on another board is not news.
  alerted_twins?: string[];
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
export const WEEKLY_MAX = 25; // only the bound the settings validator still accepts for the ignored max_per_week
const DAY = 86400000;

// PROACTIVE SCENARIOS ROUND 2 (2026-10-30): what a phone does not show is not part of a posting's words. Zero-width and
// direction characters are dropped before a title is matched or quoted: "Data​Analyst" reads "DataAnalyst", and a
// right-to-left override (U+202E) in a title turned "gnp.exe" into "exe.png" on the person's screen inside an alert.
const FORMAT_CHARS = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const words = (s: unknown) => String(s ?? "").replace(FORMAT_CHARS, "").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
// Postgres hands timestamps back as "+00:00", the feed as "Z": compare instants, never strings.
const ms = (t: unknown) => { const n = Date.parse(String(t ?? "")); return Number.isFinite(n) ? n : NaN; };
// Posting fields are other people's text: one line, bounded, before they go into a message. PROACTIVE SCENARIOS ROUND 2
// (2026-10-30): and only their visible words. A board's markup ("<b>Data Analyst</b> <a href=...>apply</a>", a <script>,
// an <img onerror=...>) went into the alert and the daily report as written, and the dashboard's feed reads the same rows;
// invisible direction and control characters went in too. Markup is dropped (a script or style element with its content),
// invisible characters are dropped, control characters read as spaces.
// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): a field longer than its room is cut between whole characters and says it was
// cut. It was cut at a UTF-16 unit: an emoji at the edge ("Tailspin 🦄🦄…") left half a character (a lone surrogate) in the
// alert, and a long company name cut mid-word ("Bank of America Merrill Lync") read as a name the posting never had.
const GRAPHEMES = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function clipWhole(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  for (const g of GRAPHEMES ? Array.from(GRAPHEMES.segment(s), (x) => x.segment) : [...s]) { if (out.length + g.length > n - 1) break; out += g; }
  return `${out.trim()}…`;
}
export function postingText(s: unknown, n: number): string {
  return clipWhole(String(s ?? "")
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*\/?\s*[a-z][^>]*>/gi, " ")
    .replace(FORMAT_CHARS, "").replace(CONTROL_CHARS, " ").replace(LONE_SURROGATE, "")
    .replace(/\s+/g, " ").trim(), n);
}
const clean = postingText;
// The same job on two boards (a company that posts on Greenhouse and on Lever, each with its own id and sometimes its own
// pay): one job to the person. Its board (provider:board, from the job id) and its company, title and place as the person
// would read them. Two postings alike on ONE board are two openings (two requisitions), never twins.
// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): as the person would read them, not as each board spells them. An aggregator
// that carries the employer's own posting writes "Acme, Inc." for "Acme" and "New York, NY, United States" for "New York,
// NY", and the person got the same job twice. A company's legal form and a trailing "United States" are not part of the
// name or the place; and the same title behind the same link (a board that carries another board's posting) is the same job.
const LEGAL = /(^| )(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|the|plc|gmbh|ag|bv|pbc)(?= |$)/gu;
const norm = (x: unknown) => clean(x, 200).toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
const companyKey = (x: unknown) => { const n = norm(x), k = n.replace(LEGAL, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim(); return k || n; };
const placeKey = (x: unknown) => norm(x).replace(/( (united states( of america)?|usa|us))+$/u, "").trim();
const linkKey = (u: unknown) => {
  try { const x = new URL(String(u ?? "")); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`; } catch { return ""; }
};
const sourceKey = (p: any) => String(p?.job_id ?? "").split(":").slice(0, 2).join(":");
export const twinKey = (p: any) => `${sourceKey(p)}|${[companyKey(p?.company), norm(p?.title), placeKey(p?.location)].join("|")}`;
// Every name a posting goes by as one job: its company, title and place; and its title behind its link.
export const twinKeys = (p: any): string[] => {
  const link = linkKey(p?.url);
  return [twinKey(p), ...(link ? [`${sourceKey(p)}|link|${norm(p?.title)}|${link}`] : [])];
};
const sourceOf = (k: string) => k.slice(0, k.indexOf("|"));
const jobOf = (k: string) => k.slice(k.indexOf("|") + 1);
// Whether a posting (its twinKeys) is the same job as one already taken from another board.
function twinOf(taken: Map<string, Set<string>>, ks: string[]): boolean {
  return ks.some((k) => { const from = taken.get(jobOf(k)); return !!from && [...from].some((s) => s !== sourceOf(k)); });
}
// The keys of a posting, worked out once per posting object.
const keyMemo = new WeakMap<object, string[]>();
const keysOf = (p: any): string[] => {
  if (!p || typeof p !== "object") return twinKeys(p);
  let k = keyMemo.get(p);
  if (!k) { k = twinKeys(p); keyMemo.set(p, k); }
  return k;
};
// The postings by each job name they go by.
function twinIndex(postings: any[]): Map<string, any[]> {
  const idx = new Map<string, any[]>();
  for (const p of postings) for (const k of keysOf(p)) { const j = jobOf(k); const l = idx.get(j); if (l) l.push(p); else idx.set(j, [p]); }
  return idx;
}
// These keys and the keys of every posting that is the same job, through other boards, one after another: a posting on
// another board than the key's under the same name is the same job, and so is every posting under its other names.
function closeTwins(keys: string[], idx: Map<string, any[]>): string[] {
  const out = new Set(keys), todo = [...keys], seen = new Set<any>();
  while (todo.length) {
    const k = todo.pop()!;
    for (const q of idx.get(jobOf(k)) ?? []) {
      if (seen.has(q)) continue;
      const qk = keysOf(q);
      if (sourceOf(qk[0]) === sourceOf(k)) continue; // two openings on one board are two jobs
      seen.add(q);
      for (const x of qk) if (!out.has(x)) { out.add(x); todo.push(x); }
    }
  }
  return [...out];
}
function take(taken: Map<string, Set<string>>, ks: string[]) {
  for (const k of ks) {
    if (!taken.has(jobOf(k))) taken.set(jobOf(k), new Set());
    taken.get(jobOf(k))!.add(sourceOf(k));
  }
}
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
// The first instant of the person's local day (on the minute; a day that starts inside a daylight-saving jump starts at
// its first minute that exists).
export function localDayStart(at: number, tz: unknown): number {
  const zone = zoneOr(tz), day = local(at, zone).date;
  let t = Math.floor(at / 60000) * 60000;
  const l = local(t, zone);
  t -= (l.hour * 60 + l.minute) * 60000;
  // a daylight-saving change between midnight and `at` leaves t an hour off: step to the day's first minute
  while (local(t, zone).date === day && local(t - 60000, zone).date === day) t -= 15 * 60000;
  while (local(t, zone).date !== day) t += 60000;
  return t;
}
// The person's local date, hour and minute at an instant.
// One formatter per zone, kept (2026-10-30): building an Intl.DateTimeFormat is the expensive part (ICU loads the zone's
// rules), and nextAwake asks the clock up to ~100 times per person per run; the answer is the same either way.
const localFmt = new Map<string, Intl.DateTimeFormat>();
function local(at: number, tz: string): { date: string; hour: number; minute: number } {
  const zone = zoneOr(tz);
  let fmt = localFmt.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (localFmt.size < 1000) localFmt.set(zone, fmt);
  }
  const parts = fmt.formatToParts(new Date(at));
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
// One posting as an alert or a report line says it: its own title, company and place, nothing else.
export const postingLine = (p: any) => `${clean(p.title, 120)} at ${clean(p.company, 80)}${clean(p.location, 80) ? ` (${clean(p.location, 80)})` : ""}`;
const line = postingLine;
// A job alert's words, from the posting as it is at `now`. PROACTIVE SCENARIOS ROUND 3 (2026-11-01): delivery writes them
// again from the posting as it is then (channel.ts deliverDue, the store's freshText): an alert found at 23:00 and held for
// quiet hours said "first seen under a minute ago" at 7:00, and one whose posting changed its title or place while it
// waited said the old one.
export function alertText(p: any, now: number): string {
  const mins = Math.max(0, Math.floor((now - ms(p.first_seen_at)) / 60000));
  return `New match: ${line(p)}, first seen ${ago(Number.isFinite(mins) ? mins : 0)}.\n${httpsUrl(p.url)}`;
}

export function planProactive(o: { users: PlanUser[]; postings: any[]; now: number; fits?: AlertFits }): Planned[] {
  const out: Planned[] = [];
  const idx = twinIndex(o.postings);
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
    let room = Math.max(0, dayRoom);
    const at = isQuiet(l.hour, prefs) ? nextAwake(o.now, u.tz, prefs) : o.now;
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): one alert per job. The same job on two boards (its own id on each, other
    // pay) was two alerts, and took two of the day's places.
    // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): one job is every posting that is the same job as another, one board after
    // another (the employer's board, an aggregator that copies its link under another name, a third that copies its words),
    // and the copy said is the job's first among the news (the employer's own, not the aggregator's that came a minute
    // later), so a later copy is known by the one alerted.
    const twins = new Map<string, Set<string>>();
    take(twins, closeTwins(u.alerted_twins ?? [], idx));
    for (const p0 of fresh) {
      if (twinOf(twins, keysOf(p0))) continue;
      const job = closeTwins(keysOf(p0), idx), mine = new Set(job);
      const p = fresh.filter((q) => keysOf(q).every((k) => mine.has(k))).sort((a, b) => ms(a.first_seen_at) - ms(b.first_seen_at) || String(a.job_id).localeCompare(String(b.job_id)))[0] ?? p0;
      take(twins, job);
      if (room <= 0) { out.push({ userId: u.id, kind: "held", job_id: p.job_id }); continue; }
      room--;
      out.push({ userId: u.id, kind: "alert", key: `alert:${p.job_id}`, at, job_id: p.job_id, text: alertText(p, o.now) });
    }
    // The daily report: once per local day, at or after the person's hour.
    if (l.hour >= prefs.report_hour && u.last_report_on !== l.date) {
      const held = new Set(u.held || []);
      const listed = new Map<string, Set<string>>();
      const day = o.postings
        .filter((p) => matchPosting(p, prefs) && floorOk(p) && ((ms(p.first_seen_at) > o.now - DAY && freshWhenSeen(p)) || held.has(p.job_id)))
        .sort(byFit(fits))
        .filter((p) => { if (twinOf(listed, keysOf(p))) return false; take(listed, closeTwins(keysOf(p), idx)); return true; });
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
