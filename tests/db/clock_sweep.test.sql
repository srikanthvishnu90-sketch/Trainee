-- CLOCK SWEEP (20261031010000_clock_sweep.sql): an application a card approved is bound to that card whatever clock showed
-- it. career_apply_cloud_text_card_of binds an application to its card only if the application was created between the
-- card's showing and its answer. One Confirm (career_apply_card_confirm_as) shows and answers in one transaction at
-- clock_timestamp(), while the applications it queues carry the transaction's start (now(), microseconds earlier); a card
-- pushed by a worker whose clock runs ahead of the database's was shown "after" the applications its answer queued. Both
-- read as approved by no card (the cloud's text route: not_card_approved, never sent). Before the fix the first two checks
-- below fail. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000c1501','clock-a@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000c1501');
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000c1501','career:account','{"epoch":1,"version":1,"paused":false}');
-- A confirmed resume on file (an entry and its event) and its file stored under sha256 'a'x64 (the owner's resume rule).
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000c15b1','00000000-0000-4000-8000-0000000c1501');
insert into agent_flow_state(thread_id,user_id,state) values ('00000000-0000-4000-8000-0000000c15b1','00000000-0000-4000-8000-0000000c1501',
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-ck-1501','text','CK Analyst')))))));
insert into career_events(user_id,kind,subject,detail) values ('00000000-0000-4000-8000-0000000c1501','fact_confirmed','CK Analyst','{"confirmation_event_id":"ev-ck-1501"}');
insert into storage.objects(bucket_id,name) values ('career-resumes', '00000000-0000-4000-8000-0000000c1501/' || repeat('a',64) || '.pdf');
create function pg_temp.prep(job text) returns career_apply_prepared language plpgsql as $$
declare p jsonb; r career_apply_prepared;
begin
 p := jsonb_build_object('version',1,'user_id','00000000-0000-4000-8000-0000000c1501','job_id',job,'company','CK Co '||job,'url','https://jobs.lever.co/ckco/'||job,
  'fields','[]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64));
 insert into career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
  values ('00000000-0000-4000-8000-0000000c1501', job, 'CK Co '||job, 'https://jobs.lever.co/ckco/'||job, p, career_apply_payload_hash(p), array['CK Co '||job]) returning * into r;
 return r;
end $$;
create temp table pr as select g, pg_temp.prep('ck-'||g) as p from generate_series(1,3) g;
create function pg_temp.id(n int) returns uuid language sql as $$ select (p).id from pr where g = n $$;
create function pg_temp.h(n int) returns text language sql as $$ select (p).payload_hash from pr where g = n $$;
create function pg_temp.card_of(job text) returns uuid language sql as $$
 select (public.career_apply_cloud_text_card_of(j)->>'card_id')::uuid from career_apply_jobs j where j.job_id = job $$;

-- 1. One Confirm, through the service's door (clock_timestamp()): the application is bound to the card that approved it.
create temp table c1 as select public.career_apply_card_confirm_as('00000000-0000-4000-8000-0000000c1501', array[pg_temp.id(1)], array[pg_temp.h(1)]) as r;
select t.ok((select r->'results'->0->>'result' = 'queued' from c1), 'one Confirm: queued');
select t.ok(pg_temp.card_of('ck-1') = (select (r->'card'->>'id')::uuid from c1),
 'one Confirm: the application is bound to its card (created at the transaction''s start, the card shown no later)');
select t.ok((select c.shown_at <= j.created_at and j.created_at <= c.answered_at from career_apply_cards c, career_apply_jobs j
  where c.id = (select (r->'card'->>'id')::uuid from c1) and j.job_id = 'ck-1'), 'shown at or before the application, answered at or after it');

-- 2. A card pushed by a worker whose clock is 2 s ahead of the database's, answered at once: bound to it.
create temp table c2 as select * from public.career_apply_card_open_for('00000000-0000-4000-8000-0000000c1501', array[pg_temp.id(2)], clock_timestamp() + interval '2 seconds');
select t.ok((select shown_at <= now() from c2), 'a worker 2 s ahead: the card is shown no later than the database''s now');
select t.ok((public.career_apply_card_answer_as('00000000-0000-4000-8000-0000000c1501', (select id from c2), array[1]))->0->>'result' = 'queued', 'answered: queued');
select t.ok(pg_temp.card_of('ck-2') = (select id from c2), 'a worker 2 s ahead: the application is bound to its card');

-- 3. A caller's earlier time is kept as given (a card shown 11 minutes ago is stale for a yes, as before).
create temp table c3 as select * from public.career_apply_card_open_for('00000000-0000-4000-8000-0000000c1501', array[pg_temp.id(3)], now() - interval '11 minutes');
select t.ok((select shown_at = now() - interval '11 minutes' from c3), 'an earlier time: kept exactly');
do $$ begin
 perform public.career_apply_card_answer_as('00000000-0000-4000-8000-0000000c1501', (select id from c3), array[1]);
 raise exception 'FAIL a yes to a card shown 11 minutes ago was taken';
exception when others then
 if sqlerrm not like '%card_stale%' then raise; end if;
 raise notice 'ok   an earlier time: a yes 11 minutes later is still stale';
end $$;

-- Who may call it: nobody but the owner's own functions (the _as doors).
select t.ok(not has_function_privilege('anon', 'public.career_apply_card_open_for(uuid, uuid[], timestamptz)', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_card_open_for(uuid, uuid[], timestamptz)', 'execute')
 and not has_function_privilege('service_role', 'public.career_apply_card_open_for(uuid, uuid[], timestamptz)', 'execute'), 'open_for: no client');
select t.ok(prosecdef and proconfig::text like '%search_path=public, pg_temp%', 'open_for: definer with a fixed search_path')
 from pg_proc where oid = 'public.career_apply_card_open_for(uuid, uuid[], timestamptz)'::regprocedure;
rollback;
