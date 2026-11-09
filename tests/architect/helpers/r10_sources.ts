// R10 scripted SOURCE DOUBLE (architect ruling 2026-11-09): fixed, dated, FICTIONAL pages about a Stripe-like company, served
// only inside the suite's fetch double, so a research answer (spec B.5, E.5, F.2) can be checked against what was actually
// fetched: every cited link must be one of these pages and must have been requested on that turn; every figure must appear on a
// fetched page with its date; interpretation must be labelled as such; open questions must be named. Nothing here is a real fact
// about any company: each page says it is a test fixture, and the figures are invented. A world without `sources` refuses these
// hosts like any other (the named-blocker case, r10-post-reset-replay).
export interface SourcePage { url: string; title: string; date: string; kind: "company" | "newsroom" | "role" | "reporting"; body: string }
export const STRIPE_SOURCES: SourcePage[] = [
  { url: "https://stripe.com/about", title: "About Stripe", date: "2026-09-15", kind: "company",
    body: "TEST FIXTURE, fictional. Stripe builds payments and financial software for businesses of every size: online payments, billing and subscriptions, invoicing, fraud screening (Radar) and revenue reporting." },
  { url: "https://stripe.com/newsroom/2026-10-ledger-insights", title: "Stripe introduces Ledger Insights", date: "2026-10-02", kind: "newsroom",
    body: "TEST FIXTURE, fictional. On 2026-10-02 Stripe announced Ledger Insights, a reporting product that reconciles payouts against invoices for finance teams. The company said 4,200 businesses joined the beta." },
  { url: "https://stripe.com/jobs/listing/data-analyst-intern/7001", title: "Data Analyst Intern", date: "2026-10-20", kind: "role",
    body: "TEST FIXTURE, fictional. Data Analyst Intern, Summer 2027. You will build dashboards on payment success and dispute rates, design metrics for experiments, and write recommendations for product teams. SQL and Python required. Open to students graduating between December 2027 and June 2028." },
  { url: "https://news.example.test/2026/10/stripe-disputes", title: "Merchants report longer dispute windows", date: "2026-10-28", kind: "reporting",
    body: "TEST FIXTURE, fictional. A trade outlet reported on 2026-10-28 that some merchants saw longer card dispute windows this autumn; Stripe did not comment. The report is based on interviews with 12 merchants." },
];
export const SOURCE_HOSTS = new Set(STRIPE_SOURCES.map((p) => new URL(p.url).host));
export function sourcePage(u: URL): SourcePage | null {
  const want = `${u.origin}${u.pathname}`.replace(/\/$/, "");
  return STRIPE_SOURCES.find((p) => p.url === want) ?? null;
}
export function sourceResponse(p: SourcePage): Response {
  return new Response(`<html><head><title>${p.title}</title><meta name="date" content="${p.date}"></head><body><h1>${p.title}</h1><time datetime="${p.date}">${p.date}</time><p>${p.body}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
// An index page per host (what a site search or a newsroom listing would return), linking that host's pages.
export function sourceIndex(u: URL): Response | null {
  if (!SOURCE_HOSTS.has(u.host)) return null;
  const pages = STRIPE_SOURCES.filter((p) => new URL(p.url).host === u.host);
  return new Response(`<html><body><h1>${u.host} (test fixture)</h1><ul>${pages.map((p) => `<li><a href="${p.url}">${p.title}</a> <time>${p.date}</time></li>`).join("")}</ul></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
