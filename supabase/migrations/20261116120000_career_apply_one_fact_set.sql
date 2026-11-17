-- MASS APPLY CONVERSATIONS (2026-11-16): preparation and send read ONE trusted fact set.
-- Preparation reads the person's profile through career_apply_profile_for (20261026120018: a fact carrying an upload hash is
-- kept only while that hash is their confirmed resume record's). The send read the card-cloud bridge's
-- career_apply_message_cloud_sources (20261024130000), whose profile is the raw stored one, WITHOUT that filter (and
-- workers/career-cloud/engine_input.ts restEngineInputSource read the raw profile the same way). A fact the filter dropped at
-- preparation was then present at the send, and the approved application was refused as changed (eval MA05/MA12). Now the
-- snapshot's profile, and so its digest, is career_apply_profile_for's.
-- Only where the bridge is installed (it is applied at its own filename position, before this file); otherwise nothing.
-- Never applied live by an agent; the owner's release path applies it.
-- Rollback: supabase/rollbacks/20261116120000_career_apply_one_fact_set.down.sql
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
 with rows as(select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'key',key,'kind',kind,'answer',answer,'state',state)
  order by id),'[]'::jsonb) r from public.career_apply_questions where user_id=p_user and state='answered')
 select jsonb_build_object('profile',public.career_apply_profile_for(p_user),'rows',r) into v from rows;
 return v||jsonb_build_object('user_id',p_user,'digest',encode(sha256(convert_to(public.career_apply_canonical(v||jsonb_build_object('user_id',p_user)),'UTF8')),'hex'));
end $$;
$f$;
 revoke all on function public.career_apply_message_cloud_sources(uuid) from public,anon,authenticated,service_role;
 grant execute on function public.career_apply_message_cloud_sources(uuid) to service_role;
end $m$;
