// D-062 $0 world: the real career handler under production flags (every RELEASE_FLAGS switch at its release value, no never-on
// switch, PRODUCTION_BRAIN), a scripted model on the Anthropic wire, stub Gmail accounts and a stubbed web search. Every other
// host is refused and recorded. Used by tests/architect/d062-capabilities-process.test.ts and d062-google-accounts.test.ts.
import assertNode from "node:assert/strict";
import { anthropicWire } from "./anthropic_wire.ts";
import { openWorld } from "./response_world.ts";
import { type Call, flagsNow, type Step } from "./mirror_process.ts";
import { isPeopleSearch, peopleSearchAnswer } from "./d062_fixtures.ts";
import { PRODUCTION_BRAIN, RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../../supabase/functions/agent-chat/release_config.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const READ = "https://www.googleapis.com/auth/gmail.readonly", SEND = "https://www.googleapis.com/auth/gmail.send";
export const DAY = 86_400_000;
export const parse = (calls: Call[], name: string) => { try { return JSON.parse(calls.find((c) => c.name === name)?.result || "{}"); } catch { return {}; } };

export type Mail = { id: string; threadId: string; at: number; from: string; subject: string; snippet: string; messageId: string; body?: string; dkim?: string };
// One stub Gmail API per account (by its access token); the OAuth host answers code exchanges, userinfo and revokes.
export function fakeGmail(token: string) {
  const inbox: Mail[] = [], sent: { raw: string; threadId: string | null }[] = [], calls: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const meta = (m: Mail) => ({ id: m.id, threadId: m.threadId, internalDate: String(m.at), snippet: m.snippet, labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [
    { name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.at).toUTCString() }, { name: "Message-ID", value: m.messageId },
    ...(m.dkim ? [{ name: "Authentication-Results", value: `mx.google.com; dkim=pass header.i=@${m.dkim} header.s=s1; spf=pass smtp.mailfrom=x@${m.dkim}; dmarc=pass header.from=${m.dkim}` }] : []),
  ], body: { data: btoa(m.body ?? m.snippet).replace(/\+/g, "-").replace(/\//g, "_") } } });
  const handle = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.pathname}${u.searchParams.get("q") ? `?q=${u.searchParams.get("q")}` : ""}`);
    if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: { code: 401 } }, 401);
    if (req.method === "GET" && u.pathname === "/gmail/v1/users/me/messages") {
      const q = u.searchParams.get("q") ?? "", after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
      const words = q.replace(/after:\d+|-in:\w+/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = inbox.filter((m) => m.at > after && words.every((w) => `${m.from} ${m.subject} ${m.snippet}`.toLowerCase().includes(w.replace(/^from:/, ""))));
      return json({ messages: hits.slice().reverse().map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const one = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && one) { const m = inbox.find((x) => x.id === decodeURIComponent(one[1])); return m ? json(meta(m)) : json({ error: "not found" }, 404); }
    if (req.method === "POST" && u.pathname === "/gmail/v1/users/me/messages/send") {
      const b = await req.json();
      const raw = String(b.raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
      sent.push({ raw: new TextDecoder().decode(Uint8Array.from(atob(raw + "=".repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0))), threadId: b.threadId ?? null });
      return json({ id: `sent-${sent.length}`, threadId: b.threadId ?? `thr-new-${sent.length}` });
    }
    return json({ error: "not found" }, 404);
  };
  return { inbox, sent, calls, handle };
}

// ------------------------------------------------------------------------------------------------ the conversation driver
export type Seen = { code: boolean; tools: string[]; calls: Call[]; reply: string; intent: string | null; body: any; outbound: string[]; searches: number };
export async function conversation(o: { gmail?: ReturnType<typeof fakeGmail> | null; google?: (req: Request) => Promise<Response | null>; script: Record<string, Step[]>; setup?: (pg: any, userId: string) => Promise<void> }) {
  let label = "";
  const seen: Record<string, Seen> = {};
  const fresh = (): Seen => ({ code: true, tools: [], calls: [], reply: "", intent: null, body: null, outbound: [], searches: 0 });
  const scripted = (chat: any) => {
    const msgs: any[] = chat.messages ?? [];
    const reply = (content: string, tool_calls?: unknown[]) => Response.json({ id: "d62", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    if (!Array.isArray(chat.tools) || !chat.tools.length) return reply(chat.response_format ? "{}" : `scripted (${label})`);
    const s = seen[label] ??= fresh();
    if (s.code) { s.code = false; s.tools = chat.tools.map((t: any) => t.function?.name ?? t.name); }
    const last = msgs.at(-1);
    if (last?.role === "tool" && s.calls.length && !s.calls.at(-1)!.result) s.calls.at(-1)!.result = String(last.content ?? "");
    const steps = o.script[label] ?? [], step = steps[s.calls.length];
    if (step && "tool" in step) {
      const input = typeof step.input === "function" ? step.input(s.calls) : step.input;
      s.calls.push({ name: step.tool, input, result: "" });
      return reply("", [{ id: `toolu_d62_${s.calls.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(input) } }]);
    }
    const t = steps.find((x): x is Extract<Step, { text: unknown }> => "text" in x)?.text;
    return reply((typeof t === "function" ? t(s.calls) : t) ?? `scripted (${label})`);
  };
  const model = async (req: Request) => {
    const body = await req.clone().json().catch(() => ({}));
    if ((body.tools ?? []).some((t: any) => /^web_search_/.test(String(t?.type ?? "")))) {
      (seen[label] ??= fresh()).searches++;
      (seen[label] as any).searchBody = body;
      return Response.json(isPeopleSearch(body) ? peopleSearchAnswer(body) : { id: "msg_search", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [], usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } });
    }
    return anthropicWire(req, scripted);
  };
  const world = await openWorld(2, { model });
  const below = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (o.google && (u.host === "gmail.googleapis.com" || u.host === "oauth2.googleapis.com" || u.host === "www.googleapis.com")) { const r = await o.google(req); if (r) return r; }
    if (o.gmail && u.host === "gmail.googleapis.com") return await o.gmail.handle(req);
    if (u.host !== "api.anthropic.com" && u.host !== "supabase.test") (seen[label] ??= fresh()).outbound.push(`${req.method} ${u.origin}${u.pathname}`);
    return await below(req);
  }) as typeof fetch;
  // PRODUCTION CONFIGURATION: every release flag unset (served at its release value), no never-on switch, the production brain.
  for (const k of Object.keys(RELEASE_FLAGS)) Deno.env.delete(k);
  for (const k of RELEASE_NEVER_ON) Deno.env.delete(k);
  Deno.env.set("CAREER_BRAIN", PRODUCTION_BRAIN);
  Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
  // File links (the tracker page) as production has them; a test secret, not a real one.
  Deno.env.set("TRAINEE_FILE_BASE_URL", "https://trainee.example.test"); Deno.env.set("TRAINEE_FILE_LINK_SECRET", "test-file-link-secret-0123456789abcdef");
  const person = await world.person({ resume: false });
  await o.setup?.(world.pg, person.id);
  const close = async () => { globalThis.fetch = below; for (const k of ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"]) Deno.env.delete(k); await world.close(); };
  const say = async (id: string, text: string) => {
    label = id;
    const f = flagsNow();
    eq(f.release, { ...RELEASE_FLAGS }, `${id}: effective release flags`); eq(f.neverOnOn, [], `${id}: a never-on switch is on`); eq(f.brain, PRODUCTION_BRAIN, `${id}: the brain`);
    const r: any = await person.say(text);
    const s = seen[id] ??= fresh();
    s.reply = String(r.reply ?? ""); s.intent = r.intent ?? null; s.body = r.body ?? null;
    return s;
  };
  return { world, person, say, seen, close };
}
