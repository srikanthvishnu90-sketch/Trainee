-- Rollback of 20261113140000_career_apply_stop_stale_facts.sql: the stop, the claim guard, the record of changes and facts_at go.
-- Rows already closed (not_submitted, evidence.reason 'fact_changed') stay closed: nothing is put back in the queue. After this an
-- approved application is again not stopped when a fact it states changes (the state before the migration); the chat's call finds
-- no function and its reply says the approved applications could not be checked. One transaction, re-runnable.
do $$ begin
 lock table public.career_apply_jobs in access exclusive mode;
 drop function if exists public.career_apply_stop_stale_facts(uuid, text[], text);
 drop trigger if exists career_apply_facts_claim_guard on public.career_apply_jobs;
 drop function if exists public.career_apply_facts_claim_guard();
 drop trigger if exists career_apply_facts_email_guard on public.career_apply_jobs;
 drop function if exists public.career_apply_facts_email_guard();
 drop trigger if exists career_apply_facts_at_stamp on public.career_apply_jobs;
 drop trigger if exists career_apply_facts_at_stamp on public.career_apply_prepared;
 drop function if exists public.career_apply_facts_at_stamp();
 drop function if exists public.career_apply_fact_changed_close(uuid, timestamptz, text);
 drop function if exists public.career_apply_payload_states(jsonb, text[]);
 alter table public.career_apply_jobs drop column if exists facts_at;
 alter table public.career_apply_prepared drop column if exists facts_at;
 drop table if exists public.career_apply_fact_changes;
end $$;
