// A fake Anthropic Messages wire (POST https://api.anthropic.com/v1/messages) for the reader tests (owner directive
// 2026-11-02: Claude-only, no OpenAI anywhere). It answers in Anthropic's shape with a usage block, keeps every request
// body and header, and records every URL it was asked for, so a test can assert that the only host contacted is
// api.anthropic.com. No network, no key, no spend.
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export type FakeAnswer = string | Error | { tool: string; input: unknown } | { status: number; body: unknown };

export function fakeAnthropic(answer: (body: any) => FakeAnswer = () => "", usage = { input_tokens: 320, output_tokens: 18 }) {
  const bodies: any[] = [], urls: string[] = [], headers: Record<string, string>[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url instanceof Request ? url.url : url));
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])));
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push(body);
    const a = answer(body);
    if (a instanceof Error) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: a.message } }), { status: 500 });
    if (typeof a === "object" && "status" in a) return new Response(JSON.stringify(a.body), { status: a.status });
    const content = typeof a === "string" ? [{ type: "text", text: a }] : [{ type: "tool_use", id: "toolu_test_1", name: a.tool, input: a.input }];
    return new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: body.model, content, stop_reason: typeof a === "string" ? "end_turn" : "tool_use", usage }), { status: 200 });
  }) as typeof fetch;
  return {
    request, bodies, urls, headers,
    hosts: () => [...new Set(urls.map((u) => new URL(u).host))],
    // Every request went to api.anthropic.com and nowhere else.
    onlyAnthropic: () => urls.every((u) => new URL(u).host === "api.anthropic.com"),
  };
}
