// The integrated application flow (owner, 2026-10-23: "the flow Vishnu is waiting to see behave correctly as one piece"):
// G1's connected flow with G2 and G3 in it, on a real Postgres (CI's migration order, the G3 file included) and a real
// sandboxed browser, with the product's own code at every step. The employers are pages on 127.0.0.1 served here;
// nothing reaches a real site.
//
//   prepare   approve-first.ts prepare() -> scripts/apply.ts dry run: the form asks sponsorship and work authorization,
//             which no confirmed fact answers, so the application stops and the questions are stored (ask, never guess)
//   G2        "what do you need from me" (career_apply_questions.ts on the product's supabaseQuestionStore): each
//             question carries the person's own earlier chat message, word for word with its date; nothing is saved
//             until the person says "use N"
//   prepare   again, with the person's texted answers beside their facts file (engineFacts): ready
//   card tap  career_apply_card_open_own / career_apply_card_answer_own (G3: the ledger and the person's own cap decide)
//   drive     career_apply_claim_own (G3: re-checks the approval) -> runApproved -> the employer receives exactly the
//             approved answers, once
//   record    career_apply_finish_own: the page's confirmation number is kept as evidence; a second employer showing
//             the same number does not get it as proof (G3, D-024)
//   G3        a tampered approval is closed as not sent; the person's daily limit refuses one more; a company the
//             extension already applied to within 30 days is refused
//
// The person is synthetic (TEST). Their facts file carries name and email only, each with its source. Sponsorship and
// work authorization come only from the person's own chat messages, through their own "use N".
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import assertNode from "node:assert/strict";
import { answerOneByOne } from "../helpers/one_question.ts";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
import { pgBinDir, startPg } from "../flow/pg.ts";
import { restAdmin } from "../flow/rest.ts";
import { engineFacts, engineRunner, ownQueue, prepare, questionsToStore, runApproved } from "../../workers/career-browser/approve-first.ts";
import { QUESTIONS_INTENT, questionsTurn, supabaseQuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try {
    Deno.statSync(`${ROOT}/tools/node_modules/playwright`);
    Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`);
    return true;
  } catch {
    return false;
  }
}

const PERSON = "7b0f8f8e-6a43-4a49-9d2c-000000000002";
const THREAD = "7b0f8f8e-6a43-4a49-9d2c-0000000000a2";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-integrated-test" };
const FACTS = {
  user_id: PERSON,
  answers: {
    first_name: { value: "Ada", factId: "INT-TEST-FACT-1", ...SOURCE },
    last_name: { value: "Tester", factId: "INT-TEST-FACT-2", ...SOURCE },
    email: { value: "ada.tester@example.test", factId: "INT-TEST-FACT-3", ...SOURCE },
  },
};
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
const AUTH = "Are you legally authorized to work in the United States?";

// One employer per server (the company is the posting's host). Its form asks name, email, a resume, sponsorship and
// work authorization; its thank-you page shows `confirmation`. What each POST carried is kept.
function employer(confirmation: string) {
  const posts: Record<string, string>[] = [];
  const select = (name: string, label: string) =>
    `<label for="${name}">${label}</label><select name="${name}" id="${name}" required><option value="">Select</option>` +
    `<option value="yes">Yes</option><option value="no">No</option></select>`;
  const form = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><form method="post" action="/apply/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    select("sponsorship", SPONSOR) + select("work_auth", AUTH) + `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (req.method === "POST") {
      const data = await req.formData();
      const got: Record<string, string> = {};
      for (const [k, v] of data.entries()) got[k] = typeof v === "string" ? v : `file:${v.name}`;
      posts.push(got);
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: ${confirmation}.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (new URL(req.url).pathname === "/apply") return new Response(form, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { base, url: `${base}/apply`, host: new URL(base).host, posts, close: () => server.shutdown() };
}

Deno.test({
  name: "Integrated: prepare -> the person's own words, used by them (G2) -> card tap -> claim re-check, cap, ledger, unique confirmation (G3) -> recorded outcome",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the integrated flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const A = employer("CONF-4242"), B = employer("CONF-4242"), C = employer("CONF-1001"), D = employer("CONF-2002"), E = employer("CONF-3003");
    const work = await Deno.makeTempDir({ prefix: "trainee-integrated-" });
    try {
      // Setup (not the person acting): their account (a daily limit of 3, so the cap shows inside one flow), their chat
      // thread with two things they said earlier, and an application the extension reported to employer D five days ago.
      // Parity with Supabase, where the edge functions' role reads the chat tables (the stubs predate the stubs' default grants).
      await pg.sql(`grant select, insert on public.agent_threads, public.agent_messages to service_role`);
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'ada.tester@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false,"daily_limit":"3"}');
        ${confirmedResumeSql(PERSON, "%PDF-1.4\n% synthetic integrated-test resume\n%%EOF\n")}
        insert into public.agent_threads (id, user_id, title) values ('${THREAD}', '${PERSON}', 'TEST');
        insert into public.agent_messages (thread_id, role, content, created_at) values
          ('${THREAD}', 'user', 'I''m authorized to work in the US', '2026-10-20T15:00:00Z'),
          ('${THREAD}', 'user', 'I don''t need visa sponsorship', '2026-10-22T15:00:00Z');
        insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at)
          values ('${PERSON}', '${D.host}', 'Analyst', '${D.base}/other', 'Thanks for applying', '{}', now() - interval '5 days');`);
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify(FACTS));
      await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic integrated-test resume\n%%EOF\n"));
      const person = pg.asPerson(PERSON);
      const runEngine = engineRunner({ root: ROOT });
      const account = (await person.rpc("career_apply_account_own")).data;
      const store = supabaseQuestionStore(restAdmin(pg));
      // The chat host records each reply with its intent; the questions read it to know they are the thread's last word.
      const say = async (message: string) => {
        const r = await questionsTurn({ message, userId: PERSON, threadId: THREAD, now: Date.now(), store });
        if (r) {
          const intent = ["shown", "partial", "answered_next"].includes(r.status) || r.status.startsWith("draft") ? QUESTIONS_INTENT : "career_apply_questions_answer";
          await pg.sql(`insert into public.agent_messages (thread_id, role, content, meta) values ('${THREAD}', 'assistant', $r$${r.reply}$r$, '{"intent":"${intent}"}')`);
        }
        return r;
      };
      // The desktop prepare: the facts file and the person's texted answers beside it (approve-first.ts runLoop).
      const prepareWithAnswers = async (url: string) => {
        const rows = (await person.rpc("career_apply_answers_own")).data ?? [];
        const p = `${work}/facts-${crypto.randomUUID()}.json`;
        await Deno.writeTextFile(p, JSON.stringify(engineFacts(FACTS, rows)));
        return { r: await prepare({ url, factsPath: p, resumePath, account, now: Date.now(), runEngine }), rows };
      };
      const tap = async (url: string) => {
        const { r } = await prepareWithAnswers(url);
        assert(r.ready, `not ready: ${JSON.stringify((r as any).result)}`);
        const saved = await person.rpc("career_apply_prepare_own", { p_payload: r.payload, p_card_lines: r.card });
        assertEquals(saved.error, null, JSON.stringify(saved.error));
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [saved.data.id] });
        assertEquals(card.error, null, JSON.stringify(card.error));
        const answer = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        assertEquals(answer.error, null, JSON.stringify(answer.error));
        return { result: answer.data?.[0]?.result as string, card: card.data, payload: r.payload };
      };
      const drive = async () => {
        const queue = ownQueue(person);
        return await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => ({ path: resumePath, sha256: job.payload.resume_sha256 }),
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-${crypto.randomUUID()}.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
      };
      const job = async (site: { host: string }) =>
        JSON.parse(await pg.sql(`select coalesce(row_to_json(j)::text, 'null') from public.career_apply_jobs j where user_id = '${PERSON}' and company = '${site.host}'`) || "null");

      await t.step("prepare: the form asks sponsorship and work authorization, which no confirmed fact answers; asked, never guessed", async () => {
        const { r, rows } = await prepareWithAnswers(A.url);
        assertEquals(rows.length, 0);
        assertEquals(r.ready, false);
        assertEquals((r.result as any).reason, "needs_answers");
        const ask = questionsToStore(r.result as any, { facts: {}, answered: new Set() });
        const keys = (ask?.questions ?? []).map((q: any) => q.key).sort();
        assertEquals(keys, ["fact:sponsorship", "fact:work_authorization"], JSON.stringify(ask?.questions));
        const put = await person.rpc("career_apply_questions_put_own", { p_job_id: ask!.posting, p_questions: ask!.questions });
        assertEquals(put.error, null, JSON.stringify(put.error));
        assertEquals(A.posts.length, 0, "a dry run sends nothing");
      });

      await t.step("G2: each question carries the person's own words, with the date; nothing is saved until they say 'use N'", async () => {
        // One question at a time (review of #360): each shown with their own words for it; "use 1" saves it.
        const r = await answerOneByOne(async (m) => { const x = await say(m); return { reply: x!.reply, resultStatus: x!.status }; },
          [[SPONSOR, "use 1"], [AUTH, "use 1"]]);
        const text = r.shown;
        assert(text.includes(`"I don't need visa sponsorship"`) && /Oct 22/.test(text), text);
        assert(text.includes(`"I'm authorized to work in the US"`) && /Oct 20/.test(text), text);
        assert((r.saved.match(/Saved, as drafted/g) ?? []).length === 2, r.saved);
        const saved = await pg.sql(`select string_agg(key || '=' || answer, ',' order by key) from public.career_apply_questions where user_id = '${PERSON}'`);
        assertEquals(saved, "fact:sponsorship=No,fact:work_authorization=Yes");
      });

      await t.step("card tap: prepared again with the person's answers, shown on the card, enqueued exactly as shown", async () => {
        const t1 = await tap(A.url);
        assertEquals(t1.result, "queued");
        // What the person reads on the card: the prepared application's lines, bound to the card by its hash.
        const item = t1.card.items[0];
        const lines = await pg.sql(`select array_to_string(card_lines, E'\\n') from public.career_apply_prepared where id = '${item.prepared_id}'`);
        assert(new RegExp(`${SPONSOR.replace(/[?]/g, "\\?")}: No`).test(lines), lines);
        assert(new RegExp(`${AUTH.replace(/[?]/g, "\\?")}: Yes`).test(lines), lines);
        const row = await job(A);
        assertEquals(row.state, "queued");
        assertEquals(row.approval_hash, row.payload_hash);
        assertEquals(item.payload_hash, row.payload_hash, "the job is exactly what the card showed");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_ledger('${PERSON}', now() - interval '1 day') where source = 'queue'`), "1", "one ledger row");
      });

      await t.step("drive: the claim re-checks the approval; the employer receives exactly the approved answers, once; recorded with the page's number", async () => {
        const done = await drive();
        assertEquals(done.length, 1);
        assertEquals(A.posts.length, 1, "exactly one POST");
        const got = A.posts[0];
        assertEquals([got.first_name, got.last_name, got.email, got.sponsorship, got.work_auth], ["Ada", "Tester", "ada.tester@example.test", "no", "yes"]);
        const row = await job(A);
        assertEquals(row.state, "submitted_unconfirmed", "a page's thank-you is never 'confirmed' (only the employer's email is)");
        assertEquals(row.confirmation_id, "CONF-4242");
      });

      await t.step("unique confirmation: a second employer's page showing the same number does not get it as proof", async () => {
        assertEquals((await tap(B.url)).result, "queued");
        assertEquals((await drive()).length, 1);
        assertEquals(B.posts.length, 1);
        const row = await job(B);
        assertEquals(row.state, "submitted_unconfirmed");
        assertEquals(row.confirmation_id, null);
        assertEquals(row.evidence.confirmation_id_conflict, "CONF-4242", "what the page said is kept as evidence");
        assertEquals((await job(A)).confirmation_id, "CONF-4242", "the first employer keeps it");
      });

      await t.step("claim re-check and cap: a tampered approval is closed unsent; the person's limit of 3 refuses a fourth", async () => {
        assertEquals((await tap(E.url)).result, "queued", "the third application of the day");
        assertEquals((await tap(C.url)).result, "daily_cap", "a fourth is refused by the person's own limit");
        assertEquals(await job(C), null, "nothing queued for it");
        await pg.sql(`set session_replication_role = replica;
          update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"') where user_id = '${PERSON}' and company = '${E.host}';
          set session_replication_role = origin;`);
        assertEquals((await drive()).length, 0, "nothing handed to a drive");
        assertEquals(E.posts.length + C.posts.length, 0, "nothing reached either employer");
        const row = await job(E);
        assertEquals(row.state, "not_submitted");
        assert(/changed after it was approved/.test(row.reason), row.reason);
      });

      await t.step("one ledger: another posting at an employer the extension already applied to is queued (D-MS-3: only the same posting is a duplicate)", async () => {
        // D-MS-3 (owner, 2026-10-27): "one per company per 30 days" is gone. The extension's report was another posting at
        // this employer, so the tap queues this one (the tampered one above was closed unsent, so the person's own pace of 3
        // still has room); nothing is sent until a drive claims it.
        const r = (await tap(D.url)).result;
        assertEquals(r, "queued", "the employer is no reason to refuse");
        assertEquals((await job(D)).state, "queued");
        assertEquals(D.posts.length, 0, "queued, not sent");
      });
    } finally {
      for (const s of [A, B, C, D, E]) await s.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
