// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the independent review of ag/ma-05 (rv-ma3 probe zz-probe-ma05).
// The vague-ask proposal says "Your confirmed facts mention these kinds of roles", but it read every fact the turn had,
// including one only stated in chat, and its software signal matched the word "go": "I love to go hiking" (stated) got a
// software-engineering proposal. Now only confirmed facts are read and "go" is no signal ("golang" is). Fails on 920d5b320.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
const post = (i: number, company: string, title: string) => ({ job_id: `greenhouse:q${i}:${9000 + i}`, provider: "greenhouse", board: `q${i}`, company, title, location: "Chicago, IL",
  url: `https://boards.greenhouse.io/q${i}/jobs/${9000 + i}`, description: "Python, SQL.", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
async function vague(facts: any[]) {
  const db = memoryPostingsDb();
  await db.putMany([post(1, "Northwind", "Software Engineering Intern"), post(2, "Tidal", "Software Engineer Intern"), post(3, "Lumen", "Data Analyst")]);
  const wants = memoryWantStore();
  const r = await applyTurn({ message: "can you just apply to some jobs for me", userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { r, queued: (await wants.list("u1")).length };
}

Deno.test("a fact only stated in chat is never read as 'your confirmed facts mention'", async () => {
  for (const facts of [[{ id: "S", text: "stated: I love to go hiking", stated: true }], [{ kind: "skill", value: "Python", text: "I know Python", stated: true }],
    [{ id: "D", text: "Built dashboards in Python", status: "draft", needs_confirmation: true }]]) {
    const { r, queued } = await vague(facts);
    eq(queued, 0);
    assert(!/Your confirmed facts mention/.test(r?.reply ?? ""), `${JSON.stringify(facts)}: ${r?.reply}`);
  }
});

Deno.test("'go' is not a software signal; 'golang' and the rest are", async () => {
  const hike = await vague([{ id: "F-1", text: "I love to go hiking on weekends", status: "confirmed", needs_confirmation: false }]);
  assert(!/software engineering roles/.test(hike.r?.reply ?? ""), hike.r?.reply);
  // rv-ma5: structured evidence only, so the Golang evidence is a confirmed skill fact (was the free text "Wrote a Golang service").
  const go = await vague([{ id: "F-2", kind: "skill", name: "Golang", text: "Skill: Golang", status: "confirmed", needs_confirmation: false }]);
  assert(/software engineering roles: 2 open postings/.test(go.r?.reply ?? ""), go.r?.reply);
  eq(go.queued, 0);
});
