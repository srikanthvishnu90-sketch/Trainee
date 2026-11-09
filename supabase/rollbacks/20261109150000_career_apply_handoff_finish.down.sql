-- Reverses 20261109150000_career_apply_handoff_finish.sql. Refuses while a posting has a live row next to a wall row the
-- person answered 'not_done' (the old live-posting index cannot hold then): those must be resolved first, by hand.
-- Answers already recorded (evidence.by_person, a row moved to submitted_unconfirmed) are kept: they are the person's.
do $d$ begin
 if exists (select from public.career_apply_jobs group by user_id, job_id
   having count(*) filter (where not (state = 'not_submitted' and coalesce(reason, '') = 'needs_answers')) > 1) then
  raise exception 'rollback refused: a posting has a live row and an answered hand-off row';
 end if;
end $d$;
create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select j.state = 'not_submitted' and coalesce(j.reason, '') = 'needs_answers'
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;
drop index if exists public.career_apply_jobs_live_posting;
create unique index career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not (state = 'not_submitted' and coalesce(reason, '') = 'needs_answers');
drop index if exists public.career_apply_jobs_live_posting_v2;
drop function if exists public.career_apply_person_finished_as(uuid, uuid, text);
-- The anchored rewrites, reversed by the same anchors; then the reconcile as 20261101130000 left it.
do $d$
begin
 perform public.career_apply_mass_submit_rewrite('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)', array[
  E'id<>j.id and state=any(went) and coalesce(reason,'''')<>''finished_by_person'' and claimed_at>n-interval''1 day''',
  E'id<>j.id and state=any(went) and claimed_at>n-interval''1 day''']);
 perform public.career_apply_mass_submit_rewrite('public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)', array[
  E'where user_id = j.user_id and state = any(went) and coalesce(reason, '''') <> ''finished_by_person'' and claimed_at > p_now - interval ''1 day'')',
  E'where user_id = j.user_id and state = any(went) and claimed_at > p_now - interval ''1 day'')']);
 perform public.career_apply_mass_submit_rewrite('public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)', array[
  E'x.state = any(went) and coalesce(x.reason, '''') <> ''finished_by_person''\n  and x.claimed_at > p_now - interval ''1 day'') >= cap',
  E'x.state = any(went)\n  and x.claimed_at > p_now - interval ''1 day'') >= cap']);
 perform public.career_apply_mass_submit_rewrite('public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)', array[
  E'y.state = any(went) and coalesce(y.reason, '''') <> ''finished_by_person'' and y.claimed_at > p_now - interval ''1 day'')',
  E'y.state = any(went) and y.claimed_at > p_now - interval ''1 day'')']);
 perform public.career_apply_mass_submit_rewrite('public.career_apply_jobs_fixed()', array[
  E'new.source is null and old.state in (''driving'', ''needs_user'') and new.state = ''queued''',
  E'new.source is null and old.state = ''driving'' and new.state = ''queued''']);
end $d$;
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 perform public.career_apply_submit_worker_install();
 perform public.career_apply_cloud_authorize_closed_install();
 perform public.career_apply_reprepare_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;
drop function if exists public.career_apply_handoff_install();
-- 20261028180000's re-queue, as it was.
create or replace function public.career_apply_vm_handoff_requeue(p_user uuid, p_job_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 select * into j from public.career_apply_jobs where user_id = p_user and job_id = p_job_id and state = 'needs_user' and reason = 'login_required' for update;
 if not found then return jsonb_build_object('ok', false); end if;
 -- A portal the VM cannot fill at all (a sign-in-only employer) is finished by the person; re-queuing it would wait for nothing.
 if not public.career_apply_vm_claimable(j.url) then return jsonb_build_object('ok', false, 'why', 'site_not_supported_yet'); end if;
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return jsonb_build_object('ok', false, 'why', 'not_approved'); end if;
 update public.career_apply_jobs set state = 'queued', reason = null, evidence = evidence || jsonb_build_object('handoff_done_at', clock_timestamp()), updated_at = clock_timestamp()
  where id = j.id;
 return jsonb_build_object('ok', true);
end $$;
revoke all on function public.career_apply_vm_handoff_requeue(uuid, text) from public, anon, authenticated;
