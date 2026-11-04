-- CONNECTORS ROUND 3 (20261031060000_connectors_r3.sql), in the database alone: a connect stores its Vault entry and row in
-- one transaction holding the account (an account that is gone gets nothing; an address another account holds, in any case
-- or spacing, gets nothing and leaves the holder as it was; the same account's other grant may share it); a Gmail state is
-- spent once; an inbox run's writes need the mailbox still connected and, given the run's erase epoch, no erase since.
-- Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c3c01';
  b uuid := '00000000-0000-4000-8000-0000000c3c02';
  gone uuid := '00000000-0000-4000-8000-0000000c3c09';
  r text; n int; j jsonb; ok boolean; f text;
  h text := repeat('a', 64);
begin
  insert into auth.users(id, email) values (a, 'r3a@example.test'), (b, 'r3b@example.test');
  -- 1. the connect, whole
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"fake-a"}', 'Pat@Example.test', 'openid email');
  if r <> 'connected' then raise exception 'FAIL a plain connect: %', r; end if;
  select count(*) into n from vault.secrets where name = 'oauth_google_career_' || a;
  if n <> 1 then raise exception 'FAIL the Vault entry was not written'; end if;
  r := public.oauth_connect_commit(b, 'google_career', '{"access_token":"fake-b"}', ' pat@example.TEST ', 'openid email');
  if r <> 'taken' then raise exception 'FAIL an address another account holds (case, spaces): %', r; end if;
  r := public.oauth_connect_commit(b, 'gmail', '{"access_token":"fake-b"}', 'pat@example.test', 'openid email');
  if r <> 'taken' then raise exception 'FAIL the legacy grant shares Google''s grant: %', r; end if;
  select count(*) into n from vault.secrets where name like 'oauth_%_' || b;
  if n <> 0 or exists (select 1 from public.user_oauth_connections where user_id = b) then raise exception 'FAIL a refused connect left something'; end if;
  if (select email from public.user_oauth_connections where user_id = a and provider = 'google_career') <> 'Pat@Example.test' then raise exception 'FAIL the holder changed'; end if;
  r := public.oauth_connect_commit(b, 'microsoft', '{"access_token":"fake-b"}', 'pat@example.test', 'Mail.Read');
  if r <> 'connected' then raise exception 'FAIL a Microsoft account with the same address is another account: %', r; end if;
  r := public.oauth_connect_commit(a, 'gmail', '{"access_token":"fake-a2"}', 'pat@example.test', 'openid email');
  if r <> 'connected' then raise exception 'FAIL the same account''s other grant: %', r; end if;
  r := public.oauth_connect_commit(gone, 'google_career', '{"access_token":"fake-g"}', 'gone@example.test', 'openid email');
  if r <> 'gone' then raise exception 'FAIL an account that does not exist: %', r; end if;
  select count(*) into n from vault.secrets where name like '%' || gone;
  if n <> 0 then raise exception 'FAIL a Vault entry for an account that does not exist'; end if;
  r := public.oauth_connect_commit(a, 'dropbox', '{}', null, null);
  if r <> 'invalid' then raise exception 'FAIL an unknown provider: %', r; end if;
  raise notice 'ok   a connect is whole: gone and taken store nothing, the holder is untouched, the account''s own grants and Microsoft are separate';
  -- 2. a state spent once
  if not public.oauth_state_use('state-0123456789abcdef') then raise exception 'FAIL a fresh state'; end if;
  if public.oauth_state_use('state-0123456789abcdef') then raise exception 'FAIL a state used twice'; end if;
  if public.oauth_state_use('short') then raise exception 'FAIL a malformed state'; end if;
  raise notice 'ok   a Gmail state is spent once';
  -- 3. inbox writes
  insert into public.career_watch_kv(user_id, key, value) values (a, 'career:account', '{"epoch": 2}');
  j := public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Asana', 'stage', 'Rejected', 'evidence', 'not moving forward', 'message_hash', h, 'mail_at', now())), 2);
  if j->>'ok' <> 'true' or j->'stored' <> jsonb_build_array(h) then raise exception 'FAIL a live mailbox''s events: %', j; end if;
  j := public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Asana', 'stage', 'Rejected', 'evidence', 'again', 'message_hash', h, 'mail_at', now())), 2);
  if j->'stored' <> '[]'::jsonb then raise exception 'FAIL an event stored twice'; end if;
  j := public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Asana', 'stage', 'Rejected', 'evidence', 'x', 'message_hash', repeat('b', 64), 'mail_at', now())), 1);
  if j->>'ok' <> 'false' then raise exception 'FAIL a run that began before an erase wrote after it'; end if;
  if public.career_mail_save_draft(a, jsonb_build_object('draft_key', 'followup:x', 'application_ref', 'track:a1', 'kind', 'followup', 'company', 'Asana', 'text', 'hi', 'basis', 'b'), 1) <> 'gone' then raise exception 'FAIL a draft after an erase'; end if;
  if public.career_mail_save_draft(a, jsonb_build_object('draft_key', 'followup:x', 'application_ref', 'track:a1', 'kind', 'followup', 'company', 'Asana', 'text', 'hi', 'basis', 'b'), 2) <> 'saved' then raise exception 'FAIL a draft'; end if;
  if not public.career_mail_save_cursor(a, now()) then raise exception 'FAIL a cursor'; end if;
  if public.career_outlook_store_messages(a, jsonb_build_array(jsonb_build_object('message_hash', h, 'from_address', 'x@acme.example', 'received_at', now())), null) <> -1 then raise exception 'FAIL Outlook messages with no Outlook connection'; end if;
  if public.career_outlook_store_messages(b, jsonb_build_array(jsonb_build_object('message_hash', h, 'from_address', 'x@acme.example', 'received_at', now())), 0) <> 1 then raise exception 'FAIL Outlook messages'; end if;
  delete from public.user_oauth_connections where user_id = a and provider = 'google_career';
  j := public.career_mail_record_events(a, jsonb_build_array(jsonb_build_object('application_ref', 'track:a1', 'kind', 'rejection', 'company', 'Asana', 'stage', 'Rejected', 'evidence', 'x', 'message_hash', repeat('c', 64), 'mail_at', now())), null);
  if j->>'ok' <> 'false' or public.career_mail_save_cursor(a, now()) then raise exception 'FAIL writes after a disconnect'; end if;
  select count(*) into n from public.career_mail_events where user_id = a;
  if n <> 0 then raise exception 'FAIL the disconnect left % events', n; end if;
  raise notice 'ok   inbox writes need the mailbox and no erase since the run began';
  -- service only
  foreach f in array array['public.oauth_connect_commit(uuid, text, text, text, text, timestamptz)', 'public.oauth_state_use(text)', 'public.career_outlook_store_messages(uuid, jsonb, bigint)',
      'public.career_mail_record_events(uuid, jsonb, bigint)', 'public.career_mail_save_draft(uuid, jsonb, bigint)', 'public.career_mail_save_cursor(uuid, timestamptz)', 'public.career_erase_epoch(uuid)',
      'public.career_mailbox_live(uuid, text, bigint)'] loop
    select has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') into ok;
    if ok then raise exception 'FAIL anon or authenticated can run %', f; end if;
  end loop;
  if has_table_privilege('anon', 'public.oauth_state_uses', 'select') or has_table_privilege('authenticated', 'public.oauth_state_uses', 'select') then raise exception 'FAIL the spent states are readable'; end if;
  raise notice 'ok   service role only';
end $$;
rollback;
