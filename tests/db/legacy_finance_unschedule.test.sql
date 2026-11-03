-- scripts/launch/unschedule-legacy-finance.sql: an explicit allowlist. With no `allow`, or an empty one, it removes
-- nothing; with names, it unschedules exactly the jobs with those exact names and nothing else (a similar name, or a
-- command posting to a finance function, is not matched). pg_cron is not in the test cluster, so a stand-in cron.job and
-- cron.unschedule with the same shape are used, all inside one transaction that is rolled back.
\set ON_ERROR_STOP on
\getenv upmore_root UPMORE_ROOT
\set unsched :upmore_root '/scripts/launch/unschedule-legacy-finance.sql'
begin;
do $$ begin assert to_regclass('cron.job') is null, 'precondition: the test cluster has no cron.job'; end $$;
\i :unsched
do $$ begin raise notice 'ok - without pg_cron the file is a no-op'; end $$;

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create function cron.unschedule(job_id bigint) returns boolean language sql as
  $$ delete from cron.job where jobid = job_id returning true $$;
insert into cron.job (jobname, schedule, command) values
  ('job-a', '7 * * * *', $c$select net.http_post(url := 'https://x.supabase.co/functions/v1/agent-proactive')$c$),
  ('job-b', '0 */6 * * *', $c$select net.http_post(url := 'https://x.supabase.co/functions/v1/plaid-sync', headers := '{"Authorization":"Bearer fake-token-test"}')$c$),
  ('job-b-copy', '1 * * * *', $c$select net.http_post(url := 'https://x.supabase.co/functions/v1/plaid-sync?x=1')$c$),
  ('career-ingest', '*/5 * * * *', $c$select net.http_post(url := 'https://x.supabase.co/functions/v1/career-ingest')$c$),
  ('trainee-deliver', '* * * * *', $c$select net.http_post(url := 'https://x.supabase.co/functions/v1/trainee-deliver')$c$);

-- 1. no allow variable: nothing removed
\i :unsched
do $$ begin assert (select count(*) from cron.job) = 5, 'no allow: nothing removed'; raise notice 'ok - no allowlist removes nothing'; end $$;
-- 2. an empty allowlist: nothing removed
\set allow ''
\i :unsched
do $$ begin assert (select count(*) from cron.job) = 5, 'empty allow: nothing removed'; raise notice 'ok - an empty allowlist removes nothing'; end $$;
-- 3. exact names only: job-a and job-b go; job-b-copy (similar name, same command target), career-ingest and trainee-deliver stay
\set allow 'job-a,job-b'
\i :unsched
do $$
declare remaining text;
begin
  select string_agg(jobname, ',' order by jobname) into remaining from cron.job;
  assert remaining = 'career-ingest,job-b-copy,trainee-deliver', format('only the named jobs are removed, got: %s', remaining);
  raise notice 'ok - exactly the named jobs are unscheduled; a similar name and Trainee jobs are kept';
end $$;
-- 4. a name that is not there, run again: nothing more removed
\i :unsched
do $$ begin assert (select count(*) from cron.job) = 3, 'a second run removes nothing more'; raise notice 'ok - a second run is a no-op'; end $$;
rollback;
