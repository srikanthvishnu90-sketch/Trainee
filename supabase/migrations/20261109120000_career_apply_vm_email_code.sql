-- WO-M fix a, second half (architect ruling, 2026-11-09, option A with strict evidence): an employer that answers the
-- apply VM's Submit with "enter the code we emailed you" has not taken the application. Until now the VM could only end it
-- unknown_outcome (career_apply_vm_complete turns any not_submitted after the 'submitting' record into unknown), so the
-- posting stayed blocked as "maybe applied" and the person was never asked again.
--
-- What changes, and nothing else:
--   1. career_apply_vm_email_code_refusal(url, evidence): null only when the evidence shows ALL of
--        (1) a visible code-entry field after the click, on the same employer host as the approved link;
--        (2) no confirmation signal (URL, heading or text);
--        (3) a hash of the page text and a hash of a screenshot, both stored.
--      Otherwise it names the missing piece.
--   2. career_apply_vm_complete: after 'submitting', not_submitted / email_code stands ONLY when (1) says null. Anything less
--      is unknown_outcome exactly as before, with the missing piece in the reason. Every other state and reason after the
--      click: unchanged (the "past the click, not sent cannot be known" guard holds everywhere else).
--   3. career_apply_job_history: not_submitted / email_code is history too, so the posting can be prepared again. The live-row
--      index (career_apply_jobs_live_posting) gets the same predicate. Every anchored rewrite of 20261101130000 already calls
--      career_apply_job_history, so it follows.
--   4. The re-prepare trigger fires for email_code as for needs_answers: the posting goes back to the person's queue and a
--      preparation is asked for. The re-prepared application goes ONLY on a new card, a new payload hash and the person's yes:
--      career_apply_history_approval_guard refuses the old payload, approval or engine approval on any new row. Never resent.
-- Additive and reversible (supabase/rollbacks/20261109120000_career_apply_vm_email_code.down.sql). Idempotent.

-- 1. The evidence rule.
create or replace function public.career_apply_vm_email_code_refusal(p_url text, p_evidence jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
 select case
  when jsonb_typeof(p_evidence->'email_code') is distinct from 'object' then 'no_code_page_evidence'
  when (p_evidence->'email_code'->'code_field_visible') is distinct from 'true'::jsonb then 'no_visible_code_field'
  when lower(regexp_replace(coalesce(p_evidence->'email_code'->>'host', ''), '^www\.', ''))
    is distinct from lower(regexp_replace(regexp_replace(coalesce(substring(p_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#]+)'), ''), ':[0-9]+$', ''), '^www\.', ''))
   or coalesce(p_evidence->'email_code'->>'host', '') = '' then 'code_field_on_another_host'
  when (p_evidence->'email_code'->'confirmation_signal') is distinct from 'false'::jsonb then 'confirmation_signal_present'
  when coalesce(p_evidence->'email_code'->>'page_text_sha256', '') !~ '^[0-9a-f]{64}$' then 'no_page_text_hash'
  when coalesce(p_evidence->'email_code'->>'screenshot_sha256', '') !~ '^[0-9a-f]{64}$' then 'no_screenshot_hash'
  else null end
$$;
revoke all on function public.career_apply_vm_email_code_refusal(text, jsonb) from public, anon, authenticated;

-- 2. The outcome: 20261028180000's text, with the one proven exception.
create or replace function public.career_apply_vm_complete(p_id uuid, p_lease uuid, p_worker text, p_state text, p_reason text, p_evidence jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; st text := p_state; rs text := left(coalesce(p_reason, ''), 120); ev jsonb := coalesce(p_evidence, '{}'); why text;
begin
 if p_state is null or p_state not in ('submitted_unconfirmed', 'needs_user', 'not_submitted', 'unknown_outcome', 'failed') then raise exception 'invalid apply transition'; end if;
 if jsonb_typeof(ev) is distinct from 'object' or octet_length(ev::text) > 60000 then raise exception 'invalid evidence'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving' for update;
 if not found then raise exception 'invalid apply claim'; end if;
 if st = 'submitted_unconfirmed' and j.vm_phase is distinct from 'submitting' then raise exception 'invalid apply transition'; end if;
 -- Past the record of the click, "not sent" cannot be known: unless the employer's own page proves it held the application
 -- for an emailed code (career_apply_vm_email_code_refusal is null).
 if st in ('not_submitted', 'failed') and j.vm_phase = 'submitting' then
  why := case when st = 'not_submitted' and rs = 'email_code' then public.career_apply_vm_email_code_refusal(j.url, ev) else 'not_proven' end;
  if why is not null then
   st := 'unknown_outcome';
   rs := case when p_reason = 'email_code'
    then left('application outcome unknown: a code page after Submit was not proven (' || why || '); not retried', 120)
    else 'application outcome unknown: it failed after Submit was pressed; not retried' end;
  end if;
 end if;
 update public.career_apply_jobs set state = st, reason = nullif(rs, ''), confirmation_id = case when st = 'submitted_unconfirmed' then ev->>'confirmation_id' end,
  evidence = ev || jsonb_build_object('by', 'vm', 'worker', p_worker, 'finished_at', clock_timestamp()), updated_at = clock_timestamp()
  where id = p_id returning * into j;
 return jsonb_build_object('id', j.id, 'state', j.state, 'reason', j.reason);
end $$;
revoke all on function public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb) to apply_vm_worker, service_role;

-- 3. History, and the one live row per person and posting.
create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select j.state = 'not_submitted' and coalesce(j.reason, '') in ('needs_answers', 'email_code')
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;
-- The new predicate excludes more rows than the old one, so building it cannot fail on rows the old one held. Same name, in
-- this migration's one transaction.
drop index if exists public.career_apply_jobs_live_posting;
create unique index career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not (state = 'not_submitted' and coalesce(reason, '') in ('needs_answers', 'email_code'));

-- 4. Back in the queue, and a preparation asked for: 20261101130000's trigger, for email_code too.
create or replace function public.career_apply_reprepare_on_needs_answers() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state = 'not_submitted' and coalesce(new.reason, '') in ('needs_answers', 'email_code') and old.state is distinct from 'not_submitted' then
  begin
   insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
   values (new.user_id, new.job_id, new.url, left(coalesce(new.company, ''), 200), left(coalesce(new.payload->>'title', ''), 200), 'waiting', clock_timestamp())
   on conflict (user_id, posting_key) do update set state = 'waiting', taken_at = null, queued_at = clock_timestamp();
   perform public.career_apply_prepare_request_put(new.user_id, array[new.job_id], public.career_apply_daily_limit(new.user_id));
  exception when others then
   -- Never lose the finish over the re-queue: the posting can still be asked for again in chat.
   raise warning 'reprepare: % (job %)', sqlerrm, new.id;
  end;
 end if;
 return new;
end $$;
revoke all on function public.career_apply_reprepare_on_needs_answers() from public, anon, authenticated;
