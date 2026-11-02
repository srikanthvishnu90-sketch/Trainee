// FEATURE 17 (2026-10-26): a person with only a phone, end to end, on Ramp's Ashby form (tests/fixtures/ramp, a
// RECONSTRUCTED copy, served on 127.0.0.1), through the production pieces a live run uses:
//
//   1. their chat (agent-chat handler-career.ts handleChat, unchanged harness tests/flow/handler.ts; their thread is the
//      one their Telegram contact is linked to): resume pasted and confirmed, then "apply me to this: <Ramp link>";
//   2. the chat's kick reaches the hosted door (career-cloud-runner's handler, cloud_runner_http.ts) at
//      CAREER_PREPARE_AHEAD_URL; the request is recorded; the dispatcher starts one preparation sandbox (the host is a
//      named stand-in that runs workers/career-cloud/prepare-runner.ts in this process, the way a Vercel sandbox runs it,
//      with the four values the dispatcher hands it and no credential); every database call goes through the bridge;
//   3. the form's first question is texted to their channel at once (career_outbox 'questions'), one at a time in the
//      chat; their answers kick the preparation again (career_hosted_prepare.ts);
//   4. the card is shown in their thread at once (career_apply_card_push_requested_for) and queued for their channel,
//      within a measured, bounded time of their last message;
//   5. their tap (career_apply_card_answer_as, the service door the Telegram button calls): one job, bound to the hash;
//   6. the cloud send, with no stand-in on the path: as written, the text-card route refuses a local page (asserted);
//      then, with three URL readers in this test database treating the local copy's origin as Ashby's (named), the real
//      dispatcher claims the job, the send sandbox (sandbox-runner.ts's runSandboxJob, run in this process instead of in
//      a Vercel sandbox) reads it through the real bridge, the real authorization (approved sources, their digest, the
//      text-card route's every rule) runs before the engine and again before the one Submit, and the engine submits;
//   7. the outcome loop: the page's confirmation is evidence (a screenshot hash), the row stays submitted_unconfirmed;
//      the receipt goes to their channel; "did it go through?" reads it back; with Gmail connected, Ramp's confirmation
//      email (the Gmail API is the seam) makes it confirmed, and the read-back says so;
//   8. a visible verification check (reCAPTCHA's challenge frame at Submit): needs_user, nothing sent, and the receipt
//      says exactly what to do.
//
// RAMP_PERSONA=<file> runs steps 1-4 with that person's facts (the owner's own, kept outside the repo) and prints the
// exact payload; it then stops: a dry run. Nothing here reaches Ramp, Ashby, Vercel or any other real host.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";
import { prepareBridge, runPrepareRequest } from "../../workers/career-cloud/prepare-runner.ts";
import { bridgeQueue, runSandboxJob } from "../../workers/career-cloud/sandbox-runner.ts";
import { cloudEngineRunner } from "../../workers/career-cloud/worker.ts";
import { createRunnerHandler } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import type { SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { runMail, runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { supabaseConfirmStore } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import { RAMP_KEY, RAMP_LINK, rampSite } from "../helpers/ramp_form.ts";
import { questionLine } from "../helpers/one_question.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const SECRET = "TEST-hosted-runner-secret-0123456789abcdef0123";
const DISPATCH = "TEST-hosted-dispatch-secret-0123456789abcdef0";
const KICK = "TEST-hosted-prepare-token-0123456789abcdef0123";
const RUNNER = "http://runner.test/functions/v1/career-cloud-runner";
const CHAT = 417002;
const PERSONA_FILE = Deno.env.get("RAMP_PERSONA") || `${ROOT}/tests/fixtures/ramp/persona-test.json`;
const OWNER_RUN = !!Deno.env.get("RAMP_PERSONA");
const persona = JSON.parse(Deno.readTextFileSync(PERSONA_FILE));
const RESUME = persona.resume ?? Deno.readTextFileSync(`${ROOT}/${persona.resume_path}`);
const FILE = persona.file?.b64 ? Uint8Array.from(atob(persona.file.b64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(persona.file.text);
const FILE_NAME = String(persona.file.name);
const hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))).map((n) => n.toString(16).padStart(2, "0")).join("");
const FILE_SHA = await hex(FILE);
const b64 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); };

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

Deno.test({
  name: "FEATURE 17: phone only, Ramp's form: 'apply me to <link>' -> hosted preparation -> questions -> card in their channel, bounded -> tap -> cloud send -> outcome loop",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the hosted apply flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    // Go-live applies the card-cloud bridge; so does this database, and reconciles the claim guards as go-live does.
    const pg = await startPg({ includeBridge: true });
    const site = rampSite();
    const work = await Deno.makeTempDir({ prefix: "trainee-hosted-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const outbound: string[] = [];
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => { saved[k] = Deno.env.get(k); Deno.env.set(k, v); };
    try {
      await pg.sql(Deno.readTextFileSync(`${ROOT}/scripts/launch/verify-claim-guards.sql`).replace(/^\\.*$/gm, ""));
      // Setup (named): career_postings takes only https links; this test database lets the local copy's link in (step 2).
      await pg.sql(`do $d$ declare c text; begin for c in select conname from pg_constraint where conrelid = 'public.career_postings'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) ~ 'url' loop execute format('alter table public.career_postings drop constraint %I', c); end loop; end $d$;`);
      await supabaseParity(pg);
      const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000001f7";
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'tg-${CHAT}@users.trainee.invalid');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      setEnv("CAREER_PREPARE_AHEAD_URL", `${RUNNER}/prepare`);
      setEnv("CAREER_PREPARE_AHEAD_TOKEN", KICK);
      agentChat = await careerHandler(pg, { "tok-phone": PERSON });

      // The sandbox host: a named stand-in for Vercel that runs the runner script in this process, with only the env the
      // dispatcher gives it. Every sandbox is recorded and must be stopped.
      const created: string[] = [], stopped: string[] = [], runs: Promise<unknown>[] = [], envs: Record<string, Record<string, string>> = {};
      let sendSite = site, phases: string[] = [];
      const sendResults: any[] = [], rpcCalls: string[] = [];
      const prepEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, "--script-submit", "ashby"] });
      await Deno.mkdir(`${work}/evidence`, { mode: 0o700 });
      // The cloud engine as the send sandbox runs it, told this local page stands in for an Ashby form (--script-submit).
      const cloudEngine = cloudEngineRunner({ root: ROOT, evidenceRoot: `${work}/evidence` });
      const sendEngine: typeof cloudEngine = (args, env, controls) => cloudEngine([...args, "--script-submit", "ashby"], env, controls);
      const host: SandboxHost = {
        create: async ({ name }) => { const id = `sbx_TEST${created.length}${name.length}`; created.push(id); return id; },
        run: async (sandbox, env, script) => {
          envs[sandbox] = env;
          if (script === "workers/career-cloud/prepare-runner.ts") {
            // Setup (named): the posting's link in Trainee's records is the local copy of Ramp's form, so the engine opens
            // it as it opens the real link, and the bridge's check (the application is for this request's posting) is the
            // production check, on this link.
            await pg.sql(`update public.career_postings set url = '${sendSite.form}' where job_id = '${RAMP_KEY}' and url <> '${sendSite.form}';`);
            runs.push(runPrepareRequest({ bridge: prepareBridge({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_PREPARE_ID, sandbox, token: env.CLOUD_JOB_TOKEN }),
              runEngine: prepEngine, tmpRoot: work, log: () => {} }));
          } else if ((script ?? "workers/career-cloud/sandbox-runner.ts") === "workers/career-cloud/sandbox-runner.ts") {
            // The send sandbox, as sandbox-runner.ts's main runs it: the real bridge, the real authorization, the cloud engine.
            runs.push(runSandboxJob({ bridge: bridgeQueue({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_JOB_ID, sandbox, token: env.CLOUD_JOB_TOKEN }),
              runEngine: sendEngine, tmpRoot: work, log: () => {} }).then((r) => { sendResults.push(r); }));
          } else throw Error(`unexpected script ${script}`);
        },
        stop: async (sandbox) => { stopped.push(sandbox); },
      };
      const waits: Promise<unknown>[] = [];
      const runnerEnv: Record<string, string> = {
        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: DISPATCH,
        CAREER_PREPARE_AHEAD_TOKEN: KICK, CLOUD_PREPARE_ENABLED: "on", CLOUD_RUNNER_ENABLED: "on", CLOUD_BRIDGE_URL: RUNNER,
        CLOUD_PREPARE_MAX_CONCURRENT: "2", CLOUD_PREPARE_PER_PERSON_DAY: "10", CLOUD_PREPARE_PER_SITE_MINUTE: "6",
        CLOUD_MAX_CONCURRENT: "5", CLOUD_MAX_PER_PORTAL: "2", CLOUD_MAX_PER_PERSON_DAY: "5", CLOUD_MAX_PER_SITE_MINUTE: "2",
      };
      let runner: (req: Request) => Promise<Response>;
      const double = globalThis.fetch;
      const kicks: number[] = [];
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === "http://runner.test") { if (u.pathname.endsWith("/prepare")) kicks.push(Date.now()); return runner(req); }
        if (u.origin === new URL(SUPABASE_URL).origin) { rpcCalls.push(u.pathname.split("/").at(-1)!); return double(req); }
        if (u.hostname === "127.0.0.1") return double(req);
        outbound.push(u.href);
        if (u.hostname === "api.ashbyhq.com") return double(new Request(`${site.origin}${u.pathname}${u.search}`, req));
        return Promise.reject(new Error(`the hosted flow reaches no real host: ${u.href}`));
      }) as typeof fetch;
      runner = createRunnerHandler({ env: { get: (k) => runnerEnv[k] }, host, waitUntil: (p) => { waits.push(p); } });
      const settle = async () => { for (let i = 0; i < 5 && (waits.length || runs.length); i++) { const w = waits.splice(0), r = runs.splice(0); await Promise.all([...w, ...r]); } };
      const q1 = (s: string) => pg.sql(s);
      const chat: Chat = agentChat.chat("tok-phone");
      const say = async (m: string) => { const r = await chat.say(m); eq(r.status, 200, r.reply); return r; };
      const outbox = async (kind: string) => JSON.parse(await q1(`select coalesce(json_agg(json_build_object('key', key, 'text', text, 'card_id', card_id,
        'created_at', created_at, 'deliver_at', deliver_at, 'status', status) order by id), '[]') from public.career_outbox where user_id = '${PERSON}' and kind = '${kind}'`));
      let ok = true;
      // One question per message (review of #360): the question a text asks, and the persona's answer to it, if any.
      const answerFrom = (text: string) => {
        const q = questionLine(text);
        const a = (persona.answers as { match: string; value: string }[]).find((x) => new RegExp(x.match, "i").test(q));
        return { q, value: a?.value ?? null };
      };

      if (!ok) return;
      ok = await t.step("1. their resume, confirmed; their Telegram contact is linked to this thread; their resume file is kept for the cloud as is", async () => {
        const pasted = await say(`here is my resume:\n${RESUME}`);
        eq(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await say("yes, that's my resume");
        eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        // Setup (named): the Telegram contact linked to this thread (trainee-telegram does this at /start), and the
        // resume file they sent kept for the cloud (the channel's file upload; career_apply_cloud_resume_put_for).
        await q1(`insert into public.channel_contacts (contact, user_id, thread_id, last_inbound_at, created_at) values ('tg:${CHAT}', '${PERSON}', '${chat.thread()}', now(), now())`);
        eq(await q1(`select public.career_apply_cloud_resume_put_for('${PERSON}', '${FILE_NAME}', '${b64(FILE)}')`), FILE_SHA);
        eq(await q1(`select public.channel_target('${PERSON}', null)`), `tg:${CHAT}`);
      });

      let lastAt = 0;
      if (!ok) return;
      ok = await t.step("2. 'apply me to this: <Ramp link>': queued, the hosted door is kicked, the request recorded, one preparation sandbox started with no credential", async () => {
        lastAt = Date.now();
        const r = await say(`apply me to this: ${RAMP_LINK}`);
        eq([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assert(/^1\/1 queued/.test(r.reply) && /I've started preparing it now/.test(r.reply), r.reply);
        eq(kicks.length, 1, "the chat kicked the hosted door once");
        const req = JSON.parse(await q1(`select row_to_json(r) from (select user_id, job_ids, hosts, state from public.career_apply_prepare_requests) r`));
        eq([req.user_id, req.job_ids, req.hosts], [PERSON, [RAMP_KEY], ["jobs.ashbyhq.com"]], "their one queued posting and its host");
        await settle();
        eq(Object.keys(envs[created[0]] ?? {}).sort(), ["CLOUD_BRIDGE_URL", "CLOUD_JOB_TOKEN", "CLOUD_PREPARE_ID", "CLOUD_SANDBOX_ID"], "four values and no credential");
        assert(!JSON.stringify(envs).includes(SERVICE_KEY) && !JSON.stringify(envs).includes(SECRET), "no key or secret in the sandbox");
        eq(site.applications.length, 0, "a preparation sends nothing");
      });

      let rounds = 0, card: any = null, cardAt = 0, waitingOnThem = false;
      if (!ok) return;
      ok = await t.step("3-4. the form's first question texted at once; each next one asked after the answer; prepared again only when all are answered; the card queued for their channel", async () => {
        for (; rounds < 4 && !card; rounds++) {
          const cards = await outbox("card");
          if (cards.length) { card = cards[0]; cardAt = Date.parse(card.created_at); break; }
          const qs = await outbox("questions");
          const fresh = qs[qs.length - 1];
          assert(fresh, `after preparing, either a card or the questions are queued for their channel: ${await q1(`select string_agg(outcome || ' ' || detail, ' | ') from public.career_apply_prepare_attempts`)} / ${await q1(`select string_agg(state || ' ' || outcome::text, ' | ') from public.career_apply_prepare_requests`)}`);
          assert(Date.parse(fresh.deliver_at) <= Date.now(), "due now, not after the 30-minute hold");
          assert(!/Reply with each number/.test(fresh.text) && /(?:One question|Question 1 of \d+) only you can answer/.test(fresh.text), `one question in the text: ${fresh.text}`);
          let text = fresh.text, r: Awaited<ReturnType<typeof say>>;
          for (let n = 0; n < 30; n++) {
            const { q, value } = answerFrom(text);
            if (value === null) {
              if (OWNER_RUN) { console.log(`DRY RUN: a question the persona file does not answer:\n${q}`); waitingOnThem = true; return; }
              throw Error(`the TEST persona answers every question asked: ${q}\n${text}`);
            }
            lastAt = Date.now();
            r = await say(value);
            assert(/^Saved\./.test(r.reply) && !/doesn't fit|does not fit|isn't one of/i.test(r.reply), r.reply);
            assert(!/on your computer/.test(r.reply), `no promise the phone can't keep: ${r.reply}`);
            if (/I'm preparing your application again now with these answers/.test(r.reply)) break;
            assert(r.reply.includes("\nNext: "), `the next question is asked after the answer: ${r.reply}`);
            eq(await q1(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}'`), "0", "no card while a question is open");
            text = r.reply;
            // A new user checks in midway (messy phrasing): where it stands, plainly; nothing claimed sent.
            if (!OWNER_RUN && n === 0) {
              const st = await say("where's my application to ramp?");
              eq(st.intent, "career_apply_status", st.reply);
              assert(/Ramp \(Software Engineering Intern, Frontend\): waiting on your answer to \d+ questions?; say "what do you need from me"\. Nothing was sent\./.test(st.reply), st.reply);
              assert(!/I have no application to ramp on record/i.test(st.reply), `not "no application" while it is being prepared: ${st.reply}`);
              // The question is asked again when they ask for it, as the reply says.
              const shown = await say("what do you need from me");
              eq(shown.resultStatus, "shown", shown.reply);
              text = shown.reply;
            }
          }
          await settle();
        }
        assert(card, "a card was shown");
        // Bounded: from their last message to the card queued for their channel, measured here (the engine's dry run on
        // a local page is the bulk of it); in production add up to one minute for each tick (preparation, delivery).
        const ms = cardAt - lastAt;
        console.log(`MEASURED: card queued ${ms} ms after their last message, ${rounds} question round(s)`);
        assert(ms >= 0 && ms < 120_000, `bounded: ${ms} ms`);
        assert(Date.parse(card.deliver_at) <= Date.now(), "due now");
        eq(await q1(`select meta->>'intent' || ' ' || (meta->>'requested') from public.agent_messages where thread_id = '${chat.thread()}' and meta->>'card_id' = '${card.card_id}'`), "career_apply_card true");
        eq(stopped.sort(), [...created].sort(), "every preparation sandbox was stopped at its finish");
      });

      if (waitingOnThem) { console.log("DRY RUN: stopped where the person must answer; nothing was prepared past it, nothing approved or sent."); return; }
      let prepared = card ? JSON.parse(await q1(`select row_to_json(p) from public.career_apply_prepared p where user_id = '${PERSON}'`)) : null;
      if (!ok) return;
      ok = await t.step("the exact payload, field by field, and the card shows every one; the resume is their file, as is", async () => {
        assert(prepared, "prepared");
        const fields = prepared.payload.fields as any[];
        console.log(`PAYLOAD (${persona.label}): destination ${prepared.payload.destination}; resume ${prepared.payload.resume_sha256}`);
        for (const f of fields) console.log(`  ${f.label} [${f.name}] = ${JSON.stringify(f.value)}  (${f.factId})`);
        eq(prepared.payload.resume_sha256, FILE_SHA, "the resume bound is their file, byte for byte");
        const resume = fields.find((f) => f.name === "_systemfield_resume");
        assert(resume && resume.value === FILE_SHA, `the resume upload is in the payload: ${JSON.stringify(resume)}`);
        const date = fields.find((f) => /graduation date/i.test(f.label));
        assert(date && /^\d{2}\/\d{2}\/\d{4}$/.test(String(date.value)), `the date picker gets MM/DD/YYYY: ${JSON.stringify(date)}`);
        console.log(`CARD:\n${card.text}`);
        for (const f of fields.filter((x) => x.name !== "_systemfield_resume")) {
          // A radio group's card line is what the page reads back (the chosen option's words), not its raw value.
          const consent = /^(communicationConsent|whatsappConsent)$/.test(f.name);
          assert(consent ? card.text.includes(f.value === "given" ? "Yes - I consent" : "No - I do not consent") : card.text.includes(String(f.value)), `the card shows ${f.label} = ${f.value}`);
        }
        // A consent is never given on their behalf: only their own answer to it, asked of them.
        for (const f of fields.filter((x) => /^(communicationConsent|whatsappConsent)$/.test(x.name))) assert(/^text-answer:/.test(f.factId), `${f.name} is their own answer: ${f.factId}`);
        if (!OWNER_RUN) eq(fields.filter((x) => /^(communicationConsent|whatsappConsent)$/.test(x.name)).map((x) => x.value), ["notGiven", "notGiven"], "their own No, twice");
        if (!OWNER_RUN) {
          eq(date.value, "05/15/2028");
          for (const [label, v] of [[/new york/i, "Yes"], [/sponsorship/i, "No"]] as const) eq(String(fields.find((f) => label.test(f.label))?.value), v, String(label));
        }
      });
      if (OWNER_RUN) { console.log("DRY RUN: the owner's persona stops at the card; nothing is approved, queued or sent."); return; }

      let job: any = null;
      if (!ok) return;
      ok = await t.step("4b. they change their mind, then change it back: cancelled (the card approves nothing), asked again, a new card at once", async () => {
        const before = JSON.parse(await q1(`select row_to_json(p) from public.career_apply_prepared p where user_id = '${PERSON}'`));
        const st = await say("where is my application to Ramp");
        assert(/ready on the card I sent you; nothing is sent until you approve it there/.test(st.reply), st.reply);
        const c = await say("Actually, don't apply me to Ramp after all.");
        eq([c.intent, c.resultStatus], ["career_apply_cancel", "cancelled"], c.reply);
        assert(/^Cancelled Ramp: I removed it from your queue, deleted what I had prepared, closed its card, so a tap on it approves nothing\. Nothing was sent to Ramp\.$/.test(c.reply), c.reply);
        eq(await q1(`select count(*) from public.career_apply_wanted where user_id = '${PERSON}'`), "0");
        eq(await q1(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}'`), "0");
        const tap = await q1(`select public.career_apply_card_answer_as('${PERSON}', '${card.card_id}', '{1}')::text`).catch((e) => String(e));
        assert(/card_answered/.test(tap), `a tap on the cancelled card approves nothing: ${tap}`);
        eq(await q1(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "0", "no job");
        const again = await say("Cancel my application to Ramp");
        eq(again.resultStatus, "none", again.reply);
        assert(/nothing to cancel\. Nothing was sent to Ramp through Trainee\./.test(again.reply), again.reply);
        // Back on: asked again, prepared at once from their saved answers (nothing asked twice), a new card.
        lastAt = Date.now();
        const r = await say(`ok actually apply me to this: ${RAMP_LINK}`);
        eq([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        await settle();
        const cards = await outbox("card");
        eq(cards.length, 2, "a second card for the second ask");
        card = cards[1];
        console.log(`MEASURED: second card queued ${Date.parse(card.created_at) - lastAt} ms after asking again (answers already saved)`);
        prepared = JSON.parse(await q1(`select row_to_json(p) from public.career_apply_prepared p where user_id = '${PERSON}'`));
        eq(prepared.payload.fields.map((f: any) => [f.name, f.value]), before.payload.fields.map((f: any) => [f.name, f.value]), "the same answers, from what they already said");
        eq((await outbox("questions")).length, 1, "nothing asked twice");
      });
      if (!ok) return;
      ok = await t.step("5. their tap (the service door the Telegram button calls): one job, bound to the card's hash", async () => {
        const res = JSON.parse(await q1(`select public.career_apply_card_answer_as('${PERSON}', '${card.card_id}', '{1}')::text`));
        eq(res.map((x: any) => x.result), ["queued"]);
        job = JSON.parse(await q1(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}'`));
        eq([job.state, job.approval_hash, job.payload_hash], ["queued", prepared.payload_hash, prepared.payload_hash]);
      });

      if (!ok) return;
      ok = await t.step("6. the cloud send, end to end with no stand-in: the real dispatcher claims it, the send sandbox's real authorization (sources digest, text-card route) runs before the engine and before Submit, the engine submits exactly the card, once", async () => {
        await q1(`delete from public.career_cloud_settings where key in ('CAREER_CLOUD_APPLY','CAREER_CLOUD_TEXT_CARDS','CAREER_AGENT_SUBMIT');
          insert into public.career_cloud_settings (key, value) values ('CAREER_CLOUD_APPLY', 'on'), ('CAREER_CLOUD_TEXT_CARDS', 'on'), ('CAREER_AGENT_SUBMIT', 'on');
          select public.career_apply_cloud_optin_as('${PERSON}', true, 'TEST terms');
          insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note) values ('${PERSON}', 'ashby', 1, now() + interval '1 day', 'TEST hosted');`);
        const bad = await runner(new Request(`${RUNNER}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": "wrong" } }));
        eq(bad.status, 401, "a tick without the secret is refused");
        // As written, the text-card route refuses a page that is no portal family: a local page is never the cloud's.
        const d0 = await runner(new Request(`${RUNNER}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": DISPATCH } }));
        eq((await d0.json()).claimed, 0, "nothing claimed");
        eq(await q1(`select public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', 5, 2) from public.career_apply_jobs j where id = '${job.id}'`), "portal_not_cloud");
        // Setup (named): in this test database only, three URL readers treat the local copy's origin as Ashby's
        // (career_apply_portal, career_apply_url_host, career_apply_cloud_destination_ok); every other rule runs as written.
        const O = site.origin;
        await q1(`create or replace function public.career_apply_portal(p_url text) returns text language sql immutable set search_path = pg_catalog as $f$
           select case when p_url like '${O}/%' then 'ashby'
            when h ~ '(^|\\.)greenhouse\\.io$' then 'greenhouse' when h ~ '(^|\\.)lever\\.co$' then 'lever' when h ~ '(^|\\.)ashbyhq\\.com$' then 'ashby'
            when h ~ '(^|\\.)smartrecruiters\\.com$' then 'smartrecruiters' end
           from (select lower(substring(p_url from '^https://([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)')) as h) x $f$;
          create or replace function public.career_apply_url_host(p_url text) returns text language sql immutable set search_path = pg_catalog as $f$
           select case when p_url like '${O}/%' then '127.0.0.1' else lower(substring(p_url from '^https://([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)')) end $f$;
          create or replace function public.career_apply_cloud_destination_ok(p_dest text) returns boolean language sql immutable set search_path = pg_catalog as $f$
           select coalesce(p_dest, '') ~ '^https://' or coalesce(p_dest, '') like '${O}/%' $f$;`);
        eq(await q1(`select coalesce(public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', 5, 2), 'none') from public.career_apply_jobs j where id = '${job.id}'`), "none",
          "every other rule passes: the card's approval, the switches, the waiver, the opt-in, the numbers, the kept resume");
        rpcCalls.length = 0;
        const d = await runner(new Request(`${RUNNER}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": DISPATCH } }));
        const dj = await d.json();
        eq([dj.claimed, dj.started?.length], [1, 1], JSON.stringify(dj));
        await settle();
        eq(sendResults.length, 1, "the send sandbox ran");
        const done = sendResults[0];
        eq([done.state, done.outcome], ["confirmed", "submitted"], `${JSON.stringify(done)} ${await q1(`select evidence::text from public.career_apply_jobs where id = '${job.id}'`)}`);
        eq(rpcCalls.filter((n) => n === "career_apply_cloud_authorize_any").length, 3, `authorized before the engine and again before the one Submit: ${rpcCalls.join(",")}`);
        eq(rpcCalls.filter((n) => n === "career_apply_message_cloud_sources").length, 3, "each time against the approved sources as they are now");
        assert(rpcCalls.includes("career_apply_cloud_dispatch_claim2"), "claimed by the dispatcher's own door");
        eq(await q1(`select count(*) from public.career_apply_cloud_text_claims where job_id = '${job.id}' and card_id = '${card.card_id}' and item_n = 1`), "1", "its claim marker names the card item");
        eq(site.applications.length, 1, `exactly one application mutation: ${JSON.stringify(site.other)}`);
        const sent = site.applications[0].variables;
        const got = new Map((sent.applicationForm.fieldEntries as any[]).map((e) => [e.field, e.value]));
        for (const f of (prepared.payload.fields as any[]).filter((x) => x.name !== "_systemfield_resume")) {
          assert(got.has(f.name), `${f.label} was sent: ${JSON.stringify([...got])}`);
          const want = /^(yes|no)$/i.test(String(f.value)) && typeof got.get(f.name) === "boolean" ? String(/^yes$/i.test(String(f.value))) : String(f.value);
          eq(String(got.get(f.name)), want, `${f.label} as approved`);
        }
        eq(await hex(Uint8Array.from(atob(sent.resume.content), (c) => c.charCodeAt(0))), FILE_SHA, "their resume file, byte for byte");
        eq(sent.resume.name, FILE_NAME);
        eq(stopped.sort(), [...created].sort(), "every sandbox, the send one too, was stopped at its finish");
      });

      if (!ok) return;
      ok = await t.step("7a. without Gmail: the page's confirmation is evidence (its screenshot hash), the row stays submitted_unconfirmed; the receipt goes to their channel; read back", async () => {
        const row = JSON.parse(await q1(`select row_to_json(j) from (select state, confirmation_id, email_confirmed_at, evidence from public.career_apply_jobs where id = '${job.id}') j`));
        eq([row.state, row.confirmation_id, row.email_confirmed_at], ["submitted_unconfirmed", "RAMP-TEST-5120", null]);
        eq(row.evidence.page_confirmation, true);
        eq(row.evidence.response?.status, 200, `the employer's response code is recorded: ${JSON.stringify(row.evidence.response)}`);
        assert(/^[0-9a-f]{64}$/.test(String(row.evidence.screenshots?.sha256?.["after-submit.png"] ?? "")), `the confirmation page's screenshot, by its hash: ${JSON.stringify(row.evidence.screenshots)}`);
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
        const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
        const n = await runReceipts({ outbox: supabaseAlertStore(admin), now: Date.now(),
          finished: async () => JSON.parse(await q1(`select coalesce(json_agg(row_to_json(j)), '[]') from (select id, user_id, company, url, state, reason, confirmation_id, email_confirmed_at, evidence, source from public.career_apply_jobs where id = '${job.id}') j`)) });
        eq(n, 1);
        const receipt = (await outbox("receipt"))[0];
        assert(/^Sent to Ramp\. Their page said it was received; their confirmation email is the proof/.test(receipt.text), receipt.text);
        eq(await q1(`select public.channel_target('${PERSON}', null)`), `tg:${CHAT}`, "it goes to their Telegram chat");
        const back = await say("did my Ramp application go through?");
        assert(/submitted/.test(back.reply) && /has not confirmed it yet/.test(back.reply) && /RAMP-TEST-5120/.test(back.reply), back.reply);
      });

      if (!ok) return;
      ok = await t.step("7b. with Gmail connected: Ramp's confirmation email is matched; the row is confirmed, once; read back", async () => {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
        const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
        // Setup (named): their career Google grant exists; the Gmail API's answer is the seam.
        await q1(`insert into public.user_oauth_connections (user_id, provider, vault_name, scopes) values ('${PERSON}', 'google_career', 'oauth_google_career_${PERSON}', '{https://www.googleapis.com/auth/gmail.readonly}')`);
        const mail = { hash: "c".repeat(64), date: new Date().toISOString(), from: "Ramp <no-reply@ashbyhq.com>", subject: "Thank you for applying to Ramp",
          snippet: `We have received your application for the ${"Software Engineering Intern, Frontend"} role and will review it shortly.`,
          // Ashby sends the employer's confirmation from its own domain, naming the employer; Gmail authenticated that domain.
          auth: ["mx.google.com; dkim=pass header.i=@ashbyhq.com header.s=s1 header.b=AbC; spf=pass (google.com: domain of bounce@ashbyhq.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@ashbyhq.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=ashbyhq.com"] };
        for (let i = 0; i < 2; i++) {
          await runMail({ outbox: supabaseAlertStore(admin), now: Date.now(), store: supabaseMailStore(admin), confirm: supabaseConfirmStore(admin),
            read: async () => ({ status: "ok", mails: [mail], readThrough: Date.now(), listed: 1 }) } as any);
        }
        if (Deno.env.get("HOSTED_DEBUG")) {
          const { planConfirmations } = await import("../../supabase/functions/_shared/career_apply_confirm.ts");
          const { classifyMail } = await import("../../supabase/functions/_shared/career_mail.ts");
          const queue = await supabaseConfirmStore(admin).queue(PERSON);
          console.log("DEBUG", JSON.stringify(queue), JSON.stringify(classifyMail(mail as any)), JSON.stringify(planConfirmations([mail as any], queue)));
        }
        const row = JSON.parse(await q1(`select row_to_json(j) from (select state, email_confirmed_at is not null as by_mail, confirmation_mail_hash from public.career_apply_jobs where id = '${job.id}') j`));
        eq([row.state, row.by_mail, row.confirmation_mail_hash], ["confirmed", true, "c".repeat(64)], "confirmed by the employer's own email, once");
        const back = await say("did my Ramp application go through?");
        assert(/confirmed/i.test(back.reply) && !/has not confirmed it yet/.test(back.reply), back.reply);
      });

      if (!ok) return;
      ok = await t.step("7c. the owner's verification queries (docs/launch/RAMP-FIRST-RUN.md) run as written and read this run back", async () => {
        const doc = Deno.readTextFileSync(`${ROOT}/docs/launch/RAMP-FIRST-RUN.md`);
        const block = /```sql\n([\s\S]*?)```/.exec(doc)![1].replaceAll("<me>", PERSON).replaceAll("'%a13ae586%'", "'%/ramp/%'").replaceAll("'%a13ae586-f4cb-4385-8822-c42b9b54ed74%'", "'%/ramp/%'");
        const queries = block.split(/;\s*\n/).map((q) => q.replace(/^--.*$/gm, "").trim()).filter(Boolean);
        eq(queries.length, 7, "seven queries");
        const out: string[] = [];
        for (const q of queries) out.push(await q1(`select coalesce(json_agg(x), '[]') from (${q}) x`));
        const job = JSON.parse(out[0])[0], hashes = JSON.parse(out[1])[0], receipt = JSON.parse(out[3])[0];
        eq([job.state, job.source, job.employer_status, job.page_confirmation], ["confirmed", "cloud", "200", "true"]);
        assert(job.email_confirmed_at && /^[0-9a-f]{64}$/.test(job.screenshot_sha256["after-submit.png"]), JSON.stringify(job));
        eq([hashes.approved_as_hashed, hashes.payload_intact, hashes.from_his_card, hashes.resume_kept_intact], [true, true, true, true]);
        eq(receipt.kind, "receipt");
        eq(JSON.parse(out[6])[0].state, "done", "the preparation request finished");
      });
      if (!ok) return;
      ok = await t.step("8. a visible verification check at Submit: needs_user, nothing sent, and the reply says exactly what to do", async () => {
        // The same page, now showing reCAPTCHA's challenge frame at Submit (a low score), as Ramp's live page could.
        site.setChallenge(true);
        const sentBefore = site.applications.length;
        try {
          // A second synthetic person's approved application, the same exact payload shape, to the challenge page.
          const B = "7b0f8f8e-6a43-4a49-9d2c-0000000001f8";
          await q1(`insert into auth.users (id, email) values ('${B}', 'b@example.test'); insert into public.profiles (id) values ('${B}');
            insert into public.career_watch_kv (user_id, key, value) values ('${B}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
            select public.career_apply_cloud_resume_put_for('${B}', '${FILE_NAME}', '${b64(FILE)}');`);
          // #194's resume rule (20261026210016): an application goes into driving only for a person with a confirmed resume on
          // file (an entry with its fact_confirmed event); B is set up with one, as the product holds it.
          await q1(confirmedResumeSql(B));
          const { engineApprovalFromPayload, factsFromPayload } = await import("../../workers/career-browser/approve-first.ts");
          const { trustedManifest } = await import("../../extension/src/apply_core.ts");
          const p: any = structuredClone(prepared.payload);
          p.user_id = B;
          const frozen = factsFromPayload(p);
          p.manifest_hash = trustedManifest({ owner: B, file: frozen, rows: frozen.text_answers ?? [], resume: { sha256: p.resume_sha256 } }).hash;
          p.engine_approval = await engineApprovalFromPayload(p);
          const qp = `$p$${JSON.stringify(p)}$p$::jsonb`;
          const claimed = JSON.parse((await q1(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token, source)
            select '${B}', x.p->>'job_id', x.p->>'company', x.p->>'url', x.p, public.career_apply_payload_hash(x.p), public.career_apply_payload_hash(x.p), 'driving', 1, now(), gen_random_uuid(), 'cloud'
            from (select ${qp} p) x returning json_build_object('id', id, 'lease', lease_token)`)).split("\n").at(-1)!);
          const { jobToken } = await import("../../supabase/functions/_shared/cloud_runner.ts");
          const bridge = bridgeQueue({ url: RUNNER, id: claimed.id, sandbox: "sbx_TESTCHECK", token: await jobToken(SECRET, claimed.id, claimed.lease, "sbx_TESTCHECK") });
          const done = await runSandboxJob({ bridge, runEngine: sendEngine, tmpRoot: work, log: () => {}, queue: (q) => ({ ...q, authorize: async () => {} }) });
          eq([done.state, done.outcome], ["needs_user", "bot_check"], JSON.stringify(done));
          eq(site.applications.length, sentBefore, "nothing was sent: the check stopped it before the application left the page");
          const row = JSON.parse(await q1(`select row_to_json(j) from (select state, reason, attempts, company, url, evidence->>'handed_back' handed from public.career_apply_jobs where id = '${claimed.id}') j`));
          eq([row.state, row.reason, row.attempts], ["needs_user", "bot_check", 1], "handed back, never retried");
          const text = receiptText({ ...row, url: RAMP_LINK });
          eq(text, `Ramp is not finished: a verification check appeared, and Trainee never solves one, so finish this one yourself: open the link below, enter the answers you approved on the card, complete the check on the page, then press Submit. Nothing reached Ramp. ${RAMP_LINK}`);
          // The throttle counts the check against Ashby (career_apply_cloud_record; this page reads as Ashby's since step 6),
          // so a run of checks pauses the family or the person (tests/db/career_apply_cloud_runner.test.sql).
          eq(await q1(`select count(*) from public.career_apply_cloud_events where job_id = '${claimed.id}' and portal = 'ashby'`), "1", "counted once, against Ashby");
        } finally { site.setChallenge(false); }
        assert(outbound.every((u) => u.startsWith("https://api.ashbyhq.com/")), `no other host was asked: ${outbound}`);
      });
    } finally {
      agentChat?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await site.close();
      await pg.stop();
      if (Deno.env.get("HOSTED_KEEP")) console.log(`KEPT ${work}`); else await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
