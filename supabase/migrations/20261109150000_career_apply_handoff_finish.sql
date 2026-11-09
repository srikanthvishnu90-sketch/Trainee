-- WO-L (b, d): an application stopped by an employer's sign-in wall is the person's to finish, and their answer is recorded.
--
-- Before: the cloud worker ended such an application needs_user (login_required, bot_check, email_code) and nothing could
-- move it again. The live-posting index (20261101130000) treated only not_submitted/needs_answers as history, so the
-- posting was blocked for good. Nothing recorded that the person finished it themselves.
--
-- Now, through the person's own answer on the hand-off File (career_apply_person_finished_as, service role only; the File
-- handler checks the signed-in owner):
--   'submitted' -> the row becomes submitted_unconfirmed (reason finished_by_person, evidence.by_person), so it joins the
--                  set the mail match reads (career_mail_store.ts WENT) and an employer's confirmation can confirm it.
--                  Nothing was sent by Trainee and no confirmation is invented.
--   'not_done'  -> the row becomes HISTORY (career_apply_job_history), the posting goes back to the person's queue and a
--                  preparation is asked for: a NEW card and a NEW approval of a new payload (the history approval guard
--                  of 20261101130000 refuses the old one). Never an automatic resend.
-- A wall row is history only once the person said 'not_done', and only when evidence.nothing_sent holds (WO-L a sets it;
-- a row triage handed back before any drive, attempts = 0, gets it when the person answers). It is not history the
-- moment the worker stops (the work order's first sketch): then career_apply_prepare_candidates (an alert within 14 days)
-- would prepare it again on its own and put a second card in front of someone just told to finish it at the employer,
-- and the same wall would stop that one too.
-- career_apply_vm_handoff_requeue (20261028180000) re-queues a handed-back row with its old approval; it now refuses a
-- row the person already answered.
-- Additive and reversible (supabase/rollbacks/20261109150000_career_apply_handoff_finish.down.sql). Idempotent.

-- 1. History: the form needed answers (20261101130000), or the person said they did not finish a wall nothing was sent past.
create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select (j.state = 'not_submitted' and coalesce(j.reason, '') = 'needs_answers')
  or (j.state = 'needs_user' and coalesce(j.reason, '') in ('login_required', 'bot_check', 'email_code')
   and coalesce(j.evidence->>'nothing_sent', '') = 'true' and coalesce(j.evidence->'by_person'->>'outcome', '') = 'not_done')
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;

-- 2. At most one live row per person and posting: the same predicate as the function above (an index cannot call it).
create unique index if not exists career_apply_jobs_live_posting_v2 on public.career_apply_jobs (user_id, job_id)
 where not ((state = 'not_submitted' and coalesce(reason, '') = 'needs_answers')
  or (state = 'needs_user' and coalesce(reason, '') in ('login_required', 'bot_check', 'email_code')
   and coalesce(evidence->>'nothing_sent', '') = 'true' and coalesce(evidence->'by_person'->>'outcome', '') = 'not_done'));
drop index if exists public.career_apply_jobs_live_posting;

-- 3. The person's answer.
create or replace function public.career_apply_person_finished_as(p_user uuid, p_id uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; now_ timestamptz := clock_timestamp(); queued boolean := false;
begin
 if p_outcome is null or p_outcome not in ('submitted', 'not_done') then return jsonb_build_object('ok', false, 'why', 'bad_outcome'); end if;
 select * into j from public.career_apply_jobs where id = p_id and user_id = p_user for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;
 -- One answer per hand-off; the same answer again is a no-op (a double tap), a different one is refused.
 if j.evidence ? 'by_person' then
  if j.evidence->'by_person'->>'outcome' = p_outcome then return jsonb_build_object('ok', true, 'outcome', p_outcome, 'already', true); end if;
  return jsonb_build_object('ok', false, 'why', 'already_answered', 'outcome', j.evidence->'by_person'->>'outcome');
 end if;
 -- Only a wall the worker stopped at before anything was sent (or a portal triage handed back without a drive).
 if j.state <> 'needs_user' or coalesce(j.reason, '') not in ('login_required', 'bot_check', 'email_code')
  or not (coalesce(j.evidence->>'nothing_sent', '') = 'true' or j.attempts = 0) then
  return jsonb_build_object('ok', false, 'why', 'not_handed_back');
 end if;
 if p_outcome = 'submitted' then
  update public.career_apply_jobs set state = 'submitted_unconfirmed', reason = 'finished_by_person',
   evidence = evidence || jsonb_build_object('nothing_sent', true, 'by_person', jsonb_build_object('outcome', 'submitted', 'at', now_, 'wall', j.reason)),
   updated_at = now_
   where id = j.id;
  return jsonb_build_object('ok', true, 'outcome', 'submitted', 'state', 'submitted_unconfirmed');
 end if;
 update public.career_apply_jobs set
  evidence = evidence || jsonb_build_object('nothing_sent', true, 'by_person', jsonb_build_object('outcome', 'not_done', 'at', now_, 'wall', j.reason)),
  updated_at = now_
  where id = j.id;
 -- Back in the person's queue and a preparation asked for, as 20261101130000 does for a form that needed answers: a new
 -- card, a new approval. Never lose the answer over the re-queue; the posting can still be asked for again in chat.
 begin
  insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
  values (j.user_id, j.job_id, j.url, left(coalesce(j.company, ''), 200), left(coalesce(j.payload->>'title', ''), 200), 'waiting', now_)
  on conflict (user_id, posting_key) do update set state = 'waiting', taken_at = null, queued_at = now_;
  perform public.career_apply_prepare_request_put(j.user_id, array[j.job_id], public.career_apply_daily_limit(j.user_id));
  queued := true;
 exception when others then
  raise warning 'person_finished_as reprepare: % (job %)', sqlerrm, j.id;
 end;
 return jsonb_build_object('ok', true, 'outcome', 'not_done', 'reprepare', queued);
end $$;
revoke all on function public.career_apply_person_finished_as(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.career_apply_person_finished_as(uuid, uuid, text) to service_role;

-- 4. 20261028180000's re-queue, refusing a hand-off the person already answered (its old approval is spent).
create or replace function public.career_apply_vm_handoff_requeue(p_user uuid, p_job_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 select * into j from public.career_apply_jobs where user_id = p_user and job_id = p_job_id and state = 'needs_user' and reason = 'login_required'
  and not (evidence ? 'by_person') for update;
 if not found then return jsonb_build_object('ok', false); end if;
 -- A portal the VM cannot fill at all (a sign-in-only employer) is finished by the person; re-queuing it would wait for nothing.
 if not public.career_apply_vm_claimable(j.url) then return jsonb_build_object('ok', false, 'why', 'site_not_supported_yet'); end if;
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return jsonb_build_object('ok', false, 'why', 'not_approved'); end if;
 update public.career_apply_jobs set state = 'queued', reason = null, evidence = evidence || jsonb_build_object('handoff_done_at', clock_timestamp()), updated_at = clock_timestamp()
  where id = j.id;
 return jsonb_build_object('ok', true);
end $$;
