-- Claimed, never started: back to the queue, then RESUME (owner rule, binding, 2026-10-27: "NO LIMITS ... Back off only
-- when an outside system refuses, then RESUME"; each approved application is submitted at most once). NOT APPLIED: the
-- owner applies migrations.
--
-- Found by the apply scenario battery (PR #289's list of silent drops): an approved application a worker CLAIMED but
-- never STARTED (its engine never ran) was finished not_submitted and lost. The workers end such a claim when the worker
-- is stopping (stop(), a deploy, Ctrl+C), when it could not start inside its lease budget (its host held off by the
-- shared gate, a long queue on this machine), when its host is held and the claim is handed back so the browser is free
-- for hosts that answer, or when its journal line could not be written. Nothing was sent in any of these, the person
-- approved it, and approving the same posting again was refused by the queue's one-row-per-posting rule (duplicate_job):
-- it could never go at all.
--
-- Now the worker puts the SAME job back: state queued, attempts 0, no lease, no source (as before its claim), its
-- approval, payload and payload hash untouched (career_apply_jobs_fixed still freezes them; the requeue's own setting of
-- 20261029180000 lets this one change of source through), not handed out before not_before: now, or the host's hold
-- when the claim was handed back for it (career_apply_jobs_not_before, 20261029180000, on every claim). It runs once
-- later, by any worker, through every claim's checks again.
--
-- Exactly once, kept:
--  - only a drive the worker holds the lease of, from a worker's own computer or the cloud (never the email path or the
--    extension), still inside its 15-minute lease (an older drive is the sweep's: unknown, never driven again), with no
--    confirmation and no proof of any kind: no receipt and no picture of this drive (career_apply_receipts /
--    career_apply_receipt_files are written only after the engine ran). The worker calls it only for a claim whose engine
--    never started (its journal's durable start line, written and synced before any engine, was never written; the
--    worker clears that journal line BEFORE asking, so a crash in between can never start it from the old lease);
--  - a job whose engine started is never put back by this: it ends as its run recorded it, or unknown, never driven again;
--  - the old lease is gone: the run that let it go can record nothing more for this job.
-- After 20261029180000 (career_apply_jobs.not_before, the requeue's setting in career_apply_jobs_fixed). Idempotent.

-- p_why: why the worker let the claim go without starting it ('worker_stopping', 'not_started_in_lease', 'host_held',
-- 'journal_unwritable'). p_until: the host's hold when the claim was handed back for it (null: none); the job is handed out
-- again at the later of it and now, at most a day ahead (the longest any gate holds a host). Returns the job's id, state
-- and not-before time.
create or replace function public.career_apply_requeue_unstarted_for(p_id uuid, p_lease uuid, p_why text, p_until timestamptz,
 p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; n timestamptz := coalesce(p_now, clock_timestamp()); nb timestamptz; proof boolean := false;
begin
 if p_id is null or p_lease is null or p_why is null
  or p_why not in ('worker_stopping', 'not_started_in_lease', 'host_held', 'journal_unwritable') then raise exception 'invalid unstarted reason'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease;
 if not found then raise exception 'invalid apply claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text, 0));
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease for update;
 if not found then raise exception 'invalid apply claim'; end if;
 -- Only a drive in progress, from a browser worker, still inside its lease, that nothing confirmed.
 if j.state <> 'driving' or j.attempts <> 1 or j.source is null or j.source not in ('cloud', 'own_computer')
  or j.confirmation_id is not null or j.email_confirmed_at is not null
  or j.claimed_at is null or j.claimed_at <= n - interval '15 minutes' then raise exception 'invalid apply transition'; end if;
 -- No proof of a run: a receipt or a picture of this drive is written only after its engine ran.
 if to_regclass('public.career_apply_receipt_files') is not null then
  execute 'select exists (select from public.career_apply_receipt_files where application_id = $1)
   or exists (select from public.career_apply_receipts where application_id = $1)' into proof using j.id;
 end if;
 if proof then raise exception 'invalid apply transition'; end if;
 nb := least(n + interval '1 day', greatest(n, coalesce(p_until, n)));
 perform set_config('career.apply_requeue', j.id::text, true);
 update public.career_apply_jobs set state = 'queued', attempts = 0, lease_token = null, claimed_at = null, source = null,
  not_before = nb,
  reason = 'waiting: approved, not started yet (' || case p_why when 'worker_stopping' then 'the worker stopped before starting it'
   when 'host_held' then 'the employer''s site asked us to wait' else 'it could not start in time' end
   || '); nothing was sent, and it goes again by itself' || case when nb > n then ' after ' || to_char(nb at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' else '' end,
  evidence = evidence || jsonb_build_object('unstarted', jsonb_build_object('at', n, 'why', p_why, 'until', nb, 'source', j.source,
   'claimed_at', j.claimed_at, 'returns', coalesce((j.evidence->'unstarted'->>'returns')::int, 0) + 1)),
  updated_at = n
 where id = p_id and lease_token = p_lease and state = 'driving'
 returning * into j;
 perform set_config('career.apply_requeue', '', true);
 if j.id is null or j.state <> 'queued' then raise exception 'invalid apply transition'; end if;
 return jsonb_build_object('id', j.id, 'state', j.state, 'not_before', j.not_before,
  'wait_seconds', greatest(0, ceil(extract(epoch from j.not_before - n))::int));
end $$;

-- The same for the signed-in person's own computer, only for their own job driven there. The time is the database's.
create or replace function public.career_apply_requeue_unstarted_own(p_id uuid, p_lease uuid, p_why text, p_until timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := auth.uid();
begin
 if u is null then raise exception 'not signed in'; end if;
 if not exists (select from public.career_apply_jobs where id = p_id and user_id = u and source = 'own_computer') then raise exception 'invalid apply claim'; end if;
 return public.career_apply_requeue_unstarted_for(p_id, p_lease, p_why, p_until, clock_timestamp());
end $$;

revoke all on function public.career_apply_requeue_unstarted_for(uuid, uuid, text, timestamptz, timestamptz),
 public.career_apply_requeue_unstarted_own(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.career_apply_requeue_unstarted_for(uuid, uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.career_apply_requeue_unstarted_own(uuid, uuid, text, timestamptz) to authenticated;
