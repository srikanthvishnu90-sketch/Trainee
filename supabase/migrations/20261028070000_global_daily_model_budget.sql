-- A hard, global model budget per Chicago day (owner, 2026-10-28, in writing): "Today's testing limit is $15 total; tomorrow,
-- October 29 Chicago time, is $20 total", across all testers, and "count missing-cost turns at worst-case price against the
-- budget". Paid calls can't exceed a day's total, including concurrent calls and missing cost records. Not a recurring allowance.
--
-- The budget is a window and one row per approved day:
--   model_budget_settings  window_start / window_end are instants (ISO 8601 with an offset), seeded 2026-10-28T00:00 to
--                          2026-10-30T00:00 America/Chicago (-05:00, CDT).
--   model_budget_days      one row per approved Chicago date, each with its own limit_micros and its spent and reserved
--                          micro-dollars: 2026-10-28 $15, 2026-10-29 $20. THIS MIGRATION CREATES THEM; no function ever inserts
--                          a row. A new budget exists only when the owner approves one and an owner-run statement inserts its row
--                          and moves the window settings. A call is charged to the Chicago date it is reserved on.
-- A reservation outside [window_start, window_end), or inside it on a date with no approved row, is refused: before the window
-- nothing can be spent early, after it nothing is spent until the owner approves a new budget (no automatic rollover).
--
-- Code (_shared/model_budget.ts, called from _shared/model_gateway.ts callModel) works like this around every paid call:
--   reserve   model_budget_reserve(worst-case micros): ONE UPDATE ... WHERE spent + reserved + x <= limit RETURNING. Row locks
--             serialize concurrent callers and Postgres re-checks the WHERE after the lock wait, so two callers can never both
--             take the last dollar. No read-then-write. A reservation that does not fit makes no row and no call.
--   settle    model_budget_settle(id, actual): moves the reservation to spent at the proven actual cost. actual NULL (usage
--             missing or unparseable, model unpriced, the call's outcome unknown) keeps the FULL worst-case as spent.
--   release   model_budget_release(id): only for a proven no-call. Returns the reservation to the day.
--   expire    model_budget_expire(): a reservation still open after the TTL (a crashed worker) becomes spent at its
--             worst-case. Never a refund. Runs at the start of every reserve.
--
-- Every function is SECURITY INVOKER and service_role only: tables are RLS-on with no policy. A function that errors raises;
-- the caller then makes no paid call (fail closed). The first refusal of each kind on a Chicago date writes one founder_alerts row.
-- founder_alerts is created by 20260927_000006 (the same columns); this is a no-op wherever that has run, and keeps this file
-- applying on a schema that has not (the migration rehearsal's live-shaped base).
create table if not exists public.founder_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  user_id uuid null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.founder_alerts enable row level security;
create table if not exists public.model_budget_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into public.model_budget_settings (key, value) values
  ('paused', 'false'), ('reservation_ttl_seconds', '900'),
  ('window_start', '2026-10-28T00:00:00-05:00'), ('window_end', '2026-10-30T00:00:00-05:00')
  on conflict (key) do nothing;

create table if not exists public.model_budget_days (
  day date primary key,
  limit_micros bigint not null check (limit_micros >= 0),
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The one budget row, created here and nowhere else (the owner's approval of the 2026-10-29 budget).
-- Owner, 2026-10-28 (in writing): $15 total for 2026-10-28 (testing) and $20 total for 2026-10-29 (the beta day), America/Chicago.
-- Each day is its own row with its own limit; nothing carries from one day to the next.
insert into public.model_budget_days (day, limit_micros) values ('2026-10-28', 15000000), ('2026-10-29', 20000000) on conflict (day) do nothing;

create table if not exists public.model_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  day date not null references public.model_budget_days(day),
  micros bigint not null check (micros > 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released', 'expired')),
  cost_known boolean,
  actual_micros bigint check (actual_micros >= 0),
  model text,
  role text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists model_budget_reservations_open_idx on public.model_budget_reservations (created_at) where status = 'reserved';

alter table public.model_budget_settings enable row level security;
alter table public.model_budget_days enable row level security;
alter table public.model_budget_reservations enable row level security;
revoke all on public.model_budget_settings, public.model_budget_days, public.model_budget_reservations from public, anon, authenticated;
grant select on public.model_budget_settings to service_role;
grant select, insert, update on public.model_budget_days, public.model_budget_reservations to service_role;

-- One alert per kind per Chicago day, whatever the concurrency: the unique index decides.
drop index if exists public.founder_alerts_model_budget_once;
create unique index if not exists founder_alerts_model_budget_once on public.founder_alerts (kind, (detail ->> 'day'))
  where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed');

-- The Chicago calendar date of an instant. 2026-11-01 (fall back) has 25 hours and one date; the zone rules decide.
create or replace function public.model_budget_day(p_at timestamptz default now()) returns date
language sql stable set search_path = pg_catalog, pg_temp as $$ select (p_at at time zone 'America/Chicago')::date $$;

-- A setting as a non-negative integer; a missing row is the default, a malformed one RAISES (fail closed).
create or replace function public.model_budget_int(p_key text, p_default bigint) returns bigint
language plpgsql stable set search_path = public, pg_temp as $$
declare v text;
begin
  select value into v from public.model_budget_settings where key = p_key;
  if not found then return p_default; end if;
  if v !~ '^[0-9]{1,15}$' then raise exception 'model budget setting % is not a non-negative integer', p_key; end if;
  return v::bigint;
end $$;

-- A setting as an instant: ISO 8601 with an explicit offset or Z. Missing row = NULL (no budget); malformed RAISES.
create or replace function public.model_budget_instant(p_key text) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
declare v text;
begin
  select value into v from public.model_budget_settings where key = p_key;
  if not found then return null; end if;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'model budget setting % is not an ISO 8601 instant with an offset', p_key;
  end if;
  return v::timestamptz;
end $$;

-- Stuck reservations become spent at their worst case. One statement; skip-locked so concurrent callers never wait on it.
create or replace function public.model_budget_expire(p_now timestamptz default now()) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
  with stale as (
    select id from public.model_budget_reservations
    where status = 'reserved' and created_at < p_now - make_interval(secs => greatest(120, public.model_budget_int('reservation_ttl_seconds', 900)))
    order by id for update skip locked),
  gone as (
    update public.model_budget_reservations r set status = 'expired', cost_known = false, actual_micros = r.micros, closed_at = p_now
    from stale where r.id = stale.id returning r.day, r.micros),
  per_day as (select day, sum(micros) as m from gone group by day),
  moved as (
    update public.model_budget_days d set reserved_micros = d.reserved_micros - p.m, spent_micros = d.spent_micros + p.m, updated_at = p_now
    from per_day p where d.day = p.day returning 1)
  select count(*) into n from gone;
  return n;
end $$;

-- A refusal because the budget is not open (before the window, after it, or no row for it): one alert a Chicago day.
create or replace function public.model_budget_closed(p_state text, p_now timestamptz) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_closed', null, jsonb_build_object('day', public.model_budget_day(p_now)::text, 'state', p_state))
    on conflict (kind, (detail ->> 'day')) where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed') do nothing;
  return jsonb_build_object('ok', false, 'state', p_state);
end $$;

-- Reserve a worst-case cost. Returns {ok:true, id, day, spent, reserved, limit} or {ok:false, state:
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

-- Settle to the actual cost. NULL actual (not proven) keeps the whole worst case as spent. Idempotent: only an open
-- reservation moves, so a second settle (or one after expiry) changes nothing. Not gated by the window: a call reserved
-- inside the window is accounted for on its row even if it finishes after the window closed.
create or replace function public.model_budget_settle(p_id uuid, p_actual_micros bigint default null, p_now timestamptz default now()) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare r record;
begin
  if p_actual_micros is not null and p_actual_micros < 0 then raise exception 'actual cost cannot be negative'; end if;
  update public.model_budget_reservations set status = 'settled', cost_known = (p_actual_micros is not null),
      actual_micros = coalesce(p_actual_micros, micros), closed_at = p_now
    where id = p_id and status = 'reserved' returning day, micros, actual_micros into r;
  if not found then return jsonb_build_object('ok', false, 'state', 'not_open'); end if;
  update public.model_budget_days set reserved_micros = reserved_micros - r.micros, spent_micros = spent_micros + r.actual_micros, updated_at = p_now where day = r.day;
  if r.actual_micros > r.micros then
    insert into public.founder_alerts (kind, user_id, detail) values ('model_budget_overrun', null, jsonb_build_object('day', r.day::text, 'reserved_micros', r.micros, 'actual_micros', r.actual_micros))
      on conflict (kind, (detail ->> 'day')) where kind in ('model_budget_exhausted', 'model_budget_paused', 'model_budget_overrun', 'model_budget_closed') do nothing;
  end if;
  return jsonb_build_object('ok', true, 'spent', r.actual_micros);
end $$;

-- Give a reservation back. Only for a proven no-call.
create or replace function public.model_budget_release(p_id uuid, p_now timestamptz default now()) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare r record;
begin
  update public.model_budget_reservations set status = 'released', cost_known = true, actual_micros = 0, closed_at = p_now
    where id = p_id and status = 'reserved' returning day, micros into r;
  if not found then return jsonb_build_object('ok', false, 'state', 'not_open'); end if;
  update public.model_budget_days set reserved_micros = reserved_micros - r.micros, updated_at = p_now where day = r.day;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.model_budget_day(timestamptz), public.model_budget_int(text, bigint), public.model_budget_instant(text),
  public.model_budget_expire(timestamptz), public.model_budget_closed(text, timestamptz),
  public.model_budget_reserve(bigint, text, text, timestamptz), public.model_budget_settle(uuid, bigint, timestamptz),
  public.model_budget_release(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.model_budget_day(timestamptz), public.model_budget_int(text, bigint), public.model_budget_instant(text),
  public.model_budget_expire(timestamptz), public.model_budget_closed(text, timestamptz),
  public.model_budget_reserve(bigint, text, text, timestamptz), public.model_budget_settle(uuid, bigint, timestamptz),
  public.model_budget_release(uuid, timestamptz) to service_role;

-- Spend the ledger never saw (owner, 2026-10-28: "$15 TOTAL today", and the ledger starts when this migration is applied):
-- the owner reads the provider's own usage page for a day and records that amount once, so the day's limit is a total, not a
-- fresh allowance. It is one settled row (role 'prior_spend') per day, so the books still balance; recording again REPLACES
-- that day's figure (never adds twice) and can only raise or lower it to what the owner states. Service role only; owner-run
-- through scripts/launch/model-budget-prior-spend.sql.
create or replace function public.model_budget_record_prior_spend(p_day date, p_micros bigint, p_source text default 'provider usage page')
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare old bigint; rec record;
begin
  if p_micros is null or p_micros < 0 then raise exception 'prior spend must be zero or a positive number of micro-dollars'; end if;
  perform 1 from public.model_budget_days where day = p_day for update;
  if not found then raise exception 'no approved budget row for %', p_day; end if;
  -- The day's one prior-spend row, updated in place (rows are never deleted): settled at the stated figure, or released at zero.
  select coalesce(sum(actual_micros) filter (where status = 'settled'), 0) into old from public.model_budget_reservations where day = p_day and role = 'prior_spend';
  update public.model_budget_reservations set status = 'released', actual_micros = null, closed_at = now() where day = p_day and role = 'prior_spend';
  if p_micros > 0 then
    update public.model_budget_reservations set status = 'settled', micros = p_micros, actual_micros = p_micros, cost_known = true,
        model = left(coalesce(p_source, 'provider usage page'), 200), closed_at = now()
      where id = (select id from public.model_budget_reservations where day = p_day and role = 'prior_spend' order by created_at limit 1);
    if not found then
      insert into public.model_budget_reservations (day, micros, status, cost_known, actual_micros, model, role, closed_at)
        values (p_day, p_micros, 'settled', true, p_micros, left(coalesce(p_source, 'provider usage page'), 200), 'prior_spend', now());
    end if;
  end if;
  update public.model_budget_days set spent_micros = spent_micros - old + p_micros, updated_at = now() where day = p_day
    returning spent_micros, reserved_micros, limit_micros into rec;
  return jsonb_build_object('day', p_day, 'prior_spend', p_micros, 'spent', rec.spent_micros, 'reserved', rec.reserved_micros, 'limit', rec.limit_micros,
    'left', greatest(0, rec.limit_micros - rec.spent_micros - rec.reserved_micros));
end $$;
revoke all on function public.model_budget_record_prior_spend(date, bigint, text) from public, anon, authenticated;
grant execute on function public.model_budget_record_prior_spend(date, bigint, text) to service_role;
