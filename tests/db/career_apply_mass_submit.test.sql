-- Mass submission (20261027140000_career_apply_mass_submit.sql, owner decisions D-MS-2 and D-MS-3, 2026-10-27): no
-- product volume cap and no company rule; only the exact same posting is refused; every approval, hash and resume check
-- stays. Every assertion reads rows (the queue, the card, the claim's result), not function text.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000f001','mass-a@example.test'),
 ('00000000-0000-4000-8000-00000000f002','mass-b@example.test'),
 ('00000000-0000-4000-8000-00000000f003','mass-c@example.test'),
 ('00000000-0000-4000-8000-00000000f004','mass-d@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-00000000f001'),('00000000-0000-4000-8000-00000000f002'),
 ('00000000-0000-4000-8000-00000000f003'),('00000000-0000-4000-8000-00000000f004');
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb from profiles
 where id::text like '00000000-0000-4000-8000-00000000f00%';
-- One approved application of one posting, as the queue takes it: its payload, its hash as the approval.
create function pg_temp.payload(u text, job text, company text, url text, extra jsonb default '{}') returns jsonb language sql as $$
 select jsonb_build_object('version',1,'user_id',u,'job_id',job,'company',company,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day','engine_approval',repeat('e',64),
  'resume_sha256',encode(sha256('TEST resume'::bytea),'hex'),'destination',url) || extra
$$;
create function pg_temp.enq_with(p jsonb, h text, a text, d int) returns text language plpgsql as $$
begin perform public.career_apply_enqueue(p,h,a,d); return 'queued'; exception when others then return sqlerrm; end $$;
create function pg_temp.enq(p jsonb) returns text language sql as $$
 select pg_temp.enq_with(p, public.career_apply_payload_hash(p), public.career_apply_payload_hash(p), 25) $$;

-- ------------------------------------------------------------------------------------------- D-MS-2: volume
-- 120 approved, distinct postings for one person in one day: every one is queued (was: 25 by default, 50 at most).
create temp table r120 as select g, pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f001','TEST-MS-'||g,'Mass Employer '||g,
 'https://jobs.lever.co/mass'||g||'/'||g)) as res from generate_series(1,120) g;
select t.ok((select count(*) from r120 where res='queued') = 120,
 'one person, one day, 120 approved distinct postings: all 120 queued (' || (select count(*) from r120 where res='queued') || ')');
select t.ok((select count(*) from career_apply_jobs where user_id='00000000-0000-4000-8000-00000000f001' and state='queued') = 120,
 'the queue holds 120 rows for them');
-- A caller's legacy p_daily (any value, even 1 or 500) is never a ceiling and never refused.
select t.ok(pg_temp.enq_with(p, public.career_apply_payload_hash(p), public.career_apply_payload_hash(p), 1) = 'queued'
 and pg_temp.enq_with(q, public.career_apply_payload_hash(q), public.career_apply_payload_hash(q), 500) = 'queued',
 'a caller passing p_daily = 1 or 500 neither caps nor is refused')
 from (select pg_temp.payload('00000000-0000-4000-8000-00000000f001','TEST-MS-121','Mass Employer 121','https://jobs.lever.co/mass121/121') p,
              pg_temp.payload('00000000-0000-4000-8000-00000000f001','TEST-MS-122','Mass Employer 122','https://jobs.lever.co/mass122/122') q) x;

-- The claim hands out what is asked for: 50 at once from the person's own computer (was: 6 at most per call).
select t.as_user('00000000-0000-4000-8000-00000000f001');
set role authenticated;
create temp table own50 as select * from career_apply_claim_own(50, 'own_computer');
reset role;
select t.ok((select count(*) from own50) = 50, 'their own computer claims 50 in one call (' || (select count(*) from own50) || ')');
select t.ok((select bool_and(state='driving' and attempts=1 and lease_token is not null and source='own_computer') and count(distinct lease_token) = 50 from own50),
 'each of the 50 under its own lease, once');
-- The pool claim (the cloud's queue door) is fair: one heavy person's 72 waiting never starve 30 people with one each.
insert into auth.users(id,email) select ('00000000-0000-4000-8000-0000000fa'||lpad(g::text,3,'0'))::uuid, 'light'||g||'@example.test' from generate_series(1,30) g;
insert into profiles(id) select ('00000000-0000-4000-8000-0000000fa'||lpad(g::text,3,'0'))::uuid from generate_series(1,30) g;
insert into career_watch_kv(user_id,key,value) select ('00000000-0000-4000-8000-0000000fa'||lpad(g::text,3,'0'))::uuid,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb
 from generate_series(1,30) g;
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-0000000fa'||lpad(g::text,3,'0'),'light:'||g,'Light Co '||g,'https://jobs.lever.co/light'||g||'/1'))
 from generate_series(1,30) g;
create temp table pool31 as select * from career_apply_claim(now(), 31);
select t.ok((select count(*) = 31 and count(distinct user_id) = 31 from pool31),
 'the pool claim, 31 asked with 31 people waiting: one each, the heavy person does not take them all (' || (select count(distinct user_id) from pool31) || ' people)');
create temp table pool_rest as select * from career_apply_claim(now(), 1000);
select t.ok((select count(*) = 71 and count(distinct user_id) = 1 from pool_rest),
 'the next round, only the heavy person left waiting: the rest of their 72 in one call, not one at a time (' || (select count(*) from pool_rest) || ')');

-- A card holds the whole shown batch, of any size (was: 8 at most), and one answer queues all of it, each by its own hash.
create temp table prep as select g, (public.career_apply_prepare_for('00000000-0000-4000-8000-00000000f004', 'lever:card:'||g,
 pg_temp.payload('00000000-0000-4000-8000-00000000f004','lever:card:'||g,'Card Co '||g,'https://jobs.lever.co/card'||g||'/'||g),
 array['Card Co '||g||': Analyst','Name: Test Person'])).id as id from generate_series(1,500) g;
-- One item changed after it was prepared (past every trigger): its hash no longer matches what the card shows.
create temp table card500 as select * from career_apply_card_open_for('00000000-0000-4000-8000-00000000f004', (select array_agg(id order by g) from prep), now());
select t.ok((select jsonb_array_length(items) = 500 from card500), 'one card shows all 500');
update career_apply_prepared set payload_hash = repeat('f',64) where id = (select id from prep where g = 250);
create temp table ans500 as select career_apply_card_answer_for('00000000-0000-4000-8000-00000000f004', (select id from card500),
 (select array_agg(g) from generate_series(1,500) g), now()) v;
select t.ok((select count(*) = 499 from ans500, jsonb_array_elements(v) e where e->>'result' = 'queued'), 'one yes, one call: 499 queued');
select t.ok((select e->>'result' = 'changed' from ans500, jsonb_array_elements(v) e where (e->>'n')::int = 250), 'the one that changed since it was shown: refused, not sent');
select t.ok((select count(*) = 499 from career_apply_jobs j join career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id
 where j.user_id = '00000000-0000-4000-8000-00000000f004' and j.state = 'queued' and j.approval_hash = p.payload_hash
  and p.payload_hash = career_apply_payload_hash(j.payload)), 'every one queued by the hash that was shown, hash-checked');
select t.ok(not exists (select from career_apply_jobs where user_id = '00000000-0000-4000-8000-00000000f004' and job_id = 'lever:card:250'), 'nothing queued for the changed one');
-- The chat's own doors (career_apply_card_open_as / _answer_as, as the service role) and the scheduled push, 500 each.
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000000f006','mass-push@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-00000000f006');
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-00000000f006','career:account','{"epoch":1,"version":1,"paused":false}');
create temp table prep6 as select g, (public.career_apply_prepare_for('00000000-0000-4000-8000-00000000f006', 'lever:push:'||g,
 pg_temp.payload('00000000-0000-4000-8000-00000000f006','lever:push:'||g,'Push Co '||g,'https://jobs.lever.co/push'||g||'/'||g),
 array['#'||g])).id as id from generate_series(1,1000) g;
grant select on prep6 to service_role;
set role service_role;
create temp table card_as as select * from career_apply_card_open_as('00000000-0000-4000-8000-00000000f006', (select array_agg(id order by g) from prep6 where g <= 500));
create temp table ans_as as select career_apply_card_answer_as('00000000-0000-4000-8000-00000000f006', (select id from card_as),
 (select array_agg(g) from generate_series(1,500) g)) v;
reset role;
select t.ok((select jsonb_array_length(items) = 500 from card_as), 'the chat opens one 500-item card through career_apply_card_open_as');
select t.ok((select count(*) = 500 from ans_as, jsonb_array_elements(v) e where e->>'result' = 'queued')
 and (select count(*) = 500 from career_apply_jobs j join career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id
  where j.user_id = '00000000-0000-4000-8000-00000000f006' and j.approval_hash = p.payload_hash and p.payload_hash = career_apply_payload_hash(j.payload)),
 'one career_apply_card_answer_as call queues all 500, each by its shown hash');
-- The scheduled push shows the next 500 on one card, every line in its text.
insert into agent_threads(id,user_id,title) values ('00000000-0000-4000-8000-00000000f6aa','00000000-0000-4000-8000-00000000f006','Push');
insert into channel_contacts (contact, user_id, thread_id, last_inbound_at, created_at)
 values ('+15550006006', '00000000-0000-4000-8000-00000000f006', '00000000-0000-4000-8000-00000000f6aa', now() - interval '2 hours', now());
create temp table pushed500 as select career_apply_card_push_for('00000000-0000-4000-8000-00000000f006', (select array_agg(id order by g) from prep6 where g > 500),
 (select string_agg('#'||g, ' ' order by g) from generate_series(501,1000) g), now()) card;
select t.ok((select c.items is not null and jsonb_array_length(c.items) = 500 from career_apply_cards c where c.id = (select card from pushed500)),
 'the scheduled push opens one card with all 500');
select t.ok((select count(*) = 1 from career_outbox where user_id = '00000000-0000-4000-8000-00000000f006' and kind = 'card' and card_id = (select card from pushed500)),
 'and its one outbox row carries the card');

-- ------------------------------------------------------------------------------------------- D-MS-3: duplicates
-- Two roles at one company, same day: both queued (was: the second refused 'company_cooldown').
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:acme:analyst','Acme','https://jobs.lever.co/acme/analyst-1')) = 'queued'
 and pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:acme:engineer','Acme, Inc.','https://jobs.lever.co/acme/engineer-2')) = 'queued',
 'two roles at one company: both queued');
select t.ok((select count(*) from career_apply_jobs where user_id='00000000-0000-4000-8000-00000000f002' and state='queued') = 2, 'both rows in the queue');
-- The same posting twice: refused as a duplicate, by its job id, and by its canonical link under another id.
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:acme:analyst','Acme','https://jobs.lever.co/acme/analyst-1')) ~ 'duplicate_job',
 'the same posting again (same job id): refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:acme:analyst-copy','Acme','https://www.jobs.lever.co/acme/analyst-1/apply/')) ~ 'duplicate_job',
 'the same posting under another id (same canonical link: www, /apply, trailing slash): refused as a duplicate');
select t.ok(career_apply_posting_key('https://boards.greenhouse.io/acme/jobs/4012') = career_apply_posting_key('https://job-boards.greenhouse.io/embed/job_app?for=acme&gh_jid=4012')
 and career_apply_posting_key('https://jobs.lever.co/acme/analyst-1') <> career_apply_posting_key('https://jobs.lever.co/acme/engineer-2'),
 'a Greenhouse posting is its job number whichever Greenhouse link carries it; two Lever roles are two postings');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','greenhouse:acme:4012','Acme','https://boards.greenhouse.io/acme/jobs/4012')) = 'queued'
 and pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','gh-embed-4012','Acme','https://job-boards.greenhouse.io/embed/job_app?for=acme&gh_jid=4012')) ~ 'duplicate_job',
 'the same Greenhouse job by its embed link: refused as a duplicate');
-- An extension report of that exact posting (sent by hand) refuses it; another role at the employer does not.
insert into extension_submission_reports (user_id, employer, role, posting_url, posting_key, confirmation_text, tracker_record, observed_at) values
 ('00000000-0000-4000-8000-00000000f003','Globex','Analyst','https://jobs.ashbyhq.com/globex/role-a','ashby:globex:role-a','Thanks for applying','{}',now()-interval '1 hour');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f003','ashby:globex:role-a','Globex','https://jobs.ashbyhq.com/globex/role-a')) ~ 'duplicate_job',
 'a posting the extension already reported sent: refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f003','ashby:globex:role-b','Globex','https://jobs.ashbyhq.com/globex/role-b')) = 'queued',
 'another role at the employer the extension reported: queued');
-- Another person's application of the same posting is theirs: this person may apply.
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f003','lever:acme:analyst','Acme','https://jobs.lever.co/acme/analyst-1')) = 'queued',
 'the same posting for a different person: queued');
-- A posting tried and not sent is not a duplicate: it may be approved again (here under another id, the same link).
update career_apply_jobs set state='not_submitted' where user_id='00000000-0000-4000-8000-00000000f002' and job_id='lever:acme:engineer';
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:acme:engineer-retry','Acme','https://jobs.lever.co/acme/engineer-2')) = 'queued',
 'a posting that was not sent may be approved again');
-- The chat's apply queue: an exact posting already sent is refused 'duplicate_job'; a second role at the employer is added.
create temp table w as select career_apply_want_put_for('00000000-0000-4000-8000-00000000f003', jsonb_build_array(
 jsonb_build_object('posting_key','ashby:globex:role-a','url','https://jobs.ashbyhq.com/globex/role-a','company','Globex','title','Analyst'),
 jsonb_build_object('posting_key','ashby:globex:role-c','url','https://jobs.ashbyhq.com/globex/role-c','company','Globex','title','Engineer'))) v;
select t.ok((select v->'added' = '["ashby:globex:role-c"]'::jsonb and v->'refused'->0->>'reason' = 'duplicate_job' from w),
 'the apply queue: the sent posting refused as a duplicate, another role at the employer added');

-- ------------------------------------------------------------------------------------------- kept: approval and hash
select t.ok(pg_temp.enq(jsonb_set(pg_temp.payload('00000000-0000-4000-8000-00000000f003','lever:x:1','X','https://jobs.lever.co/x/1'),'{version}','2')) ~ 'invalid or stale',
 'a malformed payload is still refused');
select t.ok(pg_temp.enq_with(pg_temp.payload('00000000-0000-4000-8000-00000000f003','lever:x:2','X','https://jobs.lever.co/x/2'), repeat('0',64), repeat('0',64), null) ~ 'invalid or stale',
 'an approval of another payload (a hash that is not this payload''s) is still refused');
-- A payload changed after approval (past every trigger) is closed as not sent at the next claim, never handed out.
set session_replication_role = replica;
update career_apply_jobs set payload = jsonb_set(payload,'{fields}','[{"name":"first_name","value":"Someone Else"}]')
 where user_id='00000000-0000-4000-8000-00000000f003' and job_id='ashby:globex:role-b';
set session_replication_role = origin;
select t.as_user('00000000-0000-4000-8000-00000000f003');
set role authenticated;
create temp table own_c as select * from career_apply_claim_own(100, 'own_computer');
reset role;
select t.ok(not exists (select from own_c where job_id='ashby:globex:role-b'), 'the changed application is not handed out');
select t.ok((select state='not_submitted' and evidence->>'closed'='approval_changed' from career_apply_jobs
 where user_id='00000000-0000-4000-8000-00000000f003' and job_id='ashby:globex:role-b'), 'a changed payload is still voided at the claim');
select t.ok((select count(*) from own_c) = 1 and exists (select from own_c where job_id='lever:acme:analyst'), 'the unchanged one is handed out');
-- Approved, then the same posting reported sent by the extension before the claim: closed as not sent (D-MS-3 at the claim).
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f003','lever:late:1','Late Co','https://jobs.lever.co/late/1'));
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f003','lever:late:2','Late Co','https://jobs.lever.co/late/2'));
insert into extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at) values
 ('00000000-0000-4000-8000-00000000f003','Late Co','Analyst','https://jobs.lever.co/late/1','Thanks for applying','{}',now());
select t.as_user('00000000-0000-4000-8000-00000000f003');
set role authenticated;
create temp table own_late as select * from career_apply_claim_own(100, 'own_computer');
reset role;
select t.ok((select state='not_submitted' and evidence->>'closed'='duplicate_posting' from career_apply_jobs where job_id='lever:late:1'
  and user_id='00000000-0000-4000-8000-00000000f003')
 and exists (select from own_late where job_id='lever:late:2') and not exists (select from own_late where job_id='lever:late:1'),
 'a posting sent by another path after approval is closed at the claim; another role at that employer still goes');
-- A confirmation id is still never shared by two employers.
update career_apply_jobs set state='submitted_unconfirmed', confirmation_id='REF-77001' where job_id='lever:late:2' and user_id='00000000-0000-4000-8000-00000000f003';
update career_apply_jobs set state='submitted_unconfirmed', confirmation_id='ref 77001' where job_id='lever:acme:analyst' and user_id='00000000-0000-4000-8000-00000000f003';
select t.ok((select confirmation_id is null and evidence->>'confirmation_id_conflict' = 'ref 77001' from career_apply_jobs
 where job_id='lever:acme:analyst' and user_id='00000000-0000-4000-8000-00000000f003'), 'unique confirmation ids: another employer''s id is not kept as proof');

-- ------------------------------------------------------------------------------------------- kept: the resume
-- A batch card item without the prepared, confirmed resume is still refused before anything is shown or approved.
insert into agent_threads(id,user_id,title) values ('00000000-0000-4000-8000-00000000f0aa','00000000-0000-4000-8000-00000000f004','Mass card');
insert into career_message_approval_private.test_users(user_id) values ('00000000-0000-4000-8000-00000000f004');
create function pg_temp.entry(job text, resume boolean) returns jsonb language sql as $$
 select jsonb_build_object('version',1,'kind','agent-batch','jobId',job,'company','Resume Co','url','https://jobs.lever.co/resume/'||job||'/apply',
  'answers',jsonb_build_array(jsonb_build_object('name','name','label','Full name','value','TEST Person','shown','TEST Person','kind','text','factId','TEST-NAME','file',null))
   || case when resume then jsonb_build_array(jsonb_build_object('name','resume','label','Resume/CV','value','r.pdf','shown','r.pdf','kind','file',
        'factId','approved-local-resume:'||repeat('a',64),'file',repeat('a',64))) else '[]'::jsonb end,
  'blank','[]'::jsonb,'ledger','[]'::jsonb,'question_set_hash',repeat('5',64),'manifest_hash',repeat('6',64),'quarantine_version','d007-v1')
$$;
create function pg_temp.items(e jsonb) returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('entry',e,'hash',encode(sha256(convert_to(public.career_apply_canonical(e),'UTF8')),'hex'))) $$;
select t.must_fail($$select career_apply_message_card_show_as('00000000-0000-4000-8000-00000000f004','00000000-0000-4000-8000-00000000f0aa',
 pg_temp.items(pg_temp.entry('no-resume',false)))$$, 'requires a prepared resume', 'a job without the confirmed resume is still refused');
select t.ok((career_apply_message_card_show_as('00000000-0000-4000-8000-00000000f004','00000000-0000-4000-8000-00000000f0aa',
 pg_temp.items(pg_temp.entry('with-resume',true)))->>'state') = 'open', 'with it, the card is shown');

-- ------------------------------------------------------------------------------------------- D-MS-3 after an erase
-- A person who erased their record (career_erase_person, 20261026230100) keeps only the exact-posting rule: two other
-- roles at the employer they had applied to both queue the same day; the posting itself stays refused.
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000000f005','mass-erase@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-00000000f005');
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-00000000f005','career:account','{"epoch":1,"version":1,"paused":false}');
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f005','lever:erasco:1','Erase Co, Inc.','https://jobs.lever.co/erasco/1'));
update career_apply_jobs set state='submitted_unconfirmed', attempts=1, claimed_at=now(), source='own_computer', lease_token=gen_random_uuid()
 where user_id='00000000-0000-4000-8000-00000000f005';
select career_erase_person('00000000-0000-4000-8000-00000000f005');
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-00000000f005','career:account','{"epoch":1,"version":1,"paused":false}')
 on conflict (user_id,key) do update set value = excluded.value;
select t.ok(not exists (select from career_apply_jobs where user_id='00000000-0000-4000-8000-00000000f005'), 'the erase removed their applications');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f005','lever:erasco:2','Erase Co','https://jobs.lever.co/erasco/2')) = 'queued'
 and pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f005','lever:erasco:3','Erase Co','https://jobs.lever.co/erasco/3')) = 'queued',
 'after the erase: two other roles at the same employer, same day, both queued (no 30-day employer block)');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f005','lever:erasco:2','Erase Co','https://jobs.lever.co/erasco/2')) ~ 'duplicate_job',
 'the same posting twice: refused as a duplicate');
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f005','lever:erasco:1','Erase Co','https://jobs.lever.co/erasco/1')) ~ 'duplicate_job',
 'the posting they had applied to before the erase: still refused as a duplicate');
select t.ok(not exists (select from career_apply_erased where company_hash is not null), 'no employer hash is kept after an erase');

-- ------------------------------------------------------------------------------------------- kept: the person's own pace
update career_watch_kv set value = value || '{"daily_limit":"3"}' where user_id='00000000-0000-4000-8000-00000000f002';
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:pace:1','Pace Co','https://jobs.lever.co/pace/1')) ~ 'daily_cap',
 'a pace the person set themselves (3, with 3 today) still holds');
update career_watch_kv set value = value || '{"daily_limit":"lots"}' where user_id='00000000-0000-4000-8000-00000000f002';
select t.ok(pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f002','lever:pace:2','Pace Co','https://jobs.lever.co/pace/2')) ~ 'pace_unreadable',
 'an unreadable saved pace still refuses by name');
update career_watch_kv set value = value - 'daily_limit' where user_id='00000000-0000-4000-8000-00000000f002';

-- ------------------------------------------------------------------------------------------- the cloud
-- The cloud check: no product number and no company rule; the same posting sent by another path is refused.
delete from career_cloud_settings where key in ('CAREER_CLOUD_APPLY','gate_user_ids','owner_user_id');
delete from career_apply_cloud_pauses;
insert into career_cloud_settings(key,value) values('CAREER_CLOUD_APPLY','on');
select career_apply_cloud_optin_as('00000000-0000-4000-8000-00000000f004',true,'TEST terms');
select t.ok((career_apply_cloud_optin_get('00000000-0000-4000-8000-00000000f004')->>'daily') is null, 'the cloud opt-in carries no product number');
insert into career_apply_cloud_gate_waivers(user_id,portal,max_sends,expires_at,note) values
 ('00000000-0000-4000-8000-00000000f004','lever',5,now()+interval '1 day','TEST mass');
-- 40 sent by the cloud today, at one employer, and one more role there queued: the cloud may take it (was: 25 a day; the employer in 30 days).
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts,claimed_at,source)
 select '00000000-0000-4000-8000-00000000f004','lever:cloudco:'||g,'Cloud Co','https://jobs.lever.co/cloudco/'||g,'{}',repeat('d',64),repeat('d',64),
  'submitted_unconfirmed',1,now()-interval '1 hour','extension' from generate_series(1,40) g;
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f004','lever:cloudco:new','Cloud Co','https://jobs.lever.co/cloudco/new'));
select t.ok((select career_apply_cloud_refusal(j, now()) from career_apply_jobs j where job_id='lever:cloudco:new') is null,
 'the cloud check: 40 today at the same employer, a new role there may still go');
-- The same posting under a second id, after the first went: refused as a duplicate at the cloud's check.
set session_replication_role = replica;
insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state)
 select user_id,'lever:cloudco:new-copy',company,url,payload,payload_hash,approval_hash,'queued' from career_apply_jobs where job_id='lever:cloudco:new';
set session_replication_role = origin;
update career_apply_jobs set state='submitted_unconfirmed', attempts=1, claimed_at=now(), source='extension' where job_id='lever:cloudco:new';
select t.ok((select career_apply_cloud_refusal(j, now()) from career_apply_jobs j where job_id='lever:cloudco:new-copy') = 'duplicate_job',
 'the same posting after it was sent: refused as a duplicate at the cloud''s check');
-- A pace the person set still holds at the cloud.
update career_watch_kv set value = value || '{"daily_limit":"5"}' where user_id='00000000-0000-4000-8000-00000000f004';
select pg_temp.enq(pg_temp.payload('00000000-0000-4000-8000-00000000f004','lever:cloudco:paced','Cloud Co','https://jobs.lever.co/cloudco/paced'));
update career_watch_kv set value = value - 'daily_limit' where user_id='00000000-0000-4000-8000-00000000f004';
-- (the enqueue above was refused by their own pace of 5: nothing queued)
select t.ok(not exists (select from career_apply_jobs where job_id='lever:cloudco:paced'), 'their own pace at the queue');
-- Nothing of the old bounds is installed, by the reconcile's own list.
select t.ok(career_apply_guards_missing() = '{}', 'every claim guard in place, and no product bound or company rule left (' || array_to_string(career_apply_guards_missing(), '; ') || ')');
rollback;
