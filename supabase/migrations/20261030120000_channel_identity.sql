-- IDENTITY SCENARIOS (2026-10-30): multi-channel identity and account linking, found by the identity battery
-- (tests/architect/scenarios-identity.test.ts) and the Postgres journeys (tests/architect/flow-scenarios-identity.test.ts).
-- Additive and idempotent. NOT APPLIED: the owner applies migrations.
--
-- 1. channel_link_requests.contact refused a Telegram chat (its check allowed only a phone or wa:<id>), so Telegram's own
--    "Share my phone number" from a chat whose number already had Trainee on iMessage or WhatsApp raised a check violation:
--    the person read "I couldn't answer that just now" and the question was never asked. A tg:<chat id> may ask now.
-- 2. channel_contacts_derive cleared the number on every Telegram contact, so a person who signed up on Telegram by sharing
--    their number, then texted from that number on iMessage or WhatsApp, was never asked on Telegram: the number signed up a
--    second time (Auth keeps one account per phone, so every message there read "I couldn't answer that"). A Telegram
--    contact keeps a number now; the only writers that give it one are the person's own share (Telegram's verified number:
--    the sign-up it made, or the link question it asked). channel_inbound_seen still records a number for WhatsApp only.
-- 3. channel_link_candidate skipped a contact that said STOP, and only that contact: the number then signed up a second
--    time; and an account stopped on another of its channels was asked anyway, a question STOP held unseen (STOP is the
--    person's: channel_opted_out). channel_link_candidate_of returns the number's account with opted_out (the person's
--    STOP), an account that is not stopped first; the inbound core says so instead of asking or signing up.
create or replace function public.channel_contacts_derive() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.channel := case when new.contact like 'wa:%' then 'whatsapp' when new.contact like 'tg:%' then 'telegram' else 'imessage' end;
  new.address := case when new.channel = 'imessage' then new.contact else substr(new.contact, 4) end;
  if new.channel = 'imessage' and new.contact like '+%' then new.phone := new.contact; end if;
  return new;
end $$;
revoke all on function public.channel_contacts_derive() from public, anon, authenticated;

alter table public.channel_link_requests drop constraint if exists channel_link_requests_contact_check;
alter table public.channel_link_requests add constraint channel_link_requests_contact_check
  check (contact ~ '^(\+[0-9]{8,15}|wa:[A-Za-z0-9._-]{1,128}|tg:[1-9][0-9]{0,19})$');

-- A new function (the old one's return type cannot change in place, and an older migration replayed over this one must still
-- apply): the inbound store reads this one; channel_link_candidate stays as it was, unused.
create or replace function public.channel_link_candidate_of(p_phone text, p_except text) returns table (user_id uuid, contact text, opted_out boolean)
language sql stable security definer set search_path = public as $$
  select c.user_id, c.contact, public.channel_opted_out(c.contact) as opted_out from public.channel_contacts c
  where c.phone = p_phone and c.user_id is not null and c.channel <> p_except
  order by public.channel_opted_out(c.contact), c.last_inbound_at desc nulls last, c.created_at, c.contact limit 1
$$;
revoke all on function public.channel_link_candidate_of(text, text) from public, anon, authenticated;
grant execute on function public.channel_link_candidate_of(text, text) to service_role;

-- 4. channel_link_confirm: the yes for a chat on a channel the account already has (a second Telegram account sharing the
--    same number, a WhatsApp number other than the one already linked) broke the one-contact-per-channel rule: the yes
--    raised a unique violation, the person read "I couldn't answer that just now", and every later yes did the same. As a
--    link token does (channel_link_nonce_redeem), the yes now moves the account to the new chat on that channel: the
--    earlier one is let go (it keeps its STOP history, no longer the account's). A new contact that is someone else's by
--    then links nothing, as before.
create or replace function public.channel_link_confirm(p_user uuid, p_asked_on text, p_notice text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.channel_link_requests; t uuid; other uuid; ch text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  select * into r from public.channel_link_requests where user_id = p_user and asked_on = p_asked_on and answered_at is null and expires_at > p_now
  order by created_at desc, id desc limit 1 for update;
  if r.id is null then return null; end if;
  update public.channel_link_requests set answered_at = p_now where id = r.id;
  select user_id into other from public.channel_contacts where contact = r.contact;
  if other is not null and other <> p_user then return null; end if;
  select thread_id into t from public.channel_contacts where contact = p_asked_on;
  ch := case when r.contact like 'wa:%' then 'whatsapp' when r.contact like 'tg:%' then 'telegram' else 'imessage' end;
  update public.channel_contacts set user_id = null, thread_id = null, home = false, updated_at = p_now
  where user_id = p_user and channel = ch and contact <> r.contact;
  insert into public.channel_contacts(contact, user_id, thread_id, phone, created_at, updated_at)
  values (r.contact, p_user, t, r.phone, p_now, p_now)
  on conflict (contact) do update set user_id = p_user, thread_id = coalesce(public.channel_contacts.thread_id, excluded.thread_id), updated_at = p_now
  returning channel into ch;
  insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel) values (p_user, 'link:' || r.id || ':done', 'link', p_notice, p_now, ch)
  on conflict do nothing;
  return jsonb_build_object('contact', r.contact, 'key', 'link:' || r.id || ':done');
end $$;
revoke all on function public.channel_link_confirm(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_link_confirm(uuid, text, text, timestamptz) to service_role;

-- 5. "Told before" was "a contact row exists": a row left by something else read as a refusal already said, and the person got
--    silence for good: a Telegram chat unlinked from the web (its row kept for its STOP history), the old number of a person
--    who moved, a number that asked to be linked and was never answered, a number whose account was deleted while its question
--    waited. refused_at now records the sign-up refusal itself, once; a contact that gets an account starts afresh.
alter table public.channel_contacts add column if not exists refused_at timestamptz;
create or replace function public.channel_refused_before(p_contact text, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare prior timestamptz;
begin
  if p_contact is null or p_at is null then raise exception 'invalid refusal'; end if;
  insert into public.channel_contacts(contact, refused_at, created_at, updated_at) values (p_contact, p_at, p_at, p_at)
  on conflict (contact) do nothing;
  if found then return false; end if;
  select refused_at into prior from public.channel_contacts where contact = p_contact for update;
  if prior is not null then return true; end if;
  update public.channel_contacts set refused_at = p_at, updated_at = p_at where contact = p_contact;
  return false;
end $$;
revoke all on function public.channel_refused_before(text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_refused_before(text, timestamptz) to service_role;
create or replace function public.channel_contacts_refusal_reset() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.user_id is not null then new.refused_at := null; end if;
  return new;
end $$;
revoke all on function public.channel_contacts_refusal_reset() from public, anon, authenticated;
drop trigger if exists channel_contacts_refusal_reset on public.channel_contacts;
create trigger channel_contacts_refusal_reset before insert or update of user_id on public.channel_contacts
  for each row execute function public.channel_contacts_refusal_reset();

-- 6. A Telegram chat waiting for its yes carries no number on its next message (only the share did), so a typed message from
--    it went on to sign-up: with sign-up open a second account for the same person, and the yes then linked nothing (the chat
--    was someone else's by then). The open question is found by the chat itself: the contact it was asked on, or null.
create or replace function public.channel_link_pending(p_contact text, p_now timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select r.asked_on from public.channel_link_requests r
  where r.contact = p_contact and r.answered_at is null and r.expires_at > p_now
  order by r.created_at desc, r.id desc limit 1
$$;
revoke all on function public.channel_link_pending(text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_link_pending(text, timestamptz) to service_role;
