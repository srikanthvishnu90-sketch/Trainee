// The 10/10 rubric's gap #2 (2026-11-16; evals/mirror/instinct-wa-batch1/), at $0. Scope (owner, 2026-11-16): mass applying first,
// so the task contracts cover the job-search, apply, batch and application-status tasks only.
//   CU-3  each scoped benchmark turn reads as its kind of task, the rest as none; every contract carries its own items and the
//         common depth items, and names no person, school or employer
//   CU-4  a posting's deadline comes with the days left counted by code from the turn's clock (C18, C11)
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/coach-depth-units-20261116.test.ts
import assertNode from "node:assert/strict";
import { CORE, contractNote, contractOf, TASK_CONTRACTS, type TaskIntent } from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DIR = new URL("../../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const TURNS: { id: string; prompt: string }[] = Deno.readTextFileSync(new URL("prompts.jsonl", DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const NOW = Date.parse("2026-11-16T15:00:00Z");

Deno.test("CU-3 the scoped turns read as their kind of task; each contract has its items, the common depth items, and no names", () => {
  const want: Record<string, TaskIntent | null> = { C1: "plan", C3: "search", C6: "applications", C10: "tailor", C11: "apply_requirements", C12: "capacity", C16: "tracker", C18: "posting_check", C20: "tailor" };
  const history: { role: string; content: string }[] = [];
  for (const t of TURNS) {
    eq(contractOf(t.prompt, history), want[t.id] ?? null, `${t.id}: ${t.prompt}`);
    history.push({ role: "user", content: t.prompt }, { role: "assistant", content: t.id === "C5" ? "Question 1: given a list of integers, return the first that appears once. Your approach and its complexity first?" : t.id === "C21" ? "Tell me about a time you failed." : "Done." });
  }
  // General, not the benchmark: other people's words read the same way.
  eq(["find me data analyst jobs in denver", "is the stripe new grad role still open?", "can you apply to 100 jobs today", "have i applied anywhere yet", "what do i need to apply to the acme role?"].map((m) => contractOf(m)), ["search", "posting_check", "capacity", "applications", "apply_requirements"]);
  eq(["write a thank you note to dana", "say i'm a career changer, what should i do?", "quiz me on sql", "hi"].map((m) => contractOf(m)), [null, null, null, null]);
  for (const [k, c] of Object.entries(TASK_CONTRACTS)) {
    const note = contractNote(k as TaskIntent);
    for (const item of c.items) ok(note.includes(item), `${k}: ${item}`);
    for (const core of c.core) ok(note.includes(CORE[core]), `${k}: ${core}`);
    ok(c.core.includes("next") && (c.core.includes("size") || k === "posting_check"), `${k}: a next step and a size`);
    ok(!/\b(?:Sam|Rivera|Lakeshore|PayPal|Pixelforge|Waypoint|Rallyup|Harbor|Crestline|Mindgrove|Elmstead|Ondo|Citadel|Google|NVIDIA|Chicago)\b/.test(note), `${k} names the benchmark`);
  }
  ok(/days left to a deadline counted from today's date/.test(CORE.number) && /waiting for their yes/.test(CORE.verify) && /one concrete offer or question/.test(CORE.next) && /600 characters/.test(CORE.size));
});

Deno.test("CU-4 a posting's deadline comes with the days left, counted by code from the turn's clock", async () => {
  const tools = careerTools({ postings: async () => [], postingRecheck: async (url: string) => ({ state: "open", board: "Workday", url, checked_at: new Date(NOW).toISOString(), deadline: "2026-12-06", deadline_text: null }) } as any);
  const check = tools.find((t) => t.name === "check_posting_open")!;
  const r: any = await check.run({ url: "https://example.wd5.myworkdayjobs.com/jobs/job/1" }, { userId: "u", threadId: "t", now: NOW, state: {} } as any);
  ok(/2026-12-06/.test(r.note) && /20 days from today \(2026-11-16\)/.test(r.note), r.note);
  const late: any = await check.run({ url: "https://example.wd5.myworkdayjobs.com/jobs/job/1" }, { userId: "u", threadId: "t", now: Date.parse("2026-12-08T12:00:00Z"), state: {} } as any);
  ok(/passed 2 days ago/.test(late.note), late.note);
});
