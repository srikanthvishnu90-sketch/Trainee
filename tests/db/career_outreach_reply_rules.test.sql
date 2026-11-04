-- REPLY SCENARIOS (20261029100000_career_outreach_reply_rules.sql): what the replies lane does on the sending rail when it
-- reads an answer. An opt-out or a bounce cancels every email still queued to the address, anyone's; an out-of-office with
-- a return date delays a queued follow-up past it (and nothing else); a follow-up the rail cancelled before it went is
-- not counted as sent. State is asserted on the rows.
\set ON_ERROR_STOP on
begin;
-- The return date is a UTC calendar day (to_char on now() below, date_trunc in the assertion): pin the session zone so the
-- test is the same at any hour of the day and on any server zone (it failed after 19:00 America/Chicago, when the UTC day has moved on).
set local time zone 'UTC';
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000c7a01','rr-a@example.test'),('00000000-0000-4000-8000-0000000c7a02','rr-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000c7a01'),('00000000-0000-4000-8000-0000000c7a02');
set role service_role;
create temp table ids(k text primary key, id uuid);
grant all on ids to service_role;
-- One rail row: (key, user, address, follow_up_of key or null, state).
create function pg_temp.q(k text, u uuid, addr text, fu text, st text, at timestamptz default now()) returns void language sql as $$
  with x as (insert into public.career_send_queue(user_id, kind, source_id, approval_hash, idem_key, recipient_email, subject, body, follow_up_of, state, gmail_id, gmail_thread, sent_at, next_at)
    values (u, case when fu is null then 'outreach' else 'general' end, gen_random_uuid(), repeat('b', 64), 'rr:' || k, addr, 'Hello', 'Hi there', (select id from ids where ids.k = fu), st,
      case when st = 'sent' then 'g-' || k end, case when st = 'sent' then 't-' || k end, case when st = 'sent' then now() end, at) returning id)
  insert into ids select k, id from x
$$;
create function pg_temp.th(k text, addr text) returns void language sql as $$
  insert into ids select k, public.career_outreach_thread_track('00000000-0000-4000-8000-0000000c7a01', null, 'gmail', 'gt-' || k, addr, 'Contact', 'Acme', 'Hello', now() - interval '5 days')
$$;

-- 1. An opt-out read by the replies lane: every queued email to the address, anyone's, is cancelled at once.
select pg_temp.th('stop', 'stop@acme.example');
select pg_temp.q('stop-root', '00000000-0000-4000-8000-0000000c7a01', 'stop@acme.example', null, 'sent');
select pg_temp.q('stop-fu', '00000000-0000-4000-8000-0000000c7a01', 'stop@acme.example', 'stop-root', 'queued');
select pg_temp.q('stop-other', '00000000-0000-4000-8000-0000000c7a02', 'stop@acme.example', null, 'queued', now() + interval '30 days');
select pg_temp.q('stop-elsewhere', '00000000-0000-4000-8000-0000000c7a02', 'someone.else@acme.example', null, 'queued');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'stop'), 'm-stop', 'not_interested', now(), '{"who":"contact"}') = 'not_interested', 'an opt-out (the call)');
select t.ok((select bool_and(state = 'cancelled' and result = 'opted_out') from career_send_queue where id in (select id from ids where k in ('stop-fu', 'stop-other'))), 'every queued email to the address is cancelled, the other person''s too');
select t.ok((select state = 'sent' from career_send_queue where id = (select id from ids where k = 'stop-root')), 'what was already sent stays sent');
select t.ok((select state = 'queued' from career_send_queue where id = (select id from ids where k = 'stop-elsewhere')), 'an email to another address is untouched');

-- 2. A bounce read by the replies lane: the same, as bad_address, and the address is bad forever.
select pg_temp.th('gone', 'gone@acme.example');
select pg_temp.q('gone-other', '00000000-0000-4000-8000-0000000c7a02', 'gone@acme.example', null, 'queued', now() + interval '30 days');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'gone'), 'm-gone', 'bounce', now(), '{}') = 'bounced', 'a bounce (the call)');
select t.ok((select state = 'cancelled' and result = 'bad_address' from career_send_queue where id = (select id from ids where k = 'gone-other')), 'another person''s queued email to a bounced address is cancelled');
select t.ok(exists (select 1 from career_send_bad_addresses where email_hash = career_send_email_hash('gone@acme.example')), 'the address is bad forever');

-- 3. An out-of-office with a return date: this person's queued follow-up to the address waits past it; nothing else moves.
select pg_temp.th('away', 'away@acme.example');
select pg_temp.q('away-root', '00000000-0000-4000-8000-0000000c7a01', 'away@acme.example', null, 'sent');
select pg_temp.q('away-fu', '00000000-0000-4000-8000-0000000c7a01', 'away@acme.example', 'away-root', 'queued');
select pg_temp.q('away-other', '00000000-0000-4000-8000-0000000c7a02', 'away@acme.example', null, 'queued');
create temp table was as select id, next_at from career_send_queue where id in (select id from ids where k in ('away-fu', 'away-other'));
grant all on was to service_role;
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'away'), 'm-away', 'out_of_office', now(),
  jsonb_build_object('return_at', to_char(now() + interval '10 days', 'YYYY-MM-DD') || 'T00:00:00.000Z')) = 'out_of_office', 'an auto-reply with a return date (the call)');
select t.ok((select state = 'queued' and next_at >= date_trunc('day', now() + interval '10 days') + interval '1 day' from career_send_queue where id = (select id from ids where k = 'away-fu')),
  'the queued follow-up still waits to go, after the return date');
select t.ok((select q.next_at = w.next_at and q.state = 'queued' from career_send_queue q join was w using (id) where q.id = (select id from ids where k = 'away-other')), 'another person''s email is not moved');
select t.ok(not exists (select 1 from career_outreach_dnc where email_hash = career_send_email_hash('away@acme.example')), 'an auto-reply opts nobody out');

-- 4. An out-of-office without a return date: nothing moves.
select pg_temp.th('away2', 'away2@acme.example');
select pg_temp.q('away2-root', '00000000-0000-4000-8000-0000000c7a01', 'away2@acme.example', null, 'sent');
select pg_temp.q('away2-fu', '00000000-0000-4000-8000-0000000c7a01', 'away2@acme.example', 'away2-root', 'queued');
insert into was select id, next_at from career_send_queue where id = (select id from ids where k = 'away2-fu');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'away2'), 'm-away2', 'out_of_office', now(), '{}') = 'out_of_office', 'an auto-reply without a date (the call)');
select t.ok((select q.next_at = w.next_at and q.state = 'queued' from career_send_queue q join was w using (id) where q.id = (select id from ids where k = 'away2-fu')), 'no date: the follow-up keeps its time');

-- 5. The rail read the reply first and cancelled the follow-up before it went: the lane's turn marks its action not sent
--    and takes it off the count.
select pg_temp.th('rep', 'rep@acme.example');
select pg_temp.q('rep-fu', '00000000-0000-4000-8000-0000000c7a01', 'rep@acme.example', null, 'queued');
update career_send_queue set kind = 'general', state = 'cancelled', result = 'they replied' where id = (select id from ids where k = 'rep-fu');
insert into career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at, provider_ref)
 values('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'rep'), 'followup', 1, gen_random_uuid(), 1, '{"to":"rep@acme.example"}', repeat('c', 64), 'done', repeat('c', 64), now(),
   (select id from ids where k = 'rep-fu')::text);
update career_outreach_threads set followups_sent = 1 where id = (select id from ids where k = 'rep');
select t.ok(career_outreach_reply_apply('00000000-0000-4000-8000-0000000c7a01', (select id from ids where k = 'rep'), 'm-rep', 'interested', now(), '{}') = 'interested', 'a real reply (the call)');
select t.ok((select status = 'cancelled' and result = 'not sent: they replied' from career_outreach_actions where thread_id = (select id from ids where k = 'rep')), 'the follow-up the rail cancelled is not sent');
select t.ok((select followups_sent = 0 and followup_state = 'off' from career_outreach_threads where id = (select id from ids where k = 'rep')), 'and is not counted as sent; the sequence is off');
rollback;
