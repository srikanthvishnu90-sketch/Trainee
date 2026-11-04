-- REFERENCE ONLY: loaded into the throwaway test databases (tests/architect/mass-scale-pg.test.ts, mass-submit-pg.test.ts),
-- never into a live project. It is the exact shape of the Request to the database lane (builder A) for mass submission at
-- scale (owner, 2026-10-27 19:52 and 19:55 CDT): many worker instances against one database, fair leased claims that are
-- reclaimed when an instance dies, and each employer host's refusals shared by every instance. A migration that ships
-- this replaces this file in the tests.
--
-- 1. A lease before the drive. A claim leases queued applications (lease_token, lease_until) without starting them:
--    state stays 'queued', attempts stays 0. The worker begins a leased one right before its engine starts
--    (career_apply_lease_begin: queued -> driving, attempts = 1, only under its own live lease). An instance that dies
--    before beginning loses nothing: its leases lapse and any instance claims those applications again. One that dies
--    after beginning is swept to unknown_outcome and never driven again (attempts = 1), as today.
-- 2. Fair across people. Each claim takes at most one application per person, walking people in user id order from a
--    random point (a loose index scan, no window over the queue, no global lock): one person with 5,000 queued never
--    holds back the next person's first. FOR UPDATE SKIP LOCKED: concurrent claims never wait on each other.
-- 3. Host refusals, shared. career_apply_host_backoff holds, per employer host, until when every instance waits before
--    starting there again, written when a host refuses (429, 503 Retry-After, a verification check) and cleared by the next
--    success. Bounded per call; one small row per host; no number of ours (as long as the host asked, else 30 s doubling,
--    asked again at least every hour).

alter table public.career_apply_jobs add column if not exists lease_until timestamptz;
create index if not exists career_apply_jobs_queued_user_ref on public.career_apply_jobs (user_id, created_at, id)
  where state = 'queued' and attempts = 0 and source is null;
create index if not exists career_apply_jobs_driving_ref on public.career_apply_jobs (claimed_at) where state = 'driving';

-- p_after: the last person this instance was served from (its own cursor; null on its first claim: a random point). Each
-- instance walks every waiting person in id order and wraps, one item per person per lap, so in every lap each person gets
-- exactly one, however many items they have and wherever their id falls. (A random start point per call would weight each
-- person by the gap before their id, and with small claims a person just after a close neighbour would wait for many laps:
-- measured, a first start only after 199,850 others.) No shared cursor row: each instance keeps its own.
create or replace function public.career_apply_claim_fair(p_limit integer, p_lease_s integer, p_after uuid default null, p_now timestamptz default clock_timestamp())
returns setof public.career_apply_jobs language plpgsql security definer set search_path = public, pg_temp as $$
declare lim int := greatest(0, least(1000, coalesce(p_limit, 0))); lease interval := make_interval(secs => greatest(1, least(900, coalesce(p_lease_s, 120))));
  start uuid := coalesce(p_after, gen_random_uuid()); cur uuid; u uuid; cid uuid; wrapped boolean; j public.career_apply_jobs; got int := 0; pass_got int; steps int := 0;
begin
 -- Passes over the people with something claimable, one item each per pass, from a random point: the first pass reaches
 -- as many different people as the claim asks for; later passes (only when fewer people than that are waiting) take
 -- more from each, so the last person with a long queue is still served at full speed.
 loop
  cur := start; wrapped := false; pass_got := 0;
  while got < lim and steps < greatest(256, lim * 8) loop
   steps := steps + 1;
   -- The next person after `cur` with something claimable now (the partial index career_apply_jobs_queued_user_ref);
   -- after the wrap, up to and including the cursor person (the last one with anything left may be them).
   select q.user_id into u from public.career_apply_jobs q
    where q.state = 'queued' and q.attempts = 0 and q.source is null and q.user_id > cur
     and coalesce(q.lease_until, '-infinity') < p_now
    order by q.user_id limit 1;
   if u is null or (wrapped and u > start) then
    exit when wrapped;
    wrapped := true; cur := '00000000-0000-0000-0000-000000000000'; continue;
   end if;
   cur := u;
  -- The person's oldest claimable row, locked first on the cheap conditions (the index), then checked: hashing every
  -- waiting row of a person with thousands queued, on every claim, would make the last long queue crawl.
  select q.id into cid from public.career_apply_jobs q
   where q.user_id = u and q.state = 'queued' and q.attempts = 0 and q.source is null
    and coalesce(q.lease_until, '-infinity') < p_now
    -- Not on a host that is refusing now (every instance's view, career_apply_host_backoff).
    and not exists (select from public.career_apply_host_backoff b where b.until > p_now
     and b.host = lower(substring(q.url from '^[a-z]+://([^/?#]+)')))
   order by q.created_at, q.id limit 1 for update skip locked;
  if cid is null then continue; end if;
  -- G3, unchanged: only what is still exactly what the person approved, for their current account; anything else is
  -- closed unsent (never handed out).
  update public.career_apply_jobs q set lease_token = gen_random_uuid(), lease_until = p_now + lease, updated_at = p_now
   where q.id = cid and q.approval_hash = q.payload_hash and q.payload_hash = public.career_apply_payload_hash(q.payload)
    and public.career_apply_current(q.user_id, q.payload)
   returning * into j;
  if not found then
   update public.career_apply_jobs set state = 'not_submitted', reason = 'changed after it was approved; not sent', updated_at = p_now where id = cid;
   continue;
  end if;
   if found then got := got + 1; pass_got := pass_got + 1; return next j; end if;
  end loop;
  exit when got >= lim or pass_got = 0 or steps >= greatest(256, lim * 8);
 end loop;
end $$;

-- Right before the engine starts: the leases still held become drives. Returns the ids begun (a lease that lapsed and was
-- claimed by another instance is not begun, and that application is not started here).
create or replace function public.career_apply_lease_begin(p_ids uuid[], p_leases uuid[], p_now timestamptz default clock_timestamp())
returns setof uuid language sql security definer set search_path = public, pg_temp as $$
 update public.career_apply_jobs j set state = 'driving', attempts = 1, claimed_at = p_now, source = 'cloud', updated_at = p_now
  from unnest(p_ids, p_leases) as x(id, lease)
  where j.id = x.id and j.lease_token = x.lease and j.state = 'queued' and j.attempts = 0 and j.lease_until >= p_now
  returning j.id
$$;

-- Leases given back unstarted (the worker is stopping): claimable again at once.
create or replace function public.career_apply_lease_release(p_ids uuid[], p_leases uuid[])
returns integer language sql security definer set search_path = public, pg_temp as $$
 with r as (update public.career_apply_jobs j set lease_until = null, updated_at = clock_timestamp()
  from unnest(p_ids, p_leases) as x(id, lease)
  where j.id = x.id and j.lease_token = x.lease and j.state = 'queued' and j.attempts = 0 returning 1)
 select count(*)::int from r
$$;

-- A drive whose instance died: unknown, never driven again. p_after is the lease of a drive (15 minutes in production).
create or replace function public.career_apply_lease_sweep(p_after interval default interval '15 minutes', p_now timestamptz default clock_timestamp())
returns integer language sql security definer set search_path = public, pg_temp as $$
 with r as (update public.career_apply_jobs set state = 'unknown_outcome',
   reason = 'application outcome unknown: the drive stopped before recording it; not retried',
   evidence = evidence || jsonb_build_object('swept_at', p_now), updated_at = p_now
  where state = 'driving' and claimed_at < p_now - p_after returning 1)
 select count(*)::int from r
$$;

-- 3. Host refusals, shared: shipped as 20261028120000_career_apply_host_gate.sql (career_apply_host_backoff_get /
--    career_apply_host_refused / career_apply_host_ok over the one back-off table); the tests use the real ones.

revoke all on function public.career_apply_claim_fair(integer, integer, uuid, timestamptz), public.career_apply_lease_begin(uuid[], uuid[], timestamptz),
  public.career_apply_lease_release(uuid[], uuid[]), public.career_apply_lease_sweep(interval, timestamptz)
  from public, anon, authenticated;
grant execute on function public.career_apply_claim_fair(integer, integer, uuid, timestamptz), public.career_apply_lease_begin(uuid[], uuid[], timestamptz),
  public.career_apply_lease_release(uuid[], uuid[]), public.career_apply_lease_sweep(interval, timestamptz)
  to service_role;
