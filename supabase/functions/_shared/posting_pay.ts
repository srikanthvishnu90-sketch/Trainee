// WO-068: the pay a posting states, read from its own text, never estimated. A range or a single figure with its currency
// and period as written ("$153,000 - $221,000 USD", "€60k–€75k", "$45/hr"); null when the posting states none.
const MONEY = String.raw`(?:[$€£]\s?\d[\d,.]*\s?[kK]?|\d[\d,.]*\s?[kK]?\s?(?:USD|EUR|GBP|CAD|AUD))`;
const RANGE = new RegExp(String.raw`(${MONEY}|\d[\d,.]*\s?[kK]?(?=\s*(?:-|–|—|to)\s*${MONEY}))(?:\s*(?:-|–|—|to)\s*(${MONEY}|\d[\d,.]*\s?[kK]?))?(?:\s*(?:USD|EUR|GBP|CAD|AUD))?(?:\s*(?:per|\/|an?)\s*(hour|hr|year|yr|annum|month))?`, "i");
const amount = (s: string) => {
  const k = /k\s*$/i.test(s.replace(/\s*(USD|EUR|GBP|CAD|AUD)\s*$/i, ""));
  const n = Number(s.replace(/[^\d.]/g, "").replace(/\.(?=.*\.)/g, ""));
  return k ? n * 1000 : n;
};
export function payFrom(text: unknown): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  for (const m of t.matchAll(new RegExp(RANGE, "gi"))) {
    const lo = amount(m[1]);
    const hour = /hour|hr/i.test(m[3] ?? "") || /\/\s*h/i.test(m[0]);
    if (!(lo >= (hour ? 10 : 1000))) continue; // "$5 gift card", "$1M funding" stay out: a wage or salary only
    if (!hour && lo > 2_000_000) continue;
    const near = t.slice(Math.max(0, (m.index ?? 0) - 120), (m.index ?? 0) + m[0].length + 40);
    if (/\b(raised|funding|series [a-e]|valuation|revenue|arr|customers|assets under|aum|budget)\b/i.test(near) && !/\b(salary|pay|compensation|base|wage|range)\b/i.test(near)) continue;
    return m[0].trim().replace(/[.,;]+$/, "");
  }
  return null;
}
