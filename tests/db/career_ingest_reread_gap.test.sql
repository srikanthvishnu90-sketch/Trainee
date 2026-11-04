-- career-ingest's re-read gap (20261030150000_career_ingest_reread_gap.sql): a board attempted less than the gap ago, its
-- read finished or not, is not claimed. Two claims of a lane back to back with the first run's outcomes recorded in between
-- (CI run 41146111368: "read 2 times in one tick") take disjoint boards; the failure backoff and the in-flight rule stay;
-- a clock behind the last attempt takes nothing; the 3-argument form is the same claim with the plan's 10 minutes; the
-- service role's alone. Fixed instants; everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000000cb01','ingest-gap-a@example.test');
delete from public.career_board_state;
insert into public.career_board_state(provider,board,bucket,last_attempt_at,last_ok_at,last_status,fail_count) values
 ('greenhouse','a',5,null,null,null,0),
 ('greenhouse','b',5,null,null,null,0),
 ('lever','c',5,null,null,null,0),
 ('lever','d',5,'2026-10-31T09:00:00Z','2026-10-31T09:00:00Z','ok',0),
 ('ashby','e',5,'2026-10-31T09:30:00Z','2026-10-31T09:30:00Z','ok',0),
 ('ashby','f',6,null,null,null,0);
set role service_role;
-- The first run (12:00:00) takes three, reads them and records its outcomes (ok, one failure, a 404) before the second
-- run claims, a second later.
create temp table r1 as select * from public.career_board_state_claim(array[5], 3, '2026-10-31T12:00:00Z', 600000);
select t.ok((select array_agg(board order by board) = array['a','b','c'] from r1), 'the first run takes the never-read boards');
update public.career_board_state set last_status = case board when 'a' then 'ok' when 'b' then 'failed: HTTP 429' else 'failed: HTTP 404 [gone x1]' end,
  fail_count = case board when 'a' then 0 else 1 end, last_ok_at = case board when 'a' then '2026-10-31T12:00:00Z'::timestamptz end
  where board in ('a','b','c');
create temp table r2 as select * from public.career_board_state_claim(array[5], 3, '2026-10-31T12:00:01Z', 600000);
select t.ok((select array_agg(board order by board) = array['d','e'] from r2) and not exists (select 1 from r2 join r1 using (provider, board)),
 'a second later, the first run finished: the second run takes only the boards the first did not (it used to take a, b and c again)');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T12:05:00Z', 600000)),
 'the next tick (5 minutes on): nothing, every board was attempted inside the gap');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T12:09:59.999Z', 600000)),
 'a millisecond before the gap: nothing');
select t.ok((select array_agg(board order by board) = array['a','b','c','d','e'] from public.career_board_state_claim(array[5], 10, '2026-10-31T12:10:01Z', 600000)),
 'past the gap: every board again (b and c have one failure: no backoff yet)');
-- The backoff stays: two failures wait an hour from the last attempt, whatever the gap.
update public.career_board_state set last_attempt_at = '2026-10-31T12:00:00Z', last_status = 'failed: HTTP 429', fail_count = 2 where board = 'b';
update public.career_board_state set last_attempt_at = '2026-10-31T11:00:00Z', last_status = 'ok', fail_count = 0 where board in ('a','c','d','e');
select t.ok((select array_agg(board order by board) = array['a','c','d','e'] from public.career_board_state_claim(array[5], 10, '2026-10-31T12:30:00Z', 600000)),
 'two failures: b waits its hour (claimed at 12:00), the gap long past');
update public.career_board_state set last_attempt_at = '2026-10-31T11:00:00Z', last_status = 'ok' where board in ('a','c','d','e');
select t.ok((select count(*) = 1 from public.career_board_state_claim(array[5], 10, '2026-10-31T13:00:00Z', 0) where board = 'b'),
 'b is due an hour after its last attempt');
-- The in-flight rule stays with no gap; a stopped run's boards wait the gap.
update public.career_board_state set last_attempt_at = '2026-10-31T13:00:00Z', last_status = 'reading', fail_count = 0;
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T13:04:00Z', 0)), 'no gap: a board still reading under 5 minutes is not taken');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T13:06:00Z', 600000)), 'a stopped run''s boards (still "reading", 6 minutes on) wait the gap');
select t.ok((select count(*) = 5 from public.career_board_state_claim(array[5], 10, '2026-10-31T13:10:00Z', 600000)), 'and are due at the gap');
-- A clock behind the last attempt: nothing is taken inside the gap.
update public.career_board_state set last_attempt_at = '2026-10-31T14:00:00Z', last_status = 'ok', fail_count = 0;
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T13:55:00Z', 600000)), 'a run whose clock is behind the last attempt takes nothing');
-- The 3-argument form: the same claim with the plan's 10 minutes.
update public.career_board_state set last_attempt_at = '2026-10-31T14:00:00Z', last_status = 'ok', fail_count = 0;
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 10, '2026-10-31T14:09:59Z')), 'the 3-argument form: nothing inside 10 minutes');
select t.ok((select count(*) = 5 from public.career_board_state_claim(array[5], 10, '2026-10-31T14:10:00Z')), 'the 3-argument form: every board at 10 minutes');
select t.ok((select count(*) = 1 from public.career_board_state_claim(array[6], 10, '2026-10-31T14:10:00Z', 600000)), 'another lane''s buckets are its own');
select t.ok((select count(*) = 0 from public.career_board_state_claim(array[5], 0, '2026-10-31T15:00:00Z', 600000))
 and (select count(*) = 0 from public.career_board_state_claim('{}', 5, '2026-10-31T15:00:00Z', 600000)), 'no limit or no buckets: nothing');
reset role;
select t.ok((select prosecdef and proconfig is not null from pg_proc where oid = 'public.career_board_state_claim(integer[],integer,timestamptz,integer)'::regprocedure),
 'the 4-argument form is security definer with a fixed search_path');
select t.as_user('00000000-0000-4000-8000-00000000cb01');
set role authenticated;
select t.must_fail($$select * from public.career_board_state_claim(array[5], 3, now(), 600000)$$, 'permission denied', 'a signed-in person cannot claim boards (4 arguments)');
select t.must_fail($$select * from public.career_board_state_claim(array[5], 3, now())$$, 'permission denied', 'a signed-in person cannot claim boards (3 arguments)');
reset role;
set role anon;
select t.must_fail($$select * from public.career_board_state_claim(array[5], 3, now(), 600000)$$, 'permission denied', 'anon cannot claim boards');
reset role;
rollback;
