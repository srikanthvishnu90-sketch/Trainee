// MASS APPLY CONVERSATIONS (2026-11-16; split onto its own branch 2026-11-17, evals/career/mass-apply-conversations MA01, MA04, MA06, MA07, MA11, MA14): an "all" or
// "every" ask that names what to search for is the search and the batch in ONE message, as "find X and apply to all of
// them" and "apply to the top N X in Y" already are. Before: "apply to all the frontend internships in Chicago" with no list
// on the thread queued nothing ("there's no list of postings in this thread"), and "apply to every SWE internship in Chicago
// or remote that I qualify for" was not an apply turn at all. Now: each place named is searched ("Chicago or remote"), the
// employers they said to skip are left out by name, "that I qualify for" leaves out what their confirmed facts rule out (by
// name, with why), and with a list on the thread "all the remote internships" stays that list's filter (D-MS-2, unchanged).
// In-memory postings with the production search's semantics (career_ingest.ts memoryPostingsDb). No network, no database.
import assertNode from "node:assert/strict";
import { allSearchOf, applyManyAsk, applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:t${i}:${2000 + i}`, provider: "greenhouse", board: `t${i}`, company, title, location, url: `https://boards.greenhouse.io/t${i}/jobs/${2000 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function world(rows: any[], o: { shortlist?: any[] | null; facts?: any[] } = {}) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts: o.facts ?? [], shortlist: o.shortlist ?? null, postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}

const ROWS = () => [
  posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Pinecrest", "Software Engineer Intern", "Remote (US)"),
  posting("Redwood", "Software Engineering Intern", "New York, NY"), posting("Acme", "Frontend Engineering Intern", "Chicago, IL"),
  posting("Brite", "Frontend Developer Intern", "Chicago, IL"), posting("Umbra", "Data Analyst", "Remote"), posting("Vesta", "Data Analyst Intern", "Remote"),
  posting("Stripe", "Data Analyst, Payments", "Remote (US)"), posting("Lumen", "Data Analyst", "Chicago, IL"),
];

Deno.test("the ask is read: places each on their own, employers to skip, 'that I qualify for'", () => {
  eq(allSearchOf("apply to every SWE internship in Chicago or remote that I qualify for"), { search: { role: "swe internship", words: ["swe", "internship"], place: "chicago", places: ["chicago", "remote"] }, qualify: true });
  eq(allSearchOf("apply to every data analyst role that's remote, but skip Stripe"), { search: { role: "data analyst", words: ["data", "analyst"], place: "remote" }, exclude: ["Stripe"] });
  eq(allSearchOf("apply to all the data roles in NYC except Ramp and Plaid")?.exclude, ["Ramp", "Plaid"]);
  // A list referent, or no role words, is not a search: the thread's list, as before.
  for (const m of ["apply to every SWE intern role you found", "apply to all of them", "apply to all remote ones", "apply to all of those please"]) eq(allSearchOf(m), null, m);
  eq(applyManyAsk("apply to all of them"), { kind: "all" });
});

Deno.test("no list on the thread: 'all the frontend internships in Chicago' searches and queues them (before: 'no list', nothing queued)", async () => {
  const w = await world(ROWS());
  const r = await w.turn("apply to all the frontend internships in Chicago");
  eq([r?.intent, r?.status], ["career_apply_queue", "queued"], r?.reply);
  eq(await w.companies(), ["Acme", "Brite"]);
});

Deno.test("'in Chicago or remote': both places, nothing elsewhere", async () => {
  const w = await world(ROWS());
  const r = await w.turn("apply to every SWE internship in Chicago or remote");
  eq(r?.status, "queued", r?.reply);
  eq(await w.companies(), ["Northwind", "Pinecrest"]);
  assert(/Chicago or Remote/.test(r!.reply), r!.reply);
});

Deno.test("an employer to skip is left out and said so", async () => {
  const w = await world(ROWS());
  const r = await w.turn("apply to every data analyst role that's remote, but skip Stripe");
  eq(await w.companies(), ["Umbra", "Vesta"]);
  assert(/Left out: .*Stripe \(you said skip Stripe\)/.test(r!.reply), r!.reply);
});

Deno.test("with a list on the thread, 'all the remote internships' is still that list's filter; a named city is searched", async () => {
  const rows = ROWS(), listed = [rows[1], rows[0]].map((p) => ({ id: p.job_id, title: p.title, company: p.company, location: p.location, url: p.url }));
  const a = await world(rows, { shortlist: listed });
  await a.turn("Apply to all the remote internships please");
  eq(await a.companies(), ["Pinecrest"], "the list's remote one");
  const b = await world(rows, { shortlist: listed });
  await b.turn("apply to all the frontend internships in Chicago");
  eq(await b.companies(), ["Acme", "Brite"], "Chicago named: searched, not the list");
});

Deno.test("'that I qualify for': a degree the posting requires and their confirmed facts show they lack is left out, by name, with why", async () => {
  const rows = [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Saltbox", "Software Engineer Intern, Research", "Chicago, IL", "Requirements: must be enrolled in a PhD program in Computer Science.")];
  const facts = [{ id: "F-1", text: "TEST University - B.S. Computer Science, GPA 3.7, graduating May 2028", status: "confirmed", needs_confirmation: false }];
  const w = await world(rows, { facts });
  const r = await w.turn("apply to every SWE internship in Chicago that I qualify for");
  eq(await w.companies(), ["Northwind"]);
  assert(/Left out: .*Saltbox \(the posting requires a PhD; your confirmed facts show a bachelor's\)/.test(r!.reply), r!.reply);
  // Without "that I qualify for", or with no degree confirmed, nothing is ruled out on a guess.
  const all = await world(rows, { facts });
  await all.turn("apply to every SWE internship in Chicago");
  eq(await all.companies(), ["Northwind", "Saltbox"]);
  const none = await world(rows);
  await none.turn("apply to every SWE internship in Chicago that I qualify for");
  eq(await none.companies(), ["Northwind", "Saltbox"]);
});

// A place ruled out is a location exclusion (fix, 2026-11-17): "not Remote" was read as an employer called Remote to skip, and
// "except the ones in Ohio" put "except" into the search words (so nothing matched) and searched Ohio instead of leaving it out.
Deno.test("'not Remote' and 'except the ones in Ohio' are a place ruled out, never an employer to skip or a search word", () => {
  for (const m of ["apply to every data analyst role, not Remote", "apply to every data analyst role but not remote"]) {
    const a = allSearchOf(m);
    eq(a?.search.words, ["data", "analyst"], m);
    eq([a?.exclude, a?.notPlaces, a?.search.place], [undefined, ["remote"], null], m);
  }
  const o = allSearchOf("apply to all the data analyst roles except the ones in Ohio");
  eq([o?.search.words, o?.search.place, o?.exclude, o?.notPlaces], [["data", "analyst"], null, undefined, ["ohio"]]);
  eq(allSearchOf("apply to every SWE internship except the ones in Ohio or Texas")?.notPlaces, ["ohio", "texas"]);
  const both = allSearchOf("apply to every data analyst role except the ones in Ohio, but skip Stripe");
  eq([both?.search.words, both?.exclude, both?.notPlaces], [["data", "analyst"], ["Stripe"], ["ohio"]]);
});

const PLACES = () => [
  posting("Umbra", "Data Analyst", "Remote"), posting("Stripe", "Data Analyst, Payments", "Remote (US)"), posting("Lumen", "Data Analyst", "Chicago, IL"),
  posting("Buckeye", "Data Analyst", "Columbus, OH"), posting("Cuyahoga", "Data Analyst", "Cleveland, Ohio"), posting("Alamo", "Data Analyst", "Austin, TX"),
];

Deno.test("'every data analyst role, not Remote': every match outside remote is queued, the remote ones left out by name (before: 'Remote' read as an employer to skip, so the remote ones were queued)", async () => {
  const w = await world(PLACES());
  const r = await w.turn("apply to every data analyst role, not Remote");
  eq(r?.status, "queued", r?.reply);
  eq(await w.companies(), ["Alamo", "Buckeye", "Cuyahoga", "Lumen"]);
  assert(/Left out: .*Umbra .*\(you said not Remote\)/.test(r!.reply), r!.reply);
  assert(!/you said skip Remote/.test(r!.reply), r!.reply);
});

Deno.test("'all the data analyst roles except the ones in Ohio': Ohio left out, everywhere else queued (before: 'except' was a search word, so nothing matched)", async () => {
  const w = await world(PLACES());
  const r = await w.turn("apply to all the data analyst roles except the ones in Ohio");
  eq(r?.status, "queued", r?.reply);
  eq(await w.companies(), ["Alamo", "Lumen", "Stripe", "Umbra"]);
  assert(/Left out: .*Buckeye.*\(you said not Ohio\)/.test(r!.reply), r!.reply);
});

Deno.test("a place ruled out and an employer to skip in one message: both left out", async () => {
  const w = await world(PLACES());
  await w.turn("apply to every data analyst role except the ones in Ohio, but skip Stripe");
  eq(await w.companies(), ["Alamo", "Lumen", "Umbra"]);
});
