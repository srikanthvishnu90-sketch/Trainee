// deno-lint-ignore-file no-explicit-any require-await
// R10 WO-H, spec F.2 (review item 3): the owner's two production turns through the REAL handler (handleChat) on real Postgres, with
// a scripted model on the Anthropic wire (no key, no spend) and the task planner switched on. Both turns reach the staged brain's
// company research (research_company is offered and called), the planner is never asked to plan them, and the reply is never the
// batch reply, a people list, introductions or outreach. The web is unreachable here (every page 404s), so research cannot read a
// source: the reply names that blocker (spec F.2 (d)).
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/research-company-f2-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-f2a": "7b0f8f8e-6a43-4a49-9d2c-0000000f2a01", "tok-f2b": "7b0f8f8e-6a43-4a49-9d2c-0000000f2a02" };
const F2A = "Let's leave the job search for now. What's Stripe like to work for as a data analyst intern? Give me a useful company research answer: what its business does, what an analyst might work on, any concerns to investigate, and 5 good questions to ask in an interview. Use real sources and distinguish facts from your interpretation. Don't apply or contact anyone.";
const F2B = "I'm not asking for an application batch. I only want company research about Stripe. Please answer in chat: what Stripe does, what data analysts work on, 5 interview questions, and source links. If you can't research it, name the specific blocker instead of explaining how to apply.";
const ACTIONS = /\b(?:I haven't started that batch|apply list|building the list|analysts at stripe|intro(?:duction)?s? drafted|runner)\b/i;

type Call = { tools: string[]; lastUser: string; toolResult: string | null };
const calls: Call[] = [];
const scripted = async (body: any): Promise<Response> => {
  const msgs: any[] = body.messages ?? [], tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name);
  const lastUser = String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "");
  const toolResult = msgs.at(-1)?.role === "tool" ? String(msgs.at(-1).content) : null;
  calls.push({ tools, lastUser, toolResult });
  const reply = (message: any) => new Response(JSON.stringify({ id: "fake", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  if (tools.includes("plan_task")) return reply({ role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "plan_task", arguments: JSON.stringify({ kind: "task", steps: [{ capability: "jobs.search", text: "search" }] }) } }] });
  if (tools.includes("research_company") && !toolResult) return reply({ role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name: "research_company", arguments: JSON.stringify({ company: "Stripe", role: "data analyst intern", question: lastUser, format: "inline" }) } }] });
  return reply({ role: "assistant", content: "I couldn't do this research: no source about Stripe could be opened." });
};

Deno.test({ name: "F.2 at the real handler: both turns reach company research; never the planner, a batch, a people list or outreach", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_PLANNER", "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "BRAVE_SEARCH_API_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
  const realResolve = Deno.resolveDns;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "BRAVE_SEARCH_API_KEY"]) Deno.env.delete(k); // the release values (D-047)
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-f2-not-a-key");
    Deno.env.set("CAREER_PLANNER", "on"); // the planner on, to prove it never takes these turns
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["203.0.113.20"] : []); // public, so reads reach the 404s
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).hostname === "api.anthropic.com") return anthropicWire(req, (b) => scripted(b));
      return new Response("not reachable in this test", { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    for (const [tok, msgs] of [["tok-f2a", [F2A, F2B]], ["tok-f2b", [F2B]]] as const) {
      const chat = handler.chat(tok);
      for (const m of msgs) {
        const n = calls.length;
        const r = await chat.say(m);
        eq(r.status, 200, r.reply);
        const mine = calls.slice(n);
        ok(!mine.some((c) => c.tools.includes("plan_task")), `${m.slice(0, 30)}: the planner is never asked`);
        ok(mine.some((c) => c.tools.includes("research_company")) && mine.some((c) => c.toolResult !== null && /"kind":"company"/.test(c.toolResult)), `${m.slice(0, 30)}: research_company is offered and called`);
        eq(r.body.meta.brain, "staged", r.reply);
        ok(!ACTIONS.test(r.reply), `${m.slice(0, 30)}: no batch, list, intro or outreach: ${r.reply}`);
        ok(/couldn't do this research: no source about Stripe could be opened/.test(r.reply), `the specific blocker: ${r.reply}`);
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    (Deno as any).resolveDns = realResolve;
    handler?.restore();
    await pg.stop();
  }
} });
