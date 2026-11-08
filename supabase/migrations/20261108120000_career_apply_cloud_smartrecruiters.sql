-- R9 (fix/r9-apply-completion, 2026-11-08): SmartRecruiters is a cloud portal family like Greenhouse, Lever and Ashby.
-- D-013 option (a) names the four open families (Greenhouse, Lever, Ashby, SmartRecruiters), the schema has always kept
-- SmartRecruiters postings (career_postings.provider) and portal pauses, career_apply_portal(url) already names the family,
-- and #593 taught the form fill SmartRecruiters' fields (workers/career-browser/ats-fill.cjs). But every cloud claim,
-- refusal, gate and dispatch still listed only the other three, so an approved SmartRecruiters application was refused
-- 'portal_not_cloud' (or never claimed) and the 1,000-task eval scored SmartRecruiters 0%.
--
-- This adds the family to those lists and to the gate waivers' portal check. It opens nothing by itself: a family sends
-- from the cloud only once its gate is open (career_apply_cloud_open: three of the gate testers' own applications on that
-- family confirmed by the employer's email) or under the owner's waiver for one person, exactly as the other three; the
-- person's yes to the exact payload, the daily pace, the portal and person pauses and every other check stay as they are.
--
-- Written over the LIVE definitions (pg_get_functiondef), not copied from older files: several of these functions were
-- rewritten in place by later migrations (20261025110000, 20261026100000), so the text installed is what is there now
-- with only the family lists widened. Idempotent: a list that already names SmartRecruiters is left as it is.
-- NOT APPLIED to the live project: the owner applies it through the release path (docs/launch/TRAINEE-GO-LIVE.md).
-- The per-family claim's generator (20261026100000) finds claim_at's family list by an exact anchor. It now accepts the
-- list with SmartRecruiters, or the three-family list of a claim_at installed again by an older file (the staged bridge
-- re-applied by the owner's launch script, tests/architect/bridge-ledger-order.test.ts B, B' and D): the per-family claim
-- is then made from whichever list claim_at holds, exactly once, as before.
create or replace function public.career_apply_cloud_claim_portal_sql() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare src text := (select prosrc from pg_proc where oid = 'public.career_apply_cloud_claim_at(integer,timestamptz)'::regprocedure);
 fam4_from text := 'unnest(array[''greenhouse'', ''lever'', ''ashby'', ''smartrecruiters'']) f where public.career_apply_cloud_open(f)';
 fam4_to text := 'unnest(array[''greenhouse'', ''lever'', ''ashby'', ''smartrecruiters'']) f where f = p_portal and public.career_apply_cloud_open(f)';
 fam3_from text := 'unnest(array[''greenhouse'', ''lever'', ''ashby'']) f where public.career_apply_cloud_open(f)';
 fam3_to text := 'unnest(array[''greenhouse'', ''lever'', ''ashby'']) f where f = p_portal and public.career_apply_cloud_open(f)';
 fam_from text; fam_to text;
 wf_from text := 'where w.revoked_at is null and w.expires_at > p_now';
 wf_to text := 'where w.portal = p_portal and w.revoked_at is null and w.expires_at > p_now';
 body text;
begin
 if src is null then raise exception 'career_apply_cloud_claim_at missing'; end if;
 if position(fam4_from in src) > 0 then fam_from := fam4_from; fam_to := fam4_to; else fam_from := fam3_from; fam_to := fam3_to; end if;
 if (length(src) - length(replace(src, fam_from, ''))) / length(fam_from) <> 1 then
  raise exception 'claim_at changed: the family anchor is not there exactly once'; end if;
 body := replace(src, fam_from, fam_to);
 if src like '%career_apply_cloud_gate_waivers w%' then
  if (length(src) - length(replace(src, wf_from, ''))) / length(wf_from) <> 1 then
   raise exception 'claim_at changed: the waiver anchor is not there exactly once'; end if;
  body := replace(body, wf_from, wf_to);
 end if;
 if position('$cr$' in body) > 0 then raise exception 'claim_at body holds the quote tag'; end if;
 return 'create or replace function public.career_apply_cloud_claim_portal_at(p_limit integer, p_now timestamptz, p_portal text) '
  || 'returns setof public.career_apply_jobs language plpgsql security definer set search_path = public, pg_temp as $cr$'
  || body || '$cr$';
end $$;

do $sr$
declare
 r record; d text; n text; changed int := 0;
begin
 for r in
  select p.oid, p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.prokind = 'f'
   and p.proname like 'career\_apply\_%'
   -- the generator above names both lists on purpose; the per-family claim is generated again below
   and p.proname not in ('career_apply_cloud_claim_portal_sql', 'career_apply_cloud_claim_portal_at')
   and pg_get_functiondef(p.oid) ~ $re$'greenhouse', ?'lever', ?'ashby'|''greenhouse'', ''lever'', ''ashby''$re$
 loop
  d := r.def;
  n := regexp_replace(d, $re$'greenhouse', 'lever', 'ashby'(?!, 'smartrecruiters')$re$, $rp$'greenhouse', 'lever', 'ashby', 'smartrecruiters'$rp$, 'g');
  n := regexp_replace(n, $re$'greenhouse','lever','ashby'(?!,'smartrecruiters')$re$, $rp$'greenhouse','lever','ashby','smartrecruiters'$rp$, 'g');
  n := regexp_replace(n, $re$''greenhouse'', ''lever'', ''ashby''(?!, ''smartrecruiters'')$re$, $rp$''greenhouse'', ''lever'', ''ashby'', ''smartrecruiters''$rp$, 'g');
  -- The in-flight count per family (career_apply_cloud_inflight) names each family's own count.
  n := regexp_replace(n, $re$('ashby', count\(\*\) filter \(where public\.career_apply_portal\(url\) = 'ashby'\))(?!,\s*'smartrecruiters')$re$,
   $rp$\1, 'smartrecruiters', count(*) filter (where public.career_apply_portal(url) = 'smartrecruiters')$rp$, 'g');
  if n is distinct from d then execute n; changed := changed + 1; end if;
 end loop;
 -- The per-family claim is generated from claim_at's own body (20261026100000): generated again from the widened one, so
 -- career_apply_cloud_runner_missing() reads empty. The reconcile (20261025110000) installs its texts from its own body,
 -- which the loop above widened too, so a later reconcile keeps the family.
 if to_regprocedure('public.career_apply_cloud_claim_portal_install()') is not null
  and to_regprocedure('public.career_apply_cloud_claim_at(integer,timestamptz)') is not null then
  perform public.career_apply_cloud_claim_portal_install();
 end if;
 raise notice 'smartrecruiters: % cloud function(s) now name the family', changed;
end $sr$;

-- The owner's per-person waiver may name SmartRecruiters too (still at most 5 sends, at most 7 days).
do $w$
declare c text;
begin
 if to_regclass('public.career_apply_cloud_gate_waivers') is null then return; end if;
 for c in select conname from pg_constraint where conrelid = 'public.career_apply_cloud_gate_waivers'::regclass and contype = 'c'
  and pg_get_constraintdef(oid) ~ 'portal' and pg_get_constraintdef(oid) !~ 'smartrecruiters' loop
  execute format('alter table public.career_apply_cloud_gate_waivers drop constraint %I', c);
 end loop;
 if not exists (select from pg_constraint where conrelid = 'public.career_apply_cloud_gate_waivers'::regclass and conname = 'career_apply_cloud_gate_waivers_portal_check') then
  alter table public.career_apply_cloud_gate_waivers add constraint career_apply_cloud_gate_waivers_portal_check
   check (portal in ('greenhouse', 'lever', 'ashby', 'smartrecruiters'));
 end if;
end $w$;
