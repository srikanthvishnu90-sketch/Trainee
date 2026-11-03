-- ACK FAST (CHAT_QUEUE): pg_cron calls trainee-turn-worker through pg_net every minute with the TRAINEE_TURN_SECRET header. It claims
-- what the webhooks queued (and what a crashed or timed-out turn left), and once a minute removes old finished rows. The secret lives
-- in Vault and is read at call time, so it never appears in the job text, a command line or this file. Run by the OWNER only, after the
-- migration (20261102170000) and the function deploy:
--   TRAINEE_TURN_SECRET=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/trainee-turn-worker -f scripts/launch/schedule-trainee-turn-worker.sql
-- The same secret must be set on the functions (supabase secrets set TRAINEE_TURN_SECRET=...); CHAT_QUEUE=on is a separate switch, set last.
-- Scheduling it with CHAT_QUEUE off is harmless: it finds nothing. Re-running replaces the job and the secret.
-- Health: select * from public.inbound_turn_health();  failed rows: select id, last_error, created_at from public.inbound_turn_queue where status = 'failed';
\set ON_ERROR_STOP on
\set secret `printf '%s' "$TRAINEE_TURN_SECRET"`
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(:'secret', 'trainee_turn_secret', 'trainee-turn-worker scheduler header')
  where not exists (select 1 from vault.secrets where name = 'trainee_turn_secret');
select vault.update_secret((select id from vault.secrets where name = 'trainee_turn_secret'), :'secret');
select cron.unschedule('trainee-turn-worker') where exists (select 1 from cron.job where jobname = 'trainee-turn-worker');
select cron.schedule('trainee-turn-worker', '* * * * *', format($job$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-trainee-turn-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'trainee_turn_secret')),
    body := '{"cron": true, "limit": 10}'::jsonb,
    timeout_milliseconds := 140000)
$job$, :'url'));
select jobname, schedule from cron.job where jobname = 'trainee-turn-worker';
