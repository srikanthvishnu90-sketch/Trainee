-- TELEGRAM LINK OWNERSHIP (2026-10-31; owner rule of 2026-10-29: "A signed, expiring, single-use link is not proof of who
-- opened it. An unused, forwarded or copied link must not let another person read my private data or act as me."). Tests:
-- tests/db/telegram_link_confirm.test.sql, tests/architect/scenarios-telegram-link-owner.test.ts,
-- tests/architect/flow-scenarios-telegram-link-owner.test.ts.
--
-- "/start <code>" (t.me/<bot>?start=<code>, made by "connect telegram" texted on iMessage or WhatsApp, or the app's Connect
-- Telegram) linked WHICHEVER Telegram chat opened it to the account it was made for: a forwarded, pasted or leaked link gave a
-- stranger's chat the account (its private data, its approvals). The code is made where Trainee does not know the Telegram
-- user who will open it, so it cannot be bound to that user in advance. Now opening the code only ASKS: the account's own
-- channel it already uses (the contact that is not stopped and wrote last, never the new chat) gets "Someone wants to link
-- Telegram @name to your Trainee. Reply YES to allow; ignore if this wasn't you.", through the outbox (kind link, so STOP holds
-- it), and the chat is linked only on that contact's own YES (channel_link_confirm), within 15 minutes, once. Until then the new
-- chat is no one's: it reads nothing of the account and approves nothing.
--   - The code is used when the question is asked: one code, one question, one chat. A second chat (a racing stranger, the
--     owner after a stranger) is told the code was used; the owner texts "connect telegram" for a new one.
--   - A chat that is already another account's links nothing and leaves the code unused (20261031030000, kept); a chat that is
--     already the account's own stays linked (nothing new is reached) and the code is used.
--   - No channel to ask (an account with no other contact) or the account is stopped: nothing is asked or linked, the code
--     stays unused, and the chat is told plainly.
--   - A YES with two questions open on the same contact, one of them a code's (two chats racing for the same person's yes),
--     links neither and closes both: a yes cannot say which it meant. A code's question whose contact said STOP since links
--     nothing on a later yes.
--   - channel_link_nonce_redeem (the old one-step link, kept for a handler deployed before this file) never links a chat that
--     is not already the account's; it leaves the code unused.
-- Idempotent; service role only (SECURITY DEFINER, revoked from public, anon and authenticated below).

alter table public.channel_link_requests alter column phone drop not null;
alter table public.channel_link_requests add column if not exists by_code boolean not null default false;
alter table public.channel_link_requests drop constraint if exists channel_link_requests_phone_or_code;
alter table public.channel_link_requests add constraint channel_link_requests_phone_or_code check (by_code or phone is not null);
create index if not exists channel_link_requests_code_open on public.channel_link_requests (contact) where by_code and answered_at is null;

-- "/start <code>" from a Telegram chat: asks the account's own channel; links only a chat that already is the account's.
-- Returns {asked, user_id, key} (the question queued in the outbox under key), {linked, user_id, thread_id} (the chat is
-- already the account's), or {error: invalid | linked_elsewhere | no_channel | stopped}.
create or replace function public.channel_link_nonce_ask(p_nonce text, p_contact text, p_text text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; t uuid; other uuid; h text; on_contact text; on_channel text; stopped boolean; rid bigint;
begin
  if p_now is null or p_nonce is null or p_contact is null or p_nonce !~ '^[A-Za-z0-9_-]{1,64}$' or p_contact !~ '^tg:[1-9][0-9]{0,19}$' then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_text is null or btrim(p_text) = '' or length(p_text) > 600 then raise exception 'invalid link question'; end if;
  h := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  -- the code, held (a second open of the same code waits here), not yet used
  select n.user_id into u from public.channel_link_nonces n where n.nonce_hash = h and n.used_at is null and n.expires_at > p_now for update;
  if u is null then return jsonb_build_object('error', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text, 1));
  select c.user_id, c.thread_id into other, t from public.channel_contacts c where c.contact = p_contact;
  if other is not null and other <> u then return jsonb_build_object('error', 'linked_elsewhere'); end if; -- the code stays unused
  if other = u then
    update public.channel_link_nonces set used_at = p_now where nonce_hash = h;
    return jsonb_build_object('linked', true, 'user_id', u, 'thread_id', t);
  end if;
  -- the channel the person already uses: a contact of the account other than this chat, one that is not stopped first, the
  -- one they wrote from last
  select c.contact, c.channel, public.channel_opted_out(c.contact) into on_contact, on_channel, stopped
  from public.channel_contacts c where c.user_id = u and c.contact <> p_contact
  order by public.channel_opted_out(c.contact), c.last_inbound_at desc nulls last, c.created_at, c.contact limit 1;
  if on_contact is null then return jsonb_build_object('error', 'no_channel'); end if; -- the code stays unused
  if stopped then return jsonb_build_object('error', 'stopped'); end if; -- the code stays unused
  update public.channel_link_nonces set used_at = p_now where nonce_hash = h;
  insert into public.channel_link_requests(user_id, contact, phone, asked_on, created_at, expires_at, by_code)
  values (u, p_contact, null, on_contact, p_now, p_now + interval '15 minutes', true) returning id into rid;
  insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel) values (u, 'link:' || rid, 'link', p_text, p_now, on_channel);
  return jsonb_build_object('asked', true, 'user_id', u, 'key', 'link:' || rid);
end $$;

-- A chat waiting for the account's yes to a code's question (it is told so, and nothing else happens there).
create or replace function public.channel_link_code_pending(p_contact text, p_now timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.channel_link_requests r
    where r.contact = p_contact and r.by_code and r.answered_at is null and r.expires_at > p_now)
$$;

-- The yes (20261030120000, kept), and: two questions open on the contact, one a code's, link neither; a code's question
-- whose contact is stopped links nothing.
create or replace function public.channel_link_confirm(p_user uuid, p_asked_on text, p_notice text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.channel_link_requests; t uuid; other uuid; ch text; open_n int; open_code boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  select * into r from public.channel_link_requests where user_id = p_user and asked_on = p_asked_on and answered_at is null and expires_at > p_now
  order by created_at desc, id desc limit 1 for update;
  if r.id is null then return null; end if;
  select count(*), coalesce(bool_or(by_code), false) into open_n, open_code from public.channel_link_requests
  where user_id = p_user and asked_on = p_asked_on and answered_at is null and expires_at > p_now;
  if open_n > 1 and open_code then
    update public.channel_link_requests set answered_at = p_now
    where user_id = p_user and asked_on = p_asked_on and answered_at is null and expires_at > p_now;
    return jsonb_build_object('error', 'ambiguous');
  end if;
  update public.channel_link_requests set answered_at = p_now where id = r.id;
  if r.by_code and public.channel_opted_out(p_asked_on) then return null; end if;
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

-- The old one-step link: it never links a chat that is not already the account's (the code stays unused).
create or replace function public.channel_link_nonce_redeem(p_nonce text, p_contact text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; t uuid; other uuid; h text;
begin
  if p_now is null or p_nonce is null or p_contact is null or p_nonce !~ '^[A-Za-z0-9_-]{1,64}$' or p_contact !~ '^tg:[1-9][0-9]{0,19}$' then
    return jsonb_build_object('error', 'invalid');
  end if;
  h := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  select n.user_id into u from public.channel_link_nonces n where n.nonce_hash = h and n.used_at is null and n.expires_at > p_now for update;
  if u is null then return jsonb_build_object('error', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text, 1));
  select c.user_id, c.thread_id into other, t from public.channel_contacts c where c.contact = p_contact;
  if other is not null and other <> u then return jsonb_build_object('error', 'linked_elsewhere'); end if; -- the code stays unused
  if other is null then return jsonb_build_object('error', 'invalid'); end if; -- no one's chat: never linked here; the code stays unused
  update public.channel_link_nonces set used_at = p_now where nonce_hash = h;
  return jsonb_build_object('user_id', u, 'thread_id', t);
end $$;

revoke all on function public.channel_link_nonce_ask(text, text, text, timestamptz), public.channel_link_code_pending(text, timestamptz),
  public.channel_link_confirm(uuid, text, text, timestamptz), public.channel_link_nonce_redeem(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.channel_link_nonce_ask(text, text, text, timestamptz), public.channel_link_code_pending(text, timestamptz),
  public.channel_link_confirm(uuid, text, text, timestamptz), public.channel_link_nonce_redeem(text, text, timestamptz)
  to service_role;
