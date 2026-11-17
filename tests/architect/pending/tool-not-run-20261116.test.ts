// Gap #5 of the 10/10 rubric (2026-11-16; evals/mirror/instinct-wa-batch1/, live-12 C1 and C19), structural (architect direction
// after two rejected rounds of word lists): a tool call missing a required input is refused before it runs and the brain gets ONE
// more try; the refusal is a structured "not run" fact; when the call never ran, code ALWAYS adds its not-run line (a D-024 fact,
// like STANDING_REFUSED), whatever the reply says, and removes no sentence (a claim needing the refused call's result is the reply
// verifier's, PR #849: a refused call contributes no evidence). A retry that ran and threw is said to have failed. Labels come from
// a closed map, never a tool name. $0, a scripted model through the real agent loop (runAgentTurn).
//   NR-1  the refusal is structured (not_run, each missing input with its schema description, retry allowed); the retry runs
//   NR-2  a second refusal ends that tool for the turn; a third call is refused and never runs
//   NR-3  C19: the not-run line is always added; no sentence of the reply is removed; no extra model call
//   NR-4  no wording suppresses the line (review probes U1b, U2, U3, U5, U7, S1, S2, and a reply that already admits it)
//   NR-5  no sentence is ever removed (review probes O1, O2, O3)
//   NR-6  a retry that ran and threw is said to have failed; the meta names the label
//   NR-7  every tool the brain can be offered has a human label; an unknown tool is the "requested step", never its name (L1)
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/tool-not-run-20261116.test.ts
import assertNode from "node:assert/strict";
import { runAgentTurn, type ToolSpec } from "../../../supabase/functions/_shared/agent/loop.ts";
import { LABELS, labelOf } from "../../../supabase/functions/_shared/agent/not_run.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { capabilityTools } from "../../../supabase/functions/_shared/agent/capability_tools.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const runs: string[] = [];
const tool = (name: string, req: string[], run?: ToolSpec["run"]): ToolSpec => ({
  name, effect: "read", description: name,
  input_schema: { type: "object", properties: Object.fromEntries([...req, "employers"].map((k) => [k, { type: "string", description: `The ${k}, as the person named it` }])), required: req },
  run: run ?? (async (i) => { runs.push(`${name}:${JSON.stringify(i)}`); return { status: "ok", found: 3 }; }),
});
function scripted(steps: any[][]) {
  const payloads: any[] = [];
  let i = 0;
  const m = async (p: any) => { payloads.push(structuredClone(p)); const c = steps[Math.min(i++, steps.length - 1)]; return { content: c, stop_reason: c.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn" }; };
  return Object.assign(m, { payloads });
}
const text = (t: string) => [{ type: "text", text: t }];
const use = (name: string, input: unknown, id: string) => [{ type: "tool_use", id, name, input }];
const twice = (name: string) => [use(name, {}, "a"), use(name, {}, "b")];
const ASK = "find me 3 lakeshore alumni at google, just research";
const run = (tools: ToolSpec[], m: any, message = ASK) => runAgentTurn({ system: "s", history: [], message, tools, model: m, ctx: { userId: "u", threadId: "t", now: 0, state: {} } });
const resultsOf = (p: any) => p.messages[p.messages.length - 1].content.filter((b: any) => b.type === "tool_result");
const LINE = "The people search did not run this time, so there is no result from it.";
// What the loop's other guards make of the same final text with no refused call: the not-run layer only adds its line to that.
const baseline = async (tools: ToolSpec[], said: string, message = ASK) => (await run(tools, scripted([text(said)]), message)).reply;

Deno.test("NR-1 the refusal is a structured not-run fact naming each missing input; the retry with it filled runs", async () => {
  runs.length = 0;
  const m = scripted([use("find_people", { count: 3 }, "a"), use("find_people", { school: "Lakeshore University" }, "b"), text("One public lead, not verified. Nobody was contacted.")]);
  const r = await run([tool("find_people", ["school"])], m);
  const first = resultsOf(m.payloads[1])[0];
  ok(first.is_error, "refused");
  const fact = JSON.parse(String(first.content));
  eq([fact.status, fact.not_run, fact.retry_allowed], ["not_run", "people search", true]);
  eq(fact.missing_required_input, [{ input: "school", means: "The school, as the person named it" }]);
  ok(!/find_people/.test(String(first.content)), "no tool name in the fact");
  eq(runs, ['find_people:{"school":"Lakeshore University"}'], "the retry ran");
  ok(/missing required input: school/.test(r.tool_calls[0].error ?? ""), r.tool_calls[0].error);
  ok(!r.reply.includes(LINE) && !r.not_run, `a call that ran needs no line: ${r.reply}`);
});

Deno.test("NR-2 a second refusal ends that tool for the turn: a third call, even complete, is refused and never runs", async () => {
  runs.length = 0;
  const m = scripted([...twice("find_people"), use("find_people", { school: "Lakeshore" }, "c"), text("Which school should I search for?")]);
  const r = await run([tool("find_people", ["school"])], m);
  eq(runs, [], "the tool never ran");
  eq(JSON.parse(String(resultsOf(m.payloads[2])[0].content)).retry_allowed, false);
  ok(/will not run this turn/.test(JSON.parse(String(resultsOf(m.payloads[3])[0].content)).note));
  eq(r.tool_calls.map((c) => c.ok), [false, false, false]);
  ok(/^The people search (?:for Lakeshore )?did not run this time, so there is no result from it\./.test(r.reply), r.reply);
});

Deno.test("NR-3 C19: the not-run line is always added, no sentence is removed, and it costs no model call", async () => {
  const lie = "The search found no public page listing Lakeshore University alumni at Google. Try your school's alumni directory. Nobody was contacted.";
  const m = scripted([...twice("find_people"), text(lie)]);
  const r = await run([tool("find_people", ["school"])], m);
  eq(r.reply, `${LINE}\n\n${lie}`, "the line, then the reply exactly as written (its unsupported claim is the reply verifier's)");
  eq(m.payloads.length, 3, "two refusals and the reply: no review call");
  eq(r.not_run, [{ label: "people search", failed: false }]);
  const rem = await run([tool("remember_instruction", ["text"])], scripted([...twice("remember_instruction"), text("Got it, I'll keep that in mind from now on.")]), "the 3.9 gpa is outdated, don't reuse it");
  eq(rem.reply, `The save of that instruction did not run this time, so there is no result from it.\n\n${await baseline([tool("remember_instruction", ["text"])], "Got it, I'll keep that in mind from now on.", "the 3.9 gpa is outdated, don't reuse it")}`.trimEnd());
});

Deno.test("NR-4 no wording suppresses the not-run line (U1b, U2, U3, U5, U7, S1, S2, an admission)", async () => {
  const people = tool("find_people", ["school"]), jobs = tool("search_jobs", ["query"]), apps = tool("list_applications", ["scope"]);
  const cases: [ToolSpec[], any[][], string][] = [
    [[people], [...twice("find_people"), text("I found no Lakeshore alumni at Google, want me to try another school?")], LINE],
    [[people], [...twice("find_people"), text("Here are two Lakeshore alumni at Google: Jane Park and Omar Diaz.")], LINE],
    [[people], [...twice("find_people"), text("The search didn't run on LinkedIn, but there are no Lakeshore alumni at Google on public pages.")], LINE],
    [[people], [...twice("find_people"), text("I found nobody at Google who could be contacted.")], LINE],
    [[apps], [...twice("list_applications"), text("Your Stripe application is pending, and Ramp is still reviewing yours.")], "The check of your applications did not run this time"],
    [[people, jobs], [use("find_people", {}, "a"), use("search_jobs", { query: "swe" }, "j"), use("find_people", {}, "b"), text("I found 3 software roles at Google. I did not check whether they are still open. Which school are you from?")], LINE],
    [[people], [...twice("find_people"), text("I didn't save anything to your profile. Which school should I search?")], LINE],
    [[people], [...twice("find_people"), text("The people search didn't run: it needs the school. Which school?")], LINE],
  ];
  for (const [tools, steps, line] of cases) {
    const said = steps.at(-1)![0].text as string;
    const r = await run(tools, scripted(steps));
    const rest = r.reply.slice(r.reply.indexOf("\n\n") + 2);
    ok(r.reply.startsWith(line), `${said} -> ${r.reply}`);
    eq(rest, await baseline(tools, said), `nothing else changed: ${said}`);
  }
});

Deno.test("NR-5 no sentence is ever removed (O1, O2, O3)", async () => {
  const people = tool("find_people", ["school"]), comp = tool("research_company", ["company"]);
  const o1 = "Google hires interns each summer, and anyone at Google can refer you. Which school should I search alumni for?";
  const msg = "find lakeshore alumni at google, and does google hire interns?";
  const a = await run([people, comp], scripted([use("find_people", { employers: "Google" }, "a"), use("research_company", { company: "Google" }, "c"), use("find_people", { employers: "Google" }, "b"), text(o1)]), msg);
  const base = await run([people, comp], scripted([use("research_company", { company: "Google" }, "c"), text(o1)]), msg);
  eq(a.reply, `${LINE.replace("people search", "people search for Google")}\n\n${base.reply}`, "a sentence the run research covers is kept as the guards keep it");
  for (const said of ["If anyone at a career fair asks, lead with your 2 internships. Which school should I search?", "Your profile has no summary line yet. Which school should I search?"]) {
    const r = await run([people], scripted([...twice("find_people"), text(said)]));
    eq(r.reply, `${LINE}\n\n${await baseline([people], said)}`);
  }
});

Deno.test("NR-6 a retry that ran and threw is said to have failed", async () => {
  let n = 0;
  const flaky = tool("find_people", ["school"], async () => { n++; throw new Error("provider 500"); });
  const r = await run([flaky], scripted([use("find_people", {}, "a"), use("find_people", { school: "Lakeshore" }, "b"), text("The provider had trouble. Want me to try again later?")]));
  eq(n, 1);
  ok(r.reply.startsWith("The people search failed this time, so there is no result from it.") && !/did not run/.test(r.reply), r.reply);
  eq(r.not_run, [{ label: "people search", failed: true }]);
});

Deno.test("NR-7 every tool the brain can be offered has a human label; an unknown tool is the 'requested step', never its name", async () => {
  const names = [
    ...careerTools({ postings: async () => [], alerts: {}, memory: {}, events: {}, confirmations: {}, mail: {}, interviews: {}, digest: {}, outreach: {}, verifier: {}, tailor: {}, hired: {}, wants: {}, posting: async () => null, situation: null, linkCheck: async () => ({}), conversations: {}, market: {}, postingRecheck: async () => ({}), applyFlow: async () => ({}), research: {} } as any).map((t) => t.name),
    ...capabilityTools({ mail: {}, tracking: true, accounts: async () => [], cursor: null, readNow: null, connectUrl: "x", situation: null, snapshot: null, files: {}, people: { on: true, search: async () => ({}) }, inbox: {}, reply: {} } as any).map((t) => t.name),
    "create_file", "attach_document", "open_record_file", "compare_paths",
  ];
  ok(names.length >= 45, String(names.length));
  eq(names.filter((x) => !LABELS[x]), [], "tools with no label");
  for (const x of names) ok(!/_/.test(LABELS[x]) && LABELS[x] !== x, `${x}: ${LABELS[x]}`);
  eq(labelOf("queue_application"), "requested step");
  const r = await run([tool("queue_application", ["posting_id"])], scripted([...twice("queue_application"), text("Which posting should I queue?")]), "queue it");
  ok(r.reply.startsWith("The requested step did not run this time"), r.reply);
  ok(!/queue_application/.test(r.reply), r.reply);
});

// Review rv3 of ag/cd-a-not-run (probes-rv3-cd/a3_probe.ts): the line is decided per CALL, goes wherever the turn's text goes out,
// a retry that asked the person a question is not "failed", whitespace is missing, and labels read as actions.
Deno.test("NR-8 per call: a refused call another call to the same tool did not cover still gets its line (N1, the C19 shape)", async () => {
  const people = tool("find_people", ["school"]);
  const r = await run([people], scripted([use("find_people", { school: "Lakeshore", employers: "Google" }, "a"), use("find_people", { employers: "Meta" }, "b"), use("find_people", { employers: "Meta" }, "c"), text("I found 3 Lakeshore alumni at Google and none at Meta.")]), "find lakeshore alumni at google and at meta");
  ok(r.reply.startsWith("The people search for Meta did not run this time, so there is no result from it."), r.reply);
  // A retry with the refused call's arguments (and more) covers it.
  const r2 = await run([people], scripted([use("find_people", { employers: "Meta" }, "a"), use("find_people", { school: "Lakeshore", employers: "Meta" }, "b"), text("Found 3.")]));
  ok(!r2.not_run && !/did not run/.test(r2.reply), r2.reply);
});

Deno.test("NR-9 the line goes in a shown text and its parts too (N3); a retry that asked the person is not 'failed' (N2)", async () => {
  const shown = tool("draft_outreach", ["to"], async (_i, c: any) => { c.turn.show = { intent: "career_outreach_batch", text: "1. Draft to Jane\n\n2. Draft to Omar", parts: ["1. Draft to Jane", "2. Draft to Omar"] }; return { drafted: 2 }; });
  const r = await run([shown, tool("find_email", ["name"])], scripted([use("find_email", {}, "a"), use("find_email", {}, "b"), use("draft_outreach", { to: "Jane" }, "c"), text("Here are the drafts.")]));
  const line = "The inbox search did not run this time, so there is no result from it.";
  ok(r.show && r.show.text.startsWith(line) && r.show.parts?.[0] === line && r.show.parts?.length === 3, JSON.stringify(r.show));
  eq(r.reply, r.show!.text, "the reply and the shown text stay the same text");
  const { AskPerson } = await import("../../../supabase/functions/_shared/agent/loop.ts");
  const asks = tool("find_people", ["school"], async () => { throw new AskPerson("Which school did you go to?"); });
  const a = await run([asks], scripted([use("find_people", {}, "a"), use("find_people", { school: "x" }, "b"), text("Which school did you go to?")]));
  ok(/people search did not run/.test(a.reply) && !/failed/.test(a.reply), a.reply);
});

Deno.test("NR-10 whitespace-only input is missing (N10); labels read as actions (N11)", async () => {
  runs.length = 0;
  const r = await run([tool("find_people", ["school"])], scripted([use("find_people", { school: "   " }, "a"), text("Found none.")]));
  eq(runs, [], "a whitespace school never runs the search");
  ok(r.reply.startsWith(LINE), r.reply);
  const f = await run([tool("create_file", ["kind"])], scripted([use("create_file", {}, "a"), use("create_file", {}, "b"), text("Here is your plan.")]), "make me a plan file");
  ok(f.reply.startsWith("The file creation did not run this time"), f.reply);
  for (const [name, label] of Object.entries(LABELS)) ok(/\b(?:search|check|lookup|read|save|update|creation|build|export|drafting|attachment|research|comparison|scoring|setup|stop|switch|recall|removal|confirmation|correction|brief)\b/.test(label), `${name}: "The ${label} did not run" does not read as an action`);
});
