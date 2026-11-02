// FEATURE 13 (owner, 2026-10-25): the staged brain release at the REAL handler (handleChat) on real Postgres, with a fake
// model on the OpenAI wire (no key, no spend: the provider's URL is answered in-process and every call is counted).
//   1. D-035 (owner, 2026-11-01: "Ship staged brain"): CAREER_BRAIN unset serves the committed release brain (staged), so
//      an advice question goes to the brain; CAREER_BRAIN=router (the emergency rollback) answers every turn with the
//      router, byte-identical to the router run directly on the same state, and the model is never called.
//   2. CAREER_BRAIN=staged: an advice question goes to the brain (the fake model's words are the reply, the tools offered
//      exclude the actions code owns); an apply ask, a card ask and a job search stay code's, with no model call; a class
//      the owner keeps (CAREER_BRAIN_ROUTER_INTENTS) stays on the router.
//   3. The model fails: the router answers, exactly as it would have.
//   4. D-035, the code-enforced rules under the release default: crisis text gets code's 988 reply (no model call); a
//      fact the model invents about the person is not delivered (the fact lock, D-007); STOP and the pause are the host's;
//      a resume's facts are confirmed only by the person's own yes to the exact facts shown (router, no model call).
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/f13-staged-brain-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { STAGED_WITHHELD_TOOLS } from "../../supabase/functions/agent-chat/career_staged.ts";
import { crisisReply } from "../../supabase/functions/agent-chat/crisis.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = {
  "tok-f13a": "7b0f8f8e-6a43-4a49-9d2c-0000000f1301", "tok-f13b": "7b0f8f8e-6a43-4a49-9d2c-0000000f1302",
  "tok-f13c": "7b0f8f8e-6a43-4a49-9d2c-0000000f1303", "tok-f13d": "7b0f8f8e-6a43-4a49-9d2c-0000000f1304",
  "tok-f13e": "7b0f8f8e-6a43-4a49-9d2c-0000000f1305", "tok-f13f": "7b0f8f8e-6a43-4a49-9d2c-0000000f1306",
  "tok-f13g": "7b0f8f8e-6a43-4a49-9d2c-0000000f1307", "tok-f13h": "7b0f8f8e-6a43-4a49-9d2c-0000000f1308",
  "tok-f13i": "7b0f8f8e-6a43-4a49-9d2c-0000000f1309",
};
const RESUME = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
// What the fake model says in "invent" mode: a school and a GPA the person never gave (the fact lock must stop both).
const INVENTED = "With your 3.9 GPA from Stanford University you are a strong fit for these roles. Send a short thank-you note within a day.";
const ADVICE = "how should I follow up after an interview?";
const ANSWER = "Send a short thank-you note within a day that names one thing you discussed, then ask when they expect to decide. " +
  "If that date passes with no word, send one polite follow-up asking whether there is an update.";

// The fake OpenAI endpoint: each request is kept (its system prompt and tool names); "fail" answers 500.
type Call = { system: string; tools: string[]; user: string };
const calls: Call[] = [];
let mode: "answer" | "fail" | "invent" = "answer";
const fakeOpenAI = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  const url = new URL(req.url);
  if (url.hostname !== "api.openai.com") return new Response("not reachable in this test", { status: 404 });
  const body = await req.json();
  const msgs: any[] = body.messages ?? [];
  calls.push({ system: String(msgs.find((m) => m.role === "system")?.content ?? ""), tools: (body.tools ?? []).map((t: any) => t.function?.name), user: String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "") });
  if (mode === "fail") return new Response(JSON.stringify({ error: { type: "server_error", message: "fake outage" } }), { status: 500, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ id: "fake-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: mode === "invent" ? INVENTED : ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
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

    await t.step("D-035 rollback (CAREER_BRAIN=router): the router answers, byte-identical to the router itself; no model call", async () => {
      setBrain("router");
      const chat = handler!.chat("tok-f13a"), n = calls.length;
      const r = await say(chat, ADVICE);
      const direct = routerReply(PEOPLE["tok-f13a"], ADVICE);
      eq([r.reply, r.intent], [direct.reply, direct.intent], "the router's own reply, unchanged");
      eq(r.intent, "career_catchall");
      eq(r.body.meta.brain, undefined);
      eq(calls.length, n, "no model call");
      // Any other value rolls back too (a typo never leaves the brain on).
      setBrain("routr");
      const k = await say(handler!.chat("tok-f13b"), ADVICE);
      eq([k.reply, k.intent, k.body.meta.brain], [routerReply(PEOPLE["tok-f13b"], ADVICE).reply, "career_catchall", undefined]);
      eq(calls.length, n, "no model call with the kill switch");
      eq(await costRows(PEOPLE["tok-f13a"]) + await costRows(PEOPLE["tok-f13b"]), 0, "no metered turn");
    });

    await t.step("D-035 unset: the committed release config serves staged; the advice question goes to the brain", async () => {
      setBrain(null);
      const n = calls.length;
      const r = await say(handler!.chat("tok-f13f"), ADVICE);
      eq(calls.length, n + 1, "one model call");
      eq([r.reply, r.intent, r.body.meta.brain, r.body.meta.router_intent], [ANSWER, "agent", "staged", "career_catchall"]);
      for (const w of STAGED_WITHHELD_TOOLS) assert(!calls.at(-1)!.tools.includes(w), `${w} is not offered`);
    });

    await t.step("D-035 unset: crisis text gets code's crisis reply (988), never the brain", async () => {
      setBrain(null);
      const chat = handler!.chat("tok-f13g"), n = calls.length;
      for (const m of ["I'm thinking about suicide", "I don't want to live anymore, this job search is hopeless"]) {
        const r = await say(chat, m);
        eq([r.reply, r.intent, r.body.meta.brain], [crisisReply(m), "safety_support", undefined], m);
        assert(/\b988\b/.test(r.reply), `${m}: 988 is in the reply`);
      }
      eq(calls.length, n, "no model call on crisis text");
    });

    await t.step("D-035 unset: STOP and the pause are the host's; a resume is confirmed only by the person's own yes, by code", async () => {
      setBrain(null);
      const chat = handler!.chat("tok-f13h"), n = calls.length;
      const pasted = await say(chat, `here is my resume:\n${RESUME}`);
      eq([pasted.intent, pasted.body.meta.brain], ["career_resume_ingest", undefined], pasted.reply);
      const yes = await say(chat, "yes, that's my resume");
      eq([yes.intent, yes.resultStatus, yes.body.meta.brain], ["career_resume_ingest", "completed", undefined], `the yes confirms exactly the shown facts: ${yes.reply}`);
      const paused = await say(chat, "pause all career work");
      eq([paused.intent, paused.body.meta.brain], ["career_paused", undefined]);
      // While paused every turn is the host's, advice included: nothing reaches the brain.
      const asked = await say(chat, ADVICE);
      eq(asked.body.meta.brain, undefined, asked.reply);
      const stop = await say(chat, "STOP");
      eq(stop.body.meta.brain, undefined, stop.reply);
      eq(calls.length, n, "no model call on an approval, a pause or STOP");
    });

    await t.step("D-035 unset: a fact the model invents about the person is never delivered (fact lock, D-007)", async () => {
      setBrain(null);
      mode = "invent";
      try {
        const n = calls.length;
        const r = await say(handler!.chat("tok-f13i"), "how should I talk about my education in an interview?");
        eq(r.body.meta.brain, "staged", r.reply);
        assert(calls.length >= n + 2, "the draft was put back to the model once (code's review)");
        assert(!/Stanford/.test(r.reply) && !/\b3\.9\b/.test(r.reply), `an invented school or GPA reached the person: ${r.reply}`);
        assert(/thank-you note/.test(r.reply), `the supported advice stays: ${r.reply}`);
      } finally { mode = "answer"; }
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
