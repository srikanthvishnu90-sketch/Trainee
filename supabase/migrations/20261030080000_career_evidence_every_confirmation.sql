-- EVERY CONFIRMATION WITH ITS SAVE (architect, 2026-10-30; the follow-up #318 left open: "Not in this PR"). NOT APPLIED: the
-- owner applies migrations.
--
-- #318 (20261030060000) made the router's resume confirmation commit its fact_confirmed events with the turn's save
-- (career_host_commit_evidenced). Two other writers still wrote theirs DURING the turn, so a save refused afterwards
-- (revision_conflict: another thread of the person saved first) left events naming facts no saved record holds:
--   - a fact the person states in chat ("I'm a junior majoring in economics": _shared/career_router_evidence.ts
--     evidenceStatedFacts, through career_account_memory.ts accountMemoryAfterTurn);
--   - the agent brain's confirm_profile_fact (_shared/agent/career_tools.ts).
-- agent-chat now holds both (heldEvents) and passes them to the same evidenced commit. A stated fact is not a profile
-- entry: it lives in the thread's statedFacts store and the account's stated_facts record (its `facts` and `keyed` lists),
-- with no status of its own. This replaces career_host_commit_evidenced so an event may also name a stated fact this commit
-- saves (the snapshot's stores.statedFacts.facts, or the patch's stated_facts.facts / .keyed) that is not a draft. Every
-- other rule is #318's, unchanged: a refused or replayed commit writes no event, an event already on record is skipped,
-- an event that cannot be written fails the whole commit, erases carry no evidence, service role only.
-- Idempotent: create or replace only.

create or replace function public.career_host_commit_evidenced(p_base jsonb, p_events jsonb, p_task jsonb default null, p_batch jsonb default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare u uuid; saved jsonb; e jsonb; held jsonb; stated jsonb; cid text;
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
 -- The facts stated in chat this commit saves: the thread's own copy and the account's record (both of its lists).
 stated := (case when jsonb_typeof(p_base#>'{p_snapshot,stores,statedFacts,facts}') = 'array' then p_base#>'{p_snapshot,stores,statedFacts,facts}' else '[]'::jsonb end)
  || (case when jsonb_typeof(p_base#>'{p_patch,stated_facts,facts}') = 'array' then p_base#>'{p_patch,stated_facts,facts}' else '[]'::jsonb end)
  || (case when jsonb_typeof(p_base#>'{p_patch,stated_facts,keyed}') = 'array' then p_base#>'{p_patch,stated_facts,keyed}' else '[]'::jsonb end);
 for e in select x from jsonb_array_elements(p_events) x loop
  if jsonb_typeof(e) is distinct from 'object' or e->>'kind' is distinct from 'fact_confirmed' or e->>'user_id' is distinct from u::text
     or jsonb_typeof(e->'detail') is distinct from 'object' or octet_length((e->'detail')::text) > 4096
     or coalesce(e#>>'{detail,confirmation_event_id}', '') = '' or length(e#>>'{detail,confirmation_event_id}') > 120 then
   raise exception 'invalid evidenced commit';
  end if;
  cid := e#>>'{detail,confirmation_event_id}';
  if not exists (select from jsonb_array_elements(held) f where jsonb_typeof(f) = 'object' and f->>'confirmation_event_id' = cid
      and f->>'status' = 'confirmed' and f->'needs_confirmation' = 'false'::jsonb)
     and not exists (select from jsonb_array_elements(stated) f where jsonb_typeof(f) = 'object' and f->>'confirmation_event_id' = cid
      and coalesce(f->'needs_confirmation', 'false'::jsonb) = 'false'::jsonb and coalesce(f->>'status', 'confirmed') = 'confirmed') then
   raise exception 'evidence without state: confirmation % is not a confirmed entry or stated fact this commit saves', cid;
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
