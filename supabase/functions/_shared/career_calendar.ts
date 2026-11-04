// MASS NETWORKING M5 (2026-10-27): the person's calendar, for scheduling a call a contact asked for.
//   1. Free/busy: Google Calendar (freeBusy, scope calendar.freebusy) or Outlook (Microsoft Graph, M4's outlookFreeBusy),
//      the provider the outreach went from. Nothing else of the calendar is read: no titles, no attendees, no notes.
//   2. Slots: three times that are free on the person's calendar and inside working hours in BOTH time zones, computed with
//      the zones' real offsets on each day (a daylight-saving change between two slots moves the overlap; see the tests).
//   3. An event: created only from a payload the person approved (its SHA-256), at most once per thread (the database's
//      unique index), with a Google Meet or Teams link where the provider gives one. Google: the event id is derived from
//      the action id, so a retry after a lost answer finds the event instead of making a second one. Outlook: Graph's
//      transactionId does the same.
// No grant, no scope, or a provider not wired: NOT_WIRED, plainly; nothing is guessed.
export const CALENDAR_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// The Google scopes this lane needs on the career grant (gmail-oauth/career.ts CAREER_SCOPES already lists both; the
// consent URL asks for them only once the owner lists them in GOOGLE_APPROVED_EXTRA_SCOPES, per PR #196).
export const CALENDAR_SCOPES = [CALENDAR_FREEBUSY_SCOPE, CALENDAR_EVENTS_SCOPE];
const GCAL = "https://www.googleapis.com/calendar/v3";

export interface Busy { start: string; end: string }
export type FreeBusy = { status: "ok"; busy: Busy[] } | { status: "NOT_WIRED"; reason: string } | { status: "ERROR"; detail: string } | { status: "RATE_LIMITED"; detail: string };
export interface EventSpec {
  title: string; description: string; start: string; end: string; tz: string;
  attendees: string[]; conference: "meet" | "teams" | "none"; idempotency: string;
}
export type EventResult = { status: "ok"; id: string; link: string | null; html: string | null } | { status: "NOT_WIRED"; reason: string } | { status: "ERROR"; detail: string } | { status: "RATE_LIMITED"; detail: string };
export interface CalendarProvider {
  freeBusy(userId: string, startIso: string, endIso: string, tz: string): Promise<FreeBusy>;
  createEvent(userId: string, ev: EventSpec): Promise<EventResult>;
}

// ------------------------------------------------------------------------------------------------ Google Calendar
export interface GoogleCalDeps { fetch: typeof fetch; token: (userId: string, scope: string) => Promise<string | null> }
// Google's event id: base32hex (a-v, 0-9), 5 to 1024 characters. Derived from the action id, so it is the same on a retry.
export function googleEventId(seed: string): string {
  const hex = seed.toLowerCase().replace(/[^0-9a-f]/g, "");
  return `trainee${hex}`.replace(/[^a-v0-9]/g, "0").slice(0, 64);
}
export function googleCalendar(d: GoogleCalDeps): CalendarProvider {
  const limited = async (r: Response) => r.status === 429 || (r.status === 403 && /rateLimit|quota/i.test(await r.clone().text()));
  const linkOf = (j: any) => j?.hangoutLink ?? (Array.isArray(j?.conferenceData?.entryPoints) ? j.conferenceData.entryPoints.find((e: any) => e?.entryPointType === "video")?.uri : null) ?? null;
  return {
    async freeBusy(userId, startIso, endIso, tz) {
      const token = await d.token(userId, CALENDAR_FREEBUSY_SCOPE);
      if (!token) return { status: "NOT_WIRED", reason: "no Google Calendar access on your connected Google account" };
      const r = await d.fetch(`${GCAL}/freeBusy`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ timeMin: startIso, timeMax: endIso, timeZone: tz, items: [{ id: "primary" }] }) });
      if (await limited(r)) return { status: "RATE_LIMITED", detail: `HTTP ${r.status}` };
      if (r.status === 401 || r.status === 403) return { status: "NOT_WIRED", reason: `Google refused calendar access (HTTP ${r.status})` };
      if (!r.ok) return { status: "ERROR", detail: `free/busy: HTTP ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      const cal = j?.calendars?.primary;
      if (!cal || (Array.isArray(cal.errors) && cal.errors.length)) return { status: "ERROR", detail: "free/busy: the calendar could not be read" };
      return { status: "ok", busy: (Array.isArray(cal.busy) ? cal.busy : []).map((b: any) => ({ start: String(b.start), end: String(b.end) })) };
    },
    async createEvent(userId, ev) {
      const token = await d.token(userId, CALENDAR_EVENTS_SCOPE);
      if (!token) return { status: "NOT_WIRED", reason: "no Google Calendar access on your connected Google account" };
      const id = googleEventId(ev.idempotency);
      const body: any = { id, summary: ev.title, description: ev.description, start: { dateTime: ev.start, timeZone: ev.tz }, end: { dateTime: ev.end, timeZone: ev.tz },
        attendees: ev.attendees.map((email) => ({ email })) };
      if (ev.conference === "meet") body.conferenceData = { createRequest: { requestId: ev.idempotency, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      const r = await d.fetch(`${GCAL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 409) { // made before (a retry after a lost answer): read it back, never make a second one
        const g = await d.fetch(`${GCAL}/calendars/primary/events/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!g.ok) return { status: "ERROR", detail: `event exists but could not be read: HTTP ${g.status}` };
        const j: any = await g.json().catch(() => ({}));
        return { status: "ok", id, link: linkOf(j), html: j?.htmlLink ?? null };
      }
      if (await limited(r)) return { status: "RATE_LIMITED", detail: `HTTP ${r.status}` };
      if (r.status === 401 || r.status === 403) return { status: "NOT_WIRED", reason: `Google refused calendar access (HTTP ${r.status})` };
      if (!r.ok) return { status: "ERROR", detail: `create event: HTTP ${r.status}` };
      const j: any = await r.json().catch(() => ({}));
      return { status: "ok", id: String(j?.id ?? id), link: linkOf(j), html: j?.htmlLink ?? null };
    },
  };
}

// ------------------------------------------------------------------------------------------------ Outlook (M4's port)
// The functions M4's Outlook connector (feat/outlook-connector-20261027) exposes. Until they are passed in, Outlook
// calendars are NOT_WIRED and the reply says so.
export interface OutlookCalendarPort {
  outlookFreeBusy(userId: string, startIso: string, endIso: string, tz: string): Promise<FreeBusy>;
  outlookCreateEvent(userId: string, ev: { subject: string; body: string; start: string; end: string; tz: string; attendees: string[]; online: boolean; transactionId: string }): Promise<EventResult>;
}
export function outlookCalendar(port: OutlookCalendarPort | null): CalendarProvider {
  const nw = { status: "NOT_WIRED" as const, reason: "Outlook calendar is not connected in Trainee yet" };
  return {
    freeBusy: (u, s, e, tz) => (port ? port.outlookFreeBusy(u, s, e, tz) : Promise.resolve(nw)),
    createEvent: (u, ev) => (port ? port.outlookCreateEvent(u, { subject: ev.title, body: ev.description, start: ev.start, end: ev.end, tz: ev.tz, attendees: ev.attendees, online: ev.conference === "teams", transactionId: ev.idempotency }) : Promise.resolve(nw)),
  };
}

// ------------------------------------------------------------------------------------------------ time zones
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function validZone(tz: unknown): string | null {
  const s = String(tz ?? "");
  if (!s || s.length > 64 || (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(s) && s !== "UTC")) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return null; }
}
export function wall(ms: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), wd: WD.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}
// The instant a wall-clock time in a zone names (the first valid minute after a skipped hour).
export function instantOf(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 4; i++) {
    const w = wall(t, tz), seen = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    if (seen === want) return t;
    t += want - seen;
  }
  return t;
}
const ZONE_NAMES: [RegExp, string][] = [
  [/\b(?:eastern|est|edt|new york|nyc|boston|atlanta|miami|philadelphia|dc)\b/, "America/New_York"],
  [/\b(?:central|cst|cdt|chicago|dallas|houston|austin)\b/, "America/Chicago"],
  [/\b(?:mountain|mst|mdt|denver)\b/, "America/Denver"],
  [/\b(?:arizona|phoenix)\b/, "America/Phoenix"],
  [/\b(?:pacific|pst|pdt|los angeles|san francisco|seattle|bay area)\b/, "America/Los_Angeles"],
  [/\b(?:london|uk|gmt|bst)\b/, "Europe/London"],
  [/\butc\b/, "UTC"],
];
// A zone the person names ("central", "I'm in Chicago", "America/Chicago"), or null.
export function zoneNamed(text: string): string | null {
  const raw = String(text ?? "");
  const iana = /\b([A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?)\b/.exec(raw);
  if (iana && validZone(iana[1])) return iana[1];
  const t = raw.toLowerCase();
  for (const [rx, tz] of ZONE_NAMES) if (rx.test(t)) return tz;
  return null;
}
export function fmtIn(ms: number, tz: string, withDay = true): string {
  const o: Intl.DateTimeFormatOptions = { timeZone: tz, hour: "numeric", minute: "2-digit", ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}) };
  return new Intl.DateTimeFormat("en-US", o).format(new Date(ms));
}
export function zoneShort(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName");
  return p?.value ?? tz;
}

// ------------------------------------------------------------------------------------------------ slots
export interface Slot { start: string; end: string; person: string; contact: string; theirs: boolean }
export interface SlotAsk {
  busy: Busy[]; now: number; personTz: string; contactTz: string | null; minutes?: number; count?: number; days?: number;
  theirTimes?: string[]; workStart?: number; workEnd?: number; leadMs?: number;
}
const overlaps = (a0: number, a1: number, busy: { s: number; e: number }[]) => busy.some((b) => a0 < b.e && b.s < a1);
// Inside working hours on a weekday, in this zone, for the whole slot.
function inHours(s: number, e: number, tz: string, from: number, to: number): boolean {
  const a = wall(s, tz), b = wall(e - 1, tz);
  if (a.wd === 0 || a.wd === 6 || a.y !== b.y || a.m !== b.m || a.d !== b.d) return false;
  const start = a.h * 60 + a.min, end = b.h * 60 + b.min + 1;
  return start >= from * 60 && end <= to * 60;
}
export function slotLabel(s: number, e: number, personTz: string, contactTz: string | null): { person: string; contact: string } {
  const person = `${fmtIn(s, personTz)}–${fmtIn(e, personTz, false)} ${zoneShort(s, personTz)}`;
  const ct = contactTz ?? personTz;
  const contact = `${fmtIn(s, ct)}–${fmtIn(e, ct, false)} ${zoneShort(s, ct)}`;
  return { person, contact };
}
// Three (or `count`) free slots: their own proposed times first when free and in the person's hours, then one a day across
// the next working days, inside working hours in both zones, never overlapping anything busy.
export function proposeSlots(a: SlotAsk): Slot[] {
  const minutes = a.minutes ?? 30, count = a.count ?? 3, days = a.days ?? 14, from = a.workStart ?? 9, to = a.workEnd ?? 17;
  const lead = a.leadMs ?? 12 * 3600_000, ct = a.contactTz ?? null;
  const busy = a.busy.map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) })).filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e));
  const out: Slot[] = [];
  const take = (s: number, theirs: boolean) => {
    const e = s + minutes * 60_000;
    if (out.some((x) => Date.parse(x.start) === s)) return;
    const l = slotLabel(s, e, a.personTz, ct);
    out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), person: l.person, contact: l.contact, theirs });
  };
  for (const t of a.theirTimes ?? []) {
    const s = Date.parse(t);
    if (out.length >= count || !Number.isFinite(s) || s < a.now + 3600_000) continue;
    if (!overlaps(s, s + minutes * 60_000, busy) && inHours(s, s + minutes * 60_000, a.personTz, from, to)) take(s, true);
  }
  const today = wall(a.now, a.personTz);
  for (let k = 0; k < days && out.length < count; k++) {
    const x = new Date(Date.UTC(today.y, today.m - 1, today.d + k));
    const [y, m, d] = [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
    for (let mins = from * 60; mins + minutes <= to * 60; mins += 30) {
      const s = instantOf(y, m, d, Math.floor(mins / 60), mins % 60, a.personTz), e = s + minutes * 60_000;
      if (s < a.now + lead) continue;
      if (!inHours(s, e, a.personTz, from, to)) continue;
      if (ct && !inHours(s, e, ct, from, to)) continue;
      if (overlaps(s, e, busy)) continue;
      if (out.some((o) => wall(Date.parse(o.start), a.personTz).d === d)) break; // one a day, so the choice is spread
      take(s, false);
      break;
    }
  }
  return out.slice(0, count);
}
// Is [s, e) free on this busy list?
export const isFree = (busy: Busy[], s: number, e: number) => !overlaps(s, e, busy.map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) })));
