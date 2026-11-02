-- TAILORING ROUND 3 (20261031090000_career_thread_facts_authority.sql), in the database alone: a web-only person's profile
-- is per thread. A payload stamped with their account is current after an ordinary turn, a first confirmation or a new
-- thread, and stale once a value the thread held as confirmed changes or is withdrawn (a correction), as career_host_commit
-- writes it (the account's version first, then the thread). A draft, a frame, a newly confirmed fact or another thread's
-- turn changes nothing; the functions are service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000f3a01';
  ta uuid := '00000000-0000-4000-8000-0000000f3a0a';
  tb uuid := '00000000-0000-4000-8000-0000000f3a0b';
  conf jsonb := '{"id":"F-1","kind":"education","title":"B.S. Computer Science, TEST University, GPA 3.7","status":"confirmed","needs_confirmation":false}';
  fixed jsonb := '{"id":"F-1","kind":"education","title":"B.S. Computer Science, TEST University, GPA 3.9","status":"confirmed","needs_confirmation":false}';
  draft jsonb := '{"id":"F-2","kind":"experience","title":"Draft entry (TEST)","status":"draft","needs_confirmation":true}';
  st jsonb; p jsonb; v bigint; a jsonb;
begin
  insert into auth.users(id, email) values (u, 'r3facts@example.test');
  insert into public.profiles(id) values (u);
  insert into public.career_watch_kv(user_id, key, value) values (u, 'career:account', '{"epoch":0,"version":0,"paused":false}');
  insert into public.agent_threads(id, user_id) values (ta, u), (tb, u);
  -- a turn: the account's version moves, then the thread's state (career_host_commit's order)
  update public.career_watch_kv set value = value || '{"version":1}' where user_id = u and key = 'career:account';
  st := jsonb_build_object('career', jsonb_build_object('revision', 1, 'stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(conf)))));
  insert into public.agent_flow_state(thread_id, user_id, state) values (ta, u, st);
  select value into a from public.career_watch_kv where user_id = u and key = 'career:account';
  if (a->>'authority_version')::bigint <> 0 or a ? 'thread_facts' then raise exception 'FAIL a first confirmed resume in a new thread moved authority (%)', a; end if;
  raise notice 'ok   a thread''s first confirmed facts move nothing: no approval was made from a value that did not exist';
  p := jsonb_build_object('version', 1, 'user_id', u, 'privacy_epoch', 0, 'account_version', 1, 'expires_at', (now() + interval '1 day')::text);
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL a payload stamped now is not current'; end if;
  -- an ordinary turn: a frame changes, the facts do not
  update public.career_watch_kv set value = value || '{"version":2}' where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = jsonb_set(state, '{career,revision}', '2') || jsonb_build_object('career', (state->'career') || '{"frame":"thanks"}') where thread_id = ta;
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL an ordinary turn made the payload stale'; end if;
  -- a draft entry arrives: no confirmed fact changed
  update public.career_watch_kv set value = value || '{"version":3}' where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts}', jsonb_build_array(conf, draft)) where thread_id = ta;
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL a draft made the payload stale'; end if;
  -- the draft is confirmed (a new value) and the old fact's bookkeeping is re-stamped: no held value changed
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts}', jsonb_build_array(
    conf || '{"confirmed_at":"2026-11-02T00:00:00Z","provenance":"re-stamped (TEST)"}', draft || '{"status":"confirmed","needs_confirmation":false}')) where thread_id = ta;
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL a newly confirmed fact or re-stamped bookkeeping made the payload stale'; end if;
  -- withdrawn (back to a draft): a held value is gone
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts}', jsonb_build_array(conf, draft)) where thread_id = ta;
  if public.career_apply_current(u, p) is not false then raise exception 'FAIL a withdrawn confirmed fact left the payload current'; end if;
  p := p || '{"account_version":3}';
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL a payload stamped after the withdrawal is not current'; end if;
  select value into a from public.career_watch_kv where user_id = u and key = 'career:account';
  if a->'thread_facts' ? ta::text is not true or a::text ~ 'GPA|TEST' then raise exception 'FAIL the account does not hold only the thread''s mark (%)', a; end if;
  raise notice 'ok   a newly confirmed fact or a re-stamp moves nothing; a withdrawn one moves authority; the account keeps a hash, never the fact';
  -- another thread's turn with no profile
  update public.career_watch_kv set value = value || '{"version":4}' where user_id = u and key = 'career:account';
  insert into public.agent_flow_state(thread_id, user_id, state) values (tb, u, '{"career":{"revision":1}}');
  if public.career_apply_current(u, p) is not true then raise exception 'FAIL another thread''s turn made the payload stale'; end if;
  raise notice 'ok   an ordinary turn, a draft and another thread''s turn leave an approval current';
  -- the correction: GPA 3.7 -> 3.9
  update public.career_watch_kv set value = value || '{"version":5}' where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts}', jsonb_build_array(fixed, draft)) where thread_id = ta;
  if public.career_apply_current(u, p) is not false then raise exception 'FAIL a payload made with GPA 3.7 is current after the correction'; end if;
  select value into a from public.career_watch_kv where user_id = u and key = 'career:account';
  if (a->>'authority_version')::bigint <> 5 then raise exception 'FAIL authority_version is % after the correction, want 5', a->>'authority_version'; end if;
  if public.career_apply_current(u, p || '{"account_version":5}') is not true then raise exception 'FAIL a payload stamped after the correction is not current'; end if;
  raise notice 'ok   a corrected confirmed fact makes an approval stamped before it stale; one stamped after it is current';
  -- basics count too: a first value moves nothing, a changed one does
  update public.career_watch_kv set value = value || '{"version":6}' where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,basics}', '{"email":"r3facts@example.test"}') where thread_id = ta;
  if public.career_apply_current(u, p || '{"account_version":5}') is not true then raise exception 'FAIL a first basic made the approval stale'; end if;
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,basics}', '{"email":"r3facts.new@example.test"}') where thread_id = ta;
  if public.career_apply_current(u, p || '{"account_version":5}') is not false then raise exception 'FAIL a changed basic left the approval current'; end if;
  -- changed back: moves again
  update public.career_watch_kv set value = value || '{"version":7}' where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,basics}', '{"email":"r3facts@example.test"}') where thread_id = ta;
  if public.career_apply_current(u, p || '{"account_version":6}') is not false then raise exception 'FAIL a basic changed back left the approval current'; end if;
  raise notice 'ok   a changed profile basic makes an approval stale (a first one does not; one changed back does)';
  -- an account-backed thread holds a copy of the account's profile: clearing or replacing that copy moves nothing
  update public.career_watch_kv set value = value || '{"version":8}' where user_id = u and key = 'career:account';
  select (value->>'authority_version')::bigint into v from public.career_watch_kv where user_id = u and key = 'career:account';
  update public.agent_flow_state set state = '{"career":{"account_memory":1,"revision":2,"stores":{"profile":{"facts":[{"id":"F-9","title":"copy (TEST)","status":"confirmed"}]}}}}' where thread_id = tb;
  update public.agent_flow_state set state = '{"career":{"account_memory":1,"revision":3,"stores":{}}}' where thread_id = tb;
  if (select (value->>'authority_version')::bigint from public.career_watch_kv where user_id = u and key = 'career:account') <> v then
    raise exception 'FAIL an account-backed thread''s copy moved authority';
  end if;
  raise notice 'ok   an account-backed thread''s copy (set or cleared) moves nothing';
  -- service only
  if has_function_privilege('anon', 'public.career_thread_facts_authority()', 'execute') or has_function_privilege('authenticated', 'public.career_thread_facts_authority()', 'execute')
    or has_function_privilege('anon', 'public.career_thread_facts_mark(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.career_thread_facts_mark(jsonb)', 'execute')
    or has_function_privilege('anon', 'public.career_thread_facts_changed(jsonb, jsonb)', 'execute') or has_function_privilege('authenticated', 'public.career_thread_facts_changed(jsonb, jsonb)', 'execute') then
    raise exception 'FAIL a client role can execute the thread facts functions';
  end if;
  raise notice 'ok   service only';
end $$;
rollback;
