-- 20261102000000 (whole journeys round 2): a confirmed entry corrected in chat stops what was made from its old words.
-- Prepared, not approved: discarded (prepared again from the corrected entry). Approved, not handed out, carrying the old
-- words in its answers: removed from the queue. Approved without them, another kind of event, another person: untouched.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000013c0001','cs-a@example.test'), ('00000000-0000-4000-8000-0000013c0002','cs-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000013c0001'), ('00000000-0000-4000-8000-0000013c0002');
-- A confirmed resume on file for each (the owner's resume rule), as tests/flow/resume-seed.ts seeds it.
with th as (insert into agent_threads (user_id, title) select u, 'TEST seeded resume' from unnest(array['00000000-0000-4000-8000-0000013c0001','00000000-0000-4000-8000-0000013c0002']::uuid[]) u returning id, user_id)
insert into agent_flow_state (thread_id, user_id, state, updated_at) select id, user_id,
 '{"career":{"stores":{"profile":{"facts":[{"id":"seed-resume","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-resume-cs","text":"TEST Analyst, TEST Co"}]}}}}',
 now() - interval '30 days' from th;
insert into career_events (user_id, kind, subject, detail) select u, 'fact_confirmed', 'TEST Analyst, TEST Co', '{"confirmation_event_id":"seed-resume-cs"}'
 from unnest(array['00000000-0000-4000-8000-0000013c0001','00000000-0000-4000-8000-0000013c0002']::uuid[]) u;
insert into storage.objects (bucket_id, name) select 'career-resumes', u || '/' || repeat('a', 64) || '.pdf'
 from unnest(array['00000000-0000-4000-8000-0000013c0001','00000000-0000-4000-8000-0000013c0002']) u;
create temp table cs_pl as select u::uuid as u, j, jsonb_build_object('version',1,'user_id',u,'job_id',j,'company','TEST CS','url','https://boards.greenhouse.io/cs/jobs/' || n,
  'fields', jsonb_build_array(jsonb_build_object('name','gpa','label','GPA','value', g)),'resume_sha256',repeat('a',64)) as p
 from (values ('00000000-0000-4000-8000-0000013c0001','greenhouse:cs:1',1,'3.75'), ('00000000-0000-4000-8000-0000013c0001','greenhouse:cs:2',2,'3.75'),
  ('00000000-0000-4000-8000-0000013c0001','greenhouse:cs:3',3,'n/a'), ('00000000-0000-4000-8000-0000013c0002','greenhouse:cs:1',1,'3.75'),
  ('00000000-0000-4000-8000-0000013c0002','greenhouse:cs:2',2,'3.75')) v(u, j, n, g);
-- Prepared, not yet approved: cs:2 for A, cs:2 for B.
insert into career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
 select u, j, 'TEST CS', p->>'url', p, encode(sha256(convert_to(p::text, 'UTF8')), 'hex'), array['TEST CS'] from cs_pl where j = 'greenhouse:cs:2';
-- Approved and waiting: cs:1 (GPA 3.75) and cs:3 (no GPA) for A, cs:1 for B.
insert into career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash)
 select u, j, 'TEST CS', p->>'url', p, encode(sha256(convert_to(p::text, 'UTF8')), 'hex'), encode(sha256(convert_to(p::text, 'UTF8')), 'hex') from cs_pl where j in ('greenhouse:cs:1', 'greenhouse:cs:3');

-- Another kind of fact_confirmed (a resume confirmation) changes nothing.
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000013c0001', 'fact_confirmed', 'TEST', '{"confirmation_event_id":"x","via":"router: their yes to the resume entries shown to them"}');
select t.ok((select count(*) = 2 from career_apply_prepared where state in ('ready','shown')), 'a resume confirmation leaves the prepared applications');

-- A's correction of the GPA, 3.75 -> 3.95.
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000013c0001', 'fact_confirmed', 'TEST University, GPA 3.95',
 jsonb_build_object('confirmation_event_id', 'fix-1', 'corrected', jsonb_build_object('from', '3.75', 'to', '3.95'), 'via', 'router: their correction of a confirmed resume entry'));
select t.ok((select count(*) = 0 from career_apply_prepared where user_id = '00000000-0000-4000-8000-0000013c0001'), 'their prepared application from the old words is discarded');
select t.ok((select array_agg(job_id order by job_id) = array['greenhouse:cs:3'] from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000013c0001'),
 'the approval carrying 3.75 is removed from the queue; the one without it stands');
select t.ok((select count(*) = 1 from career_events where user_id = '00000000-0000-4000-8000-0000013c0001' and kind = 'note' and detail->>'why' = 'corrected'
 and (detail->>'cancelled')::int = 1 and (detail->>'discarded')::int = 1), 'a note says what stopped');
select t.ok((select count(*) = 1 from career_apply_prepared where user_id = '00000000-0000-4000-8000-0000013c0002')
 and (select count(*) = 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000013c0002'), 'another person is untouched');
-- The same correction again (a retried save) is harmless.
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000013c0001', 'fact_confirmed', 'TEST University, GPA 3.95',
 jsonb_build_object('confirmation_event_id', 'fix-2', 'corrected', jsonb_build_object('from', '3.75', 'to', '3.95'), 'via', 'router: their correction of a confirmed resume entry'));
select t.ok((select count(*) = 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000013c0001'), 'nothing more stops');
-- Not callable by a person or anon.
select t.ok(not has_function_privilege('authenticated', 'public.career_correction_stop_stale()', 'execute')
 and not has_function_privilege('anon', 'public.career_correction_stop_stale()', 'execute'), 'the trigger function is not anyone''s to call');
rollback;
