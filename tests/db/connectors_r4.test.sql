-- CONNECTORS ROUND 4 (20261105130000_connectors_r4.sql), in the database alone: "disconnect gmail" (or connecting another
-- Google account) deletes every undelivered text made from that mailbox and the offers of the drafts it deletes, and the
-- pending "which application?" asks; delivered texts, other kinds and other people's stay; a same-address reconnect keeps
-- them. A mail text is queued only while the career Google row is there. A refresh is written only over the grant it read.
-- A mail run's (and Outlook sync's) writes carry the address it read and are refused for another.
-- Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c4c01';
  b uuid := '00000000-0000-4000-8000-0000000c4c02';
  h text := repeat('a', 64); h2 text := repeat('b', 64);
  r text; n int; s1 text; s2 text; ok boolean;
begin
  insert into auth.users(id, email) values (a, 'r4a@example.test'), (b, 'r4b@example.test');
  insert into profiles(id) values (a), (b) on conflict do nothing;
  -- 1. which keys are made from mail
  if not public.career_mail_text_key('status:' || h) or not public.career_mail_text_key('status:deadline:' || h)
     or not public.career_mail_text_key('status:confirmed:0f8fad5b-d9cb-469f-a165-70867728950e') or not public.career_mail_text_key('status:which:' || h)
     or not public.career_mail_text_key('brief:' || h || ':1') or not public.career_mail_text_key('brief:' || h || ':moved') then
    raise exception 'FAIL a mail text key was not recognised'; end if;
  if public.career_mail_text_key('brief:2026-11-05') or public.career_mail_text_key('status:reminder:abc:UTC') or public.career_mail_text_key('status:connect:abc')
     or public.career_mail_text_key('alert:job-1') or public.career_mail_text_key('followup:outreach:x') or public.career_mail_text_key('status:outlook:abc')
     or public.career_mail_text_key(null) then
    raise exception 'FAIL a key not made from mail was taken for one'; end if;
  -- 2. queued only while connected
  r := public.career_mail_text_enqueue(a, 'status:' || h, 'status', 'TEST Acme moved you to interviews.', now());
  if r <> 'gone' then raise exception 'FAIL a mail text queued with no career Google row: %', r; end if;
  if exists (select 1 from career_outbox where user_id = a) then raise exception 'FAIL gone queued something'; end if;
  r := public.career_mail_text_enqueue(a, 'alert:job-1', 'alert', 'x', now());
  if r <> 'invalid' then raise exception 'FAIL a key not made from mail went through the mail queue: %', r; end if;
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"fake-a","refresh_token":"fake-ra","email":"pat@example.test"}', 'pat@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  if r <> 'connected' then raise exception 'FAIL connect a: %', r; end if;
  r := public.oauth_connect_commit(b, 'google_career', '{"access_token":"fake-b","email":"sam@example.test"}', 'sam@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  if r <> 'connected' then raise exception 'FAIL connect b: %', r; end if;
  r := public.career_mail_text_enqueue(a, 'status:' || h, 'status', 'TEST Acme moved you to interviews.', now() + interval '8 hours');
  if r <> 'queued' then raise exception 'FAIL a mail text while connected: %', r; end if;
  r := public.career_mail_text_enqueue(a, 'status:' || h, 'status', 'again', now());
  if r <> 'duplicate' then raise exception 'FAIL the same key twice: %', r; end if;
  -- 3. the disconnect deletes what was made from that mailbox, nothing else
  insert into career_outbox(user_id, key, kind, text, deliver_at, delivered_at, status) values
    (a, 'brief:' || h || ':1', 'brief', 'TEST brief 1', now() + interval '8 hours', null, 'queued'),
    (a, 'brief:' || h || ':moved', 'brief', 'TEST moved', now() + interval '8 hours', null, 'queued'),
    (a, 'status:confirmed:0f8fad5b-d9cb-469f-a165-70867728950e', 'status', 'TEST confirmed', now(), null, 'sending'),
    (a, 'status:which:' || h, 'status', 'TEST which', now(), null, 'failed'),
    (a, 'status:deadline:' || h, 'status', 'TEST deadline', now() + interval '1 day', null, 'queued'),
    (a, 'followup:followup:job:1', 'followup', 'TEST follow-up offer', now(), null, 'queued'),
    (a, 'followup:thank_you:job:1:2026-11-01', 'followup', 'TEST thank-you offer', now(), null, 'queued'),
    (a, 'status:' || h2, 'status', 'TEST said yesterday', now() - interval '1 day', now() - interval '1 day', 'delivered'),
    (a, 'alert:job-1', 'alert', 'TEST alert', now(), null, 'queued'),
    (a, 'followup:outreach:d1', 'followup', 'TEST outreach follow-up', now(), null, 'queued'),
    (a, 'brief:2026-11-05', 'brief', 'TEST daily', now(), null, 'queued'),
    (b, 'status:' || h, 'status', 'TEST b status', now(), null, 'queued');
  insert into career_watch_kv(user_id, key, value) values
    (a, 'career:confirm-ask:' || h, '{"state":"pending","text":"TEST which"}'),
    (a, 'career:confirm-ask:' || h2, '{"state":"asked","text":"TEST asked"}'),
    (b, 'career:confirm-ask:' || h, '{"state":"pending","text":"TEST b"}');
  -- a same-address reconnect (the send consent, another token) keeps everything
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"fake-a2","refresh_token":"fake-ra2","email":"pat@example.test"}', ' Pat@Example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  if r <> 'connected' then raise exception 'FAIL same-address reconnect: %', r; end if;
  select count(*) into n from career_outbox where user_id = a;
  if n <> 12 then raise exception 'FAIL a same-address reconnect deleted queued texts (% left)', n; end if;
  delete from public.user_oauth_connections where user_id = a and provider = 'google_career';
  select count(*) into n from career_outbox where user_id = a and delivered_at is null and (public.career_mail_text_key(key) or key ~ '^followup:(followup|thank_you):');
  if n <> 0 then raise exception 'FAIL % undelivered texts made from the mailbox survived the disconnect', n; end if;
  if not exists (select 1 from career_outbox where user_id = a and key = 'status:' || h2) then raise exception 'FAIL a delivered text was deleted'; end if;
  select count(*) into n from career_outbox where user_id = a and key in ('alert:job-1', 'followup:outreach:d1', 'brief:2026-11-05');
  if n <> 3 then raise exception 'FAIL texts not made from mail were deleted'; end if;
  if exists (select 1 from career_watch_kv where user_id = a and key = 'career:confirm-ask:' || h) then raise exception 'FAIL a pending ask survived'; end if;
  if not exists (select 1 from career_watch_kv where user_id = a and key = 'career:confirm-ask:' || h2) then raise exception 'FAIL an ask already shown was deleted'; end if;
  if not exists (select 1 from career_outbox where user_id = b and key = 'status:' || h) or not exists (select 1 from career_watch_kv where user_id = b and key = 'career:confirm-ask:' || h) then
    raise exception 'FAIL another person''s texts changed'; end if;
  r := public.career_mail_text_enqueue(a, 'brief:' || h || ':2', 'brief', 'TEST late brief', now());
  if r <> 'gone' then raise exception 'FAIL a mail run''s text queued after the disconnect: %', r; end if;
  -- 4. connecting another Google account is the old mailbox's disconnect
  insert into career_outbox(user_id, key, kind, text, deliver_at) values (b, 'brief:' || h2 || ':1', 'brief', 'TEST b brief', now());
  update public.user_oauth_connections set email = 'sam.work@example.test' where user_id = b and provider = 'google_career';
  if exists (select 1 from career_outbox where user_id = b and delivered_at is null and public.career_mail_text_key(key)) then raise exception 'FAIL an account switch kept the old mailbox''s texts'; end if;
  if exists (select 1 from career_watch_kv where user_id = b and key like 'career:confirm-ask:%') then raise exception 'FAIL an account switch kept the old mailbox''s ask'; end if;
  -- 5. the grant: each connect stamps its own; a refresh is written only over the grant it read
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"fake-a3","refresh_token":"fake-ra3","email":"pat@example.test"}', 'pat@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  s1 := public.oauth_vault_read('oauth_google_career_' || a);
  if coalesce(s1::jsonb->>'grant', '') !~ '^[0-9a-f-]{36}$' then raise exception 'FAIL the stored grant is not stamped: %', s1; end if;
  ok := public.oauth_vault_refresh('oauth_google_career_' || a, (s1::jsonb || '{"access_token":"fresh"}')::text);
  if not ok or public.oauth_vault_read('oauth_google_career_' || a)::jsonb->>'access_token' <> 'fresh' then raise exception 'FAIL a refresh of the stored grant'; end if;
  -- disconnected and connected again (the same address) while a refresh of the old grant ran
  delete from public.user_oauth_connections where user_id = a and provider = 'google_career';
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"fake-a4","refresh_token":"fake-ra4","email":"pat@example.test"}', 'pat@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  s2 := public.oauth_vault_read('oauth_google_career_' || a);
  if s2::jsonb->>'grant' = s1::jsonb->>'grant' then raise exception 'FAIL two connects share a grant id'; end if;
  ok := public.oauth_vault_refresh('oauth_google_career_' || a, (s1::jsonb || '{"access_token":"stale"}')::text);
  if ok then raise exception 'FAIL a refresh of the earlier grant was written over the new one'; end if;
  if public.oauth_vault_read('oauth_google_career_' || a) <> s2 then raise exception 'FAIL the new grant''s tokens changed'; end if;
  ok := public.oauth_vault_refresh('oauth_google_career_' || a, ((s1::jsonb - 'grant') || '{"access_token":"stale"}')::text);
  if ok then raise exception 'FAIL a refresh carrying no grant was written over a stamped one'; end if;
  -- a secret stored before stamping (no grant) refreshes as before
  perform public.oauth_vault_store('oauth_microsoft_' || b, '{"access_token":"old","email":"sam@example.test"}');
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values (b, 'microsoft', 'oauth_microsoft_' || b, 'sam@example.test', 'Mail.Read');
  ok := public.oauth_vault_refresh('oauth_microsoft_' || b, '{"access_token":"new","email":"sam@example.test"}');
  if not ok then raise exception 'FAIL an unstamped secret no longer refreshes'; end if;
  -- 6. a run's writes carry the address it read: another one is refused, the same one (any case or spacing) is written
  -- (a is connected as pat@example.test here)
  r := public.career_mail_text_enqueue(a, 'status:' || repeat('c', 64), 'status', 'TEST read from the old mailbox', now(), 'pat.old@example.test');
  if r <> 'gone' then raise exception 'FAIL a text read from another mailbox was queued: %', r; end if;
  r := public.career_mail_text_enqueue(a, 'status:' || repeat('c', 64), 'status', 'TEST read from this mailbox', now(), ' PAT@example.test ');
  if r <> 'queued' then raise exception 'FAIL a text read from the connected mailbox: %', r; end if;
  if (public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Acme', 'stage', 'Rejected',
      'evidence', 'TEST', 'message_hash', repeat('d', 64), 'mail_at', now())), null::bigint, 'pat.old@example.test'))->>'ok' <> 'false' then
    raise exception 'FAIL events read from another mailbox were recorded'; end if;
  if (public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Acme', 'stage', 'Rejected',
      'evidence', 'TEST', 'message_hash', repeat('d', 64), 'mail_at', now())), null::bigint, 'pat@example.test'))->>'ok' <> 'true' then
    raise exception 'FAIL events read from the connected mailbox were refused'; end if;
  if public.career_mail_save_draft(a, jsonb_build_object('draft_key', 'followup:track:a1', 'application_ref', 'track:a1', 'kind', 'followup', 'company', 'Acme', 'text', 'TEST', 'basis', 'TEST'), null::bigint, 'pat.old@example.test') <> 'gone' then
    raise exception 'FAIL a draft from another mailbox was saved'; end if;
  if public.career_mail_save_cursor(a, now(), 'pat.old@example.test') then raise exception 'FAIL the old mailbox''s read position was saved'; end if;
  if not public.career_mail_save_cursor(a, now(), 'pat@example.test') then raise exception 'FAIL the read position of the connected mailbox'; end if;
  -- Outlook (b is connected to Microsoft as sam@example.test above)
  if public.career_outlook_store_messages(b, jsonb_build_array(jsonb_build_object('message_hash', repeat('e', 64), 'from_address', 'x@acme.example', 'subject', 'TEST', 'received_at', now())), null::bigint, 'sam.old@example.test') <> -1 then
    raise exception 'FAIL Outlook messages read from another mailbox were stored'; end if;
  if public.career_outlook_store_messages(b, jsonb_build_array(jsonb_build_object('message_hash', repeat('e', 64), 'from_address', 'x@acme.example', 'subject', 'TEST', 'received_at', now())), null::bigint, 'sam@example.test') <> 1 then
    raise exception 'FAIL Outlook messages read from the connected mailbox'; end if;
  raise notice 'ok   connectors r4: mail texts deleted on disconnect and switch, queued only while connected, refresh bound to its grant';
end $$;
-- service only
do $$
begin
  if has_function_privilege('authenticated', 'public.career_mail_text_enqueue(uuid,text,text,text,timestamptz,text)', 'execute')
     or has_function_privilege('anon', 'public.career_mail_text_enqueue(uuid,text,text,text,timestamptz,text)', 'execute')
     or has_function_privilege('authenticated', 'public.career_mail_record_events(uuid,jsonb,bigint,text)', 'execute')
     or has_function_privilege('authenticated', 'public.career_outlook_store_messages(uuid,jsonb,bigint,text)', 'execute')
     or has_function_privilege('authenticated', 'public.career_mailbox_is(uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.google_career_disconnect_erase()', 'execute')
     or has_function_privilege('authenticated', 'public.oauth_vault_refresh(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.oauth_connect_commit(uuid,text,text,text,text,timestamptz)', 'execute') then
    raise exception 'FAIL a round 4 function is callable by a signed-in person or anyone anonymous'; end if;
  if not has_function_privilege('service_role', 'public.career_mail_text_enqueue(uuid,text,text,text,timestamptz,text)', 'execute') then raise exception 'FAIL the service cannot queue a mail text'; end if;
  raise notice 'ok   connectors r4: service only';
end $$;
rollback;
