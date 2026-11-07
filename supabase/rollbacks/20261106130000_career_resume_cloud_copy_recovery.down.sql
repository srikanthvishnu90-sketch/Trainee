-- Reverses 20261106130000: career_resume_put exactly as 20261106120000 left it. Recovered cloud copies are data and stay. Grants unchanged.
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

revoke all on function public.career_resume_put(uuid, text, text, text, text, bytea, text) from public, anon, authenticated;
grant execute on function public.career_resume_put(uuid, text, text, text, text, bytea, text) to service_role;

create or replace function public.career_resume_take(p_user uuid, p_detail jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare u jsonb := p_detail->'upload'; sha text := p_detail->'upload'->>'sha256'; ref text := p_detail->'upload'->>'ref';
 msg text; up record; b bytea; fname text; m text[];
begin
 if coalesce(p_detail->>'via', '') <> 'router: their yes to the resume entries shown to them' or jsonb_typeof(u) is distinct from 'object'
    or coalesce(sha, '') !~ '^[a-f0-9]{64}$' or coalesce(p_detail->>'confirmation_event_id', '') = '' then return false; end if;
 if exists (select from public.career_resume_record where user_id = p_user and state = 'confirmed' and sha256 = sha) then return false; end if;
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
drop function if exists public.career_resume_cloud_copy_recover(uuid);
