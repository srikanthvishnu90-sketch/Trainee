-- TELEGRAM LINK REPLY CODE (20261031063000_telegram_link_reply_code.sql; review #348), in the database alone, every instant
-- passed in. The hijack first: a stranger opens a leaked code, the owner's plain yes (meant for something else) must not link
-- the stranger's chat. Then: only "LINK <the request's own code>" from the asked contact links, once, within 15 minutes; a
-- wrong, reused, late or other request's code links nothing; five wrong codes close the questions; at most 3 code questions
-- open per account; a question with no {code} place asks nothing; a same-number question still takes a plain yes. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c5a01'; b uuid := '00000000-0000-4000-8000-0000000c5a02';
  t0 timestamptz := timestamptz '2026-11-04 15:00:00+00';
  home text := '+15550500001';
  ask text := 'Someone wants to link Telegram @stranger_1 to your Trainee. To allow it, reply LINK {code} here within 15 minutes.';
  code text; r jsonb; n int; k text; rc text; rc2 text; q text; owner uuid; used timestamptz;
begin
  insert into auth.users(id, email) values (a, 'tlr-a@example.test'), (b, 'tlr-b@example.test');
  insert into public.channel_contacts(contact, user_id, thread_id, last_inbound_at, created_at, updated_at) values
    (home, a, null, t0 - interval '1 hour', t0 - interval '2 hours', t0 - interval '2 hours'),
    ('+15550500002', b, null, t0 - interval '1 hour', t0 - interval '1 hour', t0 - interval '1 hour');

  -- 1. THE HIJACK (#348): a stranger opens the leaked code; the owner's next plain yes links nothing
  code := public.channel_link_nonce_issue(a, t0);
  r := public.channel_link_nonce_ask(code, 'tg:7500000001', ask, t0 + interval '1 minute');
  if r->>'asked' is distinct from 'true' then raise exception 'FAIL setup: the stranger''s open was not asked: %', r; end if;
  k := r->>'key';
  r := public.channel_link_confirm(a, home, 'linked', t0 + interval '2 minutes');
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000001' and user_id is not null) then
    raise exception 'FAIL the owner''s plain yes linked the stranger''s chat (%)', r;
  end if;
  if r is not null then raise exception 'FAIL a plain yes answered a code''s question: %', r; end if;
  raise notice 'ok   a plain yes never answers a link code''s question (the hijack is closed)';

  -- 2. the question carries the request's own 4-digit reply code, shown only on the owner's channel
  select reply_code into rc from public.channel_link_requests where user_id = a and contact = 'tg:7500000001';
  if rc is null or rc !~ '^[0-9]{4}$' then raise exception 'FAIL the request has no 4-digit reply code (%)', rc; end if;
  select text into q from public.career_outbox where user_id = a and key = k;
  if q is distinct from replace(ask, '{code}', rc) or q like '%{code}%' then raise exception 'FAIL the question does not carry its code: %', q; end if;
  if exists (select 1 from public.career_outbox where user_id = a and key = k and channel <> 'imessage') then raise exception 'FAIL the question went elsewhere'; end if;
  raise notice 'ok   the question on the owner''s own channel carries the request''s reply code';

  -- 3. wrong code, another contact with the right code, another account with the right code: nothing
  r := public.channel_link_confirm_code(a, home, lpad(((rc::int + 1) % 10000)::text, 4, '0'), 'linked', t0 + interval '3 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL a wrong code: %', r; end if;
  r := public.channel_link_confirm_code(a, 'tg:7500000001', rc, 'linked', t0 + interval '3 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL the new chat''s own LINK: %', r; end if;
  r := public.channel_link_confirm_code(b, '+15550500002', rc, 'linked', t0 + interval '3 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL another account''s LINK: %', r; end if;
  r := public.channel_link_confirm_code(a, home, 'yes', 'linked', t0 + interval '3 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL a non-code: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000001' and user_id is not null) then raise exception 'FAIL a wrong LINK linked'; end if;
  raise notice 'ok   a wrong code, the new chat, another account: nothing linked';

  -- 4. the right code from the asked contact: linked once, told; the same code again does nothing
  r := public.channel_link_confirm_code(a, home, rc, 'linked here', t0 + interval '4 minutes');
  if r->>'contact' is distinct from 'tg:7500000001' then raise exception 'FAIL the right LINK: %', r; end if;
  select user_id into owner from public.channel_contacts where contact = 'tg:7500000001';
  if owner is distinct from a then raise exception 'FAIL the chat is not linked after the right LINK'; end if;
  select count(*) into n from public.career_outbox where user_id = a and key = r->>'key' and channel = 'telegram' and text = 'linked here';
  if n <> 1 then raise exception 'FAIL the linked chat is not told (%)', n; end if;
  r := public.channel_link_confirm_code(a, home, rc, 'linked here', t0 + interval '5 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL the code worked twice: %', r; end if;
  raise notice 'ok   LINK <code> from the asked contact links once';

  -- 5. two requests open: each code links only its own chat; a late code links nothing
  code := public.channel_link_nonce_issue(a, t0 + interval '10 minutes');
  perform public.channel_link_nonce_ask(code, 'tg:7500000002', ask, t0 + interval '11 minutes');
  code := public.channel_link_nonce_issue(a, t0 + interval '10 minutes');
  perform public.channel_link_nonce_ask(code, 'tg:7500000003', ask, t0 + interval '11 minutes');
  select reply_code into rc from public.channel_link_requests where contact = 'tg:7500000002';
  select reply_code into rc2 from public.channel_link_requests where contact = 'tg:7500000003';
  if rc = rc2 then raise exception 'FAIL two open requests share a code'; end if;
  r := public.channel_link_confirm_code(a, home, rc2, 'linked', t0 + interval '12 minutes');
  if r->>'contact' is distinct from 'tg:7500000003' then raise exception 'FAIL a code linked another request: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000002' and user_id is not null) then raise exception 'FAIL the other request was linked too'; end if;
  r := public.channel_link_confirm_code(a, home, rc, 'linked', t0 + interval '26 minutes 1 second');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL a late code: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000002' and user_id is not null) then raise exception 'FAIL a late code linked'; end if;
  raise notice 'ok   each code links only its own request; after 15 minutes nothing';

  -- 6. five wrong codes close the open questions
  code := public.channel_link_nonce_issue(a, t0 + interval '30 minutes');
  perform public.channel_link_nonce_ask(code, 'tg:7500000004', ask, t0 + interval '31 minutes');
  select reply_code into rc from public.channel_link_requests where contact = 'tg:7500000004';
  for i in 1..5 loop
    perform public.channel_link_confirm_code(a, home, lpad(((rc::int + i) % 10000)::text, 4, '0'), 'linked', t0 + interval '32 minutes');
  end loop;
  r := public.channel_link_confirm_code(a, home, rc, 'linked', t0 + interval '33 minutes');
  if r->>'error' is distinct from 'no_match' then raise exception 'FAIL the right code after five wrong ones: %', r; end if;
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000004' and user_id is not null) then raise exception 'FAIL linked after five wrong codes'; end if;
  raise notice 'ok   five wrong codes close the question';

  -- 7. at most 3 code questions open per account: the 4th asks nothing and leaves its code unused
  for i in 5..7 loop
    code := public.channel_link_nonce_issue(a, t0 + interval '40 minutes');
    r := public.channel_link_nonce_ask(code, 'tg:750000000' || i, ask, t0 + interval '41 minutes');
    if r->>'asked' is distinct from 'true' then raise exception 'FAIL open % was not asked: %', i, r; end if;
  end loop;
  code := public.channel_link_nonce_issue(a, t0 + interval '40 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7500000008', ask, t0 + interval '41 minutes');
  if r->>'error' is distinct from 'busy' then raise exception 'FAIL a 4th open question: %', r; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is not null then raise exception 'FAIL the 4th code was used'; end if;
  select count(*) into n from public.channel_link_requests where user_id = a and by_code and answered_at is null and expires_at > t0 + interval '41 minutes';
  if n <> 3 then raise exception 'FAIL % open code questions', n; end if;
  raise notice 'ok   at most 3 code questions open per account';

  -- 8. a question with no {code} place (a handler from before the fix) asks nothing; the code stays unused
  code := public.channel_link_nonce_issue(a, t0 + interval '60 minutes');
  r := public.channel_link_nonce_ask(code, 'tg:7500000009', 'Someone wants to link Telegram. Reply YES to allow.', t0 + interval '61 minutes');
  if r->>'error' is distinct from 'invalid' then raise exception 'FAIL a question with no code place: %', r; end if;
  select used_at into used from public.channel_link_nonces where nonce_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex');
  if used is not null or exists (select 1 from public.channel_link_requests where contact = 'tg:7500000009') then raise exception 'FAIL it asked or used the code'; end if;
  raise notice 'ok   a question with no code place asks nothing';

  -- 9. STOP after the question: the right code links nothing
  code := public.channel_link_nonce_issue(a, t0 + interval '80 minutes');
  perform public.channel_link_nonce_ask(code, 'tg:7500000010', ask, t0 + interval '81 minutes');
  select reply_code into rc from public.channel_link_requests where contact = 'tg:7500000010';
  perform public.channel_set_opt_out(home, true, t0 + interval '82 minutes');
  r := public.channel_link_confirm_code(a, home, rc, 'linked', t0 + interval '83 minutes');
  if exists (select 1 from public.channel_contacts where contact = 'tg:7500000010' and user_id is not null) then raise exception 'FAIL linked after STOP (%)', r; end if;
  perform public.channel_set_opt_out(home, false, t0 + interval '84 minutes');
  raise notice 'ok   STOP after the question: nothing linked';

  -- 10. a same-number question (20261030120000) still takes the plain yes
  insert into public.channel_link_requests(user_id, contact, phone, asked_on, created_at, expires_at) values (a, 'wa:15550500001', '+15550500001', home, t0 + interval '90 minutes', t0 + interval '150 minutes');
  r := public.channel_link_confirm(a, home, 'linked', t0 + interval '91 minutes');
  if r->>'contact' is distinct from 'wa:15550500001' then raise exception 'FAIL the same-number yes: %', r; end if;
  raise notice 'ok   a same-number question still takes the plain yes';

  if has_function_privilege('anon', 'public.channel_link_confirm_code(uuid, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_confirm_code(uuid, text, text, text, timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.channel_link_confirm_code(uuid, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.channel_link_nonce_ask(text, text, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.channel_link_confirm(uuid, text, text, timestamptz)', 'execute') then
    raise exception 'FAIL the link functions must be service-role only';
  end if;
  raise notice 'ok   service role only';
end $$;
rollback;
