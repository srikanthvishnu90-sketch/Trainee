-- Reverses 20261102160000_model_budget_total_cap.sql: the total-mode alerts and status function go, and the 4-argument per-day
-- reserve of 20261028070000 is restored. Spend already recorded in model_budget_days is untouched.
drop function if exists public.model_budget_total_status(bigint, bigint);
drop function if exists public.model_budget_reserve(bigint, text, text, timestamptz, bigint, bigint);
drop index if exists public.founder_alerts_model_budget_total_once;
-- Restored 4-argument reserve (copied from 20261028070000). Reserve a worst-case cost. Returns {ok:true, id, day, spent, reserved, limit} or {ok:false, state:
-- 'limit' | 'paused' | 'before_window' | 'after_window' | 'no_budget', ...}.
create or replace function public.model_budget_reserve(p_micros bigint, p_model text default null, p_role text default null, p_now timestamptz default now())
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare d date; ws timestamptz; we timestamptz; rec record; rid uuid; paused text;
begin
  if p_micros is null or p_micros <= 0 then raise exception 'a reservation must be a positive number of micro-dollars'; end if;
  select lower(value) into paused from public.model_budget_settings where key = 'paused';
  if paused is not null and paused not in ('true', 'false', '1', '0', 'yes', 'no', 'on', 'off') then raise exception 'model budget setting paused is not true or false'; end if;
  if paused in ('true', '1', 'yes', 'on') then
    insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_paused', null, jsonb_build_object('day', public.model_budget_day(p_now)::text))
      on conflict (kind, (detail ->> 'day')) where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed') do nothing;
    return jsonb_build_object('ok', false, 'state', 'paused');
  end if;
  perform public.model_budget_expire(p_now);
  -- The window. Nothing before it can be spent early; nothing after it is spent without a new approved budget.
  ws := public.model_budget_instant('window_start'); we := public.model_budget_instant('window_end');
  if ws is null or we is null or we <= ws then return public.model_budget_closed('no_budget', p_now); end if;
  if p_now < ws then return public.model_budget_closed('before_window', p_now); end if;
  if p_now >= we then return public.model_budget_closed('after_window', p_now); end if;
  -- The budget row of the Chicago day the call is made on must already exist (each day its own owner-approved limit). Code never
  -- creates one.
  d := public.model_budget_day(p_now);
  perform 1 from public.model_budget_days where day = d;
  if not found then return public.model_budget_closed('no_budget', p_now); end if;
  -- The one statement that decides. A concurrent caller waits on the row lock, then re-checks the WHERE against the new totals.
  update public.model_budget_days set reserved_micros = reserved_micros + p_micros, updated_at = p_now
    where day = d and spent_micros + reserved_micros + p_micros <= limit_micros
    returning spent_micros, reserved_micros, limit_micros into rec;
  if not found then
    select spent_micros, reserved_micros, limit_micros into rec from public.model_budget_days where day = d;
    insert into public.founder_alerts (kind, user_id, detail)
      values ('model_budget_exhausted', null, jsonb_build_object('day', d::text, 'limit_micros', rec.limit_micros, 'spent_micros', rec.spent_micros, 'reserved_micros', rec.reserved_micros, 'asked_micros', p_micros))
      on conflict (kind, (detail ->> 'day')) where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed') do nothing;
    return jsonb_build_object('ok', false, 'state', 'limit', 'day', d, 'spent', rec.spent_micros, 'reserved', rec.reserved_micros, 'limit', rec.limit_micros);
  end if;
  insert into public.model_budget_reservations (day, micros, model, role, created_at) values (d, p_micros, p_model, p_role, p_now) returning id into rid;
  return jsonb_build_object('ok', true, 'id', rid, 'day', d, 'spent', rec.spent_micros, 'reserved', rec.reserved_micros, 'limit', rec.limit_micros);
end $$;
revoke all on function public.model_budget_reserve(bigint, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.model_budget_reserve(bigint, text, text, timestamptz) to service_role;
