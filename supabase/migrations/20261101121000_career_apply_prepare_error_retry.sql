-- MASS APPLY (2026-11-01, review of #384): a preparation that failed on OUR side (outcome 'error': the engine's browser
-- crashed or timed out, twice; prepare-ahead.ts) is tried again after 30 minutes, not after the 7 days a refusal by the
-- employer's form waits. 20261027141000's candidates, that one clause changed. Idempotent; not applied to any database
-- by this change.
create or replace function public.career_apply_prepare_candidates(p_now timestamptz, p_per_person integer, p_limit integer)
returns table (user_id uuid, job_id text, company text, title text, url text, location text, description text, epoch bigint, version bigint)
language sql stable security definer set search_path = public, pg_temp as $$
 with s as (
  select o.user_id, substr(o.key, 7) as job_id, o.created_at as at
  from public.career_outbox o
  where o.kind = 'alert' and o.key like 'alert:%' and o.created_at > p_now - interval '14 days'
  union all
  select w.user_id, w.posting_key as job_id, w.queued_at as at
  from public.career_apply_wanted w
  where w.state = 'waiting'
 ), a as (
  select s.user_id, s.job_id, max(s.at) as alerted_at from s group by s.user_id, s.job_id
 ), c as (
  select a.user_id, p.job_id, p.company, p.title, p.url, p.location, p.description,
   coalesce((k.value->>'epoch')::bigint, 0) as epoch, coalesce((k.value->>'version')::bigint, 0) as version,
   row_number() over (partition by a.user_id order by a.alerted_at desc, p.job_id) as rn, a.alerted_at
  from a
  join public.career_postings p on p.job_id = a.job_id and p.closed_at is null
  join public.profiles pr on pr.id = a.user_id
  join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account' and coalesce(k.value->>'paused', 'false') <> 'true'
  where not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id)
   and not exists (select from public.career_apply_prepared x where x.user_id = a.user_id and x.job_id = p.job_id)
   and not exists (select from public.career_apply_prepare_attempts t where t.user_id = a.user_id and t.posting_job_id = p.job_id
    and (t.outcome = 'ready'
     or (t.outcome = 'asked' and exists (select from public.career_apply_questions q where q.user_id = a.user_id and q.state = 'open'
      and t.engine_job_id = any(q.job_ids)))
     or (t.outcome = 'error' and t.at > p_now - interval '30 minutes')
     or (t.outcome not in ('asked', 'error') and t.at > p_now - interval '7 days')))
   and public.career_apply_company_key(p.company) <> ''
   and not public.career_apply_posting_sent(a.user_id, p.job_id, p.url, null, true)
 )
 select c.user_id, c.job_id, c.company, c.title, c.url, c.location, c.description, c.epoch, c.version
 from c where c.rn <= greatest(0, coalesce(p_per_person, 0))
 order by c.alerted_at desc, c.user_id, c.job_id
 limit greatest(0, coalesce(p_limit, 0))
$$;
revoke all on function public.career_apply_prepare_candidates(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.career_apply_prepare_candidates(timestamptz, integer, integer) to service_role;
