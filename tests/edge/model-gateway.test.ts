// The model gateway (Claude-only, owner 2026-11-02 18:38 CT). One door for the chat, the router and the planner: the
// Anthropic-shaped request goes to Anthropic's Messages API, the reply comes back in the same shape, failures carry the
// provider's cause (never the key), every call is metered and reported to health. The provider here is a fake Anthropic
// Messages wire (a stub fetch); nothing in this file reaches a real provider and nothing spends.
import { modelConfig, modelConfigFor, providerFor, toAnthropic, fromAnthropic, callModel, chatReply, plannerModel, costMicros, newMeter, meterAdd, OUTAGE_REPLY, CLAUDE_DEFAULT_MODEL, webSearch } from "../../supabase/functions/_shared/model_gateway.ts";
import { ModelUnavailableError } from "../../supabase/functions/_shared/model_calls.ts";
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => assert(JSON.stringify(a) === JSON.stringify(b), `${m} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const KEY = "sk-ant-TESTKEY-should-never-appear-anywhere-0000";
const HAIKU = { provider: "anthropic" as const, model: "claude-haiku-5-5", apiKey: KEY, reasoningEffort: "low" };
const admin = () => ({ calls: [] as any[], async rpc(name: string, args: any) { this.calls.push({ name, args }); return { data: { ok: true, call_id: "slot" }, error: null }; } });
// The fake Anthropic Messages wire: a 200 with a message, content blocks and a usage block.
const message = (content: any[], usage: any = { input_tokens: 800, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, stop = "end_turn") =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: stop, usage });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const gate = () => ({ budget: memoryBudgetGate() });

Deno.test("provider choice: Claude Haiku 5.5 for every role; no secret selects another provider or model", () => {
  const o = modelConfig(env({ ANTHROPIC_API_KEY: KEY }));
  eq([o.provider, o.model, o.reasoningEffort, o.apiKey === KEY], ["anthropic", "claude-haiku-5-5", "low", true]);
  eq(CLAUDE_DEFAULT_MODEL, "claude-haiku-5-5");
  for (const role of ["chat", "router", "planner", "probe"] as const) eq(modelConfig(env({ ANTHROPIC_API_KEY: KEY }), role).model, "claude-haiku-5-5", role);
  // Q3 (SEC11): provider and model are not switchable by secret. These are ignored.
  const asked = modelConfig(env({ ANTHROPIC_API_KEY: KEY, MODEL_PROVIDER: "other", ANTHROPIC_MODEL: "claude-x", ANTHROPIC_ROUTER_MODEL: "claude-r", OPENAI_MODEL: "x", OPENAI_ROUTER_MODEL: "y" }), "router");
  eq([asked.provider, asked.model], ["anthropic", "claude-haiku-5-5"], "model and provider secrets are ignored");
  eq(modelConfig(env({})).apiKey, "", "no key is not configured, never a fallback");
  eq(modelConfig(env({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_EFFORT: "medium" })).reasoningEffort, "medium");
  eq(modelConfigFor(env({ ANTHROPIC_API_KEY: KEY }), "claude-sonnet-5-5").model, "claude-sonnet-5-5");
});

Deno.test("providerFor refuses every non-Claude model id; callModel refuses before reserving or sending", async () => {
  eq(providerFor("claude-haiku-5-5"), "anthropic"); eq(providerFor("claude-sonnet-5-5"), "anthropic");
  for (const id of ["gpt-5-mini", "gpt-4.1-mini", "o3", "", "text-embedding-3-small", "CHATGPT"]) {
    let err: any = null; try { providerFor(id); } catch (e) { err = e; }
    assert(err instanceof ModelUnavailableError && err.type === "not_configured" && /Claude models only/.test(err.detail), `${id}: ${err}`);
  }
  let threw: any = null; try { modelConfigFor(env({ ANTHROPIC_API_KEY: KEY }), "gpt-5-mini"); } catch (e) { threw = e; }
  assert(threw instanceof ModelUnavailableError, "a config for a non-Claude model cannot be built");
  // A config assembled by hand (spread from a Claude config with another model) is refused at the door.
  const g = memoryBudgetGate(); let sent = 0;
  let err: any = null; try { await callModel({ ...HAIKU, model: "gpt-5-mini" }, { messages: [] }, { request: (async () => { sent++; return message([text("x")]); }) as any, budget: g }); } catch (e) { err = e; }
  assert(err instanceof ModelUnavailableError && err.type === "not_configured", String(err));
  eq([sent, g.snapshot().spent, g.snapshot().reserved], [0, 0, 0], "nothing sent, nothing reserved");
});

Deno.test("request: system, tools, history and photos pass through in the Messages shape; temperature and store are dropped; effort and thinking follow the model", () => {
  const tools = [{ name: "route_message", description: "d", input_schema: { type: "object", properties: { intent: { type: "string" } } } }];
  const payload = {
    max_tokens: 400, temperature: 0.2, store: false,
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }, { type: "text", text: "cards" }],
    tools, tool_choice: { type: "tool", name: "route_message" },
    messages: [
      { role: "user", content: "what's my balance" },
      { role: "assistant", content: [toolUse("t1", "read_balance", { account: "checking" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"cents\":12345}" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] },
    ],
  };
  const b = toAnthropic(payload, HAIKU);
  eq(b.model, "claude-haiku-5-5"); eq(b.max_tokens, 400);
  assert(!("temperature" in b) && !("store" in b), "Claude 5.5 takes no temperature; store is not a Messages field");
  eq(b.system, payload.system); eq(b.messages, payload.messages); eq(b.tools, tools);
  eq(b.tool_choice, { type: "tool", name: "route_message" }, "Haiku keeps a forced tool_choice");
  eq(b.thinking, { type: "disabled" }); eq(b.output_config, { effort: "low" });
  // Sonnet 5.5 (D-038): no forced tool_choice (auto, and a forced single tool is sent alone), between_tools thinking and headroom.
  const s = toAnthropic({ ...payload, tools: [...tools, { name: "other", input_schema: {} }] }, { ...HAIKU, model: "claude-sonnet-5-5" });
  eq(s.tool_choice, { type: "auto" }); eq(s.tools.map((t: any) => t.name), ["route_message"]); eq(s.thinking, { type: "between_tools" }); eq(s.max_tokens, 400 + 1024);
  const any = toAnthropic({ tools, tool_choice: { type: "any" }, messages: [] }, HAIKU);
  eq(any.tool_choice, { type: "any" }, "the planner's forced 'any' is sent to Haiku as is");
  eq(toAnthropic({ tools: [], tool_choice: { type: "none" }, messages: [] }, HAIKU).tool_choice, undefined, "tool_choice only with tools");
  const rf = toAnthropic({ messages: [], response_format: { type: "json_schema", json_schema: { name: "v", schema: { type: "object" } } } }, HAIKU);
  eq(rf.output_config, { effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
});

Deno.test("response: text and tool_use pass through; usage is kept; a cut-off answer's tool calls are discarded; an answer with no content is a provider failure", () => {
  const r = fromAnthropic({ content: [toolUse("c1", "route_message", { intent: "send_money" })], stop_reason: "tool_use", usage: { input_tokens: 800, output_tokens: 500 } });
  eq(r.stop_reason, "tool_use"); eq(r.content, [toolUse("c1", "route_message", { intent: "send_money" })]);
  const cut = fromAnthropic({ content: [text("Hi"), toolUse("c2", "x", {})], stop_reason: "max_tokens", usage: {} });
  eq(cut.stop_reason, "max_tokens"); eq(cut.content, [text("Hi")]);
  eq(fromAnthropic({ content: [text("Hi there")], stop_reason: "tool_use" }).stop_reason, "end_turn", "tool_use with no tool block is an end of turn");
  let err: any = null; try { fromAnthropic({ type: "error" }); } catch (e) { err = e; }
  assert(err instanceof ModelUnavailableError && err.type === "bad_response", String(err));
});

Deno.test("a live Anthropic refusal keeps the provider's cause, never the key; the call is metered as failed and reported to health", async () => {
  const meter = newMeter(), events: any[] = []; let sent: any = null;
  const refuse = async (url: string, init: any) => { sent = { url, key: init.headers["x-api-key"], version: init.headers["anthropic-version"] }; return Response.json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY.slice(0, 12)}********0000` } }, { status: 401 }); };
  let err: any = null; try { await callModel(HAIKU, { max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { request: refuse as any, meter, health: e => { events.push(e); }, ...gate() }); } catch (e) { err = e; }
  eq(sent.url, "https://api.anthropic.com/v1/messages"); eq(sent.key, KEY); eq(sent.version, "2023-06-01");
  assert(err instanceof ModelUnavailableError && err.status === 401, String(err));
  assert(!(err.message + err.detail + JSON.stringify(events)).includes("sk-ant"), "no key fragment in the error or the health row");
  eq([meter.calls, meter.failed], [1, 1]);
  eq(events.map(e => [e.provider, e.model, e.role, e.ok, e.status]), [["anthropic", "claude-haiku-5-5", "chat", false, 401]]);
  const none = newMeter(); let missing: any = null;
  try { await callModel({ ...HAIKU, apiKey: "" }, { messages: [] }, { request: (async () => { throw new Error("must not send"); }) as any, meter: none, ...gate() }); } catch (e) { missing = e; }
  assert(missing instanceof ModelUnavailableError && /not configured/.test(missing.message) && /Anthropic/.test(missing.message), String(missing)); eq(none.failed, 1);
  let net: any = null; try { await callModel(HAIKU, { messages: [] }, { request: (async () => { throw new TypeError("connection reset"); }) as any, ...gate() }); } catch (e) { net = e; }
  assert(net instanceof ModelUnavailableError && net.type === "network", String(net));
});

Deno.test("chat: a Claude reply comes back as text with its cost; a dead provider is the outage sentence with the cause, never silence", async () => {
  const meter = newMeter(), events: any[] = [];
  const ok = await chatReply(HAIKU, { max_tokens: 400, system: "s", messages: [{ role: "user", content: "hi" }] }, { request: (async () => message([text("Hey! What can I help with?")])) as any, meter, health: e => { events.push(e); }, ...gate() });
  assert(ok.ok); eq((ok as any).message.content, [text("Hey! What can I help with?")]);
  // 800 in at $0.10, 200 cache hits at $0.01, 500 out at $0.50 per million = 80 + 2 + 250 micro-dollars.
  eq([meter.calls, meter.failed, meter.input_tokens, meter.output_tokens, meter.cached_tokens, meter.usd_micros, meter.provider], [1, 0, 800, 500, 200, 332, "anthropic"]);
  eq(events.map(e => [e.ok, e.role]), [[true, "chat"]]);
  const dead = await chatReply(HAIKU, { messages: [] }, { request: (async () => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 })) as any, ...gate() });
  assert(!dead.ok); eq((dead as any).reply, OUTAGE_REPLY);
  assert(/overloaded_error/.test((dead as any).model_error), (dead as any).model_error);
  assert(!/payment|plan|bill/i.test(OUTAGE_REPLY.replace("I can't answer", "")), "the outage sentence has no payment words");
});

Deno.test("cost per call: tokens times the model's price (D-038), in micro-dollars; an unpriced model is counted as unpriced, never as free", () => {
  eq(costMicros("claude-haiku-5-5", { input_tokens: 800, output_tokens: 500, cache_read_input_tokens: 200 }), 332);
  eq(costMicros("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 1000 }), 275, "5-minute cache write is $0.125");
  eq(costMicros("claude-haiku-5-5", { input_tokens: 100001, output_tokens: 10 }), Math.round(5 * (100001 * 0.10 + 10 * 0.50)), "5x over 100k prompt tokens");
  eq(costMicros("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 }), 2000 + 100 + 2500 + 1000, "Sonnet: $2 / $0.10 hit / $2.50 write / $10 out, no surcharge");
  eq(costMicros("some-new-model", { input_tokens: 1 }), null);
  eq(costMicros("gpt-5-mini", { input_tokens: 1 }), null, "no non-Claude price exists");
  const m = newMeter(); meterAdd(m, { ...HAIKU, model: "some-new-model" }, { input_tokens: 5, output_tokens: 5 });
  eq([m.calls, m.unpriced, m.usd_micros], [1, 1, 0]);
});

Deno.test("web search is a dark door: it answers not available, reserves nothing and sends nothing", async () => {
  const r = await webSearch("Stripe recruiter");
  eq([r.available, r.reason, r.results], [false, "not_available", []]);
});
