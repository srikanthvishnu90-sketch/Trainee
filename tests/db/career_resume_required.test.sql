-- FEATURE 16 (20261026210016_career_resume_required.sql): OWNER RULE 2026-10-26, "never submit applications without a
-- real resume". An application is queued, claimed, prepared or carded only when its person has a confirmed resume on file
-- (entries with their fact_confirmed events) and the payload's resume_sha256 is a resume stored for them (a tailored
-- render, a cloud resume, or a file they sent); a bare 64-hex value is not a resume. A row queued before the rule is
-- closed as not sent; the card's answer names the reason; a resume file's upload is erased with the account.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000001601','rr-a@example.test'),('00000000-0000-4000-8000-000000001602','rr-b@example.test'),
 ('00000000-0000-4000-8000-000000001603','rr-c@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-000000001601'),('00000000-0000-4000-8000-000000001602'),('00000000-0000-4000-8000-000000001603');
insert into career_watch_kv(user_id,key,value) values
 ('00000000-0000-4000-8000-000000001601','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-000000001602','career:account','{"epoch":1,"version":1,"paused":false}'),
 ('00000000-0000-4000-8000-000000001603','career:account','{"epoch":1,"version":1,"paused":false}');
-- 1601 and 1602: a confirmed resume on file (an entry and its event) and a tailored render stored under sha256 'a'x64.
-- 1603: the same render stored, but no confirmed resume.
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000016b1','00000000-0000-4000-8000-000000001601'),('00000000-0000-4000-8000-0000000016b2','00000000-0000-4000-8000-000000001602');
insert into agent_flow_state(thread_id,user_id,state) select t, u::uuid,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-'||right(u,4),'text','RR Intern'))))))
 from (values ('00000000-0000-4000-8000-0000000016b1'::uuid,'00000000-0000-4000-8000-000000001601'),('00000000-0000-4000-8000-0000000016b2'::uuid,'00000000-0000-4000-8000-000000001602')) v(t,u);
insert into career_events(user_id,kind,subject,detail) values
 ('00000000-0000-4000-8000-000000001601','fact_confirmed','RR Intern','{"confirmation_event_id":"ev-1601"}'),
 ('00000000-0000-4000-8000-000000001602','fact_confirmed','RR Intern','{"confirmation_event_id":"ev-1602"}');
insert into storage.objects(bucket_id,name) select 'career-resumes', u || '/' || repeat('a',64) || '.pdf'
 from (values ('00000000-0000-4000-8000-000000001601'),('00000000-0000-4000-8000-000000001602'),('00000000-0000-4000-8000-000000001603')) v(u);
create temp table rr_p as select u, jsonb_build_object('version',1,'user_id',u,'job_id','TEST-RR-'||right(u,1)||'-'||k,'company','RR Employer '||right(u,1)||k,
   'url','https://jobs.lever.co/test/rr'||k,'fields','[]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 hour')
   || case k when 'with' then jsonb_build_object('resume_sha256',repeat('a',64)) when 'fake' then jsonb_build_object('resume_sha256',repeat('e',64)) else '{}'::jsonb end as p, k
 from (values ('00000000-0000-4000-8000-000000001601'), ('00000000-0000-4000-8000-000000001602'), ('00000000-0000-4000-8000-000000001603')) v(u),
  (values ('with'), ('none'), ('fake')) w(k);
grant select on rr_p to service_role, authenticated;
select t.ok((select career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('a',64)) and not career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('e',64))),
 'a resume is stored only under the sha256 of a file that exists for the person');

-- 1. approve-to-queue
set role service_role;
select t.must_fail($$select career_apply_enqueue(p, career_apply_payload_hash(p), career_apply_payload_hash(p), 15) from rr_p where k = 'none' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'a payload with no resume hash is refused at approve-to-queue');
select t.must_fail($$select career_apply_enqueue(p, career_apply_payload_hash(p), career_apply_payload_hash(p), 15) from rr_p where k = 'fake' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'a well-formed sha256 of no stored resume is refused');
select t.must_fail($$select career_apply_enqueue(p, career_apply_payload_hash(p), career_apply_payload_hash(p), 15) from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001603'$$,
 'no_resume', 'a stored resume with no confirmed resume on file is refused');
select t.ok((select (career_apply_enqueue(p, career_apply_payload_hash(p), career_apply_payload_hash(p), 15)).state = 'queued' from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001601'),
 'a confirmed resume on file and its stored render: queued');
select t.must_fail($$select career_apply_enqueue(jsonb_set(p, '{resume_sha256}', '"not-a-hash"'), career_apply_payload_hash(jsonb_set(p, '{resume_sha256}', '"not-a-hash"')), career_apply_payload_hash(jsonb_set(p, '{resume_sha256}', '"not-a-hash"')), 15) from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001602'$$,
 'no_resume', 'a malformed resume hash is no resume');
reset role;

-- 2. the claim: rows written past the approve guard (as a restore could) are never handed to a drive unless they pass.
set session_replication_role = replica;
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 select u::uuid, p->>'job_id', p->>'company', p->>'url', p, career_apply_payload_hash(p), career_apply_payload_hash(p) from rr_p where k in ('none', 'fake') and u = '00000000-0000-4000-8000-000000001602';
set session_replication_role = origin;
select t.as_user('00000000-0000-4000-8000-000000001602');set role authenticated;
create temp table rr_claim as select * from career_apply_claim_own(6, 'own_computer');
reset role;
select t.ok((select count(*) = 0 from rr_claim), 'the person''s computer is handed no application without its stored resume');
select t.ok((select bool_and(state = 'queued' and attempts = 0) from career_apply_jobs where job_id in ('TEST-RR-2-none', 'TEST-RR-2-fake')), 'neither was driven');
select t.as_user('00000000-0000-4000-8000-000000001601');set role authenticated;
create temp table rr_claim_a as select * from career_apply_claim_own(6, 'own_computer');
reset role;
select t.ok((select count(*) = 1 and bool_and(job_id = 'TEST-RR-1-with') from rr_claim_a), 'the application with its resume is claimed as before');
select t.ok((select count(*) = 0 from career_apply_claim(now(), 6) x where x.user_id = '00000000-0000-4000-8000-000000001602'), 'the queue claim hands them to no one either');
select t.ok((select bool_and(state = 'queued' and attempts = 0) from career_apply_jobs where job_id in ('TEST-RR-2-none', 'TEST-RR-2-fake')), 'still never driven');
-- Applied again (idempotent), the migration closes the stranded rows as not sent.
\getenv upmore_root UPMORE_ROOT
\i :upmore_root/supabase/migrations/20261026210016_career_resume_required.sql
select t.ok((select bool_and(state = 'not_submitted' and reason like 'not sent: no resume%') from career_apply_jobs where job_id in ('TEST-RR-2-none', 'TEST-RR-2-fake')),
 'rows queued before the rule without a stored resume are closed as not sent');

-- 2b. any other way into a sending state (review of #194, 2026-10-27): the emailed application is reserved straight into
-- driving, and one Gmail refused is tried again (not_submitted -> driving). Both carry the same rule.
create temp table rr_mail as select u, jsonb_build_object('kind','email','version',1,'user_id',u,'job_id','TEST-RR-MAIL-'||right(u,1),'company','RR Mail Employer '||right(u,1),
   'title','Analyst','url','https://example.test/rr-mail','to','jobs@example.test','subject','Application','body','Hello',
   'attachment',jsonb_build_object('filename','resume.pdf','sha256',repeat('a',64),'size',100,'tailored',true),'resume_sha256',repeat('a',64),'resume_tailored',true) p
 from (values ('00000000-0000-4000-8000-000000001601'), ('00000000-0000-4000-8000-000000001603')) v(u);
grant select on rr_mail to service_role;
insert into career_watch_kv(user_id,key,value) select u::uuid, 'career:email-card',
 jsonb_build_object('id','rr-mail','state','shown','payload',p,'payload_hash',career_apply_payload_hash(p),'shown_at',now(),'thread','t') from rr_mail;
set role service_role;
select t.must_fail($$select career_apply_email_reserve_as(u::uuid, p, career_apply_payload_hash(p)) from rr_mail where u = '00000000-0000-4000-8000-000000001603'$$,
 'no_resume', 'an emailed application with no confirmed resume on file is never reserved into driving');
select t.ok((select (career_apply_email_reserve_as(u::uuid, p, career_apply_payload_hash(p))).state = 'driving' from rr_mail where u = '00000000-0000-4000-8000-000000001601'),
 'with a confirmed resume on file and the stored render it attaches: reserved, as before');
reset role;
-- The retry: an emailed application Gmail refused (not_submitted), written past the guard as a restore could, then tried again.
set session_replication_role = replica;
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,source,attempts)
 select u::uuid, p->>'job_id', p->>'company', p->>'url', p, career_apply_payload_hash(p), career_apply_payload_hash(p), 'not_submitted', 'email', 1
 from rr_mail where u = '00000000-0000-4000-8000-000000001603';
set session_replication_role = origin;
set role service_role;
select t.must_fail($$select career_apply_email_reserve_as(u::uuid, p, career_apply_payload_hash(p)) from rr_mail where u = '00000000-0000-4000-8000-000000001603'$$,
 'no_resume', 'an emailed application tried again (not_submitted -> driving) with no confirmed resume is refused');
reset role;
select t.ok((select state = 'not_submitted' from career_apply_jobs where job_id = 'TEST-RR-MAIL-3'), 'and it stays not sent');
select t.must_fail($$update career_apply_jobs set state = 'driving' where job_id = 'TEST-RR-MAIL-3'$$,
 'no_resume', 'no direct update moves it into driving either');

-- 3. prepared and carded; the card's answer names the reason
select t.must_fail($$insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select u::uuid, p->>'job_id', p->>'company', p->>'url', p, career_apply_payload_hash(p), array['RR line'] from rr_p where k = 'none' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'an application with no resume is never prepared');
select t.must_fail($$insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select u::uuid, p->>'job_id', p->>'company', p->>'url', p, career_apply_payload_hash(p), array['RR line'] from rr_p where k = 'fake' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'nor with the sha256 of no stored resume');
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select u::uuid, p->>'job_id', p->>'company', p->>'url', p, career_apply_payload_hash(p), array['RR line'] from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001602';
select t.ok((select count(*) = 1 from career_apply_prepared where job_id = 'TEST-RR-2-with'), 'one with its resume is prepared');
create temp table rr_card as select (career_apply_card_open_for('00000000-0000-4000-8000-000000001602', array[(select id from career_apply_prepared where job_id = 'TEST-RR-2-with')], now())).id;
select t.ok((select count(*) = 1 from rr_card), 'and carded');
-- The stored render is gone before the tap: the queue refuses it, and the answer says why.
delete from storage.objects where name = '00000000-0000-4000-8000-000000001602/' || repeat('a',64) || '.pdf';
select t.ok((select career_apply_card_answer_for('00000000-0000-4000-8000-000000001602', (select id from rr_card), array[1], now()) = '[{"n":1,"company":"RR Employer 2with","result":"no_resume"}]'::jsonb),
 'an approval the queue refuses for its resume is answered no_resume, not refused');
select t.ok((select count(*) = 0 from career_apply_jobs where job_id = 'TEST-RR-2-with'), 'and nothing is queued');
insert into storage.objects(bucket_id,name) values ('career-resumes', '00000000-0000-4000-8000-000000001602/' || repeat('a',64) || '.pdf');
set session_replication_role = replica;
update career_apply_prepared set payload = payload - 'resume_sha256', state = 'ready' where job_id = 'TEST-RR-2-with';
set session_replication_role = origin;
select t.must_fail($$select career_apply_card_open_for('00000000-0000-4000-8000-000000001602', array[(select id from career_apply_prepared where job_id = 'TEST-RR-2-with')], now())$$,
 'no_resume', 'a card never shows an application with no resume');

-- 3b. prepared on the person's own signed-in computer: the file stays there. Its sha256 counts only when it is a resume
-- file the person confirmed (a fact_confirmed event names it as the uploaded file); any other 64-hex is refused
-- (review of #194, 2026-10-27).
select t.as_user('00000000-0000-4000-8000-000000001601');set role authenticated;
select t.must_fail($$select career_apply_prepare_own(p || jsonb_build_object('resume_sha256', repeat('f',64), 'job_id', 'TEST-RR-1-random'), array['RR device line']) from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'a random 64-hex from the person''s own computer is not a resume');
reset role;
select t.ok((select not career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('f',64))), 'and is not recorded as theirs');
insert into career_events(user_id,kind,subject,detail) values ('00000000-0000-4000-8000-000000001601','fact_confirmed','RR file',
 jsonb_build_object('confirmation_event_id','ev-rr-file','upload',jsonb_build_object('kind','file','ref','TEST local file','sha256',repeat('e',64))));
insert into career_events(user_id,kind,subject,detail) values ('00000000-0000-4000-8000-000000001601','fact_confirmed','RR pasted',
 jsonb_build_object('confirmation_event_id','ev-rr-msg','upload',jsonb_build_object('kind','message','ref','TEST pasted','sha256',repeat('d',64))));
select t.as_user('00000000-0000-4000-8000-000000001601');set role authenticated;
select t.must_fail($$select career_apply_prepare_own(p || jsonb_build_object('resume_sha256', repeat('d',64), 'job_id', 'TEST-RR-1-pasted'), array['RR device line']) from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001601'$$,
 'no_resume', 'the hash of pasted text is not a resume file');
select t.ok((select (career_apply_prepare_own(p || jsonb_build_object('resume_sha256', repeat('e',64), 'job_id', 'TEST-RR-1-device'), array['RR device line'])) is not null from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001601'),
 'the person''s own computer prepares with the resume file they confirmed');
reset role;
select t.ok((select career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('e',64))), 'that file counts as theirs');
select t.ok((select not career_resume_stored('00000000-0000-4000-8000-000000001602', repeat('e',64))), 'and as no one else''s');
set role service_role;
select t.must_fail($$select career_apply_enqueue(p || jsonb_build_object('resume_sha256', repeat('e',64), 'job_id', 'TEST-RR-2-device'), career_apply_payload_hash(p || jsonb_build_object('resume_sha256', repeat('e',64), 'job_id', 'TEST-RR-2-device')), career_apply_payload_hash(p || jsonb_build_object('resume_sha256', repeat('e',64), 'job_id', 'TEST-RR-2-device')), 15) from rr_p where k = 'with' and u = '00000000-0000-4000-8000-000000001602'$$,
 'no_resume', 'another person cannot queue with a file someone else confirmed');
reset role;

-- 4. the resume on file: a confirmed entry counts only with its fact_confirmed event recorded.
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000016a1','00000000-0000-4000-8000-000000001603');
insert into agent_flow_state(thread_id,user_id,state) values ('00000000-0000-4000-8000-0000000016a1','00000000-0000-4000-8000-000000001603',
 '{"career":{"stores":{"profile":{"facts":[{"id":"f1","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"ev-rr-3","text":"RR Intern"}]}}}}');
select t.ok((select not career_resume_on_file('00000000-0000-4000-8000-000000001603')), 'a confirmed entry whose event is not on record is no resume');
insert into career_events(user_id,kind,subject,detail) values ('00000000-0000-4000-8000-000000001603','fact_confirmed','RR Intern','{"confirmation_event_id":"ev-rr-3"}');
select t.ok((select career_resume_on_file('00000000-0000-4000-8000-000000001603')), 'with its event recorded, the resume is on file');
select t.ok((select career_resume_on_file('00000000-0000-4000-8000-000000001601')), 'each person''s own events count');
-- A resume confirmed in one thread is on file in the next: a newer thread with no profile changes nothing.
insert into agent_threads(id,user_id) values ('00000000-0000-4000-8000-0000000016c1','00000000-0000-4000-8000-000000001601');
insert into agent_flow_state(thread_id,user_id,state) values ('00000000-0000-4000-8000-0000000016c1','00000000-0000-4000-8000-000000001601','{"career":{"stores":{"profile":{"basics":{"name":"RR"},"facts":[]}}}}');
select t.ok((select career_resume_on_file('00000000-0000-4000-8000-000000001601')), 'confirmed in one thread, on file in every thread');
set role authenticated;
select t.must_fail($$select career_resume_on_file('00000000-0000-4000-8000-000000001601')$$, 'permission denied', 'a signed-in person cannot ask about anyone');
select t.must_fail($$select career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('a',64))$$, 'permission denied', 'nor about anyone''s files');
reset role;

-- 5. a resume sent as a file counts as stored; erased with the account. The bytes must be the declared size and sha256
-- (review of #194, folds in #206): a fabricated fingerprint stores nothing.
set role service_role;
select t.must_fail($$select career_resume_upload_record_as('00000000-0000-4000-8000-000000001601','telegram','telegram:forged','resume.pdf','application/pdf',9,repeat('b',64),'JVBERi0xLjQK',repeat('c',64))$$,
 'invalid resume upload', 'a fabricated sha256 is refused');
select t.must_fail($$select career_resume_upload_record_as('00000000-0000-4000-8000-000000001601','telegram','telegram:bad-base64','resume.pdf','application/pdf',9,repeat('b',64),'@not-base64!',repeat('c',64))$$,
 'invalid symbol', 'malformed base64 is refused');
select t.must_fail($$select career_resume_upload_record_as('00000000-0000-4000-8000-000000001601','telegram','telegram:bad-size','resume.pdf','application/pdf',10,encode(sha256(decode('JVBERi0xLjQK','base64')),'hex'),'JVBERi0xLjQK',repeat('c',64))$$,
 'invalid resume upload', 'a wrong declared size is refused');
select t.ok((select count(*) = 0 from career_resume_uploads where user_id = '00000000-0000-4000-8000-000000001601'), 'the refused uploads stored nothing');
select t.ok((select not career_resume_stored('00000000-0000-4000-8000-000000001601', repeat('b',64))), 'a fabricated sha256 is no stored resume');
select t.ok((select career_resume_upload_record_as('00000000-0000-4000-8000-000000001601','telegram','telegram:AgADrr','resume.pdf','application/pdf',9,encode(sha256(decode('JVBERi0xLjQK','base64')),'hex'),'JVBERi0xLjQK',repeat('c',64)) is not null),
 'the upload is recorded by its reference and sha256');
select t.ok((select career_resume_upload_record_as('00000000-0000-4000-8000-000000001601','telegram','telegram:AgADrr','resume.pdf','application/pdf',9,encode(sha256(decode('JVBERi0xLjQK','base64')),'hex'),'JVBERi0xLjQK',repeat('c',64))
  = (select id from career_resume_uploads where sha256 = encode(sha256(decode('JVBERi0xLjQK','base64')),'hex'))), 'the same upload twice is one row');
select t.ok((select career_resume_stored('00000000-0000-4000-8000-000000001601', encode(sha256(decode('JVBERi0xLjQK','base64')),'hex'))), 'the file the person sent is a stored resume');
reset role;
select t.as_user('00000000-0000-4000-8000-000000001602');set role authenticated;
select t.ok((select count(*) = 0 from career_resume_uploads), 'nobody else reads it');
reset role;
update career_watch_kv set value = jsonb_set(value, '{epoch}', '2') where user_id = '00000000-0000-4000-8000-000000001601' and key = 'career:account';
select t.ok((select count(*) = 0 from career_resume_uploads where user_id = '00000000-0000-4000-8000-000000001601'), 'an erase deletes the resume file');
rollback;
