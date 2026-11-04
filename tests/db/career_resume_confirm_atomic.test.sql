-- RESUME CONFIRMATION, ALL OR NOTHING (20261030060000_career_resume_confirm_atomic.sql): career_host_commit_evidenced
-- saves the turn and writes the confirmation's fact_confirmed events (and so the one resume record) in one transaction:
--   1. a refused save (the account moved: another thread saved first) writes no event, no record, no thread state;
--   2. an event whose confirmation the saved profile does not hold as confirmed (evidence without state) fails the whole
--      commit; so does an event of another person, a malformed one, or a commit that is also an erase;
--   3. an event that cannot be written fails the whole commit: the thread, the account version and the messages stay;
--   4. accepted: the thread holds the confirmed entries, one event each, the record names the upload, on file;
--   5. a replay of the saved turn, and a later commit naming the same confirmations, write no second event;
--   6. service role only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000ca701'; o uuid := '00000000-0000-4000-8000-0000000ca702';
  ta uuid := '00000000-0000-4000-8000-00000ca7a001'; tb uuid := '00000000-0000-4000-8000-00000ca7b001';
  resume text := E'TEST Person\nEXPERIENCE\nData Analyst Intern, TEST Atomic Co\n- Built TEST dashboards';
  mid bigint; sha text; r jsonb; evs jsonb; conf jsonb; drafts jsonb; n int;
begin
  insert into auth.users(id, email) values (u, 'ca7-u@example.test'), (o, 'ca7-o@example.test');
  insert into public.profiles(id) values (u), (o);
  insert into public.career_watch_kv(user_id, key, value) values (u, 'career:account', '{"epoch":0,"version":0,"paused":false}');
  insert into public.agent_threads(id, user_id) values (ta, u), (tb, u);
  insert into public.agent_messages(thread_id, role, content) values (ta, 'user', resume) returning id into mid;
  sha := encode(sha256(convert_to(resume, 'UTF8')), 'hex');
  create temp table ca7(k text primary key, v jsonb) on commit drop;
  -- The profile the turn leaves: two entries, confirmed with their confirmation ids (or still drafts).
  conf := jsonb_build_array(
    jsonb_build_object('id', 'f1', 'kind', 'experience', 'title', 'Data Analyst Intern, TEST Atomic Co', 'text', 'Data Analyst Intern, TEST Atomic Co', 'status', 'confirmed', 'needs_confirmation', false, 'source', 'resume-ingest', 'confirmation_event_id', 'c-0001'),
    jsonb_build_object('id', 'f2', 'kind', 'experience', 'title', 'Built TEST dashboards', 'text', 'Built TEST dashboards', 'status', 'confirmed', 'needs_confirmation', false, 'source', 'resume-ingest', 'confirmation_event_id', 'c-0002'));
  drafts := (select jsonb_agg((f - 'confirmation_event_id') || '{"status":"draft","needs_confirmation":true}') from jsonb_array_elements(conf) f);
  evs := (select jsonb_agg(jsonb_build_object('user_id', u, 'at', now(), 'kind', 'fact_confirmed', 'subject', f->>'text', 'source', 'chat',
    'detail', jsonb_build_object('id', f->>'id', 'kind', 'experience', 'confirmation_event_id', f->>'confirmation_event_id', 'message_sha256', repeat('d', 64),
      'upload', jsonb_build_object('kind', 'message', 'ref', 'agent_messages:' || mid, 'sha256', sha), 'via', 'router: their yes to the resume entries shown to them'))) from jsonb_array_elements(conf) f);
  insert into ca7 values ('conf', conf), ('drafts', drafts), ('evs', evs);

  -- 1. Thread B saves first (the web chat's turn); thread A's yes then loads a stale account version.
  r := public.career_host_commit(u, tb, 'b1', repeat('b', 64), 0, 0, jsonb_build_object('scope', jsonb_build_object('userId', u)), '{}'::jsonb, 'yes',
    jsonb_build_object('reply', 'TEST', 'thread_id', tb));
  if r ? 'error' then raise exception 'FAIL setup: thread B saves: %', r; end if;
  r := public.career_host_commit_evidenced(jsonb_build_object('p_user', u, 'p_thread', ta, 'p_key', 'a1', 'p_hash', repeat('a', 64), 'p_revision', 0, 'p_account_version', 0,
    'p_snapshot', jsonb_build_object('scope', jsonb_build_object('userId', u), 'stores', jsonb_build_object('profile', jsonb_build_object('facts', conf))),
    'p_patch', '{}'::jsonb, 'p_input', 'yes, that''s my resume', 'p_response', jsonb_build_object('reply', 'Confirmed.', 'thread_id', ta)), evs);
  if r->>'error' is distinct from 'revision_conflict' then raise exception 'FAIL a stale account version is refused: %', r; end if;
  if exists (select from public.career_events where user_id = u) then raise exception 'FAIL a refused save wrote evidence'; end if;
  if exists (select from public.career_resume_record where user_id = u) then raise exception 'FAIL a refused save wrote the resume record'; end if;
  if exists (select from public.agent_flow_state where thread_id = ta) then raise exception 'FAIL a refused save wrote the thread'; end if;
  if public.career_resume_on_file(u) then raise exception 'FAIL nothing is on file after a refused save'; end if;
  if (select count(*) from public.agent_messages where thread_id = ta) <> 1 then raise exception 'FAIL a refused save wrote messages'; end if;
  raise notice 'ok   a refused save (another thread saved first) writes no event, no record, no thread state';
end $$;

-- 2. Evidence without state, another person's event, a malformed list, an erase: the whole commit fails.
create or replace function pg_temp.base(p_facts jsonb, p_key text default 'a2', p_ver bigint default 1, p_patch jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('p_user', '00000000-0000-4000-8000-0000000ca701', 'p_thread', '00000000-0000-4000-8000-00000ca7a001', 'p_key', p_key, 'p_hash', repeat('a', 64),
  'p_revision', 0, 'p_account_version', p_ver,
  'p_snapshot', jsonb_build_object('scope', jsonb_build_object('userId', '00000000-0000-4000-8000-0000000ca701'), 'stores', jsonb_build_object('profile', jsonb_build_object('facts', p_facts))),
  'p_patch', p_patch, 'p_input', 'yes, that''s my resume', 'p_response', jsonb_build_object('reply', 'Confirmed.', 'thread_id', '00000000-0000-4000-8000-00000ca7a001')) $$;
create or replace function pg_temp.refused(p_base jsonb, p_events jsonb) returns text language plpgsql as $$
begin
 perform public.career_host_commit_evidenced(p_base, p_events);
 return null;
exception when others then return sqlerrm;
end $$;
create or replace function pg_temp.nothing_written(label text) returns void language plpgsql as $$
declare u uuid := '00000000-0000-4000-8000-0000000ca701';
begin
 if exists (select from public.career_events where user_id = u) or exists (select from public.career_resume_record where user_id = u)
    or exists (select from public.agent_flow_state where thread_id = '00000000-0000-4000-8000-00000ca7a001')
    or (select value->>'version' from public.career_watch_kv where user_id = u and key = 'career:account') <> '1'
    or (select count(*) from public.agent_messages where thread_id = '00000000-0000-4000-8000-00000ca7a001') <> 1 then
  raise exception 'FAIL % wrote something', label;
 end if;
end $$;
do $$
declare e text; evs jsonb := (select v from ca7 where k = 'evs'); conf jsonb := (select v from ca7 where k = 'conf');
begin
  e := pg_temp.refused(pg_temp.base((select v from ca7 where k = 'drafts')), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL drafts in the saved profile: %', e; end if;
  perform pg_temp.nothing_written('evidence for drafts');
  e := pg_temp.refused(pg_temp.base(conf - 1), evs);
  if e is null or e not like 'evidence without state%' then raise exception 'FAIL an entry the saved profile lacks: %', e; end if;
  perform pg_temp.nothing_written('evidence for a missing entry');
  e := pg_temp.refused(pg_temp.base(conf), jsonb_set(evs, '{0,user_id}', '"00000000-0000-4000-8000-0000000ca702"'));
  if e is distinct from 'invalid evidenced commit' then raise exception 'FAIL another person''s event: %', e; end if;
  e := pg_temp.refused(pg_temp.base(conf), evs || jsonb_build_array(evs->0));
  if e is distinct from 'invalid evidenced commit' then raise exception 'FAIL one confirmation twice: %', e; end if;
  e := pg_temp.refused(pg_temp.base(conf), '[]'::jsonb);
  if e is distinct from 'invalid evidenced commit' then raise exception 'FAIL no events: %', e; end if;
  e := pg_temp.refused(pg_temp.base(conf), jsonb_set(evs, '{0,kind}', '"note"'));
  if e is distinct from 'invalid evidenced commit' then raise exception 'FAIL another kind: %', e; end if;
  e := pg_temp.refused(pg_temp.base(conf, 'a2', 1, '{"erase":true}'::jsonb), evs);
  if e is distinct from 'invalid evidenced commit' then raise exception 'FAIL evidence riding an erase: %', e; end if;
  perform pg_temp.nothing_written('a malformed commit');
  raise notice 'ok   evidence without state, another person''s event, a malformed list or an erase fails the whole commit';
end $$;

-- 3. An event that cannot be written fails the whole commit (the thread, the account version and the messages stay).
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'TEST event write refused'; end $$;
create trigger ca7_boom before insert on public.career_events for each row when (new.subject = 'Built TEST dashboards') execute function pg_temp.boom();
do $$
declare e text;
begin
  e := pg_temp.refused(pg_temp.base((select v from ca7 where k = 'conf')), (select v from ca7 where k = 'evs'));
  if e is distinct from 'TEST event write refused' then raise exception 'FAIL the event write failure is the commit''s: %', e; end if;
  perform pg_temp.nothing_written('a commit whose second event failed');
  raise notice 'ok   an event that cannot be written fails the whole commit: no first event, no record, no thread state';
end $$;
drop trigger ca7_boom on public.career_events;

-- 4-5. Accepted, then replayed, then the same confirmations again.
do $$
declare u uuid := '00000000-0000-4000-8000-0000000ca701'; r jsonb; evs jsonb := (select v from ca7 where k = 'evs'); conf jsonb := (select v from ca7 where k = 'conf');
  sha text := (select encode(sha256(convert_to(content, 'UTF8')), 'hex') from public.agent_messages where thread_id = '00000000-0000-4000-8000-00000ca7a001');
begin
  r := public.career_host_commit_evidenced(pg_temp.base(conf), evs);
  if r ? 'error' or r->'response'->>'reply' <> 'Confirmed.' then raise exception 'FAIL the commit is accepted: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and kind = 'fact_confirmed') <> 2 then raise exception 'FAIL one event per confirmed entry'; end if;
  if (select count(*) from public.career_events e join jsonb_array_elements((select state#>'{career,stores,profile,facts}' from public.agent_flow_state where thread_id = '00000000-0000-4000-8000-00000ca7a001')) f
      on f->>'confirmation_event_id' = e.detail->>'confirmation_event_id' where e.user_id = u and f->>'status' = 'confirmed') <> 2 then
   raise exception 'FAIL every event names an entry the saved thread holds as confirmed';
  end if;
  if (select state || ':' || kind || ':' || sha256 from public.career_resume_record where user_id = u) is distinct from 'confirmed:paste:' || sha then
   raise exception 'FAIL the record names the upload: %', (select row_to_json(x) from public.career_resume_record x where user_id = u);
  end if;
  if not public.career_resume_on_file(u) then raise exception 'FAIL on file after the save'; end if;
  if (select value->>'version' from public.career_watch_kv where user_id = u and key = 'career:account') <> '2' then raise exception 'FAIL the account version moved once'; end if;
  raise notice 'ok   accepted: the thread holds the confirmed entries, one event each, the record names the upload, on file';
  r := public.career_host_commit_evidenced(pg_temp.base(conf), evs);
  if coalesce(r->>'replay', '') <> 'true' then raise exception 'FAIL the same turn again is a replay: %', r; end if;
  r := public.career_host_commit_evidenced(pg_temp.base(conf, 'a3', 2) || jsonb_build_object('p_revision', 1), evs);
  if r ? 'error' then raise exception 'FAIL a later commit naming the same confirmations is saved: %', r; end if;
  if (select count(*) from public.career_events where user_id = u and kind = 'fact_confirmed') <> 2 then raise exception 'FAIL a replay or a repeat wrote a second event'; end if;
  if (select generation from public.career_resume_record where user_id = u) <> 1 then raise exception 'FAIL the record was written once'; end if;
  raise notice 'ok   a replay of the saved turn and a later commit naming the same confirmations write no second event';
end $$;

-- 6. Service role only.
do $$
begin
  if has_function_privilege('anon', 'public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb)', 'execute') then
   raise exception 'FAIL service role only';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.career_host_commit_evidenced(jsonb, jsonb, jsonb, jsonb)'::regprocedure) then raise exception 'FAIL security invoker'; end if;
  raise notice 'ok   service role only (security invoker, like career_host_commit)';
end $$;
rollback;
