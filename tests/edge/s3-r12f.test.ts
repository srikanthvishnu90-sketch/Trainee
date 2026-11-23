// S3 r12f (the subscription sitting #7 on 72e15122e: dev H035 failed on both judges in p1 and p2, H034 in p2). In each, a search came
// back empty, the reply pipeline dropped the draft's sentences, and what was delivered answered nothing. The delivered replies are in
// evals/career/results/s3sub-72e15122ead8effd05292462001d4c4e45e0b450-p1.json and -p2.json (the sitting's worktree); they are
// Trainee's own output, used here as fixtures. The person's messages below are this file's own, never a held-out case's.
// D-101 (code floor for gutted replies) and the follow-up of the independent review of 72e15122e (a clause about the person inside a
// sentence is person-subject).
// Run: deno test -A --no-check tests/edge/s3-r12f.test.ts
import { answersNothing, floorReply, searchedLine, searchedParams } from "../../supabase/functions/_shared/agent/floor_reply.ts";
import { emptyNextStep, SEARCH_AGAIN } from "../../supabase/functions/_shared/agent/next_step.ts";
import { Ledger, saidSubject, usesTermsUnsaid, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const NOW = Date.UTC(2026, 9, 19, 15);
const yes = async (cs: unknown[]) => cs.map(() => "yes" as const);
const NURSE_MSG = "any LPN openings around cincinnati? i only do day shifts";
const SWITCH_MSG = "i stock shelves at a grocery store and want to get into tech, what can i do";
const ROUTES = "General career knowledge, not postings: people moving into computer and IT work commonly start as IT support or help desk technician, technical or customer support at a software company, data entry or records clerk, or QA tester.";
const base = { dropped: true, codeLines: [] as string[], anyFound: false, count: 0, nextStep: SEARCH_AGAIN };

// ---------------------------------------------------------------------------------------------------------- the three gutted replies
Deno.test("D-101 / H035 p1 shape: 'I can still keep it in mind … Nothing has been sent' answers nothing; code's floor says what was searched", () => {
  const gutted = "I can still keep it in mind for this chat. Nothing has been sent or applied to.";
  assert(answersNothing(gutted), "a reference back to nothing plus the not-sent line answers nothing");
  const out = floorReply({ ...base, reply: gutted, message: NURSE_MSG, emptyQuery: "LPN day shift Cincinnati" })!;
  assert(out, "the floor applies");
  assert(/I searched for LPN roles near Cincinnati \(day shift\) and found 0 postings\./.test(out), out);
  assert(!/keep it in mind/.test(out), `the dangling sentence goes: ${out}`);
  assert(out.includes("Nothing has been sent or applied to.") && out.trim().endsWith(SEARCH_AGAIN), out);
});

Deno.test("D-101 / H035 p2 shape: never a city 'not on file' when the person named the searched place this turn", () => {
  for (const gutted of ["Your city is not on file. Nothing has been sent or applied to.", `Your city is not on file. Nothing has been sent or applied to.\n\n${SEARCH_AGAIN}`]) {
    assert(answersNothing(gutted), gutted);
    const out = floorReply({ ...base, reply: gutted, message: NURSE_MSG, emptyQuery: "LPN day shift Cincinnati" })!;
    assert(out && !/not on file/i.test(out), `the city line goes: ${out}`);
    assert(/near Cincinnati \(day shift\)/.test(out), out);
    assert(out.split(SEARCH_AGAIN).length === 2, `one next step, not two: ${out}`);
  }
  // (a city the person did not name this turn: the record's own line stays)
  const other = floorReply({ ...base, reply: "Your city is not on file. Nothing has been sent or applied to.", message: "any LPN openings? days only", emptyQuery: "LPN day shift Cincinnati" })!;
  assert(/not on file/.test(other), other);
});

Deno.test("D-101 / H034 p2 shape: 'Which of these roles …' over dropped roles plus 'couldn't verify' gets the entry routes as general knowledge", () => {
  const gutted = "Which of these roles sounds closest to what you want?\n\nI couldn't verify an answer to that from what I read.";
  assert(answersNothing(gutted), gutted);
  const step = 'Say "watch for entry level help desk roles" and I\'ll save a watch for them on your list.';
  const out = floorReply({ ...base, reply: gutted, message: SWITCH_MSG, emptyQuery: "entry level help desk", routes: ROUTES, nextStep: step })!;
  assert(/I searched for help desk roles \(entry level\) and found 0 postings\./.test(out), out);
  assert(/As general career knowledge, not postings: people moving into computer and IT work commonly start as IT support or help desk technician/.test(out), out);
  assert(!/couldn't verify/.test(out) && !/these roles/.test(out), `the fallback and the dangling question go: ${out}`);
  assert(out.trim().endsWith(step), out);
  // (code's floor says nothing about the person: no "you" outside the routed step, never their job or goal)
  assert(!/(?<![\p{L}])(?:you|your)(?![\p{L}])/iu.test(out.replace(step, "")), out);
  // (the fallback with the units it lists is the fallback's whole paragraph)
  const fb = "Nothing has been sent or applied to.\n\nI couldn't verify an answer to that from what I read. This chat's tool results do hold:\nThe search (search_jobs) for \"LPN day shift Cincinnati\" returned 0 postings.";
  assert(answersNothing(fb), "a couldn't-verify fallback is never the whole substance");
});

Deno.test("D-101: the floor applies only to a gutted reply after an empty search, and keeps code's not-run lines at the head", () => {
  const gutted = "Nothing has been sent or applied to.";
  const o = { ...base, reply: gutted, message: NURSE_MSG, emptyQuery: "LPN day shift Cincinnati" };
  assert(floorReply({ ...o, dropped: false }) === null, "nothing dropped: the reply stands");
  assert(floorReply({ ...o, anyFound: true }) === null, "postings found: not this floor");
  assert(floorReply({ ...o, emptyQuery: null }) === null, "no empty search: not this floor");
  for (const real of ["The search for LPN roles in Cincinnati came back empty. Nothing has been sent or applied to.", "People moving into nursing often start as CNAs. Which of these sounds closest?",
    "I couldn't verify an answer to that from what I read. Cincinnati hospitals post most LPN roles on their own sites."]) {
    assert(!answersNothing(real), real);
    assert(floorReply({ ...o, reply: real }) === null, real);
  }
  const nr = "I couldn't save that as a standing rule.";
  const out = floorReply({ ...o, reply: `${nr}\n\nI can still keep it in mind for this chat.`, codeLines: [nr] })!;
  assert(out.startsWith(nr) && /I searched for LPN roles/.test(out), out);
});

Deno.test("D-101 (a): the search's own words are parsed into role, place and constraints; a pay band and remote are constraints", () => {
  const p = searchedParams("registered nurse day shift Columbus OH");
  assert(p.role === "registered nurse" && p.place === "Columbus, OH" && p.constraints.join() === "day shift", JSON.stringify(p));
  assert(searchedLine("data analyst remote $70k-$90k", 0) === "I searched for data analyst roles (remote, $70k-$90k) and found 0 postings.", searchedLine("data analyst remote $70k-$90k", 0));
  assert(searchedLine("Chicago", 0) === "I searched for roles near Chicago and found 0 postings.", searchedLine("Chicago", 0));
  assert(emptyNextStep("LPN day shift Cincinnati") === SEARCH_AGAIN, "with no verified watch: search again");
});

// --------------------------------------------------------------------------------------------------- through a real turn (agentTurn)
const stub = (query: string, draft: string) => {
  let n = 0;
  return async (p: any) => {
    if (!p.tools?.length) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn" };
    n++;
    return n === 1 ? { content: [{ type: "tool_use", id: "s1", name: "search_jobs", input: { query } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: draft }], stop_reason: "end_turn" };
  };
};
Deno.test("D-101 through a turn: the pipeline drops every claim of the draft, and the person gets code's floor, not a gutted reply", async () => {
  const draft = "Zorblax Medical has two LPN day openings near you [E99]. I can still keep it in mind for this chat. Nothing has been sent or applied to.";
  const r: any = await agentTurn({ message: NURSE_MSG, history: [], stores: { profile: { facts: [] } }, userId: "u-r12f", threadId: "t-r12f", now: NOW,
    model: stub("LPN day shift Cincinnati", draft), postings: async () => [], supportJudge: yes } as any);
  const reply = String(r.reply);
  assert(!/Zorblax/.test(reply), `the invented claim is still dropped: ${reply}`);
  assert(/I searched for LPN roles near Cincinnati \(day shift\) and found 0 postings\./.test(reply), reply);
  assert(!/keep it in mind/.test(reply) && !/not on file/i.test(reply), reply);
  assert(reply.includes(SEARCH_AGAIN) || /watch for/.test(reply), `one routed next step: ${reply}`);
});

// --------------------------------------------------------------------------- follow-up of the review: a person clause inside a sentence
const fieldTurn = async (message: string) => {
  const t = careerTools({ postings: async () => [] }).find((x: any) => x.name === "search_jobs")!;
  const out: any = await t.run({ query: "data analyst" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message } } as any);
  const l = new Ledger(NOW); l.addRecord([], ["city"]); l.fromToolResult("search_jobs", out); return l;
};
Deno.test("review follow-up: 'Since you know X', 'X, which you know,', 'It's your X that', 'gives you …: X' are person-subject", async () => {
  for (const s of ["Since you know SQL, data analyst roles are a natural start.", "SQL and Excel, which you know, are core data analysis tools.", "It's your SQL that stands out.", "That gives you a strong base: SQL, Excel and 2 years of reporting."])
    assert(saidSubject(s), s);
  const said = ["I know SQL and Excel and did 2 years of reporting"];
  const l = await fieldTurn(said[0]);
  for (const s of ["Since you know SQL, data analyst roles are a natural start.", "SQL and Excel, which you know, are core data analysis tools.", "It's your SQL that stands out.", "That gives you a strong base: SQL, Excel and 2 years of reporting."]) {
    const v = await verifyTagged(s, l, { judge: yes, said, ask: "which roles fit me?" });
    assert(!v.failures.length && v.text.includes(s.slice(0, 20)), `${s}: ${JSON.stringify(v.failures)}`);
  }
});
Deno.test("review follow-up: the bars stand for an embedded person clause; an unsaid example or class word credited to them is refused", async () => {
  const said = ["I know SQL and did 2 years of reporting"];
  const l = await fieldTurn(said[0]);
  const refused = ["Power BI, which you know, is a core data analysis tool.", "Since you know Power BI, data analyst roles fit.", "It's your Tableau that stands out.", "That gives you a strong base: Power BI and SQL.",
    "Dashboards, which you know, are core to the work.", "That gives you a strong base: dashboards.", "Spreadsheets, which you've used, are core to the work.", "Since you know SQL, you could earn $70k.",
    "Since you know SQL, I applied for you.", "Since you know SQL, their team needs you.", "It's your SQL that got you the interview.", "Since you know SQL, your application was sent.", "It's your 5 years of reporting that stand out."];
  for (const s of refused) for (const id of [null, ...l.units.map((u) => u.id)]) {
    const d = id ? `${s.replace(/\.$/, "")} [${id}].` : s;
    const v = await verifyTagged(d, l, { judge: yes, said, ask: "which roles fit me?" });
    assert(v.failures.length > 0, `stood (${id}): ${s}`);
  }
  for (const s of ["Since you know SQL, you could earn $70k.", "Since you know SQL, I applied for you.", "Since you know SQL, their team needs you.", "It's your SQL that got you the interview."]) assert(!saidSubject(s), `a bar holds: ${s}`);
  // (B3: a class word in either number)
  const uses = l.units.find((u) => u.uses)!.text;
  assert(usesTermsUnsaid("Your dashboards are a plus.", uses, said[0]).includes("dashboard"), "plural class word");
  assert(!usesTermsUnsaid("Your dashboards are a plus.", uses, "I built dashboards").length, "said in the plural");
});
