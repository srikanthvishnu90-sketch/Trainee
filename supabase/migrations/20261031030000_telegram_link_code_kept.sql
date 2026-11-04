-- TELEGRAM ROUND 3 (2026-10-31; tests/architect/scenarios-telegram-r3.test.ts "deeplink", tests/architect/flow-scenarios-telegram-r3.test.ts,
-- tests/db/telegram_link_code_kept.test.sql). "/start <code>" (Telegram's deep link, issued by Connect Telegram) opened from a chat
-- that is already ANOTHER account's linked nothing (linked_elsewhere, as it should) but used the code up first: the link was
-- forwarded, or opened on the wrong phone, and its owner then got "That link has expired or was already used" in their own chat.
-- The code is now used only when it links: a chat that is someone else's leaves it as it was (unused, its 10 minutes running).
-- Everything else is unchanged: a code that is forged, expired or used links nothing; a chat that is no one's, or already the
-- code owner's, is linked and the code is used; the owner's earlier Telegram chat is let go (one per channel).
-- Idempotent; service role only (SECURITY DEFINER, revoked from public, anon and authenticated below).
create or replace function public.channel_link_nonce_redeem(p_nonce text, p_contact text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; t uuid; other uuid; h text;
begin
  if p_nonce !~ '^[A-Za-z0-9_-]{1,64}$' or p_contact !~ '^tg:[1-9][0-9]{0,19}$' then return jsonb_build_object('error', 'invalid'); end if;
  h := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
  -- the code, held (a second redeem of the same code waits here), not yet used
  select n.user_id into u from public.channel_link_nonces n where n.nonce_hash = h and n.used_at is null and n.expires_at > p_now for update;
  if u is null then return jsonb_build_object('error', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text, 1));
  select c.user_id into other from public.channel_contacts c where c.contact = p_contact;
  if other is not null and other <> u then return jsonb_build_object('error', 'linked_elsewhere'); end if; -- the code stays unused
  update public.channel_link_nonces set used_at = p_now where nonce_hash = h and used_at is null;
  if not found then return jsonb_build_object('error', 'invalid'); end if;
  select c.thread_id into t from public.channel_contacts c where c.user_id = u and c.thread_id is not null order by c.last_inbound_at desc nulls last limit 1;
  update public.channel_contacts set user_id = null, thread_id = null, home = false, updated_at = p_now where user_id = u and channel = 'telegram' and contact <> p_contact;
  insert into public.channel_contacts(contact, user_id, thread_id, last_inbound_at, created_at, updated_at)
  values (p_contact, u, t, p_now, p_now, p_now)
  on conflict (contact) do update set user_id = u, thread_id = coalesce(excluded.thread_id, public.channel_contacts.thread_id), last_inbound_at = p_now, updated_at = p_now;
  return jsonb_build_object('user_id', u, 'thread_id', t);
end $$;
revoke all on function public.channel_link_nonce_redeem(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_link_nonce_redeem(text, text, timestamptz) to service_role;
