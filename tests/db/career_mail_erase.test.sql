-- An erase (a new account epoch) deletes the person's mail-tracking events and drafts; a write that is not an erase keeps
-- them; nobody else's rows change (20261021090000_career_mail_erase.sql).
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000391','mail-erase-a@example.test'),('00000000-0000-4000-8000-000000000392','mail-erase-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-000000000391'),('00000000-0000-4000-8000-000000000392');
insert into career_mail_events(user_id,application_ref,kind,company,stage,evidence,message_hash,mail_at)
 select u::uuid,'mail:acme','received','Acme','Submitted','Acme: we received your application',repeat(h,64),now()
 from (values('00000000-0000-4000-8000-000000000391','a'),('00000000-0000-4000-8000-000000000392','b')) v(u,h);
insert into career_mail_drafts(user_id,draft_key,application_ref,kind,company,text,basis)
 select u::uuid,'followup:mail:acme','mail:acme','followup','Acme','Hi, following up on my application.','14 days since received'
 from (values('00000000-0000-4000-8000-000000000391'),('00000000-0000-4000-8000-000000000392')) v(u);
insert into career_mail_cursors(user_id,read_through) values('00000000-0000-4000-8000-000000000391',now()),('00000000-0000-4000-8000-000000000392',now());
insert into career_watch_kv(user_id,key,value) values('00000000-0000-4000-8000-000000000391','career:account','{"version":1,"epoch":0}');
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-000000000391') and (select count(*)=1 from career_mail_drafts where user_id='00000000-0000-4000-8000-000000000391'),'a write that is not an erase keeps mail events and drafts');
update career_watch_kv set value='{"version":2,"epoch":1,"paused":true}' where user_id='00000000-0000-4000-8000-000000000391' and key='career:account';
select t.ok((select count(*)=0 from career_mail_events where user_id='00000000-0000-4000-8000-000000000391'),'an erase deletes the status events read from the person''s mail');
select t.ok((select count(*)=0 from career_mail_drafts where user_id='00000000-0000-4000-8000-000000000391'),'an erase deletes the follow-up and thank-you drafts');
-- The privacy policy ("What Trainee keeps from Gmail") says exactly this: "forget everything" keeps the read time.
select t.ok((select count(*)=1 from career_mail_cursors where user_id='00000000-0000-4000-8000-000000000391'),'an erase keeps the read cursor (the policy says so); only a disconnect or an account deletion removes it');
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-000000000392') and (select count(*)=1 from career_mail_drafts where user_id='00000000-0000-4000-8000-000000000392'),'nobody else''s mail rows change');
insert into career_mail_events(user_id,application_ref,kind,company,stage,evidence,message_hash,mail_at) values('00000000-0000-4000-8000-000000000391','mail:beta','received','Beta','Submitted','Beta: we received your application',repeat('c',64),now());
update career_watch_kv set value='{"version":3,"epoch":1,"paused":true}' where user_id='00000000-0000-4000-8000-000000000391' and key='career:account';
select t.ok((select count(*)=1 from career_mail_events where user_id='00000000-0000-4000-8000-000000000391'),'mail read after the erase stays when a later write keeps the same epoch');
select t.ok(not has_function_privilege('authenticated','public.career_mail_on_erase()','execute'),'the trigger function is not callable by a signed-in person');
rollback;
