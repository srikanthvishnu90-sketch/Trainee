-- 20261102130000_career_apply_prepare_fair_claim.sql (mass-apply scale audit, section 3): the preparation claim serves people in
-- turns. One person's 100 roles (four parts of 25, all queued before anyone else asked) must not hold the slots before the
-- people who asked a minute later; the limits, the lease expiry and the split of a part are exactly as before; the rollback
-- puts the old (oldest-first) order back. Run by run.sh after the migration is applied; everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-0000000fa101','fair-a@example.test'),
 ('00000000-0000-4000-8000-0000000fa102','fair-b@example.test'),
 ('00000000-0000-4000-8000-0000000fa103','fair-c@example.test'),
 ('00000000-0000-4000-8000-0000000fa104','fair-d@example.test');
insert into profiles(id) select id from auth.users where id::text like '00000000-0000-4000-8000-0000000fa10%';

-- A request of n postings for a person, queued `age` ago (+ part seconds so one person's parts keep their order).
create function pg_temp.rq(u text, part int, n int, age interval) returns void language sql as $$
 insert into career_apply_prepare_requests(user_id, job_ids, hosts, created_at)
 select u::uuid, array_agg('greenhouse:fair:' || right(u, 3) || ':' || part || ':' || g order by g),
  array_agg('boards.greenhouse.io' order by g), now() - age + (part * interval '1 second')
 from generate_series(1, n) g
$$;
create function pg_temp.reset_queue() returns void language sql as $$ delete from career_apply_prepare_requests $$;
-- 100 roles for A (four parts of 25), queued 10 minutes ago.
create function pg_temp.a100() returns void language sql as $$
 select pg_temp.rq('00000000-0000-4000-8000-0000000fa101', p, 25, interval '10 minutes') from generate_series(1, 4) p
$$;

-- 1. A has 4 parts queued first; B and C ask a minute ago. Three slots: each person gets one, not three for A.
select pg_temp.reset_queue();
select pg_temp.a100();
select pg_temp.rq('00000000-0000-4000-8000-0000000fa102', 1, 3, interval '1 minute');
select pg_temp.rq('00000000-0000-4000-8000-0000000fa103', 1, 1, interval '1 minute');
create temp table c1 as select * from career_apply_prepare_request_claim(3, 10, null, null);
select t.ok((select count(*) = 3 and count(distinct user_id) = 3 from c1), 'three slots, three people: A''s 100 roles do not take them all');
select t.ok((select count(*) = 1 from c1 where user_id = '00000000-0000-4000-8000-0000000fa101'
  and id = (select id from career_apply_prepare_requests where user_id = '00000000-0000-4000-8000-0000000fa101' order by created_at, id limit 1)),
 'A gets its OLDEST part first');
select t.ok((select bool_and(state = 'running' and lease_token is not null) from c1), 'claimed rows run under a lease, as before');

-- 2. A has 1 running and 3 queued; a newcomer D asks now. Two slots: D (a first turn) goes before A's second part, though A is far older.
select pg_temp.rq('00000000-0000-4000-8000-0000000fa104', 1, 1, interval '0 seconds');
create temp table c2 as select * from career_apply_prepare_request_claim(2, 20, null, null);
select t.ok((select count(*) = 2 from c2), 'two slots, two claims');
select t.ok((select count(*) = 1 from c2 where user_id = '00000000-0000-4000-8000-0000000fa104'), 'the newcomer is served before A''s second part');
select t.ok((select count(*) = 1 from c2 where user_id = '00000000-0000-4000-8000-0000000fa101'), 'and A still gets a slot: nothing idles');

-- 3. The global bound still binds: running now = 5 (A2, B1, C1, D1).
select t.ok((select count(*) = 5 from career_apply_prepare_requests where state = 'running'), 'five requests run');
select t.ok((select count(*) = 1 from career_apply_prepare_request_claim(10, 6, null, null)), 'global 6: only one more starts');
select t.ok((select count(*) = 0 from career_apply_prepare_request_claim(10, 6, null, null)), 'global 6 reached: nothing more');
select t.ok((select count(*) = 0 from career_apply_prepare_request_claim(0, 100, null, null)), 'p_want 0 claims nothing');

-- 4. Alone, one person still gets every free slot (the queue is work-conserving).
select pg_temp.reset_queue();
select pg_temp.a100();
select t.ok((select count(*) = 4 from career_apply_prepare_request_claim(10, 10, null, null)), 'only A waiting: all four parts start');

-- 5. A person already running parts waits behind people with none: A has 2 running, B and C one queued each, A 2 queued; 2 slots go to B and C.
select pg_temp.reset_queue();
select pg_temp.a100();
update career_apply_prepare_requests set state = 'running', claimed_at = now(), lease_token = gen_random_uuid()
 where id in (select id from career_apply_prepare_requests order by created_at, id limit 2);
select pg_temp.rq('00000000-0000-4000-8000-0000000fa102', 1, 1, interval '30 seconds');
select pg_temp.rq('00000000-0000-4000-8000-0000000fa103', 1, 1, interval '20 seconds');
create temp table c5 as select * from career_apply_prepare_request_claim(2, 20, null, null);
select t.ok((select count(*) = 2 and bool_and(user_id <> '00000000-0000-4000-8000-0000000fa101') from c5), 'two slots go to the two people with nothing running');

-- 6. The per-person-day number is exactly as before: a part that fits only in part is split, the rest waits in a request of its own.
select pg_temp.reset_queue();
select pg_temp.rq('00000000-0000-4000-8000-0000000fa101', 1, 25, interval '5 minutes');
select pg_temp.rq('00000000-0000-4000-8000-0000000fa101', 2, 25, interval '5 minutes');
create temp table c6 as select * from career_apply_prepare_request_claim(10, 10, 30, null);
select t.ok((select sum(cardinality(job_ids)) = 30 from c6), 'per person per day 30: 30 postings start');
select t.ok((select count(*) = 1 from career_apply_prepare_requests where state = 'queued' and cardinality(job_ids) = 20 and outcome->>'waiting_for' = 'per_person_day'),
 'the 20 that do not fit wait in a request of their own, with the reason');

-- 7. Expiry is unchanged: a request running past its 15-minute lease is expired, never run again.
select pg_temp.reset_queue();
select pg_temp.rq('00000000-0000-4000-8000-0000000fa101', 1, 2, interval '1 hour');
update career_apply_prepare_requests set state = 'running', claimed_at = now() - interval '16 minutes', lease_token = gen_random_uuid();
select count(*) from career_apply_prepare_request_claim(5, 5, null, null);
select t.ok((select state = 'expired' from career_apply_prepare_requests), 'past its lease: expired, not re-run');

-- 8. Invalid limits are still refused; the function is for the service role only.
select t.must_fail($$select * from career_apply_prepare_request_claim(501, 10, null, null)$$, 'invalid prepare limits', 'p_want over 500 is refused');
select t.must_fail($$select * from career_apply_prepare_request_claim(5, 0, null, null)$$, 'invalid prepare limits', 'p_global under 1 is refused');
select t.ok(has_function_privilege('service_role', 'public.career_apply_prepare_request_claim(integer, integer, integer, integer)', 'execute')
 and not has_function_privilege('anon', 'public.career_apply_prepare_request_claim(integer, integer, integer, integer)', 'execute')
 and not has_function_privilege('authenticated', 'public.career_apply_prepare_request_claim(integer, integer, integer, integer)', 'execute'), 'service_role only');

-- 9. The rollback puts the oldest-first order back (and the migration applies again after it).
\ir ../../supabase/rollbacks/20261102130000_career_apply_prepare_fair_claim.down.sql
select pg_temp.reset_queue();
select pg_temp.a100();
select pg_temp.rq('00000000-0000-4000-8000-0000000fa102', 1, 3, interval '1 minute');
create temp table c9 as select * from career_apply_prepare_request_claim(2, 10, null, null);
select t.ok((select count(*) = 2 and bool_and(user_id = '00000000-0000-4000-8000-0000000fa101') from c9), 'rolled back: oldest first, A''s first two parts (the old behaviour)');
\ir ../../supabase/migrations/20261102130000_career_apply_prepare_fair_claim.sql
select pg_temp.reset_queue();
select pg_temp.a100();
select pg_temp.rq('00000000-0000-4000-8000-0000000fa102', 1, 3, interval '1 minute');
create temp table c9b as select * from career_apply_prepare_request_claim(2, 10, null, null);
select t.ok((select count(*) = 2 and count(distinct user_id) = 2 from c9b), 'applied again: turns per person');
rollback;
