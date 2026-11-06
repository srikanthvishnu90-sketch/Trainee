-- The form-capture schedule (WO-121, D-042 M4). pg_cron calls career-form-schema through pg_net once a minute with the
-- CAREER_FORM_SCHEMA_SECRET header. Each call claims up to 600 new Greenhouse, Lever and Ashby postings without a captured
-- form and reads each once (at most 4 in flight per ATS host, 250 ms apart; about 36 reads a minute at 51,681 new
-- postings a day). The secret lives in Vault and is read at call time, so it never appears in the job text, a command line
-- or this file.
-- Run by the OWNER only, after the migration (20261107100000_career_posting_forms.sql) and the function deploy:
--   CAREER_FORM_SCHEMA_SECRET=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/career-form-schema -f scripts/launch/schedule-career-form-schema.sql
-- The same secret must be set on the function (supabase secrets set CAREER_FORM_SCHEMA_SECRET=... INGEST_CONTACT_EMAIL=...).
-- Ashby is read only with the owner's yes (CAREER_FORM_ASHBY_GRAPHQL=on on the function); without it Ashby is not_public.
-- Health (M4): select * from public.career_form_readiness(interval '24 hours');
-- Re-running replaces the job and the secret.
\set ON_ERROR_STOP on
\set secret `printf '%s' "$CAREER_FORM_SCHEMA_SECRET"`
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(:'secret', 'trainee_career_form_schema_secret', 'career-form-schema scheduler header')
  where not exists (select 1 from vault.secrets where name = 'trainee_career_form_schema_secret');
select vault.update_secret((select id from vault.secrets where name = 'trainee_career_form_schema_secret'), :'secret');
select cron.unschedule(jobname) from cron.job where jobname = 'trainee-career-form-schema';
select cron.schedule('trainee-career-form-schema', '* * * * *', format($job$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-trainee-form-schema-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'trainee_career_form_schema_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000)
$job$, :'url'));
select jobname, schedule from cron.job where jobname = 'trainee-career-form-schema';
