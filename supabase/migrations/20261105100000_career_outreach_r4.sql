-- OUTREACH R4 (2026-11-05, tests/architect/flow-scenarios-outreach-r4.test.ts, tests/db/career_outreach_r4.test.sql): the
-- older outreach claim (career_outreach_claim, the scheduled run's one-at-a-time sender, career-proactive with
-- CAREER_OUTREACH_SEND) and the sending rail (career_send_*, career-send with CAREER_SEND_RAIL) are both served ON, and both
-- picked up the same approved draft: the chat's approval queues it on the rail while the draft stays 'approved', which is
-- exactly what the older run reads. Whichever claimed first sent it, so:
--   1. A draft the rail had queued could leave through the older run instead: without the rail's checks (List-Unsubscribe,
--      the bounce list, the Sent check before a retry), and the rail then refused its own copy as "changed after you
--      approved it", which the person was told.
--   2. A rail send that Gmail answered with a 5xx (it may have gone) hands the draft back as 'approved' for the retry;
--      the older run then sent it again: two emails to one contact.
--   3. The older claim read only the do-not-contact list: an address that bounced for anyone (career_send_bad_addresses)
--      was still sent to by it.
--   4. That 5xx retry (a try Gmail may have taken) also re-opened the draft to the person: "edit 1", "redo 1" or "cancel 1"
--      changed or withdrew it, the rail then refused or cancelled its copy without looking in Sent, and the draft said
--      "not sent" (or a new version went as a second email) while the first was in the contact's inbox.
-- career_outreach_claim is redefined exactly as 20261027200000 left it except: a draft the rail has (any career_send_queue
-- row of it) is 'on_rail' and left alone, and a bounced address is 'bad_address'. The older run still sends what never
-- reached the rail (approved before Gmail could send). career_send_complete_one is redefined exactly as 20261031020000 left
-- it except (4): a tried retry keeps its draft 'sending' (result 'send_rail', as the claim leaves it and as a worker that died
-- leaves it), so it changes only once the next try has looked in Sent. Service role only (each revoked from public, anon
-- and authenticated, as before). Idempotent.
create or replace function public.career_outreach_claim(p_user uuid, p_draft uuid, p_hash text, p_now timestamptz, p_day_start timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.career_outreach_drafts;
begin
  if p_user is null or p_draft is null or p_hash is null or p_now is null then raise exception 'invalid outreach claim'; end if;
  perform pg_advisory_xact_lock(hashtextextended('career_outreach:' || p_user::text, 0));
  select * into d from public.career_outreach_drafts where id = p_draft and user_id = p_user for update;
  if not found or d.status <> 'approved' or d.approved_hash is null then return 'not_approved'; end if;
  -- (1, 2) The rail has this draft: it is its one sender. Read by the person and the address (career_send_queue_user_to).
  if exists (select 1 from public.career_send_queue q where q.user_id = p_user and q.recipient_email = lower(btrim(d.recipient_email))
             and q.kind = 'outreach' and q.source_id = d.id) then return 'on_rail'; end if;
  if d.approved_hash <> p_hash or d.hash <> p_hash then return 'changed'; end if;
  if greatest(d.approved_at, d.created_at) < p_now - interval '7 days' then return 'expired'; end if;
  if public.career_user_quiet(p_user) then return 'paused'; end if;
  if exists (select 1 from public.career_outreach_dnc
    where email_hash = encode(sha256(convert_to(lower(d.recipient_email), 'UTF8')), 'hex')) then return 'do_not_contact'; end if;
  -- (3) Bounced for anyone: never emailed again, by either sender.
  if exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(d.recipient_email)) then return 'bad_address'; end if;
  update public.career_outreach_drafts set status = 'sending', sent_at = p_now, updated_at = now() where id = d.id;
  return 'ok';
end $$;
revoke all on function public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. a tried retry stays the rail's
create or replace function public.career_send_complete_one(w text, p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.career_send_queue; o text := p->>'outcome'; a public.career_send_accounts;
  detail text := left(coalesce(p->>'detail', ''), 300); waiting int;
begin
  select * into q from public.career_send_queue where id = (p->>'id')::uuid for update;
  if not found then return 'stale'; end if;
  -- (3) The mailbox was disconnected while this worker held the email: it was cancelled with everything else (and the
  -- worker's career_send_go said stop). If the worker had already handed it to the provider, it went: that is recorded,
  -- the truth. Any other outcome only ends the hold; it is never queued again.
  if q.state = 'cancelled' and q.lease_owner is not distinct from w and q.result in ('gmail disconnected', 'outlook disconnected', 'stopped by you') then
    if o in ('sent', 'already_sent') and coalesce(p->>'gmail_id', '') <> '' then
      update public.career_send_queue set state = 'sent', sent_at = coalesce(sent_at, now()), gmail_id = p->>'gmail_id', gmail_thread = nullif(p->>'thread_id', ''),
        lease_owner = null, lease_until = null, result = 'sent before ' || q.result, updated_at = now()
      where id = q.id;
      if q.kind = 'outreach' then
        update public.career_outreach_drafts set status = 'sent', sent_at = now(), gmail_id = p->>'gmail_id', gmail_thread = nullif(p->>'thread_id', ''), result = 'sent', updated_at = now()
        where id = q.source_id and user_id = q.user_id;
      end if;
      return 'sent';
    end if;
    update public.career_send_queue set lease_owner = null, lease_until = null, updated_at = now() where id = q.id;
    return 'cancelled';
  end if;
  if q.state <> 'sending' or q.lease_owner is distinct from w then return 'stale'; end if;
  -- (5) Not sent: its approval lapsed while it was being retried (the worker found no earlier try in Sent).
  if o = 'lapsed' then
    update public.career_send_queue set state = 'cancelled', result = 'approval lapsed (more than 7 days)', lease_owner = null, lease_until = null, updated_at = now() where id = q.id;
    if q.kind = 'outreach' then
      update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = 'expired', updated_at = now()
      where id = q.source_id and user_id = q.user_id and status = 'sending';
    end if;
    update public.career_send_accounts set has_work = exists (select 1 from public.career_send_queue x where x.user_id = q.user_id and x.provider = q.provider and x.state = 'queued'), updated_at = now()
    where user_id = q.user_id and provider = q.provider;
    return 'cancelled';
  end if;
  select * into a from public.career_send_accounts where user_id = q.user_id and provider = q.provider;
  if o in ('sent', 'already_sent') then
    if coalesce(p->>'gmail_id', '') = '' then raise exception 'a sent email needs its Gmail id'; end if;
    update public.career_send_queue set state = 'sent', sent_at = coalesce(sent_at, now()), gmail_id = p->>'gmail_id', gmail_thread = nullif(p->>'thread_id', ''),
      lease_owner = null, lease_until = null, result = case when o = 'already_sent' then 'found in Sent after an interrupted try' else 'sent' end, updated_at = now()
    where id = q.id;
    if q.kind = 'outreach' then
      update public.career_outreach_drafts set status = 'sent', sent_at = now(), gmail_id = p->>'gmail_id', gmail_thread = nullif(p->>'thread_id', ''), result = 'sent', updated_at = now()
      where id = q.source_id and user_id = q.user_id;
    end if;
    update public.career_send_accounts set strikes = 0, reason = null, updated_at = now() where user_id = q.user_id and provider = q.provider and strikes > 0;
    return 'sent';
  end if;
  if o in ('retry', 'quota', 'reconnect', 'policy') then
    -- Gmail was disconnected while this one was in flight: it is cancelled with the rest, never queued again.
    if a.state = 'disconnected' or not exists (select 1 from public.user_oauth_connections c where c.user_id = q.user_id and c.provider = public.career_send_connection(q.provider)) then
      update public.career_send_queue set state = 'cancelled', result = 'gmail disconnected', lease_owner = null, lease_until = null, updated_at = now() where id = q.id;
      if q.kind = 'outreach' then update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = 'gmail disconnected', updated_at = now() where id = q.source_id and user_id = q.user_id and status = 'sending'; end if;
      return 'cancelled';
    end if;
    -- untried: Gmail never got it (a refusal, or handed back unsent), so the attempt does not count and no Sent check is due.
    update public.career_send_queue set state = 'queued', lease_owner = null, lease_until = null, updated_at = now(), result = left(o || ': ' || detail, 300),
      attempts = case when coalesce((p->>'untried')::boolean, false) then greatest(attempts - 1, 0) else attempts end,
      first_claimed_at = case when coalesce((p->>'untried')::boolean, false) and attempts <= 1 then null else first_claimed_at end,
      next_at = case o when 'retry' then coalesce((p->>'retry_at')::timestamptz, now()) when 'quota' then coalesce((p->>'resume_at')::timestamptz, now()) else next_at end
    where id = q.id;
    -- OUTREACH R4 (4): tried (Gmail may have it: a 5xx, a break, a timeout) the draft stays 'sending' for the rail, as when a
    -- worker dies: never 'approved' again, so neither an edit, a redo or a cancel nor the older claim can act on an email
    -- that may already be in the contact's inbox before the next try has looked in Sent. Untried: 'approved' as before.
    if q.kind = 'outreach' then
      update public.career_outreach_drafts set updated_at = now(),
        status = case when coalesce((p->>'untried')::boolean, false) then 'approved' else 'sending' end,
        result = case when coalesce((p->>'untried')::boolean, false) then 'queued' else 'send_rail' end
      where id = q.source_id and user_id = q.user_id and status = 'sending';
    end if;
    update public.career_send_accounts set has_work = true, updated_at = now() where user_id = q.user_id and provider = q.provider;
    select count(*) into waiting from public.career_send_queue where user_id = q.user_id and provider = q.provider and state in ('queued', 'sending');
    if o = 'quota' then
      update public.career_send_accounts set state = 'backoff', resume_at = greatest(coalesce(resume_at, '-infinity'), coalesce((p->>'resume_at')::timestamptz, now())),
        strikes = strikes + 1, reason = left('Gmail limit: ' || detail, 300), updated_at = now()
      where user_id = q.user_id and provider = q.provider returning * into a;
      perform public.career_send_notice(q.user_id, 'send-paused:' || q.user_id || ':' || to_char(a.resume_at at time zone 'UTC', 'YYYYMMDDHH24'),
        'Gmail has paused sending from your account for now: it limits how much one account can send. ' || waiting ||
        ' approved email' || case when waiting = 1 then ' is' else 's are' end || ' waiting, and Trainee carries on automatically when Gmail allows (around ' ||
        to_char(a.resume_at at time zone 'UTC', 'Mon DD, HH24:MI') || ' UTC). Nothing is lost and nothing is sent twice.');
    elsif o = 'policy' then
      update public.career_send_accounts set state = 'paused', reason = left('Gmail refused as spam or policy: ' || detail, 300), updated_at = now()
      where user_id = q.user_id and provider = q.provider;
      perform public.career_send_notice(q.user_id, 'send-policy:' || q.user_id || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24'),
        'Trainee paused sending from your Gmail: Google refused an email as possible spam or against its sending policy. ' || waiting ||
        ' approved email' || case when waiting = 1 then ' is' else 's are' end || ' waiting and nothing more goes until you say "resume sending". Sending more right now could hurt your account''s standing.');
    elsif o = 'reconnect' then
      update public.career_send_accounts set state = 'needs_reconnect', reason = left(detail, 300), updated_at = now()
      where user_id = q.user_id and provider = q.provider;
      perform public.career_send_notice(q.user_id, 'send-reconnect:' || q.user_id || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDD'),
        'Trainee couldn''t send from your Gmail: Google says the connection no longer allows it. Say "connect gmail" to reconnect. ' || waiting ||
        ' approved email' || case when waiting = 1 then ' waits' else 's wait' end || ' and go out once you do.');
    end if;
    return o;
  end if;
  if o in ('refused', 'failed') then
    update public.career_send_queue set state = o, result = left(detail, 300), lease_owner = null, lease_until = null, updated_at = now() where id = q.id;
    if q.kind = 'outreach' then
      update public.career_outreach_drafts set status = case when o = 'refused' then 'shown' else 'failed' end,
        approved_hash = null, approved_at = null, result = left(o || ': ' || detail, 200), updated_at = now()
      where id = q.source_id and user_id = q.user_id and status = 'sending';
    end if;
    return o;
  end if;
  raise exception 'unknown send outcome %', o;
end $$;
revoke all on function public.career_send_complete_one(text, jsonb) from public, anon, authenticated;
grant execute on function public.career_send_complete_one(text, jsonb) to service_role;
