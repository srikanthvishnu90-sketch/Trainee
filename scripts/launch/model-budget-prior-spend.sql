-- OWNER-RUN. Records spend the budget ledger never saw, so a day's limit stays a TOTAL (owner, 2026-10-28: "$15 total today").
-- The ledger starts counting when 20261028070000_global_daily_model_budget.sql is applied; anything the key spent earlier that
-- day (any project or tool using the same OpenAI key) is invisible to it. Read the day's figure on the provider's own usage page
-- (platform.openai.com/usage, the America/Chicago date), round UP to the cent, and record it in micro-dollars ($1.23 = 1230000):
--   psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -v day=2026-10-28 -v micros=1230000 -f scripts/launch/model-budget-prior-spend.sql
-- Running it again for the same day REPLACES the figure (it never adds twice). Prints what is left of the day's limit.
\set ON_ERROR_STOP on
select public.model_budget_record_prior_spend(:'day'::date, :'micros'::bigint, 'provider usage page, recorded by the owner');
select day, limit_micros, spent_micros, reserved_micros, limit_micros - spent_micros - reserved_micros as left_micros from public.model_budget_days order by day;
