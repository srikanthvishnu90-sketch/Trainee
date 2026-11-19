// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the review rv-ma7 of ag/ma-04 (probe x04), with ma-03's rv-ma7 fixes
// merged forward: the exclusions a batch resolved hold on every "more" and on its widened search (any case, "Inc", a state
// written out); "that I qualify for" saves no search, so a "more" after it queues nothing; a "more" with an exclusion word
// it cannot read queues nothing. S3 fails on ce4aa5ba3; S1, S2 and S4 held there already and stay as guards.
import assertNode from "node:assert/strict";
import { applyTurn, type ManyWhat } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:z${i}:${7900 + i}`, provider: "greenhouse", board: `z${i}`, company, title, location, url: `https://boards.greenhouse.io/z${i}/jobs/${7900 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function thread(rows: any[], facts: any[] = []) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  let kept: ManyWhat | null = null;
  const turn = async (message: string) => {
    const r = await applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) },
      resumeOnFile: async () => true, lastSearch: async () => kept ? JSON.parse(JSON.stringify(kept)) : null });
    if (r?.search) kept = r.search;
    return r;
  };
  return { db, turn, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}

Deno.test("S1: 'except Stripe and the ones in Ohio' holds on every 'more' (a lower-case 'stripe', 'Cleveland, Ohio')", async () => {
  const w = await thread([posting("Stripe", "Software Engineer Intern", "Chicago, IL"), posting("Google", "Software Engineer Intern", "Chicago, IL"), posting("Ohioco", "Software Engineer Intern", "Columbus, OH")]);
  await w.turn("apply to every SWE internship except Stripe and the ones in Ohio");
  await w.db.putMany([posting("Stripe", "Software Engineer Intern, Payments", "New York, NY"), posting("Acme", "Software Engineer Intern", "Austin, TX"),
    posting("Ohio2", "Software Engineer Intern", "Cleveland, Ohio"), posting("stripe", "SWE Intern", "Remote")]);
  await w.turn("apply to 20 more like those");
  await w.turn("apply to more like those");
  eq(await w.companies(), ["Acme", "Google"]);
});

Deno.test("S2: the widened search keeps them too ('Stripe, Inc.', 'Dayton, OH'); S2b: 'not remote' on the widened search", async () => {
  const w = await thread([posting("Northwind", "Frontend Engineering Intern", "Chicago, IL"), posting("Stripe", "Frontend Engineer Intern", "Chicago, IL"), posting("Ohioco", "Frontend Engineer Intern", "Columbus, OH")]);
  await w.turn("apply to every frontend internship except Stripe and the ones in Ohio");
  await w.db.putMany([posting("Stripe", "Software Engineer Intern", "Chicago, IL"), posting("Stripe, Inc.", "Software Intern", "Denver, CO"), posting("Ohio3", "Software Engineer Intern", "Dayton, OH"),
    posting("Acme", "Software Engineer Intern", "Chicago, IL")]);
  await w.turn("apply to 10 more like those");
  eq(await w.companies(), ["Acme", "Northwind"]);
  const r = await thread([posting("Northwind", "Frontend Engineering Intern", "Chicago, IL"), posting("Rem", "Frontend Engineer Intern", "Remote (US)")]);
  await r.turn("apply to every frontend internship but not remote");
  await r.db.putMany([posting("Rem2", "Software Engineer Intern", "Remote"), posting("RemT", "Software Engineer Intern (Remote)", "United States"), posting("Acme", "Software Engineer Intern", "Chicago, IL")]);
  await r.turn("apply to 10 more like those");
  eq(await r.companies(), ["Acme", "Northwind"]);
});

Deno.test("S3: 'that I qualify for' queues nothing and saves no search: the 'more' after it queues nothing", async () => {
  const w = await thread([posting("Northwind", "Frontend Engineering Intern", "Chicago, IL")], [{ kind: "skill", name: "Python", text: "Skill: Python" }]);
  const first = await w.turn("apply to every frontend internship in Chicago that I qualify for");
  eq([first?.status, first?.search], ["none", undefined], first?.reply);
  await w.db.putMany([posting("Cit", "Frontend Engineer Intern", "Chicago, IL", "Must be a US citizen."), posting("Ok", "Software Engineer Intern", "Chicago, IL")]);
  await w.turn("apply to 10 more like those");
  await w.turn("apply to 10 more like those");
  eq(await w.companies(), []);
});

Deno.test("S4: a 'more' with an exclusion it cannot read is not queued", async () => {
  for (const m of ["apply to 20 more like those but skip Google", "apply to 20 more like those except Stripe", "apply to 5 more like those that I qualify for", "apply to more, not Stripe",
    "apply to 20 more but not Stripe", "apply to 10 more like those, no Stripe", "apply to more like those except remote"]) {
    const w = await thread([posting("Northwind", "Software Engineer Intern", "Chicago, IL"), posting("Stripe", "Software Engineer Intern", "Chicago, IL")]);
    await w.turn("apply to every SWE internship in Chicago except Stripe");
    await w.db.putMany([posting("Stripe", "Software Engineer Intern II", "Chicago, IL"), posting("Google", "Software Engineer Intern", "Chicago, IL")]);
    await w.turn(m);
    eq(await w.companies(), ["Northwind"], m);
  }
});
