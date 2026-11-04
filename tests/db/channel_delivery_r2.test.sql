-- CHANNEL DELIVERY ROUND 2 (20261030100000_channel_delivery_r2.sql): a row's messages that went (sent_parts, every id in
-- order); a provider's "failed" after it was accepted put back from the message that failed (held for the window, failed
-- with the reason otherwise, a throughput refusal retried), in any order, and a late copy finding nothing; a row bound to a
-- channel the person no longer has sent home, or failed with the reason when no channel is left; a WhatsApp number released
-- from an account or moved with its person; the home channel's held rows queued again; only the service role (and the
-- signed-in person for their home channel). Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000d201','r2-a@example.test'),('00000000-0000-4000-8000-00000000d202','r2-b@example.test'),
 ('00000000-0000-4000-8000-00000000d203','r2-c@example.test'),('00000000-0000-4000-8000-00000000d204','r2-d@example.test');
insert into profiles(id) select id from auth.users where email like 'r2-_@example.test';
insert into channel_contacts(contact,user_id,alias,last_inbound_at,created_at) values
 ('wa:15550009201','00000000-0000-4000-8000-00000000d201','US.a201',now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009201','00000000-0000-4000-8000-00000000d201',null,now() - interval '3 hours',now() - interval '2 days'),
 ('tg:9202','00000000-0000-4000-8000-00000000d202',null,now() - interval '1 hour',now() - interval '2 days'),
 ('tg:9203','00000000-0000-4000-8000-00000000d203',null,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009203','00000000-0000-4000-8000-00000000d203',null,now() - interval '5 hours',now() - interval '2 days'),
 ('wa:15550009204','00000000-0000-4000-8000-00000000d204','US.d204',now() - interval '30 hours',now() - interval '2 days'),
 ('tg:9204','00000000-0000-4000-8000-00000000d204',null,now() - interval '40 hours',now() - interval '2 days');
set role service_role;

-- sent_parts: a column from 0, never negative.
select t.ok((select column_default = '0' and is_nullable = 'NO' from information_schema.columns where table_name = 'career_outbox' and column_name = 'sent_parts'),'sent_parts is a count from 0');

-- A three-message row delivered; Meta's "failed" for message 3 arrives first, then message 2's (out of order).
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,status,delivered_at,provider_id,provider_ids) values
 ('00000000-0000-4000-8000-00000000d201','reply:wa:r1','reply','a\n\nb\n\nc',now() - interval '5 minutes','whatsapp','delivered',now(),'wamid.1',array['wamid.1','wamid.2','wamid.3']);
select t.must_fail($$update career_outbox set sent_parts = -1 where key = 'reply:wa:r1'$$,'career_outbox_sent_parts','sent_parts is never negative');
select t.ok(career_outbox_rehold('wamid.3', now(), 'WhatsApp 131047: closed') = 1,'a window failure on message 3 holds the row');
select t.ok((select status = 'held' and sent_parts = 2 and provider_ids = array['wamid.1','wamid.2'] and delivered_at is null from career_outbox where key = 'reply:wa:r1'),'it resumes from message 3: two went, their ids kept');
select t.ok(career_outbox_rehold('wamid.2', now(), 'WhatsApp 131047: closed') = 1,'message 2''s failure, arriving after, still counts');
select t.ok((select status = 'held' and sent_parts = 1 and provider_ids = array['wamid.1'] from career_outbox where key = 'reply:wa:r1'),'it now resumes from message 2 (only message 1 went)');
select t.ok(career_outbox_rehold('wamid.3', now(), 'again') = 0 and career_outbox_rehold('wamid.2', now(), 'again') = 0,'a late copy of either status finds nothing');
select t.ok((select sent_parts = 1 from career_outbox where key = 'reply:wa:r1'),'and changes nothing');
-- Sent again from message 2 (new ids); a late copy of an old id still finds nothing.
update career_outbox set status = 'delivered', delivered_at = now(), sent_parts = 0, provider_ids = array['wamid.1','wamid.9','wamid.10'] where key = 'reply:wa:r1';
select t.ok(career_outbox_rehold('wamid.2', now(), 'late') = 0 and career_outbox_fail_sent('wamid.3', now(), 'late', false) = 0,'after it went again, the old messages'' statuses find nothing (it was held again and sent a third time)');

-- Any other failure: failed with the reason, from the message that failed; a throughput refusal retried within the cap.
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,status,delivered_at,provider_id,provider_ids,attempts) values
 ('00000000-0000-4000-8000-00000000d201','reply:wa:r2','reply','x',now() - interval '5 minutes','whatsapp','delivered',now(),'wamid.20',array['wamid.20'],0),
 ('00000000-0000-4000-8000-00000000d201','reply:wa:r3','reply','x\n\ny',now() - interval '5 minutes','whatsapp','delivered',now(),'wamid.30',array['wamid.30','wamid.31'],0),
 ('00000000-0000-4000-8000-00000000d201','reply:wa:r4','reply','x',now() - interval '5 minutes','whatsapp','delivered',now(),'wamid.40',null,2);
select t.ok(career_outbox_fail_sent('wamid.20', now(), 'WhatsApp 131026: undeliverable', false) = 1,'131026 marks the row');
select t.ok((select status = 'failed' and retry_at is null and error like '%131026%' and attempts = 1 and delivered_at is null from career_outbox where key = 'reply:wa:r2'),'failed for good, with the reason (it stayed "delivered")');
select t.ok(career_outbox_fail_sent('wamid.20', now(), 'again', false) = 0,'the same status again changes nothing');
select t.ok(career_outbox_fail_sent('wamid.31', now(), 'WhatsApp 130429: throughput', true) = 1,'130429 on message 2 marks the row');
select t.ok((select status = 'failed' and retry_at > now() and sent_parts = 1 and provider_ids = array['wamid.30'] from career_outbox where key = 'reply:wa:r3'),'retried from message 2');
select t.ok(career_outbox_fail_sent('wamid.40', now(), 'WhatsApp 130429: throughput', true) = 1 and (select retry_at is null from career_outbox where key = 'reply:wa:r4'),'a row at its last attempt is not retried again');
select t.ok((select sent_parts = 0 and provider_ids is null from career_outbox where key = 'reply:wa:r4'),'a single id (provider_id only) resumes from the start');

-- A row bound to a channel the person no longer has: home if they have one, else failed with the reason.
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,part_of,part) values
 ('00000000-0000-4000-8000-00000000d203','reply:tg:5:1','reply','one',now() - interval '1 minute','telegram','reply:tg:5',1),
 ('00000000-0000-4000-8000-00000000d203','reply:tg:5:2','reply','two',now() - interval '1 minute','telegram','reply:tg:5',2),
 ('00000000-0000-4000-8000-00000000d202','reply:tg:6','reply','three',now() - interval '1 minute','telegram',null,null);
insert into career_outbox(user_id,key,kind,text,deliver_at) values ('00000000-0000-4000-8000-00000000d202','digest:6','digest','news',now() - interval '1 minute');
select t.ok(career_outbox_reroute(now()) = 0,'nothing to do while every bound channel is there');
reset role;
update channel_contacts set user_id = null, thread_id = null where contact in ('tg:9203','tg:9202'); -- channel_telegram_unlink_as's effect
set role service_role;
select t.ok((select count(*) = 0 from career_outbox_claim(now(), 100) where key in ('reply:tg:5:1','reply:tg:5:2')),'before: the unlinked Telegram''s rows are never claimed (queued forever)');
select t.ok(career_outbox_reroute(now()) = 3,'three rows rerouted or failed');
select t.ok((select bool_and(channel is null and status = 'queued') from career_outbox where part_of = 'reply:tg:5'),'the person''s rows now follow their home channel');
select t.ok((select array_agg(key order by deliver_at, id) = array['reply:tg:5:1','reply:tg:5:2'] and bool_and(contact = '+15550009203') from career_outbox_claim(now(), 100) where key like 'reply:tg:5:%'),'and go out there, in order');
select t.ok((select status = 'failed' and retry_at is null and error like '%no other texting channel%' from career_outbox where key = 'reply:tg:6'),'with no channel left, the answer fails with the reason');
select t.ok((select status = 'queued' from career_outbox where key = 'digest:6'),'a proactive row with no channel waits, as before (the dashboard reads it)');
select t.ok(career_outbox_reroute(now()) = 0,'a second run finds nothing');

-- A WhatsApp number given to someone else: released from the account (the row goes; a stranger's first message is told).
select t.ok(channel_contact_release('wa:15550009201', now()) = '00000000-0000-4000-8000-00000000d201','the number is released from its account');
select t.ok(not exists (select from channel_contacts where contact = 'wa:15550009201'),'its row is gone (alias, STOP and window with it)');
select t.ok(channel_contact_release('wa:15550009201', now()) is null,'releasing it again does nothing');
-- A person who changed their number: the account (alias, home, STOP, window) moves; the old number is let go.
reset role;
update channel_contacts set opted_out = true, opted_out_at = now() where contact = 'tg:9204';
set role service_role;
select t.ok(channel_wa_number_moved('wa:15550009204', 'wa:15550009299', now()),'the number moves');
select t.ok((select user_id = '00000000-0000-4000-8000-00000000d204' and alias = 'US.d204' and phone = '+15550009299' from channel_contacts where contact = 'wa:15550009299'),'the new number is the account''s, with its business-scoped id');
select t.ok((select user_id is null and alias is null from channel_contacts where contact = 'wa:15550009204'),'the old number is no one''s');
select t.ok(channel_opted_out('wa:15550009299'),'the person''s STOP still holds');
select t.ok(not channel_wa_number_moved('wa:15550009204', 'wa:15550009298', now()),'an old number with no account moves nothing');
select t.ok(not channel_wa_number_moved('wa:15550009299', 'wa:15550009203x', now()),'a malformed new number moves nothing');

-- The home channel: what WhatsApp's window held for the home channel goes back in the queue.
insert into career_outbox(user_id,key,kind,text,deliver_at,status) values ('00000000-0000-4000-8000-00000000d204','status:h1','status','held',now() - interval '1 hour','held');
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,status) values ('00000000-0000-4000-8000-00000000d204','reply:wa:h2','reply','bound',now() - interval '1 hour','whatsapp','held');
reset role;
select t.as_user('00000000-0000-4000-8000-00000000d204');
set role authenticated;
select t.ok(channel_set_home('telegram'),'the person sets Telegram as home');
reset role;
select t.ok((select status = 'queued' from career_outbox where key = 'status:h1'),'the held proactive row goes back in the queue (for Telegram)');
select t.ok((select status = 'held' from career_outbox where key = 'reply:wa:h2'),'an answer bound to WhatsApp stays held for WhatsApp');

-- Only the service role.
select t.as_user('00000000-0000-4000-8000-00000000d204');
set role authenticated;
select t.must_fail($$select career_outbox_reroute(now())$$,'permission denied','a signed-in person cannot reroute');
select t.must_fail($$select career_outbox_fail_sent('x', now(), 'x', false)$$,'permission denied','nor fail a row');
select t.must_fail($$select channel_contact_release('wa:15550009299', now())$$,'permission denied','nor release a number');
select t.must_fail($$select channel_wa_number_moved('wa:15550009299', 'wa:15550009200', now())$$,'permission denied','nor move one');
select t.must_fail($$select career_outbox_sent_back('x')$$,'permission denied','nor touch a sent row');
reset role;
set role anon;
select t.must_fail($$select career_outbox_reroute(now())$$,'permission denied','anon cannot either');
reset role;
rollback;
