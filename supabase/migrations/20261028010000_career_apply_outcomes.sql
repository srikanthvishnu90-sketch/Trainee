-- COMPETITIVE-BAR G2 / B10 (owner 2026-10-27): outcomes, measured per 100 applications, from state only.
-- An application counts as sent when the queue recorded that it reached the employer, or may have
-- (confirmed, submitted_unconfirmed, unknown_outcome). It counts as confirmed only when the employer's own email
-- confirmed it (email_confirmed_at, WO-032/WO-039). An interview, offer, rejection or reply counts only when a
-- career_mail_events row filed under that application (job:<id>) says so and was not flagged. Nothing is estimated.
-- security_invoker: a person reads only their own rows (the tables' own policies); the service role reads all, for
-- evals and launch metrics. Additive and idempotent: a view only, no table or row changes.
create or replace view public.career_apply_outcomes with (security_invoker = true) as
with went as (
  select j.id, j.user_id, coalesce(j.claimed_at, j.created_at) as sent_at, j.email_confirmed_at
  from public.career_apply_jobs j
  where j.state in ('confirmed', 'submitted_unconfirmed', 'unknown_outcome')
), ev as (
  select e.user_id, substr(e.application_ref, 5) as job,
    min(e.mail_at) filter (where e.kind in ('interview', 'assessment', 'offer')) as interview_at,
    bool_or(e.kind = 'offer') as offer,
    bool_or(e.kind = 'rejection') as rejection,
    bool_or(e.kind in ('rejection', 'interview', 'assessment', 'offer', 'recruiter_reply')) as reply
  from public.career_mail_events e
  where e.application_ref like 'job:%' and not e.flagged
  group by e.user_id, substr(e.application_ref, 5)
), per as (
  select w.user_id,
    count(*) as sent,
    count(*) filter (where w.email_confirmed_at is not null) as confirmed,
    count(*) filter (where ev.interview_at is not null) as interviews,
    count(*) filter (where ev.offer) as offers,
    count(*) filter (where ev.rejection) as rejections,
    count(*) filter (where ev.reply) as replies,
    count(*) filter (where w.sent_at > now() - interval '7 days') as sent_7d,
    count(*) filter (where w.email_confirmed_at > now() - interval '7 days') as confirmed_7d,
    count(*) filter (where ev.interview_at > now() - interval '7 days') as interviews_7d
  from went w
  left join ev on ev.user_id = w.user_id and ev.job = w.id::text
  group by w.user_id
)
select per.*,
  round(100.0 * confirmed / nullif(sent, 0), 1) as confirmed_per_100,
  round(100.0 * interviews / nullif(sent, 0), 1) as interviews_per_100,
  round(100.0 * offers / nullif(sent, 0), 1) as offers_per_100,
  round(100.0 * replies / nullif(sent, 0), 1) as replies_per_100
from per;

revoke all on public.career_apply_outcomes from public, anon;
grant select on public.career_apply_outcomes to authenticated, service_role;
comment on view public.career_apply_outcomes is
  'B10: per person, applications sent, confirmed by the employer''s email, interviews, offers, rejections and replies, all-time, last 7 days, and per 100 sent. From career_apply_jobs and career_mail_events only.';
