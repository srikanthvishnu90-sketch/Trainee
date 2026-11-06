-- LIVE BUG (2026-11-06): the prepare-ahead candidate reads INNER JOINED career_watch_kv on key 'career:account' with
-- "paused <> true". A person with no 'career:account' row (34 of 37 live profiles) therefore had NO candidates, whatever they
-- had waiting: the owner's real test (a waiting career_apply_wanted row, open posting, never prepared) was told "no longer open
-- on file ... already prepared ... or applied in 30 days", none of which was true. A missing account row is "not paused";
-- only paused = true stops preparation (as 20261025120000's career_apply_prepare_request_enqueue already reads it).
-- epoch and version were already coalesced to 0 for a missing row (the account RPCs read an absent row as version 0, epoch 0), so
-- the account row is now LEFT JOINed for them only (0/0 when absent), and the pause is a not-exists on a row that says paused = true.
-- Changed: career_account_row_ensure + backfill + career_resume_put, career_apply_cloud_resume_put_for, career_apply_cloud_resume_kept_for (below); career_apply_prepare_candidates (global; 20261101130000's body) and career_apply_prepare_candidates_for
-- (20261102120000's body). Every other line is byte-identical to those bodies. Other 'career:account' joins were audited and are
-- intentional (see the PR): career_apply_cloud_resume_kept_for (a kept resume exists only with an account: its epoch binding),
-- and the batch/task intent claims (an intent is authority-versioned against the account row).
-- EVERY PERSON HAS THE ACCOUNT ROW (review of PR #547): a person with no 'career:account' row also could not keep a cloud resume
-- (career_resume_put writes career_apply_cloud_resumes only with the row; career_apply_cloud_resume_put_for raises no_account;
-- career_apply_cloud_resume_kept_for inner-joins it) and career_apply_current is false for them. So: (1) a one-time backfill gives every
-- profile without the row the minimal default every account writer already reads an absent row as, {"version":0,"epoch":0}
-- (20261015020000, 20261020120100, 20261026090009: coalesce(a, that)); the BEFORE INSERT career_account_authority trigger stamps
-- authority_version = version as for any insert; never overwriting (on conflict do nothing); idempotent. (2) A person created later
-- gets the row at the first thing that needs it: career_account_row_ensure(p_user), called by career_resume_put and
-- career_apply_cloud_resume_put_for (a profiles trigger was tried and dropped: it breaks the ~60 architect tests that insert a profile and then
-- the account row in a separate statement, and every account writer upserts the row anyway, which is how batch/task intents get theirs).
-- kept_for LEFT JOINs the row (epoch 0 when absent). Erase keeps working: it deletes the person's keys, then writes the account row back
-- (epoch + 1, paused), so the row is never absent after it.
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

-- ---------------------------------------------------------------------------------------------- every person has the account row
create or replace function public.career_account_row_ensure(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a jsonb;
begin
 insert into public.career_watch_kv (user_id, key, value)
 select p_user, 'career:account', '{"version":0,"epoch":0}'::jsonb
 where exists (select from auth.users u where u.id = p_user)
 on conflict (user_id, key) do nothing;
 select value into a from public.career_watch_kv where user_id = p_user and key = 'career:account';
 return a;
end $$;
revoke all on function public.career_account_row_ensure(uuid) from public, anon, authenticated;
grant execute on function public.career_account_row_ensure(uuid) to service_role;

insert into public.career_watch_kv (user_id, key, value)
select p.id, 'career:account', '{"version":0,"epoch":0}'::jsonb
from public.profiles p
where exists (select from auth.users u where u.id = p.id)
 and not exists (select from public.career_watch_kv k where k.user_id = p.id and k.key = 'career:account')
on conflict (user_id, key) do nothing;

-- career_resume_put: the account row is ensured (not required) before the cloud copy is kept.
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
 a := public.career_account_row_ensure(p_user);
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

-- Only the line reading the account row differs from 20261026230017's body: it is ensured, so no_account is raised only for a person who does not exist.
create or replace function public.career_apply_cloud_resume_put_for(p_user uuid, p_filename text, p_b64 text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare b bytea; h text; a jsonb;
begin
 if p_user is null or p_b64 is null or length(p_b64) > 7200000 then raise exception 'invalid resume'; end if;
 b := decode(p_b64, 'base64');
 h := encode(sha256(b), 'hex');
 a := public.career_account_row_ensure(p_user);
 if a is null then raise exception 'no_account'; end if;
 insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
 values (p_user, h, p_filename, b, coalesce((a->>'epoch')::bigint, 0))
 on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch,
  created_at = now();
 return h;
end $$;

-- The kept resume is read for the current account epoch; a person with no row has epoch 0.
create or replace function public.career_apply_cloud_resume_kept_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'))
 from public.career_apply_cloud_resumes r left join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0) and encode(sha256(r.bytes), 'hex') = r.sha256
 order by r.created_at desc limit 1
$$;

