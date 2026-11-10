-- WO-122 (D.4 6: a reused sensitive answer is never reused silently): the person's own answers to asked questions, as
-- career_apply_answers_own() returns them, with the postings each question was asked for (job_ids). The person's computer
-- reads it to tell an answer given for this application from one reused from another, so the card can say where a
-- reused answer came from and when. Additive: v1 is unchanged, and the computer falls back to it while v2 is not
-- deployed. Only the caller's own answered rows. Reversible (supabase/rollbacks/20261110180000_career_apply_answers_own_v2.down.sql).
-- Idempotent. Applied to a live database only by the owner's go-live.
create or replace function public.career_apply_answers_own_v2()
returns table (id uuid, key text, kind text, answer text, answered_at timestamptz, job_ids text[])
language sql stable security definer set search_path = public, pg_temp as $$
 select id, key, kind, answer, answered_at, job_ids from public.career_apply_questions where user_id = auth.uid() and state = 'answered' order by answered_at
$$;
revoke all on function public.career_apply_answers_own_v2() from public, anon, authenticated, service_role;
grant execute on function public.career_apply_answers_own_v2() to authenticated;
