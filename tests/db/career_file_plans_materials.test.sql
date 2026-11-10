-- Item 6 S3 (20261110160000_career_file_plans_materials.sql): search plans and material versions are versions, never overwrites;
-- an approval binds the exact payload hash (right hash approves, a stale hash changes nothing); an approved version is never
-- changed or deleted while its owner exists; a document approval covers its own role only; the owner reads only their own rows,
-- anon reads nothing, and no client writes. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f5301','s3-a@example.test'),('00000000-0000-4000-8000-0000000f5302','s3-b@example.test');
do $$
declare a uuid := '00000000-0000-4000-8000-0000000f5301'; b uuid := '00000000-0000-4000-8000-0000000f5302'; h1 text; h2 text; m3 text; m2 text; r text; n int;
begin
  insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap,watch) values
    (a,1,'Climate operations search','[{"k":"Work arrangement","v":"US remote only","src":{"kind":"you"}}]','[{"k":"Sector","v":"Grid, solar","src":{"kind":"you"}}]',12,null);
  select payload_hash into h1 from public.career_search_plans where user_id = a and version = 1;
  if h1 !~ '^[a-f0-9]{64}$' then raise exception 'FAIL no payload hash: %', h1; end if;
  if h1 <> public.career_search_plan_hash((select p from public.career_search_plans p where user_id = a and version = 1)) then raise exception 'FAIL hash not from content'; end if;
  -- a hash supplied at insert is replaced by the content's own
  insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap,payload_hash) values (b,1,'B plan','[]','[]',5,repeat('0',64));
  if (select payload_hash from public.career_search_plans where user_id = b) = repeat('0',64) then raise exception 'FAIL a supplied hash was kept'; end if;
  -- never overwritten
  begin update public.career_search_plans set title = 'Changed' where user_id = a and version = 1; raise exception 'FAIL a plan was overwritten';
  exception when check_violation then null; end;
  begin insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap,approved_at,approved_hash) values (a,9,'x','[]','[]',1,now(),repeat('a',64)); raise exception 'FAIL approved at insert';
  exception when check_violation then null; end;
  -- stale hash: nothing changes; right hash: approved once
  r := public.career_search_plan_approve_as(a, 1, repeat('f',64), now());
  if r <> 'stale' then raise exception 'FAIL stale hash gave %', r; end if;
  if (select approved_at from public.career_search_plans where user_id = a and version = 1) is not null then raise exception 'FAIL a stale hash approved'; end if;
  if public.career_search_plan_approve_as(a, 7, h1, now()) <> 'missing' then raise exception 'FAIL missing version'; end if;
  if public.career_search_plan_approve_as(b, 1, h1, now()) <> 'stale' then raise exception 'FAIL another person''s hash approved B'; end if;
  r := public.career_search_plan_approve_as(a, 1, h1, now());
  if r <> 'approved' then raise exception 'FAIL right hash gave %', r; end if;
  if public.career_search_plan_approve_as(a, 1, h1, now()) <> 'already' then raise exception 'FAIL approving twice'; end if;
  begin update public.career_search_plans set approved_at = now() where user_id = a and version = 1; raise exception 'FAIL an approved plan changed';
  exception when check_violation then null; end;
  begin delete from public.career_search_plans where user_id = a and version = 1; raise exception 'FAIL an approved plan deleted';
  exception when check_violation then null; end;
  -- a newer version: the older one can no longer be approved (superseded), the newer one only with its own hash
  insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap) values (a,2,'Climate operations search','[]','[]',12),(a,3,'Wider','[]','[]',20);
  select payload_hash into h2 from public.career_search_plans where user_id = a and version = 2;
  if public.career_search_plan_approve_as(a, 2, h2, now()) <> 'superseded' then raise exception 'FAIL an older version approved over a newer'; end if;
  raise notice 'ok   search plans: versions, never overwritten; approveplan binds the hash (stale and superseded change nothing); approved is kept';

  insert into public.career_material_versions(user_id,doc_key,doc_kind,version,label,based_on,role_job_id,rid,changes,file_name,file_bytes,file_sha256) values
    (a,'operations-resume','resume',2,'the operations resume for R-07','master v6','job-r07','R-07','[]','ops-v2.pdf','\x25504446',encode(sha256('\x25504446'::bytea),'hex')),
    (a,'operations-resume','resume',3,'the operations resume, process work first','master v6','job-r07','R-07','[{"kind":"Emphasis","after":"Reordered evidence","text":"No facts changed."}]',null,null,null);
  select payload_hash into m2 from public.career_material_versions where user_id = a and version = 2;
  select payload_hash into m3 from public.career_material_versions where user_id = a and version = 3;
  begin insert into public.career_material_versions(user_id,doc_key,doc_kind,version,label,file_name,file_bytes,file_sha256) values (a,'x','resume',1,'x','x.pdf','\x00',repeat('a',64)); raise exception 'FAIL a file whose hash is not its bytes';
  exception when check_violation then null; end;
  if public.career_material_version_approve_as(a,'operations-resume',2,'job-other',m2,now()) <> 'wrong_role' then raise exception 'FAIL approved for another role'; end if;
  if public.career_material_version_approve_as(a,'operations-resume',2,'job-r07',m3,now()) <> 'stale' then raise exception 'FAIL v3''s hash approved v2'; end if;
  if public.career_material_version_approve_as(a,'operations-resume',2,'job-r07',m2,now()) <> 'approved' then raise exception 'FAIL v2 not approved'; end if;
  -- approving v3 leaves v2 as it was: an approved document is never overwritten
  if public.career_material_version_approve_as(a,'operations-resume',3,'job-r07',m3,now()) <> 'approved' then raise exception 'FAIL v3 not approved'; end if;
  select count(*) into n from public.career_material_versions where user_id = a and approved_at is not null;
  if n <> 2 then raise exception 'FAIL approving v3 changed v2 (% approved)', n; end if;
  begin update public.career_material_versions set file_name = 'other.pdf' where user_id = a and version = 2; raise exception 'FAIL an approved document overwritten';
  exception when check_violation then null; end;
  begin delete from public.career_material_versions where user_id = a and version = 2; raise exception 'FAIL an approved document deleted';
  exception when check_violation then null; end;
  raise notice 'ok   material versions: approvedoc binds hash and role; an approved document is never changed, deleted or replaced by a newer approval';
end $$;

-- the owner reads their own rows only; anon reads nothing; nobody but the service role writes
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000f5302', true);
do $$ begin
  if (select count(*) from public.career_search_plans) <> 1 then raise exception 'FAIL B reads % plans', (select count(*) from public.career_search_plans); end if;
  if exists (select 1 from public.career_material_versions) then raise exception 'FAIL B reads A''s documents'; end if;
  begin insert into public.career_search_plans(user_id,version,title,hard,prefs,batch_cap) values ('00000000-0000-4000-8000-0000000f5302',2,'x','[]','[]',1); raise exception 'FAIL a client wrote a plan';
  exception when insufficient_privilege then null; end;
  begin perform public.career_search_plan_approve_as('00000000-0000-4000-8000-0000000f5302', 1, repeat('0',64), now()); raise exception 'FAIL a client ran approve';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform 1 from public.career_material_versions; raise exception 'FAIL anon read documents';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  delete from auth.users where id = '00000000-0000-4000-8000-0000000f5301';
  if exists (select 1 from public.career_search_plans where user_id = '00000000-0000-4000-8000-0000000f5301') or exists (select 1 from public.career_material_versions where user_id = '00000000-0000-4000-8000-0000000f5301') then raise exception 'FAIL a deleted account kept its versions'; end if;
  raise notice 'ok   owner-only reads, no client writes; a deleted account takes its approved versions with it';
end $$;
rollback;
