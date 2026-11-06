// D6 (beta 2026-11-06): a Telegram job-search turn hit Supabase Edge "CPU time exceeded" (HTTP 546). Three fixes, one test.
//  1. rankedShortlist (142) applies the ask's company / place / level filters BEFORE the per-posting preCheck + scoreFit:
//     the shortlist is the same list in the same order as scoring everything first (the reference is the unchanged full pass,
//     exported as _d6Full), and a "Chicago" ask scores only the Chicago / remote postings.
//  2. A posting is scored once per turn: searchPostings with a turn's FitCache does not re-score it.
//  3. The turn's CPU line counts per-posting work as CPU (scored_n; pool_map / sj_rank stages).
// Run: deno test -A --no-check tests/architect/search-cpu-20261106.test.ts
import assertNode from "node:assert/strict";
import { CareerJobs, CareerProfile, CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { newFitCache, scoredN, searchPostings } from "../../supabase/functions/_shared/career_search.ts";
import { CareerPool } from "../../supabase/functions/_shared/career_pool.js";
import { turnClock } from "../../supabase/functions/agent-chat/turn_clock.ts";

const R: any = CareerRouter;
const NOW = Date.parse("2026-11-06T12:00:00Z");
const POOL = 600;

const FAMILIES = [
  ["Data Analyst", "SQL, Excel and Tableau dashboards"], ["Software Engineer", "TypeScript and Go services"], ["Registered Nurse", "patient care"],
  ["Marketing Coordinator", "campaign calendars and reporting"], ["Financial Analyst", "forecasting and variance analysis"], ["Product Manager", "roadmaps and launch plans"],
  ["Business Analyst", "requirements and process maps"], ["Data Engineer", "Python, Airflow and dbt pipelines"],
];
const LEVELS = ["", "Junior ", "Senior ", "Entry Level ", "Associate ", "Lead ", "Intern "];
const PLACES = ["Chicago, IL", "New York, NY", "Austin, TX", "Remote", "Seattle, WA", "Denver, CO", "Chicago, IL", "Boston, MA", "Remote - US", "San Francisco, CA"];
function rows(n = POOL) {
  return Array.from({ length: n }, (_, i) => {
    const [fam, what] = FAMILIES[i % FAMILIES.length];
    const title = `${LEVELS[(i * 3) % LEVELS.length]}${fam}`, loc = PLACES[(i * 7) % PLACES.length];
    const html = `<p>Employer ${i} is hiring a ${title} to own ${what}. Partner with peers, write clear updates.</p><ul><li>${i % 9 === 0 ? "6+ years of experience" : "1 year of experience"}</li><li>SQL and Excel</li></ul><p>Pay $${55 + (i % 40)},000 - $${80 + (i % 50)},000.${i % 50 === 0 ? " Apply by 2026-01-05." : ""}${i % 41 === 0 ? " Must hold a CPA licence." : ""}</p>`;
    return { posting_key: `kb-d6-${i}`, source: "greenhouse", board: `b${i % 30}`, company: i % 5 === 0 ? `Acme ${i % 3}` : `Employer ${i}`, title, location: loc, url: `https://boards.example.test/d6/${i}`,
      posted_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`, fetched_on: "2026-10-30", corpus_vintage: "2026-10", text_excerpt: html };
  });
}
const jobs = { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml };
const pool = () => rows().map((r) => CareerPool.mapKbPosting(r, jobs));
const profile = () => {
  const p = CareerProfile.createProfile({});
  p.basics = { name: "Test Person", location: "Chicago, IL" };
  p.facts = [
    { id: "f1", kind: "education", text: "BS Statistics, State University 2025", status: "confirmed", start: "2021-09", end: "2025-05", needs_confirmation: false },
    { id: "f2", kind: "skill", text: "SQL", status: "confirmed", needs_confirmation: false },
    { id: "f3", kind: "skill", text: "Excel", status: "confirmed", needs_confirmation: false },
    { id: "f4", kind: "experience", text: "Data intern at Foo", status: "confirmed", start: "2023-01", end: "2025-01", needs_confirmation: false },
  ];
  return p;
};
const ctxOf = () => ({ postings: pool(), now: NOW, profile: profile() });
const ASKS: Record<string, any> = {
  chicago: { locations: new Set(["chicago"]) },
  chicagoOrRemote: { locations: new Set(["chicago", "remote"]) },
  junior: { bands: new Set(["junior", "new_grad", "intern"]) },
  company: { company: "acme" },
  all: { locations: new Set(["chicago", "remote"]), bands: new Set(["junior", "mid", "new_grad", "intern"]), askFamilies: ["Data/ML"] },
  none: { locations: new Set(["nowhere"]), askFamilies: ["Data/ML"] }, // empty answer: the full pass runs, counters exact
  unfiltered: {},
  employer: { locations: new Set(["chicago"]), employer: "Acme 1" },
};

Deno.test("the shortlist is the same list, in the same order, as scoring everything first", () => {
  for (const [name, o] of Object.entries(ASKS)) {
    const prof = profile();
    const ref = R._d6Full(prof, ctxOf(), o), got = R.rankedShortlist(prof, ctxOf(), o);
    const view = (r: any) => [r.id, r.score, r.bucket, r.reason, r.caveat, r.matched_skills, r.missing_required];
    assertNode.deepEqual(got.ranked.map(view), ref.ranked.map(view), name);
    assertNode.equal(got.dedupedFrom, ref.dedupedFrom, name);
    assertNode.equal(got.dedupedTo, ref.dedupedTo, name);
    if (!ref.ranked.length || o.employer) {
      assertNode.deepEqual(got.excluded, ref.excluded, name);
      assertNode.deepEqual(got.family, ref.family, name);
    } else {
      // a non-empty answer: `excluded` is the reference's, minus the postings the ask's filters removed before scoring
      const refIds = new Set(ref.excluded.map((e: any) => e.id)), gotIds = got.excluded.map((e: any) => e.id);
      assertNode.ok(gotIds.every((id: string) => refIds.has(id)), `${name}: no exclusion the full pass lacks`);
      assertNode.deepEqual(got.excluded, ref.excluded.filter((e: any) => gotIds.includes(e.id)), `${name}: same reasons, same order`);
    }
  }
  assertNode.ok(R.rankedShortlist(profile(), ctxOf(), ASKS.chicago).ranked.length > 20, "the fixture has a real Chicago shortlist");
  assertNode.equal(R.rankedShortlist(profile(), ctxOf(), ASKS.none).ranked.length, 0, "and a real empty one");
});

Deno.test("an ask with a place scores only the postings in that place (and remote when asked)", () => {
  const count = (f: () => unknown) => { const before = R.scoredCount(); f(); return R.scoredCount() - before; };
  const base = count(() => R._d6Full(profile(), ctxOf(), {}));
  const city = (p: any) => String(p.location).toLowerCase().split(",")[0];
  const inChicago = pool().filter((p: any) => city(p) === "chicago").length;
  const chicagoOrRemote = pool().filter((p: any) => city(p) === "chicago" || p.remote === "remote").length;
  assertNode.ok(base > 300, `the unfiltered pass scores most of the pool (${base})`);
  assertNode.ok(count(() => R.rankedShortlist(profile(), ctxOf(), ASKS.chicago)) <= inChicago, "chicago only");
  assertNode.ok(count(() => R.rankedShortlist(profile(), ctxOf(), ASKS.chicagoOrRemote)) <= chicagoOrRemote, "chicago or remote");
});

Deno.test("a posting is scored once per turn, and never from another profile's entries", () => {
  const p = pool().map((x: any) => ({ job_id: x.job_id, company: x.company ?? "", title: x.title, location: x.location, url: x.url, description: x.jd_text, first_seen_at: x.posted_at }));
  const cache = newFitCache(), a = profile();
  const n0 = scoredN();
  const first = searchPostings(p, "data analyst", a, 50, cache);
  const scoredFirst = scoredN() - n0;
  assertNode.ok(scoredFirst > 0 && scoredFirst <= p.length, `each posting at most once (${scoredFirst} of ${p.length})`);
  const n1 = scoredN();
  const again = searchPostings(p, "data analyst", a, 50, cache);
  assertNode.equal(scoredN() - n1, 0, "the second search in the same turn scores nothing");
  assertNode.deepEqual(again, first);
  assertNode.deepEqual(searchPostings(p, "data analyst", a, 50), first, "the cache changes nothing about the answer");
  const b = profile(); b.facts.push({ id: "f9", kind: "skill", text: "Kubernetes", status: "confirmed", needs_confirmation: false });
  const n2 = scoredN();
  searchPostings(p, "data analyst", b, 50, cache);
  assertNode.equal(scoredN() - n2, scoredFirst, "profile B is scored on its own");
  const n3 = scoredN();
  searchPostings(p, "data analyst", a, 50); searchPostings(p, "data analyst", a, 50);
  assertNode.equal(scoredN() - n3, scoredFirst * 2, "no cache, nothing remembered (no module-level state)");
});

Deno.test("row mapping is counted as CPU on the turn clock, apart from the read's wait", async () => {
  const lines: string[] = [];
  const clock = turnClock({ log: (l) => lines.push(l) });
  const loader = CareerPool.createKbPoolLoader({ readRows: async () => { await new Promise((r) => setTimeout(r, 5)); return rows(); }, jobs, cpu: (s: string, fn: () => unknown) => clock.sync(s, fn) });
  const out = await clock.wait("pool_load", () => loader.loadPool());
  assertNode.equal(out.postings.length, POOL);
  clock.flush({ scored_n: 0, cold: true });
  const l = JSON.parse(lines.at(-1)!);
  assertNode.ok(l.stages.pool_map > 0, "pool_map is a CPU stage");
  assertNode.ok(l.sync_ms >= l.stages.pool_map && l.waits.pool_load >= 5);
  assertNode.equal(l.scored_n, 0);
});
