-- Mass networking, lane M1 (2026-10-27): the sending rail. Emails the person approved leave from their own Gmail
-- (D-MN-1), exactly once each, at whatever volume they approve. One queue serves every kind of email the person approves:
-- outreach (career_outreach_drafts), applications sent by email (APL-12) and any other email they ask Trainee to write.
--
-- Owner rules this file holds (2026-10-27, 19:52-20:40 CDT):
--   * No volume limit of Trainee's own: no daily number, no per-run number, no default spacing, no per-recipient number
--     across people. The only thing that slows an account is Gmail refusing (a quota or rate-limit answer): that account
--     backs off until Gmail allows (career_send_accounts.resume_at), the person is told once in plain words, and the rest
--     of the world keeps sending.
--   * Exactly once per approved email: the idempotency key is kind + the draft's id + its approval hash, unique. A send
--     that may have reached Gmail before a crash is checked against the person's Sent mail before it is ever tried again
--     (the worker, _shared/career_send_rail.ts); the claim only hands it back with its attempt count.
--   * Opt-out ("stop", "unsubscribe", "not interested") is honoured forever (career_outreach_dnc, kept through an erase);
--     a bounced address is never emailed again by anyone (career_send_bad_addresses, a hash only, names nobody).
--   * Never the same person twice for outreach, except the follow-ups the person approves (a sequence of any length,
--     each approved; the whole sequence stops at any reply, opt-out or bounce).
--   * Mailbox protection (reacting to outside signals, not a volume limit): when an account's own recent sends bounce
--     too often, or Gmail answers with a spam or policy refusal, that account's queue pauses, the person is told with the
--     numbers, and it resumes when they say so (career_send_resume).
--   * Disconnecting Gmail cancels everything still queued; an erase deletes the queue (career_erase_person finds the
--     tables from the catalog); deleting the account removes it all.
--
-- Scale (owner, 19:52 CDT): many sender instances run at once. A claim takes whole sender accounts with FOR UPDATE SKIP
-- LOCKED, oldest turn first (round robin: one heavy sender cannot starve anyone), leases the account and up to
-- per_account of its emails, and the fenced completion only lands for the lease that holds the row. Expired leases are
-- reclaimed by the next claim. No global lock, every hot read is an index range.
--
-- Everything here is the service role's: the person sees their state through the chat (career_send_status).
-- Idempotent: every statement can run twice.

-- ---------------------------------------------------------------------------------------------- the queue
create table if not exists public.career_send_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('outreach', 'application', 'general')),
  source_id uuid not null,
  approval_hash text not null check (approval_hash ~ '^[a-f0-9]{64}$'),
  idem_key text not null unique check (length(idem_key) <= 200),
  provider text not null default 'gmail' check (provider in ('gmail', 'outlook')),
  -- One plain address: no list, no display name, no separator. One recipient per message, always; no Cc or Bcc column.
  recipient_email text not null check (recipient_email ~ '^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$'),
  subject text not null check (length(subject) between 1 and 200 and subject !~ '[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  body text not null check (length(body) between 1 and 20000),
  follow_up_of uuid references public.career_send_queue(id) on delete set null,
  state text not null default 'queued' check (state in ('queued', 'sending', 'sent', 'refused', 'failed', 'cancelled', 'bounced', 'replied')),
  attempts int not null default 0 check (attempts >= 0),
  next_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or length(lease_owner) <= 100),
  lease_until timestamptz,
  first_claimed_at timestamptz,
  sent_at timestamptz,
  gmail_id text check (gmail_id is null or length(gmail_id) <= 200),
  gmail_thread text check (gmail_thread is null or length(gmail_thread) <= 200),
  result text check (result is null or length(result) <= 300),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint career_send_sent_has_id check (state not in ('sent', 'replied', 'bounced') or gmail_id is not null)
);
-- D-MN-3 replaced (owner, 21:32 CDT): where the address came from, so the card can show it: published (on a public page),
-- known (the person's own mail) or inferred (the company's email format; address_format names it, e.g. first.last).
-- A bounce of an inferred address is reported to the domain-format learner (career_send_rail.ts recordBounce).
alter table public.career_send_queue add column if not exists address_type text
  check (address_type is null or address_type in ('published', 'known', 'inferred'));
alter table public.career_send_queue add column if not exists address_format text
  check (address_format is null or address_format ~ '^[a-z0-9._{}-]{1,40}$');
create index if not exists career_send_queue_account_due on public.career_send_queue (user_id, provider, next_at, created_at) where state = 'queued';
create index if not exists career_send_queue_leased on public.career_send_queue (lease_until) where state = 'sending';
create index if not exists career_send_queue_sent_check on public.career_send_queue (checked_at nulls first, sent_at) where state = 'sent';
create index if not exists career_send_queue_user_to on public.career_send_queue (user_id, recipient_email);
create index if not exists career_send_queue_to_open on public.career_send_queue (recipient_email) where state = 'queued';
create index if not exists career_send_queue_follow_up on public.career_send_queue (follow_up_of) where follow_up_of is not null;
alter table public.career_send_queue enable row level security;
revoke all on public.career_send_queue from public, anon, authenticated;
grant all on public.career_send_queue to service_role;

-- One row per sender account (the person's Gmail): its turn in the round robin, its lease, and Gmail's own answer
-- (backoff until resume_at, or needs_reconnect / disconnected). has_work says it has queued email.
create table if not exists public.career_send_accounts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  state text not null default 'ok' check (state in ('ok', 'backoff', 'needs_reconnect', 'disconnected', 'paused')),
  resume_at timestamptz,
  reason text check (reason is null or length(reason) <= 300),
  strikes int not null default 0 check (strikes >= 0),
  has_work boolean not null default false,
  last_turn_at timestamptz,
  lease_owner text check (lease_owner is null or length(lease_owner) <= 100),
  lease_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
create index if not exists career_send_accounts_turn on public.career_send_accounts (last_turn_at nulls first) where has_work;
alter table public.career_send_accounts enable row level security;
revoke all on public.career_send_accounts from public, anon, authenticated;
grant all on public.career_send_accounts to service_role;

-- A bounced address, as a SHA-256 of the lowercased address: never emailed again by anyone. No user_id: names nobody,
-- and an erase never re-opens it.
create table if not exists public.career_send_bad_addresses (
  email_hash text primary key check (email_hash ~ '^[a-f0-9]{64}$'),
  reason text not null default 'bounced' check (length(reason) <= 120),
  at timestamptz not null default now()
);
alter table public.career_send_bad_addresses enable row level security;
revoke all on public.career_send_bad_addresses from public, anon, authenticated;
grant all on public.career_send_bad_addresses to service_role;

-- The opt-out list is read by address alone (a "stop" holds for everyone's email to that address); its key starts with
-- the person, so without this every check would read the whole list.
create index if not exists career_outreach_dnc_email on public.career_outreach_dnc (email_hash);

-- The connection row behind each sending provider: Gmail is the career Google grant, Outlook the Microsoft grant (#226).
create or replace function public.career_send_connection(p_provider text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case p_provider when 'gmail' then 'google_career' when 'outlook' then 'microsoft' end
$$;
revoke all on function public.career_send_connection(text) from public, anon, authenticated;
grant execute on function public.career_send_connection(text) to service_role;

create or replace function public.career_send_email_hash(p_email text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'UTF8')), 'hex')
$$;
revoke all on function public.career_send_email_hash(text) from public, anon, authenticated;
grant execute on function public.career_send_email_hash(text) to service_role;

-- A plain line to the person on their home channel (career_outbox kind 'status'), once per key.
create or replace function public.career_send_notice(p_user uuid, p_key text, p_text text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (p_user, 'status:' || p_key, 'status', p_text, now())
  on conflict on constraint career_outbox_once do nothing;
end $$;
revoke all on function public.career_send_notice(uuid, text, text) from public, anon, authenticated;
grant execute on function public.career_send_notice(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------- enqueue
-- p: {user, items: [{kind, source_id, approval_hash, to, subject, body, provider?, follow_up_of?}]}. The caller
-- (career_send_rail.ts queueApproved) has already re-hashed each payload and refused one whose hash is not its approval;
-- here the database's own checks run. Returns one result per item, in order: {source_id, status, reason?, id?} with
-- status queued, already_queued or refused.
create or replace function public.career_send_enqueue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid := (p->>'user')::uuid; it jsonb; out jsonb := '[]'::jsonb; k text; src uuid; h text; to_ text; prov text;
  fu uuid; d public.career_outreach_drafts; orig public.career_send_queue; new_id uuid; ex public.career_send_queue;
  why text; touched text[] := '{}';
begin
  if u is null or jsonb_typeof(p->'items') <> 'array' then raise exception 'invalid send enqueue'; end if;
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
        and q.kind = 'outreach' and q.state in ('queued', 'sending', 'sent', 'replied', 'bounced')) then why := 'already_emailed'; end if;
    if why is null then
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

-- ---------------------------------------------------------------------------------------------- claim
-- p: {worker, accounts, per_account, lease_seconds, now?}. Up to `accounts` sender accounts, oldest turn first, each with
-- up to `per_account` of its due emails, all leased to `worker` until now + lease_seconds. Both numbers size one call;
-- neither limits what is sent (the worker claims again until nothing is due). An account in Gmail's backoff, needing a
-- reconnect, leased by another worker, or whose person is paused is skipped. An outreach email whose draft is no longer
-- exactly what was approved (changed, cancelled) is refused here, inside the draft's row lock; one to an address that
-- opted out or bounced since it was queued is cancelled.
create or replace function public.career_send_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w text := p->>'worker'; n_acc int := coalesce((p->>'accounts')::int, 20); per int := coalesce((p->>'per_account')::int, 25);
  lease interval := make_interval(secs => coalesce((p->>'lease_seconds')::int, 120));
  t timestamptz := coalesce((p->>'now')::timestamptz, now());
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
      where user_id = a.user_id and provider = a.provider and state = 'queued' and next_at <= t
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
        update public.career_outreach_drafts set status = 'sending', result = 'send_rail', updated_at = now() where id = d.id;
      end if;
      update public.career_send_queue set state = 'sending', lease_owner = w, lease_until = t + lease, attempts = attempts + 1,
        first_claimed_at = coalesce(first_claimed_at, t), updated_at = now()
      where id = q.id returning * into q;
      items := items || jsonb_build_object('id', q.id, 'user_id', q.user_id, 'kind', q.kind, 'source_id', q.source_id,
        'approval_hash', q.approval_hash, 'provider', q.provider, 'to', q.recipient_email, 'subject', q.subject, 'body', q.body,
        'attempts', q.attempts, 'first_claimed_at', q.first_claimed_at, 'follow_up_of', q.follow_up_of, 'address_type', q.address_type,
        'from_email', me,
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

-- The worker is done with an account's turn (or gave it up): its lease ends now.
create or replace function public.career_send_release(p jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.career_send_accounts set lease_owner = null, lease_until = null, updated_at = now()
  where user_id = (p->>'user')::uuid and provider = coalesce(p->>'provider', 'gmail') and lease_owner = p->>'worker';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.career_send_release(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_release(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- complete
-- (w, {id, outcome, gmail_id?, thread_id?, detail?, retry_at?, resume_at?, untried?}). Lands only for the lease that holds
-- the row (state sending, lease_owner = worker); otherwise 'stale' and nothing changes. Outcomes:
--   sent / already_sent  sent, with Gmail's message and thread ids (already_sent: found in the person's Sent mail)
--   retry                back to queued at retry_at (a 5xx, a network failure, a Sent check that could not run; with
--                        untried, a claimed email handed back without being tried)
--   quota                Gmail refused for volume: back to queued, the account backs off until resume_at; the person is
--                        told once per pause
--   reconnect            Google refused the grant (401, missing scope, revoked): the account stops until it reconnects;
--                        the person is told once
--   refused              never sent and never will be: the payload is not what was approved, or a header was unsafe
--   failed               Gmail refused this message for good (another 4xx)
create or replace function public.career_send_complete_one(w text, p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.career_send_queue; o text := p->>'outcome'; a public.career_send_accounts;
  detail text := left(coalesce(p->>'detail', ''), 300); waiting int;
begin
  select * into q from public.career_send_queue where id = (p->>'id')::uuid for update;
  if not found or q.state <> 'sending' or q.lease_owner is distinct from w then return 'stale'; end if;
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

-- One outcome ({worker, id, outcome, ...}: returns its text), or several in one transaction ({worker, results: [...],
-- release?: {user, provider}}: returns their texts in order, then ends the account's lease). Recording a few sends at
-- once is safe for exactly-once: one that reached Gmail but was not recorded before a crash is found in Sent before any
-- second try (career_send_rail.ts).
create or replace function public.career_send_complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb := '[]'::jsonb; r jsonb; w text := p->>'worker';
begin
  if w is null then raise exception 'invalid send completion'; end if;
  if not (p ? 'results') then return to_jsonb(public.career_send_complete_one(w, p)); end if;
  for r in select * from jsonb_array_elements(p->'results') loop
    out := out || to_jsonb(public.career_send_complete_one(w, r));
  end loop;
  if p ? 'release' then
    update public.career_send_accounts set lease_owner = null, lease_until = null, updated_at = now()
    where user_id = (p->'release'->>'user')::uuid and provider = coalesce(p->'release'->>'provider', 'gmail') and lease_owner = w;
  end if;
  return out;
end $$;
revoke all on function public.career_send_complete(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_complete(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- what came back
-- p: {limit, recheck_seconds, since}: sent emails whose thread is due a look (never looked at first), each stamped so
-- concurrent readers take different ones.
create or replace function public.career_send_replies_due(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  with due as (
    select id from public.career_send_queue
    where state = 'sent' and provider = 'gmail' and gmail_thread is not null and sent_at >= coalesce((p->>'since')::timestamptz, now() - interval '30 days')
      and (checked_at is null or checked_at < now() - make_interval(secs => coalesce((p->>'recheck_seconds')::int, 900)))
    order by checked_at nulls first, sent_at
    limit greatest(1, coalesce((p->>'limit')::int, 200))
    for update skip locked
  ), stamped as (
    update public.career_send_queue s set checked_at = now() from due where s.id = due.id
    returning s.id, s.user_id, s.kind, s.source_id, s.recipient_email, s.gmail_id, s.gmail_thread, s.address_type, s.address_format, s.sent_at
  )
  select coalesce(jsonb_agg(to_jsonb(stamped)), '[]'::jsonb) into out from stamped;
  return out;
end $$;
revoke all on function public.career_send_replies_due(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_replies_due(jsonb) to service_role;

-- p: {id, kind: bounce | stop | reply, detail?, pause?: {window, bounces, rate}}. bounce: the address is bad forever,
-- for everyone, and every email still queued to it is cancelled; then the account's own recent sends are looked at (the
-- last `window`, default 50): at least `bounces` (default 5) bounced and at least `rate` (default 0.1) of them, and the
-- account pauses with the numbers said to the person. stop: the address is on the opt-out list forever, and every email
-- still queued to it is cancelled. reply: the rest of that email's follow-up sequence is cancelled. Returns what it
-- recorded.
create or replace function public.career_send_record(p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.career_send_queue; k text := p->>'kind'; root uuid;
  win int := greatest(1, coalesce((p->'pause'->>'window')::int, 50)); min_b int := greatest(1, coalesce((p->'pause'->>'bounces')::int, 5));
  rate numeric := coalesce((p->'pause'->>'rate')::numeric, 0.1); n int; b int; waiting int;
begin
  select * into q from public.career_send_queue where id = (p->>'id')::uuid for update;
  if not found or q.state not in ('sent', 'replied', 'bounced') then return 'not_sent'; end if;
  root := coalesce(q.follow_up_of, q.id);
  if k = 'bounce' then
    insert into public.career_send_bad_addresses(email_hash, reason) values (public.career_send_email_hash(q.recipient_email), 'bounced')
    on conflict (email_hash) do nothing;
    update public.career_send_queue set state = 'bounced', result = left(coalesce(p->>'detail', 'bounced'), 300), updated_at = now() where id = q.id;
    update public.career_send_queue set state = 'cancelled', result = 'bad_address', updated_at = now() where recipient_email = q.recipient_email and state = 'queued';
    if q.kind = 'outreach' then update public.career_outreach_drafts set status = 'bounced', result = 'bounce', updated_at = now() where id = q.source_id and user_id = q.user_id; end if;
    -- Mailbox protection: the account's own recent sends.
    select count(*), count(*) filter (where state = 'bounced') into n, b from (
      select state from public.career_send_queue where user_id = q.user_id and provider = q.provider and sent_at is not null
        and state in ('sent', 'replied', 'bounced') order by sent_at desc limit win) r;
    if b >= min_b and b::numeric >= rate * n
       and exists (select 1 from public.career_send_accounts where user_id = q.user_id and provider = q.provider and state in ('ok', 'backoff')) then
      select count(*) into waiting from public.career_send_queue where user_id = q.user_id and provider = q.provider and state in ('queued', 'sending');
      update public.career_send_accounts set state = 'paused', reason = b || ' of the last ' || n || ' emails bounced', updated_at = now()
      where user_id = q.user_id and provider = q.provider;
      perform public.career_send_notice(q.user_id, 'send-bounces:' || q.user_id || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24'),
        'Trainee paused sending from your Gmail: ' || b || ' of your last ' || n || ' emails bounced (' || round(100.0 * b / n) ||
        '%). Many bounces can hurt your account''s standing with Gmail. Those addresses won''t be emailed again. ' || waiting ||
        ' approved email' || case when waiting = 1 then ' is' else 's are' end || ' waiting; say "resume sending" when you want them to go.');
    end if;
  elsif k in ('stop', 'reply') then
    if k = 'stop' then
      insert into public.career_outreach_dnc(user_id, email_hash, reason) values (q.user_id, public.career_send_email_hash(q.recipient_email), 'recipient asked to stop')
      on conflict (user_id, email_hash) do nothing;
      update public.career_send_queue set state = 'cancelled', result = 'opted_out', updated_at = now() where recipient_email = q.recipient_email and state = 'queued';
    end if;
    update public.career_send_queue set state = 'replied', result = k, updated_at = now() where id = q.id;
    -- An answer to any email of a sequence stops the whole sequence, and the first email counts as answered.
    update public.career_send_queue set state = 'replied', result = k, updated_at = now() where id = root and state = 'sent';
    update public.career_send_queue set state = 'cancelled', result = 'they replied', updated_at = now() where follow_up_of = root and state = 'queued';
    if q.kind = 'outreach' then update public.career_outreach_drafts set status = 'replied', result = k, updated_at = now() where id = q.source_id and user_id = q.user_id; end if;
  else
    raise exception 'unknown reply kind %', k;
  end if;
  return k;
end $$;
revoke all on function public.career_send_record(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_record(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- the person's view
-- p: {user}: counts by state and the sender account's own state, for "where are my emails".
create or replace function public.career_send_status(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from public.career_send_queue where user_id = (p->>'user')::uuid group by state) c), '{}'::jsonb),
    'next_at', (select min(next_at) from public.career_send_queue where user_id = (p->>'user')::uuid and state = 'queued'),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'state', state, 'resume_at', resume_at, 'reason', reason))
                          from public.career_send_accounts where user_id = (p->>'user')::uuid), '[]'::jsonb))
$$;
revoke all on function public.career_send_status(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_status(jsonb) to service_role;

-- p: {user, provider?}: the person says "resume sending" after a pause (bounces, or Gmail's spam or policy refusal).
-- Returns 'resumed', or the account's state when it was not paused.
create or replace function public.career_send_resume(p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare st text;
begin
  update public.career_send_accounts set state = 'ok', reason = null, updated_at = now(),
    has_work = exists (select 1 from public.career_send_queue q where q.user_id = career_send_accounts.user_id and q.provider = career_send_accounts.provider and q.state = 'queued')
  where user_id = (p->>'user')::uuid and provider = coalesce(p->>'provider', 'gmail') and state = 'paused'
  returning 'resumed' into st;
  if st is null then
    st := coalesce((select state from public.career_send_accounts where user_id = (p->>'user')::uuid and provider = coalesce(p->>'provider', 'gmail')), 'none');
  end if;
  return st;
end $$;
revoke all on function public.career_send_resume(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_resume(jsonb) to service_role;

-- p: {user, source_ids?}: the person takes back emails still queued (all, or those drafts). Returns how many.
create or replace function public.career_send_cancel(p jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.career_send_queue set state = 'cancelled', result = 'cancelled by the person', updated_at = now()
  where user_id = (p->>'user')::uuid and state = 'queued'
    and (p->'source_ids' is null or source_id in (select (jsonb_array_elements_text(p->'source_ids'))::uuid));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.career_send_cancel(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_cancel(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------- connect, disconnect
-- Disconnecting a mailbox that sends (the career Google grant for Gmail, the Microsoft grant for Outlook; any path that
-- deletes its row) cancels every email still queued from it. Reconnecting (a new or replaced row) lifts needs_reconnect:
-- what was waiting goes out.
create or replace function public.career_send_on_google() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare prov text;
begin
  if tg_op = 'DELETE' then
    prov := case old.provider when 'google_career' then 'gmail' when 'microsoft' then 'outlook' end;
    if prov is not null then
      update public.career_send_queue set state = 'cancelled', result = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and provider = prov and state = 'queued';
      update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and status = 'approved'
        and id in (select source_id from public.career_send_queue where user_id = old.user_id and kind = 'outreach' and result = prov || ' disconnected');
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

-- ---------------------------------------------------------------------------------------------- NO LIMITS on the older path
-- The owner (2026-10-27 19:55 CDT): "no person limit, never set a limit". The older one-at-a-time outreach claim
-- (20261022120000_career_control_state.sql) held a daily number (20, up to 30), a first-week warm-up (10), 90-second
-- spacing and 3 emails per address per 30 days across everyone (removed by the owner at 20:40). Redefined here with the
-- same signature and every non-volume rule kept: the exact approval's hash, its 7-day life, a paused/STOPped/erased
-- account sends nothing, do-not-contact across every user. p_day_start stays for callers and is no longer read.
create or replace function public.career_outreach_claim(p_user uuid, p_draft uuid, p_hash text, p_now timestamptz, p_day_start timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.career_outreach_drafts;
begin
 if p_user is null or p_draft is null or p_hash is null or p_now is null then raise exception 'invalid outreach claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended('career_outreach:' || p_user::text, 0));
 select * into d from public.career_outreach_drafts where id = p_draft and user_id = p_user for update;
 if not found or d.status <> 'approved' or d.approved_hash is null then return 'not_approved'; end if;
 if d.approved_hash <> p_hash or d.hash <> p_hash then return 'changed'; end if;
 if greatest(d.approved_at, d.created_at) < p_now - interval '7 days' then return 'expired'; end if;
 if public.career_user_quiet(p_user) then return 'paused'; end if;
 if exists (select 1 from public.career_outreach_dnc
   where email_hash = encode(sha256(convert_to(lower(d.recipient_email), 'UTF8')), 'hex')) then return 'do_not_contact'; end if;
 update public.career_outreach_drafts set status = 'sending', sent_at = p_now, updated_at = now() where id = d.id;
 return 'ok';
end $$;
revoke all on function public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz) to service_role;
