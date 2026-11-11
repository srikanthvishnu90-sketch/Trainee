-- Rollback of 20261110120000_career_apply_vm_boards.sql: the VM drives Greenhouse and Lever only again (the 20261028180000 bodies).
create or replace function public.career_apply_vm_family(p_url text) returns text
language sql immutable set search_path = pg_catalog, public as $$
 with h as (select regexp_replace(coalesce(public.career_apply_host(p_url), ''), ':[0-9]+$', '') as bare, public.career_apply_host(p_url) as full)
 select case
  when bare ~ '(^|\.)(linkedin\.com|lnkd\.in|indeed\.com|joinhandshake\.com|handshake\.com)$' then 'refused'
  when "full" in ('boards.greenhouse.io', 'job-boards.greenhouse.io') then 'greenhouse'
  when "full" = 'jobs.lever.co' then 'lever'
  when bare ~ '(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|taleo\.net|successfactors\.com|successfactors\.eu|oraclecloud\.com|ultipro\.com|dayforcehcm\.com|brassring\.com|adp\.com|paycomonline\.net)$' then 'account_gated'
  when bare in ('127.0.0.1', 'localhost') then 'local'
  else 'unsupported' end
 from h
$$;
create or replace function public.career_apply_vm_claimable(p_url text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select case public.career_apply_vm_family(p_url)
  when 'greenhouse' then true when 'lever' then true
  when 'local' then coalesce((select value = 'on' from public.career_cloud_settings where key = 'APPLY_VM_ALLOW_LOCAL'), false)
  else false end
$$;
