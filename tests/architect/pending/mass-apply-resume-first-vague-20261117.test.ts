// MASS APPLY CONVERSATIONS (2026-11-16, evals MA13 and MA03; split onto its own branch 2026-11-17).
// 1. Resume first (CLAUDE.md: never submit without a real confirmed resume): any ask to apply from someone with no confirmed
//    resume on file asks for the resume before anything is searched or queued. Fix: "can you just apply ..." was not read as
//    an apply command, so the missing resume was never read and the turn went on as if one were on file.
// 2. A vague ask ("can you just apply to some jobs for me") with a confirmed resume gets a concrete proposal: the role
//    families their confirmed facts mention, with how many OPEN postings are on file for each, and ONE question. The family
//    is a keyword match, so the reply never says the postings "fit"; and one posting is "1 open posting", never "1 open".
// In-memory postings with the production search's semantics (career_ingest.ts memoryPostingsDb). No network, no database.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
const post = (i: number, company: string, title: string, location = "Chicago, IL") => ({ job_id: `greenhouse:v${i}:${7000 + i}`, provider: "greenhouse", board: `v${i}`, company, title, location,
  url: `https://boards.greenhouse.io/v${i}/jobs/${7000 + i}`, description: "Python, SQL.", first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null }) as any;
const FACTS = [{ id: "F-1", text: "Built a reporting dashboard in React and Python", status: "confirmed", needs_confirmation: false }];
async function world(resume: boolean | null, facts: any[] = FACTS) {
  const db = memoryPostingsDb();
  await db.putMany([post(1, "Northwind", "Software Engineering Intern"), post(2, "Tidal", "Software Engineer Intern"), post(3, "Lumen", "Data Analyst"), post(4, "Juno", "Product Design Intern"),
    post(5, "Umbra", "Data Analyst", "Remote")]);
  const wants = memoryWantStore();
  let searched = 0;
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => { searched++; return db.search(w, l); } }, resumeOnFile: async () => resume });
  return { turn, queued: async () => (await wants.list("u1")).length, searched: () => searched };
}

Deno.test("no confirmed resume: every apply ask asks for it first, nothing searched or queued ('can you just apply ...' included)", async () => {
  for (const m of ["can you just apply to some jobs for me", "can you just apply me to 20 software internships", "just apply me to some jobs", "apply me to 50 data analyst jobs in chicago",
    "can you apply me to 20 software internships", "please apply to some remote jobs for me", "apply to the top 2 software internships in Chicago"]) {
    const w = await world(false);
    const r = await w.turn(m);
    eq([r?.status, r?.queued, await w.queued()], ["no_resume", [], 0], `${m}: ${r?.reply}`);
    eq(w.searched(), 0, `nothing searched for: ${m}`);
    assert(/I need your resume/.test(r!.reply) && /Paste or attach your resume/.test(r!.reply), r!.reply);
  }
});

Deno.test("a resume on file or an unknown answer: never no_resume; a question about applying: not this turn's", async () => {
  for (const resume of [true, null]) assert((await (await world(resume)).turn("apply me to 50 data analyst jobs in chicago"))?.status !== "no_resume");
  eq(await (await world(null)).turn("can you just apply to some jobs for me"), null, "resume unknown: no proposal claiming a confirmed resume");
  eq(await (await world(false)).turn("should I apply to 50 data analyst jobs?"), null);
  eq(await (await world(false)).turn("how do I apply to jobs"), null);
});

Deno.test("a vague ask with a confirmed resume: open counts by family, never 'fit', '1 open posting' in the singular, one question, nothing queued", async () => {
  const w = await world(true);
  const r = await w.turn("can you just apply to some jobs for me");
  eq([r?.status, await w.queued()], ["none", 0], r?.reply);
  assert(/1\. software engineering roles: 2 open postings on file/.test(r!.reply), r!.reply);
  assert(/2\. data roles: 2 open postings on file/.test(r!.reply), r!.reply);
  assert(!/\bfits?\b|\bmatch(?:es)?\b/i.test(r!.reply), `a keyword family is never called a fit: ${r!.reply}`);
  eq((r!.reply.match(/\?/g) ?? []).length, 1, r!.reply);
  // No confirmed fact names a family: not this turn's (the brain asks).
  eq(await (await world(true, [])).turn("can you just apply to some jobs for me"), null);
});

Deno.test("exactly one open posting is said in the singular", async () => {
  const db = memoryPostingsDb();
  await db.putMany([post(1, "Lumen", "Data Analyst")]);
  const r = await applyTurn({ message: "can you just apply to some jobs for me", userId: "u1", now: T, wants: memoryWantStore(), apps: async () => [], facts: [{ id: "F-3", text: "SQL and Tableau dashboards", status: "confirmed" }],
    shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  assert(/1\. data roles: 1 open posting on file \(for example Data Analyst at Lumen\)/.test(r!.reply), r?.reply);
  assert(!/1 open postings|1 open \(/.test(r!.reply), r!.reply);
});
