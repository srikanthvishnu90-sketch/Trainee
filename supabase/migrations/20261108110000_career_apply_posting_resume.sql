-- R9-G2 (e2e E09): "tailor my resume for the <role> role at <Co> and apply with it" sends THAT tailored resume to that
-- posting. Before this, the hosted preparation read only the resume the person keeps for the cloud
-- (career_apply_cloud_resume_kept_for), so the application went with their saved file whatever they asked.
--   1. career_apply_cloud_resumes.posting_job_id: a tailored resume kept for ONE posting (null: the person's kept resume,
--      unchanged). payload_hash: the prepared application that carries it (set when the preparation stores one whose
--      resume_sha256 is this file), so the approval card's payload hash binds exactly this file.
--   2. career_apply_cloud_resume_kept_for: the kept resume only (never a posting's tailored copy).
--   3. career_apply_cloud_resume_for_posting(p_user, p_posting): that posting's tailored resume, else the kept one. The
--      preparation bridge reads it for each posting, and checks the card's resume line against it.
--   4. career_apply_posting_resume_put(p_user, p_posting, p_filename, p_b64): keeps the tailored PDF for that posting, only
--      for a person with a confirmed resume on file who keeps a resume in the cloud already (their own cloud consent);
--      returns its sha256, or null when either is missing (nothing is kept). The send side is unchanged: it already reads
--      the file by the approved payload's resume_sha256 (career_apply_cloud_resume), and the resume guards already accept
--      a file the cloud holds for them (career_resume_stored).
-- Idempotent. NOT APPLIED: the owner applies migrations. Rollback: supabase/rollbacks/20261108110000_career_apply_posting_resume.down.sql.

alter table public.career_apply_cloud_resumes add column if not exists posting_job_id text;
alter table public.career_apply_cloud_resumes add column if not exists payload_hash text;
alter table public.career_apply_cloud_resumes drop constraint if exists career_apply_cloud_resumes_posting;
alter table public.career_apply_cloud_resumes add constraint career_apply_cloud_resumes_posting check (
 (posting_job_id is null or length(posting_job_id) between 1 and 300) and (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$')
 and (payload_hash is null or posting_job_id is not null));
create index if not exists career_apply_cloud_resumes_posting_idx on public.career_apply_cloud_resumes (user_id, posting_job_id, created_at desc)
 where posting_job_id is not null;

create or replace function public.career_apply_cloud_resume_kept_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'))
 from public.career_apply_cloud_resumes r left join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.posting_job_id is null and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0) and encode(sha256(r.bytes), 'hex') = r.sha256
 order by r.created_at desc limit 1
$$;

create or replace function public.career_apply_cloud_resume_for_posting(p_user uuid, p_posting text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((
  select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'), 'posting', r.posting_job_id)
  from public.career_apply_cloud_resumes r left join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
  where r.user_id = p_user and r.posting_job_id = p_posting and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0)
   and encode(sha256(r.bytes), 'hex') = r.sha256
  order by r.created_at desc limit 1), public.career_apply_cloud_resume_kept_for(p_user))
$$;

create or replace function public.career_apply_posting_resume_put(p_user uuid, p_posting text, p_filename text, p_b64 text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare b bytea; h text; ep bigint; fname text;
begin
 if p_user is null or nullif(p_posting, '') is null or length(p_posting) > 300 or p_b64 is null or length(p_b64) > 7200000 then
  raise exception 'invalid posting resume'; end if;
 b := decode(p_b64, 'base64');
 if octet_length(b) not between 1 and 5242880 or substring(b from 1 for 5) <> '\x255044462d'::bytea then raise exception 'invalid posting resume'; end if;
 fname := nullif(left(regexp_replace(coalesce(p_filename, ''), '[/\\\r\n]', ' ', 'g'), 200), '');
 if fname is null or fname like '.%' then raise exception 'invalid posting resume'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 if not public.career_resume_on_file(p_user) or public.career_apply_cloud_resume_kept_for(p_user) is null then return null; end if;
 h := encode(sha256(b), 'hex');
 select coalesce((value->>'epoch')::bigint, 0) into ep from public.career_watch_kv where user_id = p_user and key = 'career:account';
 insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch, posting_job_id)
 values (p_user, h, fname, b, coalesce(ep, 0), p_posting)
 -- The same bytes as their kept resume stay their kept resume (that file is what goes either way).
 on conflict (user_id, sha256) do update set posting_job_id = excluded.posting_job_id, filename = excluded.filename,
  privacy_epoch = excluded.privacy_epoch, payload_hash = null, created_at = now()
  where public.career_apply_cloud_resumes.posting_job_id is not null;
 return h;
end $$;

-- The prepared application that carries a posting's tailored resume: its payload hash on that file's row.
create or replace function public.career_apply_posting_resume_link() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 update public.career_apply_cloud_resumes set payload_hash = new.payload_hash
  where user_id = new.user_id and posting_job_id is not null and sha256 = new.payload->>'resume_sha256'
   and payload_hash is distinct from new.payload_hash;
 return new;
end $$;
drop trigger if exists career_apply_posting_resume_link on public.career_apply_prepared;
create trigger career_apply_posting_resume_link after insert or update of payload_hash on public.career_apply_prepared
 for each row execute function public.career_apply_posting_resume_link();

revoke all on function public.career_apply_cloud_resume_kept_for(uuid), public.career_apply_cloud_resume_for_posting(uuid, text),
 public.career_apply_posting_resume_put(uuid, text, text, text), public.career_apply_posting_resume_link() from public, anon, authenticated, service_role;
grant execute on function public.career_apply_cloud_resume_kept_for(uuid), public.career_apply_cloud_resume_for_posting(uuid, text),
 public.career_apply_posting_resume_put(uuid, text, text, text) to service_role;
