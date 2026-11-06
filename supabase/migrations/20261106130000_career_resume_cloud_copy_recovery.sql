-- G2 (review of PR #547/#549): 20261106120000 backfilled the missing 'career:account' rows but not the CLOUD COPIES of resumes already confirmed.
-- Before it, career_resume_put confirmed a file and skipped/deleted its career_apply_cloud_resumes copy because the account row was absent;
-- a re-upload of the same file returned early (same confirmed hash) before the row was ensured or the copy written, so cloud preparation
-- still reported no_resume. Two changes:
-- (1) career_resume_put: on the same-hash early return the account row is ensured and a MISSING cloud copy is written at the account's
--     current epoch (not when paused). The resume record (generation, hash, bytes) and the account row are not changed. Every other line is
--     byte-identical to 20261106120000's body.
-- (2) one-time recovery: the file bytes are kept in career_resume_record.bytes, so they ARE recoverable in SQL. A cloud copy is restored for
--     a confirmed file resume (bytes <= 5 MB, hash matches) that has no cloud copy, only when the account is not paused, its privacy epoch is
--     still 0 (an erase or revocation raises it and deletes the copies; nobody who erased is revived), and the person did not turn the cloud
--     off (career_apply_cloud_optin enabled = false deletes the copies on purpose). Written at the account's current epoch. Idempotent.
-- (3) career_resume_take routes an already-confirmed hash through that repair (one line changed). (4) The recovery runs per person under the opt-out/account lock.
-- (5) An explicit cloud opt-out (career_apply_cloud_optin.enabled = false, which deletes the copies) is respected by BOTH career_resume_put paths:
--     the new-hash path wrote the copy regardless (pre-existing), so did the same-hash repair. Opting back in (enabled = true) lifts it.
--     The recovery loop takes the per-person locks in user_id order (as career_apply_cloud_text_claim_at does); they are held to the end of this
--     migration's transaction (a migration cannot commit per person): a short window, one tiny insert per affected person, and writers wait, not fail.
-- Service_role only. Rollback: supabase/rollbacks/20261106130000_career_resume_cloud_copy_recovery.down.sql

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
  -- Same file again: nothing about the record changes (generation, authority). Only a cloud copy that is missing is put back
  -- (a file confirmed before 20261106120000 had none: its account row did not exist), for the account as it is now.
  a := public.career_account_row_ensure(p_user);
  if r.kind = 'file' and r.bytes is not null and octet_length(r.bytes) <= 5242880 and a is not null
   and coalesce(a->>'paused', 'false') <> 'true'
   and not exists (select from public.career_apply_cloud_optin o where o.user_id = p_user and o.enabled = false)
   and not exists (select from public.career_apply_cloud_resumes c where c.user_id = p_user and c.sha256 = r.sha256) then
   insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
   values (p_user, r.sha256, coalesce(r.filename, 'resume'), r.bytes, coalesce((a->>'epoch')::bigint, 0))
   on conflict (user_id, sha256) do nothing;
  end if;
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
 if r.kind = 'file' and r.bytes is not null and octet_length(r.bytes) <= 5242880 and a is not null
  and not exists (select from public.career_apply_cloud_optin o where o.user_id = p_user and o.enabled = false) then
  insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
  values (p_user, r.sha256, coalesce(r.filename, 'resume'), r.bytes, coalesce((a->>'epoch')::bigint, 0))
  on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch;
 else
  delete from public.career_apply_cloud_resumes where user_id = p_user;
 end if;
 stopped := public.career_resume_stop_unbound(p_user, 'replaced', r.confirmed_at);
 return jsonb_build_object('changed', true, 'generation', r.generation, 'stopped', stopped);
end $$;

revoke all on function public.career_resume_put(uuid, text, text, text, text, bytea, text) from public, anon, authenticated;
grant execute on function public.career_resume_put(uuid, text, text, text, text, bytea, text) to service_role;


-- career_resume_take: a confirmation of the resume that is already theirs also repairs a missing cloud copy (it returned before career_resume_put).
create or replace function public.career_resume_take(p_user uuid, p_detail jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare u jsonb := p_detail->'upload'; sha text := p_detail->'upload'->>'sha256'; ref text := p_detail->'upload'->>'ref';
 msg text; up record; b bytea; fname text; m text[];
begin
 if coalesce(p_detail->>'via', '') <> 'router: their yes to the resume entries shown to them' or jsonb_typeof(u) is distinct from 'object'
    or coalesce(sha, '') !~ '^[a-f0-9]{64}$' or coalesce(p_detail->>'confirmation_event_id', '') = '' then return false; end if;
 if exists (select from public.career_resume_record where user_id = p_user and state = 'confirmed' and sha256 = sha) then
  -- Already their resume: nothing about the record changes, but a missing cloud copy is repaired (career_resume_put's same-hash path).
  perform public.career_resume_put(p_user, sha, (select kind from public.career_resume_record where user_id = p_user), null, null, null, p_detail->>'confirmation_event_id');
  return false;
 end if;
 if u->>'kind' = 'message' then
  m := regexp_match(coalesce(ref, ''), '^agent_messages:([0-9]{1,18})$');
  if m is null then return false; end if;
  select x.content into msg from public.agent_messages x join public.agent_threads t on t.id = x.thread_id
   where x.id = m[1]::bigint and t.user_id = p_user and x.role = 'user';
  if msg is null then return false; end if;
  b := convert_to(msg, 'UTF8');
  if encode(sha256(b), 'hex') <> sha then return false; end if;
  perform public.career_resume_put(p_user, sha, 'paste', ref, null, b, p_detail->>'confirmation_event_id');
 elsif u->>'kind' = 'file' then
  m := regexp_match(coalesce(ref, ''), '\(career_resume_uploads:([0-9a-f-]{36})\)$');
  if m is not null and to_regclass('public.career_resume_uploads') is not null then
   execute 'select filename, decode(content_b64, ''base64'') as bytes from public.career_resume_uploads where id = $1::uuid and user_id = $2 and sha256 = $3'
    into up using m[1], p_user, sha;
   if up.bytes is null or encode(sha256(up.bytes), 'hex') <> sha then return false; end if;
   b := up.bytes; fname := up.filename;
  end if;
  perform public.career_resume_put(p_user, sha, 'file', ref, fname, b, p_detail->>'confirmation_event_id');
 else
  return false;
 end if;
 return true;
end $$;
revoke all on function public.career_resume_take(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.career_resume_take(uuid, jsonb) to service_role;


-- One-time recovery of the missing cloud copies (see the header), one person at a time under the same locks career_apply_cloud_optin_as and
-- the account writers take (the card-cloud maintenance lock shared, then the person's lock), with everything re-read under them: a
-- concurrent opt-out, pause, erase or resume deletion that committed first is seen, one that comes after waits for this copy and removes it.
create or replace function public.career_resume_cloud_copy_recover(p_user uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('career-card-cloud-bridge-maintenance-v1', 0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
 select r.user_id, r.sha256, coalesce(r.filename, 'resume'), r.bytes, coalesce((k.value->>'epoch')::bigint, 0)
 from public.career_resume_record r
 join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.state = 'confirmed' and r.kind = 'file' and r.bytes is not null and octet_length(r.bytes) <= 5242880
  and encode(sha256(r.bytes), 'hex') = r.sha256
  and coalesce(k.value->>'paused', 'false') <> 'true'
  and coalesce((k.value->>'epoch')::bigint, 0) = 0
  and not exists (select from public.career_apply_cloud_optin o where o.user_id = r.user_id and o.enabled = false)
  and not exists (select from public.career_apply_cloud_resumes c where c.user_id = r.user_id)
 on conflict (user_id, sha256) do nothing;
 get diagnostics n = row_count;
 return n > 0;
end $$;
revoke all on function public.career_resume_cloud_copy_recover(uuid) from public, anon, authenticated;
grant execute on function public.career_resume_cloud_copy_recover(uuid) to service_role;

do $$
declare u uuid;
begin
 for u in select r.user_id from public.career_resume_record r
  where r.state = 'confirmed' and r.kind = 'file' and r.bytes is not null
   and not exists (select from public.career_apply_cloud_resumes c where c.user_id = r.user_id)
  order by r.user_id
 loop
  perform public.career_resume_cloud_copy_recover(u);
 end loop;
end $$;
