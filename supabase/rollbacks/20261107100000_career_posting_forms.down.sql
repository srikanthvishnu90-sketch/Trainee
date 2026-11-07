-- Reverses 20261107100000 (WO-121): the form-capture table and its three functions. The captured forms are derived data
-- (read again from the public boards on the next run), so dropping them loses nothing a person gave.
drop function if exists public.career_form_readiness(interval);
drop function if exists public.career_posting_forms_put(jsonb);
drop function if exists public.career_posting_forms_todo(timestamptz, int);
drop table if exists public.career_posting_forms;
