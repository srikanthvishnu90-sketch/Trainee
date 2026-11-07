// Greptile record 86: the reply-flags test checked the handler's source, not what it saves. Through the real career handler on
// Postgres 16 with a fake model whose reply asks two questions (and asks them again on the one rewrite the loop requests), the
// response meta and the saved assistant row both carry reply_flags ["many_asks"].
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/reply-flags-handler-20261107.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-rfh-1": "7b0f8f8e-6a43-4a49-9d2c-00000c0d0b01" };
let calls = 0;
const REPLY = "Good plan to move into clinic work. What city are you targeting? What is your earliest start date?";
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("not reachable in this test", { status: 404 });
  return anthropicWire(req, async (body: any) => {
    calls++;
    return new Response(JSON.stringify({ id: "fake-rfh", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
};

Deno.test({ name: "RFS-3 the real handler saves a flagged reply's reply_flags in the response and on the assistant row", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_REPLY_WRITER"]) saved[k] = Deno.env.get(k);
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-rfh-not-a-key");
    globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    let r: any = null;
    const tried: string[] = [];
    for (const m of ["How should I explain a two-year gap in my resume?", "What do recruiters look for in a career switcher?", "I'm thinking about moving from retail into healthcare admin. Is that realistic?"]) {
      const n = calls;
      r = await handler.chat("tok-rfh-1").say(m);
      assertNode.equal(r.status, 200, r.reply);
      tried.push(`${m} -> ${r.intent} calls+${calls - n}`);
      if (calls > n) break;
    }
    assertNode.ok(calls >= 1, `the agent answered (a model turn): ${tried.join(" | ")}`);
    assertNode.deepStrictEqual(r.body?.meta?.reply_flags, ["many_asks"], `response meta: ${JSON.stringify(r.body?.meta)}`);
    const row = (await pg.sql(`select coalesce(m.meta->'reply_flags', 'null'::jsonb)::text from public.agent_messages m join public.agent_threads th on th.id = m.thread_id
      where th.user_id = '${PEOPLE["tok-rfh-1"]}' and m.role = 'assistant' order by m.id desc limit 1`)).trim();
    assertNode.equal(row, '["many_asks"]', "assistant row meta");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
