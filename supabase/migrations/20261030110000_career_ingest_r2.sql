-- career-ingest, round 2 (2026-10-30 scenario battery: tests/architect/scenarios-ingest-r2*.test.ts and
-- tests/architect/ingest-r2-pg.test.ts). Measured on the live project the same day: 136 boards at "failed: HTTP 404" with
-- fail_count up to 69 (read every hour for days), 7 of them still listing 65 open postings; 113 boards at "HTTP 429".
--   1. career_board_state_claim(buckets, limit, now): a lane run's boards taken in one statement. The due boards (never
--      read first, then the oldest attempt) are locked SKIP LOCKED, marked attempted ("reading") and returned as they were
--      before. The run used to read the due list and then record its claim in a second request, so two runs of one lane
--      (an overlapping tick, a re-planned schedule, a manual call) both took the same boards and both wrote their postings:
--      the second upsert moved a posting's first_seen_at and both runs counted it new. A board that keeps failing waits
--      after its last attempt (fail_count 2: 1 hour, then 2, 4, 8, 16, then once a day; career_shards.ts retryAfterMs is
--      the same arithmetic): a gone or refusing board is no longer asked every window for ever. A board another run claimed
--      under 5 minutes ago and is still reading is not taken (career_shards.ts IN_FLIGHT_MS): in a lane smaller than a
--      run's capacity the second of two overlapping runs used to take every board the first had just claimed.
--   2. A posting closed (career_postings.closed_at set) closes the applications still queued for it, unsent and unclaimed,
--      as not sent with the reason: the dispatch claims (career_apply_claim_fair, career_apply_vm_claim) never looked at the
--      posting, so an application approved for a posting the employer took down was still driven to its form.
-- Service role only. Idempotent: applies cleanly twice.

-- 1. the claim
create or replace function public.career_board_state_claim(p_buckets integer[], p_limit integer, p_now timestamptz)
returns setof public.career_board_state
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_now is null or coalesce(p_limit, 0) <= 0 or coalesce(cardinality(p_buckets), 0) = 0 then return; end if;
  return query
    with picked as (
      select s.provider, s.board from public.career_board_state s
      where s.bucket = any (p_buckets)
        -- being read by another run now (claimed under 5 minutes ago, not finished): not taken again
        and not coalesce(s.last_status = 'reading' and s.last_attempt_at > p_now - interval '5 minutes', false)
        and (s.last_attempt_at is null or s.fail_count < 2
          or s.last_attempt_at <= p_now - least(interval '24 hours', interval '1 hour' * power(2, least(30, s.fail_count - 2))))
      order by s.last_attempt_at asc nulls first, s.provider, s.board
      limit least(p_limit, 2000)
      for update skip locked),
    was as (select s.* from public.career_board_state s join picked p on p.provider = s.provider and p.board = s.board),
    mark as (update public.career_board_state s set last_attempt_at = p_now, last_status = 'reading', updated_at = now()
      from picked p where p.provider = s.provider and p.board = s.board returning s.provider)
    select w.* from was w order by w.last_attempt_at asc nulls first, w.provider, w.board;
end $$;
revoke all on function public.career_board_state_claim(integer[], integer, timestamptz) from public, anon, authenticated;
grant execute on function public.career_board_state_claim(integer[], integer, timestamptz) to service_role;

-- 2. a closed posting closes the applications still waiting to be sent to it
create index if not exists career_apply_jobs_queued_job on public.career_apply_jobs (job_id) where state = 'queued';
create or replace function public.career_apply_posting_closed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    update public.career_apply_jobs j set state = 'not_submitted',
      reason = 'not sent: the employer closed this posting before it was sent',
      evidence = j.evidence || jsonb_build_object('closed_at', new.closed_at, 'closed', 'posting_closed'), updated_at = now()
      where j.job_id = new.job_id and j.state = 'queued' and j.attempts = 0;
  exception when others then
    -- The ingest run's close stands either way; the claim's own re-checks still apply to what stays queued.
    raise warning 'career_apply_posting_closed: % (%)', sqlerrm, new.job_id;
  end;
  return null;
end $$;
revoke all on function public.career_apply_posting_closed() from public, anon, authenticated;
drop trigger if exists career_postings_closed_apply on public.career_postings;
create trigger career_postings_closed_apply after update of closed_at on public.career_postings
  for each row when (old.closed_at is null and new.closed_at is not null) execute function public.career_apply_posting_closed();
