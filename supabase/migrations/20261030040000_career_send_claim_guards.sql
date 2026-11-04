-- OUTREACH SCENARIOS (2026-10-30, tests/architect/scenarios-outreach.test.ts): networking drafts, approvals, the sending
-- rail and follow-ups at scale. ~10,000 generated scenarios and ~80 flows on Postgres through the rail's own functions with
-- a fake Gmail found two things the claim let through. career_send_claim (20261027200000) is redefined; everything else in
-- it is as before (no volume limit anywhere; service role only; idempotent).
--   1. An approval lives 7 days (career_outreach.ts APPROVAL_TTL_MS; every approval says "Any not sent within 7 days of
--      your approval lapse unsent"; the older path's career_outreach_claim refused it as 'expired'). The rail never looked:
--      an approved outreach email that waited on a paused account, a reconnect or Gmail's backoff went out weeks later on
--      the old yes. Now one never tried whose approval is more than 7 days old (at the claim's time) is cancelled and its
--      draft lapses (skipped, 'expired', the state "show lapsed" reads), so the person approves it again or not at all.
--   2. A follow-up was sent to someone who had already answered: the reply check reads each thread every 15 minutes, so
--      an answer since its last look did not stop a follow-up due in between. The claim now hands the worker the follow-up's
--      sequence (the first email and earlier steps already sent from Gmail, with their threads); the worker reads them
--      right before sending and records any answer (career_send_record), which stops the sequence (career_send_rail.ts).

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
