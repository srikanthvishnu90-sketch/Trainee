-- Owner monitoring schedule: pg_cron calls ops-monitor through pg_net (check every 5 minutes, digest once a day at 13:00 UTC).
-- Run by the OWNER only, after the function deploy and secrets (supabase secrets set OPS_MONITOR_TOKEN=... TELEGRAM_BOT_TOKEN=...
-- OWNER_TELEGRAM_CHAT_ID=...; optional OPS_DAILY_CAP_USD, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF for 5xx counts):
--   OPS_MONITOR_TOKEN=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/ops-monitor -f scripts/launch/schedule-ops-monitor.sql
-- The token lives in Vault and is read at call time and sent in the x-ops-token HEADER only (a ?token= in the URL is refused:
-- Supabase logs record query strings). Re-running replaces both jobs. If an earlier version of this job put the token in the URL,
-- rotate it: set a new OPS_MONITOR_TOKEN secret and run this script again.
\set ON_ERROR_STOP on
\set secret `printf '%s' "$OPS_MONITOR_TOKEN"`
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(:'secret', 'ops_monitor_token', 'ops-monitor scheduler token')
  where not exists (select 1 from vault.secrets where name = 'ops_monitor_token');
select vault.update_secret((select id from vault.secrets where name = 'ops_monitor_token'), :'secret');
select cron.unschedule(jobname) from cron.job where jobname in ('ops-monitor-check', 'ops-monitor-digest');
select cron.schedule('ops-monitor-check', '*/5 * * * *', format($job$
  select net.http_post(url := %L || '?mode=check', headers := jsonb_build_object('x-ops-token', (select decrypted_secret from vault.decrypted_secrets where name = 'ops_monitor_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$job$, :'url'));
select cron.schedule('ops-monitor-digest', '0 13 * * *', format($job$
  select net.http_post(url := %L || '?mode=digest', headers := jsonb_build_object('x-ops-token', (select decrypted_secret from vault.decrypted_secrets where name = 'ops_monitor_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$job$, :'url'));
select jobname, schedule from cron.job where jobname like 'ops-monitor-%';
