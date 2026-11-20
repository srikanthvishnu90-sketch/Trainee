-- Rollback of 20261116120000: the card-cloud bridge's own snapshot read (20261024130000), restored where the bridge is installed.
do $m$ begin
 if to_regprocedure('public.career_apply_message_cloud_sources(uuid)') is null then return; end if;
 execute $f$
create or replace function public.career_apply_message_cloud_sources(p_user uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('career-card-cloud-bridge-maintenance-v1',0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if not exists(select 1 from public.profiles where id=p_user) then raise exception 'source owner missing'; end if;
 with recent as(select state,updated_at,thread_id from public.agent_flow_state where user_id=p_user order by updated_at desc,thread_id limit 25),
 profile as(select state#>'{career,stores,profile}' p from recent
  where jsonb_typeof(state#>'{career,stores,profile}')='object' and
   (jsonb_typeof(state#>'{career,stores,profile,basics}')='object' or jsonb_typeof(state#>'{career,stores,profile,facts}')='array')
  order by updated_at desc,thread_id limit 1),
 rows as(select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'key',key,'kind',kind,'answer',answer,'state',state)
  order by id),'[]'::jsonb) r from public.career_apply_questions where user_id=p_user and state='answered')
 select jsonb_build_object('profile',(select p from profile),'rows',r) into v from rows;
 return v||jsonb_build_object('user_id',p_user,'digest',encode(sha256(convert_to(public.career_apply_canonical(v||jsonb_build_object('user_id',p_user)),'UTF8')),'hex'));
end $$;
$f$;
end $m$;
