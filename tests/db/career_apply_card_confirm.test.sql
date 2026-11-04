-- One Confirm = one card opened and answered in one transaction (20261030010000_career_apply_card_confirm.sql). Opening a card
-- closes the person's other open cards, so an open and an answer in two calls let two approvals at once close each other's
-- card (each answer then 'card_answered', both approving nothing). career_apply_card_confirm_for approves exactly the hash the
-- person was shown, once per posting, and no card it opens can be closed before it is answered. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000c0f01','confirm-a@example.test'),('00000000-0000-4000-8000-0000000c0f02','confirm-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000c0f01'),('00000000-0000-4000-8000-0000000c0f02');
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000c0f01','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-0000000c0f02','career:account','{"epoch":1,"version":1,"paused":false}');
-- A confirmed resume on file (an entry and its event) and its file stored under sha256 'a'x64 (the owner's resume rule).
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000c0fb1','00000000-0000-4000-8000-0000000c0f01');
insert into agent_flow_state(thread_id,user_id,state) values ('00000000-0000-4000-8000-0000000c0fb1','00000000-0000-4000-8000-0000000c0f01',
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-cf-0f01','text','CF Analyst')))))));
insert into career_events(user_id,kind,subject,detail) values ('00000000-0000-4000-8000-0000000c0f01','fact_confirmed','CF Analyst','{"confirmation_event_id":"ev-cf-0f01"}');
insert into storage.objects(bucket_id,name) values ('career-resumes', '00000000-0000-4000-8000-0000000c0f01/' || repeat('a',64) || '.pdf');
create function pg_temp.prep(job text) returns career_apply_prepared language plpgsql as $$
declare p jsonb; r career_apply_prepared;
begin
 p := jsonb_build_object('version',1,'user_id','00000000-0000-4000-8000-0000000c0f01','job_id',job,'company','CF Co '||job,'url','https://jobs.lever.co/cfco/'||job,
  'fields','[]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64));
 insert into career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
  values ('00000000-0000-4000-8000-0000000c0f01', job, 'CF Co '||job, 'https://jobs.lever.co/cfco/'||job, p, career_apply_payload_hash(p), array['CF Co '||job]) returning * into r;
 return r;
end $$;
create temp table pr as select g, pg_temp.prep('cf-'||g) as p from generate_series(1,4) g;
create function pg_temp.id(n int) returns uuid language sql as $$ select (p).id from pr where g = n $$;
create function pg_temp.h(n int) returns text language sql as $$ select (p).payload_hash from pr where g = n $$;
create function pg_temp.try(sql text) returns text language plpgsql as $$ declare r jsonb; begin execute sql into r; return r::text; exception when others then return 'ERR ' || sqlerrm; end $$;

-- The exact hash shown: one card, opened and answered at once, the application queued with exactly that payload.
create temp table c1 as select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[pg_temp.id(1)], array[pg_temp.h(1)], now()) as r;
select t.ok((select r->'results'->0->>'result' = 'queued' from c1), 'the exact hash shown: queued');
select t.ok((select state = 'answered' from career_apply_cards where id = (select (r->'card'->>'id')::uuid from c1)), 'its card is answered in the same call');
select t.ok((select payload_hash = pg_temp.h(1) and state = 'queued' from career_apply_jobs where job_id = 'cf-1'), 'the queue holds exactly the payload shown');
select t.ok((select state = 'approved' from career_apply_prepared where id = pg_temp.id(1)), 'the prepared application is approved');
-- Once per posting: the same Confirm again approves nothing (the prepared one is no longer open to approve) and opens no card.
select t.ok(pg_temp.try(format($q$select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[%L::uuid], array[%L], now())$q$, pg_temp.id(1), pg_temp.h(1))) like 'ERR %invalid card%',
 'the same Confirm twice: refused, nothing more');
select t.ok((select count(*) = 1 from career_apply_jobs where job_id = 'cf-1'), 'one application for the posting, never two');
select t.ok((select count(*) = 1 from career_apply_cards where user_id = '00000000-0000-4000-8000-0000000c0f01'), 'no card was opened by the refused Confirm');
-- A hash that is not the one on file (changed since it was shown, or another row's): card_changed, nothing opened or queued.
select t.ok(pg_temp.try(format($q$select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[%L::uuid], array[%L], now())$q$, pg_temp.id(2), pg_temp.h(3))) like 'ERR %card_changed%',
 'a hash other than the one on file: card_changed');
select t.ok((select state = 'ready' from career_apply_prepared where id = pg_temp.id(2)) and not exists (select from career_apply_jobs where job_id = 'cf-2'), 'nothing shown, nothing queued');
-- Someone else's prepared application is never theirs to confirm.
select t.ok(pg_temp.try(format($q$select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f02', array[%L::uuid], array[%L], now())$q$, pg_temp.id(2), pg_temp.h(2))) like 'ERR %card_changed%',
 'another person''s prepared application: refused');
-- The race this closes: a card opened for row 2 (the first call of the old two-call approval), then a Confirm of row 3 at the same
-- moment. The Confirm's open closes row 2's card, so row 2's answer approves nothing; the Confirm itself cannot be closed that way.
create temp table c2 as select * from public.career_apply_card_open_for('00000000-0000-4000-8000-0000000c0f01', array[pg_temp.id(2)], now());
create temp table c3 as select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[pg_temp.id(3)], array[pg_temp.h(3)], now()) as r;
select t.ok((select r->'results'->0->>'result' = 'queued' from c3), 'a Confirm while another card is open: queued');
select t.ok(pg_temp.try(format($q$select public.career_apply_card_answer_for('00000000-0000-4000-8000-0000000c0f01', %L::uuid, array[1], now())$q$, (select id from c2))) like 'ERR %card_answered%',
 'the two-call approval''s card was closed by the newer one: its answer approves nothing (why one Confirm is one call)');
-- Row 2 is still shown (not lost): its Confirm now approves it.
select t.ok((select (public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[pg_temp.id(2)], array[pg_temp.h(2)], now()))->'results'->0->>'result') = 'queued',
 'the row whose card was closed: its own Confirm approves it');
-- Bad input: no ids, mismatched lengths.
select t.ok(pg_temp.try($q$select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', '{}'::uuid[], '{}'::text[], now())$q$) like 'ERR %invalid card%', 'no items: refused');
select t.ok(pg_temp.try(format($q$select public.career_apply_card_confirm_for('00000000-0000-4000-8000-0000000c0f01', array[%L::uuid], array[%L, %L], now())$q$, pg_temp.id(4), pg_temp.h(4), pg_temp.h(4))) like 'ERR %invalid card%', 'hashes not one per item: refused');
-- Who may call it: the service role through career_apply_card_confirm_as only.
select t.ok(not has_function_privilege('anon', 'public.career_apply_card_confirm_as(uuid, uuid[], text[])', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_card_confirm_as(uuid, uuid[], text[])', 'execute')
 and has_function_privilege('service_role', 'public.career_apply_card_confirm_as(uuid, uuid[], text[])', 'execute'), 'confirm_as: the service role only');
select t.ok(not has_function_privilege('service_role', 'public.career_apply_card_confirm_for(uuid, uuid[], text[], timestamptz)', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_card_confirm_for(uuid, uuid[], text[], timestamptz)', 'execute'), 'confirm_for: the owner''s, no client');
select pg_temp.id(4) as id4, pg_temp.h(4) as h4 \gset
set role service_role;
select (public.career_apply_card_confirm_as('00000000-0000-4000-8000-0000000c0f01', array[:'id4'::uuid], array[:'h4']))->'results'->0->>'result' as r4 \gset
reset role;
select t.ok(:'r4' = 'queued', 'through the service door: queued');
rollback;
