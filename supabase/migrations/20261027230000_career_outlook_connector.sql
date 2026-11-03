-- M4 (2026-10-27): Outlook (Microsoft Graph) as a peer of Gmail. The person's own Microsoft account (work, school or
-- personal; the `common` endpoint) connected from any channel, its tokens only in the person's own Vault entry
-- (oauth_microsoft_<uid>, through the oauth_vault_* functions and the namespace guard of 20261012060000), and four tables:
--   career_outlook_links     the one-time link "connect my outlook" sends: bound to the person, channel, thread and purpose,
--                            stored as a SHA-256 of the token, 15 minutes, once (issue -> peek -> open -> finish).
--   career_outlook_state     one row per connected person: the token's expiry, the inbox delta link, needs_reconnect, a
--                            Graph Retry-After, and two leases (refresh, sync) so many workers run batches in parallel
--                            (FOR UPDATE SKIP LOCKED, expired leases reclaimed, no global lock). No volume limit anywhere:
--                            the only wait is Microsoft's own Retry-After (owner, 2026-10-27 "never set a limit").
--   career_outlook_messages  inbox metadata read for reply tracking: hashes, sender address, subject, Graph's preview.
--   career_outlook_sends     the idempotency ledger of every message sent through Outlook (outreach, applications by email,
--                            any approved email): one row per (person, key), bound to the approved payload's hash; a
--                            key already sent, or whose outcome is unknown, is never sent again.
-- Disconnect (the microsoft connection row deleted, by any path): the Vault entry goes (20261012060000's trigger), and
-- here every Outlook-derived row is erased, every pending send is cancelled and every live link is burned.
-- The career_ prefix puts every table under "forget everything" (career_erase_person). Additive and idempotent. Nothing is
-- granted to anon or authenticated; every function is service-role only.

create table if not exists public.career_outlook_links (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('web', 'telegram', 'imessage', 'whatsapp', 'home')),
  purpose text not null default 'connect' check (purpose in ('connect', 'outreach', 'send_email', 'track_replies', 'calendar')),
  thread_id uuid references public.agent_threads(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  opened_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome is null or outcome in ('connected', 'declined', 'error')),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check (finished_at is null or opened_at is not null));
create index if not exists career_outlook_links_user on public.career_outlook_links (user_id, created_at);

create table if not exists public.career_outlook_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  token_expires_at timestamptz,
  needs_reconnect_at timestamptz,
  needs_reconnect_reason text check (needs_reconnect_reason is null or length(needs_reconnect_reason) <= 200),
  delta_link text check (delta_link is null or delta_link ~ '^https://graph\.microsoft\.com/'),
  synced_at timestamptz,
  next_sync_at timestamptz,
  retry_after timestamptz,
  refresh_lease_by text, refresh_lease_until timestamptz,
  sync_lease_by text, sync_lease_until timestamptz,
  last_error text check (last_error is null or length(last_error) <= 300),
  updated_at timestamptz not null default now());
-- The two claim paths read only these partial indexes (bounded, never a scan of every connected person).
create index if not exists career_outlook_state_refresh_due on public.career_outlook_state (token_expires_at) where needs_reconnect_at is null;
create index if not exists career_outlook_state_sync_due on public.career_outlook_state (next_sync_at) where needs_reconnect_at is null;

create table if not exists public.career_outlook_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_hash text not null check (message_hash ~ '^[0-9a-f]{64}$'),
  conversation_hash text check (conversation_hash is null or conversation_hash ~ '^[0-9a-f]{64}$'),
  from_address text check (from_address is null or length(from_address) <= 320),
  subject text check (subject is null or length(subject) <= 500),
  preview text check (preview is null or length(preview) <= 500),
  received_at timestamptz not null,
  primary key (user_id, message_hash));
create index if not exists career_outlook_messages_from on public.career_outlook_messages (user_id, from_address, received_at desc);

create table if not exists public.career_outlook_sends (
  user_id uuid not null references auth.users(id) on delete cascade,
  idem_key text not null check (idem_key ~ '^[A-Za-z0-9:._-]{8,200}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('outreach', 'application', 'followup', 'general')),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('sending', 'sent', 'refused', 'unknown', 'cancelled', 'rate_limited')),
  detail text check (detail is null or length(detail) <= 300),
  attempts int not null default 0 check (attempts >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  sent_at timestamptz,
  primary key (user_id, idem_key));

-- ------------------------------------------------------------------------------------------------ links
create or replace function public.career_outlook_link_issue(p_user uuid, p_channel text, p_thread uuid, p_purpose text, p_now timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare n text;
begin
  if p_user is null or p_now is null then raise exception 'invalid link request'; end if;
  n := left(translate(encode(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_'), 32);
  insert into public.career_outlook_links (nonce_hash, user_id, channel, thread_id, purpose, created_at, expires_at)
  values (encode(sha256(convert_to(n, 'UTF8')), 'hex'), p_user, coalesce(p_channel, 'web'),
    (select t.id from public.agent_threads t where t.id = p_thread and t.user_id = p_user), coalesce(p_purpose, 'connect'), p_now, p_now + interval '15 minutes');
  return n;
end $$;

create or replace function public.career_outlook_link_peek(p_nonce text, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.career_outlook_links; em text; hint text;
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{32}$' or p_now is null then return jsonb_build_object('status', 'invalid'); end if;
  select * into r from public.career_outlook_links where nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  if r.id is null then return jsonb_build_object('status', 'invalid'); end if;
  if r.opened_at is not null then return jsonb_build_object('status', 'used'); end if;
  if r.expires_at <= p_now then return jsonb_build_object('status', 'expired'); end if;
  select u.email into em from auth.users u where u.id = r.user_id;
  if em ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then hint := left(em, 1) || '•••@' || split_part(em, '@', 2); end if;
  return jsonb_build_object('status', 'ok', 'channel', r.channel, 'purpose', r.purpose, 'hint', hint);
end $$;

create or replace function public.career_outlook_link_open(p_nonce text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_outlook_links;
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{32}$' or p_now is null then return jsonb_build_object('error', 'invalid'); end if;
  select * into r from public.career_outlook_links where nonce_hash = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex') for update;
  if r.id is null then return jsonb_build_object('error', 'invalid'); end if;
  if r.opened_at is not null then return jsonb_build_object('error', 'used'); end if;
  if r.expires_at <= p_now then return jsonb_build_object('error', 'expired'); end if;
  update public.career_outlook_links set opened_at = p_now where id = r.id;
  return jsonb_build_object('link_id', r.id);
end $$;

-- Microsoft's callback lands here exactly once, within 15 minutes of the open; it names the link's own person, never another.
create or replace function public.career_outlook_link_finish(p_link uuid, p_outcome text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_outlook_links;
begin
  if p_link is null or p_now is null or p_outcome is null or p_outcome not in ('connected', 'declined', 'error') then return jsonb_build_object('error', 'invalid'); end if;
  select * into r from public.career_outlook_links where id = p_link for update;
  if r.id is null or r.opened_at is null then return jsonb_build_object('error', 'invalid'); end if;
  if r.finished_at is not null then return jsonb_build_object('error', 'used'); end if;
  if r.opened_at + interval '15 minutes' <= p_now then
    update public.career_outlook_links set finished_at = p_now, outcome = 'error' where id = r.id;
    return jsonb_build_object('error', 'expired');
  end if;
  update public.career_outlook_links set finished_at = p_now, outcome = p_outcome where id = r.id;
  return jsonb_build_object('user_id', r.user_id, 'channel', r.channel, 'thread_id', r.thread_id, 'purpose', r.purpose);
end $$;

-- ------------------------------------------------------------------------------------------------ leased batches
-- Claims up to p_batch people whose access token expires before p_now + p_ahead (kind 'refresh') or whose inbox sync is
-- due and whom Microsoft has not asked to wait (kind 'sync'). Rows another worker holds are skipped, an expired lease is
-- taken over. p_batch is the size of one worker's batch (how much it takes per call), not a limit on how many are served.
create or replace function public.career_outlook_claim(p_kind text, p_worker text, p_now timestamptz, p_lease_seconds int, p_batch int,
  p_ahead_seconds int default 600) returns setof uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_kind not in ('refresh', 'sync') or p_worker is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 or coalesce(p_batch, 0) < 1 then
    raise exception 'invalid claim';
  end if;
  if p_kind = 'refresh' then
    return query
    with c as (
      select s.user_id from public.career_outlook_state s
      where s.needs_reconnect_at is null and s.token_expires_at is not null and s.token_expires_at < p_now + make_interval(secs => coalesce(p_ahead_seconds, 600))
        and (s.refresh_lease_until is null or s.refresh_lease_until <= p_now)
      order by s.token_expires_at limit p_batch for update skip locked)
    update public.career_outlook_state s set refresh_lease_by = p_worker, refresh_lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now
    from c where s.user_id = c.user_id returning s.user_id;
  else
    return query
    with c as (
      select s.user_id from public.career_outlook_state s
      where s.needs_reconnect_at is null and coalesce(s.next_sync_at, '-infinity') <= p_now and coalesce(s.retry_after, '-infinity') <= p_now
        and (s.sync_lease_until is null or s.sync_lease_until <= p_now)
      order by s.next_sync_at nulls first limit p_batch for update skip locked)
    update public.career_outlook_state s set sync_lease_by = p_worker, sync_lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now
    from c where s.user_id = c.user_id returning s.user_id;
  end if;
end $$;

-- A worker gives a claim back only while it still holds the lease (a lease that expired and was taken over is not its own).
create or replace function public.career_outlook_release(p_kind text, p_user uuid, p_worker text, p_now timestamptz, p_patch jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_kind = 'refresh' then
    update public.career_outlook_state set refresh_lease_by = null, refresh_lease_until = null,
      token_expires_at = coalesce((p_patch->>'token_expires_at')::timestamptz, token_expires_at),
      needs_reconnect_at = case when p_patch ? 'needs_reconnect_reason' then p_now else needs_reconnect_at end,
      needs_reconnect_reason = coalesce(left(p_patch->>'needs_reconnect_reason', 200), needs_reconnect_reason),
      retry_after = case when p_patch ? 'retry_after' then (p_patch->>'retry_after')::timestamptz else retry_after end,
      last_error = case when p_patch ? 'last_error' then left(p_patch->>'last_error', 300) else last_error end,
      updated_at = p_now
    where user_id = p_user and refresh_lease_by = p_worker;
  elsif p_kind = 'sync' then
    update public.career_outlook_state set sync_lease_by = null, sync_lease_until = null,
      delta_link = case when p_patch ? 'delta_link' then p_patch->>'delta_link' else delta_link end,
      synced_at = coalesce((p_patch->>'synced_at')::timestamptz, synced_at),
      next_sync_at = coalesce((p_patch->>'next_sync_at')::timestamptz, next_sync_at),
      needs_reconnect_at = case when p_patch ? 'needs_reconnect_reason' then p_now else needs_reconnect_at end,
      needs_reconnect_reason = coalesce(left(p_patch->>'needs_reconnect_reason', 200), needs_reconnect_reason),
      retry_after = case when p_patch ? 'retry_after' then (p_patch->>'retry_after')::timestamptz else retry_after end,
      last_error = case when p_patch ? 'last_error' then left(p_patch->>'last_error', 300) else last_error end,
      updated_at = p_now
    where user_id = p_user and sync_lease_by = p_worker;
  else
    raise exception 'invalid release';
  end if;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ------------------------------------------------------------------------------------------------ sends, exactly once
-- Before any call to Microsoft: 'go' only for a key never tried, or one Microsoft refused or rate-limited (nothing went);
-- 'sent' / 'unknown' (a send that may have gone) / 'cancelled' are final; 'changed' when the key's payload hash differs
-- (the text changed after it was approved: never sent under the old key); 'not_connected' when the person has no
-- Outlook connection (a disconnect stops every pending send).
create or replace function public.career_outlook_send_begin(p_user uuid, p_key text, p_hash text, p_purpose text, p_recipient_hash text, p_now timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_outlook_sends; bad boolean;
begin
  if p_user is null or p_key is null or p_hash is null or p_now is null or p_recipient_hash is null then return 'invalid'; end if;
  if not exists (select 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = 'microsoft') then return 'not_connected'; end if;
  if exists (select 1 from public.career_outlook_state s where s.user_id = p_user and s.needs_reconnect_at is not null) then return 'needs_reconnect'; end if;
  -- Whoever the caller is (outreach, applications by email, any approved email): never a recipient who asked to stop,
  -- never an address that bounced (the send rail's career_send_bad_addresses, once it exists). Checked before the ledger
  -- row, so nothing is recorded as going.
  if exists (select 1 from public.career_outreach_dnc d where d.user_id = p_user and d.email_hash = p_recipient_hash) then return 'opted_out'; end if;
  if to_regclass('public.career_send_bad_addresses') is not null then
    execute 'select exists (select 1 from public.career_send_bad_addresses where email_hash = $1)' into bad using p_recipient_hash;
    if bad then return 'bounced'; end if;
  end if;
  insert into public.career_outlook_sends (user_id, idem_key, payload_hash, purpose, recipient_hash, status, attempts, created_at, updated_at)
  values (p_user, p_key, p_hash, p_purpose, p_recipient_hash, 'sending', 1, p_now, p_now)
  on conflict (user_id, idem_key) do nothing;
  if found then return 'go'; end if;
  select * into r from public.career_outlook_sends where user_id = p_user and idem_key = p_key for update;
  if r.payload_hash <> p_hash then return 'changed'; end if;
  if r.status in ('refused', 'rate_limited') then
    update public.career_outlook_sends set status = 'sending', attempts = attempts + 1, updated_at = p_now where user_id = p_user and idem_key = p_key;
    return 'go';
  end if;
  if r.status = 'sending' then return 'unknown'; end if; -- another call is sending it, or died mid-send: never twice
  return r.status;
end $$;

create or replace function public.career_outlook_send_finish(p_user uuid, p_key text, p_status text, p_detail text, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_status not in ('sent', 'refused', 'unknown', 'rate_limited') then raise exception 'invalid send status'; end if;
  update public.career_outlook_sends set status = p_status, detail = left(p_detail, 300), updated_at = p_now,
    sent_at = case when p_status = 'sent' then p_now else sent_at end
  where user_id = p_user and idem_key = p_key and status = 'sending';
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ------------------------------------------------------------------------------------------------ disconnect
-- The microsoft connection row deleted (disconnect, an account deletion, a direct delete): everything read from that
-- mailbox goes, every send not yet made is cancelled, every live link is burned. A reconnect is an upsert, never a delete.
create or replace function public.career_outlook_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.provider = 'microsoft' then
    delete from public.career_outlook_messages where user_id = old.user_id;
    delete from public.career_outlook_state where user_id = old.user_id;
    update public.career_outlook_sends set status = 'cancelled', detail = 'Outlook disconnected', updated_at = now()
      where user_id = old.user_id and status in ('sending', 'rate_limited', 'refused');
    update public.career_outlook_links set opened_at = coalesce(opened_at, now()), finished_at = now(), outcome = coalesce(outcome, 'error')
      where user_id = old.user_id and finished_at is null;
  end if;
  return old;
end $$;
drop trigger if exists user_oauth_connections_outlook_erase on public.user_oauth_connections;
create trigger user_oauth_connections_outlook_erase after delete on public.user_oauth_connections
  for each row execute function public.career_outlook_on_disconnect();

alter table public.career_outlook_links enable row level security;
alter table public.career_outlook_state enable row level security;
alter table public.career_outlook_messages enable row level security;
alter table public.career_outlook_sends enable row level security;
revoke all on public.career_outlook_links, public.career_outlook_state, public.career_outlook_messages, public.career_outlook_sends from public, anon, authenticated;
grant select, insert, update, delete on public.career_outlook_links, public.career_outlook_state, public.career_outlook_messages, public.career_outlook_sends to service_role;

revoke all on function public.career_outlook_link_issue(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_link_peek(text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_link_open(text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_link_finish(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_claim(text, text, timestamptz, int, int, int) from public, anon, authenticated;
revoke all on function public.career_outlook_release(text, uuid, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.career_outlook_send_begin(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_send_finish(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.career_outlook_on_disconnect() from public, anon, authenticated;
grant execute on function public.career_outlook_link_issue(uuid, text, uuid, text, timestamptz), public.career_outlook_link_peek(text, timestamptz),
  public.career_outlook_link_open(text, timestamptz), public.career_outlook_link_finish(uuid, text, timestamptz),
  public.career_outlook_claim(text, text, timestamptz, int, int, int), public.career_outlook_release(text, uuid, text, timestamptz, jsonb),
  public.career_outlook_send_begin(uuid, text, text, text, text, timestamptz), public.career_outlook_send_finish(uuid, text, text, text, timestamptz) to service_role;
