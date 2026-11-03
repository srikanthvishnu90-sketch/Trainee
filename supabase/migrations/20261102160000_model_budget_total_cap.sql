-- One shared TOTAL model budget with two thresholds (owner, 2026-11-02 18:38 and 18:52 CT): Trainee is Claude-only and the whole
-- release+test cycle has a spend TARGET of $70 and an absolute HARD MAX of $100, across production AND evals, every day.
--
--   target (MODEL_BUDGET_TARGET_USD, default 70)  at 80% of it a warning is raised (founder_alerts model_budget_target_warning, and
--                                                 reserve answers warn); at 100% a loud alert is raised (model_budget_target_exceeded,
--                                                 over_target) but production traffic keeps being served. Eval and test runners read
--                                                 model_budget_total_status and REFUSE to start any new run (model_budget.ts assertRunMayStart).
--   hard   (MODEL_BUDGET_HARD_USD,   default 100) a reservation counts toward it BEFORE the call (spent + reserved + this call <= hard,
--                                                 serialized by one advisory lock, so concurrent callers cannot both take the last dollar).
--                                                 When spent + reserved reaches it, the settings row 'paused' is set to true: every model
--                                                 call is refused (reason 'paused') until the owner raises the hard max and sets it false.
--
-- model_budget_reserve gains two optional arguments. With p_hard_limit_micros NULL it is the 2026-10-28 per-day behavior, untouched
-- (windows, one row per approved day). With it set, the budget is the SUM over every model_budget_days row (the old days stay as
-- history, so nothing already spent is forgotten); there is no window and no per-day limit: the day's row is created if missing with
-- limit = hard, only to hold that day's spent and reserved micros. Both limits come from the caller (the environment variables above).
-- Service role only, as every function in this family. Applied twice is a no-op.
create table if not exists public.founder_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  user_id uuid null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.founder_alerts enable row level security;
-- One alert per kind, ever (until the owner deletes the row to re-arm it).
drop index if exists public.founder_alerts_model_budget_total_once;
create unique index founder_alerts_model_budget_total_once on public.founder_alerts (kind)
  where kind in ('model_budget_target_warning', 'model_budget_target_exceeded', 'model_budget_hard_stop');

-- Replace the 4-argument reserve (a new default-argument overload would make a 4-argument call ambiguous).
drop function if exists public.model_budget_reserve(bigint, text, text, timestamptz);
create or replace function public.model_budget_reserve(p_micros bigint, p_model text default null, p_role text default null, p_now timestamptz default now(),
  p_target_limit_micros bigint default null, p_hard_limit_micros bigint default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare d date; ws timestamptz; we timestamptz; rec record; rid uuid; paused text; t bigint; after_t bigint;
begin
  if p_micros is null or p_micros <= 0 then raise exception 'a reservation must be a positive number of micro-dollars'; end if;
  select lower(value) into paused from public.model_budget_settings where key = 'paused';
  if paused is not null and paused not in ('true', 'false', '1', '0', 'yes', 'no', 'on', 'off') then raise exception 'model budget setting paused is not true or false'; end if;
  if paused in ('true', '1', 'yes', 'on') then
    insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_paused', null, jsonb_build_object('day', public.model_budget_day(p_now)::text))
      on conflict (kind, (detail ->> 'day')) where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed') do nothing;
    return jsonb_build_object('ok', false, 'state', 'paused');
  end if;
  if p_hard_limit_micros is not null then
    -- ---- total mode: target and hard limits across every day ----
    if p_target_limit_micros is null or p_target_limit_micros <= 0 or p_hard_limit_micros < p_target_limit_micros then
      raise exception 'the target limit must be positive and no more than the hard limit';
    end if;
    perform pg_advisory_xact_lock(hashtext('model_budget_total'));
    perform public.model_budget_expire(p_now);
    d := public.model_budget_day(p_now);
    insert into public.model_budget_days (day, limit_micros) values (d, p_hard_limit_micros)
      on conflict (day) do update set limit_micros = greatest(public.model_budget_days.limit_micros, excluded.limit_micros);
    select coalesce(sum(spent_micros + reserved_micros), 0) into t from public.model_budget_days;
    if t + p_micros > p_hard_limit_micros then
      insert into public.founder_alerts (kind, user_id, detail)
        values ('model_budget_hard_stop', null, jsonb_build_object('total_micros', t, 'asked_micros', p_micros, 'hard_limit_micros', p_hard_limit_micros))
        on conflict (kind) where kind in ('model_budget_target_warning', 'model_budget_target_exceeded', 'model_budget_hard_stop') do nothing;
      if t >= p_hard_limit_micros then
        insert into public.model_budget_settings (key, value) values ('paused', 'true') on conflict (key) do update set value = 'true', updated_at = now();
      end if;
      return jsonb_build_object('ok', false, 'state', 'limit', 'total', t, 'target', p_target_limit_micros, 'limit', p_hard_limit_micros);
    end if;
    update public.model_budget_days set reserved_micros = reserved_micros + p_micros, updated_at = p_now where day = d
      returning spent_micros, reserved_micros, limit_micros into rec;
    insert into public.model_budget_reservations (day, micros, model, role, created_at) values (d, p_micros, p_model, p_role, p_now) returning id into rid;
    after_t := t + p_micros;
    if after_t * 10 >= p_target_limit_micros * 8 then
      insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_target_warning', null, jsonb_build_object('total_micros', after_t, 'target_limit_micros', p_target_limit_micros))
        on conflict (kind) where kind in ('model_budget_target_warning', 'model_budget_target_exceeded', 'model_budget_hard_stop') do nothing;
    end if;
    if after_t >= p_target_limit_micros then
      insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_target_exceeded', null, jsonb_build_object('total_micros', after_t, 'target_limit_micros', p_target_limit_micros, 'hard_limit_micros', p_hard_limit_micros))
        on conflict (kind) where kind in ('model_budget_target_warning', 'model_budget_target_exceeded', 'model_budget_hard_stop') do nothing;
    end if;
    if after_t >= p_hard_limit_micros then
      insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_hard_stop', null, jsonb_build_object('total_micros', after_t, 'hard_limit_micros', p_hard_limit_micros))
        on conflict (kind) where kind in ('model_budget_target_warning', 'model_budget_target_exceeded', 'model_budget_hard_stop') do nothing;
      insert into public.model_budget_settings (key, value) values ('paused', 'true') on conflict (key) do update set value = 'true', updated_at = now();
    end if;
    return jsonb_build_object('ok', true, 'id', rid, 'day', d, 'total', after_t, 'target', p_target_limit_micros, 'limit', p_hard_limit_micros,
      'warn', after_t * 10 >= p_target_limit_micros * 8, 'over_target', after_t >= p_target_limit_micros);
  end if;
  -- ---- per-day mode (2026-10-28), unchanged ----
  perform public.model_budget_expire(p_now);
  ws := public.model_budget_instant('window_start'); we := public.model_budget_instant('window_end');
  if ws is null or we is null or we <= ws then return public.model_budget_closed('no_budget', p_now); end if;
  if p_now < ws then return public.model_budget_closed('before_window', p_now); end if;
  if p_now >= we then return public.model_budget_closed('after_window', p_now); end if;
  d := public.model_budget_day(p_now);
  perform 1 from public.model_budget_days where day = d;
  if not found then return public.model_budget_closed('no_budget', p_now); end if;
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

-- Where the total stands: what an eval or test runner reads before it starts a run, and what model-health reports.
-- state: 'stopped' (spent + reserved at the hard max, or the paused setting is on), 'over_target', 'warning' (80% of target), 'ok'.
create or replace function public.model_budget_total_status(p_target_limit_micros bigint, p_hard_limit_micros bigint) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare t bigint; s bigint; r bigint; paused text; st text;
begin
  if p_target_limit_micros is null or p_target_limit_micros <= 0 or p_hard_limit_micros is null or p_hard_limit_micros < p_target_limit_micros then
    raise exception 'the target limit must be positive and no more than the hard limit';
  end if;
  select coalesce(sum(spent_micros), 0), coalesce(sum(reserved_micros), 0) into s, r from public.model_budget_days;
  t := s + r;
  select lower(value) into paused from public.model_budget_settings where key = 'paused';
  st := case when t >= p_hard_limit_micros or paused in ('true', '1', 'yes', 'on') then 'stopped'
             when t >= p_target_limit_micros then 'over_target'
             when t * 10 >= p_target_limit_micros * 8 then 'warning' else 'ok' end;
  return jsonb_build_object('state', st, 'spent', s, 'reserved', r, 'total', t, 'target', p_target_limit_micros, 'hard', p_hard_limit_micros);
end $$;

revoke all on function public.model_budget_reserve(bigint, text, text, timestamptz, bigint, bigint), public.model_budget_total_status(bigint, bigint) from public, anon, authenticated;
grant execute on function public.model_budget_reserve(bigint, text, text, timestamptz, bigint, bigint), public.model_budget_total_status(bigint, bigint) to service_role;
