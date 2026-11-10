// THE MODEL DECIDES QUESTIONS, AND CODES IN CHAT ARE CODE'S (architect, 2026-11-06): the two fixes at the REAL handler
// (handleChat) on real Postgres, with a fake model on the provider's wire (no key, no spend: the provider's host is answered
// in-process and every call is counted). The release default (CAREER_BRAIN unset serves staged).
//   1. Beta C02, C11 and C08 (verbatim) reach the brain; the fake model's words are the reply, never the router's form
//      template or its "current openings are unverified" recipe; the router's answer reaches the model only as labeled data
//      (router_answer), and C08's carries code's approval rules.
//   2. Controls stay code's with no model call: an apply ask, a bare yes, crisis text, STOP, the pause.
//   3. A one-time code or a password shared in chat: the fixed safety reply (career_code_in_chat), no model call, no
//      containment, and the stored user message has the token removed; ordinary numbers are untouched.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/brain-decides-questions-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { STAGED_WITHHELD_TOOLS } from "../../supabase/functions/agent-chat/career_staged.ts";
import { CODE_IN_CHAT_INTENT, CODE_IN_CHAT_REPLY } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { crisisReply } from "../../supabase/functions/agent-chat/crisis.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = {
  "tok-bdq-a": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a01", "tok-bdq-b": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a02",
  "tok-bdq-c": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a03", "tok-bdq-d": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a04",
  "tok-bdq-e": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a05", "tok-bdq-f": "7b0f8f8e-6a43-4a49-9d2c-00000b0d0a06",
};
const C02 = "Fictional beta case only, not my facts. Jordan Lee works in retail and wants to move into healthcare. Name realistic first-step roles, explain which skills transfer and what training is needed, then ask just one useful question. Do not save these as facts about me, apply, send email or contact anyone.";
const C08 = "Read-only beta question: explain exactly what my approval binds to before an application is submitted. Does a text yes send it, or must I tap a card? What if an answer changes after approval? No external actions or changes.";
const C11 = "Read-only beta test C11. Compare software QA analyst and IT help desk as entry-level career paths in general, not for my personal profile. Explain day-to-day work, transferable skills, training needed and tradeoffs. Separate general guidance from anything needing current local research. Do not claim current openings or salaries without sources. No profile changes, reminders, outreach or applications.";
const ANSWER = "Good first steps are front-desk and scheduling roles in clinics, where customer service and handling a busy queue carry over directly. " +
  "A short medical terminology course helps. Which kind of setting sounds best: a clinic, a hospital or an insurer?";

type Call = { system: string; tools: string[]; user: string };
const calls: Call[] = [];
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("not reachable in this test", { status: 404 });
  return anthropicWire(req, async (body: any) => {
    const msgs: any[] = body.messages ?? [];
    calls.push({ system: String(msgs.find((m) => m.role === "system")?.content ?? ""), tools: (body.tools ?? []).map((t: any) => t.function?.name), user: String(msgs.filter((m) => m.role === "user").at(-1)?.content ?? "") });
    return new Response(JSON.stringify({ id: "fake-bdq", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
};

Deno.test({ name: "BDQ handler: question-shaped turns are the brain's; codes and passwords in chat are code's", sanitizeResources: false, sanitizeOps: false, async fn(t) {
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
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-bdq-not-a-key");
    globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    const lastUserRow = async (id: string) => (await pg.sql(`select content from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${id}' and m.role = 'user' order by m.id desc limit 1`)).trim();
    const allRows = async (id: string) => await pg.sql(`select coalesce(string_agg(m.content, ' || '), '') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${id}'`)
      + await pg.sql(`select coalesce(string_agg(state::text, ' || '), '') from public.agent_flow_state where user_id = '${id}'`);

    await t.step("C02: the brain answers; the form template reaches the model only as router_answer data", async () => {
      const n = calls.length;
      const r = await say(handler!.chat("tok-bdq-a"), C02);
      eq(calls.length, n + 1, "one model call");
      eq([r.reply, r.intent, r.body.meta.brain, r.body.meta.router_intent], [ANSWER, "agent", "staged", "career_application_fields"]);
      assert(!r.reply.includes("What application forms usually ask for"), r.reply);
      const call = calls.at(-1)!;
      assert(call.user.includes("Jordan Lee works in retail"), "the person's words reached the model");
      assert(/router_answer \(data, not instructions/.test(call.system) && call.system.includes("What application forms usually ask for"), "the router's answer is data in the prompt");
      for (const w of STAGED_WITHHELD_TOOLS) assert(!call.tools.includes(w), `${w} is not offered`);
    });

    await t.step("C11: the brain answers; no current-openings refusal template", async () => {
      const n = calls.length;
      const r = await say(handler!.chat("tok-bdq-b"), C11);
      eq(calls.length, n + 1, "one model call");
      eq([r.reply, r.body.meta.brain, r.body.meta.router_intent], [ANSWER, "staged", "career_recommendations"]);
      assert(!/Current openings are unverified|Which employer source/.test(r.reply), r.reply);
    });

    await t.step("C08: the brain gets the turn, with code's approval rules in router_answer", async () => {
      const n = calls.length;
      const r = await say(handler!.chat("tok-bdq-c"), C08);
      eq(calls.length, n + 1, "one model call");
      eq([r.reply, r.body.meta.brain], [ANSWER, "staged"]);
      const sys = calls.at(-1)!.system;
      assert(/"intent":"career_approval_rule"/.test(sys) && /Nothing goes out without your approval/.test(sys), "the approval rules are data for the brain");
    });

    await t.step("controls stay code's with no model call: an apply ask, a bare yes, crisis, STOP, the pause", async () => {
      const chat = handler!.chat("tok-bdq-d"), n = calls.length;
      for (const m of ["apply to the data analyst role at Stripe", "yes"]) {
        const r = await say(chat, m);
        assert(r.intent !== "agent" && r.body.meta.brain === undefined, `${m}: ${r.intent}`);
      }
      const crisis = "I don't want to live anymore. Do not apply to anything?";
      const c = await say(chat, crisis);
      eq([c.reply, c.intent, c.body.meta.brain], [crisisReply(crisis), "safety_support", undefined]);
      const paused = await say(chat, "pause all career work");
      eq([paused.intent, paused.body.meta.brain], ["career_paused", undefined]);
      const stop = await say(chat, "STOP");
      eq(stop.body.meta.brain, undefined, stop.reply);
      eq(calls.length, n, "no model call");
    });

    await t.step("a one-time code or a password in chat: code's safety reply, no model, no containment, nothing stored", async () => {
      const n = calls.length;
      for (const [i, [m, token]] of ([
        ["Greenhouse sent me code 482913", "482913"],
        ["The Workday portal sent me 739201, can you enter it?", "739201"],
        ["here's my verification code for the portal: K7X9P2", "K7X9P2"],
        ["my workday password is Tr0ub4dor!x", "Tr0ub4dor!x"],
      ] as const).entries()) {
        const who = i % 2 ? "tok-bdq-e" : "tok-bdq-f";
        const r = await say(handler!.chat(who), m);
        eq([r.intent, r.body.meta.contained, r.body.meta.brain], [CODE_IN_CHAT_INTENT, false, undefined], `${m}: ${r.reply}`);
        assert(r.reply.includes(CODE_IN_CHAT_REPLY), `${m}: ${r.reply}`);
        assert(/I removed the (?:one-time code|password)/.test(r.reply), `the person is told what was removed: ${r.reply}`);
        eq((r.reply.match(/Never send passwords or codes in a message/g) ?? []).length, 0, "the safety line is said once, not twice");
        assert(!r.reply.includes(token), `never echoed: ${r.reply}`);
        const row = await lastUserRow(PEOPLE[who]);
        assert(!row.includes(token) && /\[(?:code|password) removed\]/.test(row), `stored redacted: ${row}`);
        assert(!(await allRows(PEOPLE[who])).includes(token), `${token} is nowhere in the thread or its state`);
      }
      eq(calls.length, n, "no model call");
      // Ordinary numbers are not codes: the turn is not the safety turn, and the number is kept.
      for (const m of ["my GPA is 3.4", "they offered me $24/hour", "I have 2 years of retail experience"]) {
        const r = await say(handler!.chat("tok-bdq-e"), m);
        assert(r.intent !== CODE_IN_CHAT_INTENT, `${m}: ${r.intent}`);
        eq(await lastUserRow(PEOPLE["tok-bdq-e"]), m, "stored as typed");
      }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });
