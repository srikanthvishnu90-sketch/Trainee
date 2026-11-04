-- Table hygiene schedules (scale-90k bottleneck 8; migration 20261102180000_delivery_throughput.sql must be applied first).
-- Plain SQL jobs: no function call over the network and no secret. Run by the OWNER only:
--   psql "$SUPABASE_DB_URL" -f scripts/launch/schedule-outbox-retention.sql
-- 1. trainee-outbox-retention: nightly (07:00-09:55 UTC, every 5 minutes, i.e. the small hours in Chicago) deletes finished career_outbox
--    rows older than 30 days, up to 10 batches of 5,000 per call (career_outbox_purge); a backlog drains over a few nights, never in one
--    long transaction. Queued, sending, held and retrying rows are never touched.
-- 2. trainee-rate-bucket-prune: every 15 minutes drops Telegram chat buckets idle for 10 minutes (channel_rate_buckets_prune).
-- Re-running replaces both. Health: select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'trainee-outbox%') order by start_time desc limit 5;
\set ON_ERROR_STOP on
create extension if not exists pg_cron;
select cron.unschedule(jobname) from cron.job where jobname in ('trainee-outbox-retention', 'trainee-rate-bucket-prune');
select cron.schedule('trainee-outbox-retention', '*/5 7-9 * * *', $job$select public.career_outbox_purge(interval '30 days', 5000, 10)$job$);
select cron.schedule('trainee-rate-bucket-prune', '*/15 * * * *', $job$select public.channel_rate_buckets_prune(interval '10 minutes')$job$);
select jobname, schedule from cron.job where jobname in ('trainee-outbox-retention', 'trainee-rate-bucket-prune') order by jobname;
