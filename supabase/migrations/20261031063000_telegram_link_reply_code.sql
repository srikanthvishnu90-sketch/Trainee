-- TELEGRAM LINK REPLY CODE (2026-10-31; security review #348 of 20261031040000_telegram_link_confirm.sql, which stays as it
-- was). Tests: tests/db/telegram_link_reply_code.test.sql, tests/telegram-link-reply-code.test.ts.
--
-- The hole: a stranger holding a leaked "connect telegram" code opened it, which put a pending link question on the owner's own
-- channel; the owner's next plain "yes" (even one meant for an application card) was taken by channel_link_confirm as the
-- answer to that question and linked the stranger's chat to the account. Nothing bound the yes to the question.
-- Now:
--   - Opening a code asks the owner's channel with a 4-digit reply code made here, for that one request (channel_link_requests
--     .reply_code), shown only in the question queued to the owner's own channel ("reply LINK 1234"). The handler's question
--     text carries the placeholder {code}, which is filled here; a question without it asks nothing (the code stays unused).
--   - Only "LINK <that code>" from the asked contact, within the request's 15 minutes, links the chat (channel_link_confirm_code),
--     once (answered_at). Five wrong codes on that contact close its open link questions.
--   - channel_link_confirm (the plain yes) never answers a code's question any more: it answers only a same-number question
--     (20261030120000), so a plain yes goes on to whatever the person was answering (a card).
--   - At most 3 code questions open per account: a 4th opening asks nothing and leaves its code unused ({error: busy}).
--   - A code's question opened before this file has no reply code: it can no longer be answered (it expires).
-- Idempotent; service role only (SECURITY DEFINER, revoked from public, anon and authenticated below).

alter table public.channel_link_requests add column if not exists reply_code text;
alter table public.channel_link_requests add column if not exists wrong_tries int not null default 0;
alter table public.channel_link_requests drop constraint if exists channel_link_requests_reply_code_shape;
alter table public.channel_link_requests add constraint channel_link_requests_reply_code_shape check (reply_code is null or (by_code and reply_code ~ '^[0-9]{4}$'));

-- "/start <code>" from a Telegram chat. p_text is the question for the owner's channel and must hold {code} once.
-- Returns {asked, user_id, key}, {linked, user_id, thread_id} (the chat already is the account's), or
-- {error: invalid | linked_elsewhere | no_channel | stopped | busy}.
create or replace function public.channel_link_nonce_ask(p_nonce text, p_contact text, p_text text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; t uuid; other uuid; h text; on_contact text; on_channel text; stopped boolean; rid bigint; open_n int; rc text; tries int := 0;
begin
  if p_now is null or p_nonce is null or p_contact is null or p_nonce !~ '^[A-Za-z0-9_-]{1,64}$' or p_contact !~ '^tg:[1-9][0-9]{0,19}$' then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_text is null or btrim(p_text) = '' or length(p_text) > 600 then raise exception 'invalid link question'; end if;
  -- a question with no place for its reply code (a handler from before this file) asks nothing; the code stays unused
  if (length(p_text) - length(replace(p_text, '{code}', ''))) / 6 <> 1 then return jsonb_build_object('error', 'invalid'); end if;
  h := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  select n.user_id into u from public.channel_link_nonces n where n.nonce_hash = h and n.used_at is null and n.expires_at > p_now for update;
  if u is null then return jsonb_build_object('error', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text, 1));
  select c.user_id, c.thread_id into other, t from public.channel_contacts c where c.contact = p_contact;
  if other is not null and other <> u then return jsonb_build_object('error', 'linked_elsewhere'); end if; -- the code stays unused
  if other = u then
    update public.channel_link_nonces set used_at = p_now where nonce_hash = h;
    return jsonb_build_object('linked', true, 'user_id', u, 'thread_id', t);
  end if;
  select c.contact, c.channel, public.channel_opted_out(c.contact) into on_contact, on_channel, stopped
  from public.channel_contacts c where c.user_id = u and c.contact <> p_contact
  order by public.channel_opted_out(c.contact), c.last_inbound_at desc nulls last, c.created_at, c.contact limit 1;
  if on_contact is null then return jsonb_build_object('error', 'no_channel'); end if; -- the code stays unused
  if stopped then return jsonb_build_object('error', 'stopped'); end if; -- the code stays unused
  select count(*) into open_n from public.channel_link_requests where user_id = u and by_code and answered_at is null and expires_at > p_now;
  if open_n >= 3 then return jsonb_build_object('error', 'busy'); end if; -- the code stays unused
  -- the reply code: 4 digits from gen_random_uuid (a strong random source), not one already open on that contact
  loop
    rc := lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::int & 2147483647) % 10000)::text, 4, '0');
    exit when not exists (select 1 from public.channel_link_requests where user_id = u and asked_on = on_contact and by_code
      and answered_at is null and expires_at > p_now and reply_code = rc);
    tries := tries + 1;
    if tries > 50 then raise exception 'no free link reply code'; end if;
  end loop;
  update public.channel_link_nonces set used_at = p_now where nonce_hash = h;
  insert into public.channel_link_requests(user_id, contact, phone, asked_on, created_at, expires_at, by_code, reply_code)
  values (u, p_contact, null, on_contact, p_now, p_now + interval '15 minutes', true, rc) returning id into rid;
  insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel)
  values (u, 'link:' || rid, 'link', replace(p_text, '{code}', rc), p_now, on_channel);
  return jsonb_build_object('asked', true, 'user_id', u, 'key', 'link:' || rid);
end $$;

-- The plain yes: answers only a same-number question (20261030120000); a code's question is never answered by it.
create or replace function public.channel_link_confirm(p_user uuid, p_asked_on text, p_notice text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.channel_link_requests; t uuid; other uuid; ch text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  select * into r from public.channel_link_requests where user_id = p_user and asked_on = p_asked_on and not by_code
    and answered_at is null and expires_at > p_now
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

-- "LINK <code>" from the asked contact: links the one request that code was made for, once, within its 15 minutes.
-- Returns {contact, key} or {error: no_match | stopped | linked_elsewhere}.
create or replace function public.channel_link_confirm_code(p_user uuid, p_asked_on text, p_code text, p_notice text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.channel_link_requests; t uuid; other uuid; ch text;
begin
  if p_user is null or p_asked_on is null or p_now is null then return jsonb_build_object('error', 'no_match'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
  if p_code is not null and p_code ~ '^[0-9]{4}$' then
    select * into r from public.channel_link_requests where user_id = p_user and asked_on = p_asked_on and by_code and reply_code = p_code
      and answered_at is null and expires_at > p_now
    order by created_at desc, id desc limit 1 for update;
  end if;
  if r.id is null then
    -- a wrong code counts against the contact's open code questions; the fifth closes them
    update public.channel_link_requests set wrong_tries = wrong_tries + 1,
      answered_at = case when wrong_tries + 1 >= 5 then p_now else answered_at end
    where user_id = p_user and asked_on = p_asked_on and by_code and answered_at is null and expires_at > p_now;
    return jsonb_build_object('error', 'no_match');
  end if;
  update public.channel_link_requests set answered_at = p_now where id = r.id;
  if public.channel_opted_out(p_asked_on) then return jsonb_build_object('error', 'stopped'); end if;
  select user_id into other from public.channel_contacts where contact = r.contact;
  if other is not null and other <> p_user then return jsonb_build_object('error', 'linked_elsewhere'); end if;
  select thread_id into t from public.channel_contacts where contact = p_asked_on;
  update public.channel_contacts set user_id = null, thread_id = null, home = false, updated_at = p_now
  where user_id = p_user and channel = 'telegram' and contact <> r.contact;
  insert into public.channel_contacts(contact, user_id, thread_id, phone, created_at, updated_at)
  values (r.contact, p_user, t, null, p_now, p_now)
  on conflict (contact) do update set user_id = p_user, thread_id = coalesce(public.channel_contacts.thread_id, excluded.thread_id), updated_at = p_now
  returning channel into ch;
  insert into public.career_outbox(user_id, key, kind, text, deliver_at, channel) values (p_user, 'link:' || r.id || ':done', 'link', p_notice, p_now, ch)
  on conflict do nothing;
  return jsonb_build_object('contact', r.contact, 'key', 'link:' || r.id || ':done');
end $$;

revoke all on function public.channel_link_nonce_ask(text, text, text, timestamptz), public.channel_link_confirm(uuid, text, text, timestamptz),
  public.channel_link_confirm_code(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.channel_link_nonce_ask(text, text, text, timestamptz), public.channel_link_confirm(uuid, text, text, timestamptz),
  public.channel_link_confirm_code(uuid, text, text, text, timestamptz)
  to service_role;
