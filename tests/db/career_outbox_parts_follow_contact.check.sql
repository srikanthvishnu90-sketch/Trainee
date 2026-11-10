-- 20261110120000_career_outbox_parts_follow_contact.sql: a row some of whose messages went to one chat, claimed again for
-- another chat (Telegram unlinked, the row follows the person to iMessage), goes whole there: the claim's new contact clears
-- the earlier chat's sent_parts and provider_ids. Claimed again for the same chat, it resumes after its parts as before.
-- Through the real two-lane claim (career_outbox_claim_lane). Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000f501','pf-a@example.test'),('00000000-0000-4000-8000-00000000f502','pf-b@example.test');
insert into profiles(id) select id from auth.users where email like 'pf-_@example.test';
insert into channel_contacts(contact,user_id,home,last_inbound_at,created_at) values
 ('tg:9501','00000000-0000-4000-8000-00000000f501',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009501','00000000-0000-4000-8000-00000000f501',false,now() - interval '3 hours',now() - interval '2 days'),
 ('tg:9502','00000000-0000-4000-8000-00000000f502',true,now() - interval '1 hour',now() - interval '2 days'),
 ('+15550009502','00000000-0000-4000-8000-00000000f502',false,now() - interval '3 hours',now() - interval '2 days');
insert into career_outbox(user_id, key, kind, text, deliver_at) values
 ('00000000-0000-4000-8000-00000000f501','digest:pf-a','digest','three bubbles on one chat, one on the other', now() - interval '1 minute'),
 ('00000000-0000-4000-8000-00000000f502','digest:pf-b','digest','three bubbles on one chat, one on the other', now() - interval '1 minute');
set role service_role;
create temp table claimed(id bigint, user_id uuid, contact text, key text);
create or replace function pg_temp.claim() returns void language sql as $$
  insert into claimed select c.id, c.user_id, c.contact, c.key from (
    select * from career_outbox_claim_lane(now(), 10, 'priority', 0, 1) union all select * from career_outbox_claim_lane(now(), 10, 'bulk', 0, 1)) c
  where c.key in ('digest:pf-a','digest:pf-b');
$$;

select pg_temp.claim();
select t.ok((select count(*) from claimed where contact like 'tg:%') = 2, 'both rows claimed for their Telegram chat (home)');
-- the first of their messages went, the second was refused (what the store records for a row stopped part way)
update career_outbox set status = 'failed', retry_at = now() - interval '1 second', attempts = attempts + 1, error = 'Telegram HTTP 502',
  sent_parts = 1, provider_ids = array['tg-1'] where key in ('digest:pf-a','digest:pf-b');
-- A unlinks Telegram; B keeps it
select t.ok(channel_telegram_unlink_as('00000000-0000-4000-8000-00000000f501', now()) = 1, 'A''s Telegram unlinked');
truncate claimed;
select pg_temp.claim();
select t.ok((select contact from claimed where key = 'digest:pf-a') = '+15550009501', 'A''s row claimed again, for their iMessage');
select t.ok((select sent_parts = 0 and provider_ids is null from career_outbox where key = 'digest:pf-a'),
  'A''s row goes whole on iMessage: the Telegram part count and ids are cleared (before: it skipped an iMessage bubble)');
select t.ok((select contact from claimed where key = 'digest:pf-b') = 'tg:9502', 'B''s row claimed again, for the same Telegram chat');
select t.ok((select sent_parts = 1 and provider_ids = array['tg-1'] from career_outbox where key = 'digest:pf-b'),
  'B''s row resumes after its part on the same chat (unchanged)');
select t.ok((select parts_contact from career_outbox where key = 'digest:pf-b') = 'tg:9502', 'B''s parts are recorded as sent to its Telegram chat');
-- quiet hours put B's row back (the store's "queued" mark empties contact), then it is claimed for the same chat again
update career_outbox set status = 'queued', contact = null, claimed_at = null where key = 'digest:pf-b';
select t.ok((select sent_parts = 1 and parts_contact = 'tg:9502' from career_outbox where key = 'digest:pf-b'), 'a put-back keeps the parts and where they went');
update career_outbox set status = 'sending', contact = 'tg:9502' where key = 'digest:pf-b';
select t.ok((select sent_parts = 1 and provider_ids = array['tg-1'] from career_outbox where key = 'digest:pf-b'), 'claimed for the same chat after a put-back, it still resumes after its part');
update career_outbox set status = 'queued', contact = null where key = 'digest:pf-b';
update career_outbox set status = 'sending', contact = '+15550009502' where key = 'digest:pf-b';
select t.ok((select sent_parts = 0 and provider_ids is null and parts_contact is null from career_outbox where key = 'digest:pf-b'), 'claimed for another chat after a put-back, it goes whole');
-- delivered: the part count goes back to 0 and so does where they went
update career_outbox set status = 'delivered', delivered_at = now(), error = null, retry_at = null, claimed_at = null, sent_parts = 0 where key = 'digest:pf-a';
select t.ok((select parts_contact is null from career_outbox where key = 'digest:pf-a'), 'a delivered row keeps no parts_contact');
reset role;
select t.ok(not has_function_privilege('anon', 'public.career_outbox_parts_follow_contact()', 'execute')
  and not has_function_privilege('authenticated', 'public.career_outbox_parts_follow_contact()', 'execute'), 'the trigger function is no one''s to call');
rollback;
