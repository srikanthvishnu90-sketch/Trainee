-- 20261108110000 (R9-G2, e2e E09): a resume tailored for ONE posting, kept for it, read for that posting's preparation only,
-- never as the person's kept resume, and linked to the prepared application (its payload hash) that carries it.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000109a1','pr-a@example.test'),('00000000-0000-4000-8000-0000000109a2','pr-b@example.test');
insert into profiles(id) select id from auth.users where email like 'pr-%@example.test';
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}' from auth.users where email like 'pr-%@example.test';
-- A: a confirmed resume on file (an entry and its event) and a kept cloud resume. B: a confirmed resume, nothing kept in the cloud.
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000109b1','00000000-0000-4000-8000-0000000109a1'),('00000000-0000-4000-8000-0000000109b2','00000000-0000-4000-8000-0000000109a2');
insert into agent_flow_state(thread_id,user_id,state) select t, u::uuid,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-'||right(u,4),'text','PR Intern'))))))
 from (values ('00000000-0000-4000-8000-0000000109b1'::uuid,'00000000-0000-4000-8000-0000000109a1'),('00000000-0000-4000-8000-0000000109b2'::uuid,'00000000-0000-4000-8000-0000000109a2')) v(t,u);
insert into career_events(user_id,kind,subject,detail) values
 ('00000000-0000-4000-8000-0000000109a1','fact_confirmed','PR Intern','{"confirmation_event_id":"ev-09a1"}'),
 ('00000000-0000-4000-8000-0000000109a2','fact_confirmed','PR Intern','{"confirmation_event_id":"ev-09a2"}');
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 values ('00000000-0000-4000-8000-0000000109a1',encode(sha256('%PDF-kept'::bytea),'hex'),'Kept.pdf','%PDF-kept'::bytea,1);

set role service_role;
create temp table put as select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801','Resume_Lumen_tailored.pdf',encode('%PDF-tailored-lumen'::bytea,'base64')) h;
reset role;
select t.ok((select h=encode(sha256('%PDF-tailored-lumen'::bytea),'hex') from put),'the tailored PDF is kept for that posting; its sha256 is returned');
set role service_role;
select t.ok((select career_apply_cloud_resume_kept_for('00000000-0000-4000-8000-0000000109a1')->>'filename'='Kept.pdf'),'the kept resume is still the kept one (a newer tailored copy never replaces it)');
select t.ok((select career_apply_cloud_resume_for_posting('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801')->>'filename'='Resume_Lumen_tailored.pdf'),'that posting reads its tailored resume');
select t.ok((select career_apply_cloud_resume_for_posting('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801')->>'posting'='greenhouse:lumen:801'),'and the row names the posting');
select t.ok((select career_apply_cloud_resume_for_posting('00000000-0000-4000-8000-0000000109a1','greenhouse:stripe:301')->>'filename'='Kept.pdf'),'any other posting reads the kept resume');
select t.ok((select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a2','greenhouse:lumen:801','R.pdf',encode('%PDF-b'::bytea,'base64')) is null),'no resume kept in the cloud: nothing is kept for a posting');
select t.must_fail($$select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801','R.pdf',encode('not a pdf'::bytea,'base64'))$$,'invalid posting resume','only a PDF');
select t.must_fail($$select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801','.hidden.pdf',encode('%PDF-x'::bytea,'base64'))$$,'invalid posting resume','no hidden file name');
-- The same bytes as the kept resume stay the kept resume.
select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a1','greenhouse:ramp:202','Same.pdf',encode('%PDF-kept'::bytea,'base64'));
select t.ok((select posting_job_id is null and filename='Kept.pdf' from career_apply_cloud_resumes where sha256=encode(sha256('%PDF-kept'::bytea),'hex')),'the kept file is never turned into a posting''s copy');
reset role;
-- The resume guards accept it as a file the cloud holds for them (unchanged career_resume_stored).
select t.ok(career_resume_stored('00000000-0000-4000-8000-0000000109a1',encode(sha256('%PDF-tailored-lumen'::bytea),'hex')),'the queue''s resume rule accepts the tailored copy as stored for them');
-- The prepared application that carries it links its payload hash.
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 values ('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801','Lumen','https://boards.greenhouse.io/lumen/jobs/801',
  jsonb_build_object('resume_sha256',encode(sha256('%PDF-tailored-lumen'::bytea),'hex')),repeat('d',64),array['Lumen']);
select t.ok((select payload_hash=repeat('d',64) from career_apply_cloud_resumes where posting_job_id='greenhouse:lumen:801'),'the tailored copy is linked to the payload hash that carries it');
select t.must_fail($$update career_apply_cloud_resumes set payload_hash=repeat('e',64) where posting_job_id is null$$,'check','only a posting''s copy carries a payload hash');
-- Another epoch (they asked to forget): the tailored copy is not read.
update career_watch_kv set value=jsonb_set(value,'{epoch}','2') where user_id='00000000-0000-4000-8000-0000000109a1' and key='career:account';
set role service_role;
select t.ok((select career_apply_cloud_resume_for_posting('00000000-0000-4000-8000-0000000109a1','greenhouse:lumen:801') is null),'after a privacy reset neither copy is read');
reset role;
set role authenticated;
select t.must_fail($$select career_apply_posting_resume_put('00000000-0000-4000-8000-0000000109a1','x','R.pdf','JVBERi0=')$$,'permission denied','a person cannot call the service entry');
reset role;
rollback;
