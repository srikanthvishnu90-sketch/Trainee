-- ONE CONFIRMED RESUME (#211, 20261026120018) meets the OWNER RULE (#194, 20261026210016). NOT APPLIED: the owner
-- applies migrations.
--
-- career_resume_on_file (20261026210016) answers "a confirmed resume on file" from every profile the person has: any
-- thread's entries, or the account's, each with its fact_confirmed event. Every resume check reads it: the chat's apply
-- turn (resumeOnFileReader), the card (cardTurn resumeReady), and career_resume_ok in the triggers on the queue, the
-- prepared rows and the cards.
-- #211 makes one record per person the resume. "delete my resume" (career_resume_delete_as) and a replaced resume
-- leave the entries in the chat's profile (the person keeps their profile until "forget my career profile"), and void
-- only the record. career_apply_profile_for then returns no resume entries. But career_resume_on_file still found the
-- old ones, so after a delete "apply to X" was queued again, waiting for a resume (found by
-- tests/architect/flow-one-resume.test.ts on #194 + #211 together).
--
-- From here, for a person #211's rule covers (career_resume_rule_on: a record, confirmed or deleted, or everyone once the
-- owner turns CAREER_ONE_RESUME on), a resume is on file only while their record is confirmed. The record is written
-- only from the person's own confirmation, checked against the stored upload (career_resume_take), so it is the stronger
-- proof; after "delete my resume", an erase, or with the switch on and no record, nothing is on file. For anyone else
-- nothing changes. Fail closed. Sorts after 20261026210016 (which it replaces), so every apply order (filename order,
-- tests/db/run.sh, go-live) ends with this text; plpgsql, so it applies whether or not #211's migration is there yet.
-- Idempotent.

create or replace function public.career_resume_on_file(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rule boolean := false; v_ok boolean := false;
begin
 if to_regprocedure('public.career_resume_rule_on(uuid)') is not null then
  execute 'select public.career_resume_rule_on($1)' into v_rule using p_user;
 end if;
 if coalesce(v_rule, false) then
  execute 'select exists (select from public.career_resume_record where user_id = $1 and state = ''confirmed'')' into v_ok using p_user;
  return coalesce(v_ok, false);
 end if;
 -- Not under the rule: any of the person's profiles, each thread's and the account's, each confirmed entry with its
 -- fact_confirmed event (20261026210016, unchanged).
 return exists (
  with profiles as (
   select s.state->'career'->'stores'->'profile' as p from public.agent_flow_state s where s.user_id = p_user
   union all
   select k.value->'memory'->'profile' from public.career_watch_kv k where k.user_id = p_user and k.key = 'career:account'
  ), facts as (
   select f from profiles, jsonb_array_elements(case when jsonb_typeof(p->'facts') = 'array' then p->'facts' else '[]'::jsonb end) f
   where coalesce(p->>'user_id', p_user::text) = p_user::text
  )
  select from facts
  join public.career_events e on e.user_id = p_user and e.kind = 'fact_confirmed' and e.detail->>'confirmation_event_id' = f->>'confirmation_event_id'
  where f->>'status' = 'confirmed' and f->'needs_confirmation' = 'false'::jsonb and coalesce(f->>'confirmation_event_id', '') <> ''
   and coalesce(f->>'kind', '') in ('experience', 'education', 'project', 'leadership', 'certification'));
end $$;
revoke all on function public.career_resume_on_file(uuid) from public, anon, authenticated;
grant execute on function public.career_resume_on_file(uuid) to service_role;
