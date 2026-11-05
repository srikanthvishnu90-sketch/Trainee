// Apply round 4 (2026-11-05) on a real Postgres 16 (the flow harness: every migration in production order, the card-cloud bridge
// and the claim guards as go-live installs them): sampled scenarios of scenarios-apply-r4-battery.ts's categories through the
// real submit path. The cloud runner's HTTP door (cloud_runner_http.ts: /dispatch and the job bridge /job/<op>) over a PostgREST
// double of this database (tests/flow/postgrest.ts), the real dispatcher (cloud_runner.ts dispatch, career_apply_cloud_dispatch_claim2)
// and, in each fake sandbox, the real sandbox runner (sandbox-runner.ts runSandboxJob: worker.ts runCloudJob, the resume read, the
// authorization before the engine and again before the one Submit, the finish). Named stand-ins: the sandbox host (runs the
// runner in this process), the employer's board (an engine that records what it was sent; no network), and the TypeScript
// replay of the approved sources (the payloads here are legacy-shaped; the database's own authorization, with the sources'
// digest read through the bridge, is the real one). The apply VM's claim, heartbeat, reap and complete are called directly.
// What changes mid-flight, one per person: the owner's kill switches (CAREER_AGENT_SUBMIT, CAREER_CLOUD_APPLY,
// CAREER_CLOUD_TEXT_CARDS, APPLY_VM) and the runner's release flag rolled back, a pause, "forget everything", an opt-out, a person
// pause, a fact corrected between the sources read and the authorization, the resume replaced, the posting closed, the same
// posting sent another way (before the claim and mid-flight), the employer's page changed, a browser crash before Submit
// (driven again once), a sandbox that dies after the board took it, a lease that expired, a payload changed under the queue;
// two dispatchers at once; 25 people at the dispatcher's per-person number and 25 paused people ahead of a newcomer; two VM
// workers at once, a dead VM worker reaped, a repeated Submit check; the employer's email (right job, another job).
// Checked against the database and the board after the runs: at most one application per person and posting on the board,
// only the approved payload with the confirmed resume, only for what may still go; every application ends in words (never
// "submitted" or "confirmed" without that record); nothing left being driven; nothing driven twice.
import { pgBinDir, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { createRunnerHandler } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import type { SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { bridgeQueue, runSandboxJob } from "../../workers/career-cloud/sandbox-runner.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { type AppRow, statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { planConfirmations, type QueueRow } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { type MailIn, parseFrom } from "../../supabase/functions/_shared/career_mail.ts";
import { postingKey } from "../../supabase/functions/_shared/career_apply.ts";
import { readableReason } from "./scenarios-submit-worker-battery.ts";
import { linkOf, POSTING_VARIANTS } from "./scenarios-apply-r4-battery.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
// Built at run time, never a literal secret.
const SECRET = ["TEST", "r4", "flow", "runner", "secret", "0123456789abcdef"].join("-");
const DISPATCH = ["TEST", "r4", "flow", "dispatch", "secret", "0123456789abcdef"].join("-");
const SERVICE = ["TEST", "r4", "flow", "service"].join("-");
const SUPA = "http://supabase.test", RUNNER = "http://runner.test/functions/v1/career-cloud-runner";
const RES = "%PDF-1.4 TEST r4 flow resume";

const KINDS = ["ok", "ok_unconfirmed", "kill_agent_mid", "kill_cloud_mid", "kill_textcards_mid", "runner_flag_mid", "pause_mid", "forget_mid", "optout_mid",
  "person_pause_mid", "fact_corrected_mid", "resume_replaced_mid", "resume_removed_mid", "resume_unconfirmed_mid", "posting_closed_mid", "sent_elsewhere_mid", "sent_elsewhere_before", "page_changed",
  "crash_before_submit", "died_after_post", "lease_expired_mid", "payload_changed_mid", "email_right", "email_other_job"] as const;
type Kind = typeof KINDS[number];
// What may reach the board: only these (each at most once).
const GOES = new Set<Kind>(["ok", "ok_unconfirmed", "resume_replaced_mid", "crash_before_submit", "died_after_post", "email_right", "email_other_job"]);
const SAYS_SUBMITTED = /:\s*(?:submitted\b|sent, but not finished)/;

Deno.test({
  name: "apply round 4 on Postgres: mid-flight changes, kill switches, duplicates, leases, limits and words, through the real runner, bridge and database",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) {
      if (CI) throw Error("needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg({ includeBridge: true });
    const work = await Deno.makeTempDir({ prefix: "trainee-r4-" });
    const problems: string[] = [];
    const bad = (m: string) => problems.push(m);
    try {
      await pg.sql(Deno.readTextFileSync(`${ROOT}/scripts/launch/verify-claim-guards.sql`).replace(/^\\.*$/gm, ""));
      // Setup (named): every switch on, as D-041 leaves production; the per-ATS gate open (as after the owner's own confirmed sends).
      await pg.sql(`delete from career_cloud_settings where key in ('CAREER_CLOUD_APPLY','CAREER_CLOUD_TEXT_CARDS','CAREER_AGENT_SUBMIT','APPLY_VM','APPLY_VM_USER_IDS');
        insert into career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on'),('CAREER_CLOUD_TEXT_CARDS','on'),('CAREER_AGENT_SUBMIT','on'),('APPLY_VM','on'),('APPLY_VM_USER_IDS','*');
        create or replace function public.career_apply_cloud_open(p_portal text) returns boolean language sql stable as $g$ select coalesce(p_portal in ('greenhouse','lever','ashby'),false) $g$;
        create function public.t_person(u uuid) returns void language plpgsql as $q$ begin
          insert into auth.users(id,email) values (u, u::text||'@example.test'); insert into profiles(id) values (u);
          insert into career_watch_kv(user_id,key,value) values (u,'career:account','{"epoch":1,"version":1,"paused":false}');
          perform career_apply_cloud_optin_as(u,true,'TEST terms');
          perform career_apply_cloud_resume_put_for(u,'resume.pdf',encode(convert_to('${RES}','UTF8'),'base64')); end $q$;
        create function public.t_payload(u uuid, job text, co text, url text) returns jsonb language sql as $q$
          select jsonb_build_object('version',1,'user_id',u,'job_id',job,'company',co,'url',url,'fields','[]'::jsonb,'title','TEST Data Analyst',
           'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '6 hours','engine_approval',repeat('e',64),
           'resume_sha256',encode(sha256(convert_to('${RES}','UTF8')),'hex'),'destination',url) $q$;
        create function public.t_prep(u uuid, job text, co text, url text) returns uuid language sql as $q$
          with p as (select public.t_payload(u,job,co,url) as p)
          insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines) select u,p->>'job_id',p->>'company',p->>'url',p,career_apply_payload_hash(p),array['x'] from p returning id $q$;
        create function public.t_tap(u uuid, ids uuid[]) returns void language plpgsql as $q$ declare c career_apply_cards; begin
          c := career_apply_card_open_for(u, ids, now() - interval '1 minute');
          perform career_apply_card_answer_for(u, c.id, array(select generate_series(1, cardinality(ids))), clock_timestamp()); end $q$;
        create function public.t_posting(job text, url text, co text) returns void language sql as $q$
          insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at)
          values (job, split_part(job,':',1), split_part(job,':',2), split_part(job,':',3), co, 'TEST Data Analyst', url, now(), now()) on conflict do nothing $q$;
        create function public.t_sent_elsewhere(u uuid, job text, url text, co text) returns void language sql as $q$
          insert into extension_submission_reports(user_id,employer,role,posting_url,posting_key,confirmation_text,tracker_record)
          values (u, co, 'TEST Data Analyst', url, job, 'Thank you for applying', '{}') $q$;`);

      // ---------------------------------------------------------------- phase A: one person per kind, through the runner
      interface P { kind: Kind; user: string; job: string; url: string; company: string }
      const people: P[] = KINDS.map((kind, i) => {
        const user = `00000000-0000-4000-8000-0000004a${String(i).padStart(4, "0")}`, fam = i % 3;
        const uuid = `${(0x4a00 + i).toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(i).padStart(12, "0")}`;
        const [job, url] = fam === 0 ? [`greenhouse:r4a${i}:${880000 + i}`, `https://boards.greenhouse.io/r4a${i}/jobs/${880000 + i}`]
          : fam === 1 ? [`lever:r4a${i}:${uuid}`, `https://jobs.lever.co/r4a${i}/${uuid}`] : [`ashby:r4a${i}:${uuid}`, `https://jobs.ashbyhq.com/r4a${i}/${uuid}`];
        return { kind, user, job, url, company: `R4 Employer ${i}` };
      });
      for (const p of people) {
        await pg.sql(`select t_person('${p.user}'); ${confirmedResumeSql(p.user, RES)}; select t_posting('${p.job}','${p.url}','${p.company}');
          select t_tap('${p.user}', array[t_prep('${p.user}','${p.job}','${p.company}','${p.url}')]);`);
        if (p.kind === "sent_elsewhere_before") await pg.sql(`select t_sent_elsewhere('${p.user}','${p.job}','${p.url}','${p.company}')`);
      }
      const queued = Number(await pg.sql(`select count(*) from career_apply_jobs where state = 'queued'`));
      assert(queued === people.length, `every card yes queued one application (${queued})`);
      const approved = new Map<string, string>(); // job -> approved payload hash
      for (const l of (await pg.sql(`select job_id || '|' || payload_hash from career_apply_jobs`)).split("\n")) { const [j, h] = l.split("|"); approved.set(j, h); }

      // The board: what each employer received.
      const board: { user: string; posting: string; hash: string; resume: string }[] = [];
      const byUrl = new Map(people.map((p) => [p.url, p]));
      const runnerEnv: Record<string, string> = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: SERVICE, CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: DISPATCH,
        CLOUD_BRIDGE_URL: RUNNER, CLOUD_RUNNER_ENABLED: "on", CLOUD_MAX_STARTS_PER_TICK: "60" };
      const double = postgrestDouble(pg, { url: SUPA, serviceKey: SERVICE, users: {} });
      const dead = new Set<string>(); // sandboxes whose network is gone (the sandbox died)
      const sandboxes: { sandbox: string; env: Record<string, string> }[] = [], stopped: string[] = [];
      const host: SandboxHost = {
        create: async ({ name }) => `sbx_r4_${sandboxes.length}_${name.length}_${crypto.randomUUID().slice(0, 6)}`,
        run: async (sandbox, env) => { sandboxes.push({ sandbox, env }); },
        stop: async (sandbox) => { stopped.push(sandbox); },
      };
      const runner = createRunnerHandler({ env: { get: (k) => runnerEnv[k] }, host, fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        if (new URL(req.url).origin !== SUPA) return Promise.reject(new Error(`the runner reaches no real host: ${req.url}`));
        return double.fetch(req);
      }) as typeof fetch });
      const tick = async () => {
        const r = await runner(new Request(`${RUNNER}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": DISPATCH } }));
        assert(r.status === 200, `dispatch answered ${r.status}`);
        return await r.json();
      };
      const sql = (s: string) => pg.sql(s);
      // What changes mid-flight, as the person or the owner would change it (named setup, as the superuser).
      const restore: (() => Promise<unknown>)[] = [];
      const midFlight = async (p: P, job: any) => {
        switch (p.kind) {
          case "kill_agent_mid": await sql(`update career_cloud_settings set value='off' where key='CAREER_AGENT_SUBMIT'`); restore.push(() => sql(`update career_cloud_settings set value='on' where key='CAREER_AGENT_SUBMIT'`)); break;
          case "kill_cloud_mid": await sql(`update career_cloud_settings set value='off' where key='CAREER_CLOUD_APPLY'`); restore.push(() => sql(`update career_cloud_settings set value='on' where key='CAREER_CLOUD_APPLY'`)); break;
          case "kill_textcards_mid": await sql(`update career_cloud_settings set value='off' where key='CAREER_CLOUD_TEXT_CARDS'`); restore.push(() => sql(`update career_cloud_settings set value='on' where key='CAREER_CLOUD_TEXT_CARDS'`)); break;
          case "runner_flag_mid": runnerEnv.CLOUD_RUNNER_ENABLED = "off"; restore.push(async () => { runnerEnv.CLOUD_RUNNER_ENABLED = "on"; }); break;
          case "pause_mid": await sql(`update career_watch_kv set value = value || '{"paused":true}' where user_id='${p.user}' and key='career:account'`); break;
          case "forget_mid": await sql(`update career_watch_kv set value = value || '{"epoch":2}' where user_id='${p.user}' and key='career:account'`); break;
          case "optout_mid": await sql(`select career_apply_cloud_optin_as('${p.user}', false, 'TEST stop')`); break;
          case "person_pause_mid": await sql(`insert into career_apply_cloud_pauses(scope,user_id,until,reason) values ('person','${p.user}',now()+interval '1 day','TEST stop sending for me')`); break;
          // A newer resume put for the cloud: the approved one still goes, never the newer one (the board check below).
          case "resume_replaced_mid": await sql(`select career_apply_cloud_resume_put_for('${p.user}','resume.pdf',encode(convert_to('%PDF-1.4 TEST another resume','UTF8'),'base64'))`); break;
          case "resume_removed_mid": await sql(`delete from career_apply_cloud_resumes where user_id = '${p.user}'`); break;
          // The person withdrew the confirmation of their resume (no confirmed resume on file any more).
          case "resume_unconfirmed_mid": await sql(`delete from career_events where user_id = '${p.user}' and kind = 'fact_confirmed'`); break;
          case "posting_closed_mid": await sql(`update career_postings set closed_at = now() where job_id = '${p.job}'`); break;
          case "sent_elsewhere_mid": await sql(`select t_sent_elsewhere('${p.user}','${p.job}','${p.url}','${p.company}')`); break;
          case "lease_expired_mid": await sql(`alter table career_apply_jobs disable trigger user; update career_apply_jobs set claimed_at = claimed_at - interval '16 minutes' where id = '${job.id}'; alter table career_apply_jobs enable trigger user;`); break;
          case "payload_changed_mid": await sql(`alter table career_apply_jobs disable trigger user; update career_apply_jobs set payload = payload || '{"title":"TEST changed after the yes"}' where id = '${job.id}'; alter table career_apply_jobs enable trigger user;`); break;
        }
      };
      const engineRuns = new Map<string, number>();
      const runEngine = async (args: string[], _env: unknown, controls?: { beforeEffect?: () => Promise<void> }) => {
        const url = args[args.indexOf("--url") + 1], p = byUrl.get(url)!, job = current.get(url);
        const n = (engineRuns.get(url) ?? 0) + 1;
        engineRuns.set(url, n);
        const resume = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(args[args.indexOf("--resume") + 1]))), (b) => b.toString(16).padStart(2, "0")).join("");
        if (p.kind === "page_changed") return { result: { state: "not_submitted", reason: "FORM_SCHEMA_CHANGED" }, evidence: null };
        if (p.kind === "crash_before_submit" && n === 1) return { result: { state: "not_submitted", reason: "DRIVER_ERROR" }, evidence: null };
        await midFlight(p, job);
        try { await controls!.beforeEffect!(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
        board.push({ user: job.user_id, posting: job.job_id, hash: await hashApplyPayload(job.payload), resume });
        if (p.kind === "died_after_post") { dead.add(url); throw Error("TEST the sandbox died after the board took it"); }
        return { result: { state: p.kind === "ok_unconfirmed" ? "submitted_unconfirmed" : "confirmed", confirmation_id: p.kind === "ok_unconfirmed" ? null : `R4-${p.job.length}` }, evidence: { post: { status: 200 } } };
      };
      const current = new Map<string, any>(); // url -> the job as the sandbox read it
      const runSandbox = async (sb: { sandbox: string; env: Record<string, string> }) => {
        let url = "";
        const f = ((input: RequestInfo | URL, init?: RequestInit) => {
          if (url && dead.has(url)) return Promise.reject(new Error("TEST the sandbox's network is gone"));
          return runner(input instanceof Request && !init ? input : new Request(input as any, init));
        }) as typeof fetch;
        const bridge = bridgeQueue({ url: sb.env.CLOUD_BRIDGE_URL, id: sb.env.CLOUD_JOB_ID, sandbox: sb.env.CLOUD_SANDBOX_ID, token: sb.env.CLOUD_JOB_TOKEN, fetch: f });
        const job = await bridge.job();
        url = job.url; current.set(url, job);
        const p = byUrl.get(url)!;
        // Named stand-in for the TypeScript replay of the approved sources (legacy-shaped payloads here): the sources and the
        // database's authorization are read through the bridge, exactly as authorizeCurrentCloudJob calls them.
        const call = async (op: string, extra: Record<string, unknown> = {}) => {
          const r = await f(`${RUNNER}/job/${op}`, { method: "POST", body: JSON.stringify({ id: job.id, sandbox: sb.env.CLOUD_SANDBOX_ID, token: sb.env.CLOUD_JOB_TOKEN, ...extra }) });
          const body = await r.json().catch(() => null);
          if (!r.ok) throw Error(`${op}: ${r.status} ${body?.error ?? ""}`);
          return body;
        };
        const authorize = async (_j: unknown, phase: string) => {
          const snap = await call("sources");
          if (p.kind === "fact_corrected_mid" && phase === "before_effect") {
            await sql(`update agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts,0,text}', '"TEST Analyst, corrected"') where user_id = '${p.user}'`);
          }
          const r = await call("authorize", { p_hash: job.payload_hash, p_source_digest: snap?.digest });
          if (r?.authorized !== true || r.job_id !== job.id) throw Error("CARD_CLOUD_AUTHORIZATION_REFUSED");
        };
        try {
          await runSandboxJob({ bridge, runEngine, tmpRoot: work, log: () => {}, queue: (q) => ({ ...q, authorize }) });
        } catch (e) {
          if (!dead.has(url)) bad(`${p.kind}: the sandbox runner threw: ${(e as Error).message}`);
        }
        for (const r of restore.splice(0)) await r();
      };

      // Two dispatchers at once: every approved application is claimed once.
      const [d1, d2] = await Promise.all([tick(), tick()]);
      const claimedTotal = (d1.claimed ?? 0) + (d2.claimed ?? 0);
      const startable = people.length - 1; // the posting already sent another way before the claim is ended, never claimed
      if (claimedTotal !== startable) bad(`two dispatchers claimed ${claimedTotal} of ${startable}`);
      const ids = sandboxes.map((s) => s.env.CLOUD_JOB_ID);
      if (new Set(ids).size !== ids.length) bad("a job was started in two sandboxes");
      for (const sb of [...sandboxes]) await runSandbox(sb);
      // The 15-minute sweep, run as if that time had passed: what died mid-flight is unknown, never re-driven.
      await pg.asService().rpc("career_apply_sweep", { p_now: new Date(Date.now() + 20 * 60_000).toISOString() });
      const again = await tick();
      if (again.claimed) bad(`a later tick claimed ${again.claimed} again`);

      // The employer's email: the right job, and a rejection naming another role at the same employer.
      const rowsOf = async (u: string): Promise<QueueRow[]> => JSON.parse(await sql(`select coalesce(json_agg(json_build_object('id',id,'company',company,'url',url,'state',state,
        'title',payload->>'title','submitted_at',coalesce(claimed_at,created_at),'confirmation_hash',confirmation_mail_hash)),'[]') from career_apply_jobs where user_id='${u}'`));
      const auth = (from: string) => { const d = parseFrom(from).domain; return [`mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=AbC; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT) header.from=${d}`]; };
      for (const p of people.filter((x) => x.kind === "email_right" || x.kind === "email_other_job")) {
        const from = p.url.includes("greenhouse") ? `${p.company} <no-reply@us.greenhouse-mail.io>` : p.url.includes("lever") ? `${p.company} <no-reply@hire.lever.co>` : `${p.company} <no-reply@ashbyhq.com>`;
        const right = p.kind === "email_right";
        const mail: MailIn = { hash: (right ? "1" : "2").repeat(63) + String(p.job.length % 10), date: new Date(Date.now() + 60_000).toISOString(), from, auth: auth(from),
          subject: right ? `Thank you for applying to ${p.company}` : `Your application to ${p.company}`,
          snippet: right ? "We have received your application for the TEST Data Analyst role and will review it shortly."
            : "Thank you for your interest in the Senior Platform Engineer role. Unfortunately we have decided to move forward with other candidates." };
        for (const plan of planConfirmations([mail], await rowsOf(p.user))) {
          if (plan.kind !== "confirm") continue;
          const r = await pg.asService().rpc("career_apply_confirm_as", { p_user: p.user, p_id: plan.id, p_hash: plan.hash, p_kind: plan.mail_kind, p_evidence: plan.evidence, p_mail_at: plan.mail_at });
          if (r.error) bad(`${p.kind}: confirm refused: ${r.error.message}`);
        }
      }

      // ---------------------------------------------------------------- the checks, against the database
      const rows: (AppRow & { user_id: string; payload_hash: string; evidence: any })[] = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('id',id,'user_id',user_id,'job_id',job_id,
        'company',company,'state',state,'reason',reason,'confirmation_id',confirmation_id,'created_at',created_at,'updated_at',updated_at,'payload_hash',payload_hash,'evidence',evidence)),'[]') from career_apply_jobs`));
      const cloudSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RES))), (b) => b.toString(16).padStart(2, "0")).join("");
      for (const p of people) {
        const mine = rows.filter((r) => r.user_id === p.user), sent = board.filter((b) => b.user === p.user);
        if (mine.length !== 1) { bad(`${p.kind}: ${mine.length} rows`); continue; }
        const r = mine[0], line = statusLine(r);
        if (sent.length > (GOES.has(p.kind) ? 1 : 0)) bad(`${p.kind}: the board received ${sent.length} applications`);
        if (GOES.has(p.kind) && sent.length !== 1) bad(`${p.kind}: should have gone once, went ${sent.length}`);
        for (const b of sent) {
          if (b.hash !== approved.get(p.job)) bad(`${p.kind}: the board received a payload other than the approved one`);
          if (b.resume !== cloudSha) bad(`${p.kind}: the board received a resume other than the confirmed one`);
        }
        const want = p.kind === "died_after_post" ? ["unknown_outcome"] : p.kind === "email_right" ? ["confirmed"]
          : GOES.has(p.kind) ? ["submitted_unconfirmed"] : p.kind === "lease_expired_mid" ? ["not_submitted", "unknown_outcome"] : ["not_submitted"];
        if (!want.includes(r.state)) bad(`${p.kind}: ended ${r.state} (${r.reason}); expected ${want.join(" or ")}`);
        const took = r.state === "confirmed" || r.state === "submitted_unconfirmed";
        if (SAYS_SUBMITTED.test(line) !== took) bad(`${p.kind}: told "${line}"`);
        if (/, and .* confirmed it\b/.test(line) !== (r.state === "confirmed")) bad(`${p.kind}: told "${line}"`);
        if (!readableReason(line)) bad(`${p.kind}: a code in "${line}"`);
        if (/\bapplied\b/i.test(line)) bad(`${p.kind}: "applied" in "${line}"`);
        if (p.kind === "sent_elsewhere_before" && !/already (?:sent|on record)/.test(line)) bad(`${p.kind}: not told why: "${line}"`);
        if ((engineRuns.get(p.url) ?? 0) > (p.kind === "crash_before_submit" ? 2 : 1)) bad(`${p.kind}: driven ${engineRuns.get(p.url)} times`);
      }
      if (rows.some((r) => r.state === "driving" || r.state === "queued")) bad(`left in flight: ${rows.filter((r) => r.state === "driving" || r.state === "queued").map((r) => r.job_id).join(", ")}`);

      // ---------------------------------------------------------------- phase B: places in the text-card claim
      // 25 people at the dispatcher's per-person number (one sent today, one more approved), 25 paused people with approved
      // applications, then a newcomer: the newcomer's application is claimed on the next tick.
      const capped = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-0000004b${String(i).padStart(4, "0")}`);
      const paused = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-0000004c${String(i).padStart(4, "0")}`);
      const newcomer = "00000000-0000-4000-8000-0000004d0001";
      const seedB = async (u: string, n: number) => {
        await sql(`select t_person('${u}'); ${confirmedResumeSql(u, RES)};`);
        const prepIds: string[] = [];
        for (let k = 0; k < n; k++) prepIds.push(`t_prep('${u}','ashby:r4b${u.slice(-5)}:${k}','R4 B ${u.slice(-5)}','https://jobs.ashbyhq.com/r4b${u.slice(-5)}/${k}')`);
        await sql(`select t_tap('${u}', array[${prepIds.join(",")}]);`);
      };
      for (const u of capped) await seedB(u, 2);
      for (const u of paused) { await seedB(u, 1); await sql(`update career_watch_kv set value = value || '{"paused":true}' where user_id='${u}' and key='career:account'`); }
      const svc = pg.asService();
      const claimB = async () => {
        const r = await svc.rpc("career_apply_cloud_dispatch_claim2", { p_want: 60, p_global: 1000, p_per_portal: 1000, p_per_person_day: 1, p_per_site_minute: null });
        assert(!r.error, `claim2: ${r.error?.message}`);
        return (r.data ?? []) as { user_id: string; id: string }[];
      };
      const b1 = await claimB();
      const perPerson = new Map<string, number>();
      for (const j of b1) perPerson.set(j.user_id, (perPerson.get(j.user_id) ?? 0) + 1);
      if (capped.some((u) => perPerson.get(u) !== 1)) bad(`each capped person gets exactly one a day: ${JSON.stringify(Object.fromEntries(perPerson))}`);
      if (paused.some((u) => perPerson.has(u))) bad("a paused person's application was claimed");
      await seedB(newcomer, 1);
      const b2 = await claimB();
      if (!b2.some((j) => j.user_id === newcomer)) bad(`the newcomer was never claimed behind people who wait (${b2.length} claimed)`);
      if (b2.some((j) => j.user_id !== newcomer)) bad("a second tick went past someone's per-person number or pause");
      const stillQueued = Number(await sql(`select count(*) from career_apply_jobs where state = 'queued' and user_id = any(array[${paused.map((u) => `'${u}'`).join(",")}]::uuid[])`));
      if (stillQueued !== paused.length) bad(`a paused person's application ended instead of waiting (${stillQueued})`);
      await sql(`update career_apply_jobs set state = 'not_submitted', reason = 'TEST phase B closed', updated_at = now() where state = 'driving' and user_id::text like '00000000-0000-4000-8000-0000004%'`).catch(() => {});

      // ---------------------------------------------------------------- phase C: the apply VM, two workers, before the click
      const VMK = ["ok", "closed_mid", "sent_elsewhere_mid", "switch_off_mid", "optout_mid", "repeat_after_close", "reaped"] as const;
      const vm = VMK.map((kind, i) => ({ kind, user: `00000000-0000-4000-8000-0000004e${String(i).padStart(4, "0")}`, job: `lever:r4vm${i}:${7000 + i}`, url: `https://jobs.lever.co/r4vm${i}/${7000 + i}`, company: `R4 VM ${i}` }));
      for (const v of vm) {
        await sql(`select t_person('${v.user}'); ${confirmedResumeSql(v.user, RES)}; select t_posting('${v.job}','${v.url}','${v.company}');
          insert into career_message_approval_private.test_users(user_id) values ('${v.user}') on conflict do nothing;
          do $$ declare a uuid; p jsonb := public.t_payload('${v.user}','${v.job}','${v.company}','${v.url}'); h text := public.career_apply_payload_hash(p); begin
           insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at) values ('${v.user}','${v.job}',h,p,now(),now()) returning id into a;
           insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
            values (a,'${v.user}',gen_random_uuid(),0,h,now(),now()+interval '23 hours');
           insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash) values ('${v.user}','${v.job}','${v.company}','${v.url}',p,h,h); end $$;`);
      }
      // Two workers polling at once (the VM's claim serves people in turns: polled until every application is claimed).
      const vmClaim = async (w: string) => {
        const got: any[] = [];
        for (let i = 0; i < 40 && Number(await sql(`select count(*) from career_apply_jobs where state = 'queued' and job_id like 'lever:r4vm%'`)) > 0; i++) {
          const r = await svc.rpc("career_apply_vm_claim", { p_worker: w, p_limit: 4, p_per_user: 1, p_skip_hosts: [] });
          assert(!r.error, r.error?.message);
          got.push(...(r.data as any[]).map((j) => ({ ...j, worker: w })));
        }
        return got;
      };
      const [w1, w2] = await Promise.all([vmClaim("vm-r4-1"), vmClaim("vm-r4-2")]);
      const vmJobs = [...w1, ...w2].filter((j) => vm.some((v) => v.job === j.job_id));
      if (vmJobs.length !== vm.length) bad(`the VM claimed ${vmJobs.length} of ${vm.length}`);
      if (new Set(vmJobs.map((j) => j.id)).size !== vmJobs.length) bad("two VM workers claimed the same application");
      const vmBoard: string[] = [];
      const hb = async (j: any, phase: string | null) => (await svc.rpc("career_apply_vm_heartbeat", { p_id: j.id, p_lease: j.lease_token, p_worker: j.worker, p_phase: phase })).data;
      for (const j of vmJobs) {
        const v = vm.find((x) => x.job === j.job_id)!;
        if (v.kind === "closed_mid" || v.kind === "repeat_after_close") {
          if (v.kind === "repeat_after_close") { const first = await hb(j, "submitting"); if (first?.ok !== true) bad(`vm ${v.kind}: the first Submit check refused (${JSON.stringify(first)})`); }
          await sql(`update career_postings set closed_at = now() where job_id = '${v.job}'`);
        }
        if (v.kind === "sent_elsewhere_mid") await sql(`select t_sent_elsewhere('${v.user}','${v.job}','${v.url}','${v.company}')`);
        if (v.kind === "switch_off_mid") await sql(`update career_cloud_settings set value='off' where key='APPLY_VM'`);
        if (v.kind === "optout_mid") await sql(`select career_apply_cloud_optin_as('${v.user}', false, 'TEST stop')`);
        if (v.kind === "reaped") {
          await sql(`update career_apply_jobs set vm_heartbeat_at = now() - interval '10 minutes' where id = '${j.id}'`);
          await svc.rpc("career_apply_vm_reap", { p_stale_seconds: 60 });
        }
        const ok = await hb(j, "submitting");
        if (v.kind === "switch_off_mid") await sql(`update career_cloud_settings set value='on' where key='APPLY_VM'`);
        if (ok?.ok === true) {
          vmBoard.push(v.job);
          const c = await svc.rpc("career_apply_vm_complete", { p_id: j.id, p_lease: j.lease_token, p_worker: j.worker, p_state: "submitted_unconfirmed", p_reason: null, p_evidence: { confirmation_id: null } });
          if (c.error) bad(`vm ${v.kind}: complete refused: ${c.error.message}`);
        } else {
          const c = await svc.rpc("career_apply_vm_complete", { p_id: j.id, p_lease: j.lease_token, p_worker: j.worker, p_state: "not_submitted", p_reason: String(ok?.why ?? "refused"), p_evidence: { nothing_sent: true } });
          if (c.error && v.kind !== "reaped") bad(`vm ${v.kind}: could not record the refusal: ${c.error.message}`);
        }
      }
      for (const v of vm) {
        const sentN = vmBoard.filter((x) => x === v.job).length;
        if (sentN !== (v.kind === "ok" ? 1 : 0)) bad(`vm ${v.kind}: the Submit was allowed ${sentN} times`);
        const st = await sql(`select state || '|' || coalesce(reason,'') from career_apply_jobs where job_id = '${v.job}'`);
        if (v.kind === "ok" && !st.startsWith("submitted_unconfirmed")) bad(`vm ok ended ${st}`);
        if (v.kind === "repeat_after_close" && !st.startsWith("unknown_outcome")) bad(`vm ${v.kind}: after its recorded Submit step it may have gone; ended ${st}`);
        if (["closed_mid", "sent_elsewhere_mid", "switch_off_mid", "optout_mid"].includes(v.kind) && !st.startsWith("not_submitted")) bad(`vm ${v.kind}: ended ${st}`);
        if (v.kind === "reaped" && !/^(queued|driving)/.test(st)) bad(`vm reaped (before Submit): ended ${st}, expected back in the queue`);
      }

      // ---------------------------------------------------------------- phase D: one posting's identity, TypeScript and the database
      const links: string[] = [];
      for (const ats of ["greenhouse", "lever", "ashby"]) for (const v of POSTING_VARIANTS) for (const num of [7_100_001, 7_100_002]) links.push(linkOf(ats, "r4keys", num, v));
      links.push("https://jobs.lever.co/acme/abc?Lever-Source=X", "https://boards.greenhouse.io/acme/jobs/12?gh_jid=13", "http://jobs.ashbyhq.com:80/acme/x/", "https://jobs.ashbyhq.com/acme/x?b=2&a=1");
      const sqlKeys = JSON.parse(await sql(`select json_agg(public.career_apply_posting_key(u) order by o) from unnest(array[${links.map((l) => `$k$${l}$k$`).join(",")}]) with ordinality as t(u, o)`));
      links.forEach((l, i) => { if (postingKey(l) !== sqlKeys[i]) bad(`posting key differs for ${l}: TypeScript ${postingKey(l)}, database ${sqlKeys[i]}`); });

      console.log(`phase A: ${people.length} people (${KINDS.length} kinds), ${claimedTotal} claimed by two dispatchers, ${board.length} reached the board; phase B: ${b1.length} + ${b2.length} claimed for 51 people waiting; phase C: ${vmJobs.length} VM applications, ${vmBoard.length} submitted; phase D: ${links.length} links`);
      if (problems.length) throw Error(`${problems.length} broken:\n${problems.join("\n")}`);
    } finally {
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
