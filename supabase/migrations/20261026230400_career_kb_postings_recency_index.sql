-- Launch readiness X3 (2026-10-26): the discovery pool's read is indexed.
--
-- agent-chat reads the newest postings of career_kb_postings (order by posted_at desc nulls last, limit 600, the columns
-- the router scores) on the turns that need a pool. posted_at had no index, so each read sorted the whole table. This
-- index serves that order and limit directly. The read itself now happens only on turns that use postings
-- (agent-chat/career_pool_need.ts); it used to happen on every turn, including "hi".
-- Idempotent. tests/db/career_kb_postings_recency_index.test.sql checks the plan uses it.
create index if not exists career_kb_postings_posted_at_recent
  on public.career_kb_postings (posted_at desc nulls last);
