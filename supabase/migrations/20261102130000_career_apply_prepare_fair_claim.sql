-- MASS APPLY (2026-11-02): fair preparation claim. career_apply_prepare_request_claim took queued requests oldest first
-- (order by created_at, id), so one person who queued 100 roles (4 parts of 25, all stamped the same instant) held the next
-- slots before anyone who asked a minute later: with 2 slots that is minutes to an hour of waiting for everyone else
-- (docs/architect/mass-apply-scale-audit.md section 3).
-- Now the queue is served in turns per person: a request's turn is its position among that person's own queued requests
-- (oldest first) PLUS the number of that person's requests already running. Requests are claimed lowest turn first, then
-- oldest, so every waiting person gets a slot before anyone gets a second one; when only one person is waiting they still
-- get every free slot (nothing idles). The limits (p_want, p_global, per-person-day, per-site-minute), the lease expiry and
-- the split of a request that fits only in part are unchanged; only the ORDER changes. Same signature, additive, idempotent.
-- Rollback: supabase/rollbacks/20261102130000_career_apply_prepare_fair_claim.down.sql (restores 20261026230017's body).

create or replace function public.career_apply_prepare_request_claim(p_want integer, p_global integer, p_per_person_day integer,
 p_per_site_minute integer) returns setof public.career_apply_prepare_requests
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_apply_prepare_requests; c record; running int; got int := 0; n timestamptz := clock_timestamp();
 left_person int; take text[]; take_h text[]; rest text[]; rest_h text[]; i int; h text; site jsonb; why text;
begin
 if p_want is null or p_want not between 0 and 500 or p_global is null or p_global not between 1 and 10000
  or p_per_person_day < 1 or p_per_site_minute < 1 then
  raise exception 'invalid prepare limits'; end if;
 perform pg_advisory_xact_lock(hashtextextended('career-prepare-dispatch-v1', 0));
 -- Each expiry is told to the person once (unless they said STOP): what happened, that nothing was sent, what to do.
 for r in update public.career_apply_prepare_requests set state = 'expired', finished_at = n,
  outcome = outcome || jsonb_build_object('reason', 'the preparation did not finish inside its lease; not run again')
  where state = 'running' and claimed_at < n - interval '15 minutes' returning * loop
  perform public.career_apply_prepare_tell(r.user_id, 'status:prepare:' || r.id, 'Preparing the application you asked for stopped before it finished, so there is no card for it. Nothing was sent. Say "apply me to" with the link to try again.');
 end loop;
 for r in update public.career_apply_prepare_requests set state = 'expired', finished_at = n,
  outcome = outcome || jsonb_build_object('reason', 'not started within 24 hours')
  where state = 'queued' and created_at < n - interval '24 hours' returning * loop
  perform public.career_apply_prepare_tell(r.user_id, 'status:prepare:' || r.id, 'I couldn''t start preparing the application you asked for within a day. Nothing was sent, and it is still in your queue. Say "apply me to" with the link to try again.');
 end loop;
 select count(*) into running from public.career_apply_prepare_requests where state = 'running';
 -- Postings started this minute, per host.
 select coalesce(jsonb_object_agg(y.host, y.c), '{}') into site from (select u.host, count(*) c from public.career_apply_prepare_requests x, unnest(x.hosts) u(host)
  where x.claimed_at > n - interval '1 minute' group by u.host) y;
 -- The turn order, read once (the dispatch lock is held, so nobody else claims meanwhile); each row is locked as it is taken.
 for c in
  select q.id from (
   select x.id, x.created_at,
    row_number() over (partition by x.user_id order by x.created_at, x.id) + coalesce(
     (select count(*) from public.career_apply_prepare_requests z where z.user_id = x.user_id and z.state = 'running'), 0) as turn
   from public.career_apply_prepare_requests x where x.state = 'queued'
  ) q order by q.turn, q.created_at, q.id
 loop
  exit when got >= p_want or running + got >= p_global;
  select * into r from public.career_apply_prepare_requests where id = c.id and state = 'queued' for update skip locked;
  if r.id is null then continue; end if;
  left_person := case when p_per_person_day is null then null else p_per_person_day - public.career_apply_prepare_postings_today(r.user_id, n) end;
  take := '{}'; take_h := '{}'; rest := '{}'; rest_h := '{}'; why := null;
  for i in 1 .. cardinality(r.job_ids) loop
   h := coalesce(r.hosts[i], '');
   if left_person is not null and cardinality(take) >= left_person then rest := rest || r.job_ids[i]; rest_h := rest_h || h; why := coalesce(why, 'per_person_day');
   elsif p_per_site_minute is not null and coalesce((site->>h)::int, 0) >= p_per_site_minute then rest := rest || r.job_ids[i]; rest_h := rest_h || h; why := coalesce(why, 'per_site_minute');
   else take := take || r.job_ids[i]; take_h := take_h || h; site := site || jsonb_build_object(h, coalesce((site->>h)::int, 0) + 1);
   end if;
  end loop;
  if cardinality(take) = 0 then
   update public.career_apply_prepare_requests set outcome = outcome || jsonb_build_object('waiting_for', why) where id = r.id;
   continue;
  end if;
  if cardinality(rest) > 0 then
   insert into public.career_apply_prepare_requests (user_id, job_ids, hosts, created_at, outcome)
   values (r.user_id, rest, rest_h, r.created_at, jsonb_build_object('waiting_for', why, 'split_from', r.id));
  end if;
  update public.career_apply_prepare_requests set state = 'running', claimed_at = n, lease_token = gen_random_uuid(),
   job_ids = take, hosts = take_h, outcome = outcome - 'waiting_for'
   where id = r.id returning * into r;
  got := got + 1;
  return next r;
 end loop;
end $$;

revoke all on function public.career_apply_prepare_request_claim(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.career_apply_prepare_request_claim(integer, integer, integer, integer) to service_role;
