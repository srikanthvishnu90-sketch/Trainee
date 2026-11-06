-- WO-121/7 (20261107100000_career_posting_forms.sql): todo returns only open Greenhouse, Lever and Ashby postings with no
-- capture (or a retryable unread whose wait is over), newest first; a second put with the same SHA-256 changes nothing and
-- a changed one replaces the fields and map; a failed read never replaces a capture; career_form_readiness counts
-- captured_within_1h from read_at - first_seen_at and names why the rest are unread; anon and authenticated cannot read
-- the table or call the functions. The migration is applied inside this transaction (the ledger applies it again later).
begin;
reset role;
\set root `printf '%s' "$UPMORE_ROOT"`
\i :root/supabase/migrations/20261107100000_career_posting_forms.sql
\i :root/supabase/migrations/20261107100000_career_posting_forms.sql
set role service_role;
insert into public.career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at,closed_at) values
  ('greenhouse:acme:1','greenhouse','acme','1','Acme','Analyst','https://job-boards.greenhouse.io/acme/jobs/1', now()-interval '3 hours', now(), null),
  ('greenhouse:acme:2','greenhouse','acme','2','Acme','Engineer','https://job-boards.greenhouse.io/acme/jobs/2', now()-interval '1 hour', now(), null),
  ('lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5','lever','acme','0130d854-9bae-48d4-8ef0-e9da1ee778a5','Acme','Designer','https://jobs.lever.co/acme/0130d854-9bae-48d4-8ef0-e9da1ee778a5', now()-interval '2 hours', now(), null),
  ('ashby:acme:cba0ab2e-5ab8-416b-ac9b-115638e3c65c','ashby','acme','cba0ab2e-5ab8-416b-ac9b-115638e3c65c','Acme','PM','https://jobs.ashbyhq.com/acme/cba0ab2e-5ab8-416b-ac9b-115638e3c65c', now()-interval '30 minutes', now(), null),
  ('greenhouse:acme:3','greenhouse','acme','3','Acme','Closed role','https://job-boards.greenhouse.io/acme/jobs/3', now()-interval '1 hour', now(), now()),
  ('greenhouse:acme:4','greenhouse','acme','4','Acme','Old role','https://job-boards.greenhouse.io/acme/jobs/4', now()-interval '3 days', now(), null),
  ('smartrecruiters:acme:9','smartrecruiters','acme','9','Acme','Clerk','https://jobs.smartrecruiters.com/Acme/9', now()-interval '1 hour', now(), null),
  ('workday:acme.wd5/careers:R1','workday','acme.wd5/careers','R1','Acme','Nurse','https://acme.wd5.myworkdayjobs.com/careers/job/R1', now()-interval '1 hour', now(), null);
select t.ok((select array_agg(job_id order by n) = array['ashby:acme:cba0ab2e-5ab8-416b-ac9b-115638e3c65c','greenhouse:acme:2','lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5','greenhouse:acme:1']
  from (select job_id, row_number() over () n from public.career_posting_forms_todo(now()-interval '24 hours', 600)) x),
  'todo: open GH/Lever/Ashby postings first seen in the window, newest first (no closed, old, SmartRecruiters or Workday row)');
select t.ok((select count(*) = 2 from public.career_posting_forms_todo(now()-interval '24 hours', 2)), 'todo honours its limit');

create temp table cap as select jsonb_build_array(jsonb_build_object('job_id','greenhouse:acme:1','provider','greenhouse','state','captured',
  'source','greenhouse_boards_api','fields',jsonb_build_array(jsonb_build_object('id','email','label','Email')),'mapped','[]'::jsonb,
  'uploads',jsonb_build_array('resume'),'captcha_expected',false,'schema_sha256',repeat('a',64),
  'first_seen_at',now()-interval '3 hours','read_at',now()-interval '2 hours 30 minutes')) r;
select t.ok(public.career_posting_forms_put((select r from cap)) = 1, 'put writes a capture');
select t.ok((select uploads = array['resume'] and attempts = 1 and state = 'captured' from public.career_posting_forms where job_id='greenhouse:acme:1'), 'its uploads and state are stored');
create temp table snap as select to_jsonb(f) j from public.career_posting_forms f where job_id='greenhouse:acme:1';
select t.ok(public.career_posting_forms_put((select jsonb_set(r, '{0,read_at}', to_jsonb(now())) from cap)) = 0, 'a second put with the same sha writes nothing');
select t.ok((select to_jsonb(f) = (select j from snap) from public.career_posting_forms f where job_id='greenhouse:acme:1'), 'and the row is exactly as it was');
select t.ok(public.career_posting_forms_put((select jsonb_set(jsonb_set(r, '{0,state}', '"unread"'), '{0,unread}', '"http_error"') from cap)) = 0,
  'a failed read never replaces a capture');
select t.ok(public.career_posting_forms_put((select jsonb_set(jsonb_set(r, '{0,schema_sha256}', to_jsonb(repeat('b',64))), '{0,fields}', '[{"id":"phone","label":"Phone"}]') from cap)) = 1,
  'a changed sha is written');
select t.ok((select fields->0->>'id' = 'phone' and schema_sha256 = repeat('b',64) from public.career_posting_forms where job_id='greenhouse:acme:1'), 'and replaces the fields');
select t.ok((select count(*) = 0 from public.career_posting_forms_todo(now()-interval '24 hours', 600) where job_id = 'greenhouse:acme:1'), 'a captured posting leaves todo');

-- An unread row: retryable reasons come back after 15 min x attempts, at most 5 attempts; not_public does not.
select t.ok(public.career_posting_forms_put(jsonb_build_array(
  jsonb_build_object('job_id','lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5','provider','lever','state','unread','unread','rate_limited','detail','HTTP 429',
    'first_seen_at',now()-interval '2 hours','read_at',now()-interval '20 minutes'),
  jsonb_build_object('job_id','ashby:acme:cba0ab2e-5ab8-416b-ac9b-115638e3c65c','provider','ashby','state','unread','unread','not_public','detail','owner step 1',
    'first_seen_at',now()-interval '30 minutes','read_at',now()-interval '20 minutes'))) = 2, 'put writes unread rows');
select t.ok((select array_agg(job_id) = array['greenhouse:acme:2','lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5'] from public.career_posting_forms_todo(now()-interval '24 hours', 600)),
  'a rate_limited row 20 minutes on is read again; not_public is not');
select t.ok(public.career_posting_forms_put(jsonb_build_array(jsonb_build_object('job_id','lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5','provider','lever','state','unread',
  'unread','http_error','detail','HTTP 503','first_seen_at',now()-interval '2 hours','read_at',now()-interval '20 minutes'))) = 1, 'a second failure is written');
select t.ok((select attempts = 2 from public.career_posting_forms where job_id='lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5'), 'and counts its attempt');
select t.ok((select count(*) = 0 from public.career_posting_forms_todo(now()-interval '24 hours', 600) where job_id like 'lever:%'), 'two attempts wait 30 minutes');
update public.career_posting_forms set attempts = 5, read_at = now()-interval '1 day' where job_id like 'lever:%';
select t.ok((select count(*) = 0 from public.career_posting_forms_todo(now()-interval '24 hours', 600) where job_id like 'lever:%'), 'five attempts: never again');
select t.must_fail($$update public.career_posting_forms set state='captured' where job_id like 'lever:%'$$, 'career_posting_forms_captured', 'a capture needs its source and sha');
select t.must_fail($$update public.career_posting_forms set detail = repeat('x', 301) where job_id like 'lever:%'$$, 'career_posting_forms_detail_check', 'detail is bounded');

-- M4: greenhouse:acme:1 was read 30 minutes after first seen (within 1 h); greenhouse:acme:2 and :3 (closed before any
-- read) were not read; :4 was first seen before the window.
select t.ok((select first_seen = 3 and captured = 1 and captured_within_1h = 1 and unread_by_reason = '{"not_read_yet": 2}'::jsonb
  from public.career_form_readiness(interval '24 hours') where provider = 'greenhouse'), 'readiness: greenhouse 3 seen in the window, 1 captured within 1 h');
update public.career_posting_forms set read_at = first_seen_at + interval '2 hours' where job_id = 'greenhouse:acme:1';
select t.ok((select captured = 1 and captured_within_1h = 0 from public.career_form_readiness(interval '24 hours') where provider = 'greenhouse'),
  'captured_within_1h follows read_at - first_seen_at');
select t.ok((select unread_by_reason = '{"http_error": 1}'::jsonb from public.career_form_readiness(interval '24 hours') where provider = 'lever'), 'lever: unread by reason');
select t.ok((select unread_by_reason = '{"needs_partner_key": 1}'::jsonb and captured = 0 from public.career_form_readiness(interval '24 hours') where provider = 'smartrecruiters'),
  'SmartRecruiters is reported with its reason, never captured');
select t.ok((select unread_by_reason = '{"sign_in_required": 1}'::jsonb from public.career_form_readiness(interval '24 hours') where provider = 'workday'), 'Workday likewise');
reset role;

select t.ok((select relrowsecurity from pg_class where oid = 'public.career_posting_forms'::regclass), 'RLS is on');
select t.ok(not has_table_privilege('anon', 'public.career_posting_forms', 'select') and not has_table_privilege('authenticated', 'public.career_posting_forms', 'select'),
  'anon and authenticated cannot read the table');
select t.ok(not has_function_privilege('authenticated', 'public.career_posting_forms_todo(timestamptz,int)', 'execute')
  and not has_function_privilege('anon', 'public.career_posting_forms_put(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.career_form_readiness(interval)', 'execute'), 'nor call its functions');
set role authenticated;
select t.must_fail($$select * from public.career_posting_forms$$, 'permission denied', 'a signed-in person reading the table is refused');
reset role;
\i :root/supabase/rollbacks/20261107100000_career_posting_forms.down.sql
select t.ok(to_regclass('public.career_posting_forms') is null and to_regprocedure('public.career_form_readiness(interval)') is null, 'the rollback removes the table and functions');
rollback;
