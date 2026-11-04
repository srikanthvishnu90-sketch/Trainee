-- MASS APPLY (2026-11-02): the sandbox's candidate read was the GLOBAL career_apply_prepare_candidates(p_now, 25, 500), filtered to the
-- request's person only afterwards. With more than ~500 newer candidate rows from any people, a waiting person got zero candidates and
-- was told the posting was no longer open on file. This adds the per-person read: the SAME selection as
-- 20261101130000_career_apply_reprepare_needs_answers.sql section 4, with the person named at the start of the CTEs, so p_limit and
-- p_per_person count that person's rows only. The global function is not changed. Additive, idempotent, service_role only.
-- Rollback: supabase/rollbacks/20261102120000_career_apply_prepare_candidates_for.down.sql

create or replace function public.career_apply_prepare_candidates_for(p_user uuid, p_now timestamptz, p_per_person integer, p_limit integer)
returns table (user_id uuid, job_id text, company text, title text, url text, location text, description text, epoch bigint, version bigint)
language sql stable security definer set search_path = public, pg_temp as $$
 with s as (
  select o.user_id, substr(o.key, 7) as job_id, o.created_at as at
  from public.career_outbox o
  where o.user_id = p_user and o.kind = 'alert' and o.key like 'alert:%' and o.created_at > p_now - interval '14 days'
  union all
  select w.user_id, w.posting_key as job_id, w.queued_at as at
  from public.career_apply_wanted w
  where w.user_id = p_user and w.state = 'waiting'
 ), a as (
  select s.user_id, s.job_id, max(s.at) as alerted_at from s group by s.user_id, s.job_id
 ), c as (
  select a.user_id, p.job_id, p.company, p.title, p.url, p.location, p.description,
   coalesce((k.value->>'epoch')::bigint, 0) as epoch, coalesce((k.value->>'version')::bigint, 0) as version,
   row_number() over (partition by a.user_id order by a.alerted_at desc, p.job_id) as rn, a.alerted_at,
   (select max(h.updated_at) from public.career_apply_jobs h where h.user_id = a.user_id and h.job_id = p.job_id
     and public.career_apply_job_history(h)) as stopped_at
  from a
  join public.career_postings p on p.job_id = a.job_id and p.closed_at is null
  join public.profiles pr on pr.id = a.user_id
  join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account' and coalesce(k.value->>'paused', 'false') <> 'true'
  where not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id
     and not public.career_apply_job_history(j))
   and public.career_apply_company_key(p.company) <> ''
   and not public.career_apply_posting_sent(a.user_id, p.job_id, p.url, null, true)
 )
 select c.user_id, c.job_id, c.company, c.title, c.url, c.location, c.description, c.epoch, c.version
 from c
 where c.rn <= greatest(0, coalesce(p_per_person, 0))
  and not exists (select from public.career_apply_prepared x where x.user_id = c.user_id and x.job_id = c.job_id
   and (c.stopped_at is null or x.created_at > c.stopped_at))
  and not exists (select from public.career_apply_prepare_attempts t where t.user_id = c.user_id and t.posting_job_id = c.job_id
   and (c.stopped_at is null or t.at > c.stopped_at)
   and (t.outcome = 'ready'
    or (t.outcome = 'asked' and exists (select from public.career_apply_questions q where q.user_id = c.user_id and q.state = 'open'
     and t.engine_job_id = any(q.job_ids)))
    or (t.outcome = 'error' and t.at > p_now - interval '30 minutes')
    or (t.outcome not in ('asked', 'error') and t.at > p_now - interval '7 days')))
 order by c.alerted_at desc, c.user_id, c.job_id
 limit greatest(0, coalesce(p_limit, 0))
$$;

revoke all on function public.career_apply_prepare_candidates_for(uuid, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.career_apply_prepare_candidates_for(uuid, timestamptz, integer, integer) to service_role;
