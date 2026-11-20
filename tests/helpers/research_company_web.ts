// deno-lint-ignore-file no-explicit-any require-await
// A synthetic company web for the R10 WO-H company-research tests (fix 14). The pages restate, on made-up hosts (*.example), the
// shape of the actual sourced Stripe brief in spec C.22: a dated company update with a volume figure and a forecast, Billing and
// Radar product pages, a data analyst intern role page, a reported competitor page, a paywalled page, an outdated page and a page
// that refuses. No real page is fetched; no link here is shown as a real source.
import type { MarketDeps } from "../../supabase/functions/_shared/agent/research/market.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";

export const NOW = Date.parse("2026-11-09T15:00:00Z");
const html = (t: string, b: string) => new Response(`<!doctype html><html><head><title>${t}</title></head><body>${b}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
export const PUBLIC = async () => ["203.0.113.10"];
export const U = {
  update: "https://stripe.example/newsroom/2025-update",
  billing: "https://docs.stripe.example/billing",
  radar: "https://docs.stripe.example/radar",
  role: "https://stripe.example/jobs/data-analyst-intern",
  rivals: "https://payments-weekly.example/stripe-rivals",
  paywall: "https://bizdaily.example/stripe-enterprise",
  old: "https://stripe.example/blog/2023-billing-launch",
  refused: "https://refuses.example/stripe-profile",
};
export const PAGES: Record<string, [string, string]> = {
  [U.update]: ["Stripe's 2025 update", "<p>February 24, 2026.</p><p>Businesses on Stripe generated $1.9 trillion in total volume in 2025, up 34% from 2024.</p><p>The Revenue suite is on track to reach a $1 billion annual run rate in 2026.</p>"],
  // Architect amendment (D-073): Trainee's reading (FULL.frame) now stands only with at least 60% of its words on the pages it names
  // (the item 10 eval's "cited" measure); this page now states what that reading rests on. Every bar of the tests that use it stands.
  [U.billing]: ["Stripe Billing documentation", "<p>Stripe Billing lets businesses bill customers with subscriptions and invoices.</p><p>Billing helps businesses manage the revenue lifecycle, from the first invoice to recovering failed payments.</p><p>Stripe offers payments plus software, not card processing alone.</p>"],
  [U.radar]: ["Stripe Radar documentation", "<p>Radar uses machine learning to help businesses block fraudulent payments.</p><p>Blocking more payments can reduce fraud losses, but it can also decline legitimate customers, so businesses tune their rules to let good payments through.</p>"],
  [U.role]: ["Data Analyst Intern", "<p>As a Data Analyst Intern you will define metrics and build reports and dashboards for business teams.</p><p>You will design experiments and turn the results into business recommendations.</p><p>You have experience with SQL and are pursuing a quantitative Bachelor's or Master's degree.</p><p>Applicants graduate in December 2027 or spring/summer 2028. Offices: New York, Seattle and South San Francisco HQ.</p>"],
  [U.rivals]: ["Payments Weekly: who Stripe competes with", "<p>October 2, 2026.</p><p>Stripe competes with Adyen for large enterprise payment contracts.</p>"],
  [U.paywall]: ["Biz Daily: Stripe's enterprise push", "<p>September 30, 2026.</p><p>Stripe signed more enterprise customers this year.</p><p>Subscribe to continue reading.</p>"],
  [U.old]: ["Stripe blog: a billing launch", "<p>March 3, 2023.</p><p>Stripe launched usage-based billing for software companies.</p>"],
};
export const companyWeb = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === U.refused) return new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } });
  const p = PAGES[url];
  return p ? html(p[0], p[1]) : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
}) as typeof fetch;
export const ALL = [U.update, U.billing, U.radar, U.role, U.rivals, U.paywall, U.old, U.refused];

// What a model might draft from the pages: good lines and the defects E.5 names.
export const FULL = {
  title: "Stripe interview brief",
  frame: { text: "Stripe is easier to understand as payments plus software for the revenue lifecycle than as card processing alone.", urls: [U.billing, U.update] },
  business: [
    { text: "Stripe Billing lets businesses bill customers with subscriptions and invoices.", quote: "Stripe Billing lets businesses bill customers with subscriptions and invoices.", url: U.billing, product: "Billing" },
    { text: "Radar uses machine learning to help businesses block fraudulent payments.", quote: "Radar uses machine learning to help businesses block fraudulent payments.", url: U.radar, product: "Radar" },
    { text: "Stripe signed more enterprise customers this year.", quote: "Stripe signed more enterprise customers this year.", url: U.paywall },
    { text: "Stripe launched usage-based billing for software companies.", quote: "Stripe launched usage-based billing for software companies.", url: U.old },
  ],
  // C.22's per-product headings; "Atlas" has no kept line, so it is dropped.
  products: [{ name: "Billing", angle: "the revenue lifecycle" }, { name: "Radar", angle: "fraudulent payments and good payments" }, { name: "Atlas", angle: "incorporating startups" }],
  developments: [
    { text: "Businesses on Stripe generated $1.9 trillion in total volume in 2025, up 34% from 2024.", quote: "Businesses on Stripe generated $1.9 trillion in total volume in 2025, up 34% from 2024.", url: U.update, date: "2026-02-24" },
    { text: "The Revenue suite is on track to reach a $1 billion annual run rate in 2026.", quote: "The Revenue suite is on track to reach a $1 billion annual run rate in 2026.", url: U.update, date: "February 2026" },
    // defects: volume called revenue; a forecast stated as a result; a date the page does not carry
    { text: "Stripe revenue was $1.9 trillion in 2025.", quote: "Businesses on Stripe generated $1.9 trillion in total volume in 2025, up 34% from 2024.", url: U.update, date: "2026-02-24" },
    { text: "The Revenue suite reached a $1 billion annual run rate in 2026.", quote: "The Revenue suite is on track to reach a $1 billion annual run rate in 2026.", url: U.update, date: "2026-02-24" },
    { text: "Stripe launched usage-based billing for software companies.", quote: "Stripe launched usage-based billing for software companies.", url: U.old, date: "2024-06-01" },
  ],
  competitors: [
    { name: "Adyen", text: "Stripe competes with Adyen for large enterprise payment contracts.", quote: "Stripe competes with Adyen for large enterprise payment contracts.", url: U.rivals },
    { name: "Square", text: "Stripe competes with Adyen for large enterprise payment contracts.", quote: "Stripe competes with Adyen for large enterprise payment contracts.", url: U.rivals }, // defect: the quote never names Square
  ],
  role: [
    { text: "The Data Analyst Intern will define metrics and build reports and dashboards for business teams.", quote: "As a Data Analyst Intern you will define metrics and build reports and dashboards for business teams.", url: U.role },
    { text: "Applicants graduate in December 2027 or spring/summer 2028.", quote: "Applicants graduate in December 2027 or spring/summer 2028.", url: U.role },
  ],
  tensions: [
    { area: "blocking fraudulent payments with Radar", area_quote: "Radar uses machine learning to help businesses block fraudulent payments.", a: "blocking more payments to reduce fraud losses", b: "letting good payments through", urls: [U.radar] },
    // defect: an invented team initiative
    { area: "launching a crypto lending product", area_quote: "Stripe is launching a crypto lending product.", a: "growth", b: "risk", urls: [U.update] },
  ],
  unknowns: ["Which team the role sits on and how it is measured.", "The internship's acceptance rate is 3%."], // the second invents a figure
};
export const QUESTIONS_ONLY = {
  title: "Questions for the hiring manager",
  tensions: [
    { area: "blocking fraudulent payments with Radar", area_quote: "Radar uses machine learning to help businesses block fraudulent payments.", a: "reducing fraud losses", b: "declining legitimate customers", urls: [U.radar] },
    { area: "managing the revenue lifecycle with Billing", area_quote: "Billing helps businesses manage the revenue lifecycle, from the first invoice to recovering failed payments.", a: "recovering failed payments", b: "bill customers with subscriptions and invoices", urls: [U.billing] },
  ],
  business: [{ text: "Stripe Billing lets businesses bill customers with subscriptions and invoices.", quote: "Stripe Billing lets businesses bill customers with subscriptions and invoices.", url: U.billing }], // a focus keeps its area only
};

// The person's confirmed facts (as the tool reads them: confirmed only), one tying to the role page's SQL and dashboards.
export const FACTS = ["project: Built a Python screening workflow that combined company, revenue and contact data across 100+ targets", "skill: SQL and dashboards in Tableau"];
export function world() {
  const published: any[] = [], drafts: string[] = [];
  const deps: MarketDeps = {
    search: { id: "first_party", needsKey: false, search: async () => ({ hits: ALL.map((url) => ({ url, title: "t", provider: "company_site" as const, foundAt: NOW })), notes: [], provider: "first_party", searches: 1 }) },
    read: (u) => fetchSources(u, { fetch: companyWeb, resolver: PUBLIC, now: () => NOW, max: 12 }),
    draft: async (p) => { drafts.push(p.system); return JSON.stringify(/Fill ONLY that key/.test(p.system) ? QUESTIONS_ONLY : FULL); },
    publish: async (d) => { published.push(d); return { url: `https://trainee.example/file?t=v1.co${published.length}` }; },
  };
  return { deps, published, drafts };
}
