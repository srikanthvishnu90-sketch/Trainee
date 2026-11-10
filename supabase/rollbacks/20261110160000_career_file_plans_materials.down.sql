-- Rollback of 20261110160000_career_file_plans_materials.sql (item 6 S3). Drops the search plans and material versions and their
-- approve functions. The F-04 and F-07 Files then have no record to be drawn from and show nothing to approve.
-- Refuses while any version is approved: an approved document or plan is the person's and is never dropped by a rollback (E.4 40).
do $d$ begin
 if to_regclass('public.career_search_plans') is not null and exists (select from public.career_search_plans where approved_at is not null)
  or to_regclass('public.career_material_versions') is not null and exists (select from public.career_material_versions where approved_at is not null) then
  raise exception 'approved versions exist; export them and resolve by hand before rolling back';
 end if;
end $d$;
drop function if exists public.career_search_plan_approve_as(uuid, integer, text, timestamptz);
drop function if exists public.career_material_version_approve_as(uuid, text, integer, text, text, timestamptz);
drop table if exists public.career_search_plans cascade;
drop table if exists public.career_material_versions cascade;
drop function if exists public.career_file_versions_guard();
drop function if exists public.career_search_plan_hash(public.career_search_plans);
drop function if exists public.career_material_version_hash(public.career_material_versions);
