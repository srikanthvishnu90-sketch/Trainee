-- Claimed, never started: back to the queue, then RESUME (20261029190000_career_apply_unstarted_requeue.sql; owner rule
-- 2026-10-27). A claim the worker lets go before its engine started (the worker stopping, no start inside its lease
-- budget, its host held, its journal line unwritable) goes back to the queue as the same job, its approval and hash
-- untouched, not handed out before its not-before time (now, or the host's hold), and then runs once. A finished drive,
-- one with proof of a run, one past its lease (the sweep's: unknown), the extension's and the email path's are never put
-- back; a card-bound cloud job (the draft card -> cloud bridge) goes back like any other while its approval is live.
-- Fixed instants (now() is the transaction's start); everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000c9c01','unstarted-a@example.test'),('00000000-0000-4000-8000-0000000c9c02','unstarted-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000c9c01'),('00000000-0000-4000-8000-0000000c9c02');
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000c9c01','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-0000000c9c02','career:account','{"epoch":1,"version":1,"paused":false}');
-- Each: a confirmed resume on file (an entry and its event) and its file stored under sha256 'a'x64 (the owner's resume rule).
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000c9cb1','00000000-0000-4000-8000-0000000c9c01'),('00000000-0000-4000-8000-0000000c9cb2','00000000-0000-4000-8000-0000000c9c02');
insert into agent_flow_state(thread_id,user_id,state) select t, u::uuid,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-us-'||right(u,4),'text','US Analyst'))))))
 from (values ('00000000-0000-4000-8000-0000000c9cb1'::uuid,'00000000-0000-4000-8000-0000000c9c01'),('00000000-0000-4000-8000-0000000c9cb2'::uuid,'00000000-0000-4000-8000-0000000c9c02')) v(t,u);
insert into career_events(user_id,kind,subject,detail) values
 ('00000000-0000-4000-8000-0000000c9c01','fact_confirmed','US Analyst','{"confirmation_event_id":"ev-us-9c01"}'),
 ('00000000-0000-4000-8000-0000000c9c02','fact_confirmed','US Analyst','{"confirmation_event_id":"ev-us-9c02"}');
insert into storage.objects(bucket_id,name) select 'career-resumes', u || '/' || repeat('a',64) || '.pdf'
 from (values ('00000000-0000-4000-8000-0000000c9c01'),('00000000-0000-4000-8000-0000000c9c02')) v(u);
create function pg_temp.q(u text, job text, url text) returns uuid language plpgsql as $$
declare p jsonb; h text;
begin
 p := jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','US Co '||job,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64));
 h := career_apply_payload_hash(p);
 return (career_apply_enqueue(p,h,h)).id;
end $$;
create function pg_temp.j(job text) returns career_apply_jobs language sql as $$ select * from career_apply_jobs where job_id = job $$;
create function pg_temp.c(job text, tbl text) returns career_apply_jobs language plpgsql as $$
declare r career_apply_jobs; begin execute format('select * from %I where job_id = $1', tbl) into r using job; return r; end $$;
-- Nothing else is queued in this transaction's view but these (the pool claim is across people).
update career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before the unstarted test' where state = 'queued';
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:1', 'https://jobs.lever.co/usco/1');
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:2', 'https://jobs.lever.co/usco/2');
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:3', 'https://jobs.ashbyhq.com/usother/3');
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:4', 'https://jobs.ashbyhq.com/usother/4');
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:5', 'https://jobs.ashbyhq.com/usother/5');
create temp table approved as select id, job_id, payload, payload_hash, approval_hash from career_apply_jobs where job_id like 'us:%';
delete from career_apply_host_backoff where host in ('jobs.lever.co', 'jobs.ashbyhq.com');

-- 1. The cloud claims all five; the worker is stopped before starting us:1: it goes back, the same job, at once.
create temp table c1 as select * from career_apply_claim_fair(now(), 10, 10);
select t.ok((select count(*) = 5 and bool_and(state = 'driving' and source = 'cloud' and attempts = 1) from c1), 'the cloud claims all five');
create temp table r1 as select career_apply_requeue_unstarted_for((pg_temp.c('us:1','c1')).id, (pg_temp.c('us:1','c1')).lease_token, 'worker_stopping', null, now()) v;
select t.ok((select v->>'state' = 'queued' and (v->>'not_before')::timestamptz = now() and (v->>'wait_seconds')::int = 0 from r1),
 'stopped before it started: the same job is queued again, to be handed out at once');
select t.ok((select state = 'queued' and attempts = 0 and lease_token is null and claimed_at is null and source is null and host_refusals = 0
  and reason = 'waiting: approved, not started yet (the worker stopped before starting it); nothing was sent, and it goes again by itself'
  and evidence->'unstarted'->>'why' = 'worker_stopping' and (evidence->'unstarted'->>'returns')::int = 1
 from pg_temp.j('us:1')), 'it is as before its claim; the reason says it waits, nothing was sent; no host refusal is counted');
select t.ok((select j.payload = a.payload and j.payload_hash = a.payload_hash and j.approval_hash = a.approval_hash and j.id = a.id
 from pg_temp.j('us:1') j join approved a using (job_id)), 'the same job: its approval, payload and payload hash unchanged (no new approval)');
select t.ok((select count(*) = 1 from career_apply_jobs where job_id = 'us:1'), 'one row for the posting');
-- The run that let it go holds nothing any more.
select t.must_fail($$select career_apply_finish((pg_temp.c('us:1','c1')).id, (pg_temp.c('us:1','c1')).lease_token, 'submitted_unconfirmed', '{}')$$,
 'invalid apply claim', 'the old lease cannot finish the job');
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:1','c1')).id, (pg_temp.c('us:1','c1')).lease_token, 'worker_stopping', null, now())$$,
 'invalid apply claim', 'nor put it back twice');
select t.must_fail($$select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:1', 'https://jobs.lever.co/usco/1')$$, 'duplicate_job',
 'approving the waiting posting again adds nothing: it goes at most once');
-- Handed out again, once, under a new lease; then submitted once.
create temp table c2 as select * from career_apply_claim_fair(now(), 10, 10);
select t.ok((select count(*) = 1 and bool_and(job_id = 'us:1' and state = 'driving' and attempts = 1) from c2), 'claimed again, once');
select t.ok((select c2.lease_token is distinct from c1.lease_token from c2 join c1 using (id)), 'under a new lease');
select career_apply_finish((pg_temp.c('us:1','c2')).id, (pg_temp.c('us:1','c2')).lease_token, 'submitted_unconfirmed', '{"reason":"acknowledged"}');
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:1','c2')).id, (pg_temp.c('us:1','c2')).lease_token, 'worker_stopping', null, now())$$,
 'invalid apply transition', 'a submitted application is never put back');

-- 2. Handed back for its host's hold (another instance's refusal): not handed out before the hold ends, by any claim.
create temp table r2 as select career_apply_requeue_unstarted_for((pg_temp.c('us:2','c1')).id, (pg_temp.c('us:2','c1')).lease_token, 'host_held', now() + interval '90 seconds', now()) v;
select t.ok((select (v->>'wait_seconds')::int = 90 from r2) and (select reason like 'waiting: approved, not started yet (the employer''s site asked us to wait); nothing was sent, and it goes again by itself after %UTC' from pg_temp.j('us:2')),
 'held host: queued again, not before the hold (90 s), said with when');
select t.ok((select count(*) = 0 from career_apply_claim_fair(now() + interval '89 seconds', 10, 10)) and (select state = 'queued' from pg_temp.j('us:2')),
 'at 89 s: not handed out (its own not-before time)');
create temp table c3 as select * from career_apply_claim_fair(now() + interval '91 seconds', 10, 10);
select t.ok((select count(*) = 1 and bool_and(job_id = 'us:2') from c3), 'at 91 s: claimed again, once');
-- Its lease budget spent, again and again: each time back, no cap of ours; a hold at most a day ahead.
create temp table r3 as select career_apply_requeue_unstarted_for((pg_temp.c('us:2','c3')).id, (pg_temp.c('us:2','c3')).lease_token, 'not_started_in_lease', now() + interval '5 days', now() + interval '91 seconds') v;
select t.ok((select (v->>'not_before')::timestamptz = now() + interval '91 seconds' + interval '1 day' from r3), 'a hold beyond a day is held a day');
select t.ok((select (evidence->'unstarted'->>'returns')::int = 2 and reason like '%(it could not start in time)%' from pg_temp.j('us:2')), 'put back twice, counted');

-- 3. A drive with proof of a run (a receipt picture of this drive) is never put back: its engine ran.
insert into career_apply_receipt_files(application_id, user_id, kind, sha256, mime, bytes_b64)
 values ((pg_temp.c('us:3','c1')).id, '00000000-0000-4000-8000-0000000c9c01', 'before-click', repeat('b', 64), 'image/png', 'iVBORw0KGgo=');
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:3','c1')).id, (pg_temp.c('us:3','c1')).lease_token, 'worker_stopping', null, now())$$,
 'invalid apply transition', 'a drive with a picture of its run is never put back');
select t.ok((select state = 'driving' from pg_temp.j('us:3')), 'it stays its drive');
-- 4. Only the workers' own reasons; nothing of Trainee's own invents another.
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:5','c1')).id, (pg_temp.c('us:5','c1')).lease_token, 'too_many_today', null, now())$$,
 'invalid unstarted reason', 'no other reason');
select career_apply_finish((pg_temp.c('us:5','c1')).id, (pg_temp.c('us:5','c1')).lease_token, 'needs_user', '{"reason":"captcha"}');
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:5','c1')).id, (pg_temp.c('us:5','c1')).lease_token, 'worker_stopping', null, now())$$,
 'invalid apply transition', 'a verification check handed to the person is never put back');

-- 5. A drive past its 15-minute lease is the sweep's (unknown, never driven again), never put back.
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:4','c1')).id, (pg_temp.c('us:4','c1')).lease_token, 'not_started_in_lease', null, now() + interval '16 minutes')$$,
 'invalid apply transition', 'a drive past its lease is never put back');
select career_apply_sweep(now() + interval '16 minutes');
select t.ok((select state = 'unknown_outcome' from pg_temp.j('us:4')), 'the sweep makes it unknown');
select t.must_fail($$select career_apply_requeue_unstarted_for((pg_temp.c('us:4','c1')).id, (pg_temp.c('us:4','c1')).lease_token, 'worker_stopping', null, now())$$,
 'invalid apply transition', 'an unknown outcome is never put back');
-- 6. The person's own computer: only their own job, driven there.
select pg_temp.q('00000000-0000-4000-8000-0000000c9c01', 'us:6', 'https://jobs.lever.co/usco/6');
select t.as_user('00000000-0000-4000-8000-0000000c9c01');
set role authenticated;
create temp table c6 as select * from career_apply_claim_own(10, 'own_computer');
reset role;
grant select on c6 to authenticated;
select t.ok((select count(*) = 1 and bool_and(source = 'own_computer' and job_id = 'us:6') from c6), 'the person''s computer claims it');
select t.as_user('00000000-0000-4000-8000-0000000c9c02');
set role authenticated;
select t.must_fail($$select career_apply_requeue_unstarted_own((select id from c6), (select lease_token from c6), 'worker_stopping', null)$$, 'invalid apply claim',
 'another person cannot put it back');
select t.must_fail($$select career_apply_requeue_unstarted_for((select id from c6), (select lease_token from c6), 'worker_stopping', null, now())$$, 'permission denied',
 'a signed-in person cannot call the service''s put-back');
reset role;
select t.as_user('00000000-0000-4000-8000-0000000c9c01');
set role authenticated;
create temp table r6 as select career_apply_requeue_unstarted_own((select id from c6), (select lease_token from c6), 'worker_stopping', null) v;
reset role;
select t.ok((select v->>'state' = 'queued' from r6) and (select state = 'queued' and source is null from pg_temp.j('us:6')), 'their own: queued again');
select t.as_user('00000000-0000-4000-8000-0000000c9c01');
set role authenticated;
create temp table c7 as select * from career_apply_claim_own(10, 'own_computer');
reset role;
select t.ok((select count(*) = 1 and bool_and(job_id = 'us:6') from c7), 'and their computer is handed it again, once');

-- 7. The extension and the email path are never put back (only a browser worker's drive).
select career_apply_finish((select id from c7), (select lease_token from c7), 'not_submitted', '{"reason":"TEST"}');
select pg_temp.q('00000000-0000-4000-8000-0000000c9c02', 'us:7', 'https://jobs.lever.co/usco/7');
select t.as_user('00000000-0000-4000-8000-0000000c9c02');
set role authenticated;
create temp table c8 as select * from career_apply_claim_own(10, 'extension');
reset role;
select t.ok((select count(*) = 1 and bool_and(source = 'extension') from c8), 'the extension claims it');
select t.must_fail($$select career_apply_requeue_unstarted_for((select id from c8), (select lease_token from c8), 'worker_stopping', null, now())$$,
 'invalid apply transition', 'the extension''s drive is never put back');

-- 8. The draft card -> cloud bridge (20261024130000): a card-bound cloud job goes back like any other while its card
--    approval is live (its binding unchanged), and the bridge refuses it once that approval has expired (then the worker
--    records it not sent). The same holds for a host's refusal (career_apply_requeue_refused_for).
do $$
declare j career_apply_jobs; a uuid; l uuid; v jsonb; e text;
begin
 if to_regclass('career_message_approval_private.cloud_bound_jobs') is null then raise notice 'ok   (no bridge here: card-bound jobs checked where it is applied)'; return; end if;
 perform pg_temp.q('00000000-0000-4000-8000-0000000c9c02', 'us:8', 'https://jobs.lever.co/usco/8');
 select * into j from career_apply_jobs where job_id = 'us:8';
 insert into career_message_approval_private.test_users(user_id, enabled) values (j.user_id, true) on conflict (user_id) do update set enabled = true;
 insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,used_at) values(j.user_id,j.job_id,j.payload_hash,j.payload,now()) returning id into a;
 insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
  values(a,j.user_id,gen_random_uuid(),0,j.payload_hash,now(),now()+interval '1 hour');
 insert into career_message_approval_private.cloud_bound_jobs(job_row_id,approval_id,user_id,card_id,item_index)
  select j.id,a,j.user_id,card_id,0 from career_message_approval_private.cloud_bound_approvals where approval_id=a;
 -- Its claim, by the cloud's route (the bridge allows a drive only from the cloud).
 l := gen_random_uuid();
 update career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = l, source = 'cloud' where id = j.id;
 v := career_apply_requeue_unstarted_for(j.id, l, 'worker_stopping', null, now());
 select * into j from career_apply_jobs where id = j.id;
 if v->>'state' <> 'queued' or j.state <> 'queued' or j.source is not null or j.payload_hash <> j.approval_hash
  or not exists (select from career_message_approval_private.cloud_bound_jobs where job_row_id = j.id and approval_id = a) then
  raise exception 'FAIL a card-bound cloud job was not put back with its binding: %', to_jsonb(j); end if;
 raise notice 'ok   a card-bound cloud job, never started, goes back with its binding';
 l := gen_random_uuid();
 update career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = l, source = 'cloud' where id = j.id;
 v := career_apply_requeue_refused_for(j.id, l, 'server_busy', null, null, now());
 if v->>'state' <> 'queued' then raise exception 'FAIL a card-bound cloud job refused for load was not put back'; end if;
 raise notice 'ok   a card-bound cloud job refused for load (a 503) goes back too';
 update career_apply_jobs set not_before = null where id = j.id;
 l := gen_random_uuid();
 update career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = l, source = 'cloud' where id = j.id;
 update career_message_approval_private.cloud_bound_approvals set approved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where approval_id = a;
 begin
  perform career_apply_requeue_unstarted_for(j.id, l, 'worker_stopping', null, now());
  raise exception 'FAIL a card-bound job whose approval expired was put back';
 exception when others then e := sqlerrm;
 end;
 if e not like 'cloud immutable boundary%' then raise exception 'FAIL expected the bridge''s refusal, got %', e; end if;
 if (select state from career_apply_jobs where id = j.id) <> 'driving' then raise exception 'FAIL the refused put-back changed the drive'; end if;
 raise notice 'ok   a card-bound job whose approval expired is not put back (the bridge refuses; the worker records it not sent)';
end $$;

-- 9. Permissions: no anonymous caller; the service's put-back is the service's.
select t.ok(not has_function_privilege('anon', 'public.career_apply_requeue_unstarted_for(uuid,uuid,text,timestamptz,timestamptz)', 'execute')
 and not has_function_privilege('anon', 'public.career_apply_requeue_unstarted_own(uuid,uuid,text,timestamptz)', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_requeue_unstarted_for(uuid,uuid,text,timestamptz,timestamptz)', 'execute')
 and has_function_privilege('service_role', 'public.career_apply_requeue_unstarted_for(uuid,uuid,text,timestamptz,timestamptz)', 'execute')
 and has_function_privilege('authenticated', 'public.career_apply_requeue_unstarted_own(uuid,uuid,text,timestamptz)', 'execute'),
 'anon calls neither; a signed-in person only their own; the service its own');
rollback;
