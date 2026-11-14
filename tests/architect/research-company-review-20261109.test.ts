// deno-lint-ignore-file no-explicit-any require-await
// R10 WO-H, the architect's read of the research stack against spec F.2 and the owner's readiness review (2026-11-09): the official
// site found when none is named, the posting's own description, a reply that cites must say what the cited page says, continuation
// turns routed to research (with history), the limits on each sentence, the question count or its shortfall, other companies' SEC
// filings dropped, the SEC gap shown, and the "looking for roles" acknowledgement (channel_voice.ts; the fix is #636's). Fake web,
// fake resolver, scripted model: no network, no spend. Every company, page and figure is synthetic.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { companyInterviewAsk, researchAsk, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { enforceCompanyReplySupported, researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import { convertFree, freeProvider, freeReader } from "../../supabase/functions/_shared/research_free_sources.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";
import { freeWeb, html, NOW, PUBLIC } from "../helpers/research_free_web.ts";
import { companyWeb, NOW as CNOW, PUBLIC as CPUBLIC, U, world } from "../helpers/research_company_web.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { testSupportJudge } from "./support-test-judge.ts";
import { pageTruthJudge } from "./support-test-judge-b.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const F2A = "Let's leave the job search for now. What's Stripe like to work for as a data analyst intern? Give me a useful company research answer: what its business does, what an analyst might work on, any concerns to investigate, and 5 good questions to ask in an interview. Use real sources and distinguish facts from your interpretation. Don't apply or contact anyone.";

// The synthetic free web, plus Greenhouse postings with ids, links and descriptions (the board's own JSON).
const JOBS = { jobs: [
  { id: 4401, title: "Data Analyst Intern", location: { name: "Chicago, IL" }, absolute_url: "https://www.zentrafin.example/jobs/4401" },
  { id: 4402, title: "Account Executive", location: { name: "Remote" }, absolute_url: "https://www.zentrafin.example/jobs/4402" },
], meta: { total: 2 } };
const POSTING = { id: 4401, title: "Data Analyst Intern", location: { name: "Chicago, IL" }, company_name: "Zentrafin",
  content: "&lt;p&gt;You will build dashboards for the payments team and define metrics for checkout conversion.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Write SQL every day&lt;/li&gt;&lt;/ul&gt;" };
const web = (log: string[] = []) => {
  const base = freeWeb(log);
  return (async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = String(i instanceof Request ? i.url : i);
    if (u === "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs") return new Response(JSON.stringify(JOBS), { headers: { "content-type": "application/json" } });
    if (u === "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true") return new Response(JSON.stringify(POSTING), { headers: { "content-type": "application/json" } });
    if (u === "https://zentrafin.example/newsroom") return html("Zentrafin newsroom", "March 2, 2026. Zentrafin launched instant payouts for marketplaces.");
    return base(i, init);
  }) as typeof fetch;
};

Deno.test("F2-sources: with no site named, the official site comes from Wikidata P856; its newsroom, blog and the posting's own words are read", async () => {
  const out = await freeProvider({ fetch: web(), now: () => NOW, userAgent: null }).search({ queries: ["What does a data analyst intern do at Zentrafin"], companies: ["Zentrafin"], sites: [] });
  eq(out.sites, ["zentrafin.example"], "Wikidata's official website, www. stripped");
  for (const p of ["https://zentrafin.example/", "https://zentrafin.example/newsroom", "https://zentrafin.example/blog", "https://zentrafin.example/careers", "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true"])
    ok(out.hits.some((h) => h.url === p), `proposes ${p}: ${out.hits.map((h) => h.url).join(" ")}`);
  ok(!out.hits.some((h) => /jobs\/4402/.test(h.url)), "only postings that match the role");
  const text = convertFree("https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true", "application/json", JSON.stringify(POSTING))!.text;
  ok(text.startsWith("Posting on Zentrafin's Greenhouse job board (token zentrafin): Data Analyst Intern, Chicago, IL.") && /The posting says: You will build dashboards for the payments team and define metrics for checkout conversion\./.test(text), text);
  // The brief marks the found site's pages as the company's own, with no site in the turn.
  const read = freeReader({ fetch: web(), resolver: PUBLIC, now: () => NOW });
  const draft = { title: "Zentrafin", business: [{ text: "Zentrafin launched instant payouts for marketplaces.", quote: "Zentrafin launched instant payouts for marketplaces.", url: "https://zentrafin.example/newsroom" }],
    role: [{ text: "The Data Analyst Intern will build dashboards for the payments team.", quote: "You will build dashboards for the payments team", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true" }] };
  const r: any = await researchCompany({ company: "Zentrafin", role: "data analyst intern", question: "what does a data analyst intern do at Zentrafin", format: "inline", now: NOW,
    plan: { queries: ["What does a data analyst intern do at Zentrafin"], companies: ["Zentrafin"], sites: [] }, deps: { search: freeProvider({ fetch: web(), now: () => NOW, userAgent: null }), read, draft: async () => JSON.stringify(draft),
      // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line;
      // per the page truth, the posting's header line ("Posting on Zentrafin's Greenhouse job board …: Data Analyst Intern, Chicago,
      // IL.") does not say what the intern does, so the judge does not let it stand for the question.
      judge: pageTruthJudge("Posting on Zentrafin's Greenhouse job board") } });
  eq(r.status, "ok");
  eq(r.sources.find((s: any) => s.url === "https://zentrafin.example/newsroom")?.by, "company");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): no posting sentence holds the model's
  // capitalised "Data Analyst Intern" beside what the intern does, so the model's words cannot stand; the line is the posting's own
  // words (the draft's quote, in quotation marks), never the header line, and never dropped while the posting states it.
  eq(r.role_asks.length, 1, JSON.stringify(r.role_asks));
  ok(/"The posting says: You will build dashboards for the payments team and define metrics for checkout conversion\."$/.test(r.role_asks[0].text) && !/Greenhouse job board/.test(r.role_asks[0].text), r.role_asks[0].text);
});

Deno.test("F2-file-off: with no research File (publish off or failing), F2A is answered in chat with its sources, without forcing format", async () => {
  for (const publish of [null, async () => null, async () => { throw new Error("store down"); }]) {
    const w = world();
    // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line,
    // and the reply is enforced through the awaited form with that judge (the synchronous form lets no model sentence through).
    const r: any = await researchCompany({ company: "Stripe", role: "data analyst intern", question: F2A, now: CNOW, plan: { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] }, deps: { ...w.deps, publish: publish as any, judge: testSupportJudge } });
    eq([r.status, r.format, r.file_url], ["ok", "inline", null]);
    const out = await enforceCompanyReplySupported("Stripe Billing lets businesses bill customers with subscriptions and invoices [1].", r, { judge: testSupportJudge, ask: F2A });
    ok(/Stripe Billing lets businesses bill customers with subscriptions and invoices \[1\]\./.test(out) && /\n\[1\] [^\n]+: https:\/\//.test(out), out);
  }
});

Deno.test("cite fidelity, limits per sentence, the question count: what a cited page does not say is removed; a paywalled source is named on its sentence", async () => {
  // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line, and
  // the reply is enforced through the awaited form with that judge. On the shared synthetic web the paywalled page's only line sits
  // right beside "Subscribe to continue reading." (an order to the reader), so it is never shown and the page is never a source:
  const w0 = world();
  const r0: any = await researchCompany({ company: "Stripe", role: "data analyst intern", question: F2A, format: "inline", now: CNOW, plan: { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] }, deps: { ...w0.deps, judge: testSupportJudge } });
  ok(r0.status === "ok" && !r0.sources.some((s: any) => s.url === U.paywall) && !/enterprise customers/.test(JSON.stringify(r0)), "a line beside a paywall order is not shown");
  // so the rule this test pins (a paywalled source is named on its sentence) is read on the same page with one more sentence of its
  // own between that line and the paywall order; the page is still paywalled (it still says "Subscribe to continue reading.").
  const paywallWeb = (async (i: RequestInfo | URL, init?: RequestInit) => String(i instanceof Request ? i.url : i) === U.paywall
    ? new Response(`<!doctype html><html><head><title>Biz Daily: Stripe's enterprise push</title></head><body><p>September 30, 2026.</p><p>Stripe signed more enterprise customers this year.</p><p>Enterprise accounts are a growing part of the business.</p><p>Subscribe to continue reading.</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
    : companyWeb(i, init)) as typeof fetch;
  const w = world();
  const r: any = await researchCompany({ company: "Stripe", role: "data analyst intern", question: F2A, format: "inline", now: CNOW, plan: { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] },
    deps: { ...w.deps, read: (u: string[]) => fetchSources(u, { fetch: paywallWeb, resolver: CPUBLIC, now: () => CNOW, max: 12 }), judge: testSupportJudge } });
  const paywalled = r.sources.find((s: any) => s.limit === "paywalled").n;
  const out = await enforceCompanyReplySupported(`Stripe has a demanding culture [${paywalled}]. Stripe signed more enterprise customers this year [${paywalled}].`, r, { judge: testSupportJudge, ask: F2A });
  ok(!/demanding culture/.test(out), "a claim its cited page does not make is removed");
  // (the sentence the model only repeated is the page's own, in quotation marks, with its limit beside it)
  ok(new RegExp(`"Stripe signed more enterprise customers this year\\." \\[${paywalled}\\]\\. \\(source \\[${paywalled}\\] is paywalled\\)`).test(out), out);
  eq(r.wanted, 5);
  ok(r.questions.length < 5 && r.unknowns.some((u: string) => new RegExp(`^Only ${r.questions.length} of the 5 questions asked for could be grounded in these sources`).test(u)), JSON.stringify(r.unknowns));
  ok(/Not established by these sources:[^]*Only \d of the 5 questions/.test(out), "the shortfall is named in the reply");
});

Deno.test("SEC: another company's filing that names a private company is never its source; with no declared contact the gap is in the reply", async () => {
  const other = { hits: { hits: [{ _id: "0009990002-26-000001:other-8k.htm", _source: { ciks: ["0009990002"], display_names: ["Bigco Holdings (BIG) (CIK 0009990002)"], form: "8-K", file_date: "2026-10-01" } }] } };
  const f = (async (i: RequestInfo | URL, init?: RequestInit) => new URL(String(i)).hostname === "efts.sec.gov" ? new Response(JSON.stringify(other), { headers: { "content-type": "application/json" } }) : web()(i, init)) as typeof fetch;
  const out = await freeProvider({ fetch: f, now: () => NOW, userAgent: "Trainee research contact@example.test" }).search({ queries: ["Zentrafin"], companies: ["Zentrafin"], sites: ["zentrafin.example"] });
  ok(!out.hits.some((h) => h.provider === "sec_fts"), "Bigco's 8-K is not a source about Zentrafin");
  // RESEARCH_USER_AGENT unset: SEC is not read, and the reply says so.
  const draft = { business: [{ text: "Zentrafin launched instant payouts for marketplaces.", quote: "Zentrafin launched instant payouts for marketplaces.", url: "https://zentrafin.example/newsroom" }] };
  const r: any = await researchCompany({ company: "Zentrafin", question: "research Zentrafin", format: "inline", now: NOW, plan: { queries: ["Zentrafin"], companies: ["Zentrafin"], sites: [] },
    // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line,
    // and the reply is enforced through the awaited form with that judge.
    deps: { search: freeProvider({ fetch: web(), now: () => NOW, userAgent: null }), read: freeReader({ fetch: web(), resolver: PUBLIC, now: () => NOW }), draft: async () => JSON.stringify(draft), judge: testSupportJudge } });
  ok(/SEC filings were not read: SEC asks every reader to declare a contact/.test(await enforceCompanyReplySupported("Zentrafin launched instant payouts for marketplaces [1].", r, { judge: testSupportJudge, ask: "research Zentrafin" })), JSON.stringify(r.unread));
});

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
Deno.test("cont-routing: interview research asks reach research, also after earlier turns in the same thread", () => {
  const env = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] }; // research served on (D-047)
  const asks = ["I have an interview at Stripe next week, what should I know?", "Tell me about Stripe's business before my interview, do not apply"];
  for (const m of asks) ok(companyInterviewAsk(m) && researchAsk(m), m);
  for (const m of ["I have an interview tomorrow, what should I know?", "I have an interview with my manager about my raise"]) ok(!companyInterviewAsk(m), m);
  // With history: the same thread first searched for roles and asked about the search; the research ask still goes to research.
  const ctx = host.createTurnCtx({ userId: "u-cont", threadId: "t-cont", now: CNOW, snapshot: null, accountPersistence: true });
  for (const before of ["find data analyst internships in Chicago", "which of those is remote?"]) host.runTurn(before, ctx);
  for (const m of asks) {
    const d = stagedDecision({ env, message: m, ctx, host, structured: false });
    ok(d.brain && /research/.test(d.reason), `${m}: ${d.reason}`);
  }
});

Deno.test("F2-ack: company research is not acknowledged as a role search (channel_voice.ts; fixed by #636, fails until both are on trunk)", () => {
  ok(!/looking for roles/.test(ackFor(F2A)), ackFor(F2A));
});
