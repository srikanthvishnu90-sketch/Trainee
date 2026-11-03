// The checked-at stamp under a results page's title (owner parity audit R06, 2026-11-01). DEPENDENCY: this is #385's interface
// (supabase/functions/_shared/file_design.ts freshnessStamp + stampHtml), copied verbatim so #370 does not wait on #385 and does
// not add a second file_design.ts. When #385 merges, results_page.ts and trainee-file/handler.ts import these two from
// file_design.ts instead and this file is deleted; tests/architect/results-page-stamp.test.ts holds either way.
import { esc } from "./file_page.ts";

const FALLBACK_ZONE = "America/Chicago";
export const CHECK_UNKNOWN = "Check time unknown";
const zoneValid = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const partsOf = (t: number, tz: string, name: "shortGeneric" | "short") => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: name }).formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { date: `${g("month")} ${g("day")}, ${g("year")}`, time: `${g("hour")}:${g("minute")}`, ampm: g("dayPeriod").toUpperCase(), zone: g("timeZoneName") };
};
// "CT", "ET", "PT" where the zone has a short generic name; else its offset name ("GMT+9").
const zoneName = (t: number, tz: string) => { const g = partsOf(t, tz, "shortGeneric").zone; return /^[A-Z]{2,5}$/.test(g) ? g : partsOf(t, tz, "short").zone; };
const toMs = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) && x > 0 ? x : null;
  if (typeof x !== "string" || !x.trim()) return null;
  const t = Date.parse(x); return Number.isNaN(t) ? null : t;
};
// "Postings checked Nov 1, 2026, 9:08–9:25 AM CT": the earliest and latest of the data's own timestamps, in the person's zone (else
// Chicago's, and the stamp says so). An unreadable timestamp, or one ahead of our clock, is left out; none left: null, never an
// invented time.
export function freshnessStamp(label: string, times: readonly unknown[], o: { now: number; tz?: string | null }): string | null {
  const ts = times.map(toMs).filter((t): t is number => t !== null && t <= o.now + 60_000).sort((a, b) => a - b);
  if (!ts.length) return null;
  const known = zoneValid(o.tz), tz = known ? o.tz as string : FALLBACK_ZONE, note = known ? "" : " (Chicago time; your time zone isn't on file)";
  const lo = ts[0], hi = ts[ts.length - 1], a = partsOf(lo, tz, "short"), b = partsOf(hi, tz, "short");
  const za = zoneName(lo, tz), zb = zoneName(hi, tz);
  let when: string;
  if (a.date === b.date && a.time === b.time && a.ampm === b.ampm && (a.zone === b.zone)) when = `${a.date}, ${a.time} ${a.ampm} ${za}`;
  else if (a.zone !== b.zone) {
    when = a.date === b.date ? `${a.date}, ${a.time} ${a.ampm} ${a.zone}–${b.time} ${b.ampm} ${b.zone}` : `${a.date}, ${a.time} ${a.ampm} ${a.zone} – ${b.date}, ${b.time} ${b.ampm} ${b.zone}`;
  } else if (a.date === b.date) when = a.ampm === b.ampm ? `${a.date}, ${a.time}–${b.time} ${b.ampm} ${zb}` : `${a.date}, ${a.time} ${a.ampm}–${b.time} ${b.ampm} ${zb}`;
  else when = `${a.date}, ${a.time} ${a.ampm} – ${b.date}, ${b.time} ${b.ampm} ${zb}`;
  return `${label} ${when}${note}`;
}
// The stamp line under a title. No stamp is said as a value: the reader is told the check time is unknown.
export const stampHtml = (stamp: string | null, missing: string = CHECK_UNKNOWN) =>
  stamp ? `<p class="stamp" data-stamp="known">${esc(stamp)}</p>` : `<p class="stamp" data-stamp="unknown"><span class="v v-unknown" data-v="unknown">${esc(missing)}</span></p>`;
