-- The card-bound cloud route's last check before Submit, and a closed posting (2026-10-31). career_apply_message_cloud_authorize
-- (the card-cloud bridge's) did not look at the posting: one the employer closed between the claim and the Submit was still
-- sent. The text route's check refuses it since 20261030140000 (career_apply_cloud_text_refusal). Here the bridge's check
-- ends such an application as not sent, with the words the claims give ("not sent: the posting closed before we sent it",
-- career_apply_unsendable_words) and evidence nothing_sent, records the cloud outcome (not_sent, posting_closed) and answers
-- authorized: false, so neither the engine nor the Submit runs (a raise would roll the record back).
-- Rewritten in place by an exact anchor (as career_apply_submit_worker_install does), so the function keeps everything else
-- it has (the bridge's card binding, its pace and duplicate checks). The bridge not installed (it is not live): skipped;
-- career_apply_reconcile_bridge(), which the launch scripts run after every apply (scripts/launch/verify-claim-guards.sql),
-- now ends with this rewrite, so a bridge applied later takes it.
-- Idempotent: applies cleanly twice. Service role only; nothing here is granted to a person.

create or replace function public.career_apply_cloud_authorize_closed_install() returns text
language plpgsql security definer set search_path = public, pg_temp as $ci$
declare n int := 0; f text := 'public.career_apply_message_cloud_authorize(uuid,uuid,text,text)';
 a_from text := E'  or j.claimed_at<=n-interval''15 minutes'' then raise exception ''invalid apply claim''; end if;\n';
 a_to text := E'  or j.claimed_at<=n-interval''15 minutes'' then raise exception ''invalid apply claim''; end if;\n'
  || E' -- 2026-10-31: the employer closed the posting: ended here as not sent, in the person''s words; no engine, no Submit.\n'
  || E' if exists(select from public.career_postings cp where cp.job_id=j.job_id and cp.closed_at is not null) then\n'
  || E'  perform public.career_apply_cloud_finish(p_id,p_lease,''not_submitted'',jsonb_build_object(''reason'',public.career_apply_unsendable_words(''posting_closed''),\n'
  || E'   ''closed'',''posting_closed'',''closed_at'',n,''nothing_sent'',true),''not_sent'',''posting_closed'');\n'
  || E'  return jsonb_build_object(''authorized'',false,''refused'',''posting_closed'',''reason'',public.career_apply_unsendable_words(''posting_closed''));\n'
  || E' end if;\n';
begin
 if to_regprocedure(f) is null then return 'not installed'; end if;
 if position('posting_closed' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := public.career_apply_mass_submit_rewrite(f, array[a_from, a_to]);
 end if;
 if position('posting_closed' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  raise exception 'cloud authorize: a closed posting is not refused (the anchor was not found)';
 end if;
 return format('rewritten %s', n);
end $ci$;
revoke all on function public.career_apply_cloud_authorize_closed_install() from public, anon, authenticated;

-- 20261030140000's reconcile, ending with the rewrite above too.
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 perform public.career_apply_submit_worker_install();
 perform public.career_apply_cloud_authorize_closed_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;

select public.career_apply_cloud_authorize_closed_install();
