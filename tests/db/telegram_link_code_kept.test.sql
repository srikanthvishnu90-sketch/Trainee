-- TELEGRAM ROUND 3 (20261031030000_telegram_link_code_kept.sql), in the database alone and deterministic (every instant is passed
-- in): "/start <code>" from a chat that is another account's links nothing AND leaves the code unused, so its owner's own chat can
-- still use it; a forged, malformed, expired or used code links nothing; a chat that is no one's is linked and the code used, once;
-- the owner's earlier Telegram chat is let go; service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c3a01'; b uuid := '00000000-0000-4000-8000-0000000c3a02';
  t0 timestamptz := timestamptz '2026-11-02 15:00:00+00';
  code text; code2 text; r jsonb; used timestamptz; owner uuid; n int;
begin
  insert into auth.users(id, email) values (a, 'tg3-a@example.test'), (b, 'tg3-b@example.test');
  insert into public.channel_contacts(contact, user_id, created_at, updated_at) values ('tg:7300000001', b, t0, t0), ('tg:7300000009', a, t0, t0);
  code := public.channel_link_nonce_issue(a, t0);

  -- someone else's chat (b's) opens a's code: nothing changes for that chat, and the code is NOT used up
  r := public.channel_link_nonce_redeem(code, 'tg:7300000001', t0 + interval '1 minute');
  if r->>'error' is distinct from 'linked_elsewhere' then raise exception 'FAIL another account''s chat: want linked_elsewhere, got %', r; end if;
  select user_id into owner from public.channel_contacts where contact = 'tg:7300000001';
  if owner <> b then raise exception 'FAIL another account''s chat moved to %', owner; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is not null then raise exception 'FAIL the code was used up by a chat it never linked (used_at %)', used; end if;
  raise notice 'ok   a chat that is another account''s links nothing and leaves the code unused';

  -- the owner's own (new) chat: linked, the code used, the owner's earlier Telegram chat let go
  r := public.channel_link_nonce_redeem(code, 'tg:7300000002', t0 + interval '2 minutes');
  if (r->>'user_id')::uuid is distinct from a then raise exception 'FAIL the owner''s chat after the refusal: got %', r; end if;
  select user_id into owner from public.channel_contacts where contact = 'tg:7300000002';
  if owner <> a then raise exception 'FAIL the owner''s chat is not linked (%)', owner; end if;
  select count(*) into n from public.channel_contacts where contact = 'tg:7300000009' and user_id is not null;
  if n <> 0 then raise exception 'FAIL the owner''s earlier Telegram chat was kept'; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is distinct from t0 + interval '2 minutes' then raise exception 'FAIL the code was not used when it linked (%)', used; end if;
  raise notice 'ok   the owner''s own chat then links with the same code, once; the earlier Telegram chat is let go';

  -- used: a second chat gets nothing
  r := public.channel_link_nonce_redeem(code, 'tg:7300000003', t0 + interval '3 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a used code: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7300000003' and user_id is not null) then raise exception 'FAIL a used code linked a chat'; end if;
  -- expired: 10 minutes and a second after it was made
  code2 := public.channel_link_nonce_issue(a, t0);
  r := public.channel_link_nonce_redeem(code2, 'tg:7300000004', t0 + interval '10 minutes 1 second');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL an expired code: %', r; end if;
  -- an expired code opened by another account's chat: invalid (not linked_elsewhere: it says nothing about the code)
  r := public.channel_link_nonce_redeem(code2, 'tg:7300000001', t0 + interval '11 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL an expired code from another account''s chat: %', r; end if;
  -- forged and malformed
  r := public.channel_link_nonce_redeem(reverse(code2), 'tg:7300000005', t0 + interval '1 minute');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a forged code: %', r; end if;
  r := public.channel_link_nonce_redeem(code2 || '!', 'tg:7300000005', t0 + interval '1 minute');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a malformed code: %', r; end if;
  r := public.channel_link_nonce_redeem(code2, 'tg:-100123', t0 + interval '1 minute');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a group chat: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact in ('tg:7300000004', 'tg:7300000005') and user_id is not null) then raise exception 'FAIL an invalid code linked a chat'; end if;
  raise notice 'ok   a used, expired, forged or malformed code, or a group, links nothing';

  -- the chat already the owner's, opening a live code of the owner's: linked (unchanged), the code used
  code2 := public.channel_link_nonce_issue(a, t0 + interval '20 minutes');
  r := public.channel_link_nonce_redeem(code2, 'tg:7300000002', t0 + interval '21 minutes');
  if (r->>'user_id')::uuid is distinct from a then raise exception 'FAIL the owner''s own chat with a live code: %', r; end if;
  raise notice 'ok   the owner''s own linked chat with a live code stays linked';

  if has_function_privilege('anon', 'public.channel_link_nonce_redeem(text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_nonce_redeem(text, text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.channel_link_nonce_redeem(text, text, timestamptz)', 'execute') then
    raise exception 'FAIL channel_link_nonce_redeem must be service-role only';
  end if;
  raise notice 'ok   service role only';
end $$;
rollback;
