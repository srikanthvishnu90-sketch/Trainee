// SERIAL-1490 / SERIAL-1491 (2026-10-25): the shared-matcher contract through the REAL handler (handleChat) on real
// Postgres, no test-only seam: the person's own words ("I work at X") land on the thread's stated facts, and each apply
// ask runs the protective screen over them.
//   exact name     "I work at Contoso Analytics" + "apply to ... at Contoso Analytics": refused as their current employer
//   distinct       ... + "apply to ... at Fabrikam Data": queued; the two employers are not confused
//   partial name   "I work at Acme" + "apply to ... at Acme Robotics Inc": one question, nothing queued; "no" queues it
//                  once; "no" again stands (nothing asked again, nothing queued twice); "apply to ... at Acme Health":
//                  asked; "yes" keeps it out; "yes" again stands; asking for Acme Health again is a plain refusal
//   batch          "apply to these" over the thread's list: the distinct employers queue, the question attaches to the
//                  Acme postings only; the answer names the company while two are open
// Regression test for the shared matcher's two contracts (employer-matcher-contract.test.ts is the unit pin).
// OWNER RULE (2026-10-26, "never submit applications without a real resume"): nothing is queued for a person with no
// confirmed resume, so each person here first gives theirs (the synthetic TEST resume) and confirms it, as a real person
// would; every employer-guard assertion below is unchanged.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = { "tok-a": "7b0f8f8e-6a43-4a49-9d2c-0000000000a1", "tok-b": "7b0f8f8e-6a43-4a49-9d2c-0000000000b2", "tok-c": "7b0f8f8e-6a43-4a49-9d2c-0000000000c3" };
const ROWS: [string, string, string, string, string, string][] = [
  ["greenhouse:acmerobotics:1", "greenhouse", "acmerobotics", "Acme Robotics Inc", "Data Analyst", "https://boards.greenhouse.io/acmerobotics/jobs/1"],
  ["lever:acmehealth:2", "lever", "acmehealth", "Acme Health", "Data Analyst", "https://jobs.lever.co/acmehealth/2"],
  ["greenhouse:contoso:3", "greenhouse", "contoso", "Contoso Analytics", "Data Analyst", "https://boards.greenhouse.io/contoso/jobs/3"],
  ["greenhouse:fabrikam:4", "greenhouse", "fabrikam", "Fabrikam Data", "Data Analyst", "https://boards.greenhouse.io/fabrikam/jobs/4"],
];
const ASK_INTENT = "career_apply_employer_ask", ANSWER_INTENT = "career_apply_employer_answer";
const RESUME = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));

Deno.test({ name: "SERIAL-1490/1491: the employer guard at the real handler: exact refusal, distinct employers, a partial name asked once, repeated answers stand", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    const desc = "Data Analyst. Requirements: SQL, Python, dashboards for internal teams.";
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      ${ROWS.map((r) => `('${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}', '${r[4]}', 'Chicago, IL', '${r[5]}', '${desc}', now(), now())`).join(",")};
      insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
      ${ROWS.map((r, i) => `('${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}', '${r[4]}', 'Chicago, IL', '${r[5]}', now() - interval '${i} hours', '${desc}', 'h${i}')`).join(",")};`);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    handler = await careerHandler(pg, PEOPLE);
    const wanted = async (person: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(posting_key order by posting_key), '[]') from public.career_apply_wanted where user_id = '${person}'`)) as string[];
    const say = async (chat: Chat, message: string) => { const r = await chat.say(message); eq(r.status, 200, r.reply); return r; };
    // The seed (OWNER RULE 2026-10-26): the person's resume, pasted and confirmed in the same thread, evidenced.
    const withResume = async (chat: Chat, person: string) => {
      eq((await say(chat, `here is my resume:\n${RESUME}`)).intent, "career_resume_ingest");
      const yes = await say(chat, "yes, that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
      eq(await pg.sql(`select public.career_resume_on_file('${person}')`), "t", "a confirmed resume on file");
    };

    await t.step("exact name: their current employer is refused; a distinct employer is queued, not confused", async () => {
      const chat = handler!.chat("tok-a"), me = PEOPLE["tok-a"];
      await withResume(chat, me);
      const said = await say(chat, "I work at Contoso Analytics");
      eq(said.intent, "profile_correction", said.reply);
      const exact = await say(chat, "apply to the Data Analyst role at Contoso Analytics");
      eq([exact.intent, exact.resultStatus], ["career_apply_queue", "refused"], exact.reply);
      assert(/Contoso Analytics is your current employer/.test(exact.reply) && !/where you work now\?/.test(exact.reply) && !/\btheir\b|\bthey (?:said|set|did|work|named|already)\b|themselves|the person/i.test(exact.reply), exact.reply);
      eq(await wanted(me), []);
      const other = await say(chat, "apply to the Data Analyst role at Fabrikam Data");
      eq([other.intent, other.resultStatus], ["career_apply_queue", "queued"], other.reply);
      eq(await wanted(me), ["greenhouse:fabrikam:4"]);
      eq((await say(chat, "no")).intent !== ANSWER_INTENT, true, "no question open: a bare no is not an answer to one");
      eq(await wanted(me), ["greenhouse:fabrikam:4"]);
    });

    await t.step("partial name: asked once; no queues it once; no again stands; yes keeps the other out; yes again stands; no second question", async () => {
      const chat = handler!.chat("tok-b"), me = PEOPLE["tok-b"];
      await withResume(chat, me);
      eq((await say(chat, "I work at Acme")).intent, "profile_correction");
      const ask = await say(chat, "apply to the Data Analyst role at Acme Robotics Inc");
      eq([ask.intent, ask.resultStatus], [ASK_INTENT, "asking_employer"], ask.reply);
      assert(/is Acme Robotics Inc where you work now\?/.test(ask.reply) && /nothing is queued there until you do/.test(ask.reply), ask.reply);
      eq(await wanted(me), [], "nothing queued on an unresolved possible match");
      const no = await say(chat, "no");
      eq([no.intent, no.resultStatus], [ANSWER_INTENT, "queued"], no.reply);
      assert(/Queued: Data Analyst at Acme Robotics Inc/.test(no.reply) && /Nothing is sent and nothing is filled yet/.test(no.reply), no.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1"]);
      const no2 = await say(chat, "no");
      eq([no2.intent, no2.resultStatus], [ANSWER_INTENT, "stands"], no2.reply);
      assert(/Nothing was asked again and nothing more was queued/.test(no2.reply), no2.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1"], "not queued twice");
      const ask2 = await say(chat, "apply to the Data Analyst role at Acme Health");
      eq([ask2.intent, ask2.resultStatus], [ASK_INTENT, "asking_employer"], ask2.reply);
      assert(/is Acme Health where you work now\?/.test(ask2.reply), ask2.reply);
      const yes = await say(chat, "yes");
      eq([yes.intent, yes.resultStatus], [ANSWER_INTENT, "is_employer"], yes.reply);
      assert(/Acme Health is where you work now/.test(yes.reply) && /nothing was queued/.test(yes.reply), yes.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1"]);
      const yes2 = await say(chat, "yes");
      eq([yes2.intent, yes2.resultStatus], [ANSWER_INTENT, "stands"], yes2.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1"]);
      const again = await say(chat, "apply to the Data Analyst role at Acme Health");
      eq([again.intent, again.resultStatus], ["career_apply_queue", "refused"], again.reply);
      assert(/you said so when I asked/.test(again.reply) && !/where you work now\?/.test(again.reply), `their answer is remembered on the thread: ${again.reply}`);
      const back = await say(chat, "apply to the Data Analyst role at Acme Robotics Inc");
      eq([back.intent, back.resultStatus], ["career_apply_queue", "already"], `their no is remembered too: ${back.reply}`);
      eq(await wanted(me), ["greenhouse:acmerobotics:1"]);
    });

    await t.step("batch: the question attaches to its postings only; the rest queue; the answer names the company while two are open", async () => {
      const chat = handler!.chat("tok-c"), me = PEOPLE["tok-c"];
      await withResume(chat, me);
      eq((await say(chat, "I work at Acme")).intent, "profile_correction");
      const found = await say(chat, "find analyst jobs in Chicago");
      eq(found.intent, "career_discovery", found.reply);
      for (const r of ROWS) assert(found.reply.includes(r[3]), `${r[3]} listed: ${found.reply}`);
      const batch = await say(chat, "apply to these");
      eq([batch.intent, batch.resultStatus], [ASK_INTENT, "queued"], batch.reply);
      eq(await wanted(me), ["greenhouse:contoso:3", "greenhouse:fabrikam:4"], "the distinct employers queue");
      assert(/Queued 2 of the 4/.test(batch.reply) && /is Acme Robotics Inc where you work now\?/.test(batch.reply) && /is Acme Health where you work now\?/.test(batch.reply), batch.reply);
      const which = await say(chat, "no");
      eq([which.intent, which.resultStatus], [ASK_INTENT, "which"], which.reply);
      eq(await wanted(me), ["greenhouse:contoso:3", "greenhouse:fabrikam:4"]);
      const one = await say(chat, "Acme Robotics Inc: no");
      eq([one.intent, one.resultStatus], [ASK_INTENT, "queued"], one.reply);
      assert(/Still open: Acme Health/.test(one.reply), one.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1", "greenhouse:contoso:3", "greenhouse:fabrikam:4"]);
      const last = await say(chat, "yes");
      eq([last.intent, last.resultStatus], [ANSWER_INTENT, "is_employer"], last.reply);
      eq(await wanted(me), ["greenhouse:acmerobotics:1", "greenhouse:contoso:3", "greenhouse:fabrikam:4"]);
      const rerun = await say(chat, "apply to these");
      eq(rerun.resultStatus, "already", rerun.reply);
      assert(!/where you work now\?/.test(rerun.reply) && /you said so when I asked/.test(rerun.reply), rerun.reply);
      eq((await wanted(me)).length, 3);
      eq(await wanted(PEOPLE["tok-a"]), ["greenhouse:fabrikam:4"], "another person's queue is untouched");
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
