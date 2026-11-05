-- One posting, one identity (20261105190000_career_apply_posting_identity.sql; the mass-apply outcome eval, PR #519:
-- duplicates prevented 0/14 on Greenhouse). A Greenhouse job number names its posting on any host (?gh_jid=N on the
-- employer's careers page, the boards, the embedded form's token); Lever's EU host is its board; Lever and Ashby stay keyed
-- by board and id. The queue refuses one person's second application by any of those links and names nothing else as a
-- duplicate; another person may apply to the same posting. The rebuilt index answers as the function does. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
-- Each person as the queue takes them (the owner's resume rule: a confirmed resume on file, the file confirmed by its hash).
create function pg_temp.person(u uuid) returns void language plpgsql as $$ begin
 insert into auth.users(id,email) values (u, u::text||'@example.test'); insert into profiles(id) values (u);
 insert into career_watch_kv(user_id,key,value) values (u,'career:account','{"epoch":1,"version":1,"paused":false}');
 with t as (insert into agent_threads(user_id,title) values (u,'TEST identity') returning id)
 insert into agent_flow_state(thread_id,user_id,state,updated_at) select id,u,
  '{"career":{"stores":{"profile":{"facts":[{"id":"r","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"ev-ident","text":"TEST Analyst"}]}}}}',now() - interval '30 days' from t;
 insert into career_events(user_id,kind,subject,detail) values (u,'fact_confirmed','TEST Analyst',
  jsonb_build_object('confirmation_event_id','ev-ident','upload',jsonb_build_object('kind','file','ref','TEST','sha256',encode(sha256(convert_to('%PDF-1.4 TEST identity db','UTF8')),'hex'))));
 perform career_apply_cloud_optin_as(u,true,'TEST terms');
 perform career_apply_cloud_resume_put_for(u,'resume.pdf',encode(convert_to('%PDF-1.4 TEST identity db','UTF8'),'base64'));
end $$;
select pg_temp.person('00000000-0000-4000-8000-0000000fd001'), pg_temp.person('00000000-0000-4000-8000-0000000fd002');
create function pg_temp.payload(u text, job text, company text, url text) returns jsonb language sql as $$
 select jsonb_build_object('version',1,'user_id',u,'job_id',job,'company',company,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','engine_approval',repeat('e',64),
  'resume_sha256',encode(sha256(convert_to('%PDF-1.4 TEST identity db','UTF8')),'hex'),'destination',url)
$$;
create function pg_temp.enq(p jsonb) returns text language plpgsql as $$
begin perform public.career_apply_enqueue(p, public.career_apply_payload_hash(p), public.career_apply_payload_hash(p), 25); return 'queued';
exception when others then return sqlerrm; end $$;

-- ------------------------------------------------------------------------------------------- the key, by link form
create temp table forms(base text, link text, same boolean);
insert into forms values
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://job-boards.greenhouse.io/datadog/jobs/8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://job-boards.eu.greenhouse.io/datadog/jobs/8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://boards.greenhouse.io/datadog/jobs/8257324?gh_src=newsletter',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://boards.greenhouse.io/embed/job_app?for=datadog&token=8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://job-boards.greenhouse.io/embed/job_app?for=datadog&gh_jid=8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://careers.datadoghq.com/detail/?gh_jid=8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://www.datadoghq.com/careers/job?gh_jid=8257324&gh_src=abc',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','HTTPS://Careers.Example.Test/jobs?utm_source=x&gh_jid=8257324',true),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://boards.greenhouse.io/datadog/jobs/8257325',false),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://careers.example.test/jobs?gh_jid=82573240',false),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://careers.example.test/jobs?id=8257324',false),
 ('https://boards.greenhouse.io/datadog/jobs/8257324','https://careers.example.test/jobs/8257324',false),
 ('https://jobs.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce','https://jobs.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce/apply?lever-source=LinkedIn',true),
 ('https://jobs.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce','https://jobs.eu.lever.co/CesiumAstro/A49693F9-2066-43B3-972A-CDD3A62FBBCE/',true),
 ('https://jobs.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce','https://jobs.lever.co/othercompany/a49693f9-2066-43b3-972a-cdd3a62fbbce',false),
 ('https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3','https://jobs.ashbyhq.com/OpenAI/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/application?utm_source=alert',true),
 ('https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3','https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/',true),
 ('https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3','https://jobs.ashbyhq.com/anthropic/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3',false);
select t.ok(not exists (select from forms where (career_apply_posting_key(base) = career_apply_posting_key(link)) <> same),
 'every link form keys as its posting, and no other posting shares the key (' ||
 coalesce((select string_agg(link || ' -> ' || coalesce(career_apply_posting_key(link), 'null'), '; ') from forms
  where (career_apply_posting_key(base) = career_apply_posting_key(link)) <> same), '') || ')');
select t.ok(career_apply_posting_key('https://careers.example.test/jobs?gh_jid=8257324') = 'greenhouse.io/jobs/8257324',
 'a Greenhouse job on the employer''s careers page is Greenhouse job N');

-- ------------------------------------------------------------------------------------------- the queue
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','greenhouse:datadog:8257324','Datadog',
 'https://boards.greenhouse.io/datadog/jobs/8257324')) = 'queued', 'person A: the board''s link queued');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','careers-datadog-8257324','Datadog',
 'https://careers.example.test/jobs?gh_jid=8257324')) ~ 'duplicate_job',
 'person A again, by the employer''s careers page with gh_jid and another job id: refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','gh-embed-token-8257324','Datadog',
 'https://boards.greenhouse.io/embed/job_app?for=datadog&token=8257324')) ~ 'duplicate_job',
 'person A again, by the embedded form''s token: refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','greenhouse:datadog:8257325','Datadog',
 'https://careers.example.test/jobs?gh_jid=8257325')) = 'queued', 'person A: another Datadog job by gh_jid: queued');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd002','careers-datadog-8257324','Datadog',
 'https://careers.example.test/jobs?gh_jid=8257324')) = 'queued', 'person B, the same posting person A applied to: queued');
select t.ok(public.career_apply_posting_sent('00000000-0000-4000-8000-0000000fd001', 'some-other-id', 'https://careers.datadoghq.com/detail/?gh_jid=8257324', null, true)
 and not public.career_apply_posting_sent('00000000-0000-4000-8000-0000000fd001', 'some-other-id', 'https://careers.datadoghq.com/detail/?gh_jid=1', null, true),
 'the one ledger every prepare and Submit claim reads: the same posting by the careers page is in flight; another is not');
-- Lever and Ashby by their step links.
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','lever:cesiumastro:a49693f9','CesiumAstro',
 'https://jobs.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce')) = 'queued'
 and pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','lever-eu-copy','CesiumAstro',
 'https://jobs.eu.lever.co/cesiumastro/a49693f9-2066-43b3-972a-cdd3a62fbbce/apply')) ~ 'duplicate_job',
 'Lever: the EU host''s apply step of a queued posting: refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','ashby:openai:8fb1615c','OpenAI',
 'https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3/application')) = 'queued'
 and pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fd001','ashby-copy','OpenAI',
 'https://jobs.ashbyhq.com/OpenAI/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3?utm_source=alert')) ~ 'duplicate_job',
 'Ashby: the posting page of a queued application step: refused as a duplicate');

-- ------------------------------------------------------------------------------------------- the rebuilt index
set local enable_seqscan = off;
select t.ok((select count(*) from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000000fd001'
 and career_apply_posting_key(url) = career_apply_posting_key('https://careers.example.test/jobs?gh_jid=8257324')) = 1,
 'read through the index, the careers-page link finds the board''s row');
reset enable_seqscan;
rollback;
