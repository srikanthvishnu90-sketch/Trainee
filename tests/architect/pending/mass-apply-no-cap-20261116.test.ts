// D-092 (owner, 2026-11-16, "No cap"): one message queues every matching posting. Eval MA14 (122 remote operations roles):
// 50 were queued (MANY_MAX). And "apply to 50 data roles" (eval MA02) is the searched first-N ask, never the batch delegation.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-16T18:00:00Z");
const post = (i: number, title: string, location: string) => ({ job_id: `greenhouse:s${i}:${9000 + i}`, provider: "greenhouse", board: `s${i}`, company: `Scale Co ${i}`, title, location,
  url: `https://boards.greenhouse.io/s${i}/jobs/${9000 + i}`, description: "Excel, SQL.", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
async function world(rows: any[]) {
  const db = memoryPostingsDb(); await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts: [], shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, n: async () => (await wants.list("u1")).length };
}
Deno.test("122 matching postings are queued from one message (before: 50)", async () => {
  const w = await world(Array.from({ length: 122 }, (_, i) => post(i, "Operations Associate", "Remote")));
  const r = await w.turn("apply to every remote operations role");
  eq([r?.status, await w.n()], ["queued", 122], r?.reply);
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
