-- 20261102140000 as 20261108130000 leaves it, with 20261108110000 applied: storing the person's own resume file forgets their
-- "no_resume" tries and asks for preparation of what waits in their queue, and nothing else (nothing is queued for sending,
-- approved or sent). A posting's tailored copy (career_apply_posting_resume_put) and the payload hash its prepared
-- application links (career_apply_posting_resume_link) restart nothing: no new preparation request per prepared hash.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000113a1','rr-restart@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000113a1');
insert into career_watch_kv(user_id,key,value) values('00000000-0000-4000-8000-0000000113a1','career:account','{"epoch":1,"version":1,"paused":false}');
insert into agent_threads(id,user_id) values('00000000-0000-4000-8000-0000000113b1','00000000-0000-4000-8000-0000000113a1');
insert into agent_flow_state(thread_id,user_id,state) values('00000000-0000-4000-8000-0000000113b1','00000000-0000-4000-8000-0000000113a1',
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-13a1','text','RR Intern')))))));
insert into career_events(user_id,kind,subject,detail) values('00000000-0000-4000-8000-0000000113a1','fact_confirmed','RR Intern','{"confirmation_event_id":"ev-13a1"}');
insert into career_apply_wanted(user_id,posting_key,url,company,title) values
 ('00000000-0000-4000-8000-0000000113a1','lever:rrco:1','https://jobs.lever.co/rrco/1','RR Co','Analyst'),
 ('00000000-0000-4000-8000-0000000113a1','lever:rrco2:2','https://jobs.lever.co/rrco2/2','RR Two','Analyst');
insert into career_apply_prepare_attempts(user_id,posting_job_id,outcome,detail,at) values
 ('00000000-0000-4000-8000-0000000113a1','lever:rrco:1','no_resume','NO_RESUME_FILE',now()-interval '1 hour'),
 ('00000000-0000-4000-8000-0000000113a1','lever:rrco2:2','error','DRIVER_ERROR',now()-interval '1 hour');
create temp table sends0 as select (select count(*) from career_apply_jobs where user_id='00000000-0000-4000-8000-0000000113a1') jobs;

-- 1. Their resume file is stored: the no_resume try is forgotten (the other stays), one preparation is asked for both.
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 values ('00000000-0000-4000-8000-0000000113a1',encode(sha256('%PDF-kept-rr'::bytea),'hex'),'Kept.pdf','%PDF-kept-rr'::bytea,1);
select t.ok((select count(*)=0 from career_apply_prepare_attempts where user_id='00000000-0000-4000-8000-0000000113a1' and outcome='no_resume'),'the no_resume try is forgotten');
select t.ok((select count(*)=1 from career_apply_prepare_attempts where user_id='00000000-0000-4000-8000-0000000113a1' and outcome='error'),'any other try stays');
select t.ok((select count(*)=1 and bool_and(job_ids='{lever:rrco2:2,lever:rrco:1}' and state='queued') from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000000113a1'),
 'one preparation is asked for, for the postings waiting in their queue');
-- That preparation ran; its request is done (a later restart could not fold into it).
update career_apply_prepare_requests set state='done' where user_id='00000000-0000-4000-8000-0000000113a1';

-- 2. A resume tailored for one posting is kept: no new request.
set role service_role;
select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000113a1','lever:rrco:1','Resume_RR_tailored.pdf',encode('%PDF-tailored-rr'::bytea,'base64'));
reset role;
select t.ok((select count(*)=1 from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000000113a1'),'a posting''s tailored copy restarts nothing');

-- 3. Prepared applications carrying it, one after another, each with a new payload hash: the link writes each hash, and
-- no request is made for any of them (no churn per prepared hash).
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select '00000000-0000-4000-8000-0000000113a1','lever:rrco:1','RR Co','https://jobs.lever.co/rrco/1',
  jsonb_build_object('resume_sha256',encode(sha256('%PDF-tailored-rr'::bytea),'hex'),'n',n), repeat(chr(96+n),64), array['RR Co']
 from generate_series(1,5) n;
select t.ok((select payload_hash=repeat('e',64) from career_apply_cloud_resumes where posting_job_id='lever:rrco:1'),'the link wrote the latest prepared hash');
select t.ok((select count(*)=1 from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000000113a1'),'five prepared hashes linked: still the one request');

-- 4. A new resume file of their own: the restart runs again.
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 values ('00000000-0000-4000-8000-0000000113a1',encode(sha256('%PDF-kept-rr-v2'::bytea),'hex'),'Kept-v2.pdf','%PDF-kept-rr-v2'::bytea,1);
select t.ok((select count(*)=2 from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000000113a1'),'their new resume file asks for preparation again');

-- Never queued, approved or sent: no send job, the queue still waiting.
select t.ok((select count(*) from career_apply_jobs where user_id='00000000-0000-4000-8000-0000000113a1')=(select jobs from sends0),'nothing is queued for sending');
select t.ok((select bool_and(state='waiting') from career_apply_wanted where user_id='00000000-0000-4000-8000-0000000113a1'),'the queue still waits: nothing is taken');
rollback;
