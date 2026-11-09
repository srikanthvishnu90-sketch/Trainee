// R10 WO-C/WO-D (owner order 2026-11-09; spec E.2 #18, E.6 #50): the person's time zone, for the times a reply states
// (a role's checked time, when today's AI-answer limit resets). Only what the person set or stated: the zone saved with their
// alert settings, else the zone of the city on their own profile. Unknown is null, and the caller then says UTC and that the
// zone is unknown; a zone is never guessed from anything else.
const CITY_ZONE: [RegExp, string, string][] = [
  [/\bchicago\b|\bevanston\b|\bnaperville\b|\bschaumburg\b|\bmilwaukee\b|\bminneapolis\b|\bst\.? louis\b|\bdallas\b|\bhouston\b|\baustin\b|\bkansas city\b|\bnashville\b|\bnew orleans\b/i, "America/Chicago", "Chicago"],
  [/\bnew york\b|\bnyc\b|\bbrooklyn\b|\bboston\b|\bphiladelphia\b|\bwashington\b|\batlanta\b|\bmiami\b|\bpittsburgh\b|\bdetroit\b|\bcharlotte\b|\braleigh\b/i, "America/New_York", "New York"],
  [/\bdenver\b|\bboulder\b|\bsalt lake\b/i, "America/Denver", "Denver"],
  [/\bphoenix\b|\bscottsdale\b|\btempe\b/i, "America/Phoenix", "Phoenix"],
  [/\bsan francisco\b|\blos angeles\b|\bseattle\b|\bportland\b|\bsan diego\b|\bsan jose\b|\boakland\b|\bpalo alto\b|\bbay area\b/i, "America/Los_Angeles", "Los Angeles"],
];
const ZONE_CITY: Record<string, string> = Object.fromEntries(CITY_ZONE.map(([, z, c]) => [z, c]));

const real = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export interface PersonZone { tz: string; city: string | null }
export function personZone(o: { alertTz?: string | null; location?: string | null }): PersonZone | null {
  const tz = String(o.alertTz ?? "").trim();
  if (tz && real(tz)) return { tz, city: ZONE_CITY[tz] ?? null };
  const loc = String(o.location ?? "");
  for (const [re, zone, city] of CITY_ZONE) if (re.test(loc)) return { tz: zone, city };
  return null;
}

// The person's zone for this turn: their alert settings' zone, else their profile's city. A read that fails is unknown.
export async function readPersonZone(admin: any, userId: string, profile: any): Promise<PersonZone | null> {
  let alertTz: string | null = null;
  try { const r: any = await admin.from("career_alert_prefs").select("tz").eq("user_id", userId).maybeSingle(); alertTz = r?.data?.tz ?? null; } catch { /* unknown */ }
  return personZone({ alertTz, location: profile?.basics?.location ?? null });
}
