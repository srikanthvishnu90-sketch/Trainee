-- Reverses 20261109120000_career_apply_vm_email_code.sql: the VM's outcome, history, the live-row index and the re-prepare
-- trigger go back to 20261028180000's / 20261101130000's bodies. Refuses while an email_code history row and a live row exist
-- for the same person and posting (the old index cannot hold then): resolve those by hand first.
do $d$ begin
 if exists (select from public.career_apply_jobs h where h.state = 'not_submitted' and h.reason = 'email_code'
   and exists (select from public.career_apply_jobs l where l.user_id = h.user_id and l.job_id = h.job_id and l.id <> h.id
    and not (l.state = 'not_submitted' and coalesce(l.reason, '') in ('needs_answers', 'email_code')))) then
  raise exception 'rollback refused: an email_code history row has a live row for the same posting';
 end if;
end $d$;

create or replace function public.career_apply_vm_complete(p_id uuid, p_lease uuid, p_worker text, p_state text, p_reason text, p_evidence jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; st text := p_state; rs text := left(coalesce(p_reason, ''), 120); ev jsonb := coalesce(p_evidence, '{}');
begin
 if p_state is null or p_state not in ('submitted_unconfirmed', 'needs_user', 'not_submitted', 'unknown_outcome', 'failed') then raise exception 'invalid apply transition'; end if;
 if jsonb_typeof(ev) is distinct from 'object' or octet_length(ev::text) > 60000 then raise exception 'invalid evidence'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving' for update;
 if not found then raise exception 'invalid apply claim'; end if;
 if st = 'submitted_unconfirmed' and j.vm_phase is distinct from 'submitting' then raise exception 'invalid apply transition'; end if;
 -- Past the record of the click, "not sent" cannot be known.
 if st in ('not_submitted', 'failed') and j.vm_phase = 'submitting' then st := 'unknown_outcome'; rs := 'application outcome unknown: it failed after Submit was pressed; not retried'; end if;
 update public.career_apply_jobs set state = st, reason = nullif(rs, ''), confirmation_id = case when st = 'submitted_unconfirmed' then ev->>'confirmation_id' end,
  evidence = ev || jsonb_build_object('by', 'vm', 'worker', p_worker, 'finished_at', clock_timestamp()), updated_at = clock_timestamp()
  where id = p_id returning * into j;
 return jsonb_build_object('id', j.id, 'state', j.state, 'reason', j.reason);
end $$;
revoke all on function public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb) to apply_vm_worker, service_role;

create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select j.state = 'not_submitted' and coalesce(j.reason, '') = 'needs_answers'
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;
drop index if exists public.career_apply_jobs_live_posting;
create unique index career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not (state = 'not_submitted' and coalesce(reason, '') = 'needs_answers');

create or replace function public.career_apply_reprepare_on_needs_answers() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state = 'not_submitted' and coalesce(new.reason, '') = 'needs_answers' and old.state is distinct from 'not_submitted' then
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

drop function if exists public.career_apply_vm_email_code_refusal(text, jsonb);
