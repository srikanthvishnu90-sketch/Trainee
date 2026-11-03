-- M4 (20261027230000_career_outlook_connector.sql): Outlook as a peer of Gmail. A link works once, for its own person; a
-- send key goes once, never under a changed payload, never after a disconnect; the leased claim gives each person to one
-- worker; a disconnect erases what was read, cancels what was waiting and burns the links; nobody but the service role can
-- touch any of it. Rolled back at the end.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000c4a01','oa@example.test'),('00000000-0000-4000-8000-0000000c4a02','ob@example.test');
insert into public.agent_threads(id,user_id) values('00000000-0000-4000-8000-0000000c4f01','00000000-0000-4000-8000-0000000c4a01'),('00000000-0000-4000-8000-0000000c4f02','00000000-0000-4000-8000-0000000c4a02');
set role service_role;
create temp table lk as select career_outlook_link_issue('00000000-0000-4000-8000-0000000c4a01','telegram','00000000-0000-4000-8000-0000000c4f02','connect',now()) tok;
select t.ok((select thread_id is null and user_id = '00000000-0000-4000-8000-0000000c4a01' from career_outlook_links), 'another person''s thread is never put on the link');
select t.ok((select nonce_hash <> (select tok from lk) from career_outlook_links), 'the token is stored only as its hash');
select t.ok((select career_outlook_link_peek(tok, now())->>'status' = 'ok' from lk), 'a peek finds it');
select t.ok((select career_outlook_link_peek(tok, now())->>'status' = 'ok' from lk), 'a peek never uses it');
create temp table op as select career_outlook_link_open(tok, now()) o from lk;
select t.ok((select o ? 'link_id' from op), 'the tap opens it');
select t.ok((select career_outlook_link_open(tok, now())->>'error' = 'used' from lk), 'a second tap is refused');
select t.ok((select career_outlook_link_finish((o->>'link_id')::uuid, 'connected', now())->>'user_id' = '00000000-0000-4000-8000-0000000c4a01' from op), 'the callback names only the link''s own person');
select t.ok((select career_outlook_link_finish((o->>'link_id')::uuid, 'connected', now())->>'error' = 'used' from op), 'a replayed callback is refused');
select t.ok((career_outlook_link_open('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', now())->>'error') = 'invalid', 'an unknown token is refused');

-- Sends: not connected -> nothing; connected -> once per key; a changed payload is refused under its key.
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001',repeat('a',64),'outreach',repeat('c',64),now()) = 'not_connected', 'no Outlook connection, no send');
reset role;
insert into public.user_oauth_connections(user_id,provider,vault_name,email,scopes) values('00000000-0000-4000-8000-0000000c4a01','microsoft','oauth_microsoft_00000000-0000-4000-8000-0000000c4a01','oa@contoso.example','Mail.Send Mail.Read');
select public.oauth_vault_store('oauth_microsoft_00000000-0000-4000-8000-0000000c4a01','{"access_token":"fake"}');
insert into public.career_outlook_state(user_id, token_expires_at, next_sync_at) values('00000000-0000-4000-8000-0000000c4a01', now(), now());
insert into public.career_outlook_messages(user_id,message_hash,from_address,subject,received_at) values('00000000-0000-4000-8000-0000000c4a01',repeat('d',64),'lee@globex.example','Re: hi',now());
set role service_role;
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001',repeat('a',64),'outreach',repeat('c',64),now()) = 'go', 'the first begin goes');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001',repeat('a',64),'outreach',repeat('c',64),now()) = 'unknown', 'a second begin while it is sending never goes');
select t.ok(career_outlook_send_finish('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001','sent',null,now()), 'finished sent');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001',repeat('a',64),'outreach',repeat('c',64),now()) = 'sent', 'a sent key is final');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0001',repeat('b',64),'outreach',repeat('c',64),now()) = 'changed', 'a changed payload under the key is refused');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0002',repeat('a',64),'outreach',repeat('c',64),now()) = 'go', 'another key goes');
select t.ok(career_outlook_send_finish('00000000-0000-4000-8000-0000000c4a01','outreach:k-0002','rate_limited','retry',now()), 'Microsoft said wait');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0002',repeat('a',64),'outreach',repeat('c',64),now()) = 'go', 'a rate-limited key goes again later');
select t.ok(career_outlook_send_finish('00000000-0000-4000-8000-0000000c4a01','outreach:k-0002','rate_limited','retry',now()), 'and waits again');
-- Whoever calls the rail: never a recipient who asked to stop, never a bounced address; nothing is recorded as going.
reset role;
insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000c4a01') on conflict do nothing;
set role service_role;
insert into public.career_outreach_dnc(user_id, email_hash) values ('00000000-0000-4000-8000-0000000c4a01', repeat('e',64));
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0003',repeat('a',64),'outreach',repeat('e',64),now()) = 'opted_out', 'an opted-out recipient is refused');
select t.ok(not exists (select 1 from public.career_outlook_sends where idem_key = 'outreach:k-0003'), 'and no send is recorded for them');
reset role;
create table if not exists public.career_send_bad_addresses (email_hash text primary key, reason text not null default 'bounced');
insert into public.career_send_bad_addresses(email_hash) values (repeat('f',64)) on conflict do nothing;
set role service_role;
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0004',repeat('a',64),'application',repeat('f',64),now()) = 'bounced', 'a bounced address is refused, for any purpose');
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0005',repeat('a',64),'outreach',null,now()) = 'invalid', 'a send names its recipient');

-- Leased claims: one worker has the person; another gets nothing until the lease ends; a stranger cannot release it.
select t.ok((select count(*) from career_outlook_claim('refresh','w1',now(),60,10)) = 1, 'w1 claims the due refresh');
select t.ok((select count(*) from career_outlook_claim('refresh','w2',now(),60,10)) = 0, 'w2 gets nothing while w1 holds it');
select t.ok(not career_outlook_release('refresh','00000000-0000-4000-8000-0000000c4a01','w2',now(),'{}'), 'w2 cannot release w1''s lease');
select t.ok((select count(*) from career_outlook_claim('refresh','w2',now() + interval '61 seconds',60,10)) = 1, 'an expired lease is taken over');
select t.must_fail($$select * from career_outlook_claim('refresh','w3',now(),60,0)$$,'invalid claim','a claim must say its batch size');

-- Disconnect: the row deleted -> tokens, read mail and state gone; waiting sends cancelled; sent ones kept; links burned.
create temp table lk2 as select career_outlook_link_issue('00000000-0000-4000-8000-0000000c4a01','web',null,'connect',now()) tok;
reset role;
delete from public.user_oauth_connections where user_id = '00000000-0000-4000-8000-0000000c4a01' and provider = 'microsoft';
select t.ok(not exists (select 1 from vault.secrets where name = 'oauth_microsoft_00000000-0000-4000-8000-0000000c4a01'), 'tokens gone');
select t.ok(not exists (select 1 from public.career_outlook_messages where user_id = '00000000-0000-4000-8000-0000000c4a01'), 'Outlook mail erased');
select t.ok(not exists (select 1 from public.career_outlook_state where user_id = '00000000-0000-4000-8000-0000000c4a01'), 'Outlook state erased');
select t.ok((select status from public.career_outlook_sends where idem_key = 'outreach:k-0002') = 'cancelled', 'a waiting send is cancelled');
select t.ok((select status from public.career_outlook_sends where idem_key = 'outreach:k-0001') = 'sent', 'a sent one stays the person''s history');
select t.ok((select career_outlook_link_open(tok, now())->>'error' = 'used' from lk2), 'a link made before the disconnect can never connect');
set role service_role;
select t.ok(career_outlook_send_begin('00000000-0000-4000-8000-0000000c4a01','outreach:k-0002',repeat('a',64),'outreach',repeat('c',64),now()) = 'not_connected', 'nothing sends after a disconnect');

-- Only the service role.
reset role;
select t.ok(not has_table_privilege('anon','public.career_outlook_sends','select') and not has_table_privilege('authenticated','public.career_outlook_links','select')
  and not has_table_privilege('authenticated','public.career_outlook_messages','select') and not has_table_privilege('anon','public.career_outlook_state','select'),
  'no table is readable by a session or anon');
select t.ok(not has_function_privilege('anon','public.career_outlook_link_issue(uuid,text,uuid,text,timestamptz)','EXECUTE')
  and not has_function_privilege('authenticated','public.career_outlook_send_begin(uuid,text,text,text,text,timestamptz)','EXECUTE')
  and not has_function_privilege('authenticated','public.career_outlook_claim(text,text,timestamptz,integer,integer,integer)','EXECUTE'),
  'no function is callable by a session or anon');
select t.ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.career_outlook_links'::regclass,'public.career_outlook_state'::regclass,'public.career_outlook_messages'::regclass,'public.career_outlook_sends'::regclass)), 'row level security on every table');
select t.ok((select count(*) from unnest(public.career_erase_tables()) x where x ~ 'career_outlook_(links|state|messages|sends)$') = 4, '"forget everything" covers the four Outlook tables');
rollback;
