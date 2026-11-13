-- Rollback of 20261113140000_career_apply_stop_stale_facts.sql: the stop, the guards, the record of changes and facts_at go; the
-- apply VM's heartbeat and the cloud authorization go back to 20261105120000's and 20261026230017's. Rows already closed
-- (not_submitted, evidence.reason 'fact_changed') stay closed: nothing is put back in the queue. After this an approved application
-- is again not stopped when a fact it states changes (the state before the migration); the chat's call finds no function and its
-- reply says the approved applications could not be checked. One transaction, re-runnable.
do $$ begin
 lock table public.career_apply_jobs in access exclusive mode;
 drop function if exists public.career_apply_stop_stale_facts(uuid, jsonb, text);
 drop function if exists public.career_apply_stop_stale_facts(uuid, text[], text);
 drop trigger if exists career_apply_facts_claim_guard on public.career_apply_jobs;
 drop function if exists public.career_apply_facts_claim_guard();
 drop trigger if exists career_apply_facts_email_guard on public.career_apply_jobs;
 drop function if exists public.career_apply_facts_email_guard();
 drop trigger if exists career_apply_facts_at_stamp on public.career_apply_jobs;
 drop trigger if exists career_apply_facts_at_stamp on public.career_apply_prepared;
 drop function if exists public.career_apply_facts_at_stamp();
 drop trigger if exists career_apply_facts_write_record on public.career_watch_kv;
 drop trigger if exists career_apply_facts_write_record on public.agent_flow_state;
 drop function if exists public.career_apply_facts_write_record();
 drop function if exists public.career_apply_facts_diff(jsonb, jsonb);
end $$;
create or replace function public.career_apply_vm_heartbeat(p_id uuid, p_lease uuid, p_worker text, p_phase text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 if p_phase is not null and p_phase not in ('preparing', 'submitting') then raise exception 'invalid phase'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving' for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'lease_lost'); end if;
 -- Revoked or expired since the claim: stop, whatever the phase (the queue trigger would refuse this write anyway).
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return jsonb_build_object('ok', false, 'why', 'not_approved'); end if;
 if p_phase = 'submitting' then
  if not public.career_apply_vm_enabled() then return jsonb_build_object('ok', false, 'why', 'switch_off'); end if;
  if not public.career_apply_current(j.user_id, j.payload) then return jsonb_build_object('ok', false, 'why', 'account_changed'); end if;
  if not public.career_apply_vm_user_ok(j.user_id) then return jsonb_build_object('ok', false, 'why', 'not_opted_in'); end if;
  if exists (select from public.career_postings cp where cp.job_id = j.job_id and cp.closed_at is not null) then
   return jsonb_build_object('ok', false, 'why', 'posting_closed'); end if;
  if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then
   return jsonb_build_object('ok', false, 'why', 'duplicate_job'); end if;
  if j.vm_phase = 'preparing' then
   update public.career_apply_jobs set vm_phase = 'submitting', vm_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_id;
  else
   update public.career_apply_jobs set vm_heartbeat_at = clock_timestamp() where id = p_id;
  end if;
 else
  update public.career_apply_jobs set vm_heartbeat_at = clock_timestamp() where id = p_id;
 end if;
 return jsonb_build_object('ok', true);
end $$;
revoke all on function public.career_apply_vm_heartbeat(uuid, uuid, text, text) from public, anon, authenticated;
do $$ begin
 if exists (select from pg_roles where rolname = 'apply_vm_worker') then
  grant execute on function public.career_apply_vm_heartbeat(uuid, uuid, text, text) to apply_vm_worker;
 end if;
end $$;
grant execute on function public.career_apply_vm_heartbeat(uuid, uuid, text, text) to service_role;
create or replace function public.career_apply_cloud_authorize_any(p_id uuid, p_lease uuid, p_hash text, p_source_digest text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
 if public.career_apply_cloud_card_bound(p_id) then
  execute 'select public.career_apply_message_cloud_authorize($1, $2, $3, $4)' into r using p_id, p_lease, p_hash, p_source_digest;
  return r;
 end if;
 return public.career_apply_cloud_text_authorize(p_id, p_lease, p_hash, p_source_digest);
end $$;
revoke all on function public.career_apply_cloud_authorize_any(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.career_apply_cloud_authorize_any(uuid, uuid, text, text) to service_role;
do $$ begin
 drop function if exists public.career_apply_fact_changed_close(uuid, timestamptz, text);
 drop function if exists public.career_apply_fact_hit(uuid, jsonb, timestamptz);
 drop function if exists public.career_apply_payload_stale(jsonb, text[], text[]);
 drop function if exists public.career_apply_payload_states(jsonb, text[]);
 drop function if exists public.career_apply_changed_keys(text, text, text, text);
 drop function if exists public.career_apply_value_keys(text);
 drop function if exists public.career_apply_value_key(text);
 drop function if exists public.career_apply_fact_stops_untold(uuid);
 drop function if exists public.career_apply_fact_keys(text, text);
 drop function if exists public.career_apply_fact_said(jsonb);
 drop function if exists public.career_apply_fact_value_text(text);
 drop function if exists public.career_apply_topics(text);
 drop function if exists public.career_apply_norm_text(text);
 alter table public.career_apply_jobs drop column if exists facts_at;
 alter table public.career_apply_prepared drop column if exists facts_at;
 drop table if exists public.career_apply_fact_changes;
end $$;
