-- CHANNEL DELIVERY ROUND 2 (2026-10-30): honest states when a channel goes away or a provider fails part way. Additive and
-- idempotent; every existing function keeps its signature and every other rule of 20261021070000_channel_parity.sql and
-- 20261030000000_career_outbox_parts_order.sql.
--
-- 1. career_outbox.sent_parts: how many of a row's messages (its rendered bubbles) went out before an attempt stopped (a
--    429 or WhatsApp's window on the 2nd+ message). The next attempt sends only the rest. Before, a 429 asking for more
--    than 30 s on message 2 of 3 ended the row "failed after 1 of 3 messages went out" and the rest was never sent; WhatsApp
--    131047 on message 2 did the same. provider_ids keeps every id, in order (a single one too).
-- 2. career_outbox_rehold (a WhatsApp "failed" status for the window): the row resumes from the message that failed, not
--    from the start (the messages before it were delivered and went again), and the ids from it on are dropped, so a late
--    copy of the same status (Meta retries webhooks; statuses arrive out of order) no longer holds the row a second time
--    after it was sent again (it was sent a third time).
-- 3. career_outbox_fail_sent: any other "failed" status (WhatsApp 131026 undeliverable, a LoopMessage message_failed) marked
--    nothing: the row stayed "delivered". Now it is failed with the reason; a throughput refusal (130429...) goes again
--    from that message, at most as often as any retry.
-- 4. career_outbox_reroute: a row bound to a channel the person no longer has (Telegram unlinked, a WhatsApp number moved
--    or given to someone else) was never claimed (channel_target is null) and stayed queued forever, said nowhere. Now it
--    goes to the person's home channel; with no channel left at all, it fails with the reason.
-- 5. channel_contact_release / channel_wa_number_moved: a WhatsApp number now another person's (another business-scoped
--    id wrote from it) is let go from the old account; a person who changed their number (Meta's user_changed_number) keeps
--    their account on the new one.
-- 6. channel_set_home: what WhatsApp's window held for the home channel goes back in the queue when the home changes, so it
--    goes out on the new home instead of waiting for a WhatsApp message that may never come.
alter table public.career_outbox add column if not exists sent_parts int not null default 0;
alter table public.career_outbox drop constraint if exists career_outbox_sent_parts;
alter table public.career_outbox add constraint career_outbox_sent_parts check (sent_parts >= 0);

create or replace function public.career_outbox_rehold(p_provider_id text, p_at timestamptz, p_error text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.career_outbox o set status = 'held', delivered_at = null, error = left(p_error, 500), claimed_at = null, retry_at = null,
    sent_parts = coalesce(array_position(o.provider_ids, p_provider_id) - 1, 0),
    provider_id = case when coalesce(array_position(o.provider_ids, p_provider_id), 1) > 1 then o.provider_ids[1] end,
    provider_ids = case when coalesce(array_position(o.provider_ids, p_provider_id), 1) > 1 then o.provider_ids[1:array_position(o.provider_ids, p_provider_id) - 1] end
  where o.status = 'delivered' and (o.provider_id = p_provider_id or o.provider_ids @> array[p_provider_id]);
  get diagnostics n = row_count;
  return n + public.career_outbox_sent_back(p_provider_id);
end $$;

-- Statuses arrive out of order: message 3's "failed" may come before message 2's. A row already held (or failed) by a later
-- message's status goes back to the earlier message that failed too, so that one is sent again as well (it was lost).
create or replace function public.career_outbox_sent_back(p_provider_id text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.career_outbox o set sent_parts = array_position(o.provider_ids, p_provider_id) - 1,
    provider_id = case when array_position(o.provider_ids, p_provider_id) > 1 then o.provider_ids[1] end,
    provider_ids = case when array_position(o.provider_ids, p_provider_id) > 1 then o.provider_ids[1:array_position(o.provider_ids, p_provider_id) - 1] end
  where o.status in ('held', 'failed') and o.provider_ids @> array[p_provider_id];
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.career_outbox_fail_sent(p_provider_id text, p_at timestamptz, p_error text, p_retry boolean) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_provider_id is null or p_provider_id = '' then return 0; end if;
  update public.career_outbox o set status = 'failed', delivered_at = null, error = left(p_error, 500), claimed_at = null,
    attempts = least(o.attempts + 1, 10),
    retry_at = case when coalesce(p_retry, false) and o.attempts + 1 < 3 then p_at + interval '1 minute' end,
    sent_parts = coalesce(array_position(o.provider_ids, p_provider_id) - 1, 0),
    provider_id = case when coalesce(array_position(o.provider_ids, p_provider_id), 1) > 1 then o.provider_ids[1] end,
    provider_ids = case when coalesce(array_position(o.provider_ids, p_provider_id), 1) > 1 then o.provider_ids[1:array_position(o.provider_ids, p_provider_id) - 1] end
  where o.status = 'delivered' and (o.provider_id = p_provider_id or o.provider_ids @> array[p_provider_id]);
  get diagnostics n = row_count;
  return n + public.career_outbox_sent_back(p_provider_id);
end $$;

create or replace function public.career_outbox_reroute(p_now timestamptz) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; m int;
begin
  update public.career_outbox o set channel = null, status = case when o.status = 'held' then 'queued' else o.status end,
    sent_parts = 0, provider_id = null, provider_ids = null
  where o.channel is not null and (o.status in ('queued', 'held') or (o.status = 'failed' and o.retry_at is not null))
    and not exists (select from public.channel_contacts c where c.user_id = o.user_id and c.channel = o.channel)
    and exists (select from public.channel_contacts c where c.user_id = o.user_id);
  get diagnostics n = row_count;
  update public.career_outbox o set status = 'failed', retry_at = null, claimed_at = null,
    error = 'not sent: the channel this answers was unlinked and the person has no other texting channel'
  where o.channel is not null and (o.status in ('queued', 'held') or (o.status = 'failed' and o.retry_at is not null))
    and not exists (select from public.channel_contacts c where c.user_id = o.user_id);
  get diagnostics m = row_count;
  return n + m;
end $$;

create or replace function public.channel_contact_release(p_contact text, p_at timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  select user_id into u from public.channel_contacts where contact = p_contact;
  if u is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text, 1));
  -- The row goes: the number is someone else's now, and a stranger's first message is told about sign-up once (a row left
  -- behind read as "told before", and the new owner got silence).
  delete from public.channel_contacts where contact = p_contact and user_id = u;
  return u;
end $$;

create or replace function public.channel_wa_number_moved(p_old text, p_new text, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.channel_contacts; digits text := substr(p_new, 4);
begin
  if p_old !~ '^wa:[A-Za-z0-9._-]{1,128}$' or p_new !~ '^wa:[0-9]{6,20}$' or p_old = p_new then return false; end if;
  select * into c from public.channel_contacts where contact = p_old;
  if c.user_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.user_id::text, 1));
  if exists (select from public.channel_contacts where contact = p_new and user_id is not null and user_id <> c.user_id) then return false; end if;
  update public.channel_contacts set user_id = null, thread_id = null, home = false, alias = null, nudged_at = null,
    opted_out = false, opted_out_at = null, updated_at = p_at
  where contact = p_old;
  insert into public.channel_contacts(contact, user_id, thread_id, home, alias, phone, opted_out, opted_out_at, last_inbound_at, created_at, updated_at)
  values (p_new, c.user_id, c.thread_id, c.home, c.alias, case when length(digits) between 8 and 15 then '+' || digits end,
    c.opted_out, c.opted_out_at, c.last_inbound_at, p_at, p_at)
  on conflict (contact) do update set user_id = excluded.user_id, thread_id = excluded.thread_id, home = excluded.home,
    alias = coalesce(excluded.alias, public.channel_contacts.alias), phone = coalesce(excluded.phone, public.channel_contacts.phone),
    opted_out = excluded.opted_out, opted_out_at = excluded.opted_out_at,
    last_inbound_at = greatest(public.channel_contacts.last_inbound_at, excluded.last_inbound_at), updated_at = p_at;
  return true;
end $$;

create or replace function public.channel_set_home(p_channel text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_channel not in ('imessage', 'whatsapp', 'telegram') then raise exception 'invalid home channel'; end if;
  if not exists (select from public.channel_contacts where user_id = auth.uid() and channel = p_channel) then return false; end if;
  update public.channel_contacts set home = (channel = p_channel), updated_at = now() where user_id = auth.uid();
  update public.career_outbox set status = 'queued', error = null where user_id = auth.uid() and status = 'held' and channel is null;
  return true;
end $$;

revoke all on function public.career_outbox_fail_sent(text, timestamptz, text, boolean), public.career_outbox_reroute(timestamptz), public.career_outbox_sent_back(text),
  public.channel_contact_release(text, timestamptz), public.channel_wa_number_moved(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.career_outbox_fail_sent(text, timestamptz, text, boolean), public.career_outbox_reroute(timestamptz), public.career_outbox_sent_back(text),
  public.channel_contact_release(text, timestamptz), public.channel_wa_number_moved(text, text, timestamptz) to service_role;
-- Redefined here (20261021070000 made both): restated in this file, as every definer function must be (career-definer-revoke).
-- career_outbox_rehold is the service role's (the inbound webhook); channel_set_home is the signed-in person's own (auth.uid()).
revoke all on function public.career_outbox_rehold(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.career_outbox_rehold(text, timestamptz, text) to service_role;
revoke all on function public.channel_set_home(text) from public, anon;
grant execute on function public.channel_set_home(text) to authenticated;
