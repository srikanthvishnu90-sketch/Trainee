// MASS APPLY, ONE CLICK (owner priority, 2026-11-01): a person on Telegram asks for the top N frontend internships in
// Chicago and applies to all of them with one tap, end to end through the production pieces a live run uses:
//   in      the REAL trainee-telegram webhook (handleTelegram, composed as its index.ts composes it) -> chatThroughAgent ->
//           agent-chat's real career handler (handler-career.ts handleChat) on a real Postgres 16 with every migration
//           (tests/flow/pg.ts, card-cloud bridge included) behind the PostgREST double;
//   ask     "find frontend internships in Chicago" lists the postings; "apply to the top N" queues them; the chat kicks the
//           hosted preparation (career-cloud-runner's handler, cloud_runner_http.ts) which runs the engine's dry run on each
//           employer's real form (workers/career-cloud/prepare-runner.ts in this process, as a sandbox runs it);
//   facts   what no confirmed fact answers is asked ONE question per message, over Telegram, each shared answer asked once
//           and reused by every application (name, email, phone, work rights; the Ashby form's own questions once);
//   card    ONE card for the whole batch goes to the chat (career_outbox -> trainee-deliver's delivery run) with one
//           "Approve all N" button bound to the card id and every item's payload hash; one tap approves exactly those N
//           payloads; a retried update and a second tap add nothing;
//   switch  CAREER_AGENT_SUBMIT off: the dispatcher claims nothing, nothing reaches an employer;
//   cap     the per-person daily cap (CLOUD_MAX_PER_PERSON_DAY) holds: no more are sent in a day than it allows, the rest
//           stay approved and queued;
//   send    the real dispatcher claims in parallel (CLOUD_MAX_CONCURRENT, at most CLOUD_MAX_PER_PORTAL per ATS), each send
//           sandbox (sandbox-runner.ts runSandboxJob, in this process) runs the real authorization before the engine and
//           before Submit, and the engine (scripts/apply.ts --submit --approved) submits exactly the card;
//   out     each item's outcome recorded: submitted with the employer's confirmation, needs_user for a captcha (never
//           solved) and for a required question the form gained after the approval, not sent for a posting that closed
//           after the approval; each employer received AT MOST one application per posting, its fields byte for byte the
//           approved card's; the receipts go to the chat as results land; "where are my applications" says each, honestly.
// The employers are tests/helpers/ats_world.ts: Greenhouse, Lever and Ashby form shapes on three 127.0.0.1 origins. In this
// test database three URL readers treat each origin as its ATS (career_apply_portal, career_apply_url_host,
// career_apply_cloud_destination_ok: named setup, as in flow-hosted-apply.test.ts); every other rule runs as written.
// Nothing reaches a real employer, Telegram, Vercel or any other host. MASS_N (default 12) postings; MASS_TIMING=1 prints the
// measured wall times.
// Run (as an unprivileged user): deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-mass-apply-telegram.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";
import { prepareBridge, runPrepareRequest } from "../../workers/career-cloud/prepare-runner.ts";
import { bridgeQueue, runSandboxJob } from "../../workers/career-cloud/sandbox-runner.ts";
import { cloudEngineRunner } from "../../workers/career-cloud/worker.ts";
import { createRunnerHandler } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import type { SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { questionLine } from "../helpers/one_question.ts";
import { atsWorld, type Family, type Posting } from "../helpers/ats_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const N = Math.max(10, Number(Deno.env.get("MASS_N") || 12));
const TIMING = !!Deno.env.get("MASS_TIMING");
const SECRET = "TEST-mass-runner-secret-0123456789abcdef01234";
const DISPATCH = "TEST-mass-dispatch-secret-0123456789abcdef012";
const KICK = "TEST-mass-prepare-token-0123456789abcdef01234";
const RUNNER = "http://runner.test/functions/v1/career-cloud-runner";
const TOKEN = "123456:TEST-mass-bot-token-not-real";
const TG_SECRET = "TEST_mass_webhook_secret_0123456789_abcdef";
const CHAT = 700000417;
const CAP = 3; // the per-person daily cap for the cap step (below any one ATS's share, so the cap, not a waiver, is what holds)
const RESUME = Deno.readTextFileSync(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const FILE = new TextEncoder().encode("%PDF-1.4\n% TEST synthetic resume file for the mass-apply flow, not a real person\n%%EOF\n");
const FILE_NAME = "Alex_Testcase_Resume.pdf";
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
const FILE_SHA = await hex(FILE);
const b64 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); };
// The person's answers, by the words of the question (the TEST persona; one answer serves every form that asks it).
const PERSONA: [RegExp, string][] = [
  [/legal name|full name/i, "Alex Testcase"], [/first name/i, "Alex"], [/last name/i, "Testcase"],
  [/whatsapp/i, "No - I do not consent to receiving WhatsApp messages"], [/text message/i, "No - I do not consent to receiving text messages"],
  [/e-?mail/i, "alex.testcase@example.test"], [/phone/i, "+1 555-0100"], [/graduation date/i, "05/15/2028"], [/new york/i, "yes"],
  [/sponsorship/i, "no"], [/authorized to work/i, "yes"], [/school/i, "TEST University"],
  [/built/i, "DeployBoard (TEST project): a Go tool that deploys containerised apps on Kubernetes, used by 12 student teams on AWS EKS."],
];
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; } catch { return false; }
}
const uuidOf = (n: number, f: string) => `${f}c3b0e00-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The postings: N frontend internships in Chicago across the three ATSs, round robin; four are special.
function postingsOf(n: number): Posting[] {
  const fams: Family[] = ["greenhouse", "lever", "ashby"];
  return Array.from({ length: n }, (_, i) => {
    const family = fams[i % 3], k = i + 1;
    const company = `TEST ${["Northwind", "Contoso", "Fabrikam", "Tailspin", "Wingtip", "Litware", "Adatum", "Proseware", "Lucerne", "Fourth Coffee", "Margie", "Trey"][i % 12]} ${k}`;
    const p: Posting = { family, company, title: "Frontend Engineering Intern", board: `mass${k}`,
      id: family === "greenhouse" ? String(5000000 + k) : uuidOf(k, family === "lever" ? "1" : "2") };
    return p;
  });
}

Deno.test({
  name: `Mass apply, one tap: Telegram "apply to the top ${N}" -> one card -> one tap -> parallel sends with kill switch, cap and per-item outcomes`,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the mass-apply flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
    const T0 = Date.now();
    const pg = await startPg({ includeBridge: true });
    const postings = postingsOf(N);
    // Four special postings: a captcha at Submit (Ashby), a required question added after the approval (Greenhouse), a
    // posting closed after the approval (Lever), and the rest ordinary.
    const captcha = postings.find((p) => p.family === "lever" && p !== postings[1])!;
    const extra = postings.find((p) => p.family === "greenhouse" && p !== postings[0])!;
    const closed = postings.find((p) => p.family === "lever" && p !== postings[1] && p !== captcha)!;
    // The captcha appears after the approval (a low reCAPTCHA score on the send), as it does live.
    const world = atsWorld(postings);
    const work = await Deno.makeTempDir({ prefix: "trainee-mass-" });
    const bot = botApi();
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => { if (!(k in saved)) saved[k] = Deno.env.get(k); Deno.env.set(k, v); };
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const outbound: string[] = [];
    const timings: Record<string, number> = {};
    let ok = true;
    const step = async (name: string, fn: () => Promise<void>) => { if (ok) ok = await t.step(name, fn); };
    try {
      await pg.sql(Deno.readTextFileSync(`${ROOT}/scripts/launch/verify-claim-guards.sql`).replace(/^\\.*$/gm, ""));
      await pg.sql(`do $d$ declare c text; begin for c in select conname from pg_constraint where conrelid = 'public.career_postings'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) ~ 'url' loop execute format('alter table public.career_postings drop constraint %I', c); end loop; end $d$;`);
      await supabaseParity(pg);
      // Setup (named): in this test database only, each local origin reads as its ATS and its own host.
      const O = { greenhouse: world.origin("greenhouse"), lever: world.origin("lever"), ashby: world.origin("ashby") };
      const HOST = { greenhouse: "boards.greenhouse.io", lever: "jobs.lever.co", ashby: "jobs.ashbyhq.com" };
      await pg.sql(`create or replace function public.career_apply_portal(p_url text) returns text language sql immutable set search_path = pg_catalog as $f$
         select case when p_url like '${O.greenhouse}/%' then 'greenhouse' when p_url like '${O.lever}/%' then 'lever' when p_url like '${O.ashby}/%' then 'ashby'
          when h ~ '(^|\\.)greenhouse\\.io$' then 'greenhouse' when h ~ '(^|\\.)lever\\.co$' then 'lever' when h ~ '(^|\\.)ashbyhq\\.com$' then 'ashby'
          when h ~ '(^|\\.)smartrecruiters\\.com$' then 'smartrecruiters' end
         from (select lower(substring(p_url from '^https://([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)')) as h) x $f$;
        create or replace function public.career_apply_url_host(p_url text) returns text language sql immutable set search_path = pg_catalog as $f$
         select case when p_url like '${O.greenhouse}/%' then '${HOST.greenhouse}' when p_url like '${O.lever}/%' then '${HOST.lever}' when p_url like '${O.ashby}/%' then '${HOST.ashby}'
          else lower(substring(p_url from '^https://([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)')) end $f$;
        create or replace function public.career_apply_cloud_destination_ok(p_dest text) returns boolean language sql immutable set search_path = pg_catalog as $f$
         select coalesce(p_dest, '') ~ '^https://' or coalesce(p_dest, '') like '${O.greenhouse}/%' or coalesce(p_dest, '') like '${O.lever}/%' or coalesce(p_dest, '') like '${O.ashby}/%' $f$;`);
      // The postings on file (the knowledge base the search reads), each linked to its local form.
      const keyOf = (p: Posting) => `${p.family}:${p.board}:${p.id}`;
      const desc = "Frontend Engineering Intern. Build product UI in React and TypeScript with the web team.";
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${postings.map((p) => `('${keyOf(p)}', '${p.family}', '${p.board}', '${p.company}', '${p.title}', 'Chicago, IL', '${world.urlOf(p)}', '${desc}', now(), now())`).join(",")};
        insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${postings.map((p, i) => `('${keyOf(p)}', '${p.family}', '${p.board}', '${p.company}', '${p.title}', 'Chicago, IL', '${world.urlOf(p)}', now() - interval '${i} minutes', '${desc}', 'mh${i}')`).join(",")};`);

      setEnv("CAREER_PREPARE_AHEAD_URL", `${RUNNER}/prepare`);
      setEnv("CAREER_PREPARE_AHEAD_TOKEN", KICK);
      // The gate pins the release flags off for tests (scripts/gate.sh); this flow measures them on, as released.
      setEnv("UPMORE_SCRIPT_SUBMIT_LIVE", "1"); setEnv("CLOUD_RUNNER_ENABLED", "on"); setEnv("CLOUD_PREPARE_ENABLED", "on");
      setEnv("TELEGRAM_BOT_TOKEN", TOKEN);
      setEnv("TELEGRAM_WEBHOOK_SECRET", TG_SECRET);
      setEnv("TRAINEE_ALLOWED_CONTACTS", `telegram:${CHAT}`);
      setEnv("TRAINEE_DELIVER_SECRET", "TEST-mass-deliver-secret-0123456789-abcd");
      agentChat = await careerHandler(pg, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");

      // The sandbox host: a named stand-in for Vercel running each runner script in this process, with only the env the
      // dispatcher gives it. Ashby forms have no <form> post: their engine binds Ashby's scripted Submit (the live switch,
      // UPMORE_SCRIPT_SUBMIT_LIVE, as in production; here the local origin is named as Ashby's with --script-submit).
      const isAshby = (args: string[]) => { const i = args.indexOf("--url"); return i >= 0 && String(args[i + 1]).startsWith(O.ashby); };
      const prepBase = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      let prepRuns = 0;
      const prepEngine: typeof prepBase = (args, env, c) => { prepRuns++; return prepBase(isAshby(args) ? [...args, "--script-submit", "ashby"] : args, env, c); };
      // MASS APPLY: Greenhouse forms read from the board API (the fixture's), shared facts asked with no browser pass.
      // MASS_NO_SCHEMA=1 measures the browser-only path for the before/after.
      const schemaOpt = Deno.env.get("MASS_NO_SCHEMA") ? false as const : { greenhouseApi: world.origin("greenhouse") };
      await Deno.mkdir(`${work}/evidence`, { mode: 0o700 });
      const cloudEngine = cloudEngineRunner({ root: ROOT, evidenceRoot: `${work}/evidence` });
      let engineStarts = 0, inFlight = 0, maxInFlight = 0;
      const sendEngine: typeof cloudEngine = async (args, env, controls) => {
        engineStarts++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        try { return await cloudEngine(isAshby(args) ? [...args, "--script-submit", "ashby"] : args, env, controls); } finally { inFlight--; }
      };
      const created: string[] = [], stopped: string[] = [], runs: Promise<unknown>[] = [];
      // Sandbox seconds, as a Vercel sandbox bills them: from its run to its finish, per kind.
      const sbx = { prepare: [] as number[], send: [] as number[] };
      const timed = <T>(kind: "prepare" | "send", p: Promise<T>) => { const t0 = performance.now(); return p.finally(() => sbx[kind].push(performance.now() - t0)); };
      const sendResults: any[] = [];
      const host: SandboxHost = {
        create: async ({ name }) => { const id = `sbx_TEST${created.length}x${name.length}`; created.push(id); return id; },
        run: async (sandbox, env, script) => {
          if (script === "workers/career-cloud/prepare-runner.ts") {
            runs.push(timed("prepare", runPrepareRequest({ bridge: prepareBridge({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_PREPARE_ID, sandbox, token: env.CLOUD_JOB_TOKEN }),
              runEngine: prepEngine, tmpRoot: work, log: () => {}, schema: schemaOpt })));
          } else if ((script ?? "workers/career-cloud/sandbox-runner.ts") === "workers/career-cloud/sandbox-runner.ts") {
            runs.push(timed("send", runSandboxJob({ bridge: bridgeQueue({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_JOB_ID, sandbox, token: env.CLOUD_JOB_TOKEN }),
              runEngine: sendEngine, tmpRoot: work, log: () => {} })).then((r) => { sendResults.push(r); }));
          } else throw Error(`unexpected script ${script}`);
        },
        stop: async (sandbox) => { stopped.push(sandbox); },
      };
      const waits: Promise<unknown>[] = [];
      const runnerEnv: Record<string, string> = {
        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: DISPATCH,
        CAREER_PREPARE_AHEAD_TOKEN: KICK, UPMORE_SCRIPT_SUBMIT_LIVE: "1", CLOUD_PREPARE_ENABLED: "on", CLOUD_RUNNER_ENABLED: "on", CLOUD_BRIDGE_URL: RUNNER,
        CLOUD_PREPARE_MAX_CONCURRENT: "6", CLOUD_PREPARE_PER_PERSON_DAY: String(10 * N), CLOUD_PREPARE_PER_SITE_MINUTE: String(10 * N),
        // Mass settings (docs/architect/MASS-APPLY-COST-2026-11-01.md): 8 sandboxes at once, at most 3 on one ATS host, up to 8
        // started per tick. The defaults stay wave 1 (2, 1, 2: cloud_runner_http.ts LIMIT_DEFAULTS).
        CLOUD_MAX_STARTS_PER_TICK: Deno.env.get("MASS_PER_TICK") || "4", CLOUD_MAX_CONCURRENT: Deno.env.get("MASS_CONCURRENT") || "4", CLOUD_MAX_PER_PORTAL: Deno.env.get("MASS_PER_PORTAL") || "2", CLOUD_MAX_PER_PERSON_DAY: String(CAP), CLOUD_MAX_PER_SITE_MINUTE: String(10 * N),
      };
      let modelCalls = 0;
      let runner: (req: Request) => Promise<Response> = async () => new Response("not yet", { status: 503 });
      const double = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === "http://runner.test") return await runner(req);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin || u.hostname === "127.0.0.1") return await double(req);
        if (u.hostname === "api.openai.com") { modelCalls++; outbound.push(u.href); return Promise.reject(new Error("no model in this test")); }
        if (u.hostname === "api.telegram.org") return await double(new Request(`${bot.origin}${u.pathname}${u.search}`, req));
        outbound.push(u.href);
        return Promise.reject(new Error(`the mass-apply flow reaches no real host: ${u.href}`));
      }) as typeof fetch;
      runner = createRunnerHandler({ env: { get: (k) => runnerEnv[k] }, host, waitUntil: (p) => { waits.push(p); } });
      const settle = async () => { for (let i = 0; i < 20 && (waits.length || runs.length); i++) { const w = waits.splice(0), r = runs.splice(0); await Promise.all([...w, ...r]); } };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const q1 = (s: string) => pg.sql(s);
      const json = async (s: string) => JSON.parse((await q1(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      // ---------------------------------------------------------------------------------------------- Telegram, both ways
      let update = 7000, msgId = 100;
      const post = async (body: Record<string, unknown>, id = ++update) => {
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, {
          method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify({ update_id: id, ...body }),
        }), { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
          deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        eq(res.status, 200, await res.clone().text());
        return { id, body: await res.json() };
      };
      // trainee-deliver's every-minute run: whatever the outbox holds for this chat goes out now.
      const deliverAll = async () => { const store = supabaseChannelStore(admin); try { await deliverDue({ store, adapters: adaptersFromEnv(Deno.env), now: Date.now(), limit: 50 }); } finally { await store.release?.(); } };
      const sent = (since: number) => bot.calls.slice(since).filter((c) => c.method === "sendMessage" && c.body.chat_id === CHAT);
      const text = async (words: string) => {
        const mark = bot.calls.length;
        await post({ message: { message_id: ++msgId, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "TEST" }, date: 1, text: words } });
        const out = sent(mark);
        assert(out.length >= 1, `Trainee answered "${words}" on Telegram`);
        return out.map((c) => String(c.body.text)).join("\n\n");
      };
      let person = "";
      const jobs = () => json(`select id, job_id, company, url, state, reason, payload, payload_hash, approval_hash, confirmation_id, attempts, evidence from public.career_apply_jobs where user_id = '${person}' order by job_id`);

      await step("1. /start, the resume pasted and confirmed in Telegram; the resume file kept for the cloud as is", async () => {
        await text("/start");
        person = await q1(`select coalesce(user_id::text, '') from public.channel_contacts where contact = 'tg:${CHAT}'`);
        assert(/^[0-9a-f-]{36}$/.test(person), `an account for the chat: ${person}`);
        await text(`here is my resume:\n${RESUME}`);
        const yes = await text("yes, that's my resume");
        assert(!/stay drafts|Nothing from your resume is confirmed/.test(yes), yes);
        eq(await q1(`select public.career_resume_on_file('${person}')`), "t");
        // Setup (named): the resume FILE they sent kept for the cloud (the channel's upload; career_apply_cloud_resume_put_for).
        eq(await q1(`select public.career_apply_cloud_resume_put_for('${person}', '${FILE_NAME}', '${b64(FILE)}')`), FILE_SHA);
      });

      let queuedReply = "";
      await step(`2. one message, "apply to the top ${N} frontend internships in Chicago": every one queued, nothing approved or sent, the hosted preparation kicked`, async () => {
        const t0 = Date.now();
        queuedReply = await text(`apply to the top ${N} frontend internships in Chicago`);
        const wanted = await json(`select posting_key, state from public.career_apply_wanted where user_id = '${person}'`);
        eq(wanted.length, N, `all ${N} queued: ${queuedReply}`);
        assert(new RegExp(`Queued ${N}\\b`).test(queuedReply), queuedReply);
        eq((await jobs()).length, 0, "nothing approved");
        eq(world.submissions.length, 0, "nothing sent");
        timings.ask_ms = Date.now() - t0;
      });

      await step("3. preparation on the real forms; each question asked once, one per message, on Telegram; one card for the batch", async () => {
        const t0 = Date.now();
        const asked: string[] = [];
        for (let round = 0; round < 8; round++) {
          await settle();
          await deliverAll();
          const open = await json(`select key, label from public.career_apply_questions where user_id = '${person}' and state = 'open' order by key`);
          if (!open.length) {
            const pending = await q1(`select count(*) from public.career_apply_prepared where user_id = '${person}' and state in ('ready','shown')`);
            if (Number(pending) >= N) break;
            if (await q1(`select count(*) from public.career_apply_prepare_requests where user_id = '${person}' and state not in ('done','failed')`) === "0") {
              throw Error(`no question open, ${pending}/${N} prepared, nothing preparing: ${await q1(`select string_agg(outcome || ' ' || left(detail, 160), ' | ') from public.career_apply_prepare_attempts where user_id = '${person}'`)}`);
            }
            continue;
          }
          let reply = await text("what do you need from me");
          for (let i = 0; i < 60; i++) {
            const q = questionLine(reply);
            const hit = PERSONA.find(([re]) => re.test(q));
            if (!hit) throw Error(`the TEST persona answers every question asked: ${q}\n${reply}`);
            asked.push(q);
            reply = await text(hit[1]);
            assert(/Saved/.test(reply) && !/doesn't fit|does not fit|isn't one of/i.test(reply), reply);
            if (!reply.includes("\nNext: ")) break;
          }
        }
        await settle();
        await deliverAll();
        timings.prepare_ms = Date.now() - t0;
        const prepared = await json(`select job_id, state from public.career_apply_prepared where user_id = '${person}'`);
        eq(prepared.length, N, `every posting prepared: ${JSON.stringify(prepared)}`);
        // Shared facts once: the same question words never asked twice across the batch (posting-bound essays are their own).
        const dup = asked.filter((q, i) => asked.indexOf(q) !== i);
        eq(dup, [], `no question asked twice: ${asked.join(" | ")}`);
        console.log(`MEASURED: ${asked.length} questions asked for ${N} applications`);
      });

      let card: any = null, buttons: any[] = [], cardMsg = 0, staleButtons: string[] = [];
      await step(`4. ONE card for all ${N}, delivered to the chat with one "Approve all ${N}" button bound to every item's hash`, async () => {
        const mark = bot.calls.length;
        const shown = await text("show my applications");
        card = (await json(`select id, items, state from public.career_apply_cards where user_id = '${person}' and state = 'open'`))[0];
        assert(card, `an open card: ${shown.slice(0, 400)}`);
        const prepared = await json(`select id, company, payload_hash from public.career_apply_prepared where user_id = '${person}'`);
        eq(card.items.length, N, "one card holds the whole batch");
        eq(card.items.map((i: any) => i.payload_hash).sort(), prepared.map((p: any) => p.payload_hash).sort(), "each item by its exact payload hash");
        for (const p of postings) assert(shown.includes(p.company), `${p.company} is on the card`);
        // The open card's buttons: the last message carrying Approve buttons. Cards pushed while the batch was still being
        // prepared (each newer card closes the older) may have gone out before; their buttons approve nothing (step 5).
        const withButtons = bot.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === CHAT && c.body.reply_markup?.inline_keyboard?.flat().some((b: any) => /^tca:/.test(b.callback_data)));
        console.log(`MEASURED: ${withButtons.length} card message(s) with Approve buttons in the chat: ${withButtons.map((c) => c.body.reply_markup.inline_keyboard.flat()[0].text).join(" | ")}`);
        if (Deno.env.get("MASS_DEBUG")) for (const c of withButtons) console.log(`CARD MSG #${bot.calls.indexOf(c)}: ${String(c.body.text).slice(0, 160).replace(/\n/g, " / ")} || before: ${bot.calls.slice(Math.max(0, bot.calls.indexOf(c) - 2), bot.calls.indexOf(c)).map((x) => x.method + ":" + String(x.body.text ?? "").slice(0, 80).replace(/\n/g, " / ")).join(" ;; ")}`);
        buttons = withButtons.at(-1)!.body.reply_markup.inline_keyboard.flat();
        eq(buttons[0].text, `Approve all ${N}`);
        assert(buttons[0].callback_data.startsWith(`tca:${card.id}:`), "the last card's buttons are the open card's");
        // Buttons of an EARLIER card (another card id): those must approve nothing. The same card sent again is the same approval.
        staleButtons = withButtons.slice(0, -1).map((c) => c.body.reply_markup.inline_keyboard.flat()[0].callback_data).filter((d: string) => !d.startsWith(`tca:${card.id}:`));
        const cardIds = new Set(withButtons.map((c) => c.body.reply_markup.inline_keyboard.flat()[0].callback_data.split(":")[1]));
        console.log(`MEASURED: ${cardIds.size} distinct card(s) reached the chat for one batch (${withButtons.length} messages)`);
        eq(cardIds.size, 1, "exactly one batch card reached the person (none for part of the batch while questions were open)");
        eq(await q1(`select count(*) from public.career_apply_cards where user_id = '${person}' and state = 'open'`), "1", "exactly one open card");
        assert(/^tca:/.test(buttons[0].callback_data) && new TextEncoder().encode(buttons[0].callback_data).length <= 64, buttons[0].callback_data);
        cardMsg = 1;
      });

      const tap = async (data: string, id: string, updateId?: number) => {
        const mark = bot.calls.length;
        const r = await post({ callback_query: { id, from: { id: CHAT, is_bot: false }, message: { message_id: cardMsg, chat: { id: CHAT, type: "private" }, date: 1 }, data } }, updateId);
        return { r, calls: bot.calls.slice(mark) };
      };
      await step("5. one tap approves exactly the card's payloads; a retried update and a double tap add nothing", async () => {
        // An older card's Approve (sent while the batch was still being prepared) approves nothing.
        for (const [i, data] of staleButtons.entries()) {
          const old = await tap(data, `cbq-mass-old-${i}`);
          assert(old.calls.some((c) => c.method === "answerCallbackQuery" && /Nothing was approved|Already answered/.test(c.body.text)), JSON.stringify(old.calls));
          eq((await jobs()).length, 0, "an older card approves nothing");
        }
        const approved = await tap(buttons[0].callback_data, "cbq-mass-approve");
        eq(approved.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text), ["Approved."]);
        const j = await jobs();
        eq(j.length, N, "one queue row per item");
        const byHash = new Set(card.items.map((i: any) => i.payload_hash));
        for (const row of j) {
          eq([row.state, row.approval_hash === row.payload_hash, byHash.has(row.payload_hash)], ["queued", true, true], `${row.company} queued by the card's hash`);
        }
        eq(await q1(`select count(*) from public.career_apply_jobs where user_id = '${person}' and public.career_apply_payload_hash(payload) <> payload_hash`), "0", "every queued payload hashes to what the card showed");
        const retry = await tap(buttons[0].callback_data, "cbq-mass-approve", approved.r.id);
        eq(retry.r.body.results?.[0]?.ignored, "duplicate webhook");
        const again = await tap(buttons[0].callback_data, "cbq-mass-again");
        assert(again.calls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "Already answered."), JSON.stringify(again.calls));
        eq((await jobs()).length, N, "no second row");
      });

      // After the approval, the world moves: one posting closes, one form gains a required question.
      closed.closed = true;
      captcha.captcha = true;
      extra.extraQuestion = true;
      const dispatch = async () => {
        const d = await runner(new Request(`${RUNNER}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": DISPATCH } }));
        const dj = await d.json();
        await settle();
        return dj;
      };
      await step("6. kill switch: CAREER_AGENT_SUBMIT off, nothing is claimed, nothing reaches an employer", async () => {
        await q1(`delete from public.career_cloud_settings where key in ('CAREER_CLOUD_APPLY','CAREER_CLOUD_TEXT_CARDS','CAREER_AGENT_SUBMIT');
          insert into public.career_cloud_settings (key, value) values ('CAREER_CLOUD_APPLY', 'on'), ('CAREER_CLOUD_TEXT_CARDS', 'on'), ('CAREER_AGENT_SUBMIT', 'off');
          select public.career_apply_cloud_optin_as('${person}', true, 'TEST terms');
          insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note)
          values ${(["greenhouse", "lever", "ashby"] as const).map((f) => `('${person}', '${f}', 5, now() + interval '1 day', 'TEST mass')`).join(",")};`);
        const d = await dispatch();
        eq(d.claimed ?? 0, 0, JSON.stringify(d));
        eq([engineStarts, world.submissions.length], [0, 0]);
        eq((await jobs()).every((r: any) => r.state === "queued"), true);
      });

      await step(`7. the daily cap: at most ${CAP} go today, the rest stay approved and queued`, async () => {
        await q1(`update public.career_cloud_settings set value = 'on' where key = 'CAREER_AGENT_SUBMIT'`);
        for (let i = 0; i < 6; i++) { const d = await dispatch(); if (!d.claimed) break; }
        const j = await jobs();
        const left = j.filter((r: any) => r.state === "queued").length;
        // The cap counts sends (engine starts); a posting found closed at the claim is closed without one (not_submitted).
        // The cap counts what went, or may have gone, or was handed back today; one stopped with nothing sent (not_submitted:
        // a closed posting, a question the card never showed) does not use a place.
        const counted = j.filter((r: any) => !["queued", "not_submitted"].includes(r.state)).length;
        eq(counted, CAP, `exactly the cap went today (${j.map((r: any) => `${r.state}/${r.attempts}/${r.reason}`).join(",")})`);
        // What holds the rest is the daily cap itself, by name (not a waiver, not a pause).
        const why = await json(`select public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', ${CAP}, ${10 * N}) as why from public.career_apply_jobs j where user_id = '${person}' and state = 'queued'`);
        eq([...new Set(why.map((x: any) => x.why))], ["daily_limit"], "the queued ones wait on the daily cap");
        assert(world.submissions.length <= CAP, `no more than the cap reached employers: ${world.submissions.length}`);
        assert(left > 0, "the rest stay approved and queued");
      });

      await step("8. the rest, in parallel: every item ends in its true outcome; each employer got at most one application per posting, byte for byte the card's", async () => {
        runnerEnv.CLOUD_MAX_PER_PERSON_DAY = String(10 * N);
        const t0 = Date.now();
        for (let i = 0; i < 4 * N; i++) {
          const d = await dispatch();
          if (!d.claimed && !(await jobs()).some((r: any) => r.state === "queued")) break;
        }
        timings.send_ms = Date.now() - t0;
        const stuck = await json(`select company, public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', ${10 * N}, 4) as why from public.career_apply_jobs j where user_id = '${person}' and state = 'queued'`);
        if (stuck.length) console.log(`STILL QUEUED: ${JSON.stringify(stuck)}`);
        const confirmations: Record<string, number> = {};
        let held = 0;
        const heldOn: Posting[] = [];
        const j = await jobs();
        const stateOf = (p: Posting) => { const r = j.find((x: any) => x.company === p.company); assert(r, `${p.company} has its queue row: ${j.map((x: any) => x.company + "=" + x.job_id).join(", ")}`); return r; };
        for (const p of postings) {
          const row = stateOf(p), got = world.sent(p).filter((s) => s.status === 200);
          if (p === captcha) {
            eq([row.state, row.reason], ["needs_user", "bot_check"], `${p.company}: the captcha is handed back`);
            eq(got.length, 0, "nothing sent past a captcha");
          } else if (p === extra) {
            // Recorded as not sent, the reason being the person's answers (the receipt asks them; step 9).
            eq([row.state, row.reason], ["not_submitted", "needs_answers"], `${p.company}: a required question the card never showed stops it`);
            eq(got.length, 0, "nothing sent with an unapproved field");
          } else if (p === closed) {
            eq([row.state, row.reason], ["not_submitted", "POSTING_CLOSED"], `${p.company}: a closed posting ends alone, nothing sent`);
            eq(got.length, 0);
          } else if (row.state === "not_submitted" && row.reason === "CARD_CLOUD_AUTH_REFUSED") {
            // Claimed, then refused by the authorization before the engine or Submit (the portal paused meanwhile): nothing sent.
            eq(got.length, 0, `${p.company}: refused before Submit, nothing sent`);
            held++; heldOn.push(p);
          } else if (row.state === "queued") {
            // The cloud throttle pauses a portal after a failure on it (career_apply_cloud_events): still approved, held, nothing sent.
            const why = stuck.find((x: any) => x.company === p.company)?.why;
            eq([why, got.length], ["portal_paused", 0], `${p.company}: held by the portal pause, nothing sent`);
            held++; heldOn.push(p);
          } else {
            eq(row.state, "submitted_unconfirmed", `${p.company}: submitted (${row.reason})`);
            // Confirmation evidence: the employer's page said received (its screenshot hash kept), with its reference when it gave one.
            assert(row.confirmation_id || row.evidence?.page_confirmation === true, `${p.company}: the employer's confirmation is recorded: ${JSON.stringify(row.evidence).slice(0, 400)}`);
            confirmations[p.family] = (confirmations[p.family] ?? 0) + (row.confirmation_id ? 1 : 0);
            eq(got.length, 1, `${p.company}: exactly one application`);
            // Byte-exact: every approved field went as approved; nothing went that the card did not show.
            const fields = (row.payload.fields as any[]).filter((f) => f.type !== "input_file" && !/resume/i.test(f.name) && String(f.value ?? "") !== "");
            const posted = got[0].fields;
            for (const f of fields) {
              const want = String(f.value);
              const have = posted[f.name];
              const asBool = /^(yes|no)$/i.test(want) && (have === "true" || have === "false") ? String(/^yes$/i.test(want)) : want;
              eq(have, asBool, `${p.company}: ${f.label} as approved`);
            }
            const shown = new Set(fields.map((f) => f.name));
            for (const [k, v] of Object.entries(posted)) if (v !== "" && !/^_systemfield_resume$/.test(k)) assert(shown.has(k), `${p.company}: ${k}=${v} was sent but not on the card`);
            eq(got[0].resume?.sha256, FILE_SHA, `${p.company}: their resume file, byte for byte`);
          }
        }
        console.log(`MEASURED: confirmation ids read per ATS: ${JSON.stringify(confirmations)}; held by a portal pause: ${held}`);
        timings.held_by_portal_pause = held;
        // A posting closed after approval ends alone (POSTING_CLOSED) and pauses no ATS. A verification check is a real signal
        // from the site: the owner's throttle may pause THAT ATS (career_apply_cloud_throttle), never another one.
        for (const p of heldOn) eq(p.family, captcha.family, `${p.company} held: only the ATS that showed a verification check is paused`);
        eq(world.submissions.filter((s) => s.status !== 200).length, 0, "no duplicate submission reached any employer");
        assert(maxInFlight > 2, `sends ran in parallel past wave 1: at most ${maxInFlight} at once`);
        eq(stopped.sort(), [...created].sort(), "every sandbox stopped");
      });

      await step("9. one honest summary and the receipts as results land, in the chat", async () => {
        const mark = bot.calls.length;
        await runReceipts({ outbox: supabaseAlertStore(admin), now: Date.now(),
          finished: async () => await json(`select id, user_id, company, url, state, reason, confirmation_id, email_confirmed_at, evidence, source from public.career_apply_jobs where user_id = '${person}'`) });
        await deliverAll();
        const receipts = sent(mark).map((c) => String(c.body.text)).join("\n");
        assert(receipts.includes(captcha.company) && /verification check/.test(receipts), `the captcha's receipt says what to do: ${receipts.slice(0, 600)}`);
        assert(receipts.includes(`Not sent to ${closed.company}: this posting closed before it could be submitted. Nothing reached the employer.`), `the closed posting's receipt in words: ${receipts.slice(0, 1600)}`);
        assert(!/POSTING_CLOSED|FINAL_REVIEW|DRIVER_ERROR|[A-Z]{4,}_[A-Z_]{3,}/.test(receipts), `no engine code reaches the person: ${receipts.slice(0, 1600)}`);
        // The question the form gained after the approval: said plainly, nothing sent (asking it and a fresh card: the
        // re-preparation PR stacked on this one).
        assert(receipts.includes(`Not sent to ${extra.company}: the form has questions you have not answered yet. Nothing reached the employer.`), `the added question's receipt: ${receipts.slice(0, 1600)}`);
        await deliverAll();
        const all = await text("where are my applications");
        // The counts, read independently from the database (never through the code that wrote the reply).
        const byState = Object.fromEntries((await json(`select state, count(*)::int n from public.career_apply_jobs where user_id = '${person}' group by state`)).map((r: any) => [r.state, r.n]));
        const said = (words: string) => Number(new RegExp(`(\\d+) ${words}`).exec(all.split("\n")[0])?.[1] ?? 0);
        eq([said("submitted"), said("waiting on you"), said("not sent"), said("approved and not sent yet"), said("confirmed by the employer")],
          [byState.submitted_unconfirmed ?? 0, byState.needs_user ?? 0, byState.not_submitted ?? 0, (byState.queued ?? 0) + (byState.driving ?? 0), byState.confirmed ?? 0],
          `the summary's counts are the database's: ${all.split("\n")[0]} vs ${JSON.stringify(byState)}`);
        eq(Number(/^(\d+) applications:/.exec(all)?.[1]), N, "every application counted");
        const nums = [...all.split("\n")[0].matchAll(/(\d+) [a-z]/g)].map((m) => Number(m[1]));
        eq(nums.slice(1).reduce((a, b) => a + b, 0), N, "the counts add up to every application");
        assert(new RegExp(`first, then newest first:\\n- ${captcha.company}:`).test(all), `the one waiting on them first: ${all.slice(0, 400)}`);

        assert(!new RegExp(`${captcha.company}[^\\n]*(submitted|sent to)`, "i").test(all), `the captcha one is never said sent: ${all}`);
      });

      if (!ok) return;
      timings.total_ms = Date.now() - T0;
      const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));
      const measured = { N, ...timings, engine_starts: engineStarts, max_in_flight: maxInFlight, sandboxes: created.length,
        prepare_sandboxes: sbx.prepare.length, prepare_sandbox_ms: sum(sbx.prepare), send_sandboxes: sbx.send.length, send_sandbox_ms: sum(sbx.send),
        model_calls: modelCalls, prepare_browser_runs: prepRuns, schema_from_api: schemaOpt !== false };
      console.log(`MEASURED mass apply: ${JSON.stringify(measured)}`);
      if (TIMING) await Deno.writeTextFile(Deno.env.get("MASS_TIMING")!, JSON.stringify(measured));
      eq(outbound, [], "no real host was asked");
    } finally {
      agentChat?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await world.close();
      await bot.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});

// Telegram's Bot API on 127.0.0.1: every call recorded.
function botApi() {
  const calls: { method: string; body: any }[] = [];
  let next = 5000;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const m = new RegExp(`^/bot${TOKEN}/([A-Za-z]+)$`).exec(decodeURIComponent(u.pathname));
    if (!m || req.method !== "POST") return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    calls.push({ method: m[1], body });
    if (m[1] === "sendMessage") return Response.json({ ok: true, result: { message_id: next++, chat: { id: body.chat_id, type: "private" }, date: 1, text: body.text } });
    if (["answerCallbackQuery", "sendChatAction", "editMessageText", "editMessageReplyMarkup"].includes(m[1])) return Response.json({ ok: true, result: true });
    return Response.json({ ok: false, error_code: 400, description: `unexpected ${m[1]}` }, { status: 400 });
  });
  return { origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, calls, close: () => server.shutdown() };
}
