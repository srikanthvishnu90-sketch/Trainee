// Search parameters (2026-10-28): what a person states in a job search must constrain what comes back. The eval
// (evals/career/search-params.ts) runs the production chat path over fixture postings; this pins its floor and the
// parameter reader and the rule that a posting stating otherwise is left out. No model, no network.
// Run: deno test -A --no-check tests/architect/search-params.test.ts
import assertNode from "node:assert/strict";
import { outsideLimits, searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { runAll } from "../../evals/career/search-params.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("search params: the eval passes every case with no posting that violates a stated parameter", async () => {
  const o = await runAll();
  const failed = o.results.filter((r) => !r.pass).map((r) => `${r.id} ${r.say}: ${r.why}`);
  eq(failed, []);
  eq(o.violating, 0);
  assertNode.ok(Array.isArray(o.unstatedKept), "the unstated-level leak is reported, not hidden");
});

Deno.test("search params: the message's own words give role, place, level, pay, season, employer and sponsorship", () => {
  const a = searchTextOf("SWE internship Chicago summer 2027");
  eq([a.role, a.place, a.limits.bands, a.limits.term], ["software engineer", "chicago", ["intern"], "summer 2027"]);
  const b = searchTextOf("remote data analyst, $30+/hr");
  eq([b.role, b.remote, b.limits.pay], ["data analyst", true, { amount: 30, period: "hour" }]);
  const c = searchTextOf("find me software engineer roles at Stripe in Toronto");
  eq([c.role, c.place, c.limits.company], ["software engineer", "toronto", "Stripe"]);
  eq(searchTextOf("new grad backend, no sponsorship needed").limits.needsSponsor, false, "no sponsorship needed is not a need");
  eq(searchTextOf("backend jobs, I will need visa sponsorship").limits.needsSponsor, true);
  eq(searchTextOf("data analyst jobs paying 120k or more").limits.pay, { amount: 120000, period: "year" });
  eq(searchTextOf("jobs over $40").limits.pay, null, "a bare amount with no period is not guessed");
  eq(searchTextOf("data analyst jobs").limits.bands, null, "no level stated, none applied");
});

Deno.test("search params: a posting is left out only when its own text states the opposite", () => {
  const p = (title: string, description: string, extra: object = {}) => ({ title, company: "TEST Co", location: "Chicago, IL", description, ...extra });
  const L = (q: string) => searchTextOf(q).limits;
  eq(outsideLimits(p("Software Engineer Intern", "Summer 2026. $40/hour."), L("internship summer 2027")), "term");
  eq(outsideLimits(p("Software Engineer Intern", "Summer 2027. $40/hour."), L("internship summer 2027")), null);
  eq(outsideLimits(p("Software Engineer Intern", "Join us."), L("internship summer 2027")), null, "no season stated: kept");
  eq(outsideLimits(p("Senior Software Engineer", "x"), L("internship")), "level");
  eq(outsideLimits(p("Data Analyst", "Pay: $22/hour."), L("data analyst $30+/hr")), "pay");
  eq(outsideLimits(p("Data Analyst", "Pay: $95,000 - $115,000 per year."), L("data analyst at least $100k")), null, "the range reaches the floor");
  eq(outsideLimits(p("Data Analyst", "Pay: $22/hour."), L("data analyst at least $60k")), "pay", "hourly against a yearly floor");
  eq(outsideLimits(p("Data Analyst", "Great team."), L("data analyst $30+/hr")), null, "pay not stated: kept");
  eq(outsideLimits(p("Engineer", "We are unable to sponsor work visas."), L("engineer, I need visa sponsorship")), "sponsor");
  eq(outsideLimits(p("Engineer", "We are unable to sponsor work visas."), L("engineer, no sponsorship needed")), null);
  eq(outsideLimits(p("Engineer", "x", { company: "Acme" }), L("engineer at Stripe")), "company");
});

Deno.test("search params: a posting that states no level is kept under a level search", () => {
  const p = (title: string, description = "Great team.") => ({ title, company: "TEST Co", location: "Chicago, IL", description });
  const L = (q: string) => searchTextOf(q).limits;
  for (const q of ["new grad software engineer", "senior software engineer"]) {
    eq(outsideLimits(p("Software Engineer"), L(q)), null, `no level word kept: ${q}`);
    eq(outsideLimits(p("Data Analyst"), L(q)), null, `no level word kept: ${q}`);
  }
  eq(outsideLimits(p("Software Engineer", "Requires 3+ years of experience building services."), L("new grad software engineer")), "level", "3+ years states mid");
  eq(outsideLimits(p("Software Engineer", "We want 2+ years in backend."), L("new grad software engineer")), "level", "2+ years states mid");
  eq(outsideLimits(p("Software Engineer (Mid-level)"), L("new grad software engineer")), "level", "mid-level states mid");
  eq(outsideLimits(p("Software Engineer", "Requires 3+ years of experience."), L("senior software engineer")), "level", "3+ years is not senior");
  eq(outsideLimits(p("Staff Software Engineer"), L("new grad software engineer")), "level", "an explicit other level still drops");
  eq(outsideLimits(p("Software Engineer Intern"), L("senior software engineer")), "level");
});
