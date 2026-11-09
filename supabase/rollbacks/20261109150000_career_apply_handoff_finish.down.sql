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
create unique index if not exists career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not (state = 'not_submitted' and coalesce(reason, '') = 'needs_answers');
drop index if exists public.career_apply_jobs_live_posting_v2;
drop function if exists public.career_apply_person_finished_as(uuid, uuid, text);
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
