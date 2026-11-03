// Submit worker round (2026-10-31) on a real Postgres 16 (the flow harness: every migration in production order): sampled
// scenarios of scenarios-submit-worker-battery.ts through the real worker and the database's own functions, as the service
// role calls them. The worker is the scheduler every executor shares (workers/career-browser/mass-run.ts massRun) over the
// service-side queue store (supabase/functions/_shared/career_apply_store.ts: career_apply_sweep + career_apply_claim, the
// fair pool claim, and career_apply_finish), with the database's put-back (career_apply_requeue_refused_for /
// career_apply_requeue_unstarted_for); the cloud claim (career_apply_cloud_claim) and the employer's email
// (career_apply_confirm_as) directly. The employer's board is a fake in this process (no network): it records what it was
// sent, per person and posting, with the payload's hash.
// What changes between the yes and the claim, each on its own person: the posting closes (before the claim; while the
// application is being driven and the site then says 429, so it comes back to the queue), the approval expires, the resume
// is removed, the account is paused or reset, the posting is sent another way, the site asks to wait (a not-before time),
// a verification check, a required question with no confirmed answer, the worker killed after the board took it, two
// workers at once, the worker's millisecond clock against a microsecond not-before.
// Checked against the database's rows and the board after the runs: at most one application per person and posting on the
// board, only the approved payload, only for the postings that may still go; every closed one says why in words; nothing
// left being driven; the queue never hands out a row it did not claim.
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { supabaseApplyStore } from "../../supabase/functions/_shared/career_apply_store.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { massRun, type MassJob } from "../../workers/career-browser/mass-run.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { readableReason } from "./scenarios-submit-worker-battery.ts";

const CI = Deno.env.get("CI") === "true";
const PER = Number(Deno.env.get("SUBMIT_WORKER_PG_PER") ?? 3);
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const KINDS = ["ok", "closed_before_claim", "closed_while_driving_then_429", "expired_while_queued", "resume_removed", "paused", "account_reset",
  "sent_elsewhere", "captcha", "needs_answers", "host_wait_then_newer", "unconfirmed"] as const;
type Kind = typeof KINDS[number];
// What may reach the board for each (host_wait_then_newer: the older one waits an hour for its not-before time; its newer one goes).
const GOES: Record<Kind, boolean> = { ok: true, closed_before_claim: false, closed_while_driving_then_429: false, expired_while_queued: false, resume_removed: false,
  paused: false, account_reset: false, sent_elsewhere: false, captcha: false, needs_answers: false, host_wait_then_newer: false, unconfirmed: true };

const seedPerson = (u: string, n: string) => `
insert into auth.users(id,email) values ('${u}','sw-${n}@example.test');
insert into profiles(id) values ('${u}');
insert into career_watch_kv(user_id,key,value) values ('${u}','career:account','{"epoch":1,"version":1,"paused":false}');
insert into agent_threads(id,user_id) values (gen_random_uuid(),'${u}');
insert into agent_flow_state(thread_id,user_id,state) select id, '${u}', jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-sw-${n}','text','TEST Analyst')))))) from agent_threads where user_id='${u}';
insert into career_events(user_id,kind,subject,detail) values ('${u}','fact_confirmed','TEST Analyst','{"confirmation_event_id":"ev-sw-${n}"}');
insert into storage.objects(bucket_id,name) values ('career-resumes', '${u}/' || repeat('a',64) || '.pdf');`;
const ENQUEUE = `create or replace function pg_temp.dummy() returns int language sql as 'select 1';
create or replace function public.test_sw_enqueue(u text, job text, url text, exp interval, extra jsonb default '{}') returns uuid language plpgsql as $$
declare p jsonb; h text;
begin
 p := jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','TEST Employer '||job,'url',url,'fields',
   jsonb_build_array(jsonb_build_object('name','f0','label','TEST question','value','TEST answer','factId','F-101','user_id',u)),
  'privacy_epoch',1,'account_version',1,'expires_at',now()+exp,'resume_sha256',repeat('a',64),'engine_approval',repeat('e',64),'destination',url) || extra;
 h := career_apply_payload_hash(p);
 return (career_apply_enqueue(p,h,h)).id;
end $$;`;

interface Seeded { kind: Kind; user: string; job: string; url: string; newer?: string }

async function seed(pg: Pg, kinds: Kind[]): Promise<Seeded[]> {
  const out: Seeded[] = [];
  let sql = ENQUEUE;
  kinds.forEach((kind, i) => {
    const u = `dddddddd-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    sql += seedPerson(u, String(i));
    const job = `greenhouse:sw${i}:${1000 + i}`, url = `https://boards.greenhouse.io/sw${i}/jobs/${1000 + i}`;
    out.push({ kind, user: u, job, url, ...(kind === "host_wait_then_newer" ? { newer: `lever:sw${i}:${2000 + i}` } : {}) });
  });
  await pg.sql(sql);
  const posts = out.map((s) => `('${s.job}','greenhouse','sw','${s.job.split(":")[2]}','TEST Employer','TEST Analyst','${s.url}',now(),now())`).join(",");
  await pg.sql(`insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values ${posts}`);
  for (const s of out) {
    await pg.sql(`select test_sw_enqueue('${s.user}','${s.job}','${s.url}', ${s.kind === "expired_while_queued" ? "interval '2 seconds'" : "interval '1 day'"})`);
    if (s.newer) await pg.sql(`select test_sw_enqueue('${s.user}','${s.newer}','https://jobs.lever.co/sw/${s.newer.split(":")[2]}', interval '1 day')`);
  }
  return out;
}

// The board, and the engine that talks to it.
function boardOf(byJob: Map<string, Seeded>) {
  const got: { user: string; posting: string; hash: string; approval: string }[] = [];
  const seen = new Set<string>(); // the first time each application reaches the engine
  const engine = async (job: any): Promise<{ state: string; reason?: string; retry?: number; questions?: unknown[] }> => {
    const s = byJob.get(job.job_id) ?? [...byJob.values()].find((x) => x.newer === job.job_id)!;
    const isNewer = s.newer === job.job_id, first = !seen.has(job.job_id);
    seen.add(job.job_id);
    const hash = await hashApplyPayload(job.payload);
    if (!isNewer) {
      if (s.kind === "captcha") return { state: "needs_user", reason: "captcha" };
      if (s.kind === "needs_answers") return { state: "not_submitted", reason: "needs_answers", questions: [{ label: "TEST Why us?", type: "textarea", options: [] }] };
      if (s.kind === "closed_while_driving_then_429" && first) return { state: "requeue", retry: 0 };
      if (s.kind === "host_wait_then_newer" && first) return { state: "putback" };
    }
    got.push({ user: job.user_id, posting: job.job_id, hash, approval: job.approval_hash });
    return { state: s.kind === "unconfirmed" ? "submitted_unconfirmed" : "confirmed" };
  };
  return { got, engine };
}

const claimErrors: string[] = [];
async function worker(pg: Pg, b: ReturnType<typeof boardOf>, o: { between?: (job: any) => Promise<void> } = {}) {
  const admin = pg.asService(), store = supabaseApplyStore(admin); // its finish: career_apply_finish
  const rpc = async (name: string, args: Record<string, unknown>) => { const r = await admin.rpc(name, args); if (r.error) throw Object.assign(Error(r.error.message), { body: r.error.message }); return r.data; };
  return await massRun<MassJob & any>({
    // The many-instance cloud worker's claim (career_apply_claim_fair, the service role's), after the database's sweep, on the
    // worker's own millisecond clock. (career_apply_claim, supabaseApplyStore's, is not the service role's to call.)
    claim: async (n) => {
      const t = new Date(Date.now()).toISOString();
      await rpc("career_apply_sweep", { p_now: t });
      return await rpc("career_apply_claim_fair", { p_now: t, p_limit: n, p_per_person: 1 }) ?? [];
    },
    onClaimError: (e) => { claimErrors.push(String((e as Error)?.message ?? e)); return "stop"; },
    run: async (job, onStart) => {
      await onStart();
      const r = await b.engine(job);
      if (Deno.env.get("SW_DEBUG")) console.log(`ran ${job.job_id}: ${JSON.stringify(r)}`);
      if (r.state === "requeue") {
        await o.between?.(job);
        return { state: "not_submitted", reason: "HOST_RATE_LIMITED", recorded: false, requeue: true, status: 429, retry_after_s: r.retry ?? null };
      }
      if (r.state === "putback") {
        const x = await rpc("career_apply_requeue_unstarted_for", { p_id: job.id, p_lease: job.lease_token, p_why: "host_held", p_until: new Date(Date.now() + 3_600_000).toISOString() });
        return { state: "queued", reason: "host_held", recorded: true, not_before: Date.parse(x.not_before) };
      }
      await store.finish(job, r.state as any, { reason: r.reason ?? null, ...(r.questions ? { questions: r.questions } : {}) });
      return { state: r.state, reason: r.reason ?? null, recorded: true };
    },
    requeue: async (job, q) => {
      const x = await rpc("career_apply_requeue_refused_for", { p_id: job.id, p_lease: job.lease_token, p_reason: q.reason, p_retry_after_s: q.retryAfterS ?? 0, p_until: null });
      return { state: "queued", reason: "HOST_RATE_LIMITED", recorded: true, not_before: Date.parse(x.not_before) };
    },
    putBack: async (job, why, until) => {
      await rpc("career_apply_requeue_unstarted_for", { p_id: job.id, p_lease: job.lease_token, p_why: String(why).split(":")[0].toLowerCase(), p_until: new Date(until).toISOString() });
      return { state: "queued", reason: why, recorded: true };
    },
    unstarted: async (job, why) => { await store.finish(job, "not_submitted", { reason: why }); return { state: "not_submitted", reason: why, recorded: true }; },
    orphaned: async (job) => { await store.finish(job, "unknown_outcome", { reason: "WORKER_STOPPED" }); return { state: "unknown_outcome", recorded: true }; },
    pacing: { concurrency: 4, claimBatch: 8, hostMax: Infinity, hostSpacingMs: 0, startBudgetMs: 240_000 },
    stop: () => false, drain: true, idleMs: 1, sleep: async () => {}, log: Deno.env.get("SW_DEBUG") ? (l: string) => console.log(l) : () => {},
    // A host held off by our own 429 test would hold the drain for 30 s: the gate here never holds (the database's does).
    gate: { shared: false, until: async (hs) => new Map(hs.map((h) => [h, 0])), refused: async (_h, _w, _r, now) => now, ok: async () => {} },
  });
}

Deno.test({ name: "submit worker round on Postgres: what changes after the yes, through the real worker", ignore: !pgBinDir() && !CI, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const pg = await startPg();
  try {
    const kinds = KINDS.flatMap((k) => Array.from({ length: PER }, () => k));
    const dbg = (m: string) => { if (Deno.env.get("SW_DEBUG")) console.log(m); };
    dbg("seeding");
    const people = await seed(pg, kinds);
    dbg("seeded");
    const byJob = new Map(people.map((s) => [s.job, s]));
    // Between the yes and the claim.
    for (const s of people) {
      if (s.kind === "closed_before_claim") await pg.sql(`update career_postings set closed_at = now() where job_id = '${s.job}'`);
      if (s.kind === "resume_removed") await pg.sql(`delete from storage.objects where name like '${s.user}/%'`);
      if (s.kind === "paused") await pg.sql(`update career_watch_kv set value = value || '{"paused":true}' where user_id = '${s.user}' and key = 'career:account'`);
      if (s.kind === "account_reset") await pg.sql(`update career_watch_kv set value = value || '{"epoch":2}' where user_id = '${s.user}' and key = 'career:account'`);
      if (s.kind === "sent_elsewhere") await pg.sql(`insert into extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, success_text, tracker_record)
        values ('${s.user}', 'TEST Employer', 'TEST Analyst', '${s.url}', 'Thanks for applying (TEST)', true, '{}'::jsonb)`);
    }
    await new Promise((r) => setTimeout(r, 2_500)); // the short approvals expire
    const b = boardOf(byJob);
    // Two workers at once, in rounds: an instance whose claim found every turn locked by the other ends its drain, so the
    // rounds go on until nothing that may go is left queued (at most 8).
    const between = async (job: any) => {
      const s = byJob.get(job.job_id);
      if (s?.kind === "closed_while_driving_then_429") await pg.sql(`update career_postings set closed_at = now() where job_id = '${s.job}'`);
    };
    for (let round = 0; round < 8; round++) {
      dbg(`round ${round}`);
      await Promise.all([worker(pg, b, { between }), worker(pg, b, { between })]);
      await pg.sql(`delete from career_apply_host_backoff`);
      const left = await pg.sql(`select count(*) from career_apply_jobs j join career_watch_kv a on a.user_id = j.user_id and a.key = 'career:account'
        where j.job_id like '%:sw%' and j.state = 'queued' and (j.not_before is null or j.not_before <= now() + interval '1 minute') and a.value->>'paused' = 'false'`);
      if (left === "0") break;
    }
    const rows = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('user', user_id, 'job', job_id, 'state', state, 'reason', reason, 'ev', evidence)), '[]') from career_apply_jobs where job_id like '%:sw%'`)) as any[];

    eq(claimErrors, [], "every claim answered");
    await t.step("the board: at most one per person and posting, only the approved payload, only what may still go", () => {
      const per = new Map<string, number>();
      for (const g of b.got) {
        per.set(`${g.user}|${g.posting}`, (per.get(`${g.user}|${g.posting}`) ?? 0) + 1);
        assert(g.hash === g.approval, `the board got a payload other than the approved one: ${g.posting}`);
      }
      for (const [k, n] of per) assert(n === 1, `${k} sent ${n} times`);
      for (const s of people) {
        const sent = per.get(`${s.user}|${s.job}`) ?? 0;
        assert(sent === (GOES[s.kind] ? 1 : 0), `${s.kind}: the board got ${sent} for ${s.job}`);
        if (s.newer) assert(per.get(`${s.user}|${s.newer}`) === 1, `${s.kind}: the person's newer application was held behind a job waiting on its not-before time`);
      }
    });
    await t.step("every row: ended with words, or waiting with a reason; none left being driven", () => {
      for (const r of rows) {
        assert(r.state !== "driving", `${r.job} left driving`);
        const s = byJob.get(r.job) ?? people.find((x) => x.newer === r.job)!;
        const line = statusLine({ id: r.job, company: "TEST Employer", state: r.state, reason: r.reason, created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" });
        assert(readableReason(line), `${s.kind}: the person reads a code: ${line}`);
        if (r.job !== s.job) continue;
        const want: Partial<Record<Kind, [string, RegExp]>> = {
          closed_before_claim: ["not_submitted", /closed/], closed_while_driving_then_429: ["not_submitted", /^not sent: the posting closed before we sent it$/],
          expired_while_queued: ["not_submitted", /approval expired/], resume_removed: ["not_submitted", /no longer your confirmed resume/],
          account_reset: ["not_submitted", /account changed/], sent_elsewhere: ["not_submitted", /already sent/], paused: ["queued", /.*/],
          host_wait_then_newer: ["queued", /^waiting: /],
          captcha: ["needs_user", /captcha/], needs_answers: ["not_submitted", /needs_answers/],
        };
        const w = want[s.kind];
        if (w) assert(r.state === w[0] && w[1].test(String(r.reason ?? "")), `${s.kind}: ${r.state} / ${r.reason}`);
        if (["closed_before_claim", "closed_while_driving_then_429", "expired_while_queued", "resume_removed", "account_reset"].includes(s.kind)) {
          assert(r.ev?.nothing_sent === true || r.ev?.closed === "posting_closed", `${s.kind}: the record says nothing was sent: ${JSON.stringify(r.ev)}`);
        }
      }
    });

    await t.step("the worker's millisecond clock: a job due within the current millisecond is claimed", async () => {
      const u = "dddddddd-0000-4000-8000-0000000ff001";
      await pg.sql(seedPerson(u, "ms") + `select test_sw_enqueue('${u}','lever:swms:1','https://jobs.lever.co/swms/1', interval '1 day');`);
      const T = "2026-10-31T12:00:00.123456Z";
      const c = JSON.parse(await pg.sql(`select to_jsonb(x) from career_apply_claim_fair(clock_timestamp(), 50, 1) x where job_id = 'lever:swms:1'`));
      await pg.sql(`select career_apply_requeue_unstarted_for('${c.id}', '${c.lease_token}', 'worker_stopping', null, null)`);
      // Due at a microsecond the worker's millisecond clock cannot say (as clock_timestamp() writes it).
      await pg.sql(`update career_apply_jobs set not_before = '${T}' where id = '${c.id}'`);
      // The worker's clock (JavaScript) in the same millisecond: 12:00:00.123.
      const got = await pg.sql(`select count(*) from career_apply_claim_fair('2026-10-31T12:00:00.123Z', 50, 1) where job_id = 'lever:swms:1'`);
      eq(got, "1", "claimed at the worker's 12:00:00.123");
      await pg.sql(`update career_apply_jobs set state = 'not_submitted', reason = 'TEST done' where id = '${c.id}'`);
    });

    await t.step("the cloud claim: closes what may never go, skips a not-before, never returns a row it did not claim", async () => {
      const u = "dddddddd-0000-4000-8000-0000000ff002";
      await pg.sql(seedPerson(u, "cloud") + `
        insert into career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on') on conflict (key) do update set value='on';
        select career_apply_cloud_optin_as('${u}',true,'TEST terms');
        insert into career_apply_cloud_gate_waivers(user_id,portal,max_sends,expires_at,note) values ('${u}','lever',5,now()+interval '1 day','TEST');
        select test_sw_enqueue('${u}','lever:swc:1','https://jobs.lever.co/swc/1', interval '1 day');
        select test_sw_enqueue('${u}','lever:swc:2','https://jobs.lever.co/swc/2', interval '1 second');
        select test_sw_enqueue('${u}','lever:swc:3','https://jobs.lever.co/swc/3', interval '1 day');
        insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at)
         values ('lever:swc:3','lever','swc','3','TEST Employer','TEST Analyst','https://jobs.lever.co/swc/3',now(),now());`);
      const one = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from career_apply_cloud_claim(1) x`));
      eq(one.map((x: any) => x.job_id), ["lever:swc:1"], "the oldest first");
      await pg.sql(`select career_apply_requeue_unstarted_for('${one[0].id}', '${one[0].lease_token}', 'host_held', clock_timestamp() + interval '1 hour', null)`);
      await pg.sql(`update career_postings set closed_at = now() where job_id = 'lever:swc:3'; select pg_sleep(1.2);`);
      const next = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from career_apply_cloud_claim(5) x`));
      assert(next.every((x: any) => typeof x.id === "string" && typeof x.lease_token === "string"), `a row the claim did not take: ${JSON.stringify(next)}`);
      eq(next.length, 0, "nothing else may go");
      const st = await pg.sql(`select string_agg(job_id || '=' || state || ':' || coalesce(evidence->>'closed', '-'), ',' order by job_id) from career_apply_jobs where user_id = '${u}'`);
      eq(st, "lever:swc:1=queued:-,lever:swc:2=not_submitted:approval_expired,lever:swc:3=not_submitted:posting_closed", "the expired and the closed are ended with their reasons; the waiting one waits");
      await pg.sql(`update career_cloud_settings set value = 'off' where key = 'CAREER_CLOUD_APPLY'`);
    });

    await t.step("the employer's email while the drive is still recorded as running (the worker died after the board took it)", async () => {
      const u = "dddddddd-0000-4000-8000-0000000ff003";
      await pg.sql(seedPerson(u, "mail") + `select test_sw_enqueue('${u}','lever:swe:1','https://jobs.lever.co/swe/1', interval '1 day');`);
      const c = JSON.parse(await pg.sql(`select to_jsonb(x) from career_apply_claim_fair(clock_timestamp(), 50, 1) x where job_id = 'lever:swe:1'`));
      // The board took it; the worker died before career_apply_finish. The employer's email arrives a minute later.
      const r = await pg.sql(`select career_apply_confirm_as('${u}', '${c.id}', repeat('c', 64), 'received', 'We have received your application', now() + interval '1 minute')`);
      eq(r, "confirmed", "the email confirms it");
      eq(await pg.sql(`select state || ':' || (email_confirmed_at is not null) from career_apply_jobs where id = '${c.id}'`), "confirmed:true", "confirmed by the employer");
      // The worker coming back cannot overwrite it, and the sweep leaves it.
      const fin = await pg.asService().rpc("career_apply_finish", { p_id: c.id, p_lease: c.lease_token, p_state: "unknown_outcome", p_evidence: {} });
      assert(fin.error && /invalid apply transition/.test(fin.error.message), `finish after the email: ${JSON.stringify(fin)}`);
      await pg.sql(`select career_apply_sweep(now() + interval '1 hour')`);
      eq(await pg.sql(`select state from career_apply_jobs where id = '${c.id}'`), "confirmed", "still confirmed after the sweep");
      // An email from before the claim never confirms a drive.
      await pg.sql(`select test_sw_enqueue('${u}','lever:swe:2','https://jobs.lever.co/swe/2', interval '1 day')`);
      const raw = await pg.sql(`select to_jsonb(x) from career_apply_claim_fair(clock_timestamp(), 50, 1) x where job_id = 'lever:swe:2'`);
      assert(raw, `not claimed: ${await pg.sql(`select to_jsonb(j) - 'payload' from career_apply_jobs j where job_id = 'lever:swe:2'`)} ${await pg.sql(`select to_jsonb(t) from career_apply_claim_turns t where user_id = '${u}'`)} ${await pg.sql(`select coalesce(jsonb_agg(b), '[]') from career_apply_host_backoff b`)}`);
      const d = JSON.parse(raw);
      eq(await pg.sql(`select career_apply_confirm_as('${u}', '${d.id}', repeat('d', 64), 'received', 'We have received your application', now() - interval '1 hour')`), "outside_window", "an earlier email");
      await pg.sql(`update career_apply_jobs set state = 'not_submitted', reason = 'TEST done' where id = '${d.id}'`);
    });

    await t.step("the reconcile keeps the rewrites (scripts/launch/verify-claim-guards.sql runs it after every apply)", async () => {
      await pg.sql(`select public.career_apply_reconcile_bridge()`);
      eq(await pg.sql(`select position('date_trunc(''milliseconds'', not_before)' in pg_get_functiondef('public.career_apply_claim_own(integer,text)'::regprocedure)) > 0`), "t", "the own computer's claim");
      eq(await pg.sql(`select public.career_apply_guards_missing() = '{}' and public.career_apply_cloud_runner_missing() = '{}'`), "t", "no claim guard missing; the runner's claim matches claim_at");
    });
    console.log(`submit worker on Postgres: ${people.length} people over ${KINDS.length} kinds (${PER} each), two workers at once, board got ${b.got.length}`);
  } finally {
    await pg.stop();
  }
});
