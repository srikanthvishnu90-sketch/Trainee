// The billing invariants, shared by the pure battery (tests/architect/scenarios-billing-research.test.ts) and the
// Postgres run through the handler (tests/architect/flow-scenarios-billing-research.test.ts).
import type { RawInvoice } from "./billing-research-generator.ts";
import { LINK, linksIn } from "./research-check.ts";
import { PLAN_PRICE_CENTS, type Subscription } from "../../../supabase/functions/_shared/career_billing.ts";

export const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const RETENTION = /\b(?:discount|\d+% off|special offer|an offer|offer you|instead\b|pause|are you sure|miss you|sad to see|before you go|stay with|free month|deal\b|reconsider|downgrade|cheaper)/i;
export const REFUND_PROMISE = /refund (?:is|has been|will be|was) (?:issued|processed|sent|on its way|approved)|you(?:'ll| will) (?:get|receive) (?:a |your )?(?:refund|money back)|\bi(?:'ll| will|'ve| have) refund|refunded you/i;

// Every number and date in a reply comes from the row, from Stripe's answer, or is the plan's public price.
export function factsOk(reply: string, rows: (Subscription | null)[], inv: RawInvoice[], allowedLinks: Set<string>): string | null {
  const dates = new Set<string>();
  const nums = new Set<string>([String(PLAN_PRICE_CENTS / 100)]);
  for (const r of rows) {
    if (!r) continue;
    if (r.current_period_end && Number.isFinite(Date.parse(r.current_period_end))) dates.add(fmtDay(Date.parse(r.current_period_end)));
    if (typeof r.price_cents === "number") { nums.add(String(r.price_cents / 100)); nums.add((r.price_cents / 100).toFixed(2)); }
  }
  for (const i of inv) {
    const c = Number(i.created), a = Number(i.amount_paid);
    if (Number.isFinite(c)) { const d = new Date(c * 1000); if (Number.isFinite(d.getTime())) dates.add(fmtDay(c * 1000)); }
    if (Number.isFinite(a)) for (const v of [String(a), (a / 100).toFixed(2), (a / 1000).toFixed(3)]) nums.add(v);
  }
  if (/Invalid Date|NaN|undefined|\bnull\b|\[object/.test(reply)) return "a broken value in the reply";
  for (const u of linksIn(reply)) if (!allowedLinks.has(u)) return `a link Stripe did not return as an https stripe.com URL: ${u}`;
  let rest = reply.replace(LINK, " ");
  for (const m of rest.match(/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/g) ?? []) if (!dates.has(m)) return `a date not in the row or Stripe's answer: ${m}`;
  for (const d of dates) rest = rest.split(d).join(" ");
  const count = /^Your last (\d) payments?:/.exec(rest);
  if (count) rest = rest.replace(count[0], " ");
  for (const m of rest.match(/\d+(?:[.,]\d+)*/g) ?? []) if (!nums.has(m)) return `a number not in the row or Stripe's answer: ${m}`;
  return null;
}
// The exact links Stripe returned that are https on stripe.com, as strings (the only ones a reply may carry).
export function stripeLinks(inv: RawInvoice[]): Set<string> {
  const s = new Set<string>();
  for (const i of inv) {
    const u = i.hosted_invoice_url;
    if (typeof u !== "string" || /[\s\x00-\x1f]/.test(u)) continue;
    try { const x = new URL(u); if (x.protocol === "https:" && !x.username && !x.password && /(?:^|\.)stripe\.com$/.test(x.hostname)) s.add(u); } catch { /* not a URL */ }
  }
  return s;
}

