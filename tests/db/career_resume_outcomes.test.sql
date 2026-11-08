-- RELEASE 9 (20261107120000_career_resume_outcomes.sql): every application records the resume version, layout and kinds of
-- change of the exact tailored file it carried, at apply time, and career_apply_outcomes_by_resume reports response,
-- interview and offer rates by version, tailored or not, layout and kind of change; a person reads only their own.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000009a1','outcomes-a@example.test'),('00000000-0000-4000-8000-0000000009a2','outcomes-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000009a1'),('00000000-0000-4000-8000-0000000009a2');
select t.ok((select count(*)=3 from information_schema.columns where table_schema='public' and table_name='career_apply_jobs' and column_name in ('resume_version','resume_layout','resume_change_types')),'the three columns are added');
select t.ok((select count(*)=3 from information_schema.columns where table_schema='public' and table_name='career_apply_jobs' and column_name in ('resume_sha256','tailored','resume_persona')),'WO-028''s tag columns are still there');
select t.ok((select array_agg(tgname::text order by tgname) = array['career_apply_resume_tag','career_apply_resume_version_tag'] from pg_trigger where tgrelid='public.career_apply_jobs'::regclass and tgname like 'career_apply_resume%'),'the version tag fires after the tailored tag (name order)');
select t.ok((select not has_function_privilege('anon','public.career_apply_resume_version_tag()','execute') and not has_function_privilege('authenticated','public.career_apply_resume_version_tag()','execute')),'nobody but the table calls the trigger function');

set role service_role;
-- A's record: version 1 (Trainee layout, reordered and reworded), version 2 (own layout, a bad change kind and a bad layout
-- dropped); B's record names A's file, which must not count for A.
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000009a1','career:resume-versions',jsonb_build_object('next',3,'files',jsonb_build_object(
   repeat('1',64),jsonb_build_object('n',1,'layout','trainee','changes',jsonb_build_array('reword','reorder')),
   repeat('2',64),jsonb_build_object('n',2,'layout','own','changes',jsonb_build_array('drop','invented'))))),
 ('00000000-0000-4000-8000-0000000009a2','career:resume-versions',jsonb_build_object('next',2,'files',jsonb_build_object(
   repeat('3',64),jsonb_build_object('n',1,'layout','sideways','changes','not-a-list'))));
insert into storage.objects(bucket_id,name) values
 ('career-resumes','00000000-0000-4000-8000-0000000009a1/'||repeat('1',64)||'.pdf'),
 ('career-resumes','00000000-0000-4000-8000-0000000009a1/'||repeat('2',64)||'.pdf'),
 ('career-resumes','00000000-0000-4000-8000-0000000009a1/'||repeat('4',64)||'.pdf'),
 ('career-resumes','00000000-0000-4000-8000-0000000009a2/'||repeat('3',64)||'.pdf');
-- What went: O-1, O-2, O-3, O-4, O-5 and O-8 reached the employer (or may have); O-6 and O-7 did not. The rows are written in
-- their finished states, as the queue leaves them (a finished row sends nothing, so the resume guard does not apply).
create temp table o_jobs(job text, who uuid, sha text, tailored boolean, state text);
insert into o_jobs values
 ('O-1','00000000-0000-4000-8000-0000000009a1',repeat('1',64),true,'submitted_unconfirmed'), ('O-2','00000000-0000-4000-8000-0000000009a1',repeat('1',64),true,'submitted_unconfirmed'),
 ('O-3','00000000-0000-4000-8000-0000000009a1',repeat('2',64),true,'submitted_unconfirmed'), ('O-4','00000000-0000-4000-8000-0000000009a1',repeat('9',64),false,'submitted_unconfirmed'),
 ('O-5','00000000-0000-4000-8000-0000000009a1',repeat('9',64),false,'unknown_outcome'), ('O-6','00000000-0000-4000-8000-0000000009a1',repeat('4',64),true,'failed'),
 ('O-7','00000000-0000-4000-8000-0000000009a1',repeat('1',64),false,'failed'), ('O-8','00000000-0000-4000-8000-0000000009a2',repeat('3',64),true,'submitted_unconfirmed');
insert into career_apply_jobs(user_id,job_id,company,url,state,payload,payload_hash,approval_hash)
 select who, job, 'Outcome '||job, 'https://jobs.lever.co/test/'||job, state,
   jsonb_build_object('resume_sha256',sha)||case when tailored then '{"resume_tailored":true}'::jsonb else '{}'::jsonb end, repeat('a',64), repeat('a',64) from o_jobs;
select t.ok((select resume_version='resume-v1' and resume_layout='trainee' and resume_change_types=array['reorder','reword'] from career_apply_jobs where job_id='O-1'),'a tailored application records its file''s version, layout and change kinds');
select t.ok((select resume_version='resume-v2' and resume_layout='own' and resume_change_types=array['drop'] from career_apply_jobs where job_id='O-3'),'a change kind it does not know is dropped, never stored');
select t.ok((select resume_version is null and resume_layout is null and resume_change_types='{}' and not tailored from career_apply_jobs where job_id='O-4'),'an untailored application carries no version');
select t.ok((select tailored and resume_version is null and resume_layout is null from career_apply_jobs where job_id='O-6'),'a tailored file with no record carries no version, never a guess');
select t.ok((select not tailored and resume_version is null from career_apply_jobs where job_id='O-7'),'a recorded file sent without the tailored tag is not counted as that version');
select t.ok((select tailored and resume_version='resume-v1' and resume_layout is null and resume_change_types='{}' from career_apply_jobs where job_id='O-8'),'a malformed layout and change list record nothing');
-- The row keeps what was sent: a later change to the record does not move it.
update career_watch_kv set value=jsonb_set(value,array['files',repeat('1',64),'layout'],'"plain"') where user_id='00000000-0000-4000-8000-0000000009a1' and key='career:resume-versions';
update career_apply_jobs set reason='TEST touched' where job_id='O-1';
select t.ok((select resume_layout='trainee' from career_apply_jobs where job_id='O-1'),'a row not re-approved keeps the layout it was sent with');
update career_watch_kv set value=jsonb_set(value,array['files',repeat('1',64),'layout'],'"trainee"') where user_id='00000000-0000-4000-8000-0000000009a1' and key='career:resume-versions';

-- What came back, filed under each application (a flagged one does not count; a receipt is not a response).
insert into career_mail_events(user_id,application_ref,kind,company,evidence,message_hash,mail_at,flagged)
 select j.user_id,'job:'||j.id,e.kind,j.company,'TEST evidence '||e.kind,md5(j.job_id||e.kind)||md5(e.kind||j.job_id),now(),e.flagged
 from career_apply_jobs j join (values ('O-1','interview',false),('O-1','offer',false),('O-2','rejection',false),('O-3','recruiter_reply',false),
   ('O-4','assessment',true),('O-5','received',false),('O-6','interview',false),('O-8','interview',false)) e(job,kind,flagged) on e.job=j.job_id;
reset role;

create temp table o_rates as select * from career_apply_outcomes_by_resume where user_id='00000000-0000-4000-8000-0000000009a1';
select t.ok((select sent=3 and responses=3 and interviews=1 and offers=1 and response_per_100=100.0 and interview_per_100=33.3 and offer_per_100=33.3 from o_rates where dimension='tailoring' and bucket='tailored'),'tailored: 3 sent, 3 responses, 1 interview, 1 offer');
select t.ok((select sent=2 and responses=0 and interviews=0 and offers=0 and response_per_100=0.0 from o_rates where dimension='tailoring' and bucket='untailored'),'untailored: 2 sent; a flagged assessment and a receipt are not responses');
select t.ok((select sent=2 and responses=2 and interviews=1 and offers=1 and interview_per_100=50.0 from o_rates where dimension='version' and bucket='resume-v1'),'by version: resume-v1 sent twice, one interview');
select t.ok((select sent=1 and responses=1 and interviews=0 from o_rates where dimension='version' and bucket='resume-v2'),'resume-v2 sent once, a reply');
select t.ok((select sent=2 from o_rates where dimension='layout' and bucket='trainee') and (select sent=1 from o_rates where dimension='layout' and bucket='own'),'by layout');
select t.ok((select array_agg(bucket||':'||sent order by bucket) = array['drop:1','reorder:2','reword:2'] from o_rates where dimension='change_type'),'by kind of change: each application counted under each kind it carried');
select t.ok(not exists (select 1 from o_rates where bucket is null),'no group without a name');
select t.ok((select count(*)=0 from o_rates where dimension='version' and bucket not in ('resume-v1','resume-v2')),'an application that never reached an employer counts nowhere');

-- A person reads only their own; nobody signed out reads any.
select t.as_user('00000000-0000-4000-8000-0000000009a2');
set role authenticated;
select t.ok((select count(*)>0 and bool_and(user_id='00000000-0000-4000-8000-0000000009a2') from career_apply_outcomes_by_resume),'a person reads only their own rates');
select t.ok((select sent=1 and interviews=1 from career_apply_outcomes_by_resume where dimension='version' and bucket='resume-v1'),'B''s resume-v1 is B''s own file');
reset role;
select t.as_user('');
set role anon;
select t.must_fail($$select 1 from career_apply_outcomes_by_resume$$,'permission denied','nobody signed out reads the view');
reset role;
rollback;
