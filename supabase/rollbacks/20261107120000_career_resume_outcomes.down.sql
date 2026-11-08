-- Reverses 20261107120000_career_resume_outcomes.sql: the view, the trigger and its function, and the three columns it added.
-- career_apply_jobs keeps every column it had before (resume_sha256, tailored and resume_persona are 20261020130000's).
-- The career:resume-versions key in career_watch_kv is left as data; nothing reads it once this is rolled back.
drop view if exists public.career_apply_outcomes_by_resume;
drop trigger if exists career_apply_resume_version_tag on public.career_apply_jobs;
drop function if exists public.career_apply_resume_version_tag();
alter table public.career_apply_jobs drop column if exists resume_change_types;
alter table public.career_apply_jobs drop column if exists resume_layout;
alter table public.career_apply_jobs drop column if exists resume_version;
