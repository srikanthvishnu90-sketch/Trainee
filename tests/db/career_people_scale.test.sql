-- PEOPLE FINDING at scale (20261027170000_career_people_scale.sql): imports in parts with indexed dedupe, the lookups a
-- turn makes on indexes (never a scan of a person's whole list), the scheduled push paged with no cap, and
-- "forget my LinkedIn contacts" across every chat of the person in one statement.
begin;
reset role;
-- The whole plan of a query, every line (EXPLAIN returns one row per line).
create or replace function pg_temp.plan_of(q text) returns text language plpgsql as $$
declare l text; out text := '';
begin
  for l in execute 'explain ' || q loop out := out || l || ' / '; end loop;
  return out;
end $$;
insert into auth.users(id, email) values ('00000000-0000-0000-0000-00000000a170', 'scale-a@example.com'), ('00000000-0000-0000-0000-00000000b170', 'scale-b@example.com');

-- 1. A 30,000-row export in 15 parts of 2,000: one import record, the database's totals, dedupe by the unique index.
do $$
declare r jsonb; imp bigint := null; part int; t0 timestamptz := clock_timestamp(); ms numeric;
begin
  for part in 0..14 loop
    r := public.career_people_import_part('00000000-0000-0000-0000-00000000a170', 'linkedin_export', 'Connections.csv', null,
      (select jsonb_agg(jsonb_build_object('name', 'Person ' || g, 'email', case when g % 7 = 0 then 'p' || g || '@mail.example.com' end,
         'company', 'Firm ' || (g % 500), 'company_key', 'firm ' || (g % 500), 'source_ref', 'Connections.csv, row ' || g,
         'dedupe_key', case when g % 7 = 0 then 'e:p' || g || '@mail.example.com' else 'n:person ' || g || '|firm ' || (g % 500) end))
       from generate_series(part * 2000 + 1, part * 2000 + 2000) g),
      30000, 0, true, imp);
    imp := (r->>'import')::bigint;
  end loop;
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  perform t.ok((r->>'kept')::int = 30000, 'a 30,000-row export in 15 parts: 30,000 kept');
  perform t.ok((select count(*) = 1 from public.career_people_imports where user_id = '00000000-0000-0000-0000-00000000a170'), 'one import record for the whole file');
  perform t.ok((select imported = 30000 and duplicates = 0 and with_email = 4285 and rows_read = 30000 from public.career_people_imports where id = imp), 'its counts are the totals of every part');
  raise notice 'ok   measured: 30,000 rows imported in 15 parts in % ms', round(ms);
  -- the same part again (a retry): nothing doubled, counted as duplicates
  r := public.career_people_import_part('00000000-0000-0000-0000-00000000a170', 'linkedin_export', 'Connections.csv', null,
    (select jsonb_agg(jsonb_build_object('name', 'Person ' || g, 'company', 'Firm ' || (g % 500), 'company_key', 'firm ' || (g % 500), 'source_ref', 'r', 'dedupe_key', 'n:person ' || g || '|firm ' || (g % 500)))
     from generate_series(1, 6) g where g % 7 <> 0), 6, 0, true, imp);
  perform t.ok((r->>'inserted')::int = 0 and (r->>'kept')::int = 30000, 'a retried part adds nothing (unique index)');
  -- a part naming another person's import is refused
  perform t.must_fail(format($q$select public.career_people_import_part('00000000-0000-0000-0000-00000000b170', 'linkedin_export', 'x.csv', null, '[]'::jsonb, 0, 0, false, %s)$q$, imp),
    'invalid people import part', 'a part can only add to its own person''s import');
end $$;

-- 2. The reads a turn makes are on indexes, and bounded.
analyze public.career_people;
set local enable_seqscan = off;
do $$
declare plan text;
begin
  plan := pg_temp.plan_of('select * from public.career_people where user_id = ''00000000-0000-0000-0000-00000000a170'' and company_key = ''firm 7'' order by id limit 1000');
  perform t.ok(plan ~ 'Index', 'who do I know at X: an index read (' || plan || ')');
  perform t.ok((select count(*) from public.career_people_named('00000000-0000-0000-0000-00000000a170', 'person 12345', 50)) = 1, 'a contact by full name');
  perform t.ok((select count(*) from public.career_people_named('00000000-0000-0000-0000-00000000a170', 'Person', 50)) = 50, 'a first name alone: one bounded page');
  perform t.ok((select count(*) from public.career_people_named('00000000-0000-0000-0000-00000000a170', 'Pers%', 50)) = 0, 'a wildcard in a name matches nothing (escaped)');
  plan := pg_temp.plan_of('select * from public.career_people where user_id = ''00000000-0000-0000-0000-00000000a170'' and lower(name) = ''person 12345''');
  perform t.ok(plan ~ 'career_people_name', 'by name: the name index (' || plan || ')');
  perform t.ok((select (public.career_people_tallies('00000000-0000-0000-0000-00000000a170', 'firm 7')->>'at_company')::int = 60), 'a company''s count is the database''s');
end $$;
reset enable_seqscan;

-- 3. The scheduled push pages every due reminder (no cap), oldest due first, only approved or sent.
insert into public.career_intro_requests (user_id, n, route, target_name, target_ref, to_name, delivery, subject, body, payload_hash, status, approved_hash, follow_up_at)
select '00000000-0000-0000-0000-00000000a170', g, 'direct', 'T', 'r', 'P', 'copy', 's', 'b', repeat('a', 64),
       case when g % 10 = 0 then 'replied' when g % 10 = 1 then 'cancelled' when g % 2 = 0 then 'sent' else 'approved' end,
       case when g % 10 not in (0, 1) and g % 2 = 1 then repeat('a', 64) end,
       now() - make_interval(secs => g)
from generate_series(1, 2500) g;
do $$
declare page int := 0; got int := 0; n int; last_at timestamptz := null; last_id bigint := null;
begin
  create temp table pg_page (follow_up_at timestamptz, id bigint, status text) on commit drop;
  loop
    truncate pg_page;
    insert into pg_page select follow_up_at, id, status from public.career_intro_due(now(), last_at, last_id, 1000);
    get diagnostics n = row_count;
    exit when n = 0;
    perform t.ok(not exists (select 1 from pg_page where status not in ('approved', 'sent')), format('page %s: approved or sent only', page + 1));
    got := got + n; page := page + 1;
    select follow_up_at, id into last_at, last_id from pg_page order by follow_up_at desc, id desc limit 1;
  end loop;
  perform t.ok(got = 2000, format('every due approved/sent reminder is read, in %s pages of up to 1,000 (%s); replied and cancelled never', page, got));
end $$;

-- 4. Forget across every chat in one statement: the export's copy goes from each other chat, a typed list stays,
--    the revision moves, the person's own chat and another person's are untouched.
insert into public.agent_threads (id, user_id) values ('00000000-0000-0000-0000-0000000a1701', '00000000-0000-0000-0000-00000000a170'),
  ('00000000-0000-0000-0000-0000000a1702', '00000000-0000-0000-0000-00000000a170'), ('00000000-0000-0000-0000-0000000a1703', '00000000-0000-0000-0000-00000000a170'),
  ('00000000-0000-0000-0000-0000000b1701', '00000000-0000-0000-0000-00000000b170');
insert into public.agent_flow_state (thread_id, user_id, state) values
 ('00000000-0000-0000-0000-0000000a1701', '00000000-0000-0000-0000-00000000a170', '{"career":{"revision":4,"stores":{"contacts":[{"file":"Connections.csv","row":1,"name":"A"},{"file":"x","row":2,"name":"B","linkedin_export":true},{"file":"friends.csv","row":1,"name":"Mo"}]}}}'),
 ('00000000-0000-0000-0000-0000000a1702', '00000000-0000-0000-0000-00000000a170', '{"career":{"revision":1,"stores":{"contacts":[{"file":"Connections.csv","row":1,"name":"A"}]}}}'),
 ('00000000-0000-0000-0000-0000000a1703', '00000000-0000-0000-0000-00000000a170', '{"career":{"revision":9,"stores":{"contacts":[{"file":"Connections.csv","row":1,"name":"A"}]}}}'),
 ('00000000-0000-0000-0000-0000000b1701', '00000000-0000-0000-0000-00000000b170', '{"career":{"revision":1,"stores":{"contacts":[{"file":"Connections.csv","row":1,"name":"Z"}]}}}');
do $$ declare r jsonb := public.career_people_prune_thread_contacts('00000000-0000-0000-0000-00000000a170', '00000000-0000-0000-0000-0000000a1703', false); begin perform t.ok(r = '{"rows": 3, "threads": 2}'::jsonb, 'three export rows from two other chats: ' || r::text); end $$;
select t.ok((select state #> '{career,stores,contacts}' = '[{"file":"friends.csv","row":1,"name":"Mo"}]'::jsonb and (state #>> '{career,revision}')::int = 5 from public.agent_flow_state where thread_id = '00000000-0000-0000-0000-0000000a1701'), 'a typed list stays; the revision moved');
select t.ok((select jsonb_array_length(state #> '{career,stores,contacts}') = 1 and (state #>> '{career,revision}')::int = 9 from public.agent_flow_state where thread_id = '00000000-0000-0000-0000-0000000a1703'), 'the chat the person is in is left to its own turn');
select t.ok((select jsonb_array_length(state #> '{career,stores,contacts}') = 1 from public.agent_flow_state where thread_id = '00000000-0000-0000-0000-0000000b1701'), 'another person''s chat is untouched');
select t.ok(public.career_people_prune_thread_contacts('00000000-0000-0000-0000-00000000a170', null, true) = '{"rows": 2, "threads": 2}'::jsonb, 'forget everything: every row of every chat');
select t.ok((select bool_and(jsonb_array_length(state #> '{career,stores,contacts}') = 0) from public.agent_flow_state where user_id = '00000000-0000-0000-0000-00000000a170'), 'nothing left in any chat');
do $$ declare plan text; begin
  set local enable_seqscan = off;
  plan := pg_temp.plan_of('select 1 from public.agent_flow_state where user_id = ''00000000-0000-0000-0000-00000000a170''');
  perform t.ok(plan ~ 'agent_flow_state_user', 'a person''s chats: the user index (' || plan || ')');
end $$;
rollback;
