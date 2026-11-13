-- Posting index (docs/architect/POSTING-INDEX.md): the fields the owner's "know every open role, verified live" needs beyond
-- WO-006/069: which ATS, the level (internship...), the stated application deadline, the posting's own requirements text,
-- when we last proved it live, why it closed, and a change signature. Additive and idempotent; NOT applied by the author
-- (the owner runs go-live). No backfill: rows fill in on their board's next read.
alter table public.career_postings add column if not exists ats_type text check (ats_type is null or length(ats_type) <= 40);
alter table public.career_postings add column if not exists level text check (level is null or level in ('internship','entry','mid','senior','lead','executive'));
alter table public.career_postings add column if not exists deadline date;
alter table public.career_postings add column if not exists requirements text check (requirements is null or length(requirements) <= 3000);
alter table public.career_postings add column if not exists last_verified_at timestamptz;
alter table public.career_postings add column if not exists closed_reason text check (closed_reason is null or length(closed_reason) <= 200);
alter table public.career_postings add column if not exists content_sig text check (content_sig is null or length(content_sig) <= 32);

-- Fast filtered search over OPEN postings only (partial indexes stay small as closed rows pile up).
create index if not exists career_postings_open_level_posted on public.career_postings (level, coalesce(posted_at, first_seen_at) desc) where closed_at is null;
create index if not exists career_postings_open_remote_posted on public.career_postings (remote, coalesce(posted_at, first_seen_at) desc) where closed_at is null;
create index if not exists career_postings_open_role_posted on public.career_postings (role_family, coalesce(posted_at, first_seen_at) desc) where closed_at is null;
create index if not exists career_postings_open_company on public.career_postings (lower(company)) where closed_at is null;
create index if not exists career_postings_open_deadline on public.career_postings (deadline) where closed_at is null and deadline is not null;
-- The verification queue: open postings, least recently proven live first.
create index if not exists career_postings_verify_queue on public.career_postings (last_verified_at asc nulls first) where closed_at is null;
