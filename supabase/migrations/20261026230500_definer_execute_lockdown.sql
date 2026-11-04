-- Launch readiness B1 / SEC1 / SEC2 (2026-10-26): no SECURITY DEFINER function in public is executable by anon.
--
-- What happened. Supabase grants EXECUTE on every new function in public to anon, authenticated and service_role through
-- its default privileges, and Postgres grants it to PUBLIC as well. A SECURITY DEFINER function runs with its owner's
-- rights, so the anon key (which ships in the web page) could call any of them over /rest/v1/rpc. Fourteen were open on
-- production: exec_vault_read was applied to production by hand without the revoke its repo file has
-- (20260928_000010_exec_vault_read.sql:21), so anyone could decrypt the exec_cred_* Vault secrets; the referral, SimpleFIN,
-- Plaid and anomaly functions were created with "revoke ... from public" or nothing, which leaves anon's explicit grant.
-- The architect revoked them live on 2026-10-26 ~18:30 UTC through the Supabase MCP; this file is that change, codified,
-- so a fresh project, a rehearsal and every later apply end in the same state.
--
-- 1. The fourteen functions, by name, whatever their signature (they are not all created by files in this repo):
--    service-role only:              exec_vault_read, plaid_month_spend
--    signed-in people and service:   simplefin_secret_exists, simplefin_store_access_url, generate_referral_code,
--                                    is_eligible_referrer, qualify_referral, get_referral_stats, credit_pending_referral,
--                                    report_ai_anomaly
--    trigger functions (no caller):  assign_referral_code, agent_settings_audit, agent_workflow_stop_guard,
--                                    agent_financial_disconnect_guard
-- 2. A sweep: any other SECURITY DEFINER function in public that anon can still execute loses EXECUTE from PUBLIC and anon;
--    authenticated and service_role keep exactly the access they had (granted by name before PUBLIC is taken away).
--
-- Idempotent: every statement is a revoke or grant on what exists; a function that is absent is skipped.
-- The guard: tests/db/definer_lockdown.test.sql (no definer function anon-executable, every one with a fixed search_path),
-- and tests/career-definer-revoke.test.cjs (every migration that creates one revokes it from public and anon in the file).
-- Two blocks, so tests/db/definer_lockdown.test.sql can run each alone: the named list must close the fourteen without the
-- sweep's help (the sweep would otherwise hide a name missing from the list).
do $lockdown_named$
declare
  f record;
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in (
      'exec_vault_read', 'plaid_month_spend',
      'simplefin_secret_exists', 'simplefin_store_access_url', 'generate_referral_code', 'is_eligible_referrer',
      'qualify_referral', 'get_referral_stats', 'credit_pending_referral', 'report_ai_anomaly',
      'assign_referral_code', 'agent_settings_audit', 'agent_workflow_stop_guard', 'agent_financial_disconnect_guard')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname in ('exec_vault_read', 'plaid_month_spend') then
      execute format('revoke all on function %s from authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    elsif f.proname in ('assign_referral_code', 'agent_settings_audit', 'agent_workflow_stop_guard', 'agent_financial_disconnect_guard') then
      -- Trigger functions run as triggers, never called; nobody needs EXECUTE on them.
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end
$lockdown_named$;

do $lockdown_sweep$
declare
  f record;
  had_auth boolean;
  had_service boolean;
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    had_auth := has_function_privilege('authenticated', f.oid, 'EXECUTE');
    had_service := has_function_privilege('service_role', f.oid, 'EXECUTE');
    if had_auth then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if had_service then execute format('grant execute on function %s to service_role', f.sig); end if;
    execute format('revoke all on function %s from public, anon', f.sig);
  end loop;
end
$lockdown_sweep$;
