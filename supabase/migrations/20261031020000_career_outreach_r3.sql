-- OUTREACH R3 (2026-10-31, tests/architect/scenarios-outreach-r3.test.ts, outreach-r3-pg.test.ts, tests/db/career_outreach_r3.test.sql):
-- a fresh-seed battery over the outreach lifecycle after the draft (approval binding, the send claim, the mailbox send,
-- what comes back, follow-ups, stops) found five things the sending rail let through. Redefined here, each exactly as
-- before except as said: career_send_enqueue (20261027200000), career_send_go (20261029200000), career_send_claim
-- (20261030040000) and career_send_complete_one (20261030090000).
--   1. Two approvals to the same address at once (two batches drafted in two chats, each approved in its own chat) each
--      found no email to that address yet and both were queued: the contact got two first emails. The hand-off now takes
--      the person's lock, so the second sees the first and is refused (already_emailed).
--   2. A draft edited after its approval and approved again ("edit 3: ...", then "send 3") never went: its new approval
--      was refused as already_emailed by its own earlier approval still waiting on the rail, which the claim then refused
--      as changed. The person was told it was going. Now the newer approval of the same draft replaces the one waiting
--      (cancelled, 'replaced by a newer approval of the same draft') and is queued.
--   3. An approved draft the rail refused for good (the address opted out or bounced for anyone, or the person already
--      emailed them) stayed 'approved' forever with no reason anywhere. It is now skipped with that reason, and the chat
--      says it won't be sent (career_outreach.ts).
--   4. career_send_go, the worker's last check, did not look at what came back since the claim: a claim holds up to 25 of
--      an account's emails and sends them one after another, and a "stop" or a bounce recorded meanwhile (the reply check
--      runs alongside) did not stop the next one to that address; nor did an answer on a follow-up's sequence. Now it
--      answers 'stop' for an address on the opt-out or bounce list and for a follow-up whose sequence was answered or
--      dropped; the email goes back untried and the next claim cancels it with the reason.
--   5. An approval lives 7 days, but only an email never tried was held to it: one that Gmail answered 5xx (or that timed
--      out, or whose worker died) was retried for as long as it failed and could leave weeks later on the old yes. The
--      claim now marks a retried outreach email whose approval is older (lapsed); the worker checks the person's Sent mail
--      first (it may have gone) and otherwise reports 'lapsed': cancelled, the draft lapses (skipped, 'expired', which
--      "show lapsed" shows again for a fresh yes).
-- Service role only (each function revoked from public, anon and authenticated, as before). Idempotent. No volume limit.


-- ---------------------------------------------------------------------------------------------- 1-3. enqueue
create or replace function public.career_send_enqueue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid := (p->>'user')::uuid; it jsonb; out jsonb := '[]'::jsonb; k text; src uuid; h text; to_ text; prov text;
  fu uuid; d public.career_outreach_drafts; orig public.career_send_queue; new_id uuid; ex public.career_send_queue;
  why text; touched text[] := '{}';
begin
  if u is null or jsonb_typeof(p->'items') <> 'array' then raise exception 'invalid send enqueue'; end if;
  -- (1) One hand-off at a time per person: two approvals of the same address at once each saw no email to it yet.
  perform pg_advisory_xact_lock(hashtextextended('career_send_enqueue:' || u::text, 0));
  for it in select * from jsonb_array_elements(p->'items') loop
    why := null; new_id := null;
    begin
      k := it->>'kind'; src := (it->>'source_id')::uuid; h := it->>'approval_hash'; to_ := lower(btrim(coalesce(it->>'to', '')));
      prov := coalesce(it->>'provider', 'gmail'); fu := nullif(it->>'follow_up_of', '')::uuid;
    exception when others then why := 'invalid'; end;
    if why is null and (k is null or k not in ('outreach', 'application', 'general') or src is null or h !~ '^[a-f0-9]{64}$') then why := 'invalid'; end if;
    if why is null and (it ? 'cc' or it ? 'bcc') then why := 'cc_bcc_not_approved'; end if;
    if why is null and prov not in ('gmail', 'outlook') then why := 'invalid'; end if;
    if why is null and not exists (select 1 from public.user_oauth_connections c where c.user_id = u and c.provider = public.career_send_connection(prov)) then why := 'not_connected'; end if;
    if why is null and k = 'outreach' then
      select * into d from public.career_outreach_drafts where id = src and user_id = u;
      if not found then why := 'not_found';
      elsif d.status <> 'approved' or d.approved_hash is null then why := 'not_approved';
      elsif d.approved_hash <> h or d.hash <> h or lower(d.recipient_email) <> to_ then why := 'changed';
      end if;
    end if;
    if why is null and exists (select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(to_)) then why := 'opted_out'; end if;
    if why is null and exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(to_)) then why := 'bad_address'; end if;
    -- Already this exact approval: the same row, never a second one.
    if why is null then
      select * into ex from public.career_send_queue where idem_key = k || ':' || src || ':' || h;
      if found then
        out := out || jsonb_build_object('source_id', src, 'status', 'already_queued', 'id', ex.id, 'state', ex.state);
        continue;
      end if;
    end if;
    -- A follow-up names the first email of its sequence (follow_up_of): the person's own, to the same address, not
    -- answered, bounced or dropped. A sequence may be as long as the person approves; it stops at any reply.
    if why is null and fu is not null then
      select * into orig from public.career_send_queue where id = fu and user_id = u;
      if found and orig.follow_up_of is not null then select * into orig from public.career_send_queue where id = orig.follow_up_of and user_id = u; end if;
      if not found or orig.recipient_email <> to_ then why := 'follow_up_refused';
      elsif orig.state = 'replied' or exists (select 1 from public.career_send_queue f where f.follow_up_of = orig.id and f.state = 'replied') then why := 'replied';
      elsif orig.state not in ('queued', 'sending', 'sent') then why := 'follow_up_refused';
      else fu := orig.id;
      end if;
    end if;
    -- Outreach: never the same person twice, except the follow-ups above.
    if why is null and k = 'outreach' and fu is null and exists (select 1 from public.career_send_queue q where q.user_id = u and q.recipient_email = to_
        and q.kind = 'outreach' and q.state in ('queued', 'sending', 'sent', 'replied', 'bounced')
        -- (2) its own earlier approval still waiting is replaced below, never counted as an email already sent
        and not (q.source_id = src and q.state = 'queued')) then why := 'already_emailed'; end if;
    if why is null then
      -- (2) A newer approval of the same draft (edited, then approved again) replaces the one still waiting.
      update public.career_send_queue set state = 'cancelled', result = 'replaced by a newer approval of the same draft', updated_at = now()
      where user_id = u and kind = k and source_id = src and approval_hash <> h and state = 'queued';
      begin
        insert into public.career_send_queue(user_id, kind, source_id, approval_hash, idem_key, provider, recipient_email, subject, body, follow_up_of, address_type, address_format, next_at)
        values (u, k, src, h, k || ':' || src || ':' || h, prov, to_, coalesce(it->>'subject', ''), coalesce(it->>'body', ''), fu, nullif(it->>'address_type', ''), nullif(it->>'address_format', ''),
          greatest(now(), coalesce(nullif(it->>'send_at', '')::timestamptz, now())))
        on conflict (idem_key) do nothing
        returning id into new_id;
      exception when check_violation then why := 'invalid';
      end;
      if why is null and new_id is null then
        select * into ex from public.career_send_queue where idem_key = k || ':' || src || ':' || h;
        out := out || jsonb_build_object('source_id', src, 'status', 'already_queued', 'id', ex.id, 'state', ex.state);
        continue;
      end if;
    end if;
    if why is not null then
      -- (3) Refused for good: the approved draft says why instead of waiting as approved forever.
      if k = 'outreach' and why in ('opted_out', 'bad_address', 'already_emailed') then
        update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = why, updated_at = now()
        where id = src and user_id = u and status = 'approved';
      end if;
      out := out || jsonb_build_object('source_id', src, 'status', 'refused', 'reason', why);
    else
      out := out || jsonb_build_object('source_id', src, 'status', 'queued', 'id', new_id);
      if not prov = any(touched) then touched := touched || prov; end if;
    end if;
  end loop;
  -- After the rows: a claim holding this account's row either already saw them or sees has_work after we commit.
  insert into public.career_send_accounts(user_id, provider, has_work)
  select u, x, true from unnest(touched) x
  on conflict (user_id, provider) do update set has_work = true, updated_at = now();
  return out;
end $$;
revoke all on function public.career_send_enqueue(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_enqueue(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. the last check
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
  -- (4) What came back since the claim: an opt-out or a bounce of this address (anyone's), or an answer on this
  -- follow-up's sequence. The email is handed back untried; the next claim cancels it and says why.
  if exists (select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(q.recipient_email))
     or exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(q.recipient_email)) then
    return 'stop';
  end if;
  if q.follow_up_of is not null and (
       exists (select 1 from public.career_send_queue r where r.id = q.follow_up_of and r.state <> 'sent')
       or exists (select 1 from public.career_send_queue f where f.follow_up_of = q.follow_up_of and f.id <> q.id and f.state in ('replied', 'bounced'))) then
    return 'stop';
  end if;
  return 'go';
end $$;
revoke all on function public.career_send_go(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_go(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- 5. lapsed while retried
create or replace function public.career_send_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w text := p->>'worker'; n_acc int := coalesce((p->>'accounts')::int, 20); per int := coalesce((p->>'per_account')::int, 25);
  lease interval := make_interval(secs => coalesce((p->>'lease_seconds')::int, 120));
  t timestamptz := coalesce((p->>'now')::timestamptz, now());
  -- A worker's clock has millisecond precision; next_at is stamped in microseconds. An email queued earlier in the same
  -- millisecond as the claim is due: the caller's time covers its whole millisecond (CI found an email left unclaimed).
  due timestamptz := case when p ? 'now' then date_trunc('milliseconds', (p->>'now')::timestamptz) + interval '999 microseconds' else now() end;
  a public.career_send_accounts; q public.career_send_queue; d public.career_outreach_drafts;
  items jsonb; out jsonb := '[]'::jsonb; bad text; me text; root text;
begin
  if w is null or length(w) > 100 or n_acc < 1 or per < 1 or lease <= interval '0' then raise exception 'invalid send claim'; end if;
  -- Leases that lapsed (a worker that died): back to queued with their attempt count, so the next worker checks the
  -- person's Sent mail before trying again. Bounded and skip-locked, so concurrent claims share the work.
  with lapsed as (
    update public.career_send_queue s set state = 'queued', lease_owner = null, lease_until = null, next_at = t, updated_at = now(),
      result = 'lease lapsed; checked against Sent before any retry'
    where s.id in (select id from public.career_send_queue where state = 'sending' and lease_until < t
                   order by lease_until limit 1000 for update skip locked)
    returning s.user_id, s.provider
  )
  update public.career_send_accounts x set has_work = true, updated_at = now()
  from (select distinct user_id, provider from lapsed) l where x.user_id = l.user_id and x.provider = l.provider and not x.has_work;
  for a in
    select * from public.career_send_accounts
    where has_work and state in ('ok', 'backoff') and (resume_at is null or resume_at <= t)
      and (lease_until is null or lease_until < t)
    order by last_turn_at nulls first
    limit n_acc
    for update skip locked
  loop
    if public.career_user_quiet(a.user_id) then
      update public.career_send_accounts set last_turn_at = t where user_id = a.user_id and provider = a.provider;
      continue;
    end if;
    items := '[]'::jsonb;
    -- The person's own address (the connection's), for the List-Unsubscribe header of cold outreach.
    me := (select lower(c.email) from public.user_oauth_connections c where c.user_id = a.user_id and c.provider = 'google_career');
    for q in
      select * from public.career_send_queue
      where user_id = a.user_id and provider = a.provider and state = 'queued' and next_at <= due
      order by next_at, created_at
      limit per
      for update skip locked
    loop
      bad := null;
      if exists (select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(q.recipient_email)) then bad := 'opted_out';
      elsif exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(q.recipient_email)) then bad := 'bad_address';
      end if;
      if bad is not null then
        update public.career_send_queue set state = 'cancelled', result = bad, updated_at = now() where id = q.id;
        continue;
      end if;
      -- A follow-up goes only after its sequence's first email went; an answered or dropped sequence never continues.
      if q.follow_up_of is not null then
        root := (select r.state from public.career_send_queue r where r.id = q.follow_up_of);
        if root is null or root in ('replied', 'bounced', 'cancelled', 'refused', 'failed') then
          update public.career_send_queue set state = 'cancelled', result = 'sequence stopped', updated_at = now() where id = q.id;
          continue;
        elsif root <> 'sent' then
          continue;
        -- One step of a sequence at a time, in order: an earlier follow-up still waiting or in flight goes first.
        elsif exists (select 1 from public.career_send_queue p where p.follow_up_of = q.follow_up_of and p.id <> q.id
            and p.state in ('queued', 'sending') and (p.next_at, p.created_at, p.id) < (q.next_at, q.created_at, q.id)) then
          continue;
        end if;
      end if;
      if q.kind = 'outreach' then
        select * into d from public.career_outreach_drafts where id = q.source_id and user_id = q.user_id for update;
        if not found or not (d.status = 'approved' or (d.status = 'sending' and d.result = 'send_rail')) or d.approved_hash is distinct from q.approval_hash or d.hash <> q.approval_hash then
          -- The person took it back ("cancel 1", the draft is skipped) or it is gone: cancelled. Anything else: refused.
          update public.career_send_queue set updated_at = now(),
            state = case when not found or d.status = 'skipped' then 'cancelled' else 'refused' end,
            result = case when not found then 'draft gone' when d.status = 'skipped' then 'approval withdrawn' else 'changed after approval' end
          where id = q.id;
          continue;
        end if;
        -- (1) An approval lives 7 days (career_outreach.ts APPROVAL_TTL_MS, said on every approval): an email never tried
        -- whose approval is older is not sent. The draft lapses as the older path left it (skipped, 'expired'), so "show
        -- lapsed" shows it again for a fresh yes.
        if q.attempts = 0 and greatest(d.approved_at, d.created_at) < t - interval '7 days' then
          update public.career_send_queue set state = 'cancelled', result = 'approval lapsed (more than 7 days)', updated_at = now() where id = q.id;
          update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = 'expired', updated_at = now() where id = d.id;
          continue;
        end if;
        update public.career_outreach_drafts set status = 'sending', result = 'send_rail', updated_at = now() where id = d.id;
      end if;
      update public.career_send_queue set state = 'sending', lease_owner = w, lease_until = t + lease, attempts = attempts + 1,
        first_claimed_at = coalesce(first_claimed_at, t), updated_at = now()
      where id = q.id returning * into q;
      items := items || jsonb_build_object('id', q.id, 'user_id', q.user_id, 'kind', q.kind, 'source_id', q.source_id,
        'approval_hash', q.approval_hash, 'provider', q.provider, 'to', q.recipient_email, 'subject', q.subject, 'body', q.body,
        'attempts', q.attempts, 'first_claimed_at', q.first_claimed_at, 'follow_up_of', q.follow_up_of, 'address_type', q.address_type,
        'from_email', me,
        -- (5) Tried before (attempts counts this claim) and its approval is now more than 7 days old: the worker checks
        -- Sent and, when the earlier try did not go, does not send it.
        'lapsed', case when q.kind = 'outreach' and q.attempts > 1 and greatest(d.approved_at, d.created_at) < t - interval '7 days' then true end,
        -- (2) A follow-up: its sequence's emails already sent from Gmail, whose threads the worker reads right before it goes.
        'sequence', case when q.follow_up_of is not null then (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'recipient_email', s.recipient_email,
            'gmail_id', s.gmail_id, 'gmail_thread', s.gmail_thread, 'sent_at', s.sent_at) order by s.sent_at), '[]'::jsonb)
          from public.career_send_queue s where (s.id = q.follow_up_of or s.follow_up_of = q.follow_up_of) and s.id <> q.id
            and s.state = 'sent' and s.provider = 'gmail' and s.gmail_thread is not null) end,
        -- The outreach draft as it is stored now, read under its row lock: the worker re-hashes it before sending.
        'draft', case when q.kind = 'outreach' then jsonb_build_object('recipient', d.recipient, 'subject', d.subject, 'body', d.body, 'footer', d.footer) end);
    end loop;
    update public.career_send_accounts set last_turn_at = t, updated_at = now(),
      lease_owner = case when jsonb_array_length(items) > 0 then w else null end,
      lease_until = case when jsonb_array_length(items) > 0 then t + lease else null end,
      has_work = exists (select 1 from public.career_send_queue where user_id = a.user_id and provider = a.provider and state = 'queued'),
      state = case when state = 'backoff' then 'ok' else state end
    where user_id = a.user_id and provider = a.provider;
    if jsonb_array_length(items) > 0 then
      out := out || jsonb_build_object('user_id', a.user_id, 'provider', a.provider, 'items', items);
    end if;
  end loop;
  return jsonb_build_object('accounts', out);
end $$;
revoke all on function public.career_send_claim(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_claim(jsonb) to service_role;

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
