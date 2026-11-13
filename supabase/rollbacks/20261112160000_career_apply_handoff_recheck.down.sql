-- Rollback of 20261112160000_career_apply_handoff_recheck.sql: the hand-off answers and their row state go. A row a "done" or a
-- yes put back in the queue is closed first, unsent: without its hand-off state the apply VM would drive it as an ordinary approved
-- row and could press Submit without the person's yes to the exact-answers card. The same for one a worker holds right now
-- (driving) that has not recorded the click: the dead-worker sweep (career_apply_vm_reap) would put it back in the queue as an
-- ordinary row, and the worker's own last check before Submit (its lease heartbeat) now finds no lease and stops unsent. A row
-- whose click is already recorded (vm_phase 'submitting': only ever after the person's yes to that exact card) is left to its
-- worker's honest outcome. Re-runnable: with the columns already gone there is nothing left to close.
-- One statement, so one transaction, with the table locked first (review of #800): a "done" that commits between the close and the
-- drop of the claim guard would otherwise leave a queued row with no hand-off state, which the plain claim would hand out as an
-- ordinary approved row. Under the lock nobody writes the table until every piece is gone; the functions that record a "done" or a
-- yes go before the rows are closed, so a call that was waiting on the lock finds no function and records nothing.
do $$ begin
 lock table public.career_apply_jobs in access exclusive mode;
 drop function if exists public.career_apply_handoff_done_as(uuid, uuid);
 drop function if exists public.career_apply_handoff_yes_as(uuid, uuid, text);
 if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'career_apply_jobs' and column_name = 'handoff_done_at') then
  execute $q$update public.career_apply_jobs set state = 'not_submitted', reason = 'handoff_rolled_back',
   evidence = evidence || jsonb_build_object('nothing_sent', true, 'closed', 'handoff_rolled_back', 'closed_at', clock_timestamp()), updated_at = clock_timestamp()
   where handoff_done_at is not null and (state = 'queued' or (state = 'driving' and vm_phase is distinct from 'submitting'))$q$;
 end if;
 drop trigger if exists career_apply_handoff_claim_guard on public.career_apply_jobs;
 drop function if exists public.career_apply_handoff_claim_guard();
 drop function if exists public.career_apply_vm_claim_handoff(text, integer, integer, text[]);
 drop function if exists public.career_apply_vm_handoff_state(uuid, uuid, text);
 drop function if exists public.career_apply_handoff_requeue(public.career_apply_jobs, jsonb, jsonb);
 drop function if exists public.career_apply_handoff_refusal(public.career_apply_jobs);
 alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_handoff_yes_shape;
 alter table public.career_apply_jobs drop column if exists handoff_yes;
 alter table public.career_apply_jobs drop column if exists handoff_done_at;
end $$;
