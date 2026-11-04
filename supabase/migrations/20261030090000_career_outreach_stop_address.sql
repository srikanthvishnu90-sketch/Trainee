-- NETWORKING R2 (2026-10-30, tests/architect/scenarios-networking-r2.test.ts and flow-scenarios-networking-r2.test.ts):
-- people discovery, drafts, sending, replies and follow-ups at scale found two things the database had no answer for.
--   1. career_send_stop_address (new): the person's own "stop emailing maya@acme.com" (career_outreach_replies.ts
--      stopTurn). Before, nothing answered it: only "cancel N" took back one draft, so emails already queued on the rail,
--      approved drafts and follow-ups to that address still went. Now, in one transaction, every email of THIS person's to
--      that address that has not gone is stopped:
--        - the rail's rows still queued, or held by a worker that has not handed them to the mailbox yet (career_send_go
--          then answers 'stop', as it does after a disconnect), are cancelled ('stopped by you');
--        - outreach drafts shown or approved (and one claimed by the rail whose row was just cancelled) are skipped;
--        - follow-ups and scheduling replies shown, approved or claimed in the replies lane are cancelled;
--        - the conversation's follow-ups are turned off, so none is drafted to them again.
--      A worker holding one keeps its hold: if it had already handed the email to Gmail, the send is recorded as sent (the
--      truth; career_send_complete_one, below, reads 'stopped by you' as it reads a disconnect), and nothing else goes.
--      It returns the counts the reply says, and how many emails to them already went (never "unsent"). It touches no one
--      else's emails and puts the address on no do-not-contact list (the person's choice about their own email).
--      career_outreach_addresses_named (new) finds the address when the person names them ("stop emailing Maya Chen"), in
--      their conversations and in drafts not sent yet.
--   2. career_provider_candidates gains `blocked`: an address someone opted out of (career_outreach_dnc, anyone's) or that
--      bounced (career_send_bad_addresses, career_email_bad) is not counted or labelled as one "I could use" when people
--      discovery lists them. Before, the list said "N with an address I could use" for someone who had asked every Trainee
--      user to stop (drafting then refused them, so the count was simply wrong).
-- Service role only. Idempotent (create or replace). No volume limit anywhere.

create or replace function public.career_send_stop_address(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid := (p->>'user')::uuid; e text := lower(btrim(coalesce(p->>'email', '')));
  nq int := 0; nd int := 0; na int := 0; nt int := 0; ns int := 0; nds int := 0;
begin
  if u is null or e !~ '^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$' then raise exception 'invalid stop'; end if;
  perform pg_advisory_xact_lock(hashtextextended('career_send_stop:' || u::text || ':' || e, 0));
  -- (1) The rail: queued, or held by a worker that has not been told 'go' yet (career_send_go reads the row FOR SHARE).
  with q as (
    update public.career_send_queue set state = 'cancelled', result = 'stopped by you', updated_at = now()
    where user_id = u and recipient_email = e and state in ('queued', 'sending')
    returning id, kind, source_id
  ), d as (
    -- an outreach draft the rail was holding goes back to skipped with it
    update public.career_outreach_drafts x set status = 'skipped', approved_hash = null, approved_at = null, result = 'stopped by you', updated_at = now()
    from q where q.kind = 'outreach' and x.id = q.source_id and x.user_id = u and x.status in ('approved', 'sending')
    returning x.id
  ), a as (
    -- a replies-lane action the rail was holding is cancelled with it
    update public.career_outreach_actions x set status = 'cancelled', result = 'cancelled: you said stop emailing them', lease_owner = null, lease_until = null, updated_at = now()
    from q where q.kind = 'general' and x.id = q.source_id and x.user_id = u and x.status in ('shown', 'approved', 'running', 'done')
    returning x.id
  )
  select (select count(*) from q), (select count(*) from d) into nq, nds;
  -- (2) Outreach drafts not on the rail yet: shown (waiting for a yes) or approved (waiting to be queued).
  update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = 'stopped by you', updated_at = now()
  where user_id = u and recipient_email = e and status in ('shown', 'approved');
  get diagnostics nd = row_count;
  nd := nd + nds;
  -- (3) The replies lane: follow-ups and scheduling replies waiting for a yes, approved, or claimed and not yet handed over.
  update public.career_outreach_actions x set status = 'cancelled', result = 'cancelled: you said stop emailing them', lease_owner = null, lease_until = null, updated_at = now()
  from public.career_outreach_threads t
  where t.user_id = u and t.recipient_email = e and x.thread_id = t.id and x.kind <> 'calendar_event' and x.status in ('shown', 'approved', 'running');
  get diagnostics na = row_count;
  -- (4) No follow-up is drafted to them again.
  update public.career_outreach_threads set followup_state = case when followup_state = 'done' then 'done' else 'off' end, updated_at = now()
  where user_id = u and recipient_email = e;
  get diagnostics nt = row_count;
  -- What already went (said, never undone): the rail's sends, else the older path's drafts marked sent.
  select greatest(
    (select count(*) from public.career_send_queue where user_id = u and recipient_email = e and state in ('sent', 'replied', 'bounced')),
    (select count(*) from public.career_outreach_drafts where user_id = u and recipient_email = e and status in ('sent', 'replied', 'bounced'))) into ns;
  update public.career_send_accounts x set has_work = exists (select 1 from public.career_send_queue q where q.user_id = x.user_id and q.provider = x.provider and q.state = 'queued'), updated_at = now()
  where x.user_id = u;
  return jsonb_build_object('queued', nq, 'drafts', nd, 'actions', na, 'threads', nt, 'sent', ns);
end $$;
revoke all on function public.career_send_stop_address(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_stop_address(jsonb) to service_role;

-- "stop emailing Maya Chen": the addresses of this person's outreach to someone of that name (or first name), from the
-- conversations the replies lane watches and the drafts not sent yet (shown, approved or on the rail), one row per address.
create or replace function public.career_outreach_addresses_named(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with want as (select lower(regexp_replace(btrim(coalesce(p->>'name', '')), '\s+', ' ', 'g')) as n, (p->>'user')::uuid as u),
  found as (
    select t.recipient_email as email, t.recipient_name as name from public.career_outreach_threads t, want
    where t.user_id = want.u and want.n <> '' and (lower(t.recipient_name) = want.n or split_part(lower(t.recipient_name), ' ', 1) = want.n)
    union all
    select d.recipient_email, d.recipient->>'name' from public.career_outreach_drafts d, want
    where d.user_id = want.u and want.n <> '' and d.status in ('shown', 'approved', 'sending')
      and (lower(d.recipient->>'name') = want.n or split_part(lower(d.recipient->>'name'), ' ', 1) = want.n)
  )
  select coalesce(jsonb_agg(jsonb_build_object('email', email, 'name', name) order by email), '[]'::jsonb)
  from (select distinct on (email) email, name from found order by email, name) x
$$;
revoke all on function public.career_outreach_addresses_named(jsonb) from public, anon, authenticated;
grant execute on function public.career_outreach_addresses_named(jsonb) to service_role;

create or replace function public.career_provider_candidates(p_user uuid, p_keys text[], p_after bigint, p_page int)
returns setof jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select to_jsonb(x) from (
    select p.id, p.source, p.name, p.email, p.company, p.company_key, p.position, p.school, p.source_ref, p.source_url, p.provider, p.provider_id, p.domain,
           p.email_status, p.email_evidence, p.email_confidence, p.mx, p.sendable, p.fetched_at, p.same_as, p.connected_on, p.profile_text,
           (p.email is not null and (
              exists (select 1 from career_outreach_dnc d where d.email_hash = career_email_hash(p.email))
              or exists (select 1 from career_send_bad_addresses b where b.email_hash = career_email_hash(p.email))
              or exists (select 1 from career_email_bad b2 where b2.addr_hash = career_email_hash(p.email)))) as blocked
    from career_people p
    where p.user_id = p_user and p.company_key = any(p_keys) and p.id > coalesce(p_after, 0)
    order by p.id limit greatest(least(coalesce(p_page, 500), 5000), 1)) x
$$;
revoke all on function public.career_provider_candidates(uuid, text[], bigint, int) from public, anon, authenticated;
grant execute on function public.career_provider_candidates(uuid, text[], bigint, int) to service_role;

-- career_send_complete_one (20261029200000), exactly as it was, except that an email stopped by the person while a worker
-- held it is read like one cancelled by a disconnect: a send already handed to the mailbox is recorded as sent (the
-- truth), anything else only ends the hold and it is never queued again.
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
    if q.kind = 'outreach' then update public.career_outreach_drafts set status = 'approved', result = 'queued', updated_at = now() where id = q.source_id and user_id = q.user_id and status = 'sending'; end if;
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
