-- Back off, then RESUME (owner rule, binding, 2026-10-27: "NO LIMITS ... Back off only when an outside system refuses
-- (429, quota, bot wall), then RESUME"). NOT APPLIED: the owner applies migrations.
--
-- Found by the apply scenario battery (PR #288): an approved application whose employer's site refused for load before
-- anything was filled or sent (the engine's HOST_RATE_LIMITED: a 429 with or without Retry-After, or a 503 that said when
-- to come back) was finished not_submitted and never tried again; approving the same posting again was refused by the
-- queue's one-row-per-posting rule (unique(user_id, job_id)), so it could never go at all.
--
-- Now such a refusal puts the SAME job back: state queued, attempts 0, no lease, no source (as it was before its claim),
-- with a not-before time, the host's hold (the workers' shared gate, career_apply_host_refused, or the host's own
-- Retry-After), and its approval, payload and payload hash untouched (career_apply_jobs_fixed still freezes them). No
-- new approval is asked for; it runs again once the host's back-off ends. There is no cap of Trainee's own on how many
-- times a host may refuse: each refusal backs off again (the gate doubles, or the host's Retry-After).
--
-- Kept, unchanged:
--  - exactly once: only a drive the worker reports refused BEFORE submit is put back (career_apply_requeue_refused_*):
--    one still driving under its own lease, from a worker's own computer or the cloud (never the email path or the
--    extension), with no confirmation of any kind. Anything after the engine may have sent stays as it is recorded
--    (unknown_outcome by the worker or by the 15-minute sweep, never driven again). The old lease is gone: the run that
--    was refused can record nothing more for this job;
--  - a verification check (a captcha, a bot wall) is the person's: needs_user, handed back, never put back or retried.
--    A sign-in wall likewise (ACCOUNT_LOGIN_REQUIRED): the employer asks the person to sign in to an account, which is not
--    the site refusing for load and is not cured by waiting, so it is needs_user, and its host is not backed off;
--  - every claim's checks (hash re-check, resume, gates, pauses, the person's own pace): the job is an ordinary queued
--    job again, so every claim checks it as it checks any other;
--  - the counted states: a requeued job is queued, so the same posting is still refused as in flight (duplicate_job) and
--    still counts as applied in the chat's screen (career_apply_counted_states()).
-- New:
--  - career_apply_jobs.not_before (null: no wait) and host_refusals (how many times its host refused it before submit);
--  - career_apply_jobs_not_before (BEFORE UPDATE OF state): no claim, by any path, hands out a job before its not-before
--    time; the row is skipped, as the resume guards skip a job without its resume. On every claim there is, present and
--    future, whatever the reconcile (career_apply_reconcile_bridge) rewrites them to. The claims already skip a host that
--    is holding back (career_apply_host_backoff), and the requeue keeps that hold at least as long as the job's own;
--  - career_apply_jobs_fixed: the source a claim gave may be cleared only by this requeue (driving -> queued, attempts 0,
--    no lease), marked by its own transaction-local setting; any other change of source is refused as before.
-- After 20261029170000 (and 20261028120000, whose shared gate it reads). Idempotent.

alter table public.career_apply_jobs add column if not exists not_before timestamptz;
alter table public.career_apply_jobs add column if not exists host_refusals integer not null default 0;
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_host_refusals_check;
alter table public.career_apply_jobs add constraint career_apply_jobs_host_refusals_check check (host_refusals >= 0);
create index if not exists career_apply_jobs_not_before on public.career_apply_jobs (not_before) where state = 'queued' and not_before is not null;

-- No claim hands out a job before its not-before time (any claim: the pool, the person's computer, the cloud's, the
-- per-portal one, the extension's, and any written later). The row is left queued for a later claim.
create or replace function public.career_apply_jobs_not_before() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if new.state = 'driving' and old.state = 'queued' and old.not_before is not null
  and old.not_before > coalesce(new.claimed_at, clock_timestamp()) then
  return null;
 end if;
 return new;
end $$;
revoke all on function public.career_apply_jobs_not_before() from public, anon, authenticated;
drop trigger if exists career_apply_jobs_not_before on public.career_apply_jobs;
create trigger career_apply_jobs_not_before before update of state on public.career_apply_jobs
 for each row execute function public.career_apply_jobs_not_before();

-- 20261025100000's guard, with one change: the requeue below may clear the source a claim gave (the job goes back to how
-- it was before its claim). Everything else as it was.
create or replace function public.career_apply_jobs_fixed() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if old.source is not null and new.source is distinct from old.source
  and not (new.source is null and old.state = 'driving' and new.state = 'queued' and new.attempts = 0 and new.lease_token is null
   and new.claimed_at is null and coalesce(current_setting('career.apply_requeue', true), '') = old.id::text) then
  raise exception 'source_fixed'; end if;
 -- A source is given by the claim that starts a drive, from queued, and by nothing else.
 if old.source is null and new.source is not null and old.state <> 'queued' then raise exception 'source_fixed'; end if;
 if old.email_confirmed_at is not null and (new.email_confirmed_at is distinct from old.email_confirmed_at
   or new.confirmation_mail_hash is distinct from old.confirmation_mail_hash) then raise exception 'mail_confirmation_fixed'; end if;
 -- G3: what the person approved never changes under the approval. The person, posting, company and link never change;
 -- the payload and its hashes change only when a refused application (not_submitted) is approved again, and then only
 -- to a payload that hashes to its new approval (career_apply_email_reserve_for's fresh yes).
 if new.user_id is distinct from old.user_id or new.job_id is distinct from old.job_id or new.company is distinct from old.company
  or new.url is distinct from old.url then
  raise exception 'approval_fixed: an application''s person, posting, company and link are immutable'; end if;
 if (new.payload is distinct from old.payload or new.payload_hash is distinct from old.payload_hash or new.approval_hash is distinct from old.approval_hash)
  and (old.state <> 'not_submitted' or new.payload_hash is distinct from public.career_apply_payload_hash(new.payload)
   or new.approval_hash is distinct from new.payload_hash) then
  raise exception 'approval_fixed: an approved application is immutable but for a new approval of one that was not sent'; end if;
 return new;
end $$;

-- The drive holding the job's lease reports that the employer's site refused before anything was sent, for load:
-- 'rate_limited' (429), 'server_busy' (503 with a time to come back) or 'quota'. Never 'bot_wall' (the person's).
-- p_until: until when the workers' shared gate holds the host now (its answer to career_apply_host_refused); null when
-- no gate was told, and then this records the refusal in the host's back-off itself (30 s doubling, as the gate does).
-- p_retry_after_s: the host's own Retry-After, in seconds. The job may be handed out again at the latest of these (at
-- most a day ahead, the longest any gate holds a host), and its host's back-off, in the job's scope, holds at least
-- that long so the claims skip it. Returns the job's id, state, not-before time, host and refusal count.
create or replace function public.career_apply_requeue_refused_for(p_id uuid, p_lease uuid, p_reason text, p_retry_after_s integer,
 p_until timestamptz, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; n timestamptz := coalesce(p_now, clock_timestamp()); h text; sc text; b public.career_apply_host_backoff;
 nb timestamptz; wait int;
begin
 if p_id is null or p_lease is null or p_reason is null or p_reason not in ('rate_limited', 'server_busy', 'quota')
  or (p_retry_after_s is not null and p_retry_after_s < 0) then raise exception 'invalid portal refusal'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease;
 if not found then raise exception 'invalid apply claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text, 0));
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease for update;
 if not found then raise exception 'invalid apply claim'; end if;
 -- Only a drive in progress, from a browser worker, that nothing confirmed: the one the refused run still holds.
 if j.state <> 'driving' or j.attempts <> 1 or j.source is null or j.source not in ('cloud', 'own_computer')
  or j.confirmation_id is not null or j.email_confirmed_at is not null then raise exception 'invalid apply transition'; end if;
 h := public.career_apply_host(j.url); sc := public.career_apply_backoff_scope(j.source, j.user_id);
 if h is null or h = '' then raise exception 'invalid apply claim'; end if;
 select * into b from public.career_apply_host_backoff where scope = sc and host = h for update;
 if p_until is null and p_retry_after_s is null then
  -- No gate was told and the host named no time: this is the refusal's record (the gate's own 30 s doubling).
  wait := least(3600, 30 * power(2, least(coalesce(case when b.last_at > n - interval '1 hour' then b.refusals end, 0), 7))::int);
  nb := n + make_interval(secs => wait);
  insert into public.career_apply_host_backoff (scope, host, until, refusals, last_reason, last_at, updated_at)
  values (sc, h, nb, 1, case when p_reason = 'server_busy' then 'server_busy' else 'rate_limited' end, n, n)
  on conflict (scope, host) do update set until = greatest(career_apply_host_backoff.until, excluded.until),
   refusals = case when career_apply_host_backoff.last_at > n - interval '1 hour' then career_apply_host_backoff.refusals + 1 else 1 end,
   last_reason = excluded.last_reason, last_at = n, updated_at = n
  returning * into b;
  nb := greatest(nb, b.until);
 else
  nb := least(n + interval '1 day', greatest(coalesce(p_until, n), n + make_interval(secs => least(coalesce(p_retry_after_s, 0), 86400))));
  -- The host's back-off in the job's scope holds at least as long (the gate already counted this refusal: not again).
  insert into public.career_apply_host_backoff (scope, host, until, refusals, last_reason, last_at, updated_at)
  values (sc, h, nb, 1, case when p_reason = 'server_busy' then 'server_busy' else 'rate_limited' end, n, n)
  on conflict (scope, host) do update set until = greatest(career_apply_host_backoff.until, excluded.until),
   last_reason = excluded.last_reason, last_at = greatest(career_apply_host_backoff.last_at, n), updated_at = n
  returning * into b;
 end if;
 perform set_config('career.apply_requeue', j.id::text, true);
 update public.career_apply_jobs set state = 'queued', attempts = 0, lease_token = null, claimed_at = null, source = null,
  not_before = nb, host_refusals = host_refusals + 1,
  reason = 'waiting: the employer''s site asked us to slow down (' || case p_reason when 'server_busy' then 'busy' when 'quota' then 'quota'
   else 'too many requests' end || '); nothing was sent, and it goes again by itself after '
   || to_char(nb at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC',
  evidence = evidence || jsonb_build_object('host_refused', jsonb_build_object('at', n, 'reason', p_reason, 'retry_after_s', p_retry_after_s,
   'until', nb, 'host', h, 'source', j.source, 'claimed_at', j.claimed_at, 'refusals', j.host_refusals + 1)),
  updated_at = n
 where id = p_id and lease_token = p_lease and state = 'driving'
 returning * into j;
 perform set_config('career.apply_requeue', '', true);
 if j.id is null or j.state <> 'queued' then raise exception 'invalid apply transition'; end if;
 return jsonb_build_object('id', j.id, 'state', j.state, 'not_before', j.not_before, 'host', h, 'scope', sc, 'refusals', j.host_refusals,
  'wait_seconds', greatest(0, ceil(extract(epoch from j.not_before - n))::int));
end $$;

-- The same for the signed-in person's own computer, only for their own job driven there. The time is the database's.
create or replace function public.career_apply_requeue_refused_own(p_id uuid, p_lease uuid, p_reason text, p_retry_after_s integer, p_until timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception 'not signed in'; end if;
 if not exists (select from public.career_apply_jobs where id = p_id and user_id = u and source = 'own_computer') then raise exception 'invalid apply claim'; end if;
 return public.career_apply_requeue_refused_for(p_id, p_lease, p_reason, p_retry_after_s, p_until, clock_timestamp());
end $$;

revoke all on function public.career_apply_requeue_refused_for(uuid, uuid, text, integer, timestamptz, timestamptz),
 public.career_apply_requeue_refused_own(uuid, uuid, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.career_apply_requeue_refused_for(uuid, uuid, text, integer, timestamptz, timestamptz) to service_role;
grant execute on function public.career_apply_requeue_refused_own(uuid, uuid, text, integer, timestamptz) to authenticated;
