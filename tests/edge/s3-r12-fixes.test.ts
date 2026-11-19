// S3 r12 (the subscription sitting for 66118fb7a: dev H010, H034, H035 failed in code). Each test names the transcript it comes from.
// Run: deno test -A --no-check tests/edge/s3-r12-fixes.test.ts
import { evidenceTurn, Ledger, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { careerTools, EMPTY_SEARCH_NOTE } from "../../supabase/functions/_shared/agent/career_tools.ts";
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

// (architect ruling on the empty-search fix: the pipeline stays on; the empty result gives units the reply can cite)
const emptySearch = async (message: string, query: string) => {
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const out: any = await t.run({ query }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message } } as any);
  const l = new Ledger(NOW);
  l.fromToolResult("search_jobs", out);
  return { out, l };
};
const H034 = "can u look at jobs for me im a cashier wanna do something w computers";

Deno.test("S3 r12 / H034, H035: an empty search states what it searched and gives the field's entry roles as suggestion units", async () => {
  const { out, l } = await emptySearch(H034, "entry level help desk support");
  eq(out.note, EMPTY_SEARCH_NOTE, "the note is unchanged");
  eq(out.searched, "entry level help desk support");
  assert(out.suggestions?.[0]?.roles?.some((r: string) => /help desk/i.test(r)), JSON.stringify(out));
  assert(l.units.some((u) => u.kind === "chat" && /for "entry level help desk support" returned 0 postings/.test(u.text)), l.block());
  const sg = l.units.find((u) => u.kind === "suggestion");
  assert(sg && /not postings/.test(sg.text) && /help desk/i.test(sg.text) && !sg.owner, l.block());
  eq(evidenceTurn(l), true, "the pipeline still runs on an empty search");
  // (no field the table holds: no suggestion is made up)
  const nurse = await emptySearch("got anything for nurses near columbus who want days only?", "registered nurse day shift Columbus");
  eq(nurse.out.suggestions, undefined);
  assert(nurse.l.units.some((u) => /for "registered nurse day shift Columbus" returned 0 postings/.test(u.text)), nurse.l.block());
});

Deno.test("S3 r12 / H034: an empty-search reply naming the suggested roles survives the pipeline", async () => {
  const { l } = await emptySearch(H034, "entry level help desk support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const asked: string[] = [];
  const judge = async (cs: { claim: string; source: string }[]) => { for (const c of cs) asked.push(c.source); return cs.map(() => "yes" as const); };
  const draft = `Nothing matched entry level help desk support right now [E1]. People moving into computer work commonly start as an IT support or help desk technician, a data entry or records clerk, or a QA tester [${sg.id}]. Which of those sounds closest to what you want?`;
  const v = await verifyTagged(draft, l, { ask: H034, judge });
  assert(v.text.includes("IT support or help desk technician"), JSON.stringify(v));
  assert(v.text.includes("Which of those sounds closest to what you want?"), v.text);
});

Deno.test("S3 r12 / H034: a sentence a suggestion unit holds stands without the judge; pay, requirements and postings on it do not", async () => {
  // (the eval harness gives the brain no support judge, so every judged claim fails closed there: probe-r12-ruling kept nothing)
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const good = `People moving into computer and IT work commonly start as IT support or help desk technician, data entry or records clerk, or QA tester [${sg.id}].`;
  const v = await verifyTagged(good, l, { ask: H034, judge: null });
  assert(v.text.includes("help desk technician"), JSON.stringify(v));
  for (const bad of ["IT support or help desk technician roles pay well and need no degree", "IT support or help desk technician roles require a certification",
    "IT support or help desk technician openings are posted near you", "IT support or help desk technician jobs pay $20 an hour"]) {
    const b = await verifyTagged(`${bad} [${sg.id}].`, l, { ask: H034, judge: null });
    assert(!b.text, `kept: ${bad} -> ${b.text}`);
  }
});

Deno.test("S3 r12 / H034: a question whose count word counts the items this reply shows stands; any other count does not", async () => {
  // (probe-r12-ruling3 1 and 4: the roles stood, and "Which of those four sounds closest to what you want?" was dropped for "four")
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const four = `People moving into computer and IT work commonly start as IT support or help desk technician, technical or customer support at a software company, data entry or records clerk, or QA tester [${sg.id}].`;
  const ok = await verifyTagged(`${four} Which of those four sounds closest to what you want?`, l, { ask: H034, judge: null });
  assert(ok.text.includes("Which of those four sounds closest to what you want?") && ok.text.includes("QA tester"), JSON.stringify(ok));
  const listed = await verifyTagged(`1. IT support or help desk technician [${sg.id}].\n2. QA tester [${sg.id}].\nWhich of these two fits you best?`, l, { ask: H034, judge: null });
  assert(listed.text.endsWith("Which of these two fits you best?"), listed.text);
  // (a count that is not what the reply shows, or a list that did not stand, refuses the question as before)
  const wrong = await verifyTagged(`${four} Which of those three sounds closest to what you want?`, l, { ask: H034, judge: null });
  assert(!wrong.text.includes("those three"), wrong.text);
  const gone = await verifyTagged("Zorblax Medical, Quintel Care, Brightline Health and Arden Labs pay $90 an hour. Which of those four sounds best?", l, { ask: H034, judge: null });
  assert(!gone.text.includes("those four"), gone.text);
  const alone = await verifyTagged("Which of those four sounds closest to what you want?", l, { ask: H034, judge: null });
  eq(alone.text, "");
});

Deno.test("S3 r12 / H034: a tag written after the sentence's stop cites that sentence, not the next one", async () => {
  // (probe-r12-ruling: "…nothing to show yet. [E2] Cashiers commonly…" and the repair's "…not postings. [E3]" on its own line)
  const { l } = await emptySearch(H034, "entry level help desk support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const cited: string[][] = [];
  const judge = async (cs: { claim: string; source: string }[]) => { for (const c of cs) cited.push([c.claim, c.source]); return cs.map(() => "yes" as const); };
  const draft = `The search for entry level help desk support returned 0 postings. [E1] People moving into computer and IT work commonly start as IT support or help desk technician, or QA tester; this is general career knowledge, not postings. [${sg.id}]\nWhich of those sounds closest to what you want?`;
  const v = await verifyTagged(draft, l, { ask: H034, judge });
  eq(v.failures, [], JSON.stringify(v.failures));
  assert(v.text.includes("returned 0 postings.") && v.text.includes("help desk technician") && !/\[E\d/.test(v.text), v.text);
  eq(v.citeOf.find(([x]) => x.startsWith("The search"))?.[1], ["E1"]);
  eq(v.citeOf.find(([x]) => x.startsWith("People moving"))?.[1], [sg.id]);
});

Deno.test("S3 r12 / H034: an empty-search reply that invents a posting or an employer is still dropped", async () => {
  const { l } = await emptySearch(H034, "entry level help desk support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const sources: string[] = [];
  const judge = async (cs: { claim: string; source: string }[]) => { for (const c of cs) sources.push(c.source); return cs.map(() => "yes" as const); };
  // (each cites the suggestion unit, as a reply would; the judge here says yes to everything, so code alone drops them)
  for (const bad of ["Brightline Tech is hiring IT support technicians near you", "There is a help desk technician opening near you",
    "Brightline Tech has a data entry clerk role open", "I found 3 help desk postings", "A QA tester position is open in your area"]) {
    const v = await verifyTagged(`${bad} [${sg.id}]. Want me to keep looking?`, l, { ask: H034, judge });
    assert(!v.text.includes(bad), `kept: ${bad} -> ${v.text}`);
  }
  // (an uncited one is checked against every unit but the suggestions: what the judge reads never includes them)
  await verifyTagged("There is a help desk technician opening near you. Want me to keep looking?", l, { ask: H034, judge });
  assert(!sources.some((x) => /General career knowledge/.test(x)), "a posting claim is never judged against a suggestion");
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
  for (const said of ["Question 1: Tell me about yourself and why this role.", "Your first question: “Tell me about yourself and why you want this role.”",
    // (probe-r12-after-3: the brain's own longer wording)
    "Question 1: Tell me about yourself and why you want this data analyst role."]) {
    const next = serve([said]);
    assert(!/Tell me about yourself/.test(next), `repeated after ${said}: ${next}`);
    assert(/Here is your question: /.test(next), next);
  }
  // (a different question with the same frame is not the same question)
  assert(/Tell me about yourself/.test(serve(["Question 1: Tell me about a time you failed."])), "an unrelated question leaves the bank's order");
});

// ---- S3 r12, architect ruling: code's next-step line after an empty search whose kept reply neither asks nor offers (next_step.ts)
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { emptySearchNextStep, nextStepLine, watchCommand, watchWords } from "../../supabase/functions/_shared/agent/next_step.ts";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
const H035 = "got anything for nurses near columbus who want days only?";
const stub = (query: string, draft: string) => {
  let n = 0;
  return async (p: any) => {
    if (!p.tools?.length) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn" };
    n++;
    return n === 1 ? { content: [{ type: "tool_use", id: "s1", name: "search_jobs", input: { query } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: draft }], stop_reason: "end_turn" };
  };
};
const turn = (query: string, draft: string, message = H035) => agentTurn({ message, history: [], stores: { profile: { facts: [] } }, userId: "u-ns", threadId: "t-ns", now: NOW,
  model: stub(query, draft), postings: async () => [], supportJudge: yes } as any) as Promise<any>;

Deno.test("S3 r12 / H035: an empty search whose kept reply asks and offers nothing ends with code's watch line", async () => {
  const r = await turn("registered nurse day shift Columbus", "The search for registered nurse day shift Columbus returned 0 postings [E2]. Nothing has been sent or applied to.");
  const line = emptySearchNextStep("registered nurse day shift Columbus")!;
  eq(line, 'Say "watch for registered nurse day shift Columbus roles" and I\'ll save a watch for them on your list.');
  assert(String(r.reply).endsWith(line), r.reply);
  eq(String(r.reply).split(line).length, 2, "once");
});

Deno.test("S3 r12 / H035: no line when the brain's own question or offer stood, or when the search found postings", async () => {
  const asked = await turn("registered nurse day shift Columbus", "The search for registered nurse day shift Columbus returned 0 postings [E2]. Which of those sounds closest to what you want?");
  assert(!/save a watch/.test(asked.reply), asked.reply);
  eq(nextStepLine("Nothing matched. I can look at named hospitals if you name them.", "nurse", false), null, "an offer");
  eq(nextStepLine("Nothing matched.", "nurse", true), null, "a search found postings");
  eq(nextStepLine("Nothing matched.", null, false), null, "no empty search");
  assert(nextStepLine("Nothing matched.", "nurse", false), "otherwise, the line");
});

Deno.test("S3 r12 / H035: the line's command is code's watch, word for word", () => {
  const host = CareerHost.createCareerHost({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment });
  for (const q of ["registered nurse day shift Columbus", "entry level help desk support", "nurse \"days\" Columbus, OH"]) {
    const cmd = watchCommand(watchWords(q)!);
    assert(emptySearchNextStep(q)!.includes(`"${cmd}"`), cmd);
    const ctx: any = host.createTurnCtx({ userId: "u1", threadId: "t1", now: NOW, snapshot: null });
    const d = stagedDecision({ env: { get: (k: string) => k === "CAREER_BRAIN" ? "staged" : undefined }, message: cmd, ctx, host, structured: false });
    eq([d.brain, d.intent], [false, "career_watch_create"], cmd);
    const r = host.runTurn(cmd, ctx);
    eq(r.intent, "career_watch_create", cmd);
    assert(/^Watch set: /.test(String(r.reply)), r.reply);
  }
});
