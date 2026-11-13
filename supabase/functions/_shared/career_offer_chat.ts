// FEATURE 12 (DIAGNOSIS 2.13, fix F6): the offer turn on the live path, code-first, before the router. A person texts an
// offer ("I got an offer from JPMorgan for $110k as an analyst in New York"), a rate check ("is $95k good for a data
// analyst in Chicago"), "compare my two offers" or "help me negotiate"; code reads it with WO-036's reader
// (career_offer.ts), places the base against the public pay data (DOL LCA, BLS OEWS, the BLS national median) and the
// pay ranges open postings on file state for the same role and metro, and drafts the counter from 128's factScript on an
// approval card that cites the benchmark it used. No model call.
//
// Honesty rules, in code:
//   - A median is said only from MIN_N (5) or more filings or postings; fewer is said as a refusal with the count.
//   - Every number carries its dataset, its period and its n. A percentile is said exactly where the data publishes it
//     and otherwise as an estimate on a straight line between the published percentiles, and said to be one.
//   - Bonus, signing and equity only as the person stated them; equity is never valued.
//   - No cost-of-living dataset is on file, so two places are never adjusted; the reply says so.
//   - Nothing is sent. The counter is a draft on a card (requires_approval, sent: false) bound to its exact text by hash;
//     there is no send path for it.
import { anyAssumed, type Bench, CONFIRM_TTL_MS, plainNo, plainYes, readingBlock, readingHash, benchmarks, comparable, currencyOf, rateThenEstimate, readingOf, statedHours, settleCurrency, unsettledText, type Field, hasWord, isUsd, known, MAX_MESSAGE, mergeOffers, MIN_N, norm, moneyFor, moneyIn, notPlaced, type Offer, type OfferData, parseOfferWords, payData, PER, placeKind, rateAsk, rateIn, rateNote, sameCurrency, UNKNOWN_CURRENCY, usMarket } from "./career_offer.ts";
import { CareerNegotiation, CareerPaths } from "./router_core.career.js";
import { searchWords } from "./career_ingest.ts";
import type { KV, Src } from "./file_family.ts";
import type { OfferComparison } from "./file_family_apply.ts";

export const OFFER_INTENT = { ask: "career_offer_ask", bench: "career_offer_benchmark", compare: "career_offer_compare", counter: "career_offer_counter", confirm: "career_offer_confirm" } as const;
export const ASK_TTL_MS = 24 * 3600_000;
export const MAX_ON_FILE = 6; // offers kept in the thread
// The pay data source. Production reads the bundled datasets; a test points it at fixture datasets.
export const offerData = { get: (): OfferData => payData() };

// src (LOOP 13): where each figure came from, read from the person's own words (offer letter, verbal, their estimate, or
// just "you told me"). An offer whose base is the person's estimate is not an offer they have: it is never cited as one.
export type SrcLabel = "offer letter" | "verbal" | "your estimate" | "you told me";
// `aside`: an offer the person only mentioned beside another ("I also have an offer from Meta for $170k"): never the one a
// plain "help me negotiate" drafts to.
// D-078 `confirmed`: the person's yes to the reading of this offer (the block's hash, when, by whom). Absent or null: the
// offer is on file but unconfirmed, and nothing compares, benchmarks or drafts from it.
export interface Confirmed { by: "person"; at: number; hash: string }
export interface OnFile { offer: Offer; equity: string | null; said: string; at: number; aside?: boolean; confirmed?: Confirmed | null; src?: Partial<Record<"base" | "signing" | "bonus" | "equity" | "benefits" | "terms", SrcLabel>>; benefits?: { text: string; src: SrcLabel }[] }
// Kept in the thread's `offerBenchmark` store (career_host.js STATE_KEYS; erased with the rest). The pieces/asked/at
// fields keep the shape WO-036's brain tool reads, so the two never disagree about a half-told offer.
// `target`: the company the last counter was drafted to, so a later plain "help me negotiate" means the same one.
// D-078 `shown`: the reading last shown for the person's yes: its hash and block, when, what to do on the yes, and for a rate
// check (never kept on file) the check itself. It lives for one turn: any other message drops it.
export type Then = "bench" | "bench_counter" | "counter" | "compare";
export interface Shown { hash: string; block: string; at: number; then: Then; notGiven: Field[]; check?: OnFile | null; names?: string[] }
export interface OfferChatState { v: 1; pieces: string[]; asked: Field[]; at: number; mode?: "offer" | "check"; offers: OnFile[]; target?: string | null; shown?: Shown | null }
export interface PostedRow { company?: string; title?: string; location?: string; pay?: string | null }
export interface PostingsReader { search(words: string[], limit: number): Promise<PostedRow[]> }
export interface OfferCard { type: "approval_card"; kind: "counter_email"; title: string; body: string; destination: null; requires_approval: true; sent: false; note: string; payload_hash: string; benchmark: string | null }
export interface OfferAnswer { intent: string; status: string; reply: string; parts: string[]; card: OfferCard | null; comparison?: OfferComparison | null }
export interface OfferTurnResult { answer: OfferAnswer | null; state: OfferChatState | null }

const REQUIRED: Field[] = ["base", "city", "role"];
const ASK_WORDS: Record<string, string> = { base: "the base salary", city: "the city", role: "the job title" };
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
// D-069: each of the offer's figures in the currency it was said in (never restated in dollars, never converted).
const cur = (o: Offer, k: "base" | "signing" | "bonus" | "bonus_target") => o.currencies?.[k] ?? (k === "base" ? o.currency : undefined) ?? o.currency ?? "USD";
const m$ = (o: Offer, k: "base" | "signing" | "bonus" | "bonus_target", n: number) => moneyIn(n, cur(o, k));
const placeOf = (o: Offer) => o.remote ? "remote" : o.metro_label ?? o.place ?? o.city;
const titleOf = (o: Offer) => o.title ?? o.role;
// Guaranteed cash adds only figures said in one currency; with two, nothing is added (no sourced exchange rate is on file).
// A figure whose currency is not known is never added to another (2026-11-13).
const curs = (o: Offer) => [cur(o, "base"), ...(o.signing != null ? [cur(o, "signing")] : []), ...(o.bonus != null ? [cur(o, "bonus")] : [])];
const curName = (o: Offer) => !known(o.currency ?? "USD") ? "a currency that was not stated" : o.currency_assumed?.base ? "USD (an assumption, not confirmed)" : o.currency ?? "USD";
const oneCurrency = (o: Offer) => curs(o).every(known) && !anyAssumed(o) && new Set([cur(o, "base"), ...(o.signing != null ? [cur(o, "signing")] : []), ...(o.bonus != null ? [cur(o, "bonus")] : [])]).size === 1;
const ord = (n: number) => { const r = n % 100, t = n % 10; return `${n}${r >= 11 && r <= 13 ? "th" : t === 1 ? "st" : t === 2 ? "nd" : t === 3 ? "rd" : "th"}`; };
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ---------- what the message asks ----------
const OFFER_WORDS = /\b(offer|offers|offered|offering)\b/i;
const CHECK = /\b(is|are|would|was)\b[^?.!]*\b(good|fair|low|lowball|high|enough|competitive|reasonable|decent|market|underpaid|normal|average|ok|okay)\b|\bwhat(?:'s| is) (?:the )?(?:market|going rate)\b|\bhow does\b[^?.!]*\bcompare\b/i;
const COMPARE = /\bcompare\b[^.?!]*\boffers?\b|\bwhich offer\b|\boffers?\b[^.?!]*\b(?:side by side|compared?)\b|\bwhich (?:one )?(?:is|pays) better\b/i;
const NEGOTIATE = /\bnegotiat\w*|\bcounter(?:[- ]?offer)?\b|\bask(?:ing)? for more\b/i;
// Other asks that name a role and a place ("find data analyst jobs in Chicago") are never an offer's missing piece.
export const HYPOTHETICAL = /\b(?:hypothetical(?:ly)?|in theory|imagine|suppose|supposing|pretend|let'?s say|say i(?:'?d)? (?:had|got|get|have)|if i (?:had|got|were to get|ever got)|what if i (?:had|got|get))\b/i;
const OTHER_ASK = /\b(find|search|apply|jobs?|openings|postings|watch|alert|tailor|resume|cover letter|interview|mock)\b/i;
const EQUITY = /\b(equity|rsus?|stock|options|shares|vest\w*|cliff)\b/i;
const CLAUSES = /[;\n]|,(?!\d{2},\d|\d{3})|\.(?=\s|$)|\s+(?:and|but|plus|with)\s+/i;

function equityOf(text: string): { equity: string | null; rest: string } {
  const parts = text.split(CLAUSES).map((c) => c.trim()).filter(Boolean);
  const eq = parts.filter((c) => EQUITY.test(c));
  return { equity: eq.length ? eq.join(", ") : null, rest: parts.filter((c) => !EQUITY.test(c)).join(", ") };
}
// ---------- where a figure came from (LOOP 13) ----------
const LETTER = /\b(offer letter|letter|in writing|written|contract|offer doc\w*|paperwork)\b/i;
const VERBAL = /\b(verbal\w*|on the phone|over the phone|on (?:a|the) call|recruiter (?:said|told|mentioned)|hiring manager (?:said|told|mentioned))\b/i;
const ESTIMATE = /\b(i think|i guess|i expect|expecting|probably|likely|maybe|might|around|roughly|approximately|estimat\w*|will offer|going to offer)\b|~\s?\$?\d/i;
const kindOf = (t: string): SrcLabel | null => ESTIMATE.test(t) ? "your estimate" : VERBAL.test(t) ? "verbal" : LETTER.test(t) ? "offer letter" : null;
// The clause's own words first; else the message's, when the whole message points one way; else "you told me".
export function sourceOf(clause: string | null | undefined, said: string): SrcLabel {
  const own = clause ? kindOf(clause) : null;
  if (own) return own;
  // A sentence about another offer ("I might get another offer from Meta") says nothing about where this one came from.
  const kinds = new Set(said.split(/[;\n]|\.(?=\s|$)/).filter((x) => !/\b(?:another|other|competing|second) offer\b|\balso\b/i.test(x)).flatMap((x) => x.split(CLAUSES)).map((c) => kindOf(c)).filter(Boolean));
  return kinds.size === 1 ? [...kinds][0] as SrcLabel : "you told me";
}
function sourcesOf(o: Offer, equity: string | null, said: string): NonNullable<OnFile["src"]> {
  const from = o.from ?? {};
  return { base: sourceOf(from.base, said), signing: sourceOf(from.signing, said), bonus: sourceOf(from.bonus ?? from.bonus_target ?? from.bonus_pct, said),
    equity: sourceOf(equity, said), terms: sourceOf(null, said) };
}
// Benefits only as the person gave them, never valued beyond the dollar amount they said, never added to cash.
export function benefitsOf(said: string): { text: string; src: SrcLabel }[] {
  const out: { text: string; src: SrcLabel }[] = [];
  const add = (text: string, c: string) => { if (!out.some((b) => b.text === text)) out.push({ text, src: sourceOf(c, said) }); };
  const money = (n: string, k?: string) => usd(Number(n.replace(/,/g, "")) * (k ? 1000 : 1));
  for (const c of said.split(/[;\n]|,(?!\d{3})|\.(?=\s|$)|\s+(?:and|plus|with)\s+/i).map((x) => x.trim()).filter(Boolean)) {
    for (const m of c.matchAll(/(\d+(?:\.\d+)?)\s?%\s*(401|403|457)\s?\(?([kb])\)?\s*match/gi)) add(`${m[1]}% ${m[2]}(${m[3].toLowerCase()}) match (not valued)`, c);
    for (const m of c.matchAll(/\b(401|403|457)\s?\(?([kb])\)?\s*match(?:ing)?\s*(?:of\s*|up to\s*)?(\d+(?:\.\d+)?)\s?%/gi)) add(`${m[3]}% ${m[1]}(${m[2].toLowerCase()}) match (not valued)`, c);
    for (const m of c.matchAll(/\$\s?(\d[\d,]*)\s?([kK])?\s*(?:in |of |for )?((?:relocation|reloc)\w*|(?:[a-z]+ )?stipend|(?:[a-z]+ )?allowance|tuition\w*)/gi)) add(`${money(m[1], m[2])} ${m[3].toLowerCase()}`, c);
    for (const m of c.matchAll(/\b((?:relocation|reloc)\w*|(?:[a-z]+ )?stipend|(?:[a-z]+ )?allowance|tuition\w*)(?: bonus| package| assistance)?\s*(?:of|up to)\s*\$\s?(\d[\d,]*)\s?([kK])?/gi)) add(`${money(m[2], m[3])} ${m[1].toLowerCase()}`, c);
    for (const m of c.matchAll(/\b(\d{1,2})\s*(days?|weeks?)\s*(?:of\s*)?(pto|vacation|paid time off)\b/gi)) add(`${m[1]} ${m[2]} of ${m[3]}`, c);
  }
  return out;
}
// Equity, worked out only from what the person said: a dollar grant (or a yearly amount) over a stated vesting period,
// split evenly per year at the grant value; year one from a stated cliff (a cliff of up to 12 months vests the first year's
// share by month 12; a longer one vests nothing in year one). Options are never valued (the strike and share price are not
// known). Never added to cash; never a market value.
export interface EquityValue { text: string; short: string; annual: number | null; yearOne: number | null; grant: number | null }
export function equityValue(said: string): EquityValue {
  const t = String(said ?? "");
  const none = (why: string): EquityValue => ({ text: `${t} (not valued: ${why})`, short: `not valued (${why})`, annual: null, yearOne: null, grant: null });
  if (/\boptions?\b/i.test(t) && !/\b(rsus?|restricted stock|stock units?)\b/i.test(t)) return none("what options are worth depends on the strike price and the share price, and neither is known");
  const amt = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?(?![\w])/);
  if (!amt) return none("no dollar value given");
  const v = Number(amt[1].replace(/,/g, "")) * (/k/i.test(amt[2] ?? "") ? 1000 : /m/i.test(amt[2] ?? "") ? 1_000_000 : 1);
  const ym = t.match(/(?:over|across|vest\w*(?: over)?)\s+(\d{1,2})\s*(?:years?|yrs?)\b|\b(\d{1,2})[- ](?:year|yr)s?[- ]vest/i);
  const years = ym ? Number(ym[1] ?? ym[2]) : null;
  const cm = t.match(/\b(\d{1,2})[- ]?(year|yr|month|mo)s?[- ]cliff|\bcliff of (\d{1,2})\s*(year|yr|month|mo)s?/i);
  const cliff = cm ? Number(cm[1] ?? cm[3]) * (/^y/i.test(cm[2] ?? cm[4]) ? 12 : 1) : null;
  const perYear = /\b(per year|a year|each year|every year|annually|per annum)\b|\/\s?yr\b/i.test(t);
  if (!years) return { text: `${usd(v)}${perYear ? " a year" : ""} as you said it; the vesting period was not given, so it is not split by year. Not cash.`, short: `${usd(v)}${perYear ? " a year" : ""}, vesting period not given`, annual: perYear ? v : null, yearOne: null, grant: perYear ? null : v };
  const grant = perYear ? v * years : v;
  const exact = grant % years === 0;
  const annual = Math.round(grant / years);
  const cliffTxt = cliff == null ? null : cliff % 12 === 0 ? `${cliff / 12}-year cliff` : `${cliff}-month cliff`;
  const yearOne = cliff == null ? null : cliff <= 12 ? annual : 0;
  const a = `${exact ? "" : "about "}${usd(annual)} a year`;
  const y1 = cliffTxt ? `${cliffTxt}, so year one ${yearOne === 0 ? "$0" : `${exact ? "" : "about "}${usd(yearOne!)}`}` : "cliff not given, so year one is not stated";
  return { text: `${usd(grant)} over ${years} years = ${a} at the grant value; ${y1}. Not cash, and not a market value.`, short: `${a} at the grant value (${y1})`, annual, yearOne, grant };
}

function missingOf(o: Offer): Field[] { return REQUIRED.filter((f) => f === "city" ? !o.city : f === "base" ? o.base == null : !o[f]); }
function askFor(missing: Field[], o: Offer): string {
  const w = missing.map((f) => ASK_WORDS[f]);
  const list = w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0];
  const have = [o.company, titleOf(o), o.metro_label ?? o.place ?? (o.remote ? "remote" : null), o.base != null ? m$(o, "base", o.base) : null, o.total ? `total pay ${o.total.written} (not the base)` : null].filter(Boolean).join(", ");
  return `${have ? `Got it: ${have}. ` : ""}${rateAsk(o)}To place it against market pay I need ${list}. What ${missing.length > 1 ? "are they" : "is it"}?`;
}
const sameCompany = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------- the market numbers ----------
// Where the base sits: exact at a published percentile, an estimate on a straight line between two of them, or past
// the published band (never extrapolated).
export function percentileOf(base: number, b: { p25: number | null; median: number | null; p75: number | null }): string | null {
  const pts = ([[25, b.p25], [50, b.median], [75, b.p75]] as [number, number | null][]).filter((p): p is [number, number] => p[1] != null);
  if (pts.length < 2) return null;
  for (const [p, v] of pts) if (base === v) return `at exactly the ${ord(p)} percentile`;
  if (base < pts[0][1]) return `below the ${ord(pts[0][0])} percentile`;
  if (base > pts[pts.length - 1][1]) return `above the ${ord(pts[pts.length - 1][0])} percentile`;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p1, v1] = pts[i], [p2, v2] = pts[i + 1];
    if (base > v1 && base < v2) return `at about the ${ord(Math.round(p1 + ((base - v1) / (v2 - v1)) * (p2 - p1)))} percentile (estimated between the published ${ord(p1)} and ${ord(p2)})`;
  }
  return null;
}
function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}
// A posting's stated yearly range in US dollars, read from the text the board stated (career_ingest boardPay). An hourly,
// monthly or non-USD figure is not converted; it is left out and counted as such.
export function yearlyRange(pay: string | null | undefined): { lo: number; hi: number } | null {
  const t = String(pay ?? "");
  if (!t || /\b(hour|hr|month|week|day)\b|\/\s?h\b/i.test(t) || /\b(EUR|GBP|CAD|AUD|INR|JPY|CHF|SGD)\b|[€£]/.test(t)) return null;
  const nums = [...t.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kK])?/g)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null;
  const lo = nums[0], hi = nums[1] ?? nums[0];
  if (lo < 10000 || hi < lo || hi > 2_000_000) return null;
  return { lo, hi };
}
export interface PostedBench { shown: boolean; n: number; median: number | null; p25: number | null; p75: number | null; below: number; reason: string | null; cite: string; label: string; companies: string[] }
// Open postings on file for the same role in the same metro that state a yearly pay range: the midpoint of each range.
export async function postedPay(o: Offer, postings: PostingsReader | null, data: OfferData, now: number): Promise<PostedBench | null> {
  if (!postings || !o.role || !o.metro || !isUsd(o) || !usMarket(o)) return null;
  const metro = (data?.maps?.metros || []).find((m: any) => m.key === o.metro);
  const label = `Pay stated by open ${o.role} postings in the ${o.metro_label} on file`;
  const cite = (n: number) => `${n} open ${o.role} postings in the ${o.metro_label} that state pay (job boards' own pay fields, read ${dateOf(now)})`;
  let rows: PostedRow[];
  try { rows = await postings.search(searchWords(o.role), 300); }
  catch { return { shown: false, n: 0, median: null, p25: null, p75: null, below: 0, reason: "the postings could not be read just now", cite: "", label, companies: [] }; }
  const mids: number[] = [], companies: string[] = [];
  for (const r of rows) {
    if (!hasWord(String(r.title ?? ""), o.role)) continue;
    const loc = String(r.location ?? "");
    if (!metro || !(metro.words as string[]).some((w) => hasWord(loc, w))) continue;
    const range = yearlyRange(r.pay);
    if (!range) continue;
    mids.push((range.lo + range.hi) / 2);
    if (r.company && !companies.includes(r.company)) companies.push(r.company);
  }
  const n = mids.length;
  if (n < MIN_N) {
    return { shown: false, n, median: null, p25: null, p75: null, below: 0, cite: "", label, companies,
      reason: n === 0 ? "no open posting on file for this role and metro states a yearly pay range" : `only ${n} open posting${n === 1 ? "" : "s"} on file state${n === 1 ? "s" : ""} a yearly pay range, too few for a median (I need at least ${MIN_N})` };
  }
  const s = mids.slice().sort((a, b) => a - b);
  const below = o.base != null ? s.filter((m) => m < o.base!).length : 0;
  return { shown: true, n, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), below, reason: null, cite: cite(n), label, companies };
}
interface Market { pub: Bench[]; posted: PostedBench | null }
async function marketFor(o: Offer, postings: PostingsReader | null, data: OfferData, now: number): Promise<Market> {
  return { pub: benchmarks(o, data), posted: await postedPay(o, postings, data, now) };
}
// The one number a counter may cite: the employer's own filings first, then the metro's BLS figure, then postings in the
// metro, then the national figure.
function citable(m: Market): { median: number; cite: string; n: number | null } | null {
  const byKind = (k: string) => m.pub.find((b) => b.kind === k && b.shown && b.median != null);
  const lca = byKind("lca"), oews = byKind("oews"), nat = byKind("bls_national");
  if (lca) return { median: lca.median!, cite: lca.cite, n: lca.n };
  if (oews) return { median: oews.median!, cite: `${oews.cite}${oews.n ? `, about ${oews.n.toLocaleString("en-US")} people employed` : ""}`, n: oews.n };
  if (m.posted?.shown) return { median: m.posted.median!, cite: m.posted.cite, n: m.posted.n };
  if (nat) return { median: nat.median!, cite: nat.cite, n: nat.n };
  return null;
}
function marketLines(o: Offer, m: Market): string[] {
  const lines: string[] = [];
  const urls: string[] = [];
  // 2026-11-13: an unknown currency, or a place code cannot confirm is in the United States, is said and never compared.
  const why = notPlaced(o);
  if (why && (!known(o.currency ?? "USD") || isUsd(o))) lines.push(why);
  else if (!isUsd(o)) lines.push(`Public pay data (DOL, BLS): US data in US dollars; your offer is in ${o.currency}, so it is not placed against it and nothing is converted (no sourced exchange rate is on file).`);
  else if (!o.occupation) lines.push(o.role ? `Public pay data (DOL, BLS): none mapped to "${o.role}", so no public figure.` : "Public pay data: without the job title there is no occupation to look up.");
  for (const b of m.pub) {
    if (!b.shown) { lines.push(`${b.label}: no median, ${b.reason}.`); continue; }
    const size = b.kind === "lca" ? `from ${b.n} filings` : b.n ? `about ${b.n.toLocaleString("en-US")} people employed` : "sample size not published";
    const band = b.p25 != null && b.p75 != null ? `; middle half ${usd(b.p25)} to ${usd(b.p75)}` : "";
    const dataset = b.kind === "lca" ? "DOL H-1B LCA" : b.kind === "oews" ? "BLS OEWS" : "BLS";
    const pct = o.base != null ? percentileOf(o.base, b) : null;
    lines.push(`${b.label} (${dataset}, ${b.period}): median ${usd(b.median!)}, ${size}${band}.${o.base != null ? ` Your base is ${pct ?? (b.position ? b.position.replace(/^Your base is /, "").replace(/\.$/, "") : "not placed")}.` : ""} What it is: ${b.what}`);
    urls.push(b.source_url);
  }
  const p = m.posted;
  if (p) {
    if (!p.shown) lines.push(`${p.label}: no median, ${p.reason}.`);
    else lines.push(`${p.label}: median ${usd(p.median!)} from ${p.n} postings (the middle of each stated range); middle half ${usd(p.p25!)} to ${usd(p.p75!)}.${o.base != null ? ` Your base is above the middle of ${p.below} of the ${p.n} posted ranges.` : ""} What it is: what employers hiring now post, not what they pay.`);
  }
  if (!why && m.pub.every((b) => !b.shown) && !p?.shown) lines.push("So I have no market number for this one, and I won't make one up.");
  const uniq = [...new Set(urls)];
  if (uniq.length) lines.push("Sources:", ...uniq);
  return lines;
}
function offerLine(f: { offer: Offer; equity: string | null }, check: boolean): string {
  const o = f.offer;
  const head = [o.company, titleOf(o), placeOf(o)].filter(Boolean).join(", ");
  const pay = [o.base != null && !(o.rate && o.part_year) ? `base ${m$(o, "base", o.base)}${rateNote(o, cur(o, "base"))}` : o.rate ? rateThenEstimate(o, cur(o, "base")) : null,
    o.total ? `total pay as you said it ${o.total.written} (not the base, not compared)` : null, o.signing != null ? `signing ${m$(o, "signing", o.signing)}` : null,
    o.bonus != null ? `bonus ${m$(o, "bonus", o.bonus)}` : null, o.bonus_target != null ? `target bonus ${m$(o, "bonus_target", o.bonus_target)} (not guaranteed)` : null,
    o.bonus_pct != null ? `target bonus ${o.bonus_pct}%${o.base != null && !partRate(o) ? ` (worked out from the base: ${m$(o, "base", o.base * o.bonus_pct / 100)}, not guaranteed)` : " (not guaranteed)"}` : null].filter(Boolean).join(", ");
  const eq = f.equity ? equityValue(f.equity) : null;
  return `${check ? "Checking" : "Your offer"}: ${head}${pay ? `, ${pay}` : ""}.${f.equity ? ` Equity as you said it: ${f.equity} (not valued).${eq?.annual != null ? ` Worked out: ${eq.short}; not cash.` : ""}` : ""}${o.deadline ? ` Deadline: ${o.deadline.text}.` : ""}`;
}
// Where each figure in the offer came from, in one line.
function sourceLine(f: OnFile): string | null {
  const o = f.offer, s = f.src ?? {};
  const bits = [o.base != null ? `base ${s.base ?? "you told me"}` : null, o.signing != null ? `signing ${s.signing ?? "you told me"}` : null,
    o.bonus != null || o.bonus_target != null || o.bonus_pct != null ? `bonus ${s.bonus ?? "you told me"}` : null, f.equity ? `equity ${s.equity ?? "you told me"}` : null,
    ...(f.benefits ?? []).map((b) => `${b.text.replace(/ \(not valued\)$/, "")} ${b.src}`)].filter(Boolean);
  return bits.length ? bits.join(", ") : null;
}
const isEstimate = (f: OnFile) => f.src?.base === "your estimate";
const guaranteed = (o: Offer) => o.base != null && oneCurrency(o) && !partRate(o) ? o.base + (o.signing ?? 0) + (o.bonus ?? 0) : null;
// The figures that were not added, said each in its own currency.
const andList = (xs: string[]) => xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const notAdded = (o: Offer) => `not added up: ${andList([o.base != null ? `base ${m$(o, "base", o.base)}` : null, o.signing != null ? `signing bonus ${m$(o, "signing", o.signing)}` : null, o.bonus != null ? `bonus ${m$(o, "bonus", o.bonus)}` : null].filter((x): x is string => !!x))} ${curs(o).every(known) && new Set(curs(o)).size > 1 ? "are in different currencies, and no sourced exchange rate is on file, so nothing is converted" : "are not all in a confirmed currency, so nothing is added or converted"}`;
// Round 3: a rate for work that is not a full year of full-time work (an internship, a contract, part-time). Nothing shown to
// the person turns it into a yearly figure, and it is left out of every sum.
const partRate = (o: Offer) => statedHours(o);
const rateSaid = (o: Offer) => `${rateIn(o.rate!.amount, cur(o, "base"))} ${PER[o.rate!.period]}`;
const NOT_YEARLY = "not a full-year salary";
const targetAmount = (o: Offer) => partRate(o) ? null : o.bonus_target != null ? o.bonus_target : o.bonus_pct != null && o.base != null ? Math.round(o.base * o.bonus_pct / 100) : null;
// F-15 (offer comparison File): the offers on file as rows, each value with its source; a value not given is Unknown;
// code's arithmetic is labelled "worked out". No row adds equity to cash, and no row is called a total.
export function comparisonOf(list: OnFile[]): OfferComparison {
  const S = (label: string): Src => ({ label });
  const WORKED = S("worked out");
  const unknown = (k: string): KV => ({ k, v: null, missing: "Unknown - not given" });
  const offers = list.map((f, i) => {
    const o = f.offer, s = f.src ?? {};
    const src = (k: keyof NonNullable<OnFile["src"]>) => S(s[k] ?? "you told me");
    const rows: KV[] = [];
    if (partRate(o)) rows.push({ k: "Base", v: `${rateSaid(o)} (${NOT_YEARLY}: you said ${o.part_year})`, src: src("base") });
    else rows.push(o.base != null ? { k: "Base", v: o.rate && o.annualized ? `${rateIn(o.rate.amount, cur(o, "base"))} ${PER[o.rate.period]} x ${o.annualized.assumption} = ${m$(o, "base", o.base)} a year` : o.hourly ? `${rateIn(o.hourly, cur(o, "base"))} an hour x 2,080 hours = ${m$(o, "base", o.base)} a year` : m$(o, "base", o.base), src: src("base") } : unknown("Base"));
    if (o.base != null && o.rate && o.annualized && !partRate(o)) rows.push({ k: "Yearly base basis", v: `An estimate, not a stated salary: ${rateIn(o.rate.amount, cur(o, "base"))} ${PER[o.rate.period]} x ${o.annualized.assumption}${o.part_year ? `; you said ${o.part_year}, so a full year is not expected` : ""}`, src: WORKED });
    rows.push(o.signing != null ? { k: "Signing bonus", v: m$(o, "signing", o.signing), src: src("signing") } : unknown("Signing bonus"));
    const t = targetAmount(o);
    const bonus = [o.bonus != null ? `${m$(o, "bonus", o.bonus)} guaranteed` : null, o.bonus_target != null ? `target ${m$(o, "bonus_target", o.bonus_target)}, not guaranteed` : null,
      o.bonus_pct != null ? (o.base != null ? `target ${o.bonus_pct}% of base = ${m$(o, "base", t!)}, not guaranteed` : `target ${o.bonus_pct}% of base, not guaranteed`) : null].filter(Boolean).join("; ");
    rows.push(bonus ? { k: "Bonus", v: bonus, src: src("bonus") } : unknown("Bonus"));
    rows.push(f.equity ? { k: "Equity", v: equityValue(f.equity).text, src: src("equity") } : unknown("Equity"));
    const ben = f.benefits ?? [];
    const one = ben.length && ben.every((b) => b.src === ben[0].src);
    rows.push(ben.length ? { k: "Benefits", v: ben.map((b) => one ? b.text : `${b.text} (${b.src})`).join("; "), src: S(one ? ben[0].src : "you told me") } : unknown("Benefits"));
    const place = placeOf(o);
    rows.push(place ? { k: "Place", v: place, src: src("terms") } : unknown("Place"));
    rows.push(o.deadline ? { k: "Deadline", v: o.deadline.text, src: src("terms") } : unknown("Deadline"));
    const g = guaranteed(o);
    if (partRate(o)) rows.push({ k: "Guaranteed first-year cash", v: `Not worked out: the pay is a rate and ${NOT_YEARLY}`, src: WORKED });
    else rows.push(g != null ? { k: "Guaranteed first-year cash", v: `${m$(o, "base", g)} (base + signing + guaranteed bonus; equity and benefits not added)`, src: WORKED }
      : o.base != null ? { k: "Guaranteed first-year cash", v: notAdded(o), src: WORKED } : unknown("Guaranteed first-year cash"));
    if (g != null && t != null) rows.push({ k: "First-year cash if the target bonus pays in full", v: `${m$(o, "base", g + t)} (not guaranteed)`, src: WORKED });
    if (isEstimate(f)) rows.push({ k: "Status", v: "Your estimate of an offer, not an offer you have", src: S("your estimate") });
    return { letter: String.fromCharCode(65 + i), company: o.company || `Offer ${i + 1}`, rows };
  });
  return { offers, deadline: null, basis: "as you told me, each figure with its source" };
}
function fit(lines: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    const next = cur ? `${cur}\n${l}` : l;
    if (next.length > MAX_MESSAGE && cur) { out.push(cur.trim()); cur = l; } else cur = next;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((m) => m.length > MAX_MESSAGE ? m.slice(0, MAX_MESSAGE - 3) + "..." : m);
}
function answer(intent: string, status: string, groups: string[][], card: OfferCard | null = null, comparison: OfferComparison | null = null): OfferAnswer {
  const parts = groups.flatMap(fit);
  return { intent, status, parts, reply: parts.join("\n\n"), card, comparison };
}

// ---------- the turns ----------
async function benchTurn(f: OnFile, check: boolean, notGiven: Field[], postings: PostingsReader | null, data: OfferData, now: number, negotiate: boolean, state: OfferChatState): Promise<OfferAnswer> {
  // Not settled: restate what was read and what was not, and ask. Nothing is compared and no counter is drafted.
  if (f.offer.unsettled) return answer(OFFER_INTENT.ask, "unsettled", [[unsettledText(f.offer)]]);
  const m = await marketFor(f.offer, postings, data, now);
  const head = [offerLine(f, check)];
  if (notGiven.length) head.push(`Not given: ${notGiven.map((x) => ASK_WORDS[x]).join(", ")}, so I left ${notGiven.length > 1 ? "those" : "that"} out.`);
  if (!f.offer.company && !check) head.push("No company given, so the employer's own filings are not looked up.");
  const from = sourceLine(f);
  if (from) head.push(`Where these came from: ${from}.`);
  for (const fact of [known(f.offer.currency) ? f.offer.currency_fact : null, f.offer.period_fact]) if (fact) head.push(`${fact[0].toUpperCase()}${fact.slice(1)}.`);
  if ((f.benefits ?? []).length) head.push(`Benefits as you gave them (not added to pay): ${f.benefits!.map((b) => b.text).join("; ")}.`);
  if (isEstimate(f)) head.push("This is your estimate of an offer, not an offer you have, so I won't cite it as an offer in a counter.");
  const groups = [[...head, "", ...marketLines(f.offer, m)]];
  if (negotiate && !check) return counterOf(f, m, state, now, groups);
  const next = check ? "If this is an offer you have, tell me the company and I'll keep it on file; say \"help me negotiate\" for a counter." : "Say \"help me negotiate\" for a counter email that cites these numbers, or \"compare my offers\" once you have another.";
  groups.push([next]);
  return answer(OFFER_INTENT.bench, m.pub.some((b) => b.shown) || m.posted?.shown ? "benchmarked" : "no_benchmark", groups);
}
async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function counterOf(f: OnFile, m: Market, state: OfferChatState, _now: number, lead: string[][] = []): Promise<OfferAnswer> {
  const o = f.offer;
  if (o.unsettled) return answer(OFFER_INTENT.counter, "unsettled", [...lead, [`I can't draft a counter for ${o.company || "this offer"} yet. ${unsettledText(o)}`]]);
  if (isEstimate(f)) {
    return answer(OFFER_INTENT.counter, "estimate_only", [...lead, [`${o.company || "This offer"} is your estimate of an offer, not an offer you have, so there is nothing to counter yet: a counter would thank them for an offer they have not made. Text me the terms once they make it.`]]);
  }
  // A rate is never set against a yearly median, nor is a job that is not a full year.
  const bench = o.rate || o.part_year ? null : citable(m);
  // Other offers the person told this thread about (company and base in their words) are competing offers.
  // An offer the person only estimated is not one they have: never cited as a competing offer (LOOP 13).
  // D-069: a competing offer in another currency is never weighed against this base (that would need a sourced rate).
  // Round 2: weighed only like for like (comparable); any other offer the person has is cited as they wrote it, with no arithmetic.
  const others = [...o.competing.filter((c) => !sameCompany(c.company, o.company)).map((c) => ({ ...c, plain: c.plain !== false })), ...state.offers.filter((x) => x !== f && !!x.confirmed && !isEstimate(x) && !x.offer.unsettled && !sameCompany(x.offer.company, o.company) && (x.offer.base != null || x.offer.rate) && x.offer.company && !o.competing.some((c) => sameCompany(c.company, x.offer.company)))
    .map((x) => ({ company: x.offer.company, base: x.offer.base ?? 0, said: x.said, currency: x.offer.currency, assumed: !!x.offer.currency_assumed?.base, rated: !!x.offer.rate, abroad: (placeKind(x.offer) === "us") !== (placeKind(o) === "us"),
      plain: !x.offer.rate && !x.offer.part_year && !x.offer.total && /\b(?:base|salary)\b/i.test(x.offer.from?.base ?? ""), onFile: true, written: x.offer.written?.base ?? (x.offer.rate ? rateSaid(x.offer) : x.offer.base != null ? m$(x.offer, "base", x.offer.base) : undefined) }))];
  const competing = others.filter((c) => comparable(o, c)), cited = others.filter((c) => !comparable(o, c) && c.company && c.written);
  const script = (CareerNegotiation as any).factScript({ company: o.company, role: titleOf(o), base: o.base, signing: o.signing }, { competing, deadline: o.deadline, benchmark: bench ? { median: bench.median, cite: bench.cite } : null, money: moneyFor(o) });
  let email: string = script.email;
  // The figure the person said they want is the ask; code never makes one up from another offer of theirs on file (it is
  // cited, and the ask names no number).
  const inline = o.competing.some((c) => c.plain !== false && comparable(o, c) && o.base != null && c.base > o.base);
  if (!o.ask && !inline) email = email.replace(/^Could you bring the base to [^?]*\?/m, "Could you improve the base?");
  if (o.ask) email = email.split("\n").map((l) => /^(?:Could you|Is there flexibility)/.test(l) ? `Could you bring the base to ${o.ask!.written}? ${l.slice(l.indexOf("? ") + 2)}` : l).join("\n");
  if (cited.length) {
    const lines = email.split("\n"), at = lines.findIndex((l) => /^(?:Could you|Is there flexibility)/.test(l));
    lines.splice(at >= 0 ? at : lines.length, 0, ...cited.map((c) => `I also have an offer from ${c.company}: ${c.written}.`));
    email = lines.join("\n");
  }
  // A competing offer leads the ask; the benchmark is still cited beside it when it is above the base.
  if (bench && o.base != null && bench.median > o.base && !email.includes(bench.cite)) {
    const lines = email.split("\n");
    const at = lines.findIndex((l) => /^I have another offer/.test(l));
    lines.splice(at >= 0 ? at + 1 : Math.max(lines.length - 3, 0), 0, `${bench.cite} shows a median of ${usd(bench.median)}.`);
    email = lines.join("\n");
  }
  const benchCited = bench && o.base != null && bench.median > o.base ? bench.cite : null;
  const card0 = (CareerNegotiation as any).approvalCard("counter_email", { title: `Counter for ${o.company || "your offer"}: review before you send it`, body: email, destination: null });
  const card: OfferCard = { ...card0, kind: "counter_email", destination: null, payload_hash: await sha256(email), benchmark: benchCited };
  const why = benchCited ? `It cites ${benchCited}: median ${usd(bench!.median)}.`
    : bench ? `Your base is already at or above the market median I have (${usd(bench.median)}, ${bench.cite}), so the draft asks for flexibility instead of citing it.`
    : o.part_year ? `You said ${o.part_year}, which is not a full year of full-time work, so the draft cites no full-year market number and asks for flexibility.`
    : o.rate ? "Your pay is a rate, and I don't set a rate against a yearly median, so the draft cites no market number and asks for flexibility."
    : "I have no market number with enough data behind it, so the draft cites none and asks for flexibility.";
  const yours = o.ask ? ` It asks for the figure you gave, ${o.ask.written}.` : / base to /.test(email) ? "" : " It names no figure of your own: tell me the number you want and I'll put it in.";
  const groups = [...lead, [`A counter for ${o.company || "your offer"}, on a card for your review. ${why}${yours}`, "", email], ["On a call:", script.call],
    ["Nothing is sent: Trainee has no send for this draft. Edit it, then send it from your own email."]];
  return answer(OFFER_INTENT.counter, "drafted", groups, card);
}
async function compareTurn(all: OnFile[], postings: PostingsReader | null, data: OfferData, now: number): Promise<OfferAnswer> {
  // An offer that is not settled is not put beside another: its figures are not known well enough to compare.
  const list = all.filter((f) => !f.offer.unsettled), out = all.filter((f) => f.offer.unsettled);
  if (list.length < 2) return answer(OFFER_INTENT.compare, "unsettled", [[`I can't compare yet: ${out.map((f) => `${f.offer.company || "one offer"} is not settled. ${unsettledText(f.offer)}`).join(" ")}`]]);
  const ms = await Promise.all(list.map((f) => marketFor(f.offer, postings, data, now)));
  const name = (f: OnFile, i: number) => f.offer.company || `offer ${i + 1}`;
  const row = (what: string, val: (f: OnFile, i: number) => string) => `${what}: ${list.map((f, i) => `${name(f, i)} ${val(f, i)}`).join("; ")}.`;
  const lines = [`Your ${list.length} offers side by side, as you told me:`];
  lines.push(row("Base", (f) => { const o = f.offer; return partRate(o) ? `${rateSaid(o)} (${NOT_YEARLY}: you said ${o.part_year})` : o.base != null ? `${m$(o, "base", o.base)}${o.rate && o.annualized ? ` (an estimate: ${rateIn(o.rate.amount, cur(o, "base"))} ${PER[o.rate.period]} x ${o.annualized.assumption})` : ""}` : o.rate ? `${rateIn(o.rate.amount, cur(o, "base"))} ${PER[o.rate.period]} (no yearly figure)` : "not given"; }));
  if (out.length) lines.push(`Not included: ${out.map((f) => f.offer.company || "one offer").join(", ")} (not settled yet).`);
  lines.push(row("Signing", (f) => f.offer.signing != null ? m$(f.offer, "signing", f.offer.signing) : "not given"));
  lines.push(row("Bonus", (f) => f.offer.bonus != null ? m$(f.offer, "bonus", f.offer.bonus) : f.offer.bonus_pct != null ? `target ${f.offer.bonus_pct}% (target, not guaranteed)` : "not given"));
  lines.push(row("Equity", (f) => f.equity ? `${f.equity} (as you said it, not valued)` : "not given"));
  lines.push(row("Place", (f) => placeOf(f.offer) ?? "not given"));
  lines.push(row("Deadline", (f) => f.offer.deadline?.text ?? "not given"));
  lines.push(row("First-year cash (base, signing and a stated bonus amount)", (f) => { const g = guaranteed(f.offer); return partRate(f.offer) ? `not worked out (${NOT_YEARLY})` : g != null ? `${m$(f.offer, "base", g)}${f.offer.rate && f.offer.annualized ? ` (an estimate from ${rateSaid(f.offer)} x ${f.offer.annualized.assumption})` : ""}` : f.offer.base != null ? notAdded(f.offer) : "unknown"; }));
  if (list.some((f) => targetAmount(f.offer) != null)) lines.push(row("If the target bonus pays in full (not guaranteed)", (f) => { const t = targetAmount(f.offer), g = guaranteed(f.offer); return t != null && g != null ? m$(f.offer, "base", g + t) : "no target bonus given"; }));
  if (list.some((f) => f.equity)) lines.push(row("Equity worked out (at the grant value; not cash, never added to the cash above)", (f) => f.equity ? equityValue(f.equity).short : "none given"));
  if (list.some((f) => (f.benefits ?? []).length)) lines.push(row("Benefits as given (not added to pay)", (f) => (f.benefits ?? []).length ? f.benefits!.map((b) => b.text).join(", ") : "none given"));
  lines.push(`Where the figures came from: ${list.map((f, i) => `${name(f, i)}: ${sourceLine(f) ?? "nothing stated"}`).join("; ")}.`);
  const est = list.filter(isEstimate);
  if (est.length) lines.push(`${est.map((f, i) => name(f, i)).join(" and ")}: your estimate of an offer, not an offer you have.`);
  lines.push(row("Against the market", (f, i) => {
    const b = citable(ms[i]);
    if (!b) return isUsd(f.offer) ? "no market number with enough data" : `no market number (the offer is in ${curName(f.offer)}; the public pay data on file is in US dollars)`;
    const pub = ms[i].pub.find((x) => x.shown && x.median === b.median && x.cite && b.cite.startsWith(x.cite));
    const pct = f.offer.base != null && pub ? percentileOf(f.offer.base, pub) : null;
    return `median ${usd(b.median)} (${b.cite})${pct ? `, your base ${pct}` : f.offer.base != null ? `, your base ${f.offer.base >= b.median ? "at or above" : "below"} it` : ""}`;
  }));
  // D-069: offers said in different currencies are shown each in its own and never converted or ranked against each other.
  const currencies = [...new Set(list.map((f) => f.offer.currency ?? "USD"))];
  if (currencies.length > 1 || !currencies.every(known) || list.some((f) => f.offer.currency_assumed?.base)) lines.push(`Currencies: ${list.map((f, i) => `${name(f, i)} in ${curName(f.offer)}`).join(", ")}. No sourced exchange rate is on file, so the amounts are not converted, and the offers are not ranked on pay against each other.`);
  const places = new Set(list.map((f) => f.offer.metro ?? f.offer.city));
  lines.push(places.size > 1 ? "Cost of living: no cost-of-living dataset is on file, so the places are not adjusted against each other." : "Cost of living: same place, so no adjustment is needed.");
  const deadlines = list.filter((f) => f.offer.deadline);
  if (deadlines.length) lines.push(`Answer first: ${deadlines.map((f, i) => `${name(f, i)} by ${f.offer.deadline!.text}`).join(", ")}.`);
  return answer(OFFER_INTENT.compare, "compared", [lines, ["Say \"help me negotiate with <company>\" for a counter email that cites these numbers."]], null, comparisonOf(list));
}

// The other offer a counter may be drafted to when none is named: the one told as an offer, never one only mentioned.
function onFile(offer: Offer, equity: string | null, said: string, words: string, at: number): OnFile {
  return { offer, equity, said, at, src: sourcesOf(offer, equity, words), benefits: benefitsOf(words) };
}
function fresh(state: OfferChatState | null, now: number): OfferChatState {
  const offers = Array.isArray(state?.offers) ? state!.offers : [];
  return { v: 1, pieces: [], asked: [], at: now, offers, ...(state?.target ? { target: state.target } : {}) };
}
function keep(state: OfferChatState, f: OnFile): OfferChatState {
  const offers = state.offers.filter((x) => !(f.offer.company && sameCompany(x.offer.company, f.offer.company)));
  // A competing offer the person named with its base is kept as an offer too.
  for (const c of f.offer.competing) {
    if (!c.company || offers.some((x) => sameCompany(x.offer.company, c.company))) continue;
    const o = parseOfferWords(c.said, offerData.get());
    Object.assign(o, { company: c.company, base: c.base, hourly: null, rate: null, annualized: null, period_fact: null, competing: [], currency: c.currency ?? UNKNOWN_CURRENCY, marks: undefined, currency_assumed: c.assumed ? { base: true } : {} });
    o.currencies = { ...(o.currencies ?? {}), base: o.currency }; o.currency_fact = !known(o.currency) ? "currency not stated" : c.assumed ? "currency not stated: read as US dollars, which is an assumption; please confirm the currency" : null;
    Object.assign(o, { written: c.written ? { base: c.written } : {}, place_kind: c.abroad ? "other" : o.place_kind, open: [], unsettled: false });
    offers.push({ ...onFile(o, null, c.said, c.said, f.at), aside: true });
  }
  // The offer told in this message is the last on file; one only mentioned beside it never is.
  offers.push(f);
  return { ...state, pieces: [], asked: [], offers: offers.slice(-MAX_ON_FILE) };
}
// The offers on file a message names, by the company as told or by any of the firm's names ("JPM" for JPMorganChase).
function named(message: string, offers: OnFile[]): OnFile[] {
  const firms: any[] = (CareerPaths as any).firmGuide()?.firms || [];
  const namesOf = (f: OnFile) => [f.offer.company, ...(firms.find((x) => x.firm_id === f.offer.firm_id)?.aliases || [])].filter(Boolean).map((w) => String(w).toLowerCase());
  return offers.filter((f) => namesOf(f).some((w) => hasWord(message, w, true) || (w.length > 4 && hasWord(message, w))));
}

const AMEND_LEAD = /^\W*(?:actually|correction|sorry|oops|update|oh|wait|they (?:raised|bumped|increased|upped|lowered|cut)|it'?s|it is|that'?s|that is|the base is|base is|plus|also|i meant)\b/i;
const STRONG_LEAD = /^\W*(?:actually|correction|they (?:raised|bumped|increased|upped|lowered|cut)|i meant)\b|\bi meant\b/i;
const STALE_WORD = /\d\s?[kKmM]\b|\d{4,}|[$€£¥₹]|\b(?:base|salary|bonus|signing|equity|rsus?|per (?:hour|month|week|year)|hourly|monthly|weekly|annual\w*|intern\w*|contract\w*|part[- ]time|full[- ]time|remote|relocat\w*|canadian|australian|american|swiss|dollars?|euros?|pounds?|francs?|yen|rupees?|pesos?|usd|cad|eur|gbp|currency)\b|\bin [A-Z]/i;
// The offer on file with one field changed by `message`, "stale" when the message bears on it and is not a clean change, null
// when the message is not about the offer.
function amendOf(message: string, o: Offer, data: OfferData): Offer | "stale" | null {
  if (!AMEND_LEAD.test(message) && !STALE_WORD.test(message) && !(!o.company && firmFor(message)) && !(o.open ?? []).some((x) => /could be/.test(x))) return null;
  const body = message.replace(/^\W*(?:(?:sorry|actually|correction|oops|oh|wait|update)\b[,:.!]?\s*)+/i, "").replace(/\s+not\s+\$?\d[\d,.]*\s?[kKmM]?\b/, "");
  const stale = STRONG_LEAD.test(message) || STALE_WORD.test(message) ? "stale" as const : null;
  // The period alone: the figure on file was per that period.
  const per = /^(?:that'?s|it'?s|it is|that is|they'?re)\s+(?:(?:per|a|an|each)\s+(hour|day|week|month|year)|(hourly|daily|weekly|bi-?weekly|monthly|yearly|annual))\b[.!]?$/i.exec(body);
  // A place that settles an ambiguous one ("Ontario, CA" then "California").
  const amb = (o.open ?? []).some((x) => /could be/.test(x)) && o.place ? /^(?:it'?s|it is|in)?\s*(?:in\s+)?([A-Z][A-Za-z ]+?)[.!]?$/.exec(body) : null;
  // The currency alone: "it's in CAD", "in euros", "USD".
  const code = /\d/.test(body) ? null : currencyOf((/^(?:(?:it'?s|that'?s|it is|that is|they pay|paid)\s+)?(?:paid\s+)?in\s+([A-Za-z. ]+?)[.!]?$/i.exec(body)?.[1] ?? (/^[A-Z]{3}$/.test(body) ? body : "")).trim());
  let p: Offer;
  if (per && !o.rate && o.base != null) p = parseOfferWords(`${o.written?.base ?? o.base} ${per[1] ? `per ${per[1]}` : per[2]}`, data);
  else if (amb) { p = parseOfferWords(`It is in ${o.place!.split(",")[0]}, ${amb[1]}`, data); if (p.unsettled || !p.place) return "stale"; }
  else if (code && code.length === 3) {
    const off: Offer = { ...o, marks: { ...(o.marks ?? {}) }, written: { ...(o.written ?? {}) } };
    for (const k of ["base", "signing", "bonus", "bonus_target"] as const) if (off[k] != null || (k === "base" && off.rate)) { const m = off.marks![k]; if (!m || m === "$" || k === "base") { off.marks![k] = code; if (m !== code) delete off.written![k]; } }
    off.open = (off.open ?? []).filter((x) => !/^a currency/.test(x)); off.unsettled = off.open.length > 0;
    return settleCurrency(off);
  } else p = parseOfferWords(body, data);
  const firm = !o.company ? firmFor(message) : null;
  if (p.company && o.company && !sameCompany(p.company, o.company)) return null; // another company's offer: not an amendment
  if (p.unsettled) return stale;
  const changes = p.base != null || !!p.rate || !!p.place || !!p.metro || !!p.part_year || p.signing != null || p.bonus != null || p.bonus_pct != null || !!p.ask || !!p.deadline || !!p.total || p.competing.length > 0 || !!firm;
  if (!changes) return stale;
  const base: Offer = { ...o, open: amb ? (o.open ?? []).filter((x) => !/could be/.test(x)) : o.open };
  const out = mergeOffers(base, { ...p, company: firm?.name ?? null, firm_id: firm?.firm_id ?? null, lca_company_id: firm?.lca_company_id ?? null, sector: firm?.sector ?? null, title: p.title && /\b(?:as|title|role|position)\b/i.test(body) ? p.title : null, role: p.title && /\b(?:as|title|role|position)\b/i.test(body) ? p.role : null }, data);
  if (base.base != null && !p.rate && p.base == null && base.rate == null) { out.open = [...(base.open ?? []), ...(p.open ?? [])]; out.unsettled = out.open.length > 0; }
  return out;
}
const firmFor = (message: string): any | null => message.trim().split(/\s+/).length <= 3 ? (CareerPaths as any).firmGuide()?.firms?.find((f: any) => [f.name, ...(f.aliases ?? [])].some((w: string) => hasWord(message, String(w).toLowerCase(), true))) ?? null : null;

// ---------- D-078: confirm before compare ----------
// The reading of one offer (or rate check) as the block the person confirms. Every field comes from the stored Offer, so
// the block's hash binds the yes to exactly what will be benchmarked and drafted.
function blockOf(f: OnFile, check: boolean): string {
  return readingBlock(f.offer, { equity: f.equity, benefits: (f.benefits ?? []).map((b) => b.text), check, estimate: isEstimate(f) });
}
async function show(state: OfferChatState, f: OnFile, then: Then, check: boolean, notGiven: Field[], now: number, o: { lead?: string; names?: string[]; postings?: PostingsReader | null; data?: OfferData } = {}): Promise<OfferTurnResult> {
  // Not settled: the restatement and the ask, as before. Nothing is compared, so there is nothing to confirm yet.
  if (f.offer.unsettled) return { answer: answer(OFFER_INTENT.ask, "unsettled", [[unsettledText(f.offer)]]), state };
  const block = blockOf(f, check);
  const shown: Shown = { hash: await readingHash(block), block, at: now, then, notGiven, check: check ? f : null, ...(o.names?.length ? { names: o.names } : {}) };
  return { answer: answer(OFFER_INTENT.confirm, "confirm", [[...(o.lead ? [o.lead] : []), block]]), state: { ...state, shown } };
}
// The person's yes: the offer whose block, printed again now, is the block shown (same hash) is confirmed, with the time;
// then what they asked for runs on that confirmed offer. Anything else confirms nothing.
async function confirmShown(shown: Shown, state: OfferChatState, postings: PostingsReader | null, data: OfferData, now: number, lastReply: string | null): Promise<OfferTurnResult> {
  const cands = shown.check ? [shown.check] : state.offers;
  let hit: OnFile | null = null;
  for (const f of cands) { const b = blockOf(f, !!shown.check); if (b === shown.block && (await readingHash(b)) === shown.hash) { hit = f; break; } }
  if (!hit || (lastReply && !lastReply.includes(shown.block))) {
    return { answer: answer(OFFER_INTENT.confirm, "not_confirmed", [["That yes was not to the reading I showed just before it, so it confirms nothing and I have compared nothing. Tell me the offer again and I'll show you how I read it."]]), state };
  }
  const c: Confirmed = { by: "person", at: now, hash: shown.hash };
  const f: OnFile = { ...hit, confirmed: c };
  // An offer named beside it (shown in the same block as "another offer you mentioned") is confirmed with it.
  const beside = (x: OnFile) => x.aside && !x.confirmed && hit!.offer.competing.some((k) => sameCompany(k.company, x.offer.company));
  const next: OfferChatState = shown.check ? state : { ...state, offers: state.offers.map((x) => x === hit ? f : beside(x) ? { ...x, confirmed: c } : x) };
  if (shown.then === "compare") return compareStep(next, shown.names ? next.offers.filter((x) => shown.names!.some((n) => sameCompany(n, x.offer.company))) : [], postings, data, now, next);
  if (shown.then === "counter") {
    const m = await marketFor(f.offer, postings, data, now);
    return { answer: await counterOf(f, m, next, now), state: { ...next, target: f.offer.company } };
  }
  const negotiate = shown.then === "bench_counter";
  return { answer: await benchTurn(f, !!shown.check, shown.notGiven, postings, data, now, negotiate, next), state: negotiate && !shown.check ? { ...next, target: f.offer.company } : next };
}
// Compare the offers on file (or the ones named): each must be confirmed first; the first that is not is shown for a yes.
async function compareStep(state: OfferChatState, picked: OnFile[], postings: PostingsReader | null, data: OfferData, now: number, unchanged: OfferChatState | null): Promise<OfferTurnResult> {
  const list = (picked.length >= 2 ? picked : state.offers).slice(-3);
  if (list.length < 2) {
    const have = state.offers.map((f) => f.offer.company || "one offer without a company").join(", ");
    return { answer: answer(OFFER_INTENT.compare, "need_offers", [[`${have ? `I have one offer on file in this chat: ${have}.` : "I have no offers on file in this chat yet."} Text me each offer (company, base, city and title, plus any signing bonus, bonus, equity or deadline) and I'll put them side by side.`]], null, list.length ? comparisonOf(list) : null), state: unchanged ?? state };
  }
  const waiting = list.filter((f) => !f.confirmed && !f.offer.unsettled);
  if (waiting.length) {
    const w = waiting[0];
    const lead = `Before I compare, confirm how I read ${w.offer.company ? `the ${w.offer.company} offer` : "this offer"}${waiting.length > 1 ? ` (then ${waiting.length - 1} more)` : ""}.`;
    return show(state, w, "compare", false, missingOf(w.offer), now, { lead, names: picked.length >= 2 ? picked.map((x) => x.offer.company).filter((x): x is string => !!x) : undefined });
  }
  return { answer: await compareTurn(list, postings, data, now), state };
}

// One turn. `answer` null: not an offer turn (the router answers); `state` is what the thread keeps either way (a half-told
// offer whose ask was not answered by this message is dropped, so the ask is only ever the last word).
// `lastReply`: the reply sent just before this message, when the caller has it; a yes confirms a reading only when that
// reply showed it.
export async function offerChatTurn(o: { message: string; state: OfferChatState | null; now: number; postings?: PostingsReader | null; lastReply?: string | null }): Promise<OfferTurnResult> {
  const message = norm(String(o.message ?? "")).trim();
  const data = offerData.get();
  const postings = o.postings ?? null;
  const prior = o.state && typeof o.state === "object" ? o.state : null;
  const state = fresh(prior, o.now);
  const pending = prior && Array.isArray(prior.pieces) && prior.pieces.length && Array.isArray(prior.asked) && prior.asked.length && o.now - prior.at < ASK_TTL_MS ? prior : null;
  const unchanged: OfferChatState | null = prior ? { ...state, offers: state.offers } : null;
  if (!message) return { answer: null, state: unchanged };
  // D-078 step 0: the answer to a reading shown in the reply just before this one. A plain yes confirms it (and only it);
  // a plain no asks what to change; anything else drops it (`fresh` keeps no `shown`), and a correction below shows the
  // reading again.
  const shownP = prior?.shown && o.now - prior.shown.at < CONFIRM_TTL_MS ? prior.shown : null;
  if (shownP && plainYes(message)) return confirmShown(shownP, state, postings, data, o.now, typeof o.lastReply === "string" && o.lastReply.trim() ? o.lastReply : null);
  if (shownP && plainNo(message)) return { answer: answer(OFFER_INTENT.confirm, "not_confirmed", [["OK, nothing is confirmed and nothing is compared. What should I change? Tell me the right detail, for example \"the base is $150k a year\" or \"it's in CAD\"."]]), state };
  // "No, it's 160k": the correction itself.
  const said = shownP ? message.replace(/^\W*(?:no|nope|not quite|wrong)\b[\s,.:;!-]*(?=\S)/i, "") : message;
  // MIRROR WA-1 (2026-11-11, the owner's WhatsApp benchmark C7): "hypothetically if i had two offers, 120k in chicago vs 140k
  // in nyc, how would you think about it" was taken as a real offer ("Got it: Chicago metro, $120,000") and the job title
  // asked for. An offer the person says is hypothetical is not theirs: nothing is kept, and the turn goes on (the brain answers it).
  if (HYPOTHETICAL.test(message)) return { answer: null, state: unchanged };
  const negotiate = NEGOTIATE.test(message);

  // 1. The answer to the one question asked about a half-told offer.
  // A control phrase ("help me negotiate") is never the answer to the ask.
  if (pending && !OTHER_ASK.test(message) && !COMPARE.test(message) && !/^\W*(?:please\s+)?(?:help me\s+)?(?:negotiat\w*|counter)\b/i.test(message)) {
    const { equity, rest } = equityOf(message);
    const add = parseOfferWords(rest, data, { asked: pending.asked });
    const filled = pending.asked.filter((f) => f === "city" ? !!add.city : f === "base" ? add.base != null : !!add[f]);
    if (filled.length) {
      const pieces = [...pending.pieces, rest];
      const offer = pieces.map((p, i) => parseOfferWords(p, data, i ? { asked: pending.asked } : {})).reduce((a, b) => mergeOffers(a, b, data));
      const priorEquity = pending.pieces.map((p) => equityOf(p).equity).filter(Boolean).join(", ");
      const f = onFile(offer, [priorEquity, equity].filter(Boolean).join(", ") || null, pieces.join(" / "), [...pending.pieces, message].join(". "), o.now);
      const check = pending.mode === "check";
      const next = check ? state : keep(state, f);
      // D-078: the reading is shown for the person's yes; nothing is benchmarked yet.
      return show(next, f, negotiate ? "bench_counter" : "bench", check, missingOf(offer), o.now);
    }
  }

  // 1b. Round 3, stale protection. A later message about the offer on file either amends one field cleanly (the base, the
  // period, the place, the employment type, a component, the currency, the figure wanted) or, when it has a pay, period,
  // place, currency or employment word and code cannot tell what it changes, marks that offer unsettled: the reply restates
  // what is on file and asks what changed, and nothing is compared or drafted from it until it is told again.
  // D-078: a correction to a rate check's reading (never kept on file) reads the check again and shows it again.
  if (shownP?.check && !COMPARE.test(said) && !OTHER_ASK.test(said)) {
    const a = amendOf(said, shownP.check.offer, data);
    if (a && a !== "stale") return show(state, onFile(a, shownP.check.equity, `${shownP.check.said} / ${said}`, `${shownP.check.said}. ${said}`, o.now), "bench", true, missingOf(a), o.now);
  }
  const told = state.offers.filter((x) => !x.aside), onName = named(message, told), last = onName.length === 1 ? onName[0] : told[told.length - 1];
  if (last && !pending && !COMPARE.test(said) && !OTHER_ASK.test(said) && !/\?\s*$/.test(said) && !(CHECK.test(said) && !AMEND_LEAD.test(said))) {
    const a = amendOf(said, last.offer, data);
    if (a) {
      const both = `${last.said} / ${said}`;
      // D-078: a change to any field puts the offer back to unconfirmed (`confirmed: null`), and its reading is shown again.
      const f: OnFile = a === "stale" ? { ...last, confirmed: null, offer: { ...last.offer, unsettled: true, open: [...(last.offer.open ?? []), `your later message "${message}": I could not tell what it changes`] } }
        : { ...onFile(a, last.equity, both, `${last.said}. ${said}`, o.now), aside: last.aside, confirmed: null };
      const next = { ...state, offers: state.offers.map((x) => x === last ? f : x) };
      if (a === "stale") return { answer: answer(OFFER_INTENT.ask, "unsettled", [[`You told me this offer: ${readingOf(last.offer).join("; ")}. Then you wrote "${message}", and I could not tell what it changes, so I have stopped using this offer for a comparison or a counter. What changed? Tell me the offer again in one line and I'll redo it.`]]), state: next };
      return show(next, f, negotiate ? "bench_counter" : "bench", false, missingOf(f.offer), o.now, { lead: last.confirmed ? "That changes the offer you confirmed, so it needs your yes again before I compare anything." : undefined });
    }
  }

  // 2. Compare the offers on file (or the ones named); each is confirmed first.
  if (COMPARE.test(message)) return compareStep(state, named(message, state.offers), postings, data, o.now, unchanged);

  // 3. An offer or a rate check in this message.
  const { equity, rest } = equityOf(message);
  const offer = parseOfferWords(rest, data);
  const isOffer = OFFER_WORDS.test(message), isCheck = CHECK.test(message);
  if ((offer.base != null || offer.rate || offer.total) && (isOffer || isCheck || negotiate) && (offer.role || offer.city || offer.company)) {
    const check = !isOffer && !offer.company;
    const f = onFile(offer, equity, rest, message, o.now);
    const missing = missingOf(offer);
    if (missing.length) {
      const next: OfferChatState = { ...state, pieces: [rest], asked: missing, at: o.now, mode: check ? "check" : "offer" };
      return { answer: answer(OFFER_INTENT.ask, "ask", [[askFor(missing, offer)]]), state: next };
    }
    const next = check ? state : keep(state, f);
    // D-078: the reading first; the benchmark (and a counter, when asked) only after the person's yes to it.
    return show(next, f, negotiate ? "bench_counter" : "bench", check, [], o.now);
  }

  // 4. "Help me negotiate" over an offer on file.
  if (negotiate && state.offers.length) {
    const before = state.offers.filter((x) => state.target && sameCompany(x.offer.company, state.target));
    const picked = named(message, state.offers).length ? named(message, state.offers) : before, told = state.offers.filter((x) => !x.aside);
    // Which offer? The one named; else the only one told as an offer. With several and none named, ask: never guess the company.
    if (!picked.length && told.length > 1) return { answer: answer(OFFER_INTENT.ask, "which_offer", [[`Which offer should the counter go to: ${told.map((x) => x.offer.company || "the one with no company").join(" or ")}? Say "help me negotiate with <company>".`]]), state };
    const f = picked.length ? picked[picked.length - 1] : told[0] ?? state.offers[state.offers.length - 1];
    // D-078: an offer not confirmed yet is shown for a yes first (one not settled, or only an estimate, gets no counter anyway).
    if (!f.confirmed && !f.offer.unsettled && !isEstimate(f)) return show(state, f, "counter", false, missingOf(f.offer), o.now, { lead: "Before I draft a counter, confirm how I read this offer." });
    const m = await marketFor(f.offer, postings, data, o.now);
    return { answer: await counterOf(f, m, state, o.now), state: { ...state, target: f.offer.company } };
  }
  return { answer: null, state: unchanged };
}
