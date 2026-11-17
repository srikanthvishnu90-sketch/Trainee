// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the independent review of ag/ma-04 (rv-ma3 probe zz-probe-ma04). A
// place they ruled out was not part of the saved search (meta.apply_search), so "20 more like those" after "…except the ones in
// Ohio" queued the Ohio posting, and after "…but not remote" the widened search queued a remote one. Fails on 26ee316aa.
// Also: a saved "that I qualify for" with no confirmed fact to check against queues nothing on "more" and says so.
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
  return { job_id: `greenhouse:m${i}:${8000 + i}`, provider: "greenhouse", board: `m${i}`, company, title, location, url: `https://boards.greenhouse.io/m${i}/jobs/${8000 + i}`,
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

Deno.test("'…except the ones in Ohio', then '20 more like those': the saved search carries the place, Ohio is never queued", async () => {
  const w = await thread([posting("Umbra", "Data Analyst", "Chicago, IL"), posting("Ohioco", "Data Analyst", "Columbus, OH"), posting("Vesta", "Data Analyst", "Remote")]);
  const first = await w.turn("apply to all the data analyst roles except the ones in Ohio");
  eq(first?.search?.notPlaces, ["ohio"], first?.reply);
  const more = await w.turn("apply to 20 more like those");
  eq(await w.companies(), ["Umbra", "Vesta"], more?.reply);
  eq(more?.status, "none", more?.reply);
});

Deno.test("'…but not remote', then '20 more like those': the widened search leaves remote out too", async () => {
  const w = await thread([posting("Umbra", "Frontend Engineer Intern", "Chicago, IL"), posting("Rem", "Frontend Engineer Intern", "Remote"), posting("Soft", "Software Engineer Intern", "Remote"),
    posting("Loop", "Software Engineer Intern", "Austin, TX")]);
  const first = await w.turn("apply to every frontend internship but not remote");
  eq([first?.search?.notPlaces, await w.companies()], [["remote"], ["Umbra"]], first?.reply);
  const more = await w.turn("apply to 20 more like those");
  eq(await w.companies(), ["Loop", "Umbra"], `widened to software internships, never a remote one: ${more?.reply}`);
  assert(/widened/.test(more!.reply), more?.reply);
});

Deno.test("a saved 'that I qualify for' with nothing confirmed to check against: 'more' queues nothing and says so", async () => {
  const db = memoryPostingsDb();
  await db.putMany([posting("A", "Data Analyst", "Chicago, IL"), posting("B", "Data Analyst", "Chicago, IL")]);
  const wants = memoryWantStore();
  const saved: ManyWhat = { role: "data analyst", words: ["data", "analyst"], place: "chicago", qualify: true };
  const r = await applyTurn({ message: "apply to 20 more like those", userId: "u1", now: T, wants, apps: async () => [], facts: [], shortlist: null,
    postings: { search: (words: string[], l: number) => db.search(words, l) }, resumeOnFile: async () => true, lastSearch: async () => saved });
  eq([(await wants.list("u1")).length, r?.status], [0, "none"], r?.reply);
  assert(/couldn't check "that I qualify for"/.test(r!.reply), r?.reply);
});
