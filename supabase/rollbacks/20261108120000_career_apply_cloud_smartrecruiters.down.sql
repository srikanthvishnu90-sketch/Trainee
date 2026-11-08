-- Reverses 20261108120000_career_apply_cloud_smartrecruiters.sql: the cloud's claims, refusals, gate and dispatch name
-- Greenhouse, Lever and Ashby again, and the waivers' portal check is the three. A SmartRecruiters application already
-- approved stays as it is (refused 'portal_not_cloud' at its next claim, as before); a SmartRecruiters waiver row, if one
-- was written, is revoked so the narrower check can be added.
do $sr$
declare r record; d text; n text;
begin
 for r in
  select p.oid, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.prokind = 'f' and p.proname like 'career\_apply\_%' and pg_get_functiondef(p.oid) ~ 'smartrecruiters'
   and pg_get_functiondef(p.oid) ~ $re$'ashby', ?'smartrecruiters'|''ashby'', ''smartrecruiters''$re$
 loop
  d := r.def;
  n := replace(d, $s$'greenhouse', 'lever', 'ashby', 'smartrecruiters'$s$, $s$'greenhouse', 'lever', 'ashby'$s$);
  n := replace(n, $s$'greenhouse','lever','ashby','smartrecruiters'$s$, $s$'greenhouse','lever','ashby'$s$);
  n := replace(n, $s$''greenhouse'', ''lever'', ''ashby'', ''smartrecruiters''$s$, $s$''greenhouse'', ''lever'', ''ashby''$s$);
  n := replace(n, $s$, 'smartrecruiters', count(*) filter (where public.career_apply_portal(url) = 'smartrecruiters')$s$, '');
  if n is distinct from d then execute n; end if;
 end loop;
end $sr$;
do $w$
begin
 if to_regclass('public.career_apply_cloud_gate_waivers') is null then return; end if;
 delete from public.career_apply_cloud_gate_waivers where portal = 'smartrecruiters';
 alter table public.career_apply_cloud_gate_waivers drop constraint if exists career_apply_cloud_gate_waivers_portal_check;
 alter table public.career_apply_cloud_gate_waivers add constraint career_apply_cloud_gate_waivers_portal_check check (portal in ('greenhouse', 'lever', 'ashby'));
end $w$;
