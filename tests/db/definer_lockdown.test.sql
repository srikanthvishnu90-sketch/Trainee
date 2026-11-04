-- Launch readiness B1 (20261026230500_definer_execute_lockdown.sql): no SECURITY DEFINER function in public can be run with
-- the anon key, and every one has a fixed search_path. Run on the latest schema, after every migration, so a definer
-- function any later file adds without its revoke fails this run.
\set ON_ERROR_STOP on
begin;
reset role;

-- 1. Production's shape on 2026-10-26: the fourteen functions as they were live (hand-applied, Supabase's default grants
--    to anon, authenticated and service_role, EXECUTE to PUBLIC). Stand-ins with the live names; the bodies do not matter.
do $$
declare n text;
begin
  -- plaid_month_spend takes the person's id, as live (20260927_000006_plaid_spend_governor.sql:95); the others text.
  if to_regprocedure('public.plaid_month_spend(uuid)') is null then
    create function public.plaid_month_spend(p uuid) returns bigint language sql security definer set search_path = public, pg_temp as $f$ select 0::bigint $f$;
    grant execute on function public.plaid_month_spend(uuid) to public, anon, authenticated, service_role;
  end if;
  foreach n in array array['exec_vault_read','simplefin_secret_exists','simplefin_store_access_url',
    'generate_referral_code','is_eligible_referrer','qualify_referral','get_referral_stats','credit_pending_referral',
    'report_ai_anomaly'] loop
    if to_regprocedure('public.'||n||'(text)') is null then
      execute format('create function public.%I(p text) returns text language sql security definer set search_path = public, pg_temp as $f$ select p $f$', n);
      execute format('grant execute on function public.%I(text) to public, anon, authenticated, service_role', n);
    end if;
  end loop;
  if to_regprocedure('public.assign_referral_code()') is null then
    create function public.assign_referral_code() returns trigger language plpgsql security definer set search_path = public, pg_temp as $f$ begin return new; end $f$;
    grant execute on function public.assign_referral_code() to public, anon, authenticated, service_role;
  end if;
end $$;
-- A definer function on no list, open to anon and to signed-in people, as a later hand-applied one would be: the sweep's.
create function public.zz_unlisted_definer(p text) returns text language sql security definer set search_path = public, pg_temp as $f$ select p $f$;
grant execute on function public.zz_unlisted_definer(text) to public, anon, authenticated, service_role;
-- Every one of the fourteen, the repo's own definitions and the stand-ins alike, gets the grants production had
-- (tests/db/run.sh applies the repo's files, and the lockdown already ran over them): the hole, as it was live.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('exec_vault_read','plaid_month_spend','simplefin_secret_exists','simplefin_store_access_url',
      'generate_referral_code','is_eligible_referrer','qualify_referral','get_referral_stats','credit_pending_referral','report_ai_anomaly',
      'assign_referral_code','agent_settings_audit','agent_workflow_stop_guard','agent_financial_disconnect_guard') loop
    execute format('grant execute on function %s to public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;

select t.ok(has_function_privilege('anon','public.exec_vault_read(text)','EXECUTE')
  and has_function_privilege('anon','public.simplefin_store_access_url(text)','EXECUTE')
  and has_function_privilege('anon','public.agent_settings_audit()','EXECUTE'),
  'before the lockdown: anon can run exec_vault_read, simplefin_store_access_url and a trigger function (the hole, reproduced)');
select t.ok((select count(*) = 14 from (select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('exec_vault_read','plaid_month_spend','simplefin_secret_exists','simplefin_store_access_url',
      'generate_referral_code','is_eligible_referrer','qualify_referral','get_referral_stats','credit_pending_referral','report_ai_anomaly',
      'assign_referral_code','agent_settings_audit','agent_workflow_stop_guard','agent_financial_disconnect_guard')) x),
  'all fourteen exist here: the repo''s own files for twelve (six referral, plaid_month_spend, report_ai_anomaly, exec_vault_read, three triggers), stand-ins for the two SimpleFIN ones');

-- 2a. The named list ALONE (the migration's first block, read from the file, not a copy): the sweep that follows it would
--     close any function the list forgot, so this is the only place a name missing from the list, or a dropped revoke,
--     is seen. The unlisted function must still be open afterwards, which shows the sweep did not run.
\set named_block `awk '/^do \$lockdown_named\$/,/^\$lockdown_named\$;/' "$UPMORE_ROOT/supabase/migrations/20261026230500_definer_execute_lockdown.sql"`
select t.ok(:'named_block' like 'do $lockdown_named$%' and :'named_block' like '%$lockdown_named$;', 'the named-list block was read from the migration file');
select :'named_block' \gexec
select t.ok((select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('public'::name, p.oid, 'EXECUTE'))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('exec_vault_read','plaid_month_spend','simplefin_secret_exists','simplefin_store_access_url',
      'generate_referral_code','is_eligible_referrer','qualify_referral','get_referral_stats','credit_pending_referral','report_ai_anomaly',
      'assign_referral_code','agent_settings_audit','agent_workflow_stop_guard','agent_financial_disconnect_guard')),
  'the named list alone: anon (and PUBLIC) can run none of the fourteen, every overload');
select t.ok(not has_function_privilege('anon','public.exec_vault_read(text)','EXECUTE')
  and not has_function_privilege('authenticated','public.exec_vault_read(text)','EXECUTE')
  and has_function_privilege('service_role','public.exec_vault_read(text)','EXECUTE'),
  'the named list alone: exec_vault_read is service role only');
select t.ok(has_function_privilege('anon','public.zz_unlisted_definer(text)','EXECUTE'),
  'the named list alone leaves a definer function on no list open to anon (so the sweep was not what closed the fourteen)');

-- 2. The migration, twice (idempotent).
\ir ../../supabase/migrations/20261026230500_definer_execute_lockdown.sql
\ir ../../supabase/migrations/20261026230500_definer_execute_lockdown.sql

-- 3. Each function's access, as the architect set it live.
select t.ok(not has_function_privilege('anon','public.exec_vault_read(text)','EXECUTE')
  and not has_function_privilege('authenticated','public.exec_vault_read(text)','EXECUTE')
  and has_function_privilege('service_role','public.exec_vault_read(text)','EXECUTE')
  and not has_function_privilege('anon','public.plaid_month_spend(uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.plaid_month_spend(uuid)','EXECUTE')
  and has_function_privilege('service_role','public.plaid_month_spend(uuid)','EXECUTE'),
  'exec_vault_read and plaid_month_spend: service role only');
select t.ok((select bool_and(not has_function_privilege('anon',('public.'||n||'(text)')::regprocedure,'EXECUTE')
    and has_function_privilege('authenticated',('public.'||n||'(text)')::regprocedure,'EXECUTE')
    and has_function_privilege('service_role',('public.'||n||'(text)')::regprocedure,'EXECUTE'))
  from unnest(array['simplefin_secret_exists','simplefin_store_access_url','generate_referral_code','is_eligible_referrer',
    'qualify_referral','get_referral_stats','credit_pending_referral','report_ai_anomaly']) n),
  'the referral, SimpleFIN and anomaly functions: signed-in people and the service role, never anon');
select t.ok((select bool_and(not has_function_privilege(r, f, 'EXECUTE'))
  from unnest(array['public.assign_referral_code()','public.agent_settings_audit()','public.agent_workflow_stop_guard()',
    'public.agent_financial_disconnect_guard()']::regprocedure[]) f, unnest(array['anon','authenticated']) r),
  'the four trigger functions: nobody may call them');
select t.ok(not has_function_privilege('anon','public.zz_unlisted_definer(text)','EXECUTE')
  and has_function_privilege('authenticated','public.zz_unlisted_definer(text)','EXECUTE')
  and has_function_privilege('service_role','public.zz_unlisted_definer(text)','EXECUTE'),
  'the sweep: a definer function on no list loses anon (and PUBLIC) and keeps the access signed-in people and the service role had');
select t.ok(has_function_privilege('authenticated','public.career_apply_claim_own(integer)','EXECUTE')
  and not has_function_privilege('anon','public.career_apply_claim_own(integer)','EXECUTE'),
  'the sweep keeps a signed-in person''s own functions (career_apply_claim_own) and takes nothing else');
rollback;

-- 4. The guard, on the schema the whole suite built (outside the transaction above: no stand-ins). tests/db/run.sh has applied
--    every migration that declares a definer function and checked that each one exists here (by the scan's
--    --definer-keys), so this covers the repo's real functions, not only the ones this file builds.
do $$
declare open_to_anon text; no_path text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into open_to_anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');
  if open_to_anon is not null then raise exception 'FAIL SECURITY DEFINER functions executable by anon: %', open_to_anon; end if;
  raise notice 'ok   no SECURITY DEFINER function in public is executable by anon';
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into no_path
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if no_path is not null then raise exception 'FAIL SECURITY DEFINER functions without a fixed search_path: %', no_path; end if;
  raise notice 'ok   every SECURITY DEFINER function in public sets its search_path';
end $$;

-- 5. Go-live's own MIGRATION_MARK for this file, read from scripts/launch/trainee-go-live.sh (not a copy): it reads true
--    only when anon can run no definer function AND signed-in people cannot run exec_vault_read or plaid_month_spend.
\set lockdown_mark `grep -o "not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and ((p.prosecdef.*" "$UPMORE_ROOT/scripts/launch/trainee-go-live.sh" | sed 's/"$//'`
begin;
select t.ok((select :lockdown_mark), 'go-live''s mark reads true on the locked-down schema');
do $$ begin
  if to_regprocedure('public.exec_vault_read(text)') is null then
    create function public.exec_vault_read(p text) returns text language sql security definer set search_path = public, pg_temp as $f$ select p $f$;
  end if;
  if to_regprocedure('public.plaid_month_spend(uuid)') is null then
    create function public.plaid_month_spend(p uuid) returns bigint language sql security definer set search_path = public, pg_temp as $f$ select 0::bigint $f$;
  end if;
end $$;
revoke all on function public.exec_vault_read(text), public.plaid_month_spend(uuid) from public, anon, authenticated;
select t.ok((select :lockdown_mark), 'the mark reads true with both service-role only');
grant execute on function public.exec_vault_read(text) to authenticated;
select t.ok(not (select :lockdown_mark), 'the mark reads false while signed-in people can run exec_vault_read');
revoke execute on function public.exec_vault_read(text) from authenticated;
grant execute on function public.plaid_month_spend(uuid) to authenticated;
select t.ok(not (select :lockdown_mark), 'the mark reads false while signed-in people can run plaid_month_spend');
revoke execute on function public.plaid_month_spend(uuid) from authenticated;
grant execute on function public.exec_vault_read(text) to anon;
select t.ok(not (select :lockdown_mark), 'the mark reads false while anon can run a definer function');
rollback;
