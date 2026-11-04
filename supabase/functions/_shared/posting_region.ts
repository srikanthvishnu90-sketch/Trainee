// SERIAL-1530 (F4): where a posting is open, and whether the person is there. The spec (upmore-spec2, 3.1 and 3.2)
// makes locations plus the remote preference and work authorization hard filters and says never to infer work
// authorization silently. Before this, a remote posting passed any watch whose remote preference was not "no" (152's
// locationOk, career_alerts.fits), so "watch data analyst in New York" admitted a "Remote - US only" posting for a
// person in Toronto, and a posting's stated country restriction was never read.
//
// One rule, used by the scheduled matcher (career_alerts.ts) and mirrored in module 152 (packages/domain, the
// router's own matcher) with the same REGION_TABLE and the same decision; tests/architect/alerts-remote-region.test.ts
// pins the two to each other on a fixture matrix.
//   regionsOf(text)        the regions a place text names: "us", a country ("canada", "uk", ...) or a bloc ("eu", "apac")
//   postingScope(p)        the regions a posting is restricted to: a remote posting's stated country ("Remote - US",
//                          "Spain (Remote)", "Remote (US, Canada)") and any restriction stated in its text ("must be
//                          authorized to work in the United States", "US-based", "UK residents only"); [] = none stated
//   regionDecision(p, w)   the location decision for one posting against one watch: remote preference, watched places,
//                          the posting's scope against the person's STATED location (w.home). A scope with the location
//                          not on record is held, never passed: nothing is inferred about where they are or what they
//                          are authorized for. A restriction phrased as authorization is screened as a place (the
//                          person's stated location), never as a claim about their authorization.
import { postingPlaces, STATE_NAMES, unsettledRemoteCode } from "./posting_place.ts";

// key -> the words a text uses for it (whole words, case-blind). Kept identical in 152 (REGION_TABLE there).
export const REGION_TABLE: [string, string[]][] = [
  ["us", ["us", "u.s.", "u.s", "usa", "u.s.a.", "united states", "united states of america", "america", "stateside"]],
  ["canada", ["canada", "canadian"]],
  ["uk", ["uk", "u.k.", "united kingdom", "britain", "great britain", "england", "scotland", "wales", "northern ireland"]],
  ["ireland", ["ireland", "republic of ireland"]],
  ["germany", ["germany", "deutschland"]], ["france", ["france"]], ["spain", ["spain"]], ["italy", ["italy"]],
  ["netherlands", ["netherlands", "the netherlands", "holland"]], ["belgium", ["belgium"]], ["austria", ["austria"]],
  ["switzerland", ["switzerland"]], ["sweden", ["sweden"]], ["denmark", ["denmark"]], ["finland", ["finland"]], ["norway", ["norway"]],
  ["poland", ["poland"]], ["portugal", ["portugal"]], ["czechia", ["czechia", "czech republic"]],
  ["india", ["india"]], ["australia", ["australia"]], ["new zealand", ["new zealand"]], ["singapore", ["singapore"]], ["japan", ["japan"]],
  ["mexico", ["mexico"]], ["brazil", ["brazil"]], ["argentina", ["argentina"]], ["israel", ["israel"]], ["uae", ["uae", "united arab emirates", "dubai"]],
  ["eu", ["eu", "european union", "europe", "emea", "eea"]], ["apac", ["apac", "asia pacific", "asia-pacific"]], ["latam", ["latam", "latin america"]],
];
export const EU_MEMBERS = new Set(["ireland", "germany", "france", "spain", "italy", "netherlands", "belgium", "austria", "sweden", "denmark", "finland", "poland", "portugal", "czechia"]);
const CA_CODES = /\b(on|bc|qc|ab|ns|mb|sk|nb|pe|nl)\b/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TABLE_RE: [string, RegExp][] = REGION_TABLE.map(([k, words]) => [k, new RegExp(`(^|[^a-z0-9.])(${words.map(esc).join("|")})(?=$|[^a-z0-9])`, "i")]);
const low = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// The regions a place text names. A US state (code or name), a known US city or "US" is "us"; a Canadian province code
// beside a city is "canada"; otherwise the table's words. Unknown text names none.
export function regionsOf(text: unknown): string[] {
  const t = low(text);
  if (!t) return [];
  const out = new Set<string>();
  for (const [k, re] of TABLE_RE) if (re.test(` ${t} `)) out.add(k);
  if (!out.has("us")) {
    if (postingPlaces(String(text)).some((p) => p.country === "us")) out.add("us");
    else if (/,\s*([a-z]{2})\b/.test(t) && STATE_NAMES[(/,\s*([a-z]{2})\b/.exec(t) as RegExpExecArray)[1]] && !CA_CODES.test(t)) out.add("us");
  }
  if (!out.size && CA_CODES.test(t) && /,\s*(on|bc|qc|ab|ns|mb|sk|nb|pe|nl)\b/.test(t)) out.add("canada");
  return [...out];
}

// A restriction stated in the posting's own words, as regions: "authorized to work in the United States", "must be
// located in the UK", "must be US-based", "Canada residents only", "open to candidates in the EU". The phrase must name a
// region the table knows and be about the candidate: an employer's own descriptor ("a Chicago-based company", "we are
// based in Chicago", "serving residents of Texas") is not a restriction (the labeled set's P02-01 and P06-01 were held
// on "Chicago-based" boilerplate before this line).
const RESTRICT = /(?:(?:authori[sz]ed|eligible|legally (?:able|permitted|entitled)|permitted|entitled|right|work authori[sz]ation) to work (?:in|within)|(?:must|need to|required to|should|have to) (?:reside|be (?:located|based|living|resident)|live|work|be) (?:in|within)|(?:candidates?|applicants?|you) (?:must be|should be|are|need to be) (?:located|based|living|resident) (?:in|within)|open (?:only )?to (?:candidates|applicants|residents|those)? ?(?:in|of|within)|only (?:for|to) (?:candidates|applicants|residents) (?:in|of|within))\s+(?:the\s+)?([a-z .&'-]{2,40}?)(?=\s*(?:[.;:,)\n]|$|\s+(?:only|and|or|at|for|who|with|to|are|is)\b))/gi;
const ONLY = /\b([a-z. ]{2,30}?)\s+(?:residents\s+)?only\b/gi;
// "must be US-based", "US-based candidates only": the candidate, never the employer ("a Chicago-based company").
const BASED = /\b(?:(?:must|should|need to) be|candidates? (?:must be|should be|are)|you are|you must be)\s+([a-z.]{2,15})-based\b|\b([a-z.]{2,15})-based\s+(?:candidates?|applicants?|residents?|only)\b/gi;
export function restrictionsOf(text: unknown): string[] {
  const t = low(text);
  if (!t) return [];
  const out = new Set<string>();
  for (const re of [RESTRICT, ONLY, BASED]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) for (const k of regionsOf(m[1] ?? m[2])) out.add(k);
  }
  return [...out];
}

export interface RegionPosting { location?: string | null; description?: string | null; jd_text?: string | null; remote?: string | null }
export const isRemotePosting = (p: RegionPosting) => p.remote === "remote" || /\bremote\b/i.test(String(p.location ?? ""));
// The regions a posting is open to: a remote posting's stated country or bloc in its location, plus any restriction in
// its text. Empty: nothing stated (a remote posting is then open anywhere; an office posting is where its location is).
export function postingScope(p: RegionPosting): string[] {
  const out = new Set<string>();
  const loc = String(p.location ?? "");
  if (isRemotePosting(p)) {
    for (const part of postingPlaces(loc)) if (part.remote && part.country === "us") out.add("us");
    // "Remote - Canada", "Spain (Remote)", "Remote (US, Canada)": the names beside the word remote.
    // Round 3 (2026-11-03): only a code that is two places at once beside it ("Remote - IN": Indiana or India) names none.
    for (const seg of loc.split(/[;|•·\n]/)) if (/\bremote\b/i.test(seg) && !unsettledRemoteCode(seg.replace(/\bremote\b/gi, " "))) for (const k of regionsOf(seg.replace(/\bremote\b/gi, " "))) out.add(k);
  }
  for (const k of restrictionsOf(p.description ?? p.jd_text ?? "")) out.add(k);
  return [...out];
}
const inScope = (home: string[], scope: string[]) => home.some((h) => scope.includes(h) || (scope.includes("eu") && (EU_MEMBERS.has(h) || h === "eu")) || (h === "us" && scope.includes("us")));
const say = (ks: string[]) => ks.map((k) => k === "us" ? "the US" : k === "uk" ? "the UK" : k === "eu" ? "the EU" : k === "uae" ? "the UAE" : k.replace(/\b\w/g, (c) => c.toUpperCase())).join(" or ");

export interface RegionWatch { remote_ok?: boolean | null; locations?: string[] | null; home?: string | null }
export type RegionDecision = { ok: true; via: string } | { ok: false; why: string };
// The location decision for one posting against one watch. `placeOk` is the caller's own watched-place rule for an
// office posting (152 and the alerts matcher each keep theirs); the scope screen runs after it.
export function regionDecision(p: RegionPosting, w: RegionWatch, placeOk: () => { ok: boolean; via?: string }): RegionDecision {
  const scope = postingScope(p), home = regionsOf(w.home);
  const held = (what: string) => ({ ok: false as const, why: `${what}, and your location is not on record: tell me your city and country and I will match it` });
  if (isRemotePosting(p)) {
    if (w.remote_ok === false) return { ok: false, why: "remote postings are left out of this watch" };
    if (!scope.length) return { ok: true, via: "remote" };
    if (!home.length) return held(`remote within ${say(scope)} only`);
    if (inScope(home, scope)) return { ok: true, via: `remote within ${say(scope)}` };
    return { ok: false, why: `remote within ${say(scope)} only; your location is ${say(home)}` };
  }
  const place = placeOk();
  if (!place.ok) return { ok: false, why: `location ${String(p.location ?? "").trim() || "unstated"} is outside this watch's places` };
  if (scope.length) {
    if (!home.length) return held(`open to ${say(scope)} only`);
    if (!inScope(home, scope)) return { ok: false, why: `open to ${say(scope)} only; your location is ${say(home)}` };
  }
  return { ok: true, via: place.via ?? "location" };
}
