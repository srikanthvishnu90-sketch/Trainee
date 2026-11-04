-- TESTS ONLY / WRITTEN / NOT_RUN. No SQL execution, apply, engine or employer evidence claimed.
-- Outside run.sh discovery. Requires reviewed bridge SQL; since 20261027140000 (D-MS-2) the cloud-only15/day clamp is gone
-- (source reviewed: 7bbd2096); missing prerequisites are setup errors, never baseline regressions.
-- After 20261025140000 (CAPS-1390) the queue's enqueue takes no ceiling from its caller: the tap-time check below
-- is against the person's own pace; the bridge's claim-time 15 is its own text and is exercised unchanged.
-- Caller supplies an explicit local disposable DB connection, card_cloud_tests_authorized=true,
-- card_cloud_disposable_database=<exact name>, and session marker upmore.test.disposable=
-- 'card-cloud-daily-cap'. Baseline schema/bridge must already be installed by separate authorization.
-- Two jobs receive real stored cards/taps BEFORE importing synthetic historical count rows.
-- This models a legacy/backlog queue, so tap's separate15 enqueue limit cannot mask claim's cap.
-- History uses actual enqueue, then explicit synthetic terminal seeding; it is NOT proof of
-- browser submission, employer confirmation, a valid engine result, or historical cloud permission.
-- No private approval/binding rows are fabricated. Source digest and pre-effect fences are separate.
\set ON_ERROR_STOP on
\if :{?card_cloud_tests_authorized}
\else
 \echo 'NOT_RUN: explicit card_cloud_tests_authorized=true required'
 \quit 3
\endif
\if :card_cloud_tests_authorized
\else
 \quit 3
\endif
\if :{?card_cloud_disposable_database}
\else
 \echo 'NOT_RUN: explicit disposable database name required'
 \quit 3
\endif
select coalesce(current_database()=:'card_cloud_disposable_database' and inet_server_addr() is null
 and current_setting('upmore.test.disposable',true)='card-cloud-daily-cap',false) as cap_disposable_ok \gset
\if :cap_disposable_ok
\else
 \echo 'NOT_RUN: named local disposable database/fixture marker mismatch'
 \quit 3
\endif
begin;
reset role;
set local search_path=public,pg_temp;
create function pg_temp.cap_ok(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL cloud cap: %',label; end if;
 raise notice 'ok cloud cap: %',label; end $$;
create function pg_temp.cap_must_fail(sql text,pattern text,label text) returns void language plpgsql as $$
declare message text;begin
 begin execute sql;exception when others then message:=sqlerrm;end;
 perform pg_temp.cap_ok(message is not null and message~pattern,label||coalesce(': '||message,''));
end $$;
select pg_temp.cap_ok(to_regprocedure('public.career_apply_message_cloud_card_show_as(uuid,uuid,jsonb)') is not null
 and to_regprocedure('public.career_apply_message_card_approve_own(uuid,text)') is not null
 and to_regprocedure('public.career_apply_cloud_claim(integer)') is not null,
 'PRECONDITION: reviewed bridge APIs installed');
select pg_temp.cap_ok(not exists(select from public.career_apply_jobs where state='driving')
 and not exists(select from auth.users where id in
 ('00000000-0000-4000-8000-00000000cb01','00000000-0000-4000-8000-00000000cb02')),
 'PRECONDITION: isolated fixture owners absent; no competing active drives');
\ir ../../fixtures/card-cloud-db-20261021/fixture.sql
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000cb01','cloud-cap@example.test'),
 ('00000000-0000-4000-8000-00000000cb02','extension-cap@example.test');
insert into public.profiles(id) values
 ('00000000-0000-4000-8000-00000000cb01'),('00000000-0000-4000-8000-00000000cb02');
insert into public.agent_threads(id,user_id,title) values
 ('00000000-0000-4000-8000-00000000cba1','00000000-0000-4000-8000-00000000cb01','Synthetic daily cap');
insert into public.career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-00000000cb01','career:account','{"epoch":1,"version":1,"paused":false,"daily_limit":25}'),
 ('00000000-0000-4000-8000-00000000cb02','career:account','{"epoch":1,"version":1,"paused":false,"daily_limit":25}');
insert into career_message_approval_private.test_users(user_id) values('00000000-0000-4000-8000-00000000cb01');
insert into public.career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 values('00000000-0000-4000-8000-00000000cb01',encode(sha256(convert_to('%PDF-1.4 SYNTHETIC TEST RESUME','UTF8')),'hex'),
 'synthetic.pdf',convert_to('%PDF-1.4 SYNTHETIC TEST RESUME','UTF8'),1);
-- These exact answered sources reconstruct the prepared P through the worker's current-source contract.
select pg_temp.cc_seed_sources();
create temp table cap_state(k text primary key,v jsonb);
grant all on cap_state to authenticated,service_role;
set role service_role;
insert into cap_state values('optin',public.career_apply_cloud_optin_as(
 '00000000-0000-4000-8000-00000000cb01',true,'Synthetic cloud-only daily cap terms'));
reset role;
-- D-MS-2 (20261027140000, owner 2026-10-27): no cloud-only 15; the opt-in carries the person's own pace (25, set by them).
select pg_temp.cap_ok((select (v->>'daily')::integer=25 from cap_state where k='optin'),
 'new cloud opt-in reports the person''s own pace (25), no cloud-only 15');
-- An EXISTING legacy row: its raw number is not rewritten and no longer decides; the person's current pace does.
update public.career_apply_cloud_optin set daily=7 where user_id='00000000-0000-4000-8000-00000000cb01';
select pg_temp.cap_ok((select daily=7 from public.career_apply_cloud_optin where user_id='00000000-0000-4000-8000-00000000cb01')
 and (public.career_apply_cloud_optin_get('00000000-0000-4000-8000-00000000cb01')->>'daily')::integer=25,
 'a legacy raw opt-in number (7) is kept but the person''s own current pace (25) is what is reported');
insert into public.career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on'),('CAREER_AGENT_SUBMIT','on')
 on conflict(key) do update set value=excluded.value;
-- Claimed history below predates this waiver, so its5-send allowance cannot mask the daily boundary.
insert into public.career_apply_cloud_gate_waivers(user_id,portal,max_sends,created_at,expires_at,note)
 values('00000000-0000-4000-8000-00000000cb01','lever',5,clock_timestamp(),clock_timestamp()+interval'1 hour',
 'Synthetic daily cap gate bypass; not an owner enrollment or real-send authorization');
insert into cap_state values('item-a',pg_temp.cc_full_item('claim-race')),('item-b',pg_temp.cc_full_item('tap-race'));
set role service_role;
insert into cap_state values('card',public.career_apply_message_cloud_card_show_as(
 '00000000-0000-4000-8000-00000000cb01','00000000-0000-4000-8000-00000000cba1',
 jsonb_build_array((select v from cap_state where k='item-a'),(select v from cap_state where k='item-b'))));
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000cb01',true);
set role authenticated;
insert into cap_state values('receipt',public.career_apply_message_card_approve_own(
 (select (v->>'id')::uuid from cap_state where k='card'),(select v->>'hash' from cap_state where k='card')));
reset role;
create temp table cap_bound as select j.id,j.payload,j.payload_hash,b.approval_id
 from public.career_apply_jobs j join career_message_approval_private.cloud_bound_jobs b on b.job_row_id=j.id
 where b.card_id=(select (v->>'id')::uuid from cap_state where k='card');
select pg_temp.cap_ok((select count(*)=2 from cap_bound)
 and (select jsonb_array_length(v->'jobs')=2 from cap_state where k='receipt')
 and not exists(select from cap_bound b where not exists(select from cap_state s
  where s.k in('item-a','item-b') and s.v->'payload'=b.payload and s.v->>'hash'=b.payload_hash)),
 'both pending jobs were queued by actual tap with the exact shown prepared P/Hq');

savepoint disabled_optin_control;
set role service_role;
select public.career_apply_cloud_optin_as('00000000-0000-4000-8000-00000000cb01',false,null);
insert into cap_state select 'disabled-claim',coalesce(jsonb_agg(to_jsonb(j)),'[]')
 from public.career_apply_cloud_claim(6) j;
reset role;
select pg_temp.cap_ok((select v='[]'::jsonb from cap_state where k='disabled-claim')
 and not exists(select from public.career_apply_jobs j join cap_bound b on b.id=j.id
  where j.state<>'queued' or j.attempts<>0 or j.source is not null),
 'disabled opt-in permits zero claims, even with switches ON and live card bindings');
rollback to disabled_optin_control;

-- Count fixture only. Each row uses the real enqueue API, then an explicit synthetic historical
-- outcome is seeded from queued. No approval/binding metadata is invented, and no engine is run.
create function pg_temp.cap_seed_history(u uuid,route text,n integer) returns void language plpgsql as $$
declare i integer;p jsonb;h text;j public.career_apply_jobs;begin
 for i in 1..n loop
  p:=jsonb_build_object('version',1,'user_id',u,'job_id','synthetic-count:'||route||':'||i,
   'company','Synthetic historical '||route||' '||i,'url','https://jobs.lever.co/synthetic/history-'||route||'-'||i,
   'fields','[]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at',clock_timestamp()+interval'1 hour');
  h:=encode(sha256(convert_to(public.career_apply_canonical(p),'UTF8')),'hex');
  j:=public.career_apply_enqueue(p,h,h,25);
  update public.career_apply_jobs set state='submitted_unconfirmed',attempts=1,source=route,
   claimed_at=clock_timestamp()-interval'1 hour',lease_token=gen_random_uuid(),
   evidence='{"synthetic_historical_count_fixture":true,"not_engine_or_employer_proof":true}'
   where id=j.id;
 end loop;
end $$;
select pg_temp.cap_seed_history('00000000-0000-4000-8000-00000000cb01','cloud',14);
select pg_temp.cap_ok((select count(*)=14 from public.career_apply_jobs where
 user_id='00000000-0000-4000-8000-00000000cb01' and source='cloud' and attempts=1
 and state='submitted_unconfirmed' and claimed_at>clock_timestamp()-interval'1 day'),
 'PRECONDITION:14 counted cloud history rows, plus two actually approved unattempted jobs');
-- The person lowers their own pace to 15: exactly the 15th goes, the 16th waits, refused by their own number.
update public.career_watch_kv set value=value||'{"daily_limit":15}'
 where user_id='00000000-0000-4000-8000-00000000cb01' and key='career:account';
set role service_role;
insert into cap_state select 'fifteenth',coalesce(jsonb_agg(to_jsonb(j)),'[]') from public.career_apply_cloud_claim(6) j;
reset role;
select pg_temp.cap_ok((select jsonb_array_length(v)=1 from cap_state where k='fifteenth')
 and (select count(*)=15 from public.career_apply_jobs where user_id='00000000-0000-4000-8000-00000000cb01'
  and source='cloud' and attempts=1 and state in('driving','confirmed','submitted_unconfirmed','needs_user','unknown_outcome')
  and claimed_at>clock_timestamp()-interval'1 day')
 and (select count(*)=1 from public.career_apply_jobs j join cap_bound b on b.id=j.id
  where j.state='driving' and j.source='cloud' and j.attempts=1 and j.lease_token is not null),
 'with their own pace of 15: 14 prior sends allow exactly the 15th cloud claim');
select pg_temp.cap_ok((select count(*)=1 from public.career_apply_jobs j join cap_bound b on b.id=j.id
  where j.state='queued' and j.source is null and j.attempts=0 and j.lease_token is null
  and public.career_apply_cloud_refusal(j,clock_timestamp())='daily_limit'),
 'the 16th is refused by their own pace, by name, and keeps zero attempts/lease');
-- Their pace back at 25: the 16th cloud send of the day goes (no cloud-only 15, D-MS-2).
update public.career_watch_kv set value=value||'{"daily_limit":25}'
 where user_id='00000000-0000-4000-8000-00000000cb01' and key='career:account';
set role service_role;
insert into cap_state select 'sixteenth',coalesce(jsonb_agg(to_jsonb(j)),'[]') from public.career_apply_cloud_claim(6) j;
reset role;
select pg_temp.cap_ok((select jsonb_array_length(v)=1 from cap_state where k='sixteenth')
 and (select count(*)=16 from public.career_apply_jobs where user_id='00000000-0000-4000-8000-00000000cb01'
  and source='cloud' and attempts=1 and claimed_at>clock_timestamp()-interval'1 day'),
 'with their pace at 25, the 16th cloud claim goes: no cloud-only 15');
select pg_temp.cap_ok((select daily=7 from public.career_apply_cloud_optin where user_id='00000000-0000-4000-8000-00000000cb01'),
 'the legacy raw opt-in number remains unchanged');

-- Tap: the number it hands the queue (15) is no ceiling since 20261025140000 (CAPS-1390: Trainee sets no daily number);
-- the one ledger refuses a tap only against the pace the person set themselves. Here their own pace is set to exactly
-- what the ledger counts for them today, so the next tap is theirs to refuse: no job, no permission, card unanswered.
insert into cap_state values('at-limit-card',public.career_apply_message_cloud_card_show_as(
 '00000000-0000-4000-8000-00000000cb01','00000000-0000-4000-8000-00000000cba1',
 jsonb_build_array(pg_temp.cc_full_item('resume-negative'))));
create temp table cap_counts as select (select count(*) from public.career_apply_jobs) jobs,
 (select count(*) from public.career_apply_batch_approvals) approvals,
 (select count(*) from public.career_apply_ledger('00000000-0000-4000-8000-00000000cb01',clock_timestamp()-interval'1 day')) today;
select pg_temp.cap_ok((select today>=1 from cap_counts),'the ledger counts what went today');
update public.career_watch_kv set value=value||jsonb_build_object('daily_limit',(select today from cap_counts))
 where user_id='00000000-0000-4000-8000-00000000cb01' and key='career:account';
set role authenticated;
select pg_temp.cap_must_fail($$select public.career_apply_message_card_approve_own(
 (select (v->>'id')::uuid from cap_state where k='at-limit-card'),(select v->>'hash' from cap_state where k='at-limit-card'))$$,
 'daily_cap','a tap past the pace the person set is refused without partial approval consumption (the tap''s own 15 no longer binds)');
reset role;
update public.career_watch_kv set value=value||'{"daily_limit":25}'
 where user_id='00000000-0000-4000-8000-00000000cb01' and key='career:account';
select pg_temp.cap_ok((select count(*) from public.career_apply_jobs)=(select jobs from cap_counts)
 and (select count(*) from public.career_apply_batch_approvals)=(select approvals from cap_counts)
 and (select approved_at is null from public.career_apply_message_cards
  where id=(select (v->>'id')::uuid from cap_state where k='at-limit-card')),
 'tap-cap refusal rolls back permission/job mint and leaves card unanswered');

-- Extension CONTROL: original account/global25 remains, and its actual start API accepts16.
-- This minimal preexisting extension queue contract is not cloud card or browser/engine proof.
select pg_temp.cap_ok(public.career_apply_daily_limit('00000000-0000-4000-8000-00000000cb02')=25,
 'cloud-only15 cap does not lower extension/global account25');
select pg_temp.cap_seed_history('00000000-0000-4000-8000-00000000cb02','extension',15);
insert into cap_state values('extension-payload',jsonb_build_object('version',1,'source','extension',
 'user_id','00000000-0000-4000-8000-00000000cb02','job_id','synthetic-extension-sixteenth',
 'company','Synthetic extension sixteenth','url','https://jobs.lever.co/synthetic/extension-sixteenth',
 'fields','[]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at',clock_timestamp()+interval'1 hour'));
-- canonical() remains service-only; compute the synthetic card hash before switching to the client role.
insert into cap_state select 'extension-hash',jsonb_build_object('hash',
 encode(sha256(convert_to(public.career_apply_canonical(v),'UTF8')),'hex')) from cap_state where k='extension-payload';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000cb02',true);
set role authenticated;
insert into cap_state select 'extension-receipt',public.career_apply_extension_begin_own(v,
 (select v->>'hash' from cap_state where k='extension-hash')) from cap_state where k='extension-payload';
reset role;
select pg_temp.cap_ok((select v->>'id' is not null from cap_state where k='extension-receipt')
 and (select count(*)=16 from public.career_apply_jobs where user_id='00000000-0000-4000-8000-00000000cb02')
 and (select state='driving' and source='extension' and attempts=1 from public.career_apply_jobs
  where user_id='00000000-0000-4000-8000-00000000cb02' and job_id='synthetic-extension-sixteenth'),
 'extension16th start still succeeds under unchanged global25; no engine or employer invoked');
-- Both switches and all synthetic state are transactional test setup, erased here on future execution.
rollback;
