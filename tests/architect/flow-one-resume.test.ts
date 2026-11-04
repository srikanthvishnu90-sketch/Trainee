// ONE CONFIRMED RESUME through the REAL chat handler (handleChat, supabase/functions/agent-chat/handler-career.ts) on real
// Postgres in CI's migration order, with the real supabase-js client; the only seam is the HTTP hop to the Supabase
// project (tests/flow/postgrest.ts). A brand-new person texts (the request every texting channel sends: the service key
// and as_user_id, channel_runtime.ts chatThroughAgent), then uses the web app (their own session):
//   texting  pastes their resume with a messy lead-in and confirms it -> the one record is that message, by its sha256
//   texting  "what resume do you have?" -> said from the record, including that the cloud has no file to attach
//   web      "apply to the <role> role at <Company>" -> on their queue: the resume confirmed by text is theirs on the web
//   texting  pastes a different resume and confirms it -> the record moves to it (generation 2)
//   web      "delete my resume pls" -> every copy gone; the reply says nothing will be prepared or sent until a new one
//   texting  "apply to" a second posting -> the plain no-resume reply; nothing prepared, queued or sent
//   web      "do you have my resume" -> none
// CAREER_ACCOUNT_MEMORY stays off (the default). The server prepare is not configured (no CAREER_PREPARE_AHEAD_URL).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const RESUME2 = RESUME.replace("LEADERSHIP", "EXPERIENCE\nData Analyst Intern, Northwind Traders (TEST), January 2026 - May 2026\n- Built weekly sales dashboards in SQL and Tableau for 6 regional managers\n\nLEADERSHIP");
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
const JOB = "greenhouse:onerestest:11", COMPANY = "TEST One Resume Employer", ROLE = "TEST Analyst";
const JOB2 = "greenhouse:onerestwo:12", COMPANY2 = "TEST Second Employer";
const JOB3 = "greenhouse:oneresthree:13", COMPANY3 = "TEST Third Employer";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

Deno.test({ name: "one confirmed resume, a new person on a texting channel and the web: paste, change, ask, delete, apply blocked", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) {
    if (CI) throw Error("the one-resume chat flow needs Postgres 16 in CI");
    console.log("NOT_RUN locally: no Postgres binaries");
    return;
  }
  const pg: Pg = await startPg();
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
      values ('${JOB}', 'greenhouse', 'onerestest', '${COMPANY}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/onerestest/jobs/11',
      '${ROLE}. Requirements: SQL, Python, dashboards.', now(), now()),
      ('${JOB2}', 'greenhouse', 'onerestwo', '${COMPANY2}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/onerestwo/jobs/12',
      '${ROLE}. Requirements: SQL, Python, dashboards.', now(), now()),
      ('${JOB3}', 'greenhouse', 'oneresthree', '${COMPANY3}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/oneresthree/jobs/13',
      '${ROLE}. Requirements: SQL, Python, dashboards.', now(), now());
      insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test'); insert into public.profiles (id) values ('${PERSON}');
      insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    h = await careerHandler(pg, { "tok-one": PERSON });
    const handleChat = (await import("../../supabase/functions/agent-chat/handler-career.ts")).handleChat;
    let textThread: string | null = null, n = 0;
    const text = async (message: string) => {
      const res = await handleChat(new Request(`${SUPABASE_URL}/functions/v1/agent-chat`, {
        method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ as_user_id: PERSON, message, turn_key: `sms-${++n}-${Date.now()}`, ...(textThread ? { thread_id: textThread } : {}) }),
      }));
      const body = await res.json().catch(() => ({}));
      if (body?.thread_id) textThread = body.thread_id;
      eq(res.status, 200, `${message.slice(0, 40)}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      return { reply: String(body?.reply ?? ""), intent: body?.meta?.intent ?? null, resultStatus: body?.meta?.result_status ?? null };
    };
    const web = h.chat("tok-one");
    const say = async (m: string) => { const r = await web.say(m); eq(r.status, 200, r.reply); return r; };
    const record = async () => JSON.parse((await pg.sql(`select coalesce((select json_build_object('state', state, 'kind', kind, 'sha256', sha256, 'generation', generation)::text
      from public.career_resume_record where user_id = '${PERSON}'), 'null')`)) || "null");
    const storedSha = async (needle: string) => sha(await pg.sql(`select m.content from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
      where t.user_id = '${PERSON}' and m.role = 'user' and m.content like ${"$n$%" + needle + "%$n$"} order by m.id desc limit 1`));

    await t.step("texting: a messy paste, confirmed, is the one resume, by the sha256 of the message they sent", async () => {
      eq(await record(), null, "a new person has none");
      const pasted = await text(`ok here is my resume:\n${RESUME}`);
      eq(pasted.intent, "career_resume_ingest", pasted.reply);
      eq(await record(), null, "nothing is the resume until they confirm it");
      const yes = await text("yes that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
      const r = await record();
      eq([r?.state, r?.kind, r?.generation], ["confirmed", "paste", 1]);
      eq(r.sha256, await storedSha("Alex Testcase"), "the record is the message they pasted, byte for byte");
    });

    await t.step("texting: 'what resume do you have?' is answered from the record", async () => {
      const a = await text("what resume do you have?");
      eq(a.intent, "career_resume_record", a.reply);
      ok(/^The resume on file is the resume you pasted and confirmed on \d{4}-\d{2}-\d{2}\. Every application I prepare uses only it/.test(a.reply), a.reply);
      ok(/applications sent from the cloud have no file of yours to attach/.test(a.reply), a.reply);
    });

    const wanted = () => pg.sql(`select coalesce(string_agg(posting_key || ':' || state, ',' order by posting_key), '') from public.career_apply_wanted where user_id = '${PERSON}'`);
    await t.step("web: the resume confirmed by text is theirs on the web: 'apply to ...' puts the posting on their queue", async () => {
      const r = await say(`apply to the ${ROLE} role at ${COMPANY}`);
      eq(r.intent, "career_apply_queue", r.reply);
      ok(!/no confirmed resume/i.test(r.reply), `not refused for a resume: ${r.reply}`);
      eq(await wanted(), `${JOB}:waiting`);
    });

    await t.step("texting: a different resume, confirmed, replaces it", async () => {
      const before = (await record()).sha256;
      const pasted = await text(`actually use this one instead, I added my new internship:\n${RESUME2}`);
      eq(pasted.intent, "career_resume_ingest", pasted.reply);
      const yes = await text("yes, that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
      const r = await record();
      eq([r.state, r.kind, r.generation], ["confirmed", "paste", 2]);
      ok(r.sha256 !== before);
      eq(r.sha256, await storedSha("Northwind Traders"));
    });

    await t.step("web: 'delete my resume pls' deletes every copy and says what follows", async () => {
      const d = await say("delete my resume pls");
      eq(d.intent, "career_resume_record", d.reply);
      ok(/^Deleted the resume you pasted and confirmed on \d{4}-\d{2}-\d{2}; I keep no copy of it\. The entries you confirmed from it stay in your profile until you say "forget my career profile", and no application uses them without a resume on file\. No application will be prepared or sent until you paste your resume here and confirm it\.$/.test(d.reply), d.reply);
      const r = await record();
      eq([r.state, r.sha256], ["deleted", null]);
      eq(await pg.sql(`select count(*) from public.career_apply_cloud_resumes where user_id = '${PERSON}'`), "0");
      const again = await say("do you have my resume");
      ok(/^I don't have a resume on file for you\./.test(again.reply), again.reply);
    });

    await t.step("texting: applying after the delete is refused in plain words; nothing prepared, queued or sent", async () => {
      const r = await text(`apply to the ${ROLE} role at ${COMPANY2}`);
      // In #211's words or #194's (whichever turn answers first): no confirmed resume on file.
      ok(/no confirmed resume on file|no resume on file: I have no confirmed resume/i.test(r.reply), `the reply says why: ${r.reply}`);
      ok(!/\bapplied\b|\bsubmitted\b(?! yet)/i.test(r.reply.replace(/nothing (is|was|has been) (sent|submitted)/ig, "")), `no submission claimed: ${r.reply}`);
      eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "0");
      eq(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}'`), "0");
      const p = await pg.asService().rpc("career_apply_profile_for", { p_user: PERSON });
      eq((p.data?.facts ?? []).filter((f: any) => ["experience", "education", "project", "leadership", "certification"].includes(f.kind)), [],
        "what every prepare reads holds no resume entry");
    });
    await t.step("web: a resume confirmed again lifts the block: the next 'apply to ...' is queued", async () => {
      const pasted = await say(`here is my resume:\n${RESUME}`);
      eq(pasted.intent, "career_resume_ingest", pasted.reply);
      const yes = await say("yes that's my resume");
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
      eq((await record()).state, "confirmed");
      const r = await say(`apply to the ${ROLE} role at ${COMPANY3}`);
      eq(r.intent, "career_apply_queue", r.reply);
      ok(!/no confirmed resume/i.test(r.reply), `not refused for a resume: ${r.reply}`);
      ok((await wanted()).includes(`${JOB3}:waiting`));
    });
  } finally {
    h?.restore();
    await pg.stop();
  }
} });
