-- CONNECTOR SCENARIOS (2026-10-29, tests/architect/scenarios-connectors.test.ts): disconnect and erase, at scale. ~10,000
-- generated asks, provider answers and account states, and ~200 end to end on Postgres through the real handler, found
-- what a disconnect left waiting or said wrong. Owner rules: a disconnect revokes at the provider where possible, deletes
-- the tokens and rows, erases the mail read from that account, cancels EVERY pending send, and the reply says only what
-- the read-back shows; an erase deletes the person's data but keeps the global opt-out and bounce lists (hashes).
--   1. career_send_on_google (20261027200000): a disconnect cancelled only the rail's QUEUED emails. One a worker held
--      (state 'sending') survived it: when its worker died, the next claim put it back in the queue, and once the person
--      connected again it was sent. Now every queued and every held email from that mailbox is cancelled; a held one keeps
--      its lease owner so that a worker that had already handed it to the provider can still record that it went (the
--      truth), and the worker that had not is stopped by (2). Approved emails of the replies lane that waited on this
--      mailbox are cancelled too (not yet handed to the rail: shown, approved, being handed; handed and cancelled on the
--      rail above: taken back and not counted as sent), and what was read from it is erased (the other side's turns of
--      its threads, and the mailbox's read position, career_outreach_sync.cursor).
--   2. career_send_go (new): the worker asks right before it hands an email to Gmail or Outlook; only the lease holder of
--      an email still 'sending', from a mailbox still connected, gets 'go'. It waits for a disconnect in progress (row
--      lock), so nothing is sent after the cancel commits.
--   3. career_send_complete_one (20261027200000): as before, plus (3) above: a held email cancelled by a disconnect is
--      recorded as sent when its worker reports that it went; any other outcome ends the hold.
--   4. career_connector_on_disconnect (20261028110000): disconnecting one mailbox no longer cancels the approved outreach
--      emails queued on the person's OTHER mailbox (disconnecting Outlook cancelled the emails going from Gmail).
--   5. career_connector_waiting (new): what still waits to go from a mailbox, counted by the database at any volume, read
--      before and after a disconnect so the reply says exactly what the read-back shows (connectors.ts).
--   6. career_outreach_dnc: deleting an account deleted the person's opt-out hashes (on delete cascade), and the opt-out
--      list is read across everyone, so a contact who said "stop" to one person could be emailed by another once the first
--      deleted their account. The row now outlives its person with no owner (on delete set null; the primary key becomes
--      a unique index). The bounce list (career_send_bad_addresses) names nobody and was already kept.
-- Everything else is as before. Idempotent; service role only; no volume limit anywhere.

-- ---------------------------------------------------------------------------------------------- 1. disconnect
create or replace function public.career_send_on_google() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare prov text; label text;
begin
  if tg_op = 'DELETE' then
    prov := case old.provider when 'google_career' then 'gmail' when 'microsoft' then 'outlook' end;
    if prov is not null then
      label := case prov when 'gmail' then 'Gmail' else 'Outlook' end;
      -- Every email waiting or held: cancelled. A held one keeps its lease owner (career_send_complete_one (3)).
      update public.career_send_queue set state = 'cancelled', result = prov || ' disconnected', updated_at = now(),
        lease_owner = case when state = 'sending' then lease_owner end, lease_until = case when state = 'sending' then lease_until end
      where user_id = old.user_id and provider = prov and state in ('queued', 'sending');
      update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and status in ('approved', 'sending')
        and id in (select source_id from public.career_send_queue where user_id = old.user_id and kind = 'outreach' and provider = prov
                   and state = 'cancelled' and result = prov || ' disconnected' and updated_at = now());
      -- The replies lane: a follow-up handed to the rail and cancelled just above never went: taken back, not counted.
      with a as (
        update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || label || ' disconnected', 300), updated_at = now()
        where x.user_id = old.user_id and x.status = 'done'
          and x.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov)
          and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and exists (select 1 from public.career_send_queue s where s.id = x.provider_ref::uuid and s.user_id = old.user_id and s.state = 'cancelled'
                      and s.sent_at is null and s.lease_owner is null and s.result = prov || ' disconnected' and s.updated_at = now())
        returning x.thread_id, x.kind
      )
      update public.career_outreach_threads h set followups_sent = greatest(h.followups_sent - k.n, 0), updated_at = now()
      from (select thread_id, count(*)::int n from a where kind = 'followup' group by thread_id) k where h.id = k.thread_id;
      -- Not handed yet (waiting for the yes, approved, being handed): cancelled; the person approves again to send.
      update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || label || ' disconnected', 300),
        lease_owner = null, lease_until = null, updated_at = now()
      where x.user_id = old.user_id and x.status in ('shown', 'approved', 'running')
        and x.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov);
      update public.career_outreach_threads set followup_state = 'none', updated_at = now()
      where user_id = old.user_id and provider = prov and followup_state = 'drafted';
      -- What was read from the mailbox: the other side's turns and the read position.
      delete from public.career_outreach_turns u where u.user_id = old.user_id and u.who <> 'person'
        and u.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov);
      update public.career_outreach_threads t set turns = (select count(*) from public.career_outreach_turns u where u.thread_id = t.id), updated_at = now()
      where t.user_id = old.user_id and t.provider = prov;
      update public.career_outreach_sync set cursor = null where user_id = old.user_id and provider = prov;
      update public.career_send_accounts set state = 'disconnected', has_work = false, reason = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and provider = prov;
    end if;
    return old;
  end if;
  prov := case new.provider when 'google_career' then 'gmail' when 'microsoft' then 'outlook' end;
  if prov is not null then
    update public.career_send_accounts set state = 'ok', resume_at = null, reason = null, strikes = 0, updated_at = now(),
      has_work = exists (select 1 from public.career_send_queue where user_id = new.user_id and provider = prov and state = 'queued')
    where user_id = new.user_id and provider = prov and state in ('needs_reconnect', 'disconnected');
  end if;
  return new;
end $$;
revoke all on function public.career_send_on_google() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_send_rail on public.user_oauth_connections;
create trigger user_oauth_connections_send_rail after insert or update or delete on public.user_oauth_connections
  for each row execute function public.career_send_on_google();

-- ---------------------------------------------------------------------------------------------- 2. the worker's last check
-- p: {worker, id}. 'go' only for the lease holder of an email still 'sending' from a mailbox still connected; else 'stop'.
create or replace function public.career_send_go(p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.career_send_queue;
begin
  if p->>'worker' is null or p->>'id' is null then raise exception 'invalid send check'; end if;
  -- FOR SHARE: a disconnect in progress holds the row; this waits for it, then sees the email cancelled.
  select * into q from public.career_send_queue where id = (p->>'id')::uuid for share;
  if not found or q.state <> 'sending' or q.lease_owner is distinct from p->>'worker' then return 'stop'; end if;
  if not exists (select 1 from public.user_oauth_connections c where c.user_id = q.user_id and c.provider = public.career_send_connection(q.provider))
     or exists (select 1 from public.career_send_accounts a where a.user_id = q.user_id and a.provider = q.provider and a.state = 'disconnected') then
    return 'stop';
  end if;
  return 'go';
end $$;
revoke all on function public.career_send_go(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_go(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- 3. complete
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
  if q.state = 'cancelled' and q.lease_owner is not distinct from w and q.result in ('gmail disconnected', 'outlook disconnected') then
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

-- ---------------------------------------------------------------------------------------------- 4. the other mailbox
create or replace function public.career_connector_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.provider in ('google_career', 'microsoft') then
    -- Every approved outreach email that has not gone yet, except one queued to go from the person's other mailbox.
    update public.career_outreach_drafts d set status = 'skipped', result = 'cancelled: ' || case when old.provider = 'microsoft' then 'Outlook' else 'Gmail' end || ' disconnected', updated_at = now()
      where d.user_id = old.user_id and d.status = 'approved'
        and not exists (select 1 from public.career_send_queue q where q.user_id = old.user_id and q.kind = 'outreach' and q.source_id = d.id
          and q.state in ('queued', 'sending') and q.provider <> case when old.provider = 'microsoft' then 'outlook' else 'gmail' end);
  end if;
  if old.provider in ('google_career', 'gmail') then
    update public.career_connector_links set opened_at = coalesce(opened_at, now()), finished_at = now(), outcome = coalesce(outcome, 'error')
      where user_id = old.user_id and connector = 'gmail' and finished_at is null;
  end if;
  return old;
end $$;
revoke all on function public.career_connector_on_disconnect() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_connector_cancel on public.user_oauth_connections;
create trigger user_oauth_connections_connector_cancel after delete on public.user_oauth_connections
  for each row execute function public.career_connector_on_disconnect();

-- ---------------------------------------------------------------------------------------------- 5. what waits on a mailbox
-- {approved, queued, actions, sending}: approved outreach emails not queued on the other mailbox; emails queued on this
-- mailbox's rail (an outreach one is counted once, with its approved draft); the replies lane's approved emails not yet
-- handed over on this mailbox's threads; emails a worker holds (they may be going right now).
create or replace function public.career_connector_waiting(p_user uuid, p_mailbox text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'approved', (select count(*) from public.career_outreach_drafts d where d.user_id = p_user and d.status = 'approved'
      and not exists (select 1 from public.career_send_queue q where q.user_id = p_user and q.kind = 'outreach' and q.source_id = d.id
        and q.state in ('queued', 'sending') and q.provider <> p_mailbox)),
    'queued', (select count(*) from public.career_send_queue q where q.user_id = p_user and q.provider = p_mailbox and q.state = 'queued'
      and not (q.kind = 'outreach' and exists (select 1 from public.career_outreach_drafts d where d.id = q.source_id and d.user_id = p_user and d.status = 'approved'))),
    'actions', (select count(*) from public.career_outreach_actions x join public.career_outreach_threads t on t.id = x.thread_id
      where x.user_id = p_user and t.provider = p_mailbox and x.status in ('approved', 'running')),
    'sending', (select count(*) from public.career_send_queue q where q.user_id = p_user and q.provider = p_mailbox and q.state = 'sending'))
$$;
revoke all on function public.career_connector_waiting(uuid, text) from public, anon, authenticated;
grant execute on function public.career_connector_waiting(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------- 6. opt-outs outlive the account
create unique index if not exists career_outreach_dnc_user_email on public.career_outreach_dnc (user_id, email_hash);
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.career_outreach_dnc'::regclass and contype = 'p' loop
    execute format('alter table public.career_outreach_dnc drop constraint %I', c);
  end loop;
  for c in select conname from pg_constraint where conrelid = 'public.career_outreach_dnc'::regclass and contype = 'f' and confdeltype <> 'n' loop
    execute format('alter table public.career_outreach_dnc drop constraint %I', c);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.career_outreach_dnc'::regclass and contype = 'f') then
    alter table public.career_outreach_dnc add constraint career_outreach_dnc_user_id_fkey foreign key (user_id) references public.profiles(id) on delete set null;
  end if;
end $$;
alter table public.career_outreach_dnc alter column user_id drop not null;
