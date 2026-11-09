-- definer-scan: dynamic function DDL reviewed (career_apply_handoff_install rewrites installed bodies by exact anchors)
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
-- career_apply_vm_handoff_requeue (20261028180000) re-queued a handed-back row under its old approval (architect, WO-L):
--   a CLOUD row (the apply VM, or a portal triage handed back) is refused: a fresh cloud context never carries the
--   person's sign-in, and the approval was spent on the wall. Those go through career_apply_person_finished_as.
--   a row the person's own engine ran (source own_computer or extension: their browser session persists) is re-queued
--   under the same approval only while the payload still hashes to it and nothing was clicked; its source is cleared so
--   career_apply_claim_own can take it again (career_apply_jobs_fixed allows that for this one function's re-queue).
--   Either way, a hand-off the person already answered is never re-queued.
-- A person-submitted row is left out of the daily-cap "went" readers (architect, WO-L): that cap paces Trainee's own
-- sends, and the person submitting themselves is not Trainee sending. It still counts as sent everywhere else (the
-- posting ledger, the pipeline, the overview, the mail match). Rewritten by exact anchors (career_apply_handoff_install,
-- which career_apply_reconcile_bridge now ends with).
-- Additive and reversible (supabase/rollbacks/20261109150000_career_apply_handoff_finish.down.sql). Idempotent.

-- 1. History: the form needed answers (20261101130000), or the person said they did not finish a wall nothing was sent past.
create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select (j.state = 'not_submitted' and coalesce(j.reason, '') = 'needs_answers')
  or (j.state = 'needs_user' and coalesce(j.reason, '') in ('login_required', 'bot_check', 'email_code')
   and coalesce(j.evidence->>'nothing_sent', '') = 'true' and coalesce(j.evidence->'by_person'->>'outcome', '') = 'not_done')
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;

-- 2. At most one live row per person and posting: the same predicate as the function above (an index cannot call it). The
-- index keeps its name (career_apply_jobs_live_posting) so earlier rollbacks and checks that name it still find it.
drop index if exists public.career_apply_jobs_live_posting;
create unique index career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not ((state = 'not_submitted' and coalesce(reason, '') = 'needs_answers')
  or (state = 'needs_user' and coalesce(reason, '') in ('login_required', 'bot_check', 'email_code')
   and coalesce(evidence->>'nothing_sent', '') = 'true' and coalesce(evidence->'by_person'->>'outcome', '') = 'not_done'));

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

-- 4. 20261028180000's re-queue: cloud rows go through the hand-off File; the person's own engine may be re-queued.
create or replace function public.career_apply_vm_handoff_requeue(p_user uuid, p_job_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 select * into j from public.career_apply_jobs where user_id = p_user and job_id = p_job_id and state = 'needs_user' and reason = 'login_required'
  and not (evidence ? 'by_person') for update;
 if not found then return jsonb_build_object('ok', false); end if;
 if j.source is distinct from 'own_computer' and j.source is distinct from 'extension' then
  return jsonb_build_object('ok', false, 'why', 'finish_in_handoff_file');
 end if;
 if j.approval_hash is distinct from j.payload_hash or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload) then
  return jsonb_build_object('ok', false, 'why', 'approval_changed');
 end if;
 if coalesce(j.vm_phase, '') = 'submitting' or j.evidence ? 'clicked_at'
  or (jsonb_typeof(j.evidence->'proof') = 'object' and j.evidence->'proof' ? 'click') then
  return jsonb_build_object('ok', false, 'why', 'clicked');
 end if;
 perform set_config('career.apply_requeue', j.id::text, true);
 update public.career_apply_jobs set state = 'queued', reason = null, source = null, attempts = 0, lease_token = null, claimed_at = null,
  evidence = evidence || jsonb_build_object('handoff_done_at', clock_timestamp(), 'handoff_source', j.source), updated_at = clock_timestamp()
  where id = j.id;
 perform set_config('career.apply_requeue', '', true);
 return jsonb_build_object('ok', true);
end $$;
revoke all on function public.career_apply_vm_handoff_requeue(uuid, text) from public, anon, authenticated;

-- 5. The anchored rewrites: the daily-cap readers leave out a person-submitted row; the source of a local hand-off may be
--    cleared by the re-queue above (career.apply_requeue names that row, as 20261029180000's own re-queue does).
create or replace function public.career_apply_handoff_install() returns text
language plpgsql security definer set search_path = public, pg_temp as $hi$
declare n int := 0; f text; bad text[] := '{}';
 fns text[] := array['public.career_apply_message_cloud_authorize(uuid,uuid,text,text)', 'public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)',
  'public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)',
  'public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)'];
begin
 n := n + public.career_apply_mass_submit_rewrite(fns[1], array[
  E'id<>j.id and state=any(went) and claimed_at>n-interval''1 day''',
  E'id<>j.id and state=any(went) and coalesce(reason,'''')<>''finished_by_person'' and claimed_at>n-interval''1 day''']);
 n := n + public.career_apply_mass_submit_rewrite(fns[2], array[
  E'where user_id = j.user_id and state = any(went) and claimed_at > p_now - interval ''1 day'')',
  E'where user_id = j.user_id and state = any(went) and coalesce(reason, '''') <> ''finished_by_person'' and claimed_at > p_now - interval ''1 day'')']);
 n := n + public.career_apply_mass_submit_rewrite(fns[3], array[
  E'x.state = any(went)\n  and x.claimed_at > p_now - interval ''1 day'') >= cap',
  E'x.state = any(went) and coalesce(x.reason, '''') <> ''finished_by_person''\n  and x.claimed_at > p_now - interval ''1 day'') >= cap']);
 n := n + public.career_apply_mass_submit_rewrite(fns[4], array[
  E'y.state = any(went) and y.claimed_at > p_now - interval ''1 day'')',
  E'y.state = any(went) and coalesce(y.reason, '''') <> ''finished_by_person'' and y.claimed_at > p_now - interval ''1 day'')']);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_jobs_fixed()', array[
  E'new.source is null and old.state = ''driving'' and new.state = ''queued''',
  E'new.source is null and old.state in (''driving'', ''needs_user'') and new.state = ''queued''']);
 -- Every installed one must now carry the change; an anchor that moved fails loudly, never silently.
 foreach f in array fns loop
  if to_regprocedure(f) is not null and position('finished_by_person' in pg_get_functiondef(to_regprocedure(f))) = 0 then bad := bad || f; end if;
 end loop;
 -- The guard is checked only in a shape that has the re-queue exception at all (20261029180000 and later, as production):
 -- an older one (a migration-order test's) allows no source change, so a local re-queue there fails loudly (source_fixed).
 f := pg_get_functiondef('public.career_apply_jobs_fixed()'::regprocedure);
 if position('career.apply_requeue' in f) > 0 and position('old.state in (''driving'', ''needs_user'')' in f) = 0 then
  bad := bad || 'public.career_apply_jobs_fixed()'::text; end if;
 if cardinality(bad) > 0 then raise exception 'handoff: an anchor was not found in %', array_to_string(bad, ', '); end if;
 return format('rewritten %s', n);
end $hi$;
revoke all on function public.career_apply_handoff_install() from public, anon, authenticated;

-- 20261101130000's reconcile, ending with the rewrite above too.
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
 perform public.career_apply_handoff_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;

select public.career_apply_handoff_install();
