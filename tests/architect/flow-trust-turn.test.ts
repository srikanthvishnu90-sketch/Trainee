// REQS DOC 1 (conversation and trust) through the REAL handler (handleChat) on real Postgres: the questions a person asks
// about Trainee itself (Q33 what it is, Q234/Q239/Q244 privacy, Q235 what it can see, Q202 legal/tax/medical referral,
// Q84/Q127 a bare thanks) are answered by code before the router, from the person's own rows, and change nothing.
// On trunk before this change each of these fell to the router: the "I may have missed what you meant" banner, "that is
// not on your record" for "am I talking to a real person", and the negotiation script for a tax question.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-trust": "7b0f8f8e-6a43-4a49-9d2c-0000000d0c01" };
const FALLBACK = /I may have missed what you meant|I didn't catch that|not sure which part of your search/i;

Deno.test({ name: "REQS DOC 1: trust questions answered by code at the real handler, from the person's rows", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    const me = PEOPLE["tok-trust"];
    await pg.sql(`insert into auth.users (id, email) values ('${me}', '${me}@example.test'); insert into public.profiles (id) values ('${me}');
      insert into public.career_watch_kv (user_id, key, value) values ('${me}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    handler = await careerHandler(pg, PEOPLE);
    const chat: Chat = handler.chat("tok-trust");
    const say = async (message: string) => { const r = await chat.say(message); eq(r.status, 200, r.reply); return r; };
    const count = async (table: string) => Number(await pg.sql(`select count(*) from public.${table} where user_id = '${me}'`));
    // Every turn leaves an agent_turn_costs row (a zero row when no model ran): what counts is the calls in them.
    const calls = async () => Number(await pg.sql(`select coalesce(sum(calls), 0) from public.agent_turn_costs where user_id = '${me}'`));
    const before = { wanted: await count("career_apply_wanted"), drafts: await count("career_outreach_drafts"), calls: await calls() };

    await t.step("Q33: what it is, plainly", async () => {
      for (const m of ["are you a bot?", "am I talking to a real person?"]) {
        const r = await say(m);
        eq(r.intent, "career_identity", `${m}: ${r.reply}`);
        assert(/\bAI\b/.test(r.reply) && /not a (real )?person/i.test(r.reply) && !FALLBACK.test(r.reply), r.reply);
      }
    });

    await t.step("Q234/Q239/Q244: the privacy promise and what is kept", async () => {
      const sell = await say("do you sell my data?");
      eq(sell.intent, "career_privacy", sell.reply);
      assert(/don't sell/i.test(sell.reply) && /forget everything/.test(sell.reply), sell.reply);
      const store = await say("what do you store about me?");
      eq(store.intent, "career_privacy", store.reply);
      assert(/resume/.test(store.reply) && /tracker/.test(store.reply), store.reply);
    });

    await t.step("Q235 (review R1, R2): what it can see and holds follows the person's own rows", async () => {
      const none = await say("can you see my other apps?");
      eq(none.intent, "career_account_access", none.reply);
      assert(/No account is connected/.test(none.reply) && /your contact details/.test(none.reply) && /Nothing else yet/.test(none.reply), none.reply);
      // R1: a send-only Outlook connection is a connection, named from its own scopes.
      await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${me}', 'microsoft', 'oauth_microsoft_${me}', 'me@outlook.example', 'openid https://graph.microsoft.com/Mail.Send');`);
      const out = await say("can you see my other apps?");
      assert(/Outlook: I can send an email only after your yes/.test(out.reply) && !/No account is connected/.test(out.reply), out.reply);
      await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${me}', 'google_career', 'oauth_google_career_${me}', 'me@gmail.example', 'openid email https://www.googleapis.com/auth/gmail.readonly');`);
      const both = await say("can you see my other apps?");
      assert(/Gmail: I read your job mail[^\n]*can't send/.test(both.reply) && /Outlook: I can send/.test(both.reply), both.reply);
      // R2: what Trainee holds is read from the record: an application the person logged in chat is on the tracker.
      const logged = await say("I applied to Vandelay Industries for the Data Analyst role");
      assert(/Vandelay/.test(logged.reply), logged.reply);
      const held = await say("can you see my tracker?");
      eq(held.intent, "career_account_access", held.reply);
      assert(/1 application on your tracker/.test(held.reply) && !/only this chat/.test(held.reply), held.reply);
    });

    await t.step("Q202: a tax question about a bonus is referred, not answered with the negotiation script", async () => {
      const tax = await say("do I owe taxes on my signing bonus?");
      eq(tax.intent, "career_out_of_domain", tax.reply);
      assert(/tax professional/.test(tax.reply) && !/script|word for word/i.test(tax.reply), tax.reply);
      const legal = await say("is it legal for my employer to fire me for this?");
      eq(legal.intent, "career_out_of_domain", legal.reply);
      assert(/lawyer/.test(legal.reply), legal.reply);
    });

    await t.step("re-review 3: a tax question with a counter question keeps the counter question", async () => {
      const r = await say("do I owe taxes on my signing bonus and should I counter");
      assert(/^The tax part is a question for a tax professional/.test(r.reply), r.reply);
      assert(String(r.intent).startsWith("negotiation_") && !FALLBACK.test(r.reply), `the counter ask is answered: ${r.intent}: ${r.reply}`);
    });

    await t.step("re-review 1: distress gets the crisis answer at the real handler, also mid mock interview", async () => {
      for (const m of ["should I see a therapist because I want to die", "I want to die, should I see a doctor", "should I talk to a counselor, I've been thinking about killing myself", "wanna die lol"]) {
        const r = await say(m);
        eq(r.intent, "safety_support", `${m}: ${r.reply}`);
        assert(/988/.test(r.reply) && !/doctor|therapist|won't guess/.test(r.reply), r.reply);
      }
      const mock = await say("mock me for data analyst at Acme");
      eq(mock.intent, "career_mock", mock.reply);
      const answers = async () => Number(await pg.sql(`select coalesce(sum(jsonb_array_length(coalesce(value->'answers', '[]'::jsonb))), 0) from public.career_watch_kv where user_id = '${me}' and value ? 'answers'`));
      const before = await answers();
      const r = await say("In my last internship I built the weekly sales dashboard in SQL and cut reporting time in half, but honestly I want to die");
      eq(await answers(), before, "the mock never recorded the message as an answer");
      eq(r.intent, "safety_support", `a waiting mock question never takes it as an answer: ${r.intent}: ${r.reply}`);
      await say("end mock");
    });

    await t.step("Q84/Q127: a bare thanks is a short acknowledgment, marked so a channel can react instead", async () => {
      const r = await say("thanks!");
      eq(r.intent, "conversation_ack", r.reply);
      eq(r.body?.meta?.ack, true);
      assert(r.reply.split(/\s+/).length <= 2 && !FALLBACK.test(r.reply), r.reply);
    });

    await t.step("none of it changed the person's state or spent a model call", async () => {
      eq(await count("career_apply_wanted"), before.wanted, "nothing queued");
      eq(await count("career_outreach_drafts"), before.drafts, "nothing drafted");
      eq(await calls(), before.calls, "no model call");
    });

    await t.step("career asks still reach the router", async () => {
      // Review R4: a privacy question with a job search in it is the router's whole, never cut to the privacy answer.
      const mixed = await say("is my data safe? find me data analyst jobs");
      assert(mixed.intent !== "career_privacy", `${mixed.intent}: ${mixed.reply}`);
      const r = await say("find me data analyst jobs in Chicago");
      assert(!["career_identity", "career_privacy", "career_account_access", "career_out_of_domain", "conversation_ack"].includes(String(r.intent)), `${r.intent}: ${r.reply}`);
    });

    await t.step("a paused account keeps the host's answer: account controls outrank these answers", async () => {
      const p = await say("pause all career work");
      assert(!FALLBACK.test(p.reply), p.reply);
      const r = await say("are you a bot?");
      assert(r.intent !== "career_identity", `while paused the host answers: ${r.intent}: ${r.reply}`);
      const d = await say("I want to kill myself");
      eq(d.intent, "safety_support", `distress outranks the pause: ${d.intent}: ${d.reply}`);
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
