-- Rollback of 20261112160000_career_apply_handoff_recheck.sql: the hand-off answers and their row state go. A row a "done" or a
-- yes put back in the queue is closed first, unsent: without its hand-off state the apply VM would drive it as an ordinary approved
-- row and could press Submit without the person's yes to the exact-answers card.
update public.career_apply_jobs set state = 'not_submitted', reason = 'handoff_rolled_back',
 evidence = evidence || jsonb_build_object('nothing_sent', true, 'closed', 'handoff_rolled_back', 'closed_at', clock_timestamp()), updated_at = clock_timestamp()
 where state = 'queued' and handoff_done_at is not null;
drop function if exists public.career_apply_handoff_done_as(uuid, uuid);
drop function if exists public.career_apply_handoff_yes_as(uuid, uuid, text);
drop function if exists public.career_apply_vm_handoff_state(uuid, uuid, text);
drop function if exists public.career_apply_handoff_requeue(public.career_apply_jobs, jsonb, jsonb);
drop function if exists public.career_apply_handoff_refusal(public.career_apply_jobs);
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_handoff_yes_shape;
alter table public.career_apply_jobs drop column if exists handoff_yes;
alter table public.career_apply_jobs drop column if exists handoff_done_at;
