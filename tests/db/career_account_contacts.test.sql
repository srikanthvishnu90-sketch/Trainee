-- 20261027160100_career_account_contacts.sql: the person's contacts on the account (ruling R1), at any size.
-- Proves on the real schema: put writes and replaces a file's rows; a put or forget is refused (null, nothing changed) once
-- the account's privacy epoch moved; forget deletes every row of the people picked and remembers them; a legacy chat copy
-- (unless_forgotten) never brings a forgotten person back, an explicit import does and lifts the tombstone; the summary;
-- 50,000 rows for one person read by firm and by name on their indexes; "forget everything" (the erase) and account
-- deletion remove both tables' rows; service role only.
do $$
declare u uuid := '00000000-0000-4000-8000-00000000c001'; v uuid := '00000000-0000-4000-8000-00000000c002'; n int; s record;
  row1 jsonb := '{"row_key":"Connections.csv#1","person_key":"e:maya@stripe.example","file":"Connections.csv","name_key":"maya chen","email":"maya@stripe.example","firm_key":"stripe","firm_raw_key":"stripe","data":{"file":"Connections.csv","row":1,"name":"Maya Chen"}}';
  row2 jsonb := '{"row_key":"Connections.csv#2","person_key":"n:lee park@stripe","file":"Connections.csv","name_key":"lee park","email":null,"firm_key":"stripe","firm_raw_key":"stripe","data":{"file":"Connections.csv","row":2,"name":"Lee Park"}}';
  row3 jsonb := '{"row_key":"more.csv#1","person_key":"e:maya@stripe.example","file":"more.csv","name_key":"maya chen","email":"maya@stripe.example","firm_key":"stripe","firm_raw_key":"stripe","data":{"file":"more.csv","row":1,"name":"Maya Chen"}}';
begin
  insert into auth.users (id, email) values (u, 'c1@example.test'), (v, 'c2@example.test') on conflict do nothing;
  insert into public.career_watch_kv (user_id, key, value) values (u, 'career:account', '{"epoch":0,"version":0,"paused":false}'), (v, 'career:account', '{"epoch":0,"version":0,"paused":false}') on conflict (user_id, key) do nothing;

  n := public.career_account_contacts_put(u, 0, jsonb_build_array(row1, row2, row3), 'Connections.csv', false);
  if n <> 3 then raise exception 'FAIL put wrote %', n; end if;
  select * into s from public.career_account_contacts_summary(u);
  if s.total <> 3 or s.file_count <> 2 or s.files <> array['Connections.csv', 'more.csv'] then raise exception 'FAIL summary % % %', s.total, s.file_count, s.files; end if;
  -- A file sent again replaces its own rows only.
  n := public.career_account_contacts_put(u, 0, jsonb_build_array(row1), 'Connections.csv', false);
  if (select count(*) from public.career_account_contacts where user_id = u) <> 2 then raise exception 'FAIL replace_file'; end if;
  raise notice 'ok   put writes the rows; a file sent again replaces its own rows only; the summary counts rows and files';

  -- The epoch moved (an erase ran during the turn): put and forget refuse and change nothing.
  if public.career_account_contacts_put(u, 7, jsonb_build_array(row2), null, false) is not null then raise exception 'FAIL put after the epoch moved'; end if;
  if public.career_account_contacts_forget(u, 7, true, false, null) is not null then raise exception 'FAIL forget after the epoch moved'; end if;
  if (select count(*) from public.career_account_contacts where user_id = u) <> 2 then raise exception 'FAIL a refused write changed rows'; end if;
  raise notice 'ok   a put or forget with a stale epoch is refused (null) and changes nothing';

  -- Forget by row: every row of that person goes (Maya on two lists), and she is remembered.
  n := public.career_account_contacts_forget(u, 0, false, false, array['Connections.csv#1']);
  if n <> 2 or exists (select 1 from public.career_account_contacts where user_id = u and person_key = 'e:maya@stripe.example') then raise exception 'FAIL forget by row: %', n; end if;
  if not exists (select 1 from public.career_account_contacts_forgotten where user_id = u and person_key = 'e:maya@stripe.example') then raise exception 'FAIL tombstone'; end if;
  -- A legacy chat copy never brings her back; an explicit import does, and lifts the tombstone.
  n := public.career_account_contacts_put(u, 0, jsonb_build_array(row1, row2), null, true);
  if n <> 1 or exists (select 1 from public.career_account_contacts where user_id = u and person_key = 'e:maya@stripe.example') then raise exception 'FAIL legacy copy restored a forgotten person'; end if;
  n := public.career_account_contacts_put(u, 0, jsonb_build_array(row1), null, false);
  if not exists (select 1 from public.career_account_contacts where user_id = u and person_key = 'e:maya@stripe.example')
     or exists (select 1 from public.career_account_contacts_forgotten where user_id = u) then raise exception 'FAIL explicit import'; end if;
  raise notice 'ok   forget removes every row of the person and remembers them; a chat copy never restores them; an import on purpose does';

  -- forget all / LinkedIn only; another account untouched.
  perform public.career_account_contacts_put(v, 0, jsonb_build_array(row1), null, false);
  n := public.career_account_contacts_forget(u, 0, false, true, null);
  if n <> 2 then raise exception 'FAIL forget linkedin %', n; end if;
  if (select count(*) from public.career_account_contacts where user_id = v) <> 1 then raise exception 'FAIL another account touched'; end if;
  raise notice 'ok   "forget my LinkedIn contacts" removes the export''s rows; another account is untouched';

  -- 50,000 rows for one person: the firm and name reads run on their indexes (no scan of the person's list).
  insert into public.career_account_contacts (user_id, row_key, person_key, file, name_key, email, firm_key, firm_raw_key, data)
  select u, 'big.csv#' || g, 'e:p' || g || '@f' || (g % 500) || '.example', 'big.csv', 'person ' || g, 'p' || g || '@f' || (g % 500) || '.example', 'firm ' || (g % 500), 'firm ' || (g % 500), jsonb_build_object('row', g)
  from generate_series(1, 50000) g;
  analyze public.career_account_contacts;
  select * into s from public.career_account_contacts_summary(u);
  if s.total <> 50000 then raise exception 'FAIL summary at scale %', s.total; end if;
  raise notice 'ok   50,000 contacts on one account, no cap';
end $$;

do $$
declare plan text := ''; l text;
begin
  for l in execute $q$explain select row_key, data from public.career_account_contacts where user_id = '00000000-0000-4000-8000-00000000c001' and firm_key = 'firm 7' and row_key > '' order by row_key limit 1000$q$ loop plan := plan || l || E'\n'; end loop;
  if plan not like '%career_account_contacts_firm%' then raise exception 'FAIL the firm read does not use its index: %', plan; end if;
  plan := '';
  for l in execute $q$explain select row_key, data from public.career_account_contacts where user_id = '00000000-0000-4000-8000-00000000c001' and name_key like 'person 12 %' and row_key > '' order by row_key limit 1000$q$ loop plan := plan || l || E'\n'; end loop;
  if plan not like '%career_account_contacts_name%' then raise exception 'FAIL the name read does not use its index: %', plan; end if;
  raise notice 'ok   the firm and name reads run on career_account_contacts_firm and _name';
end $$;

do $$
declare u uuid := '00000000-0000-4000-8000-00000000c001'; v uuid := '00000000-0000-4000-8000-00000000c002';
begin
  perform public.career_account_contacts_forget(v, 0, false, false, array['Connections.csv#1']);
  -- "forget everything": the erase on the account write (career_erase_person) clears both tables.
  update public.career_watch_kv set value = value || '{"epoch":1,"paused":true}'::jsonb where user_id = u and key = 'career:account';
  update public.career_watch_kv set value = value || '{"epoch":1,"paused":true}'::jsonb where user_id = v and key = 'career:account';
  if exists (select 1 from public.career_account_contacts where user_id in (u, v)) or exists (select 1 from public.career_account_contacts_forgotten where user_id in (u, v)) then
    raise exception 'FAIL the erase left contacts'; end if;
  raise notice 'ok   "forget everything" removes the contacts and the forgotten list';
  perform public.career_account_contacts_put(u, 1, '[{"row_key":"a#1","person_key":"e:a@x.example","file":"a","name_key":"a","email":"a@x.example","firm_key":"","firm_raw_key":"","data":{}}]'::jsonb, null, false);
  delete from auth.users where id in (u, v);
  if exists (select 1 from public.career_account_contacts where user_id = u) then raise exception 'FAIL account deletion left contacts'; end if;
  raise notice 'ok   account deletion removes them (on delete cascade)';
  if has_table_privilege('authenticated', 'public.career_account_contacts', 'SELECT') or has_table_privilege('anon', 'public.career_account_contacts', 'SELECT')
     or has_function_privilege('authenticated', 'public.career_account_contacts_put(uuid,bigint,jsonb,text,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.career_account_contacts_forget(uuid,bigint,boolean,boolean,text[])', 'EXECUTE') then raise exception 'FAIL client access'; end if;
  raise notice 'ok   service role only';
end $$;
