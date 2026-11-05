-- Apply and mass submission, round 4 (2026-11-05: tests/architect/scenarios-apply-r4*.test.ts, a seeded battery on the pure
-- submit-path code, and tests/architect/flow-scenarios-apply-r4.test.ts, sampled runs through the real dispatcher, bridge and
-- this database). Real employer submission is on (D-041), so what the last checks before a Submit miss now reaches employers.
-- Found, on the routes the cloud runner and the apply VM take:
--   1. The text-card route (career_apply_cloud_text_refusal, the claim and the authorization before the engine and before the
--      one Submit) never asked whether this exact posting was already sent another way after the person's yes: the person
--      applied themselves (the extension's report), or another path sent it (career_apply_posting_sent, the one ledger every
--      other claim and the card-cloud authorization read). It was claimed and sent a second time.
--   2. The text-card claim (career_apply_cloud_text_claim_at) looked at the first 24 candidates only (each person's oldest
--      first) and stopped when none of them could go. People who wait (paused, stopped for a while, at the dispatcher's
--      per-person number or their own pace) or whose oldest row is refused for good held those 24 places, so nobody else's
--      approved application was ever claimed on that ATS family: one pause per person among 24 people stopped every other
--      person's sends. A posting already sent another way stayed queued for ever ("approved, not sent yet").
--   3. The apply VM's last check before the Submit click (career_apply_vm_heartbeat 'submitting') did not look at the
--      posting (closed by the employer since the claim, or already sent another way since the claim) nor at the person's
--      own yes to cloud sending (withdrawn since the claim), and a second 'submitting' (a retried attempt) skipped every check.
-- Fixed here, without loosening anything:
--   career_apply_cloud_text_refusal: 'duplicate_job' when this exact posting was sent (or may have been) by any path since;
--     'resume_gone' when the person no longer has a confirmed resume on file (career_resume_ok, the claim's own rule).
--   career_apply_cloud_text_claim_at: a posting already sent another way is ended as not sent, in the words the other claims
--     use; people who wait for a person-level reason (paused, a person pause, at their daily number) are not candidates; and
--     the candidates are read page by page (each person's oldest first, as before, at most 20 pages of 24 per call) until
--     the claim is full, so rows that cannot go now never hold anybody else's place.
--   career_apply_vm_heartbeat: every 'submitting' (the first and any repeat) re-checks the switch, the account, the person's
--     yes to cloud sending, a closed posting and a posting already sent another way, before the click.
-- Service role only; nothing here is granted to a person. Idempotent: applies cleanly twice.

-- ------------------------------------------------------------------------------------------- 1. the text-card refusal
create or replace function public.career_apply_cloud_text_refusal(j public.career_apply_jobs, p_now timestamptz, p_phase text,
 p_per_person_day integer default null, p_per_site_minute integer default null) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare fam text := public.career_apply_portal(j.url); v_host text := public.career_apply_url_host(j.url); card jsonb;
 o public.career_apply_cloud_optin; a jsonb; co text := public.career_apply_company_key(j.company);
 went text[] := array['driving', 'confirmed', 'submitted_unconfirmed', 'needs_user', 'unknown_outcome']; cap integer;
begin
 if p_now is null or p_phase is null or p_phase not in ('claim', 'authorize') then return 'invalid'; end if;
 -- The owner's kill switch (CAREER_AGENT_SUBMIT), the cloud's (CAREER_CLOUD_APPLY) and this route's (CAREER_CLOUD_TEXT_CARDS):
 -- all three, as every other cloud route requires the first two.
 if not public.career_apply_agent_submit_enabled() then return 'cloud_switches_off'; end if;
 if not public.career_apply_cloud_enabled() or not public.career_apply_cloud_text_cards_enabled() then return 'cloud_switches_off'; end if;
 if p_phase = 'claim' and (j.state <> 'queued' or j.attempts <> 0 or j.source is not null) then return 'not_approved'; end if;
 if p_phase = 'authorize' and (j.state <> 'driving' or j.source is distinct from 'cloud' or j.attempts <> 1
  or not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id and t.user_id = j.user_id)) then
  return 'not_approved'; end if;
 if j.approval_hash is distinct from j.payload_hash or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload)
  or coalesce(j.payload->>'engine_approval', '') !~ '^[0-9a-f]{64}$' or j.payload->>'user_id' is distinct from j.user_id::text
  or j.payload->>'url' is distinct from j.url or j.payload->>'company' is distinct from j.company
  or j.payload->>'job_id' is distinct from j.job_id then return 'not_approved'; end if;
 if exists (select from public.career_postings p where p.job_id = j.job_id and p.closed_at is not null) then return 'posting_closed'; end if;
 -- 2026-11-05: this exact posting, sent (or maybe sent) by any path since the yes: the person's own extension, another queue
 -- row under the same link, a batch ledger. Never a second application to it (D-MS-3: only the exact posting).
 if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then return 'duplicate_job'; end if;
 if public.career_apply_cloud_card_bound(j.id) then return 'card_cloud_route'; end if;
 card := public.career_apply_cloud_text_card_of(j);
 if card is null then return 'not_card_approved'; end if;
 if (card->>'answered_at')::timestamptz <= p_now - interval '24 hours' then return 'approval_expired'; end if;
 if p_phase = 'authorize' and not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id
  and t.card_id = (card->>'card_id')::uuid and t.item_n = (card->>'n')::int) then return 'not_approved'; end if;
 if public.career_apply_current(j.user_id, j.payload) is distinct from true then return 'stale'; end if;
 if fam is null or fam not in ('greenhouse', 'lever', 'ashby') then return 'portal_not_cloud'; end if;
 if not public.career_apply_cloud_destination_ok(j.payload->>'destination') then return 'person_submits'; end if;
 if not public.career_apply_cloud_open(fam) then
  if p_phase = 'claim' and public.career_apply_cloud_waiver_left(j.user_id, fam, p_now) <= 0 then return 'gate_closed'; end if;
  -- At the authorization this job already counts against its waiver: it may go while the count, it included, is within.
  if p_phase = 'authorize' and not exists (select from public.career_apply_cloud_gate_waivers w where w.user_id = j.user_id
   and w.portal = fam and w.revoked_at is null and w.created_at <= j.claimed_at and w.expires_at > p_now
   and (select count(*) from public.career_apply_jobs x where x.user_id = j.user_id and x.source = 'cloud' and x.attempts > 0
    and x.claimed_at >= w.created_at and public.career_apply_portal(x.url) = fam) <= w.max_sends) then return 'gate_closed'; end if;
 end if;
 select * into o from public.career_apply_cloud_optin where user_id = j.user_id;
 select value into a from public.career_watch_kv where user_id = j.user_id and key = 'career:account';
 if o.user_id is null or not o.enabled or o.privacy_epoch is distinct from coalesce((a->>'epoch')::bigint, 0) then return 'not_opted_in'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'portal' and portal = fam and until > p_now) then return 'portal_paused'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'person' and user_id = j.user_id and until > p_now) then return 'person_paused'; end if;
 -- Only a number someone chose: the person's own pace as it is now (career_apply_daily_limit, CAPS-1390) and the
 -- dispatcher's, if it was given one. least() skips nulls; with neither, there is no daily number (NO LIMITS). No employer
 -- cooldown (D-MS-3).
 cap := least(public.career_apply_daily_limit(j.user_id), p_per_person_day);
 if cap is not null and (select count(*) from public.career_apply_jobs x where x.user_id = j.user_id and x.id <> j.id and x.state = any(went)
  and x.claimed_at > p_now - interval '1 day') >= cap then return 'daily_limit'; end if;
 if p_phase = 'claim' and p_per_site_minute is not null and (select count(*) from public.career_apply_cloud_text_claims t
  where t.host = v_host and t.claimed_at > p_now - interval '1 minute') >= p_per_site_minute then return 'site_rate'; end if;
 if not exists (select from public.career_apply_cloud_resumes r where r.user_id = j.user_id and r.sha256 = j.payload->>'resume_sha256'
  and r.privacy_epoch = (j.payload->>'privacy_epoch')::bigint and encode(sha256(r.bytes), 'hex') = r.sha256) then
  return 'resume_not_in_cloud'; end if;
 -- 2026-11-05: still a confirmed resume on file and this one stored for the person (the queue's own rule, career_resume_ok,
 -- which the claim's career_apply_close_unsendable reads): withdrawn between the claim and the Submit, nothing is sent.
 if to_regprocedure('public.career_resume_ok(uuid,jsonb)') is not null and not public.career_resume_ok(j.user_id, j.payload) then
  return 'resume_gone'; end if;
 return null;
end $$;
revoke all on function public.career_apply_cloud_text_refusal(public.career_apply_jobs, timestamptz, text, integer, integer) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------- 2. the text-card claim
-- At most p_limit (1..6), each person's oldest first, each job claimed once (attempts = 1, source = 'cloud'), with its
-- marker. Candidates are read page by page (each page each person's oldest not yet looked at, 24 at a time, at most 20 pages)
-- until the claim is full, so rows that cannot go now never hold another person's place; people waiting for a person-level
-- reason are not candidates at all. Each page's people are locked in user id order (as every claim).
create or replace function public.career_apply_cloud_text_claim_at(p_limit integer, p_now timestamptz, p_portal text,
 p_per_person_day integer default null, p_per_site_minute integer default null) returns setof public.career_apply_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids uuid[]; users uuid[]; u uuid; c uuid; j public.career_apply_jobs; card jsonb; got int := 0; pg int := 0;
 lim int := greatest(0, least(6, coalesce(p_limit, 0))); seen uuid[] := '{}'; waiting uuid[];
 went text[] := array['driving', 'confirmed', 'submitted_unconfirmed', 'needs_user', 'unknown_outcome'];
begin
 if p_now is null or lim = 0 or p_portal is null or p_portal not in ('greenhouse', 'lever', 'ashby')
  or not public.career_apply_agent_submit_enabled()
  or not public.career_apply_cloud_enabled() or not public.career_apply_cloud_text_cards_enabled() then return; end if;
 -- Who waits now, whatever their row: paused (the account, or a person pause), or at their daily number (their own pace or
 -- the dispatcher's). career_apply_cloud_text_refusal still decides every row; this only keeps them from holding places.
 waiting := array(
  select q.user_id from (select distinct x.user_id from public.career_apply_jobs x where x.state = 'queued' and x.attempts = 0 and x.source is null
    and public.career_apply_portal(x.url) = p_portal) q
  where coalesce((select a.value->>'paused' from public.career_watch_kv a where a.user_id = q.user_id and a.key = 'career:account'), 'false') <> 'false'
   or exists (select from public.career_apply_cloud_pauses s where s.scope = 'person' and s.user_id = q.user_id and s.until > p_now)
   or (least(public.career_apply_daily_limit(q.user_id), p_per_person_day) is not null
    and (select count(*) from public.career_apply_jobs y where y.user_id = q.user_id and y.state = any(went) and y.claimed_at > p_now - interval '1 day')
     >= least(public.career_apply_daily_limit(q.user_id), p_per_person_day)));
 while got < lim and pg < 20 loop
  pg := pg + 1;
  ids := array(select x.id from (select q.id, q.created_at, row_number() over (partition by q.user_id order by q.created_at, q.id) rn
    from public.career_apply_jobs q join public.career_apply_cloud_optin o on o.user_id = q.user_id and o.enabled
    where q.state = 'queued' and q.attempts = 0 and q.source is null and q.approval_hash = q.payload_hash
     and public.career_apply_portal(q.url) = p_portal
     and (q.not_before is null or date_trunc('milliseconds', q.not_before) <= p_now)
     and q.user_id <> all (waiting) and q.id <> all (seen)) x order by x.rn, x.created_at, x.id limit lim * 4);
  exit when cardinality(ids) = 0;
  seen := seen || ids;
  users := array(select distinct user_id from public.career_apply_jobs where id = any(ids) order by user_id);
  foreach u in array users loop perform pg_advisory_xact_lock(hashtextextended(u::text, 0)); end loop;
  foreach c in array ids loop
   exit when got >= lim;
   select * into j from public.career_apply_jobs where id = c and state = 'queued' for update skip locked;
   continue when not found;
   continue when public.career_apply_close_unsendable(array[j.id], p_now) > 0;
   -- This exact posting was sent another way since the yes: ended as not sent, in the words every other claim uses.
   if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then
    begin
     update public.career_apply_jobs set state = 'not_submitted',
      reason = 'not sent: this exact posting was already sent (recorded after you approved this one)',
      evidence = evidence || jsonb_build_object('closed_at', p_now, 'closed', 'duplicate_posting', 'nothing_sent', true), updated_at = p_now
      where id = j.id and state = 'queued';
    exception when others then
     raise warning 'career_apply_cloud_text_claim_at: % (%)', sqlerrm, j.id;
    end;
    continue;
   end if;
   continue when public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', p_per_person_day, p_per_site_minute) is not null;
   card := public.career_apply_cloud_text_card_of(j);
   update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = clock_timestamp(), lease_token = gen_random_uuid(),
    updated_at = clock_timestamp(), source = 'cloud' where id = j.id returning * into j;
   continue when j.id is null;
   insert into public.career_apply_cloud_text_claims (job_id, user_id, card_id, item_n, host, claimed_at)
    values (j.id, j.user_id, (card->>'card_id')::uuid, (card->>'n')::int, public.career_apply_url_host(j.url), j.claimed_at);
   got := got + 1;
   return next j;
  end loop;
 end loop;
end $$;
revoke all on function public.career_apply_cloud_text_claim_at(integer, timestamptz, text, integer, integer) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------- 3. the apply VM, before the click
-- {"ok": true} while this worker still holds the lease. p_phase = 'submitting' is the last step before the Submit click: every
-- time it is asked (a retried attempt asks again) it needs the switch on, the account current, the person's yes to cloud
-- sending, the posting open and not already sent another way; the first one records the phase, after which the row is never
-- put back for a retry.
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
 if exists (select from pg_roles where rolname = 'service_role') then
  grant execute on function public.career_apply_vm_heartbeat(uuid, uuid, text, text) to service_role;
 end if;
end $$;
