// "I want X roles that pay $Y" (owner, 2026-11-01): the pay a posting states, as numbers, held against the floor the person
// named, and the short reply a texting channel gets (the results themselves live on the hosted page, file_page.ts).
//
// Rules that do not move (reqs Q566, Q672, Q684, Q194, Q435):
//   - pay is only ever what the posting (or the search result) states; nothing is estimated, averaged or filled in;
//   - a floor "pays $X" keeps a role only when its listed pay reaches X; a role that lists no pay is never counted as
//     meeting it: it goes in its own "pay not listed" group, and the reply says how many could not be checked;
//   - pay in another currency, or with no period, is shown in its own terms and never compared with a dollar floor;
//   - a figure converted to the floor's period says so, and how (2,080 hours a year).
import { payFrom } from "./posting_pay.ts";

export const HOURS_PER_YEAR = 2080;
export type Period = "hour" | "month" | "year";
export interface Floor { amount: number; period: "hour" | "year" }
// The pay a posting states, as numbers. period: as the posting states it; null when it states none and the figure could be either
// (a bare "$45"); a bare figure of 10,000 or more is read as a year's salary. currency: as written ("$" alone or USD is USD;
// CA$, C$, CAD, A$, AU$, AUD, €, EUR, £, GBP, ₹, INR, Rs are not). text: the posting's own words, for the attribution.
// up_to: the posting gives only a ceiling ("Up to $150,000"): min is that ceiling too, and the page says "Up to".
export interface Pay { min: number; max: number; period: Period | null; currency: string; text: string; up_to?: boolean }
export type PayGroup = "meets" | "unlisted" | "below" | "unchecked";

const SYMBOL: Record<string, string> = { USD: "$", CAD: "CA$", AUD: "A$", NZD: "NZ$", SGD: "S$", HKD: "HK$", MXN: "MX$", EUR: "€", GBP: "£", JPY: "¥" };
// A currency written before a figure ("$", "CA$", "€", "USD ") or after it ("CAD"). A figure with neither is not pay: "401(k)",
// "403(b)", "40-hour", "15%", "4 weeks" never are.
const PRE = String.raw`(CA\$|C\$|AU\$|A\$|NZ\$|S\$|HK\$|MX\$|US\$|\$|€|£|¥|₹|Rs\.?\s?|\b(?:USD|CAD|AUD|NZD|SGD|HKD|MXN|EUR|GBP|INR|JPY|CHF)\s)`;
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)(\s?[kK](?![a-zA-Z(]))?`;
const SUF = String.raw`(\s?\b(?:USD|CAD|AUD|NZD|SGD|HKD|MXN|EUR|GBP|INR|JPY|CHF)\b)`;
// One pay figure, or two joined by a range word (-, –, —, to): never two figures from different clauses.
const PAY_RE = new RegExp(`${PRE}?${NUM}(?:\\s*(?:-|–|—|to)\\s*${PRE}?${NUM})?${SUF}?`, "g");
const CODE_OF: Record<string, string> = { "$": "USD", "US$": "USD", "CA$": "CAD", "C$": "CAD", "AU$": "AUD", "A$": "AUD", "NZ$": "NZD", "S$": "SGD", "HK$": "HKD", "MX$": "MXN", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };
const currencyOf = (pre: string | undefined, suf: string | undefined): string | null => {
  const w = (suf ?? "").trim() || (pre ?? "").trim();
  if (!w) return null;
  if (/^Rs\.?$/.test(w)) return "INR";
  return CODE_OF[w] ?? (/^[A-Z]{3}$/.test(w) ? w : null);
};
// The period, read only on the figure itself: right after it ("/hr", "per hour", "an hour", "a year", "annually", "per month") or
// right before it ("Hourly rate: $31", "Annual salary of $90,000"). "40-hour week" elsewhere in the sentence is not a wage.
const AFTER = /^\s*(?:\/\s*|per\s+|an?\s+|each\s+)?(hours?|hrs?|h|hourly|years?|yrs?|annum|annually|annual|months?|mos?|monthly)\b/i;
const BEFORE = /\b(hourly|per hour|annual(?:ly)?|yearly|monthly)\s*(?:base\s*)?(?:rate|pay|wage|salary|compensation)?\s*(?:of|is|:)?\s*(?:up to\s*)?$/i;
const periodWord = (w: string): Period => /^h/i.test(w) ? "hour" : /^mo/i.test(w) ? "month" : "year";

// `stated` is the posting's own pay field when it has one; the description is read only when it has none (posting_pay.ts payFrom:
// a wage or salary only, never a funding round or a gift card).
export function parsePay(stated: unknown, description?: unknown): Pay | null {
  const raw = String(stated ?? "").replace(/\s+/g, " ").trim();
  const text = raw && /\d/.test(raw) ? raw : payFrom(description);
  if (!text) return null;
  for (const m of text.matchAll(PAY_RE)) {
    const [whole, pre1, n1, k1, pre2, n2, k2, suf] = m;
    const currency = currencyOf(pre1 ?? pre2, suf);
    if (!currency) continue; // a figure with no currency is not pay
    const at = m.index ?? 0;
    let lo = Number(n1.replace(/,/g, "")) * (k1 ? 1000 : 1);
    const hasHi = n2 !== undefined;
    let hi = hasHi ? Number(n2.replace(/,/g, "")) * (k2 ? 1000 : 1) : lo;
    // "$90-120k": inside one range, the k on the upper figure belongs to the lower one too. Nowhere else does a k travel.
    if (hasHi && k2 && !k1 && lo < 1000 && hi >= 1000) lo *= 1000;
    if (!(lo > 0) || !(hi > 0)) continue;
    if (lo > hi) [lo, hi] = [hi, lo];
    const after = text.slice(at + whole.length, at + whole.length + 30), before = text.slice(Math.max(0, at - 40), at);
    const a = AFTER.exec(after), b = BEFORE.exec(before);
    const period: Period | null = a ? periodWord(a[1]) : b ? periodWord(b[1].replace(/^per /i, "")) : hi >= 10000 ? "year" : null;
    const up_to = !hasHi && /\bup to\s*$/i.test(before);
    return { min: lo, max: hi, period, currency, text, ...(up_to ? { up_to } : {}) };
  }
  return null;
}

const perYear = (n: number, p: Period) => (p === "year" ? n : p === "month" ? n * 12 : n * HOURS_PER_YEAR);
// Where a role stands against the floor. "meets": its listed pay reaches the floor (the top of a range counts; the page says when
// the range starts below it). "unchecked": another currency, or no period stated: shown, never compared. No floor: "meets".
export function payGroup(pay: Pay | null, floor: Floor | null): PayGroup {
  if (!pay) return "unlisted";
  if (pay.currency !== "USD" || !pay.period) return "unchecked";
  if (!floor) return "meets";
  return perYear(pay.max, pay.period) >= perYear(floor.amount, floor.period) ? "meets" : "below";
}
export const startsBelow = (pay: Pay | null, floor: Floor | null) => !!pay && payGroup(pay, floor) === "meets" && !!floor && perYear(pay.min, pay.period!) < perYear(floor.amount, floor.period);

const money = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));
const thousands = (n: number) => { const k = Math.round(n / 100) / 10; return Number.isInteger(k) ? String(k) : k.toFixed(1); };
const span = (a: string, b: string) => (a === b ? a : `${a}-${b}`);
// One format everywhere (Q566), in the posting's own period and currency: "$30-40/hr", "$5,000/mo", "$90-120k/yr", "CA$60-75k/yr".
// Without a period, or in a currency without a symbol here: the posting's own words.
export function payText(p: Pay): string {
  const sym = SYMBOL[p.currency];
  if (!sym || !p.period) return p.text;
  if (p.up_to) return `Up to ${payText({ ...p, up_to: false })}`;
  if (p.period === "hour") return `${sym}${span(money(p.min), money(p.max))}/hr`;
  if (p.period === "month") return `${sym}${span(money(p.min), money(p.max))}/mo`;
  return p.max >= 1000 ? `${sym}${span(thousands(p.min), thousands(p.max))}k/yr` : `${sym}${span(money(p.min), money(p.max))}/yr`;
}
// A figure in another period than the floor's, converted so the two can be compared, and saying how (Q672: an estimate is never
// presented as the employer's figure). Null when nothing was converted (same period, or not compared at all).
export function conversionNote(p: Pay | null, floor: Floor | null): string | null {
  if (!p || !floor || p.currency !== "USD" || !p.period || p.period === floor.period) return null;
  const a = perYear(p.min, p.period), b = perYear(p.max, p.period);
  if (floor.period === "hour") return `≈ $${span(String(Math.round(a / HOURS_PER_YEAR)), String(Math.round(b / HOURS_PER_YEAR)))}/hr, assuming 2,080 hrs/yr`;
  return `≈ $${span(String(Math.round(a / 1000)), String(Math.round(b / 1000)))}k/yr, assuming 2,080 hrs/yr`;
}
export const floorText = (f: Floor) => f.period === "hour" ? `$${money(f.amount)}/hr` : f.amount >= 1000 ? `$${thousands(f.amount)}k` : `$${money(f.amount)}/yr`;

// ---------------------------------------------------------------- the reply on a texting channel
// SMS, iMessage and WhatsApp (reqs Q74, Q584, Q585, Q620): plain text only (no markdown, no bullets, no bold), one or two short
// sentences that answer on their own, then the link alone on its own line, introduced by the sentence before it.
export const TEXTING = new Set(["sms", "imessage", "whatsapp"]);
export interface What { one: string; many: string }
export function resultsReply(o: { what: What; floor: Floor | null; meets: number; unlisted: number; unchecked?: number; url: string }): string {
  const total = o.meets + o.unlisted + (o.unchecked ?? 0);
  const n = (k: number) => `${k} ${k === 1 ? o.what.one : o.what.many}`;
  let first: string;
  if (!o.floor) first = `I found ${n(total)}.`;
  else if (o.meets && o.unlisted) first = `I found ${n(o.meets)} that ${o.meets === 1 ? "lists" : "list"} pay of ${floorText(o.floor)} or more, plus ${o.unlisted} that ${o.unlisted === 1 ? "doesn't" : "don't"} list pay, so I couldn't check ${o.unlisted === 1 ? "it" : "those"}.`;
  else if (o.meets) first = `I found ${n(o.meets)} that ${o.meets === 1 ? "lists" : "list"} pay of ${floorText(o.floor)} or more.`;
  else if (!o.unlisted && o.unchecked) {
    const one = o.unchecked === 1;
    return `I found ${n(o.unchecked)}, but ${one ? "it lists" : "they list"} pay in another currency or without a period, so I couldn't compare ${one ? "it" : "them"} with ${floorText(o.floor)}. Here ${one ? "it is" : "they are"} by fit, with Apply on each:\n${o.url}`;
  } else first = `I found ${n(o.unlisted)}, but ${o.unlisted === 1 ? "it doesn't" : "none of them"} list pay, so I couldn't check ${o.unlisted === 1 ? "it" : "them"} against ${floorText(o.floor)}.`;
  if (o.unchecked) first += ` ${o.unchecked} ${o.unchecked === 1 ? "lists" : "list"} pay in another currency.`;
  return `${first} Here they are by fit, with Apply on each:\n${o.url}`;
}
// The reply may carry nothing a texting app would show as formatting: no markdown emphasis, headings, bullets or link syntax.
export const MARKDOWN = /\*\*|__|^\s*[#>*-]\s|\[[^\]]*\]\([^)]*\)|`/m;
