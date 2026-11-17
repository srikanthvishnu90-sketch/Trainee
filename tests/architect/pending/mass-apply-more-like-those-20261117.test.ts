// MASS APPLY CONVERSATIONS (2026-11-16, eval MA11; split onto its own branch 2026-11-17): "apply to 20 more like those" is the
// search the thread's last searched batch came from (kept on its reply as meta.apply_search), again, without what is already
// on their apply list; when the exact search is used up it widens one step to the role family's related titles, said by
// name. The saved search carries the employers they said to skip and "that I qualify for", so a later "more" never re-adds a
// skipped employer or a posting their confirmed facts rule out. Before: the brain answered "I can't apply from this chat".
// In-memory postings with the production search's semantics (career_ingest.ts memoryPostingsDb). No network, no database.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn, type ManyWhat } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:m${i}:${3000 + i}`, provider: "greenhouse", board: `m${i}`, company, title, location, url: `https://boards.greenhouse.io/m${i}/jobs/${3000 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
// The thread: each reply's `search` is what the handler keeps as meta.apply_search; lastSearch reads the latest one back.
async function thread(rows: any[]) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  let kept: ManyWhat | null = null;
  const turn = async (message: string) => {
    const r = await applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts: [], shortlist: null, postings: { search: (w: string[], l: number) => db.search(w, l) },
      resumeOnFile: async () => true, lastSearch: async () => kept });
    if (r?.search) kept = r.search;
    return r;
  };
  return { turn, keep: (s: ManyWhat) => { kept = s; }, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}

Deno.test("the ask: '20 more like those', 'more of those please'", () => {
  eq(applyManyAsk("apply to 20 more like those"), { kind: "more", n: 20 });
  eq(applyManyAsk("apply to more of those please"), { kind: "more", n: null });
  eq(applyManyAsk("apply to five more"), { kind: "more", n: 5 });
});

Deno.test("'apply to 20 more like those': the last batch's search again, without what is already on the apply list; fewer said plainly", async () => {
  const w = await thread([posting("Acme", "Frontend Engineering Intern", "Chicago, IL"), posting("Brite", "Frontend Developer Intern", "Chicago, IL"), posting("Cobalt", "Frontend Intern", "Chicago, IL")]);
  // No search kept on the thread: nothing queued, and what to say instead.
  const none = await w.turn("apply to 20 more like those");
  eq([none?.status, (await w.companies()).length], ["none", 0], none?.reply);
  const first = await w.turn("apply to the top 2 frontend internships in Chicago");
  assert(first?.search, "the searched batch returns its search for the reply's meta");
  eq((await w.companies()).length, 2);
  const more = await w.turn("apply to 20 more like those");
  eq((await w.companies()).length, 3, more?.reply);
  assert(/2 already on your apply list left out/.test(more!.reply) && /not 20/.test(more!.reply), more!.reply);
  const again = await w.turn("apply to 20 more like those");
  eq(again?.status, "none", again?.reply);
  assert(/already on your apply list, so there are no more/.test(again!.reply), again!.reply);
});

Deno.test("'20 more like those' with the exact search used up: widened to the role family's related titles, said by name", async () => {
  const w = await thread([posting("Acme", "Frontend Engineering Intern", "Chicago, IL"), posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Juno", "Product Design Intern", "Chicago, IL")]);
  await w.turn("find frontend internships in Chicago and apply to all of them");
  const more = await w.turn("apply to 20 more like those");
  eq(await w.companies(), ["Acme", "Northwind"], more?.reply);
  assert(/widened to related titles: software internships in Chicago/.test(more!.reply), more!.reply);
});

// The search a "…remote, but skip Stripe" batch keeps on its reply (meta.apply_search): its exclude list rides with it.
const SKIP_STRIPE: ManyWhat = { role: "data analyst", words: ["data", "analyst"], place: "remote", exclude: ["Stripe"] };
const DATA = () => [posting("Umbra", "Data Analyst", "Remote"), posting("Stripe", "Data Analyst, Payments", "Remote (US)"), posting("Vesta", "Data Analyst", "Remote"),
  posting("Stripe", "Senior Data Analyst", "Remote"), posting("Orbit", "Data Analyst", "Remote (US)"), posting("Lumen", "Data Analyst", "Chicago, IL")];

Deno.test("after '…remote, but skip Stripe', '20 more like those' never queues Stripe; the next 'more' still carries the skip", async () => {
  const w = await thread(DATA());
  w.keep(SKIP_STRIPE);
  const more = await w.turn("apply to 20 more like those");
  eq(await w.companies(), ["Orbit", "Umbra", "Vesta"], more?.reply);
  eq(more?.search?.exclude, ["Stripe"], "the reply's saved search keeps the exclude list for the next 'more'");
  const again = await w.turn("apply to more like those");
  eq(again?.status, "none", again?.reply);
  assert(!(await w.companies()).includes("Stripe"));
});

Deno.test("widening never re-adds a skipped employer either", async () => {
  const w = await thread([posting("Acme", "Frontend Engineering Intern", "Chicago, IL"), posting("Stripe", "Software Engineering Intern", "Chicago, IL"), posting("Northwind", "Software Engineer Intern", "Chicago, IL")]);
  await w.turn("find frontend internships in Chicago and apply to all of them");
  w.keep({ role: "frontend internships", words: ["frontend", "internships"], place: "chicago", exclude: ["Stripe"] });
  const more = await w.turn("apply to 20 more like those");
  eq(await w.companies(), ["Acme", "Northwind"], more?.reply);
});

Deno.test("a saved 'that I qualify for' search leaves out what their confirmed facts rule out on every 'more', and keeps qualify for the next", async () => {
  const db = memoryPostingsDb();
  await db.putMany([posting("Fit Co", "Data Analyst", "Chicago, IL", "Data analyst. SQL, Excel, Tableau dashboards. Entry level."),
    posting("Nurse Co", "Registered Nurse", "Chicago, IL", "RN license required. BLS certification.")]);
  const wants = memoryWantStore();
  const facts = [{ kind: "skill", text: "Skill: SQL", name: "SQL", status: "confirmed", confirmed: true }, { kind: "skill", text: "Skill: Excel", name: "Excel", status: "confirmed", confirmed: true },
    { kind: "education", text: "B.S. Statistics at TEST University, 2024", status: "confirmed", confirmed: true }];
  const saved: ManyWhat = { role: "", words: [], place: "chicago", qualify: true };
  const turn = (s: ManyWhat) => applyTurn({ message: "apply to 20 more like those", userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true, lastSearch: async () => s });
  const r = await turn(saved);
  eq((await wants.list("u1")).map((x) => x.company), ["Fit Co"], r?.reply);
  eq(r?.search?.qualify, true, "the qualify filter rides on the saved search");
  // Without qualify on the saved search, nothing is ruled out on a guess: the nurse role is queued as any match is.
  const loose = memoryWantStore();
  await applyTurn({ message: "apply to 20 more like those", userId: "u1", now: T, wants: loose, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true, lastSearch: async () => ({ ...saved, qualify: undefined }) });
  eq((await loose.list("u1")).map((x) => x.company).sort(), ["Fit Co", "Nurse Co"]);
});
