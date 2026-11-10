// TELEGRAM LOOP (2026-11-10, item 14): a greeting before a job ask is not the role searched for. Found by
// tests/architect/telegram-loop-30.test.ts: "hello, I need a job" through the real webhook was answered "I checked hello in any
// location ... none was found". Pure code (posting_constraints.ts searchTextOf, career_search_judge.ts askFor).
//   deno test -A --no-check tests/architect/search-greeting-role.test.ts
import assertNode from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { askFor } from "../../supabase/functions/_shared/career_search_judge.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const roleOf = (m: string) => askFor(m, { intent: "" }, null)?.ask?.role ?? null;

Deno.test("a greeting before the ask is never the role", () => {
  for (const m of ["hello, I need a job", "hey there, looking for a job", "good morning, I need an internship", "Hello!", "hi there", "hey trainee, I need work"]) {
    eq(roleOf(m), null, `${m}: no role named, so no search for a greeting`);
    for (const w of ["hello", "hey", "there", "morning", "trainee"]) eq(searchTextOf(m).role.split(" ").includes(w), false, `${m}: "${w}" is not a role word`);
  }
  for (const [m, role] of [["hello I want a data analyst job", "data analyst"], ["hey, find me data analyst jobs in Chicago", "data analyst"], ["Hi there! data analyst internships", "data analyst"],
    ["good day, software engineer roles remote", "software engineer"]] as const) eq(roleOf(m), role, m);
});

Deno.test("a word that only starts like a greeting stays", () => {
  for (const [m, role] of [["yoga instructor jobs", "yoga instructor"], ["history teacher jobs in Austin", "history teacher"], ["youth counselor roles", "youth counselor"]] as const) eq(roleOf(m), role, m);
});
