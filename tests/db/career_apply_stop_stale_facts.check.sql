-- D-075 (20261113140000_career_apply_stop_stale_facts.sql), in the database alone: a changed fact stops, for one person, the
-- approved applications stating it: by fact id (a derived "Yes" included), else by normalised value (3.90 = 3.9; never "yes" alone);
-- one already tried is reported and left for the claim; another person's row and a row stating another fact are untouched; the claim
-- guard closes a row the stop left; the fact write itself records a change (the account record), with no stop call; facts_at moves
-- only with a new approval; anon and authenticated can run none of it. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f7501','sf-a@example.test'),('00000000-0000-4000-8000-0000000f7502','sf-b@example.test');
insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000f7501'),('00000000-0000-4000-8000-0000000f7502') on conflict do nothing;
do $$
declare a uuid := '00000000-0000-4000-8000-0000000f7501'; b uuid := '00000000-0000-4000-8000-0000000f7502'; r jsonb; n int; st text; fa timestamptz;
begin
  if not public.career_apply_payload_stale('{"fields":[{"label":"Authorized?","value":"Yes","factId":"F0"}]}', array['F0'], '{}')
     or not public.career_apply_payload_stale('{"answers":[{"label":"GPA","value":"3.90"}]}', '{}', public.career_apply_changed_keys('GPA: 3.9', null, null, null))
     or not public.career_apply_payload_stale('{"answers":[{"value":"05/2026"}]}', '{}', public.career_apply_changed_keys('Graduating in May 2026', null, 'Graduating in December 2026', null))
     or public.career_apply_payload_stale('{"answers":[{"value":"3.95"},{"value":"Yes"},{"value":"May"}]}', '{}', public.career_apply_changed_keys('GPA: 3.9', null, null, null) || public.career_apply_changed_keys('Yes', null, null, null))
  then raise exception 'FAIL career_apply_payload_stale'; end if;
  if not public.career_apply_payload_stale('{"fields":[{"label":"What is your GPA?","value":"3.9","factId":"text-answer:1"}]}', array['F-gpa'], public.career_apply_changed_keys('GPA: 3.9', null, null, null))
     or not public.career_apply_payload_stale('{"fields":[{"label":"Authorized to work without sponsorship?","value":"Yes","factId":"F-wa"}]}', array['F-sp'], public.career_apply_changed_keys('Sponsorship: I do not need sponsorship', null, 'Sponsorship: I will need sponsorship', null))
     or public.career_apply_payload_stale('{"fields":[{"label":"How many references?","value":"2"}]}', array['F-py'], public.career_apply_changed_keys('2 years of Python experience', null, null, null))
     or (public.career_apply_facts_diff('[{"id":"F-py","text":"2 years of Python experience","status":"confirmed"},{"id":"F-c","text":"Citizenship: U.S. citizen","status":"confirmed"}]',
           '[{"id":"F-py2","text":"2 years of Python experience","status":"confirmed"},{"id":"F-c","text":"Citizenship: US citizen","status":"confirmed"}]')).ids <> '{}'
  then raise exception 'FAIL round 3 matching'; end if;
  raise notice 'ok   a field states its fact by id and its value; values compare normalised; yes/no/a month alone never';
  raise notice 'ok   a text answer and a two-fact answer are stale; the same words saved again and an unrelated 2 are not';

  set local session_replication_role = replica;
  insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts) values
    (a,'sf-1','Unstarted Co','https://example.test/1','{"fields":[{"label":"Authorized?","value":"Yes","factId":"F0"}]}',repeat('a',64),repeat('a',64),'queued',0),
    (a,'sf-2','Tried Co','https://example.test/2','{"fields":[{"label":"Authorized?","value":"Yes","factId":"F0"}]}',repeat('b',64),repeat('b',64),'queued',1),
    (a,'sf-3','Other Fact Co','https://example.test/3','{"fields":[{"label":"Willing to relocate?","value":"Yes","factId":"F1"}]}',repeat('c',64),repeat('c',64),'queued',0),
    (b,'sf-4','Someone Else Co','https://example.test/4','{"fields":[{"label":"Authorized?","value":"Yes","factId":"F0"}]}',repeat('d',64),repeat('d',64),'queued',0),
    (a,'sf-5','Write Co','https://example.test/5','{"fields":[{"label":"GPA","value":"3.8","factId":"F5"}]}',repeat('e',64),repeat('e',64),'queued',0);
  set local session_replication_role = origin;

  begin perform public.career_apply_stop_stale_facts(a, '[]'::jsonb, 'set_aside'); raise exception 'FAIL an empty change was accepted';
  exception when others then if sqlerrm <> 'invalid fact change' then raise; end if; end;

  r := public.career_apply_stop_stale_facts(a, '[{"id":"F0","was":"Work authorization: US citizen","now":null}]', 'set_aside');
  if jsonb_array_length(r->'cancelled') <> 1 or r->'cancelled'->0->>'company' <> 'Unstarted Co' or jsonb_array_length(r->'started') <> 1
     or r->'started'->0->>'company' <> 'Tried Co' or jsonb_array_length(r->'being_sent') <> 0 then raise exception 'FAIL the stop returned %', r; end if;
  select string_agg(job_id || ':' || state, ',' order by job_id) into st from public.career_apply_jobs where user_id in (a, b);
  if st <> 'sf-1:not_submitted,sf-2:queued,sf-3:queued,sf-4:queued,sf-5:queued' then raise exception 'FAIL states after the stop: %', st; end if;
  raise notice 'ok   the stop closes the unstarted row by fact id, reports the tried one, leaves another fact and another person';

  update public.career_apply_jobs set state = 'driving', attempts = 2, claimed_at = now(), lease_token = gen_random_uuid() where job_id = 'sf-2';
  get diagnostics n = row_count;
  select state into st from public.career_apply_jobs where job_id = 'sf-2';
  if n <> 0 or st <> 'not_submitted' then raise exception 'FAIL the claim started a stale row (% rows, state %)', n, st; end if;
  raise notice 'ok   the claim closes a row stating a changed fact instead of starting it';

  -- The fact write records the change itself: no stop call.
  update public.career_watch_kv set value = '{"memory":{"v":1,"profile":{"facts":[{"id":"F5","kind":"other","text":"GPA: 3.8","status":"confirmed"}]}}}' where user_id = a and key = 'career:account';
  if not found then insert into public.career_watch_kv(user_id,key,value) values (a,'career:account','{"memory":{"v":1,"profile":{"facts":[{"id":"F5","kind":"other","text":"GPA: 3.8","status":"confirmed"}]}}}'); end if;
  update public.career_watch_kv set value = '{"memory":{"v":1,"profile":{"facts":[{"id":"F5","kind":"other","text":"GPA: 3.7","status":"draft","needs_confirmation":true}]}}}' where user_id = a and key = 'career:account';
  if not exists (select from public.career_apply_fact_changes where user_id = a and reason = 'fact_write' and 'F5' = any(fact_ids) and 'n:3.8' = any(fact_keys)) then raise exception 'FAIL the fact write recorded nothing'; end if;
  update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = gen_random_uuid() where job_id = 'sf-5';
  if (select state from public.career_apply_jobs where job_id = 'sf-5') <> 'not_submitted' then raise exception 'FAIL a row stating a fact changed by a write was started'; end if;
  if (select jsonb_array_length(public.career_apply_fact_stops_untold(a))) <> 2 or (select jsonb_array_length(public.career_apply_fact_stops_untold(a))) <> 0 then
   raise exception 'FAIL the claim''s stops are not told once'; end if;
  raise notice 'ok   a fact write records the change in its own transaction; the claim refuses with no stop call';
  raise notice 'ok   what the claim stopped is told once (the chat''s own stop was said in its reply)';

  -- facts_at moves only with a new approval.
  select coalesce(facts_at, created_at) into fa from public.career_apply_jobs where job_id = 'sf-3';
  update public.career_apply_jobs set facts_at = now() + interval '1 day' where job_id = 'sf-3';
  update public.career_apply_jobs set state = 'queued', reason = null where job_id = 'sf-1';
  if (select facts_at from public.career_apply_jobs where job_id = 'sf-3') is distinct from fa
     or (select facts_at from public.career_apply_jobs where job_id = 'sf-1') > (select max(at) from public.career_apply_fact_changes where user_id = a and 'F0' = any(fact_ids)) then
   raise exception 'FAIL facts_at moved without a new approval'; end if;
  raise notice 'ok   facts_at moves only with a new approval (not by an update, not by not_submitted -> queued)';

  if has_function_privilege('anon', 'public.career_apply_stop_stale_facts(uuid,jsonb,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_apply_stop_stale_facts(uuid,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.career_apply_stop_stale_facts(uuid,jsonb,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_apply_fact_changed_close(uuid,timestamptz,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_apply_fact_hit(uuid,jsonb,timestamptz)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.career_apply_fact_changes', 'SELECT') or has_table_privilege('anon', 'public.career_apply_fact_changes', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.career_apply_fact_changes'::regclass) then raise exception 'FAIL grants'; end if;
  raise notice 'ok   service role only; the record of changes is closed to anon and authenticated';

  delete from auth.users where id = a;
  if exists (select 1 from public.career_apply_fact_changes where user_id = a) then raise exception 'FAIL the changes outlived the account'; end if;
  raise notice 'ok   deleting the account removes the record of changes';
end $$;
rollback;
