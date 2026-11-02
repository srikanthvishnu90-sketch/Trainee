// One door to the AI provider (owner decision 2026-10-11: OpenAI, the cheapest model that makes forced tool calls).
//
// Every caller (the chat reply, the flow router, the financial planner) keeps building the request it always built, in
// the Anthropic Messages shape, and reads back the same shape. This module sends it to the configured provider and
// translates both ways, so the planner's tool loop, the router's forced tool call and the chat's text reply keep one shape.
//
// Provider: chosen from the MODEL NAME only (D-038, owner ruling 2026-11-01 as relayed by the architect's main session:
// the career reply model may be Claude via ANTHROPIC_API_KEY). A "claude-" model goes to Anthropic's Messages API with
// ANTHROPIC_API_KEY; every other model goes to OpenAI with OPENAI_API_KEY (modelConfigFor). No secret switches a provider on
// its own: MODEL_PROVIDER, ANTHROPIC_MODEL and ANTHROPIC_ROUTER_MODEL are still ignored (Q3, 2026-10-28; SEC11), and
// modelConfig (the router, planner and finance chat) stays OpenAI. A missing key fails as "not configured" with the honest
// outage reply. Model: OPENAI_MODEL (default gpt-5-nano); the router may use OPENAI_ROUTER_MODEL; the career reply model is
// agent-chat/release_model.ts. Keys are read from the environment only and never logged.
import { ModelBudgetBlockedError, ModelUnavailableError, providerError, recordModelUsage, reserveModelCall } from "./model_calls.ts";
import { type BudgetGate, budgetBlockOfType, budgetPausedByEnv, budgetReply, denoEnvGet, REFUSED_BEFORE_GENERATION, resolveBudgetGate, usageProven, worstCaseMicros } from "./model_budget.ts";

export type Provider = "openai" | "anthropic";
export type ModelRole = "chat" | "router" | "planner" | "probe";
export interface ModelConfig { provider: Provider; model: string; apiKey: string; reasoningEffort: string | null }
type Env = { get(name: string): string | undefined };

export const OPENAI_DEFAULT_MODEL = "gpt-5-nano";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const PROVIDER_NAME: Record<Provider, string> = { openai: "OpenAI", anthropic: "Anthropic" };

export function modelConfig(env: Env, role: ModelRole = "chat"): ModelConfig {
  const base = env.get("OPENAI_MODEL") || OPENAI_DEFAULT_MODEL;
  const model = (role === "router" && env.get("OPENAI_ROUTER_MODEL")) || base;
  return { provider: "openai", model, apiKey: env.get("OPENAI_API_KEY") || "", reasoningEffort: reasoningModel(model) ? (env.get("OPENAI_REASONING_EFFORT") || "minimal") : null };
}
export const providerName = (c: ModelConfig) => PROVIDER_NAME[c.provider];
// D-038: the provider a model name belongs to. Only Claude model ids go to Anthropic.
export const providerFor = (model: string): Provider => /^claude-/i.test(String(model || "")) ? "anthropic" : "openai";
// D-038 review: CAREER_MODEL stays the OpenAI-only readers' model (mail, essay, mock prep, outreach replies). A claude- id
// there is never sent to OpenAI: those readers get their OpenAI fallback instead. The reply model has its own key.
export function openaiCareerModel(env: Env, fallback = "gpt-5-mini"): string {
  const v = (env.get("CAREER_MODEL") ?? "").trim();
  return v && providerFor(v) === "openai" ? v : fallback;
}
// A complete config for one named model: its provider, that provider's key, and its effort. Callers that pick a model
// (the career reply model) use this instead of { ...modelConfig(env), model }, which would carry OpenAI's key and provider.
// Anthropic effort: ANTHROPIC_EFFORT (low by default: a Telegram reply should land in seconds; owner may raise it).
export function modelConfigFor(env: Env, model: string): ModelConfig {
  if (providerFor(model) === "anthropic") return { provider: "anthropic", model, apiKey: env.get("ANTHROPIC_API_KEY") || "", reasoningEffort: env.get("ANTHROPIC_EFFORT") || "low" };
  return { provider: "openai", model, apiKey: env.get("OPENAI_API_KEY") || "", reasoningEffort: reasoningModel(model) ? (env.get("OPENAI_REASONING_EFFORT") || "minimal") : null };
}
// Reasoning models (gpt-5 family, o-series) take max_completion_tokens and reasoning_effort, and reject a custom temperature.
const reasoningModel = (model: string) => /^(gpt-5|o\d)/i.test(model);
// Owner, 2026-10-11: keep OpenAI spend small. At minimal effort gpt-5-nano rarely thinks; 512 is a cap, not a spend.
export const REASONING_HEADROOM = 512;

// Anthropic request -> OpenAI chat completions request.
export function toOpenAI(payload: any, cfg: ModelConfig): any {
  const messages: any[] = [];
  const system = Array.isArray(payload.system) ? payload.system.map((b: any) => b && b.text || "").filter(Boolean).join("\n\n") : payload.system;
  if (system) messages.push({ role: "system", content: String(system) });
  for (const m of payload.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      const calls = blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push(Object.assign({ role: "assistant", content: text || null }, calls.length ? { tool_calls: calls } : {}));
      continue;
    }
    // A user turn: tool results become "tool" messages (in order, before any text the turn also carries).
    for (const b of blocks.filter(b => b.type === "tool_result")) {
      const content = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x && x.text || "").join("") : JSON.stringify(b.content ?? "");
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
    }
    const parts = blocks.filter(b => b.type === "text" || b.type === "image").map(b => b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image_url", image_url: { url: `data:${b.source && b.source.media_type};base64,${b.source && b.source.data}` } });
    if (parts.length) messages.push({ role: "user", content: parts.every(p => p.type === "text") ? parts.map(p => p.text).join("") : parts });
  }
  // A reasoning model spends part of max_completion_tokens thinking; the headroom keeps a forced tool call from being cut off.
  // WO-061: decided by the model this request names, never by the config it was copied from. Callers write
  // { ...modelConfig(env), model: X }, so the effort chosen for the default model rode along to X: gpt-4.1-mini got
  // reasoning_effort and answered HTTP 400 on every call (run 39541224991), and a gpt-5 model under a non-reasoning default
  // got a temperature and no headroom.
  const effort = reasoningModel(cfg.model) ? (cfg.reasoningEffort || "minimal") : null;
  const body: any = { model: cfg.model, messages, max_completion_tokens: (payload.max_tokens || 1024) + (effort ? REASONING_HEADROOM : 0) };
  if (effort) body.reasoning_effort = effort;
  else if (typeof payload.temperature === "number") body.temperature = payload.temperature;
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    const tc = payload.tool_choice;
    body.tool_choice = !tc || tc.type === "auto" ? "auto" : tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : tc.type === "none" ? "none" : "auto";
  }
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) body.stop = payload.stop_sequences.slice(0, 4);
  // WO-040: a caller that reads a person's mail asks OpenAI not to keep the completion (store: false).
  if (payload.store === false) body.store = false;
  // WO-051: a caller that needs a fixed answer shape asks for OpenAI's structured output (a strict JSON schema).
  if (payload.response_format?.type === "json_schema") body.response_format = payload.response_format;
  return body;
}

// The Anthropic request: the callers' payload is already in the Messages shape; only what the Messages API does not take is
// translated or dropped (D-038). store:false is OpenAI's (the Messages API keeps no completion for reuse; nothing to send).
// temperature is dropped: Claude 5.5 models take none ("Omit temperature, top_p, and top_k",
// platform.claude.com/docs/en/models/haiku-5-5/overview). response_format json_schema becomes output_config.format.
// Thinking is kept as low as each model allows, for chat latency (platform.claude.com/docs/en/build-with-claude/effort):
// Haiku 5.5 takes thinking disabled at high effort or below; Sonnet 5.5's lowest is between_tools (disabled is a 400), whose
// thinking blocks between tool calls count against max_tokens, so Sonnet gets ANTHROPIC_THINKING_HEADROOM more.
// tool_choice is sent only with tools (a tools:[] + none request sends neither). Sonnet 5.5 rejects a forced tool_choice
// (type "tool" or "any": a 400; platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), so a forced choice is sent
// as auto, and a forced single tool is sent alone: the caller's own check that a tool was called still decides (the flow
// router throws to its regex net; the outreach parser fails closed). Effort: cfg.reasoningEffort (low by default).
const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high"]);
export const ANTHROPIC_THINKING_HEADROOM = 1024;
const NO_FORCED_TOOL = /^claude-sonnet-5-5/i;
export function toAnthropic(payload: any, cfg: ModelConfig): any {
  const sonnet55 = NO_FORCED_TOOL.test(cfg.model);
  const body: any = { model: cfg.model, max_tokens: (payload.max_tokens || 1024) + (sonnet55 ? ANTHROPIC_THINKING_HEADROOM : 0), messages: payload.messages || [] };
  if (payload.system) body.system = payload.system;
  let tools: any[] = Array.isArray(payload.tools) ? payload.tools : [];
  let tc = payload.tool_choice;
  if (sonnet55 && tc && (tc.type === "tool" || tc.type === "any")) {
    if (tc.type === "tool") tools = tools.filter((t: any) => t && t.name === tc.name);
    tc = { type: "auto" };
  }
  if (tools.length) {
    body.tools = tools;
    if (tc) body.tool_choice = tc;
  }
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) body.stop_sequences = payload.stop_sequences.slice(0, 4);
  // Effort exists on Claude 4.6 and later; older ids (Haiku 4.5) reject it, so it is sent only to the 5.x family used here.
  const effortOk = /^claude-(haiku|sonnet|opus)-5/i.test(cfg.model);
  const out: any = effortOk ? { effort: ANTHROPIC_EFFORTS.has(String(cfg.reasoningEffort)) ? String(cfg.reasoningEffort) : "low" } : {};
  const rf = payload.response_format;
  if (rf?.type === "json_schema" && rf.json_schema?.schema) out.format = { type: "json_schema", schema: rf.json_schema.schema };
  if (Object.keys(out).length) body.output_config = out;
  if (/^claude-haiku-5/i.test(cfg.model)) body.thinking = { type: "disabled" };
  else if (sonnet55) body.thinking = { type: "between_tools" };
  return body;
}
// Anthropic message -> the callers' shape. Thinking blocks are KEPT, complete and in place: the agent loop replays an
// assistant turn's content as it came (loop.ts), and Sonnet 5.5 requires them passed back unchanged in tool-use loops;
// callers read only text and tool_use blocks, and toOpenAI drops them. A cut-off answer's tool calls are discarded, as on
// the OpenAI side (a truncated call is never executable).
export function fromAnthropic(body: any): any {
  if (!body || !Array.isArray(body.content)) throw new ModelUnavailableError(502, "bad_response", "Anthropic returned no message");
  const truncated = body.stop_reason === "max_tokens";
  const content = body.content.filter((b: any) => b && !(truncated && b.type === "tool_use"));
  const used = content.some((b: any) => b.type === "tool_use");
  const stop_reason = truncated ? "max_tokens" : body.stop_reason === "tool_use" && !used ? "end_turn" : body.stop_reason;
  return Object.assign({}, body, { content, stop_reason });
}

// OpenAI chat completion -> Anthropic message. Malformed completed tool calls fail; truncated calls are discarded.
export function fromOpenAI(body: any): any {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  if (!choice || !choice.message) throw new ModelUnavailableError(502, "bad_response", "OpenAI returned no message");
  const msg = choice.message, content: any[] = [];
  const truncated = choice.finish_reason === "length";
  const text = typeof msg.content === "string" ? msg.content : msg.refusal ? String(msg.refusal) : "";
  if (text) content.push({ type: "text", text });
  // Truncation can cut JSON arguments mid-value. None of that response's calls are executable, including calls
  // that happen to parse before the cut: retain its usage and let the caller handle max_tokens without decoding them.
  for (const c of truncated ? [] : msg.tool_calls || []) {
    if (!c || c.type !== "function" || !c.function) continue;
    let input: any;
    try { input = JSON.parse(c.function.arguments || "{}"); } catch (_) { throw new ModelUnavailableError(502, "bad_tool_call", `OpenAI returned unreadable arguments for ${c.function.name}`); }
    content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
  }
  const used = content.some(b => b.type === "tool_use");
  // A parsed call does not override the provider saying the generation was cut off; the loop must repair without effects.
  const stop_reason = truncated ? "max_tokens" : used ? "tool_use" : choice.finish_reason === "content_filter" ? "refusal" : "end_turn";
  const u = body.usage || {};
  const cached = Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const usage = { input_tokens: Math.max(0, (Number(u.prompt_tokens) || 0) - cached), output_tokens: Number(u.completion_tokens) || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
  return { id: body.id, type: "message", role: "assistant", model: body.model, content, stop_reason, usage };
}

// USD per million tokens. Every row says where it came from and whether the price was read from the provider's own page.
// 2026-10-28 verification (WebFetch from the build session; OpenAI's pricing page itself, platform.openai.com/docs/pricing, is not
// reachable from there, so OpenAI prices are read from each model's page on developers.openai.com/api/docs/models/<id>):
//   verified   read on the provider's own page on 2026-10-28.
//   third_party   read only on a third-party table (cloudprice.net) on 2026-10-28; the provider's page was not reachable.
//   unverified   not read anywhere today. Kept as last known. The budget does not trust it blindly: an unknown model is reserved
//                at the HIGHEST price in this table, and every row's reservation uses the larger of its input, cached and write rates.
// Several of these models are now marked Deprecated or Shut down on OpenAI's pages (noted per row). A model that is gone answers
// with an error, which costs nothing; a price here that is too low is the risk, which is why a mismatch must be fixed here first.
// Update here when the invoice disagrees; the cost is an estimate until it is reconciled with the provider's bill.
// long_context (D-038): a model whose whole request is priced higher once its prompt (input + cache reads + cache writes)
// passes over_tokens: every rate times multiplier (Claude Haiku 5.5: 5x over 100,000 prompt tokens).
export const PRICES: Record<string, { input: number; cached: number; cache_write: number; output: number; call_fee?: number; long_context?: { over_tokens: number; multiplier: number }; source: string; checked: "verified" | "third_party" | "unverified"; checked_on: string }> = {
  "gpt-5": { input: 1.25, cached: 0.125, cache_write: 0, output: 10.00, source: "https://developers.openai.com/api/docs/models/gpt-5 (page marks the model Deprecated)", checked: "verified", checked_on: "2026-10-28" },
  "gpt-5-nano": { input: 0.05, cached: 0.005, cache_write: 0, output: 0.40, source: "https://developers.openai.com/api/docs/models/gpt-5-nano (Deprecated)", checked: "verified", checked_on: "2026-10-28" },
  "gpt-5-mini": { input: 0.25, cached: 0.025, cache_write: 0, output: 2.00, source: "https://cloudprice.net/models/gpt-5-mini, Standard tier (OpenAI's developers.openai.com page for it was not reachable; deprecated 2026-10-19)", checked: "third_party", checked_on: "2026-10-28" },
  "gpt-4.1-nano": { input: 0.10, cached: 0.025, cache_write: 0, output: 0.40, source: "https://developers.openai.com/api/docs/models/gpt-4.1-nano (marked Shut down)", checked: "verified", checked_on: "2026-10-28" },
  // WO-061: the second, independent eval judge (owner, 2026-10-21: two judges, both must pass).
  "gpt-4.1-mini": { input: 0.40, cached: 0.10, cache_write: 0, output: 1.60, source: "https://developers.openai.com/api/docs/models/gpt-4.1-mini (Deprecated)", checked: "verified", checked_on: "2026-10-28" },
  // D-038, the career reply model candidates (Anthropic, owner ruling 2026-11-01). Read on Anthropic's own pages on 2026-11-01:
  // platform.claude.com/docs/en/about-claude/pricing and the model overview pages. cache_write is the 5-minute write rate.
  "claude-haiku-5-5": { input: 0.10, cached: 0.01, cache_write: 0.125, output: 0.50, long_context: { over_tokens: 100000, multiplier: 5 }, source: "https://platform.claude.com/docs/en/about-claude/pricing and https://platform.claude.com/docs/en/models/haiku-5-5/overview ($0.10 in, $0.125 5m write, $0.01 hit, $0.50 out up to 100,000 prompt tokens; 5x over; Active, retirement not sooner than 2027-10-07)", checked: "verified", checked_on: "2026-11-01" },
  "claude-sonnet-5-5": { input: 2.00, cached: 0.10, cache_write: 2.50, output: 10.00, source: "https://platform.claude.com/docs/en/about-claude/pricing ($2 in, $2.50 5m write, $0.10 hit, $10 out; no long-context surcharge listed)", checked: "verified", checked_on: "2026-11-01" },
  "claude-haiku-4-5-20251001": { input: 1.00, cached: 0.10, cache_write: 1.25, output: 5.00, source: "Anthropic published pricing, last known; platform.claude.com/docs/en/about-claude/pricing could not be fetched on 2026-10-28 (never used unless MODEL_PROVIDER=anthropic is set on purpose)", checked: "unverified", checked_on: "2026-10-11" },
};
// Realtime voice (not callModel: the browser talks to OpenAI with a key minted by career-voice; see career_voice.ts). Text prices for
// gpt-realtime-mini were read on https://developers.openai.com/api/docs/models/gpt-realtime-mini (2026-10-28): $0.60 in, $0.06 cached,
// $2.40 out. Its audio prices ($10 in, $20 out per 1M tokens) were read only on https://cloudprice.net/models/openai/gpt-realtime-mini
// (2026-10-28). gpt-realtime (the full model) was NOT read anywhere today; it is reserved at three times the mini rate. OpenAI does not
// publish a per-minute price, so the voice reservation is an assumption, not a verified figure (see career_voice.ts).
// Cost of one call in micro-dollars (1e-6 USD), from the tokens the provider reported. null when the model has no price.
export function costMicros(model: string, usage: any): number | null {
  const p = PRICES[model]; if (!p || !usage) return null;
  const n = (k: string) => Number(usage[k]) || 0;
  const prompt = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  const x = p.long_context && prompt > p.long_context.over_tokens ? p.long_context.multiplier : 1;
  return Math.round(x * (n("input_tokens") * p.input + n("cache_read_input_tokens") * p.cached + n("cache_creation_input_tokens") * p.cache_write + n("output_tokens") * p.output));
}

// Per-turn meter: every call in one user turn adds to it; the turn's message meta carries the total.
export interface TurnMeter { calls: number; failed: number; input_tokens: number; output_tokens: number; cached_tokens: number; usd_micros: number; unpriced: number; provider: string | null; models: string[] }
export const newMeter = (): TurnMeter => ({ calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, usd_micros: 0, unpriced: 0, provider: null, models: [] });
export function meterAdd(m: TurnMeter | undefined, cfg: ModelConfig, usage: any, failed = false) {
  if (!m) return;
  m.calls++; m.provider = cfg.provider; if (!m.models.includes(cfg.model)) m.models.push(cfg.model);
  if (failed) { m.failed++; return; }
  m.input_tokens += Number(usage && usage.input_tokens) || 0; m.output_tokens += Number(usage && usage.output_tokens) || 0;
  m.cached_tokens += Number(usage && usage.cache_read_input_tokens) || 0;
  const c = costMicros(cfg.model, usage); if (c === null) m.unpriced++; else m.usd_micros += c;
}

// Every user turn leaves one cost row, so a missing row can never be read as zero spend (2026-10-28).
//   metered, calls = 0   the turn made no model call (the row says zero, in so many words);
//   metered, calls > 0   the turn's calls, tokens and estimated cost;
//   unrecorded           the sink was missing or refused the write, so how many calls the turn made is NOT KNOWN
//                        (calls is null, never 0). A reader must count these turns as unknown, not as free.
// Meters are tracked, so a turn that throws after calling the model is still recorded. finish() runs once, at the end of
// the turn, whatever the reply was. It returns what the turn is now recorded as. Recording never breaks a reply.
export type TurnRecord = "metered" | "zero" | "unrecorded" | "skipped";
export function turnLedger(admin: any, userId: string, threadId: string | null) {
  const tracked: TurnMeter[] = [], done = new Set<TurnMeter>();
  let wrote = 0, failed = false, skipped = false;
  const put = async (row: Record<string, unknown>): Promise<string | null> => {
    if (!admin || typeof admin.from !== "function") return "no cost sink is wired";
    try { const r = await admin.from("agent_turn_costs").insert({ user_id: userId, thread_id: threadId, ...row }); return r && r.error ? String(r.error.message || r.error) : null; }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  const record = async (m: TurnMeter) => {
    if (!m.calls || done.has(m)) return; // a meter with no calls adds nothing; the turn's zero row says so
    done.add(m);
    const err = await put({ meter_state: "metered", provider: m.provider, models: m.models, calls: m.calls, failed: m.failed, input_tokens: m.input_tokens, output_tokens: m.output_tokens, cached_tokens: m.cached_tokens, usd_micros: m.usd_micros, unpriced: m.unpriced });
    if (err) { failed = true; console.error("turn cost not recorded:", err); } else wrote++;
  };
  return {
    track(m: TurnMeter): TurnMeter { tracked.push(m); return m; },
    record,
    // A replayed turn (same turn key) is the first run's answer again: its row is the first run's.
    skip() { skipped = true; },
    async finish(): Promise<TurnRecord> {
      if (skipped) return "skipped";
      for (const m of tracked) await record(m);
      if (!failed && wrote > 0) return "metered";
      if (!failed) {
        const err = await put({ meter_state: "metered", calls: 0 });
        if (!err) return "zero";
        console.error("turn cost not recorded:", err);
      }
      const err = await put({ meter_state: "unrecorded", calls: null });
      if (err) console.error("turn marked unrecorded failed (the turn is unrecorded and has no row):", err);
      return "unrecorded";
    },
  };
}

// Health events: one row per provider call outcome, so a dead key shows within minutes (model-health reads them).
export type HealthSink = (e: { provider: Provider; model: string; role: ModelRole; ok: boolean; status: number | null; error_type: string | null; detail: string | null; latency_ms: number }) => Promise<void> | void;
export function adminHealthSink(admin: any): HealthSink {
  return async (e) => { try { await admin.from("agent_provider_events").insert(e); } catch (_) { /* health logging never breaks a reply */ } };
}

// Voice is OFF for the beta (owner, 2026-10-28): a speech, transcription or realtime model is refused here before anything is reserved or sent.
export const VOICE_MODEL = /realtime|tts|whisper|transcribe|speech|audio/i;
export function refuseVoiceModel(model: string) { if (VOICE_MODEL.test(String(model || ""))) throw new ModelUnavailableError(403, "voice_off", "voice and speech models are switched off"); }
export interface CallOptions { role?: ModelRole; request?: typeof fetch; timeoutMs?: number; meter?: TurnMeter; health?: HealthSink; budget?: BudgetGate }
// The one call. Returns an Anthropic-shaped message; throws ModelUnavailableError (provider status, type and message,
// never the key) when the provider refuses, fails or is not configured.
//
// 2026-10-28, the global daily budget (_shared/model_budget.ts, migration 20261028070000): this function is the ONLY door to a
// paid model, and nothing is sent before the worst-case cost of the request has been reserved in the day's row. Settled to the
// proven cost after; kept at the full worst case when anything about the call is unproven; given back only for a proven no-call.
export async function callModel(cfg: ModelConfig, payload: any, o: CallOptions = {}): Promise<any> {
  refuseVoiceModel(cfg.model);
  const role = o.role || "chat", request = o.request || fetch, started = Date.now();
  const report = async (ok: boolean, status: number | null, type: string | null, detail: string | null) => { if (o.health) await o.health({ provider: cfg.provider, model: cfg.model, role, ok, status, error_type: type, detail, latency_ms: Date.now() - started }); };
  if (!cfg.apiKey) { const e = new ModelUnavailableError(0, "not_configured", `${providerName(cfg)} API key is not configured`); meterAdd(o.meter, cfg, null, true); await report(false, null, e.type, e.detail); throw e; }
  // ---- reserve (nothing is sent until this succeeds) ----
  const env = denoEnvGet();
  if (budgetPausedByEnv(env || (() => undefined))) throw new ModelBudgetBlockedError("paused", "MODEL_BUDGET_PAUSED is on");
  const gate = resolveBudgetGate(o.budget, env);
  if (!gate) throw new ModelBudgetBlockedError("unavailable", "the budget service is configured without a key");
  const sendBody = cfg.provider === "openai" ? toOpenAI(payload, cfg) : toAnthropic(payload, cfg);
  const bodyText = JSON.stringify(sendBody);
  const worst = worstCaseMicros(cfg.model, PRICES, {
    bytes: new TextEncoder().encode(bodyText).length,
    images: JSON.stringify(payload).split('"type":"image').length - 1,
    maxOutputTokens: Number(cfg.provider === "openai" ? sendBody.max_completion_tokens : sendBody.max_tokens ?? 1024) || 1024,
  });
  const got = await gate.reserve(worst, { model: cfg.model, role });
  if (!got.ok) {
    console.error(`[model] budget ${got.reason}${got.detail ? `: ${got.detail}` : ""}`);
    throw new ModelBudgetBlockedError(got.reason, got.reason === "limit" ? "the global model budget is used up" : got.reason === "paused" ? "the model budget is switched off" : got.reason === "before" ? "the model budget window has not opened" : got.reason === "after" ? "the model budget window has ended and no new budget is approved" : `the model budget could not be checked${got.detail ? `: ${got.detail}` : ""}`);
  }
  // Until proven otherwise the whole worst case is spent. Only the branches below that prove more change this.
  let close: { kind: "keep" } | { kind: "actual"; micros: number } | { kind: "release" } = { kind: "keep" };
  try {
    let res: Response;
    try {
      res = cfg.provider === "openai"
        ? await request(OPENAI_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` }, body: bodyText, signal: AbortSignal.timeout(o.timeoutMs || 30000) })
        : await request(ANTHROPIC_URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, body: bodyText, signal: AbortSignal.timeout(o.timeoutMs || 30000) });
    } catch (err) {
      const e = new ModelUnavailableError(0, err && (err as any).name === "TimeoutError" ? "timeout" : "network", `${providerName(cfg)}: ${err instanceof Error ? err.message : String(err)}`);
      meterAdd(o.meter, cfg, null, true); await report(false, null, e.type, e.detail); throw e;
    }
    if (!res.ok) {
      if (REFUSED_BEFORE_GENERATION.has(res.status)) close = { kind: "release" };
      const e = await providerError(res); meterAdd(o.meter, cfg, null, true); await report(false, e.status, e.type, e.detail); throw e;
    }
    const raw = await res.text();
    if (raw.length > 200000) { const e = new ModelUnavailableError(502, "too_large", `${providerName(cfg)} response is too large`); meterAdd(o.meter, cfg, null, true); await report(false, 502, e.type, e.detail); throw e; }
    let out: any, parsed: any;
    try { parsed = JSON.parse(raw); out = cfg.provider === "openai" ? fromOpenAI(parsed) : fromAnthropic(parsed); }
    catch (err) { const e = err instanceof ModelUnavailableError ? err : new ModelUnavailableError(502, "bad_response", `${providerName(cfg)} returned unreadable JSON`); meterAdd(o.meter, cfg, null, true); await report(false, e.status, e.type, e.detail); throw e; }
    // Settled to the actual cost only when the provider's own usage block is real (fromOpenAI turns a missing one into zeros)
    // and the model has a price; otherwise the worst case stays spent.
    const actual = usageProven(cfg.provider, parsed) ? costMicros(cfg.model, out.usage) : null;
    if (actual !== null && Number.isFinite(actual)) close = { kind: "actual", micros: Math.max(1, actual) };
    meterAdd(o.meter, cfg, out.usage); await report(true, res.status, null, null);
    return out;
  } finally {
    try {
      if (close.kind === "release") await gate.release(got.id);
      else await gate.settle(got.id, close.kind === "actual" ? close.micros : null);
    } catch (e) { console.error("[model] budget settle failed; the reservation stays open and expires to its worst case:", e instanceof Error ? e.message : e); }
  }
}

// What a person reads when the provider is down: the same sentence everywhere, never planner wording, never silence.
export const OUTAGE_REPLY = "I can't answer that right now: the AI service Upmore uses isn't responding, so I didn't look anything up and nothing was changed. Try again in a few minutes.";

// The financial planner's model: one reserved budget slot per round, the provider's usage recorded against it.
// style: the response-style examples for this message (StyleCorpus.render), appended to the planner's system prompt.
export function plannerModel(admin: any, userId: string, threadId: string, cfg: ModelConfig, o: CallOptions & { style?: string } = {}): any {
  const requestId = crypto.randomUUID(), deadline = Date.now() + 70000;
  return { async complete(payload: any, step: number) {
    if (!cfg.apiKey) throw new ModelUnavailableError(0, "not_configured", `${providerName(cfg)} API key is not configured`);
    if (Date.now() > deadline - 5000) throw new Error("Financial model deadline reached.");
    const callId = await reserveModelCall(admin, userId, threadId, requestId, step, cfg.model);
    let response: any;
    const system = o.style && typeof payload.system === "string" ? `${payload.system}\n\n${o.style}` : payload.system;
    try { response = await callModel(cfg, Object.assign({}, payload, { system, max_tokens: 1200 }), Object.assign({}, o, { role: "planner", timeoutMs: Math.min(18000, deadline - Date.now()) })); }
    catch (e) { if (e instanceof ModelUnavailableError) console.error(`[model] planner ${e.summary()}`); throw e; }
    await recordModelUsage(admin, callId, response.usage);
    return response;
  } };
}

// The chat reply's model call. A provider failure becomes the outage sentence with its cause for the message meta;
// anything else (a bug, a budget error) still throws.
export async function chatReply(cfg: ModelConfig, payload: any, o: CallOptions = {}): Promise<{ ok: true; message: any } | { ok: false; reply: string; model_error: string }> {
  try { return { ok: true, message: await callModel(cfg, payload, Object.assign({}, o, { role: "chat" as ModelRole })) }; }
  catch (e) {
    if (!(e instanceof ModelUnavailableError)) throw e;
    console.error(`[model] chat ${e.summary()}`);
    const block = budgetBlockOfType(e.type);
    return { ok: false, reply: block ? budgetReply(block) : OUTAGE_REPLY, model_error: e.summary() };
  }
}

// OpenAI's Responses API with the web_search tool (people discovery). The same rule as callModel: nothing is sent before the
// worst case is reserved in the day's row; settled to the proven cost, kept whole when anything is unproven, given back only for
// a provider refusal before generation. The worst case adds, for up to WEB_SEARCH_MAX_CALLS searches, the search content and a
// fee of WEB_SEARCH_FEE_MICROS each (OpenAI lists web search at $10-$25 per 1,000 calls; not read on its pricing page today).
// Returns the provider's Response untouched; throws ModelBudgetBlockedError when the budget refuses.
// The search content OpenAI adds to the model's input (billed as input tokens) is reserved as WEB_SEARCH_CONTENT_TOKENS per search
// at the model's highest input rate; the fee is reserved AND settled at WEB_SEARCH_FEE_MICROS (the conservative figure, since the
// listed price was not read on OpenAI's page today: a lower unverified number would undercount). max_tool_calls is forced to at
// most WEB_SEARCH_MAX_CALLS, so the searches a call can make are bounded by what was reserved.
export const WEB_SEARCH_FEE_MICROS = 25_000, WEB_SEARCH_MAX_CALLS = 1, WEB_SEARCH_CONTENT_TOKENS = 32_000;
// The worst case of one Responses call with the web_search tool, and what it settles to. ONE definition, used by responsesCall and by
// the batch runner's cap (evals/career/batch/entries.ts), so neither can undercount a search: max_tool_calls is forced to at most
// WEB_SEARCH_MAX_CALLS, each search reserves WEB_SEARCH_CONTENT_TOKENS of search content at the highest input rate plus
// WEB_SEARCH_FEE_MICROS, and the output allowance is max_output_tokens.
export function responsesWorst(model: string, body: Record<string, unknown>): { bodyText: string; maxCalls: number; micros: number } {
  const asked = Number(body.max_tool_calls);
  const maxCalls = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, WEB_SEARCH_MAX_CALLS) : WEB_SEARCH_MAX_CALLS;
  const bodyText = JSON.stringify({ ...body, max_tool_calls: maxCalls, model });
  const micros = worstCaseMicros(model, PRICES, { bytes: new TextEncoder().encode(bodyText).length + maxCalls * WEB_SEARCH_CONTENT_TOKENS, images: 0, maxOutputTokens: Number(body.max_output_tokens) || 4096 }) + maxCalls * WEB_SEARCH_FEE_MICROS;
  return { bodyText, maxCalls, micros };
}
// Proven cost of a Responses answer (tokens plus a fee per web_search_call), or null when the usage block is not real.
export function responsesSettle(model: string, j: any): number | null {
  const u = j && j.usage, num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!(u && num(u.input_tokens) && num(u.output_tokens) && Array.isArray(j.output))) return null;
  const tokens = costMicros(model, u);
  if (tokens === null || !Number.isFinite(tokens)) return null;
  const searches = j.output.filter((x: any) => x && x.type === "web_search_call").length;
  return Math.max(1, tokens + searches * WEB_SEARCH_FEE_MICROS);
}
export async function responsesCall(o: { apiKey: string; model: string; body: Record<string, unknown>; request?: typeof fetch; budget?: BudgetGate; timeoutMs?: number; role?: ModelRole }): Promise<Response> {
  refuseVoiceModel(o.model);
  const send = o.request || fetch;
  const env = denoEnvGet();
  if (budgetPausedByEnv(env || (() => undefined))) throw new ModelBudgetBlockedError("paused", "MODEL_BUDGET_PAUSED is on");
  const gate = resolveBudgetGate(o.budget, env);
  if (!gate) throw new ModelBudgetBlockedError("unavailable", "the budget service is configured without a key");
  const { bodyText, micros: worst } = responsesWorst(o.model, o.body);
  const got = await gate.reserve(worst, { model: o.model, role: o.role || "chat" });
  if (!got.ok) {
    console.error(`[model] budget ${got.reason}${got.detail ? `: ${got.detail}` : ""}`);
    throw new ModelBudgetBlockedError(got.reason, got.reason === "limit" ? "the global model budget is used up" : got.reason === "paused" ? "the model budget is switched off" : got.reason === "before" ? "the model budget window has not opened" : got.reason === "after" ? "the model budget window has ended and no new budget is approved" : `the model budget could not be checked${got.detail ? `: ${got.detail}` : ""}`);
  }
  let close: { kind: "keep" } | { kind: "actual"; micros: number } | { kind: "release" } = { kind: "keep" };
  try {
    const res = await send(RESPONSES_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` }, body: bodyText, signal: AbortSignal.timeout(o.timeoutMs || 45000) });
    if (!res.ok) { if (REFUSED_BEFORE_GENERATION.has(res.status)) close = { kind: "release" }; return res; }
    // Read a copy: the caller still gets the body. Proven only when the usage block is real and the model has a price.
    const raw = await res.clone().text().catch(() => ""), j: any = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    const settled = responsesSettle(o.model, j);
    if (settled !== null) close = { kind: "actual", micros: settled }; // the truth, even above the reservation (the day records an overrun)
    return res;
  } finally {
    try {
      if (close.kind === "release") await gate.release(got.id);
      else await gate.settle(got.id, close.kind === "actual" ? close.micros : null);
    } catch (e) { console.error("[model] budget settle failed; the reservation stays open and expires to its worst case:", e instanceof Error ? e.message : e); }
  }
}
