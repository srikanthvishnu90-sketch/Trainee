-- Every user turn leaves one cost row (2026-10-28). Until now a turn that made no model call left no row, so "no row" could
-- mean "no spend" or "the write never happened", and nothing told them apart. Now:
--   meter_state = 'metered'    calls is the number of model calls the turn made, 0 included;
--   meter_state = 'unrecorded' the sink was missing or refused the write: calls is NULL (unknown), never 0.
-- Existing rows are all 'metered' (the default). Code (not this migration) writes the rows: _shared/model_gateway.ts turnLedger.
alter table public.agent_turn_costs add column if not exists meter_state text not null default 'metered'
  check (meter_state in ('metered', 'unrecorded'));
alter table public.agent_turn_costs alter column calls drop not null;
alter table public.agent_turn_costs drop constraint if exists agent_turn_costs_state_calls;
alter table public.agent_turn_costs add constraint agent_turn_costs_state_calls
  check ((meter_state = 'metered' and calls is not null) or (meter_state = 'unrecorded' and calls is null));

-- The daily view keeps its columns and gains one at the end: the turns whose calls are unknown. model_calls counts
-- the known calls only, so a day with unrecorded_turns > 0 is a lower bound, not a total.
create or replace view public.agent_daily_costs with (security_invoker = true) as
  select user_id, (created_at at time zone 'UTC')::date as day, count(*) as turns, sum(calls) as model_calls,
         sum(failed) as failed_calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
         sum(usd_micros) as usd_micros, round(sum(usd_micros) / 1000000.0, 6) as usd, sum(unpriced) as unpriced_calls,
         count(*) filter (where meter_state = 'unrecorded') as unrecorded_turns
  from public.agent_turn_costs group by user_id, (created_at at time zone 'UTC')::date;
grant select on public.agent_daily_costs to authenticated, service_role;
