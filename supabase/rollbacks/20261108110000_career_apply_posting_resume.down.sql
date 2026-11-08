-- Reverses 20261108110000: career_apply_cloud_resume_kept_for exactly as 20261106120000 left it; the per-posting read, put
-- and link removed. Tailored copies kept for one posting are deleted first, so the restored read (the newest row) can never
-- pick one as the person's kept resume.
drop trigger if exists career_apply_posting_resume_link on public.career_apply_prepared;
drop function if exists public.career_apply_posting_resume_link();
drop function if exists public.career_apply_posting_resume_put(uuid, text, text, text);
drop function if exists public.career_apply_cloud_resume_for_posting(uuid, text);
delete from public.career_apply_cloud_resumes where posting_job_id is not null;
create or replace function public.career_apply_cloud_resume_kept_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'))
 from public.career_apply_cloud_resumes r left join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0) and encode(sha256(r.bytes), 'hex') = r.sha256
 order by r.created_at desc limit 1
$$;
revoke all on function public.career_apply_cloud_resume_kept_for(uuid) from public, anon, authenticated;
grant execute on function public.career_apply_cloud_resume_kept_for(uuid) to service_role;
revoke all on function public.career_apply_cloud_resume_kept_for(uuid) from public, anon, authenticated;
grant execute on function public.career_apply_cloud_resume_kept_for(uuid) to service_role;
drop index if exists public.career_apply_cloud_resumes_posting_idx;
alter table public.career_apply_cloud_resumes drop constraint if exists career_apply_cloud_resumes_posting;
alter table public.career_apply_cloud_resumes drop column if exists payload_hash;
alter table public.career_apply_cloud_resumes drop column if exists posting_job_id;
