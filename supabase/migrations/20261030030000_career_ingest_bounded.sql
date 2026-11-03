-- career-ingest, bounded (2026-10-30 production fix). Measured on the live project 2026-10-29/30: about 20% of lane runs
-- failed every hour; "touch postings" / "write postings: canceling statement due to statement timeout" (PostgREST's 8 s);
-- career_postings ~580,000 rows (3.2 GB), 990,822 updates of which only 67,318 (7%) HOT; the touch (last_seen_at only)
-- averaged 90 ms per 100 rows with a 7.9 s maximum, the upsert 55 ms with 7.9 s (pg_stat_statements). A touch that is not
-- a HOT update writes a new row version that every index must point at, the GIN search index included: the whole
-- tsvector of a description up to 20,000 characters, again, for a row whose text did not change. With fastupdate on those
-- entries pile into the GIN pending list until the statement that crosses gin_pending_list_limit (4 MB) has to merge it
-- all into the index, and that one statement runs past the timeout. Rehearsed on the flow harness (6,000 postings of
-- 15,000 characters, 100-row touches): before, median 506 ms, max 1,271 ms, 10% HOT; after 1-2 below, 314 / 588 ms on
-- the first round, 156 / 240 ms by the third with 61% of touches HOT.
--   1. The GIN index writes through (fastupdate off: no pending list, so no merge inside a random statement), and the
--      pending list there is now is merged once, here.
--   2. Fill factor 85: a row version written from now on lands on a page with room, so its next touch can be HOT (no
--      index writes at all). The table is not rewritten (no lock beyond the ALTER); rows move as they are next written.
--   3. career_postings_known(ids): the rows a run compares against, without descriptions (the description's SHA-256 in
--      their place), by POST: no URL limit (100 long Workday ids made ~13 KB URLs: "error sending request") and no 20 KB
--      of text per posting read back into the function's memory.
--   4. career_board_state.pass_offset / pass_started_at: a board larger than one run's posting budget (one Lever board
--      lists 4,600 postings) is read in parts over several runs.
--   5. career_ingest_runs.status / error: a run's row is written when it starts ('started') and completed when it ends
--      ('done', or 'failed' with its error), so a run the platform stops, or one that fails, is never silent.
-- The function also writes at most 50 rows (1 MB) and touches at most 100 ids a statement, and retries a statement that
-- times out as two halves before failing only that board. Idempotent: applies cleanly twice.

-- 1. the GIN index writes through
alter index public.career_postings_search set (fastupdate = off);
select pg_catalog.gin_clean_pending_list('public.career_postings_search'::regclass);
-- 2. room for HOT updates
alter table public.career_postings set (fillfactor = 85);

-- 3. the stored rows a run compares against, without descriptions
create or replace function public.career_postings_known(p_ids text[])
returns table (job_id text, provider text, board text, ats_id text, company text, title text, location text, url text,
  department text, posted_at timestamptz, remote text, role_family text, seniority_band text, apply_email text, pay text,
  first_seen_at timestamptz, last_seen_at timestamptz, closed_at timestamptz, description_sha text)
language plpgsql stable set search_path = pg_catalog, public as $$
begin
  if coalesce(cardinality(p_ids), 0) > 1000 then
    raise exception 'career_postings_known: at most 1000 ids a call (got %)', cardinality(p_ids);
  end if;
  return query
    select p.job_id, p.provider, p.board, p.ats_id, p.company, p.title, p.location, p.url, p.department, p.posted_at, p.remote,
      p.role_family, p.seniority_band, p.apply_email, p.pay, p.first_seen_at, p.last_seen_at, p.closed_at,
      encode(sha256(convert_to(p.description, 'UTF8')), 'hex')
    from public.career_postings p where p.job_id = any(p_ids);
end $$;
revoke all on function public.career_postings_known(text[]) from public, anon, authenticated;
grant execute on function public.career_postings_known(text[]) to service_role;

-- 4. a board read in parts
alter table public.career_board_state add column if not exists pass_offset int not null default 0;
alter table public.career_board_state add column if not exists pass_started_at timestamptz;
alter table public.career_board_state drop constraint if exists career_board_state_pass_check;
alter table public.career_board_state add constraint career_board_state_pass_check
  check (pass_offset >= 0 and (pass_offset = 0) = (pass_started_at is null));

-- 5. a run's row from its start; failed runs carry their error
alter table public.career_ingest_runs add column if not exists status text not null default 'done';
alter table public.career_ingest_runs add column if not exists error text;
alter table public.career_ingest_runs drop constraint if exists career_ingest_runs_status_check;
alter table public.career_ingest_runs add constraint career_ingest_runs_status_check
  check (status in ('started', 'done', 'failed') and (error is null or length(error) <= 1000) and (status <> 'failed' or error is not null));
