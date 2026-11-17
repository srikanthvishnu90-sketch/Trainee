// D-092 (owner, 2026-11-16, "No cap") under D-NO-LIMITS: one message queues every matching posting; MANY_MAX (50) is removed.
// Eval MA14 (122 remote operations roles): 50 were queued. And a count with a role ("apply to 50 data roles", eval MA02) is the
// searched first-N ask, never the router's batch delegation (career_batch_apply). No network, no database.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
const post = (i: number, title: string, location: string) => ({ job_id: `greenhouse:s${i}:${9000 + i}`, provider: "greenhouse", board: `s${i}`, company: `Scale Co ${i}`, title, location,
  url: `https://boards.greenhouse.io/s${i}/jobs/${9000 + i}`, description: "Excel, SQL.", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
async function world(rows: any[]) {
  const db = memoryPostingsDb(); await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts: [], shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, n: async () => (await wants.list("u1")).length };
}
Deno.test("122 matching postings are all queued from one message (before: 50, 'one message queues at most 50')", async () => {
  const w = await world(Array.from({ length: 122 }, (_, i) => post(i, "Operations Associate", "Remote")));
  const r = await w.turn("apply to the top 200 remote operations roles");
  eq([r?.status, await w.n()], ["queued", 122], r?.reply);
  assert(/I found 122 open, not 200/.test(r!.reply), r!.reply);
  assert(!/at most 50/.test(r!.reply), r!.reply);
});
Deno.test("'apply to 50 data roles' is the searched first-N ask: the 9 data roles that exist, said as fewer than 50, nothing else", async () => {
  eq(applyManyAsk("apply to 50 data roles")?.kind, "first");
  const rows = [...Array.from({ length: 9 }, (_, i) => post(i, "Data Analyst", "Chicago, IL")), ...Array.from({ length: 5 }, (_, i) => post(100 + i, "Frontend Engineering Intern", "Chicago, IL"))];
  const w = await world(rows);
  const r = await w.turn("apply to 50 data roles");
  eq([r?.status, await w.n()], ["queued", 9], r?.reply);
  assert(/I found 9 open, not 50/.test(r!.reply), r!.reply);
});
// Review of ag/ma-02-no-cap (2026-11-17): a count that refers to what was already shown is never read as a search. Before:
// "apply to 2 of the jobs on that list" searched for "list" ("I have no open of the jobs on that list postings"), and "apply
// to 3 more roles like these" searched for "more" and "like".
Deno.test("a count over the shown list is the list's first N; 'more' and 'like these' are never a search", async () => {
  for (const m of ["apply to 2 of the jobs on that list", "apply to 2 of the roles", "apply to 3 roles from that list", "apply to 4 data roles from the list you showed", "apply to 3 jobs you just listed"]) {
    const a = applyManyAsk(m);
    eq(a?.kind, "first", m);
    eq((a as any)?.what, undefined, `${m}: no search words`);
  }
  for (const m of ["apply to 3 more roles like these", "apply to 3 more roles like those", "apply to 5 more data roles"]) eq(applyManyAsk(m), null, m);
  // The searched count with a role is unchanged by this.
  eq((applyManyAsk("apply to 15 software engineering intern roles in Chicago") as any)?.what?.words, ["software", "engineering", "intern"]);
  // Through the turn: no list on hand, "2 of the jobs on that list" asks for the list; it never searches for "list".
  const w = await world([post(1, "List Manager", "Remote"), post(2, "Data Analyst", "Remote")]);
  const r = await w.turn("apply to 2 of the jobs on that list");
  assert(!/of the jobs on that list postings/.test(r?.reply ?? ""), r?.reply);
  eq(await w.n(), 0, r?.reply);
});
