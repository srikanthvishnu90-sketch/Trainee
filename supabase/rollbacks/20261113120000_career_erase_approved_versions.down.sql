-- Rollback of 20261113120000_career_erase_approved_versions.sql (D-072 files writers, review fix). Restores the versions guard of
-- 20261110160000 and the erase of 20261026230100, exactly. After it, "forget everything" raises again for a person with an approved
-- plan or document (the defect the migration fixed), so roll back only together with 20261110160000.
-- The guard is restored only while its tables exist (rolling 20261110160000 back drops it with them).
do $d$ begin
 if to_regprocedure('public.career_file_versions_guard()') is null then return; end if;
 execute $f$
create or replace function public.career_file_versions_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if tg_op = 'INSERT' then
  if new.approved_at is not null then raise exception 'a version is approved by its approve function, never at insert' using errcode = 'check_violation'; end if;
  if tg_table_name = 'career_search_plans' then new.payload_hash := public.career_search_plan_hash(new);
  else new.payload_hash := public.career_material_version_hash(new); end if;
  return new;
 end if;
 if tg_op = 'DELETE' then
  if old.approved_at is not null and exists (select 1 from auth.users where id = old.user_id) then
   raise exception 'an approved version is never deleted' using errcode = 'check_violation';
  end if;
  return old;
 end if;
 if old.approved_at is not null then raise exception 'an approved version is never changed' using errcode = 'check_violation'; end if;
 if (to_jsonb(new) - array['approved_at', 'approved_hash', 'approved_role']) is distinct from (to_jsonb(old) - array['approved_at', 'approved_hash', 'approved_role']) then
  raise exception 'a version is never overwritten; insert a new version' using errcode = 'check_violation';
 end if;
 return new;
end $$
 $f$;
 revoke all on function public.career_file_versions_guard() from public, anon, authenticated;
end $d$;

create or replace function public.career_erase_person(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  todo text[] := public.career_erase_tables();
  left_over text[];
  tbl text;
  n bigint;
  deleted jsonb := '{}'::jsonb;
  pass int := 0;
begin
  if p_user is null then raise exception 'career erase: no person'; end if;
  -- The apply rules' tombstone: hashes and a time, from the queue and the extension's employer reports.
  insert into public.career_apply_erased(user_id, posting_hash, company_hash, at)
  select j.user_id, encode(sha256(convert_to(j.job_id, 'UTF8')), 'hex'),
    nullif(encode(sha256(convert_to(public.career_apply_company_key(j.company), 'UTF8')), 'hex'), encode(sha256(''::bytea), 'hex')),
    coalesce(j.claimed_at, j.created_at)
  from public.career_apply_jobs j where j.user_id = p_user
  on conflict (user_id, posting_hash) do nothing;
  insert into public.career_apply_erased(user_id, posting_hash, company_hash, at)
  select r.user_id, encode(sha256(convert_to('report:' || r.posting_url, 'UTF8')), 'hex'),
    nullif(encode(sha256(convert_to(public.career_apply_company_key(r.employer), 'UTF8')), 'hex'), encode(sha256(''::bytea), 'hex')),
    coalesce(r.observed_at, r.reported_at)
  from public.extension_submission_reports r where r.user_id = p_user
  on conflict (user_id, posting_hash) do nothing;
  perform public.career_apply_erased_expire();
  -- A row another table still references (no cascade) is deleted on a later pass, after the row referencing it.
  while array_length(todo, 1) > 0 and pass < 10 loop
    pass := pass + 1; left_over := '{}';
    foreach tbl in array todo loop
      begin
        execute format('delete from %s where user_id = $1', tbl) using p_user;
        get diagnostics n = row_count;
        if n > 0 then deleted := deleted || jsonb_build_object(tbl, coalesce((deleted->>tbl)::bigint, 0) + n); end if;
      exception when foreign_key_violation then
        left_over := left_over || tbl;
      end;
    end loop;
    todo := left_over;
  end loop;
  if array_length(todo, 1) > 0 then raise exception 'career erase: could not empty %', todo; end if;
  return deleted;
end $$;
revoke all on function public.career_erase_person(uuid) from public, anon, authenticated;
grant execute on function public.career_erase_person(uuid) to service_role;
