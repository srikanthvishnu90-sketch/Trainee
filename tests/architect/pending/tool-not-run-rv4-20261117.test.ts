// Gap #5, review rv4 of ag/cd-a-not-run (2026-11-17; probes rv4-cd/probes a_probe.ts, a_leak.ts, a_condense.ts). $0, scripted model.
//   NR-11 (A1) code's not-run line survives career_brain's length pass: the condenser's rewrite drops it, code puts it back first
//   NR-12 (A2) the line never echoes raw call arguments: only a whitelisted subject (company, employer, firm, role, title, school),
//              never an id, a draft body, a note or a recipient, and the whole line passes the leak guard
//   NR-13 the one retry is per CALL, not per tool: a call about something else after a call refused twice still runs
//   NR-15 (rv5, probe rv5-cd/probes/a5_retry.ts) a refused call is resolved when the same tool later ran with the inputs it lacked:
//         order, case, a string for a list, a count, or firms named for "trading firms" never leave a false not-run line
//   NR-16 (rv6, probe rv6-cd/probes/a6_other_subject.ts, D-097) a later run about another subject resolves nothing: the refused
//         call's own inputs must hold in the later call (a superset list; counts may differ; a category met by named firms)
//   NR-14 the not-run labels reach the turn's stored meta (body.meta via agentMeta) through the real handler (Postgres 16)
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/tool-not-run-rv4-20261117.test.ts
import assertNode from "node:assert/strict";
import { runAgentTurn, type ToolSpec } from "../../../supabase/functions/_shared/agent/loop.ts";
import { leakedWords } from "../../../supabase/functions/_shared/agent/reply_guards.ts";
import { notRunLine, withNotRun } from "../../../supabase/functions/_shared/agent/not_run.ts";
import { agentTurn, shortenedOk } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { canRun } from "../helpers/response_world.ts";
import { runConversation, type Step } from "../helpers/mirror_process.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const runs: string[] = [];
const tool = (name: string, req: string[], props: string[] = req): ToolSpec => ({
  name, effect: "read", description: name,
  input_schema: { type: "object", properties: Object.fromEntries([...new Set([...req, ...props])].map((k) => [k, { type: "string", description: k }])), required: req },
  run: async (i) => { runs.push(`${name}:${JSON.stringify(i)}`); return { status: "ok", found: 1 }; },
});
function scripted(steps: any[][]) {
  const payloads: any[] = [];
  let i = 0;
  const m = async (p: any) => { payloads.push(structuredClone(p)); const c = steps[Math.min(i++, steps.length - 1)]; return { content: c, stop_reason: c.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn" }; };
  return Object.assign(m, { payloads });
}
const text = (t: string) => [{ type: "text", text: t }];
const use = (name: string, input: unknown, id: string) => [{ type: "tool_use", id, name, input }];
const run = (tools: ToolSpec[], m: any, message = "hi") => runAgentTurn({ system: "s", history: [], message, tools, model: m, ctx: { userId: "u", threadId: "t", now: 0, state: {} } });
const LEAK = { tools: [] as string[], typed: "", postings: new Map() };
const LINE = "The people search did not run this time, so there is no result from it.";

// a_condense.ts: the rewrite the condenser returns has no not-run line, and shortenedOk accepts it.
const BODY = "Here is how to reach Lakeshore alumni at Google without a list from me. Start with your school's alumni directory and filter by employer, then look at the Lakeshore alumni group's posts for anyone who mentions Google teams you care about. Write a short note that names the team and one specific question about their work, and ask for fifteen minutes rather than a referral. Career fairs on campus are another route because Google recruiters often bring alumni with them, and the career office's alumni evenings are worth a look as well. Nobody was contacted and nothing was sent.";
const SHORT = "Reach Lakeshore alumni at Google through your school's alumni directory, filtered by employer, and the alumni group's posts. Send a short note naming the team and one question, asking for fifteen minutes, not a referral. Campus career fairs help too. Nobody was contacted and nothing was sent.";

Deno.test("NR-11 (A1) the not-run line survives career_brain's length pass and every later rewrite", async () => {
  ok(shortenedOk(`${LINE}\n\n${BODY}`, SHORT, Number.POSITIVE_INFINITY), "the probe's premise: the condenser check alone accepts a rewrite without the line");
  const ps: any[] = [];
  let i = 0;
  // interview_brief is offered on every brain turn (it needs a company); refused twice, it never ran.
  const steps = [use("interview_brief", {}, "a"), use("interview_brief", {}, "b"), text(BODY)];
  const BRIEF = "The interview brief build did not run this time, so there is no result from it.";
  const model = async (p: any) => { ps.push(p); const c = i < steps.length ? steps[i++] : text(SHORT); return { content: c, stop_reason: c.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn" }; };
  const r: any = await agentTurn({ message: "how do i reach lakeshore alumni at google? just advice", history: [], stores: { profile: null }, userId: "u", threadId: "th", now: Date.parse("2026-11-17T15:00:00Z"), model } as any);
  ok(r.reply.startsWith(`${BRIEF}\n\n`), `the line leads the reply after the length pass: ${r.reply}`);
  eq(r.reply.split(BRIEF).length, 2, "once");
  ok(r.shorten?.ran && r.shorten.outcome !== "rejected" && r.reply === `${BRIEF}\n\n${SHORT}`, `the length pass ran on the reply without the line and its rewrite follows it: ${JSON.stringify(r.shorten)} ${r.reply}`);
  ok(!String(ps.at(-1).messages?.at(-1)?.content ?? JSON.stringify(ps.at(-1))).includes("did not run this time, so there is no result"), "the condenser is never handed code's line to rewrite");
});
Deno.test("NR-11b (A1) withNotRun puts code's lines back first, once, and leaves a text that already leads with them as it is", () => {
  eq(withNotRun(`${LINE}\n\n${BODY}`, [LINE]), `${LINE}\n\n${BODY}`);
  eq(withNotRun(SHORT, [LINE]), `${LINE}\n\n${SHORT}`);
  eq(withNotRun(`${SHORT} ${LINE}`, [LINE]), `${LINE}\n\n${SHORT}`, "moved to the end: put back first");
  eq(withNotRun(`${LINE} ${SHORT}\n\n${LINE}`, [LINE]), `${LINE}\n\n${SHORT}`, "twice: once");
  eq(withNotRun(SHORT, []), SHORT, "no lines: unchanged");
});

Deno.test("NR-12 (A2) the line echoes only a whitelisted subject, never an id, a draft body, a note or a recipient (a_probe P1, P2, P5; a_leak)", async () => {
  const cpf = tool("correct_profile_fact", ["id", "text"]);
  for (const id of ["f_9c2d41aa-77e1-4b0e-a1", "3f2b9c1e-8a7d-4e21-9b0c-1d2e3f4a5b6c", "F-002"]) {
    const r = await run([cpf], scripted([use("correct_profile_fact", { id }, "a"), use("correct_profile_fact", { id }, "b"), text("What should your GPA read instead?")]), "my gpa is wrong");
    ok(r.reply.startsWith("The correction to that fact did not run this time, so there is no result from it."), r.reply);
    ok(!r.reply.includes(id) && !r.codeLines!.some((l) => l.includes(id)), `id ${id} echoed: ${r.reply}`);
  }
  const body = "Hi Jane, thanks so much for the chat yesterday about the analyst role at Ramp";
  const df = tool("draft_followup", ["kind", "body"], ["kind", "recipient", "body", "tone"]);
  const d = await run([df], scripted([use("draft_followup", { body, recipient: "Jane Park" }, "a"), use("draft_followup", { body, recipient: "Jane Park" }, "b"), text("Is this a thank-you note or a follow-up?")]), "draft a note to jane");
  ok(d.reply.startsWith("The message drafting did not run this time, so there is no result from it."), d.reply);
  ok(!d.reply.includes("Hi Jane") && !d.reply.includes("Jane Park"), d.reply);
  const q = tool("queue_applications", ["postings"], ["postings", "note"]);
  const p5 = await run([q], scripted([use("queue_applications", { postings: [], note: "job_7f3e2a91 at Ramp" }, "a"), use("queue_applications", { postings: [""], note: "job_7f3e2a91 at Ramp" }, "b"), text("Which roles should I queue?")]));
  ok(p5.reply.startsWith("The apply queue update did not run this time"), p5.reply);
  ok(!/job_7f3e2a91/.test(p5.reply), p5.reply);
  // A subject is still named when it is one: a company, an employer, a role.
  const fp = tool("find_people", ["school", "employers"], ["school", "employers", "role"]);
  const p3 = await run([fp], scripted([use("find_people", { employers: "Jane Street", role: "trader" }, "a"), use("find_people", { employers: "Jane Street", role: "trader" }, "b"), text("Which school?")]));
  ok(p3.reply.startsWith("The people search for Jane Street and trader did not run this time"), p3.reply);
  // A subject-named argument that holds an id, a link or a long free text is left out; every line passes the leak guard.
  for (const company of ["job_7f3e2a91", "f_9c2d41aa-77e1", "https://boards.greenhouse.io/ramp/jobs/1", "Ramp, and also please remember that my GPA is 3.9 and I want remote roles only"]) {
    const line = notRunLine("research_company", false, [company]);
    eq(line, "The company research did not run this time, so there is no result from it.", company);
  }
  for (const r of [p3, p5, d]) for (const l of r.codeLines ?? []) eq(leakedWords(l, LEAK), [], l);
});

Deno.test("NR-13 the one retry is per call, not per tool: another call to the same tool keeps its own retry and runs", async () => {
  runs.length = 0;
  const fp = tool("find_people", ["school", "employers"]);
  const m = scripted([
    use("find_people", { employers: "Google" }, "a"), use("find_people", { employers: "Google" }, "b"), // that call: refused twice
    use("find_people", { employers: "Meta" }, "c"), // another call: its own first refusal, retry allowed
    use("find_people", { school: "Lakeshore", employers: "Meta" }, "d"), // its retry runs
    text("Found 1 Lakeshore alum at Meta."),
  ]);
  const r = await run([fp], m, "lakeshore alumni at google and at meta");
  const res = (k: number) => JSON.parse(String(m.payloads[k].messages.at(-1).content.find((b: any) => b.type === "tool_result").content));
  eq([res(1).retry_allowed, res(2).retry_allowed, res(3).retry_allowed], [true, false, true], "the Meta call is not the Google call's third try");
  eq(runs, ['find_people:{"school":"Lakeshore","employers":"Meta"}'], "the other call ran");
  // Architect ruling (review rv6, D-097): a run about Meta does not resolve the refused Google calls.
  ok(r.reply.startsWith("The people search for Google did not run this time") && !/for Meta did not run/.test(r.reply), r.reply);
});

Deno.test({ name: "NR-14 the not-run labels reach the turn's stored meta through the real handler", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("needs Postgres 16 in CI");
  const script: Record<string, Step[]> = { C19: [{ tool: "find_people", input: { count: 3 } }, { tool: "find_people", input: { count: 3 } }, { text: "Which school should I search for?" }] };
  const { seen, world, person, close } = await runConversation(script, { only: ["C19"] });
  try {
    ok(/^The people search did not run this time/.test(seen.C19.reply), seen.C19.reply);
    const meta = JSON.parse(await world.pg.sql(`select coalesce((select meta::text from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${person.id}' and m.role = 'assistant' and m.content like 'The people search did not run%' order by m.id desc limit 1), 'null')`));
    eq(meta?.not_run, [{ label: "people search", failed: false }], JSON.stringify(meta));
  } finally { await close(); }
} });

Deno.test("NR-15 (rv5) a refused call is resolved by a later run of the same tool with the inputs it lacked, never by comparing JSON", async () => {
  const seen: string[] = [];
  const fp: ToolSpec = { name: "find_people", effect: "read", description: "find_people",
    input_schema: { type: "object", properties: { school: { type: "string" }, employers: { type: "array", items: { type: "string" } }, count: { type: "integer" }, role: { type: "string" } }, required: ["school", "employers"] } as any,
    run: async (i) => { seen.push(JSON.stringify(i)); return { status: "ok", leads: [{ name: "Ana Ruiz", employer: "Google" }] }; } };
  const cases: [string, unknown, unknown][] = [
    ["order", { employers: ["Google", "Jane Street"] }, { school: "Lakeshore", employers: ["Jane Street", "Google"] }],
    ["case", { employers: ["google"] }, { school: "Lakeshore", employers: ["Google"] }],
    ["string->array", { employers: "Google" }, { school: "Lakeshore", employers: ["Google"] }],
    ["count", { employers: ["Google"], count: 3 }, { school: "Lakeshore", employers: ["Google"], count: 5 }],
    ["trading firms named", { employers: ["Google", "trading firms"] }, { school: "Lakeshore", employers: ["Google", "Jane Street", "Citadel"] }],
  ];
  for (const [label, a, b] of cases) {
    seen.length = 0;
    const r = await run([fp], scripted([use("find_people", a, "a"), use("find_people", b, "b"), text("I found Ana Ruiz, a Lakeshore alum at Google.")]), "find 3 lakeshore alumni at google or trading firms");
    eq(seen.length, 1, `${label}: the retry ran`);
    ok(!r.not_run && !/did not run|failed this time/.test(r.reply), `${label}: ${r.reply}`);
  }
  // A later run that still lacks what the refused call lacked does not resolve it (another tool, or the same input still missing).
  const other = tool("research_company", ["company"]);
  const r2 = await run([fp, other], scripted([use("find_people", { employers: ["Google"] }, "a"), use("research_company", { company: "Google" }, "c"), use("find_people", { employers: ["Google"] }, "b"), text("Google hires interns.")]));
  ok(r2.reply.startsWith("The people search for Google did not run this time"), r2.reply);
});

Deno.test("NR-16 (rv6) a later run about another subject never resolves a refused call; its own inputs must hold", async () => {
  const fp: ToolSpec = { name: "find_people", effect: "read", description: "find_people",
    input_schema: { type: "object", properties: { school: { type: "string" }, employers: { type: "string" }, role: { type: "string" }, count: { type: "integer" } }, required: ["school", "employers"] } as any,
    run: async (i: any) => ({ status: "ok", leads: [{ name: "Ana Ruiz", employer: i.employers }] }) };
  const msg = "lakeshore alumni at jane street and google";
  const a6 = await run([fp], scripted([use("find_people", { employers: "Jane Street", role: "trader" }, "a"), use("find_people", { school: "Lakeshore", employers: "Google" }, "b"), text("I found 2 Lakeshore alumni trading at Jane Street and 1 at Google.")]), msg);
  ok(a6.reply.startsWith("The people search for Jane Street and trader did not run this time"), `a6_other_subject: ${a6.reply}`);
  eq(a6.not_run, [{ label: "people search", failed: false }]);
  // The same employer but the role dropped, or a list that loses one of the refused employers: not the same call.
  const dropRole = await run([fp], scripted([use("find_people", { employers: "Jane Street", role: "trader" }, "a"), use("find_people", { school: "Lakeshore", employers: "Jane Street" }, "b"), text("Found 1.")]), msg);
  ok(/did not run this time/.test(dropRole.reply), dropRole.reply);
  const lost = await run([fp], scripted([use("find_people", { employers: ["Google", "Jane Street"] }, "a"), use("find_people", { school: "Lakeshore", employers: ["Google"] }, "b"), text("Found 1.")]), msg);
  ok(/did not run this time/.test(lost.reply), lost.reply);
  // Kept: the role kept and more employers added (a superset), and a count changed.
  const sup = await run([fp], scripted([use("find_people", { employers: "Jane Street", role: "Trader ", count: 2 }, "a"), use("find_people", { school: "Lakeshore", employers: ["jane street", "Citadel"], role: "trader", count: 5 }, "b"), text("Found 1.")]), msg);
  ok(!sup.not_run && !/did not run/.test(sup.reply), sup.reply);
  // A named employer is no category: "Google" is not met by "Meta".
  const notCat = await run([fp], scripted([use("find_people", { employers: ["Google"] }, "a"), use("find_people", { school: "Lakeshore", employers: ["Meta"] }, "b"), text("Found 1.")]), msg);
  ok(/for Google did not run this time/.test(notCat.reply), notCat.reply);
});
