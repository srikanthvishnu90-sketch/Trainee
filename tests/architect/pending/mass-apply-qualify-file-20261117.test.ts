// MASS APPLY (architect ruling on review rv-ma7, RESPONSE-RULES 3.1 / D-096): "apply to every <role> that I qualify for" with more
// than one posting is a File, never a list in chat. The File (the results page, as search results use) shows each posting's stated
// requirements as posted and that they were not checked against the person; it claims no fit. The chat says the count, "I couldn't
// confirm you're eligible for them", and asks which to queue: "all of them" or the File's numbers, which bind exactly the File's
// postings in its numbering (R-01, R-02, ...). One posting stays inline. Nothing is queued by the ask. No network, no database.
import assertNode from "node:assert/strict";
import { applyTurn, type ShortlistEntry } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";
import { qualifyFile } from "../../../supabase/functions/_shared/qualify_file.ts";
import { feedUrlsFor } from "../../../supabase/functions/_shared/file_link.ts";
import { BASE, env, get, NOW, plain, U, world } from "../../helpers/results_world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:qf${i}:${6600 + i}`, provider: "greenhouse", board: `qf${i}`, company, title, location, url: `https://boards.greenhouse.io/qf${i}/jobs/${6600 + i}`,
    description, first_seen_at: new Date(NOW - i * 60000).toISOString(), last_seen_at: new Date(NOW).toISOString(), posted_at: null, closed_at: null, pay: null } as any;
};
const ROWS = () => [posting("Acme", "Software Engineer Intern", "Chicago, IL", "Build tools. Applicants must be U.S. citizens. Active TS/SCI security clearance required."),
  posting("Plain", "Software Engineer Intern", "Chicago, IL"), posting("Gradco", "Software Engineering Intern", "Chicago, IL", "Open to students graduating in 2027.")];
async function ask(rows: any[], message = "apply to every SWE internship in Chicago that I qualify for", shortlist: ShortlistEntry[] | null = null) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  const r = await applyTurn({ message, userId: U, now: NOW, wants, apps: async () => [], facts: [{ kind: "skill", name: "Python", text: "Skill: Python" }], shortlist,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { r, queued: (await wants.list(U)).map((w) => w.company).sort() };
}

Deno.test("more than one posting: a File with each posting's requirements as posted; the chat is a short summary and the question", async () => {
  const { r, queued } = await ask(ROWS());
  eq([queued, r?.status], [[], "none"], r?.reply);
  assert(r?.qualify && r.qualify.rows.length === 3, "the postings for the File");
  const w = world();
  const f = await qualifyFile({ userId: U, now: NOW, what: r!.qualify!.what, skipped: r!.qualify!.skipped, rows: r!.qualify!.rows, store: w.store, links: (u, l) => feedUrlsFor(env, u, l, NOW) });
  assert(f, "the File was made");
  // The chat: count, not confirmed, the File, the question. No posting is listed in chat.
  assert(f!.reply.startsWith("I found 3 open swe internship postings in Chicago."), f!.reply);
  assert(/I couldn't confirm you're eligible for them: I don't decide that for you, so nothing was queued\./.test(f!.reply), f!.reply);
  assert(f!.reply.includes(`${BASE}?t=`) && /Which should I queue\? Say "all of them", or the File's numbers/.test(f!.reply), f!.reply);
  assert(!/Acme|Plain|Gradco|citizens|clearance|best fit|Ranked/i.test(f!.reply), `no list or fit claim in chat: ${f!.reply}`);
  // The File: each card with its requirements as posted, not checked; no fit claim.
  const s = await w.A.tok(U, f!.listId, NOW);
  const page = plain(await (await get(w, s)).text());
  for (const q of ["Applicants must be U.S. citizens.", "Active TS/SCI security clearance required.", "Open to students graduating in 2027."]) assert(page.includes(`“${q}”`), `${q} in the File`);
  assert(page.includes("No citizenship, sponsorship, clearance, degree, graduation, residence, GPA, language or age requirement in its text"), "Plain says none stated");
  assert(page.includes("not checked against you: Trainee doesn't decide eligibility") && page.includes("Whether you meet each posting's requirements was not checked"), page.slice(0, 600));
  assert(!/Closest by fit|Best match|Fit is judged only|sorted by fit|Sorted by fit/.test(page), "the File claims no fit");
  // The thread's list is the File's, in its R-numbers: "1 and 3" queues R-01 and R-03, "all of them" all three.
  eq(f!.listed.length, 3);
  const rid = (company: string) => { const at = page.indexOf(`Software Engineer${company === "Gradco" ? "ing" : ""} Intern ${company}`); return page.slice(Math.max(0, at - 40), at).match(/R-\d\d/g)?.at(-1); };
  eq(f!.listed.map((e) => rid(String(e.company))), ["R-01", "R-02", "R-03"], "the list is in the File's numbering");
  const pick = await ask(ROWS(), "apply to 1 and 3", f!.listed);
  eq(pick.queued, [f!.listed[0].company, f!.listed[2].company].sort(), pick.r?.reply);
  const all = await ask(ROWS(), "apply to all of them", f!.listed);
  eq(all.queued, ["Acme", "Gradco", "Plain"], all.r?.reply);
});

Deno.test("exactly one posting stays inline, with its requirement as posted; no File asked for", async () => {
  const { r, queued } = await ask([posting("Solo", "Software Engineer Intern", "Chicago, IL", "Must be a US citizen.")]);
  eq([queued, r?.status, r?.qualify], [[], "none", undefined], r?.reply);
  assert(r!.reply.includes(`Solo (Chicago, IL): the posting says "Must be a US citizen."`) && /couldn't confirm you're eligible for it/.test(r!.reply), r?.reply);
});
