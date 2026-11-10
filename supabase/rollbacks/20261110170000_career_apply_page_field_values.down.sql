-- Rollback of 20261110170000_career_apply_page_field_values.sql: the card-cloud validator as
-- 20261024130000_career_apply_card_cloud_bridge.sql defines it (no page_field_values key), and the helper dropped.
-- A queued payload that carries page_field_values is refused by this validator; prepare such postings again after a rollback.

create or replace function career_message_approval_private.cloud_validate(p_user uuid,p_items jsonb) returns void
language plpgsql set search_path=public,pg_temp as $$
declare it jsonb;p jsonb;r jsonb;f jsonb;s jsonb;a jsonb;seen text[]:='{}';
begin
 if jsonb_typeof(p_items) is distinct from'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'invalid cloud items'; end if;
 for it in select value from jsonb_array_elements(p_items) loop
  p:=it->'payload';r:=it->'readback';
  if not coalesce(career_message_approval_private.cloud_keys(it,array['payload','hash','readback']),false)
   or not coalesce(career_message_approval_private.cloud_keys(p,array['version','user_id','job_id','company','url','fields','destination','resume_sha256',
    'page_field_names','engine_approval','schema_hash','privacy_epoch','account_version','expires_at','quarantine_version','manifest_hash',
    'replay_sources','resume_tailored','resume_persona','approved_snapshot']),false)
   or p->'version' is distinct from'1'::jsonb or p->>'user_id' is distinct from p_user::text
   or length(coalesce(p->>'job_id','')) not between 3 and 300 or length(coalesce(p->>'company','')) not between 1 and 200
   or coalesce(p->>'url','')!~'^https://' or coalesce(p->>'destination','')!~'^https://'
   or octet_length(p::text)>131072 or jsonb_typeof(p->'fields') is distinct from'array'
   or jsonb_typeof(p->'page_field_names') is distinct from'array' or jsonb_typeof(p->'replay_sources') is distinct from'array'
   or coalesce(p->>'engine_approval','')!~'^[0-9a-f]{64}$' or coalesce(p->>'schema_hash','')!~'^[0-9a-f]{64}$'
   or coalesce(p->>'manifest_hash','')!~'^[0-9a-f]{64}$' or p->>'quarantine_version' is distinct from'd007-v1'
   or coalesce(p->>'resume_sha256','')!~'^[0-9a-f]{64}$'
   or it->>'hash' is distinct from encode(sha256(convert_to(public.career_apply_canonical(p),'UTF8')),'hex')
  then raise exception 'invalid or stale cloud payload'; end if;
  if p->>'job_id'=any(seen) then raise exception 'duplicate cloud posting'; end if;seen:=array_append(seen,p->>'job_id');
  if public.career_apply_current(p_user,p) is distinct from true then raise exception 'stale cloud authority'; end if;
  if not coalesce(career_message_approval_private.cloud_keys(r,array['answers','resume_name','resume_sha256','destination','blank','employer_fields']),false)
   or jsonb_typeof(r->'answers') is distinct from'array' or jsonb_typeof(r->'blank') is distinct from'array'
   or jsonb_typeof(r->'employer_fields') is distinct from'array' or r->'employer_fields' is distinct from p->'page_field_names'
   or exists(select 1 from jsonb_array_elements(r->'blank')x where jsonb_typeof(x) is distinct from'string')
   or exists(select 1 from jsonb_array_elements(p->'page_field_names')x where jsonb_typeof(x) is distinct from'string' or x#>>'{}'='')
   or (select count(*) from jsonb_array_elements(p->'page_field_names'))<>(select count(distinct x#>>'{}') from jsonb_array_elements(p->'page_field_names')x)
   or coalesce(r->>'resume_name','')=''
   or r->>'resume_sha256' is distinct from p->>'resume_sha256' or r->>'destination' is distinct from p->>'destination'
   or (select array_agg(x->>'name' order by x->>'name') from jsonb_array_elements(r->'answers')x)
     is distinct from(select array_agg(x->>'name' order by x->>'name') from jsonb_array_elements(p->'fields')x)
   or (select count(*) from jsonb_array_elements(p->'fields'))<>(select count(distinct x->>'name') from jsonb_array_elements(p->'fields')x)
  then raise exception 'cloud readback mismatch'; end if;
  for f in select value from jsonb_array_elements(p->'fields') loop
   if not coalesce(career_message_approval_private.cloud_keys(f,array['name','label','value','factId','provenance','confirmation_event_id','authorizes','source']),false)
    or jsonb_typeof(f->'name') is distinct from'string' or coalesce(f->>'name','')='' or jsonb_typeof(f->'label') is distinct from'string' or coalesce(f->>'label','')=''
    or jsonb_typeof(f->'factId') is distinct from'string' or coalesce(f->>'factId','')=''
    or jsonb_typeof(f->'value') is null or jsonb_typeof(f->'value') not in('string','object','number','boolean')
    or (f?'authorizes' and jsonb_typeof(f->'authorizes') is distinct from'boolean')
    or not coalesce(career_message_approval_private.cloud_source_ok(f->'source'),false)
    or jsonb_typeof(f->'confirmation_event_id') is distinct from'string' or coalesce(f->>'confirmation_event_id','')=''
    or jsonb_typeof(f->'provenance') is distinct from'string' or coalesce(f->>'provenance','')=''
    or career_message_approval_private.cloud_quarantined(f) then raise exception 'invalid or quarantined cloud field'; end if;
   if jsonb_typeof(f->'value')='object' and (
    not coalesce(career_message_approval_private.cloud_keys(f->'value',array['filename','sha256']),false)
    or f->'value'->>'filename' is distinct from r->>'resume_name'
    or f->'value'->>'sha256' is distinct from p->>'resume_sha256'
    or f->>'factId' is distinct from 'approved-local-resume:'||(p->>'resume_sha256')) then
    raise exception 'invalid cloud file answer'; end if;
   select value into a from jsonb_array_elements(r->'answers') where value->>'name'=f->>'name';
   if not coalesce(career_message_approval_private.cloud_keys(a,array['name','label','value','shown','factId','kind']),false)
    or a->'value' is distinct from f->'value' or a->>'label' is distinct from f->>'label'
    or a->>'factId' is distinct from f->>'factId' or jsonb_typeof(a->'shown') is distinct from'string' then raise exception 'cloud answer readback mismatch'; end if;
  end loop;
  for s in select value from jsonb_array_elements(p->'replay_sources') loop
   if not coalesce(career_message_approval_private.cloud_keys(s,array['table','key','value','factId','event','provenance','authorizes']),false)
    or not coalesce(career_message_approval_private.cloud_source_ok(jsonb_build_object('table',s->'table','key',s->'key','value',s->'value')),false)
    or jsonb_typeof(s->'factId') is distinct from'string' or coalesce(s->>'factId','')=''
    or jsonb_typeof(s->'event') is distinct from'string' or coalesce(s->>'event','')=''
    or jsonb_typeof(s->'provenance') is distinct from'string' or coalesce(s->>'provenance','')=''
    or (s?'authorizes' and jsonb_typeof(s->'authorizes') is distinct from'boolean')
    or career_message_approval_private.cloud_quarantined(s) then raise exception 'invalid or quarantined replay source'; end if;
  end loop;
  if p?'approved_snapshot' then
   s:=p->'approved_snapshot';
   if not coalesce(career_message_approval_private.cloud_keys(s,array['schema','original']),false)
    or jsonb_typeof(s->'schema') is distinct from'array' or s->'original' is distinct from(p-'approved_snapshot')
    or encode(sha256(convert_to(public.career_apply_canonical(s->'schema'),'UTF8')),'hex') is distinct from p->>'schema_hash'
   then raise exception 'cloud approved schema mismatch'; end if;
  end if;
  if not exists(select 1 from public.career_apply_cloud_resumes x where x.user_id=p_user and x.sha256=p->>'resume_sha256'
   and x.privacy_epoch=(p->>'privacy_epoch')::bigint and encode(sha256(x.bytes),'hex')=x.sha256 and x.filename=r->>'resume_name')
  then raise exception 'cloud owned resume mismatch'; end if;
 end loop;
end $$;

revoke all on function career_message_approval_private.cloud_validate(uuid,jsonb) from public,anon,authenticated,service_role;
drop function if exists career_message_approval_private.cloud_page_values_ok(jsonb);
