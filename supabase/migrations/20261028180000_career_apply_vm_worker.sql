-- The apply VM, the database side (owner, 2026-10-28: no Browserbase; we run our own browsers on our own VM, many people
-- at once, no volume cap of ours - D-MS-2).
-- NOT APPLIED: like every migration, the owner applies it; nothing here runs on the live project until then.
--
-- What it adds, and nothing else:
--  - career_apply_vm_claim: the VM's claim. Round-robin ACROSS PEOPLE (the existing claim_turns table): the longest-waiting
--    people are served first, p_per_user each (more each when fewer people wait), so one person's 500-item batch never
--    starves anyone. FOR UPDATE SKIP LOCKED: two workers never get the same person's turn or the same row.
--    Workers are stateless: nothing is remembered on a VM; any number of VMs can claim at once.
--  - career_apply_vm_heartbeat / _resume / _complete / _reap: the lease, the one kept resume, the honest outcome, the dead-worker
--    sweep. A row is marked 'submitting' BEFORE the Submit click (the heartbeat that records it also re-checks the kill switch
--    and that the account is still current). Retry is allowed only while the row is still 'preparing': a worker that dies
--    before the click puts the row back (at most 2 times); a worker that dies after it leaves 'unknown_outcome', never re-sent.
--  - career_apply_vm_triage: refuses LinkedIn / Indeed / Handshake outright; an account-gated portal (Workday and kin) is not
--    driven: it is handed to the person as 'needs_user' / 'login_required' (the product never creates accounts or takes a password).
--  - career_apply_vm_handoff_requeue: after the person has signed in themselves on a secure handoff (designed in
--    docs/launch/APPLY-VM-RUNBOOK.md section 9), the item goes back to the queue.
--  - career_apply_status_for / career_apply_my_status: queued / preparing / sending / submitted / confirmed / needs_you / not_sent /
--    unknown, said honestly ('confirmed' only when the employer's own email confirmed it, as the existing trigger enforces).
--  - A role with no table rights (apply_vm_worker) that may run only these functions plus the two host back-off calls.
--
-- Off until the owner turns it on, in this order (docs/launch/APPLY-VM-RUNBOOK.md): APPLY_VM = 'on'; APPLY_VM_USER_IDS = the
-- owner's id (or '*': every person who said yes to cloud sending); APPLY_VM_ALLOW_LOCAL = 'on' only for the dry run on mock forms.
-- No number of ours limits the volume. What slows a portal is that portal refusing (career_apply_host_refused_for).

-- ADDITIVE: the allowed keys are whatever the constraint allows now (read from pg_constraint, so a key an earlier migration added, such as
-- CAREER_CLOUD_TEXT_CARDS, is never lost), plus any key already stored in the table, plus the three VM keys. Idempotent.
do $$
declare def text; keys text[];
begin
 select pg_get_constraintdef(c.oid) into def from pg_constraint c
  where c.conrelid = 'public.career_cloud_settings'::regclass and c.conname = 'career_cloud_settings_key_check';
 select array_agg(distinct k) into keys from (
   select m[1] as k from regexp_matches(coalesce(def, ''), $re$'([A-Za-z0-9_]+)'$re$, 'g') m
   union select key from public.career_cloud_settings
   union select unnest(array['APPLY_VM', 'APPLY_VM_USER_IDS', 'APPLY_VM_ALLOW_LOCAL'])) x;
 alter table public.career_cloud_settings drop constraint if exists career_cloud_settings_key_check;
 execute format('alter table public.career_cloud_settings add constraint career_cloud_settings_key_check check (key in (%s))',
  (select string_agg(quote_literal(k), ', ' order by k) from unnest(keys) k));
end $$;

alter table public.career_apply_jobs add column if not exists vm_worker text;
alter table public.career_apply_jobs add column if not exists vm_heartbeat_at timestamptz;
alter table public.career_apply_jobs add column if not exists vm_phase text;
alter table public.career_apply_jobs add column if not exists vm_requeues integer not null default 0;
alter table public.career_apply_jobs add column if not exists vm_triaged boolean not null default false; -- each queued row is looked at once (refused / sign-in portal / fine)
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_vm_check;
alter table public.career_apply_jobs add constraint career_apply_jobs_vm_check
  check ((vm_phase is null or vm_phase in ('preparing', 'submitting')) and vm_requeues between 0 and 2
    and (vm_worker is null or vm_worker ~ '^[A-Za-z0-9._:-]{1,64}$'));
create index if not exists career_apply_vm_live_idx on public.career_apply_jobs (vm_heartbeat_at) where state = 'driving' and vm_worker is not null;

-- ------------------------------------------------------------------------------------------------ switches
create or replace function public.career_apply_vm_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((select value = 'on' from public.career_cloud_settings where key = 'APPLY_VM'), false)
$$;
-- Who the VM may send for. A list of ids names people the owner enabled directly; '*' is every person who said yes to cloud
-- sending in chat (career_apply_cloud_optin). Missing or unreadable: nobody.
create or replace function public.career_apply_vm_user_ok(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
 select value into v from public.career_cloud_settings where key = 'APPLY_VM_USER_IDS';
 if v is null or p_user is null then return false; end if;
 if btrim(v) = '*' then
  return coalesce((public.career_apply_cloud_optin_get(p_user)->>'enabled')::boolean, false);
 end if;
 return p_user = any (v::uuid[]);
exception when others then return false;
end $$;

-- The portal family of a link. 'refused' is never driven by anything of ours; 'account_gated' needs the person's own sign-in;
-- 'greenhouse' and 'lever' are the forms the VM fills; 'local' is a mock form on the VM itself (dry run only).
create or replace function public.career_apply_vm_family(p_url text) returns text
language sql immutable set search_path = pg_catalog, public as $$
 with h as (select regexp_replace(coalesce(public.career_apply_host(p_url), ''), ':[0-9]+$', '') as bare, public.career_apply_host(p_url) as full)
 select case
  when bare ~ '(^|\.)(linkedin\.com|lnkd\.in|indeed\.com|joinhandshake\.com|handshake\.com)$' then 'refused'
  when "full" in ('boards.greenhouse.io', 'job-boards.greenhouse.io') then 'greenhouse'
  when "full" = 'jobs.lever.co' then 'lever'
  when bare ~ '(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|taleo\.net|successfactors\.com|successfactors\.eu|oraclecloud\.com|ultipro\.com|dayforcehcm\.com|brassring\.com|adp\.com|paycomonline\.net)$' then 'account_gated'
  when bare in ('127.0.0.1', 'localhost') then 'local'
  else 'unsupported' end
 from h
$$;
create or replace function public.career_apply_vm_claimable(p_url text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select case public.career_apply_vm_family(p_url)
  when 'greenhouse' then true when 'lever' then true
  when 'local' then coalesce((select value = 'on' from public.career_cloud_settings where key = 'APPLY_VM_ALLOW_LOCAL'), false)
  else false end
$$;

-- ------------------------------------------------------------------------------------------------ triage
-- Closes what the VM must never drive, so the person is told the truth instead of waiting: 'refused' sites are not sent
-- (not_submitted / site_not_supported); an account-gated portal goes to the person (needs_user / login_required, with the link).
-- career_apply_vm_triage_for does it for given people (the claim calls it for exactly the people it is serving this round, so
-- its cost follows what is handed out, never the size of the whole queue); career_apply_vm_triage does it for everyone (maintenance).
create or replace function public.career_apply_vm_triage_for(p_users uuid[], p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int := 0; b int := 0; now_ timestamptz := clock_timestamp(); lim int := greatest(1, least(coalesce(p_limit, 500), 5000));
begin
 -- Each queued row is looked at once (vm_triaged); a row that is fine is marked and never looked at again.
 with c as (select id, public.career_apply_vm_family(url) as fam from public.career_apply_jobs
   where user_id = any (p_users) and state = 'queued' and attempts = 0 and source is null and not vm_triaged
    -- a queued row whose stored approval is gone / revoked / expired cannot be written by anything (the bridge's queue trigger refuses);
    -- the claim closes it NOT_APPROVED, so one such row never aborts everyone's triage
    and public.career_apply_vm_approval_refusal(career_apply_jobs, now_) is null
   order by created_at limit lim for update skip locked),
 u as (update public.career_apply_jobs j set vm_triaged = true,
   state = case c.fam when 'refused' then 'not_submitted' when 'account_gated' then 'needs_user' else j.state end,
   reason = case c.fam when 'refused' then 'site_not_supported' when 'account_gated' then 'login_required' else j.reason end,
   evidence = case c.fam
    when 'refused' then j.evidence || jsonb_build_object('closed_at', now_, 'closed', 'site_not_supported', 'by', 'vm', 'link', j.url)
    when 'account_gated' then j.evidence || jsonb_build_object('closed_at', now_, 'by', 'vm', 'link', j.url, 'handoff', 'person_signs_in',
      'handed_back', 'this employer needs the person to sign in or verify themselves; nothing was sent')
    else j.evidence end,
   updated_at = case when c.fam in ('refused', 'account_gated') then now_ else j.updated_at end
  from c where j.id = c.id returning c.fam)
 select count(*) filter (where fam = 'refused'), count(*) filter (where fam = 'account_gated') into a, b from u;
 return jsonb_build_object('refused', a, 'handed_back', b);
end $$;
create or replace function public.career_apply_vm_triage(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if not public.career_apply_vm_enabled() then return jsonb_build_object('refused', 0, 'handed_back', 0); end if;
 return public.career_apply_vm_triage_for(array(select t.user_id from public.career_apply_claim_turns t where t.queued and public.career_apply_vm_user_ok(t.user_id)), p_limit);
end $$;

-- ------------------------------------------------------------------------------------------------ approval
-- The one question "is this row approved right now?", answered from the stored approval record and nothing in the payload
-- (review of #279: a hash the enqueuer wrote, or a 64-hex token inside the payload, proves nothing). It is the card-cloud bridge's
-- own career_message_approval_private.cloud_bound_refusal (20261024130000): the row has an immutable binding to an approval that
-- exists, is the same person's, is for this exact payload hash and entry, was used by the tap, is not revoked, is not expired
-- (the approval's 24 hours and the payload's own expires_at), and the person is still eligible. Same predicate the queue trigger
-- applies when a bound row goes to 'driving', so a row this passes can never be refused later by the trigger and abort a batch.
-- No bridge, no approval store: fail closed (nothing is approved), never "approved because nothing says otherwise".
create or replace function public.career_apply_vm_approval_refusal(j public.career_apply_jobs, p_now timestamptz) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare why text;
begin
 if to_regprocedure('career_message_approval_private.cloud_bound_refusal(public.career_apply_jobs,timestamptz,boolean)') is null then return 'NOT_APPROVED'; end if;
 why := career_message_approval_private.cloud_bound_refusal(j, p_now, true);
 return case when why is null then null else 'NOT_APPROVED' end;
end $$;

-- ------------------------------------------------------------------------------------------------ claim
-- p_skip_hosts: hosts this worker is already at its own limit on (so it does not lease what it cannot start).
create or replace function public.career_apply_vm_claim(p_worker text, p_limit integer, p_per_user integer default 1, p_skip_hosts text[] default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare now_ timestamptz := clock_timestamp(); people uuid[]; ids uuid[]; out jsonb; r record; bad uuid[] := '{}';
 per int := greatest(1, coalesce(p_per_user, 1)); lim int := greatest(0, coalesce(p_limit, 0));
begin
 if not public.career_apply_vm_enabled() or lim = 0 or p_worker is null or p_worker !~ '^[A-Za-z0-9._:-]{1,64}$' then return '[]'::jsonb; end if;
 -- The longest-waiting people, locked SKIP LOCKED: two workers never take the same person's turn at once.
 people := array(select t.user_id from public.career_apply_claim_turns t where t.queued and public.career_apply_vm_user_ok(t.user_id)
  order by t.last_claim_at, t.user_id limit (lim + per - 1) / per for update skip locked);
 if cardinality(people) = 0 then return '[]'::jsonb; end if;
 -- Fewer people than the batch: an equal larger share each, so the batch still fills and nobody gets more than anyone else.
 per := greatest(per, ceil(lim::numeric / cardinality(people))::int);
 update public.career_apply_claim_turns set last_claim_at = now_ where user_id = any (people);
 perform public.career_apply_vm_triage_for(people, 500);
 ids := array(select q.id from unnest(people) with ordinality as pp(u, o)
  cross join lateral (select j.id, j.created_at from public.career_apply_jobs j
   where j.user_id = pp.u and j.state = 'queued' and j.attempts = 0
    and (j.source is null or (j.source = 'cloud' and j.vm_worker is null and j.vm_requeues > 0))
    and public.career_apply_vm_claimable(j.url)
    and public.career_apply_current(j.user_id, j.payload)
    and public.career_apply_host(j.url) <> all (coalesce(p_skip_hosts, '{}'))
    and not exists (select from public.career_apply_host_backoff b where b.scope = 'cloud' and b.host = public.career_apply_host(j.url) and b.until > now_)
   order by j.created_at, j.id limit per for update of j skip locked) q
  order by pp.o, q.created_at, q.id limit lim);
 if cardinality(ids) = 0 then return '[]'::jsonb; end if;
 -- The stored-approval check on exactly these: a row with no live approval record bound to this person and this exact payload hash
 -- (missing, wrong hash, revoked, expired, another person's, or enqueued directly) is closed NOT_APPROVED and never handed out.
 for r in select j.id from public.career_apply_jobs j where j.id = any (ids) and public.career_apply_vm_approval_refusal(j, now_) is not null loop
  bad := bad || r.id;
  begin
   update public.career_apply_jobs set state = 'not_submitted', reason = 'NOT_APPROVED',
    evidence = evidence || jsonb_build_object('closed_at', now_, 'closed', 'not_approved', 'by', 'vm', 'nothing_sent', true), updated_at = now_
    where id = r.id and state = 'queued';
  exception when others then null; -- a row the queue trigger will not let us close stays queued, but is never handed out
  end;
 end loop;
 ids := array(select x from unnest(ids) x where x <> all (bad));
 if cardinality(ids) = 0 then return '[]'::jsonb; end if;
 -- The approval re-check on exactly these: a payload that no longer hashes to what was approved, or a posting another
 -- path sent since, is closed as not sent and never handed out.
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: the application changed after it was approved',
  evidence = evidence || jsonb_build_object('closed_at', now_, 'closed', 'approval_changed'), updated_at = now_
  where id = any (ids) and (approval_hash is distinct from payload_hash or payload_hash is distinct from public.career_apply_payload_hash(payload));
 update public.career_apply_jobs q set state = 'not_submitted',
  reason = 'not sent: this exact posting was already sent (recorded after you approved this one)',
  evidence = q.evidence || jsonb_build_object('closed_at', now_, 'closed', 'duplicate_posting'), updated_at = now_
  where q.id = any (ids) and q.state = 'queued' and public.career_apply_posting_sent(q.user_id, q.job_id, q.url, q.id::text, false);
 with got as (
  update public.career_apply_jobs j set state = 'driving', attempts = 1, claimed_at = now_, lease_token = gen_random_uuid(), updated_at = now_,
   source = 'cloud', vm_worker = p_worker, vm_heartbeat_at = now_, vm_phase = 'preparing'
  where j.id = any (ids) and j.state = 'queued' returning j.*)
 select coalesce(jsonb_agg(jsonb_build_object('id', id, 'lease_token', lease_token, 'user_id', user_id, 'job_id', job_id, 'company', company,
   'url', url, 'payload', payload, 'payload_hash', payload_hash, 'approval_hash', approval_hash, 'requeues', vm_requeues,
   'approval_id', (select b.approval_id from career_message_approval_private.cloud_bound_jobs b where b.job_row_id = got.id))), '[]'::jsonb) into out from got;
 return out;
end $$;

-- ------------------------------------------------------------------------------------------------ lease
-- {"ok": true} while this worker still holds the lease. p_phase = 'submitting' is the last step before the Submit click: it also
-- needs the kill switch on and the account still current, and once recorded the row is never put back for a retry.
create or replace function public.career_apply_vm_heartbeat(p_id uuid, p_lease uuid, p_worker text, p_phase text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 if p_phase is not null and p_phase not in ('preparing', 'submitting') then raise exception 'invalid phase'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving' for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'lease_lost'); end if;
 -- Revoked or expired since the claim: stop, whatever the phase (the queue trigger would refuse this write anyway).
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return jsonb_build_object('ok', false, 'why', 'not_approved'); end if;
 if p_phase = 'submitting' and j.vm_phase = 'preparing' then
  if not public.career_apply_vm_enabled() then return jsonb_build_object('ok', false, 'why', 'switch_off'); end if;
  if not public.career_apply_current(j.user_id, j.payload) then return jsonb_build_object('ok', false, 'why', 'account_changed'); end if;
  update public.career_apply_jobs set vm_phase = 'submitting', vm_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_id;
 else
  update public.career_apply_jobs set vm_heartbeat_at = clock_timestamp() where id = p_id;
 end if;
 return jsonb_build_object('ok', true);
end $$;

-- The one resume the job was approved with, for the job this worker holds the lease on.
create or replace function public.career_apply_vm_resume(p_id uuid, p_lease uuid, p_worker text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; r public.career_apply_cloud_resumes;
begin
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving';
 if not found then raise exception 'invalid apply claim'; end if;
 select * into r from public.career_apply_cloud_resumes x where x.user_id = j.user_id and x.sha256 = j.payload->>'resume_sha256'
  and x.privacy_epoch = (j.payload->>'privacy_epoch')::bigint;
 if not found then return null; end if;
 return jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'));
end $$;

-- The outcome. Honest by construction: submitted only after the 'submitting' record; a refusal after that record is 'unknown'.
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

-- Dead workers. Before the click (phase 'preparing'): back to the queue, at most twice, then closed not sent. After it: unknown, never re-sent.
create or replace function public.career_apply_vm_reap(p_stale_seconds integer default 120) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare now_ timestamptz := clock_timestamp(); a int; b int; c int; stale interval := make_interval(secs => greatest(30, coalesce(p_stale_seconds, 120)));
begin
 update public.career_apply_jobs set state = 'unknown_outcome', reason = 'application outcome unknown: the worker stopped after Submit was pressed; not retried',
  evidence = evidence || jsonb_build_object('reaped_at', now_, 'by', 'vm'), updated_at = now_
  where state = 'driving' and vm_worker is not null and vm_phase = 'submitting' and vm_heartbeat_at < now_ - stale;
 get diagnostics a = row_count;
 update public.career_apply_jobs j set state = 'queued', attempts = 0, lease_token = null, claimed_at = null, vm_worker = null, vm_heartbeat_at = null,
  vm_phase = null, vm_requeues = vm_requeues + 1, updated_at = now_
  where state = 'driving' and vm_worker is not null and vm_phase = 'preparing' and vm_heartbeat_at < now_ - stale and vm_requeues < 2
   and public.career_apply_vm_approval_refusal(j, now_) is null; -- an approval gone since the claim is not put back in the queue
 get diagnostics b = row_count;
 update public.career_apply_jobs j set state = 'not_submitted',
  reason = case when vm_requeues >= 2 then 'worker_lost_before_submit' else 'NOT_APPROVED' end,
  evidence = evidence || jsonb_build_object('reaped_at', now_, 'by', 'vm', 'nothing_sent', true), updated_at = now_
  where state = 'driving' and vm_worker is not null and vm_phase = 'preparing' and vm_heartbeat_at < now_ - stale
   and (vm_requeues >= 2 or public.career_apply_vm_approval_refusal(j, now_) is not null);
 get diagnostics c = row_count;
 return jsonb_build_object('unknown', a, 'requeued', b, 'closed_not_sent', c);
end $$;

-- After the person has signed in themselves (the handoff), the item is driven again. Only an item the VM handed back for a sign-in.
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

-- ------------------------------------------------------------------------------------------------ status
create or replace function public.career_apply_vm_status_of(j public.career_apply_jobs) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('id', j.id, 'job_id', j.job_id, 'company', j.company, 'url', j.url, 'since', j.updated_at,
  'status', case j.state
   when 'queued' then 'queued'
   when 'driving' then case when j.vm_phase = 'submitting' then 'sending' else 'preparing' end
   when 'submitted_unconfirmed' then 'submitted'
   when 'confirmed' then 'confirmed'
   when 'needs_user' then 'needs_you'
   when 'unknown_outcome' then 'unknown'
   else 'not_sent' end,
  'detail', case
   when j.state = 'queued' then case when not public.career_apply_vm_enabled() or not public.career_apply_vm_user_ok(j.user_id) then 'waiting_for_sender'
     when not public.career_apply_vm_claimable(j.url) then 'site_not_supported_yet' else 'waiting_in_line' end
   when j.state in ('needs_user', 'not_submitted', 'failed', 'unknown_outcome') then coalesce(j.reason, j.state)
   when j.state = 'submitted_unconfirmed' then 'employer_page_showed_confirmation_email_not_seen_yet'
   when j.state = 'confirmed' then 'employer_email_confirmed'
   else null end,
  'link', case when j.state = 'needs_user' then j.url end,
  'proof', case when j.state in ('submitted_unconfirmed', 'confirmed') then jsonb_build_object('confirmation_id', j.confirmation_id,
     'screenshot_sha256', j.evidence#>>'{proof,after_sha256}', 'finished_at', j.evidence->>'finished_at') end)
$$;
create or replace function public.career_apply_status_for(p_user uuid, p_job_id text default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(public.career_apply_vm_status_of(j) order by j.updated_at desc), '[]'::jsonb)
 from (select * from public.career_apply_jobs where user_id = p_user and (p_job_id is null or job_id = p_job_id) order by updated_at desc limit 200) j
$$;
create or replace function public.career_apply_my_status(p_job_id text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
 if auth.uid() is null then raise exception 'not signed in'; end if;
 return public.career_apply_status_for(auth.uid(), p_job_id);
end $$;

-- ------------------------------------------------------------------------------------------------ least privilege
do $$ begin
 if not exists (select from pg_roles where rolname = 'apply_vm_worker') then create role apply_vm_worker nologin noinherit; end if;
 if exists (select from pg_roles where rolname = 'authenticator') then grant apply_vm_worker to authenticator; end if;
end $$;
grant usage on schema public to apply_vm_worker;
revoke all on function public.career_apply_vm_approval_refusal(public.career_apply_jobs, timestamptz), public.career_apply_vm_enabled(), public.career_apply_vm_user_ok(uuid), public.career_apply_vm_family(text), public.career_apply_vm_claimable(text),
 public.career_apply_vm_triage(integer), public.career_apply_vm_triage_for(uuid[], integer), public.career_apply_vm_claim(text, integer, integer, text[]), public.career_apply_vm_heartbeat(uuid, uuid, text, text),
 public.career_apply_vm_resume(uuid, uuid, text), public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb), public.career_apply_vm_reap(integer),
 public.career_apply_vm_handoff_requeue(uuid, text), public.career_apply_vm_status_of(public.career_apply_jobs), public.career_apply_status_for(uuid, text),
 public.career_apply_my_status(text) from public, anon, authenticated;
grant execute on function public.career_apply_vm_triage(integer), public.career_apply_vm_claim(text, integer, integer, text[]),
 public.career_apply_vm_heartbeat(uuid, uuid, text, text), public.career_apply_vm_resume(uuid, uuid, text),
 public.career_apply_vm_complete(uuid, uuid, text, text, text, jsonb), public.career_apply_vm_reap(integer) to apply_vm_worker, service_role;
grant execute on function public.career_apply_host_refused_for(uuid, uuid, text, integer, timestamptz), public.career_apply_host_ok_for(uuid, uuid, timestamptz) to apply_vm_worker;
grant execute on function public.career_apply_vm_enabled(), public.career_apply_vm_user_ok(uuid), public.career_apply_vm_family(text), public.career_apply_vm_claimable(text),
 public.career_apply_vm_handoff_requeue(uuid, text), public.career_apply_vm_status_of(public.career_apply_jobs), public.career_apply_status_for(uuid, text) to service_role;
grant execute on function public.career_apply_my_status(text) to authenticated, service_role;

-- ------------------------------------------------------------------------------------------------ a scale fix found by the load test
-- career_apply_jobs_confirmation (20261025100000) looked for another employer's identical confirmation id with
-- `career_apply_confirmation_key(confirmation_id) = k`, which cannot use the partial index (WHERE confirmation_id IS NOT NULL) because
-- the query never says so: every confirmation write scanned the whole queue (190 ms at 20,000 rows, growing with the table). The rule is
-- unchanged; the query now states `confirmation_id is not null` so the existing index serves it, and the reports table gets the same index.
create index if not exists extension_submission_reports_confirmation_key on public.extension_submission_reports (public.career_apply_confirmation_key(confirmation_id)) where confirmation_id is not null;
create or replace function public.career_apply_jobs_confirmation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := public.career_apply_confirmation_key(new.confirmation_id); co text := public.career_apply_company_key(new.company);
begin
 if k is null or (tg_op = 'UPDATE' and new.confirmation_id is not distinct from old.confirmation_id) then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('career_apply_confirmation:' || k, 0));
 if exists (select from public.career_apply_jobs x where x.confirmation_id is not null and x.id <> new.id and public.career_apply_confirmation_key(x.confirmation_id) = k
     and public.career_apply_company_key(x.company) <> co)
  or exists (select from public.extension_submission_reports r where r.confirmation_id is not null and public.career_apply_confirmation_key(r.confirmation_id) = k
     and public.career_apply_company_key(r.employer) <> co) then
  new.evidence := coalesce(new.evidence, '{}'::jsonb) || jsonb_build_object('confirmation_id_conflict', new.confirmation_id);
  new.confirmation_id := null;
 end if;
 return new;
end $$;
revoke all on function public.career_apply_jobs_confirmation() from public, anon, authenticated; -- a trigger function: the trigger runs it, nobody calls it
