-- Disconnecting Google also deletes the person's undelivered deadline reminder queued in career_outbox from their mail
-- (20261103100000_google_disconnect_erase_outbox.sql, over 20261030050000_account_erase_r2.sql). A reminder already delivered,
-- every other outbox kind and everybody else's reminder stay; a reconnect with the same address keeps the reminder; a
-- different address is the old mailbox's disconnect and deletes it.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000004b1','gdo-a@example.test'),('00000000-0000-4000-8000-0000000004b2','gdo-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000004b1'),('00000000-0000-4000-8000-0000000004b2');
insert into career_outbox(user_id,key,kind,text,deliver_at,delivered_at) values
  ('00000000-0000-4000-8000-0000000004b1','status:deadline:' || repeat('c',64),'status','Reminder: your Acme assessment is due soon.',now() + interval '1 day',null),
  ('00000000-0000-4000-8000-0000000004b1','status:deadline:' || repeat('d',64),'status','Reminder: your Hooli assessment was due.',now() - interval '1 day',now()),
  ('00000000-0000-4000-8000-0000000004b1','alert:test:1','alert','A new job matches.',now(),null),
  ('00000000-0000-4000-8000-0000000004b2','status:deadline:' || repeat('e',64),'status','Reminder: your Acme assessment is due soon.',now() + interval '1 day',null);
set role service_role;
insert into public.user_oauth_connections(user_id,provider,vault_name,email,scopes) values
  ('00000000-0000-4000-8000-0000000004b1','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004b1','a@example.test','openid email https://www.googleapis.com/auth/gmail.readonly'),
  ('00000000-0000-4000-8000-0000000004b2','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004b2','b@example.test','https://www.googleapis.com/auth/gmail.readonly');
reset role;
-- A reconnect with the same address is an update that is not a switch: everything stays.
insert into public.user_oauth_connections(user_id,provider,vault_name,email,scopes) values
  ('00000000-0000-4000-8000-0000000004b1','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004b1','a@example.test','https://www.googleapis.com/auth/gmail.readonly')
  on conflict (user_id,provider) do update set scopes=excluded.scopes, connected_at=now();
select t.ok((select count(*)=3 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b1'),'a reconnect (same address) keeps the queued reminder');
delete from public.user_oauth_connections where user_id='00000000-0000-4000-8000-0000000004b1' and provider='google_career';
select t.ok((select count(*)=0 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b1' and key like 'status:deadline:%' and delivered_at is null),'disconnecting Google deletes the undelivered deadline reminder queued from that Gmail');
select t.ok((select count(*)=1 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b1' and key like 'status:deadline:%' and delivered_at is not null),'a reminder already delivered stays, as part of the person''s own history');
select t.ok((select count(*)=1 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b1' and key='alert:test:1'),'queued messages that did not come from Gmail stay');
select t.ok((select count(*)=1 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b2' and key like 'status:deadline:%' and delivered_at is null),'nobody else''s reminder changes');
-- Connecting another account (the address changes) is the old mailbox's disconnect.
insert into career_outbox(user_id,key,kind,text,deliver_at,delivered_at) values
  ('00000000-0000-4000-8000-0000000004b2','status:deadline:' || repeat('f',64),'status','Reminder: your Globex assessment is due soon.',now() + interval '1 day',null);
update public.user_oauth_connections set email='b2@example.test' where user_id='00000000-0000-4000-8000-0000000004b2' and provider='google_career';
select t.ok((select count(*)=0 from career_outbox where user_id='00000000-0000-4000-8000-0000000004b2' and key like 'status:deadline:%' and delivered_at is null),'connecting a different Google account deletes the old mailbox''s undelivered reminders');
select t.ok(not has_function_privilege('authenticated','public.google_career_disconnect_erase()','execute') and not has_function_privilege('anon','public.google_career_disconnect_erase()','execute'),'the trigger function is still not callable by a signed-in person or anyone anonymous');
rollback;
