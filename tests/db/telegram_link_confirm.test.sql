-- TELEGRAM LINK OWNERSHIP (20261031040000_telegram_link_confirm.sql), in the database alone and deterministic (every instant is
-- passed in): opening a link code links nothing; it asks the account's own channel (a contact that is not stopped, the one written
-- from last) through the outbox and uses the code; only that contact's YES (channel_link_confirm) links the chat, within 15
-- minutes, once. A second chat gets nothing from the code; a yes from another contact, a late yes, a yes after STOP, a yes with a
-- second chat's question open, an account deleted: nothing linked. A stopped account or one with no channel is not asked and keeps
-- its code. The old one-step redeem links no new chat. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c4a01'; b uuid := '00000000-0000-4000-8000-0000000c4a02';
  c uuid := '00000000-0000-4000-8000-0000000c4a03'; d uuid := '00000000-0000-4000-8000-0000000c4a04';
  t0 timestamptz := timestamptz '2026-11-03 15:00:00+00';
  home text := '+15550400001'; ask text := 'Someone wants to link Telegram @stranger_1 to your Trainee. Reply YES to allow; ignore if this wasn''t you.';
  code text; code2 text; r jsonb; used timestamptz; owner uuid; n int; k text;
begin
  insert into auth.users(id, email) values (a, 'tgl-a@example.test'), (b, 'tgl-b@example.test'), (c, 'tgl-c@example.test'), (d, 'tgl-d@example.test');
  insert into public.channel_contacts(contact, user_id, thread_id, last_inbound_at, created_at, updated_at) values
    (home, a, null, t0 - interval '1 hour', t0 - interval '2 hours', t0 - interval '2 hours'),
    ('wa:15550400009', a, null, t0 - interval '3 hours', t0 - interval '3 hours', t0 - interval '3 hours'),
    ('+15550400002', b, null, t0 - interval '1 hour', t0 - interval '1 hour', t0 - interval '1 hour'),
    ('tg:7400000099', b, null, t0 - interval '1 hour', t0 - interval '1 hour', t0 - interval '1 hour'),
    ('+15550400004', d, null, t0 - interval '1 hour', t0 - interval '1 hour', t0 - interval '1 hour');

  -- 1. a stranger's chat opens the forwarded code: asked on the account's own channel, nothing linked, the code used
  code := public.channel_link_nonce_issue(a, t0);
  r := public.channel_link_nonce_ask(code, 'tg:7400000001', ask, t0 + interval '1 minute');
  if r->>'asked' is distinct from 'true' or (r->>'user_id')::uuid is distinct from a then raise exception 'FAIL a stranger''s open: want asked, got %', r; end if;
  k := r->>'key';
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000001' and user_id is not null) then raise exception 'FAIL the opener''s chat was linked before the YES'; end if;
  select count(*) into n from public.career_outbox where user_id = a and key = k and kind = 'link' and channel = 'imessage' and text = ask;
  if n <> 1 then raise exception 'FAIL the question is not queued once on the account''s iMessage (%)', n; end if;
  select count(*) into n from public.channel_link_requests where user_id = a and contact = 'tg:7400000001' and asked_on = home and by_code and phone is null
    and expires_at = t0 + interval '16 minutes' and answered_at is null;
  if n <> 1 then raise exception 'FAIL the open question (%)', n; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is distinct from t0 + interval '1 minute' then raise exception 'FAIL the code was not used by its question (%)', used; end if;
  if not public.channel_link_code_pending('tg:7400000001', t0 + interval '2 minutes') then raise exception 'FAIL the chat does not read as waiting'; end if;
  if public.channel_link_code_pending('tg:7400000003', t0 + interval '2 minutes') then raise exception 'FAIL another chat reads as waiting'; end if;
  raise notice 'ok   a stranger opening the code links nothing; the account''s own channel is asked once; the code is used';

  -- 2. the same code again (a racing stranger, the owner after the stranger): nothing, no second question
  r := public.channel_link_nonce_ask(code, 'tg:7400000003', ask, t0 + interval '2 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a used code opened again: %', r; end if;
  select count(*) into n from public.channel_link_requests where user_id = a;
  if n <> 1 then raise exception 'FAIL one code asked % questions', n; end if;
  raise notice 'ok   one code, one question';

  -- 3. yeses that are not the asked contact's: another account's, the account's other channel; then the late one
  if public.channel_link_confirm(b, '+15550400002', 'linked', t0 + interval '3 minutes') is not null then raise exception 'FAIL another account''s yes confirmed something'; end if;
  if public.channel_link_confirm(a, 'wa:15550400009', 'linked', t0 + interval '3 minutes') is not null then raise exception 'FAIL a yes from a contact not asked confirmed'; end if;
  if public.channel_link_confirm(a, 'tg:7400000001', 'linked', t0 + interval '3 minutes') is not null then raise exception 'FAIL the new chat''s own yes confirmed'; end if;
  if public.channel_link_confirm(a, home, 'linked', t0 + interval '16 minutes 1 second') is not null then raise exception 'FAIL a yes after 15 minutes confirmed'; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000001' and user_id is not null) then raise exception 'FAIL a wrong or late yes linked the chat'; end if;
  raise notice 'ok   a yes from another account, another of the account''s channels, the new chat itself, or after 15 minutes links nothing';

  -- 4. the owner's own chat and the account's YES: linked once, told; the code it came from used
  code := public.channel_link_nonce_issue(a, t0 + interval '20 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7400000002', ask, t0 + interval '21 minutes');
  if r->>'asked' is distinct from 'true' then raise exception 'FAIL the owner''s open: %', r; end if;
  r := public.channel_link_confirm(a, home, 'linked here', t0 + interval '22 minutes');
  if r->>'contact' is distinct from 'tg:7400000002' then raise exception 'FAIL the YES: %', r; end if;
  select user_id into owner from public.channel_contacts where contact = 'tg:7400000002';
  if owner is distinct from a then raise exception 'FAIL the owner''s chat is not linked after the YES (%)', owner; end if;
  select count(*) into n from public.career_outbox where user_id = a and key = r->>'key' and channel = 'telegram' and text = 'linked here';
  if n <> 1 then raise exception 'FAIL the linked chat is not told (%)', n; end if;
  if public.channel_link_confirm(a, home, 'linked here', t0 + interval '23 minutes') is not null then raise exception 'FAIL a second YES confirmed again'; end if;
  if public.channel_link_code_pending('tg:7400000002', t0 + interval '23 minutes') then raise exception 'FAIL the linked chat still reads as waiting'; end if;
  raise notice 'ok   the owner''s chat is linked by the account''s YES, once, and told';

  -- 5. replay: the used code from a stranger; a live code from the chat already the account's (stays linked, code used)
  r := public.channel_link_nonce_ask(code, 'tg:7400000005', ask, t0 + interval '24 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a replayed code: %', r; end if;
  code2 := public.channel_link_nonce_issue(a, t0 + interval '24 minutes');
  r := public.channel_link_nonce_ask(code2, 'tg:7400000002', ask, t0 + interval '25 minutes');
  if r->>'linked' is distinct from 'true' or (r->>'user_id')::uuid is distinct from a then raise exception 'FAIL the account''s own chat with a live code: %', r; end if;
  -- another account's chat: linked_elsewhere, the code kept (20261031030000)
  code2 := public.channel_link_nonce_issue(a, t0 + interval '25 minutes');
  r := public.channel_link_nonce_ask(code2, 'tg:7400000099', ask, t0 + interval '26 minutes');
  if r->>'error' is distinct from 'linked_elsewhere' then raise exception 'FAIL another account''s chat: %', r; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code2, 'UTF8')), 'hex');
  if used is not null then raise exception 'FAIL another account''s chat used the code'; end if;
  raise notice 'ok   a replayed code links nothing; the account''s own chat stays linked; another account''s chat leaves the code';

  -- 6. two questions open on one contact (the owner's chat and a stranger's, two codes): the YES links neither, closes both
  code := public.channel_link_nonce_issue(a, t0 + interval '30 minutes');
  code2 := public.channel_link_nonce_issue(a, t0 + interval '30 minutes');
  perform public.channel_link_nonce_ask(code, 'tg:7400000006', ask, t0 + interval '31 minutes');
  perform public.channel_link_nonce_ask(code2, 'tg:7400000007', ask, t0 + interval '31 minutes 10 seconds');
  r := public.channel_link_confirm(a, home, 'linked', t0 + interval '32 minutes');
  if r->>'error' is distinct from 'ambiguous' then raise exception 'FAIL a yes with two questions open: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact in ('tg:7400000006', 'tg:7400000007') and user_id is not null) then raise exception 'FAIL an ambiguous yes linked a chat'; end if;
  if public.channel_link_confirm(a, home, 'linked', t0 + interval '33 minutes') is not null then raise exception 'FAIL a second yes after the ambiguous one linked'; end if;
  raise notice 'ok   a yes with two chats waiting links neither and closes both';

  -- 7. STOP: before the open, nothing is asked and the code is kept; after the question, the yes links nothing
  perform public.channel_set_opt_out(home, true, t0 + interval '40 minutes');
  code := public.channel_link_nonce_issue(a, t0 + interval '40 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7400000008', ask, t0 + interval '41 minutes');
  if r->>'error' is distinct from 'stopped' then raise exception 'FAIL a stopped account: %', r; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is not null then raise exception 'FAIL a stopped account''s code was used'; end if;
  perform public.channel_set_opt_out(home, false, t0 + interval '42 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7400000008', ask, t0 + interval '43 minutes');
  if r->>'asked' is distinct from 'true' then raise exception 'FAIL after START: %', r; end if;
  perform public.channel_set_opt_out(home, true, t0 + interval '44 minutes');
  if public.channel_link_confirm(a, home, 'linked', t0 + interval '45 minutes') is not null then raise exception 'FAIL a yes after STOP confirmed'; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000008' and user_id is not null) then raise exception 'FAIL a yes after STOP linked'; end if;
  perform public.channel_set_opt_out(home, false, t0 + interval '46 minutes');
  raise notice 'ok   a stopped account is not asked and keeps its code; a yes after STOP links nothing';

  -- 8. no channel to ask (an app-made code for an account with no contact): nothing, the code kept
  code := public.channel_link_nonce_issue(c, t0);
  r := public.channel_link_nonce_ask(code, 'tg:7400000010', ask, t0 + interval '1 minute');
  if r->>'error' is distinct from 'no_channel' then raise exception 'FAIL no channel: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000010' and user_id is not null) then raise exception 'FAIL no channel linked'; end if;
  raise notice 'ok   an account with no channel to ask links nothing';

  -- 9. the account deleted while its question waits: the question goes with it; the chat is never linked
  code := public.channel_link_nonce_issue(d, t0);
  r := public.channel_link_nonce_ask(code, 'tg:7400000011', ask, t0 + interval '1 minute');
  if r->>'asked' is distinct from 'true' then raise exception 'FAIL setup (deleted): %', r; end if;
  delete from public.career_outbox where user_id = d;
  delete from public.channel_contacts where user_id = d;
  delete from auth.users where id = d;
  if public.channel_link_code_pending('tg:7400000011', t0 + interval '2 minutes') then raise exception 'FAIL a deleted account''s question still waits'; end if;
  if public.channel_link_confirm(d, '+15550400004', 'linked', t0 + interval '2 minutes') is not null then raise exception 'FAIL a deleted account''s yes linked'; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000011' and user_id is not null) then raise exception 'FAIL a deleted account''s question linked a chat'; end if;
  raise notice 'ok   an account deleted while its question waits links nothing';

  -- 10. expired, forged, malformed, a group: nothing asked
  code := public.channel_link_nonce_issue(a, t0 + interval '50 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7400000012', ask, t0 + interval '60 minutes 1 second');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL an expired code: %', r; end if;
  r := public.channel_link_nonce_ask(reverse(code), 'tg:7400000012', ask, t0 + interval '51 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a forged code: %', r; end if;
  r := public.channel_link_nonce_ask(code || '!', 'tg:7400000012', ask, t0 + interval '51 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a malformed code: %', r; end if;
  r := public.channel_link_nonce_ask(code, 'tg:-100123', ask, t0 + interval '51 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a group: %', r; end if;
  if exists (select 1 from public.channel_link_requests where contact in ('tg:7400000012', 'tg:-100123')) then raise exception 'FAIL an invalid code asked'; end if;
  begin
    perform public.channel_link_nonce_ask(code, 'tg:7400000012', '  ', t0 + interval '51 minutes');
    raise exception 'FAIL an empty question was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'ok   an expired, forged or malformed code, or a group, asks nothing; an empty question is refused';

  -- 11. the old one-step redeem never links a chat that is no one's (the code kept); the account's own chat stays linked
  code := public.channel_link_nonce_issue(a, t0 + interval '70 minutes');
  r := public.channel_link_nonce_redeem(code, 'tg:7400000013', t0 + interval '71 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL the old redeem on a new chat: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7400000013' and user_id is not null) then raise exception 'FAIL the old redeem linked a new chat'; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is not null then raise exception 'FAIL the old redeem used the code on a chat it did not link'; end if;
  r := public.channel_link_nonce_redeem(code, 'tg:7400000002', t0 + interval '72 minutes');
  if (r->>'user_id')::uuid is distinct from a then raise exception 'FAIL the old redeem on the account''s own chat: %', r; end if;
  raise notice 'ok   the old one-step redeem links no new chat';

  -- 12. a request needs a number or a code
  begin
    insert into public.channel_link_requests(user_id, contact, phone, asked_on, created_at, expires_at) values (a, 'tg:7400000014', null, home, t0, t0 + interval '1 hour');
    raise exception 'FAIL a request with neither a number nor a code';
  exception when check_violation then null;
  end;

  if has_function_privilege('anon', 'public.channel_link_nonce_ask(text, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_nonce_ask(text, text, text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.channel_link_code_pending(text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_code_pending(text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.channel_link_confirm(uuid, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_confirm(uuid, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_nonce_redeem(text, text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.channel_link_nonce_ask(text, text, text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.channel_link_code_pending(text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.channel_link_confirm(uuid, text, text, timestamptz)', 'execute') then
    raise exception 'FAIL the link functions must be service-role only';
  end if;
  raise notice 'ok   service role only';
end $$;
rollback;
