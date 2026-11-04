-- career-ingest, round 2 (20261030110000_career_ingest_r2.sql): a lane run's boards are claimed in one statement (marked
-- attempted and "reading", returned as they were; a board claimed by one run is not handed to the next); a board that keeps
-- failing waits after its last attempt (1 h at 2 failures, doubling, at most a day); the claim is the service role's alone;
-- a posting the run closes closes the applications still queued for it (not sent, the reason says why), and nothing else.
-- Fixed instants; everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000000ca01','ingest-r2-a@example.test');
insert into public.profiles(id) values ('00000000-0000-4000-8000-00000000ca01') on conflict do nothing;
delete from public.career_board_state;
insert into public.career_board_state(provider,board,bucket,last_attempt_at,last_ok_at,last_status,fail_count) values
 ('greenhouse','never',3,null,null,null,0),
 ('greenhouse','oldest',3,'2026-10-30T01:00:00Z','2026-10-30T01:00:00Z','ok',0),
 ('lever','newer',3,'2026-10-30T05:00:00Z','2026-10-30T05:00:00Z','ok',0),
 ('lever','failing1',3,'2026-10-30T05:30:00Z','2026-10-30T04:00:00Z','failed: HTTP 429',1),
 ('greenhouse','gone2',3,'2026-10-30T05:30:00Z',null,'failed: HTTP 404 [gone x2]',2),
 ('greenhouse','gone2old',3,'2026-10-30T04:30:00Z',null,'failed: HTTP 404 [gone x2]',2),
 ('greenhouse','gone9',3,'2026-10-29T12:00:00Z',null,'failed: HTTP 404',9),
 ('greenhouse','gone9old',3,'2026-10-29T05:00:00Z',null,'failed: HTTP 404',9),
 ('ashby','otherlane',4,null,null,null,0);
set role service_role;
create temp table c1 as select * from public.career_board_state_claim(array[3], 3, '2026-10-30T06:00:00Z');
select t.ok((select array_agg(board order by last_attempt_at nulls first, provider, board) = array['never','gone9old','oldest'] from c1),
 'the oldest due first (never read first); a board in its backoff is not taken (gone9: 9 failures, a day since 2026-10-29 12:00 not yet)');
select t.ok((select bool_and(s.last_attempt_at = '2026-10-30T06:00:00Z' and s.last_status = 'reading') from public.career_board_state s join c1 using (provider,board)),
 'the claimed boards are marked attempted now, "reading", in the same statement');
select t.ok((select last_status is null and last_attempt_at is null from c1 where board = 'never') and (select last_status = 'ok' from c1 where board = 'oldest'),
 'the rows come back as they were before the claim (the run builds its record from them)');
create temp table c2 as select * from public.career_board_state_claim(array[3], 3, '2026-10-30T06:00:30Z');
select t.ok((select array_agg(board order by board) = array['failing1','gone2old','newer'] from c2),
 'the next run takes the boards now waiting longest, none of the first run''s (they went to the back); 1 failure: no wait; 2 failures: 1 hour (gone2old, 1.5 h ago, yes; gone2, 30 min ago, no)');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[3], 10, '2026-10-30T06:01:00Z')),
 'a minute on, nothing: every other board is being read by one of the two runs (claimed under 5 minutes ago, still reading)');
select t.ok((select array_agg(board order by board) = array['failing1','never','newer','oldest'] from public.career_board_state_claim(array[3], 10, '2026-10-30T06:06:00Z')),
 'six minutes on (the runs were stopped: their claims are older than 5 minutes), every board not in a backoff is due again; every board with 2 or more failures waits from its last attempt (gone9old, claimed at 06:00 with 9, a day)');
select t.ok((select count(*) = 1 from public.career_board_state_claim(array[4], 10, '2026-10-30T06:01:00Z')), 'another lane''s buckets are its own');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[3], 0, '2026-10-30T06:01:00Z'))
 and (select count(*) = 0 from public.career_board_state_claim('{}', 5, '2026-10-30T06:01:00Z')), 'no limit or no buckets: nothing');
select t.ok((select count(*) = 1 from public.career_board_state_claim(array[3], 10, '2026-10-30T07:01:00Z') where board = 'gone2'),
 'gone2 is due an hour after its last attempt');
update public.career_board_state set last_attempt_at = '2026-10-29T06:00:00Z', fail_count = 40 where board = 'gone9';
select t.ok((select count(*) = 1 from public.career_board_state_claim(array[3], 10, '2026-10-30T07:01:00Z') where board = 'gone9'),
 'the wait never passes a day, however many failures');
reset role;
select t.as_user('00000000-0000-4000-8000-00000000ca01');
set role authenticated;
select t.must_fail($$select * from public.career_board_state_claim(array[3], 3, now())$$, 'permission denied', 'a signed-in person cannot claim boards');
reset role;

-- A closed posting closes the applications still waiting for it.
insert into public.career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values
 ('greenhouse:acme:1','greenhouse','acme','1','Acme','Analyst','https://boards.greenhouse.io/acme/jobs/1','2026-10-29T12:00:00Z','2026-10-29T12:00:00Z'),
 ('greenhouse:acme:2','greenhouse','acme','2','Acme','Analyst II','https://boards.greenhouse.io/acme/jobs/2','2026-10-29T12:00:00Z','2026-10-29T12:00:00Z');
alter table public.career_apply_jobs disable trigger user;
insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts,claimed_at,lease_token) values
 ('00000000-0000-4000-8000-00000000ca01','greenhouse:acme:1','Acme','https://boards.greenhouse.io/acme/jobs/1','{}',repeat('a',64),repeat('a',64),'queued',0,null,null),
 ('00000000-0000-4000-8000-00000000ca01','greenhouse:acme:2','Acme','https://boards.greenhouse.io/acme/jobs/2','{}',repeat('b',64),repeat('b',64),'queued',0,null,null);
alter table public.career_apply_jobs enable trigger user;
set role service_role;
update public.career_postings set last_seen_at = '2026-10-30T06:00:00Z' where job_id = 'greenhouse:acme:1';
select t.ok((select state = 'queued' from public.career_apply_jobs where job_id = 'greenhouse:acme:1'), 'a touch changes nothing for the application');
update public.career_postings set closed_at = '2026-10-30T06:00:00Z' where job_id = 'greenhouse:acme:1';
select t.ok((select state = 'not_submitted' and reason = 'not sent: the employer closed this posting before it was sent' and evidence->>'closed' = 'posting_closed'
 and payload_hash = repeat('a',64) from public.career_apply_jobs where job_id = 'greenhouse:acme:1'), 'closed: the application waiting for it is not sent, and says why; its approval untouched');
select t.ok((select state = 'queued' from public.career_apply_jobs where job_id = 'greenhouse:acme:2'), 'the other posting''s application still waits');
-- An upsert that keeps a posting open (what every ingest write sends) closes nothing.
insert into public.career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at,closed_at)
 values ('greenhouse:acme:2','greenhouse','acme','2','Acme','Analyst II','https://boards.greenhouse.io/acme/jobs/2','2026-10-29T12:00:00Z','2026-10-30T06:00:00Z',null)
 on conflict (job_id) do update set last_seen_at = excluded.last_seen_at, closed_at = excluded.closed_at;
select t.ok((select state = 'queued' from public.career_apply_jobs where job_id = 'greenhouse:acme:2'), 'an open posting rewritten: its application still waits');
reset role;
rollback;
