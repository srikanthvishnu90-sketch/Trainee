// D-038: the career reply model is one committed default (agent-chat/release_model.ts), read by every career call site;
// CAREER_REPLY_MODEL is the rollback only (CAREER_MODEL is the background readers' key); Claude-only (owner, 2026-11-02): the
// default is claude-haiku-5-5, Sonnet 5.5 only when the owner sets it explicitly, and any non-claude id is refused
// (providerFor throws); every model the default or a rollback can name is priced, so the cost ledger and the global daily budget
// stay right. Nothing here reaches a real provider: the provider is a stub fetch.
import { CAREER_MODEL_DEFAULT, careerModel, careerModelConfig, ROLLBACK_MODELS } from "../../supabase/functions/agent-chat/release_model.ts";
import { ANTHROPIC_THINKING_HEADROOM, callModel, costMicros, fromAnthropic, modelConfig, modelConfigFor, newMeter, PRICES, providerFor, readerModel, toAnthropic } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate, worstCaseMicros } from "../../supabase/functions/_shared/model_budget.ts";

function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => assert(JSON.stringify(a) === JSON.stringify(b), `${m} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (s: string) => s.split("\n").map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");

Deno.test("D-038: the default is one quoted line, priced from the provider's own page, and not voice", () => {
  const src = read("supabase/functions/agent-chat/release_model.ts");
  const m = /^export const CAREER_MODEL_DEFAULT = "([^"]+)";$/m.exec(src);
  assert(m && m[1] === CAREER_MODEL_DEFAULT, "CAREER_MODEL_DEFAULT is one quoted line");
  const row = PRICES[CAREER_MODEL_DEFAULT];
  assert(row, `the default ${CAREER_MODEL_DEFAULT} has a price row`);
  assert(/^https:\/\//.test(row.source) && /^\d{4}-\d{2}-\d{2}$/.test(row.checked_on), "the row names its source URL and date");
  eq(careerModel(env({})), CAREER_MODEL_DEFAULT, "unset: the default");
  eq(CAREER_MODEL_DEFAULT, "claude-haiku-5-5", "Haiku 5.5 is the committed default");
  eq([...ROLLBACK_MODELS], ["claude-haiku-5-5", "claude-sonnet-5-5"], "no non-Claude model is a rollback");
  eq(careerModel(env({ ANTHROPIC_API_KEY: "a" })), "claude-haiku-5-5", "a key alone never selects Sonnet: only the owner's explicit CAREER_REPLY_MODEL does");
});

Deno.test("D-038: every career call site reads the one default; no stray model id or CAREER_MODEL read on the chat path", () => {
  const h = code(read("supabase/functions/agent-chat/handler-career.ts"));
  assert((h.match(/careerModelConfig\(Deno\.env\)/g) ?? []).length >= 8, "the eight career call sites read careerModelConfig");
  const bad: string[] = [];
  for (const e of Deno.readDirSync(new URL("supabase/functions/agent-chat/", root))) {
    if (!e.isFile || !/\.(ts|js)$/.test(e.name) || e.name === "release_model.ts") continue;
    const text = code(read(`supabase/functions/agent-chat/${e.name}`));
    text.split("\n").forEach((l, i) => {
      if (/env\.get\(\s*["']CAREER_MODEL["']\s*\)/.test(l)) bad.push(`${e.name}:${i + 1} reads CAREER_MODEL itself`);
      if (/model:\s*["'](gpt-|o\d|claude-)/.test(l) || /\|\|\s*["'](gpt-|claude-)[\w.-]+["']/.test(l)) bad.push(`${e.name}:${i + 1} hard-codes a model: ${l.trim().slice(0, 100)}`);
    });
  }
  eq(bad, [], "no stray model ids on the chat path");
  for (const f of ["evals/career/run.ts", "evals/career/compare.ts", "evals/career/run-conversations.ts", "evals/career/slice.ts"]) {
    const t = code(read(f));
    assert(t.includes("careerModelConfig(Deno.env)") && !/CAREER_MODEL"\)\s*\|\|/.test(t), `${f} measures the committed model`);
  }
  const wf = read(".github/workflows/brain-eval.yml");
  eq((wf.match(/^\s*CAREER(_REPLY)?_MODEL:.*$/gm) ?? []).map((l) => l.trim()), ["CAREER_REPLY_MODEL: ${{ inputs.model }}"], "brain-eval never pins a model; only the dispatch input names one");
  assert(/ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/.test(wf) && /ANTHROPIC_EVAL_BUDGET_USD: "25"/.test(wf), "the Anthropic key and its own cap reach the run");
});

Deno.test("D-038: CAREER_REPLY_MODEL rolls back only to a listed, priced, keyed Claude model; any other id serves the default", () => {
  const key = { ANTHROPIC_API_KEY: "a" };
  eq(careerModel(env({ ...key, CAREER_REPLY_MODEL: "claude-haiku-5-5" })), "claude-haiku-5-5", "a listed, keyed rollback is honoured");
  eq(careerModel(env({ ...key, CAREER_REPLY_MODEL: " claude-sonnet-5-5 " })), "claude-sonnet-5-5", "Sonnet 5.5 when the owner sets it explicitly (trimmed)");
  eq(careerModel(env({ CAREER_REPLY_MODEL: "claude-sonnet-5-5" })), CAREER_MODEL_DEFAULT, "no Anthropic key: the default");
  eq(careerModel(env({ ...key, CAREER_REPLY_MODEL: "gpt-5-mini" })), CAREER_MODEL_DEFAULT, "a gpt id is never honoured");
  eq(careerModel(env({ ...key, CAREER_REPLY_MODEL: "claude-haiku-5-6" })), CAREER_MODEL_DEFAULT, "a typo serves the default");
  eq(careerModel(env({ ...key, CAREER_MODEL: "claude-sonnet-5-5" })), CAREER_MODEL_DEFAULT, "CAREER_MODEL (the readers' key) never moves the reply model");
  for (const m of ROLLBACK_MODELS) assert(PRICES[m], `${m} on the rollback list is priced`);
  const a = careerModelConfig(env({ ...key, CAREER_REPLY_MODEL: "claude-sonnet-5-5" }));
  eq([a.provider, a.model, a.apiKey], ["anthropic", "claude-sonnet-5-5", "a"]);
  const d = careerModelConfig(env(key));
  eq([d.provider, d.model, d.apiKey], ["anthropic", "claude-haiku-5-5", "a"]);
  eq([providerFor("claude-sonnet-5-5"), providerFor("claude-haiku-5-5")], ["anthropic", "anthropic"]);
  let err: any = null; try { providerFor("gpt-5-mini"); } catch (e) { err = e; }
  assert(err && err.type === "not_configured", "gpt-5-mini is refused");
  // Q3/SEC11: no secret switches the model or provider of the default config.
  const m = modelConfig(env({ ...key, MODEL_PROVIDER: "x", ANTHROPIC_MODEL: "claude-sonnet-5-5", OPENAI_MODEL: "gpt-5" }));
  eq([m.provider, m.model], ["anthropic", "claude-haiku-5-5"]);
});

Deno.test("D-038 review: the background readers' model is a priced Claude id (CAREER_MODEL) or Haiku 5.5; anything else is ignored", () => {
  eq(readerModel(env({ CAREER_MODEL: "claude-sonnet-5-5" })), "claude-sonnet-5-5");
  eq(readerModel(env({ CAREER_MODEL: "gpt-4.1-mini" })), "claude-haiku-5-5", "a gpt id is ignored");
  eq(readerModel(env({ CAREER_MODEL: "claude-unpriced-9" })), "claude-haiku-5-5", "an unpriced id is ignored");
  eq(readerModel(env({})), "claude-haiku-5-5");
});

Deno.test("D-038 review: the date of every price row is a real check, from 2026-10-01 to today", () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [m, r] of Object.entries(PRICES)) if (m.startsWith("claude-haiku-5") || m.startsWith("claude-sonnet-5")) assert(r.checked_on >= "2026-10-01" && r.checked_on <= today, m);
});

Deno.test("D-038: the Claude rows are verified, long-context priced and reserved", () => {
  for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
    const r = PRICES[m]; assert(r && r.checked === "verified" && /platform\.claude\.com/.test(r.source) && r.checked_on === "2026-11-01", `${m} row`);
  }
  const small = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  eq(costMicros("claude-haiku-5-5", small), 150, "1,000 in at $0.10 + 100 out at $0.50");
  eq(costMicros("claude-haiku-5-5", { ...small, input_tokens: 100001 }), Math.round(5 * (100001 * 0.10 + 100 * 0.50)), "over 100,000 prompt tokens: 5x");
  eq(costMicros("claude-sonnet-5-5", small), 3000);
  assert(worstCaseMicros("claude-haiku-5-5", PRICES, { bytes: 200000, images: 0, maxOutputTokens: 0 }) >= 5 * 200000 * 0.125, "a long prompt is reserved at the surcharge");
});

Deno.test("D-038: the Anthropic request drops what the Messages API does not take and keeps thinking off for chat", () => {
  const cfg = modelConfigFor(env({ ANTHROPIC_API_KEY: "a" }), "claude-haiku-5-5");
  const b = toAnthropic({ system: "s", messages: [{ role: "user", content: "hi" }], max_tokens: 400, temperature: 0.4, store: false,
    tools: [{ name: "t", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" },
    response_format: { type: "json_schema", json_schema: { name: "j", strict: true, schema: { type: "object", properties: {}, additionalProperties: false } } } }, cfg);
  eq([b.model, b.max_tokens, b.system, "temperature" in b, "store" in b, "response_format" in b], ["claude-haiku-5-5", 400, "s", false, false, false]);
  eq(b.output_config, { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } } });
  eq(b.thinking, { type: "disabled" });
  eq(toAnthropic({ messages: [] }, modelConfigFor(env({}), "claude-sonnet-5-5")).thinking, { type: "between_tools" });
  const cut = fromAnthropic({ type: "message", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "a" }, { type: "tool_use", id: "1", name: "t", input: {} }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } });
  eq([cut.content.map((c: any) => c.type), cut.stop_reason], [["thinking", "text"], "max_tokens"], "a cut-off call is never executable; thinking is kept");
  // A tools:[] + none request (career_brain.ts regenerate) sends neither tools nor tool_choice.
  const bare = toAnthropic({ messages: [], tools: [], tool_choice: { type: "none" }, max_tokens: 500 }, cfg);
  eq(["tools" in bare, "tool_choice" in bare], [false, false]);
});

const ROUTE = { name: "route_message", description: "d", input_schema: { type: "object", properties: { intent: { type: "string" } } } };
const OTHER = { name: "other", description: "d", input_schema: { type: "object", properties: {} } };
Deno.test("D-038 review: a forced tool on Haiku 5.5 is sent as is; on Sonnet 5.5 (which rejects it) as auto with that tool alone", () => {
  const forced = { system: "s", messages: [{ role: "user", content: "send sam 40" }], tools: [ROUTE, OTHER], tool_choice: { type: "tool", name: "route_message" }, max_tokens: 400 };
  const h = toAnthropic(forced, modelConfigFor(env({}), "claude-haiku-5-5"));
  eq([h.tool_choice, h.tools.map((t: any) => t.name), h.max_tokens, h.thinking], [{ type: "tool", name: "route_message" }, ["route_message", "other"], 400, { type: "disabled" }]);
  const so = toAnthropic(forced, modelConfigFor(env({}), "claude-sonnet-5-5"));
  eq([so.tool_choice, so.tools.map((t: any) => t.name), so.max_tokens, so.thinking], [{ type: "auto" }, ["route_message"], 400 + ANTHROPIC_THINKING_HEADROOM, { type: "between_tools" }]);
  const any = toAnthropic({ ...forced, tool_choice: { type: "any" } }, modelConfigFor(env({}), "claude-sonnet-5-5"));
  eq([any.tool_choice, any.tools.length], [{ type: "auto" }, 2], "any becomes auto with every tool");
});

Deno.test("D-038 review: a two-step tool loop replays the assistant turn with its thinking blocks complete, on both request shapes", () => {
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
    const cfg = modelConfigFor(env({ ANTHROPIC_API_KEY: "a" }), model);
    const step1 = fromAnthropic({ type: "message", content: [{ type: "thinking", thinking: "plan", signature: "sig1" }, { type: "tool_use", id: "tu1", name: "other", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 5 } });
    eq(step1.stop_reason, "tool_use");
    // The agent loop (loop.ts) pushes the assistant content as it came, then the tool result.
    const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: step1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] }];
    const req2 = toAnthropic({ system: "s", messages, tools: [OTHER], max_tokens: 800 }, cfg);
    eq(req2.messages[1].content, [{ type: "thinking", thinking: "plan", signature: "sig1" }, { type: "tool_use", id: "tu1", name: "other", input: {} }], `${model}: thinking passed back unchanged`);
    eq(["tool_choice" in req2, req2.tools.length], [false, 1], `${model}: auto by default, tools kept`);
  }
});

Deno.test("D-038: a Claude call goes to Anthropic with its key, is reserved and metered", async () => {
  const gate = memoryBudgetGate(), meter = newMeter(), seen: any[] = [];
  const request = (async (url: string, init: any) => {
    seen.push({ url, key: init.headers["x-api-key"], auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), { status: 200 });
  }) as any;
  const cfg = careerModelConfig(env({ CAREER_REPLY_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "test-anthropic-key" }));
  const out = await callModel(cfg, { messages: [{ role: "user", content: "hi" }], max_tokens: 50, temperature: 0.2 }, { request, meter, budget: gate });
  eq(out.content, [{ type: "text", text: "ok" }]);
  eq([seen[0].url, seen[0].key, seen[0].auth], ["https://api.anthropic.com/v1/messages", "test-anthropic-key", undefined], "Anthropic's URL and key");
  assert(!("temperature" in seen[0].body), "no temperature sent");
  eq([meter.calls, meter.usd_micros, meter.provider], [1, 150, "anthropic"], "metered at the verified price");
  eq(gate.snapshot().spent, 150, "the budget settles to the proven cost");
  const missing = modelConfigFor(env({}), "claude-haiku-5-5");
  let err: any = null; try { await callModel(missing, { messages: [] }, { request: (async () => { throw new Error("must not send"); }) as any, budget: gate }); } catch (e) { err = e; }
  assert(err && err.type === "not_configured", "no ANTHROPIC_API_KEY: not configured, nothing sent");
});
