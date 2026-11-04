// Provider-completion regressions. All conversations, providers and effects are local synthetic fixtures.
import { runAgentTurn, type ToolSpec } from "../../supabase/functions/_shared/agent/loop.ts";
import { callModel, fromAnthropic, newMeter } from "../../supabase/functions/_shared/model_gateway.ts";

function eq(got: unknown, expected: unknown, why = "") {
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${why}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}
function ok(value: unknown, why: string): asserts value { if (!value) throw new Error(why); }
const QUESTION = "Compare the two postings by responsibilities and schedule.";
const COMPLETE = "The first posting focuses on reporting on weekdays. The second focuses on payroll on weekends.";
const text = (reply: string, reason = "end_turn") => ({ content: [{ type: "text", text: reply }], stop_reason: reason });
const USAGE = { input_tokens: 100, output_tokens: 50 };
const cut = (reply: string) => fromAnthropic({ type: "message", content: [{ type: "text", text: reply }], stop_reason: "max_tokens", usage: USAGE });
const call = () => ({ content: [{ type: "tool_use", id: "save-fixture", name: "save_fixture", input: {} }], stop_reason: "tool_use" });
const gatewayCall = (reason: string) => fromAnthropic({ type: "message", content: [{ type: "tool_use", id: "save-fixture", name: "save_fixture", input: {} }], stop_reason: reason, usage: USAGE });
async function run(responses: any[], options: { maxSteps?: number; show?: boolean } = {}) {
  let saves = 0;
  const payloads: any[] = [];
  const tool: ToolSpec = { name: "save_fixture", effect: "write_own", description: "Synthetic save", input_schema: { type: "object", properties: {}, required: [] },
    run: async (_i, c) => { saves++; if (options.show) c.turn!.show = { intent: "SYNTHETIC_SHOW", text: "Synthetic exact preview." }; return { saved: true }; } };
  const result = await runAgentTurn({ system: "Use only the supplied synthetic posting details.", message: QUESTION, history: [], tools: [tool], maxSteps: options.maxSteps,
    ctx: { userId: "SYNTHETIC-DEPTH-OWNER", threadId: "SYNTHETIC-DEPTH-THREAD", now: 0, state: {} },
    model: async (p) => { payloads.push(structuredClone(p)); return responses[Math.min(payloads.length - 1, responses.length - 1)]; } });
  return { result, payloads, saves };
}

Deno.test("reply depth: provider token truncation cannot be labelled a complete answer", async () => {
  const { result, payloads, saves } = await run([cut("Compare the two postings by responsibilities and"), text(COMPLETE)]);
  eq(result.reply, COMPLETE); eq(result.stopped, "final"); eq(payloads.length, 2); eq(saves, 0);
  eq(payloads[1].tool_choice, { type: "none" });
  eq(payloads[1].messages, payloads[0].messages, "truncated output is not conversation evidence");
});

Deno.test("reply depth: repeated truncated output stops after one text-only repair", async () => {
  const { result, payloads } = await run([cut("Read the first posting.")]);
  eq(result.stopped, "incomplete_reply"); eq(payloads.length, 2);
  ok(result.reply !== "Read the first posting.", "a provider-declared partial response escaped as the answer");
});

Deno.test("reply depth: truncation after a completed save never repeats or denies the save", async () => {
  const { result, payloads, saves } = await run([call(), cut("The comparison is"), cut("The comparison is")]);
  eq(result.stopped, "incomplete_reply"); eq(payloads.length, 3); eq(saves, 1);
  eq(result.tool_calls.length, 1); eq(result.pending_approvals, []);
  ok(!/nothing.{0,10}saved/i.test(result.reply), "completed save was denied");
});

Deno.test("reply depth: no remaining step budget prevents a truncation repair call", async () => {
  const { result, payloads } = await run([cut("The first posting is")], { maxSteps: 1 });
  eq(result.stopped, "incomplete_reply"); eq(payloads.length, 1);
});

Deno.test("reply depth: a truncated provider response cannot execute embedded tool calls", async () => {
  const truncated = { ...call(), stop_reason: "max_tokens" };
  const { result, payloads, saves } = await run([truncated, text(COMPLETE)]);
  eq(result.reply, COMPLETE); eq(payloads.length, 2); eq(saves, 0); eq(result.tool_calls, []); eq(result.pending_approvals, []);
});

Deno.test("reply depth: a max_tokens stop remains truncated even beside a fully parsed tool call", async () => {
  const truncated = gatewayCall("max_tokens");
  eq(truncated.stop_reason, "max_tokens"); eq(truncated.content, [], "other gateway callers cannot consume even a parsed truncated call");
  const { result, payloads, saves } = await run([truncated, text(COMPLETE)]);
  eq(result.reply, COMPLETE); eq(result.stopped, "final"); eq(payloads.length, 2); eq(saves, 0);
  eq(result.tool_calls, []); eq(result.pending_approvals, []); eq(payloads[1].tool_choice, { type: "none" });
});

Deno.test("reply depth: a completed tool call still executes once", async () => {
  const { result, payloads, saves } = await run([gatewayCall("tool_use"), text(COMPLETE)]);
  eq(result.reply, COMPLETE); eq(result.stopped, "final"); eq(payloads.length, 2); eq(saves, 1);
  eq(result.tool_calls.length, 1); eq(result.tool_calls[0].ok, true);
});

Deno.test("reply depth: provider truncation leaves an already generated exact preview authoritative", async () => {
  const { result, payloads, saves } = await run([call(), cut("A partial retelling")], { show: true });
  eq(result.reply, "Synthetic exact preview."); eq(result.show?.text, "Synthetic exact preview."); eq(payloads.length, 2); eq(saves, 1);
});

Deno.test("reply depth: completed short text and explicit refusal are not truncation", async () => {
  for (const reply of [text("Read both postings."), text("I cannot submit an application without your approval.", "refusal")]) {
    const { result, payloads } = await run([reply]);
    eq(result.reply, reply.content[0].text); eq(result.stopped, "final"); eq(payloads.length, 1);
  }
});

const wireCall = (name: string, input: unknown = {}) => ({ type: "tool_use", id: name, name, input });
const wire = (reason: string, calls: any[] = [], reply: string | null = null) => ({
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: reason,
  content: [...(reply ? [{ type: "text", text: reply }] : []), ...calls], usage: { input_tokens: 100, output_tokens: 50 },
});
async function providerRun(responses: any[], show = false) {
  let saves = 0, external = 0;
  const payloads: any[] = [], health: any[] = [], meter = newMeter();
  const tools: ToolSpec[] = [
    { name: "save_fixture", effect: "write_own", description: "Synthetic save", input_schema: { type: "object", properties: {}, required: [] },
      run: async (_i, c) => { saves++; if (show) c.turn!.show = { intent: "SYNTHETIC_SHOW", text: "Synthetic exact preview." }; return { saved: true }; } },
    { name: "external_fixture", effect: "external", description: "Synthetic external effect", input_schema: { type: "object", properties: {}, required: [] },
      run: async () => { external++; return {}; } },
  ];
  const result = await runAgentTurn({ system: "Use supplied synthetic posting information only.", history: [], message: QUESTION, tools,
    ctx: { userId: "SYNTHETIC-DEPTH-OWNER", threadId: "SYNTHETIC-DEPTH-THREAD", now: 0, state: {} },
    model: async (p) => callModel({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: "synthetic-unusable-key", reasoningEffort: "low" }, p, {
      meter, health: (e) => { health.push(e); }, request: (async (_url, init) => {
        payloads.push(JSON.parse(String(init!.body)));
        return Response.json(responses[Math.min(payloads.length - 1, responses.length - 1)]);
      }) as typeof fetch,
    }),
  });
  return { result, payloads, saves, external, health, meter };
}

Deno.test("reply depth: a tool call under max_tokens is discarded and both wire calls remain metered", async () => {
  const { result, payloads, saves, health, meter } = await providerRun([
    wire("max_tokens", [wireCall("save_fixture", { note: "unfinished" })]), wire("end_turn", [], COMPLETE),
  ]);
  eq(result.reply, COMPLETE); eq(result.stopped, "final"); eq(payloads.length, 2); eq(payloads[1].tool_choice, { type: "none" });
  eq(saves, 0); eq(result.tool_calls, []); eq(result.pending_approvals, []);
  eq([meter.calls, meter.failed, meter.input_tokens, meter.output_tokens, meter.usd_micros], [2, 0, 200, 100, 70]);
  eq(health.map((e) => [e.ok, e.error_type]), [[true, null], [true, null]]);
});

Deno.test("reply depth: tool calls under max_tokens cannot execute or enqueue either call", async () => {
  const { result, payloads, saves, external } = await providerRun([
    wire("max_tokens", [wireCall("save_fixture"), wireCall("external_fixture", { to: "x" })]), wire("end_turn", [], COMPLETE),
  ]);
  eq(result.reply, COMPLETE); eq(payloads.length, 2);
  eq([saves, external, result.tool_calls.length, result.pending_approvals.length], [0, 0, 0, 0]);
});

Deno.test("reply depth: repeated max_tokens tool calls gets one repair and an honest incomplete result", async () => {
  const { result, payloads, saves, external, meter } = await providerRun([
    wire("max_tokens", [wireCall("save_fixture", { note: "u" })]),
  ]);
  eq(result.stopped, "incomplete_reply"); eq(payloads.length, 2); eq(payloads[1].tool_choice, { type: "none" });
  eq([saves, external, result.tool_calls.length, result.pending_approvals.length], [0, 0, 0, 0]);
  eq(meter.usd_micros, 70, "failed completion does not erase provider token cost");
});

Deno.test("reply depth: truncated retelling preserves an existing exact preview and its single save", async () => {
  const { result, payloads, saves, meter } = await providerRun([
    wire("tool_use", [wireCall("save_fixture")]), wire("max_tokens", [wireCall("save_fixture", { note: "u" })]),
  ], true);
  eq(result.reply, "Synthetic exact preview."); eq(result.stopped, "final"); eq(payloads.length, 2); eq(saves, 1);
  eq(meter.usd_micros, 70, "preview delivery retains both provider calls' usage");
});

async function placeholderTurn(message: string, replies: string[]) {
  const payloads: any[] = [];
  const result = await runAgentTurn({ system: "Answer only from the person's supplied facts; ask for facts you lack.", history: [], message,
    tools: [], ctx: { userId: "SYNTHETIC-PLACEHOLDER-OWNER", threadId: "SYNTHETIC-PLACEHOLDER-THREAD", now: 0, state: {} },
    model: async (p) => { payloads.push(structuredClone(p)); return text(replies[Math.min(payloads.length - 1, replies.length - 1)]); } });
  return { result, payloads };
}
const MATCH_QUESTION = "Which of my skills match this role?";
const PLACEHOLDER_CLAIM = "Your [your skill] skills are a strong match.";
const ASK_FACTS = "Which skills have you used, and which posting should I compare them with?";

Deno.test("reply depth: an informational answer cannot end at a fact placeholder produced by truth review", async () => {
  const { result, payloads } = await placeholderTurn(MATCH_QUESTION, ["Your Excel skills are a strong match.", PLACEHOLDER_CLAIM, ASK_FACTS]);
  eq(result.reply, ASK_FACTS); eq(result.stopped, "final"); eq(payloads.length, 3);
  eq(payloads[2].tool_choice, { type: "none" }); eq(result.tool_calls, []); eq(result.pending_approvals, []);
  eq(payloads[2].messages, payloads[0].messages, "review and placeholder are not the person's evidence");
});

Deno.test("reply depth: a directly returned personal-fact placeholder gets one clarification repair", async () => {
  const { result, payloads } = await placeholderTurn(MATCH_QUESTION, [PLACEHOLDER_CLAIM, ASK_FACTS]);
  eq(result.reply, ASK_FACTS); eq(payloads.length, 2); eq(payloads[1].tool_choice, { type: "none" });
});

Deno.test("reply depth: repeated placeholder pseudoanswers stop honestly within the existing repair bound", async () => {
  const { result, payloads } = await placeholderTurn(MATCH_QUESTION, [PLACEHOLDER_CLAIM]);
  eq(result.stopped, "incomplete_reply"); eq(payloads.length, 2);
  ok(!result.reply.includes("[your skill]"), "the informational pseudoanswer escaped after recovery");
});

Deno.test("reply depth: supported answer content survives alongside an unfilled fact field", async () => {
  const supported = "SQL matches the reporting requirement.";
  const { result, payloads } = await placeholderTurn("I use SQL. Which skills match the reporting requirement?", [supported + " " + PLACEHOLDER_CLAIM, supported]);
  eq(result.reply, supported + " " + PLACEHOLDER_CLAIM); eq(payloads.length, 1);
});

Deno.test("reply depth: explicit templates and requested drafts retain fill-in facts", async () => {
  for (const message of ["Give me a fill-in template for a recruiter email.", "Write a recruiter email for me.", "Could you draft a short message for a recruiter?"]) {
    const draft = "Hi [Recruiter Name],\n\nMy [your skill] experience fits the role. Could we discuss it?\n\n[Your Name]";
    const { result, payloads } = await placeholderTurn(message, [draft]);
    eq(result.reply, draft, message); eq(result.stopped, "final"); eq(payloads.length, 1);
  }
});

Deno.test("reply depth: exact-copy and literal-placeholder explanations remain valid", async () => {
  for (const [message, reply] of [
    ['Reply exactly "Your [your skill] skills are a strong match."', PLACEHOLDER_CLAIM],
    ['What does "[your skill]" mean in a template?', '"[your skill]" is a field to replace with a skill you have actually used.'],
  ]) {
    const { result, payloads } = await placeholderTurn(message, [reply]); eq(result.reply, reply); eq(payloads.length, 1);
  }
});

Deno.test("reply depth: code-owned previews remain exact even when they contain a fill-in field", async () => {
  const tool: ToolSpec = { name: "show_fixture", description: "Show a synthetic preview", effect: "read", input_schema: { type: "object", properties: {}, required: [] },
    run: async (_i, c) => { c.turn!.show = { intent: "SYNTHETIC_SHOW", text: PLACEHOLDER_CLAIM }; return { shown: true }; } };
  let calls = 0;
  const result = await runAgentTurn({ system: "s", history: [], message: MATCH_QUESTION, tools: [tool], ctx: { userId: "SYNTHETIC-OWNER", threadId: "SYNTHETIC-THREAD", now: 0, state: {} },
    model: async () => calls++ === 0 ? { content: [{ type: "tool_use", id: "SYNTHETIC-SHOW", name: tool.name, input: {} }], stop_reason: "tool_use" } : text("Shown.") });
  eq(result.reply, PLACEHOLDER_CLAIM); eq(calls, 2); eq(result.show?.text, PLACEHOLDER_CLAIM);
});
