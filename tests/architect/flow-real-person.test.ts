// SUBMIT-STEER-1130 / SPLIT-1146 (d) / JOIN-1236b: a person as the chat leaves them, from their texts to a submitted
// application, on a real Postgres (CI's migration order) and a real sandboxed browser, with the product's own code at
// every step. No hand-made profile and no seeded answer: everything the employer receives comes from what the person
// typed in chat.
//
//   chat      every text goes through the production agent-chat handler (handler-career.ts handleChat, unchanged, real
//             supabase-js; tests/flow/handler.ts): the router's own replies, agent-chat's own evidence step (after the
//             router's resume confirm), its questions turn ("what do you need from me", "use N") and its status read-back
//   prepare   prepare-ahead.ts on an alerted posting, reading their stored profile (storedProfile): no name or email on
//             file, so it asks for them; then the engine's dry run asks the form's phone, sponsorship and work
//             authorization questions
//   tap       career_apply_card_open_own / career_apply_card_answer_own: one ledger (G3)
//   drive     career_apply_claim_own -> runApproved -> the employer receives exactly the approved answers, once
//   read back "did my application to ... go through?" through the handler, from career_apply_jobs: submitted, not
//             confirmed (a page's thank-you is never "confirmed")
//
// The negative (the first person): a reply that showed a count and no entry, written into their thread in place of the
// router's reply as an explicit synthetic stand-in, so it stays a negative whatever the router renders: their yes
// evidences nothing, the entries stay drafts, and their application stops at no_resume.
// The positive (the second person): the router's own reply to the paste (e0aad64b shows each entry), asserted as it is.
//
// The seam, disclosed: the HTTP hop to the Supabase project (tests/flow/postgrest.ts answers it over the same database),
// and prepare-ahead / the card / the drive called as their own processes call them. The people are synthetic (TEST); the
// employer is a page on 127.0.0.1 served here; nothing reaches a real site.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { answerOneByOne } from "../helpers/one_question.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
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
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
const AUTH = "Are you legally authorized to work in the United States?";
const COMPANY = "TEST Real Employer";

// The employer: name, email, phone, a resume, sponsorship and work authorization; its thank-you page shows a number.
function employer() {
  const posts: Record<string, string>[] = [];
  let upload = "";
  const select = (name: string, label: string) =>
    `<label for="${name}">${label}</label><select name="${name}" id="${name}" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>`;
  const form = `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>${COMPANY}</p><form method="post" action="/apply/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="phone">Phone</label><input name="phone" id="phone" type="tel" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    select("sponsorship", SPONSOR) + select("work_auth", AUTH) + `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (req.method === "POST") {
      const data = await req.formData(), got: Record<string, string> = {};
      for (const [k, v] of data.entries()) {
        if (typeof v === "string") got[k] = v;
        else {
          got[k] = `file:${v.name}`;
          upload = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await v.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
        }
      }
      posts.push(got);
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: REAL-7001.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (new URL(req.url).pathname === "/apply") return new Response(form, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  return { url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/apply`, posts, upload: () => upload, close: () => server.shutdown() };
}

// A reply that shows a count and no entry: the negative's explicit stand-in for the router's reply to the paste.
const COUNT_ONLY = "Your resume is on record — as drafts, awaiting your word. I read it as 15 facts — every one is held as a DRAFT on your profile. " +
  "Say \"yes, that's my resume\" and I confirm them as your facts.";
const day = (d = new Date()) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const norm = (x: string) => String(x).replace(/\s+/g, " ").toLowerCase();
const lastAssistant = async (pg: { sql: (s: string) => Promise<string> }, thread: string) =>
  await pg.sql(`select id from public.agent_messages where thread_id = '${thread}' and role = 'assistant' order by id desc limit 1`);

async function setup(pg: any, person: string, job: string) {
  await pg.sql(`insert into auth.users (id, email) values ('${person}', '${person}@example.test') on conflict do nothing;
    insert into public.profiles (id) values ('${person}') on conflict do nothing;
    insert into public.career_watch_kv (user_id, key, value) values ('${person}', 'career:account', '{"epoch":0,"version":0,"paused":false}') on conflict do nothing;
    insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${person}', 'alert:${job}', 'alert', 'TEST alert', now());`);
}

Deno.test({
  name: "Real person: chat -> evidenced resume -> prepare asks -> their own words, used by them -> card tap -> submitted once -> read back as not confirmed",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the real-person flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-real-person-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      const JOB = "greenhouse:realtest:1", TODAY = "7b0f8f8e-6a43-4a49-9d2c-0000000000d1", PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000d2";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        values ('${JOB}', 'greenhouse', 'realtest', '${COMPANY}', 'TEST Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/realtest/jobs/1',
        'TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.', now(), now())`);
      await setup(pg, TODAY, JOB);
      const svc = pg.asService(), person = pg.asPerson(PERSON);
      agentChat = await careerHandler(pg, { "tok-today": TODAY, "tok-person": PERSON });
      const handler = agentChat;
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => {
          await memory.put(path, pdf);
          await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`);
        },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const deps = { db: svc, runEngine, profileFor: storedProfile(svc), urlFor: () => site.url, resumeFor: tailoredResume({ render: edgeRenderer(), resumes }) };
      const outcomeFor = (done: { user_id: string; outcome: string }[], u: string) => done.filter((d) => d.user_id === u).map((d) => d.outcome);

      await t.step("negative: a reply that showed a count and no entry; their yes evidences nothing, is never called confirmed, and their application stops at no_resume", async () => {
        const chat = handler.chat("tok-today");
        const pasted = await chat.say(`here is my resume:\n${RESUME}`);
        assertEquals([pasted.status, pasted.intent], [200, "career_resume_ingest"], pasted.reply);
        // The explicit stand-in: the thread shows a count where the router's reply was.
        await pg.sql(`update public.agent_messages set content = $c$${COUNT_ONLY}$c$ where id = ${await lastAssistant(pg, chat.thread()!)}`);
        const yes = await chat.say("yes, that's my resume");
        assertEquals(yes.status, 200, yes.reply);
        assert(!/^Confirmed\b|now run on them/.test(yes.reply) && /not shown to you word for word/.test(yes.reply), `agent-chat says nothing is confirmed: ${yes.reply}`);
        assertEquals(await pg.sql(`select count(*) from public.career_events where user_id = '${TODAY}' and kind = 'fact_confirmed'`), "0");
        const done = await prepareAhead(deps);
        assertEquals(outcomeFor(done, TODAY), ["no_resume"], JSON.stringify(done));
        assertEquals(await pg.sql(`select count(*) from public.career_apply_questions where user_id = '${TODAY}'`), "0", "nothing is asked of them that would not help");
      });

      // The second person's account and alert, once the first's prepare has run (it would otherwise try them too, before
      // they said anything, and record that try).
      await setup(pg, PERSON, JOB);
      const chat: Chat = handler.chat("tok-person");
      await t.step("chat: they paste their resume, are shown its entries, and say it is theirs; each entry gets its event and upload", async () => {
        const pasted = await chat.say(`here is my resume:\n${RESUME}`);
        assertEquals([pasted.status, pasted.intent], [200, "career_resume_ingest"], pasted.reply);
        const drafts = JSON.parse(await pg.sql(`select state->'career'->'stores'->'profile'->'facts' from public.agent_flow_state where user_id = '${PERSON}' order by updated_at desc limit 1`));
        assert(drafts.length >= 10, "the resume was read as entries");
        const unshown = drafts.filter((f: any) => !norm(pasted.reply).includes(norm(f.text)));
        assertEquals(unshown.length, 0, `the router's own reply shows every entry (${unshown.length} of ${drafts.length} not): ${pasted.reply.slice(0, 300)}`);
        const yes = await chat.say("yes, that's my resume");
        assertEquals([yes.status, yes.intent, yes.resultStatus], [200, "career_resume_ingest", "completed"], yes.reply);
        assertEquals(await pg.sql(`select count(*) from public.career_events where user_id = '${PERSON}' and kind = 'fact_confirmed'`), String(drafts.length),
          "agent-chat's evidence step: one persisted event per entry");
        // What they say about themselves, in their own words, on later days (the router's replies to these are Muse's).
        for (const t of ["my name is Jordan Rivera", "my email is jordan.rivera@example.test", "my phone number is 312-555-0142",
          "I'm a US citizen and I don't need visa sponsorship", "I'm authorized to work in the US"]) {
          const r = await chat.say(t);
          assertEquals(r.status, 200, r.reply);
        }
      });

      // Their texts to the questions, through agent-chat like every other text.
      const say = async (message: string) => {
        const r = await chat.say(message);
        assertEquals(r.status, 200, r.reply);
        return { reply: r.reply, status: r.resultStatus ?? "" };
      };
      // One question at a time (review of #360): each question with this label, as it comes up, answered with "use 1".
      const useAll = async (labels: string[]) => {
        const r = await answerOneByOne((m) => say(m).then((x) => ({ reply: x.reply, resultStatus: x.status })), labels.map((l) => [l, "use 1"] as [string, string]));
        for (const label of labels) assert(r.saved.includes("Saved, as drafted"), `${label}: ${r.saved}`);
        assert(!/Nothing was saved|There's no draft/.test(r.saved), r.saved);
        return r.shown;
      };

      await t.step("prepare: confirmed entries, no name or email on file: it asks for those once; no page is opened", async () => {
        const done = await prepareAhead(deps);
        assertEquals(outcomeFor(done, PERSON), ["asked"], JSON.stringify(done));
        assertEquals(await pg.sql(`select string_agg(key, ',' order by key) from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`),
          "fact:email,fact:first_name,fact:last_name");
        assertEquals(site.posts.length, 0);
      });

      await t.step("their words: name and email offered back word for word with the date; only 'use N' saves them", async () => {
        const text = await useAll(["First name", "Last name", "Email"]);
        assert(text.includes(`"my name is Jordan Rivera"`) && text.includes(`"my email is jordan.rivera@example.test"`) && text.includes(day()), text);
        assertEquals(await pg.sql(`select string_agg(key || '=' || answer, ',' order by key) from public.career_apply_questions where user_id = '${PERSON}'`),
          "fact:email=jordan.rivera@example.test,fact:first_name=Jordan,fact:last_name=Rivera");
      });

      await t.step("prepare again: the resume is tailored from their evidenced entries; the dry run asks the form's phone, sponsorship and work authorization", async () => {
        const done = await prepareAhead(deps);
        assertEquals(outcomeFor(done, PERSON), ["asked"], JSON.stringify(done));
        assertEquals(await pg.sql(`select string_agg(key, ',' order by key) from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`),
          "fact:phone,fact:sponsorship,fact:work_authorization");
        assertEquals(site.posts.length, 0, "a dry run sends nothing");
      });

      await t.step("their words again: phone, sponsorship and work authorization, each from their own message, each used by them", async () => {
        const text = await useAll(["Phone", SPONSOR, AUTH]);
        assert(text.includes(`"my phone number is 312-555-0142"`) && text.includes(`"I'm authorized to work in the US"`) && text.includes(day()), text);
        assertEquals(await pg.sql(`select string_agg(key || '=' || answer, ',' order by key) from public.career_apply_questions where user_id = '${PERSON}' and key in ('fact:phone','fact:sponsorship','fact:work_authorization')`),
          "fact:phone=312-555-0142,fact:sponsorship=No,fact:work_authorization=Yes");
      });

      let preparedId = "", tailored = "";
      await t.step("prepare: ready, with only their own answers and the resume tailored to the posting; the card shows each answer", async () => {
        const done = await prepareAhead(deps);
        const mine = done.filter((d) => d.user_id === PERSON);
        assertEquals(mine.map((d) => d.outcome), ["ready"], JSON.stringify(done));
        preparedId = mine[0].prepared_id!;
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${preparedId}'`));
        tailored = row.payload.resume_sha256;
        assertEquals(row.payload.resume_tailored, true);
        const values = Object.fromEntries(row.payload.fields.filter((f: any) => f.name !== "resume").map((f: any) => [f.name, f.value]));
        assertEquals(values, { first_name: "Jordan", last_name: "Rivera", email: "jordan.rivera@example.test", phone: "312-555-0142", sponsorship: "no", work_auth: "yes" });
        const lines = row.card_lines.join("\n");
        for (const v of ["Jordan", "Rivera", "jordan.rivera@example.test", "312-555-0142"]) assert(lines.includes(v), `the card shows ${v}: ${lines}`);
      });

      // Their status questions, through agent-chat (its read-back from career_apply_jobs answers before the router).
      const ask = async (message: string) => { const r = await chat.say(message); assertEquals(r.status, 200, r.reply); return { reply: r.reply, intent: r.intent }; };
      await t.step("their tap: queued exactly as shown, one ledger row; read back as approved, not sent", async () => {
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [preparedId] });
        assertEquals(card.error, null, JSON.stringify(card.error));
        const answer = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        assertEquals(answer.error, null, JSON.stringify(answer.error));
        assertEquals(answer.data?.[0]?.result, "queued");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_ledger('${PERSON}', now() - interval '1 day')`), "1", "one ledger");
        const r = await ask(`did my application to ${COMPANY} go through?`);
        assert(r && /approved, not sent yet/.test(r.reply), JSON.stringify(r));
      });

      await t.step("drive: the employer receives exactly the approved answers and the tailored resume, once; recorded as submitted, not confirmed", async () => {
        const queue = ownQueue(person);
        const done = await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => {
            const path = `${work}/sent-resume.pdf`;
            await Deno.writeFile(path, memory.files.get(`career-resumes/${PERSON}/${job.payload.resume_sha256}.pdf`)!);
            return { path, sha256: job.payload.resume_sha256 };
          },
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-facts.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
        assertEquals(done.length, 1);
        assertEquals(site.posts.length, 1, "exactly one POST");
        const got = site.posts[0];
        assertEquals([got.first_name, got.last_name, got.email, got.phone, got.sponsorship, got.work_auth],
          ["Jordan", "Rivera", "jordan.rivera@example.test", "312-555-0142", "no", "yes"]);
        assertEquals(site.upload(), tailored, "the tailored resume, byte for byte");
        const row = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}'`));
        assertEquals([row.state, row.confirmation_id], ["submitted_unconfirmed", "REAL-7001"]);
      });

      await t.step("read back: submitted, not confirmed by the employer; never called a success it did not see", async () => {
        const one = await ask(`did my application to ${COMPANY} go through?`);
        assert(one && /submitted/.test(one.reply) && /has not confirmed it yet/.test(one.reply) && /REAL-7001/.test(one.reply), JSON.stringify(one));
        assert(!/confirmed it\b(?! yet)|went through|successful/i.test(one!.reply.replace("has not confirmed it yet", "")), one!.reply);
        const all = await ask("where are my applications");
        assert(all && all.reply.includes(COMPANY), JSON.stringify(all));
        const none = await ask("did my application to Stark Industries go through?");
        assert(none && /no application to Stark Industries on record/.test(none.reply), JSON.stringify(none));
      });
    } finally {
      agentChat?.restore();
      await site.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
