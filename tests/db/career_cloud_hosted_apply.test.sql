-- FEATURE 17 (20261026230017_career_cloud_hosted_apply.sql): the cloud route for text-card approvals, the hosted
-- preparation requests and the bounded card push for postings the person asked for. Every refusal has a case here,
-- including the adversarial ones: a job nobody approved on a card, another person's, a double claim, a forged lease or
-- hash, an expired approval, an erase, a pause, a spent waiver, a site rate, a missing resume, a card-cloud job.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000f171','hosted-a@example.test'),
 ('00000000-0000-4000-8000-00000000f172','hosted-b@example.test'),
 ('00000000-0000-4000-8000-00000000f173','hosted-c@example.test');
insert into profiles(id) select id from auth.users where id::text like '00000000-0000-4000-8000-00000000f17%';
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb from profiles
 where id::text like '00000000-0000-4000-8000-00000000f17%';
delete from career_cloud_settings where key in ('CAREER_CLOUD_APPLY','CAREER_CLOUD_TEXT_CARDS','CAREER_AGENT_SUBMIT','gate_user_ids','owner_user_id');
delete from career_apply_cloud_pauses;
insert into career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on');
-- A and C opted in, B not. A holds an Ashby waiver of 2 sends; C holds none (the gate stays closed: no gate testers).
select career_apply_cloud_optin_as('00000000-0000-4000-8000-00000000f171',true,'TEST terms');
select career_apply_cloud_optin_as('00000000-0000-4000-8000-00000000f173',true,'TEST terms');
insert into career_apply_cloud_gate_waivers(user_id,portal,max_sends,expires_at,note)
 values('00000000-0000-4000-8000-00000000f171','ashby',2,now()+interval '1 day','TEST hosted apply');
-- Each person's resume kept for the cloud, as is.
select t.ok(career_apply_cloud_resume_put_for(id,'resume.pdf',encode(convert_to('%PDF-1.4 TEST resume '||id::text,'UTF8'),'base64'))
 = encode(sha256(convert_to('%PDF-1.4 TEST resume '||id::text,'UTF8')),'hex'),'the kept resume is stored by its hash')
 from profiles where id::text like '00000000-0000-4000-8000-00000000f17%';
select t.ok((career_apply_cloud_resume_kept_for('00000000-0000-4000-8000-00000000f171')->>'filename')='resume.pdf','the kept resume reads back for the account');

create function pg_temp.payload(u text, n int, url text, co text default null, dest text default null) returns jsonb language sql as $$
 select jsonb_build_object('version',1,'user_id',u,'job_id','TEST-HOSTED-'||n,'company',coalesce(co,'Hosted Employer '||n),'url',url,
  'fields',jsonb_build_array(jsonb_build_object('name','_systemfield_email','label','Email','value','a@example.test')),
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 hour','engine_approval',repeat('e',64),
  'resume_sha256',encode(sha256(convert_to('%PDF-1.4 TEST resume '||u,'UTF8')),'hex'),'destination',coalesce(dest,url))
$$;
create function pg_temp.prep(u text, n int, url text, co text default null, dest text default null) returns uuid language plpgsql as $$
declare p jsonb := pg_temp.payload(u,n,url,co,dest); r uuid;
begin
 insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 values(u::uuid,p->>'job_id',p->>'company',url,p,career_apply_payload_hash(p),array[(p->>'company')||': Email: a@example.test'])
 returning id into r;
 return r;
end $$;
-- A card shown a minute ago and answered now (the tap): approve the numbers given.
create function pg_temp.tap(u text, ids uuid[], approve int[]) returns uuid language plpgsql as $$
declare c career_apply_cards;
begin
 c := career_apply_card_open_for(u::uuid, ids, now() - interval '1 minute');
 perform career_apply_card_answer_for(u::uuid, c.id, approve, clock_timestamp());
 return c.id;
end $$;
create function pg_temp.job(u text, n int) returns career_apply_jobs language sql as $$
 select * from career_apply_jobs where user_id=u::uuid and job_id='TEST-HOSTED-'||n $$;
create function pg_temp.why(u text, n int, ppd int default null, psm int default null) returns text language sql as $$
 select career_apply_cloud_text_refusal(pg_temp.job(u,n), clock_timestamp(), 'claim', ppd, psm) $$;

-- A: two postings on one card; 1 approved, 2 declined. Then one approved alone (3).
create temp table c1 as select pg_temp.tap('00000000-0000-4000-8000-00000000f171',
 array[pg_temp.prep('00000000-0000-4000-8000-00000000f171',1,'https://jobs.ashbyhq.com/hosted1/1'),
       pg_temp.prep('00000000-0000-4000-8000-00000000f171',2,'https://jobs.ashbyhq.com/hosted2/2')], '{1}') as card;
select t.ok((select count(*)=1 from career_apply_jobs where user_id='00000000-0000-4000-8000-00000000f171'),'only the approved item was queued');
-- A job queued by a direct enqueue, never on a card (C), with every other condition met.
select (career_apply_enqueue(pg_temp.payload('00000000-0000-4000-8000-00000000f173',4,'https://jobs.ashbyhq.com/hosted4/4'),
 career_apply_payload_hash(pg_temp.payload('00000000-0000-4000-8000-00000000f173',4,'https://jobs.ashbyhq.com/hosted4/4')),
 career_apply_payload_hash(pg_temp.payload('00000000-0000-4000-8000-00000000f173',4,'https://jobs.ashbyhq.com/hosted4/4')),15)).id;

-- The route's own switch is off by default: nothing is claimed, even with the kill switch and the cloud's switch on.
insert into career_cloud_settings(key,value) values('CAREER_AGENT_SUBMIT','on');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1)='cloud_switches_off','route switch off: refused');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10)),'route switch off: the dispatcher claims nothing');
insert into career_cloud_settings(key,value) values('CAREER_CLOUD_TEXT_CARDS','on');
-- F1: the owner's kill switch. With the cloud's and this route's switches on but CAREER_AGENT_SUBMIT absent, nothing is
-- refused for another reason first, nothing is claimed, and nothing can be authorized.
delete from career_cloud_settings where key='CAREER_AGENT_SUBMIT';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1)='cloud_switches_off','kill switch absent: the card-approved job is refused');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10)),'kill switch absent: the dispatcher claims nothing');
select t.ok((select count(*)=0 from career_apply_cloud_text_claim_at(6,clock_timestamp(),'ashby',15,10)),'kill switch absent: the text claim itself claims nothing');
insert into career_cloud_settings(key,value) values('CAREER_AGENT_SUBMIT','off');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1)='cloud_switches_off','kill switch off: refused');
update career_cloud_settings set value='on' where key='CAREER_AGENT_SUBMIT';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f173',4)='not_card_approved','a job no card approved is refused (directly enqueued)');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1) is null,'the card-approved job may go');

-- Nobody but the service.
reset role; set role authenticated;
select t.must_fail($$select * from career_apply_cloud_dispatch_claim2(1,1,1,1,1)$$,'permission denied','a signed-in person cannot dispatch');
select t.must_fail($$select career_apply_cloud_text_authorize(gen_random_uuid(),gen_random_uuid(),'x',null)$$,'permission denied','nor authorize');
select t.must_fail($$select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f171','{x}',5)$$,'permission denied','nor request a preparation');
select t.must_fail($$select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f171',gen_random_uuid(),array[gen_random_uuid()],'x',now())$$,'permission denied','nor push a card');
reset role; set role service_role;
select t.must_fail($$select * from career_apply_cloud_text_claim_at(1,now(),'ashby',1,1)$$,'permission denied','the text claim is reached only through the dispatcher');
select t.must_fail($$select * from career_apply_cloud_dispatch_claim2(1,1,1,0,1)$$,'invalid dispatch limits','a zero per-person number is refused');
select t.must_fail($$select * from career_apply_cloud_dispatch_claim2(1,1,1,1,0)$$,'invalid dispatch limits','a zero per-site number is refused');
reset role;
-- Every function this migration adds: none executable by anon or a signed-in person (directly or through PUBLIC); the
-- inner checks not even by the service, which reaches them only through its doors.
select t.ok((select count(*)=28 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['career_apply_cancel_for','career_apply_card_push_requested_for','career_apply_cloud_authorize_any','career_apply_cloud_card_bound','career_apply_cloud_destination_ok','career_apply_cloud_dispatch_claim2','career_apply_cloud_resume_kept_for','career_apply_cloud_resume_put_for','career_apply_cloud_text_authorize','career_apply_cloud_text_card_of','career_apply_cloud_text_cards_enabled','career_apply_cloud_text_claim_at','career_apply_cloud_text_refusal','career_apply_never_automated','career_apply_pending_for','career_apply_prepare_postings_today','career_apply_prepare_request_claim','career_apply_prepare_request_finish','career_apply_prepare_request_notice','career_apply_prepare_request_posting','career_apply_prepare_request_put','career_apply_prepare_request_questions','career_apply_prepare_request_ready','career_apply_prepare_request_sandbox','career_apply_prepare_request_scope','career_apply_prepare_tell','career_apply_questions_push_requested_for','career_apply_url_host'])),
 'every function the migration adds is accounted for');
select t.ok(not exists(select from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['career_apply_cancel_for','career_apply_card_push_requested_for','career_apply_cloud_authorize_any','career_apply_cloud_card_bound','career_apply_cloud_destination_ok','career_apply_cloud_dispatch_claim2','career_apply_cloud_resume_kept_for','career_apply_cloud_resume_put_for','career_apply_cloud_text_authorize','career_apply_cloud_text_card_of','career_apply_cloud_text_cards_enabled','career_apply_cloud_text_claim_at','career_apply_cloud_text_refusal','career_apply_never_automated','career_apply_pending_for','career_apply_prepare_postings_today','career_apply_prepare_request_claim','career_apply_prepare_request_finish','career_apply_prepare_request_notice','career_apply_prepare_request_posting','career_apply_prepare_request_put','career_apply_prepare_request_questions','career_apply_prepare_request_ready','career_apply_prepare_request_sandbox','career_apply_prepare_request_scope','career_apply_prepare_tell','career_apply_questions_push_requested_for','career_apply_url_host'])
 and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))),'anon and a signed-in person execute none of them');
select t.ok(not exists(select from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname=any(array['career_apply_cloud_text_claim_at','career_apply_cloud_text_authorize','career_apply_cloud_text_refusal','career_apply_cloud_text_card_of',
  'career_apply_prepare_tell','career_apply_never_automated','career_apply_prepare_postings_today','career_apply_cloud_destination_ok'])
 and has_function_privilege('service_role',p.oid,'execute')),'the inner checks are not the service''s to call');
-- The claim: one job, under its lease, with its marker; a second dispatch claims nothing (no double claim).
create temp table d1 as select * from career_apply_cloud_dispatch_claim2(10,10,10,15,10);
select t.ok((select count(*)=1 and bool_and(job_id='TEST-HOSTED-1' and state='driving' and source='cloud' and attempts=1 and lease_token is not null) from d1),
 'the card-approved job is claimed once, by the cloud, under a lease');
select t.ok((select count(*)=1 from career_apply_cloud_text_claims t join d1 on d1.id=t.job_id where t.card_id=(select card from c1) and t.item_n=1 and t.host='jobs.ashbyhq.com'),
 'its marker names the card, the item and the host');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10)),'a second dispatch claims nothing');
select t.ok((select state='queued' and source is null from career_apply_jobs where job_id='TEST-HOSTED-4'),'the never-approved job is left alone');

-- The authorization: forged lease, forged hash, then the real one; a pause makes it stale; the route is named.
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,gen_random_uuid(),%L,%L)$$,(select id from d1),(select payload_hash from d1),
 career_apply_message_cloud_sources('00000000-0000-4000-8000-00000000f171')->>'digest'),'invalid apply claim','a forged lease is refused');
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,%L)$$,(select id from d1),(select lease_token from d1),repeat('0',64),
 career_apply_message_cloud_sources('00000000-0000-4000-8000-00000000f171')->>'digest'),'invalid apply claim','a forged hash is refused');
select t.ok((career_apply_cloud_authorize_any((select id from d1),(select lease_token from d1),(select payload_hash from d1),
 (career_apply_message_cloud_sources('00000000-0000-4000-8000-00000000f171')->>'digest')))->>'route'='text_card','authorized, by the text-card route, with the approved sources'' digest');
create function pg_temp.auth1() returns jsonb language sql as $$ select career_apply_cloud_authorize_any((select id from d1),(select lease_token from d1),(select payload_hash from d1),
 (career_apply_message_cloud_sources('00000000-0000-4000-8000-00000000f171')->>'digest')) $$;
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,null)$$,(select id from d1),(select lease_token from d1),(select payload_hash from d1)),'invalid source digest','no sources digest: refused');
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,%L)$$,(select id from d1),(select lease_token from d1),(select payload_hash from d1),repeat('a',64)),'approved sources changed','sources changed since the worker read them: refused');
update career_cloud_settings set value='off' where key='CAREER_AGENT_SUBMIT';
select t.must_fail($$select pg_temp.auth1()$$,'agent submit is off','the owner''s kill switch stops it at the authorization, in its own words');
update career_cloud_settings set value='on' where key='CAREER_AGENT_SUBMIT';
create temp table mk as select * from career_apply_cloud_text_claims where job_id=(select id from d1);
delete from career_apply_cloud_text_claims where job_id=(select id from d1);
select t.must_fail($$select pg_temp.auth1()$$,'not_approved','a claimed job with no marker is authorized for nothing');
insert into career_apply_cloud_text_claims select * from mk;
update career_apply_cloud_text_claims set item_n=2 where job_id=(select id from d1);
select t.must_fail($$select pg_temp.auth1()$$,'not_approved','a marker naming another item of the card authorizes nothing');
update career_apply_cloud_text_claims set item_n=1 where job_id=(select id from d1);
update career_apply_cloud_text_claims set user_id='00000000-0000-4000-8000-00000000f172' where job_id=(select id from d1);
select t.must_fail($$select pg_temp.auth1()$$,'not_approved','a marker under another person''s name authorizes nothing');
update career_apply_cloud_text_claims set user_id='00000000-0000-4000-8000-00000000f171' where job_id=(select id from d1);
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set claimed_at=claimed_at-interval '16 minutes' where id=(select id from d1);
select t.must_fail($$select pg_temp.auth1()$$,'invalid apply claim','a claim older than its 15-minute lease authorizes nothing');
update career_apply_jobs set claimed_at=claimed_at+interval '16 minutes' where id=(select id from d1);
alter table career_apply_jobs enable trigger user;
select t.ok((pg_temp.auth1())->>'authorized'='true','restored: authorized again');
update career_watch_kv set value=jsonb_set(value,'{paused}','"true"') where user_id='00000000-0000-4000-8000-00000000f171' and key='career:account';
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,null)$$,(select id from d1),(select lease_token from d1),(select payload_hash from d1)),'stale','a paused account stops it before the engine or Submit');
update career_watch_kv set value=jsonb_set(value,'{paused}','"false"') where user_id='00000000-0000-4000-8000-00000000f171' and key='career:account';
-- Kill switch off at the authorization: refused.
update career_cloud_settings set value='off' where key='CAREER_CLOUD_APPLY';
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,null)$$,(select id from d1),(select lease_token from d1),(select payload_hash from d1)),'cloud_switches_off','the kill switch stops it at the authorization');
update career_cloud_settings set value='on' where key='CAREER_CLOUD_APPLY';
select career_apply_cloud_finish((select id from d1),(select lease_token from d1),'submitted_unconfirmed','{"reason":"page said received"}'::jsonb,'submitted',null);
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,null)$$,(select id from d1),(select lease_token from d1),(select payload_hash from d1)),'invalid apply claim','a finished job is authorized for nothing');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1)='not_approved','a job that already went is never claimed again (double send)');
-- Never retried: even put back to queued (a hand edit, a bug elsewhere), a job tried once is never claimed again.
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set state='queued', source=null where job_id='TEST-HOSTED-1';
alter table career_apply_jobs enable trigger user;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',1)='not_approved','a job with one attempt, queued again, is refused');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10) where job_id='TEST-HOSTED-1'),'and the dispatcher does not claim it');
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set state='submitted_unconfirmed', source='cloud' where job_id='TEST-HOSTED-1';
alter table career_apply_jobs enable trigger user;

-- Refusals, each on its own: approval older than 24 hours; a missing resume; a person not opted in; an erase.
create temp table c3 as select pg_temp.tap('00000000-0000-4000-8000-00000000f171',array[pg_temp.prep('00000000-0000-4000-8000-00000000f171',3,'https://jobs.ashbyhq.com/hosted3/3')],'{1}') card;
update career_apply_cards set answered_at=answered_at-interval '25 hours',shown_at=shown_at-interval '25 hours' where id=(select card from c3);
update career_apply_jobs set created_at=created_at-interval '25 hours' where job_id='TEST-HOSTED-3';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='approval_expired','an approval older than 24 hours is refused');
update career_apply_cards set answered_at=answered_at+interval '25 hours',shown_at=shown_at+interval '25 hours' where id=(select card from c3);
update career_apply_jobs set created_at=created_at+interval '25 hours' where job_id='TEST-HOSTED-3';
delete from career_apply_cloud_resumes where user_id='00000000-0000-4000-8000-00000000f171';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='resume_not_in_cloud','no kept resume: refused');
select career_apply_cloud_resume_put_for('00000000-0000-4000-8000-00000000f171','resume.pdf',encode(convert_to('%PDF-1.4 TEST resume 00000000-0000-4000-8000-00000000f171','UTF8'),'base64'));
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3) is null,'with the resume back, it may go');
-- The binding to the card, each condition on its own (the rows changed under the job, then put back).
create temp table k3 as select * from career_apply_cards where id=(select card from c3);
create temp table q3 as select * from career_apply_prepared where job_id='TEST-HOSTED-3';
update career_apply_cards set items=(select jsonb_agg(jsonb_set(it,'{payload_hash}',to_jsonb(repeat('0',64)))) from jsonb_array_elements(items) it) where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','the card item must carry the job''s hash');
update career_apply_cards set items=(select items from k3) where id=(select card from c3);
update career_apply_cards set answer=jsonb_set(answer,'{approve}','[]') where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','its number must be among those approved');
update career_apply_cards set answer=(select answer from k3) where id=(select card from c3);
update career_apply_cards set answer=jsonb_set(answer,'{results}',(select jsonb_agg(jsonb_set(r,'{result}','"declined"')) from jsonb_array_elements(answer->'results') r)) where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','its result must be queued');
update career_apply_cards set answer=(select answer from k3) where id=(select card from c3);
update career_apply_cards set user_id='00000000-0000-4000-8000-00000000f172' where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','the card must be this person''s');
update career_apply_cards set user_id='00000000-0000-4000-8000-00000000f171' where id=(select card from c3);
update career_apply_prepared set user_id='00000000-0000-4000-8000-00000000f172' where id=(select id from q3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','the prepared application must be this person''s');
update career_apply_prepared set user_id='00000000-0000-4000-8000-00000000f171' where id=(select id from q3);
update career_apply_cards set shown_at=shown_at+interval '1 hour', answered_at=answered_at+interval '2 hours' where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='not_card_approved','a job made before the card was shown is not that card''s');
update career_apply_cards set shown_at=(select shown_at from k3), answered_at=(select answered_at from k3) where id=(select card from c3);
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3) is null,'restored: it may go');
-- Per person per day: one already went today, the dispatcher's number is 1.
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3,1)='daily_limit','the per-person number is held');
-- NO LIMITS (owner, 2026-10-27, D-MS-2): with no number given (the default) and no pace of their own, there is no daily
-- number at all: twenty applications already gone today hold nothing back.
set session_replication_role = replica;
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts,source,claimed_at)
 select '00000000-0000-4000-8000-00000000f171','TEST-NOLIMIT-'||g,'No Limit '||g,'https://example.org/nl/'||g,'{}',repeat('a',64),repeat('a',64),'confirmed',1,'own_computer',now()
 from generate_series(1,20) g;
set session_replication_role = origin;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3) is null,'no number given: twenty gone today, this one may still go (no Trainee daily cap)');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3,21)='daily_limit','a number someone chose still holds');
delete from career_apply_jobs where job_id like 'TEST-NOLIMIT-%';
-- Per site per minute: one Ashby claim this minute, the number is 1.
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3,15,1)='site_rate','the per-site number is held');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,1)),'the dispatcher with a per-site 1 claims nothing more there this minute');
-- Portal paused, person paused.
insert into career_apply_cloud_pauses(scope,portal,reason,until,created_at) values('portal','ashby','TEST',now()+interval '1 hour',now());
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='portal_paused','a paused family is refused');
delete from career_apply_cloud_pauses;
insert into career_apply_cloud_pauses(scope,user_id,reason,until,created_at) values('person','00000000-0000-4000-8000-00000000f171','TEST',now()+interval '1 hour',now());
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',3)='person_paused','a paused person is refused');
delete from career_apply_cloud_pauses;
-- The waiver: 2 sends. The second goes; a third is refused because the gate is closed and the waiver spent.
create temp table d2 as select * from career_apply_cloud_dispatch_claim2(10,10,10,15,10);
select t.ok((select count(*)=1 and bool_and(job_id='TEST-HOSTED-3') from d2),'the second waived send is claimed');
create temp table c5 as select pg_temp.tap('00000000-0000-4000-8000-00000000f171',array[pg_temp.prep('00000000-0000-4000-8000-00000000f171',5,'https://jobs.ashbyhq.com/hosted5/5')],'{1}') card;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f171',5)='gate_closed','the waiver is spent: the gate is closed for a third');
-- C has no waiver: gate closed; B is not opted in.
create temp table c6 as select pg_temp.tap('00000000-0000-4000-8000-00000000f173',array[pg_temp.prep('00000000-0000-4000-8000-00000000f173',6,'https://jobs.ashbyhq.com/hosted6/6')],'{1}') card;
create temp table c7 as select pg_temp.tap('00000000-0000-4000-8000-00000000f172',array[pg_temp.prep('00000000-0000-4000-8000-00000000f172',7,'https://jobs.ashbyhq.com/hosted7/7')],'{1}') card;
insert into career_apply_cloud_gate_waivers(user_id,portal,max_sends,expires_at,note) values('00000000-0000-4000-8000-00000000f172','ashby',5,now()+interval '1 day','TEST B');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f173',6)='gate_closed','no waiver, gate closed: refused');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',7)='not_opted_in','not opted in: refused');
-- An erase (the epoch moves): the opt-in and the kept resume go with it; the job is stale.
insert into career_apply_cloud_gate_waivers(user_id,portal,max_sends,expires_at,note) values('00000000-0000-4000-8000-00000000f173','ashby',5,now()+interval '1 day','TEST C');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f173',6) is null,'C with a waiver may go');
-- No employer cooldown (D-MS-3: only the exact posting is a duplicate): another application to Hosted Employer 6 this
-- month, by another way, does not hold this one back. (C's other application, the directly queued one, made out to the
-- same employer for this check, then put back.)
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set company='Hosted Employer 6' where job_id='TEST-HOSTED-4';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f173',6) is null,'another application to the same employer this month: this posting may still go');
update career_apply_jobs set company='Hosted Employer 4' where job_id='TEST-HOSTED-4';
alter table career_apply_jobs enable trigger user;
-- The dispatcher's room: one text job is in flight (A's, claimed above). With a global 1, or 1 per family, C's waits.
select t.ok((select count(*)=1 from career_apply_jobs where source='cloud' and state='driving'),'one in flight');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,1,10,15,10)),'global 1, one in flight: nothing more is claimed');
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,1,15,10)),'1 per family, one Ashby in flight: nothing more is claimed');
update career_watch_kv set value=jsonb_set(value,'{epoch}','2') where user_id='00000000-0000-4000-8000-00000000f173' and key='career:account';
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f173',6)='stale','after an erase the approval is stale');
select t.ok((select count(*)=0 from career_apply_cloud_resumes where user_id='00000000-0000-4000-8000-00000000f173'),'and the kept resume is gone');
-- Not a cloud portal; a form only the person can submit.
update career_watch_kv set value='{"epoch":1,"version":1,"paused":false}' where user_id='00000000-0000-4000-8000-00000000f172' and key='career:account';
select career_apply_cloud_optin_as('00000000-0000-4000-8000-00000000f172',true,'TEST terms');
select career_apply_cloud_resume_put_for('00000000-0000-4000-8000-00000000f172','resume.pdf',encode(convert_to('%PDF-1.4 TEST resume 00000000-0000-4000-8000-00000000f172','UTF8'),'base64'));
create temp table c8 as select pg_temp.tap('00000000-0000-4000-8000-00000000f172',array[pg_temp.prep('00000000-0000-4000-8000-00000000f172',8,'https://jobs.smartrecruiters.com/x/8')],'{1}') card;
create temp table c9 as select pg_temp.tap('00000000-0000-4000-8000-00000000f172',array[pg_temp.prep('00000000-0000-4000-8000-00000000f172',9,'https://jobs.ashbyhq.com/hosted9/9','Person Submits Co','person-submits')],'{1}') card;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',8)='portal_not_cloud','another portal family is never the cloud''s');
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',9)='person_submits','a form only the person can submit is never the cloud''s');
-- The job changed after the tap (payload no longer the prepared one): refused.
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set payload=jsonb_set(payload,'{fields,0,value}','"changed@example.test"') where job_id='TEST-HOSTED-7';
alter table career_apply_jobs enable trigger user;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',7)='not_approved','a payload that no longer hashes to what was approved is refused as such');
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set payload_hash=career_apply_payload_hash(payload),approval_hash=career_apply_payload_hash(payload) where job_id='TEST-HOSTED-7';
alter table career_apply_jobs enable trigger user;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',7)='not_card_approved','a job whose payload is not the card''s is refused, even rehashed');
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set payload=jsonb_set(payload,'{user_id}','"00000000-0000-4000-8000-00000000f171"') where job_id='TEST-HOSTED-7';
update career_apply_jobs set payload_hash=career_apply_payload_hash(payload),approval_hash=career_apply_payload_hash(payload) where job_id='TEST-HOSTED-7';
alter table career_apply_jobs enable trigger user;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',7)='not_approved','a job carrying another person''s application is refused as such');
alter table career_apply_jobs disable trigger user;
update career_apply_jobs set payload=jsonb_set(jsonb_set(payload,'{user_id}','"00000000-0000-4000-8000-00000000f172"'),'{engine_approval}','"not-an-approval"') where job_id='TEST-HOSTED-7';
update career_apply_jobs set payload_hash=career_apply_payload_hash(payload),approval_hash=career_apply_payload_hash(payload) where job_id='TEST-HOSTED-7';
alter table career_apply_jobs enable trigger user;
select t.ok(pg_temp.why('00000000-0000-4000-8000-00000000f172',7)='not_approved','a job without the engine''s approval of the exact application is refused as such');
-- The prepared application changed after the tap (its row no longer the job's): refused, though the card's hash still is.
update career_apply_prepared set payload=jsonb_set(payload,'{company}','"Someone Else"') where job_id='TEST-HOSTED-6';
select t.ok(career_apply_cloud_text_refusal((select j from career_apply_jobs j where job_id='TEST-HOSTED-6'),clock_timestamp(),'claim') in ('not_card_approved'),
 'a prepared row changed after the tap binds nothing');
-- A card-cloud (bridge) job is never taken by this route.
do $$ declare j career_apply_jobs; a uuid; begin
 if to_regclass('career_message_approval_private.cloud_bound_jobs') is null then raise notice 'ok   (no bridge here: card-cloud exclusion checked where it is applied)'; return; end if;
 select * into j from career_apply_jobs where job_id='TEST-HOSTED-5';
 insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,used_at) values(j.user_id,j.job_id,j.payload_hash,j.payload,now()) returning id into a;
 insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
  values(a,j.user_id,gen_random_uuid(),0,j.payload_hash,now(),now()+interval '1 hour');
 insert into career_message_approval_private.cloud_bound_jobs(job_row_id,approval_id,user_id,card_id,item_index)
  select j.id,a,j.user_id,card_id,0 from career_message_approval_private.cloud_bound_approvals where approval_id=a;
 if career_apply_cloud_text_refusal(j,clock_timestamp(),'claim') is distinct from 'card_cloud_route' then raise exception 'FAIL a card-cloud job was not left to its own route'; end if;
 raise notice 'ok   a card-cloud job is left to the bridge''s own route';
end $$;

-- ------------------------------------------------------------------------------------------ preparation requests
insert into career_apply_wanted(user_id,posting_key,url,company,title) values
 ('00000000-0000-4000-8000-00000000f171','ashby:hostedp:1','https://jobs.ashbyhq.com/hostedp/1','P1 Co','Intern'),
 ('00000000-0000-4000-8000-00000000f171','ashby:hostedp:2','https://jobs.ashbyhq.com/hostedp/2','P2 Co','Intern'),
 ('00000000-0000-4000-8000-00000000f172','greenhouse:hostedq:1','https://job-boards.greenhouse.io/hostedq/jobs/1','Q1 Co','Intern');
select t.must_fail($$select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f171','{ashby:not-theirs:9}',5)$$,'nothing_to_prepare','a posting not in the person''s queue is not prepared');
select t.must_fail($$select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f172','{ashby:hostedp:1}',5)$$,'nothing_to_prepare','another person''s queued posting is not theirs to prepare');
create temp table r1 as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f171','{ashby:hostedp:1,ashby:hostedp:2,ashby:not-theirs:9}',5) v;
select t.ok((select (v->>'accepted')::boolean from r1),'accepted');
select t.ok((select job_ids='{ashby:hostedp:1,ashby:hostedp:2}' and hosts='{jobs.ashbyhq.com,jobs.ashbyhq.com}' from career_apply_prepare_requests where id=(select (v->>'id')::uuid from r1)),
 'only their own queued postings, with the employer host');
select t.ok((select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f171','{ashby:hostedp:2,ashby:hostedp:1}',5)->>'id')=(select v->>'id' from r1),
 'a second kick for the same postings is the same request (double tap)');
create temp table r2 as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f172','{greenhouse:hostedq:1}',5) v;
-- Global 1: one claimed; the scope opens only with its lease; per site 1 a minute.
create temp table p1 as select * from career_apply_prepare_request_claim(10,1,5,10);
select t.ok((select count(*)=1 and bool_and(state='running' and lease_token is not null) from p1),'global 1: one request runs');
select t.ok((select count(*)=0 from career_apply_prepare_request_claim(10,1,5,10)),'global 1: no second while it runs');
select t.ok(career_apply_prepare_request_scope((select id from p1),gen_random_uuid()) is null,'the scope needs the lease');
select t.ok((career_apply_prepare_request_scope((select id from p1),(select lease_token from p1))->>'user_id')=(select user_id::text from p1),'with its lease: the person');
select career_apply_prepare_request_finish((select id from p1),(select lease_token from p1),'done','{"ready":1}'::jsonb,null);
select t.must_fail(format($$select career_apply_prepare_request_finish(%L,%L,'done','{}'::jsonb,null)$$,(select id from p1),(select lease_token from p1)),'invalid prepare lease','finished once');
select t.ok(career_apply_prepare_request_scope((select id from p1),(select lease_token from p1)) is null,'a finished request opens nothing');
-- Per person per day 1: the person whose request ran today waits; the other runs.
create temp table r3 as select career_apply_prepare_request_put((select user_id from p1),(select job_ids from p1),1) v;
select t.ok((select not (v->>'accepted')::boolean and v->>'waiting_for'='per_person_day' from r3),'over today''s number: the chat is told it waits');
create temp table p2 as select * from career_apply_prepare_request_claim(10,10,1,10);
select t.ok((select count(*)=1 and bool_and(user_id<>(select user_id from p1)) from p2),'per person per day 1: only the other person''s request runs');
-- A request running past its lease is expired, never run again.
update career_apply_prepare_requests set claimed_at=now()-interval '16 minutes' where id=(select id from p2);
select t.ok((select count(*)>=0 from career_apply_prepare_request_claim(1,10,5,10)),'a claim runs');
select t.ok((select state='expired' from career_apply_prepare_requests where id=(select id from p2)),'a request past its lease is expired, not re-run');

-- ------------------------------------------------------------------------------------------ the bounded push
insert into agent_threads(id,user_id) values('00000000-0000-4000-8000-0000000f17aa','00000000-0000-4000-8000-00000000f171');
insert into channel_contacts(contact,user_id,thread_id,last_inbound_at,created_at) values('tg:417001','00000000-0000-4000-8000-00000000f171','00000000-0000-4000-8000-0000000f17aa',now(),now());
-- They just texted, and the reply went out: the scheduled push holds back for 30 minutes.
insert into career_outbox(user_id,key,kind,text,deliver_at) values('00000000-0000-4000-8000-00000000f171','reply:TEST-HOSTED','reply','1/1 queued',now());
create temp table pp as select pg_temp.prep('00000000-0000-4000-8000-00000000f171',11,'https://jobs.ashbyhq.com/hostedp/1','P1 Co') id;
create temp table qq as select pg_temp.prep('00000000-0000-4000-8000-00000000f171',12,'https://jobs.ashbyhq.com/hostedz/1','Z1 Co') id;
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f171','ashby:hostedp:1','ready',null,(select id from pp),'TEST-HOSTED-11');
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f171','ashby:other:1','ready',null,(select id from qq),'TEST-HOSTED-12');
select t.ok(career_apply_card_push_for('00000000-0000-4000-8000-00000000f171',array[(select id from pp)],'P1 Co: Email: a@example.test',now()) is null,
 'the scheduled push holds back while the conversation is under way');
select t.must_fail(format($$select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f171',%L,array[%L::uuid],'Z1 Co: Email: a@example.test',now())$$,
 (select v->>'id' from r1),(select id from qq)),'not a requested preparation','a prepared row they did not ask for in this request is not pushed this way');
select t.must_fail(format($$select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f172',%L,array[%L::uuid],'P1 Co: Email: a@example.test',now())$$,
 (select v->>'id' from r1),(select id from pp)),'not a requested preparation','another person''s request pushes nothing');
-- Even when that person has their own prepared try on the same posting: a request is its own person's only.
create temp table pb as select pg_temp.prep('00000000-0000-4000-8000-00000000f172',31,'https://jobs.ashbyhq.com/hostedp/1','P9 Co') id;
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f172','ashby:hostedp:1','ready',null,(select id from pb),'TEST-HOSTED-31');
select t.must_fail(format($$select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f172',%L,array[%L::uuid],'P9 Co: Email: a@example.test',now())$$,
 (select v->>'id' from r1),(select id from pb)),'not a requested preparation','another person''s request pushes nothing of theirs, even for the same posting');
select t.must_fail(format($$select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f171',%L,array[%L::uuid],'P1 Co only',now())$$,
 (select v->>'id' from r1),(select id from pp)),'does not carry every line','a text missing a card line is refused');
create temp table pushed as select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f171',(select (v->>'id')::uuid from r1),
 array[(select id from pp)],'P1 Co: Email: a@example.test',now()) card;
select t.ok((select card is not null from pushed),'the card they asked for is shown now, inside the 30 minutes');
select t.ok((select count(*)=1 from career_outbox where user_id='00000000-0000-4000-8000-00000000f171' and kind='card' and card_id=(select card from pushed) and deliver_at<=now()),
 'one outbox row carries it, due now');
select t.ok((select meta->>'requested'='true' and meta->>'card_id'=(select card::text from pushed) from agent_messages where thread_id='00000000-0000-4000-8000-0000000f17aa' order by id desc limit 1),
 'the thread records the card it showed');
select t.ok(public.channel_target('00000000-0000-4000-8000-00000000f171',null)='tg:417001','it goes to their Telegram chat');
-- Opted out: nothing.
update channel_contacts set opted_out=true where contact='tg:417001';
update career_apply_prepared set state='ready' where id=(select id from pp);
select t.ok(career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f171',(select (v->>'id')::uuid from r1),array[(select id from pp)],'P1 Co: Email: a@example.test',now()) is null,
 'after STOP, nothing is pushed');
select t.ok((select stage from career_apply_pending_for('00000000-0000-4000-8000-00000000f171') where posting_key='ashby:hostedp:1')='stopped',
 'and its status says why (they texted STOP), never "on its way"');
-- ------------------------------------------------------------------------------------------ follow-through
update channel_contacts set opted_out=false where contact='tg:417001';
update career_apply_prepared set state='shown' where id=(select id from pp);
select t.ok((select stage from career_apply_pending_for('00000000-0000-4000-8000-00000000f171') where posting_key='ashby:hostedp:1')='on_card',
 'a posting on an open card reads on_card');
-- (Requests made in one transaction share their time, so which one an earlier claim took is the database's choice:
-- the stage must follow whichever it is.)
select t.ok((select stage from career_apply_pending_for('00000000-0000-4000-8000-00000000f171') where posting_key='ashby:hostedp:2')
 = case when exists(select from career_apply_prepare_requests where state='running' and 'ashby:hostedp:2'=any(job_ids)) then 'preparing' else 'waiting_day_limit' end,
 'a posting reads preparing only while its request runs; waiting on today''s number otherwise');
-- Changing their mind: cancel P1 Co. The queue row, the prepared application and its try go; the open card closes; a tap
-- on it then approves nothing; asking again prepares afresh.
create temp table cx as select career_apply_cancel_for('00000000-0000-4000-8000-00000000f171','P1 Co') v;
select t.ok((select (v->>'queued_removed')::int=1 and (v->>'prepared_removed')::int=1 and (v->>'cards_closed')::int=1 from cx),'cancel: queue row, prepared application and its card');
select t.ok(not exists(select from career_apply_wanted where user_id='00000000-0000-4000-8000-00000000f171' and posting_key='ashby:hostedp:1'),'out of the queue');
select t.ok((select state='answered' and answer->>'closed'='cancelled by the person' from career_apply_cards where id=(select card from pushed)),'the card is closed');
select t.must_fail(format($$select career_apply_card_answer_for('00000000-0000-4000-8000-00000000f171',%L,'{1}',clock_timestamp())$$,(select card from pushed)),'card_answered','a tap on the cancelled card approves nothing');
select t.ok(not exists(select from career_apply_prepare_attempts where user_id='00000000-0000-4000-8000-00000000f171' and posting_job_id='ashby:hostedp:1'),'its try is gone, so asking again prepares afresh');
-- An approved application not yet claimed is closed not_submitted; one being sent is left and named; a sent one is named.
create temp table c12 as select pg_temp.tap('00000000-0000-4000-8000-00000000f171',array[pg_temp.prep('00000000-0000-4000-8000-00000000f171',13,'https://jobs.ashbyhq.com/hostedc/13','Cancel Co')],'{1}') card;
create temp table cy as select career_apply_cancel_for('00000000-0000-4000-8000-00000000f171','Cancel Co') v;
select t.ok((select (v->>'approved_cancelled')::int=1 from cy) and (select state='not_submitted' and reason like 'not sent: you cancelled it%' from career_apply_jobs where job_id='TEST-HOSTED-13'),
 'an approved, unclaimed application is not sent');
select t.ok((select (v->>'being_sent')::int=1 from (select career_apply_cancel_for('00000000-0000-4000-8000-00000000f171','Hosted Employer 3') v) x),'one being sent is left as it is and named');
select t.ok((select jsonb_array_length(v->'already_sent')=1 from (select career_apply_cancel_for('00000000-0000-4000-8000-00000000f171','Hosted Employer 1') v) x),'a sent one is named, never undone');
select t.ok((select state='submitted_unconfirmed' from career_apply_jobs where job_id='TEST-HOSTED-1'),'and it is unchanged');
select t.ok((select (v->>'queued_removed')::int=0 and (v->>'prepared_removed')::int=0 from (select career_apply_cancel_for('00000000-0000-4000-8000-00000000f172','P1 Co') v) x),'another person''s cancel touches nothing of theirs');
-- A person on the web chat only: the card goes into their last thread, with no text queued.
insert into auth.users(id,email) values('00000000-0000-4000-8000-00000000f174','hosted-web@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-00000000f174');
insert into career_watch_kv(user_id,key,value) values('00000000-0000-4000-8000-00000000f174','career:account','{"epoch":1,"version":1,"paused":false}');
insert into agent_threads(id,user_id) values('00000000-0000-4000-8000-0000000f17bb','00000000-0000-4000-8000-00000000f174');
insert into agent_messages(thread_id,role,content) values('00000000-0000-4000-8000-0000000f17bb','user','apply me to this');
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f174','ashby:hostedw:1','https://jobs.ashbyhq.com/hostedw/1','W1 Co','Intern');
create temp table rw as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f174','{ashby:hostedw:1}',5) v;
create temp table pw as select pg_temp.prep('00000000-0000-4000-8000-00000000f174',14,'https://jobs.ashbyhq.com/hostedw/1','W1 Co') id;
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f174','ashby:hostedw:1','ready',null,(select id from pw),'TEST-HOSTED-14');
create temp table pushedw as select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f174',(select (v->>'id')::uuid from rw),array[(select id from pw)],'W1 Co: Email: a@example.test',now()) card;
select t.ok((select card is not null from pushedw),'web only: the card is shown');
select t.ok((select meta->>'card_id'=(select card::text from pushedw) from agent_messages where thread_id='00000000-0000-4000-8000-0000000f17bb' order by id desc limit 1),'in the thread they last talked in');
select t.ok(not exists(select from career_outbox where user_id='00000000-0000-4000-8000-00000000f174'),'no text is queued for a person with no texting contact');
-- And they can approve it there: the web chat's Approve button (src/career-apply-card.js) calls career_apply_card_answer_own
-- as the signed-in person, with the card that message names; another person cannot.
grant select on pushedw to authenticated;
select t.as_user('00000000-0000-4000-8000-00000000f172'); set role authenticated;
select t.must_fail($$select career_apply_card_answer_own((select card from pushedw), array[1])$$,'invalid card answer','another person cannot approve the web card');
reset role;
select t.as_user('00000000-0000-4000-8000-00000000f174'); set role authenticated;
select career_apply_card_answer_own((select card from pushedw), array[1]);
reset role;
select t.ok((select state='queued' and approval_hash=payload_hash from career_apply_jobs where user_id='00000000-0000-4000-8000-00000000f174' and job_id='TEST-HOSTED-14'),
 'web only: the card in their thread is approved by its button, and exactly that application is queued');
-- An expired request is told, once: queued for more than a day.
update career_apply_prepare_requests set created_at=now()-interval '25 hours' where id=(select (v->>'id')::uuid from rw);
select count(*) from career_apply_prepare_request_claim(0,10,5,10);
select t.ok((select state='expired' from career_apply_prepare_requests where id=(select (v->>'id')::uuid from rw)),'a request not started in a day is expired');
select t.ok((select content like 'I couldn''t start preparing the application you asked for within a day%Nothing was sent%' from agent_messages where meta->>'notice_key'='status:prepare:'||(select v->>'id' from rw)),'and the person (web only) is told in their thread what happened and what to do');
select count(*) from career_apply_prepare_request_claim(0,10,5,10);
select t.ok((select count(*)=1 from agent_messages where meta->>'notice_key'='status:prepare:'||(select v->>'id' from rw)),'told once');
select t.ok(not exists(select from career_outbox where user_id='00000000-0000-4000-8000-00000000f174'),'and no text is queued for them');
-- A texting person whose request ran past its lease is told on their channel.
create temp table rl as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f171','{ashby:hostedp:2}',50) v;
select count(*) from career_apply_prepare_request_claim(5,50,50,50);
update career_apply_prepare_requests set claimed_at=now()-interval '16 minutes' where id=(select (v->>'id')::uuid from rl);
select count(*) from career_apply_prepare_request_claim(0,50,50,50);
select t.ok((select text like 'Preparing the application you asked for stopped before it finished%' from career_outbox where key='status:prepare:'||(select v->>'id' from rl)),'a request past its lease is told on their channel');
-- A person who texts by SMS: the same card, queued for their phone number.
insert into agent_threads(id,user_id) values('00000000-0000-4000-8000-0000000f17cc','00000000-0000-4000-8000-00000000f173');
insert into channel_contacts(contact,user_id,thread_id,last_inbound_at,created_at) values('+15550171730','00000000-0000-4000-8000-00000000f173','00000000-0000-4000-8000-0000000f17cc',now(),now());
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f173','ashby:hosteds:1','https://jobs.ashbyhq.com/hosteds/1','S1 Co','Intern');
create temp table rs as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f173','{ashby:hosteds:1}',5) v;
create temp table ps as select pg_temp.prep('00000000-0000-4000-8000-00000000f173',15,'https://jobs.ashbyhq.com/hosteds/1','S1 Co') id;
update career_apply_prepared set payload=jsonb_set(payload,'{privacy_epoch}','2') where id=(select id from ps);
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f173','ashby:hosteds:1','ready',null,(select id from ps),'TEST-HOSTED-15');
create temp table pusheds as select career_apply_card_push_requested_for('00000000-0000-4000-8000-00000000f173',(select (v->>'id')::uuid from rs),array[(select id from ps)],'S1 Co: Email: a@example.test',now()) card;
select t.ok((select card is not null from pusheds) and exists(select from career_outbox where user_id='00000000-0000-4000-8000-00000000f173' and card_id=(select card from pusheds)),'SMS: the card is queued for their texts');
select t.ok(public.channel_target('00000000-0000-4000-8000-00000000f173',null)='+15550171730','to their phone number');
-- They change their mind on the SMS one: its only posting leaves, so the request that was to prepare it ends.
create temp table cs as select career_apply_cancel_for('00000000-0000-4000-8000-00000000f173','s1 co') v;
select t.ok((select (v->>'queued_removed')::int=1 from cs)
 and (select state='expired' and outcome->>'reason'='cancelled by the person' from career_apply_prepare_requests where id=(select (v->>'id')::uuid from rs)),
 'cancelling the only posting of a waiting preparation ends it (any case of the name)');
-- Another person's same-named employer is never touched.
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f172','ashby:hosteds:9','https://jobs.ashbyhq.com/hosteds/9','S1 Co','Intern');
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f173','ashby:hosteds:8','https://jobs.ashbyhq.com/hosteds/8','S1 Co','Intern');
select career_apply_cancel_for('00000000-0000-4000-8000-00000000f173','S1 Co');
select t.ok(exists(select from career_apply_wanted where user_id='00000000-0000-4000-8000-00000000f172' and posting_key='ashby:hosteds:9')
 and not exists(select from career_apply_wanted where user_id='00000000-0000-4000-8000-00000000f173' and posting_key='ashby:hosteds:8'),'a cancel leaves another person''s queue as it was');
-- Status before a card: waiting on their answers, with the count; a posting already an application is said by the
-- applications list, not twice.
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f173','ashby:hostedq:1','https://jobs.ashbyhq.com/hostedq/1','Q1 Co','Intern');
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f173','ashby:hostedq:1','asked','2 questions',null,'TEST-HOSTED-Q');
insert into career_apply_questions(user_id,key,kind,label,type,job_ids) values('00000000-0000-4000-8000-00000000f173','label:00000000000f17a1','screen','What is your graduation date?','date','{TEST-HOSTED-Q}'),
 ('00000000-0000-4000-8000-00000000f173','label:00000000000f17a2','consent','WhatsApp consent','radio','{TEST-HOSTED-Q}');
select t.ok((select stage='waiting_on_you' and open_questions=2 from career_apply_pending_for('00000000-0000-4000-8000-00000000f173') where posting_key='ashby:hostedq:1'),'a posting waiting on their answers reads waiting_on_you, 2');
insert into career_apply_wanted(user_id,posting_key,url,company,title) values('00000000-0000-4000-8000-00000000f171','ashby:hostedr:1','https://jobs.ashbyhq.com/hostedr/1','Hosted Employer 1','Intern');
select career_apply_prepare_attempt_for('00000000-0000-4000-8000-00000000f171','ashby:hostedr:1','error','x',null,'TEST-HOSTED-1');
select t.ok(not exists(select from career_apply_pending_for('00000000-0000-4000-8000-00000000f171') where posting_key='ashby:hostedr:1'),'a posting that is already an application is not listed again');
-- A notice is never sent after STOP, and a thread notice is written once per key.
update channel_contacts set opted_out=true where contact='+15550171730';
select t.ok(not career_apply_prepare_tell('00000000-0000-4000-8000-00000000f173','status:prepare:stop-test','x')
 and not exists(select from career_outbox where key='status:prepare:stop-test'),'after STOP, no notice');
select t.ok(career_apply_prepare_tell('00000000-0000-4000-8000-00000000f174','status:prepare:once-test','x'),'a thread notice is written');
select t.ok(not career_apply_prepare_tell('00000000-0000-4000-8000-00000000f174','status:prepare:once-test','x'),'the same notice again is refused');
select t.ok((select count(*)=1 from agent_messages where meta->>'notice_key'='status:prepare:once-test'),'a thread notice is written once');
-- ------------------------------------------------------------------------------------------ preparation numbers count postings
insert into auth.users(id,email) values('00000000-0000-4000-8000-00000000f176','hosted-many@example.test'),('00000000-0000-4000-8000-00000000f177','hosted-site@example.test'),
 ('00000000-0000-4000-8000-00000000f178','hosted-lock@example.test'),('00000000-0000-4000-8000-00000000f179','hosted-lock2@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-00000000f176'),('00000000-0000-4000-8000-00000000f177'),('00000000-0000-4000-8000-00000000f178'),('00000000-0000-4000-8000-00000000f179');
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb from profiles
 where id in ('00000000-0000-4000-8000-00000000f176','00000000-0000-4000-8000-00000000f177');
-- (f178 and f179 are left without an account row: writing one takes the person's lock, and the lock checks below need
-- persons nothing has locked yet.)
-- The probe: one request of 25 postings on one host, with 1 posting a day per person and 1 a minute per site.
insert into career_apply_wanted(user_id,posting_key,url,company,title)
 select '00000000-0000-4000-8000-00000000f176','ashby:many:'||g,'https://jobs.ashbyhq.com/many/'||g,'Many '||g,'Intern' from generate_series(1,25) g;
create temp table rm as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f176',array(select 'ashby:many:'||g from generate_series(1,25) g),1) v;
select t.ok((select (v->>'accepted')::boolean from rm) and (select cardinality(job_ids)=25 and cardinality(hosts)=25 from career_apply_prepare_requests where id=(select (v->>'id')::uuid from rm)),
 'one request of 25 is accepted (nothing started today), each posting with its host');
-- Nothing else may run this minute on that host for this check: earlier requests are done.
update career_apply_prepare_requests set state='done', finished_at=now() where state in ('queued','running') and user_id<>'00000000-0000-4000-8000-00000000f176';
update career_apply_prepare_requests set claimed_at=claimed_at-interval '2 days' where claimed_at is not null;
create temp table pm as select * from career_apply_prepare_request_claim(10,10,1,1);
select t.ok((select count(*)=1 and bool_and(cardinality(job_ids)=1 and cardinality(hosts)=1) from pm),'per person 1 a day: one posting of the 25 starts, not 25');
select t.ok((select count(*)=1 and bool_and(cardinality(job_ids)=24 and outcome->>'waiting_for'='per_person_day') from career_apply_prepare_requests
 where user_id='00000000-0000-4000-8000-00000000f176' and state='queued'),'the other 24 wait in a request of their own, and say why');
select t.ok((select count(*) filter (where stage='preparing')=1 and count(*) filter (where stage='waiting_day_limit')=24 from career_apply_pending_for('00000000-0000-4000-8000-00000000f176')),
 'their status: one being prepared, 24 waiting on today''s number');
select t.ok((select count(*)=0 from career_apply_prepare_request_claim(10,10,1,1)),'and nothing more starts for them today');
-- Changing their mind about one of the 24: it leaves the waiting request; the others keep their hosts in order.
select career_apply_cancel_for('00000000-0000-4000-8000-00000000f176','Many 5');
select t.ok((select cardinality(job_ids)=23 and cardinality(hosts)=23 and not 'ashby:many:5'=any(job_ids) from career_apply_prepare_requests
 where user_id='00000000-0000-4000-8000-00000000f176' and state='queued'),'a cancelled posting leaves the waiting request, the rest as they were');
-- Per site: another person, three postings on the same host, this minute: none start (1 a minute there is used);
-- one on another host starts.
insert into career_apply_wanted(user_id,posting_key,url,company,title) values
 ('00000000-0000-4000-8000-00000000f177','ashby:site:1','https://jobs.ashbyhq.com/site/1','Site 1','Intern'),
 ('00000000-0000-4000-8000-00000000f177','ashby:site:2','https://jobs.ashbyhq.com/site/2','Site 2','Intern'),
 ('00000000-0000-4000-8000-00000000f177','greenhouse:site:3','https://job-boards.greenhouse.io/site/jobs/3','Site 3','Intern');
create temp table rsite as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f177','{ashby:site:1,ashby:site:2,greenhouse:site:3}',10) v;
create temp table psite as select * from career_apply_prepare_request_claim(10,10,10,1);
select t.ok((select count(*)=1 and bool_and(job_ids='{greenhouse:site:3}') from psite),'per site 1 a minute: only the posting on another host starts');
select t.ok((select stage from career_apply_pending_for('00000000-0000-4000-8000-00000000f177') where posting_key='ashby:site:1')='starting',
 'a posting waiting for its site''s minute reads starting (within minutes), not being prepared');
-- Later the site has room but their day's number is used: the waiting request records the new reason, and says it.
select count(*) from career_apply_prepare_request_claim(10,10,1,10);
select t.ok((select stage from career_apply_pending_for('00000000-0000-4000-8000-00000000f177') where posting_key='ashby:site:1')='waiting_day_limit',
 'a request skipped for the person''s day records why, so their status says it');
-- LinkedIn and Indeed are never prepared (nor sent): a queued posting there is not taken.
insert into career_apply_wanted(user_id,posting_key,url,company,title) values
 ('00000000-0000-4000-8000-00000000f177','linkedin:x:1','https://www.linkedin.com/jobs/view/1','LI Co','Intern'),
 ('00000000-0000-4000-8000-00000000f177','indeed:x:1','https://www.indeed.com/viewjob?jk=1','IN Co','Intern'),
 ('00000000-0000-4000-8000-00000000f177','indeed:x:2','https://uk.indeed.co.uk/viewjob?jk=2','IN2 Co','Intern');
select t.must_fail($$select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f177','{linkedin:x:1,indeed:x:1,indeed:x:2}',10)$$,'nothing_to_prepare','LinkedIn and Indeed postings never reach a hosted preparation');
-- The person's lock: a cancel takes both of the person's locks (the claim's and the push's), so nothing is claimed or
-- pushed halfway through it. f178 has touched nothing before this.
create function pg_temp.holds(k bigint) returns boolean language sql as $$
 select exists(select from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted and objsubid=1
  and classid=((k>>32)&4294967295)::bigint::oid and objid=(k&4294967295)::bigint::oid) $$;
select t.ok(not pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f178',0)) and not pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f178',1)),'(f178 holds no lock yet)');
select pg_advisory_xact_lock(hashtextextended('lock-probe',0));
select t.ok(pg_temp.holds(hashtextextended('lock-probe',0)),'(the lock probe sees a lock that is held)');
select career_apply_cancel_for('00000000-0000-4000-8000-00000000f178','Nobody');
select t.ok(pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f178',0)) and pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f178',1)),'a cancel holds the person''s claim and push locks');
-- The text claim takes each candidate person's lock before it reads their job (f179: opted in, a queued job, no card).
insert into career_apply_cloud_optin(user_id,enabled,privacy_epoch) values('00000000-0000-4000-8000-00000000f179',true,1);
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 select '00000000-0000-4000-8000-00000000f179','TEST-HOSTED-79','Lock Co','https://jobs.ashbyhq.com/lock/79',
  pg_temp.payload('00000000-0000-4000-8000-00000000f179',79,'https://jobs.ashbyhq.com/lock/79','Lock Co'),
  career_apply_payload_hash(pg_temp.payload('00000000-0000-4000-8000-00000000f179',79,'https://jobs.ashbyhq.com/lock/79','Lock Co')),
  career_apply_payload_hash(pg_temp.payload('00000000-0000-4000-8000-00000000f179',79,'https://jobs.ashbyhq.com/lock/79','Lock Co'));
select t.ok(not pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f179',0)),'(f179 holds no lock yet)');
-- With the owner's kill switch off the claim touches no one: not even a person's lock is taken.
update career_cloud_settings set value='off' where key='CAREER_AGENT_SUBMIT';
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10)),'kill switch off: nothing claimed');
select t.ok(not pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f179',0)),'kill switch off: no person''s lock taken');
update career_cloud_settings set value='on' where key='CAREER_AGENT_SUBMIT';
select t.ok((select count(*)=0 from career_apply_cloud_dispatch_claim2(10,10,10,15,10) where user_id='00000000-0000-4000-8000-00000000f179'),'a job no card approved is not claimed');
select t.ok(pg_temp.holds(hashtextextended('00000000-0000-4000-8000-00000000f179',0)),'but the claim held the person''s lock while it read the job');

-- NO LIMITS (owner, 2026-10-27; D-MS-2): no number of Trainee's own on the dispatcher, the card, or preparation.
select t.ok((select count(*)>=0 from career_apply_cloud_dispatch_claim2(10,10,10,null,null)),'the dispatcher takes no per-person or per-site number (unset by default)');
select t.ok((select count(*)>=0 from career_apply_cloud_dispatch_claim2(10,10,10,500,600)),'and any number someone chooses (no ceiling of 50)');
select t.must_fail($$select * from career_apply_cloud_dispatch_claim2(1,1,1,0,null)$$,'invalid dispatch limits','a zero per-person number is still refused');
insert into career_apply_cloud_text_claims(job_id,user_id,card_id,item_n,host,claimed_at)
 select id,user_id,gen_random_uuid(),9,'jobs.ashbyhq.com',now() from career_apply_jobs where job_id='TEST-HOSTED-79';
select t.ok((select item_n=9 from career_apply_cloud_text_claims where job_id=(select id from career_apply_jobs where job_id='TEST-HOSTED-79')),
 'a card of any size: its ninth application can be claimed (one yes covers the whole batch)');
delete from career_apply_cloud_text_claims where job_id=(select id from career_apply_jobs where job_id='TEST-HOSTED-79');
select t.must_fail(format($$select career_apply_card_push_requested_for(%L,gen_random_uuid(),array(select gen_random_uuid() from generate_series(1,9)),'x',now())$$,
 '00000000-0000-4000-8000-00000000f177'),'not a requested preparation','nine applications on one asked-for card are not refused for their number');
insert into career_apply_wanted(user_id,posting_key,url,company,title)
 select '00000000-0000-4000-8000-00000000f177','ashby:bulk:'||g,'https://jobs.ashbyhq.com/bulk'||g||'/'||g,'Bulk '||g,'Intern' from generate_series(1,130) g;
create temp table rb as select career_apply_prepare_request_put('00000000-0000-4000-8000-00000000f177',array(select 'ashby:bulk:'||g from generate_series(1,130) g),null) v;
select t.ok((select (v->>'accepted')::boolean and (v->>'postings')::int=130 and jsonb_array_length(v->'requests')=6 from rb),
 'one request for 130 postings, no number given: accepted whole, in 6 parts (never cut at 25 or 100)');
select t.ok((select sum(cardinality(job_ids))=130 and count(*)=6 and max(cardinality(job_ids))=25 from career_apply_prepare_requests
 where id in (select (jsonb_array_elements_text(v->'requests'))::uuid from rb)),'every one of the 130 is in a part; none is dropped');
update career_apply_prepare_requests set state='done', finished_at=now() where state='running';
create temp table pb_all as select * from career_apply_prepare_request_claim(500,10000,null,null);
select t.ok((select count(*)=6 from pb_all where id in (select (jsonb_array_elements_text(v->'requests'))::uuid from rb)),'no per-person or per-site number: all six parts start');
rollback;
