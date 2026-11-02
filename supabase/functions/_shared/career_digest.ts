// WO-034: the weekly digest, as pure functions. Once a week, at the person's day and hour (default Sunday 6 pm in their
// zone), one plain text built only from their rows: applications sent this week by source, confirmations, status changes
// from mail (and the ones they told Trainee), interviews coming up, drafts waiting for them to send, job alerts sent, and
// one line on the response rate with its counts. Nothing is estimated and no row means no line about it. Every link is
// bare on its own line; the text stays under 1,500 characters, and a list that does not fit says how many are left and
// offers the rest. The run (career_proactive_run.ts runDigest) keys it digest:<ISO week>, so it is said once a week.
import { foldEvents, mergeApps, type StatusEvent, type TrackedApp } from "./career_mail.ts";
import { appsFromQueue, appsFromTracker } from "./career_mail_store.ts";
import type { InterviewRow } from "./career_invite.ts";

export interface DigestPrefs { on: boolean; day: number; hour: number } // day: 0 Sunday .. 6 Saturday, in the person's zone
export const DEFAULT_DIGEST: DigestPrefs = { on: true, day: 0, hour: 18 };
export const DIGEST_LIMIT = 1500;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY = 86400000, WEEK = 7 * DAY;

// The person's words for a day ("sunday", "Sun", "weekends" is not one) and an hour, checked the way the table checks them.
export function validDigest(input: Record<string, unknown>, base: DigestPrefs = DEFAULT_DIGEST): { ok: true; prefs: DigestPrefs } | { ok: false; error: string } {
  const out = { ...base };
  if (input.on !== undefined) {
    if (typeof input.on !== "boolean") return { ok: false, error: "on must be true or false" };
    out.on = input.on;
  }
  if (input.day !== undefined) {
    const d = String(input.day).trim().toLowerCase().slice(0, 3);
    const i = DAY_NAMES.findIndex((n) => n.toLowerCase().startsWith(d));
    if (d.length < 3 || i < 0) return { ok: false, error: "day must be a day of the week, e.g. Sunday" };
    out.day = i;
  }
  if (input.hour !== undefined) {
    if (!Number.isInteger(input.hour) || (input.hour as number) < 0 || (input.hour as number) > 23) return { ok: false, error: "hour must be a whole hour from 0 to 23" };
    out.hour = input.hour as number;
  }
  return { ok: true, prefs: out };
}

// The person's local date, weekday and hour at an instant.
export function localAt(at: number, tz: string): { date: string; weekday: number; hour: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")), hour: Number(g("hour")) % 24 };
}
// ISO week of a calendar day ("2026-W43"): the key that makes the digest once a week.
export function isoWeek(date: string): string {
  const t = new Date(`${date}T00:00:00Z`), dow = (t.getUTCDay() + 6) % 7;
  const thu = new Date(t.getTime() + (3 - dow) * DAY), y = thu.getUTCFullYear();
  const week = 1 + Math.floor((thu.getTime() - Date.UTC(y, 0, 1)) / WEEK);
  return `${y}-W${String(week).padStart(2, "0")}`;
}
// Due: on the person's day, at or after their hour (a missed run catches up the same day, never the next).
export function digestDue(prefs: DigestPrefs, now: number, tz: string): { due: boolean; week: string } {
  const l = localAt(now, tz);
  return { due: prefs.on && l.weekday === prefs.day && l.hour >= prefs.hour, week: isoWeek(l.date) };
}

// ------------------------------------------------------------------------------------------------ the rows
export interface DigestRows {
  queue: any[]; // career_apply_jobs: id, company, url, state, title, created_at, updated_at
  tracker: any[]; // the tracker rows the person keeps by text
  mail: StatusEvent[]; // career_mail_events
  interviews: InterviewRow[]; // career_interviews
  drafts: { key: string; kind: string; company: string; role: string | null; state: string; created_at: string }[]; // career_mail_drafts
  alerts: { created_at: string }[]; // career_outbox rows of kind alert in the week
  events: { at: string; kind: string; subject: string; detail: Record<string, unknown> }[]; // career_events in the week
}

// PROACTIVE SCENARIOS ROUND 3 (2026-11-01): cut between whole characters (an emoji at the edge left half of one).
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); if (t.length <= n) return t; let out = ""; for (const ch of t) { if (out.length + ch.length > n - 3) break; out += ch; } return `${out}...`; };
const httpsUrl = (u: unknown) => (/^https:\/\/\S+$/.test(String(u ?? "")) ? String(u) : null);
const ms = (t: unknown) => { const n = Date.parse(String(t ?? "")); return Number.isFinite(n) ? n : NaN; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const WENT = new Set(["confirmed", "submitted_unconfirmed", "unknown_outcome"]);
const REPLIES = new Set(["rejection", "interview", "assessment", "offer", "recruiter_reply"]);
// The board an application went through, from its own link.
function board(url: unknown): string {
  const h = (() => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; } })();
  for (const [re, name] of [[/greenhouse/, "Greenhouse"], [/lever\.co$/, "Lever"], [/ashbyhq/, "Ashby"], [/smartrecruiters/, "SmartRecruiters"], [/workday/, "Workday"], [/workable/, "Workable"]] as [RegExp, string][]) if (re.test(h)) return name;
  return "other sites";
}
function dayIn(at: number, tz: string, weekday = false): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", ...(weekday ? { weekday: "short" } : {}) });
}
const time12 = (time: string) => { const [h, m] = time.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

export interface Digest { text: string; counts: Record<string, number> }
// null: nothing on file at all, so there is nothing to say.
export function buildDigest(rows: DigestRows, o: { now: number; tz: string }): Digest | null {
  const since = o.now - WEEK, inWeek = (t: unknown) => { const x = ms(t); return x > since && x <= o.now; };
  const apps: TrackedApp[] = foldEvents(mergeApps(appsFromQueue(rows.queue), appsFromTracker(rows.tracker)), rows.mail);
  // Sent this week, by source: Trainee's applications by the board they went through, the ones the person logged, the
  // ones found only in their mail.
  const viaTrainee = rows.queue.filter((r) => WENT.has(r.state) && inWeek(r.updated_at ?? r.created_at));
  const boards = new Map<string, number>();
  for (const r of viaTrainee) boards.set(board(r.url), (boards.get(board(r.url)) ?? 0) + 1);
  const logged = apps.filter((a) => a.source === "tracker" && inWeek(a.applied_at)).length;
  const fromMail = new Set(rows.mail.filter((e) => e.ref.startsWith("mail:") && e.kind === "received" && inWeek(e.at)).map((e) => e.ref)).size;
  const sent = viaTrainee.length + logged + fromMail;
  const sources = [
    viaTrainee.length ? `through Trainee ${viaTrainee.length}: ${[...boards].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}` : "",
    logged ? `you logged ${logged}` : "", fromMail ? `found in your mail ${fromMail}` : "",
  ].filter(Boolean);
  // Confirmations: an employer said it got the application (the apply worker's confirmation, or a confirmation email).
  const confirmed = new Set([
    ...rows.queue.filter((r) => r.state === "confirmed" && inWeek(r.updated_at)).map((r) => `job:${r.id}`),
    ...rows.mail.filter((e) => e.kind === "received" && inWeek(e.at)).map((e) => e.ref),
  ]).size;
  // Status changes: from mail (a stage that moved), and the ones the person reported to Trainee.
  const changes = [
    ...rows.mail.filter((e) => e.stage && e.kind !== "received" && inWeek(e.at)).map((e) => ({ at: ms(e.at), line: `- ${clip(e.company, 60)}${e.role ? ` (${clip(e.role, 50)})` : ""}: ${e.stage}, ${dayIn(ms(e.at), o.tz)} (mail)` })),
    ...rows.events.filter((e) => e.kind === "status_change" && inWeek(e.at)).map((e) => ({ at: ms(e.at), line: `- ${clip(e.subject, 60)}: ${clip(e.detail?.stage ?? "updated", 30)}, ${dayIn(ms(e.at), o.tz)} (you told me)` })),
  ].sort((a, b) => b.at - a.at).map((x) => x.line);
  // Interviews coming up: a stated date from today on, soonest first; an invite this week with no date says so.
  const today = localAt(o.now, o.tz).date;
  const urlOf = (r: InterviewRow) => httpsUrl(apps.find((a) => a.ref === r.ref)?.url);
  // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): an interview a later email cancelled or moved away from is not coming up (it
  // was listed with its old date as if it would happen). The moved one is listed at its new time, from its own invite.
  const live = rows.interviews.filter((r) => !r.cancelled_at && !r.moved_at);
  const upcoming = live.filter((r) => (r.starts_at ? ms(r.starts_at) > o.now : r.date && r.date >= today))
    .sort((a, b) => String(a.starts_at ?? a.date).localeCompare(String(b.starts_at ?? b.date)))
    .map((r) => {
      const when = r.starts_at
        ? new Date(ms(r.starts_at)).toLocaleString("en-US", { timeZone: o.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
        : `${dayIn(Date.parse(`${r.date}T12:00:00Z`), "UTC", true)}${r.time ? `, ${time12(r.time)} (time zone not stated)` : ", time not stated"}`;
      const u = urlOf(r);
      return `- ${clip(r.company ?? "Company not named", 60)}${r.role ? ` (${clip(r.role, 50)})` : ""}: ${when}${u ? `\n${u}` : ""}`;
    });
  const undated = live.filter((r) => !r.date && inWeek(r.seen_at)).map((r) => `- ${clip(r.company ?? "Company not named", 60)}${r.role ? ` (${clip(r.role, 50)})` : ""}: the invite gives no date`);
  const interviews = [...upcoming, ...undated];
  const waiting = rows.drafts.filter((d) => d.state === "drafted" && o.now - ms(d.created_at) <= 30 * DAY)
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))
    .map((d) => `- ${d.kind === "followup" ? "follow-up to" : "thank-you to"} ${clip(d.company, 60)}${d.role ? ` (${clip(d.role, 50)})` : ""}`);
  const alerts = rows.alerts.filter((a) => inWeek(a.created_at)).length;
  // The response rate: every application on file that went, and how many of them heard anything back.
  const total = apps.length, replied = apps.filter((a) => (a.events ?? []).some((e) => REPLIES.has(e.kind))).length;

  if (!total && !rows.interviews.length && !rows.drafts.length && !alerts) return null;
  const rate = total
    ? `Response rate: ${replied} of ${plural(total, "application")} on file ${replied === 1 ? "has" : "have"} had a reply (${Math.round((replied / total) * 100)}%)${total < 10 ? ", too few to read much into" : ""}.`
    : "Response rate: no applications on file yet.";
  const counts = { sent, confirmations: confirmed, status_changes: changes.length, interviews: interviews.length, drafts: waiting.length, alerts, replied, total };
  const list = (head: string, items: string[], n: number) => {
    if (!items.length) return [];
    const shown = items.slice(0, n);
    return [head, ...shown, ...(items.length > shown.length ? [`and ${items.length - shown.length} more; ask me for the rest.`] : [])];
  };
  const compose = (n: number) => [
    `Your weekly job search digest, ${dayIn(since + 1, o.tz)} to ${dayIn(o.now, o.tz)}:`,
    sent ? `Applications sent: ${sent} (${sources.join("; ")}).` : "Applications sent: none this week.",
    `Confirmations: ${confirmed}.`,
    ...(changes.length ? list(`Status changes: ${changes.length}`, changes, n) : ["Status changes: none this week."]),
    ...(interviews.length ? list(`Interviews coming up: ${interviews.length}`, interviews, n) : ["Interviews coming up: none on file."]),
    ...(waiting.length ? list(`Drafts waiting for you to send (Trainee never sends them): ${waiting.length}`, waiting, n) : []),
    `Job alerts sent: ${alerts}.`,
    rate,
    `Text "weekly digest off" to stop these, or tell me another day and time.`,
  ].join("\n");
  let text = compose(5);
  for (const n of [3, 2, 1, 0]) if (text.length > DIGEST_LIMIT) text = compose(n);
  return { text: text.length <= DIGEST_LIMIT ? text : text.slice(0, DIGEST_LIMIT), counts };
}
