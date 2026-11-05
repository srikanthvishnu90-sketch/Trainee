-- Trainee landing page — waitlist survey (owner-ordered 2026-11-04).
-- After joining the waitlist, the site offers "Earn another week free of
-- Trainee": a 3-question form (site/survey.html) whose answers land here,
-- written by the public edge function site-survey with the service role.
-- RLS is enabled with NO public policies, same as site_waitlist: only the
-- service role writes, and reads happen through operator tooling
-- (the key-gated site-admin function).

create table if not exists public.site_waitlist_survey (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  q_career_issues text not null,
  q_platform_issues text not null,
  q_one_thing text not null,
  source text,
  created_at timestamptz not null default now()
);

alter table public.site_waitlist_survey enable row level security;
