// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the independent review of ag/ma-03 (rv-ma3 probes). Each fails on
// bd9c95e80 (the branch before this fix):
//   1 "…except the ones in Ohio and skip Stripe": the place list swallowed "and skip stripe" (notPlaces ["ohio","skip stripe"]),
//     so Stripe was queued;
//   2 with a list on the thread, "all the remote internships but skip Stripe / except Stripe / that I qualify for" dropped the
//     exclude and the qualify filter and queued every listed posting;
//   3 "that I qualify for" with no confirmed facts queued everything, silently;
//   4 a fact the person only stated in chat ruled postings out and was called "your confirmed facts".
// No network, no database.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:r${i}:${6000 + i}`, provider: "greenhouse", board: `r${i}`, company, title, location, url: `https://boards.greenhouse.io/r${i}/jobs/${6000 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function world(rows: any[], o: { shortlist?: any[] | null; facts?: any[] } = {}) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts: o.facts ?? [], shortlist: o.shortlist ?? null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}
const ROWS = () => [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Pinecrest", "Software Engineer Intern", "Remote (US)"),
  posting("Stripe", "Software Engineer Intern", "Remote (US)"), posting("Ohioco", "Software Engineer Intern", "Columbus, OH")];
const listed = (rows: any[]) => rows.map((p) => ({ id: p.job_id, title: p.title, company: p.company, location: p.location, url: p.url }));

Deno.test("1: a place ruled out and then an employer to skip: the place list stops at the skip clause", async () => {
  const ask: any = applyManyAsk("apply to every SWE internship except the ones in Ohio and skip Stripe");
  eq([ask?.notPlaces, ask?.exclude], [["ohio"], ["Stripe"]]);
  eq((applyManyAsk("apply to every SWE internship except the ones in Ohio or Texas, but skip Stripe") as any)?.notPlaces, ["ohio", "texas"]);
  const w = await world(ROWS());
  const r = await w.turn("apply to every SWE internship except the ones in Ohio and skip Stripe");
  eq(await w.companies(), ["Northwind", "Pinecrest"], r?.reply);
  assert(/you said not Ohio/.test(r!.reply) && /you said skip Stripe/.test(r!.reply), r?.reply);
});

Deno.test("2: on the thread's list, an employer to skip is left out by name; 'that I qualify for' queues nothing and says why", async () => {
  const rows = ROWS();
  for (const m of ["Apply to all the remote internships but skip Stripe", "apply to all the remote internships except Stripe"]) {
    const w = await world(rows, { shortlist: listed([rows[1], rows[2]]) });
    const r = await w.turn(m);
    eq(await w.companies(), ["Pinecrest"], `${m}: ${r?.reply}`);
    assert(/Left out: .*Stripe \(you said skip Stripe\)/.test(r!.reply), r?.reply);
  }
  const w = await world(rows, { shortlist: listed([rows[1], rows[2]]) });
  const r = await w.turn("apply to all the remote internships that I qualify for");
  eq(await w.companies(), [], r?.reply);
  assert(/can't check "that I qualify for"/.test(r!.reply) && /nothing was queued/.test(r!.reply), r?.reply);
  const only = await world(rows, { shortlist: listed([rows[2]]) });
  const none = await only.turn("Apply to all the remote internships but skip Stripe");
  eq([await only.companies(), none?.status], [[], "none"], none?.reply);
});

Deno.test("3: 'that I qualify for' with no confirmed facts: nothing queued, the filter could not be checked", async () => {
  const w = await world([posting("A", "Software Engineering Intern", "Chicago, IL", "Must be enrolled in a PhD program."), posting("B", "Software Engineering Intern", "Chicago, IL")]);
  const r = await w.turn("apply to every SWE internship in Chicago that I qualify for");
  eq([await w.companies(), r?.status], [[], "none"], r?.reply);
  assert(/couldn't check "that I qualify for"/.test(r!.reply), r?.reply);
});

Deno.test("4: a fact only stated in chat never rules a posting out and is never called confirmed", async () => {
  const rows = [posting("A", "Software Engineering Intern", "Chicago, IL", "Must be enrolled in a PhD program."), posting("B", "Software Engineering Intern", "Chicago, IL")];
  const stated = [{ kind: "education", value: "B.S. Computer Science", text: "I'm doing a B.S. in Computer Science", stated: true }];
  const w = await world(rows, { facts: stated });
  const r = await w.turn("apply to every SWE internship in Chicago that I qualify for");
  eq(await w.companies(), [], r?.reply);
  assert(!/your confirmed facts show/.test(r!.reply), r?.reply);
  const all = await world(rows, { facts: stated });
  const a = await all.turn("apply to every SWE internship in Chicago");
  eq(await all.companies(), ["A", "B"], a?.reply);
  assert(!/confirmed facts/.test(a!.reply.split("Queued")[0]), `the ranking is not said to be by confirmed facts: ${a?.reply}`);
});
