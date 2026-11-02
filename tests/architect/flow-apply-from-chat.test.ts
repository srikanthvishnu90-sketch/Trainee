// STEP 4 F1 (2026-10-25): from a chat ask to a submitted application, on the queue path, with no test-only seam.
//   chat     "apply to the <role> at <Company>" -> handleChat (handler-career.ts, unchanged, real supabase-js over the
//            flow harness's PostgREST double) -> career_apply_wanted, the person's own apply queue
//   prepare  prepare-ahead.ts prepareAhead (the scheduled server run) draws the wanted posting as a candidate: the
//            engine's dry run on the employer's page, their confirmed facts, the resume tailored to it; what the form
//            asks and no fact answers is asked of them once, in chat (career_apply_questions)
//   answers  "what do you need from me" / "use N" through handleChat (their own words, each used by them)
//   card     career_apply_card_open_own / card_answer_own  (their own tap, as the person)
//   drive    runApproved -> scripts/apply.ts on the employer's page, once; recorded submitted_unconfirmed
//   chat     "did my application to <Company> go through?" -> read back from career_apply_jobs, never a success unseen
//   sibling  a second employer with the same form: a shared fact answered once (name, email, phone, work rights) serves
//            both; an answer bound to one posting (the essay "Why do you want to work here?", keyed job:<posting+label>)
//            is never inherited by the other, which is asked its own and prepared only after it (NEXT-1385 (1))
// Everything but the employer page (127.0.0.1) and the person's tap (an RPC as the person) is the product's own code.
// Fail-first on b7291b6a: the chat ask is the router's named_role_apply explanation (worker not connected), nothing is
// queued, and prepareAhead draws no candidate (career_apply_prepare_candidates reads alerts only).
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
const AUTH = "Are you legally authorized to work in the United States?";
const COMPANY = "TEST Chat Employer";
const SIBLING = "TEST Sibling Employer";
const ROLE = "TEST Analyst";
const WHY = "Why do you want to work here?";

// The employers: two postings on 127.0.0.1 with the same form (name, email, phone, a resume, sponsorship, work
// authorization and a required essay), one per route; every POST is kept per route.
function employer() {
  const posts: Record<string, Record<string, string>[]> = { apply: [], sibling: [] };
  const uploads: Record<string, string> = {};
  const select = (name: string, label: string) =>
    `<label for="${name}">${label}</label><select name="${name}" id="${name}" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>`;
  const form = (route: string, company: string) => `<!doctype html><title>TEST role</title><h1>${ROLE}</h1><p>${company}</p><form method="post" action="/${route}/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="phone">Phone</label><input name="phone" id="phone" type="tel" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    select("sponsorship", SPONSOR) + select("work_auth", AUTH) +
    `<label for="why">${WHY}</label><textarea name="why" id="why" required></textarea>` +
    `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") {
      const route = path.split("/")[1];
      const data = await req.formData(), got: Record<string, string> = {};
      for (const [k, v] of data.entries()) {
        if (typeof v === "string") got[k] = v;
        else { got[k] = `file:${v.name}`; uploads[route] = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await v.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
      }
      (posts[route] ??= []).push(got);
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: CHAT-${route.toUpperCase()}-1.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (path === "/apply") return new Response(form("apply", COMPANY), { headers: { "content-type": "text/html" } });
    if (path === "/sibling") return new Response(form("sibling", SIBLING), { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { url: `${base}/apply`, sibling: `${base}/sibling`, posts, upload: (route: string) => uploads[route] ?? "", close: () => server.shutdown() };
}
const day = (d = new Date()) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

Deno.test({
  name: "From chat to the queue: 'apply to the role at X' queues it; the server prepares it, asks in chat what the form needs, the person answers and taps; sent once; read back as not confirmed",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the chat-to-queue flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
    const pg = await startPg();
    // Two employers, two servers: the engine names a local application by its host, and the once-per-employer rule counts
    // employers, so each employer gets its own host (as each real employer has its own board tenant).
    const site = employer(), site2 = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-chat-queue-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      const JOB = "greenhouse:chattest:7", JOB2 = "greenhouse:chatsib:8", PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000e1";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        values ('${JOB}', 'greenhouse', 'chattest', '${COMPANY}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/chattest/jobs/7',
        '${ROLE}. Requirements: SQL, Python, dashboards for internal teams.', now(), now()),
        ('${JOB2}', 'greenhouse', 'chatsib', '${SIBLING}', '${ROLE}', 'Chicago, IL', 'https://boards.greenhouse.io/chatsib/jobs/8',
        '${ROLE}. Requirements: SQL, Python, dashboards for internal teams.', now(), now());
        insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      const svc = pg.asService(), person = pg.asPerson(PERSON);
      agentChat = await careerHandler(pg, { "tok-person": PERSON });
      const chat: Chat = agentChat.chat("tok-person");
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => { await memory.put(path, pdf); await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`); },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const deps = { db: svc, runEngine, profileFor: storedProfile(svc), urlFor: (c: { job_id: string }) => c.job_id === JOB2 ? site2.sibling : site.url, resumeFor: tailoredResume({ render: edgeRenderer(), resumes }) };
      const say = async (message: string) => { const r = await chat.say(message); assertEquals(r.status, 200, r.reply); return r; };
      const wanted = async () => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('key', posting_key, 'state', state, 'company', company)), '[]') from public.career_apply_wanted where user_id = '${PERSON}'`));

      await t.step("chat: resume pasted and confirmed; name, email, phone and work rights said", async () => {
        const pasted = await say(`here is my resume:\n${RESUME}`);
        assertEquals(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await say("yes, that's my resume");
        assertEquals([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        assert(Number(await pg.sql(`select count(*) from public.career_events where user_id = '${PERSON}' and kind = 'fact_confirmed'`)) >= 10, "the entries are evidenced");
        for (const m of ["my name is Jordan Rivera", "my email is jordan.rivera@example.test", "my phone number is 312-555-0142", "I'm a US citizen and I don't need visa sponsorship", "I'm authorized to work in the US"]) await say(m);
      });

      await t.step("chat: 'apply to the TEST Analyst role at TEST Chat Employer' puts that posting in their queue; nothing is prepared or sent yet, and the reply says so", async () => {
        assertEquals(await wanted(), [], "nothing queued before they ask");
        const r = await say(`apply to the ${ROLE} role at ${COMPANY}`);
        assertEquals(r.intent, "career_apply_queue", `the chat queues it: intent=${r.intent} ${r.reply}`);
        assert(/queued|on your apply list|in your queue/i.test(r.reply), r.reply);
        assert(/nothing (is|was|has been) (sent|submitted)/i.test(r.reply), `the reply says nothing was sent: ${r.reply}`);
        assert(!/submitted\b(?! yet)|applied for you|application (is|was) in/i.test(r.reply.replace(/nothing (is|was|has been) (sent|submitted)/i, "")), `never a submission claimed: ${r.reply}`);
        assert(r.reply.includes(COMPANY) && r.reply.includes(ROLE), `names the posting: ${r.reply}`);
        assertEquals(await wanted(), [{ key: JOB, state: "waiting", company: COMPANY }], "the queue holds exactly that posting");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "0", "nothing enqueued without their tap");
        assertEquals(site.posts.apply.length + site2.posts.sibling.length, 0);
      });

      await t.step("chat: an employer with no open posting on file is not this turn's; the router's honest stop answers and nothing is queued", async () => {
        const r = await say("apply to the Staff Engineer role at Stark Industries");
        assert(r.intent !== "career_apply_queue", `not claimed: ${r.intent}`);
        assert(/can'?t apply|not in the list|not on file|no open posting/i.test(r.reply), r.reply);
        assertEquals((await wanted()).length, 1, "nothing invented");
      });
      await t.step("chat: a role the employer has no open posting for is said so, naming what it does have; nothing is queued", async () => {
        const r = await say(`apply to the Staff Engineer role at ${COMPANY}`);
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "none"], r.reply);
        assert(r.reply.includes(ROLE) && /nothing was queued/.test(r.reply), r.reply);
        assertEquals((await wanted()).length, 1);
      });

      await t.step("chat: asking again does not queue it twice", async () => {
        const r = await say(`apply to the ${ROLE} role at ${COMPANY}`);
        assertEquals(r.intent, "career_apply_queue", r.reply);
        assert(/already (in|on) your (queue|apply list)/i.test(r.reply), r.reply);
        assertEquals((await wanted()).length, 1);
      });

      await t.step("chat: a second employer with the same role is queued beside the first", async () => {
        const r = await say(`apply to the ${ROLE} role at ${SIBLING}`);
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assertEquals((await wanted()).map((w: any) => w.key).sort(), [JOB2, JOB].sort());
      });

      // One question at a time (coordinator review of #360): "what do you need from me" shows the first open question;
      // "skip" moves on to the next; the one shown is answered with the whole message, or "use 1" for its offered draft.
      const untilShown = async (label: string, company?: string) => {
        let s = await say("what do you need from me");
        assertEquals(s.resultStatus, "shown", s.reply);
        for (let i = 0; i < 12 && !(s.reply.includes(label) && (!company || s.reply.includes(company))); i++) {
          s = await say("skip");
          assertEquals(s.resultStatus, "answered_next", s.reply);
        }
        assert(s.reply.includes(label) && (!company || s.reply.includes(company)), `${label}${company ? ` for ${company}` : ""} is asked: ${s.reply}`);
        return s.reply;
      };
      const useAll = async (labels: string[]) => {
        const texts: string[] = [];
        for (const label of labels) {
          texts.push(await untilShown(label));
          const used = await say("use 1");
          assert(/Saved, as drafted/.test(used.reply), `${label}: ${used.reply}`);
        }
        return texts.join("\n");
      };
      const outcomes = (done: { user_id: string; job_id: string; outcome: string }[]) =>
        done.filter((d) => d.user_id === PERSON).map((d) => [d.job_id, d.outcome]).sort((a, b) => a[0].localeCompare(b[0]));
      const openKeys = async () => (await pg.sql(`select coalesce(string_agg(key, ',' order by key), '') from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`)).split(",").filter(Boolean);
      await t.step("prepare: the server run draws both queued postings (no alert ever sent them); with no name or email on file it asks for those once, shared", async () => {
        const done = await prepareAhead(deps);
        assertEquals(outcomes(done), [[JOB2, "asked"], [JOB, "asked"]].sort((a, b) => a[0].localeCompare(b[0])), JSON.stringify(done));
        assertEquals(await openKeys(), ["fact:email", "fact:first_name", "fact:last_name"], "one shared question each, not one per posting");
        assertEquals(site.posts.apply.length + site2.posts.sibling.length, 0);
      });

      await t.step("their words: name and email offered back word for word; only 'use N' saves them", async () => {
        const text = await useAll(["First name", "Last name", "Email"]);
        assert(text.includes(`"my name is Jordan Rivera"`) && text.includes(day()), text);
      });

      let essayKeys: string[] = [];
      await t.step("prepare again: both dry runs ask phone, sponsorship and work authorization once (shared), and the essay once PER POSTING, each under its own key", async () => {
        assertEquals(outcomes(await prepareAhead(deps)), [[JOB2, "asked"], [JOB, "asked"]].sort((a, b) => a[0].localeCompare(b[0])));
        const keys = await openKeys();
        essayKeys = keys.filter((k) => k.startsWith("job:"));
        assertEquals(keys.filter((k) => !k.startsWith("job:")), ["fact:phone", "fact:sponsorship", "fact:work_authorization"]);
        assertEquals(essayKeys.length, 2, `the same essay label is two questions, one per posting, never one that travels: ${keys.join(",")}`);
        const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('key', key, 'label', label, 'company', company, 'jobs', job_ids) order by company), '[]') from public.career_apply_questions where user_id = '${PERSON}' and key like 'job:%'`));
        // Each row is bound to the engine's own posting id for that run (the page it opened), one per employer.
        assertEquals(rows.map((r: any) => [r.label, r.company, r.jobs]), [[WHY, COMPANY, [site.url]], [WHY, SIBLING, [site2.sibling]]]);
        assertEquals(site.posts.apply.length + site2.posts.sibling.length, 0, "a dry run sends nothing");
      });

      const FIRST_WHY = "I built the TEST Chat analytics pipeline and want to keep building it.";
      const SIBLING_WHY = "TEST Sibling ships weekly and I want to learn that pace.";
      await t.step("their words: phone, sponsorship and work authorization used by them; the first employer's essay typed for it alone", async () => {
        await useAll(["Phone", SPONSOR, AUTH]);
        await untilShown(WHY, COMPANY);
        const saved = await say(FIRST_WHY);
        assert(/kept word for word/.test(saved.reply), saved.reply);
        const left = await openKeys();
        assertEquals(left.length, 1, `the sibling's essay stays open: ${left.join(",")}`);
        assert(left[0].startsWith("job:"), left[0]);
      });

      let preparedId = "", tailored = "";
      await t.step("prepare: the first is ready with its own essay; the sibling still waits on its own question, never given the first's answer", async () => {
        const done = await prepareAhead(deps);
        // A posting whose question is still open is not run again (its 'asked' try stands until the answer); it is not prepared.
        assertEquals(outcomes(done), [[JOB, "ready"]], JSON.stringify(done));
        assertEquals((await openKeys()).length, 1, "the sibling's essay is still open");
        preparedId = done.find((d) => d.job_id === JOB)!.prepared_id!;
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${preparedId}'`));
        tailored = row.payload.resume_sha256;
        assertEquals(row.payload.resume_tailored, true);
        const values = Object.fromEntries(row.payload.fields.filter((f: any) => f.name !== "resume").map((f: any) => [f.name, f.value]));
        assertEquals(values, { first_name: "Jordan", last_name: "Rivera", email: "jordan.rivera@example.test", phone: "312-555-0142", sponsorship: "no", work_auth: "yes", why: FIRST_WHY });
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}' and job_id = '${JOB2}'`), "0", "the sibling is not prepared on the first's essay");
      });

      let preparedId2 = "";
      await t.step("the sibling's own essay, typed for it; then it is ready with that text and nothing of the first's", async () => {
        await untilShown(WHY, SIBLING);
        const saved = await say(SIBLING_WHY);
        assert(/kept word for word/.test(saved.reply), saved.reply);
        const done = await prepareAhead(deps);
        assertEquals(outcomes(done), [[JOB2, "ready"]], JSON.stringify(done));
        preparedId2 = done[0].prepared_id!;
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${preparedId2}'`));
        assertEquals(row.payload.fields.find((f: any) => f.name === "why")?.value, SIBLING_WHY);
      });

      await t.step("their taps: each queued exactly as shown, each its own approval; read back as approved, not sent", async () => {
        for (const id of [preparedId, preparedId2]) {
          const card = await person.rpc("career_apply_card_open_own", { p_ids: [id] });
          assertEquals(card.error, null, JSON.stringify(card.error));
          const answer = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
          assertEquals(answer.error, null, JSON.stringify(answer.error));
          assertEquals(answer.data?.[0]?.result, "queued");
        }
        assertEquals(await pg.sql(`select count(distinct payload_hash) from public.career_apply_jobs where user_id = '${PERSON}' and state = 'queued'`), "2", "two applications, two exact payloads");
        const r = await say(`did my application to ${COMPANY} go through?`);
        assert(/approved, not sent yet/.test(r.reply), r.reply);
      });

      await t.step("drive: each employer receives exactly its own approved answers and the tailored resume, once; both recorded as submitted, not confirmed", async () => {
        const queue = ownQueue(person);
        const done = await runApproved({
          claim: () => queue.claim(2),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => { const path = `${work}/sent-resume-${job.payload.resume_sha256.slice(0, 8)}.pdf`; await Deno.writeFile(path, memory.files.get(`career-resumes/${PERSON}/${job.payload.resume_sha256}.pdf`)!); return { path, sha256: job.payload.resume_sha256 }; },
          writeFacts: async (job, facts) => { const p = `${work}/approved-facts-${job.id}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; },
          runEngine,
        });
        assertEquals(done.length, 2);
        assertEquals([site.posts.apply.length, site2.posts.sibling.length], [1, 1], "exactly one POST each");
        const a = site.posts.apply[0], b = site2.posts.sibling[0];
        assertEquals([a.first_name, a.last_name, a.email, a.phone, a.sponsorship, a.work_auth, a.why], ["Jordan", "Rivera", "jordan.rivera@example.test", "312-555-0142", "no", "yes", FIRST_WHY]);
        assertEquals([b.first_name, b.last_name, b.email, b.phone, b.sponsorship, b.work_auth, b.why], ["Jordan", "Rivera", "jordan.rivera@example.test", "312-555-0142", "no", "yes", SIBLING_WHY]);
        assertEquals(site.upload("apply"), tailored, "the first's tailored resume, byte for byte");
        // The queue's job_id is the engine's posting key (the page it submitted to); each row carries its own employer's confirmation.
        const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('company', company, 'state', state, 'conf', confirmation_id) order by confirmation_id), '[]') from public.career_apply_jobs where user_id = '${PERSON}'`));
        assertEquals(rows, [{ company: COMPANY, state: "submitted_unconfirmed", conf: "CHAT-APPLY-1" }, { company: SIBLING, state: "submitted_unconfirmed", conf: "CHAT-SIBLING-1" }]);
      });

      await t.step("read back in chat: each submitted, not confirmed by its employer; never a success it did not see", async () => {
        const one = await say(`did my application to ${COMPANY} go through?`);
        assert(/submitted/.test(one.reply) && /has not confirmed it yet/.test(one.reply) && /CHAT-APPLY-1/.test(one.reply), one.reply);
        const two = await say(`did my application to ${SIBLING} go through?`);
        assert(/submitted/.test(two.reply) && /has not confirmed it yet/.test(two.reply) && /CHAT-SIBLING-1/.test(two.reply), two.reply);
        const all = await say("where are my applications");
        assert(all.reply.includes(COMPANY) && all.reply.includes(SIBLING), all.reply);
      });
    } finally {
      agentChat?.restore();
      await site.close();
      await site2.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
