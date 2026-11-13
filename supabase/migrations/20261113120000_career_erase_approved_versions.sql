-- D-072 (files writers), review fix: "forget everything" erases a person's approved plans and documents.
--
-- career_file_versions_guard (20261110160000) refuses the DELETE of an approved search plan or material version while its owner
-- exists. career_erase_person (20261026230100) deletes the person's rows from every career table and treats only a foreign key
-- violation as "later pass", so for anyone who had approved a plan or a document the guard's check_violation ended the whole erase:
-- nothing was erased. Since D-072 those rows are written on ordinary turns, so that is every person who approved one.
--
-- The fix is narrow. career_erase_person names, for its own transaction only, the one person it is erasing
-- (set_config('career.erase_person', <user id>, true): transaction-local, cleared again when the erase ends), and the guard lets the
-- delete of an approved version through only when that setting is exactly the row's owner. Every other delete of an approved
-- version is refused as before (a plain DELETE, a delete during the erase of a different person, a delete after the erase ended);
-- an approved version is still never changed. Account deletion is unchanged: it cascades after the auth.users row is gone, which the
-- guard already allowed. career_path_comparisons (20261112150000) has no delete guard (its trigger is BEFORE UPDATE only), so the
-- erase already emptied it; the SQL test proves that too.
--
-- The erase is otherwise exactly 20261026230100's. Additive and reversible
-- (supabase/rollbacks/20261113120000_career_erase_approved_versions.down.sql). Idempotent.

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
  -- The person's own erase (career_erase_person, for this transaction and this person only) deletes their approved versions.
  if old.approved_at is not null and exists (select 1 from auth.users where id = old.user_id)
     and coalesce(current_setting('career.erase_person', true), '') is distinct from old.user_id::text then
   raise exception 'an approved version is never deleted' using errcode = 'check_violation';
  end if;
  return old;
 end if;
 if old.approved_at is not null then raise exception 'an approved version is never changed' using errcode = 'check_violation'; end if;
 if (to_jsonb(new) - array['approved_at', 'approved_hash', 'approved_role']) is distinct from (to_jsonb(old) - array['approved_at', 'approved_hash', 'approved_role']) then
  raise exception 'a version is never overwritten; insert a new version' using errcode = 'check_violation';
 end if;
 return new;
end $$;
revoke all on function public.career_file_versions_guard() from public, anon, authenticated;

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
  -- This transaction is erasing this person: the versions guard lets their approved plans and documents go (and no one else's).
  perform set_config('career.erase_person', p_user::text, true);
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
  -- The erase is over: nothing later in this transaction may delete an approved version. (An erase that raises leaves the setting
  -- to its transaction, which is rolled back with it.)
  perform set_config('career.erase_person', '', true);
  if array_length(todo, 1) > 0 then raise exception 'career erase: could not empty %', todo; end if;
  return deleted;
end $$;
revoke all on function public.career_erase_person(uuid) from public, anon, authenticated;
grant execute on function public.career_erase_person(uuid) to service_role;
