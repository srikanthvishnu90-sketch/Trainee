-- PEOPLE FINDING: Gmail read in full, never truncated (owner, 2026-10-27: no volume limit of Trainee's own). The ask
-- "who do I know at Ramp" and "show my Handshake and Indeed jobs" used to read the newest 25 / 20 messages and stop.
-- Now each such read is a SWEEP with a saved cursor: Gmail's page token plus the position inside that page (keyset over
-- Gmail's own order), so it resumes exactly where it stopped. A turn reads for a few seconds and says plainly when more
-- is still being read; the scheduled run (CAREER_PEOPLE_SWEEP=on) continues every unfinished sweep in leased batches.
-- A finished sweep keeps the newest message time it saw; the next ask reads only mail after it.
--
--   career_people_gmail_sweeps     one cursor per person, kind and company (correspondents at a domain; job alerts).
--   career_people_sweep_lease      a turn takes one sweep (made if new) unless another reader holds it or Gmail asked
--                                  to slow down (retry_at). Returns {leased, row}.
--   career_people_sweep_save       the holder saves the cursor and lets go; refused for a lease it no longer holds.
--   career_people_sweep_claim      the scheduled run takes a batch of unfinished, unheld sweeps: FOR UPDATE SKIP LOCKED,
--                                  so any number of runs work in parallel, each sweep held by one at a time; a lease
--                                  that ran out (a crashed reader) is taken again.
-- Erased with everything else: the account epoch ("forget everything"), Gmail disconnect, account deletion (cascade).
-- Idempotent.

create table if not exists public.career_people_gmail_sweeps (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('correspondents', 'job_alerts')),
  scope text not null default '' check (length(scope) <= 200),          -- the company's domain label (correspondents)
  company_key text not null default '' check (length(company_key) <= 200),
  state text not null default 'idle' check (state in ('idle', 'reading', 'done')),
  query text check (query is null or length(query) <= 2000),
  page_token text check (page_token is null or length(page_token) <= 2000),
  skip int not null default 0 check (skip >= 0),
  newest_at timestamptz,
  read_count bigint not null default 0 check (read_count >= 0),       -- messages read in the current sweep
  lease_id uuid,
  lease_until timestamptz,
  retry_at timestamptz,                                                -- Gmail asked to slow down: not before this
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, scope)
);
create index if not exists career_people_gmail_sweeps_open on public.career_people_gmail_sweeps (updated_at) where state = 'reading';
alter table public.career_people_gmail_sweeps enable row level security;
revoke all on public.career_people_gmail_sweeps from public, anon, authenticated;
grant all on public.career_people_gmail_sweeps to service_role;

create or replace function public.career_people_sweep_lease(p_user uuid, p_kind text, p_scope text, p_company_key text, p_lease_seconds int)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare r career_people_gmail_sweeps;
begin
  if p_user is null or p_kind not in ('correspondents', 'job_alerts') or p_lease_seconds is null or p_lease_seconds < 1 then raise exception 'invalid sweep lease'; end if;
  insert into career_people_gmail_sweeps (user_id, kind, scope, company_key) values (p_user, p_kind, coalesce(p_scope, ''), coalesce(p_company_key, ''))
  on conflict (user_id, kind, scope) do nothing;
  update career_people_gmail_sweeps s set lease_id = gen_random_uuid(), lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   where s.user_id = p_user and s.kind = p_kind and s.scope = coalesce(p_scope, '')
     and (s.lease_until is null or s.lease_until <= now()) and (s.retry_at is null or s.retry_at <= now())
  returning * into r;
  if found then return jsonb_build_object('leased', true, 'row', to_jsonb(r)); end if;
  select * into r from career_people_gmail_sweeps s where s.user_id = p_user and s.kind = p_kind and s.scope = coalesce(p_scope, '');
  return jsonb_build_object('leased', false, 'row', to_jsonb(r));
end $$;
revoke all on function public.career_people_sweep_lease(uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.career_people_sweep_lease(uuid, text, text, text, int) to service_role;

create or replace function public.career_people_sweep_save(p_user uuid, p_kind text, p_scope text, p_lease uuid, p_state text, p_query text,
  p_page_token text, p_skip int, p_newest_at timestamptz, p_read_count bigint, p_retry_at timestamptz)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_state not in ('reading', 'done') then raise exception 'invalid sweep state'; end if;
  update career_people_gmail_sweeps s
     set state = p_state, query = p_query, page_token = case when p_state = 'done' then null else p_page_token end,
         skip = case when p_state = 'done' then 0 else greatest(coalesce(p_skip, 0), 0) end,
         newest_at = greatest(s.newest_at, p_newest_at), read_count = greatest(coalesce(p_read_count, 0), 0),
         retry_at = p_retry_at, lease_id = null, lease_until = null, updated_at = now()
   where s.user_id = p_user and s.kind = p_kind and s.scope = coalesce(p_scope, '') and s.lease_id = p_lease;
  return found;
end $$;
revoke all on function public.career_people_sweep_save(uuid, text, text, uuid, text, text, text, int, timestamptz, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.career_people_sweep_save(uuid, text, text, uuid, text, text, text, int, timestamptz, bigint, timestamptz) to service_role;

create or replace function public.career_people_sweep_claim(p_lease_seconds int, p_limit int)
returns setof public.career_people_gmail_sweeps language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  return query
  with c as (
    select s.user_id, s.kind, s.scope from career_people_gmail_sweeps s
     where s.state = 'reading' and (s.lease_until is null or s.lease_until <= now()) and (s.retry_at is null or s.retry_at <= now())
     order by s.updated_at
     limit greatest(coalesce(p_limit, 1), 1)
     for update skip locked
  )
  update career_people_gmail_sweeps s set lease_id = gen_random_uuid(), lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 1), 1)), updated_at = now()
    from c where s.user_id = c.user_id and s.kind = c.kind and s.scope = c.scope
  returning s.*;
end $$;
revoke all on function public.career_people_sweep_claim(int, int) from public, anon, authenticated;
grant execute on function public.career_people_sweep_claim(int, int) to service_role;

-- Erase: the account epoch moving ("forget everything") and Gmail being disconnected take every cursor with them.
create or replace function public.career_people_sweeps_on_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.key = 'career:account' and coalesce((new.value->>'epoch')::bigint, 0) >
    (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
  delete from public.career_people_gmail_sweeps where user_id = new.user_id;
 end if;
 return new;
end $$;
revoke all on function public.career_people_sweeps_on_erase() from public, anon, authenticated;
drop trigger if exists career_people_sweeps_on_erase on public.career_watch_kv;
create trigger career_people_sweeps_on_erase after insert or update on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_people_sweeps_on_erase();

create or replace function public.career_people_sweeps_on_gmail_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if old.provider = 'google_career' then delete from public.career_people_gmail_sweeps where user_id = old.user_id; end if;
 return old;
end $$;
revoke all on function public.career_people_sweeps_on_gmail_disconnect() from public, anon, authenticated;
drop trigger if exists career_people_sweeps_on_gmail_disconnect on public.user_oauth_connections;
create trigger career_people_sweeps_on_gmail_disconnect after delete on public.user_oauth_connections
 for each row execute function public.career_people_sweeps_on_gmail_disconnect();

-- The scheduled run's count of sweeps it moved forward, on its run record like every other rail.
alter table public.career_proactive_runs add column if not exists people_sweeps int not null default 0 check (people_sweeps >= 0);
