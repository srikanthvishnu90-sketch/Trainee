-- Reverses 20261102180000_delivery_throughput.sql. Nothing it deleted comes back: career_outbox_purge removed finished rows
-- older than 30 days for good (take a backup before the first scheduled run if they matter). The four outbox indexes it
-- kept were never dropped, so there is nothing to recreate. Unschedule first:
--   select cron.unschedule('trainee-outbox-retention'); select cron.unschedule('trainee-rate-bucket-prune');
drop function if exists public.career_outbox_purge(interval, int, int);
drop function if exists public.career_outbox_claim_lane(timestamptz, int, text, int, int);
drop function if exists public.channel_rate_buckets_prune(interval);
drop function if exists public.channel_rate_acquire(text[], double precision[], double precision[], double precision, timestamptz);
drop table if exists public.channel_rate_buckets;
drop index if exists public.career_outbox_due_priority;
drop index if exists public.career_outbox_terminal_old;
drop index if exists public.agent_threads_user_id_idx;
drop index if exists public.agent_tasks_user_id_idx;
drop index if exists public.channel_threads_thread_id_idx;
do $$
declare t text;
begin
  foreach t in array array['career_outbox', 'career_apply_jobs', 'career_apply_cards', 'career_apply_wanted', 'career_watch_kv', 'career_postings'] loop
    continue when to_regclass('public.' || t) is null;
    execute format('alter table public.%I reset (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor)', t);
  end loop;
end $$;
