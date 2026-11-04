// FEATURE 1 (2026-10-25): apply from chat, through the production handler (handleChat, handler-career.ts) on a real
// Postgres with the real supabase-js client (tests/flow/handler.ts). No browser: this proves the chat side of the path,
// from what the person says to the rows in their apply queue and the worker's prepare being asked for exactly those rows.
//   "find analyst jobs in Chicago"  -> the router lists four postings and keeps the list on the thread
//   "apply to 1 and 3"             -> positions on that list; one queued, the closed one named; "1/2 queued; ..."
//   "apply to the 4th one"         -> the very posting they applied to 10 days ago is named as the same posting (D-MS-3: no 30-day rule); 0/1
//   "apply to all of them"         -> 1/4 queued (1 already in your queue); every refusal named
//   "apply to the X role at Y"     -> the single named ask, 1/1 queued
//   the prepare                    -> off: said "hasn't started"; on (CAREER_PREPARE_AHEAD_URL): the worker is asked with
//                                     exactly the rows just queued, and the reply says it started
//   no resume                      -> another person with no confirmed resume: 0/2 queued, nothing written
//   never                          -> no row in career_apply_jobs, no card: nothing approved or sent without the card tap
// Fail-first on 08832ca79 (origin/arch/diagnosis-1240): "apply to 1 and 3" is not the apply turn (the router answers it),
// nothing is queued, and no reply carries a coverage fraction.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);

Deno.test({
  name: "FEATURE 1: apply from chat through handleChat: positions, all, a named role; coverage and reasons said; the prepare asked for exactly the rows queued; nothing approved or sent",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the apply-from-chat flow needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg = await startPg();
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const env = ["CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN"];
    try {
      await supabaseParity(pg);
      const A = "greenhouse:alpha:1", B = "greenhouse:bravo:2", C = "greenhouse:charlie:3", D = "greenhouse:delta:4", E = "greenhouse:echo:5";
      const rows = [
        [A, "alpha", "Alpha Works", "TEST Analyst"],
        [B, "bravo", "Bravo Labs", "TEST Analyst"],
        [C, "charlie", "Charlie Freight", "Data Analyst"],
        [D, "delta", "Delta Prior", "Data Analyst"],
      ];
      const desc = "TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.";
      const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000f1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000000f2";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${[...rows, [E, "echo", "Echo Systems", "Data Engineer"]].map((r) => `('${r[0]}', 'greenhouse', '${r[1]}', '${r[2]}', '${r[3]}', 'Chicago, IL', 'https://boards.greenhouse.io/${r[1]}/jobs/${r[0].split(":")[2]}', '${desc}', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${rows.map((r, i) => `('${r[0]}', 'greenhouse', '${r[1]}', '${r[2]}', '${r[3]}', 'Chicago, IL', 'https://boards.greenhouse.io/${r[1]}/jobs/${r[0].split(":")[2]}', now() - interval '${i} hours', '${desc}', 'f${i}')`).join(",")};
        insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test'), ('${OTHER}', '${OTHER}@example.test');
        insert into public.profiles (id) values ('${PERSON}'), ('${OTHER}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${OTHER}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
        values ('${PERSON}', 'greenhouse:delta:4', 'Delta Prior', 'https://boards.greenhouse.io/delta/jobs/4', '{}', repeat('a', 64), repeat('a', 64), 'submitted_unconfirmed', now() - interval '10 days');`);
      agentChat = await careerHandler(pg, { "tok-person": PERSON, "tok-other": OTHER });
      // The worker's prepare door, answered here: every request the handler makes to it is kept.
      const kicks: { auth: string | null; body: any }[] = [];
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("http://prepare.test/")) {
          kicks.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
          return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
        }
        return inner(input as any, init);
      }) as typeof fetch;
      for (const k of env) Deno.env.delete(k);
      const chat: Chat = agentChat.chat("tok-person");
      const say = async (c: Chat, message: string) => { const r = await c.say(message); assertEquals(r.status, 200, r.reply); return r; };
      const wanted = async (u = PERSON) => (await pg.sql(`select coalesce(string_agg(posting_key, ',' order by posting_key), '') from public.career_apply_wanted where user_id = '${u}'`)).split(",").filter(Boolean);
      const nothingSent = async () => {
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}' and company <> 'Delta Prior'`), "0", "no application approved: the queue row comes only from the card's tap");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_cards where user_id = '${PERSON}'`), "0", "no card was opened by the apply turn");
      };
      let pos: Record<string, number> = {};

      await t.step("chat: the resume confirmed; the router lists the four postings and keeps the list on the thread", async () => {
        await say(chat, `here is my resume:\n${RESUME}`);
        const yes = await say(chat, "yes, that's my resume");
        assertEquals([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        const r = await say(chat, "find analyst jobs in Chicago");
        assertEquals(r.intent, "career_discovery", r.reply);
        const list = JSON.parse(await pg.sql(`select coalesce((select state->'career'->'stores'->'discovery'->'lastShortlist' from public.agent_flow_state where user_id = '${PERSON}' order by updated_at desc limit 1)::text, '[]')`)) as any[];
        assertEquals(list.length, 4, JSON.stringify(list));
        pos = Object.fromEntries(list.map((e, i) => [String(e.id), i + 1]));
        for (const id of [A, B, C, D]) assert(pos[id], `${id} is on the list: ${JSON.stringify(list)}`);
        assertEquals(await wanted(), []);
        // Bravo closes after it was listed: the next ingest sweep no longer finds it on its board and closes it the way
        // career_ingest's close() does (closed_at set on career_postings). The search lists only open postings (FEATURE 5's
        // live board), so a closed posting reaches the apply turn only like this: listed while open, closed before the ask.
        await pg.sql(`update public.career_postings set closed_at = now() where job_id = '${B}'`);
      });

      await t.step("chat: 'apply to <A> and <B>' by position: A queued, B named as closed; 1/2 queued; the prepare is off and said so", async () => {
        const r = await say(chat, `apply to ${pos[A]} and ${pos[B]}`);
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assert(r.reply.startsWith("1/2 queued; I'll show you each application's exact answers on a card before anything is sent."), r.reply);
        assert(/TEST Analyst at Bravo Labs: posting closed/.test(r.reply), `the closed posting is named with its reason: ${r.reply}`);
        assert(/Preparing it hasn't started yet; it waits in your queue\./.test(r.reply), `off is said, never "started": ${r.reply}`);
        assertEquals(await wanted(), [A]);
        assertEquals(kicks.length, 0, "off: the worker is not asked");
        await nothingSent();
      });

      Deno.env.set("CAREER_PREPARE_AHEAD_URL", "http://prepare.test/run");
      Deno.env.set("CAREER_PREPARE_AHEAD_TOKEN", "TEST-token");
      const ord = ["first", "second", "third", "fourth"];

      await t.step("chat: 'apply to the <Nth> one' on the very posting applied to 10 days ago: 0/1, named as the same posting (D-MS-3: no 30-day rule); nothing asked to prepare", async () => {
        const r = await say(chat, `apply to the ${ord[pos[D] - 1]} one`);
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "refused"], r.reply);
        assert(r.reply.startsWith("0/1 queued."), r.reply);
        assert(/Delta Prior[^\n]*already in your applications as the same posting/.test(r.reply) && !/30 days/.test(r.reply) && !/\btheir\b|\bthey (?:said|set|did|work|named|already)\b|themselves|the person/i.test(r.reply), r.reply);
        assertEquals([await wanted(), kicks.length], [[A], 0]);
      });

      await t.step("chat: 'apply to all of them': 1/4 queued (1 already); each other posting named with its reason; the worker asked for exactly the new row", async () => {
        const r = await say(chat, "apply to all of them");
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assert(r.reply.startsWith("1/4 queued (1 already in your queue); I'll show you each application's exact answers on a card before anything is sent."), r.reply);
        assert(r.reply.includes("Data Analyst at Charlie Freight"), r.reply);
        assert(/Bravo Labs: posting closed/.test(r.reply) && /Delta Prior[^\n]*already in your applications as the same posting/.test(r.reply), r.reply);
        assert(/I've started preparing it now/.test(r.reply), r.reply);
        assertEquals(await wanted(), [A, C].sort());
        assertEquals(kicks, [{ auth: "Bearer TEST-token", body: { user_id: PERSON, job_ids: [C] } }]);
        await nothingSent();
      });

      await t.step("chat: 'apply to the Data Engineer role at Echo Systems': 1/1 queued; the worker asked for it; a repeat changes nothing", async () => {
        const r = await say(chat, "apply to the Data Engineer role at Echo Systems");
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assert(r.reply.startsWith("1/1 queued; I'll show you each application's exact answers on a card before anything is sent. Queued: Data Engineer at Echo Systems"), r.reply);
        assertEquals(kicks.at(-1)?.body, { user_id: PERSON, job_ids: [E] });
        const again = await say(chat, "apply to the Data Engineer role at Echo Systems");
        assertEquals(again.resultStatus, "already", again.reply);
        assertEquals(kicks.length, 2, "nothing new queued, nothing asked to prepare");
        assertEquals(await wanted(), [A, C, E].sort());
        await nothingSent();
      });

      await t.step("chat: a position past the list is named, never guessed", async () => {
        const r = await say(chat, "apply to #9");
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "none"], r.reply);
        assert(/I listed 4/.test(r.reply) && /nothing was queued/.test(r.reply), r.reply);
        assertEquals((await wanted()).length, 3);
      });

      await t.step("chat: another person with no confirmed resume: 'apply to 1 and 2' queues nothing, names both, says what to do", async () => {
        const other: Chat = agentChat!.chat("tok-other");
        const list = await say(other, "find analyst jobs in Chicago");
        assertEquals(list.intent, "career_discovery", list.reply);
        const r = await say(other, "apply to 1 and 2");
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "no_resume"], r.reply);
        assert(r.reply.startsWith("0/2 queued.") && /no resume on file/.test(r.reply) && /Paste or attach your resume, confirm it, then ask again\./.test(r.reply), r.reply);
        assertEquals(await wanted(OTHER), []);
        assertEquals(kicks.length, 2);
      });
    } finally {
      for (const k of env) Deno.env.delete(k);
      agentChat?.restore();
      await pg.stop();
    }
  },
});
