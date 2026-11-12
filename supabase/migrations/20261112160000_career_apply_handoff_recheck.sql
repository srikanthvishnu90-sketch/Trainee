-- D-072 (item 4, round 2): the hand-off's live state on the apply rows, and the two answers the person gives in chat.
--
-- The runner stops at a wall the rules keep (an employer's sign-in, a shown verification check, an emailed code) with everything
-- else filled and nothing sent, and the apply VM records that stop as needs_user with its hand-off (evidence.handoff: the one step
-- in words and one https link to the employer's own page, workers/career-browser/handoff.cjs). The person finishes ONLY that step,
-- themselves, in their own browser at that link. Then:
--   1. "done" in chat -> career_apply_handoff_done_as: the row goes back to the queue for a RE-CHECK (handoff_done_at). The apply VM
--      re-opens the posting in a NEW cloud browser session (no cookie or session of the person's is carried: a fresh context per
--      run), drives the same approved payload to the instant before Submit, and records needs_user / ready_for_yes with the exact
--      answers the page holds as a card and the card's hash (evidence.answers_card). Nothing is sent on that run.
--      A wall that is still there on the re-check (the employer keeps the step in the person's own signed-in session) is recorded
--      with evidence.needs_extension: that application is finished in the person's own browser (the extension, or the person
--      submitting at the link themselves, career_apply_person_finished_as), never by the cloud, and it is never counted as a pass.
--      A board the cloud runner does not drive at all (career_apply_vm_claimable false: Workday and the other account portals) is
--      needs_extension at once.
--   2. "yes" to THAT card -> career_apply_handoff_yes_as: only when the card's hash is the one the row holds now. The row goes back to
--      the queue with handoff_yes = {card_hash}; the VM re-opens the page once more and presses Submit only if the page still holds
--      exactly that card (handoff.cjs recheck: another card is refused, unsent).
-- Both are service-role functions; the chat handler (supabase/functions/_shared/career_apply_handoff.ts) calls them for the
-- signed-in person. The apply VM reads a leased row's hand-off state with career_apply_vm_handoff_state (its role has no table
-- rights). The stored approval is checked again (career_apply_vm_approval_refusal): an expired or revoked approval is not re-queued.
-- The re-queue clears the claim's source the way 20261109150000's re-queue does (career.apply_requeue names the row; the guard
-- career_apply_jobs_fixed allows needs_user -> queued with the source cleared for that row only).
-- Additive and reversible (supabase/rollbacks/20261112160000_career_apply_handoff_recheck.down.sql). Idempotent.

alter table public.career_apply_jobs add column if not exists handoff_done_at timestamptz;
alter table public.career_apply_jobs add column if not exists handoff_yes jsonb;
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_handoff_yes_shape;
alter table public.career_apply_jobs add constraint career_apply_jobs_handoff_yes_shape
 check (handoff_yes is null or (jsonb_typeof(handoff_yes) = 'object' and coalesce(handoff_yes->>'card_hash', '') ~ '^[0-9a-f]{64}$'));

-- The one re-queue both answers use: back to the queue, unclaimed, sourceless, with the hand-off state given.
create or replace function public.career_apply_handoff_requeue(j public.career_apply_jobs, p_yes jsonb, p_note jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare now_ timestamptz := clock_timestamp();
begin
 perform set_config('career.apply_requeue', j.id::text, true);
 update public.career_apply_jobs set state = 'queued', reason = null, attempts = 0, lease_token = null, claimed_at = null, source = null,
  vm_worker = null, vm_heartbeat_at = null, vm_phase = null, not_before = null,
  handoff_done_at = coalesce(j.handoff_done_at, now_), handoff_yes = p_yes,
  evidence = evidence || p_note, updated_at = now_
  where id = j.id;
 perform set_config('career.apply_requeue', '', true);
end $$;
revoke all on function public.career_apply_handoff_requeue(public.career_apply_jobs, jsonb, jsonb) from public, anon, authenticated;

-- Why a row cannot be driven again by the cloud right now, or null.
create or replace function public.career_apply_handoff_refusal(j public.career_apply_jobs) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
 if coalesce(j.vm_phase, '') = 'submitting' or j.evidence ? 'clicked_at' then return 'clicked'; end if;
 if coalesce(j.evidence->>'nothing_sent', '') <> 'true' then return 'not_handed_back'; end if;
 if j.evidence ? 'by_person' then return 'already_answered'; end if;
 if j.source is distinct from 'cloud' then return 'not_cloud'; end if;
 if j.approval_hash is distinct from j.payload_hash or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload) then return 'approval_changed'; end if;
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return 'not_approved'; end if;
 return null;
end $$;
revoke all on function public.career_apply_handoff_refusal(public.career_apply_jobs) from public, anon, authenticated;

-- 1. "done": the person finished the step at the employer's page.
create or replace function public.career_apply_handoff_done_as(p_user uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; why text; now_ timestamptz := clock_timestamp();
begin
 select * into j from public.career_apply_jobs where id = p_id and user_id = p_user for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;
 if j.state <> 'needs_user' or coalesce(j.reason, '') not in ('login_required', 'bot_check', 'email_code')
  or jsonb_typeof(j.evidence->'handoff') is distinct from 'object' then return jsonb_build_object('ok', false, 'why', 'no_handoff_waiting'); end if;
 why := public.career_apply_handoff_refusal(j);
 if why is not null then return jsonb_build_object('ok', false, 'why', why); end if;
 -- A board the cloud runner does not drive (an account portal): the step lives in the person's own browser session.
 if not public.career_apply_vm_claimable(j.url) then
  update public.career_apply_jobs set evidence = evidence || jsonb_build_object('needs_extension', true, 'needs_extension_at', now_), updated_at = now_ where id = j.id;
  return jsonb_build_object('ok', false, 'why', 'needs_extension');
 end if;
 perform public.career_apply_handoff_requeue(j, null, jsonb_build_object('handoff_done', jsonb_build_object('at', now_, 'wall', j.reason)));
 return jsonb_build_object('ok', true, 'state', 'queued', 'recheck', true);
end $$;
revoke all on function public.career_apply_handoff_done_as(uuid, uuid) from public, anon, authenticated;
grant execute on function public.career_apply_handoff_done_as(uuid, uuid) to service_role;

-- 2. "yes" to the exact-answers card the re-check recorded: only that card's hash.
create or replace function public.career_apply_handoff_yes_as(p_user uuid, p_id uuid, p_card_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; why text; now_ timestamptz := clock_timestamp();
begin
 if p_card_hash is null or p_card_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'why', 'bad_card'); end if;
 select * into j from public.career_apply_jobs where id = p_id and user_id = p_user for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;
 if j.state <> 'needs_user' or coalesce(j.reason, '') <> 'ready_for_yes' or j.handoff_done_at is null then return jsonb_build_object('ok', false, 'why', 'no_card_waiting'); end if;
 if coalesce(j.evidence->'answers_card'->>'hash', '') <> p_card_hash then return jsonb_build_object('ok', false, 'why', 'card_changed'); end if;
 why := public.career_apply_handoff_refusal(j);
 if why is not null then return jsonb_build_object('ok', false, 'why', why); end if;
 perform public.career_apply_handoff_requeue(j, jsonb_build_object('card_hash', p_card_hash, 'at', now_), jsonb_build_object('handoff_yes_at', now_));
 return jsonb_build_object('ok', true, 'state', 'queued', 'card_hash', p_card_hash);
end $$;
revoke all on function public.career_apply_handoff_yes_as(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.career_apply_handoff_yes_as(uuid, uuid, text) to service_role;

-- The apply VM: the hand-off state of the row it holds the lease on (its role reads no table).
create or replace function public.career_apply_vm_handoff_state(p_id uuid, p_lease uuid, p_worker text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving';
 if not found then raise exception 'invalid apply claim'; end if;
 return jsonb_build_object('handoff_done_at', j.handoff_done_at, 'handoff_yes', j.handoff_yes);
end $$;
revoke all on function public.career_apply_vm_handoff_state(uuid, uuid, text) from public, anon, authenticated;
do $$ begin
 if exists (select from pg_roles where rolname = 'apply_vm_worker') then
  grant execute on function public.career_apply_vm_handoff_state(uuid, uuid, text) to apply_vm_worker;
 end if;
end $$;
grant execute on function public.career_apply_vm_handoff_state(uuid, uuid, text) to service_role;
