// REQS DOC 1 follow-up: "forget everything" (the policy's own delete) deletes the person's chat messages too. Through the
// REAL handler on real Postgres: two people text in two threads each and have replies waiting in the outbox; one says
// "forget everything" and confirms. That person's chat messages are gone from every thread (only the answer confirming the
// erase is kept), their thread titles are cleared and their unsent outbox copies are gone; the other person's messages,
// titles and outbox are untouched, row for row. Fail-first: on trunk the erase kept agent_messages and titles.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-erase": "7b0f8f8e-6a43-4a49-9d2c-0000000e0a01", "tok-keep": "7b0f8f8e-6a43-4a49-9d2c-0000000e0a02" };

Deno.test({ name: "forget everything deletes the person's chat messages, every thread, and nobody else's", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const [me, other] = [PEOPLE["tok-erase"], PEOPLE["tok-keep"]];
    handler = await careerHandler(pg, PEOPLE);
    const ok = async (c: ReturnType<NonNullable<typeof handler>["chat"]>, m: string) => { const r = await c.say(m); eq(r.status, 200, r.reply); return r; };
    // Two threads each (the web app and a texting channel both write threads of the same person).
    const mine = [handler.chat("tok-erase"), handler.chat("tok-erase")], theirs = [handler.chat("tok-keep"), handler.chat("tok-keep")];
    for (const c of [...mine, ...theirs]) { await ok(c, "my secret target is Initech, keep that between us"); await ok(c, "find me data analyst jobs in Chicago"); }
    // A reply waiting to go out to each person (an outbox copy not sent yet).
    for (const id of [me, other]) {
      await pg.sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${id}', 'reply:pending-${id}', 'reply', 'about Initech: your private note', now() + interval '1 hour');`);
    }
    const messages = async (u: string) => (await pg.sql(`select coalesce(string_agg(m.content, ' | ' order by m.id), '') from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${u}'`));
    const count = async (sql: string) => Number(await pg.sql(sql));
    const threadsOf = (u: string) => `select count(*) from public.agent_threads where user_id = '${u}'`;
    const theirsBefore = { msgs: await messages(other), titles: await pg.sql(`select string_agg(coalesce(title, '-'), '|' order by id) from public.agent_threads where user_id = '${other}'`),
      outbox: await count(`select count(*) from public.career_outbox where user_id = '${other}' and delivered_at is null`) };
    assert(/Initech/.test(await messages(me)) && /Initech/.test(theirsBefore.msgs), "both people's messages are stored before the erase");
    eq(await count(threadsOf(me)), 2);

    await t.step("the erase deletes this person's messages in every thread, their titles and their unsent outbox copies", async () => {
      const ask = await ok(mine[0], "forget everything");
      eq(ask.intent, "career_erase_confirm", ask.reply);
      assert(/chat messages go too/.test(ask.reply), `the confirmation says the messages go: ${ask.reply}`);
      const done = await ok(mine[0], "yes, erase it");
      eq(done.intent, "career_profile_erased", done.reply);
      const left = await pg.sql(`select coalesce(string_agg(m.role || ':' || m.content, ' | ' order by m.id), '') from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${me}'`);
      assert(!/Initech|find me data analyst|forget everything/.test(left), `nothing from before the erase is kept: ${left}`);
      eq(await count(`select count(*) from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${me}'`), 2, `only the erase turn itself is kept: ${left}`);
      assert(/deleted our chat messages/.test(left), `the kept answer says the messages were deleted: ${left}`);
      eq(await count(`select count(*) from public.agent_threads where user_id = '${me}' and title is not null`), 0, "the thread titles (first words of the chat) are cleared");
      eq(await count(`select count(*) from public.career_outbox where user_id = '${me}' and delivered_at is null`), 0, "the unsent outbox copy is gone");
    });

    await t.step("the other person's messages, titles and outbox are untouched", async () => {
      eq(await messages(other), theirsBefore.msgs);
      eq(await pg.sql(`select string_agg(coalesce(title, '-'), '|' order by id) from public.agent_threads where user_id = '${other}'`), theirsBefore.titles);
      eq(await count(`select count(*) from public.career_outbox where user_id = '${other}' and delivered_at is null`), theirsBefore.outbox);
      assert(theirsBefore.outbox === 1);
    });

    await t.step("a pause alone (no erase) deletes no message", async () => {
      const before = await messages(other);
      await ok(theirs[0], "pause all career work");
      assert((await messages(other)).startsWith(before), "every earlier message is still there after a pause");
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
