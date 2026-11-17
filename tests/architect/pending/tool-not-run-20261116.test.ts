// Gap #5 of the 10/10 rubric (2026-11-16; evals/mirror/instinct-wa-batch1/, live-12 C1 and C19): a tool call missing a required
// input is refused before it runs, the brain gets ONE more try with the refusal naming each missing input from the tool's own
// schema, and if the call never runs the reply says so: it never reports a result from it (D-024). Live-12 C19: find_people was
// refused with "missing required input: school, employers" and the delivered reply said "The search found no public page ...".
// $0, a scripted model through the real agent loop (runAgentTurn).
//   NR-1  the first refusal names each missing input with its schema description and allows one more call; the retry with the
//         inputs filled runs the tool
//   NR-2  a second refusal ends that tool for the turn: a third call is refused and the tool never runs
//   NR-3  C19: "found nobody" after a refused people search is impossible: the review asks once, then code removes the sentence
//         and the reply says the search did not run
//   NR-4  a refused save (C1's remember_instruction) is said not to have run, even when the reply talks about something else
//   NR-5  a reply that already says the call did not run is left as the model wrote it
//   deno test -A --no-check tests/architect/pending/tool-not-run-20261116.test.ts
import assertNode from "node:assert/strict";
import { runAgentTurn, type ToolSpec } from "../../../supabase/functions/_shared/agent/loop.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const runs: string[] = [];
const people: ToolSpec = {
  name: "find_people", effect: "read",
  description: "Public people search by a shared school at employers.",
  input_schema: { type: "object", properties: { school: { type: "string", description: "The school, as the person named it" }, employers: { type: "array", items: { type: "string" }, description: "Employers to look at, as the person named them" }, count: { type: "integer", description: "How many" } }, required: ["school", "employers"] },
  run: async (i) => { runs.push(`find_people:${JSON.stringify(i)}`); return { status: "ok", leads: [{ name: "Lead One", employer: "Google", verified: false }] }; },
};
const remember: ToolSpec = {
  name: "remember_instruction", effect: "write_own",
  description: "Keep something that must always hold.",
  input_schema: { type: "object", properties: { instruction: { type: "string", description: "The instruction, short and plain" }, quote: { type: "string", description: "Their exact words from this message" } }, required: ["instruction", "quote"] },
  run: async () => { runs.push("remember_instruction"); return { status: "kept" }; },
};
// A scripted model: each answer in turn; the last one repeats. Records every payload it was given.
function scripted(steps: any[][]) {
  const payloads: any[] = [];
  let i = 0;
  const m = async (p: any) => { payloads.push(structuredClone(p)); const c = steps[Math.min(i++, steps.length - 1)]; return { content: c, stop_reason: c.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn" }; };
  return Object.assign(m, { payloads });
}
const text = (t: string) => [{ type: "text", text: t }];
const use = (name: string, input: unknown, id: string) => [{ type: "tool_use", id, name, input }];
const C19 = "find me 3 lakeshore alumni working at google or trading firms i could reach out to, just research don't message anyone";
const run = (tools: ToolSpec[], m: any, message = C19) => runAgentTurn({ system: "s", history: [], message, tools, model: m, ctx: { userId: "u", threadId: "t", now: 0, state: {} } });
const resultsOf = (p: any) => p.messages[p.messages.length - 1].content.filter((b: any) => b.type === "tool_result");

Deno.test("NR-1 the first refusal names each missing input from the schema and allows one more call; the retry runs", async () => {
  runs.length = 0;
  const m = scripted([use("find_people", { count: 3 }, "a"), use("find_people", { school: "Lakeshore University", employers: ["Google"], count: 3 }, "b"), text("One public lead, not verified: Lead One at Google. Nobody was contacted.")]);
  const r = await run([people], m);
  const first = resultsOf(m.payloads[1])[0];
  ok(first.is_error, "refused");
  const said = String(first.content);
  ok(/school \(The school, as the person named it\)/.test(said) && /employers \(Employers to look at/.test(said), `each missing input with its description: ${said}`);
  ok(/once more/.test(said) && /did not run/.test(said), `one more try, and it did not run: ${said}`);
  eq(runs, ['find_people:{"school":"Lakeshore University","employers":["Google"],"count":3}'], "the retry with the inputs ran");
  eq(r.tool_calls.map((c) => [c.name, c.ok]), [["find_people", false], ["find_people", true]]);
  ok(/missing required input: school, employers/.test(r.tool_calls[0].error ?? ""), r.tool_calls[0].error);
  ok(!/did not run/.test(r.reply), `a call that ran needs no not-run line: ${r.reply}`);
});

Deno.test("NR-2 a second refusal ends that tool for the turn: a third call is refused and never runs", async () => {
  runs.length = 0;
  const m = scripted([use("find_people", { count: 3 }, "a"), use("find_people", { count: 3 }, "b"), use("find_people", { school: "Lakeshore University", employers: ["Google"] }, "c"),
    text("The people search did not run because it needed the school and the employers. Which employers should I look at?")]);
  const r = await run([people], m);
  eq(runs, [], "the tool never ran");
  ok(/second try/.test(String(resultsOf(m.payloads[2])[0].content)), "the second refusal says it was the last");
  ok(/will not run again/.test(String(resultsOf(m.payloads[3])[0].content)), `the third call is refused: ${resultsOf(m.payloads[3])[0].content}`);
  eq(r.tool_calls.map((c) => c.ok), [false, false, false]);
  ok(/did not run/.test(r.reply), r.reply);
});

Deno.test("NR-3 C19: after a refused people search, 'found nobody' is impossible; the reply says the search did not run", async () => {
  runs.length = 0;
  const lie = "The search found no public page listing Lakeshore University alumni at Google, Citadel or Jane Street. Try your school's alumni directory and its career office. Nobody was contacted.";
  const m = scripted([use("find_people", { count: 3 }, "a"), use("find_people", { count: 3 }, "b"), text(lie)]);
  const r = await run([people], m);
  eq(runs, [], "the search never ran");
  ok(m.payloads.some((p) => /did not run this turn/.test(String(p.system))), "the brain was asked once to fix it");
  ok(!/found no public page/.test(r.reply), `a result from a search that never ran: ${r.reply}`);
  ok(/people search did not run/.test(r.reply), `the reply says it did not run: ${r.reply}`);
  ok(/alumni directory/.test(r.reply) && /Nobody was contacted/.test(r.reply), `the rest of the reply stands: ${r.reply}`);
});

Deno.test("NR-4 C1: a refused save is said not to have run, even when the reply is about something else; NR-5 one that says so stands", async () => {
  runs.length = 0;
  const m = scripted([use("remember_instruction", { instruction: "Never use the 3.9 GPA" }, "a"), text("Start with the PayPal internship: it closes December 6. Want me to prepare it for your approval?")]);
  const r = await run([remember], m, "the 3.9 gpa is outdated, don't reuse it. what should i do to land a swe internship?");
  eq(runs, []);
  ok(/save of that instruction did not run/.test(r.reply) && /PayPal internship/.test(r.reply), r.reply);
  // NR-5: a reply that already says the call did not run stands as written, with no review.
  {
    runs.length = 0;
    const said = "The people search didn't run: it needs the school. Which school should I search for?";
    const m2 = scripted([use("find_people", { employers: ["Google"] }, "a"), text(said)]);
    const r2 = await run([people], m2);
    eq(r2.reply, said);
    eq(m2.payloads.length, 2, "no review was needed");
  }
});
