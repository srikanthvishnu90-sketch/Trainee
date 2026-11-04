-- ERASE SCENARIOS ROUND 2 (20261030050000_account_erase_r2.sql), in the database alone:
--   1. oauth_vault_refresh writes a refreshed token only while its connection row exists and names the same account; after
--      a disconnect or an account deletion it writes nothing (false), and a refresh of the account connected before never
--      overwrites the new account's tokens;
--   2. connecting another account over the one connected (an upsert: an UPDATE) is the old mailbox's disconnect: its queued
--      emails are cancelled, the replies lane's approved follow-ups too, and the mail read from it is erased; the same account
--      connecting again keeps everything; the other mailbox is untouched;
--   3. a deleted account is quiet (career_user_quiet) and gone (career_account_gone); a live one is neither;
--   4. account_deletion_log takes a record with nothing that names the person and refuses an unknown outcome;
--   5. service role only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000e2001'; b uuid := '00000000-0000-4000-8000-0000000e2002'; c uuid := '00000000-0000-4000-8000-0000000e2003';
  r jsonb; q1 uuid; q2 uuid; qo uuid; th uuid := gen_random_uuid(); ok boolean;
begin
  insert into auth.users(id, email) values (a, 'e2-a@example.test'), (b, 'e2-b@example.test'), (c, 'e2-c@example.test');
  insert into public.profiles(id) values (a), (b), (c);

  -- 1. the refresh write
  perform public.oauth_vault_store('oauth_google_career_' || a, '{"access_token":"old","refresh_token":"r","email":"one@example.test"}');
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values (a, 'google_career', 'oauth_google_career_' || a, 'one@example.test', 'openid email');
  if public.oauth_vault_refresh('oauth_google_career_' || a, '{"access_token":"fresh","refresh_token":"r","email":"one@example.test"}') is not true then raise exception 'FAIL a refresh while connected is written'; end if;
  if public.oauth_vault_read('oauth_google_career_' || a)::jsonb->>'access_token' <> 'fresh' then raise exception 'FAIL the refreshed token is stored'; end if;
  if public.oauth_vault_refresh('oauth_google_career_' || a, '{"access_token":"x","refresh_token":"r","email":"someone-else@example.test"}') is not false then raise exception 'FAIL a refresh of another account is refused'; end if;
  if public.oauth_vault_read('oauth_google_career_' || a)::jsonb->>'access_token' <> 'fresh' then raise exception 'FAIL a refused refresh writes nothing'; end if;
  if public.oauth_vault_refresh('oauth_google_career_' || a, 'not json') is not true then raise exception 'FAIL a secret without an account name is written while connected'; end if;
  delete from public.user_oauth_connections where user_id = a and provider = 'google_career';
  if public.oauth_vault_read('oauth_google_career_' || a) is not null then raise exception 'FAIL the disconnect removed the token'; end if;
  if public.oauth_vault_refresh('oauth_google_career_' || a, '{"access_token":"late","refresh_token":"r"}') is not false then raise exception 'FAIL a refresh after the disconnect is refused'; end if;
  if public.oauth_vault_read('oauth_google_career_' || a) is not null then raise exception 'FAIL a refresh after the disconnect writes no token back'; end if;
  begin perform public.oauth_vault_refresh('simplefin_x', '{}'); raise exception 'FAIL only oauth names'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'ok   a refreshed token is written only while its connection exists and names the same account';

  -- 2. another account over the one connected
  perform public.oauth_vault_store('oauth_google_career_' || b, '{"access_token":"b1","refresh_token":"rb","email":"old@example.test"}');
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values
    (b, 'google_career', 'oauth_google_career_' || b, 'old@example.test', 'openid email'),
    (b, 'microsoft', 'oauth_microsoft_' || b, 'b@outlook.example', 'Mail.Send');
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('a', 64), 'to', 'x1@contacts.example', 'subject', 'S', 'body', 'B', 'provider', 'gmail', 'send_at', now() + interval '1 day'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('b', 64), 'to', 'x2@contacts.example', 'subject', 'S', 'body', 'B', 'provider', 'gmail', 'send_at', now() + interval '1 day'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('c', 64), 'to', 'x3@contacts.example', 'subject', 'S', 'body', 'B', 'provider', 'outlook', 'send_at', now() + interval '1 day'))));
  q1 := (r->0->>'id')::uuid; q2 := (r->1->>'id')::uuid; qo := (r->2->>'id')::uuid;
  if (select count(*) from public.career_send_queue where id in (q1, q2, qo) and state = 'queued') <> 3 then raise exception 'FAIL setup: %', r; end if;
  insert into public.career_mail_events (user_id, application_ref, kind, company, stage, evidence, message_hash, mail_at)
    values (b, 'mail:acme', 'received', 'Acme', 'Submitted', 'Acme: received', repeat('e', 64), now());
  insert into public.career_outreach_threads (id, user_id, provider, provider_thread, recipient_email, subject, sent_at) values (th, b, 'gmail', 'pt-1', 'y@contacts.example', 'Hello', now());
  insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)
    values (b, th, 'followup', 1, gen_random_uuid(), 1, '{"to":"y@contacts.example"}', repeat('f', 64), 'approved', repeat('f', 64), now());
  -- The same account connecting again (its scopes changed): everything stays.
  update public.user_oauth_connections set scopes = 'openid email https://www.googleapis.com/auth/gmail.send', connected_at = now() where user_id = b and provider = 'google_career';
  update public.user_oauth_connections set email = 'OLD@example.test ' where user_id = b and provider = 'google_career';
  if (select count(*) from public.career_send_queue where id in (q1, q2) and state = 'queued') <> 2 then raise exception 'FAIL the same account connecting again keeps its emails'; end if;
  if not exists (select 1 from public.career_mail_events where user_id = b) then raise exception 'FAIL the same account connecting again keeps its mail'; end if;
  -- Another account: the old mailbox's emails are cancelled, its follow-up too, its mail erased; Outlook untouched.
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values (b, 'google_career', 'oauth_google_career_' || b, 'new@example.test', 'openid email')
    on conflict (user_id, provider) do update set email = excluded.email, scopes = excluded.scopes;
  if (select count(*) from public.career_send_queue where id in (q1, q2) and state = 'cancelled' and result = 'gmail disconnected') <> 2 then raise exception 'FAIL another account cancels the old mailbox''s emails: %', (select jsonb_agg(state) from public.career_send_queue where id in (q1, q2)); end if;
  if (select state from public.career_send_queue where id = qo) <> 'queued' then raise exception 'FAIL the other mailbox is untouched'; end if;
  if exists (select 1 from public.career_mail_events where user_id = b) then raise exception 'FAIL the old account''s mail is erased'; end if;
  if (select status from public.career_outreach_actions where thread_id = th) <> 'cancelled' then raise exception 'FAIL the old mailbox''s approved follow-up is cancelled'; end if;
  if not exists (select 1 from public.user_oauth_connections where user_id = b and provider = 'google_career' and email = 'new@example.test') then raise exception 'FAIL the new account is connected'; end if;
  if (select state from public.career_send_accounts where user_id = b and provider = 'gmail') is distinct from 'ok' then raise exception 'FAIL the new account can send: %', (select state from public.career_send_accounts where user_id = b and provider = 'gmail'); end if;
  raise notice 'ok   another account over the one connected cancels the old mailbox''s emails and follow-ups and erases its mail; the same account keeps them';

  -- 3. a deleted account is quiet and gone
  if public.career_user_quiet(c) or public.career_account_gone(c) then raise exception 'FAIL a live account is neither quiet nor gone'; end if;
  delete from auth.users where id = c;
  if not public.career_user_quiet(c) or not public.career_account_gone(c) then raise exception 'FAIL a deleted account is quiet and gone'; end if;
  if not public.career_account_gone(null) then raise exception 'FAIL no account is gone'; end if;
  raise notice 'ok   a deleted account is quiet and gone';

  -- 4. the record
  insert into public.account_deletion_log (deleted, google, outlook, failures) values (true, '{"google_career":"revoked","gmail":"refused"}', true, '{}');
  begin
    insert into public.account_deletion_log (deleted, google) values (true, '{"google_career":"sure"}');
    raise exception 'FAIL an unknown outcome is refused';
  exception when check_violation then null; end;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'account_deletion_log' and (data_type = 'uuid' or column_name ~ 'user|email|phone')) then
    raise exception 'FAIL the record has no column that names a person';
  end if;
  raise notice 'ok   the deletion record names nobody and takes only known outcomes';
end $$;

-- 5. service role only
set local role authenticated;
do $$ begin
  begin perform public.oauth_vault_refresh('oauth_google_career_x', '{}'); raise exception 'FAIL authenticated refreshes a token'; exception when insufficient_privilege then null; end;
  begin perform public.career_account_gone(gen_random_uuid()); raise exception 'FAIL authenticated reads gone'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.account_deletion_log; raise exception 'FAIL authenticated reads the record'; exception when insufficient_privilege then null; end;
  raise notice 'ok   service role only';
end $$;
rollback;
