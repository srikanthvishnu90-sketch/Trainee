// R10 WO-C (owner order 2026-11-09; spec APP-LAYER-15-FIXES.md B.2, C.7, E.2): what each role on a search reply carries,
// read from the posting itself, and what an empty search says it checked. Pure functions: no fetch, no write.
//
// Each numbered role: employer, exact title, location and work arrangement, the student or graduation window in the
// posting's own words (or "not stated in the posting"), whether the application page was re-checked just now (and when, in
// the person's time zone), and the application link. Fit stays fit: a skills match is never an eligibility verdict.
import { METRO } from "./search_widen.ts";

const lc = (s: unknown) => String(s ?? "").toLowerCase();

// "Nov 8, 5:16 PM CST" in the person's zone; UTC (said) when their zone is unknown or not a real zone.
export function checkedAt(now: number, tz: string | null | undefined): { text: string; zoneKnown: boolean } {
  const fmt = (timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(now));
  if (tz) { try { return { text: fmt(tz), zoneKnown: true }; } catch { /* not a zone: UTC below */ } }
  return { text: fmt("UTC"), zoneKnown: false };
}

// Remote, hybrid or on-site, as the posting states it; null when it states none.
export function arrangementOf(location: string, description: string): string | null {
  const l = lc(location), d = lc(description);
  if (/\bhybrid\b/.test(l) || /\bhybrid\b/.test(d)) return "hybrid";
  // A bare "Remote" names no region (about 10,700 open postings, many on EU boards): said so, never read as the US.
  if (/\bremote\b/.test(l)) return /^\s*(?:fully\s+)?remote\s*$/.test(l) ? "remote, region not stated" : "remote";
  if (/\b(?:on-?site|in[- ]office|in[- ]person)\b/.test(l) || /\b(?:on-?site|in[- ]office|in[- ]person)\b/.test(d)) return "on-site";
  if (/\b(?:fully remote|100% remote|remote[- ]first)\b/.test(d)) return "remote";
  return null;
}

// The posting's own sentence about who may apply as a student (graduation dates, enrollment), quoted; null when none.
const WINDOW = /\b(?:graduat\w*|enrolled|pursuing (?:a|an|your)?\s*(?:bachelor|master|degree|ba|bs|ms)\w*|class of 20\d\d|currently a student|current students?|rising (?:junior|senior|sophomore)s?|returning to (?:school|university|college)|expected (?:graduation|to graduate))\b/i;
export function studentWindowOf(description: string): string | null {
  const text = String(description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Abbreviations ("U.S.", "e.g.", "Ph.D.") are not sentence ends: their dots are held while the text is split.
  const held = text.replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, "\u0000")).replace(/\b(?:St|Dr|Mr|Ms|Jr|Sr|vs|approx)\./g, (m) => m.replace(".", "\u0000"));
  const s = held.split(/(?<=[.!?;])\s+/).find((x) => WINDOW.test(x.replace(/\u0000/g, ".")));
  if (!s) return null;
  const q = s.replace(/\u0000/g, ".").trim().replace(/[;]$/, ".");
  return q.length > 170 ? `${q.slice(0, 167).replace(/\s+\S*$/, "")}...` : q;
}

// The titles a role is also posted under: "data analyst" internships are also posted as "data analytics" ones.
export function roleVariants(roles: string[]): string[] {
  const out: string[] = [];
  for (const r of roles.map((x) => lc(x).replace(/\s+(?:roles?|jobs?|openings?|positions?)$/, "").trim()).filter(Boolean)) {
    out.push(r);
    if (/\banalyst\b/.test(r)) out.push(r.replace(/\banalyst\b/, "analytics"));
  }
  return [...new Set(out)];
}

// The place said in words: "Chicago", "the Chicago area (Chicago and 37 nearby towns)", "remote in the US".
const cap = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
export function placesLine(ask: { place: string | null; area?: boolean; remote: boolean; remoteOnly?: boolean; remoteRegion?: string | null }): string {
  const bits: string[] = [];
  if (ask.place && !ask.remoteOnly) bits.push(ask.area ? `the ${cap(ask.place)} area (${cap(ask.place)} and ${(METRO[lc(ask.place)]?.length ?? 1) - 1} nearby towns)` : cap(ask.place));
  if (ask.remote) bits.push(ask.remoteRegion === "us" ? "remote in the US" : "remote");
  return bits.join(" and ") || "any location";
}

// The one widening most likely to find something, from what the search did not yet include.
export function nextWidening(ask: { roles?: string[]; role: string; place: string | null; area?: boolean; remote: boolean }): string {
  if (ask.place && !ask.area && METRO[lc(ask.place)]) return `the ${cap(ask.place)} area (the suburbs too): say "include the ${cap(ask.place)} area"`;
  if (!ask.remote) return `remote roles in the US: say "include remote US"`;
  const roles = ask.roles?.length ? ask.roles : [ask.role];
  if (roles.length < 2) return `related titles (business analyst, analytics): say "include business analyst and analytics"`;
  return `a later season or entry-level roles: say which`;
}

// How many roles the person asked for ("find me 5 data analyst internships"); null when they named no number.
const WORD_N: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export function wantOf(message: string): number | null {
  const m = /\b(?:find|show|get|give|list|pull up|send)\s+(?:me\s+)?(?:the\s+)?(?:top\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+[a-z,/-]+){0,9}?\s+(?:internships?|interns?|jobs?|roles?|openings?|positions?)\b/i.exec(String(message ?? ""));
  if (!m) return null;
  const n = WORD_N[m[1].toLowerCase()] ?? Number(m[1]);
  return n >= 1 && n <= 25 ? n : null;
}
