// OWNER RULE (2026-10-26, "never submit applications without a real resume") at scale: generated apply asks (a named role
// at a company, a company alone, the thread's last list by position, count or "all"), in many phrasings and casings,
// through the chat's apply turn (career_apply_chat.ts applyTurn, the single and batch asks) with no confirmed resume on
// file. Nothing is queued and nothing is asked to prepare; every ask the turn takes says why in plain words (no resume
// on file) and what to do. The same asks with a confirmed resume do queue (the control: the resume is the reason).
// The handler-level proof, on real Postgres, is flow-scenarios-safety.test.ts. No network, no model.
import assertNode from "node:assert/strict";
import { applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { applyAsks, rng } from "./scenarios-fixture.ts";

const NOW = Date.parse("2026-10-29T16:00:00Z");
const POSTINGS = [
  { job_id: "greenhouse:alpha:1", company: "Alpha Works", title: "TEST Analyst", url: "https://boards.greenhouse.io/alpha/jobs/1", closed_at: null },
  { job_id: "greenhouse:bravo:2", company: "Bravo Labs", title: "Data Analyst", url: "https://boards.greenhouse.io/bravo/jobs/2", closed_at: null },
  { job_id: "lever:charlie:3", company: "Charlie Data", title: "Software Engineer Intern", url: "https://jobs.lever.co/charlie/3", closed_at: null },
  { job_id: "greenhouse:delta:4", company: "Delta Freight", title: "Operations Analyst", url: "https://boards.greenhouse.io/delta/jobs/4", closed_at: null },
];
const LIST: ShortlistEntry[] = POSTINGS.map((p) => ({ id: p.job_id, title: p.title, company: p.company, location: "Chicago, IL", url: p.url }));
const ASKS = applyAsks(rng(4040), 2000, POSTINGS);
const PLAIN = /no resume on file|no confirmed resume/i, NEXT = /Paste or attach your resume, confirm it, then ask again\./;

function world(resume: boolean) {
  const wants = memoryWantStore(), kicks: string[][] = [];
  const turn = (message: string) => applyTurn({
    message, userId: "u-scen", now: NOW, wants, apps: async () => [], facts: [], shortlist: LIST,
    postings: { search: async (words: string[]) => POSTINGS.filter((p) => words.some((w) => p.company.toLowerCase().includes(w.toLowerCase()))) },
    posting: async (id: string) => POSTINGS.find((p) => p.job_id === id) ?? null,
    resumeOnFile: async () => resume,
    prepare: async (ids: string[]) => { kicks.push(ids); return "started" as const; },
  });
  return { wants, kicks, turn };
}

Deno.test(`${ASKS.length} generated apply asks with no confirmed resume: nothing queued or prepared; each ask taken says why in plain words`, async () => {
  const fails: string[] = [];
  let taken = 0;
  for (const a of ASKS) {
    const w = world(false);
    const r = await w.turn(a.input);
    if ((await w.wants.list("u-scen")).length || w.kicks.length) fails.push(`queued without a resume: ${JSON.stringify(a.input)} -> ${r?.status}: ${r?.reply}`);
    if (!r) continue;
    taken++;
    if (r.status === "queued") fails.push(`said queued: ${JSON.stringify(a.input)} -> ${r.reply}`);
    // A turn that found the posting(s) says the reason; one that asks which posting, or finds none, queues nothing either.
    if (!["none", "which", "no_list"].includes(r.status) && !(r.status === "no_resume" && PLAIN.test(r.reply) && NEXT.test(r.reply))) fails.push(`no plain reason: ${JSON.stringify(a.input)} -> ${r.status}: ${r.reply}`);
  }
  if (fails.length) throw new Error(`${fails.length} of ${ASKS.length} failed:\n${[...new Set(fails)].slice(0, 30).join("\n")}`);
  assertNode.ok(taken > ASKS.length * 0.6, `most generated asks are the apply turn's (${taken} of ${ASKS.length})`);
});

Deno.test("the same asks with a confirmed resume queue: the resume is the reason nothing was queued", async () => {
  let queued = 0, taken = 0;
  for (const a of ASKS.slice(0, 400)) {
    const w = world(true);
    const r = await w.turn(a.input);
    if (r) taken++;
    if ((await w.wants.list("u-scen")).length) queued++;
  }
  assertNode.ok(queued > taken * 0.8, `${queued} of ${taken} taken asks queued with a resume`);
});
