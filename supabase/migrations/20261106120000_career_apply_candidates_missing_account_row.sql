-- LIVE BUG (2026-11-06): the prepare-ahead candidate reads INNER JOINED career_watch_kv on key 'career:account' with
-- "paused <> true". A person with no 'career:account' row (34 of 37 live profiles) therefore had NO candidates, whatever they
-- had waiting: the owner's real test (a waiting career_apply_wanted row, open posting, never prepared) was told "no longer open
-- on file ... already prepared ... or applied in 30 days", none of which was true. A missing account row is "not paused";
-- only paused = true stops preparation (as 20261025120000's career_apply_prepare_request_enqueue already reads it).
-- epoch and version were already coalesced to 0 for a missing row (the account RPCs read an absent row as version 0, epoch 0), so
-- the account row is now LEFT JOINed for them only (0/0 when absent), and the pause is a not-exists on a row that says paused = true.
-- Changed: career_apply_prepare_candidates (global; 20261101130000's body) and career_apply_prepare_candidates_for
-- (20261102120000's body). Every other line is byte-identical to those bodies. Other 'career:account' joins were audited and are
-- intentional (see the PR): career_apply_cloud_resume_kept_for (a kept resume exists only with an account: its epoch binding),
-- and the batch/task intent claims (an intent is authority-versioned against the account row).
-- Additive, idempotent, service_role only. Rollback: supabase/rollbacks/20261106120000_career_apply_candidates_missing_account_row.down.sql

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
   row_number() over (partition by a.user_id order by a.alerted_at desc, p.job_id) as rn, a.alerted_at,
   (select max(h.updated_at) from public.career_apply_jobs h where h.user_id = a.user_id and h.job_id = p.job_id
     and public.career_apply_job_history(h)) as stopped_at
  from a
  join public.career_postings p on p.job_id = a.job_id and p.closed_at is null
  join public.profiles pr on pr.id = a.user_id
  left join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account'
  where not exists (select from public.career_watch_kv pk where pk.user_id = a.user_id and pk.key = 'career:account' and coalesce(pk.value->>'paused', 'false') = 'true')
   and not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id
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


revoke all on function public.career_apply_prepare_candidates(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.career_apply_prepare_candidates(timestamptz, integer, integer) to service_role;

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
  left join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account'
  where not exists (select from public.career_watch_kv pk where pk.user_id = a.user_id and pk.key = 'career:account' and coalesce(pk.value->>'paused', 'false') = 'true')
   and not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id
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

