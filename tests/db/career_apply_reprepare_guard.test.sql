-- 20261101130000 (review of #391): an approval spent on a history row (not_submitted, needs_answers) is never spent again.
-- No user path reaches it (the re-prepared application has a new payload and a new approval), so the guard is on the table:
-- whatever inserts the row (career_apply_enqueue as service_role included) is refused. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000013b0001','rg-a@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000013b0001');
-- A confirmed resume on file (the owner's resume rule: nothing is queued without one), as tests/flow/resume-seed.ts seeds it.
with th as (insert into agent_threads (user_id, title) values ('00000000-0000-4000-8000-0000013b0001', 'TEST seeded resume') returning id)
insert into agent_flow_state (thread_id, user_id, state, updated_at) select id, '00000000-0000-4000-8000-0000013b0001',
 '{"career":{"stores":{"profile":{"facts":[{"id":"seed-resume","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-resume-rg","text":"TEST Analyst, TEST Co"}]}}}}',
 now() - interval '30 days' from th;
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000013b0001', 'fact_confirmed', 'TEST Analyst, TEST Co', '{"confirmation_event_id":"seed-resume-rg"}');
insert into storage.objects (bucket_id, name) values ('career-resumes', '00000000-0000-4000-8000-0000013b0001/' || repeat('a', 64) || '.pdf');
-- The history row: approved (hash H1, engine approval E1), driven, stopped by the form for a new question.
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013b0001','greenhouse:rg:1','TEST RG','https://boards.greenhouse.io/rg/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:rg:1','engine_approval',repeat('e',64)),repeat('1',64),repeat('1',64));
set local session_replication_role = replica;
update career_apply_jobs set state='not_submitted', reason='needs_answers' where job_id='greenhouse:rg:1';
set local session_replication_role = origin;
select t.ok((select public.career_apply_job_history(j) from career_apply_jobs j where job_id='greenhouse:rg:1'),'the stopped row is history');

-- 1. The same approval again (the old payload and hash, as a direct service_role enqueue would write it): refused.
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013b0001','greenhouse:rg:1','TEST RG','https://boards.greenhouse.io/rg/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:rg:1','engine_approval',repeat('e',64)),repeat('1',64),repeat('1',64))$$,
 'approval_spent','the old payload and approval are refused');
-- 2. A new payload that reuses only the old engine approval: refused.
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013b0001','greenhouse:rg:1','TEST RG','https://boards.greenhouse.io/rg/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:rg:1','engine_approval',repeat('e',64)),repeat('2',64),repeat('2',64))$$,
 'approval_spent','the old engine approval on a new payload is refused');
-- 3. The re-prepared application with its new approval: accepted (one live row).
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013b0001','greenhouse:rg:1','TEST RG','https://boards.greenhouse.io/rg/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:rg:1','engine_approval',repeat('f',64)),repeat('3',64),repeat('3',64));
select t.ok((select count(*)=2 from career_apply_jobs where job_id='greenhouse:rg:1'),'a new approval makes the new row');
-- 4. Another posting with a hash some other history row used is not this guard's business (it is per person and posting).
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013b0001','greenhouse:rg:2','TEST RG','https://boards.greenhouse.io/rg/jobs/2',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:rg:2'),repeat('1',64),repeat('1',64));
select t.ok(true,'another posting is not refused by this guard');
rollback;
