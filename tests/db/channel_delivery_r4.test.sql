-- CHANNEL DELIVERY ROUND 4 (20261105160000_channel_delivery_r4.sql): a person's STOP outlives the chat they said it on. A
-- Telegram chat unlinked, a WhatsApp number released, a chat linked to another account: when the contact that holds the STOP
-- leaves the person, the STOP (with its time) stays on every contact they still have, so nothing Trainee starts goes to
-- them until START. A contact that was not opted out changes nothing; START still clears every contact; an account deleted
-- cascades as before; the trigger's function is no one's to call. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000d401','r4-a@example.test'),('00000000-0000-4000-8000-00000000d402','r4-b@example.test'),
 ('00000000-0000-4000-8000-00000000d403','r4-c@example.test'),('00000000-0000-4000-8000-00000000d404','r4-d@example.test'),
 ('00000000-0000-4000-8000-00000000d405','r4-e@example.test');
insert into profiles(id) select id from auth.users where email like 'r4-_@example.test';
insert into channel_contacts(contact,user_id,home,last_inbound_at,created_at) values
 ('tg:9401','00000000-0000-4000-8000-00000000d401',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009401','00000000-0000-4000-8000-00000000d401',false,now() - interval '3 hours',now() - interval '2 days'),
 ('wa:15550009402','00000000-0000-4000-8000-00000000d402',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009402','00000000-0000-4000-8000-00000000d402',false,now() - interval '3 hours',now() - interval '2 days'),
 ('tg:9403','00000000-0000-4000-8000-00000000d403',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009403','00000000-0000-4000-8000-00000000d403',false,now() - interval '3 hours',now() - interval '2 days'),
 ('tg:9404','00000000-0000-4000-8000-00000000d404',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009404','00000000-0000-4000-8000-00000000d404',false,now() - interval '3 hours',now() - interval '2 days'),
 ('+15550009405','00000000-0000-4000-8000-00000000d405',true,now() - interval '3 hours',now() - interval '2 days');
set role service_role;

-- A says STOP on Telegram, then unlinks Telegram: the STOP (and its time) stays on their iMessage.
select channel_set_opt_out('tg:9401', true, '2026-11-05T15:00:00Z');
select t.ok(channel_opted_out('+15550009401') and career_user_quiet('00000000-0000-4000-8000-00000000d401'),'A is opted out (the STOP on Telegram is the person''s)');
select t.ok(channel_telegram_unlink_as('00000000-0000-4000-8000-00000000d401', now()) = 1,'A''s Telegram unlinked');
select t.ok(channel_opted_out('+15550009401'),'A''s iMessage is still opted out after the unlink (before: Trainee texted it again)');
select t.ok(career_user_quiet('00000000-0000-4000-8000-00000000d401'),'and A is still quiet: nothing Trainee starts goes');
select t.ok((select opted_out_at = '2026-11-05T15:00:00Z' from channel_contacts where contact = '+15550009401'),'with the time of the STOP (an answer to a message from before it stays held)');

-- B blocked the bot... on WhatsApp B says STOP; the number is then released (someone else's now): B's iMessage keeps the STOP.
select channel_set_opt_out('wa:15550009402', true, '2026-11-05T15:05:00Z');
select t.ok(channel_contact_release('wa:15550009402', now()) = '00000000-0000-4000-8000-00000000d402','B''s WhatsApp number released');
select t.ok(channel_opted_out('+15550009402') and career_user_quiet('00000000-0000-4000-8000-00000000d402'),'B''s STOP stays on their iMessage');

-- C's opted-out Telegram chat moves to another account (E): C's iMessage keeps the STOP; E's own contact is not touched.
select channel_set_opt_out('tg:9403', true, '2026-11-05T15:10:00Z');
update channel_contacts set user_id = '00000000-0000-4000-8000-00000000d405', home = false where contact = 'tg:9403';
select t.ok(channel_opted_out('+15550009403'),'C''s iMessage keeps C''s STOP');
select t.ok((select not opted_out from channel_contacts where contact = '+15550009405'),'E''s own number is not opted out by C''s STOP');

-- D was never opted out: unlinking changes nothing on D's other contact.
select t.ok(channel_telegram_unlink_as('00000000-0000-4000-8000-00000000d404', now()) = 1,'D''s Telegram unlinked');
select t.ok((select not opted_out and opted_out_at is null from channel_contacts where contact = '+15550009404'),'D''s iMessage is not opted out');

-- An update that does not move the contact (a new message time) fires nothing.
select channel_set_opt_out('+15550009404', true, '2026-11-05T15:20:00Z');
update channel_contacts set last_inbound_at = now() where contact = '+15550009404';
select t.ok((select count(*) = 1 from channel_contacts where user_id = '00000000-0000-4000-8000-00000000d404'),'D has one contact left');

-- START from the contact that is left clears the person's STOP.
select channel_set_opt_out('+15550009401', false, now());
select t.ok(not channel_opted_out('+15550009401') and not career_user_quiet('00000000-0000-4000-8000-00000000d401'),'START clears it');

-- An account deleted: its contacts cascade away as before (the trigger never blocks the delete).
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-00000000d402';
select t.ok(not exists (select 1 from channel_contacts where user_id = '00000000-0000-4000-8000-00000000d402'),'a deleted account''s contacts are gone');

-- The trigger's function is no one's to call.
select t.ok(not has_function_privilege('anon', 'public.channel_contacts_keep_stop()', 'execute')
  and not has_function_privilege('authenticated', 'public.channel_contacts_keep_stop()', 'execute'),'anon and a signed-in person cannot call the trigger function');
rollback;
