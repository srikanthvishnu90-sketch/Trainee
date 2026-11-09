-- 20261109120000 (WO-M, architect ruling 2026-11-09): after the VM's Submit click, an employer page asking for an emailed code
-- ends not_submitted / email_code ONLY with the full evidence: a visible code field on the same employer host, no confirmation
-- signal, a page-text hash and a screenshot hash. Each missing piece leaves it unknown_outcome. The posting is then history:
-- back in the person's queue, a preparation asked, and the new application needs a NEW payload and approval. Rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000013c0001','ec-a@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000013c0001');
-- A confirmed resume on file (nothing is queued without one), as career_apply_reprepare_guard.test.sql seeds it.
with th as (insert into agent_threads (user_id, title) values ('00000000-0000-4000-8000-0000013c0001', 'TEST seeded resume') returning id)
insert into agent_flow_state (thread_id, user_id, state, updated_at) select id, '00000000-0000-4000-8000-0000013c0001',
 '{"career":{"stores":{"profile":{"facts":[{"id":"seed-resume","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-resume-ec","text":"TEST Analyst, TEST Co"}]}}}}',
 now() - interval '30 days' from th;
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000013c0001', 'fact_confirmed', 'TEST Analyst, TEST Co', '{"confirmation_event_id":"seed-resume-ec"}');
insert into storage.objects (bucket_id, name) values ('career-resumes', '00000000-0000-4000-8000-0000013c0001/' || repeat('a', 64) || '.pdf');
-- One approved application (hash H1, engine approval E1) on the employer host boards.greenhouse.io.
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013c0001','greenhouse:ec:1','TEST EC','https://boards.greenhouse.io/ec/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:ec:1','engine_approval',repeat('e',64)),repeat('1',64),repeat('1',64));

-- The VM has claimed it and recorded 'submitting' (the click): set directly, as the claim and heartbeat leave it.
create temp table ec_lease as select '00000000-0000-4000-8000-0000013c00ff'::uuid as lease, 'vm-ec'::text as worker;
create or replace function pg_temp.drive() returns void language sql as $$
 update career_apply_jobs set state = 'driving', reason = null, lease_token = (select lease from ec_lease), vm_worker = (select worker from ec_lease),
  vm_phase = 'submitting', vm_heartbeat_at = now(), claimed_at = now(), attempts = 1 where job_id = 'greenhouse:ec:1' and payload_hash = repeat('1',64);
$$;
create or replace function pg_temp.finish(ev jsonb, reason text default 'email_code') returns jsonb language sql as $$
 select public.career_apply_vm_complete((select id from career_apply_jobs where job_id = 'greenhouse:ec:1' and payload_hash = repeat('1',64)),
  (select lease from ec_lease), (select worker from ec_lease), 'not_submitted', reason, ev);
$$;
create temp table ec_good as select jsonb_build_object('submit_clicked', true, 'email_code', jsonb_build_object(
 'code_field_visible', true, 'host', 'boards.greenhouse.io', 'confirmation_signal', false,
 'page_text_sha256', repeat('b', 64), 'screenshot_sha256', repeat('c', 64))) as ev;

-- 1. Each missing piece: unknown_outcome, never re-prepared, the piece named.
set local session_replication_role = replica; select pg_temp.drive(); set local session_replication_role = origin;
select t.ok((pg_temp.finish('{"submit_clicked":true}'::jsonb))->>'state' = 'unknown_outcome', 'no code-page evidence: unknown');
do $$
declare piece text; bad jsonb; r jsonb; good jsonb := (select ev from ec_good);
begin
 for piece, bad in select * from (values
   ('no_visible_code_field', jsonb_set(good, '{email_code,code_field_visible}', 'false')),
   ('no_visible_code_field', good #- '{email_code,code_field_visible}'),
   ('code_field_on_another_host', jsonb_set(good, '{email_code,host}', '"verify.example.com"')),
   ('code_field_on_another_host', good #- '{email_code,host}'),
   ('confirmation_signal_present', jsonb_set(good, '{email_code,confirmation_signal}', 'true')),
   ('confirmation_signal_present', good #- '{email_code,confirmation_signal}'),
   ('no_page_text_hash', jsonb_set(good, '{email_code,page_text_sha256}', '"abc"')),
   ('no_page_text_hash', good #- '{email_code,page_text_sha256}'),
   ('no_screenshot_hash', good #- '{email_code,screenshot_sha256}'),
   ('no_screenshot_hash', jsonb_set(good, '{email_code,screenshot_sha256}', 'null'))) v(p, e) loop
  set local session_replication_role = replica; perform pg_temp.drive(); set local session_replication_role = origin;
  r := pg_temp.finish(bad);
  if r->>'state' <> 'unknown_outcome' or position(piece in r->>'reason') = 0 then
   raise exception 'FAIL missing piece %: got %', piece, r;
  end if;
 end loop;
 raise notice 'ok   each missing piece of evidence leaves unknown_outcome, the piece named (10 cases)';
end $$;
select t.ok(not exists (select from career_apply_wanted where user_id = '00000000-0000-4000-8000-0000013c0001'), 'an unproven code page is never re-prepared');
-- Another reason after the click is still unknown, whatever the evidence says (the guard holds everywhere else).
set local session_replication_role = replica; select pg_temp.drive(); set local session_replication_role = origin;
select t.ok((pg_temp.finish((select ev from ec_good), 'needs_answers'))->>'state' = 'unknown_outcome', 'needs_answers after the click stays unknown');
-- www. on either side is the same host.
select t.ok(public.career_apply_vm_email_code_refusal('https://www.acme.example/jobs/1', jsonb_set((select ev from ec_good), '{email_code,host}', '"acme.example"')) is null, 'www. is the same host');
select t.ok(public.career_apply_vm_email_code_refusal('https://acme.example:8443/jobs/1', jsonb_set((select ev from ec_good), '{email_code,host}', '"acme.example"')) is null, 'a port is not part of the host');
select t.ok(public.career_apply_vm_email_code_refusal('https://evil.example/@acme.example/jobs/1', jsonb_set((select ev from ec_good), '{email_code,host}', '"acme.example"')) = 'code_field_on_another_host', 'a path is not the host');

-- 2. The full evidence: not_submitted / email_code, history, back in the queue, a preparation asked.
set local session_replication_role = replica; select pg_temp.drive(); set local session_replication_role = origin;
select t.ok((pg_temp.finish((select ev from ec_good)))->>'reason' = 'email_code', 'the proven code page ends email_code');
select t.ok((select state || ':' || reason from career_apply_jobs where job_id = 'greenhouse:ec:1') = 'not_submitted:email_code', 'not_submitted / email_code');
select t.ok((select public.career_apply_job_history(j) from career_apply_jobs j where job_id = 'greenhouse:ec:1'), 'it is history');
select t.ok((select state from career_apply_wanted where user_id = '00000000-0000-4000-8000-0000013c0001' and posting_key = 'greenhouse:ec:1') = 'waiting', 'back in the person''s queue');
select t.ok(exists (select from career_apply_prepare_requests where user_id = '00000000-0000-4000-8000-0000013c0001' and 'greenhouse:ec:1' = any(job_ids)), 'a preparation is asked for');

-- 3. Re-preparing needs a new card and hash: the old payload, approval or engine approval is refused; a new one is one live row.
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013c0001','greenhouse:ec:1','TEST EC','https://boards.greenhouse.io/ec/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:ec:1','engine_approval',repeat('e',64)),repeat('1',64),repeat('1',64))$$,
 'approval_spent', 'the old payload and approval are never sent again');
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013c0001','greenhouse:ec:1','TEST EC','https://boards.greenhouse.io/ec/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:ec:1','engine_approval',repeat('e',64)),repeat('2',64),repeat('2',64))$$,
 'approval_spent', 'the old engine approval on a new payload is refused');
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013c0001','greenhouse:ec:1','TEST EC','https://boards.greenhouse.io/ec/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:ec:1','engine_approval',repeat('f',64)),repeat('3',64),repeat('3',64));
select t.ok((select count(*) = 2 from career_apply_jobs where job_id = 'greenhouse:ec:1'), 'the new approval makes the new row beside the history row');
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values ('00000000-0000-4000-8000-0000013c0001','greenhouse:ec:1','TEST EC','https://boards.greenhouse.io/ec/jobs/1',
  jsonb_build_object('resume_sha256',repeat('a',64),'job_id','greenhouse:ec:1','engine_approval',repeat('9',64)),repeat('4',64),repeat('4',64))$$,
 'duplicate key|career_apply_jobs_live_posting', 'still one live row per person and posting');
rollback;
