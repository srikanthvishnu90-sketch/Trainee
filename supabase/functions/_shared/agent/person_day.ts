// The person's calendar day (YYYY-MM-DD) at `now`, in their time zone: the one definition the system prompt's "Today is" line
// (career_brain.ts localDay) and the tools' day counts (career_tools.ts, days left to a deadline) use, so they never disagree. No
// zone, an empty one or one the runtime does not know: America/New_York, the product's default zone. The apply queue's daily
// limit (career_apply_want.ts dayStart) counts the same day for a known zone, and stays on UTC for an unknown one (review rv4).
export const DEFAULT_ZONE = "America/New_York";
// The zone the person's day is counted in: theirs when the runtime knows it, else the default.
export function personZone(tz?: string | null): string {
  const zone = typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_ZONE;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); return zone; } catch { return DEFAULT_ZONE; }
}
const fmt = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
export function personDay(now: number, tz?: string | null): string { return fmt(personZone(tz)).format(new Date(now)); }
