// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the review rv-ma5 of ag/ma-04 (probe new04), with ma-03's rulings B1
// and B3 merged forward. The saved search (meta.apply_search) keeps the exclusions as they RESOLVED (an employer, a place), and a
// saved "that I qualify for" also leaves out every posting whose requirement no confirmed fact could check, on each "more".
// The first test fails on d40d193e3; the second passed there only through the invented "not a US citizen" exclusion (B2).
import assertNode from "node:assert/strict";
import { applyTurn, type ManyWhat } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:n${i}:${7700 + i}`, provider: "greenhouse", board: `n${i}`, company, title, location, url: `https://boards.greenhouse.io/n${i}/jobs/${7700 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function thread(rows: any[], facts: any[] = []) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  let kept: ManyWhat | null = null;
  const turn = async (message: string) => {
    const r = await applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) },
      resumeOnFile: async () => true, lastSearch: async () => kept });
    if (r?.search) kept = JSON.parse(JSON.stringify(r.search)); // what agent-chat keeps as meta.apply_search
    return r;
  };
  return { db, turn, saved: () => kept, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}
const batch = (tag: string) => [posting("Northwind" + tag, "Software Engineer Intern", "Chicago, IL"), posting("Stripe", "Software Engineer Intern " + tag, "Chicago, IL"),
  posting("Ohioco" + tag, "Software Engineer Intern", "Columbus, OH"), posting("Pine" + tag, "Software Engineer Intern", "Remote (US)")];

Deno.test("'…and don't apply to Stripe', 'not remote, skip Stripe': the resolved exclusions ride on every 'more'", async () => {
  for (const [first, want, saved] of [
    ["apply to every SWE internship except the ones in Ohio and don't apply to Stripe", ["NorthwindA", "NorthwindB", "PineA", "PineB"], { exclude: ["Stripe"], notPlaces: ["ohio"] }],
    ["apply to every SWE internship not in Ohio and not remote, skip Stripe", ["NorthwindA", "NorthwindB"], { exclude: ["Stripe"], notPlaces: ["ohio", "remote"] }],
  ] as const) {
    const w = await thread(batch("A"));
    await w.turn(first);
    eq({ exclude: w.saved()?.exclude, notPlaces: w.saved()?.notPlaces }, saved, first);
    await w.db.putMany(batch("B"));
    const more = await w.turn("apply to 20 more like those");
    eq(await w.companies(), want, `${first} -> more: ${more?.reply}`);
  }
});

// rv-ma7 (1.): replaces the earlier qualify-carry behaviour (architect ruling: a "qualify" ask never queues and never decides eligibility).
Deno.test("after 'that I qualify for' (nothing queued, no search saved), 'more' queues nothing", async () => {
  const w = await thread([posting("A", "Software Engineer Intern", "Chicago, IL")], [{ kind: "education", text: "B.S. Computer Science, 2027" }]);
  await w.turn("apply to every SWE internship in Chicago that I qualify for");
  await w.db.putMany([posting("Cit", "Software Engineer Intern", "Chicago, IL", "Must be a US citizen."), posting("B", "Software Engineer Intern", "Chicago, IL")]);
  const more = await w.turn("apply to 10 more like those");
  eq(await w.companies(), [], more?.reply);
});
