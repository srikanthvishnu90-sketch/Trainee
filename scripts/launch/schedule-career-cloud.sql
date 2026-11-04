-- The cloud runner's two ticks (F-RUNNER, FEATURE 17; docs/launch/CLOUD-RUNNER.md): pg_cron calls career-cloud-runner
-- through pg_net every minute, /dispatch (sending approved applications) and /prepare-dispatch (preparing the cards people
-- asked for), each with the CLOUD_DISPATCH_SECRET header. The secret lives in Vault and is read at call time, so it never
-- appears in a job's text, a command line or this file. Run by the OWNER only (scripts/launch/trainee-go-live.sh step 5):
--   CLOUD_DISPATCH_SECRET=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/career-cloud-runner -f scripts/launch/schedule-career-cloud.sql
-- The same secret must be set on the function. Re-running replaces both jobs and the secret. Off: unset
-- CLOUD_RUNNER_ENABLED / CLOUD_PREPARE_ENABLED (each tick then answers "skipped"), or unschedule:
--   select cron.unschedule('career-cloud-dispatch'); select cron.unschedule('career-cloud-prepare-dispatch');
\set ON_ERROR_STOP on
\set secret `printf '%s' "$CLOUD_DISPATCH_SECRET"`
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(:'secret', 'career_cloud_dispatch_secret', 'career-cloud-runner scheduler header')
  where not exists (select 1 from vault.secrets where name = 'career_cloud_dispatch_secret');
select vault.update_secret((select id from vault.secrets where name = 'career_cloud_dispatch_secret'), :'secret');
select cron.unschedule('career-cloud-dispatch') where exists (select 1 from cron.job where jobname = 'career-cloud-dispatch');
select cron.unschedule('career-cloud-prepare-dispatch') where exists (select 1 from cron.job where jobname = 'career-cloud-prepare-dispatch');
select cron.schedule('career-cloud-dispatch', '* * * * *', format($job$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-cloud-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'career_cloud_dispatch_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000)
$job$, :'url' || '/dispatch'));
select cron.schedule('career-cloud-prepare-dispatch', '* * * * *', format($job$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-cloud-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'career_cloud_dispatch_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000)
$job$, :'url' || '/prepare-dispatch'));
select jobname, schedule from cron.job where jobname in ('career-cloud-dispatch', 'career-cloud-prepare-dispatch') order by jobname;
