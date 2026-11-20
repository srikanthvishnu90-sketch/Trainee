-- D-062 (20261111120000_career_google_accounts.sql), in the database alone: a second Google account is ADDED, not swapped in; one
-- address belongs to one person (added or first grant, either way); each added account has its own Vault entry, under a name
-- derived from its owner and address; its events carry its address and are recorded only for an address the person has
-- connected; disconnecting one account takes only its token and its events; disconnecting the first grant leaves the added
-- accounts' events; deleting the person removes every row and token; no client can read the table. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000d6201';
  b uuid := '00000000-0000-4000-8000-0000000d6202';
  r text; n int; ok boolean; s text;
  ev jsonb;
begin
  insert into auth.users(id, email) values (a, 'd62a@example.test'), (b, 'd62b@example.test');
  insert into profiles(id) values (a), (b) on conflict do nothing;
  -- 1. no first grant yet: the first grant's own path
  r := public.career_google_account_commit(a, '{"access_token":"t1"}', 'Sam@Example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  if r <> 'primary' then raise exception 'FAIL with no first grant, the first grant''s path: %', r; end if;
  r := public.oauth_connect_commit(a, 'google_career', '{"access_token":"t1","refresh_token":"r1","email":"sam@example.test"}', 'sam@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
  if r <> 'connected' then raise exception 'FAIL first grant: %', r; end if;
  r := public.career_google_account_commit(a, '{"access_token":"t1b"}', 'sam@example.test', 'x');
  if r <> 'primary' then raise exception 'FAIL the first grant''s own address again is its path: %', r; end if;
  -- 2. a second address is added; the first grant is untouched
  r := public.career_google_account_commit(a, '{"access_token":"t2","refresh_token":"r2"}', ' Sam.Work@Example.test ', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
  if r <> 'added' then raise exception 'FAIL a second account is added: %', r; end if;
  if (select email from user_oauth_connections where user_id = a and provider = 'google_career') <> 'sam@example.test' then raise exception 'FAIL the first grant was replaced'; end if;
  if (select vault_name from career_google_accounts where user_id = a and mailbox = 'sam.work@example.test') <> 'oauth_google_career_' || a::text || '_' || md5('sam.work@example.test') then
    raise exception 'FAIL the added account''s Vault name is not derived'; end if;
  s := public.career_google_account_vault_read(a, 'sam.work@example.test');
  if s is null or (s::jsonb->>'access_token') <> 't2' or (s::jsonb->>'grant') is null then raise exception 'FAIL the added token is stored and stamped: %', s; end if;
  if public.career_google_account_vault_read(b, 'sam.work@example.test') is not null then raise exception 'FAIL another person read the token'; end if;
  begin
    insert into career_google_accounts(user_id, mailbox, vault_name) values (a, 'x@example.test', 'oauth_google_career_' || b::text);
    raise exception 'FAIL a row pointing at another Vault name was accepted';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  -- 3. one address, one person
  r := public.career_google_account_commit(b, '{"access_token":"tb"}', 'bee@example.test', 'x');
  if r <> 'primary' then raise exception 'FAIL b first: %', r; end if;
  r := public.oauth_connect_commit(b, 'google_career', '{"access_token":"tb","email":"bee@example.test"}', 'bee@example.test', 'x');
  r := public.career_google_account_commit(b, '{"access_token":"x"}', 'sam.work@example.test', 'x');
  if r <> 'taken' then raise exception 'FAIL another person''s added account was added: %', r; end if;
  r := public.career_google_account_commit(b, '{"access_token":"x"}', 'sam@example.test', 'x');
  if r <> 'taken' then raise exception 'FAIL another person''s first grant was added: %', r; end if;
  r := public.oauth_connect_commit(b, 'google_career', '{"access_token":"x","email":"sam.work@example.test"}', 'sam.work@example.test', 'x');
  if r <> 'taken' then raise exception 'FAIL another person''s added account became a first grant: %', r; end if;
  if (select email from user_oauth_connections where user_id = b and provider = 'google_career') <> 'bee@example.test' then raise exception 'FAIL b''s grant moved'; end if;
  -- 4. events carry their account; an address the person has not connected is not recorded
  ev := jsonb_build_array(
    jsonb_build_object('application_ref', 'mail:acme', 'kind', 'received', 'company', 'Acme', 'stage', 'Submitted', 'evidence', 'Thanks for applying', 'message_hash', repeat('1', 64), 'mail_at', now()::text),
    jsonb_build_object('application_ref', 'mail:globex', 'kind', 'received', 'company', 'Globex', 'stage', 'Submitted', 'evidence', 'Thanks for applying', 'message_hash', repeat('2', 64), 'mail_at', now()::text, 'mailbox', 'Sam.Work@example.test'),
    jsonb_build_object('application_ref', 'mail:initech', 'kind', 'received', 'company', 'Initech', 'stage', 'Submitted', 'evidence', 'Thanks for applying', 'message_hash', repeat('3', 64), 'mail_at', now()::text, 'mailbox', 'stranger@example.test'));
  perform public.career_mail_record_events(a, ev, null);
  if (select string_agg(company || ':' || coalesce(mailbox, '-'), ',' order by company) from career_mail_events where user_id = a) <> 'Acme:-,Globex:sam.work@example.test' then
    raise exception 'FAIL events by account: %', (select string_agg(company || ':' || coalesce(mailbox, '-'), ',') from career_mail_events where user_id = a); end if;
  if not public.career_mailbox_is(a, 'google_career', 'sam.work@example.test') or public.career_mailbox_is(a, 'google_career', 'stranger@example.test') then raise exception 'FAIL mailbox_is'; end if;
  -- 5. a refresh only over the same address and grant
  if public.career_google_account_vault_refresh(a, 'sam.work@example.test', '{"access_token":"t3","email":"other@example.test"}') then raise exception 'FAIL a refresh for another address'; end if;
  if public.career_google_account_vault_refresh(a, 'sam.work@example.test', '{"access_token":"t3","grant":"old"}') then raise exception 'FAIL a refresh of another grant'; end if;
  if not public.career_google_account_vault_refresh(a, 'sam.work@example.test', jsonb_build_object('access_token', 't3', 'grant', (s::jsonb->>'grant'))::text) then raise exception 'FAIL the same grant''s refresh'; end if;
  -- 6. at most five added accounts
  for n in 1..4 loop r := public.career_google_account_commit(a, '{"access_token":"x"}', 'extra' || n || '@example.test', 'x'); end loop;
  r := public.career_google_account_commit(a, '{"access_token":"x"}', 'extra5@example.test', 'x');
  if r <> 'limit' then raise exception 'FAIL a sixth added account: %', r; end if;
  delete from career_google_accounts where user_id = a and mailbox like 'extra%';
  -- 7. disconnecting the first grant keeps the added account and its events
  delete from user_oauth_connections where user_id = a and provider = 'google_career';
  if (select string_agg(company, ',') from career_mail_events where user_id = a) <> 'Globex' then raise exception 'FAIL the first grant''s disconnect took the added account''s events'; end if;
  if not public.career_mailbox_live(a, 'google_career', null) then raise exception 'FAIL an added account keeps the mail run alive'; end if;
  -- 8. disconnecting the added account takes its token and its events
  delete from career_google_accounts where user_id = a and mailbox = 'sam.work@example.test';
  if exists (select 1 from vault.secrets where name = 'oauth_google_career_' || a::text || '_' || md5('sam.work@example.test')) then raise exception 'FAIL the token outlived its account'; end if;
  if exists (select 1 from career_mail_events where user_id = a) then raise exception 'FAIL events outlived their account'; end if;
  if public.career_mailbox_live(a, 'google_career', null) then raise exception 'FAIL nothing connected is still live'; end if;
  -- 9. deleting the person removes every added account and its token
  r := public.career_google_account_commit(b, '{"access_token":"y"}', 'bee.two@example.test', 'x');
  if r <> 'added' then raise exception 'FAIL b adds: %', r; end if;
  delete from auth.users where id = b;
  if exists (select 1 from career_google_accounts where user_id = b) or exists (select 1 from vault.secrets where name like 'oauth_google_career_' || b::text || '%') then
    raise exception 'FAIL a deleted person left an account or a token'; end if;
  -- 10. no client reads or writes the table, and the functions are the service role's
  if has_table_privilege('authenticated', 'public.career_google_accounts', 'select') or has_table_privilege('anon', 'public.career_google_accounts', 'select')
     or has_table_privilege('authenticated', 'public.career_google_accounts', 'insert') then raise exception 'FAIL a client can reach career_google_accounts'; end if;
  if has_function_privilege('authenticated', 'public.career_google_account_commit(uuid, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.career_google_account_vault_read(uuid, text)', 'execute') then raise exception 'FAIL a client can run the account functions'; end if;
  raise notice 'ok   a second Google account is added; one address one person; tokens by derived name; events by account; disconnect one, the first, or the person';
end $$;
rollback;
