-- The submit worker, after the yes (20261030140000_career_apply_submit_worker.sql; the round's battery and its Postgres sample:
-- tests/architect/scenarios-submit-worker*.test.ts, flow-scenarios-submit-worker.test.ts). Every claim ends, with its reason,
-- what may never go as approved (a closed posting, an expired approval, a changed account, a resume no longer confirmed) and
-- never hands it out; a not-before not yet due no longer holds the person's place, compared at the worker's millisecond; the
-- cloud claim never returns a row it did not claim; the employer's email confirms a drive still recorded as running.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000e5a01','sw-a@example.test'),('00000000-0000-4000-8000-0000000e5a02','sw-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000e5a01'),('00000000-0000-4000-8000-0000000e5a02');
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000e5a01','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-0000000e5a02','career:account','{"epoch":1,"version":1,"paused":false}');
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000e5ab1','00000000-0000-4000-8000-0000000e5a01'),('00000000-0000-4000-8000-0000000e5ab2','00000000-0000-4000-8000-0000000e5a02');
insert into agent_flow_state(thread_id,user_id,state) select t, u::uuid,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-sw-'||right(u,4),'text','SW Analyst'))))))
 from (values ('00000000-0000-4000-8000-0000000e5ab1'::uuid,'00000000-0000-4000-8000-0000000e5a01'),('00000000-0000-4000-8000-0000000e5ab2'::uuid,'00000000-0000-4000-8000-0000000e5a02')) v(t,u);
insert into career_events(user_id,kind,subject,detail) values
 ('00000000-0000-4000-8000-0000000e5a01','fact_confirmed','SW Analyst','{"confirmation_event_id":"ev-sw-5a01"}'),
 ('00000000-0000-4000-8000-0000000e5a02','fact_confirmed','SW Analyst','{"confirmation_event_id":"ev-sw-5a02"}');
insert into storage.objects(bucket_id,name) select 'career-resumes', u || '/' || repeat('a',64) || '.pdf'
 from (values ('00000000-0000-4000-8000-0000000e5a01'),('00000000-0000-4000-8000-0000000e5a02')) v(u);
create function pg_temp.q(u text, job text, url text, exp interval) returns uuid language plpgsql as $$
declare p jsonb; h text;
begin
 p := jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','SW Co '||job,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',clock_timestamp()+exp,'resume_sha256',repeat('a',64));
 h := career_apply_payload_hash(p);
 return (career_apply_enqueue(p,h,h)).id;
end $$;
create function pg_temp.j(job text) returns career_apply_jobs language sql as $$ select * from career_apply_jobs where job_id = job $$;
update career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before the submit worker test' where state in ('queued', 'driving');
delete from career_apply_host_backoff;
insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values
 ('greenhouse:swco:1','greenhouse','swco','1','SW Co','Analyst','https://boards.greenhouse.io/swco/jobs/1',now(),now());

-- 1. A posting that closes while its application is being driven, then put back (the site said 429): the claim ends it.
select pg_temp.q('00000000-0000-4000-8000-0000000e5a01', 'greenhouse:swco:1', 'https://boards.greenhouse.io/swco/jobs/1', interval '1 day');
create temp table c1 as select * from career_apply_claim_fair(clock_timestamp(), 10, 10);
update career_postings set closed_at = now() where job_id = 'greenhouse:swco:1';
select t.ok((select state = 'driving' from pg_temp.j('greenhouse:swco:1')), 'being driven when the posting closed: the close trigger leaves it to the worker');
select career_apply_requeue_refused_for(id, lease_token, 'rate_limited', 0, null, clock_timestamp()) from c1 where job_id = 'greenhouse:swco:1';
delete from career_apply_host_backoff;
select t.ok((select count(*) = 0 from career_apply_claim_fair(clock_timestamp() + interval '1 second', 10, 10) where job_id = 'greenhouse:swco:1'), 'put back after the close: never handed out again');
select t.ok((select state = 'not_submitted' and reason = 'not sent: the posting closed before we sent it' and evidence->>'closed' = 'posting_closed'
 and (evidence->>'nothing_sent')::boolean from pg_temp.j('greenhouse:swco:1')), 'ended: the posting closed before we sent it');

-- 2. An approval that expires while queued, and a resume removed: ended with their reasons, not left waiting for ever.
select pg_temp.q('00000000-0000-4000-8000-0000000e5a02', 'greenhouse:swco:2', 'https://jobs.lever.co/swco/2', interval '1 millisecond');
select pg_sleep(0.01);
select t.ok((select count(*) = 0 from career_apply_claim_fair(clock_timestamp(), 10, 10)), 'the expired approval is not handed out');
select t.ok((select state = 'not_submitted' and reason like 'not sent: your approval expired before we could send it%' from pg_temp.j('greenhouse:swco:2')), 'ended: the approval expired');
select pg_temp.q('00000000-0000-4000-8000-0000000e5a02', 'greenhouse:swco:3', 'https://jobs.lever.co/swco/3', interval '1 day');
delete from storage.objects where name like '00000000-0000-4000-8000-0000000e5a02/%';
select t.ok((select count(*) = 0 from career_apply_claim_fair(clock_timestamp(), 10, 10)), 'a resume no longer on file: not handed out');
select t.ok((select state = 'not_submitted' and reason like 'not sent: the resume you approved it with is no longer your confirmed resume%' from pg_temp.j('greenhouse:swco:3')), 'ended: the resume');
insert into storage.objects(bucket_id,name) values ('career-resumes', '00000000-0000-4000-8000-0000000e5a02/' || repeat('a',64) || '.pdf');

-- 3. Paused: it waits (not ended); reset ("forget everything"): ended.
select pg_temp.q('00000000-0000-4000-8000-0000000e5a02', 'greenhouse:swco:4', 'https://jobs.lever.co/swco/4', interval '1 day');
update career_watch_kv set value = value || '{"paused":true}' where user_id = '00000000-0000-4000-8000-0000000e5a02' and key = 'career:account';
select t.ok((select count(*) = 0 from career_apply_claim_fair(clock_timestamp(), 10, 10)) and (select state = 'queued' from pg_temp.j('greenhouse:swco:4')), 'paused: waits, not handed out, not ended');
update career_watch_kv set value = value || '{"paused":false,"epoch":2}' where user_id = '00000000-0000-4000-8000-0000000e5a02' and key = 'career:account';
select t.ok((select count(*) = 0 from career_apply_claim_fair(clock_timestamp(), 10, 10)) and (select state = 'not_submitted' and reason like 'not sent: your Trainee account changed%' from pg_temp.j('greenhouse:swco:4')), 'reset: ended');
update career_watch_kv set value = value || '{"epoch":1}' where user_id = '00000000-0000-4000-8000-0000000e5a02' and key = 'career:account';

-- 4. A not-before not yet due does not hold the person's place; due within the worker's millisecond, it is claimed.
select pg_temp.q('00000000-0000-4000-8000-0000000e5a01', 'greenhouse:swco:5', 'https://jobs.lever.co/swco/5', interval '1 day');
select pg_temp.q('00000000-0000-4000-8000-0000000e5a01', 'greenhouse:swco:6', 'https://jobs.ashbyhq.com/swco/6', interval '1 day');
-- Both rows are enqueued in this transaction, so created_at (now()) ties and the claim's id tie-break is a random uuid: pin
-- the age so "the oldest first" is a fact, not a coin flip (it failed on a fair share of CI runs).
update career_apply_jobs set created_at = now() - interval '2 minutes' where job_id = 'greenhouse:swco:5';
update career_apply_jobs set created_at = now() - interval '1 minute' where job_id = 'greenhouse:swco:6';
create temp table c5 as select * from career_apply_claim_fair(clock_timestamp(), 1, 1);
select t.ok((select job_id = 'greenhouse:swco:5' from c5), 'the oldest first');
select career_apply_requeue_unstarted_for(id, lease_token, 'host_held', clock_timestamp() + interval '1 hour', null) from c5;
select t.ok((select string_agg(job_id, ',') = 'greenhouse:swco:6' from career_apply_claim_fair(clock_timestamp(), 1, 1)), 'the newer one goes while the older waits for its time');
update career_apply_jobs set not_before = '2026-10-31T12:00:00.123456Z' where job_id = 'greenhouse:swco:5';
select t.ok((select count(*) = 1 from career_apply_claim_fair('2026-10-31T12:00:00.123Z', 10, 10) where job_id = 'greenhouse:swco:5'), 'due in the worker''s millisecond (12:00:00.123): claimed');
update career_apply_jobs set state = 'not_submitted', reason = 'TEST done' where job_id in ('greenhouse:swco:5', 'greenhouse:swco:6');

-- 5. The employer's email for a drive still recorded as running (the worker died after the board took it).
select pg_temp.q('00000000-0000-4000-8000-0000000e5a01', 'greenhouse:swco:7', 'https://jobs.lever.co/swco/7', interval '1 day');
create temp table c7 as select * from career_apply_claim_fair(clock_timestamp(), 10, 10);
select t.ok((select career_apply_confirm_as('00000000-0000-4000-8000-0000000e5a01', (pg_temp.j('greenhouse:swco:7')).id, repeat('c',64), 'received', 'We received your application', now() + interval '1 minute') = 'confirmed'), 'the email confirms it');
select t.ok((select state = 'confirmed' and email_confirmed_at is not null from pg_temp.j('greenhouse:swco:7')), 'confirmed by the employer');
select t.must_fail($$select career_apply_finish((select id from c7 where job_id = 'greenhouse:swco:7'), (select lease_token from c7 where job_id = 'greenhouse:swco:7'), 'unknown_outcome', '{}')$$, 'invalid apply transition', 'the worker coming back cannot overwrite it');

-- 6. The rewrites are installed, and the reconcile keeps them.
select public.career_apply_reconcile_bridge();
select t.ok(position('date_trunc(''milliseconds'', not_before)' in pg_get_functiondef('public.career_apply_claim_own(integer,text)'::regprocedure)) > 0, 'the own computer''s claim skips a not-before not yet due');
select t.ok(position('continue when j.id is null' in pg_get_functiondef('public.career_apply_cloud_claim_at(integer,timestamptz)'::regprocedure)) > 0
 and position('career_apply_close_unsendable' in pg_get_functiondef('public.career_apply_cloud_claim_portal_at(integer,timestamptz,text)'::regprocedure)) > 0, 'the cloud claims');
select t.ok(public.career_apply_guards_missing() = '{}', 'no claim guard missing');

-- 7. Service only.
select t.as_user('00000000-0000-4000-8000-0000000e5a01');
set role authenticated;
select t.must_fail($$select public.career_apply_close_unsendable(array[gen_random_uuid()], now())$$, 'permission denied', 'a person cannot close applications');
select t.must_fail($$select public.career_apply_submit_worker_install()$$, 'permission denied', 'a person cannot rewrite the claims');
reset role;
rollback;
