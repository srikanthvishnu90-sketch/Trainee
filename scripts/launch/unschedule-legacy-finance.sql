-- Unschedule the pg_cron jobs the OWNER names, by exact job name, and nothing else (Q3, 2026-10-28; audit O2, SEC9).
-- It is an explicit allowlist: with no `allow` variable, or an empty one, this file removes NOTHING. A job whose name
-- is not on the list is never touched, whatever its command says. No function, table, row or Vault secret is touched.
-- The live project's cron.job holds legacy finance jobs (upmore-proactive, plaid-sync-6h, cancel-watcher-daily); the
-- owner reads `select jobname, schedule from cron.job` first, then names exactly the ones to stop:
--   psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -v allow=plaid-sync-6h,cancel-watcher-daily -f scripts/launch/unschedule-legacy-finance.sql
-- or through go-live: bash scripts/launch/trainee-go-live.sh ... --unschedule-cron plaid-sync-6h,cancel-watcher-daily
-- Prints job names and schedules only (a command can hold a token). To put one back, re-run its original schedule file.
\set ON_ERROR_STOP on
\if :{?allow}
\else
  \set allow ''
\endif
-- psql does not substitute variables inside a $$ body, so the list goes in through a session setting first.
select set_config('unschedule.allow', :'allow', false) is not null as allow_set \gset
do $$
declare
  j record;
  names text[] := array(select btrim(x) from unnest(string_to_array(current_setting('unschedule.allow'), ',')) x where btrim(x) <> '');
  n int := 0;
begin
  if to_regclass('cron.job') is null then
    raise notice 'unschedule: pg_cron is not installed, nothing removed';
    return;
  end if;
  if coalesce(array_length(names, 1), 0) = 0 then
    raise notice 'unschedule: no job named, nothing removed';
  else
    for j in select jobid, jobname from cron.job where jobname = any (names) order by jobid loop
      perform cron.unschedule(j.jobid);
      raise notice 'unscheduled: % (job %)', j.jobname, j.jobid;
      n := n + 1;
    end loop;
    raise notice 'unscheduled % of % named', n, array_length(names, 1);
  end if;
  for j in select jobname, schedule from cron.job order by jobname loop
    raise notice 'schedule kept: % (%)', coalesce(j.jobname, '(unnamed)'), j.schedule;
  end loop;
end
$$;
