// F01, F02, F03, F30 (docs/architect/FUNDAMENTAL-ISSUES-2026-11-04.md, wave 1 lane 1a): the search role keeps only role
// words, one stray word no longer empties the search, the number asked for is the number listed, and one reading of the
// message ({role, place, level, count, constraints}) is the search reply's source. Inputs are the beta's own (C01, A1.1,
// A9.1; the C01 text as evals/career/beta-vs-instinct/cases.json reconstructs it). No database, no model.
// Run: deno test -A --no-check tests/architect/search-ask-f01-f03.test.ts
import assertNode from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { askFor, bestWords, searchJudgeTurn, type MatchMode, type SearchSources, type SourcePosting } from "../../supabase/functions/_shared/career_search_judge.ts";
import { matchesWords, wordStem } from "../../supabase/functions/_shared/career_ingest.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-05T12:00:00Z"), DAY = 86400000;

const C01 = "Find three realistic entry-level customer support jobs in Chicago and send me the links. Do not apply, send or contact anyone.";
const A1_1 = "Find ten customer support roles in Chicago";
const A9_1 = "Find three entry-level support jobs in Chicago";

Deno.test("F01: the beta asks search the role, not the count, hedge or instruction words", () => {
  const c = searchTextOf(C01);
  eq([c.role, c.place, c.count], ["customer support", "chicago", 3]);
  eq(c.limits.bands?.includes("new_grad"), true, "entry-level is a level, kept as one");
  const a = searchTextOf(A1_1);
  eq([a.role, a.place, a.count], ["customer support", "chicago", 10]);
  const b = searchTextOf(A9_1);
  eq([b.role, b.place, b.count], ["support", "chicago", 3]);
});

Deno.test("F01: constraint and delivery phrases are not role words", () => {
  for (const [m, role] of [
    ["customer support jobs in Chicago, don't contact anyone", "customer support"],
    ["I want a couple of nursing jobs in Boston with links", "nursing"],
    ["find data analyst jobs and send me the links", "data analyst"],
    ["data analyst roles, do not apply to anything yet", "data analyst"],
    ["show me only current marketing coordinator openings", "marketing coordinator"],
    ["find me 3+ years backend roles", "backend"],
    ["software engineer jobs paying $150k with 5 years experience", "software engineer"],
  ] as const) eq(searchTextOf(m).role, role, m);
  // A message that names no role still names none.
  eq(searchTextOf("Show only current postings").role, "");
});

Deno.test("F03: count words and digits are read where they count postings, never as pay, years or a season", () => {
  for (const [m, n] of [
    ["find 3 data analyst jobs", 3], ["Find ten customer support roles in Chicago", 10], ["find a few remote SWE roles", 3],
    ["find me 5 nursing jobs", 5], ["show me the top 5 product manager roles in NYC", 5], ["find me 10 SWE intern roles", 10],
    ["Find 20 marketing coordinator openings", 20], ["I want a couple of nursing jobs in Boston", 2], ["give me twelve sales roles", 12],
  ] as const) eq(searchTextOf(m).count, n, m);
  for (const m of [
    "software engineer jobs paying $150k with 5 years experience", "data analyst jobs, 2 years experience", "SWE internship Chicago summer 2027",
    "find data analyst jobs", "$50/hr customer support jobs", "find me 3+ years backend roles", "nursing jobs paying 120k or more",
  ]) eq(searchTextOf(m).count, null, m);
});

// Fake sources that honour the match mode the way the production reads do: "all" every word, "any" one of them.
function sources(rows: SourcePosting[], seen: { mode: MatchMode | undefined; words: string[] }[] = []): SearchSources {
  const pick = (words: string[], mode: MatchMode = "all") => rows.filter((p) => mode === "any" ? words.some((w) => matchesWords(p, [w])) : matchesWords(p, words));
  return {
    live: async (words, _l, mode) => { seen.push({ mode, words }); return pick(words, mode); },
    liveHasRows: async () => rows.length > 0,
    snapshot: async () => [],
  };
}
const P = (id: string, title: string, location: string, daysAgo = 1, description = ""): SourcePosting =>
  ({ job_id: id, company: `TEST ${id}`, title, location, url: `https://boards.greenhouse.io/test/jobs/${id}`, description, first_seen_at: new Date(NOW - daysAgo * DAY).toISOString() });
const SUPPORT = Array.from({ length: 14 }, (_, i) => P(`s${i}`, "Customer Support Specialist (Entry Level)", "Chicago, IL", i + 1, "Entry-level customer support."));
const OTHER = [P("o1", "Data Analyst", "Chicago, IL"), P("o2", "Customer Support Specialist", "Austin, TX"), P("o3", "Barista", "Chicago, IL")];

Deno.test("F03: the count asked for is the count listed, and the results page holds that many", async () => {
  for (const [m, n] of [[C01, 3], [A1_1, 10], [A9_1, 3]] as const) {
    const ask = askFor(m, null, null)!.ask;
    eq(ask.count, n, m);
    const r = (await searchJudgeTurn({ message: m, ask, userId: "u", now: NOW, profile: null, sources: sources([...SUPPORT, ...OTHER]), judge: { on: false } }))!;
    eq(r.shortlist.length, n, r.reply);
    eq(r.picked?.length, n);
    assert(r.shortlist.every((e) => /customer support/i.test(e.title) && /chicago/i.test(e.location ?? "")), r.reply);
    eq((r.reply.match(/https:\/\/boards\.greenhouse\.io\//g) ?? []).length, n, r.reply);
  }
  // No number: the default list stands (8), as before.
  const ask = askFor("find customer support jobs in Chicago", null, null)!.ask;
  eq(ask.count, null);
  const r = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources(SUPPORT), judge: { on: false } }))!;
  eq(r.shortlist.length, 8);
});

Deno.test("F03: fewer matches than asked for is said, never padded", async () => {
  const ask = askFor(A1_1, null, null)!.ask;
  const r = (await searchJudgeTurn({ message: A1_1, ask, userId: "u", now: NOW, profile: null, sources: sources(SUPPORT.slice(0, 4)), judge: { on: false } }))!;
  eq(r.shortlist.length, 4);
  assert(/You asked for 10; only 4 came out\./.test(r.reply), r.reply);
});

Deno.test("F02: a stray word no longer empties the search; the postings carrying the most role words are listed, and said so", async () => {
  const seen: { mode: MatchMode | undefined; words: string[] }[] = [];
  const ask = { role: "customer support realistic", place: "chicago", remote: false, count: 3 };
  const r = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources([...SUPPORT, ...OTHER], seen), judge: { on: false } }))!;
  eq(r.status, "ranked");
  eq(r.shortlist.length, 3);
  assert(r.shortlist.every((e) => /customer support/i.test(e.title)), r.reply);
  assert(/No posting matched every word of "customer support realistic", so these match "customer support"\./.test(r.reply), r.reply);
  eq(seen.map((s) => s.mode ?? "all"), ["all", "any"]);
  // Nothing in any title: still "none", nothing invented.
  const none = (await searchJudgeTurn({ message: "m", ask: { role: "astronaut pilot", place: null, remote: false }, userId: "u", now: NOW, profile: null, sources: sources(OTHER), judge: { on: false } }))!;
  eq(none.status, "none");
  assert(/Nothing was invented/.test(none.reply), none.reply);
  // A full match never takes the fallback.
  const seen2: { mode: MatchMode | undefined; words: string[] }[] = [];
  await searchJudgeTurn({ message: "m", ask: { role: "customer support", place: "chicago", remote: false }, userId: "u", now: NOW, profile: null, sources: sources(SUPPORT, seen2), judge: { on: false } });
  eq(seen2.map((s) => s.mode ?? "all"), ["all"]);
});

Deno.test("F02: bestWords picks the largest set of role words a title carries, never a description-only word", () => {
  eq(bestWords([{ title: "Customer Support Specialist" }, { title: "Support Engineer" }], ["customer", "support", "realistic"]), ["customer", "support"]);
  eq(bestWords([{ title: "Barista" }], ["customer", "support"]), null);
  eq(wordStem("analysts"), "analyst");
});

Deno.test("F30: the router's parse and the message's parse do not disagree: one reading is the search's", () => {
  // The router read "customer support" (its own discovery.lastParams for this very text); the message's reading agrees now,
  // and adds the count and level the router does not carry.
  const disc = { lastParams: { ask: C01.slice(0, 200), roleText: "customer support", whereText: "Chicago", remote: false } };
  const a = askFor(C01, { intent: "career_discovery" }, disc)!;
  eq([a.ask.role, a.ask.place, a.ask.count, a.append], ["customer support", "Chicago", 3, false]);
  // A router role that kept a count or a hedge word is read without it.
  const disc2 = { lastParams: { ask: "Show me ten current ones", roleText: "ten current", whereText: null, remote: false } };
  eq(askFor("Show me ten current ones", { intent: "career_discovery" }, disc2), null);
  const disc3 = { lastParams: { ask: A1_1, roleText: "ten customer support", whereText: "Chicago", remote: false } };
  eq(askFor(A1_1, { intent: "career_discovery" }, disc3)!.ask.role, "customer support");
});
