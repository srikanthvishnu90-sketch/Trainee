// Subscription mode for evals (owner, 2026-11-16, in chat: "yes" to "build the local subscription mode so all testing, including
// the 95% check, costs $0 in API credits"; D-089). An Anthropic Messages API request is answered by the `claude` CLI on the owner's
// Claude subscription instead of the API: no ANTHROPIC_API_KEY, no API billing. Local only, never CI, never production (a server
// cannot use the subscription, and live users stay on the API).
//
// How: the request's system prompt, tools and messages are rendered as text for `claude -p`, which answers through --json-schema
// with the same content blocks the API would return (text and tool_use). The child process gets an ALLOWLISTED environment
// (CHILD_ENV: PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_*, TERM; no API key, auth token, provider switch, base URL,
// custom header, config folder or parent Claude Code session variable reaches it), runs in an empty folder with
// `--setting-sources project` (so no CLAUDE.md or user settings reach the model), no tools of its own (`--tools ""`), no MCP
// servers, no saved session. Every call runs with --output-format stream-json; its stdout is read as it streams, and the
// child is killed as soon as its init event (which the CLI emits after reading the prompt and before it sends any model
// request) reports an apiKeySource other than "none", and the call is refused. preflight() makes one such call before the
// first request. The module refuses to run in CI (CI or GITHUB_ACTIONS set, even empty) whoever imports it, and removes its
// empty folder when the process ends.
//
// Known differences from the API (stated, so a measurement says what it measured):
// - The CLI adds a small base context of its own (about 600 tokens) in front of the request's system prompt.
// - `thinking`, `effort`, `temperature`, cache markers and `max_tokens` are not passed (the CLI sets its own).
// - Web search: a request offering the web_search server tool is answered by the CLI's own WebSearch tool (on the subscription),
//   returned in the API's blocks (server_tool_use, web_search_tool_result, text with web_search_result_location citations).
//   Its snippets come from Claude Code's search, not the API's, so cited passages can differ from what the API would return.
//   Other server tools are dropped and counted (`stats.serverToolsDropped`).
// - Images in messages are replaced by "[image omitted]".

// apiKeySource: "none" while every call's init event reported "none"; otherwise the first other value seen (that call was refused).
export interface CliStats { calls: number; failed: number; serverToolsDropped: number; webSearches: number; ms: number; apiKeySource: string | null }
export const stats: CliStats = { calls: 0, failed: 0, serverToolsDropped: 0, webSearches: 0, ms: 0, apiKeySource: null };

const SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { enum: ["text", "tool_use"] }, text: { type: "string" }, name: { type: "string" }, input: { type: "object" } },
        required: ["type"],
      },
    },
  },
  required: ["content"],
};

const textOf = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map(blockText).join("\n") : "";
function blockText(b: any): string {
  if (!b || typeof b !== "object") return String(b ?? "");
  if (b.type === "text") return String(b.text ?? "");
  if (b.type === "tool_use") return `<tool_call name=${JSON.stringify(b.name)} id=${JSON.stringify(b.id)}>${JSON.stringify(b.input ?? {})}</tool_call>`;
  if (b.type === "tool_result") return `<tool_result for=${JSON.stringify(b.tool_use_id)}${b.is_error ? " error=true" : ""}>${textOf(b.content)}</tool_result>`;
  if (b.type === "image" || b.type === "document") return "[image omitted]";
  if (b.type === "thinking" || b.type === "redacted_thinking") return "";
  return JSON.stringify(b);
}

/** The text the CLI sees: the request's system prompt, the bridge protocol, the tools, then the conversation. */
export function render(body: any): { system: string; prompt: string; schema: unknown } {
  const own = (body.tools ?? []).filter((t: any) => t && t.input_schema && !t.type?.startsWith?.("web_search"));
  stats.serverToolsDropped += (body.tools ?? []).length - own.length;
  const structured = body.output_config?.format?.schema;
  const sys = typeof body.system === "string" ? body.system : textOf(body.system);
  const protocol = structured
    ? "Bridge protocol: answer with one JSON object matching the required schema; it is the whole reply."
    : [
      "Bridge protocol: you are the assistant in the conversation below, answering its last turn. The tools listed below ARE",
      "available to you: you call one by putting a tool_use item in your JSON answer, and the system runs it and sends you the",
      "result in the next turn as <tool_result>. (You have no other way to run tools; that is expected, not a limitation to",
      'mention.) Your whole answer is a JSON object {"content": [...]} whose items are {"type":"text","text":...} for words to',
      'the user and {"type":"tool_use","name":...,"input":{...}} for a tool call (input must match the tool\'s schema). Use the',
      "tools exactly as the instructions above say you should. After a tool_use item, stop and wait for its result. Never",
      "write <tool_call> or <tool_result> tags yourself, and never mention this protocol. Important: the listed tools are NOT",
      "functions in your own tool list; never try to invoke them directly (that fails). Your only real function is the one",
      "that returns your structured answer: put each tool call as a tool_use item inside that answer.",
    ].join(" ");
  const tools = own.length
    ? "\n\nTools you may call:\n" + own.map((t: any) => `- ${t.name}: ${t.description ?? ""}\n  input schema: ${JSON.stringify(t.input_schema)}`).join("\n")
    : "";
  const choice = body.tool_choice?.type === "tool" ? `\nYou must call the tool ${body.tool_choice.name}.` : body.tool_choice?.type === "any" ? "\nYou must call a tool." : "";
  const convo = (body.messages ?? []).map((m: any) => `<${m.role}>\n${textOf(m.content)}\n</${m.role}>`).join("\n");
  return { system: `${sys}\n\n${protocol}${tools}${choice}`, prompt: `${convo}\n\nAnswer the last user turn now.`, schema: structured ?? SCHEMA };
}

let preflighted = false;
// The child's environment is an allowlist: only these keys (and LC_*) pass. Everything else (ANTHROPIC_*, AWS_*, CLAUDE_CODE_*,
// CLAUDECODE, CLAUDE_CONFIG_DIR, proxies) is dropped, so nothing can point the CLI at API billing or another provider.
export const CHILD_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"];
export function childEnv(from: Record<string, string> = Deno.env.toObject()): Record<string, string> {
  return Object.fromEntries(Object.entries(from).filter(([k]) => CHILD_ENV.includes(k) || /^LC_[A-Z_]+$/.test(k)));
}
// Never in CI, whoever imports this module (the runners refuse too; this holds for any other caller). Set at all counts.
export const inCi = (env: { has(k: string): boolean } = Deno.env) => env.has("CI") || env.has("GITHUB_ACTIONS");
function refuseCi(): void {
  if (inCi()) throw new Error("subscription mode never runs in CI (D-089)");
}
let empty: string | null = null;
function emptyDir(): string {
  if (empty) return empty;
  empty = Deno.makeTempDirSync({ prefix: "claude-cli-empty-" });
  globalThis.addEventListener("unload", () => { try { if (empty) Deno.removeSync(empty, { recursive: true }); } catch { /* already gone */ } });
  return empty;
}
// The isolation every call has: print mode, only the named CLI tools ("" = none), no MCP servers, only project settings (the
// empty folder has none), no saved session. BASE is a model call with no tools; the web search call allows only WebSearch.
export const isolated = (tools: string): string[] => ["-p", "--tools", tools, "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence"];
export const BASE: readonly string[] = isolated("");
// One CLI call. stdout is read line by line as it streams: the init event names the call's apiKeySource; one other than
// "none" kills the child at once (before the CLI sends a model request) and refuses the call, whatever preflight saw.
export async function runCli(args: string[], stdin: string): Promise<{ code: number; out: string; err: string; result: any }> {
  refuseCi();
  const p = new Deno.Command("claude", { args: [...args, "--output-format", "stream-json", "--verbose"], cwd: emptyDir(), env: childEnv(), clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const errText = new Response(p.stderr).text();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(stdin)); await w.close();
  const lines: string[] = [];
  let init: any = null, refused: string | null = null, buf = "";
  const dec = new TextDecoder();
  const reader = p.stdout.getReader();
  const take = (line: string) => {
    lines.push(line);
    let e: any = null; try { e = JSON.parse(line); } catch { return; }
    if (init || e?.type !== "system" || e?.subtype !== "init") return;
    init = e;
    if (stats.apiKeySource === null || stats.apiKeySource === "none") stats.apiKeySource = String(e.apiKeySource); // sticky: one other value stays
    if (e.apiKeySource !== "none") { refused = String(e.apiKeySource); try { p.kill("SIGKILL"); } catch { /* already gone */ } }
  };
  while (!refused) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k: number;
    while (!refused && (k = buf.indexOf("\n")) >= 0) { take(buf.slice(0, k)); buf = buf.slice(k + 1); }
    // An init line still waiting for its newline is checked as soon as it is whole JSON (a partial line never parses).
    if (!refused && !init && buf.trim()) { try { JSON.parse(buf); take(buf); buf = ""; } catch { /* not whole yet */ } }
  }
  if (!refused && buf) take(buf);
  try { reader.releaseLock(); await p.stdout.cancel(); } catch { /* closed */ }
  if (refused) { errText.catch(() => {}); throw new Error(`subscription mode: apiKeySource is ${JSON.stringify(refused)}, not "none"; the CLI was stopped before any model request (it would bill the API)`); }
  const st = await p.status, err = await errText, out = lines.join("\n");
  if (!init) throw new Error(`subscription mode: the claude CLI did not start (exit ${st.code}): ${(err || out).slice(0, 200)}`);
  const result = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e: any) => e?.type === "result") ?? null;
  return { code: st.code, out, err, result };
}

/** Refuses unless the CLI is signed in to a subscription and would bill no API key. */
export async function preflight(model = "claude-sonnet-5-5"): Promise<void> {
  refuseCi();
  if (preflighted) return;
  await runCli([...BASE, "--model", model, "--system-prompt", "Reply with the word ok."], "ok?");
  preflighted = true;
}

/** The Messages API endpoint itself: not /v1/messages/count_tokens, not /v1/messages/batches. */
export const isMessagesUrl = (url: string) => /^https:\/\/api\.anthropic\.com\/v1\/messages\/?(\?.*)?$/.test(url);

/** Answers one Messages API body through the CLI; returns the API's response shape. */
const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    searches: { type: "integer" },
    results: { type: "array", items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, page_age: { type: "string" } }, required: ["url", "title"] } },
    answer: { type: "array", items: { type: "object", properties: { text: { type: "string" }, citations: { type: "array", items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, cited_text: { type: "string" } }, required: ["url", "cited_text"] } } }, required: ["text"] } },
  },
  required: ["searches", "results", "answer"],
};
async function searchCall(body: any, tool: any): Promise<any> {
  const sys = typeof body.system === "string" ? body.system : textOf(body.system);
  const q = (body.messages ?? []).map((m: any) => textOf(m.content)).join("\n");
  const limits = [tool.max_uses ? `Search at most ${tool.max_uses} times.` : "", tool.allowed_domains?.length ? `Only use results from: ${tool.allowed_domains.join(", ")}.` : "", tool.blocked_domains?.length ? `Never use results from: ${tool.blocked_domains.join(", ")}.` : ""].filter(Boolean).join(" ");
  const protocol = [
    "Bridge protocol: use the WebSearch tool to research the question, then return the structured answer.", limits,
    "results: every search result you saw (https url, title, page age if shown). answer: your answer as short text pieces; give",
    "each piece the citations it rests on, where cited_text is copied word for word from that result's snippet (never",
    "paraphrased, never invented). searches: how many searches you ran.",
  ].join(" ");
  const t0 = performance.now();
  stats.calls++;
  const r = await runCli([...isolated("WebSearch"), "--allowedTools", "WebSearch", "--model", String(body.model || "claude-sonnet-5-5"), "--system-prompt", `${sys}\n\n${protocol}`, "--json-schema", JSON.stringify(SEARCH_SCHEMA)], q);
  stats.ms += performance.now() - t0;
  const out: any = r.result;
  if (!out) { stats.failed++; throw new Error(`claude CLI web search gave no result (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`); }
  if (out.is_error || !out.structured_output) { stats.failed++; throw new Error(`claude CLI web search error: ${String(out.result ?? out.subtype).slice(0, 300)}`); }
  const so = out.structured_output, https = (u: unknown) => typeof u === "string" && /^https:\/\//i.test(u);
  const searches = Math.max(0, Math.min(Number(tool.max_uses) || 3, Number(so.searches) || 0));
  stats.webSearches += searches;
  const u = out.usage ?? {};
  const content: any[] = [
    { type: "server_tool_use", id: `srvtoolu_cli_${stats.calls}`, name: "web_search", input: { query: q.slice(0, 400) } },
    { type: "web_search_tool_result", tool_use_id: `srvtoolu_cli_${stats.calls}`, content: (so.results ?? []).filter((x: any) => https(x?.url)).map((x: any) => ({ type: "web_search_result", url: x.url, title: String(x.title ?? ""), page_age: x.page_age ?? null, encrypted_content: "" })) },
    ...(so.answer ?? []).filter((a: any) => typeof a?.text === "string" && a.text.trim()).map((a: any) => ({ type: "text", text: a.text, citations: (a.citations ?? []).filter((c: any) => https(c?.url) && c.cited_text).map((c: any) => ({ type: "web_search_result_location", url: c.url, title: String(c.title ?? ""), cited_text: String(c.cited_text), encrypted_index: "" })) })),
  ];
  return { id: `cli_${stats.calls}`, type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, server_tool_use: { web_search_requests: searches } } };
}

export async function messages(body: any): Promise<any> {
  await preflight(body.model);
  const search = (body.tools ?? []).find((t: any) => /^web_search/.test(String(t?.type ?? "")));
  if (search && !(body.tools ?? []).some((t: any) => t?.input_schema)) return await searchCall(body, search);
  const { system, prompt, schema } = render(body);
  const t0 = performance.now();
  stats.calls++;
  const r = await runCli([...BASE, "--model", String(body.model || "claude-sonnet-5-5"), "--system-prompt", system, "--json-schema", JSON.stringify(schema)], prompt);
  stats.ms += performance.now() - t0;
  const out: any = r.result;
  if (!out) { stats.failed++; throw new Error(`claude CLI gave no result (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`); }
  if (out.is_error || !out.structured_output) { stats.failed++; throw new Error(`claude CLI error: ${String(out.result ?? out.subtype).slice(0, 300)}`); }
  const u = out.usage ?? {};
  const usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 };
  if (body.output_config?.format?.schema) {
    return { id: `cli_${stats.calls}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(out.structured_output) }], stop_reason: "end_turn", usage };
  }
  let n = 0;
  const content = (out.structured_output.content ?? []).filter((b: any) => b && (b.type === "text" ? typeof b.text === "string" && b.text.trim() : typeof b.name === "string"))
    .map((b: any) => b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: `toolu_cli_${stats.calls}_${n++}`, name: b.name, input: b.input ?? {} });
  return { id: `cli_${stats.calls}`, type: "message", role: "assistant", model: body.model, content: content.length ? content : [{ type: "text", text: "" }], stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn", usage };
}

/** A fetch-shaped handler for https://api.anthropic.com/v1/messages requests. */
export async function cliFetch(req: Request): Promise<Response> {
  const body = await req.clone().json().catch(() => null);
  if (!body) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "subscription mode: request body is not JSON" } }, { status: 400 });
  try { return Response.json(await messages(body)); } catch (e) {
    return Response.json({ type: "error", error: { type: "api_error", message: `subscription mode: ${(e as Error).message}` } }, { status: 500 });
  }
}
