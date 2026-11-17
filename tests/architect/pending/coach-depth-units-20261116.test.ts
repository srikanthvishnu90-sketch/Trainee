// The 10/10 rubric's gap #2 (2026-11-16; evals/mirror/instinct-wa-batch1/), at $0. Scope (owner, 2026-11-16): mass applying, so
// the job-search, apply, batch and application-status tools. Architect direction (review rv3): contracts are attached
// structurally, to the tool whose result the reply reports, in that tool's run note, only when the brain calls it; nothing reads
// the person's message to pick one.
//   CU-3  every contracted tool's result carries its contract in its run note, after the tool's own note; other tools are
//         untouched; each contract has its items and the common items, names no person, school or employer
//   CU-4  through the real brain turn: a call to check_posting_open brings the contract back in its result; a message alone
//         (no call) never puts a contract in the prompt, whatever it says
//   CU-5  one person's day: the prompt's date, a deadline's days left and the apply queue's daily-limit day agree for any zone
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/coach-depth-units-20261116.test.ts
import assertNode from "node:assert/strict";
import * as Contracts from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { CORE, contractNote, TASK_CONTRACTS, TOOL_CONTRACTS, type TaskIntent, withContracts } from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { careerTools } from "../../../supabase/functions/_shared/agent/career_tools.ts";
import { agentTurn, localDay } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { dayStart } from "../../../supabase/functions/_shared/career_apply_want.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-16T15:00:00Z");
const recheck = (deadline = "2026-12-06") => async (url: string) => ({ state: "open", board: "Workday", url, checked_at: "", deadline, deadline_text: null });

Deno.test("CU-3 a contracted tool's result carries its contract in its run note; nothing else is touched; no message reader", async () => {
  ok(!("contractOf" in Contracts), "no contract is read from the person's message any more");
  eq(Object.keys(TASK_CONTRACTS).sort(), [...new Set(Object.values(TOOL_CONTRACTS))].sort(), "every contract is attached to a tool, and only those");
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
  const result = seen[1].messages.at(-1).content.find((b: any) => b.type === "tool_result");
  ok(String(result.content).includes("TASK CONTRACT FOR YOUR REPLY ABOUT THIS RESULT (whether a posting is open)"), String(result.content).slice(0, 300));
  for (const m of ["is the office still open on weekends?", "is the deadline still open for the stripe role", "apply to all 25 of those", "list my applications"]) {
    const s: any[] = [];
    await agentTurn({ message: m, history: [], stores: { profile: null }, userId: "u-cu4b", threadId: "th", now: NOW, model: async (p: any) => { s.push(p); return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; } } as any);
    ok(!/TASK CONTRACT/.test(String(s[0].system)), `${m}: a contract read from the message`);
  }
});

Deno.test("CU-5 the prompt's day, the days left and the queue's daily-limit day are one person's day in any zone", async () => {
  const now = Date.parse("2026-11-17T02:30:00Z");
  for (const tz of [undefined, null, "", "America/Los_Angeles", "Pacific/Kiritimati", "Not/AZone", "Asia/Kolkata"]) {
    const t = careerTools({ postings: async () => [], tz, postingRecheck: recheck() } as any).find((x) => x.name === "check_posting_open")!;
    const r: any = await t.run({ url: "https://x.wd5.myworkdayjobs.com/j/1" }, { userId: "u", threadId: "t", now, state: {} } as any);
    const day = localDay(now, tz as any);
    ok(r.note.includes(`from today (${day})`), `${JSON.stringify(tz)}: prompt ${day} vs ${r.note}`);
    const start = dayStart(now, tz as any);
    ok(Date.parse(start) <= now && localDay(Date.parse(start), tz as any) === day && localDay(Date.parse(start) - 1000, tz as any) !== day, `${JSON.stringify(tz)}: queue day starts ${start}, prompt day ${day}`);
  }
  // Review rv3: at 21:30 in New York on November 16, with no zone known, the daily limit is still November 16's (it was UTC's 17th).
  eq(dayStart(now, undefined), "2026-11-16T05:00:00.000Z");
});
