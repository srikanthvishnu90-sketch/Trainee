-- Task 3 (2026-10-28): one connector framework (supabase/functions/_shared/connectors.ts). Gmail and Outlook plug into one
-- registry; this file adds what the registry keeps in the database:
--   career_connector_links  the one-time link "connect gmail" sends from any channel (web, Telegram, iMessage, WhatsApp):
--                           bound to the person, the channel and the thread, stored only as a SHA-256 of the token,
--                           15 minutes, used once (issue -> peek -> open -> finish). Gmail's link lives here; Outlook keeps
--                           career_outlook_links (20261027230000) until it moves, and the registry hides the difference.
--                           The connector column is the registry's id, so a link can never open another connector's consent.
--   career_parked_tasks     "one ask, then resume": a task that needed a connector the person had not connected, parked
--                           by person and need (gmail, outlook, or mail: either one). The first park of a need is the one
--                           ask (the reply carries the link); every later park of the same need while one waits is kept
--                           and never asks again. When the person connects, the connect callback claims the waiting tasks
--                           (FOR UPDATE SKIP LOCKED, a lease, an expired lease reclaimed) and runs each exactly once.
--   pending sends           a mail connector's connection row deleted (disconnect, by any path) cancels every approved
--                           outreach email that has not gone yet (career_outreach_drafts 'approved' -> 'skipped', result
--                           says why), and burns the person's live Gmail links. Outlook's own ledger is cancelled by
--                           20261027230000's trigger.
-- The career_ prefix puts both tables under "forget everything" (career_erase_person). Additive and idempotent. Nothing is
-- granted to anon or authenticated; every function is service-role only. No volume limit of Trainee's own anywhere.

-- ------------------------------------------------------------------------------------------------ links
create table if not exists public.career_connector_links (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector text not null check (connector in ('gmail')),
  channel text not null check (channel in ('web', 'telegram', 'imessage', 'whatsapp', 'home')),
  thread_id uuid references public.agent_threads(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  opened_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome is null or outcome in ('connected', 'declined', 'error')),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check (finished_at is null or opened_at is not null));
create index if not exists career_connector_links_user on public.career_connector_links (user_id, connector, opened_at desc);

create or replace function public.career_connector_link_issue(p_user uuid, p_connector text, p_channel text, p_thread uuid, p_now timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare n text;
begin
  if p_user is null or p_now is null or p_connector is null then raise exception 'invalid link request'; end if;
  n := left(translate(encode(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_'), 32);
  insert into public.career_connector_links (nonce_hash, user_id, connector, channel, thread_id, created_at, expires_at)
  values (encode(sha256(convert_to(n, 'UTF8')), 'hex'), p_user, p_connector, coalesce(p_channel, 'web'),
    (select t.id from public.agent_threads t where t.id = p_thread and t.user_id = p_user), p_now, p_now + interval '15 minutes');
  return n;
end $$;

-- A message preview (Telegram, iMessage, WhatsApp) fetches a link as soon as it is delivered: a GET only peeks.
create or replace function public.career_connector_link_peek(p_nonce text, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.career_connector_links; em text; hint text;
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{32}$' or p_now is null then return jsonb_build_object('status', 'invalid'); end if;
  select * into r from public.career_connector_links where nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  if r.id is null then return jsonb_build_object('status', 'invalid'); end if;
  if r.opened_at is not null then return jsonb_build_object('status', 'used'); end if;
  if r.expires_at <= p_now then return jsonb_build_object('status', 'expired'); end if;
  select u.email into em from auth.users u where u.id = r.user_id;
  if em ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then hint := left(em, 1) || '•••@' || split_part(em, '@', 2); end if;
  return jsonb_build_object('status', 'ok', 'connector', r.connector, 'hint', hint);
end $$;

-- The person's own tap: used once. Returns whose link it is so the consent's signed state names that person, never another.
create or replace function public.career_connector_link_open(p_nonce text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_connector_links;
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{32}$' or p_now is null then return jsonb_build_object('error', 'invalid'); end if;
  select * into r from public.career_connector_links where nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex') for update;
  if r.id is null then return jsonb_build_object('error', 'invalid'); end if;
  if r.opened_at is not null then return jsonb_build_object('error', 'used'); end if;
  if r.expires_at <= p_now then return jsonb_build_object('error', 'expired'); end if;
  update public.career_connector_links set opened_at = p_now where id = r.id;
  return jsonb_build_object('link_id', r.id, 'user_id', r.user_id, 'connector', r.connector);
end $$;

-- The provider's callback (authenticated by its own signed state for p_user): the person's most recently opened, unfinished
-- link of that connector, within 15 minutes of its open, finished once; it says where to answer. Null when there is none
-- (a connect started in the app, not from a chat link).
create or replace function public.career_connector_link_finish(p_user uuid, p_connector text, p_outcome text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_connector_links;
begin
  if p_user is null or p_now is null or p_outcome is null or p_outcome not in ('connected', 'declined', 'error') then return null; end if;
  select * into r from public.career_connector_links
  where user_id = p_user and connector = p_connector and opened_at is not null and finished_at is null and opened_at > p_now - interval '15 minutes'
  order by opened_at desc limit 1 for update;
  if r.id is null then return null; end if;
  update public.career_connector_links set finished_at = p_now, outcome = p_outcome where id = r.id;
  return jsonb_build_object('link_id', r.id, 'user_id', r.user_id, 'channel', r.channel, 'thread_id', r.thread_id);
end $$;

-- ------------------------------------------------------------------------------------------------ parked tasks
create table if not exists public.career_parked_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  need text not null check (need in ('gmail', 'outlook', 'mail')),
  ask text not null check (length(ask) between 1 and 2000),
  ask_hash text not null check (ask_hash ~ '^[0-9a-f]{64}$'),
  thread_id uuid references public.agent_threads(id) on delete set null,
  channel text not null check (channel in ('web', 'telegram', 'imessage', 'whatsapp', 'home')),
  status text not null default 'waiting' check (status in ('waiting', 'resuming', 'resumed', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  result text check (result is null or length(result) <= 300),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resumed_at timestamptz);
-- One live task per (person, need, ask): the same ask parked twice is the same task.
create unique index if not exists career_parked_tasks_live on public.career_parked_tasks (user_id, need, ask_hash) where status in ('waiting', 'resuming');
create index if not exists career_parked_tasks_waiting on public.career_parked_tasks (user_id, need) where status in ('waiting', 'resuming');

-- Park a task. first = true only when no task of this need was already waiting (a 'mail' ask, which either mail
-- connector answers, counts for both, and both count for it): that park is the one ask. Serialized per person and need, so two turns at once never both ask.
create or replace function public.career_parked_park(p_user uuid, p_need text, p_ask text, p_thread uuid, p_channel text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare h text; waiting boolean; id_ uuid; dup boolean := false;
begin
  if p_user is null or p_need is null or p_ask is null or p_now is null then raise exception 'invalid park'; end if;
  perform pg_advisory_xact_lock(hashtextextended('career_parked:' || p_user::text, 0));
  h := encode(sha256(convert_to(lower(btrim(regexp_replace(p_ask, '\s+', ' ', 'g'))), 'UTF8')), 'hex');
  select exists (select 1 from public.career_parked_tasks t where t.user_id = p_user and t.status in ('waiting', 'resuming')
    and (t.need = p_need or t.need = 'mail' or p_need = 'mail')) into waiting;
  insert into public.career_parked_tasks (user_id, need, ask, ask_hash, thread_id, channel, created_at, updated_at)
  values (p_user, p_need, left(btrim(p_ask), 2000), h, (select t.id from public.agent_threads t where t.id = p_thread and t.user_id = p_user),
    coalesce(p_channel, 'web'), p_now, p_now)
  on conflict (user_id, need, ask_hash) where status in ('waiting', 'resuming') do nothing
  returning id into id_;
  if id_ is null then
    dup := true;
    select t.id into id_ from public.career_parked_tasks t where t.user_id = p_user and t.need = p_need and t.ask_hash = h and t.status in ('waiting', 'resuming');
  end if;
  return jsonb_build_object('task_id', id_, 'first', not waiting, 'duplicate', dup);
end $$;

-- The connect callback (or a sweeper) claims the person's tasks a connector now satisfies: waiting ones, and resuming ones
-- whose lease expired (a worker that died mid-resume). Rows another worker holds are skipped.
create or replace function public.career_parked_claim(p_user uuid, p_needs text[], p_now timestamptz, p_lease_seconds int default 300)
returns setof public.career_parked_tasks language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid claim'; end if;
  return query
  with c as (
    select t.id from public.career_parked_tasks t
    where t.user_id = p_user and t.need = any(p_needs)
      and (t.status = 'waiting' or (t.status = 'resuming' and t.lease_until <= p_now))
    order by t.created_at limit 50 for update skip locked)
  update public.career_parked_tasks t set status = 'resuming', lease_until = p_now + make_interval(secs => p_lease_seconds),
    attempts = t.attempts + 1, updated_at = p_now
  from c where t.id = c.id returning t.*;
end $$;

-- A sweeper's batch across people: waiting tasks whose need is now connected (a resume that failed, or a callback that
-- died before claiming); an Outlook that needs reconnecting is not connected. Many sweepers run at once; each task goes
-- to one.
create or replace function public.career_parked_due(p_now timestamptz, p_batch int, p_lease_seconds int default 300)
returns setof public.career_parked_tasks language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_now is null or coalesce(p_batch, 0) < 1 or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid claim'; end if;
  return query
  with c as (
    select t.id from public.career_parked_tasks t
    where (t.status = 'waiting' or (t.status = 'resuming' and t.lease_until <= p_now))
      and exists (select 1 from public.user_oauth_connections o where o.user_id = t.user_id
        and ((t.need in ('gmail', 'mail') and o.provider = 'google_career') or (t.need in ('outlook', 'mail') and o.provider = 'microsoft'
          and not exists (select 1 from public.career_outlook_state s where s.user_id = t.user_id and s.needs_reconnect_at is not null))))
    order by t.updated_at limit p_batch for update skip locked)
  update public.career_parked_tasks t set status = 'resuming', lease_until = p_now + make_interval(secs => p_lease_seconds),
    attempts = t.attempts + 1, updated_at = p_now
  from c where t.id = c.id returning t.*;
end $$;

-- Only the holder of a live claim finishes it: 'resumed' (done, never again) or 'waiting' (kept for the next try).
create or replace function public.career_parked_finish(p_id uuid, p_status text, p_result text, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_status not in ('resumed', 'waiting') then raise exception 'invalid finish'; end if;
  update public.career_parked_tasks set status = p_status, lease_until = null, result = left(p_result, 300), updated_at = p_now,
    resumed_at = case when p_status = 'resumed' then p_now else resumed_at end
  where id = p_id and status = 'resuming';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ------------------------------------------------------------------------------------------------ disconnect
-- A mail connector's row deleted (any path): every approved outreach email that has not gone yet is cancelled (the person
-- approves it again to send it), and every live Gmail link dies. A reconnect is an upsert, never a delete.
create or replace function public.career_connector_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.provider in ('google_career', 'microsoft') then
    update public.career_outreach_drafts set status = 'skipped', result = 'cancelled: ' || case when old.provider = 'microsoft' then 'Outlook' else 'Gmail' end || ' disconnected', updated_at = now()
      where user_id = old.user_id and status = 'approved';
  end if;
  if old.provider in ('google_career', 'gmail') then
    update public.career_connector_links set opened_at = coalesce(opened_at, now()), finished_at = now(), outcome = coalesce(outcome, 'error')
      where user_id = old.user_id and connector = 'gmail' and finished_at is null;
  end if;
  return old;
end $$;
drop trigger if exists user_oauth_connections_connector_cancel on public.user_oauth_connections;
create trigger user_oauth_connections_connector_cancel after delete on public.user_oauth_connections
  for each row execute function public.career_connector_on_disconnect();

alter table public.career_connector_links enable row level security;
alter table public.career_parked_tasks enable row level security;
revoke all on public.career_connector_links, public.career_parked_tasks from public, anon, authenticated;
grant select, insert, update, delete on public.career_connector_links, public.career_parked_tasks to service_role;

revoke all on function public.career_connector_link_issue(uuid, text, text, uuid, timestamptz), public.career_connector_link_peek(text, timestamptz),
  public.career_connector_link_open(text, timestamptz), public.career_connector_link_finish(uuid, text, text, timestamptz),
  public.career_parked_park(uuid, text, text, uuid, text, timestamptz), public.career_parked_claim(uuid, text[], timestamptz, int),
  public.career_parked_due(timestamptz, int, int), public.career_parked_finish(uuid, text, text, timestamptz),
  public.career_connector_on_disconnect() from public, anon, authenticated;
grant execute on function public.career_connector_link_issue(uuid, text, text, uuid, timestamptz), public.career_connector_link_peek(text, timestamptz),
  public.career_connector_link_open(text, timestamptz), public.career_connector_link_finish(uuid, text, text, timestamptz),
  public.career_parked_park(uuid, text, text, uuid, text, timestamptz), public.career_parked_claim(uuid, text[], timestamptz, int),
  public.career_parked_due(timestamptz, int, int), public.career_parked_finish(uuid, text, text, timestamptz) to service_role;
