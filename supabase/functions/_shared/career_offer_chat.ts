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
import { type Bench, benchmarks, type Field, hasWord, MAX_MESSAGE, mergeOffers, MIN_N, type Offer, type OfferData, parseOfferWords, payData } from "./career_offer.ts";
import { CareerNegotiation, CareerPaths } from "./router_core.career.js";
import { searchWords } from "./career_ingest.ts";
import type { KV, Src } from "./file_family.ts";
import type { OfferComparison } from "./file_family_apply.ts";

export const OFFER_INTENT = { ask: "career_offer_ask", bench: "career_offer_benchmark", compare: "career_offer_compare", counter: "career_offer_counter" } as const;
export const ASK_TTL_MS = 24 * 3600_000;
export const MAX_ON_FILE = 6; // offers kept in the thread
// The pay data source. Production reads the bundled datasets; a test points it at fixture datasets.
export const offerData = { get: (): OfferData => payData() };

// src (LOOP 13): where each figure came from, read from the person's own words (offer letter, verbal, their estimate, or
// just "you told me"). An offer whose base is the person's estimate is not an offer they have: it is never cited as one.
export type SrcLabel = "offer letter" | "verbal" | "your estimate" | "you told me";
export interface OnFile { offer: Offer; equity: string | null; said: string; at: number; src?: Partial<Record<"base" | "signing" | "bonus" | "equity" | "benefits" | "terms", SrcLabel>>; benefits?: { text: string; src: SrcLabel }[] }
// Kept in the thread's `offerBenchmark` store (career_host.js STATE_KEYS; erased with the rest). The pieces/asked/at
// fields keep the shape WO-036's brain tool reads, so the two never disagree about a half-told offer.
export interface OfferChatState { v: 1; pieces: string[]; asked: Field[]; at: number; mode?: "offer" | "check"; offers: OnFile[] }
export interface PostedRow { company?: string; title?: string; location?: string; pay?: string | null }
export interface PostingsReader { search(words: string[], limit: number): Promise<PostedRow[]> }
export interface OfferCard { type: "approval_card"; kind: "counter_email"; title: string; body: string; destination: null; requires_approval: true; sent: false; note: string; payload_hash: string; benchmark: string | null }
export interface OfferAnswer { intent: string; status: string; reply: string; parts: string[]; card: OfferCard | null; comparison?: OfferComparison | null }
export interface OfferTurnResult { answer: OfferAnswer | null; state: OfferChatState | null }

const REQUIRED: Field[] = ["base", "city", "role"];
const ASK_WORDS: Record<string, string> = { base: "the base salary", city: "the city", role: "the job title" };
const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const ord = (n: number) => { const r = n % 100, t = n % 10; return `${n}${r >= 11 && r <= 13 ? "th" : t === 1 ? "st" : t === 2 ? "nd" : t === 3 ? "rd" : "th"}`; };
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ---------- what the message asks ----------
const OFFER_WORDS = /\b(offer|offers|offered|offering)\b/i;
const CHECK = /\b(is|are|would|was)\b[^?.!]*\b(good|fair|low|lowball|high|enough|competitive|reasonable|decent|market|underpaid|normal|average|ok|okay)\b|\bwhat(?:'s| is) (?:the )?(?:market|going rate)\b|\bhow does\b[^?.!]*\bcompare\b/i;
const COMPARE = /\bcompare\b[^.?!]*\boffers?\b|\bwhich offer\b|\boffers?\b[^.?!]*\b(?:side by side|compared?)\b|\bwhich (?:one )?(?:is|pays) better\b/i;
const NEGOTIATE = /\bnegotiat\w*|\bcounter(?:[- ]?offer)?\b|\bask(?:ing)? for more\b/i;
// Other asks that name a role and a place ("find data analyst jobs in Chicago") are never an offer's missing piece.
const OTHER_ASK = /\b(find|search|apply|jobs?|openings|postings|watch|alert|tailor|resume|cover letter|interview|mock)\b/i;
const EQUITY = /\b(equity|rsus?|stock|options|shares|vest\w*|cliff)\b/i;
const CLAUSES = /[;\n]|,(?!\d{3})|\.(?=\s|$)|\s+(?:and|but|plus|with)\s+/i;

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
  const kinds = new Set(said.split(CLAUSES).map((c) => kindOf(c)).filter(Boolean));
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
  const have = [o.company, o.role, o.metro_label ?? (o.remote ? "remote" : null), o.base != null ? usd(o.base) : null].filter(Boolean).join(", ");
  return `${have ? `Got it: ${have}. ` : ""}To place it against market pay I need ${list}. What ${missing.length > 1 ? "are they" : "is it"}?`;
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
  if (!postings || !o.role || !o.metro) return null;
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
  if (!o.occupation) lines.push(o.role ? `Public pay data (DOL, BLS): none mapped to "${o.role}", so no public figure.` : "Public pay data: without the job title there is no occupation to look up.");
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
  if (m.pub.every((b) => !b.shown) && !p?.shown) lines.push("So I have no market number for this one, and I won't make one up.");
  const uniq = [...new Set(urls)];
  if (uniq.length) lines.push("Sources:", ...uniq);
  return lines;
}
function offerLine(f: { offer: Offer; equity: string | null }, check: boolean): string {
  const o = f.offer;
  const head = [o.company, o.role, o.remote ? "remote" : o.metro_label ?? o.city].filter(Boolean).join(", ");
  const pay = [o.base != null ? `base ${usd(o.base)}${o.hourly ? ` (${usd(o.hourly)} an hour x 2,080 hours)` : ""}` : null, o.signing != null ? `signing ${usd(o.signing)}` : null,
    o.bonus != null ? `bonus ${usd(o.bonus)}` : null, o.bonus_target != null ? `target bonus ${usd(o.bonus_target)} (not guaranteed)` : null,
    o.bonus_pct != null ? `target bonus ${o.bonus_pct}%${o.base != null ? ` (${usd(o.base * o.bonus_pct / 100)}, not guaranteed)` : ""}` : null].filter(Boolean).join(", ");
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
const guaranteed = (o: Offer) => o.base != null ? o.base + (o.signing ?? 0) + (o.bonus ?? 0) : null;
const targetAmount = (o: Offer) => o.bonus_target != null ? o.bonus_target : o.bonus_pct != null && o.base != null ? Math.round(o.base * o.bonus_pct / 100) : null;
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
    rows.push(o.base != null ? { k: "Base", v: o.hourly ? `${usd(o.hourly)} an hour x 2,080 hours = ${usd(o.base)} a year` : usd(o.base), src: src("base") } : unknown("Base"));
    rows.push(o.signing != null ? { k: "Signing bonus", v: usd(o.signing), src: src("signing") } : unknown("Signing bonus"));
    const t = targetAmount(o);
    const bonus = [o.bonus != null ? `${usd(o.bonus)} guaranteed` : null, o.bonus_target != null ? `target ${usd(o.bonus_target)}, not guaranteed` : null,
      o.bonus_pct != null ? (o.base != null ? `target ${o.bonus_pct}% of base = ${usd(t!)}, not guaranteed` : `target ${o.bonus_pct}% of base, not guaranteed`) : null].filter(Boolean).join("; ");
    rows.push(bonus ? { k: "Bonus", v: bonus, src: src("bonus") } : unknown("Bonus"));
    rows.push(f.equity ? { k: "Equity", v: equityValue(f.equity).text, src: src("equity") } : unknown("Equity"));
    const ben = f.benefits ?? [];
    const one = ben.length && ben.every((b) => b.src === ben[0].src);
    rows.push(ben.length ? { k: "Benefits", v: ben.map((b) => one ? b.text : `${b.text} (${b.src})`).join("; "), src: S(one ? ben[0].src : "you told me") } : unknown("Benefits"));
    const place = o.remote ? "remote" : o.metro_label ?? o.city;
    rows.push(place ? { k: "Place", v: place, src: src("terms") } : unknown("Place"));
    rows.push(o.deadline ? { k: "Deadline", v: o.deadline.text, src: src("terms") } : unknown("Deadline"));
    const g = guaranteed(o);
    rows.push(g != null ? { k: "Guaranteed first-year cash", v: `${usd(g)} (base + signing + guaranteed bonus; equity and benefits not added)`, src: WORKED } : unknown("Guaranteed first-year cash"));
    if (g != null && t != null) rows.push({ k: "First-year cash if the target bonus pays in full", v: `${usd(g + t)} (not guaranteed)`, src: WORKED });
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
  const m = await marketFor(f.offer, postings, data, now);
  const head = [offerLine(f, check)];
  if (notGiven.length) head.push(`Not given: ${notGiven.map((x) => ASK_WORDS[x]).join(", ")}, so I left ${notGiven.length > 1 ? "those" : "that"} out.`);
  if (!f.offer.company && !check) head.push("No company given, so the employer's own filings are not looked up.");
  const from = sourceLine(f);
  if (from) head.push(`Where these came from: ${from}.`);
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
  if (isEstimate(f)) {
    return answer(OFFER_INTENT.counter, "estimate_only", [...lead, [`${o.company || "This offer"} is your estimate of an offer, not an offer you have, so there is nothing to counter yet: a counter would thank them for an offer they have not made. Text me the terms once they make it.`]]);
  }
  const bench = citable(m);
  // Other offers the person told this thread about (company and base in their words) are competing offers.
  // An offer the person only estimated is not one they have: never cited as a competing offer (LOOP 13).
  const competing = [...o.competing, ...state.offers.filter((x) => x !== f && !isEstimate(x) && !sameCompany(x.offer.company, o.company) && x.offer.base != null && x.offer.company)
    .map((x) => ({ company: x.offer.company, base: x.offer.base!, said: x.said }))];
  const script = (CareerNegotiation as any).factScript({ company: o.company, role: o.role, base: o.base, signing: o.signing }, { competing, deadline: o.deadline, benchmark: bench ? { median: bench.median, cite: bench.cite } : null });
  let email: string = script.email;
  // A competing offer leads the ask; the benchmark is still cited beside it when it is above the base.
  if (bench && o.base != null && bench.median > o.base && !email.includes(bench.cite)) {
    const lines = email.split("\n");
    const at = lines.findIndex((l) => /^I have another offer/.test(l));
    lines.splice(at >= 0 ? at + 1 : Math.max(lines.length - 3, 0), 0, `${bench.cite} shows a median of ${usd(bench.median)}.`);
    email = lines.join("\n");
  }
  const cited = bench && o.base != null && bench.median > o.base ? bench.cite : null;
  const card0 = (CareerNegotiation as any).approvalCard("counter_email", { title: `Counter for ${o.company || "your offer"}: review before you send it`, body: email, destination: null });
  const card: OfferCard = { ...card0, kind: "counter_email", destination: null, payload_hash: await sha256(email), benchmark: cited };
  const why = cited ? `It cites ${cited}: median ${usd(bench!.median)}.`
    : bench ? `Your base is already at or above the market median I have (${usd(bench.median)}, ${bench.cite}), so the draft asks for flexibility instead of citing it.`
    : "I have no market number with enough data behind it, so the draft cites none and asks for flexibility.";
  const groups = [...lead, [`A counter for ${o.company || "your offer"}, on a card for your review. ${why}`, "", email], ["On a call:", script.call],
    ["Nothing is sent: Trainee has no send for this draft. Edit it, then send it from your own email."]];
  return answer(OFFER_INTENT.counter, "drafted", groups, card);
}
async function compareTurn(list: OnFile[], postings: PostingsReader | null, data: OfferData, now: number): Promise<OfferAnswer> {
  const ms = await Promise.all(list.map((f) => marketFor(f.offer, postings, data, now)));
  const name = (f: OnFile, i: number) => f.offer.company || `offer ${i + 1}`;
  const row = (what: string, val: (f: OnFile, i: number) => string) => `${what}: ${list.map((f, i) => `${name(f, i)} ${val(f, i)}`).join("; ")}.`;
  const lines = [`Your ${list.length} offers side by side, as you told me:`];
  lines.push(row("Base", (f) => f.offer.base != null ? usd(f.offer.base) : "not given"));
  lines.push(row("Signing", (f) => f.offer.signing != null ? usd(f.offer.signing) : "not given"));
  lines.push(row("Bonus", (f) => f.offer.bonus != null ? usd(f.offer.bonus) : f.offer.bonus_pct != null ? `target ${f.offer.bonus_pct}% (target, not guaranteed)` : "not given"));
  lines.push(row("Equity", (f) => f.equity ? `${f.equity} (as you said it, not valued)` : "not given"));
  lines.push(row("Place", (f) => f.offer.remote ? "remote" : f.offer.metro_label ?? f.offer.city ?? "not given"));
  lines.push(row("Deadline", (f) => f.offer.deadline?.text ?? "not given"));
  lines.push(row("First-year cash (base, signing and a stated bonus amount)", (f) => f.offer.base != null ? usd(guaranteed(f.offer)!) : "unknown"));
  if (list.some((f) => targetAmount(f.offer) != null)) lines.push(row("If the target bonus pays in full (not guaranteed)", (f) => { const t = targetAmount(f.offer), g = guaranteed(f.offer); return t != null && g != null ? usd(g + t) : "no target bonus given"; }));
  if (list.some((f) => f.equity)) lines.push(row("Equity worked out (at the grant value; not cash, never added to the cash above)", (f) => f.equity ? equityValue(f.equity).short : "none given"));
  if (list.some((f) => (f.benefits ?? []).length)) lines.push(row("Benefits as given (not added to pay)", (f) => (f.benefits ?? []).length ? f.benefits!.map((b) => b.text).join(", ") : "none given"));
  lines.push(`Where the figures came from: ${list.map((f, i) => `${name(f, i)}: ${sourceLine(f) ?? "nothing stated"}`).join("; ")}.`);
  const est = list.filter(isEstimate);
  if (est.length) lines.push(`${est.map((f, i) => name(f, i)).join(" and ")}: your estimate of an offer, not an offer you have.`);
  lines.push(row("Against the market", (f, i) => {
    const b = citable(ms[i]);
    if (!b) return "no market number with enough data";
    const pub = ms[i].pub.find((x) => x.shown && x.median === b.median && x.cite && b.cite.startsWith(x.cite));
    const pct = f.offer.base != null && pub ? percentileOf(f.offer.base, pub) : null;
    return `median ${usd(b.median)} (${b.cite})${pct ? `, your base ${pct}` : f.offer.base != null ? `, your base ${f.offer.base >= b.median ? "at or above" : "below"} it` : ""}`;
  }));
  const places = new Set(list.map((f) => f.offer.metro ?? f.offer.city));
  lines.push(places.size > 1 ? "Cost of living: no cost-of-living dataset is on file, so the places are not adjusted against each other." : "Cost of living: same place, so no adjustment is needed.");
  const deadlines = list.filter((f) => f.offer.deadline);
  if (deadlines.length) lines.push(`Answer first: ${deadlines.map((f, i) => `${name(f, i)} by ${f.offer.deadline!.text}`).join(", ")}.`);
  return answer(OFFER_INTENT.compare, "compared", [lines, ["Say \"help me negotiate with <company>\" for a counter email that cites these numbers."]], null, comparisonOf(list));
}

function onFile(offer: Offer, equity: string | null, said: string, words: string, at: number): OnFile {
  return { offer, equity, said, at, src: sourcesOf(offer, equity, words), benefits: benefitsOf(words) };
}
function fresh(state: OfferChatState | null, now: number): OfferChatState {
  const offers = Array.isArray(state?.offers) ? state!.offers : [];
  return { v: 1, pieces: [], asked: [], at: now, offers };
}
function keep(state: OfferChatState, f: OnFile): OfferChatState {
  const offers = state.offers.filter((x) => !(f.offer.company && sameCompany(x.offer.company, f.offer.company)));
  offers.push(f);
  // A competing offer the person named with its base is kept as an offer too.
  for (const c of f.offer.competing) {
    if (!c.company || offers.some((x) => sameCompany(x.offer.company, c.company))) continue;
    const o = parseOfferWords(c.said, offerData.get());
    o.company = c.company; o.base = c.base; o.competing = [];
    offers.push(onFile(o, null, c.said, c.said, f.at));
  }
  return { ...state, pieces: [], asked: [], offers: offers.slice(-MAX_ON_FILE) };
}
// The offers on file a message names, by the company as told or by any of the firm's names ("JPM" for JPMorganChase).
function named(message: string, offers: OnFile[]): OnFile[] {
  const firms: any[] = (CareerPaths as any).firmGuide()?.firms || [];
  const namesOf = (f: OnFile) => [f.offer.company, ...(firms.find((x) => x.firm_id === f.offer.firm_id)?.aliases || [])].filter(Boolean).map((w) => String(w).toLowerCase());
  return offers.filter((f) => namesOf(f).some((w) => hasWord(message, w, true) || (w.length > 4 && hasWord(message, w))));
}

// One turn. `answer` null: not an offer turn (the router answers); `state` is what the thread keeps either way (a half-told
// offer whose ask was not answered by this message is dropped, so the ask is only ever the last word).
export async function offerChatTurn(o: { message: string; state: OfferChatState | null; now: number; postings?: PostingsReader | null }): Promise<OfferTurnResult> {
  const message = String(o.message ?? "").trim();
  const data = offerData.get();
  const postings = o.postings ?? null;
  const prior = o.state && typeof o.state === "object" ? o.state : null;
  const state = fresh(prior, o.now);
  const pending = prior && Array.isArray(prior.pieces) && prior.pieces.length && Array.isArray(prior.asked) && prior.asked.length && o.now - prior.at < ASK_TTL_MS ? prior : null;
  const unchanged: OfferChatState | null = prior ? { ...state, offers: state.offers } : null;
  if (!message) return { answer: null, state: unchanged };
  const negotiate = NEGOTIATE.test(message);

  // 1. The answer to the one question asked about a half-told offer.
  if (pending && !OTHER_ASK.test(message) && !COMPARE.test(message)) {
    const { equity, rest } = equityOf(message);
    const add = parseOfferWords(rest, data);
    const filled = pending.asked.filter((f) => f === "city" ? !!add.city : f === "base" ? add.base != null : !!add[f]);
    if (filled.length) {
      const pieces = [...pending.pieces, rest];
      const offer = pieces.map((p) => parseOfferWords(p, data)).reduce((a, b) => mergeOffers(a, b, data));
      const priorEquity = pending.pieces.map((p) => equityOf(p).equity).filter(Boolean).join(", ");
      const f = onFile(offer, [priorEquity, equity].filter(Boolean).join(", ") || null, pieces.join(" / "), [...pending.pieces, message].join(". "), o.now);
      const check = pending.mode === "check";
      const next = check ? state : keep(state, f);
      return { answer: await benchTurn(f, check, missingOf(offer), postings, data, o.now, negotiate, next), state: next };
    }
  }

  // 2. Compare the offers on file (or the ones named).
  if (COMPARE.test(message)) {
    const picked = named(message, state.offers);
    const list = (picked.length >= 2 ? picked : state.offers).slice(-3);
    if (list.length < 2) {
      const have = state.offers.map((f) => f.offer.company || "one offer without a company").join(", ");
      return { answer: answer(OFFER_INTENT.compare, "need_offers", [[`${have ? `I have one offer on file in this chat: ${have}.` : "I have no offers on file in this chat yet."} Text me each offer (company, base, city and title, plus any signing bonus, bonus, equity or deadline) and I'll put them side by side.`]], null, list.length ? comparisonOf(list) : null), state: unchanged ?? state };
    }
    return { answer: await compareTurn(list, postings, data, o.now), state };
  }

  // 3. An offer or a rate check in this message.
  const { equity, rest } = equityOf(message);
  const offer = parseOfferWords(rest, data);
  const isOffer = OFFER_WORDS.test(message), isCheck = CHECK.test(message);
  if (offer.base != null && (isOffer || isCheck || negotiate) && (offer.role || offer.city || offer.company)) {
    const check = !isOffer && !offer.company;
    const f = onFile(offer, equity, rest, message, o.now);
    const missing = missingOf(offer);
    if (missing.length) {
      const next: OfferChatState = { ...state, pieces: [rest], asked: missing, at: o.now, mode: check ? "check" : "offer" };
      return { answer: answer(OFFER_INTENT.ask, "ask", [[askFor(missing, offer)]]), state: next };
    }
    const next = check ? state : keep(state, f);
    return { answer: await benchTurn(f, check, [], postings, data, o.now, negotiate, next), state: next };
  }

  // 4. "Help me negotiate" over an offer on file.
  if (negotiate && state.offers.length) {
    const picked = named(message, state.offers);
    const f = picked.length ? picked[picked.length - 1] : state.offers[state.offers.length - 1];
    const m = await marketFor(f.offer, postings, data, o.now);
    return { answer: await counterOf(f, m, state, o.now), state };
  }
  return { answer: null, state: unchanged };
}
