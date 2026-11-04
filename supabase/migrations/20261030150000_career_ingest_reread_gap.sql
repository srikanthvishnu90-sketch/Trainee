-- career-ingest: the re-read gap (2026-10-31). CI run 41146111368 (tests/architect/ingest-r2-pg.test.ts, "two runs at
-- once"): "lever:s45b0: read 2 times in one tick". career_board_state_claim (20261030110000_career_ingest_r2.sql) skipped a
-- board only while another run was still reading it (status "reading", claimed under 5 minutes ago). A board whose read had
-- just finished (ok, or fewer than 2 failures) was due again at once, so the second of two overlapping runs, or the next
-- tick, in a lane smaller than a run's capacity read every board the first had just read: twice the requests to the
-- boards, and more HTTP 429s from them.
--   career_board_state_claim(buckets, limit, now, reread_gap_ms): a board attempted less than reread_gap_ms before now,
--   its read finished or not, is not claimed. The failure backoff (fail_count 2: 1 hour, doubling, at most a day) and the
--   in-flight rule stay as they were. The caller passes the gap from its plan: half the slack the headroom leaves,
--   (window - window / 1.5) / 2 = window / 6: 1 hour for the 6-hour default (supabase/functions/_shared/career_shards.ts
--   rereadGapMs; the comment there shows why every board is still read within the window: gap + cycle = window minus
--   half the slack, and the gap is at least an interval when a window holds 6 runs or more).
--   career_board_state_claim(buckets, limit, now): kept (a function deployed before this migration calls it), now the same
--   claim with the gap of the scheduled plan (scripts/launch/schedule-career-ingest.sql: window_min=60, every 5 minutes):
--   10 minutes (career_shards.ts DEFAULT_REREAD_GAP_MS).
-- tests/architect/ingest-reread-gap-pg.test.ts holds this function and career_shards.ts claimable to the same answers.
-- Service role only. Idempotent: applies cleanly twice.

create or replace function public.career_board_state_claim(p_buckets integer[], p_limit integer, p_now timestamptz, p_reread_gap_ms integer)
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
        -- attempted inside the re-read gap, finished or not: not taken again (a clock behind the last attempt: neither)
        and not coalesce(p_reread_gap_ms > 0 and s.last_attempt_at > p_now - p_reread_gap_ms * interval '1 millisecond', false)
        -- failing: waits after its last attempt (2 failures: 1 hour, doubling, at most a day)
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
revoke all on function public.career_board_state_claim(integer[], integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.career_board_state_claim(integer[], integer, timestamptz, integer) to service_role;

-- The 3-argument form: the same claim, the scheduled plan's gap (10 minutes).
create or replace function public.career_board_state_claim(p_buckets integer[], p_limit integer, p_now timestamptz)
returns setof public.career_board_state
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return query select * from public.career_board_state_claim(p_buckets, p_limit, p_now, 10 * 60000);
end $$;
revoke all on function public.career_board_state_claim(integer[], integer, timestamptz) from public, anon, authenticated;
grant execute on function public.career_board_state_claim(integer[], integer, timestamptz) to service_role;
