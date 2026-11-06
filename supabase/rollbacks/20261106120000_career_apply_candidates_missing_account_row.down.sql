-- Reverses 20261106120000_career_apply_candidates_missing_account_row.sql: the two candidate reads exactly as 20261101130000 and 20261102120000 left them
-- (a person with no 'career:account' row gets no candidates). Grants unchanged.
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

-- The account rows the backfill and the ensure function wrote STAY: people may have written to them since (pause, facts, epoch), and a default
-- row is read the same as an absent one by every account reader. The three resume functions go back to the bodies below; the ensure function goes.
create or replace function public.career_resume_put(p_user uuid, p_sha256 text, p_kind text, p_ref text, p_filename text, p_bytes bytea,
 p_event text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_resume_record; a jsonb; fname text; stopped jsonb := '{}'::jsonb;
begin
 if p_user is null or coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' or p_kind not in ('file', 'paste') or coalesce(p_event, '') = '' then
  raise exception 'invalid resume record'; end if;
 if p_bytes is not null and encode(sha256(p_bytes), 'hex') <> p_sha256 then raise exception 'invalid resume record'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 select * into r from public.career_resume_record where user_id = p_user for update;
 if found and r.state = 'confirmed' and r.sha256 = p_sha256 then
  return jsonb_build_object('changed', false, 'generation', r.generation);
 end if;
 perform public.career_resume_retire(p_user, clock_timestamp());
 delete from public.career_resume_retired where user_id = p_user and sha256 = p_sha256;
 fname := nullif(left(regexp_replace(coalesce(p_filename, ''), '[/\\\r\n]', ' ', 'g'), 200), '');
 if fname like '.%' then fname := 'resume' || fname; end if;
 insert into public.career_resume_record as x (user_id, state, sha256, kind, source_ref, filename, bytes, confirmation_event_id, confirmed_at, generation, updated_at)
 values (p_user, 'confirmed', p_sha256, p_kind, left(nullif(p_ref, ''), 300), fname,
  case when octet_length(p_bytes) between 1 and 10485760 then p_bytes end, left(p_event, 120), clock_timestamp(), 1, clock_timestamp())
 on conflict (user_id) do update set state = 'confirmed', sha256 = excluded.sha256, kind = excluded.kind, source_ref = excluded.source_ref,
  filename = excluded.filename, bytes = excluded.bytes, confirmation_event_id = excluded.confirmation_event_id,
  confirmed_at = excluded.confirmed_at, generation = x.generation + 1, updated_at = excluded.updated_at
 returning * into r;
 -- The cloud attaches only this file: kept for the account as it is now (its epoch), every other kept file removed.
 delete from public.career_apply_cloud_resumes where user_id = p_user and sha256 <> p_sha256;
 select value into a from public.career_watch_kv where user_id = p_user and key = 'career:account';
 if r.kind = 'file' and r.bytes is not null and octet_length(r.bytes) <= 5242880 and a is not null then
  insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
  values (p_user, r.sha256, coalesce(r.filename, 'resume'), r.bytes, coalesce((a->>'epoch')::bigint, 0))
  on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch;
 else
  delete from public.career_apply_cloud_resumes where user_id = p_user;
 end if;
 stopped := public.career_resume_stop_unbound(p_user, 'replaced', r.confirmed_at);
 return jsonb_build_object('changed', true, 'generation', r.generation, 'stopped', stopped);
end $$;

create or replace function public.career_apply_cloud_resume_put_for(p_user uuid, p_filename text, p_b64 text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare b bytea; h text; a jsonb;
begin
 if p_user is null or p_b64 is null or length(p_b64) > 7200000 then raise exception 'invalid resume'; end if;
 b := decode(p_b64, 'base64');
 h := encode(sha256(b), 'hex');
 select value into a from public.career_watch_kv where user_id = p_user and key = 'career:account';
 if a is null then raise exception 'no_account'; end if;
 insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
 values (p_user, h, p_filename, b, coalesce((a->>'epoch')::bigint, 0))
 on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch,
  created_at = now();
 return h;
end $$;

create or replace function public.career_apply_cloud_resume_kept_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'))
 from public.career_apply_cloud_resumes r join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0) and encode(sha256(r.bytes), 'hex') = r.sha256
 order by r.created_at desc limit 1
$$;

drop function if exists public.career_account_row_ensure(uuid);
