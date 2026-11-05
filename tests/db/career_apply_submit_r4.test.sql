-- APPLY ROUND 4 (20261105120000_career_apply_submit_r4.sql), in the database alone: the text-card route never sends a posting
-- already sent another way (closed as not sent at the claim, refused at the authorization before Submit), never lets people who
-- wait hold everyone else's places in its claim, and refuses at the authorization when the person no longer has a confirmed
-- resume; the apply VM's last check before the click refuses a closed posting, one already sent another way and a withdrawn
-- yes, on every ask. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
delete from career_cloud_settings where key in ('CAREER_CLOUD_APPLY','CAREER_CLOUD_TEXT_CARDS','CAREER_AGENT_SUBMIT','APPLY_VM','APPLY_VM_USER_IDS');
insert into career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on'),('CAREER_CLOUD_TEXT_CARDS','on'),('CAREER_AGENT_SUBMIT','on'),('APPLY_VM','on'),('APPLY_VM_USER_IDS','*');
delete from career_apply_cloud_pauses;
-- Setup (named): the per-ATS gate open, as after the owner's own confirmed sends.
create or replace function public.career_apply_cloud_open(p_portal text) returns boolean language sql stable as $g$ select coalesce(p_portal in ('greenhouse','lever','ashby'),false) $g$;
create function pg_temp.person(u uuid) returns void language plpgsql as $$ begin
 insert into auth.users(id,email) values (u, u::text||'@example.test'); insert into profiles(id) values (u);
 insert into career_watch_kv(user_id,key,value) values (u,'career:account','{"epoch":1,"version":1,"paused":false}');
 -- a confirmed resume on file (the owner's rule), the file confirmed by its hash
 with t as (insert into agent_threads(user_id,title) values (u,'TEST r4') returning id)
 insert into agent_flow_state(thread_id,user_id,state,updated_at) select id,u,
  '{"career":{"stores":{"profile":{"facts":[{"id":"r","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"ev-r4","text":"TEST Analyst"}]}}}}',now() - interval '30 days' from t;
 insert into career_events(user_id,kind,subject,detail) values (u,'fact_confirmed','TEST Analyst',
  jsonb_build_object('confirmation_event_id','ev-r4','upload',jsonb_build_object('kind','file','ref','TEST','sha256',encode(sha256(convert_to('%PDF-1.4 TEST r4 db','UTF8')),'hex'))));
 perform career_apply_cloud_optin_as(u,true,'TEST terms');
 perform career_apply_cloud_resume_put_for(u,'resume.pdf',encode(convert_to('%PDF-1.4 TEST r4 db','UTF8'),'base64'));
end $$;
create function pg_temp.pl(u uuid, job text, url text) returns jsonb language sql as $$
 select jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','R4 DB Co','url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '6 hours','engine_approval',repeat('e',64),
  'resume_sha256',encode(sha256(convert_to('%PDF-1.4 TEST r4 db','UTF8')),'hex'),'destination',url) $$;
create function pg_temp.card(u uuid, jobs text[]) returns void language plpgsql as $$
declare ids uuid[] := '{}'; j text; p jsonb; r uuid; c career_apply_cards;
begin
 foreach j in array jobs loop
  p := pg_temp.pl(u, j, 'https://jobs.ashbyhq.com/r4db/' || replace(j, ':', '-'));
  insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines) values (u,j,'R4 DB Co',p->>'url',p,career_apply_payload_hash(p),array['x']) returning id into r;
  ids := ids || r;
 end loop;
 c := career_apply_card_open_for(u, ids, now() - interval '1 minute');
 perform career_apply_card_answer_for(u, c.id, array(select generate_series(1, cardinality(ids))), clock_timestamp());
end $$;
create function pg_temp.sources(u uuid) returns text language sql as $$ select career_apply_message_cloud_sources(u)->>'digest' $$;

-- 1. A posting the person sent themselves (the extension) after the yes: closed as not sent at the claim, in words; never claimed.
select pg_temp.person('00000000-0000-4000-8000-0000000d4001');
select pg_temp.card('00000000-0000-4000-8000-0000000d4001', array['ashby:r4db:1','ashby:r4db:2']);
insert into extension_submission_reports(user_id,employer,role,posting_url,posting_key,confirmation_text,tracker_record)
 values ('00000000-0000-4000-8000-0000000d4001','R4 DB Co','TEST','https://jobs.ashbyhq.com/r4db/ashby-r4db-1','ashby:r4db:1','Thanks','{}');
create temp table c1 as select * from career_apply_cloud_dispatch_claim2(10,100,100,null,null);
select t.ok((select count(*)=1 and bool_and(job_id='ashby:r4db:2') from c1),'only the posting not sent another way is claimed');
select t.ok((select state='not_submitted' and reason='not sent: this exact posting was already sent (recorded after you approved this one)'
 and (evidence->>'nothing_sent')::boolean from career_apply_jobs where job_id='ashby:r4db:1'),'the one sent another way is ended as not sent, in words');
-- ... and mid-flight: sent another way between the claim and the Submit, refused at the authorization.
insert into extension_submission_reports(user_id,employer,role,posting_url,posting_key,confirmation_text,tracker_record)
 values ('00000000-0000-4000-8000-0000000d4001','R4 DB Co','TEST','https://jobs.ashbyhq.com/r4db/ashby-r4db-2?utm_source=x','x','Thanks','{}');
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,%L)$$,(select id from c1),(select lease_token from c1),(select payload_hash from c1),
 pg_temp.sources('00000000-0000-4000-8000-0000000d4001')),'duplicate_job','sent another way (the same posting under a tracking link) after the claim: refused before Submit');

-- 2. No confirmed resume any more (the person withdrew it) between the claim and the Submit: refused.
select pg_temp.person('00000000-0000-4000-8000-0000000d4002');
select pg_temp.card('00000000-0000-4000-8000-0000000d4002', array['ashby:r4db:3']);
create temp table c2 as select * from career_apply_cloud_dispatch_claim2(10,100,100,null,null);
select t.ok((select count(*)=1 from c2),'claimed');
select t.ok((career_apply_cloud_authorize_any((select id from c2),(select lease_token from c2),(select payload_hash from c2),pg_temp.sources('00000000-0000-4000-8000-0000000d4002')))->>'authorized'='true','authorized while the resume is confirmed');
delete from career_events where user_id='00000000-0000-4000-8000-0000000d4002' and kind='fact_confirmed';
select t.must_fail(format($$select career_apply_cloud_authorize_any(%L,%L,%L,%L)$$,(select id from c2),(select lease_token from c2),(select payload_hash from c2),
 pg_temp.sources('00000000-0000-4000-8000-0000000d4002')),'resume_gone','no confirmed resume on file: refused before Submit');

-- 3. Places: 25 people at the dispatcher's per-person number and 25 paused people never keep a newcomer waiting.
do $$ declare i int; u uuid; begin
 for i in 1..25 loop
  u := ('00000000-0000-4000-8000-0000000d5' || lpad(i::text, 3, '0'))::uuid; perform pg_temp.person(u);
  perform pg_temp.card(u, array['ashby:r4cap'||i||':1','ashby:r4cap'||i||':2']);
  u := ('00000000-0000-4000-8000-0000000d6' || lpad(i::text, 3, '0'))::uuid; perform pg_temp.person(u);
  perform pg_temp.card(u, array['ashby:r4pau'||i||':1']);
  update career_watch_kv set value = value || '{"paused":true}' where user_id = u and key = 'career:account';
 end loop; end $$;
create temp table c3 as select * from career_apply_cloud_dispatch_claim2(100,1000,1000,1,null);
select t.ok((select count(*)=25 and count(distinct user_id)=25 from c3 where user_id::text like '00000000-0000-4000-8000-0000000d5%'),'each of the 25 gets exactly its one');
select t.ok(not exists(select from c3 where user_id::text like '00000000-0000-4000-8000-0000000d6%'),'no paused person''s application is claimed');
select pg_temp.person('00000000-0000-4000-8000-0000000d7001');
select pg_temp.card('00000000-0000-4000-8000-0000000d7001', array['ashby:r4new:1']);
create temp table c4 as select * from career_apply_cloud_dispatch_claim2(100,1000,1000,1,null);
select t.ok((select count(*)=1 and bool_and(user_id='00000000-0000-4000-8000-0000000d7001') from c4),'the newcomer is claimed behind 50 people who wait');
select t.ok((select count(*)=25 from career_apply_jobs where state='queued' and user_id::text like '00000000-0000-4000-8000-0000000d6%'),'paused people''s applications wait (not ended)');

-- 4. The apply VM before the click.
create function pg_temp.vmjob(u uuid, job text) returns uuid language plpgsql as $$
declare a uuid; url text := 'https://jobs.lever.co/r4vm/' || replace(job, ':', '-'); p jsonb := pg_temp.pl(u, job, url); h text := public.career_apply_payload_hash(p); id uuid;
begin
 insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values (job,'lever','r4vm',job,'R4 DB Co','TEST',url,now(),now());
 insert into career_message_approval_private.test_users(user_id) values (u) on conflict do nothing;
 insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at) values (u,job,h,p,now(),now()) returning career_apply_batch_approvals.id into a;
 insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at) values (a,u,gen_random_uuid(),0,h,now(),now()+interval '23 hours');
 insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash) values (u,job,'R4 DB Co',url,p,h,h) returning career_apply_jobs.id into id;
 return id;
end $$;
select pg_temp.person('00000000-0000-4000-8000-0000000d8001');
select pg_temp.vmjob('00000000-0000-4000-8000-0000000d8001','lever:r4vm:1'), pg_temp.vmjob('00000000-0000-4000-8000-0000000d8001','lever:r4vm:2'),
 pg_temp.vmjob('00000000-0000-4000-8000-0000000d8001','lever:r4vm:3');
-- The VM serves people in turns (the longest waiting first): polled until it has these three, as a worker polls.
create temp table v (job text, id uuid, lease uuid);
do $$ begin for i in 1..120 loop
 insert into v select x->>'job_id', (x->>'id')::uuid, (x->>'lease_token')::uuid from jsonb_array_elements(career_apply_vm_claim('vm-r4', 10, 10, '{}')) x;
 exit when (select count(*) from v) >= 3; end loop; end $$;
select t.ok((select count(*)=3 from v),'the VM claims the three');
create function pg_temp.hb(job text) returns jsonb language sql as $$ select career_apply_vm_heartbeat((select id from v where v.job=$1),(select lease from v where v.job=$1),'vm-r4','submitting') $$;
update career_postings set closed_at=now() where job_id='lever:r4vm:1';
select t.ok(pg_temp.hb('lever:r4vm:1')->>'why'='posting_closed','closed since the claim: no click');
insert into extension_submission_reports(user_id,employer,role,posting_url,posting_key,confirmation_text,tracker_record)
 values ('00000000-0000-4000-8000-0000000d8001','R4 DB Co','TEST','https://jobs.lever.co/r4vm/lever-r4vm-2/apply','lever:r4vm:2','Thanks','{}');
select t.ok(pg_temp.hb('lever:r4vm:2')->>'why'='duplicate_job','sent another way since the claim: no click');
select t.ok((pg_temp.hb('lever:r4vm:3')->>'ok')::boolean,'the third may go');
select t.ok((select vm_phase='submitting' from career_apply_jobs where job_id='lever:r4vm:3'),'its Submit step is recorded');
select career_apply_cloud_optin_as('00000000-0000-4000-8000-0000000d8001', false, 'TEST stop');
select t.ok(pg_temp.hb('lever:r4vm:3')->>'why'='not_opted_in','asked again after the person withdrew their yes: no click');
select t.ok((career_apply_vm_complete((select id from v where job='lever:r4vm:3'),(select lease from v where job='lever:r4vm:3'),'vm-r4','not_submitted','not_opted_in','{}'))->>'state'='unknown_outcome',
 'refused after its recorded Submit step: unknown, never "not sent"');

-- 5. Nobody but the service and the VM role.
select t.ok(not has_function_privilege('anon','public.career_apply_vm_heartbeat(uuid,uuid,text,text)','execute')
 and not has_function_privilege('authenticated','public.career_apply_vm_heartbeat(uuid,uuid,text,text)','execute')
 and has_function_privilege('service_role','public.career_apply_vm_heartbeat(uuid,uuid,text,text)','execute'),'the heartbeat: service and VM only');
select t.ok(not exists(select from pg_proc p where p.oid in ('public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)'::regprocedure,
 'public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)'::regprocedure)
 and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))),
 'the text route''s inner checks: reached only through the dispatcher and the authorization');
rollback;
