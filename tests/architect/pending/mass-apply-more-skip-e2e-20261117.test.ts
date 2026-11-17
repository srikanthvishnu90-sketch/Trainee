// MASS APPLY CONVERSATIONS (2026-11-17): the end-to-end form of ag/ma-04's carry test, added by whichever of ag/ma-03 and
// ag/ma-04 lands second (it needs both: ma-03 reads "…remote, but skip Stripe", ma-04 keeps the search on the reply and runs
// "20 more like those"). Real turns only: the first message's own reply carries its search (meta.apply_search) with the exclude
// list and the qualify filter, and every later "more" never queues Stripe. No network, no database.
import assertNode from "node:assert/strict";
import { applyTurn, type ManyWhat } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "SQL, dashboards.") => {
  const i = ++seq;
  return { job_id: `greenhouse:e${i}:${4000 + i}`, provider: "greenhouse", board: `e${i}`, company, title, location, url: `https://boards.greenhouse.io/e${i}/jobs/${4000 + i}`,
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
    if (r?.search) kept = r.search; // what agent-chat keeps as meta.apply_search
    return r;
  };
  return { turn, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}

Deno.test("'…remote, but skip Stripe', then '20 more like those' (twice): Stripe is never queued", async () => {
  const rows = [posting("Umbra", "Data Analyst", "Remote"), posting("Stripe", "Data Analyst, Payments", "Remote (US)"), posting("Lumen", "Data Analyst", "Chicago, IL"),
    posting("Vesta", "Data Analyst", "Remote"), posting("Stripe", "Senior Data Analyst", "Remote")];
  const w2 = await thread(rows);
  const all = await w2.turn("apply to every data analyst role that's remote, but skip Stripe");
  eq(all?.search?.exclude, ["Stripe"], `the reply's saved search carries the exclude list: ${all?.reply}`);
  assert(!(await w2.companies()).includes("Stripe"), all?.reply);
  const more = await w2.turn("apply to 20 more like those");
  assert(!(await w2.companies()).includes("Stripe"), `${await w2.companies()} / ${more?.reply}`);
  eq(more?.status, "none", `only Stripe is left, and Stripe is skipped: ${more?.reply}`);
  const again = await w2.turn("apply to 20 more like those");
  assert(!(await w2.companies()).includes("Stripe"), again?.reply);
  eq(await w2.companies(), ["Umbra", "Vesta"]);
});

Deno.test("'…that I qualify for', then '20 more like those': the qualify filter rides on the saved search", async () => {
  const facts = [{ id: "F-1", text: "TEST University - B.S. Computer Science, graduating May 2028", status: "confirmed", needs_confirmation: false }];
  const rows = [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Saltbox", "Software Engineer Intern, Research", "Chicago, IL", "Requirements: must be enrolled in a PhD program in Computer Science."),
    posting("Tidal", "Software Engineering Intern", "Chicago, IL")];
  const w = await thread(rows, facts);
  const first = await w.turn("apply to every SWE internship in Chicago that I qualify for");
  eq(first?.search?.qualify, true, first?.reply);
  const more = await w.turn("apply to 20 more like those");
  assert(!(await w.companies()).includes("Saltbox"), `${await w.companies()} / ${more?.reply}`);
});
