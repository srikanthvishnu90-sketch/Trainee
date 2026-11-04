-- Back off, then RESUME (20261029180000_career_apply_refusal_requeue.sql; owner rule 2026-10-27). An approved application
-- whose employer's site refused for load before anything was sent goes back to the queue as the same job, its approval
-- and hash untouched, and is not handed out before its not-before time (the host's hold), by any claim; then it runs
-- once. Every refusal backs off again, with no cap of Trainee's own. A drive that may have sent (unknown), a finished
-- one, a verification check, the email path and the extension are never put back. Fixed instants (now() is the
-- transaction's start); everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000c9b01','requeue-a@example.test'),('00000000-0000-4000-8000-0000000c9b02','requeue-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000c9b01'),('00000000-0000-4000-8000-0000000c9b02');
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000c9b01','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-0000000c9b02','career:account','{"epoch":1,"version":1,"paused":false}');
-- Each: a confirmed resume on file (an entry and its event) and its file stored under sha256 'a'x64 (the owner's resume rule).
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000c9bb1','00000000-0000-4000-8000-0000000c9b01'),('00000000-0000-4000-8000-0000000c9bb2','00000000-0000-4000-8000-0000000c9b02');
insert into agent_flow_state(thread_id,user_id,state) select t, u::uuid,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-rq-'||right(u,4),'text','RQ Analyst'))))))
 from (values ('00000000-0000-4000-8000-0000000c9bb1'::uuid,'00000000-0000-4000-8000-0000000c9b01'),('00000000-0000-4000-8000-0000000c9bb2'::uuid,'00000000-0000-4000-8000-0000000c9b02')) v(t,u);
insert into career_events(user_id,kind,subject,detail) values
 ('00000000-0000-4000-8000-0000000c9b01','fact_confirmed','RQ Analyst','{"confirmation_event_id":"ev-rq-9b01"}'),
 ('00000000-0000-4000-8000-0000000c9b02','fact_confirmed','RQ Analyst','{"confirmation_event_id":"ev-rq-9b02"}');
insert into storage.objects(bucket_id,name) select 'career-resumes', u || '/' || repeat('a',64) || '.pdf'
 from (values ('00000000-0000-4000-8000-0000000c9b01'),('00000000-0000-4000-8000-0000000c9b02')) v(u);
create function pg_temp.q(u text, job text, url text) returns uuid language plpgsql as $$
declare p jsonb; h text;
begin
 p := jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','RQ Co '||job,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64));
 h := career_apply_payload_hash(p);
 return (career_apply_enqueue(p,h,h)).id;
end $$;
create function pg_temp.j(job text) returns career_apply_jobs language sql as $$ select * from career_apply_jobs where job_id = job $$;
-- Nothing else is queued in this transaction's view but these (the pool claim is across people).
update career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before the requeue test' where state = 'queued';
select pg_temp.q('00000000-0000-4000-8000-0000000c9b01', 'rq:1', 'https://jobs.lever.co/rqco/1');
select pg_temp.q('00000000-0000-4000-8000-0000000c9b01', 'rq:2', 'https://jobs.lever.co/rqco/2');
select pg_temp.q('00000000-0000-4000-8000-0000000c9b01', 'rq:3', 'https://jobs.ashbyhq.com/rqother/3');
create temp table approved as select id, job_id, payload, payload_hash, approval_hash from career_apply_jobs where job_id like 'rq:%';
delete from career_apply_host_backoff where host in ('jobs.lever.co', 'jobs.ashbyhq.com');

-- 1. The cloud claims all three; the employer's site answers rq:1 with 429, Retry-After 120, before anything was filled.
create temp table c1 as select * from career_apply_claim_fair(now(), 10, 10);
select t.ok((select count(*) = 3 and bool_and(state = 'driving' and source = 'cloud' and attempts = 1) from c1), 'the cloud claims all three');
create temp table r1 as select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:1'), (select lease_token from c1 where job_id = 'rq:1'),
 'rate_limited', 120, null, now()) v;
select t.ok((select v->>'state' = 'queued' and (v->>'not_before')::timestamptz = now() + interval '120 seconds' and (v->>'refusals')::int = 1 from r1),
 'a 429 with Retry-After 120: the same job is queued again, not before 120 s from now');
select t.ok((select state = 'queued' and attempts = 0 and lease_token is null and claimed_at is null and source is null and host_refusals = 1
  and not_before = now() + interval '120 seconds' and reason like 'waiting: the employer''s site asked us to slow down%nothing was sent%'
 from pg_temp.j('rq:1')), 'it is as before its claim: queued, no lease, no source; the reason says it waits and nothing was sent');
select t.ok((select j.payload = a.payload and j.payload_hash = a.payload_hash and j.approval_hash = a.approval_hash and j.id = a.id
 from pg_temp.j('rq:1') j join approved a using (job_id)), 'the same job: its approval, payload and payload hash unchanged (no new approval)');
select t.ok((select count(*) = 1 from career_apply_jobs where job_id = 'rq:1'), 'one row for the posting');
select t.ok((select until >= now() + interval '120 seconds' from career_apply_host_backoff where scope = 'cloud' and host = 'jobs.lever.co'),
 'the host''s back-off holds at least as long, so the claims skip its host');
-- The refused run's lease is gone: it can record nothing more for this job.
select t.must_fail($$select career_apply_finish((select id from c1 where job_id = 'rq:1'), (select lease_token from c1 where job_id = 'rq:1'), 'submitted_unconfirmed', '{}')$$,
 'invalid apply claim', 'the refused run''s old lease cannot finish the job');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:1'), (select lease_token from c1 where job_id = 'rq:1'), 'rate_limited', 1, null, now())$$,
 'invalid apply claim', 'nor put it back twice');

-- 2. The same posting approved again while it waits: refused as the same posting (it is in flight); still one job.
select t.must_fail($$select pg_temp.q('00000000-0000-4000-8000-0000000c9b01', 'rq:1', 'https://jobs.lever.co/rqco/1')$$, 'duplicate_job',
 'approving the waiting posting again adds nothing: it goes at most once');

-- 3. Before its time no claim hands it out: the host is held, and even with the host's back-off gone (another worker's
--    success, a deleted row) the job's own not-before time holds (career_apply_jobs_not_before, on every claim).
create temp table c2 as select * from career_apply_claim_fair(now() + interval '60 seconds', 10, 10);
select t.ok((select count(*) = 0 from c2) and (select state = 'queued' from pg_temp.j('rq:1')), 'at 60 s: not handed out (its host is held)');
delete from career_apply_host_backoff where scope = 'cloud' and host = 'jobs.lever.co';
create temp table c3 as select * from career_apply_claim_fair(now() + interval '119 seconds', 10, 10);
select t.ok((select count(*) = 0 from c3) and (select state = 'queued' and attempts = 0 from pg_temp.j('rq:1')),
 'at 119 s with the host''s back-off deleted: still not handed out (the job''s own not-before time)');
select t.ok((select count(*) = 0 from career_apply_claim(now() + interval '119 seconds', 10)), 'the pool claim''s door neither');
-- 4. Once its time has come it is claimed again, once, under a new lease.
create temp table c4 as select * from career_apply_claim_fair(now() + interval '121 seconds', 10, 10);
select t.ok((select count(*) = 1 and bool_and(job_id = 'rq:1' and state = 'driving' and attempts = 1 and source = 'cloud') from c4), 'at 121 s: claimed again');
select t.ok((select c4.lease_token is distinct from c1.lease_token from c4 join c1 using (id)), 'under a new lease');
select t.ok((select count(*) = 0 from career_apply_claim_fair(now() + interval '122 seconds', 10, 10)), 'and only once');

-- 5. It is refused again, and again: each refusal backs off again; no cap of Trainee's own on how many times.
--    No Retry-After and no gate: 30 s, doubling per refusal in a row (the gate's own rule). The gate's answer: its time.
create temp table seq (n int, lease uuid, at timestamptz, v jsonb);
do $$
declare l uuid := (select lease_token from c4); at timestamptz := now() + interval '121 seconds'; v jsonb; i int; c career_apply_jobs;
begin
 for i in 1 .. 12 loop
  v := career_apply_requeue_refused_for((select id from approved where job_id = 'rq:1'), l, 'rate_limited', null, null, at);
  insert into seq values (i, l, at, v);
  at := (v->>'not_before')::timestamptz;
  select * into c from career_apply_claim_fair(at, 10, 10) limit 1;
  if c.id is null then raise exception 'FAIL refusal % : not claimed again at its time', i; end if;
  l := c.lease_token;
 end loop;
 update seq set lease = l where n = 12;
end $$;
select t.ok((select array_agg((v->>'wait_seconds')::int order by n) = '{30,60,120,240,480,960,1920,3600,30,60,120,240}' from seq),
 'no Retry-After: 30 s, doubling each time it is refused again, asked again at most an hour apart (an hour apart starts over, as the gate does)');
select t.ok((select host_refusals = 13 and state = 'driving' from pg_temp.j('rq:1')), 'refused 13 times and still driven again: no cap of Trainee''s own');
-- The gate's answer and the host's Retry-After: the later of the two.
create temp table r5 as select career_apply_requeue_refused_for((select id from approved where job_id = 'rq:1'), (select lease from seq where n = 12),
 'server_busy', 5, (select at from seq where n = 12) + interval '3600 seconds' + interval '45 seconds', (select at from seq where n = 12) + interval '3600 seconds') v;
select t.ok((select (v->>'wait_seconds')::int = 45 from r5), 'a 503 with a gate''s hold of 45 s and Retry-After 5: waits 45 s (the later)');
select t.ok((select reason like '%(busy)%' from pg_temp.j('rq:1')), 'the 503 said as busy');
create temp table c5 as select * from career_apply_claim_fair((select (v->>'not_before')::timestamptz from r5), 10, 10);
select t.ok((select count(*) = 1 from c5), 'claimed again at its time');

-- 6. Submitted once: after the finish nothing puts it back.
select career_apply_finish((select id from c5), (select lease_token from c5), 'submitted_unconfirmed', '{"reason":"acknowledged"}');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c5), (select lease_token from c5), 'rate_limited', 1, null, now())$$,
 'invalid apply transition', 'a submitted application is never put back');
select t.ok((select state = 'submitted_unconfirmed' and host_refusals = 14 from pg_temp.j('rq:1')), 'it was submitted once, after 14 refusals');

-- 7. A drive that may have sent (the engine started, the outcome unknown) is never put back or driven again.
select career_apply_finish((select id from c1 where job_id = 'rq:2'), (select lease_token from c1 where job_id = 'rq:2'), 'unknown_outcome', '{"reason":"the worker stopped while this application ran; not retried"}');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:2'), (select lease_token from c1 where job_id = 'rq:2'), 'rate_limited', 1, null, now())$$,
 'invalid apply transition', 'an unknown outcome is never put back');
select t.ok((select count(*) = 0 from career_apply_claim_fair(now() + interval '2 days', 10, 10)), 'and never claimed again');
-- 8. A verification check is the person's: needs_user; never a load refusal, never put back.
select t.must_fail($$select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:3'), (select lease_token from c1 where job_id = 'rq:3'), 'bot_wall', null, null, now())$$,
 'invalid portal refusal', 'a verification check is not put back');
select career_apply_finish((select id from c1 where job_id = 'rq:3'), (select lease_token from c1 where job_id = 'rq:3'), 'needs_user', '{"reason":"bot_check"}');
select t.ok((select state = 'needs_user' and host_refusals = 0 from pg_temp.j('rq:3')), 'it stays needs_user');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:3'), (select lease_token from c1 where job_id = 'rq:3'), 'rate_limited', 1, null, now())$$,
 'invalid apply transition', 'and needs_user is never put back');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c1 where job_id = 'rq:3'), (select lease_token from c1 where job_id = 'rq:3'), 'too_many_today', 1, null, now())$$,
 'invalid portal refusal', 'only an outside refusal: no reason of Trainee''s own');

-- 9. The person's own computer: only their own job, driven there; the host held for their computer.
select pg_temp.q('00000000-0000-4000-8000-0000000c9b01', 'rq:4', 'https://jobs.lever.co/rqco/4');
select t.as_user('00000000-0000-4000-8000-0000000c9b01');
set role authenticated;
create temp table c6 as select * from career_apply_claim_own(10, 'own_computer');
reset role;
grant select on c6 to authenticated;
select t.ok((select count(*) = 1 and bool_and(source = 'own_computer') from c6), 'the person''s computer claims it');
select t.as_user('00000000-0000-4000-8000-0000000c9b02');
set role authenticated;
select t.must_fail($$select career_apply_requeue_refused_own((select id from c6), (select lease_token from c6), 'rate_limited', 30, null)$$, 'invalid apply claim',
 'another person cannot put it back');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c6), (select lease_token from c6), 'rate_limited', 30, null, now())$$, 'permission denied',
 'a signed-in person cannot call the service''s requeue');
reset role;
select t.as_user('00000000-0000-4000-8000-0000000c9b01');
set role authenticated;
create temp table r6 as select career_apply_requeue_refused_own((select id from c6), (select lease_token from c6), 'rate_limited', 30, null) v;
reset role;
select t.ok((select v->>'state' = 'queued' and (v->>'wait_seconds')::int between 29 and 30 and v->>'scope' = '00000000-0000-4000-8000-0000000c9b01' from r6),
 'the person''s own: queued again, 30 s (its Retry-After), held for their computer');
select t.ok((career_apply_host_wait('https://jobs.lever.co/rqco/4', '00000000-0000-4000-8000-0000000c9b01', now())->>'waiting')::boolean,
 'their computer''s claim skips the host while it waits');
select t.as_user('00000000-0000-4000-8000-0000000c9b01');
set role authenticated;
select t.ok((select count(*) = 0 from career_apply_claim_own(10, 'own_computer')), 'and their computer is not handed it before its time');
reset role;

-- 10. The extension and the email path are never put back (only a browser worker's drive).
update career_apply_jobs set not_before = null where job_id = 'rq:4';
delete from career_apply_host_backoff where host = 'jobs.lever.co';
select t.as_user('00000000-0000-4000-8000-0000000c9b01');
set role authenticated;
create temp table c7 as select * from career_apply_claim_own(10, 'extension');
reset role;
select t.ok((select count(*) = 1 and bool_and(source = 'extension') from c7), 'the extension claims it');
select t.must_fail($$select career_apply_requeue_refused_for((select id from c7), (select lease_token from c7), 'rate_limited', 30, null, now())$$,
 'invalid apply transition', 'the extension''s drive is never put back');

-- 11. The source a claim gave is still fixed for anything but the requeue.
select t.must_fail($$update career_apply_jobs set state = 'queued', attempts = 0, lease_token = null, claimed_at = null, source = null where id = (select id from c7)$$,
 'source_fixed', 'a plain update cannot clear a claim''s source');
select t.must_fail($$with m as (select set_config('career.apply_requeue', gen_random_uuid()::text, true) s) update career_apply_jobs set state = 'queued', attempts = 0, lease_token = null, claimed_at = null, source = null where id = (select id from c7) and exists (select from m)$$,
 'source_fixed', 'nor with the requeue''s mark for another job');
select set_config('career.apply_requeue', '', true);
select t.must_fail($$update career_apply_jobs set payload = payload || '{"x":1}' where job_id = 'rq:1'$$, 'approval_fixed', 'the approval is still frozen');

-- 12. Permissions: no anonymous caller; the service's requeue is the service's.
select t.ok(not has_function_privilege('anon', 'public.career_apply_requeue_refused_for(uuid,uuid,text,integer,timestamptz,timestamptz)', 'execute')
 and not has_function_privilege('anon', 'public.career_apply_requeue_refused_own(uuid,uuid,text,integer,timestamptz)', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_requeue_refused_for(uuid,uuid,text,integer,timestamptz,timestamptz)', 'execute')
 and has_function_privilege('service_role', 'public.career_apply_requeue_refused_for(uuid,uuid,text,integer,timestamptz,timestamptz)', 'execute')
 and has_function_privilege('authenticated', 'public.career_apply_requeue_refused_own(uuid,uuid,text,integer,timestamptz)', 'execute'),
 'anon calls neither; a signed-in person only their own; the service its own');
rollback;
