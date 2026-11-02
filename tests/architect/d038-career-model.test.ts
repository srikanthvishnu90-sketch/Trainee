// D-038: the career reply model is one committed default (agent-chat/release_model.ts), read by every career call site;
// CAREER_MODEL is the rollback only; the provider follows the model name (claude- ids go to Anthropic with
// ANTHROPIC_API_KEY); every model the default or a rollback can name is priced, so the cost ledger and the global daily budget
// stay right. Nothing here reaches a real provider: the provider is a stub fetch.
import { CAREER_MODEL_DEFAULT, careerModel, careerModelConfig } from "../../supabase/functions/agent-chat/release_model.ts";
import { callModel, costMicros, fromAnthropic, modelConfig, modelConfigFor, newMeter, PRICES, providerFor, toAnthropic } from "../../supabase/functions/_shared/model_gateway.ts";
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
  eq((wf.match(/^\s*CAREER_MODEL:.*$/gm) ?? []).map((l) => l.trim()), ["CAREER_MODEL: ${{ inputs.model }}"], "brain-eval never pins a model; only the dispatch input names one");
  assert(/ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/.test(wf) && /ANTHROPIC_EVAL_BUDGET_USD: "25"/.test(wf), "the Anthropic key and its own cap reach the run");
});

Deno.test("D-038: CAREER_MODEL rolls back to a priced model only; the provider and key follow the model name", () => {
  eq(careerModel(env({ CAREER_MODEL: "gpt-4.1-mini" })), "gpt-4.1-mini", "a priced rollback is honoured");
  eq(careerModel(env({ CAREER_MODEL: " gpt-4.1-mini " })), "gpt-4.1-mini", "trimmed");
  eq(careerModel(env({ CAREER_MODEL: "gpt-5-mnii" })), CAREER_MODEL_DEFAULT, "a typo serves the default");
  eq(careerModel(env({ CAREER_MODEL: "gpt-realtime-mini" })), CAREER_MODEL_DEFAULT, "a voice model is never the reply model");
  const a = careerModelConfig(env({ CAREER_MODEL: "claude-haiku-5-5", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }));
  eq([a.provider, a.model, a.apiKey], ["anthropic", "claude-haiku-5-5", "a"], "a claude id uses Anthropic's key");
  const o = careerModelConfig(env({ CAREER_MODEL: "gpt-4.1-mini", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }));
  eq([o.provider, o.apiKey], ["openai", "o"], "a gpt id uses OpenAI's key");
  eq([providerFor("claude-sonnet-5-5"), providerFor("gpt-5-mini")], ["anthropic", "openai"]);
  // The OpenAI-only configs are unchanged: no secret switches a provider (Q3/SEC11).
  eq(modelConfig(env({ OPENAI_API_KEY: "o", MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", OPENAI_MODEL: "claude-haiku-5-5" })).provider, "openai");
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
  const cut = fromAnthropic({ type: "message", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "tool_use", id: "1", name: "t", input: {} }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } });
  eq([cut.content.map((c: any) => c.type), cut.stop_reason], [["text"], "max_tokens"], "a cut-off call is never executable; thinking is not shown");
});

Deno.test("D-038: a Claude call goes to Anthropic with its key, is reserved and metered like OpenAI's", async () => {
  const gate = memoryBudgetGate(), meter = newMeter(), seen: any[] = [];
  const request = (async (url: string, init: any) => {
    seen.push({ url, key: init.headers["x-api-key"], auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), { status: 200 });
  }) as any;
  const cfg = careerModelConfig(env({ CAREER_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "test-anthropic-key", OPENAI_API_KEY: "test-openai-key" }));
  const out = await callModel(cfg, { messages: [{ role: "user", content: "hi" }], max_tokens: 50, temperature: 0.2 }, { request, meter, budget: gate });
  eq(out.content, [{ type: "text", text: "ok" }]);
  eq([seen[0].url, seen[0].key, seen[0].auth], ["https://api.anthropic.com/v1/messages", "test-anthropic-key", undefined], "Anthropic's URL and key, never OpenAI's");
  assert(!("temperature" in seen[0].body), "no temperature sent");
  eq([meter.calls, meter.usd_micros, meter.provider], [1, 150, "anthropic"], "metered at the verified price");
  eq(gate.snapshot().spent, 150, "the budget settles to the proven cost");
  const missing = careerModelConfig(env({ CAREER_MODEL: "claude-haiku-5-5", OPENAI_API_KEY: "o" }));
  let err: any = null; try { await callModel(missing, { messages: [] }, { request: (async () => { throw new Error("must not send"); }) as any, budget: gate }); } catch (e) { err = e; }
  assert(err && err.type === "not_configured", "no ANTHROPIC_API_KEY: not configured, nothing sent");
});
