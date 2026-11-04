-- Google verification (2026-10-26): deleting the career Google row (a disconnect) deletes what mail tracking kept from
-- that Gmail (events, drafts, read cursor); a reconnect (upsert = update) keeps them; the legacy "gmail" row's delete
-- touches nothing; nobody else's rows change (20261026200011_google_disconnect_erase.sql).
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000004a1','gdis-a@example.test'),('00000000-0000-4000-8000-0000000004a2','gdis-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000004a1'),('00000000-0000-4000-8000-0000000004a2');
insert into career_mail_events(user_id,application_ref,kind,company,stage,evidence,message_hash,mail_at)
 select u::uuid,'mail:acme','received','Acme','Submitted','Acme: we received your application',repeat(h,64),now()
 from (values('00000000-0000-4000-8000-0000000004a1','a'),('00000000-0000-4000-8000-0000000004a2','b')) v(u,h);
insert into career_mail_drafts(user_id,draft_key,application_ref,kind,company,text,basis)
 select u::uuid,'followup:mail:acme','mail:acme','followup','Acme','Hi, following up on my application.','14 days since received'
 from (values('00000000-0000-4000-8000-0000000004a1'),('00000000-0000-4000-8000-0000000004a2')) v(u);
insert into career_mail_cursors(user_id,read_through)
 select u::uuid, now() from (values('00000000-0000-4000-8000-0000000004a1'),('00000000-0000-4000-8000-0000000004a2')) v(u);
set role service_role;
insert into public.user_oauth_connections(user_id,provider,vault_name,email,scopes) values
  ('00000000-0000-4000-8000-0000000004a1','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004a1','a@example.test','openid email https://www.googleapis.com/auth/gmail.readonly'),
  ('00000000-0000-4000-8000-0000000004a1','gmail','oauth_gmail_00000000-0000-4000-8000-0000000004a1','a@example.test','https://www.googleapis.com/auth/gmail.readonly'),
  ('00000000-0000-4000-8000-0000000004a2','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004a2','b@example.test','https://www.googleapis.com/auth/gmail.readonly');
reset role;
-- A reconnect is the callback's upsert: an update of the same row, never a delete.
insert into public.user_oauth_connections(user_id,provider,vault_name,email,scopes) values
  ('00000000-0000-4000-8000-0000000004a1','google_career','oauth_google_career_00000000-0000-4000-8000-0000000004a1','a@example.test','https://www.googleapis.com/auth/gmail.readonly')
  on conflict (user_id,provider) do update set scopes=excluded.scopes, connected_at=now();
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-0000000004a1') and (select count(*)=1 from career_mail_drafts where user_id='00000000-0000-4000-8000-0000000004a1') and (select count(*)=1 from career_mail_cursors where user_id='00000000-0000-4000-8000-0000000004a1'),'a reconnect (upsert) keeps the mail rows');
delete from public.user_oauth_connections where user_id='00000000-0000-4000-8000-0000000004a1' and provider='gmail';
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-0000000004a1'),'removing the legacy finance grant (provider gmail) keeps the career mail rows');
delete from public.user_oauth_connections where user_id='00000000-0000-4000-8000-0000000004a1' and provider='google_career';
select t.ok((select count(*)=0 from career_mail_events where user_id='00000000-0000-4000-8000-0000000004a1'),'disconnecting Google deletes the status events read from that Gmail');
select t.ok((select count(*)=0 from career_mail_drafts where user_id='00000000-0000-4000-8000-0000000004a1'),'and the follow-up and thank-you drafts made from them');
select t.ok((select count(*)=0 from career_mail_cursors where user_id='00000000-0000-4000-8000-0000000004a1'),'and the read cursor');
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-0000000004a2') and (select count(*)=1 from career_mail_drafts where user_id='00000000-0000-4000-8000-0000000004a2') and (select count(*)=1 from career_mail_cursors where user_id='00000000-0000-4000-8000-0000000004a2'),'nobody else''s mail rows change');
delete from auth.users where id='00000000-0000-4000-8000-0000000004a2';
select t.ok((select count(*)=0 from career_mail_events where user_id='00000000-0000-4000-8000-0000000004a2') and (select count(*)=0 from public.user_oauth_connections where user_id='00000000-0000-4000-8000-0000000004a2'),'an account deletion still takes the grant and the mail rows together');
select t.ok(not has_function_privilege('authenticated','public.google_career_disconnect_erase()','execute') and not has_function_privilege('anon','public.google_career_disconnect_erase()','execute'),'the trigger function is not callable by a signed-in person or anyone anonymous');
rollback;
