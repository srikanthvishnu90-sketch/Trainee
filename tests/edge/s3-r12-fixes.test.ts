// S3 r12 (the subscription sitting for 66118fb7a: dev H010, H034, H035 failed in code). Each test names the transcript it comes from.
// Run: deno test -A --no-check tests/edge/s3-r12-fixes.test.ts
import { evidenceTurn, Ledger, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { prepQuestionsAsked, recordPrepAsked, STAGED_TOOL_POLICY, stagedToolPolicy } from "../../supabase/functions/agent-chat/career_staged.ts";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CareerAccess, CareerContainment, CareerDoorstep, CareerOnboarding, CareerReply, CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.UTC(2026, 9, 19, 15);
// (a judge that says yes to everything it is asked: the pipeline's own code decides what reaches it)
const yes = async (cs: unknown[]) => cs.map(() => "yes" as const);
const oneHit = () => { const l = new Ledger(NOW); l.fromToolResult("search_jobs", { postings: [{ company: "Riverside Health", title: "Registered Nurse, Days", location: "Columbus, OH", url: "https://jobs.example.com/rn-1", state: "open" }] }); return l; };

Deno.test("S3 r12 / H035: an indefinite pronoun opening a sentence names no employer, so later sentences are not dropped as about it", async () => {
  // (pass 1 and 2 of the sitting: "Nothing has been sent or applied to." made "Nothing" the subject of every later sentence, and
  // the reply's question, "Which of those four sounds closest to what you want?", failed with "no cited unit is about Nothing")
  const draft = "Nothing has been sent or applied to. Which of those sounds closest to what you want?";
  const v = await verifyTagged(draft, oneHit(), { ask: "got anything for nurses near columbus who want days only?", judge: yes });
  assert(!v.failures.some((f) => /about Nothing/.test(f.reason)), JSON.stringify(v.failures));
  assert(v.text.includes("Which of those sounds closest to what you want?"), v.text);
  for (const w of ["Everything", "Nobody", "Someone", "None"]) {
    const v2 = await verifyTagged(`${w} has been sent. Which of those sounds closest to what you want?`, oneHit(), { ask: "nurse jobs", judge: yes });
    assert(!v2.failures.some((f) => f.reason.includes(`about ${w}`)) && v2.text.includes("closest to what you want?"), `${w}: ${JSON.stringify(v2)}`);
  }
  // (a real employer opening a sentence is still a subject: its claims still need its own unit)
  const v3 = await verifyTagged("Zorblax Medical pays $95 an hour.", oneHit(), { ask: "nurse jobs" });
  assert(v3.failures.length && !v3.text.includes("Zorblax"), JSON.stringify(v3));
});

Deno.test("S3 r12 / H034: a list item that is dropped takes its number with it (no \"1. 2. 3.\" left standing)", async () => {
  const draft = "Two openings matched. [E1]\n1. Zorblax Medical pays $95 an hour.\n2. Quintel Care pays $99 an hour.\nWhich one should I look at first?";
  const v = await verifyTagged(draft, oneHit(), { ask: "nurse jobs" });
  assert(!/(?:^|\s)[12]\.(?:\s|$)/.test(v.text), `orphan list number left: ${JSON.stringify(v.text)}`);
  assert(v.text.includes("Which one should I look at first?"), v.text);
  // (a kept item keeps its number)
  const kept = await verifyTagged("1. Riverside Health has a Registered Nurse, Days posting that is open. [E1]", oneHit(), { ask: "nurse jobs" });
  if (kept.text.includes("Riverside")) assert(/^1\. Riverside/.test(kept.text), kept.text);
});

Deno.test("S3 r12 / H034, H035: a search that returned no posting read nothing, so it alone does not make an evidence turn", () => {
  const empty = new Ledger(NOW);
  empty.fromToolResult("search_jobs", { postings: [], total: 0, source: "none" });
  eq(empty.units.length, 1, "the count is still a unit (the reply may cite it)");
  eq(evidenceTurn(empty), false, "an empty search alone");
  eq(evidenceTurn(oneHit()), true, "a search that returned a posting");
  const both = new Ledger(NOW);
  both.fromToolResult("search_jobs", { postings: [] });
  both.fromToolResult("research_company", { sources: [{ n: 1, url: "https://example.org/a" }], points: [{ text: "Riverside Health hires new graduate nurses.", cite: [1] }] });
  eq(evidenceTurn(both), true, "an empty search with a page read this turn");
  const two = new Ledger(NOW);
  two.fromToolResult("search_jobs", { postings: [] });
  two.fromToolResult("search_jobs", { postings: [{ company: "Riverside Health", title: "RN", url: "https://jobs.example.com/rn-1", state: "open" }] });
  eq(evidenceTurn(two), true, "an empty search then one that found a posting");
});

Deno.test("S3 r12 / H010: the questions a brain-run mock asked are kept on the thread, only for a prep turn", () => {
  const q1 = "Mock started for a data analyst interview at Northwind Ledger. Answer out loud.\n\nQuestion 1: Tell me about yourself and why this role. Aim for about a minute: your most relevant work.";
  eq(prepQuestionsAsked(q1), ["Tell me about yourself and why this role."]);
  eq(prepQuestionsAsked("Here's your first question: “Tell me about yourself and why you want this role.” Answer out loud."), ["Tell me about yourself and why you want this role."]);
  assert(prepQuestionsAsked("Good answer. How did you measure the result?").includes("How did you measure the result?"));
  const ctx: Record<string, any> = {};
  recordPrepAsked(ctx, "prep_mock_start", q1);
  eq(ctx.trackStore?._careerThread?.prep?.asked, ["Tell me about yourself and why this role."]);
  eq(ctx.trackStore.rows, [], "a new store has the router's shape");
  assert(!("lastQ" in ctx.trackStore._careerThread.prep), "no code session is opened by it");
  const other: Record<string, any> = {};
  recordPrepAsked(other, "career_discovery", "Which city should I search?");
  eq(other, {}, "not a prep turn: nothing is written");
  // (the staged policy carries the router's intent; with no decision it is the plain policy, as before)
  eq(stagedToolPolicy({ brain: true, mode: "staged", intent: "prep_mock_start", reason: "x" } as any).intent, "prep_mock_start");
  eq(stagedToolPolicy(null), STAGED_TOOL_POLICY);
});

Deno.test("S3 r12 / H010: \"next question\" never serves a bank question the brain's mock already asked", () => {
  const host = CareerHost.createCareerHost({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment });
  const serve = (asked: string[] | null) => {
    const ctx: any = host.createTurnCtx({ userId: "u1", threadId: "t1", now: NOW, snapshot: null });
    if (asked) recordPrepAsked(ctx, "prep_mock_start", asked.join(" "));
    const r = host.runTurn("keep going — next question", ctx);
    eq(r.intent, "prep_brief");
    return String(r.reply);
  };
  const first = serve(null);
  assert(/Tell me about yourself/.test(first), first);
  for (const said of ["Question 1: Tell me about yourself and why this role.", "Your first question: “Tell me about yourself and why you want this role.”"]) {
    const next = serve([said]);
    assert(!/Tell me about yourself/.test(next), `repeated after ${said}: ${next}`);
    assert(/Here is your question: /.test(next), next);
  }
  // (a different question with the same frame is not the same question)
  assert(/Tell me about yourself/.test(serve(["Question 1: Tell me about a time you failed."])), "an unrelated question leaves the bank's order");
});
