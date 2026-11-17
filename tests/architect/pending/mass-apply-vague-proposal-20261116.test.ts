// MASS APPLY CONVERSATIONS (2026-11-16, eval MA03): "can you just apply to some jobs for me" names no role. With a confirmed
// resume, the reply proposes a concrete batch from the confirmed facts (the role families they point to, how many open
// postings fit each, two examples) and asks ONE question; nothing is queued. Before, it asked for a role open-ended.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-16T18:00:00Z");
const post = (i: number, company: string, title: string) => ({ job_id: `greenhouse:v${i}:${7000 + i}`, provider: "greenhouse", board: `v${i}`, company, title, location: "Chicago, IL",
  url: `https://boards.greenhouse.io/v${i}/jobs/${7000 + i}`, description: "Python, SQL.", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
Deno.test("a vague ask: a concrete proposal from the confirmed facts, one question, nothing queued", async () => {
  const db = memoryPostingsDb();
  await db.putMany([post(1, "Northwind", "Software Engineering Intern"), post(2, "Tidal", "Software Engineer Intern"), post(3, "Lumen", "Data Analyst"), post(4, "Juno", "Product Design Intern")]);
  const wants = memoryWantStore();
  const facts = [{ id: "F-1", text: "Built a reporting dashboard in React and Python", status: "confirmed", needs_confirmation: false }];
  const r = await applyTurn({ message: "can you just apply to some jobs for me", userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  eq([r?.status, (await wants.list("u1")).length], ["none", 0], r?.reply);
  assert(/1\. software engineering roles: 2 open/.test(r!.reply) && /2\. data roles: 1 open/.test(r!.reply), r!.reply);
  eq((r!.reply.match(/\?/g) ?? []).length, 1, r!.reply);
  // No confirmed facts pointing anywhere: not this turn's (the brain asks).
  eq(await applyTurn({ message: "can you just apply to some jobs for me", userId: "u1", now: T, wants, apps: async () => [], facts: [], shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true }), null);
});
