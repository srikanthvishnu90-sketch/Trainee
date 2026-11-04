-- 20261027160000_career_outreach_followup_claim.sql: the leased claim of due networking follow-up reminders.
-- Proves on the real schema: only due, unleased rows of that key are claimed, oldest due first; a claim leases them so a
-- second claim gets the others (never the same person twice); a lapsed lease is claimed again; every due person is
-- reached by claiming until empty (no "first 500"); the claim runs on the index; service role only.
do $$
declare n int; a uuid[]; b uuid[];
begin
  -- 1,200 people with one due reminder each (due times spread, the last one oldest), 30 not yet due, 20 already fired.
  insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'fu' || g || '@example.test' from generate_series(1, 1250) g on conflict do nothing;
  insert into public.career_watch_kv (user_id, key, value)
  select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'career:outreach:followups',
         jsonb_build_object('items', jsonb_build_array(jsonb_build_object('draft_id', 'd' || g, 'due_at', to_char((timestamptz '2026-11-01 00:00:00+00' - make_interval(secs => g)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'fired_at', null)),
                            'next_due_at', case when g <= 1200 then to_char((timestamptz '2026-11-01 00:00:00+00' - make_interval(secs => g)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                                when g <= 1230 then '2026-12-01T00:00:00.000Z' else null end)
  from generate_series(1, 1250) g;
  -- Another key of the same person is never claimed.
  insert into public.career_watch_kv (user_id, key, value) values ('00000000-0000-4000-8000-000000000001', 'career:contacts', '{"next_due_at":"2020-01-01T00:00:00.000Z"}');

  -- Oldest due first, whatever plan the database picks (the index would hand rows in order even without an ORDER BY,
  -- so the check runs with index scans off): the claim is exactly the 100 oldest (g = 1101..1200).
  perform set_config('enable_indexscan', 'off', true); perform set_config('enable_bitmapscan', 'off', true);
  select array_agg(user_id order by value->>'next_due_at') into a from public.career_outreach_followups_claim(timestamptz '2026-11-02 00:00:00+00', 100, 300);
  perform set_config('enable_indexscan', 'on', true); perform set_config('enable_bitmapscan', 'on', true);
  if cardinality(a) <> 100 then raise exception 'FAIL claim size %', cardinality(a); end if;
  if a[1] <> '00000000-0000-4000-8000-000000001200'::uuid then raise exception 'FAIL oldest first: %', a[1]; end if;
  if exists (select 1 from unnest(a) u where u not in (select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1101, 1200) g)) then
    raise exception 'FAIL oldest first: the claim is not the 100 oldest due'; end if;
  select array_agg(user_id) into b from public.career_outreach_followups_claim(timestamptz '2026-11-02 00:00:00+00', 100, 300);
  if a && b then raise exception 'FAIL a leased person was claimed twice'; end if;
  raise notice 'ok   a claim takes the oldest due first and leases them; a second claim gets other people';

  -- Claim until empty: every due person exactly once (200 already leased above, 1000 left), none not yet due, none fired.
  n := 0;
  loop
    with c as (select * from public.career_outreach_followups_claim(timestamptz '2026-11-02 00:00:00+00', 137, 300)) select count(*) into strict n from c;
    exit when n = 0;
  end loop;
  select count(*) into n from public.career_watch_kv where key = 'career:outreach:followups' and value ? 'lease_until';
  if n <> 1200 then raise exception 'FAIL every due person claimed once by claiming until empty: % leased', n; end if;
  raise notice 'ok   claiming until empty reaches all 1,200 due people (no first-500 starvation), and nothing not yet due';

  -- A lease that lapsed is claimed again (an instance died mid-batch).
  select count(*) into n from public.career_outreach_followups_claim(timestamptz '2026-11-02 00:05:01+00', 5000, 300);
  if n <> 1200 then raise exception 'FAIL lapsed leases claimed again: %', n; end if;
  raise notice 'ok   lapsed leases are claimed again';

  -- The app's save (next_due_at null once fired) takes a person out of the claim.
  update public.career_watch_kv set value = jsonb_build_object('items', '[]'::jsonb, 'next_due_at', null) where key = 'career:outreach:followups' and user_id = '00000000-0000-4000-8000-000000000001';
  select count(*) into n from public.career_outreach_followups_claim(timestamptz '2026-11-03 00:00:00+00', 5000, 300) where user_id = '00000000-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'FAIL a person with nothing waiting was claimed'; end if;
  raise notice 'ok   a person with nothing waiting is never claimed';

  if has_function_privilege('anon', 'public.career_outreach_followups_claim(timestamptz,int,int)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.career_outreach_followups_claim(timestamptz,int,int)', 'EXECUTE') then raise exception 'FAIL claim callable by a client'; end if;
  if not has_function_privilege('service_role', 'public.career_outreach_followups_claim(timestamptz,int,int)', 'EXECUTE') then raise exception 'FAIL service role cannot claim'; end if;
  raise notice 'ok   service role only';
  delete from public.career_watch_kv where user_id in (select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 1250) g);
  delete from auth.users where id in (select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 1250) g);
end $$;

-- The claim's due scan uses the partial index (not a scan of every career_watch_kv row).
set enable_seqscan = off;
do $$
declare plan text := ''; l text;
begin
  for l in execute $q$explain select user_id from public.career_watch_kv w where w.key = 'career:outreach:followups'
    and w.value ? 'next_due_at' and w.value->>'next_due_at' is not null and (w.value->>'next_due_at')::text <= '2026-11-02T00:00:00.000Z'
    order by (w.value->>'next_due_at')::text limit 50$q$ loop plan := plan || l || E'\n'; end loop;
  if plan not like '%career_watch_kv_followups_due%' then raise exception 'FAIL the due scan does not use career_watch_kv_followups_due: %', plan; end if;
  raise notice 'ok   the due scan runs on career_watch_kv_followups_due';
end $$;
reset enable_seqscan;
