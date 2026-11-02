// REQS DOC 1 (Q83, Q196): "that's not what I asked", "you're not listening", "this is useless" with nothing else in the
// message: the miss owned in one line, the last answer named from the record, one question; never the catch-all. A message
// that carries the real ask after the complaint stays the router's and re-runs on it. Outcome checks through the REAL
// handler (handleChat) on real Postgres: the intent recorded, the reply's parts, and the thread's search state unchanged.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/reqs-doc1-redo.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { lastAnswerAs, redoAsk, redoTurn } from "../../supabase/functions/_shared/career_redo.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const BANNED = /great question|let me know if|anything else|happy to help|how can i help|i apologi[sz]e for any/i;
const CATCHALL = /I'm not sure which part of your search that's about/;

Deno.test("REDO/1 the asks: a bare complaint is one; a complaint with the real ask, a correction or a job word is not", () => {
  for (const m of ["that's not what I asked", "Thats not what i meant.", "no that's not what I asked for", "not what I asked", "you're not listening", "are you even listening?",
    "you didn't answer my question", "that doesn't answer my question", "you misunderstood me", "you got it wrong", "this is useless", "ugh this is so useless", "not helpful",
    "wrong answer", "bruh", "ugh", "that's not it"]) assert(redoAsk(m), m);
  for (const m of ["that's not what I asked, I want marketing internships in chicago", "no I meant marketing internships", "that's wrong", "that's wrong, my GPA is 3.6",
    "is this job useless for my resume", "not helpful jobs", "find me jobs", "thanks", "no", "wrong company on my resume", "you got it", "useless skills to list?"]) assert(!redoAsk(m), m);
});

Deno.test("REDO/2 the reply: the miss owned, the last answer named from the record only, one question, nothing banned", () => {
  const disc = { lastParams: { roleText: "data analyst internships", whereText: null } };
  const r = redoTurn({ message: "that's not what I asked", lastIntent: "career_internship_discovery", discovery: disc })!;
  eq(r.intent, "conversation_redo");
  eq(r.reply, "You're right, that answer missed what you asked. I took your last message as a job search for data analyst internships. What did you want instead? A few words is enough, like the role and city or the task, and I'll redo it now.");
  eq((r.reply.match(/\?/g) ?? []).length, 1, "one question");
  assert(!BANNED.test(r.reply) && !/—|;/.test(r.reply), r.reply);
  eq(lastAnswerAs("career_discovery", { lastParams: { roleText: "nurse", whereText: "Denver" } }), "a job search for nurse in Denver");
  eq(lastAnswerAs("career_discovery", null), "a job search", "no search on record: the role is never guessed");
  eq(lastAnswerAs("career_catchall", null), "something I couldn't place");
  eq(lastAnswerAs("some_new_intent", null), null);
  eq(lastAnswerAs("prep_brief", null), "interview prep");
  eq(lastAnswerAs("career_mock", null), "interview prep");
  assert(lastAnswerAs("packet_prep", null) !== "interview prep", "an application packet is not interview prep");
  assert(lastAnswerAs("career_apply_prepared", null) !== "interview prep", "a prepared application is not interview prep");
  const u = redoTurn({ message: "you're not listening", lastIntent: null })!;
  eq(u.status, "asked_unknown");
  assert(!/I took your last message as/.test(u.reply), `nothing said about an answer not on record: ${u.reply}`);
  eq(redoTurn({ message: "find me jobs", lastIntent: "career_discovery" }), null);
});

const PEOPLE: Record<string, string> = { "tok-d1": "7b0f8f8e-6a43-4a49-9d2c-0000000ad001" };

Deno.test({ name: "REDO/3 the real handler on real Postgres: a bare complaint gets the redo turn, never the catch-all; the search state is unchanged; the real ask still runs", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    const D1 = PEOPLE["tok-d1"];
    await pg.sql(`insert into auth.users (id, email) values ('${D1}', 'd1@example.test'); insert into public.profiles (id) values ('${D1}');
      insert into public.career_watch_kv (user_id, key, value) values ('${D1}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, text: string) => { const r = await c.say(text); eq(r.status, 200, r.reply); return r; };
    const discovery = async (thread: string | null) => JSON.parse((await pg.sql(`select coalesce(state->'career'->'stores'->'discovery'->'lastParams', 'null'::jsonb) from public.agent_flow_state where thread_id = '${thread}'`)) || "null");

    await t.step("after a search: the miss owned, the search named from the record, one question; nothing in the search state changes", async () => {
      const c = handler!.chat("tok-d1");
      const s = await say(c, "find me data analyst internships");
      assert(/discovery/.test(String(s.intent)), `${s.intent}: ${s.reply}`);
      const before = await discovery(c.thread());
      assert(before && before.roleText, JSON.stringify(before));
      const r = await say(c, "that's not what I asked");
      eq([r.intent, r.resultStatus], ["conversation_redo", "asked"], r.reply);
      assert(r.reply.startsWith("You're right, that answer missed what you asked."), r.reply);
      assert(r.reply.includes(`I took your last message as a job search for ${before.roleText}.`), r.reply);
      eq((r.reply.match(/\?/g) ?? []).length, 1, r.reply);
      assert(!CATCHALL.test(r.reply) && !BANNED.test(r.reply), r.reply);
      eq(await discovery(c.thread()), before, "read only: the search state is unchanged");
      const next = await say(c, "you're not listening");
      eq([next.intent, next.resultStatus], ["conversation_redo", "asked_unknown"], `the redo's own reply is no answer to name: ${next.reply}`);
    });

    await t.step("the real ask after the complaint runs: the router re-runs the search on it", async () => {
      const c = handler!.chat("tok-d1");
      await say(c, "find me data analyst internships");
      const r = await say(c, "that's not what i asked, i want marketing internships");
      assert(r.intent !== "conversation_redo" && /discovery/.test(String(r.intent)), `${r.intent}: ${r.reply}`);
      assert(/marketing/i.test(JSON.stringify(await discovery(c.thread()))), "the search now runs on what they asked for");
    });

    await t.step("a new thread with no answer yet: owned and asked, nothing claimed about an answer", async () => {
      const r = await say(handler!.chat("tok-d1"), "this is useless");
      eq([r.intent, r.resultStatus], ["conversation_redo", "asked_unknown"], r.reply);
      assert(!CATCHALL.test(r.reply), r.reply);
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
