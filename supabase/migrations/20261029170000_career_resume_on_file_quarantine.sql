-- APPLY SCENARIOS (architect, 2026-10-29; tests/architect/flow-scenarios-apply.test.ts C). NOT APPLIED: the owner
-- applies migrations.
--
-- OWNER RULE (2026-10-26): never submit an application without a real, confirmed resume. D-007: a quarantined fact (the
-- owner's bank, factId F-027..F-079, or one given under the owner-delegated / answer-all provenance; fact_quarantine.ts
-- quarantinedFact) is never used for an application. career_resume_on_file (20261026210017) counted any confirmed resume
-- entry with its fact_confirmed event, a quarantined one included: a person whose only "resume" was a quarantined entry
-- read as having a confirmed resume on file, so the queue, the claim, the prepared rows and the cards took their
-- applications (found by the generated resume states: none, draft, unconfirmed, quarantined, confirmed).
-- From here a quarantined entry is not a resume on file. Everything else is 20261026210017's text, unchanged: under the
-- one-record rule only the confirmed record counts; otherwise a confirmed entry of a resume kind with its event.
-- Sorts after 20261026210017 (which it replaces), so every apply order ends with this text. Fail closed. Idempotent.

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
 -- fact_confirmed event (20261026210016), never a quarantined one (D-007: the owner's bank, the answer-all delegation).
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
   and coalesce(f->>'kind', '') in ('experience', 'education', 'project', 'leadership', 'certification')
   -- D-007 (fact_quarantine.ts quarantinedFact): the owner's bank ids and the owner-delegated provenance.
   and btrim(coalesce(f->>'factId', '')) !~ '^F-0*(2[7-9]|[3-6][0-9]|7[0-9])$'
   and coalesce(f->>'provenance', '') !~* '(owner-delegated|answer-all)');
end $$;
revoke all on function public.career_resume_on_file(uuid) from public, anon, authenticated;
grant execute on function public.career_resume_on_file(uuid) to service_role;
