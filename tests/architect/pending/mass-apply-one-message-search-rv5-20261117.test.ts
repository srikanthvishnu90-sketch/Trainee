// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the review rv-ma5 of ag/ma-03 (probes new03 / new03b), under the
// architect's rulings. Each fails on 1a8b5a4de (the branch before this fix).
//   B1 an exclusion clause is read whole or not at all: every part resolves to a place one of the postings found is in, or an
//      employer one of them is at (any case); a part that is neither queues NOTHING and is asked about, naming the part.
//   B2 a posting that requires US citizenship, with no work authorization confirmed, never reads "your profile says not a US
//      citizen": "your work authorization isn't on file", and under "that I qualify for" it is NOT CHECKED (named, not queued).
//   B3 "that I qualify for" queues only postings whose every stated requirement was checked against a confirmed fact (trunk's
//      usableFact: status confirmed only); the rest are named as not checked; "best fit for your confirmed facts" only when facts
//      about the work itself (a skill, an experience) ranked them.
// No network, no database.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";
import { fitOf, scoringProfileFor } from "../../../supabase/functions/_shared/career_search.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:v${i}:${3000 + i}`, provider: "greenhouse", board: `v${i}`, company, title, location, url: `https://boards.greenhouse.io/v${i}/jobs/${3000 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function world(rows: any[], facts: any[] = []) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, companies: async () => (await wants.list("u1")).map((w) => `${w.company}|${w.location ?? ""}`).sort() };
}
const ROWS = () => [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Pinecrest", "Software Engineer Intern", "Remote (US)"),
  posting("Stripe", "Software Engineer Intern", "Remote (US)"), posting("Ohioco", "Software Engineer Intern", "Columbus, OH"), posting("Texco", "Software Engineer Intern", "Austin, TX"),
  posting("Google", "Software Engineer Intern", "Chicago, IL")];

Deno.test("B1: every wording of 'not Ohio, not Stripe' leaves both out", async () => {
  for (const m of ["apply to every SWE internship except the ones in Ohio and skip Stripe", "apply to every SWE internship except the ones in Ohio, and skip Stripe",
    "apply to every SWE internship except the ones in Ohio but skip Stripe", "apply to every SWE internship except the ones in Ohio and not at Stripe",
    "apply to every SWE internship except Stripe and the ones in Ohio", "apply to every SWE internship skip Stripe except the ones in Ohio",
    "apply to every SWE internship except the ones in Ohio and skip Stripe please", "apply to every SWE internship except the ones in Ohio and also skip Stripe",
    "apply to every SWE internship except the ones in Ohio and don't apply to Stripe", "apply to every SWE internship except the ones in Ohio and nothing at Stripe",
    "apply to every SWE internship except the ones in Ohio. Skip Stripe", "apply to every SWE internship except the ones in Ohio; skip Stripe",
    "apply to every SWE internship except the ones in Ohio & skip Stripe", "apply to every SWE internship except the ones in Ohio and Stripe",
    "apply to every SWE internship except in Ohio or at Stripe", "apply to every SWE internship except the ones in Ohio and those at Stripe",
    "apply to every SWE internship except the ones in Ohio and the Stripe one", "apply to every SWE internship except the ones in Ohio and stripe",
    "apply to every SWE internship except the ones in Ohio and never Stripe", "apply to every SWE internship except the ones in Ohio and avoid Stripe",
    "apply to every SWE internship except the ones in Ohio and ignore Stripe"]) {
    const w = await world(ROWS());
    const r = await w.turn(m);
    eq((await w.companies()).map((c) => c.split("|")[0]), ["Google", "Northwind", "Pinecrest", "Texco"], `${m}: ${r?.reply}`);
  }
});

Deno.test("B1: lower case, lists of employers, 'no', 'anywhere but', 'remote ones'", async () => {
  const cases: [string, string[]][] = [
    ["apply to every SWE internship except stripe", ["Google", "Northwind", "Ohioco", "Pinecrest", "Texco"]],
    ["apply to every SWE internship except Stripe and Google", ["Northwind", "Ohioco", "Pinecrest", "Texco"]],
    ["apply to every SWE internship except Stripe, Google", ["Northwind", "Ohioco", "Pinecrest", "Texco"]],
    ["apply to every SWE internship, no Stripe", ["Google", "Northwind", "Ohioco", "Pinecrest", "Texco"]],
    ["apply to every SWE internship anywhere but Ohio", ["Google", "Northwind", "Pinecrest", "Stripe", "Texco"]],
    ["apply to every SWE internship except the ones in Ohio and remote ones", ["Google", "Northwind", "Texco"]],
    ["apply to every SWE internship not in Ohio and not remote", ["Google", "Northwind", "Texco"]],
    ["apply to every SWE internship except the ones in Ohio or Texas and skip Stripe", ["Google", "Northwind", "Pinecrest"]],
  ];
  for (const [m, want] of cases) {
    const w = await world(ROWS());
    const r = await w.turn(m);
    eq((await w.companies()).map((c) => c.split("|")[0]), want, `${m}: ${r?.reply}`);
  }
});

Deno.test("B1: a part that is no employer or place found queues nothing and is asked about, by name", async () => {
  for (const [m, part] of [["apply to every SWE internship except the ones in Ohio and I hate Stripe so skip them", "I hate Stripe so"], ["apply to every SWE internship except Acme", "Acme"],
    ["apply to the top 2 SWE internships except Stripe", "except stripe"]] as const) {
    const w = await world(ROWS());
    const r = await w.turn(m);
    eq([await w.companies(), r?.status], [[], "none"], `${m}: ${r?.reply}`);
    assert(r!.reply.toLowerCase().includes(`i couldn't tell what "${part.toLowerCase()}" leaves out`) && /employer or a place/.test(r!.reply), r?.reply);
  }
  const ask: any = applyManyAsk("apply to every SWE internship except the ones in Ohio or Texas and skip Stripe");
  eq([ask?.notPlaces, ask?.exclude], [["ohio", "texas"], ["Stripe"]]);
});

const BS = { kind: "education", text: "B.S. Computer Science, UIUC, 2027", title: "B.S. Computer Science" };
const QROWS = () => [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Phdco", "Software Engineer Intern", "Chicago, IL", "Must be enrolled in a PhD program."),
  posting("Citco", "Software Engineer Intern", "Chicago, IL", "Must be a US citizen. Requires active security clearance."),
  posting("Senior", "Software Engineer Intern", "Chicago, IL", "Requires 5+ years of professional experience.")];
const Q = "apply to every SWE internship in Chicago that I qualify for";

Deno.test("B2: no work authorization on file is never 'not a US citizen'; the posting is not checked, not ineligible", async () => {
  const sp = scoringProfileFor({ facts: [BS] });
  const f = fitOf({ job_id: "x", company: "Citco", title: "Software Engineer Intern", location: "Chicago, IL", description: "Must be a US citizen." }, sp);
  assert(!/not a US citizen/.test(JSON.stringify(f)), JSON.stringify(f));
  assert(/your work authorization isn't on file/.test(JSON.stringify(f.gaps)), JSON.stringify(f));
  const w = await world(QROWS(), [BS]);
  const r = await w.turn(Q);
  assert(!/not a US citizen/.test(r!.reply), r?.reply);
  assert(/Not checked, so not queued: .*Citco \(the posting requires US citizenship; your work authorization isn't on file\)/.test(r!.reply), r?.reply);
  assert(!/Left out: [^.]*Citco/.test(r!.reply), `Citco is not called ineligible: ${r?.reply}`);
});

Deno.test("B3: only postings whose every requirement was checked are queued; the rest are named as not checked", async () => {
  const w = await world(QROWS(), [BS]);
  const r = await w.turn(Q);
  eq((await w.companies()).map((c) => c.split("|")[0]), ["Northwind"], r?.reply);
  assert(/Left out: .*Phdco \(the posting requires a PhD; your confirmed facts show a bachelor's\)/.test(r!.reply), r?.reply);
  assert(/Not checked, so not queued: .*Senior \(the posting asks for years of experience; no dated experience is on file\)/.test(r!.reply), r?.reply);
  assert(!/best fit for your confirmed facts/.test(r!.reply), `a school alone does not rank by fit: ${r?.reply}`);
});

Deno.test("B3: a pending, rejected, draft or stated fact is never used; an interest never ranks by fit", async () => {
  for (const facts of [[{ ...BS, status: "pending" }], [{ ...BS, status: "rejected" }], [{ ...BS, status: "draft", needs_confirmation: true }], [{ ...BS, stated: true }]]) {
    const w = await world(QROWS(), facts);
    const r = await w.turn(Q);
    eq(await w.companies(), [], `${JSON.stringify(facts)}: ${r?.reply}`);
    assert(/couldn't check "that I qualify for"/.test(r!.reply), r?.reply);
  }
  const w = await world(QROWS(), [{ kind: "other", text: "Interest: chess" }]);
  const r = await w.turn(Q);
  eq((await w.companies()).map((c) => c.split("|")[0]), ["Northwind"], r?.reply);
  assert(!/best fit for your confirmed facts/.test(r!.reply) && /Not checked, so not queued: .*Phdco/.test(r!.reply), r?.reply);
  const sk = await world(QROWS(), [{ kind: "skill", name: "Python", text: "Skill: Python" }]);
  const s = await sk.turn(Q);
  assert(/best fit for your confirmed facts first/.test(s!.reply), `a confirmed skill ranks: ${s?.reply}`);
});
