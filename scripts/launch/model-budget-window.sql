-- OWNER-RUN, and only for a NEW approved budget. 2026-10-28 ($15) and 2026-10-29 ($20) America/Chicago are already seeded by
-- 20261028070000_global_daily_model_budget.sql, and each call is charged to the Chicago date it is made on, so nothing has to be
-- run at midnight between them. To approve another day, give its date, its total in micro-dollars, and the window end (the
-- next Chicago midnight after the last approved day, with its offset: -05:00 in CDT, -06:00 in CST):
--   psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -v day=2026-10-30 -v micros=20000000 -v end=2026-10-31T00:00:00-05:00 -f scripts/launch/model-budget-window.sql
-- A day's row is created if absent; on an existing row only the limit changes (spent and reserved are kept, never reset). The
-- window start is never moved later than a day that already has a row. Hard cap, fail closed: outside the window, or on a date
-- with no row, every paid call is refused. Prints the rows and the window.
\set ON_ERROR_STOP on
begin;
insert into public.model_budget_days (day, limit_micros) values (:'day'::date, :'micros'::bigint)
  on conflict (day) do update set limit_micros = excluded.limit_micros, updated_at = now();
insert into public.model_budget_settings (key, value) values ('window_end', :'end')
  on conflict (key) do update set value = excluded.value, updated_at = now();
commit;
select day, limit_micros, spent_micros, reserved_micros from public.model_budget_days order by day;
select key, value from public.model_budget_settings where key like 'window_%' order by key;
