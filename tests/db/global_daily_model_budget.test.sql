-- SQL tests for 20261028070000_global_daily_model_budget.sql. The concurrency proof (200 simultaneous reservations against $20)
-- is tests/architect/global-daily-budget.test.ts, which needs real parallel sessions; this file checks the single-session rules.
-- The budget (owner, 2026-10-28): $15 for 2026-10-28 and $20 for 2026-10-29 America/Chicago, each day its own row; the test passes
-- the instant it asks at (p_now).
begin;
reset role;
set role service_role;
select t.ok((select string_agg(day::text || '=' || limit_micros, ',' order by day) = '2026-10-28=15000000,2026-10-29=20000000' from public.model_budget_days), 'the migration made exactly the two owner-approved rows: 10-28 $15, 10-29 $20');
select t.ok((public.model_budget_reserve(1, 'gpt-5', 'chat', '2026-10-28T04:59:59Z') ->> 'state') = 'before_window', '10-27 23:59:59 Chicago is refused');
select t.ok((public.model_budget_reserve(15000001, 'gpt-5', 'chat', '2026-10-29T04:59:59Z') ->> 'state') = 'limit', '10-28 23:59:59 Chicago is the $15 day: one micro-dollar over it is refused');
select t.ok((public.model_budget_reserve(15000000, 'gpt-5', 'chat', '2026-10-28T05:00:00Z') ->> 'ok')::boolean, '10-28 00:00:00 Chicago: the whole $15 fits');
select t.ok((public.model_budget_reserve(1, 'gpt-5', 'chat', '2026-10-30T05:00:00Z') ->> 'state') = 'after_window', '10-30 00:00:00 Chicago is refused');
select t.ok((public.model_budget_reserve(15000000, 'gpt-5', 'chat', '2026-10-29T05:00:00Z') ->> 'ok')::boolean, '10-29 00:00:00 Chicago is allowed');
select t.ok((public.model_budget_reserve(5000001, 'gpt-5', 'chat', '2026-10-29T05:00:30Z') ->> 'state') = 'limit', 'one micro-dollar over the limit is refused');
select t.ok((public.model_budget_reserve(5000000, 'gpt-5', 'chat', '2026-10-29T05:00:30Z') ->> 'ok')::boolean, 'an exact fit is granted');
select t.ok((select spent_micros = 0 and reserved_micros = 20000000 from public.model_budget_days where day = '2026-10-29'), 'the day holds reserved + spent, never more than the limit');
select t.ok((select count(*) = 1 from public.founder_alerts where kind = 'model_budget_exhausted' and detail ->> 'day' = '2026-10-29'), 'the first refusal at the 10-29 limit wrote one alert for that day');
select public.model_budget_reserve(1, null, null, '2026-10-29T05:00:30Z');
select t.ok((select count(*) = 1 from public.founder_alerts where kind = 'model_budget_exhausted' and detail ->> 'day' = '2026-10-29'), 'a second refusal writes no second alert');
select t.ok((select count(*) = 2 from public.model_budget_days), 'no refusal created a budget row');
select t.ok((select spent_micros + reserved_micros = 15000000 from public.model_budget_days where day = '2026-10-28'), 'the 10-28 day is its own: its $15 (spent once past the TTL) was not touched by 10-29');
-- A missing usage record keeps the whole reservation as spent.
select public.model_budget_settle(id) from public.model_budget_reservations where micros = 15000000 and day = '2026-10-29';
select t.ok((select spent_micros = 15000000 and reserved_micros = 5000000 from public.model_budget_days where day = '2026-10-29'), 'settling without a proven cost keeps the whole worst case as spent');
select t.must_fail($$select public.model_budget_reserve(0)$$, 'positive', 'a zero reservation is an error');
-- Spend the ledger never saw (the owner's figure from the provider's usage page) counts against the day's total, once.
select t.ok((public.model_budget_record_prior_spend('2026-10-29', 1230000) ->> 'prior_spend')::bigint = 1230000, 'prior spend recorded');
select t.ok((select spent_micros = 16230000 from public.model_budget_days where day = '2026-10-29'), 'it is added to the day''s spent');
select public.model_budget_record_prior_spend('2026-10-29', 2000000);
select t.ok((select spent_micros = 17000000 from public.model_budget_days where day = '2026-10-29'), 'recording again replaces the figure, never adds twice');
select public.model_budget_record_prior_spend('2026-10-29', 0);
select t.ok((select spent_micros = 15000000 from public.model_budget_days where day = '2026-10-29'), 'zero takes it back out');
select t.ok((select count(*) = 1 from public.model_budget_reservations where role = 'prior_spend'), 'one prior-spend row per day, kept for the record');
select t.must_fail($$select public.model_budget_record_prior_spend('2026-12-25', 1)$$, 'no approved budget row', 'a day with no approved budget is refused');
select t.must_fail($$select public.model_budget_record_prior_spend('2026-10-29', -1)$$, 'zero or a positive', 'a negative figure is refused');
reset role;
set role authenticated;
select t.must_fail($$select public.model_budget_reserve(1)$$, 'permission denied', 'a signed-in person cannot reserve');
select t.must_fail($$select * from public.model_budget_days$$, 'permission denied', 'a signed-in person cannot read the days');
select t.must_fail($$select public.model_budget_record_prior_spend('2026-10-28', 1)$$, 'permission denied', 'a signed-in person cannot record spend');
reset role;
rollback;
