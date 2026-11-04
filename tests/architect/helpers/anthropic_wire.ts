// Scripted-model tests on the Anthropic Messages wire (owner directive 2026-11-02: Claude-only, no OpenAI anywhere).
//
// Many handler and flow tests drive the product with a scripted model: a function that reads the conversation and answers with
// text or a tool call. They were written against a chat-completions request/response shape. The product now talks to
// POST https://api.anthropic.com/v1/messages only, so each such test intercepts that host and hands the request to its scripted
// model through this adapter:
//
//   if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => scriptedModel(chat));
//
// The wire the product sees is Anthropic's (x-api-key, Messages request, Messages response with a usage block). The adapter
// only re-expresses the request as the flat message list the scripts already read (system line, user/assistant turns, tool
// calls and tool results) and the script's answer as a Messages response. Nothing here reaches a network or spends anything.
export const ANTHROPIC_HOST = "api.anthropic.com";

// Anthropic Messages request -> the flat list the scripts read.
export function messagesToChat(body: any): any {
  const messages: any[] = [];
  const system = Array.isArray(body.system) ? body.system.map((b: any) => (b && b.text) || "").filter(Boolean).join("\n\n") : body.system;
  if (system) messages.push({ role: "system", content: String(system) });
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push(Object.assign({ role: "assistant", content: text || null }, calls.length ? { tool_calls: calls } : {}));
      continue;
    }
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const content = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => (x && x.text) || "").join("") : JSON.stringify(b.content ?? "");
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
    }
    const parts = blocks.filter((b) => b.type === "text" || b.type === "image").map((b) => b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image_url", image_url: { url: `data:${b.source && b.source.media_type};base64,${b.source && b.source.data}` } });
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("") : parts });
  }
  const out: any = { model: body.model, messages, max_completion_tokens: body.max_tokens ?? 1024, max_tokens: body.max_tokens };
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    const tc = body.tool_choice;
    out.tool_choice = !tc || tc.type === "auto" ? "auto" : tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : tc.type === "none" ? "none" : "auto";
  }
  const fmt = body.output_config?.format;
  if (fmt?.type === "json_schema") out.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: fmt.schema } };
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  return out;
}

// A script's answer (the flat shape: choices[0].message with content and tool_calls, usage with prompt/completion tokens)
// -> an Anthropic Messages response.
export function chatToMessages(j: any, model?: string): any {
  const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
  if (!choice || !choice.message) return { type: "error", error: { type: "api_error", message: "the scripted model returned no message" } };
  const msg = choice.message, content: any[] = [];
  const text = typeof msg.content === "string" ? msg.content : "";
  if (text) content.push({ type: "text", text });
  for (const c of msg.tool_calls || []) {
    if (!c || !c.function) continue;
    let input: unknown = {};
    try { input = JSON.parse(c.function.arguments || "{}"); } catch (_) { input = {}; }
    content.push({ type: "tool_use", id: c.id || "toolu_test", name: c.function.name, input });
  }
  const truncated = choice.finish_reason === "length";
  const used = content.some((b) => b.type === "tool_use");
  const u = j.usage || {};
  return {
    id: j.id || "msg_test", type: "message", role: "assistant", model: model || j.model || "claude-haiku-5-5", content,
    stop_reason: truncated ? "max_tokens" : used ? "tool_use" : "end_turn",
    usage: { input_tokens: Number(u.prompt_tokens) || 0, output_tokens: Number(u.completion_tokens) || 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

// The test's intercepted fetch calls this for a request to api.anthropic.com. `script` gets the flat request and the original
// Request (for headers); it returns the script's Response (or the answer object). A non-2xx answer passes through unchanged.
export async function anthropicWire(req: Request, script: (chat: any, req: Request) => Response | Promise<Response> | any): Promise<Response> {
  const body = await req.clone().json().catch(() => ({}));
  const answer = await script(messagesToChat(body), req);
  if (!(answer instanceof Response)) return new Response(JSON.stringify(chatToMessages(answer, body.model)), { status: 200, headers: { "content-type": "application/json" } });
  if (!answer.ok) return answer;
  const j = await answer.json().catch(() => null);
  return new Response(JSON.stringify(chatToMessages(j, body.model)), { status: 200, headers: { "content-type": "application/json" } });
}
