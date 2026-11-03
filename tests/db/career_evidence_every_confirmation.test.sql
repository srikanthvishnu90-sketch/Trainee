-- EVERY CONFIRMATION WITH ITS SAVE (20261030080000_career_evidence_every_confirmation.sql): career_host_commit_evidenced
-- also takes the fact_confirmed events of facts the person STATED in chat (evidenceStatedFacts) and of the brain's
-- confirm_profile_fact, so they are written with the turn's save or not at all:
--   1. a refused save (another thread saved first) writes no stated fact's event;
--   2. a stated fact's event is accepted when the commit saves that stated fact with its confirmation id (the thread's
--      stores.statedFacts, or the account's stated_facts.facts / .keyed), one event each;
--   3. evidence without state: an event whose stated fact this commit does not save (or saves without its confirmation
--      id, or as a draft) fails the whole commit;
--   4. a brain-confirmed profile fact (no upload, no resume) is accepted exactly like a resume entry;
--   5. a replay writes nothing twice. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000ce801';
  ta uuid := '00000000-0000-4000-8000-00000ce8a001'; tb uuid := '00000000-0000-4000-8000-00000ce8b001';
  stated jsonb; evs jsonb; r jsonb;
begin
  insert into auth.users(id, email) values (u, 'ce8-u@example.test');
  insert into public.profiles(id) values (u);
  insert into public.career_watch_kv(user_id, key, value) values (u, 'career:account', '{"epoch":0,"version":0,"paused":false}');
  insert into public.agent_threads(id, user_id) values (ta, u), (tb, u);
  create temp table ce8(k text primary key, v jsonb) on commit drop;
  stated := jsonb_build_array(
    jsonb_build_object('kind', 'year', 'value', 'junior', 'evidence', 'I am a junior', 'provenance', 'owner stated in chat, in their own words (TEST)', 'confirmation_event_id', 's-0001'),
    jsonb_build_object('kind', 'majors', 'value', 'economics', 'evidence', 'majoring in economics', 'provenance', 'owner stated in chat, in their own words (TEST)', 'confirmation_event_id', 's-0002'));
  evs := (select jsonb_agg(jsonb_build_object('user_id', u, 'at', now(), 'kind', 'fact_confirmed', 'subject', (f->>'kind') || ': ' || (f->>'value'), 'source', 'chat',
    'detail', jsonb_build_object('kind', f->>'kind', 'value', f->>'value', 'confirmation_event_id', f->>'confirmation_event_id', 'message_sha256', repeat('e', 64),
      'thread_id', ta, 'via', 'router: stated by the person in chat'))) from jsonb_array_elements(stated) f);
  insert into ce8 values ('stated', stated), ('evs', evs);

  -- 1. Thread B saves first; thread A's statement then carries a stale account version.
  r := public.career_host_commit(u, tb, 'b1', repeat('b', 64), 0, 0, jsonb_build_object('scope', jsonb_build_object('userId', u)), '{}'::jsonb, 'hi',
    jsonb_build_object('reply', 'TEST', 'thread_id', tb));
  if r ? 'error' then raise exception 'FAIL setup: thread B saves: %', r; end if;
  r := public.career_host_commit_evidenced(jsonb_build_object('p_user', u, 'p_thread', ta, 'p_key', 'a1', 'p_hash', repeat('a', 64), 'p_revision', 0, 'p_account_version', 0,
    'p_snapshot', jsonb_build_object('scope', jsonb_build_object('userId', u), 'stores', jsonb_build_object('statedFacts', jsonb_build_object('facts', stated))),
    'p_patch', '{}'::jsonb, 'p_input', 'I am a junior majoring in economics', 'p_response', jsonb_build_object('reply', 'Noted.', 'thread_id', ta)), evs);
  if r->>'error' is distinct from 'revision_conflict' then raise exception 'FAIL a stale account version is refused: %', r; end if;
  if exists (select from public.career_events where user_id = u) then raise exception 'FAIL a refused save wrote a stated fact''s event'; end if;
  if exists (select from public.agent_flow_state where thread_id = ta) then raise exception 'FAIL a refused save wrote the thread'; end if;
  raise notice 'ok   a refused save (another thread saved first) writes no stated fact''s event and no thread state';
end $$;

create or replace function pg_temp.base(p_stores jsonb, p_key text default 'a2', p_ver bigint default 1, p_patch jsonb default '{}'::jsonb, p_rev bigint default 0) returns jsonb language sql as $$
 select jsonb_build_object('p_user', '00000000-0000-4000-8000-0000000ce801', 'p_thread', '00000000-0000-4000-8000-00000ce8a001', 'p_key', p_key, 'p_hash', repeat('a', 64),
  'p_revision', p_rev, 'p_account_version', p_ver,
  'p_snapshot', jsonb_build_object('scope', jsonb_build_object('userId', '00000000-0000-4000-8000-0000000ce801'), 'stores', p_stores),
  'p_patch', p_patch, 'p_input', 'I am a junior majoring in economics', 'p_response', jsonb_build_object('reply', 'Noted.', 'thread_id', '00000000-0000-4000-8000-00000ce8a001')) $$;
create or replace function pg_temp.refused(p_base jsonb, p_events jsonb) returns text language plpgsql as $$
begin
 perform public.career_host_commit_evidenced(p_base, p_events);
 return null;
exception when others then return sqlerrm;
end $$;

-- 3. Evidence without state: the commit fails whole.
do $$
declare e text; evs jsonb := (select v from ce8 where k = 'evs'); stated jsonb := (select v from ce8 where k = 'stated'); u uuid := '00000000-0000-4000-8000-0000000ce801';
begin
  e := pg_temp.refused(pg_temp.base(jsonb_build_object('statedFacts', jsonb_build_object('facts', stated - 1))), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL a stated fact the commit does not save: %', e; end if;
  e := pg_temp.refused(pg_temp.base(jsonb_build_object('statedFacts', jsonb_build_object('facts', (select jsonb_agg(f - 'confirmation_event_id') from jsonb_array_elements(stated) f)))), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL a stated fact saved without its confirmation id: %', e; end if;
  e := pg_temp.refused(pg_temp.base(jsonb_build_object('statedFacts', jsonb_build_object('facts', (select jsonb_agg(f || '{"needs_confirmation":true}') from jsonb_array_elements(stated) f)))), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL a stated fact saved as a draft: %', e; end if;
  e := pg_temp.refused(pg_temp.base('{}'::jsonb), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL nothing saved at all: %', e; end if;
  if exists (select from public.career_events where user_id = u) or exists (select from public.agent_flow_state where thread_id = '00000000-0000-4000-8000-00000ce8a001') then
   raise exception 'FAIL a failed commit wrote something';
  end if;
  raise notice 'ok   evidence without state (a stated fact not saved, saved without its confirmation id, or a draft) fails the whole commit';
end $$;

-- 2 and 5. Accepted from the thread's stores, one event each; a replay writes nothing twice; the account's keyed list counts too.
do $$
declare u uuid := '00000000-0000-4000-8000-0000000ce801'; r jsonb; evs jsonb := (select v from ce8 where k = 'evs'); stated jsonb := (select v from ce8 where k = 'stated');
  keyed jsonb; kev jsonb;
begin
  r := public.career_host_commit_evidenced(pg_temp.base(jsonb_build_object('statedFacts', jsonb_build_object('facts', stated))), evs);
  if r ? 'error' or r->'response'->>'reply' <> 'Noted.' then raise exception 'FAIL the commit is accepted: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and kind = 'fact_confirmed') <> 2 then raise exception 'FAIL one event per stated fact'; end if;
  if (select count(*) from public.career_events e join jsonb_array_elements((select state#>'{career,stores,statedFacts,facts}' from public.agent_flow_state where thread_id = '00000000-0000-4000-8000-00000ce8a001')) f
      on f->>'confirmation_event_id' = e.detail->>'confirmation_event_id' where e.user_id = u) <> 2 then
   raise exception 'FAIL every event names a stated fact the saved thread holds';
  end if;
  r := public.career_host_commit_evidenced(pg_temp.base(jsonb_build_object('statedFacts', jsonb_build_object('facts', stated))), evs);
  if coalesce(r->>'replay', '') <> 'true' then raise exception 'FAIL the same turn again is a replay: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and kind = 'fact_confirmed') <> 2 then raise exception 'FAIL a replay wrote a second event'; end if;
  raise notice 'ok   accepted from the thread''s stated facts, one event each; a replay writes nothing twice';
  -- The account's stated_facts record (its keyed list: a fact the SQL validator does not shape-check) is a saved place too.
  keyed := jsonb_build_array(jsonb_build_object('kind', 'recruiter', 'key', 'acme', 'value', 'Dana at Acme', 'confirmation_event_id', 's-0003', 'provenance', 'owner stated in chat, in their own words (TEST)'));
  kev := jsonb_build_array(jsonb_build_object('user_id', u, 'at', now(), 'kind', 'fact_confirmed', 'subject', 'recruiter: Dana at Acme', 'source', 'chat',
    'detail', jsonb_build_object('kind', 'recruiter', 'key', 'acme', 'value', 'Dana at Acme', 'confirmation_event_id', 's-0003', 'via', 'router: stated by the person in chat')));
  r := public.career_host_commit_evidenced(pg_temp.base('{}'::jsonb, 'a4', 2, jsonb_build_object('stated_facts', jsonb_build_object('facts', '[]'::jsonb, 'keyed', keyed, 'offer', null, 'updated_at', now())), 1), kev);
  if r ? 'error' then raise exception 'FAIL a keyed stated fact on the account patch is a saved place: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and detail->>'confirmation_event_id' = 's-0003') <> 1 then raise exception 'FAIL the keyed fact''s event'; end if;
  raise notice 'ok   a stated fact saved on the account''s keyed list carries its event';
end $$;

-- 4. The brain's confirm_profile_fact: a profile fact confirmed in chat (no resume upload) is evidenced like a resume entry.
do $$
declare u uuid := '00000000-0000-4000-8000-0000000ce801'; r jsonb; fact jsonb; ev jsonb;
begin
  fact := jsonb_build_array(jsonb_build_object('id', 'F-001', 'kind', 'experience', 'text', 'Data analyst at TEST Brain Co', 'status', 'confirmed', 'needs_confirmation', false,
    'provenance', 'owner confirmed in chat (TEST)', 'confirmation_event_id', 'b-0001'));
  ev := jsonb_build_array(jsonb_build_object('user_id', u, 'at', now(), 'kind', 'fact_confirmed', 'subject', 'Data analyst at TEST Brain Co', 'source', 'chat',
    'detail', jsonb_build_object('id', 'F-001', 'kind', 'experience', 'confirmation_event_id', 'b-0001', 'message_sha256', repeat('f', 64))));
  if pg_temp.refused(pg_temp.base(jsonb_build_object('profile', jsonb_build_object('facts', (select jsonb_agg(f || '{"status":"draft","needs_confirmation":true}') from jsonb_array_elements(fact) f))), 'a5', 3, '{}'::jsonb, 2), ev) not like 'evidence without state%' then
   raise exception 'FAIL a brain confirmation of a fact the commit saves as a draft';
  end if;
  r := public.career_host_commit_evidenced(pg_temp.base(jsonb_build_object('profile', jsonb_build_object('facts', fact)), 'a5', 3, '{}'::jsonb, 2), ev);
  if r ? 'error' then raise exception 'FAIL a brain confirmation is accepted: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and detail->>'confirmation_event_id' = 'b-0001') <> 1 then raise exception 'FAIL the brain confirmation''s event'; end if;
  raise notice 'ok   the brain''s confirm_profile_fact is written with the save, like a resume entry';
end $$;
rollback;
