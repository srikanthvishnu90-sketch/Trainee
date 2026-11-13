-- D-075 (20261113140000_career_apply_stop_stale_facts.sql), in the database alone: the stop closes, for one person, the approved
-- applications not yet started whose payload states a changed value; one already tried is reported and left; another person's row
-- and a row stating another value are untouched; the claim guard closes a row the stop left instead of starting it; facts_at is
-- the stamp trigger's; anon and authenticated can run none of it. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f7501','sf-a@example.test'),('00000000-0000-4000-8000-0000000f7502','sf-b@example.test');
insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000f7501'),('00000000-0000-4000-8000-0000000f7502') on conflict do nothing;
do $$
declare a uuid := '00000000-0000-4000-8000-0000000f7501'; b uuid := '00000000-0000-4000-8000-0000000f7502'; r jsonb; n int; st text; fa timestamptz;
begin
  if not public.career_apply_payload_states('{"answers":[{"label":"GPA","value":"3.9"}]}', array['3.9'])
     or public.career_apply_payload_states('{"answers":[{"label":"GPA","value":"3.95"},{"label":"x","value":"13.9"}]}', array['3.9'])
     or not public.career_apply_payload_states('{"fields":[{"value":3.9}],"note":"lives in austin"}', array['Austin'])
     or public.career_apply_payload_states('{"answers":[{"value":"3.9"}]}', array['3']) then raise exception 'FAIL career_apply_payload_states'; end if;
  raise notice 'ok   a payload states a value as a whole word, in any case; never inside another number';

  -- Seeded past the approval and resume guards (not what this file is about); the stamp trigger is then run by a plain update.
  set local session_replication_role = replica;
  insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts) values
    (a,'sf-1','Unstarted Co','https://example.test/1','{"answers":[{"label":"GPA","value":"3.9"}]}',repeat('a',64),repeat('a',64),'queued',0),
    (a,'sf-2','Tried Co','https://example.test/2','{"answers":[{"label":"GPA","value":"3.9"}]}',repeat('b',64),repeat('b',64),'queued',1),
    (a,'sf-3','Other Value Co','https://example.test/3','{"answers":[{"label":"GPA","value":"3.95"}]}',repeat('c',64),repeat('c',64),'queued',0),
    (b,'sf-4','Someone Else Co','https://example.test/4','{"answers":[{"label":"GPA","value":"3.9"}]}',repeat('d',64),repeat('d',64),'queued',0);
  set local session_replication_role = origin;

  begin perform public.career_apply_stop_stale_facts(a, array['3'], 'set_aside'); raise exception 'FAIL a one-character value was accepted';
  exception when others then if sqlerrm <> 'invalid fact change' then raise; end if; end;

  r := public.career_apply_stop_stale_facts(a, array['GPA: 3.9', '3.9'], 'set_aside');
  if jsonb_array_length(r->'cancelled') <> 1 or r->'cancelled'->0->>'company' <> 'Unstarted Co' or jsonb_array_length(r->'started') <> 1
     or r->'started'->0->>'company' <> 'Tried Co' or jsonb_array_length(r->'discarded') <> 0 or jsonb_array_length(r->'being_sent') <> 0 then
    raise exception 'FAIL the stop returned %', r; end if;
  select string_agg(job_id || ':' || state, ',' order by job_id) into st from public.career_apply_jobs where user_id in (a, b);
  if st <> 'sf-1:not_submitted,sf-2:queued,sf-3:queued,sf-4:queued' then raise exception 'FAIL states after the stop: %', st; end if;
  if (select evidence->>'reason' from public.career_apply_jobs where job_id = 'sf-1') <> 'fact_changed' then raise exception 'FAIL no reason recorded'; end if;
  raise notice 'ok   the stop closes the unstarted row unsent, reports the tried one, leaves another value and another person';

  -- The claim guard: the start of a drive on the tried row is skipped and the row is closed; an unaffected row starts.
  update public.career_apply_jobs set state = 'driving', attempts = 2, claimed_at = now(), lease_token = gen_random_uuid() where job_id = 'sf-2';
  get diagnostics n = row_count;
  select state into st from public.career_apply_jobs where job_id = 'sf-2';
  if n <> 0 or st <> 'not_submitted' then raise exception 'FAIL the claim started a stale row (% rows, state %)', n, st; end if;
  if (select evidence->>'stopped_by' from public.career_apply_jobs where job_id = 'sf-2') <> 'claim' then raise exception 'FAIL the claim guard left no reason'; end if;
  raise notice 'ok   the claim closes a row stating a changed value instead of starting it';

  -- facts_at: only the stamp trigger moves it.
  select coalesce(facts_at, created_at) into fa from public.career_apply_jobs where job_id = 'sf-3';
  update public.career_apply_jobs set facts_at = now() + interval '1 day' where job_id = 'sf-3';
  if (select facts_at from public.career_apply_jobs where job_id = 'sf-3') is distinct from fa then raise exception 'FAIL facts_at was moved by a plain update'; end if;
  raise notice 'ok   facts_at cannot be moved by an ordinary update';

  if has_function_privilege('anon', 'public.career_apply_stop_stale_facts(uuid,text[],text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_apply_stop_stale_facts(uuid,text[],text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.career_apply_stop_stale_facts(uuid,text[],text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_apply_fact_changed_close(uuid,timestamptz,text)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.career_apply_fact_changes', 'SELECT') or has_table_privilege('anon', 'public.career_apply_fact_changes', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.career_apply_fact_changes'::regclass) then raise exception 'FAIL grants'; end if;
  raise notice 'ok   service role only; the record of changes is closed to anon and authenticated';

  delete from auth.users where id = a;
  if exists (select 1 from public.career_apply_fact_changes where user_id = a) then raise exception 'FAIL the changes outlived the account'; end if;
  raise notice 'ok   deleting the account removes the record of changes';
end $$;
rollback;
