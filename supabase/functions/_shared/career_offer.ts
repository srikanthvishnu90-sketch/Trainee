// WO-036: the offer benchmark. The person texts their offer in their own words ("JPM offered 110k base, 15k signing,
// NYC, analyst"); code reads it, asks once for what is missing, places it against public data, and drafts a counter
// from 128's factScript. The model never supplies a number.
//
// Public data only, each number said with what it is, its period and its n:
//   - DOL H-1B LCA: the employer's own filed wages for that occupation and metro (packages/career-data/datasets/
//     dol-lca-wages.json, built by scripts/career/datasets/aggregate-lca.py --wages). A median from fewer than 5
//     filings is never shown as a benchmark.
//   - BLS OEWS: the occupation's wage percentiles in the metro (bls-oews-metro.json, scripts/career/datasets/import-oews.py).
//   - BLS national median for the occupation (bls-labor-data.json, already on file) when the metro data is not loaded.
// A file not imported yet is said in one line ("not loaded yet"), never filled in. Nothing is sent: the counter is a
// draft the person reads, edits and sends themselves.
import { CareerNegotiation, CareerPaths, CareerProfile } from "./router_core.career.js";

export const MIN_N = 5; // the fewest filings a median may come from
export const ASK_TTL_MS = 24 * 3600_000; // a half-told offer waits this long for the missing pieces
export const REQUIRED = ["company", "base", "city", "role"] as const;
export type Field = typeof REQUIRED[number];
export const MAX_MESSAGE = 1500;

export interface Competing { company: string | null; base: number; said: string; currency?: string; mark?: string | null; assumed?: boolean; written?: string; rated?: boolean; abroad?: boolean; plain?: boolean }
export type Period = "hour" | "day" | "week" | "biweek" | "semimonth" | "month" | "year";
type Fig = "base" | "signing" | "bonus" | "bonus_target";
export interface Offer {
  company: string | null; firm_id: string | null; lca_company_id: string | null; sector: string | null;
  base: number | null; hourly: number | null; signing: number | null; bonus: number | null; bonus_pct: number | null;
  city: string | null; metro: string | null; metro_label: string | null; remote: boolean;
  role: string | null; occupation: { key: string; soc: string; soc_title: string; bls_national: string | null } | null;
  competing: Competing[]; deadline: { text: string } | null;
  // LOOP 13: a bonus amount said as a target ("a $15k target bonus") is not guaranteed cash; and the clause each figure was
  // read from, so the reply can say where it came from (offer letter, verbal, the person's estimate).
  bonus_target?: number | null; from?: Partial<Record<"base" | "signing" | "bonus" | "bonus_pct" | "bonus_target", string>>;
  // D-069 (real set item 13, findings 2 and 3): the offer as the person stated it. `currency` is the base's currency as said
  // ("AUD 87,600" is AUD, "$110k" is USD; nothing said is read as USD, as before), and `currencies` each figure's own, so an
  // amount said in AUD or PLN is never restated in dollars. `title` is the job title in their words and `place` the place they
  // named, any title and any place: an offer outside the metros and titles the pay data knows is still their offer (it is kept
  // and compared; only the public benchmark is skipped). `period`: "hour" for an hourly base, "year" for a yearly one, null
  // when not said.
  currency?: string; currencies?: Partial<Record<"base" | "signing" | "bonus" | "bonus_target", string>>;
  title?: string | null; place?: string | null; period?: Period | null;
  // 2026-11-13 (review of PR #788): nothing is assumed. `currency` and `currencies` are an ISO code, or UNKNOWN_CURRENCY
  // ("XXX", ISO 4217's own "no currency") when the currency was not stated or is ambiguous; `currency_fact` says which and
  // why (null when the base's currency was stated), and `marks` keeps what was written next to each figure so a later
  // message (the city) can settle it. `rate` is a base said per hour, day, week, two weeks or month; `annualized` is the
  // stated assumption a yearly `base` was worked out with (null for a daily rate: no yearly base), and `period_fact` says so.
  // `currency_assumed` marks a figure read as US dollars without the person saying so beyond a "$" or nothing, for a place
  // code cannot confirm is in the United States: it is never benchmarked, added or weighed against another amount, the
  // reply asks to confirm it, and a counter email writes it as the person wrote it (`written`).
  currency_fact?: string | null; marks?: Partial<Record<Fig, string | null>>; currency_assumed?: Partial<Record<Fig, boolean>>; written?: Partial<Record<Fig, string>>;
  rate?: { amount: number; period: Period } | null; annualized?: { factor: number; assumption: string } | null; period_fact?: string | null;
  // 2026-11-13 round 2, the completeness rule: every money, currency, period, range, total-pay or place word in the message
  // must have been taken by exactly one field. What was not is listed in `open` (in the person's words) and the offer is
  // `unsettled`: no benchmark, no percent, no leverage, no counter; the reply restates what was read and asks.
  // `total`: pay said as total compensation, OTE or TC (never the base). `part_year`: the words that say the job is not a full
  // year of full-time work (internship, contract, part-time, stated hours or weeks): a yearly figure from its rate is arithmetic
  // only, never compared. `place_kind` and `state`: whether the stated place is in the United States, and which state.
  // Round 3: `current` is the pay the person says they make now and `ask` the figure they say they want: neither is the offer.
  open?: string[]; unsettled?: boolean; total?: { amount: number; written: string } | null; part_year?: string | null;
  current?: string | null; ask?: { amount: number; written: string } | null;
  place_kind?: "us" | "none" | "dollar" | "other"; state?: string | null;
}
export interface Bench {
  kind: "lca" | "oews" | "bls_national";
  shown: boolean;
  label: string; // what the number is, in words
  cite: string; // the short citation used in the draft
  what: string; // the caveat, said plainly
  period: string | null;
  n: number | null;
  median: number | null; p25: number | null; p75: number | null;
  position: string | null;
  reason: string | null; // why it is not shown
  source_url: string;
}
export interface OfferData { maps: any; lca_wages: any; oews_metro: any; bls_national: any; lca_companies: any }

export function payData(): OfferData { return (CareerNegotiation as any).payData(); }
function guide(): any { return (CareerPaths as any).firmGuide(); }

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
// ---------- currency (D-069; 2026-11-13) ----------
// ISO 4217 codes people write next to pay. "A$", "C$", "S$" and the like name their own dollar. A bare "$" is US dollars
// unless the place is one whose own money is a dollar or a peso (Toronto, Sydney, Mexico City): then it is ambiguous.
export const CURRENCY_CODES = ["USD", "AUD", "CAD", "EUR", "GBP", "INR", "JPY", "CHF", "SGD", "PLN", "NZD", "HKD", "MXN", "BRL", "SEK", "NOK", "DKK", "CNY", "KRW",
  "ILS", "ZAR", "AED", "CZK", "HUF", "RON", "TRY", "PHP", "IDR", "MYR", "THB", "TWD", "VND", "COP", "ARS", "CLP", "PEN", "NGN", "KES", "EGP", "SAR", "QAR", "BGN", "UAH"];
export const UNKNOWN_CURRENCY = "XXX";
export const NOT_STATED = "currency not stated";
const CODE_RE = CURRENCY_CODES.join("|");
const WORDY = new Set(["TRY", "PHP", "PEN", "COP", "ARS", "SAR"]); // codes that are also words: read only in capitals
// A code as written: all capitals, or all lower case ("95k cad"); "RMB" is the yuan. Never a capitalized word ("Ron").
function codeOf(w: string | undefined): string | null {
  if (!w || (w !== w.toUpperCase() && w !== w.toLowerCase())) return null;
  const u = w.toUpperCase();
  if (u === "RMB") return "CNY";
  return CURRENCY_CODES.includes(u) && (w === u || !WORDY.has(u)) ? u : null;
}
const DOLLAR_PREFIX: Record<string, string> = { US: "USD", A: "AUD", AU: "AUD", C: "CAD", CA: "CAD", NZ: "NZD", S: "SGD", SG: "SGD", HK: "HKD", MX: "MXN", R: "BRL" };
// A sign that names one currency. "¥" is both the yen and the yuan, "kr" four Nordic currencies, "pesos" several: ambiguous.
const SYMBOL: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "¥", "￥": "¥", "₹": "INR", "₩": "KRW", "₪": "ILS", "zł": "PLN" };
const WORD_CUR: [RegExp, string][] = [[/^\s?US(?:\s?dollars?)?\b/, "USD"], [/^\s?(?:us\s?dollars?|american(?:\s?dollars?)?)\b/i, "USD"], [/^\s?(?:canadian|cdn)(?:\s?dollars?)?\b(?!\s+(?:company|firm|startup|entity|subsidiary|office|team|bank|branch))|^\s?loonies\b/i, "CAD"], [/^\s?(?:australian|aussie)(?:\s?dollars?)?\b(?!\s+(?:company|firm|startup|entity|subsidiary|office|team|bank|branch))/i, "AUD"],
  [/^\s?(?:new zealand|nz|kiwi)\s?dollars?\b/i, "NZD"], [/^\s?singapore(?:an)?\s?dollars?\b/i, "SGD"], [/^\s?hong kong\s?dollars?\b/i, "HKD"], [/^\s?(?:dollars?|bucks)\b/i, "$"],
  [/^\s?euros?\b/i, "EUR"], [/^\s?(?:pounds?(?:\s+sterling)?|quid|sterling)\b/i, "GBP"], [/^\s?(?:indian\s)?rupees?\b/i, "INR"], [/^\s?(?:z[łl]oty|zlotys?|zł)(?![\w])/i, "PLN"],
  [/^\s?(?:japanese\s)?yen\b/i, "JPY"], [/^\s?(?:chinese\s)?(?:yuan|renminbi)\b/i, "CNY"], [/^\s?(?:swiss\s)?francs?\b/i, "CHF"], [/^\s?swedish\s?(?:kronor|krona)\b/i, "SEK"],
  [/^\s?norwegian\s?(?:kroner|krone)\b/i, "NOK"], [/^\s?danish\s?(?:kroner|krone)\b/i, "DKK"], [/^\s?(?:kr|kronor|krona|kroner|krone)\b/i, "kr"],
  [/^\s?mexican\s?pesos?\b/i, "MXN"], [/^\s?pesos?\b/i, "pesos"], [/^\s?(?:brazilian\s)?rea(?:is|ls?)\b/i, "BRL"]];
const AMBIGUOUS: Record<string, string> = { "kr": `"kr" could be Swedish, Norwegian, Danish or Icelandic kronor (SEK, NOK, DKK or ISK)`, "¥": `"¥" is the sign of both the Japanese yen and the Chinese yuan`,
  "pesos": `"pesos" could be Mexican, Argentine, Chilean, Colombian or Philippine pesos`, "lakh": `lakh and crore count rupees, and which country's rupee was not said (write INR, PKR ...)` };
const DOLLARS = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN", "TWD"]);
// Round 3: a currency counts only next to an amount (currencyMark) or in an explicit statement of it: "in CAD", "paid in
// reais", "(Canadian dollars)", "It's in euros". A word that is also an ordinary word, a place or a company ("real",
// "pound", "rand", "Sterling, Virginia", "a Canadian company") never sets or questions the currency.
const CUR_WORDS = String.raw`(?:(?:us|u\.s\.|american|canadian|cdn|australian|aussie|new zealand|singapore|hong kong|mexican|swedish|norwegian|danish|swiss|indian|japanese|chinese|brazilian)\s)?(?:dollars|bucks|euros?|pounds(?: sterling)?|sterling|quid|rupees|yen|yuan|renminbi|francs|kronor|kroner|pesos|reais|zloty|loonies)`;
const CUR_SAID = new RegExp(String.raw`\b(?:paid |denominated )?in\s+(${CODE_RE}|RMB|${CODE_RE.toLowerCase()}|${CUR_WORDS})\b(?!\s+[A-Za-z]*(?:company|firm|startup|entity|office|team|bank|branch))|\((${CODE_RE}|RMB|${CUR_WORDS})\)`, "gi");
const freeCur = (rest: string) => [...rest.matchAll(CUR_SAID)].map((m) => m[1] ?? m[2]).filter((w) => codeOf(w) || !/^[A-Za-z]{3}$/.test(w));
export function currencyOf(token: string): string | null {
  const w = token.replace(/^(?:paid )?in\s/i, "").replace(/^(?:us|u\.s\.)\sdollars$/i, "US dollars").trim();
  if (codeOf(w)) return codeOf(w);
  for (const [re, v] of WORD_CUR) if (re.test(w)) return v;
  return null;
}
// What is written next to an amount: an ISO code, or the mark as said when it is ambiguous ("$", "kr", "¥", "pesos"); null
// when nothing is. `after` is how much of the text after the amount the currency's own words take.
export function currencyMark(text: string, at: number, end: number): { mark: string | null; after: number } {
  const before = text.slice(Math.max(0, at - 8), at), rest = text.slice(end, end + 30);
  const pre = codeOf(new RegExp(`(?:^|[^A-Za-z])(${CODE_RE}|RMB)\\$?\\s?$`, "i").exec(before)?.[1]);
  if (pre) return { mark: pre, after: 0 };
  const post = new RegExp(`^\\s?\\(?(${CODE_RE}|RMB)\\)?(?![A-Za-z])`, "i").exec(rest);
  if (codeOf(post?.[1])) return { mark: codeOf(post![1]), after: post![0].length };
  const sym = /(?:^|[^A-Za-z])([A-Z]{1,2})\s?\$\s?$/.exec(text.slice(at, at + 1) === "$" ? `${before}$` : before)?.[1];
  if (sym && DOLLAR_PREFIX[sym]) return { mark: DOLLAR_PREFIX[sym], after: 0 };
  if (/(?:^|[^A-Za-z])Rs\.?\s?$/.test(before)) return { mark: "INR", after: 0 };
  for (const [k, v] of Object.entries(SYMBOL)) { if (before.trimEnd().endsWith(k)) return { mark: v, after: 0 }; if (rest.trimStart().startsWith(k)) return { mark: v, after: rest.indexOf(k) + k.length }; }
  for (const [re, v] of WORD_CUR) { const m = re.exec(rest); if (m) return { mark: v, after: m[0].length }; }
  if (text.slice(at, end).includes("$") || /\$\s?$/.test(before)) return { mark: "$", after: 0 };
  return { mark: null, after: 0 };
}
// ---------- the place: is it in the United States? ----------
const STATES: Record<string, string> = Object.fromEntries(("Alabama:AL,Alaska:AK,Arizona:AZ,Arkansas:AR,California:CA,Colorado:CO,Connecticut:CT,Delaware:DE,Florida:FL,Georgia:GA,Hawaii:HI,Idaho:ID,Illinois:IL,Indiana:IN,Iowa:IA,Kansas:KS,"
  + "Kentucky:KY,Louisiana:LA,Maine:ME,Maryland:MD,Massachusetts:MA,Michigan:MI,Minnesota:MN,Mississippi:MS,Missouri:MO,Montana:MT,Nebraska:NE,Nevada:NV,New Hampshire:NH,New Jersey:NJ,New Mexico:NM,New York:NY,North Carolina:NC,"
  + "North Dakota:ND,Ohio:OH,Oklahoma:OK,Oregon:OR,Pennsylvania:PA,Rhode Island:RI,South Carolina:SC,South Dakota:SD,Tennessee:TN,Texas:TX,Utah:UT,Vermont:VT,Virginia:VA,Washington:WA,West Virginia:WV,Wisconsin:WI,Wyoming:WY,"
  + "District of Columbia:DC,DC:DC,United States:US,USA:US,US:US").split(",").map((x) => x.split(":").map((y, i) => i ? y : y.toLowerCase())));
const STATE_CODES = new Set(Object.values(STATES));
const GEORGIA_CITIES = /^(?:Atlanta|Athens|Savannah|Augusta|Macon|Columbus|Alpharetta|Marietta|Decatur)$/i;
// Large US cities outside the metros the pay data maps, named without a state ("in San Diego"), that are no other country's city.
const US_CITY = /^(?:San Diego|Phoenix|Portland|Minneapolis|Saint Paul|St\.? Paul|Detroit|Pittsburgh|Nashville|Charlotte|Raleigh|Salt Lake City|Las Vegas|San Antonio|Columbus|Indianapolis|Baltimore|Sacramento|Kansas City|St\.? Louis|Tampa|Orlando|Jacksonville|Cleveland|Cincinnati|Milwaukee|Honolulu|Boise|Albuquerque|Tucson|Omaha|Oklahoma City|Louisville|New Orleans|Buffalo|Boulder|Irvine|San Mateo|Fort Lauderdale|Ann Arbor|Madison)$/;
const DOLLAR_PLACE = /\b(?:Canada|Toronto|Vancouver|Montreal|Ottawa|Calgary|Edmonton|Waterloo|Winnipeg|Quebec|Ontario|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|ON|QC|BC|AB|MB|SK|NS|NB|NL|Mississauga|Halifax|Hamilton|Victoria|Kingston|Richmond|Windsor|Surrey|Australia|Sydney|Melbourne|Brisbane|Perth|Adelaide|Canberra|New Zealand|Auckland|Wellington|Christchurch|Singapore|Hong Kong|Taiwan|Taipei|Mexico|Guadalajara|Monterrey|Argentina|Buenos Aires|Chile|Santiago|Colombia|Bogota|Medellin|Brazil|Sao Paulo|Rio de Janeiro|Jamaica|Bahamas|Barbados|Trinidad|Fiji|Uruguay|Montevideo|Dominican Republic|Philippines|Manila|Cuba|Liberia|Namibia|Belize|Guyana)\b/;
// The stated place always wins over a metro guess. "City, Region": a US state makes it a US place and keeps a metro only
// when that metro lies in that state ("Arlington, Texas" is not the DC metro); any other region is not the United States
// ("Queens, Ontario", "Miami, Australia"); ", CA" after a Canadian city and "Georgia" without one of its cities are ambiguous.
export function readPlace(place: string | null, metro: any | null): { kind: "us" | "none" | "dollar" | "other"; metro: any | null; state: string | null; open: string | null } {
  if (!place) return { kind: metro ? "us" : "none", metro, state: null, open: null };
  const cut = place.lastIndexOf(","), city = (cut < 0 ? place : place.slice(0, cut)).trim(), region = cut < 0 ? null : place.slice(cut + 1).trim();
  const stateOf = (w: string) => STATE_CODES.has(w) ? w : STATES[w.toLowerCase()] ?? null;
  const metroStates = new Set<string>((metro?.lca_cities ?? []).map((x: string[]) => x[1]));
  const metroNamed = !!metro && (metro.words as string[]).some((w) => hasWord(place, w));
  if (region) {
    const st = stateOf(region);
    if (region === "CA" && DOLLAR_PLACE.test(city)) return { kind: "other", metro: null, state: null, open: `"${place}": CA could be California or Canada` };
    if (/^Georgia$/i.test(region) && !GEORGIA_CITIES.test(city)) return { kind: "other", metro: null, state: null, open: `"${place}": Georgia could be the US state or the country` };
    if (!st) return { kind: DOLLAR_PLACE.test(place) ? "dollar" : "other", metro: null, state: null, open: null };
    return { kind: "us", metro: metroNamed && (st === "US" || metroStates.has(st)) ? metro : null, state: st === "US" ? null : st, open: null };
  }
  if (/^Georgia$/i.test(city)) return { kind: "other", metro: null, state: null, open: `"Georgia" could be the US state or the country` };
  if (stateOf(city)) return { kind: "us", metro: /^(?:DC|District of Columbia|New York)$/i.test(city) ? metro : null, state: stateOf(city) === "US" ? null : stateOf(city), open: null };
  if (metroNamed) return { kind: "us", metro, state: null, open: null };
  return { kind: US_CITY.test(city) ? "us" : DOLLAR_PLACE.test(city) ? "dollar" : "other", metro: null, state: null, open: null };
}
// "us": a metro the pay data knows, a US state, or a city with its state. "none": remote or not said. "dollar": a place whose
// own money is a dollar or a peso. "other": any other place, which code cannot confirm is in the United States.
export function placeKind(o: Pick<Offer, "metro" | "place" | "city" | "remote" | "place_kind">): "us" | "none" | "dollar" | "other" {
  if (o.place_kind) return o.place_kind;
  if (o.metro) return "us";
  const p = o.place ?? (o.city && o.city !== "remote" ? o.city : null);
  return readPlace(p, null).kind;
}
const placeName = (o: Offer) => o.metro_label ?? o.place ?? o.city ?? "the place";
// US pay data is placed only against a US-dollar offer for a US place (or one with no place said, or remote).
export const usMarket = (o: Offer) => ["us", "none"].includes(placeKind(o));
export const known = (c: string | null | undefined) => !!c && c !== UNKNOWN_CURRENCY;
// Two amounts are in one currency only when both currencies are known and equal (a legacy offer on file with none is USD).
export const sameCurrency = (a: string | null | undefined, b: string | null | undefined) => known(a ?? "USD") && (a ?? "USD") === (b ?? "USD");
// A competing offer is weighed against this base only like for like: both yearly as said, one known currency, neither an
// assumption, and not a job in another country.
export const comparable = (o: Offer, x: Competing) => x.plain !== false && !o.part_year && !o.rate && !x.rated && !x.assumed && !x.abroad && !o.currency_assumed?.base && !o.unsettled && sameCurrency(x.currency, o.currency);
// The person stated the hours or how long the job lasts ("20 hrs/week", "12-week internship", "part-time"): a 2,080-hour year
// contradicts what they said, so no yearly estimate is shown for the rate at all. An internship or contract with no hours or
// duration stated keeps the estimate, always labelled with its basis.
export const statedHours = (o: Offer) => !!o.rate && !!o.part_year && /\d|part[- ]time|pro[- ]rata|FTE/i.test(o.part_year);
// A rate as said, then its labelled yearly estimate when one may be shown.
export function rateThenEstimate(o: Offer, c: string | null | undefined): string {
  const r = `${rateIn(o.rate!.amount, c)} ${PER[o.rate!.period]}`;
  if (statedHours(o) || !o.annualized || o.base == null) return `${r}${o.part_year ? " (not a full-year salary)" : ""}`;
  return `${r} (estimate: x ${o.annualized.assumption} = ${moneyIn(o.base, c)} a year; you said ${o.part_year}, so a full year is not expected)`;
}
export const anyAssumed = (o: Offer) => Object.values(o.currency_assumed ?? {}).some(Boolean);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// Each figure's currency from what was written next to it and, for "$" or nothing, the place. A figure with no currency of
// its own takes the message's only stated one; with none stated and a US place it is read as US dollars and that is said;
// otherwise it is unknown. Run after every read and every merge (the city may arrive in a later message).
export function settleCurrency(o: Offer): Offer {
  const marks = o.marks;
  if (!marks) return o;
  const figs = (["base", "signing", "bonus", "bonus_target"] as Fig[]).filter((f) => f === "base" ? o.base != null || !!o.rate : o[f] != null);
  // Only this offer's own figures say its currency: another company's offer never lends its currency to this one.
  const stated = new Set(figs.map((f) => marks[f]).filter((m): m is string => !!m));
  const only = stated.size === 1 ? [...stated][0] : null, kind = placeKind(o);
  const other = [...stated].find((m) => CURRENCY_CODES.includes(m) && m !== "USD");
  const guess = (why: string): [string, string, boolean] => ["USD", `${NOT_STATED}: ${why}, so it is read as US dollars, which is an assumption; please confirm the currency`, true];
  // [currency, the fact to say, assumed]
  const settle = (own: string | null | undefined): [string, string | null, boolean] => {
    const m = own ?? only;
    if (!m) {
      if (stated.size === 0 && kind === "us") return ["USD", `${NOT_STATED}; read as US dollars because ${placeName(o)} is in the United States`, false];
      return stated.size === 0 && kind === "other" ? guess(`the figure has no currency and ${placeName(o)} is not a US place I can confirm`) : [UNKNOWN_CURRENCY, NOT_STATED, false];
    }
    if (m === "$") {
      if (kind === "other") return guess(`the dollar sign is all that was written and ${placeName(o)} is not a US place I can confirm`);
      if (kind !== "dollar") return ["USD", null, false];
      return other ? guess(`the dollar sign is written beside ${other} for ${placeName(o)}`) : [UNKNOWN_CURRENCY, `${NOT_STATED}: the dollar sign with ${placeName(o)} could mean US dollars or the local currency`, false];
    }
    return AMBIGUOUS[m] ? [UNKNOWN_CURRENCY, `${NOT_STATED}: ${AMBIGUOUS[m]}`, false] : [m, null, false];
  };
  const read = Object.fromEntries(figs.map((f) => [f, settle(marks[f])])) as Partial<Record<Fig, [string, string | null, boolean]>>;
  o.currencies = Object.fromEntries(figs.map((f) => [f, read[f]![0]]));
  o.currency_assumed = Object.fromEntries(figs.filter((f) => read[f]![2]).map((f) => [f, true]));
  // A competing figure with no currency of its own is read in this offer's only on an assumption (unless both are plainly US dollars).
  for (const c of o.competing) if ("mark" in c) { const [cur, , assumed] = settle(c.mark); c.currency = cur; c.assumed = assumed || (!c.mark && !(cur === "USD" && kind === "us")); }
  if (figs.includes("base")) o.currency = read.base![0]; else delete o.currency;
  // The fact said: the base's, else that of the first other figure read on an assumption.
  const g = figs.find((f) => f !== "base" && read[f]![2]);
  o.currency_fact = read.base?.[1] ?? (g ? `${g === "signing" ? "signing bonus" : "bonus"} ${read[g]![1]}` : null);
  const r = o.rate;
  o.period_fact = !r || o.part_year ? null : o.annualized ? `the yearly base is an estimate: ${rateIn(r.amount, o.currency)} ${PER[r.period]} x ${o.annualized.assumption}, as if that many are paid in a year`
    : `${rateIn(r.amount, o.currency)} ${PER[r.period]} is a daily rate; it is not turned into a yearly base because the days worked in a year were not given`;
  return o;
}
// An amount written in its own currency: "$87,600" for US dollars, "AUD 87,600" for any other; an amount whose currency is
// not known is written with no sign and says so. Never converted.
export function moneyIn(n: number, currency: string | null | undefined): string {
  const t = Math.round(n).toLocaleString("en-US");
  if (currency === UNKNOWN_CURRENCY) return `${t} (${NOT_STATED})`;
  return currency && currency !== "USD" ? `${currency} ${t}` : `$${t}`;
}
export const isUsd = (o: Pick<Offer, "currency">) => (o.currency ?? "USD") === "USD";
// The formatter a counter script writes each figure with: each in its own currency (D-069); the bare number when the
// currency is unknown; and a base said as a rate as that rate ("$6,500 a month"), never as the yearly estimate.
export const moneyFor = (o: Offer) => (n: number, field?: string) => {
  const c = field === "signing" ? (o.currencies?.signing ?? o.currency) : o.currency, bare = (x: string) => x.replace(` (${NOT_STATED})`, "");
  // 2026-11-13 round 2: a figure is written as the person wrote it, in its own period ("$90/hr", "£90k", "110k"); only a plain
  // yearly figure in stated US dollars is written out ("$110,000"). A rate is never restated as a yearly figure.
  const k: Fig | null = field === "signing" ? "signing" : field === undefined && n === o.base ? "base" : null;
  if (k && o.written?.[k] && !(c === "USD" && !o.currency_assumed?.[k] && !(k === "base" && o.rate))) return o.written[k]!;
  if (k === "base" && o.rate) return `${rateIn(o.rate.amount, c)} ${PER[o.rate.period]}`;
  return bare(field === undefined && o.rate && n === o.base ? `${rateIn(o.rate.amount, c)} ${PER[o.rate.period]}` : moneyIn(n, c));
};
// A rate keeps its cents ("$27.50 an hour").
export function rateIn(n: number, currency: string | null | undefined): string {
  const t = Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === UNKNOWN_CURRENCY) return `${t} (${NOT_STATED})`;
  return currency && currency !== "USD" ? `${currency} ${t}` : `$${t}`;
}
// ---------- the period ----------
// A yearly base worked out from a rate is an estimate, shown with the assumption it rests on. A daily rate has none.
export const PER: Record<Period, string> = { hour: "an hour", day: "a day", week: "a week", biweek: "every two weeks", semimonth: "twice a month", month: "a month", year: "a year" };
const ANNUAL: Partial<Record<Period, { factor: number; assumption: string }>> = { hour: { factor: 2080, assumption: "2,080 hours" }, week: { factor: 52, assumption: "52 weeks" },
  biweek: { factor: 26, assumption: "26 pay periods" }, semimonth: { factor: 24, assumption: "24 pay periods" }, month: { factor: 12, assumption: "12 months" } };
const RATE_RANGE: Record<string, [number, number]> = { hour: [7, 1000], day: [50, 10000], week: [100, 50000], biweek: [200, 100000], semimonth: [200, 100000], month: [500, 500000] };
const periodOf = (w: string): Period => { const x = w.toLowerCase().replace(/[- ]/g, ""); return /^(hr|hour|h$)/.test(x) ? "hour" : /^(day|dai)/.test(x) ? "day" : /^(twiceamonth|semimonth)/.test(x) ? "semimonth" : /^(biweek|twoweek|2week|otherweek|fortnight)/.test(x) ? "biweek" : /^(week|wk)/.test(x) ? "week" : /^mo/.test(x) ? "month" : "year"; };
const PERIOD_AFTER = /^(?:\s(?:base|salary|gross|net))?\s?(?:(?:\/|per\s|an?\s|each\s|every\s)\s?(hr|hour|h|day|two weeks|2 weeks|other week|fortnight|week|wk|month|mo|year|yr|annum)\b|(twice a month|semi-?monthly|hourly|daily|bi-?weekly|fortnightly|weekly|monthly|yearly|annually|annual)\b)/i;
const PERIOD_BEFORE = /\b(hourly|daily|bi-?weekly|fortnightly|weekly|monthly|yearly|annual)\s(?:(?:base|salary|pay|rate|wage)\s)?(?:(?:of|is|at)\s)?$/i;
// The offer's base as said, with its rate and the stated assumption behind a yearly figure.
export function rateNote(o: Offer, c: string | null | undefined): string {
  if (o.rate && o.annualized) return ` (${rateIn(o.rate.amount, c)} ${PER[o.rate.period]} x ${o.annualized.assumption})`;
  return o.hourly ? ` (${rateIn(o.hourly, c)} an hour x 2,080 hours)` : "";
}
// Why the offer is not placed against the public pay data, in one line; null when it is.
export function notPlaced(o: Offer): string | null {
  if (o.unsettled) return `I have not compared this offer with anything, because I could not place this: ${(o.open ?? []).join("; ")}.`;
  if (o.currency === UNKNOWN_CURRENCY) return `${cap(o.currency_fact ?? NOT_STATED)}. So it is not placed against any pay data, and nothing is converted. Tell me the offer again with its currency (USD, CAD, EUR ...) and I'll redo it.`;
  if (!isUsd(o)) return `The offer is in ${o.currency}. The public pay data on file is US data in US dollars, so it is not placed against it, and nothing is converted.`;
  if (o.currency_assumed?.base) return "The currency is an assumption until you confirm it, so the offer is not placed against any pay data.";
  if (o.part_year) return `You said ${o.part_year}, which is not a full year of full-time work, so the full-year pay data is not placed against it.`;
  return usMarket(o) ? null : `The public pay data on file is for the United States, and ${placeName(o)} is not a US place I can confirm, so the offer is not placed against it.`;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9$%.]+/g, " ").trim();
// A word or phrase, bounded so "c++" and "jpm" match only as themselves. With `names`, a short company alias (JPM, GS,
// HRT, Meta) matches only written as a name (JPM or Jpm, Meta or META), so "gs" or "meta" inside a sentence never
// names a company.
export function hasWord(text: string, w: string, names = false): boolean {
  const bound = (s: string) => `(?<![\\w+#])${esc(s)}(?![\\w+#])`;
  if (names && w.length <= 4 && /^[a-z]+$/.test(w)) {
    return new RegExp(`${bound(w.toUpperCase())}|${bound(w[0].toUpperCase() + w.slice(1))}`).test(text);
  }
  return new RegExp(bound(w), "i").test(text);
}

// ---------- reading the offer from the person's words ----------
// D-069: the words that answer "what is the job title?" or "what is the city?" (asked once about a half-told offer): "I'm a
// cybersecurity intern", "It's in Sydney", "cybersecurity intern in Scottsdale, Arizona". Only read as an answer to that ask.
const ANSWER_LEAD = /^\s*(?:(?:so|well|oh|ok|okay|yes|yeah|sure)[,!.]?\s+)?(?:(?:i'?m|i am|i'?ll be|i will be|it'?s|it is|it'?d be|it would be|that'?s|that is|the (?:job )?title is|my (?:job )?title is|title|role|the role is|position|as)\s*:?\s+)?(?:an?\s+|the\s+)?/i;
export function titleAnswer(text: string): string | null {
  const t = String(text ?? "").replace(ANSWER_LEAD, "").split(/(?:^|\s+)(?:in|at|based in|located in|out of)\s+|[,.;!?(]/i)[0].trim();
  if (!t || /\d/.test(t) || t.split(/\s+/).length > 7 || !/^[A-Za-z][A-Za-z&/+#' -]*$/.test(t) || NOT_TITLE_ANSWER.test(t)) return null;
  return t.replace(/\s+(?:role|position|job)$/i, "").toLowerCase();
}
// Not a title: "not sure", and a control phrase the person types to the agent ("help me negotiate", "correction: ...").
const NOT_TITLE_ANSWER = /^(?:not sure|no idea|dunno|don'?t know|idk|unsure|n\/a|none|nothing|skip|later|never ?mind|remote|hybrid)\b|\b(?:help|negotiat\w*|compare|counter|correction|actually|sorry|thanks|please|draft|email|offer)\b/i;
export function placeAnswer(text: string, onlyCity = true): string | null {
  const said = placeIn(text);
  if (said) return said;
  const raw = String(text ?? "");
  // Not asked alone, the bare words are a place only when they say so ("it's in ...", "in ...", "based in ...").
  if (!onlyCity && !/^\s*(?:(?:it'?s|it is|it'?d be|that'?s|the city is|city|the office is|i'?ll be|i will be)\s*:?\s+)?(?:in|based in|located in|out of)\s+|^\s*(?:the city is|city)\s*:?\s+/i.test(raw)) return null;
  const t = raw.replace(/^\s*(?:(?:it'?s|it is|it'?d be|that'?s|the city is|city|the office is|i'?ll be|i will be)\s*:?\s+)?(?:in|based in|located in|out of|at)\s+/i, "").replace(/^\s*(?:it'?s|it is|the city is|city)\s*:?\s+/i, "").replace(/[.!?]+$/, "").trim();
  if (!t || /\d/.test(t) || t.split(/\s+/).length > 6 || !/^[A-Za-z][A-Za-z.' -]*(?:,\s*[A-Za-z][A-Za-z.' -]*)?$/.test(t) || NOT_TITLE_ANSWER.test(t)) return null;
  return t;
}
const MONEY = new RegExp(String.raw`(?:(?<![\w.]|\d[,'])|(?<=\b(?:${CODE_RE}|RMB|Rs)))\$?\s?(\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:[,' ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|K|thousand|mm|million|m|M|lakhs?|lacs?|LPA|lpa|L|crores?|cr)?(?![\w])`, "g");
// Everything the figure's own words take, from the currency before it to the period after it: `text` is that span as written.
interface Amount { value: number; per: Period | null; at: number; end: number; mark: string | null; text: string; pre?: string }
// Round 3: a number that is not pay, from the words around it: a ZIP code after a city or state, an id ("employee id",
// "requisition", "req", "#"), a headcount ("a team of 12000 people"), a count of months of pay.
export function notPay(before: string, tok: string, after: string): boolean {
  if (/^\d{5}$/.test(tok) && /(?:\b[A-Z]{2}|[A-Z][a-z]+),?\s+$/.test(before)) return true;
  if (/(?:\b(?:id|no|number|requisition|req|ticket|ref|reference|badge|code|ext|extension)\b\.?|#)\s*:?\s*$/i.test(before)) return true;
  return /\bteam of\s+$/i.test(before) || /^\s?(?:people|employees|engineers|staff|users|customers|person|headcount)\b/i.test(after);
}
function amounts(clause: string): Amount[] {
  const out: Amount[] = [];
  for (const m of clause.matchAll(MONEY)) {
    let v = Number(m[1].replace(/[,' ]/g, ""));
    const unit = m[2] === "L" ? "lakh" : (m[2] || "").toLowerCase(), at = m.index ?? 0, end = at + m[0].length;
    if (unit === "k" || unit === "thousand") v *= 1000;
    else if (unit === "m" || unit === "mm" || unit === "million") v *= 1_000_000;
    else if (/^(?:lakh|lac|lpa)/.test(unit)) v *= 100_000;
    else if (/^cr/.test(unit)) v *= 10_000_000;
    const cm = currencyMark(clause, at, end), after = cm.after;
    // Lakh and crore count rupees: with no currency named, whose rupee is not known.
    const mark = cm.mark ?? (/^(?:lakh|lac|lpa|cr)/.test(unit) ? "lakh" : null);
    // The period said with the amount: right after it ("45 GBP/hr", "8k a month", "$3,000 biweekly") or right before ("monthly salary of 6,500").
    const post = PERIOD_AFTER.exec(clause.slice(end + after)), pm = post ?? PERIOD_BEFORE.exec(clause.slice(0, at));
    const per = unit === "lpa" ? "year" : pm ? periodOf(pm[1] ?? pm[2]) : null, rated = !!per && per !== "year";
    const dollar = !!mark;
    // "401k", "403(b)", "457b" name a retirement plan, never pay (LOOP 13: "a 4% 401k match" was read as a $401,000 base).
    if (!dollar && /^(?:401|403|457)$/.test(m[1]) && /^\s?\(?[kb]\)?/i.test(clause.slice(at + m[0].indexOf(m[1]) + m[1].length))) continue;
    // A bare small number is a count or a date, not pay: pay is "110k", "$110,000", "110000", "$45/hr" or "$1,500 a week".
    if (rated ? v < RATE_RANGE[per!][0] || v > RATE_RANGE[per!][1] : v < 1000) continue;
    if (!dollar && !unit && !rated && (v < 10000 || /^20\d\d$/.test(m[1]))) continue;
    if (!dollar && notPay(clause.slice(0, at), m[1], clause.slice(end))) continue;
    const lead = new RegExp(String.raw`(?:\b(?:${CODE_RE}|RMB|Rs|US|AU|CA|NZ|SG|HK|MX|[ACSR])\s?\$?|[€£¥￥₹₩₪])\s?$`).exec(clause.slice(0, at));
    const to = end + after + (post ? post[0].length : 0);
    out.push({ value: v, per, at: lead ? lead.index : at, end: to, mark, text: clause.slice(lead ? lead.index : at, to).trim(), pre: !post && pm ? pm[0] : undefined });
  }
  return out;
}
export function firmIn(text: string): any | null {
  const g = guide();
  let best: any = null, bestLen = 0;
  for (const f of g?.firms || []) {
    for (const a of [f.name, ...(f.aliases || [])]) {
      const w = String(a).toLowerCase();
      if (w.length > bestLen && hasWord(text, w, true)) { best = f; bestLen = w.length; }
    }
  }
  return best;
}
// A company not in the guide, named the way people say it: "Acme offered", "offer from Acme", "at Acme".
function namedCompany(text: string): string | null {
  const m = text.match(/\b([A-Z][\w&.'-]*(?:\s+(?:of\s+|and\s+|& )?[A-Z][\w&.'-]*){0,3})\s+(?:offered|is offering|gave me|made me an offer)/) ||
    text.match(/\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:will|might|may|could|should|is going to|is likely to) offer\b/) ||
    text.match(/\boffer (?:letter )?(?:from|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
  if (!m) return null;
  const name = m[1].replace(/^(?:I|My|The|An?|They|We)\s+/, "").trim();
  return name && !/^(I|My|The|They|We|So|Just|Also)$/.test(name) ? name : null;
}
function metroIn(text: string, maps: any): any | null {
  let best: any = null, bestLen = 0;
  for (const m of maps?.metros || []) for (const w of m.words) if (w.length > bestLen && hasWord(text, w)) { best = m; bestLen = w.length; }
  return best;
}
const ROLE_WORDS = ["investment banking analyst", "summer analyst", "ib analyst", "financial analyst", "research analyst", "business analyst",
  "data analyst", "data scientist", "software engineer", "software developer", "software development engineer", "machine learning engineer",
  "product manager", "associate consultant", "management consultant", "consultant", "quantitative researcher", "quantitative trader",
  "trader", "associate", "analyst", "engineer", "developer", "swe", "sde", "accountant", "auditor"];
function roleIn(text: string): string | null {
  for (const r of ROLE_WORDS) if (hasWord(text, r)) return r === "swe" || r === "sde" ? r.toUpperCase() : r;
  return null;
}
// D-069: the job title as the person said it ("as an advanced analytics intern", "as a cybersecurity intern in Scottsdale"),
// any title, in their words: at most 7 words, letters only (a title is never a figure), not a phrase that only looks like one.
const NOT_TITLE = /^(?:first|second|third|next|year|result|matter|whole|bonus|signing|base|offer|counter|backup|start|minimum|total|percentage|reminder|test|joke|favor|courtesy|starting point)\b/i;
const TITLE_STOP = String.raw`(?=\s+(?:in|at|based|located|out of|for|with|on|from|starting|and|but|plus|paying|making|earning|offered|remote|hybrid|onsite|on-site)\b|\s*[,.;!?(]|\s*$)`;
export function titleIn(text: string): string | null {
  const t = String(text ?? "");
  const m = new RegExp(String.raw`\b(?:as|for)\s+(?:an?|the|my)\s+([A-Za-z][A-Za-z&/+#'-]*(?:\s+[A-Za-z&/+#'-]+){0,6}?)` + TITLE_STOP, "i").exec(t)
    ?? new RegExp(String.raw`\b(?:title(?:\s+is)?|role(?:\s+is)?|position(?:\s+is)?)\s*:?\s+(?:an?\s+)?([A-Za-z][A-Za-z&/+#'-]*(?:\s+[A-Za-z&/+#'-]+){0,6}?)` + TITLE_STOP, "i").exec(t);
  const w = m?.[1]?.trim();
  if (!w || NOT_TITLE.test(w) || /\b(?:offer|offered|salary|base|signing|bonus)\b/i.test(w)) return null;
  return w.replace(/\s+(?:role|position|job)$/i, "").toLowerCase();
}
// D-069: the place the person named ("in Sydney", "in Lake Mary, Florida", "based in Warsaw, Poland"), any place: capitalized
// words after "in", "based in", "located in" or "out of", with one ", Region" after them. Not a month, a currency, a team.
const NOT_PLACE = new RegExp(`^(?:${CODE_RE}|January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|My|Our|Their|Total|Cash|Equity|Stock|Base|Salary|Year|Person|Office|RSUs?)\\b`);
export function placeIn(text: string): string | null {
  // A comma before a new sentence or another company's offer does not join it to the place ("in Seattle, I also ...").
  const t = String(text ?? "").replace(/,\s*(?=(?:I|It|It's|My|We|They|The|And|But|Also)\b|[A-Z][\w&.'-]*\s+(?:offered|is offering|gave|will)\b)/g, "; ");
  const P = String.raw`[A-Z][A-Za-z\u00C0-\u024F.'-]*(?:\s+(?:[A-Z][A-Za-z\u00C0-\u024F.'-]*|de|del|la|le|of|upon|am|an|sur))*?`;
  // "relocating from Toronto to Seattle" names the place the job is in last.
  const m = new RegExp(String.raw`\b(?:(?:relocating|moving|transferring)\s+from\s+${P}(?:,\s*${P})?\s+to|in|based in|located in|out of|relocating to|moving to)\s+(${P}(?:,\s*${P})?)(?=\s*(?:[;.!?()]|,(?!\s*[A-Z])|\s(?:as|for|with|and|but|plus|at|on|not|or|starting|paying|base|offered|office)\b|$))`).exec(t);
  const w = m?.[1]?.replace(/[.,]+$/, "").trim();
  if (!w || NOT_PLACE.test(w) || w.length > 80) return null;
  return w;
}
// Words that say a level or a kind of the same job, not another profession ("senior software engineer", "backend engineer intern").
const LEVEL = /^(?:senior|sr|junior|jr|staff|principal|lead|associate|entry|level|new|grad|graduate|summer|intern|i|ii|iii|iv|full|part|time|remote|embedded|backend|back|end|frontend|front|fullstack|stack|infrastructure|platform|mobile|ios|android|cloud|systems|web|ai|ml)$/;
// 2026-11-13 round 2: a title maps to a benchmark occupation only as a whole phrase from the table. "developer", "analyst" or
// "consultant" inside another profession ("real estate developer", "market research analyst", "sales consultant") is no match.
function occupationFor(role: string | null, sector: string | null, maps: any, title?: string | null): Offer["occupation"] {
  if (!role) return null;
  const r = (title && hasWord(title, role) ? title : role).toLowerCase();
  const occs: any[] = maps?.occupations || [];
  // The longest matching phrase wins ("investment banking analyst" over "analyst").
  let best: any = null, bestLen = 0, word = "";
  for (const o of occs) for (const w of o.words) if (w.length > bestLen && (r === w || hasWord(r, w))) { best = o; bestLen = w.length; word = w; }
  if (best && !r.replace(new RegExp(`(?<![\\w+#])${esc(word)}(?![\\w+#])`), " ").split(/[^a-z]+/).filter(Boolean).every((x) => LEVEL.test(x))) best = null;
  if (!best && /^(summer )?analyst$/.test(r) && sector) best = occs.find((o) => (o.analyst_sectors || []).includes(sector)) || null;
  return best ? { key: best.key, soc: best.soc, soc_title: best.soc_title, bls_national: best.bls_national ?? null } : null;
}
const DEADLINE = /\b(?:deadline(?: is)?|expires?(?: on)?|due|(?:answer|respond|reply|decide|sign|accept)(?: back)? by|need to (?:answer|decide|respond|reply|sign|accept)(?: by)?|have until|by)\s+((?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|end of (?:the )?(?:day|week|month)|eod|eow|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})/i;
const BENEFIT = /\b(relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)(?![\w])/i;
// An amount followed by a benefit's name ("$3,000 relocation") inside a clause that also states the pay.
const PERK = /\b(?:moving|housing|commuter|travel|visa|equipment|home office|wellness|gym|phone|internet|education|learning|match)\b/i;
const BENEFIT_AMOUNT = /^\s*(?:in |of |for )?(?:relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)/i;
const COMPETING = /\b(another offer|competing offer|other offer|second offer|also (?:have|got) an offer|also offered|offer from .+ too)\b|\balso have [A-Z][\w&.'-]* (?:at|for)\b/i;

// ---------- the completeness rule (2026-11-13 round 2) ----------
export const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/ /g, " ").replace(/\bRs\.\s?/g, "Rs ").replace(/\bp\.a\.?(?=\s|$)/gi, "per annum").replace(/\bU\.S\.A?\.?(?=\s|$)/g, "US").replace(/\bD\.C\.?/g, "DC").replace(/\bSt\.\s/g, "St ");
const EQUITY = /\b(?:equity|rsus?|stock|options|shares|vest\w*|cliff)\b/i;
const TOTAL = /\b(?:OTE|TC)\b|\b(?:total comp(?:ensation)?|total package|total pay|on[- ]target earnings|all[- ]in|total)\b/i;
// Not a full year of full-time work. Stated hours of 35 a week or more are full time and are not such a signal.
const PART_YEAR = /\b(\d{1,2})\s?(?:hrs?|hours)\s?(?:\/|a|per|each)\s?(?:week|wk)\b|\bpart[- ]time\b|\b\d{1,2}-(?:week|month)\b(?!\s*(?:cliff|vest))|\b\d{1,2}[- ](?:week|month|wk|mo|year|yr)s?(?=\s+(?:intern\w*|contract\w*|co-?op|placement|gig|program|term|fixed))|\bintern(?:ship)?\b|\bcontract(?:or)?\b|\bfixed[- ]term\b|\btemp(?:orary)?\b|\bseasonal\b|\bco-?op\b|\bpro[- ]rata\b|\b[1-4] days a week\b|\b0?\.\d+ FTE\b|\b\d{2}% FTE\b/gi;
const partYear = (t: string) => [...t.matchAll(PART_YEAR)].filter((m) => !(m[1] && Number(m[1]) >= 35)).map((m) => m[0].trim());
// Pay the person makes now, and the figure they say they want: neither is the offer's.
const CURRENT_PAY = /\b(?:currently|right now|at the moment|presently)\b[^.]*\b(?:make|making|earn|earning|paid|on)\b|\bmy current\b|\bI (?:make|earn)\b/i;
const WANTED = /\bI(?:'d| would)? (?:want|like|asked for|am asking for|countered (?:at|with)|am hoping for)\b|\basking for\b|\bmy (?:ask|target|number) is\b/i;
// Another offer counts only as the person's own, one they hold now: not a friend's, declined, expired or hoped-for one.
const NOT_OWN = /\b(?:friend|brother|sister|colleague|coworker|roommate|wife|husband|partner|cousin|someone|somebody)\b|\b(?:turned down|declined|rejected|expired|rescinded|withdr[ae]w\w*|pulled)\b|\b(?:might|may|could|should|expect\w*|hop(?:e|ing)|if I|would have|used to|last year|previous\w*|hypothetical\w*)\b/i;
const KNOWN_PLACE = /^(?:London|Paris|Berlin|Dublin|Munich|Amsterdam|Madrid|Barcelona|Zurich|Geneva|Stockholm|Oslo|Copenhagen|Warsaw|Tokyo|Shanghai|Beijing|Bangalore|Mumbai|Delhi|Hyderabad|Pune|Dubai|Tel Aviv|Lisbon|Milan|Rome|Vienna|Prague|Seoul|Manchester|Edinburgh)$/;
const RANGE = /\$?\d[\d,.]*\s?[kKmM]?\s?(?:-|–|—|\sto\s)\s?\$?\d[\d,.]*\s?[kKmM]\b|\bbetween\s+\$?\d[\d,.]*\s?[kKmM]?\s+and\s+\$?\d[\d,.]*\s?[kKmM]?/;
const LEFT_PERIOD = /\b1[3-6](?:th)? months?\b|\btwice a month\b|\bsemi-?monthly\b|\bbi-?monthly\b|\bper (?:hour|day|week|month|year|annum)\b|\/\s?(?:hr|hour|h|day|wk|week|mo|month|yr|year)\b|\ban hour\b|\ba (?:day|month|year)\b|\b(?:hourly|daily|weekly|bi-?weekly|fortnightly|monthly|annually|yearly)\b|\bevery (?:two|2|other) weeks\b/i;
const NOT_A_PLACE = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Q[1-4]|I|My|Our|Their|Total|Cash|Equity|Stock|Base|Salary|Year|Person|Office|RSUs?|PTO)\b/;
// What is left of the message once every field has taken its words: any money, currency, period, total-pay or place word still
// there was not understood, and is returned in the person's own words.
const isPlace = (w: string) => KNOWN_PLACE.test(w) || US_CITY.test(w) || DOLLAR_PLACE.test(w) || !!STATES[w.toLowerCase()] || (payData()?.maps?.metros ?? []).some((m: any) => (m.words as string[]).includes(w.toLowerCase()));
function leftOpen(rest: string): string[] {
  const open: string[] = [], said = (what: string, w: string) => { const x = `${what}: "${w.trim()}"`; if (!open.includes(x)) open.push(x); };
  for (const m of rest.matchAll(/\d[\d.,' ]*\d|\d/g)) {
    const tok = m[0].trim(), at = m.index ?? 0, after = rest.slice(at + m[0].length, at + m[0].length + 14), before = rest.slice(Math.max(0, at - 12), at), n = Number(tok.replace(/[,' ]/g, ""));
    if (/^\s?%/.test(after) || /^(?:401|403|457|1099)$/.test(tok) || /^(?:19|20)\d\d$/.test(tok) || notPay(rest.slice(0, at), tok, after)) continue;
    const unit = /^\s?(?:k|m|mm|thousand|million|lakhs?|lacs?|lpa|l|cr|crores?|kr)(?![a-z])/i.exec(after)?.[0] ?? "";
    const labelled = /^\s?(?:\+\s?)?(?:base|salary|bonus|signing)\b/i.test(after) || /(?:base|salary|bonus)\s?(?:of|is|:)?\s?$/i.test(before) || /[$€£¥￥₹₩₪]\s?$/.test(before);
    if (unit || n >= 1000 || labelled || (/^\d{1,3}[.,]\d{2,3}$/.test(tok) && !/^\d+\.\d{1,2}$/.test(tok))) said("a figure I did not use", tok + unit);
  }
  if (!open.length && /[$€£¥￥₹₩₪]|zł/.test(rest)) said("a currency sign with no figure I could read", /[$€£¥￥₹₩₪]|zł/.exec(rest)![0]);
  for (const w of freeCur(rest)) said("a currency I did not attach to a figure", w);
  const lakh = /\b(?:lakhs?|lacs?|crores?|lpa)\b/i.exec(rest); if (lakh && !open.length) said("a currency I did not attach to a figure", lakh[0]);
  const per = LEFT_PERIOD.exec(rest); if (per) said("a pay period I did not attach to a figure", per[0]);
  const tot = TOTAL.exec(rest); if (tot) said("total pay with no figure I could read", tot[0]);
  for (const m of rest.matchAll(/(?:\b(?:or|and|from)\s+|\/\s*)([A-Z][A-Za-z]+(?: [A-Z][a-z]+)?)\b/g)) if (isPlace(m[1])) said("a second place I did not use", m[1]);
  for (const m of rest.matchAll(/\b(?:in|to)\s+(?:the\s+)?([A-Z][A-Za-zÀ-ɏ'.-]*(?:,?\s+[A-Z][A-Za-zÀ-ɏ'.-]*)*)/g)) if (!NOT_A_PLACE.test(m[1]) && !codeOf(m[1])) said("a second place I did not use", m[1]);
  return open;
}

// One message, or one piece of it, read into an offer. Clauses are read one at a time so "110k base, 15k signing" puts
// each number with its own label, and a clause about another offer never becomes this offer's numbers. Every word a field
// takes is struck from `rest`; what is left is checked by leftOpen.
export function parseOfferWords(text: string, data: OfferData = payData(), opts: { asked?: readonly Field[] } = {}): Offer {
  const t = norm(String(text ?? ""));
  const maps = data?.maps;
  const offer: Offer = { company: null, firm_id: null, lca_company_id: null, sector: null, base: null, hourly: null, signing: null, bonus: null, bonus_pct: null,
    city: null, metro: null, metro_label: null, remote: false, role: null, occupation: null, competing: [], deadline: null };
  let rest = t;
  const open: string[] = [];
  const eat = (w: string | null | undefined) => { if (!w) return; const i = rest.toLowerCase().indexOf(w.toLowerCase()); if (i >= 0) rest = `${rest.slice(0, i)} | ${rest.slice(i + w.length)}`; };
  const eatAll = (re: RegExp) => { rest = rest.replace(re, " | "); };
  const range = RANGE.exec(t);
  if (range) { open.push(`a range, not one figure: "${range[0].trim()}"`); eat(range[0]); }
  // A sentence at a time: once a clause in it is about another offer, the rest of that sentence is too ("... from Meta for
  // 170k plus 30k signing"), so that offer's parts never attach to this one.
  const SPLIT = /,(?!\d{2},\d|\d{3})|\s+(?:and|but|plus|with|or)\s+/i;
  const main: string[] = [], aside: string[] = [];
  for (const sentence of t.split(/[;\n]|\.(?=\s|$)/).map((x) => x.trim()).filter(Boolean)) {
    const clauses = sentence.split(SPLIT).map((c) => c.trim()).filter(Boolean);
    const k = clauses.findIndex((c) => COMPETING.test(c) || (/\boffer(?:ed)?\b.*\btoo\b/i.test(c) && amounts(c).length));
    main.push(...(k < 0 ? clauses : clauses.slice(0, k)));
    if (k < 0) continue;
    const c = clauses[k], tail = sentence.slice(sentence.indexOf(c)), as = amounts(tail), a = as[0];
    aside.push(tail); eat(tail);
    // Only the person's own offer, held now, stated with one figure: anything else is not cited at all.
    if (!a || NOT_OWN.test(sentence) || /\b(?:from|at)\s+[A-Z][\w&.'-]*\b.*\b(?:from|at)\s+[A-Z]/.test(tail.replace(COMPETING, ""))) continue;
    const f = firmIn(c.replace(COMPETING, ""));
    const named = f ? f.name : (c.match(/\b(?:from|at|have)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/)?.[1] ?? null);
    const rated = !!a.per && a.per !== "year", f1 = rated ? ANNUAL[a.per!]?.factor ?? null : 1, where = placeIn(tail);
    // `plain`: a single yearly figure with no component named. Otherwise it is cited as written, component and all
    // ("$170k total comp", "170k plus 30k signing", "$170k as an intern"), and never weighed against this base.
    const rest1 = tail.slice(tail.indexOf(a.text) + a.text.length).replace(/\s+in\s+[A-Z][\w ,.'-]*$/, "").trim();
    const plain = as.length === 1 && !rated && !rest1 && !TOTAL.test(tail) && !partYear(tail).length && !/\b(?:signing|sign-on|bonus|equity|rsus?|stock|options)\b/i.test(tail);
    if (f1 != null) offer.competing.push({ company: named, base: a.value * f1, said: tail, mark: a.mark, written: plain ? a.text : `${a.text}${rest1 ? ` ${rest1}` : ""}`, rated, plain, abroad: !!where && readPlace(where, metroIn(where, maps)).kind !== "us" });
  }
  const body = main.join(", ");
  const firm = firmIn(body);
  if (firm) { offer.company = firm.name; offer.firm_id = firm.firm_id; offer.lca_company_id = firm.lca_company_id ?? null; offer.sector = firm.sector ?? null; }
  else offer.company = namedCompany(body);
  const from: NonNullable<Offer["from"]> = {};
  offer.from = from;
  const marks: NonNullable<Offer["marks"]> & { total?: string | null } = {}, written: NonNullable<Offer["written"]> = {};
  offer.marks = marks; offer.written = written;
  offer.bonus_target = null;
  const take = (a: Amount) => { eat(a.text); eat(a.pre?.trim()); };
  for (const c of main) {
    // Equity is kept as the person said it and never read as pay (the chat turn reads it; here its words are only struck).
    if (EQUITY.test(c) && !/\b(?:base|salary)\b/i.test(c)) { eat(c); continue; }
    const all = amounts(c), as = all.filter((a) => !BENEFIT_AMOUNT.test(c.slice(a.end, a.end + 40)));
    for (const a of all) if (!as.includes(a)) { take(a); }
    if (!as.length) { const p = c.match(/(\d{1,2}(?:\.\d+)?)\s?%\s*(?:target )?bonus|bonus(?: target)?(?: of)? (\d{1,2}(?:\.\d+)?)\s?%/i); if (p) { offer.bonus_pct = Number(p[1] ?? p[2]); from.bonus_pct = c; } continue; }
    // A relocation, a stipend or a retirement match is a benefit, never the base or a bonus (LOOP 13).
    if ((BENEFIT.test(c) || PERK.test(c)) && !/\b(base|salary)\b/i.test(c)) { eat(c); continue; }
    // What the person makes now, and the figure they want, are not the offer's.
    if (CURRENT_PAY.test(c)) { offer.current = as[0].text; eat(c); continue; }
    if (WANTED.test(c)) { offer.ask = { amount: as[0].value, written: as[0].text }; eat(c); continue; }
    // Total compensation, OTE or TC is not the base: the figure next to those words is kept as said, never compared.
    if (TOTAL.test(c)) {
      const ti = as.findIndex((x) => new RegExp(`(?:${TOTAL.source})\\s*(?:of|is|:|=)?\\s*$`, "i").test(c.slice(0, x.at)) || new RegExp(`^\\s*(?:in\\s+)?(?:${TOTAL.source})`, "i").test(c.slice(x.end)));
      const tot = ti >= 0 ? as.splice(ti, 1)[0] : !/\bbase\b/i.test(c) ? as.shift()! : null;
      if (tot) { offer.total = { amount: tot.value, written: tot.text }; take(tot); eatAll(TOTAL); }
      if (!as.length) continue;
    }
    const a = as[0];
    const rated = !!a.per && a.per !== "year";
    // "up to 150k" and "at least 150k" are a bound, not a figure.
    const lead = c.slice(0, a.at), bound = /\b(?:up to|as much as|at least|a minimum of|no less than|north of|upwards of)\s*$/i.exec(lead) ?? /^\+(?!\s*\$?\d)/.exec(c.slice(a.end));
    if (bound) open.push(`a bound, not one figure: "${`${/^\+/.test(bound[0]) ? "" : bound[0]}${a.text}${/^\+/.test(bound[0]) ? "+" : ""}`.trim()}"`);
    if (/sign(?:ing|-on| on)/i.test(c)) { offer.signing = a.value; from.signing = c; marks.signing = a.mark; written.signing = a.text; take(a); }
    else if (/bonus/i.test(c) && /\btarget\b/i.test(c)) { offer.bonus_target = a.value; from.bonus_target = c; marks.bonus_target = a.mark; take(a); }
    else if (/bonus/i.test(c)) { offer.bonus = a.value; from.bonus = c; marks.bonus = a.mark; take(a); }
    else if (/\b(base|salary|pay|offered|offer of|offering|comp|per year|a year|annual|\/yr)\b/i.test(c) || rated || (offer.base == null && !offer.rate)) {
      // Two figures that could each be the base: neither is chosen.
      if (offer.base != null || offer.rate) { open.push(`two figures that could each be the base: "${written.base}" and "${a.text}"`); take(a); continue; }
      // A rate is kept as said; the yearly base is rate x a stated assumption, or nothing for a daily rate.
      if (rated) { const y = ANNUAL[a.per!] ?? null; Object.assign(offer, { rate: { amount: a.value, period: a.per }, annualized: y, base: y ? Math.round(a.value * y.factor) : null, hourly: a.per === "hour" ? a.value : null, period: a.per }); }
      else Object.assign(offer, { rate: null, annualized: null, base: a.value, hourly: null, period: a.per === "year" || /\b(per year|a year|annual(?:ly)?|yearly|\/\s?yr|per annum)\b/i.test(c) ? "year" : null });
      from.base = c; marks.base = a.mark; written.base = a.text; take(a);
    }
  }
  // The place as said is read from the whole message: "Lake Mary, Florida" spans a comma the clauses are split on.
  let place = placeIn(aside.reduce((x, c) => x.replace(c, " "), t));
  let metro = metroIn(place ?? body, maps) ?? (place ? null : metroIn(body, maps));
  // An answer to the one ask: the title or the place as said, when the words are nothing else.
  if (opts.asked?.includes("city") && !metro && !place && !/\bremote\b/i.test(body)) place = placeAnswer(t, opts.asked.length === 1);
  const where = readPlace(place, metro);
  metro = where.metro;
  if (where.open) open.push(where.open);
  offer.place = place; offer.place_kind = where.kind; offer.state = where.state;
  if (metro) { offer.metro = metro.key; offer.metro_label = metro.label; offer.city = metro.label; }
  else if (place) offer.city = place;
  else if (/\bremote\b/i.test(body)) { offer.remote = true; offer.city = "remote"; }
  // The title answer is the words left once the place is taken out ("Seattle" alone names a place, never a title).
  const bare = () => {
    let x = t;
    if (offer.place) x = x.replace(new RegExp(`(?:\\b(?:in|based in|located in|out of)\\s+)?${esc(offer.place)}`, "i"), " ");
    for (const w of metro?.words ?? []) if (hasWord(x, w)) x = x.replace(new RegExp(`(?:\\b(?:in|based in|located in|out of)\\s+)?(?<![\\w+#])${esc(w)}(?![\\w+#])`, "i"), " ");
    return x.replace(/\s+/g, " ").trim();
  };
  const title = titleIn(body) ?? (opts.asked?.includes("role") && !roleIn(body) ? titleAnswer(bare()) : null);
  offer.title = title;
  // A title the pay data knows keeps its known role (the benchmark's words); any other stated title is the role as said.
  offer.role = roleIn(body) ?? title;
  offer.occupation = occupationFor(offer.role, offer.sector, maps, title);
  const d = t.match(DEADLINE);
  if (d) offer.deadline = { text: d[1] };
  // Not a full year of full-time work, as the person said it: the rate stays a rate.
  const part = partYear(aside.reduce((x, c) => x.replace(c, " "), t));
  offer.part_year = part.length ? part.join(", ") : null;
  // Strike what the fields above took, then read a currency said on its own ("paid in CAD") as the currency of every figure
  // that has none of its own (or only a "$", when it names a dollar); one that contradicts a figure stays open.
  for (const w of [place, title, d?.[0], offer.company, ...(metro?.words ?? []), ...(firm ? [firm.name, ...(firm.aliases ?? [])] : [])]) eat(w);
  eatAll(PART_YEAR); eatAll(/\b(?:relocating|moving|transferring)\s+from\s+[A-Z][\w'.-]*(?:,?\s[A-Z][\w'.-]*)*\s+to\b/g); eatAll(/\bpaid\s+(?:weekly|bi-?weekly|monthly|semi-?monthly|twice a month|every (?:two|other) weeks)\b/gi);
  eatAll(/\bnot\s+(?:in\s+)?[A-Z][\w'.-]*(?:\s[A-Z][\w'.-]*)*/g);
  const free = freeCur(rest), codes = new Set(free.map(currencyOf));
  const figs = (["base", "signing", "bonus", "bonus_target"] as Fig[]).filter((f) => marks[f] !== undefined);
  if (codes.size === 1 && [...codes][0] && figs.length) {
    const code = [...codes][0]!;
    if (figs.every((f) => !marks[f] || marks[f] === code || (marks[f] === "$" && DOLLARS.has(code)))) { for (const f of figs) { if (marks[f] !== code) delete written[f]; marks[f] = code; } eatAll(CUR_SAID); }
  }
  // A period word that only repeats the rate's own period ("it's hourly, $72/hr") is that rate's.
  if (offer.rate) for (let m = LEFT_PERIOD.exec(rest); m && !/months?$/.test(m[0]) && periodOf(m[0].replace(/^(?:per |an? |\/\s?)/i, "")) === offer.rate.period; m = LEFT_PERIOD.exec(rest)) eat(m[0]);
  open.push(...leftOpen(rest));
  if (offer.base != null && !offer.rate && offer.base > 5_000_000 && (!marks.base || marks.base === "$" || marks.base === "USD")) open.push(`"${written.base}" is far above any yearly base I can check; say the amount again`);
  offer.open = open; offer.unsettled = open.length > 0;
  return settleCurrency(offer);
}

// Later words fill what earlier words left open, and correct what they said.
export function mergeOffers(a: Offer, b: Offer, data: OfferData = payData()): Offer {
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "competing") continue;
    if (v !== null && v !== false && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  // A base said again replaces the whole of the earlier one: its rate, period and yearly figure go together.
  if (b.base != null || b.rate) for (const k of ["base", "hourly", "rate", "annualized", "period"] as const) out[k] = b[k] ?? null;
  out.competing = [...a.competing, ...b.competing].map((c) => ({ ...c }));
  out.from = { ...(a.from ?? {}), ...(b.from ?? {}) };
  out.currencies = { ...(a.currencies ?? {}), ...(b.currencies ?? {}) };
  out.currency = out.currencies.base ?? a.currency ?? b.currency;
  if (out.currency === undefined) delete out.currency;
  out.written = { ...(a.written ?? {}), ...(b.written ?? {}) };
  out.part_year = [a.part_year, b.part_year].filter(Boolean).join(", ") || null;
  // A place said again replaces the whole of the earlier one (its metro and state go with it).
  if (b.place != null || b.metro) for (const k of ["place", "city", "metro", "metro_label", "place_kind", "state"] as const) out[k] = b[k] ?? null;
  if (a.marks || b.marks) { out.marks = { ...(a.marks ?? {}), ...(b.marks ?? {}) }; settleCurrency(out); }
  out.occupation = occupationFor(out.role, out.sector, data?.maps, out.title);
  // What a piece left open stays open until the base is said again whole.
  out.open = b.base != null || b.rate ? [...(b.open ?? [])] : [...new Set([...(a.open ?? []), ...(b.open ?? [])])];
  out.unsettled = out.open.length > 0;
  out.part_year = [a.part_year, b.part_year].filter(Boolean).join(", ") || null;
  if (b.place == null && !b.metro && a.place_kind) { out.place_kind = a.place_kind; out.state = a.state ?? null; }
  return out as Offer;
}
export function missingOf(o: Offer): Field[] {
  return REQUIRED.filter((f) => f === "city" ? !o.city : f === "base" ? o.base == null : !o[f]);
}
// A daily rate is not a base salary: the ask says why it was not used.
export const rateAsk = (o: Offer) => o.rate && o.base == null && o.period_fact ? `${cap(o.period_fact)}. ` : "";
const ASK_WORDS: Record<Field, string> = { company: "the company", base: "the base salary", city: "the city", role: "the job title" };
export function askFor(missing: Field[], o?: Offer): string {
  const w = missing.map((f) => ASK_WORDS[f]);
  const list = w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0];
  return `${o ? rateAsk(o) : ""}To benchmark it I need ${list}. What ${missing.length > 1 ? "are they" : "is it"}?`;
}

// ---------- the benchmark ----------
function position(base: number, b: { median: number | null; p25: number | null; p75: number | null }): string | null {
  if (b.median == null) return null;
  const pct = Math.round(((base - b.median) / b.median) * 100);
  const vs = pct === 0 ? "right at the median" : `${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} the median`;
  let band = "";
  if (b.p25 != null && base < b.p25) band = ", under the 25th percentile";
  else if (b.p75 != null && base > b.p75) band = ", over the 75th percentile";
  else if (b.p25 != null && b.p75 != null) band = base < b.median ? ", between the 25th percentile and the median" : base > b.median ? ", between the median and the 75th percentile" : "";
  return `Your base is ${vs}${band}.`;
}
export function benchmarks(o: Offer, data: OfferData = payData()): Bench[] {
  const out: Bench[] = [];
  if (!o.occupation) return out;
  // D-069: the public pay data on file is US data in US dollars. An offer said in another currency is never placed against it
  // (that would need a conversion with a sourced rate, and a US market for a non-US job).
  // 2026-11-13: nor is an offer whose currency is not known, or one for a place code cannot confirm is in the United States.
  if (!isUsd(o) || !usMarket(o) || o.currency_assumed?.base || o.unsettled || o.part_year) return out;
  const occ = o.occupation;
  const base = o.base;
  // 1. The employer's own filed H-1B wages for this occupation and metro.
  const lca = data?.lca_wages;
  const lcaWhat = "Employers' filed wages for H-1B workers, not offers; a floor signal (the employer must pay at least this).";
  if (o.lca_company_id && o.metro) {
    const b: Bench = { kind: "lca", shown: false, label: `${o.company}'s own H-1B filings for ${occ.soc_title} in the ${o.metro_label}`, cite: "", what: lcaWhat,
      period: lca?.period ?? null, n: null, median: null, p25: null, p75: null, position: null, reason: null, source_url: lca?.source_url || "https://www.dol.gov/agencies/eta/foreign-labor/performance" };
    if (lca?.status !== "imported") b.reason = "not loaded yet";
    else {
      const cell = (lca.cells || []).find((c: any) => c.company_id === o.lca_company_id && c.soc === occ.soc && c.metro === o.metro);
      if (!cell) b.reason = `none on file for ${lca.period}`;
      else {
        b.n = cell.n;
        if (cell.n < MIN_N) b.reason = `only ${cell.n} filing${cell.n === 1 ? "" : "s"} in ${lca.period}, too few for a median`;
        else Object.assign(b, { shown: true, median: cell.median, p25: cell.p25, p75: cell.p75, cite: `${o.company}'s own H-1B filings for ${occ.soc_title} in the ${o.metro_label} (DOL LCA, ${lca.period}, ${cell.n} filings)` });
      }
    }
    out.push(b);
  }
  // 2. BLS OEWS for the occupation in the metro.
  const oews = data?.oews_metro;
  const oewsWhat = "What employers in the area paid people in this occupation, all levels of experience; not entry-level pay and not one employer's.";
  let oewsShown = false;
  if (o.metro) {
    const b: Bench = { kind: "oews", shown: false, label: `BLS pay for ${occ.soc_title} in the ${o.metro_label}`, cite: "", what: oewsWhat,
      period: oews?.reference_period ?? null, n: null, median: null, p25: null, p75: null, position: null, reason: null, source_url: oews?.source_url || "https://www.bls.gov/oes/tables.htm" };
    if (oews?.status !== "imported") b.reason = "not loaded yet";
    else {
      const cell = (oews.cells || []).find((c: any) => c.soc === occ.soc && c.metro === o.metro);
      if (!cell) b.reason = `none on file for ${oews.reference_period}`;
      else if (cell.median == null) b.reason = (cell.flags || []).includes("median_top_coded") ? "the median is above BLS's top published band" : "BLS did not release a median";
      else { Object.assign(b, { shown: true, n: cell.employment ?? null, median: cell.median, p25: cell.p25, p75: cell.p75, cite: `BLS OEWS for ${occ.soc_title} in the ${o.metro_label} (${oews.reference_period})` }); oewsShown = true; }
    }
    out.push(b);
  }
  // 3. The national median already on file, when the metro figure is not there.
  if (!oewsShown && occ.bls_national) {
    const bls = data?.bls_national;
    const rec = (bls?.occupations || []).find((r: any) => r.occupation === occ.bls_national);
    if (rec && Number.isFinite(rec.median_annual_wage_usd_may2024)) {
      out.push({ kind: "bls_national", shown: true, label: `BLS national median for ${rec.occupation.toLowerCase()}`, cite: `BLS's national median for ${rec.occupation.toLowerCase()} (May 2024)`,
        what: `All employers and experience levels, nationwide${o.metro_label ? `; not the ${o.metro_label}` : ""}, not entry level.`, period: "May 2024", n: rec.employment_2024 ?? null,
        median: rec.median_annual_wage_usd_may2024, p25: null, p75: null, position: null, reason: null, source_url: rec.source_url });
    }
  }
  if (base != null) for (const b of out) if (b.shown) b.position = position(base, b);
  return out;
}

// ---------- the reply ----------
function host(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function fit(lines: string[]): string[] {
  // Split on purpose at a line boundary so no message is over MAX_MESSAGE characters.
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    const next = cur ? `${cur}\n${l}` : l;
    if (next.length > MAX_MESSAGE && cur) { out.push(cur.trim()); cur = l; } else cur = next;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((m) => m.length > MAX_MESSAGE ? m.slice(0, MAX_MESSAGE - 3) + "..." : m);
}
export interface OfferResult {
  status: "ask" | "benchmarked" | "confirm";
  offer: Offer;
  missing: Field[];
  ask: string | null;
  benchmarks: Bench[];
  draft: { email: string; call: string; sent: false } | null;
  messages: string[];
}
// What was understood, field by field, in the offer's own terms.
export function readingOf(o: Offer): string[] {
  const c = o.currencies ?? {}, open = (o.open ?? []).join(" ");
  // Round 3: what is unclear is quoted in the person's words (in `open`), never restated as a guessed value.
  const pay = !/figure|range|bound|base|period|months|currency/.test(open), where = !/place|could be/.test(open), who = !/two figures/.test(open);
  return [who && o.company ? `company ${o.company}` : null, o.title ?? o.role ? `title ${o.title ?? o.role}` : null, where && o.city ? `place ${o.city === "remote" ? "remote" : o.metro_label ?? o.place ?? o.city}` : null,
    !pay ? null : o.rate ? `pay ${rateIn(o.rate.amount, c.base ?? o.currency)} ${PER[o.rate.period]}` : o.base != null ? `base ${moneyIn(o.base, c.base ?? o.currency)}` : null,
    pay && o.signing != null ? `signing bonus ${moneyIn(o.signing, c.signing)}` : null, pay && o.bonus != null ? `bonus ${moneyIn(o.bonus, c.bonus)}` : null, o.bonus_pct != null ? `target bonus ${o.bonus_pct}%` : null,
    o.total ? `total pay as you said it "${o.total.written}" (not the base)` : null, o.part_year ? `you said ${o.part_year}` : null, o.current ? `your pay now "${o.current}" (not the offer)` : null,
    o.ask ? `the figure you want "${o.ask.written}"` : null].filter((x): x is string => !!x);
}
// ---------- confirm before compare (owner decision 2026-11-13, D-078) ----------
// Reading free text by rule is wrong about one time in seven, so the reading is a step the person confirms. The offer as
// read is shown back in one short block (company, role, base with its currency and period as read, every other component
// as written, place, deadline; anything unclear marked "not sure") and nothing is compared, benchmarked, placed at a
// percentile or drafted until the person says a plain yes to THAT block: the yes is bound to the block's SHA-256 (the
// same exact-payload binding as the counter card and the outreach approvals), and a yes after another turn, or to a
// block that has since changed, confirms nothing. What then feeds the numbers and the counter is the confirmed Offer the
// block was printed from (the raw text is kept only for where each figure came from).
export const CONFIRM_TTL_MS = ASK_TTL_MS;
export const CONFIRM_ASK = "Is that right? Reply yes, or tell me what to change. I compare nothing and draft nothing until you confirm it.";
export interface ReadingExtra { equity?: string | null; benefits?: string[]; check?: boolean; estimate?: boolean; notGiven?: Field[] }
export function readingBlock(o: Offer, x: ReadingExtra = {}): string {
  const c = o.currencies ?? {};
  const notSure: string[] = [];
  const curOf = (k: Fig) => (k === "base" ? c.base ?? o.currency : c[k] ?? o.currency) ?? "USD";
  // The currency each figure was read in: stated, read from the place (said so), or not sure.
  const curWord = (k: Fig) => {
    const code = curOf(k);
    if (!known(code)) { notSure.push(`the currency of the ${k === "base" ? "base" : k === "signing" ? "signing bonus" : "bonus"} (not stated)`); return "currency not sure"; }
    if (o.currency_assumed?.[k]) { notSure.push(`the currency of the ${k === "base" ? "base" : k === "signing" ? "signing bonus" : "bonus"} (read as ${code}, which was not stated)`); return `${code}, not sure`; }
    return code;
  };
  const amt = (k: Fig, n: number) => { const code = curOf(k); return known(code) ? moneyIn(n, code) : Math.round(n).toLocaleString("en-US"); };
  const asWritten = (k: Fig) => o.written?.[k] ? ` (you wrote "${o.written[k]}")` : "";
  const lines: string[] = [];
  const who = x.check ? "Here is how I read your question" : x.estimate ? "Here is how I read this (your estimate of an offer)" : "Here is how I read this offer";
  lines.push(`${who}:`);
  if (!x.check || o.company) lines.push(`- Company: ${o.company ?? "not given"}`);
  lines.push(`- Role: ${o.title ?? o.role ?? "not given"}`);
  if (o.rate) lines.push(`- Base: ${o.rate.amount != null ? `${known(curOf("base")) ? rateIn(o.rate.amount, curOf("base")) : rateIn(o.rate.amount, "USD").replace(/^\$/, "")} ${PER[o.rate.period]}` : ""}, ${curWord("base")}${asWritten("base")}${o.part_year ? `; you said "${o.part_year}", so not a full year` : ""}`);
  else if (o.base != null) lines.push(`- Base: ${amt("base", o.base)} ${o.period === "year" || o.period == null ? "a year" : PER[o.period]}${o.period == null ? " (no period stated; read as yearly)" : ""}, ${curWord("base")}${asWritten("base")}`);
  else lines.push("- Base: not given");
  if (known(curOf("base")) && !o.currency_assumed?.base && o.currency_fact && /read as/.test(o.currency_fact)) lines.push(`- Currency: ${o.currency_fact}`);
  if (o.signing != null) lines.push(`- Signing bonus: ${amt("signing", o.signing)}, ${curWord("signing")}${asWritten("signing")}`);
  if (o.bonus != null) lines.push(`- Bonus: ${amt("bonus", o.bonus)}, ${curWord("bonus")}${asWritten("bonus")}`);
  if (o.bonus_target != null) lines.push(`- Target bonus: ${amt("bonus_target", o.bonus_target)} (not guaranteed)${asWritten("bonus_target")}`);
  if (o.bonus_pct != null) lines.push(`- Target bonus: ${o.bonus_pct}% of base (not guaranteed)`);
  if (o.total) lines.push(`- Total pay, as you wrote it: "${o.total.written}" (not the base)`);
  if (x.equity) lines.push(`- Equity, as you wrote it: ${x.equity}`);
  if (x.benefits?.length) lines.push(`- Benefits, as you wrote them: ${x.benefits.join("; ")}`);
  lines.push(`- Location: ${o.remote ? "remote" : o.metro_label ?? o.place ?? o.city ?? "not given"}`);
  if (o.deadline) lines.push(`- Deadline: ${o.deadline.text}`);
  for (const k of o.competing ?? []) lines.push(`- Another offer you mentioned: ${k.company ?? "a company not named"}, ${k.written ?? moneyIn(k.base, k.currency)}${k.assumed ? " (currency not sure)" : ""}`);
  if (o.ask) lines.push(`- The figure you want: "${o.ask.written}"`);
  // The pay they make now is never said back (it is not the offer, and it is theirs to keep private); it is only left out.
  for (const q of o.open ?? []) notSure.push(q);
  if (notSure.length) lines.push(`- Not sure: ${[...new Set(notSure)].join("; ")}`);
  lines.push(CONFIRM_ASK);
  return lines.join("\n");
}
// SHA-256 (FIPS 180-4) of the block's UTF-8 bytes, hex: the same digest crypto.subtle gives (checked in the D-078 test), done
// in place so the brain's offer tool keeps its synchronous shape.
const K256 = Array.from({ length: 64 }, (_, i) => { let n = 2, c = 0; for (;; n++) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p && c++ === i) break; } return (Math.cbrt(n) % 1) * 2 ** 32 >>> 0; });
export function readingHash(block: string): string {
  const b = new TextEncoder().encode(block), l = b.length, words = new Uint32Array(((l + 9 + 63) >> 6) << 4);
  for (let i = 0; i < l; i++) words[i >> 2] |= b[i] << (24 - (i % 4) * 8);
  words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
  words[words.length - 1] = l * 8; words[words.length - 2] = Math.floor(l / 2 ** 29);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Uint32Array(64);
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let j = 0; j < words.length; j += 16) {
    for (let t = 0; t < 64; t++) W[t] = t < 16 ? words[j + t] : (r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10)) + W[t - 7] + (r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3)) + W[t - 16];
    let [a, bb, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) >>> 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    [a, bb, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map((v) => v.toString(16).padStart(8, "0")).join("");
}
// A plain yes to the block shown, in this message alone: 122's confirmationReply (the reader every fact confirmation uses).
export const plainYes = (message: string) => (CareerProfile as any).confirmationReply(String(message ?? "")).kind === "yes";
export const plainNo = (message: string) => (CareerProfile as any).confirmationReply(String(message ?? "")).kind === "no";

// The reply to an offer that is not settled: what was read, what was not, and the ask. No figure is compared or drafted.
export function unsettledText(o: Offer): string {
  const read = readingOf(o);
  return `${read.length ? `Here is what I read: ${read.join("; ")}. ` : ""}I could not place this: ${(o.open ?? []).join("; ")}. So I have not compared the offer with anything or drafted a counter. Tell me the offer again in one line (company, title, city and state, the base with its currency and whether it is per year, month, week or hour) and I'll redo it.`;
}
export function offerReply(o: Offer, notGiven: Field[], data: OfferData = payData()): OfferResult {
  if (o.unsettled) { const ask = unsettledText(o); return { status: "ask", offer: o, missing: notGiven, ask, benchmarks: [], draft: null, messages: fit([ask]) }; }
  const bench = benchmarks(o, data);
  const c = o.currencies ?? {};
  const parts = [o.company, o.title ?? o.role, o.city === "remote" ? "remote" : o.metro_label ?? o.place ?? o.city, o.base != null && !(o.rate && o.part_year) ? `base ${moneyIn(o.base, c.base ?? o.currency)}${rateNote(o, c.base ?? o.currency)}` : o.rate ? rateThenEstimate(o, c.base ?? o.currency) : null,
    o.signing != null ? `signing ${moneyIn(o.signing, c.signing)}` : null, o.bonus != null ? `bonus ${moneyIn(o.bonus, c.bonus)}` : null, o.bonus_pct != null ? `target bonus ${o.bonus_pct}%` : null, o.total ? `total pay as you said it ${o.total.written} (not the base, not compared)` : null].filter(Boolean);
  const lines: string[] = [`Your offer: ${parts.join(", ")}.`];
  if (notGiven.length) lines.push(`Not given: ${notGiven.map((f) => ASK_WORDS[f]).join(", ")}, so I left ${notGiven.length > 1 ? "those" : "that"} out of the comparison.`);
  const why = notPlaced(o);
  if (o.currency_fact && known(o.currency)) lines.push(`${cap(o.currency_fact)}.`);
  if (o.period_fact) lines.push(`${cap(o.period_fact)}.`);
  if (why) lines.push(why);
  else if (!o.occupation) lines.push(o.role ? `I don't have public pay data mapped to "${o.role}" at ${o.sector ? `a ${o.sector} firm` : "this employer"}, so there is no occupation benchmark.` : "Without the job title there is no occupation to benchmark against.");
  const urls: string[] = [];
  for (const b of bench) {
    if (b.shown) {
      lines.push("");
      lines.push(`${b.label}, ${b.period}${b.kind === "lca" ? `, ${b.n} filings` : b.n ? `, about ${b.n.toLocaleString("en-US")} people employed` : ""}: median ${usd(b.median!)}${b.p25 != null && b.p75 != null ? ` (middle half ${usd(b.p25)} to ${usd(b.p75)})` : ""}.`);
      lines.push(`What it is: ${b.what}`);
      if (b.position) lines.push(b.position);
      urls.push(b.source_url);
    } else {
      lines.push("");
      lines.push(`${b.label}: ${b.reason}.`);
    }
  }
  const shown = bench.filter((b) => b.shown);
  if (o.occupation && !why && !shown.length) lines.push("", "So I have no public number to place your offer against yet, and I won't make one up.");
  // A rate is never set against a yearly median in a counter, and only a like-for-like competing offer is weighed.
  const firstUp = o.rate ? undefined : shown.find((b) => b.median != null);
  const script = (CareerNegotiation as any).factScript({ company: o.company, role: o.title ?? o.role, base: o.base, signing: o.signing },
    { competing: o.competing.filter((x) => comparable(o, x)).map((x) => ({ ...x })), deadline: o.deadline, benchmark: firstUp ? { median: firstUp.median, cite: firstUp.cite } : null, money: moneyFor(o) });
  const uniq = [...new Set(urls)];
  if (uniq.length) lines.push("", "Sources:", ...uniq);
  const draftLines = ["A counter you could send. Nothing is sent: edit it and send it yourself.", "", script.email, "", "On a call:", script.call];
  return {
    status: "benchmarked", offer: o, missing: notGiven, ask: null, benchmarks: bench,
    draft: { email: script.email, call: script.call, sent: false },
    messages: [...fit(lines), ...fit(draftLines)],
  };
}

// ---------- the tool's turn: read, ask once, answer ----------
// D-078: `reading` is the block last shown for the person's yes (its hash, its time and the pieces it was read from).
export interface OfferPending { v: 1; pieces: string[]; asked: Field[]; at: number; reading?: { hash: string; block: string; at: number; missing: Field[] } }
export function offerTurn(o: { words: string; pending: OfferPending | null; now: number; data?: OfferData; lastReply?: string | null }): { result: OfferResult; pending: OfferPending | null } {
  const data = o.data ?? payData();
  const fresh = o.pending && o.now - o.pending.at < ASK_TTL_MS ? o.pending : null;
  // D-078: the person's plain yes to the reading shown in the reply just before this one confirms exactly that reading. The
  // offer is read again from the same pieces; it must print the same block (hash), or nothing is confirmed.
  const shown = o.pending?.reading && o.now - o.pending.reading.at < CONFIRM_TTL_MS ? o.pending.reading : null;
  if (shown && plainYes(o.words)) {
    const offer = o.pending!.pieces.map((p, i) => parseOfferWords(p, data, i ? { asked: o.pending!.asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
    const block = readingBlock(offer, { notGiven: shown.missing });
    const before = typeof o.lastReply === "string" && o.lastReply.trim() ? o.lastReply : null;
    if (block === shown.block && readingHash(block) === shown.hash && (!before || before.includes(block))) return { result: offerReply(offer, shown.missing, data), pending: null };
    const again = { hash: readingHash(block), block, at: o.now, missing: shown.missing };
    return { result: { status: "confirm", offer, missing: shown.missing, ask: block, benchmarks: [], draft: null, messages: [`That yes was not to the reading shown just before it, so it confirms nothing.\n${block}`] }, pending: { ...o.pending!, at: o.now, reading: again } };
  }
  const now = parseOfferWords(o.words, data);
  // A new offer (another company with its own base) starts over instead of mixing two offers.
  let pieces = fresh ? [...fresh.pieces, o.words] : [o.words];
  let asked = fresh ? fresh.asked : [];
  if (fresh && now.company && now.base != null) {
    const before = fresh.pieces.map((p, i) => parseOfferWords(p, data, i ? { asked: fresh.asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
    if (before.company && before.company !== now.company) { pieces = [o.words]; asked = []; }
  }
  // A reading was shown and this message is not a yes: it corrects the reading (read on top of the same pieces) or starts
  // another offer; either way the reading is shown again before anything is compared.
  if (shown && !(now.company && now.base != null)) { pieces = [...o.pending!.pieces, o.words]; asked = o.pending!.asked; }
  const offer = pieces.map((p, i) => parseOfferWords(p, data, i ? { asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
  const missing = missingOf(offer);
  if (missing.length && !asked.length) {
    const ask = askFor(missing, offer);
    return { result: { status: "ask", offer, missing, ask, benchmarks: [], draft: null, messages: [ask] }, pending: { v: 1, pieces, asked: missing, at: o.now } };
  }
  // Not settled: the restatement and the ask, as before (nothing is compared, so there is nothing to confirm yet).
  if (offer.unsettled) return { result: offerReply(offer, missing, data), pending: null };
  // Asked once already: what is still missing is said, never asked again; the reading is shown for the person's yes.
  const block = readingBlock(offer, { notGiven: missing });
  return { result: { status: "confirm", offer, missing, ask: block, benchmarks: [], draft: null, messages: [block] }, pending: { v: 1, pieces, asked, at: o.now, reading: { hash: readingHash(block), block, at: o.now, missing } } };
}
// The words must be the person's own, from this turn's message.
export function saidIn(message: string, words: string): boolean {
  const w = plain(words), m = plain(message);
  return !!w && ` ${m} `.includes(` ${w} `);
}
export { host as sourceHost };
