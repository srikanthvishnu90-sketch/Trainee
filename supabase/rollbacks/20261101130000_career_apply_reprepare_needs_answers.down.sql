-- Reverses 20261101130000_career_apply_reprepare_needs_answers.sql. Refuses while a person has a history row and a live row
-- for the same posting (the old unique constraint cannot hold then): those must be resolved first, by hand.
do $d$ begin
 if exists (select from public.career_apply_jobs group by user_id, job_id having count(*) > 1) then
  raise exception 'rollback refused: some postings have a history row and a live row (unique(user_id, job_id) cannot be restored)';
 end if;
end $d$;
drop trigger if exists career_apply_reprepare_on_needs_answers on public.career_apply_jobs;
drop trigger if exists career_apply_history_approval_guard on public.career_apply_jobs;
drop function if exists public.career_apply_history_approval_guard();
drop function if exists public.career_apply_reprepare_on_needs_answers();
alter table public.career_apply_jobs add constraint career_apply_jobs_user_id_job_id_key unique (user_id, job_id);
drop index if exists public.career_apply_jobs_live_posting;
-- The rewrites, reversed by the same anchors.
do $d$
declare r text[][] := array[
 array['public.career_apply_enqueue(jsonb,text,text,integer)', E'if exists(select from public.career_apply_jobs x where x.user_id=u and x.job_id=p_payload->>''job_id'' and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;', E'if exists(select from public.career_apply_jobs where user_id=u and job_id=p_payload->>''job_id'') then raise exception ''duplicate_job''; end if;'],
 array['public.career_apply_prepare_own(jsonb,text[])', E'if exists (select from public.career_apply_jobs x where x.user_id = u and x.job_id = p_payload->>''job_id'' and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;', E'if exists (select from public.career_apply_jobs where user_id = u and job_id = p_payload->>''job_id'') then raise exception ''duplicate_job''; end if;'],
 array['public.career_apply_record_own(text,text,text,text)', E'if exists (select from public.career_apply_jobs x where x.user_id = u and x.job_id = p_job_id and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;', E'if exists (select from public.career_apply_jobs where user_id = u and job_id = p_job_id) then raise exception ''duplicate_job''; end if;'],
 array['public.career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)', E'select * into prior from public.career_apply_jobs x where x.user_id = p_user and x.job_id = p_payload->>''job_id'' and not public.career_apply_job_history(x) for update;', E'select * into prior from public.career_apply_jobs where user_id = p_user and job_id = p_payload->>''job_id'' for update;'],
 array['public.career_apply_pending_for(uuid)', E'and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '''')) and not public.career_apply_job_history(j))', E'and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '''')))'],
 array['public.career_apply_status_for(uuid,text)', E'from (select * from public.career_apply_jobs h where h.user_id = p_user and (p_job_id is null or h.job_id = p_job_id) and not (public.career_apply_job_history(h) and exists (select from public.career_apply_jobs l where l.user_id = h.user_id and l.job_id = h.job_id and l.id <> h.id and l.created_at > h.created_at)) order by h.updated_at desc limit 200) j', E'from (select * from public.career_apply_jobs where user_id = p_user and (p_job_id is null or job_id = p_job_id) order by updated_at desc limit 200) j'],
 array['public.career_apply_prepare_for(uuid,text,jsonb,text[])', E'if exists (select from public.career_apply_jobs x where x.user_id = p_user and x.job_id in (p_payload->>''job_id'', p_posting_job_id) and not public.career_apply_job_history(x)) then\n  raise exception ''duplicate_job''; end if;', E'if exists (select from public.career_apply_jobs where user_id = p_user and job_id in (p_payload->>''job_id'', p_posting_job_id)) then\n  raise exception ''duplicate_job''; end if;']];
 i int;
begin
 for i in 1 .. array_length(r, 1) loop perform public.career_apply_mass_submit_rewrite(r[i][1], array[r[i][2], r[i][3]]); end loop;
end $d$;
-- 20261031000000's reconcile again.
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 perform public.career_apply_submit_worker_install();
 perform public.career_apply_cloud_authorize_closed_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;
drop function if exists public.career_apply_reprepare_install();
-- 20261101121000's candidates.
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
drop function if exists public.career_apply_job_history(public.career_apply_jobs);
