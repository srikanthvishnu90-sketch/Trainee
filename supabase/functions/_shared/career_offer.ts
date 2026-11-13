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
import { CareerNegotiation, CareerPaths } from "./router_core.career.js";

export const MIN_N = 5; // the fewest filings a median may come from
export const ASK_TTL_MS = 24 * 3600_000; // a half-told offer waits this long for the missing pieces
export const REQUIRED = ["company", "base", "city", "role"] as const;
export type Field = typeof REQUIRED[number];
export const MAX_MESSAGE = 1500;

export interface Competing { company: string | null; base: number; said: string; currency?: string; mark?: string | null }
export type Period = "hour" | "day" | "week" | "biweek" | "month" | "year";
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
  currency_fact?: string | null; marks?: Partial<Record<Fig, string | null>>;
  rate?: { amount: number; period: Period } | null; annualized?: { factor: number; assumption: string } | null; period_fact?: string | null;
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
const WORD_CUR: [RegExp, string][] = [[/^\s?(?:us|u\.s\.|american)\s?dollars?\b/i, "USD"], [/^\s?(?:canadian|cdn)(?:\s?dollars?)?\b/i, "CAD"], [/^\s?(?:australian|aussie)(?:\s?dollars?)?\b/i, "AUD"],
  [/^\s?(?:new zealand|nz|kiwi)\s?dollars?\b/i, "NZD"], [/^\s?singapore(?:an)?\s?dollars?\b/i, "SGD"], [/^\s?hong kong\s?dollars?\b/i, "HKD"], [/^\s?(?:dollars?|bucks)\b/i, "$"],
  [/^\s?euros?\b/i, "EUR"], [/^\s?(?:pounds?|quid)(?:\s+sterling)?\b/i, "GBP"], [/^\s?(?:indian\s)?rupees?\b/i, "INR"], [/^\s?(?:z[łl]oty|zlotys?|zł)(?![\w])/i, "PLN"],
  [/^\s?(?:japanese\s)?yen\b/i, "JPY"], [/^\s?(?:chinese\s)?(?:yuan|renminbi)\b/i, "CNY"], [/^\s?(?:swiss\s)?francs?\b/i, "CHF"], [/^\s?swedish\s?(?:kronor|krona)\b/i, "SEK"],
  [/^\s?norwegian\s?(?:kroner|krone)\b/i, "NOK"], [/^\s?danish\s?(?:kroner|krone)\b/i, "DKK"], [/^\s?(?:kr|kronor|krona|kroner|krone)\b/i, "kr"],
  [/^\s?mexican\s?pesos?\b/i, "MXN"], [/^\s?pesos?\b/i, "pesos"], [/^\s?(?:brazilian\s)?rea(?:is|ls?)\b/i, "BRL"]];
const AMBIGUOUS: Record<string, string> = { "kr": `"kr" could be Swedish, Norwegian, Danish or Icelandic kronor (SEK, NOK, DKK or ISK)`, "¥": `"¥" is the sign of both the Japanese yen and the Chinese yuan`,
  "pesos": `"pesos" could be Mexican, Argentine, Chilean, Colombian or Philippine pesos` };
// What is written next to an amount: an ISO code, or the mark as said when it is ambiguous ("$", "kr", "¥", "pesos"); null
// when nothing is. `after` is how much of the text after the amount the currency's own words take.
export function currencyMark(text: string, at: number, end: number): { mark: string | null; after: number } {
  const before = text.slice(Math.max(0, at - 8), at), rest = text.slice(end, end + 30);
  const pre = codeOf(new RegExp(`(?:^|[^A-Za-z])(${CODE_RE}|RMB)\\$?\\s?$`, "i").exec(before)?.[1]);
  if (pre) return { mark: pre, after: 0 };
  const post = new RegExp(`^\\s?(${CODE_RE}|RMB)(?![A-Za-z])`, "i").exec(rest);
  if (codeOf(post?.[1])) return { mark: codeOf(post![1]), after: post![0].length };
  const sym = /(?:^|[^A-Za-z])([A-Z]{1,2})\$\s?$/.exec(text.slice(at, at + 1) === "$" ? `${before}$` : before)?.[1];
  if (sym && DOLLAR_PREFIX[sym]) return { mark: DOLLAR_PREFIX[sym], after: 0 };
  if (/(?:^|[^A-Za-z])Rs\.?\s?$/.test(before)) return { mark: "INR", after: 0 };
  for (const [k, v] of Object.entries(SYMBOL)) { if (before.trimEnd().endsWith(k)) return { mark: v, after: 0 }; if (rest.trimStart().startsWith(k)) return { mark: v, after: rest.indexOf(k) + k.length }; }
  for (const [re, v] of WORD_CUR) { const m = re.exec(rest); if (m) return { mark: v, after: m[0].length }; }
  if (text.slice(at, end).includes("$") || /\$\s?$/.test(before)) return { mark: "$", after: 0 };
  return { mark: null, after: 0 };
}
// ---------- the place: is it in the United States? ----------
const US_STATE = /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|United States|USA|U\.S\.A?\.?)\b|,\s*(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|US)\b/;
const DOLLAR_PLACE = /\b(?:Canada|Toronto|Vancouver|Montreal|Ottawa|Calgary|Edmonton|Waterloo|Winnipeg|Quebec|Ontario|British Columbia|Alberta|Mississauga|Halifax|Australia|Sydney|Melbourne|Brisbane|Perth|Adelaide|Canberra|New Zealand|Auckland|Wellington|Christchurch|Singapore|Hong Kong|Taiwan|Taipei|Mexico|Guadalajara|Monterrey|Argentina|Buenos Aires|Chile|Santiago|Colombia|Bogota|Medellin|Brazil|Sao Paulo|Rio de Janeiro|Jamaica|Bahamas|Barbados|Trinidad|Fiji|Uruguay|Montevideo|Dominican Republic|Philippines|Manila|Cuba|Liberia|Namibia|Belize|Guyana)\b/i;
// "us": a metro the pay data knows, or a named US state. "none": remote or not said. "dollar": a place whose own money is a
// dollar or a peso. "other": any other place, which code cannot confirm is in the United States.
export function placeKind(o: Pick<Offer, "metro" | "place" | "city" | "remote">): "us" | "none" | "dollar" | "other" {
  if (o.metro) return "us";
  const p = o.place ?? (o.city && o.city !== "remote" ? o.city : null);
  if (!p) return "none";
  return US_STATE.test(p) ? "us" : DOLLAR_PLACE.test(p) ? "dollar" : "other";
}
const placeName = (o: Offer) => o.metro_label ?? o.place ?? o.city ?? "the place";
// US pay data is placed only against a US-dollar offer for a US place (or one with no place said, or remote).
export const usMarket = (o: Offer) => ["us", "none"].includes(placeKind(o));
export const known = (c: string | null | undefined) => !!c && c !== UNKNOWN_CURRENCY;
// Two amounts are in one currency only when both currencies are known and equal (a legacy offer on file with none is USD).
export const sameCurrency = (a: string | null | undefined, b: string | null | undefined) => known(a ?? "USD") && (a ?? "USD") === (b ?? "USD");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// Each figure's currency from what was written next to it and, for "$" or nothing, the place. A figure with no currency of
// its own takes the message's only stated one; with none stated and a US place it is read as US dollars and that is said;
// otherwise it is unknown. Run after every read and every merge (the city may arrive in a later message).
export function settleCurrency(o: Offer): Offer {
  const marks = o.marks;
  if (!marks) return o;
  const figs = (["base", "signing", "bonus", "bonus_target"] as Fig[]).filter((f) => f === "base" ? o.base != null || !!o.rate : o[f] != null);
  const stated = new Set([...figs.map((f) => marks[f]), ...o.competing.map((c) => c.mark)].filter((m): m is string => !!m));
  const only = stated.size === 1 ? [...stated][0] : null, kind = placeKind(o);
  const settle = (own: string | null | undefined): [string, string | null] => {
    const m = own ?? only;
    if (!m) return stated.size === 0 && kind === "us" ? ["USD", `${NOT_STATED}; read as US dollars because ${placeName(o)} is in the United States`] : [UNKNOWN_CURRENCY, NOT_STATED];
    if (m === "$") return kind === "dollar" ? [UNKNOWN_CURRENCY, `${NOT_STATED}: the dollar sign with ${placeName(o)} could mean US dollars or the local currency`] : ["USD", null];
    return AMBIGUOUS[m] ? [UNKNOWN_CURRENCY, `${NOT_STATED}: ${AMBIGUOUS[m]}`] : [m, null];
  };
  o.currencies = Object.fromEntries(figs.map((f) => [f, settle(marks[f])[0]]));
  for (const c of o.competing) if ("mark" in c) c.currency = settle(c.mark)[0];
  if (figs.includes("base")) { [o.currency, o.currency_fact] = settle(marks.base); } else { delete o.currency; o.currency_fact = null; }
  const r = o.rate;
  o.period_fact = !r ? null : o.annualized ? `the yearly base is an estimate: ${rateIn(r.amount, o.currency)} ${PER[r.period]} x ${o.annualized.assumption}, as if that many are paid in a year`
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
export const PER: Record<Period, string> = { hour: "an hour", day: "a day", week: "a week", biweek: "every two weeks", month: "a month", year: "a year" };
const ANNUAL: Partial<Record<Period, { factor: number; assumption: string }>> = { hour: { factor: 2080, assumption: "2,080 hours" }, week: { factor: 52, assumption: "52 weeks" },
  biweek: { factor: 26, assumption: "26 pay periods" }, month: { factor: 12, assumption: "12 months" } };
const RATE_RANGE: Record<string, [number, number]> = { hour: [7, 1000], day: [50, 10000], week: [100, 50000], biweek: [200, 100000], month: [500, 500000] };
const periodOf = (w: string): Period => { const x = w.toLowerCase().replace(/[- ]/g, ""); return /^(hr|hour|h$)/.test(x) ? "hour" : /^(day|dai)/.test(x) ? "day" : /^(biweek|twoweek|2week|otherweek|fortnight)/.test(x) ? "biweek" : /^(week|wk)/.test(x) ? "week" : /^mo/.test(x) ? "month" : "year"; };
const PERIOD_AFTER = /^(?:\s(?:base|salary|gross|net))?\s?(?:(?:\/|per\s|an?\s|each\s|every\s)\s?(hr|hour|h|day|two weeks|2 weeks|other week|fortnight|week|wk|month|mo|year|yr|annum)\b|(hourly|daily|bi-?weekly|fortnightly|weekly|monthly|yearly|annually|annual)\b)/i;
const PERIOD_BEFORE = /\b(hourly|daily|bi-?weekly|fortnightly|weekly|monthly|yearly|annual)\s(?:(?:base|salary|pay|rate|wage)\s)?(?:(?:of|is|at)\s)?$/i;
// The offer's base as said, with its rate and the stated assumption behind a yearly figure.
export function rateNote(o: Offer, c: string | null | undefined): string {
  if (o.rate && o.annualized) return ` (${rateIn(o.rate.amount, c)} ${PER[o.rate.period]} x ${o.annualized.assumption})`;
  return o.hourly ? ` (${rateIn(o.hourly, c)} an hour x 2,080 hours)` : "";
}
// Why the offer is not placed against the public pay data, in one line; null when it is.
export function notPlaced(o: Offer): string | null {
  if (o.currency === UNKNOWN_CURRENCY) return `${cap(o.currency_fact ?? NOT_STATED)}. So it is not placed against any pay data, and nothing is converted. Tell me the offer again with its currency (USD, CAD, EUR ...) and I'll redo it.`;
  if (!isUsd(o)) return `The offer is in ${o.currency}. The public pay data on file is US data in US dollars, so it is not placed against it, and nothing is converted.`;
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
const NOT_TITLE_ANSWER = /^(?:not sure|no idea|dunno|don'?t know|idk|unsure|n\/a|none|nothing|skip|later|never ?mind|remote|hybrid)\b/i;
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
const MONEY = /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|K|thousand|m|M)?(?![\w])/g;
interface Amount { value: number; per: Period | null; at: number; end: number; mark: string | null }
function amounts(clause: string): Amount[] {
  const out: Amount[] = [];
  for (const m of clause.matchAll(MONEY)) {
    let v = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").toLowerCase(), at = m.index ?? 0, end = at + m[0].length;
    if (unit === "k" || unit === "thousand") v *= 1000;
    else if (unit === "m") v *= 1_000_000;
    const { mark, after } = currencyMark(clause, at, end);
    // The period said with the amount: right after it ("45 GBP/hr", "8k a month", "$3,000 biweekly") or right before ("monthly salary of 6,500").
    const post = PERIOD_AFTER.exec(clause.slice(end + after)), pm = post ?? PERIOD_BEFORE.exec(clause.slice(0, at));
    const per = pm ? periodOf(pm[1] ?? pm[2]) : null, rated = !!per && per !== "year";
    const dollar = !!mark;
    // "401k", "403(b)", "457b" name a retirement plan, never pay (LOOP 13: "a 4% 401k match" was read as a $401,000 base).
    if (!dollar && /^(?:401|403|457)$/.test(m[1]) && /^\s?\(?[kb]\)?/i.test(clause.slice(at + m[0].indexOf(m[1]) + m[1].length))) continue;
    // A bare small number is a count or a date, not pay: pay is "110k", "$110,000", "110000", "$45/hr" or "$1,500 a week".
    if (rated ? v < RATE_RANGE[per!][0] || v > RATE_RANGE[per!][1] : v < 1000) continue;
    if (!dollar && !unit && !rated && (v < 10000 || /^20\d\d$/.test(m[1]))) continue;
    out.push({ value: v, per, at, end: end + after + (post ? post[0].length : 0), mark });
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
  const m = text.match(/\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:offered|is offering|gave me|made me an offer)/) ||
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
const NOT_TITLE = /^(?:result|matter|whole|bonus|signing|base|offer|counter|backup|start|minimum|total|percentage|reminder|test|joke|favor|courtesy|starting point)\b/i;
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
const NOT_PLACE = new RegExp(`^(?:${CODE_RE}|January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4]|My|Our|Their|Total|Cash|Equity|Stock|Base|Salary|Year|Person|Office)\b`);
export function placeIn(text: string): string | null {
  const t = String(text ?? "");
  const P = String.raw`[A-Z][A-Za-z.'-]*(?:\s+(?:[A-Z][A-Za-z.'-]*|de|del|la|le|of|upon|am|an|sur))*?`;
  const m = new RegExp(String.raw`\b(?:in|based in|located in|out of|relocating to|moving to)\s+(${P}(?:,\s*${P})?)(?=\s*(?:[;.!?()]|,(?!\s*[A-Z])|\s(?:as|for|with|and|but|plus|at|on|starting|paying|base|offered)\b|$))`).exec(t);
  const w = m?.[1]?.replace(/[.,]+$/, "").trim();
  if (!w || NOT_PLACE.test(w) || w.length > 80) return null;
  return w;
}
function occupationFor(role: string | null, sector: string | null, maps: any): Offer["occupation"] {
  if (!role) return null;
  const r = role.toLowerCase();
  const occs: any[] = maps?.occupations || [];
  // The longest matching phrase wins ("investment banking analyst" over "analyst").
  let best: any = null, bestLen = 0;
  for (const o of occs) for (const w of o.words) if (w.length > bestLen && (r === w || hasWord(r, w))) { best = o; bestLen = w.length; }
  if (!best && /^(summer )?analyst$/.test(r) && sector) best = occs.find((o) => (o.analyst_sectors || []).includes(sector)) || null;
  return best ? { key: best.key, soc: best.soc, soc_title: best.soc_title, bls_national: best.bls_national ?? null } : null;
}
const DEADLINE = /\b(?:deadline(?: is)?|expires?(?: on)?|due|(?:answer|respond|reply|decide|sign|accept)(?: back)? by|need to (?:answer|decide|respond|reply|sign|accept)(?: by)?|have until|by)\s+((?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|end of (?:the )?(?:day|week|month)|eod|eow|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})/i;
const BENEFIT = /\b(relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)(?![\w])/i;
// An amount followed by a benefit's name ("$3,000 relocation") inside a clause that also states the pay.
const BENEFIT_AMOUNT = /^\s*(?:in |of |for )?(?:relocation|reloc|stipend|allowance|tuition|(?:401|403|457)\s?\(?[kb]\)?)/i;
const COMPETING = /\b(another offer|competing offer|other offer|second offer|also (?:have|got) an offer|also offered|offer from .+ too)\b/i;

// One message, or one piece of it, read into an offer. Clauses are read one at a time so "110k base, 15k signing" puts
// each number with its own label, and a clause about another offer never becomes this offer's numbers.
export function parseOfferWords(text: string, data: OfferData = payData(), opts: { asked?: readonly Field[] } = {}): Offer {
  const t = String(text ?? "");
  const maps = data?.maps;
  const offer: Offer = { company: null, firm_id: null, lca_company_id: null, sector: null, base: null, hourly: null, signing: null, bonus: null, bonus_pct: null,
    city: null, metro: null, metro_label: null, remote: false, role: null, occupation: null, competing: [], deadline: null };
  const clauses = t.split(/[;\n]|,(?!\d{3})|\.(?=\s|$)|\s+(?:and|but|plus|with)\s+/i).map((c) => c.trim()).filter(Boolean);
  const main: string[] = [];
  for (const c of clauses) {
    if (COMPETING.test(c) || (/\boffer(?:ed)?\b.*\btoo\b/i.test(c) && amounts(c).length)) {
      const a = amounts(c)[0];
      if (a) {
        const f = firmIn(c.replace(COMPETING, ""));
        const named = f ? f.name : (c.match(/\b(?:from|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/)?.[1] ?? null);
        const f1 = a.per && a.per !== "year" ? ANNUAL[a.per]?.factor ?? null : 1;
        if (f1 != null) offer.competing.push({ company: named, base: a.value * f1, said: c, mark: a.mark });
      }
      continue;
    }
    main.push(c);
  }
  const body = main.join(", ");
  const firm = firmIn(body);
  if (firm) { offer.company = firm.name; offer.firm_id = firm.firm_id; offer.lca_company_id = firm.lca_company_id ?? null; offer.sector = firm.sector ?? null; }
  else offer.company = namedCompany(body);
  const from: NonNullable<Offer["from"]> = {};
  offer.from = from;
  const marks: NonNullable<Offer["marks"]> = {};
  offer.marks = marks;
  offer.bonus_target = null;
  for (const c of main) {
    const as = amounts(c).filter((a) => !BENEFIT_AMOUNT.test(c.slice(a.end, a.end + 40)));
    if (!as.length) { const p = c.match(/(\d{1,2}(?:\.\d+)?)\s?%\s*(?:target )?bonus|bonus(?: target)?(?: of)? (\d{1,2}(?:\.\d+)?)\s?%/i); if (p) { offer.bonus_pct = Number(p[1] ?? p[2]); from.bonus_pct = c; } continue; }
    // A relocation, a stipend or a retirement match is a benefit, never the base or a bonus (LOOP 13).
    if (BENEFIT.test(c) && !/\b(base|salary)\b/i.test(c)) continue;
    const a = as[0];
    const rated = !!a.per && a.per !== "year";
    if (/sign(?:ing|-on| on)/i.test(c)) { offer.signing = a.value; from.signing = c; marks.signing = a.mark; }
    else if (/bonus/i.test(c) && /\btarget\b/i.test(c)) { offer.bonus_target = a.value; from.bonus_target = c; marks.bonus_target = a.mark; }
    else if (/bonus/i.test(c)) { offer.bonus = a.value; from.bonus = c; marks.bonus = a.mark; }
    else if (/\b(base|salary|pay|offered|offer of|offering|comp|per year|a year|annual|\/yr)\b/i.test(c) || rated || (offer.base == null && !offer.rate)) {
      // A rate is kept as said; the yearly base is rate x a stated assumption, or nothing for a daily rate.
      if (rated) { const y = ANNUAL[a.per!] ?? null; Object.assign(offer, { rate: { amount: a.value, period: a.per }, annualized: y, base: y ? Math.round(a.value * y.factor) : null, hourly: a.per === "hour" ? a.value : null, period: a.per }); }
      else Object.assign(offer, { rate: null, annualized: null, base: a.value, hourly: null, period: a.per === "year" || /\b(per year|a year|annual(?:ly)?|yearly|\/\s?yr|per annum)\b/i.test(c) ? "year" : null });
      from.base = c; marks.base = a.mark;
    }
  }
  const metro = metroIn(body, maps);
  // The place as said is read from the whole message: "Lake Mary, Florida" spans a comma the clauses are split on.
  const place = placeIn(t.replace(COMPETING, " "));
  offer.place = place;
  if (metro) { offer.metro = metro.key; offer.metro_label = metro.label; offer.city = metro.label; }
  else if (place) offer.city = place;
  else if (/\bremote\b/i.test(body)) { offer.remote = true; offer.city = "remote"; }
  // An answer to the one ask: the title or the place as said, when the words are nothing else.
  if (opts.asked?.includes("city") && !metro && !place && !offer.remote) { const p = placeAnswer(t, opts.asked.length === 1); if (p) { offer.place = p; offer.city = p; } }
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
  offer.occupation = occupationFor(offer.role, offer.sector, maps);
  const d = t.match(DEADLINE);
  if (d) offer.deadline = { text: d[1] };
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
  if (a.marks || b.marks) { out.marks = { ...(a.marks ?? {}), ...(b.marks ?? {}) }; settleCurrency(out); }
  out.occupation = occupationFor(out.role, out.sector, data?.maps);
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
  if (!isUsd(o) || !usMarket(o)) return out;
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
  status: "ask" | "benchmarked";
  offer: Offer;
  missing: Field[];
  ask: string | null;
  benchmarks: Bench[];
  draft: { email: string; call: string; sent: false } | null;
  messages: string[];
}
export function offerReply(o: Offer, notGiven: Field[], data: OfferData = payData()): OfferResult {
  const bench = benchmarks(o, data);
  const c = o.currencies ?? {};
  const parts = [o.company, o.title ?? o.role, o.city === "remote" ? "remote" : o.metro_label ?? o.place ?? o.city, o.base != null ? `base ${moneyIn(o.base, c.base ?? o.currency)}${rateNote(o, c.base ?? o.currency)}` : o.rate ? `${rateIn(o.rate.amount, o.currency)} ${PER[o.rate.period]}` : null,
    o.signing != null ? `signing ${moneyIn(o.signing, c.signing)}` : null, o.bonus != null ? `bonus ${moneyIn(o.bonus, c.bonus)}` : null, o.bonus_pct != null ? `target bonus ${o.bonus_pct}%` : null].filter(Boolean);
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
  const firstUp = shown.find((b) => b.median != null);
  const script = (CareerNegotiation as any).factScript({ company: o.company, role: o.title ?? o.role, base: o.base, signing: o.signing },
    { competing: o.competing.filter((x) => sameCurrency(x.currency, o.currency)).map((x) => ({ ...x })), deadline: o.deadline, benchmark: firstUp ? { median: firstUp.median, cite: firstUp.cite } : null, money: moneyFor(o) });
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
export interface OfferPending { v: 1; pieces: string[]; asked: Field[]; at: number }
export function offerTurn(o: { words: string; pending: OfferPending | null; now: number; data?: OfferData }): { result: OfferResult; pending: OfferPending | null } {
  const data = o.data ?? payData();
  const fresh = o.pending && o.now - o.pending.at < ASK_TTL_MS ? o.pending : null;
  const now = parseOfferWords(o.words, data);
  // A new offer (another company with its own base) starts over instead of mixing two offers.
  let pieces = fresh ? [...fresh.pieces, o.words] : [o.words];
  let asked = fresh ? fresh.asked : [];
  if (fresh && now.company && now.base != null) {
    const before = fresh.pieces.map((p, i) => parseOfferWords(p, data, i ? { asked: fresh.asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
    if (before.company && before.company !== now.company) { pieces = [o.words]; asked = []; }
  }
  const offer = pieces.map((p, i) => parseOfferWords(p, data, i ? { asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
  const missing = missingOf(offer);
  if (missing.length && !asked.length) {
    const ask = askFor(missing, offer);
    return { result: { status: "ask", offer, missing, ask, benchmarks: [], draft: null, messages: [ask] }, pending: { v: 1, pieces, asked: missing, at: o.now } };
  }
  // Asked once already: what is still missing is said, never asked again.
  return { result: offerReply(offer, missing, data), pending: null };
}
// The words must be the person's own, from this turn's message.
export function saidIn(message: string, words: string): boolean {
  const w = plain(words), m = plain(message);
  return !!w && ` ${m} `.includes(` ${w} `);
}
export { host as sourceHost };
