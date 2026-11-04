-- Back off only when an employer's portal refuses (owner decision D-MS-2, 2026-10-27, and "no person limit, never set a
-- limit", 19:55 CDT). NOT APPLIED: the owner applies migrations.
--
-- Trainee sets no volume limit and no pacing number of its own. Nothing here limits how many applications are approved,
-- queued, claimed or driven, and nothing spaces drives apart while the portal accepts them. Only the portal saying no
-- slows work down:
--  - 'rate_limited': a rate limit (HTTP 429, or the page saying to slow down);
--  - 'bot_wall': a verification check. That drive ends needs_user and is never retried; no captcha is solved;
--  - 'server_busy': the portal is unavailable (HTTP 503).
-- A portal limits the address the requests come from, so a refusal holds back only the drives that share that address:
-- scope 'cloud' for the cloud's drives (source cloud), and the person's own id for their own computer or extension.
-- A drive that meets a refusal reports it (career_apply_host_refused_for, or _own on the person's computer). Its host,
-- in its scope, then waits: the portal's own Retry-After when it sent one, otherwise 30 seconds, doubling with each
-- refusal in a row, up to an hour. While it waits, the claims hand out nothing on that host in that scope
-- (20261027141000). The first request the portal accepts again (career_apply_host_ok_for / _own) ends the wait and starts
-- the doubling over.
-- career_apply_host_wait(url, scope, now) says whether a link's host is waiting, until when and why. The workers read it,
-- and the chat tells the person from it, plainly: "the employer's site asked us to slow down; it resumes at …".

create table if not exists public.career_apply_host_backoff (
 scope text not null check (scope = 'cloud' or scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 host text not null check (host ~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
 until timestamptz not null,
 refusals integer not null default 0 check (refusals >= 0),
 last_reason text not null check (last_reason in ('rate_limited', 'bot_wall', 'server_busy')),
 last_at timestamptz not null,
 updated_at timestamptz not null default now(),
 primary key (scope, host)
);
alter table public.career_apply_host_backoff enable row level security;
revoke all on public.career_apply_host_backoff from public, anon, authenticated;
grant select on public.career_apply_host_backoff to service_role;

-- A link's host as backoff counts it: lower case, without www., without a default port (any other port is kept).
create or replace function public.career_apply_host(p_url text) returns text
language sql immutable set search_path = pg_catalog as $$
 select regexp_replace(regexp_replace(lower(substring(btrim(coalesce(p_url, '')) from '^https?://([^/?#@]+)')), '^www\.', ''), ':(80|443)$', '')
$$;
-- The scope a job's refusals belong to: the cloud's shared addresses, or the person's own.
create or replace function public.career_apply_backoff_scope(p_source text, p_user uuid) returns text
language sql immutable set search_path = pg_catalog as $$
 select case when p_source = 'cloud' or p_source is null then 'cloud' else p_user::text end
$$;

create or replace function public.career_apply_host_wait(p_url text, p_scope text, p_now timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((select jsonb_build_object('host', b.host, 'scope', b.scope, 'waiting', true, 'until', b.until, 'reason', b.last_reason,
   'wait_seconds', greatest(1, ceil(extract(epoch from b.until - p_now))::int))
  from public.career_apply_host_backoff b where b.scope = p_scope and b.host = public.career_apply_host(p_url) and b.until > p_now),
  jsonb_build_object('host', public.career_apply_host(p_url), 'scope', p_scope, 'waiting', false, 'wait_seconds', 0))
$$;

-- The drive holding the job's lease reports that the portal refused. Returns the wait now in force on its host.
create or replace function public.career_apply_host_refused_for(p_id uuid, p_lease uuid, p_reason text, p_retry_after_seconds integer, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; h text; sc text; b public.career_apply_host_backoff; wait int;
begin
 if p_id is null or p_lease is null or p_now is null or p_reason is null or p_reason not in ('rate_limited', 'bot_wall', 'server_busy')
  or (p_retry_after_seconds is not null and p_retry_after_seconds < 0) then raise exception 'invalid portal refusal'; end if;
 select * into j from public.career_apply_jobs where id = p_id;
 if j.id is null or j.state is distinct from 'driving' or j.lease_token is distinct from p_lease then raise exception 'invalid apply claim'; end if;
 h := public.career_apply_host(j.url); sc := public.career_apply_backoff_scope(j.source, j.user_id);
 if h is null or h = '' then raise exception 'invalid apply claim'; end if;
 select * into b from public.career_apply_host_backoff where scope = sc and host = h for update;
 -- The portal's own word when it gave one; otherwise 30 s, doubling per refusal in a row (an hour apart starts over).
 wait := coalesce(p_retry_after_seconds, least(3600, 30 * power(2, least(coalesce(case when b.last_at > p_now - interval '1 hour' then b.refusals end, 0), 7))::int));
 insert into public.career_apply_host_backoff (scope, host, until, refusals, last_reason, last_at, updated_at)
 values (sc, h, p_now + make_interval(secs => wait), 1, p_reason, p_now, p_now)
 on conflict (scope, host) do update set until = greatest(career_apply_host_backoff.until, excluded.until),
  refusals = case when career_apply_host_backoff.last_at > p_now - interval '1 hour' then career_apply_host_backoff.refusals + 1 else 1 end,
  last_reason = excluded.last_reason, last_at = p_now, updated_at = p_now
 returning * into b;
 return jsonb_build_object('host', h, 'scope', sc, 'until', b.until, 'refusals', b.refusals, 'reason', b.last_reason,
  'wait_seconds', greatest(0, ceil(extract(epoch from b.until - p_now))::int));
end $$;

-- The portal accepted a request again: the wait on its host, in that scope, ends and the doubling starts over.
create or replace function public.career_apply_host_ok_for(p_id uuid, p_lease uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; h text; sc text;
begin
 if p_id is null or p_lease is null or p_now is null then raise exception 'invalid apply claim'; end if;
 select * into j from public.career_apply_jobs where id = p_id;
 if j.id is null or j.lease_token is distinct from p_lease then raise exception 'invalid apply claim'; end if;
 h := public.career_apply_host(j.url); sc := public.career_apply_backoff_scope(j.source, j.user_id);
 update public.career_apply_host_backoff set until = least(until, p_now), refusals = 0, updated_at = p_now where scope = sc and host = h;
 return jsonb_build_object('host', h, 'scope', sc, 'waiting', false);
end $$;

-- The same two for the signed-in person's own computer, only for their own job.
create or replace function public.career_apply_host_refused_own(p_id uuid, p_lease uuid, p_reason text, p_retry_after_seconds integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception 'not signed in'; end if;
 if not exists (select from public.career_apply_jobs where id = p_id and user_id = u) then raise exception 'invalid apply claim'; end if;
 return public.career_apply_host_refused_for(p_id, p_lease, p_reason, p_retry_after_seconds, clock_timestamp());
end $$;
create or replace function public.career_apply_host_ok_own(p_id uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception 'not signed in'; end if;
 if not exists (select from public.career_apply_jobs where id = p_id and user_id = u) then raise exception 'invalid apply claim'; end if;
 return public.career_apply_host_ok_for(p_id, p_lease, clock_timestamp());
end $$;
create or replace function public.career_apply_host_wait_own(p_url text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception 'not signed in'; end if;
 return public.career_apply_host_wait(p_url, u::text, clock_timestamp());
end $$;

revoke all on function public.career_apply_host(text), public.career_apply_backoff_scope(text, uuid), public.career_apply_host_wait(text, text, timestamptz),
 public.career_apply_host_refused_for(uuid, uuid, text, integer, timestamptz), public.career_apply_host_ok_for(uuid, uuid, timestamptz),
 public.career_apply_host_refused_own(uuid, uuid, text, integer), public.career_apply_host_ok_own(uuid, uuid), public.career_apply_host_wait_own(text)
 from public, anon, authenticated;
grant execute on function public.career_apply_host(text), public.career_apply_backoff_scope(text, uuid), public.career_apply_host_wait(text, text, timestamptz),
 public.career_apply_host_refused_for(uuid, uuid, text, integer, timestamptz), public.career_apply_host_ok_for(uuid, uuid, timestamptz) to service_role;
grant execute on function public.career_apply_host_refused_own(uuid, uuid, text, integer), public.career_apply_host_ok_own(uuid, uuid),
 public.career_apply_host_wait_own(text) to authenticated;
