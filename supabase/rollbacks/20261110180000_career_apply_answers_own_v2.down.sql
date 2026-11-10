-- Rollback of 20261110180000_career_apply_answers_own_v2.sql (WO-122). Drops v2 only; career_apply_answers_own() (v1) and
-- every stored question and answer are untouched, and the person's computer falls back to v1.
drop function if exists public.career_apply_answers_own_v2();
