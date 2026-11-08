-- RELEASE 10 (20261108130000_career_resume_template_outcomes.sql): an application sent with a file set in one of the fifteen
-- templates records which (T01..T15), only when the file's layout is 'template'; the view reports rates by template.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000009c1','templates-a@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000009c1');
select t.ok((select count(*)=1 from information_schema.columns where table_schema='public' and table_name='career_apply_jobs' and column_name='resume_template'),'the template column is added');
select t.ok((select pg_get_constraintdef(oid) like '%template%' from pg_constraint where conname='career_apply_jobs_resume_layout_check'),'the layout check admits template (the trigger writes the column; nothing else can)');
set role service_role;
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-0000000009c1','career:resume-versions',jsonb_build_object('next',5,'files',jsonb_build_object(
   repeat('5',64),jsonb_build_object('n',1,'layout','template','template','T05','changes',jsonb_build_array('reorder')),
   repeat('6',64),jsonb_build_object('n',2,'layout','template','template','T16','changes',jsonb_build_array()),
   repeat('7',64),jsonb_build_object('n',3,'layout','trainee','template','T03','changes',jsonb_build_array()),
   repeat('8',64),jsonb_build_object('n',4,'layout','template','template','T12','changes',jsonb_build_array()))));
insert into storage.objects(bucket_id,name) select 'career-resumes','00000000-0000-4000-8000-0000000009c1/'||repeat(d,64)||'.pdf' from unnest(array['5','6','7','8']) d;
insert into career_apply_jobs(user_id,job_id,company,url,state,payload,payload_hash,approval_hash)
 select '00000000-0000-4000-8000-0000000009c1', job, 'Template '||job, 'https://jobs.lever.co/test/'||job, 'submitted_unconfirmed',
   jsonb_build_object('resume_sha256',repeat(d,64),'resume_tailored',true), repeat('a',64), repeat('a',64)
 from (values ('T-1','5'),('T-2','5'),('T-3','6'),('T-4','7'),('T-5','8')) v(job,d);
select t.ok((select resume_layout='template' and resume_template='T05' and resume_version='resume-v1' from career_apply_jobs where job_id='T-1'),'a template file records its layout and its template');
select t.ok((select resume_layout='template' and resume_template is null from career_apply_jobs where job_id='T-3'),'a template id outside T01..T15 records nothing, never a guess');
select t.ok((select resume_layout='trainee' and resume_template is null from career_apply_jobs where job_id='T-4'),'a file not set in a template records no template');
insert into career_mail_events(user_id,application_ref,kind,company,evidence,message_hash,mail_at,flagged)
 select j.user_id,'job:'||j.id,'interview',j.company,'TEST evidence',md5(j.job_id)||md5(j.job_id||'x'),now(),false from career_apply_jobs j where j.job_id in ('T-1','T-5');
reset role;
create temp table t_rates as select * from career_apply_outcomes_by_resume where user_id='00000000-0000-4000-8000-0000000009c1';
select t.ok((select array_agg(bucket||':'||sent||':'||interviews order by bucket) = array['T05:2:1','T12:1:1'] from t_rates where dimension='template'),'by template: T05 sent twice with one interview, T12 once with one');
select t.ok((select sent=4 from t_rates where dimension='layout' and bucket='template'),'by layout: four template files');
rollback;
