// Architect ruling (review rv-ma7, 2026-11-17): a place a person rules out ("except the ones in Florida") is accepted as a place
// when it is a US state (name or postal code) or a major US city, even when none of the postings found is there (it then leaves
// nothing out, and nothing is asked). Any other name must be a place or an employer among the postings found
// (career_apply_chat.ts resolveExclusions). One data file, lower case, no punctuation.
const STATES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri",
  "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
  "wisconsin", "wyoming", "district of columbia", "puerto rico"];
const CODES = ["al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc", "pr"];
const CITIES = ["new york city", "nyc", "los angeles", "la", "chicago", "houston", "phoenix", "philadelphia", "san antonio", "san diego", "dallas", "austin",
  "san jose", "fort worth", "jacksonville", "columbus", "charlotte", "indianapolis", "san francisco", "sf", "bay area", "seattle", "denver", "washington dc",
  "dc", "boston", "nashville", "el paso", "detroit", "oklahoma city", "portland", "las vegas", "memphis", "louisville", "baltimore", "milwaukee", "albuquerque",
  "tucson", "fresno", "sacramento", "kansas city", "mesa", "atlanta", "omaha", "colorado springs", "raleigh", "miami", "long beach", "virginia beach",
  "oakland", "minneapolis", "tulsa", "tampa", "arlington", "new orleans", "cleveland", "pittsburgh", "cincinnati", "st louis", "salt lake city", "orlando",
  "palo alto", "mountain view", "menlo park", "sunnyvale", "redmond", "cambridge", "brooklyn", "manhattan", "silicon valley", "durham", "ann arbor", "madison",
  "boulder", "irvine", "san mateo", "santa clara", "jersey city", "hoboken", "buffalo", "rochester", "richmond", "providence", "hartford", "honolulu", "anchorage"];
export const KNOWN_PLACES: ReadonlySet<string> = new Set([...STATES, ...CODES, ...CITIES]);
// A typed place, normalized: lower case, no dots, single spaces; "Columbus, OH" is known when its city or its state is.
export function knownPlace(raw: string): boolean {
  const p = String(raw ?? "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (KNOWN_PLACES.has(p)) return true;
  const parts = p.split(/\s*,\s*/).filter(Boolean);
  return parts.length > 1 && parts.every((x) => KNOWN_PLACES.has(x));
}
