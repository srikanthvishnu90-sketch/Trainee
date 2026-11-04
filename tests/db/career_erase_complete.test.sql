-- Launch readiness S2 (20261026230100_career_erase_complete.sql): "forget everything" and account deletion leave nothing
-- of the person in any career or channel table. Every such table (found from the catalog, not a list) gets a row for the
-- person, then the erase runs through the real commit; every table the erase owns is empty for them, the kept ones hold
-- nothing identifying, and another person's rows are untouched. Then account deletion removes every row with a user_id.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-00000000e201','erase-a@example.test'),('00000000-0000-4000-8000-00000000e202','erase-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-00000000e201'),('00000000-0000-4000-8000-00000000e202');
insert into agent_threads(id,user_id) values('00000000-0000-4000-8000-00000000e2a1','00000000-0000-4000-8000-00000000e201'),('00000000-0000-4000-8000-00000000e2b1','00000000-0000-4000-8000-00000000e202');

-- One row for each person in every table with a user_id column outside auth: the columns the table requires get a value of
-- their type (the person's id for user_id, their thread for thread_id). Triggers and foreign keys are off while seeding
-- (session_replication_role = replica), and CHECK constraints are dropped inside this transaction, which is rolled back:
-- the erase is under test here, not the shape of each row. NOT NULL still holds. The tables the audit named are also
-- filled by hand below, with rows shaped as the product writes them.
create temp table seeded(tbl text, who uuid, ok boolean, why text);
do $$
declare k record;
begin
  for k in select conrelid::regclass::text rel, conname from pg_constraint
    where contype = 'c' and conrelid in (select format('%I.%I', table_schema, table_name)::regclass from information_schema.columns
      where column_name = 'user_id' and table_schema in ('public','career_message_approval_private')) loop
    execute format('alter table %s drop constraint %I', k.rel, k.conname);
  end loop;
end $$;
set session_replication_role = replica;
do $$
declare r record; c record; cols text; vals text; v text; u text; th text;
begin
  foreach u in array array['00000000-0000-4000-8000-00000000e201','00000000-0000-4000-8000-00000000e202'] loop
    th := case when u like '%e201' then '00000000-0000-4000-8000-00000000e2a1' else '00000000-0000-4000-8000-00000000e2b1' end;
    for r in select distinct c2.table_schema s, c2.table_name n from information_schema.columns c2
      join information_schema.tables t2 on t2.table_schema=c2.table_schema and t2.table_name=c2.table_name
      where c2.column_name='user_id' and t2.table_type='BASE TABLE' and c2.table_schema not in ('auth','storage','t','pg_temp')
        and c2.table_schema not like 'pg_temp%' loop
      cols := ''; vals := '';
      for c in select column_name cn, data_type dt, udt_name un from information_schema.columns
        where table_schema=r.s and table_name=r.n
          -- Identity and generated columns fill themselves (a GENERATED ALWAYS column refuses a value), so never write them.
          and is_identity = 'NO' and is_generated = 'NEVER'
          and (column_name in ('user_id','thread_id') or (is_nullable='NO' and column_default is null)) loop
        v := case
          when c.cn = 'user_id' then quote_literal(u)
          when c.cn = 'thread_id' and c.dt = 'uuid' then quote_literal(th)
          when c.dt = 'uuid' then 'gen_random_uuid()'
          when c.dt in ('text','character varying') then quote_literal('TEST-'||md5(random()::text))
          when c.dt in ('jsonb','json') then quote_literal('{}')
          when c.dt in ('integer','bigint','smallint','numeric','double precision','real') then case when u like '%e201' then '1' else '2' end
          when c.dt like 'timestamp%' then 'now()'
          when c.dt = 'date' then 'current_date'
          when c.dt = 'boolean' then 'false'
          when c.dt = 'bytea' then quote_literal('\x00')
          when c.dt = 'ARRAY' then quote_literal('{}')
          else 'null' end;
        cols := cols || case when cols = '' then '' else ',' end || quote_ident(c.cn);
        vals := vals || case when vals = '' then '' else ',' end || v;
      end loop;
      begin
        execute format('insert into %I.%I (%s) values (%s)', r.s, r.n, cols, vals);
        insert into seeded values (format('%I.%I', r.s, r.n), u::uuid, true, null);
      exception when others then
        insert into seeded values (format('%I.%I', r.s, r.n), u::uuid, false, sqlerrm);
      end;
    end loop;
  end loop;
end $$;
set session_replication_role = origin;
-- The tombstone starts empty: only an erase writes it.
delete from career_apply_erased;

-- By hand: the tables whose checks a generic value cannot meet, for both people. Each is what the erase must reach.
do $$
declare u uuid; job uuid;
begin
  foreach u in array array['00000000-0000-4000-8000-00000000e201','00000000-0000-4000-8000-00000000e202']::uuid[] loop
    set local session_replication_role = replica;
    insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,claimed_at)
    values (u,'TEST-ERASE-'||right(u::text,4),'Erase Employer','https://jobs.lever.co/test/erase','{"fields":[{"name":"email","value":"erase@example.test"}]}',repeat('a',64),repeat('a',64),'confirmed',now() - interval '2 days')
    returning id into job;
    insert into career_apply_receipts(application_id,user_id,company,url,state,reached_employer,payload_hash,approval_hash,approved_at,finished_at,pictures_keep_until)
      values (job,u,'Erase Employer','https://jobs.lever.co/test/erase','confirmed','yes',repeat('a',64),repeat('a',64),now(),now(),now()+interval '90 days')
      on conflict do nothing;
    insert into career_apply_receipt_files(application_id,user_id,kind,sha256,mime,bytes_b64)
      values (job,u,'before-click',repeat('b',64),'image/png','iVBORw0KGgo=') on conflict do nothing;
    insert into extension_submission_reports(user_id,employer,role,posting_url,confirmation_text,tracker_record,answers_submitted)
      values (u,'Erase Employer','Analyst','https://jobs.lever.co/test/erase','Thanks for applying','{}','{"email":"erase@example.test"}');
    insert into channel_artifacts(user_id,thread_id,filename,mime,bytes_b64,expires_at)
      values (u,(select id from agent_threads where user_id = u limit 1),'proof.png','image/png','iVBORw0KGgo=',now()+interval '1 day');
    set local session_replication_role = origin;
  end loop;
end $$;
insert into seeded select t, w, true, 'by hand' from unnest(array['00000000-0000-4000-8000-00000000e201','00000000-0000-4000-8000-00000000e202']::uuid[]) w, unnest(array['public.career_apply_jobs','public.career_apply_receipts',
  'public.career_apply_receipt_files','public.extension_submission_reports','public.channel_artifacts']) t;

create temp table person_rows(tbl text, who text, n bigint);
create or replace function pg_temp.count_rows(who uuid) returns table(tbl text, n bigint) language plpgsql as $$
declare r record; k bigint;
begin
  for r in select distinct format('%I.%I', c.table_schema, c.table_name) t from information_schema.columns c
    join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name
    where c.column_name='user_id' and x.table_type='BASE TABLE' and c.table_schema not in ('auth','storage','t') and c.table_schema not like 'pg_temp%' loop
    execute format('select count(*) from %s where user_id = $1', r.t) into k using who;
    tbl := r.t; n := k; return next;
  end loop;
end $$;

select t.ok((select bool_and(exists(select 1 from seeded s where s.tbl = e and s.ok and s.who = w)) from unnest(career_erase_tables()) e,
    unnest(array['00000000-0000-4000-8000-00000000e201','00000000-0000-4000-8000-00000000e202']::uuid[]) w),
  'every table the erase owns holds a row for each person before it runs: '||coalesce((select string_agg(distinct s.tbl||' ('||s.why||')', '; ')
    from unnest(career_erase_tables()) e join seeded s on s.tbl = e where not s.ok), 'all seeded, for both people'));
-- Read from pg_catalog, apart from the function's own query: every career, channel or extension table with a user_id
-- column is erased or named as kept, so a table added later cannot be missed silently.
select t.ok(not exists (select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where a.attname = 'user_id' and not a.attisdropped and c.relkind in ('r','p') and n.nspname = 'public'
      and c.relname ~ '^(career_|channel_|extension_)'
      and not (format('%I.%I', n.nspname, c.relname) = any(career_erase_tables()))
      and not (c.relname = any(career_erase_kept_tables()))),
  'every career, channel and extension table with a user_id is erased ('||(select count(*) from unnest(career_erase_tables()))||
  ') or kept with a reason ('||cardinality(career_erase_kept_tables())||')');
select t.ok(array['public.career_apply_jobs','public.career_apply_prepared','public.career_apply_questions','public.career_apply_wanted',
  'public.career_apply_cards','public.career_apply_receipts','public.career_apply_receipt_files','public.extension_submission_reports',
  'public.channel_artifacts','public.career_outbox','public.career_alert_prefs','public.career_events']::text[] <@ career_erase_tables(),
  'the applications, their receipts and screenshots, extension reports and channel files are the erase''s');
select t.ok(not ('public.career_watch_kv' = any(career_erase_tables())) and not ('public.channel_contacts' = any(career_erase_tables())),
  'the account row and the address being texted from are kept (named in career_erase_kept_tables)');

-- 2. "forget everything" through the real commit, as the host's erase turn writes it (as the other host-commit tests call it).
reset role;
insert into career_watch_kv(user_id,key,value) values
  ('00000000-0000-4000-8000-00000000e201','career:account','{"epoch":0,"version":0,"paused":false}'),
  ('00000000-0000-4000-8000-00000000e202','career:account','{"epoch":0,"version":0,"paused":false}')
  on conflict (user_id,key) do update set value = excluded.value;
select career_host_commit('00000000-0000-4000-8000-00000000e201','00000000-0000-4000-8000-00000000e2a1','erase-turn-1',repeat('e',64),0,0,
  jsonb_build_object('v',1,'scope',jsonb_build_object('userId','00000000-0000-4000-8000-00000000e201'),'stores','{}'::jsonb),
  '{"erase":true}','forget everything',jsonb_build_object('thread_id','00000000-0000-4000-8000-00000000e2a1','reply','Forgotten.'));
reset role;
select t.ok(coalesce((select string_agg(tbl, ', ') from pg_temp.count_rows('00000000-0000-4000-8000-00000000e201') where n > 0 and tbl = any(career_erase_tables())), '') = '',
  'after "forget everything" every career and channel table the erase owns is empty for the person: '||
  coalesce((select string_agg(tbl||'='||n, ', ') from pg_temp.count_rows('00000000-0000-4000-8000-00000000e201') where n > 0 and tbl = any(career_erase_tables())), 'none left'));
select t.ok((select count(*) = 0 from career_apply_jobs where user_id = '00000000-0000-4000-8000-00000000e201')
  and (select count(*) = 0 from career_apply_receipt_files where user_id = '00000000-0000-4000-8000-00000000e201')
  and (select count(*) = 0 from extension_submission_reports where user_id = '00000000-0000-4000-8000-00000000e201'),
  'career_apply_jobs, the stored screenshots and extension_submission_reports are gone');
select t.ok((select count(*) = 0 from career_task_intents_v1 where user_id = '00000000-0000-4000-8000-00000000e201' and (private_input is not null or result is not null))
  and (select count(*) = 0 from career_batch_intents_v1 where user_id = '00000000-0000-4000-8000-00000000e201' and (private_input is not null or result is not null))
  and (select count(*) = 0 from career_reminder_outbox where user_id = '00000000-0000-4000-8000-00000000e201' and (payload is not null or record is not null)),
  'the kept effect ledger and reminder rows hold no input, result or text');
-- The apply rules outlive the record: the same posting is refused ever, the same employer (any spelling the key folds)
-- for 30 days, a different employer is not; the tombstone holds hashes and a time, nothing readable.
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
  values ('00000000-0000-4000-8000-00000000e201','TEST-ERASE-e201','Someone Else','https://jobs.lever.co/test/x','{}',repeat('c',64),repeat('c',64))$$,
  'duplicate_job','after the erase, the same posting is still never applied to twice');
select t.must_fail($$insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
  values ('00000000-0000-4000-8000-00000000e201','TEST-ERASE-NEW','Erase Employer, Inc.','https://jobs.lever.co/test/y','{}',repeat('c',64),repeat('c',64))$$,
  'company_cooldown','after the erase, the same employer is still refused within 30 days');
savepoint other_employer;
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
  values ('00000000-0000-4000-8000-00000000e201','TEST-ERASE-OTHER','Unrelated Employer','https://jobs.lever.co/test/z','{}',repeat('c',64),repeat('c',64));
select t.ok((select count(*) = 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-00000000e201' and job_id = 'TEST-ERASE-OTHER'),
  'a different employer and posting is taken as before');
rollback to savepoint other_employer;
select t.ok((select count(*) >= 1 and bool_and(posting_hash ~ '^[a-f0-9]{64}$' and (company_hash is null or company_hash ~ '^[a-f0-9]{64}$'))
    from career_apply_erased where user_id = '00000000-0000-4000-8000-00000000e201')
  and not exists (select 1 from career_apply_erased e where e.user_id = '00000000-0000-4000-8000-00000000e201'
    and (e::text ilike '%erase employer%' or e::text ilike '%lever.co%' or e::text ilike '%TEST-ERASE%')),
  'the tombstone keeps only hashes and a time: no employer name, link or posting key');
-- A second erase changes nothing and expires employer hashes past 30 days.
update career_apply_erased set at = now() - interval '31 days' where user_id = '00000000-0000-4000-8000-00000000e201';
select t.ok(career_apply_erased_expire() >= 1, 'the expiry clears employer hashes past their 30 days');
select t.ok(not exists (select 1 from career_apply_erased where at < now() - interval '30 days' and company_hash is not null)
  and exists (select 1 from career_apply_erased where user_id = '00000000-0000-4000-8000-00000000e201' and posting_hash ~ '^[a-f0-9]{64}$'),
  'past its 30 days no employer hash is left; the posting hash stays (once per posting, ever)');
select t.ok(coalesce((select string_agg(tbl, ', ') from pg_temp.count_rows('00000000-0000-4000-8000-00000000e202') b
    where b.n = 0 and b.tbl = any(career_erase_tables()) and exists (select 1 from seeded s where s.tbl = b.tbl and s.ok)), '') = '',
  'the other person''s rows are untouched: '||coalesce((select string_agg(tbl, ', ') from pg_temp.count_rows('00000000-0000-4000-8000-00000000e202') b
    where b.n = 0 and b.tbl = any(career_erase_tables()) and exists (select 1 from seeded s where s.tbl = b.tbl and s.ok)), 'all there'));
-- An epoch raised without the pause (the approval-staleness signal) is not an erase: the queue keeps its rows.
update career_watch_kv set value = '{"epoch":9,"version":9,"paused":false}' where user_id = '00000000-0000-4000-8000-00000000e202' and key = 'career:account';
select t.ok((select count(*) >= 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-00000000e202'),
  'an epoch raised with no pause leaves the applications (career_apply_jobs.test.sql''s contract)');


-- 3. Account deletion, in delete-account's order: the append-only action ledger is purged, then the auth user is deleted.
-- Every table with a user_id column is then empty for the deleted person.
-- (purge_user_action_ledger is not in tests/db/run.sh's list; its file is applied here, inside this rolled-back transaction.)
\ir ../../supabase/migrations/20260928_000009_purge_user_action_ledger.sql
select purge_user_action_ledger('00000000-0000-4000-8000-00000000e202');
delete from auth.users where id = '00000000-0000-4000-8000-00000000e202';
-- A row can be left only in a table whose user_id sits in a composite foreign key with ON DELETE CASCADE to a parent
-- row the seed never made (the seed turned foreign-key checks off): with checks on, as in production, such a row cannot
-- exist, so the cascade removes it with its parent. Anything else left is a failure, named.
create or replace function pg_temp.left_over(who uuid) returns table(tbl text, n bigint, orphaned bigint) language plpgsql as $$
declare r record; k record; cond text; o bigint;
begin
  for r in select c.tbl, c.n from pg_temp.count_rows(who) c where c.n > 0 loop
    o := 0;
    for k in select f.confrelid::regclass::text parent,
        (select string_agg(format('p.%I = x.%I', pa.attname, ca.attname), ' and ')
           from unnest(f.conkey, f.confkey) u(ck, pk)
           join pg_attribute ca on ca.attrelid = f.conrelid and ca.attnum = u.ck
           join pg_attribute pa on pa.attrelid = f.confrelid and pa.attnum = u.pk) cond
      from pg_constraint f
      where f.contype = 'f' and f.confdeltype = 'c' and f.conrelid = r.tbl::regclass
        and (select attnum from pg_attribute where attrelid = f.conrelid and attname = 'user_id') = any(f.conkey) loop
      execute format('select count(*) from %s x where x.user_id = $1 and not exists (select 1 from %s p where %s)', r.tbl, k.parent, k.cond)
        into o using who;
      exit when o = r.n;
    end loop;
    tbl := r.tbl; n := r.n; orphaned := o; return next;
  end loop;
end $$;
select t.ok(not exists (select 1 from pg_temp.left_over('00000000-0000-4000-8000-00000000e202') where orphaned < n),
  'account deletion leaves no row with the person''s user_id in any table, but rows a cascading key would have removed with a parent the seed never made: '||
  coalesce((select string_agg(tbl||' '||n||' left, '||orphaned||' without their parent', '; ') from pg_temp.left_over('00000000-0000-4000-8000-00000000e202')), 'none left'));
rollback;
