// S3 r12 (the subscription sitting for 66118fb7a: dev H010, H034, H035 failed in code). Each test names the transcript it comes from.
// Run: deno test -A --no-check tests/edge/s3-r12-fixes.test.ts
import { dropDanglingCounts, evidenceTurn, Ledger, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
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

Deno.test("S3 r12 / H034: a question whose count word counts the items this reply shows stands; any other count does not", async () => {
  // (probe-r12-ruling3 1 and 4: the roles stood, and "Which of those four sounds closest to what you want?" was dropped for "four")
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const four = `People moving into computer and IT work commonly start as IT support or help desk technician, technical or customer support at a software company, data entry or records clerk, or QA tester [${sg.id}].`;
  const ok = await verifyTagged(`${four} Which of those four sounds closest to what you want?`, l, { ask: H034, judge: yes });
  assert(ok.text.includes("Which of those four sounds closest to what you want?") && ok.text.includes("QA tester"), JSON.stringify(ok));
  const listed = await verifyTagged(`1. IT support or help desk technician [${sg.id}].\n2. QA tester [${sg.id}].\nWhich of these two fits you best?`, l, { ask: H034, judge: yes });
  assert(listed.text.endsWith("Which of these two fits you best?"), listed.text);
  // (a count that is not what the reply shows, or a list that did not stand, refuses the question as before)
  const wrong = await verifyTagged(`${four} Which of those three sounds closest to what you want?`, l, { ask: H034, judge: yes });
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
import { emptySearchNextStep, nextStepLine, SEARCH_AGAIN, watchVerified } from "../../supabase/functions/_shared/agent/next_step.ts";
import { routerWatchProbe, watchHostReady } from "../../supabase/functions/agent-chat/career_staged.ts";
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
const PROFILE = { facts: [{ id: "F-001", kind: "experience", text: "I'm a registered nurse", status: "confirmed", source: "user" }] };
const turn = (query: string, draft: string, message = H035, stores: Record<string, unknown> = { profile: structuredClone(PROFILE) }) => agentTurn({ message, history: [], stores, userId: "u-ns", threadId: "t-ns", now: NOW,
  model: stub(query, draft), postings: async () => [], supportJudge: yes } as any) as Promise<any>;

Deno.test("S3 r12 / H034, architect ruling (narrowed): a back-reference to a list goes only when that list was dropped", async () => {
  // (probe-r12-nextstep-5: "Pick whichever of the four roles above sounds closest and I'll search for it" was delivered after the
  // four roles were dropped)
  const four = "People moving into computer work commonly start as IT support or help desk technician, technical or customer support at a software company, data entry or records clerk, or QA tester.";
  const saved = "Saved: you're a cashier, and you want to do something with computers.";
  const droppedList = "1. IT support\n2. Data entry\n3. QA tester\n4. Tech support";
  for (const ref of ["Pick whichever of the four roles above sounds closest and I'll search for it.", "I'll look up the 4 roles I listed next.", "Which of those four sounds closest?"]) {
    eq(dropDanglingCounts(`${saved} ${ref}`, droppedList), saved, `dangling: ${ref}`);
    eq(dropDanglingCounts(`${saved} ${ref}`, ""), `${saved} ${ref}`, `nothing dropped: ${ref}`);
    eq(dropDanglingCounts(`${saved} ${ref}`, "Nothing has been sent."), `${saved} ${ref}`, `what was dropped held no list: ${ref}`);
    eq(dropDanglingCounts(`${four} ${ref}`, droppedList), `${four} ${ref}`, `the list is still shown: ${ref}`);
    eq(dropDanglingCounts(ref, droppedList), ref, `never emptied: ${ref}`);
  }
  // (in the pipeline, on what it drops)
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const v = await verifyTagged(`Nothing has been sent or applied to.\n1. Plumber [E99].\n2. Welder [E99].\n3. Electrician [E99].\n4. Carpenter [E99].\nWhich of those four sounds closest to what you want?`, l, { ask: H034, judge: yes });
  assert(!v.text.includes("those four") && v.text.includes("Nothing has been sent"), v.text);
  // (through a real turn: the condense or pipeline path dropped the list, the reference goes)
  const r: any = await turn("entry level help desk IT support", `1. Plumber [E99].\n2. Welder [E99].\n3. Electrician [E99].\n4. Carpenter [E99].\nNothing has been sent or applied to. Pick whichever of the four roles above sounds closest and I'll search for it.`, H034);
  assert(!String(r.reply).includes("four roles above"), r.reply);
});

Deno.test("review p5, p6: true counts stay (no bare 'all N' or 'one of the N'; a File link, a pair or the sentence's own series shows the items)", async () => {
  const droppedList = "1. IT support\n2. Data entry\n3. QA tester\n4. Tech support";
  for (const r of ["I sent all 5 applications. Nothing else is waiting on you.", "Applied to all three roles you picked. You'll see them on your list.",
    "I put the 10 matching postings in a File:\nhttps://trainee.app/f/abc\nWhich of those 10 should I apply to first?",
    "Your File has 12 postings:\nhttps://trainee.app/f/abc\nPick any of the 12 and I'll prepare it.", "All four answers you gave were strong. Want another question?",
    "Of the 3 interviews you have, the Stripe one is first.", "These 3 steps matter: tailor, apply, follow up.", "1. Help desk technician\n2. QA tester\nWhich of those two fits?",
    "Help desk technician and QA tester are two good starts. Which of those two fits?", "You applied to 4 jobs last week; all four are still pending."]) {
    eq(dropDanglingCounts(r), r, r);
    eq(dropDanglingCounts(r, droppedList), r, `with a dropped list: ${r}`);
  }
  for (const draft of ["Sounds good. Practice the STAR format for all three stories you mentioned, then send me your first one.",
    "Great, all four of your references said yes, so you're set there. Want me to draft the thank-you note?",
    "Ok. Pick all three of the roles you're interested in and I'll keep them in mind."]) {
    const model = async () => ({ content: [{ type: "text", text: draft }], stop_reason: "end_turn" });
    const r: any = await agentTurn({ message: "i have three stories ready for my interview: the outage, the migration and the launch", history: [], stores: { profile: { facts: [] } }, userId: "u", threadId: "t", now: NOW, model, postings: async () => [], supportJudge: yes } as any);
    eq(r.reply, draft, draft);
  }
});

Deno.test("review p1: a suggestion-held claim goes to the support judge like any other, and a no drops it", async () => {
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const no = async (cs: unknown[]) => cs.map(() => "no" as const);
  for (const c of ["IT support or help desk technician roles are fully remote and easy to get", "A help desk technician job is a great fit for you because cashier work is customer support",
    "You would be hired as a QA tester within weeks", "QA tester roles lead quickly to software engineer jobs", "Data entry or records clerk work is being replaced by AI",
    "IT support at a software company is the best-paid of these", "Technical or customer support at a software company is what most cashiers do next",
    "People moving into computer work start as help desk technician and get promoted fast", "Help desk technician roles need no experience at all",
    "QA tester is the most common route into tech for people with no background", "Help desk technicians work nights and weekends", "Microsoft starts many people as help desk technicians",
    "IT support at a software company is in high demand in your city", "These roles open up a lot in January", "Help desk technicians at Amazon get trained on the job",
    "QA tester work suits you since you already use computers daily", "Help desk is the role you told me you wanted",
    // (and the unit's own sentence too: nothing stands on a suggestion without the judge's yes)
    "People moving into computer and IT work commonly start as IT support or help desk technician, or QA tester"]) {
    eq((await verifyTagged(`${c} [${sg.id}].`, l, { ask: H034, judge: no })).text, "", c);
    eq((await verifyTagged(`${c}.`, l, { ask: H034, judge: no })).text, "", `untagged: ${c}`);
    eq((await verifyTagged(`${c} [${sg.id}].`, l, { ask: H034, judge: null })).text, "", `no judge: ${c}`);
  }
  assert((await verifyTagged(`People moving into computer and IT work commonly start as IT support or help desk technician, or QA tester [${sg.id}].`, l, { ask: H034, judge: yes })).text, "a yes keeps it");
});

Deno.test("review p3, p4: a counted question that claims postings, and posting claims on suggestions, are dropped", async () => {
  const { l } = await emptySearch(H034, "entry level help desk IT support");
  const sg = l.units.find((u) => u.kind === "suggestion")!;
  const four = `People moving into computer and IT work commonly start as IT support or help desk technician, technical or customer support at a software company, data entry or records clerk, or QA tester [${sg.id}].`;
  for (const q of ["Which of those four openings should I apply you to?", "Which of those four jobs near you do you want me to send your resume to?", "Should I apply you to all four of those?"]) {
    const v = await verifyTagged(`${four} ${q}`, l, { ask: H034, judge: yes });
    assert(!v.text.includes(q), `kept: ${q}`);
  }
  for (const c of ["There are QA tester jobs near you", "Help desk technician jobs are available near you right now", "QA tester jobs are easy to find near you", "IT support roles are hiring in your area"]) {
    const v = await verifyTagged(`${c} [${sg.id}].`, l, { ask: H034, judge: yes });
    eq(v.text, "", c);
  }
  const bare = new Ledger(NOW);
  bare.fromToolResult("search_jobs", { postings: [] });
  eq((await verifyTagged("Which of those four openings should I apply you to?", bare, { ask: "jobs w computers", judge: async (cs: unknown[]) => cs.map(() => "no" as const) })).text, "");
});

Deno.test("review p2: the watch line is offered only for a watch code would really save for exactly those words", async () => {
  await watchHostReady;
  const ctx = { profile: structuredClone(PROFILE) };
  const ok = (q: string, c: Record<string, unknown> | null = ctx) => watchVerified(q, { hasProfile: !!c, probe: routerWatchProbe(c ?? {}) });
  for (const q of ["registered nurse day shift", "nurse", "data entry or records clerk", "barista"]) assert(ok(q), `verified: ${q}`);
  for (const q of ["jobs near me", "data analyst $80k", "entry-level marketing coordinator, New York", "remote software engineer jobs", "software engineer intern summer 2027",
    "stop", "cancel my applications", "delete my account", "apply to everything", "send my resume", "unsubscribe alerts", "part-time warehouse jobs in Dallas",
    "night shift CNA Columbus OH", "registered nurse day shift Columbus", "Google", "jobs", "IT", "help desk OR IT support"]) assert(!ok(q), `refused: ${q}`);
  assert(!ok("registered nurse day shift", null), "no profile: no line");
});

Deno.test("S3 r12 / H035: an empty search whose kept reply asks and offers nothing ends with code's verified watch line", async () => {
  const r = await turn("registered nurse day shift", "The search for registered nurse day shift returned 0 postings [E2]. Nothing has been sent or applied to.");
  const line = emptySearchNextStep("registered nurse day shift")!;
  eq(line, 'Say "watch for registered nurse day shift roles" and I\'ll save a watch for them on your list.');
  assert(String(r.reply).endsWith(line), r.reply);
  eq(String(r.reply).split(line).length, 2, "once");
  // (a watch code would not save as asked: no watch line, the search-again line instead, once)
  for (const [q, stores] of [["registered nurse day shift Columbus", { profile: structuredClone(PROFILE) }], ["registered nurse day shift", {}], ["stop", { profile: structuredClone(PROFILE) }]] as const) {
    const n = await turn(q, `The search for ${q} returned 0 postings [E2]. Nothing has been sent or applied to.`, H035, structuredClone(stores) as any);
    assert(!/save a watch/.test(String(n.reply)), `${q}: ${n.reply}`);
    assert(String(n.reply).endsWith(SEARCH_AGAIN) && String(n.reply).split(SEARCH_AGAIN).length === 2, `${q}: ${n.reply}`);
  }
});

Deno.test("S3 r12 / H035: no line when the brain's own question or offer stood, or when the search found postings", async () => {
  const asked = await turn("registered nurse day shift", "The search for registered nurse day shift returned 0 postings [E2]. Which kind of nursing role should I search next?");
  assert(!/save a watch/.test(asked.reply), asked.reply);
  const yesQ = () => true;
  eq(nextStepLine("Nothing matched. I can look at named hospitals if you name them.", "nurse", false, yesQ), null, "an offer");
  eq(nextStepLine("Nothing matched.", "nurse", true, yesQ), null, "a search found postings");
  eq(nextStepLine("Nothing matched.", null, false, yesQ), null, "no empty search");
  eq(nextStepLine("Nothing matched.", "nurse", false, () => false), SEARCH_AGAIN, "not verified: search again");
  eq(nextStepLine("Nothing matched. Which city should I search?", "nurse", false, () => false), null, "a question stood: nothing");
  assert(nextStepLine("Nothing matched.", "nurse", false, yesQ), "otherwise, the line");
});
