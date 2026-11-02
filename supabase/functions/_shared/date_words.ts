// Deadlines said exactly (reqs Q588, Q589, Q590): the weekday, the date, and for a moment the time and its zone, in the person's
// own zone. Never "soon", never a relative word, never the UTC calendar day of a moment.
//
// Two kinds of deadline reach Trainee:
//   - a calendar day ("2026-11-06", or midnight UTC as a date-only source stores it): the day itself, in every zone. It is open
//     until that day has ended everywhere ("anywhere on earth", UTC-12), so a posting is never refused while the employer's own
//     day is still running; the employer's form has the last word after that.
//   - a moment ("2026-11-06T23:59:00-05:00"): said in the person's zone with the zone named ("11:59 PM CST"); with no zone known
//     it is Chicago's, and the words say so. It has passed when that moment has.
// Pure: no I/O, no clock of its own (the caller passes `now`).
export const FALLBACK_ZONE = "America/Chicago";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00))?$/;
const AOE_MS = 12 * 3600_000; // UTC-12: the last place a calendar day ends
const zoneOk = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

export interface Deadline { dateOnly: boolean; endsAt: number; ymd?: [number, number, number] }
// The deadline a stored value means, or null when it is not a date.
export function deadlineOf(raw: string | null | undefined): Deadline | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const d = DATE_ONLY.exec(s);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const start = Date.UTC(y, m - 1, day);
    const back = new Date(start);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) return null; // "2026-02-31"
    return { dateOnly: true, endsAt: start + 86_400_000 + AOE_MS, ymd: [y, m, day] };
  }
  // A moment must say its own offset or Z: a bare local time names no zone, so it is not read as anyone's.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { dateOnly: false, endsAt: t };
}

// Passed once the clock is past it: a deadline of exactly now is still open (as the posting screen has always read it).
export const deadlinePassed = (raw: string | null | undefined, now: number): boolean => { const d = deadlineOf(raw); return !!d && now > d.endsAt; };

// "Friday, Nov 6" (a calendar day), "Friday, Nov 6, 11:59 PM CST" (a moment, in the person's zone), "Friday, Nov 6, 11:59 PM CST
// (Chicago time)" when the person's zone is not known. The year is added when it is not the year it is now (in that zone).
export function deadlineWords(raw: string | null | undefined, now: number, tz?: string | null): string | null {
  const d = deadlineOf(raw);
  if (!d) return null;
  if (d.dateOnly) {
    const [y, m, day] = d.ymd!;
    const at = new Date(Date.UTC(y, m - 1, day, 12));
    const thisYear = new Date(now).getUTCFullYear();
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", ...(y !== thisYear ? { year: "numeric" } : {}) }).format(at);
  }
  const known = zoneOk(tz), zone = known ? tz as string : FALLBACK_ZONE;
  const yearIn = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(new Date(t));
  const sameYear = yearIn(d.endsAt) === yearIn(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(new Date(d.endsAt));
  const v = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const day = `${v("weekday")}, ${v("month")} ${v("day")}${sameYear ? "" : `, ${v("year")}`}`;
  return `${day}, ${v("hour")}:${v("minute")} ${v("dayPeriod")} ${v("timeZoneName")}${known ? "" : " (Chicago time)"}`;
}
