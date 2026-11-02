// FEATURE 13 (owner, 2026-10-25): the staged brain release at the REAL handler (handleChat) on real Postgres, with a fake
// model on the OpenAI wire (no key, no spend: the provider's URL is answered in-process and every call is counted).
//   1. CAREER_BRAIN unset: the router answers every turn, byte-identical to the router run directly on the same state,
//      and the model is never called; CAREER_BRAIN=router (the kill switch) is the same.
//   2. CAREER_BRAIN=staged: an advice question goes to the brain (the fake model's words are the reply, the tools offered
//      exclude the actions code owns); an apply ask, a card ask and a job search stay code's, with no model call; a class
//      the owner keeps (CAREER_BRAIN_ROUTER_INTENTS) stays on the router.
//   3. The model fails: the router answers, exactly as it would have.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/f13-staged-brain-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { STAGED_WITHHELD_TOOLS } from "../../supabase/functions/agent-chat/career_staged.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = {
  "tok-f13a": "7b0f8f8e-6a43-4a49-9d2c-0000000f1301", "tok-f13b": "7b0f8f8e-6a43-4a49-9d2c-0000000f1302",
  "tok-f13c": "7b0f8f8e-6a43-4a49-9d2c-0000000f1303", "tok-f13d": "7b0f8f8e-6a43-4a49-9d2c-0000000f1304",
  "tok-f13e": "7b0f8f8e-6a43-4a49-9d2c-0000000f1305",
};
const ADVICE = "how should I follow up after an interview?";
const ANSWER = "Send a short thank-you note within a day that names one thing you discussed, then ask when they expect to decide. " +
  "If that date passes with no word, send one polite follow-up asking whether there is an update.";

// The fake OpenAI endpoint: each request is kept (its system prompt and tool names); "fail" answers 500.
type Call = { system: string; tools: string[]; user: string };
const calls: Call[] = [];
let mode: "answer" | "fail" = "answer";
const fakeOpenAI = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  const url = new URL(req.url);
  if (url.pathname === "/v1/moderations" || (await req.clone().text()).includes("TRAINEE_CRISIS_SCREEN")) return Response.json({ id: "screen", model: "screen", results: [{ flagged: false, categories: {} }], choices: [{ index: 0, message: { role: "assistant", content: "NO" }, finish_reason: "stop" }], content: [{ type: "text", text: "NO" }], stop_reason: "end_turn", usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 } }); // #354: the crisis screen's moderation and classifier calls, not counted (architect OK 2026-11-02)
  if (url.hostname !== "api.openai.com") return new Response("not reachable in this test", { status: 404 });
  const body = await req.json();
  const msgs: any[] = body.messages ?? [];
  calls.push({ system: String(msgs.find((m) => m.role === "system")?.content ?? ""), tools: (body.tools ?? []).map((t: any) => t.function?.name), user: String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "") });
  if (mode === "fail") return new Response(JSON.stringify({ error: { type: "server_error", message: "fake outage" } }), { status: 500, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ id: "fake-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
};

// The router run directly on a fresh account's first turn, as the handler builds it (empty pool, account persistence).
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const routerReply = (userId: string, message: string) => {
  const r = host.runTurn(message, host.createTurnCtx({ userId, threadId: "direct", now: Date.now(), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } }));
  return { reply: r.reply, intent: r.intent };
};

Deno.test({ name: "F13: the staged brain release at the real handler", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL"]) saved[k] = Deno.env.get(k);
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const setBrain = (v: string | null, keep: string | null = null) => {
    if (v === null) Deno.env.delete("CAREER_BRAIN"); else Deno.env.set("CAREER_BRAIN", v);
    if (keep === null) Deno.env.delete("CAREER_BRAIN_ROUTER_INTENTS"); else Deno.env.set("CAREER_BRAIN_ROUTER_INTENTS", keep);
  };
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    Deno.env.set("OPENAI_API_KEY", "sk-fake-f13-not-a-key");
    Deno.env.delete("MODEL_PROVIDER");
    Deno.env.set("CAREER_MODEL", "gpt-5-mini");
    // The double passes any origin but the Supabase project to the fetch it found installed: the fake provider.
    globalThis.fetch = fakeOpenAI as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    const costRows = async (id: string) => Number((await pg.sql(`select count(*) from public.agent_turn_costs where user_id = '${id}' and calls > 0`)).trim()); // rows with model calls; a zero-call turn leaves a calls = 0 row (2026-10-28)

    await t.step("unset: the router answers, byte-identical to the router itself; no model call", async () => {
      setBrain(null);
      const chat = handler!.chat("tok-f13a"), n = calls.length;
      const r = await say(chat, ADVICE);
      const direct = routerReply(PEOPLE["tok-f13a"], ADVICE);
      eq([r.reply, r.intent], [direct.reply, direct.intent], "the router's own reply, unchanged");
      eq(r.intent, "career_catchall");
      eq(r.body.meta.brain, undefined);
      eq(calls.length, n, "no model call");
      // The kill switch is the same router.
      setBrain("router");
      const k = await say(handler!.chat("tok-f13b"), ADVICE);
      eq([k.reply, k.intent, k.body.meta.brain], [routerReply(PEOPLE["tok-f13b"], ADVICE).reply, "career_catchall", undefined]);
      eq(calls.length, n, "no model call with the kill switch");
      eq(await costRows(PEOPLE["tok-f13a"]) + await costRows(PEOPLE["tok-f13b"]), 0, "no metered turn");
    });

    await t.step("staged: the advice question goes to the brain, with the actions code owns withheld", async () => {
      setBrain("staged");
      const chat = handler!.chat("tok-f13c"), n = calls.length;
      const r = await say(chat, ADVICE);
      eq(calls.length, n + 1, "one model call");
      eq(r.reply, ANSWER, "the brain's words are the reply");
      eq([r.intent, r.body.meta.brain, r.body.meta.router_intent, r.resultStatus], ["agent", "staged", "career_catchall", "final"]);
      const call = calls.at(-1)!;
      assert(call.user.includes(ADVICE), "the person's question reached the model");
      for (const w of STAGED_WITHHELD_TOOLS) assert(!call.tools.includes(w), `${w} is not offered`);
      for (const k of ["search_jobs", "get_situation", "where_do_i_stand"]) assert(call.tools.includes(k), `${k} is offered`);
      assert(/Applying to a posting, starting or stopping job alerts/.test(call.system), "the staged note is in the system prompt");
      eq(await costRows(PEOPLE["tok-f13c"]), 1, "the brain's turn is metered");
      // Another phrasing: a turn no module claims.
      const o = await say(chat, "I'm so overwhelmed with all of this");
      eq([o.reply, o.body.meta.brain, o.body.meta.router_intent], [ANSWER, "staged", "unclaimed"]);
      eq(calls.length, n + 2);
    });

    await t.step("staged: apply, the card and a job search stay code's; no model call", async () => {
      setBrain("staged");
      const chat = handler!.chat("tok-f13d"), n = calls.length;
      for (const m of ["apply to the Backend Software Engineer role at Ironstack Payments", "show my prepared applications", "find me data analyst jobs in Chicago", "watch data analyst roles in Chicago for me and alert me when new ones post"]) {
        const r = await say(chat, m);
        assert(r.intent !== "agent" && r.body.meta.brain === undefined, `${m}: ${r.intent}`);
        eq(calls.length, n, `${m}: no model call`);
      }
      // A class the owner keeps on the router.
      setBrain("staged", "career_catchall");
      const kept = await say(handler!.chat("tok-f13d"), ADVICE);
      eq([kept.intent, kept.body.meta.brain], ["career_catchall", undefined]);
      eq(calls.length, n, "kept on the router: no model call");
    });

    await t.step("staged, the model fails: the router answers exactly as it would have", async () => {
      setBrain("staged");
      mode = "fail";
      const n = calls.length;
      const r = await say(handler!.chat("tok-f13e"), ADVICE);
      assert(calls.length > n, "the brain was tried");
      eq([r.reply, r.intent, r.body.meta.brain], [routerReply(PEOPLE["tok-f13e"], ADVICE).reply, "career_catchall", undefined], "the router's reply");
    });
  } finally {
    mode = "answer";
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
