// MASS APPLY CONVERSATIONS (2026-11-16, eval MA13; CLAUDE.md: never submit without a real confirmed resume): an ask to apply
// from someone with no confirmed resume on file asks for the resume first. Before, "apply me to 50 data analyst jobs in chicago"
// (a count with a role: no apply grammar of this turn's) went on to the search, which listed postings with "Apply on each".
// With a resume on file (or unknown) the turn stays out, so every other route is unchanged.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const turn = (message: string, resume: boolean | null) => applyTurn({ message, userId: "u1", now: Date.now(), wants: memoryWantStore(), apps: async () => [], facts: [], shortlist: null,
  postings: { search: async () => [] }, resumeOnFile: async () => resume });

Deno.test("no confirmed resume: the apply ask asks for it first, nothing searched or queued", async () => {
  for (const m of ["apply me to 50 data analyst jobs in chicago", "can you apply me to 20 software internships", "please apply to some remote jobs for me"]) {
    const r = await turn(m, false);
    eq([r?.status, r?.queued], ["no_resume", []], m);
    assert(/I need your resume/.test(r!.reply) && /Paste or attach your resume/.test(r!.reply), r!.reply);
  }
});
Deno.test("a resume on file or an unknown answer: never no_resume; a question about applying: not this turn's", async () => {
  // With a resume on file (or unknown), the ask goes on as its own turn (D-092: the searched first-N ask), never "no_resume".
  assert((await turn("apply me to 50 data analyst jobs in chicago", true))?.status !== "no_resume");
  assert((await turn("apply me to 50 data analyst jobs in chicago", null))?.status !== "no_resume");
  eq(await turn("apply to the Data Analyst role at Acme", true), null, "a named role not on file stays the router's");
  eq(await turn("should I apply to 50 data analyst jobs?", false), null);
  eq(await turn("how do I apply to jobs", false), null);
});
