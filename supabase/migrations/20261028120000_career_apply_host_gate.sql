-- The workers' shared host gate (workers/career-browser/mass-run.ts dbHostGate), over the one back-off table
-- (20261027140000_career_apply_host_backoff.sql), so many worker instances share each portal's refusals. NOT APPLIED:
-- the owner applies migrations. No volume limit of Trainee's own (owner, 2026-10-27): only a portal refusing holds work
-- back, for its own Retry-After when it sent one, otherwise 30 s doubling per refusal in a row, at most an hour. The
-- workers drive in the cloud's scope ('cloud'). A host is lower case, without www. or a default port.

create or replace function public.career_apply_gate_host(p_host text) returns text
language sql immutable set search_path = pg_catalog as $$
 select regexp_replace(regexp_replace(lower(btrim(coalesce(p_host, ''))), '^www\.', ''), ':(80|443)$', '')
$$;

-- Until when each of these hosts waits (only the hosts that wait now).
create or replace function public.career_apply_host_backoff_get(p_hosts text[])
returns table (host text, until timestamptz) language sql stable security definer set search_path = public, pg_temp as $$
 select b.host, b.until from public.career_apply_host_backoff b
 where b.scope = 'cloud' and b.host = any(array(select public.career_apply_gate_host(x) from unnest(p_hosts[1:1000]) x))
  and b.until > clock_timestamp()
$$;

-- A portal refused (429, 503, a verification check): the host waits. Returns until when.
create or replace function public.career_apply_host_refused(p_host text, p_reason text, p_retry_after_s integer)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare h text := public.career_apply_gate_host(p_host); n timestamptz := clock_timestamp(); b public.career_apply_host_backoff; wait int;
 why text := case when coalesce(p_reason, '') ~* 'captcha|bot|verif|challenge|wall' then 'bot_wall'
   when coalesce(p_reason, '') ~* '503|busy|unavailable' then 'server_busy' else 'rate_limited' end;
begin
 if h = '' or length(h) > 253 or h !~ '^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$' then raise exception 'invalid host'; end if;
 select * into b from public.career_apply_host_backoff where scope = 'cloud' and host = h for update;
 wait := case when p_retry_after_s is not null and p_retry_after_s >= 0 then least(p_retry_after_s, 86400)
  else least(3600, 30 * power(2, least(coalesce(case when b.last_at > n - interval '1 hour' then b.refusals end, 0), 7))::int) end;
 insert into public.career_apply_host_backoff (scope, host, until, refusals, last_reason, last_at, updated_at)
 values ('cloud', h, n + make_interval(secs => wait), 1, why, n, n)
 on conflict (scope, host) do update set until = greatest(career_apply_host_backoff.until, excluded.until),
  refusals = case when career_apply_host_backoff.last_at > n - interval '1 hour' then career_apply_host_backoff.refusals + 1 else 1 end,
  last_reason = excluded.last_reason, last_at = n, updated_at = n
 returning * into b;
 return b.until;
end $$;

-- The portal accepted a request again: the doubling starts over (a wait already in force still runs out).
create or replace function public.career_apply_host_ok(p_host text)
returns void language sql security definer set search_path = public, pg_temp as $$
 update public.career_apply_host_backoff set refusals = 0, updated_at = clock_timestamp()
 where scope = 'cloud' and host = public.career_apply_gate_host(p_host) and refusals > 0 and until <= clock_timestamp()
$$;

revoke all on function public.career_apply_gate_host(text), public.career_apply_host_backoff_get(text[]),
 public.career_apply_host_refused(text, text, integer), public.career_apply_host_ok(text) from public, anon, authenticated;
grant execute on function public.career_apply_gate_host(text), public.career_apply_host_backoff_get(text[]),
 public.career_apply_host_refused(text, text, integer), public.career_apply_host_ok(text) to service_role;
