-- Mass networking, lane M1 (20261027200000_career_send_queue.sql): the sending rail's queue in the database alone.
-- Exactly once per approval (idempotency key), the outreach approval re-checked at the door and at the claim, one plain
-- recipient and a one-line subject, opt-out and bad addresses refused, never the same person twice for outreach except
-- one follow-up, the claim's round robin and skip-locked leases (a second session gets other accounts, never the same
-- rows), the fenced completion, Gmail's backoff per account, disconnect cancels, reconnect resumes, the person's view,
-- service-only access, and no volume number anywhere.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000052a1','send-a@example.test'),('00000000-0000-4000-8000-0000000052a2','send-b@example.test'),('00000000-0000-4000-8000-0000000052a3','send-c@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-0000000052a1'),('00000000-0000-4000-8000-0000000052a2'),('00000000-0000-4000-8000-0000000052a3');
insert into user_oauth_connections(user_id,provider,vault_name,scopes) values
 ('00000000-0000-4000-8000-0000000052a1','google_career','oauth_google_career_00000000-0000-4000-8000-0000000052a1','openid email'),
 ('00000000-0000-4000-8000-0000000052a2','google_career','oauth_google_career_00000000-0000-4000-8000-0000000052a2','openid email');
-- A's approved outreach drafts (hash = approval), one shown and not approved.
insert into career_outreach_drafts(id,user_id,batch_id,n,recipient,recipient_email,subject,body,footer,hash,status,approved_hash,approved_at) values
 ('00000000-0000-4000-8000-00000000d001','00000000-0000-4000-8000-0000000052a1','00000000-0000-4000-8000-00000000b001',1,'{}','one@example.test','S1','B1','F',repeat('1',64),'approved',repeat('1',64),now()),
 ('00000000-0000-4000-8000-00000000d002','00000000-0000-4000-8000-0000000052a1','00000000-0000-4000-8000-00000000b001',2,'{}','two@example.test','S2','B2','F',repeat('2',64),'approved',repeat('2',64),now()),
 ('00000000-0000-4000-8000-00000000d003','00000000-0000-4000-8000-0000000052a1','00000000-0000-4000-8000-00000000b001',3,'{}','three@example.test','S3','B3','F',repeat('3',64),'shown',null,null);
set role service_role;
create temp table r as select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','items',jsonb_build_array(
  jsonb_build_object('kind','outreach','source_id','00000000-0000-4000-8000-00000000d001','approval_hash',repeat('1',64),'to','one@example.test','subject','S1','body','B1'),
  jsonb_build_object('kind','outreach','source_id','00000000-0000-4000-8000-00000000d001','approval_hash',repeat('1',64),'to','one@example.test','subject','S1','body','B1'),
  jsonb_build_object('kind','outreach','source_id','00000000-0000-4000-8000-00000000d002','approval_hash',repeat('9',64),'to','two@example.test','subject','S2','body','B2'),
  jsonb_build_object('kind','outreach','source_id','00000000-0000-4000-8000-00000000d003','approval_hash',repeat('3',64),'to','three@example.test','subject','S3','body','B3'),
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','x@example.test','subject','Hi'||chr(13)||chr(10)||'Bcc: spy@example.test','body','B'),
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','x@example.test, y@example.test','subject','Hi','body','B'),
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','x@example.test','subject','Hi','body','B','bcc','spy@example.test'),
  jsonb_build_object('kind','application','source_id','00000000-0000-4000-8000-00000000a001','approval_hash',repeat('b',64),'to','jobs@example.test','subject','Application','body','Attached.'),
  jsonb_build_object('kind','blast','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','x@example.test','subject','Hi','body','B')
))) j;
select t.ok((select jsonb_agg(e->>'status') from r, jsonb_array_elements(r.j) e) = '["queued","already_queued","refused","refused","refused","refused","refused","queued","refused"]'::jsonb,
  'queued once; the same approval again is the same row; a hash that is not the approval, an unapproved draft, a header break, two recipients, a Bcc, an unknown kind refused');
select t.ok((select jsonb_agg(e->>'reason') filter (where e->>'status' = 'refused') from r, jsonb_array_elements(r.j) e) = '["changed","not_approved","invalid","invalid","cc_bcc_not_approved","invalid"]'::jsonb, 'each refusal names its reason');
select t.ok((select count(*) = 2 from career_send_queue where user_id = '00000000-0000-4000-8000-0000000052a1'), 'two rows: one outreach, one application (APL-12 uses the same rail)');
select t.must_fail($$insert into career_send_queue(user_id,kind,source_id,approval_hash,idem_key,recipient_email,subject,body) values('00000000-0000-4000-8000-0000000052a1','general',gen_random_uuid(),repeat('a',64),'k1','a@example.test','x'||chr(10)||'Bcc: b@example.test','b')$$,'career_send_queue_subject_check','a subject with a line break is refused by the table itself');
select t.must_fail($$insert into career_send_queue(user_id,kind,source_id,approval_hash,idem_key,recipient_email,subject,body) values('00000000-0000-4000-8000-0000000052a1','general',gen_random_uuid(),repeat('a',64),'k2','Jane <a@example.test>','x','b')$$,'career_send_queue_recipient_email_check','one plain address, never a display name or a list');
select t.must_fail($$update career_send_queue set state = 'sent' where user_id = '00000000-0000-4000-8000-0000000052a1'$$,'career_send_sent_has_id','sent only with Gmail''s message id');
-- Where the address came from rides with the email (the card shows it): published, known or inferred, nothing else.
select t.ok((select jsonb_agg(e->>'status') from jsonb_array_elements(public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','inferred@example.test','subject','Hi','body','B','address_type','inferred','address_format','first.last'),
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','guess@example.test','subject','Hi','body','B','address_type','guessed'))))) e) = '["queued","refused"]'::jsonb, 'an inferred address is queued with its label; an unknown label is refused');
select t.ok((select address_type = 'inferred' and address_format = 'first.last' from career_send_queue where recipient_email = 'inferred@example.test'), 'the label and the format are kept');
delete from career_send_queue where recipient_email = 'inferred@example.test';
-- Not connected: refused at the door.
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a3','items',jsonb_build_array(jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('a',64),'to','x@example.test','subject','Hi','body','B'))))->0->>'reason') = 'not_connected', 'no Gmail connected: nothing queued');

-- Fifty general emails for B: no number of Trainee's own refuses any of them.
select t.ok((select count(*) from jsonb_array_elements(public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',
  (select jsonb_agg(jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('c',64),'to','b'||g||'@example.test','subject','Hi '||g,'body','B')) from generate_series(1,50) g)))) e where e->>'status' = 'queued') = 50,
  '50 at once for one person: all queued (no daily or batch number)');

-- The claim: two sessions' worth (the same transaction stands in for "the first still holds its lease").
create temp table c1 as select public.career_send_claim('{"worker":"w1","accounts":1,"per_account":100,"lease_seconds":60}'::jsonb) j;
create temp table c2 as select public.career_send_claim('{"worker":"w2","accounts":5,"per_account":100,"lease_seconds":60}'::jsonb) j;
select t.ok(jsonb_array_length((select j from c1)->'accounts') = 1 and jsonb_array_length((select j from c2)->'accounts') = 1
  and ((select j from c1)->'accounts'->0->>'user_id') <> ((select j from c2)->'accounts'->0->>'user_id'), 'a leased account is never handed to a second worker; the second gets the other account');
select t.ok((select sum(jsonb_array_length(a->'items')) from (select jsonb_array_elements(j->'accounts') a from c1 union all select jsonb_array_elements(j->'accounts') a from c2) x) = 52, 'every due email claimed, once (2 for A, 50 for B: per_account sizes a claim, never a cap)');
select t.ok((select count(*) = 52 from career_send_queue where state = 'sending'), 'all leased');
select t.ok((select status from career_outreach_drafts where id = '00000000-0000-4000-8000-00000000d001') = 'sending', 'the outreach draft is held while it is sent');
select t.ok(jsonb_array_length(public.career_send_claim('{"worker":"w3","accounts":5,"per_account":100,"lease_seconds":60}'::jsonb)->'accounts') = 0, 'a third worker finds nothing to take');
-- New email for an account while a worker holds it: no other worker takes that account until the lease ends.
select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',jsonb_build_array(jsonb_build_object('kind','general','source_id','00000000-0000-4000-8000-00000000c0de','approval_hash',repeat('c',64),'to','late-b@example.test','subject','Hi','body','B'))));
select t.ok(jsonb_array_length(public.career_send_claim('{"worker":"w3","accounts":5,"per_account":100,"lease_seconds":60}'::jsonb)->'accounts') = 0, 'an account another worker holds is skipped, even with new email (one sender per account)');

-- Completion is fenced to the lease (one outcome returns its word as a JSON string).
reset role;
create function pg_temp.done(p jsonb) returns text language sql as $f$ select public.career_send_complete(p) #>> '{}' $f$;
set role service_role;
select t.ok(pg_temp.done(jsonb_build_object('worker','w2','id',(select id from career_send_queue where source_id = '00000000-0000-4000-8000-00000000d001'),'outcome','sent','gmail_id','g1','thread_id','t1')) =
  case when ((select j from c1)->'accounts'->0->>'user_id') = '00000000-0000-4000-8000-0000000052a1' then 'stale' else 'sent' end, 'only the lease holder completes');
select t.ok(pg_temp.done(jsonb_build_object('worker',(select case when (j->'accounts'->0->>'user_id') = '00000000-0000-4000-8000-0000000052a1' then 'w1' else 'w2' end from c1),'id',(select id from career_send_queue where source_id = '00000000-0000-4000-8000-00000000d001'),'outcome','sent','gmail_id','g1','thread_id','t1')) = 'sent', 'the holder records the send');
select t.ok((select status = 'sent' and gmail_id = 'g1' from career_outreach_drafts where id = '00000000-0000-4000-8000-00000000d001'), 'the draft is sent with its Gmail id');
select t.ok(pg_temp.done(jsonb_build_object('worker','w1','id',(select id from career_send_queue where source_id = '00000000-0000-4000-8000-00000000d001'),'outcome','sent','gmail_id','g2')) = 'stale', 'completing twice changes nothing');
select public.career_send_complete(jsonb_build_object('worker',lease_owner,'id',id,'outcome','sent','gmail_id','g-app')) from career_send_queue where kind = 'application';
select public.career_send_release(jsonb_build_object('worker',lease_owner,'user',user_id)) from career_send_accounts where user_id = '00000000-0000-4000-8000-0000000052a1';

-- Gmail's quota on B: B backs off until Gmail's time, is told once, and its emails wait.
create temp table b_ids as select id from career_send_queue where user_id = '00000000-0000-4000-8000-0000000052a2' order by created_at;
select public.career_send_complete(jsonb_build_object('worker',(select case when (j->'accounts'->0->>'user_id') = '00000000-0000-4000-8000-0000000052a2' then 'w1' else 'w2' end from c1),'id',id,'outcome','quota','untried',true,'detail','HTTP 429','resume_at',(now() + interval '1 hour')::text)) from b_ids;
select t.ok((select state = 'backoff' and resume_at > now() + interval '59 minutes' from career_send_accounts where user_id = '00000000-0000-4000-8000-0000000052a2'), 'the account waits for Gmail''s own time');
select t.ok((select count(*) = 1 from career_outbox where user_id = '00000000-0000-4000-8000-0000000052a2' and key like 'status:send-paused:%' and kind = 'status'), 'told once, however many emails the refusal touched');
select t.ok((select count(*) = 51 from career_send_queue where user_id = '00000000-0000-4000-8000-0000000052a2' and state = 'queued' and attempts = 0), 'all waiting, none counted as tried (Gmail refused them)');
select public.career_send_release('{"worker":"w1","user":"00000000-0000-4000-8000-0000000052a2"}'::jsonb), public.career_send_release('{"worker":"w2","user":"00000000-0000-4000-8000-0000000052a2"}'::jsonb);
select t.ok(jsonb_array_length(public.career_send_claim('{"worker":"w4","accounts":5,"per_account":100,"lease_seconds":60}'::jsonb)->'accounts') = 0, 'not before Gmail allows, not even the email approved during the pause');
select t.ok(jsonb_array_length(public.career_send_claim(jsonb_build_object('worker','w5','accounts',5,'per_account',100,'lease_seconds',60,'now',(now() + interval '61 minutes')::text))->'accounts'->0->'items') = 51, 'after Gmail''s time: all of them, at once');

-- A lease that lapsed (the worker died): reclaimed, with its attempt count, for a Sent check first.
select t.ok((select (j->'accounts'->0->'items'->0->>'attempts')::int = 2 from (select public.career_send_claim(jsonb_build_object('worker','w6','accounts',5,'per_account',100,'lease_seconds',60,'now',(now() + interval '3 hours')::text)) j) x), 'a lapsed lease comes back marked as tried once already');

-- Replies, stops and bounces.
update career_send_queue set state = 'sent', gmail_id = 'g' || id, gmail_thread = 't' || id, sent_at = now(), lease_owner = null where user_id = '00000000-0000-4000-8000-0000000052a2';
create temp table due as select public.career_send_replies_due('{"limit":1000}'::jsonb) j;
select t.ok((select jsonb_array_length(j) >= 50 from due), 'every sent email is due a look at its thread');
select t.ok(jsonb_array_length(public.career_send_replies_due('{"limit":1000}'::jsonb)) = 0, 'a concurrent reader does not take the same ones');
select t.ok(public.career_send_record(jsonb_build_object('id',(select id from career_send_queue where recipient_email = 'b1@example.test'),'kind','stop')) = 'stop', 'a stop is recorded');
select t.ok((select count(*) = 1 from career_outreach_dnc where email_hash = public.career_send_email_hash('b1@example.test')), 'on the opt-out list forever');
select t.ok(public.career_send_record(jsonb_build_object('id',(select id from career_send_queue where recipient_email = 'b2@example.test'),'kind','bounce')) = 'bounce', 'a bounce is recorded');
select t.ok((select count(*) = 1 from career_send_bad_addresses where email_hash = public.career_send_email_hash('b2@example.test')), 'the address is bad, for everyone');
select t.ok((select jsonb_agg(e->>'reason') from jsonb_array_elements(public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('d',64),'to','b1@example.test','subject','Hi','body','B'),
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('d',64),'to','B2@Example.test','subject','Hi','body','B'))))) e) = '["opted_out","bad_address"]'::jsonb,
  'another person''s email to an opted-out or bounced address is refused');
-- Follow-ups: a sequence the person approves, one email at a time, only to the same address, stopped by any answer.
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('e',64),'to','b3@example.test','subject','Following up','body','B','follow_up_of',(select id from career_send_queue where recipient_email = 'b3@example.test')))))->0->>'status') = 'queued', 'one follow-up is queued');
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('f',64),'to','b3@example.test','subject','Again','body','B','follow_up_of',(select id from career_send_queue where recipient_email = 'b3@example.test' and follow_up_of is null)))))->0->>'status') = 'queued', 'a second approved follow-up joins the sequence (any length the person approves)');
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('f',64),'to','someone-else@example.test','subject','Again','body','B','follow_up_of',(select id from career_send_queue where recipient_email = 'b3@example.test' and follow_up_of is null)))))->0->>'reason') = 'follow_up_refused', 'a follow-up only to the same address');
select public.career_send_record(jsonb_build_object('id',(select id from career_send_queue where recipient_email = 'b3@example.test' and follow_up_of is null),'kind','reply'));
select t.ok((select bool_and(state = 'cancelled') and count(*) = 2 from career_send_queue where recipient_email = 'b3@example.test' and follow_up_of is not null), 'a reply cancels the whole rest of the sequence');
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a2','items',jsonb_build_array(
  jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('1',64),'to','b3@example.test','subject','Once more','body','B','follow_up_of',(select id from career_send_queue where recipient_email = 'b3@example.test' and follow_up_of is null)))))->0->>'reason') = 'replied', 'nothing follows up an answered email');
-- Outreach: never the same person twice.
insert into career_outreach_drafts(id,user_id,batch_id,n,recipient,recipient_email,subject,body,footer,hash,status,approved_hash,approved_at) values
 ('00000000-0000-4000-8000-00000000d004','00000000-0000-4000-8000-0000000052a1','00000000-0000-4000-8000-00000000b002',1,'{}','one@example.test','Again','B','F',repeat('4',64),'approved',repeat('4',64),now());
select t.ok((select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','items',jsonb_build_array(
  jsonb_build_object('kind','outreach','source_id','00000000-0000-4000-8000-00000000d004','approval_hash',repeat('4',64),'to','one@example.test','subject','Again','body','B'))))->0->>'reason') = 'already_emailed', 'a second outreach to someone already emailed is refused');

-- Status, cancel, disconnect, reconnect.
select t.ok((select (public.career_send_status('{"user":"00000000-0000-4000-8000-0000000052a2"}'::jsonb)->'counts'->>'replied')::int = 2), 'the person''s view counts what came back');
select public.career_send_enqueue(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','items',(select jsonb_agg(jsonb_build_object('kind','general','source_id',gen_random_uuid(),'approval_hash',repeat('c',64),'to','late'||g||'@example.test','subject','Hi','body','B')) from generate_series(1,3) g)));
select t.ok(public.career_send_cancel(jsonb_build_object('user','00000000-0000-4000-8000-0000000052a1','source_ids',jsonb_build_array((select source_id from career_send_queue where recipient_email = 'late1@example.test')))) = 1, 'the person takes one back');
reset role;
update career_send_accounts set state = 'needs_reconnect' where user_id = '00000000-0000-4000-8000-0000000052a1';
update user_oauth_connections set scopes = 'openid email https://www.googleapis.com/auth/gmail.send' where user_id = '00000000-0000-4000-8000-0000000052a1';
select t.ok((select state = 'ok' from career_send_accounts where user_id = '00000000-0000-4000-8000-0000000052a1'), 'a reconnect lifts needs_reconnect');
delete from user_oauth_connections where user_id = '00000000-0000-4000-8000-0000000052a1' and provider = 'google_career';
select t.ok((select count(*) = 0 from career_send_queue where user_id = '00000000-0000-4000-8000-0000000052a1' and state = 'queued'), 'disconnecting Gmail cancels everything still queued');
select t.ok((select state = 'disconnected' and not has_work from career_send_accounts where user_id = '00000000-0000-4000-8000-0000000052a1'), 'and the account stops');

-- The person reads nothing directly; nobody but the service runs the rail.
select t.as_user('00000000-0000-4000-8000-0000000052a1'); set role authenticated;
select t.must_fail($$select * from career_send_queue$$,'permission denied','the queue is the service''s');
select t.must_fail($$select public.career_send_enqueue('{}'::jsonb)$$,'permission denied','a signed-in person cannot queue a send');
select t.must_fail($$select public.career_send_claim('{"worker":"x"}'::jsonb)$$,'permission denied','or claim one');
reset role; set role anon;
select t.must_fail($$select public.career_send_complete('{}'::jsonb)$$,'permission denied','anon runs nothing');
reset role;
-- No volume number in the rail's code.
select t.ok(not exists (select 1 from pg_proc where proname like 'career_send_%' and (prosrc ~* 'daily_cap|interval ''90 seconds''|recipient_cap|>= ?3 then')), 'no daily cap, spacing or per-recipient number in any send function');
-- NO LIMITS on the older one-at-a-time claim too: 40 approved drafts for one person, claimed in the same second, all go
-- (it held 10 a day in the first week, 20 by default, 90 seconds apart); a changed one and an opted-out one still do not.
insert into career_outreach_drafts(id,user_id,batch_id,n,recipient,recipient_email,subject,body,footer,hash,status,approved_hash,approved_at)
 select ('00000000-0000-4000-8000-0000000e' || lpad(g::text, 4, '0'))::uuid,'00000000-0000-4000-8000-0000000052a3',('00000000-0000-4000-8000-0000000f' || lpad(g::text, 4, '0'))::uuid,1,'{}','old'||g||'@example.test','S','B','F',repeat('e',64),'approved',repeat('e',64),now()
 from generate_series(1,42) g;
insert into career_outreach_dnc(user_id,email_hash,reason) values('00000000-0000-4000-8000-0000000052a3',public.career_send_email_hash('old42@example.test'),'recipient asked to stop');
select t.ok((select count(*) from generate_series(1,40) g where public.career_outreach_claim('00000000-0000-4000-8000-0000000052a3',('00000000-0000-4000-8000-0000000e' || lpad(g::text, 4, '0'))::uuid,repeat('e',64),now(),now() - interval '1 hour') = 'ok') = 40,
  'the older claim: 40 in one second for one new sender, all ok (no daily number, warm-up or spacing)');
select t.ok(public.career_outreach_claim('00000000-0000-4000-8000-0000000052a3','00000000-0000-4000-8000-0000000e0041',repeat('f',64),now(),now()) = 'changed', 'the older claim still binds the exact approval');
select t.ok(public.career_outreach_claim('00000000-0000-4000-8000-0000000052a3','00000000-0000-4000-8000-0000000e0042',repeat('e',64),now(),now()) = 'do_not_contact', 'and still honours an opt-out');
select t.ok(not exists (select 1 from pg_proc where proname = 'career_outreach_claim' and prosrc ~* 'daily_cap|90 seconds|least\(cap|>= 3'), 'no volume number left in career_outreach_claim');
-- Erase: the queue and the account go; the opt-out and the bad address stay.
select public.career_erase_person('00000000-0000-4000-8000-0000000052a2');
select t.ok((select count(*) = 0 from career_send_queue where user_id = '00000000-0000-4000-8000-0000000052a2') and (select count(*) = 0 from career_send_accounts where user_id = '00000000-0000-4000-8000-0000000052a2'), 'an erase deletes the queue and the account row');
select t.ok((select count(*) = 1 from career_send_bad_addresses where email_hash = public.career_send_email_hash('b2@example.test')) and (select count(*) >= 1 from career_outreach_dnc where email_hash = public.career_send_email_hash('b1@example.test')), 'the bounce and the opt-out survive it');
rollback;
