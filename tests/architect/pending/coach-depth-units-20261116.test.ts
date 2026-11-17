// The 10/10 rubric's gap #2 (2026-11-16; evals/mirror/instinct-wa-batch1/), at $0. Scope (owner, 2026-11-16): mass applying, so
// the job-search, apply, batch and application-status tools. Architect direction (review rv3): contracts are attached
// structurally, to the tool whose result the reply reports, in that tool's run note, only when the brain calls it; nothing reads
// the person's message to pick one.
//   CU-3  every contracted tool's result carries its contract in its run note, after the tool's own note; other tools are
//         untouched; each contract has its items and the common items, names no person, school or employer
//   CU-4  through the real brain turn: a call to check_posting_open brings the contract back in its result; a message alone
//         (no call) never puts a contract in the prompt, whatever it says
//   CU-5  one person's day: the prompt's date, a deadline's days left and the apply queue's daily-limit day agree for a known
//         zone; an unknown zone keeps the daily limit on UTC as before (architect ruling, review rv4)
//   Review rv4 (architect ruling 2026-11-17: one contract system, chosen by the tool's result):
//   CU-6  a contract is chosen by the tool's result: none when the open check is not_readable or unknown, or the call was
//         refused or threw; a closed posting gets the closed contract, never "prepare it"
//   CU-7  the search contract follows RESPONSE-RULES 3.1: more than one posting goes in a File, never a raw link list
//   CU-9  (rv5, probe rv5-cd/probes/c5_search.ts) one search turn's system prompt and search contract never contradict:
//         both follow RESPONSE-RULES 3.1, neither asks for each posting with its link on its own line
//   CU-10 (rv5, probe rv5-cd/probes/c5_queue.ts) an apply contract that points at HOW APPROVAL WORKS comes with that block in
//         the same turn's prompt, and the two say the same thing about the card
//   CU-8  trunk's message-read contracts are gone from the prompt ("THIS REPLY MUST"); the pipeline's checks come from the
//         contracts the tools attached (draft and requirements migrated), plus answer_first
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/coach-depth-units-20261116.test.ts
import assertNode from "node:assert/strict";
import * as Contracts from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { contractFor, CORE, contractNote, pipelineContracts, TASK_CONTRACTS, TOOL_CONTRACTS, type TaskIntent, withContracts } from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { runAgentTurn } from "../../../supabase/functions/_shared/agent/loop.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { agentTurn, localDay } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { dayStart } from "../../../supabase/functions/_shared/career_apply_want.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-16T15:00:00Z");
const recheck = (deadline = "2026-12-06") => async (url: string) => ({ state: "open", board: "Workday", url, checked_at: "", deadline, deadline_text: null });

Deno.test("CU-3 a contracted tool's result carries its contract in its run note; nothing else is touched; no message reader", async () => {
  ok(!("contractOf" in Contracts), "no contract is read from the person's message any more");
  eq(Object.keys(TASK_CONTRACTS).sort(), [...new Set(Object.values(TOOL_CONTRACTS).flat())].sort(), "every contract is attached to a tool, and only those");
  const plain = { name: "plain_tool", effect: "read" as const, description: "d", input_schema: { type: "object" as const, properties: {}, required: [] }, run: async () => ({ note: "own" }) };
  const tools = withContracts([...careerTools({ postings: async () => [], postingRecheck: recheck() } as any), plain]);
  const check = tools.find((t) => t.name === "check_posting_open")!;
  const out: any = await check.run({ url: "https://x.wd5.myworkdayjobs.com/j/1" }, { userId: "u", threadId: "t", now: NOW, state: {} } as any);
  ok(out.note.startsWith("Checked live on Workday just now") && out.note.endsWith(contractNote("posting_check")), out.note);
  eq(await tools.find((t) => t.name === "plain_tool")!.run({}, {} as any), { note: "own" }, "a tool with no contract is untouched");
  for (const [k, c] of Object.entries(TASK_CONTRACTS)) {
    const note = contractNote(k as TaskIntent);
    for (const item of c.items) ok(note.includes(item), `${k}: ${item}`);
    for (const core of c.core) ok(note.includes(CORE[core]), `${k}: ${core}`);
    ok(!/\b(?:Sam|Rivera|Lakeshore|PayPal|Pixelforge|Waypoint|Rallyup|Harbor|Crestline|Mindgrove|Elmstead|Ondo|Citadel|Google|NVIDIA|Chicago)\b/.test(note), `${k} names the benchmark`);
  }
  ok(/HOW APPROVAL WORKS/.test(contractNote("apply")) && /never an order, a split or a change it does not report/.test(contractNote("tailor")));
});

Deno.test("CU-4 through the brain turn: the contract comes back with the tool's result; a message alone never adds one", async () => {
  const seen: any[] = [];
  const model = async (p: any) => {
    seen.push(structuredClone(p));
    return seen.length === 1 ? { content: [{ type: "tool_use", id: "t1", name: "check_posting_open", input: { url: "https://x.wd5.myworkdayjobs.com/j/1" } }], stop_reason: "tool_use" } : { content: [{ type: "text", text: "Yes, it is open." }], stop_reason: "end_turn" };
  };
  await agentTurn({ message: "is that workday posting still open? https://x.wd5.myworkdayjobs.com/j/1", history: [], stores: { profile: null }, userId: "u-cu4", threadId: "th", now: NOW, model, postingRecheck: recheck() } as any);
  ok(!/TASK CONTRACT/.test(String(seen[0].system)), "no contract in the prompt before any call");
  ok(!/THIS REPLY MUST/.test(String(seen[0].system)), "no message-read contract (reply_pipeline contractsFor) in the prompt either");
  const result = seen[1].messages.at(-1).content.find((b: any) => b.type === "tool_result");
  ok(String(result.content).includes("TASK CONTRACT FOR YOUR REPLY ABOUT THIS RESULT (whether a posting is open)"), String(result.content).slice(0, 300));
  for (const m of ["is the office still open on weekends?", "is the deadline still open for the stripe role", "apply to all 25 of those", "list my applications", "write me a referral ask for stripe", "what do i need to apply to the paypal internship", "draft a note to my recruiter"]) {
    const s: any[] = [];
    await agentTurn({ message: m, history: [], stores: { profile: null }, userId: "u-cu4b", threadId: "th", now: NOW, model: async (p: any) => { s.push(p); return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; } } as any);
    ok(!/TASK CONTRACT/.test(String(s[0].system)), `${m}: a contract read from the message`);
    ok(!/THIS REPLY MUST/.test(String(s[0].system)), `${m}: trunk's message-read contract (contractsFor) in the prompt`);
  }
});

Deno.test("CU-5 the prompt's day, the days left and the queue's daily-limit day are one person's day in any zone", async () => {
  const now = Date.parse("2026-11-17T02:30:00Z");
  for (const tz of [undefined, null, "", "America/Los_Angeles", "Pacific/Kiritimati", "Not/AZone", "Asia/Kolkata", "America/New_York"]) {
    const t = careerTools({ postings: async () => [], tz, postingRecheck: recheck() } as any).find((x) => x.name === "check_posting_open")!;
    const r: any = await t.run({ url: "https://x.wd5.myworkdayjobs.com/j/1" }, { userId: "u", threadId: "t", now, state: {} } as any);
    const day = localDay(now, tz as any);
    ok(r.note.includes(`from today (${day})`), `${JSON.stringify(tz)}: prompt ${day} vs ${r.note}`);
    // A known zone: the queue's day is the prompt's day.
    if (typeof tz !== "string" || !tz || tz === "Not/AZone") continue;
    const start = dayStart(now, tz as any);
    ok(Date.parse(start) <= now && localDay(Date.parse(start), tz as any) === day && localDay(Date.parse(start) - 1000, tz as any) !== day, `${JSON.stringify(tz)}: queue day starts ${start}, prompt day ${day}`);
  }
  // Architect ruling (review rv4): with no zone known, the daily limit falls back as before, to UTC's day; it never silently
  // switches to New York.
  for (const tz of [undefined, null, "", "Not/AZone"]) eq(dayStart(now, tz as any), "2026-11-17T00:00:00.000Z", JSON.stringify(tz));
});

const ctx0 = () => ({ userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: "is it open", added: [] } }) as any;
Deno.test("CU-6 the contract follows the tool's result: none for not_readable, unknown, a refused or a failed call; closed is not 'prepare it'", async () => {
  // rv4-cd/probes/c_note.ts: a not_readable or unknown check carried "First sentence: open or closed ... prepare it".
  for (const st of [{ state: "not_readable", host: "jobs.example.com" }, { state: "unknown", board: "greenhouse" }]) {
    const t = withContracts(careerTools({ postings: async () => [], postingRecheck: async () => st } as any)).find((x) => x.name === "check_posting_open")!;
    const c = ctx0();
    const out: any = await t.run({ url: "https://jobs.example.com/1" }, c);
    ok(!/TASK CONTRACT/.test(out.note) && !/prepare it/.test(out.note), `${st.state}: ${out.note}`);
    eq(c.turn.contracts ?? [], [], `${st.state}: nothing recorded for the pipeline`);
  }
  const closed = withContracts(careerTools({ postings: async () => [], postingRecheck: async (url: string) => ({ state: "closed", board: "Greenhouse", url, checked_at: "" }) } as any)).find((x) => x.name === "check_posting_open")!;
  const cc = ctx0();
  const out: any = await closed.run({ url: "https://boards.greenhouse.io/x/jobs/1" }, cc);
  ok(out.note.endsWith(contractNote("posting_closed")) && !/prepare it for their approval/.test(out.note), out.note);
  eq(cc.turn.contracts, ["posting_closed"]);
  for (const [tool, r] of [["inspect_apply_flow", { status: "not_readable" }], ["search_jobs", { error: "provider down" }], ["read_application_mail", { status: "not_connected" }], ["queue_applications", { ok: false }]] as const) eq(contractFor(tool, r), null, tool);
  eq(contractFor("inspect_apply_flow", { status: "ok" }), "apply_requirements");
  // Through the loop: a call refused for a missing input never runs, and one that throws returns nothing: neither carries one.
  const seen: string[] = [];
  const thrower = withContracts([{ name: "search_jobs", effect: "read", description: "d", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, run: async () => { throw new Error("provider 500"); } }] as any);
  const steps = [[{ type: "tool_use", id: "a", name: "search_jobs", input: {} }], [{ type: "tool_use", id: "b", name: "search_jobs", input: { query: "analyst" } }], [{ type: "text", text: "ok" }]];
  let i = 0;
  const c2: any = { userId: "u", threadId: "t", now: NOW, state: {} };
  await runAgentTurn({ system: "s", history: [], message: "find analyst roles", tools: thrower, ctx: c2, model: async (p: any) => { const last = p.messages.at(-1); if (Array.isArray(last?.content)) for (const b of last.content) if (b.type === "tool_result") seen.push(String(b.content)); const c = steps[Math.min(i++, steps.length - 1)]; return { content: c, stop_reason: c[0].type === "tool_use" ? "tool_use" : "end_turn" }; } } as any);
  ok(seen.length >= 2, String(seen.length));
  for (const r of seen) ok(!/TASK CONTRACT/.test(r), r.slice(0, 200));
  eq(c2.turn.contracts ?? [], []);
});

Deno.test("CU-7 the search contract follows RESPONSE-RULES 3.1: more than one posting goes in a File, never a raw link list", () => {
  const n = contractNote("search");
  ok(!/Each posting on its own line/.test(n), "a line per posting with its link is a raw link list in chat");
  ok(/never a list of raw links in chat \(RESPONSE-RULES 3\.1\)/.test(n) && /go in a File \(create_file\)/.test(n), n);
});

Deno.test("CU-8 one contract system: the pipeline's checks come from the contracts tools attached, plus answer_first", () => {
  eq(pipelineContracts(undefined).map((c) => c.id), ["answer_first"]);
  eq(pipelineContracts(["search"]).map((c) => c.id), ["answer_first"]);
  eq(pipelineContracts(["apply_requirements", "draft", "apply_requirements"]).map((c) => c.id), ["answer_first", "requirements", "draft"]);
  // The two contracts that existed only in trunk's message reader are tool-attached now.
  ok(TOOL_CONTRACTS.inspect_apply_flow.includes("apply_requirements") && TASK_CONTRACTS.apply_requirements.checks?.includes("requirements"));
  ok(TOOL_CONTRACTS.draft_followup.includes("draft") && /not sent/.test(contractNote("draft")) && /referral itself/.test(contractNote("draft")));
});

const searchTurn = async (tool: string, input: unknown, extra: Record<string, unknown> = {}) => {
  const seen: any[] = []; let i = 0;
  const steps = [[{ type: "tool_use", id: "a", name: tool, input }], [{ type: "text", text: "ok" }]];
  const P = (n: number, co: string) => ({ job_id: `j${n}`, company: co, title: "Data Analyst Intern", location: "Chicago, IL", url: `https://boards.greenhouse.io/${co.toLowerCase()}/jobs/${1000 + n}`, first_seen_at: "2026-11-10", description: "SQL, Python" });
  await agentTurn({ message: "find me data analyst internships in chicago", history: [], stores: { profile: null }, userId: "u-cu9", threadId: "th", now: NOW, postings: async () => [P(1, "Acme"), P(2, "Brightloop"), P(3, "Citadel")], ...extra,
    model: async (p: any) => { seen.push(structuredClone(p)); const c = steps[Math.min(i++, steps.length - 1)]; return { content: c, stop_reason: c[0].type === "tool_use" ? "tool_use" : "end_turn" }; } } as any);
  const tr = seen[1].messages.at(-1).content.find((b: any) => b.type === "tool_result");
  return { system: String(seen[1].system), result: String(tr?.content ?? "") };
};
Deno.test("CU-9 one search turn: the system prompt and the search contract give one rule for postings and links (RESPONSE-RULES 3.1)", async () => {
  const { system, result } = await searchTurn("search_jobs", { query: "data analyst intern chicago" });
  ok(result.includes(contractNote("search").slice(0, 80)), "the search contract came back with the result");
  const both = `${system}\n${result}`;
  ok(!/Name each with its\s+link/.test(both) && !/Each posting on its own line/.test(both), "a rule that lists every posting with its link on its own line");
  for (const [where, t] of [["system prompt", system], ["contract", result]]) ok(/never a list of raw\s+links in chat \(RESPONSE-RULES 3\.1\)/.test(t) && /go in a File \(create_file\)/.test(t), `${where} does not state RESPONSE-RULES 3.1`);
});
Deno.test("CU-10 an apply contract comes with HOW APPROVAL WORKS in the same turn's prompt, saying the same about the card", async () => {
  const { memoryWantStore } = await import("../../../supabase/functions/_shared/career_apply_want.ts");
  const { approvalRulesText } = await import("../../../supabase/functions/_shared/agent/approval_rules.ts");
  const { system, result } = await searchTurn("queue_applications", { postings: [{ url: "https://job-boards.greenhouse.io/acme/jobs/4000001", company: "Acme", title: "Data Analyst 1" }] }, { wants: memoryWantStore() });
  ok(result.includes(contractNote("apply").slice(0, 80)), result.slice(0, 300));
  ok(/HOW APPROVAL WORKS/.test(contractNote("apply")) && system.includes(approvalRulesText()), "the contract points at HOW APPROVAL WORKS, so the prompt carries it");
  ok(/one card/.test(contractNote("apply")) && /one card listing every prepared application/.test(approvalRulesText()), "both: one card, one yes");
});
