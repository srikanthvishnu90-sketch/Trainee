-- RESUME CONFIRMATION, ALL OR NOTHING (architect, 2026-10-30; found by tests/architect/flow-scenarios-onboarding-r2.test.ts,
-- #317, "races"). NOT APPLIED: the owner applies migrations.
--
-- The person's yes to their resume entries ("yes, that's my resume") is evidenced by one fact_confirmed career_event per
-- entry (_shared/career_router_evidence.ts), and the first of those events writes the one resume record
-- (career_resume_from_event -> career_resume_take -> career_resume_put, 20261026120018), which career_resume_on_file reads.
-- agent-chat wrote those events DURING the turn, then saved the thread (career_host_commit). When the same person's yes
-- reached two threads at once (Telegram and the web chat), the second save was refused (revision_conflict: the account
-- version had moved) and the reply said so, but the events and the record were already written: career_resume_on_file read
-- true while the profile still held drafts, and the resend wrote a second set of events. D-007 (facts only from confirmed
-- facts) needs the evidence and the confirmation to commit together or not at all.
--
-- career_host_commit_evidenced: the turn's commit (career_host_commit, or the task / batch commit that wraps it) and the
-- confirmation's events in ONE transaction:
--   - every event is a fact_confirmed of this person whose confirmation_event_id names an entry the saved profile holds as
--     confirmed (the thread snapshot's profile, or the account memory's in the same patch): no evidence without state;
--   - a refused commit (revision_conflict, turn_key_conflict, privacy_epoch_changed, ...) or a replay of an already saved
--     turn writes no event (and so no resume record);
--   - an event already on record (the same confirmation_event_id) is not written twice;
--   - an event that cannot be written fails the whole commit (nothing saved; the person is told it was not saved).
-- career_host_commit itself is unchanged; a turn with no confirmation still calls it as before. Service role only.
-- Idempotent: create or replace only.

create or replace function public.career_host_commit_evidenced(p_base jsonb, p_events jsonb, p_task jsonb default null, p_batch jsonb default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare u uuid; saved jsonb; e jsonb; held jsonb; cid text;
begin
 if jsonb_typeof(p_base) is distinct from 'object' or coalesce(p_base->>'p_user','') !~ '^[0-9a-fA-F-]{36}$'
    or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 60
    or (p_task is not null and p_batch is not null) or octet_length(p_events::text) > 262144 then
  raise exception 'invalid evidenced commit';
 end if;
 u := (p_base->>'p_user')::uuid;
 -- An erase rebuilds the account from nothing; evidence never rides it.
 if jsonb_typeof(p_base->'p_patch') = 'object' and p_base->'p_patch' ? 'erase' then raise exception 'invalid evidenced commit'; end if;
 -- The entries this commit saves: the thread's profile and, when the account memory rides the patch, the account's.
 held := (case when jsonb_typeof(p_base#>'{p_snapshot,stores,profile,facts}') = 'array' then p_base#>'{p_snapshot,stores,profile,facts}' else '[]'::jsonb end)
  || (case when jsonb_typeof(p_base#>'{p_patch,memory,profile,facts}') = 'array' then p_base#>'{p_patch,memory,profile,facts}' else '[]'::jsonb end);
 for e in select x from jsonb_array_elements(p_events) x loop
  if jsonb_typeof(e) is distinct from 'object' or e->>'kind' is distinct from 'fact_confirmed' or e->>'user_id' is distinct from u::text
     or jsonb_typeof(e->'detail') is distinct from 'object' or octet_length((e->'detail')::text) > 4096
     or coalesce(e#>>'{detail,confirmation_event_id}', '') = '' or length(e#>>'{detail,confirmation_event_id}') > 120 then
   raise exception 'invalid evidenced commit';
  end if;
  cid := e#>>'{detail,confirmation_event_id}';
  if not exists (select from jsonb_array_elements(held) f where jsonb_typeof(f) = 'object' and f->>'confirmation_event_id' = cid
      and f->>'status' = 'confirmed' and f->'needs_confirmation' = 'false'::jsonb) then
   raise exception 'evidence without state: confirmation % is not a confirmed entry of the profile this commit saves', cid;
  end if;
 end loop;
 if (select count(distinct x#>>'{detail,confirmation_event_id}') from jsonb_array_elements(p_events) x) <> jsonb_array_length(p_events) then
  raise exception 'invalid evidenced commit';
 end if;
 saved := case
  when p_batch is not null then public.career_batch_turn_commit_v1(p_base, p_batch)
  when p_task is not null then public.career_task_turn_commit_v1(p_base, p_task)
  else public.career_host_commit(u, (p_base->>'p_thread')::uuid, p_base->>'p_key', p_base->>'p_hash', (p_base->>'p_revision')::bigint,
   (p_base->>'p_account_version')::bigint, p_base->'p_snapshot', p_base->'p_patch', p_base->>'p_input', p_base->'p_response') end;
 -- Refused, or a turn already saved (its evidence went with it): nothing more is written.
 if jsonb_typeof(saved) is distinct from 'object' or saved ? 'error' or coalesce(saved->>'replay', 'false') = 'true' then return saved; end if;
 -- The evidence, in this transaction (the resume record follows from the first event: career_resume_from_event).
 insert into public.career_events (user_id, at, kind, subject, detail, source)
 select u, coalesce((x->>'at')::timestamptz, now()), 'fact_confirmed', left(coalesce(x->>'subject', ''), 200), x->'detail',
  left(coalesce(nullif(x->>'source', ''), 'chat'), 40)
 from jsonb_array_elements(p_events) with ordinality as t(x, n)
 where not exists (select from public.career_events c where c.user_id = u and c.kind = 'fact_confirmed'
  and c.detail->>'confirmation_event_id' = x#>>'{detail,confirmation_event_id}')
 order by n;
 return saved;
end $$;
revoke all on function public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb) to service_role;
