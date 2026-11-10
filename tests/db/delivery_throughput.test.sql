-- DELIVERY THROUGHPUT (20261102180000_delivery_throughput.sql): the shared token bucket (burst, refill, all-or-nothing, bad
-- arguments, service only); the two-lane sharded claim (replies and approvals before alerts, shards disjoint and stable, the
-- parts-in-order rule kept, service only); the outbox retention (finished rows past 30 days only, in batches); the foreign-key
-- indexes; the autovacuum settings; the four outbox indexes the scale report called unused are still there. Rolls back.
-- (Parallel sessions on the bucket and the claim: tests/architect/delivery-throughput-pg.test.ts.)
begin;
reset role;

-- 1. The bucket. Fixed instants (p_now), so nothing here depends on the clock. rate 25/s, burst 5.
create temp table g(n int);
insert into g select public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2030-01-01 00:00:00+00') from generate_series(1, 5);
select t.ok((select count(*) = 5 and max(n) = 0 from g), 'a new bucket starts full: 5 takes of 1 at one instant');
select t.ok(public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2030-01-01 00:00:00+00') = 40, 'the 6th is told to wait 1000/25 = 40 ms');
select t.ok(public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2030-01-01 00:00:00.020+00') between 1 and 20, 'half a refill later it is told to wait the other half');
truncate g;
insert into g select public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2030-01-01 00:00:00.200+00') from generate_series(1, 6);
select t.ok((select count(*) filter (where n = 0) = 5 and count(*) filter (where n > 0) = 1 from g), '200 ms refill 5 tokens (25/s): 5 takes, the 6th waits');
truncate g;
insert into g select public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2030-01-01 00:01:00+00') from generate_series(1, 8);
select t.ok((select count(*) filter (where n = 0) = 5 from g), 'a long pause never stores more than the burst (5), not 1500');
select t.ok(public.channel_rate_acquire(array['test:global'], array[25.0], array[5.0], 1, '2029-12-31 00:00:00+00') > 0, 'a caller''s clock in the past gives no extra tokens');
-- All or nothing: the chat's bucket (burst 1) is empty after one take, and then the global bucket is not spent either.
select public.channel_rate_acquire(array['test:g2', 'test:chat:1'], array[25.0, 1.0], array[5.0, 1.0], 1, '2030-02-01 00:00:00+00');
select t.ok(public.channel_rate_acquire(array['test:g2', 'test:chat:1'], array[25.0, 1.0], array[5.0, 1.0], 1, '2030-02-01 00:00:00+00') = 1000, 'the same chat again at once: wait a second (its own rate)');
select t.ok((select tokens = 4 from public.channel_rate_buckets where key = 'test:g2'), 'the refused call spent nothing of the global bucket (4 left of 5 after the one take)');
select t.ok(public.channel_rate_acquire(array['test:g2', 'test:chat:2'], array[25.0, 1.0], array[5.0, 1.0], 1, '2030-02-01 00:00:00+00') = 0, 'another chat goes');
-- Bad arguments.
select t.must_fail($$select public.channel_rate_acquire(array['a','a'], array[1.0,1.0], array[1.0,1.0])$$, 'distinct', 'the same key twice is refused');
select t.must_fail($$select public.channel_rate_acquire(array['a'], array[1.0,2.0], array[1.0])$$, 'one length', 'lists of different lengths are refused');
select t.must_fail($$select public.channel_rate_acquire(array['a'], array[0.0], array[1.0])$$, 'rate is above 0', 'a rate of 0 is refused');
select t.must_fail($$select public.channel_rate_acquire(array['a'], array[1.0], array[0.5], 1)$$, 'rate is above 0', 'a burst under the cost is refused');
-- The prune drops idle chat buckets only.
update public.channel_rate_buckets set refilled_at = clock_timestamp() - interval '20 minutes' where key in ('test:chat:1', 'test:global');
select t.ok(public.channel_rate_buckets_prune() = 1, 'the prune drops one idle chat bucket');
select t.ok(exists (select 1 from public.channel_rate_buckets where key = 'test:global') and not exists (select 1 from public.channel_rate_buckets where key = 'test:chat:1'), 'and keeps an idle global bucket');

-- 2. The claim in lanes and shards.
create temp table u as select gen_random_uuid() as id, n from generate_series(1, 40) n;
insert into auth.users(id, email) select id, 'dt-' || n || '@example.test' from u;
insert into profiles(id) select id from u;
insert into channel_contacts(contact, user_id, last_inbound_at, created_at) select 'tg:' || (7000 + n), id, now(), now() from u;
-- 30 alerts (older) and 3 replies, 2 cards, a receipt (newer), all telegram.
insert into career_outbox(user_id, key, kind, text, deliver_at, channel) select id, 'alert:dt' || n, 'alert', 'a', now() - interval '10 minutes' + n * interval '1 second', 'telegram' from u where n <= 30;
insert into career_outbox(user_id, key, kind, text, deliver_at, channel) select id, 'reply:dt' || n, 'reply', 'r', now() - interval '1 minute', 'telegram' from u where n between 31 and 33;
insert into career_outbox(user_id, key, kind, text, deliver_at, channel) select id, 'card:dt' || n, 'card', 'c', now() - interval '1 minute', 'telegram' from u where n between 34 and 35;
insert into career_outbox(user_id, key, kind, text, deliver_at, channel) select id, 'receipt:dt' || n, 'receipt', 'x', now() - interval '1 minute', 'telegram' from u where n = 36;
set role service_role;
select t.ok((select count(*) = 5 and bool_and(key ~ '^(reply|card):') from career_outbox_claim_lane(now(), 100, 'priority')), 'the priority lane claims the 3 replies and 2 cards, none of the older alerts');
select t.ok((select count(*) = 0 from career_outbox_claim_lane(now(), 100, 'priority')), 'those 5 are now sending: a second priority claim finds nothing');
update career_outbox set status = 'delivered', delivered_at = now(), claimed_at = null where status = 'sending';
select t.ok((select count(*) = 10 and bool_and(key ~ '^(alert|receipt):') from career_outbox_claim_lane(now(), 10, 'bulk')), 'the bulk lane claims alerts and receipts only, and no more than the limit');
update career_outbox set status = 'queued', claimed_at = null where status = 'sending';
-- Shards: disjoint, together all, stable per person.
create temp table s0 as select * from career_outbox_claim_lane(now(), 100, 'bulk', 0, 4);
update career_outbox set status = 'queued', claimed_at = null where status = 'sending';
create temp table s1 as select * from career_outbox_claim_lane(now(), 100, 'bulk', 1, 4);
update career_outbox set status = 'queued', claimed_at = null where status = 'sending';
create temp table s2 as select * from career_outbox_claim_lane(now(), 100, 'bulk', 2, 4);
update career_outbox set status = 'queued', claimed_at = null where status = 'sending';
create temp table s3 as select * from career_outbox_claim_lane(now(), 100, 'bulk', 3, 4);
update career_outbox set status = 'queued', claimed_at = null where status = 'sending';
select t.ok((select count(*) = 31 from (select id from s0 union all select id from s1 union all select id from s2 union all select id from s3) x) and (select count(distinct id) = 31 from (select id from s0 union all select id from s1 union all select id from s2 union all select id from s3) x), 'four shards claim the 31 bulk rows between them, each row in exactly one');
select t.ok((select count(*) > 0 from s0) and (select count(*) > 0 from s1) and (select count(*) > 0 from s2) and (select count(*) > 0 from s3), 'each shard gets some people (the hash spreads 31 rows)');
select t.ok((select bool_and((hashtextextended(user_id::text, 0) & 2147483647) % 4 = 2) from s2), 'a person''s shard is the hash of their id');
select t.must_fail($$select * from career_outbox_claim_lane(now(), 1, 'all')$$, 'priority or bulk', 'an unknown lane is refused');
select t.must_fail($$select * from career_outbox_claim_lane(now(), 1, 'bulk', 4, 4)$$, 'shard', 'a shard past the count is refused');
-- The parts-in-order rule holds in the lane claim.
reset role;
insert into career_outbox(user_id, key, kind, text, deliver_at, channel, part_of, part)
  select id, 'reply:dtp:' || p, 'reply', 'p' || p, now() - interval '1 minute', 'telegram', 'reply:dtp', p from u, generate_series(1, 3) p where n = 40;
set role service_role;
-- part 1 is with another run: parts 2 and 3 wait
reset role;
update career_outbox set status = 'sending', claimed_at = now() where key = 'reply:dtp:1';
set role service_role;
select t.ok((select count(*) = 0 from career_outbox_claim_lane(now(), 100, 'priority') where key like 'reply:dtp:%'), 'part 1 with another run holds parts 2 and 3');
reset role;
update career_outbox set status = 'delivered', delivered_at = now(), claimed_at = null where key = 'reply:dtp:1';
set role service_role;
select t.ok((select array_agg(o.part order by o.part) = array[2, 3] from career_outbox_claim_lane(now(), 100, 'priority') c join career_outbox o on o.id = c.id where o.part_of = 'reply:dtp'), 'after part 1 is delivered the next claim takes parts 2 and 3');
reset role;
set role authenticated;
select t.must_fail($$select * from career_outbox_claim_lane(now(), 1, 'bulk')$$, 'permission denied', 'a person cannot run the lane claim');
select t.must_fail($$select public.channel_rate_acquire(array['a'], array[1.0], array[1.0])$$, 'permission denied', 'a person cannot take from the bucket');
select t.must_fail($$select public.career_outbox_purge()$$, 'permission denied', 'a person cannot run the retention');
select t.must_fail($$select * from public.channel_rate_buckets$$, 'permission denied', 'a person cannot read the buckets');
reset role;
set role anon;
select t.must_fail($$select public.channel_rate_acquire(array['a'], array[1.0], array[1.0])$$, 'permission denied', 'anon cannot take from the bucket');
reset role;

-- 3. Retention. Everything not finished, or finished lately, stays.
delete from career_outbox;
insert into career_outbox(user_id, key, kind, text, deliver_at, created_at, status, delivered_at, retry_at, channel)
select (select id from u where n = 1), 'alert:ret-' || k, 'alert', 'x', now() - interval '60 days', now() - age, st, case when st = 'delivered' then now() - age end, rt, 'telegram'
from (values
  ('del-old-1', interval '40 days', 'delivered', null::timestamptz), ('del-old-2', interval '40 days', 'delivered', null), ('del-old-3', interval '31 days', 'delivered', null),
  ('del-new', interval '5 days', 'delivered', null), ('del-edge', interval '29 days', 'delivered', null),
  ('skip-old', interval '40 days', 'skipped_opt_out', null), ('skip-new', interval '2 days', 'skipped_opt_out', null),
  ('fail-final-old', interval '40 days', 'failed', null), ('fail-retry-old', interval '40 days', 'failed', now() + interval '1 hour'),
  ('queued-old', interval '40 days', 'queued', null), ('sending-old', interval '40 days', 'sending', null), ('held-old', interval '40 days', 'held', null)) v(k, age, st, rt);
update career_outbox set claimed_at = now() where status = 'sending';
set role service_role;
select t.ok(public.career_outbox_purge(interval '30 days', 2, 1) = 2, 'one batch of 2 deletes 2 rows (batches are bounded)');
select t.ok(public.career_outbox_purge(interval '30 days', 2, 10) = 3, 'the rest: 3 delivered/skipped/failed-for-good rows past 30 days (1 delivered, then skipped and failed final)');
reset role;
select t.ok((select array_agg(substr(key, 11) order by key) = array['del-edge', 'del-new', 'fail-retry-old', 'held-old', 'queued-old', 'sending-old', 'skip-new'] from career_outbox),
  'what is left: recent finished rows, a failed row waiting for its retry, queued, sending and held rows of any age');
set role service_role;
select t.ok(public.career_outbox_purge() = 0, 'nothing left to purge');
select t.must_fail($$select public.career_outbox_purge(interval '1 day')$$, 'at least 7 days', 'a retention under 7 days is refused');
reset role;

-- 4. Indexes and settings.
select t.ok((select count(*) = 4 from pg_indexes where schemaname = 'public' and tablename = 'career_outbox' and indexname in ('career_outbox_parts', 'career_outbox_provider_id', 'career_outbox_provider_ids', 'career_outbox_card_id')),
  'the four outbox indexes the report calls unused are kept (the claims, the delivery-status callbacks and the card foreign key read them)');
select t.ok((select count(*) = 2 from pg_indexes where schemaname = 'public' and indexname in ('career_outbox_due_priority', 'career_outbox_terminal_old')), 'the priority-lane and retention indexes exist');
select t.ok(exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = 'public.agent_tasks'::regclass and a.attname = 'user_id' and i.indpred is null), 'agent_tasks.user_id leads an index');
select t.ok(exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = 'public.channel_threads'::regclass and a.attname = 'thread_id' and i.indpred is null), 'channel_threads.thread_id leads an index');
select t.ok(exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = 'public.agent_threads'::regclass and a.attname = 'user_id' and i.indpred is null), 'agent_threads.user_id leads an index');
select t.ok((select bool_and(coalesce(reloptions, '{}') @> array['autovacuum_vacuum_scale_factor=0.02']) from pg_class where oid in ('public.career_outbox'::regclass, 'public.career_watch_kv'::regclass, 'public.career_postings'::regclass, 'public.career_apply_jobs'::regclass)),
  'autovacuum runs at 2% on the outbox, career_watch_kv, career_postings and career_apply_jobs');
rollback;
