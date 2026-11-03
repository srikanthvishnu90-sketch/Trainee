-- IDENTITY SCENARIOS (20261030120000_channel_identity.sql): a Telegram chat may ask to be linked (its own shared number); a
-- Telegram contact keeps the number it was given and channel_inbound_seen never gives it one; the number's account is
-- returned with the person's STOP (any of their contacts), an account that is not stopped first; only the service role.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000e301','id-a@example.test'),('00000000-0000-4000-8000-00000000e302','id-b@example.test'),
 ('00000000-0000-4000-8000-00000000e303','id-c@example.test');
insert into profiles(id) select id from auth.users where email like 'id-_@example.test';
insert into channel_contacts(contact,user_id,last_inbound_at,created_at) values
 ('+15550009301','00000000-0000-4000-8000-00000000e301',now() - interval '1 hour',now() - interval '2 days'),
 ('tg:9301','00000000-0000-4000-8000-00000000e301',now() - interval '3 hours',now() - interval '2 days');
set role service_role;

-- A Telegram contact keeps the number it is given (the person's own share); without one it has none.
insert into channel_contacts(contact,user_id,phone,last_inbound_at,created_at) values ('tg:9302','00000000-0000-4000-8000-00000000e302','+15550009302',now() - interval '1 hour',now() - interval '1 day');
select t.ok((select phone = '+15550009302' and channel = 'telegram' from channel_contacts where contact = 'tg:9302'),'a Telegram contact keeps the number it signed up with');
select t.ok((select phone is null from channel_contacts where contact = 'tg:9301'),'and has none otherwise');
select public.channel_inbound_seen('tg:9301', now(), null, '+15550009399');
select t.ok((select phone is null from channel_contacts where contact = 'tg:9301'),'a message never gives a Telegram contact a number');
select public.channel_inbound_seen('+15550009301', now(), null, '+15550009398');
select t.ok((select phone = '+15550009301' from channel_contacts where contact = '+15550009301'),'iMessage keeps its own number');

-- The same number on iMessage after a Telegram sign-up by share: the Telegram chat is the number's account.
select t.ok((select user_id = '00000000-0000-4000-8000-00000000e302' and contact = 'tg:9302' and not opted_out from channel_link_candidate_of('+15550009302','imessage')),'the Telegram chat that shared the number is asked');

-- A Telegram chat asks to be linked to the account already on iMessage with its number.
select t.ok((select channel_link_ask('00000000-0000-4000-8000-00000000e301','tg:9311','+15550009301','+15550009301','Someone texted Trainee on Telegram from your number. Reply yes to link it.',now()) like 'link:%'),'a Telegram chat may ask');
select t.ok((select user_id is null and phone = '+15550009301' from channel_contacts where contact = 'tg:9311'),'recorded with its own number, not linked');
select t.must_fail($$insert into channel_link_requests(user_id,contact,phone,asked_on,created_at,expires_at) values ('00000000-0000-4000-8000-00000000e301','tg:-100123','+15550009301','+15550009301',now(),now() + interval '1 hour')$$,'channel_link_requests_contact_check','a group chat never asks');
select t.must_fail($$insert into channel_link_requests(user_id,contact,phone,asked_on,created_at,expires_at) values ('00000000-0000-4000-8000-00000000e301','someone@example.test','+15550009301','+15550009301',now(),now() + interval '1 hour')$$,'channel_link_requests_contact_check','nor an address');
-- Account A has a Telegram chat already (one per channel): the yes moves the account to the new chat, as a link token does
-- (it raised a unique violation, and every yes read "I couldn't answer that").
select t.ok((select channel_link_confirm('00000000-0000-4000-8000-00000000e301','+15550009301','This chat is linked to your Trainee account now. Text here any time.',now())->>'contact' = 'tg:9311'),'the yes from iMessage links the Telegram chat');
select t.ok((select user_id = '00000000-0000-4000-8000-00000000e301' from channel_contacts where contact = 'tg:9311'),'linked');
select t.ok((select user_id is null and thread_id is null and not home from channel_contacts where contact = 'tg:9301'),'the earlier Telegram chat is let go (one per channel)');
select t.ok((select count(*) = 1 from channel_contacts where user_id = '00000000-0000-4000-8000-00000000e301' and channel = 'telegram'),'one Telegram chat');
select t.ok((select channel = 'telegram' from career_outbox where key like 'link:%:done' and user_id = '00000000-0000-4000-8000-00000000e301'),'told on the new chat');

-- STOP is the person's: a STOP on any of the account's contacts marks the number's account stopped.
insert into channel_contacts(contact,user_id,last_inbound_at,created_at) values
 ('+15550009303','00000000-0000-4000-8000-00000000e303',now() - interval '1 hour',now() - interval '1 day'),
 ('tg:9303','00000000-0000-4000-8000-00000000e303',now() - interval '2 hours',now() - interval '1 day');
select t.ok((select not opted_out from channel_link_candidate_of('+15550009303','whatsapp')),'not stopped');
select public.channel_set_opt_out('tg:9303', true, now());
select t.ok((select contact = '+15550009303' and opted_out from channel_link_candidate_of('+15550009303','whatsapp')),'a STOP on Telegram stops the account the number asks (no question held unseen)');
select public.channel_set_opt_out('+15550009303', false, now());
select t.ok((select not opted_out from channel_link_candidate_of('+15550009303','whatsapp')),'START on iMessage: asked again');
select public.channel_set_opt_out('+15550009303', true, now());
select t.ok((select opted_out from channel_link_candidate_of('+15550009303','whatsapp')),'a STOP on the contact itself: the account is still returned, marked');
-- One number on two accounts: the one that is not stopped comes first.
insert into channel_contacts(contact,user_id,phone,last_inbound_at,created_at) values ('wa:US.e302','00000000-0000-4000-8000-00000000e302','+15550009303',now() - interval '5 hours',now() - interval '1 day');
select t.ok((select user_id = '00000000-0000-4000-8000-00000000e302' and not opted_out from channel_link_candidate_of('+15550009303','telegram')),'an account that is not stopped first');
select t.ok((select count(*) = 0 from channel_link_candidate_of('+15550009399','telegram')),'a number with no account: none');

-- The sign-up refusal is said once, and a row some other step left is not a refusal already said.
select t.ok(not channel_refused_before('+15550009377', now()),'a stranger is told the first time');
select t.ok(channel_refused_before('+15550009377', now()),'and not again');
select t.ok(not channel_refused_before('tg:9301', now()),'a Telegram chat let go (its row kept) is told once, not left in silence');
select t.ok(channel_refused_before('tg:9301', now()),'once');
insert into channel_contacts(contact,last_inbound_at,created_at) values ('wa:15550009378',now(),now());
select t.ok(not channel_refused_before('wa:15550009378', now()),'a number that only asked to be linked is told');
update channel_contacts set user_id = '00000000-0000-4000-8000-00000000e302' where contact = '+15550009377';
select t.ok((select refused_at is null from channel_contacts where contact = '+15550009377'),'a contact that gets an account starts afresh');
update channel_contacts set user_id = null where contact = '+15550009377';
select t.ok(not channel_refused_before('+15550009377', now()),'and is told again once it is no one''s');

-- The open question of a chat that asked: found by the chat, while it is open.
select t.ok(channel_link_ask('00000000-0000-4000-8000-00000000e301','wa:15550009301','+15550009301','+15550009301','Someone texted Trainee on WhatsApp from your number. Reply yes to link it.',now()) like 'link:%','asked');
select t.ok(channel_link_pending('wa:15550009301', now()) = '+15550009301','the open question is found by the chat that asked');
select t.ok(channel_link_pending('wa:15550009301', now() + interval '61 minutes') is null,'not after the hour');
select t.ok(channel_link_pending('tg:9399', now()) is null,'nor for a chat that never asked');

-- Only the service role.
reset role;
select t.as_user('00000000-0000-4000-8000-00000000e301');
set role authenticated;
select t.must_fail($$select * from channel_link_candidate_of('+15550009301','whatsapp')$$,'permission denied','a signed-in person cannot look a number up');
reset role;
set role anon;
select t.must_fail($$select * from channel_link_candidate_of('+15550009301','whatsapp')$$,'permission denied','nor can anon');
reset role;
rollback;
