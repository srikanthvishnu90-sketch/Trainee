-- D-072 files writers, review fix (20261113120000_career_erase_approved_versions.sql), in the database alone: a person who approved
-- a search plan and a document can still be forgotten. A plain DELETE of an approved version is refused before, during another
-- person's erase and after the erase; the person's own erase (career_erase_person, and the "forget everything" epoch trigger that
-- calls it) removes their approved plan, approved document and path comparisons; another person's rows are untouched; the account
-- deletion cascade still removes approved versions. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f7301','ev-a@example.test'),('00000000-0000-4000-8000-0000000f7302','ev-b@example.test'),
  ('00000000-0000-4000-8000-0000000f7303','ev-c@example.test');
do $$
declare a uuid := '00000000-0000-4000-8000-0000000f7301'; b uuid := '00000000-0000-4000-8000-0000000f7302'; c uuid := '00000000-0000-4000-8000-0000000f7303';
  u uuid; h text; d jsonb := '[{"letter":"A","name":"consulting","said":"consulting","rows":[]},{"letter":"B","name":"product management","said":"product management","rows":[]}]';
begin
  -- Each person: an approved plan, a document with an approved version and a newer unapproved one, and one path comparison.
  foreach u in array array[a, b, c] loop
    insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap) values (u,1,'Search plan','[]','[]',10);
    select payload_hash into h from public.career_search_plans where user_id = u and version = 1;
    if public.career_search_plan_approve_as(u, 1, h, now()) <> 'approved' then raise exception 'FAIL setup: plan not approved'; end if;
    insert into public.career_material_versions(user_id,doc_key,doc_kind,version,label,role_job_id,file_name,file_bytes,file_sha256) values
      (u,'resume-acme','resume',1,'the resume for Acme','job-1','r.pdf','\x25504446',encode(sha256('\x25504446'::bytea),'hex')),
      (u,'resume-acme','resume',2,'the resume for Acme, shorter','job-1',null,null,null);
    select payload_hash into h from public.career_material_versions where user_id = u and version = 1;
    if public.career_material_version_approve_as(u,'resume-acme',1,'job-1',h,now()) <> 'approved' then raise exception 'FAIL setup: document not approved'; end if;
    insert into public.career_path_comparisons(user_id,version,title,directions,said,confirmed_facts) values (u,1,'Consulting vs product management',d,'consulting or product management?',0);
  end loop;

  -- A plain DELETE of an approved version is refused, as before.
  begin delete from public.career_search_plans where user_id = a; raise exception 'FAIL a plain delete removed an approved plan';
  exception when check_violation then null; end;
  begin delete from public.career_material_versions where user_id = a and version = 1; raise exception 'FAIL a plain delete removed an approved document';
  exception when check_violation then null; end;
  -- An approved version is still never changed, whatever the setting says.
  perform set_config('career.erase_person', a::text, true);
  begin update public.career_search_plans set title = 'Changed' where user_id = a; raise exception 'FAIL an approved plan changed under the erase setting';
  exception when check_violation then null; end;
  perform set_config('career.erase_person', '', true);
  raise notice 'ok   a plain delete of an approved plan or document is refused';

  -- B is erased: B's approved plan, both document versions and the comparison are gone.
  perform public.career_erase_person(b);
  if exists (select 1 from public.career_search_plans where user_id = b) then raise exception 'FAIL the erase left an approved plan'; end if;
  if exists (select 1 from public.career_material_versions where user_id = b) then raise exception 'FAIL the erase left an approved document'; end if;
  if exists (select 1 from public.career_path_comparisons where user_id = b) then raise exception 'FAIL the erase left a path comparison'; end if;
  if not exists (select 1 from auth.users where id = b) then raise exception 'FAIL the erase removed the account'; end if;
  -- A and C are untouched, and the erase left nothing behind that lets their approved versions be deleted.
  if (select count(*) from public.career_search_plans where user_id in (a, c)) <> 2 or (select count(*) from public.career_material_versions where user_id in (a, c)) <> 4
     or (select count(*) from public.career_path_comparisons where user_id in (a, c)) <> 2 then raise exception 'FAIL the erase of B touched another person'; end if;
  if coalesce(current_setting('career.erase_person', true), '') <> '' then raise exception 'FAIL the erase left its setting on: %', current_setting('career.erase_person', true); end if;
  begin delete from public.career_search_plans where user_id = a; raise exception 'FAIL after an erase, a plain delete removed an approved plan';
  exception when check_violation then null; end;
  begin delete from public.career_material_versions where user_id = a and version = 1; raise exception 'FAIL after an erase, a plain delete removed an approved document';
  exception when check_violation then null; end;
  -- The setting names one person: while it names B, A's approved versions are still refused.
  perform set_config('career.erase_person', b::text, true);
  begin delete from public.career_search_plans where user_id = a; raise exception 'FAIL the erase of one person let another''s approved plan go';
  exception when check_violation then null; end;
  begin delete from public.career_material_versions where user_id = a and version = 1; raise exception 'FAIL the erase of one person let another''s approved document go';
  exception when check_violation then null; end;
  perform set_config('career.erase_person', '', true);
  raise notice 'ok   career_erase_person removes the person''s approved plan, approved document and path comparison, and only theirs';

  -- "forget everything" as the chat does it: the account record's epoch advances and the trigger erases. It does not raise.
  insert into public.career_watch_kv(user_id, key, value) values (a, 'career:account', '{"paused":true,"epoch":1}'::jsonb)
    on conflict (user_id, key) do update set value = jsonb_build_object('paused', true, 'epoch', coalesce((public.career_watch_kv.value->>'epoch')::bigint, 0) + 1);
  if exists (select 1 from public.career_search_plans where user_id = a) or exists (select 1 from public.career_material_versions where user_id = a)
     or exists (select 1 from public.career_path_comparisons where user_id = a) then raise exception 'FAIL forget everything left a plan, a document or a comparison'; end if;
  if (select count(*) from public.career_search_plans where user_id = c and approved_at is not null) <> 1 then raise exception 'FAIL forget everything touched another person'; end if;
  raise notice 'ok   forget everything (the account epoch) erases approved versions without raising';

  -- Account deletion still cascades over approved versions.
  delete from auth.users where id = c;
  if exists (select 1 from public.career_search_plans where user_id = c) or exists (select 1 from public.career_material_versions where user_id = c)
     or exists (select 1 from public.career_path_comparisons where user_id = c) then raise exception 'FAIL rows outlived the account'; end if;
  raise notice 'ok   deleting the account removes approved versions and comparisons';
end $$;
rollback;
