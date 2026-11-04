-- Reverses 20261102120000_career_apply_prepare_candidates_for.sql. The global career_apply_prepare_candidates is untouched.
drop function if exists public.career_apply_prepare_candidates_for(uuid, timestamptz, integer, integer);
