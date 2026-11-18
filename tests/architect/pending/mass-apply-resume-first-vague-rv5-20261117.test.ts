// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the review rv-ma5 of ag/ma-05 (probe new05), under the architect's
// ruling: the vague-ask proposal reads only structured evidence (confirmed skill facts matched as whole skill names, titles of
// confirmed experience entries), never free-text words from descriptions or interests. Fails on 45ab0865b.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
const post = (i: number, company: string, title: string) => ({ job_id: `greenhouse:w${i}:${9500 + i}`, provider: "greenhouse", board: `w${i}`, company, title, location: "Chicago, IL",
  url: `https://boards.greenhouse.io/w${i}/jobs/${9500 + i}`, description: "x", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
async function vague(facts: any[]) {
  const db = memoryPostingsDb();
  await db.putMany([post(1, "Northwind", "Software Engineering Intern"), post(2, "Lumen", "Data Analyst"), post(3, "Gold", "Financial Analyst Intern")]);
  const wants = memoryWantStore();
  const r = await applyTurn({ message: "can you just apply to some jobs for me", userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { r, queued: (await wants.list("u1")).length };
}
const C = (text: string) => ({ kind: "experience", text, status: "confirmed", needs_confirmation: false });

Deno.test("free text in a confirmed entry is no evidence: no proposal claims a kind of role", async () => {
  for (const t of ["Server at Olive Garden; excel at customer service under pressure", "Volunteer: data entry for a food bank", "Barista; learned to react calmly to rushes",
    "Lifeguard. Interest: investment in community gardens", "Interest: Java coffee roasting", "Retail associate at Target", "Pet sitter: python and gecko care"]) {
    const { r, queued } = await vague([C(t)]);
    eq(queued, 0);
    assert(!/Your confirmed facts mention/.test(r?.reply ?? ""), `${t}: ${r?.reply}`);
  }
  const { r } = await vague([{ kind: "skill", name: "python and gecko care", status: "confirmed" }, { kind: "interest", name: "Java", text: "Java coffee" }]);
  assert(!/Your confirmed facts mention/.test(r?.reply ?? ""), `a skill phrase matches whole; an interest is not a skill: ${r?.reply}`);
});

Deno.test("structured evidence: a confirmed skill named whole, or a confirmed experience title", async () => {
  const xl = await vague([{ kind: "skill", name: "Microsoft Excel", text: "Skill: Microsoft Excel", status: "confirmed" }]);
  assert(/finance roles: 1 open posting/.test(xl.r!.reply) && /data roles: 1 open posting/.test(xl.r!.reply), xl.r?.reply);
  const da = await vague([{ kind: "experience", title: "Data Analyst Intern", text: "Data Analyst Intern, Acme", status: "confirmed" }]);
  assert(/data roles: 1 open posting/.test(da.r!.reply) && !/software engineering roles/.test(da.r!.reply), da.r?.reply);
  const pending = await vague([{ kind: "skill", name: "Python", status: "pending" }]);
  assert(!/Your confirmed facts mention/.test(pending.r?.reply ?? ""), `a pending skill is not confirmed: ${pending.r?.reply}`);
  eq([xl.queued, da.queued], [0, 0]);
});
