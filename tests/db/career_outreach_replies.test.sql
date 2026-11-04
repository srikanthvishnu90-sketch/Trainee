-- MASS NETWORKING M5 (20261027240000_career_outreach_replies.sql): replies understood as a conversation, one follow-up per
-- non-reply after the person's own interval, calls scheduled, every external effect from an approved exact payload, leased
-- queues. State is asserted on the rows; each guard here has a mutation check recorded in the PR.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000c5a01','m5-a@example.test'),('00000000-0000-4000-8000-0000000c5a02','m5-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000c5a01'),('00000000-0000-4000-8000-0000000c5a02');
set role service_role;

-- 1. Watching: a sent thread is tracked once per draft and per provider thread; its mailbox gets one sync row.
create temp table ids(k text primary key, id uuid);
grant all on ids to service_role;
insert into ids select 'stop', career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a01', null, 'gmail', 'g-stop', 'Stop.Me@example.test', 'Stop Person', 'Acme', 'Hello', now() - interval '10 days');
insert into ids select 'quiet', career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a01', null, 'gmail', 'g-quiet', 'quiet@example.test', 'Quiet Person', 'Acme', 'Hello', now() - interval '10 days');
insert into ids select 'ooo', career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a01', null, 'gmail', 'g-ooo', 'away@example.test', 'Away Person', 'Acme', 'Hello', now() - interval '10 days');
insert into ids select 'call', career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a01', null, 'outlook', 'o-call', 'talk@example.test', 'Talk Person', 'Beta', 'Hi', now() - interval '2 days');
select t.ok(career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a01', null, 'gmail', 'g-stop', 'stop.me@example.test', 'x', 'x', 'x', now()) = (select id from ids where k = 'stop'),
  'tracking the same provider thread again returns the same thread');
select t.ok((select count(*) = 2 from career_outreach_sync where user_id = '00000000-0000-4000-8000-0000000c5a01'), 'one sync row per person and mailbox (gmail, outlook)');
select t.ok((select recipient_email = 'stop.me@example.test' from career_outreach_threads where id = (select id from ids where k = 'stop')), 'the address is kept lowercased');

-- 2. Sync leases: a due mailbox goes to one worker; a second worker gets the others; an expired lease is taken again.
select t.ok((select count(*) = 1 from career_outreach_sync_claim('w1', 1, now(), 60)), 'worker 1 leases one mailbox');
select t.ok((select count(*) = 1 from career_outreach_sync_claim('w2', 5, now(), 60)), 'worker 2 gets only the other one, never the leased one');
select t.ok((select count(*) = 0 from career_outreach_sync_claim('w3', 5, now(), 60)), 'nothing left for a third worker while both leases hold');
select t.ok((select count(*) = 2 from career_outreach_sync_claim('w3', 5, now() + interval '2 minutes', 60)), 'expired leases are taken again');
select t.ok(not career_outreach_sync_release('00000000-0000-4000-8000-0000000c5a01', 'gmail', 'w1', 'h-9', now(), null), 'a worker that lost its lease cannot write the cursor');
select t.ok(career_outreach_sync_release('00000000-0000-4000-8000-0000000c5a01', 'gmail', 'w3', 'h-9', now() + interval '5 minutes', null), 'the lease holder writes the cursor and frees the row (the call)');
select t.ok((select cursor = 'h-9' and lease_owner is null from career_outreach_sync where user_id = '00000000-0000-4000-8000-0000000c5a01' and provider = 'gmail'), 'the lease holder writes the cursor and frees the row');

-- 3. A stop: do-not-contact, terminal, open actions cancelled, a message counted once.
insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash,approved_at)
 values('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='stop'),'followup','00000000-0000-4000-8000-00000000ab01',1,'{"to":"stop.me@example.test"}',repeat('a',64),'approved',repeat('a',64),now());
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='stop'), 'm-stop', 'not_interested', now(),
  '{"who":"contact","summary":"Asked not to be contacted.","conversation":{"open_asks":[],"commitments":[],"next_step":"Nothing more will be sent."}}') = 'not_interested', 'a stop sets not_interested');
select t.ok(exists (select 1 from career_outreach_dnc where email_hash = encode(sha256(convert_to('stop.me@example.test','UTF8')),'hex')), 'the address is on the do-not-contact list (hash)');
select t.ok((select status = 'cancelled' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab01'), 'the approved follow-up is cancelled');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='stop'), 'm-stop', 'interested', now(), '{}') = 'seen', 'the same message is counted once');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='stop'), 'm-later', 'wants_call', now(), '{}') = 'terminal', 'a later friendly message never reopens a stopped contact (the call)');
select t.ok((select status = 'not_interested' from career_outreach_threads where id = (select id from ids where k='stop')), 'a later friendly message never reopens a stopped contact');
select t.ok((select turns = 2 and next_step = 'Nothing more will be sent.' from career_outreach_threads where id = (select id from ids where k='stop'))
  and (select count(*) = 2 from career_outreach_turns where thread_id = (select id from ids where k='stop')), 'every turn is on the conversation; the state carries the next step');
-- Even an approved follow-up written after the stop is refused at the claim.
update career_outreach_actions set status = 'approved', approved_at = now(), approved_hash = hash where batch_id = '00000000-0000-4000-8000-00000000ab01';
select t.ok((select count(*) = 0 from career_outreach_action_claim('w1', 10, 10, now(), 60)), 'a follow-up to a stopped contact is not claimed');
select t.ok((select status = 'refused' and result = 'do_not_contact' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab01'),
  'a follow-up to a stopped contact is refused at the claim (do_not_contact), never sent');

-- 4. Follow-ups: only after the person's own interval; asked once when unset; never past a reply or before an OOO return.
select t.ok((select count(*) = 0 from career_outreach_followups_due('w1', 100, now(), 60)), 'no interval set: nothing is due (no Trainee default)');
select t.ok((select count(*) = 1 from career_outreach_followup_ask_due(100, now())), 'the person is asked once');
select t.ok((select count(*) = 0 from career_outreach_followup_ask_due(100, now())), 'and never asked twice');
update career_outreach_followup_prefs set steps = '{5,4}' where user_id = '00000000-0000-4000-8000-0000000c5a01';
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='ooo'), 'm-ooo', 'out_of_office', now(),
  jsonb_build_object('return_at', to_char(now() + interval '6 days', 'YYYY-MM-DD'))) = 'out_of_office', 'an out-of-office keeps the thread open');
select t.ok((select array_agg(id) = array[(select id from ids where k='quiet')] from career_outreach_followups_due('w1', 100, now(), 60)),
  'due: the quiet thread only (not the stopped one, not the one away, not the one sent 2 days ago)');
select t.ok((select count(*) = 0 from career_outreach_followups_due('w2', 100, now(), 60)), 'the quiet thread is leased to worker 1; worker 2 gets nothing');
select t.ok((select (select id from ids where k='ooo') = any(array_agg(id)) from career_outreach_followups_due('w2', 100, now() + interval '8 days', 60)),
  'after the return date (plus a day) the away thread is due too');
-- One follow-up open per thread at a time (the sequence is the person's, any length; each step goes once).
insert into career_outreach_actions(user_id,thread_id,kind,step,batch_id,n,payload,hash) values('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='quiet'),'followup',1,'00000000-0000-4000-8000-00000000ab02',1,'{"to":"quiet@example.test"}',repeat('b',64));
select t.must_fail($$insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash) values('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='quiet'),'followup',gen_random_uuid(),1,'{}',repeat('c',64))$$,
  'career_outreach_actions_one_followup', 'a second follow-up open on a thread at once is refused by the database');
-- Approval binds the exact hash; a stale hash approves nothing.
select t.ok(career_outreach_actions_approve('00000000-0000-4000-8000-0000000c5a01'::uuid,'00000000-0000-4000-8000-00000000ab02'::uuid,('[{"n":1,"hash":"' || repeat('f',64) || '"}]')::jsonb, now()) = '{}'::int[],
  'a yes on a payload that changed since it was shown approves nothing');
select t.ok(career_outreach_actions_approve('00000000-0000-4000-8000-0000000c5a01'::uuid,'00000000-0000-4000-8000-00000000ab02'::uuid,('[{"n":1,"hash":"' || repeat('b',64) || '"}]')::jsonb, now()) = '{1}'::int[],
  'the exact hash approves it');
-- A reply arrives after approval: the follow-up is cancelled, and even if it were still approved the claim refuses it.
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='quiet'), 'm-q1', 'interested', now(),
  '{"who":"contact","asks":["send your resume"],"conversation":{"open_asks":[{"text":"send your resume","at":"2026-10-27T00:00:00Z"}],"commitments":[],"next_step":"They asked for your resume."}}') = 'interested', 'an interested reply');
select t.ok((select status = 'cancelled' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab02'), 'a reply cancels the approved follow-up');
select t.ok((select followup_state = 'off' and jsonb_array_length(open_asks) = 1 and replied_at is not null from career_outreach_threads where id = (select id from ids where k='quiet')),
  'the thread: follow-up off, the open ask carried, replied');
update career_outreach_actions set status = 'approved', approved_hash = hash, approved_at = now() where batch_id = '00000000-0000-4000-8000-00000000ab02';
select t.ok((select count(*) = 0 from career_outreach_action_claim('w1', 10, 10, now(), 60)), 'nothing claimed');
select t.ok((select result = 'replied' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab02'),
  'the claim refuses a follow-up on a thread with a reply');

-- 5. A call: the scheduling reply, then the confirmed event, created once; an action whose lease expires is taken again.
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='call'), 'o-m1', 'wants_call', now(),
  '{"who":"contact","contact_tz":"Europe/London","their_times":["2026-11-03T15:00:00Z"]}') = 'wants_call', 'wants a call');
select t.ok((select count(*) = 1 from career_outreach_wanting_call(10)), 'it is on the scheduling list');
insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash,approved_at)
 values('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='call'),'schedule_reply','00000000-0000-4000-8000-00000000ab03',1,'{"to":"talk@example.test","slots":[{"start":"2026-11-03T15:00:00Z"}]}',repeat('d',64),'approved',repeat('d',64),now());
select t.ok((select count(*) = 0 from career_outreach_wanting_call(10)), 'with a scheduling reply waiting it is off the list');
select t.ok((select count(*) = 1 from career_outreach_action_claim('w1', 10, 10, now(), 60)), 'the approved scheduling reply is claimed');
select t.ok((select count(*) = 0 from career_outreach_action_claim('w2', 10, 10, now(), 60)), 'never by a second worker while leased');
-- The lease expires mid-hand-off: the next claim takes it again (the rail's key makes a second hand-off the same row).
select t.ok((select count(*) = 1 from career_outreach_action_claim('w2', 10, 10, now() + interval '5 minutes', 60)), 'the expired action is claimed again');
select t.ok((select status in ('approved', 'running') and result like 'lease expired%' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab03'), 'an action whose lease expired is taken again (the rail and the calendar make that idempotent)');
select t.ok(not career_outreach_action_finish((select id from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab03'), 'w1', 'done', 'x', null, 'sent'), 'the old lease holder cannot finish it afterwards');
-- Again, finished properly: the thread moves to call_proposed with the offered slots.
update career_outreach_actions set status = 'approved', result = null where batch_id = '00000000-0000-4000-8000-00000000ab03';
select t.ok(career_outreach_action_finish((select id from career_outreach_action_claim('w1', 10, 10, now(), 60) limit 1), 'w1', 'done', 'msg-1', null, 'sent'), 'finished by its lease holder');
select t.ok((select status = 'call_proposed' and jsonb_array_length(offered) = 1 from career_outreach_threads where id = (select id from ids where k='call')), 'sent: times offered');
insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash,approved_at) values
 ('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='call'),'calendar_event','00000000-0000-4000-8000-00000000ab04',1,'{"to":"talk@example.test","start":"2026-11-03T15:00:00Z","end":"2026-11-03T15:30:00Z"}',repeat('e',64),'shown',null,null),
 ('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='call'),'calendar_event','00000000-0000-4000-8000-00000000ab04',2,'{"to":"talk@example.test","start":"2026-11-03T15:00:00Z","end":"2026-11-03T15:30:00Z"}',repeat('e',64),'approved',repeat('e',64),now());
select t.ok((select count(*) = 1 and bool_and(n = 2) from career_outreach_action_claim('w1', 10, 10, now(), 60)), 'only the approved event is claimed; the one only shown is not');
-- An event lease that expires is taken again (the provider's id makes the retry idempotent).
select t.ok((select count(*) = 1 from career_outreach_action_claim('w2', 10, 10, now() + interval '5 minutes', 60)), 'an expired event lease is retried');
select t.ok(career_outreach_action_finish((select id from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab04' and n = 2), 'w2', 'done', 'ev-1', 'https://meet.example/abc', 'created', null), 'created: call scheduled with the event (the call)');
select t.ok((select status = 'call_scheduled' and event->>'ref' = 'ev-1' from career_outreach_threads where id = (select id from ids where k='call')), 'created: call scheduled with the event');
update career_outreach_actions set status = 'approved', approved_hash = hash, approved_at = now() where batch_id = '00000000-0000-4000-8000-00000000ab04' and n = 1;
select t.ok((select count(*) = 0 from career_outreach_action_claim('w1', 10, 10, now(), 60)), 'no second event claimed');
select t.ok((select result = 'already_created' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab04' and n = 1),
  'a second event for the same thread is refused at the claim');
select t.must_fail($$update career_outreach_actions set status = 'running' where batch_id = '00000000-0000-4000-8000-00000000ab04' and n = 1$$, 'career_outreach_actions_one_event', 'and by the database: one event per thread');
select t.must_fail($$insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash) values('00000000-0000-4000-8000-0000000c5a01',(select id from ids where k='call'),'schedule_reply',gen_random_uuid(),1,'{}',repeat('a',64),'approved',repeat('b',64))$$,
  'career_outreach_actions_approved_is_exact', 'an approval is always the exact payload''s hash');

-- 6. Fairness: one person with many approvals cannot starve another.
insert into ids select 'b1', career_outreach_thread_track('00000000-0000-4000-8000-0000000c5a02', null, 'gmail', 'gb-1', 'bperson@example.test', 'B', 'C', 'S', now() - interval '1 day');
insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash,approved_at)
 select '00000000-0000-4000-8000-0000000c5a01', (select id from ids where k='quiet'), 'schedule_reply', '00000000-0000-4000-8000-00000000ab05', g, '{}', repeat('a',64), 'approved', repeat('a',64), now() - interval '1 hour' from generate_series(1, 30) g;
update career_outreach_threads set status = 'wants_call' where id = (select id from ids where k='quiet');
insert into career_outreach_actions(user_id,thread_id,kind,step,batch_id,n,payload,hash,status,approved_hash,approved_at)
 values('00000000-0000-4000-8000-0000000c5a02', (select id from ids where k='b1'), 'followup', 1, '00000000-0000-4000-8000-00000000ab06', 1, '{}', repeat('a',64), 'approved', repeat('a',64), now());
select t.ok((select count(*) filter (where user_id = '00000000-0000-4000-8000-0000000c5a02') = 1 and count(*) filter (where user_id = '00000000-0000-4000-8000-0000000c5a01') = 2
  from career_outreach_action_claim('w9', 3, 2, now(), 60)), 'per person per call: 2 of A''s 30, and B''s one in the same call (B approved last)');
-- B's sequence (3 then 4 days): step 1 sent moves the thread on; step 1 can never go twice; step 2 is due 4 days after it.
insert into career_outreach_followup_prefs(user_id, steps) values ('00000000-0000-4000-8000-0000000c5a02', '{3,4}');
select t.ok(career_outreach_action_finish((select id from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab06'), 'w9', 'done', 'm', null, 'sent'), 'B''s first follow-up sent');
select t.ok((select followups_sent = 1 and followup_state = 'none' and last_touch_at is not null from career_outreach_threads where id = (select id from ids where k='b1')), 'one of two sent; the next may be drafted');
select t.must_fail($$insert into career_outreach_actions(user_id,thread_id,kind,step,batch_id,n,payload,hash,status,approved_hash) values('00000000-0000-4000-8000-0000000c5a02',(select id from ids where k='b1'),'followup',1,gen_random_uuid(),1,'{}',repeat('a',64),'done',repeat('a',64))$$,
  'career_outreach_actions_followup_step', 'step 1 of a sequence can never be sent twice');
select t.ok((select count(*) = 0 from career_outreach_followups_due('w8', 100, now() + interval '3 days', 60) where user_id = '00000000-0000-4000-8000-0000000c5a02'), 'step 2 waits its 4 days after step 1');
select t.ok((select count(*) = 1 from career_outreach_followups_due('w8', 100, now() + interval '5 days', 60) where user_id = '00000000-0000-4000-8000-0000000c5a02'), 'then it is due');
-- A stop recorded elsewhere (WO-033's rail, or another person's thread): the address alone refuses the claim.
insert into career_outreach_dnc(user_id, email_hash, reason) values ('00000000-0000-4000-8000-0000000c5a01', encode(sha256(convert_to('bperson@example.test','UTF8')),'hex'), 'recipient asked to stop');
insert into career_outreach_actions(user_id,thread_id,kind,batch_id,n,payload,hash,status,approved_hash,approved_at)
 values('00000000-0000-4000-8000-0000000c5a02', (select id from ids where k='b1'), 'schedule_reply', '00000000-0000-4000-8000-00000000ab07', 1, '{}', repeat('a',64), 'approved', repeat('a',64), now());
update career_outreach_threads set status = 'wants_call' where id = (select id from ids where k='b1');
select t.ok((select count(*) = 0 from career_outreach_action_claim('w9', 100, 5, now(), 60) where user_id = '00000000-0000-4000-8000-0000000c5a02'), 'nothing of B''s claimed');
select t.ok((select status = 'refused' and result = 'do_not_contact' from career_outreach_actions where batch_id = '00000000-0000-4000-8000-00000000ab07'),
  'an address on anyone''s do-not-contact list is refused at the claim, whatever the thread says');

-- 7. Permissions: only the service claims, approves or applies; a person reads their own threads, turns and actions.
reset role;
select t.as_user('00000000-0000-4000-8000-0000000c5a02'); set role authenticated;
select t.ok((select count(*) = 1 from career_outreach_threads), 'a person reads only their own threads');
select t.ok((select count(*) = 0 from career_outreach_turns), 'and only their own conversation turns');
select t.must_fail($$select career_outreach_action_claim('x', 1, 1, now(), 60)$$, 'permission denied', 'a person cannot claim');
select t.must_fail($$select career_outreach_actions_approve('00000000-0000-4000-8000-0000000c5a02', gen_random_uuid(), '[]', now())$$, 'permission denied', 'a person cannot approve by calling the database');
select t.must_fail($$update career_outreach_actions set status = 'approved'$$, 'permission denied', 'a person cannot write an approval');
select t.must_fail($$select * from career_outreach_sync$$, 'permission denied', 'the cursors are the service''s');
reset role; set role anon;
select t.must_fail($$select * from career_outreach_threads$$, 'permission denied', 'anon reads nothing');
reset role;

-- 8. Erase: the new tables are the erase's (prefix career_), the do-not-contact list is kept.
select t.ok(array['public.career_outreach_threads','public.career_outreach_turns','public.career_outreach_actions','public.career_outreach_sync','public.career_outreach_followup_prefs']::text[] <@ career_erase_tables(),
  'threads, turns, actions, cursors and the follow-up setting are erased with the person');
select career_erase_person('00000000-0000-4000-8000-0000000c5a01');
select t.ok((select count(*) = 0 from career_outreach_threads where user_id = '00000000-0000-4000-8000-0000000c5a01') and (select count(*) = 0 from career_outreach_turns where user_id = '00000000-0000-4000-8000-0000000c5a01')
  and exists (select 1 from career_outreach_dnc where email_hash = encode(sha256(convert_to('stop.me@example.test','UTF8')),'hex')), 'after an erase nothing of the outreach is left, and the stop still holds');
rollback;
