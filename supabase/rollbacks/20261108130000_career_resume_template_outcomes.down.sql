-- Reverses 20261108130000_career_resume_template_outcomes.sql: back to 20261107120000's view, trigger function and layout
-- check, and the resume_template column dropped. Rows tagged 'template' lose that layout (set to null) so the old check holds.
update public.career_apply_jobs set resume_layout = null where resume_layout = 'template';
drop view if exists public.career_apply_outcomes_by_resume;
create or replace function public.career_apply_resume_version_tag() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
 new.resume_version := null; new.resume_layout := null; new.resume_change_types := '{}';
 if not new.tailored or new.resume_sha256 is null then return new; end if;
 select k.value->'files'->new.resume_sha256 into v from public.career_watch_kv k where k.user_id = new.user_id and k.key = 'career:resume-versions';
 if v is null or jsonb_typeof(v) <> 'object' then return new; end if;
 new.resume_version := case when coalesce(v->>'n', '') ~ '^[1-9][0-9]{0,5}$' then 'resume-v' || (v->>'n') end;
 new.resume_layout := case when v->>'layout' in ('plain', 'trainee', 'own') then v->>'layout' end;
 new.resume_change_types := coalesce((select array_agg(distinct c order by c) from jsonb_array_elements_text(case when jsonb_typeof(v->'changes') = 'array' then v->'changes' else '[]'::jsonb end) c
   where c in ('reorder', 'drop', 'skills', 'reword')), '{}');
 return new;
end $$;
revoke all on function public.career_apply_resume_version_tag() from public, anon, authenticated;

create view public.career_apply_outcomes_by_resume with (security_invoker = true) as
with went as (
  select j.id, j.user_id, j.tailored, j.resume_version, j.resume_layout, j.resume_change_types
  from public.career_apply_jobs j
  where j.state in ('confirmed', 'submitted_unconfirmed', 'unknown_outcome')
), ev as (
  select e.user_id, substr(e.application_ref, 5) as job,
    bool_or(e.kind in ('interview', 'assessment', 'offer')) as interview,
    bool_or(e.kind = 'offer') as offer,
    bool_or(e.kind in ('rejection', 'interview', 'assessment', 'offer', 'recruiter_reply')) as response
  from public.career_mail_events e
  where e.application_ref like 'job:%' and not e.flagged
  group by e.user_id, substr(e.application_ref, 5)
), apps as (
  select w.*, coalesce(ev.response, false) as response, coalesce(ev.interview, false) as interview, coalesce(ev.offer, false) as offer
  from went w left join ev on ev.user_id = w.user_id and ev.job = w.id::text
), keyed as (
  select user_id, 'tailoring'::text as dimension, case when tailored then 'tailored' else 'untailored' end as bucket, response, interview, offer from apps
  union all select user_id, 'version', resume_version, response, interview, offer from apps where resume_version is not null
  union all select user_id, 'layout', resume_layout, response, interview, offer from apps where resume_layout is not null
  union all select a.user_id, 'change_type', c, a.response, a.interview, a.offer from apps a cross join lateral unnest(a.resume_change_types) c
), per as (
  select user_id, dimension, bucket, count(*) as sent,
    count(*) filter (where response) as responses, count(*) filter (where interview) as interviews, count(*) filter (where offer) as offers
  from keyed group by user_id, dimension, bucket
)
select per.*,
  round(100.0 * responses / nullif(sent, 0), 1) as response_per_100,
  round(100.0 * interviews / nullif(sent, 0), 1) as interview_per_100,
  round(100.0 * offers / nullif(sent, 0), 1) as offer_per_100
from per;

revoke all on public.career_apply_outcomes_by_resume from public, anon;
grant select on public.career_apply_outcomes_by_resume to authenticated, service_role;
comment on view public.career_apply_outcomes_by_resume is
  'Release 9: per person, applications sent and responses, interviews and offers (counts and per 100) by resume version, tailored or not, layout and kind of change. From career_apply_jobs (tagged at apply time by career_apply_resume_version_tag) and career_mail_events only.';
alter table public.career_apply_jobs drop column if exists resume_template;
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_resume_layout_check;
alter table public.career_apply_jobs add constraint career_apply_jobs_resume_layout_check
  check (resume_layout is null or resume_layout in ('plain', 'trainee', 'own'));
