-- WO-L (20261109150000): an application an employer's sign-in wall stopped (needs_user, nothing sent) is the person's to
-- finish. "I submitted it" makes it submitted_unconfirmed (by the person, waiting for the employer's mail); "I didn't
-- finish" makes it history and asks for a new preparation: a new card and a new approval, never the old one again.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000014c0001','hf-a@example.test'), ('00000000-0000-4000-8000-0000014c0002','hf-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000014c0001'), ('00000000-0000-4000-8000-0000014c0002');
-- A confirmed resume on file (nothing is queued without one), as tests/flow/resume-seed.ts seeds it.
with th as (insert into agent_threads (user_id, title) values ('00000000-0000-4000-8000-0000014c0001', 'TEST seeded resume') returning id)
insert into agent_flow_state (thread_id, user_id, state, updated_at) select id, '00000000-0000-4000-8000-0000014c0001',
 '{"career":{"stores":{"profile":{"facts":[{"id":"seed-resume","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-resume-hf","text":"TEST Analyst, TEST Co"}]}}}}',
 now() - interval '30 days' from th;
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000014c0001', 'fact_confirmed', 'TEST Analyst, TEST Co', '{"confirmation_event_id":"seed-resume-hf"}');
insert into storage.objects (bucket_id, name) values ('career-resumes', '00000000-0000-4000-8000-0000014c0001/' || repeat('a', 64) || '.pdf');

-- Five applications, each approved (hash Hn, engine approval En):
--  hf:1 SSO wall after a drive (WO-L a: nothing_sent)      hf:2 password wall after a drive (nothing_sent)
--  hf:3 a portal triage handed back before any drive        hf:4 a wall recorded before WO-L (no nothing_sent)
--  hf:5 a required question with no answer (needs_user, not a wall)
insert into career_apply_jobs(id,user_id,job_id,company,url,payload,payload_hash,approval_hash)
select ('10000000-0000-4000-8000-0000014c000'||n)::uuid, '00000000-0000-4000-8000-0000014c0001', 'greenhouse:hf:'||n, 'TEST HF', 'https://boards.greenhouse.io/hf/jobs/'||n,
 jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:hf:'||n,'engine_approval',repeat(n::text,64),'title','TEST Intern'), repeat(n::text,64), repeat(n::text,64)
from generate_series(1,5) n;
set local session_replication_role = replica;
update career_apply_jobs set state='needs_user', reason='login_required', attempts=1, evidence='{"nothing_sent":true,"wall":"sso_redirect"}' where job_id='greenhouse:hf:1';
update career_apply_jobs set state='needs_user', reason='login_required', attempts=1, evidence='{"nothing_sent":true,"wall":"password"}' where job_id='greenhouse:hf:2';
update career_apply_jobs set state='needs_user', reason='login_required', attempts=0, evidence='{"handoff":"person_signs_in"}' where job_id='greenhouse:hf:3';
update career_apply_jobs set state='needs_user', reason='login_required', attempts=1, evidence='{}' where job_id='greenhouse:hf:4';
update career_apply_jobs set state='needs_user', reason='missing_required_answer: Graduation date', attempts=1, evidence='{"nothing_sent":true}' where job_id='greenhouse:hf:5';
set local session_replication_role = origin;

-- 0. The index and the function agree; only the one RPC entry, service role only.
select t.ok(to_regclass('public.career_apply_jobs_live_posting') is null and to_regclass('public.career_apply_jobs_live_posting_v2') is not null, 'the live-posting index is the WO-L one');
select t.ok(not has_function_privilege('authenticated', 'public.career_apply_person_finished_as(uuid,uuid,text)', 'execute')
 and not has_function_privilege('anon', 'public.career_apply_person_finished_as(uuid,uuid,text)', 'execute')
 and has_function_privilege('service_role', 'public.career_apply_person_finished_as(uuid,uuid,text)', 'execute'), 'service role only');
select t.ok((select not public.career_apply_job_history(j) from career_apply_jobs j where job_id='greenhouse:hf:1'), 'a wall is not history before the person answers (no automatic re-preparation)');
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000014c0001','greenhouse:hf:1','TEST HF','https://boards.greenhouse.io/hf/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:hf:1','engine_approval',repeat('9',64)),repeat('9',64),repeat('9',64))$$,
 'duplicate key|career_apply_jobs_live_posting', 'while it waits on the person the posting has one live row');

-- 1. Refusals: a bad answer, someone else's row, a row that is not a wall, a wall from before WO-L (it cannot show nothing was sent).
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0001','sent')->>'why' = 'bad_outcome', 'only submitted or not_done');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0002','10000000-0000-4000-8000-0000014c0001','submitted')->>'why' = 'not_found', 'another person cannot answer it');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0005','submitted')->>'why' = 'not_handed_back', 'a missing answer is not a wall');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0004','not_done')->>'why' = 'not_handed_back', 'a wall with no proof nothing was sent is refused');
select t.ok((select state='needs_user' and evidence='{}'::jsonb from career_apply_jobs where job_id='greenhouse:hf:4'), 'and is left exactly as it was');

-- 2. "I submitted it": submitted_unconfirmed by the person, no confirmation invented; a double tap is a no-op; the other answer is refused.
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0002','submitted') @> '{"ok":true,"state":"submitted_unconfirmed"}', 'submitted');
select t.ok((select state='submitted_unconfirmed' and reason='finished_by_person' and confirmation_id is null
  and evidence->'by_person'->>'outcome'='submitted' and evidence->'by_person'->>'wall'='login_required' and evidence->>'nothing_sent'='true'
 from career_apply_jobs where job_id='greenhouse:hf:2'), 'by the person, unconfirmed, no confirmation id, the wall kept');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0002','submitted') @> '{"ok":true,"already":true}', 'the same answer twice is one answer');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0002','not_done')->>'why' = 'already_answered', 'the other answer after it is refused');
select t.ok((select not public.career_apply_job_history(j) from career_apply_jobs j where job_id='greenhouse:hf:2'), 'a submitted one is not history: the posting stays sent');
-- a portal triage handed back before any drive can be finished by the person too
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0003','submitted') @> '{"ok":true}', 'a triaged portal the person finished');

-- 3. "I didn't finish": history, back in the queue, a preparation asked for; the old approval is never used again.
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0001','not_done') @> '{"ok":true,"outcome":"not_done","reprepare":true}', 'not_done');
select t.ok((select count(*)=1 from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000014c0001' and 'greenhouse:hf:1' = any(job_ids) and state='queued'), 'a preparation is asked for (a new card)');
select t.ok((select state='needs_user' and public.career_apply_job_history(j) and evidence->'by_person'->>'outcome'='not_done' from career_apply_jobs j where job_id='greenhouse:hf:1'), 'the row is history, its state unchanged');
select t.ok((select state='waiting' from career_apply_wanted where user_id='00000000-0000-4000-8000-0000014c0001' and posting_key='greenhouse:hf:1'), 'the posting is back in the person''s queue');
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000014c0001','greenhouse:hf:1','TEST HF','https://boards.greenhouse.io/hf/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:hf:1','engine_approval',repeat('1',64),'title','TEST Intern'),repeat('1',64),repeat('1',64))$$,
 'approval_spent', 'the old payload and approval are refused');
select t.ok(public.career_apply_vm_handoff_requeue('00000000-0000-4000-8000-0000014c0001','greenhouse:hf:1') = '{"ok": false}'::jsonb, 'the VM re-queue never resends an answered hand-off');
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000014c0001','greenhouse:hf:1','TEST HF','https://boards.greenhouse.io/hf/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:hf:1','engine_approval',repeat('b',64),'title','TEST Intern'),repeat('b',64),repeat('b',64));
select t.ok((select count(*)=2 from career_apply_jobs where job_id='greenhouse:hf:1'), 'the new card''s new approval makes the new row');
select t.ok(public.career_apply_person_finished_as('00000000-0000-4000-8000-0000014c0001','10000000-0000-4000-8000-0000014c0001','submitted')->>'why' = 'already_answered', 'a history row cannot be turned into a submission afterwards');
rollback;
