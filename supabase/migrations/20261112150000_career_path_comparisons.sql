-- D-072 (files writers): the store the F-03 Path comparison File is drawn from (FILE-RECORDS.md section 6). Before it, no record of
-- compared directions existed anywhere, so the File could only say "nothing on record".
--
--   career_path_comparisons   the paths a person said they are weighing (offers, tracks, fields), one row per comparison they
--                             made in chat, newest last (version 1, 2, ...). Each direction is stored as the person named it, the
--                             words they used, and rows that point at their own facts: what they said, the confirmed facts that
--                             relate, an offer they told Trainee about. Each row names its source; a value the person did not
--                             give or confirm is never stored (D-007), and no reach, odds or timing is predicted.
--
-- Owner only (RLS select own rows; no client writes; the service role writes from agent-chat's compare_paths tool). Versions,
-- not overwrites: a row's content never changes after insert (a trigger refuses it); a new comparison is a new version. Delete
-- with the account (on delete cascade). Additive and reversible
-- (supabase/rollbacks/20261112150000_career_path_comparisons.down.sql). Idempotent.

create table if not exists public.career_path_comparisons (
 id bigserial primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 version integer not null check (version >= 1),
 title text not null check (length(title) between 1 and 120),
 directions jsonb not null check (jsonb_typeof(directions) = 'array' and jsonb_array_length(directions) between 2 and 4),
 said text not null check (length(said) between 1 and 600),
 confirmed_facts integer not null default 0 check (confirmed_facts >= 0),
 created_at timestamptz not null default now(),
 unique (user_id, version)
);

-- Versions, not overwrites: a comparison is never changed after it is written.
create or replace function public.career_path_comparisons_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 raise exception 'a path comparison is never overwritten; insert a new version' using errcode = 'check_violation';
end $$;
drop trigger if exists career_path_comparisons_guard on public.career_path_comparisons;
create trigger career_path_comparisons_guard before update on public.career_path_comparisons for each row execute function public.career_path_comparisons_guard();

alter table public.career_path_comparisons enable row level security;
drop policy if exists career_path_comparisons_own on public.career_path_comparisons;
create policy career_path_comparisons_own on public.career_path_comparisons for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.career_path_comparisons from public, anon, authenticated;
grant select on public.career_path_comparisons to authenticated;
grant all on public.career_path_comparisons to service_role;
grant usage, select on sequence public.career_path_comparisons_id_seq to service_role;
revoke all on function public.career_path_comparisons_guard() from public, anon, authenticated;
