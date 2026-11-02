-- Reverses 20261102140000_career_apply_resume_file_restarts_preparation.sql. Tries already forgotten and requests already made stay.
drop trigger if exists career_apply_resume_file_restarts on public.career_apply_cloud_resumes;
drop function if exists public.career_apply_resume_file_restarts();
